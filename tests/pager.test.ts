import { describe, expect, it } from 'vitest'
import {
  ack, create, DEFAULT_CONFIG, interruptAttention, interruptEvent, manual,
  manualPaused, ORDER_ALL, orderFor, setAuto, setOrder, showPage, step, tick
} from '../src/renderer/pager.js'
import type { PagerConfig, PagerState } from '../src/renderer/pager.js'

const CFG: PagerConfig = DEFAULT_CONFIG
const T0 = 1_000_000

/** 把时钟推到 ms 并跑一次 tick */
const at = (s: PagerState, ms: number): PagerState => tick(s, ms, CFG)

describe('节奏默认值', () => {
  it('六页 dwell 与新事件钉住都是 60s，手动暂停 120s（tokens.css §14）', () => {
    expect(DEFAULT_CONFIG.dwellA).toBe(60_000)
    expect(DEFAULT_CONFIG.dwellB).toBe(60_000)
    expect(DEFAULT_CONFIG.dwellC).toBe(60_000)
    expect(DEFAULT_CONFIG.dwellEvent).toBe(60_000)
    expect(DEFAULT_CONFIG.manualHold).toBe(120_000)
  })
})

describe('页序（v2 六页）', () => {
  it('全序是 A → B → C1 → C2 → D → E', () => {
    expect(ORDER_ALL).toEqual(['a', 'b', 'c1', 'c2', 'd', 'e'])
  })

  it('C2 空时它不在轮播里 —— 它是 C1 的溢出页，空的就是一页空白', () => {
    expect(orderFor(false)).toEqual(['a', 'b', 'c1', 'd', 'e'])
    expect(orderFor(true)).toEqual(ORDER_ALL)
  })

  it('setOrder：列表没变就原样返回（每帧都会调，不该每帧都造新对象）', () => {
    const s = create(T0, {}, CFG)
    expect(setOrder(s, orderFor(false), T0, CFG)).toBe(s)
  })

  it('停在 C2 时它突然变空 → 落回 C1，而不是留在一页不存在的空白上', () => {
    let s = setOrder(create(T0, {}, CFG), orderFor(true), T0, CFG)
    s = manual(s, 'c2', T0, CFG)
    s = setOrder(s, orderFor(false), T0 + 1_000, CFG)
    expect(s.page).toBe('c1')
  })

  it('停在别的页时 C2 变空不动页码', () => {
    let s = setOrder(create(T0, {}, CFG), orderFor(true), T0, CFG)
    s = manual(s, 'd', T0, CFG)
    expect(setOrder(s, orderFor(false), T0 + 1_000, CFG).page).toBe('d')
  })
})

describe('定时轮播', () => {
  it('没停够就不推进', () => {
    const s = create(T0, {}, CFG)
    expect(at(s, T0 + 59_999).page).toBe('a')
  })

  it('C2 空时：A → B → C1 → D → E → A，每页停满一个 dwell', () => {
    let s = create(T0, {}, CFG)
    s = at(s, T0 + 60_000); expect(s.page).toBe('b')
    s = at(s, T0 + 119_999); expect(s.page).toBe('b')
    s = at(s, T0 + 120_000); expect(s.page).toBe('c1')
    s = at(s, T0 + 180_000); expect(s.page).toBe('d')
    s = at(s, T0 + 240_000); expect(s.page).toBe('e')
    s = at(s, T0 + 300_000); expect(s.page).toBe('a')
  })

  it('C2 非空时它排在 C1 之后', () => {
    let s = setOrder(create(T0, {}, CFG), orderFor(true), T0, CFG)
    s = at(s, T0 + 60_000); expect(s.page).toBe('b')
    s = at(s, T0 + 120_000); expect(s.page).toBe('c1')
    s = at(s, T0 + 180_000); expect(s.page).toBe('c2')
    s = at(s, T0 + 240_000); expect(s.page).toBe('d')
    s = at(s, T0 + 300_000); expect(s.page).toBe('e')
    s = at(s, T0 + 360_000); expect(s.page).toBe('a')
  })

  it('轮播关闭后不推进，重新打开从当前页重新计时而不是立刻翻页', () => {
    let s = create(T0, {}, CFG)
    s = setAuto(s, false, T0 + 10_000, CFG)
    s = at(s, T0 + 600_000)
    expect(s.page).toBe('a')
    s = setAuto(s, true, T0 + 600_000, CFG)
    expect(at(s, T0 + 659_999).page).toBe('a')
    expect(at(s, T0 + 660_000).page).toBe('b')
  })
})

