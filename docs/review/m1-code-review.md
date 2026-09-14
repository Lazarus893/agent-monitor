# M1 代码复核 · Agent Monitor

> reviewer 视角的独立复核，不改任何代码。
> 复核对象：`src/`、`tests/`、`scripts/`、构建配置、`design/shots/m1/` 产物。
> 参照：`docs/m1-brief.md`、`PLAN.md` §2.3/§4/§5、`design/brief-m0-rotation.md`、`design/variations.html`。
> 日期：2026-09-14。每条发现标 **严重度**（P0 阻塞 / P1 提交前必修 / P2 可择期）与**置信度**。

---

## 0. 结论先行

**修完 5 条（1 × P0 + 4 × P1）后可提交。**

机械验证已过：`pnpm test` 43/43 通过（102 ms），`pnpm build` 退出码 0、无 error/warning。
但**验收 1 与验收 3 实际没达成**：前者是主进程从不把首帧状态递给渲染层（在当前 960×540 模式下面板会是黑屏），后者是 28 张截图里至少 4 张是错帧、半透明过渡帧或空白帧，其中最关键的 attention 整屏页那张拍成了 C 页。

剩余 P0 / P1 清单见 §6。

整体判断：这是一份质量明显在平均线之上的移植。画布 CSS 与原型 **逐字节一致**（见 §3.1 的 diff 证据），fixtures 与 `design/fixtures/` 逐字节一致，抖动修复被抽成了纯函数并配了真实根因的回归用例，安全面（contextIsolation / nodeIntegration / CSP / 零网络 / 零凭据）干净。问题集中在**「状态怎么第一次到达渲染层」与「截图脚本的时序」**这两处接缝上——都是没有被 43 条单测覆盖的地带。

---

## 1. 正确性

### 1.1 P0 · 渲染层永远收不到首帧 MonitorState（置信度：高，静态推证，未实机跑）

`src/main/index.ts:47-49`

```ts
const unsubscribe = store.subscribe(state => {
  if (!mw.win.isDestroyed()) mw.win.webContents.send(CH.state, state)
})
```

`Store.subscribe`（`src/main/state.ts:205-209`）在注册时**同步回调一次** `fn(this.state)`。而 `await mw.load()` 在 `src/main/index.ts:81` 才执行——也就是说这唯一的一次 `webContents.send(CH.state, …)` 发生在页面加载之前，落在 `about:blank` 上，被丢弃。之后 store 不再变化，就再没有第二次推送。

代码里没有任何补救路径：全仓库找不到 `did-finish-load` / `dom-ready` 的重推，也没有让渲染层主动拉取的 `ipcMain.handle`（`grep -rn "did-finish-load\|dom-ready\|CH.state" src/ scripts/` 只有上面这一处 send 和 preload 的一处 on）。

唯一的偶然补救是 `MonitorWindow` 构造里 `ready-to-show → relocate() → deps.onCanvas(canvasFor(bounds))`（`src/main/window.ts:82-85`、`170`）→ `Store.setCanvas`。但 `setCanvas` 在尺寸相同时提前 return（`src/main/state.ts:196`），而 `Store` 的初值就是 `{480, 270}`：

| 目标显示器 | canvasFor | 与初值 | 结果 |
|---|---|---|---|
| TYPE-C 960×540 @2x（**用户当前模式**） | 480×270 | 相同 | **不 emit → 面板全黑，只有右上角时钟** |
| 回落到主屏 960×540 窗口 | 480×270 | 相同 | **不 emit → 同样全黑** |
| TYPE-C 960×640 @1x（原生 3:2） | 480×320 | 不同 | emit → 侥幸能显示 |

这解释了为什么 executor 可能没发现：`pnpm shoot` 每轮都调 `store.setScene()`、`pnpm selftest` 第 5 步调 `dev.simulateEvent()`，两条路都会触发 emit；`design/shots/m1/native-960x640/` 说明实机验证很可能是在 960×640 模式下做的——那是三种情形里唯一能跑的一种。

**影响**：验收 1「`pnpm dev` 启动后窗口出现在 TYPE-C 副屏并铺满」在字面上成立（窗口位置对），但屏上没有内容。

**建议修法**（任选其一，都不动数据模型）：
- `mw.win.webContents.on('did-finish-load', () => mw.win.webContents.send(CH.state, store.get()))`；或
- 把 `store.subscribe(...)` 挪到 `await mw.load()` 之后；或
- 加一条 `ipcMain.handle('monitor:get', () => store.get())`，preload 暴露 `getState()`，渲染层 `subscribe` 之后立刻拉一次（最稳，不依赖事件顺序）。

顺带：修好之后请在 **960×540 模式**下跑一次 `pnpm dev` 复验，不要只在 960×640 下验。

---

### 1.2 pager.ts 与 `brief-m0-rotation.md` 的逐条比对

`src/renderer/pager.ts` 是纯函数、无副作用、每个导出都对得上简报的一句话。逐条核对结果：

| 简报规则 | 实现 | 结论 |
|---|---|---|
| 每页停 60 s，A→B→C→A | `tick` `pager.ts:72-82`；`ORDER` `:29` | ✅ 与 `--dwell-a/b/c` 一致（`tokens.css:223-226`），单测 `tests/pager.test.ts:30-36` 卡到 59_999 / 60_000 边界 |
| 新事件立即跳 C 并停满一个 dwell，再来一条重新计时 | `interruptEvent` `:89-93`，`dwellFor` 的 `eventHold` 分支 `:60` | ✅ 单测 `:50-65` |
| attention 冻结轮播，解除后回 A | `interruptAttention` `:96-98`、`ack` `:101-105` | ✅ 单测 `:86-101` |
| 手动后暂停 120 s | `manual` `:111-121`，`--manual-hold: 120s`（`tokens.css:231`） | ✅ 单测 `:121-135` |
| 手动暂停期间来新事件仍跳 C | `interruptEvent` 里 `holdUntil: 0` `:91` | ✅ 单测 `:75-82`，selftest 第 5 步也真按了一遍 |
| attention 下手动无效 | `manual` / `step` 的 `if (s.attention) return s` | ✅ 单测 `:103-109` |
| reduced-motion 不影响状态机 | 状态里没有任何动效键 | ✅ 单测 `:164-179` 用「键名集合 + 两次同解」把它证成了可执行断言，写法可取 |

