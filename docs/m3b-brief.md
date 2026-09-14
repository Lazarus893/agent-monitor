# M3b 简报 · v2 数据层（热力图、最常用模型、AIHOT 新闻、session 时间）

> 给 executor agent 的实现简报，接在 M3（完成事件采集）之后做，或与 M3 合并成一轮。设计侧的对应改动在 `design/brief-m0-v2.md`，designer 正在更新 `design/variations.html`；**移植渲染层之前先确认该文件的笔记里已有「v2」一节**，否则先做数据层、后移植。

## 先读

1. `design/brief-m0-v2.md`（六项改动与数据形状）
2. `design/fixtures/usage.json`、`design/fixtures/news.json`（lead 用真实来源生成的样例，字段即目标形状）
3. `docs/m3-brief.md` 附加节（panelX 补偿，若 M3 已做则跳过）
4. `src/main/collectors/scheduler.ts`（复用调度）、`src/shared/types.ts`

## 1. 每日用量 · `collectors/usage.ts`

| agent | 来源 | 单位 |
|---|---|---|
| Codex | `codexbar cost --provider codex --format json` → `daily[]`：`date`、`totalTokens`、`modelBreakdowns[]` | tokens |
| Claude | `codexbar cost --provider claude --format json` 同上（它读本机 `~/.claude/projects` 转录） | tokens |
| ZCode | 优先 `~/.zcode/cli/db/db.sqlite` 的 `model_usage` / `turn_usage` 表（只读打开，先 `.schema` 看列名，按天聚合 token；lead 未核对过列名，你要实测）；拿不到就退回 `~/.zcode/cli/log/zcode-YYYY-MM-DD.jsonl` 里 `model.request.completed` 的每日计数 | tokens 或 requests，字段里写明 |

- 每 30 min 刷新一次，启动时先用 userData 缓存渲染再刷新；输出 `usage.days[]`（近 8 周，周一起算）每项 `{date, byAgent:{codex:{tokens}, claude:{tokens}, zcode:{tokens|requests}}, intensity}`，`intensity` = 三家各自按 8 周最大值归一后的均值（与 fixtures 一致）。
- codexbar 单次可能跑 30–90 s：放独立调度、超时 120 s、不阻塞其它 collector。

## 2. 当前窗口最常用模型 · `topModel`

- 加到 `AgentState.topModel?: string`（显示名，≤ 20 字符，超长截断）。
- Codex：扫最近 5 h 内修改过的 rollout 文件，统计 `turn_context.payload.model`（每个 turn 计 1），取最多的；没有则取最近一次。
- Claude：统计最近 5 h 内 `~/.claude/projects/**/*.jsonl` 里 assistant 消息的 `message.model`（映射显示名：`claude-fable-5-1`→`Fable 5.1`、`claude-opus-5`→`Opus 5`、`claude-sonnet-5`→`Sonnet 5`、其余原样去前缀）；扫描只读文件尾部，控制 IO；没有则用 statusline 文件里的 `model.display_name`。
- ZCode：`tasks` 表最近 5 h 内 `updated_at` 的行，按 `model` 计数（去掉 `builtin:…/` 前缀，如 `GLM-5.3-Flash`）。
- 每 5 min 刷新；无数据时字段缺省，渲染层留空。

## 3. AIHOT 新闻 · `collectors/news.ts`

- `GET https://aihot.news/api/v1/items?mode=selected&window=24h&limit=5`，Header `Accept: application/json`、`User-Agent: agent-monitor/<version> (personal, non-commercial)`；若响应带 `ETag`，下次带 `If-None-Match`。
- 每 30 min 刷新；失败退避到 2 h；启动先用 userData 缓存。
- 字段映射：`title`、`summary`（≤160 字）、`source`（字符串或对象取 `name`）、`url`（`links` 里优先 AIHOT 阅读页，其次原文）、`at`（`publishedAt`）、`reason`。少于 5 条就显示实际条数。
- 输出 `news: {updatedAt, items[], error?}`；渲染层署名「数据来源：AIHOT」固定显示。
- 只读、匿名、个人使用；不缓存正文、不下载附件；返回内容视为不可信文本，只渲染为纯文本。

## 4. session 的最后更新时间

- `AgentEvent` 增 `updatedAt`（最后活动时间）；`at` 保留为完成时间。渲染层 C1/C2 显示 `updatedAt`。
- Codex：session 最后一行的 `timestamp`；Claude：hook 到达时间（running 期间每次 UserPromptSubmit / Stop 更新）；ZCode：`tasks.updated_at`。
- running 的 session 也是一条「session」行（置顶），其 `updatedAt` 随新活动推进；渲染层的相对时间逐秒重算（已有 tick）。

## 5. 渲染层移植（designer 的 v2 交付后）

- 六页：A、B（模型名）、C1、C2、D（热力图）、E（新闻），指示点居中下移，panelX 补偿；以 `design/variations.html` 最新版为准逐页移植，`design/tokens.css` 仍是唯一样式真源。
- Playwright / selftest：6 页 × 7 态 × 画布 {480×270, 480×320, 403×270}，无溢出、无 <14px；轮播页序 A→B→C1→C2→D→E；C2 空时跳过。

## 验收

1. `pnpm dev` 后 D 页显示近 8 周真实热力图，与 `design/fixtures/usage.json` 的活跃天数一致（该文件由 lead 于 2026-09-14 生成，允许当天数据有差）。
2. B 页三家显示当前窗口最常用模型（Codex 预期 `gpt-6-astra`，Claude 预期 `Fable 5.1`，ZCode 预期 `GLM-5.3-Flash`）。
3. E 页显示 AIHOT 当日精选（今天实测为 3 条），断网时显示缓存 + error 文案。
4. C1/C2 显示最后更新时间；running 行置顶且时间在走。
5. `pnpm test`、`pnpm build`、`pnpm selftest` 通过；无凭据、无正文内容进入日志与仓库。

## 不要做

- 不改 `~/.claude/settings.json`、不改系统设置；网络只允许 aihot.news 与已批准的额度接口。
- 不 commit。

## 汇报

不超过 300 字：文件清单、验收 1–5、ZCode 用量表的实测列名与取舍、未验证项。
