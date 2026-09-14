/**
 * 常驻日志 —— `~/Library/Logs/Agent Monitor/main.log`（简报 §4）。
 *
 * 面板是 24/7 跑的，打包后没有终端能看 stdout，出了事只剩这个文件。三条纪律：
 *
 * 1. **轮转**：超过 5 MB 滚成 `main.1.log`，最多留 3 份（`main.1` / `.2` / `.3`），
 *    上限约 20 MB。轮转在**写之前**判断，所以单个文件不会越过阈值太多。
 * 2. **不吞输出**：console.* 仍然照常打到 stdout/stderr（`pnpm dev` 下要看得见），
 *    文件只是 tee 出来的一份。
 * 3. **不写密钥**：本项目的 Key 只在 collectors/quota 的内存里流转，从不进 console；
 *    这里也不做任何「把对象整份 dump」的事 —— 只落 console 已经格式化好的那行字。
 *
 * 同步写（`appendFileSync`）是有意的：日志量是每分钟几行的量级，而异步写在
 * `uncaughtException` / `will-quit` 这两条路上经常还没落盘进程就没了 —— 恰恰是
 * 最需要那几行的时候。
 */

import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const DEFAULT_LOG_DIR = join(homedir(), 'Library', 'Logs', 'Agent Monitor')
export const LOG_NAME = 'main.log'
/** 单个文件上限：超过就轮转 */
export const MAX_BYTES = 5 * 1024 * 1024
/** 保留几份历史（main.1.log … main.3.log） */
export const KEEP = 3

/** `MONITOR_LOG_DIR` 让 selftest / soak 把日志写进临时目录，不污染用户的真实日志。 */
export const logDir = (env = process.env.MONITOR_LOG_DIR): string =>
  env && env.trim() ? env : DEFAULT_LOG_DIR

const stamp = (): string => {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/**
 * 轮转判断。`main.3.log` 被丢掉，2→3、1→2、main→1。
 * 纯函数化不了（要碰文件系统），但每一步都各自 try —— 少一份历史比崩掉强。
 */
export function rotate(dir: string, max = MAX_BYTES, keep = KEEP): boolean {
  const file = join(dir, LOG_NAME)
  let size = 0
  try {
    size = statSync(file).size
  } catch {
    return false // 还没有这个文件
  }
  if (size < max) return false
  const nth = (n: number): string => join(dir, `main.${n}.log`)
  try {
    rmSync(nth(keep), { force: true })
  } catch { /* 删不掉就让它占着，下一轮还会再试 */ }
  for (let i = keep - 1; i >= 1; i--) {
    try {
      renameSync(nth(i), nth(i + 1))
    } catch { /* 这一档不存在 */ }
  }
  try {
    renameSync(file, nth(1))
  } catch {
    return false
  }
  return true
}

export type Logger = {
  file: string
  /** 写一行（已带时间戳与级别）。失败静默 —— 日志不该反过来弄崩进程。 */
  write(level: string, line: string): void
  /** 还原 console.*（测试与 selftest 用） */
  restore(): void
}

/**
 * 接管 console.log / warn / error，把同一行 tee 进日志文件。
 * 返回的 restore 会把三个方法还原回去。
 */
export function startLogging(dir = logDir()): Logger {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  } catch { /* 建不了目录就只剩 stdout，照跑 */ }
  const file = join(dir, LOG_NAME)

  const write = (level: string, line: string): void => {
    try {
      rotate(dir)
      appendFileSync(file, `${stamp()} ${level} ${line}\n`, { mode: 0o600 })
    } catch { /* 磁盘满 / 没权限 —— 静默 */ }
  }

  const original = { log: console.log, warn: console.warn, error: console.error }
  const tee = (level: string, fn: (...a: unknown[]) => void) =>
    (...args: unknown[]): void => {
      fn(...args)
      // 只落**已经格式化好的**参数，不做深度序列化：日志里出现整份对象，
      // 就是密钥有一天会溜进日志的那条路。
      write(level, args.map(a => (typeof a === 'string' ? a : String(a))).join(' '))
    }
  console.log = tee('INFO', original.log)
  console.warn = tee('WARN', original.warn)
  console.error = tee('ERROR', original.error)

  return {
    file,
    write,
    restore(): void {
      console.log = original.log
      console.warn = original.warn
      console.error = original.error
    }
  }
}

/**
 * 全局兜底（简报 §4）：任何没被 collector 的 try/catch 接住的异常都只记日志，
 * 绝不让主进程退出。面板宁可某一块数据停更，也不该整个消失。
 *
 * 没有例外 —— 包括退出途中那些 `EPIPE` / `ERR_IPC_CHANNEL_CLOSED` 噪音，
 * 一律只记一行。判断「哪些异常是致命的」需要的信息这里没有，
 * 而误判成致命的代价（面板整块消失、还没人发现）远大于多记几行。
 */
export function installCrashGuards(): void {
  process.on('uncaughtException', err => {
    console.error(`[uncaught] ${err instanceof Error ? err.stack ?? err.message : String(err)}`)
  })
  process.on('unhandledRejection', reason => {
    console.error(`[unhandled] ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`)
  })
}
