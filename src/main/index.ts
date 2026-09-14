/**
 * app 生命周期、单实例锁、创建窗口、注册快捷键、dev IPC。
 * M1 不做托盘 / 自启 / 打包 —— 那是 M4。
 */

import { app, ipcMain } from 'electron'
import { join } from 'node:path'
import { MonitorWindow } from './window.js'
import { Store } from './state.js'
import { registerShortcuts, unregisterShortcuts } from './shortcuts.js'
import { CH } from '../shared/ipc.js'
import type { DevMessage } from '../shared/ipc.js'
import { SCENE_NAMES } from '../shared/types.js'
import type { MonitorCommand, MonitorState, Page, SceneName } from '../shared/types.js'

const SHOOT = process.env.MONITOR_SHOOT === '1'
const SELFTEST = process.env.MONITOR_SELFTEST === '1'
// 调试视图（原型的控制栏）：显式 MONITOR_DEBUG=1 时开；截图要的是纯净视图，所以 shoot 下强制关
const DEBUG = process.env.MONITOR_DEBUG === '1' && !SHOOT

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  void main()
}

async function main(): Promise<void> {
  await app.whenReady()

  const store = new Store()
  const mw = new MonitorWindow({
    rendererUrl: process.env.ELECTRON_RENDERER_URL,
    debug: DEBUG,
    // 画布尺寸跟着目标显示器走：960×540 @2x → 480×270，960×640 @1x → 480×320
    onCanvas: canvas => store.setCanvas(canvas)
  })

  // 渲染层的 console error 要在主进程日志里看得见 —— 验收第 5 条靠它
  mw.win.webContents.on('console-message', ev => {
    if (ev.level === 'error' || ev.level === 'warning') {
      console.error(`[renderer:${ev.level}] ${ev.message} (${ev.sourceId}:${ev.lineNumber})`)
    }
  })

  /**
   * 首帧必须等页面加载完。
   * Store.subscribe 注册时会同步回调一次，而 mw.load() 在后面才 await ——
   * 那一次 send 落在 about:blank 上被丢掉，之后 store 不再变化就再没有第二次推送，
   * 面板于是全黑（复核 P0）。所以：didFinishLoad 之前只记不发，加载完立刻补推当前整份 state。
   * did-finish-load 每次重载都会再触发（dev 的整页刷新也算），重载后也能拿到状态。
   */
  let rendererReady = false
  const push = (state: MonitorState): void => {
    if (!rendererReady || mw.win.isDestroyed()) return
    mw.win.webContents.send(CH.state, state)
  }
  mw.win.webContents.on('did-finish-load', () => {
    rendererReady = true
    push(store.get())
  })
  const unsubscribe = store.subscribe(push)

  ipcMain.on(CH.ack, (_e, id: string) => {
    if (typeof id === 'string') store.ack(id)
  })
  ipcMain.on(CH.setPage, (_e, page: Page) => {
    // M1 页码由渲染层的 pager 持有，主进程只记录，不回推（回推会和本地状态机打架）
    if (DEBUG) console.log(`[page] ${page}`)
  })
  if (!app.isPackaged) {
    ipcMain.on(CH.dev, (_e, msg: DevMessage) => {
      switch (msg?.type) {
        case 'setState':
          if ((SCENE_NAMES as string[]).includes(msg.name)) store.setScene(msg.name as SceneName)
          break
        case 'simulateEvent':
          store.simulateEvent()
          break
        case 'simulateAttention':
          store.simulateAttention()
          break
        case 'clearAttention':
          store.clearAttention()
          break
      }
    })
  }

  registerShortcuts((cmd: MonitorCommand) => {
    if (!mw.win.isDestroyed()) mw.win.webContents.send(CH.command, cmd)
  })

  await mw.load()
  mw.watch()

  // 工具脚本动态 import：截图与自检代码不该出现在生产 main bundle 里（复核 P2-5.3）
  if (SHOOT) {
    const { runShoot } = await import('../../scripts/shoot.js')
    await new Promise<void>(r => setTimeout(r, 1200)) // 让首帧与字体收敛
    const ok = await runShoot(mw.win, store, join(app.getAppPath(), 'design', 'shots', 'm1'))
    unsubscribe()
    process.exitCode = ok ? 0 : 1
    app.quit()
  } else if (SELFTEST) {
    const { runSelftest } = await import('../../scripts/selftest.js')
    const ok = await runSelftest(mw.win)
    unsubscribe()
    process.exitCode = ok ? 0 : 1
    app.quit()
  }

  app.on('will-quit', unregisterShortcuts)
  // 副屏面板是常驻的：关掉最后一个窗口就等于关掉它，不留后台进程
  app.on('window-all-closed', () => app.quit())
}
