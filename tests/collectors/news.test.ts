/**
 * AIHOT 返回的字段映射。样本是本机 2026-09-14 真实响应的形状（标题与正文换成占位）。
 * 重点在两条安全线：source 可能是对象、url 只接受 http(s)。
 */

import { describe, expect, it } from 'vitest'
import {
  SUMMARY_MAX, TITLE_MAX, parseItems, pickUrl, shortSource, sourceName
} from '../../src/main/collectors/news.js'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { newsWhen } from '../../src/renderer/timefmt.js'

const RESPONSE = {
  schemaVersion: 1,
  query: { mode: 'selected', window: '24h' },
  items: [
    {
      id: 'cmu12ocst0b6nro2nypi25zyq',
      title: '某团队开源 Search Agent 模型',
      originalTitle: '原标题',
      summary: '权重和评测代码已公开，数据与训练配方将陆续公布。',
      source: { name: '公众号：某技术团队' },
      links: { aihot: 'https://aihot.news/items/cmu12ocst0b6nro2nypi25zyq', original: 'https://example.com/a' },
      publishedAt: '2026-09-14T09:59:00.000Z',
      category: 'ai-models',
      reason: '给出了完整训练思路。'
    },
    {
      id: 'b',
      title: '第二条',
      source: '纯字符串来源',
      links: { original: 'https://example.com/b' },
      publishedAt: 'not a date'
    }
  ],
  page: { total: 2 }
}

describe('parseItems', () => {
  it('取出标题、摘要、来源、链接、时间、理由', () => {
    const [a] = parseItems(RESPONSE)
    expect(a!.title).toBe('某团队开源 Search Agent 模型')
    expect(a!.summary).toBe('权重和评测代码已公开，数据与训练配方将陆续公布。')
    // E-1 起 source 已经是收过的主名（渠道前缀剥掉），见下面的 shortSource 那一组
    expect(a!.source).toBe('某技术团队')
    // url 不再进 NewsItem（brief-m0-v2 §8）；链接走 parseFeed().links，见下面那一组
    expect(a!.at).toBe('2026-09-14T09:59:00.000Z')
    expect(a!.reason).toBe('给出了完整训练思路。')
  })

  it('只取 AIHOT 站内阅读页，**不退回原文**（brief-m0-v2 §8 的域名白名单要挡的就是它）', () => {
    expect(pickUrl(RESPONSE.items[0] as Record<string, unknown>)).toContain('aihot.news')
    // items[1] 只有 links.original（example.com），不该被当成可打开的链接
    expect(pickUrl(RESPONSE.items[1] as Record<string, unknown>)).toBeUndefined()
  })

  it('顶层 url 字段**不再**是退路 —— 只认 links.aihot 一个来路', () => {
    expect(pickUrl({ url: 'https://aihot.news/items/x' })).toBeUndefined()
    expect(pickUrl({ links: { aihot: 'data:text/html,x' } })).toBeUndefined()
  })

  it('source 两种编码都认', () => {
    expect(sourceName({ name: 'x' })).toBe('x')
    expect(sourceName('y')).toBe('y')
    expect(sourceName(null)).toBeUndefined()
    expect(parseItems(RESPONSE)[1]!.source).toBe('纯字符串来源')
  })

  it('非法日期被丢掉而不是塞一个 Invalid Date', () => {
    expect(parseItems(RESPONSE)[1]!.at).toBeUndefined()
  })

  it('只接受 https —— javascript: / data: / http: 一律不进内存', () => {
    expect(pickUrl({ links: { aihot: 'javascript:alert(1)' }, url: 'data:text/html,x' })).toBeUndefined()
    expect(pickUrl({ links: { aihot: 'http://aihot.news/x' } })).toBeUndefined()
    expect(pickUrl({ links: { aihot: 'https://aihot.news/items/ok' } })).toBe('https://aihot.news/items/ok')
  })

  it('标题与摘要都被截断，换行压成一行', () => {
    const long = 'あ'.repeat(400)
    const [it0] = parseItems({ items: [{ title: 'x\ny\n\nz', summary: long }] })
    expect(it0!.title).toBe('x y z')
    expect(it0!.summary!.length).toBeLessThanOrEqual(SUMMARY_MAX)
    const [it1] = parseItems({ items: [{ title: long }] })
    expect(it1!.title.length).toBeLessThanOrEqual(TITLE_MAX)
  })

  it('没有标题的条目直接跳过；limit 生效', () => {
    expect(parseItems({ items: [{ summary: '只有摘要' }, { title: 'ok' }] })).toHaveLength(1)
    expect(parseItems({ items: Array.from({ length: 9 }, (_, i) => ({ title: 't' + i })) })).toHaveLength(5)
  })

  it('完全不认识的形状 → 空表，不抛', () => {
    expect(parseItems(null)).toEqual([])
    expect(parseItems({ items: 'x' })).toEqual([])
  })

  it('少于 5 条时按实际条数返回（今天实测是 3 条）', () => {
    expect(parseItems({ items: [{ title: 'a' }, { title: 'b' }, { title: 'c' }] })).toHaveLength(3)
  })
})

