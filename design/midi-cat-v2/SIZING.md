# 方案 1 · 副屏尺寸结论

用户倾向方案 1。建议 96×96 的猫布局框，保留左场景 224×128 和右栏 151 的布局。

## 尺寸账

| 部分 | 排版坐标尺寸 | 960×540 输出缓冲区约占用 |
|---|---|---|
| 全页 | 403×270 | 959×540 |
| 左场景 | 224×128 | 533×256 |
| 场景与右栏间隔 | 12 | 29 |
| 右栏 | 151 | 359 |
| 现有猫框 | 64×56 | 152×112 |
| 推荐猫框 | 96×96 | 228×192 |

来源：src/shared/scale.ts、src/renderer/app.css 和 src/renderer/app.ts。横向倍率 2×1.19，纵向倍率 2；1.19 是项目已保存的面板形变补偿。以上输出尺寸不等同于面板原生像素数或实物厘米数；本轮没有重新测量显示器。

排版宽度：左右外边距 8+8；224+12+151=387；387+16=403。96×96 猫框占全页宽约 24%、高约 36%，含图片透明留白。

## 推荐布局与动作边界

- 猫框：(80,8)，尺寸 96×96；实际轮廓在框内。
- 桌面从 y=92 下移到 y=104；场景仍高 128，下方剩 24。
- 灯在 (12,48)，底部对齐新桌面；键盘在 (80,100)。最终打字帧应把爪端放在键帽上。
- 小跳向上 8：框顶到 0，仍在场景内。
- 预留动作包围框 x=72–192、y=0–112，宽 120、高 112；尾摆与睡觉帧也需遵守。
- 112×112 如果维持脚底 y=104，框顶为 -8，失去跳跃余量；不推荐原位加大。

## 视觉取舍

保留方案 1 的宽脸、黄绿眼、M 纹、胸环和环尾。小屏应减少细毛与碎点，增加虹膜/瞳孔和银灰/黑环对比。

04-round-small.png 是使用内置 image_gen 对 01 制作的小屏简化预览，随后按技能脚本去除品红背景；四角 alpha 均为 0。它仍是高分辨率像素风概念图，不是严格 48×48 源像素成品。正式 sprite 建议 48×48 网格 ×2，固定脸型与花纹逐帧绘制。无需因旧版使用 ×4 而继续限制新版源网格为 16×14。

## 预览与验证

打开 [尺寸预览](size-preview.html) 可切换旧猫 / 推荐 96 / 112，以及两种显示模式：

- 物理比例示意：806×540，403×270 等比放大 2 倍。用来在普通显示器上判断外形比例；不是副屏实拍。
- 输出缓冲区：960×540，包含横向 1.19 预拉伸；在普通显示器上看会略宽，副屏硬件压缩后才恢复形状。

截图：[推荐比例示意](size-96-physical.png)、[旧版比例示意](size-old-physical.png)、[推荐输出缓冲区](size-96-buffer.png)。截图文件带系统 DPR 2，与 CSS 视口尺寸区分。

已用 Electron 加载实际项目样式和生成图，检查推荐尺寸加载成功、右栏无横向溢出，猫框处于场景内。用 capture-sizing.cjs 可重跑三张截图。预览统计数字是固定样例。本轮未更改正式应用，也未对连接的副屏做实机观感确认。

## 本次 image_gen 提示词

```text
Edit/reference image: use ONLY the seated FRONT cat at upper left of the supplied ROUND COMPANION design sheet. Create a single isolated front-facing seated silver tabby game sprite, retaining that exact appealing broad round adult face, sturdy body, relatively small upright pink-lined ears, olive-yellow green irises with black pupils, forehead M, dark cheek marks, 2 or 3 bold dark chest necklace bands, pale muzzle, small pale front paw ends, ringed tail curled beside its left haunch. Simplify it specifically for a tiny desktop display: disciplined chunky square pixel clusters, approximately 48x48 source-grid vocabulary, very limited 8 colors, no individual fur hairs, no dithering, no painterly shaded texture, no gradients, no whisker hairlines. Face and eyes must be legible at a rendered 96x96 CSS size. Full body including paws and curled tail visible, centered, silhouette takes 88 percent canvas height and 78 percent width; face broad and serious-cute like reference. No keyboard, no props, no text, no ground, no shadow. Background perfectly flat uniform solid #FF00FF for chroma key removal, none of that magenta on cat. Crisp block pixel edges. Square canvas. This is a small-display simplification of selected concept 01, not a new cat design.
```

