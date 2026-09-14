/**
 * 三个额度 collector 的共同调度器。
 *
 * 一个 collector 一条独立的 setTimeout 链（不是一个 setInterval 扫全部）：
 * 各自的周期不同（codex 60 s、claude 15 s、zcode 60 s），退避也各退各的。
 *
 * 四条纪律，全部来自简报「统一行为」：
 *   1. ±10% 抖动 —— 三条链不会永远在同一秒一起醒来；
 *   2. 同一个 collector 不并发 —— 下一次的定时器在上一次落地之后才排；
 *   3. 超时 15 s —— 传给 run 的 AbortSignal 会被 abort，超时算 network；
 *   4. 连续失败指数退避，封顶 10 min，成功立刻复位。
 *      只有「可能会自己好」的失败才退避：missing_key / missing_tool / no_statusline
 *      是本机还没接上，重试成本又极低（读一次 Keychain / 一次 stat），退避只会让
 *      用户补上 Key 之后要等十分钟才看到变化。
 */

import type { QuotaResult } from './quota/types.js'
import { summarize } from './quota/types.js'

export const TIMEOUT_MS = 15_000
export const MAX_BACKOFF_MS = 10 * 60_000
export const JITTER = 0.1

/** 会自己好的失败才退避；本机没接上的三种保持原周期 */
const BACKOFF_CODES = new Set(['network', 'rate_limited', 'unauthorized'])

export type Job = {
  /** 日志前缀里的名字：`[quota:codex]` */
  name: string
  intervalMs: number
  run: (signal: AbortSignal) => Promise<QuotaResult>
  onResult: (result: QuotaResult) => void
}

/**
 * 下一次该等多久。纯函数，便于把「退避到底退了多少」钉成用例。
 * failures 是连续失败次数（0 = 上一轮成功）。
 */
export function nextDelay(intervalMs: number, failures: number, rand: () => number = Math.random): number {
  const base = failures > 0
    ? Math.min(intervalMs * 2 ** failures, MAX_BACKOFF_MS)
    : intervalMs
  // rand() ∈ [0,1) → 系数 ∈ [0.9, 1.1)
  return Math.round(base * (1 + (rand() * 2 - 1) * JITTER))
}

export function logLine(name: string, result: QuotaResult, ms: number): string {
  const head = `[quota:${name}]`
  if (result.ok) return `${head} ok ${summarize(result.windows)} in ${ms}ms`
  const kept = result.windows?.length ? ` kept ${summarize(result.windows)} stale` : ''
  return `${head} error ${result.code}${kept} in ${ms}ms`
}

type JobState = { failures: number; timer: ReturnType<typeof setTimeout> | null; inFlight: boolean }

export class Scheduler {
  private states = new Map<string, JobState>()
  private stopped = true

  constructor(
    private jobs: Job[],
    private deps: { rand?: () => number; now?: () => number; log?: (line: string) => void } = {}
  ) {}

  /** 立刻跑一轮，之后各自按周期续。 */
  start(): void {
    if (!this.stopped) return
    this.stopped = false
    for (const job of this.jobs) {
      this.states.set(job.name, { failures: 0, timer: null, inFlight: false })
      void this.cycle(job)
    }
  }

  /** 立刻跑一轮（dev 的 forceError 用：60 s 周期下等下一轮才生效没法演示）。 */
  kick(name: string): void {
    const job = this.jobs.find(j => j.name === name)
    const st = this.states.get(name)
    if (!job || !st || this.stopped || st.inFlight) return
    if (st.timer) clearTimeout(st.timer)
    st.timer = null
    void this.cycle(job)
  }

  stop(): void {
    this.stopped = true
    for (const st of this.states.values()) {
      if (st.timer) clearTimeout(st.timer)
      st.timer = null
    }
  }

  private async cycle(job: Job): Promise<void> {
    const st = this.states.get(job.name)
    if (!st || this.stopped || st.inFlight) return
    st.inFlight = true

    const now = this.deps.now ?? Date.now
    const log = this.deps.log ?? ((line: string) => console.log(line))
    const started = now()
    const ac = new AbortController()
    let killer: ReturnType<typeof setTimeout> | null = null
    // 超时不只是 abort 一下就完事：collector 如果没理会 signal（或卡在 execFile 的
    // 清理里），只 abort 会让这条链永远停在 await 上，之后一次都不再采。
    // 所以 race 一个必定落地的兜底结果；abort 仍然发出去，让底下的 fetch / execFile 收摊。
    const timeout = new Promise<QuotaResult>(resolve => {
      killer = setTimeout(() => {
        ac.abort()
        resolve({ ok: false, code: 'network' })
      }, TIMEOUT_MS)
    })
    // run 抛出 = 没有被归一化的意外（DNS、socket、解析崩在半路），一律当网络不可达
    const runner = job.run(ac.signal).then(r => r, (): QuotaResult => ({ ok: false, code: 'network' }))
    const result = await Promise.race([runner, timeout])
    if (killer) clearTimeout(killer)

    const ms = now() - started
    log(logLine(job.name, result, ms))
    st.failures = result.ok || !BACKOFF_CODES.has(result.code) ? 0 : st.failures + 1
    st.inFlight = false
    try {
      job.onResult(result)
    } catch (err) {
      log(`[quota:${job.name}] onResult threw: ${String(err)}`)
    }

    if (this.stopped) return
    const delay = nextDelay(job.intervalMs, st.failures, this.deps.rand)
    st.timer = setTimeout(() => { void this.cycle(job) }, delay)
  }
}
