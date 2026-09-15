/**
 * 渲染层 —— design/variations.html 的移植：四页、七态、提示音、reduced-motion、手动切换。
 *
 * 与原型的三处结构差别：
 *   1. 数据不再来自内联 fixtures，而是主进程经 preload 推来的 MonitorState；
 *      未读在数据模型里是 `acked`（PLAN §2.3），画布上仍读作「未读」。
 *   2. 页码由 pager.ts 这个纯状态机持有，DOM 只跟着它走；轮播/打断/手动的规则全在那边，
 *      这里不再散落 dwellUntil / holdUntil 之类的可变量。
 *   3. 没有「纯净模式」—— Electron 窗口本身就是纯净的（frameless + simpleFullScreen），
 *      原型里那一档是为了在浏览器里还原副屏效果，到这里就没有对应物了。
 */

import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import '@fontsource/ibm-plex-mono/600.css'
import '../../design/tokens.css'
import './app.css'

import {
  DEFAULT_CONFIG, ack as pagerAck, create, interruptAttention, interruptEvent,
  manual, manualPaused, orderFor, setAuto, setOrder, showPage as pagerShowPage, step, tick
} from './pager.js'
import type { PagerConfig, PagerState } from './pager.js'
import type {
  AgentEvent, AgentId, AgentState, MonitorApi, MonitorState, NewsData, Notice, NoticeCode,
  Page, QuotaWindow, SceneName, UsageData
} from '../shared/types.js'
import { scaleFor } from '../shared/scale.js'
import { newsWhen } from './timefmt.js'

declare global {
  interface Window { monitor: MonitorApi }
}

/* ---------- 常量 ---------- */

/**
 * `fill` 是额度条的填充色（原型 REVISION 7）：**每家用自己的身份色**，
 * 不再是统一的 --charcoal，阈值也不再把整条改成黄 / 红。
 * 理由（designer 2026-09-14）：重绘整条会和身份色打架，而且恰好在最需要看清
 * 「这条是谁的」的时候把身份抹掉。阈值信号改由百分比数字变色 + 数字旁的
 * .b-alert 图标承担，颜色之外仍有非颜色信号（WCAG 1.4.1）。
 *
 * 这里存的是 **token 名**不是色值：ZCode 的蓝是对着 Claude 的橙做过 OKLCH 校准的，
 * 抄一份 hex 过来，任何一边重新调色时就会分家。
 */
type AgentBrand = { name: string; shortName: string; tag: string; color: string; fill: string }

/**
 * `shortName` 是 A 页瓦片标题用的短名（终审 A-2）。
 * 141px 的瓦片放不下「Claude Code」，原来被截成「Claude Co…」——
 * 瓦片上**唯一**的身份标签被省略掉了一半，而省略号本身不携带任何信息。
 * 标题改用短名，`aria-label` 仍然是全名，屏幕阅读器那边一个字不少。
 */
const AGENTS: Record<AgentId, AgentBrand> = {
  codex: { name: 'Codex', shortName: 'Codex', tag: 'Codex', color: 'var(--id-codex)', fill: 'var(--quota-fill-codex)' },
  claude: { name: 'Claude Code', shortName: 'Claude', tag: 'Claude', color: 'var(--id-claude)', fill: 'var(--quota-fill-claude)' },
  zcode: { name: 'ZCode', shortName: 'ZCode', tag: 'ZCode', color: 'var(--id-zcode)', fill: 'var(--quota-fill-zcode)' }
}

const WIN5H = 5 * 3600 * 1000
/** v2：C 拆成 C1 / C2，每页 4 行，共 8 个 session（design/brief-m0-v2.md §1） */
const PER_PAGE = 4

const KIND_LABEL: Record<string, string> = {
  running: '运行中', failed: '失败', attention: '等待批准', completed: '已完成'
}
const FEED_TITLE: Partial<Record<SceneName, string>> = {
  attention: '需要你', running: '进行中', loading: 'session', empty: 'session', error: 'session'
}

/** 指示点的 aria 名。attn 不在轮播里，不需要名字。 */
const PAGE_LABEL: Partial<Record<Page, string>> = {
  a: '总览', b: '额度详情', c1: 'session', c2: '更早的 session', d: '每日用量', e: '今日 AI'
}

/** 热力图五档。0 档是「这一天没用」，顶档是 --charcoal（与额度填充同色）。 */
const HEAT_LEVELS = 5

type Copy = { icon: IconName; title: string; why: string }

/**
 * notice code → 画布上的那块 msg。口径沿用 M0（design/review/00-designer-notes.md）：
 * 标题一句、原因与下一步压成一句。这里是与 agent 无关的默认值。
 */
const NOTICE_COPY: Record<NoticeCode, Copy> = {
  first_sample: { icon: 'clock', title: '等待首轮采样', why: '约 60 秒后自动出现' },
  no_statusline: { icon: 'inbox', title: '还没接入 statusline', why: '跑 install-claude-statusline 接入' },
  missing_key: { icon: 'key', title: '未连接', why: '还没有这一家的 API Key' },
  missing_tool: { icon: 'inbox', title: '找不到采集命令', why: '装好之后自动恢复' },
  unauthorized: { icon: 'lock', title: '额度接口 401', why: '登录令牌过期，需要重新授权' },
  rate_limited: { icon: 'hour', title: '接口限流 429', why: '已退避重试，稍后自动恢复' },
  network: { icon: 'wifi', title: '网络不可达', why: '恢复联网后自动重连，不用操作' },
  feed_empty: { icon: 'inbox', title: '今天还没有完成的任务', why: '有任务跑完会自动排到这里' },
  feed_error: { icon: 'radio', title: '事件采集中断', why: '30 秒后自动重新挂载，期间事件会补齐' }
}

/**
 * 同一个失败码，三家的下一步动作完全不同 —— 按 (agent, code) 覆盖默认文案。
 * 复核 P1-②：以前 401 无论落在谁身上都写「跑 codex login」，
 * Claude 那块瓦片上就印着这句（design/shots/m2/live-page-a.png）。
 */
const AGENT_COPY: Partial<Record<AgentId, Partial<Record<NoticeCode, Partial<Copy>>>>> = {
  codex: {
    unauthorized: { why: '登录令牌过期，跑 codex login 重新授权' },
    missing_tool: { title: '找不到 codexbar', why: '装好 codexbar 后自动恢复' }
  },
  claude: {
    unauthorized: { why: '登录令牌过期，跑 claude login 重新授权' },
    rate_limited: { why: '已退避重试，期间读 statusline 缓存' }
  },
  zcode: {
    unauthorized: { why: 'Key 失效，换一枚智谱 Key' },
    missing_key: { why: '还没有智谱 API Key' }
  }
}

const copyFor = (code: NoticeCode, agent?: AgentId): Copy =>
  ({ ...NOTICE_COPY[code], ...(agent ? AGENT_COPY[agent]?.[code] : undefined) })

type IconName = keyof typeof ICON
const ICON = {
  clock: '<circle cx="8" cy="8" r="5.8"/><path d="M8 4.6V8l2.4 1.5"/>',
  check: '<path d="M3 8.4 6.2 11.6 13 4.8"/>',
  alert: '<circle cx="8" cy="8" r="6"/><path d="M8 4.9v3.5"/><path d="M8 11.2h.01"/>',
  ret: '<path d="M13.2 3.8v3.4a2 2 0 0 1-2 2H3.4"/><path d="M6.2 6.6 3.2 9.2l3 2.8"/>',
  key: '<circle cx="5.6" cy="10.4" r="2.7"/><path d="M7.6 8.5 13 3.1"/><path d="M10.7 5.9 12.3 7.5"/>',
  lock: '<rect x="3" y="7.1" width="10" height="6.3" rx="1.7"/><path d="M5.4 7.1V5.3a2.6 2.6 0 0 1 5.2 0v1.8"/>',
  hour: '<path d="M4.5 2.6h7M4.5 13.4h7"/><path d="M5.6 2.6v2.1L8 7.1l2.4-2.4V2.6"/><path d="M5.6 13.4v-2.1L8 8.9l2.4 2.4v2.1"/>',
  wifi: '<path d="M2.3 6.1a9.2 9.2 0 0 1 3.1-1.8"/><path d="M13.7 6.1a9.2 9.2 0 0 0-4.4-2"/><path d="M4.8 8.7a5.6 5.6 0 0 1 1.7-1"/><path d="M11.2 8.7a5.6 5.6 0 0 0-1.3-.8"/><path d="M8 11.9h.01"/><path d="M2.4 2.4 13.6 13.6"/>',
  inbox: '<path d="M2.2 9.4h3.1l.9 1.9h3.6l.9-1.9h3.1"/><path d="M3.5 3.1h9l1.3 6.3v3.5H2.2V9.4z"/>',
  /* E 页行尾的外链标记（REVISION 9）：monoline，与其余图标同一套描边 */
  linkout: '<path d="M9.4 3.2h3.4v3.4"/><path d="M12.8 3.2 7.7 8.3"/>' +
    '<path d="M11.9 9.5v2.7a1.4 1.4 0 0 1-1.4 1.4H3.8a1.4 1.4 0 0 1-1.4-1.4V5.5a1.4 1.4 0 0 1 1.4-1.4h2.7"/>',
  radio: '<circle cx="8" cy="8" r="1.6"/><path d="M4.8 11.2a4.5 4.5 0 0 1 0-6.4"/><path d="M11.2 4.8a4.5 4.5 0 0 1 0 6.4"/><path d="M2.4 2.4 13.6 13.6"/>',
  dot: '<circle cx="8" cy="8" r="3.2"/>'
} as const

