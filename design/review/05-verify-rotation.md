# R5 · 发布前复核 · 轮播版（A/B/C + attention 四页）

> 评审对象：`design/variations.html`（轮播版）、`design/tokens.css`、`design/shots/page-{a,b,c,attention}.png`
> 依据：`design/brief-m0-rotation.md` · `design/brief-m0-35.md` · `design/brief-m0.md`「评审后修订」·
> `design/review/03-verify-a11y-35.md`（R3）· `04-verify-hierarchy-35.md`（R4）· `00-designer-notes.md` 末两节
> 工具：`npx playwright` 1.63 / Chromium / dpr 2–4，脚本在会话 scratchpad（只读 lane，不落 `design/`）
> 口径：**报告每一条发现**，含低严重度与不确定项；过滤与排序交给 lead。

---

## 0 · 结论摘要（先看这里）

| 维度 | 结果 |
|---|---|
| R3/R4 返工（9 项点名抽验） | **7 已落实 · 2 部分落实**（V3 名字宽度、间距例外清单），0 回退 |
| 轮播规则（12 条断言） | **12/12 通过**（页序、停留、打断、指示点、reduced-motion、控制栏、localStorage） |
| 几何与可读性（4 页 × 7 态 = 28 格） | 画布越界 0 · 字号下限 **恒为 14px** · 每页字号全部达标；**3 处文本被无声截断**（B 页原因句、C 页时间列、B 页名字列） |
| 对比度 | 文本 37 组唯一配对 **全部通过**（最低 6.00:1）；非文本图形 **2 处 <3:1**（重置刻度 1.95、骨架 1.97） |
| accent | 每页每态 **≤2**（实测最多 1 处纯白 + 呼吸叠层），全量按计算颜色扫描 |
| 五态 | 4 页 × 7 态 **28/28 有内容且语义正确**，empty 含 ZCode「未连接」，三条 error 各不相同 |
| 反 slop / 内容预算 | emoji / 渐变 / 靛蓝 / 左侧色条 / 画布内 #000·#fff **全部 0 命中**；被砍内容 **0 复活** |
| console error | 0（28 格切换 + 轮播 40s + 打断流程全程） |

**剩余：P0 × 1 · P1 × 5 · P2 × 12。结论：修完 4 条后可发布**（见 §9）。

新增的三条 P0/P1 全部是**轮播架构本身带来的新面**——四页常驻 DOM（R5-01）、信息从瓦片搬到单行（R5-03 / R5-04）——
前两轮在单屏版上不可能发现它们。这本身说明改版面必须重跑全量断言，而不是只跑差量。

---

## 1 · R3/R4 返工核验（作者称「23 条修 21 跳 2」）

### 1.0 先说计数本身

两份报告是 R3-01~16（16 条）+ R4-01~17（17 条）= 33 条，作者列出的重合是 4 条（R4-02=R3-01 /
R4-03=R3-03 / R4-04=R3-02 / R4-05=R3-04），去重后应是 **29 条，不是 23 条**。
另有若干条在轮播重写后自然失效（R4-09 的 12/13/14 同档问题——12/13px 已全部废除；
R3-15 的断言口径——结构已换）。**我无法从两份报告重建出「23」这个数**，
但逐条抽验没有发现被悄悄丢掉的 P0/P1。建议下一轮返工记录直接按编号列 29 行的表，
每行写「已修 / 已失效 / 跳过 + 一句理由」，计数就不必再被反推。

### 1.1 点名抽验的九项

| # | 项 | 判定 | 证据（本轮实测） |
|---|---|---|---|
| 1 | 缺口机制（三种填充末端 2px `--canvas`） | ✅ **已落实** | `.bar>i` 与 `.band .used` 均带 `box-shadow:var(--quota-notch-w) 0 0 var(--quota-notch)`（HTML 515 / 584 行）。实测缺口对轨道 **3.75:1**；对 charcoal 填充 13.3、warn 12.7、danger 6.7（按 WCAG 公式实算）。`band-edge` 4× 截图上 97% 档的缺口清晰可见，边界不再依赖 danger 与 ash 的 1.81:1 |
| 2 | charcoal 填充（`--quota-fill` 不再等于 accent） | ✅ **已落实** | 实测 `.band .used` = `rgb(211,211,212)`，对 ash 轨道 **3.57:1**、对 surface 12.99:1。按计算颜色全量扫描，全屏纯白背景元素只剩 `.rmark` / `.iddot` 各 36 px²（6×6）与指示点 16 px² |
| 3 | V2 弧宽补偿 8px vs 4px | 🟡 **仅 token 层** | `--arc-stroke:8px` / `--arc-track:4px` 在 tokens.css ✅，但**轮播版没有任何一页渲染 V2 的弧**（`grep` 无 `.gauge`），无法运行时验证。文件头自检已如实写明「本版 V2 未上页，token 保留」——**声明与实现一致，不算问题**，但这条修复等于悬空，若 M1 把弧作为 A 页风格开关打开，需重新验一次 |
| 4 | V2 基线（foot 槽位恒占位） | ✅ **已落实（换了载体）** | A 页 `.tile-foot:empty{visibility:hidden}`（不再 `display:none`）。三块瓦片实测 tileY 81 / 高 218 / padding 8px **完全一致**；populated·edge·attention·running 四态下 `.num` 顶边恒为 **154.4**、foot 顶边恒为 **266**，0 错位（单屏版曾错位 12px） |
| 5 | V3 名字列宽度 | 🟡 **部分落实** | 轮播 B 页 `.b-name` 从 84→**108px** 并带 `overflow:hidden;text-overflow:ellipsis` ✅；但实测「Claude Code」内容宽 **109 > 108**，仍差 1px。且 `.b-name` 是 `inline-flex`，文本是匿名 flex item，**ellipsis 对它不生效**——4× 截图确认既没有省略号也看不出裁切（只切掉 1px 反锯齿边），属于「当前数据侥幸」。见 R5-08 |
| 6 | 间距例外清单 ↔ 自检行一致 | ❌ **未落实（同类问题第二次）** | tokens.css §6 现存 4 条例外，其中「V3 `.tile` padding 4px 8px」**已不存在**（轮播 B 页是 `8px 12px`，在栅格上）、「V3 `.band .caret`」选择器名已过时（现为 `.page-b .band .caret`）；而本版真实的 off-grid 值 **`.page-c .feed` gap 6px、`.feed-skel` gap 6px、`.caret` margin-left −1px 一条都没登记**。文件头自检写的「间距全部回栅格，§6 例外清单已重写成真实集合」对本版不成立。见 R5-05 |
| 7 | 骨架可见 | ✅ **已落实** | `.skel i` / `.feed-skel i` = `--stone` `rgb(67,67,69)`，实测对 surface **1.97:1**、对 canvas **2.03:1**（原 1.03/1.06）。`a-loading` 截图上三块骨架清楚可辨。仍低于 3:1，但这是 R3-07 自己给的取值，不作为新问题 |
| 8 | 任何页都不渲染 cwd | ✅ **已落实** | `grep` 全文：`cwd` 只出现在 `fx-events` 的 JSON 数据里与自检注释里，渲染路径 **0 引用**（`it.cwd` 无命中，`.rsub` 已整体删除）。28 格 innerText 扫描里唯一的 `~/` 是 attention 条目的标题「批准写入 ~/.claude/settings.json」——那是「在等你批准什么」本身，不是 cwd 字段 |
| 9 | 倒计时不重复 | ✅ **已落实** | A 页每块瓦片 foot 只有一处 `.cd`（18px）+ 一个状态词（14px）；B 页每条只有一处 `.b-cd`。28 格文本抄录里没有任何一块瓦片出现两次同一个倒计时串（单屏版 V2 曾是「3m」+「3m · 余量吃紧」） |

