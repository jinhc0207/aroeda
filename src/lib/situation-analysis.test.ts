/**
 * Situation Analyzer 규격 테스트
 *
 * 실행: npm test
 *
 * 실제 분석 기능은 아직 없다. 규격 검증과 mock 결과가 매칭 엔진을 통과하는지만 확인한다.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SCRIPTURE_CARDS } from '../data/scripture-cards.ts';
import { TAXONOMY, isKnownTag, unknownTags } from '../data/analysis-taxonomy.ts';
import { matchScriptureCards } from './scripture-matcher.ts';
import { MOCK_ANALYSIS_CASES, MOCK_SAFETY_CASES } from './situation-analysis.mock.ts';
import {
  assertSituationAnalysis,
  validateSituationAnalysis,
  type SituationAnalysis,
} from './situation-analysis.ts';

const baseAnalysis = (): SituationAnalysis => ({
  primaryDomain: 'grief_loss',
  secondaryDomains: [],
  situationTags: ['사별'],
  emotionTags: ['슬픔'],
  spiritualQuestionTags: ['슬픔'],
  prayerModes: ['탄식'],
  pastoralFunctions: ['위로'],
  safety: { level: 'normal', categories: [] },
  confidence: 0.8,
});

describe('표준 태그 사전', () => {
  it('Scripture Card에 있는 값으로만 만들어진다', () => {
    const fromCards = {
      situationTags: new Set(SCRIPTURE_CARDS.flatMap((card) => card.situationTags)),
      emotionTags: new Set(SCRIPTURE_CARDS.flatMap((card) => card.emotionTags)),
      spiritualQuestionTags: new Set(SCRIPTURE_CARDS.flatMap((card) => card.spiritualQuestionTags)),
      prayerModes: new Set(SCRIPTURE_CARDS.flatMap((card) => card.prayerModes)),
      pastoralFunctions: new Set(SCRIPTURE_CARDS.flatMap((card) => card.pastoralFunction)),
    };

    for (const [kind, tags] of Object.entries(TAXONOMY)) {
      const expected = fromCards[kind as keyof typeof fromCards];
      assert.equal(tags.length, expected.size, `${kind} 개수가 카드와 다릅니다.`);
      for (const tag of tags) {
        assert.ok(expected.has(tag), `${kind}에 카드에 없는 태그가 있습니다: ${tag}`);
      }
    }
  });

  it('중복 태그가 없다', () => {
    for (const [kind, tags] of Object.entries(TAXONOMY)) {
      assert.equal(new Set(tags).size, tags.length, `${kind}에 중복이 있습니다.`);
    }
  });

  it('사전에 없는 태그를 찾아낸다', () => {
    assert.equal(isKnownTag('emotionTags', '슬픔'), true);
    assert.equal(isKnownTag('emotionTags', '이런 감정은 없습니다'), false);
    assert.deepEqual(unknownTags('situationTags', ['사별', '없는 상황']), ['없는 상황']);
  });
});

describe('Situation Analyzer 규격 검증', () => {
  it('올바른 결과는 통과한다', () => {
    const result = validateSituationAnalysis(baseAnalysis());
    assert.equal(result.valid, true, result.errors.join(' / '));
  });

  it('정의되지 않은 태그가 들어오면 실패한다', () => {
    const analysis = { ...baseAnalysis(), emotionTags: ['슬픔', '없는감정'] };
    const result = validateSituationAnalysis(analysis);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((error) => error.includes('없는감정')));
    assert.throws(() => assertSituationAnalysis(analysis));
  });

  it('confidence가 0~1을 벗어나면 실패한다', () => {
    for (const confidence of [-0.1, 1.5]) {
      const result = validateSituationAnalysis({ ...baseAnalysis(), confidence });
      assert.equal(result.valid, false, `${confidence}가 통과되었습니다.`);
      assert.ok(result.errors.some((error) => error.includes('confidence')));
    }
    assert.equal(validateSituationAnalysis({ ...baseAnalysis(), confidence: 0 }).valid, true);
    assert.equal(validateSituationAnalysis({ ...baseAnalysis(), confidence: 1 }).valid, true);
  });

  it('safety는 허용된 값만 받는다', () => {
    const badLevel = validateSituationAnalysis({
      ...baseAnalysis(),
      safety: { level: 'danger', categories: [] },
    });
    assert.equal(badLevel.valid, false);

    const badCategory = validateSituationAnalysis({
      ...baseAnalysis(),
      safety: { level: 'urgent', categories: ['panic'] },
    });
    assert.equal(badCategory.valid, false);

    const normalWithCategory = validateSituationAnalysis({
      ...baseAnalysis(),
      safety: { level: 'normal', categories: ['suicide'] },
    });
    assert.equal(normalWithCategory.valid, false);

    const urgentWithoutCategory = validateSituationAnalysis({
      ...baseAnalysis(),
      safety: { level: 'urgent', categories: [] },
    });
    assert.equal(urgentWithoutCategory.valid, false);
  });

  it('객체가 아닌 값도 오류 없이 걸러낸다', () => {
    for (const value of [null, undefined, 'text', 42, []]) {
      assert.equal(validateSituationAnalysis(value).valid, false);
    }
  });
});

describe('Mock 분석 결과 → 매칭 엔진', () => {
  for (const testCase of MOCK_ANALYSIS_CASES) {
    it(`${testCase.name} → ${testCase.expectedCardId}`, () => {
      const validation = validateSituationAnalysis(testCase.analysis);
      assert.equal(validation.valid, true, validation.errors.join(' / '));

      const result = matchScriptureCards(testCase.analysis);
      assert.equal(
        result.topCards.length,
        1,
        `동점: ${result.topCards.map((card) => card.cardId).join(', ')}`,
      );
      assert.equal(result.topCards[0].cardId, testCase.expectedCardId);
    });
  }
});

describe('안전 상황 mock', () => {
  for (const safetyCase of MOCK_SAFETY_CASES) {
    it(`${safetyCase.name}이 스키마로 표현된다`, () => {
      // 안전 상황에서도 나머지 규격을 그대로 지킬 수 있어야 한다.
      const analysis = {
        primaryDomain: 'other_uncovered',
        secondaryDomains: [],
        situationTags: [],
        emotionTags: [],
        spiritualQuestionTags: [],
        prayerModes: [],
        pastoralFunctions: [],
        safety: safetyCase.safety,
        confidence: 0.5,
      };
      const result = validateSituationAnalysis(analysis);
      assert.equal(result.valid, true, result.errors.join(' / '));
      assert.equal(safetyCase.safety.level, 'urgent');
      assert.ok(safetyCase.safety.categories.length > 0);
    });
  }
});
