import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'

const projectRoot = __dirname

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: { index: resolve(projectRoot, 'src/main/index.ts') }
      }
    }
  },
  preload: {
    build: {
      rollupOptions: {
        input: {
          index: resolve(projectRoot, 'src/preload/index.ts'),
          // M4 ·「连接 ZCode」窗口自己的桥，只暴露 save / close
          connect: resolve(projectRoot, 'src/preload/connect.ts')
        },
        /* CJS + `.cjs` 后缀是为了**打开 `sandbox: true`**（M1 复核 §9.5-1）。
           package.json 是 `"type": "module"`，electron-vite 默认把 preload 产成 ESM
           `.mjs`，而 ESM preload 要求 `sandbox: false` —— 于是 preload 一直跑在
           一个有完整 Node 的渲染进程里。产成 CJS 就没有这条限制了；
           两个 preload 都只用到 `ipcRenderer` / `contextBridge`，沙箱里都拿得到。 */
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs',
          /* **沙箱 preload 必须是单文件。** 只要两个 preload 入口引同一个模块，
             rollup 就会把它抽成 `chunks/ipc-*.cjs`，而沙箱里的 preload 没有模块解析，
             加载时直接报 `module not found: ./chunks/ipc-….cjs`，`window.monitor`
             整个不存在（2026-09-14 实测）。
             解法不在这儿而在源码结构上：面板的频道在 `shared/ipc.ts`，连接窗口的在
             `shared/connect-ipc.ts`，两个入口没有共享模块。
             `tests/preload-bundle.test.ts` 盯着产物里不出现 chunks/。 */
          chunkFileNames: 'chunks/[name]-[hash].cjs'
        }
      }
    }
  },
  renderer: {
    root: resolve(projectRoot, 'src/renderer'),
    server: {
      // 渲染层直接 import ../../design/tokens.css —— 它在 root 之外，dev server 要放行。
      // 简报给的两条路里选「直接 import」而不是「构建期复制 + 断言逐字相同」：
      // 少一份副本就少一处会漂移的真源。
      fs: { allow: [projectRoot] }
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve(projectRoot, 'src/renderer/index.html'),
          connect: resolve(projectRoot, 'src/renderer/connect.html')
        }
      }
    }
  }
})
