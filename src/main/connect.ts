/**
 * 「连接 ZCode」窗口（简报 §1）。托盘里唯一会打开第二个 webContents 的地方。
 *
 * 400×160，一行说明 + 一个密码型输入框 + 保存 / 取消。保存写进 macOS 钥匙串
 * （`agent-monitor` / `zcode-bigmodel`），**不落盘明文、不进日志、不进状态**。
 *
 * 安全（M1 复核 §2 的 P2「M4 加第二个 webContents 时记得校验 sender」）：
 *   · 这个窗口有自己的 preload，只暴露 save / cancel 两个方法；
 *   · 两个 IPC handler 都先比对 `event.sender`，不是这个窗口发的一律丢弃；
 *   · 窗口自己不导航、不开外链（setWindowOpenHandler + will-navigate 全 deny）。
 */

import { BrowserWindow, ipcMain } from 'electron'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CONNECT_CH } from '../shared/connect-ipc.js'
import type { ConnectResult } from '../shared/connect-ipc.js'
import { keychainTarget, readKeychain, writeKeychain } from './collectors/quota/keychain.js'
import { KEYCHAIN_ACCOUNT, KEYCHAIN_SERVICE } from './collectors/quota/zcode.js'

const here = dirname(fileURLToPath(import.meta.url))

/** 面板的画布色，窗口起来时不闪白 */
const BG = '#0d0d0d'

/** 钥匙串里到底有没有那一项 —— 托盘据此在「连接」与「更换」之间切文案。 */
export async function hasZcodeKey(): Promise<boolean> {
  const t = keychainTarget(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
  return (await readKeychain(t.service, t.account)) !== null
}

/**
 * 用户粘进来的那串东西能不能当 Key 用。
 *
 * 抽成纯函数是为了能测（M4 复核 §1.7）：这是本阶段安全等级最高的一段，
 * 原来它整个写死在 `ipcMain.handle` 的闭包里，从外面够不着，一条单测都没有。
 * 真正的闸门在 `writeKeychain` 里（它才贴着 `security -i`），这里负责的是
 * **给用户看的那句话** —— 同一条规则两处都有，是有意的纵深。
 */
export function validateKey(raw: unknown): { ok: true; key: string } | { ok: false; message: string } {
  if (typeof raw !== 'string') return { ok: false, message: 'Key 必须是文本' }
  const key = raw.trim()
  if (!key) return { ok: false, message: '请先粘贴 Key' }
  // 正则写转义形式：源码里留裸控制字符会让整个文件被当成二进制
  if (/[\u0000-\u001f\u007f]/.test(key)) {
    return { ok: false, message: 'Key 里有不可见字符，请重新复制' }
  }
  return { ok: true, key }
}

export type ConnectDeps = {
  rendererUrl?: string
  /** 保存成功后回调 —— 托盘据此刷新菜单，采集器据此立刻重采一轮 */
  onSaved?: () => void
}

let win: BrowserWindow | null = null
let registered = false
/**
 * 当前这一次打开传进来的 deps。
 * handler 只注册一次（窗口可以开关很多次），所以**不能**让它闭合住第一次的 deps
 * —— 那样第二次开窗时 `onSaved` 还是第一次那个闭包（M4 复核 §1.6）。
 * 现在每次 openConnectWindow 覆写这里，handler 读它。
 */
let current: ConnectDeps = {}

export function openConnectWindow(deps: ConnectDeps = {}): BrowserWindow {
  current = deps
  if (win && !win.isDestroyed()) {
    win.show()
    win.focus()
    return win
  }

  win = new BrowserWindow({
    width: 400,
    height: 160,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: '连接 ZCode',
    backgroundColor: BG,
    show: false,
    webPreferences: {
      preload: join(here, '../preload/connect.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  const w = win
  w.setMenuBarVisibility(false)
  w.once('ready-to-show', () => { w.show(); w.focus() })
  w.on('closed', () => { win = null })

  /* 这个窗口不该去任何地方。面板那边留了一条 https → 系统浏览器的路（新闻链接要用），
     这里**一条都不留**：它的 HTML 里没有任何链接，CSP 还是 default-src 'none'。
     给一个「只做一件事」的窗口留一条通向系统浏览器的路，没有收益只有面。 */
  w.webContents.setWindowOpenHandler(({ url }) => {
    console.warn(`[zcode] 连接窗口拦下开窗请求：${url.slice(0, 64)}`)
    return { action: 'deny' }
  })
  w.webContents.on('will-navigate', ev => ev.preventDefault())

  if (!registered) {
    registered = true
    /* sender 校验：`win` 是模块级的当前连接窗口，不是它发来的一律丢。
       handle 只注册一次（窗口可以开关很多次，handler 不能重复注册）。 */
    const fromConnectWindow = (sender: Electron.WebContents): boolean =>
      win !== null && !win.isDestroyed() && sender === win.webContents

    ipcMain.handle(CONNECT_CH.save, async (ev, key: unknown): Promise<ConnectResult> => {
      if (!fromConnectWindow(ev.sender)) return { ok: false, message: '来源不可信' }
      const v = validateKey(key)
      if (!v.ok) return { ok: false, message: v.message }
      const t = keychainTarget(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
      const ok = await writeKeychain(t.service, t.account, v.key, 'Agent Monitor · ZCode')
      // 日志里只有成败，没有 Key，也没有 Key 的长度
      console.log(`[zcode] Keychain 写入${ok ? '成功' : '失败'}（${t.service} / ${t.account}）`)
      if (ok) current.onSaved?.()
      return ok ? { ok: true } : { ok: false, message: '写入钥匙串失败，请在弹框里选「始终允许」后重试' }
    })

    ipcMain.on(CONNECT_CH.close, ev => {
      if (!fromConnectWindow(ev.sender)) return
      win?.close()
    })
  }

  if (deps.rendererUrl) void w.loadURL(`${deps.rendererUrl.replace(/\/$/, '')}/connect.html`)
  else void w.loadFile(join(here, '../renderer/connect.html'))

  return w
}

/** 退出前收摊（托盘 / will-quit 用） */
export function closeConnectWindow(): void {
  if (win && !win.isDestroyed()) win.close()
  win = null
}
