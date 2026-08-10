#!/usr/bin/env node
'use strict'
//
// eta-gate — make the agent decide, once per prompt, whether this turn needs a plan, and make it
// close the turn it opened.
//
// The UserPromptSubmit reminder is only text. Nothing checks that it was followed, so a turn can
// skip `plan` outright, or call it and never call `done` — both of which read, from the outside,
// exactly like the skill never ran. Three events, three questions:
//
//   PreToolUse  (Edit|Write)  has this prompt grown past a touch-up with no plan? stop once if so.
//   PostToolUse (Bash)        did `plan` actually open a turn? only that satisfies the gate.
//   Stop                      was that turn closed, and did the reply ever show it? ask once if not.
//
// The first one used to fire on the first edit of every prompt, which made a one-line fix cost a
// blocked call and a retry — noise on exactly the turns the skill says to skip. An estimate is worth
// asking for once a turn is actually long, so that is what is measured: how long the prompt has been
// running, and how many files it has changed. Under both thresholds the gate stays out of the way.
//
// The last one is the other half of the same hole: `plan` ran and its output never reached the user.
// From the outside that is indistinguishable from a turn that skipped the skill, and no tool call
// can reveal it — what the agent writes is not a tool call. Only the transcript knows.
//
// What satisfies the gate is a turn appearing in the log, not a command line that looks like it
// planned. PreToolUse fires before the command runs, so it cannot tell `plan "a" "b"` from a `plan`
// eta.js refused for having no step names, or from a `cat` that happened to mention both words —
// and every one of those used to open the gate and leave the reader with nothing on screen.
//
// It does not judge the work. A shell script cannot tell a four-step refactor from a typo fix. It
// hands that judgement back to the agent and refuses to let it be skipped in silence: stop once, say
// what the two answers are, and let the retry through either way.
//
// Register on all four events — UserPromptSubmit opens the gate, PreToolUse reads it, PostToolUse
// satisfies it, Stop collects the finish time:
//
//   "UserPromptSubmit": [{ "hooks": [{ "type": "command",
//       "command": "node \"$CLAUDE_PROJECT_DIR/.claude/skills/turn-eta/hooks/eta-gate.js\"" }] }],
//   "PreToolUse": [{ "matcher": "Edit|Write", "hooks": [{ "type": "command",
//       "command": "node \"$CLAUDE_PROJECT_DIR/.claude/skills/turn-eta/hooks/eta-gate.js\"" }] }],
//   "PostToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "command",
//       "command": "node \"$CLAUDE_PROJECT_DIR/.claude/skills/turn-eta/hooks/eta-gate.js\"" }] }],
//   "Stop": [{ "hooks": [{ "type": "command",
//       "command": "node \"$CLAUDE_PROJECT_DIR/.claude/skills/turn-eta/hooks/eta-gate.js\"" }] }]
//
// self-check: node eta-gate.js --selftest
//

const fs = require('fs')
const path = require('path')
const os = require('os')

const PENDING = 'pending' // this prompt has not been judged yet
const PLANNED = 'planned' // a turn was opened for this prompt — the id is kept alongside
const BLOCKED = 'blocked' // stopped once already — the retry goes through
const ASKED_DONE = 'asked-done' // sent back once for the missing `done`
const ASKED_SHOW = 'asked-show' // sent back once for a plan that never reached the reply

const MS = 60000
// How long a turn this session opened keeps counting as "a plan is already running".
//
// NOT eta.js's abandoned-turn window, which is four hours: that one answers whether a turn may
// still be closed, and being generous there costs nothing. This window answers whether the agent
// should be stopped again mid-plan, and steps go quiet for long stretches of honest work — a
// deploy, a build, a browser run. Blocking there interrupts a plan the agent is already following,
// which is the exact opposite of the point.
const RUNNING_MS = 20 * MS
// How recently a turn must have been opened to be the one the Bash call just planned. Only the
// fallback for a tool result we cannot read an id out of, so it is kept tight on purpose: `plan`
// writes its row a moment before this hook runs, and a wider window starts claiming turns another
// agent opened.
const PLAN_MS = 30 * 1000
const PRUNE_MS = 24 * 60 * MS // gate files from yesterday's sessions

// When a prompt stops being a touch-up. Either signal alone is enough: a turn can be long without
// touching many files (a build, a browser run, reading around) or short but broad (a rename across
// four files). Both are past the point where "how long will this take" is worth a sentence.
const WORK_MS = 3 * MS // still editing this long after the prompt arrived
const WORK_EDITS = 4 // the fourth file change of one prompt

