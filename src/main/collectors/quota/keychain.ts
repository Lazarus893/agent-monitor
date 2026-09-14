/**
 * Keychain 读取。只走 `security find-generic-password -w`，不 cat 任何凭据文件
 * （PLAN §4「不读 ~/.codexbar/config.json、~/.codex/config.toml」）。
 *
 * 返回值只在调用方的内存里流转：不进状态、不进日志、不进异常消息。
 * 找不到项、被拒绝、超时，统统返回 null —— 调用方据此映射成 missing_key / unauthorized。
 */

import { execFile } from 'node:child_process'

export function readKeychain(
  service: string,
  account?: string,
  signal?: AbortSignal
): Promise<string | null> {
  const args = ['find-generic-password', '-s', service]
  if (account) args.push('-a', account)
  args.push('-w')
  return new Promise(resolve => {
    execFile('security', args, { signal, maxBuffer: 1 << 20 }, (err, stdout) => {
      // err 的 message 里会带上完整命令行，但 -w 的输出只在 stdout，命令行里没有密钥
      if (err) return resolve(null)
      const value = (stdout ?? '').trim()
      resolve(value.length ? value : null)
    })
  })
}

/**
 * 环境变量能不能改写钥匙串项名。**打包产物里一律不能**（M4 复核 P1-②）。
 *
 * 这是个开发期旋钮：自检与验收靠它指到一个临时项，走完「保存 → 读回 → 删除」的往返
 * 而不碰真实的 Key。但打包之后它就变成了一条口子 —— 能给 app 设环境变量的人
 * 可以把「连接 ZCode」写进任意项名。主进程在启动时按 `app.isPackaged` 关掉它。
 *
 * 默认是开的：单测与脚本在 Electron 之外跑，没人会去调这个开关。
 */
let overrideAllowed = true
export function setKeychainOverrideAllowed(allowed: boolean): void {
  overrideAllowed = allowed
}

/**
 * service / account 的最终取值。
 * `MONITOR_KEYCHAIN_SERVICE` / `MONITOR_KEYCHAIN_ACCOUNT` 让验收与自检用一个临时项
 * 走完「保存 → 读回 → 删除」的往返，**绝不碰用户真实的 agent-monitor / zcode-bigmodel**。
 * 打包后这两个变量被忽略，见 setKeychainOverrideAllowed。
 */
export function keychainTarget(
  service: string,
  account: string,
  env = process.env
): { service: string; account: string } {
  if (!overrideAllowed) return { service, account }
  return {
    service: env['MONITOR_KEYCHAIN_SERVICE']?.trim() || service,
    account: env['MONITOR_KEYCHAIN_ACCOUNT']?.trim() || account
  }
}

/**
 * `security -i` 的命令行里，带空格 / 引号 / 反斜杠的值要用双引号包起来并转义。
 * 导出只为让单测钉住这段转义 —— 它错了会静默写进一个截断的 Key。
 */
export function quoteForSecurity(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** 控制字符绝不会出现在 API Key 里；出现就是粘贴带进来的脏东西，或者是注入尝试。 */
const CONTROL = /[\u0000-\u001f\u007f]/

/**
 * 授权框可能晾在那儿等人点，给够时间；但不能不设上限 ——
 * 不设的话钥匙串被锁时这个 Promise 永不 settle，连接窗口就一直停在「保存中…」。
 */
const WRITE_TIMEOUT_MS = 60_000

/**
 * 写入 Keychain。`-U` = 已存在就更新，不是新建第二条。
 *
 * **密钥不走 argv**：`security -i` 从 stdin 读命令，于是 `ps` 里只看得到 `security -i`。
 * 直接 `execFile('security', ['-w', key])` 也能用，但那样同机的任何进程都能
 * 在进程表里读到这枚 Key。
 *
 * 三道闸门（M4 复核 §1.2–1.4）：
 *   1. 控制字符在**这里**拒，不在调用方 —— `security -i` 的命令流注入是这条链路上
 *      唯一的高危面，校验该贴在最靠近危险的那一层。调用方那份只负责给用户看的文案。
 *   2. 写完**读回逐字比**。转义错了会静默存进一个被截断的 Key，而面板那边只显示
 *      「未连接」，用户永远查不到是丢了半截。比较只在内存里做，不记日志、不回显。
 *   3. 超时 + stdin 的 error 监听（`security` 提前退出会让这个流抛 EPIPE）。
 *
 * 返回 true/false；失败原因只记一句人类可读的话，**永不回显密钥本身**。
 */
export async function writeKeychain(
  service: string,
  account: string,
  secret: string,
  label = service
): Promise<boolean> {
  if (!secret || CONTROL.test(secret)) {
    console.warn('[keychain] 拒绝写入：Key 为空或含控制字符')
    return false
  }
  const line = [
    'add-generic-password', '-U',
    '-s', quoteForSecurity(service),
    '-a', quoteForSecurity(account),
    '-l', quoteForSecurity(label),
    '-w', quoteForSecurity(secret)
  ].join(' ')
  const wrote = await new Promise<boolean>(resolve => {
    const child = execFile(
      'security', ['-i'],
      { maxBuffer: 1 << 20, timeout: WRITE_TIMEOUT_MS },
      err => {
        if (err) console.warn('[keychain] 写入失败（钥匙串可能被锁、超时，或用户拒绝了授权）')
        resolve(!err)
      }
    )
    // security 提前退出会让 stdin 抛 EPIPE —— 那该由这里接住，不该滚到全局兜底
    child.stdin?.on('error', () => { /* 退出码那一路会报告失败 */ })
    child.stdin?.end(line + '\n')
  })
  if (!wrote) return false

  const back = await readKeychain(service, account)
  if (back !== secret) {
    console.warn('[keychain] 写入后读回不一致（长度与内容都不记录），已判失败')
    return false
  }
  return true
}

/** 删除一条（验收的往返测试用；托盘里没有「删除」入口）。 */
export function deleteKeychain(service: string, account: string): Promise<boolean> {
  return new Promise(resolve => {
    execFile('security', ['delete-generic-password', '-s', service, '-a', account], err => {
      resolve(!err)
    })
  })
}

/**
 * 那一项**在不在**，不取它的明文。
 *
 * 不带 `-w`：`security` 只读属性，不解密密码，于是不会弹「允许访问」授权框。
 * 自检要断言「真实的 agent-monitor / zcode-bigmodel 没被动过」，用这个就够了 ——
 * 为了一句断言去读用户真实 Key 的明文是不必要的（M4 复核 §7.4）。
 */
export function keychainItemExists(service: string, account: string): Promise<boolean> {
  return new Promise(resolve => {
    execFile('security', ['find-generic-password', '-s', service, '-a', account], err => {
      resolve(!err)
    })
  })
}
