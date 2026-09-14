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
  manual, manualPaused, setAuto, showPage as pagerShowPage, step, tick
} from './pager.js'
import type { PagerConfig, PagerState } from './pager.js'
import type {
  AgentEvent, AgentId, AgentState, MonitorApi, MonitorState, Notice, NoticeCode, Page, QuotaWindow, SceneName
} from '../shared/types.js'

declare global {
  interface Window { monitor: MonitorApi }
}

/* ---------- 常量 ---------- */

const AGENTS: Record<AgentId, { name: string; tag: string; color: string }> = {
  codex: { name: 'Codex', tag: 'Codex', color: 'var(--id-codex)' },
  claude: { name: 'Claude Code', tag: 'Claude', color: 'var(--id-claude)' },
  zcode: { name: 'ZCode', tag: 'ZCode', color: 'var(--id-zcode)' }
}

const WIN5H = 5 * 3600 * 1000
const ROW_BUDGET = 4 // C 页：1 放大 + 3 行

const KIND_LABEL: Record<string, string> = {
  running: '运行中', failed: '失败', attention: '等待批准', completed: '已完成'
}
const FEED_TITLE: Partial<Record<SceneName, string>> = {
  attention: '需要你', running: '进行中', loading: '事件', empty: '事件', error: '事件'
}

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
  const ms = Math.max(0, new Date(iso).getTime() - ref)
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
  /** 采集出错但旧数字还在：照常画数字，把「后重置 / 速度判语」那一格换成「数据 N 分钟前」 */
  stale?: { since: string; icon: IconName }
}
type LoadingTile = { agent: AgentId; phase: 'loading'; status: AgentState['status'] }
type NoticeTile = { agent: AgentId; phase: 'msg'; status: AgentState['status']; msg: Msg }
// 判别字段必须是字面量，写成 'loading' | 'msg' 的话 if/else 链narrow 不下去
type Tile = OkTile | LoadingTile | NoticeTile
type Feed = { phase: 'ok' | 'loading' | 'msg'; items: AgentEvent[]; msg?: Msg }
type Scene = { tiles: Tile[]; feed: Feed }

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
    ...(a.stale && a.notice
      ? { stale: { since: a.updatedAt, icon: copyFor(a.notice.code, a.id).icon } }
      : {})
  }
}

function toScene(s: MonitorState): Scene {
  const tiles: Tile[] = s.agents.map(a => toTile(a, s.loading))
  const feed: Feed = {
    phase: s.loading ? 'loading' : s.feedNotice ? 'msg' : 'ok',
    items: s.events,
    msg: s.feedNotice ? toMsg(s.feedNotice) : undefined
  }
  return { tiles, feed }
}

/* ---------- DOM ---------- */

const root = document.documentElement
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

const el = {
  paTiles: $('paTiles'), pbBands: $('pbBands'), pcFeed: $('pcFeed'), paAttn: $('paAttn'),
  feedTitle: $('feedTitle'), dots: $('dots'), live: $('live'), meter: $('meter'),
  unread: $('unread'), holdmark: $('holdmark'), topLoading: $('topLoading')
}

const params = new URLSearchParams(location.search)
const DEBUG = params.get('debug') === '1'
root.dataset.debug = DEBUG ? '1' : '0'

/* ---------- 时钟：原点由主进程给（fixtures 的 generatedAt），倒计时才与 resetsAt 自洽 ---------- */

let now0 = Date.now()
let boot = Date.now()
const now = (): number => now0 + (Date.now() - boot)

/* ---------- 运行时状态 ---------- */

let state: MonitorState | null = null
let scene: Scene = { tiles: [], feed: { phase: 'loading', items: [] } }
let cfg: PagerConfig = DEFAULT_CONFIG
let pg: PagerState = create(Date.now())
let rm = window.matchMedia('(prefers-reduced-motion:reduce)').matches
let lastPage: Page | null = null
let knownIds = new Set<string>()
let firstState = true
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
    const head = `<div class="tile-head"><h2 class="tile-name">${esc(a.name)}</h2>` +
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
    return `<section class="tile" data-status="${t.status}" data-level="${lv}" style="--idc:${a.color}" ` +
      `aria-label="${esc(a.name)} 额度">${head}${body}</section>`
  }).join('')
}

/* ---------- 渲染：B 页 ---------- */

