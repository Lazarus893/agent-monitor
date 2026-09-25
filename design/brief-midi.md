# Midi 打字伴侣 · F 页 · M0 简报

> 两只猫轮班：Midi（虎斑）白班 8–20 点，咖啡（暹罗）其余时间；托盘「Midi 形象」可固定一只；F 页场景下方「换班」按钮临时换；换班有走位动画。实现与截图见 `design/midi-cat-v3/IMPLEMENTATION.md`（暹罗）与 `design/midi-cat-v2/IMPLEMENTATION.md`（虎斑）。
> `design/midi-prototype.html` 仅保留为历史交互原型。
> 玩法与取舍的完整版发布在 Artifact「墨墨打字伴侣」（猫已改名 Midi）。本文只写 M0 要做的事。

## 0 · 一句话

副屏第七页：一只坐在键盘后面的像素猫 Midi。你打字它就打字（左右爪交替），停 4 秒它抬头看你，
停 5 分钟趴下睡。它不评价、不催、不因为你今天没打字而变样。右侧三个数：今日字数、连续天数、昨天字数。

## 1 · 两层数据，M0 只做心跳层

| 层 | 信号 | 来源 | 延迟 | 看得到原文吗 |
|---|---|---|---|---|
| 心跳层 | 「刚才多打了 N 个字」 | 本机 AX 监听子进程（Swift，`helpers/ax-pulse`） | < 100 ms | **不看**：子进程只比长度，文本不出进程 |
| 日记层（下一期） | 逐日统计、主战场 app、一句日记 | dsh-ime 链路（farm-keeper 规则） | 5–20 s | 模型看，页面永不显示 |

## 2 · 心跳层子进程 `ax-pulse`

（规则从 ContextIME `AXMonitor.swift` 的实战里提炼，见 `~/Projects/ContextIME/docs/DISCUSSION.md`。）

- 单文件 Swift（`helpers/ax-pulse/main.swift`），`scripts/build-ax-pulse.sh` 用 `swiftc` 编到 `build/ax-pulse`（不提交），打包经 `extraResources` 落到 `Contents/Resources/ax-pulse`。
- 进程壳是 `NSApplication`（activationPolicy `.prohibited`）+ 主 RunLoop：NSWorkspace 通知与 AXObserver 都需要它。stdin 关闭即退出，父进程没了不留孤儿。
- 权限：启动 `AXIsProcessTrustedWithOptions`（prompt 一次）；没权限 → `{"status":"untrusted"}`，每 5 s 复查，拿到即 `{"status":"ok"}`。TCC 把授权记在**父进程**（dev 下是 Electron，打包后是 Agent Monitor）上，且按代码签名追踪 —— 所以 `pnpm package` 改用钥匙串里的本地证书签（`scripts/sign-app.sh`），签名不随构建漂。
- Electron / Chromium 系 app（Claude 桌面端、Cursor、企业微信）：刚到前台一两秒问不到焦点（cannotComplete），稳定后不用任何私有属性就能拿到 AXTextArea 与字数；**AXManualAccessibility 反而会弄坏它**（2026-09-15 实测）。所以取不到焦点就重试：前 4 次隔 0.5 s，之后每 5 s，直到拿到或前台换人。
- **只监听前台 app**：`didActivateApplicationNotification` 时换观察者。app 元素上挂焦点变化通知，焦点元素上挂 `kAXValueChanged`；焦点通知里给的 element 不可信，重新查 `kAXFocusedUIElement`。
- 读字数只读 `kAXNumberOfCharactersAttribute`（一个 Int，文本从不跨进程拷贝）；焦点换了基线重置为新元素当前字数。
- 每次值变化报 `{"t":<ms>,"d":<带符号增量>}`，`|d| > 30` 不报（粘贴 / 整段替换 / 刷屏）。**永不输出文本、app 名、bundle id。**
- 拒掉的 app：密码管理器、系统设置、SecurityAgent、钥匙串、loginwindow；以及**终端类**（Terminal / iTerm2 / Ghostty / Warp / kitty / Alacritty / WezTerm）—— 它们的 AX value 是整个 scrollback，命令输出会被当成打字。这是 M0 的已知限制：终端类 app 不算数；IDE 内嵌终端（VS Code / Cursor / JetBrains / Zed）目前没拒，输出会被当成打字，二期处理。
- `AXSecureTextField` 子角色一律不挂。

