# R1 · 反 slop + 层级节奏 · 评审报告

> 评审对象：`design/variations.html` + `design/tokens.css`
> 评审依据：`brief-m0.md`（已定项）、`DESIGN.md`（raycast）、`anti-ai-slop.md`、`typography.md`、`hierarchy-rhythm-review.md`
> 运行时验证：Playwright 1.63.0 / Chromium / 1100x820 viewport / deviceScaleFactor:2 / 3 variants x 7 states = 21 combos
> 模式：THOROUGH（未触发 ADVERSARIAL 升级条件）
> 落盘说明：reviewer agent 为只读 lane，本文件由 lead 按其回执原文落盘，未改动内容。

---

## 总览

tokens.css 的提取质量很高——每个 hex 都溯源到 DESIGN.md，项目层追加的 6 个 section（身份色、阈值、type scale、动效、几何）分组清晰、命名按用途。variations.html 的 1738 行单文件原型完成度远超 M0 通常水准：7 态 x 3 变体全部可由控制栏切到，21 个组合运行时零溢出零裁切，anti-slop 清单的 7 条 P0 全部干净。以下是逐条发现。

---

## 发现

### R1-01 · P1 · 置信 0.85
位置：所有变体 · state=attention · Codex 瓦片 `.iddot`
现象：运行时 accent 计数在 attention 态达到 3（Codex iddot + Claude iddot + attention 行 rmark），超过 ≤2 上限。Codex 身份色 `--id-codex: #f4f4f6` 与 `--accent: #f4f4f6` 是同一个 hex，计算背景色均为 `rgb(244,244,246)`。
依据：Playwright 逐元素读取 `getComputedStyle().backgroundColor`，三个变体的 attention 态均返回 3 个 `rgb(244, 244, 246)` 可见元素。brief-m0.md 定义 `accent ≤2`；设计者声称 attention=2，因为把 Codex iddot 按概念（身份≠accent）排除了，但视觉结果是同一视口内三个相同亮度的白色圆点。
建议：将 `--id-codex` 降至 `--body`（#cdcdcd，12.23:1）或 `--charcoal`（#d3d3d4，12.99:1），使其在视觉上与 accent 白拉开半档。需要修改 brief-m0.md 的已定项，由用户拍板。

### R1-02 · P1 · 置信 0.90
位置：V2 · 所有含数据状态 · `.gauge .track`
现象：仪表轨道 stroke 使用 `--hairline`（#242728），叠在 `.tile` 背景 `--surface`（#0d0d0d）上实测 1.29:1，远低于 WCAG 1.4.11 对非文本图形组件的 3:1 下限。弧的「总长度」需要用户脑补。
依据：WCAG 2.1 SC 1.4.11 Non-text Contrast。设计者在 00-designer-notes.md §6.3 已标注此问题并说明是按已定项「轨道用 hairline」执行；但 1.29:1 离 3:1 差距过大，中心倒计时和右侧数字只能部分兜底。
建议：将轨道从 `--hairline` 提至 `--stone`（#434345，1.97:1）或更高的 `--ash`（#6a6b6c，3.64:1 达到 3:1）。由于轨道是非文本图形，3:1 是硬线。需要修改 brief-m0.md 的已定项。

### R1-03 · P1 · 置信 0.70
位置：所有变体 · state=populated/loading/empty/edge/running · Codex 瓦片 `.iddot`
现象：设计者声称 loading=0 accent、empty=0 accent、populated=1 accent，但运行时 Codex iddot 始终渲染为 `rgb(244,244,246)`（V1/V2 的 loading/empty 态 `tileHead()` 不设 `data-off`），使这些状态的实际视觉 accent 分别多出 1 处。V3 的 skeleton 态正确设置了 `data-off="1"` 来关闭 iddot，但 V1/V2 没做同样处理。
依据：Playwright 验证 V1 populated accent=2（Codex iddot + 未读 rmark），V1 loading accent=1（Codex iddot），V1 empty accent=1（Codex iddot）。设计者声称值为 1/0/0。
建议：在 V1/V2 的 loading 和 empty 态也对 Codex 的 iddot 设置 `data-off="1"`，或从根源修复 R1-01（降低 `--id-codex`）。

