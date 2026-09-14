/**
 * 调度器的四条纪律：抖动、不并发、超时、退避。
 * 用假定时器 + 固定 rand（0.5 → 抖动系数正好 1.0），断言的是「第几毫秒醒来」而不是「大概」。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  JITTER, MAX_BACKOFF_MS, Scheduler, TIMEOUT_MS, logLine, nextDelay
} from '../../src/main/collectors/scheduler.js'
import type { Job } from '../../src/main/collectors/scheduler.js'
import type { QuotaResult } from '../../src/main/collectors/quota/types.js'

const OK: QuotaResult = {
  ok: true,
  windows: [
    { label: '5h', usedPercent: 22, resetsAt: '2026-09-14T08:56:08Z' },
    { label: '7d', usedPercent: 7, resetsAt: '2026-09-19T19:21:22Z' }
  ]
}
const NET: QuotaResult = { ok: false, code: 'network' }

describe('nextDelay', () => {
  it('成功之后就是原周期，抖动不超过 ±10%', () => {
    for (const r of [0, 0.5, 0.999]) {
      const d = nextDelay(60_000, 0, () => r)
      expect(d).toBeGreaterThanOrEqual(60_000 * (1 - JITTER))
      expect(d).toBeLessThanOrEqual(60_000 * (1 + JITTER))
    }
  })

  it('连续失败指数退避', () => {
    const half = () => 0.5
    expect(nextDelay(60_000, 1, half)).toBe(120_000)
    expect(nextDelay(60_000, 2, half)).toBe(240_000)
    expect(nextDelay(60_000, 3, half)).toBe(480_000)
  })

  it('退避封顶 10 min', () => {
    expect(nextDelay(60_000, 20, () => 0.5)).toBe(MAX_BACKOFF_MS)
  })
})

describe('logLine', () => {
  it('成功一行，失败一行，都不含来源字段', () => {
    expect(logLine('codex', OK, 812)).toBe('[quota:codex] ok 5h=22% 7d=7% in 812ms')
    expect(logLine('zcode', NET, 15001)).toBe('[quota:zcode] error network in 15001ms')
    expect(logLine('claude', { ...NET, windows: OK.ok ? OK.windows : [] }, 20))
      .toBe('[quota:claude] error network kept 5h=22% 7d=7% stale in 20ms')
  })
})

describe('Scheduler', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const make = (
    run: Job['run'],
    intervalMs = 1000
  ): { sched: Scheduler; results: QuotaResult[]; lines: string[] } => {
    const results: QuotaResult[] = []
    const lines: string[] = []
    const sched = new Scheduler(
      [{ name: 't', intervalMs, run, onResult: r => results.push(r) }],
      { rand: () => 0.5, log: l => lines.push(l) }
    )
    return { sched, results, lines }
  }

  it('启动立刻采一轮，之后按周期续', async () => {
    const run = vi.fn(async () => OK)
    const { sched, results } = make(run)
    sched.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(run).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(run).toHaveBeenCalledTimes(2)
    expect(results).toHaveLength(2)
    sched.stop()
  })

  it('同一个 collector 不并发：上一轮没落地，下一轮的定时器就还没排', async () => {
    const gate: { release: (() => void) | null } = { release: null }
    const run = vi.fn(() => new Promise<QuotaResult>(r => { gate.release = () => r(OK) }))
    const { sched } = make(run)
    sched.start()
    await vi.advanceTimersByTimeAsync(5000) // 远超一个周期
    expect(run).toHaveBeenCalledTimes(1)
    gate.release?.()
    await vi.advanceTimersByTimeAsync(1000)
    expect(run).toHaveBeenCalledTimes(2)
    sched.stop()
  })

  it('超时 15 s 兜底：collector 不理会 signal，链条也不会卡死', async () => {
    const run = vi.fn(() => new Promise<QuotaResult>(() => {}))
    const { sched, results } = make(run)
    sched.start()
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS)
    expect(results).toEqual([{ ok: false, code: 'network' }])
    sched.stop()
  })

  it('失败退避、成功复位', async () => {
    const seq: QuotaResult[] = [NET, NET, OK, OK]
    let i = 0
    const run = vi.fn(async () => seq[Math.min(i++, seq.length - 1)]!)
    const { sched } = make(run)
    sched.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(run).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1999)   // 第 1 次失败 → 2×周期
    expect(run).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(run).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(3999)   // 第 2 次失败 → 4×周期
    expect(run).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(run).toHaveBeenCalledTimes(3)      // 这次成功
    await vi.advanceTimersByTimeAsync(1000)   // 复位回 1×周期
    expect(run).toHaveBeenCalledTimes(4)
    sched.stop()
  })

  it('missing_key / missing_tool 不退避 —— 本机还没接上，重试只是一次 Keychain 读', async () => {
    const run = vi.fn(async (): Promise<QuotaResult> => ({ ok: false, code: 'missing_key' }))
    const { sched } = make(run)
    sched.start()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(1000)
    expect(run).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1000)
    expect(run).toHaveBeenCalledTimes(3)
    sched.stop()
  })

  it('stop 之后不再排下一轮', async () => {
    const run = vi.fn(async () => OK)
    const { sched } = make(run)
    sched.start()
    await vi.advanceTimersByTimeAsync(0)
    sched.stop()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('onResult 抛出不会打断这条链', async () => {
    const lines: string[] = []
    const run = vi.fn(async () => OK)
    const sched = new Scheduler(
      [{ name: 't', intervalMs: 1000, run, onResult: () => { throw new Error('boom') } }],
      { rand: () => 0.5, log: l => lines.push(l) }
    )
    sched.start()
    await vi.advanceTimersByTimeAsync(1000)
    expect(run).toHaveBeenCalledTimes(2)
    expect(lines.some(l => l.includes('onResult threw'))).toBe(true)
    sched.stop()
  })
})
