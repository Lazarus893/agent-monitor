/**
 * 「连接 ZCode」窗口的桥。暴露面只有两个方法 —— 存一枚 Key、关窗。
 * 这个窗口跑在 `sandbox: true` 下，所以这里只 require 得到 electron 的那几样，
 * 拿不到 fs、拿不到 child_process；Key 的落地一律在主进程做。
 */

import { contextBridge, ipcRenderer } from 'electron'
import { CONNECT_CH } from '../shared/connect-ipc.js'
import type { ConnectApi, ConnectResult } from '../shared/connect-ipc.js'

const api: ConnectApi = {
  save(key: string): Promise<ConnectResult> {
    return ipcRenderer.invoke(CONNECT_CH.save, key) as Promise<ConnectResult>
  },
  close(): void {
    ipcRenderer.send(CONNECT_CH.close)
  }
}

contextBridge.exposeInMainWorld('connectApi', api)
