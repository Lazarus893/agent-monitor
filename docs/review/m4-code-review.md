# M4 代码与安全复核 · 打磨与交付

> 复核人：m4-reviewer（只读；本轮只写这一个文件，未动 src/ scripts/ tests/ build/ design/，未 commit，未启动 app）
> 日期：2026-09-14
> 范围：`src/main/{tray,connect,install,log,resources}.ts`、`src/{preload,renderer}/connect.*`、
> `src/shared/connect-ipc.ts`、`electron-builder.yml`、`scripts/{install-app.sh,soak.mjs,make-icons.py}`、
> `build/` 图标、`README.md`、6 个新增测试，以及 M1–M3 复核里标注 M4 的 P2 清单。

## 0. 实跑结果

| 命令 | 结果 | 证据 |
|---|---|---|
| `pnpm test` | ✅ 25 文件 / **355 项**全过，937 ms | vitest run，exit 0 |
| `pnpm build` | ✅ 两份 `tsc --noEmit` + electron-vite build 全过 | exit 0，产出 `out/{main,preload,renderer}` |
| 凭据扫描（仓库） | ✅ 0 命中 | `grep -rlIE` 九种模式（`sk-`、`ghp_`、`xox*-`、`AKIA`、JWT、PRIVATE KEY、常见邮箱域），排除 `node_modules/.git` |
| 凭据扫描（`dist/` + `out/` + `build/`） | ✅ 唯一命中是误报 | `out/main/chunks/selftest-*.js` 命中 `zcode-bigmodel.*=`，逐条回查九个模式后确认只有这一条，是 `KEYCHAIN_ACCOUNT` 常量定义，非密钥（未打印内容） |
| 凭据扫描（`app.asar` strings） | ✅ 0 命中 | `strings app.asar | grep -cE '...' -> 0` |
| `codesign --verify --deep --strict` | ✅ exit 0，`Signature=adhoc`，`flags=0x2(adhoc)`，`Identifier=com.tonyye.agent-monitor` | 对 `dist/mac-arm64/Agent Monitor.app` |
| `spctl --assess --type execute` | ⚠️ `rejected`（**符合预期**，README 已写明处理方式） | ad-hoc 无公证 |

**未实跑**（受任务约束）：`pnpm dev` / `pnpm selftest` / `pnpm shoot` / `pnpm soak` / 启动打包版 / 任何钥匙串写入。
executor 汇报的 selftest 48 项、soak 30 min −6.7%、登录项注册、Gatekeeper 与钥匙串首次授权，本轮**未复现**，下面凡依赖它们的结论均标 🟡。

---

## 1. Keychain 写入全链路（最高优先级）

链路：`tray.ts:206`「连接 ZCode…」→ `index.ts:249 openConnectWindow` → `connect.ts:44` BrowserWindow
→ `preload/connect.ts:15 save()` → `connect.ts:84 ipcMain.handle` → `keychain.ts:68 writeKeychain`
→ `execFile('security', ['-i'])` + stdin。

### 1.1 ✅ 做对的地方（逐条核过，作为基线记下来）

| 简报要求 | 结论 | 位置 |
|---|---|---|
| Key 只经 IPC 一次 | ✅ 渲染层 `input.value` → `invoke(save, key)` 一次，主进程用完即弃，不入 `Store`、不入 `Config`、不入 `MonitorState` | `renderer/connect.ts:38`、`connect.ts:84-100` |
| 不进日志 | ✅ 只落「Keychain 写入成功/失败（service / account）」，连长度都没记；`log.ts:95-97` 的 tee 明确不做深度序列化 | `connect.ts:96`、`log.ts:93-98` |
| 不进 localStorage | ✅ 渲染层全文无 `localStorage` / `sessionStorage` / `fetch` / URL 拼接；CSP `connect-src 'none'` 兜底 | `renderer/connect.ts` 全文、`connect.html:6` |
| 窗口关闭后不残留 | ✅ 成功后立刻 `input.value = ''`（`connect.ts:51`），900 ms 后关窗；窗口 `close()` 销毁整个渲染进程，无 `preventDefault` | `renderer/connect.ts:48-52`、`connect.ts:64` |
| **不用 shell 拼接** | ✅ **且比 argv 更强**：`execFile('security', ['-i'])` 不经 shell，密钥从 **stdin** 进，`ps` 的进程表里只看得到 `security -i`。这是本阶段最值得肯定的一处设计 | `keychain.ts:76-80` |
| `-U` 更新语义 | ✅ `add-generic-password -U` = 已存在则更新，不新建第二条 | `keychain.ts:70` |
| 失败反馈 | ✅ 返回 `{ok:false, message}`，文案直接指向「在弹框里选『始终允许』后重试」 | `connect.ts:99` |
| webPreferences | ✅ `contextIsolation: true` / `nodeIntegration: false` / **`sandbox: true`** 三项齐全 | `connect.ts:58-62` |
| navigation 拦截 | ✅ `will-navigate` 全 `preventDefault`，`setWindowOpenHandler` 返回 `deny` | `connect.ts:74-77` |
| CSP | ✅ `default-src 'none'`，含 `base-uri 'none'` / `form-action 'none'`（M1 复核 §9.5-3 要的两条补上了） | `connect.html:6` |
| **sender 校验** | ✅ 两条频道都先比 `ev.sender === win.webContents`，不是就丢；`handle` 只注册一次，窗口可反复开关 | `connect.ts:80-105` |
| 控制字符防注入 | ✅ 拒绝 U+0000–U+001F 与 U+007F。**这条是关键**：`security -i` 从 stdin 逐行读命令，一个换行就能注入第二条 `security` 命令 | `connect.ts:91-93` |
| 转义正确性 | ✅ 有专门测试（`quoteForSecurity` 5 条，含「先转反斜杠再转引号」的顺序），且 selftest 用带空格 + 双引号 + 反斜杠的 probe 走了真实往返 | `tests/keychain.test.ts:14-38`、`selftest.ts` 连接窗口段 |
| 验收不碰真实项 | ✅ `MONITOR_KEYCHAIN_SERVICE/_ACCOUNT` 把 selftest 指到 `agent-monitor-selftest / zcode-probe`，跑完 `deleteKeychain` 清掉 | `keychain.ts:33-45` |

### 1.2 P2 · `writeKeychain` 的控制字符校验在**调用方**，不在函数里
置信度：高 · `src/main/connect.ts:91` vs `src/main/collectors/quota/keychain.ts:68-82`

挡住换行注入的那三行写在 `ipcMain.handle` 里，`writeKeychain()` 自己对入参不设防。
它是 `export` 的，`selftest.ts` 已经在直接调 `readKeychain` / `deleteKeychain`，
下一个调用点只要绕过连接窗口就把这道闸门丢了。
`security -i` 的命令流注入是这条链路上**唯一的高危面**，校验该贴在最靠近危险的那一层。

改法：把控制字符判断移进 `writeKeychain`（命中直接 `return false`），
`connect.ts` 保留那条用于给用户看的友好文案。

### 1.3 P2 · 写入之后没有读回校验
置信度：高 · `src/main/collectors/quota/keychain.ts:74-81`

`writeKeychain` 只看 `security` 的退出码。代码注释自己点破了风险：转义错了会「静默存进一个被截断的 Key」，
而面板那边只显示「未连接」——用户永远查不到是转义丢了半截。

selftest 确实覆盖了往返（probe 串含空格 / 双引号 / 反斜杠），但那是**一个固定字符串**；
真实 Key 的字符集由智谱决定，不由我们决定。
运行时补一次读回比较（`readKeychain` 后逐字比，**只在内存里比、不记日志、不回显**），
不一致就返回「写入的内容与读回不一致，请重试」，成本是一次 `security find-generic-password`。

### 1.4 P2 · 写入无超时，stdin 无 error 处理
置信度：中 · `src/main/collectors/quota/keychain.ts:74-81`

- `readKeychain` 接受 `signal`，`writeKeychain` 不接受，也没有 `timeout`。
  钥匙串被锁 / 授权框被晾着时，这个 Promise 永不 settle，连接窗口就一直停在「保存中…」，
  两个按钮都 `disabled`（`renderer/connect.ts:42`）。Esc 还能关窗，所以不是死局，但没有任何提示说「它还在等你点系统弹框」。
- `child.stdin?.end(...)` 之前没挂 `error` 监听。`security` 提前退出会让这个流抛 `EPIPE`，
  变成一次 `uncaughtException` —— 现在被 `installCrashGuards` 兜住只记一行，但那是兜底，不是设计。

改法：加 `timeout: 60_000`（授权框留够时间）+ `child.stdin?.on('error', () => {})`。

### 1.5 P2 · 连接窗口的 `setWindowOpenHandler` 与它自己的文档矛盾
置信度：高 · `src/main/connect.ts:74-77` vs 同文件 `:11` 的注释

文件头注释写「窗口自己不导航、不开外链（setWindowOpenHandler + will-navigate **全 deny**）」，
代码却是 `if (url.startsWith('https://')) void shell.openExternal(url)`。
这是从 `window.ts:86-90` 抄过来的分支——面板那边确实需要它（新闻链接），
但连接窗口的 HTML 里一个链接都没有，CSP 还是 `default-src 'none'`。
留着它等于给一个「一件事窗口」保留了一条通向系统浏览器的路，且注释说它不存在。删掉那个 `if`。

