# Agent Monitor

副屏上常驻的一块面板，只回答两个问题：**三个 agent 还剩多少额度**，**谁刚做完 / 谁在等我**。

跑在 TYPE-C 副屏（960×540 @2x）上；副屏不在就回落到主屏一个 960×540 的窗口。
没有设置界面 —— 所有开关都在**托盘菜单**里。

设计与方案见 `PLAN.md` 与 `DESIGN.md`，各阶段简报在 `docs/`。

---

## 安装

```bash
pnpm install
pnpm package        # 构建 + electron-builder + ad-hoc 签名 → dist/mac-arm64/Agent Monitor.app
pnpm install:app    # ditto 到 ~/Applications（覆盖前自动备份旧版，只留最近 2 份）
```

然后在「访达 → 应用程序 →（个人）Applications」里双击 **Agent Monitor**。

只打 macOS arm64、只打 `dir`（不做 dmg、不做自动更新）：这个 app 只装在你自己这台机器上。

### 首次启动：三个会弹框的地方

这三处都需要你**亲手点一下**，脚本代替不了。

**1. Gatekeeper（大概率会遇到）**

app 是 ad-hoc 签名的（`codesign -s -`），没有开发者证书、没有公证，所以
`spctl --assess` 会给 `rejected`。从 Finder 双击可能弹「无法打开，因为 Apple 无法检查
其是否包含恶意软件」。两种处理方式，任选一种：

- **右键点 app → 打开 → 在弹框里再点一次「打开」**（推荐，只需要做一次）；
- 或者在终端里去掉隔离属性：

  ```bash
  xattr -cr "$HOME/Applications/Agent Monitor.app"
  ```

> 本机实测：`pnpm install:app` 装出来的这一份**没有** `com.apple.quarantine` 属性
> （`ditto` 从本地构建目录复制，不经过浏览器/下载），直接起得来。
> 如果你把 app 传到别的机器上再打开，才一定会撞上 Gatekeeper。

**2. 钥匙串「允许访问」**

ZCode 的额度要读钥匙串里的 `agent-monitor / zcode-bigmodel`。ad-hoc 签名的 app
每次重新打包，签名标识就变了，macOS 会把它当成「另一个程序」，于是弹
「Agent Monitor 想要访问您的钥匙串中的密钥」。

**请点「始终允许」**（不是「允许」）—— 点「允许」的话，每隔一分钟的下一轮采集会再弹一次。
重新 `pnpm package` 之后可能需要再点一次。

**3. 登录项授权**

首次勾选「登录时启动」时，macOS 可能在「系统设置 → 通用 → 登录项与扩展」里
要你确认一次。

### 开机自启

装好之后**默认开**：app 会把自己注册成登录项（`app.setLoginItemSettings`），
下次开机自动起来并落到副屏。

- **关掉**：托盘菜单 → 取消勾选「登录时启动」。
- **或者**在「系统设置 → 通用 → 登录项与扩展 → 开机时打开」里把 Agent Monitor 关掉 / 删掉。
- 验证：重启 → 登录 → 十几秒内副屏上出现面板、菜单栏出现托盘图标。
  日志里会有一行 `[login] openAtLogin=true → 系统回报 true status=enabled`。

> `openAsHidden` 这一位 Electron 44 已经没有了（macOS 13 起登录项走 SMAppService，
> 那套 API 不带「以隐藏方式启动」）。对这个 app 反而正好：面板本来就该开机后
> 自己出现在副屏上。

---

## 托盘菜单

菜单栏上那个三根竖条的图标（模板图，跟着菜单栏明暗自动反色）。它是**唯一的设置入口**。

| 菜单项 | 说明 |
|---|---|
| `Agent Monitor 0.1.0 · 运行中（TYPE-C）` | 只读。括号里是面板此刻落在哪块屏上 |
| `静音提示音` | 新事件 / 有人等你时那一声轻提示音。持久化 |
| `总在最前` | 默认关。持久化 |
| `登录时启动` | 默认开。持久化 |
| `回到总览页` | 等价 ⌃⌥↑ |
| `连接 ZCode…` / `更换 ZCode Key…` | 打开一个 400×160 的小窗，粘贴智谱 bigmodel 的 API Key，存进钥匙串。**不落盘明文，不进日志** |
| `Claude 采集：已接入 / 未接入` | 子菜单：安装 statusline 采集 / 安装 hooks / 全部卸载 |
| `校准横向比例…` / `重置横向比例` | 等价 ⌃⌥C / ⌃⌥0 |
| `打开日志文件夹` | `~/Library/Logs/Agent Monitor/` |
| `退出` | |