function renderPageB(): void {
  el.pbBands.innerHTML = scene.tiles.map(t => {
    const a = AGENTS[t.agent]
    const lv = t.phase === 'ok' ? level(t.windows[0].usedPercent) : 'ok'
    const off = t.phase !== 'ok' || t.status === 'offline'
    const nameCell = `<h2 class="b-name"><span class="iddot"${off ? ' data-off="1"' : ''}></span>` +
      `<span class="t">${esc(a.name)}</span></h2>`
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
      inner = `<div class="b-head">${nameCell}
        <span class="b-verdict"${t.stale
          ? ` data-tone="mute" data-stale="${esc(t.stale.since)}"`
          : ` data-verdict="${start}" data-used="${w5.usedPercent}" data-status="${t.status}"`}></span>
        <span class="b-pc mono">${w5.usedPercent}%</span>
        ${w7 ? `<span class="b-sec mono">${esc(w7.label)} ${w7.usedPercent}%</span>` : ''}
        <span class="b-cd mono" data-cd="${esc(w5.resetsAt)}"></span></div>
        <div class="bandbox">
          <div class="band" role="img" aria-label="5h 窗已用 ${w5.usedPercent}%，右端为重置点">
            <span class="used" style="width:${w5.usedPercent}%"></span>
            <span class="caret" data-caret="${start}"></span></div>
          <span class="resettick"></span></div>`
    }
    return `<section class="tile" data-status="${t.status}" data-level="${lv}" style="--idc:${a.color}" ` +
      `aria-label="${esc(a.name)} 额度">${inner}</section>`
  }).join('')
}

/* ---------- 渲染：C 页 ---------- */

