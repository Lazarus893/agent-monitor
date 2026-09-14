/**
 * 托盘「Claude 采集」那一行字的判据（M4 §1）。
 *
 * 只读 settings.json，永远不写 —— 这几条同时是「启动时不碰用户配置」的回归保护：
 * 测试里给的都是临时文件，真实的 ~/.claude/settings.json 一次都没被打开过。
 */

import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SETTINGS_FILE, claudeStatus, statusLabel } from '../src/main/install.js'

const write = (json: unknown): string => {
  const f = join(mkdtempSync(join(tmpdir(), 'claude-')), 'settings.json')
  writeFileSync(f, typeof json === 'string' ? json : JSON.stringify(json, null, 2))
  return f
}

describe('claudeStatus', () => {
  it('默认指向 ~/.claude/settings.json', () => {
    expect(SETTINGS_FILE).toMatch(/\.claude\/settings\.json$/)
  })

  it('文件不存在 = 两个都没装（没装 Claude Code 的机器）', () => {
    expect(claudeStatus(join(tmpdir(), 'no-such-file-', String(Math.random())))).toEqual({
      statusline: false, hooks: false
    })
  })

  it('只包了 statusline', () => {
    const f = write({
      statusLine: { command: 'bash "/x/scripts/claude-statusline-tee.sh" -- /bin/sh -c "ccstatus"' }
    })
    expect(claudeStatus(f)).toEqual({ statusline: true, hooks: false })
    expect(statusLabel(claudeStatus(f))).toBe('Claude 采集：仅额度')
  })

  it('只装了 hooks', () => {
    const f = write({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'bash "/x/scripts/claude-hook.sh"' }] }] }
    })
    expect(claudeStatus(f)).toEqual({ statusline: false, hooks: true })
    expect(statusLabel(claudeStatus(f))).toBe('Claude 采集：仅事件')
  })

  it('两个都在 = 已接入', () => {
    const f = write({
      statusLine: { command: 'bash "/x/claude-statusline-tee.sh"' },
      hooks: { Stop: [{ hooks: [{ command: 'bash "/x/claude-hook.sh"' }] }] }
    })
    expect(statusLabel(claudeStatus(f))).toBe('Claude 采集：已接入')
  })

  it('用户自己的别的 hook 不会被认成我们的', () => {
    const f = write({
      hooks: { Stop: [{ hooks: [{ command: 'bash ~/bin/my-own-hook.sh' }] }] }
    })
    expect(claudeStatus(f)).toEqual({ statusline: false, hooks: false })
    expect(statusLabel(claudeStatus(f))).toBe('Claude 采集：未接入')
  })

  it('坏 JSON 也不抛 —— 它只是文本匹配，读得到就够', () => {
    const f = write('{ 这不是合法 JSON, claude-hook.sh')
    expect(() => claudeStatus(f)).not.toThrow()
    expect(claudeStatus(f).hooks).toBe(true)
  })
})
