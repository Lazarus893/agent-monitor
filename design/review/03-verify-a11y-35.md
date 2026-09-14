# R3 · 复核 · 无障碍 + 交互态 + 五态 + 新画布几何（3.5 寸版）

> 评审对象：`design/variations.html`（480×270 画布 / zoom 2）与 `design/tokens.css`
> 依据：`design/brief-m0-35.md`（差量简报）、`design/brief-review.md`（通用要求与严重度）、
> `design/review/01-slop-hierarchy.md`、`02-a11y-states.md`、`00-designer-notes.md` 末两节（返工记录 + 3.5 寸版）
> 运行时验证：Playwright 1.63.0 / Chromium 153 / viewport 1100×900 / `deviceScaleFactor:2` /
> **3 变体 × 7 状态 = 21 个组合逐个实测**；对比度由脚本按 WCAG 2.x
> sRGB→线性→相对亮度→`(L1+.05)/(L2+.05)` 现算，含 alpha 合成与祖先链背景推导
> 本 lane 只读，只写本文件；`design/` 下其它文件未改动

---

## 0 · 结论摘要（先看这里）

| 项 | 结果 |
|---|---|
| 15 条返工（B1–B4 / Q1–Q7 / P1–P4）落到 3.5 寸版 | **12 条已落实 · 3 条部分（B1 / Q5 / P1）· 0 条未落实** |
| 新画布几何 6 项硬指标 | **6/6 通过** |
| console error / pageerror（21 组合） | **0 / 0** |
| 本轮新增发现 | **P0 ×1 · P1 ×6 · P2 ×9** |
| 结论 | **修完 4 条（R3-01 P0 + R3-02 / R3-04 / R3-06 P1）后可发布** |

**一句话**：B1「轨道提到 `--ash`」这条修对了轨道，但它的两个连带修正在 3.5 寸版上留了尾巴——
填充只在 `ok` 档提到了 `--ink`（warn/danger 档没跟上，danger 填充与轨道只剩 **1.81:1**），
而提上去的 `--ink` 填充本身就是 `--accent` 的同一个 hex，于是 V1 / V3 的额度填充成了全屏面积最大的那块 accent，
把 Q1 好不容易腾出来的 accent 名额又吃回去了。其余 13 条修得干净。

---

## 1 · 15 条返工逐条验证（是否真的落在 3.5 寸版里）

判定口径：**必须在 `design/variations.html`（3.5 寸版）里成立**，960 版成立不算数。
每条给运行时证据或行号。

### 阻断类

#### B1 · 轨道类图形一律 ≥3:1 —— 🟡 **部分落实**

已落实的部分：

| 轨道 | 行号 | 取色 | 底色 | 实测 |
|---|---|---|---|---|
| V1 bar 轨 | 486 `.bar{background:var(--quota-track)}` | `--ash` #6a6b6c | `--surface` #0d0d0d | **3.64:1** ✅ |
| V2 仪表弧轨 | 589 `.gauge .track{stroke:var(--quota-track)}` | 同上 | 同上 | **3.64:1** ✅ |
| V3 时间带轨 | 622 `.band{background:var(--quota-track)}` | 同上 | 同上 | **3.64:1** ✅ |
| 以上三者在 attention 瓦片（`--surface-elevated` #101111）上 | — | — | — | **3.54:1** ✅ |
| V3 游标翻暗色 | 628 `.caret{background:var(--canvas)}` | #07080a | ash 轨 / ink 填充 / warn 填充 / danger 填充 | **3.75 / 18.24 / 12.68 / 6.81:1** ✅ |
| `--quota-track` / `--quota-fill` token | tokens.css 240–241 | — | — | 与 960 版逐字相同 ✅ |

**没落实的部分（三条，全部是 B1 自己声明的「连带修正」）：**

1. **填充只在 `ok` 档提到了 `--ink`。** `.bar[data-level="danger"]>i`（行 490）、
   `.gauge .prog`（行 593）、`.band .used`（行 626）在 danger 档改回 `--danger` #ff6161，
   叠在提亮后的 ash 轨道上实测 **1.81:1**。作者笔记写的「填充与轨道之间恢复到 4.86:1」
   只对 `ok` 档成立。实测三档：`ink 4.86:1` ✅ · `warn 3.38:1` ✅ · **`danger 1.81:1` ❌**。
   提亮轨道之前（`--hairline` #242728）danger 填充与轨道约 5.1:1——**B1 让 danger 档变差了**。
   详见 R3-01。
2. **V2 的身份色进度弧只补了 1px 形状差，在 3.5 寸上等于没补。** 见 R3-02。
3. **「V3 刻度翻成暗色」这条在本画布上已无对象**：`.b-axis` 与 `.row::after` 时间轴节点
   在 3.5 寸版被砍掉了（`grep -c b-axis` = 0，`.row::after` 仅存在于 tokens.css 注释里）。
   只剩游标，已验证达标。这条不算未落实，但 tokens.css §6 还在列它，见 R3-14。

#### B2 · loading 的 `role="status"` —— ✅ **已落实**

行 1289 / 1291（V1/V2 瓦片骨架）、1346（V3 瓦片骨架）、1408（事件区骨架）四处
`<span class="loading-label" role="status">读取中</span>`；行 687 `#live` 为第五处。
运行时 21 组合实测：**loading 态 `[role=status]` 计数 = 5，其余 18 个组合 = 1**。
行 1435 `if (state === "loading") el.live.textContent = "正在读取三个 agent 的额度与事件"`，
实测 live 文本吻合。

#### B3 · stage 内的语义标题 —— ✅ **已落实**

行 681 `<h1 class="sr">`、行 684 `<h2 class="sr" id="feedTitle">`、
行 1271 / 1330 / 1340 / 1345 三块瓦片名 `<h2>`。行 442 用 `:where()` 重置，外观零变化。
**21 个组合 heading 数全部 = 5**，DOM 顺序 h1 → h2×3 → h2，无跳级。

#### B4 · 事件行 aria-label 拼入 kind —— ✅ **已落实**

行 1136 `KIND_LABEL`，行 1387 拼装。运行时实测：

```
Codex · 运行中 · 构造 v0.3 盲判任务分类样本 · 4m15s
Claude Code · 等待批准 · 批准写入 ~/.claude/settings.json · 刚刚 · 未读，按 Enter 标记已读
Codex · 失败 · 回复ok · 刚刚 · 未读，按 Enter 标记已读
ZCode · 已完成 · 合并四个文件并添加训练评估集标签列 · 1 分钟前 · 未读，按 Enter 标记已读
```

四种 kind 全覆盖，相对时间也拼进去了。

### 质量类

#### Q1 · `--id-codex` → `var(--charcoal)` —— ✅ **已落实**

tokens.css 行 96 / variations.html 行 223 `--id-codex: var(--charcoal)`。
运行时 Codex `.iddot` 实测 `rgb(211,211,212)`，对 `--surface` **12.99:1**（非文本 3:1 ✅），
与 `--accent` `rgb(244,244,246)` 不再同色。
连带效果实测：**loading / empty / error 三态 accent 计数 = 0**（R1-03 彻底解掉）。

