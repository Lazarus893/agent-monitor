/**
 * Claude 额度：主来源（statusline tee 落的文件）与兜底（OAuth）的分工与节流。
 *
 * 样本说明：statusline JSON 与 OAuth 200 正文都是**构造**的（字段名对齐
 * ~/.claude/coralline/statusline.sh 那一次 jq 取的路径与 PLAN §2.1），
 * 因为今天本机 /api/oauth/usage 连续 429 —— 那个 429 正文是真的，见 claude-oauth-429.json，
 * 而 Keychain 里的 accessToken 实测是空串。两种真实失败下面都有对应用例。
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  ClaudeCollector, FILE_FRESH_MS, OAUTH_MIN_GAP_MS, isPlaceholder, parseAccessToken, parseRateLimits,
  parseWrittenAt
} from '../../src/main/collectors/quota/claude.js'
import { summarize } from '../../src/main/collectors/quota/types.js'

const load = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8')) as unknown

const statusline = load('claude-statusline.json')
const statuslineEpoch = load('claude-statusline-epoch.json')
const oauthUsage = load('claude-oauth-usage.json')
const oauth429 = load('claude-oauth-429.json')
const teeFile = load('claude-tee-file.json')

const T0 = Date.UTC(2026, 8, 14, 10, 0, 0)
const signal = (): AbortSignal => new AbortController().signal
const wrap = (payload: unknown, writtenAt: string): unknown => ({ writtenAt, payload })

describe('parseRateLimits', () => {
  it('statusline JSON（ISO 的 resets_at）', () => {
    expect(parseRateLimits(statusline)).toEqual([
      { label: '5h', usedPercent: 18, resetsAt: '2026-09-14T09:00:00.000Z' },
      { label: '7d', usedPercent: 31, resetsAt: '2026-09-19T03:00:00.000Z' }
    ])
  })

  it('同一份数据换成 epoch 秒，落到同一个时刻', () => {
    const w = parseRateLimits(statuslineEpoch)
    expect(w[0]).toEqual({ label: '5h', usedPercent: 82, resetsAt: '2026-09-14T09:00:00.000Z' })
  })

  it('tee 的 { writtenAt, payload } 包装照样读得出来', () => {
    const w = parseRateLimits(wrap(statusline, '2026-09-14T18:00:00+08:00'))
    expect(w).toHaveLength(2)
    expect(parseWrittenAt(wrap(statusline, '2026-09-14T18:00:00+08:00')))
      .toBe('2026-09-14T10:00:00.000Z')
  })

  it('tee 真实落盘的那一份（只有 rate_limits + model，resets_at 是 epoch 秒）', () => {
    expect(parseRateLimits(teeFile)).toEqual([
      { label: '5h', usedPercent: 2, resetsAt: '2026-09-14T16:00:00.000Z' },
      { label: '7d', usedPercent: 10, resetsAt: '2026-09-19T04:00:00.000Z' }
    ])
    expect(parseWrittenAt(teeFile)).toBe('2026-09-14T11:34:31.000Z')
  })

  it('OAuth 正文：utilization 别名与 epoch 一并容错', () => {
    expect(parseRateLimits(oauthUsage)).toEqual([
      { label: '5h', usedPercent: 46, resetsAt: '2026-09-14T12:00:00.000Z' },
      { label: '7d', usedPercent: 52, resetsAt: '2026-09-19T07:00:00.000Z' }
    ])
  })

  it('429 正文里没有窗口', () => {
    expect(parseRateLimits(oauth429)).toEqual([])
  })
})

describe('ClaudeCollector', () => {
  it('文件新鲜（10 min 内）就用文件，一次网络都不发', async () => {
    const fetchUsage = vi.fn()
    const c = new ClaudeCollector({
      now: () => T0,
      readStatusline: async () => wrap(statusline, new Date(T0 - 60_000).toISOString()),
      readToken: async () => 'tok',
      fetchUsage
    })
    const r = await c.run(signal())
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.windows[0]!.usedPercent).toBe(18)
    expect(fetchUsage).not.toHaveBeenCalled()
  })

  it('文件超过 10 min → 走 OAuth；成功就用新数字', async () => {
    const fetchUsage = vi.fn(async () => ({ status: 200, body: oauthUsage }))
    const c = new ClaudeCollector({
      now: () => T0,
      readStatusline: async () => wrap(statusline, new Date(T0 - FILE_FRESH_MS - 1000).toISOString()),
      readToken: async () => 'tok',
      fetchUsage
    })
    const r = await c.run(signal())
    expect(fetchUsage).toHaveBeenCalledTimes(1)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.windows[0]!.usedPercent).toBe(46)
  })

  it('OAuth 429：旧数字留着并带上它自己的时刻，错误码是 rate_limited', async () => {
    const writtenAt = new Date(T0 - 20 * 60_000).toISOString()
    const c = new ClaudeCollector({
      now: () => T0,
      readStatusline: async () => wrap(statusline, writtenAt),
      readToken: async () => 'tok',
      fetchUsage: async () => ({ status: 429, body: oauth429 })
    })
    const r = await c.run(signal())
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('rate_limited')
    expect(r.windows).toHaveLength(2)
    expect(r.sampledAt).toBe(writtenAt)
  })

  it('429 之后退避翻倍：5 min 后不再调，10 min 后才调；期间码不变', async () => {
    let now = T0
    const fetchUsage = vi.fn(async () => ({ status: 429, body: oauth429 }))
    const c = new ClaudeCollector({
      now: () => now,
      readStatusline: async () => null,
      readToken: async () => 'tok',
      fetchUsage
    })
    expect(await c.run(signal())).toEqual({ ok: false, code: 'rate_limited' })  // 第 1 次，真调
    now = T0 + OAUTH_MIN_GAP_MS + 1000                      // 5 min 多一点
    const gated = await c.run(signal())
    expect(fetchUsage).toHaveBeenCalledTimes(1)             // 退避到 10 min，这次不调
    expect(gated).toEqual({ ok: false, code: 'rate_limited' })  // 复述上一次的结论，不回落
    now = T0 + 2 * OAUTH_MIN_GAP_MS + 1000                  // 10 min 多一点
    await c.run(signal())
    expect(fetchUsage).toHaveBeenCalledTimes(2)
  })

  it('没有可用令牌时根本不算一次兜底调用：文件也没有 → 稳定的 no_statusline 空态', async () => {
    const fetchUsage = vi.fn()
    const c = new ClaudeCollector({
      now: () => T0,
      readStatusline: async () => null,
      readToken: async () => null,
      fetchUsage
    })
    expect(await c.run(signal())).toEqual({ ok: false, code: 'no_statusline' })
    expect(fetchUsage).not.toHaveBeenCalled()
  })

  /**
   * 复核 P1-①的回归：tee 未装 + 无可用令牌时，旧实现的码序列是
   * unauthorized×1 → no_statusline×19 循环 —— 屏上每 5 分钟闪 15 秒红色 401。
   * 45 轮 = 11 min 15 s，跨过两个 5 min 门槛，只允许出现一种码。
   */
  it('tee 未装 + 无令牌：45 轮（11 min）状态不抖，只有 no_statusline', async () => {
    let now = T0
    const c = new ClaudeCollector({
      now: () => now,
      readStatusline: async () => null,
      readToken: async () => null,
      fetchUsage: async () => ({ status: 200, body: oauthUsage })
    })
    const codes = new Set<string>()
    for (let i = 0; i < 45; i++) {
      const r = await c.run(signal())
      codes.add(r.ok ? 'ok' : r.code)
      now += 15_000
    }
    expect([...codes]).toEqual(['no_statusline'])
  })

  it('有令牌但端点持续 429：45 轮里也只有 rate_limited 一种码', async () => {
    let now = T0
    const c = new ClaudeCollector({
      now: () => now,
      readStatusline: async () => null,
      readToken: async () => 'tok',
      fetchUsage: async () => ({ status: 429, body: oauth429 })
    })
    const codes = new Set<string>()
    for (let i = 0; i < 45; i++) {
      const r = await c.run(signal())
      codes.add(r.ok ? 'ok' : r.code)
      now += 15_000
    }
    expect([...codes]).toEqual(['rate_limited'])
  })

  it('只有端点真的回 401 才是 unauthorized，且不覆盖已有的文件数据', async () => {
    const writtenAt = new Date(T0 - 20 * 60_000).toISOString()
    const c = new ClaudeCollector({
      now: () => T0,
      readStatusline: async () => wrap(statusline, writtenAt),
      readToken: async () => 'tok',
      fetchUsage: async () => ({ status: 401, body: { error: 'unauthorized' } })
    })
    const r = await c.run(signal())
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('unauthorized')
    expect(r.windows).toHaveLength(2)     // 文件数据没被兜底的失败抹掉
    expect(r.sampledAt).toBe(writtenAt)
  })

  it('文件在但解析不出窗口（写了一半 / 不是 JSON）也当没有', async () => {
    const c = new ClaudeCollector({
      now: () => T0,
      readStatusline: async () => ({ writtenAt: new Date(T0).toISOString(), payload: { foo: 1 } }),
      readToken: async () => null,
      fetchUsage: async () => ({ status: 200, body: oauthUsage })
    })
    expect(await c.run(signal())).toEqual({ ok: false, code: 'no_statusline' })
  })
})

