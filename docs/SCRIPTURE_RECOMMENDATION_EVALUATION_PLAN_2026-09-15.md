# Scripture Card 51장 자연어 추천 평가 계획 (2026-09-15)

이 문서는 Scripture Card 51장(Scripture Card Expansion v2, `docs/SCRIPTURE_CARD_EXPANSION_2026-09-15.md`)이
실제 자연어 입력에서도 제대로 추천되는지 평가하기 위해 준비한 자료와 절차를 적는다. 이 작업 자체는
평가 자료와 로컬 평가 도구만 준비했고, 실제 OpenAI 호출은 하지 않았다.

## 1. 51장은 "평가를 시작할 수 있는 카드 기준선"이다

51장은 완성된 최종 카드 수가 아니라, 지금부터 자연어 평가를 시작할 수 있는 출발점이다.
`scripts/scripture-recommendation-evaluation-cases.ts`의 `preferredCardId`/`acceptableCardIds`는
사람이 각 문장과 카드의 situationTags를 직접 대조해서 세운 **평가 가설**이지, 코드가 의미상
겹침을 자동으로 "검증"한 결과가 아니다. `src/lib/scripture-recommendation-evaluation-cases.test.ts`가
실제로 확인하는 것은 원본 위치(문장·domain·rank·cluster가 EXPANSION_SCENARIOS와 일치)·개수
(51장이 각각 정확히 3번, 총 153개)·카드 영역 소속·문장과 ID 중복 없음·안전 경계 사례(`SAFETY_BOUNDARY_SCENARIOS`)
와의 교집합이 0건이라는 **데이터 정합성**뿐이다. 이 정적 검증을 통과했다고 자연어 추천이 실제로
잘 된다는 뜻은 아니다 — 그것은 아래 §4의 실제 호출로만 확인한다.

## 2. 태그 분리 테스트는 자연어 Analyzer 정확도를 증명하지 않는다

`scripture-expansion-simulation.test.ts`의 situationTags 분리 무결성 테스트와, 이번에 추가한
`scripture-recommendation-evaluation-cases.test.ts`는 둘 다 **정적 데이터** 테스트다.

- 확인하는 것: 카드에 저장된 태그를 그대로 Gate에 되먹였을 때 같은 영역의 다른 카드와
  분리되어 단독 1위가 되는가. 51개 카드가 평가 코퍼스에 고르게 3번씩 등장하는가.
- 확인하지 않는 것: 실제 사용자가 쓴 자연어 문장에서 Situation Analyzer(OpenAI)가 그 태그를
  정확히 뽑아내는가. 이것은 OpenAI를 실제로 불러야만 알 수 있고, `npm run test:logic`이나
  `npm test`로는 절대 증명되지 않는다.

이 구분을 분명히 하는 이유는, 태그 테스트가 전부 통과한 것을 "51장이 실제 대화에서도 잘 작동한다"는
증거로 착각하지 않기 위해서다.

## 3. 평가 자료

- `scripts/situation-scenario-corpus.ts`의 `EXPANSION_SCENARIOS`(17개 영역 × 20문장 = 340문장,
  기존 자료, 이번에 수정하지 않음)에서만 문장을 가져왔다.
- `scripts/scripture-recommendation-evaluation-cases.ts` — 새로 만든 153개 평가 코퍼스.
  51개 카드가 각각 정확히 3번씩 `preferredCardId`로 등장한다. 문장을 새로 짓지 않았고,
  `SAFETY_BOUNDARY_SCENARIOS`(안전 경계로 확정된 문장)와는 domain·rank·text 세 값을 모두
  대조해 교집합이 0건임을 정적 테스트로 직접 확인한다(도메인이 EXPANSION_SCENARIOS에 속한다는
  것만으로는 안전 경계 제외를 증명하지 않는다 — 안전 경계 문장도 같은 도메인에 속하기 때문이다).
  각 사례는 원본 코퍼스의 domain·rank·cluster를 그대로 달고 있어 `EXPANSION_SCENARIOS`와
  항상 대조할 수 있다.
- `preferredCardId`(1위로 기대하는 카드)와 `acceptableCardIds`(1~2장, preferred 포함 — top1이
  이 중 하나면 합리적이라고 인정)를 구분했다. "신규 카드는 예전 일반 카드를 자동으로 acceptable에
  넣는다"거나 "카드가 3장씩 함께 생긴 영역은 대안을 넣지 않는다" 같은 일괄 규칙 없이, 같은
  영역 카드 3장의 situationTags와 문장 내용을 매 사례마다 직접 대조해서 정했다. acceptable은
  둘 다 실제로 목회적으로 자연스러운 경우에만 넣었고, 그 이유는 각 사례의 `rationale`과 파일
  상단 주석에 적었다 — 같은 영역 카드 3장을 전부 허용해 평가를 약화하지 않았다.

