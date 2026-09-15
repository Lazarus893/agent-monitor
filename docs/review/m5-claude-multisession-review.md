# M5 Claude 多会话合并 · 代码复核

> 复核 lane：m5-reviewer-quota（Opus）。范围：`scripts/claude-statusline-tee.sh`、`scripts/selftest.ts`、`src/main/collectors/quota/claude.ts`、`tests/collectors/claude.test.ts`、`tests/statusline-tee.test.ts`、`tests/fixtures/ratelimits/`。
> 证据：`npx vitest run` → 28 files / 471 tests 全绿；`npx tsc --noEmit -p tsconfig.node.json` 无输出。三条 P1 均在真实模块上做了反例复现。

## P0

无。

## P1

### P1-1 `wins()` 不看窗口是否已经过期 —— 过期窗口的高百分比会变成永久幽灵

`src/main/collectors/quota/claude.ts:160-165`（`wins`），`:136-157`（`mergeSamples`）

合并只比 `resetsAt` 谁晚、`usedPercent` 谁大，从来不问「这个 `resetsAt` 是不是已经在过去」。`session-stale` fixture 只钉住了容易的那一半（过期窗输给一个更晚的当前窗）。难的那一半没覆盖也没处理：**当前 5h 窗根本没有任何会话报告 `five_hour` 时**（正是这次要修的那个高频情形），唯一带 `five_hour` 的样本就是那个闲置会话每秒重写的上一窗旧快照，它没有竞争对手，直接胜出。

反例（已实测）：闲置会话 `{5h 97%, resets_at = now-1h}` + 活跃会话 `{省掉 five_hour, 7d 28%}` → 合并结果 `5h=97% 7d=28%`。正确答案是 `5h=absent`。屏上后果比原 bug 更糟：`countdown()`（`src/renderer/app.ts:153-161`）把负数夹成 0 → A/B 两页长期显示「97% · 0m」，B 页游标落到带外。只要那个闲置会话不关，永远不会自愈（tee 每秒重写，`writtenAt` 永远新鲜，10 min 窗滤不掉它）。

建议：在 `mergeSamples` 里把 `now` 纳入判据，凡 `Date.parse(w.resetsAt) <= now` 的窗口直接丢弃（等同于「这份样本没有这个键」）。丢完之后规则可以同时简化成「只取 `usedPercent` 最大」，不再需要靠 `resetsAt` 排序来隐式表达跨重置点 —— 顺带把 P2-1、P2-2 一起消掉。

### P1-2 不新鲜样本在收集阶段就被滤掉 —— 冷启动时 stale 数字整个丢失，屏上错说「还没接入 statusline」

`claude.ts:208`、`:212`（`collectSamples` 的两处 `age <= FILE_FRESH_MS`）、`:335-349`（`readFile`）、`:298-321`（`run`）

老实现 `defaultReadStatusline` 无条件返回文件内容，新鲜与否由 `run()` 判断，所以文件头那条纪律（「文件旧了但刷新没成 → 把旧数字连同它的写入时间一起交出去（stale）」）成立。新实现把 10 min 门槛下沉进了 `collectSamples`，于是 `readFile()` 永远只能返回新鲜样本，`run()` 里带 `windows` 的 stale 返回在默认路径上成了死代码。

稳态下 `mergeQuota`（`src/main/state.ts:264-278`）会用 `prev.windows` 兜住；**冷启动兜不住**：初始态 `prev.windows` 为空。反例（已实测）：一份 20 分钟前写的会话文件（5h 44% / 7d 61%），Keychain 无可用令牌，`run()` 返回 `{"ok":false,"code":"no_statusline"}` → `status:'offline'` + notice「还没接入 statusline」。用户合盖过夜、早上开机（登录自启）就是这条路径。

建议：`collectSamples` 只负责「扫 + 删 >24h」，返回 24 h 内的全部样本；把 10 min 新鲜判定还给 `run()`。

### P1-3 `statuslineModel()` 仍只读老单文件 —— 模型名兜底被这次改动打断

`src/main/collectors/topmodel.ts:158`、`:161`

`claudeTopModel()` 在近 5 h 没有转录可数时 `return statuslineModel()`，读的是 `STATUSLINE_FILE`（老单文件）。新 tee 拿得到 `session_id` 时不再写它，所以这条兜底要么读到 ENOENT（新机器：B 页模型名消失），要么读到升级前遗留的那份**永久冻结**的旧快照（老机器：长期显示错的模型名，且没有东西会删它）。`tests/collectors/topmodel.test.ts:113` 自建临时文件，测不出这次断裂。

建议：给 `topmodel.ts` 一个「挑 `STATUSLINE_DIR/*.json` 里 `writtenAt` 最新的一份」的取文件函数，或在 `collectSamples` 的样本上一并带出 `model.display_name`。补一条跨模块用例。

