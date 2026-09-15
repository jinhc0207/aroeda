/**
 * 말씀 영역 확장 로컬 시뮬레이션
 *
 * OpenAI·네트워크 없이 실제 분석기가 반환할 수 있는 태그 묶음을 재현한다.
 * 각 확장 영역이 대표 카드로 연결되고, 안전 신호가 있으면 추천보다 먼저 멈추는지 확인한다.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { runRecommendationGate } from './recommendation-gate.ts';
import { SCRIPTURE_CARDS } from '../data/scripture-cards.ts';
import type { SituationAnalysis } from './situation-analysis.ts';

const analysisOf = (
  primaryDomain: SituationAnalysis['primaryDomain'],
  overrides: Partial<SituationAnalysis> = {},
): SituationAnalysis => ({
  domainPriority: 'resolved',
  primaryDomain,
  domainChoiceCandidates: [],
  secondaryDomains: [],
  situationTags: [],
  emotionTags: [],
  spiritualQuestionTags: [],
  prayerModes: [],
  pastoralFunctions: [],
  safety: { level: 'normal', categories: [] },
  confidence: 0.86,
  ...overrides,
});

describe('말씀 영역 확장 · 실제 입력 방향 시뮬레이션', () => {
  const cases: Array<{
    name: string;
    analysis: SituationAnalysis;
    expectedCardId: string;
  }> = [
    {
      name: '사람들 사이에서도 외로운 날',
      analysis: analysisOf('loneliness_isolation', {
        situationTags: ['외로움', '내 이야기를 할 사람이 없음'],
        emotionTags: ['외로움'],
        spiritualQuestionTags: ['하나님의 함께하심'],
        prayerModes: ['탄식', '교제'],
        pastoralFunctions: ['위로'],
      }),
      expectedCardId: 'SC-011',
    },
    {
      name: '아이와 대화가 막힌 날',
      analysis: analysisOf('family_parenting_conflict', {
        situationTags: ['자녀와 갈등', '아이와 대화가 어려움'],
        emotionTags: ['분노', '답답함'],
        spiritualQuestionTags: ['관계 회복', '지혜'],
        prayerModes: ['간구'],
        pastoralFunctions: ['지혜'],
      }),
      expectedCardId: 'SC-012',
    },
    {
      name: '일할 힘이 남지 않은 날',
      analysis: analysisOf('burnout_exhaustion', {
        situationTags: ['소진', '의욕 상실'],
        emotionTags: ['무기력', '지침'],
        spiritualQuestionTags: ['쉼'],
        prayerModes: ['간구', '교제'],
        pastoralFunctions: ['쉼'],
      }),
      expectedCardId: 'SC-013',
    },
    {
      name: '기도해도 하나님이 멀게 느껴지는 날',
      analysis: analysisOf('spiritual_dryness', {
        situationTags: ['하나님이 멀게 느껴짐', '기도해도 아무 느낌이 없음'],
        emotionTags: ['목마름', '낙심'],
        spiritualQuestionTags: ['하나님의 침묵', '소망'],
        prayerModes: ['탄식', '신뢰'],
        pastoralFunctions: ['소망'],
      }),
      expectedCardId: 'SC-014',
    },
    {
      name: '생활비가 부족한 달',
      analysis: analysisOf('financial_hardship', {
        situationTags: ['경제적 어려움', '생활비 부족'],
        emotionTags: ['불안', '걱정'],
        spiritualQuestionTags: ['하나님의 돌보심', '신뢰'],
        prayerModes: ['간구'],
        pastoralFunctions: ['위로'],
      }),
      expectedCardId: 'SC-015',
    },
    {
      name: '만성질환과 함께 살아가는 날',
      analysis: analysisOf('chronic_illness', {
        situationTags: ['만성질환', '아픈 몸과 함께 살아감'],
        emotionTags: ['지침', '두려움'],
        spiritualQuestionTags: ['하나님의 함께하심', '은혜'],
        prayerModes: ['탄식', '간구'],
        pastoralFunctions: ['위로'],
      }),
      expectedCardId: 'SC-016',
    },
    {
      name: '상처 준 사람을 용서할지 고민하는 날',
      analysis: analysisOf('relationship_conflict_forgiveness', {
        situationTags: ['관계 갈등', '용서하고 싶음'],
        emotionTags: ['상처', '분노'],
        spiritualQuestionTags: ['용서', '관계 회복'],
        prayerModes: ['탄식', '결단'],
        pastoralFunctions: ['관계 회복'],
      }),
      expectedCardId: 'SC-017',
    },
  ];

  for (const testCase of cases) {
    it(`${testCase.name} → ${testCase.expectedCardId}`, () => {
      const result = runRecommendationGate(testCase.analysis);
      assert.equal(result.route, 'recommend');
      assert.equal(result.selectedCardId, testCase.expectedCardId);
      assert.equal(result.coverage?.covered, true);
    });
  }

  it('새 영역의 실제 위험 신호는 말씀 추천보다 안전 경로가 먼저다', () => {
    const result = runRecommendationGate(
      analysisOf('family_parenting_conflict', {
        situationTags: ['가족 갈등'],
        safety: { level: 'urgent', categories: ['abuse', 'immediate_danger'] },
      }),
    );
    assert.equal(result.route, 'safety');
    assert.equal(result.selectedCardId, null);
  });

  it('분류체계 밖의 문장은 지금도 억지 추천하지 않는다', () => {
    const result = runRecommendationGate(analysisOf('other_uncovered'));
    assert.equal(result.route, 'no_coverage');
    assert.equal(result.selectedCardId, null);
  });
});

/* ================================================================== */
/* Scripture Card Expansion v2 (2026-09-15) · 신규 20장 situationTags 분리 무결성 */
/* ================================================================== */

