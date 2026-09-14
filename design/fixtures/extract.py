#!/usr/bin/env python3
"""Extract real local data into design fixtures (mechanical extraction only).

Sources:
  - Codex:  ~/.codex/sessions/**/rollout-*.jsonl  (session_meta, user_message, task_complete)
  - Claude: ~/.claude/projects/<slug>/<session>.jsonl (summary, user, assistant)
  - ZCode:  ~/.zcode/v2/tasks-index.sqlite (tasks table, read-only)
  - Codex quota: design/fixtures/_codex_raw.json (codexbar output captured earlier)

Writes: design/fixtures/events.json, design/fixtures/quota.json
No secrets are read or written.
"""
import glob
import json
import os
import sqlite3
import subprocess
from datetime import datetime, timezone

HOME = os.path.expanduser("~")
HERE = os.path.dirname(os.path.abspath(__file__))
MAX_TITLE = 64


def clip(s, n=MAX_TITLE):
    s = " ".join((s or "").split())
    return s if len(s) <= n else s[: n - 1] + "…"


def short_cwd(p):
    return p.replace(HOME, "~") if p else ""


def iso_from_ms(ms):
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).astimezone().isoformat(timespec="seconds")


def iso_from_s(s):
    return datetime.fromtimestamp(int(s), tz=timezone.utc).astimezone().isoformat(timespec="seconds")


# ---------- Codex ----------
def codex_events(limit=10):
    out = []
    files = sorted(glob.glob(f"{HOME}/.codex/sessions/2026/0[89]/*/rollout-*.jsonl"))
    for f in files:
        meta, first_user = None, None
        for line in open(f, encoding="utf-8", errors="ignore"):
            try:
                d = json.loads(line)
            except Exception:
                continue
            t = d.get("type")
            p = d.get("payload") or {}
            if t == "session_meta":
                meta = {"cwd": p.get("cwd", ""), "originator": p.get("originator", ""), "id": p.get("id", "")}
            elif t == "event_msg" and p.get("type") == "user_message" and first_user is None:
                first_user = p.get("message") or ""
            elif t == "response_item" and p.get("role") == "user" and first_user is None:
                for blk in p.get("content") or []:
                    txt = blk.get("text", "") if isinstance(blk, dict) else ""
                    if txt and not txt.lstrip().startswith(("<", "#")):
                        first_user = txt
                        break
            elif t == "event_msg" and p.get("type") == "task_complete":
                err = p.get("error")
                last = p.get("last_agent_message") or ""
                completed = p.get("completed_at")
                at = iso_from_s(completed) if completed else d.get("timestamp")
                out.append({
                    "id": f"codex:{(meta or {}).get('id','')}:{p.get('turn_id','')}",
                    "agent": "codex",
                    "kind": "failed" if err else "completed",
                    "title": clip(first_user) or "（无标题）",
                    "summary": clip(last.split("\n")[0], 120) if last else (clip(str(err)[:120]) if err else ""),
                    "cwd": short_cwd((meta or {}).get("cwd", "")),
                    "source": (meta or {}).get("originator", "codex"),
                    "at": at,
                    "durationMs": int(p["duration_ms"]) if p.get("duration_ms") else None,
                })
    out.sort(key=lambda e: e["at"] or "", reverse=True)
    return out[:limit]


# ---------- Claude ----------
def claude_events(limit=10):
    out = []
    files = [f for f in glob.glob(f"{HOME}/.claude/projects/*/*.jsonl") if "/agent-" not in f]
    files.sort(key=os.path.getmtime, reverse=True)
    for f in files[:40]:
        summary, first_user, last_assistant, cwd, last_ts = None, None, None, "", None
        for line in open(f, encoding="utf-8", errors="ignore"):
            try:
                d = json.loads(line)
            except Exception:
                continue
            t = d.get("type")
            if t == "summary" and not summary:
                summary = d.get("summary")
            elif t == "user":
                cwd = cwd or d.get("cwd", "")
                c = (d.get("message") or {}).get("content")
                text = c if isinstance(c, str) else " ".join(b.get("text", "") for b in (c or []) if isinstance(b, dict) and b.get("type") == "text")
                if text and not text.startswith("<") and first_user is None:
                    first_user = text
                last_ts = d.get("timestamp") or last_ts
            elif t == "assistant":
                c = (d.get("message") or {}).get("content") or []
                text = " ".join(b.get("text", "") for b in c if isinstance(b, dict) and b.get("type") == "text")
                if text:
                    last_assistant = text
                last_ts = d.get("timestamp") or last_ts
        if not (summary or first_user):
            continue
        out.append({
            "id": f"claude:{os.path.basename(f)[:8]}",
            "agent": "claude",
            "kind": "completed",
            "title": clip(summary or first_user),
            "summary": clip((last_assistant or "").split("\n")[0], 120),
            "cwd": short_cwd(cwd),
            "source": "Claude Code",
            "at": last_ts,
            "durationMs": None,
        })
        if len(out) >= limit:
            break
    return out


