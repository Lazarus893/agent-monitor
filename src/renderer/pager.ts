/**
 * 轮播状态机 —— 纯函数，不碰 DOM、不读 CSS、不读时钟。
 * 规则来自 design/brief-m0-rotation.md「节奏」「打断规则」「手动切换」三节。
 *
 * 打断优先级（高 → 低）：attention > 新事件 > 定时轮播；手动暂停只压定时轮播。
 */

import type { Page } from '../shared/types.js'

export type PagerConfig = {
  dwellA: number
  dwellB: number
  dwellC: number
  /** 新事件跳 C 后停满的一个 dwell */
  dwellEvent: number
  /** 手动切页后的轮播暂停 */
  manualHold: number
}

/** 默认值与 design/tokens.css §14 一致；渲染层启动时会用实际 token 值覆盖 */
export const DEFAULT_CONFIG: PagerConfig = {
  dwellA: 60_000,
  dwellB: 60_000,
  dwellC: 60_000,
  dwellEvent: 60_000,
  manualHold: 120_000
}

export const ORDER: Page[] = ['a', 'b', 'c']

/** attn 不在 ORDER 里，indexOf 会返回 −1；从它出发的下一页应当是 A，而不是被兜成 0 后的 B */
const nextFrom = (page: Page, dir: 1 | -1): Page => {
  const i = ORDER.indexOf(page)
  if (i < 0) return 'a'
  return ORDER[(i + dir + ORDER.length) % ORDER.length]!
}

export type PagerState = {
  page: Page
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
    auto: init?.auto ?? true,
    attention: false,
    dwellUntil: 0,
    holdUntil: 0,
    eventHold: false
  }
  return { ...s, dwellUntil: now + dwellFor(s, page, cfg) }
}

export function dwellFor(s: PagerState, page: Page, cfg: PagerConfig = DEFAULT_CONFIG): number {
  if (page === 'c' && s.eventHold) return cfg.dwellEvent
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

  const next = nextFrom(s.page, 1)
  // C 页那一停走完，钉住随之解除
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
  return { ...held, page: 'c', dwellUntil: now + dwellFor(held, 'c', cfg) }
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
  return manual(s, nextFrom(s.page, dir), now, cfg)
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
 * 顺手清掉 eventHold —— 否则定到 C 页会按 dwellEvent 而不是 dwellC 计时，
 * 截图之后状态机的节奏就和真实运行对不上了。
 */
export function showPage(s: PagerState, page: Page, now: number,
                         cfg: PagerConfig = DEFAULT_CONFIG): PagerState {
  const cleared: PagerState = { ...s, eventHold: false }
  return { ...cleared, page, dwellUntil: now + dwellFor(cleared, page, cfg) }
}
