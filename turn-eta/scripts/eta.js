#!/usr/bin/env node
// show-me-your-eta — tell the user when this turn will be done, then learn from what it really took.
//
//   eta.js plan <steps> --provider <p> --model <m> [--size S|M|L]   open a turn, print the ETA
//   eta.js step [id]                                                one step finished, reprint the ETA
//   eta.js done [id]                                                close the turn, record the miss
//   eta.js stats [--provider <p> --model <m>]                       what the log says right now
//   eta.js --selftest
//
// Logs live inside the project so an agent locked to its working directory can still read them:
//
//   <project root>/.eta/<provider>/<model>/log.tsv
//
// Provider and model are folders, not columns — a Codex turn never borrows a Claude turn's pace
// unless the ladder has to reach that far. The ladder, widest hop last:
//   this model + same size -> this model -> this provider -> everything here -> shared log -> default
//
// Self-check: node eta.js --selftest

'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')

const HEADER = '# id\tstart\tsteps\test_min\tend\tactual_min\tstate\tsize\tstep_mins'
const DEFAULT_PACE_MIN = 4 // per step, until the log has something better to say
const MIN_SAMPLES = 3 // a rung needs this many finished turns before we trust it
const RECENT = 20
const SIZES = ['S', 'M', 'L']
const MS = 60000

// ---------- paths ----------

function projectRoot(from = process.cwd()) {
  let dir = path.resolve(from)
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir
    const up = path.dirname(dir)
    if (up === dir) return path.resolve(from)
    dir = up
  }
}

// folder-safe, so "anthropic/claude-opus-5[1m]" can't escape .eta
const slug = (s) =>
  String(s || 'unknown')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '') || 'unknown'

const etaRoot = (from) => path.join(projectRoot(from), '.eta')
const logPathFor = (root, provider, model) => path.join(root, slug(provider), slug(model), 'log.tsv')

// every log.tsv under an .eta root, tagged with the folders it came from
function scan(root) {
  const out = []
  let providers = []
  try {
    providers = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return out
  }
  for (const p of providers) {
    if (!p.isDirectory()) continue
    let models = []
    try {
      models = fs.readdirSync(path.join(root, p.name), { withFileTypes: true })
    } catch {
      continue
    }
    for (const m of models) {
      if (!m.isDirectory()) continue
      const file = path.join(root, p.name, m.name, 'log.tsv')
      if (fs.existsSync(file)) out.push({ provider: p.name, model: m.name, file })
    }
  }
  return out
}

// ---------- log io ----------

function load(file) {
  if (!file || !fs.existsSync(file)) return []
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim() && !l.startsWith('#'))
    .map((l) => l.split('\t'))
    .map((c) => ({
      id: c[0],
      start: c[1],
      steps: Number(c[2]),
      est: Number(c[3]),
      end: c[4],
      actual: c[5] === '-' || c[5] === undefined ? null : Number(c[5]),
      state: c[6],
      size: c[7] || 'M',
      stepMins: (c[8] || '').split(',').filter(Boolean).map(Number),
    }))
}

function save(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const body = rows.map((r) =>
    [
      r.id,
      r.start,
      r.steps,
      r.est,
      r.end || '-',
      r.actual === null || r.actual === undefined ? '-' : r.actual,
      r.state,
      r.size,
      r.stepMins.map(round1).join(','),
    ].join('\t')
  )
  fs.writeFileSync(file, [HEADER, ...body].join('\n') + '\n')
}

const round1 = (n) => Math.round(n * 10) / 10
const finished = (rows) => rows.filter((r) => r.state === 'done' && r.actual !== null && r.steps > 0)

