# M2 代码复核 · Agent Monitor（真实额度采集）

> reviewer 视角的独立复核，不改任何代码。
> 复核对象：`src/main/collectors/**`、`src/main/state.ts`、`src/renderer/app.ts` 的 M2 增量、`scripts/claude-statusline-tee.sh`、`scripts/install-claude-statusline.mjs`、`tests/collectors/**`、`tests/statusline-tee.test.ts`、`tests/fixtures/**`、`design/shots/m2/`。
> 参照：`docs/m2-brief.md`、`PLAN.md` §2.1/§2.3/§5/§6、`docs/review/m1-code-review.md`（已修的 5 条与仍开着的 4 条 P2 不重复）。
> 日期：2026-09-14。每条标 **严重度**（P0 阻塞 / P1 提交前必修 / P2 可择期）与**置信度**。
> 未跑 `pnpm dev` / `pnpm selftest`（会在副屏开窗口）。所有动态证据来自沙箱内复跑 collector 与 tee，见 §7。

---

## 0. 结论先行

**修完 4 条 P1 + 确认 1 条越界改动后可提交。没有 P0。**

机械验证已过：`pnpm test` **120/120**（428 ms，8 个文件）、`pnpm build` 退出码 0、无 error/warning、**零新增依赖**（`package.json` / `pnpm-lock.yaml` 均未改动）。

采集层的骨架是扎实的：三个 collector 的契约统一、`QuotaResult` 是判别联合、错误码不产文案（文案留在设计稿那一侧）、`mergeQuota` 我逐个转换跑了一遍**没有找到「error 覆盖成功数据」或反向的路径**（§3.1 有实证表）、Keychain 只走 `security find-generic-password -w` 且返回值不进日志/异常/快照、fixtures 里的邮箱已 `<redacted>`、两张 M2 截图里没有任何凭据。

问题集中在**「失败态怎么讲给用户听」和「安装脚本怎么动用户的真文件」**这两处——都在单测覆盖之外，也正是这块常亮副屏上用户唯一会盯着看的东西。其中两条（错误文案不分 agent、`no_statusline` 语义）executor 已自报，我把它们的**实际表现**测出来了，比自报的更严重一点：不是"文案不准"，是**每 5 分钟闪一次红**。

另外发现一处**超出简报范围的改动**：`~/.claude/settings.json` 已经被安装脚本改过了（§2.5）。

---

## 1. 安全与隐私

总体干净。逐条对照复核维度 1：

| 项 | 结论 | 证据 |
|---|---|---|
| Keychain 只经 `security find-generic-password` | ✅ | `keychain.ts:16-25`，全仓库只有这一处；`grep -rn "codexbar/config\|codex/config.toml\|credentials.json" src/` 零命中，PLAN §4「不碰明文 key 文件」守住了 |
| token 不进日志 / 异常 / 快照 / 截图 | ✅ | `keychain.ts:22` 明确 `if (err) return resolve(null)`——不把 `err.message`（含完整命令行）往外传；`logLine`（`scheduler.ts:47-52`）只出 `code` 与百分比；`design/shots/m2/*.png` 四张我逐张看过，只有数字、倒计时、文案 |
| codexbar 返回体里的 `accountEmail` | ✅ 解析器不取 | `codex.ts:74-80` 只取 `primary`/`secondary`/`loginMethod`；`tests/collectors/codex.test.ts:25` 专门钉了「解析结果里不含邮箱」；fixture 里已是 `<redacted>` |
| OAuth 请求头 | ✅ 正确且不多带 | `claude.ts:104-107`：`Authorization: Bearer <token>` + `anthropic-beta: oauth-2025-04-20`，没有 UA、没有账号标识 |
| 智谱请求头 | ✅ | `zcode.ts:81-84`：裸 Key 不加 Bearer（与 PLAN §2.1 一致），只多一个 `Accept-Language` |
| tee 写的文件权限 | ❌ **P1**，见 §1.1 | 实测 `-rw-r--r--`（0644），目录 `drwxr-xr-x`（0755） |
| 安装脚本备份 / 幂等 / 还原 | 🟡 基本正确，两处不严格，见 §1.2 / §1.3 | |
| settings.json 其余字段原样保留 | ✅ **实证通过** | 见 §1.4 |
| tee 对原命令的参数转义 | ❌ **P1**，见 §1.3 | |

### 1.1 P1 · tee 落盘的文件是 0644，且存了整份 payload（置信度：高，实测）

`scripts/claude-statusline-tee.sh:29-33`

```bash
mkdir -p "$dir" &&
printf '{"writtenAt":"%s","payload":%s}\n' "$ts" "$input" > "$out.tmp.$$" &&
mv -f "$out.tmp.$$" "$out"
```

没有 `umask 077`，也没有 `chmod`。沙箱实跑（`AGENT_MONITOR_DIR` 指向临时目录，用户真实 umask 022）：

```
drwxr-xr-x  .../dir
-rw-r--r--  .../dir/claude-ratelimits.json
```

落盘内容不是只有 `rate_limits`，是**整份 statusline JSON**。我用真实安装串跑了一遍，文件里确实带着：

```
文件里的顶层键: writtenAt,payload
payload 里含: cwd, transcript_path, session_id
```

也就是说，Claude Code 每一个会话的**工程绝对路径、transcript 文件路径、session id**（外加 `cost.total_cost_usd`、token 计数）每秒一次落到一个同机任何用户/任何进程都能读的文件里。不是凭据泄漏，但简报的复核维度写明了「应 0600」，而采集侧只需要 `payload.rate_limits`。

**修法**（两选一，都是一行）：
- 脚本开头加 `umask 077`，并把 `mkdir -p "$dir"` 换成 `mkdir -p "$dir" && chmod 700 "$dir"`；
- 更省的做法：`printf` 之后补 `chmod 600 "$out.tmp.$$"`（在 `mv` 之前，避免出现 0644 的可见窗口）。

顺带建议只落 `rate_limits` 那一段——不依赖 jq 的话，`case` 里做一次极简裁剪成本不低，那就至少把权限收掉。

**当前状态**：`~/.agent-monitor/` 已经以 0755 存在（19:14 创建），目录里暂时还是空的（§2.5）。改完脚本后要手工 `chmod 700 ~/.agent-monitor` 一次，脚本自己不会去修已存在目录的权限。

### 1.2 P2 · 安装脚本的几处不严格（置信度：高）

`scripts/install-claude-statusline.mjs`

