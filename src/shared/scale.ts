/**
 * 画布宽度与 stage 倍率的换算 —— 横向压缩补偿（M3 附加节）唯一的算术。
 *
 * 主进程（写配置、算默认值）与渲染层（设 CSS 变量）都要这段，所以放 shared：
 * 两边各算一遍就会出现「配置里写着 1.19、屏上是 1.18」这种对不上。
 *
 * 副屏 EDID 原生 960×640，用户在 960×540 @2x 下使用，面板缩放器把画面横向压掉 15.6%。
 * 补法：画布逻辑宽度缩成 round(480 / panelX)，stage 横向乘 2 × panelX。
 *
 * **横向倍率必须是 2 × panelX，不能写成 960 / 403。** 两者数值只差 0.09%，
 * 但含义不同：panelX 是用户拿 design/tools/aspect-test.html 的圆在这块面板上量出来的**物理系数**，
 * 从窗口宽度反推出来的比值会把这个实测值悄悄换掉（画布宽取过整，比值就不再等于量到的那个数）。
 * 代价是 403 × 2.38 = 959.14，比 960 少 0.86 逻辑像素 —— 这一条缝落在最右列，
 * 而 body 的底色与 stage 同为 --canvas，屏上看不出来。要严丝合缝的话该动的是窗口宽度
 * （M4 的活），不是这里的系数。（designer 2026-09-14 明确要求保留实测值。）
 */

export const PANEL_X_MIN = 1.0
export const PANEL_X_MAX = 1.35

export function clampPanelX(v: number): number {
  if (!Number.isFinite(v)) return 1
  // 量化到 0.01：浮点累加会攒出 1.1900000000000004，它会原样写进配置、原样闪在屏角
  return Math.round(Math.min(PANEL_X_MAX, Math.max(PANEL_X_MIN, v)) * 100) / 100
}

/** 480 / 1.19 = 403.36 → 403 */
export function canvasWidthFor(baseWidth: number, panelX: number): number {
  return Math.round(baseWidth / clampPanelX(panelX))
}

export type StageScale = { w: number; h: number; sx: number; sy: number }

/**
 * canvas 是目标显示器 bounds 的一半（960×540 → 480×270；960×640 → 480×320）。
 * 返回画布逻辑尺寸与 stage 的两个倍率；sx / sy 相除即为实际生效的 panelX。
 */
export function scaleFor(canvas: { width: number; height: number }, panelX: number): StageScale {
  const px = clampPanelX(panelX)
  return { w: canvasWidthFor(canvas.width, px), h: canvas.height, sx: 2 * px, sy: 2 }
}
