/**
 * 托盘「Claude 采集」那一项背后的两件事：**看现在装没装**、**调既有的安装脚本**。
 *
 * 纪律（简报「不要做」）：本文件不会自己去改 `~/.claude/settings.json`，
 * 一行都不写 —— 它只在用户点了托盘菜单时 spawn `scripts/install-claude-*.mjs`，
 * 那两个脚本自带备份、幂等与精确卸载。启动时只读不写。
 *
 * 为什么用 `process.execPath` + `ELECTRON_RUN_AS_NODE` 而不是 `node`：
 * 从 Finder / 登录项启动的 GUI app 拿到的 PATH 只有 `/usr/bin:/bin:/usr/sbin:/sbin`，
 * homebrew 的 node 不在里面。Electron 自己就是一个 Node，借它跑最稳。
 */

import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import { scriptDir } from './resources.js'

export const SETTINGS_FILE = join(homedir(), '.claude', 'settings.json')

/** 两个脚本各自在 settings.json 里留下的锚 */
const HOOK_MARK = 'claude-hook.sh'
const TEE_MARK = 'claude-statusline-tee.sh'

export type ClaudeStatus = {
  /** statusline tee 已包上 */
  statusline: boolean
  /** 四个 hook 已装 */
  hooks: boolean
}

/**
 * 只读地判断当前状态。判据是「settings.json 的文本里有没有那个脚本名」——
 * 比脚本自己的逐字匹配宽，但这里只是给菜单显示一行字，宽一点不会误删任何东西。
 * 读不到文件（没装过 Claude Code）一律算未接入。
 */
export function claudeStatus(file = SETTINGS_FILE): ClaudeStatus {
  let text = ''
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return { statusline: false, hooks: false }
  }
  return { statusline: text.includes(TEE_MARK), hooks: text.includes(HOOK_MARK) }
}

/** 菜单上那行字：两个都装了才叫「已接入」，装了一半说清是哪一半 */
export function statusLabel(s: ClaudeStatus): string {
  if (s.statusline && s.hooks) return 'Claude 采集：已接入'
  if (s.statusline) return 'Claude 采集：仅额度'
  if (s.hooks) return 'Claude 采集：仅事件'
  return 'Claude 采集：未接入'
}

export type InstallTask = 'statusline' | 'hooks' | 'uninstall-all'

const SCRIPTS: Record<'statusline' | 'hooks', string> = {
  statusline: 'install-claude-statusline.mjs',
  hooks: 'install-claude-hooks.mjs'
}

function run(script: string, args: string[]): Promise<{ ok: boolean; output: string }> {
  const file = join(scriptDir(), script)
  return new Promise(resolve => {
    execFile(
      process.execPath,
      [file, ...args],
      {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        timeout: 20_000,
        maxBuffer: 1 << 20
      },
      (err, stdout, stderr) => {
        const output = `${stdout ?? ''}${stderr ?? ''}`.trim()
        resolve({ ok: !err, output: output || (err ? String(err) : '') })
      }
    )
  })
}

/**
 * 跑一件事。返回给托盘用来闪一条提示的短句 + 成败。
 * 卸载是两个脚本各跑一次 `--uninstall`，任何一个失败都算失败。
 */
export async function runInstall(task: InstallTask): Promise<{ ok: boolean; message: string }> {
  if (task === 'uninstall-all') {
    const a = await run(SCRIPTS.statusline, ['--uninstall'])
    const b = await run(SCRIPTS.hooks, ['--uninstall'])
    const ok = a.ok && b.ok
    console.log(`[install] 全部卸载 ${ok ? 'ok' : '失败'}\n${a.output}\n${b.output}`.trim())
    return { ok, message: ok ? '已卸载 Claude 采集' : '卸载失败，详见日志' }
  }
  const r = await run(SCRIPTS[task], [])
  const what = task === 'statusline' ? 'statusline 采集' : 'hooks'
  console.log(`[install] 安装 ${what} ${r.ok ? 'ok' : '失败'}\n${r.output}`.trim())
  return { ok: r.ok, message: r.ok ? `已安装 ${what}` : `安装 ${what} 失败，详见日志` }
}

/** 打包后跑安装脚本前的一道自检：脚本确实随包出来了吗 */
export function scriptsAvailable(): boolean {
  try {
    for (const s of Object.values(SCRIPTS)) readFileSync(join(scriptDir(), s), 'utf8')
    return true
  } catch {
    console.warn(`[install] 找不到安装脚本（${scriptDir()}），isPackaged=${app.isPackaged}`)
    return false
  }
}