#### Q2 · attention 态下时钟不消失 —— ✅ **已落实（天然成立）**

本版 `.topbar` 没有任何 `display:none` 规则（`grep` 无命中），行 682 时钟常驻。
**21 个组合 `[data-clock]` 全部可见且非空**（实测 `height>0` 且 `textContent="14:33"`）。

#### Q3 · V1/V2 的阈值判语 + 警示图标 —— ✅ **已落实**

行 1275–1280 `footIcon()` 按 `attention > 阈值 > running > 常态` 换图标；
行 1447–1454 `tickTiles()` 换文案。实测：

| 组合 | 三块瓦片 foot |
|---|---|
| v1/edge | `3m · 余量吃紧`(alert/danger) · `2h26m · 余量偏紧`(alert/warn) · `2h09m 后重置`(clock/ok) |
| v2/edge | 同上；ok+idle 档 foot 为空串并被 `:empty` 收掉 |
| v1/populated | `2h22m 后重置` ×2 —— ok 档保持沉默，不加填充文案 ✅ |

阈值不再只有颜色一个信号（图标形状 clock→alert + 文字「余量吃紧 / 偏紧」）。

#### Q4 · `.row:active` —— ✅ **已落实**

行 514–515：`.row:active{background:var(--surface-card);box-shadow:inset 0 0 0 1px var(--ash);
transition-duration:var(--dur-instant)}`，排在行 516 `.row:focus-visible` **之前**，
同特异性下键盘描边后置获胜。运行时 CSSOM 读取三条规则齐全：

```
.row:hover          → background: var(--surface-elevated);
.row:active         → background: var(--surface-card); box-shadow: inset 0 0 0 1px var(--ash); transition-duration: var(--dur-instant);
.row:focus-visible  → outline: none; box-shadow: inset 0 0 0 2px var(--accent);
```

#### Q5 · V3 attention 的事件流表头「1 项在上方等待」—— 🟡 **部分落实（视觉侧已无问题，AT 侧有回退）**

Q5 针对的是 960 版 V3 的 attention strip 接管后表头显示「全部已读」的误导。
3.5 寸版按新决策 4 砍掉了 strip，attention 事件回到事件区本身，**视觉上的误导消失了，这条的动机已被结构性解决** ✅。
但 `<h2 id="feedTitle">` 是**硬编码的「最近完成」，7 个状态从不改写**（行 684，`renderFeed()` 里无写入）。
实测 21 组合 sr-only h2 全部为「最近完成」。于是读屏用户在 attention / running / error 态下
听到的区段标题是「最近完成」，而区段内容是「等待你批准写入 ~/.claude/settings.json」。
Q5 的可见层解决了，无障碍层是新的失配。详见 R3-09。

#### Q6 · `.attn-tag` 字距 —— ✅ **已落实**

行 523 `letter-spacing:var(--tr-small)`（.01em）。`--tr-caps` 只留给真正 ALL CAPS 的
`.chip`（行 520–521，`text-transform:uppercase` + `.08em`）。运行时实测 `.chip` 全部 0.96px（= 12×.08），
`.attn-tag` 0.12px。CJK 不再被 caps tracking 拉开。

#### Q7 · attention 行边框 → `--ash` —— ✅ **已落实**

行 543 `.row[data-kind="attention"]{border-color:var(--ash)}`。
实测 `rgb(106,107,108)` 对 `--canvas` #07080a = **3.75:1** ✅（原 `--hairline-strong` 是 1.54:1）。

### 打磨类

#### P1 · 间距回栅格 —— 🟡 **部分落实**

结构间距确实回到了 token（`--pad-screen/--gap-tile/--gap-block` 全是 8，`--sp-sm` 12/16 等）。
但 3.5 寸重排引入了 **4 处未登记的 off-scale 值**，而 tokens.css §6 登记的 **5 条例外全部已失效**。
文件顶部自检行 116 写「全部落在 2/4/8/12/16 栅格；例外仅字形几何（--dot 5px、游标 2px）」——
这句与实现不符。详见 R3-06。

#### P2 · 跨阈值播报 —— ✅ **已落实**

行 1351–1360 `announceThresholds()`，只在 `prev !== lv && lv !== "ok"` 那一刻推一次。
实测 populated → edge 切换后 `#live` = **「Claude Code 5h 额度已达 82%，余量偏紧」**；
再切 loading 变成「正在读取三个 agent 的额度与事件」，不逐秒重复播报。

#### P3 · breathe 去掉 `filter:brightness` —— ✅ **已落实**

行 468–472：`.tile[data-status="attention"]::before, .row[data-kind="attention"]::before`
为 `position:absolute;inset:0;background:var(--ink);opacity:0;pointer-events:none`，
`@keyframes breathe{0%,100%{opacity:0}50%{opacity:.06}}`。
全文件 CSS 内**没有任何 `filter:` 声明**（`grep brightness` 只命中注释与 token 说明）。
实测 21 组合 `::before` 的 `animationName` = `breathe`，`animationDuration` = `3s`。
峰值 6% ink 叠层把 `#101111` 抬到约 `rgb(32,32,32)`，sRGB 数值口径 +5.4% ≤ 8% ✅。
纯 GPU 合成属性（opacity），不触发 paint ✅。

#### P4 · V3 主数字（960 版 18px → 3.5 版 16px）—— ✅ **沿用已接受的取舍**

行 275 `--fs-num-sm: 16px`，行 613–615 `.b-pc`。实测 V3 三档全部 16px。
`brief-m0-35.md` 的通用底线是「主数字 ≥44px」，V3 轴定义是「百分比退成 16px 次级」，
按 lead 在第一轮已接受的「更具体的那条优先」执行，一致。

### 小结

| 分类 | 已落实 | 部分 | 未落实 |
|---|---|---|---|
| B1–B4 | B2 B3 B4 | **B1** | — |
| Q1–Q7 | Q1 Q2 Q3 Q4 Q6 Q7 | **Q5** | — |
| P1–P4 | P2 P3 P4 | **P1** | — |
| **合计** | **12** | **3** | **0** |

---

## 2 · 新画布几何：21 组合运行时实测

| # | 指标 | 口径 | 结果 |
|---|---|---|---|
| 1 | 画布内所有元素不超出 480×270 | stage 内全部后代 `getBoundingClientRect()` 换算回画布坐标，±0.5px 容差，排除 `.sr` | **21/21 通过，越界元素 0** |
| 2 | 无任何文本计算字号 < 12px | `TreeWalker` 扫 stage 内全部非空文本节点的父元素 `fontSize` | **21/21 通过，min = 12px** |
| 3 | 最新事件标题 ≥16px、单行、省略号 | `.row.lead .rtitle` | **18px · `white-space:nowrap` · `overflow:hidden` · `text-overflow:ellipsis` · 实测行数 = 1**（21/21） |
| 4 | 主数字 ≥44px | `.num` / `.b-pc` | **V1 = 48px · V2 = 44px**（21/21）；**V3 = 16px**（轴定义豁免，P4 已接受） |
| 5 | 行高 ≥28px | `.row` 实测高度 | **lead 44px · 次行 32px · V3 lead 64px**，全部 ≥28 |
| 6 | zoom 2 后整体正好 960×540 | `#stage.getBoundingClientRect()` | **21/21 全部 `960 × 540`**（唯一值） |

