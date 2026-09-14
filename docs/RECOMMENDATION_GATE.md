# Recommendation Gate

Situation Analysis, Safety, Situation Domain, Scripture Coverage, Scripture Matcher를 하나로 잇는 관문이다.

우선순위:

1. Safety
2. Domain Priority (영역 선택 필요 여부)
3. Primary Domain Coverage
4. Eligible Domain/Card 제한
5. Matcher
6. Tie 처리

핵심 원칙:

- 안전이 일반 말씀 추천보다 우선한다.
- primaryDomain이 uncovered이면 secondaryDomain을 이용해
  억지로 Scripture Card를 추천하지 않는다.
- Matcher는 모든 삶의 상황을 커버하는 장치가 아니다.
- Matcher는 이미 coverage가 확인된 후보들 사이에서
  더 적합한 카드를 비교하는 장치다.
- 높은 Matcher 점수만으로 coverage를 대신 판단하지 않는다.
- 아직 score threshold는 사용하지 않는다.
- 동점이면 임의로 하나를 고르지 않는다.

---

## route

| route | 뜻 | selectedCardId |
| --- | --- | --- |
| `safety` | 안전 대응이 먼저인 상황 | 없음 |
| `domain_choice` | 중심 영역을 하나로 정할 근거가 없음 (영역 선택 필요) | 없음 |
| `no_coverage` | 지금 카드로 다룰 수 없는 상황 | 없음 |
| `recommend` | 후보 중 한 장이 정해짐 | 있음 |
| `ambiguous` | 중심 영역은 정해졌고, 그 영역 카드끼리 최고점이 동점 | 없음 |

`domain_choice`와 `ambiguous`는 다르다.
`domain_choice`는 영역 자체가 정해지지 않은 것이고, `ambiguous`는 영역은 정해졌지만 카드가 한 장으로 좁혀지지 않은 것이다.

## 처리 순서

safety → domain_choice → no_coverage → recommend / ambiguous

### STEP 1 · Safety

`safety.level !== 'normal'`이면 다른 판단보다 먼저 `route = "safety"`를 돌려준다.
`domainPriority`가 `needs_choice`여도 safety가 먼저다.

Matcher를 계산할 수는 있어도 그 결과를 일반 말씀 추천으로 쓰지 않는다.
safety의 level과 category는 결과에 그대로 보존한다.

### STEP 1-1 · Domain Priority

`domainPriority === 'needs_choice'`이면 `route = "domain_choice"`, `reason = DOMAIN_PRIORITY_UNRESOLVED`.

- `primaryDomain = null`, `domainChoiceCandidates`는 Analyzer 값 그대로 보존
- `secondaryDomains`, `eligibleDomains`, `eligibleCardIds`, `rankedCandidates`는 모두 `[]`
- `selectedCardId = null`, `isTie = false`
- `coverage = null` (영역이 정해지지 않아 계산하지 않았다는 뜻. uncovered라는 뜻이 아니다)
- 문장 순서로 첫 후보를 primary처럼 쓰지 않는다. top-level 카드 필드는 모두 비어 있다.
- 대신 두 후보 각각에 대해 `domainChoiceOptions`를 미리 계산한다 (아래 "영역 선택 option").
- `no_coverage`로 표현하지 않으며, coverage gap으로 기록하지 않는다 (gap 기록은 top-level `no_coverage`만).

#### 영역 선택 option (Domain Choice Server Resolution v1, 2026-09-14)

```ts
type DomainChoiceResolution = 'recommend' | 'ambiguous' | 'no_coverage';
type DomainChoiceOption = {
  domain: SituationDomain;
  resolution: DomainChoiceResolution;
  selectedCardId: string | null; // recommend일 때만 카드 번호
};
```

- 계산 방법: 후보마다 `_shared/domain-choice-resolution.ts`의 `resolveAnalysisForChosenDomain`으로
  "그 후보를 primary, 나머지 후보를 secondary"로 둔 resolved 분석을 만들고, 기존 Primary-First 규칙(STEP 2~5)을 그대로 돌린다.
