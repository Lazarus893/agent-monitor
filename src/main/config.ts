/**
 * 用户配置 —— `~/.agent-monitor/config.json`。
 *
 * 装两类东西：`panelX`（横向压缩补偿）与 M4 托盘的三个开关
 * （静音 / 总在最前 / 登录时启动）。写入一律是**合并写**，见 writeConfig。
 *
 * 为什么需要它：副屏 EDID 原生面板是 960×640（3:2），用户在 960×540 @2x 下使用，
 * 画面被面板自己的缩放器横向压掉 15.6%，圆变成竖椭圆、字显得瘦。这是**显示器内部**
 * 的形变，macOS 与 Electron 都看不见它，只能由人眼校准一次再由我们补回去。
 * 用户 2026-09-14 用 design/tools/aspect-test.html 的正圆实测：**1.19**。
 *
 * 补偿方式（design/brief-m0-v2.md §5）：画布逻辑宽度缩成 round(480 / panelX)，
 * stage 横向再按 bounds.width / canvasW 拉回去。于是屏上 1 CSS px 宽 = 1 CSS px 高，
 * 而版面仍然是那一份 480 高度栅格 —— 变窄的是横向的可用格子数，不是字号。
 *
 * 默认值按显示模式分档：960×540（被压）→ 1.19，960×640（原生）→ 1.0。
 * 用户手调过之后**以配置为准**，不再随模式切换被覆盖 —— 否则插拔一次就把校准结果丢了。
 *
 * 落盘是原子的（写临时文件再 rename），0600；读失败一律回落默认值，不崩。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { clampPanelX } from '../shared/scale.js'

export { canvasWidthFor, clampPanelX } from '../shared/scale.js'

export const CONFIG_DIR = join(homedir(), '.agent-monitor')
export const DEFAULT_CONFIG_FILE = join(CONFIG_DIR, 'config.json')

/**
 * 配置文件路径。`MONITOR_CONFIG_FILE` 可覆盖 —— selftest / shoot 靠它把 panelX
 * 写进临时目录，绝不碰用户真实的 ~/.agent-monitor/config.json（自检不该有副作用）。
 */
export const configFile = (env = process.env.MONITOR_CONFIG_FILE): string =>
  env && env.trim() ? env : DEFAULT_CONFIG_FILE

/** 兼容旧调用点；新代码用 configFile()。 */
export const CONFIG_FILE = DEFAULT_CONFIG_FILE

/** 被压模式（960×540）的实测系数 */
export const PANEL_X_COMPRESSED = 1.19
/** 原生模式（960×640）不需要补偿 */
export const PANEL_X_NATIVE = 1.0
export const PANEL_X_STEP = 0.02

export type Config = {
  /** 当前生效的补偿系数 */
  panelX?: number
  /** 托盘「静音提示音」。默认关（有声）。 */
  muted?: boolean
  /** 托盘「总在最前」。默认关（简报 §1）。 */
  alwaysOnTop?: boolean
  /** 托盘「登录时启动」。默认开（简报 §2）。 */
  openAtLogin?: boolean
  /**
   * 这个值是不是**用户自己调出来的**。
   *
   * 复核 P1-②：原来的判据是「盘上有没有 panelX」，而构造函数为了满足简报的
   * 「配置不存在则创建」自己就写了一个 panelX 进去 —— 于是第二次启动起 touched 恒为真，
   * 用户把副屏切到原生 960×640 之后再也回不到 1.0，画面被横向拉伸 19%。
   * 现在把它显式落盘：默认值写 touched:false，只有 ⌃⌥] / ⌃⌥[ 才置 true。
   */
  touched?: boolean
}

/** 显示模式 → 默认补偿。判据是画布高度：270 = 540 模式（被压），320 = 640 模式（原生）。 */
export function defaultPanelX(canvas: { width: number; height: number }): number {
  return canvas.height >= 300 ? PANEL_X_NATIVE : PANEL_X_COMPRESSED
}

/**
 * 盘上那份对象的原样读取，不做任何净化。**读不出来时返回 null**，
 * 与「读出来是个空对象」区分开 —— 调用方靠这个区别决定回落到什么。
 *
 * 合并写要用它 —— M3 复核 §3.4 记的前向陷阱：`writeConfig` 原来整份覆盖，
 * 用户手加的字段（以及本文件还不认识的新字段）会被下一次 nudge 抹掉。
 * M4 加了三个开关之后，「整份覆盖」立刻会变成真 bug：托盘勾静音会把 panelX 冲掉。
 */
function readRaw(file: string): Record<string, unknown> | null {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return null // 不存在 / 没权限 —— 第一次启动就是这一条，不值得记日志
  }
  try {
    const raw: unknown = JSON.parse(text)
    if (typeof raw !== 'object' || raw === null) throw new Error('不是对象')
    return raw as Record<string, unknown>
  } catch (err) {
    // 文件在、但内容坏了：这个值得说一声，否则用户会以为自己编辑的那行生效了
    console.warn(`[config] ${file} 解析失败，本次按默认值跑：${String(err)}`)
    return null
  }
}

