/**
 * design/tokens.css 是唯一的样式真源。
 *
 * 「逐字相同」在这个仓库里不是靠比对两份文件保证的 —— 那样就已经有两份了，
 * 而两份文件迟早会分家（M0 的返工记录里这种事出过两次）。
 * 保证的方式是**只有一份**：渲染层直接 import design/tokens.css，src/ 下不存在副本。
 * 这三条断言把「只有一份」钉住：
 *   1. 渲染层 import 的就是 design/tokens.css 本体；
 *   2. src/ 下没有任何文件重新定义 tokens 里的变量（:root 块只能有一个）；
 *   3. 构建产物里那些变量确实在（import 没被摇掉，也没被谁覆盖）。
 */

import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const TOKENS = join(ROOT, 'design', 'tokens.css')

/** tokens.css 里 :root 定义的全部变量名 */
function tokenNames(): string[] {
  const css = readFileSync(TOKENS, 'utf8')
  return [...new Set([...css.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gim)].map(m => m[1]!))]
}

const walk = (dir: string, out: string[] = []): string[] => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

describe('tokens 只有一份', () => {
  it('渲染层 import 的是 design/tokens.css 本体', () => {
    const app = readFileSync(join(ROOT, 'src', 'renderer', 'app.ts'), 'utf8')
    expect(app).toContain("import '../../design/tokens.css'")
  })

  it('src/ 下没有 tokens 的副本', () => {
    const copies = walk(join(ROOT, 'src'))
      .filter(f => f.endsWith('.css'))
      .filter(f => /:root\s*\{/.test(readFileSync(f, 'utf8')))
    expect(copies).toEqual([])
  })

  it('src/ 下的样式不重新定义任何 token', () => {
    const names = new Set(tokenNames())
    const redefined: string[] = []
    for (const f of walk(join(ROOT, 'src')).filter(x => x.endsWith('.css'))) {
      const css = readFileSync(f, 'utf8')
      for (const m of css.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gim)) {
        if (names.has(m[1]!)) redefined.push(`${f}: ${m[1]}`)
      }
    }
    expect(redefined).toEqual([])
  })

  it('tokens 里带着 v2 新增的那几个（--panel-x 与五档热力图）', () => {
    const names = tokenNames()
    for (const n of ['--panel-x', '--heat-0', '--heat-1', '--heat-2', '--heat-3', '--heat-4']) {
      expect(names).toContain(n)
    }
  })

  it('构建产物里 tokens 确实在（import 没被摇掉）', () => {
    const assets = join(ROOT, 'out', 'renderer', 'assets')
    if (!existsSync(assets)) return // 还没 build 过就跳过，pnpm build 会跑到这一条
    const css = readdirSync(assets).filter(f => f.endsWith('.css'))
      .map(f => readFileSync(join(assets, f), 'utf8')).join('\n')
    expect(css).toContain('--heat-4')
    expect(css).toContain('--panel-x')
    // 画布里那几个关键变量也要在，少一个都会让整块屏退回浏览器默认样式
    for (const n of ['--canvas', '--ink', '--accent', '--screen-w']) expect(css).toContain(n)
  })
})
