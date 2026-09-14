/**
 * Recommendation Gate V1 테스트
 *
 * 실행: npm test
 *
 * 실제 OpenAI를 부르지 않는다. mock Situation Analysis만 사용한다.
 *
 * 후보 규칙(Primary-First):
 *   후보 영역은 정확히 [primaryDomain]이고, 후보 카드는 primaryDomain을 가진 카드뿐이다.
 *   secondaryDomains는 결과에 보존되지만, 그 영역의 카드를 후보에 넣지 않는다.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { COMPOUND_SCENARIOS, DOMAIN_CHOICE_SCENARIOS } from '../../scripts/situation-scenario-corpus.ts';
import { SCRIPTURE_CARDS } from '../data/scripture-cards.ts';
import type { SituationDomain } from '../data/situation-domains.ts';
import { runRecommendationGate, selectFromRanked } from './recommendation-gate.ts';
import type { CardScore } from './scripture-matcher.ts';
import { validateSituationAnalysis, type SituationAnalysis } from './situation-analysis.ts';

type AnalysisOverrides = Partial<SituationAnalysis>;

const analysisOf = (overrides: AnalysisOverrides): SituationAnalysis => ({
  domainPriority: 'resolved',
  primaryDomain: 'fear_uncertainty',
  domainChoiceCandidates: [],
  secondaryDomains: [],
  situationTags: [],
  emotionTags: [],
  spiritualQuestionTags: [],
  prayerModes: [],
  pastoralFunctions: [],
  safety: { level: 'normal', categories: [] },
  confidence: 0.8,
  ...overrides,
});

const fakeScore = (cardId: string, totalScore: number): CardScore => ({
  cardId,
  totalScore,
  situationScore: 0,
  emotionScore: 0,
  spiritualQuestionScore: 0,
  prayerModeScore: 0,
  pastoralFunctionScore: totalScore,
  matchedTags: {
    situation: [],
    emotion: [],
    spiritualQuestion: [],
    prayerMode: [],
    pastoralFunction: [],
  },
});

const cardsWithDomain = (domain: SituationDomain) =>
  SCRIPTURE_CARDS.filter((card) => card.domains.includes(domain)).map((card) => card.id);

/** primaryDomain을 갖지 않고 secondaryDomains 중 하나만 가진 카드. 후보에 들어오면 안 된다. */
const secondaryOnlyCardIds = (primary: SituationDomain, secondaries: readonly SituationDomain[]) =>
  SCRIPTURE_CARDS.filter(
    (card) => !card.domains.includes(primary) && card.domains.some((domain) => secondaries.includes(domain)),
  ).map((card) => card.id);

/** 추천 경로 결과가 Primary-First 계약을 지키는지 한 번에 확인한다. */
function assertPrimaryOnly(
  result: ReturnType<typeof runRecommendationGate>,
  primary: SituationDomain,
  secondaries: readonly SituationDomain[],
) {
  assert.deepEqual(result.eligibleDomains, [primary]);
  assert.deepEqual([...result.eligibleCardIds].sort(), cardsWithDomain(primary).sort());
  assert.deepEqual(result.secondaryDomains, [...secondaries], 'secondaryDomains는 결과에 그대로 보존된다.');

  const primarySet = new Set(cardsWithDomain(primary));
  for (const id of result.eligibleCardIds) assert.ok(primarySet.has(id), `후보에 primary 밖 카드: ${id}`);
  for (const score of result.rankedCandidates) assert.ok(primarySet.has(score.cardId), `순위에 primary 밖 카드: ${score.cardId}`);

  for (const id of secondaryOnlyCardIds(primary, secondaries)) {
    assert.equal(result.eligibleCardIds.includes(id), false, `secondary 전용 카드가 후보에 들어왔습니다: ${id}`);
    assert.equal(
      result.rankedCandidates.some((score) => score.cardId === id),
      false,
      `secondary 전용 카드가 순위에 들어왔습니다: ${id}`,
    );
  }
}

describe('Recommendation Gate · 추천 가능한 상황', () => {
  it('TEST 1 · 두려움/검사 결과 대기 → recommend / SC-001', () => {
    const analysis = analysisOf({
      primaryDomain: 'fear_uncertainty',
      situationTags: ['두려운 일을 앞둠', '불확실한 결과'],
      emotionTags: ['두려움'],
      spiritualQuestionTags: ['신뢰'],
      prayerModes: ['간구'],
      pastoralFunctions: ['위로'],
    });
    assert.equal(validateSituationAnalysis(analysis).valid, true);

    const result = runRecommendationGate(analysis);
    assert.equal(result.route, 'recommend');
    assert.equal(result.selectedCardId, 'SC-001');
    assert.equal(result.reason, 'CARD_SELECTED');
    assert.equal(result.isTie, false);
    assert.deepEqual(result.eligibleCardIds.sort(), ['SC-001']);
  });

  it('TEST 2 · 감사 → recommend / SC-004', () => {
    const analysis = analysisOf({
      primaryDomain: 'gratitude_joy',
      situationTags: ['좋은 일이 생김'],
      emotionTags: ['기쁨', '감사'],
      spiritualQuestionTags: ['감사'],
      prayerModes: ['감사'],
      pastoralFunctions: ['감사'],
    });
    const result = runRecommendationGate(analysis);
    assert.equal(result.route, 'recommend');
    assert.equal(result.selectedCardId, 'SC-004');
    assert.deepEqual(result.eligibleCardIds.sort(), ['SC-004']);
  });

  it('TEST 3 · 사별 → recommend / SC-009', () => {
    const analysis = analysisOf({
      primaryDomain: 'grief_loss',
      situationTags: ['사별', '상실'],
      emotionTags: ['슬픔', '그리움'],
      spiritualQuestionTags: ['슬픔'],
      prayerModes: ['탄식'],
      pastoralFunctions: ['위로', '애도'],
    });
    const result = runRecommendationGate(analysis);
    assert.equal(result.route, 'recommend');
    assert.equal(result.selectedCardId, 'SC-009');
    assert.deepEqual(result.eligibleCardIds.sort(), ['SC-009']);
  });
});

