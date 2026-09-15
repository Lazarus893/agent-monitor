/**
 * statusline tee 的唯一硬要求：**包装前后 statusline 的可见输出一字不差**。
 * 这里就真的跑两遍 coralline（一遍直连、一遍经 tee），逐字节比 stdout 与退出码。
 *
 * 时钟段每秒都在变，会把逐字节比较变成掷骰子 —— 用一份临时 coralline.conf
 * （CORALLINE_CONFIG）把 VL_CLOCK 关掉，比的是除时钟外的整行。
 * 输入样本 tests/fixtures/claude-statusline.json 的字段名与 statusline.sh 那一次
 * jq 取的路径逐条对齐。
 */

import { execFileSync } from 'node:child_process'
import {
  chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseRateLimits, parseWrittenAt } from '../src/main/collectors/quota/claude.js'

const TEE = new URL('../scripts/claude-statusline-tee.sh', import.meta.url).pathname
const STATUSLINE = join(homedir(), '.claude', 'coralline', 'statusline.sh')
const SAMPLE = readFileSync(new URL('./fixtures/claude-statusline.json', import.meta.url), 'utf8')

const jq = (() => {
  try {
    execFileSync('jq', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()
const canRunCoralline = existsSync(STATUSLINE) && jq
if (!canRunCoralline) {
  // 静默 skip 会变成一条永远绿的空用例（复核 §4.2a）
  console.warn(`[statusline-tee] 跳过 coralline 逐字节比对：${existsSync(STATUSLINE) ? '缺 jq' : '本机没有 ' + STATUSLINE}`)
}

const workdir = (): string => mkdtempSync(join(tmpdir(), 'agent-monitor-tee-'))

/** 样本里的 session_id —— 新版 tee 按它分文件 */
const SID = '00000000-0000-4000-8000-000000000000'
/** 这份样本该落到哪儿：`<am>/claude-ratelimits/<sid>.json` */
const sessionFile = (am: string): string => join(am, 'claude-ratelimits', `${SID}.json`)

/** 关掉秒级时钟，其余沿用 coralline 默认 —— 两次运行之间唯一会变的就是它 */
function fixedConf(dir: string): string {
  const conf = join(dir, 'coralline.conf')
  writeFileSync(conf, 'VL_CLOCK=off\n')
  return conf
}

type Run = { stdout: Buffer; status: number }
const run = (argv: string[], env: NodeJS.ProcessEnv): Run => {
  try {
    return { stdout: execFileSync('bash', argv, { input: SAMPLE, env: { ...process.env, ...env } }), status: 0 }
  } catch (err) {
    const e = err as { stdout?: Buffer; status?: number }
    return { stdout: e.stdout ?? Buffer.alloc(0), status: e.status ?? 1 }
  }
}

describe('claude-statusline-tee.sh', () => {
  it('没有原命令时就是一个纯 tee：stdout 原样，文件带 writtenAt + payload', () => {
    const dir = workdir()
    const out = run([TEE], { AGENT_MONITOR_DIR: join(dir, 'am') })
    expect(out.stdout.toString()).toBe(SAMPLE.trimEnd())
    if (!jq) return   // 没有 jq 就只转发不落盘，下面的断言不适用

    const raw = JSON.parse(readFileSync(sessionFile(join(dir, 'am')), 'utf8')) as unknown
    expect(parseWrittenAt(raw)).toBeTruthy()
    expect(parseRateLimits(raw)).toEqual([
      { label: '5h', usedPercent: 18, resetsAt: '2026-09-14T09:00:00.000Z' },
      { label: '7d', usedPercent: 31, resetsAt: '2026-09-19T03:00:00.000Z' }
    ])
  })

  /**
   * 复核 P1-③：这个文件每秒被重写一次。采集侧只要 rate_limits，
   * 而 statusline 的原始 JSON 里还有每个会话的工程路径、transcript 路径、session id。
   */
  it.skipIf(!jq)('只落 rate_limits 与 model.display_name，不落 cwd / transcript_path / cost', () => {
    const dir = workdir()
    run([TEE], { AGENT_MONITOR_DIR: join(dir, 'am') })
    const text = readFileSync(sessionFile(join(dir, 'am')), 'utf8')
    /* session_id 从「一个字都不落」变成「只出现在文件名里」（2026-09-15 多会话 P1）：
       没有它就分不开写入者。它是个 uuid，不像 cwd 那样泄露工程结构，目录仍是 0700。
       **文件内容里仍然一个字都没有。** */
    for (const leak of ['cwd', 'transcript_path', 'session_id', 'total_cost_usd', 'sample-project']) {
      expect(text).not.toContain(leak)
    }
    const raw = JSON.parse(text) as { payload: Record<string, unknown> }
    expect(Object.keys(raw.payload).sort()).toEqual(['model', 'rate_limits'])
    expect(raw.payload.model).toEqual({ display_name: 'Sample' })
  })

  it.skipIf(!jq)('目录 0700、文件 0600；已存在的 0755 目录也会被收紧', () => {
    const dir = workdir()
    const am = join(dir, 'am')
    execFileSync('mkdir', ['-m', '755', am])
    run([TEE], { AGENT_MONITOR_DIR: am })
    expect(statSync(am).mode & 0o777).toBe(0o700)
    expect(statSync(join(am, 'claude-ratelimits')).mode & 0o777).toBe(0o700)
    expect(statSync(sessionFile(am)).mode & 0o777).toBe(0o600)
  })

  /* ====================================================================
     按会话分文件（2026-09-15 实机 P1）。用户同时开着几十个 Claude Code 会话，
     原来它们每秒轮流覆盖同一份文件 —— 有的给 five_hour，有的不给，
     面板上的 5h 于是时不时掉成 0%。
     ==================================================================== */

  const runWith = (json: string, am: string): Run => {
    try {
      return { stdout: execFileSync('bash', [TEE], { input: json, env: { ...process.env, AGENT_MONITOR_DIR: am } }), status: 0 }
    } catch (err) {
      const e = err as { stdout?: Buffer; status?: number }
      return { stdout: e.stdout ?? Buffer.alloc(0), status: e.status ?? 1 }
    }
  }
  const payload = (sid: string | null, rl: unknown): string =>
    JSON.stringify({ ...(sid ? { session_id: sid } : {}), rate_limits: rl })

  it.skipIf(!jq)('两个会话各写各的，互不覆盖', () => {
    const am = join(workdir(), 'am')
    runWith(payload('sess-a', { five_hour: { used_percentage: 5, resets_at: 1789790400 } }), am)
    runWith(payload('sess-b', { seven_day: { used_percentage: 22, resets_at: 1789790400 } }), am)
    expect(readdirSync(join(am, 'claude-ratelimits')).sort()).toEqual(['sess-a.json', 'sess-b.json'])
    expect(parseRateLimits(JSON.parse(readFileSync(join(am, 'claude-ratelimits', 'sess-a.json'), 'utf8'))))
      .toEqual([{ label: '5h', usedPercent: 5, resetsAt: '2026-09-19T04:00:00.000Z' }])
  })

  /* 拿不到 session_id 也**不许**退回共写一份单文件 —— 几十个无 sid 会话共写一份，
     正是这次要修的覆盖 bug。按写入进程（$PPID）分文件，老的单文件一个字都不写。 */
  it.skipIf(!jq)('拿不到 session_id 时按写入进程分文件，不写老的单文件', () => {
    const am = join(workdir(), 'am')
    runWith(payload(null, { seven_day: { used_percentage: 22, resets_at: 1789790400 } }), am)
    const names = readdirSync(join(am, 'claude-ratelimits'))
    expect(names).toHaveLength(1)
    expect(names[0]).toMatch(/^nosid-\d+\.json$/)
    expect(existsSync(join(am, 'claude-ratelimits.json'))).toBe(false)
  })

  it.skipIf(!jq)('不合规的 session_id 一律当没拿到，绝不写出目录', () => {
    const dir = workdir()
    const am = join(dir, 'am')
    for (const bad of ['../../pwned', 'a/b', '..', 'x'.repeat(65)]) {
      runWith(payload(bad, { seven_day: { used_percentage: 1, resets_at: 1789790400 } }), am)
    }
    // `../../pwned` 相对 <dir>/am/claude-ratelimits 正好是 <dir>/pwned.json
    expect(existsSync(join(dir, 'pwned.json'))).toBe(false)
    expect(existsSync(join(am, 'pwned.json'))).toBe(false)
    expect(existsSync(join(am, 'claude-ratelimits.json'))).toBe(false)
    // 四次都落到同一份 nosid 文件里（同一个父进程），目录里就这一个
    expect(readdirSync(join(am, 'claude-ratelimits'))).toHaveLength(1)
  })

  /**
   * 逐字节比对的性质用一个**自带的**脚本钉死：ANSI 转义、CJK、emoji、方框字符、
   * 字面 % 都要原样穿过 tee。coralline 那条用例依赖用户主目录，缺 jq / 缺文件时会 skip。
   */
  it('ANSI / emoji / CJK / 字面 % 的输出逐字节穿过 tee', () => {
    const dir = workdir()
    const sl = join(dir, 'sl.sh')
    writeFileSync(sl, "#!/bin/bash\ncat > /dev/null\nprintf '\\033[38;5;208m▰▱ 花叔 🚀 100%% │ ✔\\033[0m'\n")
    chmodSync(sl, 0o755)
    const direct = run([sl], { AGENT_MONITOR_DIR: join(dir, 'am') })
    const teed = run([TEE, '--', '/bin/sh', '-c', JSON.stringify(sl).slice(1, -1)], { AGENT_MONITOR_DIR: join(dir, 'am') })
    expect(teed.stdout.equals(direct.stdout)).toBe(true)
    expect(direct.stdout.length).toBeGreaterThan(20)
  })

  it('写盘失败不影响转交给原命令的内容（结尾换行会被命令替换吃掉，JSON 文档里不表意）', () => {
    // 目录名指向一个文件 → mkdir 必失败
    const dir = workdir()
    const blocked = join(dir, 'not-a-dir')
    writeFileSync(blocked, 'x')
    const direct = run(['-c', 'cat'], {})
    const teed = run([TEE, '--', 'cat'], { AGENT_MONITOR_DIR: blocked })
    expect(teed.stdout.toString()).toBe(direct.stdout.toString().trimEnd())
    expect(JSON.parse(teed.stdout.toString())).toEqual(JSON.parse(direct.stdout.toString()))
    expect(teed.status).toBe(0)
  })

  it('退出码透传的是原命令的', () => {
    expect(run([TEE, '--', 'bash', '-c', 'exit 3'], { AGENT_MONITOR_DIR: workdir() }).status).toBe(3)
  })

  it.skipIf(!canRunCoralline)('包装前后 coralline 的 stdout 逐字节相同（副本，不动用户那份）', () => {
    const dir = workdir()
    // 复制一份再跑：用例不该依赖也不该触碰 ~/.claude 下的真文件
    const copy = join(dir, 'statusline.sh')
    copyFileSync(STATUSLINE, copy)
    const env = { CORALLINE_CONFIG: fixedConf(dir), AGENT_MONITOR_DIR: join(dir, 'am') }
    const before = run([copy], env)
    // 装出来的真实形态：原命令整条交给 /bin/sh -c
    const after = run([TEE, '--', '/bin/sh', '-c', `bash ${JSON.stringify(copy)}`], env)
    expect(after.stdout.equals(before.stdout)).toBe(true)
    expect(after.status).toBe(before.status)
    expect(before.stdout.length).toBeGreaterThan(0)
    // 样本带 session_id，所以落在 claude-ratelimits/<sid>.json
    if (jq) expect(existsSync(sessionFile(join(dir, 'am')))).toBe(true)
  })
})

/**
 * 安装脚本只在**临时副本**上跑 —— 真正的 ~/.claude/settings.json 由 lead 决定何时动，
 * 本项目任何测试与代码都不碰它（M2 简报「不要做」第二条）。
 */
describe('install-claude-statusline.mjs', () => {
  const INSTALLER = new URL('../scripts/install-claude-statusline.mjs', import.meta.url).pathname
  const ORIGINAL = 'bash ~/.claude/coralline/statusline.sh'

  const sandbox = (): string => {
    const dir = workdir()
    const file = join(dir, 'settings.json')
    writeFileSync(file, JSON.stringify({
      permissions: { allow: ['mcp__pencil'] },
      model: 'claude-sample',
      statusLine: { type: 'command', command: ORIGINAL, refreshInterval: 1 }
    }, null, 2) + '\n')
    return file
  }
  const node = (args: string[]): string =>
    execFileSync('node', args, { encoding: 'utf8' })
  const read = (file: string): Record<string, unknown> =>
    JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  const command = (file: string): string =>
    (read(file).statusLine as { command: string }).command

  it('装：包一层、先备份、其余字段一个不动', () => {
    const file = sandbox()
    const out = node([INSTALLER, '--settings', file])
    expect(out).toMatch(/备份：/)
    const cmd = command(file)
    // 原命令整条作为一个 shell 字符串交回去，而不是拆成 argv（复核 P1-④）
    expect(cmd).toMatch(/^bash ".*claude-statusline-tee\.sh" -- \/bin\/sh -c "bash ~\/\.claude\/coralline\/statusline\.sh"$/)
    expect(read(file).model).toBe('claude-sample')
    expect((read(file).statusLine as { refreshInterval: number }).refreshInterval).toBe(1)
    const backups = execFileSync('bash', ['-c', `ls ${JSON.stringify(file)}.bak-* | wc -l`], { encoding: 'utf8' })
    expect(Number(backups.trim())).toBe(1)
  })

  it('幂等：再装一次不套娃、不写文件', () => {
    const file = sandbox()
    node([INSTALLER, '--settings', file])
    const first = command(file)
    const out = node([INSTALLER, '--settings', file])
    expect(out).toMatch(/已经是最新的包装形态/)
    expect(command(file)).toBe(first)
  })

  it('卸：还原成一模一样的原命令', () => {
    const file = sandbox()
    node([INSTALLER, '--settings', file])
    node([INSTALLER, '--settings', file, '--uninstall'])
    expect(command(file)).toBe(ORIGINAL)
  })

  it('含 shell 操作符的原命令装卸往返不走样（旧实现会把 statusline 打成空白）', () => {
    const tricky = 'FOO=1 bash ~/.claude/sl.sh | cat'
    const file = workdir() + '/settings.json'
    writeFileSync(file, JSON.stringify({ statusLine: { type: 'command', command: tricky } }, null, 2))
    node([INSTALLER, '--settings', file])
    expect(command(file)).toBe(`bash ${JSON.stringify(TEE)} -- /bin/sh -c ${JSON.stringify(tricky)}`)
    node([INSTALLER, '--settings', file, '--uninstall'])
    expect(command(file)).toBe(tricky)
  })

  it('旧格式（argv 拼接）会被就地重写成新格式，且仍能正确还原', () => {
    const file = workdir() + '/settings.json'
    const legacy = `bash ${JSON.stringify(TEE)} -- ${ORIGINAL}`
    writeFileSync(file, JSON.stringify({ statusLine: { type: 'command', command: legacy } }, null, 2))
    const out = node([INSTALLER, '--settings', file])
    expect(out).toMatch(/备份：/)
    expect(command(file)).toBe(`bash ${JSON.stringify(TEE)} -- /bin/sh -c ${JSON.stringify(ORIGINAL)}`)
    node([INSTALLER, '--settings', file, '--uninstall'])
    expect(command(file)).toBe(ORIGINAL)
  })

  it('原文件没有结尾换行时，装完也不会多出一个', () => {
    const file = workdir() + '/settings.json'
    writeFileSync(file, JSON.stringify({ statusLine: { type: 'command', command: ORIGINAL } }, null, 2))
    node([INSTALLER, '--settings', file])
    expect(readFileSync(file, 'utf8').endsWith('\n')).toBe(false)
  })

  it('settings.json 不是合法 JSON 时给人话并且一个字节都不改', () => {
    const file = workdir() + '/settings.json'
    writeFileSync(file, '{bad')
    let stderr = ''
    try {
      execFileSync('node', [INSTALLER, '--settings', file], { encoding: 'utf8', stdio: 'pipe' })
    } catch (err) {
      stderr = (err as { stderr?: string }).stderr ?? ''
    }
    expect(stderr).toMatch(/不是合法 JSON/)
    expect(readFileSync(file, 'utf8')).toBe('{bad')
  })

  it('没包过时卸载是空操作', () => {
    const file = sandbox()
    const out = node([INSTALLER, '--settings', file, '--uninstall'])
    expect(out).toMatch(/没有被包过/)
    expect(command(file)).toBe(ORIGINAL)
  })
})
