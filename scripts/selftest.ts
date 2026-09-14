/**
 * 交互自检 —— 验收第 4 条的机械证据：全局快捷键、指示点、边缘区、手动暂停、新事件打断。
 * 由主进程在 MONITOR_SELFTEST=1 时调用（`pnpm selftest`），用 sendInputEvent 真按键真点击，
 * 再从渲染层读回 data-page，不靠肉眼。
 *
 * 它不是 design/verify.mjs 的替代品（那份跑的是版面与对比度断言），
 * 只覆盖「Electron 这一层的线接没接上」。
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { globalShortcut } from 'electron'
import { CH } from '../src/shared/ipc.js'
import type { AgentId, MonitorCommand, Page } from '../src/shared/types.js'
import { collectCodex } from '../src/main/collectors/quota/codex.js'
import { createZcodeCollector } from '../src/main/collectors/quota/zcode.js'

/** 自检发的指令：showPage 的 token 由 sendCommand 补，调用处不写。
 *  （Omit 作用在联合类型上会把分支压平，所以这里显式列出来。） */
type CommandInput =
  | Extract<MonitorCommand, { type: 'step' } | { type: 'home' }>
  | { type: 'showPage'; page: Page }

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

/** 当前页里有没有任何可见元素越出 .screen。.sr 是 1px 的屏幕阅读器锚点，按定义在框外。 */
const OVERFLOW_PROBE = `(() => {
  const box = document.querySelector('.screen').getBoundingClientRect()
  const pg = document.querySelector('.page[data-on="1"]')
  const bad = []
  pg.querySelectorAll('*').forEach(n => {
    if (n.classList.contains('sr') || n.closest('.sr')) return
    const r = n.getBoundingClientRect()
    if (!r.width && !r.height) return
    if (r.bottom > box.bottom + 0.5 || r.right > box.right + 0.5 ||
        r.top < box.top - 0.5 || r.left < box.left - 0.5) {
      bad.push((n.className && n.className.baseVal !== undefined ? 'svg' : n.className) || n.tagName)
    }
  })
  return bad.slice(0, 4)
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

export async function runSelftest(win: BrowserWindow): Promise<boolean> {
  console.log('[selftest] 前提：副屏在位、⌃⌥←/→/↑ 未被其它 app 占用。' +
    '任一前提不成立时下面会有 FAIL，那不一定是代码回归。')
  await sleep(1200)

  // 0.0 · 首轮真实采样（M2 验收 1 的机械证据）。codexbar 冷启动实测 3 s 出头，
  // 预算给到 60 s —— 简报要求的就是「60 s 内出现真实数字」。
  const sampledIn = await waitForFirstSample(win, 60_000)
  check('首轮真实采样落地（骨架屏退场）', sampledIn >= 0,
    sampledIn >= 0 ? `${sampledIn}ms` : '60 s 内仍是骨架屏')

  // 0 · 首帧状态真的到了渲染层。
  // 曾经的 P0：唯一一次 send 发生在 mw.load() 之前，落在 about:blank 上，面板全黑。
  // 判据取 DOM 而不是内部计数器：三块瓦片 + 至少一行事件，只有 state 到了才画得出来。
  const tiles = await js<number>(win, 'document.querySelectorAll("#paTiles .tile").length')
  const rows = await js<number>(win, 'document.querySelectorAll("#pcFeed .row").length')
  const startPage = await page(win)
  check('首帧 state 已到渲染层', tiles === 3 && rows > 0,
    `瓦片 ${tiles} 行 ${rows}`)
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
  check('⌃⌥→ / ⌃⌥↑ 切页', afterRight === 'b' && afterRight2 === 'c' && afterHome === 'a',
    `a →${afterRight} →${afterRight2}，↑ → ${afterHome}`)

  // 2 · 点击指示点直接跳页
  const dotC = await centerOf(win, '#dots button[data-p="c"]')
  await clickAt(win, dotC.x, dotC.y)
  const afterDot = await page(win)
  check('点击指示点跳页', afterDot === 'c', `点 (${dotC.x},${dotC.y}) → ${afterDot}`)

  // 3 · 手动切页后轮播暂停：‖ 标记出现，且 token 是 120s
  const holdVisible = await js<boolean>(win, '!document.getElementById("holdmark").hidden')
  const holdToken = await js<string>(win,
    'getComputedStyle(document.documentElement).getPropertyValue("--manual-hold").trim()')
  check('手动后轮播暂停', holdVisible && holdToken === '120s', `‖=${holdVisible} --manual-hold=${holdToken}`)

  // 4 · 边缘区切页（左侧 = 上一页）
  const edge = await centerOf(win, '.edge[data-side="prev"]')
  await clickAt(win, edge.x, edge.y)
  const afterEdge = await page(win)
  check('点击边缘区切页', afterEdge === 'b', `c 上一页 → ${afterEdge}`)

  // 5 · 新事件打断：手动暂停期间仍然跳 C 并解除暂停
  await js(win, 'window.monitor.dev.simulateEvent()')
  await sleep(400)
  const afterEvent = await page(win)
  const holdAfterEvent = await js<boolean>(win, '!document.getElementById("holdmark").hidden')
  check('新事件打断手动暂停', afterEvent === 'c' && !holdAfterEvent,
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
  await sendCommand(win, { type: 'showPage', page: 'c' })
  const acked = await js<string>(win, `(() => {
    const row = document.querySelector('#pcFeed .row[data-unread="1"]')
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
    const dir = join(process.cwd(), 'design', 'shots', 'm2')
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

  // 7 · 两种画布尺寸都不能溢出。
  // 面板原生是 960×640（3:2），当前 960×540 @2x 是缩放器压出来的；用户切到原生模式后
  // 画布就是 480×320。这里直接改 --canvas-h 量一遍，不等真去切分辨率。
  // 切页动画期间 .page 还带着 translateX(-24px)，量出来会误报越界；先关掉动画再量。
  const rmBefore = await js<string>(win, 'document.documentElement.dataset.rm')
  await js(win, "document.documentElement.dataset.rm = '1'")
  for (const h of [270, 320]) {
    const overflowing: string[] = []
    await js(win, `document.documentElement.style.setProperty('--canvas-h','${h}px')`)
    for (const p of ['a', 'b', 'c', 'attn']) {
      await sendCommand(win, { type: 'showPage', page: p as 'a' })
      const bad = await js<string[]>(win, OVERFLOW_PROBE)
      if (bad.length) overflowing.push(`${p}:${bad.join(',')}`)
    }
    check(`画布 480×${h} 不溢出`, overflowing.length === 0,
      overflowing.length ? overflowing.join(' | ') : '四页全部落在 .screen 内')
  }
  // 8 · 原生模式的肉眼证据：把窗口真的开成 960×640、画布 480×320 拍两张。
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
    const dir = join(process.cwd(), 'design', 'shots', 'm2', 'native-960x640')
    await mkdir(dir, { recursive: true })
    for (const p of ['a', 'c'] as const) {
      await sendCommand(win, { type: 'showPage', page: p })
      await sleep(300)
      const img = await win.webContents.capturePage()
      await writeFile(join(dir, `page-${p}.png`), img.toPNG())
    }
    check('原生 960×640 模式预览已出图', true, `${dir}/page-{a,c}.png`)
  } catch (err) {
    check('原生 960×640 模式预览已出图', false, String(err))
  }

  // 量完把尺寸与动画开关都交还回去
  await js(win, "document.documentElement.style.removeProperty('--canvas-h')")
  await js(win, `document.documentElement.dataset.rm = ${JSON.stringify(rmBefore || '0')}`)

  const failed = results.filter(r => !r.ok)
  console.log(`[selftest] ${results.length - failed.length}/${results.length} 通过`)
  return failed.length === 0
}
