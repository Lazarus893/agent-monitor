/**
 * 副屏窗口：frameless、bounds 精确等于目标显示器、simpleFullScreen。
 *
 * 用 setSimpleFullScreen 而不是 setFullScreen —— 后者会让 macOS 新建一个 Space，
 * 副屏就被抢成一块全屏工作区，切 Space 时面板会消失（PLAN.md §4）。
 * 渲染层自己带 zoom: 2（画布 480×270 → 960×540），主进程不再设 zoomFactor，避免双重缩放。
 *
 * 抖动根因（2026-09-14 实机）：进入 simpleFullScreen 会隐藏该屏菜单栏 → workArea 变化
 * → display-metrics-changed → 回调再「退出全屏 → setBounds → 进全屏」→ 无限循环。
 * 三道闸门挡住它：changedMetrics 过滤（见 displays.shouldRelocate）、300ms debounce、
 * 以及重定位期间的 relocating 标志。
 */

import { BrowserWindow, screen, shell } from 'electron'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import {
  canvasFor, centeredBounds, displaySignature, pickTarget, RelocateQueue, shouldRelocate,
  TARGET_H, TARGET_W
} from './displays.js'
import type { DisplayLike, Size, Target } from './displays.js'

const here = dirname(fileURLToPath(import.meta.url))

const CANVAS_BG = '#07080a' // --canvas

/** 事件合并窗口：一次插拔会连发好几个 screen 事件，只该落位一次 */
const DEBOUNCE_MS = 300
/** 重定位期间丢弃事件的时长 —— 要盖住我们自己 toggle 全屏引发的那几个回调 */
const SETTLE_MS = 600
/** 热插拔兜底轮询：screen 事件已经够快，这条只是保证「2s 内」是有下界的承诺 */
const POLL_MS = 500

export type WindowDeps = {
  /** dev 下是 vite 的 URL，打包后是本地文件 */
  rendererUrl?: string
  debug: boolean
  /** 每次落位后回报画布尺寸（bounds / 2）。960×540 @2x → 480×270；960×640 @1x → 480×320 */
  onCanvas?: (canvas: Size) => void
}

export class MonitorWindow {
  readonly win: BrowserWindow
  private signature = ''
  private timer: NodeJS.Timeout | null = null
  private debounce: NodeJS.Timeout | null = null
  private settleTimer: NodeJS.Timeout | null = null
  private relocating = false
  /** 变化队列：settle 期间到达的只延后，不丢弃 */
  private queue = new RelocateQueue()
  private current: Target | null = null
  /** 副屏最后一次是什么尺寸 —— 回落窗口跟着它，插回去时画布才不会闪一下 */
  private lastSize: Size = { width: TARGET_W, height: TARGET_H }

