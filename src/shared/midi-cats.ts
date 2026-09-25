/**
 * 两只猫的名字与轮班表。主进程（托盘文案）和渲染层（右栏文案、换班时机）共用，
 * 名字只写在这一处。
 */
import type { MidiSkin, MidiSkinPref } from './types.js'

export const MIDI_CATS: ReadonlyArray<{ id: MidiSkin; name: string; breed: string }> = [
  { id: 'tabby', name: 'Midi', breed: '虎斑' },
  { id: 'siamese', name: '咖啡', breed: '暹罗' }
]

export const catName = (skin: MidiSkin): string => MIDI_CATS.find(c => c.id === skin)!.name
export const otherCat = (skin: MidiSkin): MidiSkin => (skin === 'tabby' ? 'siamese' : 'tabby')

/** 轮班：Midi 值白班 08:00–20:00，咖啡值晚班 20:00–08:00。只看本机小时，与夜间眯眼（22–05）无关。 */
export const SHIFT = { DAY_START: 8, NIGHT_START: 20 } as const

export const shiftSkinAt = (hour: number): MidiSkin =>
  hour >= SHIFT.DAY_START && hour < SHIFT.NIGHT_START ? 'tabby' : 'siamese'

/** 下一个交班时刻（同一把钟的毫秒）：08:00 或 20:00，取最近的那个。页面上的「换班」在轮班模式下顶到这里为止。 */
export function nextShiftAt(t: number): number {
  const d = new Date(t)
  const at = (h: number): number => new Date(d.getFullYear(), d.getMonth(), d.getDate(), h).getTime()
  const h = d.getHours()
  if (h < SHIFT.DAY_START) return at(SHIFT.DAY_START)
  if (h < SHIFT.NIGHT_START) return at(SHIFT.NIGHT_START)
  return at(SHIFT.DAY_START + 24)
}

/** 偏好 → 此刻该谁当班。 */
export const resolveSkin = (pref: MidiSkinPref, hour: number): MidiSkin =>
  pref === 'shift' ? shiftSkinAt(hour) : pref
