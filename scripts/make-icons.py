#!/usr/bin/env python3
"""生成托盘模板图与 app 图标（简报 §1 / §3）。

    python3 scripts/make-icons.py

产物（都进仓库，打包时直接用，平时不需要再跑这个脚本）：

    build/trayTemplate.png      16×16   托盘，黑色 + alpha，macOS 按菜单栏明暗自动反色
    build/trayTemplate@2x.png   32×32   同上
    build/icon.icns             app 图标，深色圆角底 + 同一套 monoline 图形

图形：三根等宽圆头竖条，高度不同 —— 就是面板 A 页那三块额度。monoline、1.6px 描边
（按 16 单位的画布计），放大到 1024 仍然是同一份几何，不另画一版。

托盘图必须是**纯黑 + alpha** 并命名成 `...Template.png`：macOS 只看 alpha 通道，
深色菜单栏下自动反成白色。给它上颜色会被吃掉，还会在浅色菜单栏下糊成一团。

依赖 Pillow（本机 12.2）。它只在**重新生成图标**时需要，跑 app / 打包都不需要。
"""

from pathlib import Path
import subprocess
import sys
import tempfile

try:
    from PIL import Image, ImageDraw
except ImportError:  # pragma: no cover
    sys.exit("需要 Pillow：pip3 install Pillow")

ROOT = Path(__file__).resolve().parent.parent
BUILD = ROOT / "build"

# --- 16 单位画布上的几何（唯一的真源） ---------------------------------------
UNIT = 16.0
STROKE = 1.6                      # 简报指定的描边宽度
BARS = [                          # (中心 x, 顶端 y, 底端 y)，端点是圆头的圆心
    (2.8, 7.5, 13.8),             # 圆头会再往外各鼓出 STROKE/2，
    (8.0, 2.2, 13.8),             # 所以实际占到 x 2.0–14.0、y 1.4–14.6，
    (13.2, 5.1, 13.8),            # 16×16 的框里留 1.4 单位余白
]
# macOS 应用图标的圆角方块：占画布 82%，圆角半径为方块边长的 22.37%
ICON_INSET = 0.09
ICON_RADIUS = 0.2237
ICON_BG = (13, 13, 13, 255)       # --surface
ICON_EDGE = (36, 39, 40, 255)     # --hairline
ICON_INK = (244, 244, 246, 255)   # --ink

SS = 8                            # 超采样倍数：先画 8 倍再降采样，圆头才不毛糙


def draw_bars(d: "ImageDraw.ImageDraw", size: float, color, ox=0.0, oy=0.0, scale=1.0):
    """把三根竖条画到当前画布上。size 是 16 单位对应的像素数。"""
    k = size / UNIT * scale
    w = STROKE * k
    for cx, top, bot in BARS:
        x = ox + cx * k
        y0, y1 = oy + top * k, oy + bot * k
        d.rounded_rectangle(
            [x - w / 2, y0 - w / 2, x + w / 2, y1 + w / 2],
            radius=w / 2, fill=color,
        )


def tray(px: int) -> "Image.Image":
    """托盘模板图：纯黑 + alpha。"""
    big = Image.new("RGBA", (px * SS, px * SS), (0, 0, 0, 0))
    draw_bars(ImageDraw.Draw(big), px * SS, (0, 0, 0, 255))
    return big.resize((px, px), Image.LANCZOS)


def app_icon(px: int) -> "Image.Image":
    """app 图标：深色圆角底 + 一圈 hairline + 同一份图形。"""
    s = px * SS
    big = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(big)
    inset = s * ICON_INSET
    side = s - inset * 2
    r = side * ICON_RADIUS
    edge = max(1.0, s * 0.004)
    d.rounded_rectangle([inset, inset, s - inset, s - inset], radius=r,
                        fill=ICON_BG, outline=ICON_EDGE, width=int(round(edge)))
    # 图形占方块的 46%，居中
    g = side * 0.46
    draw_bars(d, g, ICON_INK, ox=(s - g) / 2, oy=(s - g) / 2)
    return big.resize((px, px), Image.LANCZOS)


def main() -> None:
    BUILD.mkdir(parents=True, exist_ok=True)
    tray(16).save(BUILD / "trayTemplate.png")
    tray(32).save(BUILD / "trayTemplate@2x.png")
    print(f"写出 {BUILD/'trayTemplate.png'} 与 @2x")

    with tempfile.TemporaryDirectory() as tmp:
        iconset = Path(tmp) / "icon.iconset"
        iconset.mkdir()
        for base in (16, 32, 128, 256, 512):
            app_icon(base).save(iconset / f"icon_{base}x{base}.png")
            app_icon(base * 2).save(iconset / f"icon_{base}x{base}@2x.png")
        out = BUILD / "icon.icns"
        subprocess.run(["iconutil", "-c", "icns", str(iconset), "-o", str(out)], check=True)
        print(f"写出 {out}")


if __name__ == "__main__":
    main()
