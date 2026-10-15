// pcc-review v2 - ONE review per batch, a narrow fix-check of the fix diff, then a hard stop.
// Call: Workflow({name: "pcc:pcc-review", args: {...}})
// args:
//   repo     (required) absolute path of the repo
//   range    (required) the delta to review: "<base>..<head>" / "<base>...<head>", or a single rev "<base>"
//            (a single rev = <base> against the WORKING TREE, so uncommitted edits are in the delta; run
//            `git add -N <new files>` first, otherwise untracked files are invisible to git diff)
//   extra?   more ranges to review in the same review (array, same forms as range)
//   changedLines? non-negative integer: sum of added+deleted lines of `git diff --numstat <range>` (new files included via `git add -N`).
//            code tier: ONE reviewer covers all lenses only when changedLines < 100 AND extra is empty; missing,
//            >= 100, or any extra entry -> separate reviewers per lens.
//   tier?    'code' (default) | 'docs'. docs = one reviewer with lenses docs+simplify (docs, README, agent/policy text).
//   security? boolean, default true. false drops the security lens (caller: every file of the delta matches the adapter's low_risk_paths; otherwise true).
//   fix?     true -> a sonnet fixer commits once for the surviving HIGH+MEDIUM findings, then ONE opus fix-check reads only that
//            fix diff. Max 2 fix cycles; blockers left after cycle 2 -> 'structural'.
//   lanes?   true -> after a ship verdict, run the repo's PCC sweep lanes per <repo>/.claude/pcc.md
//   context? short caller note for the reviewers (cut to 800 chars)
//   scratch? base dir for agent scratch files; without it each agent makes its own with mktemp -d
//   limits?  free text, a binding resource rule for probes/tests/builds, e.g.
//            "probes: systemd-run --user --scope -q -p MemoryMax=3G -p MemorySwapMax=0 <cmd>; tests/builds: MemoryMax=6G"
//   round    REMOVED in v2: passing it throws.
// Leftover MEDIUMs (after a fix-check) go to medium[] for cards and never start another cycle.
// returns { status: 'ship'|'blocked'|'structural', mode, fixCycles, head, high, medium, debt, refutedHigh,
//           tried, fixChecks, lanes, note, uncovered }. tried is keyed by lens. 'blocked' or a non-empty `uncovered` is not a ship.

export const meta = {
  name: 'pcc-review',
  description: 'PCC review v2: one delta-only review per batch (1-3 Opus agents by risk tier), skeptic per HIGH, sonnet fixer, Opus fix-check of the fix diff only, optional PCC lanes',
  whenToUse: 'PCC review gate for any repo with a .claude/pcc.md; one review, max 2 fix cycles, then ship or structural',
  phases: [
    { title: 'Review', detail: 'security | correctness | simplify (or docs | simplify) on the delta only, once', model: 'opus' },
    { title: 'Verify', detail: 'one skeptic per HIGH finding, default refuted', model: 'opus' },
    { title: 'Fix', detail: 'one fixer for all surviving HIGH+MEDIUM, one commit; structural if too big', model: 'sonnet' },
    { title: 'Fix-check', detail: 'one reviewer reads only the fix diff: findings fixed? anything new introduced?', model: 'opus' },
    { title: 'Lanes', detail: 'repo PCC sweep per .claude/pcc.md', model: 'sonnet' },
  ],
}

// ---------------------------------------------------------------- policy
const REVIEW_MODEL = 'opus'      // reviewers, verifiers, fix-check: judgment work never on sonnet
const FIX_MODEL = 'sonnet'
const LANES_MODEL = 'sonnet'
const SMALL_DELTA_LINES = 100    // changedLines below this -> one reviewer for all lenses
const MAX_FINDINGS = 8
const MAX_TRIED = 10
const GIT_MODEL = 'haiku'        // read-only git probes (HEAD before/after the fixer); the script trusts git, not the fixer's word
const SHA = /^[0-9a-f]{40}$/
const DUP_SIM = 0.8             // title word overlap (Jaccard) needed to merge two near-line HIGHs
const DUP_SIM_SAME_LINE = 0.5  // a looser overlap is enough when both findings sit on the very same line
const DUP_LINE_WINDOW = 5       // two HIGHs in one file this many lines apart with similar titles share one root cause
const MAX_FIX_CYCLES = 2         // fix + fix-check cycles per batch; blockers after the last one -> structural
const FIX_STRUCTURAL_LINES = 150 // a fix bigger than this is a redesign: the fixer must not write it