## P2

1. **`wins()` 遇到 NaN 时合法值永远赢不了它**（`claude.ts:160-165`）。`ra !== rb` 对 NaN 恒真，`ra > rb` 恒假，先入库的坏值永久占位，与「写入顺序无关」的注释矛盾。当前经 `parseRateLimits`/`toIso` 进不来；建议显式 `Number.isNaN` 守卫或注释写明前置条件。
2. **`resetsAt` 只做严格相等**（`claude.ts:163`）。同一窗两个会话若报出相差几秒的 `resets_at`，会挑中「更晚」而可能用量更低的那份。按 P1-1 改成「滤掉过期窗 + 取最大用量」后一并消失。
3. **有几类文件永远不会被清理**（`claude.ts:197-207`）：`readSample` 返回 null 的（坏 JSON 等）在 TTL 删除之前就 `continue`；`<sid>.json.tmp.<pid>` 残留不以 `.json` 结尾也被跳过。app 不运行时 tee 照写，目录单向增长。建议 TTL 删除改成先取 `stat().mtimeMs`。反之误删风险可接受：专用目录、只 `*.json`、`at > 0` 守卫、必须 >24 h，与 `mv` 撞车窗口毫秒级且下一秒自愈。
4. **`sampledAt` 取所有样本里最新的写入时刻**（`claude.ts:346-348`）。闲置会话每秒重写的是旧快照，`newest.at` 衡量的是「最近一次有会话重写了文件」，不是「最近一次看到这个数字」，屏上「数据 N 分钟前」结构性偏乐观。至少改注释；更贴切的是只在贡献了胜出窗口的样本里取最大。
5. **`readFile()` 里重新取了一次 `now`**（`claude.ts:341`），与 `run()` 的 `now` 不同一；`?.` 多余。把 `now` 当参数传下去。
6. **老单文件兼容路径值得重新裁决**（tee:70-72 写、`claude.ts:210-212` 读）。安装器把 statusLine 指向 tee 脚本绝对路径，就地更新即生效，不存在「还在写老文件的旧 tee」；Claude Code 始终提供 `session_id`，`sid=''` 分支实际不可达。按「不保留向后兼容层」两边都该删；若保留，无 sid 时写 `<sessions>/nosid-$PPID.json` 并注释写明理由，否则一旦走到这一支几十个无 sid 会话又共写一份文件。
7. **文档漂移**：`claude.ts:4-6`、`:13`、tee 脚本抬头 `:2-3`、`scripts/install-claude-statusline.mjs:141` 提示语、`docs/m2-brief.md:18`/`:31` 仍说「单文件」；`claude.ts:182-183` 说「新鲜判据与单文件那条一致」不准确（老实现不在读取处过滤）。
8. **测试缺口**（与 P1 对应）：无「过期窗是当前 5h 唯一来源」用例（P1-1）；`claude.test.ts:390` 停在 `collectSamples` 返回 `[]`，collector 级 stale 未验证（P1-2）；无 `statuslineModel`/`claudeTopModel` 新目录布局用例（P1-3）；`statusline-tee.test.ts:139-146` 路径逃逸只断言副作用，建议 `AGENT_MONITOR_DIR=<tmp>/am` + 坏 sid `../pwned` + 断言 `<tmp>/pwned.json` 不存在；`wins()` 平局无用例（已核对无缺陷）。

## 已核查、确认无问题的点

- **路径安全（tee:55-62）站得住**：白名单挡 `/`、反斜杠、空白、换行；`..` 由 `.*` 单独挡；限长 64；`jq -r` 对非字符串输出也落在白名单外；剩余形态（`-rf`、`a..b`）只是普通文件名且 `$out` 以 `/` 开头。
- **权限在 `mv` 之前就位**：`umask 077` 子 shell 内建目录/文件，`chmod` 只收紧旧的，都在 `mv -f` 之前；用例 `statusline-tee.test.ts:99-104` 钉住。
- **并发与 `mv` 原子性**：`tmp="$out.tmp.$$"` 每进程一份；同目录 `mv -f` 原子替换。
- **`readStatusline` 注入 vs 合并两条路的分流正确**，类型自洽，`tsc` 通过。
- **OAuth 兜底、stale 判定逻辑本身未动**；**只有 7d 的样本不影响 5h** 成立。
- **fixtures 质量高**：真机 15:36 原样抄录，README 写清四份各自代表什么。
- **selftest 新增格是端到端真落盘验证**，临时目录、无网络。
- **无任何密钥、凭据或用户路径进入改动**。

## 结论

**REQUEST CHANGES —— 修完 P1-1 / P1-2 / P1-3 再提交。** 主干思路（按 session 分文件 + 按键合并 + 过期清理）正确，路径安全与权限处理干净。P2 建议同批处理第 6、7 条，其余可跟进。
