/**
 * ZCode 事件 —— 每 3 s 只读轮询 `~/.zcode/v2/tasks-index.sqlite` 的 `tasks` 表。
 *
 * 不用原生 sqlite 模块（省掉 electron-rebuild）：直接 spawn 系统 `sqlite3 -readonly -json`。
 * 表很小（本机 41 行），3 s 一次没有压力；WAL 模式下只读打开不影响 ZCode 自己写（M0 已验）。
 *
 * 实测列名（2026-09-14，`.schema tasks`）：
 *   workspace_key, workspace_path, task_id, title, task_status, provider, mode, model,
 *   created_at, updated_at(ms epoch), pinned, archived, deleted, …
 * 主键是 (workspace_key, task_id)，所以 diff 的键要带 workspace —— 只用 task_id 会在
 * 两个工作区各有一条同 id 的任务时互相覆盖。
 *
 * **`pending` 的语义未实测**：本机 41 行全是 `completed`，一条 pending / running 都没有。
 * 观察方法写在 §PENDING 注释里。在拿到实测之前按 running 处理，并留 `MONITOR_ZCODE_PENDING`
 * 开关（`running` | `attention` | `ignore`）——如果实测发现 pending 是「排队等你点开始」，
 * 把它切成 attention 即可，不用改代码。
 */

import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent } from '../../../shared/types.js'
import type { EventCollector, EventInput, EventSink } from './types.js'
import { TITLE_MAX, clip, tilde } from './types.js'

export const DEFAULT_DB = join(homedir(), '.zcode', 'v2', 'tasks-index.sqlite')
export const SQLITE = '/usr/bin/sqlite3'
export const POLL_MS = 3_000
export const QUERY =
  'select workspace_key,task_id,title,task_status,model,workspace_path,updated_at ' +
  'from tasks where deleted=0 order by updated_at desc limit 20'

export type TaskRow = {
  workspace_key?: string
  task_id?: string
  title?: string
  task_status?: string | null
  model?: string | null
  workspace_path?: string | null
  updated_at?: number | string
}

/**
 * §PENDING · 怎么实测 pending 的语义
 * ---------------------------------------------------------------
 * 1. 在 ZCode.app 里发起一个任务，**不要**立刻回答它的追问；
 * 2. 同时跑：
 *      watch -n1 "/usr/bin/sqlite3 -readonly -json ~/.zcode/v2/tasks-index.sqlite \
 *        \"select task_id,task_status,updated_at from tasks where deleted=0 \
 *          order by updated_at desc limit 3\""
 * 3. 记录状态序列。若出现 `pending` 且此时 ZCode 界面上正等着你输入 → 它是「等待你」，
 *    把 MONITOR_ZCODE_PENDING 设成 attention；
 *    若 `pending` 只出现在任务刚创建、模型还没开始回复的那一小段 → 它是「排队中」，
 *    保持 running。
 * 4. 本机 2026-09-14 全表 41 行全是 completed，序列观察不到，因此本轮按 running 处理。
 */
export type PendingMode = 'running' | 'attention' | 'ignore'

export function pendingMode(env = process.env.MONITOR_ZCODE_PENDING): PendingMode {
  return env === 'attention' || env === 'ignore' ? env : 'running'
}

/** task_status → 事件类型。未知状态一律忽略（不崩、不猜）。 */
export function kindFor(status: string | null | undefined, pending: PendingMode):
  AgentEvent['kind'] | null {
  switch ((status ?? '').toLowerCase()) {
    case 'running': return 'running'
    case 'completed': return 'completed'
    case 'failed':
    case 'cancelled': return 'failed'
    case 'pending': return pending === 'ignore' ? null : pending === 'attention' ? 'attention' : 'running'
    default: return null
  }
}

/** `builtin:bigmodel-coding-plan/GLM-5.3-Flash` → `GLM-5.3-Flash` */
export const modelName = (raw: string | null | undefined): string =>
  (raw ?? '').split('/').pop() ?? ''

const iso = (v: unknown): string => {
  const n = typeof v === 'string' ? Number(v) : v
  if (typeof n !== 'number' || !Number.isFinite(n)) return new Date().toISOString()
  // updated_at 是毫秒 epoch（本机实测 1789386316203）；给秒级也留一条路
  return new Date(n > 1e12 ? n : n * 1000).toISOString()
}

const keyOf = (r: TaskRow): string => `${r.workspace_key ?? ''}:${r.task_id ?? ''}`

