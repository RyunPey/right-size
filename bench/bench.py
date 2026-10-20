"""A/B benchmark for right-size: every case runs headless with the plugin on and off.

  python bench/bench.py run [--reps 2] [--case GLOB ...] [--tag TAG ...] [-j 4] [--max-cost 5] [--shared-cache]
  python bench/bench.py report bench/results/<file>.jsonl
  python bench/bench.py selftest

The on arm loads right-size from this checkout (--plugin-dir) with any installed copy disabled. The off arm
disables it and runs the baseline model and effort. Each case is one session, so multi-turn cases exercise the
cache guard. The answering model comes from the API's usage data; the pick, effort and guard decision come from
the plugin's own status line.
"""
import argparse
import fnmatch
import json
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path

from cases import CASES

ROOT = Path(__file__).resolve().parent.parent
RESULTS = Path(__file__).resolve().parent / "results"
TIERS = ["haiku", "sonnet", "opus"]
DISABLE_INSTALLED = json.dumps({"enabledPlugins": {"right-size@right-size": False}})
# Writes and network stay off: answers must come from the model, and a run must not touch your machine.
DISALLOWED = "Bash,Write,Edit,NotebookEdit,WebFetch,WebSearch,Agent"


def tier_of(model):
    return next((t for t in TIERS if t in (model or "")), model)


def parse_status(text):
    """'sonnet · medium (kept: cache hot)' -> pick fields."""
    if not text:
        return {}
    if text.startswith("right-size:"):
        return {"status": text, "fallback": True}
    head = text.split(" (")[0]
    model, _, effort = head.partition(" · ")
    return {"status": text, "pick": model, "effort": effort or None, "kept": "(kept:" in text,
            "not_honored": "(ran " in text}


def command(arm, args):
    # A unique line in each session's system prompt keeps sessions from reading each other's prompt cache,
    # so an arm never runs cheaper because the other arm just sent the same prompt.
    nonce = f"Benchmark session {uuid.uuid4().hex}."
    cmd = [shutil.which("claude") or "claude", "-p", "--input-format", "stream-json", "--output-format",
           "stream-json", "--verbose", "--model", args.baseline_model, "--effort", args.baseline_effort,
           f"--disallowedTools={DISALLOWED}", "--settings", DISABLE_INSTALLED]
    if not args.shared_cache:
        cmd += ["--append-system-prompt", nonce]
    return cmd + (["--plugin-dir", str(ROOT)] if arm == "on" else [])


def run_case(arm, case, rep, args, workdir):
    """Runs every turn of a case in one session; returns one row per turn."""
    rows, models, status = [], set(), None
    prev_cost, prev_usage = 0.0, {}
    t0 = time.monotonic()
    proc = subprocess.Popen(command(arm, args), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, text=True, encoding="utf-8", cwd=workdir)

    def send(i):  # one turn at a time: messages queued ahead of a running turn get dropped
        if i < len(case.turns):
            message = {"type": "user", "message": {"role": "user", "content": case.turns[i].prompt}}
            proc.stdin.write(json.dumps(message) + "\n")
            proc.stdin.flush()
        else:
            proc.stdin.close()

    send(0)
    try:
        for line in proc.stdout:
            try:
                ev = json.loads(line)
            except json.JSONDecodeError:
                continue
            kind = ev.get("type")
            if kind == "assistant":
                models.add(ev["message"].get("model"))
            elif kind == "system" and ev.get("subtype") == "ui_status" and ev.get("plugin") == "right-size":
                status = ev.get("text") or status
            elif kind == "result":
                i = len(rows)
                turn = case.turns[i]
                usage = {m: u["costUSD"] for m, u in (ev.get("modelUsage") or {}).items()}
                spent = {m: round(c - prev_usage.get(m, 0), 6) for m, c in usage.items() if c - prev_usage.get(m, 0) > 0}
                cost = (ev.get("total_cost_usd") or 0) - prev_cost
                answer = ev.get("result") or ""
                ran = max(spent, key=spent.get) if spent else next(iter(models), None)
                rows.append({
                    "arm": arm, "case": case.name, "rep": rep, "turn": i, "tier": turn.tier, "tags": case.tags,
                    "kept_expected": case.kept_at.get(i), "ran": tier_of(ran), "models": spent,
                    "cost": round(cost, 6), "wall_s": round(time.monotonic() - t0, 1),
                    "pass": bool(not ev.get("is_error") and turn.check(answer)), "steps": ev.get("num_turns"),
                    "answer": answer, **(parse_status(status) if arm == "on" else {}),
                })
                prev_cost, prev_usage, models, status, t0 = ev.get("total_cost_usd") or 0, usage, set(), None, time.monotonic()
                send(len(rows))
                if len(rows) == len(case.turns):
                    break
        proc.wait(timeout=args.timeout)
    except subprocess.TimeoutExpired:
        proc.kill()
    err = proc.stderr.read()[-300:] if proc.stderr else ""
    for i in range(len(rows), len(case.turns)):  # turns that never answered
        rows.append({"arm": arm, "case": case.name, "rep": rep, "turn": i, "tier": case.turns[i].tier,
                     "tags": case.tags, "pass": False, "cost": 0, "error": err or "no result"})
    return rows


