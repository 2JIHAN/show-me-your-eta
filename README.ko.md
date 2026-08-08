# show-me-your-eta

코딩 에이전트한테 "이거 언제 끝나?"를 매번 묻지 않아도 되게 만드는 스킬이다.

일을 시작하기 전에 에이전트가 이번 턴을 몇 스텝으로 나눌지 세고 끝날 시각을 말한다. 스텝이 하나씩
끝날 때마다 실제로 몇 분 걸렸는지 재고, 턴이 끝나면 예상과 실제를 기록에 남긴다. 다음 예상은 그 기록을
읽고 낸다. 오래 쓸수록 숫자가 맞아 간다.

어느 에이전트든, 어느 프로바이더든, 어느 모델이든 쓴다.

[English](README.md) · **한국어**

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

## 설치

```bash
npx skills add 2JIHAN/show-me-your-eta
```

에이전트의 스킬 폴더에 깔린다 — Claude Code, Codex, Antigravity, Gemini CLI, Copilot CLI 등
[`skills`](https://skills.sh) CLI가 아는 곳이면 다 된다. 지금 프로젝트가 아니라 사용자 전체에 깔려면
`-g`를 붙인다.

받아 오는 의존성이 없다. node 스크립트 하나뿐이라 `node_modules`도 빌드도 없다.

## 어떻게 도나

### 기록은 프로젝트 안에, 프로바이더와 모델로 갈라서

```
<프로젝트 루트>/.eta/
├── anthropic/
│   ├── claude-opus-5/log.tsv
│   └── claude-haiku-4-5/log.tsv
├── openai/
│   └── gpt-5-codex/log.tsv
└── google/
    └── gemini-3-pro/log.tsv
```

홈 폴더에 한 장으로 두지 않은 이유가 둘이다.

- **에이전트는 작업 폴더 밖으로 못 나가게 묶여 있는 경우가 많다.** 프로젝트 밖에 있는 기록은 못 읽는
  기록이고, 기록을 못 읽는 예상은 그냥 고정값이다.
- **모델마다 속도가 다르다.** 한 모델에서 잰 속도를 다른 모델에 그대로 갖다 쓰면 어긋난다. 폴더로
  갈라 두고, 빌려 쓸지 말지는 아래 사다리가 정한다.

`.eta/`는 `.gitignore`에 넣는다. 내 컴퓨터에서 내 턴을 잰 값이라 남한테는 안 맞는다.

### 예상은 사다리를 타고 내려온다

`plan`은 **스텝당 실제 소요의 중앙값**을 쓴다. 좁은 것부터 보고, 끝난 기록이 3건 이상인 첫 칸에서
멈춘다.

| # | 단 | 언제 |
|---|------|-----------|
| 1 | 이 프로바이더 + 모델 + 같은 크기 | 기록이 쌓이면 보통 여기 |
| 2 | 이 프로바이더 + 모델 | 그 크기를 해본 적이 별로 없을 때 |
| 3 | 이 프로바이더의 모든 모델 | 모델을 방금 바꿨을 때 |
| 4 | 이 프로젝트의 모든 기록 | 프로바이더를 방금 바꿨을 때 |
| 5 | `TURN_ETA_DIR` 공용 기록 | 새 프로젝트를 막 열었을 때 |
| 6 | 스텝당 4분 | 아직 아무 기록도 없을 때 |

평균이 아니라 중앙값이라, 어쩌다 한 번 길었던 턴이 그다음 예상을 전부 밀어 올리지 않는다. 각 단은 최근
20턴까지만 본다. `plan`은 어느 단을 썼고 몇 건이 받쳐 주는지를 늘 같이 찍는다.

### 스텝은 재는 것이지 넘겨짚는 게 아니다

`step`은 그 스텝이 실제로 몇 분 걸렸는지 적고, 남은 스텝은 처음 예상이 아니라 방금 잰 속도로 다시
계산한다. 초반부터 느린 턴은 끝나고서가 아니라 2스텝째에 그렇다고 말한다.

## 쓰는 법

```bash
eta.js plan <스텝수> --provider <p> --model <m> [--size S|M|L]
eta.js step [id]
eta.js done [id]
eta.js stats [--provider <p> --model <m>]
```

| 옵션 | 뜻 |
|------|---------|
| `--provider` | 모델을 돌리는 쪽 — `anthropic`, `openai`, `google` 등 |
| `--model` | 모델 이름 — `claude-opus-5`, `gpt-5-codex`, `gemini-3-pro` 등 |
| `--size` | `S` 잔손질, `M` 보통(기본), `L` 덩어리 큰 일 |
| `--dir` | 다른 `.eta` 폴더를 보게 한다(주로 시험용) |

셸은 지금 자기를 돌리는 모델이 뭔지 알 수 없다. 그래서 에이전트가 `--provider`와 `--model`을 직접
넘긴다. 스킬 파일에 그렇게 하라고 적혀 있다. 안 넘기면 `unknown/unknown`으로 들어간다.

| 환경변수 | 뜻 |
|---|---|
| `TURN_ETA_DIR` | 이 프로젝트 기록이 얇을 때 빌려 볼 다른 `.eta` 폴더 |

## 에이전트가 실제로 하게 만들기

스킬을 깔면 설명은 에이전트가 찾을 수 있는 자리에 놓인다. 매 턴 그걸 집어 드는지는 에이전트에 달렸다.
클로드 코드에서는 `UserPromptSubmit` 훅이 확실하다.

```sh
#!/bin/sh
S="$CLAUDE_PROJECT_DIR/.claude/skills/turn-eta"
[ -f "$S/SKILL.md" ] || exit 0
echo "이번 턴에 실제 작업이 있으면 $S/SKILL.md 대로 한다 — 시작 전에 plan, 답변 마지막 문단에 예상 종료시각, 스텝이 끝날 때마다 step, 다 끝나면 done."
exit 0
```

`.claude/settings.json`의 `hooks.UserPromptSubmit`에 등록한다. 다른 에이전트도 비슷한 자리가 있다.
훅 없이도 돌긴 하는데, 그러면 덜 걸린다.

## 개발

```bash
node turn-eta/scripts/eta.js --selftest
```

경로 잡기, 폴더 분기, 사다리 각 단, 스텝별 시간 재기, 공용 기록 빌려 쓰기를 덮는다. 테스트 도구는 안
쓴다.

## 라이선스

MIT
