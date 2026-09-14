/**
 * 事件与 ack 的落盘 —— `userData/events.json`，最多 200 条，原子写。
 *
 * 为什么要落盘：验收第 4 条「重启 app 后历史事件不重复报警；未读 ack 状态保留」。
 * 不落盘的话，每次重启都会把最近 24 h 的 Codex 历史整读一遍，屏上跳 C 页响一串铃；
 * 而已经标过已读的那几条又会重新变红。
 *
 * 恢复语义：**全部回灌为已读**。这不是把用户的 ack 状态丢了 ——
 * 而是「重启之后没有任何一件事是刚刚发生的」。真正需要保留的是「这条我见过」，
 * 靠的是 id 进了列表之后就不会被 collector 再当新事件推一遍（Feed.ids）。
 *
 * 写盘是合并的：一秒内的多次变化只写一次，避免 3 s 轮询把磁盘打满。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AgentEvent } from '../../../shared/types.js'
import { MAX_EVENTS } from './types.js'

export const FILE_NAME = 'events.json'
/** 写盘合并窗口 */
export const FLUSH_MS = 1_000

export type Persisted = { version: 1; savedAt: string; events: AgentEvent[] }

export const fileIn = (userData: string): string => join(userData, FILE_NAME)

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

/** 逐条校验：坏掉的一条不该让整份历史作废 */
export function parse(raw: unknown): AgentEvent[] {
  if (!isRec(raw) || !Array.isArray(raw['events'])) return []
  const out: AgentEvent[] = []
  for (const e of raw['events']) {
    if (!isRec(e)) continue
    const { id, agent, kind, title, at } = e
    if (typeof id !== 'string' || typeof title !== 'string' || typeof at !== 'string') continue
    if (agent !== 'codex' && agent !== 'claude' && agent !== 'zcode') continue
    if (kind !== 'completed' && kind !== 'failed' && kind !== 'attention' && kind !== 'running') continue
    out.push({ ...(e as unknown as AgentEvent), acked: true })
    if (out.length >= MAX_EVENTS) break
  }
  return out
}

export function load(userData: string): AgentEvent[] {
  try {
    return parse(JSON.parse(readFileSync(fileIn(userData), 'utf8')))
  } catch {
    return []
  }
}

/**
 * 空表守卫（复核 P1-①的第二道）。
 * 「内存里一条都没有」有两种可能：真的没有历史，或者这一程根本没人往 Saver 里塞过快照。
 * 后者在稳态重启时是常态，而它会把盘上的历史整份抹掉。
 * 判据取「盘上还有没有」——盘上非空而内存为空，一律当成第二种，不写。
 */
export function wouldWipe(userData: string, events: AgentEvent[]): boolean {
  return events.length === 0 && load(userData).length > 0
}

export function save(userData: string, events: AgentEvent[]): boolean {
  const file = fileIn(userData)
  if (wouldWipe(userData, events)) {
    console.warn('[events] 内存里没有事件而盘上有，跳过这次落盘（不抹历史）')
    return false
  }
  try {
    mkdirSync(dirname(file), { recursive: true })
    const body: Persisted = {
      version: 1,
      savedAt: new Date().toISOString(),
      // running 行不落盘：重启之后它一定已经不在跑了，留着会显示一条永远不动的「进行中」
      events: events.filter(e => e.kind !== 'running').slice(0, MAX_EVENTS)
    }
    const tmp = file + '.tmp'
    writeFileSync(tmp, JSON.stringify(body), { mode: 0o600 })
    renameSync(tmp, file)
    return true
  } catch (err) {
    console.warn(`[events] 落盘失败：${String(err)}`)
    return false
  }
}

/** 合并写：一秒内的多次调用只落一次盘 */
export class Saver {
  private timer: ReturnType<typeof setTimeout> | null = null
  private latest: AgentEvent[] = []
  /** 从来没被 schedule 过就什么都别写 —— 那时 latest 的空表不代表「历史是空的」 */
  private primed = false

  constructor(private userData: string, private flushMs = FLUSH_MS) {}

  schedule(events: AgentEvent[]): void {
    this.latest = events
    this.primed = true
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      save(this.userData, this.latest)
    }, this.flushMs)
  }

  /** 退出前把最后一次变化落下去 */
  flush(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (!this.primed) return
    save(this.userData, this.latest)
  }
}
