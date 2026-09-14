# M0 设计简报 · Agent Monitor 高保真变体

> 给 designer agent 的工作简报。所有决策已由用户拍板，简报里的「已定」项不要再问、不要漂移。

## 你的角色

designer-who-codes。按 `claude-design-system` 的 `generate-variations` + `make-a-prototype` 两个流程做事，交付一个可交互的单文件原型，里面有三个可切换的高保真变体。

## 必读，按这个顺序

1. `PLAN.md` §0、§3（目标、设计治理、布局 B）
2. `DESIGN.md`（raycast，唯一视觉真源。重点：Colors / Typography / Layout / Elevation & Depth / Shapes / Components / Do's and Don'ts）
3. `~/.claude/docs/open-design-craft/` 下的 `color.md`、`typography.md`、`state-coverage.md`、`accessibility-baseline.md`、`animation-discipline.md`、`anti-ai-slop.md`、`laws-of-ux.md`（看 dashboard 相关段落：Selective Attention、Pareto、Working Memory、Serial Position）
4. `~/.claude/skills/claude-design-system/skills/design-system-extract.md`、`generate-variations.md`、`make-a-prototype.md`
5. `~/.claude/design-vocab.md`（写变体说明和注释时用它的机制词汇，不用「好看」「高级」这类词）
6. fixtures：`design/fixtures/quota.json`、`design/fixtures/events.json`（本机真实数据，字段含义见 `design/fixtures/extract.py` 顶部注释）
7. `design/wireframes.html` 里的布局 B（已选定；A、C 只作参照）

## 已定的决策

**屏幕** 逻辑 960×540 @2x，7 寸，手臂距离观看。任何文本 ≥12px；标签 13px；事件标题 16–18px；主数字 ≥48px；最新一条事件标题 ≥20px。没有触控，鼠标极少用，但行高仍 ≥40px。

**布局 B** 上带三块额度瓦片，顺序固定 Codex → Claude Code → ZCode；下带统一时序事件流，最新一条放大。右上角当前时间（tabular）。

**视觉真源** raycast：canvas `#07080a`、surface 阶梯 `#0d0d0d → #101111 → #121212`、hairline `#242728`、圆角 6–10px、无投影、Inter + `font-feature-settings: "calt","kern","liga","ss03"`。字体从 Google Fonts 加载并写完整 fallback 栈。

**唯一有意偏离** 所有数字（百分比、倒计时、时间戳）用等宽 tabular 面。在 IBM Plex Mono 与 JetBrains Mono 之间选一个，在 notes 里用一句话说明理由（提示：48px 以上的数字不能读起来像代码）。标签沿用 Inter。

**身份色**（分类色，只用于徽记、色点、仪表进度弧这类小面积，绝不做大面积填充）
- Claude `#d97757`
- ZCode 智谱蓝，从 `#3b6cff` 出发，在 oklch 里校到与 Claude 橙同明度、同色度
- Codex 中性白 `#f4f4f6`

**语义色** 沿用 raycast：green `#59d499`、yellow `#ffc533`、red `#ff6161`；额度 ≥80% 转黄、≥95% 转红。语义色不算 accent。

**accent 纪律** 真正的强调只留给「未读 / 需要你」，每屏可见 ≤2 处。不要用左侧色条标记未读行（那是 AI slop 清单上的默认卡片样式）；用 surface 阶梯上升一档 + 标题转 ink 白加粗 + 一个 6px 圆点。

**ZCode 静止态** 默认是「未连接」空态：没有 API Key。空态要有一句话说明原因和一句话说明怎么接（没有按钮，配置在托盘菜单里做）。populated 态用 `quota.json` 里 `sampleWhenConnected` 的数据，含第三个窗口「1mo · MCP 8/1000」。

**通知** 副屏高亮 + 轻提示音。原型里用 Web Audio 合成一个 ≤200ms 的柔和音（两个正弦音、短衰减），不要外链音频文件。不发系统通知。

**attention 状态** 「等待你批准 / 输入」必须设计出来：它是全屏最高优先级信号，但仍要遵守 accent ≤2。运行中（running）也要有状态：agent 徽记旁一个慢速脉冲。

**交互** 没有任何设置类 UI。唯一交互：点击事件行 = ack（未读 → 已读）。键盘 Tab / Enter 可达，hover / focus 可见（focus 用 raycast 的 hairline-strong 或 ink 描边，不用浏览器默认蓝）。

**禁用** emoji 图标（图标用 1.6–1.8px 描边 monoline SVG，`currentColor`）；任何渐变；Tailwind 靛蓝系；大面积纯黑纯白（raycast 的 `#07080a` 与 `#f4f4f6` 可以）；装饰性动画。

**五态** 每块额度瓦片与事件流都要有 loading / empty / error / populated / edge：
- error 具体到：额度接口 401 未授权、被限流、离线（三种文案不同，都要给出下一步）
- edge 具体到：64 字任务标题、超长 cwd、一分钟内 8 条事件、额度 97% 且 3 分钟后重置

**动效** 只用于状态变化：新事件进入（≤400ms，从最新行位置推入，其余行位移）、额度条推进（300ms）、running 脉冲（2s 周期）、attention 呼吸（3s 周期，亮度不超过 8%）。状态切换 150–300ms。`prefers-reduced-motion` 下全部关闭，只保留即时切换。

**文案** 中文界面；agent 名、5h / 7d / 1mo 标签用英文和数字。倒计时用 `2h34m` 样式；重置时间用 `16:56`；跨天用 `9/20 03:21`。

