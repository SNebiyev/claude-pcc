#!/usr/bin/env python3
"""PCC cost line: agents, tokens and wall time of the subagents of a batch.
Run: python3 -I scripts/pcc-cost.py --project-dir ~/.claude/projects/<key> --since <ISO> [--until <ISO>] [--session <id>]
Tokens = per assistant message input + cache_creation + output (cache reads excluded)."""
import argparse, json, re, statistics
from datetime import datetime, timezone
from pathlib import Path

CLASSES = [  # first match wins
    ("review", re.compile(r"review|audit|security|refute|simplif|correctness|verify|skeptic|fix-check", re.I)),
    ("fix", re.compile(r"fix|implement|patch", re.I)),
    ("lanes", re.compile(r"pcc|lane|e2e|playwright|sweep|flake", re.I)),
]

def ts(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(timezone.utc)

def classify(desc, path):
    if not desc and "/workflows/" in path:
        return "review"
    for name, rx in CLASSES:
        if rx.search(desc or ""):
            return name
    return "other"

def read_agent(p):
    first = last = None; tokens = 0; floor = None; seen = set()
    for line in p.open(errors="replace"):
        try:
            d = json.loads(line)
        except ValueError:
            continue
        t = d.get("timestamp")
        if t:
            first = first or t; last = t
        m = d.get("message") if d.get("type") == "assistant" else None
        u = m.get("usage") if isinstance(m, dict) else None
        if not u:
            continue
        key = m.get("id") or d.get("uuid")
        if key in seen:
            continue
        seen.add(key)
        base = (u.get("input_tokens") or 0) + (u.get("cache_creation_input_tokens") or 0)
        tokens += base + (u.get("output_tokens") or 0)
        if floor is None:
            floor = base + (u.get("cache_read_input_tokens") or 0)
    return first, last, tokens, floor

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--project-dir", required=True)
    ap.add_argument("--since", required=True)
    ap.add_argument("--until")
    ap.add_argument("--session")
    a = ap.parse_args()
    since = ts(a.since); until = ts(a.until) if a.until else None
    root = Path(a.project_dir).expanduser()
    sessions = [root / a.session] if a.session else [d for d in root.iterdir() if d.is_dir()]
    stats = {}; floors = []; lo = hi = None
    for s in sessions:
        for p in (s / "subagents").rglob("agent-*.jsonl"):
            first, last, tokens, floor = read_agent(p)
            if not first or ts(first) < since or (until and ts(first) > until):
                continue
            meta = {}
            try:
                meta = json.loads(p.with_suffix(".meta.json").read_text())
            except (OSError, ValueError):
                pass
            c = stats.setdefault(classify(meta.get("description"), str(p)), [0, 0])
            c[0] += 1; c[1] += tokens
            if floor is not None:
                floors.append(floor)
            f, l = ts(first), ts(last)
            lo = min(lo, f) if lo else f; hi = max(hi, l) if hi else l
    print("PCC cost (tokens = input + cache_creation + output per assistant message; cache reads excluded)")
    for name in ("review", "fix", "lanes", "other"):
        n, t = stats.get(name, [0, 0])
        print(f"  {name:7} agents={n:4} tokens={t:>12,}")
    n = sum(v[0] for v in stats.values()); t = sum(v[1] for v in stats.values())
    wall = (hi - lo).total_seconds() / 60 if lo else 0
    print(f"  total   agents={n:4} tokens={t:>12,} wall={wall:.0f} min")
    if floors:
        print(f"  first-turn context (input+cache_creation+cache_read): median={int(statistics.median(floors)):,} max={max(floors):,}")

if __name__ == "__main__":
    main()