1. `:52` `JSON.parse(text)` 没有 try/catch——用户的 settings.json 要是有尾逗号/注释，用户看到的是一条 Node 栈回溯而不是人话。上一行的 `readFileSync` 倒是包了。
2. `:67-72` 还原只认「第一个 ` -- `」，不校验前缀确实是 `bash "<TEE>" `。只要 `current.includes('claude-statusline-tee.sh')` 为真就动手。TEE 路径里出现 ` -- ` 的概率约等于零，但「严格还原」的判据应该是**前缀匹配**而不是**子串包含 + 找分隔符**。
3. `:59` 幂等判据是 `current.includes('claude-statusline-tee.sh')`——如果哪天换了文件名，旧包装会被当成"没装过"再包一层，套娃。判据建议用「以 `bash "<TEE 绝对路径>" -- ` 开头」。
4. `:85` 写回时**无条件补一个结尾换行**。实测（§1.4）用户原本的 settings.json 没有结尾换行，安装后多了一个。无害，但「只改一个字段」这句话严格说不成立。
5. 文件是 `-rw-r--r--` 但带 `#!/usr/bin/env node` shebang——文档里写的是 `node scripts/...`，那就不必有 shebang；要留 shebang 就补 `chmod +x`。（`claude-statusline-tee.sh` 是 0755，正确。）

### 1.3 P1 · 原命令被当成 argv 拼接，带环境变量前缀的 statusline 会被整条打掉（置信度：高，实测）

`install-claude-statusline.mjs:79`

```js
next = `bash ${JSON.stringify(TEE)} -- ${current}`
```

`current` 是一条**给 shell 的命令串**，但拼完之后由外层 shell 分词，tee 再用 `"$@"` 当 argv 执行（`claude-statusline-tee.sh:45` `printf '%s' "$input" | "$@"`）。于是原命令里凡是**只有 shell 认识、argv 不认识**的成分都会变味。沙箱逐条实测：

| 原命令形态 | 直接跑 | 包装后 | 结论 |
|---|---|---|---|
| `bash ./sl.sh`（用户当前就是这种） | `SL[{"a":1}]` | `SL[{"a":1}]` | ✅ |
| `bash "./my dir/sl.sh"`（路径含空格/引号） | `SL[{"a":1}]` | `SL[{"a":1}]` | ✅ 外层 shell 分词 + `"$@"` 保词，转义是安全的 |
| `bash ./sl.sh && printf TAIL` | `SL[...]TAIL` | `SL[...]TAIL` | 🟡 凑巧一致（`&&` 落在 tee 外面），但 `TAIL` 已经拿不到 stdin |
| `FOO=1 bash ./sl.sh` | `SL[{"a":1}]` | **stdout 空**，stderr：`line 45: FOO=1: command not found` | ❌ **statusline 变空白** |

第四行是真正的坑：Claude Code 的 statusline 会**整条变空**，而且失败信息只在 stderr（用户看不到），排查起来像是 Claude Code 自己坏了。同类还会挂的：以 `a; b`、`a | b`、`(a)`、`exec ...` 开头的命令。

**修法**：不要把原命令降级成 argv，交回给 shell：

```js
next = `bash ${JSON.stringify(TEE)} -- /bin/sh -c ${JSON.stringify(current)}`
```

（tee 那侧一个字都不用改：`"$@"` 就是 `/bin/sh -c '<原命令>'`。还原时相应地剥掉 `/bin/sh -c ` 这一层。）或者退一步：安装前检测 `current` 含 `[;&|(){}<>]` 或 `^\w+=` 时**拒绝安装**并提示手工包，至少不要静默把 statusline 打掉。

### 1.4 ✅ settings.json 其余字段确实原样保留（置信度：高，实证）

复核维度里专门问了「JSON 序列化会不会改动格式/顺序」。拿用户机上今天那次安装的备份与当前文件对比：

```
$ diff <(sed 's/"command":.*/<省略>/' settings.json.bak-20260914-191401) <(sed 's/"command":.*/<省略>/' settings.json)
31c31
< }
\ No newline at end of file
---
> }

$ node -e '…把两边 statusLine.command 都置成 "X" 再比…'
键顺序一致: true
其余内容一致: true
```

`detectIndent`（`:33-36`）从原文第一处 `\n<缩进>"` 取缩进这一招是对的——2 空格被正确识别，15 个顶层键的顺序、`permissions.allow` 数组、嵌套对象全部逐字节相同。唯一差异是 §1.2-4 说的那个结尾换行。

（要注意的边界没有出现但仍然存在：`JSON.stringify` 会把**形如整数的键**提到最前面重排，且会把原本压在一行的数组展开成多行。当前这份 settings.json 两种都没有。）

### 1.5 P2 · 两处小的安全面（置信度：中高）

1. **`security` 可能弹 Keychain 授权框**：`claude.ts:86` 读 `Claude Code-credentials`。dev 下 Electron 未签名，`security` 对非同签名调用方会弹系统授权对话框。当前本机 accessToken 是空串所以走不到深处，但一旦用户重新登录、token 非空，`~/.agent-monitor` 文件又缺失，这条路每 5 min 就可能弹一次框。M4 打包签名前记一笔。
2. **`MONITOR_FAKE_ERROR` 在打包后仍然有效**：`index.ts:111` `quota = SHOOT ? null : startQuota(store)`，而 `startQuota` 无条件读 `process.env.MONITOR_FAKE_ERROR`（`quota/index.ts:69`）。IPC 那条 `dev.forceError` 已被 `!app.isPackaged` 挡住（`index.ts:76`），env 这条没有。不是漏洞（只能让自己的面板显示假错误），但是生产产物里的一个调试开关，建议同样按 `app.isPackaged` 门控。
3. preload 无条件暴露 `dev`（现在多了 `forceError`）——M1 已记为 P2，此处不重复，只说明 M2 没有收窄它。

---

## 2. 正确性

### 2.1 P1 · Claude：tee 未装时每 5 分钟闪一次红色 401（置信度：高，有码序列 + 截图实证）

这是 executor 自报的两条已知问题的**合并后果**，实际表现比"文案不准"严重。

`claude.ts:165-173`：

```ts
if (this.lastOAuthAt && now - this.lastOAuthAt < this.gapMs) return null   // 被节流 → run() 给 no_statusline
this.lastOAuthAt = now
const token = await this.d.readToken()
if (!token) { this.gapMs = OAUTH_MIN_GAP_MS; return { ok: false, code: 'unauthorized' } }
```

`run` 末尾 `:151` `return { ok: false, code: oauth?.code ?? 'no_statusline', ...keep }`。

于是「文件不存在 + accessToken 是空串」（**本机此刻的真实状态**）下，15 s 一跳的码序列是：

```
CLAUDE 15s 码序列:
unauthorized×1 → no_statusline×19 → unauthorized×1 → no_statusline×19 → unauthorized×1 → no_statusline×4
```

（沙箱实跑 `ClaudeCollector` 45 轮 = 11 min 15 s，`readStatusline: () => null`、`readToken: () => null`。）

翻成屏上的样子：**每 5 分钟，Claude 那块瓦片会从灰色空态「statusline 未写入」跳成红锁头「额度接口 401」15 秒，再跳回去**。一块 24 小时常亮的副屏上，这是最糟的一类噪音——它规律地骗你"出事了"，而其实什么都没变。

