/**
 * 唯一的桥。contextIsolation: true、nodeIntegration: false，
 * 渲染层只能拿到下面这几个方法，拿不到 ipcRenderer、拿不到 require。
 */

import { contextBridge, ipcRenderer } from 'electron'
import { CH } from '../shared/ipc.js'
import type {
  AgentId, MonitorApi, MonitorCommand, MonitorState, NoticeCode, Page, SceneName
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
  ack(id: string) {
    ipcRenderer.send(CH.ack, id)
  },
  setPage(page: Page) {
    ipcRenderer.send(CH.setPage, page)
  },
  rendered(token: number) {
    ipcRenderer.send(CH.rendered, token)
  },
  dev: {
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
    }
  }
}

contextBridge.exposeInMainWorld('monitor', api)