/**
 * E 页专用的短相对时间。通用的 whenFmt 跨天给「9/13 02:34」（14px mono 下 84px），
 * 这一行给不起 —— 时间列曾因此被来源名整段挤没（designer 2026-09-14 修）。
 */
describe('newsWhen', () => {
  const t = Date.parse('2026-09-14T20:00:00+08:00')
  const at = (iso: string): string => newsWhen(iso, t)

  it('四档：刚刚 / N 分钟前 / N 小时前 / M/D', () => {
    expect(at('2026-09-14T19:59:30+08:00')).toBe('刚刚')
    expect(at('2026-09-14T19:30:00+08:00')).toBe('30 分钟前')
    expect(at('2026-09-14T09:00:00+08:00')).toBe('11 小时前')
    expect(at('2026-09-12T09:00:00+08:00')).toBe('9/12')
  })

  it('最长的那一档就是「23 小时前」——列宽是按它定的，满 24 h 才退回日期', () => {
    expect(at('2026-09-13T21:00:00+08:00')).toBe('23 小时前')   // 23.0 h
    expect(at('2026-09-13T20:00:01+08:00')).toBe('23 小时前')   // 差 1 s 到 24 h
    expect(at('2026-09-13T20:00:00+08:00')).toBe('9/13')        // 整 24 h
  })

  it('非法时间给空串，不给 Invalid Date', () => {
    expect(newsWhen('nope', t)).toBe('')
  })
})

/* ==========================================================================
   设计终审 E-1 · 来源名要收成能读的主名。
   E 页来源列只有约 72px ≈ 5 个全角字，`公众号：…` 这种前缀会把整列吃光，
   屏上剩下的信息量为零。
   ========================================================================== */

describe('shortSource · 实测样本', () => {
  /** 2026-09-14 当场从 AIHOT 抓的那一份，三条来源名一字未改 */
  const LIVE = JSON.parse(
    readFileSync(join(process.cwd(), 'tests/fixtures/aihot-selected.json'), 'utf8')
  ) as { items: Array<{ source: { name: string } }> }

  it('fixture 里就是那三条真实来源名', () => {
    expect(LIVE.items.map(i => i.source.name)).toEqual([
      '公众号：小红书技术（dots.llm）',
      'Gary Marcus：The Road to AI We Can Trust（RSS）',
      'Hacker News：AI 热帖'
    ])
  })

  it('三条各自收成主名', () => {
    expect(LIVE.items.map(i => shortSource(i.source.name)))
      .toEqual(['小红书技术', 'Gary Marcus', 'Hacker News'])
  })

  it('剥完都在 6 个全角字以内 —— 那一列放得下', () => {
    for (const i of LIVE.items) expect(shortSource(i.source.name).length).toBeLessThanOrEqual(11)
  })

  it('整条链路：parseItems 出来的 source 已经是主名', () => {
    expect(parseItems(LIVE).map(i => i.source)).toEqual(['小红书技术', 'Gary Marcus', 'Hacker News'])
  })
})

describe('shortSource · 规则边界（构造用例，非实测）', () => {
  it('没有冒号就原样返回', () => {
    expect(shortSource('少数派')).toBe('少数派')
    expect(shortSource('V2EX')).toBe('V2EX')
  })

  it('半角冒号与全角冒号一视同仁', () => {
    expect(shortSource('公众号: 机器之心')).toBe('机器之心')
    expect(shortSource('公众号：机器之心')).toBe('机器之心')
  })

  it('渠道词不分大小写', () => {
    expect(shortSource('RSS：Simon Willison')).toBe('Simon Willison')
    expect(shortSource('rss：Simon Willison')).toBe('Simon Willison')
  })

  it('左半截不是渠道词就取左边 —— 「较短的那段」是错的判据', () => {
    // 右边更短，但主名在左边
    expect(shortSource('Hacker News：AI')).toBe('Hacker News')
  })

  it('半角与全角括注都去掉，位置不限', () => {
    expect(shortSource('量子位（QbitAI）')).toBe('量子位')
    expect(shortSource('The Verge (AI)')).toBe('The Verge')
    expect(shortSource('（转载）少数派')).toBe('少数派')
  })

  it('只切第一个冒号 —— 后面的冒号是名字的一部分', () => {
    expect(shortSource('公众号：AI：前沿')).toBe('AI：前沿')
  })

  it('剥光了就退回去，不返回空串', () => {
    expect(shortSource('公众号：')).toBe('公众号：')
    expect(shortSource('（全是括注）')).toBe('（全是括注）')
    expect(shortSource('   ')).toBe('')
  })

  it('换行与多余空白压平（来源名是不可信文本）', () => {
    expect(shortSource('公众号：\n 机器  之心 ')).toBe('机器 之心')
  })
})
