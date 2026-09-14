/**
 * 两个 preload 的产物形态（M4）。
 *
 * 这几条钉的是一个**实测踩过的坑**：`sandbox: true` 的 preload 没有模块解析，
 * 一旦 rollup 因为两个入口共享模块而抽出 `chunks/ipc-*.cjs`，加载直接失败：
 *
 *     Unable to load preload script: out/preload/index.cjs
 *     Error: module not found: ./chunks/ipc-CdzEW7TD.cjs
 *
 * 而**面板只是白屏**，主进程日志里只有一行 renderer error —— 不盯着就会打包发出去。
 * 解法是源码结构上的（面板的频道在 shared/ipc.ts，连接窗口的在 shared/connect-ipc.ts，
 * 两个入口不共享任何模块），所以这里同时盯产物与源码两侧。
 */

import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const OUT = join(ROOT, 'out', 'preload')
const built = existsSync(OUT)

describe('preload 产物', () => {
  it.runIf(built)('没有 chunks/ —— 沙箱 preload 必须是单文件', () => {
    expect(readdirSync(OUT).filter(f => f === 'chunks')).toEqual([])
    for (const f of readdirSync(OUT)) {
      const text = readFileSync(join(OUT, f), 'utf8')
      expect(text).not.toMatch(/require\(["']\.\//)
    }
  })

  it.runIf(built)('两个入口都在，且都是 .cjs（ESM preload 开不了 sandbox）', () => {
    const files = readdirSync(OUT).sort()
    expect(files).toEqual(['connect.cjs', 'index.cjs'])
  })

  it.runIf(built)('产物里只 require electron，没有别的 Node 模块', () => {
    for (const f of readdirSync(OUT)) {
      const text = readFileSync(join(OUT, f), 'utf8')
      const mods = [...text.matchAll(/require\(["']([^"']+)["']\)/g)].map(m => m[1])
      expect([...new Set(mods)]).toEqual(['electron'])
    }
  })

  it('dev 通道由构建期常量守着 —— pnpm build 的产物里整段被摇掉', () => {
    /* 断言写在**源码**上而不是产物上：`electron-vite dev`（pnpm dev / selftest / shoot）
       也往 out/ 写 preload，那一份是 DEV 构建、本来就该带着 dev 通道。
       对着 out/ 断言「不含 simulateAttention」会随最后一次跑的是 build 还是 dev 翻红翻绿。

       实测（pnpm build 之后）：out/preload/index.cjs 里 `simulateAttention` 0 次。
       注意必须是「条件挂上」而不是「先建好再 delete」—— 后者虽然也不暴露，
       但五个方法的代码仍原样留在产物里。 */
    const src = readFileSync(join(ROOT, 'src/preload/index.ts'), 'utf8')
    expect(src).toMatch(/if \(import\.meta\.env\.DEV\)\s*\{\s*api\.dev\s*=/)
    expect(src).not.toMatch(/delete .*\.dev/)
  })
})

describe('源码结构：两个 preload 入口不共享模块', () => {
  const imports = (file: string): string[] =>
    [...readFileSync(join(ROOT, file), 'utf8').matchAll(/from ['"](\.[^'"]+)['"]/g)]
      .map(m => m[1]!)
      // 纯类型 import 会被擦掉，不会进产物，所以只看值导入
      .filter(spec => !/^import type/.test(spec))

  it('面板 preload 引 shared/ipc，连接窗口 preload 引 shared/connect-ipc', () => {
    expect(imports('src/preload/index.ts')).toContain('../shared/ipc.js')
    expect(imports('src/preload/connect.ts')).toContain('../shared/connect-ipc.js')
  })

  it('两边的相对 import 没有交集', () => {
    const a = new Set(imports('src/preload/index.ts'))
    const b = new Set(imports('src/preload/connect.ts'))
    expect([...a].filter(x => b.has(x))).toEqual([])
  })

  it('连接窗口的两条频道名与主进程用的是同一份常量', async () => {
    const { CONNECT_CH } = await import('../src/shared/connect-ipc.js')
    expect(CONNECT_CH.save).toBe('monitor:connect-save')
    expect(CONNECT_CH.close).toBe('monitor:connect-close')
    // shared/ipc.ts 里不该再留一份（留着就是两个入口又共享模块了）
    const ipc = readFileSync(join(ROOT, 'src/shared/ipc.ts'), 'utf8')
    expect(ipc).not.toContain('monitor:connect-')
  })
})