describe('Recommendation Gate · 확장 카드 영역', () => {
  it('TEST 4 · 경제적 어려움 + 불안 → recommend / SC-015 (fear_uncertainty 카드 SC-001은 후보 아님)', () => {
    const analysis = analysisOf({
      primaryDomain: 'financial_hardship',
      secondaryDomains: ['fear_uncertainty'],
      situationTags: ['경제적 어려움', '생활비 부족'],
      emotionTags: ['불안', '걱정'],
      spiritualQuestionTags: ['신뢰'],
      prayerModes: ['간구'],
      pastoralFunctions: ['위로'],
    });
    const result = runRecommendationGate(analysis);
    assert.equal(result.route, 'recommend');
    assert.equal(result.selectedCardId, 'SC-015');
    assert.deepEqual(result.eligibleCardIds.sort(), ['SC-015', 'SC-026', 'SC-027']);
    assert.equal(result.eligibleCardIds.includes('SC-001'), false);
    assertPrimaryOnly(result, 'financial_hardship', ['fear_uncertainty']);
  });

  it('TEST 5 · 부모-자녀 갈등 + 지혜 → recommend / SC-012 (wisdom_discernment 카드 SC-010은 후보 아님)', () => {
    const analysis = analysisOf({
      primaryDomain: 'family_parenting_conflict',
      secondaryDomains: ['wisdom_discernment'],
      situationTags: ['자녀와 갈등', '아이와 대화가 어려움'],
      emotionTags: ['막막함'],
      spiritualQuestionTags: ['관계 회복'],
      prayerModes: ['간구'],
      pastoralFunctions: ['관계 회복'],
    });
    const result = runRecommendationGate(analysis);
    assert.equal(result.route, 'recommend');
    assert.equal(result.selectedCardId, 'SC-012');
    assert.deepEqual(result.eligibleCardIds.sort(), ['SC-012', 'SC-020', 'SC-021']);
    assert.equal(result.eligibleCardIds.includes('SC-010'), false);
    assertPrimaryOnly(result, 'family_parenting_conflict', ['wisdom_discernment']);
  });

  it('TEST 6 · 대인 갈등과 용서 → recommend / SC-017 (repentance_guilt 카드 SC-006은 후보 아님)', () => {
    const analysis = analysisOf({
      primaryDomain: 'relationship_conflict_forgiveness',
      secondaryDomains: ['repentance_guilt'],
      situationTags: ['관계 갈등', '용서하고 싶음'],
      spiritualQuestionTags: ['용서', '관계 회복'],
      prayerModes: ['결단'],
      pastoralFunctions: ['관계 회복'],
    });
    const result = runRecommendationGate(analysis);
    assert.equal(result.route, 'recommend');
    assert.equal(result.selectedCardId, 'SC-017');
    assert.deepEqual(result.eligibleCardIds.sort(), ['SC-017', 'SC-030', 'SC-031']);
    assert.equal(result.eligibleCardIds.includes('SC-006'), false);
    assertPrimaryOnly(result, 'relationship_conflict_forgiveness', ['repentance_guilt']);
  });

  it('대표 카드가 없는 fallback은 secondary가 있어도 추천하지 않는다', () => {
    for (const primaryDomain of ['other_uncovered'] as SituationDomain[]) {
      const result = runRecommendationGate(
        analysisOf({ primaryDomain, secondaryDomains: ['fear_uncertainty', 'grief_loss'] }),
      );
      assert.equal(result.route, 'no_coverage', `${primaryDomain}에서 추천이 나왔습니다.`);
      assert.equal(result.reason, 'PRIMARY_DOMAIN_NOT_COVERED');
      assert.deepEqual(result.eligibleDomains, []);
      assert.deepEqual(result.eligibleCardIds, []);
      assert.deepEqual(result.rankedCandidates, []);
      assert.equal(result.selectedCardId, null);
    }
  });
});

