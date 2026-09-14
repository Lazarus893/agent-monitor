/**
 * 日志轮转与 console tee（M4 §4）。
 *
 * 验收第 4 条里「日志轮转生效」就靠这几条 —— 实机上要攒够 5 MB 才看得见一次轮转，
 * 不可能每次都等；这里把阈值调小，把三个档位的搬家顺序钉死。
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_LOG_DIR, LOG_NAME, MAX_BYTES, logDir, makeCrashHandlers, rotate, startLogging
} from '../src/main/log.js'

const dir = (): string => mkdtempSync(join(tmpdir(), 'amlog-'))
const nth = (d: string, n: number): string => join(d, `main.${n}.log`)

let restore: (() => void) | null = null
afterEach(() => { restore?.(); restore = null })

describe('日志位置', () => {
  it('默认是 ~/Library/Logs/Agent Monitor', () => {
    expect(DEFAULT_LOG_DIR).toMatch(/Library\/Logs\/Agent Monitor$/)
    expect(logDir(undefined)).toBe(DEFAULT_LOG_DIR)
  })

  it('MONITOR_LOG_DIR 可以挪走（selftest / soak 靠它不污染真实日志）', () => {
    expect(logDir('/tmp/x')).toBe('/tmp/x')
    expect(logDir('   ')).toBe(DEFAULT_LOG_DIR) // 空白当没给
  })

  it('阈值就是简报写的 5 MB', () => {
    expect(MAX_BYTES).toBe(5 * 1024 * 1024)
  })
})

describe('轮转', () => {
  it('没到阈值不动', () => {
    const d = dir()
    writeFileSync(join(d, LOG_NAME), 'x'.repeat(100))
    expect(rotate(d, 1000)).toBe(false)
    expect(existsSync(nth(d, 1))).toBe(false)
  })

  it('文件不存在不抛', () => {
    expect(rotate(dir(), 10)).toBe(false)
  })

  it('超阈值：main → main.1，原文件腾空', () => {
    const d = dir()
    writeFileSync(join(d, LOG_NAME), 'A'.repeat(50))
    expect(rotate(d, 10)).toBe(true)
    expect(existsSync(join(d, LOG_NAME))).toBe(false)
    expect(readFileSync(nth(d, 1), 'utf8')).toBe('A'.repeat(50))
  })

  it('三个档位依次后移，第 4 份被丢掉', () => {
    const d = dir()
    writeFileSync(join(d, LOG_NAME), 'now')
    writeFileSync(nth(d, 1), 'one')
    writeFileSync(nth(d, 2), 'two')
    writeFileSync(nth(d, 3), 'three')   // 这一份该被丢
    expect(rotate(d, 1)).toBe(true)
    expect(readFileSync(nth(d, 1), 'utf8')).toBe('now')
    expect(readFileSync(nth(d, 2), 'utf8')).toBe('one')
    expect(readFileSync(nth(d, 3), 'utf8')).toBe('two')
    expect(existsSync(join(d, 'main.4.log'))).toBe(false)
  })
})

describe('console tee', () => {
  it('照常打到 stdout，同时写进文件，带时间戳与级别', () => {
    const d = dir()
    const logger = startLogging(d)
    restore = () => logger.restore()
    console.log('[probe] 一行普通日志')
    console.warn('[probe] 一行警告')
    console.error('[probe] 一行错误')
    logger.restore()
    restore = null
    const text = readFileSync(logger.file, 'utf8')
    expect(text).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} INFO \[probe\] 一行普通日志$/m)
    expect(text).toContain('WARN [probe] 一行警告')
    expect(text).toContain('ERROR [probe] 一行错误')
  })

  it('日志文件是 0600 —— 里面有 cwd 这类路径，不该给同机其他用户看', () => {
    const d = dir()
    const logger = startLogging(d)
    restore = () => logger.restore()
    console.log('x')
    logger.restore()
    restore = null
    expect(statSync(logger.file).mode & 0o777).toBe(0o600)
  })

  it('restore 之后不再写文件', () => {
    const d = dir()
    const logger = startLogging(d)
    console.log('之前')
    logger.restore()
    console.log('之后')
    const text = readFileSync(logger.file, 'utf8')
    expect(text).toContain('之前')
    expect(text).not.toContain('之后')
  })

  it('目录建不出来也不崩（只是没有文件那一份）', () => {
    // 用一个文件当目录 —— mkdir 必失败
    const d = dir()
    const notADir = join(d, 'occupied')
    writeFileSync(notADir, 'x')
    const logger = startLogging(notADir)
    restore = () => logger.restore()
    expect(() => console.log('仍然不该抛')).not.toThrow()
    logger.restore()
    restore = null
  })
})

/* ==========================================================================
   两段式兜底（设计终审收尾第 1 条）。
   启动期的「不崩」会让 app 静静挂住 —— 没有窗口、没有报错、也不退出；
   实测踩过一次（打包版跑 selftest，executeJavaScript reject 之后挂了四分钟）。
   ========================================================================== */

describe('崩溃兜底分两段', () => {
  const spy = (): { fatal: (c: number) => void; codes: number[] } => {
    const codes: number[] = []
    return { fatal: c => codes.push(c), codes }
  }

  it('窗口就绪之前：uncaughtException → 记 ERROR 并 exit(1)', () => {
    const s = spy()
    const h = makeCrashHandlers(s.fatal)
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    h.onUncaught(new Error('起不来'))
    expect(s.codes).toEqual([1])
    expect(err.mock.calls.flat().join(' ')).toContain('起不来')
    expect(err.mock.calls.flat().join(' ')).toContain('[fatal]')
    err.mockRestore()
  })

  it('窗口就绪之前：unhandledRejection 同样 exit(1)', () => {
    const s = spy()
    const h = makeCrashHandlers(s.fatal)
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    h.onRejection(new Error('promise 没人接'))
    expect(s.codes).toEqual([1])
    err.mockRestore()
  })

  it('markReady 之后：只记日志，绝不退出', () => {
    const s = spy()
    const h = makeCrashHandlers(s.fatal)
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    h.markReady()
    h.onUncaught(new Error('某个 collector 炸了'))
    h.onRejection(new Error('某个 fetch 没 catch'))
    expect(s.codes).toEqual([])
    const out = err.mock.calls.flat().join(' ')
    expect(out).toContain('某个 collector 炸了')
    expect(out).toContain('某个 fetch 没 catch')
    expect(out).not.toContain('[fatal]')
    err.mockRestore()
  })

  it('ready() 如实反映当前处在哪一段', () => {
    const h = makeCrashHandlers(() => {})
    expect(h.ready()).toBe(false)
    h.markReady()
    expect(h.ready()).toBe(true)
  })

  it('非 Error 的抛出物也记得下来，不会变成 [object Object]', () => {
    const s = spy()
    const h = makeCrashHandlers(s.fatal)
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    h.markReady()
    h.onRejection('一个字符串')
    h.onRejection({ code: 'ENOENT' })
    const out = err.mock.calls.flat().join(' ')
    expect(out).toContain('一个字符串')
    expect(out).toContain('ENOENT')
    err.mockRestore()
  })

  it('主进程把 markReady 挂在首帧那一刻（did-finish-load）', () => {
    const src = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8')
    expect(src).toMatch(/installCrashGuards\(code => app\.exit\(code\)\)/)
    const load = src.indexOf("did-finish-load")
    const mark = src.indexOf('crash.markReady()')
    expect(load).toBeGreaterThan(-1)
    expect(mark).toBeGreaterThan(load)
  })
})
