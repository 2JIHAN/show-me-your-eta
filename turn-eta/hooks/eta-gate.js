#!/usr/bin/env node
'use strict'
//
// eta-gate — make the agent decide, once per prompt, whether this turn needs a plan.
//
// The UserPromptSubmit reminder is only text. Nothing checks that it was followed, so a turn can call
// `plan`, keep the output to itself, and never call `done` — which reads, from the outside, exactly
// like the skill never ran. This hook stops the first Edit/Write of each prompt while no plan exists.
//
// It does not judge the work. A shell script cannot tell a four-step refactor from a typo fix. It
// hands that judgement back to the agent and refuses to let it be skipped in silence: stop once, say
// what the two answers are, and let the retry through either way.
//
// Register on BOTH events — UserPromptSubmit opens the gate, PreToolUse reads it:
//
//   "UserPromptSubmit": [{ "hooks": [{ "type": "command",
//       "command": "node \"$CLAUDE_PROJECT_DIR/.claude/skills/turn-eta/hooks/eta-gate.js\"" }] }],
//   "PreToolUse": [{ "matcher": "Edit|Write|Bash", "hooks": [{ "type": "command",
//       "command": "node \"$CLAUDE_PROJECT_DIR/.claude/skills/turn-eta/hooks/eta-gate.js\"" }] }]
//
// self-check: node eta-gate.js --selftest
//

const fs = require('fs')
const path = require('path')
const os = require('os')

const PENDING = 'pending' // this prompt has not been judged yet
const PLANNED = 'planned' // plan ran for this prompt
const BLOCKED = 'blocked' // stopped once already — the retry goes through

const MS = 60000
// How long an open turn keeps counting as "a plan is already running".
//
// NOT eta.js's 4-minute abandoned-turn window, which was the first thing tried here and was wrong:
// eta.js drops a stale turn so it cannot hijack the next `step`, and four minutes of silence is a
// fine signal for that. This window answers a different question — should the agent be stopped
// again mid-plan — and steps go quiet for long stretches of honest work: a deploy, a build, a
// browser run. Blocking there interrupts a plan the agent is already following, which is the exact
// opposite of the point.
const RUNNING_MS = 20 * MS
const PRUNE_MS = 24 * 60 * MS // gate files from yesterday's sessions

const REASON = [
  'No plan for this prompt yet. Before touching files, say which kind of turn this is.',
  '',
  '- More than one step → run `eta.js plan "…" "…"` first, then open your reply with what it',
  '  prints, in that order: the **ETA …** line, then the numbered steps.',
  '- A one-line touch-up → just try the edit again. The second attempt goes through.',
  '',
  'This stops you once per prompt, never twice.',
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

function readState(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim()
  } catch {
    return null
  }
}

function writeState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, state + '\n')
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

// Is a turn already under way? A mid-turn message from the user re-opens the gate, and without this
// the agent gets stopped again halfway through a plan it is already following.
function turnRunning(root, now) {
  const base = path.join(root, '.eta')
  const subdirs = (dir) => {
    try {
      return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
    } catch {
      return []
    }
  }
  for (const provider of subdirs(base)) {
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
        if (f[6] === 'open' && now - Date.parse(f[1]) < RUNNING_MS) return true
      }
    }
  }
  return false
}

// Returns the text to stop with, or null to let the call through.
function decide(input, now = Date.now()) {
  const root = projectRoot(process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd())
  const file = gateFile(root, input.session_id)

  if (input.hook_event_name === 'UserPromptSubmit') {
    prune(gateDir(root), now)
    writeState(file, PENDING)
    return null
  }
  if (input.hook_event_name !== 'PreToolUse') return null

  // Reading the codebase is not the thing being gated — only changing it is.
  if (input.tool_name === 'Bash') {
    const cmd = String((input.tool_input && input.tool_input.command) || '')
    if (/eta\.js\b[^\n]*\bplan\b/.test(cmd)) writeState(file, PLANNED)
    return null
  }
  if (input.tool_name !== 'Edit' && input.tool_name !== 'Write') return null

  // No file means UserPromptSubmit never ran. Blocking then would wedge the session with nothing
  // able to clear it, so an uninstalled half is the same as no gate at all.
  if (readState(file) !== PENDING) return null
  if (turnRunning(root, now)) return null

  writeState(file, BLOCKED)
  return REASON
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

  let reason = null
  try {
    reason = decide(input)
  } catch {
    return 0 // a broken gate must never be the reason work stops
  }
  if (!reason) return 0

  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    })
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
  const prompt = () => decide({ hook_event_name: 'UserPromptSubmit', session_id: sid }, t0)
  const edit = (at = t0) => decide({ hook_event_name: 'PreToolUse', tool_name: 'Edit', session_id: sid }, at)
  const bash = (command) =>
    decide({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, session_id: sid }, t0)

  // no state file yet — an uninstalled UserPromptSubmit must not wedge anything
  assert.strictEqual(edit(), null)

  // the first edit of a prompt is stopped, the retry is not
  prompt()
  assert.ok(edit().startsWith('No plan for this prompt yet.'))
  assert.strictEqual(edit(), null)

  // a prompt that planned is never stopped
  prompt()
  assert.strictEqual(bash('node /x/eta.js plan "a" "b" --size M'), null)
  assert.strictEqual(readState(gateFile(root, sid)), PLANNED)
  assert.strictEqual(edit(), null)

  // reading around is not gated, and does not count as planning
  prompt()
  assert.strictEqual(bash('ls -la && grep -rn eta.js .'), null)
  assert.strictEqual(readState(gateFile(root, sid)), PENDING)
  assert.ok(edit())

  // sessions do not share a gate
  prompt()
  assert.strictEqual(
    decide({ hook_event_name: 'PreToolUse', tool_name: 'Write', session_id: 'sess-2' }, t0),
    null
  )
  assert.ok(edit(), 'sess-1 is still pending')

  // a mid-turn message re-opens the gate, but an open turn keeps the agent working
  const log = path.join(root, '.eta', 'anthropic', 'claude-opus-5', 'log.tsv')
  fs.mkdirSync(path.dirname(log), { recursive: true })
  const row = (id, start, state) => `${id}\t${start}\t2\t4\t-\t-\t${state}\tM\t\ta|b\t`
  fs.writeFileSync(log, '# header\n' + row('aaa', new Date(t0 - MS).toISOString(), 'open') + '\n')
  prompt()
  assert.strictEqual(edit(), null, 'a fresh open turn means a plan is already running')

  // an abandoned turn does not hold the gate open forever
  // a plan that waits on a deploy goes quiet for minutes and must still count as running
  fs.writeFileSync(log, '# header\n' + row('aaa', new Date(t0 - 12 * MS).toISOString(), 'open') + '\n')
  prompt()
  assert.strictEqual(edit(), null, 'a quiet stretch mid-plan is not an abandoned turn')

  fs.writeFileSync(log, '# header\n' + row('aaa', new Date(t0 - 25 * MS).toISOString(), 'open') + '\n')
  prompt()
  assert.ok(edit(), 'a turn left open far past the window is not a running plan')

  // a finished turn is not a running plan either
  fs.writeFileSync(log, '# header\n' + row('aaa', new Date(t0 - MS).toISOString(), 'done') + '\n')
  prompt()
  assert.ok(edit())

  // yesterday's sessions are swept up
  const old = gateFile(root, 'sess-old')
  writeState(old, PENDING)
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

module.exports = { decide, gateFile, PENDING, PLANNED, BLOCKED }
