/**
 * Claude 额度：主来源（statusline tee 落的文件）与兜底（OAuth）的分工与节流。
 *
 * 样本说明：statusline JSON 与 OAuth 200 正文都是**构造**的（字段名对齐
 * ~/.claude/coralline/statusline.sh 那一次 jq 取的路径与 PLAN §2.1），
 * 因为今天本机 /api/oauth/usage 连续 429 —— 那个 429 正文是真的，见 claude-oauth-429.json，
 * 而 Keychain 里的 accessToken 实测是空串。两种真实失败下面都有对应用例。
 */

import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { RawSample } from '../../src/main/collectors/quota/claude.js'
import {
  ClaudeCollector, FILE_FRESH_MS, OAUTH_MIN_GAP_MS, SESSION_TTL_MS, collectSamples, isPlaceholder,
  mergeSamples, newestSample, parseAccessToken, parseRateLimits, parseWrittenAt
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

/* ==========================================================================
   多会话合并（2026-09-15 实机 P1）。

   用户同时开着几十个 Claude Code 会话，它们原来每秒轮流覆盖同一个
   ~/.agent-monitor/claude-ratelimits.json —— 有的给 five_hour，有的不给，
   采集每 15 s 读到哪份算哪份，面板上的 5h 于是时不时掉成占位 0%
   （实测日志 744 次采集里 136 次 `5h=absent`）。
   现在 tee 按 session_id 分文件，采集侧按键合并。

   fixture 是那一刻 ~/.agent-monitor/claude-ratelimits/ 的真实内容，
   见 tests/fixtures/ratelimits/README.md。
   ========================================================================== */

describe('mergeSamples / collectSamples', () => {
  const FIX = new URL('../fixtures/ratelimits/', import.meta.url)
  /** 样本里最晚的那次写入：2026-09-15T15:36:40+08:00 */
  const NOW = Date.UTC(2026, 8, 15, 7, 36, 40)

  const sample = (name: string): RawSample => {
    const raw = load(`ratelimits/${name}.json`)
    return { windows: parseRateLimits(raw), at: Date.parse(parseWrittenAt(raw)!) }
  }
  /** 那一刻真实在跑的四个会话 */
  const four = (): RawSample[] => ['a', 'b', 'c', 'd'].map(n => sample(`session-${n}`))

  /**
   * 把若干 fixture 摆进一个临时的 claude-ratelimits/ 目录，返回 [目录, 老单文件路径]。
   * `legacyFrom` 摆一份升级前遗留的单文件 —— 它该被忽略并清掉，不该参与合并。
   */
  const layout = (names: string[], legacyFrom?: string): [string, string] => {
    const am = mkdtempSync(join(tmpdir(), 'agent-monitor-merge-'))
    const dir = join(am, 'claude-ratelimits')
    mkdirSync(dir)
    for (const n of names) copyFileSync(new URL(`${n}.json`, FIX), join(dir, `${n}.json`))
    const legacy = join(am, 'claude-ratelimits.json')
    if (legacyFrom) copyFileSync(new URL(`${legacyFrom}.json`, FIX), legacy)
    return [dir, legacy]
  }
  /** 把文件的 mtime 拨到 `ms` 毫秒之前（TTL 删除按 mtime 算） */
  const age = (file: string, ms: number): void => {
    const t = new Date(Date.now() - ms)
    utimesSync(file, t, t)
  }

  it('fixture 就是那四份真实文件：两份有 5h，两份整个省掉了这个键', () => {
    const keys = ['a', 'b', 'c', 'd'].map(n =>
      Object.keys((load(`ratelimits/session-${n}.json`) as
        { payload: { rate_limits: Record<string, unknown> } }).payload.rate_limits))
    expect(keys).toEqual([
      ['five_hour', 'seven_day'], ['seven_day'], ['seven_day'], ['five_hour', 'seven_day']
    ])
  })

  /* 这一条是 P1 的正题。写得最晚的是 session-a（5h 5%），
     按 writtenAt 取最新就会挑中它 —— 每个会话只知道**它自己最近一次 API 请求**
     看到的额度，闲置会话每秒重写的是旧快照。 */
  it('四个会话合并成 5h=12 / 7d=28：活着的窗口里取用量最大的，不是写得最晚的', () => {
    expect(summarize(mergeSamples(four(), NOW))).toBe('5h=12% 7d=28%')
  })

  it('写入顺序怎么排都是同一个答案（合并不看谁先谁后）', () => {
    const s = four()
    const perms: RawSample[][] = [
      [s[0]!, s[1]!, s[2]!, s[3]!], [s[3]!, s[2]!, s[1]!, s[0]!],
      [s[1]!, s[3]!, s[0]!, s[2]!], [s[2]!, s[0]!, s[3]!, s[1]!]
    ]
    for (const p of perms) expect(summarize(mergeSamples(p, NOW))).toBe('5h=12% 7d=28%')
  })

  /* 跨过重置点：session-stale 的 5h 是**上一个窗口**的 97%（重置时刻已经过去），
     而且它是写得最晚的一份。过期窗一律丢弃，所以它连参赛资格都没有。 */
  it('过期窗被丢弃：上一个窗口的 97% 压不过当前窗口的 12%', () => {
    expect(summarize(mergeSamples([...four(), sample('session-stale')], NOW)))
      .toBe('5h=12% 7d=28%')
  })

  /* P1-1 的反例。当前 5h 窗还没有任何会话报过 five_hour 时，那个闲置会话的旧快照
     没有竞争对手 —— 不丢弃过期窗的话它直接胜出，屏上长期「97% · 0m」且永不自愈
     （tee 每秒重写，写入时刻永远新鲜，10 min 窗滤不掉它）。 */
  it('过期窗是当前 5h 唯一来源 → 结果是占位，不是「97% · 0m」', () => {
    const w = mergeSamples([sample('session-stale'), sample('session-b')], NOW)
    expect(summarize(w)).toBe('5h=absent 7d=22%')
    expect(isPlaceholder(w[0]!)).toBe(true)
  })

  it('重置时刻正好等于 now 也算过期（那一刻窗口已经翻篇）', () => {
    const at = Date.parse('2026-09-15T09:00:00.000Z')   // fixture 里 5h 的重置时刻
    expect(summarize(mergeSamples(four(), at))).toBe('5h=absent 7d=28%')
  })

  it('resetsAt 解析不出来的窗口不参与竞争（NaN 不许永久占位）', () => {
    const bad: RawSample = { windows: [{ label: '5h', usedPercent: 99, resetsAt: '不是时刻' }], at: NOW }
    expect(summarize(mergeSamples([bad, ...four()], NOW))).toBe('5h=12% 7d=28%')
    expect(summarize(mergeSamples([...four(), bad], NOW))).toBe('5h=12% 7d=28%')
  })

  it('所有样本都没给出活着的 five_hour 时才落到占位', () => {
    const w = mergeSamples([sample('session-b'), sample('session-c')], NOW)
    expect(summarize(w)).toBe('5h=absent 7d=24%')
    expect(isPlaceholder(w[0]!)).toBe(true)
  })

  it('一份样本都没有 → 一个窗口都不给（那一路该走 notice，不是 0%）', () => {
    expect(mergeSamples([], NOW)).toEqual([])
  })

  it('扫目录：四份都在 → 合并结果与直接喂样本一致', async () => {
    const [dir, legacy] = layout(['session-a', 'session-b', 'session-c', 'session-d'])
    const got = await collectSamples(NOW, dir, legacy)
    expect(got).toHaveLength(4)
    expect(summarize(mergeSamples(got, NOW))).toBe('5h=12% 7d=28%')
  })

  /* P1-2：10 min 新鲜判定**不在这一层**。滤在这里的话，run() 里「旧数字带 stale
     交出去」那条路在默认路径上就成了死代码，冷启动会把旧数字整个丢掉。 */
  it('不新鲜（>10 min）的样本照样返回 —— 新鲜判定是 run() 的事', async () => {
    const [dir, legacy] = layout(['session-a', 'session-b', 'session-c', 'session-d'])
    const got = await collectSamples(NOW + FILE_FRESH_MS + 1000, dir, legacy)
    expect(got).toHaveLength(4)
  })

  /* P2-6：升级前那份单文件现在没有任何东西写它，留着只会是个冻结的旧快照。 */
  it('遗留的老单文件不参与合并，而且被顺手删掉', async () => {
    const [dir, legacy] = layout(['session-b'], 'session-d')
    expect(existsSync(legacy)).toBe(true)
    const got = await collectSamples(NOW, dir, legacy)
    expect(got).toHaveLength(1)                                   // 只有 session-b
    expect(summarize(mergeSamples(got, NOW))).toBe('5h=absent 7d=22%')
    expect(existsSync(legacy)).toBe(false)
  })

  it('老单文件本来就不存在时也不抛', async () => {
    const [dir, legacy] = layout(['session-d'])
    expect(await collectSamples(NOW, dir, legacy)).toHaveLength(1)
  })

  it('目录根本不存在（还没装 tee）→ 不抛，空表', async () => {
    const am = mkdtempSync(join(tmpdir(), 'agent-monitor-merge-'))
    expect(await collectSamples(NOW, join(am, 'claude-ratelimits'), join(am, 'nope.json'))).toEqual([])
  })

  /* P2-3：TTL 删除按 mtime 算、且在读之前 —— 坏 JSON 与 .tmp 残留也清得掉。
     app 不跑的时候 tee 照写，不清就单向增长。 */
  it('超过 24 h 没动过的文件被删掉，包括坏 JSON 与 .tmp 残留', async () => {
    const [dir, legacy] = layout(['session-a', 'session-d'])
    writeFileSync(join(dir, 'session-x.json.tmp.4242'), '{"writtenAt":')
    writeFileSync(join(dir, 'session-broken.json'), 'not json at all')
    for (const n of ['session-a.json', 'session-x.json.tmp.4242', 'session-broken.json']) {
      age(join(dir, n), SESSION_TTL_MS + 60_000)
    }
    const got = await collectSamples(Date.now(), dir, legacy)
    expect(existsSync(join(dir, 'session-a.json'))).toBe(false)
    expect(existsSync(join(dir, 'session-x.json.tmp.4242'))).toBe(false)
    expect(existsSync(join(dir, 'session-broken.json'))).toBe(false)
    expect(existsSync(join(dir, 'session-d.json'))).toBe(true)     // 刚写的，留着
    expect(got).toHaveLength(1)
  })

  it('24 h 内的文件一律不删，哪怕这一轮用不上它', async () => {
    const [dir, legacy] = layout(['session-d'])
    age(join(dir, 'session-d.json'), 23 * 3600_000)
    await collectSamples(Date.now(), dir, legacy)
    expect(existsSync(join(dir, 'session-d.json'))).toBe(true)
  })

  it('非 .json 与半写的 .tmp 文件一概不读', async () => {
    const [dir, legacy] = layout(['session-d'])
    writeFileSync(join(dir, 'session-x.json.tmp.4242'), '{"writtenAt":')
    writeFileSync(join(dir, 'notes.txt'), 'hello')
    expect(await collectSamples(NOW, dir, legacy)).toHaveLength(1)
  })

  it('坏 JSON 的那一份跳过，其余照常合并', async () => {
    const [dir, legacy] = layout(['session-a', 'session-d'])
    writeFileSync(join(dir, 'session-broken.json'), '{"writtenAt":"2026-09-15T15:36:41+08:00","pay')
    const got = await collectSamples(NOW + 1000, dir, legacy)
    expect(got).toHaveLength(2)
    expect(summarize(mergeSamples(got, NOW))).toBe('5h=12% 7d=28%')
  })

  it('样本带出 model.display_name（topmodel 的兜底靠它）', async () => {
    const [dir, legacy] = layout(['session-d'])
    const got = await collectSamples(NOW, dir, legacy)
    expect(got[0]!.model).toBe('Fable 5.1')
    expect((await newestSample(NOW, dir))?.model).toBe('Fable 5.1')
  })

  it('newestSample 取写入时刻最新的那一份', async () => {
    const [dir] = layout(['session-a', 'session-b', 'session-c', 'session-d'])
    const s = await newestSample(NOW, dir)
    expect(s?.at).toBe(Date.parse('2026-09-15T15:36:39+08:00'))   // session-a
  })

  it('ClaudeCollector 默认走合并，且 sampledAt 是最近一次有会话写入的时刻', async () => {
    const [dir, legacy] = layout(['session-a', 'session-b', 'session-c', 'session-d'])
    const fetchUsage = vi.fn()
    const c = new ClaudeCollector({
      now: () => NOW,
      collectSamples: n => collectSamples(n, dir, legacy),
      readToken: async () => 'tok',
      fetchUsage
    })
    const r = await c.run(signal())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(summarize(r.windows)).toBe('5h=12% 7d=28%')
    expect(r.sampledAt).toBe('2026-09-15T07:36:39.000Z')   // session-a，写得最晚的那份
    expect(fetchUsage).not.toHaveBeenCalled()              // 文件新鲜，一次网络都不发
  })

  /* P1-2 的反例：合盖过夜、早上开机（登录自启）就是这条路 —— 文件 20 min 前写的，
     Keychain 没有可用令牌。旧数字必须连同它的写入时刻一起交出去（文件头纪律：stale），
     而不是报「还没接入 statusline」把整块瓦片清成空态。 */
  it('文件旧了（>10 min）且没有可用令牌：带回旧数字 + 写入时刻，标 stale 而不是空态', async () => {
    const [dir, legacy] = layout(['session-a', 'session-b', 'session-c', 'session-d'])
    const later = NOW + 20 * 60_000
    const fetchUsage = vi.fn()
    const c = new ClaudeCollector({
      now: () => later,
      collectSamples: n => collectSamples(n, dir, legacy),
      readToken: async () => null,
      fetchUsage
    })
    const r = await c.run(signal())
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('no_statusline')
    expect(summarize(r.windows ?? [])).toBe('5h=12% 7d=28%')   // 数字没被丢掉
    expect(r.sampledAt).toBe('2026-09-15T07:36:39.000Z')       // 停在文件的写入时刻
    expect(fetchUsage).not.toHaveBeenCalled()                  // 没令牌就不算一次兜底调用
  })

  it('一份文件都没有时才是真的空态（no_statusline，不带 windows）', async () => {
    const [dir, legacy] = layout([])
    const c = new ClaudeCollector({
      now: () => NOW,
      collectSamples: n => collectSamples(n, dir, legacy),
      readToken: async () => null,
      fetchUsage: async () => ({ status: 200, body: {} })
    })
    expect(await c.run(signal())).toEqual({ ok: false, code: 'no_statusline' })
  })
})
