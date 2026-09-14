/**
 * 主进程与渲染层共用的数据模型。
 * 主干来自 PLAN.md §2.3；M1 为了把 M0 原型的七态完整搬过来，加了三处最小扩展，
 * 每处都在下面注明理由，M2 接真实采集时应保留而不是回退。
 */

export type AgentId = 'codex' | 'claude' | 'zcode'

export type QuotaWindow = {
  label: '5h' | '7d' | '1mo'
  usedPercent: number
  resetsAt: string
  /** 1mo 窗是计数而非百分比（智谱 MCP 调用 8/1000），fixtures 里就带着这三个字段 */
  current?: number
  total?: number
  unit?: string
}

export type AgentStatus = 'idle' | 'running' | 'attention' | 'offline'

/**
 * 扩展 1 · notice 取代 PLAN 的 `error?`。
 * 原型的 empty 与 error 两态在版面上是同一块 msg（图标 + 标题 + 一句原因），
 * 只有色调不同；错误码单独列会让渲染层写两套一样的分支。
 * 文案不进这里 —— code 到文案的映射留在渲染层，它是设计稿的一部分。
 */
export type NoticeTone = 'empty' | 'error'
export type NoticeCode =
  | 'first_sample'     // 还没采到第一轮（empty）
  | 'no_statusline'    // Claude statusline 还没写入（empty）
  | 'missing_key'      // ZCode 未连接（empty）
  | 'unauthorized'     // 额度接口 401（error）
  | 'rate_limited'     // 429（error）
  | 'network'          // 网络不可达（error）
  | 'feed_empty'       // 今天还没有完成的任务（empty）
  | 'feed_error'       // 事件采集中断（error）

export type Notice = { tone: NoticeTone; code: NoticeCode }

export type AgentState = {
  id: AgentId
  status: AgentStatus
  windows: QuotaWindow[]
  updatedAt: string
  notice?: Notice
}

/**
 * 扩展 2 · kind 加 'running'。
 * 原型的 running 态在 C 页顶部有一行「进行中」，它不是已完成事件，
 * 但和事件行共用同一个行结构，所以放在同一个列表里而不是另起一个字段。
 */
export type EventKind = 'completed' | 'failed' | 'attention' | 'running'

export type AgentEvent = {
  id: string
  agent: AgentId
  kind: EventKind
  title: string
  summary?: string
  at: string
  /** kind === 'running' 时用它算「已跑多久」 */
  startedAt?: string
  durationMs?: number
  acked: boolean
}

export type SceneName =
  | 'populated' | 'loading' | 'empty' | 'error' | 'edge' | 'attention' | 'running'

export const SCENE_NAMES: SceneName[] = [
  'populated', 'loading', 'empty', 'error', 'edge', 'attention', 'running'
]

/** 画布尺寸：目标显示器逻辑 bounds 的一半，渲染层再 zoom: 2 铺回去。
 *  960×540 @2x → 480×270；960×640 @1x（EDID 原生 3:2 模式）→ 480×320。
 *  不写死是因为用户随时可能在两种模式间切换。 */
export type CanvasSize = { width: number; height: number }

export type MonitorState = {
  /** M1 只有 fixtures，scene 就是当前喂的是哪一份；M2 之后这个字段会消失 */
  scene: SceneName
  canvas: CanvasSize
  /**
   * 扩展 3 · 时间原点。
   * 原型把「现在」冻结在 fixtures 的 generatedAt，倒计时才与 resetsAt 自洽、截图才可复现。
   * 渲染层用 generatedAt + (Date.now() - boot) 当作 now()。
   */
  generatedAt: string
  loading: boolean
  agents: AgentState[]
  events: AgentEvent[]
  /** 事件区整体的空/错态（与单个 agent 的 notice 无关） */
  feedNotice?: Notice
}

export type Page = 'a' | 'b' | 'c' | 'attn'

/** 主进程 → 渲染层的一次性指令（状态走 MonitorState，不走这里） */
export type MonitorCommand =
  | { type: 'step'; dir: -1 | 1 }   // ⌃⌥← / ⌃⌥→
  | { type: 'home' }                // ⌃⌥↑：回 A 并恢复轮播
  /** 截图脚本用：直接定页，不触发手动暂停。token 原样回报，让脚本只认自己那一声 */
  | { type: 'showPage'; page: Page; token: number }

export type DevApi = {
  setState(name: SceneName): void
  simulateEvent(): void
  simulateAttention(): void
  clearAttention(): void
}

export type MonitorApi = {
  subscribe(cb: (state: MonitorState) => void): () => void
  onCommand(cb: (cmd: MonitorCommand) => void): () => void
  ack(id: string): void
  setPage(page: Page): void
  /** 截图脚本用：渲染层画完一帧后回报，带回指令里的 token */
  rendered(token: number): void
  dev: DevApi
}
