import { describe, expect, it, vi } from 'vitest'
import { Store } from '../src/main/state.js'
import type { MonitorState } from '../src/shared/types.js'

describe('Store.subscribe', () => {
  /**
   * 复核 P0 的回归：主进程曾经在 mw.load() 之前就把唯一一次首帧 send 出去，
   * 落在 about:blank 上被丢弃，面板全黑。修法是「渲染层就绪后再推」，
   * 前提是 subscribe 必须立刻回放当前整份 state —— 这条把那个前提钉住。
   */
  it('订阅时同步回放一次当前整份 state，含三个 agent 与画布尺寸', () => {
    const store = new Store()
    const seen: MonitorState[] = []
    store.subscribe(s => seen.push(s))

    expect(seen).toHaveLength(1)
    const first = seen[0]!
    expect(first.agents.map(a => a.id)).toEqual(['codex', 'claude', 'zcode'])
    expect(first.agents.every(a => a.windows.length > 0)).toBe(true)
    expect(first.events.length).toBeGreaterThan(0)
    expect(first.canvas).toEqual({ width: 480, height: 270 })
    expect(first.scene).toBe('populated')
  })

  it('晚一步订阅也拿得到同一份 state —— 重载之后补推靠的就是这个', () => {
    const store = new Store()
    store.setScene('error')
    const late: MonitorState[] = []
    store.subscribe(s => late.push(s))
    expect(late[0]!.scene).toBe('error')
    expect(late[0]!.feedNotice).toEqual({ tone: 'error', code: 'feed_error' })
  })

  it('unsubscribe 之后不再收到推送', () => {
    const store = new Store()
    const fn = vi.fn()
    const off = store.subscribe(fn)
    off()
    store.setScene('empty')
    expect(fn).toHaveBeenCalledTimes(1) // 只有订阅时那一次回放
  })
})

describe('Store 的画布与事件', () => {
  it('setCanvas 只在尺寸真的变了才推 —— 但首帧不再依赖它', () => {
    const store = new Store()
    const fn = vi.fn()
    store.subscribe(fn)
    store.setCanvas({ width: 480, height: 270 }) // 与初值相同
    expect(fn).toHaveBeenCalledTimes(1)
    store.setCanvas({ width: 480, height: 320 }) // 原生 3:2 模式
    expect(fn).toHaveBeenCalledTimes(2)
    expect(store.get().canvas).toEqual({ width: 480, height: 320 })
  })

  it('切场景保留当前画布尺寸', () => {
    const store = new Store()
    store.setCanvas({ width: 480, height: 320 })
    store.setScene('running')
    expect(store.get().canvas).toEqual({ width: 480, height: 320 })
  })

  it('ack 把那一条标成已读，attention 随之解除', () => {
    const store = new Store()
    store.setScene('attention')
    expect(store.hasAttention()).toBe(true)
    const attn = store.get().events.find(e => e.kind === 'attention')!
    store.ack(attn.id)
    expect(store.hasAttention()).toBe(false)
    expect(store.get().events.find(e => e.id === attn.id)!.acked).toBe(true)
  })

  it('模拟新事件排到 feed 顶部且未读', () => {
    const store = new Store()
    const before = store.get().events.length
    const ev = store.simulateEvent()
    const after = store.get()
    expect(after.events).toHaveLength(before + 1)
    expect(after.events[0]!.id).toBe(ev.id)
    expect(after.events[0]!.acked).toBe(false)
  })

  it('七个场景都能生成，且都带满三个 agent', () => {
    const store = new Store()
    for (const scene of ['populated', 'loading', 'empty', 'error', 'edge', 'attention', 'running'] as const) {
      store.setScene(scene)
      const s = store.get()
      expect(s.scene).toBe(scene)
      expect(s.agents).toHaveLength(3)
    }
  })
})
