/**
 * Codex rollout 解析 + 增量读取。
 * 样本取自本机真实 rollout 文件的形状（字段与嵌套一字未改），标题与 cwd 换成合成值。
 */

import { describe, expect, it } from 'vitest'
import { mkdtempSync, appendFileSync, utimesSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CodexEvents, attentionTypes, basenameSession, listRollouts, newSession, parseLine
} from '../../../src/main/collectors/events/codex.js'
import type { EventInput, EventSink } from '../../../src/main/collectors/events/types.js'
import type { AgentId, AgentStatus } from '../../../src/shared/types.js'

const FIX = join(process.cwd(), 'tests', 'fixtures', 'events')
const lines = (name: string): string[] =>
  readFileSync(join(FIX, name), 'utf8').split('\n').filter(l => l.trim())

function run(name: string): { events: EventInput[]; session: ReturnType<typeof newSession> } {
  const s = newSession('unknown')
  const events: EventInput[] = []
  for (const l of lines(name)) {
    const e = parseLine(l, s, new Set())
    if (e) events.push(e)
  }
  return { events, session: s }
}

function sink(): EventSink & { events: EventInput[]; logs: string[]; statuses: string[] } {
  const events: EventInput[] = []
  const logs: string[] = []
  const statuses: string[] = []
  return {
    events, logs, statuses,
    emit: (e: EventInput) => { events.push(e) },
    status: (a: AgentId, st: AgentStatus) => { statuses.push(`${a}:${st}`) },
    log: (l: string) => { logs.push(l) }
  }
}

describe('parseLine', () => {
  it('从 session_meta 取 session id 与 cwd', () => {
    const { session } = run('codex-rollout.jsonl')
    expect(session.sessionId).toBe('01a08ac2-a8b0-7e01-8a3a-7b7390a4dd76')
    expect(session.cwd).toBe('/private/tmp/sample-workspace')
  })

  it('跳过以 < 开头的系统块，用真正的用户提问作标题', () => {
    const { events } = run('codex-rollout.jsonl')
    const done = events.find(e => e.kind === 'completed')!
    expect(done.title).toBe('把增量解析补上 fixture 回归')
  })

  it('task_complete 带 last_agent_message 时只取首段作摘要', () => {
    const done = run('codex-rollout.jsonl').events.find(e => e.kind === 'completed')!
    expect(done.summary).toBe('已新增 6 个解析用例。')
    expect(done.durationMs).toBe(5876)
    expect(done.id).toBe('codex:01a08ac2-a8b0-7e01-8a3a-7b7390a4dd76:01a08ac2-aab2-7c20-8bca-71be4c9aaf85')
  })

  it('turn_context 的 model 被记下来（B 页 topModel 用）', () => {
    expect(run('codex-rollout.jsonl').session.model).toBe('gpt-6-astra')
  })

  it('payload.error 非空 → failed；畸形行跳过不崩', () => {
    const { events } = run('codex-failed.jsonl')
    const last = events[events.length - 1]!
    expect(last.kind).toBe('failed')
    // user_message 也能当标题
    expect(last.title).toBe('回复ok')
  })

  it('task_started 产生 running 行，task_complete 之后不再 running', () => {
    const { events, session } = run('codex-rollout.jsonl')
    expect(events.some(e => e.kind === 'running')).toBe(true)
    expect(session.running).toBe(false)
  })

  it('审批事件名默认为空（本机全量扫描证明 rollout 里没有这类事件）', () => {
    expect(attentionTypes('').size).toBe(0)
    expect([...attentionTypes('exec_approval_request, foo')]).toEqual(['exec_approval_request', 'foo'])
  })

  it('配上名字之后能认出 attention', () => {
    const s = newSession('s')
    const ev = parseLine(
      '{"timestamp":"2026-09-14T12:00:00.000Z","type":"event_msg",' +
      '"payload":{"type":"exec_approval_request","command":"rm -rf /"}}',
      s, new Set(['exec_approval_request'])
    )
    expect(ev?.kind).toBe('attention')
    expect(s.attention).toBe(true)
  })

  it('用户发话解除 attention', () => {
    const s = newSession('s')
    s.attention = true
    parseLine('{"type":"event_msg","payload":{"type":"user_message","message":"继续"}}', s, new Set())
    expect(s.attention).toBe(false)
  })
})

