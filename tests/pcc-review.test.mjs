import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// PCC_REVIEW_SCRIPT lets a negative control point the same tests at another copy of the script
const scriptUrl = process.env.PCC_REVIEW_SCRIPT ? new URL('file://' + process.env.PCC_REVIEW_SCRIPT) : new URL('../workflows/pcc-review.js', import.meta.url)
const src = readFileSync(scriptUrl, 'utf8').replace('export const meta', 'const meta')
const AsyncFn = Object.getPrototypeOf(async function () {}).constructor
const H40 = c => c.repeat(40)

// A reviewer answer is described neutrally as {findings, tried?: {lens: [..]}}; the harness shapes `tried`
// to whatever the schema the script asked for says (per-lens object, or the old flat array).
function shape(res, schema) {
  if (!res || !schema || !schema.properties || !schema.properties.tried || !res.findings) return res
  const lenses = schema.properties.tried.type === 'object' ? Object.keys(schema.properties.tried.properties) : null
  const map = res.tried || {}
  if (lenses) {
    const tried = {}
    for (const l of lenses) tried[l] = l in map ? map[l] : ['t']
    return { findings: res.findings, tried }
  }
  return { findings: res.findings, tried: Object.keys(map).length ? Object.values(map).flat() : ['t'] }
}

function run(args, handler) {
  const calls = []
  const prompts = {}
  // {raw: X} from a handler is returned to the script unshaped; a handler that throws makes the agent call reject
  const agent = async (prompt, o) => { calls.push(o.label); prompts[o.label] = prompt; const h = handler(o.label, prompt); return h && 'raw' in h && Object.keys(h).length === 1 ? h.raw : shape(h, o.schema) }
  // like the real parallel(): a thunk that throws yields null instead of rejecting
  const parallel = fns => Promise.all(fns.map(f => f().catch(() => null)))
  return new AsyncFn('args', 'agent', 'parallel', 'phase', 'log', src)(args, agent, parallel, () => {}, () => {}).then(r => ({ r, calls, prompts }))
}
const A = { repo: '/x', range: 'a..b' }
const clean = () => ({ findings: [] })
const f = (severity, file, line, title) => ({ severity, file, line, title, evidence: 'e', fix: 'f' })
const reviews = calls => calls.filter(c => /^review:[a-z+]+(:retry)?$/.test(c))

test('fixer short sha -> blocked', async () => {
  const { r } = await run({ ...A, fix: true }, l => l.startsWith('fix:') ? { head: 'abc1234', base: H40('a'), summary: '', testsRun: [], concerns: [] }
    : l.startsWith('review:correctness') ? { findings: [f('MEDIUM', 'a.js', 10, 'm')] } : clean())
  assert.equal(r.status, 'blocked')
  assert.match(r.note, /HEAD/)
})

test('fixer base == head -> blocked', async () => {
  const { r } = await run({ ...A, fix: true }, l => l.startsWith('fix:') ? { head: H40('a'), base: H40('a'), summary: '', testsRun: [], concerns: [] }
    : l.startsWith('review:correctness') ? { findings: [f('MEDIUM', 'a.js', 10, 'm')] } : clean())
  assert.equal(r.status, 'blocked')
})

test('refuted HIGH does not hide a distinct HIGH from another lens', async () => {
  const { r } = await run(A, l => {
    if (l.startsWith('review:security')) return { findings: [f('HIGH', 'a.js', 10, 'xss')] }
    if (l.startsWith('review:correctness')) return { findings: [f('HIGH', 'a.js', 12, 'data loss')] }
    if (l.includes('verify1')) return { refuted: true, reason: 'r' }
    if (l.includes('verify2')) return { refuted: false, reason: 'r' }
    return clean()
  })
  assert.equal(r.high.length, 1)
  assert.equal(r.status, 'blocked')
})

test('BUG dedup: refuted HIGH does not erase a distinct HIGH 2 lines away in the same lens', async () => {
  const { r, calls } = await run(A, l => {
    if (l === 'review:security') return { findings: [f('HIGH', 'a.js', 10, 'xss'), f('HIGH', 'a.js', 12, 'authz bypass')] }
    if (l.includes('verify1')) return { refuted: true, reason: 'r' }
    if (l.includes('verify2')) return { refuted: false, reason: 'r' }
    return clean()
  })
  assert.equal(calls.filter(c => c.includes('verify')).length, 2)
  assert.equal(r.high.length, 1)
  assert.equal(r.high[0].title, 'authz bypass')
  assert.notEqual(r.status, 'ship')
})

