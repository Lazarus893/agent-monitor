/**
 * Claude Code 额度。
 *
 * 主来源是本地文件：Claude Code 每秒喂给 statusline 的 JSON 里就有
 * `rate_limits.five_hour / seven_day`，由 scripts/claude-statusline-tee.sh **按会话**落到
 * ~/.agent-monitor/claude-ratelimits/<session_id>.json —— 几十个会话各写各的，
 * 由这里合并（见 mergeSamples）。零网络、零凭据、有会话时就是实时的。
 *
 * 备用来源是 Keychain 里的 OAuth token 调 /api/oauth/usage —— 今天本机实测：
 * 该端点连续 429（tests/fixtures/claude-oauth-429.json 是真实响应），而且
 * `Claude Code-credentials` 里的 accessToken 是空串。所以它只能是**低频兜底**：
 * 最少 5 min 一次，429 之后指数退避到 30 min，永远不会因为它而把主来源挤掉。
 *
 * 文件旧了（最近一次会话写入超过 10 min）但刷新没成 → 把旧数字连同写入时间一起交出去（stale），
 * 而不是把瓦片清成一句错误文案：旧数字仍然是这块屏上最有用的信息。
 *
 * 「屏上说什么」这件事有两条纪律（M2 复核 P1-①）：
 *   1. **文件从来没有过 = tee 还没装**，那就稳定地说「还没接入 statusline」（empty），
 *      OAuth 拿不到令牌只用来决定要不要退避，不上屏。以前这里会先试 OAuth、
 *      再按「被节流」回落，于是码序列成了 unauthorized×1 → no_statusline×19 循环 ——
 *      屏上每 5 分钟闪 15 秒红色 401，而其实什么都没变。
 *   2. **兜底的结论是粘的**：两次真正的 OAuth 之间（5–30 min）一直复述上一次的结论，
 *      而不是回落到另一个码。只有真的 401/403 才 unauthorized、真的 429 才 rate_limited。
 */

import { readdir, readFile, stat, unlink } from 'node:fs/promises'
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'
import type { QuotaWindow } from '../../../shared/types.js'
import type { QuotaResult } from './types.js'
import { codeFromStatus, isRecord, toIso, toInt } from './types.js'
import { readKeychain } from './keychain.js'

/** 一个会话一份：`<session_id>.json`（拿不到 id 时是 `nosid-<ppid>.json`） */
export const STATUSLINE_DIR = join(homedir(), '.agent-monitor', 'claude-ratelimits')
/** 升级前那一份所有会话共写的单文件。现在没有任何东西写它，见到就删。 */
export const LEGACY_FILE = join(homedir(), '.agent-monitor', 'claude-ratelimits.json')
/** 超过这么久没动过的文件直接删掉 —— 会话早结束了（按 mtime 算，坏 JSON 与 .tmp 残留一并清） */
export const SESSION_TTL_MS = 24 * 3600_000
/** 最近一次会话写入超过这个岁数就该去刷新（简报：10 min）。判定在 run() 里。 */
export const FILE_FRESH_MS = 10 * 60_000
/** OAuth 兜底的最小间隔（简报：5 min） */
export const OAUTH_MIN_GAP_MS = 5 * 60_000
/** 429 退避的上限（简报：30 min） */
export const OAUTH_MAX_GAP_MS = 30 * 60_000
export const OAUTH_URL = 'https://api.anthropic.com/api/oauth/usage'
const KEYCHAIN_SERVICE = 'Claude Code-credentials'

/**
 * 从任意一种载体里取出两个窗口。三种形状都要吃得下：
 *   · tee 写的包装 `{ writtenAt, payload: <statusline JSON> }`
 *   · statusline JSON 本身 `{ rate_limits: { five_hour, seven_day } }`
 *   · OAuth usage 的返回 `{ five_hour, seven_day }`
 * used_percentage / utilization 两个字段名、resets_at 的 ISO / epoch 两种编码都容错。
 */