// A cheap prefilter, not the test. The log is what decides — so this can afford to be loose, and
// has to be: a `plan` split across lines with a backslash is still a plan.
const PLAN_CMD = /eta\.js[\s\S]*\bplan\b/
const TURN_ID = /turn id:\s*([a-z0-9]{4,16})/i

const REASON = (why) =>
  [
    `This prompt is past a touch-up — ${why} — and no plan was opened for it.`,
    '',
    '- Work still ahead → run `eta.js plan "…" "…"` now, and put what it prints at the top of your',
    '  reply, in that order: the **ETA …** line, then the numbered steps.',
    '- Nearly done → just try the edit again. The second attempt goes through.',
    '',
    'This stops you once per prompt, never twice.',
  ].join('\n')

const UNCLOSED = (id) =>
  [
    `Turn ${id} is still open — \`done\` never ran, so this turn ends without a finish time.`,
    '',
    `- Run \`eta.js done ${id}\` and close your reply with what it prints: the **FINISHED …** line.`,
    '- If something is still running, close the turn anyway, say what is still going, and give a',
    '  fresh **ETA …** for it.',
    '',
    'This asks once per prompt, never twice.',
  ].join('\n')

const UNSHOWN = [
  'You ran `eta.js plan` this turn but never showed it. The estimate is for the user, not for you.',
  '',
  'Reply again with what it printed — the **ETA …** line, then the numbered steps — before',
  'anything else. Keep the rest of the answer as it was.',
  '',
  'This asks once per prompt, never twice.',
].join('\n')

// The .eta directory belongs to the repo, not the working directory — same walk eta.js does, so the
// gate and the log always land in the same place.
function projectRoot(from) {
  let dir = path.resolve(from)
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir
    const up = path.dirname(dir)
    if (up === dir) return path.resolve(from)
    dir = up
  }
}

// folder-safe, so a session id can't escape .eta/gate
const slug = (s) =>
  String(s || 'unknown')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '') || 'unknown'

const gateDir = (root) => path.join(root, '.eta', 'gate')
const gateFile = (root, sid) => path.join(gateDir(root), slug(sid))

// The gate file carries the turn this session opened, not just a word. Without the id, "is a plan
// running?" can only be answered for the whole project — and then one agent's open turn waves every
// other agent's edits straight through.
// It also carries how big the prompt has grown: when it arrived, and how many files it has changed
// since. Neither can be recovered afterwards — the log only knows about turns that were planned, and
// an unplanned prompt is exactly the case being measured.
function readGate(file) {
  try {
    const [state, id, at, edits] = fs.readFileSync(file, 'utf8').trim().split('\t')
    return { state: state || null, id: id || null, at: Number(at) || 0, edits: Number(edits) || 0 }
  } catch {
    return { state: null, id: null, at: 0, edits: 0 }
  }
}

function writeGate(file, state, id, at, edits) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, [state, id || '', at || '', edits || ''].join('\t').replace(/\t+$/, '') + '\n')
}

function prune(dir, now) {
  let names = []
  try {
    names = fs.readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    const file = path.join(dir, name)
    try {
      if (now - fs.statSync(file).mtimeMs > PRUNE_MS) fs.unlinkSync(file)
    } catch {
      // a file another session just removed — nothing to do
    }
  }
}

// ---------- the log ----------

function subdirs(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    return []
  }
}

// Every turn eta.js has written under this project, across providers and models.
function turns(root) {
  const base = path.join(root, '.eta')
  const out = []
  for (const provider of subdirs(base)) {
    if (provider === 'gate') continue
    for (const model of subdirs(path.join(base, provider))) {
      let text = ''
      try {
        text = fs.readFileSync(path.join(base, provider, model, 'log.tsv'), 'utf8')
      } catch {
        continue
      }
      for (const line of text.split('\n')) {
        if (!line || line[0] === '#') continue
        const f = line.split('\t')
        if (f.length < 7 || !f[0]) continue
        const start = Date.parse(f[1])
        if (Number.isFinite(start)) out.push({ id: f[0], start, state: f[6] })
      }
    }
  }
  return out
}

const openTurn = (root, id) => (id ? turns(root).find((t) => t.id === id && t.state === 'open') : undefined)

// ---------- what the reader actually saw ----------

// Either shape the skill ends a line with. `FINISHED` counts too: a turn short enough to be over
// before the reply is written closes on the finish time and never reprints the estimate, and
// sending that back for "no ETA" would be asking for a number the clock already disproved.
const SHOWN_LINE = /\*\*(ETA|FINISHED) \d{1,2}:\d{2}\*\*|\*\*예상 종료시각[^*]*\*\*/

