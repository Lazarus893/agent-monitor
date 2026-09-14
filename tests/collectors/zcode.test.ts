/**
 * 智谱 quota/limit 解析器。tests/fixtures/zcode-quota.json 是今天本机用 Keychain 里的
 * Key 真实调回来的返回体（正文里没有任何凭据字段，逐字保留）。
 * PLAN §2.1 留了一条待办：「unit 枚举是从两个 nextResetTime 的间隔推断的，实现时再核对」——
 * 这份返回体把它核对上了：unit 3 number 5 = 5 小时窗，unit 6 = 周窗。
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { createZcodeCollector, parseZcode } from '../../src/main/collectors/quota/zcode.js'
import type { ZcodeDeps } from '../../src/main/collectors/quota/zcode.js'

const body = JSON.parse(
  readFileSync(new URL('../fixtures/zcode-quota.json', import.meta.url), 'utf8')
) as unknown

const signal = (): AbortSignal => new AbortController().signal
const withKey = (fetchQuota: ZcodeDeps['fetchQuota']) =>
  createZcodeCollector({ readKey: async () => 'test-key', fetchQuota })

describe('parseZcode', () => {
  it('三条 limits → 5h / 7d / 1mo，nextResetTime 的毫秒时间戳转 ISO', () => {
    const r = parseZcode(body)
    expect(r?.plan).toBe('pro')
    expect(r?.windows).toEqual([
      { label: '5h', usedPercent: 6, resetsAt: '2026-09-14T13:56:14.232Z' },
      { label: '7d', usedPercent: 19, resetsAt: '2026-09-18T08:35:33.976Z' },
      {
        label: '1mo',
        usedPercent: 1,
        resetsAt: '2026-09-23T10:00:55.982Z',
        current: 19,
        total: 1000,
        unit: 'MCP 调用'
      }
    ])
  })

  it('接口把 limits 的顺序调换了也照样 5h 在前 —— 渲染层拿 windows[0] 当 5 小时窗用', () => {
    const reversed = JSON.parse(JSON.stringify(body)) as { data: { limits: unknown[] } }
    reversed.data.limits.reverse()
    expect(parseZcode(reversed)?.windows.map(w => w.label)).toEqual(['5h', '7d', '1mo'])
  })

  it('认不出的 unit 组合直接跳过，不臆造 label', () => {
    const odd = { data: { limits: [{ type: 'TOKENS_LIMIT', unit: 9, number: 2, percentage: 5, nextResetTime: 1789394174232 }] } }
    expect(parseZcode(odd)).toBeNull()
  })

  it('没有 data / limits 的返回体一律 null', () => {
    expect(parseZcode({ code: 200 })).toBeNull()
    expect(parseZcode('nope')).toBeNull()
  })
})

describe('readKeychain（真的调 security，不碰任何真实条目）', () => {
  it.skipIf(process.platform !== 'darwin')('不存在的 service → null（security 退出码 44）', async () => {
    const { readKeychain } = await import('../../src/main/collectors/quota/keychain.js')
    expect(await readKeychain('agent-monitor-nonexistent-test', 'nope')).toBeNull()
  })
})

describe('collectZcode', () => {
  it('Keychain 里没有这一项 → missing_key（「未连接」空态，不是错误）', async () => {
    const collect = createZcodeCollector({ readKey: async () => null })
    expect(await collect(signal())).toEqual({ ok: false, code: 'missing_key' })
  })

  it('拿到 Key 就调接口，Authorization 是裸 Key（不加 Bearer）', async () => {
    const fetchQuota = vi.fn(async () => ({ status: 200, body }))
    const r = await withKey(fetchQuota)(signal())
    expect(fetchQuota).toHaveBeenCalledWith('test-key', expect.anything())
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.plan).toBe('pro')
  })

  it('HTTP 401 / 429 / 500 各自映射', async () => {
    const at = async (status: number) => withKey(async () => ({ status, body: {} }))(signal())
    expect(await at(401)).toEqual({ ok: false, code: 'unauthorized' })
    expect(await at(429)).toEqual({ ok: false, code: 'rate_limited' })
    expect(await at(500)).toEqual({ ok: false, code: 'network' })
  })

  it('200 但业务码不对 —— 智谱把鉴权失败塞在正文里', async () => {
    const r = await withKey(async () => ({
      status: 200,
      body: { code: 401, msg: '令牌已失效', success: false }
    }))(signal())
    expect(r).toEqual({ ok: false, code: 'unauthorized' })
  })

  it('请求本身抛出（离线 / DNS） → network', async () => {
    const r = await withKey(async () => { throw new Error('getaddrinfo ENOTFOUND') })(signal())
    expect(r).toEqual({ ok: false, code: 'network' })
  })
})
