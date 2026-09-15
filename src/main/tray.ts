/**
 * 托盘 —— **唯一的设置入口**（简报 §1）。
 *
 * 副屏上没有任何按钮、没有设置页（PLAN §3.3 的「三通病 · 简洁」），所以所有开关
 * 都在这里。菜单顺序就是简报给的顺序，不重排。
 *
 * 两条与决策 3 有关的取舍：
 *   · 安装 / 卸载完成后的「托盘提示」用 `tray.setTitle()` 在图标右边闪 3 秒文字，
 *     **不发 macOS 系统通知**（决策 3：不打断主屏）。
 *   · 失败才弹一个 dialog —— 改 `~/.claude/settings.json` 这种事失败了不能只写日志。
 *
 * 菜单里有四样东西会在运行中变：勾选状态、面板所在的显示器、钥匙串里有没有 Key、
 * Claude 采集装没装。前两样由改动方直接调 `rebuild()`；Claude 采集可能被别的进程改
 * （用户自己编辑 settings.json），所以还有一条 20 s 的重建 —— 它只 readFileSync 一次。
 * 钥匙串那一问只在启动与保存完之后做：它要 spawn `security`，放进 20 s 的循环里
 * 会在没点过「始终允许」的机器上每 20 s 弹一次授权框。
 *
 * 为什么不是「菜单打开前重建」：macOS 上 `setContextMenu` 之后，左键点击由系统直接
 * 弹菜单，`click` / `right-click` 事件不会先到我们手上 —— 没有「打开前」这个时机。
 */

import { app, dialog, Menu, nativeImage, shell, Tray } from 'electron'
import { join } from 'node:path'
import { claudeStatus, runInstall, scriptsAvailable, statusLabel } from './install.js'
import type { ClaudeStatus, InstallTask } from './install.js'
import { assetDir } from './resources.js'
import type { Prefs } from './config.js'

const TITLE_FLASH_MS = 3000
/** 「Claude 采集」那一行可能被别的进程改，所以周期重建。一次 readFileSync 的量级。 */
const REFRESH_MS = 20_000

export type TrayDeps = {
  /** 显示在首行的版本号 */
  version: string
  /** 面板现在落在哪块屏上；副屏不在时给「主屏窗口」 */
  displayLabel: () => string
  /** 读当前偏好（每次重建菜单时重读，配置可能被别处改过） */
  prefs: () => Prefs
  /** 勾选后的落地。写配置由调用方做，这里只报事件。 */
  setMuted: (v: boolean) => void
  setTypingFollow: (v: boolean) => void
  setAlwaysOnTop: (v: boolean) => void
  setOpenAtLogin: (v: boolean) => void
  /** 回到总览页（等价 ⌃⌥↑） */
  home: () => void
  /** 校准叠层开关（等价 ⌃⌥C） */
  calibrate: () => void
  /** 横向比例复位（等价 ⌃⌥0） */
  resetPanelX: () => void
  /** 打开「连接 ZCode」窗口 */
  connect: () => void
  /** 钥匙串里已经有 Key 了吗 —— 决定菜单文案是「连接」还是「更换」 */
  hasKey: () => Promise<boolean>
  /** 日志文件夹 */
  logDir: string
}

export class TrayMenu {
  readonly tray: Tray
  private hasKey = false
  private flash: NodeJS.Timeout | null = null
  private refresh: NodeJS.Timeout | null = null
  private busy = false
  /** 脚本在不在是装包时就定死的，不必每次重建菜单都去 stat 两个文件 */
  private readonly canInstall = scriptsAvailable()

