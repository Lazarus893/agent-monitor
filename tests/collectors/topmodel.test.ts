/**
 * B 页的「当前窗口用得最多的模型」。
 */

import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  NAME_MAX, WINDOW_MS, claudeTopModel, countModels, displayName, plainName, recentTranscripts,
  statuslineModel, topOf
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

describe('statusline 兜底', () => {
  it('tee 落盘的包装形状里取 model.display_name', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'sl-')), 'claude-ratelimits.json')
    writeFileSync(file, JSON.stringify({
      writtenAt: '2026-09-14T19:48:05+08:00',
      payload: { rate_limits: {}, model: { display_name: 'Fable 5.1' } }
    }))
    expect(await statuslineModel(file)).toBe('Fable 5.1')
  })

  it('没有文件 / 没有 model 时 undefined', async () => {
    expect(await statuslineModel(join(tmpdir(), 'nope-' + Date.now()))).toBeUndefined()
  })
})
