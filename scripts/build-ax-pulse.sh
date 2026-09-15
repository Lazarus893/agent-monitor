#!/bin/bash
# 编 F 页心跳层的 AX 监听子进程（helpers/ax-pulse/main.swift → build/ax-pulse）。
#
#   pnpm build:helper
#
# 单文件、无依赖，所以不需要 SwiftPM 的一整套目录 —— swiftc 直接出可执行文件。
# build/ 下的图标是要提交的，这个二进制不是（见 .gitignore）。
# 打包时由 electron-builder 的 extraResources 落到 Contents/Resources/ax-pulse。

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/helpers/ax-pulse/main.swift"
OUT="$ROOT/build/ax-pulse"

# 编不出来不是 `pnpm build` 失败。ax-pulse 只在 macOS 上有意义，而它缺席时
# 运行时本来就有一条正经的路：collector 找不到二进制 → status=offline，
# F 页画「还没连上 Midi 的耳朵」。CI / Linux 上为这个断掉整个构建，
# 换来的只是「在一台永远跑不起这个子进程的机器上没编一个跑不起来的子进程」。
# 但在 darwin 且 swiftc 就在手边时，编译报错是真的错，照样 exit 1。
if [ "$(uname -s)" != "Darwin" ]; then
  echo "跳过 ax-pulse：不是 macOS（F 页的心跳层会按 offline 画）" >&2
  exit 0
fi
if ! command -v swiftc >/dev/null 2>&1; then
  echo "跳过 ax-pulse：没有 swiftc（装一下 Xcode Command Line Tools：xcode-select --install）" >&2
  exit 0
fi

mkdir -p "$ROOT/build"
swiftc -O -o "$OUT" "$SRC"
echo "ax-pulse → $OUT"