补充实测（不在任务清单但顺手跑了）：

- **0 个 console error / 0 个 pageerror**（21 组合全程）。
- 「凡靠省略号收尾的元素必须真的 `overflow:hidden`」：**0 违例**。
- 内联 tokens 与 `design/tokens.css`：提取后**逐字节相同**（15742 B vs 15742 B，`IDENTICAL: True`）。
- 禁用项：`linear/radial/conic-gradient` 0 · `border-left` 0 · `#000000`/`#ffffff` 0 ·
  Tailwind 靛蓝（`indigo` / `4f46e5` / `6366f1`）0 · emoji 0 · `fetch(` 0 · 本地 css `<link>` 0。
  裸 `#fff` 仅出现在 harness 的 `.seg button[aria-pressed=true]`（行 416，不参与设计）与注释里。
- 截图 `design/shots/*.png` 六张实测 **1920×1080**（= 960×540 @2x），与面板一一对应 ✅。
- 结构容器纵向裁切：见 R3-15（两处 `scrollHeight > clientHeight` 是基线/字形几何造成的假阳性，
  另有一处 `.b-name` 是真的文本溢出，见 R3-05）。

---

## 3 · 对比度：脚本实算

方法：逐元素取 `getComputedStyle().color` / `backgroundColor` / `stroke`，
沿祖先链推导有效背景（含 alpha 逐层 `over()` 合成，底色兜底 `--canvas` #07080a），
再按 WCAG 相对亮度公式计算。下表为 21 组合去重后的全部唯一配对。

### 3.1 文本 × 底色 —— **全部通过，0 例外**

按比值升序，只列每个「色 × 底 × 字号」唯一组合：

| 比值 | 需要 | 元素 | 前景 | 底色 | 样例 |
|---|---|---|---|---|---|
| **6.23:1** | 4.5 | `.chip` 12px/500 | `--id-claude` #d97757 | `--surface` | `CLAUDE` |
| **6.42:1** | 4.5 | `.chip` 12px/500 | 同上 | `--canvas` | `CLAUDE` |
| **6.47:1** | 4.5 | `.chip` 12px/500 | `--id-zcode` #6f93e6 | `--surface` | `ZCODE` |
| **6.60:1** | 3 / 4.5 | `.num` 48px · `.unit` 14px · `.b-pc` 16px · `.b-verdict` 12px | `--danger` #ff6161 | `--surface` | `97` `%` `97%` `额度接口 401` |
| **6.83:1** | 4.5 | `.rtime` `.rsub` 12px | `--mute` | `--surface-card` | `刚刚` |
| **6.90:1** | 4.5 | `.unit` `.v1-sec` `.b-cd` | `--mute` | `--surface-elevated` | `7d 31%` |
| **7.09:1** | 4.5 | `.loading-label` `.b-note` `.msg p` `.tile-foot span` 等 12px | `--mute` | `--surface` | `读取中` `还没有智谱 API Key` |
| **7.30:1** | 4.5 | `.clock` `.rtime` 12px | `--mute` | `--canvas` | `14:33` |
| **11.90 / 12.23:1** | 4.5 | `.cd` `.rtitle`(已读) `.tile-foot span`(阈值) | `--body` #cdcdcd | elevated / surface | `2h26m` `回复ok` `3m · 余量吃紧` |
| **12.30:1** | 3 / 4.5 | `.num` 48px · `.b-pc` · `.b-verdict` | `--warn` #ffc533 | `--surface` | `82` `跑在时钟前 31 点 · 会提前用尽` |
| **12.99 / 13.39:1** | 4.5 | `.chip` 12px/500 | `--id-codex`(charcoal) | surface / canvas | `CODEX` |
| **17.05 / 17.22 / 17.69 / 18.24:1** | 3 / 4.5 | `.tile-name` `.b-name` `.attn-tag` `.rtitle`(未读/lead) `.num` | `--ink` | card / elevated / surface / canvas | 全部主文本 |

**判定**：所有 12–13px 有意义小字一律走 `--mute`（≥6.83:1），`--ash`（3.64:1）与 `--stone`（1.97:1）
**没有承载任何文本**——与 00-designer-notes §4.5 的自我约束一致，核实通过。
最低的一档是 `--id-claude` 的 12px 徽记 6.23:1，仍远高于 4.5:1。

呼吸叠层的影响也算过：peak 6% ink 把 attention 行底色从 `#121212` 抬到 `rgb(32,32,32)`，
`--mute` 在该底色上仍有 **5.9:1**，`--ink` 约 15:1，不越线。

### 3.2 非文本图形 × 底色（3:1 硬线）

| 比值 | 判定 | 对象 | 取色 | 底色 |
|---|---|---|---|---|
| 1.03:1 | ❌ | loading 骨架块（瓦片内） | `--surface-elevated` | `--surface` |
| 1.06:1 | ❌ | loading 骨架块（事件区） | `--surface-elevated` | `--canvas` |
| 1.33:1 | ❌ | `.tile` 卡片边框 | `--hairline` | `--canvas` |
| **1.71:1** | ❌ | **V2 进度弧 vs 轨道**（Claude） | `--id-claude` | `--ash` 轨 |
| **1.78:1** | ❌ | **V2 进度弧 vs 轨道**（ZCode） | `--id-zcode` | `--ash` 轨 |
| **1.81:1** | ❌ | **V1 bar / V2 arc / V3 band 的 danger 填充 vs 轨道** | `--danger` | `--ash` 轨 |
| 3.38:1 | ✅ | 三处 warn 填充 vs 轨道 | `--warn` | `--ash` 轨 |
| 3.54:1 | ✅ | 三处轨道 vs attention 瓦片底 | `--ash` | `--surface-elevated` |
| 3.57:1 | ✅ | V2 进度弧 vs 轨道（Codex） | `--charcoal` | `--ash` 轨 |
| **3.64:1** | ✅ | **V1 bar 轨 / V2 arc 轨 / V3 band 轨 vs 瓦片底** | `--ash` | `--surface` |
| 3.64:1 | ✅ | `.iddot[data-off]` 离线灰点 | `--ash` | `--surface` |
| 3.75:1 | ✅ | attention 行边框（Q7） | `--ash` | `--canvas` |
| **3.75:1** | ✅ | **V3 游标 vs ash 轨道** | `--canvas` | `--ash` |
| **4.86:1** | ✅ | **V1/V3 的 ink 填充 vs 轨道** | `--ink` | `--ash` 轨 |
| 5.79:1 | ✅ | `.rmark[data-aged]` 衰减未读点 | `--accent-dim` | `--surface` |
| 6.06–6.47:1 | ✅ | 身份点 / V2 进度弧 vs 瓦片底 | 三只身份色 | surface / elevated |
| 6.60–7.30:1 | ✅ | 全部 monoline 图标 | `--danger` / `--mute` | surface / card / canvas |
| 6.81 / 12.68 / 18.24:1 | ✅ | V3 游标 vs danger / warn / ink 填充 | `--canvas` | 对应填充 |
| 17.05–18.24:1 | ✅ | `.rmark` 未读点 / `.msg-head` 图标 | `--accent` / `--ink` | card / surface / canvas |

