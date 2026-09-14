/**
 * ZCode 额度：智谱 bigmodel 的 /api/monitor/usage/quota/limit。
 *
 * Key 来自 Keychain（service=agent-monitor, account=zcode-bigmodel）—— ZCode 自己的
 * OAuth 令牌在 ~/.zcode/v2/credentials.json 里是 enc:v1: 加密的，不可复用（PLAN §2.1）。
 * Keychain 里没有这一项 = 用户还没给 Key，屏上是「未连接」空态，不是错误。
 *
 * limits[] 的 unit 枚举（3 = 小时、6 = 周）今天又对了一次真实返回：
 * unit 3 number 5 → 5h 窗、unit 6 → 7d 窗、TIME_LIMIT → 月度 MCP 调用计数。
 * 认不出的组合直接跳过，不臆造 label —— QuotaWindow.label 只有三个合法值。
 */

import type { QuotaWindow } from '../../../shared/types.js'
import type { QuotaResult } from './types.js'
import { codeFromStatus, codeFromText, isRecord, toIso, toInt } from './types.js'
import { readKeychain } from './keychain.js'

export const QUOTA_URL = 'https://open.bigmodel.cn/api/monitor/usage/quota/limit'
export const KEYCHAIN_SERVICE = 'agent-monitor'
export const KEYCHAIN_ACCOUNT = 'zcode-bigmodel'

/** 智谱返回体 → 窗口 + 档位。返回 null 表示这不是一份能用的返回。 */
export function parseZcode(body: unknown): { windows: QuotaWindow[]; plan?: string } | null {
  if (!isRecord(body)) return null
  const data = body['data']
  if (!isRecord(data)) return null
  const limits = data['limits']
  if (!Array.isArray(limits)) return null

  const windows: QuotaWindow[] = []
  for (const raw of limits) {
    if (!isRecord(raw)) continue
    const resetsAt = toIso(raw['nextResetTime'])
    const usedPercent = toInt(raw['percentage'])
    if (!resetsAt || usedPercent === null) continue

    if (raw['type'] === 'TOKENS_LIMIT') {
      const unit = raw['unit'], number = raw['number']
      const label = unit === 3 && number === 5 ? '5h' : unit === 6 ? '7d' : null
      if (!label) continue
      windows.push({ label, usedPercent, resetsAt })
    } else if (raw['type'] === 'TIME_LIMIT') {
      // 这一条是计数而非比例：currentValue / usage（usage 是上限，19 / 1000）
      const current = toInt(raw['currentValue'])
      const total = toInt(raw['usage'])
      windows.push({
        label: '1mo',
        usedPercent,
        resetsAt,
        ...(current === null ? {} : { current }),
        ...(total === null ? {} : { total }),
        unit: 'MCP 调用'
      })
    }
  }
  if (!windows.length) return null
  // 按 5h → 7d → 1mo 排一次：接口是按 limits[] 的返回顺序给的，而渲染层两页都拿
  // windows[0] 当 5 小时窗用（A 页的大数字、B 页时间带的起点）。顺序一旦调换，
  // 屏上会「数字看着对、位置全错」（复核 §2.3）。
  const ORDER: Record<QuotaWindow['label'], number> = { '5h': 0, '7d': 1, '1mo': 2 }
  windows.sort((a, b) => ORDER[a.label] - ORDER[b.label])
  const level = data['level']
  return { windows, plan: typeof level === 'string' ? level : undefined }
}

/** 200 但业务码不对（智谱把鉴权失败也塞在 200 的正文里） */
function bodyError(body: unknown): QuotaResult | null {
  if (!isRecord(body)) return { ok: false, code: 'network' }
  const code = body['code']
  const ok = code === 200 || code === '200' || body['success'] === true
  if (ok) return null
  const text = `${String(code ?? '')} ${String(body['msg'] ?? '')}`
  return { ok: false, code: codeFromText(text) ?? 'unauthorized' }
}

export type ZcodeDeps = {
  readKey?: (signal: AbortSignal) => Promise<string | null>
  fetchQuota?: (key: string, signal: AbortSignal) => Promise<{ status: number; body: unknown }>
}

const defaultFetchQuota = async (
  key: string,
  signal: AbortSignal
): Promise<{ status: number; body: unknown }> => {
  // Authorization 不加 Bearer —— 智谱这个端点要的是裸 Key（glm-plan-usage 插件同款）
  const res = await fetch(QUOTA_URL, {
    headers: { Authorization: key, 'Accept-Language': 'zh-CN,zh' },
    signal
  })
  let body: unknown = null
  try {
    body = await res.json()
  } catch {
    body = null
  }
  return { status: res.status, body }
}

export function createZcodeCollector(deps: ZcodeDeps = {}) {
  const readKey = deps.readKey
    ?? ((signal: AbortSignal) => readKeychain(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, signal))
  const fetchQuota = deps.fetchQuota ?? defaultFetchQuota

  return async function collectZcode(signal: AbortSignal): Promise<QuotaResult> {
    const key = await readKey(signal)
    if (!key) return { ok: false, code: 'missing_key' }

    let status: number
    let body: unknown
    try {
      ;({ status, body } = await fetchQuota(key, signal))
    } catch {
      return { ok: false, code: 'network' }
    }
    if (status < 200 || status >= 300) return { ok: false, code: codeFromStatus(status) }

    const err = bodyError(body)
    if (err) return err
    const parsed = parseZcode(body)
    if (!parsed) return { ok: false, code: 'network' }
    return {
      ok: true,
      windows: parsed.windows,
      plan: parsed.plan,
      sampledAt: new Date().toISOString()
    }
  }
}
