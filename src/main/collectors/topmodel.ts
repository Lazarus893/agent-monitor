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

import { open, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { MODEL_DISPLAY } from './events/claude.js'
import { STATUSLINE_DIR, newestSample } from './quota/claude.js'

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
  now = Date.now(),
  /* 怎么把 id 变成屏上那几个字。默认 `displayName`（`Fable 5.1`）；
     B 页传 `shortModel`（brief-m0-v2 §10 起那一格是「产品名 · 模型」）。
     传进来而不是在外面再转一道：statusline 兜底那条路返回的已经是显示名，
     外面再套一层就会对一个**已经格式化过的**字符串再解析一次。 */
  format: (raw: string) => string | undefined = displayName
): Promise<string | undefined> {
  const counts = new Map<string, number>()
  for (const f of await recentTranscripts(dir, windowMs, now)) {
    countModels(await tail(f), counts)
  }
  const top = topOf(counts)
  if (top) return format(top)
  // statusline 给的是 display_name（`Fable 5.1`），不是 id —— 它已经是给人看的了
  return statuslineModel()
}

/**
 * statusline 兜底的模型名：会话目录里**写入时刻最新**那一份的 `model.display_name`。
 *
 * tee 从 2026-09-15 起按 session_id 分文件，不再写那个单文件（`claude.ts` 见到还会删它），
 * 所以这里必须走目录 —— 还读单文件的话，新机器读到 ENOENT（B 页模型名消失），
 * 老机器读到升级前冻结的那份旧快照（长期显示错的模型名）。
 */
export async function statuslineModel(dir = STATUSLINE_DIR): Promise<string | undefined> {
  const s = await newestSample(Date.now(), dir)
  const name = s?.model
  if (!name) return undefined
  return name.length <= NAME_MAX ? name : name.slice(0, NAME_MAX - 1) + '…'
}

/** Codex / ZCode 的 id 本身就是显示名，只做长度截断 */
export function plainName(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  return raw.length <= NAME_MAX ? raw : raw.slice(0, NAME_MAX - 1) + '…'
}

/* ==========================================================================
   短名（brief-m0-v2 §10）。B 页那一格是「产品名 · 模型」，模型那半只有几个字符，
   放的必须是**认得出是哪个模型**的最短形式，而不是把完整 id 截断 ——
   `GLM-5.3-Fl…` 与 `gpt-6-astr…` 都是「截断」，不是「短名」。

   本机实测出现过的 id（三处采集当场抓的，用例就用这些）：
     Claude  claude-fable-5-1 / claude-opus-5 / claude-opus-4-6 / opus / <synthetic>
     Codex   gpt-6-astra / gpt-5.6-sol
     ZCode   builtin:bigmodel-coding-plan/GLM-5.3-Flash / …/GLM-5.3$high / …/GLM-5.2
   ========================================================================== */

/** 未知形态的上限（简报：最长 10 字符） */
export const SHORT_MAX = 10

const cap = (s: string): string => (s ? s[0]!.toUpperCase() + s.slice(1) : s)
const clipShort = (s: string): string =>
  s.length <= SHORT_MAX ? s : s.slice(0, SHORT_MAX - 1) + '…'

/**
 * 模型 id → 紧跟在产品名后面的短名。
 *
 * 四条家族规则，其余走兜底。**故意不做成一张查找表**：表只认见过的那几个，
 * 而模型每隔几周就出新的，认不出的那天屏上就会退回一串截断的 id。
 * 规则认的是**构词法**，新版本号、新代号都自动接得住。
 *
 * **每一条返回路径都过 `clipShort`**（m5-designer 2026-09-15 提的）：
 * 构词法的输出长度是开放的 —— `claude-somelongname-5` 剥完仍然是 20 个字符，
 * 而 B 页那一格按 ≤10 设计。只靠渲染层那条断言兜不住：它要在
 * 「产品名最长的那一行 + ok 档 + 403 画布」同时成立时才会红，条件太窄。
 * 长度是这个函数自己的契约，就在这儿闭合。
 */
export function shortModel(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  // `builtin:bigmodel-coding-plan/GLM-5.3$high` → `GLM-5.3`：去供应商路径与 $档位
  const bare = (raw.split('/').pop() ?? '').split('$')[0]!.trim()
  if (!bare) return undefined

  // Claude：claude-<名>-<版本各段> → `Fable 5.1` / `Opus 5` / `Haiku 4.5`
  const cl = /^claude-([a-z]+)((?:-\d+)*)$/i.exec(bare)
  if (cl) {
    const ver = cl[2]!.split('-').filter(Boolean).join('.')
    return clipShort(ver ? `${cap(cl[1]!)} ${ver}` : cap(cl[1]!))
  }
  // 裸的家族名（转录里出现过 `opus`）
  if (/^(opus|sonnet|haiku|fable)$/i.test(bare)) return clipShort(cap(bare))

  // Codex：gpt-<版本>-<代号> → 代号本身就是产品名（Astra / Sol）；没有代号就 `GPT-<版本>`
  const gp = /^gpt-([\d.]+)(?:-([a-z][a-z\d]*))?$/i.exec(bare)
  if (gp) return clipShort(gp[2] ? cap(gp[2]) : `GPT-${gp[1]}`)

  // 智谱：GLM-<主>.<次>，后面的档位词（Flash / Air…）不进短名
  const glm = /^(GLM-[\d.]+)/i.exec(bare)
  if (glm) return clipShort(glm[1]!.toUpperCase())

  /* 兜底：去掉厂商前缀（第一个 `-` 之前那段，只有它像厂商名时才去），
     取最后一段、首字母大写、截到 10 字符。
     `<synthetic>` 这种尖括号占位也走这里，原样留着比猜一个名字诚实。 */
  const parts = bare.split('-').filter(Boolean)
  const last = parts.length > 1 ? parts[parts.length - 1]! : bare
  return clipShort(cap(last))
}