test('BUG retry: attempt-1 HIGH with empty tried + clean retry keeps and verifies the HIGH', async () => {
  const { r, calls } = await run(A, l => {
    if (l === 'review:security') return { findings: [f('HIGH', 'a.js', 10, 'xss')], tried: { security: [] } }
    if (l.includes('verify')) return { refuted: false, reason: 'r' }
    return clean()
  })
  assert.ok(calls.includes('review:security:retry'))
  assert.ok(calls.includes('verify1'))
  assert.equal(r.high.length, 1)
  assert.notEqual(r.status, 'ship')
  assert.deepEqual(r.uncovered, [])
})

test('BUG retry: both attempts unusable -> lens uncovered, blocked, findings still kept', async () => {
  const { r } = await run(A, l => {
    if (l.startsWith('review:security')) return { findings: [f('MEDIUM', 'a.js', 10, l.endsWith(':retry') ? 'm2' : 'm1')], tried: { security: [] } }
    return clean()
  })
  assert.equal(r.status, 'blocked')
  assert.deepEqual(r.uncovered, ['security'])
  assert.equal(r.medium.length, 2) // both attempts' findings are kept
})

test('retry findings of both attempts are merged', async () => {
  const { r } = await run(A, l => {
    if (l === 'review:simplify') return { findings: [f('LOW', 'a.js', 1, 'l1')], tried: { simplify: [] } }
    if (l === 'review:simplify:retry') return { findings: [f('LOW', 'b.js', 2, 'l2')] }
    return clean()
  })
  assert.equal(r.debt.length, 2)
  assert.equal(r.status, 'ship')
})

test('empty tried on every lens -> uncovered, blocked', async () => {
  const { r } = await run(A, () => ({ findings: [], tried: { security: [], correctness: [], simplify: [] } }))
  assert.equal(r.status, 'blocked')
  assert.deepEqual(r.uncovered.sort(), ['correctness', 'security', 'simplify'])
})

test('BUG blank tried entries are unusable and filtered out', async () => {
  const { r } = await run(A, l => l.startsWith('review:security') ? { findings: [], tried: { security: ['', '   '] } } : clean())
  assert.deepEqual(r.uncovered, ['security'])
  assert.equal(r.status, 'blocked')
  const ok = await run(A, l => l.startsWith('review:security') ? { findings: [], tried: { security: ['', 'real'] } } : clean())
  assert.equal(ok.r.status, 'ship')
  assert.deepEqual(ok.r.tried.security, ['real'])
})

test('three separate mode: tried keyed by single lens; missing or >=100 changedLines', async () => {
  for (const cl of [undefined, 150, 100, '100']) {
    const { r, calls } = await run({ ...A, changedLines: cl }, clean)
    assert.deepEqual(reviews(calls).sort(), ['review:correctness', 'review:security', 'review:simplify'])
    assert.deepEqual(Object.keys(r.tried).sort(), ['correctness', 'security', 'simplify'])
    assert.deepEqual(r.tried.security, ['t'])
  }
})

test('BUG small delta: changedLines=50 -> one reviewer for all three lenses', async () => {
  const { r, calls, prompts } = await run({ ...A, changedLines: 50 }, clean)
  assert.deepEqual(reviews(calls), ['review:security+correctness+simplify'])
  assert.deepEqual(Object.keys(r.tried).sort(), ['correctness', 'security', 'simplify'])
  assert.deepEqual(r.tried.correctness, ['t'])
  assert.match(prompts['review:security+correctness+simplify'], /EACH lens/)
  assert.equal(r.status, 'ship')
  const z = await run({ ...A, changedLines: '0' }, clean)
  assert.equal(reviews(z.calls).length, 1)
})

