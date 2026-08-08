#!/usr/bin/env node
// turn-eta — 한 턴이 얼마나 걸릴지 미리 말하고, 끝나면 실제와 견줘서 쌓는다.
//
//   eta.js plan <스텝수> [--project 이름] [--log 경로]   예상 소요와 예상 종료시각을 찍고 기록 하나를 연다
//   eta.js done [id]     [--project 이름] [--log 경로]   실제 걸린 시간을 재서 예상과 견주고 닫는다
//   eta.js stats         [--project 이름] [--log 경로]   지금 쓰는 보정치를 보여준다
//   eta.js --selftest
//
// 되먹임 고리: done이 (예상, 실제)를 로그에 쌓고 → plan이 그 로그에서 스텝당 실제 소요
// 중앙값을 꺼내 다음 예상을 낸다. 기록이 세 건 넘게 쌓이면 기본값 대신 실측이 쓰인다.
//
// 로그는 프로젝트를 오가도 살아남게 홈에 쌓는다. 줄마다 프로젝트 칸이 있어서
// 그 프로젝트 기록이 충분하면 그것만 쓰고, 얇으면 전체 기록을 빌려 쓴다.

const fs = require('fs')
const path = require('path')
const os = require('os')

const DEFAULT_LOG = path.join(os.homedir(), '.claude', 'turn-eta', 'log.tsv')
const DEFAULT_PER_STEP = 4 // ponytail: 기록이 얇을 때 쓰는 스텝당 분. 쌓이면 실측 중앙값이 대신한다
const MIN_SAMPLES = 3 // 이만큼 쌓여야 기본값을 버린다
const KEEP = 20 // 중앙값과 편향을 낼 때 보는 최근 기록 수
const HEADER = '# id\t프로젝트\t시작\t스텝수\t예상분\t종료\t실제분\t상태'

const pad = (n) => String(n).padStart(2, '0')
// 한국 시각. ICU 없이도 맞게 나오라고 손으로 9시간 민다.
const kst = (ms) => new Date(ms + 9 * 3600000).toISOString().slice(0, 19) + '+09:00'
const hhmm = (ms) => kst(ms).slice(11, 16)
const round1 = (n) => Math.round(n * 10) / 10
const median = (a) => {
  const s = [...a].sort((x, y) => x - y)
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
}

function load(logPath) {
  if (!fs.existsSync(logPath)) return []
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
    }))
}

function save(logPath, rows) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true })
  const body = rows.map((r) =>
    [r.id, r.project, r.start, r.steps, r.est, r.end, r.actual === null ? '-' : r.actual, r.state].join('\t')
  )
  fs.writeFileSync(logPath, [HEADER, ...body].join('\n') + '\n')
}

// 스텝당 몇 분으로 볼 것인가. 이 프로젝트 기록이 충분하면 그것만, 얇으면 전체, 그것도 얇으면 기본값.
function perStep(rows, project) {
  const finished = rows.filter((r) => r.state === 'done' && r.actual !== null && r.steps > 0)
  const mine = finished.filter((r) => r.project === project)
  const use = mine.length >= MIN_SAMPLES ? mine : finished
  if (use.length < MIN_SAMPLES) return { min: DEFAULT_PER_STEP, from: '기본값', n: use.length }
  const pick = use.slice(-KEEP)
  return { min: median(pick.map((r) => r.actual / r.steps)), from: use === mine ? '이 프로젝트 기록' : '전체 기록', n: pick.length }
}

// 최근 예상이 얼마나 어긋났나. 양수면 실제가 더 걸린 것(낙관적).
function bias(rows, project) {
  const finished = rows.filter((r) => r.state === 'done' && r.actual !== null)
  const mine = finished.filter((r) => r.project === project)
  const use = (mine.length >= MIN_SAMPLES ? mine : finished).slice(-KEEP)
  if (!use.length) return null
  const avg = Math.round(use.reduce((s, r) => s + (r.actual - r.est), 0) / use.length)
  return { n: use.length, avg }
}

const lean = (v) => (v === 0 ? '딱 맞았다' : `${Math.abs(v)}분 ${v > 0 ? '낙관적' : '비관적'}`)

