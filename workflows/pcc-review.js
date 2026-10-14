// pcc-review - PCC review cycle for a delta. Call: Workflow({name: "pcc:pcc-review", args: {...}})
// args:
//   repo     (required) absolute path of the repo
//   range    (required) the delta to review: "<base>..<head>" / "<base>...<head>", or a single rev "<base>"
//            (a single rev = <base> against the WORKING TREE, so uncommitted edits are in the delta; run
//            `git add -N <new files>` first, otherwise untracked files are invisible to git diff)
//   extra?   more ranges to review in the same round (array, same forms as range)
//   changedLines? non-negative integer: sum of added+deleted lines of `git diff --numstat <range>` (new files included).
//            < 100 -> ONE reviewer covers security+correctness+simplify; missing or >= 100 -> three separate reviewers
//   fix?     true -> one sonnet fixer commits once for the surviving HIGH+MEDIUM findings
//   lanes?   true -> after a ship verdict, run the repo's PCC sweep lanes per <repo>/.claude/pcc.md
//   round?   non-negative integer: review rounds already spent on this batch (budget is 2 in total)
//   context? short caller note for the reviewers (cut to 800 chars)
//   scratch? base dir for agent scratch files; without it each agent makes its own with mktemp -d
//   limits?  free text, a binding resource rule for probes/tests/builds, e.g.
//            "probes: systemd-run --user --scope -q -p MemoryMax=3G -p MemorySwapMax=0 <cmd>; tests/builds: MemoryMax=6G"
// After round 2 a surviving HIGH gives 'structural'; MEDIUM-only gives 'ship' with medium[] returned UNFIXED
// (a fix after the last review would be unreviewed code).
// returns { status: 'ship'|'blocked'|'structural', roundsUsed, head, high, medium, debt, refutedHigh,
//           tried, lanes, note, uncovered }. tried is keyed by lens (security/correctness/simplify) in both modes. 'blocked' or a non-empty `uncovered` is not a ship.

export const meta = {
  name: 'pcc-review',
  description: 'PCC review cycle: delta-only lens reviews, skeptic verify of HIGHs, one fixer, re-review, optional PCC lanes',
  whenToUse: 'PCC review gate for any repo with a .claude/pcc.md; delta-only, Opus reviewers, Sonnet fixers, max 2 rounds',
  phases: [
    { title: 'Review', detail: 'security | correctness | simplify on the delta only', model: 'opus' },
    { title: 'Verify', detail: 'one skeptic per HIGH finding, default refuted', model: 'opus' },
    { title: 'Fix', detail: 'one fixer for all surviving HIGH+MEDIUM, one commit', model: 'sonnet' },
    { title: 'Lanes', detail: 'repo PCC sweep per .claude/pcc.md', model: 'sonnet' },
  ],
}

// ---------------------------------------------------------------- policy
const REVIEW_MODEL = 'opus'      // reviewers + verifiers: judgment work never on sonnet
const FIX_MODEL = 'sonnet'
const LANES_MODEL = 'sonnet'
const MAX_ROUNDS = 2             // total review rounds per batch (args.round counts earlier ones)
const SMALL_DELTA_LINES = 100    // changedLines below this -> one reviewer for all lenses
const MAX_FINDINGS = 8
const MAX_TRIED = 10

