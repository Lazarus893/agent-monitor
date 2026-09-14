# M3 简报 · 完成事件采集

> 给 executor agent 的实现简报。M2 采集层已在真机出数。M3 的目标：三家 agent 的**完成 / 失败 / 等待你**事件实时进入事件流，触发 C 页打断与提示音；未读与 ack 跨重启持久化。

## 先读

1. `PLAN.md` §2.2（三家事件来源，每条已实测）、§2.3（`AgentEvent` 模型）、§6（风险：hooks 拖慢 Claude、Codex 格式随版本变）
2. `design/brief-m0-rotation.md`「打断规则」「手动切换」（事件如何影响轮播；渲染层已实现，主进程只需把事件推进 state 并标记 `isNew`）
3. `design/fixtures/extract.py`（三家记录的真实解析样例：Codex rollout 的 `session_meta / user_message / response_item / task_complete`，Claude 项目 jsonl 的 `summary / user / assistant`，ZCode `tasks` 表）
4. `src/main/state.ts`、`src/shared/types.ts`（M1/M2 的状态结构；事件数组与 `isNew` 语义在此扩展）
5. `src/main/collectors/scheduler.ts`（M2 的调度器；ZCode 轮询可复用）

## 三个 collector（放 `src/main/collectors/events/`）

### Codex · `codex.ts` · 文件监听

- 用 chokidar 5 监听 `~/.codex/sessions/**/rollout-*.jsonl`（新文件 + 追加）；每个文件记 offset 只读新行，畸形行跳过。
- 解析：`session_meta`（cwd、originator、id）；首条用户提问（`event_msg.user_message.message`，或 `response_item` role=user 的 `input_text`，跳过以 `<` / `#` 开头的系统块）作标题；`task_started` → 该会话 running；`task_complete` → `completed`，`payload.error` 非空 → `failed`；`last_agent_message` 首段作 summary；`duration_ms`。
- **等待你**：先用 `grep -h -o '"type":"[a-z_]*"' ~/.codex/sessions/2026/*/*/*.jsonl | sort | uniq -c` 找出真实存在的审批 / 提问事件名（预计形如 `exec_approval_request`、`apply_patch_approval_request`、`request_user_input`），命中 → 该会话 `attention`，直到同会话下一条 `task_complete` 或用户消息。找不到就在笔记里写明并留接口。
- 启动时把最近 24 h 的事件**回灌为已读**（`isNew: false`），只有启动后新到的才算新事件。
- 目录可用环境变量 `MONITOR_CODEX_SESSIONS_DIR` 覆盖，便于 selftest 用临时目录。

### Claude Code · `claude.ts` · hooks + 本地 HTTP

- 主进程起 `http://127.0.0.1:47831`（只绑回环，端口可 `MONITOR_HOOK_PORT` 覆盖），路由 `POST /hook`。校验：`Content-Type: application/json`、body ≤ 64 KB、必有 `hook_event_name` 与 `session_id`；另要求 Header `X-Monitor-Token` 等于 `~/.agent-monitor/hook-token`（首次启动生成，0600），防止本机其它进程伪造事件。
- 事件映射：`UserPromptSubmit` → 该会话 running；`Stop` → `completed`；`Notification` 且 `notification_type` 为 `permission_prompt`（或 message 含「permission」）→ `attention`，`idle_prompt` 类忽略或按 running 结束处理；`SessionEnd` → 清 running。
- 标题与摘要：读 `transcript_path`（jsonl）：`summary` 行优先，否则首条用户文本；最后一条 assistant 文本首段作 summary；读取只取尾部 256 KB。
- `scripts/claude-hook.sh`：hook 命令本体，`curl -s -m 3 -X POST … --data-binary @- -H "X-Monitor-Token: $(cat ~/.agent-monitor/hook-token)" >/dev/null 2>&1 &`，全异步、失败静默、退出码恒 0。
- `scripts/install-claude-hooks.mjs`：读 `~/.claude/settings.json`，先备份到 `settings.json.bak-<时间戳>`，往 `hooks.UserPromptSubmit / Stop / Notification / SessionEnd` 各加一条指向上面脚本的 command hook（`timeout: 3`），幂等，`--uninstall` 只移除自己那几条。**只写不装**，由 lead 决定何时安装。
- 兜底监听 `~/.claude/projects/**/*.jsonl` 本轮不做，留接口。

### ZCode · `zcode.ts` · 只读轮询

