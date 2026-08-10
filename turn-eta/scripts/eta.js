#!/usr/bin/env node
// show-me-your-eta — tell the user when this turn will be done, then learn from what it really took.
//
//   eta.js plan "first step" "second step" … --provider <p> --model <m> [--size S|M|L]
//   eta.js step <id>                                                one step finished, reprint the ETA
//   eta.js done <id>                                                close the turn, print the finish time
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

const HEADER = '# id\tstart\tsteps\test_min\tend\tactual_min\tstate\tsize\tstep_mins\tstep_names\teta'
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
      names: (c[9] || '').split('|').filter(Boolean),
      eta: c[10] || '',
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
      r.names.join('|'),
      r.eta || '',
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

// A turn is only open in the project it was planned in. Say which one we looked in — the usual
// cause is a shell that changed directory between plan and done, and "no open turn" hides that.
function notFound(opt, id, what) {
  const where = `looked in ${opt.root}`
  return id ? `turn ${id} is not open here — ${where}` : `no open turn to ${what} — ${where}`
}

// ---------- clock ----------

const clock = (ms) => {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
// Local time with its offset, not UTC. The clock line above is local, and a log whose rows read
// six hours off from it is a log nobody trusts. The offset keeps it exact if the file travels.
const iso = (ms) => {
  const d = new Date(ms)
  const off = -d.getTimezoneOffset()
  const p2 = (n) => String(Math.abs(Math.trunc(n))).padStart(2, '0')
  const date = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
  const time = `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`
  return `${date}T${time}${off < 0 ? '-' : '+'}${p2(off / 60)}:${p2(off % 60)}`
}
const etaLine = (ms) => `**ETA ${clock(ms)}**`
// Minutes are too coarse for a single step — a 40-second step should not read as "0 min".
const hms = (min) => {
  const total = Math.max(0, Math.round(min * 60))
  return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, '0')}s`
}

// ---------- commands ----------

function openRow(file, opt, names, now) {
  const rows = load(file)
  const steps = names.length
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
    names,
    eta: iso(now + est * MS),
  })
  save(file, rows)
  return { id, est, p, steps }
}

function plan(opt, names, now = Date.now()) {
  const file = logPathFor(opt.root, opt.provider, opt.model)
  const { id, est, p, steps } = openRow(file, opt, names, now)
  const b = bias(opt.root, opt)
  const out = [
    // The finish time leads. It is the one line the reader came for, and a plan that buries it
    // reads as a to-do list — the steps below are the reasoning behind the number, not the point.
    `${etaLine(now + est * MS)} (${est} min)`,
    '',
    ...names.map((n, i) => `${i + 1}. ${n}`),
    '',
    `${steps} steps, ~${est} min (${round1(p.min)} min/step from ${p.from}, ${p.n} turns)`,
    '',
  ]
  if (b) out.push(`(last ${b.n} estimates ran ${Math.abs(b.off)} min ${b.off > 0 ? 'long' : 'short'})`)
  out.push(`turn id: ${id}`)
  return { id, est, text: out.join('\n') }
}

const openRows = (rows) => rows.filter((r) => r.state === 'open')

// An id names exactly one turn, so look for that turn instead of guessing which log it is in.
// Guessing used to send `done <id>` into whichever log was touched last — another agent's, in
// another provider's folder — where the id it was handed does not exist. The call failed and the
// turn it was asked to close stayed open, which is the one thing `done` exists to prevent.
function logHolding(root, id) {
  if (!id) return null
  const files = scan(root)
  const holds = (state) =>
    files.find((f) => load(f.file).some((r) => r.id === id && (!state || r.state === state)))
  const found = holds('open') || holds(null)
  return found ? found.file : null
}

// `plan` is told the provider and model; `step` and `done` should not have to repeat them.
// With an id, the log that holds it wins. Without one, follow the most recently opened turn here.
function activeLog(opt, id, now = Date.now()) {
  const held = logHolding(opt.root, id)
  if (held) return held
  if (opt.explicit) return logPathFor(opt.root, opt.provider, opt.model)
  const open = scan(opt.root)
    .map((f) => ({ file: f.file, rows: openRows(load(f.file)).filter((r) => now - Date.parse(r.start) < STALE_MS) }))
    .filter((f) => f.rows.length)
    .sort((a, b) => Date.parse(a.rows[a.rows.length - 1].start) - Date.parse(b.rows[b.rows.length - 1].start))
    .pop()
  return open ? open.file : logPathFor(opt.root, opt.provider, opt.model)
}

// A turn older than this was abandoned — don't let it hijack the next step.
const STALE_MS = 4 * 60 * MS

function pick(rows, id, now = Date.now()) {
  const open = openRows(rows)
  if (id) return open.find((r) => r.id === id) || null
  const fresh = open
    .filter((r) => now - Date.parse(r.start) < STALE_MS)
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
  // Two agents in one project would otherwise close each other's turns. Guessing here
  // corrupts both logs silently, so refuse and make the caller name the one it opened.
  if (fresh.length > 1) {
    throw new Error(`${fresh.length} turns are open here — pass the id: ${fresh.map((r) => r.id).join(', ')}`)
  }
  return fresh.length ? fresh[0] : null
}

// One step done: measure what it actually took and re-forecast the rest from that pace.
function step(opt, id, now = Date.now()) {
  const file = activeLog(opt, id, now)
  const rows = load(file)
  const row = pick(rows, id, now)
  if (!row) throw new Error(notFound(opt, id, 'step'))

  const spent = (now - Date.parse(row.start)) / MS
  const before = row.stepMins.reduce((a, b) => a + b, 0)
  row.stepMins.push(Math.max(0, round1(spent - before)))
  const doneSteps = row.stepMins.length

  const observed = spent / doneSteps
  const left = Math.max(0, row.steps - doneSteps)

  // Trusting this turn alone means one slow first step drags the whole forecast with it. Weight it
  // by how much of the turn is actually done: at step 1 of 4 the history still carries three
  // quarters, by step 3 this turn carries three quarters, and at the end history is gone.
  const prior = pace(opt.root, opt, opt.shared).min
  const w = doneSteps / row.steps
  const blended = prior * (1 - w) + observed * w
  const eta = now + Math.round(blended * left) * MS

  const prev = Date.parse(row.eta)
  const moved = Number.isFinite(prev) ? Math.round((eta - prev) / MS) : 0
  row.eta = iso(eta)
  save(file, rows)

  const drift =
    moved === 0 ? 'on track' : `${Math.abs(moved)} min ${moved > 0 ? 'later' : 'earlier'}`
  const text = [
    `${doneSteps}/${row.steps} ${row.names[doneSteps - 1] ?? ''} — ${hms(row.stepMins[doneSteps - 1])}`,
    '',
    left ? `**ETA ${clock(eta)}** (${drift})` : `last step — wrap up and run done`,
  ].join('\n')

  return { id: row.id, text, remaining: left }
}

function done(opt, id, now = Date.now()) {
  const file = activeLog(opt, id, now)
  const rows = load(file)
  const row = pick(rows, id, now)
  if (!row) throw new Error(notFound(opt, id, 'close'))

  const actual = Math.max(1, Math.round((now - Date.parse(row.start)) / MS))
  row.end = iso(now)
  row.actual = actual
  row.state = 'done'
  const counted = row.stepMins.reduce((a, b) => a + b, 0)
  if (counted < actual) row.stepMins.push(round1(actual - counted)) // the tail after the last step
  save(file, rows)

  // The reply is written after the work is finished, so the closing line is a finish time,
  // not a forecast. Printing the old ETA there would date-stamp a guess that already expired.
  // The two numbers say how far off it was; naming the gap on top of them is padding.
  //
  // The per-step times come out here too. They are the only part of the record that says *where*
  // the estimate went wrong, and leaving them in the log means nobody ever reads them.
  // A markdown table, because this text gets pasted into a reply. Lining columns up by hand
  // means counting terminal cells, and a Korean step name is two cells wide per character.
  // The per-step table lives in the log; the closing line is what the reply ends on.
  const lines = [`**FINISHED ${clock(now)}** (estimated ${row.est} min / actual ${actual} min)`]
  return { id: row.id, actual, text: lines.join('\n') }
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
    explicit: false,
    root: null,
    shared: process.env.TURN_ETA_DIR || null,
  }
  const rest = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--provider') (opt.provider = argv[++i]), (opt.explicit = true)
    else if (a === '--model') (opt.model = argv[++i]), (opt.explicit = true)
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
      const names = rest.slice(1).filter((n) => n.trim())
      if (!names.length || names.every((n) => /^\d+$/.test(n))) {
        throw new Error('plan needs the steps by name, e.g. plan "reproduce the failure" "fix the parser"')
      }
      console.log(plan(opt, names).text)
      return 0
    }
    // The id is not optional. Another agent in the same project shares this log, and a call
    // without one closed the wrong turn twice before this check existed.
    if (cmd === 'step' || cmd === 'done') {
      if (!arg) throw new Error(`${cmd} needs the turn id that plan printed, e.g. ${cmd} 48i35qek`)
      return console.log((cmd === 'step' ? step : done)(opt, arg).text), 0
    }
    if (cmd === 'stats') return console.log(stats(opt)), 0
  } catch (e) {
    console.error(e.message)
    return 1
  }

  console.error(
    'usage: eta.js plan "step one" "step two" … | step <id> | done <id> | stats  [--provider p --model m --size S|M|L] [--dir .eta]'
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

  // 시각은 오프셋을 달고 저장된다 — 왕복해도 같은 순간이어야 한다
  const stamped = iso(t0)
  assert.ok(/[+-]\d\d:\d\d$/.test(stamped), stamped)
  assert.strictEqual(Date.parse(stamped), t0)

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
  const names3 = ['read the test', 'fix the parser', 're-run']
  const first = plan(o(), names3, t0)
  assert.ok(first.text.includes('from default'), first.text)
  assert.strictEqual(first.est, 12)
  assert.ok(/\*\*ETA \d\d:\d\d\*\*/.test(first.text), first.text)
  assert.ok(first.text.includes('\n1. read the test\n2. fix the parser\n3. re-run\n'), first.text)
  const planLines = first.text.split('\n')
  const etaAt = planLines.findIndex((l) => l.startsWith('**ETA '))
  assert.strictEqual(etaAt, 0, first.text) // the finish time leads, on its own line
  assert.strictEqual(planLines[1], '', first.text)
  assert.ok(/^\*\*ETA \d\d:\d\d\*\* \(12 min\)$/.test(planLines[etaAt]), planLines[etaAt]) // how long, not just when

  // steps are measured one by one and the forecast follows the measured pace
  const s1 = step(o(), first.id, t0 + 2 * MS)
  assert.strictEqual(s1.text.split('\n').length, 3, s1.text) // the step, a blank, then the eta alone
  assert.strictEqual(s1.text.split('\n')[1], '', s1.text)
  assert.strictEqual(s1.text.split('\n')[0], '1/3 read the test — 2m 00s', s1.text)
  assert.ok(/^\*\*ETA \d\d:\d\d\*\* \((on track|\d+ min (earlier|later))\)$/.test(s1.text.split('\n')[2]), s1.text)
  const s2 = step(o(), first.id, t0 + 4 * MS)
  assert.ok(s2.text.startsWith('2/3 fix the parser — 2m 00s'), s2.text)

  // a slow first step must not drag the whole forecast: the history still carries most of the weight
  const slowRoot = path.join(tmp, 'slow', '.eta')
  const so = { ...o(), root: slowRoot }
  for (let i = 0; i < 3; i++) {
    const q = plan(so, ['a', 'b', 'c', 'd'], t0)
    done(so, q.id, t0 + 4 * MS) // 1 min per step, three times over
  }
  const slow = plan(so, ['a', 'b', 'c', 'd'], t0)
  const afterSlow = step(so, slow.id, t0 + 4 * MS) // first step alone took 4 min
  const naive = 4 * 3 // this turn's pace applied to the three that remain
  const blendedEta = Date.parse(afterSlow.eta ?? '') // not exported; read the row instead
  const row2 = load(logPathFor(slowRoot, 'anthropic', 'claude-opus-5')).pop()
  const ahead = Math.round((Date.parse(row2.eta) - (t0 + 4 * MS)) / MS)
  assert.ok(ahead < naive, `blended ${ahead} min should undercut the naive ${naive} min`)
  assert.ok(ahead > 3, `and still exceed the historical ${3} min: ${ahead}`)
  done(so, slow.id, t0 + 5 * MS)
  const closed = done(o(), first.id, t0 + 6 * MS)
  assert.strictEqual(closed.actual, 6)
  assert.ok(closed.text.includes('estimated 12 min / actual 6 min'), closed.text)
  assert.ok(!/spot on|long|short/.test(closed.text), closed.text) // the numbers say it; no verdict
  assert.ok(/^\*\*FINISHED \d\d:\d\d\*\* /.test(closed.text), closed.text)
  assert.strictEqual(closed.text.split('\n').length, 1, closed.text) // one closing line, no table
  const row = load(logPathFor(root, 'anthropic', 'claude-opus-5')).pop()
  assert.deepStrictEqual(row.stepMins, [2, 2, 2], JSON.stringify(row.stepMins))
  assert.deepStrictEqual(row.names, names3, JSON.stringify(row.names))

  // once MIN_SAMPLES turns exist, the measured median replaces the default
  const put = (opt, steps, spent, at = t0) => {
    const p = plan(opt, Array.from({ length: steps }, (_, i) => `step ${i + 1}`), at)
    done(opt, p.id, at + spent * MS)
  }
  put(o(), 3, 6)
  put(o(), 3, 6)
  const fourth = plan(o(), names3, t0)
  assert.ok(fourth.text.includes('anthropic/claude-opus-5 M'), fourth.text)
  assert.ok(fourth.text.includes('2 min/step'), fourth.text)
  done(o(), fourth.id, t0 + MS)

  // a size with no history of its own drops one rung, to the same model
  const large = plan(o({ size: 'L' }), ['a', 'b'], t0)
  assert.ok(large.text.includes('from anthropic/claude-opus-5,'), large.text)
  done(o({ size: 'L' }), large.id, t0 + MS)

  // an unseen model drops to the provider, and an unseen provider to everything here
  const otherModel = plan(o({ model: 'claude-haiku-4-5' }), ['a', 'b'], t0)
  assert.ok(otherModel.text.includes('from anthropic,'), otherModel.text)
  done(o({ model: 'claude-haiku-4-5' }), otherModel.id, t0 + MS)

  const otherProvider = plan(o({ provider: 'openai', model: 'gpt-5' }), ['a', 'b'], t0)
  assert.ok(otherProvider.text.includes('from all,'), otherProvider.text)
  done(o({ provider: 'openai', model: 'gpt-5' }), otherProvider.id, t0 + MS)

  // a second project borrows only through the shared log
  const other = path.join(tmp, 'other', '.eta')
  const alone = plan({ ...o(), root: other }, names3, t0)
  assert.ok(alone.text.includes('from default'), alone.text)
  done({ ...o(), root: other }, alone.id, t0 + MS)
  const borrowed = plan({ ...o(), root: other, shared: root }, names3, t0)
  assert.ok(borrowed.text.includes('shared anthropic/claude-opus-5'), borrowed.text)
  done({ ...o(), root: other, shared: root }, borrowed.id, t0 + MS)

  // step and done without --provider/--model follow the most recent open turn
  const bare = { provider: 'unknown', model: 'unknown', size: 'M', root, shared: null, explicit: false }
  const opened = plan(o(), ['a', 'b'], t0)
  const followed = step(bare, undefined, t0 + MS)
  assert.strictEqual(followed.id, opened.id, 'step without flags must follow the open turn')
  assert.ok(hms(0.5) === '0m 30s' && hms(4.1) === '4m 06s', hms(4.1))
  assert.strictEqual(done(bare, undefined, t0 + 2 * MS).id, opened.id)

  // two open turns at once: guessing is worse than stopping
  const a1 = plan(o(), ['a'], t0)
  const a2 = plan(o({ size: 'L' }), ['b'], t0)
  assert.throws(() => step(o(), undefined, t0 + MS), /pass the id/)
  assert.strictEqual(step(o(), a1.id, t0 + MS).id, a1.id, 'a named id still works with two open')
  done(o(), a1.id, t0 + MS)
  done(o(), a2.id, t0 + MS)

  // an id is followed into the log that holds it, not into whichever log was written last
  const mixed = path.join(tmp, 'mixed', '.eta')
  const mine = { ...o(), root: mixed }
  const theirs = { ...o({ provider: 'openai', model: 'gpt-5-codex' }), root: mixed }
  const ours = plan(mine, ['a', 'b'], t0)
  plan(theirs, ['x', 'y'], t0 + MS) // another agent opens a turn later, in another provider's folder
  const bare2 = { provider: 'unknown', model: 'unknown', size: 'M', root: mixed, shared: null, explicit: false }
  assert.strictEqual(done(bare2, ours.id, t0 + 2 * MS).id, ours.id, 'done <id> must find its own log')
  assert.strictEqual(
    load(logPathFor(mixed, 'anthropic', 'claude-opus-5')).find((r) => r.id === ours.id).state,
    'done',
    'and close the turn there, not fail against someone else\'s log'
  )

  // an abandoned turn must not hijack the next step
  const stale = plan(o(), Array.from({ length: 9 }, (_, i) => `s${i}`), t0 - 5 * 60 * MS)
  const fresh = plan(o(), ['a', 'b'], t0)
  assert.strictEqual(step(o(), undefined, t0 + MS).id, fresh.id, 'step must follow the fresh turn')
  assert.strictEqual(done(o(), stale.id, t0 + MS).id, stale.id, 'a named id still works')
  done(o(), fresh.id, t0 + MS)
  assert.ok(fresh.text.includes('turn id: '), fresh.text)

  // closing without an open turn is an error, not a silent no-op
  assert.throws(() => step({ ...o(), root: path.join(tmp, 'empty') }, undefined, t0), /no open turn/)
  assert.throws(() => step(o(), 'nosuchid', t0), /not open here — looked in/)

  fs.rmSync(tmp, { recursive: true, force: true })
  console.log('selftest passed')
}

if (require.main === module) process.exit(main(process.argv.slice(2)))
module.exports = { projectRoot, slug, logPathFor, scan, pace, plan, step, done, stats }
