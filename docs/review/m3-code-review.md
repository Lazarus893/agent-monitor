# M3 / M3b 代码复核

> 范围：`src/main/collectors/events/*`、`src/main/collectors/{usage,news,topmodel,v2}.ts`、`src/main/config.ts`、`src/shared/scale.ts`、`scripts/claude-hook.sh`、`scripts/install-claude-hooks.mjs`，以及它们在 `state.ts` / `index.ts` / `shortcuts.ts` / 渲染层的接线。
> 参照：`docs/m3-brief.md`（含文末 panelX 附加节）、`docs/m3b-brief.md`、`docs/review/m1-code-review.md`、`docs/review/m2-code-review.md`（仍开着的 6 条 P2 不重复，只在本轮**新代码里原样重现**时才记）。
> 日期：2026-09-14。每条标 **严重度**（P0 阻塞 / P1 提交前必修 / P2 可择期）与**置信度**，尽量给实证。
> 复核者只读不改；下文所有 repro 跑在临时目录里，仓库工作区未被本次复核改动。

---

## 0. 结论先说

**P0 = 0 · P1 = 6（其中 1 条是待 lead 确认的越界改动、1 条是另一条 lane 的在途改动）· P2 = 19。**

**修完 5 条 P1（§7 的 1–5）并就第 6 条与 lead 确认后可提交。**

`pnpm test` ✅ **266/266**（18 文件，1.7 s）、`pnpm build` ✅ **exit 0**（`tsc --noEmit` ×2 + `electron-vite build`）。
注：executor 汇报时是 259 条，复核期间另一条 lane 又加了 7 条并改了 `src/shared/scale.ts`，见 P1-④。

这一轮的骨架是对的，而且有几处判断明显比简报更硬：
- **去重 / 收束 / 未读判定 / 排序**四件事全部收进 `feed.ts` 一层，三家 collector 只负责"我这儿发生了一件事"。这是 M3 最容易散架的地方，它没散。
- **`booted` 只有一处**（`events/index.ts:56`），三家 `start()` 全部 await 完才翻 true。"回灌不响铃"这条不变量因此只有一个开关，而不是三家各自小心。
- **不装 chokidar**（简报点名要的依赖）——`codex.ts:26-30` 写清了理由（本轮网络只许回环 + 额度接口 + aihot），改用 `fs.watch(recursive)` + 3 s 兜底扫描。`package.json` / `pnpm-lock.yaml` **零 diff**，`node_modules` 仍只有 7 个 devDeps。这是对的取舍。
- **渲染层第一次吃真实外部文本**（Codex 的用户 prompt、Claude 的 transcript、ZCode 的任务标题），全部经 `esc()`（`app.ts:161`）进 innerHTML 模板，属性一律双引号，`index.html:5` 的 CSP 是 `default-src 'none'`。这一道做对了，见 §1.5。

六条 P1 里有三条的共同形状是**"跨两次生命周期才暴露"**：退出再进来（①）、重开 app（②）、隔天再 resume（③）。三条都不在 266 条用例的射程里，因为用例全是单进程内的往返。这是本轮测试最实在的缺口，见 §6。

---

## 1. hook 服务器的安全边界

先把做对的列清楚，这一节整体是**本轮质量最高的一块**：

| 简报要求 | 结论 | 证据 |
|---|---|---|
| 只绑回环 | ✅ | `claude.ts:29` `HOOK_HOST = '127.0.0.1'`，`:238` `server.listen(port, HOOK_HOST)`，无第二个 listen |
| token 定长比较 | ✅ | `claude.ts:57-62` 先比长度再 `timingSafeEqual`；长度不同直接返回 false 不抛 |
| token 文件 0600 / 目录 0700 | ✅ 实测 | `ls -l ~/.agent-monitor/` → `-rw------- hook-token`、`drwx------ .`；`claude.ts:46-50` 显式 `mode: 0o600` + `chmodSync(dir, 0o700)` |
| token 随机性 | ✅ | `randomBytes(24)` = 192 bit，hex 48 字符。够 |
| body ≤ 64 KB | ✅ | `claude.ts:272-278` 边收边计数，超了立刻 break |
| Content-Type 校验 | ✅ | `claude.ts:269` 必含 `application/json` |
| JSON 解析异常 | ✅ | `claude.ts:281-285` try/catch → 400 |
| 浏览器页面能否伪造 | ✅ **进不来** | 服务器**从不回任何 `Access-Control-Allow-Origin`**，`OPTIONS` 走 `req.method !== 'POST'` → 404。而 `X-Monitor-Token` 是自定义头、`application/json` 也不是 CORS 安全列表值——**两个条件各自都强制预检**，预检拿不到 ACAO 就被浏览器掐死 |
| hook 脚本读不到 token | ✅ | `claude-hook.sh:17-20` `[ -r ]` / 空串 → `exit 0` 静默，不报错不重试 |
| 先应答再干活 | ✅ | `claude.ts:288-294` `end(204)` 之后才 `await this.ingest()`——hook 是同步挡在 Claude 前面的，这个顺序很重要 |

下面是发现的问题。

### 1.1 P2 · token 通过 `curl -H` 传，落在 `ps` 的 argv 里（置信度：高）

`claude-hook.sh:27-31` 把 token 拼进命令行参数。macOS 的 `ps` 默认可以看到**其它用户**进程的完整 argv，于是"token 挡住本机伪造"这条防线对另一个本地用户是失效的。

需要说清楚的是**它并没有比现状更糟**：token 文件本身是 0600，对**同一个用户**的任意进程本来就是敞开的——同用户进程直接 `cat` 就行，根本不用看 `ps`。所以这条只影响"多用户 Mac 上的另一个用户"这一个场景。

改法很轻：`curl -H @<(printf ...)` 或 `--config -` 从 stdin 喂 header。

### 1.2 P2 · hook 脚本没有 `--noproxy '*'`（置信度：高，当前未触发）

`claude-hook.sh:28` 的 curl 走默认代理解析。设了 `ALL_PROXY` / `http_proxy` 而 `no_proxy` 没带 `127.0.0.1` 的机器上，**整份 hook payload（含 `cwd`、`session_id`、`transcript_path`）会被发给代理**。这正是简报"不读凭据、网络只允许回环"想挡住的那类外流。

本机当前实测 `env | grep -i proxy` 为空、`~/.zshrc` 无代理设置，所以**现在不触发**。但开发机装代理是常态，加一个 `--noproxy '*'` 是零成本的。

### 1.3 P2 · `ensureToken` 重写既有文件时 0600 不生效（置信度：高）

