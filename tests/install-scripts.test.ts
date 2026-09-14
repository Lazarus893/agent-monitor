/**
 * 两个安装脚本对 `~/.claude/settings.json` 的写法（M4 复核 P1-①）。
 *
 * 这是本项目唯一会碰用户全局配置的地方。`writeFileSync` 对已存在的文件是
 * `open(..., 'w')` —— 先截断再写；中间被打断（`install.ts` 的 20 s 超时会发 SIGTERM）
 * 就留下一个 0 字节或半截的 settings.json，用户的 Claude Code 整个起不来。
 *
 * 用例分两层：
 *   · 行为层：真的跑一遍脚本，看备份、结果、残留；
 *   · 源码层：把「tmp + rename」「备份先打印再写」「import 时不执行」这三条钉死。
 *     这一层不优雅，但它守的是一个**没法在测试里复现的时刻**（正好被 SIGTERM 打断），
 *     只能对着写法断言。
 */

import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = process.cwd()
const SCRIPTS = {
  hooks: join(ROOT, 'scripts', 'install-claude-hooks.mjs'),
  statusline: join(ROOT, 'scripts', 'install-claude-statusline.mjs')
}

/** 一份带用户自有内容的 settings.json，跑完要确认它们一个字都没少 */
const SEED = {
  statusLine: { type: 'command', command: 'bash ~/.claude/my-statusline.sh' },
  hooks: { Stop: [{ hooks: [{ type: 'command', command: 'bash ~/bin/my-own-hook.sh' }] }] },
  我的设置: '别动我'
}

function bed(): string {
  const dir = mkdtempSync(join(tmpdir(), 'claude-set-'))
  const file = join(dir, 'settings.json')
  writeFileSync(file, JSON.stringify(SEED, null, 2) + '\n')
  return file
}

const run = (script: string, file: string, ...args: string[]): string =>
  execFileSync(process.execPath, [script, '--settings', file, ...args], { encoding: 'utf8' })

describe('行为：装 → 卸一个来回', () => {
  for (const [name, script] of Object.entries(SCRIPTS)) {
    it(`${name}：装完留下备份、结果是合法 JSON、用户自己的内容还在`, () => {
      const file = bed()
      const dir = join(file, '..')
      const out = run(script, file)
      expect(out).toContain('备份：')

      const after = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
      expect(after['我的设置']).toBe('别动我')
      // 备份是动手之前那一份
      const backups = readdirSync(dir).filter(f => f.includes('.bak-'))
      expect(backups).toHaveLength(1)
      expect(JSON.parse(readFileSync(join(dir, backups[0]!), 'utf8'))).toEqual(SEED)
      // 没有留下 .tmp-<pid>
      expect(readdirSync(dir).filter(f => f.includes('.tmp-'))).toEqual([])
    })

    it(`${name}：卸载把用户原有的那条原样还回去`, () => {
      const file = bed()
      run(script, file)
      run(script, file, '--uninstall')
      const back = JSON.parse(readFileSync(file, 'utf8')) as typeof SEED
      expect(back.statusLine.command).toBe(SEED.statusLine.command)
      expect(back.hooks).toEqual(SEED.hooks)
      expect(back['我的设置']).toBe('别动我')
      expect(readdirSync(join(file, '..')).filter(f => f.includes('.tmp-'))).toEqual([])
    })
  }
})

describe('写法：原子写 + 先报备份 + import 不执行', () => {
  for (const [name, script] of Object.entries(SCRIPTS)) {
    const src = (): string => readFileSync(script, 'utf8')

    it(`${name}：走 tmp + renameSync，不直接 writeFileSync 到 settings`, () => {
      const s = src()
      expect(s).toMatch(/function writeAtomic\(/)
      expect(s).toMatch(/renameSync\(tmp, file\)/)
      // 直接往目标文件 writeFileSync 就是那条会截断的路，一处都不该有
      expect(s).not.toMatch(/writeFileSync\(\s*settingsPath/)
      // 失败时要把 tmp 清掉，别给用户留一个 settings.json.tmp 的谜
      expect(s).toMatch(/unlinkSync\(tmp\)/)
    })

    it(`${name}：备份路径**先打印再写**`, () => {
      const s = src()
      const printed = s.indexOf('console.log(`备份：${backup}`)')
      const written = s.indexOf('writeAtomic(settingsPath')
      expect(printed).toBeGreaterThan(-1)
      expect(written).toBeGreaterThan(-1)
      // 顺序反了的话，被打断的那一次用户根本不知道备份在哪
      expect(printed).toBeLessThan(written)
    })

    it(`${name}：被 import 时不执行 main（否则单测会写用户真实配置）`, () => {
      expect(src()).toMatch(/if \(process\.argv\[1\] && resolve\(process\.argv\[1\]\) === resolve\(fileURLToPath\(import\.meta\.url\)\)\) \{/)
      expect(src()).not.toMatch(/^main\(\)$/m)
    })
  }
})