### 1.2 其余抽验（无回退）

| 项 | 判定 | 证据 |
|---|---|---|
| Q1 Codex 身份色 charcoal | ✅ | `.iddot` 实测 `rgb(211,211,212)`，12.99:1 |
| B1 轨道 ≥3:1 | ✅ | `.band` = ash，对 surface **3.64**、对 surface-elevated（attention 瓦片）**3.54**、指示点对 canvas **3.75** |
| B2 loading `role="status"` | ✅ | 28 格扫描：loading 态 7 处 `role=status`（3 A 瓦片 + 3 B 瓦片 + 1 事件区）+ `#live` 播报 |
| B3 语义标题 ≥5 | ✅ | 恒为 **11 个**（1 × h1 sr + 4 页 h2 + 6 瓦片 h2），非当前页整页 `aria-hidden="true"` |
| B4 aria-label 含 kind | ✅ | 实测「ZCode · 已完成 · …」「Claude Code · 等待批准 · …」「Codex · 运行中 · …」，未读行追加「未读，按 Enter 标记已读」 |
| Q4 `.row:active` | ✅ | 实测按下时 `bg #121212` + `inset 0 0 0 1px --ash` |
| Q6 中文字距 | ✅ | `.attn-tag` 0.01em；ALL-CAPS `.chip` / `.attn-who` 实测 **0.08em ≥ 0.06em** |
| Q7 attention 边框 --ash | ✅ | `.row[data-kind=attention]` 与 `.attn-card` 边框均 ash |
| P2 跨阈值播报 | ✅ | populated→edge 切换后 `#live` 实测 =「Claude Code 5h 额度已达 82%，余量偏紧」 |
| P3 breathe 用 opacity | ✅ | `::before` 叠层 `opacity 0→.06`（≤8%），周期 3s，无 `filter`；running 脉冲 2s |
| R3-09 事件区 sr 标题按状态改写 | ✅ | attention→「需要你」、running→「进行中」、loading/empty/error→「事件」、populated→「最近完成」 |
| R3-11 `.tile-foot` 补省略号 | 🟡 | 轮播 A 页 `.tile-foot` 只有 `overflow:hidden`，**没有 `text-overflow`**（它也是 flex 容器，补了也不生效）。当前数据不溢出，属潜伏项。见 R5-12 |
| R4-12 `%` 归主数字 | ✅ | `.unit` = `--body` `rgb(205,205,205)` 12.23:1，与 `--mute` 元数据层分开 |
| R4-16 未读点回 6px | ✅ | `--dot:6px`，实测 `.rmark` / `.iddot` 面积 36 px² |
| R4-17 判语只留结论 | ✅ | 实测「按这个速度用不完」/「运行中 · 按这个速度用不完」，无「落后时钟 N 点」 |
| R4-09 给 Electron 层的字号档注释 | ✅ | tokens.css §10 已补，§14 明确写了轮播层覆盖下限到 14px |
| R3-14 验证脚本落盘 | 🟡 | `design/verify.mjs` 已存在 ✅；但 `git log` 仍是「does not have any commits yet」，**仓库至今 0 commit**，旧版仍靠副本文件留存。建档由 lead 拍板（不重复报） |
| 跳过项 R3-13（瓦片边框 1.33:1） | 记录 | 轮播版仍是 `--hairline`，属实机待验项，同意不在本轮改 |
| 跳过项 R3-16（积压未读无痕迹） | 记录 | C 页从 2 行扩到 4 行，edge 的 8 条仍只露 4 条且无计数——符合简报明令，同意 |
| 内联 token ↔ tokens.css | ✅ | 逐字比对（去首尾空白）**完全相同**，19318 字符 |

---

## 2 · 轮播规则核验（Playwright 实测）

控制栏与 `data-page` 属性为观测口径；每条都在**不打断页面自身计时**的前提下采样。

| # | 简报要求 | 实测 | 判定 |
|---|---|---|---|
| 1 | 页序 A → B → C → A | 连续 40s 采样：`c→a→b→c→a→b`，无跳页、无回头 | ✅ |
| 2 | 停留 A ≥ B、C | token：`--dwell-a 10s` / `--dwell-b 6s` / `--dwell-c 6s`；**完整实测 A = 10.001s 与 10.033s，B = 5.972s，C = 6.002s** | ✅ |
| 3 | 任何一页 ≥4s | 最小 token 是 `--dwell-idle 4s`，等于下限不低于 | ✅ |
| 4 | 新事件后 200ms 内 C 页可见 | 点「模拟新事件」后 **60ms 已在 C 页**（`data-page=c` 且 `.page-c[data-on=1]`），新行在顶部、`lead`、`unread=1` | ✅ |
| 5 | 新事件停 20s | meter 实测 19.8s → 12.6s → 5.6s → 0.6s，全程停在 C；到期后自动进 A | ✅ |
| 6 | 期间再来一条重置 20s | 第二次推送后 meter 回到 **19.8s** | ✅ |
| 7 | attention 接管时轮播停止 | 连续 12 次 1s 采样**全部为 attn**，meter =「attention 接管 · 轮播暂停」 | ✅ |
| 8 | 解除后回 A | 再点一次「模拟等待批准」→ 200ms 内 `data-page=a`，meter 恢复「A · 9.8s」 | ✅ |
| 9 | 指示点：当前 ink 其余 ash | 实测三点各 4px、gap 4px、距画布右下各 8px；当前页 `rgb(244,244,246)`（对 canvas 18.24:1），其余 `rgb(106,107,108)`（3.75:1）；**attention 页三点全暗**（作者的刻意判断，读作「不在轮播的三页里」） | ✅ |
| 10 | reduced-motion 下切页无动画 | 媒体查询（`reducedMotion:'reduce'` 上下文）与控制栏开关两条通道分别实测：`.page` 的 `transition-duration = 0s`、`transform = none`、`animation-name = none`、指示点 transition 0s | ✅ |
| 11 | 控制栏手动切页 + 关闭轮播 | 关轮播后 **12s 内页面不动**，meter =「轮播关闭」；手动点 C 页立刻生效且 `aria-pressed` 同步 | ✅ |
| 12 | localStorage 记住轮播开关（与手动页） | 关轮播后 `am.rotate="0"`、`am.page="c"`；重载后复选框仍未勾选、停在 C 页且 8s 不动 | ✅ |

补充观察（不计入断言）：