describe('Recommendation Gate · 안전 우선', () => {
  it('TEST 7 · 자살 사고(caution) → safety', () => {
    const analysis = analysisOf({
      primaryDomain: 'waiting_unanswered_prayer',
      emotionTags: ['낙심'],
      safety: { level: 'caution', categories: ['suicide'] },
    });
    const result = runRecommendationGate(analysis);
    assert.equal(result.route, 'safety');
    assert.equal(result.reason, 'SAFETY_FIRST');
    assert.equal(result.selectedCardId, null);
    assert.deepEqual(result.rankedCandidates, []);
    // safety 정보는 결과에 그대로 남는다.
    assert.equal(result.safety.level, 'caution');
    assert.deepEqual(result.safety.categories, ['suicide']);
  });

  it('TEST 8 · 현재 폭행 피해(urgent) → safety', () => {
    const analysis = analysisOf({
      primaryDomain: 'injustice_mistreatment',
      situationTags: ['괴롭힘', '부당대우'],
      emotionTags: ['두려움'],
      safety: { level: 'urgent', categories: ['abuse', 'immediate_danger'] },
    });
    const result = runRecommendationGate(analysis);
    assert.equal(result.route, 'safety');
    assert.equal(result.selectedCardId, null);
    assert.deepEqual(result.eligibleCardIds, []);
  });

  it('safety가 normal이 아니면 covered domain이어도 항상 safety route', () => {
    for (const level of ['caution', 'urgent'] as const) {
      const result = runRecommendationGate(
        analysisOf({
          primaryDomain: 'grief_loss',
          situationTags: ['사별'],
          safety: { level, categories: ['abuse'] },
        }),
      );
      assert.equal(result.route, 'safety');
    }
  });

  it('복합 사연이어도 safety가 먼저이고 secondary 카드로 우회 추천하지 않는다', () => {
    const result = runRecommendationGate(
      analysisOf({
        primaryDomain: 'relationship_conflict_forgiveness',
        secondaryDomains: ['family_parenting_conflict', 'loneliness_isolation'],
        situationTags: ['관계 갈등'],
        safety: { level: 'caution', categories: ['abuse'] },
      }),
    );
    assert.equal(result.route, 'safety');
    assert.equal(result.reason, 'SAFETY_FIRST');
    assert.deepEqual(result.eligibleCardIds, []);
    assert.deepEqual(result.rankedCandidates, []);
    assert.deepEqual(result.secondaryDomains, ['family_parenting_conflict', 'loneliness_isolation']);
  });
});

describe('Recommendation Gate · 복합 사연은 primary 카드만 후보', () => {
  it('TEST 9 · gratitude_joy + fear_uncertainty → 후보는 SC-004 한 장 (SC-001은 후보 아님)', () => {
    const analysis = analysisOf({
      primaryDomain: 'gratitude_joy',
      secondaryDomains: ['fear_uncertainty'],
      situationTags: ['좋은 일이 생김', '두려운 일을 앞둠'],
      emotionTags: ['기쁨', '감사', '두려움'],
      spiritualQuestionTags: ['감사', '신뢰'],
      prayerModes: ['감사', '간구'],
      pastoralFunctions: ['감사', '위로'],
    });
    const result = runRecommendationGate(analysis);

    assert.deepEqual(result.eligibleDomains, ['gratitude_joy']);
    assert.deepEqual(result.eligibleCardIds, ['SC-004']);
    assert.equal(result.eligibleCardIds.includes('SC-001'), false);
    assert.equal(result.rankedCandidates.length, 1);
    assert.equal(result.route, 'recommend');
    assert.equal(result.selectedCardId, 'SC-004');
    assertPrimaryOnly(result, 'gratitude_joy', ['fear_uncertainty']);
  });

  it('TEST 10 · decision_guidance + wisdom_discernment → 후보는 SC-002 한 장 (SC-010은 후보 아님)', () => {
    const analysis = analysisOf({
      primaryDomain: 'decision_guidance',
      secondaryDomains: ['wisdom_discernment'],
      situationTags: ['중요한 결정', '판단이 어려움'],
      emotionTags: ['혼란'],
      spiritualQuestionTags: ['인도', '지혜'],
      prayerModes: ['간구'],
      pastoralFunctions: ['인도', '지혜'],
    });
    const result = runRecommendationGate(analysis);

    assert.deepEqual(result.eligibleCardIds, ['SC-002']);
    assert.equal(result.eligibleCardIds.includes('SC-010'), false);
    assert.equal(result.rankedCandidates.length, 1);
    assert.equal(result.route, 'recommend');
    assert.equal(result.selectedCardId, 'SC-002');
  });

  it('primary 1개 + secondary 1개: 후보 영역에 secondary가 들어가지 않는다', () => {
    const result = runRecommendationGate(
      analysisOf({
        primaryDomain: 'grief_loss',
        secondaryDomains: ['loneliness_isolation'],
        situationTags: ['사별'],
      }),
    );
    assert.deepEqual(result.eligibleDomains, ['grief_loss']);
    assert.deepEqual(result.eligibleCardIds, ['SC-009']);
    assertPrimaryOnly(result, 'grief_loss', ['loneliness_isolation']);
  });

  it('primary 1개 + secondary 2개: 후보 카드가 전부 primary 카드다', () => {
    const secondaries: SituationDomain[] = ['chronic_illness', 'family_parenting_conflict'];
    const result = runRecommendationGate(
      analysisOf({
        primaryDomain: 'financial_hardship',
        secondaryDomains: secondaries,
        situationTags: ['생활비 부족', '만성질환', '가족 갈등'],
        emotionTags: ['불안', '지침'],
        spiritualQuestionTags: ['하나님의 돌보심', '관계 회복'],
        prayerModes: ['간구'],
        pastoralFunctions: ['위로', '관계 회복'],
      }),
    );
    assert.equal(result.route, 'recommend');
    assert.deepEqual(result.eligibleCardIds.sort(), ['SC-015', 'SC-026', 'SC-027']);
    assertPrimaryOnly(result, 'financial_hardship', secondaries);
  });

  it('secondary 전용 카드는 태그가 그 카드에 강하게 맞아도 후보·순위에 들어오지 않는다', () => {
    // SC-011(loneliness_isolation)의 태그를 그대로 준다.
    // 예전 규칙이었다면 SC-011이 후보에 들어와 SC-009를 밀어낼 수 있었다.
    const result = runRecommendationGate(
      analysisOf({
        primaryDomain: 'grief_loss',
        secondaryDomains: ['loneliness_isolation'],
        situationTags: ['외로움', '관계적 고립', '내 이야기를 할 사람이 없음'],
        emotionTags: ['외로움', '허탈함'],
        spiritualQuestionTags: ['하나님의 함께하심', '위로', '맡김'],
        prayerModes: ['교제'],
        pastoralFunctions: ['교제'],
      }),
    );
    assert.equal(result.route, 'recommend');
    assert.equal(result.selectedCardId, 'SC-009');
    for (const id of ['SC-011', 'SC-018', 'SC-019']) {
      assert.equal(result.eligibleCardIds.includes(id), false, id);
      assert.equal(result.rankedCandidates.some((score) => score.cardId === id), false, id);
    }
    assertPrimaryOnly(result, 'grief_loss', ['loneliness_isolation']);
  });

  it('COMPOUND_SCENARIOS 68개 전부: 후보가 primary 카드 집합 밖으로 나가지 않는다', () => {
    // 이 테스트가 확인하는 것은 Gate의 후보 규칙뿐이다.
    // 코퍼스의 primaryDomain·secondaryDomains 선택이 사람의 의미 기준으로 옳은지는 검증하지 않는다.
    // 코퍼스 문장에는 태그가 없으므로 태그는 비워 두고 영역만 넣는다.
    assert.equal(COMPOUND_SCENARIOS.length, 68);
    for (const scenario of COMPOUND_SCENARIOS) {
      const secondaries = [...scenario.secondaryDomains] as SituationDomain[];
      const result = runRecommendationGate(
        analysisOf({ primaryDomain: scenario.primaryDomain, secondaryDomains: secondaries }),
      );
      assert.notEqual(result.route, 'no_coverage', scenario.text);
      assertPrimaryOnly(result, scenario.primaryDomain, secondaries);
    }
  });
});