function plan(logPath, project, steps, now = Date.now()) {
  const rows = load(logPath)
  const p = perStep(rows, project)
  const est = Math.max(1, Math.round(p.min * steps))
  const id = now.toString(36)
  rows.push({ id, project, start: kst(now), steps, est, end: '-', actual: null, state: 'open' })
  save(logPath, rows)
  const b = bias(rows, project)
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

function done(logPath, project, id, now = Date.now()) {
  const rows = load(logPath)
  let i = -1
  for (let k = rows.length - 1; k >= 0; k--) {
    const r = rows[k]
    if (id ? r.id === id : r.state === 'open' && r.project === project) {
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

function stats(logPath, project) {
  const rows = load(logPath)
  const p = perStep(rows, project)
  const b = bias(rows, project)
  const open = rows.filter((r) => r.state === 'open' && r.project === project)
  return [
    `스텝당 ${round1(p.min)}분 (${p.from} ${p.n}건)`,
    b ? `최근 ${b.n}번 예상은 ${lean(b.avg)}` : '아직 끝낸 기록이 없다',
    open.length ? `열린 기록 ${open.length}개: ${open.map((r) => `${r.id}(${r.start.slice(11, 16)} 시작)`).join(', ')}` : '열린 기록 없음',
    `로그: ${logPath}`,
  ].join('\n')
}

function selftest() {
  const assert = require('assert')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-eta-'))
  const log = path.join(tmp, 'log.tsv')
  const M = 60000
  const t = Date.UTC(2026, 7, 8, 1, 0, 0) // 한국 시각 10:00

  // 기록이 없으면 기본값으로 잡고 예상 종료시각을 한 줄 찍는다
  const p1 = plan(log, 'proj', 3, t)
  assert.strictEqual(p1.est, 12, '스텝 3개 x 기본 4분')
  assert.strictEqual(p1.lines[1], '예상 종료시각: 10:12', p1.lines[1])
  assert.strictEqual(p1.perStep.from, '기본값')

  // 끝내면 예상과 실제 차이를 말한다
  const d1 = done(log, 'proj', null, t + 17 * M)
  assert.strictEqual(d1.actual, 17)
  assert.ok(d1.line.includes('예상 12분 / 실제 17분') && d1.line.includes('5분 낙관적'), d1.line)

  // 세 건 쌓이면 기본값 대신 실측 중앙값을 쓴다
  for (const spent of [18, 15]) {
    const p = plan(log, 'proj', 3, t)
    done(log, 'proj', p.id, t + spent * M)
  }
  const p2 = plan(log, 'proj', 3, t)
  assert.strictEqual(p2.perStep.from, '이 프로젝트 기록')
  assert.strictEqual(p2.est, 17, '17/18/15의 중앙값 17분')
  assert.ok(p2.lines[2].includes('지난 3번'), p2.lines[2])

  // 자기 기록이 얇은 프로젝트는 전체 기록을 빌려 쓴다
  const p3 = plan(log, 'other', 2, t)
  assert.strictEqual(p3.perStep.from, '전체 기록')

  // id 없이 done을 부르면 그 프로젝트의 마지막 열린 기록을 닫는다
  const d3 = done(log, 'other', null, t + 4 * M)
  assert.strictEqual(d3.id, p3.id)

  // 열린 게 없으면 조용히 넘어가지 않고 알려준다
  assert.ok(done(log, '없는프로젝트', null, t).error)
  assert.ok(done(log, 'proj', '없는id', t).error)

  // 사람이 손으로 지워도 안 죽는다
  assert.deepStrictEqual(load(path.join(tmp, '없는파일.tsv')), [])
  assert.ok(stats(log, 'proj').includes('스텝당'))

  fs.rmSync(tmp, { recursive: true, force: true })
  console.log('자체검증 통과')
}

function main(argv) {
  if (argv.includes('--selftest')) return selftest(), 0

  let cmd = null
  let steps = null
  let id = null
  let logPath = DEFAULT_LOG
  let project = path.basename(process.cwd())
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--log') logPath = argv[++i]
    else if (argv[i] === '--project') project = argv[++i]
    else if (argv[i].startsWith('-')) continue
    else if (cmd === null) cmd = argv[i]
    else if (/^\d+$/.test(argv[i]) && steps === null) steps = Number(argv[i])
    else if (id === null) id = argv[i]
  }

  if (cmd === 'plan') {
    if (!steps) return console.error('사용법: eta.js plan <스텝수>'), 2
    console.log(plan(logPath, project, steps).lines.join('\n'))
    return 0
  }
  if (cmd === 'done') {
    const r = done(logPath, project, id || (steps !== null ? String(steps) : null))
    console.log(r.error || r.line)
    return r.error ? 1 : 0
  }
  if (cmd === 'stats') {
    console.log(stats(logPath, project))
    return 0
  }
  console.error('사용법: eta.js plan <스텝수> | done [id] | stats  [--project 이름] [--log 경로]')
  return 2
}

if (require.main === module) process.exit(main(process.argv.slice(2)))
module.exports = { load, perStep, bias, plan, done, stats }