  constructor(private deps: TrayDeps) {
    const icon = trayImage()
    this.tray = new Tray(icon)
    this.tray.setToolTip('Agent Monitor')
    /* 托盘起来了没有，只看屏幕才知道 —— 而这个 app 常驻、没人盯着，
       菜单栏满了的时候系统还会把图标直接藏掉。落一行当证据：
       图标尺寸、是不是模板图、以及菜单栏最终给它的位置。
       bounds 的宽或高为 0 就是没画出来。
       延后一拍再读 —— 构造完的那一瞬间 macOS 还没给它布局，当场读到的是 32x0@0,0。 */
    setTimeout(() => {
      if (this.tray.isDestroyed()) return
      const size = icon.getSize()
      const b = this.tray.getBounds()
      console.log(`[tray] 就位 icon=${size.width}x${size.height} ` +
        `template=${icon.isTemplateImage()} bounds=${b.width}x${b.height}@${b.x},${b.y}`)
    }, 1200)
    this.rebuild()
    // 钥匙串那一问是异步的，先用「连接」文案顶着，查完再重建一次
    void this.refreshKey()
    /* 周期任务只重建菜单（读一次 settings.json），**不**重查钥匙串 ——
       每 20 s spawn 一次 `security` 除了白费，还可能在没「始终允许」的机器上
       每 20 s 弹一次授权框。钥匙串只在启动时与保存完之后查。 */
    this.refresh = setInterval(() => this.rebuild(), REFRESH_MS)
  }

  /** 重新查钥匙串并重建菜单（保存完 Key 之后调） */
  async refreshKey(): Promise<void> {
    try {
      this.hasKey = await this.deps.hasKey()
    } catch {
      this.hasKey = false
    }
    this.rebuild()
  }

  /** 显示器变了 / 偏好变了 —— 重画菜单 */
  rebuild(): void {
    if (this.tray.isDestroyed()) return
    this.tray.setContextMenu(Menu.buildFromTemplate(this.template()))
  }

  private template(): Electron.MenuItemConstructorOptions[] {
    return trayTemplate({
      version: this.deps.version,
      display: this.deps.displayLabel(),
      prefs: this.deps.prefs(),
      claude: claudeStatus(),
      hasKey: this.hasKey,
      canInstall: this.canInstall,
      busy: this.busy
    }, {
      setMuted: v => { this.deps.setMuted(v); this.rebuild() },
      setTypingFollow: v => { this.deps.setTypingFollow(v); this.rebuild() },
      setAlwaysOnTop: v => { this.deps.setAlwaysOnTop(v); this.rebuild() },
      setOpenAtLogin: v => { this.deps.setOpenAtLogin(v); this.rebuild() },
      home: () => this.deps.home(),
      connect: () => this.deps.connect(),
      install: task => { void this.install(task) },
      calibrate: () => this.deps.calibrate(),
      resetPanelX: () => this.deps.resetPanelX(),
      openLogs: () => { void shell.openPath(this.deps.logDir) },
      quit: () => app.quit()
    })
  }

  /** 跑一件安装 / 卸载。期间把三项禁用，免得连点两次。 */
  private async install(task: InstallTask): Promise<void> {
    if (this.busy) return
    this.busy = true
    this.rebuild()
    const r = await runInstall(task)
    this.busy = false
    this.rebuild()
    if (r.ok) {
      this.notice(r.message)
      return
    }
    // 失败不能只闪一下就过去 —— 它意味着用户的 settings.json 没被改成他以为的样子
    dialog.showMessageBox({
      type: 'warning',
      title: 'Agent Monitor',
      message: r.message,
      detail: `详细输出在日志里：${join(this.deps.logDir, 'main.log')}`,
      buttons: ['好']
    }).catch(() => { /* 对话框起不来也不该影响面板 */ })
  }

  /** 托盘提示：图标右边闪 3 秒文字，不发系统通知（决策 3） */
  notice(text: string): void {
    if (this.tray.isDestroyed()) return
    this.tray.setTitle(` ${text}`)
    if (this.flash) clearTimeout(this.flash)
    this.flash = setTimeout(() => {
      this.flash = null
      if (!this.tray.isDestroyed()) this.tray.setTitle('')
    }, TITLE_FLASH_MS)
  }

  destroy(): void {
    if (this.flash) clearTimeout(this.flash)
    if (this.refresh) clearInterval(this.refresh)
    this.flash = this.refresh = null
    if (!this.tray.isDestroyed()) this.tray.destroy()
  }
}

