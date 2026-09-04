# Recommendation Gate

Situation Analysis, Safety, Situation Domain, Scripture Coverage, Scripture Matcher를 하나로 잇는 관문이다.

우선순위:

1. Safety
2. Primary Domain Coverage
3. Eligible Domain/Card 제한
4. Matcher
5. Tie 처리

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
| `no_coverage` | 지금 카드로 다룰 수 없는 상황 | 없음 |
| `recommend` | 후보 중 한 장이 정해짐 | 있음 |
| `ambiguous` | 후보 최고점이 동점 | 없음 |

## 처리 순서

### STEP 1 · Safety

`safety.level !== 'normal'`이면 다른 판단보다 먼저 `route = "safety"`를 돌려준다.

Matcher를 계산할 수는 있어도 그 결과를 일반 말씀 추천으로 쓰지 않는다.
safety의 level과 category는 결과에 그대로 보존한다.

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

### STEP 3 · Candidate Domain

covered이면 후보 domain을 만든다.

- primaryDomain (반드시 포함)
- secondaryDomains 중 covered인 domain

후보 Scripture Card는 위 domain 중 하나 이상을 가진 카드만 허용한다.
다른 domain의 카드는 Matcher 점수가 높아도 최종 후보가 될 수 없다.

### STEP 4 · Matcher

기존 `src/lib/scripture-matcher.ts`의 배점과 계산 방식은 바꾸지 않는다.
Gate는 Matcher 결과에서 후보 카드만 걸러 점수순으로 쓴다.

### STEP 5 · 결과

- 후보 최고점이 한 장이면 `route = "recommend"`, `selectedCardId` 지정, `reason = CARD_SELECTED`
- 후보 최고점이 정확히 동점이면 `route = "ambiguous"`, `selectedCardId = null`, `isTie = true`, `reason = TOP_SCORE_TIE`

점수가 낮다는 이유만으로 `no_coverage` 처리하지 않는다. threshold는 아직 없다.

## 결과 구조

```ts
{
  route, reason,
  primaryDomain, secondaryDomains,
  safety, coverage,
  eligibleDomains, eligibleCardIds,
  rankedCandidates,
  selectedCardId, isTie
}
```

`reason`은 내부 개발 확인용 코드다.
`SAFETY_FIRST` / `PRIMARY_DOMAIN_NOT_COVERED` / `CARD_SELECTED` / `TOP_SCORE_TIE`

사용자에게 보여줄 자연어 문장은 아직 만들지 않았다.

## 구현 메모 (2026-08-27 기준)

### 지금 구현된 것

- `src/lib/recommendation-gate.ts`: 위 5단계와 동점 처리용 순수 함수 `selectFromRanked`
- `src/lib/recommendation-gate.test.ts`: TEST 1~10과 동점 테스트

### 아직 구현하지 않은 것

- score threshold와 low confidence 처리
- `safety` route에서 사용자에게 보여줄 안전 안내
- `no_coverage` / `ambiguous`일 때 사용자에게 보여줄 화면
- fallback card
- 앱 화면 연결 (두 번째 화면은 여전히 SC-001로 고정되어 있다)