function rowHTML(it: AgentEvent, isLead: boolean, aged: boolean): string {
  const a = AGENTS[it.agent]
  const unread = !it.acked
  const icon: IconName = it.kind === 'failed' ? 'alert' : it.kind === 'attention' ? 'ret'
    : it.kind === 'running' ? 'dot' : 'check'
  const timeAttr = it.kind === 'running'
    ? `data-elapsed="${esc(it.startedAt ?? it.at)}"` : `data-when="${esc(it.at)}"`
  const when = it.kind === 'running'
    ? elapsedFmt(now() - new Date(it.startedAt ?? it.at).getTime()) : whenFmt(it.at, now())
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

function renderPageC(): void {
  const f = scene.feed
  el.feedTitle.textContent = (state && FEED_TITLE[state.scene]) || '最近完成'
  if (f.phase === 'loading') {
    el.pcFeed.innerHTML = `<div class="feed-skel"><i></i><i></i><i></i>
      <span class="loading-label" role="status" style="padding:4px 8px 0">读取中</span></div>`
    return
  }
  if (f.phase === 'msg') {
    const m = f.msg!
    el.pcFeed.innerHTML = `<div class="feed-msg msg" data-tone="${m.tone}">
      <div class="msg-head">${svg(m.icon, 15)}<span>${esc(m.title)}</span></div>
      <p>${esc(m.why)}</p></div>`
    return
  }
  const shown = f.items.slice(0, ROW_BUDGET)
  const attn = shown.some(x => x.kind === 'attention' && !x.acked)
  let spent = false
  el.pcFeed.innerHTML = shown.map((it, i) => {
    const full = !spent && (attn ? it.kind === 'attention' : !it.acked)
    if (full) spent = true
    return rowHTML(it, i === 0, !it.acked && !full)
  }).join('')
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
      st === 'attention' ? '等待你批准'
        : lv === 'danger' ? '吃紧'
          : lv === 'warn' ? '偏紧'
            : st === 'running' ? '运行中'
              : '后重置'
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
  document.querySelectorAll<HTMLElement>('[data-verdict]').forEach(n => {
    const pct = Math.max(0, Math.min(100, ((t - Number(n.dataset.verdict)) / WIN5H) * 100))
    const used = Number(n.dataset.used), over = used > pct, st = n.dataset.status
    if (st === 'attention') { n.dataset.tone = 'attn'; n.textContent = '等待你批准'; return }
    n.dataset.tone = over ? 'over' : 'under'
    const verdict = over ? '按这个速度会提前用尽' : '按这个速度用不完'
    n.textContent = st === 'running' ? `运行中 · ${verdict}` : verdict
  })
}

function tickFeed(): void {
  const t = now()
  document.querySelectorAll<HTMLElement>('[data-when]').forEach(n => {
    n.textContent = whenFmt(n.dataset.when!, t)
  })
  document.querySelectorAll<HTMLElement>('[data-elapsed]').forEach(n => {
    n.textContent = elapsedFmt(t - new Date(n.dataset.elapsed!).getTime())
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
  // attention 页三点全暗，读作「当前不在轮播的三页里」
  el.dots.querySelectorAll<HTMLElement>('button').forEach(n => {
    n.dataset.on = n.dataset.p === p ? '1' : '0'
  })
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
  el.holdmark.hidden = !manualPaused(pg, Date.now())
  if (!DEBUG) return
  const left = Math.max(0, pg.dwellUntil - Date.now()) / 1000
  const leftTxt = left >= 10 ? String(Math.ceil(left)) : left.toFixed(1)
  const held = Math.max(0, pg.holdUntil - Date.now()) / 1000
  el.meter.textContent = pg.attention ? 'attention 接管 · 轮播暂停'
    : held > 0 ? `${pg.page.toUpperCase()} · 手动暂停 ${Math.ceil(held)}s`
      : !pg.auto ? '轮播关闭'
        : pg.page === 'attn' ? 'attention'
          : `${pg.page.toUpperCase()}${pg.eventHold && pg.page === 'c' ? ' · 新事件钉住' : ''} · ${leftTxt}s`
}

/* ---------- 提示音 ---------- */

let ac: AudioContext | null = null
function chime(): void {
  if (rm) return
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

/* ---------- 状态进来 ---------- */

const motionOn = (): boolean => !rm

function onState(next: MonitorState): void {
  const prevIds = knownIds
  const prevAttn = pg.attention
  state = next
  scene = toScene(next)
  root.dataset.state = next.scene

  // 画布尺寸由主进程给（目标显示器 bounds / 2）：960×540 @2x → 480×270，
  // 960×640 @1x（面板的 EDID 原生 3:2 模式）→ 480×320。zoom 仍是 2，不写死尺寸。
  root.style.setProperty('--canvas-w', `${next.canvas.width}px`)
  root.style.setProperty('--canvas-h', `${next.canvas.height}px`)

  const isFirst = firstState
  if (firstState) {
    now0 = new Date(next.generatedAt).getTime()
    boot = Date.now()
    firstState = false
  }

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

  // FLIP：新行从顶部推入，其余行跟着往下走
  const anim = motionOn() && !!fresh
  const before = new Map<string, number>()
  if (anim) {
    el.pcFeed.querySelectorAll<HTMLElement>('.row').forEach(r => {
      before.set(r.dataset.id!, r.getBoundingClientRect().top)
    })
  }

  renderPageA(); renderPageB(); renderPageC(); renderPageAttn()
  tickTiles(); tickFeed(); tickClocks()

  /* ack 走的是 IPC 往返，回来时 renderPageC 整块 innerHTML 重写，行元素必然被销毁重建，
     焦点于是掉到 <body>，键盘用户每标记一条已读就要从头 Tab（原型里有 again.focus()，
     移植时掉了）。把焦点还给同一条 data-id。 */
  if (refocusRowId) {
    const again = el.pcFeed.querySelector<HTMLElement>(`.row[data-id="${CSS.escape(refocusRowId)}"]`)
    refocusRowId = null
    again?.focus()
  }
  announceThresholds()
  if (next.loading) el.live.textContent = '正在读取三个 agent 的额度与事件'

  if (anim) {
    el.pcFeed.querySelectorAll<HTMLElement>('.row').forEach(r => {
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

el.pcFeed.addEventListener('click', e => {
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
    window.monitor.dev.setState(b.dataset.s as SceneName)
  })
  $('btnPush').addEventListener('click', () => window.monitor.dev.simulateEvent())
  $('btnAttn').addEventListener('click', () => {
    if (attnItem()) window.monitor.dev.clearAttention()
    else window.monitor.dev.simulateAttention()
  })
}

/* ---------- 主进程指令 ---------- */

window.monitor.onCommand(cmd => {
  const nowMs = Date.now()
  if (cmd.type === 'step') pg = step(pg, cmd.dir, nowMs, cfg)
  else if (cmd.type === 'home') pg = manual(pg, 'a', nowMs, cfg)
  else if (cmd.type === 'showPage') pg = pagerShowPage(pg, cmd.page, nowMs, cfg)
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