**P2 · `attn` 页不在 `ORDER` 里，从它出发的推进会跳过 A**（置信度：高）
`pager.ts:78`：`ORDER[(Math.max(0, ORDER.indexOf(s.page)) + 1) % ORDER.length]`。当 `page === 'attn'` 时 `indexOf` 返回 −1，被 `Math.max(0, …)` 兜成 0，下一页算出来是 **`b`** 而不是 `a`。正常路径进不来（`tick` 在 `s.attention` 时先 return），但 `showPage(s, 'attn')`（`:141-144`，截图脚本专用）**不设 `attention` 标志**，于是截图脚本把页面定在 attn 之后，60 s 后状态机会自己滑到 B 页。同理 `step` 从 attn 出发（`:127-128`）向左会到 `c`、向右到 `b`。
`showPage` 也没清 `eventHold`，定到 C 页时会按 `dwellEvent` 计时。
建议：`ORDER.indexOf` 找不到时显式回 `'a'`，并让 `showPage` 清 `eventHold`。单测里 `showPage` **完全没被 import**，这个洞是测试盲区的直接后果。

---

### 1.3 P1 · 首帧把既有未读事件当成「新事件」，开机就跳 C 页并响提示音（置信度：高）

`src/renderer/app.ts:492`

```ts
const fresh = next.events.find(e => !prevIds.has(e.id) && !e.acked && e.kind !== 'attention')
```

首帧时 `knownIds` 是空集（`app.ts:171`），而 `populated` 场景的 `baseFeed()` 把第一条标成未读（`src/main/state.ts:56`：`acked: i !== 0`）。于是首帧必然命中 `fresh` → `interruptEvent` + `chime()`（`app.ts:533-537`），面板一启动就落在 C 页并响一声。

简报的默认是 `A → B → C`，`create(now, { page: 'a' })`（`app.ts:177`）也是这么起的——首帧立刻把它推翻。`app.ts:483-487` 已经有 `firstState` 标志（只用来定时间原点），把它顺手用在这里即可：首帧只 `knownIds = new Set(...)`，不触发打断。

同一根因的次要表现（P2）：调试栏切场景（`empty → populated`）会让 6 条事件全变「新」，命中一条 `fresh` 后跳 C；原型的 `segState` 点击是不跳页的（`design/variations.html` 的 `segState` handler 只 `render()`）。

**今天被 §1.1 掩盖**——首帧根本没到——所以修完 P0 之后这条会立刻显形。两条要一起修、一起验。

---

### 1.4 P1 · window.ts：settle 窗口内的显示器变化会被**永久**吞掉（置信度：中高）

三道闸门（`changedMetrics` 过滤 / 300 ms debounce / `relocating` 标志）确实把 2026-09-14 那个抖动死循环挡住了，`shouldRelocate` 的两道判据（`src/main/displays.ts:120-123`）逻辑正确，回归用例（`tests/displays.test.ts:148-186`）把根因写进了断言，这部分是扎实的。**仍可能循环的路径我没找到**：workArea 单独变化被第一道闸门挡掉，目标不变且已全屏被第二道闸门挡掉，回落窗口路径 `shouldRelocate(null, null, {isFullScreen:false}) === false`。

但有一个反向问题——**丢事件**：

```ts
// src/main/window.ts:102-107（轮询）
const sig = displaySignature(allDisplays())
if (sig === this.signature) return
this.signature = sig        // ← 先消费掉指纹
this.schedule()             // ← 再被 relocating 丢弃

// :119-120
private schedule(changed?: readonly string[]): void {
  if (this.relocating) return   // 丢弃，不排队、不置脏位

// :174-178（settle 结束）
this.relocating = false
this.signature = displaySignature(allDisplays())  // ← 再抹一次
```

时间线：`t=0` 开始重定位（`relocating = true`，`SETTLE_MS = 600`）→ `t=300` 用户真的拔了副屏，`display-removed` 到达，被丢弃 → `t=500` 轮询发现指纹变了，**先写回 `this.signature`**，再调 `schedule()`，又被丢弃 → `t=600` settle 结束，`signature` 再刷成当前值。此后指纹不再变化，轮询永远不会触发，`display-*` 事件也不会重放。窗口就停在一块已经不存在（或已经改了 bounds）的显示器上，直到下一次显示器拓扑变化。

macOS 热插拔恰恰是「一串事件、拓扑在几百毫秒里二次收敛」的场景，第一发触发重定位、第二发落在 settle 窗口里是很常见的，因此这条直接威胁**验收 2「2 s 内迁回/回落」**。

建议：`schedule()` 被 `relocating` 挡住时置一个 `dirty` 标志，settle 结束时若 `dirty` 就无条件再跑一次 `relocate()`（不带 `changed`，绕过第一道闸门）；或者轮询里把 `this.signature = sig` 挪到 `schedule()` 真正执行之后。

相关 P2：
- `shouldRelocate` 收到**空数组** `changed: []` 时 `[].some(...)` 为 false → 返回 `false`（`displays.ts:120`）。`schedule()` 在 `pendingUnconditional` 为假且 `pendingMetrics` 为空时正好会传 `[]`（`window.ts:126`）。今天进不来，但语义上「空的变更集」和「没有变更集」被当成了相反的两件事，建议显式处理。
- `dispose()`（`window.ts:111-116`）只清定时器，不摘 `screen.on(...)` 的三个监听；窗口关掉之后回调仍持有 `this`。M1 是「关窗即退出进程」所以无害，M4 加托盘之后会变成真泄漏。
- `MonitorWindow.target()`（`window.ts:183-185`）无人调用，死代码。

