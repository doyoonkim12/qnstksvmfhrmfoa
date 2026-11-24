# Codex ↔ Claude 협업 키트

역할을 나눠서 **한 Claude Code 세션 안에서** 주고받는다. 단계 사이에 기다리는 틈은 없다.

| 단계 | 담당 |
|---|---|
| 기획 · 설계 · 작업 계획(완료 기준 C1, C2 …) | **Codex** |
| 구현 · 수정 | **Claude Code** |
| 검토 · 반박 · 수정 제안 (자기 계획 기준) | **Codex** |
| 다시 수정 | **Claude Code** |
| 예시 사진 · 목업 · 일러스트 | **GPT** (`gen-image.js`) |
| 재수정 2번 후에도 의견이 갈린 것 | **Gemini 심판** (CLI → 안 되면 크롬 임시 채팅) |
| 심판 뒤에도 남은 것 | **사장님 체크리스트** |

```
사장님 요청 → Codex 기획 → Claude 구현 → Codex 검토(테스트와 동시에)
   ├─ PASS ───────────────────────────────→ 체크리스트(위험 경로만) → 끝
   └─ FAIL → Codex 수정 제안 → Claude 수정 → Codex 재검토 (최대 2번) → 남은 것 = 체크리스트
```

Codex 는 매 회차에 **자기 계획 + 지난 지적 + Claude 의 답**을 전부 넘겨받아 같은 대화처럼 이어간다.
기록은 `reviews/` 한 파일에 기획 → 회차별 검토 → 최종 정리 순으로 쌓인다.

## 설치 (프로젝트마다 한 번)

1. 이 폴더(`.claude/cross-review/`)를 프로젝트의 `.claude/` 아래에 복사
2. `config.json` 수정
   - `testCmd`: 그 프로젝트의 테스트 명령 (예: `pnpm verify:fast`, `pytest -q`). 비우면 테스트 없이 검증
   - `riskyPaths`: 바뀌면 PASS 여도 "사장님 결재" 항목을 붙일 경로 (결제·주문·배포·키)
   - `reviewCmd`: 기본은 `codex exec --sandbox read-only --skip-git-repo-check -o {out} -`
     (옵션 이름은 2026-11 macOS ChatGPT 앱 내장 codex 에서 확인됨)
   - `codex` 가 PATH 에 없어도 자동으로 찾음: macOS ChatGPT 앱 내장 CLI, Homebrew,
     `~/.local/bin`, npm 전역(Windows `%APPDATA%\npm\codex.cmd`) 순서.
     그래도 못 찾으면 환경변수 `CROSS_REVIEW_CODEX` 에 전체 경로를 넣는다.
     → **config.json 에 컴퓨터별 전체 경로를 적지 말 것** (다른 컴퓨터에서 깨짐)
3. `.claude/settings.json` 의 `hooks` 에 추가

```json
"UserPromptSubmit": [{ "hooks": [{ "type": "command", "timeout": 900,
  "command": "node \"$CLAUDE_PROJECT_DIR/.claude/cross-review/cross-review.js\" prompt" }] }],
"Stop": [{ "hooks": [{ "type": "command", "timeout": 1200,
  "command": "node \"$CLAUDE_PROJECT_DIR/.claude/cross-review/cross-review.js\" stop" }] }]
```

4. `.gitignore` 에 추가

```
.claude/cross-review/state*.json
.claude/cross-review/last-review-*.txt
```

5. Claude Code 를 새로 시작 (훅은 시작할 때 읽힘)

## 기획 설정

- `planning` (기본 `true`): 요청이 오면 Codex 가 먼저 저장소를 읽고 계획을 세워 Claude 에게 넘김.
  질문·설명 요청처럼 코드 작업이 아니면 Codex 가 `PLAN: NONE` 으로 건너뜀
- `planMinChars` (기본 20): 이보다 짧은 메시지("응", "진행해")는 기획하지 않고 하던 작업을 이어감
- `planTier` (기본 `large`): 기획에 쓸 `modelTiers` 단계
- `planApproval` (기본 `false`): `true` 면 Claude 가 계획을 보여주고 **사장님 승인 후** 구현. 코인·결제 프로젝트는 `true` 권장
- `planTimeoutSec` (기본 600): 넘으면 기획 없이 진행하고 그 사실을 사장님께 알림 (NOT_PROVEN)
- 훅 대기: 기획하는 동안(보통 1~5분) Claude 는 시작하지 않고 기다린다. UserPromptSubmit 훅 `timeout` 은 900 이상으로

## Gemini 심판

재수정을 다 하고도 Codex 지적이 남으면, 체크리스트로 넘기기 전에 Gemini 가 항목마다 판정한다.

- `judge` (기본 `true`), `judgeCmd` (기본 `gemini -p "..."` — Gemini CLI. 비우면 크롬으로 바로), `judgeTimeoutSec` 300
- Gemini 가 **CLAUDE** 로 판정한 지적은 빠지고(⚖️ 기록), **CODEX** 로 판정한 것만 체크리스트에 남음. 다 빠지면 `PASS(Gemini 심판)`
- `gemini` 는 PATH 에 없어도 Homebrew·npm 위치에서 찾음. 그래도 없으면 환경변수 `CROSS_REVIEW_GEMINI`
- `judgeChromeFallback` (기본 `true`): CLI 가 안 되면(없음·한도·이상한 답) `reviews/…-심판요청.md` 를 만들고,
  Claude 에게 **크롬 Gemini 임시 채팅**으로 판정받아 `node .claude/cross-review/cross-review.js note <기록파일> < 답` 으로 기록하게 함.
  크롬이 연결돼 있지 않으면 체크리스트 그대로
