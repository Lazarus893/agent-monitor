/**
 * F 页心跳层的主进程侧：起 ax-pulse 子进程、按行收脉冲、记账、推屏。
 *
 * 两条推送路，快慢分开（design/brief-midi.md §3）：
 *   · 脉冲 —— 每一条立刻走 CH.pulse 送到渲染层。爪子要在 100 ms 内动，
 *     这条路上不能有任何节流，也不能顺带搬一整份 MonitorState；
 *   · 慢数据 —— 三个数 + 连接状态，节流 5 s 进 store（状态变化 / 跨日 / stop 立刻）。
 *
 * 子进程崩了就退避重启（2 s → 4 s → … 封顶 60 s），期间 status 是 offline；
 * 账本在主进程手上，所以「子进程被杀」不会让今日字数清零 —— 验收第 4 条要的就是这个。
 */

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createInterface } from 'node:readline'
import type { TypingData, TypingPulse, TypingStatus } from '../../../shared/types.js'
import type { Store } from '../../state.js'
import { helperPath } from '../../resources.js'
import { localDate } from '../usage.js'
import { Ledger } from './ledger.js'
import { PulseFolder } from './pulse.js'

/** 慢数据的节流窗口 */
export const STATE_MS = 5_000
/** 子进程退出后的首次重试间隔，每次翻倍 */
export const RESTART_MIN_MS = 2_000
export const RESTART_MAX_MS = 60_000
/** dev 的 simulateTyping 一次最多模拟多少字，防手滑写个 1e9 把主进程卡死 */
const SIMULATE_MAX = 2_000
/** 子进程 stderr 的限流：一行最多留多少字符、一分钟最多转发多少行 */
const HELPER_LINE_MAX = 200
const HELPER_LINES_PER_MIN = 20
const HELPER_WINDOW_MS = 60_000
/** stop() 里等子进程自己退的时间，过了才动手 kill */
const STOP_GRACE_MS = 500

/** 子进程 stdout 的两种行 */
export type HelperLine =
  | { kind: 'status'; status: Extract<TypingStatus, 'ok' | 'untrusted'> }
  | { kind: 'pulse'; t: number; d: number }

