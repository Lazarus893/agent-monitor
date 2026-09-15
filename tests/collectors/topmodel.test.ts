/**
 * B 页的「当前窗口用得最多的模型」。
 */

import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  NAME_MAX, SHORT_MAX, WINDOW_MS, claudeTopModel, countModels, displayName, plainName, recentTranscripts, shortModel, statuslineModel, topOf
} from '../../src/main/collectors/topmodel.js'

describe('countModels / topOf', () => {
  it('数 assistant 的 model 字段，取最多的那个', () => {
    const text = [
      '{"type":"assistant","message":{"model":"claude-opus-5"}}',
      '{"type":"assistant","message":{"model":"claude-fable-5-1"}}',
      '{"type":"assistant","message":{"model":"claude-fable-5-1"}}'
    ].join('\n')
    expect(topOf(countModels(text))).toBe('claude-fable-5-1')
  })

  it('合成标记与别名被跳过', () => {
    const line = (m: string): string => `{"type":"assistant","message":{"model":"${m}"}}`
    const counts = countModels([line('<synthetic>'), line('opus'), line('claude-opus-5')].join('\n'))
    expect([...counts.keys()]).toEqual(['claude-opus-5'])
  })

  it('只数 assistant 行：用户粘贴的 JSON 片段里的 model 不算（复核 P2-4.4）', () => {
    const text = [
      '{"type":"user","message":{"content":"我贴一段日志：{\\"model\\":\\"claude-opus-5\\"}"}}',
      '{"type":"assistant","message":{"model":"claude-fable-5-1"}}'
    ].join('\n')
    expect([...countModels(text).keys()]).toEqual(['claude-fable-5-1'])
  })

  it('递归扫描：subagent 的转录在更深的目录里，也要数进来（复核 P2-4.2）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'deep-'))
    mkdirSync(join(dir, 'proj', 'subagents'), { recursive: true })
    writeFileSync(join(dir, 'proj', 'subagents', 'a.jsonl'),
      '{"type":"assistant","message":{"model":"claude-opus-5"}}\n'.repeat(9))
    writeFileSync(join(dir, 'proj', 'top.jsonl'),
      '{"type":"assistant","message":{"model":"claude-fable-5-1"}}\n')
    expect(await recentTranscripts(dir)).toHaveLength(2)
    expect(await claudeTopModel(dir)).toBe('Opus 5')
  })

  it('并列时结论稳定（按名字排序取第一个），不会每轮跳来跳去', () => {
    const counts = new Map([['b-model', 3], ['a-model', 3]])
    expect(topOf(counts)).toBe('a-model')
    expect(topOf(new Map([['a-model', 3], ['b-model', 3]]))).toBe('a-model')
  })

  it('空表 → undefined（渲染层留空，而不是写「未知」）', () => {
    expect(topOf(new Map())).toBeUndefined()
  })
})

describe('displayName', () => {
  it('映射表里的按显示名', () => {
    expect(displayName('claude-fable-5-1')).toBe('Fable 5.1')
    expect(displayName('claude-opus-5')).toBe('Opus 5')
    expect(displayName('claude-sonnet-5')).toBe('Sonnet 5')
  })

  it('不在表里的去掉 claude- 前缀，不猜版本号写法', () => {
    expect(displayName('claude-newthing-9')).toBe('newthing-9')
  })

  it('超过 20 字符截断', () => {
    expect(displayName('x'.repeat(40)).length).toBe(NAME_MAX)
  })
})

describe('plainName', () => {
  it('Codex / ZCode 的 id 本身就是显示名', () => {
    expect(plainName('gpt-6-astra')).toBe('gpt-6-astra')
    expect(plainName('GLM-5.3-Flash')).toBe('GLM-5.3-Flash')
    expect(plainName(undefined)).toBeUndefined()
    expect(plainName('y'.repeat(40))!.length).toBe(NAME_MAX)
  })
})

