/**
 * 会话标题索引：让 C1/C2 显示桌面端里那个标题，而不是首条提问。
 *
 * 样本是**实测**的（2026-09-15 本机），按 coordinator 的口径脱敏成 id / title / cwd 三个字段：
 *   tests/fixtures/titles/claude-sessions.json        —— 从 65 份 local_*.json 里取前 3 份
 *   tests/fixtures/titles/codex-session-index.jsonl   —— session_index.jsonl 的最后 3 行
 *
 * 这一层最容易出的错不是解析，是**时序**：标题在第一轮对话结束之后才生成，
 * 事件早就进列表了。所以用例的重点在「后到的标题能不能原地改名，且不把它当成新事件」。
 */

import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_CLAUDE_DIR, DEFAULT_CODEX_INDEX, TITLE_MAX, TitleIndex,
  claudeDir, codexIndex, parseClaudeSession, parseCodexIndexLine
} from '../../../src/main/collectors/events/titles.js'
import type { TitleHit } from '../../../src/main/collectors/events/titles.js'
import { Feed } from '../../../src/main/collectors/events/feed.js'
import type { EventInput } from '../../../src/main/collectors/events/types.js'

const FIX = join(process.cwd(), 'tests', 'fixtures', 'titles')
const CLAUDE = JSON.parse(readFileSync(join(FIX, 'claude-sessions.json'), 'utf8')) as Array<{
  cliSessionId: string; title: string; cwd: string
}>
const CODEX = readFileSync(join(FIX, 'codex-session-index.jsonl'), 'utf8')
  .split('\n').filter(l => l.trim())

describe('路径与覆盖', () => {
  it('默认指向两处桌面端的账本', () => {
    expect(DEFAULT_CLAUDE_DIR).toMatch(/Application Support\/Claude\/claude-code-sessions$/)
    expect(DEFAULT_CODEX_INDEX).toMatch(/\.codex\/session_index\.jsonl$/)
  })

  it('环境变量能挪走（selftest 用临时目录，绝不碰真实索引）', () => {
    expect(claudeDir('/tmp/a')).toBe('/tmp/a')
    expect(codexIndex('/tmp/b.jsonl')).toBe('/tmp/b.jsonl')
    expect(claudeDir('  ')).toBe(DEFAULT_CLAUDE_DIR)   // 空白当没给
    expect(codexIndex(undefined)).toBe(DEFAULT_CODEX_INDEX)
  })
})