describe('打断 2 · 新事件', () => {
  it('立刻跳 C1 并停满 dwellEvent（v2 把 C 拆开之后，钉住的是 C1）', () => {
    let s = create(T0, {}, CFG)
    s = interruptEvent(s, T0 + 5_000, CFG)
    expect(s.page).toBe('c1')
    expect(s.eventHold).toBe(true)
    expect(at(s, T0 + 64_999).page).toBe('c1')
    expect(at(s, T0 + 65_000).page).toBe('d')
  })

  it('期间再来一条重新计时（否则第一条只露几秒）', () => {
    let s = create(T0, {}, CFG)
    s = interruptEvent(s, T0 + 5_000, CFG)
    s = interruptEvent(s, T0 + 40_000, CFG)   // 第二条
    expect(at(s, T0 + 99_999).page).toBe('c1')
    expect(at(s, T0 + 100_000).page).toBe('d')
  })

  it('钉住到期后 eventHold 解除，C1 回到普通 dwell', () => {
    let s = create(T0, {}, CFG)
    s = interruptEvent(s, T0, CFG)
    s = at(s, T0 + 60_000)
    expect(s.page).toBe('d')
    expect(s.eventHold).toBe(false)
  })

  it('新事件盖过手动暂停：手动切到 B 之后来事件，仍跳 C1', () => {
    let s = create(T0, {}, CFG)
    s = manual(s, 'b', T0 + 1_000, CFG)
    expect(manualPaused(s, T0 + 2_000)).toBe(true)
    s = interruptEvent(s, T0 + 2_000, CFG)
    expect(s.page).toBe('c1')
    expect(manualPaused(s, T0 + 2_000)).toBe(false)
  })
})

describe('打断 1 · attention', () => {
  it('接管整屏并冻结轮播，时间再久也不翻页', () => {
    let s = create(T0, {}, CFG)
    s = interruptAttention(s, T0 + 1_000)
    expect(s.page).toBe('attn')
    expect(at(s, T0 + 10 * 60_000).page).toBe('attn')
  })

  it('解除（ack）后回 A 页并恢复轮播', () => {
    let s = create(T0, {}, CFG)
    s = interruptAttention(s, T0 + 1_000)
    s = ack(s, T0 + 30_000, CFG)
    expect(s.page).toBe('a')
    expect(s.attention).toBe(false)
    expect(at(s, T0 + 89_999).page).toBe('a')
    expect(at(s, T0 + 90_000).page).toBe('b')
  })

  it('attention 下手动切页无效 —— 这一页需要被处理', () => {
    let s = create(T0, {}, CFG)
    s = interruptAttention(s, T0)
    expect(manual(s, 'b', T0 + 1_000, CFG)).toBe(s)
    expect(step(s, 1, T0 + 1_000, CFG)).toBe(s)
    expect(step(s, -1, T0 + 1_000, CFG)).toBe(s)
  })

  it('attention 接管期间新事件只进 feed，不抢屏', () => {
    let s = create(T0, {}, CFG)
    s = interruptAttention(s, T0)
    const after = interruptEvent(s, T0 + 1_000, CFG)
    expect(after.page).toBe('attn')
    expect(after).toBe(s)
  })
})

