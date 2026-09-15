/**
 * F 页心跳层（M5）：增量折算、账本派生、子进程行解析。
 *
 * 这三块都是纯函数，而它们恰好是整条链上**唯一**没法在实机上一眼看出错的部分：
 * 拼音上屏那个负增量折错了，屏上只是数字慢慢偏，没人会当场发现。
 */

import { describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IME_WINDOW_MS, MAX_DELTA, PulseFolder } from '../../src/main/collectors/typing/pulse.js'
import type { Folded } from '../../src/main/collectors/typing/pulse.js'
import { Ledger, derive, fileIn, parse, shiftDate } from '../../src/main/collectors/typing/ledger.js'
import { parseLine } from '../../src/main/collectors/typing/index.js'
import { localDate } from '../../src/main/collectors/usage.js'

/** 账本最终看到的那个数 —— fold 现在给的是逐笔，加起来才是它 */
const sum = (r: Folded): number => r.entries.reduce((s, e) => s + e.n, 0)

describe('PulseFolder', () => {
  it('正增量：立刻出脉冲、立刻记账', () => {
    const f = new PulseFolder()
    expect(f.fold(1000, 1)).toEqual({ pulse: { at: 1000, delta: 1 }, entries: [{ at: 1000, n: 1 }] })
    expect(f.fold(1100, 3)).toEqual({ pulse: { at: 1100, delta: 3 }, entries: [{ at: 1100, n: 3 }] })
  })

  it('退格（−1）忽略：删一个字不代表没打过', () => {
    const f = new PulseFolder()
    f.fold(1000, 5)
    expect(f.fold(1200, -1)).toEqual({ entries: [] })
  })

  it('拼音上屏：扣回去，但只扣到本波挣到的那些', () => {
    const f = new PulseFolder()
    // wo xiang xie → 10 个字母
    f.fold(1000, 10)
    // 上屏成「我想写」：10 − 3 = −7
    const r = f.fold(1500, -7)
    expect(r.pulse).toBeUndefined()
    expect(sum(r)).toBe(-7)
  })

  it('回落比本波大时封底在本波（不能扣到之前的字）', () => {
    const f = new PulseFolder()
    f.fold(1000, 4)
    expect(sum(f.fold(1200, -30))).toBe(-4)
    // 本波已经扣光，紧接着再来一个负值就没得扣了
    expect(sum(f.fold(1300, -5))).toBe(0)
  })

  it('超过 3 s 的回落不算这一波', () => {
    const f = new PulseFolder()
    f.fold(1000, 10)
    expect(sum(f.fold(1000 + IME_WINDOW_MS + 1, -7))).toBe(0)
    // 边界：正好 3 s 仍然算
    const g = new PulseFolder()
    g.fold(1000, 10)
    expect(sum(g.fold(1000 + IME_WINDOW_MS, -7))).toBe(-7)
  })

  it('大于 30 的增量一律不来（粘贴 / 整段替换）', () => {
    const f = new PulseFolder()
    expect(f.fold(1000, MAX_DELTA + 1)).toEqual({ entries: [] })
    expect(f.fold(1000, -(MAX_DELTA + 1))).toEqual({ entries: [] })
    // 粘贴之后那一波不该留下可扣的余额
    f.fold(1100, 2)
    expect(sum(f.fold(1200, -10))).toBe(-2)
  })

  it('0 与非整数不记账', () => {
    const f = new PulseFolder()
    expect(f.fold(1000, 0)).toEqual({ entries: [] })
    expect(f.fold(1000, 1.5)).toEqual({ entries: [] })
    expect(f.fold(1000, Number.NaN)).toEqual({ entries: [] })
  })

  it('逐笔带着挣到它的那一刻，且从最近的一笔往回扣', () => {
    const f = new PulseFolder()
    f.fold(1000, 4)
    f.fold(1200, 3)
    // 扣 5：先扣光 1200 那笔的 3，再从 1000 那笔里扣 2
    expect(f.fold(1400, -5).entries).toEqual([{ at: 1200, n: -3 }, { at: 1000, n: -2 }])
    // 1000 那笔还剩 2，可以继续扣
    expect(f.fold(1500, -9).entries).toEqual([{ at: 1000, n: -2 }])
  })

  /**
   * 跨零点那一秒是整条链上最容易错、又最难复现的地方：
   * 23:59:59 敲下的字母在 00:00:01 上屏，那笔回落属于**昨天**那一格。
   * 按消息时刻记的话昨天凭空多几个字、今天凭空欠几个字，两天都错，
   * 而且一年只有 365 次机会撞上。
   */
  it('23:59:59 敲的字母在 00:00:01 上屏，扣的是昨天', () => {
    const before = new Date(2026, 8, 14, 23, 59, 59).getTime()
    const after = new Date(2026, 8, 15, 0, 0, 1).getTime()
    const f = new PulseFolder()
    f.fold(before, 10)
    const back = f.fold(after, -7)
    expect(back.entries).toEqual([{ at: before, n: -7 }])
    expect(localDate(new Date(back.entries[0]!.at))).toBe('2026-09-14')
    expect(localDate(new Date(after))).toBe('2026-09-15')
  })
})

