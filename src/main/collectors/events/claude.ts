/**
 * Claude Code 事件 —— hooks + 一个只绑回环的 HTTP 服务器。
 *
 * 为什么不监听 `~/.claude/projects/**​/*.jsonl`：转录文件是 Claude 写完一整段才落盘的，
 * 「刚做完」与「等你批准」这两件事在文件里都没有明确的标记，而 hook 是 Claude 主动
 * 在那一刻调的，语义精确、延迟接近零。文件监听留作兜底接口（本轮不做，PLAN §2.2）。
 *
 * 安全边界（简报「三个 collector · Claude」）：
 *   · 只 bind 127.0.0.1，外网与局域网都进不来；
 *   · Header `X-Monitor-Token` 必须等于 `~/.agent-monitor/hook-token`（首启生成，0600）——
 *     回环地址对本机所有进程都是开的，没有这一道，任何一个本地程序都能伪造「需要你批准」；
 *   · body ≤ 64 KB、必须是 application/json、必须带 hook_event_name + session_id；
 *   · 只认 POST /hook，别的路径一律 404，不做任何反射回显。
 *
 * 屏上与日志里都不出现 transcript 正文：标题与摘要都过 clip()（80 / 120 字），
 * 日志只打 kind、标题、cwd 与耗时。
 */

import { createServer, type Server } from 'node:http'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent } from '../../../shared/types.js'
import type { EventCollector, EventInput, EventSink } from './types.js'
import { SUMMARY_MAX, TITLE_MAX, clip, looksLikeSystemBlock, tilde } from './types.js'

export const HOOK_HOST = '127.0.0.1'
export const DEFAULT_HOOK_PORT = 47831
export const DEFAULT_TOKEN_FILE = join(homedir(), '.agent-monitor', 'hook-token')

/**
 * token 文件路径。`MONITOR_HOOK_TOKEN_FILE` 可覆盖 —— claude-hook.sh 认同一个环境变量，
 * selftest 用它把服务器与脚本一起挪到临时目录，不覆写用户真实的 hook-token。
 */
export const tokenFile = (env = process.env.MONITOR_HOOK_TOKEN_FILE): string =>
  env && env.trim() ? env : DEFAULT_TOKEN_FILE

/** 兼容旧调用点；新代码用 tokenFile()。 */
export const TOKEN_FILE = DEFAULT_TOKEN_FILE
export const MAX_BODY = 64 * 1024
/** transcript 只读尾部这么多 —— 一整份可以有几十 MB，而我们只要最后一条助手消息 */
export const TRANSCRIPT_TAIL = 256 * 1024

export function hookPort(env = process.env.MONITOR_HOOK_PORT): number {
  const n = Number(env)
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : DEFAULT_HOOK_PORT
}

/** 读 token；不存在就生成一枚 0600 的。目录也收成 0700。 */
export function ensureToken(file = tokenFile()): string {
  try {
    const t = readFileSync(file, 'utf8').trim()
    if (t) return t
  } catch { /* 不存在，往下生成 */ }
  const token = randomBytes(24).toString('hex')
  mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 })
  writeFileSync(file, token + '\n', { mode: 0o600 })
  // writeFileSync 的 mode 只对**新建**生效：文件已存在（内容为空 / 被清过）时权限不会变，
  // 所以显式再 chmod 一次（复核 P2-1.3）。目录同理。
  try { chmodSync(file, 0o600) } catch { /* 权限已经对就算了 */ }
  try { chmodSync(join(file, '..'), 0o700) } catch { /* 同上 */ }
  return token
}

/** 定长比较，避免按字节提前返回泄漏前缀（这里成本为零，就别省） */
export function tokenMatches(got: string | undefined, want: string): boolean {
  if (!got) return false
  const a = Buffer.from(got)
  const b = Buffer.from(want)
  return a.length === b.length && timingSafeEqual(a, b)
}

export type HookPayload = {
  hook_event_name: string
  session_id: string
  transcript_path?: string
  cwd?: string
  notification_type?: string
  message?: string
}