**作者声称的两处，逐条核实：**

| 作者原话 | 核实 |
|---|---|
| 「填充提到 `--ink` 保住 4.86:1」 | ✅ **在 ok 档精确成立（4.86:1）**；warn 档 3.38:1 也过线；**danger 档 1.81:1 不成立** → R3-01 |
| 「V3 刻度与游标翻成暗色」 | 刻度已随 `.b-axis` 一起被砍（本画布不存在）；**游标已翻暗色并实测达标**（3.75 / 6.81 / 12.68 / 18.24:1）✅ |

---

## 4 · 五态覆盖表（3 瓦片 + 事件区 × 7 态 × 3 变体）

✓ = 实测可切换且内容完整 · **粗体** = 本次逐字抄回的运行时文本

| 组件 | loading | empty | error | populated | edge | attention | running |
|---|---|---|---|---|---|---|---|
| **Codex 瓦片** | ✓ 骨架+`读取中` | ✓ 等待首轮采样 | ✓ 额度接口 401 | ✓ 22% | ✓ 97%(danger) | ✓ idle 22% | ✓ pulse 运行中 |
| **Claude 瓦片** | ✓ 骨架+`读取中` | ✓ statusline 未写入 | ✓ 接口限流 429 | ✓ 18% | ✓ 82%(warn) | ✓ breathe+等待你批准 | ✓ pulse 运行中 |
| **ZCode 瓦片** | ✓ 骨架+`读取中` | ✓ 未连接 | ✓ 网络不可达 | ✓ 未连接 | ✓ 已连接 3% | ✓ 未连接 | ✓ 未连接 |
| **事件区** | ✓ 骨架+`读取中` | ✓ 今天还没有完成的任务 | ✓ 事件采集中断 | ✓ 1 放大未读 + 1 次行 | ✓ 2 条（V3 1 条） | ✓ attention 行 | ✓ 正在运行行 |

**21/21 组合全部可由控制栏切到，内容非空，无 JS 报错。**

### 4.1 砍掉内容后，每个状态是否仍说了「原因 + 下一步」

| 位置 | error（压成一句） | empty | 判定 |
|---|---|---|---|
| Codex | **额度接口 401 / 登录令牌过期，跑 codex login 重新授权** | **等待首轮采样 / 约 60 秒后自动出现** | ✅ 原因 + 下一步齐 |
| Claude | **接口限流 429 / 已退避重试，期间读 statusline 缓存** | **statusline 未写入 / 跑一次 claude 会话即可补上** | ✅ |
| ZCode | **网络不可达 / 恢复联网后自动重连，不用操作** | **未连接 / 还没有智谱 API Key** | ✅ error 齐；**empty 只剩原因，下一步按简报移到托盘菜单** —— 符合 `brief-m0-35.md` 的明确指示 |
| 事件区 | **事件采集中断 / 30 秒后自动重新挂载，期间事件会补齐** | **今天还没有完成的任务 / 有任务跑完会自动排到这里** | ✅ |

**三条 error 文案各不相同**（401 / 429 / 离线），**每条都是一句话含原因与下一步**，
符合 `brief-m0-35.md`「error：一行 12px，原因 + 下一步压成一句」。✅

### 4.2 edge 四种边界

| 边界 | 结果 |
|---|---|
| 64 字标题 | `.rtitle` 单行 `text-overflow:ellipsis`（U+2026 单字符），实测 `scrollWidth 763 > clientWidth 289` 正常截断 ✅ |
| 超长 cwd | **本画布已不适用**——cwd 被内容预算砍掉（仅 V3 lead 行的 `.rsub` 在无 summary 时回落到 cwd）。作者已在笔记与文件头注明 ✅ |
| 一分钟 8 条 | `ROW_BUDGET = {v1:2, v2:2, v3:1}`（行 1243），实测只渲染 2 / 2 / 1 条，不溢出 ✅（但 6 条未读在屏上无任何痕迹，见 R3-16） |
| 97% 额度 | `.num` 转 `--danger`，foot 变 `3m · 余量吃紧` + alert 图标，倒计时逐秒递减 ✅ |

### 4.3 不靠颜色单独传状态

| 状态 | 颜色信号 | 非颜色信号 | 判定 |
|---|---|---|---|
| running | iddot 身份色 | 2s pulse + foot「运行中 · 2h22m」+ 事件区置顶「正在运行」行 + aria-label「运行中」 | ✅ |
| attention | iddot 转 accent + 光晕 + breathe | foot「等待你批准」+ 行首「↵ 等待你」+ ash 边框 + 底色升 card + aria-label「等待批准」 | ✅ |
| 未读 | `.rmark` accent 点 | 底色升 `--surface` + 标题转 ink + `font-weight` 400→500 + aria-label「未读，按 Enter 标记已读」 | ✅ |
| 额度阈值 V1/V2 | 数字/bar 转 warn/danger | **图标 clock→alert + 文字「余量偏紧 / 吃紧」**（Q3 已补） | ✅ |
| 额度阈值 V3 | 同上 | `.b-verdict`「跑在时钟前 31 点 · 会提前用尽」 | ✅ |

---

## 5 · 键盘 / focus / `:active` / reduced-motion / aria-live / heading / role=status