- 切页动效只用 `opacity` + `transform`（300ms `cubic-bezier(.2,0,0,1)`），GPU 可合成，无 layout 属性。
- 待命页向左偏移，`.pages` 无横向滚动区（overflow 扫描 0 命中），作者「新做的判断 1」成立。
- **空闲加速（30 分钟 → B/C 各 4s）本轮未验**：`dwellFor()` 的代码路径是活的（`lastActivity` + `sceneHasRunning()`），
  但需要快进 30 分钟，原型里无法注入时钟。与作者自述一致。
- **提示音未验**（headless 静音），只确认 `chime()` 不抛异常、`rm=1` 时直接 return。

---

## 3 · 几何与可读性（4 页 × 7 状态 = 28 格）

### 3.1 全局

| 项 | 实测 |
|---|---|
| stage | 28/28 恒为 **960×540**，`zoom = 2`，画布 480×270 |
| 越界 | 逐元素 bounding box 对 stage 边界比对：**0 处越界**（含待命页元素，排除 `data-on="0"` 的页） |
| 字号下限 | 28/28 **minFont = 14px**（含 sr-only 之外的全部可见文本） |
| 越界/裁切 | 结构容器（`.screen/.pages/.page/.tiles/.bands/.feed/.tile/.row/.b-head/.band/.attn-card`）**0 处 scroll 溢出** |

### 3.2 每页字号（逐元素实测 vs 简报下限）

| 页 | 元素 | 要求 | 实测 | |
|---|---|---|---|---|
| A | 5h 百分比 | ≥64px | **64px** | ✅ |
| A | agent 名 | 16px | 16px | ✅ |
| A | 倒计时 | ≥18px mono | 18px（IBM Plex Mono, tabular） | ✅ |
| A | 状态词 / % 后缀 | ≥14px | 14 / 20px | ✅ |
| B | 5h 百分比 | ≥20px mono | 20px | ✅ |
| B | 7d 次级 | 16px | 16px | ✅ |
| B | 判语 / 倒计时 | ≥14px | 14px | ✅ |
| B | 带高 | ≥10px | **12px** | ✅ |
| C | 最新标题 | ≥20px 单行省略号 | 20px · `nowrap` + `ellipsis` · 1 行 | ✅ |
| C | 其余标题 | 16px | 16px | ✅ |
| C | 时间 | 14px | 14px | ✅ |
| attn | 「等待你」 | ≥24px | **28px** | ✅ |
| attn | 说明句 | ≥18px | 18px | ✅ |
| 全局 | 时钟 | 14px | 14px mono | ✅ |
| 全局 | 空/错原因句 | 14–16px | 标题 16 / 原因 14 | ✅ |

### 3.3 三块瓦片：同基线、同内边距

- A 页 populated / edge / attention / running：三块 `tileY = 81`、`height = 218`、`padding = 8px`，
  `.num` 顶边 **154.4 × 3**，`.tile-foot` 顶边 **266 × 3**——完全共基线。
- B 页：三条 `tileY = 81 / 157.7 / 234.3`、高 64.7、`padding = 8px 12px`，等距等高。
- **例外**：A 页 empty / error 态下三块是消息块并垂直居中，行数不同导致标题基线不齐——
  empty 实测 `183 / 163.9 / 183`，error 实测 `164.1 / 173.5 / 173.5`，**最大差 19.1px（≈3 mm）**。见 R5-09。

### 3.4 被无声截断的三处（本节是本轮几何部分的主要发现）

| 位置 | 需要 / 可用 | 后果 |
|---|---|---|
| B 页 `.b-verdict`（error / empty） | 366 / 322 px（Codex 401）、341 / 322（Claude 429） | 一句话里的**下一步被省略号吃掉**，见 R5-03 与 `b-error` 截图 |
| C 页 `.rtime` | 67 / 58 px（「29 分钟前」）、59 / 58（「1 分钟前」） | 溢出 9px 撞进 8px 栅格间隙与完成图标，见 R5-04 与 `row-lead` 截图 |
| B 页 `.b-name` | 109 / 108 px（「Claude Code」） | 当前只切掉 1px，且 flex 匿名项不出省略号；名字再长就是硬切，见 R5-08 |

---

## 4 · 对比度与 accent（脚本按 WCAG 2.1 实算）

### 4.1 文本 × 底色 —— 37 组唯一配对，0 例外

逐元素取计算色与最近的不透明祖先底色，按 `(L1+.05)/(L2+.05)` 实算。最低的五组：

| 比值 | 字号 | 前景 | 位置 | 门槛 |
|---|---|---|---|---|
| **6.00** | 16px | `--id-claude #d97757` | attention 页 `.attn-who`（ALL-CAPS 徽记） | 4.5 ✅ |
| 6.42 | 14px | `--id-claude` | C 页 `.chip` | 4.5 ✅ |
| 6.47 | 14px | `--id-zcode #6f93e6` | C 页 `.chip` | 4.5 ✅ |
| 6.60 | 14/20/64px | `--danger #ff6161` | A 页 97%、B 页 error 判语 | 4.5 ✅ |
| 6.83 | 14px | `--mute #9c9c9d` | attention 页「已等 2h00m」（底 surface-card） | 4.5 ✅ |

`--ash` 与 `--stone` 未被用作任何文本色 ✅。`--mute` 的最低出现是 6.83:1，远高于 4.5 ✅。

### 4.2 非文本图形 × 相邻色（3:1 硬线，三档全算）

| 比值 | 元素 | 相邻 | 判定 |
|---|---|---|---|
| 18.24 | 指示点（当前页，ink） | canvas | ✅ |
| 13.3 / 12.7 / 6.7 | **缺口 `--canvas`** vs charcoal / warn / danger 填充 | 填充 | ✅ 三档全过，且与填充色无关 |
| 3.75 | 缺口 · 游标 · 指示点（ash） | 轨道 / canvas | ✅ |
| 3.64 / 3.54 | 轨道 `--ash` | surface / surface-elevated | ✅ |
| 3.57 | 填充 `--charcoal` | 轨道 | ✅ |
| 3.38 | 填充 warn | 轨道 | ✅（缺口另有保险） |
| **1.95** | **重置刻度 `--mute`** | **轨道 `--ash`** | ❌ 见 R5-02 |
| 1.81 | 填充 danger | 轨道 | 🟡 参考值——边界已由缺口承担（R3-01 的既定修法），不再单列 |
| 1.97 / 2.03 | 骨架 `--stone` | surface / canvas | 🟡 沿用 R3-07 建议值，见 R5-17 |

图标（1.6px monoline，`currentColor`）随所在文本色，取值落在 6.60–12.30:1 ✅；
它们的**描边宽度**（1.6px = 0.26 mm）仍是 R4-14 提过的物理可辨性问题，不是对比度问题。

### 4.3 accent 全量扫描（按计算颜色，不用选择器白名单）

口径：遍历画布内全部可见元素与 `::before/::after`，取 `background-color == rgb(244,244,246)`。

