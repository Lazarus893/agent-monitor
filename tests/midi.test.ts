import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { flowStep, frameFor, isNight, milestoneHop, stateText } from '../src/renderer/midi.js'
import type { FrameInput } from '../src/renderer/midi.js'
import { CAT, CAT_PAL, KEYBOARD, LAMP } from '../src/renderer/midi-sprites.js'
import type { Frame, FrameName } from '../src/renderer/midi-sprites.js'

const T0 = 1_000_000

const frame = (o: Partial<FrameInput> = {}): ReturnType<typeof frameFor> => frameFor({
  now: T0, lastInputAt: T0, paw: 0, night: false, blinkUntil: 0, status: 'ok', ...o
})

describe('帧：四态 + 夜间 + 诚实态', () => {
  it('600 ms 内是打字，左右爪跟着 paw 交替', () => {
    expect(frame({ lastInputAt: T0 - 100, paw: 1 })).toBe('typeL')
    expect(frame({ lastInputAt: T0 - 100, paw: 0 })).toBe('typeR')
    expect(frame({ lastInputAt: T0 - 599, paw: 1 })).toBe('typeL')
  })

  it('600 ms – 4 s 是 idle，4 s – 5 min 抬头看你，5 min 起睡', () => {
    expect(frame({ lastInputAt: T0 - 600 })).toBe('idle')
    expect(frame({ lastInputAt: T0 - 4_000 })).toBe('idle')
    expect(frame({ lastInputAt: T0 - 4_001 })).toBe('look')
    expect(frame({ lastInputAt: T0 - 299_999 })).toBe('look')
    expect(frame({ lastInputAt: T0 - 300_000 })).toBe('sleep')
  })

  it('夜间帧顶掉 idle 与 look，但顶不掉打字和睡', () => {
    expect(frame({ lastInputAt: T0 - 1_000, night: true })).toBe('night')
    expect(frame({ lastInputAt: T0 - 10_000, night: true })).toBe('night')
    expect(frame({ lastInputAt: T0 - 100, night: true, paw: 1 })).toBe('typeL')
    expect(frame({ lastInputAt: T0 - 300_000, night: true })).toBe('sleep')
  })

  it('眨眼是个瞬时窗口，到期就还回去', () => {
    expect(frame({ lastInputAt: T0 - 1_000, blinkUntil: T0 + 1 })).toBe('blink')
    expect(frame({ lastInputAt: T0 - 1_000, blinkUntil: T0 })).toBe('idle')
  })

  it('诚实态盖过活动态：没权限 / 没连上一律趴着，connecting 是 idle', () => {
    expect(frame({ status: 'untrusted', lastInputAt: T0 - 100 })).toBe('sleep')
    expect(frame({ status: 'offline', lastInputAt: T0 - 100 })).toBe('sleep')
    expect(frame({ status: 'connecting', lastInputAt: T0 - 300_000 })).toBe('idle')
  })

  it('这一程还没收到过脉冲：idle（夜里是 night），不是睡着了', () => {
    expect(frame({ lastInputAt: 0 })).toBe('idle')
    expect(frame({ lastInputAt: 0, night: true })).toBe('night')
  })
})

describe('心流灯', () => {
  it('每个字 +0.03，封顶 1', () => {
    expect(flowStep(0, { now: T0, lastInputAt: T0, dt: 0.016, delta: 1 })).toBeCloseTo(0.03, 6)
    expect(flowStep(0, { now: T0, lastInputAt: T0, dt: 0.016, delta: 10 })).toBeCloseTo(0.3, 6)
    expect(flowStep(0.9, { now: T0, lastInputAt: T0, dt: 0.016, delta: 10 })).toBe(1)
  })

  it('停 2 s 之内不衰减', () => {
    expect(flowStep(0.5, { now: T0 + 2_000, lastInputAt: T0, dt: 1 })).toBe(0.5)
  })

  it('停过 2 s 后每秒 −0.03，底 0.06 不灭到零', () => {
    expect(flowStep(0.5, { now: T0 + 2_001, lastInputAt: T0, dt: 1 })).toBeCloseTo(0.47, 6)
    expect(flowStep(0.07, { now: T0 + 60_000, lastInputAt: T0, dt: 1 })).toBe(0.06)
    expect(flowStep(0.06, { now: T0 + 60_000, lastInputAt: T0, dt: 10 })).toBe(0.06)
  })

  it('时钟倒退（dt 为负）时不越界：衰减那一支也钳在 1', () => {
    /* now() 的原点会在主进程换一份 generatedAt 时整段往回挪（调试栏切场景），
       那一帧的 dt 是负的 —— `- 0.03 × 负数` 是在加亮度。
       灯冲过 1，光锥透明度与影子格数就一起越界。 */
    expect(flowStep(1, { now: T0 + 10_000, lastInputAt: T0, dt: -5 })).toBe(1)
    expect(flowStep(0.9, { now: T0 + 10_000, lastInputAt: T0, dt: -100 })).toBe(1)
    // 满灯 + 一大把字：加法那一支本来就封着顶，倒退也不该把它顶出去
    expect(flowStep(1, { now: T0 + 10_000, lastInputAt: T0, dt: -1, delta: 30 })).toBe(1)
  })

  it('这一程没收到过脉冲时是 0 —— 那时屏上没有「此刻」可言', () => {
    expect(flowStep(0.5, { now: T0, lastInputAt: 0, dt: 1 })).toBe(0)
    expect(flowStep(0, { now: T0, lastInputAt: 0, dt: 1, delta: 5 })).toBe(0)
  })
})