  constructor(private deps: WindowDeps) {
    this.win = new BrowserWindow({
      width: TARGET_W,
      height: TARGET_H,
      frame: false,
      show: false,
      resizable: false,
      fullscreenable: true,
      backgroundColor: CANVAS_BG,
      title: 'Agent Monitor',
      webPreferences: {
        // package.json 是 "type": "module"，electron-vite 把 preload 产成 .mjs；
        // ESM preload 要求 sandbox: false，contextIsolation 仍然是 true。
        preload: join(here, '../preload/index.mjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      }
    })

    // 面板上不该有任何能跳出去的东西；真出现外链就交给系统浏览器，别在副屏里导航
    this.win.webContents.setWindowOpenHandler(({ url }) => {
      void shell.openExternal(url)
      return { action: 'deny' }
    })

    this.win.once('ready-to-show', () => {
      this.relocate()
      this.win.show()
    })
  }

  async load(): Promise<void> {
    const query = this.deps.debug ? '?debug=1' : ''
    if (this.deps.rendererUrl) await this.win.loadURL(this.deps.rendererUrl + query)
    else await this.win.loadFile(join(here, '../renderer/index.html'), { search: query.slice(1) })
  }

  /** 开始盯着显示器变化 —— 拔掉 / 插回都要在 2s 内落位 */
  watch(): void {
    screen.on('display-added', () => this.schedule())
    screen.on('display-removed', () => this.schedule())
    screen.on('display-metrics-changed', (_e, _display, changedMetrics: string[]) => {
      this.schedule(changedMetrics)
    })
    this.signature = displaySignature(allDisplays())
    this.timer = setInterval(() => {
      // 指纹在这里**不消费** —— 它由 relocate() 处理完之后才更新。
      // 先消费会让「排队中又被丢弃」的变化永远找不回来（复核 P1）。
      if (displaySignature(allDisplays()) === this.signature) return
      this.schedule()
    }, POLL_MS)
    this.win.on('closed', () => this.dispose())
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer)
    if (this.debounce) clearTimeout(this.debounce)
    if (this.settleTimer) clearTimeout(this.settleTimer)
    this.timer = this.debounce = this.settleTimer = null
  }

  /**
   * 攒事件。changed 为空表示插拔或轮询发现的变化，不经 changedMetrics 过滤。
   * settle 期间（relocating）只入队不起定时器 —— settle 结束时会补跑一次，
   * 所以我们自己 toggle 全屏引发的回调不会丢掉真实变化，也不会把它变成死循环
   * （补跑那一轮 shouldRelocate 会看到目标没变且已全屏，直接 return）。
   */
  private schedule(changed?: readonly string[]): void {
    this.queue.push(changed)
    if (this.queue.blocked) return
    if (this.debounce) clearTimeout(this.debounce)
    this.debounce = setTimeout(() => {
      this.debounce = null
      if (this.queue.blocked) return
      this.relocate(this.queue.take())
    }, DEBOUNCE_MS)
  }

  /** 选屏 + 落位。副屏在 → 全屏铺满；副屏不在 → 主屏居中 960×540 普通窗口。 */
  relocate(changed?: readonly string[]): void {
    if (this.win.isDestroyed() || this.relocating) return
    const target = pickTarget(allDisplays())
    const isFull = this.win.isSimpleFullScreen()

    if (!shouldRelocate(this.current, target, { changed, isFullScreen: isFull })) {
      this.current = target
      // 这一轮确实处理过了，指纹才能更新；否则轮询会每 500 ms 重复报同一次变化
      this.signature = displaySignature(allDisplays())
      return
    }

    this.relocating = true
    this.queue.block()
    try {
      const bounds = target
        ? target.bounds
        : centeredBounds(screen.getPrimaryDisplay() as unknown as DisplayLike, this.lastSize)
      if (target) {
        this.lastSize = { width: target.bounds.width, height: target.bounds.height }
        console.log(
          `[displays] target="${target.label}" by=${target.reason} bounds=${fmt(bounds)} ` +
            `scale=${target.scaleFactor} canvas=${fmtSize(canvasFor(bounds))} ` +
            `win=${fmt(this.win.getBounds())} fullscreen=${isFull}`
        )
        // 顺序要紧：先退出 simpleFullScreen，再挪 bounds，最后再全屏，
        // 否则 setBounds 会被当前屏的全屏状态吃掉，窗口留在旧屏上。
        if (isFull) this.win.setSimpleFullScreen(false)
        this.win.setBounds(bounds)
        this.win.setSimpleFullScreen(true)
      } else {
        console.log(
          `[displays] TYPE-C 不在，回落到主屏居中窗口 bounds=${fmt(bounds)} ` +
            `canvas=${fmtSize(canvasFor(bounds))}`
        )
        if (isFull) this.win.setSimpleFullScreen(false)
        this.win.setBounds(bounds)
      }
      this.current = target
      this.deps.onCanvas?.(canvasFor(bounds))
    } finally {
      // 全屏切换会带出一串 workArea / bounds 事件，等它们过去再解除封锁
      if (this.settleTimer) clearTimeout(this.settleTimer)
      this.settleTimer = setTimeout(() => {
        this.settleTimer = null
        this.relocating = false
        this.signature = displaySignature(allDisplays())
        this.queue.unblock()
        // settle 期间攒下的变化在这里补跑 —— 它们只是被延后，没有被丢掉
        if (this.queue.pending) this.schedule()
      }, SETTLE_MS)
    }
  }

  /** 当前落在哪块屏上（截图脚本与日志用） */
  target(): Target | null {
    return this.current
  }
}

function allDisplays(): DisplayLike[] {
  return screen.getAllDisplays() as unknown as DisplayLike[]
}

const fmt = (b: { x: number; y: number; width: number; height: number }): string =>
  `${b.width}x${b.height}@${b.x},${b.y}`

const fmtSize = (s: Size): string => `${s.width}x${s.height}`