`claude.ts:41-52`：只有 `readFileSync` 失败或读到空串才生成。走到 `writeFileSync(file, token, { mode: 0o600 })` 时，**如果文件已存在（比如被截断成 0 字节），Node 的 `mode` 只在创建时使用**，既有权限原样保留。同理，读到一个**已经是 0644 的** token 文件时，代码直接采信、不校验权限。

窄，但修起来就是读成功之后补一次 `chmodSync(file, 0o600)`。

### 1.4 P2 · 慢连接与 Host 校验（置信度：中高）

- 没有设 `server.requestTimeout` / `headersTimeout` / `maxConnections`，靠 Node 默认（headers 60 s、request 300 s）。不会被拖死，但 300 s 对一个只收 <64 KB JSON 的端点太宽。
- 没有 Host 头校验。DNS rebinding 的主路径已经被 token 挡死（攻击者猜不到 48 位十六进制），这条只是纵深防御，可以不做，但值得在注释里留一句"为什么不做"。
- `claude.ts:279` 超限时 `req.destroy()` **在** `end(413)` **之前**——socket 先被销毁，413 大概率发不出去，客户端看到的是连接重置。用例 `超大 body → 413` 能过是因为它断言的是 curl/undici 那侧的观测，实际行为要看时序。先 `end(413)` 再 `destroy()` 更稳。

### 1.5 ✅ 渲染层 XSS：本轮第一次喂真实外部文本，这一道做对了

M1/M2 的事件流是 fixtures，M3 开始喂的是**用户能写的任意文本**：Codex 的首条 prompt、Claude transcript 的 summary、ZCode 的任务标题。而 `app.ts` 大量用 innerHTML 模板（`:337/:366/:434/:448/:470`）。

逐个核过：`rowHTML`（`:413-427`）与 `renderPageAttn`（`:470-477`）里**每一处外部文本都过 `esc()`**——`it.title`、`it.summary`、`it.id`、`it.at`、`it.startedAt`、`t.topModel`、`w5.resetsAt`、`t.stale.since` 全部包了。`esc`（`:161-162`）转 `& < > "`，不转 `'`，而模板里的属性**一律双引号**，所以不转单引号是安全的。未转义的只有 `a.color` / `it.kind` / `m.tone` 三类，全部来自静态表或已被 `persist.parse`（`:37`）收窄到四个字面量的枚举。

配合 `contextIsolation: true` / `nodeIntegration: false`（`window.ts:70-71`）与 `default-src 'none'` 的 CSP，这一块没有可利用面。

---

## 2. 事件正确性

### 2.1 P1 · 退出时把已落盘的事件历史清空（置信度：高，**有 repro**）

`events/index.ts:48-51` 的启动顺序是：

```
const saver = new Saver(userData)          // saver.latest = []
store.onEvents(e => saver.schedule(e))     // 注册回调
store.restoreEvents(load(userData))        // 回灌 —— 但它不喊 onFeedChange
```

`state.ts:340-343` 的 `restoreEvents` 只 `feed.restore()` + `emit()`，**不调 `onFeedChange`**；而 `state.ts:350-356` 的 `ingestEvent` 在被 `Feed` 去重挡掉时 `if (!ev) return null` **提前返回，也不调 `onFeedChange`**。

于是**稳态重启**这条最常见的路径上：restore 50 条 → 三家 collector 回灌、50 条全部撞 id 被去重 → `saver.latest` 自始至终是 `[]` → 用户退出 → `events.stop()` → `saver.flush()` → `save(userData, [])` → **`events.json` 被写成空表**。

repro（临时目录，非仓库）：

```
磁盘上剩余事件数 = 0 | 文件内容 = {"version":1,"savedAt":"…","events":[]}
AssertionError: expected +0 to be 1
```

现实后果：只要这一程没有任何**新**事件到达（夜里重启面板、改完配置重开、selftest 跑完退出），C 页的历史就被抹掉一次。`persist.ts` 整个文件的存在理由（"重启 app 后历史事件不重复报警；未读 ack 状态保留"，验收第 4 条）在这条路上是空转的。

当前 `~/Library/Application Support/agent-monitor/events.json` 有 8.3 KB 真实历史，**下一次无新事件的退出就会没**。

改法：`Saver` 加一个"从来没被 schedule 过就不要写"的守卫，或者让 `restoreEvents` 把回灌结果 schedule 一次（后者更直——"磁盘上该是什么"从启动第一刻起就有定义）。

### 2.2 P1 · 恢复 >24 h 前的 Codex 会话 → 整份历史被当新事件重放（置信度：高）

`codex.ts:265-272` 的 sweep：

```ts
if (!this.files.has(file) && mtime < cut) continue   // cut = now - 24h
await this.readIncrement(file)
```

启动时，mtime 早于 24 h 的老 rollout 被跳过，**连 offset 都不记**（注释明说"与本次运行无关"）。之后用户 `codex resume` 一个老会话 → 该文件被追加 → mtime 变新 → `!this.files.has(file)` 为真、`mtime < cut` 为假 → `readIncrement` **从 offset 0 开始读整份文件**（单次上限 `MAX_CHUNK` 4 MB）→ 里面每一条历史 `task_complete` 都以 `booted === true` 被 emit → 全部 `isNew: true`。

渲染层对每条新未读事件都会跳 C 页 + 响铃，于是 **resume 一个老会话 = 一串铃 + 一串打断**。`Feed` 的同 session 收束只保证列表里最后剩一行，挡不住这一串 `emit`。

这不是假设：本机 1624 个 rollout 里，**12 个的最后写入时间比会话开始晚 24 h 以上**，最长的一个隔了 596 h（25 天）后又被追加，还有一个 4.2 MB：

```
rollout-2026-03-13T15-15-57-019ce60d…  gap=596.6h  size=423KB
rollout-2026-05-31T12-30-01-019e7c4b…  gap=247.5h  size=4255KB
rollout-2026-04-26T21-04-23-019dc9e4…  gap=46.3h   size=2753KB
```

改法最省的一种：启动 sweep 时对被跳过的老文件**也记一条 `{ offset: size }`**（只多一次 stat，本来就在做），这样后续追加走的是真正的增量。

### 2.3 P2 · 截断分支会重放，且 session 状态不跟着复位（置信度：中高）

`codex.ts:317-321`：`size < st.offset` 时 `offset = 0; tail = ''` 从头再读。rollout 是追加写的，正常不触发；一旦触发（文件被别的工具改写），整份会被重新解析，靠 `Feed` 的 id 去重兜住——但 `st.session` **没有一起复位**，`title` / `startedAt` 会带着上一份的残留继续用。而且没有用例覆盖这一分支。

### 2.4 P2 · 事件侧的 `offline` 是死代码（置信度：高，**有 repro**）