test('BUG small delta: merged agent with one lens tried empty -> retry, then uncovered', async () => {
  const a = await run({ ...A, changedLines: 50 }, l => l === 'review:security+correctness+simplify' ? { findings: [], tried: { simplify: [] } } : clean())
  assert.deepEqual(reviews(a.calls), ['review:security+correctness+simplify', 'review:security+correctness+simplify:retry'])
  assert.equal(a.r.status, 'ship')
  const b = await run({ ...A, changedLines: 50 }, () => ({ findings: [f('LOW', 'a.js', 1, 'l')], tried: { simplify: [] } }))
  assert.equal(b.r.status, 'blocked')
  assert.deepEqual(b.r.uncovered.sort(), ['correctness', 'security', 'simplify'])
  assert.equal(b.r.debt.length, 1) // the identical finding of the retry is an exact duplicate
  assert.equal(b.r.debt[0].lens, 'security+correctness+simplify')
})

test('untracked-file instruction only for a single-rev range', async () => {
  const one = await run({ ...A, range: 'main' }, clean)
  assert.match(one.prompts['review:security'], /git ls-files --others --exclude-standard/)
  const two = await run(A, clean)
  assert.doesNotMatch(two.prompts['review:security'], /ls-files/)
})

test('BUG strict args: bad range / extra / changedLines / tier / security throw', async () => {
  for (const range of ['a b', '--output=x', 'a;b', '', 5, '$(x)']) await assert.rejects(run({ ...A, range }, clean), /range|required/, `range ${JSON.stringify(range)}`)
  for (const extra of [['a b'], [5], 'HEAD', ['ok', '-x']]) await assert.rejects(run({ ...A, extra }, clean), /extra/, `extra ${JSON.stringify(extra)}`)
  for (const tier of ['x', 'doc', 5, true]) await assert.rejects(run({ ...A, tier }, clean), /tier/, `tier ${JSON.stringify(tier)}`)
  for (const security of ['no', 0, 1, []]) await assert.rejects(run({ ...A, security }, clean), /security/, `security ${JSON.stringify(security)}`)
  for (const changedLines of [-1, '1.5', true, 'x', 1.5, '', [5], ' 5']) await assert.rejects(run({ ...A, changedLines }, clean), /changedLines/, `changedLines ${JSON.stringify(changedLines)}`)
  for (const range of ['main', 'a..b', 'a...b', 'HEAD~2', 'origin/main..HEAD', 'HEAD@{1}', 'v1.2.3^']) await run({ ...A, range }, clean)
})

test('failed lane or empty lanes -> blocked', async () => {
  const lanesRes = v => run({ ...A, lanes: true }, l => l === 'lanes' ? v : clean()).then(x => x.r.status)
  assert.equal(await lanesRes({ verdict: 'green', lanes: [{ name: 'e2e', result: 'fail', evidence: '' }] }), 'blocked')
  assert.equal(await lanesRes({ verdict: 'green', lanes: [] }), 'blocked')
  assert.equal(await lanesRes({ verdict: 'green', lanes: [{ name: 'u', result: 'pass', evidence: '' }] }), 'ship')
})

test('BUG lanes: all skipped with verdict green -> blocked and note lists them', async () => {
  const { r } = await run({ ...A, lanes: true }, l => l === 'lanes'
    ? { verdict: 'green', lanes: [{ name: 'e2e', result: 'skipped', evidence: '' }, { name: 'build', result: 'skipped', evidence: '' }] } : clean())
  assert.equal(r.status, 'blocked')
  assert.match(r.note, /lanes skipped: e2e, build/)
})

test('BUG lanes: one pass + one skipped -> ship, note lists the skipped lane', async () => {
  const { r } = await run({ ...A, lanes: true }, l => l === 'lanes'
    ? { verdict: 'green', lanes: [{ name: 'unit', result: 'pass', evidence: '' }, { name: 'e2e', result: 'skipped', evidence: '' }] } : clean())
  assert.equal(r.status, 'ship')
  assert.match(r.note, /lanes skipped: e2e/)
})

const FULL = ['security', 'correctness', 'simplify']

test('ITEM1 reviewer throws -> retry runs and covers the lens', async () => {
  const { r, calls } = await run(A, l => { if (l === 'review:security') throw new Error('boom'); return clean() })
  assert.ok(calls.includes('review:security:retry'))
  assert.equal(r.status, 'ship')
  assert.deepEqual(r.uncovered, [])
})

