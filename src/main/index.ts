/**
 * app 生命周期、单实例锁、创建窗口、注册快捷键、托盘、登录自启、dev IPC。
 *
 * M4 在 M1 的骨架上加了四样长期运行需要的东西：
 *   · 日志（`~/Library/Logs/Agent Monitor/main.log`，5 MB 轮转 ×3）与全局异常兜底；
 *   · 托盘 —— 唯一的设置入口，副屏上仍然没有任何按钮；
 *   · 登录自启（`openAtLogin` + `openAsHidden`），托盘里可关；
 *   · 渲染进程崩溃自动 reload。
 */

import { app, ipcMain, Menu } from 'electron'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
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
import { PanelXConfig, readPrefs, writePref } from './config.js'
import { installCrashGuards, logDir, startLogging } from './log.js'
import { TrayMenu } from './tray.js'
import { closeConnectWindow, hasZcodeKey, openConnectWindow } from './connect.js'
import { setKeychainOverrideAllowed } from './collectors/quota/keychain.js'

const SHOOT = process.env.MONITOR_SHOOT === '1'
const SELFTEST = process.env.MONITOR_SELFTEST === '1'
// 调试视图（原型的控制栏）：显式 MONITOR_DEBUG=1 时开；截图要的是纯净视图，所以 shoot 下强制关
const DEBUG = process.env.MONITOR_DEBUG === '1' && !SHOOT

/* 日志在最早：单实例被挡掉、或者启动路上直接抛，这两种情况也该在文件里留下一行。
   selftest / shoot 改写到临时目录 —— 自检不该往用户真实的日志里塞合成事件。 */
const LOG_DIR = process.env.MONITOR_LOG_DIR?.trim()
  || (SELFTEST || SHOOT ? join(tmpdir(), 'agent-monitor-selftest', 'logs') : logDir())
startLogging(LOG_DIR)
/* 启动期的致命错误要**退出**，不能吞（设计终审收尾第 1 条）。
   `app.exit` 而不是 `app.quit`：quit 会走 will-quit 那一串 handler，
   而此刻的前提正是「启动没走完」，那些 handler 未必能安全跑。 */
const crash = installCrashGuards(code => app.exit(code))