// ---------------------------------------------------------------- args
const A = args || {}
const repo = A.repo
const baseRange = A.range
if (!repo || !baseRange) throw new Error('pcc-review: args.repo and args.range are required')
// a rev is one side, or two sides split on the FIRST '...' / '..'; braces only in the @{...} form (no shell brace expansion)
const REV_SIDE = /^(?:[\w\/^~.-]|@\{[\w.-]*\})+$/
function checkRev(x, what) {
  const bad = () => new Error(`pcc-review: ${what} must be a single rev or a..b / a...b, got ${JSON.stringify(x)}`)
  if (typeof x !== 'string') throw bad()
  const i2 = x.indexOf('..')
  let sides = [x]
  if (i2 !== -1) {
    const sep = x.startsWith('...', i2) ? '...' : '..'
    sides = [x.slice(0, i2), x.slice(i2 + sep.length)]
  }
  for (const side of sides) {
    if (!side || side.includes('..') || side.startsWith('-') || side.startsWith('~') || !REV_SIDE.test(side)) throw bad()
  }
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
if (A.round !== undefined) throw new Error('pcc-review v2: args.round was removed - v2 runs one review per batch; a batch that needs more is a structural decision')
const tier = (A.tier === undefined || A.tier === null) ? 'code' : A.tier
if (tier !== 'code' && tier !== 'docs') throw new Error(`pcc-review: args.tier must be 'code' or 'docs', got ${JSON.stringify(A.tier)}`)
if (A.security !== undefined && A.security !== null && typeof A.security !== 'boolean') throw new Error('pcc-review: args.security must be a boolean')
const useSecurity = A.security !== false
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
const FINDING_PROPS = {
  severity: { type: 'string', enum: ['HIGH', 'MEDIUM', 'LOW'] },
  file: { type: 'string' },
  line: { type: 'integer' },
  title: { type: 'string', description: '<= 15 words' },
  evidence: { type: 'string', description: '<= 50 words: file:line and the concrete failure scenario' },
  fix: { type: 'string', description: '<= 30 words' },
}
const FINDING_ITEM = { type: 'object', properties: FINDING_PROPS, required: ['severity', 'file', 'line', 'title', 'evidence', 'fix'] }

// tried is per lens: an object with one non-empty array per lens of the group
function findingsSchema(lenses) {
  const triedProps = {}
  for (const l of lenses) triedProps[l] = { type: 'array', minItems: 1, maxItems: MAX_TRIED, items: { type: 'string', description: '<= 15 words: attack/check shape tried' } }
  return {
    type: 'object',
    properties: {
      findings: { type: 'array', maxItems: MAX_FINDINGS, items: FINDING_ITEM },
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
    structural: { type: 'boolean', description: `true when the fix needs more than ~${FIX_STRUCTURAL_LINES} changed lines or a redesign: you made NO commit` },
    reason: { type: 'string', description: 'why the fix is structural (<= 40 words)' },
    head: { type: 'string', description: '40-hex sha of your commit (structural: the current HEAD)' },
    base: { type: 'string', description: 'sha of HEAD before your commit (structural: the current HEAD)' },
    summary: { type: 'string', description: '<= 60 words' },
    changedLines: { type: 'integer', minimum: 0, description: 'added+deleted lines of `git diff --numstat <base>..<head>` for your commit (structural: 0)' },
    testsRun: { type: 'array', items: { type: 'string' } },
    concerns: { type: 'array', items: { type: 'string' } },
  },
  required: ['head', 'base', 'summary', 'changedLines', 'testsRun', 'concerns'],
}

const GIT_SCHEMA = {
  type: 'object',
  properties: {
    head: { type: 'string', description: 'exact output of `git rev-parse HEAD` (40 hex)' },
    commits: { type: 'integer', minimum: 0, description: 'number of commits in `git rev-list --count <pre>..HEAD` (post probe only)' },
    changedLines: { type: 'integer', minimum: 0, description: 'added+deleted lines summed from `git diff --numstat <pre>..HEAD` (post probe only; binary files count 0)' },
  },
  required: ['head'],
}
// the post-fix probe must report all three: a missing value blocks, the fixer's own numbers are never a fallback
const POST_GIT_SCHEMA = { ...GIT_SCHEMA, required: ['head', 'commits', 'changedLines'] }

const CHECK_SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer', description: 'number of the finding in the list you were given' },
          fixed: { type: 'boolean' },
          note: { type: 'string', description: '<= 20 words' },
        },
        required: ['index', 'fixed', 'note'],
      },
    },
    newFindings: { type: 'array', maxItems: 5, items: FINDING_ITEM },
    tried: { type: 'array', minItems: 1, maxItems: MAX_TRIED, items: { type: 'string', description: '<= 15 words: check shape tried' } },
  },
  required: ['results', 'newFindings', 'tried'],
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
  docs:
    'DOCS: factual accuracy against the code the text describes, contradictions, steps an agent or user could misread, missing steps; ' +
    'for agent/policy instructions also anything that grants access or leaks data. Wording and style preferences are LOW. ' +
    'The delta is expected to be text only: if it touches code, config or scripts, report that as a HIGH (file, line 0) because the security and correctness lenses did not run.',
}

