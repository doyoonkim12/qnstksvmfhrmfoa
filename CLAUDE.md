# userbot-router

텔레그램 **유저봇**(개인 계정으로 동작). 소스 방에 들어오는 **은행 입금 문자**를 읽고,
규칙에 맞는 타겟 방(지점별 입금방)으로 보기 좋게 정리해서 다시 보낸다.
Render(무료 플랜)에서 상시 실행 중 — `main` 브랜치가 곧 운영.

## 구조

| 파일 | 역할 |
|---|---|
| `userbot-router.js` | 진입점. 텔레그램 연결, 이벤트 핸들러, `/healthz` 서버, keepalive 핑. 부작용 있음(실행 시 바로 접속) |
| `src/config.js` | 방 ID(`TARGETS`), 방 타이틀, **라우팅 규칙**. 규칙 추가/변경은 거의 여기서만 |
| `src/routing.js` | 순수 함수: `shouldForward`, `matchTargets`, `calcOriginTitle`, `buildBody` |
| `src/format.js` | 순수 함수: `formatMessage` (입금 문자 정리) |
| `login-once.js` | 최초 1회 SESSION 문자열 생성용 (대화형, 로컬에서만) |
| `test/` | `node:test` 기반 테스트 (외부 의존성 없음) |

## 동작 규칙 (바꾸면 안 되는 것들)

- "입금"이 있고 "출금"이 없을 때만 전달 (공백 무시).
- **배타 규칙**이 하나라도 걸리면 그 타겟으로만 보내고 누적 규칙은 무시.
- **누적 규칙**은 걸린 것들의 타겟을 합치고 중복 제거.
- 종로 입금방(`JONGNO_DEPOSIT`)에는 출처 종로 방 이름(1차 > 2차 > 3차 우선)을 타이틀로 붙임.
- `formatMessage`는 정리 결과가 비면 원문을 그대로 반환.

## 명령어

```bash
npm test        # 테스트
npm run check   # 전체 문법 검사
npm start       # 실행 (API_ID, API_HASH, SESSION 환경변수 필요 → 로컬에서 함부로 돌리지 말 것)
```

## 작업 규칙

- **비밀값 절대 커밋 금지**: `SESSION`, `API_ID`, `API_HASH`는 Render 환경변수에만. 코드에서는 `process.env`로만 읽는다.
  (`.claude/hooks/guard-secrets.js` 훅이 커밋/푸시 때 검사함)
- 라우팅/포맷 로직을 바꿀 땐 **테스트를 먼저** 추가하거나 고친 다음 코드 수정.
  `.js` 파일 수정 시 `.claude/hooks/run-tests.js` 훅이 자동으로 문법 검사 + 테스트를 돌린다.
- 새 은행 문자 형식을 지원할 땐 실제 문자 예시(개인정보는 마스킹)를 `test/format.test.js`에 케이스로 추가.
- `userbot-router.js`에는 텔레그램/HTTP 연결 코드만 둔다. 판단 로직은 `src/`의 순수 함수로.
- 실제 계정으로 메시지를 보내는 코드(`sendMessage`)는 테스트에서 호출하지 않는다.
  유저봇은 과도한 요청 시 텔레그램 계정이 정지될 수 있음.
- `main`에 바로 푸시하지 말고 브랜치 → CI 통과 → 사람이 확인 후 머지. (`main` = 운영 배포)
- 새 타겟 방 ID가 필요하면 그 방에서 `/probe` 입력 → 봇이 chat_id를 답장함.

## 알려진 이슈 / 확인 필요

- `src/format.js`의 `isMaskedAccount`가 `*`나 `-`가 들어간 줄을 전부 지워서
  `박*영(2982)` 같은 마스킹 이름 줄도 결과에서 빠진다. 의도인지 확인 필요 (테스트에 현재 동작으로 기록됨).
- `TARGETS.JONGNO1`(종로1차)은 정의돼 있지만 이를 타겟으로 하는 규칙이 없다 → 현재 이 방으로는 아무것도 안 감.
