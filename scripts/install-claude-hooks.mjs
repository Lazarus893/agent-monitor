#!/usr/bin/env node
/**
 * 把 claude-hook.sh 装进 ~/.claude/settings.json 的 hooks，或者卸掉。
 * **这个脚本不会被本项目自动执行** —— 由 lead 决定什么时候装（M3 简报「只写不装」）。
 *
 *   node scripts/install-claude-hooks.mjs             装
 *   node scripts/install-claude-hooks.mjs --uninstall 只移除本脚本装的那几条
 *   node scripts/install-claude-hooks.mjs --dry-run   只打印会写成什么样，不落盘
 *   node scripts/install-claude-hooks.mjs --settings <路径>   换一份 settings 操作（测试用）
 *
 * 装四个事件（M3 简报）：
 *   UserPromptSubmit → 会话开跑    Stop         → 完成
 *   Notification     → 等待你批准  SessionEnd   → 清 running
 *
 * 纪律：
 *   · 动手之前先备份到 settings.json.bak-<时间戳>；
 *   · **幂等** —— 已经装过就什么都不做，绝不重复追加；
 *   · **只碰自己那几条** —— 用户已有的 hook 一条不动，卸载时按脚本路径精确匹配；
 *   · 每条 `timeout: 3`，与 hook 本体里的 `curl -m 3` 对齐；
 *   · 缩进与结尾换行沿用原文件。
 */

import { copyFileSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const HOOK = join(HERE, 'claude-hook.sh')
const EVENTS = ['UserPromptSubmit', 'Stop', 'Notification', 'SessionEnd']
const TIMEOUT = 3

/**
 * 装出来的命令串，以及「这一条是不是我们装的」。
 *
 * 判据必须是**整条命令逐字相等**，不能是「包含 claude-hook.sh」这种子串匹配
 * （复核 P1-⑤）：用户自己有一个同名脚本时，子串判据会把它认成「已装」——
 * 我们的装不上，而 `--uninstall` 会把**用户的那条**删掉。
 * M2 的 install-claude-statusline.mjs 刚因为同类问题改成锚定匹配，这里不能把老毛病带回来。
 */
const command = `bash ${JSON.stringify(HOOK)}`
const isOurs = cmd => typeof cmd === 'string' && cmd.trim() === command

const argv = process.argv.slice(2)
const uninstall = argv.includes('--uninstall')
const dryRun = argv.includes('--dry-run')
const at = argv.indexOf('--settings')
const settingsPath = at >= 0 && argv[at + 1]
  ? resolve(argv[at + 1])
  : join(homedir(), '.claude', 'settings.json')

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
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/**
 * settings.json 的 hooks 形状：
 *   hooks: { <Event>: [ { matcher?: string, hooks: [ { type, command, timeout } ] } ] }
 * 我们往每个事件里加**一个自己的 matcher 组**（没有 matcher = 全部匹配），
 * 而不是塞进用户已有的组里 —— 后者一旦被用户删掉，我们的那条也跟着没了。
 */
export function addHook(hooks, event) {
  const groups = Array.isArray(hooks[event]) ? hooks[event] : []
  const already = groups.some(g =>
    Array.isArray(g?.hooks) && g.hooks.some(h => isOurs(h?.command)))
  if (already) return { hooks, changed: false }
  return {
    hooks: {
      ...hooks,
      [event]: [...groups, { hooks: [{ type: 'command', command, timeout: TIMEOUT }] }]
    },
    changed: true
  }
}

export function removeHook(hooks, event) {
  const groups = Array.isArray(hooks[event]) ? hooks[event] : []
  let changed = false
  const kept = []
  for (const g of groups) {
    if (!Array.isArray(g?.hooks)) { kept.push(g); continue }
    const inner = g.hooks.filter(h => !isOurs(h?.command))
    if (inner.length === g.hooks.length) { kept.push(g); continue }
    changed = true
    // 组里还剩别的 hook 就留着组；只剩我们那一条就把整组去掉，不留空壳
    if (inner.length) kept.push({ ...g, hooks: inner })
  }
  const next = { ...hooks }
  if (kept.length) next[event] = kept
  else delete next[event]
  return { hooks: next, changed }
}

export function apply(settings, remove) {
  let hooks = settings.hooks && typeof settings.hooks === 'object' ? { ...settings.hooks } : {}
  let changed = false
  for (const ev of EVENTS) {
    const r = remove ? removeHook(hooks, ev) : addHook(hooks, ev)
    hooks = r.hooks
    changed = changed || r.changed
  }
  const next = { ...settings }
  if (Object.keys(hooks).length) next.hooks = hooks
  else delete next.hooks
  return { settings: next, changed }
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

  const { settings: next, changed } = apply(settings, uninstall)
  if (!changed) {
    console.log(uninstall ? '没有本脚本装的 hook，无需还原。' : '四个 hook 都已在位，未改动。')
    return
  }

  const tail = text.endsWith('\n') ? '\n' : ''
  const body = JSON.stringify(next, null, detectIndent(text)) + tail

  if (dryRun) {
    console.log(`[dry-run] 会写入 ${settingsPath}：`)
    console.log(JSON.stringify(next.hooks ?? {}, null, 2))
    return
  }

  /* 顺序要紧（复核 P1-①）：备份 → **先把备份路径打出来** → 再写。
     原来这一行 console.log 在写入之后，被 SIGTERM 打断的那一次用户什么也看不到，
     不知道有备份、更不知道备份在哪 —— 托盘只会说一句「安装失败，详见日志」。 */
  const backup = `${settingsPath}.bak-${stamp()}`
  copyFileSync(settingsPath, backup)
  console.log(`备份：${backup}`)
  writeAtomic(settingsPath, body)

  console.log(uninstall
    ? `已移除 ${EVENTS.join(' / ')} 上本脚本装的 hook。`
    : `已装 ${EVENTS.join(' / ')} 四个 hook（timeout ${TIMEOUT}s）：\n  ${command}\n` +
      '面板在跑时事件会在 1 s 内出现；面板没跑时 hook 静默失败，不影响 Claude Code。')
}

// 被 import 时（测试）不执行
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main()
}
