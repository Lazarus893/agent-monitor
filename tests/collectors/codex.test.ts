/**
 * Codex 解析器。样本 tests/fixtures/codex-usage.stdout.txt 是今天本机
 * `codexbar usage --provider codex --json` 的真实 stdout，只把 accountEmail 抹成 <redacted>：
 * 前两行 `[codex notify] …` 噪音也一字不动地留着 —— 它就是整段 JSON.parse 会失败的原因。
 */

import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { collectCodex, extractJson, parseCodex } from '../../src/main/collectors/quota/codex.js'

const raw = readFileSync(new URL('../fixtures/codex-usage.stdout.txt', import.meta.url), 'utf8')

describe('parseCodex', () => {
  it('从「噪音行 + JSON」的真实 stdout 里解出两个窗口', () => {
    const r = parseCodex(raw)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.windows).toEqual([
      { label: '5h', usedPercent: 1, resetsAt: '2026-09-14T14:06:02.000Z' },
      { label: '7d', usedPercent: 8, resetsAt: '2026-09-19T19:21:22.000Z' }
    ])
    expect(r.plan).toBe('plus')
  })

  it('解析结果里不含邮箱等身份字段', () => {
    expect(JSON.stringify(parseCodex(raw))).not.toMatch(/accountEmail|@/)
  })

  it('extractJson 能跳过噪音行，整段 JSON 时也照常', () => {
    expect(Array.isArray(extractJson(raw))).toBe(true)
    expect(extractJson('{"a":1}')).toEqual({ a: 1 })
    expect(extractJson('随便什么都不是')).toBeUndefined()
  })

  it('有输出但没有 usage —— 当作登录态问题', () => {
    expect(parseCodex('[{"provider":"codex"}]')).toEqual({ ok: false, code: 'unauthorized' })
  })

  it('窗口字段残缺（只有 resetDescription，没有 usedPercent）也不产出半截窗口', () => {
    const out = '[{"usage":{"primary":{"resetDescription":"16:56"},"loginMethod":"plus"}}]'
    expect(parseCodex(out)).toEqual({ ok: false, code: 'unauthorized' })
  })

  it('输出里带 429 / 401 特征时映射到对应失败码', () => {
    expect(parseCodex('error: 429 rate limit exceeded')).toEqual({ ok: false, code: 'rate_limited' })
    expect(parseCodex('error: 401 unauthorized')).toEqual({ ok: false, code: 'unauthorized' })
  })

  it('完全读不懂的输出 → network（连不上，不是没授权）', () => {
    expect(parseCodex('')).toEqual({ ok: false, code: 'network' })
  })
})

describe('collectCodex', () => {
  it('第一个候选不存在就试下一个 —— 这是 PATH 里没有 codexbar 时实际要走的路', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codexbar-'))
    const bin = join(dir, 'codexbar')
    writeFileSync(bin, `#!/bin/sh\ncat ${JSON.stringify(new URL('../fixtures/codex-usage.stdout.txt', import.meta.url).pathname)}\n`)
    chmodSync(bin, 0o755)
    const r = await collectCodex(new AbortController().signal, ['/nonexistent/codexbar', bin])
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.windows.map(w => w.usedPercent)).toEqual([1, 8])
  })

  it('候选路径全都不存在 → missing_tool', async () => {
    const r = await collectCodex(new AbortController().signal, [
      '/nonexistent/codexbar-a',
      '/nonexistent/codexbar-b'
    ])
    expect(r).toEqual({ ok: false, code: 'missing_tool' })
  })
})