### 1.6 P2 · `ipcMain.handle` 捕获的是**第一次**调用的 `deps`
置信度：高 · `src/main/connect.ts:79-105`（`registered` 闭包）

`registered` 只允许注册一次，于是 handler 里的 `deps.onSaved` 永远是第一次 `openConnectWindow(...)` 传进来的那个闭包。
现在无害——`index.ts:249-256` 每次点菜单都新建一个 deps，但它闭合的 `tray` / `quota` 是同一对 `let` 绑定，
运行时读到的值一样。可它是个陷阱：哪天 deps 里放进一个**值**而不是一个读取器，第二次开窗就会静默用上旧值。

改法：把 `deps` 提成模块级 `let current: ConnectDeps`，每次 `openConnectWindow` 覆写它，handler 读 `current`。

### 1.7 P2 · `connect.ts` 没有单测
置信度：高

sender 校验、控制字符拒绝、trim、五条错误文案——全部写死在 `openConnectWindow` 内部的闭包里，
从外面够不着，所以一条单测都没有。这是本阶段安全等级最高的一段代码，却只有 selftest 的端到端一条（还需要真机 + 钥匙串）。

改法照抄 `tray.ts` 已经做对的模式：`trayTemplate` 被抽成纯函数于是有 15 条测试。
这里同样抽一个 `export function validateKey(raw: unknown)`，返回成功值或错误文案，
handler 只剩「校验 → 写 → 回」三行。

---

## 2. `install.ts` / 改 `~/.claude/settings.json`

### 2.1 ✅ `install.ts` 自己完全守住了纪律
`install.ts` 对 settings.json **一行都不写**（全文只有 `readFileSync`，`:41`、`:104`）。
写操作全部下放给 `scripts/install-claude-*.mjs`，且只在 `TrayMenu.install()` → 用户点菜单时 spawn（`tray.ts:139-160`）。
启动路径（`claudeStatus()` → 菜单文案）只读。
`process.execPath` + `ELECTRON_RUN_AS_NODE=1` 的选择也对：GUI app 的 PATH 里没有 homebrew 的 node。

备份 / 幂等 / 精确匹配卸载三条在两个脚本里也都成立：

| 项 | 结论 | 位置 |
|---|---|---|
| 备份 | ✅ `settings.json.bak-<时间戳>`，写之前 | `install-claude-hooks.mjs:148`、`install-claude-statusline.mjs:107` |
| 幂等 | ✅ `addHook` 先查 `already` 直接返回 `changed:false`；statusline 先剥再包，结果一样就不写文件 | `hooks:74-77`、`statusline:98-103` |
| 精确匹配卸载 | ✅ `isOurs` 是**整条命令逐字相等**，不是子串。注释里明确记了「子串判据会把用户同名脚本认成我们的，卸载时删掉用户那条」 | `hooks:43` |
| JSON 其余字段保真 | ✅ 展开拷贝 + `detectIndent` 沿用原缩进 + 结尾换行沿用原文件；空 `hooks` 会被 `delete` 掉不留空壳 | `hooks:100-113,144-146` |
| 坏 JSON 不动手 | ✅ 解析失败直接 exit 1，明说「没有改动任何东西」 | `hooks:129-133` |

### 2.2 **P1 · `settings.json` 是就地非原子写，存在半写文件窗口**
置信度：高 · `scripts/install-claude-hooks.mjs:149`、`scripts/install-claude-statusline.mjs:111`、`src/main/install.ts:68-79`

```js
copyFileSync(settingsPath, backup)          // :148
writeFileSync(settingsPath, body)           // :149  <- open(O_TRUNC) 之后才写
```

`writeFileSync` 对已存在的文件是 `open(..., 'w')`，**先截断再写**。中间被打断就留下一个 0 字节或半截的
`~/.claude/settings.json`——那会让用户的 Claude Code 整个起不来，而这是本项目唯一会碰用户全局配置的地方。

打断不是假想：`install.ts:71` 给了 `timeout: 20_000`，execFile 超时发 **SIGTERM**，正好能落在截断与写入之间。
磁盘满同理。

雪上加霜的是**顺序**：打印备份路径的那行 `console.log` 在 `writeFileSync` **之后**（`hooks:151`、`statusline:113`）。
被 SIGTERM 打断的那一次，用户什么也看不到，不知道 `.bak-<时间戳>` 在哪、甚至不知道有备份。
托盘只会弹一句「安装 hooks 失败，详见日志」。

本仓库自己的 `config.ts:127-133` 已经把正确写法写好了（`writeFileSync(tmp)` → `renameSync(tmp, file)`）。
**用户的文件比我们自己的文件更该用这个写法。**

改法（三处小改）：
1. 两个脚本改成 `tmp` + `renameSync`（同目录，保证同一文件系统）；
2. 备份路径**先打印再写**；
3. `install.ts` 的 20 s timeout 保留，但改完 (1) 之后它就不再有半写风险。

### 2.3 P2 · 并发写无任何保护
置信度：中 · 两个脚本的 read-modify-write 段

Claude Code 自己也会写 `~/.claude/settings.json`。两个脚本读进来、改、整份写回，
中间任何一方的写入都会被另一方的整份覆盖丢掉。`uninstall-all` 里两个脚本是 `await` 串行的（`install.ts:92-93`），
自家两条不会互相打架，**但与 Claude Code 之间没有任何锁**。

不阻塞提交（这是单机单用户、且用户是在点菜单那一刻主动触发的），
但值得在脚本输出里加一句提示，或者在读-写之间比一次 mtime。

### 2.4 P2 · `isOurs` 的逐字匹配含绝对路径，装法一换就卸不掉
置信度：高 · `install-claude-hooks.mjs:42`（命令串由 `HOOK` 绝对路径拼成）、`resources.ts:16-20`

`HOOK` 在 dev 下是 `<repo>/scripts/claude-hook.sh`，打包后是
`~/Applications/Agent Monitor.app/Contents/Resources/scripts/claude-hook.sh`。
逐字匹配（这条本身是对的，见 2.1）意味着：**用仓库装过、再用打包版卸载，卸不掉**，反之亦然，
settings.json 里会留下一条指向已删除路径的孤儿 hook（`curl` 每次静默失败，用户永远不知道）。

README 的还原命令只给了 `~/Applications` 那一份，括号里的仓库写法是并列的另一条，
没有说「你装的时候用的哪条，卸的时候就得用哪条」。

改法：托盘的「全部卸载」额外扫一遍**任意路径**下的 `claude-hook.sh` / `claude-statusline-tee.sh`，
命中非本次路径的就在 dialog 里列出来让用户确认；或者至少在 README 里写清这条对应关系。

---

## 3. 托盘与登录项

### 3.1 ✅ 菜单与配置同步
- 三个勾选项都是「先调 deps → 写 config（合并写）→ `rebuild()`」（`tray.ts:118-122`、`index.ts:262-280`）。
- `writeConfig` 是**合并写**（`config.ts:125-136`），托盘勾静音不会把用户校准出来的 `panelX` 冲掉——
  这正是 M3 复核 §3.4 记的前向陷阱，本阶段处理正确。
- `prefs` 在 `index.ts` 里是 `let` + 整体替换，`tray.ts` 通过 `prefs: () => prefs` 读取器每次重读，没有快照分叉。
- 20 s 周期重建只为了「Claude 采集」那一行（settings.json 可能被别的进程改），
  **明确不重查钥匙串**，理由写在 `tray.ts:14-17`：否则没点过「始终允许」的机器每 20 s 弹一次框。这个取舍是对的。
- 菜单顺序、文案、禁用条件有 15 条测试钉住（`tests/tray.test.ts`），包括「没有 emoji」「没有通知入口（决策 3）」两条纪律断言。

### 3.2 ✅ `openAsHidden` 的偏离有正当理由且写清楚了
简报写 `{ openAtLogin: true, openAsHidden: true }`，代码只写了 `openAtLogin`（`index.ts:226`）。
理由在 `index.ts:207-217` 与 README「开机自启」段：Electron 44 已移除该位（macOS 13 起走 SMAppService）。
**并且对这个 app 反而更对**——面板本来就该开机后出现在副屏上。
焦点问题由 `show: false` + `ready-to-show` 才 show 解决（`window.ts:63,96-99`），不调 `app.focus()`。✅

`applyOpenAtLogin` 只在 `app.isPackaged` 时写（`index.ts:219-222`），避免把 `node_modules` 里的 Electron
写进用户登录项——这一条很重要，做对了。

### 3.3 ✅ 退出顺序：M3 P1-① 语义仍成立
四个 `will-quit` 依次是
`tray.destroy + closeConnectWindow`（`:260`）→ `quota.stop`（`:277`）→ `v2.stop + events.stop`（`:292`）→ `unregisterShortcuts`（`:315`）。
**落盘在 `events.stop()` 里面**（`collectors/events/index.ts:69-73`：先 `clearInterval` + 各 collector `stop()`，最后 `saver.flush()`），
所以「先停 collector 再落盘」这条语义成立。✅

### 3.4 P2 · `will-quit` 四个 handler 没有各自 try/catch；SIGTERM 完全绕过
置信度：中 · `src/main/index.ts:260,277,292,315`、`scripts/install-app.sh:31-35`

- 若 `quota.stop()` 抛（`:277`），Electron 会中断后续 `will-quit` 监听器，`saver.flush()`（`:292`）就不会跑，
  最多丢一个 flush 周期的事件历史。每个 handler 各包一层 `try/catch` 即可。