test('ITEM1 reviewer throws twice -> uncovered, blocked, no crash', async () => {
  const { r } = await run(A, l => { if (l.startsWith('review:security')) throw new Error('boom'); return clean() })
  assert.equal(r.status, 'blocked')
  assert.deepEqual(r.uncovered, ['security'])
  const all = await run({ ...A, changedLines: 5 }, () => { throw new Error('boom') })
  assert.equal(all.r.status, 'blocked')
  assert.deepEqual(all.r.uncovered.sort(), FULL.slice().sort())
})

test('ITEM2 non-array findings with usable tried are unusable -> retry -> uncovered, blocked', async () => {
  for (const bad of [null, 'none', {}]) {
    const { r, calls } = await run(A, l => l.startsWith('review:security') ? { raw: { findings: bad, tried: { security: ['x'] } } } : clean())
    assert.ok(calls.includes('review:security:retry'), JSON.stringify(bad))
    assert.equal(r.status, 'blocked', JSON.stringify(bad))
    assert.deepEqual(r.uncovered, ['security'])
  }
  const ok = await run(A, l => l === 'review:security' ? { raw: { findings: null, tried: { security: ['x'] } } } : clean())
  assert.equal(ok.r.status, 'ship') // a usable retry covers the lens
})

test('ITEM3 small mode is off whenever extra is given', async () => {
  const { calls } = await run({ ...A, changedLines: 10, extra: ['HEAD'] }, clean)
  assert.deepEqual(reviews(calls).sort(), ['review:correctness', 'review:security', 'review:simplify'])
  const one = await run({ ...A, changedLines: 10, extra: [] }, clean)
  assert.equal(reviews(one.calls).length, 1)
})

test('ITEM4 rev validity table', async () => {
  const valid = ['HEAD', 'HEAD~2', 'abc123^', 'main@{u}', 'a..b', 'a...b', 'origin/main..HEAD']
  const invalid = ['', '..', '...', 'a..', '..b', 'a..b..c', '{a..c}', '{1..9}', '{1..99999999}', '~root', '-x', '--output=x', 'a b', 'a;b']
  for (const x of valid) {
    await run({ ...A, range: x }, clean)
    await run({ ...A, extra: [x] }, clean)
  }
  for (const x of invalid) {
    await assert.rejects(run({ ...A, range: x }, clean), /range|required/, `range ${JSON.stringify(x)}`)
    await assert.rejects(run({ ...A, extra: [x] }, clean), /extra/, `extra ${JSON.stringify(x)}`)
  }
})

test('ITEM6 exact duplicate across attempts is dropped; near-duplicates are kept', async () => {
  const { r, calls } = await run(A, l => {
    if (l === 'review:security') return { findings: [f('HIGH', 'a.js', 10, 'xss')], tried: { security: [] } }
    if (l === 'review:security:retry') return { findings: [f('HIGH', 'a.js', 10, 'xss'), f('HIGH', 'a.js', 11, 'xss')] }
    if (l.includes('verify')) return { refuted: false, reason: 'r' }
    return clean()
  })
  assert.equal(calls.filter(c => c.includes('verify')).length, 2)
  assert.equal(r.high.length, 2)
})

test('ITEM10 small mode: tried missing a lens key -> retry -> uncovered, blocked', async () => {
  const { r, calls } = await run({ ...A, changedLines: 5 }, () => ({ raw: { findings: [], tried: { security: ['a'], correctness: ['b'] } } }))
  assert.equal(reviews(calls).length, 2)
  assert.equal(r.status, 'blocked')
  assert.deepEqual(r.uncovered.sort(), FULL.slice().sort())
})

// ---------------------------------------------------------------- v2
const FX = (over = {}) => ({ head: H40('b'), base: H40('a'), changedLines: 10, summary: '', testsRun: [], concerns: [], ...over })
const chk = (results, newFindings = [], tried = ['t']) => ({ raw: { results, newFindings, tried } })
const ok = i => ({ index: i, fixed: true, note: 'n' })
const notOk = i => ({ index: i, fixed: false, note: 'n' })
const mkHigh = l => l === 'review:correctness' ? { findings: [f('HIGH', 'a.js', 1, 'h')] } : l.startsWith('verify') ? { refuted: false, reason: 'r' } : clean()

test('v2 args.round throws with the removal message', async () => {
  for (const round of [0, 1, '2'])
    await assert.rejects(run({ ...A, round }, clean), /args\.round was removed/)
})

