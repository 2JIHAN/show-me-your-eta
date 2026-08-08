<div align="center">

# show-me-your-eta

**Your coding agent tells you when it will be done — and gets better at it every turn.**

[![skills.sh](https://skills.sh/b/2JIHAN/show-me-your-eta)](https://skills.sh/2JIHAN/show-me-your-eta)
[![License: MIT](https://img.shields.io/badge/License-MIT-black.svg)](LICENSE)
[![No dependencies](https://img.shields.io/badge/dependencies-none-black.svg)](turn-eta/scripts/eta.js)

English · [한국어](README.ko.md)

</div>

---

Agents are happy to work for twenty minutes without telling you it will be twenty minutes. This skill
makes them commit to a number, hold themselves to it, and learn from every miss.

<table>
<tr><th>Without it</th><th>With it</th></tr>
<tr valign="top"><td>

> Let me fix that.
>
> *…silence…*
>
> *…still working…*
>
> Done!

</td><td>

> Four steps: read the failing test, fix the parser, update the fixtures, re-run the suite.
>
> *…work…*
>
> **ETA: 17:45**

</td></tr>
</table>

Every step is timed as it lands, so a turn that starts slow says so at step 2 instead of at the end.
When the turn closes, the estimate and the truth go into a log — and the next estimate reads that log.

Any agent. Any provider. Any model.

## Quickstart

**1. Install it**

```bash
npx skills add 2JIHAN/show-me-your-eta
```

Works with Claude Code, Codex, Antigravity, Cursor, Gemini CLI, Copilot CLI, and everything else the
[`skills`](https://skills.sh) CLI knows. Add `-g` to install once for every project.

**2. Keep the log out of git**

```bash
echo ".eta/" >> .gitignore
```

**3. Ask your agent for something that takes real work**

```
> the checkout tests are failing, fix them
```

**4. It answers with a plan and a finish time**

```
Four steps: reproduce the failure, fix the date parser, update the fixtures,
re-run the suite.

…

ETA: 17:45
```

**5. It reports as each step lands**

```
step 2/4 done in 4.1 min (3.8 min/step so far)
ETA: 17:49
```

**6. When it finishes, the miss is written down**

```
estimated 14 min / actual 17 min (3 min short)
```

**7. A few turns later, the estimate is yours, not a guess**

```
4 steps, ~15 min (3.8 min/step from anthropic/claude-opus-5 M, 9 turns)
ETA: 18:22
```

That last line is the whole point. The first estimate is a stock guess. The tenth is measured from your
machine, your codebase, and the model you actually use.

> [!TIP]
> Installing puts the instructions where the agent can find them, but whether it reaches for them every
> turn is up to the agent. See [Make it fire every turn](#make-it-fire-every-turn) to pin it down.

## How it works

Three pieces, no magic:

| | |
|---|---|
| **Commit** | Before touching anything, the agent counts the steps and prints a finish time as the last line of its reply. |
| **Measure** | Each finished step is timed and the remainder is re-forecast from the measured pace — not from the original guess. |
| **Learn** | The estimate and the actual land in a log. The next estimate is the median of what really happened. |

### What it writes down

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

One tab-separated row per turn — steps, estimate, actual, and how long each step ran:

```
# id     start                 steps  est_min  end                   actual_min  state  size  step_mins
48i35qek 2026-08-08T06:39:57Z  4      14       2026-08-08T06:56:44Z  17          done   M     4.1,3.2,5.0,4.7
```

It lives **inside the project**, split by **provider and model**, for two reasons:

- Agents are often confined to their working directory. A log outside the project is a log the agent
  cannot read, and an estimator that cannot read its history is just a constant.
- Models do not work at the same speed. A pace measured on one model is a bad prior for another.

### How the estimate gets better

The next estimate is the **median minutes per step** from the narrowest match with at least 3 finished
turns:

| # | Rung | Reached when |
|---|------|--------------|
| 1 | this provider + model + same size | the normal case, once history exists |
| 2 | this provider + model | a work size you have not done much of |
| 3 | this provider, any model | a model you just switched to |
| 4 | everything in this project | a provider you just switched to |
| 5 | the shared log in `TURN_ETA_DIR` | a brand-new project |
| 6 | 4 minutes per step | nothing to go on yet |

Median rather than mean, so one turn that ran long does not drag every future estimate with it. Last 20
turns per rung. The rung it used is printed every time, so the number is never a mystery.

Point `TURN_ETA_DIR` at another `.eta` directory to let a fresh project borrow from an old one. It is
only consulted when the local log has nothing to say.

## Make it fire every turn

<details>
<summary><b>Claude Code</b></summary>

Save this as `.claude/hooks/inject-turn-eta.sh`:

```sh
#!/bin/sh
S="$CLAUDE_PROJECT_DIR/.claude/skills/turn-eta"
[ -f "$S/SKILL.md" ] || exit 0
echo "If this turn contains real work, follow $S/SKILL.md — plan before starting, the ETA as the last paragraph of the reply, step as each step lands, done at the end."
exit 0
```

Register it in `.claude/settings.json`:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "sh \"$CLAUDE_PROJECT_DIR/.claude/hooks/inject-turn-eta.sh\"" }] }
    ]
  }
}
```

Restart Claude Code for the hook to take effect.

</details>

<details>
<summary><b>Other agents</b></summary>

Anything with a per-turn instruction file works — `AGENTS.md`, `GEMINI.md`, a system prompt, a rules
file. One line is enough:

```
When a turn contains real work, follow the turn-eta skill: plan before starting,
the ETA as the last paragraph of the reply, step as each step lands, done at the end.
```

Without it the skill still triggers on its own description; it just fires less often.

</details>

## FAQ

**Does it slow anything down?** No. Three short Node calls per turn, no network, no dependencies.

**What if the agent forgets to call `done`?** The turn stays open and is ignored by every estimate.
After four hours it is treated as abandoned.

**Two agents in one project?** `plan` prints a turn id — pass it to `step` and `done` and they stay out
of each other's way.

**Do I have to run anything myself?** No. The agent reads the skill and calls the script. The only
commands you type are the install and, if you contribute, the self-test.

**Can I share history across projects?** Set `TURN_ETA_DIR` to a shared `.eta` directory.

## Contributing

One dependency-free Node script and one skill file. To check a change:

```bash
node turn-eta/scripts/eta.js --selftest
```

Covers path handling, the provider/model split, every rung of the ladder, per-step timing, and the
shared-log fallback. No test framework. Issues and pull requests welcome.

## License

[MIT](LICENSE)
