# M1 简报 · Electron 骨架

> 给 executor agent 的实现简报。M0 已定稿；M1 的目标是让定稿的四页轮播在 TYPE-C 副屏上以 Electron 全屏跑起来，用 fixtures 数据，不接真实采集（那是 M2 / M3）。

## 先读

1. `PLAN.md` §1（本机事实）、§2.3（数据模型）、§4（架构与取舍）、§5（M1 验收）
2. `design/brief-m0-rotation.md`（轮播、打断、纯净模式、**手动切换**的全部规则）
3. `design/variations.html`（M0 定稿原型，渲染层的移植来源；designer 可能仍在补「手动切换」一节，**移植渲染层之前重新读一次最新文件**）
4. `design/tokens.css`（唯一样式真源）
5. `design/review/00-designer-notes.md` 末尾几节（轮播、R5、实机反馈、手动切换的实现细节与坑）
6. `design/fixtures/quota.json`、`events.json`（M1 的数据）

## 技术栈决定（相对 PLAN.md §4 的修订，已由 lead 拍板）

- electron-vite 5 + Electron 44 + TypeScript，包管理 pnpm。
- **渲染层不用 React / Tailwind**，直接移植原型的原生 HTML / CSS / JS 为 TS 模块。理由：原型已是可运行的完整实现，tokens.css 是手写的 raycast 体系，加框架只增加复杂度。
- 画布仍是 480×270，用原型同款 CSS `zoom: 2` 铺满 960×540；主进程不再另设 zoomFactor，避免双重缩放。
- 状态由主进程持有（PLAN.md §2.3 的 `AgentState[]` + `AgentEvent[]`），经 preload 推给渲染层；渲染层只画、只发 ack / setPage。
- electron-builder、托盘、自启到 M4 再加。

## 目录

```
Monitor/
  package.json  electron.vite.config.ts  tsconfig.json  tsconfig.node.json  tsconfig.web.json
  src/main/
    index.ts        app 生命周期、单实例锁、创建窗口、注册快捷键、dev IPC
    displays.ts     pickTarget(displays: Display[]): Target —— 优先 label 含 "TYPE-C"，其次 size 960×540，否则 null；纯函数
    window.ts       frameless、bounds 精确等于目标显示器、setSimpleFullScreen(true)、backgroundColor #07080a、
                    hot-plug：监听 screen 的 display-added / display-removed / display-metrics-changed 重新 pickTarget；
                    找不到副屏 → 主屏居中 960×540 普通窗口，副屏回来 → 2 s 内迁回全屏
    state.ts        MonitorState 存储 + 变更推送（只推 diff 或整份都可，M1 数据量小）；
                    M1 用 src/main/fixtures/*.json（从 design/fixtures 复制）喂数据
    shortcuts.ts    globalShortcut：⌃⌥← / ⌃⌥→ 切页，⌃⌥↑ 回 A 并恢复轮播；注册失败只记录不崩
  src/preload/index.ts
                    contextBridge.exposeInMainWorld("monitor", {
                      subscribe(cb), ack(id), setPage(page),
                      dev: { setState(name), simulateEvent(), simulateAttention(), clearAttention() }
                    })；contextIsolation: true，nodeIntegration: false
  src/renderer/
    index.html      纯净视图，无控制栏；`?debug=1` 时显示原型里的控制栏（七态切换、模拟、轮播开关、reduced-motion）
    tokens.css      直接 import `../../design/tokens.css`（或构建期复制并断言逐字相同）
    app.ts          从原型移植：四页、七态、纯净显示、提示音、reduced-motion、手动切换（键盘 / 指示点 / 边缘区）
    pager.ts        轮播状态机，纯函数：tick(now)、interrupt(kind)、manual(page)、ack()；dwell 60 s、事件打断停满一轮、
                    attention 冻结、手动后 120 s 暂停；不碰 DOM，便于测试
  tests/
    displays.test.ts   pickTarget：label 命中 / 尺寸命中 / 都不命中 / 多个候选
    pager.test.ts      dwell 推进、A→B→C→A、新事件跳 C 并重新计时、attention 冻结与解除回 A、手动后 120 s 暂停并恢复、
                       attention 下手动无效、reduced-motion 不影响状态机
  scripts/shoot.ts     dev 模式下经 IPC 让主进程 capturePage，四页 × 七态截图到 design/shots/m1/（960×540 @2x）
```

## 验收（对应 PLAN.md §5 M1）

1. `pnpm dev` 启动后窗口出现在 TYPE-C 副屏并铺满 960×540；主进程日志打印所选显示器的 label 与 bounds。
2. 拔掉副屏：2 s 内变为主屏居中的 960×540 普通窗口；插回：2 s 内回到副屏全屏。实机插拔由用户做，你要在汇报里写清验证步骤，并用 vitest 覆盖 `pickTarget` 的选择逻辑。
3. `design/shots/m1/` 里四页 × 七态各一张，与 `design/shots/page-*.png` 目视一致（同字号、同布局、同数据）。
4. 全局快捷键切页可用；点击指示点 / 边缘区可切页；手动切页后自动轮播暂停 120 s；新事件仍能打断。
5. `pnpm test` 全过；`pnpm build` 通过；渲染层无 console error。

## 不要做

- 不接真实数据源（codexbar、OAuth、智谱接口、rollout 监听、hooks、sqlite）——那是 M2 / M3。
- 不做托盘、登录自启、打包、任何设置 UI。
- 不读任何凭据文件，不访问网络。
- 不修改 `design/` 下的文件（只允许新增 `design/shots/m1/`）。
- 不 commit；完成后由 lead 提交。

## 汇报

不超过 300 字：文件清单、验收 1–5 各自的状态与证据、未验证项、发现的原型移植问题。
