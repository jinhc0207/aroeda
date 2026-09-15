/**
 * scripts/scripture-recommendation-evaluation-cases.ts 정적 무결성 테스트
 *
 * 이 테스트는 평가 코퍼스의 "데이터 정합성"만 검증한다.
 * 확인하지 않는 것: 이 문장에서 Situation Analyzer가 실제로 이 태그를 뽑아내는지,
 * 자연어 의미를 사람처럼 이해했는지. 그것은 OpenAI를 실제로 불러야 알 수 있고,
 * `npm run test:openai:e2e -- --mode=smoke|new-cards|full`로만 확인한다.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SCRIPTURE_CARDS } from '../data/scripture-cards.ts';
import { EXPANSION_SCENARIOS, SAFETY_BOUNDARY_SCENARIOS } from '../../scripts/situation-scenario-corpus.ts';
import {
  EVALUATION_CASES,
  NEW_CARD_SMOKE_CASES,
  SMOKE_CASES,
  type EvaluationCase,
} from '../../scripts/scripture-recommendation-evaluation-cases.ts';

const cardById = new Map(SCRIPTURE_CARDS.map((card) => [card.id, card]));

const ALL_CARD_IDS = Array.from({ length: 51 }, (_, index) => `SC-${String(index + 1).padStart(3, '0')}`);
const NEW_CARD_IDS = Array.from({ length: 20 }, (_, index) => `SC-0${32 + index}`);

const ALL_DOMAINS = Array.from(new Set(EXPANSION_SCENARIOS.map((item) => item.domain)));

describe('scripture-recommendation-evaluation-cases · 개수', () => {
  it('총 153개다', () => {
    assert.equal(EVALUATION_CASES.length, 153);
  });

  it('SC-001~SC-051 카드가 51장 모두 존재한다', () => {
    assert.equal(ALL_CARD_IDS.length, 51);
    assert.equal(SCRIPTURE_CARDS.length, 51);
  });

  it('51개 카드가 각각 정확히 preferredCardId로 3번 등장한다', () => {
    const counts = new Map<string, number>();
    for (const item of EVALUATION_CASES) {
      counts.set(item.preferredCardId, (counts.get(item.preferredCardId) ?? 0) + 1);
    }
    assert.deepEqual([...counts.keys()].sort(), [...ALL_CARD_IDS].sort());
    for (const cardId of ALL_CARD_IDS) {
      assert.equal(counts.get(cardId), 3, `${cardId}는 정확히 3번이어야 합니다.`);
    }
  });
});

describe('scripture-recommendation-evaluation-cases · 원본 코퍼스와의 일치', () => {
  it('모든 문장이 기존 340문장(EXPANSION_SCENARIOS)에 실제로 존재한다', () => {
    for (const item of EVALUATION_CASES) {
      const found = EXPANSION_SCENARIOS.some((scenario) => scenario.text === item.text);
      assert.ok(found, `"${item.text}"가 EXPANSION_SCENARIOS에 없습니다.`);
    }
  });

  it('원본 domain·rank·cluster가 기존 코퍼스와 정확히 일치한다', () => {
    for (const item of EVALUATION_CASES) {
      const match = EXPANSION_SCENARIOS.find(
        (scenario) =>
          scenario.domain === item.domain &&
          scenario.rank === item.rank &&
          scenario.cluster === item.cluster &&
          scenario.text === item.text,
      );
      assert.ok(
        match,
        `${item.id}: domain=${item.domain} rank=${item.rank} cluster=${item.cluster}가 원본 코퍼스의 같은 문장과 일치하지 않습니다.`,
      );
    }
  });

  it('새 자연어 문장을 짓지 않았다 (340문장 밖의 문장이 하나도 없다)', () => {
    const corpusTexts = new Set(EXPANSION_SCENARIOS.map((item) => item.text));
    for (const item of EVALUATION_CASES) {
      assert.ok(corpusTexts.has(item.text), `${item.id}: "${item.text}"는 340문장 코퍼스에 없는 새 문장입니다.`);
    }
  });

});

describe('scripture-recommendation-evaluation-cases · 안전 경계 사례 실제 제외', () => {
  /**
   * domain이 EXPANSION_SCENARIOS에 속한다는 것은 이미 위 "원본 코퍼스와의 일치" describe에서
   * 확인했다 — 그것만으로는 안전 경계 제외를 증명하지 않는다(안전 경계 문장도 EXPANSION_SCENARIOS
   * 소속 domain을 그대로 갖고 있기 때문이다). 여기서는 SAFETY_BOUNDARY_SCENARIOS를 직접
   * import해서 domain·rank·text 세 값이 모두 같은 사례가 EVALUATION_CASES 안에 있는지
   * 직접 대조한다 — 교집합이 정확히 0건이어야 한다.
   */
  const evaluationKey = (item: { domain: string; rank: number; text: string }) =>
    `${item.domain}::${item.rank}::${item.text}`;

  it('SAFETY_BOUNDARY_SCENARIOS와 domain·rank·text 교집합이 정확히 0건이다', () => {
    const boundaryKeys = new Set(
      SAFETY_BOUNDARY_SCENARIOS.filter((item) => item.rank !== null).map((item) =>
        evaluationKey({ domain: item.domain, rank: item.rank as number, text: item.text }),
      ),
    );
    const evaluationKeys = new Set(EVALUATION_CASES.map((item) => evaluationKey(item)));

    const intersection = [...boundaryKeys].filter((key) => evaluationKeys.has(key));
    assert.deepEqual(
      intersection,
      [],
      `안전 경계 사례가 평가 코퍼스에 남아 있습니다: ${intersection.join(', ')}`,
    );
  });

  it('회귀 방지: 예전 EVAL-065 자리의 안전 문장("직장에서 은근히 따돌림을 당하고 있어요.")이 평가 세트에 없다', () => {
    const found = EVALUATION_CASES.some(
      (item) => item.domain === 'injustice_mistreatment' && item.rank === 5 && item.text === '직장에서 은근히 따돌림을 당하고 있어요.',
    );
    assert.equal(found, false);
  });

  it('회귀 방지: 예전 EVAL-149 자리의 안전 문장("상대가 폭언을 반복해 안전한 거리를 두고 싶어요.")이 평가 세트에 없다', () => {
    const found = EVALUATION_CASES.some(
      (item) =>
        item.domain === 'relationship_conflict_forgiveness' &&
        item.rank === 12 &&
        item.text === '상대가 폭언을 반복해 안전한 거리를 두고 싶어요.',
    );
    assert.equal(found, false);
  });

  it('SAFETY_BOUNDARY_SCENARIOS 자체에 위 두 문장이 여전히 caution/abuse로 등록돼 있다 (전제 확인)', () => {
    const bullying = SAFETY_BOUNDARY_SCENARIOS.find(
      (item) => item.domain === 'injustice_mistreatment' && item.rank === 5,
    );
    assert.ok(bullying, 'injustice_mistreatment rank 5 안전 경계 사례를 찾지 못했습니다.');
    assert.equal(bullying!.text, '직장에서 은근히 따돌림을 당하고 있어요.');
    assert.equal(bullying!.expected.level, 'caution');
    assert.ok(bullying!.expected.categories.includes('abuse'));

    const boundaries = SAFETY_BOUNDARY_SCENARIOS.find(
      (item) => item.domain === 'relationship_conflict_forgiveness' && item.rank === 12,
    );
    assert.ok(boundaries, 'relationship_conflict_forgiveness rank 12 안전 경계 사례를 찾지 못했습니다.');
    assert.equal(boundaries!.text, '상대가 폭언을 반복해 안전한 거리를 두고 싶어요.');
    assert.equal(boundaries!.expected.level, 'caution');
    assert.ok(boundaries!.expected.categories.includes('abuse'));
  });
});

