/**
 * 全局快捷键。不需要窗口聚焦 —— 副屏面板本来就不该被点到才能用。
 * 注册失败（被别的 app 占了）只记录，不崩：少一个快捷键不该让面板起不来。
 *
 *   ⌃⌥← / ⌃⌥→   切页
 *   ⌃⌥↑          回 A 并恢复轮播
 *   ⌃⌥] / ⌃⌥[   横向压缩补偿 panelX ±0.02（M3 附加节）
 *   ⌃⌥0          panelX 复位为当前显示模式的默认
 *   ⌃⌥C          校准叠层开关（200px 正圆 + 十字线）
 *
 * panelX 的三个键不直接发 MonitorCommand：值要先经主进程的 PanelXConfig 夹紧、
 * 写回 ~/.agent-monitor/config.json，再把**结果**推给渲染层。让渲染层自己加减
 * 会让配置文件与屏上的值分家。
 */

import { globalShortcut } from 'electron'
import type { MonitorCommand } from '../shared/types.js'

/** 只需要转发的那几个 */
const BINDINGS: Array<{ accelerator: string; command: MonitorCommand }> = [
  { accelerator: 'Control+Alt+Left', command: { type: 'step', dir: -1 } },
  { accelerator: 'Control+Alt+Right', command: { type: 'step', dir: 1 } },
  { accelerator: 'Control+Alt+Up', command: { type: 'home' } },
  { accelerator: 'Control+Alt+C', command: { type: 'calibrate' } }
]

export type PanelXActions = {
  /** ⌃⌥] / ⌃⌥[ */
  nudge(delta: number): void
  /** ⌃⌥0 */
  reset(): void
}

function bind(accelerator: string, fn: () => void): void {
  let ok = false
  try {
    ok = globalShortcut.register(accelerator, fn)
  } catch (err) {
    console.warn(`[shortcuts] ${accelerator} 注册抛错：${String(err)}`)
    return
  }
  if (!ok) console.warn(`[shortcuts] ${accelerator} 注册失败（可能被其它 app 占用），已跳过`)
}

export function registerShortcuts(
  send: (cmd: MonitorCommand) => void,
  panelX?: PanelXActions
): void {
  for (const { accelerator, command } of BINDINGS) bind(accelerator, () => send(command))
  if (!panelX) return
  bind('Control+Alt+]', () => panelX.nudge(+0.02))
  bind('Control+Alt+[', () => panelX.nudge(-0.02))
  bind('Control+Alt+0', () => panelX.reset())
}

export function unregisterShortcuts(): void {
  globalShortcut.unregisterAll()
}