---

### 1.5 displays.ts 对 960×640 的处理：✅

`TARGET_SIZES` 同时收 960×540 与 960×640（`displays.ts:38-41`），`canvasFor` 用 `bounds/2` 算画布而不是写死（`:47-50`），回落窗口跟随 `lastSize`（`window.ts:54`、`150`）避免插回时画布闪一下，`--canvas-w/-h` 一路经 `MonitorState.canvas` 推到 `app.ts:480-481`，`app.css:22` 用 `var(--canvas-w, var(--screen-w))` 兜底。这一条链是完整的，单测 `tests/displays.test.ts:110-141` 覆盖了 label 命中、尺寸命中、`canvasFor` 两档、以及「bounds + scaleFactor 同时变要重新落位」。

P2：`pickTarget` 不排除内建屏 / 主屏。若哪天主屏被设成 960×540，`hasSize` 会把主屏选成目标。加一条 `!d.internal` 或「不是 primary」的过滤成本很低。

---

## 2. 安全

M1 的安全底线是「不联网、不读凭据、渲染层拿不到 Node」，三条都达成。

`grep -rn "fetch(|require(|child_process|spawn|exec(|https?://|keychain|safeStorage|XMLHttpRequest|WebSocket" src/ scripts/` → **零命中**。唯一的 http 引用在 `design/aspect-test.html`（Google Fonts，见 §5），不在构建链路里。字体改成 `@fontsource` 自托管是对的：产物里 44 个 woff/woff2 都落在 `out/renderer/assets/`，CSP 也就不必给外域开口子。

| 项 | 结论 |
|---|---|
| `contextIsolation: true` / `nodeIntegration: false` | ✅ `window.ts:70-71` |
| `sandbox: false` | ⚠️ P2，见下 |
| preload 暴露面 | 6 个方法 + 一个 dev 子对象，全部只转发 `ipcRenderer.send/on`，不透传 `ipcRenderer` 本身（`src/preload/index.ts`）✅ |
| `ack` 入参校验 | ✅ `index.ts:52` `typeof id === 'string'` |
| `setPage` 入参校验 | ⚠️ 无校验，但只在 `DEBUG` 下 `console.log`，无副作用（`index.ts:54-57`） |
| dev 通道 | ✅ 主进程侧 `if (!app.isPackaged)` 整体不注册（`index.ts:58`）；`setState` 的 name 用 `SCENE_NAMES` 白名单校验（`:62`） |
| CSP | ✅ 有，`default-src 'none'`，见下 |
| 外链 | `setWindowOpenHandler` 一律 deny ✅，但转手 `shell.openExternal(url)` ⚠️ |

**P2 · `sandbox: false`（`window.ts:72`）**
注释说明了理由（`"type": "module"` → electron-vite 产 `.mjs` preload → ESM preload 要求关沙箱），成立。但代价是 preload 跑在非沙箱渲染进程里、拥有完整 Node。这个 preload 只用到 `ipcRenderer`，把 preload 单独产成 CJS（electron-vite 支持给 preload 单独设 `build.rollupOptions.output.format: 'cjs'` + `.cjs` 后缀）就能把 `sandbox: true` 打开，纵深防御多一层。M1 不必现在动，但建议在 M4 打包前解决，别让它变成默认。

**P2 · `shell.openExternal(url)` 未校验协议（`window.ts:77-80`）**
面板里没有任何外链，这段是纯保险丝；但保险丝本身把任意 URL（含 `file://`、自定义 scheme）交给了系统。既然本来就 `return { action: 'deny' }`，更稳的做法是只对 `https:` 放行，或者干脆不 `openExternal`。同处还**缺 `will-navigate` 拦截**：真出现一次同窗口导航，面板就会被导走且没有回来的路。

**P2 · CSP 细节（`src/renderer/index.html:5-6`）**
`default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data:; connect-src 'self'` —— 方向对，`'unsafe-inline'` 只开在 style（行内 `style="--idc:…"` / `width:…%` 需要），script 没开。两点补充：
1. 缺 `base-uri 'none'` 与 `form-action 'none'`，这两个不受 `default-src` 覆盖；
2. **打包后走 `file://` 时 `'self'` 的匹配行为未验证**——Chromium 对 file: 来源的 `'self'` 处理历来别扭，可能把同目录的 JS/CSS/字体全拦掉。M1 不打包（`load()` 走 `ELECTRON_RENDERER_URL`，`window.ts:90`），所以现在看不出来。**请在 M4 第一次 `electron-vite preview` / 打包时立刻复验**，否则会是个"本地跑得好好的、打完包白屏"的经典坑。

**P2 · preload 无条件暴露 `dev`（`preload/index.ts:30-43`）**
主进程侧已按 `app.isPackaged` 挡住，所以打包后调用只是空转，不构成漏洞。但把 `dev` 也按同一条件在 preload 侧裁掉，攻击面更小、也更诚实。

**P2 · `ipcMain.on` 不校验 sender**
M1 只有一个窗口、渲染层不加载任何外部内容，风险为零。M4 若引入任何第二个 webContents（托盘 popover、设置窗），记得加 `event.senderFrame` 校验。

---

## 3. 与原型的一致性

### 3.1 画布 CSS：逐字节一致 ✅（强证据）

把 `design/variations.html` 第 514–776 行的第三个 `<style>` 块（STAGE 段）与 `src/renderer/app.css` 第 27–288 行做 diff：

```
$ diff proto-body.css app-body.css | wc -l
2          # 唯一差异是文件末尾多一个空行
```