test('v2 tier docs -> one docs+simplify agent', async () => {
  const { r, calls, prompts } = await run({ ...A, tier: 'docs', changedLines: 500 }, clean)
  assert.deepEqual(reviews(calls), ['review:docs+simplify'])
  assert.equal(r.mode, 'docs')
  assert.deepEqual(Object.keys(r.tried).sort(), ['docs', 'simplify'])
  assert.match(prompts['review:docs+simplify'], /DOCS: factual accuracy/)
  assert.equal(r.status, 'ship')
})

test('v2 security=false: small keeps all 3 lenses; large -> two agents', async () => {
  const s = await run({ ...A, security: false, changedLines: 10 }, clean)
  assert.deepEqual(reviews(s.calls), ['review:security+correctness+simplify'])
  assert.equal(s.r.mode, 'small')
  const l = await run({ ...A, security: false, changedLines: 400 }, clean)
  assert.deepEqual(reviews(l.calls).sort(), ['review:correctness', 'review:simplify'])
  assert.equal(l.r.mode, 'large')
  assert.deepEqual(Object.keys(l.r.tried).sort(), ['correctness', 'simplify'])
  const t = await run({ ...A, security: true, changedLines: 10 }, clean)
  assert.deepEqual(reviews(t.calls), ['review:security+correctness+simplify'])
})

test('v2 reviewer prompt carries the budget', async () => {
  const { prompts } = await run(A, clean)
  const p = prompts['review:security']
  assert.match(p, /at most 30 tool calls/)
  assert.match(p, /git diff -U25 a\.\.b/)
  assert.match(p, /Do NOT build harnesses, fuzzers/)
  assert.match(p, /ONE probe/)
})

test('v2 clean review -> ship, no fixer, no fix-check', async () => {
  const { r, calls } = await run({ ...A, fix: true }, clean)
  assert.equal(r.status, 'ship')
  assert.equal(r.fixCycles, 0)
  assert.ok(!calls.some(c => c.startsWith('fix')))
})

test('v2 HIGH fixed and fix-check clean -> ship after one cycle', async () => {
  const { r, calls, prompts } = await run({ ...A, fix: true }, l => {
    if (l === 'fix:1') return FX()
    if (l === 'fixcheck:1') return chk([ok(1)])
    return mkHigh(l)
  })
  assert.equal(r.status, 'ship')
  assert.equal(r.fixCycles, 1)
  assert.equal(r.head, H40('b'))
  assert.deepEqual(r.high, [])
  assert.equal(calls.filter(c => c.startsWith('review:')).length, 3) // no second review
  assert.match(prompts['fixcheck:1'], new RegExp(`git diff ${H40('a')}\\.\\.${H40('b')}`))
  assert.equal(r.fixChecks.length, 1)
})

test('v2 fix-check: HIGH unfixed -> second cycle -> clean -> ship', async () => {
  const { r, calls, prompts } = await run({ ...A, fix: true }, l => {
    if (l === 'fix:1') return FX()
    if (l === 'fix:2') return FX({ head: H40('c'), base: H40('b') })
    if (l === 'fixcheck:1') return chk([notOk(1)])
    if (l === 'fixcheck:2') return chk([ok(1)])
    return mkHigh(l)
  })
  assert.equal(r.status, 'ship')
  assert.equal(r.fixCycles, 2)
  assert.equal(r.head, H40('c'))
  assert.match(prompts['fix:2'], /\[HIGH\] a\.js:1 - h/)
  assert.equal(calls.filter(c => c.startsWith('review:')).length, 3)
})

test('v2 HIGH still open after cycle 2 -> structural', async () => {
  const { r, calls } = await run({ ...A, fix: true }, l => {
    if (l.startsWith('fix:')) return FX()
    if (l.startsWith('fixcheck:')) return chk([notOk(1)])
    return mkHigh(l)
  })
  assert.equal(r.status, 'structural')
  assert.equal(r.fixCycles, 2)
  assert.equal(r.high.length, 1)
  assert.match(r.note, /structural decision/)
  assert.ok(!calls.includes('fix:3'))
})

test('v2 new HIGH from fix-check counts as a blocker', async () => {
  const { r } = await run({ ...A, fix: true }, l => {
    if (l.startsWith('fix:')) return FX()
    if (l === 'fixcheck:1') return chk([ok(1)], [f('HIGH', 'b.js', 3, 'new bug')])
    if (l === 'fixcheck:2') return chk([ok(1)])
    return mkHigh(l)
  })
  assert.equal(r.status, 'ship')
  assert.equal(r.fixCycles, 2)
})

