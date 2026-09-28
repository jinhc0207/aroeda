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
  domainPriority: 'resolved',
  primaryDomain: 'grief_loss',
  domainChoiceCandidates: [],
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
        domainPriority: 'resolved',
        primaryDomain: 'other_uncovered',
        domainChoiceCandidates: [],
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

/* ================================================================== */
/* 영역 우선순위(domainPriority) 계약                                   */
/* ================================================================== */

describe('Situation Analyzer 규격 · 영역 우선순위', () => {
  const needsChoice = (): SituationAnalysis => ({
    ...baseAnalysis(),
    domainPriority: 'needs_choice',
    primaryDomain: null,
    domainChoiceCandidates: ['financial_hardship', 'fear_uncertainty'],
    secondaryDomains: [],
  });

  const needsDetail = (): SituationAnalysis => ({
    ...baseAnalysis(),
    domainPriority: 'needs_detail',
    primaryDomain: null,
    domainChoiceCandidates: [],
    secondaryDomains: [],
  });

  const failsWith = (value: unknown, fragment: string) => {
    const result = validateSituationAnalysis(value);
    assert.equal(result.valid, false, `통과하면 안 됩니다: ${JSON.stringify(value)}`);
    assert.ok(
      result.errors.some((error) => error.includes(fragment)),
      `"${fragment}" 오류가 없습니다: ${result.errors.join(' / ')}`,
    );
  };

  it('resolved 기본 형태는 통과한다', () => {
    assert.equal(validateSituationAnalysis(baseAnalysis()).valid, true);
    const withSecondary = { ...baseAnalysis(), secondaryDomains: ['loneliness_isolation'] };
    assert.equal(validateSituationAnalysis(withSecondary).valid, true);
  });

  it('needs_choice 기본 형태는 통과한다', () => {
    const result = validateSituationAnalysis(needsChoice());
    assert.equal(result.valid, true, result.errors.join(' / '));
  });

  it('needs_detail은 중심 영역·선택 후보·보조 영역이 모두 비어 있을 때만 통과한다', () => {
    const valid = validateSituationAnalysis(needsDetail());
    assert.equal(valid.valid, true, valid.errors.join(' / '));

    failsWith({ ...needsDetail(), primaryDomain: 'fear_uncertainty' }, 'needs_detail이면 primaryDomain은 null이어야 합니다');
    failsWith(
      { ...needsDetail(), domainChoiceCandidates: ['fear_uncertainty', 'financial_hardship'] },
      'needs_detail이면 domainChoiceCandidates는 비어 있어야 합니다',
    );
    failsWith(
      { ...needsDetail(), secondaryDomains: ['fear_uncertainty'] },
      'needs_detail이면 secondaryDomains는 비어 있어야 합니다',
    );
  });

  it('domainPriority가 없거나 허용되지 않는 값이면 실패한다', () => {
    const { domainPriority, ...withoutPriority } = baseAnalysis();
    void domainPriority;
    failsWith(withoutPriority, 'domainPriority가 없습니다');
    failsWith({ ...baseAnalysis(), domainPriority: 'tie' }, 'domainPriority 값이 허용되지 않습니다');
    failsWith({ ...baseAnalysis(), domainPriority: null }, 'domainPriority 값이 허용되지 않습니다');
  });

  it('새 필드가 없는 예전 모양은 실패한다', () => {
    const { domainPriority, domainChoiceCandidates, ...oldShape } = baseAnalysis();
    void domainPriority;
    void domainChoiceCandidates;
    const result = validateSituationAnalysis(oldShape);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((error) => error.includes('domainPriority')));
    assert.ok(result.errors.some((error) => error.includes('domainChoiceCandidates')));
  });

  it('resolved인데 primaryDomain이 null이면 실패한다', () => {
    failsWith({ ...baseAnalysis(), primaryDomain: null }, 'resolved면 primaryDomain이 null이면 안 됩니다');
  });

  it('resolved인데 선택 후보가 있으면 실패한다', () => {
    failsWith(
      { ...baseAnalysis(), domainChoiceCandidates: ['financial_hardship', 'fear_uncertainty'] },
      'resolved면 domainChoiceCandidates는 비어 있어야 합니다',
    );
  });

  it('needs_choice인데 primaryDomain이 null이 아니면 실패한다', () => {
    failsWith({ ...needsChoice(), primaryDomain: 'financial_hardship' }, 'needs_choice면 primaryDomain은 null이어야 합니다');
  });

  it('needs_choice인데 후보가 정확히 2개가 아니면 실패한다', () => {
    for (const candidates of [[], ['financial_hardship'], ['financial_hardship', 'fear_uncertainty', 'grief_loss']]) {
      failsWith({ ...needsChoice(), domainChoiceCandidates: candidates }, '정확히 2개여야 합니다');
    }
  });

  it('후보가 중복되면 실패한다', () => {
    failsWith({ ...needsChoice(), domainChoiceCandidates: ['grief_loss', 'grief_loss'] }, '같은 domain이 중복');
  });

  it('후보가 표준 영역이 아니면 실패한다', () => {
    failsWith({ ...needsChoice(), domainChoiceCandidates: ['grief_loss', 'made_up_domain'] }, '표준 domain이 아닌 값');
  });

  it('후보에 other_uncovered가 있으면 실패한다', () => {
    failsWith({ ...needsChoice(), domainChoiceCandidates: ['grief_loss', 'other_uncovered'] }, 'other_uncovered은 넣을 수 없습니다');
  });

  it('needs_choice인데 secondaryDomains가 비어 있지 않으면 실패한다', () => {
    failsWith({ ...needsChoice(), secondaryDomains: ['loneliness_isolation'] }, 'needs_choice면 secondaryDomains는 비어 있어야 합니다');
  });

  it('domainChoiceCandidates가 배열이 아니면 실패한다', () => {
    failsWith({ ...baseAnalysis(), domainChoiceCandidates: 'grief_loss' }, 'domainChoiceCandidates가 배열이 아닙니다');
  });

  it('기존 primary·secondary 중복 규칙은 그대로다', () => {
    failsWith({ ...baseAnalysis(), secondaryDomains: ['grief_loss'] }, 'secondaryDomains에 primaryDomain이 중복');
    failsWith({ ...baseAnalysis(), secondaryDomains: ['loneliness_isolation', 'loneliness_isolation'] }, 'secondaryDomains에 같은 domain이 중복');
  });

  it('needs_choice여도 안전·태그·confidence 검증은 약해지지 않는다', () => {
    failsWith({ ...needsChoice(), safety: { level: 'caution', categories: [] } }, 'categories가 최소 하나');
    failsWith({ ...needsChoice(), situationTags: ['없는 태그'] }, '표준 사전에 없는 태그');
    failsWith({ ...needsChoice(), confidence: 2 }, 'confidence는 0과 1 사이');
    const withSafety = { ...needsChoice(), safety: { level: 'caution', categories: ['abuse'] } };
    assert.equal(validateSituationAnalysis(withSafety).valid, true);
  });

  it('needs_detail이어도 안전 신호 검증은 약해지지 않는다', () => {
    failsWith({ ...needsDetail(), safety: { level: 'urgent', categories: [] } }, 'categories가 최소 하나');
    const urgent = { ...needsDetail(), safety: { level: 'urgent' as const, categories: ['suicide' as const] } };
    assert.equal(validateSituationAnalysis(urgent).valid, true);
  });
});