const svg = (n: IconName, s = 14): string =>
  `<svg viewBox="0 0 16 16" width="${s}" height="${s}" fill="none" stroke="currentColor" stroke-width="1.6" ` +
  `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[n]}</svg>`

/* ---------- 格式化 ---------- */

const p2 = (n: number): string => String(n).padStart(2, '0')
const hhmm = (d: Date): string => p2(d.getHours()) + ':' + p2(d.getMinutes())
const sameDay = (a: Date, b: Date): boolean =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()

const countdown = (iso: string, ref: number): string => {
  /* 没有重置时刻 → 「—」。采集侧在「5h 窗这一程没有任何使用记录」时会补一个
     `resetsAt: ''` 的占位窗（Claude Code 会整个省掉 five_hour 这个键）。
     不挡住的话这里会算出 NaN，屏上是 `NaNhNaNm`。 */
  const t = new Date(iso).getTime()
  if (!iso || Number.isNaN(t)) return '—'
  const ms = Math.max(0, t - ref)
  const m = Math.floor(ms / 60000), h = Math.floor(m / 60)
  return h > 0 ? `${h}h${p2(m % 60)}m` : `${m}m`
}
const elapsedFmt = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000))
  return s < 3600 ? `${Math.floor(s / 60)}m${p2(s % 60)}s`
    : `${Math.floor(s / 3600)}h${p2(Math.floor(s / 60) % 60)}m`
}
const whenFmt = (iso: string, ref: number): string => {
  const d = new Date(iso), diff = ref - d.getTime()
  if (diff < 60000) return '刚刚'
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`
  return sameDay(d, new Date(ref)) ? hhmm(d) : `${d.getMonth() + 1}/${d.getDate()} ${hhmm(d)}`
}
/**
 * stale 标记：数字还是上一轮的真数据，只是旧了。岁数由 AgentState.updatedAt 算。
 * A 页的瓦片实测只有 141px 宽，那一格装不下「数据 59 分钟前」（selftest 逐字量过），
 * 所以 A 页用短形 —— 那里的图标已经在说「连不上」；B 页的判语位宽敞，用完整那句。
 */
const staleFmt = (iso: string, ref: number, short = false): string => {
  const m = Math.floor(Math.max(0, ref - new Date(iso).getTime()) / 60000)
  const h = Math.floor(m / 60)
  const body = m < 1 ? '1 分钟内'
    : m < 60 ? `${m} 分钟前`
      : h < 24 ? `${h} 小时前` : `${Math.floor(h / 24)} 天前`
  return short ? body : `数据 ${body}`
}
const level = (p: number): 'ok' | 'warn' | 'danger' => (p >= 95 ? 'danger' : p >= 80 ? 'warn' : 'ok')
const esc = (s: unknown): string =>
  String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string))

/* ---------- 视图模型 ---------- */

type Msg = { tone: Notice['tone'] } & Copy

/**
 * Tile 做成判别联合，而不是 `phase: string` + `windows[0]!`。
 * 「phase === 'ok' 就一定有 5h 窗」这条不变量原来只写在注释里，M2 接真实采集时
 * 「拿到了响应但 windows 是空数组」是完全可能的一种返回，那时渲染层会当场抛。
 * 现在由类型担保：ok 分支的 windows 是非空元组，空数组进不来（见 toScene）。
 */
type OkTile = {
  agent: AgentId
  phase: 'ok'
  status: AgentState['status']
  windows: [QuotaWindow, ...QuotaWindow[]]
  /** v2 §2 · B 页判语那一格改显示的「当前 5h 窗用得最多的模型」。没采到就缺省，留空。 */
  topModel?: string
  /** 采集出错但旧数字还在：照常画数字，把「后重置 / 速度判语」那一格换成「数据 N 分钟前」 */
  stale?: { since: string; icon: IconName }
}
type LoadingTile = { agent: AgentId; phase: 'loading'; status: AgentState['status'] }
type NoticeTile = { agent: AgentId; phase: 'msg'; status: AgentState['status']; msg: Msg }
// 判别字段必须是字面量，写成 'loading' | 'msg' 的话 if/else 链narrow 不下去
type Tile = OkTile | LoadingTile | NoticeTile
type Feed = { phase: 'ok' | 'loading' | 'msg'; items: AgentEvent[]; msg?: Msg }
type Scene = {
  tiles: Tile[]
  feed: Feed
  usage?: UsageData
  news?: NewsData
  usageState: DataState
  newsState: DataState
}

const toMsg = (n: Notice, agent?: AgentId): Msg => ({ tone: n.tone, ...copyFor(n.code, agent) })

function toTile(a: AgentState, loading: boolean): Tile {
  if (loading) return { agent: a.id, phase: 'loading', status: a.status }
  const [w5, ...rest] = a.windows
  // 没有 notice 也没有窗口 —— 有响应但还没数据，按「等待首轮采样」的空态画，别当成 ok
  // 有 notice 但旧数字还在（stale）—— 数字仍然是这块屏上最有用的信息，照画，
  // 只把那一格判语换成数据的岁数；一次网络抖动不该把三块瓦片清成文案。
  if (!w5 || (a.notice && !a.stale)) {
    return {
      agent: a.id,
      phase: 'msg',
      status: a.status,
      msg: toMsg(a.notice ?? { tone: 'empty', code: 'first_sample' }, a.id)
    }
  }
  return {
    agent: a.id,
    phase: 'ok',
    status: a.status,
    windows: [w5, ...rest],
    ...(a.topModel ? { topModel: a.topModel } : {}),
    ...(a.stale && a.notice
      ? { stale: { since: a.updatedAt, icon: copyFor(a.notice.code, a.id).icon } }
      : {})
  }
}

/**
 * D / E 两页的数据是独立来源（codexbar cost 与 AIHOT），与三家额度无关，
 * 所以它们各有各的五态。scene 模式（调试栏的七态）下跟着场景名走 ——
 * 原型就是这么演示的，截图对账要对得上。
 */
type DataState = 'ok' | 'loading' | 'empty' | 'error' | 'edge'

const SCENE_DATA_STATE: Partial<Record<SceneName, DataState>> = {
  loading: 'loading', empty: 'empty', error: 'error', edge: 'edge'
}

function dataStateFor(s: MonitorState, has: boolean, err: boolean): DataState {
  const forced = SCENE_DATA_STATE[s.scene]
  if (forced) return forced
  if (err) return 'error'
  return has ? 'ok' : 'loading'
}

function toScene(s: MonitorState): Scene {
  const tiles: Tile[] = s.agents.map(a => toTile(a, s.loading))
  const feed: Feed = {
    phase: s.loading ? 'loading' : s.feedNotice ? 'msg' : 'ok',
    items: s.events,
    msg: s.feedNotice ? toMsg(s.feedNotice) : undefined
  }
  return {
    tiles,
    feed,
    usage: s.usage,
    news: s.news,
    usageState: dataStateFor(s, !!s.usage?.days.length, !!s.usage?.error),
    newsState: dataStateFor(s, !!s.news?.items.length, !!s.news?.error)
  }
}

/* ---------- DOM ---------- */

const root = document.documentElement
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

const el = {
  paTiles: $('paTiles'), pbBands: $('pbBands'),
  pc1Feed: $('pc1Feed'), pc2Feed: $('pc2Feed'),
  pdHeat: $('pdHeat'), peNews: $('peNews'), paAttn: $('paAttn'),
  feedTitle: $('feedTitle'), dots: $('dots'), live: $('live'), meter: $('meter'),
  unread: $('unread'), topLoading: $('topLoading'),
  panelxFlash: $('panelxFlash'), calib: $('calib')
}

/** 「‖」手动暂停标记。指示点整块重画时它会被重建，所以不能放进上面那张常量表。 */
let holdmark: HTMLElement | null = null

const params = new URLSearchParams(location.search)
const DEBUG = params.get('debug') === '1'
root.dataset.debug = DEBUG ? '1' : '0'

/* ---------- 时钟：原点由主进程给（fixtures 的 generatedAt），倒计时才与 resetsAt 自洽 ---------- */

let now0 = Date.now()
let boot = Date.now()
const now = (): number => now0 + (Date.now() - boot)

/* ---------- 运行时状态 ---------- */

let state: MonitorState | null = null
let scene: Scene = {
  tiles: [], feed: { phase: 'loading', items: [] }, usageState: 'loading', newsState: 'loading'
}
let cfg: PagerConfig = DEFAULT_CONFIG
let pg: PagerState = create(Date.now())
let rm = window.matchMedia('(prefers-reduced-motion:reduce)').matches
/**
 * 提示音静音 —— 托盘的开关，主进程经 `{type:'mute'}` 推来（首帧与每次重载都会补推）。
 *
 * M1 复核 §3.4：原型把静音绑在 `prefers-reduced-motion` 上，于是一个只想关动画的用户
 * 会连「有人在等你」那一声一起丢掉。两件事没有关系，M4 把它们拆开：
 * 动画看 `rm`，声音只看这一位。
 */
let muted = false
let lastPage: Page | null = null
let knownIds = new Set<string>()
let firstState = true
/** 上一帧的时间原点 —— 变了才重新对时，见 onState */
let lastGeneratedAt = ''
/** 上一帧的场景名 —— 调试栏切场景时整份 events 被换掉，那不算「新事件」 */
let state0: SceneName | null = null
/** ack 之前焦点在哪一行：重渲染会销毁行元素，之后要把焦点还回去 */
let refocusRowId: string | null = null

const cssMs = (name: string): number => {
  const v = getComputedStyle(root).getPropertyValue(name).trim()
  const n = v.endsWith('ms') ? parseFloat(v) : parseFloat(v) * 1000
  return Number.isFinite(n) ? n : 0
}

function readConfig(): PagerConfig {
  const read = (name: string, fallback: number): number => cssMs(name) || fallback
  return {
    dwellA: read('--dwell-a', DEFAULT_CONFIG.dwellA),
    dwellB: read('--dwell-b', DEFAULT_CONFIG.dwellB),
    dwellC: read('--dwell-c', DEFAULT_CONFIG.dwellC),
    dwellEvent: read('--dwell-event', DEFAULT_CONFIG.dwellEvent),
    manualHold: read('--manual-hold', DEFAULT_CONFIG.manualHold)
  }
}

/* ---------- 渲染：A 页 ---------- */

function footIcon(t: Tile, lv: string): IconName {
  if (t.phase === 'ok' && t.stale) return t.stale.icon
  if (t.status === 'attention') return 'ret'
  if (lv !== 'ok') return 'alert'
  if (t.status === 'running') return 'dot'
  return 'clock'
}

const msgBlock = (m: Msg): string => `<div class="msg" data-tone="${m.tone}">
  <div class="msg-head">${svg(m.icon, 15)}<span>${esc(m.title)}</span></div>
  <p>${esc(m.why)}</p></div>`

function renderPageA(): void {
  el.paTiles.innerHTML = scene.tiles.map(t => {
    const a = AGENTS[t.agent]
    const lv = t.phase === 'ok' ? level(t.windows[0].usedPercent) : 'ok'
    const head = `<div class="tile-head"><h2 class="tile-name">${esc(a.shortName)}</h2>` +
      `<span class="iddot"${t.status === 'offline' ? ' data-off="1"' : ''}></span></div>`
    let body: string
    if (t.phase === 'loading') {
      body = `<div class="skel"><i style="height:44px;width:70%"></i>
        <i style="height:18px;width:48%"></i><span class="loading-label sr" role="status">读取中</span></div>`
    } else if (t.phase === 'msg') {
      body = msgBlock(t.msg)
    } else {
      const w5 = t.windows[0]
      body = `<div class="a-body"><div class="a-nums" data-wide="${w5.usedPercent >= 100 ? 1 : 0}">
          <span class="num">${w5.usedPercent}</span><span class="unit">%</span></div></div>
        <div class="tile-foot" data-level="${lv}" data-status="${t.status}">${svg(footIcon(t, lv), 15)}<span
          class="cd mono" data-foot="${esc(w5.resetsAt)}" data-level="${lv}" data-status="${t.status}"></span><span
          class="word"${t.stale
            ? ` data-stale="${esc(t.stale.since)}" data-stale-short="1"`
            : ` data-word="${lv}|${t.status}"`}></span></div>`
    }
    return `<section class="tile" data-status="${t.status}" data-level="${lv}" style="--idc:${a.color};--fill:${a.fill}" ` +
      `aria-label="${esc(a.name)} 额度">${head}${body}</section>`
  }).join('')
}

/* ---------- 渲染：B 页 ---------- */

function renderPageB(): void {
  el.pbBands.innerHTML = scene.tiles.map(t => {
    const a = AGENTS[t.agent]
    const lv = t.phase === 'ok' ? level(t.windows[0].usedPercent) : 'ok'
    const off = t.phase !== 'ok' || t.status === 'offline'
    /* REVISION 10 · 模型短名跟在产品名后面。四条都不显示：
       ① 没有模型数据（分隔符是关系，不是装饰，连「·」也不出现）；
       ② 这一行有状态词（等待你批准 / 运行中）—— 一行只带一个从属信息，
          而状态词永远比「用得最多的模型」更该被看到；
       ③ warn / danger 档 —— 那一刻该被读到的是余量，不是模型；
       ④ stale（M2 的扩展）—— 该说的是「数字有多旧」。 */
    const word = t.status === 'attention' ? '等待你批准' : t.status === 'running' ? '运行中' : ''
    // Tile 是判别联合：stale / topModel 只在 ok 那一支上有，所以先收窄再取
    const model = t.phase === 'ok' && !word && !t.stale && lv === 'ok' ? (t.topModel ?? '') : ''
    const nameCell = `<h2 class="b-name"><span class="iddot"${off ? ' data-off="1"' : ''}></span>` +
      `<span class="t">${esc(a.name)}</span>` +
      (model ? `<span class="b-model">· ${esc(model)}</span>` : '') + '</h2>'
    let inner: string
    if (t.phase === 'loading') {
      inner = `<div class="b-head">${nameCell}<span class="b-verdict"><span class="loading-label sr" role="status">读取中</span></span></div>
        <div class="skel" style="flex:none"><i style="height:12px"></i></div>`
    } else if (t.phase === 'msg') {
      const m = t.msg
      inner = `<div class="b-head">${nameCell}<span class="b-verdict" data-tone="${m.tone === 'error' ? 'error' : 'mute'}">${
        svg(m.icon, 14)} ${esc(m.title)}</span></div>
        <div class="b-note">${esc(m.why)}</div>`
    } else {
      const w5 = t.windows[0], w7 = t.windows[1]
      const start = new Date(w5.resetsAt).getTime() - WIN5H
      /* v2 §2 · 判语整句删掉，原位置改显示「当前窗口用得最多的模型名」。
         「够不够撑到重置」不丢：它由时间带上填充与「现在」游标的落差承担。
         stale 时仍然让位给「数据 N 分钟前」—— 那一刻更该说的是数字有多旧。 */
      inner = `<div class="b-head b-head-ok">${nameCell}
        ${t.stale
          ? `<span class="b-verdict" data-tone="mute" data-stale="${esc(t.stale.since)}"></span>`
          : word
            ? `<span class="b-verdict" data-tone="${t.status === 'attention' ? 'attn' : 'mute'}">${esc(word)}</span>`
            : ''}
        ${lv === 'ok' ? '' : `<span class="b-alert" aria-label="${lv === 'danger' ? '余量吃紧' : '余量偏紧'}">${svg('alert', 14)}</span>`}
        <span class="b-pc mono">${w5.usedPercent}%</span>
        ${w7 ? `<span class="b-sec mono">${esc(w7.label)} ${w7.usedPercent}%</span>` : ''}
        <span class="b-cd mono" data-cd="${esc(w5.resetsAt)}"></span></div>
        <div class="bandbox">
          <div class="band" role="img" aria-label="5h 窗已用 ${w5.usedPercent}%，右端为重置点">
            <span class="used" style="width:${w5.usedPercent}%"></span>
            </div>
          <span class="caret" data-caret="${start}"></span>
          <span class="resettick"></span></div>`
    }
    return `<section class="tile" data-status="${t.status}" data-level="${lv}" style="--idc:${a.color};--fill:${a.fill}" ` +
      `aria-label="${esc(a.name)} 额度">${inner}</section>`
  }).join('')
}

/* ---------- 渲染：C 页 ---------- */

function rowHTML(it: AgentEvent, isLead: boolean, aged: boolean): string {
  const a = AGENTS[it.agent]
  const unread = !it.acked
  const icon: IconName = it.kind === 'failed' ? 'alert' : it.kind === 'attention' ? 'ret'
    : it.kind === 'running' ? 'dot' : 'check'
  /* v2 §1 · 时间一律是「最后更新时间」，running 也是 ——
     它随新活动推进，所以屏上从「刚刚」开始往后爬，而不是停在开始时刻。 */
  const lu = it.updatedAt ?? it.at
  const timeAttr = `data-when="${esc(lu)}"`
  const when = whenFmt(lu, now())
  const label = `${a.name} · ${KIND_LABEL[it.kind] ?? KIND_LABEL.completed} · ${it.title} · ${when}` +
    (unread ? ' · 未读，按 Enter 标记已读' : '')
  const first = it.kind === 'attention'
    ? `<span class="attn-tag">${svg('ret', 13)}等待你</span>`
    : `<span class="chip">${esc(a.tag)}</span>`
  return `<button type="button" class="row${isLead ? ' lead' : ''}" data-id="${esc(it.id)}" ` +
    `data-kind="${it.kind}" data-unread="${unread ? 1 : 0}" data-aged="${aged ? 1 : 0}" ` +
    `style="--idc:${a.color}" aria-label="${esc(label)}">` +
    first + `<span class="rtitle">${esc(it.title)}</span>` +
    `<span class="rtime" ${timeAttr}></span>` +
    `<span class="rkind" data-kind="${it.kind}">${svg(icon, 14)}</span>` +
    `<span class="rmark"></span></button>`
}

/**
 * v2 §1 · C 拆成 C1 / C2，每页 4 行，共 8 个 session。
 * 排序：running 置顶，其余按**最后更新时间**倒序（不是开始时间，也不是完成时间）。
 * 放大的那一条只在 C1 的首位 —— 它是「最新的一件事」；C2 是溢出页，四行等权。
 */
const lastUpdateOf = (it: AgentEvent): string => it.updatedAt ?? it.at

export function sortSessions(items: AgentEvent[]): AgentEvent[] {
  return [...items].sort((x, y) => {
    const rx = x.kind === 'running' ? 1 : 0
    const ry = y.kind === 'running' ? 1 : 0
    if (rx !== ry) return ry - rx
    return Date.parse(lastUpdateOf(y)) - Date.parse(lastUpdateOf(x))
  })
}

/** C2 有没有行 —— 指示点个数与轮播列表都读它（空则整页跳过） */
const hasC2 = (): boolean =>
  scene.feed.phase === 'ok' && sortSessions(scene.feed.items).length > PER_PAGE

function renderPageC(): void {
  const f = scene.feed
  el.feedTitle.textContent = (state && FEED_TITLE[state.scene]) || '最近的 session'
  if (f.phase === 'loading') {
    el.pc1Feed.innerHTML = `<div class="feed-skel"><i></i><i></i><i></i><i></i>
      <span class="loading-label sr" role="status">读取中</span></div>`
    el.pc2Feed.innerHTML = ''
    return
  }
  if (f.phase === 'msg') {
    const m = f.msg!
    el.pc1Feed.innerHTML = `<div class="feed-msg msg" data-tone="${m.tone}">
      <div class="msg-head">${svg(m.icon, 15)}<span>${esc(m.title)}</span></div>
      <p>${esc(m.why)}</p></div>`
    el.pc2Feed.innerHTML = ''
    return
  }
  /* 全套强调只给一条：有 attention 时给它，否则给排序后的第一条未读。
     顺序不能反 —— 在排序之前打旗标，屏上第一行就不是被强调的那条
     （designer 的断言抓到过这个）。 */
  const all = sortSessions(f.items)
  const attn = all.some(x => x.kind === 'attention' && !x.acked)
  let spent = false
  const paint = (list: AgentEvent[], withLead: boolean): string => list.map((it, i) => {
    const full = !spent && (attn ? it.kind === 'attention' : !it.acked)
    if (full) spent = true
    return rowHTML(it, withLead && i === 0, !it.acked && !full)
  }).join('')
  el.pc1Feed.innerHTML = paint(all.slice(0, PER_PAGE), true)
  el.pc2Feed.innerHTML = paint(all.slice(PER_PAGE, PER_PAGE * 2), false)
  tickFeed()
}

/* ---------- 渲染：D 页 · 每日用量热力图 ---------- */

/**
 * 数字缩写。热力图的 tooltip 要在 14px 一行里报三家，全写 3 亿会把行撑破。
 */
export const fmtNum = (v: number): string =>
  v >= 1e8 ? (v / 1e8).toFixed(1) + '亿'
    : v >= 1e4 ? (v / 1e4).toFixed(1) + '万' : String(v)

/** 0 档留给「这一天没用」，其余四档按窗口内最大值均分 */
export function heatLevel(intensity: number, max: number): number {
  if (!intensity) return 0
  const t = max > 0 ? intensity / max : 0
  return Math.min(HEAT_LEVELS - 1, 1 + Math.floor(t * (HEAT_LEVELS - 1) - 1e-9))
}

/** 隔行标星期，免得 14px 在 13px 的格距上挤成一片 */
const DAY_LABEL = ['一', '', '三', '', '五', '', '日']

function renderPageD(): void {
  const st = scene.usageState
  /* `!usage?.days.length` 这一半是 M4 补的（不在 M4 简报上，但 M4 的日志把它照出来了）：
     `edge` 场景在 dataStateFor 里是**无条件**返回 'edge' 的，而 fixtures 的 edge 帧
     根本没有 usage 字段。原来这里紧接着写 `scene.usage!`，于是调试栏切到 edge、
     以及 selftest 跑七态截图时，D 页每次都抛
     `Cannot read properties of undefined (reading 'days')`——
     整个 onState 那一轮渲染就此中断。E 页同位置写的是 `scene.news?.items ?? []`，
     两页本该一致。

     守卫本身不用动：`st !== 'ok' && st !== 'edge'` 就是 DataState 里的
     {loading, empty, error}，与原型 2026-09-14 独立修好的
     `st === "loading" || st === "empty" || st === "error"` 同义 —— edge 不再
     被当成空态。缺的只是「拿到 edge 却没有 usage」这一格的兜底。 */
  const usage = scene.usage
  if ((st !== 'ok' && st !== 'edge') || !usage?.days.length) {
    el.pdHeat.innerHTML = st === 'loading'
      ? `<div class="feed-skel"><i style="height:20px"></i><i style="height:104px"></i>
         <span class="loading-label" role="status">读取中</span></div>`
      : `<div class="feed-msg msg" data-tone="${st === 'error' ? 'error' : 'empty'}">
         <div class="msg-head">${svg(st === 'error' ? 'radio' : 'inbox', 15)}<span>${
           st === 'error' ? '用量数据读取失败' : '还没有用量数据'}</span></div>
         <p>${st === 'error' ? 'codexbar cost 调用超时，30 分钟后重试' : '跑满一天后这里会出现第一格'}</p></div>`
    return
  }
  const days = usage.days
  const maxI = days.reduce((m, d) => Math.max(m, d.intensity || 0), 0)
  /* D-1 · cell 原来写死 13px，而 cols 是「宽度能放下多少列」的上限（算出 23）——
     版面按 23 列设计、数据给了 8 列，中间缺了「回流到格子尺寸」这一步：
     热力图只占可用宽的 30%，单格 2.08mm，而这是唯一一页需要分辨密度差异的页。
     改成由宽 / 高两个预算里较小的那个推出，上限 28px、下限 10px：
     今天的 8 周给 cell 18（单格 2.88mm，+92% 面积、纵向填满），
     数据长到 26 周时同一个公式自己降回密排，不需要再改第二次。 */
  const avail = el.pdHeat.clientWidth || 387
  const gridW = avail - 26 - 8                                              // 减掉星期标签列与它的间隙
  const gridH = Math.max(42, el.pdHeat.clientHeight - 20 - 8 - 20 - 8)      // 减掉页眉 / 说明行与两道间隙
  const cols = Math.max(4, Math.min(Math.ceil(days.length / 7), Math.floor((gridW + 2) / 12)))
  const shown = days.slice(-cols * 7)
  if (!shown.length) { el.pdHeat.innerHTML = ''; return }
  /* 第一格对齐到周一：JS 的 getDay() 周日是 0 */
  const firstIdx = (new Date(shown[0]!.date).getDay() + 6) % 7
  /* 列宽要按**真正会画出来的列数**算：开头补齐到周一的空格会把最后一周挤成第 9 列，
     按 8 列算宽度就会多画一列、整页溢出 17px（原型第一版就是这么溢的）。 */
  const drawnCols = Math.ceil((firstIdx + shown.length) / 7)
  /* 列宽填满可用宽（上限 48，列数很少时不至于长成色块），行高取 min(列宽, 高预算 / 7)
     并封顶 28：8 周 → 42×18 填满宽高，26 周 → 11×11 方格并纵向居中，自己退化。
     **格子不再是正方形** —— 横向是「哪一周」，纵向是「星期几」，两个轴本来就不同质。 */
  const cellW = Math.max(10, Math.min(48, Math.floor((gridW + 2) / drawnCols) - 2))
  const cellH = Math.max(10, Math.min(28, cellW, Math.floor((gridH + 2) / 7) - 2))
  const cellsHtml = Array.from({ length: firstIdx }, () =>
    '<span class="cell" data-void="1" aria-hidden="true"></span>').join('') +
    shown.map(d => {
      const lv = heatLevel(d.intensity, maxI)
      return `<button type="button" class="cell" data-l="${lv}" data-date="${esc(d.date)}" ` +
        `tabindex="-1" aria-label="${esc(d.date)} 用量第 ${lv} 档"></button>`
    }).join('')
  const weeks = usage.weeks || Math.round(shown.length / 7)
  el.pdHeat.innerHTML = `
    <div class="d-head"><span class="d-title">每日用量 · 近 ${weeks} 周</span>
      <span class="d-date" id="dDate"></span></div>
    <div class="d-grid" style="--cell-w:${cellW}px;--cell-h:${cellH}px">
      <div class="d-days">${DAY_LABEL.map(x => `<span>${x}</span>`).join('')}</div>
      <div class="d-cells" id="dCells">${cellsHtml}</div>
    </div>
    <div class="d-tip"><span class="d-nums" id="dNums"></span></div>`

  const cells = [...el.pdHeat.querySelectorAll<HTMLElement>('.cell[data-date]')]
  const byDate = new Map(days.map(d => [d.date, d]))
  const dateEl = el.pdHeat.querySelector<HTMLElement>('#dDate')!
  const nums = el.pdHeat.querySelector<HTMLElement>('#dNums')!
  /* 单位由主进程显式给（usage.units），不靠「哪个键存在」去猜 ——
     ZCode 走 model_usage 时是 token，退回日志时才是请求数，同一个字段两种含义。 */
  const units = usage.units
  const unitWord = (id: AgentId): string => (units[id] === 'requests' ? ' 次' : ' tok')
  /* D-3 + D-4 · 说明行整条让给三家的数值，一家都不许缺 —— 缺的那家显式渲染成「—」，
     而不是让省略号把它吞掉（上一版第三家整个消失就是这么来的）。
     身份色图例同时删掉：那三个色点挂在一张**单色**网格上，是在告诉用户
     「格子按 agent 着色」，而格子其实只有明度一个维度 —— 图例主动误导。
     日期上移到页眉右侧，与 E 页的更新时间同一个槽位。 */
  const showTip = (c: HTMLElement): void => {
    const d = byDate.get(c.dataset.date!)
    if (!d) return
    const b = d.byAgent
    const val = (id: AgentId, v: string): string =>
      `<span>${esc(AGENTS[id].shortName)} <b>${esc(v)}</b></span>`
    dateEl.textContent = d.date
    nums.innerHTML =
      val('codex', b.codex ? fmtNum(b.codex.tokens || 0) + unitWord('codex') : '—') +
      val('claude', b.claude ? fmtNum(b.claude.tokens || 0) + unitWord('claude') : '—') +
      val('zcode', b.zcode ? fmtNum(b.zcode.tokens ?? b.zcode.requests ?? 0) + unitWord('zcode') : '—')
    cells.forEach(x => { x.tabIndex = x === c ? 0 : -1 })
  }
  cells.forEach((c, i) => {
    c.addEventListener('mouseenter', () => showTip(c))
    c.addEventListener('focus', () => showTip(c))
    c.addEventListener('keydown', e => {
      const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
      if (!d) return
      const t = cells[i + d]
      if (t) { t.focus(); e.preventDefault(); e.stopPropagation() }
    })
  })
  const last = cells[cells.length - 1]
  if (last) { last.tabIndex = 0; showTip(last) }
}

/* ---------- 渲染：E 页 · 今日 AI 大事（AIHOT） ---------- */

/**
 * 不打断、不响铃、不计未读。
 * AIHOT 的返回是外部文本，一律当不可信：只经 esc() 以纯文本渲染，不建链接、不预取。
 */
function renderPageE(): void {
  const st = scene.newsState
  const items = (scene.news?.items ?? []).slice(0, 5)
  if (st === 'loading') {
    el.peNews.innerHTML = `<div class="feed-skel">${'<i style="height:30px"></i>'.repeat(5)}
      <span class="loading-label" role="status">读取中</span></div>`
    return
  }
  if (st === 'error' && !items.length) {
    el.peNews.innerHTML = `<div class="feed-msg msg" data-tone="error">
      <div class="msg-head">${svg('radio', 15)}<span>AIHOT 暂时连不上</span></div>
      <p>30 分钟后重试，期间显示上一次的结果</p></div>`
    return
  }
  if (!items.length) {
    el.peNews.innerHTML = `<div class="feed-msg msg" data-tone="empty">
      <div class="msg-head">${svg('inbox', 15)}<span>今天还没有精选</span></div>
      <p>AIHOT 的精选是人工策展，空窗期很正常</p></div>`
    return
  }
  /* 断网但有缓存：照常画，更新时间旁边说明它是旧的 —— 缓存比一句错误文案有用 */
  const updated = scene.news?.updatedAt ?? ''
  el.peNews.innerHTML = `
    <div class="e-head"><span class="e-title">今日 AI · AIHOT</span>
      <span class="e-upd"${st === 'error' ? '' : ` data-when="${esc(updated)}"`}>${
        st === 'error' ? '连不上 · 显示缓存' : ''}</span></div>
    <div class="e-list">${items.map((it, i) => `<button type="button" class="e-item" data-news="${esc(it.id)}">
        <span class="e-no">${i + 1}</span>
        <span class="e-t">${esc(it.title)}</span>
        <span class="e-meta"><span class="e-src">${esc(it.source ?? 'AIHOT')}</span>
          <!-- E-1 · 这里**不**再实现一遍剥前缀的规则。原型里有一个 srcName()，
               那是因为原型没有采集层；本项目的 it.source 只有一个来源，就是
               collectors/news.ts 的 shortSource()，规则连同实测样本的用例都在那边。
               渲染层再写一份，就是第二处会漂移的真源 —— 和 tokens.css 只留一份是同一条纪律。 -->
          <span class="e-time" data-newswhen="${esc(it.at ?? updated)}"></span>
          <span class="e-go">${svg('linkout', 16)}</span></span>
      </button>`).join('')}</div>`
  /* 标题行数由实测行高决定，不按画布高度一刀切：3 条时每条放得下两行，
     满 5 条时每条只剩 27px，自动退回一行。 */
  const list = el.peNews.querySelector<HTMLElement>('.e-list')
  if (list) {
    const per = (list.clientHeight - 4 * (items.length - 1)) / Math.max(1, items.length)
    el.peNews.style.setProperty('--e-lines', String(Math.max(1, Math.min(3, Math.floor(per / 19)))))
  }
  tickFeed()
}

/* ---------- 渲染：attention 页 ---------- */

const attnItem = (): AgentEvent | undefined =>
  scene.feed.items.find(x => x.kind === 'attention' && !x.acked)

function renderPageAttn(): void {
  const it = attnItem()
  if (!it) {
    el.paAttn.innerHTML = `<div class="feed-msg msg" data-tone="empty">
      <div class="msg-head">${svg('check', 15)}<span>没有等待你的事</span></div>
      <p>有 agent 请求批准时，这一页会接管整屏并暂停轮播。</p></div>`
    return
  }
  const a = AGENTS[it.agent]
  el.paAttn.innerHTML = `<div class="attn-card" style="--idc:${a.color}">
    <span class="attn-dot"></span>
    <span class="attn-who">${esc(a.tag)}</span>
    <span class="attn-lead">${svg('ret', 26)}等待你</span>
    <span class="attn-what">${esc(it.title)}</span>
    <span class="attn-meta"><span>${esc(it.summary ?? '')}</span>
      <span class="mono" data-elapsed2="${esc(it.at)}"></span></span></div>`
}

/* ---------- 逐秒增量更新 ---------- */

function tickClocks(): void {
  const txt = hhmm(new Date(now()))
  document.querySelectorAll<HTMLElement>('[data-clock]').forEach(n => { n.textContent = txt })
}

function tickTiles(): void {
  const t = now()
  document.querySelectorAll<HTMLElement>('[data-foot]').forEach(n => {
    n.textContent = n.dataset.status === 'attention' ? '' : countdown(n.dataset.foot!, t)
  })
  document.querySelectorAll<HTMLElement>('[data-word]').forEach(n => {
    const [lv, st] = n.dataset.word!.split('|')
    n.textContent =
      /* A-1 · 「后重置」删掉：左边 15px 的时钟图标已经把「这是倒计时」说完了，
         这三个字是对图标的文字复述，而它恰好把 5 字符倒计时（约 80% 的时间）
         挤出瓦片内宽，被硬切成「后重」—— 一个残缺字形比一个省略号更糟。
         剩下的四个词都不是复述：它们说的是图标说不了的那件事。 */
      st === 'attention' ? '等待你批准'
        : lv === 'danger' ? '吃紧'
          : lv === 'warn' ? '偏紧'
            : st === 'running' ? '运行中'
              : ''
  })
  document.querySelectorAll<HTMLElement>('[data-cd]').forEach(n => {
    n.textContent = countdown(n.dataset.cd!, t)
  })
  document.querySelectorAll<HTMLElement>('[data-stale]').forEach(n => {
    n.textContent = staleFmt(n.dataset.stale!, t, n.dataset.staleShort === '1')
  })
  document.querySelectorAll<HTMLElement>('[data-caret]').forEach(n => {
    const pct = Math.max(0, Math.min(100, ((t - Number(n.dataset.caret)) / WIN5H) * 100))
    n.style.left = pct.toFixed(2) + '%'
  })
  /* v2 §2 · 判语整句删掉，原位置改显示当前窗口用得最多的模型名。
     「够不够撑到重置」不丢：它由时间带上填充与「现在」游标的落差承担，
     不再用一句话复述 —— 那句话在 14px 上本来也只是被扫过去而不是被读。
     还没采到 topModel 时整格留空，不写「未知」占位。 */
  /* REVISION 10 起这里没有 [data-model] 要刷了：模型短名是 nameCell 里的静态文本，
     状态词也在 renderPageB 里就定好。留这段空跑一遍只是浪费一次 querySelectorAll。 */
}

function tickFeed(): void {
  const t = now()
  document.querySelectorAll<HTMLElement>('[data-when]').forEach(n => {
    n.textContent = whenFmt(n.dataset.when!, t)
  })
  document.querySelectorAll<HTMLElement>('[data-elapsed]').forEach(n => {
    n.textContent = elapsedFmt(t - new Date(n.dataset.elapsed!).getTime())
  })
  document.querySelectorAll<HTMLElement>('[data-newswhen]').forEach(n => {
    n.textContent = newsWhen(n.dataset.newswhen!, t)
  })
  document.querySelectorAll<HTMLElement>('[data-elapsed2]').forEach(n => {
    n.textContent = '已等 ' + elapsedFmt(t - new Date(n.dataset.elapsed2!).getTime())
  })
}

/* ---------- 跨阈值播报 ---------- */

const lastLevel: Partial<Record<AgentId, string | null>> = {}
function announceThresholds(): void {
  scene.tiles.forEach(t => {
    if (t.phase !== 'ok') { lastLevel[t.agent] = null; return }
    const w = t.windows[0], lv = level(w.usedPercent), prev = lastLevel[t.agent]
    if (prev && prev !== lv && lv !== 'ok') {
      el.live.textContent = `${AGENTS[t.agent].name} 5h 额度已达 ${w.usedPercent}%，` +
        (lv === 'danger' ? '余量吃紧' : '余量偏紧')
    }
    lastLevel[t.agent] = lv
  })
}

/* ---------- 页切换 ---------- */

/**
 * 指示点。v2 §6：水平居中、贴画布底边（原来在右下角与瓦片边框重合）。
 * 个数随轮播列表变 —— C2 空时少一个；attention 页不在列表里，那时全部暗着，
 * 这本身就是「当前不在轮播的六页里」这条状态信息。
 */
function renderDots(p: Page): void {
  const L = pg.order
  el.dots.innerHTML = '<span class="holdmark" id="holdmark" data-not-accent hidden>&#8214;</span>' +
    L.map((q, i) => `<button type="button" data-p="${esc(q)}" data-not-accent ` +
      `data-on="${q === p ? 1 : 0}" aria-label="第 ${i + 1} 页 ${esc(PAGE_LABEL[q] ?? q)}"></button>`).join('')
  holdmark = document.getElementById('holdmark')
  if (holdmark) holdmark.hidden = !manualPaused(pg, Date.now())
}

function applyPage(): void {
  const p = pg.page
  root.dataset.page = p
  document.querySelectorAll<HTMLElement>('.page').forEach(n => {
    const on = n.dataset.p === p
    n.dataset.on = on ? '1' : '0'
    // inert 是主机制：aria-hidden 只挡无障碍树，挡不住 Tab（R5-01）
    n.inert = !on
    n.setAttribute('aria-hidden', on ? 'false' : 'true')
  })
  renderDots(p)
  lastPage = p
  syncTopbar()
  syncSegPage()
  window.monitor.setPage(p)
}

function syncSegPage(): void {
  if (!DEBUG) return
  document.querySelectorAll<HTMLElement>('#segPage button').forEach(b => {
    b.setAttribute('aria-pressed', String(b.dataset.p === pg.page))
  })
}

/** 未读数与「读取中」都挂在顶栏，它对三页都在（R5-07 / R3-16） */
function syncTopbar(): void {
  el.topLoading.hidden = !(state?.loading ?? false)
  const unread = scene.feed.items.filter(x => !x.acked).length
  el.unread.textContent = unread > 0 && (pg.page === 'a' || pg.page === 'b') ? `· ${unread}` : ''
}

function updateMeter(): void {
  // ‖ 每 100ms 刷一次，到期自己消失 —— 只在切页时刷会让它停在屏上
  if (holdmark) holdmark.hidden = !manualPaused(pg, Date.now())
  if (!DEBUG) return
  const left = Math.max(0, pg.dwellUntil - Date.now()) / 1000
  const leftTxt = left >= 10 ? String(Math.ceil(left)) : left.toFixed(1)
  const held = Math.max(0, pg.holdUntil - Date.now()) / 1000
  el.meter.textContent = pg.attention ? 'attention 接管 · 轮播暂停'
    : held > 0 ? `${pg.page.toUpperCase()} · 手动暂停 ${Math.ceil(held)}s`
      : !pg.auto ? '轮播关闭'
        : pg.page === 'attn' ? 'attention'
          : `${pg.page.toUpperCase()}${pg.eventHold && pg.page === 'c1' ? ' · 新事件钉住' : ''} · ${leftTxt}s`
}

/* ---------- 提示音 ---------- */

let ac: AudioContext | null = null
function chime(): void {
  if (muted) return
  try {
    ac = ac ?? new AudioContext()
    if (ac.state === 'suspended') void ac.resume()
    const t = ac.currentTime, g = ac.createGain()
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(0.055, t + 0.012)
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18)
    g.connect(ac.destination)
    ;([[784, 1], [1174.7, 0.5]] as const).forEach(([f, m]) => {
      const o = ac!.createOscillator(), og = ac!.createGain()
      o.type = 'sine'; o.frequency.setValueAtTime(f, t)
      og.gain.setValueAtTime(m, t); o.connect(og); og.connect(g); o.start(t); o.stop(t + 0.2)
    })
  } catch { /* 没有音频设备也不该让面板停下来 */ }
}

/* ---------- 画布尺寸与横向压缩补偿 ---------- */

/**
 * 画布尺寸由主进程给（目标显示器 bounds / 2）：960×540 @2x → 480×270，
 * 960×640 @1x（面板的 EDID 原生 3:2 模式）→ 480×320。
 * panelX 的换算在 shared/scale.ts —— 主进程与这里必须用同一份算术。
 */
let panelXShown = 0
function applyCanvas(canvas: { width: number; height: number }, panelX: number): void {
  const { w, h, sx, sy } = scaleFor(canvas, panelX)
  root.style.setProperty('--canvas-w', `${w}px`)
  root.style.setProperty('--canvas-h', `${h}px`)
  root.style.setProperty('--scale-x', String(sx))
  root.style.setProperty('--scale-y', String(sy))
  panelXShown = panelX
}

/** ⌃⌥] / ⌃⌥[ / ⌃⌥0 之后右上角闪 1 s。不写进 aria-live —— 它是给眼睛的即时反馈。 */
let flashTimer: ReturnType<typeof setTimeout> | null = null
function flashPanelX(value: number): void {
  el.panelxFlash.textContent = value.toFixed(2)
  el.panelxFlash.dataset.on = '1'
  if (flashTimer) clearTimeout(flashTimer)
  flashTimer = setTimeout(() => { delete el.panelxFlash.dataset.on }, 1000)
}

function toggleCalibration(): void {
  const on = el.calib.dataset.on === '1'
  if (on) delete el.calib.dataset.on
  else el.calib.dataset.on = '1'
  el.live.textContent = on ? '校准叠层已关闭' : `校准叠层已打开，当前补偿 ${panelXShown.toFixed(2)}`
}

/* ---------- 状态进来 ---------- */

const motionOn = (): boolean => !rm

function onState(next: MonitorState): void {
  const prevIds = knownIds
  const prevAttn = pg.attention
  state = next
  scene = toScene(next)
  root.dataset.state = next.scene

  applyCanvas(next.canvas, next.panelX)

  const isFirst = firstState
  /* 时间原点跟着 `generatedAt` 走，而不是只认首帧。
     只认首帧的后果（M4 实测）：selftest 先跑真实采集、之后再切 fixtures 场景，
     原点仍停在真实的「现在」，于是 fixtures 里那些早已过去的 resetsAt 全被夹成
     「0m 后重置」—— 落盘的七态截图整批是错的。
     判据是 `generatedAt` **变了**才重置，不是每帧都重置：live 模式下
     setPanelX / setCanvas 这类 emit 会原样带着上一次采集的 generatedAt，
     每帧都重置会让屏上的钟往回跳到上次采集的时刻。 */
  if (firstState || next.generatedAt !== lastGeneratedAt) {
    now0 = new Date(next.generatedAt).getTime()
    boot = Date.now()
    firstState = false
  }
  lastGeneratedAt = next.generatedAt

  const nowMs = Date.now()
  const hasAttn = !!attnItem()
  /* 「新事件」= 这一帧第一次见到的未读事件。
     首帧例外：fixtures 里本来就有一条未读，如果把它当新事件，面板一开机就跳 C 页并响一声，
     而简报的默认是从 A 页起轮播。首帧只认帧、不打断（复核 P1）。
     切场景同理：整份 events 被换掉，不该被读成「来了新事件」。 */
  const sceneChanged = !!state0 && state0 !== next.scene
  const fresh = isFirst || sceneChanged
    ? undefined
    : next.events.find(e => !prevIds.has(e.id) && !e.acked && e.kind !== 'attention')
  state0 = next.scene
  knownIds = new Set(next.events.map(e => e.id))

  // FLIP：新行从顶部推入，其余行跟着往下走。C1 / C2 两块都要量 ——
  // 一条新 session 会把 C1 的第 4 行挤到 C2 的首位，只量 C1 那条行会凭空闪现。
  const anim = motionOn() && !!fresh
  const before = new Map<string, number>()
  if (anim) {
    feedRows().forEach(r => { before.set(r.dataset.id!, r.getBoundingClientRect().top) })
  }

  renderPageA(); renderPageB(); renderPageC(); renderPageD(); renderPageE(); renderPageAttn()
  tickTiles(); tickFeed(); tickClocks()
  // C2 可能刚空掉 / 刚有行：轮播列表与指示点个数跟着变
  pg = setOrder(pg, orderFor(hasC2()), nowMs, cfg)

  /* ack 走的是 IPC 往返，回来时 renderPageC 整块 innerHTML 重写，行元素必然被销毁重建，
     焦点于是掉到 <body>，键盘用户每标记一条已读就要从头 Tab（原型里有 again.focus()，
     移植时掉了）。把焦点还给同一条 data-id。 */
  if (refocusRowId) {
    const sel = `.row[data-id="${CSS.escape(refocusRowId)}"]`
    const again = el.pc1Feed.querySelector<HTMLElement>(sel) ?? el.pc2Feed.querySelector<HTMLElement>(sel)
    refocusRowId = null
    again?.focus()
  }
  announceThresholds()
  if (next.loading) el.live.textContent = '正在读取三个 agent 的额度与事件'

  if (anim) {
    feedRows().forEach(r => {
      const prev = before.get(r.dataset.id!)
      if (prev == null) { r.classList.add('enter'); return }
      const d = prev - r.getBoundingClientRect().top
      if (!d) return
      r.style.transition = 'none'
      r.style.transform = `translateY(${d}px)`
      requestAnimationFrame(() => {
        r.style.transition = 'transform var(--dur-event) var(--ease-standard)'
        r.style.transform = ''
      })
    })
  }

  // 打断 1 · attention 接管 / 解除。首帧就带 attention 时仍然接管（那是当前状态，
  // 不是「刚发生」），但不响提示音 —— 开机的一声会被当成刚有人在等你。
  if (hasAttn && !prevAttn) {
    pg = interruptAttention(pg, nowMs)
    if (!isFirst) chime()
    el.live.textContent = '需要你批准：' + (attnItem()?.title ?? '')
  } else if (!hasAttn && prevAttn) {
    pg = pagerAck(pg, nowMs, cfg)
    el.live.textContent = '等待批准已解除，轮播恢复'
  } else if (fresh) {
    // 打断 2 · 新事件：跳 C 停满一个 dwell；attention 接管期间 pager 会自己挡住
    pg = interruptEvent(pg, nowMs, cfg)
    chime()
    el.live.textContent = `新事件：${AGENTS[fresh.agent].name} ${fresh.title}`
  }

  applyPage()
  updateMeter()
}

/* ---------- ack ---------- */

/** C1 + C2 的全部行。FLIP 与 ack 都要把两页当成一个列表看。 */
const feedRows = (): HTMLElement[] => [
  ...el.pc1Feed.querySelectorAll<HTMLElement>('.row'),
  ...el.pc2Feed.querySelectorAll<HTMLElement>('.row')
]

const onFeedClick = (e: Event): void => {
  const row = (e.target as HTMLElement).closest<HTMLElement>('.row')
  if (!row) return
  const it = scene.feed.items.find(x => x.id === row.dataset.id)
  if (!it || it.acked) return
  // attention 行 ack 之后整屏会回 A 页，那里没有这一行可还；其余行记下来等重渲染后还焦点
  if (it.kind !== 'attention' && document.activeElement === row) refocusRowId = it.id
  window.monitor.ack(it.id)
  const left = scene.feed.items.filter(x => !x.acked).length - 1
  el.live.textContent = it.kind === 'attention' ? '已批准，轮播恢复'
    : left ? `已标记已读，还剩 ${left} 条未读` : '已全部读完'
}
el.pc1Feed.addEventListener('click', onFeedClick)
el.pc2Feed.addEventListener('click', onFeedClick)

/* E 页：点一条就在系统浏览器里打开它（brief-m0-v2 §8）。
   这里**只发 id** —— 链接、协议与域名白名单都在主进程（见 main/newslink.ts）。
   行本身是 `<button>`，所以 Enter / Space 由浏览器直接派成 click，不用再听一次键盘。
   与 C 页不同：不 ack、不计未读、不打断轮播；但这是一次真实的手动交互，
   所以按既有规则把轮播暂停 120 s —— 用户正要去看这条，别在他眼皮底下翻页。 */
el.peNews.addEventListener('click', e => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('.e-item[data-news]')
  if (!b) return
  markUserInput()
  pg = manual(pg, 'e', Date.now(), cfg)
  applyPage()
  window.monitor.openNews(b.dataset.news!)
})

/* ---------- 手动切换：键盘 / 指示点 / 边缘热区 ---------- */

/** 只给真正会用方向键打字的控件让路 —— 放宽成「焦点在任何控件上就不响应」会让勾选框
 *  拿到焦点后方向键直接失灵（原型里这条是被断言抓出来的）。 */
function isTyping(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false
  if (t.isContentEditable || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return true
  return t.tagName === 'INPUT' &&
    !['checkbox', 'radio', 'button', 'submit'].includes((t as HTMLInputElement).type)
}

document.addEventListener('keydown', e => {
  if (isTyping(e.target)) return
  const nowMs = Date.now()
  if (e.key === 'ArrowRight') { pg = step(pg, 1, nowMs, cfg); applyPage(); e.preventDefault() }
  else if (e.key === 'ArrowLeft') { pg = step(pg, -1, nowMs, cfg); applyPage(); e.preventDefault() }
  else if (e.key === 'ArrowUp' || e.key === 'Home') { pg = manual(pg, 'a', nowMs, cfg); applyPage(); e.preventDefault() }
})

el.dots.addEventListener('click', e => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('button[data-p]')
  if (!b) return
  pg = manual(pg, b.dataset.p as Page, Date.now(), cfg)
  applyPage()
})

const CHEVRON = (d: string): string =>
  `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" ` +
  `stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
  `<path d="${d === 'prev' ? 'M15 5 8 12l7 7' : 'M9 5l7 7-7 7'}"/></svg>`

let hintTimer = 0
document.querySelectorAll<HTMLElement>('.edge').forEach(n => {
  n.innerHTML = CHEVRON(n.dataset.side!)
  n.addEventListener('click', () => {
    pg = step(pg, n.dataset.side === 'next' ? 1 : -1, Date.now(), cfg)
    applyPage()
  })
  // 无常驻控件：鼠标移入才浮出 chevron，2s 无移动即隐藏
  const show = (): void => {
    if (pg.attention) return
    n.dataset.hint = '1'
    clearTimeout(hintTimer)
    hintTimer = window.setTimeout(() => {
      document.querySelectorAll<HTMLElement>('.edge').forEach(m => { m.dataset.hint = '0' })
    }, 2000)
  }
  n.addEventListener('mouseenter', show)
  n.addEventListener('mousemove', show)
  n.addEventListener('mouseleave', () => { n.dataset.hint = '0' })
  n.addEventListener('focus', () => { n.dataset.hint = '1' })
  n.addEventListener('blur', () => { n.dataset.hint = '0' })
})

/* ---------- 调试栏 ---------- */

if (DEBUG) {
  const chkRotate = $<HTMLInputElement>('chkRotate')
  chkRotate.addEventListener('change', () => {
    pg = setAuto(pg, chkRotate.checked, Date.now(), cfg)
    root.dataset.rotate = pg.auto ? '1' : '0'
    updateMeter()
  })
  const chkRm = $<HTMLInputElement>('chkRm')
  chkRm.addEventListener('change', () => {
    rm = chkRm.checked || window.matchMedia('(prefers-reduced-motion:reduce)').matches
    root.dataset.rm = rm ? '1' : '0'
  })
  $('segPage').addEventListener('click', e => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('button[data-p]')
    if (!b) return
    const p = b.dataset.p as Page
    // attn 是一张状态页而不是轮播里的一页，手动路径到不了它；控制栏是核对工具，
    // 用 showPage 直接定过去，不走 manual 的 120s 暂停语义。
    pg = p === 'attn' ? pagerShowPage(pg, p, Date.now(), cfg) : manual(pg, p, Date.now(), cfg)
    applyPage()
    syncSegPage()
  })
  $('segState').addEventListener('click', e => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('button[data-s]')
    if (!b) return
    document.querySelectorAll<HTMLElement>('#segState button').forEach(x => {
      x.setAttribute('aria-pressed', String(x.dataset.s === b.dataset.s))
    })
    window.monitor.dev?.setState(b.dataset.s as SceneName)
  })
  $('btnPush').addEventListener('click', () => window.monitor.dev?.simulateEvent())
  $('btnAttn').addEventListener('click', () => {
    if (attnItem()) window.monitor.dev?.clearAttention()
    else window.monitor.dev?.simulateAttention()
  })
}

/* ---------- 主进程指令 ---------- */

window.monitor.onCommand(cmd => {
  const nowMs = Date.now()
  if (cmd.type === 'step') pg = step(pg, cmd.dir, nowMs, cfg)
  else if (cmd.type === 'home') pg = manual(pg, 'a', nowMs, cfg)
  else if (cmd.type === 'showPage') pg = pagerShowPage(pg, cmd.page, nowMs, cfg)
  else if (cmd.type === 'panelX') {
    // 值已经由主进程夹紧并写回配置，这里只负责换算与闪显；状态里的 panelX 随后也会推来。
    // 首帧之前也可能按到（快捷键是全局的），那时按默认画布算，下一帧 onState 会纠正。
    applyCanvas(state?.canvas ?? { width: 480, height: 270 }, cmd.value)
    flashPanelX(cmd.value)
    return
  } else if (cmd.type === 'calibrate') {
    toggleCalibration()
    return
  } else if (cmd.type === 'mute') {
    muted = cmd.value
    return
  }
  applyPage()
  if (cmd.type === 'showPage') {
    // 截图脚本等的就是这一声：两帧之后版面才真的落定。
    // token 原样回报 —— 没有它，上一轮迟到的回报会提前解锁下一轮，拍到过渡帧（复核 P1）。
    const token = cmd.token
    requestAnimationFrame(() => requestAnimationFrame(() => window.monitor.rendered(token)))
  }
})

/* ---------- 启动 ---------- */

cfg = readConfig()
pg = create(Date.now(), { page: 'a', auto: true }, cfg)
root.dataset.rm = rm ? '1' : '0'
root.dataset.rotate = '1'
window.matchMedia('(prefers-reduced-motion:reduce)').addEventListener('change', ev => {
  rm = ev.matches
  root.dataset.rm = rm ? '1' : '0'
})

window.monitor.subscribe(onState)
applyPage()

/* 静置态不该有焦点。
   实测：窗口起来之后 activeElement 是 .edge[data-side="prev"]（第一个可聚焦元素），
   于是面板一静置就挂着一圈 focus ring 加一个浮出的 chevron —— 截图里看得一清二楚。
   来源是 Chromium 在窗口/文档拿到焦点时自己派的，不是用户按的，所以判据用「用户有没有
   动过键鼠」而不是「谁被聚焦了」：第一次 keydown / pointerdown 之前到达的焦点一律丢掉，
   之后 Tab 与点击照常工作。 */
let userDrivenFocus = false
const markUserInput = (): void => { userDrivenFocus = true }
window.addEventListener('keydown', markUserInput, { capture: true })
window.addEventListener('pointerdown', markUserInput, { capture: true })
document.addEventListener('focusin', e => {
  if (userDrivenFocus) return
  const t = e.target
  if (t instanceof HTMLElement && t !== document.body) t.blur()
})

setInterval(() => { tickClocks(); tickTiles(); tickFeed() }, 1000)
setInterval(() => {
  const before = pg.page
  pg = tick(pg, Date.now(), cfg)
  if (pg.page !== before || lastPage !== pg.page) applyPage()
  updateMeter()
}, 100)
