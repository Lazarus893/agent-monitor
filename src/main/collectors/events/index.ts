/**
 * 把三个事件 collector 接上 Store，并管住持久化、回灌与 running 超时。
 *
 * 「新事件」的判据只有一处：`booted`。
 * 三家的 start() 都是「先把历史整读一遍，再打开监听」，这段回灌期间 booted 还是 false，
 * 所有事件以已读进列表 —— 于是重启之后屏上有历史，但不跳 C 页、不响铃（验收第 4 条）。
 * 回灌结束后翻 true，之后到达的才是真的新事件。
 */

import type { AgentEvent, AgentId, AgentStatus } from '../../../shared/types.js'
import type { Store } from '../../state.js'
import { CodexEvents } from './codex.js'
import { ClaudeEvents } from './claude.js'
import { ZcodeEvents } from './zcode.js'
import { Saver, load } from './persist.js'
import type { EventCollector, EventInput, EventSink } from './types.js'

/** running 超时巡检周期 */
const SWEEP_MS = 60_000

export type EventsHandle = {
  stop(): void
  /** 三家都回灌完 —— topModel 的第一轮要等它，否则问到的是三张空表 */
  ready: Promise<void>
  /** B 页的 topModel 要问 Codex / ZCode 那两个 collector 手上的计数 */
  codex: CodexEvents
  zcode: ZcodeEvents
  claude: ClaudeEvents
}

export function startEvents(store: Store, userData: string): EventsHandle {
  const saver = new Saver(userData)
  store.onEvents(events => saver.schedule(events))
  store.restoreEvents(load(userData))

  let booted = false
  const sink: EventSink = {
    emit(input: EventInput): void {
      store.ingestEvent(input, booted)
    },
    status(agent: AgentId, status: AgentStatus): void {
      store.setEventStatus(agent, status)
    },
    log(line: string): void {
      console.log(line)
    }
  }

  const codex = new CodexEvents(sink)
  const claude = new ClaudeEvents(sink)
  const zcode = new ZcodeEvents(sink)
  const all: EventCollector[] = [codex, claude, zcode]

  // 三家并行起。全部回灌完才翻 booted —— 任何一家还在回灌时翻，它剩下的历史就会被当新事件。
  const ready = Promise.all(all.map(c => Promise.resolve(c.start()).catch(err => {
    console.warn(`[events:${c.name}] 启动失败：${String(err)}`)
  }))).then(() => {
    booted = true
    console.log('[events] 回灌完成，之后到达的事件才算新事件')
  })

  const timer = setInterval(() => {
    for (const ev of store.sweepRunning()) {
      console.log(`[events:${ev.agent}] running 超时 2h，自动清除 "${ev.title}"`)
    }
  }, SWEEP_MS)

  return {
    stop(): void {
      clearInterval(timer)
      for (const c of all) void c.stop()
      saver.flush()
    },
    ready,
    codex,
    claude,
    zcode
  }
}

export type { AgentEvent }
