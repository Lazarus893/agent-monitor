/**
 * 与 DOM 无关的时间格式化 —— 单独一个模块是为了可测：
 * app.ts 在模块加载时就去拿 DOM 节点，vitest 的 node 环境里 import 不进来。
 */

/**
 * E 页（AIHOT）专用的短相对时间。
 *
 * 通用的 whenFmt 跨天会给出「9/13 02:34」，14px mono 下要 84px —— 这一行给不起。
 * AIHOT 的窗口本来就是 24 h，最长只需要「23 小时前」（约 56px），省下的宽度还给标题。
 * 这一条是 designer 2026-09-14 修 E 页时定的：在那之前时间和来源挤在同一个
 * overflow:hidden 的格子里，三条真实新闻的来源名都长到把时间整段吃掉。
 */
export function newsWhen(iso: string, ref: number): string {
  const d = new Date(iso)
  const diff = ref - d.getTime()
  if (!Number.isFinite(diff)) return ''
  if (diff < 60_000) return '刚刚'
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)} 小时前`
  return `${d.getMonth() + 1}/${d.getDate()}`
}