安装 / 卸载完成后，图标右边会闪 3 秒一行字（**不发 macOS 系统通知** —— 决策 3：不打断主屏）。
失败会弹一个对话框，因为那意味着你的 `settings.json` 没被改成你以为的样子。

### Claude 采集装了什么、怎么还原

「安装」这两项会改 `~/.claude/settings.json`，**只在你点菜单时执行**，启动时只读不写。
动手前自动备份成 `settings.json.bak-<时间戳>`。

- `安装 statusline 采集`：把你现有的 statusline 命令包一层
  `scripts/claude-statusline-tee.sh`，把 Claude Code 每秒喂给 statusline 的
  `rate_limits` 抄一份到 `~/.agent-monitor/`。零网络，有会话时实时。
- `安装 hooks`：装 `UserPromptSubmit` / `Stop` / `Notification` / `SessionEnd` 四个 hook，
  每个 `timeout: 3`，命令只是 `curl` 异步 POST 到 `127.0.0.1:47831`，失败静默。

**还原（两条命令，等价于菜单里的「全部卸载」）：**

```bash
APP="$HOME/Applications/Agent Monitor.app/Contents/Resources/scripts"
ELECTRON_RUN_AS_NODE=1 "$HOME/Applications/Agent Monitor.app/Contents/MacOS/Agent Monitor" "$APP/install-claude-statusline.mjs" --uninstall
ELECTRON_RUN_AS_NODE=1 "$HOME/Applications/Agent Monitor.app/Contents/MacOS/Agent Monitor" "$APP/install-claude-hooks.mjs" --uninstall
```

（在仓库里的等价写法：`node scripts/install-claude-statusline.mjs --uninstall`、
`node scripts/install-claude-hooks.mjs --uninstall`。两个脚本都按**整条命令逐字匹配**
只摘自己装的那几条，你自己的 hook 一条不动。）

> **用哪条装的，就得用哪条卸。** 逐字匹配里含脚本的绝对路径，而仓库里的路径
> （`<repo>/scripts/…`）和打包版的路径（`…app/Contents/Resources/scripts/…`）是两个串。
> 用仓库装、用打包版卸，卸不掉，`settings.json` 里会留下一条指向旧路径的孤儿 hook
> （`curl` 每次静默失败，面板收不到事件，也不会报错）。
> 拿不准就搜一下：`grep -n "claude-hook.sh\|claude-statusline-tee.sh" ~/.claude/settings.json`，
> 看它指向哪儿，就用哪一份脚本卸。

写入是**原子**的：先备份成 `settings.json.bak-<时间戳>`（备份路径在动手之前就打印出来），
再写临时文件 `rename` 过去。中途被打断也不会留下半截的 `settings.json`。

## 卸载

```bash
# 1. 退出（托盘 → 退出）
# 2. 还原 settings.json —— 上面那两条命令
# 3. 关掉登录项：托盘里取消勾选「登录时启动」，或在系统设置里删掉
# 4. 删 app 与它的数据
rm -rf "$HOME/Applications/Agent Monitor.app"
rm -rf "$HOME/.agent-monitor"                    # 配置、事件历史、statusline 抄件
rm -rf "$HOME/Library/Logs/Agent Monitor"        # 日志
rm -rf "$HOME/Library/Application Support/Agent Monitor"
# 5. 钥匙串里那枚 ZCode Key（想留着下次用就跳过）
security delete-generic-password -s agent-monitor -a zcode-bigmodel
```

---

## 快捷键

全局，不需要面板有焦点。

