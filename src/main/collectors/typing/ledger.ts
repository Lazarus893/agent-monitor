/**
 * 逐日字数账本 —— `userData/typing.json`。
 *
 * `{ version: 1, days: { "YYYY-MM-DD": <字数> } }`，本地日期口径
 * （不能用 toISOString：那是 UTC，晚上八点之后会算到明天）。
 * 屏上的三个数全部从这一份派生，不另存一份「今日」——
 * 存两份就会有一份是错的，而跨零点那一刻恰好是它最容易错的时候。
 *
 * 写盘去抖 5 s：打字时每个字都会改账本，不合并的话一分钟写几百次盘。
 * stop() 时 flush，退出不丢最后几个字。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { localDate } from '../usage.js'

export const FILE_NAME = 'typing.json'
/** 写盘合并窗口 */
export const FLUSH_MS = 5_000

export type LedgerFile = { version: 1; days: Record<string, number> }

export const fileIn = (userData: string): string => join(userData, FILE_NAME)

/** 今日 / 昨天 / 连续天数，全部从账本算 */
export type Derived = { today: number; yesterday: number; streak: number }

/** 日期加减，走本地日历（月末、夏令时都交给 Date 处理） */
export function shiftDate(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number)
  return localDate(new Date(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + days))
}

/** 逐条校验：坏掉的一天不该让整份账本作废 */
export function parse(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {}
  if (typeof raw !== 'object' || raw === null) return out
  const days = (raw as Record<string, unknown>)['days']
  if (typeof days !== 'object' || days === null) return out
  for (const [k, v] of Object.entries(days as Record<string, unknown>)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(k)) continue
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) continue
    out[k] = Math.round(v)
  }
  return out
}

/**
 * streak 含今天。今天还是 0 时从昨天往回数 ——
 * 早上八点打开电脑还没敲字，不该看到连续天数被清成 0。
 */
export function derive(days: Record<string, number>, today: string): Derived {
  const at = (d: string): number => days[d] ?? 0
  const yesterday = shiftDate(today, -1)
  let cur = at(today) > 0 ? today : yesterday
  let streak = 0
  while (at(cur) > 0) {
    streak++
    cur = shiftDate(cur, -1)
  }
  return { today: at(today), yesterday: at(yesterday), streak }
}

export class Ledger {
  /** 内存里就是权威的那一份；盘上只是它的快照 */
  readonly days: Record<string, number>
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private userData: string, private flushMs = FLUSH_MS) {
    this.days = load(userData)
  }

  /** 记一笔。delta 可负（拼音上屏的回落），但一天不会记成负数。 */
  add(date: string, delta: number): number {
    const next = Math.max(0, (this.days[date] ?? 0) + delta)
    this.days[date] = next
    this.schedule()
    return next
  }

  derive(today: string): Derived {
    return derive(this.days, today)
  }

  private schedule(): void {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      save(this.userData, this.days)
    }, this.flushMs)
  }

  /** 退出前把最后几个字落下去 */
  flush(): void {
    if (!this.timer) return
    clearTimeout(this.timer)
    this.timer = null
    save(this.userData, this.days)
  }
}

export function load(userData: string): Record<string, number> {
  try {
    return parse(JSON.parse(readFileSync(fileIn(userData), 'utf8')))
  } catch {
    return {}
  }
}

export function save(userData: string, days: Record<string, number>): boolean {
  const file = fileIn(userData)
  try {
    mkdirSync(dirname(file), { recursive: true })
    const body: LedgerFile = { version: 1, days }
    const tmp = file + '.tmp'
    writeFileSync(tmp, JSON.stringify(body), { mode: 0o600 })
    renameSync(tmp, file)
    return true
  } catch (err) {
    console.warn(`[typing] 账本落盘失败：${String(err)}`)
    return false
  }
}
