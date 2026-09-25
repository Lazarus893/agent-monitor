/**
 * 托盘菜单的内容与顺序（简报 §1「菜单项，按此顺序」）。
 *
 * 菜单是这个 app **唯一**的设置入口 —— 副屏上没有任何按钮。所以「有哪几项、
 * 什么顺序、勾选状态对不对、什么时候该灰掉」全是可执行的验收点，而不是看一眼的事。
 *
 * `trayTemplate` 是纯函数，不碰 Electron API，也不需要真的建一个 Tray。
 */

import { describe, expect, it } from 'vitest'
import { trayTemplate } from '../src/main/tray.js'
import type { TrayActions, TrayState } from '../src/main/tray.js'
import { DEFAULT_PREFS } from '../src/main/config.js'

const actions = (): TrayActions & { calls: string[] } => {
  const calls: string[] = []
  return {
    calls,
    setMuted: v => calls.push(`muted:${v}`),
    setAlwaysOnTop: v => calls.push(`top:${v}`),
    setOpenAtLogin: v => calls.push(`login:${v}`),
    setTypingFollow: v => calls.push(`follow:${v}`),
    setMidiSkin: v => calls.push(`skin:${v}`),
    home: () => calls.push('home'),
    connect: () => calls.push('connect'),
    install: t => calls.push(`install:${t}`),
    calibrate: () => calls.push('calibrate'),
    resetPanelX: () => calls.push('reset'),
    openLogs: () => calls.push('logs'),
    quit: () => calls.push('quit')
  }
}

const state = (over: Partial<TrayState> = {}): TrayState => ({
  version: '0.1.0',
  display: 'TYPE-C',
  prefs: DEFAULT_PREFS,
  claude: { statusline: false, hooks: false },
  hasKey: false,
  canInstall: true,
  busy: false,
  ...over
})

const labels = (s = state()): string[] =>
  trayTemplate(s, actions()).map(i => (i.type === 'separator' ? '—' : String(i.label)))

describe('菜单顺序', () => {
  it('与简报 §1 逐项一致', () => {
    expect(labels()).toEqual([
      'Agent Monitor 0.1.0 · 运行中（TYPE-C）',
      '—',
      '静音提示音',
      '总在最前',
      '登录时启动',
      '打字时切到 Midi',
      'Midi 形象',
      '回到总览页',
      '—',
      '连接 ZCode…',
      'Claude 采集：未接入',
      '校准横向比例…',
      '重置横向比例',
      '—',
      '打开日志文件夹',
      '退出'
    ])
  })

  it('首行是禁用的，显示版本与当前显示器', () => {
    const first = trayTemplate(state(), actions())[0]!
    expect(first.enabled).toBe(false)
    expect(first.label).toContain('0.1.0')
    expect(first.label).toContain('TYPE-C')
  })

  it('副屏不在时首行说的是回落位置', () => {
    expect(labels(state({ display: '主屏窗口' }))[0]).toContain('主屏窗口')
  })
})

describe('四个勾选项', () => {
  const boxes = (s: TrayState) =>
    trayTemplate(s, actions()).filter(i => i.type === 'checkbox')

  it('默认：不静音、不置顶、登录自启开、打字时切到 Midi 开', () => {
    expect(boxes(state()).map(i => [i.label, i.checked])).toEqual([
      ['静音提示音', false], ['总在最前', false], ['登录时启动', true], ['打字时切到 Midi', true]
    ])
  })

  it('勾选状态跟着 prefs 走', () => {
    const s = state({ prefs: { ...DEFAULT_PREFS, muted: true, alwaysOnTop: true, openAtLogin: false, typingFollow: false } })
    expect(boxes(s).map(i => i.checked)).toEqual([true, true, false, false])
  })

  it('点一下把新的勾选状态交出去', () => {
    const a = actions()
    const items = trayTemplate(state(), a).filter(i => i.type === 'checkbox')
    for (const it of items) it.click?.({ checked: true } as never, undefined as never, undefined as never)
    expect(a.calls).toEqual(['muted:true', 'top:true', 'login:true', 'follow:true'])
  })
})

