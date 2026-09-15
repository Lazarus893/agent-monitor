/**
 * 随包走的静态资源在哪儿。
 *
 * dev 下 `app.getAppPath()` 就是仓库根，`build/` 与 `scripts/` 原地就在；
 * 打包后它们经 electron-builder 的 `extraResources` 落到 `Contents/Resources/`，
 * **不进 asar** —— 安装脚本要被 `node` 与 `bash` 当成真实文件读，
 * asar 里的路径它们打不开。
 */

import { app } from 'electron'
import { join } from 'node:path'

/** 托盘模板图 / app 图标所在目录 */
export function assetDir(): string {
  return app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'build')
}

/** 两个安装脚本与两个 shell 脚本所在目录 */
export function scriptDir(): string {
  return app.isPackaged ? join(process.resourcesPath, 'scripts') : join(app.getAppPath(), 'scripts')
}

/**
 * F 页心跳层的 AX 监听子进程。
 * dev 下是 `scripts/build-ax-pulse.sh` 编出来的 `build/ax-pulse`（pnpm predev 会保证它在）；
 * 打包后经 extraResources 落到 `Contents/Resources/ax-pulse`。
 */
export function helperPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'ax-pulse')
    : join(app.getAppPath(), 'build', 'ax-pulse')
}
