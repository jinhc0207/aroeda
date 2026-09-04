# recommend-scripture

사용자의 '지금 나의 상황' 한 문장을 받아 Recommendation Gate 판단까지 수행하는 Edge Function.

아직 배포하지 않았습니다.

## 흐름

```
situation
→ OpenAI Situation Analyzer (analyze-situation과 완전히 같은 규칙)
→ validateSituationAnalysis
→ Recommendation Gate
→ route
```

이번 단계에서는 Gate 판단까지만 합니다.
성경 원문, 사용자용 설명, 기도 방향, 안전 안내 문구는 아직 만들지 않습니다.

## 요청

```
POST /recommend-scripture
{ "situation": "사용자가 입력한 한국어 문장" }
```

입력 규칙은 analyze-situation과 같습니다. POST만 허용, 문자열, 공백 제외 한 글자 이상, 최대 3000자.

## 응답

성공 (200)

```json
{
  "ok": true,
  "result": {
    "route": "safety | no_coverage | recommend | ambiguous",
    "reason": "SAFETY_FIRST | PRIMARY_DOMAIN_NOT_COVERED | CARD_SELECTED | TOP_SCORE_TIE",
    "primaryDomain": "...",
    "secondaryDomains": [],
    "safety": { "level": "...", "categories": [] },
    "coverage": { "primaryDomain": "...", "covered": true, "cardIds": [] },
    "eligibleDomains": [],
    "eligibleCardIds": [],
    "rankedCandidates": [],
    "selectedCardId": null,
    "isTie": false
  }
}
```

`result`는 `_shared/recommendation-gate.ts`의 `GateResult`를 그대로 돌려준 것입니다.
새 필드를 만들지 않았습니다.

실패 응답과 오류 코드는 analyze-situation과 동일합니다.

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

## route별 의미

- `safety` — 안전 대응이 먼저인 상황. 이 함수는 신호만 돌려주고 상담 문구·전화번호·기도문·성경본문을 만들지 않습니다.
- `no_coverage` — 지금 카드로 다룰 수 없는 상황. secondaryDomains에 카드가 있어도 우회 추천하지 않으며 `selectedCardId`는 항상 `null`입니다.
- `recommend` — `selectedCardId`에 카드 id(SC-xxx)가 들어갑니다. 성경 원문은 아직 반환하지 않습니다.
- `ambiguous` — 후보 최고점이 정확히 동점. `selectedCardId`는 `null`, `isTie`는 `true`입니다. 임의로 한 장을 고르지 않습니다.

## 파일

- `index.ts` — Deno 진입점. `Deno.env.get("OPENAI_API_KEY")`로 키를 읽고 OpenAI Responses API를 호출한다.
- `handler.ts` — 실제 처리. Deno 전용 코드가 없어서 Node에서도 테스트할 수 있다.
- `handler.test.ts` — 실제 OpenAI 호출 없이 도는 테스트 (`npm test`에 포함).

입력 처리와 Analyzer 호출은 `../_shared/edge-analyzer.ts`,
Gate 판단은 `../_shared/recommendation-gate.ts`를 그대로 씁니다.
analyze-situation과 같은 파일을 쓰기 때문에 두 함수의 규칙이 갈라지지 않습니다.

## 개인정보

- 사용자의 문장을 저장하지 않습니다.
- OpenAI 요청은 `store: false`입니다.
- 로그에는 요청 id, 오류 종류, HTTP 상태만 남깁니다.
- 응답에는 OpenAI 원본과 usage를 포함하지 않습니다.

## 배포 전에 확인할 것

1. Supabase 프로젝트에 `OPENAI_API_KEY` 시크릿이 등록되어 있어야 합니다.
2. 이 함수는 `supabase/functions` 폴더 바깥을 참조하지 않습니다. 공용 규칙은 모두 `../_shared`에서 가져옵니다.