两个成因各自也都是问题：

**(a) P1 · 文案按 code 不分 agent，Claude 的 401 让你去跑 `codex login`。**
`app.ts:59`：

```ts
unauthorized: { icon: 'lock', title: '额度接口 401', why: '登录令牌过期，跑 codex login 重新授权' },
```

这不是推演——executor 自己那张验收截图 `design/shots/m2/live-page-a.png` 上就印着：Claude Code 瓦片 → 「额度接口 401 / 登录令牌过期，跑 codex login 重新授权」。三个 agent 的下一步动作完全不同（`codex login` / `claude` 重新登录 / 补智谱 Key），`NOTICE_COPY` 的 key 必须从 `NoticeCode` 变成 `agent × code`，至少 `unauthorized` 与 `missing_key` 这两条要分。

**(b) P1 · `no_statusline` 只在"被节流"这一支返回，语义反了。**
`no_statusline` 的字面意思是"tee 还没把文件写出来"，而这恰恰是**文件缺失**那一支应该给的码；现在文件缺失反而给 `unauthorized`（因为它先去试了 OAuth），只有"刚试过、还没到下一次"才给 `no_statusline`。

**建议的修法**（一处判断，同时解掉 (b) 和闪烁）：把「文件在不在」与「兜底成不成」分成两个维度——

```ts
const hasFile = !!(file && file.windows.length)
// 文件从来没有过 = tee 还没装/还没写：无论兜底结果如何，这就是 no_statusline，
// OAuth 的失败只用来决定要不要退避，不上屏。
if (!hasFile && (oauth === null || !oauth.ok)) return { ok: false, code: 'no_statusline' }
```

这样 tee 未装时屏上稳定是「statusline 未写入」空态，一次都不会闪红；OAuth 真的成功了就照常出数字。

顺带 `no_statusline` 的 why 文案（`app.ts:56`「跑一次 claude 会话即可补上」）在**tee 没装**的前提下是错的——跑多少次会话都补不上。建议改成「跑一次 `node scripts/install-claude-statusline.mjs` 装上 statusline tee」。

**(c) P2 · 退避在这条路上被反复复位。** `scheduler.ts:119` 只在失败码属于 `BACKOFF_CODES` 时累加 failures，而 `no_statusline` 不在里面 → failures 每轮清零。所以 Claude 这条链实际是 15 s / 30 s 交替，不构成压力，但"连续失败指数退避"在这条最常见的路径上等于没生效。

### 2.2 ✅ 三家解析器对真实样本与畸形输入

逐项对照复核维度 2，结论是**这一块做得好**，只有一个排序问题（§2.3）。

| 检查项 | 结论 | 证据 |
|---|---|---|
| codexbar「噪音行 + JSON」 | ✅ | `codex.ts:26-37` 先整段试再从最后一行往前试；fixture `codex-usage.stdout.txt` 就是带两行 `[codex notify]` 的真实输出 |
| codexbar 找不到 | ✅ `missing_tool` | `codex.ts:105`/`:115`，**只有所有候选都 ENOENT 才算 missing_tool**，这个判据是对的 |
| codexbar 非零退出 | ✅ 先看 stdout 再看 stderr | `codex.ts:106-113`，注释写明了"部分 provider 失败时仍会打出可用的那一份" |
| codexbar 超时 | ✅ `network` | 由 `scheduler.ts:106-111` 的 race 兜底，abort 同时发出去让 `execFile` 收摊 |
| 空 / 非 JSON / 缺字段 | ✅ 不产半截窗口 | `codex.ts:63-69` 两个字段任一缺就整条丢弃；`tests/collectors/codex.test.ts:39` 钉住 |
| `resets_at` epoch 秒 / 毫秒 / ISO | ✅ 三种都对 | `types.ts:51-65`，用 1e12 当秒/毫秒分界；三个 fixture（ISO、epoch 秒、epoch 毫秒）各覆盖一种 |
| `used_percentage` / `utilization` 别名 | ✅ | `claude.ts:51` |
| tee 包装 `{writtenAt,payload}` / 裸 statusline / OAuth 正文三种载体 | ✅ 同一个解析器吃下 | `claude.ts:44-45` 两次"有就下钻，没有就当自己是" |
| 智谱 unit/number 映射 | ✅ `unit 3 && number 5 → 5h`、`unit 6 → 7d`、`TIME_LIMIT → 1mo` | `zcode.ts:37-53`；认不出的组合 `continue`，不臆造 label（`:39-40`），这条纪律很对 |
| 智谱 200 + 业务码非 200 | ✅ | `zcode.ts:62-69`，把鉴权失败从正文里捞出来 |
| 调度器抖动 / 不并发 / 退避 / 复位 | ✅ | `scheduler.ts:39-45`（±10%）、`:95` `inFlight` 闸 + `:129` 落地后才排下一次、`:119` 成功即复位；8 条单测覆盖 |
| Claude「超过 10 min 未更新」 | ✅ | `claude.ts:136-141`，`writtenAt` 缺失时 `age = Infinity` → 一律去刷新，这个降级是对的 |
| OAuth 最小间隔 5 min + 429 退避到 30 min | ✅ 真的实现了 | `claude.ts:165`（门）、`:184-186`（翻倍封顶 30 min）；`tests/collectors/claude.test.ts:105-122` 用"5 min 后不调、10 min 后才调"钉住 |

一个值得表扬的实现细节：`scheduler.ts:103-111` 的超时不是"abort 一下就完事"，而是 race 一个必定落地的结果。注释里写明了原因——collector 若不理会 signal，光 abort 会让这条链**永远停在 await 上，之后一次都不再采**。这是很多定时采集实现里真实存在的坑，这里主动堵掉了。

（对应的 P2：超时之后上一轮的 `run` promise 可能仍在跑，"不并发"是**逻辑上**保证的、不是**进程上**。注释已承认，成本可控。）

### 2.3 P2 · ZCode 的 windows 顺序依赖接口返回顺序，渲染层却假定 `windows[0]` 是 5h 窗（置信度：高，实测）

`zcode.ts:31-55` 按 `limits[]` 的数组顺序 push；`codex.ts:70-71` 则是显式 `push(primary,'5h')` 再 `push(secondary,'7d')`。两家不一致。

把 fixture 的 limits 前两项对调再解析：

```
倒序 limits → ["7d","5h"]
```

而渲染层两页都硬吃 `windows[0]`：

- `app.ts:264` A 页大数字 `const w5 = t.windows[0]`；
- `app.ts:300-302` B 页 `const w5 = t.windows[0]`，且 **`const start = new Date(w5.resetsAt).getTime() - WIN5H`** ——把 `windows[0]` 的重置时刻减 5 小时当作时间带起点。

