/**
 * MonitorState 存储 + 变更推送。
 *
 * 两种模式，形状完全一样：
 *   · live（M2 起的默认）—— 额度、事件、用量、新闻全部来自真实采集（M3 起事件也是真的）。
 *     dev 调试栏一旦切了场景就退出 live，免得真实采集把正在看的那一帧顶掉。
 *   · scene —— 七个场景全部来自 src/main/fixtures/*.json（design/fixtures 的副本），
 *     与 design/variations.html 的 SCENES 一一对应。截图对账要逐像素对得上，
 *     喂进去的数据就必须是同一份，所以这条路 M2 一个字都没动。
 */

import type {
  AgentEvent, AgentId, AgentState, AgentStatus, CanvasSize, MonitorState, NewsData, Notice,
  QuotaWindow, SceneName, UsageData
} from '../shared/types.js'
import type { QuotaResult } from './collectors/quota/types.js'
import { ERROR_TONE } from './collectors/quota/types.js'
import { Feed } from './collectors/events/feed.js'
import type { EventInput } from './collectors/events/types.js'
import { PANEL_X_COMPRESSED } from './config.js'
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

/** 在冻结原点上加 N 分钟，拿一个可复现的 resetsAt（edge 的 107h55m 用） */
const plusMinutes = (iso: string, min: number): string =>
  new Date(new Date(iso).getTime() + min * 60_000).toISOString()

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

/**
 * fixtures 里三家的模型短名，与原型的 `TOP_MODEL` 对齐（REVISION 10）。
 *
 * 不加这一项的话，B 页在**所有** fixtures 帧上都不显示模型 —— 于是
 * 「产品名 + 短名并排」这个最宽的组合在七态截图与逐格量尺里一次都测不到，
 * 而 m5-designer 钉进 edge 的那个复现正是冲着这个组合来的。
 * 真机上这个字段由 collectors/topmodel.ts 的 shortModel() 给。
 */
const TOP_MODEL: Record<AgentId, string> = {
  codex: 'Astra', claude: 'Fable 5.1', zcode: 'GLM-5.3'
}

const agent = (
  id: AgentId,
  status: AgentState['status'],
  windows: QuotaWindow[],
  notice?: Notice
): AgentState => ({
  id, status, windows, updatedAt: QUOTA.generatedAt, notice, topModel: TOP_MODEL[id]
})

const CODEX = QUOTA.codex.windows
const CLAUDE = QUOTA.claude.windows
const ZCODE = QUOTA.zcode.windows

const okAgents = (over: Partial<Record<AgentId, AgentState['status']>> = {}): AgentState[] => [
  agent('codex', over.codex ?? 'idle', CODEX),
  agent('claude', over.claude ?? 'idle', CLAUDE),
  agent('zcode', over.zcode ?? 'idle', ZCODE)
]

/** 场景只造「画什么」，不造「画多宽」——canvas 与 panelX 跟着显示器与配置走，与场景无关 */
type SceneBody = Omit<MonitorState, 'scene' | 'canvas' | 'panelX'>

