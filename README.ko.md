<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
    <img src="assets/logo.svg" width="120" alt="show-me-your-eta">
  </picture>
</p>

<h1 align="center">show-me-your-eta</h1>

<p align="center">
  <em>코딩 에이전트가 언제 끝날지 말해 주고 턴이 쌓일수록 그 말이 맞아 갑니다.</em>
</p>

<p align="center">
  <a href="https://skills.sh/2JIHAN/show-me-your-eta"><img src="https://skills.sh/b/2JIHAN/show-me-your-eta" alt="skills.sh"></a>
  <img src="https://img.shields.io/badge/works%20with-any%20agent-111111?style=flat-square" alt="Works with any agent">
  <img src="https://img.shields.io/badge/dependencies-none-111111?style=flat-square" alt="No dependencies">
  <img src="https://img.shields.io/badge/license-MIT-111111?style=flat-square" alt="MIT license">
</p>

<p align="center">
  <a href="README.md">English</a> · 한국어
</p>

---

에이전트는 20분짜리 일을 하면서도 20분 걸린다는 말을 하지 않습니다. 이 스킬은 무엇을 몇 스텝으로 할
건지와 끝날 시각을 먼저 적게 합니다. 그러고는 그 시각을 시계와 맞춰 보고, 어긋난 만큼을 기록해서 다음에
더 맞게 만듭니다.

<table>
<tr><th>없을 때</th><th>있을 때</th></tr>
<tr valign="top"><td>

> 고쳐볼게요.
>
> *…조용…*
>
> *…아직 작업 중…*
>
> 다 됐습니다!

</td><td>

> 1. 실패 재현
> 2. 날짜 파서 고치기
> 3. 픽스처 맞추기
> 4. 테스트 다시 돌리기
>
> *…작업…*
>
> **예상 종료시각: 17:45**

</td></tr>
</table>

스텝이 하나씩 끝날 때마다 실제로 몇 분 걸렸는지 잽니다. 그래서 초반부터 느린 턴은 끝나고서가 아니라
2스텝째에 그렇다고 말합니다. 턴이 닫히면 예상과 실제가 기록에 남고 다음 예상은 그 기록을 읽습니다.

어느 에이전트에서든, 어느 프로바이더와 모델에서든 씁니다.

## 빠르게 시작하기

**1. 설치**

```bash
npx skills add 2JIHAN/show-me-your-eta
```