function median(nums) {
  const s = [...nums].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

// ---------- the ladder ----------

// Widest hop last. Returns {min, from, n} — `from` is printed so a human sees which rung was used.
function pace(root, opt, sharedRoot) {
  const provider = slug(opt.provider)
  const model = slug(opt.model)

  for (const [source, label] of [
    [root, ''],
    [sharedRoot, 'shared '],
  ]) {
    if (!source) continue
    const all = scan(source)
    const mine = all.filter((f) => f.provider === provider && f.model === model)
    const sameProvider = all.filter((f) => f.provider === provider)

    const rows = (files) => files.flatMap((f) => finished(load(f.file))).slice(-RECENT)
    const mineRows = rows(mine)

    const rungs = [
      [mineRows.filter((r) => r.size === opt.size), `${label}${provider}/${model} ${opt.size}`],
      [mineRows, `${label}${provider}/${model}`],
      [rows(sameProvider), `${label}${provider}`],
      [rows(all), `${label}all`],
    ]
    for (const [picked, name] of rungs) {
      if (picked.length >= MIN_SAMPLES) {
        return { min: median(picked.map((r) => r.actual / r.steps)), from: name, n: picked.length }
      }
    }
  }
  return { min: DEFAULT_PACE_MIN, from: 'default', n: 0 }
}

// how far off the recent estimates were, in minutes (positive = we said it would take longer)
function bias(root, opt) {
  const file = logPathFor(root, opt.provider, opt.model)
  const rows = finished(load(file)).slice(-RECENT)
  if (rows.length < 2) return null
  return { n: rows.length, off: Math.round(median(rows.map((r) => r.est - r.actual))) }
}

// ---------- clock ----------

const clock = (ms) => {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
const iso = (ms) => new Date(ms).toISOString()
const etaLine = (ms) => `ETA: ${clock(ms)}`

// ---------- commands ----------

function openRow(file, opt, steps, now) {
  const rows = load(file)
  const p = pace(opt.root, opt, opt.shared)
  const est = Math.max(1, Math.round(p.min * steps))
  const id = Math.random().toString(36).slice(2, 10)
  rows.push({
    id,
    start: iso(now),
    steps,
    est,
    end: '-',
    actual: null,
    state: 'open',
    size: opt.size,
    stepMins: [],
  })
  save(file, rows)
  return { id, est, p }
}

function plan(opt, steps, now = Date.now()) {
  const file = logPathFor(opt.root, opt.provider, opt.model)
  const { id, est, p } = openRow(file, opt, steps, now)
  const b = bias(opt.root, opt)
  const out = [
    `${steps} steps, ~${est} min (${round1(p.min)} min/step from ${p.from}, ${p.n} turns)`,
    etaLine(now + est * MS),
  ]
  if (b) out.push(`(last ${b.n} estimates ran ${Math.abs(b.off)} min ${b.off > 0 ? 'long' : 'short'})`)
  return { id, est, text: out.join('\n') }
}

const openRows = (rows) => rows.filter((r) => r.state === 'open')

function pick(rows, id) {
  const open = openRows(rows)
  if (id) return open.find((r) => r.id === id) || null
  return open.length ? open[open.length - 1] : null
}

// One step done: measure what it actually took and re-forecast the rest from that pace.
function step(opt, id, now = Date.now()) {
  const file = logPathFor(opt.root, opt.provider, opt.model)
  const rows = load(file)
  const row = pick(rows, id)
  if (!row) throw new Error('no open turn to step — run plan first')

  const spent = (now - Date.parse(row.start)) / MS
  const before = row.stepMins.reduce((a, b) => a + b, 0)
  row.stepMins.push(Math.max(0, round1(spent - before)))
  const doneSteps = row.stepMins.length
  save(file, rows)

  const observed = spent / doneSteps
  const left = Math.max(0, row.steps - doneSteps)
  const eta = now + Math.round(observed * left) * MS
  const text = [
    `step ${doneSteps}/${row.steps} done in ${round1(row.stepMins[doneSteps - 1])} min (${round1(observed)} min/step so far)`,
    left ? etaLine(eta) : 'last step — wrap up and run done',
  ].join('\n')
  return { id: row.id, text, remaining: left }
}

function done(opt, id, now = Date.now()) {
  const file = logPathFor(opt.root, opt.provider, opt.model)
  const rows = load(file)
  const row = pick(rows, id)
  if (!row) throw new Error('no open turn to close')

  const actual = Math.max(1, Math.round((now - Date.parse(row.start)) / MS))
  row.end = iso(now)
  row.actual = actual
  row.state = 'done'
  const counted = row.stepMins.reduce((a, b) => a + b, 0)
  if (counted < actual) row.stepMins.push(round1(actual - counted)) // the tail after the last step
  save(file, rows)

  const off = row.est - actual
  const verdict = off === 0 ? 'spot on' : `${Math.abs(off)} min ${off > 0 ? 'long' : 'short'}`
  return { id: row.id, actual, text: `estimated ${row.est} min / actual ${actual} min (${verdict})` }
}

function stats(opt) {
  const p = pace(opt.root, opt, opt.shared)
  const b = bias(opt.root, opt)
  const open = openRows(load(logPathFor(opt.root, opt.provider, opt.model)))
  const out = [
    `${round1(p.min)} min/step (from ${p.from}, ${p.n} turns)`,
    b ? `last ${b.n} estimates ran ${Math.abs(b.off)} min ${b.off > 0 ? 'long' : 'short'}` : 'not enough history to judge the bias yet',
    open.length ? `${open.length} turn(s) still open` : 'no open turn',
    `log: ${logPathFor(opt.root, opt.provider, opt.model)}`,
  ]
  const seen = scan(opt.root)
  if (seen.length) out.push(`logs here: ${seen.map((f) => `${f.provider}/${f.model}`).join(', ')}`)
  return out.join('\n')
}

// ---------- cli ----------

function parseArgs(argv) {
  const opt = {
    provider: 'unknown',
    model: 'unknown',
    size: 'M',
    root: null,
    shared: process.env.TURN_ETA_DIR || null,
  }
  const rest = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--provider') opt.provider = argv[++i]
    else if (a === '--model') opt.model = argv[++i]
    else if (a === '--size') opt.size = String(argv[++i] || 'M').toUpperCase()
    else if (a === '--dir') opt.root = argv[++i]
    else if (a.startsWith('-')) continue
    else rest.push(a)
  }
  if (!SIZES.includes(opt.size)) opt.size = 'M'
  opt.root = opt.root || etaRoot()
  if (opt.shared && path.resolve(opt.shared) === path.resolve(opt.root)) opt.shared = null
  return { opt, rest }
}

function main(argv) {
  if (argv.includes('--selftest')) return selftest(), 0
  const { opt, rest } = parseArgs(argv)
  const [cmd, arg] = rest

  try {
    if (cmd === 'plan') {
      const steps = Number(arg)
      if (!Number.isFinite(steps) || steps < 1) throw new Error('plan needs a step count, e.g. plan 4')
      console.log(plan(opt, Math.round(steps)).text)
      return 0
    }
    if (cmd === 'step') return console.log(step(opt, arg).text), 0
    if (cmd === 'done') return console.log(done(opt, arg).text), 0
    if (cmd === 'stats') return console.log(stats(opt)), 0
  } catch (e) {
    console.error(e.message)
    return 1
  }

  console.error(
    'usage: eta.js plan <steps> | step [id] | done [id] | stats  [--provider p --model m --size S|M|L] [--dir .eta]'
  )
  return 2
}

// ---------- selftest ----------

function selftest() {
  const assert = require('assert')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eta-'))
  const root = path.join(tmp, '.eta')
  const t0 = Date.parse('2026-08-08T10:00:00Z')
  const o = (over = {}) => ({ provider: 'anthropic', model: 'claude-opus-5', size: 'M', root, shared: null, ...over })

  // folders, not columns
  const f = logPathFor(root, 'Anthropic', 'claude-opus-5[1m]')
  assert.strictEqual(path.relative(root, f), path.join('anthropic', 'claude-opus-5-1m', 'log.tsv'), f)
  assert.ok(!logPathFor(root, '../../etc', 'x').includes('..'), 'provider must not escape .eta')

  // project root is the nearest .git, even from a subfolder
  const repo = path.join(tmp, 'repo')
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true })
  const deep = path.join(repo, 'a', 'b')
  fs.mkdirSync(deep, { recursive: true })
  assert.strictEqual(fs.realpathSync(projectRoot(deep)), fs.realpathSync(repo))
  assert.ok(etaRoot(deep).endsWith('.eta'))

  // a fresh log falls back to the default pace
  const first = plan(o(), 3, t0)
  assert.ok(first.text.includes('from default'), first.text)
  assert.strictEqual(first.est, 12)
  assert.ok(/ETA: \d\d:\d\d/.test(first.text), first.text)

  // steps are measured one by one and the forecast follows the measured pace
  const s1 = step(o(), first.id, t0 + 2 * MS)
  assert.ok(s1.text.includes('step 1/3'), s1.text)
  assert.ok(s1.text.includes('2 min'), s1.text)
  const s2 = step(o(), first.id, t0 + 4 * MS)
  assert.ok(s2.text.includes('step 2/3'), s2.text)
  const closed = done(o(), first.id, t0 + 6 * MS)
  assert.strictEqual(closed.actual, 6)
  assert.ok(closed.text.includes('6 min long'), closed.text) // 12 estimated, 6 actual
  const row = load(logPathFor(root, 'anthropic', 'claude-opus-5')).pop()
  assert.deepStrictEqual(row.stepMins, [2, 2, 2], JSON.stringify(row.stepMins))

  // once MIN_SAMPLES turns exist, the measured median replaces the default
  const put = (opt, steps, spent, at = t0) => {
    const p = plan(opt, steps, at)
    done(opt, p.id, at + spent * MS)
  }
  put(o(), 3, 6)
  put(o(), 3, 6)
  const fourth = plan(o(), 3, t0)
  assert.ok(fourth.text.includes('anthropic/claude-opus-5 M'), fourth.text)
  assert.ok(fourth.text.includes('2 min/step'), fourth.text)
  done(o(), fourth.id, t0 + MS)

  // a size with no history of its own drops one rung, to the same model
  const large = plan(o({ size: 'L' }), 2, t0)
  assert.ok(large.text.includes('from anthropic/claude-opus-5,'), large.text)
  done(o({ size: 'L' }), large.id, t0 + MS)

  // an unseen model drops to the provider, and an unseen provider to everything here
  const otherModel = plan(o({ model: 'claude-haiku-4-5' }), 2, t0)
  assert.ok(otherModel.text.includes('from anthropic,'), otherModel.text)
  done(o({ model: 'claude-haiku-4-5' }), otherModel.id, t0 + MS)

  const otherProvider = plan(o({ provider: 'openai', model: 'gpt-5' }), 2, t0)
  assert.ok(otherProvider.text.includes('from all,'), otherProvider.text)
  done(o({ provider: 'openai', model: 'gpt-5' }), otherProvider.id, t0 + MS)

  // a second project borrows only through the shared log
  const other = path.join(tmp, 'other', '.eta')
  const alone = plan({ ...o(), root: other }, 3, t0)
  assert.ok(alone.text.includes('from default'), alone.text)
  done({ ...o(), root: other }, alone.id, t0 + MS)
  const borrowed = plan({ ...o(), root: other, shared: root }, 3, t0)
  assert.ok(borrowed.text.includes('shared anthropic/claude-opus-5'), borrowed.text)
  done({ ...o(), root: other, shared: root }, borrowed.id, t0 + MS)

  // closing without an open turn is an error, not a silent no-op
  assert.throws(() => step({ ...o(), root: path.join(tmp, 'empty') }, undefined, t0), /no open turn/)

  fs.rmSync(tmp, { recursive: true, force: true })
  console.log('selftest passed')
}

if (require.main === module) process.exit(main(process.argv.slice(2)))
module.exports = { projectRoot, slug, logPathFor, scan, pace, plan, step, done, stats }
