/**
 * Recommendation Gate V1 테스트
 *
 * 실행: npm test
 *
 * 실제 OpenAI를 부르지 않는다. mock Situation Analysis만 사용한다.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SCRIPTURE_CARDS } from '../data/scripture-cards.ts';
import type { SituationDomain } from '../data/situation-domains.ts';
import { runRecommendationGate, selectFromRanked } from './recommendation-gate.ts';
import type { CardScore } from './scripture-matcher.ts';
import { validateSituationAnalysis, type SituationAnalysis } from './situation-analysis.ts';

type AnalysisOverrides = Partial<SituationAnalysis>;

const analysisOf = (overrides: AnalysisOverrides): SituationAnalysis => ({
  primaryDomain: 'fear_uncertainty',
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
    assert.deepEqual(result.eligibleCardIds, ['SC-001']);
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
  });
});

describe('Recommendation Gate · 카드가 없는 상황', () => {
  it('TEST 4 · 경제적 어려움 + 불안 → no_coverage (SC-001 추천 금지)', () => {
    const analysis = analysisOf({
      primaryDomain: 'financial_hardship',
      secondaryDomains: ['fear_uncertainty'],
      situationTags: ['미래 걱정'],
      emotionTags: ['불안', '걱정'],
      spiritualQuestionTags: ['신뢰'],
      prayerModes: ['간구'],
      pastoralFunctions: ['위로'],
    });
    const result = runRecommendationGate(analysis);
    assert.equal(result.route, 'no_coverage');
    assert.equal(result.reason, 'PRIMARY_DOMAIN_NOT_COVERED');
    assert.equal(result.selectedCardId, null);
    assert.deepEqual(result.eligibleCardIds, []);
    assert.deepEqual(result.rankedCandidates, []);
  });

  it('TEST 5 · 부모-자녀 갈등 + 지혜 → no_coverage (SC-010 추천 금지)', () => {
    const analysis = analysisOf({
      primaryDomain: 'family_parenting_conflict',
      secondaryDomains: ['wisdom_discernment'],
      situationTags: ['어떻게 해야 할지 모름', '판단이 어려움'],
      emotionTags: ['막막함'],
      spiritualQuestionTags: ['지혜'],
      prayerModes: ['간구'],
      pastoralFunctions: ['지혜'],
    });
    const result = runRecommendationGate(analysis);
    assert.equal(result.route, 'no_coverage');
    assert.equal(result.selectedCardId, null);
    assert.equal(result.eligibleCardIds.includes('SC-010'), false);
  });

  it('TEST 6 · 대인 갈등과 용서 → no_coverage (SC-006 추천 금지)', () => {
    const analysis = analysisOf({
      primaryDomain: 'relationship_conflict_forgiveness',
      secondaryDomains: ['repentance_guilt'],
      spiritualQuestionTags: ['용서', '은혜'],
      prayerModes: ['회개'],
      pastoralFunctions: ['회개'],
    });
    const result = runRecommendationGate(analysis);
    assert.equal(result.route, 'no_coverage');
    assert.equal(result.selectedCardId, null);
    assert.equal(result.eligibleCardIds.includes('SC-006'), false);
  });

  it('covered secondary가 있어도 primary가 uncovered면 추천하지 않는다', () => {
    for (const primaryDomain of [
      'loneliness_isolation',
      'burnout_exhaustion',
      'spiritual_dryness',
      'chronic_illness',
      'other_uncovered',
    ] as SituationDomain[]) {
      const result = runRecommendationGate(
        analysisOf({ primaryDomain, secondaryDomains: ['fear_uncertainty', 'grief_loss'] }),
      );
      assert.equal(result.route, 'no_coverage', `${primaryDomain}에서 추천이 나왔습니다.`);
      assert.deepEqual(result.eligibleCardIds, []);
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
});

describe('Recommendation Gate · 복합 covered domain', () => {
  it('TEST 9 · gratitude_joy + fear_uncertainty → 후보는 SC-004, SC-001만', () => {
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

    assert.deepEqual(result.eligibleDomains, ['gratitude_joy', 'fear_uncertainty']);
    assert.equal(result.eligibleCardIds.includes('SC-004'), true);
    assert.equal(result.eligibleCardIds.includes('SC-001'), true);
    assert.equal(result.eligibleCardIds.length, 2, '관련 없는 domain 카드가 후보에 들어왔습니다.');
    assert.equal(result.rankedCandidates.length, 2);
    assert.ok(['SC-004', 'SC-001'].includes(result.selectedCardId ?? ''));
  });

  it('TEST 10 · decision_guidance + wisdom_discernment → 후보는 SC-002, SC-010만', () => {
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

    assert.deepEqual(result.eligibleCardIds.sort(), ['SC-002', 'SC-010']);
    assert.equal(result.rankedCandidates.length, 2);
    assert.ok(['recommend', 'ambiguous'].includes(result.route));
  });

  it('uncovered secondary는 후보 domain에 들어가지 않는다', () => {
    const result = runRecommendationGate(
      analysisOf({
        primaryDomain: 'grief_loss',
        secondaryDomains: ['loneliness_isolation'],
        situationTags: ['사별'],
      }),
    );
    assert.deepEqual(result.eligibleDomains, ['grief_loss']);
    assert.deepEqual(result.eligibleCardIds, cardsWithDomain('grief_loss'));
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

  it('실제 분석에서도 동점이면 ambiguous / selectedCardId null', () => {
    // SC-002와 SC-010 모두에 똑같이 해당하는 태그만 사용한다. Matcher 배점은 그대로다.
    const analysis = analysisOf({
      primaryDomain: 'decision_guidance',
      secondaryDomains: ['wisdom_discernment'],
      spiritualQuestionTags: ['인도', '분별'],
      prayerModes: ['간구'],
      pastoralFunctions: ['인도'],
    });
    const result = runRecommendationGate(analysis);

    assert.equal(result.route, 'ambiguous');
    assert.equal(result.reason, 'TOP_SCORE_TIE');
    assert.equal(result.selectedCardId, null);
    assert.equal(result.isTie, true);
    assert.equal(result.rankedCandidates[0].totalScore, result.rankedCandidates[1].totalScore);
  });
});