describe('扫描转录目录', () => {
  const build = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'proj-'))
    mkdirSync(join(dir, '-Users-x-a'))
    const fresh = join(dir, '-Users-x-a', 'fresh.jsonl')
    writeFileSync(fresh, '{"type":"assistant","message":{"model":"claude-fable-5-1"}}\n'.repeat(3))
    const old = join(dir, '-Users-x-a', 'old.jsonl')
    writeFileSync(old, '{"type":"assistant","message":{"model":"claude-opus-5"}}\n'.repeat(50))
    // 把旧文件的 mtime 推到窗口之外
    const t = (Date.now() - WINDOW_MS * 2) / 1000
    utimesSync(old, t, t)
    return dir
  }

  it('只看窗口内动过的文件', async () => {
    const dir = build()
    const files = await recentTranscripts(dir)
    expect(files).toHaveLength(1)
    expect(files[0]).toContain('fresh.jsonl')
    expect(await claudeTopModel(dir)).toBe('Fable 5.1')
  })

  it('目录不存在 → 空表，退回 statusline', async () => {
    expect(await recentTranscripts(join(tmpdir(), 'nope-' + Date.now()))).toEqual([])
  })
})

/* tee 从 2026-09-15 起按 session_id 分文件（P1-3）：兜底必须走目录。
   还读老单文件的话，新机器读到 ENOENT（B 页模型名消失），
   老机器读到升级前冻结的那份旧快照（长期显示错的模型名，且没有东西会删它）。 */
describe('statusline 兜底', () => {
  /** 一个临时的 claude-ratelimits/ 目录，`[sid, display_name, 写入时刻]` 各一份 */
  const layout = (files: [string, string, string][]): string => {
    const dir = join(mkdtempSync(join(tmpdir(), 'sl-')), 'claude-ratelimits')
    mkdirSync(dir, { recursive: true })
    for (const [sid, name, writtenAt] of files) {
      writeFileSync(join(dir, `${sid}.json`), JSON.stringify({
        writtenAt,
        payload: {
          rate_limits: { seven_day: { used_percentage: 3, resets_at: 1789790400 } },
          model: { display_name: name }
        }
      }))
    }
    return dir
  }

  it('会话目录里取 writtenAt 最新那份的 model.display_name', async () => {
    const dir = layout([
      ['sess-old', 'Astra 3', '2026-09-14T19:48:05+08:00'],
      ['sess-new', 'Fable 5.1', '2026-09-14T19:48:07+08:00']
    ])
    expect(await statuslineModel(dir)).toBe('Fable 5.1')
  })

  it('只有一份会话文件时就用它', async () => {
    expect(await statuslineModel(layout([['solo', 'Fable 5.1', '2026-09-14T19:48:05+08:00']])))
      .toBe('Fable 5.1')
  })

  it('目录不存在 / 里面没有 model 时 undefined', async () => {
    expect(await statuslineModel(join(tmpdir(), 'nope-' + Date.now()))).toBeUndefined()
    const dir = join(mkdtempSync(join(tmpdir(), 'sl-')), 'claude-ratelimits')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'a.json'), JSON.stringify({
      writtenAt: '2026-09-14T19:48:05+08:00',
      payload: { rate_limits: { seven_day: { used_percentage: 3, resets_at: 1789790400 } } }
    }))
    expect(await statuslineModel(dir)).toBeUndefined()
  })
})

/* ==========================================================================
   短名（brief-m0-v2 §10）：B 页那一格是「产品名 · 模型」，模型那半只有几个字符。
   下面这批 id **全部是本机当场抓的**（~/.claude/projects 的转录、
   ~/.codex/sessions 的 rollout、~/.zcode 的 tasks 表），不是编的。
   ========================================================================== */

