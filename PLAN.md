# Agent Monitor — 副屏监视器方案 v0.1

> 状态：待你过目。批准后按 M0 → M4 逐层推进，每层都是能跑的产品。
> 发布版（含三个布局线框）：见对话里的 Artifact 链接。

## 0. 一句话

在 TYPE-C 副屏（逻辑 960×540）上常驻一块 Electron 面板，只回答两个问题：
**三个 agent 还剩多少额度**，以及 **谁刚做完 / 谁在等我**。

---

## 1. 已核实的本机事实

| 项 | 结论 |
|---|---|
| 副屏 | 名称 `TYPE-C`，物理 1920×1080，逻辑 **960×540 @2x**，位于 Mi Monitor 正上方，坐标 (1728, −540)。**物理尺寸 3.5 英寸**（2026-09-14 用户实测确认），1 逻辑像素 ≈ 0.08 mm |
| 渲染倍率 | 用户在三档字号比对中选 **2x**：app 按 **480×270** 画布设计，整体 `zoom: 2` 铺满 960×540，1 CSS px = 4×4 物理像素。系统分辨率保持 960×540 不动 |
| Codex | CLI 0.147.0；桌面端是 ChatGPT.app 内的 Codex Desktop（cli 0.153.4）；两端会话都落在 `~/.codex/sessions/` |
| Claude Code | 2.1.258；TUI 与 Claude.app Code 标签页共用 `~/.claude/settings.json`；OAuth 凭据在 Keychain（`Claude Code-credentials`），订阅 max 20x |
| ZCode | ZCode.app 3.11.2，内置 `glm/zcode.cjs` 运行时；登录的是 **智谱 bigmodel coding plan**（OAuth），Z.ai 两个 plan 均 not entitled |
| CodexBar CLI | `/opt/homebrew/bin/codexbar`，已启用 codex / claude / zai 等 provider |
| 工具链 | node 22.19、pnpm 9.15、bun 1.3.8、系统自带 sqlite3 3.51 |
| git | `Monitor/` 目前在 `~/Projects` 这个大仓库里（大量 untracked 噪音） |

---

## 2. 数据源（每条都已实测）

### 2.1 额度

| Agent | 来源 | 拿到的字段 | 实测状态 |
|---|---|---|---|
| **Codex** | `codexbar usage --provider codex --json`（内部走 Codex CLI 的 rate limit 接口） | `primary`＝5 小时窗（usedPercent、resetsAt）、`secondary`＝7 天窗（10080 min）、loginMethod | ✅ 正常返回 |
| **Claude Code** | ① Claude Code 每秒喂给 statusline 的 JSON 里就有 `rate_limits.five_hour / seven_day.used_percentage + resets_at`，在 statusline 脚本里 tee 一份到 `~/.agent-monitor/claude.json` ② 备用：Keychain 里的 OAuth token 调 `GET api.anthropic.com/api/oauth/usage`（claude-hud 同款） | 5h / 7d 利用率、重置时间、订阅档位 | ①零网络、有会话时实时；② 今天实测两次都 `rate_limit_error`，只能低频兜底（≥5 min 一次 + 退避） |
| **ZCode** | 智谱 `GET open.bigmodel.cn/api/monitor/usage/quota/limit`，Header `Authorization: <API Key>`（glm-plan-usage 插件同款） | `limits[]`：TOKENS_LIMIT 5h 窗 percentage + nextResetTime；TOKENS_LIMIT 周窗；TIME_LIMIT 月度 MCP 调用（currentValue / usage）；`level` | 返回结构已用 Z.ai 同构接口验证；**ZCode 自己的 OAuth 令牌在 `~/.zcode/v2/credentials.json` 里是 `enc:v1:` 加密的，不可复用** → 需要一枚同账号的智谱 API Key |

> 注：智谱 `unit` 枚举（3＝小时、6＝周）是从两个 nextResetTime 的间隔推断的，实现时再核对一次。

### 2.2 完成事件

