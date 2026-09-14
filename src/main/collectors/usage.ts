/**
 * 每日用量（D 页热力图的数据）。
 *
 * 三家的来源与单位（M3b 简报那张表 + 本机实测）：
 *   Codex  `codexbar cost --provider codex --format json` → `[{ daily: [{date,totalTokens}] }]`
 *   Claude 同上换 provider（codexbar 读本机 ~/.claude/projects 转录算的）
 *   ZCode  `~/.zcode/cli/db/db.sqlite` 的 **model_usage** 表 —— 2026-09-14 `.schema` 实测列名：
 *            started_at(ms epoch)、input_tokens、output_tokens、reasoning_tokens、
 *            cache_creation_input_tokens、cache_read_input_tokens、model_id、status
 *          按天聚合 input+output+reasoning（不含 cache_read：它是复用，不是新消耗，
 *          算进去会让 ZCode 的数字比另外两家虚高一个量级）。
 *          turn_usage 也有 computed_total_tokens，但它按 turn 记、且含缓存读，
 *          与 codexbar 的口径差更远 —— 选 model_usage。
 *          取不到（表没了 / sqlite3 不在）才退回日志里的请求数。
 *
 * 注意 codexbar 的返回顶层是**数组**（`[{...}]`），不是对象 —— 直接 `.daily` 会拿到 undefined。
 * 单次可能跑 30–90 s（本机实测两家合计约 8 s），所以它有自己的调度：
 * 30 min 一轮、超时 120 s、与三个额度 collector 互不阻塞。
 */

import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentId, UsageData, UsageDay } from '../../shared/types.js'

export const CODEXBAR_CANDIDATES = ['codexbar', '/opt/homebrew/bin/codexbar', '/usr/local/bin/codexbar']
export const ZCODE_USAGE_DB = join(homedir(), '.zcode', 'cli', 'db', 'db.sqlite')
export const SQLITE = '/usr/bin/sqlite3'
export const WEEKS = 8
export const REFRESH_MS = 30 * 60_000
export const TIMEOUT_MS = 120_000

/** 本地日期 YYYY-MM-DD（不能用 toISOString：那是 UTC，晚上八点之后会算到明天） */
export function localDate(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * 近 N 周的日期序列，**周一起算**、以今天所在的那一周结尾。
 * 热力图是 7 行 × N 列，列必须从周一开始，否则格子会错位一天。
 */
export function dateWindow(weeks: number, today = new Date()): string[] {
  const end = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  // getDay(): 周日 = 0。要让周一 = 0
  const dow = (end.getDay() + 6) % 7
  const start = new Date(end)
  start.setDate(end.getDate() - dow - (weeks - 1) * 7)
  const out: string[] = []
  for (const d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) out.push(localDate(d))
  return out
}

type Daily = { date?: string; totalTokens?: number }

/** codexbar 的返回：`[{ daily: [...] }]` 或 `{ daily: [...] }`，两种都吃 */
export function parseCodexbarCost(raw: unknown): Map<string, number> {
  const root = Array.isArray(raw) ? raw[0] : raw
  const out = new Map<string, number>()
  if (typeof root !== 'object' || root === null) return out
  const daily = (root as Record<string, unknown>)['daily']
  if (!Array.isArray(daily)) return out
  for (const d of daily as Daily[]) {
    if (!d || typeof d.date !== 'string') continue
    const n = typeof d.totalTokens === 'number' && Number.isFinite(d.totalTokens) ? d.totalTokens : 0
    out.set(d.date, (out.get(d.date) ?? 0) + n)
  }
  return out
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<string | null> {
  return new Promise(resolve => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 32 << 20 }, (err, stdout) =>
      resolve(err ? null : stdout))
  })
}

/**
 * codexbar 可能不在 PATH 里（Electron 的 PATH 比登录 shell 短），所以要试几个路径。
 * 超时预算是**整个查找过程**的，不是每个候选各给一份（复核 P2-4.5）——
 * 三个候选各 120 s 串起来最坏 6 分钟，那时这一轮 usage 已经毫无意义了。
 * 不存在的路径会 ENOENT 秒失败，真正花时间的只有「二进制在但卡住」那一个。
 */
async function codexbar(args: string[], timeoutMs: number): Promise<string | null> {
  const deadline = Date.now() + timeoutMs
  for (const bin of CODEXBAR_CANDIDATES) {
    const left = deadline - Date.now()
    if (left <= 0) return null
    const out = await run(bin, args, left)
    if (out !== null) return out
  }
  return null
}

