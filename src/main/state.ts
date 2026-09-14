/**
 * MonitorState 存储 + 变更推送。
 *
 * 两种模式，形状完全一样：
 *   · live（M2 起的默认）—— 额度来自三个 collector 的真实采集，事件仍是 M1 的 fixtures
 *     （完成事件是 M3 的活）。dev 调试栏一旦切了场景就退出 live，免得真实采集把
 *     正在看的那一帧顶掉。
 *   · scene —— 七个场景全部来自 src/main/fixtures/*.json（design/fixtures 的副本），
 *     与 design/variations.html 的 SCENES 一一对应。截图对账要逐像素对得上，
 *     喂进去的数据就必须是同一份，所以这条路 M2 一个字都没动。
 */

import type {
  AgentEvent, AgentId, AgentState, CanvasSize, MonitorState, Notice, QuotaWindow, SceneName
} from '../shared/types.js'
import type { QuotaResult } from './collectors/quota/types.js'
import { ERROR_TONE } from './collectors/quota/types.js'
// 直接 import JSON：打包时由 rollup 内联进 out/main/index.js，
// 省掉一条「运行时去哪儿找 fixtures」的路径分支（dev 与打包后的目录并不一样）。
import quotaJson from './fixtures/quota.json' with { type: 'json' }
import eventsJson from './fixtures/events.json' with { type: 'json' }

type RawQuota = {
  generatedAt: string
} & Record<AgentId, { status: string; plan: string; windows: QuotaWindow[] }>

type RawEvent = {
  id: string
  agent: AgentId
  kind: 'completed' | 'failed'
  title: string
  summary?: string
  at: string
  durationMs: number | null
}

const QUOTA = quotaJson as unknown as RawQuota
const RAW_EVENTS = (eventsJson as unknown as { generatedAt: string; events: RawEvent[] }).events

/** 时间原点冻结在 fixtures 的 generatedAt —— 倒计时与 resetsAt 自洽，截图可复现 */
const NOW0 = new Date(QUOTA.generatedAt).getTime()
const BOOT = Date.now()
export const frozenNow = (): number => NOW0 + (Date.now() - BOOT)

const p2 = (n: number): string => String(n).padStart(2, '0')

const seen = new Set<string>()
const SRC = RAW_EVENTS.filter(e => (seen.has(e.id) ? false : (seen.add(e.id), true)))

const toEvent = (e: RawEvent, over: Partial<AgentEvent> = {}): AgentEvent => ({
  id: e.id,
  agent: e.agent,
  kind: e.kind,
  title: e.title,
  summary: e.summary || '',
  at: e.at,
  durationMs: e.durationMs ?? undefined,
  acked: true,
  ...over
})

const baseFeed = (): AgentEvent[] => SRC.slice(0, 6).map((e, i) => toEvent(e, { acked: i !== 0 }))

/** edge：一分钟内 8 条事件全未读，专验时间列与省略号 */
const edgeFeed = (): AgentEvent[] =>
  SRC.slice(0, 8).map((e, i) =>
    toEvent(e, {
      id: 'edge' + i,
      at: `2026-09-14T16:3${i < 3 ? 2 : 1}:${p2(59 - i * 7)}+08:00`,
      acked: false
    })
  )

const ATTN_EVENT: AgentEvent = {
  id: 'attn1',
  agent: 'claude',
  kind: 'attention',
  title: '批准写入 ~/.claude/settings.json',
  summary: '会话已暂停，等待 Write 权限确认',
  at: '2026-09-14T14:32:39+08:00',
  acked: false
}

const agent = (
  id: AgentId,
  status: AgentState['status'],
  windows: QuotaWindow[],
  notice?: Notice
): AgentState => ({ id, status, windows, updatedAt: QUOTA.generatedAt, notice })

const CODEX = QUOTA.codex.windows
const CLAUDE = QUOTA.claude.windows
const ZCODE = QUOTA.zcode.windows

const okAgents = (over: Partial<Record<AgentId, AgentState['status']>> = {}): AgentState[] => [
  agent('codex', over.codex ?? 'idle', CODEX),
  agent('claude', over.claude ?? 'idle', CLAUDE),
  agent('zcode', over.zcode ?? 'idle', ZCODE)
]

