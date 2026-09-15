/**
 * E 页「点开这条新闻」的那道闸门（brief-m0-v2 §8）。
 *
 * 这条链路上流动的是**来自网络的字符串**：AIHOT 返回的 `links.aihot`。
 * 它最终会走到 `shell.openExternal` —— 那是本项目唯一一个把外部输入交给操作系统的地方，
 * 所以校验写成独立的纯函数放在这里，能被单测正面打，而不是埋在 ipcMain 的闭包里
 * （连接窗口的 `validateKey` 是同一个理由，见 M4 复核 §1.7）。
 *
 * 分工：
 *   · 渲染层只发 `id`，从头到尾不持有链接；
 *   · `NewsCollector.linkFor(id)` 把 id 换成链接（只在主进程内存里）；
 *   · 这里做协议与域名校验；
 *   · 不过关就不开，记一行 WARN。**不回退到原文链接** —— 原文指向公众号 /
 *     substack / 随便哪个站，那正是白名单要挡的东西。
 */

/** 允许打开的域名。子域一并放行（`aihot.news` 放行 `www.aihot.news`）。 */
export const NEWS_HOSTS = ['aihot.news', 'aihot.virxact.com'] as const

/** 主机名在白名单里吗。精确相等，或者是白名单项的子域。 */
export function allowedNewsHost(host: string): boolean {
  const h = host.toLowerCase()
  return NEWS_HOSTS.some(d => h === d || h.endsWith(`.${d}`))
}

export type NewsLinkCheck =
  | { ok: true; url: string }
  | { ok: false; reason: 'missing' | 'unparsable' | 'protocol' | 'host' }

/**
 * 能不能打开这个链接。
 *
 * 只认 `https:` —— `http:` 也不行（明文跳转没有理由），
 * `javascript:` / `file:` / `data:` 这些更不用说，它们连不上白名单也过不了协议这关。
 */
export function checkNewsLink(raw: string | undefined): NewsLinkCheck {
  if (!raw) return { ok: false, reason: 'missing' }
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return { ok: false, reason: 'unparsable' }
  }
  if (u.protocol !== 'https:') return { ok: false, reason: 'protocol' }
  if (!allowedNewsHost(u.hostname)) return { ok: false, reason: 'host' }
  return { ok: true, url: u.toString() }
}

/** 条目 id 本身也是渲染层递过来的，先当不可信的看。 */
export const MAX_NEWS_ID = 64

export function validNewsId(raw: unknown): raw is string {
  /* 只挡控制字符，**不挡空格** —— 缺 id 时我们兜底生成的是
     `aihot:<序号>:<标题前 16 字>`，标题里本来就可能有空格。
     id 只当 Map 的键用，没有注入面；控制字符挡掉是为了日志干净。 */
  return typeof raw === 'string' && raw.length > 0 && raw.length <= MAX_NEWS_ID &&
    !/[\u0000-\u001f\u007f]/.test(raw)
}

/** 日志里的人话 */
export const REASON_TEXT: Record<Exclude<NewsLinkCheck, { ok: true }>['reason'], string> = {
  missing: '这条没有站内阅读页（或缓存回灌那一程还没抓到）',
  unparsable: '链接解析不出来',
  protocol: '协议不是 https',
  host: '域名不在白名单里'
}