- 정확히 두 개. 순서는 `domainChoiceCandidates` 순서 그대로지만 우선순위를 뜻하지 않는다. 후보 순서를 뒤집어도 영역별 결과는 같다.
- 각 option은 자기 영역 카드만 후보로 쓴다. 다른 후보 영역의 카드는 들어가지 않는다.
- 태그·점수 상세·분석 결과 전체는 option에 넣지 않는다.
- 이미 받은 분석 결과만으로 계산하는 순수 계산이다. OpenAI를 다시 부르지 않는다.
  그래서 앱이 영역을 고를 때 추가 분석 호출과 새 quota 소비 없이 이 결과를 쓸 수 있다.
- 내부의 resolved 계산 함수는 `runRecommendationGate`를 다시 부르지 않는다 (재귀 없음).
- safety·recommend·ambiguous·no_coverage route에서 `domainChoiceOptions`는 항상 `[]`이다.

`resolved`인데 `primaryDomain`이 null이면 검증을 거치지 않은 입력이므로 Gate가 예외를 던진다.

### STEP 2 · Primary Domain Coverage

safety가 normal이면 `primaryDomain`의 coverage를 확인한다.
covered가 false면 `route = "no_coverage"`.

secondaryDomains 중에 covered domain이 있어도 진행하지 않는다.

예:

```
primaryDomain: financial_hardship
secondaryDomains: fear_uncertainty
→ SC-001을 추천하면 안 된다
→ route = no_coverage
```

### STEP 3 · Candidate Domain (Primary-First)

covered이면 후보 domain을 만든다.

- 후보 domain은 정확히 `[primaryDomain]`이다.
- 후보 Scripture Card는 `primaryDomain`을 가진 카드만 허용한다.

`secondaryDomains`는 결과와 분석 데이터에 그대로 보존하지만,
그 영역에 속한다는 이유만으로 해당 영역의 카드를 후보에 추가하지 않는다.
보조 영역의 카드가 태그 점수로 중심 영역의 말씀을 밀어내지 않게 하기 위해서다.

예:

```
primaryDomain: grief_loss
secondaryDomains: loneliness_isolation
→ 후보: SC-009 (grief_loss 카드)
→ SC-011·SC-018·SC-019 (loneliness_isolation 카드)는 태그가 강하게 맞아도 후보가 아니다
```

`secondaryDomains`를 태그로 바꾸거나, domain bonus·가중치·threshold를 새로 만들지 않는다.

> 변경 이력 (2026-09-14): 이전에는 covered인 secondaryDomains의 카드도 후보에 넣었다.
> 복합 사연에서 보조 영역 카드가 중심 영역 카드를 밀어낼 수 있어 primaryDomain 카드만 후보로 좁혔다.

### STEP 4 · Matcher

기존 `src/lib/scripture-matcher.ts`의 배점과 계산 방식은 바꾸지 않는다.
Matcher에는 Situation Analysis 전체를 그대로 넘기고, Gate는 그 결과에서 후보 카드만 걸러 점수순으로 쓴다.
복합 사연에서 분석기가 붙인 태그는 같은 primaryDomain 카드들 사이의 순위를 정하는 데 쓰인다.

### STEP 5 · 결과

- 후보 최고점이 한 장이면 `route = "recommend"`, `selectedCardId` 지정, `reason = CARD_SELECTED`
- 후보 최고점이 정확히 동점이면 `route = "ambiguous"`, `selectedCardId = null`, `isTie = true`, `reason = TOP_SCORE_TIE`

점수가 낮다는 이유만으로 `no_coverage` 처리하지 않는다. threshold는 아직 없다.

## 결과 구조

