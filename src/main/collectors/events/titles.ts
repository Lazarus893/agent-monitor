/**
 * 会话标题索引 —— 让 C1/C2 显示**桌面端里那个标题**，而不是首条提问。
 *
 * 用户日常用的是 Codex 与 Claude 的桌面端，那边每个会话都有一个生成好的名字；
 * 我们原来只能拿到首条提问（Claude）或 rollout 里的首句（Codex），
 * 于是屏上是「hi 你现在用的是什么模型」，而 App 里那条叫「整理页面 Skill 详情」。
 *
 * 两处来源（2026-09-15 本机实测）：
 *
 *   Claude  `~/Library/Application Support/Claude/claude-code-sessions/**​/local_*.json`
 *           （本机实测是两层 uuid 目录，见 scanClaude 里为什么要递归）
 *           `{ cliSessionId, title, titleSource, cwd, lastActivityAt, isArchived, … }`
 *           `cliSessionId` 就是 hook 发来的 `session_id`，两边能对上。
 *
 *   Codex   `~/.codex/session_index.jsonl`
 *           每行 `{ id, thread_name, updated_at }`，`id` 就是 rollout 文件名里那个会话 id。
 *
 * 两条都是**只读**：这个索引是桌面端自己的账本，我们一个字节都不写。
 *
 * 为什么要监听而不是查一次：标题通常在**第一轮对话结束之后**才生成。
 * 事件先到（那时只有回退标题），标题后到 —— 所以这里盯着文件变化，
 * 拿到之后**原地改**已经在列表里的那几条（id 不变，不算新事件、不响铃、不置未读）。
 *
 * 用 `node:fs.watch` 而不是 chokidar：本仓库没有 chokidar 这个依赖，
 * `events/codex.ts` 盯 rollout 目录用的也是 `fs.watch(dir, {recursive:true})`，
 * 两处保持一致，也省掉一个原生依赖。
 */

import { watch } from 'node:fs'
import type { FSWatcher } from 'node:fs'
import { open, readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentId } from '../../../shared/types.js'
import { clip, oneLine } from './types.js'

export const DEFAULT_CLAUDE_DIR =
  join(homedir(), 'Library', 'Application Support', 'Claude', 'claude-code-sessions')
export const DEFAULT_CODEX_INDEX = join(homedir(), '.codex', 'session_index.jsonl')

/** 目录 / 文件都可以用环境变量挪开 —— selftest 用临时目录，绝不碰真实索引 */
export const claudeDir = (env = process.env.MONITOR_CLAUDE_SESSIONS_DIR): string =>
  env && env.trim() ? env : DEFAULT_CLAUDE_DIR
export const codexIndex = (env = process.env.MONITOR_CODEX_INDEX): string =>
  env && env.trim() ? env : DEFAULT_CODEX_INDEX

/** 标题跟事件标题同一个上限，免得一条 200 字的名字把行撑爆 */
export const TITLE_MAX = 80
/** 兜底轮询：fs.watch 在某些路径（网络盘、权限变化）上会静默失效 */
export const POLL_MS = 5_000
/** 单次读 Codex 索引的上限，防止一个被写爆的文件把主进程卡住 */
const MAX_CHUNK = 2 * 1024 * 1024

const isRec = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null

/** 一条标题：哪个 agent 的哪个会话，叫什么 */
export type TitleHit = { agent: AgentId; sessionId: string; title: string }

/**
 * Claude 的一份 `local_*.json`。
 * `titleSource` 是 `auto`（模型生成）还是别的都要 —— 用户看到的就是 `title` 这一个字段。
 * 归档过的会话照样收：C1/C2 显示的是历史，归档不代表它不该有名字。
 */
export function parseClaudeSession(raw: unknown): TitleHit | null {
  if (!isRec(raw)) return null
  const id = raw['cliSessionId']
  const title = raw['title']
  if (typeof id !== 'string' || !id.trim()) return null
  if (typeof title !== 'string') return null
  const t = clip(oneLine(title), TITLE_MAX)
  if (!t) return null
  return { agent: 'claude', sessionId: id.trim(), title: t }
}

/** Codex 索引的一行。坏行返回 null（整份文件不能被一行毁掉）。 */
export function parseCodexIndexLine(line: string): TitleHit | null {
  const s = line.trim()
  if (!s) return null
  let o: unknown
  try {
    o = JSON.parse(s)
  } catch {
    return null
  }
  if (!isRec(o)) return null
  const id = o['id']
  const name = o['thread_name']
  if (typeof id !== 'string' || !id.trim()) return null
  if (typeof name !== 'string') return null
  const t = clip(oneLine(name), TITLE_MAX)
  if (!t) return null
  return { agent: 'codex', sessionId: id.trim(), title: t }
}

export type TitleSink = {
  /** 收到一条标题。回灌期与运行期都会调，调用方自己决定要不要落地。 */
  title(hit: TitleHit): void
  log(line: string): void
}

/**
 * 盯着两处索引，把标题喂给 sink。
 *
 * 启动时先整读一遍（那一遍的标题用来修正回灌回来的历史事件），
 * 然后监听 + 5 s 兜底轮询。
 */
