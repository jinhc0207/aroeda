# analyze-situation

사용자의 '지금 나의 상황' 한 문장을 아뢰다 표준 태그 구조(Situation Analysis)로 바꿔 돌려주는 Edge Function.

아직 배포하지 않았습니다.

## 요청

```
POST /analyze-situation
{ "situation": "사용자가 입력한 한국어 문장" }
```

- POST만 허용
- `situation`은 문자열, 공백을 제외하고 한 글자 이상, 최대 3000자

## 응답

성공 (200)

```json
{
  "ok": true,
  "analysis": {
    "primaryDomain": "...",
    "secondaryDomains": [],
    "situationTags": [],
    "emotionTags": [],
    "spiritualQuestionTags": [],
    "prayerModes": [],
    "pastoralFunctions": [],
    "safety": { "level": "...", "categories": [] },
    "confidence": 0.0
  }
}
```

실패

```json
{ "ok": false, "error": "오류코드" }
```

| 오류코드 | HTTP |
| --- | --- |
| `METHOD_NOT_ALLOWED` | 405 |
| `INVALID_JSON` | 400 |
| `INVALID_INPUT` | 400 |
| `SITUATION_TOO_LONG` | 400 |
| `OPENAI_API_KEY_MISSING` | 500 |
| `OPENAI_REQUEST_FAILED` | 502 |
| `INVALID_ANALYSIS_RESPONSE` | 502 |
| `INTERNAL_ERROR` | 500 |

OpenAI의 상세 오류 메시지는 사용자에게 전달하지 않습니다.

## 파일

- `index.ts` — Deno 진입점. `Deno.env.get("OPENAI_API_KEY")`로 키를 읽고 OpenAI Responses API를 호출한다.
- `handler.ts` — 실제 처리. Deno 전용 코드가 없어서 Node에서도 테스트할 수 있다.
- `handler.test.ts` — 실제 OpenAI 호출 없이 도는 테스트 (`npm test`에 포함).

지시문과 응답 구조는 새로 쓰지 않고 `supabase/functions/_shared/analyzer-contract.ts` 한 곳에서 가져다 씁니다.
로컬 테스트 프로그램(`npm run test:openai:e2e`)도 같은 파일을 씁니다. 규칙의 원본은 언제나 `_shared`입니다.
앱과 기존 코드는 `src/lib`, `src/data`의 같은 이름 파일을 계속 쓰면 됩니다. 그 파일들은 `_shared`를 그대로 다시 내보내는 얇은 파일입니다.

## 개인정보

- 사용자의 문장을 저장하지 않습니다.
- OpenAI 요청은 `store: false`입니다.
- 로그에는 요청 id, 오류 종류, HTTP 상태만 남깁니다. 문장 원문과 OpenAI 원본 응답은 남기지 않습니다.
- 응답에는 OpenAI 원본과 usage를 포함하지 않습니다.

## 안전(safety)

이 함수는 안전 상황을 발견해도 상담 문구나 성경구절을 만들지 않습니다.
`safety.level`과 `safety.categories`만 정확히 돌려주고, 실제 분기는 Recommendation Gate 단계에서 처리합니다.

## 배포 전에 확인할 것

배포는 아직 하지 않았습니다. 배포 시점에 두 가지를 확인해야 합니다.

1. Supabase 프로젝트에 `OPENAI_API_KEY` 시크릿을 등록해야 합니다. 키를 코드나 파일에 넣지 않습니다.
2. 이 함수는 `supabase/functions` 폴더 바깥을 참조하지 않습니다. 공용 규칙은 모두 `../_shared`에서 가져옵니다.
   `_shared`에는 Deno 전용 코드나 서버 전용 코드가 들어가지 않습니다. 순수 TypeScript 규칙 파일만 둡니다.