## 4. 실행 순서 — smoke → new-cards → full

실제 OpenAI 호출은 한 번에 153건을 다 부르지 않고, 아래 순서로 단계별로 확인한다.

1. **smoke** (`--mode=smoke`, 17건) — 17개 영역에서 대표 카드 한 장씩만 부른다. 구조 검증·안전
   오탐·domain 일치 같은 기본 배선이 살아있는지 가장 적은 호출로 먼저 확인한다.
2. **new-cards** (`--mode=new-cards`, 20건) — 이번에 새로 추가된 SC-032~SC-051이 각각 최소
   한 번은 실제로 1위로 뽑히는지 확인한다.
3. **full** (`--mode=full`, 153건) — 앞의 두 단계에서 큰 문제가 없을 때만 전체를 돌린다.

각 단계는 `node scripts/test-openai-recommendation-e2e.ts --mode=<smoke|new-cards|full>`로 실행한다.
`--dry-run`을 더하면 OpenAI를 부르지 않고 그 모드가 실제로 어떤 사례를 고르는지만 먼저 눈으로
확인할 수 있다. 모드를 지정하지 않고 실행하면 사용법만 출력하고 아무것도 호출하지 않는다.

## 5. 실제 호출은 별도 승인 뒤에만 실행한다

이 작업(평가 자료·도구 준비)은 OpenAI를 한 번도 호출하지 않았다. `--mode=smoke` 등 실제 호출이
일어나는 실행은 이 문서가 아니라 별도로 실행 승인을 받은 뒤에만 한다. `OPENAI_API_KEY`가 없으면
`scripts/analyzer-prompt.ts`의 `createClient()`가 즉시 안내만 하고 종료하므로, 승인 없이 키를
넣지 않는 한 실제로 호출될 수 없다.

## 6. 호출 횟수와 토큰은 보고하되 금액은 문서에 고정하지 않는다

각 단계 실행 결과는 다음을 각각 나눠 보고한다(`scripts/test-openai-recommendation-e2e.ts`의
출력 형식).

1. 응답 구조 검증 성공률
2. 안전 오탐 수 (안전 경계 문장이 아닌데 `route: 'safety'`로 온 경우)
3. primary domain 일치율
4. preferred 카드 1위 일치율
5. acceptable 카드 일치율
6. 예상하지 않은 `domain_choice`·`ambiguous`·`no_coverage` 수
7. 입력·출력·전체 토큰 사용량(input / output / total)

실제 보고 항목은 위 7개다(토큰 사용량의 input/output/total은 7번 항목 하나의 하위 수치이지
별개 항목이 아니다). 실행 결과는 총계만 보여주지 않고, 구조 검증 실패·안전 오탐·primary
domain 불일치·preferred 불일치·acceptable 불일치·예상 밖 route(domain_choice/ambiguous/no_coverage
각각)별로 실패한 평가 ID를 나눠 출력한다.

토큰 사용량은 실행 시점의 실제 응답 기준으로 그때그때 보고한다. OpenAI 요금은 모델·시점에 따라
바뀌므로, 이 문서에는 "몇 건 호출 시 예상 비용이 얼마"처럼 변동 가능한 금액을 고정해서 적지 않는다.
비용을 가늠해야 하면 실행 시점의 실제 토큰 사용량과 그 시점의 공개 요금표를 따로 대조한다.

API Key, 사용자 문장, 모델 원본 응답은 파일에 자동 저장하지 않는다 — 모든 출력은 콘솔(stdout)뿐이고,
결과를 남기고 싶으면 실행하는 사람이 직접 `tee`를 붙인다.

## 7. 지인 베타 전 통과 기준은 지금 정하지 않는다

"지인 베타를 시작하기 전에 몇 퍼센트 이상 일치해야 한다" 같은 구체적 통과 기준은 이 문서에서
미리 정하지 않는다. §4의 smoke → new-cards → full을 실제로 실행해 §6의 7개 항목을 본 뒤에,
그 결과를 보고 기준을 정한다. 지금 이 시점에는 실제 호출 결과가 전혀 없으므로, 근거 없는 숫자를
목표치로 못박지 않는다.
