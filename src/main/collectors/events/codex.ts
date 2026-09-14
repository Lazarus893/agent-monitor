/**
 * Codex 事件 —— 监听 `~/.codex/sessions/**​/rollout-*.jsonl`。
 *
 * 为什么是文件监听而不是 `notify`：`notify` 已被 Codex Computer Use 占用，且只覆盖 TUI；
 * rollout 文件三端（Desktop / TUI / `codex exec`）全覆盖、零配置（PLAN §2.2）。
 *
 * 增量读取：每个文件记一个字节 offset，只读新追加的部分，畸形行跳过。
 * 不用 chokidar —— 它不在依赖里，而装它要走 registry（本轮网络只许回环 + 额度接口 + aihot）。
 * node 自带的 `fs.watch(dir, { recursive: true })` 在 macOS 上是 FSEvents，
 * 覆盖「新文件 + 追加」这两件事足够了；再配一条 3 s 的兜底扫描，
 * 保证「2 s 内出现」有个下界（FSEvents 合并事件时会晚，但不会不来）。
 *
 * 实测（2026-09-14，本机全部 rollout 文件）的真实形状：
 *   session_meta.payload = { session_id, cwd, originator, cli_version, … }
 *   event_msg.payload.type = task_started | user_message | task_complete | agent_message
 *   task_complete.payload  = { turn_id, last_agent_message, error: {message}|null,
 *                              started_at, completed_at, duration_ms }
 *   turn_context.payload   = { turn_id, cwd, model, … }   ← M3b 的 topModel 用它
 *
 * **「等待你」的实测结论**：把 2025+2026 全部 rollout 文件的 `"type":"…"` 取全集
 * （67 个名字），里面**没有任何审批 / 提问事件**——没有 `exec_approval_request`、
 * 没有 `apply_patch_approval_request`。`request_user_input` 只出现在
 * developer 消息的权限说明正文里（3 处，全是散文），不是事件类型。
 * 结论：Codex 的审批请求不落 rollout 文件。这里留一个可配置的名字表
 * （`MONITOR_CODEX_ATTENTION_TYPES`，逗号分隔），将来 Codex 真的写了就不用改代码。
 */

import { watch } from 'node:fs'
import type { FSWatcher } from 'node:fs'
import { open, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent } from '../../../shared/types.js'
import type { EventCollector, EventInput, EventSink } from './types.js'
import {
  BACKFILL_MS, SUMMARY_MAX, TITLE_MAX, clip, looksLikeSystemBlock, tilde
} from './types.js'

export const DEFAULT_SESSIONS_DIR = join(homedir(), '.codex', 'sessions')
/** 兜底扫描周期：FSEvents 有合并延迟，这条保证「最迟 3 s」 */
const SWEEP_MS = 3_000
/** 单次增量读的上限，防止一个被别的工具写爆的文件把主进程卡住 */
const MAX_CHUNK = 4 * 1024 * 1024
/** 半行缓冲的上限。正常 rollout 一行几 KB，2 MB 已经远超任何真实情况。 */
const MAX_TAIL = 2 * 1024 * 1024

export function attentionTypes(env = process.env.MONITOR_CODEX_ATTENTION_TYPES): Set<string> {
  const fromEnv = (env ?? '').split(',').map(s => s.trim()).filter(Boolean)
  // 默认留空：本机全量扫描证明这些名字一个都不存在，默认打开只会制造假的「等待你」
  return new Set(fromEnv)
}

/** 一个会话在解析过程中的累积状态。跨行才拼得出一条事件。 */
export type CodexSession = {
  sessionId: string
  cwd: string
  title: string
  /** 最近一次 turn_context 里的 model，M3b 的 topModel 用 */
  model?: string
  /** 最后一行的 timestamp —— AgentEvent.updatedAt */
  updatedAt: string
  running: boolean
  attention: boolean
  startedAt?: string
}