const SCENES: Record<SceneName, () => Omit<MonitorState, 'scene' | 'canvas'>> = {
  populated: () => ({
    generatedAt: QUOTA.generatedAt,
    loading: false,
    agents: okAgents(),
    events: baseFeed()
  }),
  loading: () => ({
    generatedAt: QUOTA.generatedAt,
    loading: true,
    agents: [agent('codex', 'idle', []), agent('claude', 'idle', []), agent('zcode', 'idle', [])],
    events: []
  }),
  empty: () => ({
    generatedAt: QUOTA.generatedAt,
    loading: false,
    agents: [
      agent('codex', 'idle', [], { tone: 'empty', code: 'first_sample' }),
      agent('claude', 'idle', [], { tone: 'empty', code: 'no_statusline' }),
      // Key 已进 Keychain，「未连接」退成 empty 态的一种（Key 缺失时才出现）
      agent('zcode', 'offline', [], { tone: 'empty', code: 'missing_key' })
    ],
    events: [],
    feedNotice: { tone: 'empty', code: 'feed_empty' }
  }),
  error: () => ({
    generatedAt: QUOTA.generatedAt,
    loading: false,
    agents: [
      agent('codex', 'offline', [], { tone: 'error', code: 'unauthorized' }),
      agent('claude', 'offline', [], { tone: 'error', code: 'rate_limited' }),
      agent('zcode', 'offline', [], { tone: 'error', code: 'network' })
    ],
    events: [],
    feedNotice: { tone: 'error', code: 'feed_error' }
  }),
  edge: () => ({
    generatedAt: QUOTA.generatedAt,
    loading: false,
    agents: [
      agent('codex', 'idle', [
        { label: '5h', usedPercent: 97, resetsAt: '2026-09-14T16:35:48+08:00' },
        CODEX[1]!
      ]),
      agent('claude', 'idle', [
        { label: '5h', usedPercent: 82, resetsAt: CLAUDE[0]!.resetsAt },
        CLAUDE[1]!
      ]),
      agent('zcode', 'idle', ZCODE)
    ],
    events: edgeFeed()
  }),
  attention: () => ({
    generatedAt: QUOTA.generatedAt,
    loading: false,
    agents: okAgents({ claude: 'attention' }),
    events: [{ ...ATTN_EVENT }, ...baseFeed().slice(1, 4).map(e => ({ ...e, acked: true }))]
  }),
  running: () => ({
    generatedAt: QUOTA.generatedAt,
    loading: false,
    agents: okAgents({ codex: 'running', claude: 'running' }),
    events: [
      {
        id: 'run1',
        agent: 'codex',
        kind: 'running',
        title: '构造 v0.3 盲判任务分类样本',
        summary: '已处理 412 / 710 条',
        at: '2026-09-14T14:29:09+08:00',
        startedAt: '2026-09-14T14:29:09+08:00',
        acked: true
      },
      ...baseFeed().slice(1, 4).map((e, i) => ({ ...e, acked: i !== 0 }))
    ]
  })
}

/** 模拟新事件用的池子，与原型同一份 —— 截图与实机演示里出现的标题要一致 */
const POOL: Array<{ agent: AgentId; title: string; summary: string }> = [
  { agent: 'codex', title: '把 rollout jsonl 的增量解析补上 fixture 回归', summary: '新增 6 个解析用例，全部通过' },
  { agent: 'claude', title: '给 statusline 包一层 tee，把 rate_limits 落盘', summary: '脚本已就位，settings.json 已备份' },
  { agent: 'zcode', title: '训练集 b4 批次转写完成', summary: '本批 68 条，去重后 64 条入库' },
  { agent: 'codex', title: '核对智谱 quota/limit 的 unit 枚举', summary: '3 = 小时、6 = 周，已确认' },
  { agent: 'claude', title: '副屏窗口热插拔迁移的 displays.ts 草稿', summary: '按 label 优先、尺寸次之重新定位' }
]

/** live 的起点：三块都还没采到第一轮。windows 为空且没有 notice 时，
 *  渲染层按「等待首轮采样」画（app.ts 的 toTile），不需要在这里造 notice。 */
const blankAgent = (id: AgentId, at: string): AgentState =>
  ({ id, status: 'idle', windows: [], updatedAt: at })

/**
 * 凭据 / 工具没了 —— 这两种失败要把旧数字清掉。
 * 「网络抖了一下」的旧数字仍然有用（额度没有因此改变），而「Key 被删了」之后
 * 屏上还挂着一个数字是在骗人：用户要的是「未连接」这句话和下一步。
 */
const CLEARS_WINDOWS = new Set(['missing_key', 'missing_tool'])

/**
 * 一次采集结果 → 新的 AgentState。
 * 成功：换数字、刷新 updatedAt。
 * 失败：带回窗口就用带回的（Claude 的旧文件），否则留住上一轮的；两种都标 stale，
 *       updatedAt 停在数据真正的时刻 —— 屏上「数据 N 分钟前」算的就是它。
 *       一个数字都没有过（首轮就失败）、或者失败的是 missing_key / missing_tool 时
 *       不留数字，走 notice 的空/错态。
 */
export function mergeQuota(prev: AgentState, result: QuotaResult, nowIso: string): AgentState {
  if (result.ok) {
    return {
      id: prev.id,
      status: 'idle',
      windows: result.windows,
      updatedAt: result.sampledAt ?? nowIso,
      plan: result.plan ?? prev.plan
    }
  }
  const carried = CLEARS_WINDOWS.has(result.code)
    ? []
    : (result.windows?.length ? result.windows : prev.windows)
  const tone = ERROR_TONE[result.code]
  const stale = carried.length > 0
  return {
    id: prev.id,
    // 身份点的判据统一成「屏上还有没有数字」：一个数字都没有 ⇒ offline
    // （「codexbar 没装」与「智谱没连」在用户眼里是同一件事，不该一亮一灭，复核 §3.2）；
    // 还有 stale 数字时，出错才熄灭，empty 态（如 statusline 旧了）身份点留着。
    status: carried.length === 0 || tone === 'error' ? 'offline' : 'idle',
    windows: carried,
    updatedAt: result.windows?.length ? (result.sampledAt ?? nowIso) : prev.updatedAt,
    notice: { tone, code: result.code },
    ...(stale ? { stale: true } : {}),
    plan: prev.plan
  }
}