describe('Recommendation Gate · 태그는 같은 primary 카드들 사이의 순서를 정한다', () => {
  // 실제 카드 데이터로 확인한다. primary와 secondary를 고정하고 태그만 바꾼다.
  // 분석 결과의 태그에는 "어느 영역에서 온 태그인지"가 표시되지 않는다.
  // 그래서 이 테스트가 보여 주는 것은 "복합 사연에서 분석기가 붙인 태그가 primary 카드 순위를 바꿀 수 있다"까지다.
  const base = { primaryDomain: 'loneliness_isolation', secondaryDomains: ['chronic_illness'] } as const;

  it('태그에 따라 같은 loneliness_isolation 카드 중 다른 카드가 선택된다', () => {
    const cases: Array<[string[], string]> = [
      [['내 이야기를 할 사람이 없음'], 'SC-011'],
      [['혼자 견딤', '도움이 필요함'], 'SC-018'],
      [['공동체가 필요함'], 'SC-019'],
    ];
    for (const [situationTags, expected] of cases) {
      const result = runRecommendationGate(
        analysisOf({ ...base, secondaryDomains: [...base.secondaryDomains], situationTags }),
      );
      assert.equal(result.route, 'recommend', situationTags.join(','));
      assert.equal(result.selectedCardId, expected, situationTags.join(','));
      assert.equal(result.rankedCandidates[0].cardId, expected);
      assertPrimaryOnly(result, 'loneliness_isolation', ['chronic_illness']);
    }
  });

  it('보조 상황(질병)에서 나온 태그가 primary(경제) 카드의 1위를 바꿀 수 있다', () => {
    const secondaries: SituationDomain[] = ['chronic_illness'];
    // 경제 상황 태그만 있을 때
    const moneyOnly = runRecommendationGate(
      analysisOf({
        primaryDomain: 'financial_hardship',
        secondaryDomains: secondaries,
        situationTags: ['생활비 부족', '생계 걱정'],
      }),
    );
    // 질병과 함께 버티는 상황에서 분석기가 붙일 수 있는 목회 기능 태그 '인내'를 준다.
    // '인내'는 경제 카드 중 SC-027에만 있다.
    const withIllnessTag = runRecommendationGate(
      analysisOf({
        primaryDomain: 'financial_hardship',
        secondaryDomains: secondaries,
        pastoralFunctions: ['인내'],
      }),
    );
    assert.equal(moneyOnly.selectedCardId, 'SC-015');
    assert.equal(withIllnessTag.selectedCardId, 'SC-027');
    assertPrimaryOnly(moneyOnly, 'financial_hardship', secondaries);
    assertPrimaryOnly(withIllnessTag, 'financial_hardship', secondaries);
  });
});

