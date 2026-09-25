# Midi · 暹罗形象已接入（2026-09-16）

> 同日追加：暹罗猫命名「咖啡」，两只猫轮班与换班动画，见文末。

用户 2026-09-15 提供第二只猫（海豹重点色暹罗）的照片，要求按 v2 的思路再做一套，并加一个切换形象的入口。

## 实现

- 两套图集并存：`src/renderer/assets/midi-tabby.png`（原方案 3 虎斑，文件由 midi-pocket.png 改名）与 `src/renderer/assets/midi-siamese.png`（本轮新作）。都是 1536×1024 RGBA，4 列 2 行，姿态顺序 idle / typeL / typeR / look / blink / night / sleep / ear。
- `src/renderer/midi-sprites.ts`：`CAT_SKINS` 按形象各给 8 个裁切矩形，`CAT_ATLAS_FILE` 给文件名；测试与渲染层共用这一份。暹罗的站姿源框 284×300 缩到 84×88（虎斑是 284×336 → 76×88），脚底同样落在猫框 y=92；蜷睡帧 312×190 → 92×56。耳动帧的源框刻意停在 x=1438，把右上角两道「动耳」小标记留在外面。
- `src/renderer/midi-cat.ts`：画家按形象各解码一次、各缓存 8 张 96×96，`load(skin)` 幂等、`ready(skin)` 查就绪；画哪只由调用方每次指定，所以换班那 2.5 秒两只可以同时在屏上。托盘偏好推来之前不解码任何图集。
- 切换入口在托盘：「Midi 形象」子菜单，单选「Midi · 虎斑 / 咖啡 · 暹罗 / 轮班」（`src/main/tray.ts` 的 `MIDI_SKINS`）。副屏上没有按钮，这是项目从 M4 起的约定：托盘是唯一的设置入口。
- 偏好 `midiSkin` 落在 `~/.agent-monitor/config.json`，合并写；只认三个已知值，写错按默认。默认 `shift`（轮班）。
- 主进程与 mute / typingFollow 同一条路：`{type:'midiSkin'}` 指令，did-finish-load 时补推一次；渲染层收到才开始解码。
- 场景、桌面、灯、键盘、动作时序、夜间与 reduced-motion 规则全部不变。

## 生成流水线

- 三张方向稿 + 图集都用 Codex 内置 image_gen（通过 `generate.sh` 里的 `codex exec` 调用；本机全局 codex 0.147 跑不了配置里的 gpt-6-astra，用的是临时目录里的 0.154）。`codex exec` 在非终端里必须 `</dev/null`，否则会一直等 stdin。
- 方向稿 01 / 03 两次生成都把「暖白底」画成了深棕发光底（02 正常）；猫本身准确，直接用 03 的猫作图集参考，并在提示里声明忽略其背景。图集一次成功：品红底干净，抠透明后四角 alpha 为 0，半透明像素 12541。
- 抠透明用 `~/.codex/skills/.system/imagegen/scripts/remove_chroma_key.py`（auto-key border、soft-matte、12/220、despill），参数与 v2 相同。
- 八个格子实测轮廓框（站姿约 279×295，脚底统一在 y=416 / 896）由 `generate.sh` 的 atlas 阶段打印。

## 验证

- `pnpm test`：533 项通过（含新增：托盘子菜单单选与点击、`midiSkin` 只认已知值、两套图集尺寸与裁切不越格）。
- `pnpm build`：通过；两张图集都进了 out/renderer/assets。
- `MIDI_SKIN=siamese|tabby node_modules/.bin/electron design/midi-cat-v3/verify-runtime.cjs`：各 13 张状态截图（runtime-shots-siamese / runtime-shots-tabby），页面为 F、图集就绪、姿态匹配、右栏不溢出、无页面错误。
- [双形象截图预览](runtime-preview.html)。

## 命名与轮班（2026-09-16 下午）

- 名字只写在 `src/shared/midi-cats.ts`：tabby = Midi，siamese = 咖啡。托盘文案、右栏文案（「咖啡 在等你」「还没连上 咖啡 的耳朵」）都从这里取；页面名仍叫「Midi 打字伴侣」。
- 轮班表也在那里：Midi 白班 08:00–20:00，咖啡晚班 20:00–08:00，只看本机小时；与夜间眯眼（22–05）是两回事。
- 换班编排 `handoverFrame(elapsed)`（`src/renderer/midi.ts`，纯函数，有测试）：0–360 ms 当班的猫抬头（look）；360–1320 ms 向右走出画面 160px；接班的猫提前 120 ms 从画面左侧外（x=−96）走进来，2160 ms 坐回原位，动一下耳朵到 2460 ms 结束。没有走路帧，走位 = 左右爪交替帧 + 2px 起伏 + 4px 网格平移，每 120 ms 一步。两只都画在键盘后面、灯后面，前爪不压键；右栏文案这 2.5 秒是「咖啡 来接班」。
- 触发：动画循环每帧算「该谁当班」，变了就换。只有这页正显示着、没开 reduced-motion、上一只图集已就绪时才走动画；从别的页回来时发现该换了直接换（那次换班发生在看不见的时候，不回放）。托盘手动切换走同一段动画。
- F 页场景正下方居中一粒「换班」胶囊按钮（2026-09-16 追加：菜单栏满时托盘图标会被系统藏掉，换猫得有条不靠托盘的路；先放在右栏底角，被 15% 宽的翻页热区盖住，于是挪到场景下方）。轮班模式下它是临时的：另一只顶到下一个交班点（`nextShiftAt`），再按一下撤销；固定了某一只时它改偏好本身，经新的 `monitor:set-midi-skin` 通道到主进程落盘、重建托盘，再由 command 推回来生效。换班进行中不响应。这是副屏上除翻页外唯一的按钮。
- 分镜：[handover-strip.png](handover-strip.png)（`capture-handover.cjs` 每 300 ms 拍一张）；截图集里新增 handover 一张，断言姿态为 handover、文案以「来接班」结尾。
- 测试 538 项通过；tabby / siamese / shift 三种偏好各 15 张状态截图通过（含 handover 与按钮触发的 swap）。

## 已知取舍

- 方向稿 01 / 03 的深色底是生成器的固执，两次都没能改过来；它们只是设计记录，不影响图集。`-darkbg` 后缀的是第一次生成的版本。
- 生成式像素风位图，不是严格 48×48 手绘像素资产；虎斑那套亦然。
