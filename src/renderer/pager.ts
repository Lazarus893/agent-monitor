/**
 * 轮播状态机 —— 纯函数，不碰 DOM、不读 CSS、不读时钟。
 * 规则来自 design/brief-m0-rotation.md「节奏」「打断规则」「手动切换」三节。
 *
 * 打断优先级（高 → 低）：attention > 新事件 > 打字 > 定时轮播；
 * 手动暂停压定时轮播与打字（你翻到 B 页盯额度的时候，正在敲的字不该把它抢走），压不住新事件。
 */

import type { Page } from '../shared/types.js'

export type PagerConfig = {
  dwellA: number
  dwellB: number
  dwellC: number
  /** 新事件跳 C1 后停满的一个 dwell */
  dwellEvent: number
  /** 手动切页后的轮播暂停 */
  manualHold: number
  /** 打字把 F 页推到眼前之后，最后一个键之后再停多久才恢复轮播 */
  dwellTyping: number
}

/** 默认值与 design/tokens.css §14 一致；渲染层启动时会用实际 token 值覆盖 */
export const DEFAULT_CONFIG: PagerConfig = {
  dwellA: 60_000,
  dwellB: 60_000,
  dwellC: 60_000,
  dwellEvent: 60_000,
  manualHold: 120_000,
  dwellTyping: 30_000
}

/**
 * 页序：A → B → C1 → C2 → D → E → F（design/brief-m0-v2.md「轮播」+ brief-midi.md §4）。
 * C2 为空时整页跳过 —— 它是 C1 的溢出页，没有第 5 个 session 时它是一页空白。
 * 所以「当前在轮播里的页」是一个**随数据变化**的列表，不是常量：
 * 指示点的个数、→ 的下一页、自动推进的下一页，三处都要读同一份列表。
 *
 * F（Midi）排在最后而不是插在中间：前六页回答「机器怎么样」，F 回答「你怎么样」，
 * 一轮的结尾比中间更适合放它 —— 也让 D/E 这两页数据页仍然挨着。
 */
export const ORDER_ALL: Page[] = ['a', 'b', 'c1', 'c2', 'd', 'e', 'f']

/** 轮播中的页。`hasC2` 由渲染层按「排序后第 5 条 session 存不存在」给。 */
export const orderFor = (hasC2: boolean): Page[] =>
  hasC2 ? ORDER_ALL : ORDER_ALL.filter(p => p !== 'c2')

/** attn 不在轮播列表里，indexOf 会返回 −1；从它出发的下一页应当是 A，而不是被兜成 0 后的 B */
const nextFrom = (page: Page, dir: 1 | -1, order: Page[]): Page => {
  const i = order.indexOf(page)
  if (i < 0) return 'a'
  return order[(i + dir + order.length) % order.length]!
}

export type PagerState = {
  page: Page
  /** 当前轮播列表（C2 空时少一页）。由渲染层每帧用 setOrder 同步进来。 */
  order: Page[]
  /** 自动轮播开关（调试视图的控制栏可以关） */
  auto: boolean
  /** attention 接管中：整屏被 attn 页占住，轮播与手动全部停摆 */
  attention: boolean
  /** 当前页的到期时刻 */
  dwellUntil: number
  /** 手动切页后的暂停到期时刻，0 = 没有暂停 */
  holdUntil: number
  /** 新事件把 C 页钉住：这一停是 dwellEvent 而不是 dwellC */
  eventHold: boolean
}

export function create(now: number, init?: Partial<Pick<PagerState, 'page' | 'auto'>>,
                       cfg: PagerConfig = DEFAULT_CONFIG): PagerState {
  const page = init?.page ?? 'a'
  const s: PagerState = {
    page,
    order: orderFor(false),
    auto: init?.auto ?? true,
    attention: false,
    dwellUntil: 0,
    holdUntil: 0,
    eventHold: false
  }
  return { ...s, dwellUntil: now + dwellFor(s, page, cfg) }
}

/**
 * 同步轮播列表。
 * 只有当前页正好是被移出列表的那一页（C2 刚变空）时才需要动页码 —— 那时回 C1，
 * 否则用户会停在一页不再存在的空白上直到下一次 dwell 到期。
 */
export function setOrder(s: PagerState, order: Page[], now: number,
                         cfg: PagerConfig = DEFAULT_CONFIG): PagerState {
  if (s.order.length === order.length && s.order.every((p, i) => p === order[i])) return s
  const next: PagerState = { ...s, order }
  if (s.page === 'attn' || order.includes(s.page)) return next
  return { ...next, page: 'c1', dwellUntil: now + dwellFor(next, 'c1', cfg) }
}

/**
 * 新事件钉住的是 C1（v2 把 C 拆成 C1/C2 之后，认旧的 'c' 会让「停 60 s」整条规则失效）。
 * C1/C2/D/E/F 共用 dwellC —— tokens 里三个 dwell 本来就都是 60 s，
 * 为 F 再加一个同值的配置项只会多一处要一起改的地方。
 */
export function dwellFor(s: PagerState, page: Page, cfg: PagerConfig = DEFAULT_CONFIG): number {
  if (page === 'c1' && s.eventHold) return cfg.dwellEvent
  if (page === 'a') return cfg.dwellA
  if (page === 'b') return cfg.dwellB
  return cfg.dwellC
}