def run(args):
    cases = [c for c in CASES
             if (not args.case or any(fnmatch.fnmatch(c.name, g) for g in args.case))
             and (not args.tag or set(args.tag) & set(c.tags))]
    if not cases:
        sys.exit("no cases match")
    RESULTS.mkdir(exist_ok=True)
    out = Path(args.out or RESULTS / f"{datetime.now():%Y%m%d-%H%M%S}.jsonl")
    jobs = [(arm, c, r) for r in range(args.reps) for c in cases for arm in args.arms]
    spent, lock = [0.0], threading.Lock()
    workdir = tempfile.mkdtemp(prefix="right-size-bench-")  # empty: no repo context, no CLAUDE.md

    def job(j):
        arm, case, rep = j
        with lock:
            if args.max_cost and spent[0] >= args.max_cost:
                return []
        rows = run_case(arm, case, rep, args, workdir)
        with lock:
            spent[0] += sum(r["cost"] for r in rows)
            print(f"[${spent[0]:6.2f}] {arm:3} {case.name:12} rep{rep} "
                  + " ".join(f"{r.get('status') or r.get('ran')}={'ok' if r['pass'] else 'FAIL'}" for r in rows),
                  flush=True)
        return rows

    print(f"{len(jobs)} sessions -> {out}")
    with ThreadPoolExecutor(args.jobs) as pool, out.open("w", encoding="utf-8") as f:
        for rows in pool.map(job, jobs):
            for r in rows:
                f.write(json.dumps(r) + "\n")
    if args.max_cost and spent[0] >= args.max_cost:
        print(f"stopped early: cost ceiling ${args.max_cost} reached")
    report(out)