describe('文案', () => {
  const text = (o: Partial<Parameters<typeof stateText>[0]> = {}): string =>
    stateText({ now: T0, lastInputAt: T0, night: false, status: 'ok', ...o })

  it('三种诚实态与简报 §4 一字不差', () => {
    expect(text({ status: 'connecting' })).toBe('Midi 正在醒来')
    expect(text({ status: 'untrusted' }))
      .toBe('系统设置 › 隐私与安全性 › 辅助功能 里勾上 Agent Monitor')
    expect(text({ status: 'offline' })).toBe('还没连上 Midi 的耳朵')
  })

  it('ok 且这一程还没打过字：Midi 在等你', () => {
    expect(text({ lastInputAt: 0 })).toBe('Midi 在等你')
  })

  it('活动态四句，夜里换两句', () => {
    expect(text({ lastInputAt: T0 - 100 })).toBe('Midi 在打字')
    expect(text({ lastInputAt: T0 - 1_000 })).toBe('Midi 在歇爪')
    expect(text({ lastInputAt: T0 - 10_000 })).toBe('Midi 在看你')
    expect(text({ lastInputAt: T0 - 300_000 })).toBe('Midi 睡着了')
    expect(text({ lastInputAt: T0 - 1_000, night: true })).toBe('Midi 困了')
    expect(text({ lastInputAt: T0 - 10_000, night: true })).toBe('Midi 眯着眼看你')
  })

  it('一句都不评价用户 —— 主语永远是猫或系统，不出现「你今天」这类判语', () => {
    const all = [
      text({ status: 'connecting' }), text({ status: 'offline' }), text({ lastInputAt: 0 }),
      text({ lastInputAt: T0 - 100 }), text({ lastInputAt: T0 - 300_000 })
    ]
    for (const s of all) expect(s).not.toMatch(/少|没打|加油|该|太/)
  })
})

describe('夜间与里程碑', () => {
  it('22:00–05:00 算夜里', () => {
    expect([22, 23, 0, 3, 4].map(isNight)).toEqual([true, true, true, true, true])
    expect([5, 9, 15, 21].map(isNight)).toEqual([false, false, false, false])
  })

  it('跨过 500 的倍数才跳，一次跨多个也只跳一次', () => {
    expect(milestoneHop(499, 500)).toBe(true)
    expect(milestoneHop(500, 501)).toBe(false)
    expect(milestoneHop(499, 1_200)).toBe(true)
    expect(milestoneHop(0, 0)).toBe(false)
  })

  it('慢数据把 today 往回改时不跳 —— 账本覆盖不是成就', () => {
    expect(milestoneHop(1_200, 800)).toBe(false)
  })
})

describe('像素资产', () => {
  it('七帧都在，每帧 16×14 格', () => {
    const names = ['idle', 'typeL', 'typeR', 'look', 'blink', 'night', 'sleep'] as const
    expect(Object.keys(CAT).sort()).toEqual([...names].sort())
    for (const n of names) {
      expect(CAT[n]).toHaveLength(14)
      for (const row of CAT[n]) expect(row).toHaveLength(16)
    }
  })

  it('猫只有 5 色，帧里不出现别的字符', () => {
    expect(Object.keys(CAT_PAL).sort()).toEqual(['d', 'e', 'h', 'o', 'p'])
    const used = new Set(Object.values(CAT).flat().join('').split(''))
    used.delete('.')
    expect([...used].sort()).toEqual(['d', 'e', 'h', 'o', 'p'])
  })

  it('灯 8×14、键盘 20×4，字符只用场景那四个（色值由 tokens 给）', () => {
    expect(LAMP).toHaveLength(14)
    for (const row of LAMP) expect(row).toHaveLength(8)
    expect(KEYBOARD).toHaveLength(4)
    for (const row of KEYBOARD) expect(row).toHaveLength(20)
    const used = new Set((LAMP.join('') + KEYBOARD.join('')).split(''))
    used.delete('.')
    expect([...used].sort()).toEqual(['K', 'L', 'k', 'z'])
  })
})

