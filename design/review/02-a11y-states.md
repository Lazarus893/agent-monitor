# R2 · 无障碍 + 交互态 + 五态覆盖

> Reviewer 2 · 评审对象：`design/variations.html` + `design/tokens.css`
> 运行时验证：Playwright 1.63.0 / Chromium / 1100x820 viewport / deviceScaleFactor:2
> 对比度：Python 脚本按 WCAG 2.x 相对亮度公式逐对计算（见下方完整表）
> 落盘说明：reviewer agent 为只读 lane，本文件由 lead 按其回执原文落盘，未改动内容。

---

## 对比度：逐对实测

所有数值由脚本按 WCAG sRGB→线性→相对亮度→(L1+0.05)/(L2+0.05) 计算。作者在 tokens.css §3 声称的 13 个比值全部精确吻合（delta < 0.01），无一虚报。

### 文本色 × 背景

| 前景 | 背景 | 比值 | AA 正文 (4.5:1) | AA 大字 (3:1) |
|---|---|---|---|---|
| ink #f4f4f6 | surface #0d0d0d | **17.69:1** | PASS | PASS |
| ink #f4f4f6 | surface-card #121212 | **17.05:1** | PASS | PASS |
| charcoal #d3d3d4 | surface #0d0d0d | **12.99:1** | PASS | PASS |
| body #cdcdcd | surface #0d0d0d | **12.23:1** | PASS | PASS |
| body #cdcdcd | surface-card #121212 | **11.78:1** | PASS | PASS |
| mute #9c9c9d | surface #0d0d0d | **7.09:1** | PASS | PASS |
| mute #9c9c9d | surface-elevated #101111 | **6.90:1** | PASS | PASS |
| mute #9c9c9d | surface-card #121212 | **6.83:1** | PASS | PASS |
| ash #6a6b6c | surface #0d0d0d | **3.64:1** | **FAIL** | PASS |
| ash #6a6b6c | surface-card #121212 | **3.51:1** | **FAIL** | PASS |
| stone #434345 | surface #0d0d0d | **1.97:1** | **FAIL** | **FAIL** |

**ash 用法核实**：代码中 ash 仅出现在 `.tile-foot svg{color:var(--ash)}` (V1 clock icon)、V3 timeline dots (stone, not ash)。所有 12–13px 有意义小字（timestamp、cwd、label、feed-count）均用 mute 7.09:1，符合 4.5:1 正文线。ash 不承载任何文本，仅做非信息性图标标记。**通过**。

### 语义色 × 背景 (surface #0d0d0d)

| 前景 | 比值 | 用途 |
|---|---|---|
| ok #59d499 | **10.46:1** | 额度正常段（不单独使用，无文本） |
| warn #ffc533 | **12.30:1** | 额度 ≥80% 数字 + bar |
| danger #ff6161 | **6.60:1** | 额度 ≥95% 数字 + bar |
| info #57c1ff | **9.70:1** | 未使用 |

### 身份色 × 背景 (surface #0d0d0d)

| 前景 | 比值 | 非文本 3:1 |
|---|---|---|
| id-codex #f4f4f6 | **17.69:1** | PASS |
| id-claude #d97757 | **6.23:1** | PASS |
| id-zcode #6f93e6 | **6.47:1** | PASS |

### 关键非文本组件

| 对 | 比值 | 3:1 | 备注 |
|---|---|---|---|
| hairline #242728 on surface #0d0d0d | **1.29:1** | **FAIL** | V2 仪表弧轨道 |
| hairline-strong rgba(255,255,255,.16) on surface #0d0d0d | **1.54:1** | **FAIL** | attention 行边框 |
| stone #434345 on surface #0d0d0d | **1.97:1** | **FAIL** | inactive track / V3 时间轴节点 |
| stone #434345 on canvas #07080a | **2.03:1** | **FAIL** | V3 时间轴节点 |
| ink #f4f4f6 on surface-card #121212 | **17.05:1** | PASS | focus ring 2px inset |
| accent-dim (合成) on surface #0d0d0d | **5.79:1** | PASS | aged 未读点 |