/**
 * 托盘图。`trayTemplate.png` 的命名不是装饰 —— macOS 看到 `...Template` 就只用 alpha，
 * 菜单栏深色时自动反成白色。`setTemplateImage(true)` 是双保险：
 * `createFromPath` 在某些路径下不会从文件名推断。
 */
function trayImage(): Electron.NativeImage {
  const img = nativeImage.createFromPath(join(assetDir(), 'trayTemplate.png'))
  if (!img.isEmpty()) img.setTemplateImage(true)
  else console.warn(`[tray] 找不到图标：${join(assetDir(), 'trayTemplate.png')}`)
  return img
}

/* ==========================================================================
   菜单模板 —— 抽成纯函数，好让单测钉住**顺序与文案**（简报 §1「按此顺序」）。
   它不碰任何 Electron API，只产出 MenuItemConstructorOptions 数组。
   ========================================================================== */

export type TrayState = {
  version: string
  /** 面板此刻落在哪块屏上 */
  display: string
  prefs: Prefs
  claude: ClaudeStatus
  hasKey: boolean
  /** 安装脚本随包出来了吗 */
  canInstall: boolean
  /** 正在跑安装 / 卸载 */
  busy: boolean
}

export type TrayActions = {
  setMuted: (v: boolean) => void
  setAlwaysOnTop: (v: boolean) => void
  setOpenAtLogin: (v: boolean) => void
  setTypingFollow: (v: boolean) => void
  home: () => void
  connect: () => void
  install: (task: InstallTask) => void
  calibrate: () => void
  resetPanelX: () => void
  openLogs: () => void
  quit: () => void
}

export function trayTemplate(s: TrayState, a: TrayActions): Electron.MenuItemConstructorOptions[] {
  const usable = s.canInstall && !s.busy
  return [
    { label: `Agent Monitor ${s.version} · 运行中（${s.display}）`, enabled: false },
    { type: 'separator' },
    {
      label: '静音提示音',
      type: 'checkbox',
      checked: s.prefs.muted,
      click: item => a.setMuted(item.checked)
    },
    {
      label: '总在最前',
      type: 'checkbox',
      checked: s.prefs.alwaysOnTop,
      click: item => a.setAlwaysOnTop(item.checked)
    },
    {
      // 简报 §2：登录自启默认开，这里是唯一的关闭入口
      label: '登录时启动',
      type: 'checkbox',
      checked: s.prefs.openAtLogin,
      click: item => a.setOpenAtLogin(item.checked)
    },
    {
      // M5：连敲几下就把 Midi 那页推到眼前，停 30 s 恢复轮播。不想被它抢屏就关掉。
      label: '打字时切到 Midi',
      type: 'checkbox',
      checked: s.prefs.typingFollow,
      click: item => a.setTypingFollow(item.checked)
    },
    { label: '回到总览页', click: () => a.home() },
    { type: 'separator' },
    { label: s.hasKey ? '更换 ZCode Key…' : '连接 ZCode…', click: () => a.connect() },
    {
      label: statusLabel(s.claude),
      submenu: [
        {
          label: s.claude.statusline ? '重装 statusline 采集' : '安装 statusline 采集',
          enabled: usable,
          click: () => a.install('statusline')
        },
        {
          label: s.claude.hooks ? '重装 hooks' : '安装 hooks',
          enabled: usable,
          click: () => a.install('hooks')
        },
        { type: 'separator' },
        {
          label: '全部卸载',
          enabled: usable && (s.claude.statusline || s.claude.hooks),
          click: () => a.install('uninstall-all')
        }
      ]
    },
    { label: '校准横向比例…', click: () => a.calibrate() },
    { label: '重置横向比例', click: () => a.resetPanelX() },
    { type: 'separator' },
    { label: '打开日志文件夹', click: () => a.openLogs() },
    { label: '退出', click: () => a.quit() }
  ]
}