/**
 * 카드가 1장뿐이던 10개 영역에 정확히 2장씩 추가해(총 20장) 17개 영역 모두 3장이 되었다.
 *
 * 이 블록이 확인하는 것은 딱 하나, "카드 데이터의 situationTags 분리 무결성"이다.
 * 각 신규 카드 자신의 situationTags를 그대로 Gate 입력으로 되먹였을 때, 같은 영역의
 * 다른 두 카드와 확실히 구분되어 단독 1위 recommend가 되는지를 본다.
 *
 * 이것은 자연어 문장이 아니라 카드에 이미 저장된 태그를 그대로 되돌려 넣는 것이므로,
 * 실제 사용자 입력이나 Situation Analyzer가 그 문장에서 이 태그들을 정확히 추출하는지는
 * 이 테스트로 검증하지 않는다(Analyzer 정확도는 OpenAI를 실제로 불러야 알 수 있고,
 * 이 파일은 OpenAI·네트워크 없이 도는 로컬 시뮬레이션이다).
 *
 * situationTags만 쓰는 이유: emotionTags·spiritualQuestionTags·prayerModes·pastoralFunction은
 * 표준 사전 안에서 카드끼리 값을 나눠 쓰므로, 정말 분리되어 있는지는 그 영역 안에서
 * 카드마다 유일한 situationTags만으로 보아야 한다. 다른 사전까지 더해야만 분리된다면
 * 그것을 숨기지 않는다(이 파일의 20건 모두 situationTags만으로 분리된다).
 */
describe('Scripture Card Expansion v2 · 신규 카드 20장 situationTags 분리 무결성', () => {
  const newCardIds = Array.from({ length: 20 }, (_, index) => `SC-0${32 + index}`);
  assert.equal(newCardIds.length, 20);
  assert.deepEqual(newCardIds[0], 'SC-032');
  assert.deepEqual(newCardIds[19], 'SC-051');

  for (const cardId of newCardIds) {
    const card = SCRIPTURE_CARDS.find((item) => item.id === cardId);
    assert.ok(card, `${cardId} 카드를 찾지 못했습니다.`);
    const domain = card!.domains[0];

    it(`${cardId}(${domain}) · 자신의 situationTags로 같은 영역의 다른 카드와 분리된다`, () => {
      const analysis = analysisOf(domain, { situationTags: [...card!.situationTags] });
      const result = runRecommendationGate(analysis);

      assert.equal(result.route, 'recommend', `${cardId}: route=${result.route}`);
      assert.equal(result.selectedCardId, cardId);
      assert.equal(result.isTie, false, `${cardId}: 동점이 발생했습니다.`);
      assert.equal(result.coverage?.covered, true);
      // 같은 영역의 다른 두 카드도 여전히 후보다 — 이 카드만 남기고 나머지를 빼는 것이 아니다.
      assert.equal(result.eligibleCardIds.length, 3, `${cardId}: 영역 카드가 3장이어야 합니다.`);
    });
  }
});

describe('Scripture Card Expansion v2 · 실제 OpenAI 평가에서 확인한 카드 경계', () => {
  it('SC-034는 결혼·재혼 여부의 결정을 다른 일반 결정과 구분한다', () => {
    const card = SCRIPTURE_CARDS.find((item) => item.id === 'SC-034');
    assert.ok(card);
    assert.ok(card!.situationTags.includes('결혼이나 재혼 여부를 결정함'));
  });

  it('SC-041은 복잡한 생각을 내려놓는 교제에 쉼 기능도 포함한다', () => {
    const card = SCRIPTURE_CARDS.find((item) => item.id === 'SC-041');
    assert.ok(card);
    assert.ok(card!.situationTags.includes('복잡한 생각을 내려놓음'));
    assert.ok(card!.pastoralFunction.includes('쉼'));
  });

  it('SC-051은 일반적인 판단 어려움이 아니라 가르침의 신뢰성을 살피는 단서만 갖는다', () => {
    const card = SCRIPTURE_CARDS.find((item) => item.id === 'SC-051');
    assert.ok(card);
    assert.deepEqual(card!.situationTags, ['사랑과 진실을 함께 고려함', '믿을 만한 가르침인지 살핌']);
    assert.equal(card!.situationTags.includes('무엇이 더 나은지 분별함'), false);
  });
});