| 页 / 态 | accent 实测 | 明细 |
|---|---|---|
| a/attention | **1**（+1 呼吸叠层） | `.iddot` 36 px²；`.tile::before` 是 opacity 0→.06 的白色呼吸叠层，即使计入也只有 2 |
| b/attention | **1**（+1 呼吸叠层） | 同上 |
| c/populated · edge · running | **1** | `.rmark` 36 px² |
| c/attention | **1**（+1 呼吸叠层） | `.rmark` 36 px² |
| attn/attention | **0**（+1 呼吸叠层） | 整屏只有身份色 + ink 文字 |
| 其余 21 格 | **0** | — |
| 指示点 | 排除 | 当前页那一点 16 px²，带 `data-not-accent`，简报明写「这不算 accent」 |

**结论：≤2 成立**，且 R3-03/R4-03 指出的「最亮最大的白是额度而不是需要你」已彻底消失——
全屏面积最大的纯白现在是 36 px² 的未读点本身。身份色只出现在 6px 圆点、14–16px 徽记文字、
running 图标上，**没有任何大面积身份色填充** ✅。

顺带一条不确定观察：attention 页是全屏最高优先级页面，但它**一个 accent 也没有**（靠 28px ink 标题 +
整卡呼吸承担）。这不违规（≤2 是上限不是下限），记录供 lead 判断是否要把那颗 6px 白点也放上去。

---

## 5 · 五态 × 四页 + 无障碍

### 5.1 覆盖表（28 格全部实测抄录）

| | populated | loading | empty | error | edge | attention | running |
|---|---|---|---|---|---|---|---|
| **A 总览** | ✅ 22/18/61% + 倒计时 | ✅ 骨架 ×3（文字转 sr） | ✅ 三条原因，ZCode =「未连接 · 还没有智谱 API Key」 | ✅ 401 / 429 / 网络不可达 | ✅ 97%·2m·吃紧 / 82%·偏紧 | ✅ Claude foot =「等待你批准」 | ✅ 「23m 运行中」+ 脉冲 |
| **B 详情** | ✅ 带 + 游标 + 重置刻度 + 判语 | ✅ 骨架条 ×3 | ✅ 原因并进判语行 | 🟡 三条各不相同但**被截断** | ✅ 97% 带 + 2m | ✅ 判语 =「等待你批准」 | ✅ 「运行中 · 按这个速度用不完」 |
| **C 事件** | ✅ 1 放大 + 3 行 | ✅ 骨架 + 唯一可见的「读取中」 | ✅「今天还没有完成的任务 / 有任务跑完会自动排到这里」 | ✅「事件采集中断 / 30 秒后自动重新挂载，期间事件会补齐」 | ✅ 8 条取 4 条，未读衰减 | ✅ 顶行变 attention 行 | ✅ 顶行「进行中 · 2h03m」 |
| **attention 页** | ✅ 兜底空态 | ✅ 兜底空态 | ✅ 兜底空态 | ✅ 兜底空态 | ✅ 兜底空态 | ✅ 28px 等待你 + 18px 说明 + 已等 2h00m | ✅ 兜底空态 |

- **empty 含 ZCode「未连接」** ✅：Key 已进 Keychain 后「未连接」退成 empty 的一种，
  文案「未连接 · 还没有智谱 API Key」，「怎么接」仍在屏外 ✅。
- **error 一句话含原因与下一步** ✅ 三条文案互不相同、各自含下一步；
  但在 B 页被截断（R5-03），A 页与 C 页完整。
- **edge 四项**：97% 转红 ✅ / 倒计时 2m ✅ / 64 字标题单行省略号 ✅ / 一分钟内 8 条不溢出 ✅（渲染 4 条，
  无计数文字——简报明令，沿用 R3-16 的既定判断）。**超长 cwd 这条边界已随 cwd 被砍而不适用** ✅。

### 5.2 无障碍逐项

| 项 | 结果 |
|---|---|
| heading | 11 个（h1 sr + 4 页 h2 + 6 瓦片 h2），非当前页整页 `aria-hidden="true"` ✅ |
| `role="status"` | loading 态 7 处 + `#live` 一处 ✅ |
| `aria-live` | 唯一 `polite` 区；新事件、ack、跨阈值、attention 均写入 ✅ |
| `aria-label` 含 kind | ✅（已完成 / 等待批准 / 运行中 / 失败）+ 未读提示 |
| SVG | 全部 `aria-hidden="true"`，均有文字替代 ✅ |
| focus | `.row:focus-visible` = `inset 0 0 0 2px --accent`，对 surface 17.05:1，**非浏览器默认蓝** ✅ |
| Enter ack | ✅ 未读 → 已读，`#live` =「已全部读完」，焦点保持在同一行 |
| `:active` | ✅ `#121212` + `inset 1px --ash`，`--dur-instant 120ms` |
| hover | ❌ **未读行与 attention 行没有 hover 态**（被同特异度的后置规则覆盖），见 R5-06 |
| Tab 顺序 | ❌ **隐藏页的 4 个事件行仍在 Tab 序里**，见 R5-01 |
| reduced-motion | ✅ 媒体查询与开关双通道全停 |

---

## 6 · 反 slop 与内容预算

| 项 | 结果 |
|---|---|
| emoji | 0（正则扫 `U+1F300–1FAFF`、`U+2600–27BF`、`FE0F`） |
| 渐变 | 0（唯一命中是 tokens.css 里「为什么没抽 raycast 的 gradient」这条注释） |
| 靛蓝系 | 0 |
| 左侧色条卡片 | 0（`border-left` 无命中） |
| 大面积 #000 / #fff | 画布内 0；`#fff` 只出现在控制栏按钮（简报明定「纯工具样式，不参与设计」） |
| 投影 | 画布内 `box-shadow` 只有三种用途：缺口（机制）、focus/active 描边、attention 圆点 2px 白光环——无一是高斯投影 ✅ |
| 装饰性动画 | 无；动效只在状态变化与轮播切页 |
| **被砍内容是否复活** | 品牌字 0（只剩 sr-only h1）· cwd 0 · 1mo 0（仅存在于 fixtures 数据）· 「另 N 条更早」0 · 未读计数文字 0 —— **28 格 innerText 全量扫描确认** |
| 文案视角 | 「等待你批准」「余量吃紧」「按这个速度用不完」「恢复联网后自动重连，不用操作」——全部用户视角 ✅ |
| tabular | 所有数字 `font-variant-numeric: tabular-nums` + `"tnum" 1,"zero" 1` ✅ |
| 字距 | ALL-CAPS 0.08em（≥0.06 ✅）；中文 0.01em；64px 数字 −0.02em ✅ |

---

## 7 · 发现清单