export async function collectCodexbar(
  provider: 'codex' | 'claude',
  timeoutMs = TIMEOUT_MS
): Promise<Map<string, number> | null> {
  const out = await codexbar(['cost', '--provider', provider, '--format', 'json'], timeoutMs)
  if (out === null) return null
  try {
    return parseCodexbarCost(JSON.parse(out))
  } catch {
    return null
  }
}

export const ZCODE_TOKENS_SQL =
  "select date(started_at/1000,'unixepoch','localtime') d, " +
  'sum(input_tokens+output_tokens+reasoning_tokens) v from model_usage ' +
  "where started_at >= (strftime('%s','now','-70 days'))*1000 group by 1"

export const ZCODE_REQUESTS_SQL =
  "select date(started_at/1000,'unixepoch','localtime') d, count(*) v from model_usage " +
  "where started_at >= (strftime('%s','now','-70 days'))*1000 group by 1"

export function parseSqliteDays(raw: unknown): Map<string, number> {
  const out = new Map<string, number>()
  if (!Array.isArray(raw)) return out
  for (const r of raw) {
    if (typeof r !== 'object' || r === null) continue
    const o = r as Record<string, unknown>
    if (typeof o['d'] !== 'string') continue
    const v = typeof o['v'] === 'number' ? o['v'] : Number(o['v'])
    out.set(o['d'], Number.isFinite(v) ? v : 0)
  }
  return out
}

/** ZCode：先试 token，表不对再退回请求数。返回值带单位。 */
export async function collectZcode(
  db = process.env.MONITOR_ZCODE_USAGE_DB || ZCODE_USAGE_DB
): Promise<{ days: Map<string, number>; unit: 'tokens' | 'requests' } | null> {
  for (const [sql, unit] of [[ZCODE_TOKENS_SQL, 'tokens'], [ZCODE_REQUESTS_SQL, 'requests']] as const) {
    const out = await run(SQLITE, ['-readonly', '-json', db, sql], 20_000)
    if (out === null) continue
    const text = out.trim()
    if (!text) return { days: new Map(), unit }
    try {
      return { days: parseSqliteDays(JSON.parse(text)), unit }
    } catch { /* 换下一条 SQL */ }
  }
  return null
}

/**
 * 归一。三家各自按本窗口内的最大值除一次，再取均值。
 * 不能先加总再归一：Claude 一天 7 亿 token，ZCode 一天 5 千万，加起来 ZCode 就消失了。
 */
export function buildDays(
  dates: string[],
  per: Partial<Record<AgentId, Map<string, number>>>,
  zcodeUnit: 'tokens' | 'requests'
): UsageDay[] {
  const ids: AgentId[] = ['codex', 'claude', 'zcode']
  const max: Record<string, number> = {}
  for (const id of ids) {
    let m = 0
    for (const d of dates) m = Math.max(m, per[id]?.get(d) ?? 0)
    max[id] = m
  }
  return dates.map(date => {
    const vals = ids.map(id => {
      const v = per[id]?.get(date) ?? 0
      return max[id]! > 0 ? v / max[id]! : 0
    })
    const intensity = Math.round((vals.reduce((a, b) => a + b, 0) / ids.length) * 1000) / 1000
    return {
      date,
      byAgent: {
        codex: { tokens: per.codex?.get(date) ?? 0 },
        claude: { tokens: per.claude?.get(date) ?? 0 },
        zcode: zcodeUnit === 'tokens'
          ? { tokens: per.zcode?.get(date) ?? 0 }
          : { requests: per.zcode?.get(date) ?? 0 }
      },
      intensity
    }
  })
}

export async function collectUsage(weeks = WEEKS, today = new Date()): Promise<UsageData> {
  const dates = dateWindow(weeks, today)
  const [codex, claude, zcode] = await Promise.all([
    collectCodexbar('codex'),
    collectCodexbar('claude'),
    collectZcode()
  ])
  const per: Partial<Record<AgentId, Map<string, number>>> = {}
  if (codex) per.codex = codex
  if (claude) per.claude = claude
  if (zcode) per.zcode = zcode.days
  const unit = zcode?.unit ?? 'tokens'

  const data: UsageData = {
    updatedAt: new Date().toISOString(),
    weeks,
    days: buildDays(dates, per, unit),
    units: { codex: 'tokens', claude: 'tokens', zcode: unit }
  }
  // 三家全空 = 一个来源都没通上，画错态而不是画一整片空格子
  if (!codex && !claude && !zcode) data.error = 'missing_tool'
  return data
}

/** 只有一行日志，且只有数量级，不出具体 token 数以外的任何东西 */
export function logLine(u: UsageData): string {
  const active = u.days.filter(d => d.intensity > 0).length
  return `[usage] ${u.weeks} 周 ${u.days.length} 天，活跃 ${active} 天` +
    (u.error ? `（${u.error}）` : '')
}