## 3 · 主进程 `src/main/collectors/typing/`

- 子进程按行解析；崩了退避重启（2 s → 4 s → … 封顶 60 s）；找不到二进制 → `offline`。
- **增量折算（PulseFolder，纯函数）**：`d > 0` 立刻算打字（脉冲 + 账本）；`d == −1` 是退格，忽略；`−30 ≤ d ≤ −2` 且 3 s 内有过正增量 → 拼音中间态上屏（`wo xiang xie` 十个字母变成三个字，AX 报 −7），账本扣回但下限是这 3 s 内挣到的数；其它负值忽略。
- 账本 `userData/typing.json`：`{ version:1, days:{ "YYYY-MM-DD": chars } }`，原子写、0600、去抖 5 s、退出 flush。`today / yesterday / streak` 全部从账本派生（streak 含今天；今天为 0 时从昨天往回数）。
- 推送：每条脉冲立刻 `CH.pulse`；`MonitorState.typing` 节流 5 s（状态变化、跨日立刻）。
- dev：`simulateTyping(chars)` 走与真实脉冲同一条路。SHOOT 模式不起子进程，fixtures 的 `populated` 场景自带一份 typing。

## 4 · 渲染层 F 页

- 画布区分左右：左边场景（`<canvas>`，像素倍率 4，整数倍）、右边三个数 + 一行状态文案；底部指示点自动多一个。
- 帧：idle / typeL / typeR / look / blink / night / sleep，另有 idle 的 ear 姿态；图集按形象取 `src/renderer/assets/midi-{siamese,tabby}.png`，各渲染到固定 96×96 缓存；偏好 `midiSkin`（tabby / siamese / shift）经 command 推到渲染层，`shared/midi-cats.ts` 决定此刻谁当班；文案里的名字跟当班的猫走。换班编排是 `midi.ts` 的纯函数 `handoverFrame`。灯、键盘仍为主题色字符网格。
- 状态机（纯函数，可测）：`< 600 ms` 打字（每个脉冲切一次爪）；`< 4 s` idle（3–7 s 随机眨眼，闭眼 220 ms）；`< 5 min` 抬头看你；`≥ 5 min` 睡。22:00–05:00 眼睛眯成一条缝（night 帧替代 idle/look）。
- 心流灯：`flow ∈ [0,1]`，每个字 +0.03，停 2 s 后每秒 −0.03，底 0.06 不灭到零；灯光透明度与影子长度（0–3 格）跟它走。
- 里程碑：今日字数每过 500 跳一下（2 格上 2 格下，480 ms，切帧不补间）。
- 位移一律落网格；只有透明度允许平滑。`prefers-reduced-motion` 时不跳、不点头，只切帧。
- 诚实态：
  - `connecting` → 猫 idle，文案「Midi 正在醒来」；
  - `untrusted` → 猫 sleep，文案「系统设置 › 隐私与安全性 › 辅助功能 里勾上 Agent Monitor」；
  - `offline` → 猫 sleep，文案「还没连上 Midi 的耳朵」；
  - `ok` 且今天 0 字 → 猫 idle，文案「Midi 在等你」，右栏「今日」不显示 0，显示「昨天 N 字」在上；
  - 数字一律 tabular-nums，`--font-num`。
- 颜色：场景用 tokens 的 canvas / surface / hairline / mute / ink；猫的米色是分类色；金色 `#f2c14e`（= `--warn`）只用于灯光。
- 轮播：`ORDER_ALL` 加 `'f'`，dwell 与 D/E 同；`PAGE_LABEL.f = 'Midi'`；调试栏与 shoot / selftest 的页面列表都加上。

## 5 · 验收

- `pnpm build` 与 `pnpm test` 全绿；新用例：账本派生（跨日 / streak / 粘贴不算）、状态机（四态 + 夜间 + 里程碑）、pager 七页。
- dev 实机：敲一下 100 ms 内爪子动；停 5 分钟睡；杀掉子进程猫趴下且今日数字不清零；重启 app 数字不丢。
- 打包后：首次起要在辅助功能里勾一次；ad-hoc 重签后要再勾一次（与钥匙串同类，写进 README）。
