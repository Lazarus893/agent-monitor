/**
 * 唯一的桥。contextIsolation: true、nodeIntegration: false，
 * 渲染层只能拿到下面这几个方法，拿不到 ipcRenderer、拿不到 require。
 */

import { contextBridge, ipcRenderer } from 'electron'
import { CH } from '../shared/ipc.js'
import type {
  AgentId, MonitorApi, MonitorCommand, MonitorState, NoticeCode, Page, SceneName, TypingPulse
} from '../shared/types.js'

const api: MonitorApi = {
  subscribe(cb) {
    const fn = (_e: unknown, state: MonitorState): void => cb(state)
    ipcRenderer.on(CH.state, fn)
    return () => { ipcRenderer.off(CH.state, fn) }
  },
  onCommand(cb) {
    const fn = (_e: unknown, cmd: MonitorCommand): void => cb(cmd)
    ipcRenderer.on(CH.command, fn)
    return () => { ipcRenderer.off(CH.command, fn) }
  },
  onPulse(cb) {
    const fn = (_e: unknown, pulse: TypingPulse): void => cb(pulse)
    ipcRenderer.on(CH.pulse, fn)
    return () => { ipcRenderer.off(CH.pulse, fn) }
  },
  ack(id: string) {
    ipcRenderer.send(CH.ack, id)
  },
  setPage(page: Page) {
    ipcRenderer.send(CH.setPage, page)
  },
  rendered(token: number) {
    ipcRenderer.send(CH.rendered, token)
  },
  openNews(id: string) {
    // 只递一个 id。链接在主进程那边取与校验（shared/types.ts 的 NewsItem 注释说明了理由）
    ipcRenderer.send(CH.openNews, id)
  }
}

/* dev 子对象只在 dev 构建里**挂上去**（M1 复核 §2 的 P2）。
   主进程侧本来就按 `app.isPackaged` 不注册那条频道，所以产物里调用它只是空转；
   但暴露面越小越诚实 —— 打出来的包里不该有「模拟 attention」这种方法。

   为什么是「条件挂上」而不是「先建好再 delete」：后者虽然也不会暴露出去，
   但五个方法的代码仍然原样躺在产物里（实测 out/preload/index.cjs 里
   `simulateAttention` 这个名字还在）。写成条件赋值，rollup 才能把整段摇掉。

   判据用构建期的 `import.meta.env.DEV`（vite 静态替换成字面量）而不是运行时的
   `process.env`：这个 preload 跑在 `sandbox: true` 下，那里的 `process` 是个精简 shim，
   `env` 不保证在。 */
if (import.meta.env.DEV) {
  api.dev = {
    setState(name: SceneName | 'live') {
      ipcRenderer.send(CH.dev, { type: 'setState', name })
    },
    forceError(agent: AgentId, code: NoticeCode | null) {
      ipcRenderer.send(CH.dev, { type: 'forceError', agent, code })
    },
    simulateEvent() {
      ipcRenderer.send(CH.dev, { type: 'simulateEvent' })
    },
    simulateAttention() {
      ipcRenderer.send(CH.dev, { type: 'simulateAttention' })
    },
    clearAttention() {
      ipcRenderer.send(CH.dev, { type: 'clearAttention' })
    },
    simulateTyping(chars: number) {
      ipcRenderer.send(CH.dev, { type: 'simulateTyping', chars })
    }
  }
}

contextBridge.exposeInMainWorld('monitor', api)