也就是说 **A / B / C / attention 四页、瓦片、时间带、事件行、五态 msg 块、reduced-motion 段的每一条规则都原样搬过来了**，包括 R5-01/02/03/06/08/09/11/15/20 那一批评审修订的注释。`app.css` 头部声明的四处改动（去掉 stage 的圆角与投影、body 直接是 `--canvas`、追加 `.harness`、尺寸改 `--canvas-w/-h`）与实际内容吻合，没有夹带别的改动。

`design/tokens.css` 是**直接 import**（`app.ts:19`）而不是复制，`electron.vite.config.ts:27` 用 `server.fs.allow` 放行 root 之外的路径——「少一份副本就少一处会漂移的真源」，这个取舍对。

### 3.2 渲染 JS：四页 / 七态 / 手动切换 / 提示音 / reduced-motion 全部在位 ✅

逐个函数比对 `design/variations.html:1243-1928` 与 `src/renderer/app.ts`：`footIcon` / `msgBlock` / `renderPageA` / `renderPageB` / `rowHTML` / `renderPageC` / `renderPageAttn` / `tickClocks` / `tickTiles` / `tickFeed` / `announceThresholds` / `chime` / FLIP 推入动画 / `isTyping` / 方向键 / 指示点 / 边缘 chevron（15% 宽、2 s 自隐、focus 也浮出）—— 模板字符串与类名一致，`NOTICE_COPY` 八条文案逐字取自原型。七态由 `state.ts` 的 `SCENES` 提供，与原型的 `SCENES` 一一对应，且 `src/main/fixtures/*.json` 与 `design/fixtures/*.json` **diff 为空**。

三处结构差别都在 `app.ts:1-11` 的文件头写明了（数据来自主进程、页码交给 pager、没有纯净模式），理由成立——Electron 窗口本来就是纯净的。

**没有发现原型没有的视觉差异。**

### 3.3 P1 · ack 之后焦点丢失（移植时掉了一行，a11y 回归）（置信度：高）

原型的 ack 处理在重渲染之后把焦点还给同一行：

```js
// design/variations.html 的 el.pcFeed click handler
const again = el.pcFeed.querySelector(`.row[data-id="${CSS.escape(it.id)}"]`);
if (again) again.focus();
```

`src/renderer/app.ts:545-554` 没有这一段。M1 的 ack 是 IPC 往返（`ack → store.emit → onState → renderPageC` 整块 `innerHTML` 重写），**行元素必然被销毁重建**，所以焦点必然掉到 `<body>`。键盘用户按 Enter 标记一条已读之后，下一次 Tab 要从头开始。原型专门修过这个，移植时丢了。

修法：`onState` 里在 `renderPageC()` 之后，若 `document.activeElement` 曾是某个 `.row`（或记下 ack 前的 `data-id`），重渲染后 `querySelector` 回来 `focus()`。注意要和 `app.ts:594-602` 的「静置态丢弃焦点」逻辑协调——那段只在 `userDrivenFocus` 为假时抢焦点，ack 一定发生在用户输入之后，所以不冲突。

### 3.4 其它小差别（P2，方向都没错，记一笔备查）

- `renderPageC` 的 attention 判定加了 `&& !x.acked`（`app.ts:306` vs 原型 `shown.some(x => x.kind === "attention")`）：attention 行被 ack 之后不再霸占「放大那一条」的名额，比原型更合理，保留。
- 调试栏**少了原型的页切换按钮组**（`segPage`）。`brief-m0-rotation.md`「手动切换」末句写的是「调试视图的控制栏保留原有页切换按钮」。键盘 / 指示点 / 边缘区 / 全局快捷键四条路都在，实际影响很小，但这是对简报的一处未声明删减。
- `updateMeter`（`app.ts:194-205`）没有原型的 `page === "attn" → "attention"` 分支；`showPage('attn')` 之后仪表会显示 `ATTN · 59.8s`。纯工具层。
- `chime()` 在 `rm` 为真时静音（`app.ts:211`），与原型一致。但 `prefers-reduced-motion` 讲的是动效不是声音——一个只关动画的用户会连提示音一起丢掉。原型的决定，不在 M1 改；记在这里供 M4 的 polish-pass 复议。

---

## 4. 测试质量

### 4.1 43 条覆盖了什么

| 文件 | 条数 | 覆盖 |
|---|---|---|
| `tests/displays.test.ts` | 22 | `pickTarget`（label 命中 / 大小写与前后缀 / 尺寸命中 / 都不命中 / label 优先于尺寸 / 多候选取第一个 / label 为 undefined）、`centeredBounds`（默认与跟随 640）、两种面板模式、`shouldRelocate` 抖动回归 8 条、`displaySignature` 4 条 |
| `tests/pager.test.ts` | 21 | 默认值对齐 tokens、定时轮播 3 条（含 59_999/60_000 边界）、新事件 4 条、attention 4 条、手动 4 条、纯度 2 条 |

质量高的地方：`shouldRelocate` 那一组把「进全屏 → workArea 变 → 再 toggle」的真实死循环写成了可读的断言；pager 的时间断言都卡在 dwell 的两侧（59_999 / 60_000、119_999 / 120_000、64_999 / 65_000），不是随手取整；「reduced-motion 不影响状态机」被证成了「状态键名集合 + 两次同解」而不是一句注释。

### 4.2 漏了什么

**`shouldRelocate` 的边界**
- `changed: []`（空数组）——见 §1.4，语义与 `undefined` 相反却没有断言。
- `changed: ['workArea']` 但目标**真的**变了（`prev !== next`）→ 当前实现返回 `false`。这是第一道闸门的有意取舍，但没有一条用例把这个取舍钉住，将来有人放宽闸门不会有测试报警。
- `shouldRelocate(null, null, { isFullScreen: true })`（没有副屏但窗口仍在全屏，应该退出全屏）——`tests/displays.test.ts:173-175` 只测了 `isFullScreen: false`。
- `targetsEqual` 只比 id 与 bounds，不比 label / reason；「同一块屏从 size 命中变成 label 命中」不会触发重定位。可能是有意的，但没有测试表达。