export class TitleIndex {
  readonly name = 'titles'
  private known = new Map<string, string>()        // `${agent}:${sessionId}` → title
  private codexOffset = 0
  /** 文件 → 上次读它时的 mtime。没变过的就不再读一遍（见 scanClaude）。 */
  private seenAt = new Map<string, number>()
  private watchers: FSWatcher[] = []
  private timer: ReturnType<typeof setInterval> | null = null
  private busy = false

  constructor(
    private sink: TitleSink,
    private dir: string = claudeDir(),
    private index: string = codexIndex()
  ) {}

  /** 当前已知的标题（事件产生时先问一次，问不到就用回退标题） */
  titleFor(agent: AgentId, sessionId: string): string | undefined {
    return this.known.get(`${agent}:${sessionId}`)
  }

  async start(): Promise<void> {
    await this.scan()
    try {
      this.watchers.push(watch(this.dir, { recursive: true }, () => { void this.scan() }))
    } catch {
      this.sink.log(`[titles] 监听不了 ${this.dir}，退回 ${POLL_MS}ms 轮询`)
    }
    try {
      // 盯文件本身：codex 是往同一个文件追加，不是新建
      this.watchers.push(watch(this.index, () => { void this.scan() }))
    } catch {
      this.sink.log(`[titles] 监听不了 ${this.index}，退回 ${POLL_MS}ms 轮询`)
    }
    for (const w of this.watchers) w.on('error', () => { /* 目录被删/换盘：轮询兜着 */ })
    this.timer = setInterval(() => { void this.scan() }, POLL_MS)
  }

  stop(): void {
    for (const w of this.watchers) w.close()
    this.watchers = []
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** 手动跑一轮（selftest 与单测用，不必等 fs.watch 或 5 s 轮询） */
  async tick(): Promise<void> {
    while (this.busy) await new Promise(r => setTimeout(r, 10))
    await this.scan()
  }

  private async scan(): Promise<void> {
    if (this.busy) return
    this.busy = true
    try {
      await this.scanClaude()
      await this.scanCodex()
    } catch (err) {
      this.sink.log(`[titles] 扫描出错：${String(err)}`)
    } finally {
      this.busy = false
    }
  }

  /**
   * Claude：`<dir>/**​/local_*.json`，整份读（每份几 KB，本机 65 份也就一瞬）。
   *
   * **递归**，不是只下钻一层：实测路径是
   * `<dir>/<uuid>/<uuid>/local_<uuid>.json`（两层），而且这个层数是桌面端的实现细节，
   * 它哪天多套一层，写死层数的版本就会静默地一条标题都读不到 —— 而表现是
   * 「标题没更新」，最难查的那一类。深度设 6 层封顶，够任何合理的嵌套。
   */
  private async scanClaude(): Promise<void> {
    const walk = async (d: string, depth: number): Promise<void> => {
      if (depth > 6) return
      let entries
      try {
        entries = await readdir(d, { withFileTypes: true })
      } catch {
        return // 没装 Claude 桌面端、路径变了、或者这一层没权限
      }
      for (const e of entries) {
        const p = join(d, e.name)
        if (e.isDirectory()) { await walk(p, depth + 1); continue }
        if (!e.name.startsWith('local_') || !e.name.endsWith('.json')) continue
        try {
          /* mtime 没变就不读。5 s 的兜底轮询要是每轮都把这 65 份（本机）整读一遍，
             就是一个随会话数单调变差的常驻开销 —— 和 M3 复核抓到的
             「每 3 s stat 1624 个 rollout」同一个形状。stat 一次比 read+JSON.parse 便宜得多。 */
          const m = (await stat(p)).mtimeMs
          if (this.seenAt.get(p) === m) continue
          this.seenAt.set(p, m)
          this.offer(parseClaudeSession(JSON.parse(await readFile(p, 'utf8'))))
        } catch {
          // 正在写一半的 JSON / 刚被删掉：下一轮再说
        }
      }
    }
    await walk(this.dir, 0)
  }

  /** Codex：单文件追加，按 offset 读增量；文件被截短就从头再来 */
  private async scanCodex(): Promise<void> {
    let size = 0
    try {
      size = (await stat(this.index)).size
    } catch {
      return
    }
    if (size < this.codexOffset) this.codexOffset = 0
    if (size === this.codexOffset) return
    let fh
    try {
      fh = await open(this.index, 'r')
    } catch {
      return
    }
    try {
      const len = Math.min(size - this.codexOffset, MAX_CHUNK)
      const buf = Buffer.allocUnsafe(len)
      const { bytesRead } = await fh.read(buf, 0, len, this.codexOffset)
      const text = buf.subarray(0, bytesRead).toString('utf8')
      const lines = text.split('\n')
      /* 最后一段可能是半行 —— 留给下一轮，offset 只推进到最后一个换行为止。
         这一条和 codex.ts 的增量读是同一个模式。 */
      const tail = lines.pop() ?? ''
      for (const line of lines) this.offer(parseCodexIndexLine(line))
      this.codexOffset += bytesRead - Buffer.byteLength(tail, 'utf8')
    } finally {
      await fh.close()
    }
  }

  /** 新标题 / 标题变了才往外报；同一个值重复看到一百遍也只报一次 */
  private offer(hit: TitleHit | null): void {
    if (!hit) return
    const key = `${hit.agent}:${hit.sessionId}`
    if (this.known.get(key) === hit.title) return
    this.known.set(key, hit.title)
    this.sink.title(hit)
  }
}