所以智谱哪天调换返回顺序，屏上会出现「7 天窗的百分比被当成 5 小时窗的大数字」，B 页的时间带起点直接错 6 天多。同理，若某个档位只返回 `7d` + `1mo` 而没有 `5h`，B 页会用一个月度重置时刻去画一条 5 小时的带子。

**修法**：`parseZcode` 返回前按 `['5h','7d','1mo']` 排一次序（两行），或者让 `toTile` / `renderPageB` 按 `label === '5h'` 取窗口而不是按下标。前者更省。

### 2.4 P2 · `codeFromText` 的正则会误伤（置信度：中）

`types.ts:36-39` 的 `/401|unauthor|…|登录|鉴权|令牌/i` 会被**输出里任意位置**的 `401` 或「登录」命中。它只在 JSON 解析失败之后才跑（`codex.ts:52`、`:58`），触达面小；但 codexbar 未来若在失败时打一段带时间戳或数字 id 的中文提示，就可能把 `network` 误判成 `unauthorized`——而这两者的下一步动作完全相反（重新登录 vs 什么都别做）。建议把判据收成"整行以特征开头"或只看 stderr 的头两行。

### 2.5 P1（需确认）· `~/.claude/settings.json` 已经被改过了（置信度：高，实证）

简报「不要做」第 2 条：**「不修改 `~/.claude/settings.json`（只写安装脚本）」**；`scripts/install-claude-statusline.mjs` 的文件头也写着「**这个脚本不会被本项目自动执行**——由 lead 决定什么时候装」。

但本机现状是：

```
-rw-------  762  Sep 14 19:14  ~/.claude/settings.json
-rw-------  685  Sep 14 19:14  ~/.claude/settings.json.bak-20260914-191401     ← 安装脚本的时间戳格式
statusLine.command = bash "/Users/tonyye/Projects/Monitor/scripts/claude-statusline-tee.sh" -- bash ~/.claude/coralline/statusline.sh
```

安装脚本**已经在真实 settings.json 上跑过一次**（19:14）。

我**没有动它**（本轮复核不写 `~/.claude` 下任何文件）。客观评价这次改动本身：

- 备份在（`.bak-20260914-191401`），内容与当前文件除 `statusLine.command` 与结尾换行外**逐字节一致**（§1.4）；
- 文件权限没有退化（原 0600，`copyFileSync` + `writeFileSync` 覆盖写都保住了 0600）；
- 包装串我在沙箱里用**用户的真实命令串**跑了一遍：退出码 0、stdout 561 字节、与不包装时**逐字节相同**、stderr 空；
- 可一键还原：`node scripts/install-claude-statusline.mjs --uninstall`。

所以这次改动是良性且可逆的。但它超出了简报授权的范围，需要 lead 确认是不是自己装的；如果是 executor 自作主张装的，除了还原/保留这个决定之外，更该记一笔的是**"不要做"清单被越过了**这件事本身。

另外一个当下的事实：`~/.agent-monitor/` 目录在（19:14 创建），但**`claude-ratelimits.json` 至今不存在**——说明装好之后 Claude Code 还没有刷新过一次 statusline。因此简报验收 1「三块瓦片都显示真实数字」在 Claude 这一块**目前仍未被证实**，而且在文件出现之前屏上就是 §2.1 那个每 5 分钟闪一次红的样子。

---

## 3. 状态与渲染

### 3.1 ✅ `mergeQuota` 没有「error 覆盖成功数据」或反向的路径（置信度：高，实证）

沙箱把 `mergeQuota`（`state.ts:208-238`）的每种转换跑了一遍：

| 转换 | 结果 | 判断 |
|---|---|---|
| 首轮成功 | `windows=[18%]`、`updatedAt=采样时刻`、`plan=max`，**无 notice、无 stale** | ✅ |
| 成功 → `network` 失败 | `windows` 原样留着、`stale:true`、`notice={error,network}`、`status=offline`、**`updatedAt` 停在旧时刻** | ✅ 正是简报要的 |
| 失败 → 再成功 | `windows=[20%]`、**`stale` 与 `notice` 同时消失**、`status` 回 `idle` | ✅ 无残留 |
| 成功 → `missing_key` | `windows=[]`、`notice={empty,missing_key}`、无 stale | ✅ 清掉旧数字是对的（挂着过期数字在骗人） |
| 成功 → `no_statusline` | `windows` 留着 + `stale:true` + `notice={empty,no_statusline}` | ✅ |
| 首轮就 401 | `windows=[]`、`notice={error,unauthorized}`、无 stale | ✅ |

成功分支（`:209-216`）是**整条重建**而不是展开旧对象，所以 `notice`/`stale` 不可能漏带过来——这是这个函数最关键的一个写法选择，写对了。`plan` 用 `result.plan ?? prev.plan` 保留，也对（某些失败返回里没有档位）。

### 3.2 ✅ `missing_key` / `no_statusline` 是 empty 而非 error

`types.ts:25-32` 的 `ERROR_TONE` 把 `missing_key` / `missing_tool` / `no_statusline` 都映到 `'empty'`，`mergeQuota:226` 用它填 `notice.tone`，渲染层 `app.css:123` 只对 `[data-tone="error"]` 上红。ZCode 无 Key 时屏上是灰色「未连接 · 还没有智谱 API Key」，符合简报。

**P2**：`mergeQuota:227` 里 `status` 的判据是 `tone === 'error' || result.code === 'missing_key'` → `missing_tool` 和 `no_statusline` 保持 `idle`（身份点亮着）。「codexbar 没装」和「智谱没连」在用户眼里是同一件事，身份点却一亮一灭。建议统一成「没有窗口 ⇒ offline」。

### 3.3 ✅ stale 的表现符合简报，但只有 selftest 能验

`toTile:158` 的判据 `if (!w5 || (a.notice && !a.stale))` 是对的：**有数字 + stale 时不退成文案块**，走 `phase:'ok'` 并带上 `stale:{since,icon}`（`:170-173`）。A 页把"速度判语"那一格换成短形「59 分钟前」，B 页换成完整句「数据 23 小时前」，倒计时都留着（`app.ts:269-275`、`:300-306`）；`tickTiles`（`:418-420`）每秒重算。foot 图标切成 notice 的图标（`:243`），B 页身份点在 `status==='offline'` 时熄灭（`:287-288`，M2 新加的判据，对）。

这一路与简报「保留数字 + 标注」完全吻合。两个 P2：

1. `app.ts:303` stale 时给 `.b-verdict` 打的是 `data-tone="mute"`，但 `app.css:175-177` 只有 `over` / `error` / `attn` 三个规则——`mute` 在 CSS 里**没有对应规则**，靠 `.b-verdict` 基础色恰好就是 `var(--mute)` 才显示正确。能用，但是个悬空属性，将来有人改基础色就会静默走样。
2. stale 文案没有任何 aria 处理，屏幕阅读器上「18 %」和「数据 23 分钟前」是两段无关文本。这块屏本来就不是 a11y 场景，记一笔。