describe('Recommendation Gate · 동점 처리', () => {
  it('순수 함수: 최고점이 같으면 임의로 고르지 않는다', () => {
    const tie = selectFromRanked([fakeScore('SC-002', 60), fakeScore('SC-010', 60), fakeScore('SC-001', 10)]);
    assert.equal(tie.selectedCardId, null);
    assert.equal(tie.isTie, true);
    assert.deepEqual(
      tie.topCards.map((card) => card.cardId),
      ['SC-002', 'SC-010'],
    );

    const single = selectFromRanked([fakeScore('SC-002', 60), fakeScore('SC-010', 59)]);
    assert.equal(single.selectedCardId, 'SC-002');
    assert.equal(single.isTie, false);
  });

  it('실제 분석에서도 primary 카드끼리 동점이면 ambiguous / selectedCardId null', () => {
    // family_parenting_conflict의 세 카드(SC-012·SC-020·SC-021)가 모두 가진 태그만 사용한다. 배점은 그대로다.
    // 예전에는 decision_guidance + 보조 wisdom_discernment의 동점으로 확인했지만,
    // 보조 영역 카드가 후보에서 빠지므로 같은 primary 안의 동점으로 바꿨다.
    const analysis = analysisOf({
      primaryDomain: 'family_parenting_conflict',
      secondaryDomains: ['burnout_exhaustion'],
      spiritualQuestionTags: ['지혜'],
      pastoralFunctions: ['지혜'],
    });
    const result = runRecommendationGate(analysis);

    assert.equal(result.route, 'ambiguous');
    assert.equal(result.reason, 'TOP_SCORE_TIE');
    assert.equal(result.selectedCardId, null);
    assert.equal(result.isTie, true);
    assert.equal(result.rankedCandidates[0].totalScore, result.rankedCandidates[1].totalScore);
    assertPrimaryOnly(result, 'family_parenting_conflict', ['burnout_exhaustion']);
  });

  it('secondary 카드가 빠지면서 예전의 교차 영역 동점은 더 이상 생기지 않는다', () => {
    // 예전: decision_guidance(SC-002)와 보조 wisdom_discernment(SC-010)가 같은 점수 → ambiguous.
    // 지금: 후보가 SC-002 한 장뿐이라 동점이 아니다.
    const result = runRecommendationGate(
      analysisOf({
        primaryDomain: 'decision_guidance',
        secondaryDomains: ['wisdom_discernment'],
        spiritualQuestionTags: ['인도', '분별'],
        prayerModes: ['간구'],
        pastoralFunctions: ['인도'],
      }),
    );
    assert.equal(result.route, 'recommend');
    assert.equal(result.selectedCardId, 'SC-002');
    assert.equal(result.isTie, false);
    assert.deepEqual(result.eligibleCardIds, ['SC-002']);
  });
});

/* ================================================================== */
/* 영역 우선순위 · domain_choice                                         */
/* ================================================================== */

/**
 * 이 묶음은 Gate가 analyzer 계약을 어떻게 처리하는지만 본다.
 * 코퍼스 사례를 계약 모양의 mock으로 바꿔 넣을 뿐, 실제 Analyzer(OpenAI)가
 * 그 문장을 needs_choice 또는 resolved로 분류하는지는 검증하지 않는다.
 */
const needsChoiceOf = (
  candidates: readonly [SituationDomain, SituationDomain],
  overrides: Partial<SituationAnalysis> = {},
): SituationAnalysis =>
  analysisOf({
    domainPriority: 'needs_choice',
    primaryDomain: null,
    domainChoiceCandidates: [...candidates],
    secondaryDomains: [],
    ...overrides,
  });