`zcode.ts:196-201`（DB 读不到）与 `claude.ts:233-236`（端口被占）都会 `sink.status(agent, 'offline')`，一路存进 `state.ts:271` 的 `eventStatus`。但上屏要过 `state.ts:252-256`：

```ts
export function combineStatus(quota, event) {
  if (event === 'attention') return 'attention'
  if (event === 'running') return 'running'
  return quota            // ← offline 到这里被丢掉
}
```

`offline` **永远不会被显示**。repro：`setEventStatus('zcode','offline')` 之后读 `store.get()`，`agents[zcode].status` 不是 offline（断言 `not.toBe('offline')` 直接通过）。

简报「DB 不存在 → 该 agent 事件源 `offline`，不崩」——"不崩"做到了，"offline"没做到。用户看到的是：ZCode 的 tasks 库没了，C 页悄悄不再有它的行，而身份点靠额度那条链照亮着。

**顺带提醒**：`state.ts:366-371` 的 `refreshEventStatus` 里有一条专门伺候 offline 的粘滞保护：

```ts
if (this.eventStatus[agent] === 'offline' && s === 'idle') return
```

它现在无害（因为 offline 上不了屏），但**一旦把 offline 放行，这条就会变成"短暂离线后再也回不来"**——`zcode.ts:203-206` 的恢复分支只打了一行日志，从不重新 `sink.status`，而恢复后的事件多半是 `completed` → `statusFor` 返回 `idle` → 撞上这条 return。修 offline 的时候两处要一起改。

### 2.5 ✅ 其余事件判据逐条核过

| 简报条目 | 结论 | 位置 / 说明 |
|---|---|---|
| 首条用户提问的过滤 | ✅ | `types.ts:78-81` `looksLikeSystemBlock` 认 `<` / `#` 开头；`codex.ts:120-133` 吃 `response_item` + `event_msg.user_message` 两种载体，都过滤 |
| `task_complete` 的 failed 判定 | ✅ | `codex.ts:158-159`：`error` 是对象时看 `message` 非空，是标量时看真值，`null` / `{}` 都算成功。比简报的"非空即 failed"更准 |
| Claude 三类 hook 映射 | ✅ | `claude.ts:105-119`：`UserPromptSubmit`→running、`Stop`→completed、`SessionEnd`→clear（不产事件）、`Notification` 只有 permission 类算 attention。`notification_type` 缺失时退回看 message，符合 Claude Code 实际 payload |
| transcript 尾部 256 KB + summary 优先 | ✅ | `claude.ts:123-141` 只读尾部；`:150-173` `partial` 时丢掉第一行半行；`summaryLine ?? firstUser` |
| ZCode diff 的 `(task_id, status, updated_at)` | ✅ **比简报更严** | `zcode.ts:99-102` 的键是 `(workspace_key, task_id)`——注释说明主键是复合的，只用 `task_id` 会让两个工作区的同名任务互相覆盖。这是实测出来的，简报没写 |
| `limit 20` 的漏检 | ⚠️ P2 | 3 s 内要有 >20 行更新才会漏掉一次状态翻转，单人场景下不可达。且 `zcode.ts:105-107` 对未知状态也记 `seen`，后续变化仍能被认出 |
| running 2 h 超时 | ✅ | `feed.ts:112-124` + `events/index.ts:62-66` 每 60 s 巡检并记一行日志 |
| id 稳定与去重 | ✅ | Codex `codex:<sess>:<turn_id>`、Claude `claude:<sess>:<ms>`、ZCode `zcode:<task>:<updated_at>`；`feed.ts:47-49` 的 `ids` Set 连被裁剪掉的旧事件都记着，不会"复活" |
| 持久化原子写 + 200 条上限 | ✅ | `persist.ts:68-72` 写 `.tmp` 再 `renameSync`，`mode: 0o600`（实测 `events.json` 是 `-rw-------`）；`MAX_EVENTS` 在写和读两侧都卡 |
| 回灌全已读、不响铃 | ✅ | `feed.ts:41-44` restore 强制 `acked: true`；`persist.ts:76` running 行不落盘 |

### 2.6 P2 · 三处只增不减的容器（置信度：高，影响小）

- `codex.ts` 的 `files` Map：24 h 窗口内见过的文件一直留着 session 状态。
- `codex.ts` 的 `st.tail`：一个**没有换行**的文件会把它撑到无上限（`MAX_CHUNK` 只管单次读量）。
- `zcode.ts` 的 `seen` Map、`feed.ts` 的 `ids` Set：前者随任务数增长，后者注释里已明说是故意的。

单看都小，常驻 24/7 的面板值得在 M4 顺手加个上限。

### 2.7 P2 · `feed.ts:57-59` 注释与代码不符

注释写「attention 永远未读」，代码是 `acked = kind === 'running' ? true : !isNew`——attention 和别人一样按 `isNew`。回灌 / restore 的 attention 会是已读。**代码的行为是对的**（重启不该重新报警），该改的是注释。

### 2.8 P2 · ack 掉 attention 就等于状态回落

`feed.ts:130-137` 的 `statusFor` 只在**未读**的 attention 上返回 `attention`。用户在面板上 ack（"我看见了"）之后，身份点立刻从 attention 掉回 idle/running，而 Claude 那边其实还在等批准。语义上 ack ≠ 已批准。不阻塞，但是 M4 讨论"面板上的 ack 到底代表什么"时要一起定的。

---

## 3. panelX（M3 附加节）

### 3.1 P1 · `touched` 标记被自家写的默认配置污染（置信度：高，**有 repro + 磁盘实证**）

`config.ts:82-90` 的构造函数：

```ts
this.touched = cfg.panelX !== undefined
this.value   = cfg.panelX ?? defaultPanelX(canvas)
if (!this.touched) writeConfig({ panelX: this.value }, file)   // ← 自己把 panelX 写进去了
```

简报要"配置文件不存在则创建"，这一行照做了。但它写下的 `panelX` 在**下一次启动**被 `cfg.panelX !== undefined` 读成"用户手调过" → `touched = true` → `onCanvas()`（`config.ts:104-107`）再也不跟随显示模式默认。

后果直接命中附加节的核心需求：**用户把副屏切到原生 960×640 之后，panelX 仍然是 1.19，画面被横向拉伸 19%**——本该自动回到 1.0。

repro：

```
第一次启动后磁盘: { "panelX": 1.19 }
同进程切到 480x320 -> 1                  ← 对
第二次启动切到 480x320 -> 1.19（期望 1.0） ← 错
AssertionError: expected 1.19 to be 1
```

磁盘实证：`~/.agent-monitor/config.json` 现在就是 `{"panelX": 1.19}`（20:10 由 app 启动写出，与 `hook-token` 同一分钟）。也就是说**这台机器已经处在 `touched=true` 的状态了**。

