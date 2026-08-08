<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
    <img src="assets/logo.svg" width="120" alt="show-me-your-eta">
  </picture>
</p>

<h1 align="center">show-me-your-eta</h1>

<p align="center">
  <em>Your coding agent tells you when it will be done — and gets better at it every turn.</em>
</p>

<p align="center">
  <a href="https://skills.sh/2JIHAN/show-me-your-eta"><img src="https://skills.sh/b/2JIHAN/show-me-your-eta" alt="skills.sh"></a>
  <img src="https://img.shields.io/badge/works%20with-any%20agent-111111?style=flat-square" alt="Works with any agent">
  <img src="https://img.shields.io/badge/dependencies-none-111111?style=flat-square" alt="No dependencies">
  <img src="https://img.shields.io/badge/license-MIT-111111?style=flat-square" alt="MIT license">
</p>

<p align="center">
  English · <a href="README.ko.md">한국어</a>
</p>

---

Agents are happy to work for twenty minutes without telling you it will be twenty minutes. This skill
makes them lay out the steps and a finish time first, then checks that time against the clock.

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

> 1. reproduce the failure
> 2. fix the date parser
> 3. update the fixtures
> 4. re-run the suite
>
> *…work…*
>
> **ETA: 17:45**

</td></tr>
</table>

Every step is timed as it lands, so a turn that starts slow says so at step 2 instead of at the end.
When the turn closes, the estimate and the truth go into a log — and the next estimate reads that log.

It works with any agent, any provider, and any model.

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

**4. It opens with a numbered plan and a finish time**

```
1. reproduce the failure
2. fix the date parser
3. update the fixtures
4. re-run the suite

ETA: 17:45
```

Both land before the work starts, so you can cut step 3 while cutting it is still free.

**5. Each step is timed as it lands, and the rest is re-forecast**

```
step 2/4 done in 4.1 min — fix the date parser (3.8 min/step so far) (next: update the fixtures)
ETA: 17:49
```

Step 1 ran long, so the finish time moved. Whether you watch this happen or only see it at the end
depends on your agent — most send one message per turn.

**6. When it finishes, you get the real time and where it went**

```
finished: 17:48 (estimated 14 min / actual 17 min)

| # | step | min |
|---|------|-----|
| 1 | reproduce the failure | 3.2 |
| 2 | fix the date parser | 8.1 |
| 3 | update the fixtures | 1.9 |
| 4 | re-run the suite | 3.8 |
```

An estimate is only worth printing while the work is still running. Once it is done, the honest closing
line is the clock — and the per-step times say which step ate the estimate.

**7. A few turns later, the estimate is yours, not a guess**

```
4 steps, ~15 min (3.8 min/step from anthropic/claude-opus-5 M, 9 turns)
ETA: 18:22
```

The first estimate is a stock guess. The tenth is measured on your machine, in your codebase, with the
model you actually run.

> [!TIP]
> Installing puts the instructions where the agent can find them, but whether it reaches for them every
> turn is up to the agent. See [Make it fire every turn](#make-it-fire-every-turn) to pin it down.

## How it works

Four pieces:

| | |
|---|---|
| **Commit** | Before touching anything, the agent names the steps and opens its reply with the numbered plan and a finish time. A bare step count is refused. |
| **Measure** | Each finished step is timed and the remainder is re-forecast from the measured pace — not from the original guess. |
| **Learn** | The estimate and the actual land in a log. The next estimate is the median of what really happened. |
| **Close honestly** | The reply ends with the finish time and the per-step table, not with an ETA the clock already disproved. |

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

One tab-separated row per turn — the steps by name, the estimate, the actual, and how long each step
ran. Times are written in the machine's own zone with the offset attached, so they line up with the
clock the agent printed and still resolve to the right instant if the file moves:

```
# id     start                     steps  est_min  end                       actual_min  state  size  step_mins        step_names
48i35qek 2026-08-08T15:39:57+09:00  4  14  2026-08-08T15:56:44+09:00  17  done  M  4.1,3.2,5.0,4.7  reproduce|fix parser|fixtures|re-run
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
turns per rung. The rung it used is printed every time, so you can see where the number came from.

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
E="node $S/scripts/eta.js"
cat <<TXT
If this turn contains real work, follow $S/SKILL.md.

- Before starting: \`$E plan "first step" "second step" … --provider <p> --model <m> --size S|M|L\`
- Open the reply with the numbered list and the \`ETA:\` line it prints
- \`$E step <turn id>\` as each step lands, \`$E done <turn id>\` at the end — the id is required
- Close the reply with what \`done\` prints: the finish line and the per-step table
TXT
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
When a turn contains real work, follow the turn-eta skill: plan the steps by name before
starting, open the reply with the numbered plan and its ETA, call step <id> as each step
lands, and close with what done prints.
```

Without it the skill still triggers on its own description; it just fires less often.

</details>

## FAQ

**Does it slow anything down?** No. A handful of short Node calls per turn, no network, no
dependencies.

**What if the agent forgets to call `done`?** The turn stays open and is ignored by every estimate.
After four hours it is treated as abandoned.

**Two agents in one project?** `plan` prints a turn id and `step` and `done` require it. Neither can
close a turn it did not open.

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
