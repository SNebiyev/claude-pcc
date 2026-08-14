# PCC adapter - TEMPLATE

Keep this file in your own repo as `<repo>/.claude/pcc.md`. The skill reads it as its first action.

The adapter holds ONLY what is specific to this repo: commands, measured timings, health checks, this repo's traps. The protocol itself lives in the skill - do not copy it here.

If the file is missing, the skill works out the stack itself (`package.json`, `build.gradle*`, `pom.xml`, `go.mod`, `Cargo.toml`, `pyproject.toml`, `Makefile`, the CI config) and writes this file. Commit it so nobody rediscovers the same commands a third time.

---

## Commands

```bash
# gate - before every commit, seconds
<compile>                    # e.g. ./gradlew compileJava compileTestJava
<typecheck>                  # e.g. npx tsc --noEmit
<lint>                       # e.g. npx eslint src --cache
<fast unit tests>            # e.g. npx tsx --test "src/**/*.test.ts"

# sweep - end of day
<bring services up>          # e.g. ./scripts/dev-up.sh all
<full test suite>            # e.g. ./gradlew test
<e2e>                        # e.g. npx playwright test
<clean build>                # e.g. ./gradlew clean build
```

## Lanes this repo does NOT have

The point of writing absence down is that it stops being rediscovered - and stops being confused with "I could not find it". One line each, with the reason.

| Lane | Status | Why |
|---|---|---|
| e2e | none | not written yet - the sweep says so in its verdict |
| integration | none | not applicable, this repo is a library |
| services | none | nothing to start; the sweep's live check is skipped |

Delete the rows that do not apply. If a lane exists but you could not find its command, that is NOT absence - find it before writing it here.

## The clean point

A sweep covers everything from the last clean point to HEAD. Mark it with a local git tag:

```bash
git diff pcc-clean...HEAD --name-only     # the scope
git tag -f pcc-clean HEAD                 # when the sweep goes green (never pushed)
```

With no tag, use `origin/main...HEAD` and say so in the report.

**On an existing codebase the tag is set by the `baseline` run, not by hand.** Until it exists, a sweep has no meaningful scope - run `PCC baseline` once first.

```bash
git ls-files -- src backend            # the baseline scope: the tree, not a diff
```

## Health checks

For the sweep's "the services actually run" step. Each must return 200:

| Service | URL | Note |
|---|---|---|
| backend | `http://localhost:8080/actuator/health` | |
| frontend | `http://localhost:3000/` | ⚠️ check the FINAL path, not one that redirects - `curl -f` treats a 3xx as success |

## Measured timings

Decide narrow-vs-wide from numbers, not instinct. Measure first, then fill this in:

| Gate | Narrow | Wide |
|---|---|---|
| lint | single file, ~2s | whole tree, ~40s |
| typecheck | no per-file mode | ~40s |
| unit | single file | full suite, ~6s |
| integration | name filter, ~20s | full suite, ~90s |
| e2e | one spec | full suite - **never** in an intermediate loop |

## This repo's traps

Put ONLY recurring, repo-specific ones here. Universal traps live in the skill's `troubleshooting.md`.

- **`<tool>` exits 0 even when it finds problems** - read its output, not the exit code.
- **`<test suite>` hangs silently under pressure** - check worker processes plus artifact `mtime`s.
- **Known load-flake specs:** `<list>` - if the name is here and it is not code you touched, verify standalone.
- **Generated files:** `<list>` - must be excluded from the "tree changed" fingerprint, because a PCC step regenerates them.