Claude Code, Codex, Antigravity, Cursor, Gemini CLI, Copilot CLI 등
[`skills`](https://skills.sh) CLI가 아는 곳이면 다 됩니다. 프로젝트마다 말고 한 번만 깔려면 `-g`를
붙이세요.

**2. 기록은 git에서 빼기**

```bash
echo ".eta/" >> .gitignore
```

**3. 손이 좀 가는 일을 시킵니다**

```
> 결제 테스트 깨졌어, 고쳐줘
```

**4. 번호 붙인 계획과 끝날 시각을 먼저 내놓습니다**

```
1. 실패 재현
2. 날짜 파서 고치기
3. 픽스처 맞추기
4. 테스트 다시 돌리기

예상 종료시각: 17:45
```

둘 다 일을 시작하기 전에 나옵니다. 그래서 3번은 빼라고 아직 공짜일 때 자를 수 있습니다.

**5. 스텝마다 시간을 재고 남은 시간을 다시 계산합니다**

```
step 2/4 done in 4.1 min — 날짜 파서 고치기 (3.8 min/step so far) (next: 픽스처 맞추기)
ETA: 17:49
```

1번이 예상보다 오래 걸려서 끝날 시각이 밀렸습니다. 이게 도는 동안 보이는지, 끝나고 한꺼번에 보이는지는
에이전트마다 다릅니다. 대개는 턴 하나에 메시지 하나를 보냅니다.

**6. 끝나면 실제 시각과 어디서 어긋났는지가 나옵니다**

```
finished: 17:48 (estimated 14 min / actual 17 min)

| # | step | min |
|---|------|-----|
| 1 | 실패 재현 | 3.2 |
| 2 | 날짜 파서 고치기 | 8.1 |
| 3 | 픽스처 맞추기 | 1.9 |
| 4 | 테스트 다시 돌리기 | 3.8 |
```

예상은 일이 도는 동안에만 값어치가 있습니다. 끝난 뒤에 정직한 마지막 줄은 시계이고, 스텝별 시간이 어느
스텝이 예상을 잡아먹었는지 말해 줍니다.

**7. 몇 턴 지나면 그 숫자가 내 것이 됩니다**

```
4 steps, ~15 min (3.8 min/step from anthropic/claude-opus-5 M, 9 turns)
ETA: 18:22
```

첫 예상은 남이 정해 준 기본값입니다. 열 번째 예상은 내 컴퓨터에서, 내 코드로, 내가 실제로 쓰는 모델로
잰 값입니다.

> [!TIP]
> 설치하면 설명은 에이전트가 찾을 수 있는 자리에 놓입니다. 다만 매 턴 그걸 집어 드는지는 에이전트에
> 달렸습니다. [매 턴 확실히 걸리게 하기](#매-턴-확실히-걸리게-하기)를 보고 못 박아 두세요.

## 어떻게 도나

넷뿐입니다.

| | |
|---|---|
| **약속** | 손대기 전에 스텝을 이름으로 적고, 답변을 번호 목록과 끝날 시각으로 엽니다. 숫자만 세는 건 안 받습니다. |
| **측정** | 끝난 스텝마다 시간을 재고 남은 시간은 처음 예상이 아니라 방금 잰 속도로 다시 계산합니다. |
| **학습** | 예상과 실제가 기록에 쌓입니다. 다음 예상은 실제로 걸렸던 시간의 중앙값입니다. |
| **정직한 마무리** | 답변을 끝난 시각과 스텝별 표로 닫습니다. 시계가 이미 틀렸다고 판정한 예상을 다시 적지 않습니다. |

### 무엇을 적어 두나

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

턴 하나가 한 줄입니다. 스텝 이름, 얼마로 잡았는지, 실제로 얼마 걸렸는지, 스텝마다 몇 분씩 썼는지가
들어갑니다. 시각은 그 컴퓨터의 지역 시각으로 적고 오프셋을 붙입니다. 그래서 화면에 찍힌 시계와 눈으로
맞춰 볼 수 있고, 파일을 다른 데로 옮겨도 같은 순간을 가리킵니다.

```
# id     start                     steps  est_min  end                       actual_min  state  size  step_mins        step_names
48i35qek 2026-08-08T15:39:57+09:00  4  14  2026-08-08T15:56:44+09:00  17  done  M  4.1,3.2,5.0,4.7  실패 재현|파서|픽스처|재실행
```

홈 폴더가 아니라 **프로젝트 안**에, 그리고 **프로바이더와 모델로 갈라서** 두는 이유가 둘입니다.

- 에이전트는 작업 폴더 밖으로 나가지 못하게 묶여 있는 경우가 많습니다. 프로젝트 밖에 있는 기록은 못 읽는
  기록이고 기록을 못 읽는 예상은 그냥 고정값입니다.
- 모델마다 속도가 다릅니다. 한 모델에서 잰 속도를 다른 모델에 갖다 쓰면 어긋납니다.

### 예상이 좋아지는 방식

다음 예상은 **스텝당 실제 소요의 중앙값**입니다. 좁은 것부터 보고 끝난 기록이 3건 이상인 첫 칸에서
멈춥니다.

| # | 단 | 여기까지 오는 때 |
|---|------|-----------|
| 1 | 이 프로바이더 + 모델 + 같은 크기 | 기록이 쌓이면 보통 여기 |
| 2 | 이 프로바이더 + 모델 | 그 크기를 해본 적이 별로 없을 때 |
| 3 | 이 프로바이더의 모든 모델 | 모델을 방금 바꿨을 때 |
| 4 | 이 프로젝트의 모든 기록 | 프로바이더를 방금 바꿨을 때 |
| 5 | `TURN_ETA_DIR` 공용 기록 | 새 프로젝트를 막 열었을 때 |
| 6 | 스텝당 4분 | 아직 아무 기록도 없을 때 |

평균이 아니라 중앙값이라, 어쩌다 한 번 길었던 턴이 그다음 예상을 전부 밀어 올리지 않습니다. 각 단은 최근
20턴까지 봅니다. 어느 단을 썼는지 늘 같이 찍히니 숫자가 어디서 나왔는지 보입니다.

새 프로젝트가 예전 기록을 빌려 쓰게 하려면 `TURN_ETA_DIR`에 다른 `.eta` 폴더를 걸면 됩니다. 이 프로젝트
기록이 얇을 때만 봅니다.

## 매 턴 확실히 걸리게 하기

<details>
<summary><b>Claude Code</b></summary>

`.claude/hooks/inject-turn-eta.sh`로 저장합니다.

```sh
#!/bin/sh
S="$CLAUDE_PROJECT_DIR/.claude/skills/turn-eta"
[ -f "$S/SKILL.md" ] || exit 0
E="node $S/scripts/eta.js"
cat <<TXT
이번 턴에 실제 작업이 있으면 $S/SKILL.md 대로 한다.

- 시작 전에 \`$E plan "첫 스텝" "둘째 스텝" … --provider <p> --model <m> --size S|M|L\`
- 찍혀 나온 번호 목록과 \`ETA:\` 줄로 답변을 연다
- 스텝이 끝날 때마다 \`$E step <턴id>\`, 끝나면 \`$E done <턴id>\` — id는 필수다
- 답변은 \`done\`이 찍어 준 끝난 시각 줄과 스텝별 표로 닫는다
TXT
exit 0
```

`.claude/settings.json`에 등록합니다.

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "sh \"$CLAUDE_PROJECT_DIR/.claude/hooks/inject-turn-eta.sh\"" }] }
    ]
  }
}
```

훅은 클로드 코드를 다시 켜야 먹습니다.

</details>

<details>
<summary><b>다른 에이전트</b></summary>

턴마다 읽히는 지시문 파일이 있으면 어디든 됩니다 — `AGENTS.md`, `GEMINI.md`, 시스템 프롬프트, 규칙 파일.
한 줄이면 충분합니다.

```
실제 작업이 있는 턴이면 turn-eta 스킬대로 한다: 시작 전에 스텝을 이름으로 plan 하고, 번호 목록과
예상 종료시각으로 답변을 열고, 스텝이 끝날 때마다 step <턴id>, 끝나면 done <턴id>이 찍어 준
것으로 답변을 닫는다.
```

이게 없어도 스킬 설명만으로 걸리긴 합니다. 다만 덜 걸립니다.

</details>

## 자주 묻는 것

**느려지지 않나요?** 안 느려집니다. 턴마다 짧은 node 호출 몇 번이 전부고 네트워크도 의존성도 없습니다.

**에이전트가 `done`을 깜빡하면요?** 그 턴은 열린 채로 남고 예상 계산에서 빠집니다. 네 시간이 지나면
버려진 것으로 보고 무시합니다.

**제가 직접 칠 명령이 있나요?** 없습니다. 에이전트가 스킬을 읽고 부릅니다. 사람이 치는 건 설치 한 줄,
그리고 고칠 사람이라면 자체검증 한 줄뿐입니다.

**한 프로젝트에서 에이전트를 둘 돌리면요?** `plan`이 턴 id를 찍어 주고 `step`과 `done`이 그 id를
요구합니다. 자기가 열지 않은 턴은 닫지 못합니다.

**프로젝트끼리 기록을 나눠 쓰려면요?** `TURN_ETA_DIR`에 공용 `.eta` 폴더를 걸면 됩니다.

## 고치고 싶다면

의존성 없는 node 스크립트 하나와 스킬 파일 하나가 전부입니다.

```bash
node turn-eta/scripts/eta.js --selftest
```

경로 잡기, 프로바이더·모델 폴더 분기, 사다리 각 단, 스텝별 시간 재기, 버려진 턴 걸러내기, 공용 기록
빌려 쓰기를 덮습니다. 테스트 도구는 쓰지 않습니다. 이슈와 PR 환영합니다.

## 라이선스

[MIT](LICENSE)
