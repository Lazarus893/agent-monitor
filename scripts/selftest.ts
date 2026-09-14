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
import { app, globalShortcut } from 'electron'
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

/** 自检发的指令：showPage 的 token 由 sendCommand 补，调用处不写。
 *  （Omit 作用在联合类型上会把分支压平，所以这里显式列出来。） */
type CommandInput =
  | Extract<MonitorCommand, { type: 'step' } | { type: 'home' }>
  | { type: 'showPage'; page: Page }

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

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
      const dir = join(process.cwd(), 'design', 'shots', 'm3')
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
      const dir = join(process.cwd(), 'design', 'shots', 'm3', 'live')
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
    const dir = join(process.cwd(), 'design', 'shots', 'm3', 'native-960x640')
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
