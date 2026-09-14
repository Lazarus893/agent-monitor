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
import type { AgentId, MonitorCommand, MonitorState, NoticeCode, Page, SceneName } from '../shared/types.js'
import { setForcedError, startQuota } from './collectors/quota/index.js'
import { startEvents } from './collectors/events/index.js'
import { startV2 } from './collectors/v2.js'
import { PanelXConfig } from './config.js'

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

  // 截图对账要的是 fixtures 的那七帧（逐像素跟原型比），别让真实采集把它们顶掉；
  // 其余情况（pnpm dev / selftest）一律跑真实采集。
  const store = new Store(SHOOT ? 'populated' : 'live')

  /**
   * 横向压缩补偿（M3 附加节）。副屏在 960×540 模式下被面板缩放器横向压 15.6%，
   * 用户实测系数 1.19。默认值按显示模式给，手调过之后以 ~/.agent-monitor/config.json 为准。
   */
  let canvas = { width: 480, height: 270 }
  const panel = new PanelXConfig(canvas)
  store.setPanelX(panel.get())

  const mw = new MonitorWindow({
    rendererUrl: process.env.ELECTRON_RENDERER_URL,
    debug: DEBUG,
    // 画布尺寸跟着目标显示器走：960×540 @2x → 480×270，960×640 @1x → 480×320
    onCanvas: next => {
      canvas = next
      store.setCanvas(next)
      store.setPanelX(panel.onCanvas(next))
    }
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
  // 采集器在窗口加载完之后才 start（见下），这里先留个引用给 dev IPC 用
  let quota: ReturnType<typeof startQuota> | null = null

  if (!app.isPackaged) {
    ipcMain.on(CH.dev, (_e, msg: DevMessage) => {
      switch (msg?.type) {
        case 'setState':
          if (msg.name === 'live') store.setLive()
          else if ((SCENE_NAMES as string[]).includes(msg.name)) store.setScene(msg.name as SceneName)
          break
        case 'forceError': {
          const id = msg.agent as AgentId
          if (id !== 'codex' && id !== 'claude' && id !== 'zcode') break
          const ok = setForcedError(id, msg.code as NoticeCode | null)
          console.log(`[quota:${id}] forceError ${msg.code ?? '(clear)'} → ${ok ? 'armed' : 'ignored'}`)
          // 立刻重采一轮，否则 60 s 周期下要等一分钟才看得见
          if (ok) quota?.kick(id)
          break
        }
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

  const send = (cmd: MonitorCommand): void => {
    if (!mw.win.isDestroyed()) mw.win.webContents.send(CH.command, cmd)
  }
  const applyPanelX = (value: number): void => {
    store.setPanelX(value)
    // 屏角闪显 1 s 当前值 —— 用户要能一眼看到自己调到了多少
    send({ type: 'panelX', value })
    console.log(`[panelx] ${value.toFixed(2)}`)
  }
  registerShortcuts(send, {
    nudge: delta => applyPanelX(panel.nudge(delta)),
    reset: () => applyPanelX(panel.reset(canvas))
  })

  await mw.load()
  mw.watch()

  // 采集在窗口就绪之后才起：首轮结果到达时渲染层已经能收状态了
  // dev 开关（MONITOR_FAKE_ERROR）只在未打包时认，别把调试旋钮留在产物里（复核 §1.5-2）
  quota = SHOOT ? null : startQuota(store, { dev: !app.isPackaged })
  app.on('will-quit', () => quota?.stop())

  /* M3 事件 + M3b 的 v2 数据层。截图模式喂的是 fixtures 那七帧，不起真实采集。
     selftest / shoot 的落盘一律换到独立目录（`MONITOR_USER_DATA`）：它们会往事件流里
     塞合成事件，绝不能混进用户真实的 events.json —— 实机 C1 页上出现过
     「selftest · ZCode 任务」那样的行，就是这条隔离没做全。
     panelX 的配置与 hook 的 token / 端口同样由环境变量挪开（见 package.json 的 scripts）。 */
  const dataDir = process.env.MONITOR_USER_DATA?.trim()
    || (SELFTEST || SHOOT ? join(app.getPath('temp'), 'agent-monitor-selftest') : app.getPath('userData'))
  const events = SHOOT ? null : startEvents(store, dataDir)
  const v2 = SHOOT || !events ? null : startV2(store, dataDir, events, app.getVersion())
  app.on('will-quit', () => { v2?.stop(); events?.stop() })

  // 工具脚本动态 import：截图与自检代码不该出现在生产 main bundle 里（复核 P2-5.3）
  if (SHOOT) {
    const { runShoot } = await import('../../scripts/shoot.js')
    await new Promise<void>(r => setTimeout(r, 1200)) // 让首帧与字体收敛
    const ok = await runShoot(mw.win, store, join(app.getAppPath(), 'design', 'shots', 'm3'))
    unsubscribe()
    process.exitCode = ok ? 0 : 1
    app.quit()
  } else if (SELFTEST) {
    const { runSelftest } = await import('../../scripts/selftest.js')
    const ok = await runSelftest(mw.win, store)
    unsubscribe()
    process.exitCode = ok ? 0 : 1
    app.quit()
  }

  app.on('will-quit', unregisterShortcuts)
  // 副屏面板是常驻的：关掉最后一个窗口就等于关掉它，不留后台进程
  app.on('window-all-closed', () => app.quit())
}