### 3.4 ✅ `forceError` 只在 dev 通道

主进程 `index.ts:76` 整个 `ipcMain.on(CH.dev, …)` 包在 `if (!app.isPackaged)` 里；`:82-90` 又对 `agent` 做了白名单校验，`setForcedError`（`quota/index.ts:30-35`）对 `code` 做了 `FORCEABLE` 白名单，非法值返回 false 且不 `kick`。链路是干净的。

两处 P2：`MONITOR_FAKE_ERROR` 环境变量没有同样门控（§1.5-2）；`dev.forceError` 没有调试栏按钮，只能从 devtools 或 selftest 调（简报只要求 API，可接受，但 `index.html` 的调试栏里其余四个开关都有按钮，这一个没有，是不一致）。

### 3.5 P2 · 一旦 dev 切过场景就再也回不到 live（置信度：高）

`state.ts:308` `setScene` 把 `this.mode = 'scene'`，而**没有任何一条路把它改回 `'live'`**（`grep -n "mode = 'live'" src/` 只有构造函数）。调试栏点一下场景按钮，真实采集就只写 `this.live` 不再上屏，直到重启进程。`tests/state.test.ts` 的最后一条用例把这个行为钉成了"特性"，但它缺一半：应该再有一个 `setLive()`（或让 `dev.setState('live')` 走回去）。dev-only，不阻塞。

### 3.6 P2 · live 模式下事件流是 M1 的假数据，屏上没有任何标记

`state.ts:264` live 的初始 state 用 `events: baseFeed()`。这是简报明说的（完成事件是 M3），但 `design/shots/m2/native-960x640/page-c.png` 上能看到后果：真实时钟 19:08，事件行写着「刚刚 / 16:03 / 14:32 / 16:32」，标题是 fixtures 里的中文任务名。面板此刻**一半真一半假且不可分辨**。M3 会覆盖掉，但在那之前如果要给用户看这块屏，建议 live 模式下把事件区渲染成 `feedNotice` 空态（「完成事件将在 M3 接入」），而不是拿假数据占位。

---

## 4. 测试

### 4.1 120 条覆盖了什么

| 文件 | 新增 | 覆盖 |
|---|---|---|
| `tests/collectors/codex.test.ts` | 8 | 噪音行 + JSON 的真实 stdout、**解析结果不含邮箱**、`extractJson` 两条路、无 `usage`、窗口字段残缺、429/401 文本映射、读不懂 → network、候选全 ENOENT → missing_tool |
| `tests/collectors/claude.test.ts` | 10 | 三种载体 × 三种 `resets_at` 编码、429 正文无窗口、文件新鲜不发网络、超 10 min 走 OAuth、429 留旧数字 + 自己的时刻、**429 退避翻倍的两个时间点**、空 token → unauthorized 且不发请求、被节流 → no_statusline、文件写了一半 |
| `tests/collectors/zcode.test.ts` | 9 | 三条 limits → 5h/7d/1mo + 毫秒转 ISO、认不出的 unit 跳过、无 data/limits → null、**真调 `security` 读一个不存在的 service**、missing_key、裸 Key 无 Bearer、401/429/500 映射、200 + 业务码错、请求抛出 → network |
| `tests/collectors/scheduler.test.ts` | 11 | 抖动区间、指数退避、封顶 10 min、日志两种形态且不含来源字段、启动即采、**不并发**、**超时兜底不卡死**、失败退避 + 成功复位、missing_* 不退避、stop 后不再排、onResult 抛出不断链 |
| `tests/statusline-tee.test.ts` | 8 | 纯 tee 模式、写盘失败不影响转交、退出码透传、**与真实 coralline 逐字节比对**；安装脚本装/幂等/卸/未装时卸 4 条（全在临时副本上） |
| `tests/state.test.ts` | +9 | live 默认骨架屏、首轮落地、失败留数字标 stale、失败自带旧窗口用文件时刻、首轮失败不标 stale、missing_key/missing_tool 清数字、恢复后 stale+notice 同消、scene 模式只记不推 |

质量高的地方：**每条用例的名字都是一句可核对的断言**（"accessToken 是空串（本机实测的状态）→ unauthorized，不发请求"），而不是 "should work"；429 退避那条卡在 `5 min + 1 s` 不调、`10 min + 1 s` 才调两个点上；`readKeychain` 那条**真的去调 `security`**（用一个不存在的 service），而不是 mock 掉——这条把"命令行拼对没有"也顺带证了。fixtures 全部脱敏且每份都带 `_note` 说明来源与构造理由。

### 4.2 漏了什么

**（a）P2 · 逐字节比对的覆盖面**
复核维度 4 专门问了这条。逐项回答：

- **是否在副本上跑？** 不是——`tests/statusline-tee.test.ts:19`/`:84-85` 直接执行用户的 `~/.claude/coralline/statusline.sh`。**是只读执行**（不改它），但 `pnpm test` 因此依赖用户主目录的状态；`:30` 的 `canRunCoralline` 在缺 jq 或缺该文件时**静默 skip**，CI 上会变成一条永远绿的空用例。建议：把 statusline.sh 复制进临时目录再跑（同时解掉"依赖真文件"和"静默 skip"两件事），或者至少在 skip 时 `console.warn` 出声。
- **是否覆盖 emoji / ANSI？** **没有**。本机实跑这条用例确实通过了（`direct.bin` 与 `teed.bin` 各 561 字节、`cmp` 相同、内容含 ANSI 转义），但那份输出里**没有一个非 ASCII 字节**（`VL_CLOCK=off` + 样本里模型名是 `Sample`）。我另外构造了一条含 `\033[38;5;208m`、CJK、`🚀`、`│`、`✔`、字面 `%` 的输出单独验过：**逐字节相同**。所以 tee 本身是安全的，缺的是**用例**——建议加一条不依赖 coralline 的固定用例（自带一个打 emoji/ANSI 的小脚本），把这条性质钉死。

**（b）P2 · 采集层与渲染层之间没有一条用例**
`mergeQuota` 有 9 条，`toTile` 有 0 条。§2.1 那个"每 5 分钟闪一次红"和 §3.3 的 stale 渲染，**都在单测的盲区里**——前者要把 `ClaudeCollector` 连续跑多轮才看得出来（我是在沙箱里手搓的），后者只有 `pnpm selftest` 能验。M1 复核就建议过加一个 jsdom 的 `tests/render.test.ts`，M2 的 stale 分支让这条建议更急：一条「`AgentState{windows, notice, stale} → toTile → phase==='ok' 且带 stale`」的用例只要五行。

