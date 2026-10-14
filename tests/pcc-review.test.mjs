import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../workflows/pcc-review.js', import.meta.url), 'utf8').replace('export const meta', 'const meta')
const AsyncFn = Object.getPrototypeOf(async function () {}).constructor
const H40 = c => c.repeat(40)

function run(args, handler) {
  const calls = []
  const agent = async (prompt, o) => { calls.push(o.label); return handler(o.label, prompt) }
  const parallel = fns => Promise.all(fns.map(f => f()))
  return new AsyncFn('args', 'agent', 'parallel', 'phase', 'log', src)(args, agent, parallel, () => {}, () => {}).then(r => ({ r, calls }))
}
const A = { repo: '/x', range: 'a..b' }
const clean = () => ({ findings: [], tried: ['t'] })
const f = (severity, file, line, title) => ({ severity, file, line, title, evidence: 'e', fix: 'f' })

test('fixer short sha -> blocked', async () => {
  const { r } = await run({ ...A, fix: true }, l => l.includes(':fix') ? { head: 'abc1234', base: H40('a'), summary: '', testsRun: [], concerns: [] }
    : l.startsWith('r1:correctness') ? { findings: [f('MEDIUM', 'a.js', 10, 'm')], tried: ['t'] } : clean())
  assert.equal(r.status, 'blocked')
  assert.match(r.note, /HEAD/)
})

test('fixer base == head -> blocked', async () => {
  const { r } = await run({ ...A, fix: true }, l => l.includes(':fix') ? { head: H40('a'), base: H40('a'), summary: '', testsRun: [], concerns: [] }
    : l.startsWith('r1:correctness') ? { findings: [f('MEDIUM', 'a.js', 10, 'm')], tried: ['t'] } : clean())
  assert.equal(r.status, 'blocked')
})

test('refuted HIGH does not hide a distinct HIGH from another lens', async () => {
  const { r } = await run(A, l => {
    if (l.startsWith('r1:security')) return { findings: [f('HIGH', 'a.js', 10, 'xss')], tried: ['t'] }
    if (l.startsWith('r1:correctness')) return { findings: [f('HIGH', 'a.js', 12, 'data loss')], tried: ['t'] }
    if (l.includes('verify1')) return { refuted: true, reason: 'r' }
    if (l.includes('verify2')) return { refuted: false, reason: 'r' }
    return clean()
  })
  assert.equal(r.high.length, 1)
  assert.equal(r.status, 'blocked')
})

test('empty tried on every lens -> uncovered, blocked', async () => {
  const { r } = await run(A, () => ({ findings: [], tried: [] }))
  assert.equal(r.status, 'blocked')
  assert.deepEqual(r.uncovered.sort(), ['correctness', 'security', 'simplify'])
})

test('round arg validated', async () => {
  await assert.rejects(run({ ...A, round: -3 }, clean))
  await assert.rejects(run({ ...A, round: 'x' }, clean))
  const { r, calls } = await run({ ...A, round: '2' }, clean)
  assert.equal(r.status, 'structural')
  assert.equal(calls.length, 0)
})

test('failed lane or empty lanes -> blocked', async () => {
  const lanesRes = v => run({ ...A, lanes: true }, l => l === 'lanes' ? v : clean()).then(x => x.r.status)
  assert.equal(await lanesRes({ verdict: 'green', lanes: [{ name: 'e2e', result: 'fail', evidence: '' }] }), 'blocked')
  assert.equal(await lanesRes({ verdict: 'green', lanes: [] }), 'blocked')
  assert.equal(await lanesRes({ verdict: 'green', lanes: [{ name: 'u', result: 'pass', evidence: '' }] }), 'ship')
})
