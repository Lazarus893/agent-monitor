/**
 * 三个额度 collector 的共同契约。
 *
 * 一次采集只有两种结局：拿到窗口，或者拿到一个错误码。错误码直接复用渲染层的
 * NoticeCode —— 采集层不产文案（文案是设计稿的一部分，留在 app.ts 的 NOTICE_COPY），
 * 只负责判断「是哪一种失败」。
 *
 * 失败仍可能带 windows：Claude 的主来源是本地文件，文件在而刷新失败时，
 * 上一轮的数字仍然是真的，只是旧了 —— 这种情况回传 windows + sampledAt，
 * 由 Store 保留数字并标 stale（简报「统一行为」第二条）。
 */

import type { NoticeCode, QuotaWindow } from '../../../shared/types.js'

export type QuotaErrorCode = Extract<
  NoticeCode,
  'unauthorized' | 'rate_limited' | 'network' | 'missing_key' | 'missing_tool' | 'no_statusline'
>

export type QuotaResult =
  | { ok: true; windows: QuotaWindow[]; plan?: string; sampledAt?: string }
  | { ok: false; code: QuotaErrorCode; windows?: QuotaWindow[]; sampledAt?: string }

/** 失败码 → notice 的色调。missing_* / no_statusline 是「还没接上」而不是「坏了」，走 empty。 */
export const ERROR_TONE: Record<QuotaErrorCode, 'empty' | 'error'> = {
  unauthorized: 'error',
  rate_limited: 'error',
  network: 'error',
  missing_key: 'empty',
  missing_tool: 'empty',
  no_statusline: 'empty'
}

/**
 * 一段文本里认得出的失败特征。codexbar 的 stderr、智谱的 msg 都只能靠文本判。
 * 判据要窄：它只在 JSON 解析失败之后才跑，而 unauthorized 与 network 的下一步完全相反
 * （去重新登录 vs 什么都别做）。所以状态码要求词边界，中文要求「令牌/鉴权 + 失效」连用，
 * 光出现「登录」两个字不算（复核 §2.4）。
 */
export function codeFromText(text: string): QuotaErrorCode | null {
  if (/\b(401|403)\b|unauthor|invalid[_ -]?api[_ -]?key|token[^\n]{0,20}(expired|invalid)|(令牌|凭据|鉴权|登录状态)[^\n]{0,6}(过期|失效|无效|失败)/i.test(text)) {
    return 'unauthorized'
  }
  if (/\b429\b|rate.?limit|too many requests|请求过于频繁|限流/i.test(text)) return 'rate_limited'
  return null
}

/** HTTP 状态码 → 失败码。2xx 之外都算失败。 */
export function codeFromStatus(status: number): 'unauthorized' | 'rate_limited' | 'network' {
  if (status === 401 || status === 403) return 'unauthorized'
  if (status === 429) return 'rate_limited'
  return 'network'
}

/** resets_at 有两种编码：ISO 字符串，或 epoch（秒 / 毫秒）。两种都要落到同一个时刻。 */
export function toIso(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v)) {
    // 2001-09-09 之后的秒级时间戳都 > 1e9，毫秒级都 > 1e12：用 1e12 当分界
    const ms = v > 1e12 ? v : v * 1000
    const d = new Date(ms)
    return Number.isNaN(d.getTime()) ? null : d.toISOString()
  }
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v)
    if (Number.isFinite(n) && /^\d+$/.test(v.trim())) return toIso(n)
    const d = new Date(v)
    return Number.isNaN(d.getTime()) ? null : d.toISOString()
  }
  return null
}

/**
 * 非负整数：百分比与计数共用（接口给过 number 也给过字符串，非有限值一律当没有）。
 * 刻意不夹到 0–100 —— 智谱的 TIME_LIMIT 用它转 19 / 1000 这种计数（复核 §5-3）。
 */
export function toInt(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : v
  if (typeof n !== 'number' || !Number.isFinite(n)) return null
  return Math.max(0, Math.round(n))
}

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null

/** 日志里的一行摘要：`5h=22% 7d=7%`。只出百分比，不出任何来源字段。 */
export const summarize = (windows: QuotaWindow[]): string =>
  windows.map(w => `${w.label}=${w.usedPercent}%`).join(' ') || '(无窗口)'