- `install-app.sh:33` 的 `pkill -f` 发的是 SIGTERM，Electron 主进程默认直接终止，**`will-quit` 一个都不跑**。
  也就是说「`pnpm install:app` 覆盖一个正在跑的实例」这条正常路径必然丢掉未 flush 的事件。
  改法：`process.on('SIGTERM', () => app.quit())`。

### 3.5 **P1 · ⌘W 关掉面板 = 整个 app 退出**
置信度：高 · `src/main/index.ts:317`、`src/main/window.ts:59-79`（全文无 `Menu.setApplicationMenu`、无 `closable: false`、无 `close` 监听）

全仓库没有 `Menu.setApplicationMenu`，于是 macOS 上挂的是 **Electron 的默认应用菜单**，
里面有 `Close Window`（**⌘W**）、`Reload`（⌘R）、`Toggle DevTools`（⌥⌘I）。
面板窗口是可聚焦的（它有 `.edge` 翻页按钮，用户点它就会聚焦，见 `renderer/index.html` 的两个 `<button class="edge">`），
一次误触 ⌘W → 窗口关闭 → `window-all-closed`（`:317`）→ `app.quit()`。

对一个「24/7 常驻、没人盯着」的监视器来说，这是最糟的失败形态：它安静地整个消失，
托盘图标也一起没了，而用户以为它还在跑。`LSUIElement: false`（Dock 图标留着）让面板更容易被点到，放大了这条。

改法二选一：
- `Menu.setApplicationMenu(...)` 给一份最小菜单，保留 ⌘Q、去掉 ⌘W 与 DevTools；
- 或者 `new BrowserWindow({ closable: false })` + 让「退出」只走托盘。

（`window-all-closed → app.quit()` 本身符合简报「关掉最后一个窗口就等于关掉它」，问题不在这条，
在于**存在一个用户不该有的关窗入口**。）

---

## 4. 打包

### 4.1 ✅ `files` 白名单干净——实测而非推断
`electron-builder.yml:21-23` 只有 `out/**/*` 与 `package.json`。
我解了 `app.asar` 的头，**共 85 个文件**，去掉字体后全量如下：

```
/out/main/chunks/selftest-BArjiCeF.js   /out/main/chunks/shoot-Dvd86PvH.js
/out/main/index.js                      /out/preload/{index,connect}.cjs
/out/renderer/{index,connect}.html      /out/renderer/assets/{index,connect,tokens}.{js,css}
/package.json (207 B)
```

`design/`、`tests/`、`fixtures/`、`.agent-monitor`、`docs/`、`PLAN.md`、`DESIGN.md`、任何截图——**一个都没进**。✅
`package.json` 被 electron-builder 重写成 207 字节（不含 scripts / devDependencies），也没有泄漏。✅
`extraResources` 只放 4 个脚本 + 2 张托盘图，实测 `Contents/Resources/` 里确实只有
`app.asar / icon.icns / trayTemplate.png / trayTemplate@2x.png / scripts/` 加 Electron 自带的 `*.lproj`。✅
`asar: true` ✅。安装脚本放 asar 外的理由（`node` / `bash` 打不开 asar 内路径）成立。✅

### 4.2 ✅ ad-hoc 签名步骤
`package.json:12` 的 `package` 串是 `build → electron-builder → codesign --force --deep -s - → codesign --verify --deep --strict`。
**自带验证步骤**，不是签完就算。实测 `codesign -dv` 回报 `Signature=adhoc` / `flags=0x2(adhoc)` / `TeamIdentifier=not set`，
`--verify --deep --strict` exit 0，`spctl` `rejected`——与 README 写的完全一致。✅
`install-app.sh:48-54` 装完还会再验一次签名并在失败时直接给出 `xattr -cr` 的原话。✅

### 4.3 ✅ `install-app.sh` 的 ditto 与备份
`ditto` 而非 `cp -R`（保扩展属性 + 符号链接，签名不会因复制失效）✅；
覆盖前 `mv` 成 `Agent Monitor.app.bak-<时间戳>` ✅；
`rm -rf` 只作用在 `ls -dt "$DEST_DIR/Agent Monitor.app.bak-"*` 这个受控前缀上，
且 glob 无命中时 while 循环空转，没有「删到别处」的路径 ✅；`set -euo pipefail` ✅。

（小瑕疵：`:32` 的 `echo "正在运行的 Agent Monitor 已退出"` 印在 `pkill` **之前**，文案顺序反了。）

### 4.4 ✅ README 卸载步骤完整
逐条核过，简报要的五项全在（README「卸载」段）：登录项 ✅、settings.json 两条还原命令 ✅、
`~/.agent-monitor` ✅、`~/Library/Logs/Agent Monitor` ✅、钥匙串项 ✅
（另外多给了 `~/Library/Application Support/Agent Monitor`，是对的——Electron 的 userData 在那儿）。

### 4.5 P2 · selftest / shoot 的代码随包发出去了
置信度：高 · `app.asar:/out/main/chunks/selftest-BArjiCeF.js`（38 188 B）、`shoot-Dvd86PvH.js`（2 592 B）vs `index.ts:295` 的注释

`index.ts:294` 的注释写「工具脚本动态 import：截图与自检代码**不该出现在生产 main bundle 里**（复核 P2-5.3）」。
动态 import 确实把它们从主 chunk 里挪走了，但**没有把它们挪出安装包**——只是变成了两个旁 chunk。
装好的 app 用 `MONITOR_SELFTEST=1` 启动，仍然会走进自检路径（注入合成事件、写临时目录、跑完 quit）。

不是漏洞（设环境变量的人本来就控制着这台机器），但注释宣称的事和产物不符，而且这 38 KB 里
包含了对钥匙串、对 `~/.claude` 的全部探针逻辑。
改法：main 侧用 `import.meta.env.DEV` 把这两段整体摇掉，让 `pnpm build` 的产物里根本没有这两个 chunk。

### 4.6 **P1 · `ELECTRON_RENDERER_URL` 在打包产物里仍然生效**
置信度：中（机制确定，可利用性取决于攻击者是否已能控制 app 的环境变量）
· `src/main/index.ts:67`（面板）、`src/main/index.ts:250` → `src/main/connect.ts:113`（连接窗口）

```ts
rendererUrl: process.env.ELECTRON_RENDERER_URL      // index.ts:67 与 :250，两处都没有 isPackaged 门
...
if (deps.rendererUrl) void w.loadURL(`${...}/connect.html`)   // connect.ts:113
```

本项目其它每一个开发期旋钮都正确地关在 `app.isPackaged` 后面：
dev IPC 频道（`index.ts:142`）、`MONITOR_FAKE_ERROR`（`index.ts:286` 的 `dev: !app.isPackaged`）、
登录项写入（`index.ts:220`）、preload 的 `dev` 子对象（`preload/index.ts:52` 的 `import.meta.env.DEV`）。
**只有渲染层 URL 这一个没关。**

后果不对称：面板窗口被劫持只是显示错东西；
**连接窗口的 preload 暴露的是 `save()`，它直通 `security add-generic-password -U`**——
一个从 `ELECTRON_RENDERER_URL` 指向的远端页面可以往 `agent-monitor / zcode-bigmodel` 写任意值
（配合同样未设门的 `MONITOR_KEYCHAIN_SERVICE`，还能改写别的项名）。
sender 校验挡不住它：发起方确实就是连接窗口本身。

前提是攻击者能给这个 app 设环境变量（改登录项 plist、`env X=... open -a`）。
门槛不低，但修法是两行，而且这是整套 gating 里唯一的缺口：

```ts
const rendererUrl = app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL
```

---

## 5. 长期运行

### 5.1 ✅ 日志轮转
`log.ts:50-72` 的 `rotate()`：`main.3` 删掉 → `2→3` → `1→2` → `main→1`，每步各自 `try`。
`5 * 1024 * 1024` 与简报一致（`:29`，有测试钉住）。文件 `0600`（`:91`，有测试实测 `mode & 0o777 === 0o600`）。
`appendFileSync` 同步写的理由（`:12-15`：`uncaughtException` / `will-quit` 那两条路上异步写常常还没落盘进程就没了）成立。✅
11 条测试覆盖阈值、三档搬家顺序、tee 格式、0600、restore、目录建不出来不崩。

**并发写**：单实例锁保证只有一个主进程；渲染进程不写日志；`selftest` / `shoot` / `soak` 各自
`MONITOR_LOG_DIR` 到独立临时目录（`package.json:14-15`、`soak.mjs:52`）。实际无并发。✅

### 5.2 P2 · 权限只在「创建时」生效
置信度：高 · `src/main/log.ts:84,91`

`mkdirSync(dir, { mode: 0o700 })` 与 `appendFileSync(file, ..., { mode: 0o600 })` 的 mode
**都只在目标不存在时才应用**。M1–M3 期间如果已经生成过一份 0644 的 `main.log` 或 0755 的目录，
它们不会被本阶段收紧，而 README 明确承诺「文件权限 0600」。
改法：`startLogging` 里对已存在的目录 / 文件补一次 `chmodSync`（失败忽略）。

### 5.3 P2 · `installCrashGuards` 会把**启动期**致命错误也吞掉
置信度：高 · `src/main/log.ts:120-129`、`src/main/index.ts:39`