export const newSession = (sessionId: string): CodexSession => ({
  sessionId, cwd: '', title: '', updatedAt: '', running: false, attention: false
})

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

/** payload 里取首段文本：`last_agent_message` 可能是长篇，只要第一段。 */
function firstPara(text: string): string {
  const para = text.split(/\n\s*\n/)[0] ?? text
  return clip(para, SUMMARY_MAX)
}

/**
 * 解析一行，更新会话状态，必要时产出一条事件。
 * 纯函数（除了改 `s`）—— 三家里最容易随 Codex 版本漂移的就是这里，用例钉的就是它。
 */
export function parseLine(
  line: string,
  s: CodexSession,
  attn: Set<string>
): EventInput | null {
  let obj: unknown
  try {
    obj = JSON.parse(line)
  } catch {
    return null // 畸形行跳过：写到一半的行下一轮会以完整形态再来一次
  }
  if (!isRec(obj)) return null

  const ts = typeof obj['timestamp'] === 'string' ? obj['timestamp'] : ''
  if (ts) s.updatedAt = ts
  const type = obj['type']
  const payload = isRec(obj['payload']) ? obj['payload'] : null
  if (!payload) return null

  if (type === 'session_meta') {
    const id = payload['session_id'] ?? payload['id']
    if (typeof id === 'string') s.sessionId = id
    if (typeof payload['cwd'] === 'string') s.cwd = payload['cwd']
    return null
  }

  if (type === 'turn_context') {
    if (typeof payload['model'] === 'string') s.model = payload['model']
    if (!s.cwd && typeof payload['cwd'] === 'string') s.cwd = payload['cwd']
    return null
  }

  // 首条用户提问作标题。两种载体都要吃：event_msg.user_message 与 response_item role=user
  if (type === 'response_item' && payload['role'] === 'user' && !s.title) {
    const content = payload['content']
    if (Array.isArray(content)) {
      for (const part of content) {
        if (!isRec(part) || part['type'] !== 'input_text') continue
        const text = part['text']
        if (typeof text !== 'string' || !text.trim() || looksLikeSystemBlock(text)) continue
        s.title = clip(text, TITLE_MAX)
        break
      }
    }
    return null
  }

  if (type !== 'event_msg') return null
  const kind = payload['type']

  if (kind === 'user_message') {
    const msg = payload['message']
    if (typeof msg === 'string' && msg.trim() && !looksLikeSystemBlock(msg)) {
      if (!s.title) s.title = clip(msg, TITLE_MAX)
    }
    // 用户发话 = 上一轮的「等待你」结束了
    s.attention = false
    return null
  }

  if (kind === 'task_started') {
    s.running = true
    s.attention = false
    s.startedAt = ts || s.updatedAt
    return event(s, 'running', ts)
  }

  if (kind === 'task_complete') {
    s.running = false
    s.attention = false
    const err = payload['error']
    const failed = isRec(err) ? typeof err['message'] === 'string' && !!err['message'] : !!err
    const last = payload['last_agent_message']
    const summary = typeof last === 'string' && last.trim() ? firstPara(last) : undefined
    const durationMs = typeof payload['duration_ms'] === 'number' ? payload['duration_ms'] : undefined
    const turn = typeof payload['turn_id'] === 'string' ? payload['turn_id'] : String(ts)
    return {
      ...event(s, failed ? 'failed' : 'completed', ts),
      id: `codex:${s.sessionId}:${turn}`,
      summary,
      durationMs
    }
  }

  if (typeof kind === 'string' && attn.has(kind)) {
    s.attention = true
    return { ...event(s, 'attention', ts), id: `codex:${s.sessionId}:attn:${ts}` }
  }

  return null
}

function event(s: CodexSession, kind: AgentEvent['kind'], ts: string): EventInput {
  const at = ts || s.updatedAt || new Date().toISOString()
  return {
    id: `codex:${s.sessionId}:${kind}:${at}`,
    agent: 'codex',
    kind,
    title: s.title || '(未命名会话)',
    at,
    updatedAt: s.updatedAt || at,
    sessionId: s.sessionId,
    cwd: s.cwd,
    startedAt: s.startedAt
  }
}

