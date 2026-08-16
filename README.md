# PCC - Pre Commit Check

A commit-gate protocol for Claude Code. Stack-agnostic: JS, Java, Go, Rust, Python - it does not matter, because the commands live in your repo's adapter, not in the skill.

## The three tiers

| Tier | When | Scope | Time |
|---|---|---|---|
| `gate` | before every commit | the tree, mechanically | seconds to 2 min |
| `sweep` | end of day, or when a batch closes | `pcc-clean...HEAD` | 15-40 min |
| [`baseline`](#baseline---onboarding-onto-a-codebase-that-predates-pcc) | **once**, on a repo PCC has never covered | the whole tree | hours, once |

"PCC" on its own means **sweep**. `baseline` is never implicit - it runs only when asked for by name.

## What it does

When Claude hears "PCC", it loads this protocol:

- **A missing lane is named, not skipped.** No e2e, no test suite, nothing to start - none of it stalls the run, and none of it hides inside the word "GREEN". Absence has to be proven (a suite you failed to find looks identical to one that does not exist) and then recorded in the adapter, so it is decided once instead of rediscovered every run.
- **An order that is never rearranged.** Build → services actually come up → fix → review skills → tests → clean build. The code settles first and review runs second, otherwise every fix invalidates the reviews.
- **The speed rule: narrow inside the loop, wide once at the end.** When a gate breaks, fix the offending file and re-check only that file. Running the full suite on an intermediate iteration is a cost that proves nothing.
- **The review skills get only the current round's delta.** Measured: a seven-round sweep re-read the same 550 KB diff every round, ~800k tokens per round.
- **A cosmetic finding does not restart the loop.** If it does not change behaviour, it goes to the debt list.
- **An expensive step is reused when its inputs are byte-identical.** Give each expensive step the paths it actually reads, hash them with comments stripped, and carry a PASSED result forward instead of running it again. Docs and plan files are inputs to nothing. Measured on one repo: the sweep was ~25 minutes, 21 of them e2e - a docs edit now costs 70 seconds. The cheap lane (compile, lint, unit) is never reused and always sees the raw tree, which is what makes the comment axis safe.
- **Evidence rules.** The exit code is not evidence (measured: `gradlew build | tail` returned exit 0 with 63 failing tests). Read the artifact - and the artifact must be FRESH, because an UP-TO-DATE build system can look green while executing no tests at all.
- **How to run a long step.** `nohup … & disown` plus a `kill -0 $PID` loop. A text sentinel tells you what happened, not when to stop.

`troubleshooting.md` carries nine universal traps: the reaped long run, a parallel session overwriting artifacts, the silently hanging test runner, e2e load flake, a stale tree, and formatters that lie with exit 0.

**PCC never commits.** After a green verdict it stops and waits for an instruction.

## Install

### As a plugin (recommended)

```
/plugin marketplace add SNebiyev/claude-pcc
/plugin install pcc@claude-pcc
```

### Manually (personal)

```bash
git clone https://github.com/SNebiyev/claude-pcc.git
mkdir -p ~/.claude/skills
cp -r claude-pcc/skills/pcc ~/.claude/skills/
```

### Inside a repo (team)

Commit `skills/pcc/` to your repo as `.claude/skills/pcc/`. No install step - everyone who clones gets it, and `git pull` is the update mechanism.

### Updating

**A plugin install does not auto-update.** It is pinned to a version and a commit SHA in a versioned cache directory, `claude plugin list` shows no "update available" marker, and refreshing the marketplace catalogue does not touch what is installed. To move to a new version:

```
/plugin marketplace update claude-pcc
/plugin update pcc
```

then restart Claude Code.

For a team all working in one repo, the committed-skill route above is the better one: everyone is on the same version by construction, it travels with the repo's own `.claude/pcc.md` adapter, and nobody has to remember to update anything.

## Usage

Two ways to invoke it, and they do the same thing:

```
/pcc                    # explicit - the slash command
```

or just say it in a sentence, in any language:

```
run PCC
get this commit-ready
PCC et
```

The `description` frontmatter lists trigger phrases in English and Azerbaijani, so Claude loads the skill on either.

Pass an argument to skip the default:

```
/pcc gate               # the fast per-commit tier, not the full sweep
/pcc baseline           # the one-time whole-tree pass on an existing codebase
```

## First run

The skill's first action is to look for `<repo>/.claude/pcc.md`. If it is missing, it works out your stack and writes the adapter - `examples/pcc.md` is the template. Commit that file so nobody rediscovers the same commands a third time.

## Baseline - onboarding onto a codebase that predates PCC

A sweep is scoped to `pcc-clean...HEAD`. That is the right scope for the person who just wrote the diff, and useless for someone joining a project with years of history: on day one there is no clean point, so the review steps either stare at the entire repo at once or at your first tiny commit. Either way you learn nothing about the code you just inherited.

`baseline` inverts the scope, and runs once per repo.

```
/pcc baseline
```

**What it does differently:**

| | sweep | baseline |
|---|---|---|
| Scope | `git diff pcc-clean...HEAD` | `git ls-files` - the tree |
| Review | the delta, in the main session | module by module, **parallel read-only subagents** |
| Findings | fixed in this run | written to a debt list, **not fixed** |
| Verdict | GREEN / RED | **BASELINE** - it inventories the tree, it does not certify it |
| Ends by | moving `pcc-clean` | creating `pcc-clean` for the first time |

**Why it does not just fix what it finds.** Fix-everything applies to a delta you wrote ten minutes ago, not to years of other people's decisions. A newcomer whose first task becomes "clear the backlog" is blocked, not onboarded. So the baseline fixes only what the mechanical gates catch - compile, typecheck, lint, tests, all cheap and unambiguous - plus anything actively broken, and inventories the rest.

**Why it fans out.** The tree is split by module (from the build config, the top-level source dirs, `CODEOWNERS`, or a directory histogram over `git ls-files`) and each chunk goes to its own read-only subagent. Each returns a bounded list - `file:line`, severity, one sentence, why it matters - capped per chunk so one noisy module cannot flood the inventory. The source never enters the main context, and the chunks run at once instead of end to end.

Chunks are ordered by blast radius: auth, payments and data migrations before settings screens. Set a budget up front; if it covers 12 of 20 modules, the report **names the 8 it did not read**. A partial baseline that states its own coverage is useful. One that implies it covered everything is not.

The mechanical gates stay in the main session on purpose - each is a single whole-tree command graded from an artifact, and an agent in between is only somewhere the evidence can get paraphrased.

**After it:** every later sweep is a normal delta, and the codebase's debt is a list instead of a feeling.

## Requirements

- Claude Code. It uses the built-in `/security-review`, `/simplify` and `/code-review` skills - there are **no custom skill dependencies**.
- A git repo with `origin/HEAD` set: `git remote set-head origin -a`

## Dil haqqında / About language

Skill ingiliscədir, amma **azərbaycanca işləyir**. Sən "PCC et" yazırsan, Claude ingiliscə protokolu oxuyur, sənə azərbaycanca cavab verir - skill-in dili cavabın dilini təyin etmir, söhbətin dili təyin edir. Tetikleyici sözlər hər iki dildə yazılıb.

The skill is written in English but works in any language: the conversation's language decides the reply, not the skill's. Trigger phrases are listed in both English and Azerbaijani.

## License

MIT