| 键 | 作用 |
|---|---|
| ⌃⌥← / ⌃⌥→ | 上一页 / 下一页（手动切换后暂停轮播 120 s） |
| ⌃⌥↑ | 回总览页并恢复轮播 |
| ⌃⌥C | 校准叠层开关（200px 正圆 + 十字线） |
| ⌃⌥] / ⌃⌥[ | 横向压缩补偿 ±0.02 |
| ⌃⌥0 | 横向压缩补偿复位 |

**横向压缩补偿**是什么：这块副屏的 EDID 原生模式是 960×640，你在 960×540 下用，
面板自己的缩放器把画面横向压掉 15.6%。macOS 和 Electron 都看不见这个形变，只能人眼校准。
按 ⌃⌥C 打开叠层，用 ⌃⌥] / ⌃⌥[ 调到那个圆看起来是正圆为止（你实测是 1.19）。
校准页也可以直接在浏览器里开：`design/tools/aspect-test.html`。

---

## 长期运行

- **日志**：`~/Library/Logs/Agent Monitor/main.log`，超过 5 MB 滚成 `main.1.log`，
  最多留 3 份（上限约 20 MB），文件权限 0600。日志里有路径，没有任何凭据。
- **不会因为一个采集器出错就退出**：collector 各自 try/catch + 退避，另有一层
  `uncaughtException` / `unhandledRejection` 兜底，只记日志不崩。
- **渲染进程崩了自动重载**（退避 2 s；我们自己退出时不重载）。
- **副屏拔掉**不崩，回落主屏窗口；插回去 2 s 内落位。
- **`~/.codex/sessions` 越长越慢这件事已经封住**：本机 1624 份 rollout / 391 MB，
  原来每 3 s 全量 `stat` 一遍约占一个核的 0.6%，而且只会一直涨。现在每 3 s 只看
  这一程真读过的文件加今天 / 昨天目录（本机 1 个），老文件降到每 60 s 一次。
- **内存**：`pnpm soak` 跑 30 分钟，每分钟记一次 RSS，以第 2 分钟为基线，
  增长超过 30% 判泄漏（明细写在 `$TMPDIR/agent-monitor-soak/soak.json`）。
  24 小时的那一程由你实机跑。

```bash
pnpm soak                  # 30 分钟
pnpm soak -- --minutes 5   # 改完代码先短跑一轮
```

> soak 会占住副屏、并且单实例锁只允许一个 —— 别和 `pnpm dev` 或已装好的 app 同时开。

---

## 开发

```bash
pnpm dev          # 开发模式（MONITOR_DEBUG=1 可以叫出原型的调试控制栏）
pnpm build        # 两份 tsc --noEmit + electron-vite build
pnpm test         # vitest
pnpm selftest     # 真机自检：走真实采集 + 真实副屏（项数见输出末行）
pnpm shoot        # 七页 × 七态对账截图 → design/shots/m3/
pnpm icons        # 重新生成托盘图与 icon.icns（需要 Pillow，平时不用跑）
```

`selftest` 与 `shoot` 各有独立的临时 `MONITOR_USER_DATA` / `MONITOR_CONFIG_FILE` /
`MONITOR_LOG_DIR` / hook 端口与截图目录，互不覆盖，也不碰你真实的
`~/.agent-monitor`、`~/.claude`、`~/Library/Logs`。

几个开发期的环境变量：

| 变量 | 用途 |
|---|---|
| `MONITOR_LOG_DIR` | 日志挪到别处 |
| `MONITOR_SHOTS_DIR` | `pnpm shoot` 的输出目录 |
| `MONITOR_SHOTS_LIVE_DIR` | `pnpm selftest` 那六张真实截图的去处 |
| `MONITOR_KEYCHAIN_SERVICE` / `_ACCOUNT` | 指到一个**临时**钥匙串项，验收往返用，不碰真实那条 |

### 安全边界

- 两个渲染进程都是 `contextIsolation: true` / `nodeIntegration: false` / **`sandbox: true`**，
  preload 产成 CJS 单文件（沙箱 preload 没有模块解析，不能被拆成 chunks）。
- 面板与连接窗口各有自己的 preload：面板 5 个方法（`subscribe` / `onCommand` / `ack` /
  `setPage` / `rendered`，dev 构建下多一个 `dev` 子对象），连接窗口 2 个（`save` / `close`）；
  主进程侧每个 IPC handler 都校验 `event.sender`。
- CSP `default-src 'none'`，外链只放行 https 且一律交给系统浏览器，`will-navigate` 全拦。
  打包后走 `file://` 已实测：脚本、样式、字体都正常加载，无 CSP 拒绝。
- 调试通道（模拟事件 / 强制错误）由构建期常量守着，`pnpm build` 的产物里整段被摇掉。
- Key 只在内存与钥匙串之间流转：写入走 `security -i`（命令从 stdin 读，`ps` 里看不到密钥），
  不落盘明文、不进日志、不进状态。