`log.ts:113-118` 的注释明确承认「没有例外……判断哪些异常是致命的需要的信息这里没有」，
这个取舍在**稳态**下是对的（宁可某块数据停更，也别整个消失）。
但它同时盖住了 `main()` 的启动路径：`installCrashGuards()` 在 `:39` 就装好了，
而 `new TrayMenu(...)`（`index.ts:238`）、`await mw.load()`（`:282`）都在它之后。

具体后果：若 `new TrayMenu` 抛（例如托盘图读不到 + 某些 Tray 构造异常），
异常被记一行，`main()` 的 async 链断掉，**`await mw.load()` 永远不会执行**——
进程活着、没有窗口、没有托盘、没有任何 UI。用户看到的是「双击了，什么都没发生」，
而唯一的线索在一个他不知道存在的日志文件里。

改法（轻）：给启动阶段一道兜底——`main()` 整体 `try/catch`，catch 里 `dialog.showErrorBox` + `app.quit()`；
或者设一个「N 秒内没走到 `mw.load()` 完成就弹框退出」的看门狗。稳态的 `uncaughtException` 策略不用动。

### 5.4 ✅ 渲染层 crash reload 的循环保护
`index.ts:84-103`：
- `quitting` 标志（`before-quit` 置位）避免把自己 quit 时的渲染进程退出记成 ERROR 并重载 ✅
- `reason === 'clean-exit'` 与 `isDestroyed()` 两道短路 ✅
- **2 s 退避**，并且注释说清了它的作用是「让『一起来就崩』的循环在日志里每 2 s 留一条，看得见」✅
- `rendererReady = false` 在 reload 前复位，`did-finish-load` 时补推整份 state + 补推 `mute` 偏好（`:120-125`）✅

没有次数上限（崩溃-重载可以无限循环），但每轮 2 s + 每轮两行日志，属于「可观测的无限循环」，
比静默放弃好。不记问题。

### 5.5 ✅ soak 脚本
`soak.mjs` 的设计站得住：基线取**第 2 分钟**而不是第 0 分钟（避开字体 / 首轮采集 / V8 预热，`:39`、`:19-22`）；
`main` 与 `tree` 两个口径，并说明 macOS 的 RSS 会重复计入共享页所以 tree 只看趋势；
隔离目录 `MONITOR_USER_DATA / CONFIG_FILE / LOG_DIR / HOOK_TOKEN_FILE / HOOK_PORT` 全换（`:46-53`），
钥匙串走只读那条原路（跑在和平时一样的代码路径上）；
采样不足时打印 app 日志尾巴并 exit 1，不会假装通过（`:137-142`）。
🟡 executor 汇报的「30 分钟 −6.7%」本轮未复跑。

### 5.6 P2 · M3 §2.6「只增容器」只做了三分之一
置信度：高 · `codex.ts:45,405-407` ✅ vs `codex.ts` 的 `files` Map、`zcode.ts` 的 `seen` Map ❌

`st.tail` 加了 `MAX_TAIL = 2 MB` 上限并在超限时丢弃缓冲 + 记日志 ✅。
但 M3 复核点名的另两个——`codex.files`（24 h 窗口内见过的文件一直留着 session 状态）与 `zcode.seen`
——全文搜不到任何 `delete` / `prune` / 上限。
soak 只跑 30 分钟，这两个的增长要按天看，测不出来。不阻塞，但 24 h 实机验证时值得专门看一眼 `main` 的 RSS 斜率。

---

## 6. 前序 P2 清单逐条核对

| 出处 | 项 | 状态 | 证据 |
|---|---|---|---|
| M1 §9.5-1 / §7.1 | `sandbox: true`（改 CJS preload） | ✅ **做到了** | `window.ts:77`、`connect.ts:61`；`electron.vite.config.ts:22-38` 产 CJS `.cjs`；`tests/preload-bundle.test.ts` 4 条钉住「不出现 chunks/」「只 require electron」「两个入口不共享模块」——这条回归保护写得很好，它挡的是「面板白屏、日志里只有一行 renderer error」这种发出去才发现的坑 |
| M1 §7.2 | `file://` 下 CSP `'self'` 能否匹配 | 🟡 **已处理，本轮无法复验** | 两份 HTML 的 CSP 都在（`index.html:6`、`connect.html:6`），构建产物引用的是相对路径 `./assets/...`（实测）；README「安全边界」段写「打包后走 `file://` 已实测：脚本、样式、字体都正常加载，无 CSP 拒绝」。我不能启动 app，只能记 executor 的实测结论 |
| M1 §9.5-3 | CSP 缺 `base-uri` / `form-action` | ✅ | 两份 HTML 都补上了 `base-uri 'none'; form-action 'none'` |
| M1 §3.4 | reduced-motion 时连提示音一起丢 | ✅ **解耦了** | `app.ts:307` 的 `rm` 与 `:315` 的 `muted` 是两个独立变量；`chime()`（`:825-826`）**只**看 `muted`；静音走托盘 → `MonitorCommand{type:'mute'}`（`types.ts:206-209` 有专门注释说明为什么走 command 而不是塞进 state） |
| M1 §9.5-2 | `shell.openExternal` 收任意 URL | ✅ 面板已收紧为只放行 https（`window.ts:86-90`）；⚠️ 但连接窗口把这个分支抄了过去（见 §1.5） |
| M1 §9.5-5 | `ipcMain.on` 不校验 sender | ✅ | `index.ts:129-131` 的 `fromPanel`，`CH.ack` / `CH.setPage` / `CH.dev` 三条都过；连接窗口两条见 §1.1。唯一没校验的是 `CH.rendered`（`scripts/shoot.ts:56`），只在 `MONITOR_SHOOT=1` 下注册，可接受 |
| M1 §9.5-6 | `screen.on(...)` 三个监听不摘 | ✅ | `window.ts:118-122` 存 `offScreen`，`dispose()`（`:136-143`）调用它，`watch()` 里 `win.on('closed', () => this.dispose())`。M1 复核预言的「M4 加托盘之后会变成真泄漏」被堵住了 |
| M2 §1.5-1 | `security` 可能弹钥匙串授权框 | ✅ 写进 README 了 | README「首次启动 · 2. 钥匙串『允许访问』」。⚠️ 但因果多半不准，见 §7.5 |
| M3 §2.6 | 三个只增容器 | 🟡 三分之一 | 见 §5.6 |
| M3 §3.2 | selftest 与 `scale.ts` 对 0.86 px 缝各说各话 | ✅ **合了 lane** | `selftest.ts:760` 现在明写「这 0.86px 的缝是**有意的**——panelX 是用户拿正圆量出来的」，选了「容差 + 写明」那条路，不再是两边互相打架 |
| M3 §5 | `~/.codex/sessions` 每 3 s 全量 stat 1624 个文件 | ✅ **做掉了** | `codex.ts:352-353` 只下钻 `recentDayDirs`（今天 / 昨天，`:439-441`），老文件降到 `DEEP_SWEEP_MS = 60_000`（`:71`）。README 也写了实测数据 |
| M3 §3.4 | selftest 不 hermetic（`PanelXConfig` 仍读写真实 config） | ✅ | `config.ts:36-37` 的 `configFile()` 认 `MONITOR_CONFIG_FILE`，`package.json:14-15` 给 selftest / shoot 各配了独立临时路径 |
| 简报 §5 | `design/aspect-test.html` 归档到 `design/tools/` | ✅ | git 记为 `R design/aspect-test.html -> design/tools/aspect-test.html`；`tokens.css:250` 与 README 的引用都跟着改了 |
| M3 §2.8 | ack ≠ 已批准 | ⬜ **未处理，也未说明** | 简报 §5 要求「做不了的写理由」。这一条 M3 复核写的是「M4 讨论『面板上的 ack 到底代表什么』时要一起定的」，本轮 `feed.ts` 的 `statusFor` 未变，executor 汇报里也没提。属于产品决策不是 bug，但清单上该有个结论 |

---

## 7. 测试与工程

### 7.1 355 条覆盖了什么
M4 新增 6 个文件 / 约 50 条：`tray`(15) `log`(11) `keychain`(8) `install`(7) `stage-css-port`(5) `preload-bundle`(4)。
质量高于「凑数」——每一条都能说出它挡的是哪个具体事故：

- `preload-bundle` 挡的是「沙箱 preload 被拆成 chunks → `window.monitor` 不存在 → 面板白屏」，**实测踩过**；
- `stage-css-port` 挡的是「designer 改了原型、移植没跟进，屏上悄悄落后一版而所有结构性断言照样全绿」，
  而且特意**按段头内容找、不按第几个 `<style>` 块找**（注释里说明了为什么不能依赖序数）；
- `tray` 的「没有 emoji」「没有通知入口」两条是把简报纪律与决策 3 变成了可执行断言；
- `log` 的 0600 是实测 `statSync(...).mode`，不是看代码。

### 7.2 漏了什么
| 缺口 | 影响 |
|---|---|
| `connect.ts` 零单测 | 本阶段安全等级最高的一段，只有 selftest 一条端到端（需真机 + 钥匙串）。见 §1.7 |
| `install.ts` 只测了 `claudeStatus` / `statusLabel`（读侧），`runInstall` / `run()`（写侧、超时、`ELECTRON_RUN_AS_NODE`）零覆盖 | §2.2 的半写窗口正好落在这块 |
| `resources.ts` 零覆盖 | `assetDir()` / `scriptDir()` 的 packaged 分支只有真机能验；托盘图找不到只会 `console.warn`（`tray.ts:181`），不会红 |
| 两个安装脚本的**写路径**无测试 | `addHook` / `removeHook` / `apply` 是纯函数、可测，但 `tests/` 下没有对应文件（`statusline-tee.test.ts` 测的是 shell 脚本，不是 installer） |
| `rotate()` 的并发 / 部分失败 | 现实里无并发，可接受 |

