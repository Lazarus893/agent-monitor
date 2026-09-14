/**
 * vite 在构建期把 `import.meta.env.DEV` 静态替换成 `true` / `false`。
 * 这里只声明 preload 用到的那一个字段 —— 引 `vite/client` 会把 DOM 的一整套
 * 模块声明也拖进 tsconfig.node 的编译单元，而主进程里没有 DOM。
 */
interface ImportMetaEnv {
  readonly DEV: boolean
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
