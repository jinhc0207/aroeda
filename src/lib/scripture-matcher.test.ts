/**
 * Scripture Matching Engine 테스트
 *
 * 실행: npm test
 *
 * 태그는 모두 Scripture Card에 실제로 저장되어 있는 값을 그대로 사용한다.
 * 이 파일은 앱 화면에서 불러오지 않으므로 앱 번들에는 들어가지 않는다.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { matchScriptureCards, type MatchInput } from './scripture-matcher.ts';

type Case = {
  name: string;
  input: MatchInput;
  expectedCardId: string;
};

const CASES: Case[] = [
  {
    name: 'CASE 1 · 미래 선택과 이사 앞에서',
    input: {
      situationTags: ['미래 선택', '이사'],
      emotionTags: ['걱정', '불확실함'],
      spiritualQuestionTags: ['인도', '신뢰', '분별'],
      prayerModes: ['간구'],
    },
    expectedCardId: 'SC-002',
  },
  {
    name: 'CASE 2 · 좋은 일이 생김',
    input: {
      situationTags: ['좋은 일이 생김'],
      emotionTags: ['기쁨', '감사'],
      spiritualQuestionTags: ['감사', '하나님의 선하심'],
      prayerModes: ['감사', '찬양'],
    },
    expectedCardId: 'SC-004',
  },
  {
    name: 'CASE 3 · 오래된 기도, 변하지 않는 상황',
    input: {
      situationTags: ['오래된 기도', '상황이 변하지 않음'],
      emotionTags: ['지침', '답답함'],
      spiritualQuestionTags: ['하나님의 침묵', '기다림'],
      prayerModes: ['탄식', '간구'],
    },
    expectedCardId: 'SC-003',
  },
  {
    name: 'CASE 4 · 다른 사람과 비교',
    input: {
      situationTags: ['다른 사람과 비교'],
      emotionTags: ['열등감', '질투'],
      spiritualQuestionTags: ['비교', '소명'],
      prayerModes: ['간구', '결단'],
    },
    expectedCardId: 'SC-007',
  },
  {
    name: 'CASE 5 · 억울한 일과 괴롭힘',
    input: {
      situationTags: ['억울한 일을 당함', '괴롭힘'],
      emotionTags: ['분노', '억울함'],
      spiritualQuestionTags: ['정의', '악'],
      prayerModes: ['탄식', '간구'],
    },
    expectedCardId: 'SC-008',
  },
  {
    name: 'CASE 6 · 사별과 상실',
    input: {
      situationTags: ['사별', '상실'],
      emotionTags: ['슬픔', '그리움'],
      spiritualQuestionTags: ['슬픔', '하나님의 함께하심'],
      prayerModes: ['탄식'],
    },
    expectedCardId: 'SC-009',
  },
  {
    name: 'CASE 7 · 같은 죄를 반복함',
    input: {
      situationTags: ['같은 죄를 반복함'],
      emotionTags: ['죄책감', '부끄러움'],
      spiritualQuestionTags: ['회개', '용서', '은혜'],
      prayerModes: ['회개'],
    },
    expectedCardId: 'SC-006',
  },
  {
    name: 'CASE 8 · 특별한 문제 없이 조용히',
    input: {
      situationTags: ['특별한 문제가 없음'],
      emotionTags: ['평안', '고요함'],
      spiritualQuestionTags: ['하나님과의 교제', '쉼'],
      prayerModes: ['교제'],
    },
    expectedCardId: 'SC-005',
  },
];

describe('Scripture Matching Engine', () => {
  for (const testCase of CASES) {
    it(`${testCase.name} → ${testCase.expectedCardId}`, () => {
      const result = matchScriptureCards(testCase.input);

      assert.equal(
        result.topCards.length,
        1,
        `동점이 발생했습니다: ${result.topCards.map((card) => card.cardId).join(', ')}`,
      );
      assert.equal(result.topCards[0].cardId, testCase.expectedCardId);

      // 점수 상세가 모두 계산되는지 확인
      const top = result.topCards[0];
      for (const key of [
        'situationScore',
        'emotionScore',
        'spiritualQuestionScore',
        'prayerModeScore',
        'pastoralFunctionScore',
      ] as const) {
        assert.equal(typeof top[key], 'number', `${key}가 숫자가 아닙니다.`);
      }
      assert.equal(result.scores.length, 31, '카드 31개 전부의 점수가 나와야 합니다.');
    });
  }

  it('동점이면 숨기지 않고 모두 돌려준다', () => {
    // 어떤 카드와도 맞지 않는 태그 → 모든 카드가 0점 동점
    const result = matchScriptureCards({ situationTags: ['존재하지 않는 상황'] });
    assert.equal(result.topScore, 0);
    assert.equal(result.isTie, true);
    assert.equal(result.topCards.length, 31);
  });

  it('알 수 없는 태그가 섞여 있어도 멈추지 않는다', () => {
    const result = matchScriptureCards({
      situationTags: ['사별', '이런 태그는 없습니다'],
      emotionTags: ['슬픔'],
      spiritualQuestionTags: ['알 수 없는 질문'],
      prayerModes: [],
      pastoralFunctions: ['위로'],
    });
    assert.equal(result.topCards[0].cardId, 'SC-009');
    assert.ok(result.topScore > 0);
  });

  it('빈 입력에도 오류를 내지 않는다', () => {
    const result = matchScriptureCards({});
    assert.equal(result.scores.length, 31);
    assert.equal(result.topScore, 0);
    assert.equal(result.isTie, true);
  });
});