type FileState = {
  offset: number
  session: CodexSession
  tail: string
  /** 启动时因为太旧被跳过：offset 直接落在文件尾，内容一行没解析过 */
  skipped?: boolean
}

export class CodexEvents implements EventCollector {
  readonly name = 'codex'
  private files = new Map<string, FileState>()
  private watcher: FSWatcher | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private attn = attentionTypes()
  private booted = false
  private busy = false
  /** 扫描期间又来了变化：不丢，扫完立刻再来一轮（FSEvents 在长扫描中途照样会发） */
  private again = false

  constructor(
    private sink: EventSink,
    private dir: string = process.env.MONITOR_CODEX_SESSIONS_DIR || DEFAULT_SESSIONS_DIR,
    private now: () => number = Date.now
  ) {}

  /** 最近一次见到的 model（M3b topModel 用），按 5 h 窗口内出现次数计 */
  modelCounts(windowMs: number): Map<string, number> {
    const cut = this.now() - windowMs
    const counts = new Map<string, number>()
    for (const f of this.files.values()) {
      const { model, updatedAt } = f.session
      if (!model || !updatedAt) continue
      if (new Date(updatedAt).getTime() < cut) continue
      counts.set(model, (counts.get(model) ?? 0) + 1)
    }
    return counts
  }

  async start(): Promise<void> {
    // 回灌：先把最近 24 h 的文件整读一遍（emit 出来的都会被 store 标成已读），
    // 然后才打开监听。顺序反了就会把回灌的历史当成新事件，一开机响一串铃。
    await this.sweep()
    this.booted = true
    try {
      this.watcher = watch(this.dir, { recursive: true }, () => { void this.sweep() })
      this.watcher.on('error', err => this.sink.log(`[events:codex] watch 出错：${String(err)}`))
    } catch (err) {
      // 目录不存在 / 平台不支持 recursive —— 退回纯轮询，不崩
      this.sink.log(`[events:codex] 无法监听目录，退回 ${SWEEP_MS}ms 轮询：${String(err)}`)
    }
    this.timer = setInterval(() => { void this.sweep() }, SWEEP_MS)
  }

