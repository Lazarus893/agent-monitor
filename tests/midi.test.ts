import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { flowStep, frameFor, HANDOVER, HANDOVER_MS, handoverFrame, isNight, milestoneHop, stateText } from '../src/renderer/midi.js'
import { catName, nextShiftAt, otherCat, resolveSkin, shiftSkinAt } from '../src/shared/midi-cats.js'
import type { FrameInput } from '../src/renderer/midi.js'
import { CAT_ATLAS_FILE, CAT_ATLAS_SIZE, CAT_SIZE, CAT_PAW_Y, CAT_SKINS, KEYBOARD, LAMP } from '../src/renderer/midi-sprites.js'
import type { MidiSkin } from '../src/shared/types.js'

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
    expect(frame({ lastInputAt: 0, blinkUntil: T0 + 200 })).toBe('blink')
    expect(frame({ lastInputAt: 0, blinkUntil: T0, night: true })).toBe('night')
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
    stateText({ now: T0, lastInputAt: T0, night: false, status: 'ok', name: 'Midi', ...o })

  it('文案里的名字跟当班的猫走', () => {
    expect(text({ name: '咖啡', lastInputAt: 0 })).toBe('咖啡 在等你')
    expect(text({ name: '咖啡', status: 'offline' })).toBe('还没连上 咖啡 的耳朵')
    expect(text({ name: catName('siamese'), lastInputAt: T0 - 300_000 })).toBe('咖啡 睡着了')
    expect(text({ name: catName('tabby'), lastInputAt: T0 - 300_000 })).toBe('Midi 睡着了')
  })

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