/** 校验一份已解析的 body。返回 null 表示合法。 */
export function validate(raw: unknown): { status: number; reason: string } | null {
  if (typeof raw !== 'object' || raw === null) return { status: 400, reason: 'not an object' }
  const o = raw as Record<string, unknown>
  if (typeof o['hook_event_name'] !== 'string' || !o['hook_event_name']) {
    return { status: 400, reason: 'missing hook_event_name' }
  }
  if (typeof o['session_id'] !== 'string' || !o['session_id']) {
    return { status: 400, reason: 'missing session_id' }
  }
  return null
}

/** 一个会话的累积状态。hook 之间要记着标题与开始时间。 */
export type ClaudeSession = {
  sessionId: string
  cwd: string
  title: string
  startedAt?: string
  updatedAt: string
  running: boolean
  attention: boolean
}

const newSession = (sessionId: string): ClaudeSession => ({
  sessionId, cwd: '', title: '', updatedAt: '', running: false, attention: false
})

/**
 * hook 名 → 事件类型。
 *   UserPromptSubmit → running（会话开跑）
 *   Stop             → completed
 *   Notification     → permission 类才算 attention；idle 类忽略
 *   SessionEnd       → 清 running，不产生事件（用户关掉窗口不是「做完了」）
 */
export function kindFor(p: HookPayload): AgentEvent['kind'] | 'clear' | null {
  switch (p.hook_event_name) {
    case 'UserPromptSubmit': return 'running'
    case 'Stop': return 'completed'
    case 'SessionEnd': return 'clear'
    case 'Notification': {
      const t = (p.notification_type ?? '').toLowerCase()
      const m = (p.message ?? '').toLowerCase()
      if (t.includes('permission') || (!t && m.includes('permission'))) return 'attention'
      // idle_prompt 之类：Claude 只是在提醒你它闲着，不是在等你批准
      return null
    }
    default: return null
  }
}

/** 从文件头读这么多，用来找首条用户消息 —— 它在文件**开头**，尾部那 256 KB 里没有它 */
export const TRANSCRIPT_HEAD = 64 * 1024

/**
 * 从 transcript jsonl 取标题与摘要。读不到就返回空，不抛。
 *
 * 两头都要读：
 *   · **尾部** 256 KB —— 最后一条 assistant 文本作摘要，`summary` 行也多半在这里
 *     （Claude 写完会话摘要之后会追加）。
 *   · **头部** 64 KB —— 尾部没给出标题时，首条用户提问在文件**开头**，
 *     只读尾部必然取不到，于是标题回落成「(未命名会话)」（lead 在实机 C1 页上看到的就是它）。
 * 一份转录可以有几十 MB，两头各截一段仍然是常数级 IO。
 */
export async function readTranscript(
  path: string,
  tailBytes = TRANSCRIPT_TAIL,
  headBytes = TRANSCRIPT_HEAD
): Promise<{ title?: string; summary?: string }> {
  let fh
  try {
    fh = await open(path, 'r')
  } catch {
    return {}
  }
  try {
    const { size } = await fh.stat()
    const start = Math.max(0, size - tailBytes)
    const tail = Buffer.allocUnsafe(size - start)
    await fh.read(tail, 0, size - start, start)
    const out = parseTranscript(tail.toString('utf8'), start > 0)
    if (out.title) return out

    // 尾部没有 summary 行、也没有用户文本 —— 去开头找首条提问
    if (start === 0) return out          // 整份都读过了，头部没有别的
    const headLen = Math.min(headBytes, size)
    const head = Buffer.allocUnsafe(headLen)
    await fh.read(head, 0, headLen, 0)
    const fromHead = parseTranscript(head.toString('utf8'), false)
    if (fromHead.title) out.title = fromHead.title
    return out
  } catch {
    return {}
  } finally {
    await fh.close()
  }
}

/** 最后的回退：拿 cwd 的最后一段当标题。比「(未命名会话)」多说了「在哪个项目」。 */
export const titleFromCwd = (cwd: string): string =>
  cwd.split('/').filter(Boolean).pop() ?? ''

