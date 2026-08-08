# show-me-your-eta

A skill that makes your coding agent answer the question you always end up asking: **when will this be
done?**

Install it, and every turn with real work in it starts with a step count and a finish time, and ends
with the truth:

> I'll do this in 4 steps — read the failing test, fix the parser, update the fixtures, re-run the suite.
>
> *…work…*
>
> **ETA: 17:45**

Each step is timed as it lands, so a turn that starts slow says so at step 2 instead of at the end. When
the turn closes, the estimate and the actual go into a log, and the next estimate reads that log. The
longer you work with it, the closer the numbers get.

Works with any agent, any provider, any model.

**English** · [한국어](README.ko.md)

## Install

```bash
npx skills add 2JIHAN/show-me-your-eta
```

Installs into your agent's skill directory — Claude Code, Codex, Antigravity, Gemini CLI, Copilot CLI,
and anything else the [`skills`](https://skills.sh) CLI supports. Add `-g` to install for every project
instead of just this one.

Then add `.eta/` to your `.gitignore` (see below), and you're done. No runtime dependencies, nothing to
build, no API keys.

You never run anything yourself. The agent reads the skill and calls the script as it works.

## Make sure it actually fires

Installing puts the instructions where the agent can find them. Whether it reaches for them on every
turn depends on the agent. In Claude Code, a `UserPromptSubmit` hook makes it reliable:

```sh
#!/bin/sh
S="$CLAUDE_PROJECT_DIR/.claude/skills/turn-eta"
[ -f "$S/SKILL.md" ] || exit 0
echo "If this turn contains real work, follow $S/SKILL.md — plan before starting, ETA as the last paragraph of the reply, step as each step lands, done at the end."
exit 0
```

Register it under `hooks.UserPromptSubmit` in `.claude/settings.json`. Other agents have their own
equivalent. It works without one; it just triggers less often.

## What it writes down

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

One tab-separated row per turn: how many steps, what was estimated, what it actually took, and how long
each individual step ran.

Two reasons it lives in the project rather than your home directory:

- **Agents are often confined to their working directory.** A log outside the project is a log the agent
  cannot read, and an estimator that cannot read its history is just a constant.
- **Models do not work at the same speed.** A pace measured on one model is a bad prior for another.
  Folders keep them apart.

**Add `.eta/` to `.gitignore`.** It measures your machine on your turns — it means nothing to your
teammates and it changes on every turn.

## How the estimate gets better

The next estimate is the **median minutes per step** from the narrowest match that has at least 3
finished turns:

| # | Rung | Reached when |
|---|------|--------------|
| 1 | this provider + model + same size | the normal case, once history exists |
| 2 | this provider + model | a work size you have not done much of |
| 3 | this provider, any model | a model you just switched to |
| 4 | everything in this project | a provider you just switched to |
| 5 | the shared log in `TURN_ETA_DIR` | a brand-new project |
| 6 | 4 minutes per step | nothing to go on yet |

Median rather than mean, so one turn that ran long does not drag every future estimate with it. Only the
last 20 turns per rung count. The agent is told to print which rung it used, so the number is never a
mystery.

Set `TURN_ETA_DIR` to another `.eta` directory if you want a fresh project to borrow history from an old
one. It is only consulted when the local log has nothing to say.

## Contributing

The whole thing is one dependency-free Node script and a skill file. To check a change:

```bash
node turn-eta/scripts/eta.js --selftest
```

It covers path handling, the provider/model split, every rung of the ladder, per-step timing, and the
shared-log fallback. No test framework. Issues and pull requests welcome.

## License

MIT