| 项 | 实测 | 判定 |
|---|---|---|
| **Tab 顺序** | 控制栏按钮 → stage 内事件行按 DOM 顺序（lead 在前）→ 回到文档。瓦片不进 tab 环（`<section>` 无 tabindex） | ✅ |
| **事件行语义** | `<button type="button">`，非 div | ✅ |
| **Enter ack** | unread 1 → 0，`#live` = 「已全部读完」，焦点仍在原行（`activeElement.className = "row lead"`） | ✅ |
| **Space ack** | 同上（`<button>` 原生行为，无需额外 keydown） | ✅ |
| **focus 可见** | `box-shadow: rgb(244,244,246) 0px 0px 0px 2px inset`，`outline:none`。对 `--surface-card` **17.05:1** | ✅ 非浏览器默认蓝 |
| **focus 不被裁切** | 聚焦行在画布坐标 `8,177 → 472,221`，完全在 480×270 内；inset 描边天然不会越界 | ✅ |
| **`:active`** | 规则存在（行 514），`--dur-instant` 120ms，且位于 `:focus-visible` 之前 | ✅ |
| **hover** | `.row:hover{background:var(--surface-elevated)}` | ✅ |
| **disabled** | 无禁用态元素，N/A | — |
| **transition 150–300ms** | `.row` / `.tile` 用 `--dur-state` 180ms；bar/arc 用 `--dur-bar` 300ms；新事件 `--dur-event` 360ms（≤400 上限） | ✅ |
| **reduced-motion · 控制栏开关** | `.iddot` `animationName` pulse → **none**；`.tile::before` / `.row::before` breathe → **none**；`.row` `transitionDuration` → **0s** | ✅ |
| **reduced-motion · 媒体查询** | 独立 page `emulateMedia({reducedMotion:'reduce'})`，`.iddot` `animationName` = **none** | ✅ 两条通道任一生效即全停 |
| **动效只服务状态变化** | 全文件仅 `pulse`(2s) / `breathe`(3s) / `enter`(360ms) 三个 keyframes，无 shimmer、无循环装饰动画 | ✅ |
| **GPU 合成** | breathe = opacity 叠层（P3）；pulse = opacity；enter = `transform:translateY` + opacity；FLIP 用 `transform`。**无 layout 属性动画，无 `filter:`** | ✅ |
| **aria-live** | 行 687 `<p class="sr" role="status" aria-live="polite" id="live">`，先于内容存在。实测播报四类：新事件 / ack 结果 / loading / 跨阈值 | ✅ |
| **heading** | 21 组合均为 5，层级 h1→h2 无跳级 | ✅ |
| **`role="status"`** | loading 态 5 个，其余状态 1 个（`#live`） | ✅ |
| **SVG 图标** | 全部 `aria-hidden="true"` + `currentColor` + 1.6px stroke，且都有文字替代（chip / foot 文案 / aria-label） | ✅ |
| **`role="img"`** | `.bar` / `.gauge` / `.band` 均带 `aria-label="5h 窗已用 X%"` | ✅ |
| **landmark** | 三块瓦片 `<section aria-label="Codex 额度">` | ✅ |
| **控制栏** | `role="group"` + `aria-label` + `aria-pressed` 同步 | ✅（harness，不计入设计） |

---

## 6 · 本轮发现

### R3-01 · P0 · 置信 0.80
**位置**：V1 `.bar[data-level="danger"]>i`（行 490）· V2 `.tile[data-level="danger"] .gauge .prog`（行 593）·
V3 `.tile[data-level="danger"] .band .used`（行 626）· state=edge（Codex 97%）
**现象**：danger 档的额度填充 `--danger` #ff6161 叠在 B1 提亮后的 `--ash` #6a6b6c 轨道上，
脚本实测 **1.81:1**，远低于 WCAG 1.4.11 对承载信息的非文本组件的 3:1。
填充与轨道的边界正是「用了多少」这条信息本身。
**依据**：脚本实算，三个变体同一数值（`rgb(255,97,97)` on `rgb(106,107,108)` = 1.81:1）。
对照：ok 档 `--ink` on ash = 4.86:1 ✅，warn 档 `--warn` on ash = 3.38:1 ✅。
**这是 B1 引入的回归**——提亮之前轨道是 `--hairline` #242728，danger 填充与它约 5.1:1。
00-designer-notes 的「填充与轨道之间恢复到 4.86:1」只覆盖了 ok 档。
**缓解**：同屏还有 48px 红色「97」和 foot「3m · 余量吃紧」，信息不会丢失——
若 lead 认为 bar 在 danger 档只是冗余装饰，可降级为 P1。
**建议**：不要再去调填充色（红黄是阈值语义，动不得），改用**形状缺口**机制：
给三种填充的右端统一加一道 2px `--canvas` 的分隔（与 V3 游标同一机制，实测 6.81–18.24:1），
边界就不再依赖填充色与轨道色的色差。一处改动同时解掉 R3-02。

### R3-02 · P1 · 置信 0.85
**位置**：V2 `.gauge .prog`（行 590）× `.gauge .track`（行 589）· 所有含数据状态
**现象**：身份色进度弧叠在 ash 轨道上实测 **Claude 1.71:1 / ZCode 1.78:1**（Codex 因 Q1 改成 charcoal 后是 3.57:1 ✅）。
作者用「进度弧比轨道宽 1px」的形状差来补色差（`--arc-stroke:5px` vs `--arc-track:4px`，行 326–327）。
**这个补偿在 3.5 寸上低于视觉分辨阈**：1px 的总差 = 每侧 0.5 画布 px = **0.08 mm**
（1 画布 px = 4×4 物理像素 = 0.16 mm @ 629 ppi），在 50–60 cm 处张角约 **0.5 弧分**，
低于约 1 弧分的人眼分辨极限。960 版用的是 2px（每侧 1px），3.5 寸版把它砍半了。
**依据**：tokens.css §12 几何值；`brief-m0-35.md` 的观看距离与像素尺寸；实测对比度。
**建议**：把 `--arc-stroke` 提到 8px（每侧 2px = 0.32 mm ≈ 2 弧分），或改用 R3-01 的缺口机制——
在进度弧末端留一道 2px `--canvas` 的 `stroke-dasharray` 缺口。

### R3-03 · P1 · 置信 0.85
**位置**：V1 `.bar>i`（行 487）· V3 `.band .used`（行 623）· token `--quota-fill: var(--ink)`（tokens.css 行 106）
· state=populated / attention / running
**现象**：B1 把填充提到 `--ink` #f4f4f6，而 `--accent` 也是 #f4f4f6——
**额度填充现在和「未读 / 需要你」是同一个 hex，且面积大一个数量级**。
运行时按「计算背景色 == `rgb(244,244,246)` 且可见」扫描：