describe('ZCode 与 Claude 采集', () => {
  it('没有 Key 是「连接」，有 Key 是「更换」', () => {
    expect(labels(state({ hasKey: false }))).toContain('连接 ZCode…')
    expect(labels(state({ hasKey: true }))).toContain('更换 ZCode Key…')
  })

  it('采集那一行随装没装变文案', () => {
    const label = (c: TrayState['claude']): string =>
      String(trayTemplate(state({ claude: c }), actions())[10]!.label)
    expect(label({ statusline: false, hooks: false })).toBe('Claude 采集：未接入')
    expect(label({ statusline: true, hooks: false })).toBe('Claude 采集：仅额度')
    expect(label({ statusline: false, hooks: true })).toBe('Claude 采集：仅事件')
    expect(label({ statusline: true, hooks: true })).toBe('Claude 采集：已接入')
  })

  it('子菜单三项：装过的显示「重装」，一个都没装时「全部卸载」灰掉', () => {
    const sub = (c: TrayState['claude']) =>
      trayTemplate(state({ claude: c }), actions())[10]!.submenu as Electron.MenuItemConstructorOptions[]
    const none = sub({ statusline: false, hooks: false })
    expect(none.map(i => (i.type === 'separator' ? '—' : String(i.label))))
      .toEqual(['安装 statusline 采集', '安装 hooks', '—', '全部卸载'])
    // 一个都没装的时候「全部卸载」没有意义
    expect(none[3]!.enabled).toBe(false)

    const both = sub({ statusline: true, hooks: true })
    expect(both[0]!.label).toBe('重装 statusline 采集')
    expect(both[1]!.label).toBe('重装 hooks')
    expect(both[3]!.enabled).toBe(true)
  })

  it('脚本没随包出来 / 正在装 → 三项都灰掉，点不动', () => {
    for (const over of [{ canInstall: false }, { busy: true }]) {
      const sub = trayTemplate(state({ claude: { statusline: true, hooks: true }, ...over }), actions())[10]!
        .submenu as Electron.MenuItemConstructorOptions[]
      expect(sub.filter(i => i.type !== 'separator').map(i => i.enabled)).toEqual([false, false, false])
    }
  })

  it('三项各自触发对应的任务', () => {
    const a = actions()
    const sub = trayTemplate(state({ claude: { statusline: true, hooks: true } }), a)[10]!
      .submenu as Electron.MenuItemConstructorOptions[]
    for (const it of sub) it.click?.({} as never, undefined as never, undefined as never)
    expect(a.calls).toEqual(['install:statusline', 'install:hooks', 'install:uninstall-all'])
  })
})

describe('Midi 形象', () => {
  const sub = (s: TrayState, a = actions()) =>
    trayTemplate(s, a).find(i => i.label === 'Midi 形象')!.submenu as Electron.MenuItemConstructorOptions[]

  it('两只猫加轮班，互斥单选，默认轮班', () => {
    expect(sub(state()).map(i => [i.label, i.type, i.checked])).toEqual([
      ['Midi · 虎斑', 'radio', false], ['咖啡 · 暹罗', 'radio', false], ['轮班 · Midi 8–20 点，咖啡 其余时间', 'radio', true]
    ])
  })

  it('勾选跟着 prefs.midiSkin 走', () => {
    expect(sub(state({ prefs: { ...DEFAULT_PREFS, midiSkin: 'tabby' } })).map(i => i.checked)).toEqual([true, false, false])
    expect(sub(state({ prefs: { ...DEFAULT_PREFS, midiSkin: 'siamese' } })).map(i => i.checked)).toEqual([false, true, false])
  })

  it('点一项把形象 id 交出去', () => {
    const a = actions()
    const items = sub(state(), a)
    items[0]!.click?.({} as never, undefined as never, undefined as never)
    items[2]!.click?.({} as never, undefined as never, undefined as never)
    expect(a.calls).toEqual(['skin:tabby', 'skin:shift'])
  })
})

describe('其余几项都接到了东西上', () => {
  it('每个非分隔、非禁用项都有 click', () => {
    const items = trayTemplate(state(), actions())
      .filter(i => i.type !== 'separator' && i.enabled !== false)
    expect(items.every(i => typeof i.click === 'function' || i.submenu)).toBe(true)
  })

  it('回到总览 / 校准 / 重置 / 日志 / 退出 各自调对了', () => {
    const a = actions()
    const items = trayTemplate(state(), a)
    const byLabel = (l: string) => items.find(i => i.label === l)!
    for (const l of ['回到总览页', '校准横向比例…', '重置横向比例', '打开日志文件夹', '退出']) {
      byLabel(l).click?.({} as never, undefined as never, undefined as never)
    }
    expect(a.calls).toEqual(['home', 'calibrate', 'reset', 'logs', 'quit'])
  })

  it('菜单里没有 emoji（简报：不用 emoji 当图标）', () => {
    const all = trayTemplate(state(), actions()).flatMap(i => [
      String(i.label ?? ''),
      ...((i.submenu as Electron.MenuItemConstructorOptions[] | undefined) ?? []).map(x => String(x.label ?? ''))
    ])
    expect(all.join('')).not.toMatch(/\p{Extended_Pictographic}/u)
  })
})

describe('不做的事', () => {
  it('菜单里没有「通知」这一类入口（决策 3：只在副屏高亮，不发系统通知）', () => {
    expect(labels().join(' ')).not.toMatch(/通知/)
  })
})