```ts
{
  route, reason,
  domainPriority,                 // 'resolved' | 'needs_choice'
  primaryDomain,                  // domain_choice·(needs_choice인 safety)에서는 null
  domainChoiceCandidates,         // domain_choice에서만 2개, 나머지 route는 []
  domainChoiceOptions,            // domain_choice에서만 후보 순서대로 2개, 나머지 route는 []
  secondaryDomains,
  safety, coverage,               // coverage: 영역 미정이면 null
  eligibleDomains, eligibleCardIds,
  rankedCandidates,
  selectedCardId, isTie
}
```

`reason`은 내부 개발 확인용 코드다.
`SAFETY_FIRST` / `DOMAIN_PRIORITY_UNRESOLVED` / `PRIMARY_DOMAIN_NOT_COVERED` / `CARD_SELECTED` / `TOP_SCORE_TIE`

사용자에게 보여줄 자연어 문장은 아직 만들지 않았다.

## 구현 메모 (2026-08-27 기준)

### 지금 구현된 것

- `src/lib/recommendation-gate.ts`: 위 5단계와 동점 처리용 순수 함수 `selectFromRanked`
- `src/lib/recommendation-gate.test.ts`: TEST 1~10과 동점 테스트

### 아직 구현하지 않은 것

- 실제 OpenAI가 resolved/needs_choice를 정확히 나누는지 검증 (지금은 계약형 mock만 확인)
- 세 개 이상의 독립 영역: V1은 후보를 두 개만 담는다 (Analyzer의 임의 선택 위험)
- score threshold와 low confidence 처리
- `safety` route에서 사용자에게 보여줄 안전 안내
- `no_coverage` / `ambiguous`일 때 사용자에게 보여줄 화면
- fallback card
- 앱 화면 연결 (두 번째 화면은 여전히 SC-001로 고정되어 있다)

## 기도 도움 서버의 선택 영역 재검증 (2026-09-14)

`generate-prayer-guidance` 요청은 `{ situation, cardId, selectedDomain }` 세 값이 모두 필수다.
`selectedDomain`은 한글 문구가 아니라 내부 표준 domain 값이다.

서버 순서:

1. 요청 형식 검사 (`selectedDomain`이 표준 영역이고 `other_uncovered`가 아닌지 포함) — 실패하면 사용량 확인·분석 전에 거절
2. 카드 존재 확인
3. 기존 방식으로 상황 재분석 (분석 1회)
4. safety가 normal이 아니면 즉시 거절 — 선택 영역을 보기 전이다
5. `resolveAnalysisForChosenDomain(재분석 결과, selectedDomain)`
   - needs_choice: 두 후보 중 하나일 때만
   - resolved: primary 또는 secondary로 실제 탐지됐을 때만
   - 분석 어디에도 없으면 거절. 요청 값을 분석 결과에 강제로 넣지 않는다
6. 변환된 분석으로 Primary-First Gate. `recommend`가 아니면(동점·coverage 없음) 거절
7. 카드가 그 Gate의 `eligibleCardIds`에 있는지 확인. 선택 영역 카드가 아니면 거절
8. 그 뒤에만 기도 도움 생성 (1회, 재시도 없음)

밖으로 나가는 실패는 언제나 `PRAYER_GUIDANCE_UNAVAILABLE` 하나다.
서버 로그에는 고정된 내부 코드(`prayer_guidance_safety_first`, `prayer_guidance_domain_not_detected` 등)만 남기고
사용자 문장·선택 영역·카드 번호는 남기지 않는다. `selectedDomain`은 저장하지 않는다.

### 앱(client)의 domain_choice 처리 (2026-09-14 구현, 2026-09-15 뒤로가기 수정)

서버 계약과 별개로 미뤄져 있던 앱 쪽 연결이 이제 구현되어 있다.

- `src/lib/request-recommendation.ts`: `GATE_ROUTES`에 `domain_choice`가 있고, `domainChoiceCandidates`/
  `domainChoiceOptions`를 검증한 뒤 `{ status: 'domain_choice', options }`로 돌려준다.
  일반 `recommend`도 `primaryDomain`을 함께 검증해 `cardId`와 `selectedDomain`을 함께 돌려준다.
