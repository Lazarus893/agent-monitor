/**
 * 渲染层的画布样式必须与原型**逐字相同**。
 *
 * design/variations.html 是设计真源，src/renderer/app.css 是它的移植。
 * 两份文件迟早会分家 —— designer 改了原型而这边没跟进，屏上就悄悄落后一版，
 * 而且没有任何断言会红（版面仍然「不溢出、无 <14px」，只是不是最新那一版）。
 * 这条把「移植是忠实的」变成可执行的判据：
 *   原型第三个 <style> 块（STAGE 段）必须与 app.css 的 STAGE 段一字不差。
 *
 * app.css 允许的差异只在这一段**之外**，且都写在文件头的注释里：
 * 头注释、body、.stage 的尺寸与倍率、panelX 的两件配套 UI、末尾的 .harness 调试栏。
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()

const STAGE_HEAD = '/* ==========================================================================\n   STAGE —— 画布坐标 480×270'
const HARNESS_HEAD = '/* ==========================================================================\n   调试栏 —— 纯工具'

/**
 * 原型里的 STAGE 段 —— **按内容找，不按第几个 <style> 块找**。
 *
 * 「第三个」是 designer 那边的实现细节，不是我该依赖的不变量：
 * 他哪天拆一个 style 块，这条要么无故变红，要么更糟 —— 悄悄对着错的块变绿。
 * 改成认段头标记，块数怎么变都指得准；并顺手断言它只出现在一个块里。
 */
function prototypeStage(): string {
  const html = readFileSync(join(ROOT, 'design', 'variations.html'), 'utf8').split('\n')
  const opens = html.flatMap((l, i) => (l.trim() === '<style>' ? [i] : []))
  const closes = html.flatMap((l, i) => (l.trim() === '</style>' ? [i] : []))
  const blocks = opens.map((o, k) => html.slice(o + 1, closes[k]!).join('\n').trim())
  const hits = blocks.filter(b => b.includes(STAGE_HEAD))
  // 一个都没有 = 段头改了名；两个以上 = 画布样式被拆开了，「逐字相同」这条就失去意义
  expect(hits).toHaveLength(1)
  return hits[0]!
}

function portedStage(): string {
  const css = readFileSync(join(ROOT, 'src', 'renderer', 'app.css'), 'utf8')
  const i = css.indexOf(STAGE_HEAD)
  const j = css.indexOf(HARNESS_HEAD)
  expect(i).toBeGreaterThan(0)
  expect(j).toBeGreaterThan(i)
  return css.slice(i, j).trim()
}

describe('画布样式的移植是忠实的', () => {
  it('app.css 的 STAGE 段与原型第三个 <style> 块逐字相同', () => {
    expect(portedStage()).toBe(prototypeStage())
  })

  it('六页的样式都在（少一页就是漏移植了）', () => {
    const css = portedStage()
    for (const p of ['.page-a', '.page-b', '.page-c', '.page-d', '.page-e', '.page-attn']) {
      expect(css).toContain(p)
    }
  })

  it('E 页的时间列不可收缩 —— 它曾被来源名整段挤掉', () => {
    expect(portedStage()).toContain('.page-e .e-time{flex:none')
  })

  it('画布样式里不混调试栏的样式（.harness 是工具层，不进画布）', () => {
    expect(prototypeStage()).not.toContain('.harness')
    expect(portedStage()).not.toContain('.harness')
  })
})