- 每 3 s `spawn("/usr/bin/sqlite3", ["-readonly", "-json", db, sql])`，`sql = select task_id,title,task_status,model,workspace_path,updated_at from tasks where deleted=0 order by updated_at desc limit 20`；DB 路径可 `MONITOR_ZCODE_DB` 覆盖。
- 按 `(task_id, task_status, updated_at)` 做 diff：新出现或状态变化才产生事件；`running` → running；`completed` → completed；`failed` / `cancelled` → failed；`pending` 的语义**要实测**（用户会跑一个 ZCode 任务，你在笔记里写清观察方法），先按 running 处理并留开关。
- WAL 模式下只读打开没问题（M0 已验证）；DB 不存在 → 该 agent 事件源 `offline`，不崩。
- 可选：tail `~/.zcode/cli/log/zcode-YYYY-MM-DD.jsonl` 的 `turn.completed` 降低延迟；本轮不做。

## 统一行为

- `AgentEvent` 按 PLAN §2.3；`id` 稳定（Codex `codex:<session>:<turn>`，Claude `claude:<session>:<stop 时间戳>`，ZCode `zcode:<task_id>:<updated_at>`），同 id 去重。
- 事件与 ack 持久化到 `app.getPath("userData")/events.json`（最多 200 条，原子写）；重启后回灌为已读，不再打断、不再响铃。
- per-agent `status`：`running` 有任一会话在跑、`attention` 有任一会话在等、否则 `idle`；running 超过 2 h 未收尾自动清除并记日志。
- 主进程只在**启动之后新到**的事件上标 `isNew: true`；渲染层已有「新事件跳 C + 提示音 + 未读」逻辑，不要在主进程重复做打断。
- 日志一行一事件：`[events:codex] completed "评估集构造合理性审查" cwd=~/Downloads/… 42s`；不打印 transcript 内容、不打印 token。
- Dev IPC 保留 `simulateEvent / simulateAttention / clearAttention`。

## 测试

- `tests/collectors/events/*.test.ts`：三家解析器用脱敏真实样本（放 `tests/fixtures/events/`）；Codex offset 追踪与畸形行；hook 服务器的校验（缺 token 401、超大 body 413、非 JSON 400）；ZCode diff 逻辑用临时 sqlite 文件；持久化与回灌语义；running 超时清除。
- `pnpm selftest` 增：往临时 rollout 文件追加一条 `task_complete` → 2 s 内 C 页出现新行且 `isNew`；对临时 sqlite 改一行状态 → 3 s 内出现；向本地端口 POST 一条带 token 的 Stop → 出现；重启进程后三条均为已读。

## 验收（PLAN.md §5 M3）

1. 真实 Codex：`codex exec "reply ok"` 结束后 2 s 内事件出现（消耗极少额度，可做一次）；日志一行。
2. 真实 Claude：lead 安装 hooks 后，`claude -p "reply ok"` 触发 Stop → 事件出现。你只需保证安装脚本与服务器就绪，并写清验证步骤。
3. 真实 ZCode：用户跑一个任务时状态翻转 running → completed，事件出现；写清观察方法。
4. 重启 app 后历史事件不重复报警；未读 ack 状态保留。
5. `pnpm test`、`pnpm build`、`pnpm selftest` 通过；无凭据、无 transcript 内容进入日志或仓库。

## 不要做

- 不修改 `~/.claude/settings.json`、不动 Codex 的 `notify` 配置（它已被 Codex Computer Use 占用）。
- 不读凭据文件；网络只允许回环地址的 hook 服务器。
- 不做托盘 / 自启 / 打包（M4）。
- 不 commit。

## 汇报

不超过 300 字：文件清单、验收 1–5 状态与证据、hooks 安装与还原命令、Codex 审批事件名的实测结果、ZCode `pending` 的观察结论、未验证项。

---

## 附加（2026-09-14 晚，用户第二轮实机反馈）· 横向压缩补偿

副屏 EDID 原生面板 960×640（3:2），用户仍在 960×540 @2x 模式下使用，画面被面板缩放器横向压 15.6%，字显得瘦。M3 顺带实现：

- 主进程配置 `~/.agent-monitor/config.json`（不存在则创建）里加 `panelX`（默认：目标屏为 960×540 时 **1.19**（用户 2026-09-14 用校准页实测为正圆），为 960×640 时 1.0，用户手调后以配置为准）。
- 渲染层 stage 的缩放改为 `transform: scale(2 * panelX, 2)`，画布逻辑宽度 = `round(480 / panelX)`；`--canvas-w` 随之变化，所有页在 403×270 与 403×320 也不能溢出。
- 全局快捷键 `⌃⌥]` / `⌃⌥[` 调 ±0.02，右上角闪显 1 s 当前值，写回配置；`⌃⌥0` 复位为模式默认。
- 加一个校准叠层：`⌃⌥C` 切换显示一个 200px 正圆与十字线（`--ash` 线，不算 accent），供用户调到正圆后关闭。
- 单测：panelX 与画布宽度换算、配置读写；selftest：切换 panelX 后 stage 实测宽度仍为 960。
