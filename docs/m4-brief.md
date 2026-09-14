# M4 简报 · 打磨与交付

> 给 executor agent 的实现简报。M3（事件采集 + v2 六页）提交后进行。M4 的目标：把 app 变成一个装在 `~/Applications` 里、开机自起、不用再碰终端的常驻程序。

## 先读

1. `PLAN.md` §4（架构）、§5 M4 行、§7 决策 3（通知只在副屏高亮 + 轻提示音，不发系统通知）
2. `docs/review/m1-*.md`、`m2-*.md`、`m3-*.md` 里被推迟到 M4 的 P2（sandbox、CSP under file://、Keychain 弹框、reduced-motion 静音等）
3. `src/main/index.ts`、`shortcuts.ts`、`config.ts`（现有生命周期与配置）

## 交付

### 1. 托盘菜单（唯一的设置入口）

菜单项，按此顺序：
- `Agent Monitor · 运行中`（禁用项，显示版本与所在显示器）
- 分隔
- `静音提示音`（勾选，持久化到 config）
- `总在最前`（勾选，持久化；默认关）
- `回到总览页`
- 分隔
- `连接 ZCode…`：打开一个最小窗口（400×160，只有一个密码型输入框、说明一行、「保存」「取消」），保存到 Keychain `agent-monitor / zcode-bigmodel`（用 `security add-generic-password -U` 或 keytar 同等；不落盘明文）；已有 Key 时菜单显示「更换 ZCode Key…」
- `Claude 采集：已接入 / 未接入`（子菜单：安装 statusline 采集、安装 hooks、全部卸载；调用现有两个安装脚本，完成后弹一条托盘提示）
- `校准横向比例…`（切换校准叠层，等价 ⌃⌥C）与 `重置横向比例`
- 分隔
- `打开日志文件夹`、`退出`

托盘图标：16×16 模板图（`Template.png` 命名，黑白，macOS 自动反色），monoline，1.6px 描边；不用 emoji。

### 2. 登录自启

`app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true })`；托盘菜单里可勾选关闭。单实例锁已有，确认二次启动只是把已有窗口带到副屏。

### 3. 打包

- electron-builder，`mac` target `dir`（不做 dmg），`productName: "Agent Monitor"`，`appId: com.tonyye.agent-monitor`，输出到 `dist/mac-arm64/Agent Monitor.app`，再提供 `pnpm install:app` 脚本用 `ditto` 复制到 `~/Applications/`（覆盖前备份旧版）。
- ad-hoc 签名（`identity: null` + `codesign --force --deep -s -`），`hardenedRuntime: false`；首次启动若被 Gatekeeper 拦下，README 写明 `xattr -cr`。
- 打包后的 app 读 Keychain 时 macOS 会弹「允许访问」框，实测一次并在 README 写明点「始终允许」。
- 图标：`build/icon.icns`，与托盘同一套 monoline 图形放大版，深色底。

### 4. 长期运行

- collector 异常不能让主进程退出：所有 collector 包在 try/catch + 退避里（复核已确认大部分），补一个全局 `process.on('uncaughtException')` 记日志不崩。
- 日志轮转：`~/Library/Logs/Agent Monitor/main.log`，超过 5 MB 滚动，保留 3 份。
- 内存：`pnpm soak` 脚本跑 30 分钟，每分钟记录 RSS，增长超过 30% 视为泄漏；24 h 由用户实机验证。
- 渲染层崩溃自动 reload；显示器全部拔掉时不崩（回落主屏已有）。

### 5. 被推迟的 P2 清单

逐条处理复核报告里标注 M4 的项：`sandbox: true` 可行性、`file://` 下 CSP、reduced-motion 时静音、Keychain 弹框说明、`design/aspect-test.html` 归档到 `design/tools/`。做不了的写理由。

### 6. polish-pass（设计侧）

移植完成后请 lead 派 reviewer 对 app 真实截图跑 claude-design-system 的 `polish-pass`（accessibility-audit / ai-slop-check / hierarchy-rhythm-review / interaction-states-pass），你只需在汇报里列出 `design/shots/m4/` 的六页真实截图供其使用。

## 验收（PLAN.md §5 M4）

1. `pnpm package && pnpm install:app` 后，`~/Applications/Agent Monitor.app` 双击启动，落在副屏，托盘图标出现。
2. 重启登录后自动启动（用户实机验证，写清验证步骤与关闭方法）。
3. 托盘各项可用：静音、置顶、连接 ZCode（用临时 service 名测试保存与读取，不动真项）、采集安装/卸载往返、校准、退出。
4. `pnpm soak` 30 分钟 RSS 增长 < 30%；日志轮转生效。
5. `pnpm test`、`pnpm build`、`pnpm selftest` 通过；README.md 写清安装、首次授权、卸载（含还原 settings.json 的两条命令）。

## 不要做

- 不发 macOS 系统通知（决策 3）。
- 不做自动更新、不做 dmg、不做多显示器同时显示。
- 不改 `~/.claude/settings.json`（安装脚本只在用户点托盘菜单时执行）。
- 不 commit。

## 汇报

不超过 300 字：文件清单、验收 1–5 状态与证据、Gatekeeper / Keychain 首次授权的实测、未验证项。