/**
 * 像素资产的移植是忠实的（与 tests/stage-css-port.test.ts 同一条思路）。
 *
 * design/midi-prototype.html 是这批帧唯一的设计真源 —— designer 是在像素网格上
 * 直接画的，没有 PNG 素材。midi-sprites.ts 是它的副本，而两份文件迟早会分家：
 * 原型改了一只耳朵而这边没跟，屏上就悄悄落后一版，且没有任何断言会红
 * （帧仍然 16×14、仍然只有 5 色，只是不是最新那一只猫）。
 * 这条把「副本是逐字的」变成可执行的判据。
 *
 * 只比猫的 5 色：场景那四个字符（k / K / L / z）在原型里自带一套灰，
 * 在 sprites 里**故意不给色值** —— 桌子和灯要跟着整屏的 tokens 走（见 sprites 的头注释）。
 */
const PROTOTYPE = join(process.cwd(), 'design', 'midi-prototype.html')

/** 原型里的 `F(\`…\`)` 块，按名字取。与 sprites 里的 F 同一个变换。 */
function prototypeFrames(): Record<string, Frame> {
  const html = readFileSync(PROTOTYPE, 'utf8')
  const out: Record<string, Frame> = {}
  // `idle: F(`…`)` 与 `const LAMP = F(`…`)` 两种写法都吃；名字取 : 或 = 前面那个标识符
  for (const m of html.matchAll(/(\w+)\s*[:=]\s*F\(`([^`]*)`\)/g)) {
    const [, name, body] = m
    // 同名出现两次 = 原型里有两份，「逐字相同」就没了意义
    expect(out[name!], `原型里 ${name!} 出现了不止一次`).toBeUndefined()
    out[name!] = body!.trim().split('\n').map(l => l.trim())
  }
  return out
}

/** 原型的 PAL 对象。整块取出来再逐条解析，免得撞上别处的 `x:'#hex'`。 */
function prototypePal(): Record<string, string> {
  const html = readFileSync(PROTOTYPE, 'utf8')
  const block = /const PAL\s*=\s*\{([\s\S]*?)\n\s*\};/.exec(html)
  expect(block, '原型里找不到 PAL 对象（它改名了？）').not.toBeNull()
  const out: Record<string, string> = {}
  for (const m of block![1]!.matchAll(/(\w+)\s*:\s*'(#[0-9a-fA-F]{3,8})'/g)) out[m[1]!] = m[2]!
  return out
}

describe('像素资产与原型逐字相同', () => {
  it('猫的七帧与原型一字不差', () => {
    const proto = prototypeFrames()
    const names: FrameName[] = ['idle', 'typeL', 'typeR', 'look', 'blink', 'night', 'sleep']
    for (const n of names) {
      expect(proto[n], `原型里没有 ${n} 这一帧`).toBeDefined()
      expect(CAT[n], n).toEqual(proto[n])
    }
  })

  it('灯与键盘与原型一字不差', () => {
    const proto = prototypeFrames()
    expect(LAMP).toEqual(proto['LAMP'])
    expect(KEYBOARD).toEqual(proto['KEYBOARD'])
  })

  it('猫的 5 色与原型的 PAL 一致；场景那四个字符不在这里给色值', () => {
    const pal = prototypePal()
    for (const ch of ['o', 'd', 'h', 'e', 'p']) {
      expect(CAT_PAL[ch], ch).toBe(pal[ch])
    }
    expect(Object.keys(CAT_PAL).sort()).toEqual(['d', 'e', 'h', 'o', 'p'])
    // k / K / L / z 由渲染层从 tokens 取（app.ts 的 midiPalette），不从原型搬灰度
    for (const ch of ['k', 'K', 'L', 'z']) {
      expect(pal[ch], `原型的 PAL 少了场景色 ${ch}`).toBeDefined()
      expect(CAT_PAL[ch], ch).toBeUndefined()
    }
  })
})
