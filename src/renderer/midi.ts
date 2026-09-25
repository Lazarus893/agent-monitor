/**
 * Midi 的状态机与派生量 —— 纯函数，不碰 DOM、不读时钟、不读随机数。
 * 规则来自 design/brief-midi.md §4，手感（帧的优先级、心流灯的系数）来自 design/midi-prototype.html。
 *
 * 时间一律作参数传进来：F 页的「现在」是 app.ts 的 now()（原点是主进程给的 generatedAt），
 * 不是 Date.now()。截图对账要求同一份输入必然画出同一帧，这里就不能自己去读钟。
 */

import type { TypingStatus } from '../shared/types.js'
import type { CatPose, FrameName } from './midi-sprites.js'

/** 打字：最后一个字之后这么久内都算「在打」，每个脉冲切一次爪 */
const TYPE_MS = 600
/** 抬头看你：停这么久之后猫从 idle 换成 look */
const LOOK_MS = 4_000
/** 趴下睡：停这么久之后猫睡着（简报 §4 的 5 分钟） */
const SLEEP_MS = 5 * 60_000
/** 心流灯：停这么久之后开始衰减 */
const FLOW_HOLD_MS = 2_000

export const MIDI_TIMING = { TYPE_MS, LOOK_MS, SLEEP_MS, FLOW_HOLD_MS } as const

export type FrameInput = {
  now: number
  /** 最近一次脉冲的时刻（与 now 同一把钟）。这一程还没收到过就是 0。 */
  lastInputAt: number
  /** 左右爪交替的那一位，每个脉冲翻一次 */
  paw: number
  night: boolean
  /** 眨眼窗口的到期时刻，随机数在调用方（这里要保持纯） */
  blinkUntil: number
  status: TypingStatus
}

/**
 * 该画哪一帧。
 *
 * 诚实态优先于活动态（简报 §4）：没权限 / 没连上时猫是趴着的，不能因为「刚好 600 ms 内
 * 有过一次脉冲」而让它假装在打字 —— 那一刻我们根本收不到脉冲。
 * connecting 画 idle：子进程在起，猫在醒，不是睡着也不是在打。
 *
 * 活动态的顺序照搬原型：打字 > 睡 > 眨眼 > 夜间 > 抬头 > idle。
 * 眨眼排在夜间之前是故意的 —— 夜间帧的眼睛已经是一条缝，再眨一次看不出来，
 * 但它是个 110 ms 的瞬时窗口，让它压住夜间帧比反过来省一个分支。
 */
export function frameFor(i: FrameInput): FrameName {
  if (i.status === 'untrusted' || i.status === 'offline') return 'sleep'
  if (i.status === 'connecting') return 'idle'
  // 这一程还没收到过脉冲：猫在等你，不是睡着了（idle - 0 会算出一个巨大的停顿）
  if (!i.lastInputAt) {
    if (i.now < i.blinkUntil) return 'blink'
    return i.night ? 'night' : 'idle'
  }
  const idle = i.now - i.lastInputAt
  if (idle < TYPE_MS) return i.paw ? 'typeL' : 'typeR'
  if (idle >= SLEEP_MS) return 'sleep'
  if (i.now < i.blinkUntil) return 'blink'
  if (i.night) return 'night'
  if (idle > LOOK_MS) return 'look'
  return 'idle'
}

export type FlowInput = {
  now: number
  lastInputAt: number
  /** 距上一次 flowStep 的秒数 */
  dt: number
  /** 这一帧新到的字数；只有脉冲那一刻非 0 */
  delta?: number
}

/**
 * 心流灯 —— 每个字 +0.03，停 2 s 后每秒 −0.03，上限 1，底 0.06 不灭到零。
 * 「不灭到零」是简报里的一条手感：灯灭掉等于在说「你今天不行」，而它不评价。
 * 这一程一个字都没收到过时才真的是 0（那时屏上本来就没有「此刻」可言）。
 */
export function flowStep(flow: number, i: FlowInput): number {
  if (!i.lastInputAt) return 0
  const gained = Math.min(1, flow + 0.03 * (i.delta ?? 0))
  if (i.now - i.lastInputAt <= FLOW_HOLD_MS) return gained
  /* 衰减这一支也钳上限。dt 理论上非负，但它是两次 now() 相减，而 now() 的原点
     会在主进程换一份 generatedAt 时整段挪（调试栏切场景、fixtures 回程）——
     那一帧的 dt 是负的，`- 0.03 × 负数` 是在**加**亮度。
     不钳的话灯会冲过 1，而下游两处都按 [0,1] 写：光锥透明度 0.04 + flow×0.22
     （越界就不再是「越亮」而是被 canvas 截断），影子 round(flow×3) 格会画到第四格。 */
  return Math.min(1, Math.max(0.06, gained - 0.03 * i.dt))
}

