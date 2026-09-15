#!/usr/bin/env node
/**
 * 把 claude-statusline-tee.sh 装进 ~/.claude/settings.json 的 statusLine.command，
 * 或者卸掉。**这个脚本不会被本项目自动执行** —— 由 lead 决定什么时候装（M2 简报）。
 *
 *   node scripts/install-claude-statusline.mjs            装
 *   node scripts/install-claude-statusline.mjs --uninstall 还原
 *   node scripts/install-claude-statusline.mjs --settings <路径>   换一份 settings 操作（测试用）
 *
 * 纪律：
 *   · 动手之前先备份到 settings.json.bak-<时间戳>；
 *   · 幂等 —— 已经包过就什么都不做，不会套娃；
 *   · 只改 statusLine.command 这一个字段，缩进沿用原文件。
 */

import { copyFileSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const TEE = join(HERE, 'claude-statusline-tee.sh')
const MARK = 'claude-statusline-tee.sh'
/**
 * 包装串的形态：`bash "<TEE>" -- /bin/sh -c "<原命令整条>"`。
 * 原命令必须整条交回给 shell，而不是拆成 argv —— 否则 `FOO=1 cmd`、`a | b`、`(a)`
 * 这些「只有 shell 认识」的成分会被打掉，statusline 直接变成空白（复核 P1-④ 实测）。
 */
const SH = '/bin/sh -c '
const buildWrap = original => `bash ${JSON.stringify(TEE)} -- ${SH}${JSON.stringify(original)}`

/** 认出已装的包装（新旧两种格式都认），返回里面那条原命令；没装过返回 null。 */
function unwrap(command) {
  const m = command.match(/^bash (?:"([^"]*claude-statusline-tee\.sh)"|(\S*claude-statusline-tee\.sh)) -- (.*)$/s)
  if (!m) return command.includes(MARK) ? { original: command, unknown: true } : null
  const rest = m[3]
  if (rest.startsWith(SH)) {
    // 新格式：后面是一个 JSON 字符串字面量
    try {
      const parsed = JSON.parse(rest.slice(SH.length))
      if (typeof parsed === 'string') return { original: parsed }
    } catch {
      // 落到下面当旧格式处理
    }
  }
  // 旧格式（M2 第一版）：原命令被当 argv 直接拼在 -- 后面
  return { original: rest }
}

const argv = process.argv.slice(2)
const uninstall = argv.includes('--uninstall')
const at = argv.indexOf('--settings')
const settingsPath = at >= 0 && argv[at + 1]
  ? resolve(argv[at + 1])
  : join(homedir(), '.claude', 'settings.json')

/** 沿用原文件的缩进，别把用户的 settings.json 重排成另一种风格 */
/**
 * 原子写（M4 复核 P1-①）。
 *
 * `writeFileSync` 对已存在的文件是 `open(..., 'w')` —— **先截断、再写**。
 * 中间被打断（`install.ts` 给的 20 s 超时会发 SIGTERM，正好能落在这个窗口里；磁盘满同理）
 * 就会留下一个 0 字节或半截的 `~/.claude/settings.json`，用户的 Claude Code 整个起不来。
 * 这是本项目唯一会碰用户全局配置的地方，比我们自己的配置更该用这个写法
 * （src/main/config.ts 早就是这么写的）。
 *
 * tmp 放在**同一个目录**，`rename` 才是同一文件系统上的原子操作。
 * 失败时把 tmp 清掉，不给用户留一个 `settings.json.tmp` 的谜。
 */
function writeAtomic(file, body) {
  const tmp = `${file}.tmp-${process.pid}`
  try {
    writeFileSync(tmp, body, { mode: 0o600 })
    renameSync(tmp, file)
  } catch (err) {
    try { unlinkSync(tmp) } catch { /* 本来就没写出来 */ }
    throw err
  }
}

function detectIndent(text) {
  const m = text.match(/\n([ \t]+)"/)
  return m ? m[1] : '  '
}

function stamp() {
  const d = new Date()
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function main() {
  let text
  try {
    text = readFileSync(settingsPath, 'utf8')
  } catch {
    console.error(`找不到 ${settingsPath}`)
    process.exit(1)
  }
  let settings
  try {
    settings = JSON.parse(text)
  } catch (err) {
    console.error(`${settingsPath} 不是合法 JSON（${err.message}），没有改动任何东西。`)
    process.exit(1)
  }
  const current = settings?.statusLine?.command
  if (typeof current !== 'string' || !current.trim()) {
    console.error(`${settingsPath} 里没有 statusLine.command，先在 Claude Code 里配好 statusline 再来。`)
    process.exit(1)
  }

  const wrapped = unwrap(current)
  if (wrapped?.unknown) {
    console.error('statusLine.command 里有 tee 的名字，但不是本脚本装出来的形态，' +
      '为安全起见不自动改。请手工处理：\n  ' + current)
    process.exit(1)
  }
  // 先剥再包：已装的旧格式会被就地重写成新格式（幂等 —— 结果一样就不写文件）
  const original = wrapped ? wrapped.original : current
  const next = uninstall ? original : buildWrap(original)

  if (next === current) {
    console.log(uninstall ? '没有被包过，无需还原：' : '已经是最新的包装形态，未改动：')
    console.log(`  ${current}`)
    return
  }

  /* 备份 → 先打印备份路径 → 再原子写（复核 P1-①，理由见 writeAtomic） */
  const backup = `${settingsPath}.bak-${stamp()}`
  copyFileSync(settingsPath, backup)
  console.log(`备份：${backup}`)
  settings.statusLine.command = next
  // 结尾换行沿用原文件：只改一个字段，就别顺手多加一个字节
  const tail = text.endsWith('\n') ? '\n' : ''
  writeAtomic(settingsPath, JSON.stringify(settings, null, detectIndent(text)) + tail)

  console.log(`statusLine.command：\n  旧 ${current}\n  新 ${next}`)
  console.log(uninstall
    ? '已还原。'
    : '已安装。下一次 statusline 刷新就会按会话写 ~/.agent-monitor/claude-ratelimits/<session_id>.json' +
      '（裁剪成 rate_limits + model.display_name，目录 0700 / 文件 0600；' +
      '多个会话各写各的，由采集侧合并；需要 jq，没有 jq 则只转发不落盘）。')
}

/* 被 import 时不执行 —— 与 install-claude-hooks.mjs 一致。
   原来这里是裸的 `main()`：谁 import 一下这个模块（写个单测就会），
   它就当场对着**用户真实的** ~/.claude/settings.json 跑一遍安装。
   本轮实测踩到过（`node -e "import(...)"` 直接打印了「已经是最新的包装形态」）。 */
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main()
}
