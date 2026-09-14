/**
 * 把三个 collector 挂上调度器，结果写进 Store。
 *
 * 周期（简报「三个 collector」那张表）：codex 60 s、claude 15 s（读本地文件，便宜）、zcode 60 s。
 * 抖动、不并发、超时、退避都在 Scheduler 里，这里只负责接线与「强制失败」这个开关。
 */

import type { AgentId, NoticeCode } from '../../../shared/types.js'
import type { Store } from '../../state.js'
import { Scheduler } from '../scheduler.js'
import type { Job } from '../scheduler.js'
import { ClaudeCollector } from './claude.js'
import { collectCodex } from './codex.js'
import type { QuotaErrorCode, QuotaResult } from './types.js'
import { createZcodeCollector } from './zcode.js'

export const INTERVAL_MS: Record<AgentId, number> = {
  codex: 60_000,
  claude: 15_000,
  zcode: 60_000
}

const FORCEABLE = new Set<string>([
  'unauthorized', 'rate_limited', 'network', 'missing_key', 'missing_tool', 'no_statusline'
])

/** 演练用：把某个 agent 的下一轮采集短路成一个失败码。断网 / 缺 Key 都不用真动系统设置。 */
const forced = new Map<AgentId, QuotaErrorCode>()

export function setForcedError(agent: AgentId, code: NoticeCode | null): boolean {
  if (code === null) return forced.delete(agent)
  if (!FORCEABLE.has(code)) return false
  forced.set(agent, code as QuotaErrorCode)
  return true
}

/** MONITOR_FAKE_ERROR=network（三家全套）或 MONITOR_FAKE_ERROR=zcode:missing_key,codex:network */
export function applyFakeErrorEnv(value: string | undefined, agents: AgentId[]): void {
  if (!value) return
  for (const part of value.split(',').map(s => s.trim()).filter(Boolean)) {
    const [a, c] = part.includes(':') ? part.split(':') : [null, part]
    const code = (c ?? '').trim() as NoticeCode
    for (const id of agents) {
      if (a === null || a.trim() === id) setForcedError(id, code)
    }
  }
}

export function startQuota(store: Store, opts: { dev?: boolean } = {}): Scheduler {
  const claude = new ClaudeCollector()
  const zcode = createZcodeCollector()

  const real: Record<AgentId, (signal: AbortSignal) => Promise<QuotaResult>> = {
    codex: collectCodex,
    claude: claude.run,
    zcode
  }

  const jobs: Job[] = (Object.keys(real) as AgentId[]).map(id => ({
    name: id,
    intervalMs: INTERVAL_MS[id],
    run: signal => {
      const fake = forced.get(id)
      return fake ? Promise.resolve({ ok: false as const, code: fake }) : real[id](signal)
    },
    onResult: result => store.applyQuota(id, result)
  }))

  if (opts.dev) applyFakeErrorEnv(process.env.MONITOR_FAKE_ERROR, Object.keys(real) as AgentId[])

  const scheduler = new Scheduler(jobs)
  scheduler.start()
  return scheduler
}
