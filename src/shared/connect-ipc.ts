/**
 * 「连接 ZCode」窗口的 IPC 契约。
 *
 * 为什么单独一个文件、而不是并进 `shared/ipc.ts`：
 * 两个 preload 都跑在 `sandbox: true` 下，而**沙箱里的 preload 必须是单文件**——
 * 它没有模块解析，`require('./chunks/…')` 直接失败。只要两个 preload 入口
 * 引同一个模块，rollup 就会把它抽成 `out/preload/chunks/ipc-*.cjs`，
 * 于是 `window.monitor` 整个不存在（2026-09-14 实测：面板白屏 + preload 加载失败）。
 *
 * 所以面板的频道留在 `shared/ipc.ts`（只有面板 preload 引），
 * 连接窗口的频道在这里（只有连接窗口 preload 引）。两个入口不共享任何模块，
 * 产物里就不会有 chunks/。`tests/preload-bundle.test.ts` 盯着这一条。
 */

export const CONNECT_CH = {
  /** renderer → main（invoke）：存一枚 Key，返回 ConnectResult */
  save: 'monitor:connect-save',
  /** renderer → main：关窗 */
  close: 'monitor:connect-close'
} as const

/** 连接窗口的返回值：失败时带一句给用户看的话，永远不含 Key 本身。 */
export type ConnectResult = { ok: boolean; message?: string }

/** 连接窗口 preload 暴露的全部能力 —— 两个方法，没有别的。 */
export type ConnectApi = {
  save(key: string): Promise<ConnectResult>
  close(): void
}