const SCENES: Record<SceneName, () => SceneBody> = {
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
  /* edge 保持 97 / 82 / 61 —— 它的价值是 **danger / warn / ok 三档同屏**，
     换成三家 100% 就把这个对照丢了（m5-designer 2026-09-15 明确要求别替换）。
     三位数撑破版面那一格由下面的 full 场景负责。 */
  edge: () => ({
    generatedAt: QUOTA.generatedAt,
    loading: false,
    agents: [
      agent('codex', 'idle', [
        { label: '5h', usedPercent: 97, resetsAt: '2026-09-14T16:35:48+08:00' },
        CODEX[1]!
      ]),
      /* Claude 这一行就是**实机那一帧**（m5-designer 2026-09-15 定位并钉进 fixture）：
         61% 必须是 ok 档 —— warn/danger 时模型短名本来就不显示，
         那样就复现不出「产品名 + 短名并排」这个最宽的组合；
         只有 5h 没有 7d；倒计时 107h55m（7 字符）。
         三样凑齐才会撞上「.b-name 的 basis 0 + .b-cd 定宽」那个左截断右留空。 */
      agent('claude', 'idle', [
        { label: '5h', usedPercent: 61, resetsAt: plusMinutes(QUOTA.generatedAt, 107 * 60 + 55) }
      ]),
      // warn 这一档挪给 ZCode，edge 仍是 danger / ok / warn 三档同屏
      agent('zcode', 'idle', [{ ...ZCODE[0]!, usedPercent: 82 }, ...ZCODE.slice(1)])
    ],
    events: edgeFeed()
  }),
  /* full = 三家 5h 与 7d 全部 100%（brief 第 9 条，用户实机撞到的那一格）。
     A 页 64px 的「100」要 115.2px，而 panelX 1.19 下瓦片内宽只有 105.67px ——
     R5-11 当年算的 133px 是 480 画布的数，结论只在一种画布上成立却被当成了结论。
     这一帧存在的意义就是让「只在一种画布上成立」这件事以后必然被断言抓到。 */
  full: () => ({
    generatedAt: QUOTA.generatedAt,
    loading: false,
    agents: (['codex', 'claude', 'zcode'] as AgentId[]).map(id => {
      const src = id === 'codex' ? CODEX : id === 'claude' ? CLAUDE : ZCODE
      return agent(id, 'idle', src.map(w => ({ ...w, usedPercent: 100 })))
    }),
    events: baseFeed()
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
      plan: result.plan ?? prev.plan,
      ...(prev.topModel ? { topModel: prev.topModel } : {})
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
    plan: prev.plan,
    ...(prev.topModel ? { topModel: prev.topModel } : {})
  }
}

type Listener = (state: MonitorState) => void

/**
 * 事件状态 > 额度状态。
 * 「有人在等你」与「有人在跑」是这块屏要回答的第二个问题，比「额度接口连不上」更重要。
 *
 * **事件侧的 offline 刻意不放行**（复核 P2-2.4 指出它上不了屏 —— 确实如此，是有意的）：
 * 身份点的判据在 M2 复核里已经定死为「屏上还有没有数字」。ZCode 的 tasks 库读不到时
 * 额度那条链可能好好的、瓦片上挂着真实百分比，这时候把身份点熄掉是在说谎。
 * 「事件源离线」需要自己的表达位（C 页的一行空态文案，而不是身份点），那是设计问题，
 * 留给 designer 在 M4 定。在那之前 collector 报的 offline 只进日志与 eventStatus，不上屏。
 */
export function combineStatus(quota: AgentStatus, event: AgentStatus | null): AgentStatus {
  if (event === 'attention') return 'attention'
  if (event === 'running') return 'running'
  return quota
}

export class Store {
  private state: MonitorState
  private listeners = new Set<Listener>()
  private seq = 0
  /** 画布尺寸跟着目标显示器走，由 window.ts 在每次落位后回调进来 */
  private canvas: CanvasSize = { width: 480, height: 270 }
  private mode: 'live' | 'scene'
  /** 三家最近一次的真实状态。dev 切到场景之后采集仍然写这里，只是不再上屏。 */
  private live: Record<AgentId, AgentState>
  /** M3 · 真实事件流。scene 模式下照收不上屏，切回 live 时它已经是最新的。 */
  private feed = new Feed()
  /** 事件侧给出的 per-agent 状态（running / attention / offline），与额度侧分开存 */
  private eventStatus: Partial<Record<AgentId, AgentStatus>> = {}
  /** M3b · B 页的「当前窗口最常用模型」 */
  private topModel: Partial<Record<AgentId, string>> = {}
  private usage: UsageData | undefined
  private news: NewsData | undefined
  private panelX = PANEL_X_COMPRESSED
  /** 事件流变了就喊一声，由主进程接去落盘（Store 不碰文件系统） */
  private onFeedChange: ((events: AgentEvent[]) => void) | null = null

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
          panelX: this.panelX,
          generatedAt: at,
          // 首轮采样到达之前是骨架屏；到了就翻 false（applyQuota）
          loading: true,
          agents: this.liveAgents(),
          events: [],
          feedNotice: { tone: 'empty', code: 'feed_empty' }
        }
      : { scene: initial, ...SCENES[initial](), canvas: this.canvas, panelX: this.panelX }
  }

  private liveAgents(): AgentState[] {
    return (['codex', 'claude', 'zcode'] as AgentId[]).map(id => {
      const base = this.live[id]
      const status = combineStatus(base.status, this.eventStatus[id] ?? null)
      const top = this.topModel[id]
      return {
        ...base,
        status,
        ...(top ? { topModel: top } : {})
      }
    })
  }

  /** live 模式下的整份状态。事件与额度都从各自的「最近一次」重算，不做增量。 */
  private liveState(over: Partial<MonitorState> = {}): MonitorState {
    const events = this.feed.list()
    const next: MonitorState = {
      ...this.state,
      canvas: this.canvas,
      panelX: this.panelX,
      agents: this.liveAgents(),
      events,
      ...(this.usage ? { usage: this.usage } : {}),
      ...(this.news ? { news: this.news } : {}),
      ...over
    }
    // 事件区的空态：一条都没有时说「今天还没有完成的任务」，有了就撤掉
    if (events.length) delete next.feedNotice
    else next.feedNotice = { tone: 'empty', code: 'feed_empty' }
    return next
  }

  /** 主进程接走「事件流变了」这件事去落盘 */
  onEvents(fn: (events: AgentEvent[]) => void): void {
    this.onFeedChange = fn
  }

  /**
   * 启动时从 userData 回灌：全部已读，不打断、不响铃。
   *
   * 回灌完必须喊一声 onFeedChange（复核 P1-①）。不喊的话，「稳态重启」这条最常见的路上
   * ——盘上 50 条、三家回灌全部撞 id 被去重、这一程没有任何新事件——
   * Saver 手里的快照自始至终是空表，退出时 flush 就把 events.json 写成 `[]`，
   * 历史被抹掉一次。喊了之后「磁盘上该是什么」从启动第一刻起就有定义。
   */
  restoreEvents(events: AgentEvent[]): void {
    this.feed.restore(events)
    this.onFeedChange?.(this.feed.list())
    if (this.mode === 'live') this.emit(this.liveState())
  }

  /**
   * collector 推来一条事件。
   * `isNew` = 「这是 app 启动之后新到的」——只有它为真时才可能未读、才可能打断。
   * 启动回灌、重启恢复都走 isNew=false（简报「统一行为」第 4 条）。
   */
  ingestEvent(input: EventInput, isNew: boolean): AgentEvent | null {
    const ev = this.feed.ingest(input, isNew)
    if (!ev) return null
    this.refreshEventStatus(ev.agent)
    this.onFeedChange?.(this.feed.list())
    if (this.mode === 'live') this.emit(this.liveState({ generatedAt: new Date().toISOString() }))
    return ev
  }

  /**
   * 桌面端的会话标题到了：把这个 session 已经在列表里的事件原地改名。
   *
   * 走 onFeedChange 让它落盘（下次启动回灌回来的就是好名字了），
   * 但**不碰 generatedAt** —— 改个名不是「又采到了一轮」，
   * 时间原点动了会让整屏的相对时间跟着跳一下。
   */
  retitleSession(agent: AgentId, sessionId: string, title: string): number {
    const n = this.feed.retitle(agent, sessionId, title)
    if (!n) return 0
    this.onFeedChange?.(this.feed.list())
    if (this.mode === 'live') this.emit(this.liveState())
    return n
  }

  /** collector 直接报的状态（目前只有 offline：事件源本身连不上） */
  setEventStatus(agent: AgentId, status: AgentStatus): void {
    if (this.eventStatus[agent] === status) return
    this.eventStatus[agent] = status
    if (this.mode === 'live') this.emit(this.liveState())
  }

  private refreshEventStatus(agent: AgentId): void {
    /* 直接覆盖。原来这里有一条「offline 粘住不放」的保护，但 combineStatus 本来就不放行
       offline（见上），那条保护于是只剩一个副作用：短暂离线之后再也回不到 running ——
       collector 的恢复分支只打日志、不重新报状态（复核 P2-2.4 的顺带提醒）。
       既然 offline 上不了屏，就别让它悄悄卡住真正会上屏的那两个。 */
    this.eventStatus[agent] = this.feed.statusFor(agent)
  }

  /** running 超时清除（每分钟一次，由主进程驱动） */
  sweepRunning(now = Date.now()): AgentEvent[] {
    const dropped = this.feed.sweepRunning(now)
    if (!dropped.length) return dropped
    for (const id of new Set(dropped.map(d => d.agent))) this.refreshEventStatus(id)
    this.onFeedChange?.(this.feed.list())
    if (this.mode === 'live') this.emit(this.liveState())
    return dropped
  }

  setTopModel(agent: AgentId, name: string | undefined): void {
    if (this.topModel[agent] === name) return
    if (name) this.topModel[agent] = name
    else delete this.topModel[agent]
    if (this.mode === 'live') this.emit(this.liveState())
  }

  setUsage(usage: UsageData): void {
    this.usage = usage
    if (this.mode === 'live') this.emit(this.liveState())
  }

  setNews(news: NewsData): void {
    this.news = news
    if (this.mode === 'live') this.emit(this.liveState())
  }

  /** 横向压缩补偿。值由 main 的 PanelXConfig 算好写回配置，这里只负责上屏。 */
  setPanelX(panelX: number): void {
    if (this.panelX === panelX) return
    this.panelX = panelX
    this.emit({ ...this.state, panelX })
  }

  getPanelX(): number {
    return this.panelX
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
    this.emit(this.liveState({ generatedAt: nowIso, loading: false }))
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
    this.emit({ scene, ...SCENES[scene](), canvas: this.canvas, panelX: this.panelX })
  }

  /** 从 fixtures 场景切回真实采集（调试栏点过场景之后的回程，复核 §3.5） */
  setLive(): void {
    this.mode = 'live'
    this.emit(this.liveState({
      scene: 'populated',
      generatedAt: new Date().toISOString(),
      loading: false
    }))
  }

  /**
   * 打断 2 · 新事件（dev）。
   * live 模式下走与真实事件**同一条**路（Feed.ingest → refreshEventStatus → emit），
   * 否则演练验的就不是上线时那条路；scene 模式下仍然只改屏上的那一份。
   */
  simulateEvent(): AgentEvent {
    const s = POOL[this.seq++ % POOL.length]!
    const at = new Date(this.nowMs()).toISOString()
    const input: EventInput = {
      id: `new${this.seq}-${Date.now()}`,
      agent: s.agent,
      kind: 'completed',
      title: s.title,
      summary: s.summary,
      at,
      updatedAt: at,
      sessionId: `sim-${this.seq}`
    }
    if (this.mode === 'live') return this.ingestEvent(input, true) ?? { ...input, acked: false }
    const ev: AgentEvent = { ...input, acked: false }
    const base = this.state.events.length ? this.state
      : { ...this.state, ...SCENES.populated(), scene: 'populated' as SceneName, canvas: this.canvas }
    this.emit({ ...base, feedNotice: undefined, events: [ev, ...base.events] })
    return ev
  }

  /** 打断 1 · attention */
  simulateAttention(): void {
    if (this.hasAttention()) return
    const at = new Date(this.nowMs()).toISOString()
    if (this.mode === 'live') {
      this.ingestEvent({
        ...ATTN_EVENT, id: 'attn-' + Date.now(), at, updatedAt: at, sessionId: 'sim-attn'
      }, true)
      return
    }
    const base = this.state.events.length ? this.state
      : { ...this.state, ...SCENES.populated(), scene: 'populated' as SceneName, canvas: this.canvas }
    const ev: AgentEvent = { ...ATTN_EVENT, id: 'attn-' + Date.now(), at }
    this.emit({ ...base, feedNotice: undefined, events: [ev, ...base.events] })
  }

  clearAttention(): void {
    if (this.mode === 'live') {
      if (!this.feed.clearAttention()) return
      for (const id of ['codex', 'claude', 'zcode'] as AgentId[]) this.refreshEventStatus(id)
      this.onFeedChange?.(this.feed.list())
      this.emit(this.liveState())
      return
    }
    const events = this.state.events.filter(e => e.kind !== 'attention')
    if (events.length === this.state.events.length) return
    this.emit({ ...this.state, events })
  }

  /** ack 一条：attention 行 ack 即解除接管（acked 之后它就不再是「等着你」的那条） */
  ack(id: string): void {
    if (this.mode === 'live') {
      if (!this.feed.ack(id)) return
      for (const a of ['codex', 'claude', 'zcode'] as AgentId[]) this.refreshEventStatus(a)
      this.onFeedChange?.(this.feed.list())
      this.emit(this.liveState())
      return
    }
    let hit = false
    const events = this.state.events.map(e => {
      if (e.id !== id || e.acked) return e
      hit = true
      return { ...e, acked: true }
    })
    if (hit) this.emit({ ...this.state, events })
  }

  hasAttention(): boolean {
    const list = this.mode === 'live' ? this.feed.list() : this.state.events
    return list.some(e => e.kind === 'attention' && !e.acked)
  }

  /** 未读条数（日志与 selftest 用） */
  unread(): number {
    return this.mode === 'live' ? this.feed.unread()
      : this.state.events.filter(e => !e.acked).length
  }
}
