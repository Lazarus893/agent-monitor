/**
 * Claude hook 服务器的校验、hook → 事件的映射、transcript 尾部解析。
 * 服务器用端口 0（内核随便分一个），不碰真实的 47831。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ClaudeEvents, ensureToken, hookPort, kindFor, parseTranscript, readTranscript, titleFromCwd,
  tokenFile, tokenMatches, validate
} from '../../../src/main/collectors/events/claude.js'
import type { EventInput, EventSink } from '../../../src/main/collectors/events/types.js'
import type { AgentId, AgentStatus } from '../../../src/shared/types.js'

const FIX = join(process.cwd(), 'tests', 'fixtures', 'events')

function sink(): EventSink & { events: EventInput[]; logs: string[] } {
  const events: EventInput[] = []
  const logs: string[] = []
  return {
    events, logs,
    emit: (e: EventInput) => { events.push(e) },
    status: (_a: AgentId, _s: AgentStatus) => {},
    log: (l: string) => { logs.push(l) }
  }
}

describe('token', () => {
  it('首次生成 0600 的 token 文件，第二次读回同一个', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hooktok-'))
    const file = join(dir, 'sub', 'hook-token')
    const a = ensureToken(file)
    expect(a).toMatch(/^[0-9a-f]{48}$/)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(ensureToken(file)).toBe(a)
    expect(readFileSync(file, 'utf8').trim()).toBe(a)
  })

  it('定长比较：长度不同直接假，不抛', () => {
    expect(tokenMatches('abc', 'abc')).toBe(true)
    expect(tokenMatches('abcd', 'abc')).toBe(false)
    expect(tokenMatches(undefined, 'abc')).toBe(false)
    expect(tokenMatches('', 'abc')).toBe(false)
  })

  it('token 文件路径可用环境变量覆盖（selftest 的隔离靠它）', () => {
    expect(tokenFile('/tmp/x/hook-token')).toBe('/tmp/x/hook-token')
    expect(tokenFile(undefined)).toContain('.agent-monitor')
    expect(tokenFile('  ')).toContain('.agent-monitor')
  })

  it('端口可用环境变量覆盖，非法值回落 47831', () => {
    expect(hookPort(undefined)).toBe(47831)
    expect(hookPort('55123')).toBe(55123)
    expect(hookPort('nope')).toBe(47831)
    expect(hookPort('99999')).toBe(47831)
  })
})

describe('validate', () => {
  it('缺 hook_event_name / session_id 都是 400', () => {
    expect(validate({ session_id: 's' })?.status).toBe(400)
    expect(validate({ hook_event_name: 'Stop' })?.status).toBe(400)
    expect(validate('nope')?.status).toBe(400)
    expect(validate({ hook_event_name: 'Stop', session_id: 's' })).toBeNull()
  })
})

describe('kindFor', () => {
  it('四个事件各就各位', () => {
    expect(kindFor({ hook_event_name: 'UserPromptSubmit', session_id: 's' })).toBe('running')
    expect(kindFor({ hook_event_name: 'Stop', session_id: 's' })).toBe('completed')
    expect(kindFor({ hook_event_name: 'SessionEnd', session_id: 's' })).toBe('clear')
    expect(kindFor({ hook_event_name: 'PreToolUse', session_id: 's' })).toBeNull()
  })

  it('Notification 只有 permission 类算 attention，idle 类忽略', () => {
    expect(kindFor({
      hook_event_name: 'Notification', session_id: 's', notification_type: 'permission_prompt'
    })).toBe('attention')
    expect(kindFor({
      hook_event_name: 'Notification', session_id: 's', message: 'Claude needs your permission to use Write'
    })).toBe('attention')
    expect(kindFor({
      hook_event_name: 'Notification', session_id: 's', notification_type: 'idle_prompt'
    })).toBeNull()
  })
})

describe('transcript', () => {
  it('summary 行优先作标题，最后一条 assistant 首段作摘要，# 开头的用户块跳过', async () => {
    const r = await readTranscript(join(FIX, 'claude-transcript.jsonl'))
    expect(r.title).toBe('给 statusline 包一层 tee')
    expect(r.summary).toBe('脚本已就位，settings.json 已备份')
  })

  it('没有 summary 行时退回首条用户文本', () => {
    const text = [
      '{"type":"user","message":{"content":"# CLAUDE.md"}}',
      '{"type":"user","message":{"content":[{"type":"text","text":"真正的问题"}]}}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"回答"}]}}'
    ].join('\n')
    expect(parseTranscript(text, false)).toEqual({ title: '真正的问题', summary: '回答' })
  })

  it('从中间截断时丢掉第一行半行，畸形行跳过', () => {
    const text = 'half-of-a-line}\n{"type":"assistant","message":{"content":"尾"}}\nnot json'
    expect(parseTranscript(text, true).summary).toBe('尾')
  })

  it('文件不存在时返回空对象，不抛', async () => {
    expect(await readTranscript(join(tmpdir(), 'nope-' + Date.now()))).toEqual({})
  })
})

describe('hook 服务器', () => {
  let c: ClaudeEvents
  let sk: ReturnType<typeof sink>
  let token: string
  let url: string

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hooksrv-'))
    const tokenFile = join(dir, 'hook-token')
    sk = sink()
    c = new ClaudeEvents(sk, 0, tokenFile)
    await c.start()
    token = readFileSync(tokenFile, 'utf8').trim()
    url = `http://127.0.0.1:${c.address()}/hook`
  })
  afterAll(() => c.stop())

  const post = (body: string, headers: Record<string, string> = {}): Promise<Response> =>
    fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-monitor-token': token, ...headers },
      body
    })

  it('缺 token → 401', async () => {
    const r = await post('{}', { 'x-monitor-token': '' })
    expect(r.status).toBe(401)
  })

  it('错 token → 401', async () => {
    const r = await post('{}', { 'x-monitor-token': 'deadbeef' })
    expect(r.status).toBe(401)
  })

  it('非 JSON content-type → 415', async () => {
    const r = await post('{}', { 'content-type': 'text/plain' })
    expect(r.status).toBe(415)
  })

  it('非 JSON body → 400', async () => {
    expect((await post('not json')).status).toBe(400)
  })

  it('缺必填字段 → 400', async () => {
    expect((await post('{"hook_event_name":"Stop"}')).status).toBe(400)
  })

  it('超大 body → 413', async () => {
    const big = JSON.stringify({ hook_event_name: 'Stop', session_id: 's', pad: 'x'.repeat(70_000) })
    expect((await post(big)).status).toBe(413)
  })

  it('别的路径 → 404；GET → 404', async () => {
    expect((await fetch(`http://127.0.0.1:${c.address()}/`, { method: 'POST' })).status).toBe(404)
    expect((await fetch(url)).status).toBe(404)
  })

  it('合法的 Stop → 204，并产出一条 completed', async () => {
    const r = await post(JSON.stringify({
      hook_event_name: 'Stop', session_id: 'sess-1', cwd: '/tmp/w',
      transcript_path: join(FIX, 'claude-transcript.jsonl')
    }))
    expect(r.status).toBe(204)
    // 先应答再干活，等一拍
    await new Promise(res => setTimeout(res, 120))
    const ev = sk.events.find(e => e.kind === 'completed')
    expect(ev?.agent).toBe('claude')
    expect(ev?.title).toBe('给 statusline 包一层 tee')
    expect(ev?.sessionId).toBe('sess-1')
    expect(ev?.id.startsWith('claude:sess-1:')).toBe(true)
  })

  it('日志里不出现 transcript 正文、不出现 token', () => {
    for (const l of sk.logs) {
      expect(l).not.toContain(token)
      expect(l).not.toContain('第二段不要')
    }
  })
})

describe('ingest（不起服务器）', () => {
  it('UserPromptSubmit → running；Stop 带上耗时；SessionEnd 不产事件', async () => {
    const sk = sink()
    const c = new ClaudeEvents(sk, 0, join(mkdtempSync(join(tmpdir(), 'tk-')), 't'))
    const t0 = '2026-09-14T10:00:00.000Z'
    const t1 = '2026-09-14T10:00:42.000Z'
    const run = await c.ingest({ hook_event_name: 'UserPromptSubmit', session_id: 's' }, t0)
    expect(run?.kind).toBe('running')
    const done = await c.ingest({ hook_event_name: 'Stop', session_id: 's' }, t1)
    expect(done?.kind).toBe('completed')
    expect(done?.durationMs).toBe(42_000)
    expect(done?.updatedAt).toBe(t1)
    expect(await c.ingest({ hook_event_name: 'SessionEnd', session_id: 's' }, t1)).toBeNull()
  })

  it('permission 类 Notification 的 message 成为摘要（截断到 120 字）', async () => {
    const sk = sink()
    const c = new ClaudeEvents(sk, 0, join(mkdtempSync(join(tmpdir(), 'tk-')), 't'))
    const ev = await c.ingest({
      hook_event_name: 'Notification', session_id: 's',
      notification_type: 'permission_prompt', message: '等待 Write 权限确认'
    })
    expect(ev?.kind).toBe('attention')
    expect(ev?.summary).toBe('等待 Write 权限确认')
  })
})

describe('transcript 两头各读一段', () => {
  it('摘要取自尾部，超过预算的前半段不会被读进来', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tail-'))
    const file = join(dir, 't.jsonl')
    const filler = '{"type":"assistant","message":{"content":"早期回答"}}\n'.repeat(200)
    writeFileSync(file, filler + '{"type":"assistant","message":{"content":"最后一条"}}\n')
    const r = await readTranscript(file, 200)
    expect(r.summary).toBe('最后一条')
  })

  /**
   * 实机上 C1 页出现过一整行「(未命名会话)」：长会话里 summary 行还没写，
   * 首条用户提问又在文件开头，只读尾部必然取不到。
   */
  it('长会话没有 summary 行时，标题回到文件头的首条提问', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'head-'))
    const file = join(dir, 't.jsonl')
    writeFileSync(file,
      '{"type":"user","message":{"content":"把热力图的单位改成显式的"}}\n' +
      '{"type":"assistant","message":{"content":"早期回答"}}\n'.repeat(300) +
      '{"type":"assistant","message":{"content":"最后一条"}}\n')
    const r = await readTranscript(file, 200, 4096)
    expect(r.title).toBe('把热力图的单位改成显式的')
    expect(r.summary).toBe('最后一条')
  })

  it('尾部就有 summary 行时不去读文件头', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'head2-'))
    const file = join(dir, 't.jsonl')
    writeFileSync(file,
      '{"type":"user","message":{"content":"开头的提问"}}\n' +
      '{"type":"assistant","message":{"content":"x"}}\n'.repeat(200) +
      '{"type":"summary","summary":"会话摘要"}\n')
    expect((await readTranscript(file, 400, 4096)).title).toBe('会话摘要')
  })

  it('三级回退：transcript 取不到标题时用 cwd 末段，而不是「(未命名会话)」', async () => {
    expect(titleFromCwd('/Users/x/Projects/Monitor')).toBe('Monitor')
    expect(titleFromCwd('/')).toBe('')

    const sk = sink()
    const c = new ClaudeEvents(sk, 0, join(mkdtempSync(join(tmpdir(), 'tk-')), 't'))
    const ev = await c.ingest({
      hook_event_name: 'Stop', session_id: 's', cwd: '/Users/x/Projects/Monitor'
    })
    expect(ev?.title).toBe('Monitor')
  })
})
