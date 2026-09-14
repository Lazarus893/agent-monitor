/**
 * 「连接 ZCode」窗口的脚本。它只做三件事：收一串文本、交给主进程、报结果。
 * Key 不进任何变量以外的地方 —— 不 localStorage、不 URL、不 console。
 */

// tokens.css 是唯一的颜色真源，这里 import 的是那份本体而不是副本
import '../../design/tokens.css'
import './connect.css'
import type { ConnectApi } from '../shared/connect-ipc.js'

declare global {
  interface Window { connectApi: ConnectApi }
}

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id)
  if (!el) throw new Error(`缺少元素 #${id}`)
  return el as T
}

const input = $<HTMLInputElement>('key')
const msg = $<HTMLParagraphElement>('msg')
const save = $<HTMLButtonElement>('save')
const cancel = $<HTMLButtonElement>('cancel')

function say(text: string, tone: 'ok' | 'error' | '' = ''): void {
  msg.textContent = text
  if (tone) msg.dataset['tone'] = tone
  else delete msg.dataset['tone']
}

let busy = false

async function submit(): Promise<void> {
  if (busy) return
  const key = input.value
  if (!key.trim()) {
    say('请先粘贴 Key', 'error')
    input.focus()
    return
  }
  busy = true
  save.disabled = cancel.disabled = true
  // 首次写钥匙串时 macOS 会弹授权框，那期间这里就停在「保存中…」
  say('保存中…')
  try {
    const res = await window.connectApi.save(key)
    if (res.ok) {
      say('已保存，面板会在下一轮采集后显示额度', 'ok')
      // 把输入框里的 Key 立刻清掉，窗口关之前它不该还留在 DOM 里
      input.value = ''
      setTimeout(() => window.connectApi.close(), 900)
      return
    }
    say(res.message ?? '保存失败', 'error')
  } catch {
    say('保存失败，请重试', 'error')
  }
  busy = false
  save.disabled = cancel.disabled = false
  input.focus()
}

save.addEventListener('click', () => { void submit() })
cancel.addEventListener('click', () => window.connectApi.close())
input.addEventListener('input', () => { if (msg.dataset['tone'] === 'error') say('') })
input.addEventListener('keydown', ev => {
  if (ev.key === 'Enter') { ev.preventDefault(); void submit() }
})
// Esc 关窗放在 document 上就够了 —— 输入框里的按键会冒泡上来
document.addEventListener('keydown', ev => {
  if (ev.key === 'Escape') window.connectApi.close()
})

input.focus()