**pager 的时间边界与遗漏导出**
- **`showPage` 完全没被 import**——截图脚本唯一依赖的入口零覆盖，§1.2 那个 attn→b 的滑动就是从这里漏出去的。
- `manual(s, 'attn', …)`：没有任何守卫阻止手动切到 attn 页，`dwellFor` 会给它 `dwellC`。UI 上到不了（指示点只有 a/b/c），但纯函数层面是敞开的。
- `now === holdUntil` / `now === dwellUntil` 的同刻语义（`manualPaused` 用 `>`、`tick` 用 `<`，两者自洽）没有专门断言；测试取的是 120_001 而不是 120_000。
- `setAuto(false)` 不清 `holdUntil`、`interruptAttention` 之后 `auto` 保持原值——这些组合态没有断言。

**整个渲染层零测试**
43 条全在 `displays` + `pager`。`toScene`、`NOTICE_COPY` 映射、`renderPageA/B/C/Attn` 的 HTML、`syncTopbar` 的「只在 A/B 页显示未读数」、`announceThresholds` 的跨阈值播报——一条都没有。`design/verify.mjs`（Playwright，28 条版面断言 + 12 条节奏断言）**没有接到 Electron 渲染层上**，`package.json` 里也没有对应脚本。验收 3 因此只剩「人眼看截图」这一条路，而截图本身有 §4.3 的问题。

建议（不必在本轮做完）：加一个 jsdom/happy-dom 环境的 `tests/render.test.ts`，至少把「七态 × 四页都能渲染出非空 HTML 且不抛错」钉住——这一条就能把 §1.1 那种「首帧没到」的问题在 CI 里变成红色。

### 4.3 P1 · `scripts/shoot.ts` 的 `rendered` 没有序号，产物已被证伪（置信度：高，有实证）

`design/shots/m1/` 里 28 张 + `native-960x640/` 2 张。对 28 张算 md5：

```
page-attention-empty.png  ==  page-attention-populated.png     # 合理：两种场景下 attn 页都是「没有等待你的事」
page-a-attention.png      ==  page-attention-edge.png          # 不合理
```

打开看：
- **`page-a-attention.png` 是一张半透明过渡帧**——C 页的事件行正在淡出，A 页的「97% 7d」「Claude Code 按这个速度用不完 82%」在底下淡入，两层叠在一起。
- **`page-attention-attention.png` 拍成了 C 页**（右下角第三个点亮着，画面是带 attention 行的事件流），而这一张恰恰是整个 M1 最该拍对的一张：简报要求 attention 是「专用整屏页，『等待你』≥24px」。
- **`page-b-attention.png` 只有 14 KB，画面全黑**，只剩右上角 `16:33 · 1` 和三个全暗的点——是页切换刚开始、新页 `opacity` 还在 0 的那一帧。

根因在 `scripts/shoot.ts:26-37` 与 `:47-52`：

```ts
const settled = waitRendered()      // ipcMain.once(CH.rendered, …)，无序号
store.setScene(scene)
win.webContents.send(CH.command, { type: 'showPage', page })
const ok = await settled
await sleep(ok ? 420 : 700)
```

`rendered` 是个**无身份的裸信号**。某一轮若超时（走 700 ms 分支），它的 `once` 监听已被 `off` 掉，但渲染层那一声 `rendered()` 仍会晚到；下一轮在发指令**之前**就已经 `ipcMain.once` 注册好了，于是**上一轮的迟到信号会立刻解锁下一轮的等待**。此后 420 ms 的 sleep 从「本轮页面还没切」的时刻起算，`--dur-page`（300 ms）的淡入淡出就会被拍进去，甚至拍到 `opacity: 0` 的起始帧。一旦错位就会沿着 28 张一路传染，这与「坏帧集中在靠后的 edge / attention 场景」的现象吻合。

**影响**：验收 3「四页 × 七态各一张，与 `design/shots/page-*.png` 目视一致」**未达成**。

**修法**：给 `rendered` 带一个自增 token（`showPage` 指令里下发，渲染层原样回报），`waitRendered(token)` 只认自己的那一声；顺便在超时分支打一条 warn，别让超时静默。最省事的补强：捕获前额外 `await sleep(--dur-page + 100)`，并在 capture 之后用 `executeJavaScript` 读回 `document.documentElement.dataset.page` 与 `dataset.state`，与文件名断言一致——**让脚本自己发现拍错了，而不是靠 reviewer 去算 md5**。

尺寸本身是对的：28 张都是 1920×1080（960×540 @2x），native 两张 1920×1280。

### 4.4 `scripts/selftest.ts` 的可重复性

7 组检查（全局快捷键 / ⌃⌥ 切页 / 指示点 / 手动暂停 + `--manual-hold` token / 边缘区 / 新事件打断 / attention 接管与解除）+ 两档画布溢出 + 原生模式出图。用 `sendInputEvent` 真按键真点击、从 `data-page` 读回结果，思路对，是验收 4 的机械证据。

可重复性上的三个前提没有写在脚本里，建议补一句输出说明：
1. **依赖全局快捷键没被别的 app 占用**。`registerShortcuts` 的设计是「注册失败只记录不崩」（`shortcuts.ts:25`，正确），但 selftest 第 1 条会直接 FAIL，看起来像回归。
2. **依赖副屏在位**：第 7/8 步在窗口上量溢出、改 bounds 到 960×640；没有副屏时窗口是主屏居中的 960×540，量出来的结论不一样。
3. **失败时不还原**：`:164-165` 的 `--canvas-h` 与 `dataset.rm` 还原写在最后，中途任一步抛错就跳过——不过第 8 步用了 try/catch 且进程随后退出，实际影响有限。

另：selftest 第 8 步把窗口 `setSimpleFullScreen(false)` 并改成 960×640 之后就退出，注释里已说明「之后进程就退出了」，可接受。