// Risk tiers (owner decision 2026-10-15): docs -> one agent; small code delta -> one agent; otherwise one agent per lens
// (measured: each agent has a ~60-65k token floor, and a merged correctness+simplify agent lost the simplify checks).
function groupsFor(lines) {
  if (tier === 'docs') {
    log('mode: docs tier -> one reviewer, lenses docs+simplify; security lens NOT run (docs tier skips it even with security=' + useSecurity + ')')
    return { mode: 'docs', groups: [['docs', 'simplify']] }
  }
  const small = lines !== null && lines < SMALL_DELTA_LINES && extra.length === 0
  const why = small
    ? `changedLines=${lines} < ${SMALL_DELTA_LINES}, no extra`
    : extra.length ? 'extra ranges given' : lines === null ? 'changedLines not given' : `changedLines=${lines} >= ${SMALL_DELTA_LINES}`
  // small delta: one agent always carries all 3 lenses; security=false only drops the security agent of a large delta
  const lenses = small || useSecurity ? ['security', 'correctness', 'simplify'] : ['correctness', 'simplify']
  log(`mode: ${small ? 'one reviewer for ' + lenses.join('+') : 'separate reviewers per lens (' + lenses.join(', ') + ')'} (${why})` +
    (small || useSecurity ? '' : '; security lens off: caller passed security=false'))
  return { mode: small ? 'small' : 'large', groups: small ? [lenses] : lenses.map(l => [l]) }
}
const cleanList = a => Array.isArray(a) ? a.filter(t => typeof t === 'string' && t.trim() !== '') : []
const cleanTried = (x, l) => x && x.tried && typeof x.tried === 'object' && !Array.isArray(x.tried) ? cleanList(x.tried[l]) : []
// usable = findings is an array (never silently treated as clean) and every lens has a non-blank tried entry
const triedUsable = (x, g) => !!x && Array.isArray(x.findings) && g.every(l => cleanTried(x, l).length > 0)