export type StateInput = {
  now: number
  lastInputAt: number
  night: boolean
  status: TypingStatus
  /** 当班那只猫的名字（Midi / 咖啡）。 */
  name: string
}

/**
 * 右栏那一行文案。
 * 前三句是简报 §4 的诚实态，一字不差；后面几句是活动态，取自原型的 stateText()。
 * 一句都不带评价：它只说猫在干什么，不说你在干什么。
 */
export function stateText(i: StateInput): string {
  if (i.status === 'connecting') return `${i.name} 正在醒来`
  if (i.status === 'untrusted') return '系统设置 › 隐私与安全性 › 辅助功能 里勾上 Agent Monitor'
  if (i.status === 'offline') return `还没连上 ${i.name} 的耳朵`
  if (!i.lastInputAt) return `${i.name} 在等你`
  const idle = i.now - i.lastInputAt
  if (idle < TYPE_MS) return `${i.name} 在打字`
  if (idle >= SLEEP_MS) return `${i.name} 睡着了`
  if (idle > LOOK_MS) return i.night ? `${i.name} 眯着眼看你` : `${i.name} 在看你`
  return i.night ? `${i.name} 困了` : `${i.name} 在歇爪`
}

/* ==========================================================================
   换班 —— 两只猫在键盘后面走位。没有走路帧，用左右爪交替帧 + 2px 起伏在网格上平移。
   时间轴（ms）：
     0–360        当班的猫抬头看一眼（look）
     360–1320     它向右走出画面：160px，每 120ms 换一次爪、起伏一次
     1200–2160    接班的猫从左边走进来（比前一段早 120ms 起步，两只不重叠）
     2160–2460    坐定，动一下耳朵
   位移一律落 4px 网格；reduced-motion 下不调用这里，直接换。
   ========================================================================== */
export const HANDOVER = {
  LOOK_MS: 360, WALK_MS: 960, OVERLAP_MS: 120, SETTLE_MS: 300, STEP_MS: 120,
  HOME_X: 80, EXIT_PX: 160, ENTER_X: -96, SCENE_W: 224, GRID: 4
} as const
export const HANDOVER_MS = HANDOVER.LOOK_MS + HANDOVER.WALK_MS - HANDOVER.OVERLAP_MS + HANDOVER.WALK_MS + HANDOVER.SETTLE_MS

export type Walker = { pose: CatPose; x: number; bob: number }
export type HandoverFrame = { out: Walker | null; in: Walker | null; done: boolean }

const snap = (v: number): number => Math.round(v / HANDOVER.GRID) * HANDOVER.GRID
const stepping = (q: number, from: number, dist: number): Walker => {
  const step = Math.floor(q / HANDOVER.STEP_MS)
  return { pose: step % 2 ? 'typeL' : 'typeR', x: from + snap(dist * q / HANDOVER.WALK_MS), bob: step % 2 ? -2 : 0 }
}

/** elapsed = 距换班开始的毫秒。返回两只猫此刻各自的姿态与位置；出画面的那只为 null。 */
export function handoverFrame(elapsed: number): HandoverFrame {
  const { LOOK_MS, WALK_MS, OVERLAP_MS, HOME_X, EXIT_PX, ENTER_X, SCENE_W } = HANDOVER
  if (elapsed >= HANDOVER_MS) return { out: null, in: { pose: 'idle', x: HOME_X, bob: 0 }, done: true }
  let out: Walker | null = null
  if (elapsed < LOOK_MS) out = { pose: 'look', x: HOME_X, bob: 0 }
  else if (elapsed < LOOK_MS + WALK_MS) {
    out = stepping(elapsed - LOOK_MS, HOME_X, EXIT_PX)
    if (out.x >= SCENE_W) out = null
  }
  let inn: Walker | null = null
  const q = elapsed - (LOOK_MS + WALK_MS - OVERLAP_MS)
  if (q >= WALK_MS) inn = { pose: 'ear', x: HOME_X, bob: 0 }
  else if (q >= 0) inn = stepping(q, ENTER_X, HOME_X - ENTER_X)
  return { out, in: inn, done: false }
}

/** 夜间：22:00–05:00。只看本机小时，连日记层都不用（简报 §4「夜猫子」）。 */
export const isNight = (hour: number): boolean => hour >= 22 || hour < 5

/**
 * 里程碑：今日字数每跨过一个 500 的倍数跳一下。
 * 用「跨过倍数」而不是「攒够 500」：账本的 today 会被主进程的慢数据整段覆盖
 * （跨日、重启、对账），攒计数器会在那一刻错位，而倍数是个绝对刻度，覆盖多少次都对得上。
 */
export const milestoneHop = (prevToday: number, today: number): boolean =>
  Math.floor(today / 500) > Math.floor(prevToday / 500)