describe('shortModel · 实测 id', () => {
  it('Claude：家族名 + 版本号，连字符版本合成小数点', () => {
    expect(shortModel('claude-fable-5-1')).toBe('Fable 5.1')
    expect(shortModel('claude-opus-5')).toBe('Opus 5')
    expect(shortModel('claude-opus-4-6')).toBe('Opus 4.6')
    expect(shortModel('claude-sonnet-5')).toBe('Sonnet 5')
    expect(shortModel('claude-haiku-4-5')).toBe('Haiku 4.5')
  })

  it('Claude：转录里还出现过裸的家族名', () => {
    expect(shortModel('opus')).toBe('Opus')
    expect(shortModel('sonnet')).toBe('Sonnet')
  })

  it('Codex：代号就是产品名，没有代号才退回 GPT-<版本>', () => {
    expect(shortModel('gpt-6-astra')).toBe('Astra')
    expect(shortModel('gpt-5.6-sol')).toBe('Sol')
    expect(shortModel('gpt-5.6')).toBe('GPT-5.6')
  })

  it('ZCode：去供应商路径与 $档位，档位词（Flash/Air）不进短名', () => {
    expect(shortModel('builtin:bigmodel-coding-plan/GLM-5.3-Flash')).toBe('GLM-5.3')
    expect(shortModel('builtin:bigmodel-coding-plan/GLM-5.3$high')).toBe('GLM-5.3')
    expect(shortModel('builtin:bigmodel-coding-plan/GLM-5.3$max')).toBe('GLM-5.3')
    expect(shortModel('builtin:bigmodel-coding-plan/GLM-5.2')).toBe('GLM-5.2')
    expect(shortModel('GLM-5')).toBe('GLM-5')
    expect(shortModel('GLM-5.3-Flash')).toBe('GLM-5.3')
  })

  it('三家出来的都塞得进那一格（≤10 字符）', () => {
    for (const id of [
      'claude-fable-5-1', 'claude-opus-4-6', 'gpt-6-astra', 'gpt-5.6-sol',
      'builtin:bigmodel-coding-plan/GLM-5.3-Flash'
    ]) {
      expect(shortModel(id)!.length).toBeLessThanOrEqual(SHORT_MAX)
    }
  })

  /* 长度是这个函数自己的契约，不能只靠 B 页那条渲染断言兜 ——
     那条要在「产品名最长的一行 + ok 档 + 403 画布」同时成立时才会红，条件太窄。
     构词法的输出长度是开放的：新家族名、长代号、长版本链都可能超。 */
  it('**任何**输入的输出都 ≤10 —— 构词法不给长度做保证，这里给', () => {
    const ids = [
      // 实测过的
      'claude-fable-5-1', 'claude-opus-5', 'claude-opus-4-6', 'opus', '<synthetic>',
      'gpt-6-astra', 'gpt-5.6-sol',
      'builtin:bigmodel-coding-plan/GLM-5.3-Flash', 'builtin:bigmodel-coding-plan/GLM-5.3$high',
      // 构造的长形态：每一条都走不同的分支
      'claude-somelongfamilyname-5',              // Claude 分支：长家族名
      'claude-sonnet-4-5-20250929',               // Claude 分支：长版本链
      'gpt-7-averyverylongcodename',              // Codex 分支：长代号
      'gpt-12.34.56.78',                          // Codex 分支：长版本
      'GLM-5.3.4.5.6.7.8.9-Flash',                // 智谱分支：长版本
      'builtin:plan/some-vendor-averylongtailsegment',  // 兜底分支
      'averylongsinglewordmodelname'              // 兜底分支：没有连字符
    ]
    for (const id of ids) {
      const out = shortModel(id)
      expect(out, id).toBeDefined()
      expect(out!.length, `${id} → ${out}`).toBeLessThanOrEqual(SHORT_MAX)
    }
  })
})

describe('shortModel · 兜底', () => {
  it('不认识的：去厂商前缀取最后一段、首字母大写、截到 10', () => {
    expect(shortModel('some-vendor-nova')).toBe('Nova')
    expect(shortModel('acme-verylongmodelname')).toBe('Verylongm…')
    expect(shortModel('acme-verylongmodelname')!.length).toBe(SHORT_MAX)
  })

  it('没有连字符就原样（只做首字母大写与截断）', () => {
    expect(shortModel('mystery')).toBe('Mystery')
  })

  it('占位符原样留着 —— 猜一个名字比显示占位更糟', () => {
    expect(shortModel('<synthetic>')).toBe('<syntheti…')
  })

  it('空 / undefined → undefined（渲染层留空，不写「未知」）', () => {
    expect(shortModel(undefined)).toBeUndefined()
    expect(shortModel('')).toBeUndefined()
    expect(shortModel('   ')).toBeUndefined()
    expect(shortModel('builtin:plan/')).toBeUndefined()
  })
})
