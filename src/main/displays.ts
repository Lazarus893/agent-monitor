/**
 * 选屏：纯函数，不 import electron，便于 vitest 直接喂假的 Display。
 * 规则（docs/m1-brief.md）：优先 label 含 "TYPE-C"，其次尺寸命中，否则 null。
 *
 * 尺寸有两种，因为这块面板的原生像素是 960×640（3:2）：
 *   · 960×540 @2x —— 当前模式，面板的缩放器把画面横向压了 15.6%
 *   · 960×640 @1x —— EDID 原生模式，用户随时可能切过去
 * 两种都要认，而且画布尺寸不能写死：它由 bounds / 2 算出来（480×270 或 480×320），
 * 经 MonitorState 推给渲染层，CSS 用 --canvas-w / --canvas-h。
 */

export type DisplayBounds = { x: number; y: number; width: number; height: number }

/** Electron Display 的最小子集 —— 只用到这几个字段，测试里不必造整个对象 */
export type DisplayLike = {
  id: number
  label?: string
  bounds: DisplayBounds
  size: { width: number; height: number }
  scaleFactor?: number
  rotation?: number
  internal?: boolean
}

export type Size = { width: number; height: number }

export type Target = {
  id: number
  label: string
  bounds: DisplayBounds
  scaleFactor: number
  /** 命中原因，主进程日志要打出来，插拔排障时看得见是按哪条规则选的 */
  reason: 'label' | 'size'
}

export const TARGET_LABEL = 'TYPE-C'
/** 两种可接受的逻辑尺寸；第一条同时是找不到副屏时兜底窗口的默认尺寸 */
export const TARGET_SIZES: readonly Size[] = [
  { width: 960, height: 540 },  // 缩放器压过的当前模式 @2x
  { width: 960, height: 640 }   // EDID 原生 3:2 模式 @1x
]
export const TARGET_W = TARGET_SIZES[0]!.width
export const TARGET_H = TARGET_SIZES[0]!.height

/** 画布是逻辑尺寸的一半 —— 渲染层整体 zoom: 2 再铺回去（tokens.css §12） */
export const CANVAS_ZOOM = 2
export const canvasFor = (bounds: DisplayBounds): Size => ({
  width: Math.round(bounds.width / CANVAS_ZOOM),
  height: Math.round(bounds.height / CANVAS_ZOOM)
})

const hasLabel = (d: DisplayLike): boolean =>
  typeof d.label === 'string' && d.label.toUpperCase().includes(TARGET_LABEL)

const hasSize = (d: DisplayLike): boolean =>
  TARGET_SIZES.some(s => d.size.width === s.width && d.size.height === s.height)

/**
 * 多个候选时取列表里的第一个：screen.getAllDisplays() 的顺序在同一次插拔内是稳定的，
 * 再引入「离主屏最近」之类的二次规则只会让插拔行为更难预测。
 */
export function pickTarget(displays: readonly DisplayLike[]): Target | null {
  const byLabel = displays.find(hasLabel)
  if (byLabel) return toTarget(byLabel, 'label')
  const bySize = displays.find(hasSize)
  if (bySize) return toTarget(bySize, 'size')
  return null
}

function toTarget(d: DisplayLike, reason: Target['reason']): Target {
  return {
    id: d.id,
    label: d.label ?? `display-${d.id}`,
    bounds: { ...d.bounds },
    scaleFactor: d.scaleFactor ?? 1,
    reason
  }
}

/**
 * 没有副屏时的兜底：主屏居中的窗口。
 * 尺寸跟随目标模式 —— 副屏最后一次是 960×640 就开 960×640 的窗口，
 * 否则画布会在插回去的一瞬间换一次尺寸。没有历史就用默认的 960×540。
 */
export function centeredBounds(primary: DisplayLike, size: Size = TARGET_SIZES[0]!): DisplayBounds {
  const { x, y, width, height } = primary.bounds
  return {
    x: Math.round(x + (width - size.width) / 2),
    y: Math.round(y + (height - size.height) / 2),
    width: size.width,
    height: size.height
  }
}

export function targetsEqual(a: Target | null, b: Target | null): boolean {
  if (!a || !b) return a === b
  return (
    a.id === b.id &&
    a.bounds.x === b.bounds.x &&
    a.bounds.y === b.bounds.y &&
    a.bounds.width === b.bounds.width &&
    a.bounds.height === b.bounds.height
  )
}

/**
 * 要不要重新落位。抽成纯函数是因为这里出过一个真实的死循环：
 * 进入 simpleFullScreen 会隐藏该屏菜单栏 → workArea 变化 → display-metrics-changed
 * → 回调又「退出全屏 → setBounds → 进全屏」→ 再次触发。窗口就在副屏上疯狂抖动。
 * 两道闸门：
 *   1. display-metrics-changed 只认 bounds / scaleFactor，workArea 单独变化一律忽略；
 *   2. 目标没变且窗口的全屏状态已经对了，就什么都不做 —— 不再 toggle 全屏。
 * changed 为 undefined 表示 display-added / display-removed 或轮询发现的变化，不过第一道闸门。
 */
export function shouldRelocate(
  prev: Target | null,
  next: Target | null,
  opts: { changed?: readonly string[]; isFullScreen: boolean }
): boolean {
  if (opts.changed && !opts.changed.some(m => m === 'bounds' || m === 'scaleFactor')) return false
  if (!targetsEqual(prev, next)) return true
  // 目标没变：只有窗口当前的全屏状态与目标不相符时才需要动它
  return next ? !opts.isFullScreen : opts.isFullScreen
}

/**
 * 显示器变化的排队。
 * 抽出来是因为原来的写法会**永久丢事件**：重定位后有 600 ms 的 settle 窗口，
 * 这期间到达的变化被直接扔掉，而轮询那边指纹已经先被消费掉了，于是「settle 期间拔掉副屏」
 * 这一下再也不会被处理 —— 直接威胁验收 2。改成只延后不丢弃，settle 结束后补跑一次。
 */
export class RelocateQueue {
  private metrics = new Set<string>()
  private unconditional = false
  private armed = false
  private blockedFlag = false

  /** 记下一次变化。changed 为空表示插拔或轮询发现的变化，不经 changedMetrics 过滤。 */
  push(changed?: readonly string[]): void {
    if (changed) for (const m of changed) this.metrics.add(m)
    else this.unconditional = true
    this.armed = true
  }

  /** 还有没有攒着没跑的变化 */
  get pending(): boolean {
    return this.armed
  }

  get blocked(): boolean {
    return this.blockedFlag
  }

  block(): void {
    this.blockedFlag = true
  }

  unblock(): void {
    this.blockedFlag = false
  }

  /** 取出这一轮要处理的 changedMetrics 并清空队列；undefined = 不过滤 */
  take(): readonly string[] | undefined {
    const out = this.unconditional ? undefined : [...this.metrics]
    this.metrics.clear()
    this.unconditional = false
    this.armed = false
    return out
  }
}

/** 显示器集合的指纹：热插拔轮询用它判断「有没有变」，避免每秒重排窗口。
 *  刻意只看 id / label / bounds，不看 workArea —— 全屏会改 workArea，看了就又是一个抖动源。 */
export function displaySignature(displays: readonly DisplayLike[]): string {
  return displays
    .map(d =>
      `${d.id}:${d.bounds.x},${d.bounds.y},${d.bounds.width}x${d.bounds.height}` +
      `:${d.scaleFactor ?? 1}:${d.rotation ?? 0}`)
    .join('|')
}