- `src/lib/request-prayer-guidance.ts`: 요청 본문이 정확히 `{ situation, cardId, selectedDomain }`이고,
  선택 영역이 표준값이 아니거나 없으면 서버를 부르지 않는다.
- `src/state/situation.tsx`: `selectedDomain`, `domainChoiceOptions`를 들고 있다. 카드·영역·선택지를
  다루는 함수는 넷이고, 서로 다른 계약을 갖는다.
  - `setRecommendation({ cardId, selectedDomain })`: 첫 화면의 일반 `recommend` 결과를 저장한다.
    카드·영역을 채우고, 남아 있던 `domainChoiceOptions`는 비운다.
  - `setDomainChoiceOptions(options)`: 첫 화면의 `domain_choice` 결과(두 후보의 option)를 저장한다.
    아직 카드·영역이 정해지지 않았으므로 그 둘은 비운다.
  - `applyDomainChoiceOption(option)`: 영역 선택 화면에서 후보 하나를 고른 결과를 반영한다.
    `recommend` option이면 카드·영역을 채우고, `ambiguous`/`no_coverage` option이면 카드·영역만
    비운다. **`domainChoiceOptions`는 건드리지 않는다** — `setRecommendation`과 다른 점이다.
    뒤로가기로 선택 화면에 돌아왔을 때 같은 두 후보에서 다시 고를 수 있어야 하기 때문이다.
  - `clearRecommendation()`: 카드·영역·`domainChoiceOptions`를 전부 비운다. 새 추천을 시작하기 전과
    기도를 마치고 처음으로 돌아갈 때 쓴다.
  - `clearAfterDataDeletion()`: 위 셋(상황 포함)을 모두 비운다.

  정리하면 `domainChoiceOptions`(선택지)가 유지되는 범위는 **영역 선택 화면에 머무는 동안뿐**이다.
  그 흐름을 벗어나는 순간 — 새 추천을 시작하거나, 기도를 마치고 처음으로 돌아가거나, 내 정보를
  삭제하면 — 예외 없이 비워진다.
- `src/app/domain-choice.tsx`: 영역 선택 화면. 이미 받아 둔 `domainChoiceOptions`만 보여주고 고르게 하며,
  고를 때 네트워크 호출이 없다.
  - 고를 때 `router.replace`가 아니라 `router.push`를 쓴다. `recommend`는 `/scripture`로,
    `ambiguous`는 `/ambiguous`로, `no_coverage`는 `/no-coverage`로 이동하되, 이 선택 화면은
    스택에 그대로 남는다. 그래서 그 화면들에서 뒤로 가면 같은 영역 선택 화면으로 돌아오고,
    (`applyDomainChoiceOption`이 `domainChoiceOptions`를 비우지 않으므로) 같은 두 후보 중
    처음과 다른 쪽을 다시 고를 수 있다.
  - 연속 탭 가드는 `useFocusEffect` 기준 포커스 단위다. 이 화면이 다시 포커스될 때(뒤로 돌아올 때)
    가드가 풀린다. 포커스되지 않은 동안(다른 화면이 앞에 있는 동안) 내 정보 삭제 등으로
    `domainChoiceOptions`가 비워져도 지금 앞에 있는 화면을 갑자기 바꾸지 않고, 이 화면이 다시
    포커스됐을 때만 옵션이 없다는 것을 보고 홈(`/`)으로 보낸다. 옵션 없이 직접 들어온 경우도 같다.
- `src/app/index.tsx`, `src/app/prayer.tsx`: 위 함수들과 화면을 실제로 연결했다. 첫 화면에서
  `/scripture`·`/domain-choice` 어느 쪽으로 가든 모두 `router.push`다.
- 사용자용 영역 이름은 `src/data/domain-labels.ts`에 있다. 내부 영문 domain 코드는 화면에 쓰지 않는다.