### R5-01 · P0 · 置信 0.90
**位置**：`.page{opacity:0;pointer-events:none}`（HTML 475–478 行）+ `showPage()` 的 `aria-hidden` 写入（1487–1491 行）· 任意当前页 ≠ C 时
**现象**：四页常驻 DOM，非当前页只靠 `opacity:0` + `pointer-events:none` + `aria-hidden="true"` 隐藏。
实测在 A 页按 Tab：焦点依次落到**隐藏的 C 页里 4 个 `.row` 按钮**上——
`page.dataset.on="0"`、`aria-hidden="true"`、`opacity = 0.0044`，
焦点环画在一个看不见（且偏移到画布左外侧）的元素上，连按 4 次 Tab 都「什么都没发生」；
此时按 Enter 会 ack 一条用户根本没看到的事件。
**依据**：ARIA 规范禁止 `aria-hidden="true"` 的子树包含可聚焦元素（axe-core `aria-hidden-focus`，serious）；
WCAG 2.4.7 要求焦点可见；`brief-m0.md` 自检行「Tab 顺序合理；focus 可见」。
**这是轮播架构独有的新面**——单屏版没有隐藏页，前两轮不可能发现。
**缓解**：副屏几乎不用键盘；4 个盲停都在同一处、不构成陷阱。lead 若认为键盘路径不是 M0 的验收面，可降 P1。
**建议**：给非当前页加 `inert`（一行，Chromium 130+ 原生支持，自动同时处理 `aria-hidden` 与 tab 序），
或在 `showPage()` 里对非当前页的 `.row` 写 `tabindex="-1"`。前者更省，且顺带把 `pointer-events:none` 的意图收进同一个属性。

### R5-02 · P1 · 置信 0.80
**位置**：`.page-b .band .resettick`（HTML 593 行 `background:var(--mute)`）· B 页所有含数据状态
**现象**：简报点名要求 B 页画「重置刻度」。它实现为带右端一条 2px `--mute` 竖线，
实测 `#9c9c9d` 叠 `--ash` 轨道 = **1.95:1**；4× 截图（`band-zcode`）上**目视无法从轨道里分出这条刻度**。
换句话说，这个元素在 DOM 里存在、在屏上不存在。
**依据**：WCAG 1.4.11——承载信息的非文本组件对相邻色 ≥3:1。这正是 B1/R3-01 立过的同一条线，
只是这次落在轮播版新加的元素上（单屏版没有 resettick）。
**缓解**：带的右端**本身**就是重置点，且同一行有 14px 的倒计时数字，信息不会丢；
所以这是「这条线白画了」而不是「读者被误导」。
**建议**：改用与游标同源的机制——把刻度做成**上下各出头 2px 的刻痕**，落在带外的 `--surface` 上
（`--mute` 对 surface 7.09:1），它就永远不与轨道/填充争同一段像素；或直接删掉它，让圆角右端独自承担。

### R5-03 · P1 · 置信 0.85
**位置**：`.page-b .b-verdict`（`white-space:nowrap;overflow:hidden;text-overflow:ellipsis`，HTML 571 行）· B 页 error / empty
**现象**：B 页把「原因 + 下一步」并进判语那一行（作者「新做的判断 4」，为省一行）。
实测宽度不够：Codex「额度接口 401 · 登录令牌过期，跑 codex login 重新授权」需 **366px，可用 322px**；
Claude「接口限流 429 · 已退避重试，期间读 statusline 缓存」需 **341px**。
截图 `b-error` 上实际显示为「… 跑 codex login …」「… 期间读 statusline…」——
**下一步的动作被省略号截掉**（Codex 侥幸留下了命令本身，Claude 那条丢了宾语）。
**依据**：`brief-m0.md` 已定项「error 具体到三种文案，都要给出下一步」；
`brief-m0-35.md`「原因 + 下一步压成一句」——压成一句不等于可以截断。
**建议**：三选一。(a) B 页 error/empty 放弃「并进一行」，回到两行（判语行 + 14px 原因行，B 页每条有 64.7px 高，放得下）；
(b) 把 `.b-pc` / `.b-sec` / `.b-cd` 在 msg 态整体让位，把 322px 放宽到整条 440px；
(c) 缩短文案（「401 · 跑 codex login」）。我倾向 (b)：msg 态本来就没有百分比可显示。

### R5-04 · P1 · 置信 0.90
**位置**：`.row{grid-template-columns:64px minmax(0,1fr) 58px 14px var(--dot)}`（HTML 602 行）· C 页所有含事件状态
**现象**：时间列固定 58px，但相对时间文案会超：实测「29 分钟前」= **67px**、「1 分钟前」= 59px。
`.rtime` 没有 `overflow:hidden`，Chromium 对溢出行按起始边对齐，于是**向右溢出 9px，吃光 8px 栅格间隙并压进完成图标**。
4× 截图 `row-lead` 上「分钟前」与「✓」之间**零间隙、笔画相接**。
当同一行的标题又是省略号截断时（第 3、4 行），屏上就是「…前✓」三个东西挤在一起。
**依据**：`hierarchy-rhythm-review` 的「同一对象复现 = 同栅格」；本条只在相对时间是「NN 分钟前」时出现，
「刚刚」「14:32」都不触发——所以它是**数据相关的间歇性错位**，比恒定错位更难在截图评审里被发现。
**建议**：时间列 58 → **68px**（标题列还有 272px，让 10px 不影响单行省略号），
或把文案缩成「29 分前」/「29m」；同时给 `.rtime` 补 `overflow:hidden`，把溢出变成可见的省略而不是压邻居。

### R5-05 · P1 · 置信 0.95
**位置**：`tokens.css` §6 OFF-SCALE EXCEPTIONS（行 66–80）× 轮播版实际 CSS × 文件头自检行 71
**现象**：R3-06 修过一次的「清单与实现双向失配」在轮播版**重新出现**：

登记了但在本版不存在 / 名字已过时（2/4）：

| 清单写的 | 本版实际 |
|---|---|
| `V3 .tile padding 4px 8px` | `.page-b .tile` 是 `8px 12px`，**在栅格上，该例外已不存在** |
| `V3 .band .caret 2px` | 选择器已改名为 `.page-b .band .caret`（值仍是 2px，只是名字过时） |

实际存在但未登记（3 处，运行时全量扫 `gap/padding/margin` 比对 {2,4,8,12,16,24,32}）：

| 值 | 位置 |
|---|---|
| `gap: 6px` | `.page-c .feed`（事件行之间的节奏间距——这是节奏不是字形几何） |
| `gap: 6px` | `.page-c .feed-skel`（loading 骨架） |
| `margin-left: -1px` | `.page-b .band .caret`（游标居中补偿，属字形几何，登记即可） |

而文件头自检写的是「R3-06 间距全部回栅格，tokens.css §6 例外清单已重写成真实集合」。
**依据**：这与上一轮 B2、R4-01 是同一类缺陷——**声明与实现不符会让后续评审失去可信基线**；
R3-06 当时按阻断口径处理，本条同源。
**建议**：`.feed` / `.feed-skel` 的 6px 收到 **4px 或 8px**（C 页目前底部还有约 17px 余量，收到 8px 也放得下）；
把 `.caret` 的 −1px 登记进清单；把清单里 V3 的两条改写成 page-b 口径；同步改自检那一行。
**并且**：请把这条断言写进 `verify.mjs`（全量 gap/padding/margin 比对栅格 + 与 §6 清单做集合比较），
否则它每换一次版面就会复发一次。