// ---------------------------------------------------------------- args
const A = args || {}
const repo = A.repo
const baseRange = A.range
if (!repo || !baseRange) throw new Error('pcc-review: args.repo and args.range are required')
const REV_RE = /^[\w.\/~^@{}-]+(\.\.\.?[\w.\/~^@{}-]+)?$/
function checkRev(x, what) {
  if (typeof x !== 'string' || !REV_RE.test(x) || x.startsWith('-')) throw new Error(`pcc-review: ${what} must be a single rev or a..b / a...b, got ${JSON.stringify(x)}`)
}
function parseCount(v, what) {
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0) return v
  if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v)
  throw new Error(`pcc-review: ${what} must be a non-negative integer, got ${JSON.stringify(v)}`)
}
checkRev(baseRange, 'args.range')
if (A.extra !== undefined && A.extra !== null && !Array.isArray(A.extra)) throw new Error('pcc-review: args.extra must be an array of ranges')
const extra = (A.extra || []).slice()
extra.forEach((x, i) => checkRev(x, `args.extra[${i}]`))
const doFix = A.fix === true
const doLanes = A.lanes === true
const context = String(A.context || '').slice(0, 800)
const startRound = (A.round === undefined || A.round === null) ? 0 : parseCount(A.round, 'args.round')
const changedLines = (A.changedLines === undefined || A.changedLines === null) ? null : parseCount(A.changedLines, 'args.changedLines')
const scratchBase = A.scratch ? String(A.scratch).replace(/\/+$/, '') : ''
const limits = A.limits ? String(A.limits) : ''
const LIMITS_FALLBACK = `If ${repo}/.claude/pcc.md states memory/CPU limits for probes, tests or builds, follow them.`
const limitsRule = limits ? `Binding resource limits for every probe, test and build (follow verbatim): ${limits}` : LIMITS_FALLBACK
const NO_EXTERNAL = 'Do not create or change issue-tracker cards, PRs or any external state.'
function scratchRule(name) {
  return scratchBase
    ? `Scratch files only under ${scratchBase}/${name} and delete that directory when you finish.`
    : 'Scratch files only in a directory you create yourself with `mktemp -d -t pcc-review-XXXXXX`; delete it when you finish.'
}

// ---------------------------------------------------------------- schemas
// tried is per lens: an object with one non-empty array per lens of the group
function findingsSchema(lenses) {
  const triedProps = {}
  for (const l of lenses) triedProps[l] = { type: 'array', minItems: 1, maxItems: MAX_TRIED, items: { type: 'string', description: '<= 15 words: attack/check shape tried' } }
  return {
    type: 'object',
    properties: {
      findings: {
        type: 'array',
        maxItems: MAX_FINDINGS,
        items: {
          type: 'object',
          properties: {
            severity: { type: 'string', enum: ['HIGH', 'MEDIUM', 'LOW'] },
            file: { type: 'string' },
            line: { type: 'integer' },
            title: { type: 'string', description: '<= 15 words' },
            evidence: { type: 'string', description: '<= 50 words: exact input or measurement' },
            fix: { type: 'string', description: '<= 30 words' },
          },
          required: ['severity', 'file', 'line', 'title', 'evidence', 'fix'],
        },
      },
      tried: { type: 'object', properties: triedProps, required: lenses.slice() },
    },
    required: ['findings', 'tried'],
  }
}

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    refuted: { type: 'boolean' },
    reason: { type: 'string', description: '<= 40 words' },
  },
  required: ['refuted', 'reason'],
}

const FIX_SCHEMA = {
  type: 'object',
  properties: {
    head: { type: 'string', description: '40-hex sha of your commit' },
    base: { type: 'string', description: 'sha of HEAD before your commit' },
    summary: { type: 'string', description: '<= 60 words' },
    testsRun: { type: 'array', items: { type: 'string' } },
    concerns: { type: 'array', items: { type: 'string' } },
  },
  required: ['head', 'base', 'summary', 'testsRun', 'concerns'],
}

const LANES_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['green', 'red'] },
    lanes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          result: { type: 'string', enum: ['pass', 'fail', 'skipped'] },
          evidence: { type: 'string', description: '<= 30 words' },
        },
        required: ['name', 'result', 'evidence'],
      },
    },
  },
  required: ['verdict', 'lanes'],
}

// ---------------------------------------------------------------- lens text
const LENS_TEXT = {
  security:
    'SECURITY: server CPU/memory DoS reachable by any user (super-linear parsing, unbounded input, amplification), ' +
    'XSS or unsafe content reaching another user or another user\'s agent, auth/authorization bypass, injection, secret leakage, data exposure.',
  correctness:
    'CORRECTNESS: behaviour bugs normal users hit, data loss, wrong results, races, error paths, edge cases of the changed code, missing or wrong tests for changed behaviour.',
  simplify:
    'SIMPLIFY: needless complexity, duplicated helpers that already exist, dead code, hand-rolled code where a standard library exists. These are normally LOW unless they hide a real bug.',
}

