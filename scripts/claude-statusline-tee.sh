#!/usr/bin/env bash
# 给 Claude Code 的 statusline 包一层：把它每秒喂进来的那份 JSON 里**只有额度那两个字段**
# 按会话落到 ~/.agent-monitor/claude-ratelimits/<session_id>.json（采集侧合并多个会话），
# 再原样交给原来的 statusline 命令。
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
# 只落 rate_limits 与 model.display_name：statusline 的原始 JSON 里还有
# cwd、transcript_path、cost —— 采集侧一个都不需要，而这个文件每秒被重写一次，
# 不该把每个会话的工程路径摊在磁盘上。裁剪用 jq（coralline 本来就依赖 jq）；
# 没有 jq 就**什么都不写**，绝不退回去写整份 payload。
# 目录 0700、文件 0600：umask 放在子 shell 里，不会漏给原命令。
#
# **按会话分文件**（2026-09-15 实机 P1）：原来所有会话写同一个
# claude-ratelimits.json，而用户同时开着几十个 Claude Code 会话，它们每秒轮流覆盖
# 同一份文件——有的会话给 `{five_hour:5, seven_day:26}`，有的只给 `{seven_day:22}`
# （5h 窗无使用记录时 Claude Code 会整个省掉这个键）。采集每 15 s 读到哪份算哪份，
# 于是面板上的 5h 时不时掉成 0%（实测日志 744 次里 136 次 `5h=absent`）。
# 现在落到 claude-ratelimits/<session_id>.json，各写各的，由采集侧按键合并。
#
# 这里**把 session_id 写进了文件名**——它是上面那条「不摊 session id」的有意反转：
# 没有它就分不开写入者，而这个 id 是个 uuid，不像 cwd 那样泄露工程结构，
# 目录仍是 0700。cwd 与 transcript_path 照旧一个字都不落盘。
# 老的单文件形态已经删干净：没有任何分支再写它，采集侧见到那个路径会顺手删掉。
set -u

dir="${AGENT_MONITOR_DIR:-$HOME/.agent-monitor}"
sessions="$dir/claude-ratelimits"

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

      # 会话 id 决定写哪一份。它来自 JSON，所以只接受安全字符并限长——
      # 里面要是有 `/` 或 `..`，拼出来的就是目录外的路径。不合规就当作没拿到（见下）。
      sid=$(printf '%s' "$input" | jq -r '.session_id // empty' 2>/dev/null)
      case "$sid" in
        *[!A-Za-z0-9._-]* | '' ) sid='' ;;   # 只收安全字符
        .* ) sid='' ;;                        # `.` / `..` / 隐藏名：点号在允许集里，要单独挡
        *) [ "${#sid}" -le 64 ] || sid='' ;;  # 限长
      esac

      # 拿不到 / 不合规的 session_id 也照样一个写入者一份：退回去共写一个单文件的话，
      # 几十个无 sid 会话又会每秒互相覆盖 —— 那正是这次要修的 bug。
      # $PPID（Claude Code 那个进程）在同一个会话里是稳的；$$ 每秒都换，会撑爆目录。
      [ -n "$sid" ] || sid="nosid-$PPID"

      mkdir -p "$sessions" || exit 0
      chmod 700 "$dir" 2>/dev/null || :       # 早先以 0755 建出来的目录也一并收紧
      chmod 700 "$sessions" 2>/dev/null || :
      out="$sessions/$sid.json"
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