### R1-04 · P2 · 置信 0.85
位置：全局 · `.status`（gap:7px）、`.v1-primary`（gap:7px）、`.v1-secondary`（gap:6px）、`.v1-bars`（gap:6px）、`.tile-foot`（gap:6px）、`.msg`（gap:6px）、`.attn-strip`（padding:14px）、`.v2 .tile-body`（gap:14px）、`.skel`（gap:10px）、`.v2 .tile-foot`（gap:10px）
现象：15+ 处间距值不在 token scale（2/4/8/12/16/24/32px）上，也不在 4px 栅格上。6px、7px、10px、14px 是最常见的偏离值。
依据：Playwright `getComputedStyle()` 读取所有 gap/padding 并与 4px 倍数比对。tokens.css §6 定义的 spacing scale 不包含 6/7/10/14px。hierarchy-rhythm-review.md 要求 "All padding/margin/gap values snap to a consistent scale (multiples of 4px or 8px)."
建议：确认这些值是有意的光学微调还是漏掉的 token 映射。如果是微调，在 tokens.css 补注释说明哪些位置允许 off-scale 值；如果不是，收拢到最近的 token step。

### R1-05 · P2 · 置信 0.80
位置：V3 · state=attention · `.topbar`
现象：V3 attention 态用 strip 接管 topbar（`[data-variant="v3"][data-state="attention"] .topbar{display:none}`），时钟随之消失。strip 显示事件时间（"刚刚"）但不显示系统时钟。用户在 attention 态下无法得知当前时间。
依据：CSS 规则 `display:none` 彻底移除 topbar；strip 的 HTML 不包含 clock 元素。
建议：在 strip 的右端加一个 clock span，或不隐藏 topbar 而是将 strip 放在 topbar 与 tiles 之间（需调整总高度预算）。

### R1-06 · P2 · 置信 0.75
位置：V3 · state=attention · 事件流表头
现象：V3 的 attention 态把 attention 事件从事件流中移除（`stripOwns=true` → filter），feed 标题变成「最近完成」，计数显示「全部已读」。用户若只看屏幕下半部分，看到「全部已读」会误以为没有需要处理的事。
依据：JS `renderFeed()` 在 `stripOwns` 条件下把 feedTitle 改成 "最近完成" 并过滤掉 attention 事件。虽然 strip 是全屏最高优先级信号，但下方单独看是自洽但有误导性的。
建议：保留 feedTitle 为 "需要你"，或在 feed-count 里加一句 "strip 中有 1 项等待" 作为锚点。

### R1-07 · P2 · 置信 0.60
位置：全局 · `.attn-tag`
现象：`.attn-tag` 设置了 `letter-spacing:var(--tr-caps)`（.08em）但不设置 `text-transform:uppercase`。它渲染的文本是中文「等待你」，CJK 字符不区分大小写，但 .08em tracking 会轻微拉开汉字间距。
依据：CSS `.attn-tag{letter-spacing:var(--tr-caps)}`。typography.md 的 tracking 规则是针对 ALL CAPS latin 的，CJK 不适用同一理由。
建议：`.attn-tag` 的 letter-spacing 改用 `--tr-small`（.01em）或 0，因为它不是 ALL CAPS 拉丁文。影响极小（12px 上 .08em 才 ≈0.96px 总增量），但概念上不自洽。

### R1-08 · P2 · 置信 0.90
位置：tokens.css · `--charcoal: #d3d3d4`
现象：token 提取了 `--charcoal` 但 `variations.html` 中 `var(--charcoal)` 出现 0 次。设计者在 findings 里已标注 "dead weight"。
依据：`grep -c 'var(--charcoal)' variations.html` 返回 0。tokens.css findings section 第一条。
建议：要么在 Electron 渲染层有明确用途再保留，要么注释掉并标注 "reserved, not used in M0 prototype"，避免未来维护者误以为它有用。

### R1-09 · P2 · 置信 0.55
位置：V3 · all states · `.b-side .pc`（主数字）
现象：V3 的百分比数字使用 `--fs-strong: 18px`，而 brief-m0.md 的屏幕规则写了「主数字 ≥48px」。设计者在 00-designer-notes.md §4.9 详细说明了两条已定项的冲突及其选择（按更具体的 V3 轴定义执行），合理。
依据：brief-m0.md "主数字 ≥48px" vs V3 轴定义 "额度百分比退为次级"。
建议：无需修改，但需要用户在评审反馈中显式确认接受此取舍。

---

## Slop 七宗检查

