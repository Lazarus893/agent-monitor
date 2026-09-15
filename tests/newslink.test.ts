/**
 * E 页「点开这条新闻」那道闸门（brief-m0-v2 §8）。
 *
 * 这是本项目唯一一处把外部输入交给操作系统（`shell.openExternal`）的地方，
 * 而输入是 AIHOT 返回的字符串。所以校验抽成纯函数，正面打。
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  MAX_NEWS_ID, NEWS_HOSTS, allowedNewsHost, checkNewsLink, validNewsId
} from '../src/main/newslink.js'
import { parseFeed, pickUrl } from '../src/main/collectors/news.js'
import { onWindowOpen } from '../src/main/window.js'

describe('域名白名单', () => {
  it('就是简报写的那两个', () => {
    expect([...NEWS_HOSTS]).toEqual(['aihot.news', 'aihot.virxact.com'])
  })

  it('精确匹配与子域都放行，大小写不敏感', () => {
    for (const h of ['aihot.news', 'www.aihot.news', 'AIHOT.NEWS', 'aihot.virxact.com', 'a.b.aihot.news']) {
      expect(allowedNewsHost(h)).toBe(true)
    }
  })

  it('**后缀像**但不是同一个域的一律挡住', () => {
    for (const h of ['evil-aihot.news', 'aihot.news.evil.com', 'notaihot.news', 'aihot.virxact.com.evil.io']) {
      expect(allowedNewsHost(h)).toBe(false)
    }
  })
})

describe('checkNewsLink', () => {
  it('真实的站内阅读页放行（样本取自 tests/fixtures/aihot-selected.json）', () => {
    const raw = JSON.parse(
      readFileSync(join(process.cwd(), 'tests/fixtures/aihot-selected.json'), 'utf8')
    ) as unknown
    const links = [...parseFeed(raw).links.values()]
    expect(links.length).toBeGreaterThan(0)
    for (const l of links) {
      expect(l).toMatch(/^https:\/\/aihot\.news\/items\//)
      expect(checkNewsLink(l)).toEqual({ ok: true, url: l })
    }
  })

  it('没有链接 → missing（缓存回灌那一程、或这条本来就没给 links.aihot）', () => {
    expect(checkNewsLink(undefined)).toEqual({ ok: false, reason: 'missing' })
    expect(checkNewsLink('')).toEqual({ ok: false, reason: 'missing' })
  })

  it('解析不出来 → unparsable', () => {
    expect(checkNewsLink('不是一个 URL')).toEqual({ ok: false, reason: 'unparsable' })
    expect(checkNewsLink('//aihot.news/items/x')).toEqual({ ok: false, reason: 'unparsable' })
  })

  it('非 https 一律挡住 —— 连 http 都不行', () => {
    expect(checkNewsLink('http://aihot.news/items/x')).toEqual({ ok: false, reason: 'protocol' })
    for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,<script>1</script>']) {
      expect(checkNewsLink(bad).ok).toBe(false)
    }
  })

  it('https 但域名不对 → host（原文链接就是这一类，所以数据层根本不收它）', () => {
    expect(checkNewsLink('https://mp.weixin.qq.com/s?x=1')).toEqual({ ok: false, reason: 'host' })
    expect(checkNewsLink('https://evil-aihot.news/items/x')).toEqual({ ok: false, reason: 'host' })
  })

  it('用户信息 / 端口这类花样过不了域名这关', () => {
    expect(checkNewsLink('https://aihot.news@evil.com/x')).toEqual({ ok: false, reason: 'host' })
    // 自己域名带端口是允许的：hostname 不含端口
    expect(checkNewsLink('https://aihot.news:8443/items/x').ok).toBe(true)
  })
})

describe('validNewsId', () => {
  it('AIHOT 的 cuid 与我们兜底生成的 id 都收', () => {
    expect(validNewsId('cmu12ocst0b6nro2nypi25zyq')).toBe(true)
    // 兜底 id 里有冒号，标题片段里可能有空格与中文
    expect(validNewsId('aihot:0:小红书 AllSpark 开源')).toBe(true)
  })

  it('非字符串、空串、超长一律拒', () => {
    expect(validNewsId(undefined)).toBe(false)
    expect(validNewsId(123)).toBe(false)
    expect(validNewsId({})).toBe(false)
    expect(validNewsId('')).toBe(false)
    expect(validNewsId('x'.repeat(MAX_NEWS_ID + 1))).toBe(false)
    expect(validNewsId('x'.repeat(MAX_NEWS_ID))).toBe(true)
  })

  it('控制字符拒掉（日志干净），空格不拒（兜底 id 里有）', () => {
    expect(validNewsId('a\nb')).toBe(false)
    expect(validNewsId('a\u0000b')).toBe(false)
    expect(validNewsId('a\u007fb')).toBe(false)
    expect(validNewsId('a b')).toBe(true)
  })
})

describe('渲染层拿不到 URL', () => {
  it('NewsItem 里没有 url 字段（brief-m0-v2 §8）', () => {
    const raw = JSON.parse(
      readFileSync(join(process.cwd(), 'tests/fixtures/aihot-selected.json'), 'utf8')
    ) as unknown
    const { items, links } = parseFeed(raw)
    expect(items.length).toBe(links.size)
    for (const it of items) {
      expect(Object.keys(it)).not.toContain('url')
      // 但主进程那边查得到
      expect(links.get(it.id)).toMatch(/^https:\/\/aihot\.news\//)
    }
  })

  it('shared/types.ts 里也不许再有 url —— 加回去就是又把链接送进渲染层了', () => {
    const src = readFileSync(join(process.cwd(), 'src/shared/types.ts'), 'utf8')
    const block = src.slice(src.indexOf('export type NewsItem'), src.indexOf('export type NewsData'))
    expect(block).not.toMatch(/^\s*url\??:/m)
  })
})

/* ==========================================================================
   面板窗口：渲染层无论怎么 window.open，主进程都不去开。
   E 页要打开新闻走的是另一条路（只发 id + 白名单，见上面那几组），不经过这里。
   ========================================================================== */

