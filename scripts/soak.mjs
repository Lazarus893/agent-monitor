#!/usr/bin/env node
/**
 * 内存 soak（简报 §4）：把 app 跑起来，每分钟记一次 RSS，增长超过 30% 判泄漏。
 *
 *   pnpm soak                # 30 分钟
 *   pnpm soak -- --minutes 5 # 短跑一轮，改完代码先看一眼
 *
 * 量什么：
 *   · `main`  —— Electron 主进程。collector、事件流、日志都在这儿，泄漏最可能在这。
 *   · `tree`  —— 主进程 + 全部子进程（渲染、GPU、网络、工具）的 RSS 之和。
 *     macOS 的 RSS 在进程间会重复计入共享页，所以这个数偏大；它只用来看**趋势**。
 *
 * 判据：以**第 2 分钟**为基线，不是第 0 分钟 —— 头一两分钟里字体、首轮采集、
 * V8 的预热都还在涨，拿那一刻当基线会把正常的启动开销算成泄漏。
 *
 * 隔离：userData / config / 日志 / hook 端口全部挪到临时目录，
 * 不碰用户真实的 ~/.agent-monitor、~/Library/Logs、events.json。
 * 钥匙串是**只读**的那条原路（读不写），soak 才跑在和平时一样的代码路径上。
 *
 * 注意：跑的时候面板会占住副屏，且单实例锁只允许一个 —— 别和 pnpm dev 同时开。
 */

import { spawn, execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
/** electron 包默认导出的是本机那个二进制的绝对路径 */
const ELECTRON = require('electron')

const argv = process.argv.slice(2)
const at = argv.indexOf('--minutes')
const MINUTES = at >= 0 && argv[at + 1] ? Math.max(2, Number(argv[at + 1])) : 30
/** 基线取第几分钟 —— 启动抖动过去之后 */
const BASELINE_MIN = Math.min(2, MINUTES - 1)
const LIMIT = 0.30

const DIR = join(tmpdir(), 'agent-monitor-soak')
mkdirSync(DIR, { recursive: true })

const env = {
  ...process.env,
  MONITOR_USER_DATA: DIR,
  MONITOR_CONFIG_FILE: join(DIR, 'config.json'),
  MONITOR_LOG_DIR: join(DIR, 'logs'),
  MONITOR_HOOK_TOKEN_FILE: join(DIR, 'hook-token'),
  MONITOR_HOOK_PORT: '47934'
}

/** 一棵进程树上所有 pid 的 RSS（KB）。ps 一次拿全，避免逐个 pgrep。 */
function sampleTree(rootPid) {
  let out = ''
  try {
    out = execFileSync('ps', ['-eo', 'pid=,ppid=,rss='], { encoding: 'utf8' })
  } catch {
    return null
  }
  const rows = []
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)$/)
    if (m) rows.push({ pid: +m[1], ppid: +m[2], rss: +m[3] })
  }
  const byParent = new Map()
  const rss = new Map()
  for (const r of rows) {
    rss.set(r.pid, r.rss)
    if (!byParent.has(r.ppid)) byParent.set(r.ppid, [])
    byParent.get(r.ppid).push(r.pid)
  }
  if (!rss.has(rootPid)) return null
  let total = 0
  let count = 0
  const stack = [rootPid]
  const seen = new Set()
  while (stack.length) {
    const pid = stack.pop()
    if (seen.has(pid)) continue
    seen.add(pid)
    total += rss.get(pid) ?? 0
    count++
    for (const c of byParent.get(pid) ?? []) stack.push(c)
  }
  return { main: rss.get(rootPid), tree: total, procs: count }
}

const mb = kb => (kb / 1024).toFixed(1)

async function main() {
  console.log(`[soak] ${MINUTES} 分钟，隔离目录 ${DIR}`)
  const child = spawn(ELECTRON, ['.'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let appLog = ''
  child.stdout.on('data', d => { appLog += d })
  child.stderr.on('data', d => { appLog += d })

  let exited = false
  let stopping = false      // 我们自己在收工，它退出是正常的
  child.on('exit', code => {
    exited = true
    if (!stopping) console.error(`[soak] app 提前退出，code=${code}`)
  })

  const rows = []
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  // 先等 20 s 让窗口与首轮采集落地，再开始第 0 分钟的采样
  await sleep(20_000)

  for (let m = 0; m <= MINUTES && !exited; m++) {
    const s = sampleTree(child.pid)
    if (!s) break
    rows.push({ minute: m, ...s })
    console.log(
      `[soak] ${String(m).padStart(2)} min  main=${mb(s.main)} MB  ` +
      `tree=${mb(s.tree)} MB  procs=${s.procs}`
    )
    if (m < MINUTES) await sleep(60_000)
  }

  if (!exited) {
    stopping = true
    child.kill('SIGTERM')
    await sleep(1500)
    if (!child.killed) child.kill('SIGKILL')
  }

  const report = join(DIR, 'soak.json')
  const base = rows.find(r => r.minute === BASELINE_MIN) ?? rows[0]
  const last = rows[rows.length - 1]
  if (!base || !last || rows.length < 3) {
    console.error('[soak] 采样不足，判不了。app 日志：')
    console.error(appLog.split('\n').slice(-20).join('\n'))
    writeFileSync(report, JSON.stringify({ rows, appLogTail: appLog.slice(-4000) }, null, 1))
    process.exit(1)
  }

  const growth = k => (last[k] - base[k]) / base[k]
  const gMain = growth('main')
  const gTree = growth('tree')
  const peakTree = Math.max(...rows.map(r => r.tree))
  const ok = gMain <= LIMIT && gTree <= LIMIT

  writeFileSync(report, JSON.stringify({
    minutes: MINUTES, baselineMinute: base.minute, limit: LIMIT,
    main: { base: base.main, last: last.main, growth: gMain },
    tree: { base: base.tree, last: last.tree, growth: gTree, peak: peakTree },
    rows, ok, appLogTail: appLog.slice(-4000)
  }, null, 1))

  const pct = g => `${(g * 100).toFixed(1)}%`
  console.log('')
  console.log(`[soak] 基线 ${base.minute} min → 末次 ${last.minute} min`)
  console.log(`[soak] main ${mb(base.main)} → ${mb(last.main)} MB（${pct(gMain)}）`)
  console.log(`[soak] tree ${mb(base.tree)} → ${mb(last.tree)} MB（${pct(gTree)}，峰值 ${mb(peakTree)} MB）`)
  console.log(`[soak] 判据 ≤ ${pct(LIMIT)} → ${ok ? '通过' : '未通过'}`)
  console.log(`[soak] 明细 ${report}`)
  process.exit(ok ? 0 : 1)
}

main().catch(err => {
  console.error(`[soak] ${String(err)}`)
  process.exit(1)
})
