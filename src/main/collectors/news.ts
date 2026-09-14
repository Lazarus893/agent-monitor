/**
 * 今日 AI 大事（E 页）—— AIHOT 的匿名只读 API。
 *
 * `GET https://aihot.news/api/v1/items?mode=selected&window=24h&limit=5`
 * 无需 Key、无需登录；按站方要求带 `User-Agent: agent-monitor/<v> (personal, non-commercial)`，
 * 响应头里的 `ETag` 下一轮带回 `If-None-Match`（304 时沿用上一份，省流量也省他们的机器）。
 *
 * 本机 2026-09-14 实测的返回形状：
 *   { schemaVersion: 1, query: {...}, items: [ {
 *       id, title, originalTitle, summary,
 *       source: { name },                       ← 对象，不是字符串
 *       links:  { aihot, original },            ← 阅读页优先
 *       publishedAt, discoveredAt, category, score, selected, reason,
 *       attribution: { name, url } } ], page: {...} }
 * 响应头还带 `x-aihot-commercial-use: written-authorization-required` 与
 * `link: <https://aihot.news/terms>; rel="terms-of-service"` —— 本项目是个人非商业使用，
 * 页面固定署名「数据来源：AIHOT」（渲染层负责）。
 *
 * 安全口径：返回内容一律当**不可信文本**。这里只做取字段、压成一行、截长度三件事，
 * 不预取 url、不下载图片、不缓存正文以外的任何东西，渲染层只以纯文本渲染。
 */

import type { NewsData, NewsItem } from '../../shared/types.js'
import { clip, oneLine } from './events/types.js'

export const NEWS_URL = 'https://aihot.news/api/v1/items?mode=selected&window=24h&limit=5'
export const REFRESH_MS = 30 * 60_000
/** 失败后退避到 2 h（简报） */
export const BACKOFF_MS = 2 * 60 * 60_000
export const TIMEOUT_MS = 15_000
export const TITLE_MAX = 100
export const SUMMARY_MAX = 160

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

/** source 可能是字符串，也可能是 `{ name }` */
export function sourceName(v: unknown): string | undefined {
  if (typeof v === 'string') return oneLine(v) || undefined
  if (isRec(v) && typeof v['name'] === 'string') return oneLine(v['name']) || undefined
  return undefined
}

/**
 * 「发布渠道」类的通用词。左半截是它们之一时，真正的来源名在**右边**。
 * 只列观察到的与显然同类的几个 —— 这是一份判据，不是一份词典，
 * 漏了一个的代价只是那一条少剥一层前缀，不会剥错。
 */
const CHANNEL_WORDS = new Set([
  '公众号', '微信公众号', '微信', '知乎', '知乎专栏', '专栏', '博客', '播客',
  'rss', '订阅', '新闻', '资讯', '论坛', '媒体', '来源', 'blog', 'podcast', 'newsletter'
])

/**
 * 把 AIHOT 的来源名收成能读的主名（设计终审 E-1）。
 *
 * E 页来源列实测只有约 72px ≈ 5 个全角字。原样渲染的结果是
 * `公众号： …` —— 前缀刚好吃光整列，真正的来源名一个字都没露出来，信息量为零。
 *
 * 三条实测样本（tests/fixtures/aihot-selected.json，2026-09-14 当场抓的）：
 *   `公众号：小红书技术（dots.llm）`                   → `小红书技术`
 *   `Gary Marcus：The Road to AI We Can Trust（RSS）`  → `Gary Marcus`
 *   `Hacker News：AI 热帖`                             → `Hacker News`
 *
 * 规则（按这个顺序）：
 *   1. 去掉括注 —— `（dots.llm）` / `(RSS)` 都是补充说明，不是名字；
 *   2. 在**第一个**冒号（全角或半角）处切开；
 *   3. 左半截是「公众号 / 知乎 / RSS」这类**发布渠道**词 → 取右半截，否则取左半截。
 *      为什么不是「取较短的那段」：`Hacker News：AI 热帖` 的右边更短，但主名在左边。
 *   4. 任何一步把字剥光了就退回上一步的结果 —— 宁可显示一个长名字，也不显示空白。
 *
 * 只在**取来源名**这一步做，不碰 title / summary：那两个字段是正文，
 * 删正文是编辑行为，不是清洗。
 */
export function shortSource(raw: string): string {
  const stripped = oneLine(raw.replace(/[（(][^）)]*[）)]/g, ' ')).trim()
  const base = stripped || oneLine(raw).trim()
  const m = /^([^：:]+)[：:](.+)$/.exec(base)
  if (!m) return base
  const left = m[1]!.trim()
  const right = m[2]!.trim()
  const pick = CHANNEL_WORDS.has(left.toLowerCase()) ? right : left
  return pick || base
}

