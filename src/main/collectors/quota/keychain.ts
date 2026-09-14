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
