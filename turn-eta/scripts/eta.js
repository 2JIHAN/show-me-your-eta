#!/usr/bin/env node
// turn-eta — 한 턴이 얼마나 걸릴지 미리 말하고, 끝나면 실제와 견줘서 쌓는다.
//
//   eta.js plan <스텝수> [--model 이름] [--provider 이름] [--size S|M|L] [--log 경로]
//   eta.js done [id]     [--log 경로]
//   eta.js stats         [--model 이름] [--size S|M|L] [--log 경로]
//   eta.js --selftest
//
// 되먹임 고리: done이 (예상, 실제)를 로그에 쌓고 → plan이 그 로그에서 스텝당 실제 소요
// 중앙값을 꺼내 다음 예상을 낸다.
//
// 로그는 프로젝트 안(.eta/log.tsv)에 쌓는다. 권한을 프로젝트 밖으로 못 나가게 막은
// 세션에서도 읽히라고. 모델과 작업 크기는 폴더가 아니라 칸으로 두고, 좁은 것부터
// 넓은 것으로 내려가며 기록을 빌려 쓴다(사다리).

const fs = require('fs')
const path = require('path')
const os = require('os')

const DEFAULT_PER_STEP = 4 // ponytail: 기록이 얇을 때 쓰는 스텝당 분. 쌓이면 실측 중앙값이 대신한다
const MIN_SAMPLES = 3 // 이만큼 쌓여야 그 단을 쓴다
const KEEP = 20 // 중앙값과 편향을 낼 때 보는 최근 기록 수
const SIZES = ['S', 'M', 'L']
const HEADER = '# id\t프로젝트\t시작\t스텝수\t예상분\t종료\t실제분\t상태\tprovider\tmodel\tsize'

// 가장 가까운 .git이 있는 폴더를 프로젝트 루트로 본다. 저장소가 아니면 지금 폴더.
function projectRoot(from = process.cwd()) {
  let d = path.resolve(from)
  for (;;) {
    if (fs.existsSync(path.join(d, '.git'))) return d
    const up = path.dirname(d)
    if (up === d) return path.resolve(from)
    d = up
  }
}

const defaultLog = (from) => path.join(projectRoot(from), '.eta', 'log.tsv')

// 한국 시각. ICU 없이도 맞게 나오라고 손으로 9시간 민다.
const kst = (ms) => new Date(ms + 9 * 3600000).toISOString().slice(0, 19) + '+09:00'
const hhmm = (ms) => kst(ms).slice(11, 16)
const round1 = (n) => Math.round(n * 10) / 10
const median = (a) => {
  const s = [...a].sort((x, y) => x - y)
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
}

function load(logPath) {
  if (!logPath || !fs.existsSync(logPath)) return []
  return fs
    .readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((l) => l.trim() && !l.startsWith('#'))
    .map((l) => l.split('\t'))
    .filter((c) => c.length >= 8)
    .map((c) => ({
      id: c[0],
      project: c[1],
      start: c[2],
      steps: Number(c[3]),
      est: Number(c[4]),
      end: c[5],
      actual: c[6] === '-' ? null : Number(c[6]),
      state: c[7],
      // 칸 셋이 없던 옛 줄은 빈 값으로 읽힌다 → 좁은 단에서 걸러진다
      provider: c[8] || '',
      model: c[9] || '',
      size: c[10] || '',
    }))
}

function save(logPath, rows) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true })
  const body = rows.map((r) =>
    [
      r.id,
      r.project,
      r.start,
      r.steps,
      r.est,
      r.end,
      r.actual === null ? '-' : r.actual,
      r.state,
      r.provider || '',
      r.model || '',
      r.size || '',
    ].join('\t')
  )
  fs.writeFileSync(logPath, [HEADER, ...body].join('\n') + '\n')
}

const finished = (rows) => rows.filter((r) => r.state === 'done' && r.actual !== null && r.steps > 0)

