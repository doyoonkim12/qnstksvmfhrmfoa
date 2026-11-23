# 교차 검증 키트 (Claude 수정 → Codex 검증)

Claude Code 가 코드를 고치고 멈출 때마다 **Codex(GPT)가 자동으로 검증**하고,
FAIL 이면 Claude 가 고치거나 근거로 반박한다. 재수정은 최대 2번,
그래도 남는 건 **사장님 체크리스트**로 `reviews/` 파일과 세션에 남는다.

```
Claude 수정 → (멈추는 순간) 테스트 실행 + Codex 검증
   ├─ PASS ─────────────────────────────→ 체크리스트(위험 경로만) → 끝
   └─ FAIL → Claude 재수정/반박 → 재검증 (최대 2번) → 남은 지적 = 체크리스트 → 끝
```

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
"UserPromptSubmit": [{ "hooks": [{ "type": "command",
  "command": "node \"$CLAUDE_PROJECT_DIR/.claude/cross-review/cross-review.js\" prompt" }] }],
"Stop": [{ "hooks": [{ "type": "command", "timeout": 1200,
  "command": "node \"$CLAUDE_PROJECT_DIR/.claude/cross-review/cross-review.js\" stop" }] }]
```

4. `.gitignore` 에 추가

```
.claude/cross-review/state.json
.claude/cross-review/last-review-*.txt
```

5. Claude Code 를 새로 시작 (훅은 시작할 때 읽힘)

## 동작 규칙

- 코드 파일이 안 바뀌었으면 검증 안 함 (질문·문서 작업은 그냥 통과)
- 같은 상태를 두 번 검증하지 않음 → 무한 반복 없음
- Codex 는 **읽기 전용**으로만 실행 (코드 수정 불가)
- 리뷰어가 답을 못 하면 `NOT_PROVEN` — 통과로 치지 않고 체크리스트에 올림
- 이 컴퓨터에 `codex` 가 없으면 검증을 건너뛰고 알림만 남김
- 키트 자체 오류로는 Claude 작업이 막히지 않음
- 잠깐 끄기: `CROSS_REVIEW_OFF=1 claude`

## 비가역 작업은 키트와 별개

검증 PASS 는 "코드가 맞아 보인다"는 뜻이지 **운영 반영 승인이 아니다.**
실주문·결제·운영 배포·DB 마이그레이션·키 교체는 PASS 여도 사람 결재.
