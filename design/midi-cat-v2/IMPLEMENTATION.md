# Midi · 方案 3 已接入

> 2026-09-16：图集文件改名为 midi-tabby.png，作为「虎斑」形象与新的暹罗形象并存（默认暹罗），见 [v3](../midi-cat-v3/IMPLEMENTATION.md)。

2026-09-15：用户最终改选 03 / POCKET MIDI，替代此前的方案 1 倾向。

## 实现

- 正式资产：src/renderer/assets/midi-tabby.png，1536×1024 RGBA 图集。
- 8 个姿态：idle / typeL / typeR / look / blink / night / sleep / ear。
- 源裁切与固定落点：src/renderer/midi-sprites.ts；每帧脚底固定在猫框 y=92。
- src/renderer/midi-cat.ts 解码一次，生成八张 96×96 缓存；之后每帧只复制缓存，关闭图像平滑。
- 场景仍为 224×128，右栏仍为 151；猫框 (80,8)，桌面 y=104，键盘 (88,94)。前爪二次绘制到键帽上。
- 沿用输入、4 秒抬头、5 分钟睡眠、夜间、500 字小跳规则。偶发轻动耳朵；眨眼窗口 220ms；无输入时也能眨眼。
- reduced-motion 保留状态变化，关闭眨眼、耳动、身体位移和小跳。不可见时停止动画循环，空闲仍为 8 Hz。

这是生成式像素风位图，不声称是严格 48×48 的手工像素资产。猫框在 960×540 输出缓冲区约为 228×192；1.19 的横向预拉伸仍由面板硬件压回。

## 来源和复现

设计参考：03-pocket-retro.png。
图集由内置 image_gen 制作；06-pocket-actions-key.png 为原始品红背景图。
透明处理使用系统 imagegen 技能的 remove_chroma_key.py（auto-key border、soft-matte、12/220 阈值、despill）。
此前方案 1 的文件仅保留为设计历史，没有被正式程序引用。旧 design/midi-prototype.html 是历史原型，不再是猫帧的真源。

## 验证

- pnpm build / pnpm package：通过；使用本机稳定证书签名。
- pnpm test：526 项通过。
- 13 种正式页面状态截图检查通过（含眨眼、耳动、长数字、减少动态效果和连接异常）。
- 已安装到 ~/Applications/Agent Monitor.app 并重新启动；旧版保留为带时间戳的 .bak 备份。启动日志确认 TYPE-C 副屏 960×540 全屏落位，typing status ok。
- 使用实际构建出的 out/renderer/index.html，通过沙箱 preload 注入示例状态，检查本地图片可加载、页面为 F、状态帧匹配、右栏无横向溢出、无页面错误。
- 运行 node_modules/.bin/electron design/midi-cat-v2/verify-runtime.cjs 可复现 runtime-shots 截图及 checks.json。不会启动生产采集器或改动用户统计。

[查看正式页面截图](runtime-preview.html)

## 最终图集提示词

```text
Create a game animation sprite atlas based EXACTLY on the selected "03 / POCKET MIDI" reference design, especially its smaller IDLE and TYPE poses, not a taller realistic cat. Compact cute chunky silver tabby with large broad head, short sturdy body and legs, greenish-yellow eyes black pupils, M forehead mark, dark chest rings, pale muzzle and paws, thick upright black-ringed tail to viewer LEFT. Must retain charming pocket proportions from reference and clearly visible upright tail; gray silver NOT orange. Simple flat limited-palette pixel art, crisp large square pixel clusters, no fur noise, no gradient, no dithering, no blur.
Canvas EXACTLY 1536x1024, landscape. EXACTLY 4 COLUMNS and 2 ROWS, uniform cells 384x512, one isolated cat in each. No text/labels/grid/keyboard/props/shadows. Entire background perfectly uniform #FF00FF magenta for removal. Each cat must stay completely INSIDE its cell with 40px left and right gutters (never touch boundaries). Same scale and same baseline in each cell. No overlap between cells. For ALL first six poses keep identical body, tail, head proportions, ear positions and markings, changing only specified feature. Front cat viewed very slightly from above like reference.
Top row left to right:
1 idle, compact attentive cat, two front paws resting at baseline and upright ringed tail.
2 typing viewer-left paw slightly lifted and forward, right paw grounded; BOTH paws visible and attached; head body tail unchanged.
3 typing viewer-right paw slightly lifted and forward, left paw grounded; BOTH paws visible and attached; head body tail unchanged.
4 looking up, chin lifted a little and pupils looking upward, body and raised tail unchanged.
Bottom row left to right:
5 blinking: EXACT same as idle with only eyes closed into curved slits.
6 sleepy half-closed eyes: EXACT same as idle with only upper eyelids lowered.
7 sleeping: same cat curled into low horizontal shape head resting on paws eyes closed, ringed tail wrapped along back/body. Keep same head scale, same baseline, more blank magenta above.
8 ear twitch: EXACT same as idle with only one ear angled slightly.
These are animation frames of ONE CAT. Keep silhouette stable in typing/blink/night to avoid jitter. Exaggerate paw change enough to read on tiny screen but do not wave above chin. Simple adorable pixel-game art like selected reference.
```