### 7.3 ✅ selftest 与 shoot 的隔离仍然成立
- `index.ts:287-292`：`MONITOR_USER_DATA` 优先，否则 selftest → `temp/agent-monitor-selftest`，shoot → `temp/agent-monitor-shoot`，
  **两个工具各一份**（注释写明共用一份会让 selftest 注入的合成事件被下一次 shoot 拍进交付截图）✅
- `package.json:14-15`：两条 script 各自把 `USER_DATA / CONFIG_FILE / HOOK_TOKEN_FILE / HOOK_PORT(47931/47932) / LOG_DIR` 全部挪开 ✅
- `soak.mjs` 用第三套（端口 47934）✅
- `index.ts:34-37`：日志目录在 selftest / shoot 下也换掉 ✅
- selftest 的钥匙串往返用 `MONITOR_KEYCHAIN_SERVICE=agent-monitor-selftest` 临时项，跑完删 ✅
- selftest 截图改落 `design/shots/selftest/`（`selftest.ts:42-49`）并加进 `.gitignore` ✅——
  这一条修掉了「自检与 shoot 写同一个目录」的老问题。

### 7.4 P2 · selftest 会读用户**真实**的钥匙串项
置信度：高 · `scripts/selftest.ts`（「临时钥匙串项已清干净，真实项未被触碰」那一条 check）

```ts
gone === null && (await readKeychain('agent-monitor', 'zcode-bigmodel')) !== null
```

断言「真实项未被触碰」的做法是**去读真实项**。只读、不写，安全性上没问题，但有两个副作用：
1. 会 spawn 一次针对真实项的 `security find-generic-password`，在没点过「始终允许」的机器上**弹授权框**；
2. 它让这条 selftest **依赖一台已经连好 ZCode 的机器**——没连过的机器上这条必红，而红的原因与被测行为无关。

改法：把断言改成「真实项的存在性在 selftest 前后一致」（前面先读一次存起来），或者干脆只断言临时项已清。

### 7.5 P2 · README 的钥匙串授权因果需要实测确认
置信度：中 · `README.md`「首次启动 · 2」

README 写「ad-hoc 签名的 app 每次重新打包，签名标识就变了，macOS 会把它当成『另一个程序』，
于是弹『Agent Monitor 想要访问您的钥匙串中的密钥』」。

但本项目访问钥匙串的进程**不是 app 自己**，是它 spawn 出来的 `/usr/bin/security`（Apple 签名，`keychain.ts:20,76,87`）。
钥匙串的 ACL 与「始终允许」是绑在**发起请求的那个进程**上的。
如果实际如此，那么弹框里的程序名多半是 `security` 而不是 `Agent Monitor`，
而且「重新 `pnpm package` 之后可能需要再点一次」这句也就不成立。

这段是用户唯一的操作指引，写错了会让人在弹框里找不到 README 描述的那个程序名。
建议 executor 实机截一张弹框对一下文案（只需要一次，不必写进仓库）。

### 7.6 P2 · 已提交的 M0 基线截图被本轮改写
置信度：高 · `git status`：`M design/shots/page-a-x119.png` `page-b-x119.png` `page-b.png`；`design/verify.mjs:5`

三张**已提交的对账基线**被重新生成了（`page-b.png` 从 94 506 → 94 531 字节）。
写它们的是 `design/verify.mjs`，而那个文件里 `SHOTS` 是一条硬编码的绝对路径
（`/Users/tonyye/Projects/Monitor/design/shots`），直接写进仓库的基线目录。

基线的意义在于它不随手被改；一个设计校验脚本顺手覆盖三张历史基线，下次对账就没有参照物了。
（这几张属于 M0/M3 设计侧改动，未必是 M4 executor 有意为之，但它出现在本次待提交的工作区里，提交前要有个说法。）
改法：`SHOTS` 改成相对 `import.meta.url` 解析；基线目录与 verify 的输出目录分开。

### 7.7 ✅ 仓库无构建产物 / 图标中间产物
- `build/` 里只有 3 个交付物（`icon.icns` 122 KB、`trayTemplate.png` 272 B、`trayTemplate@2x.png` 467 B），
  没有 `.iconset/` 残留——`make-icons.py:95` 用的是 `tempfile.TemporaryDirectory()`，出作用域自动清 ✅
- `.gitignore` 覆盖 `dist/` `out/` `test-results/` `*.log` `node_modules/` `design/shots/selftest/` ✅
- `design/shots/m4/` 是 6 张真实截图（给 polish-pass 用），属于交付物，不是中间产物 ✅

### 7.8 ✅ 新增依赖只有一个
`package.json:31` 新增 **`electron-builder ^26.15.3`**（devDependency），与简报一致。
无新增 runtime dependency——`dependencies` 字段整个不存在，所以 asar 里也没有 `node_modules`（实测 85 个文件里一个都没有）✅

### 7.9 P2 · `preload-bundle.test.ts` 的三条断言依赖 `out/` 里最后一次是 build 产物
置信度：低 · `tests/preload-bundle.test.ts:24-49`

三条 `it.runIf(built)` 只判断 `out/preload` 存不存在。`pnpm dev` / `selftest` / `shoot` 也往 `out/` 写 preload（DEV 构建）。
测试作者已经意识到这一点并把「dev 通道被摇掉」那条改成了断言**源码**（`:51-64`，理由写在注释里，很清醒），
但前三条仍然对着产物断言。dev 产物大概率也满足（同样是 CJS 单文件），所以现在不会红，
但这是一条「结果取决于你上一次跑的是哪个命令」的测试。
改法：要么在断言里加一句「产物是 build 而非 dev」的判据，要么把这三条挪进一个需要先 build 的独立 lane。

---

## 8. 结论

| 级别 | 数量 | 清单 |
|---|---|---|
| **P0** | **0** | — |
| **P1** | **3** | §2.2 `settings.json` 非原子写（有半写窗口，且备份路径在写之后才打印）<br>§4.6 `ELECTRON_RENDERER_URL` 在打包产物里未设门（直通连接窗口的 Keychain 写入）<br>§3.5 ⌘W 关掉面板 = 整个 app 退出（默认应用菜单未替换） |
| **P2** | **18** | §1.2 控制字符校验不在 `writeKeychain` 里 · §1.3 无读回校验 · §1.4 无超时 / stdin 无 error · §1.5 连接窗口的 openExternal 与注释矛盾 · §1.6 handler 捕获首次 deps · §1.7 `connect.ts` 零单测 · §2.3 无并发保护 · §2.4 逐字匹配含绝对路径导致孤儿 hook · §3.4 `will-quit` 无 try/catch + SIGTERM 绕过 · §4.5 selftest/shoot chunk 随包发出 · §5.2 权限只在创建时生效 · §5.3 兜底吞掉启动期致命错误 · §5.6 只增容器只做了三分之一 · §6 `ack ≠ 已批准` 未处理也未说明 · §7.4 selftest 读真实钥匙串项 · §7.5 README 钥匙串因果待实测 · §7.6 M0 基线截图被改写 + 硬编码绝对路径 · §7.9 preload-bundle 测试依赖上次跑的是哪个命令 |

### 判定：**修完 3 条 P1 后可提交**

理由：

这一阶段的**主线做得扎实**。最高优先级的钥匙串链路上，`security -i` 从 stdin 读命令
（让密钥不出现在 `ps` 里）是比简报要求的 argv 更好的解法；sender 校验、控制字符拒绝、
`sandbox: true`（连带把 M1 留下的最大一条 P2 关掉）、两个 preload 不共享模块并用测试钉死、
打包白名单实测干净、卸载文档完整——都到位。前序 P2 清单 14 项里 10 项完成、2 项部分完成、
1 项无法复验、1 项未处理，处理方式基本合理且理由写在代码里。

三条 P1 有一个共同点：**都不是功能缺陷，而是「常驻 24/7 + 碰用户全局配置」这个场景放大出来的边界**，
而且三条的改法都在 5 行以内：

1. **§2.2** 是唯一会**损坏用户文件**的路径。仓库自己的 `config.ts:127-133` 已经写好了正确范式（tmp + rename），
   把它抄到两个 installer 里即可，顺手把备份路径的 `console.log` 挪到写之前。
2. **§4.6** 是整套 `isPackaged` gating 里唯一的缺口，而它恰好开在通向钥匙串写入的那条路上。一行 `app.isPackaged ? undefined : ...`。
3. **§3.5** 是这个 app 最难被发现的失败形态——它会安静地整个消失。一句 `Menu.setApplicationMenu` 或 `closable: false`。

18 条 P2 里没有阻塞项。若要在提交前顺手挑两条，我推荐 **§1.3（写入后读回校验）**
——它是钥匙串链路上唯一「错了完全静默」的分支；以及 **§5.3（启动期致命错误的兜底）**
——它决定用户遇到问题时看到的是一个弹框还是「双击了什么都没发生」。

