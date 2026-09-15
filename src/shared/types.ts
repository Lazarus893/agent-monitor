/**
 * 主进程与渲染层共用的数据模型。
 * 主干来自 PLAN.md §2.3；M1 为了把 M0 原型的七态完整搬过来加了三处最小扩展，
 * M2 接真实采集时又加了第四处（stale / plan）。每处都在下面注明理由。
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
  | 'missing_tool'     // PATH 与 /opt/homebrew/bin 里都没有 codexbar（empty）
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
  /** 最后一次「窗口数字是真的」的时刻 —— 采集成功时刷新，出错时停住不动 */
  updatedAt: string
  notice?: Notice
  /**
   * 扩展 4（M2）· 采集出错但上一轮的数字还留着。
   * 这时 windows 仍然是真数据，只是旧了：渲染层照常画数字，并在倒计时旁标
   * 「数据 N 分钟前」（N 由 updatedAt 算）。没有这一位的话，一次网络抖动
   * 就会把三块瓦片清成错误文案，而屏上本来还有可用的信息。
   */
  stale?: boolean
  /** 订阅档位：codex 的 loginMethod、智谱的 level。随状态推到渲染层，当前没有任何一页画它。 */
  plan?: string
  /**
   * 扩展 5（M3b）· 当前 5h 窗内用得最多的模型显示名（≤ 20 字符）。
   * B 页原来那句「按这个速度用不完」的判语换成它（design/brief-m0-v2.md §2）：
   * 「够不够撑到重置」由时间带上的落差承担，文字位置让给一个当下才知道的事实。
   * 没采到就缺省，渲染层留空 —— 不要用「未知」占住那一行。
   */
  topModel?: string
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
  /** 完成时刻（PLAN §2.3 的 at）。running 行没有完成时刻，这里放最后活动时刻。 */
  at: string
  /**
   * 扩展 5（M3b §4）· 最后活动时刻。
   * `at` 是「这件事什么时候结束的」，`updatedAt` 是「这个 session 最后一次动是什么时候」——
   * running 的行只有后者，而 C1/C2 两页要显示的正是后者（design/brief-m0-v2.md §1）。
   * 完成的行两者相等；running 的行 updatedAt 随新活动往前走，逐秒重算相对时间。
   */
  updatedAt?: string
  /** 事件来自哪个会话 —— 同一会话的后续事件覆盖前一条（一个 session 在列表里只占一行） */
  sessionId?: string
  /** 工作目录，日志与行尾的路径标注用。不进日志的是内容，不是路径。 */
  cwd?: string
  /** kind === 'running' 时用它算「已跑多久」 */
  startedAt?: string
  durationMs?: number
  acked: boolean
}

/* ==========================================================================
   M3b · v2 数据层：每日用量热力图、AIHOT 新闻。
   两块都是「页面自己的数据」，与 agent 的额度/事件无关，所以挂在 MonitorState
   顶层而不是塞进 AgentState —— D 页与 E 页各读各的，缺一个不影响另一个。
   ========================================================================== */

/** 一天的三家用量。单位三家不同（Codex/Claude 是 token，ZCode 视来源可能是请求数），
 *  所以不合并成一个 total：合出来的数只有大小、没有意义。热力图用 intensity 着色。 */
export type UsageDay = {
  /** 本地日期 YYYY-MM-DD */
  date: string
  byAgent: {
    codex?: { tokens: number }
    claude?: { tokens: number }
    zcode?: { tokens?: number; requests?: number }
  }
  /** 0–1。三家各自按 8 周窗口内的最大值归一后求均值 —— 与 design/fixtures/usage.json 同口径 */
  intensity: number
}

export type UsageData = {
  updatedAt: string
  /** 近 N 周，周一起算，含空白天 */
  weeks: number
  days: UsageDay[]
  /** 每家的单位，渲染层 tooltip 用（'tokens' | 'requests'） */
  units: Partial<Record<AgentId, 'tokens' | 'requests'>>
  /** 采集失败时保留上一轮的 days，并带一个码；渲染层画 error 态 */
  error?: NoticeCode
}