### R5-06 · P1 · 置信 0.85
**位置**：`.row:hover`（HTML 605 行）× `.row[data-unread="1"]`（620 行）/ `.row[data-kind="attention"]`（624 行）
**现象**：`.row:hover{background:var(--surface-elevated)}` 与 `.row[data-unread="1"]{background:var(--surface)}`
**特异度相同（0,2,0）**，后者写在后面所以赢。实测：
悬停已读行 → `rgb(16,17,17)` ✅；悬停**未读行** → 仍是 `rgb(13,13,13)`，**hover 无任何反馈**（`matches(':hover')` 为 true，颜色不变）。
attention 行同理（`--surface-card` 覆盖 hover）。
**即全屏唯一值得点的那一行——未读行 / 等待你批准那一行——没有指针反馈**。
**依据**：`interaction-states-pass` 要求每个可交互元素有 default / hover / active / focus 的可区分态；
简报的唯一交互就是「点击事件行 = ack」。
**缓解**：这块屏「鼠标极少用」，focus 与 active 都正常。
**建议**：把 hover 提成 `.row:hover{background:var(--surface-card)}` 并放到属性规则之后，
或改用不与背景争的载体（例如 hover 时 1px `--hairline-strong` 内描边），避免再被下一个状态色覆盖。

### R5-07 · P2 · 置信 0.70
**位置**：`renderPageA()` / `renderPageB()` 的 `<span class="loading-label sr">读取中</span>` · A / B 页 loading
**现象**：R4-13 要求「视觉上只保留一处『读取中』」，作者照做了——但那**唯一一处在 C 页**。
轮播之后 A、B、C 是三个不同的时刻，于是 A 页与 B 页的 loading 态**一个字都没有**，
只有骨架块（1.97:1）。`a-loading` 截图上可读性尚可（骨架清楚），但「正在读」这个语义只剩形状在传。
**依据**：`state-coverage` 要求 loading 与 empty 在视觉上可区分且可解释；`role="status"` 已经补齐了 AT 侧（B2 不回退）。
**建议**：A / B 页各恢复一处 14px 的「读取中」（顶栏时钟左侧是现成的空位，不占瓦片预算），
或让骨架带 shimmer 之外的显式语义——前者一行改完且不与 R5-05 的栅格冲突。

### R5-08 · P2 · 置信 0.75
**位置**：`.page-b .b-name{width:108px;display:inline-flex}` · B 页全部状态
**现象**：R3-05 的修法（固定列宽 + 省略号）被带进了轮播版，但**余量归零**：
「Claude Code」+ 6px 圆点 + 4px gap 实测需 **109px**，列宽 108px。
更要紧的是 `.b-name` 是 `inline-flex`，文本是匿名 flex item，**`text-overflow:ellipsis` 对它不生效**——
4× 截图确认既没有省略号也看不见裁切（只切掉约 1px 的反锯齿边缘）。
也就是说这条保险**装了但没通电**：真实数据里出现更长的 agent 名（例如「Claude Code Max」）时会是硬切，不是省略。
**建议**：`width:108px` → `min-width:112px`，并把文本包一层 `<span>` 让省略号作用在块级子项上；
或把 `.b-name` 改成 `display:flex` + 内层 `span{overflow:hidden;text-overflow:ellipsis}`。

### R5-09 · P2 · 置信 0.80
**位置**：`.msg{justify-content:center}`（HTML 521 行）· A 页 empty / error
**现象**：A 页三块瓦片在 msg 态下按各自内容垂直居中，行数不同就不共基线：
empty 实测标题顶边 `183 / 163.9 / 183`，error 实测 `164.1 / 173.5 / 173.5`，**最大差 19.1px ≈ 3 mm**。
数据态（R3-04 修过的那些）是完美共基线的，反差之下这两态的「三块不是同一个对象」更明显。
**依据**：`hierarchy-rhythm-review`「三块瓦片必须作为同一对象复现——同边、同基线、同内边距」。
**建议**：`.msg` 改 `justify-content:flex-start` 并给标题行一个固定顶边（例如与数据态的 `.a-body` 同起点），
让三块的第一行文字对齐；居中留给单块独立出现的场合。

### R5-10 · P2 · 置信 0.70
**位置**：`.page-b .band` 右端 · state=edge（Codex 97% / 2 分钟后重置）
**现象**：实测带宽 438px 上，填充止于 **424.86**、缺口到 **426.86**、游标 **433.62–435.62**、重置刻度 **436–438**——
**游标与重置刻度之间只剩 0.38px**，两个不同语义的标记并成一个约 4px 宽的明暗簇。
比单屏版（R4-08 当时是 218px 带宽）已经改善一档，但 97% + 窗口末期仍然是「最需要读准」与「最读不准」重合的那一刻。
**缓解**：此时「现在」确实≈「重置点」，语义上并不矛盾；同屏还有 20px 的红色 97% 与 14px 的「2m」。
**建议**：与 R5-02 一起做——重置刻度改成出头刻痕之后，它与带内的游标就再不会争同一段像素。

### R5-11 · P2 · 置信 0.85
**位置**：`.page-a .a-nums[data-wide="1"] .num{font-size:48px}`（HTML 546 行）+ `renderPageA()` 的 `w5.usedPercent >= 100`
**现象**：百分比达到 **100% 时字号从 64px 掉到 48px**，低于简报给 A 页定的 ≥64px 下限。
当前 7 个状态没有一个触发它（edge 是 97%），所以是潜伏项——但「额度用尽」恰恰是这块屏最该喊出来的时刻。
**依据**：`brief-m0-rotation.md` 字号表「A 页 5h 百分比 ≥64px」，没有写「三位数可以例外」。
**建议**：三位数时把 `%` 后缀藏掉（100 时「%」是冗余的），或让 `.num` 用 `font-stretch` / 收紧 `--tr-num` 到 −0.04em，
实测 149.3px 瓦片内宽放得下三位 64px 数字（单字宽约 37px × 3 = 111px < 133px 内宽）——**不必降档**。

### R5-12 · P2 · 置信 0.80
**位置**：`.page-a .tile-foot{white-space:nowrap;overflow:hidden}`（HTML 551–552 行）
**现象**：R3-11 给单屏版 `.tile-foot` 补的 `text-overflow:ellipsis` **没有带进轮播版 A 页**（只有 `overflow:hidden`），
而文件头自检写着「R3-11 tile-foot 补省略号」。当前最长一条「2h26m 偏紧」约 105px，瓦片内宽 133px，不溢出；
但它同时是 flex 容器，即使补上 `text-overflow` 也不会生效。
**建议**：要么把自检那一行改成「A 页 foot 用定宽 + 两档字号控制长度，不依赖省略号」（改声明），
要么给 `.word` 单独包一层可省略的块（改实现）。两者都行，但**不能继续两边不一致**——这是 R5-05 的同一根问题。

### R5-13 · P2 · 置信 0.85
**位置**：`rotateTick()` 的 `if (attnActive){ showPage("attn", {reset:false}); return; }`（HTML 1496 行）
**现象**：attention 接管期间，控制栏的页切换按钮在 **100ms 内被抢回 attn**（实测点 B 页后仍是 attn）。
简报把页切换定义为「手动查看用」，此时它失效；要看 A/B/C 必须先关掉轮播。
**依据**：这是「轮播暂停直到解除」的正确实现的副作用，不算违规，但控制栏是验收工具，
评审者在 attention 态下没法手动核对其它页（本轮我是靠关轮播绕过的）。
**建议**：手动点击时置一个 `manualHold`，让 `rotateTick` 在 attnActive 下也尊重一次手动选择（例如 10s 内不抢），
或在 meter 上写明「attention 接管中，手动切页需先关轮播」。属工具层，不进画布。