// one agent per lens; measured 2026-10-15 on the same delta: merging correctness+simplify into one agent cost the same tokens overall and lost the simplify lens (the merged agent ran zero simplify checks; the separate simplify agent alone had found a dead regression test)
// small deltas use one agent because each agent has a ~60-65k token floor (owner decision 2026-10-15)
const SMALL = changedLines !== null && changedLines < SMALL_DELTA_LINES
const LENS_GROUPS = SMALL ? [['security', 'correctness', 'simplify']] : [['security'], ['correctness'], ['simplify']]
log(SMALL
  ? `mode: one reviewer for all three lenses (changedLines=${changedLines} < ${SMALL_DELTA_LINES})`
  : `mode: three separate reviewers (${changedLines === null ? 'changedLines not given' : `changedLines=${changedLines} >= ${SMALL_DELTA_LINES}`})`)
const triedUsable = (x, g) => !!x && !!x.tried && typeof x.tried === 'object' &&
  g.every(l => Array.isArray(x.tried[l]) && x.tried[l].some(t => typeof t === 'string' && t.trim() !== ''))

function reviewPrompt(lenses, range, roundNo) {
  const scopeRanges = [range].concat(extra)
  const scope = scopeRanges.map(x => `git diff ${x}`).join('   and   ')
  return [
    `You are a code reviewer. Lens(es): ${lenses.map(l => LENS_TEXT[l]).join('  ')}`,
    `Repo (cd there first): ${repo}`,
    `SCOPE: ONLY the changes shown by: ${scope}. Read surrounding code only to understand callers and invariants; do not report problems outside this delta.`,
    context ? `Context from the caller: ${context}` : '',
    'Your job is to REFUTE the claim "this delta is safe and correct", not to confirm it. Measure instead of guessing: build a concrete input or run the code and report what you saw.',
    'Rules:',
    '- ' + limitsRule,
    '- No docker, no servers, no Playwright. Never pkill/killall. Run long commands in the foreground.',
    '- Do not edit tracked files. ' + scratchRule(`pcc-review-${lenses.join('+')}-r${roundNo}`),
    '- ' + NO_EXTERNAL,
    scopeRanges.some(x => !x.includes('..'))
      ? 'A scope range that is a single rev (or ends at the working tree) does not show untracked new files in `git diff`: also run `git ls-files --others --exclude-standard` and review those new files as part of the delta.'
      : '',
    'If the range is empty, invalid, or the diff shows nothing, report that as a HIGH finding (file "-", line 0): an unreadable delta is not a clean delta.',
    'Severity: HIGH = server CPU/memory DoS reachable by any user, XSS/unsafe content reaching another user, data loss, auth bypass, or a correctness bug normal users hit. MEDIUM = real but limited to the user\'s own tab or needing unusual input. LOW = cleanup.',
    `Report short: at most ${MAX_FINDINGS} findings (title <= 15 words, evidence <= 50 words with exact input/measurement, fix <= 30 words) and always a "tried" object with one list per lens (${lenses.join(', ')}; <= ${MAX_TRIED} items, <= 15 words each) of the attack/check shapes you tried under EACH lens, even when you found nothing. An empty list for any lens is rejected.`,
  ].filter(Boolean).join('\n')
}

function verifyPrompt(f, range, roundNo, idx) {
  return [
    `You are a skeptic. Repo (cd there): ${repo}. Delta: git diff ${range}${extra.length ? ' (plus ' + extra.join(', ') + ')' : ''}.`,
    'A reviewer claims this HIGH finding. Try to REFUTE it: reproduce it, or show it is unreachable, bounded, already handled, or not in the delta. Refute ONLY with concrete evidence (a measurement, or a code path showing it is unreachable, bounded, already handled, or outside the delta). If you cannot show that, answer refuted=false.',
    `Finding: [${f.severity}] ${f.file}:${f.line} - ${f.title}`,
    `Evidence: ${f.evidence}`,
    `Suggested fix: ${f.fix}`,
    limitsRule,
    `No docker/servers/Playwright, never pkill/killall, no edits to tracked files. ${scratchRule(`pcc-review-verify-r${roundNo}-${idx}`)} ${NO_EXTERNAL}`,
    'Return refuted (boolean) and reason (<= 40 words).',
  ].join('\n')
}