export function readConfig(file = configFile()): Config {
  try {
    const o = readRaw(file)
    if (!o) return {}
    const panelX = o['panelX']
    const out: Config = {}
    if (typeof panelX === 'number' && Number.isFinite(panelX)) out.panelX = clampPanelX(panelX)
    // touched 只认显式的 true：老配置（M3 第一版写的 {panelX}）没有这一位，按「没调过」算，
    // 于是本机那份被污染的配置在下一次启动就自动复位，不需要用户手工删文件。
    out.touched = o['touched'] === true
    if (typeof o['muted'] === 'boolean') out.muted = o['muted']
    if (typeof o['alwaysOnTop'] === 'boolean') out.alwaysOnTop = o['alwaysOnTop']
    if (typeof o['openAtLogin'] === 'boolean') out.openAtLogin = o['openAtLogin']
    return out
  } catch {
    // 不存在 / 坏 JSON / 没权限 —— 三种都回落默认，配置不该是启动的必要条件
    return {}
  }
}

/**
 * 合并写：盘上已有的字段一律保留，只覆盖 `patch` 里给出的那几个。
 * 调用方因此可以只写自己关心的键（托盘写 muted，panelX 写 panelX），互不相冲。
 */
export function writeConfig(patch: Config, file = configFile()): boolean {
  try {
    // 盘上那份坏了就当它不存在，从 patch 重新起一份 —— 写入不该被一份坏 JSON 卡死
    const cfg = { ...(readRaw(file) ?? {}), ...patch }
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    const tmp = file + '.tmp'
    writeFileSync(tmp, JSON.stringify(cfg, null, 1) + '\n', { mode: 0o600 })
    renameSync(tmp, file)
    return true
  } catch (err) {
    console.warn(`[config] 写入失败：${String(err)}`)
    return false
  }
}

/**
 * panelX 的当前值 + 三个操作。
 * 「用户调过没有」这件事要记住（`touched`）：调过就锁死用户的值，
 * 没调过才跟着显示模式走默认。
 */
export class PanelXConfig {
  private value: number
  private touched: boolean

  constructor(canvas: { width: number; height: number }, private file = configFile()) {
    const cfg = readConfig(file)
    this.touched = cfg.touched === true
    // 没调过就按当前显示模式重算，盘上那个值只是上一次的模式默认，不是用户的选择
    this.value = this.touched && cfg.panelX !== undefined ? cfg.panelX : defaultPanelX(canvas)
    // 配置文件不存在就建一份 —— 简报要求「不存在则创建」，用户能直接编辑它
    if (!this.touched) writeConfig({ panelX: this.value, touched: false }, file)
  }

  get(): number {
    return this.value
  }

  /** 显示模式变了：没被手调过的才跟着换默认（960×540 → 1.19，960×640 → 1.0） */
  onCanvas(canvas: { width: number; height: number }): number {
    if (this.touched) return this.value
    const next = defaultPanelX(canvas)
    if (next !== this.value) {
      this.value = next
      writeConfig({ panelX: next, touched: false }, this.file)
    }
    return this.value
  }

  /** ⌃⌥] / ⌃⌥[ ：只有这里会把 touched 置真 —— 它是唯一「用户自己调」的入口 */
  nudge(delta: number): number {
    this.value = clampPanelX(this.value + delta)
    this.touched = true
    writeConfig({ panelX: this.value, touched: true }, this.file)
    return this.value
  }

  /** ⌃⌥0：回到当前显示模式的默认值，并把「手调过」这个标记也清掉 */
  reset(canvas: { width: number; height: number }): number {
    this.value = defaultPanelX(canvas)
    this.touched = false
    writeConfig({ panelX: this.value, touched: false }, this.file)
    return this.value
  }
}

/* ==========================================================================
   M4 · 托盘的三个开关。
   它们与 panelX 共用同一个 config.json，但走合并写（见 writeConfig），
   所以托盘勾一下不会把用户校准出来的 panelX 冲掉。
   ========================================================================== */

export type Prefs = {
  /** 提示音静音。注意它与 prefers-reduced-motion 解耦（M1 复核 §3.4）：
   *  只关动画的用户不该连提示音一起丢掉，静音只由这一位决定。 */
  muted: boolean
  alwaysOnTop: boolean
  openAtLogin: boolean
}

export const DEFAULT_PREFS: Prefs = { muted: false, alwaysOnTop: false, openAtLogin: true }

export function readPrefs(file = configFile()): Prefs {
  const cfg = readConfig(file)
  return {
    muted: cfg.muted ?? DEFAULT_PREFS.muted,
    alwaysOnTop: cfg.alwaysOnTop ?? DEFAULT_PREFS.alwaysOnTop,
    openAtLogin: cfg.openAtLogin ?? DEFAULT_PREFS.openAtLogin
  }
}

export function writePref<K extends keyof Prefs>(
  key: K, value: Prefs[K], file = configFile()
): boolean {
  return writeConfig({ [key]: value } as Config, file)
}