/** 坏行返回 null —— 子进程写歪一行不该让整条链停掉 */
export function parseLine(line: string): HelperLine | null {
  const s = line.trim()
  if (!s) return null
  let raw: unknown
  try {
    raw = JSON.parse(s)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  if (o['status'] === 'ok' || o['status'] === 'untrusted') {
    return { kind: 'status', status: o['status'] }
  }
  const { t, d } = o
  if (typeof t !== 'number' || !Number.isFinite(t)) return null
  if (typeof d !== 'number' || !Number.isInteger(d)) return null
  return { kind: 'pulse', t, d }
}

export type TypingHandle = {
  stop(): void
  /** dev：走与真实脉冲完全同一条路（一个字一条脉冲） */
  simulate(chars: number): void
}

export type TypingOptions = {
  /** 一条脉冲送到渲染层。collector 不持有窗口。 */
  send(pulse: TypingPulse): void
  /** 未打包时才允许 simulate */
  dev?: boolean
}

export function startTyping(store: Store, userData: string, opts: TypingOptions): TypingHandle {
  const c = new TypingCollector(store, userData, opts)
  c.start()
  return {
    stop: () => c.stop(),
    simulate: (chars: number) => { if (opts.dev) c.simulate(chars) }
  }
}

class TypingCollector {
  private ledger: Ledger
  private folder = new PulseFolder()
  private status: TypingStatus = 'connecting'
  private child: ChildProcess | null = null
  private restartMs = RESTART_MIN_MS
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  private lastInputAt: number | undefined
  /** 上一次真正进 store 的那一份，用来判断状态 / 日期变没变 */
  private pushed: TypingData | null = null
  private pushedAt = 0
  private pushTimer: ReturnType<typeof setTimeout> | null = null
  /** 距上一条日志攒了多少字 */
  private sinceLog = 0
  /** 子进程 stderr 限流的当前窗口起点与窗口内行数 */
  private logWindowAt = 0
  private logCount = 0

  constructor(private store: Store, userData: string, private opts: TypingOptions) {
    this.ledger = new Ledger(userData)
  }

  start(): void {
    this.push(true)
    if (process.platform !== 'darwin') {
      this.setStatus('offline')
      console.log('[typing] 不是 macOS，心跳层不起（F 页按 offline 画）')
      return
    }
    const bin = helperPath()
    if (!existsSync(bin)) {
      this.setStatus('offline')
      console.log(`[typing] 找不到 ax-pulse（${bin}），心跳层不起 —— 跑一次 pnpm build:helper`)
      return
    }
    this.spawn(bin)
  }

  private spawn(bin: string): void {
    if (this.stopped) return
    // stdin 保持 pipe 且不关：子进程读到 EOF 就自杀，这是它认「父进程没了」的唯一判据
    const child = spawn(bin, [], { stdio: ['pipe', 'pipe', 'pipe'] })
    this.child = child
    this.setStatus('connecting')
    console.log(`[typing] helper 启动 pid=${child.pid ?? '?'}`)

    createInterface({ input: child.stdout! }).on('line', line => this.onLine(line))
    createInterface({ input: child.stderr! }).on('line', line => this.onHelperLog(line))

    child.on('error', err => console.warn(`[typing] helper 起不来：${String(err)}`))
    // 'exit' 只留一行日志。它带 code/signal，但**它不一定来**（见 onGone）
    child.on('exit', (code, signal) =>
      console.warn(`[typing] helper 退出（code=${code ?? '-'} signal=${signal ?? '-'}）`))
    child.on('close', () => this.onGone(child, bin))
  }

  /**
   * 子进程没了：置 offline + 退避重启。
   *
   * 绑在 **'close'** 而不是 'exit'：spawn 本身失败时（二进制被删、没有执行位、
   * 架构不对）Node 发的是 'error' + 'close'，**根本不发 'exit'** —— 收尾逻辑挂在
   * 'exit' 上的话，这条链会永远停在 connecting，屏上那句「Midi 正在醒来」
   * 再也不会变成「还没连上 Midi 的耳朵」，而日志里只有一行 error。
   * 'close' 是这里唯一保证会来的事件（它等的是 stdio 全关，正常退出时也一定来）。
   */
  private onGone(child: ChildProcess, bin: string): void {
    if (this.child !== child) return
    this.child = null
    if (this.stopped) return
    this.setStatus('offline')
    const wait = this.restartMs
    this.restartMs = Math.min(this.restartMs * 2, RESTART_MAX_MS)
    console.warn(`[typing] helper 没了，${wait / 1000}s 后重启`)
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      this.spawn(bin)
    }, wait)
  }

  /**
   * 转发子进程的调试行。AX_PULSE_DEBUG=1 时它一秒能刷十几条，
   * 而这里是**主进程的日志**（要轮转、事后要有人翻）——
   * 一个调试开关不该把额度采集、事件流那些行冲得找不到。
   * 每行截到 200 字符、每分钟最多 20 行，越线之后这一分钟只说一句「已抑制」。
   */
  private onHelperLog(line: string): void {
    const now = Date.now()
    if (now - this.logWindowAt >= HELPER_WINDOW_MS) {
      this.logWindowAt = now
      this.logCount = 0
    }
    this.logCount++
    if (this.logCount > HELPER_LINES_PER_MIN) {
      if (this.logCount === HELPER_LINES_PER_MIN + 1) {
        console.log(`[typing:helper] 这一分钟已转发 ${HELPER_LINES_PER_MIN} 行，其余已抑制`)
      }
      return
    }
    const s = line.length > HELPER_LINE_MAX ? `${line.slice(0, HELPER_LINE_MAX)}…` : line
    console.log(`[typing:helper] ${s}`)
  }

  private onLine(line: string): void {
    const parsed = parseLine(line)
    if (!parsed) {
      console.warn('[typing] helper 写了一行读不懂的，丢掉')
      return
    }
    if (parsed.kind === 'status') {
      // 报到了就说明这一程活着，退避归零
      this.restartMs = RESTART_MIN_MS
      if (this.status !== parsed.status) console.log(`[typing] status ${parsed.status}`)
      this.setStatus(parsed.status)
      return
    }
    this.ingest(parsed.t, parsed.d)
  }

  /** 一条增量落地：折算 → 记账 → 推脉冲 → 推慢数据 */
  private ingest(at: number, d: number): void {
    const { pulse, entries } = this.folder.fold(at, d)
    /* 逐笔按**那一笔挣到的时刻**落格，不是按这条消息的时刻：
       23:59:59 敲下的字母在 00:00:01 上屏，那笔回落要扣在昨天那一格上。 */
    for (const e of entries) {
      this.ledger.add(localDate(new Date(e.at)), e.n)
      this.sinceLog += e.n
    }
    if (pulse) {
      this.lastInputAt = pulse.at
      this.opts.send(pulse)
    }
    this.push()
  }

  simulate(chars: number): void {
    const n = Math.min(Math.max(0, Math.floor(chars)), SIMULATE_MAX)
    // 一个字一条脉冲：渲染层的爪子要能一下一下地切
    for (let i = 0; i < n; i++) this.ingest(Date.now(), 1)
  }

  private setStatus(status: TypingStatus): void {
    if (this.status === status) return
    this.status = status
    this.push(true)
  }

  private snapshot(): TypingData {
    const date = localDate(new Date())
    const d = this.ledger.derive(date)
    return {
      status: this.status,
      date,
      today: d.today,
      yesterday: d.yesterday,
      streak: d.streak,
      ...(this.lastInputAt ? { lastInputAt: new Date(this.lastInputAt).toISOString() } : {}),
      updatedAt: new Date().toISOString()
    }
  }

  /**
   * 慢数据进 store。打字时每个字都会走到这里，所以默认节流 5 s；
   * 状态变了、或者跨过零点（date 变了）就立刻推 —— 这两件事等 5 s 是在骗人。
   */
  private push(force = false): void {
    const next = this.snapshot()
    const changed = !this.pushed || this.pushed.status !== next.status || this.pushed.date !== next.date
    const now = Date.now()
    if (force || changed || now - this.pushedAt >= STATE_MS) {
      if (this.pushTimer) {
        clearTimeout(this.pushTimer)
        this.pushTimer = null
      }
      this.pushed = next
      this.pushedAt = now
      if (this.sinceLog) {
        console.log(`[typing] 今日 ${next.today}（+${this.sinceLog}）`)
        this.sinceLog = 0
      }
      this.store.setTyping(next)
      return
    }
    if (this.pushTimer) return
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null
      this.push()
    }, STATE_MS - (now - this.pushedAt))
  }

  stop(): void {
    this.stopped = true
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = null
    if (this.pushTimer) clearTimeout(this.pushTimer)
    this.pushTimer = null
    const child = this.child
    this.child = null
    if (child) {
      /* 正常路径是**子进程自己退**：stdin 一关它读到 EOF 就 exit(0)，
         这是它认「父进程没了」的唯一判据，也是它不留孤儿的那条线。
         kill 是兜底 —— 它可能正卡在一次 AX 调用里（目标 app 不响应，超时 0.5 s），
         那一拍过去才轮得到 EOF。给 500 ms，还在就动手。
         stdin 先挂个空的 'error'：子进程已经先走一步时 end() 会 EPIPE，
         而这是个没有监听者就直接抛的错误事件，会一路冒到主进程的 crash guard ——
         退出时收尾反倒把 app 崩掉，那是最不该的一种崩。 */
      child.stdin?.on('error', () => {})
      child.stdin?.end()
      const t = setTimeout(() => child.kill(), STOP_GRACE_MS)
      // 这个兜底不该拖住 will-quit：它只在子进程真的赖着不走时才有事做
      t.unref()
      child.once('close', () => clearTimeout(t))
    }
    this.ledger.flush()
  }
}
