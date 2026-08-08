---
name: turn-eta
description: When a turn contains real work (editing files, running commands, digging through code), split it into steps, tell the user how many and when it will be done, time each step, and record the miss so the next estimate is closer. Skip it on conversation-only turns.
---

# turn-eta — say when this turn will be done, then learn from what it took

Before the work starts, say how many steps it is and when it will be finished. Time each step as it
lands. When the turn ends, write down what it really took. The next estimate reads that log.

## When this runs

**Every turn that contains real work** — editing a file, running a command, searching the codebase.

- Work in the turn → call `plan` **before** starting, put `ETA: 17:45` as its own final paragraph in
  your reply, call `step` as each step lands, call `done` when the turn's work is finished.
- Conversation-only turn (answering a question, deciding what to build) → do nothing. It is noise.
- A one-line fix is not worth the ceremony either. Use it when there is more than one step.

## Commands

Pure Node, no install. Call it from wherever the skill is installed.

```bash
# before the work — count the steps and get an ETA
node <skill>/scripts/eta.js plan 4 --provider anthropic --model claude-opus-5 --size M

# 4 steps, ~14 min (3.5 min/step from anthropic/claude-opus-5 M, 6 turns)
# ETA: 17:45
# (last 6 estimates ran 3 min long)

# each time a step lands — measured, and the rest is re-forecast from the measured pace
node <skill>/scripts/eta.js step
# step 2/4 done in 4.1 min (3.8 min/step so far)
# ETA: 17:49

# when the turn's work is done
node <skill>/scripts/eta.js done
# estimated 14 min / actual 17 min (3 min short)

# what the log says right now
node <skill>/scripts/eta.js stats
```

**You must pass your own `--provider` and `--model`.** A shell cannot see which model is driving it.
Use the identifiers you know yourself by — `--provider anthropic --model claude-opus-5`,
`--provider openai --model gpt-5-codex`, `--provider google --model gemini-3-pro`. Anything missing
lands under `unknown/unknown`, which still works but pools every model together.

`--size` is `S` (small fix), `M` (normal, the default), or `L` (large chunk). Rough is fine; it only
keeps small turns from dragging the average of large ones.

## Where the log lives

```
<project root>/.eta/<provider>/<model>/log.tsv
```

Inside the project, so an agent whose permissions stop at its working directory can still read its own
history. Project root is the nearest `.git` going up, otherwise the current directory. Provider and
model are folders, so one model's pace never quietly becomes another's.

Add `.eta/` to `.gitignore`. It is a measurement of your machine on your turns; it means nothing to
anyone else and it changes on every turn.

Set `TURN_ETA_DIR` to another `.eta` directory to share history across projects. It is only consulted
when the local log is too thin to say anything.

## How the estimate gets better

`done` records the estimate, the actual, and the per-step times. `plan` reads them back and takes the
**median minutes per step**, walking from the narrowest match outward and stopping at the first rung
with at least 3 finished turns:

1. this provider + model + same size
2. this provider + model
3. this provider, any model
4. everything in this project's `.eta`
5. the shared log in `TURN_ETA_DIR`, same order
6. otherwise 4 minutes per step

Median rather than mean, so one turn that ran long does not drag every future estimate with it. Only
the last 20 turns per rung count. `plan` prints which rung it used, so the number is never a mystery.
