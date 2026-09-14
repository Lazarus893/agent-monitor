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
        input: { index: resolve(projectRoot, 'src/preload/index.ts') }
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
        input: { index: resolve(projectRoot, 'src/renderer/index.html') }
      }
    }
  }
})