describe('parseAccessToken', () => {
  const at = (over: Record<string, unknown>): string =>
    JSON.stringify({ claudeAiOauth: { accessToken: 'tok', expiresAt: T0 + 3600_000, ...over } })

  it('正常令牌读得出来', () => {
    expect(parseAccessToken(at({}), T0)).toBe('tok')
  })

  it('空串当作没有 —— 本机两条同名 Keychain 项里就有这么一条', () => {
    expect(parseAccessToken(at({ accessToken: '' }), T0)).toBeNull()
  })

  it('已过期当作没有（刷新是 Claude Code 自己的事）', () => {
    expect(parseAccessToken(at({ expiresAt: T0 - 1 }), T0)).toBeNull()
  })

  it('expiresAt 为 0 / 缺失时不判过期', () => {
    expect(parseAccessToken(at({ expiresAt: 0 }), T0)).toBe('tok')
  })

  it('不是 JSON / 没有 claudeAiOauth → null，不抛', () => {
    expect(parseAccessToken('not json', T0)).toBeNull()
    expect(parseAccessToken('{"other":1}', T0)).toBeNull()
    expect(parseAccessToken(null, T0)).toBeNull()
  })
})

/* ==========================================================================
   5h 窗这一程没用过时，Claude Code 会**整个省掉** `five_hour` 这个键。
   实测样本：tests/fixtures/claude-statusline-no-5h.json —— 2026-09-15 00:07
   本机 ~/.agent-monitor/claude-ratelimits.json 的原样内容。

   映射一直是按键名走的，出事的是下游：渲染层按**位置**取 windows[0] 当 5h，
   于是只剩一个窗口时，7 天窗的 10% / 107h55m 被 A、B 两页当成 5h 显示 ——
   屏上是个看不出错的错数。补一个显式占位窗把这条堵死。
   ========================================================================== */

