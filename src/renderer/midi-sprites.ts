/** Midi 的位图动作帧：两套形象各一张 1536×1024 图集，网格与姿态顺序相同；灯和键盘仍由主题色绘制。 */
import type { MidiSkin } from '../shared/types.js'

export type Frame = string[]
export type FrameName = 'idle' | 'typeL' | 'typeR' | 'look' | 'blink' | 'night' | 'sleep'
export type CatPose = FrameName | 'ear'
const F = (s: string): Frame => s.trim().split('\n').map(l => l.trim())

export const CAT_SIZE = 96
export const CAT_PAW_Y = 82
export const CAT_ATLAS_SIZE = { width: 1536, height: 1024 }
/** 图集文件名，都在 ./assets 下。渲染层与测试共用这一份，别再各写一遍。 */
export const CAT_ATLAS_FILE: Record<MidiSkin, string> = {
  tabby: 'midi-tabby.png',
  siamese: 'midi-siamese.png'
}
export type CatFrame = {
  /** 已检查透明边缘的 atlas 裁切矩形。 */
  source: readonly [number, number, number, number]
  /** 96×96 内的落点；所有帧的脚底对齐 y=92。 */
  target: readonly [number, number, number, number]
}
/** 虎斑：站姿源框 284×336（脚底在源框底边），缩到 76×88。 */
const upright = (x: number, y: number): CatFrame => ({
  source: [x, y, 284, 336], target: [10, 4, 76, 88]
})
/** 暹罗：轮廓更矮更宽（约 279×295），源框 284×300 缩到 84×88，脚底同样落在 y=92。 */
const uprightS = (x: number, bottom: number): CatFrame => ({
  source: [x, bottom - 300, 284, 300], target: [6, 4, 84, 88]
})

/** 每套形象的 8 个姿态。格子是 4 列 2 行 384×512，顺序 idle / typeL / typeR / look / blink / night / sleep / ear。 */
export const CAT_SKINS: Record<MidiSkin, Record<CatPose, CatFrame>> = {
  tabby: {
    idle: upright(67, 125),
    typeL: upright(429, 124),
    typeR: upright(794, 124),
    look: upright(1160, 123),
    blink: upright(67, 572),
    night: upright(429, 571),
    sleep: { source: [790, 709, 324, 200], target: [6, 40, 84, 52] },
    ear: upright(1160, 572)
  },
  siamese: {
    idle: uprightS(54, 416),
    typeL: uprightS(422, 417),
    typeR: uprightS(786, 416),
    look: uprightS(1154, 416),
    blink: uprightS(54, 896),
    night: uprightS(422, 896),
    sleep: { source: [790, 706, 312, 190], target: [2, 36, 92, 56] },
    // 右上角那两道「动耳」小标记落在 x≥1438，这个源框刚好把它们留在外面
    ear: uprightS(1154, 896)
  }
}

/** 桌上的灯，8×14 格。z = 灯杆与灯罩边（--mute），L = 灯罩里亮着的那片（--ink）。 */
export const LAMP: Frame = F(`
  ..zzzz..
  .zLLLLz.
  .zLLLLz.
  ..zzzz..
  ....z...
  ....z...
  ....z...
  ....z...
  ....z...
  ....z...
  ....z...
  ....z...
  ...zzz..
  ..zzzzz.`)

/** 键盘，20×4 格。k = 键盘本体（--hairline），K = 键帽（--canvas，比本体暗一档）。 */
export const KEYBOARD: Frame = F(`
  kkkkkkkkkkkkkkkkkkkk
  kKkKkKkKkKkKkKkKkKkk
  kkkkkkkkkkkkkkkkkkkk
  kKKKKKKKKKKKKKKKKKkk`)
