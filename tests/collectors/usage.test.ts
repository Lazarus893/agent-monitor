/**
 * 每日用量（D 页热力图）的日期窗口、codexbar 解析与归一。
 * codexbar 的返回顶层是**数组**（本机 2026-09-14 实测），解析器错在这一层的话
 * 屏上会是一整片空格子而不是报错，所以这条单独钉住。
 */

import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SQLITE, ZCODE_TOKENS_SQL, buildDays, dateWindow, localDate, logLine, parseCodexbarCost,
  parseSqliteDays
} from '../../src/main/collectors/usage.js'
import type { AgentId } from '../../src/shared/types.js'

describe('dateWindow', () => {
  it('周一起算，以今天所在那一周结尾', () => {
    // 2026-09-14 是周一
    const d = dateWindow(8, new Date(2026, 8, 14))
    expect(d[0]).toBe('2026-07-27')            // 8 周前的周一
    expect(d[d.length - 1]).toBe('2026-09-14')
    expect(d.length).toBe(7 * 7 + 1)           // 前 7 整周 + 本周的周一
  })

  it('周日也算在它所属的那一周里（周一为首）', () => {
    const d = dateWindow(1, new Date(2026, 8, 20)) // 2026-09-20 是周日
    expect(d[0]).toBe('2026-09-14')
    expect(d).toHaveLength(7)
  })

  it('用本地日期而不是 UTC —— 晚上八点之后不能算到明天', () => {
    expect(localDate(new Date(2026, 8, 14, 23, 30))).toBe('2026-09-14')
  })
})

describe('parseCodexbarCost', () => {
  const sample = [{
    daily: [
      { date: '2026-09-13', totalTokens: 1000, modelBreakdowns: [{ modelName: 'gpt-6-astra', totalTokens: 1000 }] },
      { date: '2026-09-14', totalTokens: 2500 }
    ]
  }]

  it('顶层数组（codexbar 的真实形状）', () => {
    const m = parseCodexbarCost(sample)
    expect(m.get('2026-09-14')).toBe(2500)
  })

  it('顶层对象也吃得下', () => {
    expect(parseCodexbarCost(sample[0]).get('2026-09-13')).toBe(1000)
  })

  it('缺字段 / 非数字当 0，不抛', () => {
    const m = parseCodexbarCost([{ daily: [{ date: '2026-09-14' }, { totalTokens: 5 }, null] }])
    expect(m.get('2026-09-14')).toBe(0)
    expect(m.size).toBe(1)
  })

  it('完全不认识的形状 → 空表', () => {
    expect(parseCodexbarCost('nope').size).toBe(0)
    expect(parseCodexbarCost({ daily: 'x' }).size).toBe(0)
  })
})

describe('buildDays 归一', () => {
  const dates = ['2026-09-12', '2026-09-13', '2026-09-14']
  const per: Partial<Record<AgentId, Map<string, number>>> = {
    // 三家量级差两个数量级：不能先加总再归一，否则小的那家直接消失
    claude: new Map([['2026-09-12', 700_000_000], ['2026-09-14', 350_000_000]]),
    codex: new Map([['2026-09-13', 10_000_000]]),
    zcode: new Map([['2026-09-14', 50_000_000]])
  }

  it('每家各自按自己的最大值归一，再取均值', () => {
    const days = buildDays(dates, per, 'tokens')
    // 09-12：claude 满格 1，其余 0 → 1/3
    expect(days[0]!.intensity).toBeCloseTo(1 / 3, 3)
    // 09-13：codex 满格 → 1/3
    expect(days[1]!.intensity).toBeCloseTo(1 / 3, 3)
    // 09-14：claude 0.5 + zcode 1 → 0.5
    expect(days[2]!.intensity).toBeCloseTo(0.5, 3)
  })

  it('单位跟着来源走：ZCode 退回请求数时字段名也换', () => {
    const asTokens = buildDays(dates, per, 'tokens')[2]!.byAgent.zcode
    const asReqs = buildDays(dates, per, 'requests')[2]!.byAgent.zcode
    expect(asTokens).toEqual({ tokens: 50_000_000 })
    expect(asReqs).toEqual({ requests: 50_000_000 })
  })

  it('全零时 intensity 为 0，不产生 NaN', () => {
    const days = buildDays(dates, {}, 'tokens')
    expect(days.every(d => d.intensity === 0)).toBe(true)
  })

  it('日志只出天数，不出任何 token 数以外的东西', () => {
    const line = logLine({
      updatedAt: '', weeks: 8, days: buildDays(dates, per, 'tokens'), units: {}
    })
    expect(line).toBe('[usage] 8 周 3 天，活跃 3 天')
  })
})

describe('ZCode 用量 SQL（真实 sqlite3）', () => {
  it.skipIf(!existsSync(SQLITE))('model_usage 的实测列名能按天聚合出 token', () => {
    const db = join(mkdtempSync(join(tmpdir(), 'zu-')), 'db.sqlite')
    const now = Date.now()
    execFileSync(SQLITE, [db, `
      create table model_usage (started_at integer, input_tokens integer,
        output_tokens integer, reasoning_tokens integer, model_id text);
      insert into model_usage values (${now}, 100, 20, 5, 'GLM-5.3-Flash');
      insert into model_usage values (${now}, 1, 2, 3, 'GLM-5.3-Flash');
    `])
    const out = execFileSync(SQLITE, ['-readonly', '-json', db, ZCODE_TOKENS_SQL], { encoding: 'utf8' })
    const days = parseSqliteDays(JSON.parse(out))
    expect([...days.values()][0]).toBe(131)
  })

  it('空结果 / 坏结果 → 空表', () => {
    expect(parseSqliteDays([]).size).toBe(0)
    expect(parseSqliteDays('nope').size).toBe(0)
    expect(parseSqliteDays([{ d: '2026-09-14', v: 'x' }]).get('2026-09-14')).toBe(0)
  })
})
