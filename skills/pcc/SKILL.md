---
name: pcc
description: PCC (Pre Commit Check) protocol - a commit gate for any project. Load when asked for "PCC", "full PCC", "run PCC", "gate", "sweep", "baseline", "get this commit-ready", "check the whole codebase", or in Azerbaijani "PCC et", "commit üçün hazırla", "bütöv layihəni yoxla". Covers the three tiers (gate/sweep/baseline), the unbreakable step order, what to do when a lane like e2e does not exist, how to fan a large baseline out across parallel read-only subagents so the main context stays empty, the speed rules (narrow in the loop, wide once at the end - including the rule that a second verify after a red one is an ITERATION, not a final pass), why a delta-selector's baseline must be keyed to a commit and never to a clock, why the external dependencies of a long suite are probed before it runs, when an expensive step may be reused instead of re-run, the evidence rules (read the artifact, never the exit code), the verdict and the report. PCC NEVER commits. Project-specific commands come from the repo's own `<repo>/.claude/pcc.md` adapter.
---

# PCC - Pre Commit Check

This skill is the **protocol, not a command list**. Project-specific commands, timings and traps live in the adapter.

## 0. Find the adapter - this is the first thing you do

```bash
cat .claude/pcc.md 2>/dev/null || echo "NO ADAPTER"
```

- **Adapter exists** - the commands, tier contents, health checks and project traps are there. This file is the rule that sits on top of them.
- **No adapter** - work out the stack yourself (`package.json`, `build.gradle*`, `pom.xml`, `go.mod`, `Cargo.toml`, `pyproject.toml`, `Makefile`, the CI config), map the gate families below onto that stack's commands, then **write `.claude/pcc.md`**. Do not rediscover the same commands a third time.

## Rule zero

🔴 **PCC does NOT commit.** After a green verdict, stop, report, and wait for an explicit instruction.

## The two tiers

| Tier | When | Contents | Target time |
|---|---|---|---|
| **gate** | Every commit | compile + typecheck + lint + fast unit tests | seconds to 2 min |
| **sweep** | End of day, or when a batch of work closes | gate + services actually come up + review skills + full test suite + e2e + clean build | 15-40 min |
| **baseline** | ONCE, on a repo PCC has never covered | gate over the whole tree + review skills over the codebase in chunks. Output is a debt inventory, not a fix list | hours, once |

🔴 **"PCC" on its own means SWEEP.** Only run `gate` when that word is said. Do not ask. `baseline` is never implicit - it runs only when asked for by name, or when there is no clean point yet and you say so first.

🔴 **A sweep covers every commit since the last clean point**, not the last commit alone. Mark the clean point with a local git tag (e.g. `pcc-clean`): when a sweep goes green the tag moves to HEAD, so the next sweep's scope is `git diff pcc-clean...HEAD`. The adapter holds the command that automates this. With no tag, use `origin/main...HEAD` and say so in the report.

## The order of a sweep - never rearranged

1. **Read the scope** - `git diff --name-only <clean-point>...HEAD`.
2. **Build + rerun** - compile/typecheck/lint, then actually start the services and check them live. "It compiled" is not "it runs". A repo with nothing to start (a library, a CLI) skips the live check and says so.
3. **Fix** - everything found, in **one batch**.
4. **`/security-review`** - on the delta only.
5. **`/simplify`** - on the delta only.
6. **`/code-review`** - on the delta only.
7. **Tests** - every lane this repo has: full suite, integration, e2e. Name the ones it does not have.
8. **Final clean build** - with `clean`, because an incremental build can go green off a cache.

**Why the order matters:** the code settles first, review skills run second, the final build runs last. Reversed, every fix invalidates the reviews and the loop restarts from zero.

The review skills need a git base - if `origin/HEAD` is unset, run `git remote set-head origin -a` first.

## A lane the project does not have

Not every repo has every lane. Plenty have no e2e, some have no tests at all. A missing lane is **named**, never silently skipped and never a reason to stall - a "GREEN" that quietly means "no tests ran" is the exact failure this protocol exists to prevent.

- **Prove absence, do not assume it.** No `test` script in `package.json` is not proof. Check the CI config, the `Makefile`, a `tests/` or `spec/` directory, the language's own convention (`go test ./...`, `cargo test`, `pytest`). A suite you failed to find reads exactly like a suite that does not exist.
- **Record it in the adapter** under "Lanes this repo does not have", one line each with the reason (not written yet / not applicable / lives in another repo). Absence becomes a decision made once instead of a discovery repeated every run.
- **Never invent the command.** Do not scaffold a test runner, do not run a script that is not there, and do not read a runner's "no tests found" as red.
- **The verdict carries it:** `GREEN (no e2e lane in this repo)`. The remaining steps run unchanged.
- A repo with no automated tests at all still gets a real gate from compile + typecheck + lint. Say that plainly, and say what is therefore unverified - that sentence is usually the most useful output of the first run.

