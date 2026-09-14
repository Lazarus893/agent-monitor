/**
 * Codex 额度：`codexbar usage --provider codex --json`。
 *
 * 两处实测出来的坑：
 *   1. codexbar 会先往 stdout 打几行 `[codex notify] …` 噪音，再打 JSON —— 整段
 *      JSON.parse 会当场失败。所以先把 JSON 从这段输出里挑出来（extractJson）。
 *   2. 输出是个数组（每个 provider 一项），要的是 [0].usage。
 *
 * 返回体里带 accountEmail —— 解析器只取 primary / secondary / loginMethod，
 * 邮箱既不进状态也不进日志。
 */

import { execFile } from 'node:child_process'
import type { QuotaWindow } from '../../../shared/types.js'
import type { QuotaResult } from './types.js'
import { codeFromText, isRecord, toIso, toInt } from './types.js'

/** PATH 里找不到就试 Homebrew 的绝对路径（app 从 Finder 启动时 PATH 是最小集） */
export const CODEXBAR_CANDIDATES = ['codexbar', '/opt/homebrew/bin/codexbar']
const ARGS = ['usage', '--provider', 'codex', '--json']

/**
 * 从「噪音行 + JSON」里把 JSON 挑出来。
 * 先整段试，再从最后一个以 [ 或 { 开头的行往前试 —— JSON 总是最后打出来的那一段。
 */
export function extractJson(text: string): unknown {
  const whole = tryParse(text)
  if (whole !== undefined) return whole
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim()
    if (!line.startsWith('[') && !line.startsWith('{')) continue
    const parsed = tryParse(line)
    if (parsed !== undefined) return parsed
  }
  return undefined
}

const tryParse = (s: string): unknown => {
  try {
    return JSON.parse(s) as unknown
  } catch {
    return undefined
  }
}

/** codexbar 输出 → 窗口。primary = 5 小时窗，secondary = 7 天窗。 */
export function parseCodex(stdout: string): QuotaResult {
  const root = extractJson(stdout)
  const first = Array.isArray(root) ? root[0] : root
  if (!isRecord(first)) {
    const code = codeFromText(stdout)
    return { ok: false, code: code ?? 'network' }
  }
  const usage = first['usage']
  if (!isRecord(usage)) {
    // 有输出但没有 usage：codexbar 自己没拿到额度，多半是登录态问题
    const code = codeFromText(stdout)
    return { ok: false, code: code ?? 'unauthorized' }
  }

  const windows: QuotaWindow[] = []
  const push = (raw: unknown, label: '5h' | '7d'): void => {
    if (!isRecord(raw)) return
    const usedPercent = toInt(raw['usedPercent'])
    const resetsAt = toIso(raw['resetsAt'])
    if (usedPercent === null || !resetsAt) return
    windows.push({ label, usedPercent, resetsAt })
  }
  push(usage['primary'], '5h')
  push(usage['secondary'], '7d')
  if (!windows.length) return { ok: false, code: 'unauthorized' }

  const loginMethod = usage['loginMethod']
  return {
    ok: true,
    windows,
    plan: typeof loginMethod === 'string' ? loginMethod : undefined,
    sampledAt: toIso(usage['updatedAt']) ?? new Date().toISOString()
  }
}

type Spawned = { stdout: string; stderr: string; notFound: boolean; failed: boolean }

const run = (bin: string, signal: AbortSignal): Promise<Spawned> =>
  new Promise(resolve => {
    execFile(bin, ARGS, { signal, timeout: 0, maxBuffer: 4 << 20 }, (err, stdout, stderr) => {
      const code = (err as NodeJS.ErrnoException | null)?.code
      resolve({
        stdout: stdout ?? '',
        stderr: stderr ?? '',
        notFound: code === 'ENOENT',
        failed: !!err
      })
    })
  })

export async function collectCodex(
  signal: AbortSignal,
  bins: string[] = CODEXBAR_CANDIDATES
): Promise<QuotaResult> {
  let missing = 0
  for (const bin of bins) {
    const out = await run(bin, signal)
    if (out.notFound) { missing++; continue }
    // 退出码非 0 也先看 stdout：codexbar 在部分 provider 失败时仍会打出可用的那一份
    const parsed = parseCodex(out.stdout)
    if (parsed.ok) return parsed
    if (out.failed) {
      const fromErr = codeFromText(out.stderr + '\n' + out.stdout)
      return { ok: false, code: fromErr ?? parsed.code }
    }
    return parsed
  }
  return { ok: false, code: missing === bins.length ? 'missing_tool' : 'network' }
}