| 组合 | 实测 accent 元素 | 作者声称 |
|---|---|---|
| v1/populated | **3**（2× `.bar>i` + `.rmark`） | 1 |
| v1/attention | **4**（2× `.bar>i` + `.iddot` + `.rmark`） | 2 |
| v3/populated | **3**（2× `.band .used` + `.rmark`） | 1 |
| v3/attention | **4**（2× `.band .used` + `.iddot` + `.rmark`） | 2 |
| v3/running | **2**（2× `.band .used`） | 0 |
| v2/*（无带填充图形） | 1 / 2 / 0，与声称一致 ✅ | — |

作者的断言是**选择器白名单式**的（只数 `.iddot` / `.rmark` / strip），扫不到无 class 的 `<i>` 与 `.used`。
截图 `v3-populated` 上最亮、最大的一块白正是 Codex 与 Claude 的时间带填充，
而真正的未读点只有 5px——**层级被倒置了**：accent 的稀缺性是它起作用的唯一原因。
这也正中 anti-slop 清单的「身份/强调色越界成大面积填充」。
**依据**：Playwright 逐元素 `getComputedStyle().backgroundColor` 扫描 + 截图目视；
tokens.css §5「capped at 2 visible uses per screen」；`brief-m0.md` 已定项 #7。
**建议**：`--quota-fill` 从 `--ink` 降到 `--charcoal` #d3d3d4——
实测 charcoal 对 ash 轨道 **3.57:1**，仍过 3:1 线，同时与 accent 白拉开半档。
这与 Q1 对 `--id-codex` 的处理是同一个手法，保持系统内部自洽。

### R3-04 · P1 · 置信 0.90
**位置**：V2 `[data-variant="v2"] .tile-foot:empty{display:none}`（行 585）· state=populated / edge / attention / running
**现象**：V2 在 `ok + idle` 时整条 foot 收掉，导致**同一屏内三块瓦片的仪表弧与 44px 数字不在同一条基线上**。
实测 `v2/edge`：Codex / Claude 的 `.tile-body` 高 67px（foot 存在），ZCode 的高 91px（foot 被收掉）；
换算成弧的顶边 = 38.5px vs 50.5px，**相差 12 画布 px = 24 逻辑 px = 48 物理像素**。
截图 `v2-edge.png` 上肉眼可见 ZCode 的仪表明显偏下。
**依据**：Playwright 逐瓦片测量；`hierarchy-rhythm-review` 的「三块瓦片必须作为同一对象复现（同边、同基线、同内边距）」；
`01-slop-hierarchy.md` 曾对 960 版把这条判为通过，3.5 寸版的新决策 3 打破了它。
**建议**：不要用 `:empty{display:none}`，改成 `.tile-foot:empty{visibility:hidden}` 或保留一个
`height:16px` 的空占位——把「ok 级保持沉默」做成**内容沉默而不是盒子消失**，基线就守住了。

### R3-05 · P1 · 置信 0.85
**位置**：V3 `[data-variant="v3"] .b-name{width:84px;flex:none;white-space:nowrap}`（行 607–608）· 所有 V3 状态
**现象**：`.b-name` 是固定 84px 且 `overflow:visible` / `text-overflow:clip`。
「Claude Code」实测需要 **89px**，溢出 5px，吃掉与 `.b-verdict` 之间 8px 间隙的一大半。
结果是 V3 三条时间带的第二列（判语）有**三个不同的左边缘**：
Codex 后留白很宽、Claude Code 几乎贴死、ZCode 又是第三个位置。
截图 `v3-populated.png` / `v3-attention.png` 上非常明显（「Claude Code落后时钟 33 点」几乎连排）。
**依据**：运行时 `scrollWidth 89 > clientWidth 84`；截图目视；
「同一对象复现」与「共享左边缘」的栅格要求。
**建议**：`.b-name` 改成 `min-width:84px;flex:none` 让它按内容撑开并统一到最长名，
或把 84px 提到 92px 并补 `overflow:hidden;text-overflow:ellipsis` 作为保险。
后者更符合「固定列宽 = 可预测的扫视路径」。

### R3-06 · P1 · 置信 0.95
**位置**：`tokens.css` §6 off-scale 例外清单（行 72–80，HTML 行 199–207）× 实际 CSS
**现象**：清单与实现**双向失配**——登记的例外全部失效，实际的例外全部没登记。

登记了但已不存在 / 值不对（5/5 全错）：

| 清单写的 | 实际 |
|---|---|
| `V3 .tile { gap: 2px }` | 行 605 是 `gap:var(--sp-xs)` = **4px** |
| `--dot: 6px` | 行 329 是 **5px** |
| `.chip::before 5px` | **该规则不存在**（`grep` 仅命中此注释本身） |
| `V3 .band .caret 3px` | 行 628 是 **2px** |
| `V3 .row::after 11px/3px ring` | **该规则不存在**（时间轴节点已随 `.b-axis` 一起被砍） |

实际存在但未登记（4 处，运行时扫描全部 gap/padding 得出）：

| 值 | 位置 |
|---|---|
| `padding:10px` | 行 454 `.tile`（三个变体的瓦片内边距） |
| `padding:4px 10px` | 行 605 `[data-variant="v3"] .tile` |
| `gap:3px` | 行 522 `.attn-tag` |
| `row-gap:3px` | 行 631 `[data-variant="v3"] .row.lead` |
| `gap:6px` | 行 1288 V2 loading 骨架的内联样式 |

而文件头自检行 116 写的是「全部落在 2/4/8/12/16 栅格；例外仅字形几何（--dot 5px、游标 2px）」。
**这类「声明与实现不符」正是上一轮 B2 被判为阻断的同一种问题**，只是这次落在注释里而非功能上。
**依据**：Playwright 全量 `getComputedStyle` 扫 `rowGap/columnGap/padding*/margin*` 比对 {2,4,8,12,16,24,32}。
**建议**：`.tile` 的 10px 收到 8px 或 12px（137px 高度预算够，实测瓦片内还有余量）；
`.attn-tag` 与 V3 lead 的 3px 收到 4px 或 2px；V2 骨架的 6px 收到 4px 或 8px；
然后把 §6 清单重写成当前实际的例外集合，并同步修正文件头自检那一行。

### R3-07 · P1 · 置信 0.75
**位置**：`.skel i` / `.feed-skel i`（行 501、552）· state=loading · 三个变体
**现象**：loading 骨架块用 `--surface-elevated` #101111，在瓦片底 `--surface` 上实测 **1.03:1**，
在事件区的 `--canvas` 上 **1.06:1**——**基本看不见**。
截图 `v1-loading.png` 上骨架几乎与背景融为一体，整屏读起来更像「空」而不是「正在读」，
唯一能读出「正在读」的是那四个 12px 的「读取中」。
**依据**：脚本实算；截图目视；`state-coverage` 要求 loading 与 empty 在视觉上可区分。
（顺带：`role="status"` 那条 B2 已经把**无障碍侧**补齐了，这里说的是**视觉侧**。）
**建议**：骨架块提到 `--stone` #434345（对 surface 1.97:1，对 canvas 2.03:1），
或直接用 `--ash` 的 15% 透明叠层。骨架是「形状承载信息」的典型，
虽然 WCAG 对纯装饰骨架不强制 3:1，但 1.03:1 等于这个元素没有存在。

### R3-08 · P2 · 置信 0.80
**位置**：V2 `.gauge-center .cd`（行 595–596）+ `.tile-foot`（行 1320–1322）· state=edge / running / attention
**现象**：V2 在 warn/danger 档**同一块瓦片里把倒计时印了两遍**：
弧心「3m」+ foot「3m · 余量吃紧」。实测 `v2/edge` Codex 瓦片文本串为 `2m 97% 2m · 余量吃紧`。
3.5 寸的内容预算是「多一个元素就要有理由」，重复是最贵的那种冗余。
**建议**：warn/danger 档把弧心的 `.cd` 让位——要么弧心改显百分比（与 foot 的倒计时互补），
要么 foot 只留判语「余量吃紧」去掉重复的倒计时。

### R3-09 · P2 · 置信 0.85
**位置**：`<h2 class="sr" id="feedTitle">最近完成</h2>`（行 684）· state=attention / running / error / empty
**现象**：事件区的 sr-only 标题**硬编码为「最近完成」，7 个状态从不改写**（`renderFeed()` 无写入逻辑）。
实测 21 组合全部为「最近完成」。读屏用户在 attention 态下听到的是
「标题二 最近完成」→「按钮 Claude Code · 等待批准 · 批准写入 …」，标题与内容矛盾。
running 态同理（内容是「正在运行」），error 态是「事件采集中断」。
这是 Q5 在无障碍层的残留：可见层的误导被结构性解决了，AT 层没跟上。
**建议**：在 `renderFeed()` 里按 `scene.feed` 改写 `feedTitle.textContent`，
例如 attention → 「需要你」、running → 「进行中」、error/empty → 「事件」。三行代码。

### R3-10 · P2 · 置信 0.70
**位置**：V2 `.gauge-center .cd`（行 1315）· state=populated（ok + idle）
**现象**：V2 在 ok 档 foot 被收掉后，弧心只剩一个裸的「2h22m」，**屏上没有任何文字说明它是什么**。
实测 `v2/populated` Codex 瓦片全部文本 = `Codex 2h22m 22%`。
V1 在同一场景是「2h22m 后重置」，V3 是「2h22m」但旁边有判语兜底。
`role="img" aria-label` 只描述了百分比（「5h 窗已用 22%」），倒计时对 AT 也是不可解释的裸串。
**依据**：五态内容实测抄录；`laws-of-ux` 的可辨识性 > 可回忆性。
**建议**：弧心下方加一个 12px 的「后重置」，或把倒计时整体移出弧心、弧心改放百分比。

### R3-11 · P2 · 置信 0.90
**位置**：`.tile-foot`（行 567–570）
**现象**：`white-space:nowrap;overflow:hidden` 但**没有 `text-overflow:ellipsis`**，
超长时是硬切而不是省略号。当前 fixtures 下最长的一条是「2h26m · 余量偏紧」
（约 117px，瓦片内宽 129px），**余量只有 12px**。真实数据里出现
「10h05m · 余量偏紧」或更长的 agent 名变体时会被无声截断。
**建议**：补 `text-overflow:ellipsis`。这也是作者自己新增的断言
「凡靠省略号收尾的元素必须真的 `overflow:hidden`」的反向——这里是 hidden 了但没给省略号。

### R3-12 · P2 · 置信 0.90
**位置**：`tokens.css` FINDINGS › INCONSISTENCIES（行 195–197）
**现象**：注释仍写「this project only uses ink / body / mute; **charcoal is dead weight**」，
但 Q1 已经把 `--id-codex` 指向了 `var(--charcoal)`（行 96），charcoal 现在是三个身份色之一。
R1-08 当初正是靠这条注释成立的，修完之后注释没跟着改。
**建议**：把该句改成「charcoal carries the Codex identity since REVISION 1」。

### R3-13 · P2 · 置信 0.70
**位置**：`.tile`（行 453）· 全局
**现象**：瓦片边框 `--hairline` #242728 在 `--canvas` #07080a 上实测 **1.33:1**。
瓦片与画布的分界同时靠 surface 阶梯（#0d0d0d vs #07080a，本身也只有约 1.1:1）与这条边框，
两者叠加仍然很弱。截图上瓦片边界勉强可辨。
这是 DESIGN.md（raycast）的原样，属于已拍板的视觉真源，**不建议擅改**，
但在 0.16 mm/px 的 3.5 寸面板上值得实机复核一次——它决定了「三块」这个分组是否读得出来。
**建议**：M1 实机时若分组读不出，把瓦片边框提到 `--hairline-strong`（rgba .16，约 1.54:1）
或把瓦片底提到 `--surface-elevated`。记为实机待验项，不在本轮修。

### R3-14 · P2 · 置信 0.85
**位置**：`design/` 目录 · 验证脚本
**现象**：作者在笔记里引用的 `verify.mjs`（21 组合 + 新增四条断言）**不在仓库里**
（`find design -name "*.mjs"` 无命中），且 `git log` 显示本仓库**还没有任何 commit**
（`fatal: your current branch 'main' does not have any commits yet`）。
`brief-m0-35.md` 写的「旧版由 git 历史保留，先 git add 一次再改」没有兑现——
960 版靠 `design/variations-960x540.html` 这个副本留存，不是靠历史。
后果是：本轮我复现的所有断言都得重写一遍，下一轮还得再写一遍；
而且作者声称的 21/21 无法被独立重跑核对。
**建议**：把验证脚本落盘到 `design/verify.mjs` 并首次 commit。
（本轮我的脚本在会话 scratchpad 里，按只读 lane 约定不落到 `design/`。）

### R3-15 · P2 · 置信 0.60
**位置**：`.tile-body`（V2，行 583）· `.b-head`（V3，行 606）
**现象**：作者的断言集合里包含 `.b-head`，但实测 `.b-head` 在 V3 的
populated / edge / attention / running 下 **`scrollHeight 19 > clientHeight 16`**；
V2 的 `.tile-body` 在 foot 可见时 **`scrollHeight 76 > clientHeight 67`**。
逐子元素测量后确认：**两者都不是真的裁切**——
`.b-head` 是 `.b-pc`（IBM Plex Mono 16px / `line-height:1`）的字形上下超出行盒约 1.5px；
`.tile-body` 是 `.v2-num` 内部 44px 数字与 14px `%` 做 baseline 对齐时的行盒外溢。
两者的 `overflow` 都是 `visible`，且所有子元素的 bounding box 都落在父盒之内
（实测 spill 全为负值），画布越界检查也是 0。
所以这是**断言口径问题而非缺陷**：作者声称「结构容器无纵向裁切」在 `.b-head` 上按字面读是不成立的。
**建议**：把该断言改成「子元素 bounding box 不越父盒」，或对字形溢出加 ±2px 容差并写明理由。

### R3-16 · P2 · 置信 0.60
**位置**：`ROW_BUDGET`（行 1243）+ 未读衰减规则（行 1419–1425）· state=edge
**现象**：edge 场景有 8 条全未读事件，V1/V2 只渲染 2 条、V3 只渲染 1 条，
且第二条按 accent 衰减规则降成 `--accent-dim` 点 + `--body` 400 字重（看起来像已读）。
**屏上没有任何痕迹表明还有 6 条未读**——计数与「另 N 条更早」都按简报砍掉了。
这是 `brief-m0-35.md` 的明确指示（「未读只靠最新行本身的强调表达」），**不算违规**，
但在「一分钟内来了 8 条」这个恰恰最需要知道积压量的场景里，代价是实打实的。
**建议**：不改也行；若 lead 想留一个出口，最省地方的做法是把未读总数并进
右上角时钟那一行（`14:33 · 8`），一个字符的成本。留给 M1 实机判断。

---

## 7 · 已拍板决策符合性清单（`brief-m0-35.md` 差量项 + `brief-m0.md` 沿用项）

| # | 已定项 | 状态 | 证据 |
|---|---|---|---|
| 1 | 设计画布 480×270 CSS px，固定不滚动 | ✅ | `--screen-w/h`，stage `overflow:hidden`，无滚动容器 |
| 2 | 整体 `zoom:2` 铺满 960×540 | ✅ | 21 组合实测 stage = 960×540 |
| 3 | 任何文本 ≥12px | ✅ | 21 组合 min = 12px |
| 4 | 标签 12–13px | ✅ | `.tile-name` / `.b-name` / `.msg-head` = 13px |
| 5 | 最新事件标题 ≥16px 单行省略号 | ✅ | 18px · nowrap · ellipsis · 1 行 |
| 6 | 主数字 ≥44px | ✅ V1 48 / V2 44 · 🟡 V3 16 | V3 按轴定义豁免（P4 已接受） |
| 7 | 行高 ≥28px | ✅ | 44 / 32 / V3 64 |
| 8 | 数字 IBM Plex Mono tabular | ✅ | `font-variant-numeric:tabular-nums` + `"tnum" 1,"zero" 1` |
| 9 | 标签 Inter + ss03 | ✅ | `--font-features` 含 `"ss03" 1` |
| 10 | 三块瓦片各约 148px 宽 | ✅ | `(480−16−16)/3 = 149.33` |
| 11 | 瓦片保留 名 + 状态点 + % + 倒计时 | ✅ | 状态词按新决策 1 下沉到 foot，仍有文字信号 |
| 12 | 7d 降级（V1 12px 次级数字 / V2 不显示） | ✅ | `.v1-sec` 12px；V2 `tileV2()` 只取 `windows[0]` |
| 13 | ZCode 未连接只留「未连接」+ 一行原因 | ✅ | `ZCODE_OFF`（行 1175），「怎么接」已移除 |
| 14 | error 原因 + 下一步压成一句 | ✅ | 三条文案实测各不相同且各含下一步 |
| 15 | 事件区 1 条放大 + 最多 1 行次新 | ✅ | `ROW_BUDGET {v1:2,v2:2,v3:1}` |
| 16 | 去掉「另 N 条更早」与未读计数 | ✅ | `grep` 无命中 |
| 17 | 事件行 cwd 砍掉 | ✅ | 仅 V3 lead 的 `.rsub` 在无 summary 时回落 cwd（作者决策 8 沿用） |
| 18 | attention 不另起 strip，最新行自己变 attention 行 | ✅ | 行 542–545，无 `.attn-strip` |
| 19 | 时钟 12px 右上角 | ✅ | 行 682 + `.topbar{justify-content:flex-end}` |
| 20 | 品牌字「AGENT MONITOR」删除 | ✅ | 仅保留 sr-only h1（新决策 5） |
| 21 | V2 仪表弧 56–64px | ✅ | `--gauge:60px` |
| 22 | V3 三条时间带竖向堆叠，带高 8–10px | ✅ | `--h-band:48px`（简报写「约 44px」）· band 10px |
| 23 | V3 判语保留并压到 12px | ✅ | `.b-verdict` 12px |
| 24 | 三变体两两差别能一句话说清 | ✅ | CAPTIONS 三条 + 「读数字 → 读形状 → 读够不够撑到重置」 |
| 25 | 三变体都完整支持 7 种状态 | ✅ | 21/21 |
| 26 | accent ≤2 | ❌ | **V1/V3 实测 3–4**（R3-03）；V2 合规 |
| 27 | 轨道 ≥3:1 | ✅ | 三处轨道 3.54–3.64:1 |
| 28 | 填充与轨道边界 | 🟡 | ok 4.86 ✅ / warn 3.38 ✅ / **danger 1.81 ❌**（R3-01） |
| 29 | focus 非浏览器默认蓝 | ✅ | 2px `--ink` inset，17.05:1 |
| 30 | prefers-reduced-motion 全停 | ✅ | 媒体查询 + `data-rm` 双通道实测 |
| 31 | 无 emoji / gradient / 靛蓝 / #000·#fff 大面积 / 左侧色条 / 投影 | ✅ | 全部 `grep` 0 命中 |
| 32 | 不加滚动、不加翻页 | ✅ | 无 `overflow:auto/scroll`，无分页 |
| 33 | 不为塞内容把文本压到 12px 以下 | ✅ | min = 12px |
| 34 | 内联 tokens 与 tokens.css 逐字相同 | ✅ | 15742 B 字节级相同 |
| 35 | 截图 960×540 @2x 覆盖 `design/shots/` | ✅ | 六张 1920×1080 |
| 36 | 旧版由 git 历史保留 | ❌ | 仓库无任何 commit；靠副本文件留存（R3-14） |
| 37 | 上一轮 B/Q/P 修复不许回退 | 🟡 | 12 全带过来，B1 / Q5 / P1 有尾巴（§1） |

---

## 8 · 汇总与结论

| 严重度 | 条数 | 编号 |
|---|---|---|
| **P0** | **1** | R3-01 |
| **P1** | **6** | R3-02 · R3-03 · R3-04 · R3-05 · R3-06 · R3-07 |
| **P2** | **9** | R3-08 ~ R3-16 |

### 结论：**修完 4 条后可发布**

必修（发布前）：

| 编号 | 一句话 | 修法 | 工作量 |
|---|---|---|---|
| **R3-01 · P0** | danger 填充 vs ash 轨道 1.81:1 | 填充右端加 2px `--canvas` 缺口（复用 V3 游标机制），一次改动同时解 R3-02 | 小 |
| **R3-03 · P1** | 额度填充 = accent 同 hex，V1/V3 accent 实测 3–4 | `--quota-fill` 从 `--ink` 降到 `--charcoal`（对 ash 3.57:1，仍过线） | 一行 |
| **R3-04 · P1** | V2 `:empty` 收 foot 导致三块瓦片不共基线 | `display:none` → `visibility:hidden` 或保留 16px 空占位 | 一行 |
| **R3-06 · P1** | 4 处未登记 off-grid + §6 例外清单 5 条全失效 + 文件头自检那一行不实 | 收 5 个值 + 重写清单与自检行 | 小 |

**R3-02（V2 弧的形状补偿低于分辨阈）如果不采用 R3-01 的缺口方案，需要单独把 `--arc-stroke` 提到 8px**；
若采用缺口方案则自动解决，故未单列进必修。

可以进 M1 的（不阻断发布）：
R3-02（若已随 R3-01 解决）· R3-05（V3 `.b-name` 84px 溢出，视觉瑕疵但不丢信息）·
R3-07（loading 骨架 1.03:1，有「读取中」文字兜底）· 以及全部 9 条 P2。

其中 **R3-09（sr-only h2 恒为「最近完成」）与 R3-11（`.tile-foot` 缺省略号）各只要三行以内**，
建议顺手一起修掉——它们是纯增量，不会引入回归。

### 值得写进下一轮 brief 的一条方法论

本轮三条 P0/P1（R3-01 / R3-02 / R3-03）**全部源自同一个修复 B1**。
B1 本身是对的（轨道确实该 ≥3:1），但「把轨道提亮」这个动作会同时改变
**轨道 vs 底色**、**填充 vs 轨道**、**填充 vs accent 语义**三对关系，
而返工时只验证了第一对、只在 ok 档验证了第二对、完全没验第三对。
建议在 `verify.mjs` 里把断言从「某个元素的颜色对不对」改成
**「每一对相邻色的关系矩阵」**——三个变体 × 三个阈值档 × {轨道/填充/底色/accent} 的全配对，
并把 accent 计数从选择器白名单改成**按计算颜色全量扫描**（本轮我用的就是后者，
正是它扫出了作者白名单看不见的 `.bar>i` 与 `.band .used`）。