/**
 * 解析 transcript 的一段文本。
 * `partial` 表示这段是从中间截的，第一行大概率是半行，丢掉。
 * 标题：`summary` 行优先（Claude 自己写的会话摘要），否则最早的一条用户文本；
 * 摘要：最后一条 assistant 的文本首段。
 */
export function parseTranscript(text: string, partial: boolean): { title?: string; summary?: string } {
  const lines = text.split('\n')
  if (partial) lines.shift()
  let summaryLine: string | undefined
  let firstUser: string | undefined
  let lastAssistant: string | undefined
  for (const line of lines) {
    if (!line.trim()) continue
    let o: unknown
    try { o = JSON.parse(line) } catch { continue }
    if (typeof o !== 'object' || o === null) continue
    const r = o as Record<string, unknown>
    if (r['type'] === 'summary' && typeof r['summary'] === 'string') summaryLine = r['summary']
    else if (r['type'] === 'user' && !firstUser) {
      const t = messageText(r['message'])
      if (t && !looksLikeSystemBlock(t)) firstUser = t
    } else if (r['type'] === 'assistant') {
      const t = messageText(r['message'])
      if (t) lastAssistant = t
    }
  }
  const title = summaryLine ?? firstUser
  const out: { title?: string; summary?: string } = {}
  if (title) out.title = clip(title, TITLE_MAX)
  if (lastAssistant) out.summary = clip(lastAssistant.split(/\n\s*\n/)[0] ?? lastAssistant, SUMMARY_MAX)
  return out
}

/** message.content 有 string 与 [{type:'text',text}] 两种编码 */
function messageText(msg: unknown): string | undefined {
  if (typeof msg !== 'object' || msg === null) return undefined
  const content = (msg as Record<string, unknown>)['content']
  if (typeof content === 'string') return content.trim() || undefined
  if (!Array.isArray(content)) return undefined
  for (const part of content) {
    if (typeof part !== 'object' || part === null) continue
    const p = part as Record<string, unknown>
    if (p['type'] === 'text' && typeof p['text'] === 'string' && p['text'].trim()) return p['text']
  }
  return undefined
}

/** 最近 5 h 内 assistant 用得最多的模型（M3b topModel）。model 名从 hook 拿不到，
 *  所以这一块由 topmodel.ts 直接扫转录目录；这里只导出显示名映射，两处共用一份。 */
export const MODEL_DISPLAY: Record<string, string> = {
  'claude-fable-5-1': 'Fable 5.1',
  'claude-fable-5': 'Fable 5',
  'claude-opus-5': 'Opus 5',
  'claude-opus-4-6': 'Opus 4.6',
  'claude-sonnet-5': 'Sonnet 5',
  'claude-sonnet-4-6': 'Sonnet 4.6',
  'claude-haiku-4-5': 'Haiku 4.5'
}

export class ClaudeEvents implements EventCollector {
  readonly name = 'claude'
  private server: Server | null = null
  private sessions = new Map<string, ClaudeSession>()
  private token = ''

  constructor(
    private sink: EventSink,
    private port = hookPort(),
    private tokenPath = tokenFile()
  ) {}

  async start(): Promise<void> {
    this.token = ensureToken(this.tokenPath)
    await new Promise<void>(resolve => {
      const server = createServer((req, res) => { void this.handle(req, res) })
      server.on('error', err => {
        // 端口被占（多半是上一次没退干净）：不崩，只是这一家收不到事件
        this.sink.log(`[events:claude] hook 服务器起不来：${String(err)}`)
        this.sink.status('claude', 'offline')
        resolve()
      })
      server.listen(this.port, HOOK_HOST, () => {
        this.sink.log(`[events:claude] hook 服务器 http://${HOOK_HOST}:${this.port}/hook`)
        resolve()
      })
      this.server = server
    })
  }

  stop(): void {
    this.server?.close()
    this.server = null
  }