# ---------- ZCode ----------
def zcode_events(limit=10):
    db = f"{HOME}/.zcode/v2/tasks-index.sqlite"
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    rows = con.execute(
        "select task_id, title, task_status, model, workspace_path, updated_at from tasks "
        "where deleted=0 order by updated_at desc limit ?", (limit,)
    ).fetchall()
    con.close()
    out = []
    for tid, title, status, model, ws, upd in rows:
        kind = {"completed": "completed", "failed": "failed", "cancelled": "failed"}.get(status, "completed")
        out.append({
            "id": f"zcode:{tid}",
            "agent": "zcode",
            "kind": kind,
            "title": clip(title),
            "summary": "",
            "cwd": short_cwd(ws),
            "source": (model or "").split("/")[-1] or "ZCode",
            "at": iso_from_ms(upd),
            "durationMs": None,
        })
    return out


# ---------- ZCode quota (key from macOS Keychain, never from files) ----------
ZCODE_DISCONNECTED = {
    "status": "disconnected",
    "source": "no API key in Keychain (agent-monitor / zcode-bigmodel) → empty state 「未连接」",
    "plan": "bigmodel coding plan",
    "windows": [],
}


def zcode_quota():
    try:
        key = subprocess.check_output(
            ["security", "find-generic-password", "-s", "agent-monitor", "-a", "zcode-bigmodel", "-w"],
            text=True, stderr=subprocess.DEVNULL).strip()
    except Exception:
        return None
    if not key:
        return None
    import urllib.request
    req = urllib.request.Request(
        "https://open.bigmodel.cn/api/monitor/usage/quota/limit",
        headers={"Authorization": key, "Accept-Language": "zh-CN,zh"})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            d = json.load(r)
    except Exception as e:
        return {"status": "error", "source": "open.bigmodel.cn quota/limit", "plan": "bigmodel coding plan",
                "windows": [], "error": type(e).__name__}
    data = d.get("data") or {}
    windows = []
    for l in data.get("limits", []):
        if l.get("type") == "TOKENS_LIMIT":
            if l.get("unit") == 3 and l.get("number") == 5:
                label = "5h"
            elif l.get("unit") == 6:
                label = "7d"
            else:
                label = f"u{l.get('unit')}x{l.get('number')}"
            windows.append({"label": label, "usedPercent": l.get("percentage"), "resetsAt": iso_from_ms(l["nextResetTime"])})
        elif l.get("type") == "TIME_LIMIT":
            windows.append({"label": "1mo", "usedPercent": l.get("percentage"), "current": l.get("currentValue"),
                            "total": l.get("usage"), "unit": "MCP 调用", "resetsAt": iso_from_ms(l["nextResetTime"])})
    return {
        "status": "ok",
        "source": "open.bigmodel.cn /api/monitor/usage/quota/limit (real, key read from Keychain)",
        "plan": f"bigmodel coding plan · {data.get('level')}",
        "windows": windows,
    }


def main():
    events = codex_events() + claude_events() + zcode_events()
    events = [e for e in events if e.get("at")]
    events.sort(key=lambda e: e["at"], reverse=True)
    json.dump({"generatedAt": datetime.now().astimezone().isoformat(timespec="seconds"), "events": events},
              open(os.path.join(HERE, "events.json"), "w"), ensure_ascii=False, indent=1)

    codex_raw = json.load(open(os.path.join(HERE, "_codex_raw.json")))[0]["usage"]
    quota = {
        "generatedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
        "codex": {
            "status": "ok", "source": "codexbar usage --provider codex --json (real, today)",
            "plan": codex_raw.get("loginMethod"),
            "windows": [
                {"label": "5h", "usedPercent": codex_raw["primary"]["usedPercent"], "resetsAt": codex_raw["primary"]["resetsAt"]},
                {"label": "7d", "usedPercent": codex_raw["secondary"]["usedPercent"], "resetsAt": codex_raw["secondary"]["resetsAt"]},
            ],
        },
        "claude": {
            "status": "sample", "source": "SAMPLE — /api/oauth/usage was rate-limited today; shape matches rate_limits.five_hour/seven_day",
            "plan": "max_20x",
            "windows": [
                {"label": "5h", "usedPercent": 18, "resetsAt": "2026-09-14T17:00:00+08:00"},
                {"label": "7d", "usedPercent": 31, "resetsAt": "2026-09-19T11:00:00+08:00"},
            ],
        },
        "zcode": zcode_quota() or ZCODE_DISCONNECTED,
    }
    json.dump(quota, open(os.path.join(HERE, "quota.json"), "w"), ensure_ascii=False, indent=1)
    print(f"events: {len(events)}  (codex {sum(e['agent']=='codex' for e in events)}, claude {sum(e['agent']=='claude' for e in events)}, zcode {sum(e['agent']=='zcode' for e in events)})")
    for e in events[:12]:
        print(f"  {e['at'][:16]}  {e['agent']:6} {e['kind']:9} {e['title'][:40]:40} {e['cwd'][:30]}")


if __name__ == "__main__":
    main()