// Did any assistant message since the last user prompt carry it? The transcript is JSONL, one
// message per line. Tool results arrive as user lines too, so the prompt this turn belongs to is
// the last user line whose content is a string or plain text blocks — walking past that one would
// let last turn's ETA vouch for this turn.
function planShown(transcriptPath) {
  let lines
  try {
    lines = fs.readFileSync(transcriptPath, 'utf8').split('\n')
  } catch {
    return true // no transcript to read — never hold a turn open over a file we cannot open
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i]) continue
    let msg
    try {
      msg = JSON.parse(lines[i]).message
    } catch {
      continue
    }
    if (!msg) continue
    const content = msg.content
    if (msg.role === 'user') {
      const isPrompt =
        typeof content === 'string' || (Array.isArray(content) && content.every((b) => b.type === 'text'))
      if (isPrompt) return false // walked back to the prompt without finding it
      continue
    }
    if (msg.role !== 'assistant' || !Array.isArray(content)) continue
    for (const block of content) {
      if (block.type === 'text' && SHOWN_LINE.test(block.text || '')) return true
    }
  }
  return false
}

// ---------- what `plan` left behind ----------

// Whatever text the tool result carries, without assuming its shape.
function responseText(response) {
  if (typeof response === 'string') return response
  if (!response || typeof response !== 'object') return ''
  const fields = [response.stdout, response.output, response.stderr, response.content].filter(
    (v) => typeof v === 'string'
  )
  if (fields.length) return fields.join('\n')
  try {
    return JSON.stringify(response)
  } catch {
    return ''
  }
}

// Which turn did this Bash call open? The id `plan` printed if we can see it — that is exact
// attribution, and two agents planning in the same minute cannot be told apart without it.
// Otherwise the newest turn opened just now. A command that opened nothing returns null, which is
// the whole point: a `plan` eta.js refused leaves no row, so it leaves the gate shut.
function plannedTurn(root, response, now) {
  const printed = TURN_ID.exec(responseText(response))
  if (printed && openTurn(root, printed[1])) return printed[1]
  const fresh = turns(root)
    .filter((t) => t.state === 'open' && now - t.start < PLAN_MS && now - t.start >= 0)
    .sort((a, b) => a.start - b.start)
    .pop()
  return fresh ? fresh.id : null
}

// ---------- the decision ----------

// Returns null to stay out of the way, or {kind, reason} for main() to render.
function decide(input, now = Date.now()) {
  const root = projectRoot(process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd())
  const file = gateFile(root, input.session_id)
  const event = input.hook_event_name

  if (event === 'UserPromptSubmit') {
    prune(gateDir(root), now)
    // A mid-turn message re-opens the gate. If this session is already following a plan it opened
    // itself, and that turn is still open and still recent, stopping it again interrupts the plan.
    // Only this session's own turn counts — another agent's open turn is not this agent's plan.
    const g = readGate(file)
    const mine = (g.state === PLANNED || g.state === ASKED_DONE) && openTurn(root, g.id)
    if (mine && now - mine.start < RUNNING_MS) writeGate(file, PLANNED, g.id)
    else writeGate(file, PENDING, null, now, 0)
    return null
  }

  // The turn is over. Two ways it can end having measured everything and told the reader nothing:
  // the turn was never closed, or it was closed and the numbers stayed in the terminal. Both arrive
  // quietly at the last moment, and this is the last place either can be caught.
  if (event === 'Stop') {
    if (input.stop_hook_active) return null // already continuing from this hook; do not loop
    const g = readGate(file)
    if (!g.id || (g.state !== PLANNED && g.state !== ASKED_DONE)) return null
    if (openTurn(root, g.id)) {
      if (g.state !== PLANNED) return null // asked for it once already this prompt
      writeGate(file, ASKED_DONE, g.id)
      return { kind: 'stop', reason: UNCLOSED(g.id) }
    }
    if (planShown(input.transcript_path)) return null
    writeGate(file, ASKED_SHOW, g.id)
    return { kind: 'stop', reason: UNSHOWN }
  }

  // `plan` has run by now, so the log can be asked whether it worked instead of the command line
  // being asked whether it looked like it would.
  if (event === 'PostToolUse') {
    if (input.tool_name !== 'Bash') return null
    if (!PLAN_CMD.test(String((input.tool_input && input.tool_input.command) || ''))) return null
    const id = plannedTurn(root, input.tool_response, now)
    if (id) writeGate(file, PLANNED, id)
    return null
  }

  if (event !== 'PreToolUse') return null
  // Reading the codebase is not the thing being gated — only changing it is.
  if (input.tool_name !== 'Edit' && input.tool_name !== 'Write') return null

  // No file means UserPromptSubmit never ran. Blocking then would wedge the session with nothing
  // able to clear it, so an uninstalled half is the same as no gate at all.
  const g = readGate(file)
  if (g.state !== PENDING) return null

  const edits = g.edits + 1
  const elapsed = g.at ? now - g.at : 0
  const why =
    edits >= WORK_EDITS
      ? `${edits} file changes`
      : elapsed >= WORK_MS
        ? `${Math.round(elapsed / MS)} minutes in and still editing`
        : null
  // Still small. Count it and stay out of the way — this is the case the old gate got wrong.
  if (!why) {
    writeGate(file, PENDING, null, g.at, edits)
    return null
  }

  writeGate(file, BLOCKED)
  return { kind: 'deny', reason: REASON(why) }
}