/**
 * spawn 失败时 Node 只发 'error' + 'close'，**不发 'exit'** ——
 * collector 的「置 offline + 退避重启」就是因此绑在 'close' 上的（见 typing/index.ts 的 onGone）。
 * 这条是给那个假设上的锁：Node 哪天改了行为，这里先红，而不是等实机上
 * F 页永远停在「Midi 正在醒来」才有人发现。
 */
describe('子进程收尾的事件契约', () => {
  it('二进制不存在时 close 一定来、exit 不来', async () => {
    const child = spawn(join(tmpdir(), 'agent-monitor-no-such-helper-ax-pulse'), [],
      { stdio: ['pipe', 'pipe', 'pipe'] })
    const seen: string[] = []
    child.on('error', () => seen.push('error'))
    child.on('exit', () => seen.push('exit'))
    await new Promise<void>(r => child.on('close', () => { seen.push('close'); r() }))
    expect(seen).toContain('error')
    expect(seen).toContain('close')
    expect(seen).not.toContain('exit')
  })
})

describe('ledger derive', () => {
  it('今日 / 昨天 / streak 含今天', () => {
    const days = { '2026-09-12': 100, '2026-09-13': 200, '2026-09-14': 300 }
    expect(derive(days, '2026-09-14')).toEqual({ today: 300, yesterday: 200, streak: 3 })
  })

  it('今天还是 0 时从昨天往回数（早上八点不该看到 streak 清零）', () => {
    const days = { '2026-09-12': 100, '2026-09-13': 200 }
    expect(derive(days, '2026-09-14')).toEqual({ today: 0, yesterday: 200, streak: 2 })
  })

  it('今天 0、昨天也 0 → streak 0', () => {
    expect(derive({ '2026-09-10': 5 }, '2026-09-14')).toEqual({ today: 0, yesterday: 0, streak: 0 })
  })

  it('账本里没有昨天就是 0，中间断一天就断在那儿', () => {
    const days = { '2026-09-11': 10, '2026-09-13': 20, '2026-09-14': 30 }
    expect(derive(days, '2026-09-14')).toEqual({ today: 30, yesterday: 20, streak: 2 })
  })

  it('跨月往回数走本地日历', () => {
    expect(shiftDate('2026-09-01', -1)).toBe('2026-08-31')
    const days = { '2026-08-31': 1, '2026-09-01': 2 }
    expect(derive(days, '2026-09-01').streak).toBe(2)
  })
})

describe('ledger parse / 落盘', () => {
  it('坏掉的一天不该让整份账本作废', () => {
    const got = parse({ version: 1, days: { '2026-09-14': 10, 'nope': 3, '2026-09-13': -5, '2026-09-12': 'x' } })
    expect(got).toEqual({ '2026-09-14': 10 })
  })

  it('不是对象 / 没有 days → 空表，不抛', () => {
    expect(parse(null)).toEqual({})
    expect(parse({ version: 1 })).toEqual({})
  })

  it('add 之后 flush 能读回来，且一天不会是负数', () => {
    const dir = mkdtempSync(join(tmpdir(), 'typing-'))
    const l = new Ledger(dir)
    l.add('2026-09-14', 5)
    l.add('2026-09-14', -20)
    l.flush()
    const raw = JSON.parse(readFileSync(fileIn(dir), 'utf8')) as { version: number; days: Record<string, number> }
    expect(raw.version).toBe(1)
    expect(raw.days['2026-09-14']).toBe(0)
    // 回灌：新开一份账本读到的就是盘上那一份
    expect(new Ledger(dir).derive('2026-09-14').today).toBe(0)
  })
})

describe('parseLine', () => {
  it('两种正常行', () => {
    expect(parseLine('{"status":"ok"}')).toEqual({ kind: 'status', status: 'ok' })
    expect(parseLine('{"status":"untrusted"}')).toEqual({ kind: 'status', status: 'untrusted' })
    expect(parseLine('{"t":1700000000000,"d":-3}')).toEqual({ kind: 'pulse', t: 1700000000000, d: -3 })
  })

  it('坏行一律 null，不抛', () => {
    for (const bad of ['', '   ', 'not json', '{', '[]', 'null', '{"status":"weird"}',
      '{"t":"x","d":1}', '{"d":1}', '{"t":1,"d":1.5}', '{"t":1}']) {
      expect(parseLine(bad), bad).toBeNull()
    }
  })
})
