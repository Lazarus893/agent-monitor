/**
 * 事件流的四条规则：去重、按会话收束、排序、未读判定，外加 running 超时清除。
 * 这是三家 collector 共用的那一层，所有「屏上为什么是这个顺序 / 为什么响了铃」的问题都落在这里。
 */

import { describe, expect, it } from 'vitest'
import { Feed, sortFeed } from '../../../src/main/collectors/events/feed.js'
import type { EventInput } from '../../../src/main/collectors/events/types.js'
import { RUNNING_TIMEOUT_MS } from '../../../src/main/collectors/events/types.js'
import type { AgentEvent } from '../../../src/shared/types.js'

const at = (min: number): string => new Date(Date.UTC(2026, 8, 14, 10, min)).toISOString()

const ev = (over: Partial<EventInput> = {}): EventInput => ({
  id: 'e1',
  agent: 'codex',
  kind: 'completed',
  title: '一件事',
  at: at(0),
  updatedAt: at(0),
  sessionId: 's1',
  ...over
})

describe('去重', () => {
  it('同 id 只进一次', () => {
    const f = new Feed()
    expect(f.ingest(ev(), true)).not.toBeNull()
    expect(f.ingest(ev(), true)).toBeNull()
    expect(f.list()).toHaveLength(1)
  })

  it('被裁剪掉的旧事件不会因为再次到达而复活', () => {
    const f = new Feed()
    for (let i = 0; i < 205; i++) f.ingest(ev({ id: 'e' + i, sessionId: 's' + i, at: at(i % 60) }), false)
    expect(f.list().length).toBeLessThanOrEqual(200)
    const before = f.list().length
    f.ingest(ev({ id: 'e0', sessionId: 's0' }), true)
    expect(f.list().length).toBe(before)
  })
})

describe('按会话收束', () => {
  it('同一个 session 只占一行：running 被 completed 顶掉', () => {
    const f = new Feed()
    f.ingest(ev({ id: 'r1', kind: 'running', at: at(0), startedAt: at(0) }), false)
    f.ingest(ev({ id: 'c1', kind: 'completed', at: at(5), updatedAt: at(5) }), true)
    expect(f.list()).toHaveLength(1)
    expect(f.list()[0]!.kind).toBe('completed')
  })

  it('没有 sessionId 的事件互不覆盖', () => {
    const f = new Feed()
    const strip = (o: Partial<EventInput>): EventInput => {
      const e = ev(o)
      delete e.sessionId
      return e
    }
    f.ingest(strip({ id: 'a' }), false)
    f.ingest(strip({ id: 'b' }), false)
    expect(f.list()).toHaveLength(2)
  })
})

describe('排序', () => {
  it('running 置顶，其余按 updatedAt 倒序', () => {
    const rows: AgentEvent[] = [
      { ...ev({ id: 'old', at: at(1), updatedAt: at(1) }), acked: true },
      { ...ev({ id: 'new', at: at(9), updatedAt: at(9) }), acked: true },
      { ...ev({ id: 'run', kind: 'running', at: at(3), updatedAt: at(3) }), acked: true }
    ]
    expect(sortFeed(rows).map(r => r.id)).toEqual(['run', 'new', 'old'])
  })

  it('updatedAt 缺失时退回 at', () => {
    const mk = (id: string, t: string): AgentEvent => {
      const e = { ...ev({ id, at: t }), acked: true }
      delete e.updatedAt
      return e
    }
    expect(sortFeed([mk('a', at(1)), mk('b', at(5))]).map(r => r.id)).toEqual(['b', 'a'])
  })
})

describe('未读判定', () => {
  it('启动之后新到的才未读；回灌的一律已读', () => {
    const f = new Feed()
    expect(f.ingest(ev({ id: 'old' }), false)!.acked).toBe(true)
    expect(f.ingest(ev({ id: 'fresh', sessionId: 's2' }), true)!.acked).toBe(false)
    expect(f.unread()).toBe(1)
  })

  it('running 行不计未读（它不是「做完了一件事」）', () => {
    const f = new Feed()
    expect(f.ingest(ev({ kind: 'running' }), true)!.acked).toBe(true)
    expect(f.unread()).toBe(0)
  })

  it('restore 把全部标成已读 —— 重启后不重复报警', () => {
    const f = new Feed()
    f.restore([
      { ...ev({ id: 'a' }), acked: false },
      { ...ev({ id: 'b', sessionId: 's2' }), acked: false }
    ])
    expect(f.unread()).toBe(0)
    // 同 id 再来一次也不会变新
    expect(f.ingest(ev({ id: 'a' }), true)).toBeNull()
  })

  it('ack 只生效一次', () => {
    const f = new Feed()
    f.ingest(ev({ id: 'x' }), true)
    expect(f.ack('x')).toBe(true)
    expect(f.ack('x')).toBe(false)
    expect(f.unread()).toBe(0)
  })
})

describe('per-agent 状态', () => {
  it('attention > running > idle', () => {
    const f = new Feed()
    expect(f.statusFor('codex')).toBe('idle')
    f.ingest(ev({ id: 'r', kind: 'running', sessionId: 'sr' }), false)
    expect(f.statusFor('codex')).toBe('running')
    f.ingest(ev({ id: 'a', kind: 'attention', sessionId: 'sa' }), true)
    expect(f.statusFor('codex')).toBe('attention')
    f.ack('a')
    expect(f.statusFor('codex')).toBe('running')
  })

  it('只看自己那一家', () => {
    const f = new Feed()
    f.ingest(ev({ id: 'r', agent: 'zcode', kind: 'running' }), false)
    expect(f.statusFor('zcode')).toBe('running')
    expect(f.statusFor('codex')).toBe('idle')
  })

  it('clearAttention 把未读的 attention 标已读', () => {
    const f = new Feed()
    f.ingest(ev({ id: 'a', kind: 'attention' }), true)
    expect(f.clearAttention()).toBe(true)
    expect(f.statusFor('codex')).toBe('idle')
    expect(f.clearAttention()).toBe(false)
  })
})

describe('running 超时', () => {
  const t0 = Date.parse(at(0))

  it('两小时没收尾就被清掉', () => {
    const f = new Feed()
    f.ingest(ev({ id: 'r', kind: 'running', startedAt: at(0) }), false)
    expect(f.sweepRunning(t0 + RUNNING_TIMEOUT_MS - 1000)).toHaveLength(0)
    expect(f.sweepRunning(t0 + RUNNING_TIMEOUT_MS + 1000)).toHaveLength(1)
    expect(f.list()).toHaveLength(0)
    expect(f.statusFor('codex')).toBe('idle')
  })

  it('已完成的行不受影响', () => {
    const f = new Feed()
    f.ingest(ev({ id: 'c', at: at(0) }), false)
    expect(f.sweepRunning(t0 + RUNNING_TIMEOUT_MS * 10)).toHaveLength(0)
    expect(f.list()).toHaveLength(1)
  })
})
