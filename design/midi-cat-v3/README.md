# Midi · 小猫形象 v3（暹罗猫）

> 状态（2026-09-16）：全套已生成并接入正式程序；暹罗猫命名「咖啡」，与 Midi 轮班，见 [实现与验证](IMPLEMENTATION.md)。下文为设计记录。

参考：用户在 2026-09-15 提供的第二张自家猫照片（海豹重点色暹罗猫，坐在门口）。照片不入库；生成时通过命令行参数传入。
设计思路沿用 [v2](../midi-cat-v2/README.md)：三个方向稿 → 选一个 → 出 8 姿态图集（品红底）→ 抠透明 → 接入 96×96 猫框。

## 照片里的识别锚点

| 部位 | 照片确认 | 像素稿里怎么保 |
|---|---|---|
| 体型 | 结实敦实的成年猫，传统苹果头，不是细长楔脸的现代展赛型 | 宽圆头、短粗身、坐姿前爪并拢 |
| 面罩 | 深海豹棕，盖住双眼、鼻梁、口鼻和下巴；面罩与耳朵之间有一圈浅驼色 | 面罩是最大识别块，但不能糊成一整块黑；留出浅色额带 |
| 眼睛 | 冰蓝色、瞳孔深色、睁得很圆 | 蓝色是全套里唯一的冷色，必须给独立色阶 |
| 鼻子 | 黑色小鼻 | 面罩内 1–2 格更深的点 |
| 耳朵 | 大、深棕、内侧浅色 | 深棕外轮廓 + 浅粉/驼色内耳 |
| 胸口 | 奶白色大片胸毛，和身体的驼色有明显分界 | 胸围是第二识别块，用独立的米白色 |
| 身体 | 暖驼色，背部与体侧略深 | 两档驼色即可，不加毛发噪点 |
| 四肢与爪 | 深海豹棕，爪端近黑 | 打字帧里深色爪子压在灰键帽上对比最强 |
| 尾巴 | 粗、深海豹棕、无环纹 | 竖起在画面左侧（沿用 v2 的构图），纯深色 |

与 v2 银虎斑相比，删除的锚点：额头 M 纹、颊侧黑纹、胸环、身体回旋纹、环尾。
新增的锚点：面罩、浅色额带、蓝眼、奶白胸围、深色四肢。
调色板：近黑海豹棕、深巧克力棕、暖中棕、驼色、奶油色、米白、哑粉、冰蓝（8 色）。

## 三个方向

- [01 圆脸桌面伴侣](01-round-companion.png)：坐姿、宽脸，32×32 像素语言。
- [02 原照比例](02-photo-faithful.png)：照片坐姿 + 走动帧，48×48 像素语言；唯一一张按要求画在暖白底上的。
- [03 复古小比例](03-pocket-retro.png)：24×24 像素语言；沿用 v2 的选择，图集以它为参考。

01 和 03 两次生成都被画成深棕发光底（提示词已明确要求暖白底、无光晕），猫本身准确；`-darkbg` 后缀是第一次生成的版本。
图集：[品红底原图](06-pocket-actions-key.png) → [抠透明](06-pocket-actions.png)。

## 动作设计与落地节奏

动作表与 v2 完全一致（待机、慢眨眼、左右爪打字、抬头、尾尖摆动、耳朵轻动、趴下睡、伸懒腰、小跳、走动），见 [v2 README](../midi-cat-v2/README.md#动作设计与落地节奏)。
图集布局也不变：1536×1024、4 列 2 行、每格 384×512，顺序 idle / typeL / typeR / look / blink / night / sleep / ear。
这样运行时只需换图片和裁切矩形，`midi-cat.ts` 的解码与缓存逻辑不动。

## 生成与接入步骤（可复现）

```bash
# 1. 三张方向稿（需要 codex ≥ 0.154 且 image_gen 有额度）
design/midi-cat-v3/generate.sh /path/to/siamese.jpg sheets
# 2. 审图后出图集并抠透明；脚本末尾会打印 8 个格子的实际轮廓框
design/midi-cat-v3/generate.sh /path/to/siamese.jpg atlas
```

接入：把 `06-pocket-actions.png` 复制为 `src/renderer/assets/midi-siamese.png`，
在 `src/renderer/midi-sprites.ts` 里按打印出的轮廓框更新 8 个 `source` 矩形（v2 的 upright 统一取 284×336，脚底对齐 y=92），
`midi-cat.ts` 的图片路径改名，`tests/midi.test.ts` 的图集文件名同步；
然后 `pnpm test`、`pnpm build`，再用 `node_modules/.bin/electron design/midi-cat-v2/verify-runtime.cjs` 出 13 张状态截图复核。

如果不想等 Codex 额度：`~/.claude/skills/nano-banana-pro`（Gemini，需 `GEMINI_API_KEY`）或
`~/.claude/skills/openai-image-gen`（需 `OPENAI_API_KEY`）都能跑同一份 [prompts.md](prompts.md)，只是要手动传参考图。
