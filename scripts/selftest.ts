/**
 * 交互自检 —— 验收第 4 条的机械证据：全局快捷键、指示点、边缘区、手动暂停、新事件打断。
 * 由主进程在 MONITOR_SELFTEST=1 时调用（`pnpm selftest`），用 sendInputEvent 真按键真点击，
 * 再从渲染层读回 data-page，不靠肉眼。
 *
 * 它不是 design/verify.mjs 的替代品（那份跑的是版面与对比度断言），
 * 只覆盖「Electron 这一层的线接没接上」。
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { app, globalShortcut, Menu, screen } from 'electron'
import { CH } from '../src/shared/ipc.js'
import { SCENE_NAMES } from '../src/shared/types.js'
import type { AgentId, AgentStatus, MonitorCommand, Page } from '../src/shared/types.js'
import { collectCodex } from '../src/main/collectors/quota/codex.js'
import { createZcodeCollector } from '../src/main/collectors/quota/zcode.js'
import type { Store } from '../src/main/state.js'
import { CodexEvents } from '../src/main/collectors/events/codex.js'
import { ZcodeEvents, SQLITE } from '../src/main/collectors/events/zcode.js'
import { DEFAULT_TOKEN_FILE, hookPort, tokenFile } from '../src/main/collectors/events/claude.js'
import type { EventInput, EventSink } from '../src/main/collectors/events/types.js'
import { scaleFor } from '../src/shared/scale.js'
import { DEFAULT_CONFIG_FILE } from '../src/main/config.js'
import { fileIn, load } from '../src/main/collectors/events/persist.js'
import { closeConnectWindow, openConnectWindow } from '../src/main/connect.js'
import {
  deleteKeychain, keychainItemExists, keychainTarget, readKeychain
} from '../src/main/collectors/quota/keychain.js'

/** 自检发的指令：showPage 的 token 由 sendCommand 补，调用处不写。
 *  （Omit 作用在联合类型上会把分支压平，所以这里显式列出来。） */
type CommandInput =
  | Extract<MonitorCommand, { type: 'step' } | { type: 'home' }>
  | { type: 'showPage'; page: Page }

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

/** 连接窗口那段主动跳过时抛它 —— 与真正的失败区分开 */
class SkipConnectCheck extends Error {}

/**
 * 自检的截图一律落在 `design/shots/selftest/` 下（M4 修）。
 *
 * 原来它写的是 `design/shots/m2` 与 `design/shots/m3` —— 和 `pnpm shoot` 同一个目录。
 * 两条 lane 的产物于是互相覆盖，而且文件名与口径都不同：shoot 按 `page-<slug>-<态>` 命名、
 * 喂的是冻住的 fixtures；selftest 按 `page-<page>-<态>` 命名、跑的是真实采集之后的场景。
 * 谁最后跑谁说了算，交付截图因此会悄悄变成另一条 lane 的那一版。
 *
 * 归档用的交付截图由 `pnpm shoot`（七态对账）与 `MONITOR_SHOTS_LIVE_DIR`（真实六页）产出，
 * 这里的只是自检过程的留档。
 */
const shotDir = (sub: string): string => join(process.cwd(), 'design', 'shots', 'selftest', sub)

/** 当前页里有没有任何可见元素越出 .screen。.sr 是 1px 的屏幕阅读器锚点，按定义在框外。 */
/**
 * 当前页里有没有可见元素越出 .screen。
 *
 * 口径与 design/verify.mjs 一致（designer 第三次修正的那一条）：
 * **被 overflow:hidden 的祖先夹住的元素不算越界** —— 它的 rect 可以超出画布，
 * 但屏上被裁掉了，看不见。单行省略号就是这么实现的，按裸 rect 判会全员误报。
 * .sr 是 1px 的屏幕阅读器锚点，按定义在框外。
 */
const OVERFLOW_PROBE = `(() => {
  const box = document.querySelector('.screen').getBoundingClientRect()
  const pg = document.querySelector('.page[data-on="1"]')
  if (!pg) return ['(没有可见页)']
  const clipped = n => {
    for (let p = n.parentElement; p && p !== document.body; p = p.parentElement) {
      const o = getComputedStyle(p)
      if (o.overflowX !== 'visible' || o.overflowY !== 'visible') return true
    }
    return false
  }
  const bad = []
  pg.querySelectorAll('*').forEach(n => {
    if (n.classList.contains('sr') || n.closest('.sr')) return
    const r = n.getBoundingClientRect()
    if (!r.width && !r.height) return
    const out = r.bottom > box.bottom + 0.5 || r.right > box.right + 0.5 ||
                r.top < box.top - 0.5 || r.left < box.left - 0.5
    if (!out || clipped(n)) return
    bad.push((n.className && n.className.baseVal !== undefined ? 'svg' : n.className) || n.tagName)
  })
  return bad.slice(0, 4)
})()`

/**
 * 当前页里最小的可见字号。下限 14px（brief-m0-35.md：3.5 寸屏上 14px 是可读下界）。
 * 只看有文字内容的叶子节点 —— 空容器继承来的 font-size 不上屏。
 */
const MIN_FONT_PROBE = `(() => {
  const pg = document.querySelector('.page[data-on="1"]')
  if (!pg) return { px: 99, what: '(没有可见页)' }
  let min = 99, what = ''
  pg.querySelectorAll('*').forEach(n => {
    if (n.classList.contains('sr') || n.closest('.sr')) return
    if (n.children.length) return
    if (!(n.textContent || '').trim()) return
    const r = n.getBoundingClientRect()
    if (!r.width || !r.height) return
    const px = parseFloat(getComputedStyle(n).fontSize)
    if (px < min) { min = px; what = (n.className || n.tagName) + ':' + (n.textContent || '').trim().slice(0, 8) }
  })
  return { px: min, what }
})()`

type Result = { name: string; ok: boolean; detail: string }
const results: Result[] = []

function check(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail })
  console.log(`[selftest] ${ok ? 'PASS' : 'FAIL'} ${name} — ${detail}`)
}

const js = <T>(win: BrowserWindow, code: string): Promise<T> =>
  win.webContents.executeJavaScript(code) as Promise<T>

const page = (win: BrowserWindow): Promise<string> =>
  js<string>(win, 'document.documentElement.dataset.page')

async function clickAt(win: BrowserWindow, x: number, y: number): Promise<void> {
  win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
  win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
  await sleep(180)
}

async function centerOf(win: BrowserWindow, selector: string): Promise<{ x: number; y: number }> {
  return js(win, `(() => { const r = document.querySelector(${JSON.stringify(selector)})
    .getBoundingClientRect(); return {x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2)} })()`)
}

let token = 0
/** showPage 需要 token（截图脚本的握手），这里补上；自检不等回报，睡够切页动画即可 */
async function sendCommand(win: BrowserWindow, cmd: CommandInput): Promise<void> {
  const full = cmd.type === 'showPage' ? { ...cmd, token: ++token } : cmd
  win.webContents.send(CH.command, full)
  await sleep(360)
}

/** 首轮真实采样落地前，整块面板是骨架屏（没有事件行）。等它，别把等待读成回归。 */
async function waitForFirstSample(win: BrowserWindow, budgetMs: number): Promise<number> {
  const t0 = Date.now()
  while (Date.now() - t0 < budgetMs) {
    const done = await js<boolean>(win, 'document.getElementById("topLoading").hidden === true')
    if (done) return Date.now() - t0
    await sleep(500)
  }
  return -1
}

/**
 * 用户真实的 userData —— 自检自己写的是 MONITOR_USER_DATA 指向的临时目录，
 * 但「有没有碰过真实文件」与「拍出来的截图是不是真实历史」都要拿这个路径说话。
 * Electron 的 app.getPath('userData') 没有被改写，所以它仍然是真的那一个。
 */