function fixPrompt(items) {
  return [
    `You are the fixer. Work ONLY in ${repo} on its current branch (cd there). Never touch other branches or worktrees.`,
    'Fix every finding below (all are verified HIGH or MEDIUM). Keep each change minimal and behaviour-preserving apart from the fix.',
    'Findings:',
    ...items.map((f, i) => `${i + 1}. [${f.severity}] ${f.file}:${f.line} - ${f.title}\n   evidence: ${f.evidence}\n   suggested fix: ${f.fix}`),
    'Stage and commit ONLY the files you change for these findings (git add <paths>; never git add -A / commit -a); leave any other uncommitted changes in the tree untouched.',
    'Steps: record `git rev-parse HEAD` as base; make the fixes; add or adjust tests; run ONLY the touched tests; commit ONCE.',
    limitsRule,
    NO_EXTERNAL,
    'Commit rules: English message with a conventional prefix (fix(scope): ...); never push, never amend, never rebase, no git checkout/restore of work files. Do not pkill/killall; no docker/servers. Run long commands in the foreground.',
    'If you decide to skip, disable, or weaken anything, or accept a risk, list it in concerns.',
    'Return head (the 40-hex sha of your commit), base (sha before it), summary (<= 60 words), testsRun, concerns.',
  ].join('\n')
}

function lanesPrompt(head) {
  return [
    `Run this repo's PCC, tier "sweep", per ${repo}/.claude/pcc.md on ${head ? 'HEAD = ' + head : 'the current HEAD'}. cd to ${repo}.`,
    `Run every lane the adapter lists for the sweep tier, in the foreground, with the resource limits the adapter names. ${limitsRule} Never pkill/killall; do not touch other dev servers or docker you did not start. ${NO_EXTERNAL}`,
    'Read the artifacts (reports, logs, junit/json), never trust exit codes alone. Do not commit or push. A lane that could not run is "skipped" with the reason, and a skipped required lane makes the verdict red.',
    'Return verdict green|red and lanes [{name, result pass|fail|skipped, evidence <= 30 words}].',
  ].join('\n')
}

// ---------------------------------------------------------------- code helpers
const tried = {}
const debt = []
const refutedHigh = []
let high = []
let medium = []
let roundsUsed = 0
let head = null
let range = baseRange
let status = null
let lanes = null
let note = null
const uncovered = []

if (startRound >= MAX_ROUNDS) {
  log(`round budget already spent: args.round=${startRound} >= MAX_ROUNDS=${MAX_ROUNDS}; no review run, no more patching`)
  status = 'structural'
  note = 'round budget exhausted before this run; take a structural decision with the user'
}