describe('parseClaudeSession · 实测样本', () => {
  it('三份都取出 cliSessionId 与 title', () => {
    expect(CLAUDE.map(parseClaudeSession)).toEqual([
      { agent: 'claude', sessionId: 'c3d6b124-8b30-4602-96f6-baf3f462d7e2', title: 'V0.5 技能转写训练集问题' },
      { agent: 'claude', sessionId: '490084f6-072f-41ec-aeca-d0b235d0b178', title: 'Convert landscape photos to pixel stamp style' },
      { agent: 'claude', sessionId: '2cbff38b-2e58-44aa-bc2c-9924d42700d9', title: 'DSH插件审批请求文案' }
    ])
  })

  it('cliSessionId 就是 hook 的 session_id（uuid 形状）', () => {
    for (const c of CLAUDE) expect(c.cliSessionId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('缺字段 / 空标题 / 不是对象 → null，不抛', () => {
    expect(parseClaudeSession({ cliSessionId: 'x' })).toBeNull()
    expect(parseClaudeSession({ title: 'x' })).toBeNull()
    expect(parseClaudeSession({ cliSessionId: 'x', title: '   ' })).toBeNull()
    expect(parseClaudeSession({ cliSessionId: '  ', title: 'x' })).toBeNull()
    expect(parseClaudeSession(null)).toBeNull()
    expect(parseClaudeSession('不是对象')).toBeNull()
  })

  it('标题压成一行并截断 —— 它要进 C1 的一行里', () => {
    const hit = parseClaudeSession({ cliSessionId: 'a', title: '第一行\n第二行' })
    expect(hit!.title).toBe('第一行 第二行')
    const long = parseClaudeSession({ cliSessionId: 'a', title: '长'.repeat(200) })!
    expect(long.title.length).toBeLessThanOrEqual(TITLE_MAX + 1)   // clip 会补一个省略号
  })
})

describe('parseCodexIndexLine · 实测样本', () => {
  it('三行都取出 id 与 thread_name', () => {
    expect(CODEX.map(parseCodexIndexLine)).toEqual([
      { agent: 'codex', sessionId: '01a0708c-068f-7a91-be3d-bedb6524c013', title: '安装 Blender MCP' },
      { agent: 'codex', sessionId: '01a084fc-e92f-7761-a0d8-773f844983fb', title: '整理页面Skill详情' },
      { agent: 'codex', sessionId: '01a0853b-7564-7100-9260-a100fa439a47', title: '重构乌鸦侧影油画提示词' }
    ])
  })

  it('id 与 rollout 文件名里那个会话 id 同形', () => {
    for (const l of CODEX) {
      expect(parseCodexIndexLine(l)!.sessionId).toMatch(/^[0-9a-f-]{36}$/)
    }
  })

  it('坏行、空行、缺字段一律 null —— 一行毁不掉整份文件', () => {
    expect(parseCodexIndexLine('{ 这不是 json')).toBeNull()
    expect(parseCodexIndexLine('')).toBeNull()
    expect(parseCodexIndexLine('   ')).toBeNull()
    expect(parseCodexIndexLine('[1,2,3]')).toBeNull()
    expect(parseCodexIndexLine('{"id":"a"}')).toBeNull()
    expect(parseCodexIndexLine('{"thread_name":"x"}')).toBeNull()
  })
})

/** 造一个和实测同构的目录：<dir>/<uuid>/<uuid>/local_<uuid>.json（两层） */
function bed(): { dir: string; index: string; write(id: string, title: string): void } {
  const root = mkdtempSync(join(tmpdir(), 'titles-'))
  const dir = join(root, 'sessions')
  const index = join(root, 'session_index.jsonl')
  let n = 0
  return {
    dir,
    index,
    write(id: string, title: string): void {
      const deep = join(dir, `space-${n}`, `project-${n}`)
      mkdirSync(deep, { recursive: true })
      writeFileSync(join(deep, `local_${n}.json`), JSON.stringify({
        cliSessionId: id, title, cwd: '/tmp/x', titleSource: 'auto', isArchived: false
      }))
      n++
    }
  }
}

const sink = (): { hits: TitleHit[]; logs: string[]; title(h: TitleHit): void; log(l: string): void } => {
  const hits: TitleHit[] = []
  const logs: string[] = []
  return { hits, logs, title: h => { hits.push(h) }, log: l => { logs.push(l) } }
}

describe('TitleIndex · 扫描与增量', () => {
  it('Claude 的文件埋在两层目录下也找得到（层数是桌面端的实现细节，不能写死）', async () => {
    const b = bed()
    b.write('sess-1', '桌面端给的名字')
    const s = sink()
    const ti = new TitleIndex(s, b.dir, b.index)
    await ti.tick()
    expect(s.hits).toEqual([{ agent: 'claude', sessionId: 'sess-1', title: '桌面端给的名字' }])
    expect(ti.titleFor('claude', 'sess-1')).toBe('桌面端给的名字')
    ti.stop()
  })

  it('同一个标题重复扫到一百遍也只报一次；改了才再报', async () => {
    const b = bed()
    b.write('sess-1', '旧名字')
    const s = sink()
    const ti = new TitleIndex(s, b.dir, b.index)
    await ti.tick()
    await ti.tick()
    await ti.tick()
    expect(s.hits).toHaveLength(1)

    b.write('sess-1', '新名字')            // 同一个 cliSessionId，另一份文件
    await ti.tick()
    expect(s.hits).toHaveLength(2)
    expect(ti.titleFor('claude', 'sess-1')).toBe('新名字')
    ti.stop()
  })

  it('Codex 索引按 offset 读增量，不重复报已经读过的行', async () => {
    const b = bed()
    mkdirSync(b.dir, { recursive: true })
    writeFileSync(b.index, CODEX[0] + '\n')
    const s = sink()
    const ti = new TitleIndex(s, b.dir, b.index)
    await ti.tick()
    expect(s.hits.map(h => h.title)).toEqual(['安装 Blender MCP'])

    appendFileSync(b.index, CODEX[1] + '\n')
    await ti.tick()
    expect(s.hits.map(h => h.title)).toEqual(['安装 Blender MCP', '整理页面Skill详情'])
    ti.stop()
  })

  it('半行留到下一轮 —— 写到一半的那行不能被当成坏行丢掉', async () => {
    const b = bed()
    mkdirSync(b.dir, { recursive: true })
    const line = CODEX[2]!
    writeFileSync(b.index, line.slice(0, 20))          // 没有换行
    const s = sink()
    const ti = new TitleIndex(s, b.dir, b.index)
    await ti.tick()
    expect(s.hits).toHaveLength(0)

    appendFileSync(b.index, line.slice(20) + '\n')     // 补全
    await ti.tick()
    expect(s.hits.map(h => h.title)).toEqual(['重构乌鸦侧影油画提示词'])
    ti.stop()
  })

  it('索引被截短（桌面端重写了它）→ 从头再读，不卡在旧 offset 上', async () => {
    const b = bed()
    mkdirSync(b.dir, { recursive: true })
    writeFileSync(b.index, CODEX.join('\n') + '\n')
    const s = sink()
    const ti = new TitleIndex(s, b.dir, b.index)
    await ti.tick()
    expect(s.hits).toHaveLength(3)

    writeFileSync(b.index, CODEX[0] + '\n')            // 截短
    await ti.tick()
    // 第一条的标题没变，所以不该重复报；重点是没有抛、也没有卡住
    expect(ti.titleFor('codex', '01a0708c-068f-7a91-be3d-bedb6524c013')).toBe('安装 Blender MCP')
    ti.stop()
  })

  it('两处都不存在时安静返回，不抛（没装桌面端的机器）', async () => {
    const s = sink()
    const ti = new TitleIndex(s, '/no/such/dir', '/no/such/file.jsonl')
    await expect(ti.tick()).resolves.toBeUndefined()
    expect(s.hits).toHaveLength(0)
    ti.stop()
  })
})

describe('Feed.retitle · 后到的标题原地改名', () => {
  const ev = (over: Partial<EventInput> = {}): EventInput => ({
    id: 'codex:s1:1', agent: 'codex', kind: 'completed',
    title: '把增量解析补上 fixture 回归', at: '2026-09-15T00:00:00.000Z',
    sessionId: 's1', acked: false, ...over
  } as EventInput)

  it('改的只有 title：id / 已读 / 种类 / 时间一个都不动', () => {
    const f = new Feed()
    const before = f.ingest(ev(), true)!
    expect(before.acked).toBe(false)

    expect(f.retitle('codex', 's1', '整理页面Skill详情')).toBe(1)
    const after = f.list()[0]!
    expect(after.title).toBe('整理页面Skill详情')
    expect(after.id).toBe(before.id)          // id 不变 = 不算新事件、不重新计未读
    expect(after.acked).toBe(before.acked)
    expect(after.kind).toBe(before.kind)
    expect(after.at).toBe(before.at)
  })

  it('一个 session 在列表里只占一行（Feed 自己会收束），改名只会命中那一行', () => {
    const f = new Feed()
    f.ingest(ev({ id: 'codex:s1:1' }), true)
    f.ingest(ev({ id: 'codex:s1:2', kind: 'running' }), true)   // 同会话 → 覆盖上一条
    f.ingest(ev({ id: 'codex:s2:1', sessionId: 's2' }), true)
    expect(f.list().filter(e => e.sessionId === 's1')).toHaveLength(1)

    expect(f.retitle('codex', 's1', '新名字')).toBe(1)
    expect(f.list().find(e => e.sessionId === 's1')!.title).toBe('新名字')
    // 另一个 session 一个字没动
    expect(f.list().find(e => e.sessionId === 's2')!.title).toBe('把增量解析补上 fixture 回归')
  })

  it('没有 sessionId 的事件不会被误伤', () => {
    const f = new Feed()
    f.ingest(ev({ id: 'codex:none:1', sessionId: undefined }), true)
    expect(f.retitle('codex', 's1', '新名字')).toBe(0)
  })

  it('已读的那条也改 —— 名字变好跟读没读没关系', () => {
    const f = new Feed()
    f.ingest(ev(), false)                     // 回灌进来的，已读
    expect(f.list()[0]!.acked).toBe(true)
    expect(f.retitle('codex', 's1', '新名字')).toBe(1)
    expect(f.list()[0]!.acked).toBe(true)
  })

  it('认 agent + sessionId 两个，不串台', () => {
    const f = new Feed()
    f.ingest(ev({ id: 'claude:s1:1', agent: 'claude' }), true)
    expect(f.retitle('codex', 's1', '不该命中')).toBe(0)
    expect(f.list()[0]!.title).toBe('把增量解析补上 fixture 回归')
  })

  it('标题一样就返回 0 —— 调用方据此不写盘、不重画', () => {
    const f = new Feed()
    f.ingest(ev({ title: '同一个名字' }), true)
    expect(f.retitle('codex', 's1', '同一个名字')).toBe(0)
  })

  it('这个 session 还没有事件（标题先到）→ 0，留给索引下次认领', () => {
    expect(new Feed().retitle('codex', 's-unknown', '名字')).toBe(0)
  })
})