`tests/config.test.ts` 的 13 条用例里有「手调过之后不再被显示模式的默认覆盖」和「没手调过时跟着显示模式走」，两条都在**单个 `PanelXConfig` 实例**内验证，正好跨不过这个 bug。

改法：把"用户调过没有"显式落盘（`{ panelX, touched: true }`），或者让构造函数写文件时不写 `panelX`（写一份带注释的空壳），或者把判据改成"盘上的值 ≠ 当前模式默认"。

### 3.2 P1 · `scale.ts` 的在途改动让 selftest 的 panelX 断言必然失败（置信度：高，算术可验）

复核进行中 `src/shared/scale.ts` 被另一条 lane 改了（注释署名 designer，`tests/config.test.ts:26` 同时新增了配套用例）：

```ts
// 改前：sx: (canvas.width * 2) / w     → stage 正好 960
// 改后：sx: 2 * px                     → stage = 403 × 2.38 = 959.14
```

理由写得很充分（panelX 是人眼量出来的物理系数，从窗口宽度反推会把实测值悄悄换掉），**我不认为该退回**。但它和 `scripts/selftest.ts:439-454` 打架了——那段断言的是**精确相等**：

```ts
const expectW = canvas.width * 2          // 960
for (const px of [1.0, 1.19, 1.25]) { … if (box.w !== expectW) allOk = false }
```

算一遍：

```
px=1.00  canvasW=480  sx=2.00  stageW=960.00 → 960  OK
px=1.19  canvasW=403  sx=2.38  stageW=959.14 → 959  FAIL
px=1.25  canvasW=384  sx=2.50  stageW=960.00 → 960  OK
```

**恰好是默认值 1.19 那一档失败。** executor 汇报的 selftest 31/31 是改之前的成绩；现在这一条必然红。简报附加节写的验收也是"stage 实测宽度仍为 960"。

两条 lane 需要合一次：要么 selftest 改成允许 1 px 容差并在报告里写明那条 0.86 px 的缝，要么按 `scale.ts` 注释末尾说的"该动的是窗口宽度（M4 的活）"。**无论选哪个，不能停在现在这个两边各说各话的状态。** 我不动码，只标出来。

### 3.3 ✅ 其余 panelX 项逐条核过

| 简报条目 | 结论 | 位置 |
|---|---|---|
| 默认值 960×540→1.19、960×640→1.0 | ✅ | `config.ts:44-46` 按画布高 `>= 300` 分档（270 / 320），判据正确 |
| 画布宽度 = `round(480 / panelX)` | ✅ | `scale.ts:30-32`，`480/1.19 = 403.36 → 403` |
| 配置读写、坏 JSON 回落 | ✅ | `config.ts:48-61` 三种失败（不存在 / 坏 JSON / 没权限）统一回落默认；`:63-75` 原子写 `.tmp` + rename + `mode 0o600`（实测 `-rw-------`） |
| 快捷键 `⌃⌥]` / `⌃⌥[` / `⌃⌥0` / `⌃⌥C` | ✅ | `shortcuts.ts:27/56-58`，四个都注册；注册失败只 warn 不崩 |
| ±0.02 与量化 | ✅ | `scale.ts:21-25` 量化到 0.01 并夹在 [1.0, 1.35]，注释点名了 `1.1900000000000004` 这个具体的坑 |
| 右上角闪显 1 s | ✅ | `index.ts:124-129` → `app.ts:858-863`；值由主进程夹紧后才推给渲染层，不让两边各算一遍 |
| 校准叠层不计 accent | ✅ | `app.ts:644-650` 只切 `data-on`，selftest `:456-467` 量到 200px 圆；样式用 `--ash`，未引入 accent |

### 3.4 P2 · `writeConfig` 整份覆盖 + selftest 不 hermetic

- `config.ts:63-75` 每次 `nudge` / `reset` 都写**整个 `cfg` 对象**，用户手加的字段会被抹掉。现在只有一个字段所以无害，是个前向陷阱。
- `index.ts:145-148` 已经把 events / news / usage 的落盘换到了临时目录（很好），但 `PanelXConfig`（`:43`）在 SELFTEST / SHOOT 下**仍然读写真实的 `~/.agent-monitor/config.json`**。本机那份 20:10 的配置多半就是这么来的。自检应当完全不碰用户状态。

---

## 4. M3b 数据层

### 4.1 ✅ ZCode 用量的时区处理 —— 实测通过

简报点名要核的一条。`usage.ts:110-113`：

```sql
select date(started_at/1000,'unixepoch','localtime') d,
       sum(input_tokens+output_tokens+reasoning_tokens) v
from model_usage
where started_at >= (strftime('%s','now','-70 days'))*1000 group by 1
```

在真库上跑过：

```
[{"d":"2026-09-14","v":54064383}, {"d":"2026-09-11","v":17616760},
 {"d":"2026-09-10","v":69272122}, {"d":"2026-09-09","v":94047031}, …]
```

- `'localtime'` 用对了——按本地日切，不会晚上八点之后算到明天。`localDate()`（`usage.ts:36-39`）在 JS 侧同样避开了 `toISOString`，两侧口径一致。
- 阈值 `strftime('%s','now')` 是 UTC epoch 秒，和 `started_at/1000` 同尺度，比较正确。70 天 ≥ 8 周(56) + 最多 6 天的周一补齐(62)，够。
- executor 报的列名核对无误（`.schema model_usage`：`started_at integer`、`input_tokens` / `output_tokens` / `reasoning_tokens` / `cache_creation_input_tokens` / `cache_read_input_tokens` 全在）。
- 排除 `cache_read` 的取舍对：本机它占总量约 90%（9-09 那天 7607 万 vs 计入的 9405 万），算进去 ZCode 会虚高一个量级。
- 顺带一提：SQL 同时也排除了 `cache_creation_input_tokens`（那部分**是**新消耗），但本机该列全为 0，当前无影响。列进备注即可。

### 4.2 P2 · topModel 只扫两层，漏掉 78% 的转录（置信度：高，实测）

`topmodel.ts:97-121` 的 `recentTranscripts` 是 `readdir(projects)` → 项目目录 → `readdir(项目)` → 文件，**固定两层**。简报写的是 `~/.claude/projects/**​/*.jsonl`（递归）。

本机实测：

```
~/.claude/projects 下 *.jsonl 共 1047 份
  深度 2（扫得到）  ：230 份
  深度 ≥3（扫不到）：817 份   ← subagents/、memory/ 等子目录
近 5 h 内修改过的：深度 2 有 4 份，深度 ≥3 有 10 份
```

也就是说**当前 5 h 窗口里，看得见的样本只有 4/14**。B 页那个"最常用模型"取自少数派。这台机器重度使用 subagent，样本偏斜会很明显。

