import { describe, expect, it, vi } from 'vitest'
import { Store } from '../src/main/state.js'
import type { MonitorState, QuotaWindow } from '../src/shared/types.js'

describe('Store.subscribe', () => {
  /**
   * 复核 P0 的回归：主进程曾经在 mw.load() 之前就把唯一一次首帧 send 出去，
   * 落在 about:blank 上被丢弃，面板全黑。修法是「渲染层就绪后再推」，
   * 前提是 subscribe 必须立刻回放当前整份 state —— 这条把那个前提钉住。
   */
  it('订阅时同步回放一次当前整份 state，含三个 agent 与画布尺寸', () => {
    // 显式要 fixtures 那一路：M2 起 new Store() 的默认是 live（真实采集，首帧没有数字）
    const store = new Store('populated')
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

describe('Store · live 模式（M2 真实采集）', () => {
  const win = (usedPercent: number): QuotaWindow[] =>
    [{ label: '5h', usedPercent, resetsAt: '2026-09-14T20:00:00+08:00' }]

  it('默认就是 live：骨架屏起步，三块都还没有窗口，事件仍是 M1 的 fixtures', () => {
    const s = new Store().get()
    expect(s.loading).toBe(true)
    expect(s.agents.map(a => a.windows.length)).toEqual([0, 0, 0])
    expect(s.agents.every(a => a.notice === undefined)).toBe(true) // 交给渲染层画「等待首轮采样」
    expect(s.events.length).toBeGreaterThan(0)
  })

  it('第一轮落地就退出骨架屏，数字与 plan 都进状态', () => {
    const store = new Store()
    store.applyQuota('codex', { ok: true, windows: win(22), plan: 'plus', sampledAt: '2026-09-14T10:00:00Z' })
    const s = store.get()
    expect(s.loading).toBe(false)
    const codex = s.agents.find(a => a.id === 'codex')!
    expect(codex.windows).toEqual(win(22))
    expect(codex.plan).toBe('plus')
    expect(codex.updatedAt).toBe('2026-09-14T10:00:00Z')
    expect(codex.stale).toBeUndefined()
  })

  it('采集失败但上一轮有数字：数字留着标 stale，updatedAt 停在旧时刻', () => {
    const store = new Store()
    store.applyQuota('zcode', { ok: true, windows: win(61), sampledAt: '2026-09-14T10:00:00Z' })
    store.applyQuota('zcode', { ok: false, code: 'network' })
    const zcode = store.get().agents.find(a => a.id === 'zcode')!
    expect(zcode.windows).toEqual(win(61))
    expect(zcode.stale).toBe(true)
    expect(zcode.status).toBe('offline')
    expect(zcode.notice).toEqual({ tone: 'error', code: 'network' })
    expect(zcode.updatedAt).toBe('2026-09-14T10:00:00Z')
  })

  it('失败结果自带旧窗口（Claude 的旧文件）时，updatedAt 用文件的写入时刻', () => {
    const store = new Store()
    store.applyQuota('claude', {
      ok: false, code: 'rate_limited', windows: win(18), sampledAt: '2026-09-14T09:30:00Z'
    })
    const claude = store.get().agents.find(a => a.id === 'claude')!
    expect(claude.stale).toBe(true)
    expect(claude.updatedAt).toBe('2026-09-14T09:30:00Z')
  })

  it('一个数字都没采到过就失败 → 不标 stale，走空/错态', () => {
    const store = new Store()
    store.applyQuota('zcode', { ok: false, code: 'missing_key' })
    const zcode = store.get().agents.find(a => a.id === 'zcode')!
    expect(zcode.stale).toBeUndefined()
    expect(zcode.windows).toEqual([])
    expect(zcode.notice).toEqual({ tone: 'empty', code: 'missing_key' })
    expect(zcode.status).toBe('offline') // 未连接：身份点熄掉
  })

  it('Key 被删（missing_key）时旧数字要清掉 —— 屏上挂着过期数字是在骗人', () => {
    const store = new Store()
    store.applyQuota('zcode', { ok: true, windows: win(61) })
    store.applyQuota('zcode', { ok: false, code: 'missing_key' })
    const zcode = store.get().agents.find(a => a.id === 'zcode')!
    expect(zcode.windows).toEqual([])
    expect(zcode.stale).toBeUndefined()
    expect(zcode.notice).toEqual({ tone: 'empty', code: 'missing_key' })
  })

  it('codexbar 不在（missing_tool）同理：清数字，走空态', () => {
    const store = new Store()
    store.applyQuota('codex', { ok: true, windows: win(22) })
    store.applyQuota('codex', { ok: false, code: 'missing_tool' })
    const codex = store.get().agents.find(a => a.id === 'codex')!
    expect(codex.windows).toEqual([])
    expect(codex.notice).toEqual({ tone: 'empty', code: 'missing_tool' })
  })

  it('身份点的判据是「屏上还有没有数字」：没有就 offline，有 stale 数字的空态仍然亮', () => {
    const store = new Store()
    store.applyQuota('codex', { ok: false, code: 'missing_tool' })
    expect(store.get().agents.find(a => a.id === 'codex')!.status).toBe('offline')

    store.applyQuota('claude', { ok: true, windows: win(18) })
    store.applyQuota('claude', { ok: false, code: 'no_statusline', windows: win(18) })
    const claude = store.get().agents.find(a => a.id === 'claude')!
    expect(claude.stale).toBe(true)
    expect(claude.status).toBe('idle')
  })

  it('setLive 把调试栏切走的场景切回真实采集', () => {
    const store = new Store()
    store.applyQuota('codex', { ok: true, windows: win(22) })
    store.setScene('error')
    store.applyQuota('codex', { ok: true, windows: win(24) })   // scene 模式下只记不推
    expect(store.get().agents.find(a => a.id === 'codex')!.windows).toEqual([])
    store.setLive()
    const s = store.get()
    expect(s.scene).toBe('populated')
    expect(s.loading).toBe(false)
    expect(s.agents.find(a => a.id === 'codex')!.windows).toEqual(win(24))
  })

  it('恢复之后 stale 与 notice 一起消失', () => {
    const store = new Store()
    store.applyQuota('codex', { ok: true, windows: win(22) })
    store.applyQuota('codex', { ok: false, code: 'network' })
    store.applyQuota('codex', { ok: true, windows: win(24) })
    const codex = store.get().agents.find(a => a.id === 'codex')!
    expect(codex.stale).toBeUndefined()
    expect(codex.notice).toBeUndefined()
    expect(codex.status).toBe('idle')
    expect(codex.windows).toEqual(win(24))
  })

  it('dev 切到场景之后，真实采集只记不推 —— 免得把正在看的那一帧顶掉', () => {
    const store = new Store()
    const fn = vi.fn()
    store.subscribe(fn)
    store.setScene('edge')
    const calls = fn.mock.calls.length
    store.applyQuota('codex', { ok: true, windows: win(22) })
    expect(fn).toHaveBeenCalledTimes(calls)
    expect(store.get().scene).toBe('edge')
  })
})
