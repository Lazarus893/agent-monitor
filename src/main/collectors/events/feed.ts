/**
 * 事件流本身 —— 去重、按会话收束、排序、未读判定、running 超时清除。
 *
 * 为什么单独一层：三家 collector 各自只会说「我这儿发生了一件事」，
 * 而「这条是不是新的」「这条要不要顶掉上一条」「屏上按什么顺序排」这三件事的判据
 * 必须只有一份。散到三家里去，就会出现 Codex 的去重规则和 ZCode 的不一样。
 *
 * 三条规则：
 *   1. **同 id 去重**：同一条事件被重复读到（文件重扫、轮询重叠）只留一条。
 *   2. **同 session 收束**：一个会话在列表里只占一行（design/brief-m0-v2.md §1
 *      的「session 列表」）。新的一条覆盖旧的，updatedAt 往前走。
 *   3. **running 置顶，其余按 updatedAt 倒序**。
 *
 * 未读：只有「启动之后新到」的才 acked=false。回灌与重启恢复的一律 acked=true ——
 * 简报「统一行为」第 4 条与验收第 4 条（重启后历史事件不重复报警）。
 */

import type { AgentEvent, AgentId, AgentStatus } from '../../../shared/types.js'
import type { EventInput } from './types.js'
import { MAX_EVENTS, RUNNING_TIMEOUT_MS } from './types.js'

const ms = (iso: string | undefined): number => {
  const n = iso ? Date.parse(iso) : NaN
  return Number.isNaN(n) ? 0 : n
}

/** running 在最前；其余按 updatedAt（没有就用 at）倒序 */
export function sortFeed(events: AgentEvent[]): AgentEvent[] {
  return [...events].sort((a, b) => {
    const ar = a.kind === 'running' ? 1 : 0
    const br = b.kind === 'running' ? 1 : 0
    if (ar !== br) return br - ar
    return ms(b.updatedAt ?? b.at) - ms(a.updatedAt ?? a.at)
  })
}

export class Feed {
  private events: AgentEvent[] = []
  /** 已经见过的 id —— 去重用，比扫数组便宜，也不会被裁剪掉的旧事件放回来 */
  private ids = new Set<string>()

  /** 恢复：从持久化文件回灌，全部标已读 */
  restore(events: AgentEvent[]): void {
    this.events = sortFeed(events.map(e => ({ ...e, acked: true }))).slice(0, MAX_EVENTS)
    this.ids = new Set(this.events.map(e => e.id))
  }

  list(): AgentEvent[] {
    return this.events
  }

  /**
   * 收一条。`isNew` 决定它算不算未读。
   * 返回真正进了列表的那条（被去重挡掉时返回 null）。
   */
  ingest(input: EventInput, isNew: boolean): AgentEvent | null {
    if (this.ids.has(input.id)) return null
    this.ids.add(input.id)

    /* running 行不计未读：它不是「做完了一件事」，而是「正在做」。
       其余一律按 isNew —— **attention 也不例外**（复核 P2-2.7 指出注释写反了）：
       重启之后回灌回来的 attention 不该重新报一次警，那件事可能早就处理完了。
       「此刻有没有人在等你」由 statusFor 看**未读的** attention 决定，不由这里决定。 */
    const acked = input.kind === 'running' ? true : !isNew
    const ev: AgentEvent = { ...input, acked }

    // 同会话收束。running → completed 时，旧的 running 行被换掉而不是并排显示。
    const rest = input.sessionId
      ? this.events.filter(e => e.sessionId !== input.sessionId)
      : this.events

    this.events = sortFeed([ev, ...rest]).slice(0, MAX_EVENTS)
    return ev
  }

  ack(id: string): boolean {
    let hit = false
    this.events = this.events.map(e => {
      if (e.id !== id || e.acked) return e
      hit = true
      return { ...e, acked: true }
    })
    return hit
  }

  /** attention 被解除（ack 或来了新的用户消息）：把该会话的 attention 行标已读 */
  clearAttention(agent?: AgentId): boolean {
    let hit = false
    this.events = this.events.map(e => {
      if (e.kind !== 'attention' || e.acked) return e
      if (agent && e.agent !== agent) return e
      hit = true
      return { ...e, acked: true }
    })
    return hit
  }

  /**
   * running 超时清除（简报「统一行为」第 3 条）。
   * 一条 running 挂了两小时还没收尾，多半是 agent 被 kill 了 / hook 没发出来。
   * 留着它会让 per-agent status 永远是 running、C 页第一行永远是同一条。
   */
  sweepRunning(now: number, timeoutMs = RUNNING_TIMEOUT_MS): AgentEvent[] {
    const dropped: AgentEvent[] = []
    this.events = this.events.filter(e => {
      if (e.kind !== 'running') return true
      const start = ms(e.startedAt ?? e.updatedAt ?? e.at)
      if (now - start < timeoutMs) return true
      dropped.push(e)
      return false
    })
    return dropped
  }

  /**
   * per-agent 状态（简报「统一行为」第 3 条）：
   * 有任一会话在等 → attention；有任一在跑 → running；否则 idle。
   * offline 不在这里算 —— 那是「事件源本身连不上」，由 collector 直接报。
   *
   * **ack ≠ 已批准**（M3 复核 §2.8 提出、M4 定下来，保持现状不改）。
   * 这里的判据是「有没有**未读的** attention」，所以用户在面板上按一下 Enter
   * 标记已读之后，身份点立刻从 attention 掉回 idle/running，而 Claude 那边
   * 可能还在等批准。语义上确实不等价。
   *
   * 之所以不改：面板是**只读**的，它没有、也不该有批准按钮（简报：副屏上没有按钮）。
   * 真正的批准发生在 Claude Code 那一侧，而我们只在 hook 的 Notification 事件里
   * 听到「我在等你」，听不到「他批完了」—— 没有解除信号，就没有正确的自动落回时机。
   * 于是 ack 在这里的含义只能是用户自己说的那句「我看见了，别再冲我闪」。
   * 把它改成「一直 attention 到下一条事件为止」会更准，但代价是面板在用户
   * 已经处理完之后仍然整屏接管，而唯一的解除方式变成「等下一个事件」——
   * 对一块常驻副屏来说，那比现在这个不精确更难受。
   * 要真解决，需要的是一个「批准已完成」的上游信号，不是这一行的判据。
   */
  statusFor(agent: AgentId): Exclude<AgentStatus, 'offline'> {
    let running = false
    for (const e of this.events) {
      if (e.agent !== agent) continue
      if (e.kind === 'attention' && !e.acked) return 'attention'
      if (e.kind === 'running') running = true
    }
    return running ? 'running' : 'idle'
  }

  unread(): number {
    return this.events.filter(e => !e.acked).length
  }
}