  stop(): void {
    this.watcher?.close()
    this.watcher = null
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** 手动跑一轮增量（selftest 与单测用：不必等 FSEvents 或 3 s 轮询）。
   *  先等当前这一轮走完，再确实地跑一轮 —— 否则 FSEvents 正好在扫的时候，
   *  这次调用会被重入保护挡掉，调用方以为扫过了。 */
  async tick(): Promise<void> {
    while (this.busy) await new Promise(r => setTimeout(r, 10))
    await this.sweep()
  }

  /** 扫一遍近 24 h 内动过的 rollout 文件，各自读增量。重入保护：FSEvents 会连发。 */
  private async sweep(): Promise<void> {
    if (this.busy) { this.again = true; return }
    this.busy = true
    try {
      do {
        this.again = false
        const cut = this.now() - BACKFILL_MS
        for (const file of await listRollouts(this.dir)) {
          let mtime = 0
          try {
            mtime = (await stat(file)).mtimeMs
          } catch {
            continue
          }
          /* 没见过 + 太旧 = 与本次运行无关，不读它的内容。
             但 offset 必须记（复核 P1-③）：`codex resume` 一个老会话会把这个文件重新写起来，
             那时 mtime 变新、文件却仍然「没见过」，readIncrement 就会从 0 读整份 ——
             里面每一条历史 task_complete 都以 booted=true 被 emit，
             于是 resume 一次老会话 = 一串铃 + 一串跳 C 页。本机 1624 份 rollout 里
             12 份是这种形态（最长隔了 596 h、最大 4.2 MB）。
             记下当前大小，之后的追加才是真正的增量。 */
          if (!this.files.has(file) && mtime < cut) {
            await this.markSkipped(file)
            continue
          }
          await this.readIncrement(file)
        }
      } while (this.again)
    } catch (err) {
      this.sink.log(`[events:codex] 扫描出错：${String(err)}`)
    } finally {
      this.busy = false
    }
  }

  /** 老文件：只把 offset 推到文件尾，一行都不解析。 */
  private async markSkipped(file: string): Promise<void> {
    try {
      const { size } = await stat(file)
      this.files.set(file, {
        offset: size, session: newSession(basenameSession(file)), tail: '', skipped: true
      })
    } catch { /* 文件刚没了，下一轮当新文件处理 */ }
  }

  private async readIncrement(file: string): Promise<void> {
    let st = this.files.get(file)
    if (!st) {
      st = { offset: 0, session: newSession(basenameSession(file)), tail: '' }
      this.files.set(file, st)
    }
    let fh
    try {
      fh = await open(file, 'r')
    } catch {
      return
    }
    try {
      const { size } = await fh.stat()
      if (size < st.offset) {
        /* 文件被截断 / 换了内容：从头再来，别把后半截当增量。
           会话状态也要跟着复位（复核 P2-2.3）—— 不复位的话 title / startedAt
           会带着上一份的残留继续用，屏上就是一条张冠李戴的行。 */
        st.offset = 0
        st.tail = ''
        st.session = newSession(st.session.sessionId)
      }
      if (size === st.offset) return
      const len = Math.min(size - st.offset, MAX_CHUNK)
      const buf = Buffer.allocUnsafe(len)
      const { bytesRead } = await fh.read(buf, 0, len, st.offset)
      st.offset += bytesRead
      const text = st.tail + buf.subarray(0, bytesRead).toString('utf8')
      const lines = text.split('\n')
      // 最后一段可能是半行（写了一半），留到下一轮再拼。
      // 但要有上限（复核 P2-2.6）：一个从头到尾没有换行的文件会把 tail 撑到无限大，
      // MAX_CHUNK 只管单次读量，管不住这个累加。超了就丢 —— 那种文件不是 rollout。
      st.tail = lines.pop() ?? ''
      if (st.tail.length > MAX_TAIL) {
        this.sink.log(`[events:codex] 单行超过 ${MAX_TAIL} 字节，丢弃缓冲：${file}`)
        st.tail = ''
      }
      for (const line of lines) {
        if (!line.trim()) continue
        const ev = parseLine(line, st.session, this.attn)
        if (ev) this.publish(ev, st.session)
      }
    } catch (err) {
      this.sink.log(`[events:codex] 读取出错：${String(err)}`)
    } finally {
      await fh.close()
    }
  }

  private publish(ev: EventInput, s: CodexSession): void {
    this.sink.emit(ev)
    if (!this.booted) return // 回灌期间不打日志，否则一开机刷屏
    if (ev.kind === 'running') return // running 不单独记一行，收尾时才记
    const dur = ev.durationMs ? ` ${Math.round(ev.durationMs / 1000)}s` : ''
    this.sink.log(
      `[events:codex] ${ev.kind} "${ev.title}" cwd=${tilde(s.cwd, homedir())}${dur}`
    )
  }
}

/** rollout 文件名里就带 session id：rollout-<ISO>-<uuid>.jsonl */
export function basenameSession(file: string): string {
  const m = /rollout-[\dT:-]+-([0-9a-f-]{36})\.jsonl$/i.exec(file)
  return m?.[1] ?? file
}

/** 递归列出 sessions 目录下的 rollout-*.jsonl。目录不存在返回空表。 */
export async function listRollouts(dir: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (d: string, depth: number): Promise<void> => {
    if (depth > 5) return
    let entries
    try {
      entries = await readdir(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(d, e.name)
      if (e.isDirectory()) await walk(p, depth + 1)
      else if (e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) out.push(p)
    }
  }
  await walk(dir, 0)
  return out
}