export function parseRateLimits(raw: unknown): QuotaWindow[] {
  if (!isRecord(raw)) return []
  const payload = isRecord(raw['payload']) ? raw['payload'] : raw
  const limits = isRecord(payload['rate_limits']) ? payload['rate_limits'] : payload

  const windows: QuotaWindow[] = []
  const push = (key: string, label: '5h' | '7d'): void => {
    const w = limits[key]
    if (!isRecord(w)) return
    const usedPercent = toInt(w['used_percentage'] ?? w['utilization'])
    const resetsAt = toIso(w['resets_at'])
    if (usedPercent === null || !resetsAt) return
    windows.push({ label, usedPercent, resetsAt })
  }
  push('five_hour', '5h')
  push('seven_day', '7d')

  /* Claude Code 在 5h 窗**没有任何使用记录**时会直接省略 `five_hour` 这个键
     （实测 2026-09-15 00:07 的 claude-ratelimits.json 就只有 seven_day）。
     映射本身一直是按键名走的，问题在下游：渲染层按**位置**取
     `windows[0]` 当 5h、`windows[1]` 当 7d，于是只剩一个窗口时，
     7 天窗的 10% / 107h55m 被 A、B 两页当成 5h 显示 —— 屏上是个看不出错的错数。

     所以缺 five_hour 时补一个**显式的占位窗**：0%、`resetsAt` 空串。
     空串是「没有重置时刻」的约定，渲染层据此显示「—」而不是算出 NaN。
     只在确实采到了 7d 的时候补 —— 一个窗口都没有的时候该走的是 notice，不是 0%。 */
  if (windows.length === 1 && windows[0]!.label === '7d') {
    windows.unshift({ label: '5h', usedPercent: 0, resetsAt: '' })
  }
  return windows
}

/** 这个窗口是「本窗口无使用记录」的占位（没有重置时刻），不是一个真的 0% */
export const isPlaceholder = (w: QuotaWindow): boolean => !w.resetsAt

/** tee 写的那个包装里的写入时间；没有就退回文件本身没有时间可用 */
export function parseWrittenAt(raw: unknown): string | null {
  return isRecord(raw) ? toIso(raw['writtenAt']) : null
}

type FileSample = { windows: QuotaWindow[]; writtenAt: string | null }

export type ClaudeDeps = {
  now?: () => number
  /** 读 statusline tee 落的**单**文件；给了就走老路径（解析用例用）。 */
  readStatusline?: () => Promise<unknown | null>
  /** 收集多会话样本；不给就扫默认目录。selftest 用它指到临时目录。 */
  collectSamples?: (now: number) => Promise<RawSample[]>
  /** 读 Keychain 里的 accessToken；拿不到（没有 / 空串 / 已过期）返回 null */
  readToken?: (now: number, signal?: AbortSignal) => Promise<string | null>
  fetchUsage?: (token: string, signal: AbortSignal) => Promise<{ status: number; body: unknown }>
}

/**
 * 一份 tee 落的样本：窗口 + 写入时刻 + 那一刻的模型显示名。
 * `at` 只用来判新鲜（10 min 窗，在 run() 里）与挑「最近一次写入」，**不参与合并取舍** ——
 * 谁的数算数由 `mergeSamples` 定。`writtenAt` 解析不出来时 `at` 是 0。
 */
export type RawSample = { windows: QuotaWindow[]; at: number; model?: string }

/**
 * 把多个会话的样本**按键合并**（2026-09-15 实机 P1）。
 *
 * 用户同时开着几十个 Claude Code 会话，每个每秒写自己那份；5h 窗没有使用记录的会话
 * 会整个省掉 `five_hour` 这个键。只取「最新的那一份」的话，读到哪份算哪份 ——
 * 面板上的 5h 就会时不时掉成占位的 0%（实测 744 次采集里 136 次 `5h=absent`）。
 *
 * **不能按 writtenAt 取最新**：实测同一刻四个会话文件写的是 `{5h 5%, 7d 26%}`、
 * `{5h 12%, 7d 28%}`、`{7d 22%}`、`{7d 24%}` —— 每个会话只知道**它自己最近一次
 * API 请求**看到的额度，闲置会话每秒重写的是个旧快照。按写入时刻挑，5h 就会在
 * 5% 与 12% 之间每 15 s 来回跳。
 *
 * 合并规则（对 five_hour / seven_day 各算各的）：
 *   1. **先把过期窗扔掉** —— `resetsAt` 不在 `now` 之后的一概不算数。闲置会话会把
 *      上一个窗口的快照一直重写下去（`{5h 97%, resets_at = 一小时前}`）；当前窗还没有
 *      任何会话报过 five_hour 时它没有对手，不扔就会一直赢，屏上长期「97% · 0m」
 *      且永远不自愈（tee 每秒重写，写入时刻永远新鲜，10 min 窗滤不掉它）。
 *      解析不出时刻的（NaN）、占位窗（空串）同样在这一步出局。
 *   2. 剩下的同键取 `usedPercent` **最大的** —— 活着的窗口只有一个，用量在一个窗口里
 *      单调不减，最大的那份就是最新的快照。
 * 两条都不看写入顺序，所以几份文件谁先谁后，结果一样。
 *
 * 只有**所有**样本都没给出一个还活着的 five_hour 时，才落到占位窗
 * （那才是真的「本窗口无使用」）。
 */