- 계정 2개가 있으면: CLI 는 계정 1, 크롬은 계정 2 로 로그인해 두면 한도에 덜 걸림
- Gemini CLI 후속은 **Antigravity CLI (`agy`)** — 개인 요금제 계정 로그인, `agy -p "..."` 로 한 번 실행 후 종료(headless). 맥에서 확인되면 `judgeCmd` 를 `agy -p "표준 입력으로 받은 글을 …"` 로 바꾼다 (표준 입력을 읽는지 먼저 시험). 환경변수 `CROSS_REVIEW_AGY` 로 경로 지정 가능
- ⚠️ 2026-11 기준 Gemini CLI 는 개인 구글 계정 로그인이 막혔다("no longer supported for Gemini Code Assist for individuals"). 그 경우 `"judgeCmd": ""` 로 두면 CLI 를 건너뛰고 바로 크롬 Gemini(임시 채팅)로 판정한다

## 이미지 생성 (GPT 담당)

예시 사진·목업·일러스트가 필요하면 Claude 는 직접 만들지 않고 GPT 에게 맡긴다.

```bash
node .claude/cross-review/gen-image.js "<무엇을 그릴지>" <저장 경로.png> [--size 1024x1024]
```

- `imageCmd` (기본 `codex exec --sandbox workspace-write --skip-git-repo-check -o {log} -`): 그림 파일을 써야 해서 쓰기 권한 샌드박스
- **진짜 그림 파일(PNG/JPEG/WEBP)이 생겼는지 파일 앞부분까지 검사**. "만들었다"는 말만 있고 파일이 없으면 실패(NOT_PROVEN)
- Codex 가 그림 말고 다른 파일을 바꾸면 경고 (자동으로 되돌리지 않음)
- 기록: `reviews/images.md`
- Codex 로 이미지가 안 되면: Higgsfield 연결의 `generate_image`(기본 모델 GPT 이미지)로 대신 — 스크립트가 실패할 때 그렇게 안내함
- Codex 계획의 `## 이미지` 항목에 필요한 그림이 적혀 나온다
- 기획 없이 하는 작업에서도 이 규칙을 지키게 하려면 프로젝트에 `CLAUDE.local.md`(개인용, git 에 안 올라감)를 만들고 한 줄 넣는다:
  `- 예시 사진·목업·일러스트는 직접 만들지 말고 node .claude/cross-review/gen-image.js 로 GPT 에게 맡긴다.`
  (`CLAUDE.local.md` 가 git 에 안 막혀 있으면 `.git/info/exclude` 에 추가)

## 속도 설정

- **기다리는 틈 없음**: Claude 가 멈추는 순간 검증 시작, 검증이 끝나는 순간 결과가 Claude 에게 감
- `parallelTests` (기본 `true`): 테스트와 Codex 를 **동시에** 돌림 → 걸리는 시간 = 둘 중 긴 쪽.
  테스트가 깨지면 Codex 가 PASS 해도 키트가 FAIL(`[T1]`)로 합침. `false` 면 테스트 결과를 Codex 에게 보여준 뒤 검증(더 느림)
- `modelTiers`: 바뀐 줄 수에 따라 Codex 옵션을 고름 (`tierLines`: 40줄 이하 small, 400줄 이하 medium, 그 위 large).
  `riskyPaths` 를 건드리면 크기와 상관없이 `risky`. 값은 `codex exec` 바로 뒤에 붙는 옵션 문자열:

```json
"modelTiers": {
  "small":  "-m <빠른 모델> -c model_reasoning_effort=low",
  "medium": "",
  "large":  "-m <가장 좋은 모델> -c model_reasoning_effort=high",
  "risky":  "-m <가장 좋은 모델> -c model_reasoning_effort=high"
}
```

  모델 이름과 `-c` 옵션은 그 컴퓨터의 `codex exec --help` 와 `codex` 설정에서 확인해서 채운다. 비워 두면 Codex 기본 모델.
- `reviews/` 기록에 회차마다 **모델 단계와 걸린 시간**(테스트·Codex 각각)이 남아서 어디가 느린지 볼 수 있음

## 동작 규칙

- 코드 파일이 안 바뀌었으면 검증 안 함 (질문·문서 작업은 그냥 통과)
- 같은 상태를 두 번 검증하지 않음 → 무한 반복 없음
- 세션마다 상태 파일을 따로 씀(`state-<세션>.json`) → 같은 폴더에서 Claude 여러 개가 떠 있어도 검토 회차가 안 섞임. 다만 작업 트리는 같이 쓰므로, 한 폴더에서 동시에 코드를 고치는 Claude 는 하나만 두는 게 좋다
- Codex 는 **읽기 전용**으로만 실행 (코드 수정 불가)
- 리뷰어가 답을 못 하면 `NOT_PROVEN` — 통과로 치지 않고 체크리스트에 올림
- 이 컴퓨터에 `codex` 가 없으면 검증을 건너뛰고 알림만 남김
- 키트 자체 오류로는 Claude 작업이 막히지 않음
- 잠깐 끄기: `CROSS_REVIEW_OFF=1 claude`

## 비가역 작업은 키트와 별개

검증 PASS 는 "코드가 맞아 보인다"는 뜻이지 **운영 반영 승인이 아니다.**
실주문·결제·운영 배포·DB 마이그레이션·키 교체는 PASS 여도 사람 결재.