describe('Recommendation Gate · 영역 선택 필요(domain_choice)', () => {
  it('needs_choice이고 safety가 normal이면 domain_choice로 두 후보를 보존하고 top-level 카드는 고르지 않는다', () => {
    const result = runRecommendationGate(
      needsChoiceOf(['financial_hardship', 'fear_uncertainty'], {
        situationTags: ['생활비 부족', '두려운 일을 앞둠'],
        emotionTags: ['불안'],
      }),
    );
    assert.equal(result.route, 'domain_choice');
    assert.equal(result.reason, 'DOMAIN_PRIORITY_UNRESOLVED');
    assert.equal(result.domainPriority, 'needs_choice');
    assert.equal(result.primaryDomain, null);
    assert.deepEqual(result.domainChoiceCandidates, ['financial_hardship', 'fear_uncertainty']);
    assert.deepEqual(result.secondaryDomains, []);
    assert.deepEqual(result.eligibleDomains, []);
    assert.deepEqual(result.eligibleCardIds, []);
    assert.deepEqual(result.rankedCandidates, []);
    assert.equal(result.selectedCardId, null);
    assert.equal(result.isTie, false);
    // 영역이 정해지지 않았으므로 coverage를 계산하지 않는다. "지원하지 않는 영역"(no_coverage)으로 표현하지 않는다.
    assert.equal(result.coverage, null);
    assert.notEqual(result.route, 'no_coverage');
  });

  it('후보 순서를 바꿔도 결과 route와 카드 없음은 같고, 순서는 그대로 보존된다(순서가 우선순위로 쓰이지 않는다)', () => {
    const forward = runRecommendationGate(needsChoiceOf(['gratitude_joy', 'grief_loss']));
    const reversed = runRecommendationGate(needsChoiceOf(['grief_loss', 'gratitude_joy']));
    for (const result of [forward, reversed]) {
      assert.equal(result.route, 'domain_choice');
      assert.equal(result.primaryDomain, null);
      assert.deepEqual(result.eligibleCardIds, []);
      assert.equal(result.selectedCardId, null);
    }
    assert.deepEqual(forward.domainChoiceCandidates, ['gratitude_joy', 'grief_loss']);
    assert.deepEqual(reversed.domainChoiceCandidates, ['grief_loss', 'gratitude_joy']);
  });

  it('safety가 normal이 아니면 needs_choice여도 safety가 먼저이고 영역 선택을 내보내지 않는다', () => {
    for (const level of ['caution', 'urgent'] as const) {
      const result = runRecommendationGate(
        needsChoiceOf(['relationship_conflict_forgiveness', 'financial_hardship'], {
          safety: { level, categories: ['abuse'] },
        }),
      );
      assert.equal(result.route, 'safety', level);
      assert.equal(result.reason, 'SAFETY_FIRST');
      assert.deepEqual(result.domainChoiceCandidates, [], '안전 경로에서는 영역 선택 후보를 내보내지 않는다.');
      assert.deepEqual(result.eligibleCardIds, []);
      assert.deepEqual(result.rankedCandidates, []);
      assert.equal(result.selectedCardId, null);
      assert.equal(result.primaryDomain, null);
      assert.equal(result.coverage, null);
      assert.deepEqual(result.safety, { level, categories: ['abuse'] });
    }
  });

  it('resolved 경로의 결과에는 domainChoiceCandidates가 항상 빈 배열이다', () => {
    const cases: SituationAnalysis[] = [
      analysisOf({ primaryDomain: 'fear_uncertainty', situationTags: ['두려운 일을 앞둠'] }),
      analysisOf({ primaryDomain: 'other_uncovered' }),
      analysisOf({ primaryDomain: 'grief_loss', safety: { level: 'caution', categories: ['suicide'] } }),
      analysisOf({ primaryDomain: 'family_parenting_conflict', spiritualQuestionTags: ['지혜'], pastoralFunctions: ['지혜'] }),
    ];
    const routes = cases.map((analysis) => {
      const result = runRecommendationGate(analysis);
      assert.equal(result.domainPriority, 'resolved');
      assert.deepEqual(result.domainChoiceCandidates, []);
      assert.ok(result.coverage !== null, 'resolved면 coverage를 계산한다.');
      return result.route;
    });
    assert.deepEqual(routes, ['recommend', 'no_coverage', 'safety', 'ambiguous']);
  });

  it('domain_choice와 카드 동점 ambiguous는 다른 route다', () => {
    const tie = runRecommendationGate(
      analysisOf({ primaryDomain: 'family_parenting_conflict', spiritualQuestionTags: ['지혜'], pastoralFunctions: ['지혜'] }),
    );
    assert.equal(tie.route, 'ambiguous');
    assert.equal(tie.reason, 'TOP_SCORE_TIE');
    assert.equal(tie.primaryDomain, 'family_parenting_conflict');
    assert.equal(tie.isTie, true);

    const choice = runRecommendationGate(needsChoiceOf(['family_parenting_conflict', 'burnout_exhaustion']));
    assert.equal(choice.route, 'domain_choice');
    assert.equal(choice.isTie, false);
    assert.equal(choice.primaryDomain, null);
  });

  it('resolved인데 primaryDomain이 null인 검증되지 않은 입력은 임의 route로 바꾸지 않고 오류를 낸다', () => {
    assert.throws(
      () => runRecommendationGate(analysisOf({ primaryDomain: null })),
      /resolved인데 primaryDomain이 없습니다/,
    );
  });
});

/** 후보 영역 하나를 고른 resolved 분석으로 직접 Gate를 돌린 결과를 option 모양으로 줄인다. 비교 기준용. */
const expectedOptionFor = (
  analysis: SituationAnalysis,
  domain: SituationDomain,
  cards = SCRIPTURE_CARDS,
) => {
  const others = analysis.domainChoiceCandidates.filter((candidate) => candidate !== domain);
  const direct = runRecommendationGate(
    { ...analysis, domainPriority: 'resolved', primaryDomain: domain, domainChoiceCandidates: [], secondaryDomains: others },
    cards,
  );
  return {
    domain,
    resolution: direct.route,
    selectedCardId: direct.route === 'recommend' ? direct.selectedCardId : null,
    eligibleCardIds: direct.eligibleCardIds,
  };
};