**（c）P2 · 没被覆盖的具体点**
- `Scheduler.kick`（`scheduler.ts:76-83`）零覆盖——`forceError` 的即时生效全靠它。
- `setForcedError` / `applyFakeErrorEnv`（`quota/index.ts:30-47`）零覆盖，后者的解析（`agent:code` 与裸 `code` 两种形态）是纯字符串逻辑，最该配用例。
- `parseZcode` 的 windows 顺序（§2.3）——现有用例只喂正序 fixture。
- `collectCodex` 的"第一个候选 ENOENT、第二个成功"这条**实际上线要走的路**没有用例（只有"全都不存在"）。
- 安装脚本：没有「原文件无结尾换行」「原命令含 shell 操作符」「settings.json 不是合法 JSON」三种输入的用例——正是 §1.2 / §1.3 两条问题所在的地方。

---

## 5. 工程

**对的地方**
- **零新增依赖**：`git status` 里 `package.json` 与 `pnpm-lock.yaml` 都没动，三个 collector 全部用 Node 内置（`node:child_process`、`node:fs/promises`、全局 `fetch`）。符合简报。
- 日志格式统一且与简报逐字对齐：`[quota:codex] ok 5h=22% 7d=7% in 812ms` / `[quota:zcode] error network in 15001ms`（`scheduler.ts:47-52`）。失败带旧数字时多一段 `kept 5h=22% stale`，是对简报的合理增强。
- 无残留调试代码：`grep -rn "TODO|FIXME|XXX|debugger|console.debug" src/ scripts/ tests/` **零命中**；`console.*` 共 20 处，全部是主进程落位日志、采集日志、shoot/selftest 进度与安装脚本的人话输出，都该留。
- `claude-statusline-tee.sh` 是 0755 可执行；tee 的三条硬要求（stdout 不脏、写盘失败不影响原命令、退出码透传）在脚本头写成了注释，并且**三条各有一条用例**。
- `selftest.ts` 的 M2 增量思路对：不是读内部状态，而是**当场再采一次**跟屏上的数字对账（`:194-209`），并且用 `dev.forceError` 走**与真实失败同一条**映射 + 合并路径来演练断网/缺 Key（`:224-259`），不动系统网络也不动真 Keychain 项。stale 文案的两页溢出量测（`:241-251`）是从 M1 那套 `OVERFLOW_PROBE` 延续下来的，好习惯。

**P2 清单**
1. `install-claude-statusline.mjs` 有 shebang 但不可执行（§1.2-5）。
2. `types.ts:22` 注释说 `plan`「目前只进日志」，但 `logLine` 从不打印 plan，而它**会**经 IPC 进渲染层的 `AgentState`。注释与实现对不上，二选一改掉。
3. `zcode.ts:44-45` 用 `toPercent()` 去转 `currentValue` / `usage` 这两个**计数**（19 / 1000）。函数本身做的是 `Math.max(0, Math.round())`，结果正确，但名字在说谎；将来有人给 `toPercent` 加个 `Math.min(100, …)` 就会把 1000 截成 100。
4. `design/shots/m2/` 下 4 张图已生成但**未进 git**（untracked）。M1 的 28 张是提交了的；M2 这批要么一起提交（我逐张看过，无凭据），要么写进 `.gitignore` 并在汇报里说明。
5. `selftest.ts:311` 把原生 960×640 的两张图从 `m1/native-960x640/page-{a,c}-populated.png` 改名到 `m2/native-960x640/page-{a,c}.png`，理由（live 模式复现不出 fixtures 那一帧）写在注释里，成立；但 M1 目录下那两张旧图还在，两处并存时要注意别拿错来对账。

---

## 6. 剩余 P0 / P1

| # | 严重度 | 位置 | 一句话 |
|---|---|---|---|
| 1 | **P1** | `src/main/collectors/quota/claude.ts:151`、`:165-173` | tee 未装 + 无 token 时，码序列是 `unauthorized×1 → no_statusline×19` 循环 → **Claude 瓦片每 5 分钟闪 15 秒红色 401**。把「文件从来没有过」直接判成 `no_statusline`，OAuth 的失败只用于退避、不上屏。 |
| 2 | **P1** | `src/renderer/app.ts:56`、`:59` | `NOTICE_COPY` 按 code 不分 agent：Claude 的 401 让用户「跑 codex login」（`design/shots/m2/live-page-a.png` 上就印着）；`no_statusline` 的「跑一次 claude 会话即可补上」在 tee 没装时是错的。至少 `unauthorized` / `missing_key` / `no_statusline` 三条要按 agent 分。 |
| 3 | **P1** | `scripts/claude-statusline-tee.sh:29-33` | 落盘文件 0644、目录 0755，且存的是**整份 payload**（含 `cwd` / `transcript_path` / `session_id`）。加 `umask 077` + `chmod 700 "$dir"`，或 `mv` 前 `chmod 600`；已存在的 `~/.agent-monitor` 需手工改一次。 |
| 4 | **P1** | `scripts/install-claude-statusline.mjs:79` + `claude-statusline-tee.sh:45` | 原命令被当 argv 拼接：`FOO=1 cmd` 形态的 statusline 会**整条变空白**（实测 `line 45: FOO=1: command not found`）。改成 `-- /bin/sh -c <JSON.stringify(原命令)>`，或检测到 shell 操作符时拒装。 |
| 5 | **P1（需确认）** | `~/.claude/settings.json` | 安装脚本**已经在真实文件上跑过**（备份 `.bak-20260914-191401`），超出简报「不要做」第 2 条。改动本身良性可逆（其余字段实证逐字节一致、权限未退化、输出逐字节一致），但需 lead 确认是否授意；另：装完至今 `~/.agent-monitor/claude-ratelimits.json` 仍不存在，验收 1 的 Claude 那一块尚未被证实。 |

P2 共 **17** 条，分散在 §1.2（5 小项）、§1.5（3）、§2.1c、§2.3、§2.4、§3.2、§3.3（2）、§3.5、§3.6、§4.2（3 组）、§5（5 小项）。不阻塞提交，建议把 §2.3（ZCode 窗口排序）和 §4.2b（渲染层零测试）放在 M3 开工前——前者是接真实接口后最可能"数字看着对、位置全错"的一处，后者是 §2.1 这类问题下次还能不能自己冒出来的分界线。

---

## 7. 本轮实际执行的命令

