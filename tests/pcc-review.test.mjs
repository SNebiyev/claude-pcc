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
const reviews = calls => calls.filter(c => /^r\d+:[a-z+]+(:retry)?$/.test(c))

test('fixer short sha -> blocked', async () => {
  const { r } = await run({ ...A, fix: true }, l => l.includes(':fix') ? { head: 'abc1234', base: H40('a'), summary: '', testsRun: [], concerns: [] }
    : l.startsWith('r1:correctness') ? { findings: [f('MEDIUM', 'a.js', 10, 'm')] } : clean())
  assert.equal(r.status, 'blocked')
  assert.match(r.note, /HEAD/)
})

test('fixer base == head -> blocked', async () => {
  const { r } = await run({ ...A, fix: true }, l => l.includes(':fix') ? { head: H40('a'), base: H40('a'), summary: '', testsRun: [], concerns: [] }
    : l.startsWith('r1:correctness') ? { findings: [f('MEDIUM', 'a.js', 10, 'm')] } : clean())
  assert.equal(r.status, 'blocked')
})

test('refuted HIGH does not hide a distinct HIGH from another lens', async () => {
  const { r } = await run(A, l => {
    if (l.startsWith('r1:security')) return { findings: [f('HIGH', 'a.js', 10, 'xss')] }
    if (l.startsWith('r1:correctness')) return { findings: [f('HIGH', 'a.js', 12, 'data loss')] }
    if (l.includes('verify1')) return { refuted: true, reason: 'r' }
    if (l.includes('verify2')) return { refuted: false, reason: 'r' }
    return clean()
  })
  assert.equal(r.high.length, 1)
  assert.equal(r.status, 'blocked')
})

test('BUG dedup: refuted HIGH does not erase a distinct HIGH 2 lines away in the same lens', async () => {
  const { r, calls } = await run(A, l => {
    if (l === 'r1:security') return { findings: [f('HIGH', 'a.js', 10, 'xss'), f('HIGH', 'a.js', 12, 'authz bypass')] }
    if (l.includes('verify1')) return { refuted: true, reason: 'r' }
    if (l.includes('verify2')) return { refuted: false, reason: 'r' }
    return clean()
  })
  assert.equal(calls.filter(c => c.includes(':verify')).length, 2)
  assert.equal(r.high.length, 1)
  assert.equal(r.high[0].title, 'authz bypass')
  assert.notEqual(r.status, 'ship')
})

test('BUG retry: attempt-1 HIGH with empty tried + clean retry keeps and verifies the HIGH', async () => {
  const { r, calls } = await run(A, l => {
    if (l === 'r1:security') return { findings: [f('HIGH', 'a.js', 10, 'xss')], tried: { security: [] } }
    if (l.includes('verify')) return { refuted: false, reason: 'r' }
    return clean()
  })
  assert.ok(calls.includes('r1:security:retry'))
  assert.ok(calls.includes('r1:verify1'))
  assert.equal(r.high.length, 1)
  assert.notEqual(r.status, 'ship')
  assert.deepEqual(r.uncovered, [])
})

test('BUG retry: both attempts unusable -> lens uncovered, blocked, findings still kept', async () => {
  const { r } = await run(A, l => {
    if (l.startsWith('r1:security')) return { findings: [f('MEDIUM', 'a.js', 10, l.endsWith(':retry') ? 'm2' : 'm1')], tried: { security: [] } }
    return clean()
  })
  assert.equal(r.status, 'blocked')
  assert.deepEqual(r.uncovered, ['security'])
  assert.equal(r.medium.length, 2) // both attempts' findings are kept
})

