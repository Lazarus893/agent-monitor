/** IPC 频道名。preload 是唯一的桥，渲染层拿不到 ipcRenderer 本身。 */
export const CH = {
  /** main → renderer：整份 MonitorState（M1 数据量小，不做 diff） */
  state: 'monitor:state',
  /** main → renderer：一次性指令（全局快捷键、截图定页） */
  command: 'monitor:command',
  /** renderer → main */
  ack: 'monitor:ack',
  setPage: 'monitor:set-page',
  rendered: 'monitor:rendered',
  dev: 'monitor:dev'
} as const

/* 「连接 ZCode」窗口的两条频道不在这里 —— 见 shared/connect-ipc.ts 文件头，
   两个沙箱 preload 不能共享任何模块，否则 rollup 会抽出 chunks/。 */

export type DevMessage =
  | { type: 'setState'; name: string }
  | { type: 'forceError'; agent: string; code: string | null }
  | { type: 'simulateEvent' }
  | { type: 'simulateAttention' }
  | { type: 'clearAttention' }