const TOP_LEVEL_EMPTY = (result: ReturnType<typeof runRecommendationGate>, label: string) => {
  assert.deepEqual(result.eligibleDomains, [], label);
  assert.deepEqual(result.eligibleCardIds, [], label);
  assert.deepEqual(result.rankedCandidates, [], label);
  assert.equal(result.selectedCardId, null, label);
  assert.equal(result.isTie, false, label);
  assert.equal(result.primaryDomain, null, label);
  assert.deepEqual(result.secondaryDomains, [], label);
  assert.equal(result.coverage, null, label);
};

describe('Recommendation Gate · 영역 선택 option (domainChoiceOptions)', () => {
  it('domain_choice에는 option이 정확히 2개이고, 순서·domain이 후보와 같다', () => {
    const candidates = ['financial_hardship', 'fear_uncertainty'] as const;
    const result = runRecommendationGate(needsChoiceOf(candidates, { situationTags: ['생활비 부족'] }));
    assert.equal(result.route, 'domain_choice');
    assert.equal(result.domainChoiceOptions.length, 2);
    assert.deepEqual(
      result.domainChoiceOptions.map((option) => option.domain),
      [...candidates],
    );
    for (const option of result.domainChoiceOptions) {
      assert.deepEqual(Object.keys(option).sort(), ['domain', 'resolution', 'selectedCardId']);
    }
    TOP_LEVEL_EMPTY(result, 'domain_choice');
  });

  it('각 option은 자기 domain 카드만 쓰고, 다른 후보 영역의 카드는 고르지 않는다', () => {
    const analysis = needsChoiceOf(['financial_hardship', 'fear_uncertainty'], {
      situationTags: ['생활비 부족', '두려운 일을 앞둠'],
      emotionTags: ['불안'],
      spiritualQuestionTags: ['신뢰'],
      pastoralFunctions: ['위로'],
    });
    const result = runRecommendationGate(analysis);
    for (const option of result.domainChoiceOptions) {
      const expected = expectedOptionFor(analysis, option.domain);
      assert.equal(option.resolution, expected.resolution, option.domain);
      assert.equal(option.selectedCardId, expected.selectedCardId, option.domain);
      if (option.selectedCardId !== null) {
        assert.ok(cardsWithDomain(option.domain).includes(option.selectedCardId), option.domain);
        const otherDomain = analysis.domainChoiceCandidates.find((domain) => domain !== option.domain)!;
        assert.equal(cardsWithDomain(otherDomain).includes(option.selectedCardId), false, option.domain);
      }
    }
  });

  it('실제 카드 데이터: 한 후보는 recommend, 다른 후보는 ambiguous가 될 수 있다', () => {
    // family_parenting_conflict 세 카드(SC-012·020·021)는 '지혜' 태그 점수가 같아 동점이다.
    // fear_uncertainty는 카드 한 장이 정해진다. 카드 번호는 하드코딩하지 않고 직접 계산과 비교한다.
    const analysis = needsChoiceOf(['family_parenting_conflict', 'fear_uncertainty'], {
      spiritualQuestionTags: ['지혜'],
      pastoralFunctions: ['지혜'],
    });
    const result = runRecommendationGate(analysis);
    const [family, fear] = result.domainChoiceOptions;
    assert.deepEqual(family, { domain: 'family_parenting_conflict', resolution: 'ambiguous', selectedCardId: null });
    assert.equal(fear.domain, 'fear_uncertainty');
    assert.equal(fear.resolution, 'recommend');
    assert.equal(fear.selectedCardId, expectedOptionFor(analysis, 'fear_uncertainty').selectedCardId);
    assert.ok(fear.selectedCardId !== null && cardsWithDomain('fear_uncertainty').includes(fear.selectedCardId));
    TOP_LEVEL_EMPTY(result, 'recommend+ambiguous');
  });

  it('주입한 작은 카드 데이터: 카드가 없는 후보는 no_coverage option이다', () => {
    const fearCard = SCRIPTURE_CARDS.find((card) => card.domains.includes('fear_uncertainty'))!;
    const cards = [fearCard];
    const analysis = needsChoiceOf(['grief_loss', 'fear_uncertainty']);
    const result = runRecommendationGate(analysis, cards);
    assert.equal(result.route, 'domain_choice');
    assert.deepEqual(result.domainChoiceOptions, [
      { domain: 'grief_loss', resolution: 'no_coverage', selectedCardId: null },
      { domain: 'fear_uncertainty', resolution: 'recommend', selectedCardId: fearCard.id },
    ]);
    // option이 no_coverage여도 top-level route는 domain_choice이고 no_coverage가 아니다.
    assert.notEqual(result.route, 'no_coverage');
    TOP_LEVEL_EMPTY(result, 'injected');
  });

  it('safety route에는 option이 없다 (needs_choice여도)', () => {
    for (const level of ['caution', 'urgent'] as const) {
      const result = runRecommendationGate(
        needsChoiceOf(['financial_hardship', 'fear_uncertainty'], { safety: { level, categories: ['abuse'] } }),
      );
      assert.equal(result.route, 'safety');
      assert.deepEqual(result.domainChoiceOptions, []);
    }
  });

  it('일반 recommend·ambiguous·no_coverage·safety에는 option이 없다', () => {
    const cases: SituationAnalysis[] = [
      analysisOf({ primaryDomain: 'fear_uncertainty', situationTags: ['두려운 일을 앞둠'] }),
      analysisOf({ primaryDomain: 'family_parenting_conflict', spiritualQuestionTags: ['지혜'], pastoralFunctions: ['지혜'] }),
      analysisOf({ primaryDomain: 'other_uncovered' }),
      analysisOf({ primaryDomain: 'grief_loss', safety: { level: 'caution', categories: ['suicide'] } }),
    ];
    const routes = cases.map((analysis) => {
      const result = runRecommendationGate(analysis);
      assert.deepEqual(result.domainChoiceOptions, [], result.route);
      return result.route;
    });
    assert.deepEqual(routes, ['recommend', 'ambiguous', 'no_coverage', 'safety']);
  });

  it('DOMAIN_CHOICE_SCENARIOS 34개: option 두 개, 후보 순서를 뒤집어도 domain별 결과가 같다', () => {
    assert.equal(DOMAIN_CHOICE_SCENARIOS.length, 34);
    for (const scenario of DOMAIN_CHOICE_SCENARIOS) {
      const [first, second] = scenario.candidateDomains;
      const forward = runRecommendationGate(needsChoiceOf([first, second]));
      const reversed = runRecommendationGate(needsChoiceOf([second, first]));

      assert.equal(forward.route, 'domain_choice', scenario.id);
      assert.equal(forward.domainChoiceOptions.length, 2, scenario.id);
      assert.deepEqual(forward.domainChoiceOptions.map((option) => option.domain), [first, second], scenario.id);
      assert.deepEqual(reversed.domainChoiceOptions.map((option) => option.domain), [second, first], scenario.id);

      const byDomain = (result: typeof forward) =>
        Object.fromEntries(result.domainChoiceOptions.map((option) => [option.domain, option]));
      assert.deepEqual(byDomain(forward), byDomain(reversed), scenario.id);

      for (const option of forward.domainChoiceOptions) {
        assert.ok(['recommend', 'ambiguous', 'no_coverage'].includes(option.resolution), scenario.id);
        assert.equal(option.selectedCardId !== null, option.resolution === 'recommend', scenario.id);
        if (option.selectedCardId !== null) {
          assert.ok(cardsWithDomain(option.domain).includes(option.selectedCardId), `${scenario.id} ${option.domain}`);
        }
      }
      TOP_LEVEL_EMPTY(forward, scenario.id);
      TOP_LEVEL_EMPTY(reversed, scenario.id);
    }
  });
});