/** 手动暂停是否仍在生效 —— 指示点左侧那个「‖」靠它显示 */
export function manualPaused(s: PagerState, now: number): boolean {
  return s.holdUntil > now
}

/** 定时推进。冻结条件：attention / 轮播关闭 / 手动暂停中 / 当前页没停够 */
export function tick(s: PagerState, now: number, cfg: PagerConfig = DEFAULT_CONFIG): PagerState {
  if (s.attention) return s
  if (!s.auto) return s
  if (now < s.holdUntil) return s
  if (now < s.dwellUntil) return s

  const next = nextFrom(s.page, 1, s.order)
  // C1 页那一停走完，钉住随之解除
  const cleared: PagerState = { ...s, eventHold: false, holdUntil: 0 }
  return { ...cleared, page: next, dwellUntil: now + dwellFor(cleared, next, cfg) }
}

/**
 * 打断 2 · 新事件：立刻跳 C 并停满 dwellEvent，再来一条重新计时。
 * 新事件盖过手动暂停（简报：手动暂停期间来了新事件仍跳 C 并重新计时），
 * 但盖不过 attention —— attention 接管期间事件只进 feed，不抢屏。
 */
export function interruptEvent(s: PagerState, now: number, cfg: PagerConfig = DEFAULT_CONFIG): PagerState {
  if (s.attention) return s
  const held: PagerState = { ...s, eventHold: true, holdUntil: 0 }
  return { ...held, page: 'c1', dwellUntil: now + dwellFor(held, 'c1', cfg) }
}

/**
 * 打断 3 · 打字：把 F 页推到眼前，最后一个键之后停满 dwellTyping 再恢复轮播。
 * 已经在 F 页就只往后推到期时刻（每个键都推，猫在动的时候页不会翻走）。
 * 让位给一切比它重要的：attention、新事件钉住的 C1、用户的手动暂停 —— 这三种情况原样返回。
 * 调用方负责「连敲几下才算打字」的判定，这里只管状态。
 */
export function interruptTyping(s: PagerState, now: number, cfg: PagerConfig = DEFAULT_CONFIG): PagerState {
  if (s.attention) return s
  if (now < s.holdUntil) return s
  if (s.eventHold && s.page === 'c1') return s
  const until = now + cfg.dwellTyping
  if (s.page === 'f') return until > s.dwellUntil ? { ...s, dwellUntil: until } : s
  return { ...s, page: 'f', dwellUntil: until }
}

/** 打断 1 · attention：专用整屏页接管，轮播暂停直到解除 */
export function interruptAttention(s: PagerState, _now: number): PagerState {
  return { ...s, attention: true, page: 'attn', eventHold: false, holdUntil: 0, dwellUntil: 0 }
}

/** 解除 attention（ack）：回 A 页并恢复轮播 —— 简报「打断结束后从 A 页恢复」 */
export function ack(s: PagerState, now: number, cfg: PagerConfig = DEFAULT_CONFIG): PagerState {
  if (!s.attention) return s
  const cleared: PagerState = { ...s, attention: false, eventHold: false, holdUntil: 0 }
  return { ...cleared, page: 'a', dwellUntil: now + dwellFor(cleared, 'a', cfg) }
}

/**
 * 手动切页：暂停自动轮播 manualHold。
 * attention 接管页不能被手动切走（它需要被处理），所以 attention 下原样返回。
 */
export function manual(s: PagerState, page: Page, now: number,
                       cfg: PagerConfig = DEFAULT_CONFIG): PagerState {
  if (s.attention) return s
  const cleared: PagerState = { ...s, eventHold: false }
  return {
    ...cleared,
    page,
    holdUntil: now + cfg.manualHold,
    dwellUntil: now + dwellFor(cleared, page, cfg)
  }
}

/** ← / → / ⌃⌥← / ⌃⌥→ */
export function step(s: PagerState, dir: -1 | 1, now: number,
                     cfg: PagerConfig = DEFAULT_CONFIG): PagerState {
  if (s.attention) return s
  return manual(s, nextFrom(s.page, dir, s.order), now, cfg)
}

/** 轮播开关。重新打开时从当前页重新计时，而不是立刻翻页。 */
export function setAuto(s: PagerState, auto: boolean, now: number,
                        cfg: PagerConfig = DEFAULT_CONFIG): PagerState {
  if (s.auto === auto) return s
  const next = { ...s, auto }
  return auto ? { ...next, dwellUntil: now + dwellFor(next, next.page, cfg) } : next
}

/**
 * 截图脚本用：直接定页，不触发手动暂停。
 * 顺手清掉 eventHold —— 否则定到 C1 页会按 dwellEvent 而不是 dwellC 计时，
 * 截图之后状态机的节奏就和真实运行对不上了。
 */
export function showPage(s: PagerState, page: Page, now: number,
                         cfg: PagerConfig = DEFAULT_CONFIG): PagerState {
  const cleared: PagerState = { ...s, eventHold: false }
  return { ...cleared, page, dwellUntil: now + dwellFor(cleared, page, cfg) }
}