function reviewPrompt(lenses, range) {
  const scopeRanges = [range].concat(extra)
  const diffCmds = scopeRanges.map(x => `git diff -U25 ${x}`).join('  and  ')
  return [
    `You are a code reviewer. Lens(es): ${lenses.map(l => LENS_TEXT[l]).join('  ')}`,
    `Repo (cd there first): ${repo}`,
    `SCOPE: ONLY the changes of: ${scopeRanges.map(x => `git diff ${x}`).join('   and   ')}. Report only problems inside this delta.`,
    context ? `Context from the caller: ${context}` : '',
    'Look for REAL defects in the delta. Budget: at most 30 tool calls.',
    `First write ${diffCmds} into ONE file in your scratch directory and Read that file whole, once. Open surrounding code only where a caller or an invariant matters.`,
    'Do NOT build harnesses, fuzzers, corpora or benchmarks. At most ONE probe (<= 5 minutes, under the limits rule), and only to confirm a suspected HIGH.',
    'Every finding needs file:line and a concrete failure scenario (exact input or sequence and what goes wrong). A speculative "could" is LOW at most.',
    'Rules:',
    '- ' + limitsRule,
    '- No docker, no servers, no Playwright. Never pkill/killall. Run long commands in the foreground.',
    '- Do not edit tracked files. ' + scratchRule(`pcc-review-${lenses.join('+')}`),
    '- ' + NO_EXTERNAL,
    scopeRanges.some(x => !x.includes('..'))
      ? 'A scope range that is a single rev (or ends at the working tree) does not show untracked new files in `git diff`: also run `git ls-files --others --exclude-standard` and review those new files as part of the delta.'
      : '',
    'If the range is empty, invalid, or the diff shows nothing, report that as a HIGH finding (file "-", line 0): an unreadable delta is not a clean delta.',
    'Severity: HIGH = server CPU/memory DoS reachable by any user, XSS/unsafe content reaching another user, data loss, auth bypass, or a correctness bug normal users hit. MEDIUM = real but limited to the user\'s own tab or needing unusual input. LOW = cleanup.',
    `Report short: at most ${MAX_FINDINGS} findings (title <= 15 words, evidence <= 50 words with file:line and the failure scenario, fix <= 30 words) and always a "tried" object with one list per lens (${lenses.join(', ')}; <= ${MAX_TRIED} items, <= 15 words each) of the checks you made under EACH lens, even when you found nothing. An empty list for any lens is rejected.`,
  ].filter(Boolean).join('\n')
}

function verifyPrompt(f, range, idx, fixDiff) {
  return [
    `You are a skeptic. Repo (cd there): ${repo}. Delta: git diff ${range}${!fixDiff && extra.length ? ' (plus ' + extra.join(', ') + ')' : ''}${fixDiff ? ' (the fix commit; the finding was reported by the fix-check)' : ''}.`,
    'A reviewer claims this HIGH finding. Try to REFUTE it: reproduce it, or show it is unreachable, bounded, already handled, or not in the delta. Refute ONLY with concrete evidence (a measurement, or a code path showing it is unreachable, bounded, already handled, or outside the delta). If you cannot show that, answer refuted=false.',
    `Finding: [${f.severity}] ${f.file}:${f.line} - ${f.title}`,
    `Evidence: ${f.evidence}`,
    `Suggested fix: ${f.fix}${sites(f)}`,
    limitsRule,
    `No docker/servers/Playwright, never pkill/killall, no edits to tracked files. ${scratchRule(`pcc-review-verify-${idx}`)} ${NO_EXTERNAL}`,
    'Return refuted (boolean) and reason (<= 40 words).',
  ].join('\n')
}

const sites = f => (f.members || []).map(m => `\n   also at ${m.file}:${m.line} - ${m.title} (evidence: ${m.evidence}; fix: ${m.fix})`).join('')
const numbered = items => items.map((f, i) => `${i + 1}. [${f.severity}] ${f.file}:${f.line} - ${f.title}\n   evidence: ${f.evidence}\n   suggested fix: ${f.fix}${sites(f)}`)

function fixPrompt(items) {
  return [
    `You are the fixer. Work ONLY in ${repo} on its current branch (cd there). Never touch other branches or worktrees.`,
    'Fix every finding below (all are verified HIGH or MEDIUM, inside the reviewed delta). Keep each change minimal and behaviour-preserving apart from the fix.',
    `If fixing needs more than ~${FIX_STRUCTURAL_LINES} changed lines or a redesign, do not write it: make no commit and return structural=true with a reason (head and base = the current HEAD).`,
    'Findings:',
    ...numbered(items),
    'Stage and commit ONLY the files you change for these findings (git add <paths>; never git add -A / commit -a); leave any other uncommitted changes in the tree untouched.',
    'Steps: record `git rev-parse HEAD` as base; make the fixes; add or adjust tests; run ONLY the touched tests; commit ONCE.',
    limitsRule,
    NO_EXTERNAL,
    'Commit rules: English message with a conventional prefix (fix(scope): ...); never push, never amend, never rebase, no git checkout/restore of work files. Do not pkill/killall; no docker/servers. Run long commands in the foreground.',
    'If you decide to skip, disable, or weaken anything, or accept a risk, list it in concerns.',
    'Return head (the 40-hex sha of your commit), base (sha before it), summary (<= 60 words), changedLines (integer: added+deleted lines summed from `git diff --numstat <base>..<head>` after your commit), testsRun, concerns.',
  ].join('\n')
}

