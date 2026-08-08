# show-me-your-eta

An agent skill that makes coding agents answer the question you always end up asking: **when will this
be done?**

Before the work starts the agent splits the turn into steps and commits to a finish time. Each step is
timed as it lands. When the turn ends, the estimate and the truth are written to a log — and the next
estimate reads that log. The longer you work, the closer the numbers get.

Works with any agent, any provider, any model.

**English** · [한국어](README.ko.md)

```
$ eta.js plan 4 --provider anthropic --model claude-opus-5 --size M
4 steps, ~14 min (3.5 min/step from anthropic/claude-opus-5 M, 6 turns)
ETA: 17:45
(last 6 estimates ran 3 min long)

$ eta.js step
step 2/4 done in 4.1 min (3.8 min/step so far)
ETA: 17:49

$ eta.js done
estimated 14 min / actual 17 min (3 min short)
```

## Install

```bash
npx skills add 2JIHAN/show-me-your-eta
```

Installs into your agent's skill directory — Claude Code, Codex, Antigravity, Gemini CLI, Copilot CLI,
and anything else the [`skills`](https://skills.sh) CLI supports. Add `-g` for a user-wide install
instead of the current project.

No runtime dependencies. One Node script, no `node_modules`, nothing to build.

## How it works

### The log lives in the project, split by provider and model

```
<project root>/.eta/
├── anthropic/
│   ├── claude-opus-5/log.tsv
│   └── claude-haiku-4-5/log.tsv
├── openai/
│   └── gpt-5-codex/log.tsv
└── google/
    └── gemini-3-pro/log.tsv
```

Two reasons it is not a single file in your home directory:

- **Agents are often confined to their working directory.** A log outside the project is a log the
  agent cannot read, and an estimator that cannot read its history is just a constant.
- **Models do not work at the same speed.** A pace measured on one model is a bad prior for another.
  Folders keep them apart; the ladder below decides when it is worth borrowing across.

Add `.eta/` to `.gitignore`. It measures your machine on your turns.

### The estimate walks a ladder

`plan` takes the **median minutes per step** from the narrowest match that has at least 3 finished
turns:

| # | Rung | Used when |
|---|------|-----------|
| 1 | this provider + model + same size | the normal case, once you have history |
| 2 | this provider + model | a size you have not done much of |
| 3 | this provider, any model | a model you just switched to |
| 4 | everything in this project | a provider you just switched to |
| 5 | `TURN_ETA_DIR` shared log | a brand-new project |
| 6 | 4 minutes per step | nothing to go on yet |

Median rather than mean, so a single long turn does not poison every future estimate. Last 20 turns
per rung. `plan` always prints which rung it used and how many turns backed it.

### Steps are measured, not assumed

`step` records what that step actually took and re-forecasts the remainder from the measured pace
rather than the original guess. A turn that starts slow says so at step 2, not at the end.

## Usage

```bash
eta.js plan <steps> --provider <p> --model <m> [--size S|M|L]
eta.js step [id]
eta.js done [id]
eta.js stats [--provider <p> --model <m>]
```

| Flag | Meaning |
|------|---------|
| `--provider` | who runs the model — `anthropic`, `openai`, `google`, … |
| `--model` | the model identifier — `claude-opus-5`, `gpt-5-codex`, `gemini-3-pro`, … |
| `--size` | `S` small fix, `M` normal (default), `L` large chunk |
| `--dir` | point at a different `.eta` directory (mostly for testing) |

A shell cannot see which model is driving it, so the agent passes `--provider` and `--model` itself.
The skill file tells it to. Anything missing lands under `unknown/unknown`.

| Environment variable | Meaning |
|---|---|
| `TURN_ETA_DIR` | another `.eta` directory to borrow from when the local log is thin |

## Making the agent actually do it

Installing the skill puts the instructions where the agent can find them. Whether it reaches for them
every turn depends on your agent. In Claude Code, a `UserPromptSubmit` hook is the reliable way:

```sh
#!/bin/sh
S="$CLAUDE_PROJECT_DIR/.claude/skills/turn-eta"
[ -f "$S/SKILL.md" ] || exit 0
echo "If this turn contains real work, follow $S/SKILL.md — run plan before starting, put the ETA as the last paragraph of your reply, run step as each step lands, run done at the end."
exit 0
```

Register it under `hooks.UserPromptSubmit` in `.claude/settings.json`. Other agents have their own
equivalent; the skill works without one, it just triggers less reliably.

## Development

```bash
node turn-eta/scripts/eta.js --selftest
```

Covers path handling, the folder split, each rung of the ladder, per-step timing, and the shared-log
fallback. No test framework.

## License

MIT