### 本轮未验证、需 executor 或实机补的
- `file://` 下 CSP `'self'` 是否真的匹配（M1 §7.2 点名要在 M4 复验；README 称已实测，我无法启动 app 复现）
- `pnpm selftest` 48 项、`pnpm soak` 30 min −6.7%、登录项注册、Gatekeeper 与钥匙串首次授权弹框的实际文案
- 24 h 常驻下 `codex.files` / `zcode.seen` 两个 Map 的增长斜率（§5.6）

---

## 9. 复验（2026-09-14 晚，executor 修完 3 条 P1 + 一批 P2 后）

只读复验，未改代码、未启动 app。

### 9.1 实跑

| 命令 | 结果 |
|---|---|
| `pnpm test` | ✅ **26 文件 / 374 项**全过（上一轮 25/355，+1 文件 +19 项），exit 0 |
| `pnpm build` | ✅ 两份 `tsc --noEmit` + electron-vite build，exit 0 |
| `pnpm package` | ✅ exit 0，`ad-hoc 签名完成`；`app.asar` 已刷新（22:53，1 274 861 B） |
| 凭据扫描（**最新** `app.asar`） | ✅ 九种模式（`sk-`、`ghp_`、`xox*-`、`AKIA`、JWT、PRIVATE KEY、`Bearer …`、`lazarus`、`@gmail.com`）**全部 0 命中** |
| asar 内容 | ✅ 仍是 85 个文件，无 design/tests/fixtures/node_modules |
| `codesign --verify --deep --strict` + `-dv` | ✅ exit 0，`Signature=adhoc` / `flags=0x2(adhoc)` / `TeamIdentifier=not set` |

### 9.2 三条 P1 逐条核对

**P1-① `settings.json` 非原子写 → ✅ 已落实**

- `scripts/install-claude-hooks.mjs:64-73` / `scripts/install-claude-statusline.mjs:70-79` 新增 `writeAtomic(file, body)`：
  `writeFileSync(\`${file}.tmp-${process.pid}\`, body, {mode:0o600})` → `renameSync(tmp, file)`，
  tmp 与目标**同目录**（rename 才是同一文件系统上的原子操作），失败时 `unlinkSync(tmp)` 收摊、异常照常抛。
- 备份顺序也改了：`hooks:174-175`、`statusline:131-132` 现在是 `copyFileSync` → **`console.log(\`备份：${backup}\`)`** → `writeAtomic`。
  被 SIGTERM 打断的那一次，用户至少能在日志里看到备份在哪。
- 额外修了一处我没提的真问题：`install-claude-statusline.mjs:149` 补上了 import 守卫
  （原来是裸 `main()`，`hooks` 那份早有守卫，statusline 这份没有）。注释说本轮实测踩到过——
  写一个单测 import 它，它就当场对着**用户真实的** `~/.claude/settings.json` 跑一遍安装。**这条比我报的那条更急。**
- 用例：`tests/install-scripts.test.ts`（新增文件，10 条，两个脚本各 5 条）——
  「装完留下备份、结果是合法 JSON、用户自己的内容还在」「卸载把用户原有的那条原样还回去」
  「走 tmp + renameSync，不直接 writeFileSync 到 settings」「备份路径**先打印再写**」
  「被 import 时不执行 main（否则单测会写用户真实配置）」。写法与行为两侧都钉住了。

**P1-② `ELECTRON_RENDERER_URL` 未设门 → ✅ 已落实，且范围比我提的更大**

- `src/main/index.ts:72`：`const rendererUrl = app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL`，
  面板（`:67` 注释）与连接窗口共用这一个值，两处直读全部消失。
- `src/main/index.ts:73`：`setKeychainOverrideAllowed(!app.isPackaged)` —— 我只把
  `MONITOR_KEYCHAIN_SERVICE/_ACCOUNT` 当作放大因子顺带提了一句，executor 把它单独关上了。
  实现在 `collectors/quota/keychain.ts:36-42`（模块级 `overrideAllowed`，默认 `true`，
  理由写清了「单测与脚本跑在 Electron 之外，没人会调这个开关」）。
- 用例：`tests/keychain.test.ts:65-89`「打包后忽略项名覆盖」3 条（关掉后一个字都不认 / 重新打开又认 / 默认是开的）
  + `:91-100`「渲染层 URL 也关在 isPackaged 后面」1 条（断言 `index.ts` 源码里不再直读该环境变量）。

**P1-③ ⌘W 关掉面板 = 整个 app 退出 → ✅ 已落实**

- `src/main/index.ts:245`：`Menu.setApplicationMenu(Menu.buildFromTemplate([{role:'appMenu'},{role:'editMenu'}]))`。
  没有 `windowMenu`（⌘W 的出处）、没有 `viewMenu`（Reload / DevTools 的出处）。
- 保留 `editMenu` 的理由（`:241`）是我没想到但正确的一点：**「连接 ZCode」那个输入框要能 ⌘V 粘贴**——
  macOS 上剪贴板快捷键由菜单提供，菜单里没有 Paste 就真的粘不了，而那个窗口的唯一用途就是粘一枚 Key。
  保留 `appMenu` 是为了留住 ⌘Q 这条有意的退出路径。
- `src/main/index.ts:345-347`：`window-all-closed` 改成只记一行日志、**不再 `app.quit()`**，
  注释说明了语义变化（M1 那条规则是在没有托盘的前提下写的，M4 之后托盘才是本体）。
  SHOOT / SELFTEST 两条路各自显式 `app.quit()`，不受影响。
- 这一项没有自动化用例（菜单构造要碰 Electron API）。可接受，但它是三条里唯一只能靠人眼确认的。

### 9.3 顺带修掉的 P2（逐条看过）

| 编号 | 状态 | 证据 |
|---|---|---|
| §1.2 控制字符校验下沉 | ✅ | `keychain.ts:70` 的 `CONTROL` 常量 + `:100-103` 在 `writeKeychain` 入口拒绝；`connect.ts` 那份保留为给用户看的文案 |
| §1.3 写后读回 | ✅ | `keychain.ts:126-131`：写成功后 `readKeychain` 逐字比，不等就判失败；注释写明「比较只在内存里做，不记日志、不回显」 |
| §1.4 超时 + stdin error | ✅ | `keychain.ts:76`（`WRITE_TIMEOUT_MS = 60_000`，注释解释为什么是 60 s 而不是更短）、`:122` 的 `child.stdin?.on('error', …)` |
| §1.5 连接窗口 openHandler | ✅ | `connect.ts:101-104` 现在无条件 `deny` + 记一行，https 分支删掉了；注释改成了与代码一致的说法 |
| §1.6 handler 捕获首次 deps | ✅ | `connect.ts:65` 提成模块级 `let current: ConnectDeps = {}` |
| §1.7 `connect.ts` 零单测 | ✅ | `connect.ts:40` 抽出 `export function validateKey(raw: unknown)`；`tests/keychain.test.ts:102-131` 5 条 `it` / 10 个 `expect`，覆盖 trim、非文本、空串、纯空白、控制字符、「注入一条 `add-generic-password`」、以及「引号 / 反斜杠 / 空格是**合法**的，不在这里拒」。（executor 汇报的「11 用例」按 `expect` 数算是 10，按 `it` 数是 5；不影响结论，记一笔以免下次对不上账。） |
| §6 ack ≠ 已批准 | ✅ 定了并写在码里 | `collectors/events/feed.ts:119-132`：**保持现状不改**，理由是面板只读、上游只有「我在等你」没有「他批完了」，没有解除信号就没有正确的落回时机；并写明了替代方案（一直 attention 到下一条事件）的代价。这正是简报 §5 要的「做不了的写理由」 |
| §7.4 selftest 读真实钥匙串项 | ✅ 主要一半 | `keychain.ts:150-156` 新增 `keychainItemExists`（`find-generic-password` **不带 `-w`**，只问在不在、不取明文）；`selftest.ts:580` 改用它。**残留**：这条 check 仍要求 `realStillThere === true`，所以在一台从没连过 ZCode 的机器上仍会红，而红因与被测行为无关 |

### 9.4 新增的一条观察（P2）

**`writeAtomic` 会把 `~/.claude/settings.json` 的权限改成 0600**
置信度：高 · `scripts/install-claude-hooks.mjs:66-68`、`install-claude-statusline.mjs:72-74`

`writeFileSync(tmp, body, { mode: 0o600 })` + `renameSync` 的组合里，**rename 带过去的是 tmp 的 mode**。
原来的就地 `writeFileSync` 是保留目标文件既有权限的。
对一份 per-user 配置来说这是收紧、不是放松，方向没错；但它是一个用户没要求、也没被告知的副作用
（若原文件是 0644，某些按组读取的工具链会突然读不到）。
要么在两个脚本里先 `statSync` 原文件、把它的 mode 透传给 tmp，要么在输出里说一句「已将权限收紧到 0600」。

（另：coordinator 汇报里写的「两个安装脚本**与 install.ts** 改 tmp+rename」，`install.ts` 这半句不准确——
`src/main/install.ts` 本来就一个字节都不写文件，本轮也没变，原子写全在两个 `.mjs` 里。不影响结论。）

### 9.5 仍然挂着的 P2（10 旧 + 1 新 = 11 条，均不阻塞）