describe('轮班', () => {
  it('Midi 白班 08–20，咖啡其余时间；指定一只时不看钟', () => {
    expect(shiftSkinAt(8)).toBe('tabby'); expect(shiftSkinAt(19)).toBe('tabby')
    expect(shiftSkinAt(20)).toBe('siamese'); expect(shiftSkinAt(7)).toBe('siamese'); expect(shiftSkinAt(0)).toBe('siamese')
    expect(resolveSkin('shift', 12)).toBe('tabby'); expect(resolveSkin('shift', 23)).toBe('siamese')
    expect(resolveSkin('siamese', 12)).toBe('siamese'); expect(resolveSkin('tabby', 23)).toBe('tabby')
  })

  it('下一个交班点：08:00 / 20:00 取最近的；「换班」按钮在轮班模式下顶到这里为止', () => {
    const at = (h: number, m = 0): number => new Date(2026, 8, 16, h, m).getTime()
    expect(nextShiftAt(at(3))).toBe(at(8))
    expect(nextShiftAt(at(8))).toBe(at(20))
    expect(nextShiftAt(at(19, 59))).toBe(at(20))
    expect(nextShiftAt(at(20))).toBe(new Date(2026, 8, 17, 8).getTime())
    expect(otherCat('tabby')).toBe('siamese'); expect(otherCat('siamese')).toBe('tabby')
  })

  it('换班编排：先抬头，再走出去，接班的从左边走进来，坐定动耳朵，到点收尾', () => {
    const { LOOK_MS, WALK_MS, OVERLAP_MS, HOME_X, ENTER_X, SCENE_W, GRID } = HANDOVER
    expect(handoverFrame(0)).toEqual({ out: { pose: 'look', x: HOME_X, bob: 0 }, in: null, done: false })
    const mid = handoverFrame(LOOK_MS + WALK_MS / 2)
    expect(mid.out!.x).toBeGreaterThan(HOME_X); expect(mid.out!.x % GRID).toBe(0)
    expect(['typeL', 'typeR']).toContain(mid.out!.pose)
    expect(mid.in).toBeNull()
    // 接班的比前一段早 OVERLAP_MS 起步，从画面左侧外面进来
    const enter = handoverFrame(LOOK_MS + WALK_MS - OVERLAP_MS)
    expect(enter.in).toEqual({ pose: 'typeR', x: ENTER_X, bob: 0 })
    // 出去的那只走到画面外就不画了
    const gone = handoverFrame(LOOK_MS + WALK_MS - 1)
    expect(gone.out === null || gone.out.x >= SCENE_W - GRID).toBe(true)
    // 坐定：回到猫框原位，动耳朵
    const settle = handoverFrame(HANDOVER_MS - 1)
    expect(settle.in).toEqual({ pose: 'ear', x: HOME_X, bob: 0 }); expect(settle.done).toBe(false)
    expect(handoverFrame(HANDOVER_MS)).toEqual({ out: null, in: { pose: 'idle', x: HOME_X, bob: 0 }, done: true })
  })

  it('走位全程落在 4px 网格上，起伏只有 0 / −2', () => {
    for (let t = 0; t < HANDOVER_MS; t += 16) {
      const f = handoverFrame(t)
      for (const w of [f.out, f.in]) if (w) { expect(Math.abs(w.x % HANDOVER.GRID)).toBe(0); expect([0, -2]).toContain(w.bob) }
    }
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

const SKINS = Object.keys(CAT_SKINS) as MidiSkin[]

describe('两套动作图', () => {
  it('两套形象各有一张图集文件，姿态集合相同', () => {
    expect(SKINS).toEqual(['tabby', 'siamese'])
    expect(Object.keys(CAT_ATLAS_FILE)).toEqual(SKINS)
    for (const skin of SKINS) expect(Object.keys(CAT_SKINS[skin])).toEqual(Object.keys(CAT_SKINS.tabby))
  })
  it.each(SKINS)('%s：图集尺寸与源矩形一致，裁切不会读到相邻动作', skin => {
    const png = readFileSync(join(process.cwd(), 'src/renderer/assets', CAT_ATLAS_FILE[skin]))
    expect(png.subarray(1, 4).toString()).toBe('PNG')
    expect(png.readUInt32BE(16)).toBe(CAT_ATLAS_SIZE.width)
    expect(png.readUInt32BE(20)).toBe(CAT_ATLAS_SIZE.height)
    expect(png[25]).toBe(6) // RGBA，避免黑底/品红底被打包
    for (const { source: [x, y, w, h] } of Object.values(CAT_SKINS[skin])) {
      expect(w).toBeGreaterThan(0); expect(h).toBeGreaterThan(0)
      expect(x + w).toBeLessThanOrEqual(CAT_ATLAS_SIZE.width)
      expect(y + h).toBeLessThanOrEqual(CAT_ATLAS_SIZE.height)
      expect(Math.floor(x / 384)).toBe(Math.floor((x + w - 1) / 384))
      expect(Math.floor(y / 512)).toBe(Math.floor((y + h - 1) / 512))
    }
  })
  it.each(SKINS)('%s：七个状态都有帧；站姿、睡姿脚底固定，小跳不会超出场景', skin => {
    const CAT = CAT_SKINS[skin]
    for (const name of ['idle', 'typeL', 'typeR', 'look', 'blink', 'night', 'sleep'] as const) {
      const [x, y, w, h] = CAT[name].target
      expect(x).toBeGreaterThanOrEqual(0); expect(y).toBeGreaterThanOrEqual(0)
      expect(x + w).toBeLessThanOrEqual(CAT_SIZE)
      expect(y + h).toBe(92)
      expect(8 + y - 8).toBeGreaterThanOrEqual(0)
      expect(8 + y + h).toBeLessThanOrEqual(128)
    }
    expect(CAT_PAW_Y).toBeLessThan(92)
    expect(CAT.typeL.source).not.toEqual(CAT.typeR.source)
  })
  it('灯与键盘仍使用主题的四个字符', () => {
    expect(LAMP).toHaveLength(14)
    for (const row of LAMP) expect(row).toHaveLength(8)
    expect(KEYBOARD).toHaveLength(4)
    for (const row of KEYBOARD) expect(row).toHaveLength(20)
    const used = new Set((LAMP.join('') + KEYBOARD.join('')).split(''))
    used.delete('.')
    expect([...used].sort()).toEqual(['K', 'L', 'k', 'z'])
  })
})