## 交付物

### 1. `design/tokens.css`
先按 `design-system-extract` 从 `DESIGN.md` 抽 raycast 的 token（颜色、字体、字号、字重、行高、字距、间距、圆角），再追加项目层：身份色、语义阈值、为 960×540 定的 type scale、动效时长与缓动。分组清晰，命名按用途不按色相。文件末尾用注释写 findings：抽了什么、DESIGN.md 里缺什么、你替项目补了什么。

### 2. `design/variations.html`
一个标准的独立 HTML 文件（带 doctype、head、body，能直接双击打开）。

- 中央一个 **960×540 的 stage，1:1 像素不缩放**；页面背景用一个不属于 raycast 阶梯的中性深灰衬托，让 stage 边界清楚。
- stage 上方一条**控制栏**，纯工具样式，不参与设计：
  - 变体切换 V1 / V2 / V3
  - 状态切换：populated / loading / empty / error / edge / attention / running
  - 「模拟新事件」按钮：推入一条新事件（从 fixtures 里随机取一条改成刚刚）+ 提示音 + 未读
  - reduced-motion 开关（模拟媒体查询）
- 三个变体**共用 `tokens.css`**（内联进文件，别 link 本地文件，方便之后发布），差异只在变体自身的 CSS / 结构。
- 变体用 `data-variant`、状态用 `data-state` 驱动；原生 JS，不用框架。
- fixtures 数据**内联**进 `<script type="application/json">`，不要 fetch。
- `localStorage` 记住当前变体与状态，刷新不丢。
- 文件顶部注释块：屏幕与状态映射（照 `make-a-prototype` Phase 2 的格式）、每个变体一句 caption、你的推荐、自检勾选表。

### 3. `design/shots/`
每个变体的 populated 与 attention 两态截图，命名 `v1-populated.png`、`v1-attention.png`……优先用 Playwright（`npx playwright` 若可用），否则用 `agent-browser` skill。截不了就在 notes 里明说，不要假装。

### 4. `design/review/00-designer-notes.md`
做了什么、字体选择理由、每个变体的 caption 与差异轴、推荐哪个及理由、哪些没验证。

## 三个变体的轴（已定）

按 basic → bold 排列。每个变体都必须完整支持全部 7 种状态。任意两个变体之间的差别要能一句话说清。

**V1 · Ledger · 照本宣科**
raycast 原样。瓦片 = agent 名 + 大百分比（5h）+ 两条细 bar（5h、7d）+ 重置倒计时。事件流 = 行，agent 用 12px 大写徽记 chip 区分，未读行按上面的规则处理。

**V2 · Gauge · 推进一档**
5h 窗改为 80–96px 的弧形仪表（SVG stroke，270° 开口朝下），身份色只上进度弧，轨道用 hairline；倒计时放进仪表中心；7d 保持细 bar。事件流最新一条放大为 20–22px 双行卡，其余行压到 40px。

**V3 · Strip · 大胆一步**
以时间为主轴。每块瓦片的核心变成一条横向的 5h 窗时间带：0 → 5h，标出当前时刻位置、已用比例、重置点；额度百分比退为次级。事件流改成你认为最能和时间带呼应的形态（右侧竖向时间轴，或底部带状），attention 出现时顶部一条全宽 strip 接管。V3 必须真的不同，但仍在 raycast 的 token 之内。

## 交付前自检（在文件顶部注释里逐项打勾）

- 六条产品原则（`PLAN.md` §3.3）逐条一句话回答
- state-coverage：五态 × 3 瓦片 + 事件流，全部可通过控制栏切到
- accent ≤2；ALL CAPS 字距 ≥0.06em；小字 ≥12px；数字 tabular-nums
- 对比度：正文 4.5:1、大字 3:1。特别核 raycast 的 mute `#9c9c9d` 与 ash `#6a6b6c` 在 `#0d0d0d` 上的比值，ash 只能用于 ≥18px 或非信息性文本
- Tab 顺序合理；focus 可见；Enter 可 ack；reduced-motion 生效
- 没有 emoji、渐变、靛蓝、左侧色条；没有 `#000` / `#fff` 大面积
- 三个变体在 7 种状态下都没有溢出 960×540、没有裁切文本（64 字标题用省略号 `…`，不是三个点）

## 不要做

- 不要问用户问题；简报没写的小决定自己定，写进 notes。
- 不要做设置页、按钮、菜单。
- 不要产出 v1.html / v2.html / v3.html 三个文件。
- 不要改 `DESIGN.md`、`PLAN.md`、fixtures。

---

## 评审后修订（lead 于 2026-09-14 拍板，依据 `design/review/01-*.md`、`02-*.md`）

两条「已定」值与简报自己的硬规则冲突，规则优先于具体值：

1. **Codex 身份色改为 raycast 的 charcoal `#d3d3d4`**（原 `#f4f4f6` 与 accent 同 hex，attention 态出现 3 个等亮度白点，违反 accent ≤2）。仍是中性白系，与 accent 拉开半档。
2. **所有轨道类图形（V1 bar 轨、V2 仪表弧轨、V3 时间带轨、V3 时间轴节点）统一提到 ≥3:1**，用 `--ash #6a6b6c`（原「轨道用 hairline」只有 1.29:1，违反 WCAG 1.4.11 非文本对比度硬线）。
3. **V3 的百分比 18px 予以接受**：V3 的轴定义「额度退为次级」比通用的「主数字 ≥48px」更具体，按具体项执行。