```
pnpm test    → Test Files 8 passed (8) · Tests 120 passed (120) · 428ms · exit 0
pnpm build   → tsc(node) + tsc(web) + electron-vite build · exit 0 · 无 error/warning

# 沙箱复跑 collector（vitest 指向 scratchpad 的临时配置，不动 tests/）
ClaudeCollector 45 轮 × 15 s，file=null / token=null
             → unauthorized×1 → no_statusline×19 → unauthorized×1 → …（§2.1）
mergeQuota 六种转换逐个打印                                           （§3.1 表）
parseZcode(limits 倒序)                                → ["7d","5h"]  （§2.3）

# tee（AGENT_MONITOR_DIR 一律指向 scratchpad，不写 ~/.agent-monitor）
落盘权限                                   → -rw-r--r-- / drwxr-xr-x  （§1.1）
emoji + ANSI + CJK + 字面 % 的输出 vs 直连  → cmp 相同                 （§4.2a）
真实 coralline vs 经 tee（VL_CLOCK=off）    → 561/561 字节 cmp 相同
用户真实安装串端到端跑一遍                  → exit 0 · stderr 空 · 文件含 cwd/transcript_path/session_id
`FOO=1 cmd` / `a && b` / 含空格路径 三种原命令形态     （§1.3 表）

# 只读检查
diff settings.json.bak-20260914-191401 vs settings.json → 仅 command + 结尾换行（§1.4）
md5 / 目视 design/shots/m2/*.png（4 张）                 → 无凭据，live-page-a 印着「跑 codex login」
grep 依赖 / TODO / debugger / 凭据字样                   → 零新增依赖、零残留、零硬编码凭据
security find-generic-password -s agent-monitor …（只查存在性）→ 存在
```

未执行（按指令）：`pnpm dev`、`pnpm selftest`、`pnpm shoot`；未写 `src/` `scripts/` `tests/` `design/` 与 `~/.claude` 下任何文件；未 commit。

---

## 8. 验收表（对照 `docs/m2-brief.md` §验收）

| # | 项 | 状态 | 证据 |
|---|---|---|---|
| 1 | 60 s 内三块瓦片显示真实数字与倒计时；三条 `[quota:*] ok` | 🟡 **2/3** | `live-page-a.png`：Codex 1% / 2h57m、ZCode 6% / 2h47m 都是真数字；**Claude 是红色 401**。日志需实跑确认。 |
| 2 | 数字与 codexbar / Claude `/usage` / 智谱控制台一致 | 🟡 **机制到位，未独立复验** | `selftest.ts:194-209` 当场再采一次做对账，设计正确；本轮没跑 selftest（会开窗口）。Claude 侧因 §2.5 的文件缺失无从对账。 |
| 3 | 断网 30 s → 保留数字标 stale，恢复后自动回来 | 🟡 **逻辑已验，实机未验** | `mergeQuota` 六种转换实证通过（§3.1）；`selftest.ts:236-259` 用 `forceError` 走同一条路演练。真断网未做。 |
| 4 | 删 Keychain ZCode 项 → 显示「未连接」 | ✅ **逻辑已验** | `zcode.ts:101` → `missing_key` → `ERROR_TONE='empty'` → `NOTICE_COPY.missing_key='未连接'`；`tests/collectors/zcode.test.ts:58`、`tests/state.test.ts` 两条覆盖；未动真实 Keychain 项（已确认该项存在）。 |
| 5 | `pnpm test` / `pnpm build` 通过；无凭据进日志、截图、仓库 | ✅ **通过** | 120/120、build exit 0；截图 4 张目视 + grep 全仓库无凭据；fixtures 里邮箱已 `<redacted>`。**唯一的例外是 §1.1：0644 的本地文件里有 cwd / transcript_path / session_id**——不在仓库里，但也不该是 world-readable。 |

---

## 9. 结论

**P0 = 0 · P1 = 5（其中 1 条是待确认的越界改动）· P2 = 17。**

**修完 4 条 P1（§6 的 1–4）并就第 5 条与 lead 确认后可提交。**

这一层的骨架（契约、调度、合并、脱敏）质量在平均线之上，`scheduler` 的超时兜底和 `mergeQuota` 的整条重建这两个写法尤其值得保留。要修的四条全部集中在**「东西没接上的时候，这块屏对用户说什么、以及怎么替用户动他的真配置」**——而这正好是简报里 error / empty 态被反复强调的那一半。

---

## Lead 批注（2026-09-14）

- P1-⑤「`~/.claude/settings.json` 已被安装脚本改动」：是 lead 于 19:14 亲自运行 `node scripts/install-claude-statusline.mjs` 所致，已备份到 `settings.json.bak-20260914-191401`，装前后 statusline 输出经同一样例逐字节比对相同。此项为授意行为，不计入 executor 越界；其余 4 条 P1 与 P2 交作者 lane 修复。

---

## 10. 复验（2026-09-14 19:45，executor 修复后）

只复核不改码。逐条核对 §6 的 5 条，外加机械验证、`~/.agent-monitor` 的权限与落盘字段、P2 抽验。

### 10.1 五条逐条核对

| # | 原问题 | 落实情况 | 证据 |
|---|---|---|---|
| 1 | **P1** Claude 每 5 min 闪一次红 401 | ✅ **已修，且修得比我建议的更完整** | `claude.ts:165-193` 把「文件有无」与「兜底成不成」彻底拆开：`hasFile` 为假时 `code: this.lastOAuthCode ?? 'no_statusline'`；新增的 `lastOAuthCode`（`:147`、`:220-224` 的 `settle()`）**记住上一次真的调过 OAuth 的结论并在两次调用之间复述它**——这正是闪烁的根因（两次之间回落到默认码）。另一处关键收敛：没有可用令牌时 `tryOAuth` 返回 `null` 且**不记时间、不记结论**（`:213-215`），"兜底这条路本来就不存在"不再被当成一次 401。沙箱重跑三种场景各 45 轮（11 min 15 s）：<br>`无文件+无令牌 → no_statusline×45`<br>`无文件+401 → unauthorized×45`<br>`无文件+429 → rate_limited×45`<br>**三条都是单一码，一次跳变都没有**（修复前是 `unauthorized×1 → no_statusline×19` 循环）。 |
| 2 | **P1** 文案按 code 不分 agent | ✅ **已修** | `app.ts:59-69` 的 `NOTICE_COPY` 退成中性底稿（`unauthorized` 的 why 改为「登录令牌过期，需要重新授权」，不再点名 codex）；新增 `AGENT_COPY`（`:72-85`）按 `(agent, code)` 覆盖：codex→`codex login`、claude→`claude login`、zcode→「Key 失效，换一枚智谱 Key」，`missing_tool`/`missing_key`/`rate_limited` 也各自特化。合并点 `:92` `{ ...NOTICE_COPY[code], ...AGENT_COPY[agent]?.[code] }`，调用处 `:191` 传了 `a.id`。用 `Partial<Record<…>>` 只覆盖差异字段、不重复底稿，这个结构是对的。 |
| 3 | **P1** 落盘 0644 + 整份 payload | ✅ **已修，实证** | `claude-statusline-tee.sh:31-49` 整段挪进子 shell 并 `umask 077`（`:32`，不会漏给原命令）；`:34-37` 用 jq 只取 `rate_limits` 与 `model.display_name`，**没有 jq 就什么都不写**（`:33`）而不是退回写整份；`:44` `chmod 700 "$dir"` 连早先 0755 建出来的目录一起收紧；`:47` 在 `mv` **之前** `chmod 600`，不留 0644 的可见窗口。本机实测：<br>`drwx------ ~/.agent-monitor`、`-rw------- claude-ratelimits.json`<br>顶层键 `writtenAt,payload`；payload 键 `rate_limits,model`；`model` 只有 `display_name`；`rate_limits` 只有 `five_hour`/`seven_day`，每个只有 `used_percentage`/`resets_at`。<br>**`cwd` / `transcript_path` / `session_id` / `cost` / `workspace` / `context_window` 逐个检查：全部不在。** |
| 4 | **P1** 原命令被当 argv 拼接 | ✅ **已修，实证** | `install-claude-statusline.mjs:28-30` 改为 `bash "<TEE>" -- /bin/sh -c <JSON.stringify(原命令)>`；`unwrap()`（`:33-48`）用**锚定的正则**认包装（解掉了我记的 §1.2-2/3 那两条「子串包含」判据），新旧两种格式都认得、旧的会就地重写。沙箱四种原命令形态逐一对比"直接跑 vs 包装后"：<br>`bash ./sl.sh` ✅ · **`FOO=1 bash ./sl.sh` ✅**（修复前 stdout 空 + `line 45: FOO=1: command not found`）· `a && printf TAIL` ✅ · `a \| tr a-z A-Z` ✅<br>真实 coralline 经新包装 → **561/561 字节 `cmp` 相同**。 |
| 5 | **P1（需确认）** `~/.claude/settings.json` 被改 | 🟡 **coordinator 已知悉；改动本身复验通过** | 19:34 又重写了一次（备份 `.bak-20260914-193421`），当前形态是新的 `/bin/sh -c` 包装。复验：除 `statusLine.command` 外与备份**文本逐字节一致**；权限仍是 0600；tee 已在真实链路上跑通（文件 19:41 落盘，见 #3）。**遗留 1 字节**：19:14 那次安装给原本没有结尾换行的文件补了一个 `\n`，新版虽已改成"沿用原文件"（`:110`），但沿用的是已被补过的现状——`--uninstall` 之后仍会比 M2 之前多一个字节。无害，记一笔。仍需 lead 对"装不装"做最终确认。 |