| # | 规则 | 结果 |
|---|---|---|
| 1 | Tailwind 靛蓝系 | ✅ 无（grep 0 命中） |
| 2 | 双色渐变 hero | ✅ 无 gradient 关键词（grep 仅在注释中出现，说明刻意排除） |
| 3 | Emoji 图标 | ✅ 无 emoji，16 个 SVG icon 全部 1.6px stroke + `currentColor` + `aria-hidden="true"` |
| 4 | Sans-serif 裸 system-ui | ✅ 标题用 `var(--font-sans)`（Inter 领头），harness 刻意用 system-ui 与设计拉开 |
| 5 | 左侧色条卡片 | ✅ 无 `border-left` pattern（grep 0 命中） |
| 6 | 编造指标 | ✅ 所有数值来自 `design/fixtures/` 真实数据或标注的合成数据 |
| 7 | 填充文案 | ✅ 无 lorem ipsum / placeholder，所有事件标题是本机真实会话记录 |

**Soft tells 检查：**
- `#000`/`#fff` 大面积：✅ canvas 是 #07080a，最亮文字是 #f4f4f6。唯一的 `#fff` 在 harness pressed 按钮（不参与设计）。
- Accent 超额（≤2 规则）：⚠️ 见 R1-01 / R1-03。概念上遵守（身份色≠accent），视觉上有越界。
- 装饰性动画 / shimmer：✅ loading 用静态骨架 + "读取中" 标签，无 shimmer。
- 投影 / box-shadow：✅ 深度全由 surface 阶梯实现，唯一的 box-shadow 在 `.iddot[data-status="attention"]` 上做光晕（3px rgba 14% 透明度），功能性。

---

## 层级

### 5 秒测试

| 变体 | populated 第一眼 | attention 第一眼 | 通过 |
|---|---|---|---|
| V1 | 48px 数字 "22%" "18%"（最大元素 = 主信息） | Claude 瓦片 "等待你" 标签 + attention 行标题（全白，呼吸动画） | ✅ |
| V2 | 仪表弧形状 + 48px 数字（pre-attentive shape + size） | 同 V1 | ✅ |
| V3 | 时间带的填充与游标落差 + 右侧 18% 数字 | strip 全宽条（18px 白色标题 + 呼吸动画），占据最高位置 | ✅ |

**Primary / secondary / tertiary 区分方式：**
- Primary：字号（48px / 20–22px lead 标题）+ 颜色（--ink 白）+ 位置（最上方或最新一条）
- Secondary：字号（16px）+ 颜色（--body 灰）+ 位置（下方行）
- Tertiary：字号（12–13px）+ 颜色（--mute 暗灰）+ 位置（元数据槽）

三级区分由字号 + 颜色 + 位置三个维度共同承载，不依赖单一维度。✅

**最新一条是否真的最重？** 是。populated 态的 lead 行比普通行高（64px vs 48px，V2 是 72px vs 40px），标题 20–22px vs 16px，且有 surface-card 背景和 accent 圆点。attention 态的 attention 行有 `hairline-strong` 边框 + 呼吸动画 + `surface-card` 背景。Running 行有身份色脉冲 + 置顶位置。✅

---

## 节奏

### 间距
主要结构间距（pad-screen 16px、gap-tile 12px、gap-block 16px、h-row 48px、h-row-lead 64px、feed padding 12px）全部在 token scale 上。15+ 处微间距偏离 4px 栅格（见 R1-04）。

### Type scale
8 个唯一字号值（12/13/14/16/18/20/22/48px），9 个命名 token（--fs-lead-lg 和 --fs-num-sm 共享 22px）。在 ≤8 档内。✅

### 三块瓦片一致性
同 border-radius（10px）、同 border（1px --hairline）、同背景（--surface）、同 padding（16px）、同 grid-template-columns（repeat(3,1fr)）、同 gap（12px）。V3 改了结构（垂直堆叠、66px 高），但三块仍同边、同内边距。✅

### 事件行一致性
所有行共享同一 grid-template-columns、同一高度 token、同一 hover / focus 处理。V2 的 non-lead 行从 48px 压到 40px，V3 也是 40px，但 lead 行高度不同（V1 64px、V2 72px、V3 48px）——这是变体差异轴的合理表达。✅

---

## 字距字号

| 规则 | 结果 | 运行时验证 |
|---|---|---|
| ALL CAPS ≥0.06em | ✅ 全部 0.080em | Playwright 逐元素验证 6 个 uppercase 实例均为 0.080em |
| 小字 ≥12px | ✅ | Playwright 扫描 stage 内所有文本节点，无 <12px（harness 11px 在 stage 外） |
| 小字 tracking ≥0.01em | ✅ --tr-small: .01em | |
| 48px 数字负字距 | ✅ --tr-num: -.02em | |
| tabular-nums 生效 | ✅ | `font-variant-numeric: tabular-nums` + `font-feature-settings: "tnum" 1, "zero" 1` 双保险 |