def report(path):
    rows = [json.loads(line) for line in Path(path).open(encoding="utf-8")]
    by = defaultdict(list)
    for r in rows:
        by[(r["case"], r["turn"], r["arm"])].append(r)
    avg = lambda rs, k: sum(r.get(k) or 0 for r in rs) / max(len(rs), 1)  # noqa: E731
    rate = lambda rs: f"{sum(r['pass'] for r in rs)}/{len(rs)}"  # noqa: E731

    print(f"\n{'case':14} {'want':6} | {'on: ran · effort':24} {'pass':>5} {'$':>7} {'s':>4} | "
          f"{'off: pass':>9} {'$':>7} {'s':>4}")
    for case, turn in dict.fromkeys((r["case"], r["turn"]) for r in rows):
        on, off = by[(case, turn, "on")], by[(case, turn, "off")]
        picks = Counter(f"{r.get('ran')}{' · ' + r['effort'] if r.get('effort') else ''}"
                        f"{' kept' if r.get('kept') else ''}" for r in on)
        label = f"{case}#{turn}" if any(r["turn"] for r in on + off) or len(by[(case, 1, 'on')]) else case
        tier = (on or off)[0].get("tier") or "-"
        print(f"{label:14} {tier:6} | {', '.join(f'{k}×{n}' if n > 1 else k for k, n in picks.items()):24} "
              f"{rate(on):>5} {avg(on, 'cost'):7.4f} {avg(on, 'wall_s'):4.0f} | "
              f"{rate(off):>9} {avg(off, 'cost'):7.4f} {avg(off, 'wall_s'):4.0f}")

    print()
    arms = {a: [r for r in rows if r["arm"] == a] for a in ("on", "off")}
    for a, rs in arms.items():
        if rs:
            print(f"{a:3}: pass {rate(rs):>7} ({sum(r['pass'] for r in rs) / len(rs):.0%})  "
                  f"cost ${sum(r['cost'] for r in rs):.2f}  wall {sum(r.get('wall_s') or 0 for r in rs) / 60:.1f} min")
    if arms["on"] and arms["off"]:
        c_on, c_off = (sum(r["cost"] for r in arms[a]) for a in ("on", "off"))
        print(f"cost change with right-size: {(c_on - c_off) / c_off:+.0%}" if c_off else "")

    # Turns the cache guard kept on the previous model say nothing about the pick.
    routed = [r for r in arms["on"] if r.get("tier") and r.get("ran") in TIERS and not r.get("kept")]
    if routed:
        diff = lambda r: TIERS.index(r["ran"]) - TIERS.index(r["tier"])  # noqa: E731
        groups = {"under": [r for r in routed if diff(r) < 0], "exact": [r for r in routed if diff(r) == 0],
                  "over": [r for r in routed if diff(r) > 0]}
        print("routing vs expected tier: " + ", ".join(
            f"{k} {len(v)} (pass {rate(v)})" for k, v in groups.items() if v))

    guard = [r for r in arms["on"] if r.get("kept_expected") is not None]
    if guard:
        verdicts = Counter()
        for r in guard:
            prev = next((p for p in by[(r["case"], r["turn"] - 1, "on")] if p["rep"] == r["rep"]), None)
            switched = prev is not None and prev.get("ran") != r.get("ran")
            if r.get("kept"):
                verdicts["held" + ("" if r["kept_expected"] else " (expected switch)")] += 1
            elif switched:
                verdicts["switched" + ("" if not r["kept_expected"] else " (expected hold)")] += 1
            else:
                verdicts["no decision: pick matched current model"] += 1
        print("cache guard: " + ", ".join(f"{k} ×{n}" for k, n in verdicts.items()))

    flags = Counter(k for r in arms["on"] for k in ("fallback", "not_honored") if r.get(k))
    errors = [(r["arm"], r["case"], r["error"][:100]) for r in rows if "error" in r]
    if flags:
        print("status flags:", dict(flags))
    if errors:
        print("errors:", *errors, sep="\n  ")


def selftest(_args):
    ok = True
    for case in CASES:
        for i, t in enumerate(case.turns):
            if not t.good:
                continue
            good, bad = t.check(t.good), t.check("I don't know.")
            ok &= good and not bad
            print(f"{case.name}#{i:<3} accepts good: {good}  rejects bad: {not bad}")
    print("SELFTEST", "PASS" if ok else "FAIL")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run")
    r.add_argument("--reps", type=int, default=2)
    r.add_argument("--arms", type=lambda s: s.split(","), default=["on", "off"])
    r.add_argument("--case", nargs="*", help="name globs")
    r.add_argument("--tag", nargs="*", help="haiku, sonnet, opus, sneaky, multi, followup, guard, urgent")
    r.add_argument("-j", "--jobs", type=int, default=4)
    r.add_argument("--max-cost", type=float, help="stop starting sessions once this many USD are spent")
    r.add_argument("--baseline-model", default="opus")
    r.add_argument("--baseline-effort", default="high")
    r.add_argument("--timeout", type=int, default=900)
    r.add_argument("--shared-cache", action="store_true",
                   help="let sessions share the prompt cache (cheaper, but arms can skew each other's cost)")
    r.add_argument("--out")
    r.set_defaults(fn=run)
    p = sub.add_parser("report")
    p.add_argument("path")
    p.set_defaults(fn=lambda a: report(a.path))
    sub.add_parser("selftest").set_defaults(fn=selftest)
    a = ap.parse_args()
    a.fn(a)