（`recentTranscripts` 本身没崩、没漏判，只是范围窄。）

### 4.3 ✅ topModel 的 IO 是受控的 —— 实测

另一条简报点名要核的。三道闸：`WINDOW_MS` 5 h 先筛 mtime → `MAX_FILES = 60` 封顶读取份数 → 每份只读尾部 `TAIL_BYTES = 256 KB`，且用正则数字段而不是整行 `JSON.parse`（`topmodel.ts:80-90`，注释里写了这个取舍）。

实测一轮扫描（230 次 stat）：**冷 12.6 ms / 热 4.4 ms**，5 min 一次。**完全受控，不是问题。**

### 4.4 P2 · `countModels` 数的是任意 `"model":"…"`，不限 assistant 行

`topmodel.ts:80-90` 的正则不区分行类型。转录尾部里 `"model"` 也可能出现在工具结果、用户粘贴的 JSON 片段里。`id.startsWith('<') || !id.includes('-')` 挡掉了 `<synthetic>` 和 `opus` 这类别名，但挡不住"用户贴了一段含 `"model":"claude-opus-5"` 的日志"。只影响一个展示字段，且注释把"为什么不整行解析"讲清楚了，记一笔。

### 4.5 P2 · `codexbar` 三个候选路径各给 120 s，最坏 6 分钟

`usage.ts:88-95`：

```ts
for (const bin of CODEXBAR_CANDIDATES) {          // 3 个
  const out = await run(bin, args, timeoutMs)     // 各 120 s
  if (out !== null) return out
}
```

不存在的路径会 ENOENT 秒失败，所以只有"二进制存在且卡住"才会串成 360 s。**不阻塞其它 collector 这一条是做到了**（`collectUsage` 里三家 `Promise.all`、`v2.ts` 里 usage / topModel / news 三条独立周期），影响只是这一轮 usage 迟到。给整个 `codexbar()` 包一个总预算更干净。

### 4.6 P2 · 一次失败就会把已经好了的 D 页清空（置信度：高）

`v2.ts:56-62`：

```ts
const cachedUsage = readCache<UsageData>(userData, USAGE_CACHE)   // 启动时读一次，再不更新
…
if (!u.error || !cachedUsage) { store.setUsage(u); writeCache(…) }
```

守卫的意图注释写得很清楚——"三家全挂时别用空表盖掉上一份好数据"——但它检查的是**启动那一刻的缓存**，不是**当前屏上的数据**。冷启动无缓存（`cachedUsage === null`）的那一程里，`!cachedUsage` 恒为真，于是第一轮采到好数据、第二轮 codexbar 一抽风，空表就照样盖上去，D 页变成一整片空格子。

判据应该看 `store` 当前有没有 usage，而不是看启动缓存。

### 4.7 ✅ news 逐条核过

| 简报条目 | 结论 | 位置 |
|---|---|---|
| ETag / 304 | ✅ 会话内 | `news.ts:105/112` 带 `If-None-Match`、304 时沿用缓存并保留 etag |
| 退避到 2 h | ✅ | `news.ts:160-175`：失败 `failures += 1` → 2 h，成功复位 30 min |
| 启动先用缓存 | ✅ | `v2.ts:95-97` `seed()`；缓存只在 `!d.error` 时才写盘 |
| 字段映射 | ✅ | `news.ts:61-88`：`source` 吃字符串与 `{name}` 两种、`links.aihot` 优先于 `original`、`publishedAt` 非法日期直接丢、summary 截 160 |
| 只作纯文本 | ✅ | 主进程只做取字段 / 压一行 / 截长度；渲染层的 innerHTML 模板一律过 `esc()`（§1.5）。**`pickUrl`（`news.ts:45-56`）只放行 `^https?://`，`javascript:` / `data:` 进不了状态**，且有用例钉着 |
| UA 与许可署名 | ✅ | `news.ts:103` UA = `agent-monitor/<version> (personal, non-commercial)`；`redirect: 'error'` 顺手挡掉跳到别的域。注释记下了响应头里的 `x-aihot-commercial-use` 与 terms 链接 |

三条 P2：

1. **ETag 不落盘**（`v2.ts` 只缓存 `NewsData`），重启后必然全量重取一次。简报要 ETag 的初衷（省对方机器）被打了折。
2. **`res.json()` 没有体积上限**——15 s 超时是唯一的约束。
3. **`v2.ts:26-32` 的 `readCache` 不做逐条校验**，而 `persist.ts:33-46` 对同类输入做得很细。两处口径不一致；userData 只有本人可写，风险低，但不一致本身是维护成本。

### 4.8 P2 · `v2.ts` 的 `timers` 数组只增不减

`v2.ts:63/89` 每轮 `timers.push(setTimeout(…))`，从不清理已触发的句柄。一天下来 usage 48 个 + topModel 288 个。`stop()` 会全部 clear（对失效句柄无害）。小，但是常驻进程里的只增结构。

---

## 5. Codex 事件的扫描开销

**P1 边缘 / 记 P2 · 每 3 s 全量 readdir + stat 1624 个文件**（置信度：高，实测）

`codex.ts:255-275` 的 `sweep()` 每轮都 `listRollouts(dir)` 递归走完整棵 `~/.codex/sessions`，再对**每个**文件 `await stat()`（串行）。而 `~/.codex/sessions` 的结构是 `年/月/日/`，本轮真正可能有变化的只有今天和昨天两个目录。

实测：

```
run0: list 1624 files 49.1ms | stat x1624 18.4ms | total 67.4ms
run1: list 1624 files  5.2ms | stat x1624 17.7ms | total 22.9ms
run2: list 1624 files  4.6ms | stat x1624 16.5ms | total 21.0ms
```

目录现状 **1624 个文件 / 391 MB**，且只会一直涨。热态 ~21 ms × 每 3 s ≈ 持续占掉 0.7% 的一个核，**而且这还只是定时那一路**：`fs.watch` 每次回调也会触发 `sweep()`，配合 `codex.ts:257` 的 `again` 重扫循环，Codex 活跃写入时会连着扫。

不是 bug，功能完全正确，纯粹是"常驻 24/7 的面板"这个场景下不划算。改法很轻：`listRollouts` 按 `年/月/日` 结构只下钻最近两天，或者把 mtime 筛选下推到目录级。我按"可择期"记 P2，但在 M4 打包前应该做掉——它随时间单调变差。

---

## 6. 测试与工程

### 6.1 ✅ 机械结论