function main() {
  let raw = ''
  try {
    raw = fs.readFileSync(0, 'utf8')
  } catch {
    return 0
  }
  let input = {}
  try {
    input = JSON.parse(raw)
  } catch {
    return 0
  }

  let out = null
  try {
    out = decide(input)
  } catch {
    return 0 // a broken gate must never be the reason work stops
  }
  if (!out) return 0

  console.log(
    JSON.stringify(
      out.kind === 'stop'
        ? { decision: 'block', reason: out.reason }
        : {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason: out.reason,
            },
          }
    )
  )
  return 0
}

// ---------- selftest ----------

function selftest() {
  const assert = require('assert')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eta-gate-'))
  fs.mkdirSync(path.join(root, '.git'))
  process.env.CLAUDE_PROJECT_DIR = root

  const t0 = Date.parse('2026-08-08T17:00:00+09:00')
  const sid = 'sess-1'
  const prompt = (s = sid, at = t0) => decide({ hook_event_name: 'UserPromptSubmit', session_id: s }, at)
  const edit = (at = t0, s = sid) =>
    decide({ hook_event_name: 'PreToolUse', tool_name: 'Edit', session_id: s }, at)
  const ran = (command, response, at = t0, s = sid) =>
    decide(
      { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command }, tool_response: response, session_id: s },
      at
    )
  const stop = (at = t0, s = sid, active = false) =>
    decide({ hook_event_name: 'Stop', session_id: s, stop_hook_active: active }, at)
  // What the gate does once a prompt has outgrown a touch-up. Four file changes is the quick way
  // there; the tests below are about what counts as a plan, not about where the threshold sits.
  const grown = (at = t0, s = sid) => {
    let out = null
    for (let i = 0; i < WORK_EDITS; i++) out = edit(at, s)
    return out
  }

  // eta.js writes here; the tests stand in for it
  const log = path.join(root, '.eta', 'anthropic', 'claude-opus-5', 'log.tsv')
  const row = (id, start, state) => `${id}\t${new Date(start).toISOString()}\t2\t4\t-\t-\t${state}\tM\t\ta|b\t`
  const writeLog = (...rows) => {
    fs.mkdirSync(path.dirname(log), { recursive: true })
    fs.writeFileSync(log, ['# header', ...rows].join('\n') + '\n')
  }
  const clearLog = () => fs.rmSync(log, { force: true })
  const planned = (id, at = t0) => (writeLog(row(id, at, 'open')), ran('node x/eta.js plan "a" "b"', { stdout: `turn id: ${id}` }, at))

  // no state file yet — an uninstalled UserPromptSubmit must not wedge anything
  assert.strictEqual(edit(), null)

  // --- a touch-up is never interrupted ---

  // one edit, seconds after the prompt: nothing to say
  prompt()
  assert.strictEqual(edit(t0 + 4000), null)
  assert.strictEqual(edit(t0 + 9000), null, 'a second file is still a touch-up')
  assert.strictEqual(edit(t0 + 15000), null, 'and a third')

  // the fourth file change of one prompt is not
  const broad = edit(t0 + 20000)
  assert.ok(broad && broad.reason.includes('4 file changes'), JSON.stringify(broad))
  assert.strictEqual(edit(t0 + 25000), null, 'stopped once, never twice')

  // a prompt still editing minutes later is asked too, however few files it touched
  prompt(sid, t0 + MS)
  assert.strictEqual(edit(t0 + 2 * MS), null)
  const slow = edit(t0 + 5 * MS)
  assert.ok(slow && slow.reason.includes('minutes in'), JSON.stringify(slow))
  assert.strictEqual(edit(t0 + 6 * MS), null)

  // the clock starts at the prompt, not at the session — a fresh prompt is a fresh touch-up
  prompt(sid, t0 + 10 * MS)
  assert.strictEqual(edit(t0 + 10 * MS + 5000), null)

  // a prompt whose `plan` actually opened a turn is never stopped
  clearLog()
  prompt()
  planned('aaa')
  assert.deepStrictEqual(readGate(gateFile(root, sid)), { state: PLANNED, id: 'aaa', at: 0, edits: 0 })
  assert.strictEqual(edit(), null)

  // --- what does NOT count as planning ---

  // reading around is not gated, and does not open the gate
  clearLog()
  prompt()
  assert.strictEqual(ran('ls -la && grep -rn eta.js .', { stdout: 'eta.js' }), null)
  assert.strictEqual(readGate(gateFile(root, sid)).state, PENDING)
  assert.ok(grown(), 'a grep is not a plan')

  // a command that merely names both words writes no turn, so it opens nothing
  clearLog()
  prompt()
  ran('cat x/eta.js | head -40   # what does plan print?', { stdout: 'const PLAN = 1' })
  assert.strictEqual(readGate(gateFile(root, sid)).state, PENDING, 'a cat is not a plan')
  assert.ok(grown())

  // a `plan` eta.js refused leaves no row behind, and so leaves the gate shut
  clearLog()
  prompt()
  ran('node x/eta.js plan 3 4', { stdout: '', stderr: 'plan needs the steps by name' })
  assert.strictEqual(readGate(gateFile(root, sid)).state, PENDING, 'a refused plan is not a plan')
  assert.ok(grown())

  // someone else's open turn is not this session's plan
  clearLog()
  writeLog(row('zzz', t0 - MS, 'open'))
  prompt()
  ran('node x/eta.js plan "a" "b"', { stdout: 'error' })
  assert.strictEqual(readGate(gateFile(root, sid)).state, PENDING, 'an older open turn is not this call')
  assert.ok(grown())

  // a plan split across lines still counts — the log decides, not the shape of the command
  clearLog()
  prompt()
  writeLog(row('bbb', t0, 'open'))
  ran('node x/eta.js \\\n  plan "a" "b"', { stdout: 'no id here' })
  assert.strictEqual(readGate(gateFile(root, sid)).id, 'bbb')

  // --- one agent's open turn must not open another's gate ---

  clearLog()
  writeLog(row('aaa', t0 - MS, 'open')) // another agent planned a minute ago and is still working
  for (const other of ['sess-2', 'sess-3']) {
    prompt(other)
    assert.ok(grown(t0, other), `${other} is not covered by another session's open turn`)
  }
  // even from another provider's log
  const codex = path.join(root, '.eta', 'openai', 'gpt-5-codex', 'log.tsv')
  fs.mkdirSync(path.dirname(codex), { recursive: true })
  fs.writeFileSync(codex, '# header\n' + row('ccc', t0 - MS, 'open') + '\n')
  prompt('sess-4')
  assert.ok(grown(t0, 'sess-4'), "a codex turn does not open a claude session's gate")
  fs.rmSync(codex, { force: true })

  // sessions do not share a gate
  clearLog()
  prompt()
  assert.strictEqual(decide({ hook_event_name: 'PreToolUse', tool_name: 'Write', session_id: 'sess-9' }, t0), null)
  assert.ok(grown(), 'sess-1 is still pending')

  // --- a mid-turn message must not interrupt this session's own plan ---

  clearLog()
  prompt()
  planned('ddd')
  prompt() // the user says something while the plan is running
  assert.strictEqual(edit(), null, 'this session opened that turn and is still following it')

  // a quiet stretch mid-plan is honest work, not an abandoned turn
  clearLog()
  prompt()
  planned('eee')
  prompt(sid, t0 + 12 * MS)
  assert.strictEqual(edit(t0 + 12 * MS), null)

  // a turn left open far past the window is not a running plan
  prompt(sid, t0 + 25 * MS)
  assert.ok(grown(t0 + 25 * MS))

  // a finished turn is not a running plan either
  clearLog()
  prompt()
  planned('fff')
  writeLog(row('fff', t0, 'done'))
  prompt()
  assert.ok(grown())

  // --- Stop: a turn that was opened has to be closed ---

  clearLog()
  prompt()
  planned('ggg')
  const asked = stop()
  assert.ok(asked && asked.kind === 'stop', 'an open turn at the end of the turn is asked about')
  assert.ok(asked.reason.includes('done ggg'), asked.reason)
  assert.strictEqual(stop(), null, 'asked once, never twice')

  // a conversation-only turn never planned, so it is never asked
  clearLog()
  prompt()
  assert.strictEqual(stop(), null)

  // and the hook never argues with itself
  clearLog()
  prompt()
  planned('iii')
  assert.strictEqual(stop(t0, sid, true), null, 'stop_hook_active must break the loop')

  // --- Stop: a plan that ran has to have been shown ---

  const transcript = path.join(root, 'transcript.jsonl')
  const write = (...msgs) => fs.writeFileSync(transcript, msgs.map((m) => JSON.stringify(m)).join('\n') + '\n')
  const said = (text) => ({ message: { role: 'assistant', content: [{ type: 'text', text }] } })
  const askedBy = { message: { role: 'user', content: 'fix the checkout tests' } }
  const toolResult = { message: { role: 'user', content: [{ type: 'tool_result', content: '**ETA 18:44**' }] } }
  const closed = (id, at = t0) => (planned(id, at), writeLog(row(id, at, 'done')))
  const ending = (at = t0, s = sid, active = false) =>
    decide({ hook_event_name: 'Stop', session_id: s, transcript_path: transcript, stop_hook_active: active }, at)

  // closed and shown — nothing to say
  clearLog()
  prompt()
  closed('jjj')
  write(askedBy, said('**ETA 18:44** (2 min)\n\n1. a\n2. b'), said('바꿨어'))
  assert.strictEqual(ending(), null)

  // a turn short enough to close on the finish time alone still counts as shown
  clearLog()
  prompt()
  closed('kkk')
  write(askedBy, said('바꿨어. **FINISHED 18:44** (estimated 2 min / actual 1 min)'))
  assert.strictEqual(ending(), null)

  // planned, measured, closed — and the reader got none of it
  clearLog()
  prompt()
  closed('lll')
  write(askedBy, said('고쳤어. 테스트도 통과해.'))
  const back = ending()
  assert.ok(back && back.reason.startsWith('You ran `eta.js plan`'), JSON.stringify(back))
  assert.strictEqual(ending(), null, 'asked once, never twice')

  // the ETA reaching the terminal is not the ETA reaching the reader
  clearLog()
  prompt()
  closed('mmm')
  write(askedBy, toolResult, said('고쳤어.'))
  assert.ok(ending(), 'a tool result is not the reply')

  // last turn's ETA does not vouch for this one
  clearLog()
  prompt()
  closed('nnn')
  write(said('**ETA 18:40** (1 min)'), askedBy, said('고쳤어.'))
  assert.ok(ending(), 'the plan has to be shown after the prompt it belongs to')

  // an unreadable transcript never holds a turn open
  clearLog()
  prompt()
  closed('ooo')
  assert.strictEqual(
    decide({ hook_event_name: 'Stop', session_id: sid, transcript_path: path.join(root, 'nope.jsonl') }, t0),
    null
  )

  // both halves in one turn: the missing `done` first, the missing reply next
  clearLog()
  prompt()
  planned('ppp')
  write(askedBy, said('고쳤어.'))
  assert.ok(ending().reason.includes('done ppp'), 'the open turn is asked about first')
  writeLog(row('ppp', t0, 'done')) // the agent closes it, still says nothing
  assert.ok(ending().reason.startsWith('You ran `eta.js plan`'), 'then the silent reply is')
  assert.strictEqual(ending(), null)

  // yesterday's sessions are swept up
  const old = gateFile(root, 'sess-old')
  writeGate(old, PENDING)
  fs.utimesSync(old, new Date(t0 - 2 * PRUNE_MS), new Date(t0 - 2 * PRUNE_MS))
  prompt()
  assert.ok(!fs.existsSync(old))

  // a slashed session id stays inside .eta/gate
  assert.strictEqual(path.dirname(gateFile(root, '../../etc/passwd')), gateDir(root))

  fs.rmSync(root, { recursive: true, force: true })
  console.log('selftest passed')
}

if (require.main === module) {
  if (process.argv.includes('--selftest')) selftest()
  else process.exit(main())
}

module.exports = { decide, gateFile, readGate, planShown, PENDING, PLANNED, BLOCKED, ASKED_DONE, ASKED_SHOW }