describe('basenameSession', () => {
  it('从文件名取 session id', () => {
    expect(basenameSession('/x/rollout-2026-09-10T18-00-08-01a08ac2-a8b0-7e01-8a3a-7b7390a4dd76.jsonl'))
      .toBe('01a08ac2-a8b0-7e01-8a3a-7b7390a4dd76')
  })
})

describe('增量读取', () => {
  it('只读新追加的行，offset 跟着走；半行留到下一轮', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-'))
    const file = join(dir, 'rollout-2026-09-14T10-00-00-01a08ac2-a8b0-7e01-8a3a-7b7390a4dd76.jsonl')
    const src = lines('codex-rollout.jsonl')
    writeFileSync(file, src.slice(0, 3).join('\n') + '\n')

    const sk = sink()
    const c = new CodexEvents(sk, dir)
    await c.start()
    const afterFirst = sk.events.length
    expect(afterFirst).toBeGreaterThan(0)
    expect(await listRollouts(dir)).toEqual([file])

    // 半行：先追加不带换行的一段，这一轮不该产出任何东西
    appendFileSync(file, src[3]!.slice(0, 20))
    await c.tick()
    // 补全剩下的部分 + 最后一行
    appendFileSync(file, src[3]!.slice(20) + '\n' + src[4] + '\n')
    await new Promise(r => setTimeout(r, 50))
    await c.tick()
    c.stop()

    const done = sk.events.filter(e => e.kind === 'completed')
    expect(done).toHaveLength(1)
    expect(done[0]!.title).toBe('把增量解析补上 fixture 回归')
    // 同一条不会因为重扫而重复产出
    expect(sk.events.filter(e => e.id === done[0]!.id)).toHaveLength(1)
  })

  /**
   * 复核 P1-③：启动时被跳过的老文件必须记 offset。
   * `codex resume` 一个 >24 h 前的会话会把它重新写起来，那时若从 0 读整份，
   * 里面每一条历史 task_complete 都会以「新事件」被推上去 —— 一串铃 + 一串跳 C 页。
   */
  it('resume 一个 >24 h 前的老会话：只报新追加的那一条，不重放整份历史', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-old-'))
    const file = join(dir, 'rollout-2026-09-01T10-00-00-01a08ac2-a8b0-7e01-8a3a-7b7390a4dd77.jsonl')
    writeFileSync(file, lines('codex-rollout.jsonl').join('\n') + '\n')
    // 把 mtime 推到 48 h 前
    const old = (Date.now() - 48 * 3600_000) / 1000
    utimesSync(file, old, old)

    const sk = sink()
    const c = new CodexEvents(sk, dir)
    await c.start()
    expect(sk.events).toEqual([])            // 老文件一行都不解析

    // 用户 resume：文件被追加
    appendFileSync(file, JSON.stringify({
      timestamp: new Date().toISOString(), type: 'event_msg',
      payload: { type: 'task_complete', turn_id: 'resumed', last_agent_message: '续写完成', error: null }
    }) + '\n')
    await c.tick()
    c.stop()

    expect(sk.events).toHaveLength(1)
    expect(sk.events[0]!.id).toContain('resumed')
  })

  it('文件被截断时会话状态跟着复位（标题不会张冠李戴）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-tr-'))
    const file = join(dir, 'rollout-2026-09-14T10-00-00-01a08ac2-a8b0-7e01-8a3a-7b7390a4dd78.jsonl')
    writeFileSync(file, lines('codex-rollout.jsonl').join('\n') + '\n')
    const sk = sink()
    const c = new CodexEvents(sk, dir)
    await c.start()
    const before = sk.events.length

    // 换成另一份更短的内容（旧标题不该留下来）
    writeFileSync(file, lines('codex-failed.jsonl').slice(0, 2).join('\n') + '\n' +
      JSON.stringify({
        timestamp: new Date().toISOString(), type: 'event_msg',
        payload: { type: 'task_complete', turn_id: 'after-truncate', error: null }
      }) + '\n')
    await c.tick()
    c.stop()
    const last = sk.events[sk.events.length - 1]!
    expect(sk.events.length).toBeGreaterThan(before)
    expect(last.title).toBe('回复ok')          // 不是上一份的「把增量解析补上…」
  })

  it('目录不存在时不崩，事件表为空', async () => {
    const sk = sink()
    const c = new CodexEvents(sk, join(tmpdir(), 'does-not-exist-' + Date.now()))
    await c.start()
    c.stop()
    expect(sk.events).toEqual([])
  })
})
