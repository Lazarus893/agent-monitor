/**
 * M3b 的三样「页面自己的数据」：每日用量、当前窗口最常用模型、AIHOT 新闻。
 *
 * 三条链各走各的周期，谁也不挡谁（简报：codexbar 单次可能 30–90 s，不能压住额度那条链）：
 *   usage 30 min · topModel 5 min · news 30 min（失败退避 2 h，在 NewsCollector 里）
 *
 * 启动时先用 userData 缓存渲染再刷新 —— 冷启动第一分钟屏上就该有东西，
 * 而不是两块空页等着 codexbar 跑完。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentId, NewsData, UsageData } from '../../shared/types.js'
import type { Store } from '../state.js'
import type { EventsHandle } from './events/index.js'
import { NewsCollector } from './news.js'
import { claudeTopModel, plainName, topOf, WINDOW_MS, REFRESH_MS as MODEL_MS } from './topmodel.js'
import { REFRESH_MS as USAGE_MS, collectUsage, logLine } from './usage.js'

const USAGE_CACHE = 'usage.json'
const NEWS_CACHE = 'news.json'

function readCache<T>(userData: string, name: string): T | null {
  try {
    return JSON.parse(readFileSync(join(userData, name), 'utf8')) as T
  } catch {
    return null
  }
}

function writeCache(userData: string, name: string, data: unknown): void {
  try {
    mkdirSync(userData, { recursive: true })
    const file = join(userData, name)
    writeFileSync(file + '.tmp', JSON.stringify(data), { mode: 0o600 })
    renameSync(file + '.tmp', file)
  } catch { /* 缓存写不进去不影响本轮显示 */ }
}

export type V2Handle = {
  stop(): void
  /** E 页点开某条时用：条目 id → 站内阅读页；没有就 undefined */
  newsLink(id: string): string | undefined
}

export function startV2(
  store: Store,
  userData: string,
  events: EventsHandle,
  version: string
): V2Handle {
  /* 每条链只持有**当前**那一个句柄。原来是 push 进数组，从不清理已触发的，
     一天下来攒 300 多个失效句柄（复核 P2-4.8）。 */
  let usageTimer: ReturnType<typeof setTimeout> | null = null
  let modelTimer: ReturnType<typeof setTimeout> | null = null

  /* ---- 1 · 每日用量 ---- */
  const cachedUsage = readCache<UsageData>(userData, USAGE_CACHE)
  if (cachedUsage?.days?.length) store.setUsage(cachedUsage)
  const usageCycle = async (): Promise<void> => {
    try {
      const u = await collectUsage()
      /* 三家全挂时别用空表盖掉**屏上现有**的那一份。
         判据必须看 store 此刻有没有 usage，不能看启动那一刻的缓存（复核 P2-4.6）：
         冷启动无缓存的那一程里 `!cachedUsage` 恒为真，于是第一轮采到好数据、
         第二轮 codexbar 一抽风，空表照样盖上去，D 页变成一整片空格子。 */
      const onScreen = store.get().usage
      if (!u.error || !onScreen?.days.length) {
        store.setUsage(u)
        if (!u.error) writeCache(userData, USAGE_CACHE, u)
      }
      console.log(logLine(u))
    } catch (err) {
      console.warn(`[usage] 采集抛出：${String(err)}`)
    }
    usageTimer = setTimeout(() => { void usageCycle() }, USAGE_MS)
  }
  void usageCycle()

  /* ---- 2 · 当前窗口最常用模型 ---- */
  // Codex 与 ZCode 的计数来自事件 collector 手上的那份缓存，所以第一轮要等它们回灌完 ——
  // 不等的话首轮问到的是三张空表，屏上要到 5 分钟后才第一次出现模型名。
  let first = true
  const modelCycle = async (): Promise<void> => {
    if (first) {
      first = false
      await events.ready
    }
    try {
      const picks: Partial<Record<AgentId, string | undefined>> = {
        codex: plainName(topOf(events.codex.modelCounts(WINDOW_MS))),
        zcode: plainName(topOf(events.zcode.modelCounts(WINDOW_MS))),
        claude: await claudeTopModel()
      }
      for (const id of ['codex', 'claude', 'zcode'] as AgentId[]) store.setTopModel(id, picks[id])
      const shown = (['codex', 'claude', 'zcode'] as AgentId[])
        .map(id => `${id}=${picks[id] ?? '-'}`).join(' ')
      console.log(`[topmodel] ${shown}`)
    } catch (err) {
      console.warn(`[topmodel] 采集抛出：${String(err)}`)
    }
    modelTimer = setTimeout(() => { void modelCycle() }, MODEL_MS)
  }
  void modelCycle()

  /* ---- 3 · AIHOT 新闻 ---- */
  const news = new NewsCollector(version, d => {
    store.setNews(d)
    if (!d.error) writeCache(userData, NEWS_CACHE, d)
  })
  news.seed(readCache<NewsData>(userData, NEWS_CACHE))
  news.start()

  return {
    stop(): void {
      if (usageTimer) clearTimeout(usageTimer)
      if (modelTimer) clearTimeout(modelTimer)
      news.stop()
    },
    /** E 页点开某条时用：条目 id → 站内阅读页。主进程还要再过一道域名校验。 */
    newsLink(id: string): string | undefined {
      return news.linkFor(id)
    }
  }
}