| Agent | 机制 | 覆盖范围 | 实测状态 |
|---|---|---|---|
| **Codex** | chokidar 监听 `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`，增量读新行，抓 `event_msg.task_complete`（有 `last_agent_message`、`duration_ms`、`completed_at`），配合同文件 `session_meta`（`cwd`、`originator`） | Desktop + TUI + `codex exec`，**零配置** | ✅ 9 月 12 个会话里 10 个 originator 是 Codex Desktop，事件字段齐全 |
| **Claude Code** | 往 `~/.claude/settings.json` 加两个 hook：`Stop`（完成）、`Notification`（等待批准 / 空闲）。hook 命令只是 `curl` 异步 POST 到面板的 `127.0.0.1:47831/events`，3 秒超时、失败静默；面板再读 `transcript_path` 尾部取最后一条助手消息做摘要。兜底：监听 `~/.claude/projects/**/*.jsonl` | TUI + Claude.app 共用同一份 settings | 目前没有任何 hook；你 2 月曾关掉 SessionStart hooks，所以这里只加最小集、全部异步 |
| **ZCode** | ① 每 3 秒 `sqlite3 -readonly -json ~/.zcode/v2/tasks-index.sqlite` 读 `tasks`（`task_status` ∈ running / pending / completed / failed / cancelled，`title`、`workspace_path`、`model`、`updated_at`）② 实时补充：tail `~/.zcode/cli/log/zcode-YYYY-MM-DD.jsonl` 的 `turn.completed` 事件（带 sessionId 可回连任务） | App 与其内置 CLI 运行时 | ✅ 表里已有 39 条 completed；状态枚举从应用包里找到 |

「等待你」这一档（Codex 的审批请求事件、Claude 的 `permission_prompt` 通知、ZCode 的 pending）放在 M4，机制已确认可行。

### 2.3 统一数据模型

```ts
type AgentId = 'codex' | 'claude' | 'zcode'

type QuotaWindow = {
  label: '5h' | '7d' | '1mo'
  usedPercent: number          // 0–100
  resetsAt: string             // ISO
}

type AgentState = {
  id: AgentId
  status: 'idle' | 'running' | 'attention' | 'offline'
  windows: QuotaWindow[]
  updatedAt: string
  error?: { code: 'unauthorized' | 'rate_limited' | 'network' | 'missing_key'; message: string }
}

type AgentEvent = {
  id: string
  agent: AgentId
  kind: 'completed' | 'failed' | 'attention'
  title: string                // 任务标题或首条 prompt 摘要
  summary?: string             // last_agent_message 首段
  cwd: string
  at: string
  durationMs?: number
  acked: boolean
}
```

---

## 3. 设计治理

### 3.1 DESIGN.md（design-md skill，来源 VoltAgent/awesome-design-md）

已拉取 6 份候选到 `docs/design-md-candidates/`，比较后：

| 候选 | 判断 |
|---|---|
| **raycast（推荐）** | 近黑画布 + 四级 surface 阶梯（#07080a → #0d0d0d → #101111 → #121212）、1px hairline #242728、6–10px 圆角、无投影、Inter + ss03。**关键在于它把彩色只留给语义与分类**——正好是三 agent 监视器要的：每个 agent 一个身份色、状态另用语义色，不存在一个抢戏的品牌主色 |
| linear.app | 同为近黑，但单一薰衣草紫主色会和三个 agent 的身份色打架 |
| warp | 暖棕黑 #2b2622、无彩色主色；若你想要更暖的副屏，这是第二选择 |
| claude / cursor / opencode.ai | 奶白编辑感画布——常亮副屏会刺眼，也是 claude-design-system 明确警告不要用在 dashboard 上的那套 house style |

### 3.2 OpenDesign craft（`~/.claude/docs/open-design-craft/`）

本项目 `od.craft.requires`：`color`、`typography`、`state-coverage`、`accessibility-baseline`、`laws-of-ux`、`animation-discipline`、`anti-ai-slop`。