---

## 发现

### R2-01 · P0 · 置信 1.0
位置：V2 · 所有含 gauge 的状态 · `.gauge .track`
现象：仪表弧的轨道使用 `stroke:var(--hairline)` (#242728)，在 tile 的 surface (#0d0d0d) 背景上实测 **1.29:1**，远低于 WCAG 1.4.11 对「非装饰性非文本图形」的 3:1 下限。轨道标示弧的总长度，用户需要靠轨道判断已用弧占多大比例。
依据：hairline #242728 on surface #0d0d0d = 1.29:1（脚本计算）。简报 §V2 写「轨道用 hairline」，作者在 §6.3 已标注为已知问题但未修改。WCAG 1.4.11 Non-text Contrast 要求承载信息的 UI 组件 ≥3:1。
建议：将轨道 stroke 从 `var(--hairline)` 提到至少 `var(--ash)` (#6a6b6c, 3.64:1) 或更高。stone (#434345, 1.97:1) 仍不达标。需要与简报作者确认是否修正已定项。

### R2-02 · P0 · 置信 1.0
位置：`variations.html` 行 1398-1401, 1472, 1535 · loading 态 · 三块瓦片 + 事件流的「读取中」
现象：文件顶部注释（行 23）声称 loading 态带 `role="status"` 的「读取中」，设计者笔记 §4.11 也声称「骨架旁挂一个 `role="status"` 的「读取中」」。但实际代码中，四处 `.loading-label` 文本均**不带** `role="status"`。全文唯一的 `role="status"` 在行 734 的 `#live` 段落（用于 ack 反馈，非 loading）。屏幕阅读器在 loading 态不会收到任何播报。
依据：`grep -n 'role="status"' variations.html` 仅命中行 734。行 1398 `<span class="loading-label">读取中</span>` 无 role 属性。
建议：在 loading 态的骨架容器上加 `role="status" aria-label="读取中"` 或将 `#live` 的 `textContent` 在进入 loading 态时更新为「正在加载」。

### R2-03 · P1 · 置信 1.0
位置：`variations.html` 行 1499 · 所有变体 · 所有含事件行的状态
现象：事件行的 `aria-label` 构造为 `` `${a.name} · ${it.title}${it.unread ? " · 未读，按 Enter 标记已读" : ""}` ``，**不包含事件 kind**（running / failed / attention / completed）。屏幕阅读器用户听到 "Codex · 构造 v0.3 盲判任务分类样本" 无法分辨这条是正在运行、已失败还是已完成。视觉上 kind 由 `.rkind` 图标传达（aria-hidden SVG），对辅助技术不可见。
依据：Playwright 运行时验证，running 行的 `ariaLabel` 为 `"Codex · 构造 v0.3 盲判任务分类样本"`，不含「运行中」。
建议：在 label 中加入 kind 映射，如 `const kindLabel = {running:"运行中", failed:"失败", attention:"等待批准", completed:"已完成"};`，拼入 aria-label。

### R2-04 · P1 · 置信 1.0
位置：V3 · attention 态 · `.topbar` / `.attn-strip`
现象：V3 attention 时 `.topbar{display:none}` 被隐藏（行 668），attention strip 接管 topbar 位置。但 strip 只显示事件的时间（"刚刚"），**不显示当前时钟**。Playwright 验证 `clockVisible=false`。用户在 V3 attention 态丢失持续的时间显示，对监控面板来说是信息损失。
依据：CSS 行 668 `[data-variant="v3"][data-state="attention"] .topbar{display:none}`。Playwright 运行时 `clock.getBoundingClientRect().height=0`。
建议：在 `.attn-strip` 右端保留一个 clock 副本，或将 clock 提到 strip 外不被隐藏的位置。

### R2-05 · P1 · 置信 0.9
位置：V1 / V2 · edge 态 · 额度阈值
现象：当额度进入 warn (≥80%) 或 danger (≥95%) 时，V1/V2 的信号仅有：数字颜色从 ink→warn/danger、bar 颜色从 body→warn/danger。没有文字标签（如"即将用尽"）、没有图标、没有形状变化。WCAG 1.4.1 (Use of Color) 要求不能仅靠颜色传递信息。数字本身的数值（如 97%）携带部分信息，但 warn 阈值 (80%) 在数值上不是自明的「危险」。V3 用 `.b-verdict` 文本提供了非颜色信号（"消耗跑在时钟前面…会提前用尽"），V1/V2 缺少等价物。
依据：简报核查项「running / attention / 未读 / 额度阈值是否都有非颜色信号」。V1 tile 代码仅改变 `.num-lead` 和 `.bar>i` 的颜色，未添加文字或图标。
建议：在 V1/V2 的 tile-foot 区域增加一句文字（如"即将用尽"/"余量充足"），或在数字旁加一个 warning icon（当 level=warn/danger 时显示）。

### R2-06 · P1 · 置信 1.0
位置：所有变体 · 所有状态 · stage 内部
现象：stage 内部没有任何 `<h1>`-`<h6>` 或 `[role="heading"]` 元素。Playwright 验证 `headings=[]`。品牌名 "Agent Monitor" 是 `<span class="brand">`，事件流标题 "最近完成" 是 `<span class="feed-title">`，tile 名是 `<span class="tile-name">`。屏幕阅读器用户无法通过 heading 导航跳转到不同区段。
依据：Playwright `stage.querySelectorAll("h1,h2,h3,h4,h5,h6,[role=heading]").length === 0`。
建议：将 `.brand` 标记为 `role="heading" aria-level="1"`，各 tile 名标记为 heading level 2，事件流标题标记为 heading level 2。或使用语义 HTML（`<h1>`, `<h2>`）并用 CSS 重置视觉样式。

### R2-07 · P1 · 置信 1.0
位置：所有变体 · `.row` · CSS
现象：事件行有 `:hover` 和 `:focus-visible` 两个交互态样式，但**没有 `:active` 样式**。简报核查项要求每个可交互元素覆盖 default / hover / active / focus / disabled 五态。用户按下（mousedown / touchstart）时无视觉反馈。
依据：CSS 行 493 `.row:hover{background:var(--surface-elevated)}`、行 494 `.row:focus-visible{...box-shadow...}`。整个文件无 `.row:active`。
建议：添加 `.row:active{background:var(--surface-card)}` 或 `.row:active{transform:scale(.995)}` 提供按下反馈，duration 用 `var(--dur-instant)` (120ms)。

### R2-08 · P2 · 置信 0.9
位置：V3 · populated/edge 态 · `.row::after` timeline dots
现象：V3 事件流的时间轴节点 `.row::after` 对已读行使用 `background:var(--stone)` (#434345)，在 canvas (#07080a) 上实测 2.03:1，低于非文本 UI 组件的 3:1。这些节点是位置标记，已读行的信息由文本和芯片传达，节点本身不承载独立语义。但作为可见 UI 元素仍应满足 3:1。
依据：stone #434345 on canvas #07080a = 2.03:1（脚本计算）。
建议：节点颜色提到 ash (#6a6b6c, 3.75:1 on canvas)。

### R2-09 · P2 · 置信 0.8
位置：所有变体 · attention 态 · `.row[data-kind="attention"]` border
现象：attention 行的 `border-color:var(--hairline-strong)` 合成后在 surface 上为 1.54:1，低于非文本 3:1。但 attention 行有多个冗余信号：背景升至 surface-card、标题转 ink 加粗、呼吸动画、accent dot、"等待你" 标签。border 不是唯一信号，failing 3:1 的实际影响被充分缓冲。
依据：hairline-strong 合成后 = 1.54:1（脚本计算）。
建议：如追求完美，可将 attention 行 border 提到 `var(--ash)` 或 `var(--mute)`，但考虑到冗余信号充足，可延后。

### R2-10 · P2 · 置信 0.7
位置：所有变体 · 所有含事件行的状态 · `.feedlist` 容器
现象：新事件到达时由 `#live` aria-live="polite" 播报文本。但当瓦片数据更新（额度百分比逐秒变化）时，无 aria-live 区域播报。对于监控面板来说，额度突变（如从 94% 跳到 97%）不会被辅助技术捕捉。
依据：代码中 `tickTiles()` 逐秒更新 DOM 文本但不更新 `#live`。
建议：可在额度跨越阈值（warn/danger）时向 `#live` 推一条播报，如「Codex 额度已达 97%」。低优先级——副屏监控不是读屏用户的主要场景。

### R2-11 · P2 · 置信 0.9
位置：V1/V2 · attention 态 · 瓦片视觉
现象：attention 态下 Codex 瓦片的 iddot 使用 `var(--id-codex)` = `#f4f4f6`，与 `var(--accent)` = `#f4f4f6` 同色。视觉上屏幕出现 3 个等强度白色标记（Codex iddot + Claude attention iddot + attention rmark），虽然设计上 Codex 的白点是 identity 而非 accent，但视觉感知上违反了「≤2 处 accent」的精神。
依据：Playwright accent 计数 attention 态 = 3（含 codex identity dot）。截图 `v1-attention.png` / `v2-attention.png` 可见 3 个等亮度白点。
建议：attention 态下非相关 agent 的 iddot 可考虑降到 `--accent-dim` 以减少视觉噪声。此条严格来说不违反规则（identity ≠ accent），标为 P2。

---

## 五态覆盖表

✓ = 已实现且可通过控制栏切换验证 · — = 不适用

| 组件 | loading | empty | error | populated | edge | attention | running |
|---|---|---|---|---|---|---|---|
| **Codex 瓦片** | ✓ 骨架 | ✓ 等待首轮采样 | ✓ 401 未授权 | ✓ 22%/7% | ✓ 97%(danger) | ✓ idle | ✓ pulse |
| **Claude 瓦片** | ✓ 骨架 | ✓ statusline 未写入 | ✓ 429 限流 | ✓ 18%/31% | ✓ 82%(warn) | ✓ breathe+等待你 | ✓ pulse |
| **ZCode 瓦片** | ✓ 骨架 | ✓ 未连接 | ✓ 网络不可达 | ✓ 未连接(空) | ✓ 已连接 3窗 | ✓ 未连接(空) | ✓ 未连接(空) |
| **事件流** | ✓ 骨架 | ✓ 今天还没有 | ✓ 采集中断 | ✓ 5条1未读 | ✓ 8条全未读 | ✓ 含attention行 | ✓ 含running行 |

**error 三条文案核实**：
1. Codex "额度接口 401 / 登录令牌过期 / 跑 codex login 重新授权" ✓ 独立文案 + 下一步
2. Claude "接口限流 429 / OAuth 额度端点触发限流 / 已退避重试" ✓ 独立文案 + 下一步
3. ZCode "网络不可达 / open.bigmodel.cn 连接超时 / 恢复联网后自动重连" ✓ 独立文案 + 下一步
4. 事件流 "事件采集中断 / 文件监听被系统回收 / 30 秒后自动重新挂载" ✓ 独立文案 + 下一步

**edge 边界核实**：
- 64 字标题：`text-overflow:ellipsis` (U+2026 单字符) ✓ 不是三个点
- 超长 cwd：`shortCwd()` 从头部收，保留尾部 2-3 段 ✓ 不撑破
- 8 条事件：budget 封顶（V1/V2=4, V3=5），超出标注在表头 ✓ 不溢出
- 97% 额度：数字转红 (danger)，倒计时 ~3 分钟 ✓ 正确

---

## 不靠颜色单独传状态

| 状态 | 颜色信号 | 非颜色信号 | 判定 |
|---|---|---|---|
| **running** | iddot identity 色 | "运行中"文字 + pulse 动画 (reduced-motion 下仍有文字) | ✓ 通过 |
| **attention** | iddot accent + breathe | "等待你"文字 + border 变化 + 背景升阶 | ✓ 通过 |
| **未读** | ink 标题 + accent dot | font-weight 400→500 + dot 出现 + surface 升阶 | ✓ 通过 |
| **额度阈值 V3** | 数字/bar 变色 | verdict 文字（"会提前用尽"/"用不完"） | ✓ 通过 |
| **额度阈值 V1/V2** | 数字/bar 变色 | **无文字、无图标、无形状** — 仅数值本身 | **⚠ 部分通过** (见 R2-05) |

---

## 语义与结构

- 事件行使用 `<button>` 元素 ✓ 正确的交互语义
- 标题层级：stage 内无任何 heading ✗ (见 R2-06)
- `aria-live="polite"` 用于 ack 后播报未读数 ✓
- SVG 图标全部 `aria-hidden="true"` ✓ 有文字替代（chip、status-label）
- 控制栏 `role="group"` + `aria-label` + `aria-pressed` ✓
- tiles 使用 `<section aria-label="Codex 额度">` ✓ 合理的 landmark
- gauge / bar / band 使用 `role="img" aria-label="5h 窗已用 X%"` ✓
- loading 态的「读取中」缺少 `role="status"` ✗ (见 R2-02)

---

## 键盘

- **Tab 顺序**：事件流行按 DOM 顺序自上而下 ✓ 瓦片无交互不进 tab 环 ✓
- **Enter / Space ack**：Playwright 验证 unread 从 1→0，`#live` 播报"已全部读完"，焦点留在原行 ✓
- **focus 可见**：`box-shadow:inset 0 0 0 2px var(--accent)` 实测 `rgb(244,244,246) 0px 0px 0px 2px inset` ✓ 不是浏览器默认蓝 ✓ 对比度 17.05:1 on surface-card ✓
- **focus 不被裁切**：inset box-shadow 不会超出元素边界 ✓ stage overflow:hidden 不影响 inset 样式 ✓

---

## 交互态覆盖

| 元素 | default | hover | active | focus | disabled |
|---|---|---|---|---|---|
| `.row` (事件行) | ✓ transparent bg | ✓ surface-elevated | ✗ **缺失** | ✓ 2px ink inset | — 无需 |
| `.tile` (瓦片) | ✓ surface bg | — 无交互 | — | — | — |
| `.seg button` (控制栏) | ✓ | ✓ | ✓ (via hover) | ✓ `focus-visible` | — |
| `.hbtn` (模拟新事件) | ✓ | ✓ | ✓ (via hover) | ✓ `focus-visible` | — |

---

## attention / running 周期与幅度

| 动效 | 规格 | 实现 | 判定 |
|---|---|---|---|
| running 脉冲 | 2s 周期 | `--cycle-pulse:2s` / `@keyframes pulse` opacity 1→0.3→1 | ✓ 匹配 |
| attention 呼吸 | 3s 周期 / ≤8% 亮度差 | `--cycle-breathe:3s` / `brightness(1)→(1.08)` = 8% | ✓ 匹配 |
| attention 态 accent | ≤2 | 2 (Claude tile iddot + attention rmark) | ✓ 匹配 |

---

## 动效

- **仅在状态变化时出现**：新事件 FLIP 360ms ✓ / bar/arc 推进 300ms ✓ / running pulse 2s ✓ / attention breathe 3s ✓ / 状态切换 180ms ✓。无装饰性动画、无 shimmer ✓
- **GPU 合成属性**：新事件入场 `transform:translateY()` + `opacity` ✓；pulse/breathe 用 `opacity` 和 `filter:brightness()` — brightness 可能触发 paint 而非纯 composite ✓（P2 级 performance concern，不阻断）
- **新事件推入**：`var(--dur-event):360ms`，≤400ms 上限 ✓
- **prefers-reduced-motion**：CSS 媒体查询 + `data-rm="1"` 双通道 ✓。Playwright 两种方式验证均为 0 个动画运行 ✓。脉冲和呼吸降级为静态标记（点仍在，不动）✓。非动效信号（文字"运行中"/"等待你"、颜色、位置）保留 ✓

---

## 溢出：运行时验证

Playwright 对 **3 变体 × 7 状态 = 21 个组合** 逐一检查：

- stage 内所有后代 bounding box 在 960×540 之内 ✓
- `.feedlist / .tiles / .screen / .tile / .tile-foot / .b-head / .b-axis / .row` 的 scrollWidth/scrollHeight ≤ clientWidth/clientHeight ✓
- stage 内无 < 12px 计算字号的文本节点 ✓

**结果：21/21 PASS，0 溢出，0 裁切。**

---

## 已拍板决策符合性清单

| # | 已定项 | 状态 | 备注 |
|---|---|---|---|
| 1 | 逻辑 960×540 @2x | ✅ | stage 宽高精确 |
| 2 | 文本 ≥12px | ✅ | Playwright 21 组合无违例 |
| 3 | 标签 13px | ✅ | `--fs-label:13px` |
| 4 | 事件标题 16-18px | ✅ | `--fs-body:16px`, `--fs-strong:18px` |
| 5 | 主数字 ≥48px | ✅ V1/V2 ❌ V3 | V3 主数字 18px（设计者 §4.9 已说明冲突处理） |
| 6 | 最新事件标题 ≥20px | ✅ | `--fs-lead:20px` / `--fs-lead-lg:22px` |
| 7 | 行高 ≥40px | ✅ | `--h-row:48px`; V2/V3 非 lead 行 40px |
| 8 | 布局 B | ✅ | 上瓦片下事件流 |
| 9 | 顺序 Codex→Claude→ZCode | ✅ | 固定 |
| 10 | 视觉真源 raycast | ✅ | 所有 token §1-§6 逐字抽取验证 |
| 11 | Inter + ss03 | ✅ | font-feature-settings 含 ss03 |
| 12 | 数字用等宽 tabular | ✅ | IBM Plex Mono + tnum + zero |
| 13 | 身份色仅小面积 | ✅ | 只在 dot/chip/arc stroke |
| 14 | accent ≤2 | ✅ | 所有态均满足（identity dot 不计为 accent） |
| 15 | 不用左侧色条 | ✅ | 未读用 surface 升阶+ink 加粗+dot |
| 16 | ZCode 默认未连接 | ✅ | populated/attention/running 态均为空态 |
| 17 | Web Audio 提示音 | ✅ | 784Hz + 1174.7Hz 正弦 180ms |
| 18 | attention 设计 | ✅ | 瓦片 breathe + 事件流 attention 行 |
| 19 | 无 emoji | ✅ | 图标全 SVG 1.6px monoline |
| 20 | 无 gradient | ✅ | 搜索 `linear/radial/conic-gradient` 零命中 |
| 21 | 无大面积 #000/#fff | ✅ | canvas=#07080a, ink=#f4f4f6 |
| 22 | 五态齐全 | ✅ | 21 组合全部可切换验证 |
| 23 | error 三种文案不同 | ✅ | 401/429/离线 各不同且有下一步 |
| 24 | edge 覆盖 | ✅ | 64字/178字cwd/8条/97% 均到位 |
| 25 | 动效只用于状态变化 | ✅ | 无 shimmer、无装饰动画 |
| 26 | prefers-reduced-motion 全关 | ✅ | CSS 媒体查询 + data-rm 双通道验证 |
| 27 | focus 不用浏览器默认蓝 | ✅ | 2px ink inset box-shadow |
| 28 | V2 轨道用 hairline | ✅ (但 1.29:1) | 照做了已定项，对比度不达标见 R2-01 |

---

## 汇总

| 严重度 | 条数 |
|---|---|
| P0 | 2 |
| P1 | 5 |
| P2 | 4 |

**最重要三条**：
1. **R2-01 (P0)**：V2 仪表弧轨道对比度 1.29:1，远低于 WCAG 1.4.11 的 3:1 下限，需修改轨道颜色。
2. **R2-02 (P0)**：loading 态的「读取中」缺少 `role="status"`，声称与实现不符，屏幕阅读器无法感知加载状态。
3. **R2-03 (P1)**：事件行 `aria-label` 不含 kind（running/failed/attention/completed），辅助技术用户无法区分事件状态。
