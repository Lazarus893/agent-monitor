import { describe, expect, it } from 'vitest'
import {
  canvasFor, centeredBounds, displaySignature, pickTarget, RelocateQueue, shouldRelocate,
  TARGET_H, TARGET_W
} from '../src/main/displays.js'
import type { DisplayLike } from '../src/main/displays.js'

const d = (over: Partial<DisplayLike> & { id: number }): DisplayLike => ({
  label: '',
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  size: { width: 1920, height: 1080 },
  scaleFactor: 2,
  ...over
})

/** 本机实测的那块副屏：逻辑 960×540 @2x，坐标 (1728, −540) —— PLAN.md §1 */
const TYPE_C = d({
  id: 7,
  label: 'TYPE-C',
  bounds: { x: 1728, y: -540, width: 960, height: 540 },
  size: { width: 960, height: 540 }
})
const BUILT_IN = d({ id: 1, label: 'Built-in Retina Display', internal: true })
const MI = d({
  id: 2,
  label: 'Mi Monitor',
  bounds: { x: 1728, y: 0, width: 2560, height: 1440 },
  size: { width: 2560, height: 1440 }
})

describe('pickTarget', () => {
  it('label 含 TYPE-C 时命中，并带上命中原因与精确 bounds', () => {
    const t = pickTarget([BUILT_IN, MI, TYPE_C])
    expect(t).not.toBeNull()
    expect(t!.id).toBe(7)
    expect(t!.reason).toBe('label')
    expect(t!.bounds).toEqual({ x: 1728, y: -540, width: 960, height: 540 })
  })

  it('label 匹配不分大小写，也接受带前后缀的名字', () => {
    const usbc = d({
      id: 9,
      label: 'HDMI/type-c Portable Monitor',
      bounds: { x: 0, y: -600, width: 1280, height: 720 },
      size: { width: 1280, height: 720 }
    })
    expect(pickTarget([BUILT_IN, usbc])?.id).toBe(9)
  })

  it('没有 label 命中时退到 size 960×540', () => {
    const noName = d({
      id: 5,
      label: 'Unknown Display',
      bounds: { x: -960, y: 0, width: TARGET_W, height: TARGET_H },
      size: { width: TARGET_W, height: TARGET_H }
    })
    const t = pickTarget([BUILT_IN, MI, noName])
    expect(t!.id).toBe(5)
    expect(t!.reason).toBe('size')
  })

  it('两条规则都不命中就返回 null（调用方据此回落到主屏窗口）', () => {
    expect(pickTarget([BUILT_IN, MI])).toBeNull()
    expect(pickTarget([])).toBeNull()
  })

  it('多个候选：label 优先于尺寸', () => {
    const bySize = d({
      id: 5,
      label: 'Sidecar Display',
      bounds: { x: -960, y: 0, width: 960, height: 540 },
      size: { width: 960, height: 540 }
    })
    // 顺序刻意把尺寸候选排在前面，确认赢的是规则而不是位置
    expect(pickTarget([bySize, TYPE_C])?.id).toBe(7)
  })

  it('多个同类候选取列表里的第一个，选择是确定的', () => {
    const second = d({
      id: 8,
      label: 'TYPE-C 2',
      bounds: { x: 0, y: -540, width: 960, height: 540 },
      size: { width: 960, height: 540 }
    })
    expect(pickTarget([TYPE_C, second])?.id).toBe(7)
    expect(pickTarget([second, TYPE_C])?.id).toBe(8)
  })

  it('label 缺失（undefined）不抛错，按尺寸继续判', () => {
    const nameless: DisplayLike = {
      id: 11,
      bounds: { x: 0, y: 0, width: 960, height: 540 },
      size: { width: 960, height: 540 }
    }
    expect(pickTarget([nameless])?.reason).toBe('size')
    expect(pickTarget([nameless])?.label).toBe('display-11')
  })
})