### 10.2 机械验证

```
pnpm test   → Test Files 9 passed (9) · Tests 146 passed (146) · 959ms · exit 0   （120 → 146，+26）
pnpm build  → tsc(node) + tsc(web) + electron-vite build · exit 0 · 无 error/warning
```

新增 `tests/collectors/runner.test.ts`（`Scheduler.kick` / `setForcedError` / `applyFakeErrorEnv`，补上了 §4.2c 的两处零覆盖）；`tests/statusline-tee.test.ts` 长出四条关键用例：**只落两个字段不落 cwd/transcript_path/session_id**（`:74`）、**目录 0700 文件 0600 且 0755 会被收紧**（`:86`）、**ANSI/emoji/CJK/字面 % 逐字节穿过 tee**（`:99`，自带脚本，不依赖 coralline）、coralline 比对改成**在副本上跑**且 skip 时 `console.warn` 出声（`:33`、`:126`）——§4.2a 我提的三点全部落实。

安装脚本沙箱回归（临时副本，不碰真文件）：装 → 幂等（第二次输出「已经是最新的包装形态，未改动」且不写文件）→ 卸（`FOO=1 bash ~/x.sh` **逐字还原**）；旧格式就地重写成新格式再卸也能还原；非法 JSON 报人话并 `exit 1`、不改动任何东西；无结尾换行的文件卸完仍无结尾换行。

### 10.3 P2 抽验

原 17 条中抽查 11 条，**10 条属实已修**：ZCode 窗口排序（倒序 limits 现在解出 `["5h","7d"]`，§2.3）、`codeFromText` 正则收窄成 `\b401\b` + 「令牌…过期」这类搭配（§2.4）、`missing_tool`/`no_statusline` 统一按「没有数字 ⇒ offline」（`state.ts:228`，§3.2）、`data-tone="mute"` 补上 CSS 规则（`app.css:176`，§3.3）、新增 `Store.setLive()`（`:314`，§3.5）、`MONITOR_FAKE_ERROR` 按 `!app.isPackaged` 门控（`index.ts:114`，§1.5-2）、`toInt` 取代 `toPercent` 转计数（`zcode.ts:44`，§5-3）、安装脚本补 `JSON.parse` try/catch 与可执行位、结尾换行沿用原文件（§1.2）、`plan` 那条对不上的注释已删（§5-2）。

**仍开着的（全部 P2，不阻塞）**：
1. §3.6 live 模式的事件流仍是 M1 fixtures 的假数据且屏上无标记（`state.ts:265`）——M3 会覆盖，但在那之前面板一半真一半假。
2. §5-4 `design/shots/m2/` 仍是 untracked，既没进 git 也没进 `.gitignore`。
3. §5-5 M1 的 `native-960x640/page-{a,c}-populated.png` 与 M2 的新图并存，对账时容易拿错。
4. §1.5-1 `security` 在未签名 Electron 下可能弹 Keychain 授权框（M4 签名前复议）。

**新发现 2 条（均 P2）**：
5. `install-claude-statusline.mjs` 的备份戳只到秒（`:64-68`）。同一秒内连做两次操作（装完立刻卸，脚本化跑回归时很常见）会**写到同一个备份名并覆盖**——沙箱里四次操作只留下一个 `.bak-`。加毫秒或撞名时加后缀即可。
6. **工作区已经混进了 M2 之外的在途改动**：`design/tokens.css`、`design/variations.html`、`src/renderer/app.css` 被改，新增 `design/brief-m0-v2.md`、`design/fixtures/{news,usage}.json`、`docs/m3-brief.md`、`docs/m3b-brief.md`。这些不属于 M2（看起来是 M0-v2 与 M3 两条线并行落下的），本轮**未纳入复核范围**。提交 M2 时**必须按文件圈定范围**，不能 `git commit -a`。

### 10.4 结论

**P0 = 0 · P1 = 0（5 条全部落实，第 5 条转为 lead 的一次确认）· P2 仍开 6 条。**

**可提交。** 两个前提：
1. 提交范围按文件圈定，只含 M2 的那些路径（§10.3-6）；
2. lead 就 `~/.claude/settings.json` 已被安装脚本改过这件事明确表态（保留 / `--uninstall` 还原）。

四条 P1 的修法都没有停在"把症状盖住"那一层：#1 补的是「两次采样之间的结论要有人记着」这个缺失的状态，#2 改的是文案表的**键**而不是往 why 里塞一句"视 agent 而定"，#3 从"收权限"进到"干脆不落那些字段"，#4 把原命令整条交回 shell 而不是逐个转义特例。这四处都比我建议的修法更彻底一点。
