/**
 * 全局快捷键：⌃⌥← / ⌃⌥→ 切页，⌃⌥↑ 回 A 并恢复轮播。
 * 不需要窗口聚焦 —— 副屏面板本来就不该被点到才能用。
 * 注册失败（被别的 app 占了）只记录，不崩：少一个快捷键不该让面板起不来。
 */

import { globalShortcut } from 'electron'
import type { MonitorCommand } from '../shared/types.js'

const BINDINGS: Array<{ accelerator: string; command: MonitorCommand }> = [
  { accelerator: 'Control+Alt+Left', command: { type: 'step', dir: -1 } },
  { accelerator: 'Control+Alt+Right', command: { type: 'step', dir: 1 } },
  { accelerator: 'Control+Alt+Up', command: { type: 'home' } }
]

export function registerShortcuts(send: (cmd: MonitorCommand) => void): void {
  for (const { accelerator, command } of BINDINGS) {
    let ok = false
    try {
      ok = globalShortcut.register(accelerator, () => send(command))
    } catch (err) {
      console.warn(`[shortcuts] ${accelerator} 注册抛错：${String(err)}`)
      continue
    }
    if (!ok) console.warn(`[shortcuts] ${accelerator} 注册失败（可能被其它 app 占用），已跳过`)
  }
}

export function unregisterShortcuts(): void {
  globalShortcut.unregisterAll()
}
