#!/bin/bash
# Agent Monitor · Claude Code hook 本体。
#
# Claude 在 UserPromptSubmit / Stop / Notification / SessionEnd 时会把一份 JSON 从 stdin
# 喂给这个脚本。它唯一的事情是把那份 JSON 原样 POST 给面板的回环端口。
#
# 三条纪律（PLAN §6「hooks 拖慢 Claude Code」）：
#   1. **全异步**：curl 扔进后台，脚本立刻返回；Claude 不会因为面板没开而卡住。
#   2. **失败静默**：面板没在跑、端口换了、curl 不在 —— 全部丢进 /dev/null。
#   3. **退出码恒 0**：非零退出码会被 Claude 当成 hook 失败并在会话里报错。
#
# token 是为了挡住本机其它进程伪造事件（回环端口对所有本地进程都是开的）。
# 它只在这里被读一次、只放进 Header，不进日志、不进任何输出。

PORT="${MONITOR_HOOK_PORT:-47831}"
TOKEN_FILE="${MONITOR_HOOK_TOKEN_FILE:-$HOME/.agent-monitor/hook-token}"

# 没有 token 文件 = 面板还没跑过第一次，没什么可发的
[ -r "$TOKEN_FILE" ] || exit 0
TOKEN=$(cat "$TOKEN_FILE" 2>/dev/null | tr -d '\n\r')
[ -n "$TOKEN" ] || exit 0

command -v curl >/dev/null 2>&1 || exit 0

# stdin 只读一次：管道读完就没了，所以先落进变量再交给后台的 curl
BODY=$(cat)
[ -n "$BODY" ] || exit 0

# --noproxy '*'：本机装了 http_proxy 时，curl 会把回环地址也交给代理，
# 于是这份 payload（含 cwd / session_id）会被送去一个第三方进程。回环请求永远直连。
printf '%s' "$BODY" | curl -s -m 3 --noproxy '*' -X POST \
  "http://127.0.0.1:${PORT}/hook" \
  -H 'Content-Type: application/json' \
  -H "X-Monitor-Token: ${TOKEN}" \
  --data-binary @- >/dev/null 2>&1 &

exit 0