---

## 5. 工程

**对的地方**
- `package.json` 依赖极干净：electron 44.3.0 / electron-vite 5.0.0 / vite 7.3.6 / vitest 5.0.0 / typescript 5.9.3 / `@types/node` / 两个 `@fontsource`，**没有一个多余项**，没有提前引入 electron-builder / React / Tailwind（符合简报「不要做」）。
- `build` 脚本先跑两份 `tsc --noEmit` 再 `electron-vite build`，等于把类型检查钉进了构建；实测退出码 0、无 warning。
- TS 严格度：两份 tsconfig 都开了 `strict` + `noUnusedLocals` + `noUnusedParameters` + `noFallthroughCasesInSwitch`。main/preload/shared 与 renderer 分成 node/web 两套 lib，`tsconfig.web.json` 的 `types: []` 防止 Node 类型漏进渲染层——这个拆分是对的。
- `.gitignore` 增补 `*.tsbuildinfo`，`out/` 已忽略。
- fixtures 用 `import ... with { type: 'json' }` 内联进 bundle（`state.ts:14-15`），省掉运行时找路径的分支，理由写在注释里。

**P2 清单**
1. `tsconfig.json` 用 `references` 但两个被引用的 project 都没有 `"composite": true`。现在没人跑 `tsc -b`，所以不报错；要么补 `composite`，要么把根 tsconfig 退回成普通的 `files: []` 占位。
2. 没开 `noUncheckedIndexedAccess`。代价是 `app.ts` / `state.ts` 里几十个 `t.windows[0]!`、`ORDER[...]!`、`TARGET_SIZES[0]!` 的 `!` **实际上是空操作**（不开这个选项时索引本来就不返回 undefined），看起来像在防御，其实没有。更要紧的是 `renderPageA/B` 假定「`phase === 'ok'` ⇒ `windows[0]` 存在」（`app.ts:207`、`:247`）——M1 的 fixtures 满足，M2 接真实采集时「拿到了响应但 windows 为空」是完全可能的一种返回，那时会抛 `Cannot read properties of undefined`。建议开 `noUncheckedIndexedAccess`，让编译器把这些点全部标出来。
3. `scripts/shoot.ts` 与 `scripts/selftest.ts` 被 `src/main/index.ts:15-16` **静态 import**，于是连同 `node:fs/promises` 一起打进了生产 main bundle（`out/main/index.js` 38 KB）。不是安全问题（只有 `MONITOR_SHOOT` / `MONITOR_SELFTEST` 能触发），但工具代码不该进产物；改成 `await import()` 动态加载即可。
4. `backgroundColor: '#07080a'`（`window.ts:25`）把 `--canvas` 的值硬编码了一份。注释写了它是 `--canvas`，但仍是第二处真源。M2 之前无所谓，改主题时记得两边一起改。
5. **`design/aspect-test.html` 是新增在 `design/` 下的文件**，超出简报「不修改 `design/`，只允许新增 `design/shots/m1/`」的范围；它还 `<link>` 了 Google Fonts（是本仓库里唯一的外部网络引用）。提交前请明确它的归属：是 M0 designer 的校准页就并进 M0 的范围说明，是 M1 期间造的临时页就删掉或挪到 `docs/`。
6. `test-results/.last-run.json` 是早先 Playwright 的残留，建议清掉或加进 `.gitignore`。
7. 无残留调试代码：`grep TODO|FIXME|XXX|debugger` 零命中；`console.log` 只有 7 处，全部是主进程的落位日志、shoot/selftest 的进度输出，以及 `index.ts:56` 那条 `DEBUG` 门控的页码日志——都该留。

---

## 6. 剩余 P0 / P1（提交前必修）

| # | 严重度 | 位置 | 一句话 |
|---|---|---|---|
| 1 | **P0** | `src/main/index.ts:47-49` / `:81` | 首帧 `MonitorState` 在页面加载前就发出去了，渲染层永远收不到；960×540 模式下面板是黑屏。加 `did-finish-load` 重推或 `ipcMain.handle` 拉取。**修完要在 960×540 模式下复验，不能只验 960×640。** |
| 2 | **P1** | `src/main/window.ts:102-107`、`:119-120`、`:174-178` | settle 窗口（600 ms）内到达的显示器变化被丢弃且指纹已被消费，永久丢事件；威胁验收 2。置脏位 + settle 结束补跑一次 `relocate()`。 |
| 3 | **P1** | `src/renderer/app.ts:492`、`:533-537` | 首帧把既有未读事件当「新事件」，开机即跳 C 页 + 响提示音，违背「默认从 A 页开始」。用已有的 `firstState` 标志跳过首帧打断。（被 #1 掩盖，一起修一起验。） |
| 4 | **P1** | `scripts/shoot.ts:26-37`、`:47-52` | `rendered` 无序号，迟到的回报会提前解锁下一轮 → 28 张里至少 4 张错帧/过渡帧/空白帧（`page-attention-attention` 拍成了 C 页，`page-a-attention` 与 `page-attention-edge` 字节相同）。验收 3 未达成。加 token + 捕获后回读 `dataset.page/state` 自校验，然后重拍。 |
| 5 | **P1** | `src/renderer/app.ts:545-554` | ack 之后焦点掉到 `<body>`（原型有 `again.focus()`，移植时丢了）；键盘用户每标记一条已读就要重新 Tab。 |

P2 共 18 条，分散在 §1.2、§1.4、§1.5、§2、§3.4、§4.2、§5，不阻塞提交，建议在 M2 开工前扫一遍（尤其 §5.2 的 `noUncheckedIndexedAccess`——它直接关系到 M2 接真实数据时渲染层会不会崩）。

---

## 7. 验收表（对照 `docs/m1-brief.md` §验收）