/** links 里优先 AIHOT 阅读页，其次原文；两者都没有才看 url 字段 */
export function pickUrl(item: Record<string, unknown>): string | undefined {
  const links = item['links']
  const candidates: unknown[] = isRec(links) ? [links['aihot'], links['original']] : []
  candidates.push(item['url'])
  for (const c of candidates) {
    if (typeof c !== 'string') continue
    // 只接受 http(s)：javascript: / data: 这类绝不进状态
    if (/^https?:\/\//i.test(c)) return c
  }
  return undefined
}

export function parseItems(raw: unknown, limit = 5): NewsItem[] {
  const root = isRec(raw) ? raw : null
  const list = root && Array.isArray(root['items']) ? root['items'] : Array.isArray(raw) ? raw : []
  const out: NewsItem[] = []
  for (const it of list) {
    if (!isRec(it)) continue
    const title = typeof it['title'] === 'string' ? clip(it['title'], TITLE_MAX) : ''
    if (!title) continue
    const item: NewsItem = {
      id: typeof it['id'] === 'string' ? it['id'] : `aihot:${out.length}:${title.slice(0, 16)}`,
      title
    }
    if (typeof it['summary'] === 'string' && it['summary'].trim()) {
      item.summary = clip(it['summary'], SUMMARY_MAX)
    }
    const src = sourceName(it['source'])
    if (src) item.source = clip(shortSource(src), 40)
    const url = pickUrl(it)
    if (url) item.url = url
    const at = it['publishedAt'] ?? it['at']
    if (typeof at === 'string' && !Number.isNaN(Date.parse(at))) item.at = at
    if (typeof it['reason'] === 'string' && it['reason'].trim()) {
      item.reason = clip(it['reason'], SUMMARY_MAX)
    }
    out.push(item)
    if (out.length >= limit) break
  }
  return out
}

export type NewsFetchResult =
  | { ok: true; items: NewsItem[]; etag?: string }
  | { ok: true; notModified: true }
  | { ok: false; code: 'network' | 'rate_limited' | 'unauthorized' }

export async function fetchNews(
  version: string,
  etag?: string,
  signal?: AbortSignal
): Promise<NewsFetchResult> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': `agent-monitor/${version} (personal, non-commercial)`
  }
  if (etag) headers['If-None-Match'] = etag
  let res: Response
  try {
    res = await fetch(NEWS_URL, { headers, signal, redirect: 'error' })
  } catch {
    return { ok: false, code: 'network' }
  }
  if (res.status === 304) return { ok: true, notModified: true }
  if (res.status === 429) return { ok: false, code: 'rate_limited' }
  if (res.status === 401 || res.status === 403) return { ok: false, code: 'unauthorized' }
  if (!res.ok) return { ok: false, code: 'network' }
  let raw: unknown
  try {
    raw = await res.json()
  } catch {
    return { ok: false, code: 'network' }
  }
  const out: { ok: true; items: NewsItem[]; etag?: string } = { ok: true, items: parseItems(raw) }
  const tag = res.headers.get('etag')
  if (tag) out.etag = tag
  return out
}

/** 30 min 一轮；失败退避到 2 h；成功复位。启动时先用 userData 缓存渲染。 */
export class NewsCollector {
  private etag?: string
  private data: NewsData | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private failures = 0

  constructor(
    private version: string,
    private onData: (d: NewsData) => void,
    private log: (line: string) => void = console.log
  ) {}

  /** 缓存回灌（主进程启动时从 userData 读到的上一份） */
  seed(data: NewsData | null): void {
    if (!data) return
    this.data = data
    this.onData(data)
  }

  start(): void {
    void this.cycle()
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  current(): NewsData | null {
    return this.data
  }

  private async cycle(): Promise<void> {
    const ac = new AbortController()
    const killer = setTimeout(() => ac.abort(), TIMEOUT_MS)
    const r = await fetchNews(this.version, this.etag, ac.signal).catch(
      (): NewsFetchResult => ({ ok: false, code: 'network' }))
    clearTimeout(killer)

    if (r.ok) {
      this.failures = 0
      if (!('notModified' in r)) {
        this.etag = r.etag
        this.data = { updatedAt: new Date().toISOString(), items: r.items }
      } else if (this.data) {
        this.data = { ...this.data, updatedAt: new Date().toISOString() }
      }
      if (this.data) this.onData(this.data)
      this.log(`[news] ok ${'notModified' in r ? '304 沿用缓存' : r.items.length + ' 条'}`)
    } else {
      this.failures += 1
      // 有缓存就留着，只挂一个 error 码；渲染层画「缓存 + 连不上」而不是清空
      this.data = this.data
        ? { ...this.data, error: r.code }
        : { updatedAt: new Date().toISOString(), items: [], error: r.code }
      this.onData(this.data)
      this.log(`[news] error ${r.code}（第 ${this.failures} 次，退避到 2h）`)
    }

    const delay = this.failures > 0 ? BACKOFF_MS : REFRESH_MS
    this.timer = setTimeout(() => { void this.cycle() }, delay)
  }
}