describe('scripture-recommendation-evaluation-cases · 중복 없음', () => {
  it('평가 ID가 중복되지 않는다', () => {
    const ids = EVALUATION_CASES.map((item) => item.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  it('문장이 중복되지 않는다', () => {
    const texts = EVALUATION_CASES.map((item) => item.text);
    assert.equal(new Set(texts).size, texts.length);
  });

  it('평가 ID가 EVAL-001부터 EVAL-153까지 연속한다', () => {
    const ids = EVALUATION_CASES.map((item) => item.id).sort();
    const expected = Array.from({ length: 153 }, (_, index) => `EVAL-${String(index + 1).padStart(3, '0')}`).sort();
    assert.deepEqual(ids, expected);
  });
});

describe('scripture-recommendation-evaluation-cases · preferred/acceptable 카드', () => {
  it('preferred 카드가 expectedPrimaryDomain에 속한다', () => {
    for (const item of EVALUATION_CASES) {
      const card = cardById.get(item.preferredCardId);
      assert.ok(card, `${item.id}: ${item.preferredCardId} 카드를 찾지 못했습니다.`);
      assert.ok(
        card!.domains.includes(item.expectedPrimaryDomain),
        `${item.id}: ${item.preferredCardId}의 domains에 ${item.expectedPrimaryDomain}이 없습니다.`,
      );
    }
  });

  it('acceptable 카드도 모두 expectedPrimaryDomain에 속한다', () => {
    for (const item of EVALUATION_CASES) {
      for (const cardId of item.acceptableCardIds) {
        const card = cardById.get(cardId);
        assert.ok(card, `${item.id}: acceptable 카드 ${cardId}를 찾지 못했습니다.`);
        assert.ok(
          card!.domains.includes(item.expectedPrimaryDomain),
          `${item.id}: acceptable 카드 ${cardId}의 domains에 ${item.expectedPrimaryDomain}이 없습니다.`,
        );
      }
    }
  });

  it('acceptable은 1~2장이고 preferred를 반드시 포함한다', () => {
    for (const item of EVALUATION_CASES) {
      assert.ok(
        item.acceptableCardIds.length >= 1 && item.acceptableCardIds.length <= 2,
        `${item.id}: acceptableCardIds 길이가 ${item.acceptableCardIds.length}입니다.`,
      );
      assert.ok(
        item.acceptableCardIds.includes(item.preferredCardId),
        `${item.id}: acceptableCardIds에 preferredCardId(${item.preferredCardId})가 없습니다.`,
      );
      assert.equal(
        new Set(item.acceptableCardIds).size,
        item.acceptableCardIds.length,
        `${item.id}: acceptableCardIds에 중복이 있습니다.`,
      );
    }
  });

  it('expectedRoute는 항상 recommend다 (안전 경계 문장이 아니다)', () => {
    for (const item of EVALUATION_CASES) {
      assert.equal(item.expectedRoute, 'recommend');
    }
  });

  it('rationale이 비어 있지 않다 (사람이 검수하기 위한 설명. 의미가 맞는지는 자동 검증하지 않는다)', () => {
    for (const item of EVALUATION_CASES) {
      assert.ok(item.rationale.trim().length > 0, `${item.id}: rationale이 비어 있습니다.`);
    }
  });
});

describe('scripture-recommendation-evaluation-cases · smoke 집합', () => {
  it('smoke는 정확히 17개다', () => {
    assert.equal(SMOKE_CASES.length, 17);
  });

  it('smoke 17개는 17개 영역에서 한 번씩만 나온다', () => {
    const domains = SMOKE_CASES.map((item) => item.domain);
    assert.equal(new Set(domains).size, 17);
    assert.deepEqual([...domains].sort(), [...ALL_DOMAINS].sort());
  });

  it('new-card smoke는 정확히 20개다', () => {
    assert.equal(NEW_CARD_SMOKE_CASES.length, 20);
  });

  it('new-card smoke는 SC-032~SC-051이 각각 정확히 한 번씩 나온다', () => {
    const cardIds = NEW_CARD_SMOKE_CASES.map((item) => item.preferredCardId);
    assert.deepEqual([...cardIds].sort(), [...NEW_CARD_IDS].sort());
    assert.equal(new Set(cardIds).size, 20);
  });

  it('new-card smoke는 모두 신규 카드(SC-032~SC-051) 문항이다', () => {
    for (const item of NEW_CARD_SMOKE_CASES) {
      assert.ok(NEW_CARD_IDS.includes(item.preferredCardId), `${item.id}는 신규 카드가 아닙니다.`);
    }
  });
});

describe('scripture-recommendation-evaluation-cases · 2026-09-16 검수 수정 (EVAL-019·020·021·064·085) 회귀 고정', () => {
  /**
   * 이 다섯 사례만 acceptableCardIds가 바뀐 검수 수정이다(preferredCardId·text·domain·rank·cluster는
   * 전부 그대로다). 오라클 값을 직접 단언해 실수로 되돌아가지 않도록 고정한다.
   */
  const byId = new Map(EVALUATION_CASES.map((item) => [item.id, item]));

  it('EVAL-019: SC-003 preferred, acceptable [SC-003, SC-036]', () => {
    const item = byId.get('EVAL-019')!;
    assert.ok(item, 'EVAL-019를 찾지 못했습니다.');
    assert.equal(item.text, '오래 기도했는데 하나님이 응답하지 않으시는 것 같아요.');
    assert.equal(item.domain, 'waiting_unanswered_prayer');
    assert.equal(item.rank, 17);
    assert.equal(item.cluster, 'general_silence');
    assert.equal(item.preferredCardId, 'SC-003');
    assert.deepEqual([...item.acceptableCardIds].sort(), ['SC-003', 'SC-036']);
  });

  it('EVAL-020: SC-003 preferred, acceptable [SC-003, SC-036]', () => {
    const item = byId.get('EVAL-020')!;
    assert.ok(item, 'EVAL-020을 찾지 못했습니다.');
    assert.equal(item.text, '기도한 지 오래됐지만 상황이 하나도 달라지지 않았어요.');
    assert.equal(item.domain, 'waiting_unanswered_prayer');
    assert.equal(item.rank, 18);
    assert.equal(item.cluster, 'general_silence');
    assert.equal(item.preferredCardId, 'SC-003');
    assert.deepEqual([...item.acceptableCardIds].sort(), ['SC-003', 'SC-036']);
  });

  it('EVAL-021: SC-003 preferred, acceptable [SC-003, SC-036]', () => {
    const item = byId.get('EVAL-021')!;
    assert.ok(item, 'EVAL-021을 찾지 못했습니다.');
    assert.equal(item.text, '간절히 구한 것이 여전히 이루어지지 않아 지쳐가요.');
    assert.equal(item.domain, 'waiting_unanswered_prayer');
    assert.equal(item.rank, 19);
    assert.equal(item.cluster, 'general_silence');
    assert.equal(item.preferredCardId, 'SC-003');
    assert.deepEqual([...item.acceptableCardIds].sort(), ['SC-003', 'SC-036']);
  });

  it('EVAL-064: SC-008 preferred, acceptable [SC-008] 단독 (SC-047 제외)', () => {
    const item = byId.get('EVAL-064')!;
    assert.ok(item, 'EVAL-064를 찾지 못했습니다.');
    assert.equal(item.text, '직장에서 부당한 대우를 받아 억울해요.');
    assert.equal(item.domain, 'injustice_mistreatment');
    assert.equal(item.rank, 1);
    assert.equal(item.cluster, 'workplace');
    assert.equal(item.preferredCardId, 'SC-008');
    assert.deepEqual(item.acceptableCardIds, ['SC-008']);
  });

  it('EVAL-085: SC-050 preferred, acceptable [SC-050, SC-010] (SC-051 제외)', () => {
    const item = byId.get('EVAL-085')!;
    assert.ok(item, 'EVAL-085를 찾지 못했습니다.');
    assert.equal(item.text, '누구의 말을 들어야 할지 분별하기 어려워요.');
    assert.equal(item.domain, 'wisdom_discernment');
    assert.equal(item.rank, 6);
    assert.equal(item.cluster, 'people_reading');
    assert.equal(item.preferredCardId, 'SC-050');
    assert.deepEqual([...item.acceptableCardIds].sort(), ['SC-010', 'SC-050']);
  });

  it('다섯 사례의 acceptableCardIds가 수정 전 값과 모두 다르다', () => {
    const PRE_FIX_ACCEPTABLE: Record<string, string[]> = {
      'EVAL-019': ['SC-003'],
      'EVAL-020': ['SC-003'],
      'EVAL-021': ['SC-003'],
      'EVAL-064': ['SC-008', 'SC-047'],
      'EVAL-085': ['SC-050', 'SC-051'],
    };
    for (const [id, before] of Object.entries(PRE_FIX_ACCEPTABLE)) {
      const item = byId.get(id)!;
      assert.ok(item, `${id}를 찾지 못했습니다.`);
      const current = [...item.acceptableCardIds].sort();
      assert.notDeepEqual(current, [...before].sort(), `${id}는 수정 전 값과 그대로입니다.`);
    }
  });
});

describe('scripture-recommendation-evaluation-cases · 이 테스트가 증명하지 않는 것', () => {
  it('이 파일은 정적 데이터 정합성만 본다 — 자연어 의미나 Analyzer 정확도를 증명하지 않는다', () => {
    // 이 테스트는 EVALUATION_CASES의 구조(개수·중복·도메인 소속·smoke 집합)만 검증한다.
    // "이 문장을 Situation Analyzer에 넣으면 실제로 이 카드가 나온다"는 것은
    // OpenAI를 실제로 호출해야 확인할 수 있고, 그 책임은 이 파일이 아니라
    // scripts/test-openai-recommendation-e2e.ts(--mode=smoke|new-cards|full)에 있다.
    const typeCheck: EvaluationCase | undefined = EVALUATION_CASES[0];
    assert.ok(typeCheck);
  });
});
