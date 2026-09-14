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
 * 全局兜底（简报 §4 + 设计终审收尾第 1 条）。
 *
 * 分两个阶段，**因为「不崩」在两个阶段里是两件不同的事**：
 *
 * · **窗口就绪之前**（启动期）：任何没被接住的异常都是致命的。它意味着面板根本没起来，
 *   而吞掉它的后果是进程活着、托盘可能也没建、屏上什么都没有 —— app 于是**静静地挂住**，
 *   没有窗口、没有报错、也不退出，用户以为它在跑。
 *   实测踩过一次：打包版跑 selftest 时 `window.monitor.dev` 不存在（打包后按设计被摇掉），
 *   `executeJavaScript` reject → `main()` 的 promise reject → 被这里吞掉 → 挂了四分钟没动静。
 *   所以启动期一律记 ERROR 再 `exit(1)`：起不来就干脆利落地起不来。
 *
 * · **窗口就绪之后**（运行期）：面板已经在屏上了，这时候的目标反过来 —— 宁可某一块数据停更，
 *   也不该整个消失。一律只记一行。
 *
 * `fatal` 可注入：主进程传 `app.exit`，单测传一个 spy。
 */

export type CrashHandlers = {
  onUncaught(err: unknown): void
  onRejection(reason: unknown): void
  /** 窗口已经画出第一帧 —— 从这里开始转成「吞掉不崩」 */
  markReady(): void
  ready(): boolean
}

/**
 * 把抛出来的东西变成一行能查的字。
 *
 * 非 Error 的抛出物（`throw {code:'ENOENT'}`、被 reject 的 POJO）用 `String()` 会变成
 * `[object Object]` —— 等于什么都没记。这里退一步做**浅层** JSON，并截到 200 字。
 *
 * 这不违反本文件「不做深度序列化」那条纪律：那条管的是 console.* 的任意入参
 * （密钥有一天会从那里溜进日志）。这里处理的是一个**抛出物**，不是业务数据，
 * 而且只取一层、还截长度 —— 完整的凭据结构进不来，最坏也只是半个字段名。
 */
const MAX_THROWN = 200
const describe = (e: unknown): string => {
  if (e instanceof Error) return e.stack ?? e.message
  const s = String(e)
  if (s !== '[object Object]') return s
  try {
    return JSON.stringify(e, Object.keys(e as object).slice(0, 8)).slice(0, MAX_THROWN)
  } catch {
    return s
  }
}

/**
 * 两个 handler 的**纯逻辑**，不碰 `process`。
 * 抽出来是为了能测：直接挂到 `process` 上的话，单测里一发 uncaughtException
 * 就会和 vitest 自己的处理打架。
 */
export function makeCrashHandlers(fatal: (code: number) => void): CrashHandlers {
  let ready = false
  const handle = (tag: string, e: unknown): void => {
    console.error(`${tag} ${describe(e)}`)
    if (ready) return
    console.error('[fatal] 窗口还没就绪就出错，退出（exit 1）——起不来就别装作在跑')
    fatal(1)
  }
  return {
    onUncaught: e => handle('[uncaught]', e),
    onRejection: e => handle('[unhandled]', e),
    markReady: () => { ready = true },
    ready: () => ready
  }
}

/** 把上面两个 handler 挂到 process 上。返回的 markReady 由主进程在首帧之后调。 */
export function installCrashGuards(fatal: (code: number) => void = c => process.exit(c)): CrashHandlers {
  const h = makeCrashHandlers(fatal)
  process.on('uncaughtException', err => h.onUncaught(err))
  process.on('unhandledRejection', reason => h.onRejection(reason))
  return h
}