export function mergeSamples(samples: RawSample[], now: number): QuotaWindow[] {
  const best = new Map<string, QuotaWindow>()
  for (const s of samples) {
    for (const w of s.windows) {
      const resets = Date.parse(w.resetsAt)
      if (!Number.isFinite(resets) || resets <= now) continue   // 规则 1
      const cur = best.get(w.label)
      if (!cur || w.usedPercent > cur.usedPercent) best.set(w.label, w)   // 规则 2
    }
  }
  const out: QuotaWindow[] = []
  for (const label of ['5h', '7d'] as const) {
    const hit = best.get(label)
    if (hit) out.push(hit)
  }
  /* 有 7d 没 5h → 补占位窗，理由与单文件那条一样（见 parseRateLimits）：
     渲染层按位置取 windows[0] 当 5h，不补的话 7d 会被当成 5h 画出来。 */
  if (out.length === 1 && out[0]!.label === '7d') {
    out.unshift({ label: '5h', usedPercent: 0, resetsAt: '' })
  }
  return out
}

/** tee 落的包装里的 `payload.model.display_name`（给 topmodel 的兜底用） */
function parseModelName(raw: unknown): string | undefined {
  if (!isRecord(raw)) return undefined
  const payload = isRecord(raw['payload']) ? raw['payload'] : raw
  const model = payload['model']
  if (!isRecord(model)) return undefined
  const name = model['display_name']
  return typeof name === 'string' && name.trim() ? name : undefined
}

/** 读一份文件，解析成样本；读不到 / 坏 JSON 返回 null */
const readSample = async (file: string): Promise<RawSample | null> => {
  try {
    const raw: unknown = JSON.parse(await readFile(file, 'utf8'))
    const windows = parseRateLimits(raw)
    if (!windows.length) return null
    const iso = parseWrittenAt(raw)
    const at = iso ? Date.parse(iso) : 0
    const model = parseModelName(raw)
    return { windows, at: Number.isNaN(at) ? 0 : at, ...(model ? { model } : {}) }
  } catch {
    return null
  }
}

/**
 * 扫会话目录，返回**全部**还没过 24 h 的样本 —— 新鲜与否（10 min）由 run() 判，
 * 这里不筛：滤在这一层的话，`run()` 里「旧数字带 stale 交出去」那条路在默认路径上
 * 就成了死代码，冷启动（合盖过夜、早上开机）会把 20 min 前的真数字整个丢掉，
 * 屏上错说「还没接入 statusline」。
 *
 * 过期删除按 **mtime** 算，而且在读之前 —— 这样坏 JSON 与 `<sid>.json.tmp.<pid>`
 * 残留也清得掉（app 不跑的时候 tee 照写，不清就单向增长）。
 *
 * 顺手把升级前那份单文件删掉：现在没有任何东西写它，留着只会是个冻结的旧快照。
 */
export async function collectSamples(
  now: number,
  dir = STATUSLINE_DIR,
  legacy = LEGACY_FILE
): Promise<RawSample[]> {
  try { await unlink(legacy) } catch { /* 本来就没有，或删不掉：都不影响这一轮 */ }

  const out: RawSample[] = []
  let names: string[] = []
  try {
    names = await readdir(dir)
  } catch {
    return out   // 还没装 tee，或者这一程还没有任何会话写过
  }
  for (const n of names) {
    const file = join(dir, n)
    let mtime = 0
    try {
      mtime = (await stat(file)).mtimeMs
    } catch {
      continue   // 刚被别的进程 mv 走了
    }
    if (now - mtime > SESSION_TTL_MS) {
      try { await unlink(file) } catch { /* 删不掉就下一轮再说 */ }
      continue
    }
    if (!n.endsWith('.json') || n.includes('.tmp.')) continue
    const s = await readSample(file)
    if (s) out.push(s)
  }
  return out
}