function checkPrompt(items, base, fixHead, idx) {
  return [
    `You are the fix-check reviewer. Repo (cd there): ${repo}. Read ONLY \`git diff ${base}..${fixHead}\` (the fix commit) and the numbered findings below. Review nothing else.`,
    '1. For each finding decide whether this diff really fixes it (results: index, fixed, note <= 20 words).',
    '2. Then report defects INTRODUCED by this diff only (lines it adds or changes) as newFindings (max 5). No review of anything else.',
    'Budget: at most 20 tool calls. At most ONE probe (<= 5 minutes, under the limits rule), and only to confirm a suspected HIGH. Every new finding needs file:line and a concrete failure scenario; a speculative "could" is LOW at most.',
    'Findings the fixer was given:',
    ...numbered(items),
    'Rules:',
    '- ' + limitsRule,
    '- No docker, no servers, no Playwright. Never pkill/killall. Do not edit tracked files. ' + scratchRule(`pcc-review-fixcheck-${idx}`),
    '- ' + NO_EXTERNAL,
    'Severity: HIGH = server CPU/memory DoS reachable by any user, XSS/unsafe content reaching another user, data loss, auth bypass, or a correctness bug normal users hit. MEDIUM = real but limited to the user\'s own tab or needing unusual input. LOW = cleanup.',
    `Return results, newFindings and a non-empty "tried" list (<= ${MAX_TRIED} items, <= 15 words each) of the checks you made, even when you found nothing.`,
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

// ---------------------------------------------------------------- state
const tried = {}
const debt = []
const refutedHigh = []
const fixChecks = []
const uncovered = []
let high = []
let medium = []
let fixCycles = 0
let head = null
let status = null
let lanes = null
let note = null
const addNote = s => { note = note ? note + '; ' + s : s }

// a throwing agent counts as a null attempt, so the retry runs
const guard = async (prompt, opts) => { try { return await agent(prompt, opts) } catch (e) { return null } }
const isObj = x => !!x && typeof x === 'object' && !Array.isArray(x)
const sameKey = fd => JSON.stringify([fd.severity, fd.file, fd.line, fd.title])
const words = t => new Set(String(t || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean))
function sameRoot(a, b) {
  if (a.file !== b.file) return false
  // never merge across sites: both lines must be known and inside the window
  if (!Number.isInteger(a.line) || !Number.isInteger(b.line) || Math.abs(a.line - b.line) > DUP_LINE_WINDOW) return false
  const wa = words(a.title), wb = words(b.title)
  const union = new Set([...wa, ...wb]).size
  if (!union) return String(a.title || '').trim() === String(b.title || '').trim() // no word tokens: exact title only
  const inter = [...wa].filter(w => wb.has(w)).length
  return inter / union >= (a.line === b.line ? DUP_SIM_SAME_LINE : DUP_SIM)
}
// HIGHs with the same root cause (same file, near line, near-identical title) get ONE skeptic; merged members stay on the group so the skeptic, fixer and fix-check see every site
function dedupHighs(list) {
  const groups = []
  for (const f of list) {
    const g = groups.find(x => sameRoot(x, f))
    if (g) {
      if (f.lens && f.lens !== g.lens && !(g.alsoFoundBy || []).includes(f.lens)) g.alsoFoundBy = (g.alsoFoundBy || []).concat(f.lens)
      g.members.push({ lens: f.lens, file: f.file, line: f.line, title: f.title, evidence: f.evidence, fix: f.fix })
      log(`HIGH merged with an earlier one (same root cause) - ${f.file}:${f.line} ${f.title}`)
    } else groups.push({ ...f, members: [] })
  }
  return groups
}
// verify groups of HIGHs: one skeptic per group; returns survivors and refuted
// prefix '' = reviewer HIGHs; `fcN` = HIGHs a fix-check found (label, tag and fixDiff derive from it)
async function verifyHighs(list, rng, prefix) {
  const groups = dedupHighs(list)
  const survivors = [], refuted = []
  if (!groups.length) return { survivors, refuted }
  const verdicts = await parallel(groups.map((f, i) => () =>
    agent(verifyPrompt(f, rng, prefix ? `${prefix}-${i + 1}` : i + 1, !!prefix), { label: prefix ? `verify:${prefix}:${i + 1}` : `verify${i + 1}`, phase: 'Verify', model: REVIEW_MODEL, schema: VERDICT_SCHEMA })))
  groups.forEach((f, i) => {
    const v = verdicts[i]
    if (v && v.refuted === true) {
      log(`HIGH dropped as refuted - ${f.file}:${f.line} ${f.title} (${v.reason})`)
      refuted.push({ ...f, reason: v.reason })
    } else if (!v) {
      log(`verifier failed, HIGH kept unverified - ${f.file}:${f.line} ${f.title}`)
      survivors.push({ ...f, unverified: true })
    } else survivors.push(f)
  })
  return { survivors, refuted }
}
function gitPrompt(pre) {
  return [
    `Read-only git probe in ${repo} (cd there). Run exactly these commands and return their facts. Change nothing; do not edit, commit, stash or checkout.`,
    '1. `git rev-parse HEAD` -> head (the 40-hex output, verbatim).',
    pre ? `2. \`git rev-list --count ${pre}..HEAD\` -> commits.` : '',
    pre ? `3. \`git diff --numstat ${pre}..HEAD\` -> changedLines = sum of added+deleted over all rows (a "-" for a binary file counts 0).` : '',
    NO_EXTERNAL,
  ].filter(Boolean).join('\n')
}

// ---------------------------------------------------------------- review (once)
phase('Review')
const { mode, groups } = groupsFor(changedLines)
const ask = (g, label) => guard(reviewPrompt(g, baseRange), { phase: 'Review', model: REVIEW_MODEL, schema: findingsSchema(g), label })
const reports = await parallel(groups.map(g => async () => {
  const gk = g.join('+')
  const attempts = [await ask(g, `review:${gk}`)]
  if (!triedUsable(attempts[0], g)) {
    log(`reviewer ${gk} returned nothing, non-array findings or unusable tried coverage, retrying once (findings of both attempts are kept)`)
    attempts.push(await ask(g, `review:${gk}:retry`))
  }
  return { g, gk, attempts }
}))

const raw = []
groups.forEach((g, i) => {
  const rep = reports[i] || { g, gk: g.join('+'), attempts: [] } // a missing report is an uncovered group, never a crash or a ship
  if (!rep.attempts.some(x => triedUsable(x, rep.g))) {
    uncovered.push(...rep.g)
    log(`lens uncovered after retry: ${rep.gk} -> final status will be blocked (its findings are still processed)`)
  }
  const seen = new Set() // exact duplicates (severity, file, line, title) of an earlier attempt are dropped
  for (const x of rep.attempts) {
    if (!x) continue
    for (const l of rep.g) {
      if (!tried[l]) tried[l] = []
      tried[l].push(...cleanTried(x, l))
    }
    if (!Array.isArray(x.findings)) continue
    const fds = x.findings.filter(isObj) // a null / non-object entry is dropped, never a crash
    const keys = fds.map(sameKey)
    fds.forEach((fd, j) => { if (!seen.has(keys[j])) raw.push({ ...fd, lens: rep.gk }) })
    keys.forEach(k => seen.add(k))
  }
})
if (!raw.length) log('no findings from any lens')
const highs = raw.filter(f => f.severity === 'HIGH')
const mediums = raw.filter(f => f.severity === 'MEDIUM')
debt.push(...raw.filter(f => f.severity === 'LOW'))

// ---------------------------------------------------------------- verify
phase('Verify')
let survivors = []
if (highs.length) {
  const vr = await verifyHighs(highs, baseRange, '')
  survivors = vr.survivors
  refutedHigh.push(...vr.refuted)
} else {
  log('no HIGH findings, verify skipped')
}

high = survivors
medium = mediums
let items = survivors.concat(mediums) // reviewers report in-delta only, so every MEDIUM is actionable

// ---------------------------------------------------------------- fix cycles
if (!items.length) {
  status = 'ship'
} else if (!doFix) {
  log(`fix=false, not fixing ${survivors.length} HIGH / ${mediums.length} MEDIUM; returning findings`)
  status = survivors.length ? 'blocked' : 'ship'
}

let range = baseRange
while (!status) {
  fixCycles++
  const cyc = `c${fixCycles}`

  phase('Fix')
  // the script reads HEAD itself (a read-only git agent) before and after the fixer: git, not the fixer's word, decides
  // cycle 1 probes HEAD; later cycles start from the head the previous post probe returned (no second probe), so a commit that
  // landed in between shows up in the post probe's commit count and blocks
  const pre = fixCycles === 1 ? await guard(gitPrompt(null), { label: `git:pre:${fixCycles}`, phase: 'Fix', model: GIT_MODEL, schema: GIT_SCHEMA }) : { head }
  if (!pre || !SHA.test(pre.head)) {
    status = 'blocked'
    addNote('could not read HEAD with git before the fix; no fixer was started')
    log(`${cyc}: ${note}`)
    break
  }
  const fx = await guard(fixPrompt(items), { label: `fix:${fixCycles}`, phase: 'Fix', model: FIX_MODEL, schema: FIX_SCHEMA })
  const post = await guard(gitPrompt(pre.head), { label: `git:post:${fixCycles}`, phase: 'Fix', model: GIT_MODEL, schema: POST_GIT_SCHEMA })
  if (!post || !SHA.test(post.head)) {
    status = 'blocked'
    addNote(`could not read HEAD with git after the fix; HEAD may hold an unreviewed commit - inspect or revert HEAD (was ${pre.head})`)
    log(`${cyc}: ${note}`)
    break
  }
  const committed = post.head !== pre.head
  if (fx && fx.structural === true) {
    const hasHigh = items.some(f => f.severity === 'HIGH')
    status = hasHigh ? 'structural' : 'ship' // the severity gate: a MEDIUM never blocks, only a HIGH goes structural
    addNote(`fixer says the fix is structural: ${fx.reason || 'no reason given'}`)
    if (!committed) {
      if (!hasHigh) addNote('MEDIUM-only batch: not blocking, shipping with medium[]')
      addNote('no commit made, HEAD == base, checked with git')
    } else {
      addNote(`WARNING: git HEAD moved from ${pre.head} to ${post.head} although the fixer said structural; the unreviewed commit is not shipped, inspect HEAD`)
      head = post.head
      if (!hasHigh) status = 'blocked' // an unreviewed commit is never shipped
    }
    if (!hasHigh) { high = []; medium = items }
    log(`${cyc}: ${note}`)
    break
  }
  if (!fx || !committed || post.commits !== 1 || !Number.isInteger(post.changedLines)) {
    status = 'blocked'
    addNote(!fx
      ? (committed ? `fixer failed but git HEAD moved (${pre.head} -> ${post.head}); HEAD holds an unreviewed commit - inspect or revert HEAD before shipping`
        : 'fixer failed and made no commit (git HEAD unchanged); inspect HEAD')
      : !committed ? 'fixer reported a fix but git HEAD did not move (no commit); inspect HEAD'
      : post.commits !== 1 ? `git shows ${Number.isInteger(post.commits) ? post.commits : 'an unknown number of'} commits after the fix, expected exactly one; HEAD holds unreviewed commits - inspect or revert HEAD (was ${pre.head})`
      : `git did not report the size of the fix commit (changedLines missing); HEAD holds an unreviewed commit - inspect or revert HEAD (was ${pre.head})`)
    if (committed) head = post.head
    log(`${cyc}: ${note}`)
    break
  }
  const fixBase = pre.head, fixHead = post.head
  if (fx.head !== fixHead || fx.base !== fixBase) {
    addNote(`fixer reported head/base ${fx.head}/${fx.base} but git says ${fixHead}/${fixBase}; the script used git`)
    log(`${cyc}: ${note}`)
  }
  const lines = post.changedLines // git's count only, never the fixer's claim
  if (lines > FIX_STRUCTURAL_LINES) {
    status = 'structural'
    addNote(`fixer's commit is ${lines} changed lines (> ${FIX_STRUCTURAL_LINES}): a redesign, not a fix; HEAD holds an unreviewed commit - inspect or revert it`)
    head = fixHead
    log(`${cyc}: ${note}`)
    break
  }
  if (fx.concerns && fx.concerns.length) log(`${cyc}: fixer concerns (orchestrator must read before merge): ${fx.concerns.join(' | ')}`)
  head = fixHead
  range = `${fixBase}..${fixHead}`
  log(`${cyc}: fixed ${items.length} finding(s) in ${range}; fix-check reads only this diff`)

  phase('Fix-check')
  const usable = x => !!x && Array.isArray(x.results) && Array.isArray(x.newFindings) && cleanList(x.tried).length > 0 &&
    x.results.every(r => r && Number.isInteger(r.index) && typeof r.fixed === 'boolean')
  let chk = await guard(checkPrompt(items, fixBase, fixHead, fixCycles), { label: `fixcheck:${fixCycles}`, phase: 'Fix-check', model: REVIEW_MODEL, schema: CHECK_SCHEMA })
  if (!usable(chk)) {
    log(`${cyc}: fix-check returned nothing or an unusable result, retrying once`)
    chk = await guard(checkPrompt(items, fixBase, fixHead, fixCycles), { label: `fixcheck:${fixCycles}:retry`, phase: 'Fix-check', model: REVIEW_MODEL, schema: CHECK_SCHEMA })
  }
  if (!usable(chk)) {
    uncovered.push('fix-check')
    status = 'blocked'
    addNote(`fix-check unusable twice for ${range}; the fix commit is unreviewed`)
    log(`${cyc}: ${note}`)
    break
  }
  const isFixed = i => chk.results.some(r => r.index === i + 1 && r.fixed === true)
  const open = items.filter((f, i) => !isFixed(i))
  const newF = chk.newFindings.filter(isObj)
  fixChecks.push({ cycle: fixCycles, base: fixBase, head: fixHead, results: chk.results, newFindings: newF, tried: cleanList(chk.tried) })
  debt.push(...newF.filter(f => f.severity === 'LOW'))
  // a HIGH the fix-check found goes through the same skeptic as a reviewer HIGH before it can block
  const vr = await verifyHighs(newF.filter(f => f.severity === 'HIGH'), range, `fc${fixCycles}`)
  refutedHigh.push(...vr.refuted)
  const blockers = open.filter(f => f.severity === 'HIGH').concat(vr.survivors)
  medium = open.filter(f => f.severity === 'MEDIUM').concat(newF.filter(f => f.severity === 'MEDIUM')) // for cards; never opens a cycle alone
  high = blockers
  log(`${cyc}: fix-check: ${items.length - open.length}/${items.length} fixed, ${blockers.length} blocker(s), ${medium.length} leftover MEDIUM`)

  if (!blockers.length) { status = 'ship'; break }
  if (fixCycles >= MAX_FIX_CYCLES) {
    status = 'structural'
    addNote(`${blockers.length} HIGH still open after fix cycle ${fixCycles}: stop patching, take a structural decision with the owner`)
    log(`${cyc}: ${note}`)
    break
  }
  items = blockers.concat(medium)
}

// ---------------------------------------------------------------- uncovered lens guard
if (uncovered.length && status !== 'structural') {
  const u = Array.from(new Set(uncovered)).join(', ')
  log(`status forced to blocked: uncovered: ${u}`)
  status = 'blocked'
  addNote(`uncovered: ${u}`)
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
  if (skippedLanes.length) addNote(`lanes skipped: ${skippedLanes.join(', ')}`)
  if (!lanes || lanes.verdict !== 'green' || !laneList.length || laneList.some(l => l.result === 'fail') || !laneList.some(l => l.result === 'pass')) {
    log('lanes: red, failed lane, empty lanes, no passing lane or no result -> status blocked')
    status = 'blocked'
  }
} else if (doLanes) {
  log(`lanes skipped: final status is ${status}, not ship`)
}

return { status, mode, fixCycles, head, high, medium, debt, refutedHigh, tried, fixChecks, lanes, note, uncovered }