const realUserData = (): string => app.getPath('userData')

/** 一个文件的内容指纹；不存在时返回 '(不存在)'。只用来证明「我们没碰过它」。 */
const fingerprint = async (file: string): Promise<string> => {
  try {
    return createHash('sha256').update(await readFile(file)).digest('hex').slice(0, 16)
  } catch {
    return '(不存在)'
  }
}

export async function runSelftest(win: BrowserWindow, store?: Store): Promise<boolean> {
  console.log('[selftest] 前提：副屏在位、⌃⌥←/→/↑ 未被其它 app 占用。' +
    '任一前提不成立时下面会有 FAIL，那不一定是代码回归。')

  /* 自检会往事件流里塞合成事件、会调 panelX、会生成 hook token —— 这些一律不许落在
     用户真实的文件上。实机 C1 页上出现过「selftest · ZCode 任务」那样的行，
     就是隔离没做全。开头记指纹、结尾再比一次，把「没有副作用」变成断言而不是承诺。 */
  const REAL_EVENTS = fileIn(realUserData())
  const guarded = [REAL_EVENTS, DEFAULT_CONFIG_FILE, DEFAULT_TOKEN_FILE]
  const guardBefore = await Promise.all(guarded.map(fingerprint))

  await sleep(1200)

  // 0.0 · 首轮真实采样（M2 验收 1 的机械证据）。codexbar 冷启动实测 3 s 出头，
  // 预算给到 60 s —— 简报要求的就是「60 s 内出现真实数字」。
  const sampledIn = await waitForFirstSample(win, 60_000)
  /* ==========================================================================
     应用菜单里不能有关窗口的路（M4 复核 P1-③）。
     不设菜单时挂的是 Electron 默认菜单，⌘W 会把面板关掉 —— 对一个 24/7
     没人盯着的监视器来说，最糟的失败形态就是它安静地整个消失。
     ⌘Q 要留着（那是有意的退出路径），⌘V 也要留着（连接 ZCode 的输入框要粘贴）。
     ========================================================================== */
  {
    const menu = Menu.getApplicationMenu()
    const flat: Array<{ label: string; accel: string; role: string }> = []
    const walk = (items: Electron.MenuItem[]): void => {
      for (const it of items) {
        flat.push({
          label: it.label || '', accel: it.accelerator || '', role: String(it.role ?? '')
        })
        if (it.submenu) walk(it.submenu.items)
      }
    }
    if (menu) walk(menu.items)
    const has = (r: string): boolean => flat.some(x => x.role.toLowerCase() === r)
    const closers = flat.filter(x =>
      ['close', 'toggledevtools', 'reload', 'forcereload'].includes(x.role.toLowerCase()))
    check('应用菜单里没有 ⌘W / DevTools / 重载，⌘Q 与粘贴仍在',
      !!menu && closers.length === 0 && has('quit') && has('paste'),
      menu
        ? `顶级 ${menu.items.map(i => i.label || i.role).join(' / ')} · ` +
          `关窗类 ${closers.length ? closers.map(c => c.role).join(',') : '无'} · ` +
          `quit=${has('quit')} paste=${has('paste')}`
        : '没有设置应用菜单（挂的是 Electron 默认菜单，带 ⌘W）')
  }

  /* ==========================================================================
     窗口有没有**逐像素**铺满目标显示器。
     两条独立证据，缺一不可：
       · `win.getBounds()` 与 display.bounds 完全相等（Electron 侧的账）；
       · `capturePage()` 出来的位图尺寸 = bounds × scaleFactor（真正画出来的像素数）。
     只看第一条不够 —— 它是「我们要求的」；第二条才是「实际渲染出来的」。
     补这一条的由头：外部用 CGWindowList 量到窗口比屏幕小约 2%。那个数字**不可信**，
     四块屏上任何带内容的窗口都会被它报小 ~2%（内建 1728→1694、Mi 1920→1882、
     TYPE-C 960→942），内容图层一撤掉立刻回到准确值。真正说话的是这里的位图尺寸。
     ========================================================================== */
  {
    const target = screen.getAllDisplays().find(d => (d.label || '').toUpperCase().includes('TYPE-C'))
    const b = win.getBounds()
    if (!target) {
      check('窗口逐像素铺满目标显示器', true, '副屏不在，跳过（回落主屏窗口是另一条路）')
    } else {
      const g = target.bounds
      const exact = b.x === g.x && b.y === g.y && b.width === g.width && b.height === g.height
      const img = (await win.webContents.capturePage()).getSize()
      const wantW = g.width * target.scaleFactor
      const wantH = g.height * target.scaleFactor
      const pixels = img.width === wantW && img.height === wantH
      check('窗口逐像素铺满目标显示器（bounds 相等 + 位图尺寸 = bounds × 倍率）',
        exact && pixels && win.isSimpleFullScreen(),
        `win=${b.width}x${b.height}@${b.x},${b.y} 目标=${g.width}x${g.height}@${g.x},${g.y} ` +
        `位图=${img.width}x${img.height}（应为 ${wantW}x${wantH}） fullscreen=${win.isSimpleFullScreen()}`)
    }
  }

  check('首轮真实采样落地（骨架屏退场）', sampledIn >= 0,
    sampledIn >= 0 ? `${sampledIn}ms` : '60 s 内仍是骨架屏')

  // 0 · 首帧状态真的到了渲染层。
  // 曾经的 P0：唯一一次 send 发生在 mw.load() 之前，落在 about:blank 上，面板全黑。
  // 判据取 DOM 而不是内部计数器：三块瓦片 + 至少一行事件，只有 state 到了才画得出来。
  const tiles = await js<number>(win, 'document.querySelectorAll("#paTiles .tile").length')
  // M3 起事件是真采集的：这一程可能一条历史都没有（临时 userData），
  // 所以判据是「C1 画出了东西」——行、骨架屏或空态文案，三者有其一即可。
  const c1 = await js<number>(win, 'document.getElementById("pc1Feed").children.length')
  const startPage = await page(win)
  check('首帧 state 已到渲染层', tiles === 3 && c1 > 0, `瓦片 ${tiles} · C1 子节点 ${c1}`)
  // 首帧里本来就有一条未读，不该被当成「新事件」而跳 C 页
  check('首帧不被既有未读事件打断', startPage === 'a', `起始页 ${startPage}`)

  // 1 · 全局快捷键：注册成功 + 它发出的那条指令真的切了页
  const accels = ['Control+Alt+Left', 'Control+Alt+Right', 'Control+Alt+Up']
  const registered = accels.filter(a => globalShortcut.isRegistered(a))
  check('全局快捷键已注册', registered.length === 3, `${registered.length}/3 → ${registered.join(' ')}`)

  await sendCommand(win, { type: 'showPage', page: 'a' })
  await sendCommand(win, { type: 'step', dir: 1 })
  const afterRight = await page(win)
  await sendCommand(win, { type: 'step', dir: 1 })
  const afterRight2 = await page(win)
  await sendCommand(win, { type: 'home' })
  const afterHome = await page(win)
  check('⌃⌥→ / ⌃⌥↑ 切页', afterRight === 'b' && afterRight2 === 'c1' && afterHome === 'a',
    `a →${afterRight} →${afterRight2}，↑ → ${afterHome}`)

  // 2 · 点击指示点直接跳页
  const dotC = await centerOf(win, '#dots button[data-p="c1"]')
  await clickAt(win, dotC.x, dotC.y)
  const afterDot = await page(win)
  check('点击指示点跳页', afterDot === 'c1', `点 (${dotC.x},${dotC.y}) → ${afterDot}`)

  // 3 · 手动切页后轮播暂停：‖ 标记出现，且 token 是 120s
  const holdVisible = await js<boolean>(win, '!document.getElementById("holdmark").hidden')
  const holdToken = await js<string>(win,
    'getComputedStyle(document.documentElement).getPropertyValue("--manual-hold").trim()')
  check('手动后轮播暂停', holdVisible && holdToken === '120s', `‖=${holdVisible} --manual-hold=${holdToken}`)

  // 4 · 边缘区切页（左侧 = 上一页）
  const edge = await centerOf(win, '.edge[data-side="prev"]')
  await clickAt(win, edge.x, edge.y)
  const afterEdge = await page(win)
  check('点击边缘区切页', afterEdge === 'b', `c1 上一页 → ${afterEdge}`)

  // 5 · 新事件打断：手动暂停期间仍然跳 C 并解除暂停
  await js(win, 'window.monitor.dev.simulateEvent()')
  await sleep(400)
  const afterEvent = await page(win)
  const holdAfterEvent = await js<boolean>(win, '!document.getElementById("holdmark").hidden')
  check('新事件打断手动暂停（跳 C1）', afterEvent === 'c1' && !holdAfterEvent,
    `→ ${afterEvent}，‖=${holdAfterEvent}`)

  // 6 · attention 接管整屏，且接管期间手动切不走
  await js(win, 'window.monitor.dev.simulateAttention()')
  await sleep(400)
  const inAttn = await page(win)
  await sendCommand(win, { type: 'step', dir: 1 })
  const stillAttn = await page(win)
  check('attention 接管且切不走', inAttn === 'attn' && stillAttn === 'attn',
    `→ ${inAttn}，按 → 之后仍是 ${stillAttn}`)

  await js(win, 'window.monitor.dev.clearAttention()')
  await sleep(400)
  const afterClear = await page(win)
  check('解除 attention 回 A', afterClear === 'a', `→ ${afterClear}`)

  // 6.5 · ack 之后焦点要还给同一行（原型有 again.focus()，移植时掉过）
  await sendCommand(win, { type: 'showPage', page: 'c1' })
  const acked = await js<string>(win, `(() => {
    const row = document.querySelector('#pc1Feed .row[data-unread="1"]')
    if (!row) return ''
    row.focus()
    row.click()
    return row.dataset.id
  })()`)
  await sleep(500)
  const focusedId = await js<string>(win,
    'document.activeElement && document.activeElement.dataset ? (document.activeElement.dataset.id || "") : ""')
  check('ack 之后焦点留在同一行', !!acked && focusedId === acked,
    acked ? `ack ${acked} → 焦点 ${focusedId || '<body>'}` : '这一帧没有未读行可点')

  // 6.6 · 真实采集对照（M2 验收 2）：屏上的数字必须等于此刻直接问来源拿到的数字。
  // 对照的是「当场再采一次」而不是内部状态 —— 后者只能证明渲染层没写错，
  // 证明不了采集层解析对了。
  const tiles3 = await js<Array<{ label: string; num: string; msg: string; stale: string }>>(win, `(() => {
    return [...document.querySelectorAll('#paTiles .tile')].map(t => ({
      label: t.getAttribute('aria-label') || '',
      num: (t.querySelector('.a-nums .num') || {}).textContent || '',
      msg: (t.querySelector('.msg-head span') || {}).textContent || '',
      stale: (t.querySelector('[data-stale]') || {}).textContent || ''
    }))
  })()`)
  check('三块瓦片按 codex / claude / zcode 排列', tiles3.length === 3 &&
    !!tiles3[0]?.label.startsWith('Codex') && !!tiles3[1]?.label.startsWith('Claude') &&
    !!tiles3[2]?.label.startsWith('ZCode'), tiles3.map(t => t.label).join(' | '))

  const shown = (i: number): string => tiles3[i]?.num || `（${tiles3[i]?.msg || '空'}）`
  const ac = new AbortController()
  const fresh: Partial<Record<AgentId, string>> = {}
  try {
    const r = await collectCodex(ac.signal)
    fresh.codex = r.ok ? String(r.windows[0]?.usedPercent ?? '') : `（${r.code}）`
  } catch (err) { fresh.codex = `（抛出 ${String(err)}）` }
  try {
    const r = await createZcodeCollector()(ac.signal)
    fresh.zcode = r.ok ? String(r.windows[0]?.usedPercent ?? '') : `（${r.code}）`
  } catch (err) { fresh.zcode = `（抛出 ${String(err)}）` }

  check('Codex 瓦片 = codexbar 当场返回', shown(0) === fresh.codex,
    `瓦片 ${shown(0)} · codexbar ${fresh.codex}`)
  check('ZCode 瓦片 = 智谱 quota/limit 当场返回', shown(2) === fresh.zcode,
    `瓦片 ${shown(2)} · 接口 ${fresh.zcode}`)
  // Claude 的主来源是 statusline tee 落的文件。tee 还没装时没有文件，OAuth 兜底今天
  // 在本机必 429 / 无 token —— 那时瓦片应当是这三种里的一种，而不是假数字。
  const claudeOk = !!tiles3[1]?.num ||
    ['还没接入 statusline', '接口限流 429', '额度接口 401', '网络不可达'].includes(tiles3[1]?.msg ?? '')
  check('Claude 瓦片要么是真数字要么是可解释的空/错态', claudeOk,
    `${shown(1)}${tiles3[1]?.stale ? ' · ' + tiles3[1].stale : ''}`)

  // 6.65 · 真实数字的肉眼证据（M2 验收 2 的截图部分）。数字与倒计时之外画面上没有别的，
  // 不会有凭据进图。
  try {
    const dir = shotDir('quota')
    await mkdir(dir, { recursive: true })
    for (const p of ['a', 'b'] as const) {
      await sendCommand(win, { type: 'showPage', page: p })
      await sleep(300)
      await writeFile(join(dir, `live-page-${p}.png`), (await win.webContents.capturePage()).toPNG())
    }
    check('真实额度截图已出图', true, `${dir}/live-page-{a,b}.png`)
  } catch (err) {
    check('真实额度截图已出图', false, String(err))
  }

  // 6.7 · 断网与「未连接」（M2 验收 3、4）。
  // 不动系统网络设置、也不动真的 Keychain 项：dev.forceError 把下一轮采集短路成指定失败码，
  // 走的是与真实失败**同一条**映射与合并路径（collectors → Store.mergeQuota → 渲染层）。
  const zcodeTile = `(() => {
    const t = document.querySelectorAll('#paTiles .tile')[2]
    return {
      num: (t.querySelector('.a-nums .num') || {}).textContent || '',
      msg: (t.querySelector('.msg-head span') || {}).textContent || '',
      stale: (t.querySelector('[data-stale]') || {}).textContent || '',
      off: !!t.querySelector('.iddot[data-off]')
    }
  })()`
  type TileProbe = { num: string; msg: string; stale: string; off: boolean }
  const probeZcode = (): Promise<TileProbe> => js<TileProbe>(win, zcodeTile)
  const force = async (code: string | null, waitMs = 1500): Promise<TileProbe> => {
    await js(win, `window.monitor.dev.forceError('zcode', ${code === null ? 'null' : `'${code}'`})`)
    await sleep(waitMs)
    return probeZcode()
  }

  const before = await probeZcode()
  const offline = await force('network')
  check('断网：数字留着标 stale，身份点熄灭', 
    !!before.num && offline.num === before.num && /分钟|小时|天/.test(offline.stale) && offline.off,
    `${offline.num || '(无数字)'} · ${offline.stale || '(无 stale 标)'} · 身份点${offline.off ? '灭' : '亮'}`)

  // stale 那一格比原来的「后重置」长，A 页瓦片只有 141px —— 两页各量一遍最坏情况。
  // 最坏情况：A 页短形「59 分钟前」、B 页完整句「数据 23 小时前」。两页各量一遍。
  const worst = async (page: Page, text: string, sel: string): Promise<string[]> => {
    await sendCommand(win, { type: 'showPage', page })
    await js(win, `(() => {
      const n = document.querySelector(${JSON.stringify(sel)})
      if (n) n.textContent = ${JSON.stringify(text)}
    })()`)
    return js<string[]>(win, OVERFLOW_PROBE)
  }
  const badA = await worst('a', '59 分钟前', '#paTiles .tile [data-stale]')
  const badB = await worst('b', '数据 23 小时前', '#pbBands .tile [data-stale]')
  check('stale 标记在 480×270 下不撑破版面', badA.length === 0 && badB.length === 0,
    badA.length || badB.length ? `A:${badA.join(',')} B:${badB.join(',')}` : 'A「59 分钟前」B「数据 23 小时前」都在框内')

  const noKey = await force('missing_key')
  check('Keychain 无此项：ZCode 变「未连接」，旧数字不再挂着', 
    noKey.msg === '未连接' && !noKey.num,
    `${noKey.msg || '(无文案)'}${noKey.num ? ' · 仍显示 ' + noKey.num : ''}`)

  const restored = await force(null, 2500)
  check('解除模拟后自动恢复真实数字', restored.num === before.num && !restored.stale,
    `${restored.num || '(无数字)'} ← 原 ${before.num}`)

  /* ==========================================================================
     REVISION 7（原型 2026-09-14）· 额度条改用各家身份色，阈值不再重绘整条。
     这三条量的是**计算样式**，不是 class：CSS 变量链断了一环（比如 tokens 少了
     --quota-fill-zcode、或者瓦片没带 --fill），class 照样在，颜色却回落成透明。
     它们要切 fixtures 场景，所以只在 store 在手时跑（截图模式不传 store）。
     ========================================================================== */
  if (store) {
    store.setScene('populated')
    await sleep(200)
    await sendCommand(win, { type: 'showPage', page: 'b' })
    await sleep(120)
    const fills = await js<Array<{ id: string; used: string; ident: string }>>(win, `
      (() => {
        const ids = ['codex','claude','zcode']
        return [...document.querySelectorAll('.page-b .tile')].map((t, i) => {
          const used = t.querySelector('.band .used')
          const cs = used ? getComputedStyle(used).backgroundColor : ''
          const ident = getComputedStyle(document.documentElement)
            .getPropertyValue('--id-' + ids[i]).trim()
          return { id: ids[i], used: cs, ident }
        })
      })()`)
    // 三条填充必须两两不同、都不是 accent 白、且分别等于该家的身份色
    const rgb = await js<Record<string, string>>(win, `
      (() => {
        const out = {}
        const probe = document.createElement('span')
        document.body.appendChild(probe)
        for (const id of ['codex','claude','zcode']) {
          probe.style.color = getComputedStyle(document.documentElement)
            .getPropertyValue('--id-' + id).trim()
          out[id] = getComputedStyle(probe).color
        }
        probe.remove()
        return out
      })()`)
    // 两边都经过浏览器解析成 rgb() 字符串，可以直接比
    const same = fills.filter(f => f.used === rgb[f.id]).length
    const distinct = new Set(fills.map(f => f.used)).size
    check('B 页三条填充分别等于各自身份色，且三色互不相同',
      same === 3 && distinct === 3,
      fills.map(f => `${f.id}=${f.used}`).join(' '))
  }

  if (store) {
    /* edge 场景里有 ≥80% 与 ≥95% 的窗口 —— 阈值信号必须在颜色之外还有一个形状：
       .b-alert 图标 + aria-label。只把数字改成黄/红是纯颜色信号（WCAG 1.4.1）。 */
    store.setScene('edge')
    await sleep(200)
    await sendCommand(win, { type: 'showPage', page: 'b' })
    await sleep(120)
    const alerts = await js<Array<{ label: string; level: string; fill: string }>>(win, `
      [...document.querySelectorAll('.page-b .tile')].map(t => ({
        level: t.dataset.level || '',
        label: t.querySelector('.b-alert')?.getAttribute('aria-label') || '',
        fill: (() => { const u = t.querySelector('.band .used')
          return u ? getComputedStyle(u).backgroundColor : '' })()
      }))`)
    const flagged = alerts.filter(a => a.level === 'warn' || a.level === 'danger')
    const labelled = flagged.filter(a =>
      a.label === (a.level === 'danger' ? '余量吃紧' : '余量偏紧'))
    // 同时确认：吃紧的那条填充**没有**被重绘成红/黄（身份色仍在）
    const okColour = flagged.every(a => a.fill && a.fill !== 'rgb(255, 97, 97)' && a.fill !== 'rgb(255, 197, 51)')
    check('edge：吃紧/偏紧的瓦片带 .b-alert 与 aria-label，填充仍是身份色',
      flagged.length > 0 && labelled.length === flagged.length && okColour,
      flagged.length
        ? flagged.map(a => `${a.level}:${a.label || '(缺 aria-label)'}:${a.fill}`).join(' ')
        : '（edge 场景里没有 ≥80% 的窗口，这条失去意义）')
  }

  if (store) {
    /* 回归 · D 页在 edge 场景下不再抛。
       原来 `dataStateFor` 对 edge 无条件返回 'edge'，而 edge 那份 fixtures 没有 usage，
       紧接着的 `scene.usage!` 每次都抛 `reading 'days'`，整轮 onState 就此中断 ——
       D 页留着上一个场景的内容，指示点数量也停在上一轮。 */
    store.setScene('error')
    await sleep(150)
    await sendCommand(win, { type: 'showPage', page: 'd' })
    await sleep(120)
    store.setScene('edge')
    await sleep(200)
    await sendCommand(win, { type: 'showPage', page: 'd' })
    await sleep(150)
    const d = await js<{ text: string; cells: number; dots: number }>(win, `
      ({ text: (document.getElementById('pdHeat')?.textContent || '').trim(),
         cells: document.querySelectorAll('#pdHeat .cell[data-date]').length,
         dots: document.querySelectorAll('#dots button').length })`)
    /* 判据是「D 页画的是**它自己这一轮**的东西」，不绑死在具体哪一种：
       有 usage 就该出格子，没有就该出空态 —— 两者都对；错的是留着上一个场景
       （error）那句「用量数据读取失败」，那说明这一轮的渲染根本没跑完。
       这么写是为了不被 fixtures 牵着走：原型刚把 edge 从「空态」改成
       「一天远超其余」的离群帧，等那份 fixtures 移植进来，这条不该跟着变红。 */
    const own = d.cells > 0 || d.text.includes('还没有用量数据')
    check('回归：edge 场景下 D 页画的是自己这一轮，不是上一个场景的残留',
      own && !d.text.includes('读取失败'),
      `${d.cells} 个格子 · ${d.text.slice(0, 20)} · 指示点 ${d.dots}`)
    /* 切回 live —— 上面三段都把 store 推进了 scene 模式，不还原的话
       后面整个 M3 事件段收不到任何真实事件（实测：四条全红）。 */
    store.setLive()
    await sleep(200)
  }

  /* ==========================================================================
     M4 ·「连接 ZCode」窗口：托盘 → 小窗 → 钥匙串 这条路走一遍**真的**。
     service / account 用临时名（MONITOR_KEYCHAIN_SERVICE），
     **绝不碰真实的 agent-monitor / zcode-bigmodel**；跑完就删。
     这条盯的是两个只有整条路跑起来才暴露的失败：
       · 沙箱 preload 被 rollup 拆成 chunks → window.connectApi 根本不存在；
       · sender 校验写错 → 保存静默失败。
     ========================================================================== */
  {
    const SERVICE = 'agent-monitor-selftest'
    const ACCOUNT = 'zcode-probe'
    const before = { s: process.env['MONITOR_KEYCHAIN_SERVICE'], a: process.env['MONITOR_KEYCHAIN_ACCOUNT'] }
    process.env['MONITOR_KEYCHAIN_SERVICE'] = SERVICE
    process.env['MONITOR_KEYCHAIN_ACCOUNT'] = ACCOUNT
    // 带空格与引号，顺便把 security -i 的转义也验了
    const PROBE = 'selftest.' + Date.now() + ' a"b\\c'
    try {
      /* 保险丝（M4 P1-② 的直接后果）：项名覆盖在打包产物里是**关掉**的，
         所以这段如果跑在打包版里，下面那一次保存会写进**用户真实的**
         agent-monitor / zcode-bigmodel，把他的 Key 冲掉。
         所以先确认覆盖真的生效了，没生效就整段不跑 —— 宁可少一条断言。 */
      const t = keychainTarget('agent-monitor', 'zcode-bigmodel')
      if (t.service !== SERVICE || t.account !== ACCOUNT) {
        check('连接 ZCode：小窗保存 → 钥匙串读回逐字相同（临时项，不碰真实 Key）', true,
          `跳过：项名覆盖未生效（打包产物里按设计关闭），不能在真实项上做写入测试。` +
          `实际会写到 ${t.service}/${t.account}`)
        throw new SkipConnectCheck()
      }
      await deleteKeychain(SERVICE, ACCOUNT)   // 上一程留下的残余
      const cw = openConnectWindow({ rendererUrl: process.env['ELECTRON_RENDERER_URL'] })
      await new Promise<void>(r => {
        if (!cw.webContents.isLoading()) return r()
        cw.webContents.once('did-finish-load', () => r())
      })
      await sleep(300)
      const bridge = await cw.webContents.executeJavaScript(
        `typeof window.connectApi?.save === 'function' && typeof window.connectApi?.close === 'function'`
      ) as boolean
      // 直接填框 + 点「保存」，走的是用户真的会走的那条路
      await cw.webContents.executeJavaScript(`(() => {
        const i = document.getElementById('key')
        i.value = ${JSON.stringify(PROBE)}
        document.getElementById('save').click()
        return true
      })()`)
      let back: string | null = null
      for (let i = 0; i < 25 && back !== PROBE; i++) {
        await sleep(200)
        back = await readKeychain(SERVICE, ACCOUNT)
      }
      check('连接 ZCode：小窗保存 → 钥匙串读回逐字相同（临时项，不碰真实 Key）',
        bridge && back === PROBE,
        bridge ? (back === PROBE ? `${SERVICE}/${ACCOUNT} 往返一致` : `读回 ${back === null ? 'null' : '不一致'}`)
          : 'window.connectApi 不存在（preload 没加载起来）')
      await deleteKeychain(SERVICE, ACCOUNT)
      const gone = await readKeychain(SERVICE, ACCOUNT)
      // 真实那一项只问「在不在」，不取明文 —— 取明文会弹授权框，也没必要（复核 §7.4）
      const realStillThere = await keychainItemExists('agent-monitor', 'zcode-bigmodel')
      check('连接 ZCode：临时钥匙串项已清干净，真实项未被触碰',
        gone === null && realStillThere,
        gone === null ? `临时项已删，真实项${realStillThere ? '仍在' : '不见了！'}` : '临时项没删掉')
      closeConnectWindow()
      await sleep(200)
    } catch (err) {
      if (!(err instanceof SkipConnectCheck)) {
        check('连接 ZCode：小窗保存 → 钥匙串读回逐字相同（临时项，不碰真实 Key）', false, String(err))
      }
    } finally {
      if (before.s === undefined) delete process.env['MONITOR_KEYCHAIN_SERVICE']
      else process.env['MONITOR_KEYCHAIN_SERVICE'] = before.s
      if (before.a === undefined) delete process.env['MONITOR_KEYCHAIN_ACCOUNT']
      else process.env['MONITOR_KEYCHAIN_ACCOUNT'] = before.a
      // 小窗抢过焦点，把面板还回去，后面的键盘相关检查才不会莫名其妙
      win.focus()
      await sleep(200)
    }
  }

  /* ==========================================================================
     M3 · 事件采集（简报「测试」一节的四条 selftest）。
     三家各用一份**临时**数据源，不动 ~/.codex 与 ~/.zcode：验的是
     「解析 → Feed → IPC → C 页」这整条路，而不是本机此刻恰好有什么历史。
     Claude 那一条打的是**正在跑的那个** hook 服务器（真端口、真 token），
     因为它本来就是这条路上唯一没法用临时目录替代的一环。
     ========================================================================== */
  if (store) {
    const sink: EventSink = {
      emit: (e: EventInput) => { store.ingestEvent(e, true) },
      status: (a: AgentId, st: AgentStatus) => { store.setEventStatus(a, st) },
      log: () => {}
    }
    /** C 页上这条 id 的行在不在、是不是未读 */
    const rowOf = (id: string): Promise<{ found: boolean; unread: boolean }> => js(win, `(() => {
      const r = document.querySelector('.feed .row[data-id=' + JSON.stringify(${JSON.stringify(id)}) + ']')
      return { found: !!r, unread: !!r && r.dataset.unread === '1' }
    })()`)
    /** 等到这条行出现，返回用时；超时返回 −1 */
    const waitRow = async (id: string, budgetMs: number): Promise<number> => {
      const t0 = Date.now()
      while (Date.now() - t0 < budgetMs) {
        if ((await rowOf(id)).found) return Date.now() - t0
        await sleep(100)
      }
      return -1
    }

    // M3-1 · Codex：往临时 rollout 文件追加一条 task_complete
    try {
      const dir = await mkdtemp(join(tmpdir(), 'selftest-codex-'))
      // session id 每轮都换：固定 id 会和上一轮落盘的历史撞上，被去重挡掉之后
      // 这条断言就变成「上一轮的行还在不在」，而不是「这一轮采到没有」
      const sid = '01a08ac2-a8b0-7e01-8a3a-' + String(Date.now()).padStart(12, '0')
      const file = join(dir, `rollout-2026-09-14T10-00-00-${sid}.jsonl`)
      const line = (o: unknown): string => JSON.stringify(o) + '\n'
      await writeFile(file,
        line({
          timestamp: new Date().toISOString(), type: 'session_meta',
          payload: { session_id: sid, cwd: dir, originator: 'codex_exec' }
        }) +
        line({
          timestamp: new Date().toISOString(), type: 'event_msg',
          payload: { type: 'user_message', message: 'selftest · 追加一条完成事件' }
        }))
      const c = new CodexEvents(sink, dir)
      await c.start()   // 回灌（上面两行以已读进列表）
      await appendFile(file, line({
        timestamp: new Date().toISOString(), type: 'event_msg',
        payload: {
          type: 'task_complete', turn_id: 'selftest-turn-' + Date.now(),
          last_agent_message: 'selftest 完成', error: null, duration_ms: 42_000
        }
      }))
      await c.tick()
      const id = store.get().events.find(e => e.sessionId === sid && e.kind === 'completed')?.id ?? ''
      const ms = id ? await waitRow(id, 2_000) : -1
      const row = await rowOf(id)
      c.stop()
      check('Codex：追加 task_complete 后 2 s 内 C 页出现新行且未读',
        ms >= 0 && row.unread, ms >= 0 ? `${ms}ms，未读=${row.unread}` : '2 s 内没出现')
    } catch (err) {
      check('Codex：追加 task_complete 后 2 s 内 C 页出现新行且未读', false, String(err))
    }

    // M3-2 · ZCode：对临时 sqlite 改一行状态
    try {
      const db = join(await mkdtemp(join(tmpdir(), 'selftest-zcode-')), 'tasks-index.sqlite')
      execFileSync(SQLITE, [db, `create table tasks (workspace_key text, task_id text,
        title text, task_status text, model text, workspace_path text, updated_at integer,
        deleted integer default 0, primary key (workspace_key, task_id));
        insert into tasks values ('w','selftest-task','selftest · ZCode 任务','running',
          'builtin:bigmodel-coding-plan/GLM-5.3-Flash','/tmp/w',${Date.now()},0);`])
      const z = new ZcodeEvents(sink, db, 60_000)
      await z.start()
      const at = Date.now() + 1000
      execFileSync(SQLITE, [db,
        `update tasks set task_status='completed', updated_at=${at} where task_id='selftest-task'`])
      await z.tick()
      const id = `zcode:selftest-task:${at}`
      const ms = await waitRow(id, 3_000)
      const row = await rowOf(id)
      z.stop()
      check('ZCode：改一行状态后 3 s 内 C 页出现新行且未读',
        ms >= 0 && row.unread, ms >= 0 ? `${ms}ms，未读=${row.unread}` : '3 s 内没出现')
    } catch (err) {
      check('ZCode：改一行状态后 3 s 内 C 页出现新行且未读', false, String(err))
    }

    // M3-3 · Claude：往正在跑的回环端口 POST 一条带 token 的 Stop
    try {
      const token = (await readFile(tokenFile(), 'utf8')).trim()
      const url = `http://127.0.0.1:${hookPort()}/hook`
      const post = (body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
        fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-monitor-token': token, ...headers },
          body: JSON.stringify(body)
        })

      const bad = await post({ hook_event_name: 'Stop', session_id: 's' }, { 'x-monitor-token': 'nope' })
      const missing = await post({ session_id: 'selftest' })
      check('hook 服务器拒绝伪造与畸形请求', bad.status === 401 && missing.status === 400,
        `错 token → ${bad.status}，缺字段 → ${missing.status}`)

      const ok = await post({
        hook_event_name: 'Stop', session_id: 'selftest-session', cwd: '/tmp/w'
      })
      // 判据不能是「行数变多」：C 页只画 4 行（1 放大 + 3），满了之后再来一条行数不变。
      // 按 id 找 —— 这条必须真的进了状态，并且真的画在了 C 页顶部。
      let id = ''
      const t0 = Date.now()
      while (Date.now() - t0 < 2_000) {
        id = store.get().events.find(e => e.sessionId === 'selftest-session')?.id ?? ''
        if (id) break
        await sleep(100)
      }
      const ms = id ? await waitRow(id, 2_000) : -1
      const row = id ? await rowOf(id) : { found: false, unread: false }
      check('Claude：POST 一条带 token 的 Stop → 2 s 内 C 页出现该会话的行且未读',
        ok.status === 204 && ms >= 0 && row.unread,
        `${ok.status}，${id || '状态里没有这条'}${ms >= 0 ? ` ${ms}ms 上屏，未读=${row.unread}` : ''}`)
    } catch (err) {
      check('Claude：POST 一条带 token 的 Stop → 2 s 内 C 页多出一行', false, String(err))
    }

    /* M3 复核 §6.3 · `esc()` 是一道真实的安全边界，之前没有任何用例守着。
       M3 之后渲染层吃的是**用户能写的任意文本**（prompt、会话摘要、cwd 路径），
       下一个往 rowHTML 里加字段的人漏掉 esc()，不会有任何东西变红。
       这一条把整条路走完：transcript 里的一句 prompt → 采集 → 状态 → C 页 DOM。 */
    try {
      const sid = 'selftest-xss-' + Date.now()
      const PAYLOAD = '<img src=x onerror="document.title=\'PWNED\'">'
      const tdir = await mkdtemp(join(tmpdir(), 'selftest-xss-'))
      const tpath = join(tdir, 'transcript.jsonl')
      await writeFile(tpath, [
        JSON.stringify({ type: 'user', message: { content: `修一下 ${PAYLOAD} 这个` } }),
        JSON.stringify({ type: 'assistant', message: { content: `<script>alert(1)</script> 好了` } })
      ].join('\n') + '\n')

      const token = (await readFile(tokenFile(), 'utf8')).trim()
      const titleBefore = await js<string>(win, 'document.title')
      const res = await fetch(`http://127.0.0.1:${hookPort()}/hook`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-monitor-token': token },
        body: JSON.stringify({
          hook_event_name: 'Stop', session_id: sid,
          cwd: '/tmp/<b>cwd</b>', transcript_path: tpath
        })
      })
      let id = ''
      const t0 = Date.now()
      while (Date.now() - t0 < 2_000 && !id) {
        id = store.get().events.find(e => e.sessionId === sid)?.id ?? ''
        if (!id) await sleep(100)
      }
      if (id) await waitRow(id, 2_000)
      await sendCommand(win, { type: 'showPage', page: 'c1' })
      await sleep(200)

      const probe = await js<{
        injected: number; title: string; text: string; raw: boolean
      }>(win, `(() => {
        const feed = document.getElementById('pc1Feed')
        return {
          /* 只在事件区里数：页面本身有 <script type="module">，
             对着 document 数会恒为非零，这条断言就永远红。
             <b> 也算证据 —— cwd 里那对 <b> 标签如果变成了元素，说明没过 esc()。 */
          injected: feed ? feed.querySelectorAll('img, script, iframe, object, embed, b').length : -1,
          title: document.title,
          text: feed ? feed.textContent : '',
          // 尖括号必须是**文本**：innerHTML 里应当是 &lt;img，而不是一个 <img 标签
          raw: !!feed && feed.innerHTML.includes('&lt;img src=x')
        }
      })()`)

      const ok = res.status === 204 && !!id && probe.injected === 0 &&
        probe.title === titleBefore && probe.raw &&
        probe.text.includes('<img src=x onerror=')
      check('C 页把不可信文本当文本渲染：注入的标签没有变成元素（复核 §6.3）', ok,
        `注入元素 ${probe.injected} 个 · document.title ${probe.title === titleBefore ? '未被改写' : '被改写了！'}` +
        ` · 尖括号${probe.raw ? '已转义' : '未转义'}`)
    } catch (err) {
      check('C 页把不可信文本当文本渲染：注入的标签没有变成元素（复核 §6.3）', false, String(err))
    }

    // M3-4 · 重启语义：恢复之后全部已读，且同 id 不会再被当成新事件
    const unreadBefore = store.unread()
    const snapshot = store.get().events
    store.restoreEvents(snapshot)
    const unreadAfter = store.unread()
    const first = snapshot[0]
    const again = first ? store.ingestEvent(first, true) : null
    check('重启后历史事件全部已读，且不会被重新当成新事件',
      unreadBefore > 0 && unreadAfter === 0 && again === null,
      `未读 ${unreadBefore} → ${unreadAfter}，重复推同一条 → ${again === null ? '被去重' : '又进来了'}`)
  }

  /* ==========================================================================
     M3 附加 · 横向压缩补偿 panelX：切了系数之后 stage 实测宽度仍然是 960。
     ========================================================================== */
  {
    const stageBox = (): Promise<{ w: number; h: number }> => js(win,
      '(() => { const r = document.getElementById("stage").getBoundingClientRect();' +
      ' return { w: Math.round(r.width), h: Math.round(r.height) } })()')
    const canvas = store?.get().canvas ?? { width: 480, height: 270 }
    const expectW = canvas.width * 2
    const sizes: string[] = []
    let allOk = true
    for (const px of [1.0, 1.19, 1.25]) {
      const sc = scaleFor(canvas, px)
      await js(win, `(() => {
        const s = ${JSON.stringify(sc)}
        const r = document.documentElement.style
        r.setProperty('--canvas-w', s.w + 'px')
        r.setProperty('--canvas-h', s.h + 'px')
        r.setProperty('--scale-x', String(s.sx))
        r.setProperty('--scale-y', String(s.sy))
      })()`)
      await sleep(120)
      const box = await stageBox()
      const scroll = await js<boolean>(win,
        'document.documentElement.scrollWidth > document.documentElement.clientWidth')
      sizes.push(`${px}→${box.w}×${box.h}${scroll ? '(横向滚动!)' : ''}`)
      // 403 × 2 × 1.19 = 959.14：这 0.86px 的缝是**有意的**——panelX 是用户拿正圆量出来的
      // 物理系数，从窗口宽度反推比值会把实测值悄悄换掉（designer 明确要求保留）。
      // 缝落在最右列，body 底色与 stage 同为 --canvas，屏上看不出来；要严丝合缝该动窗口宽度。
      if (Math.abs(box.w - expectW) > 1 || box.h !== canvas.height * 2 || scroll) allOk = false
    }
    check(`panelX 切换后 stage 宽度仍是 ${expectW}±1 且无横向滚动`, allOk, sizes.join(' '))

    // 校准叠层：⌃⌥C 打开后能量到一个 200px 的圆
    win.webContents.send(CH.command, { type: 'calibrate' })
    await sleep(200)
    const ring = await js<{ on: boolean; w: number; h: number }>(win, `(() => {
      const c = document.getElementById('calib')
      const r = c.querySelector('.ring').getBoundingClientRect()
      return { on: c.dataset.on === '1', w: Math.round(r.width), h: Math.round(r.height) }
    })()`)
    win.webContents.send(CH.command, { type: 'calibrate' })
    await sleep(200)
    const off = await js<boolean>(win, "document.getElementById('calib').dataset.on !== '1'")
    check('⌃⌥C 校准叠层可开可关，圆按画布坐标 200px',
      ring.on && ring.h > 0 && off, `开=${ring.on} 实测 ${ring.w}×${ring.h} 再按关=${off}`)

    // 量完把四个变量交还给状态（下一帧 onState 会重设，这里先清掉行内值）
    await js(win, `['--canvas-w','--canvas-h','--scale-x','--scale-y']
      .forEach(k => document.documentElement.style.removeProperty(k))`)
  }

  /* ==========================================================================
     7 · v2 版面矩阵：7 页 × 7 态 × 3 画布，无溢出、无 <14px。
     三个画布是实机会出现的三种几何：
       480×270  960×540 @2x，panelX = 1（未补偿）
       480×320  960×640 原生模式
       403×270  960×540 + panelX 1.19（用户实测的补偿系数，日常就是这一档）
     切页动画期间 .page 还带着 translateX(-24px)，量出来会误报越界；先关动画再量。
     ========================================================================== */
  const rmBefore = await js<string>(win, 'document.documentElement.dataset.rm')
  await js(win, "document.documentElement.dataset.rm = '1'")

  if (store) {
    const CANVASES: Array<{ w: number; h: number; tag: string }> = [
      { w: 480, h: 270, tag: '480×270' },
      { w: 480, h: 320, tag: '480×320' },
      { w: 403, h: 270, tag: '403×270（panelX 1.19）' }
    ]
    const PAGES: Page[] = ['a', 'b', 'c1', 'c2', 'd', 'e', 'attn']
    const STATES = SCENE_NAMES

    for (const cv of CANVASES) {
      // 画布宽度直接写 CSS 变量：不必真去改窗口尺寸，量的是版面不是窗口
      await js(win, `(() => { const r = document.documentElement.style
        r.setProperty('--canvas-w','${cv.w}px'); r.setProperty('--canvas-h','${cv.h}px')
        r.setProperty('--scale-x','2'); r.setProperty('--scale-y','2') })()`)
      const overflowing: string[] = []
      const small: string[] = []
      let cells = 0
      for (const st of STATES) {
        store.setScene(st)
        await sleep(60)
        for (const p of PAGES) {
          win.webContents.send(CH.command, { type: 'showPage', page: p, token: ++token })
          await sleep(60)
          cells++
          const bad = await js<string[]>(win, OVERFLOW_PROBE)
          if (bad.length) overflowing.push(`${p}/${st}:${bad.join(',')}`)
          const f = await js<{ px: number; what: string }>(win, MIN_FONT_PROBE)
          if (f.px < 14) small.push(`${p}/${st}:${f.px}px ${f.what}`)
        }
      }
      check(`画布 ${cv.tag} · ${cells} 格无溢出`, overflowing.length === 0,
        overflowing.length ? overflowing.slice(0, 3).join(' | ') + `（共 ${overflowing.length}）`
          : `${cells} 格全部落在 .screen 内`)
      check(`画布 ${cv.tag} · ${cells} 格无 <14px`, small.length === 0,
        small.length ? small.slice(0, 3).join(' | ') + `（共 ${small.length}）` : '最小字号 ≥ 14px')
    }

    // 8 · v2 截图：7 页 × 7 态到 design/shots/m3/（panelX 补偿后的 403×270 几何）
    try {
      await js(win, `(() => { const r = document.documentElement.style
        r.setProperty('--canvas-w','403px'); r.setProperty('--canvas-h','270px')
        r.setProperty('--scale-x','2.38'); r.setProperty('--scale-y','2') })()`)
      const dir = shotDir('states')
      await mkdir(dir, { recursive: true })
      let n = 0
      for (const st of SCENE_NAMES) {
        store.setScene(st)
        await sleep(60)
        for (const p of PAGES) {
          win.webContents.send(CH.command, { type: 'showPage', page: p, token: ++token })
          await sleep(90)
          await writeFile(join(dir, `page-${p}-${st}.png`), (await win.webContents.capturePage()).toPNG())
          n++
        }
      }
      store.setLive()
      await sleep(200)
      check('v2 七页 × 七态截图已出图', n === 49, `${n} 张 → ${dir}`)
    } catch (err) {
      check('v2 七页 × 七态截图已出图', false, String(err))
    }

    await js(win, `['--canvas-w','--canvas-h','--scale-x','--scale-y']
      .forEach(k => document.documentElement.style.removeProperty(k))`)
    await sleep(200)
  }

  /* ==========================================================================
     8.5 · 真实数据的肉眼证据：六页各拍一张到 design/shots/m3/live/。
     上面那 49 张是 fixtures 的七态对账（截图要可复现，所以喂的是冻住的那一份）；
     这六张拍的是**此刻真的采到的东西** —— D 页的热力图、E 页的 AIHOT、
     B 页的 topModel 都只有在这里才看得见。轮播 60 s 一页，等不起，直接定页。
     ========================================================================== */
  if (store) {
    try {
      /* 拍之前把事件流换成**用户真实的历史**（只读地从真 userData 读一份）。
         这一程的 feed 里攒着上面那几条合成事件，直接拍会把「selftest · ZCode 任务」
         印进交付截图 —— lead 在 page-c1.png 上看到的就是它。
         Saver 绑的是临时目录，这次 restore 不会写回真实文件。 */
      store.restoreEvents(load(realUserData()))
      store.setLive()
      await sleep(400)
      /* 交付用的六页真实截图要能指定去处（M4 放 design/shots/m4/ 给 polish-pass 用）：
         `MONITOR_SHOTS_LIVE_DIR=design/shots/m4 pnpm selftest`。
         不给就落在 selftest 自己的目录里。 */
      const override = process.env.MONITOR_SHOTS_LIVE_DIR?.trim()
      const dir = override
        ? (override.startsWith('/') ? override : join(process.cwd(), override))
        : shotDir('live')
      await mkdir(dir, { recursive: true })
      const got: string[] = []
      for (const p of ['a', 'b', 'c1', 'c2', 'd', 'e'] as const) {
        win.webContents.send(CH.command, { type: 'showPage', page: p, token: ++token })
        await sleep(420)
        await writeFile(join(dir, `page-${p}.png`), (await win.webContents.capturePage()).toPNG())
        got.push(p)
      }
      // 顺手把三家的 topModel 与 D / E 的条数读回来，日志里留一行可核对的数字
      const live = await js<{ models: string[]; days: number; news: number }>(win, `(() => ({
        models: [...document.querySelectorAll('#pbBands [data-model]')].map(n => n.textContent || '-'),
        days: document.querySelectorAll('#pdHeat .cell[data-date]').length,
        news: document.querySelectorAll('#peNews .e-item').length
      }))()`)
      // 交付截图里绝不能出现合成事件
      const synthetic = await js<string[]>(win, `[...document.querySelectorAll('.feed .row')]
        .map(r => r.dataset.id || '')
        .filter(id => /selftest|^attn-|^new[0-9]/.test(id))`)
      check('六页真实数据上屏，且截图里没有合成事件',
        got.length === 6 && live.days > 0 && live.news > 0 && synthetic.length === 0,
        `模型 ${live.models.join(' / ') || '-'} · 热力图 ${live.days} 格 · 新闻 ${live.news} 条` +
        (synthetic.length ? ` · 混入 ${synthetic.join(',')}` : '') + ` → ${dir}`)
    } catch (err) {
      check('六页真实数据上屏（B 的模型名、D 的格子、E 的条数）', false, String(err))
    }
  }

  /* ==========================================================================
     8.8 · 必填字段真的渲染出来了（designer 2026-09-14 提的那条）。
     E 页的时间之所以消失整整一轮，是因为所有断言都是**结构性**的 ——
     没有溢出、没有 <14px、没有 console error —— 而「一个该出现的字段被裁没了」
     全部通过。这条补的是内容级判据：字段必须有文字、且真的占了宽度。
     四处必填：A 的倒计时、B 的模型名、C1 每行的时间、E 每条的时间。
     ========================================================================== */
  if (store) {
    type Field = { page: Page; name: string; sel: string }
    const REQUIRED: Field[] = [
      { page: 'a', name: 'A 倒计时', sel: '#paTiles .tile-foot .cd' },
      { page: 'b', name: 'B 模型名', sel: '#pbBands [data-model]' },
      { page: 'c1', name: 'C1 行时间', sel: '#pc1Feed .row .rtime' },
      { page: 'e', name: 'E 条目时间', sel: '#peNews .e-item .e-time' }
    ]
    const missing: string[] = []
    const seen: string[] = []
    for (const f of REQUIRED) {
      win.webContents.send(CH.command, { type: 'showPage', page: f.page, token: ++token })
      await sleep(320)
      const r = await js<{ n: number; blank: number }>(win, `(() => {
        const ns = [...document.querySelectorAll(${JSON.stringify(f.sel)})]
        const blank = ns.filter(n =>
          !(n.textContent || '').trim() || n.getBoundingClientRect().width < 1).length
        return { n: ns.length, blank }
      })()`)
      seen.push(`${f.name} ${r.n - r.blank}/${r.n}`)
      // 一个都没有 = 这一页此刻是空态（合法）；有而空 = 被裁没了（就是 E 页那个 bug）
      if (r.n > 0 && r.blank > 0) missing.push(`${f.name} 有 ${r.blank} 个是空的`)
    }
    check('必填字段真的渲染出来了（A 倒计时 / B 模型名 / C1 时间 / E 时间）',
      missing.length === 0, missing.length ? missing.join(' | ') : seen.join(' · '))
  }

  /* ==========================================================================
     9 · 节奏：页序 A→B→C1→C2→D→E，C2 空时跳过。
     ========================================================================== */
  if (store) {
    const pagesNow = (): Promise<string[]> => js(win,
      '[...document.querySelectorAll("#dots button")].map(b => b.dataset.p)')
    store.setScene('populated')      // fixtures 有 6 条 session → C2 有行
    await sleep(300)
    const withC2 = await pagesNow()
    store.setScene('running')        // running 场景只有 4 条 → C2 空
    await sleep(300)
    const withoutC2 = await pagesNow()
    check('指示点随 C2 有无增减（最多 6 个，居中贴底）',
      withC2.join(',') === 'a,b,c1,c2,d,e' && withoutC2.join(',') === 'a,b,c1,d,e',
      `有 C2：${withC2.join('→')} · C2 空：${withoutC2.join('→')}`)

    store.setScene('populated')
    await sleep(300)
    const seq: string[] = []
    win.webContents.send(CH.command, { type: 'showPage', page: 'a', token: ++token })
    await sleep(200)
    for (let i = 0; i < 6; i++) {
      seq.push(await page(win))
      await sendCommand(win, { type: 'step', dir: 1 })
    }
    check('页序 A→B→C1→C2→D→E', seq.join('→') === 'a→b→c1→c2→d→e', seq.join('→'))

    const dotsBottom = await js<{ centred: boolean; gap: number }>(win, `(() => {
      const box = document.querySelector('.screen').getBoundingClientRect()
      const d = document.getElementById('dots').getBoundingClientRect()
      return { centred: Math.abs((d.left + d.right) / 2 - (box.left + box.right) / 2) < 1.5,
               gap: Math.round(box.bottom - d.bottom) }
    })()`)
    check('指示点水平居中、贴画布底', dotsBottom.centred && dotsBottom.gap <= 1,
      `居中=${dotsBottom.centred} 距底 ${dotsBottom.gap}px`)
    store.setLive()
    await sleep(300)
  }

  // 10 · 原生模式的肉眼证据：把窗口真的开成 960×640、画布 480×320 拍两张。
  // 断言只证明「没越界」，看不出多出来的 50px 落在哪；这两张是给人看的。
  // 放在最后一步，之后进程就退出了，窗口被留在非全屏也没有影响。
  try {
    if (win.isSimpleFullScreen()) win.setSimpleFullScreen(false)
    const b = win.getBounds()
    win.setBounds({ x: b.x, y: b.y, width: 960, height: 640 })
    await js(win, "document.documentElement.style.setProperty('--canvas-h','320px')")
    await sleep(500)
    // M2 起这两张拍的是真实采集的数据，所以落在 m2/ 下 —— M1 的对账截图是 fixtures 那一份，
    // 在 live 模式下已经复现不出来（时间原点变成了真时间），不该被顺手覆盖掉。
    const dir = shotDir('native-960x640')
    await mkdir(dir, { recursive: true })
    for (const p of ['a', 'c1', 'd', 'e'] as const) {
      await sendCommand(win, { type: 'showPage', page: p })
      await sleep(300)
      const img = await win.webContents.capturePage()
      await writeFile(join(dir, `page-${p}.png`), img.toPNG())
    }
    check('原生 960×640 模式预览已出图', true, `${dir}/page-{a,c1,d,e}.png`)
  } catch (err) {
    check('原生 960×640 模式预览已出图', false, String(err))
  }

  // 量完把尺寸与动画开关都交还回去
  await js(win, "document.documentElement.style.removeProperty('--canvas-h')")
  await js(win, `document.documentElement.dataset.rm = ${JSON.stringify(rmBefore || '0')}`)

  const guardAfter = await Promise.all(guarded.map(fingerprint))
  const drifted = guarded.filter((_f, i) => guardBefore[i] !== guardAfter[i])
  check('自检没有碰过用户真实的 events.json / config.json / hook-token',
    drifted.length === 0,
    drifted.length ? drifted.join('、') + ' 被改动了' : guarded.length + ' 个文件逐字节未变')

  const failed = results.filter(r => !r.ok)
  console.log(`[selftest] ${results.length - failed.length}/${results.length} 通过`)
  return failed.length === 0
}
