import { CAT_ATLAS_FILE, CAT_PAW_Y, CAT_SIZE, CAT_SKINS } from './midi-sprites.js'
import type { CatPose } from './midi-sprites.js'
import type { MidiSkin } from '../shared/types.js'

type FrameCache = Map<CatPose, HTMLCanvasElement>

export type CatPainter = {
  (ctx: CanvasRenderingContext2D, skin: MidiSkin, pose: CatPose, x: number, y: number, pawsOnly?: boolean): void
  /** 触发某套形象的解码；幂等，每套只解码一次。换班动画开始前给接班的那套调一次。 */
  load(skin: MidiSkin): void
  ready(skin: MidiSkin): boolean
}

/**
 * 每套形象解码一次、每个姿态栅格化一次；动画只复制 96×96 缓存，不反复缩放大图。
 * 两套可以同时在缓存里 —— 换班那 2.5 秒里两只猫都在屏上。
 */
export function createCatPainter(onLoad: (skin: MidiSkin, ok: boolean) => void): CatPainter {
  const cache = new Map<MidiSkin, FrameCache>()
  const pending = new Set<MidiSkin>()

  const decode = async (skin: MidiSkin): Promise<void> => {
    const image = new Image()
    image.src = new URL(`./assets/${CAT_ATLAS_FILE[skin]}`, import.meta.url).href
    try {
      await image.decode()
    } catch (error) {
      console.error(`[Midi] 小猫动作图加载失败（${skin}）`, error)
      pending.delete(skin)
      onLoad(skin, false)
      return
    }
    const built: FrameCache = new Map()
    for (const [pose, { source: s, target: d }] of Object.entries(CAT_SKINS[skin]) as [CatPose, typeof CAT_SKINS[MidiSkin][CatPose]][]) {
      const frame = document.createElement('canvas')
      frame.width = frame.height = CAT_SIZE
      const ctx = frame.getContext('2d')!
      ctx.imageSmoothingEnabled = false
      ctx.drawImage(image, s[0], s[1], s[2], s[3], d[0], d[1], d[2], d[3])
      built.set(pose, frame)
    }
    cache.set(skin, built)
    pending.delete(skin)
    onLoad(skin, true)
  }

  const paint = ((ctx, skin, pose, x, y, pawsOnly = false) => {
    const frame = cache.get(skin)?.get(pose)
    if (!frame) return
    ctx.imageSmoothingEnabled = false
    if (pawsOnly) {
      // 前爪压在键帽上；其余身体和尾巴保持在键盘后。
      ctx.drawImage(frame, 0, CAT_PAW_Y, CAT_SIZE, CAT_SIZE - CAT_PAW_Y,
        x, y + CAT_PAW_Y, CAT_SIZE, CAT_SIZE - CAT_PAW_Y)
    } else ctx.drawImage(frame, x, y)
  }) as CatPainter

  paint.load = skin => {
    if (cache.has(skin) || pending.has(skin)) return
    pending.add(skin)
    void decode(skin)
  }
  paint.ready = skin => cache.has(skin)
  return paint
}