test('v2 leftover MEDIUM alone ships with medium[] and no second cycle', async () => {
  const { r, calls } = await run({ ...A, fix: true }, l => {
    if (l === 'fix:1') return FX()
    if (l === 'fixcheck:1') return chk([notOk(1)])
    return l === 'review:correctness' ? { findings: [f('MEDIUM', 'a.js', 1, 'm')] } : clean()
  })
  assert.equal(r.status, 'ship')
  assert.equal(r.fixCycles, 1)
  assert.equal(r.medium.length, 1)
  assert.ok(!calls.includes('fix:2'))
})

test('v2 fixer structural=true -> structural with its reason', async () => {
  const { r, calls } = await run({ ...A, fix: true }, l => {
    if (l === 'fix:1') return FX({ structural: true, reason: 'needs a redesign', head: H40('a') })
    return mkHigh(l)
  })
  assert.equal(r.status, 'structural')
  assert.match(r.note, /needs a redesign/)
  assert.match(r.note, /HEAD == base/)
  assert.ok(!calls.some(c => c.startsWith('fixcheck')))
  const bad = await run({ ...A, fix: true }, l => l === 'fix:1' ? FX({ structural: true, reason: 'x' }) : mkHigh(l))
  assert.match(bad.r.note, /WARNING/)
})

test('v2 fixer commit over the line limit or without changedLines -> structural', async () => {
  for (const over of [{ changedLines: 400 }, { changedLines: undefined }]) {
    const { r, calls } = await run({ ...A, fix: true }, l => l === 'fix:1' ? FX(over) : mkHigh(l))
    assert.equal(r.status, 'structural')
    assert.ok(!calls.some(c => c.startsWith('fixcheck')))
  }
})

test('v2 fixer structural=true on a MEDIUM-only batch ships with medium[]', async () => {
  const { r } = await run({ ...A, fix: true }, l => {
    if (l === 'fix:1') return FX({ structural: true, reason: 'big', head: H40('a') })
    return l === 'review:correctness' ? { findings: [f('MEDIUM', 'a.js', 1, 'm')] } : clean()
  })
  assert.equal(r.status, 'ship')
  assert.equal(r.medium.length, 1)
})

test('v2 fix-check unusable twice -> blocked, uncovered has fix-check', async () => {
  const { r, calls } = await run({ ...A, fix: true }, l => {
    if (l === 'fix:1') return FX()
    if (l.startsWith('fixcheck:')) return chk([ok(1)], [], [])
    return mkHigh(l)
  })
  assert.deepEqual(calls.filter(c => c.startsWith('fixcheck')), ['fixcheck:1', 'fixcheck:1:retry'])
  assert.equal(r.status, 'blocked')
  assert.ok(r.uncovered.includes('fix-check'))
  const thr = await run({ ...A, fix: true }, l => { if (l.startsWith('fixcheck')) throw new Error('x'); return l === 'fix:1' ? FX() : mkHigh(l) })
  assert.ok(thr.r.uncovered.includes('fix-check'))
})

test('v2 new LOW from fix-check goes to debt', async () => {
  const { r } = await run({ ...A, fix: true }, l => {
    if (l === 'fix:1') return FX()
    if (l === 'fixcheck:1') return chk([ok(1)], [f('LOW', 'b.js', 3, 'nit')])
    return mkHigh(l)
  })
  assert.equal(r.status, 'ship')
  assert.deepEqual(r.debt.map(d => d.title), ['nit'])
})

test('v2 fix=false: HIGH -> blocked, MEDIUM only -> ship with medium[]', async () => {
  const h = await run(A, mkHigh)
  assert.equal(h.r.status, 'blocked')
  const m = await run(A, l => l === 'review:correctness' ? { findings: [f('MEDIUM', 'a.js', 1, 'm')] } : clean())
  assert.equal(m.r.status, 'ship')
  assert.equal(m.r.medium.length, 1)
})

test('v2 lanes run only on ship', async () => {
  const bad = await run({ ...A, lanes: true }, mkHigh)
  assert.ok(!bad.calls.includes('lanes'))
})