describe('centeredBounds', () => {
  it('主屏兜底窗口默认 960×540 且居中', () => {
    expect(centeredBounds(MI)).toEqual({ x: 1728 + (2560 - 960) / 2, y: (1440 - 540) / 2, width: 960, height: 540 })
  })

  it('尺寸跟随副屏最后一次的模式：960×640 时兜底窗口也是 960×640', () => {
    expect(centeredBounds(MI, { width: 960, height: 640 }))
      .toEqual({ x: 1728 + (2560 - 960) / 2, y: (1440 - 640) / 2, width: 960, height: 640 })
  })
})

/** 面板原生是 960×640（3:2），当前 960×540 @2x 是缩放器压出来的，两种模式都要能跑 */
describe('两种面板模式', () => {
  const NATIVE = d({
    id: 7,
    label: 'TYPE-C',
    bounds: { x: 1728, y: -640, width: 960, height: 640 },
    size: { width: 960, height: 640 },
    scaleFactor: 1
  })

  it('960×640 @1x 也按 label 命中，并带回 scaleFactor', () => {
    const t = pickTarget([BUILT_IN, MI, NATIVE])!
    expect(t.bounds.height).toBe(640)
    expect(t.scaleFactor).toBe(1)
  })

  it('没有 label 时 960×640 也按尺寸命中', () => {
    const nameless = { ...NATIVE, label: 'Portable Display' }
    expect(pickTarget([BUILT_IN, MI, nameless])?.reason).toBe('size')
  })

  it('画布是 bounds 的一半：540 → 270，640 → 320', () => {
    expect(canvasFor(TYPE_C.bounds)).toEqual({ width: 480, height: 270 })
    expect(canvasFor(NATIVE.bounds)).toEqual({ width: 480, height: 320 })
  })

  it('切换面板模式（bounds + scaleFactor 同时变）要重新落位', () => {
    const before = pickTarget([TYPE_C])
    const after = pickTarget([NATIVE])
    expect(shouldRelocate(before, after, { changed: ['bounds', 'scaleFactor'], isFullScreen: true })).toBe(true)
  })
})

/**
 * 2026-09-14 实机：窗口在副屏上疯狂上下抖动。
 * 根因是进入 simpleFullScreen 会隐藏该屏菜单栏 → workArea 变化 →
 * display-metrics-changed → 回调再 toggle 一次全屏 → 无限循环。
 */
describe('shouldRelocate（抖动回归）', () => {
  const target = pickTarget([BUILT_IN, MI, TYPE_C])

  it('workArea 单独变化一律忽略 —— 这正是死循环的那一环', () => {
    expect(shouldRelocate(target, target, { changed: ['workArea'], isFullScreen: true })).toBe(false)
    expect(shouldRelocate(target, target, { changed: ['workArea'], isFullScreen: false })).toBe(false)
  })

  it('同一个目标且已经全屏，不再 toggle', () => {
    expect(shouldRelocate(target, target, { isFullScreen: true })).toBe(false)
    expect(shouldRelocate(target, target, { changed: ['bounds'], isFullScreen: true })).toBe(false)
  })

  it('同一个目标但窗口不在全屏（首次落位 / 被人退出过），要落位', () => {
    expect(shouldRelocate(target, target, { isFullScreen: false })).toBe(true)
  })

  it('副屏被拔掉：要回落到主屏窗口', () => {
    expect(shouldRelocate(target, null, { isFullScreen: true })).toBe(true)
  })

  it('副屏插回来：要迁回全屏', () => {
    expect(shouldRelocate(null, target, { isFullScreen: false })).toBe(true)
  })

  it('没有副屏且窗口已是普通窗口，什么都不做', () => {
    expect(shouldRelocate(null, null, { isFullScreen: false })).toBe(false)
  })

  it('目标屏自己挪了位置（bounds 变化）要跟过去', () => {
    const moved = pickTarget([BUILT_IN, MI, { ...TYPE_C, bounds: { ...TYPE_C.bounds, y: 1117 } }])
    expect(shouldRelocate(target, moved, { changed: ['bounds'], isFullScreen: true })).toBe(true)
  })

  it('bounds 与 workArea 同时到达时按 bounds 处理，不被 workArea 吃掉', () => {
    const moved = pickTarget([BUILT_IN, MI, { ...TYPE_C, bounds: { ...TYPE_C.bounds, y: 1117 } }])
    expect(shouldRelocate(target, moved, { changed: ['workArea', 'bounds'], isFullScreen: true })).toBe(true)
  })

  it('changed 为空数组＝没有我们关心的 metric，按忽略处理（与 undefined 语义相反，钉住它）', () => {
    expect(shouldRelocate(target, null, { changed: [], isFullScreen: true })).toBe(false)
    expect(shouldRelocate(target, null, { isFullScreen: true })).toBe(true)
  })

  it('没有副屏但窗口还在全屏：要退出全屏', () => {
    expect(shouldRelocate(null, null, { isFullScreen: true })).toBe(true)
  })

  it('目标真的变了但只报了 workArea —— 当前有意忽略，这是第一道闸门的取舍', () => {
    // 放宽闸门会让抖动回来；真变化总会伴随 bounds 事件或被 500ms 轮询兜住
    expect(shouldRelocate(target, null, { changed: ['workArea'], isFullScreen: true })).toBe(false)
  })
})