对这块屏真正会"咬人"的规则：
- **accent 每屏 ≤ 2 处**。三个 agent 的身份色是分类色，不算 accent；好 / 警告 / 危险是语义色，也不算。真正的 accent 只留给「未读 / 需要你」一处。
- **五态齐全**：每块面板都要有 loading / empty / error / populated / edge。这里的 error 很具体：额度接口 401、被限流、离线；edge：任务标题 60 字、cwd 超长路径、一分钟内 8 条事件。
- **ALL CAPS 字距 ≥ 0.06em**；小字 ≥ 11–12px；大数字负字距。
- **动效只用于状态变化**（新事件进入、额度条推进、running 脉冲），尊重 `prefers-reduced-motion`；不做装饰动画。
- 反 slop P0：不用 Tailwind 靛蓝、不用双色渐变、不用 emoji 当图标。

### 3.3 你定义的 workflow（claude-design-system，brand-aware 链）

```
design-system-extract（raycast → tokens.css）
  → wireframe（3 个布局，灰阶，严格 960×540）
  → generate-variations（3 个 hi-fi 变体，单文件可切换，用今天的真实额度数据）
  → make-a-prototype（真实五态、真实事件）
  → polish-pass（accessibility-audit / ai-slop-check / hierarchy-rhythm-review / interaction-states-pass）
```

- 作者与审查分 lane：designer agent 出稿，reviewer agent 用 `~/.claude/design-vocab.md` 的机制词汇评审，不在同一上下文里自评。
- 六条产品原则自检（交付前逐条回答）：主要任务想清了吗（→ §0 两个问题）；砍到只剩一个元素是什么（→「最新一条需要我看的事」）；哪里的品味非它不可（→ 数字与倒计时的字体、agent 身份色）；80 分了吗；用户第一眼感受（→ "都还好 / 有人在等我"）；一致性（三块 agent 面板同一结构、事件行同一结构）。
- 三通病：简洁（没有按钮，没有设置页面在副屏上，配置走托盘菜单）；引导（首次运行只会出现一种引导：缺 Key 时那块面板变成「连接 ZCode 额度」的空态）；品牌感（签名元素放在数字排版与 agent 徽记上，而不是加渐变）。

### 3.4 布局候选（线框见 Artifact）

| | 结构 | 强项 | 代价 |
|---|---|---|---|
| **A 三联竖列** | 三等分列，每列＝额度 + 该 agent 自己的事件 | 身份最强，一列看完一个 agent | 事件被拆散，跨 agent 时序看不出 |
| **B 仪表在上、事件在下（推荐）** | 上带 3 块额度瓦片（约 40% 高），下带统一时序事件流，最新一条放大 | 两个问题各占一眼；跨 agent 时序清楚 | 事件流只能看 4 条左右 |
| **C 左轨 + 右事件** | 左 300px 三行紧凑额度，右侧最新事件做 hero | 通知最显眼，远距离可读 | 额度退成小字 |

**2026-09-14 追加：轮播。** 副屏实测 3.5 英寸后，用户提出分页自动轮播。三个变体各自成为一页：A 总览（V1 的大数字）、B 额度详情（V3 的时间带）、C 事件，**每页停 60 s**（用户实机反馈 10/6/6 s 太快后改定）；新事件打断跳到 C 停满 60 s，「等待你」用专用整屏页接管直到处理完；右下角三点标示当前页。原型带「纯净模式」（`?pure=1` 或按 P）：隐藏控制栏并进入浏览器全屏，用于在副屏上还原最终效果。细则见 `design/brief-m0-rotation.md`。

