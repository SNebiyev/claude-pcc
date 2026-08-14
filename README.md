# PCC - Pre Commit Check

A commit-gate protocol for Claude Code. Stack-agnostic: JS, Java, Go, Rust, Python - it does not matter, because the commands live in your repo's adapter, not in the skill.

## What it does

When Claude hears "PCC", it loads this protocol:

- **Two tiers.** `gate` on every commit (seconds), `sweep` at the end of the day (minutes). "PCC" on its own means sweep.
- **An order that is never rearranged.** Build → services actually come up → fix → review skills → tests → clean build. The code settles first and review runs second, otherwise every fix invalidates the reviews.
- **The speed rule: narrow inside the loop, wide once at the end.** When a gate breaks, fix the offending file and re-check only that file. Running the full suite on an intermediate iteration is a cost that proves nothing.
- **The review skills get only the current round's delta.** Measured: a seven-round sweep re-read the same 550 KB diff every round, ~800k tokens per round.
- **A cosmetic finding does not restart the loop.** If it does not change behaviour, it goes to the debt list.
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

Commit `skills/pcc/` to your repo as `.claude/skills/pcc/`. No install step - everyone who clones gets it.

## First run

The skill's first action is to look for `<repo>/.claude/pcc.md`. If it is missing, it works out your stack and writes the adapter - `examples/pcc.md` is the template.

Then just say "run PCC".

## Requirements

- Claude Code. It uses the built-in `/security-review`, `/simplify` and `/code-review` skills - there are **no custom skill dependencies**.
- A git repo with `origin/HEAD` set: `git remote set-head origin -a`

## Dil haqqında / About language

Skill ingiliscədir, amma **azərbaycanca işləyir**. Sən "PCC et" yazırsan, Claude ingiliscə protokolu oxuyur, sənə azərbaycanca cavab verir - skill-in dili cavabın dilini təyin etmir, söhbətin dili təyin edir. Tetikleyici sözlər hər iki dildə yazılıb.

The skill is written in English but works in any language: the conversation's language decides the reply, not the skill's. Trigger phrases are listed in both English and Azerbaijani.

## License

MIT