type Listener = (state: MonitorState) => void

export class Store {
  private state: MonitorState
  private listeners = new Set<Listener>()
  private seq = 0
  /** 画布尺寸跟着目标显示器走，由 window.ts 在每次落位后回调进来 */
  private canvas: CanvasSize = { width: 480, height: 270 }
  private mode: 'live' | 'scene'
  /** 三家最近一次的真实状态。dev 切到场景之后采集仍然写这里，只是不再上屏。 */
  private live: Record<AgentId, AgentState>

  constructor(initial: SceneName | 'live' = 'live') {
    this.mode = initial === 'live' ? 'live' : 'scene'
    const at = new Date().toISOString()
    this.live = {
      codex: blankAgent('codex', at),
      claude: blankAgent('claude', at),
      zcode: blankAgent('zcode', at)
    }
    this.state = initial === 'live'
      ? {
          scene: 'populated',
          canvas: this.canvas,
          generatedAt: at,
          // 首轮采样到达之前是骨架屏；到了就翻 false（applyQuota）
          loading: true,
          agents: this.liveAgents(),
          events: baseFeed()
        }
      : { scene: initial, ...SCENES[initial](), canvas: this.canvas }
  }

  private liveAgents(): AgentState[] {
    return [this.live.codex, this.live.claude, this.live.zcode]
  }

  /** live 用真时间；scene 用 fixtures 冻住的时间原点（截图可复现） */
  private nowMs(): number {
    return this.mode === 'live' ? Date.now() : frozenNow()
  }

  /** 一个 collector 落地一轮。scene 模式下只记不推。 */
  applyQuota(id: AgentId, result: QuotaResult): void {
    const nowIso = new Date().toISOString()
    this.live[id] = mergeQuota(this.live[id], result, nowIso)
    if (this.mode !== 'live') return
    this.emit({ ...this.state, generatedAt: nowIso, loading: false, agents: this.liveAgents() })
  }

  setCanvas(canvas: CanvasSize): void {
    if (canvas.width === this.canvas.width && canvas.height === this.canvas.height) return
    this.canvas = canvas
    this.emit({ ...this.state, canvas })
  }

  get(): MonitorState {
    return this.state
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn)
    fn(this.state)
    return () => this.listeners.delete(fn)
  }

  private emit(next: MonitorState): void {
    this.state = next
    for (const fn of this.listeners) fn(next)
  }

  setScene(scene: SceneName): void {
    this.mode = 'scene'
    this.emit({ scene, ...SCENES[scene](), canvas: this.canvas })
  }

  /** 从 fixtures 场景切回真实采集（调试栏点过场景之后的回程，复核 §3.5） */
  setLive(): void {
    this.mode = 'live'
    this.emit({
      ...this.state,
      scene: 'populated',
      generatedAt: new Date().toISOString(),
      loading: false,
      agents: this.liveAgents(),
      events: baseFeed(),
      feedNotice: undefined
    })
  }

  /** 打断 2 · 新事件：进 feed 顶部，未读 */
  simulateEvent(): AgentEvent {
    const s = POOL[this.seq++ % POOL.length]!
    const ev: AgentEvent = {
      id: `new${this.seq}-${Date.now()}`,
      agent: s.agent,
      kind: 'completed',
      title: s.title,
      summary: s.summary,
      at: new Date(this.nowMs()).toISOString(),
      acked: false
    }
    const base = this.state.events.length ? this.state : { ...this.state, ...SCENES.populated(), scene: 'populated' as SceneName, canvas: this.canvas }
    this.emit({ ...base, feedNotice: undefined, events: [ev, ...base.events] })
    return ev
  }

  /** 打断 1 · attention */
  simulateAttention(): void {
    if (this.state.events.some(e => e.kind === 'attention' && !e.acked)) return
    const base = this.state.events.length ? this.state : { ...this.state, ...SCENES.populated(), scene: 'populated' as SceneName, canvas: this.canvas }
    const ev: AgentEvent = { ...ATTN_EVENT, id: 'attn-' + Date.now(), at: new Date(this.nowMs()).toISOString() }
    this.emit({ ...base, feedNotice: undefined, events: [ev, ...base.events] })
  }

  clearAttention(): void {
    const events = this.state.events.filter(e => e.kind !== 'attention')
    if (events.length === this.state.events.length) return
    this.emit({ ...this.state, events })
  }

  /** ack 一条：attention 行 ack 即解除接管（acked 之后它就不再是「等着你」的那条） */
  ack(id: string): void {
    let hit = false
    const events = this.state.events.map(e => {
      if (e.id !== id || e.acked) return e
      hit = true
      return { ...e, acked: true }
    })
    if (hit) this.emit({ ...this.state, events })
  }

  hasAttention(): boolean {
    return this.state.events.some(e => e.kind === 'attention' && !e.acked)
  }
}