  /** 端口（测试里 port 传 0 时要知道实际听在哪） */
  address(): number {
    const a = this.server?.address()
    return typeof a === 'object' && a ? a.port : this.port
  }

  private async handle(
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse
  ): Promise<void> {
    const end = (status: number, reason = ''): void => {
      res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(status === 204 ? undefined : reason)
    }
    if (req.method !== 'POST' || (req.url ?? '').split('?')[0] !== '/hook') return end(404, 'no')
    if (!tokenMatches(header(req.headers['x-monitor-token']), this.token)) return end(401, 'no')
    const ct = String(req.headers['content-type'] ?? '')
    if (!ct.toLowerCase().includes('application/json')) return end(415, 'no')

    let size = 0
    const chunks: Buffer[] = []
    let over = false
    for await (const chunk of req) {
      size += (chunk as Buffer).length
      if (size > MAX_BODY) { over = true; break }
      chunks.push(chunk as Buffer)
    }
    if (over) { req.destroy(); return end(413, 'no') }

    let raw: unknown
    try {
      raw = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      return end(400, 'no')
    }
    const bad = validate(raw)
    if (bad) return end(bad.status, 'no')

    // 先应答再干活：hook 是同步挡在 Claude 前面的，不能让它等我们读 transcript
    end(204)
    try {
      await this.ingest(raw as HookPayload)
    } catch (err) {
      this.sink.log(`[events:claude] 处理 hook 出错：${String(err)}`)
    }
  }

  /** 把一条 hook 变成 0 或 1 条事件。导出给测试直接调，不必起服务器。 */
  async ingest(p: HookPayload, nowIso = new Date().toISOString()): Promise<EventInput | null> {
    const kind = kindFor(p)
    if (kind === null) return null
    const s = this.sessions.get(p.session_id) ?? newSession(p.session_id)
    this.sessions.set(p.session_id, s)
    if (p.cwd) s.cwd = p.cwd
    s.updatedAt = nowIso

    if (kind === 'clear') {
      s.running = false
      s.attention = false
      this.sink.status('claude', 'idle')
      return null
    }

    // 标题/摘要来自 transcript。UserPromptSubmit 时转录里还没有这一轮，
    // 只补标题；Stop 时才有助手消息可以当摘要。
    const t = p.transcript_path ? await readTranscript(p.transcript_path) : {}
    if (t.title) s.title = t.title

    if (kind === 'running') {
      s.running = true
      s.attention = false
      s.startedAt = nowIso
    } else if (kind === 'attention') {
      s.attention = true
    } else {
      s.running = false
      s.attention = false
    }

    const id = kind === 'completed'
      ? `claude:${s.sessionId}:${Date.parse(nowIso)}`
      : `claude:${s.sessionId}:${kind}:${Date.parse(nowIso)}`

    const ev: EventInput = {
      id,
      agent: 'claude',
      kind,
      // 三级回退：transcript 的 summary / 首条提问 → cwd 末段 → 占位
      title: s.title || titleFromCwd(s.cwd) || '(未命名会话)',
      at: nowIso,
      updatedAt: nowIso,
      sessionId: s.sessionId,
      cwd: s.cwd,
      startedAt: s.startedAt
    }
    if (kind === 'completed' && t.summary) ev.summary = t.summary
    if (kind === 'attention' && p.message) ev.summary = clip(p.message, SUMMARY_MAX)
    if (kind === 'completed' && s.startedAt) {
      ev.durationMs = Math.max(0, Date.parse(nowIso) - Date.parse(s.startedAt))
    }

    this.sink.emit(ev)
    if (kind !== 'running') {
      const dur = ev.durationMs ? ` ${Math.round(ev.durationMs / 1000)}s` : ''
      this.sink.log(`[events:claude] ${kind} "${ev.title}" cwd=${tilde(s.cwd, homedir())}${dur}`)
    }
    return ev
  }
}

const header = (v: string | string[] | undefined): string | undefined =>
  Array.isArray(v) ? v[0] : v