### R5-14 · P2 · 置信 0.90
**位置**：`root.dataset.rotate` 只在初始化时写入（HTML 1690 行），`chkRotate` 的 change 回调不同步
**现象**：`<html data-rotate>` 在切换「自动轮播」后**不更新**（实测重新勾选后 `localStorage.am.rotate="1"` 而 `data-rotate="0"`）。
目前没有任何 CSS 或 JS 读它，所以无功能影响——它是一个**死属性，且值是错的**。
**依据**：与 R3-06 / R5-05 同类——「代码里写着的规则和真实状态不一致」。作者自己在「新做的判断 5」里立过
「规则要写在代码里，不能只写在文档里」，这条是反例。
**建议**：要么在回调里同步，要么删掉这个属性。

### R5-15 · P2 · 置信 0.65
**位置**：`.page-b .b-verdict[data-tone="error"]{color:var(--danger)}`（HTML 573 行）· B 页 error
**现象**：整句（原因 + 下一步）连同图标全部 `--danger` 红，三条并排就是**整屏三行红字**（见 `b-error` 截图）。
单屏版的 error 只是瓦片里一行 12px，轮播版把它放大成 14px 满行之后，红色面积大了一个数量级。
**依据**：`brief-m0.md`「语义色不是 accent」是说它不占 accent 额度，不是说可以铺满；
`anti-ai-slop` 的「语义色被当作装饰」。而且「下一步」是中性动作，不该和「出错了」同色。
**建议**：图标 + 前半句（原因）保持 `--danger`，`·` 之后的下一步降到 `--body`。
这同时缩短了红色的横向连片，也顺手改善 R5-03 的可读性。

### R5-16 · P2 · 置信 0.50
**位置**：`.page-a .a-body{justify-content:center}` · A 页数据态
**现象**：瓦片内高 202px（218 − 2×8 padding）里，head 20 + gap 8 + foot 24 + gap 8 之后 body 剩 142px，
64px 的数字居中，**上下各余约 37px**。这段留白既不分组也不分层，是「一页只回答一个问题」腾出来的空位。
截图上并不难看（大数字四周有呼吸感），所以我给的置信不高。
**依据**：`hierarchy-rhythm-review`「留白要在讲结构」；对照 R4-10 对 V2 的同类判断。
**建议**：不改也行。若要改：把数字上移与 head 成组（`justify-content:flex-start` + 一个 16px 的间距），
把下方留白整体留给 foot，读起来会更像「名字 → 数字 → 还有多久」的三段式。

### R5-17 · P2 · 置信 0.60
**位置**：`.skel i` / `.feed-skel i` = `--stone`
**现象**：骨架对 surface **1.97:1**、对 canvas **2.03:1**，仍低于 3:1。
**依据**：这是 R3-07 自己给的取值（从 1.03 提上来），且 WCAG 对纯装饰骨架不强制 3:1——**不是新问题，只是没修干净**。
**建议**：M1 实机看一眼；若座位上仍偏弱，`--ash` 的 20% 透明叠层可以再提一档而不破坏 raycast 阶梯。

### R5-18 · P2 · 置信 0.60
**位置**：`.chip{font-size:14px;line-height:1;overflow:hidden}` · C 页所有事件行
**现象**：实测 `scrollHeight 16 > clientHeight 14`，字形上下各溢出 1px 并被 `overflow:hidden` 裁掉。
ALL-CAPS 拉丁字母的 cap height 在 14px Inter 上约 10px，**当前没有任何字形被切到**；
但一旦徽记里出现带下伸部的字符（或换成中文），就会被无声切边。
**依据**：R3-15 定下的口径——`overflow:hidden` 的盒子按 scrollHeight 判。
**建议**：`line-height:1` → `1.2`（行高 16.8px 吃得下），或去掉 `.chip` 的 `overflow:hidden`（它有 `nowrap`，不会换行）。

### R5-19 · P2 · 置信 0.55
**位置**：`tokens.css` §10 标题行「Seven steps, all used, 12px hard floor」
**现象**：§14 已经写明轮播层把下限抬到 14px、§10 保留作单屏版记录 ✅，但 §10 自己的标题行仍写着
「all used, 12px hard floor」。复用这份 token 的人（Electron 渲染层）从上往下读会先撞到这句。
**建议**：在 §10 标题行末加半句「—— 轮播版已由 §14 覆盖，见下」。一行注释。

### R5-20 · P2 · 置信 0.50
**位置**：attention 页 · 全屏最高优先级
**现象**：attention 页实测 accent 数 = **0**（身份色圆点 + 28px ink 标题 + 整卡呼吸）。
不违规，但「未读 / 需要你」这个 accent 的定义里，「需要你」正是这一页的主题。
**依据**：`brief-m0.md`「真正的强调只留给『未读 / 需要你』」。
**建议**：把 `.attn-who::before` 那颗 6px 身份色点换成 accent 白（或在卡片右上加一颗），
让 accent 的语义在最该出现的地方兑现一次。留给 lead，不改也成立。

---

## 8 · 已拍板决策符合性清单（`brief-m0-rotation.md` 逐条 + 沿用项抽验）

