import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { DomainChoiceOption } from './request-recommendation.ts';
import {
  buildSituationClarificationPrompt,
  combineSituationWithClarification,
  MAX_CLARIFICATION_ROUNDS,
  MAX_RECOMMENDATION_SITUATION_LENGTH,
} from './situation-clarification.ts';

const staticOptions: [DomainChoiceOption, DomainChoiceOption] = [
  { domain: 'family_parenting_conflict', resolution: 'recommend', selectedCardId: 'SC-009' },
  {
    domain: 'relationship_conflict_forgiveness',
    resolution: 'recommend',
    selectedCardId: 'SC-012',
  },
];

describe('상황 추가 질문', () => {
  it('첫 분석의 두 후보를 한국어 질문으로 만들고 내부 id는 노출하지 않는다', () => {
    const prompt = buildSituationClarificationPrompt(staticOptions);
    assert.deepEqual(prompt, {
      question: '‘가족과 자녀 문제’, ‘관계의 갈등과 용서’ 두 주제가 함께 느껴지는 상황에서, 지금 가장 마음에 걸리는 장면은 무엇인가요?',
      guide: '누가 옳은지 판단하기보다, 실제로 있었던 일을 편한 만큼 적어주세요.',
      labels: ['가족과 자녀 문제', '관계의 갈등과 용서'],
    });
    assert.equal(JSON.stringify(prompt).includes('family_parenting_conflict'), false);
  });

  it('새 영역은 서버가 검증해 보낸 표시 이름으로 질문한다', () => {
    const prompt = buildSituationClarificationPrompt([
      {
        domain: 'caregiving_strain',
        displayName: '오래 돌보는 무게',
        resolution: 'no_coverage',
        selectedCardId: null,
      },
      staticOptions[1],
    ]);
    assert.equal(
      prompt?.question,
      '‘오래 돌보는 무게’, ‘관계의 갈등과 용서’ 두 주제가 함께 느껴지는 상황에서, 지금 가장 마음에 걸리는 장면은 무엇인가요?',
    );
    assert.equal(JSON.stringify(prompt).includes('caregiving_strain'), false);
  });

  it('두 번째와 세 번째 질문은 구체적 장면의 마음과 현재 영향·바라는 도움을 차례로 묻는다', () => {
    assert.deepEqual(buildSituationClarificationPrompt(staticOptions, 1), {
      question: '그 장면에서 마음이 가장 힘들었던 순간은 언제였나요?',
      guide: '그때 들었던 감정이나 생각을 한두 문장으로 적어주세요.',
      labels: ['가족과 자녀 문제', '관계의 갈등과 용서'],
    });
    assert.deepEqual(buildSituationClarificationPrompt(staticOptions, 2), {
      question: '그 일이 지금 나에게 어떤 영향을 주고 있으며, 가장 바라는 도움은 무엇인가요?',
      guide: '위로, 용기, 관계의 회복, 결정의 지혜처럼 말씀으로 붙들고 싶은 부분을 적어주세요.',
      labels: ['가족과 자녀 문제', '관계의 갈등과 용서'],
    });
  });

  it('최대 횟수 뒤에는 더 질문하지 않는다', () => {
    assert.equal(buildSituationClarificationPrompt(staticOptions, MAX_CLARIFICATION_ROUNDS), null);
    assert.equal(buildSituationClarificationPrompt(staticOptions, -1), null);
    assert.equal(buildSituationClarificationPrompt(staticOptions, 0.5), null);
  });

  it('정확히 두 개가 아니거나 표시 이름이 같으면 질문을 만들지 않는다', () => {
    assert.equal(buildSituationClarificationPrompt([]), null);
    assert.equal(buildSituationClarificationPrompt([staticOptions[0]]), null);
    assert.equal(
      buildSituationClarificationPrompt([
        { ...staticOptions[0], displayName: '같은 이름' },
        { ...staticOptions[1], displayName: '같은 이름' },
      ]),
      null,
    );
  });
});

describe('첫 상황과 추가 설명 결합', () => {
  it('사용자가 쓴 두 내용을 줄바꿈으로만 연결한다', () => {
    assert.deepEqual(
      combineSituationWithClarification(
        ' 동생과 사이가 좋지 않아요. ',
        ' 대화할 때 무시당한다고 느껴져 속상해요. ',
      ),
      {
        ok: true,
        situation: '동생과 사이가 좋지 않아요.\n대화할 때 무시당한다고 느껴져 속상해요.',
      },
    );
  });

  it('빈 첫 상황과 빈 추가 설명을 구분해 거절한다', () => {
    assert.deepEqual(combineSituationWithClarification('   ', '설명'), {
      ok: false,
      reason: 'empty_original',
    });
    assert.deepEqual(combineSituationWithClarification('상황', '   '), {
      ok: false,
      reason: 'empty_detail',
    });
  });

  it('합친 내용이 서버의 3000자 제한을 넘으면 보내지 않는다', () => {
    const original = '가'.repeat(MAX_RECOMMENDATION_SITUATION_LENGTH - 1);
    assert.deepEqual(combineSituationWithClarification(original, '나'), {
      ok: false,
      reason: 'too_long',
    });
  });
});