/**
 * diff：只有「新出现」或「(status, updated_at) 变了」才产生事件。
 * 返回新的 seen 表与要发的事件，纯函数 —— 轮询逻辑最容易出的错是
 * 「每轮都把全表当新事件」，这一条用例钉得住。
 */
export function diff(
  rows: TaskRow[],
  seen: Map<string, string>,
  pending: PendingMode
): { events: EventInput[]; seen: Map<string, string> } {
  const next = new Map(seen)
  const events: EventInput[] = []
  for (const r of rows) {
    if (!r.task_id) continue
    const key = keyOf(r)
    const sig = `${r.task_status ?? ''}@${r.updated_at ?? ''}`
    if (next.get(key) === sig) continue
    next.set(key, sig)
    const kind = kindFor(r.task_status, pending)
    if (!kind) continue
    const at = iso(r.updated_at)
    events.push({
      id: `zcode:${r.task_id}:${r.updated_at ?? at}`,
      agent: 'zcode',
      kind,
      title: clip(r.title || '(未命名任务)', TITLE_MAX),
      at,
      updatedAt: at,
      sessionId: r.task_id,
      cwd: r.workspace_path ?? ''
    })
  }
  return { events, seen: next }
}

/** spawn 一次 sqlite3，拿回 JSON 行。DB 不存在 / sqlite3 不在 → null（该源 offline）。 */
export function queryRows(db: string, sql = QUERY, timeoutMs = 5_000): Promise<TaskRow[] | null> {
  return new Promise(resolve => {
    execFile(SQLITE, ['-readonly', '-json', db, sql], { timeout: timeoutMs, maxBuffer: 4 << 20 },
      (err, stdout) => {
        if (err) return resolve(null)
        const text = stdout.trim()
        if (!text) return resolve([])
        try {
          const parsed: unknown = JSON.parse(text)
          resolve(Array.isArray(parsed) ? parsed as TaskRow[] : [])
        } catch {
          resolve(null)
        }
      })
  })
}

export class ZcodeEvents implements EventCollector {
  readonly name = 'zcode'
  private timer: ReturnType<typeof setInterval> | null = null
  private seen = new Map<string, string>()
  private booted = false
  private busy = false
  private offline = false
  private pending = pendingMode()
  /** 最近一次看到的 (model, updatedAt)，M3b 的 topModel 用 */
  private models: Array<{ model: string; at: number }> = []

  constructor(
    private sink: EventSink,
    private db: string = process.env.MONITOR_ZCODE_DB || DEFAULT_DB,
    private intervalMs = POLL_MS
  ) {}

  async start(): Promise<void> {
    await this.poll()   // 第一轮全部回灌为已读
    this.booted = true
    this.timer = setInterval(() => { void this.poll() }, this.intervalMs)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  modelCounts(windowMs: number, now = Date.now()): Map<string, number> {
    const cut = now - windowMs
    const counts = new Map<string, number>()
    for (const m of this.models) {
      if (m.at < cut || !m.model) continue
      counts.set(m.model, (counts.get(m.model) ?? 0) + 1)
    }
    return counts
  }

  /** 手动跑一轮（单测与 selftest 用：不必等 3 s 周期）。先等在飞的那一轮落地，
   *  否则这次调用会被重入保护挡掉，调用方以为采过了。 */
  async tick(): Promise<void> {
    while (this.busy) await new Promise(r => setTimeout(r, 10))
    await this.poll()
  }

  private async poll(): Promise<void> {
    if (this.busy) return
    this.busy = true
    try {
      const rows = await queryRows(this.db)
      if (rows === null) {
        if (!this.offline) {
          this.offline = true
          this.sink.log('[events:zcode] 读不到 tasks 库，该事件源离线')
          this.sink.status('zcode', 'offline')
        }
        return
      }
      if (this.offline) {
        this.offline = false
        this.sink.log('[events:zcode] tasks 库恢复')
      }
      this.models = rows
        .map(r => ({ model: modelName(r.model), at: Date.parse(iso(r.updated_at)) }))
        .filter(m => !!m.model)

      const { events, seen } = diff(rows, this.seen, this.pending)
      this.seen = seen
      for (const ev of events) {
        this.sink.emit(ev)
        if (!this.booted || ev.kind === 'running') continue
        this.sink.log(`[events:zcode] ${ev.kind} "${ev.title}" cwd=${tilde(ev.cwd ?? '', homedir())}`)
      }
    } finally {
      this.busy = false
    }
  }
}