## `baseline` - the first run on a codebase PCC has never seen

A sweep is scoped to `pcc-clean...HEAD`. On a repo with years of history and no tag that scope is either everything (unusable in one pass) or almost nothing (a new teammate's first commit) - either way the review steps deliver nothing. Run a baseline once per repo, before the first sweep.

Only these things change:

1. **Scope is the tree, not a diff** - `git ls-files` narrowed to the code directories.
2. **The mechanical gates already are whole-tree** - compile, typecheck, lint and the test suites take no diff. Run them first, unchanged. What they find is real and belongs to nobody.
3. **The review runs in chunks**, one module or directory per call, each with the same "SCOPE IS THESE N FILES ONLY" instruction. Order the chunks by blast radius: auth, payments and data migrations before settings screens. Set a budget up front and stop when it runs out - a partial baseline that states its own coverage beats an abandoned one. On anything bigger than a small repo, run those chunks as parallel subagents - see the next section, it is what keeps the run short and the main context empty.
4. **Findings go to the debt list. They are NOT fixed in this run.** Fix-everything applies to a delta you just wrote, not to years of other people's decisions. Fix only what the mechanical gates catch (cheap, unambiguous) and anything actively broken.
5. **It ends by setting the clean point** - `git tag -f pcc-clean HEAD`. From then on every sweep is a delta again.

Report it as **BASELINE**, never GREEN: a baseline inventories the tree, it does not certify it. List which chunks were covered and which were not.

## Baseline at scale: fan out, keep the main context clean

A baseline reads the whole tree - which is exactly the work that must NOT happen in the main context. An orchestrator that reads the source itself fills up with code and runs out before it can write the inventory it was started for.

**Split the tree, delegate each chunk to a subagent, keep only the findings.**

1. **Scout inline first, cheaply.** The chunk list comes from the repo, not from a guess: the build config's modules, the top-level source directories, `CODEOWNERS`, or a directory histogram over `git ls-files`. A few hundred tokens, and it decides everything after it.
2. **One chunk = one module or one coherent directory**, never an arbitrary file count. A chunk has to be judgeable on its own - a reviewer shown half a feature reports noise. Split a module that is too big by layer (api / domain / storage), not at random.
3. **Run the chunks in parallel.** They are independent by construction; that is what makes a module boundary a module boundary.
4. **Subagents are READ-ONLY in a baseline.** They report, they do not edit. Parallel writers on a codebase nobody in the room knows yet produce conflicts you then have to review as well.
5. **Fix the return shape before fanning out.** Each subagent returns a bounded list - `file:line`, severity, a one-sentence claim, why it matters - and nothing else. No file dumps, no quoted source. Cap it (say 10 findings per chunk, worst first) so one noisy module cannot flood the inventory.
6. **Verify before a finding enters the debt list.** A subagent's finding is a claim made without the rest of the repo in view. Check the high-severity ones - yourself, or with a second agent asked to REFUTE rather than confirm. An inventory full of plausible-but-wrong entries is worse than a short one.
7. **Never truncate silently.** If the budget covered 12 of 20 modules, the report names the 8 it did not read. "Covered everything" is the one thing a partial baseline must never imply.

**What stays in the main session, undelegated:** compile, typecheck, lint and the test suites. Each is a single whole-tree command whose verdict comes from an artifact - putting an agent between you and that artifact only adds a place for the evidence to get paraphrased.

The same fan-out applies to a sweep whose delta has grown huge (a long-lived branch, months of work merged at once). The trigger is the size of the scope, not which tier you are in.

## Speed: NARROW inside the loop, WIDE once at the end

Running the full suite on an intermediate iteration is a cost that proves nothing - the full run happens at the end anyway. When a gate breaks, **fix the offending file and re-check only that file**.

| Gate | Intermediate iteration | Final pass only |
|---|---|---|
| lint | single file(s) | whole tree |
| typecheck | usually has no per-file mode - run it whole, lean on the incremental cache | whole run |
| unit | single test file | full suite (usually cheap anyway) |
| backend / integration | name filter (`--tests "*Foo*"` or equivalent) | full suite |
| e2e | ONE spec → then its group | full suite - **never** in an intermediate loop |

🔴 **A second `verify` after a red one IS an intermediate iteration.** This is the hole the table
above does not close, and it is the single largest cost measured on a real sweep. The final pass is
final only while it is passing; the moment it goes red and you fix something, the re-run is a loop
iteration that happens to be spelled `verify` - and it pays the full price of every lane inside it.

Measured, one sweep, 2026-09-05: **2 h 56 min total, 62 of them e2e across two full runs.** The
review pass - the thing everyone suspects - was 21 minutes and ran six agents in parallel. The
second full suite existed because a one-line locator fix and an edit to the orchestrator's own
source invalidated the suite's input hash.

So, after a red verdict:

1. Fix everything the run found, in **one** batch. Never one fix, one re-run.
2. Re-run **only the lanes that were red**, by name, narrow. A green lane does not become suspect
   because a different lane failed.
3. Re-run the whole thing **once**, at the end, when you believe it is finished - and only if a lane
   that was green could plausibly have been broken by the fixes.

If the harness cannot re-run one lane in isolation, that is a defect in the harness, not a reason to
pay for all of them.

## The delta-selector's baseline must be keyed to a COMMIT, never to a clock

A suite that can select a subset from the delta needs a baseline: "what was the tree the last time
this suite ran in full". Give that baseline a time-based expiry and it will be correct, useless, and
silent - all at once.

Measured: a 72-hour TTL against a cadence of one sweep every few days. Every single run printed
`FULL suite: baseline is not trustworthy (124 hours)`, then `(125 hours)`. The selector was working
exactly as designed - a stale baseline genuinely cannot answer - and it therefore **never fired
once**, while the code that would have cut 21 minutes to 6 sat there passing its own tests.

- Key the baseline to the **commit** it was taken at, so it stays valid until the tree moves.
- If you must expire it, expire it on something that tracks the tree (a merge-base, a file count,
  the number of commits since), never on hours elapsed.
- ⚠️ The tell that you have this bug: the fallback branch fires on **every** run. A safety fallback
  that is always taken is not a fallback, it is the implementation.

## Probe the external dependencies BEFORE the long suite

A browser suite needs more than the app: a tile server, an object store, a queue, a search index. Any
of them can be down while the app itself answers 200 - and the suite will then report their absence
as N application defects, after paying its full running time to do so.

Measured twice on the same project: a map-tile container had exited days earlier. The suite spent
**31 minutes** to report it as four failing map tests, each with a plausible-looking assertion error
(`toBeVisible` on a tile image that had loaded its `src` but stayed at `opacity: 0`). A one-line
`curl` answers the same question in 200 ms.

Put the probe in the step that brings services up, next to the health checks that already run there,
and name the dependency in the failure - "the tile server is down" is a different sentence from
"four map tests failed", and only one of them sends you to the right place.

## Give the review skills only the CURRENT round's delta

When a sweep runs long, do not make the skills re-read the whole scope every round. Measured: a seven-round sweep re-read the same 550 KB diff each time, ~800k tokens and 20+ minutes per round, and nearly everything found sat in parts already reviewed in earlier rounds.

- At the start of a round, take the files that round touched with `git diff --name-only`, list them file by file in the skill argument, and write: **"SCOPE IS THESE N FILES ONLY - do NOT read the wider diff"**.
- Pass findings already applied or deliberately deferred as a **"DO NOT re-report"** list.
- For a comment/docs-only fix, do not restart a full PCC.

## A cosmetic finding does NOT restart the loop

The loop usually repeats for mechanical reasons, not substantive ones: fix one comment line, the tree changes, the earlier steps' evidence goes stale, everything re-runs.

Before applying a finding, ask: **does it change behaviour?**

- **Yes** → fix it, but batch all of them together.
- **No** (a wrong comment, an unused return value, a test helper) → write it to the debt list and CLOSE the loop.

Declare one round in which nothing found is applied and everything goes to debt. Otherwise every fix spawns another round. This does not contradict "fix everything found" - the debt is recorded, not dropped.

## Reuse an expensive step only when its inputs are byte-identical

The rule above is a judgement a human makes every round. Make it deterministic and it costs nothing to apply, every time, without being argued about.

Give each expensive step a **declared set of inputs**, hash them, and store the hash beside the result. A step that PASSED and whose inputs are byte-identical carries its result forward instead of running again. Two axes, and both are needed:

- **Path** - each step declares the paths it actually reads. Documentation, plan files, and the harness's own source are inputs to nothing. The backend suite does not read the frontend. The browser suite does not read the unit tests - but it DOES read the seed scripts that build the database it runs against, so a blanket "scripts are not app code" would skip the suite over a fixture change.
- **Content** - inside those paths, hash comment-stripped source, so a rewritten comment is not a rewritten function.

Rules that keep it honest, each one learned by getting it wrong first:

1. **The hash is content identity, not history.** Do not hash HEAD. A commit moves no byte in the working tree, so hashing it makes the sweep straight after a commit pay full price - and it breaks stash round-trips and branch switches for the same reason.
2. **Only the expensive steps may be reused.** Compile, lint and the fast unit suite re-run unconditionally, over the RAW tree. That is the counterweight that makes the comment axis safe: whatever the stripper looks past, those still see.
3. **Never carry forward a result that was not a pass.** A flaky or failed step costs exactly what fixing it costs.
4. **A carried-forward result must not read as "ran just now".** Print it with a different glyph, keep its ORIGINAL timestamp, and say which run it came from. This is the evidence rule below, in receipt form.
5. **One flag forces everything** (`--rerun-all`), for when you distrust the mechanism.
6. **Print the bill before it is paid.** A `status` command should name what the next run will REUSE and what it will RE-RUN - both lists, explicitly. Never let one be inferred from the other's absence: an inverted preview once announced a full re-run for a sweep that finished in 70 seconds, which is a worse answer than saying nothing.

Measured on one repo: the sweep was ~25 minutes, 21 of them e2e. After this, a comment-or-docs edit costs **70 seconds** and the expensive lanes print as carried-forward.

🔴 **Two traps found building it. Both silent, both in the dangerous direction (reuse something you should have run).**

- **A failed command must THROW, never return empty.** `res.stdout ?? ""` over a failed `git` yields an empty file list, and an empty list hashes to a perfectly STABLE value. The first failure is harmless - it does not match the recorded hash, so everything runs. The SECOND consecutive failure matches the first exactly, and every expensive step is reused over a tree nobody read. Guard the success of the command, and guard the empty result separately: a command can exit 0 and still say nothing.
- **`git ls-files` QUOTES non-ASCII paths** - `core.quotePath` defaults to true, so `src/lib/tələ.ts` arrives as `"src/lib/t\311\231l\311\231.ts"`. That string names no file, so it hashes as deleted and every future edit to that file is invisible to the gate covering it. Use `-z`. A repo with zero such paths today is exactly the repo where this ships unnoticed.

## Fix-everything policy

Everything PCC finds gets fixed - including problems in files you did not touch and issues left by older commits. Errors and warnings alike. The final pass runs lint over the **whole tree**, not just changed files (a `tail` truncation once hid extra warnings). The only exception is the cosmetic rule above.

## Evidence rules

🔴 **The exit code is not evidence.** Measured examples: `gradlew build | tail` returned exit 0 with 63 failing tests; `gofmt -l` exits 0 even when it finds problems. **Read the artifact** - the JUnit/JSON/TAP report, the linter's JSON output, the test-results directory.

🔴 **The artifact must be FRESH.** An old test-result file reads as a pass. Record the step's start time and require the artifact's `mtime` to be newer. An UP-TO-DATE build system (Gradle, Bazel, `make`) can look green while executing no tests at all.

🔴 **A language the gate cannot see is a language with no gate.** When you add a language or service, first prove with a negative control that PCC actually goes RED for it: a compile error, a failing test, a formatting violation - each one separately.

## How to run a long step

🔴 **Do not run a long step inside a harness-tracked task - it gets reaped and the whole run is lost.** Detach the process and wait separately:

```bash
nohup <long command> > "$LOG" 2>&1 < /dev/null &
PID=$!
disown
for i in $(seq 1 120); do kill -0 "$PID" 2>/dev/null || break; sleep 15; done
tail -40 "$LOG"        # decide from the ARTIFACT
```

Three rules, each from a measured hang:

1. **The wait condition is process liveness, not a text sentinel.** The sentinel tells you *what happened*, not *when to stop* - if the process dies nothing is ever printed and a sentinel-driven loop hangs for hours.
2. **Check liveness with `kill -0 $PID`, never `pgrep -f "<pattern>"`.** The loop's own command line contains that pattern, so `pgrep` matches itself and the condition is never false. (If you must use a pattern, the bracket trick `pgrep -f "pcc[.]mjs"` works - but a PID is simpler and exact.)
3. **A deadline is mandatory.** A loop with no `seq 1 N` counter never ends on its own.

macOS has neither `setsid` nor `timeout` - use the counter above, or `curl -m N`.

## When the verdict is red, suspect the environment first

The sequence is in `troubleshooting.md`. Project-specific traps are in the adapter.

## The report

1. **Verdict** - GREEN / RED, with the numbers taken from the artifacts.
2. **How many rounds, and what each one fixed** - with file names.
3. **What went to debt** - wherever debt is tracked, with its identifiers.
4. **Say plainly if any step was unverified, skipped, or absent from this repo** - the word "GREEN" alone hides all three.
5. **What needs restarting** - with full commands. If nothing does, say so explicitly.
6. **A draft commit message** - but do NOT commit.