if (!app.requestSingleInstanceLock()) {
  console.log('[app] 已有一个实例在跑，本次退出')
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

  // 托盘的三个开关。写盘走 config 的合并写，勾一下不会把校准出来的 panelX 冲掉。
  let prefs = readPrefs()

  /* 开发期旋钮一律关在 isPackaged 后面（M4 复核 P1-②）。
     这一条原来是整套 gating 里唯一的缺口：面板被劫持只是显示错东西，
     但**连接窗口的 preload 暴露的是 save()，它直通 `security add-generic-password -U`**——
     一个由 ELECTRON_RENDERER_URL 指过去的远端页面可以往钥匙串里写任意值，
     而 sender 校验挡不住它（发起方确实就是连接窗口本身）。 */
  const rendererUrl = app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL
  setKeychainOverrideAllowed(!app.isPackaged)

  const mw = new MonitorWindow({
    rendererUrl,
    debug: DEBUG,
    // 画布尺寸跟着目标显示器走：960×540 @2x → 480×270，960×640 @1x → 480×320
    onCanvas: next => {
      canvas = next
      store.setCanvas(next)
      store.setPanelX(panel.onCanvas(next))
      // 落位会 toggle simpleFullScreen，置顶标记要重新贴一次；菜单首行的显示器名也变了
      applyAlwaysOnTop(prefs.alwaysOnTop)
      tray?.rebuild()
    }
  })

  /* 渲染进程没了就把它拉回来（简报 §4）。常驻面板最坏的样子是**一块黑屏挂在副屏上**，
     而且没人会去看：主进程还活着，托盘图标还在，所以不会有任何人发现。
     `reason === 'clean-exit'` 是我们自己 quit 时的正常路径，不重载。
     退避 2 s 是为了挡住「一起来就崩」的循环：那种情况下日志里会每 2 s 一条，看得见。 */
  let quitting = false
  app.on('before-quit', () => { quitting = true })
  mw.win.webContents.on('render-process-gone', (_e, details) => {
    // 我们自己在退出：渲染进程被杀是正常路径，不该记成 ERROR，更不该再拉起来
    if (quitting) return
    console.error(`[renderer] 进程退出：${details.reason}（exitCode=${details.exitCode}）`)
    if (details.reason === 'clean-exit' || mw.win.isDestroyed()) return
    setTimeout(() => {
      if (mw.win.isDestroyed()) return
      console.log('[renderer] 重新加载')
      rendererReady = false
      mw.win.reload()
    }, 2000)
  })
  mw.win.webContents.on('unresponsive', () => console.warn('[renderer] 无响应'))

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
    // 首帧画出来了：从这里起，未接住的异常只记日志、不再退出
    crash.markReady()
    rendererReady = true
    push(store.get())
    // 静音是个偏好、不在 state 里，所以每次加载完都补推一次（崩溃重载后也不会丢）
    send({ type: 'mute', value: prefs.muted })
  })
  const unsubscribe = store.subscribe(push)

  /* M4 起有第二个 webContents（「连接 ZCode」窗口），所以面板的 IPC 要认来源
     （M1 复核 §2 的 P2）。连接窗口自己的两个 handler 在 connect.ts 里各自校验。 */
  const fromPanel = (e: Electron.IpcMainEvent): boolean =>
    !mw.win.isDestroyed() && e.sender === mw.win.webContents

  ipcMain.on(CH.ack, (e, id: string) => {
    if (fromPanel(e) && typeof id === 'string') store.ack(id)
  })
  ipcMain.on(CH.setPage, (e, page: Page) => {
    // M1 页码由渲染层的 pager 持有，主进程只记录，不回推（回推会和本地状态机打架）
    if (fromPanel(e) && DEBUG) console.log(`[page] ${page}`)
  })
  // 采集器在窗口加载完之后才 start（见下），这里先留个引用给 dev IPC 用
  let quota: ReturnType<typeof startQuota> | null = null

  if (!app.isPackaged) {
    ipcMain.on(CH.dev, (e, msg: DevMessage) => {
      if (!fromPanel(e)) return
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

  /* ---------- M4 · 置顶、登录自启、托盘 ---------- */

  function applyAlwaysOnTop(value: boolean): void {
    if (mw.win.isDestroyed()) return
    // 'floating' 级别足够压住普通窗口，又不会盖住系统 UI（'screen-saver' 会连通知中心一起压）
    mw.win.setAlwaysOnTop(value, 'floating')
  }

  /**
   * 登录自启（简报 §2）。
   *
   * 简报写的是 `{ openAtLogin: true, openAsHidden: true }`，但 **Electron 44 已经
   * 没有 `openAsHidden` 了** —— macOS 13 起登录项走 SMAppService，那套 API 不带
   * 「以隐藏方式启动」这一位，Electron 也就把它从 `Settings` 里删了。
   * 对这个 app 来说反而正好：面板本来就该在开机后自己出现在副屏上，
   * 真被 openAsHidden 藏起来才是 bug。焦点问题由窗口自己解决（`show: false` +
   * ready-to-show 才 show，且从不调 `app.focus()`）。
   *
   * **只在打包后写**：dev 下 `process.execPath` 是 node_modules 里的 Electron，
   * 把它写进登录项，用户下次开机会起一个空壳 Electron。
   */
  function applyOpenAtLogin(value: boolean): void {
    if (!app.isPackaged) {
      console.log(`[login] 未打包，跳过登录项写入（意图 openAtLogin=${value}）`)
      return
    }
    try {
      app.setLoginItemSettings({ openAtLogin: value })
      const s = app.getLoginItemSettings()
      console.log(`[login] openAtLogin=${value} → 系统回报 ${s.openAtLogin} status=${s.status}`)
    } catch (err) {
      // 用户在「系统设置 → 通用 → 登录项」里拒绝过，就会抛在这儿；不该因此起不来
      console.warn(`[login] 写入登录项失败：${String(err)}`)
    }
  }

  /**
   * 最小应用菜单（M4 复核 P1-③）。
   *
   * 不设的话挂的是 Electron 默认菜单，里面有 **⌘W 关闭窗口**、⌘R 重载、⌥⌘I DevTools。
   * 面板是可聚焦的（翻页的 `.edge` 是两个 `<button>`，点一下就聚焦），一次误触 ⌘W
   * 就把窗口关了 —— 对一个 24/7 没人盯着的监视器来说这是最糟的失败形态：
   * 它安静地整个消失，而用户以为它还在跑。
   *
   * 只留两组：
   *   · `appMenu` —— ⌘Q 在这里，它是**有意保留**的退出路径（托盘「退出」是另一条）；
   *   · `editMenu` —— 「连接 ZCode」那个输入框要能 ⌘V 粘贴。macOS 上剪贴板快捷键
   *     是由菜单项承载的，没有 Edit 菜单就粘贴不进去，用户只能一个字符一个字符敲 Key。
   * 没有 `windowMenu`（Close ⌘W 在它里面），也没有 `viewMenu`（Reload / DevTools）。
   */
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }]))

  applyAlwaysOnTop(prefs.alwaysOnTop)
  applyOpenAtLogin(prefs.openAtLogin)

  const tray = SHOOT || SELFTEST ? null : new TrayMenu({
    version: app.getVersion(),
    displayLabel: () => mw.target()?.label ?? '主屏窗口',
    prefs: () => prefs,
    setMuted: v => {
      prefs = { ...prefs, muted: v }
      writePref('muted', v)
      send({ type: 'mute', value: v })
      console.log(`[tray] 静音 ${v ? '开' : '关'}`)
    },
    setAlwaysOnTop: v => {
      prefs = { ...prefs, alwaysOnTop: v }
      writePref('alwaysOnTop', v)
      applyAlwaysOnTop(v)
      console.log(`[tray] 总在最前 ${v ? '开' : '关'}`)
    },
    setOpenAtLogin: v => {
      prefs = { ...prefs, openAtLogin: v }
      writePref('openAtLogin', v)
      applyOpenAtLogin(v)
    },
    home: () => send({ type: 'home' }),
    calibrate: () => send({ type: 'calibrate' }),
    resetPanelX: () => applyPanelX(panel.reset(canvas)),
    connect: () => openConnectWindow({
      rendererUrl,
      onSaved: () => {
        void tray?.refreshKey()
        // 存完立刻重采一轮，否则要等下一个 60 s 周期才看得见额度
        quota?.kick('zcode')
      }
    }),
    hasKey: hasZcodeKey,
    logDir: LOG_DIR
  })
  app.on('will-quit', () => { tray?.destroy(); closeConnectWindow() })

  /* 单实例锁已有（见文件顶部）。第二次启动走到这里：不新开窗口，
     只把现有面板重新落位到副屏并带到前面 —— 简报 §2 要确认的就是这个行为。 */
  app.on('second-instance', () => {
    console.log('[app] 第二个实例被挡下，把现有窗口带回副屏')
    if (mw.win.isDestroyed()) return
    mw.relocate()
    mw.win.show()
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
    // 两个工具模式各有一份临时目录（package.json 的 scripts 里也是这么给的）——
    // 共用一份的话，selftest 塞进去的合成事件会被下一次 shoot 拍进交付截图
    || (SELFTEST ? join(app.getPath('temp'), 'agent-monitor-selftest')
      : SHOOT ? join(app.getPath('temp'), 'agent-monitor-shoot')
        : app.getPath('userData'))
  const events = SHOOT ? null : startEvents(store, dataDir)
  const v2 = SHOOT || !events ? null : startV2(store, dataDir, events, app.getVersion())
  app.on('will-quit', () => { v2?.stop(); events?.stop() })

  // 工具脚本动态 import：截图与自检代码不该出现在生产 main bundle 里（复核 P2-5.3）
  if (SHOOT) {
    const { runShoot } = await import('../../scripts/shoot.js')
    await new Promise<void>(r => setTimeout(r, 1200)) // 让首帧与字体收敛
    /* 归档目录可换：`MONITOR_SHOTS_DIR=design/shots/m4 pnpm shoot`。
       默认仍是 m3 —— 那是已提交的对账基线，不该因为加了这个开口就漂走。 */
    const shots = process.env.MONITOR_SHOTS_DIR?.trim()
    const ok = await runShoot(mw.win, store, shots
      ? (shots.startsWith('/') ? shots : join(app.getAppPath(), shots))
      : join(app.getAppPath(), 'design', 'shots', 'm3'))
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
  /* 窗口全关了**也不退**（M4 复核 P1-③）。
     M1 那条「关掉最后一个窗口就等于关掉它」是在没有托盘的前提下写的；
     M4 之后托盘才是这个 app 的本体，退出只有两条明确的路：托盘「退出」与 ⌘Q。
     窗口没了却还留着托盘，用户点一下就知道它还在 —— 比整个进程静悄悄消失强。 */
  app.on('window-all-closed', () => {
    console.log('[app] 窗口全部关闭，托盘仍在；退出请走托盘「退出」或 ⌘Q')
  })
}
