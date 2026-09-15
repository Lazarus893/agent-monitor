#!/bin/bash
# 把打好的 app 复制到 ~/Applications（简报 §3）。
#
#   pnpm install:app
#
# 用 ditto 而不是 cp -R：ditto 保留扩展属性与符号链接，签名不会因为复制而失效。
# 覆盖之前把旧版备份成 "Agent Monitor.app.bak-<时间戳>"，装坏了能退回去；
# 只留最近 2 份备份，免得 ~/Applications 里越堆越多。
#
# 这个脚本**不**动 ~/.claude/settings.json，也不写任何配置 —— 它只搬一个 .app。

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/dist/mac-arm64/Agent Monitor.app"
DEST_DIR="$HOME/Applications"
DEST="$DEST_DIR/Agent Monitor.app"
KEEP_BACKUPS=2

if [ ! -d "$SRC" ]; then
  echo "找不到 $SRC" >&2
  echo "先跑 pnpm package。" >&2
  exit 1
fi

mkdir -p "$DEST_DIR"

# 正在跑的那个实例先退掉，否则 ditto 会往一个被占用的 bundle 里写
if pgrep -f "$DEST/Contents/MacOS/Agent Monitor" >/dev/null 2>&1; then
  echo "正在运行的 Agent Monitor 已退出，装完请重新打开。"
  pkill -f "$DEST/Contents/MacOS/Agent Monitor" || true
  sleep 1
fi

if [ -d "$DEST" ]; then
  BAK="$DEST.bak-$(date +%Y%m%d-%H%M%S)"
  mv "$DEST" "$BAK"
  echo "旧版备份到：$BAK"
  # 只留最近 KEEP_BACKUPS 份
  ls -dt "$DEST_DIR/Agent Monitor.app.bak-"* 2>/dev/null \
    | tail -n +$((KEEP_BACKUPS + 1)) \
    | while IFS= read -r old; do rm -rf "$old"; echo "清掉旧备份：$old"; done
fi

ditto "$SRC" "$DEST"
echo "已安装：$DEST"

# 签名自检：签名坏掉的话这里就会报，不要等到双击时才发现（证书签或 ad-hoc 都走这一行）
if codesign --verify --deep --strict "$DEST" 2>/dev/null; then
  echo "签名校验通过。"
else
  echo "警告：签名校验没过，首次启动可能被 Gatekeeper 拦下。" >&2
  echo "按 README「首次启动」一节处理：xattr -cr \"$DEST\"" >&2
fi
