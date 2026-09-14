/**
 * 调度器的 kick 与「强制失败」这两个开关。
 * 它们不在采集路径上，却是 dev.forceError（断网/缺 Key 演练）的全部机制 ——
 * M2 复核 §4.2c 指出这两处零覆盖，补上。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Scheduler } from '../../src/main/collectors/scheduler.js'
import { applyFakeErrorEnv, setForcedError } from '../../src/main/collectors/quota/index.js'
import type { AgentId } from '../../src/shared/types.js'
import type { QuotaResult } from '../../src/main/collectors/quota/types.js'

const OK: QuotaResult = { ok: true, windows: [{ label: '5h', usedPercent: 1, resetsAt: '2026-09-14T20:00:00+08:00' }] }
const IDS: AgentId[] = ['codex', 'claude', 'zcode']

describe('Scheduler.kick', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('立刻重采一轮，并把原来排好的定时器换掉', async () => {
    const run = vi.fn(async () => OK)
    const sched = new Scheduler([{ name: 't', intervalMs: 60_000, run, onResult: () => {} }],
      { rand: () => 0.5, log: () => {} })
    sched.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(run).toHaveBeenCalledTimes(1)
    sched.kick('t')
    await vi.advanceTimersByTimeAsync(0)
    expect(run).toHaveBeenCalledTimes(2)        // 没等满 60 s
    await vi.advanceTimersByTimeAsync(60_000)
    expect(run).toHaveBeenCalledTimes(3)        // 周期照常续上，没有被 kick 打乱成两条链
    sched.stop()
  })

  it('名字不对、已停、或正在采时都是空操作（不并发）', async () => {
    const gate: { release: (() => void) | null } = { release: null }
    const run = vi.fn(() => new Promise<QuotaResult>(r => { gate.release = () => r(OK) }))
    const sched = new Scheduler([{ name: 't', intervalMs: 60_000, run, onResult: () => {} }],
      { rand: () => 0.5, log: () => {} })
    sched.start()
    await vi.advanceTimersByTimeAsync(0)
    sched.kick('t')            // 上一轮还没落地
    sched.kick('不存在的名字')
    await vi.advanceTimersByTimeAsync(0)
    expect(run).toHaveBeenCalledTimes(1)
    gate.release?.()
    sched.stop()
    sched.kick('t')            // 停了之后也不动
    await vi.advanceTimersByTimeAsync(0)
    expect(run).toHaveBeenCalledTimes(1)
  })
})

describe('setForcedError / applyFakeErrorEnv', () => {
  // 模块级状态：每条用例前后都清干净，免得互相污染
  const clearAll = (): void => { for (const id of IDS) setForcedError(id, null) }
  beforeEach(clearAll)
  afterEach(clearAll)

  it('设上再清掉：清掉一个没设过的返回 false', () => {
    expect(setForcedError('codex', 'network')).toBe(true)
    expect(setForcedError('codex', null)).toBe(true)
    expect(setForcedError('codex', null)).toBe(false)
  })

  it('只认白名单里的失败码，first_sample 这种不是采集失败的码进不来', () => {
    expect(setForcedError('zcode', 'first_sample')).toBe(false)
    expect(setForcedError('zcode', 'feed_error')).toBe(false)
    expect(setForcedError('zcode', null)).toBe(false)   // 上面两次都没设上
    expect(setForcedError('zcode', 'missing_key')).toBe(true)
  })

  it('MONITOR_FAKE_ERROR=network 给三家全套', () => {
    applyFakeErrorEnv('network', IDS)
    expect(IDS.map(id => setForcedError(id, null))).toEqual([true, true, true])
  })

  it('MONITOR_FAKE_ERROR=zcode:missing_key,codex:network 只点名的那两家', () => {
    applyFakeErrorEnv('zcode:missing_key, codex:network', IDS)
    expect(setForcedError('zcode', null)).toBe(true)
    expect(setForcedError('codex', null)).toBe(true)
    expect(setForcedError('claude', null)).toBe(false)
  })

  it('空值与无意义的值都是空操作', () => {
    applyFakeErrorEnv(undefined, IDS)
    applyFakeErrorEnv('  ', IDS)
    applyFakeErrorEnv('codex:不是个码', IDS)
    expect(IDS.map(id => setForcedError(id, null))).toEqual([false, false, false])
  })
})