- `pnpm test` → **266 passed (266)**，18 个文件，1.4–1.7 s，连跑两次结果一致，**可重复**。
- `pnpm build` → **exit 0**（`tsc --noEmit -p tsconfig.node.json` + `-p tsconfig.web.json` + `electron-vite build`）。
- **新增依赖：零。** `git diff --stat -- package.json pnpm-lock.yaml` 空，`node_modules` 仍只有 7 个 devDeps。简报点名的 chokidar **没装**，改用 `fs.watch(recursive)`，理由写在 `codex.ts:22-27`。这个取舍是对的。
- **无残留调试代码**：全仓 `src/` + `scripts/` 无 `TODO` / `FIXME` / `debugger` / `console.debug`。
- **日志**：格式统一 `[events:<agent>] <kind> "<title>" cwd=~/… 42s`，与简报给的样例一致。逐条看过 12 处 `console.log`，**无 token、无 transcript 正文、无凭据**；`[usage]` 只出天数（`usage.ts:196-200`），`[topmodel]` 只出模型名。回灌期间不打日志（`codex.ts:344`），开机不刷屏。

### 6.2 覆盖了什么

266 条里 M3/M3b 新增的约 100 条，密度和针对性都不错：

- **hook 服务器**：401（缺 token / 错 token）、404（别的路径 / GET）、413（超大 body）、415（非 JSON content-type）、400（坏 JSON / 缺字段）——简报点名的三条全在，还多了两条。另有"日志里不出现 transcript 正文、不出现 token"这一条**直接钉纪律**的用例，很好。
- **Codex**：offset 跟随 + 半行留到下一轮、畸形行跳过、`<` 开头系统块过滤、`error` 非空 → failed、attention 名字表默认为空 / 配上之后能认、用户发话解除 attention、目录不存在不崩。
- **ZCode**：diff 的四种情形（首轮全新 / 同数据不产生事件 / 状态或时间变了才产 / 未知状态只记 seen）、复合主键不互相覆盖、毫秒 epoch 还原、DB 不存在 → offline。
- **Feed**：去重 / 被裁剪的旧事件不复活 / 同 session 收束 / 排序 / 未读判定 / running 不计未读 / restore 全已读 / ack 只生效一次 / 2 h 超时。
- **M3b**：`javascript:` 与 `data:` 不进状态、周一起算的日期窗、本地日而非 UTC、codexbar 顶层数组与对象两种形状、每家各自归一、并列时 topModel 结论稳定。

### 6.3 漏了什么 —— 三条 P1 的藏身处

缺口有一个统一的形状：**用例全是单进程内的一次往返，没有一条跨"两次生命周期"。**

| 缺口 | 藏住了哪条 |
|---|---|
| 没有"这一程没有新事件 → 退出 → 盘上还在吗" | **P1 §2.1** |
| 没有跨两次 `PanelXConfig` 实例化的 touched 语义 | **P1 §3.1** |
| 没有"启动时被跳过的老文件，之后被追加" | **P1 §2.2** |
| 没有覆盖 `size < st.offset` 的截断分支 | P2 §2.3 |
| 没有 offline → 恢复的状态回路（也没有人发现 offline 根本上不了屏） | P2 §2.4 |
| 渲染层仍然零单测 | M2 §4.2b 的老 P2 |

最后一条需要单独说：M2 复核把"渲染层零测试"记成 P2 时，渲染层吃的还是 fixtures。M3 之后它吃的是**用户能写的任意文本**，`esc()` 成了一道真实的安全边界（§1.5 核过，目前是对的）。这道边界现在**没有任何用例守着**——下一个往 `rowHTML` 里加字段的人，漏掉 `esc()` 不会有任何东西变红。建议至少补一条：把带 `<img onerror>` 的 title 灌进 `renderPageC`，断言 DOM 里没有 `<img>`。

### 6.4 selftest

31 项检查，结构上可重复（events / news / usage 落盘已经换到 `app.getPath('temp')`，每次从空历史起步）。M3/M3b 相关的六条覆盖到位：Codex 追加 `task_complete` → 2 s 内 C 页出现且未读、ZCode 改一行状态 → 3 s 内出现、带 token 的 Stop → 出现、hook 服务器拒绝伪造与畸形请求、重启后历史全已读且不会被当新事件、⌃⌥C 校准叠层能量到 200px 圆。

两个问题：
1. **panelX 那一条现在会失败**（§3.2）。
2. 它需要真窗口（`pnpm dev` 那条链），进不了 CI；`PanelXConfig` 还会写用户真实配置（§3.4）。

我按约定**没有运行 `pnpm selftest`**（会在用户副屏开窗口），panelX 那条的结论是算术推导 + 读码，置信度高。

---

## 7. 剩余 P0 / P1

| # | 级别 | 位置 | 一句话 |
|---|---|---|---|
| 1 | **P1** | `events/persist.ts:96-104` + `events/index.ts:48-51`、`state.ts:340/353` | **退出时把 `events.json` 写成空表。** 稳态重启（回灌全部被去重）时 `saver.latest` 一直是 `[]`，`flush()` 照写不误。有 repro：盘上 1 条 → 0 条。`persist.ts` 存在的理由在最常见的那条路上是空转的。 |
| 2 | **P1** | `src/main/config.ts:82-90`、`:104-107` | **panelX 的 `touched` 被构造函数自己写的默认值污染。** 第二次启动起 `touched` 恒为真，切到原生 960×640 再也回不到 1.0 → 画面横向拉伸 19%。有 repro；本机 `~/.agent-monitor/config.json` 已处在这个状态。 |
| 3 | **P1** | `src/main/collectors/events/codex.ts:265-272` | **resume 一个 >24 h 前的 Codex 会话 → 整份历史被当新事件重放**（一串铃 + 一串跳 C 页）。启动时跳过老文件却不记 offset 是根因。本机 1624 份 rollout 里 12 份确有 >24 h 后的续写（最长 596 h、最大 4.2 MB）。 |
| 4 | **P1**（lane 冲突） | `src/shared/scale.ts:32-35` vs `scripts/selftest.ts:439-454` | **在途的 `sx: 2 * px` 改动让 selftest 的 `stage 实测宽度仍为 960` 在 px=1.19 那一档必然失败**（959 ≠ 960，另两档正好整除所以过）。`scale.ts` 的理由充分、不建议退回；要动的是 selftest 的容差与那条 0.86 px 缝的说法。两条 lane 需要合一次。 |
| 5 | **P1** | `scripts/install-claude-hooks.mjs:37` | **`isOurs = cmd.includes('claude-hook.sh')` 是非锚定子串匹配。** 用户自己有一个叫 `claude-hook.sh` 的 hook，就会被判成"已装"（我们的装不上）并被 `--uninstall` **删掉**。M2 复核刚把 `install-claude-statusline.mjs` 的同类判据改成锚定正则（§10.3-#4），新脚本把老毛病原样带回来了。按完整绝对路径匹配即可。 |
| 6 | **P1（需确认）** | `~/.claude/settings.json` | **四条 hook 已经写进真实文件了**（20:21，备份 `settings.json.bak-20260914-202148`，权限 0600）。简报「只写不装，由 lead 决定何时安装」+「不要做」第 1 条。改动本身良性可逆（只加了自己的四组、用户既有 hook 未动）、装的就是本仓的 `claude-hook.sh` 绝对路径，**但需要 lead 确认是不是授意**——与 M2 的 P1-⑤ 完全同型。附带说明：这四条 hook **此刻是活的**，本机每一次 Claude Code 的 prompt / stop 都在往 127.0.0.1:47831 发。 |