| 编号 | 项 | 备注 |
|---|---|---|
| §2.3 | 与 Claude Code 并发写 settings.json 无保护 | 单机单用户、用户主动触发，可接受 |
| §2.4 | `isOurs` 逐字匹配含绝对路径 → 换装法会留孤儿 hook | 建议至少写进 README |
| §3.4 | `will-quit` 四个 handler 无各自 try/catch；`install-app.sh` 的 SIGTERM 绕过 will-quit | `index.ts:285,302,317,340` 未变，全文仍无 `process.on('SIGTERM')` |
| §4.5 | selftest / shoot chunk 随包发出 | 最新 asar 里仍有 `/out/main/chunks/selftest-DdWsA7ok.js` |
| §5.2 | 日志目录 / 文件权限只在创建时生效 | `log.ts` 全文仍无 `chmodSync` |
| §5.3 | `installCrashGuards` 吞掉启动期致命错误 | 未动。P1-③ 之后影响还大了一点点：窗口全关也不退，所以「活着但没有 UI」这个形态更容易出现 |
| §5.6 | `codex.files` / `zcode.seen` 两个只增 Map | 24 h 实机验证时看 RSS 斜率 |
| §7.5 | README 钥匙串授权因果待实测 | 未动 |
| §7.6 | 三张 M0 基线截图被改写 + `design/verify.mjs` 硬编码绝对路径 | `git status` 仍显示 `M design/shots/page-{a-x119,b-x119,b}.png`，提交前要有个说法 |
| §7.9 | `preload-bundle.test.ts` 依赖上次跑的是 build 还是 dev | 未动 |
| §9.4 | **新增**：`writeAtomic` 顺手把 settings.json 改成 0600 | 方向对，但是个未告知的副作用 |
| — | §7.4 的残留半条 | selftest 仍要求本机已连过 ZCode |

### 9.6 复验判定：**可提交**

**P0 = 0，P1 = 0，P2 = 11（全部不阻塞）。**

三条 P1 全部落实，且修法比我建议的更完整：P1-② 顺手把 `MONITOR_KEYCHAIN_SERVICE/_ACCOUNT`
一起关进了 `isPackaged`；P1-③ 想到了「去掉菜单会让连接窗口粘不了 Key」这一层，保留 `editMenu`；
P1-① 还捎带发现并修了 `install-claude-statusline.mjs` 缺 import 守卫——那条比我报的半写窗口更急，
因为它是「写个单测就会误改用户真实配置」，而不是「被信号打断才会」。

八条 P2 一并修掉，其中 §1.3（写后读回）与 §1.7（`validateKey` 抽成纯函数 + 10 个断言）
把钥匙串链路上最后两处「错了完全静默」和「最高危的代码没有单测」都补上了。
`§6 ack ≠ 已批准` 按简报 §5 的要求给了明确的「不改 + 理由」，清单闭合。

测试从 355 涨到 374（+19），新增的 `tests/install-scripts.test.ts` 是**跑真实脚本对着临时 settings 文件**
走装 / 卸来回，不是只测纯函数——这正是 §7.2 点名的那块空白。

剩下的 11 条 P2 没有一条会损坏用户数据或泄漏凭据。若要挑一条在提交后优先处理，
仍然是 **§5.3（启动期致命错误的兜底）**——P1-③ 把「窗口全关也不退」定成了新语义之后，
「进程活着但一个 UI 都没有」这个形态更容易出现，而用户看到的仍然只是「双击了什么都没发生」。

---

## 10. 复验 2（2026-09-15，newslink / titles / app.css button）

只读复验，未改代码、未启动 app。`pnpm test` **28 文件 / 436 项**全过（上一轮 26/374，+2 文件 +62 项），
`pnpm build` exit 0。

### 10.1 `newslink.ts` + `openNews` —— 逐条核对

**✅ 协议白名单**：`newslink.ts:46` 只认 `https:`。`http:` 也挡（用例 `:57-62` 明确断言
`http://aihot.news/items/x → protocol`）。`javascript:` / `data:` / `file:` 连不到域名那一关就被协议挡下。

**✅ 域名白名单，且后缀相似域确实挡得住**。`allowedNewsHost`（`:22-25`）的判据是
`h === d || h.endsWith('.' + d)`——**点号写在前缀里**，这正是挡住后缀相似域的关键。
我按字符串逐个验算过 `tests/newslink.test.ts:28` 的四个反例：

| 输入 | `.aihot.news` 后缀比对 | 结论 |
|---|---|---|
| `evil-aihot.news`（15 字符） | 末 11 字符是 `-aihot.news`，不是 `.aihot.news` | ❌ 挡住 ✅ |
| `aihot.news.evil.com` | 既不相等也不以白名单项结尾 | ❌ 挡住 ✅ |
| `notaihot.news` | 末 11 字符是 `taihot.news` | ❌ 挡住 ✅ |
| `aihot.virxact.com.evil.io` | 同上 | ❌ 挡住 ✅ |

正例 `aihot.news` / `www.aihot.news` / `a.b.aihot.news` / `AIHOT.NEWS` / `aihot.virxact.com` 全放行（`:22`）。
另外两类花样也被 `URL` 的解析语义自然挡掉，并且有用例（`:69-73`）：
`https://aihot.news@evil.com/x` 的 `hostname` 是 `evil.com` → `host` 拒。

**✅ id 校验**：`validNewsId`（`:56-62`）要求字符串、非空、`≤ MAX_NEWS_ID (64)`、无控制字符；
**故意不挡空格**，理由写在注释里（缺 id 时兜底生成的是 `aihot:<序号>:<标题前 16 字>`，标题里有空格）。
用例 `:76-98` 覆盖 cuid、兜底 id、非字符串 / 空串 / 超长、控制字符、空格。

**✅ sender 校验**：`index.ts:160` 的 `if (!fromPanel(e)) return` 是这个 handler 的第一行。

**✅ 渲染层 / NewsData / 缓存 / IPC 里都没有 url**：
- `shared/types.ts:138-146` 的 `NewsItem` 无 `url`；`tests/newslink.test.ts:114-119` 直接读源码断言
  `export type NewsItem` 到 `export type NewsData` 之间不许再出现 `url?:`——**加回去就会红**，正是要的那条闸门。
- `:101-112` 另一条拿真实 fixture 跑 `parseFeed`，断言每个 item 的 `Object.keys` 不含 `url`，
  而 `links` 表里查得到——两边同时钉住「渲染层没有 / 主进程有」。
- 链接只活在 `NewsCollector.links`（`news.ts:197`）这个进程内存 Map 里，
  `v2.ts:109` 落盘的是 `NewsData`（无 url），`:111` 回灌的也是它。
  **冷启动那一程 `linkFor` 必然返回 undefined**，闸门给 `missing`，日志写「缓存回灌那一程还没抓到」——
  行为与文案一致，不是 bug。
- preload（`preload/index.ts:32-35`）只 `send(CH.openNews, id)`，桥上没有任何能传 URL 的方法。

**⚠️ 「只取 links.aihot 不回退原文」——准确说法要修一个字**
置信度：高 · `collectors/news.ts:95-104`

`pickUrl` 的候选是 `[links.aihot, item.url]`，**确实不回退 `links.original`**（那是关键的一条），
但它**会回退顶层 `url` 字段**。本机 fixture 的条目根本没有顶层 `url` 键（实测 `Object.keys` =
id/title/summary/source/links/publishedAt/category/reason），所以现在走不到这条；
可一旦 AIHOT 换了响应形状，`item.url` 是什么就由对方决定了。
**不构成漏洞**——主进程的 `checkNewsLink` 会把任何非白名单域挡在 `shell.openExternal` 之前，
纵深防御在这里正好兑现。但汇报口径写成「只取 links.aihot」会让下一个人以为数据层已经封死。
建议要么删掉 `item.url` 这个候选，要么在 `pickUrl` 里就套一次 `allowedNewsHost`。

（另：`news.ts:92` 的注释把主进程那个函数叫 `safeNewsUrl`，实际名字是 `checkNewsLink`，顺手改一下。）

**⚠️ `shell.openExternal` 有两个调用点，闸门只管住了一个**
置信度：高（机制确定）· `index.ts:171`（过闸门）vs `window.ts:87`（未过闸门）

```ts
// window.ts:86-90 —— 面板窗口的 setWindowOpenHandler
if (url.startsWith('https://')) void shell.openExternal(url)
```

这条是 M1 遗留的（那时 E 页还是 `a[target=_blank]`）。它对 URL 只有「以 https:// 开头」一个判据，
**不过域名白名单**。所以对「`shell.openExternal` 之前是否只可能收到通过闸门的 URL」这个问题，
准确答案是：**今天是，但不是因为闸门管住了全部出口，而是因为另一个出口目前无人可达。**

我按可达性正查了一遍，结论是当前**不可达**：
- `renderer/app.ts` 全文没有 `window.open`，也没有任何 `<a>`（E 页的行是 `<button data-news>`，`:680`）；
- 新闻文本一律经 `esc()`（`:188-189`，转 `& < > "`）后插进**双引号**属性与文本节点，构不出 `<a>`；
- CSP `default-src 'none'`，`will-navigate` 全拦。

但它是一条「下一次有人在面板里写一个 `<a target="_blank">` 或 `window.open` 就自动绕过白名单」的路。
既然 E 页已经改成不持有 URL，这个 handler 也没有理由再保留 https 分支——
改成和 `connect.ts:101-104` 一样无条件 `deny` 即可（那边本轮刚这么改过）。记 **P2**。