/**
 * settle 窗口内到达的变化必须只延后、不丢弃 —— 原来的写法会永久吞掉
 * 「重定位后 600ms 内拔掉副屏」这一下，直接威胁验收 2。
 */
describe('RelocateQueue', () => {
  it('block 期间 push 的变化留在队列里，unblock 之后还在', () => {
    const q = new RelocateQueue()
    q.block()
    q.push(['bounds'])
    expect(q.blocked).toBe(true)
    expect(q.pending).toBe(true)
    q.unblock()
    expect(q.pending).toBe(true)
    expect(q.take()).toEqual(['bounds'])
    expect(q.pending).toBe(false)
  })

  it('take 清空队列，重复 take 不会重放旧变化', () => {
    const q = new RelocateQueue()
    q.push(['bounds'])
    expect(q.take()).toEqual(['bounds'])
    expect(q.take()).toEqual([])
    expect(q.pending).toBe(false)
  })

  it('无条件变化（插拔 / 轮询）盖过 metrics 过滤', () => {
    const q = new RelocateQueue()
    q.push(['workArea'])
    q.push()                 // display-removed
    expect(q.take()).toBeUndefined()
  })

  it('一个 debounce 窗口里的多次 metrics 合并成一批', () => {
    const q = new RelocateQueue()
    q.push(['workArea'])
    q.push(['bounds'])
    q.push(['bounds'])
    expect(q.take()!.slice().sort()).toEqual(['bounds', 'workArea'])
  })

  it('没有变化时 pending 为假 —— settle 结束不会白跑一轮', () => {
    expect(new RelocateQueue().pending).toBe(false)
  })
})

describe('displaySignature', () => {
  it('拔掉副屏后指纹变化 —— 热插拔轮询靠它判断要不要重排', () => {
    const withPanel = displaySignature([BUILT_IN, MI, TYPE_C])
    const without = displaySignature([BUILT_IN, MI])
    expect(withPanel).not.toBe(without)
    expect(displaySignature([BUILT_IN, MI])).toBe(without)
  })

  it('不含 workArea —— 全屏后 workArea 必变，含了轮询就成了第二个抖动源', () => {
    const withWorkArea = { ...TYPE_C, workArea: { x: 1728, y: 1142, width: 960, height: 515 } }
    expect(displaySignature([withWorkArea as typeof TYPE_C])).toBe(displaySignature([TYPE_C]))
  })

  it('scaleFactor / rotation 变化算变化', () => {
    expect(displaySignature([{ ...TYPE_C, scaleFactor: 1 }])).not.toBe(displaySignature([TYPE_C]))
    expect(displaySignature([{ ...TYPE_C, rotation: 90 }])).not.toBe(displaySignature([TYPE_C]))
  })

  it('同一组显示器只是移动了位置也算变化', () => {
    const moved = { ...TYPE_C, bounds: { ...TYPE_C.bounds, y: -1080 } }
    expect(displaySignature([TYPE_C])).not.toBe(displaySignature([moved]))
  })
})
