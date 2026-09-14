/**
 * 落盘与回灌 —— 验收第 4 条（重启 app 后历史事件不重复报警）的机械证据。
 */

import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Feed } from '../../../src/main/collectors/events/feed.js'
import { Saver, fileIn, load, parse, save, wouldWipe } from '../../../src/main/collectors/events/persist.js'
import type { AgentEvent } from '../../../src/shared/types.js'

const ev = (over: Partial<AgentEvent> = {}): AgentEvent => ({
  id: 'e1', agent: 'codex', kind: 'completed', title: '一件事',
  at: '2026-09-14T10:00:00.000Z', updatedAt: '2026-09-14T10:00:00.000Z',
  sessionId: 's1', acked: false, ...over
})

describe('往返', () => {
  it('写 → 读 → 全部已读', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ev-'))
    save(dir, [ev({ id: 'a' }), ev({ id: 'b', acked: true })])
    const back = load(dir)
    expect(back.map(e => e.id)).toEqual(['a', 'b'])
    expect(back.every(e => e.acked)).toBe(true)
  })

  it('running 行不落盘 —— 重启之后它一定已经不在跑了', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ev-'))
    save(dir, [ev({ id: 'r', kind: 'running' }), ev({ id: 'c' })])
    expect(load(dir).map(e => e.id)).toEqual(['c'])
  })

  it('0600 落盘，且是原子写（不留 .tmp）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ev-'))
    save(dir, [ev()])
    const text = readFileSync(fileIn(dir), 'utf8')
    expect(JSON.parse(text).version).toBe(1)
    expect(() => readFileSync(fileIn(dir) + '.tmp', 'utf8')).toThrow()
  })

  it('文件不存在 / 坏 JSON → 空表，不抛', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ev-'))
    expect(load(dir)).toEqual([])
    writeFileSync(fileIn(dir), '{ broken')
    expect(load(dir)).toEqual([])
  })

  it('逐条校验：坏掉的一条不让整份历史作废', () => {
    const good = ev({ id: 'ok' })
    expect(parse({
      events: [
        { id: 1 },                       // id 不是字符串
        { ...good, agent: 'nobody' },    // 不认识的 agent
        { ...good, kind: 'weird' },      // 不认识的 kind
        good
      ]
    }).map(e => e.id)).toEqual(['ok'])
  })
})

describe('重启语义', () => {
  it('恢复之后 collector 再推同一条也不会变成新事件', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ev-'))
    // 第一次运行：来了一条新事件，未读
    const f1 = new Feed()
    f1.ingest({ ...ev({ id: 'boom' }) }, true)
    expect(f1.unread()).toBe(1)
    save(dir, f1.list())

    // 重启
    const f2 = new Feed()
    f2.restore(load(dir))
    expect(f2.unread()).toBe(0)
    // Codex 的回灌会把同一条再读一遍 —— 它必须被去重挡掉
    expect(f2.ingest({ ...ev({ id: 'boom' }) }, true)).toBeNull()
    expect(f2.unread()).toBe(0)
  })
})

/**
 * 复核 P1-① 的回归：稳态重启（这一程没有任何新事件）不得把历史抹掉。
 */
describe('空表守卫（复核 P1-①）', () => {
  it('内存为空而盘上非空 → 拒绝落盘', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ev-'))
    save(dir, [ev({ id: 'keep' })])
    expect(wouldWipe(dir, [])).toBe(true)
    expect(save(dir, [])).toBe(false)
    expect(load(dir).map(e => e.id)).toEqual(['keep'])
  })

  it('盘上本来就空 → 空表可以写（那是真的没有历史）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ev-'))
    expect(wouldWipe(dir, [])).toBe(false)
    expect(save(dir, [])).toBe(true)
  })

  it('Saver 从没被 schedule 过就不写任何东西', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ev-'))
    save(dir, [ev({ id: 'keep' })])
    new Saver(dir).flush()                       // 一次 schedule 都没有
    expect(load(dir).map(e => e.id)).toEqual(['keep'])
  })

  it('稳态重启：restore → 全部被去重 → 退出，历史仍在', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ev-'))
    save(dir, [ev({ id: 'a' }), ev({ id: 'b', sessionId: 's2' })])

    // 第二程：Store 侧的 restoreEvents 会把回灌结果 schedule 一次
    const saver = new Saver(dir)
    const f = new Feed()
    f.restore(load(dir))
    saver.schedule(f.list())
    // 三家 collector 回灌，全部撞 id 被去重 —— 没有任何 onFeedChange
    expect(f.ingest({ ...ev({ id: 'a' }) }, false)).toBeNull()
    saver.flush()

    expect(load(dir).map(e => e.id).sort()).toEqual(['a', 'b'])
  })
})