**小记**：`tests/newslink.test.ts:69` 的用例名写「用户信息 / 端口这类花样过不了域名这关」，
但 `:72` 断言的是 `https://aihot.news:8443/items/x` 的 `ok === true`（端口**放行**，只要主机在白名单里）。
行为本身没问题（同一台主机），是用例名与断言对不上，容易误导下一个读的人。

### 10.2 `collectors/events/titles.ts`

**✅ 全程只读、不改 mtime**。全文对文件系统只用 `readdir` / `stat` / `readFile(p,'utf8')` /
`open(this.index, 'r')` + `fh.read(...)` / `watch`。我正查了一遍
`writeFile|appendFile|unlink|rename|chmod|utimes|open(...,'w'|'a')`——**0 命中**。
`open(..., 'r')` 只可能影响 atime，不碰 mtime。用户桌面端的账本是安全的。

**✅ 异常 JSON 不崩**，三层兜住：
- `parseClaudeSession`（`:66-77`）/ `parseCodexIndexLine`（`:80-96`）逐字段 `typeof` 校验，坏的返回 `null`；
  后者的 `JSON.parse` 单独包 try——注释写明「整份文件不能被一行毁掉」；
- `scanClaude` 每个文件各包一层 try（`:196-204`），注释点名「正在写一半的 JSON / 刚被删掉：下一轮再说」；
- `scan()`（`:167-178`）整体 try/catch → 只 log。
用例 `:58-66`（缺字段 / 空标题 / 不是对象）、`:90-96`（坏行、空行、缺字段）、`:202`（两处都不存在时安静返回）覆盖到。

**✅ 递归深度**：`walk(d, depth)` 6 层封顶（`:186`），注释说明为什么不能写死两层
（层数是桌面端的实现细节，写死了将来会「静默地一条标题都读不到」——最难查的那一类）。
用例 `:127`「埋在两层目录下也找得到」。

**✅ Codex 增量读**：`size < codexOffset → 归零`（`:213`，被截短时从头来，用例 `:186`）；
`size === codexOffset → return`；单次 `MAX_CHUNK = 2 MB` 封顶，剩下的下一轮接着读；
半行 `lines.pop()` 留到下一轮，offset 只推进到最后一个换行（`:227-230`，用例 `:170`）。
`codexOffset += bytesRead - Buffer.byteLength(tail, 'utf8')` 用**字节数**而不是字符数，中文标题不会算错。✅

**✅ `Feed.retitle` 只改 title**：`feed.ts:85-93` 是 `{ ...e, title }`，其余字段整份带过；
`e.title === title` 时原对象直接返回（不产生新引用，调用方据此不写盘不重画）。
用例 `:211-275` 8 条，逐条钉住「id / 已读 / 种类 / 时间一个都不动」「没有 sessionId 的不误伤」
「已读的那条也改」「agent + sessionId 两个都认，不串台」「一样就返回 0」「标题先到 → 0」。

**mtime 缓存的正确性**——有一处顺序值得改（**P2**，置信度：中）·`titles.ts:199-201`

```ts
const m = (await stat(p)).mtimeMs
if (this.seenAt.get(p) === m) continue
this.seenAt.set(p, m)                       // ← 先记
this.offer(parseClaudeSession(JSON.parse(await readFile(p, 'utf8'))))   // ← 后读
```

mtime 在**读之前**就记下了。若这一次正好读到一份写了一半的 JSON（`JSON.parse` 抛，被外层 try 吞掉），
这个文件就会被**一直跳过，直到它的 mtime 再变一次**。桌面端多半是写临时文件再 rename（rename 会带来新 mtime），
所以实际大概率自愈；但正确的顺序是「解析成功之后再记 mtime」，代价为零。
缓存本身的方向是对的——它挡的正是 M3 §5 那个形状（5 s 轮询把本机 65 份整读一遍，随会话数单调变差）。

另两条小的：
- `seenAt` 是**只增 Map**，文件删了也不清（同 §5.6 那一类）。本机 65 条量级，不阻塞。
- `MONITOR_CLAUDE_SESSIONS_DIR` / `MONITOR_CODEX_INDEX` 两个环境变量**没有关在 `app.isPackaged` 后面**，
  与 P1-② 刚刚给 `MONITOR_KEYCHAIN_SERVICE` 定下的先例不一致。危害远低于那一条
  （这两个只能让 app 去**读**另一个目录，读到的文本还要过 `oneLine` + `clip(80)` 再进 DOM，
  且渲染层用 `esc()`），最坏是在自己屏幕上伪造几行会话标题。记 P2，按同一条原则收口即可。

### 10.3 `app.css` STAGE 段之外新增的 button 重声明

**✅ 值与原型逐字一致，且新增项只做默认外观覆盖。**
我把 `app.css:505-513` 与原型 `design/variations.html:925-933` 逐条对齐过：

| 声明 | 原型 `a.e-item` | Electron `button.e-item` | 判定 |
|---|---|---|---|
| `text-decoration` | `none` | `none` | 逐字相同 |
| `color` | `inherit` | `inherit` | 逐字相同 |
| `border-radius` | `var(--r-sm)` | `var(--r-sm)` | 逐字相同 |
| `margin-inline` | `calc(var(--sp-xs) * -1)` | `calc(var(--sp-xs) * -1)` | 逐字相同 |
| `padding-inline` | `var(--sp-xs)` | `var(--sp-xs)` | 逐字相同 |
| `transition` | `background var(--dur-state) var(--ease-standard)` | 同左 | 逐字相同 |
| `:hover` | `background:var(--surface)` | 同左 | 逐字相同 |
| `:focus-visible` | `outline:none;box-shadow:0 0 0 2px var(--accent)` | 同左 | 逐字相同 |
| `:hover/:focus .e-go` | `color:var(--ink)` | 同左 | 逐字相同 |

新增的 7 条全部是 UA 默认值的中和，没有一条引入新的视觉决策：
`appearance:none` / `background:none` / `border:0` / `font:inherit` / `text-align:inherit`
（这五条纯粹是把浏览器给 `<button>` 的 ButtonFace 底、1px 边框、居中、系统字体清掉）、
`padding-block:0`（UA 给 button 的是 1px，`<a>` 本来是 0，这是**对齐锚点**而不是改版式）、
`cursor:pointer`（`<a href>` 的 UA 默认就是 pointer，button 是 default——同样是**还原**锚点行为，
且与画布里 `.dots button` / `.edge` 的既有写法一致）。
`.page-e .e-go`、`.page-e .e-item` 这些不带标签限定的规则没有被重复声明，正确。

**⚠️ 这份副本没有任何东西盯着它与原型同步（P2，置信度：高）**
`tests/stage-css-port.test.ts` 的 `portedStage()` 取的是 `STAGE_HEAD → HARNESS_HEAD` 之间那一段，
而这个 button 块在文件**末尾、harness 之后**，落在断言范围之外。
于是：designer 改了原型的 `a.e-item`，`stage-css-port` 会红在 STAGE 那一半，
**button 这一半会静默落后**——而它正是 E 页真正生效的那一份。
文件里的注释已经说了「改样式请改原型，不要改这里」，但那是一句纪律，不是一条断言。
补一条很轻的测试即可：把原型 `a.e-item` 那几条的**值**抽出来，与 `button.e-item` 块里同名属性逐一比对。

（另：原型的点击守卫里有 `|| attnActive`（`variations.html:3372`），Electron 版的
`app.ts:1047-1054` 没有这一条。实际不需要——非当前页由 `app.css:89-91` 的
`pointer-events:none` 加 `app.ts:826` 的 `inert` 双重挡住，attention 接管时 E 页点不到。已核，不记问题。）

### 10.4 复验 2 判定：**可提交**

**P0 = 0，P1 = 0，P2 = 16。**

两块新代码的安全形状都立得住。`newslink.ts` 把「唯一一处把外部输入交给 OS 的地方」抽成了
可以被正面打的纯函数，四道闸门（sender / id / 协议 / 域名）各自独立、各有用例，
后缀相似域这一类最容易写错的判据用的是「点号写在前缀里」这个正确写法，并且有反例用例钉着。
「渲染层不持有 URL」这条做到了架构层面——不是靠自觉，而是靠一条读源码的断言 + 一条跑 fixture 的断言。
`titles.ts` 对用户桌面端账本的只读纪律经得起正查（写操作 0 命中），
异常 JSON 三层兜底，增量读的字节记账与半行处理都对，`retitle` 是纯粹的字段替换且有 8 条用例。

本轮新增 4 条 P2（§10.1 的 `pickUrl` 回退顶层 `url`、`window.ts:87` 第二个未过闸门的
`openExternal`、§10.2 的 mtime 先记后读、§10.3 的 button 副本无人盯同步），
外加两条口径 / 命名上的小记（`safeNewsUrl` 注释名、端口用例名）与两条与既有条目同类的
（`seenAt` 只增归入 §5.6、两个 titles 环境变量归入 P1-② 的同一条原则）。
加上此前挂着的 11 条，**P2 共 16 条，仍无一条阻塞提交**。

若要挑一条现在就做：**`window.ts:87` 改成无条件 `deny`**。E 页已经不持有 URL 了，
那个 https 分支失去了存在理由，而留着它就等于在白名单之外留了第二个出口——
今天不可达，靠的是「渲染层碰巧没有 `<a>`」这种会被下一次改动推翻的前提。
