/**
 * 말씀 영역 확장 로컬 시뮬레이션
 *
 * OpenAI·네트워크 없이 실제 분석기가 반환할 수 있는 태그 묶음을 재현한다.
 * 각 확장 영역이 대표 카드로 연결되고, 안전 신호가 있으면 추천보다 먼저 멈추는지 확인한다.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { runRecommendationGate } from './recommendation-gate.ts';
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
