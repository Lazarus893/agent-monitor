# M2 简报 · 真实额度采集

> 给 executor agent 的实现简报。M1 骨架已提交（commit「M1: Electron shell」）。M2 的目标：三块瓦片显示真实额度并每分钟刷新，错误态真实可复现。不接完成事件（M3）。

## 先读

1. `PLAN.md` §2.1（三家额度来源，每条已实测）、§2.3（数据模型）、§4、§6（风险）
2. `src/main/state.ts`、`src/shared/types.ts`（M1 的状态与类型，M2 在其上填数据）
3. `design/fixtures/extract.py`（三家接口的真实解析样例：codexbar JSON、智谱 quota/limit、Keychain 读取方式）
4. `design/review/00-designer-notes.md` 里 error / empty 态的文案（401 未授权、429 限流、离线、未连接，各自的「原因 + 下一步」），渲染层已实现，采集层只需给出正确的 `error.code`
5. `~/.claude/coralline/statusline.sh` 第 85–100 行：Claude Code 喂给 statusline 的 JSON 里 `rate_limits.five_hour / seven_day` 的字段名

## 三个 collector（都放 `src/main/collectors/quota/`）

| 文件 | 来源 | 周期 | 输出 |
|---|---|---|---|
| `codex.ts` | `spawn("codexbar", ["usage", "--provider", "codex", "--json"])`，PATH 里找不到就试 `/opt/homebrew/bin/codexbar` | 60 s | `primary` → `5h`，`secondary` → `7d`；`usedPercent`、`resetsAt`；`loginMethod` 进 plan |
| `claude.ts` | ① 主：读 `~/.agent-monitor/claude-ratelimits.json`（由下面的 statusline tee 写入，含写入时间）；② 备：Keychain `Claude Code-credentials` 里的 `claudeAiOauth.accessToken` 调 `GET https://api.anthropic.com/api/oauth/usage`，Header `Authorization: Bearer`、`anthropic-beta: oauth-2025-04-20` | ① 每 15 s 读文件；② 仅当文件不存在或超过 10 min 未更新时调用，最少间隔 5 min，429 后指数退避到 30 min | `five_hour` → `5h`，`seven_day` → `7d`；`used_percentage`、`resets_at`（可能是 epoch 秒或 ISO，两种都解析） |
| `zcode.ts` | Keychain：`security find-generic-password -s agent-monitor -a zcode-bigmodel -w`；`GET https://open.bigmodel.cn/api/monitor/usage/quota/limit`，Header `Authorization: <key>`（不加 Bearer） | 60 s | `TOKENS_LIMIT unit 3 number 5` → `5h`；`unit 6` → `7d`；`TIME_LIMIT` → `1mo`（current / total / unit「MCP 调用」）；`level` 进 plan |

### 统一行为

- 调度器 `src/main/collectors/scheduler.ts`：每个 collector 独立定时，带 ±10% 抖动，同一 collector 不并发，超时 15 s，连续失败指数退避（最多 10 min），成功后复位。
- 错误映射到 `AgentState.error.code`：`unauthorized`（401 / 令牌过期）、`rate_limited`（429）、`network`（超时、DNS、离线）、`missing_key`（Keychain 无项 → ZCode 显示「未连接」空态）、`missing_tool`（codexbar 不存在）。上一轮成功的数据在出错时保留并标 `stale: true`，渲染层已有 stale 表现则用，没有就在倒计时旁显示「数据 N 分钟前」。
- `updatedAt` 每次成功写入；渲染层的倒计时按 `resetsAt` 自算，不依赖轮询。
- 日志：每次采集一行 `[quota:codex] ok 5h=22% 7d=7% in 812ms` 或 `[quota:zcode] error network in 15001ms`，不打印任何令牌。
- Dev IPC 保留：`dev.setState` 仍能把三家切到七种状态用于截图；新增 `dev.forceError(agent, code)`。

### statusline tee（Claude 主来源）

- `scripts/claude-statusline-tee.sh`：从 stdin 读 JSON，原样写到 `~/.agent-monitor/claude-ratelimits.json`（加 `writtenAt`），再把原 JSON 通过管道交给原来的 statusline 命令，输出不变。写文件失败不影响原命令。
- `scripts/install-claude-statusline.mjs`：读 `~/.claude/settings.json`，先备份到 `~/.claude/settings.json.bak-<时间戳>`，把 `statusLine.command` 改为 `bash <绝对路径>/claude-statusline-tee.sh -- <原命令>`；幂等（已安装则不重复包）；`--uninstall` 还原。**脚本只写不运行**，由 lead 决定何时安装。
- 安装前后 statusline 的可见输出必须一字不差，写一个测试用 coralline 的样例 JSON 跑一遍对比。

## 测试

- `tests/collectors/*.test.ts`：三家解析器用真实样本（把 `design/fixtures/_codex_raw.json`、智谱返回样例、statusline JSON 样例、OAuth usage 样例脱敏后放 `tests/fixtures/`）；错误映射；调度器退避；stale 语义。
- `pnpm selftest` 增：真实采集一轮后三块瓦片数字与 `codexbar usage --provider codex --json`、智谱接口当场返回一致（Claude 若无 statusline 文件则允许 OAuth 或 stale）。

## 验收（PLAN.md §5 M2）

1. `pnpm dev` 后 60 s 内三块瓦片显示真实数字与倒计时；主进程日志三条 `[quota:*] ok`。
2. 数字与 `codexbar`、Claude `/usage`、智谱控制台一致（截图 + 日志对照写进汇报）。
3. 断网 30 s：三块进入离线 error 态且保留上次数字标 stale；联网后自动恢复。
4. 删掉 Keychain 里的 ZCode 项（测试时用一个临时 service 名模拟，不要动真项）→ ZCode 显示「未连接」。
5. `pnpm test`、`pnpm build` 通过；无凭据出现在日志、截图、仓库。

## 不要做

- 不接完成事件（M3）、不做托盘 / 自启 / 打包（M4）。
- 不修改 `~/.claude/settings.json`（只写安装脚本）；不读 `~/.codexbar/config.json`、`~/.codex/config.toml`（里面有明文 key，本项目不碰）。
- 不把任何 key、token、邮箱写进仓库、日志或截图。
- 不 commit。

## 汇报

不超过 300 字：文件清单、验收 1–5 状态与证据、statusline tee 的安装命令与还原命令、未验证项。
