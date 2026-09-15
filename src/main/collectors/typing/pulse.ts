/**
 * 把子进程吐出的**带符号字数增量**折成「像打字的字数」。
 *
 * 为什么不能直接把增量加进账本：中文用户的每一个字都会先以拼音的形态出现。
 * 敲 `wo xiang xie`（12 个字母，AX 逐个报 +1）再上屏成「我想写」，
 * AX 报的是一次 **−9**。那 9 个不是被删掉的字，是那 12 下敲击的另一种写法 ——
 * 一笔一笔都已经记过账了，所以要扣回去；但**只能扣到这一波为止**。
 * 不封底的话，「我」之前攒了一整天的字会被一次上屏扣掉一截。
 *
 * 退格（−1）一律忽略：删一个字不是「没打过这个字」。
 * 别的负值（切窗口、清空输入框、程序改写）也忽略 —— 它们不是这一波敲出来的。
 */

import type { TypingPulse } from '../../../shared/types.js'

/** 一次最多认多少字。再多就是粘贴 / 自动补全 / 整段替换（子进程那边也拦了一道） */
export const MAX_DELTA = 30
/** 「这一波」有多长：正增量与随后的拼音上屏之间允许隔多久 */
export const IME_WINDOW_MS = 3_000

export type Folded = {
  /** 有值就立刻推给渲染层（爪子要在 100 ms 内动）。拼音回落不产生脉冲。 */
  pulse?: TypingPulse
  /**
   * 账本要记的每一笔，**各自带着那一笔是哪一刻挣到的**。空数组 = 这一条不记账。
   *
   * 不能只给一个总数：账本按本地日期分格，而拼音上屏必然晚于敲键。
   * 23:59:59 敲下的十个字母在 00:00:01 上屏，那一笔 −7 属于**昨天**那一格 ——
   * 按消息时刻记的话，昨天凭空多七个字、今天凭空欠七个字，两天都错，
   * 而且是那种只在跨零点那一秒发生、第二天谁也复现不出来的错。
   */
  entries: Array<{ at: number; n: number }>
}

export class PulseFolder {
  /** 最近 IME_WINDOW_MS 内的正增量，拼音回落的扣减上限就是它们的和 */
  private recent: Array<{ at: number; n: number }> = []

  fold(now: number, d: number): Folded {
    this.prune(now)
    if (!Number.isFinite(d) || !Number.isInteger(d) || d === 0) return { entries: [] }
    if (Math.abs(d) > MAX_DELTA) return { entries: [] }

    if (d > 0) {
      this.recent.push({ at: now, n: d })
      return { pulse: { at: now, delta: d }, entries: [{ at: now, n: d }] }
    }
    // 退格：人删了一个字，不代表他没打过
    if (d === -1) return { entries: [] }
    // 这一波已经过去了（或者根本没有过正增量）—— 这个负数与打字无关
    if (!this.recent.length) return { entries: [] }

    const earned = this.recent.reduce((s, r) => s + r.n, 0)
    return { entries: this.consume(Math.min(-d, earned)) }
  }

  private prune(now: number): void {
    this.recent = this.recent.filter(r => now - r.at <= IME_WINDOW_MS)
  }

  /**
   * 从最近的一笔开始扣：上屏替换掉的就是刚敲的那几个字母。
   * 返回逐笔的扣减（n 为负），每笔带着**当初挣到它的那个时刻** ——
   * 账本要按那个时刻落格，不是按这次上屏的时刻。
   */
  private consume(n: number): Array<{ at: number; n: number }> {
    const out: Array<{ at: number; n: number }> = []
    let left = n
    while (left > 0 && this.recent.length) {
      const last = this.recent[this.recent.length - 1]!
      const take = Math.min(last.n, left)
      out.push({ at: last.at, n: -take })
      left -= take
      last.n -= take
      if (last.n === 0) this.recent.pop()
    }
    return out
  }
}