**2026-09-14 晚追加：v2 改动**（用户第二轮实机反馈，细则 `design/brief-m0-v2.md`）：C 页拆为 C1/C2 两页 session 列表并显示最后更新时间；B 页判语改为「当前窗口用得最多的模型」；新增 D 页 GitHub 式每日用量热力图（数据：`codexbar cost` 每日 token + ZCode 日志请求数）；新增 E 页「今日 AI 大事」5 条（AIHOT 匿名只读 API `GET /api/v1/items?mode=selected&window=24h&limit=5`，个人非商业使用，页面署名「数据来源：AIHOT」）；指示点居中下移；横向压缩补偿 `panelX`（960×540 模式默认 1.185，可用 ⌃⌥[ ] 微调）。

### 3.5 在 raycast 之上的项目特有决定（待 M0 出稿确认）

- 身份色：Claude 陶土橙 `#d97757`、ZCode 智谱蓝（取 GLM 品牌蓝）、Codex 中性白；三者只用于徽记与事件行的色点，不做大面积填充。
- 语义色沿用 raycast：green `#59d499` / yellow `#ffc533` / red `#ff6161`，额度 ≥80% 转黄、≥95% 转红。
- 数字：所有百分比与倒计时用等宽 tabular 数字（候选 IBM Plex Mono / JetBrains Mono），标签沿用 DESIGN.md 的 Inter。这是对 DESIGN.md 的唯一有意偏离，理由是远距离扫读时数字对齐比品牌一致更重要。
- 字号下限取决于 §7 问题 1（屏幕物理尺寸）。

---

## 4. Electron 架构

```
Monitor/
  package.json            electron-vite 5 · Electron 44 · React 19 · TS · Tailwind 4 · zustand · chokidar 5 · electron-builder 26
  src/main/
    index.ts              启动、托盘、单实例
    displays.ts           选屏：label === 'TYPE-C' 或 size 960×540；热插拔时迁移；找不到就 960×540 窗口化
    server.ts             127.0.0.1:47831，只收 Claude hooks 的 POST
    collectors/
      quota/codex.ts      每 60s spawn codexbar
      quota/claude.ts     读 ~/.agent-monitor/claude.json；≥5 min 才走 OAuth 兜底
      quota/zcode.ts      每 60s 调智谱 quota/limit，Key 从 safeStorage 取
      events/codex.ts     chokidar + 增量 jsonl 读取
      events/claude.ts    hooks POST → 事件；读 transcript 尾部做摘要
      events/zcode.ts     sqlite3 -readonly -json 轮询 + cli log tail
    store.ts              归一化状态，diff 后经 IPC 推给渲染层
    notify.ts             可选：系统通知 / 提示音
  src/preload/index.ts    contextBridge：subscribe(state)、ack(eventId)
  src/renderer/           App（480×270 画布 ×2）· Pager（A 总览 / B 额度详情 / C 事件 轮播 + attention 接管，见 design/brief-m0-rotation.md）· QuotaTile · TimeBand · EventFeed · 五态组件
  scripts/
    install-claude-hooks.mjs   幂等写入 Stop / Notification hooks，先备份 settings.json
    claude-statusline-tee.sh   包一层现有 coralline statusline，把 rate_limits tee 出来
  docs/design-md-candidates/   6 份 DESIGN.md
  DESIGN.md                    你选定后放这里，作为唯一视觉真源
```

关键取舍：
- **不用原生 sqlite 模块**（省掉 electron-rebuild），直接 spawn 系统 `sqlite3 -readonly -json`；表很小，3 秒一次没有压力。
- **不动 Codex 的 `notify`**：它已被 Codex Computer Use 客户端占用，且只覆盖 TUI；rollout 监听反而三端全覆盖。
- **窗口**：`frame:false` + 精确 bounds，`simpleFullscreen` 而非 `fullscreen`（避免 macOS 新建一个 Space）；`alwaysOnTop` 默认关。渲染层 `webContents.setZoomFactor(2)`，界面按 480×270 画布布局。
- **安全**：`contextIsolation:true`、`nodeIntegration:false`；Key 只经 `safeStorage` 落在 userData，不进仓库。顺带提醒：探查时发现 `~/.codexbar/config.json` 与 `~/.codex/config.toml` 里有明文 API Key，本项目不读它们，建议你之后挪进 Keychain。

