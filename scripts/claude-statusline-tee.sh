#!/usr/bin/env bash
# 给 Claude Code 的 statusline 包一层：把它每秒喂进来的那份 JSON 里**只有额度那两个字段**
# 落到 ~/.agent-monitor/claude-ratelimits.json，再原样交给原来的 statusline 命令。
#
#   用法：claude-statusline-tee.sh -- <原来的 statusline 命令...>
#   安装脚本装出来的形态是：
#         bash <tee> -- /bin/sh -c '<原来那条命令串>'
#   —— 原命令整条交回给 shell，`FOO=1 cmd`、管道、引号因此都保真。
#
# 三条硬要求：
#   1. stdout 一字不差 —— 这一层只旁路，不打印任何东西；
#      （转交给原命令的 stdin 会被命令替换吃掉结尾换行 —— 原命令自己也是 `input=$(cat)`，
#       JSON 文档的结尾换行本来就不表意，coralline 的可见输出逐字节相同，由测试钉住。）
#   2. 写文件失败（磁盘满、目录只读、没有 jq）绝不能影响原命令，整段包在子 shell + || : 里；
#   3. 退出码就是原命令的退出码。
#
# 只落 rate_limits 与 model.display_name（复核 P1-③）：statusline 的原始 JSON 里还有
# cwd、transcript_path、session_id、cost —— 采集侧一个都不需要，而这个文件每秒被重写一次，
# 不该把每个会话的工程路径与 session id 摊在磁盘上。裁剪用 jq（coralline 本来就依赖 jq）；
# 没有 jq 就**什么都不写**，绝不退回去写整份 payload。
# 目录 0700、文件 0600：umask 放在子 shell 里，不会漏给原命令。
set -u

dir="${AGENT_MONITOR_DIR:-$HOME/.agent-monitor}"
out="$dir/claude-ratelimits.json"

input=$(cat)

case "$input" in
  '{'*)
    (
      umask 077
      command -v jq >/dev/null 2>&1 || exit 0
      payload=$(printf '%s' "$input" | jq -c '{
        rate_limits: (.rate_limits // null),
        model: {display_name: (.model.display_name // null)}
      }' 2>/dev/null) || exit 0
      case "$payload" in '{'*) ;; *) exit 0 ;; esac

      ts=$(date +%Y-%m-%dT%H:%M:%S%z)   # 2026-09-14T18:45:00+0800
      ts="${ts%??}:${ts: -2}"           # → 2026-09-14T18:45:00+08:00

      mkdir -p "$dir" || exit 0
      chmod 700 "$dir" 2>/dev/null || :  # 早先以 0755 建出来的目录也一并收紧
      tmp="$out.tmp.$$"                  # 每秒一次、多会话并发：PID 后缀 + mv 原子替换
      printf '{"writtenAt":"%s","payload":%s}\n' "$ts" "$payload" > "$tmp" || { rm -f "$tmp"; exit 0; }
      chmod 600 "$tmp" 2>/dev/null || :  # mv 之前就收紧，不留 0644 的可见窗口
      mv -f "$tmp" "$out" || rm -f "$tmp"
    ) >/dev/null 2>&1 || :
    ;;
esac

if [ "${1-}" = "--" ]; then shift; fi
if [ "$#" -eq 0 ]; then
  # 没给原命令：当成纯 tee 用（自检脚本会走这一支）
  printf '%s' "$input"
  exit 0
fi

printf '%s' "$input" | "$@"