| # | 项 | 状态 | 证据 |
|---|---|---|---|
| 1 | 窗口落在 TYPE-C 并铺满、日志打印 label 与 bounds | 🟡 **部分** | 选屏与日志实现正确（`window.ts:151-154`），但**屏上没有内容**（P0 #1）。实机未验（本轮不跑 `pnpm dev`）。 |
| 2 | 拔插 2 s 内迁移 | 🟡 **部分** | `pickTarget` / `shouldRelocate` / `displaySignature` 逻辑正确且有 22 条单测；但 settle 窗口丢事件（P1 #2）。实机插拔仍需用户执行。 |
| 3 | 四页 × 七态截图与 M0 目视一致 | ❌ **未达成** | 28 张里 ≥4 张错帧（md5 重复 + 逐张查看），见 §4.3。 |
| 4 | 快捷键 / 指示点 / 边缘区 / 120 s 暂停 / 新事件仍能打断 | 🟡 **未独立验证** | `scripts/selftest.ts` 覆盖到位且设计合理，但本轮没有运行（会在副屏开窗口）。pager 的规则层由 21 条单测背书。 |
| 5 | `pnpm test` 全过、`pnpm build` 通过、渲染层无 console error | 🟡 **部分** | ✅ 43/43 通过（102 ms）；✅ build 退出码 0、无 error/warning；console error 需实跑 `pnpm dev` 才能验，主进程已挂 `console-message` 转发（`index.ts:41-45`），机制在位。 |

---

## 8. 本轮实际执行的命令

```
pnpm test    → Test Files 2 passed (2) · Tests 43 passed (43) · Duration 102ms
pnpm build   → tsc(node) + tsc(web) + electron-vite build · exit 0 · 无 error/warning
             → out/main/index.js · out/preload/index.mjs · out/renderer/index.html + 44 个字体资源
diff design/variations.html(514-776) src/renderer/app.css(27-288)   → 仅末尾空行
diff src/main/fixtures/*.json design/fixtures/*.json                → 完全一致
md5 design/shots/m1/*.png                                           → 2 组重复（1 组不合理）
grep 网络 / 凭据 / child_process / TODO / debugger                   → 零命中
```

未执行（按指令）：`pnpm dev`、`pnpm shoot`、`pnpm selftest`——三者都会在用户副屏上开窗口。因此 §1.1 的 P0 是静态推证（置信度高，推证链完整写在该节），§7 的验收 1/2/4 需要用户或 executor 实机复验。

---

## 9. 复验（2026-09-14 18:36，executor 修复后）

只复核不改码。逐条核对 §6 的 5 条，外加机械验证与截图抽查。

### 9.1 五条逐条核对

| # | 原问题 | 落实情况 | 证据 |
|---|---|---|---|
| 1 | **P0** 首帧发在页面加载前 | ✅ **已修，且比建议更稳** | `src/main/index.ts:52-61`：新增 `rendererReady` 闸门，`push()` 在就绪前只丢不发；`webContents.on('did-finish-load')` 置位后立刻 `push(store.get())` 补推整份 state，再 `store.subscribe(push)`。`did-finish-load` 每次重载都触发，dev 整页刷新后也能拿到状态（注释 `:45-51` 写明了这一点）。新增 `tests/state.test.ts:11-23` 把「subscribe 同步回放一次完整 state」钉成前提，`:25-32` 覆盖「晚一步订阅也拿得到当前 state」——正是补推依赖的那条性质。不再依赖 `setCanvas` 的偶然 emit（`tests/state.test.ts:45-54` 明确断言「首帧不再依赖它」）。 |
| 2 | **P1** settle 期间丢显示器事件 | ✅ **已修** | 新增 `RelocateQueue`（`src/main/displays.ts:132-170`）：`push` 只入队、`block/unblock` 控闸、`take()` 取批。`window.ts:124-133` 的 `schedule()` 改为**先入队再判 blocked**，被挡住时变化留在队列里；`window.ts:179-186` settle 结束后 `unblock()` 并 `if (this.queue.pending) this.schedule()` 补跑。轮询 `window.ts:102-107` **不再提前消费指纹**（注释直接点名这条复核意见），指纹改在 relocate 真正处理完之后更新——no-op 分支 `:144`、settle 分支 `:182` 各一处，两条路都覆盖到了。5 条 `RelocateQueue` 单测（`tests/displays.test.ts:207-245`）覆盖 block 期间入队、take 清空不重放、无条件变化盖过 metrics 过滤、一个 debounce 窗口内合批、空队列不白跑。 |
| 3 | **P1** 首帧把既有未读当新事件 | ✅ **已修** | `src/renderer/app.ts:515-533`：`isFirst`（复用 `firstState`）与新增的 `sceneChanged`（`state0` 记上一帧场景，`:193`）任一成立就把 `fresh` 置 `undefined`，不触发 `interruptEvent`、不响提示音。顺带处理了我在 §1.3 记的次要项：切场景不再被读成「来了新事件」。另加一处我没提但对的收敛：`:575-577` 首帧带 attention 时仍然接管（那是当前状态）但**不响铃**，理由写在注释里。 |
| 4 | **P1** shoot 的 `rendered` 无序号 | ✅ **已修，并加了自校验** | `scripts/shoot.ts:36-54` 的 `waitRendered(token)` 只认自己那一声（`if (got !== token) return`），超时改为 `console.warn` 出声而非静默；token 经 `MonitorCommand`（`src/shared/types.ts:104`）→ 渲染层原样回报（`app.ts:711-713`）→ preload `rendered(token)`（`src/preload/index.ts:27-28`），链路完整。`shoot.ts:73-89` 在**拍之前**回读 `dataset.page / dataset.state` 与文件名对账，不一致就记进 `wrong[]`、逐张打 `BAD`，收尾 `return false` → `index.ts:100-103` 据此设 `process.exitCode`，`pnpm shoot` 现在会以非零码失败。`SETTLE_MS` 从 420 提到 450（`--dur-page` 300 + 150 余量），超时从 2000 提到 3000。 |
| 5 | **P1** ack 后焦点丢失 | ✅ **已修** | `app.ts:601` 在 ack 前记下 `refocusRowId`（仅当 `document.activeElement === row` 且不是 attention 行——attention ack 之后整屏回 A 页，没有这一行可还，判断是对的）；`app.ts:550-554` 在 `renderPageC()` 之后用 `CSS.escape(id)` 找回同一条并 `focus()`。与 `:732` 起的「静置态丢弃焦点」逻辑不冲突：ack 必然发生在一次 pointerdown/keydown 之后，`userDrivenFocus` 已为真。 |