/** 写入时刻最新的那一份样本；一份都没有时 null。topmodel 的模型名兜底用它。 */
export async function newestSample(
  now = Date.now(),
  dir = STATUSLINE_DIR
): Promise<RawSample | null> {
  const samples = await collectSamples(now, dir)
  if (!samples.length) return null
  return samples.reduce((a, b) => (b.at > a.at ? b : a))
}

/**
 * Keychain 条目 → 可用的 accessToken。返回 null = 没有可用令牌（不是错误，见文件头纪律 1）。
 * 已过期的令牌当作没有：刷新是 Claude Code 自己的事，我们只读。
 */
export function parseAccessToken(raw: string | null, now: number): string | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!isRecord(parsed)) return null
    const oauth = parsed['claudeAiOauth']
    if (!isRecord(oauth)) return null
    const token = oauth['accessToken']
    if (typeof token !== 'string' || !token.length) return null
    const expiresAt = oauth['expiresAt']
    if (typeof expiresAt === 'number' && expiresAt > 0 && expiresAt <= now) return null
    return token
  } catch {
    return null
  }
}

/**
 * 本机实测：login.keychain 里有**两条**同名 `Claude Code-credentials`（acct 分别是
 * 登录名与另一个账号），`security -w` 不带 -a 时返回哪一条并不保证 ——
 * 第一次读到的那条 accessToken 是空串，于是兜底看起来「永远没有令牌」。
 * 所以按顺序试：默认匹配 → 当前登录名；第一条解析得出可用令牌的就用它。
 */
const defaultReadToken = async (now: number, signal?: AbortSignal): Promise<string | null> => {
  const accounts: Array<string | undefined> = [undefined, userInfo().username]
  for (const account of accounts) {
    const token = parseAccessToken(await readKeychain(KEYCHAIN_SERVICE, account, signal), now)
    if (token) return token
  }
  return null
}