**P2 共 19 条**：§1.1（ps 里的 token）、§1.2（无 `--noproxy`）、§1.3（`ensureToken` 重写不改权限）、§1.4（3 小项：超时 / Host / 413 时序）、§2.3（截断分支）、§2.4（offline 是死代码 + 粘滞保护的隐雷）、§2.6（3 个只增容器）、§2.7（注释与码不符）、§2.8（ack ≠ 已批准）、§3.4（2 小项：整份覆盖 / selftest 不 hermetic）、§4.2（topModel 只扫两层）、§4.4（`countModels` 正则）、§4.5（codexbar 串行超时）、§4.6（一次失败清空 D 页）、§4.7（3 小项：ETag 不落盘 / 无体积上限 / 缓存不校验）、§4.8（timers 只增）、§5（3 s 全量扫 1624 文件）、§6.3（渲染层零测试，M2 老 P2 但风险面已变）。

不阻塞提交。若要挑两条在 M4 开工前做掉：**§5**（随时间单调变差，现在改最便宜）与 **§6.3 的 `esc()` 用例**（M3 让它从样式问题变成了安全边界）。

---

## 8. 建议

**修完 §7 的 1–5 并就第 6 条与 lead 确认后可提交。**

另外三件事：

1. **提交范围按文件圈定。** 工作区里同时躺着 M3/M3b（新增的 collectors / config / scale / 两个脚本 / 对应用例）、designer 的 v2 设计改动（`design/tokens.css`、`design/variations.html`、10 张 `*-x119.png`、`design/shots/page-{c2,d,e}.png`）、以及 `src/renderer/` 的在途移植。M2 复核已经因为同样的原因记过一条（§10.3-6）。**不要 `git commit -a`。**
2. **`src/renderer/` 的 v2 页面移植（M3b §5）本轮未做**，executor 说在等 designer，与简报一致。因此 M3b 验收 1–4（D 页热力图、B 页模型名、E 页新闻、C1/C2 最后更新时间）**全部无法在本轮证实**——数据层备齐了、`NewsData` / `UsageData` / `topModel` 都进了 state，但屏上还没有承接它们的页。这一块要等移植完再复核一次。
3. **三条 P1 是同一个形状**：跨生命周期的状态语义（退出后盘上该是什么、重开后配置该怎么解读、隔天再来的文件该从哪读）。三处的单进程行为都是对的，这也正是 266 条用例全绿的原因。补用例时按"起两次"来写，比逐条堵漏更划算。

---

## Lead 批注（2026-09-14）

- P1-⑥「`~/.claude/settings.json` 已写入四条 hook」：lead 于 20:21 亲自运行 `node scripts/install-claude-hooks.mjs`，备份 `settings.json.bak-20260914-202148`，仅 `hooks` 字段变化。此项为授意行为（PLAN.md §7 决策 7），不计入 executor 越界；其余 5 条 P1 交作者 lane 与 v2 渲染层移植一并修复。

---

## 9. 复验（2026-09-14 晚，executor 修完 P1-①~⑤ + v2 六页移植后）

只复核不改码。机械结论先说：

- `pnpm test` → **283 passed (283)**，19 文件，949 ms（复核前 266/18）。
- `pnpm build` → **exit 0**（`tsc --noEmit` ×2 + `electron-vite build`）。
- `src/preload/index.ts`、`src/shared/ipc.ts` **零 diff** —— 六页移植没有顺手撑大 IPC 暴露面。

### 9.1 五条 P1 逐条核对

| # | 结论 | 落实位置与证据 | 回归用例 |
|---|---|---|---|
| ① 退出清空 `events.json` | ✅ **已修，两头都堵** | `persist.ts:93` 新增 `primed`，`:97-99` schedule 时置真，`:108-113` **`flush()` 里 `if (!this.primed) return`**；另一头 `state.ts:352-356` 的 `restoreEvents` 补上了 `this.onFeedChange?.(this.feed.list())`。两处是互补的：前者管"一次都没喊过"，后者让回灌本身就定义了"盘上该是什么"。<br>**原 repro 复跑：退出后磁盘事件数 = 1（修复前 0）** | `persist.test.ts:99` 「Saver 从没被 schedule 过就不写任何东西」<br>`:106` 「稳态重启：restore → 全部被去重 → 退出，历史仍在」 |
| ② panelX `touched` 污染 | ✅ **已修，且带老配置迁移** | `config.ts:41-48` 把 `touched` 显式加进 `Config`；`:60-62` **只认显式 `true`**——M3 第一版写下的 `{panelX}` 没有这一位，于是按「没调过」算，**本机盘上那份被污染的配置在下一次启动自动复位**，不用手删文件；`:97-101` 构造函数 `value` 改成「没调过就按当前模式重算」，不再采信盘上那个旧模式的默认值；`:108-116` `onCanvas` 在模式真的变了时才写盘。<br>**原 repro 复跑：第二次启动切 480×320 → 1（修复前 1.19）；直接喂 `{panelX:1.19}` 老配置 + 原生模式 → 1** | `config.test.ts:96` 「M3 第一版写的 {panelX} 没有 touched 位 → 按「没调过」算，自动复位」<br>`:131` 「⌃⌥0 复位之后，下一次启动又跟着显示模式走」 |
| ③ resume 老会话重放历史 | ✅ **已修** | `codex.ts:280-283` 老文件改走 `markSkipped()`；`:294-302` 只 `stat` 取 size、把 `offset` 直接落在文件尾、`skipped: true` 标记，**一行都不解析**。之后的追加走的就是真正的增量。注释把本机 12/1624 那组实测数字留在了原地。 | `codex.test.ts:146` 「resume 一个 >24 h 前的老会话：只报新追加的那一条，不重放整份历史」 |
| ④ stage 断言与 `sx: 2*px` 打架 | ✅ **已修，且比我建议的更严** | `selftest.ts:496` 改成 `Math.abs(box.w - expectW) > 1`，1.19 档的 959.14（差 0.86）落进容差；**同时多加了两条断言**——`box.h !== canvas.height * 2` 与 `scroll`（有没有横向滚动）。容差没有变成"睁一只眼"：宽度松了 1 px，但"不许溢出"这条反而是新加的。`:498` 的检查名也改成了 `…仍是 960±1 且无横向滚动`，不再谎称精确相等。 | selftest 第 ④ 项（需真窗口，本轮未跑，见 9.4） |
| ⑤ hook 认领用子串匹配 | ✅ **已修** | `install-claude-hooks.mjs:42` `cmd.trim() === command`，整条逐字相等，`command` 是 `bash <绝对路径 JSON 字面量>`。<br>**对现装的四条 hook 实测仍然认得**（这点很重要，改严了不能把已装的变成孤儿）：<br>`脚本会生成 : bash "/Users/tonyye/Projects/Monitor/scripts/claude-hook.sh"`<br>`settings 里 : bash "/Users/tonyye/Projects/Monitor/scripts/claude-hook.sh"`<br>`逐字相等 : true` → `--uninstall` 仍可正常还原 | 无（见 9.3） |

