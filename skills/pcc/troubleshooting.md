# When PCC goes red - rule these out first

Universal traps. Project-specific ones live in `<repo>/.claude/pcc.md`.

The order is not arbitrary: the ones nearer the top happen more often.

## 1. The long step was reaped - not a code defect

A long, silent run (full e2e, full test suite) gets killed inside a harness-tracked task. Printing a heartbeat is not enough - the reaper takes the process GROUP, not the silence. The only form that works is in `SKILL.md`, "How to run a long step": `nohup … & disown` plus a separate liveness loop.

Symptom: the log is cut off mid-run, the process is gone, and no error was written anywhere.

## 2. Phantom red: a parallel session overwrote the artifacts

Most PCC scripts write their artifacts to a fixed path (`/tmp/<project>-pcc/` or similar), not separated by session or working tree. When two agent sessions work in the same repo, the second run silently overwrites the first one's logs.

Symptom: the summary says `fail=1`, but the log file contains no failing line at all - the evidence does not exist.

**Check this BEFORE making a claim:**
```bash
stat -f '%Sm' <log-path>        # macOS
stat -c '%y' <log-path>         # Linux
```
If the log is older than your run started - or newer, because another run wrote it - reading it is meaningless. Re-run that gate into your own isolated file.

⚠️ While another session is running PCC, do not touch the PCC script itself - you will break their run.

## 3. The test runner hangs silently

A large suite can hang under resource pressure: the build daemon reports BUSY, no worker processes remain, the log has not moved for 20+ minutes, CPU is at 0%.

⚠️ Combined with `-q`/`--quiet` this is doubly deceptive - **success is silent too**. "The log stopped moving" is evidence of neither a hang nor a pass.

**Check:** are the worker processes alive (`ps aux | grep <executor>`), and are the test-result artifacts' `mtime`s advancing?

**When it hangs:** kill the daemon, then a small targeted set (name filter + `--max-workers=1`) almost always finishes immediately. The full suite is far more reliable run alone, with no parallel work beside it.

## 4. An e2e failure: load flake, spec defect, or real regression?

When the full suite runs in parallel (many browsers + backend + frontend + build daemon in the same memory), an **unrelated** spec takes a random timeout. With `retry=0` this shows up as "failed", not "flaky".

The sequence:
1. Is the failing spec related to the code you touched? If not, flake is likely.
2. Run it standalone. Clean on its own → load flake.
3. 🔴 **Do not stop there.** Check whether the assertion RE-READS on every attempt. A locator-based assertion (`toHaveAttribute`, `toHaveText`) re-queries the DOM but **does not reload the page** - under load one bad render holds it wrong for the whole timeout. That is not infra flake, it is a spec defect to fix. The repair is always the same: not re-query, **re-READ**.

Re-running the failed specs one by one takes minutes; the full suite takes tens of minutes - do the cheap one first.

## 5. It says "the tree changed / STALE"

Look at **whose file** changed first (`git status` plus file `mtime`s):

- The files are your own edits → re-run the build step, and know that the reviews went stale with it.
- Another session or a human is working in parallel, so the files are theirs → the fast `gate` covers the current tree; there is no need to re-run the whole sweep.

Generated artifacts (an OpenAPI JSON, a snapshot, a lock file) must be excluded from the fingerprint - a PCC step regenerates them, so they are not source changes. But do not exclude the output of a generator **PCC never runs**: that would blind the check to a real hand-edit.

## 6. The review skills cannot find a git base

`/security-review`, `/simplify` and `/code-review` work off `origin/HEAD...`:
```bash
git remote set-head origin -a
```

## 7. Formatters and linters that lie with exit 0

`gofmt -l`, some `prettier --check` variants and their relatives exit 0 even when they find problems - they just print the filenames on stdout. The gate must require **empty output**, not a zero exit code. Same class: a run that matched no tests also exits 0 - "0 tests executed" must count as a failure.