describe('Recommendation Gate · 코퍼스 계약형 mock (Analyzer 정확도 검증 아님)', () => {
  it('DOMAIN_CHOICE_SCENARIOS 34개: needs_choice mock이 validator를 통과하고 모두 domain_choice다', () => {
    assert.equal(DOMAIN_CHOICE_SCENARIOS.length, 34);
    for (const scenario of DOMAIN_CHOICE_SCENARIOS) {
      const analysis = needsChoiceOf(scenario.candidateDomains);
      const validation = validateSituationAnalysis(analysis);
      assert.equal(validation.valid, true, `${scenario.id}: ${validation.errors.join(' / ')}`);

      const result = runRecommendationGate(analysis);
      assert.equal(result.route, 'domain_choice', scenario.id);
      assert.equal(result.reason, 'DOMAIN_PRIORITY_UNRESOLVED', scenario.id);
      assert.equal(result.primaryDomain, null, scenario.id);
      assert.deepEqual(result.domainChoiceCandidates, [...scenario.candidateDomains], scenario.id);
      assert.deepEqual(result.secondaryDomains, [], scenario.id);
      assert.deepEqual(result.eligibleDomains, [], scenario.id);
      assert.deepEqual(result.eligibleCardIds, [], scenario.id);
      assert.deepEqual(result.rankedCandidates, [], scenario.id);
      assert.equal(result.selectedCardId, null, scenario.id);

      // 후보 순서를 뒤집어도 같은 결론이다. 첫 번째 후보를 primary처럼 쓰지 않는다.
      const [first, second] = scenario.candidateDomains;
      const reversed = runRecommendationGate(needsChoiceOf([second, first]));
      assert.equal(reversed.route, 'domain_choice', scenario.id);
      assert.deepEqual(reversed.eligibleCardIds, [], scenario.id);
    }
  });

  it('COMPOUND_SCENARIOS 68개: resolved mock이 validator를 통과하고 Primary-First 후보 규칙을 지킨다', () => {
    assert.equal(COMPOUND_SCENARIOS.length, 68);
    for (const scenario of COMPOUND_SCENARIOS) {
      const secondaries = [...scenario.secondaryDomains] as SituationDomain[];
      const analysis = analysisOf({
        domainPriority: 'resolved',
        primaryDomain: scenario.primaryDomain,
        domainChoiceCandidates: [],
        secondaryDomains: secondaries,
      });
      const validation = validateSituationAnalysis(analysis);
      assert.equal(validation.valid, true, `${scenario.text}: ${validation.errors.join(' / ')}`);

      const result = runRecommendationGate(analysis);
      assert.notEqual(result.route, 'domain_choice', scenario.text);
      assert.deepEqual(result.domainChoiceCandidates, [], scenario.text);
      assertPrimaryOnly(result, scenario.primaryDomain, secondaries);
    }
  });
});