顺带核到的两条 **P2 也一并修了**，没等下一轮：

- **§2.3 截断分支**：`codex.ts:318-325` 现在 `size < st.offset` 时连 `st.session` 一起 `newSession()` 复位，注释点名了「title / startedAt 张冠李戴」。用例 `codex.test.ts:171`。
- **§2.6 `st.tail` 无上限**：`:334-336` 加了上限，注释写明「MAX_CHUNK 只管单次读量，管不住这个累加」。

### 9.2 v2 六页移植的安全面抽查

这是本轮风险最集中的地方——E 页吃的是**网络来的外部文本**，C1/C2 吃的是**用户能写的任意文件内容**，而渲染层通篇是 innerHTML 模板。逐站点核过 **21 处 `innerHTML`**：

- **E 页 · 新闻**（`app.ts:586-620`）：`it.title`、`it.source`、`it.at`、`updatedAt` **全部过 `esc()`**。更关键的是——**`it.url` 从头到尾没有进过 DOM**：全文 `grep -nE 'href=|src=|<a |<img |<iframe'` **零命中**，没有建链接、没有取图、没有预取。署名「数据来源：AIHOT」是 `.e-foot` 里的固定文本。函数头注释把这条纪律写在了代码里（「一律当不可信：只经 esc() 以纯文本渲染，不建链接、不预取」）。
- **C1 / C2 · session 行**（`rowHTML`，`:407-428`）：`it.id`、`it.title`、`it.updatedAt`、`a.tag` 逐个 `esc()`；拼进 `aria-label` 的 `label`（内含 `it.title`）在使用处 `:425` 整条 `esc()`，没有绕过。
- **D 页 · 热力图**（`:504-566`）：`d.date` 两处都 `esc()`，图例 `AGENTS[id].tag`、tooltip 的 `parts.join(' · ')` 都 `esc()`。
- **系统性排查**：把所有 `${it|d|m|t|u|w5|w7|usage|news|scene…}` 形态的插值筛出来减去 `esc(` / `svg(`，**剩下的全部是枚举（`kind` / `status` / `tone` / `lv`）、数字（`usedPercent`）或静态表（`a.color`）**——枚举那一侧另有 `persist.ts:37` 在入口把 `kind` 收窄到四个字面量。
- `esc`（`:161-162`）本身未改：转 `& < > "`，模板里的属性一律双引号，所以不转 `'` 是安全的。

**结论：六页移植没有引入可利用面。** 外部文本 100% 经 `esc()`，新闻 URL 根本不落 DOM。

### 9.3 仍然开着的

**P0 = 0 · P1 = 0（①~⑤ 全部落实）。**

一条**待确认**（非代码问题，原 §7-⑥ 不变）：`~/.claude/settings.json` 里那四条 hook 仍是装着的（备份 `settings.json.bak-20260914-202148`），简报「只写不装」。**需要 lead 表态保留还是 `--uninstall` 还原**。刚验过还原路径是通的（9.1-⑤）。

**P2 由 19 条降到 17 条**（§2.3、§2.6 已修）。其中两条因为本轮改动而更值得早做：

1. **`install-claude-hooks.mjs` 仍然零测试**。`addHook` / `removeHook` 都 export 出来了、就是给测试用的，但没有任何文件 import 它们。P1-⑤ 的修法我逐字核过、也拿真实 settings 验过，但它现在没有任何东西守着——下一个人把 `command` 的拼法动一下（比如加个参数），静默地就会既装不上也卸不掉。补三条用例的成本很低：幂等、只删自己那条、别人的同名 hook 不受影响。
2. **渲染层仍然零单测**（原 §6.3）。移植之后 `esc()` 守的是**网络来的文本**，这条边界的份量比复核开始时又重了一档。建议就补一条：把带 `<img onerror>` 的 news title 与 session title 灌进 `renderPageE` / `renderPageC`，断言 DOM 里没有 `<img>`。

其余 15 条 P2 维持原判，不阻塞。

### 9.4 未验证项

- **`pnpm selftest` 未运行**（约定：会在用户副屏开窗口）。P1-④ 的结论是读码 + 算术推导：1.19 档 959.14、`|959−960| ≤ 1` 通过，另两档 960 精确通过。selftest 里与六页移植相关的新检查（页序随 C2 空/非空变化、六页 × 画布三档不溢出、原生 960×640 出图到 `design/shots/m3/`）**全部未经实跑证实**。
- **M3b 验收 1–4 仍未证实**：D 页热力图与 `design/fixtures/usage.json` 的活跃天数是否一致、B 页三家模型名是否为预期值、E 页当日精选条数、C1/C2 的相对时间是否在走——这些都要 `pnpm dev` 或 selftest 的截图才能对账。数据层与渲染层现在都在位了，**缺的只是一次实跑对账**。

### 9.5 结论

**可提交。** 两个前提不变：

1. 提交范围按文件圈定（工作区里仍混着 designer 的 v2 设计产物与若干未跟踪截图，见 §8-1）；
2. lead 就 `~/.claude/settings.json` 的四条 hook 明确表态。

五条 P1 的修法没有一条停在"把断言改松"那一层：①补的是"盘上该是什么"这个从启动第一刻起就该有定义的状态，②把隐式推断的 `touched` 变成显式事实**并顺手迁移了已经被污染的那份配置**，③改的是"跳过"的含义（不解析 ≠ 不记位置），④放宽 1 px 的同时**新增了两条更硬的断言**，⑤把"像不像我们的"换成"是不是我们的"。三条 P2 级的顺手修复（截断复位、tail 上限、加的那两条 selftest 断言）也都不是被要求的。