test('retry findings of both attempts are merged', async () => {
  const { r } = await run(A, l => {
    if (l === 'r1:simplify') return { findings: [f('LOW', 'a.js', 1, 'l1')], tried: { simplify: [] } }
    if (l === 'r1:simplify:retry') return { findings: [f('LOW', 'b.js', 2, 'l2')] }
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
  const { r } = await run(A, l => l.startsWith('r1:security') ? { findings: [], tried: { security: ['', '   '] } } : clean())
  assert.deepEqual(r.uncovered, ['security'])
  assert.equal(r.status, 'blocked')
  const ok = await run(A, l => l.startsWith('r1:security') ? { findings: [], tried: { security: ['', 'real'] } } : clean())
  assert.equal(ok.r.status, 'ship')
  assert.deepEqual(ok.r.tried.security, ['r1: real'])
})

test('three separate mode: tried keyed by single lens with round prefix; missing or >=100 changedLines', async () => {
  for (const cl of [undefined, 150, 100, '100']) {
    const { r, calls } = await run({ ...A, changedLines: cl }, clean)
    assert.deepEqual(reviews(calls).sort(), ['r1:correctness', 'r1:security', 'r1:simplify'])
    assert.deepEqual(Object.keys(r.tried).sort(), ['correctness', 'security', 'simplify'])
    assert.deepEqual(r.tried.security, ['r1: t'])
  }
})

test('BUG small delta: changedLines=50 -> one reviewer for all three lenses', async () => {
  const { r, calls, prompts } = await run({ ...A, changedLines: 50 }, clean)
  assert.deepEqual(reviews(calls), ['r1:security+correctness+simplify'])
  assert.deepEqual(Object.keys(r.tried).sort(), ['correctness', 'security', 'simplify'])
  assert.deepEqual(r.tried.correctness, ['r1: t'])
  assert.match(prompts['r1:security+correctness+simplify'], /EACH lens/)
  assert.equal(r.status, 'ship')
  const z = await run({ ...A, changedLines: '0' }, clean)
  assert.equal(reviews(z.calls).length, 1)
})

test('BUG small delta: merged agent with one lens tried empty -> retry, then uncovered', async () => {
  const a = await run({ ...A, changedLines: 50 }, l => l === 'r1:security+correctness+simplify' ? { findings: [], tried: { simplify: [] } } : clean())
  assert.deepEqual(reviews(a.calls), ['r1:security+correctness+simplify', 'r1:security+correctness+simplify:retry'])
  assert.equal(a.r.status, 'ship')
  const b = await run({ ...A, changedLines: 50 }, () => ({ findings: [f('LOW', 'a.js', 1, 'l')], tried: { simplify: [] } }))
  assert.equal(b.r.status, 'blocked')
  assert.deepEqual(b.r.uncovered.sort(), ['correctness', 'security', 'simplify'])
  assert.equal(b.r.debt.length, 1) // the identical finding of the retry is an exact duplicate
  assert.equal(b.r.debt[0].lens, 'security+correctness+simplify')
})

test('untracked-file instruction only for a single-rev range', async () => {
  const one = await run({ ...A, range: 'main' }, clean)
  assert.match(one.prompts['r1:security'], /git ls-files --others --exclude-standard/)
  const two = await run(A, clean)
  assert.doesNotMatch(two.prompts['r1:security'], /ls-files/)
})

test('BUG strict args: bad range / extra / round / changedLines throw', async () => {
  for (const range of ['a b', '--output=x', 'a;b', '', 5, '$(x)']) await assert.rejects(run({ ...A, range }, clean), /range|required/, `range ${JSON.stringify(range)}`)
  for (const extra of [['a b'], [5], 'HEAD', ['ok', '-x']]) await assert.rejects(run({ ...A, extra }, clean), /extra/, `extra ${JSON.stringify(extra)}`)
  for (const round of [true, false, [1], '', ' 1 ', '0x1', -3, 'x', 1.5, {}]) await assert.rejects(run({ ...A, round }, clean), /round/, `round ${JSON.stringify(round)}`)
  for (const changedLines of [-1, '1.5', true, 'x', 1.5, '', [5], ' 5']) await assert.rejects(run({ ...A, changedLines }, clean), /changedLines/, `changedLines ${JSON.stringify(changedLines)}`)
  for (const range of ['main', 'a..b', 'a...b', 'HEAD~2', 'origin/main..HEAD', 'HEAD@{1}', 'v1.2.3^']) await run({ ...A, range }, clean)
})

test('round arg validated', async () => {
  const { r, calls } = await run({ ...A, round: '2' }, clean)
  assert.equal(r.status, 'structural')
  assert.equal(calls.length, 0)
  const z = await run({ ...A, round: 0 }, clean)
  assert.equal(z.r.status, 'ship')
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
  const { r, calls } = await run(A, l => { if (l === 'r1:security') throw new Error('boom'); return clean() })
  assert.ok(calls.includes('r1:security:retry'))
  assert.equal(r.status, 'ship')
  assert.deepEqual(r.uncovered, [])
})

test('ITEM1 reviewer throws twice -> uncovered, blocked, no crash', async () => {
  const { r } = await run(A, l => { if (l.startsWith('r1:security')) throw new Error('boom'); return clean() })
  assert.equal(r.status, 'blocked')
  assert.deepEqual(r.uncovered, ['security'])
  const all = await run({ ...A, changedLines: 5 }, () => { throw new Error('boom') })
  assert.equal(all.r.status, 'blocked')
  assert.deepEqual(all.r.uncovered.sort(), FULL.slice().sort())
})

test('ITEM2 non-array findings with usable tried are unusable -> retry -> uncovered, blocked', async () => {
  for (const bad of [null, 'none', {}]) {
    const { r, calls } = await run(A, l => l.startsWith('r1:security') ? { raw: { findings: bad, tried: { security: ['x'] } } } : clean())
    assert.ok(calls.includes('r1:security:retry'), JSON.stringify(bad))
    assert.equal(r.status, 'blocked', JSON.stringify(bad))
    assert.deepEqual(r.uncovered, ['security'])
  }
  const ok = await run(A, l => l === 'r1:security' ? { raw: { findings: null, tried: { security: ['x'] } } } : clean())
  assert.equal(ok.r.status, 'ship') // a usable retry covers the lens
})

test('ITEM3 small mode is off whenever extra is given', async () => {
  const { calls } = await run({ ...A, changedLines: 10, extra: ['HEAD'] }, clean)
  assert.deepEqual(reviews(calls).sort(), ['r1:correctness', 'r1:security', 'r1:simplify'])
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

test('ITEM5 round 2 mode follows the fixer changedLines', async () => {
  const base = l => l === 'r1:correctness' ? { findings: [f('MEDIUM', 'a.js', 1, 'm')] } : clean()
  const fixer = cl => ({ head: H40('b'), base: H40('a'), summary: '', testsRun: [], concerns: [], ...(cl === undefined ? {} : { changedLines: cl }) })
  const small = await run({ ...A, fix: true, changedLines: 500 }, l => l.includes(':fix') ? fixer(20) : base(l))
  assert.deepEqual(reviews(small.calls).filter(c => c.startsWith('r2')), ['r2:security+correctness+simplify'])
  for (const cl of [undefined, 150, -1, '20', 1.5]) {
    const big = await run({ ...A, fix: true, changedLines: 500 }, l => l.includes(':fix') ? fixer(cl) : base(l))
    assert.deepEqual(reviews(big.calls).filter(c => c.startsWith('r2')).sort(), ['r2:correctness', 'r2:security', 'r2:simplify'], String(cl))
  }
})

test('ITEM6 exact duplicate across attempts is dropped; near-duplicates are kept', async () => {
  const { r, calls } = await run(A, l => {
    if (l === 'r1:security') return { findings: [f('HIGH', 'a.js', 10, 'xss')], tried: { security: [] } }
    if (l === 'r1:security:retry') return { findings: [f('HIGH', 'a.js', 10, 'xss'), f('HIGH', 'a.js', 11, 'xss')] }
    if (l.includes('verify')) return { refuted: false, reason: 'r' }
    return clean()
  })
  assert.equal(calls.filter(c => c.includes(':verify')).length, 2)
  assert.equal(r.high.length, 2)
})

test('ITEM10 small mode: tried missing a lens key -> retry -> uncovered, blocked', async () => {
  const { r, calls } = await run({ ...A, changedLines: 5 }, () => ({ raw: { findings: [], tried: { security: ['a'], correctness: ['b'] } } }))
  assert.equal(reviews(calls).length, 2)
  assert.equal(r.status, 'blocked')
  assert.deepEqual(r.uncovered.sort(), FULL.slice().sort())
})