/**
 * AIHOT 的一条。全部当**不可信文本**：只渲染为纯文本，不注入 HTML、不预取任何链接。
 *
 * **这里没有 url，是有意的**（brief-m0-v2 §8）。E 页的行可以点开，但渲染层
 * 从头到尾不持有链接：它只把 `id` 发给主进程，由主进程从新闻缓存里取出那条的
 * AIHOT 站内阅读页，校验协议与域名之后才 `shell.openExternal`。
 * 链接是**来自网络的不可信字符串**，让它进渲染层就等于把它放进一个
 * 随时可能被当成 href 用的地方。
 */
export type NewsItem = {
  id: string
  title: string
  summary?: string
  source?: string
  /** publishedAt，ISO */
  at?: string
  reason?: string
}

export type NewsData = {
  updatedAt: string
  items: NewsItem[]
  error?: NoticeCode
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
  /**
   * 扩展 6（M3）· 横向压缩补偿。
   * 副屏在 960×540 模式下被面板缩放器横向压 15.6%（EDID 原生 960×640），
   * 用户用 design/tools/aspect-test.html 的正圆实测系数为 1.19。
   * 画布逻辑宽度 = round(canvas.width / panelX)，stage 横向再按比例拉回去，
   * 于是屏上 1px 宽 = 1px 高。960×640 原生模式下为 1.0。
   */
  panelX: number
  /** D 页：每日用量热力图。还没采到第一轮时缺省。 */
  usage?: UsageData
  /** E 页：今日 AI 大事。还没采到第一轮时缺省。 */
  news?: NewsData
}

/**
 * 页码。
 * M1 移植的是 A / B / C / attn 四页；M3b 的 v2 版把 C 拆成 C1/C2 并新增 D、E，
 * 这里先把名字定下来（IPC 与配置要用），渲染层的 ORDER 仍是 M1 那三页 ——
 * 六页版的移植要等 designer 交付 design/variations.html 的 v2。
 */
export type Page = 'a' | 'b' | 'c' | 'c1' | 'c2' | 'd' | 'e' | 'attn'

/** 主进程 → 渲染层的一次性指令（状态走 MonitorState，不走这里） */
export type MonitorCommand =
  | { type: 'step'; dir: -1 | 1 }   // ⌃⌥← / ⌃⌥→
  | { type: 'home' }                // ⌃⌥↑：回 A 并恢复轮播
  /** 截图脚本用：直接定页，不触发手动暂停。token 原样回报，让脚本只认自己那一声 */
  | { type: 'showPage'; page: Page; token: number }
  /** ⌃⌥] / ⌃⌥[ ：panelX ±0.02；⌃⌥0 复位。值由主进程算好写回配置，这里只推结果。 */
  | { type: 'panelX'; value: number }
  /** ⌃⌥C：校准叠层开关（200px 正圆 + 十字线，调到正圆即为补偿到位） */
  | { type: 'calibrate' }
  /**
   * M4 · 托盘「静音提示音」。
   * 走 command 而不是塞进 MonitorState：它是一个偏好，不是被观察到的数据，
   * 而 `setScene` / `liveState` 每次都重建整份 state —— 偏好放进去就要在
   * 每一处构造点重新穿一遍，漏一处就是「切了场景之后静音失效」。
   * 主进程在 did-finish-load 时补推一次当前值，重载后不会丢。
   */
  | { type: 'mute'; value: boolean }

export type DevApi = {
  /** 场景名 = 喂 fixtures；'live' = 切回真实采集 */
  setState(name: SceneName | 'live'): void
  /** 把某个 agent 的下一轮采集强制成指定失败码；code 为 null 时解除（M2 断网演练用） */
  forceError(agent: AgentId, code: NoticeCode | null): void
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
  /**
   * E 页：把某条新闻在系统浏览器里打开。
   * **只发 id**，不发 URL —— 链接与校验都在主进程那边（见 NewsItem 的注释）。
   */
  openNews(id: string): void
  /**
   * 调试栏用的那几个模拟入口。**打包产物里不存在**（preload 里按构建期常量挂上），
   * 所以是可选的 —— 调用点必须写 `?.`，这正是它的真实形态。
   * 主进程侧也按 `app.isPackaged` 不注册对应频道，两道都挡着。
   */
  dev?: DevApi
}
