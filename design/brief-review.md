# M0 评审简报 · 两条独立 reviewer lane

> 评审对象：`design/variations.html` 与 `design/tokens.css`。评审者只读不改；所有修改由作者 lane 执行。
> 原则：**报告每一条发现，包括不确定和低严重度的**，每条都给严重度与置信度。过滤与排序由汇总方做，reviewer 自我审查会降低召回。

## 通用要求

先读作者的约束来源，否则无法判断「偏离」还是「有意为之」：
- `design/brief-m0.md`（已拍板的决策与唯一有意偏离）
- `DESIGN.md`（raycast，视觉真源）
- `design/review/00-designer-notes.md`（作者自述与已知未验证项）
- `~/.claude/design-vocab.md`（用它的机制词汇写发现，例如「tracking 不足」「非 GPU 合成的 transition」「accent 超额」，不要写「不好看」）

每条发现的格式：

```
### R1-07 · P1 · 置信 0.8
位置：V2 · state=attention · `.tile--zcode .empty` （或行号）
现象：……（可复现的观察）
依据：……（引用哪条规则 / 哪个数值，例如 mute #9c9c9d on #0d0d0d = 6.3:1）
建议：……（用机制词汇给出修法，一句话）
```

严重度：P0 = 阻断（对比度不达标、键盘不可达、focus 被移除、状态缺失、溢出裁切、违反已拍板决策）；P1 = 质量（slop 套路、层级失效、交互态缺失、字距字号违规）；P2 = 打磨建议。

报告末尾附「已拍板决策符合性清单」：把 `brief-m0.md` 的每条「已定」逐条打 ✅ / ❌ / 未验证。

若 `npx playwright` 可用，允许用它对每个变体 × 每个状态测量 stage 的 `scrollWidth/scrollHeight` 是否超出 960×540、并对文本元素做溢出检查；不可用则用静态阅读并标注「未运行时验证」。

## Reviewer 1 · 反 slop + 层级节奏

写到 `design/review/01-slop-hierarchy.md`。

先读：
- `~/.claude/skills/claude-design-system/skills/ai-slop-check.md`
- `~/.claude/skills/claude-design-system/skills/hierarchy-rhythm-review.md`
- `~/.claude/docs/open-design-craft/anti-ai-slop.md`、`typography.md`、`color.md`、`laws-of-ux.md`

重点核查：
1. **accent 纪律**：每个变体每个状态下真正的 accent 可见次数 ≤2；身份色是否越界成大面积填充；语义色是否被当作装饰。
2. **slop 套路**：渐变、emoji、左侧色条卡片、靛蓝系、`#000`/`#fff` 大面积、bare `system-ui` 标题、默认 `rounded-lg` 一刀切、装饰性动画。
3. **层级**：5 秒测试——每个变体在 populated 与 attention 态下，第一眼落在哪；primary / secondary / tertiary 是否由字号 + 字重 + 颜色 + 位置 + 密度共同区分；最新一条事件是否真的最重。
4. **节奏**：间距是否在 4/8 栅格上；type scale 是否 ≤8 档并被遵守；三块瓦片是否作为同一对象复现（同边、同基线、同内边距）；事件行是否复现一致。
5. **字距字号**：ALL CAPS ≥0.06em；小字 ≥12px 且 ≥0.01em；48px+ 数字负字距；tabular-nums 是否真的生效（检查 `font-variant-numeric` 或字体本身）。
6. **变体区分度**：任意两个变体能否一句话说清差别；V3 是否「真的不同」但仍在 raycast token 之内。
7. **文案**：中文文案是否从用户视角命名（「等待你批准」而非「permission_prompt」）；错误态是否说了原因和下一步。

## Reviewer 2 · 无障碍 + 交互态 + 五态覆盖

写到 `design/review/02-a11y-states.md`。

先读：
- `~/.claude/skills/claude-design-system/skills/accessibility-audit.md`
- `~/.claude/skills/claude-design-system/skills/interaction-states-pass.md`
- `~/.claude/docs/open-design-craft/accessibility-baseline.md`、`state-coverage.md`、`animation-discipline.md`

重点核查：
1. **对比度**：用脚本按 WCAG 公式实际计算 tokens 中每一对「文本色 × 底色」的比值（正文 4.5:1、≥18px 或 14px bold 3:1、UI 组件 3:1），逐对列出数值；特别是 raycast 的 mute `#9c9c9d`、ash `#6a6b6c`、stone `#434345` 在 `#0d0d0d`/`#121212` 上的用法。
2. **不靠颜色单独传状态**：running / attention / 未读 / 额度阈值是否都有非颜色信号（形状、文字、位置、粗细）。
3. **语义与结构**：事件行是 `button` 还是 `div`；标题层级；`aria-live` 是否用于新事件到达；SVG 图标是否 `aria-hidden` 且有文字替代。
4. **键盘**：Tab 顺序、Enter ack、focus 可见且不被裁切、focus 样式不是浏览器默认蓝。
5. **交互态**：每个可交互元素的 default / hover / active / focus / disabled；transition 150–300ms；`prefers-reduced-motion` 与控制栏开关是否都能关掉全部动效。
6. **五态覆盖**：3 瓦片 + 事件流 × loading / empty / error / populated / edge，逐格打勾；error 三种文案是否各不相同且给出下一步；edge 的 64 字标题是否用省略号 `…`、超长 cwd 是否不撑破布局、8 条事件是否不溢出、97% 额度是否转红且倒计时正确。
7. **attention / running**：呼吸与脉冲的周期与幅度是否符合简报（3s / ≤8%，2s）；attention 出现时是否仍 ≤2 处 accent。
8. **动效**：是否只在状态变化时出现；是否用 transform / opacity 而非 layout 属性；新事件推入是否 ≤400ms。
9. **溢出**：三个变体 × 七种状态，stage 内无横向/纵向溢出、无文本裁切。