// 한 로그 안에서 좁은 것부터 세 단. 3건이 안 되면 다음 단으로 내려간다.
function rungs(rows, model, size, prefix) {
  const fin = finished(rows)
  const tries = [
    [fin.filter((r) => r.model && r.model === model && r.size && r.size === size), `이 모델·${size} 기록`],
    [fin.filter((r) => r.model && r.model === model), '이 모델 기록'],
    [fin, prefix ? '전체 기록' : '이 프로젝트 기록'],
  ]
  for (const [set, name] of tries) {
    if (set.length < MIN_SAMPLES) continue
    const pick = set.slice(-KEEP)
    return { min: median(pick.map((r) => r.actual / r.steps)), from: prefix + name, n: pick.length }
  }
  return null
}

// 사다리: 이 프로젝트 로그 세 단 → 공용 로그 세 단 → 기본값
function perStep(rows, opt = {}) {
  const shared = opt.shared ? load(opt.shared) : []
  return (
    rungs(rows, opt.model, opt.size, '') ||
    (shared.length ? rungs(shared, opt.model, opt.size, '공용 로그 ') : null) || {
      min: DEFAULT_PER_STEP,
      from: '기본값',
      n: 0,
    }
  )
}

// 최근 예상이 얼마나 어긋났나. 양수면 실제가 더 걸린 것(낙관적).
function bias(rows) {
  const use = finished(rows).slice(-KEEP)
  if (!use.length) return null
  return { n: use.length, avg: Math.round(use.reduce((s, r) => s + (r.actual - r.est), 0) / use.length) }
}

const lean = (v) => (v === 0 ? '딱 맞았다' : `${Math.abs(v)}분 ${v > 0 ? '낙관적' : '비관적'}`)

function plan(logPath, opt, steps, now = Date.now()) {
  const rows = load(logPath)
  const p = perStep(rows, opt)
  const est = Math.max(1, Math.round(p.min * steps))
  const id = now.toString(36)
  rows.push({
    id,
    project: opt.project,
    start: kst(now),
    steps,
    est,
    end: '-',
    actual: null,
    state: 'open',
    provider: opt.provider,
    model: opt.model,
    size: opt.size,
  })
  save(logPath, rows)
  const b = bias(rows)
  return {
    id,
    est,
    perStep: p,
    lines: [
      `${steps}스텝 예정, 예상 ${est}분 (스텝당 ${round1(p.min)}분, ${p.from} ${p.n}건)`,
      `예상 종료시각: ${hhmm(now + est * 60000)}`,
      ...(b ? [`(지난 ${b.n}번 예상은 ${lean(b.avg)})`] : []),
    ],
  }
}

function done(logPath, id, now = Date.now()) {
  const rows = load(logPath)
  let i = -1
  for (let k = rows.length - 1; k >= 0; k--) {
    if (id ? rows[k].id === id : rows[k].state === 'open') {
      i = k
      break
    }
  }
  if (i < 0) return { error: id ? `그 id로 연 기록이 없다: ${id}` : '열려 있는 기록이 없다 — plan을 먼저 불러라' }
  const r = rows[i]
  // ponytail: 분 단위 반올림, 1분 미만도 1분으로 센다. 초 단위 정확도는 이 용도에 필요 없다
  const actual = Math.max(1, Math.round((now - Date.parse(r.start)) / 60000))
  rows[i] = { ...r, end: kst(now), actual, state: 'done' }
  save(logPath, rows)
  const off = actual - r.est
  return { id: r.id, est: r.est, actual, off, line: `예상 ${r.est}분 / 실제 ${actual}분 (${lean(off)})` }
}

function stats(logPath, opt) {
  const rows = load(logPath)
  const p = perStep(rows, opt)
  const b = bias(rows)
  const open = rows.filter((r) => r.state === 'open')
  return [
    `스텝당 ${round1(p.min)}분 (${p.from} ${p.n}건)`,
    b ? `최근 ${b.n}번 예상은 ${lean(b.avg)}` : '아직 끝낸 기록이 없다',
    open.length
      ? `열린 기록 ${open.length}개: ${open.map((r) => `${r.id}(${r.start.slice(11, 16)} 시작)`).join(', ')}`
      : '열린 기록 없음',
    `로그: ${logPath}`,
  ].join('\n')
}

