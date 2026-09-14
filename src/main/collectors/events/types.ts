/**
 * 三个事件 collector 的共同契约。
 *
 * 与额度那一层不同：额度是「每轮问一次，拿回一份快照」，事件是「事情发生时推一条」。
 * 所以这里没有 run(signal)，只有一个 sink —— 谁先看见谁先推，
 * 去重、排序、未读判定、持久化全部集中在 store 那一侧（一处判定，三家共用）。
 */

import type { AgentEvent, AgentId, AgentStatus } from '../../../shared/types.js'

/**
 * collector 推上来的一条。`acked` 不由 collector 决定 ——
 * 「这条算不算新」是 store 的判断：启动回灌的一律已读，启动之后新到的才是未读
 * （简报「统一行为」第 4 条：主进程只在**启动之后新到**的事件上标 isNew）。
 */
export type EventInput = Omit<AgentEvent, 'acked'>

export type EventSink = {
  /** 推一条事件。同 id 去重，同 sessionId 覆盖（一个会话在列表里只占一行）。 */
  emit(input: EventInput): void
  /** 某家 agent 的整体状态变了（running / attention / idle / offline） */
  status(agent: AgentId, status: AgentStatus): void
  /** 一行日志。统一从这里走，测试里可以把它收集起来断言。 */
  log(line: string): void
}

export type EventCollector = {
  name: string
  start(): void | Promise<void>
  stop(): void | Promise<void>
}

/** running 超过这个时长还没收尾就自动清除（简报「统一行为」第 3 条） */
export const RUNNING_TIMEOUT_MS = 2 * 60 * 60_000

/** 启动时回灌的窗口：最近 24 h 的事件按已读补进列表 */
export const BACKFILL_MS = 24 * 60 * 60_000

/** 事件列表上限（持久化与内存共用） */
export const MAX_EVENTS = 200

/** 标题 / 摘要的长度上限 —— 副屏一行放不下更多，也避免把整段 transcript 带进状态 */
export const TITLE_MAX = 80
export const SUMMARY_MAX = 120

/**
 * 压成一行。换行、连续空白、控制字符全部折叠成单空格。
 * 会进屏、会进日志的文本都过这一道 —— 一条带换行的 prompt 能把一行日志撑成十行。
 */
export function oneLine(s: string): string {
  let out = ''
  for (const ch of s) {
    const c = ch.codePointAt(0)!
    out += c < 0x20 || c === 0x7f ? ' ' : ch
  }
  return out.replace(/\s+/g, ' ').trim()
}

export function clip(s: string, max: number): string {
  const t = oneLine(s)
  return t.length <= max ? t : t.slice(0, max - 1) + '…'
}

/** `~/Downloads/x` 这种写法：日志与行尾都用它，绝对路径太长 */
export function tilde(p: string, home: string): string {
  if (!p) return ''
  return p === home ? '~' : p.startsWith(home + '/') ? '~' + p.slice(home.length) : p
}

/**
 * 首条用户提问里该跳过的系统块。
 * Codex 的第一条 `input_text` 常常是 `<permissions instructions>` / `<environment_context>`
 * 这类注入，Claude 的第一条则可能是 `# CLAUDE.md` 的内容。它们不是用户问的问题，
 * 拿来当标题会让整块屏上全是同一句系统文案。
 */
export function looksLikeSystemBlock(text: string): boolean {
  const t = text.trimStart()
  return t.startsWith('<') || t.startsWith('#')
}
