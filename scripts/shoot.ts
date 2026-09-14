/**
 * 截图：四页 × 七态 = 28 张到 design/shots/m1/。
 *
 * 由主进程在 MONITOR_SHOOT=1 时调用（`pnpm shoot`）——capturePage 只有主进程能调，
 * 单独起一个 node 脚本反而要再造一条 IPC 通道。这里做的是「驱动」：
 * 换场景 → 定页 → 等渲染层回报画完 → capturePage → 落盘。
 *
 * 时序上有两道保险，因为第一版没有它们，28 张里有 4 张是过渡帧甚至空白帧
 * （page-attention-attention 拍成了 C 页）：
 *   1. rendered 回报带自增 token，只认自己那一声 —— 无身份的裸信号会让上一轮迟到的回报
 *      提前解锁下一轮，此后一路错位传染；
 *   2. 拍完回读 dataset.page / dataset.state 与文件名对账，拍错了脚本自己报，
 *      不靠事后算 md5。
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { ipcMain } from 'electron'
import { CH } from '../src/shared/ipc.js'
import { SCENE_NAMES } from '../src/shared/types.js'
import type { Page, SceneName } from '../src/shared/types.js'
import type { Store } from '../src/main/state.js'

const PAGES: Array<{ page: Page; slug: string }> = [
  { page: 'a', slug: 'a' },
  { page: 'b', slug: 'b' },
  { page: 'c', slug: 'c' },
  { page: 'attn', slug: 'attention' }
]

/** --dur-page 是 300ms；再留 150ms 给字体与 FLIP 收敛 */
const SETTLE_MS = 450

/** 等渲染层回报**这一轮**画完。迟到的别轮回报会被忽略，超时要出声不要静默。 */
function waitRendered(token: number, timeout = 3000): Promise<boolean> {
  return new Promise(resolve => {
    const onRendered = (_e: unknown, got: number): void => {
      if (got !== token) return // 上一轮的迟到回报，丢掉
      cleanup()
      resolve(true)
    }
    const timer = setTimeout(() => {
      cleanup()
      console.warn(`[shoot] WARN token ${token} 等渲染回报超时，这一张可能是过渡帧`)
      resolve(false)
    }, timeout)
    const cleanup = (): void => {
      clearTimeout(timer)
      ipcMain.off(CH.rendered, onRendered)
    }
    ipcMain.on(CH.rendered, onRendered)
  })
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

export async function runShoot(win: BrowserWindow, store: Store, outDir: string): Promise<boolean> {
  await mkdir(outDir, { recursive: true })
  let token = 0
  let n = 0
  const wrong: string[] = []

  for (const scene of SCENE_NAMES as SceneName[]) {
    for (const { page, slug } of PAGES) {
      token++
      const settled = waitRendered(token)
      store.setScene(scene)
      win.webContents.send(CH.command, { type: 'showPage', page, token })
      await settled
      await sleep(SETTLE_MS)

      // 拍之前先对账：页面与场景必须就是文件名说的那个
      const actual = await (win.webContents.executeJavaScript(
        '({page: document.documentElement.dataset.page, state: document.documentElement.dataset.state})'
      ) as Promise<{ page: string; state: string }>)

      const img = await win.webContents.capturePage()
      const { width, height } = img.getSize()
      const file = join(outDir, `page-${slug}-${scene}.png`)
      await writeFile(file, img.toPNG())
      n++

      const ok = actual.page === page && actual.state === scene
      if (!ok) wrong.push(`${slug}-${scene}（实际 ${actual.page}/${actual.state}）`)
      const cv = store.get().canvas
      console.log(
        `[shoot] ${ok ? 'OK  ' : 'BAD '} ${file} ${width}x${height} (canvas ${cv.width}x${cv.height})`
      )
    }
  }

  if (wrong.length) {
    console.error(`[shoot] ${wrong.length} 张页面/状态对不上：${wrong.join('、')}`)
    return false
  }
  console.log(`[shoot] ${n} 张写入 ${outDir}，页面与状态逐张对账通过`)
  return true
}