// ---------------------------------------------------------------- main loop
while (!status) {
  const roundNo = startRound + roundsUsed + 1
  roundsUsed++

  phase('Review')
  const reports = await parallel(LENS_GROUPS.map(g => async () => {
    const gk = g.join('+')
    const opts = { phase: 'Review', model: REVIEW_MODEL, schema: findingsSchema(g) }
    const attempts = [await agent(reviewPrompt(g, range, roundNo), { ...opts, label: `r${roundNo}:${gk}` })]
    if (!triedUsable(attempts[0], g)) {
      log(`r${roundNo}: reviewer ${gk} returned nothing or unusable tried coverage, retrying once (findings of both attempts are kept)`)
      attempts.push(await agent(reviewPrompt(g, range, roundNo), { ...opts, label: `r${roundNo}:${gk}:retry` }))
    }
    return { g, attempts }
  }))

  const raw = []
  for (const rep of reports) {
    const gk = rep.g.join('+')
    if (!rep.attempts.some(x => triedUsable(x, rep.g))) {
      uncovered.push(...rep.g)
      log(`r${roundNo}: lens uncovered after retry: ${gk} -> final status will be blocked (its findings are still processed)`)
    }
    for (const x of rep.attempts) {
      if (!x) continue
      for (const l of rep.g) {
        const list = x.tried && Array.isArray(x.tried[l]) ? x.tried[l].filter(t => typeof t === 'string' && t.trim() !== '') : []
        if (!tried[l]) tried[l] = []
        tried[l].push(...list.map(t => `r${roundNo}: ${t}`))
      }
      if (Array.isArray(x.findings)) raw.push(...x.findings.map(fd => ({ ...fd, lens: gk })))
    }
  }
  if (!raw.length) log(`r${roundNo}: no findings from any lens`)
  const merged = raw
  const highs = merged.filter(f => f.severity === 'HIGH')
  const mediums = merged.filter(f => f.severity === 'MEDIUM')
  debt.push(...merged.filter(f => f.severity === 'LOW'))

  phase('Verify')
  let survivors = []
  if (highs.length) {
    const verdicts = await parallel(highs.map((f, i) => () =>
      agent(verifyPrompt(f, range, roundNo, i + 1), {
        label: `r${roundNo}:verify${i + 1}`,
        phase: 'Verify',
        model: REVIEW_MODEL,
        schema: VERDICT_SCHEMA,
      })))
    highs.forEach((f, i) => {
      const v = verdicts[i]
      if (v && v.refuted === true) {
        log(`r${roundNo}: HIGH dropped as refuted - ${f.file}:${f.line} ${f.title} (${v.reason})`)
        refutedHigh.push({ ...f, round: roundNo, reason: v.reason })
      } else if (!v) {
        log(`r${roundNo}: verifier failed, HIGH kept unverified - ${f.file}:${f.line} ${f.title}`)
        survivors.push({ ...f, unverified: true })
      } else {
        survivors.push(f)
      }
    })
  } else {
    log(`r${roundNo}: no HIGH findings, verify skipped`)
  }

  high = survivors
  medium = mediums
  const actionable = survivors.concat(mediums)

  if (!actionable.length) { status = 'ship'; break }

  if (!doFix) {
    log(`r${roundNo}: fix=false, not fixing ${survivors.length} HIGH / ${mediums.length} MEDIUM; returning findings`)
    status = survivors.length ? 'blocked' : 'ship'
    break
  }

  if (roundNo >= MAX_ROUNDS) {
    // A fix after the last review would ship code no review has read.
    if (survivors.length) {
      log(`r${roundNo}: HIGH survives the last allowed round -> structural, no more patching`)
      status = 'structural'
    } else {
      log(`r${roundNo}: last round, ${mediums.length} MEDIUM left unfixed (a fix now would be unreviewed); returned in medium[]`)
      status = 'ship'
    }
    break
  }

  phase('Fix')
  const fx = await agent(fixPrompt(actionable), {
    label: `r${roundNo}:fix`,
    phase: 'Fix',
    model: FIX_MODEL,
    schema: FIX_SCHEMA,
  })
  if (!fx || !/^[0-9a-f]{40}$/.test(fx.head) || !/^[0-9a-f]{40}$/.test(fx.base) || fx.base === fx.head) {
    log(`r${roundNo}: fixer failed or returned a bad/empty sha range; the fixer may have committed unreviewed code -> blocked`)
    status = 'blocked'
    note = 'fixer failed or returned a bad sha range; HEAD may hold an unreviewed commit - inspect or revert HEAD before shipping'
    break
  }
  if (fx.concerns && fx.concerns.length) log(`r${roundNo}: fixer concerns (orchestrator must read before merge): ${fx.concerns.join(' | ')}`)
  head = fx.head
  range = `${fx.base}..${fx.head}`
  extra.length = 0 // the fix delta is reviewed alone; earlier ranges were already reviewed
  log(`r${roundNo}: fixed ${actionable.length} finding(s) in ${range}; next round reviews only this delta`)
}

// ---------------------------------------------------------------- uncovered lens guard
if (uncovered.length && status !== 'structural') {
  const u = Array.from(new Set(uncovered)).join(', ')
  log(`status forced to blocked: lens uncovered: ${u}`)
  status = 'blocked'
  note = (note ? note + '; ' : '') + `lens uncovered: ${u}`
}

// ---------------------------------------------------------------- lanes
if (status === 'ship' && doLanes) {
  phase('Lanes')
  lanes = await agent(lanesPrompt(head), {
    label: 'lanes',
    phase: 'Lanes',
    model: LANES_MODEL,
    schema: LANES_SCHEMA,
  })
  const laneList = lanes && Array.isArray(lanes.lanes) ? lanes.lanes : []
  const skippedLanes = laneList.filter(l => l.result === 'skipped').map(l => l.name)
  if (skippedLanes.length) note = (note ? note + '; ' : '') + `lanes skipped: ${skippedLanes.join(', ')}`
  if (!lanes || lanes.verdict !== 'green' || !laneList.length || laneList.some(l => l.result === 'fail') || !laneList.some(l => l.result === 'pass')) {
    log('lanes: red, failed lane, empty lanes, no passing lane or no result -> status blocked')
    status = 'blocked'
  }
} else if (doLanes) {
  log(`lanes skipped: final status is ${status}, not ship`)
}

return { status, roundsUsed, head, high, medium, debt, refutedHigh, tried, lanes, note, uncovered }