function selftest() {
  const assert = require('assert')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-eta-'))
  const log = path.join(tmp, 'log.tsv')
  const shared = path.join(tmp, 'shared.tsv')
  const M = 60000
  const t = Date.UTC(2026, 7, 8, 1, 0, 0) // 한국 시각 10:00
  const o = (over) => ({ project: 'proj', provider: 'anthropic', model: 'claude-opus-5', size: 'M', ...over })
  // 한 건 끝낸 걸로 심는다
  const put = (logPath, opt, steps, spent) => {
    const p = plan(logPath, o(opt), steps, t)
    done(logPath, p.id, t + spent * M)
  }

  // 프로젝트 루트: 가장 가까운 .git을 찾고, 없으면 지금 폴더
  const deep = path.join(tmp, 'a', 'b')
  fs.mkdirSync(deep, { recursive: true })
  fs.mkdirSync(path.join(tmp, '.git'))
  assert.strictEqual(fs.realpathSync(projectRoot(deep)), fs.realpathSync(tmp))
  assert.ok(defaultLog(deep).endsWith(path.join('.eta', 'log.tsv')), defaultLog(deep))
  fs.rmSync(path.join(tmp, '.git'), { recursive: true })
  const noRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-eta-norepo-'))
  assert.strictEqual(projectRoot(noRepo), noRepo)

  // 기록이 없으면 기본값으로 잡고 예상 종료시각을 한 줄 찍는다
  const p1 = plan(log, o(), 3, t)
  assert.strictEqual(p1.est, 12, '스텝 3개 x 기본 4분')
  assert.strictEqual(p1.lines[1], '예상 종료시각: 10:12', p1.lines[1])
  assert.strictEqual(p1.perStep.from, '기본값')

  // 끝내면 예상과 실제 차이를 말한다
  const d1 = done(log, null, t + 17 * M)
  assert.strictEqual(d1.actual, 17)
  assert.ok(d1.line.includes('예상 12분 / 실제 17분') && d1.line.includes('5분 낙관적'), d1.line)

  // 칸 셋이 실제로 기록된다
  const first = load(log)[0]
  assert.deepStrictEqual(
    [first.provider, first.model, first.size],
    ['anthropic', 'claude-opus-5', 'M'],
    JSON.stringify(first)
  )

  // 사다리 1단 — 같은 모델 + 같은 크기가 3건
  put(log, {}, 3, 18)
  put(log, {}, 3, 15)
  const p2 = plan(log, o(), 3, t)
  assert.strictEqual(p2.perStep.from, '이 모델·M 기록', p2.lines[0])
  assert.strictEqual(p2.est, 17, '17/18/15의 중앙값 17분')
  assert.ok(p2.lines[0].includes('이 모델·M 기록 3건'), p2.lines[0])
  done(log, p2.id, t + 17 * M)

  // 사다리 2단 — 크기가 L인 기록은 아직 3건이 안 되니 모델 전체로 내려간다
  put(log, { size: 'L' }, 2, 20)
  const p3 = plan(log, o({ size: 'L' }), 2, t)
  assert.strictEqual(p3.perStep.from, '이 모델 기록', p3.lines[0])
  done(log, p3.id, t + 12 * M)

  // 사다리 3단 — 처음 보는 모델이면 이 프로젝트 기록 전체를 빌린다
  const p4 = plan(log, o({ model: 'gemini-3-pro' }), 2, t)
  assert.strictEqual(p4.perStep.from, '이 프로젝트 기록', p4.lines[0])
  done(log, p4.id, t + 9 * M)

  // 좁은 단은 칸이 빈 옛 줄을 걸러낸다
  const old = path.join(tmp, 'old.tsv')
  fs.writeFileSync(
    old,
    [
      HEADER,
      ...[10, 12, 14, 20].map((m, i) => `old${i}\tproj\t${kst(t)}\t2\t8\t${kst(t + m * M)}\t${m}\tdone`),
    ].join('\n') + '\n'
  )
  const oldRows = load(old)
  assert.strictEqual(oldRows[0].model, '', '옛 줄은 model 칸이 빈다')
  const pOld = perStep(oldRows, { model: 'claude-opus-5', size: 'M' })
  assert.strictEqual(pOld.from, '이 프로젝트 기록', '옛 줄은 좁은 단에서 걸러지고 전체 단에서만 쓰인다')
  assert.strictEqual(pOld.n, 4)

  // 사다리 4단 — 이 프로젝트 로그가 얇으면 공용 로그를 같은 순서로 한 번 더 본다
  for (const spent of [6, 6, 6]) put(shared, {}, 2, spent)
  const thin = path.join(tmp, 'thin.tsv')
  const p5 = plan(thin, o({ shared }), 2, t)
  assert.strictEqual(p5.perStep.from, '공용 로그 이 모델·M 기록', p5.lines[0])
  assert.strictEqual(p5.est, 6, '공용 로그 스텝당 3분 x 2스텝')
  const p6 = plan(thin, o({ shared, model: 'gemini-3-pro' }), 2, t)
  assert.strictEqual(p6.perStep.from, '공용 로그 전체 기록', p6.lines[0])

  // 사다리 5단 — 공용 로그도 없으면 기본값
  assert.strictEqual(perStep([], { model: 'claude-opus-5', size: 'M' }).from, '기본값')
  assert.strictEqual(perStep([], { model: 'claude-opus-5', size: 'M', shared: '/없는/경로.tsv' }).from, '기본값')

  // 이 프로젝트 기록이 충분해지면 공용 로그를 안 본다
  assert.strictEqual(plan(log, o({ shared }), 2, t).perStep.from, '이 모델·M 기록')

  // 열린 게 없으면 조용히 넘어가지 않고 알려준다
  const empty = path.join(tmp, 'empty.tsv')
  assert.ok(done(empty, null, t).error)
  assert.ok(done(log, '없는id', t).error)

  // 사람이 손으로 지워도 안 죽는다
  assert.deepStrictEqual(load(path.join(tmp, '없는파일.tsv')), [])
  assert.ok(stats(log, o()).includes('스텝당'))

  fs.rmSync(tmp, { recursive: true, force: true })
  fs.rmSync(noRepo, { recursive: true, force: true })
  console.log('자체검증 통과')
}