describe('缺 five_hour', () => {
  const NO5H = load('claude-statusline-no-5h.json')

  it('fixture 就是那份真实文件：只有 seven_day', () => {
    const limits = (NO5H as { payload: { rate_limits: Record<string, unknown> } }).payload.rate_limits
    expect(Object.keys(limits)).toEqual(['seven_day'])
  })

  it('两个窗口都在，且各在各的槽里 —— 7d 不许顶到 5h', () => {
    const w = parseRateLimits(NO5H)
    expect(w.map(x => x.label)).toEqual(['5h', '7d'])
    expect(w[0]!.usedPercent).toBe(0)
    expect(w[1]!.usedPercent).toBe(10)
  })

  it('5h 是占位窗：没有重置时刻（渲染层据此显示「—」）', () => {
    const w = parseRateLimits(NO5H)
    expect(w[0]!.resetsAt).toBe('')
    expect(isPlaceholder(w[0]!)).toBe(true)
    // 7d 是真窗口，重置时刻要正常解析出来
    expect(isPlaceholder(w[1]!)).toBe(false)
    expect(Date.parse(w[1]!.resetsAt)).not.toBeNaN()
  })

  it('日志把「没给这个键」和「真的 0%」分开', () => {
    expect(summarize(parseRateLimits(NO5H))).toBe('5h=absent 7d=10%')
    // 真的 0% 长这样
    expect(summarize([
      { label: '5h', usedPercent: 0, resetsAt: '2026-09-15T05:00:00.000Z' },
      { label: '7d', usedPercent: 10, resetsAt: '2026-09-19T16:00:00.000Z' }
    ])).toBe('5h=0% 7d=10%')
  })

  it('两个键都在时不补占位（别把正常情况也改了）', () => {
    const w = parseRateLimits(load('claude-statusline.json'))
    expect(w.map(x => x.label)).toEqual(['5h', '7d'])
    expect(w.every(x => !isPlaceholder(x))).toBe(true)
  })

  it('一个窗口都没有时不补 0% —— 那一路该走 notice', () => {
    expect(parseRateLimits({ payload: { rate_limits: {} } })).toEqual([])
    expect(parseRateLimits({})).toEqual([])
  })

  it('只有 five_hour 时也不动（占位只补 5h 这一侧）', () => {
    const w = parseRateLimits({
      payload: { rate_limits: { five_hour: { used_percentage: 3, resets_at: 1789790400 } } }
    })
    expect(w.map(x => x.label)).toEqual(['5h'])
    expect(w[0]!.usedPercent).toBe(3)
  })
})