### 9.2 机械验证

```
pnpm test   → Test Files 3 passed (3) · Tests 63 passed (63) · 114ms   （43 → 63，+20 条）
pnpm build  → exit 0，无 error / warning；out/main/index.js、out/preload/index.mjs、out/renderer 齐全
```

### 9.3 截图抽查（`design/shots/m1/`，18:33 重拍，28 张）

| 文件 | 结论 |
|---|---|
| `page-attention-attention.png` | ✅ **已是正确的整屏 attention 页**：CLAUDE 身份徽记 + 身份色点、「↵ 等待你」大字、「批准写入 ~/.claude/settings.json」、「会话已暂停，等待 Write 权限确认 · 已等 2h00m」、右上角一处 accent 点、三个指示点全暗。上一轮这张拍成了 C 页。 |
| `page-c-populated.png` | ✅ 正确的 C 页：lead 行放大 + 未读 accent 点 + 「29 分钟前」，其余三行 14px 时间列，第三个点亮。画面完全不透明，无过渡叠影。 |
| `page-c-attention.png` | ✅ 正确：attention 行作为 lead（带 `--ash` 描边与「等待你」标签），下接三条已读行，第三个点亮。 |
| 全量 md5 | ✅ 只剩**一组合理重复**：`page-attention-{edge,empty,error,populated}.png` 四张相同——这四个场景都没有 attention 事件，attn 页本来就是同一张「没有等待你的事」。上一轮那组不合理的重复（`page-a-attention` == `page-attention-edge`）已消失。 |

### 9.4 顺带确认的 P2（未要求，但已落实）

`noUncheckedIndexedAccess: true` 两份 tsconfig 都开了（`tsconfig.node.json:14`、`tsconfig.web.json:14`）；`tsconfig.json` 去掉了 `references` 并注明理由。`Tile` 被改成**判别联合**（`app.ts:121-130`），`toTile`（`:136-149`）在「没有 notice 也没有窗口」时降级成 `first_sample` 空态而不是当场抛——这比我建议的「靠编译器标出来」更进一步，M2 接真实采集时那条崩溃路径被类型堵死了。另：`pager.showPage` 现在清 `eventHold`（`pager.ts:150-154`），`nextFrom`（`:32-36`）修掉了 attn→B 的滑动并配了 4 条单测；`shoot`/`selftest` 改成动态 `import()`，不再进生产 main bundle（`index.ts:96-105`）；调试栏恢复了原型的 `segPage` 页切换按钮（`index.html:44-46`）；`test-results/` 进了 `.gitignore`。

### 9.5 仍然开着的项（全部 P2，不阻塞）

1. `sandbox: false`（`window.ts:72`）——M4 打包前改 CJS preload 再开沙箱。
2. `shell.openExternal(url)` 未校验协议、无 `will-navigate` 拦截（`window.ts:77-80`）。
3. CSP 缺 `base-uri` / `form-action`；**`file://` 下 `'self'` 能否匹配未验证**——M4 第一次打包/`preview` 时务必复验。
4. preload 无条件暴露 `dev`（主进程侧已按 `isPackaged` 挡住，仅纵深防御）。
5. `ipcMain.on` 不校验 sender（M1 单窗口无风险，M4 加第二个 webContents 时再说）。
6. `dispose()` 仍不摘 `screen` 的三个监听；`MonitorWindow.target()` 仍是死代码。
7. 渲染层仍无 DOM 层测试，`design/verify.mjs` 仍未接到 Electron 渲染层上。
8. `design/aspect-test.html` 仍在，归属待定（超出「只允许新增 `design/shots/m1/`」，且是仓库里唯一的外部网络引用）。
9. **新增一条观察项**：settle 结束的补跑意味着每次真实重定位后会多跑一轮 no-op 评估（我们自己 toggle 全屏产生的 `workArea` 事件会让 `pending` 为真）。它收敛的前提是 `setSimpleFullScreen(true)` 之后 `isSimpleFullScreen()` 立刻为 `true`——成立则第二轮在 `shouldRelocate` 第二道闸门直接 return，不会 toggle。**实机验收时顺手看一眼主进程日志**：若出现每约 900 ms 一条 `[displays] target=…`，就是这条没收敛。单测层面无法覆盖（依赖 Electron 的真实行为）。
10. 一处轻微回归（调试栏专用）：从 `empty` / `error` / `loading` 场景点「模拟新事件」时，`Store.simulateEvent` 会把场景提升成 `populated`（`state.ts:232`），于是 `sceneChanged` 为真、这一条不再跳 C 也不响铃。实机与 `selftest`（从 `populated` 起）都不走这条路。

### 9.6 复验结论

**可提交。** §6 的 1 × P0 + 4 × P1 全部落实，每条都带了回归用例（+20 条，63/63 通过），`pnpm build` 干净，截图重拍后抽查三张全部正确、不合理的重复已消失。验收 3 现在达成；验收 1 / 2 / 4 的实机部分仍待用户在副屏上跑（本轮按约定没有启动 `pnpm dev`），跑的时候留意 §9.5 第 9 条的日志特征。剩余 10 条全是 P2，建议在 M2 开工前顺手扫掉 1–6。
