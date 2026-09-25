#!/usr/bin/env bash
# Midi 暹罗猫形象：用 Codex 内置 image_gen 重跑整条生成流水线。
#   用法：design/midi-cat-v3/generate.sh <猫照片路径> [sheets|atlas|all]
#   产物：本目录下 01/02/03 方向稿、06-pocket-actions-key.png（品红底）、
#         06-pocket-actions.png（已抠透明，可复制到 src/renderer/assets/midi-siamese.png）。
# 前提：codex ≥ 0.154（配置里的 gpt-6-astra 需要新版本）；ChatGPT 账号有 image_gen 额度。
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REF="${1:?需要猫照片路径}"
STAGE="${2:-all}"
CODEX="${CODEX:-codex}"
CHROMA="$HOME/.codex/skills/.system/imagegen/scripts/remove_chroma_key.py"

prompt_block() { # $1 = prompts.md 里的标题片段
  awk -v key="$1" '
    $0 ~ "^## " && index($0, key) { grab = 1; next }
    grab && /^```text/ { code = 1; next }
    grab && code && /^```/ { exit }
    grab && code { print }
  ' "$HERE/prompts.md"
}
shared() { prompt_block "Shared identity block"; }

run_codex() { # $1 = 输出文件名, $2 = 提示词, 其余 = -i 参考图
  local out="$1" prompt="$2"; shift 2
  local args=()
  for img in "$@"; do args+=(-i "$img"); done
  "$CODEX" exec </dev/null -s workspace-write --skip-git-repo-check -C "$HERE" "${args[@]}" \
    -o "$HERE/.last-$out.txt" \
    "Task: use the built-in image_gen tool exactly once to generate ONE landscape image. Attached images are references, not edit targets. Use this generation prompt verbatim:

$prompt

After generation, copy the generated PNG file to ./$out.png. Do not modify any other file. Reply with only the final absolute path."
  test -s "$HERE/$out.png" || { echo "未生成 $out.png，见 .last-$out.txt"; exit 1; }
}

if [[ "$STAGE" == sheets || "$STAGE" == all ]]; then
  for n in 01-round-companion 02-photo-faithful 03-pocket-retro; do
    run_codex "$n" "$(shared)
$(prompt_block "$n")" "$REF"
  done
fi

if [[ "$STAGE" == atlas || "$STAGE" == all ]]; then
  run_codex 06-pocket-actions-key "$(prompt_block 06-pocket-actions-key)" "$HERE/03-pocket-retro.png" "$REF"
  python3 "$CHROMA" --input "$HERE/06-pocket-actions-key.png" --out "$HERE/06-pocket-actions.png" \
    --auto-key border --soft-matte --transparent-threshold 12 --opaque-threshold 220 --despill --force
  python3 - "$HERE/06-pocket-actions.png" <<'PY'
import sys; from PIL import Image
im = Image.open(sys.argv[1]); a = im.split()[-1]
assert im.size == (1536, 1024) and im.mode == 'RGBA', im.size
for r in range(2):
    for c in range(4):
        bb = a.crop((c*384, r*512, (c+1)*384, (r+1)*512)).getbbox()
        print(f'cell r{r}c{c} bbox x={bb[0]+c*384} y={bb[1]+r*512} w={bb[2]-bb[0]} h={bb[3]-bb[1]}')
PY
fi