---

## 5. 里程碑与验收

| 里程碑 | 交付 | 验收 |
|---|---|---|
| **M0 设计** ✅ 2026-09-14 | `design/tokens.css`、`design/wireframes.html`、`design/variations.html`（轮播版：A/B/C + attention 页，7 状态，真实数据）、留档 `variations-960x540.html` 与 `variations-35-single.html`、五份评审报告 `design/review/01–05`、作者笔记 `00` | 五轮评审共 3 P0 / 20+ P1 全部修复或有理由跳过；发布前验证 28/28、轮播 12/12 通过；待你在 artifact 里过目 |
| **M1 骨架** ✅ 2026-09-14 | electron-vite 5 / Electron 44；`src/main`（displays.pickTarget、RelocateQueue、state、shortcuts）、`src/renderer`（四页移植、画布参数化）、63 条单测、selftest 14 项、28 张对账截图 `design/shots/m1/` | 代码复核 `docs/review/m1-code-review.md`：1 P0 + 4 P1 修复并复验通过；实机插拔由用户验证（待回报） |
| **M2 额度** | 三个 quota collector + 重置倒计时 | 面板数字与 `codexbar` / Claude `/usage` / 智谱控制台一致 |
| **M3 事件** | 三个 event collector、事件流、未读 / ack、提示音 | `codex exec "echo hi"` 2 秒内出现；`claude -p` 触发 Stop；ZCode 跑一个任务状态翻转 |
| **M4 打磨** | 「等待你」状态、托盘、登录自启、electron-builder 打成 `~/Applications/Agent Monitor.app`、polish-pass | 四项审查过；连续运行 24h 无泄漏 |

每个 collector 的解析器都配 vitest fixture（用本机真实样本脱敏）。

---

## 6. 风险

| 风险 | 应对 |
|---|---|
| Claude OAuth usage 端点限流（今天已复现） | 以 statusline tee 为主，OAuth 只做低频兜底并退避 |
| ZCode 令牌加密不可用 | 需要你提供智谱 API Key；给不出就该面板显示「未连接」空态，其余功能不受影响 |
| Codex 桌面端会话目录格式随版本变 | 解析器容错 + fixture 回归；未知事件类型忽略不崩 |
| hooks 拖慢 Claude Code | hook 命令全异步、3 秒超时、失败静默；提供一键卸载脚本 |
| 副屏热插拔 / 分辨率变化 | `screen` 事件监听，按 label 优先、尺寸次之重新定位 |

---

## 7. 需要你拍板的事（括号里是我的默认）

1. ~~**副屏物理尺寸与观看距离**？~~ **已答：3.5 英寸，桌面座位距离；字号比对选 2x → 画布 480×270**（见 `design/brief-m0-35.md`）
2. ~~**ZCode 额度 Key**~~ **已答：用户提供了 Key，存于 macOS Keychain（service `agent-monitor`，account `zcode-bigmodel`），实测 `open.bigmodel.cn` 与 `api.z.ai` 两个域名返回同一账号（pro 档）。fixtures 与 M2 collector 都从 Keychain 读，Key 不进仓库。**
3. **通知形式**：只在副屏高亮，还是同时发 macOS 通知 / 声音？（默认：副屏高亮 + 一声轻提示音，不发系统通知，避免主屏被打断）
4. **「等待你批准 / 输入」要不要作为最高优先级状态**？（默认：要，M4）
5. **DESIGN.md**：raycast / linear.app / warp？（默认 raycast）
6. **布局**：A / B / C？（默认 B）
7. **Claude hooks**：同意往 `~/.claude/settings.json` 加 Stop + Notification 两个异步 hook？（默认同意）
8. **仓库**：Monitor 单独 `git init`，脱离 `~/Projects` 大仓库？（默认是）

另有一条假设不需要回答：你的 tech-stack 文档偏好 Tauri，但你这次明确要 Electron，按 Electron 做。
