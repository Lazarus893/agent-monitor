/**
 * ZCode tasks 表的 diff 与状态映射。
 * 端到端那一条用真的 `sqlite3` 建一个临时库 —— 采集走的就是 spawn 系统 sqlite3 这条路，
 * 用假数据打桩就验不到「-json 的输出到底长什么样」。
 */

import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  QUERY, SQLITE, ZcodeEvents, diff, kindFor, modelName, pendingMode, queryRows
} from '../../../src/main/collectors/events/zcode.js'
import type { TaskRow } from '../../../src/main/collectors/events/zcode.js'
import type { EventInput, EventSink } from '../../../src/main/collectors/events/types.js'
import type { AgentId, AgentStatus } from '../../../src/shared/types.js'

const row = (over: Partial<TaskRow> = {}): TaskRow => ({
  workspace_key: 'w1',
  task_id: 't1',
  title: '训练集 b4 批次转写',
  task_status: 'completed',
  model: 'builtin:bigmodel-coding-plan/GLM-5.3-Flash',
  workspace_path: '/Users/x/Projects/demo',
  updated_at: 1789386316203,
  ...over
})

function sink(): EventSink & { events: EventInput[]; logs: string[]; statuses: string[] } {
  const events: EventInput[] = []
  const logs: string[] = []
  const statuses: string[] = []
  return {
    events, logs, statuses,
    emit: (e: EventInput) => { events.push(e) },
    status: (a: AgentId, s: AgentStatus) => { statuses.push(`${a}:${s}`) },
    log: (l: string) => { logs.push(l) }
  }
}

describe('kindFor', () => {
  it('五种已知状态', () => {
    expect(kindFor('running', 'running')).toBe('running')
    expect(kindFor('completed', 'running')).toBe('completed')
    expect(kindFor('failed', 'running')).toBe('failed')
    expect(kindFor('cancelled', 'running')).toBe('failed')
    expect(kindFor('whatever', 'running')).toBeNull()
    expect(kindFor(null, 'running')).toBeNull()
  })

  it('pending 的语义未实测：默认按 running，可切 attention / ignore', () => {
    expect(kindFor('pending', 'running')).toBe('running')
    expect(kindFor('pending', 'attention')).toBe('attention')
    expect(kindFor('pending', 'ignore')).toBeNull()
    expect(pendingMode(undefined)).toBe('running')
    expect(pendingMode('attention')).toBe('attention')
    expect(pendingMode('nonsense')).toBe('running')
  })
})

describe('modelName', () => {
  it('去掉 builtin 前缀', () => {
    expect(modelName('builtin:bigmodel-coding-plan/GLM-5.3-Flash')).toBe('GLM-5.3-Flash')
    expect(modelName('GLM-5.3')).toBe('GLM-5.3')
    expect(modelName(null)).toBe('')
  })
})

describe('diff', () => {
  it('第一轮全是新的', () => {
    const r = diff([row(), row({ task_id: 't2' })], new Map(), 'running')
    expect(r.events).toHaveLength(2)
  })

  it('同一份数据再来一轮不产生事件', () => {
    const first = diff([row()], new Map(), 'running')
    const second = diff([row()], first.seen, 'running')
    expect(second.events).toHaveLength(0)
  })

  it('状态或 updated_at 变了才产生事件', () => {
    const a = diff([row({ task_status: 'running', updated_at: 1 })], new Map(), 'running')
    const b = diff([row({ task_status: 'completed', updated_at: 2 })], a.seen, 'running')
    expect(b.events).toHaveLength(1)
    expect(b.events[0]!.kind).toBe('completed')
    expect(b.events[0]!.sessionId).toBe('t1')
  })

  it('主键带 workspace：两个工作区的同名 task_id 互不覆盖', () => {
    const rows = [row({ workspace_key: 'w1' }), row({ workspace_key: 'w2' })]
    const r = diff(rows, new Map(), 'running')
    expect(r.events).toHaveLength(2)
    expect(r.seen.size).toBe(2)
  })

  it('未知状态的行只记 seen，不产生事件', () => {
    const r = diff([row({ task_status: 'archived' })], new Map(), 'running')
    expect(r.events).toHaveLength(0)
    expect(r.seen.size).toBe(1)
  })

  it('毫秒 epoch 被还原成 ISO', () => {
    const e = diff([row({ updated_at: 1789386316203 })], new Map(), 'running').events[0]!
    expect(e.at).toBe(new Date(1789386316203).toISOString())
    expect(e.updatedAt).toBe(e.at)
  })
})

describe('真实 sqlite3 往返', () => {
  const has = existsSync(SQLITE)
  it.skipIf(!has)('建库 → 采一轮 → 改一行状态 → 只多出这一条事件', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zc-'))
    const db = join(dir, 'tasks-index.sqlite')
    execFileSync(SQLITE, [db, `
      create table tasks (workspace_key text, task_id text, title text, task_status text,
        model text, workspace_path text, updated_at integer, deleted integer default 0,
        primary key (workspace_key, task_id));
      insert into tasks values ('w1','t1','已完成的任务','completed',
        'builtin:bigmodel-coding-plan/GLM-5.3-Flash','/tmp/w',1789386316203,0);
      insert into tasks values ('w1','t2','删掉的任务','completed','x','/tmp/w',1789386316000,1);
    `])

    expect(await queryRows(db, QUERY)).toHaveLength(1) // deleted=0 过滤生效

    const sk = sink()
    const c = new ZcodeEvents(sk, db, 10_000)
    await c.start()          // 第一轮回灌
    const afterBoot = sk.events.length
    expect(afterBoot).toBe(1)

    execFileSync(SQLITE, [db,
      "update tasks set task_status='running', updated_at=1789386400000 where task_id='t1'"])
    await c.tick()
    c.stop()
    expect(sk.events.length).toBe(afterBoot + 1)
    expect(sk.events[afterBoot]!.kind).toBe('running')
  })

  it('DB 不存在 → 该事件源 offline，不崩', async () => {
    const sk = sink()
    const c = new ZcodeEvents(sk, join(tmpdir(), 'no-such-' + Date.now() + '.sqlite'), 10_000)
    await c.start()
    c.stop()
    expect(sk.statuses).toContain('zcode:offline')
    expect(sk.events).toEqual([])
  })
})
