/**
 * 「当前窗口用得最多的模型」（B 页，M3b 简报 §2）。
 *
 * 窗口固定 5 h —— 与额度的 5h 窗对齐：B 页那条时间带说的就是这 5 小时，
 * 判语位置换成模型名之后，两者说的必须是同一段时间。
 *
 * 三家各有各的数法：
 *   Codex  近 5 h 内动过的 rollout 文件里的 `turn_context.payload.model`，每个 turn 计 1。
 *          由 CodexEvents 顺手记着（它本来就在逐行解析），这里不重复扫盘。
 *   Claude 近 5 h 内动过的 `~/.claude/projects/**​/*.jsonl` 里 assistant 的 `message.model`。
 *          只读文件尾部 256 KB（一份转录可以有几十 MB），并且只数不读正文。
 *          一条都没有时退回 statusline tee 落的 `model.display_name`。
 *   ZCode  `tasks` 表近 5 h 内 updated_at 的行按 model 计数，去掉 `builtin:…/` 前缀。
 *          由 ZcodeEvents 顺手记着。
 *
 * 显示名：Claude 的模型 id 要映射（`claude-fable-5-1` → `Fable 5.1`），
 * Codex 与 ZCode 的 id 本身就是人读的（`gpt-6-astra`、`GLM-5.3-Flash`），原样用。
 */

import { open, readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { MODEL_DISPLAY } from './events/claude.js'
import { STATUSLINE_FILE } from './quota/claude.js'

export const WINDOW_MS = 5 * 3600_000
export const REFRESH_MS = 5 * 60_000
export const PROJECTS_DIR = join(homedir(), '.claude', 'projects')
/** 每份转录只读尾部这么多 */
export const TAIL_BYTES = 256 * 1024
/** 一轮最多扫这么多份，避免转录目录很大时把 IO 打满 */
export const MAX_FILES = 60
/** 简报：显示名 ≤ 20 字符，超长截断 */
export const NAME_MAX = 20

/** 计数表里取最多的那个；并列时取名字排序靠前的，保证同一份数据每轮结论一样 */
export function topOf(counts: Map<string, number>): string | undefined {
  let best: string | undefined
  let bestN = 0
  for (const [k, n] of [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (n > bestN) { best = k; bestN = n }
  }
  return best
}

export function displayName(raw: string): string {
  const mapped = MODEL_DISPLAY[raw]
  if (mapped) return mapped
  // 没在表里的 Claude 模型：去掉 `claude-` 前缀，其余原样（别猜它的版本号写法）
  const s = raw.startsWith('claude-') ? raw.slice('claude-'.length) : raw
  return s.length <= NAME_MAX ? s : s.slice(0, NAME_MAX - 1) + '…'
}

/**
 * 一段转录文本里数 assistant 的 model。
 *
 * 只认 `"model":"…"`，不解析整行 JSON —— 一份转录几万行，全解析一轮要几百毫秒，
 * 而我们只要一个字段。但**先按行筛出 assistant 行**（复核 P2-4.4）：
 * 转录尾部里 `"model"` 也会出现在工具结果、用户粘贴的 JSON 片段里，
 * 不筛的话「用户贴了一段含 model 字段的日志」会被算进使用量。
 */
export function countModels(text: string, into = new Map<string, number>()): Map<string, number> {
  const re = /"model"\s*:\s*"([^"]{1,64})"/g
  for (const line of text.split('\n')) {
    if (!line.includes('"assistant"')) continue
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(line)) !== null) {
      const id = m[1]!
      // `<synthetic>` 是 Claude 给本地合成消息打的标记，`opus` 之类的别名也不是真实模型 id
      if (id.startsWith('<') || !id.includes('-')) continue
      into.set(id, (into.get(id) ?? 0) + 1)
    }
  }
  return into
}

/** 递归深度上限：projects / <项目> / <子目录…> / *.jsonl */
export const MAX_DEPTH = 4

/**
 * 近 windowMs 内动过的转录文件。
 *
 * **必须递归**（复核 P2-4.2）：原来固定扫两层，而 subagent 的转录落在
 * `<项目>/subagents/…` 这样的深层目录里 —— 本机 1047 份转录只有 230 份在深度 2，
 * 5 h 窗口内更是只看得见 4/14 份，B 页那个「最常用模型」取的是少数派。
 * IO 仍然受控：mtime 先筛、MAX_FILES 封顶、每份只读尾部（见 §4.3 的实测 12.6ms）。
 */
export async function recentTranscripts(
  dir = PROJECTS_DIR,
  windowMs = WINDOW_MS,
  now = Date.now()
): Promise<string[]> {
  const cut = now - windowMs
  const out: Array<{ path: string; mtime: number }> = []
  const walk = async (d: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH) return
    let entries
    try {
      entries = await readdir(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(d, e.name)
      if (e.isDirectory()) { await walk(p, depth + 1); continue }
      if (!e.isFile() || !e.name.endsWith('.jsonl')) continue
      try {
        const st = await stat(p)
        if (st.mtimeMs >= cut) out.push({ path: p, mtime: st.mtimeMs })
      } catch { /* 文件刚被删了 */ }
    }
  }
  await walk(dir, 1)
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, MAX_FILES).map(x => x.path)
}

async function tail(path: string, bytes = TAIL_BYTES): Promise<string> {
  let fh
  try {
    fh = await open(path, 'r')
  } catch {
    return ''
  }
  try {
    const { size } = await fh.stat()
    const start = Math.max(0, size - bytes)
    const len = size - start
    if (len <= 0) return ''
    const buf = Buffer.allocUnsafe(len)
    await fh.read(buf, 0, len, start)
    return buf.toString('utf8')
  } catch {
    return ''
  } finally {
    await fh.close()
  }
}

/** Claude 的 top model。没有转录可数时退回 statusline 里的 display_name。 */
export async function claudeTopModel(
  dir = PROJECTS_DIR,
  windowMs = WINDOW_MS,
  now = Date.now()
): Promise<string | undefined> {
  const counts = new Map<string, number>()
  for (const f of await recentTranscripts(dir, windowMs, now)) {
    countModels(await tail(f), counts)
  }
  const top = topOf(counts)
  if (top) return displayName(top)
  return statuslineModel()
}

export async function statuslineModel(file = STATUSLINE_FILE): Promise<string | undefined> {
  try {
    const raw: unknown = JSON.parse(await readFile(file, 'utf8'))
    if (typeof raw !== 'object' || raw === null) return undefined
    const root = raw as Record<string, unknown>
    const payload = (typeof root['payload'] === 'object' && root['payload'] !== null
      ? root['payload'] : root) as Record<string, unknown>
    const model = payload['model']
    if (typeof model !== 'object' || model === null) return undefined
    const name = (model as Record<string, unknown>)['display_name']
    return typeof name === 'string' && name.trim()
      ? (name.length <= NAME_MAX ? name : name.slice(0, NAME_MAX - 1) + '…')
      : undefined
  } catch {
    return undefined
  }
}

/** Codex / ZCode 的 id 本身就是显示名，只做长度截断 */
export function plainName(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  return raw.length <= NAME_MAX ? raw : raw.slice(0, NAME_MAX - 1) + '…'
}