| # | 已定项 | 状态 | 证据 |
|---|---|---|---|
| 1 | 三页 A/B/C + attention 专用页 | ✅ | 4 个 `.page`，控制栏 4 个按钮，28 格全部可渲染 |
| 2 | A 页：名 + 状态点 + 5h% ≥60px + 倒计时，7d 不显示 | ✅ | 16 / 6px 点 / **64px** / 18px；`.a-body` 无 7d |
| 3 | B 页：名 + 判语 + 5h% + 7d% + 带高 ≥10px + 游标 + 重置刻度 | 🟡 | 前五项 ✅（带高 12px）；重置刻度存在但**不可辨**（R5-02） |
| 4 | C 页：最新 3–4 条，第一条放大，无计数文字 | ✅ | `ROW_BUDGET = 4`，lead 20px，`grep` 无计数 |
| 5 | 任何文本 ≥14px | ✅ | 28/28 minFont = 14 |
| 6 | 时钟 14px | ✅ | 14px mono tabular |
| 7 | A 页 % ≥64px | 🟡 | 64px ✅；**100% 时降到 48px**（当前无状态触发，R5-11） |
| 8 | A 页 agent 名 16px / 倒计时 ≥18px | ✅ | 16 / 18 |
| 9 | B 页 % ≥20px / 7d 16px / 判语 ≥14px | ✅ | 20 / 16 / 14 |
| 10 | C 页最新标题 ≥20px 单行 / 其余 16px / 时间 14px | ✅ | 20 · nowrap · ellipsis / 16 / 14 |
| 11 | attention 页「等待你」≥24px / 说明 ≥18px | ✅ | 28 / 18 |
| 12 | 空态 / error 原因句 14–16px 一句话 | ✅ | 16 + 14；三条 error 各不相同 |
| 13 | 停留 A 10s / B 6s / C 6s | ✅ | token + **实测 10.00 / 5.97 / 6.00** |
| 14 | 空闲加速 B/C → 4s | 未验证 | token `--dwell-idle 4s` ✅，代码路径存在；需快进 30 分钟 |
| 15 | 切页 300ms + reduced-motion 直接切换 | ✅ | `--dur-page 300ms` opacity+transform；两条通道实测 0s |
| 16 | 指示点：三个 4px 圆点，当前 ink 其余 ash，不算 accent | ✅ | 4px/gap 4/右下 8px；`data-not-accent` 显式排除 |
| 17 | attention 接管 + 轮播暂停 + 解除回 A | ✅ | 12s 全 attn；解除后 200ms 内回 A |
| 18 | 新事件 → 立刻 C 停 20s，再来一条重置 | ✅ | 60ms 到 C；19.8→0.6s；第二条重置回 19.8s |
| 19 | running 不打断，只脉冲 + C 页顶行「进行中」 | ✅ | `.iddot` pulse 2s；C 页顶行 kind=running |
| 20 | 不让任何页停留 < 4s | ✅ | 最小 token 4s |
| 21 | 不加第四页 | ✅ | 三页 + attention 专用页 |
| 22 | 不恢复被砍内容（品牌字 / cwd / 1mo / 另 N 条 / 未读计数） | ✅ | 28 格 innerText 全量扫描 0 命中 |
| 23 | 控制栏：页 / 轮播开关 / 7 态 / 模拟事件 / 模拟等待 / reduced-motion + 剩余秒数 | ✅ | 全部存在且生效 |
| 24 | localStorage 记住轮播开关与手动页 | ✅ | `am.rotate` / `am.page` 实测跨重载 |
| 25 | 截图 4 张 960×540 @2x | ✅ | `page-{a,b,c,attention}.png` 实测 **1920×1080** |
| 26 | 内联 tokens 与 tokens.css 逐字相同 | ✅ | 去空白后完全相同（19318 字符） |
| 27 | accent ≤2（全量按颜色扫描） | ✅ | 每格 ≤1 纯白 + 呼吸叠层 |
| 28 | 轨道 ≥3:1、填充边界靠缺口 | ✅ | 轨道 3.54–3.75；缺口 3.75–13.3 三档全过 |
| 29 | focus 非默认蓝、可见 | 🟡 | 样式 ✅ 17.05:1；但可落在隐藏页上（R5-01） |
| 30 | Tab 顺序合理 | ❌ | 隐藏页 4 个行可聚焦（R5-01） |
| 31 | reduced-motion 全停 | ✅ | 双通道实测 |
| 32 | 无 emoji / 渐变 / 靛蓝 / 左侧色条 / 大面积黑白 / 投影 | ✅ | 全部 0 命中 |
| 33 | 不加滚动 / 翻页 | ✅ | 无 `overflow:auto/scroll`；`.pages` 无横向滚动区 |
| 34 | 上两轮 B/Q/P 修复不回退 | 🟡 | 抽验 16 项全部保留；2 项部分落实（R5-05 / R5-08），1 项仅 token 层（V2 弧） |
| 35 | 旧版由 git 历史保留 | ❌ | 仓库仍 0 commit（沿用 R3-14，作者已交 lead 拍板） |

---

## 9 · 汇总与结论

| 严重度 | 条数 | 编号 |
|---|---|---|
| **P0** | **1** | R5-01 |
| **P1** | **5** | R5-02 · R5-03 · R5-04 · R5-05 · R5-06 |
| **P2** | **14** | R5-07 ~ R5-20 |

### 结论：**修完 4 条后可发布**

必修（发布前）：

| 编号 | 一句话 | 修法 | 工作量 |
|---|---|---|---|
| **R5-01 · P0** | 隐藏页的 4 个事件行仍在 Tab 序里，且在 `aria-hidden` 子树内 | 非当前页加 `inert` | 一行 |
| **R5-03 · P1** | B 页 error/empty 的「下一步」被省略号截掉 | msg 态让出 `.b-pc/.b-sec/.b-cd` 的 118px，或回两行 | 小 |
| **R5-04 · P1** | C 页「29 分钟前」溢出 58px 列，与完成图标相接 | 时间列 58→68px 并补 `overflow:hidden` | 一行 |
| **R5-05 · P1** | §6 例外清单第二次与实现失配 + 自检行不实 | 收两处 6px、登记 caret 的 −1px、重写清单与自检行，并把这条断言写进 `verify.mjs` | 小 |

建议顺手一起做（都是一到三行，且不引入回归）：
**R5-02**（重置刻度改出头刻痕，同时解掉 R5-10）· **R5-06**（未读行 hover）·
**R5-11**（100% 不降档）· **R5-14**（`data-rotate` 同步或删除）· **R5-12 / R5-19**（把两处声明改到与实现一致）。

可以进 M1 的：R5-07 · R5-08 · R5-09 · R5-13 · R5-15 · R5-16 · R5-17 · R5-18 · R5-20。

### 本轮未验证 / 需实机确认

1. **空闲加速（30 分钟 → 4s）**：代码路径活，断言只覆盖 token 取值，未快进时钟。
2. **提示音**：headless 静音，只确认不抛异常、reduced-motion 下不响。
3. **节奏是否合适**：10/6/6 在座位上是快是慢、64px 会不会反而过大、切页滑动在 zoom 2 下是否顺滑——全部只在 Chromium 截图上看过。**22s 一轮是推算不是实测**。
4. **物理可读性**：本轮沿用 R4 的 0.16 mm/px @ 55 cm 几何换算，未上实机；14px 下限是否真的越过「认得出」那条线，只有实机能判。
5. **瓦片边框 1.33:1**（R3-13）：轮播版每页元素更少、分组更靠位置，风险更低，仍是实机待验项。
6. **多页之后的「找不到」风险**：三页轮播的核心假设是「A 回归得够快」，原型验不了，要看人实际会不会去等页。

### 给下一轮的一条方法论

本轮三条 P0/P1（R5-01 / R5-03 / R5-04）的共同成因是：**版面重排会把旧断言的前提换掉，但断言集合没跟着换**。
四页常驻 DOM 让「focus 可见」不再等价于「focus 元素有描边」；
把信息从瓦片搬进单行让「文本不溢出」不再等价于「容器不滚动」——
`.rtime` 和 `.b-verdict` 都是**没有 `overflow:hidden` 所以扫不出来**的溢出。
建议在 `verify.mjs` 里加两条通用断言，它们与具体版面无关：

1. **可聚焦元素必须可见**：`document.querySelectorAll('button,[tabindex]')` 逐个检查
   最近的 `aria-hidden="true"` 祖先与祖先链上的 `opacity < 0.1`，命中即失败。
2. **文本盒的内容宽必须 ≤ 容器宽**：对所有含文本的元素比对 `scrollWidth/clientWidth`，
   **不要只查 `overflow:hidden` 的盒子**——溢出到邻居身上的那种恰恰查不到；
   再对相邻栅格列做 bounding box 相交检查（本轮 R5-04 就是这样抓到的）。
