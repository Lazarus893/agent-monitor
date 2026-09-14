/**
 * AIHOT 返回的字段映射。样本是本机 2026-09-14 真实响应的形状（标题与正文换成占位）。
 * 重点在两条安全线：source 可能是对象、url 只接受 http(s)。
 */

import { describe, expect, it } from 'vitest'
import { SUMMARY_MAX, TITLE_MAX, parseItems, pickUrl, sourceName } from '../../src/main/collectors/news.js'
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
    expect(a!.source).toBe('公众号：某技术团队')
    expect(a!.url).toBe('https://aihot.news/items/cmu12ocst0b6nro2nypi25zyq')
    expect(a!.at).toBe('2026-09-14T09:59:00.000Z')
    expect(a!.reason).toBe('给出了完整训练思路。')
  })

  it('AIHOT 阅读页优先于原文', () => {
    expect(pickUrl(RESPONSE.items[0] as Record<string, unknown>)).toContain('aihot.news')
    expect(pickUrl(RESPONSE.items[1] as Record<string, unknown>)).toBe('https://example.com/b')
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

  it('只接受 http(s) 的 url —— javascript: / data: 一律不进状态', () => {
    expect(pickUrl({ links: { aihot: 'javascript:alert(1)' }, url: 'data:text/html,x' })).toBeUndefined()
    expect(pickUrl({ url: 'https://ok.example' })).toBe('https://ok.example')
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