const defaultFetchUsage = async (
  token: string,
  signal: AbortSignal
): Promise<{ status: number; body: unknown }> => {
  const res = await fetch(OAUTH_URL, {
    headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
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

type OAuthFailure = 'unauthorized' | 'rate_limited' | 'network'

export class ClaudeCollector {
  private lastOAuthAt = 0
  /** 上一次**真的调过** OAuth 的结论；null = 从没调过或上一次成功了 */
  private lastOAuthCode: OAuthFailure | null = null
  /** 当前要求的 OAuth 间隔：起步 5 min，每次 429 翻倍，封顶 30 min */
  private gapMs = OAUTH_MIN_GAP_MS
  /* `readStatusline` / `collectSamples` **保持可选**：有没有被注入，正是
     「走老的单文件路径」还是「走多会话合并」的判据。给它们兜一个默认值的话，
     `this.d.readStatusline` 永远为真，合并那条路就再也走不到了。 */
  private readonly d: Required<Omit<ClaudeDeps, 'readStatusline' | 'collectSamples'>>
    & Pick<ClaudeDeps, 'readStatusline' | 'collectSamples'>

  constructor(deps: ClaudeDeps = {}) {
    this.d = {
      now: deps.now ?? Date.now,
      readStatusline: deps.readStatusline,
      collectSamples: deps.collectSamples,
      readToken: deps.readToken ?? defaultReadToken,
      fetchUsage: deps.fetchUsage ?? defaultFetchUsage
    }
  }

  run = async (signal: AbortSignal): Promise<QuotaResult> => {
    const now = this.d.now()
    const file = await this.readFile(now)
    const hasFile = !!file && file.windows.length > 0

    if (hasFile) {
      const age = file.writtenAt ? now - new Date(file.writtenAt).getTime() : Infinity
      if (age <= FILE_FRESH_MS) {
        return { ok: true, windows: file.windows, sampledAt: file.writtenAt ?? undefined }
      }
    }

    const oauth = await this.tryOAuth(now, signal)
    if (oauth?.ok) return oauth

    if (!hasFile) {
      // 纪律 1：一个数字都没有过 = tee 还没装（或还没写第一轮）。
      // 无论兜底是没令牌、被节流还是 429，屏上都稳定地说「还没接入 statusline」；
      // 只有兜底**真的**给出 401 / 429 这种明确结论时才让它上屏。
      return { ok: false, code: this.lastOAuthCode ?? 'no_statusline' }
    }
    // 文件在、但旧了且刷新没成：数字留着标 stale，updatedAt 停在文件的写入时刻。
    // 兜底的失败码不覆盖数据，只决定这块瓦片旁边那句话。
    return {
      ok: false,
      code: this.lastOAuthCode ?? 'no_statusline',
      windows: file.windows,
      sampledAt: file.writtenAt ?? undefined
    }
  }

  /**
   * 这一轮的文件样本。
   *
   * 默认走**多会话合并**（`collectSamples` + `mergeSamples`），返回 24 h 内的全部样本；
   * `deps.readStatusline` 被注入时（单测）仍走老的单文件路径 —— 那些用例测的是解析，
   * 不是合并，两者各有各的用例。
   */
  private collect(now: number): Promise<RawSample[]> {
    return this.d.collectSamples ? this.d.collectSamples(now) : collectSamples(now)
  }

  /** `now` 由 run() 传进来，不在这里另取一次 —— 新鲜判定与合并必须用同一个时刻。 */
  private async readFile(now: number): Promise<FileSample | null> {
    if (this.d.readStatusline) {
      const raw = await this.d.readStatusline()
      if (raw === null || raw === undefined) return null
      return { windows: parseRateLimits(raw), writtenAt: parseWrittenAt(raw) }
    }
    const samples = await this.collect(now)
    if (!samples.length) return null
    const windows = mergeSamples(samples, now)
    if (!windows.length) return null
    /* 写入时刻取最新的那一份。注意它衡量的是「**最近一次有会话重写了文件**」，
       不是「最近一次看到这个数字」—— 闲置会话每秒重写的也是旧快照。
       屏上那句「数据 N 分钟前」因此结构性偏乐观；它的用途是判「tee 是不是还活着」，
       这个含义下是准的。 */
    const newest = samples.reduce((a, b) => (b.at > a.at ? b : a))
    return { windows, writtenAt: newest.at ? new Date(newest.at).toISOString() : null }
  }

  /**
   * 返回 null = 这一轮没有真的去调（离上一次不够久，或本机压根没有可用令牌）。
   * 每一次**真的调过**之后把结论记在 lastOAuthCode 上，两次之间由 run() 复述它 ——
   * 否则 15 s 一轮的链条会在「刚调过的结论」与「默认码」之间来回跳（纪律 2）。
   */
  private async tryOAuth(
    now: number,
    signal: AbortSignal
  ): Promise<Extract<QuotaResult, { ok: true }> | { ok: false; code: OAuthFailure } | null> {
    if (this.lastOAuthAt && now - this.lastOAuthAt < this.gapMs) return null

    const token = await this.d.readToken(now, signal)
    if (!token) {
      // 没有可用令牌（没有条目 / 空串 / 已过期）：兜底这条路本来就不存在，
      // 不算一次「调用」—— 不记时间、不记结论，屏上由文件那一侧说了算。
      return null
    }
    this.lastOAuthAt = now

    const settle = (code: OAuthFailure, gap: number): { ok: false; code: OAuthFailure } => {
      this.gapMs = gap
      this.lastOAuthCode = code
      return { ok: false, code }
    }

    let status: number
    let body: unknown
    try {
      ;({ status, body } = await this.d.fetchUsage(token, signal))
    } catch {
      return settle('network', OAUTH_MIN_GAP_MS)
    }

    if (status === 429) {
      return settle('rate_limited', Math.min(Math.max(this.gapMs * 2, OAUTH_MIN_GAP_MS * 2), OAUTH_MAX_GAP_MS))
    }
    if (status < 200 || status >= 300) return settle(codeFromStatus(status), OAUTH_MIN_GAP_MS)

    const windows = parseRateLimits(body)
    if (!windows.length) return settle('network', OAUTH_MIN_GAP_MS)

    this.gapMs = OAUTH_MIN_GAP_MS
    this.lastOAuthCode = null
    return { ok: true, windows, sampledAt: new Date(now).toISOString() }
  }
}