describe('手动切换', () => {
  it('手动切页后暂停 120s，期间不自动翻页', () => {
    let s = create(T0, {}, CFG)
    s = manual(s, 'c1', T0 + 1_000, CFG)
    expect(s.page).toBe('c1')
    expect(at(s, T0 + 120_000).page).toBe('c1')   // 暂停未到期
    expect(manualPaused(s, T0 + 120_999)).toBe(true)
  })

  it('120s 无操作后从当前页继续轮播', () => {
    let s = create(T0, {}, CFG)
    s = manual(s, 'c1', T0, CFG)
    expect(manualPaused(s, T0 + 120_001)).toBe(false)
    s = at(s, T0 + 120_001)
    expect(s.page).toBe('d')                     // c1 的下一页（C2 空）
  })

  it('← / → 在轮播列表里环形走，不会走进 attn 页', () => {
    let s = create(T0, {}, CFG)           // C2 空 → a b c1 d e
    s = step(s, -1, T0, CFG); expect(s.page).toBe('e')
    s = step(s, -1, T0, CFG); expect(s.page).toBe('d')
    s = step(s, 1, T0, CFG); expect(s.page).toBe('e')
    s = step(s, 1, T0, CFG); expect(s.page).toBe('a')
  })

  it('← / → 跳过空的 C2', () => {
    let s = manual(create(T0, {}, CFG), 'c1', T0, CFG)
    expect(step(s, 1, T0, CFG).page).toBe('d')
    s = setOrder(manual(create(T0, {}, CFG), 'c1', T0, CFG), orderFor(true), T0, CFG)
    expect(step(s, 1, T0, CFG).page).toBe('c2')
  })

  it('手动切走会解除新事件的钉住（人已经自己选了要看哪页）', () => {
    let s = create(T0, {}, CFG)
    s = interruptEvent(s, T0, CFG)
    s = manual(s, 'b', T0 + 1_000, CFG)
    expect(s.eventHold).toBe(false)
  })
})

/** 截图脚本唯一的入口，之前零覆盖 —— attn→B 的滑动就是从这里漏出去的 */
describe('showPage（截图脚本用）', () => {
  it('直接定页，不触发手动暂停', () => {
    let s = create(T0, {}, CFG)
    s = showPage(s, 'c1', T0 + 1_000, CFG)
    expect(s.page).toBe('c1')
    expect(manualPaused(s, T0 + 1_000)).toBe(false)
  })

  it('清掉 eventHold：定到 C1 按 dwellC 计时，不按 dwellEvent', () => {
    let s = create(T0, {}, CFG)
    s = interruptEvent(s, T0, CFG)
    s = showPage(s, 'c1', T0 + 1_000, CFG)
    expect(s.eventHold).toBe(false)
    expect(s.dwellUntil).toBe(T0 + 1_000 + CFG.dwellC)
  })

  it('从 attn 页推进下一页是 A，不是 B', () => {
    let s = create(T0, {}, CFG)
    s = showPage(s, 'attn', T0, CFG)          // showPage 不设 attention 标志
    s = tick(s, T0 + 60_000, CFG)
    expect(s.page).toBe('a')
  })

  it('从 attn 页按 ← / → 也回到 A', () => {
    let s = showPage(create(T0, {}, CFG), 'attn', T0, CFG)
    expect(step(s, 1, T0, CFG).page).toBe('a')
    expect(step(s, -1, T0, CFG).page).toBe('a')
  })
})

describe('纯度', () => {
  it('不改入参，每次都返回新对象（或原样对象）', () => {
    const s = create(T0, {}, CFG)
    const snapshot = JSON.stringify(s)
    manual(s, 'b', T0, CFG)
    interruptEvent(s, T0, CFG)
    interruptAttention(s, T0)
    tick(s, T0 + 10 * 60_000, CFG)
    expect(JSON.stringify(s)).toBe(snapshot)
  })

  it('reduced-motion 不影响状态机：它只管页序与时间，不知道动画存在', () => {
    // 状态机没有任何 motion 入参，同一串操作在「开/关动画」两种环境下必然同解。
    // 这里把它证成一条可执行的断言：状态里不存在与动效相关的键，
    // 且同一串操作跑两遍（模拟两种环境）结果逐字相同。
    const run = (): PagerState => {
      let s = create(T0, {}, CFG)
      s = at(s, T0 + 60_000)
      s = manual(s, 'c1', T0 + 61_000, CFG)
      s = interruptEvent(s, T0 + 62_000, CFG)
      s = interruptAttention(s, T0 + 63_000)
      return ack(s, T0 + 64_000, CFG)
    }
    expect(Object.keys(create(T0, {}, CFG)).sort())
      .toEqual(['attention', 'auto', 'dwellUntil', 'eventHold', 'holdUntil', 'order', 'page'])
    expect(run()).toEqual(run())
  })
})