describe('setWindowOpenHandler 一律 deny', () => {
  it('任意 URL 都只返回 deny，且不调用任何 opener', () => {
    const warned: string[] = []
    for (const url of [
      'https://aihot.news/items/x',          // 连白名单里的也不开
      'https://example.com/',
      'http://example.com/',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:text/html,<script>1</script>',
      'about:blank',
      ''
    ]) {
      expect(onWindowOpen(url, l => warned.push(l))).toEqual({ action: 'deny' })
    }
    expect(warned).toHaveLength(8)
    expect(warned.every(l => l.startsWith('[window] 拦下开窗请求'))).toBe(true)
  })

  it('window.ts 里没有 shell.openExternal 的**调用** —— 这条路彻底没有出口', () => {
    const src = readFileSync(join(process.cwd(), 'src/main/window.ts'), 'utf8')
    // 注释里可以提它（那段注释正是在解释为什么删掉），代码里不许有
    expect(src).not.toMatch(/shell\s*\.\s*openExternal\s*\(/)
    expect(src).not.toMatch(/^import .*\bshell\b.* from 'electron'/m)
  })

  it('超长 URL 只截一段进日志，不整条落盘', () => {
    const warned: string[] = []
    onWindowOpen('https://a.example/' + 'x'.repeat(5000), l => warned.push(l))
    expect(warned[0]!.length).toBeLessThan(160)
  })
})

describe('pickUrl 只认 links.aihot', () => {
  it('顶层 url 不再是退路', () => {
    expect(pickUrl({ url: 'https://aihot.news/items/x' })).toBeUndefined()
    expect(pickUrl({ links: { aihot: 'https://aihot.news/items/x' } }))
      .toBe('https://aihot.news/items/x')
  })

  it('原文链接、http、伪协议一律不收', () => {
    expect(pickUrl({ links: { original: 'https://mp.weixin.qq.com/s' } })).toBeUndefined()
    expect(pickUrl({ links: { aihot: 'http://aihot.news/x' } })).toBeUndefined()
    expect(pickUrl({ links: { aihot: 'javascript:alert(1)' } })).toBeUndefined()
    expect(pickUrl({})).toBeUndefined()
  })
})