---

## 变体区分度

| 对比 | 一句话差别 | 是否真的不同 |
|---|---|---|
| V1 → V2 | 从读数字到读形状 | ✅ 仪表弧引入 pre-attentive shape 信号 |
| V2 → V3 | 从读还剩多少到读够不够撑到重置 | ✅ 时间带 + 游标 + 判语是全新信息层 |
| V1 → V3 | 从数字优先到时间优先 | ✅ 完全不同的信息架构 |

V3 是否仍在 raycast token 之内：✅。surface 四级阶梯、hairline、Inter+ss03、身份色、语义色全部沿用，无新增 hex 或字体。差异仅在布局（竖叠 vs 横排）、数字权重（18px vs 48px）、事件流形态（时间轴 vs 卡片列表）。

---

## 文案

| 规则 | 结果 |
|---|---|
| 中文文案从用户视角命名 | ✅ "等待你批准" 而非 "permission_prompt"；"额度接口 401" 而非 "401_unauthorized" |
| 错误态说原因 + 下一步 | ✅ 三种错误（401/429/离线）各有不同的原因句和操作句 |
| 空态有说明 | ✅ "还没有智谱 API Key" + "在托盘菜单「连接 ZCode」里粘贴" |
| 数字格式 | ✅ 倒计时 "2h22m"、时间 "16:56"、跨天 "9/13 10:36" |

---

## 已拍板决策符合性清单

| # | 已定项 | 符合 |
|---|---|---|
| 1 | 960×540 @2x，文本 ≥12px | ✅ |
| 2 | 布局 B：瓦片上、事件下，顺序 Codex→Claude→ZCode | ✅ |
| 3 | raycast 视觉真源，canvas #07080a | ✅ |
| 4 | Inter + ss03，IBM Plex Mono for numerals | ✅ |
| 5 | 身份色 Claude #d97757 / ZCode OKLCH 校准 / Codex #f4f4f6 | ✅（但 Codex=accent 引发 R1-01） |
| 6 | 语义色沿用 raycast，≥80% warn ≥95% danger | ✅ |
| 7 | accent ≤2 | ⚠️ 概念遵守，视觉越界（R1-01/R1-03） |
| 8 | 不用左侧色条 | ✅ |
| 9 | ZCode 默认未连接 + 原因 + 下一步 | ✅ |
| 10 | Web Audio ≤200ms 提示音 | ✅（G5+D6 纯五度，180ms 衰减） |
| 11 | attention 全屏最高优先级 | ✅ |
| 12 | running 2s 脉冲 | ✅ |
| 13 | 无设置 UI / 无 emoji / 无渐变 / 无靛蓝 / 无 #000/#fff 大面积 | ✅ |
| 14 | 五态齐全 + error 三种文案 + edge 四种边界 | ✅ |
| 15 | 动效时长：event ≤400ms, bar 300ms, breathe 3s/≤8%, pulse 2s, state 150–300ms | ✅ |
| 16 | prefers-reduced-motion 全停 | ✅ |
| 17 | 主数字 ≥48px | ⚠️ V1/V2 ✅；V3 18px（有意偏离，已记 R1-09） |
| 18 | V2 轨道用 hairline | ✅ 已照做（但引发 R1-02 对比度问题） |
| 19 | Tab/Enter 可达，focus 非浏览器默认蓝 | ✅ 2px --ink 内描边 17.05:1 |

---

## 汇总

| 严重度 | 条数 |
|---|---|
| P0 | 0 |
| P1 | 3 |
| P2 | 6 |

**最重要的三条：**

1. **R1-01 (P1)** Codex 身份色 #f4f4f6 与 accent 同 hex，attention 态出现 3 个视觉等价的白色圆点，超过 ≤2 上限。修法：降 Codex 身份色到 --body 或 --charcoal。
2. **R1-02 (P1)** V2 仪表轨道 `--hairline` 在 `--surface` 上只有 1.29:1，达不到 WCAG 3:1 非文本图形线。修法：轨道提至 `--stone` 或 `--ash`。
3. **R1-03 (P1)** V1/V2 的 loading/empty 态 Codex iddot 仍为白色，使声称 0 accent 的状态出现 1 处视觉 accent。与 R1-01 同源，修 R1-01 即解。