function main(argv) {
  if (argv.includes('--selftest')) return selftest(), 0

  let cmd = null
  let steps = null
  let id = null
  let logPath = null
  let project = null
  const opt = { provider: 'unknown', model: 'unknown', size: 'M', shared: process.env.TURN_ETA_LOG || null }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--log') logPath = argv[++i]
    else if (argv[i] === '--project') project = argv[++i]
    else if (argv[i] === '--provider') opt.provider = argv[++i]
    else if (argv[i] === '--model') opt.model = argv[++i]
    else if (argv[i] === '--size') opt.size = argv[++i]
    else if (argv[i].startsWith('-')) continue
    else if (cmd === null) cmd = argv[i]
    else if (/^\d+$/.test(argv[i]) && steps === null) steps = Number(argv[i])
    else if (id === null) id = argv[i]
  }
  if (!SIZES.includes(opt.size)) return console.error(`--size는 ${SIZES.join('/')} 셋 중 하나`), 2
  const root = projectRoot()
  logPath = logPath || path.join(root, '.eta', 'log.tsv')
  opt.project = project || path.basename(root)
  if (opt.shared && path.resolve(opt.shared) === path.resolve(logPath)) opt.shared = null

  if (cmd === 'plan') {
    if (!steps) return console.error('사용법: eta.js plan <스텝수> [--model 이름] [--size S|M|L]'), 2
    console.log(plan(logPath, opt, steps).lines.join('\n'))
    return 0
  }
  if (cmd === 'done') {
    const r = done(logPath, id || (steps !== null ? String(steps) : null))
    console.log(r.error || r.line)
    return r.error ? 1 : 0
  }
  if (cmd === 'stats') {
    console.log(stats(logPath, opt))
    return 0
  }
  console.error('사용법: eta.js plan <스텝수> | done [id] | stats  [--model 이름] [--provider 이름] [--size S|M|L] [--log 경로]')
  return 2
}

if (require.main === module) process.exit(main(process.argv.slice(2)))
module.exports = { load, projectRoot, defaultLog, perStep, bias, plan, done, stats }
