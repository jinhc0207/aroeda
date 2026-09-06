/**
 * 모델 생성 계약 · 테스트
 *
 * 실행: npm test
 *
 * 지키려는 것 여섯 가지.
 *
 *   1. 모델에게 필요한 것만 보여준다. 연구 결과를 통째로 넘기지 않는다.
 *   2. 사람의 이야기와 운영상의 값은 모델 입력에 오지 않는다.
 *   3. 모델이 돌려주는 선택은 번호 하나뿐이다. 좌표를 적을 자리가 없다.
 *   4. 썼거나, 못 쓰겠거나. 반쪽짜리는 없다.
 *   5. 모델이 정할 수 없는 항목은 어디에 실려 와도 거절한다.
 *   6. 초안의 모양은 조립하는 쪽의 검사기가 본다. 두 벌 만들지 않는다.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  DEFER_CONDITIONS,
  DEFER_RESPONSE_FIELDS,
  FIELD_RESPONSIBILITIES,
  FORBIDDEN_MODEL_INPUT_FIELDS,
  GENERATE_RESPONSE_FIELDS,
  GENERATION_DECISIONS,
  GENERATION_DEFER_REASONS,
  GROUNDING_POLICY,
  MODEL_DRAFT_FIELDS,
  MODEL_INPUT_EXCLUSIONS,
  MODEL_INPUT_FIELDS,
  MODEL_INPUT_PASSAGE_FIELDS,
  MODEL_SYNTHESIS_FIELDS,
  PASSAGE_SELECTION_POLICY,
  TAG_VOCABULARY_POLICY,
  USER_FACING_LANGUAGE,
  buildCandidateModelGenerationInput,
  validateCandidateModelGenerationResponse,
  type CandidateModelGenerationInput,
} from '../../supabase/functions/_shared/published-content-candidate-generation-contract.ts';
import {
  AUTHORITATIVE_CANDIDATE_FIELDS,
  CANDIDATE_DRAFT_FIELDS,
} from '../../supabase/functions/_shared/published-content-candidate-builder.ts';
import { REVIEW_CHECKS } from '../../supabase/functions/_shared/published-content-contract.ts';

const CONTRACT_PATH =
  '../../supabase/functions/_shared/published-content-candidate-generation-contract.ts';
const CONTRACT_SOURCE = readFileSync(new URL(CONTRACT_PATH, import.meta.url), 'utf8');

/* ------------------------------------------------------------------ */
/* fixture                                                             */
/* ------------------------------------------------------------------ */

const PSALM_56 = { book: 'Psalms', chapter: 56, startVerse: 3, endVerse: 4 };
const PROVERBS_3 = { book: 'Proverbs', chapter: 3, startVerse: 5, endVerse: 6 };

const passage = (reference: unknown, over: Record<string, unknown> = {}) => ({
  reference,
  additionalReferences: [],
  canonicalContext: '이 본문이 놓인 원래 흐름에 대한 연구 메모입니다.',
  theologicalContribution: '이 본문이 이 영역에 주는 신학적 기여에 대한 메모입니다.',
  domainFit: '감정이 비슷해서가 아니라 이 삶의 문제를 직접 다루기 때문입니다.',
  pastoralUse: ['위로'],
  misuseRisks: ['결과 보장으로 사용하지 않는다.'],
  distinctnessFromActiveCoverage: {
    distinct: true,
    nearestExistingDomain: 'fear_uncertainty',
    explanation: '불안 일반이 아니라 생계라는 구체적 상황을 다룹니다.',
  },
  researchConfidence: 0.6,
  sourceSupport: {
    exegesisEvidenceIds: ['src_a:e1'],
    theologyEvidenceIds: [],
    pastoralEvidenceIds: [],
    safetyEvidenceIds: [],
    exegesisSourceIds: ['src_a'],
    theologySourceIds: [],
    pastoralSourceIds: [],
    safetySourceIds: [],
  },
  ...over,
});

const researchResult = (over: Record<string, unknown> = {}) => ({
  targetDomain: 'financial_hardship',
  evidenceVersion: 4,
  prioritizerSnapshotId: `snap_${'b'.repeat(64)}`,
  researchQuestion: '성경은 이 삶의 문제를 어떤 본문에서 직접 다루는가?',
  domainBoundaries: {
    includedConcerns: ['생계 압박'],
    excludedOrAdjacentConcerns: ['일반적인 미래 불안'],
  },
  candidatePassages: [passage(PSALM_56), passage(PROVERBS_3)],
  rejectedPassages: [
    {
      reference: { book: 'Genesis', chapter: 1, startVerse: 1, endVerse: 1 },
      rejectionReason: '이 영역의 핵심 문제를 직접 다루지 않습니다.',
      riskCategory: 'adjacent_domain_only',
    },
  ],
  unresolvedQuestions: ['이 영역의 사회적 배경을 더 확인해야 합니다.'],
  evidenceSetHash: `evset_${'c'.repeat(64)}`,
  ...over,
});

const INPUT = buildCandidateModelGenerationInput(researchResult()) as CandidateModelGenerationInput;

const draft = (over: Record<string, unknown> = {}) => ({
  selectedPassageIndex: 0,
  situationTags: ['생계가 흔들림'],
  emotionTags: ['막막함'],
  spiritualQuestionTags: ['하나님의 돌보심'],
  prayerModes: ['간구'],
  pastoralFunction: ['위로'],
  contextSummary: '이 본문이 놓인 흐름을 짧게 정리한 내부 설명입니다.',
  theologicalInsight: '이 본문이 붙드는 신학적 중심을 한 문장으로 적은 것입니다.',
  userExplanation: '지금 형편이 막막할 때 이 말씀이 무엇을 말하는지 쉬운 말로 설명합니다.',
  prayerDirection: '이 말씀을 붙들고 무엇을 아뢸 수 있는지 방향을 짧게 안내합니다.',
  misuseGuards: ['형편이 곧 나아진다는 약속으로 읽지 않는다.'],
  ...over,
});

const generate = (over: Record<string, unknown> = {}) => ({
  decision: 'generate',
  draft: draft(),
  ...over,
});

const defer = (over: Record<string, unknown> = {}) => ({
  decision: 'defer',
  reason: 'needs_more_research',
  ...over,
});

const check = (value: unknown, input: CandidateModelGenerationInput = INPUT) =>
  validateCandidateModelGenerationResponse(value, input);

/* ================================================================== */
/* A. 모델에게 보여줄 것                                                */
/* ================================================================== */

describe('생성 계약 · A. 모델 입력', () => {
  it('제대로 된 연구 결과에서 입력을 만든다', () => {
    assert.notEqual(INPUT, null);
  });

  it('상위 항목이 다섯뿐이다', () => {
    assert.deepEqual(Object.keys(INPUT).sort(), [...MODEL_INPUT_FIELDS].sort());
    assert.equal(MODEL_INPUT_FIELDS.length, 5);
  });

  it('본문 하나에 보여주는 항목이 여덟뿐이다', () => {
    assert.equal(MODEL_INPUT_PASSAGE_FIELDS.length, 8);
    for (const option of INPUT.candidatePassages) {
      assert.deepEqual(Object.keys(option).sort(), [...MODEL_INPUT_PASSAGE_FIELDS].sort());
    }
  });

  it('영역과 질문과 테두리를 그대로 옮긴다', () => {
    const source = researchResult();
    assert.equal(INPUT.targetDomain, source.targetDomain);
    assert.equal(INPUT.researchQuestion, source.researchQuestion);
    assert.deepEqual(INPUT.domainBoundaries, source.domainBoundaries);
    assert.deepEqual(INPUT.unresolvedQuestions, source.unresolvedQuestions);
  });

  it('본문 개수가 그대로다', () => {
    assert.equal(INPUT.candidatePassages.length, researchResult().candidatePassages.length);
  });

  it('번호가 0부터 차례로 붙는다', () => {
    INPUT.candidatePassages.forEach((option, position) => {
      assert.equal(option.index, position);
    });
  });

  it('본문 좌표를 보여준다', () => {
    assert.deepEqual(INPUT.candidatePassages[0]?.reference, PSALM_56);
    assert.deepEqual(INPUT.candidatePassages[1]?.reference, PROVERBS_3);
  });

  it('글을 쓸 근거가 되는 연구 메모를 그대로 옮긴다', () => {
    const first = INPUT.candidatePassages[0];
    const source = researchResult().candidatePassages[0] as Record<string, unknown>;
    for (const field of ['canonicalContext', 'theologicalContribution', 'domainFit'] as const) {
      assert.equal(first?.[field], source[field], field);
    }
    assert.deepEqual(first?.pastoralUse, source.pastoralUse);
    assert.deepEqual(first?.misuseRisks, source.misuseRisks);
  });

  it('연구 결과를 고치지 않는다', () => {
    const source = researchResult();
    const before = JSON.stringify(source);
    buildCandidateModelGenerationInput(source);
    assert.equal(JSON.stringify(source), before);
  });

  it('같은 연구면 같은 입력이 나온다', () => {
    assert.deepEqual(
      buildCandidateModelGenerationInput(researchResult()),
      buildCandidateModelGenerationInput(researchResult()),
    );
  });

  it('쓸 수 없는 연구 결과면 넘기지 않는다', () => {
    const cases: unknown[] = [
      null,
      undefined,
      'x',
      3,
      [],
      researchResult({ targetDomain: '' }),
      researchResult({ targetDomain: null }),
      researchResult({ candidatePassages: [] }),
      researchResult({ candidatePassages: 'x' }),
      researchResult({ domainBoundaries: null }),
      researchResult({ unresolvedQuestions: null }),
      researchResult({ researchQuestion: null }),
      researchResult({ candidatePassages: [passage(PSALM_56, { canonicalContext: null })] }),
      researchResult({ candidatePassages: [passage(PSALM_56, { misuseRisks: 'x' })] }),
      researchResult({ candidatePassages: [null] }),
    ];
    for (const bad of cases) {
      assert.equal(buildCandidateModelGenerationInput(bad), null, JSON.stringify(bad)?.slice(0, 60));
    }
  });
});

/* ================================================================== */
/* B. 보여주지 않는 것                                                  */
/* ================================================================== */

describe('생성 계약 · B. 보여주지 않는 것', () => {
  const serialized = JSON.stringify(INPUT) ?? '';

  it('연구 지문을 보여주지 않는다', () => {
    // 보여주면 다른 연구의 지문을 붙일 길이 생긴다.
    assert.equal(serialized.includes('researchResultHash'), false);
    assert.equal(serialized.includes('rres_'), false);
  });

  it('운영상의 번호와 판번호를 보여주지 않는다', () => {
    for (const field of ['evidenceVersion', 'prioritizerSnapshotId', 'evidenceSetHash']) {
      assert.equal(serialized.includes(field), false, field);
    }
    assert.equal(serialized.includes('snap_'), false);
    assert.equal(serialized.includes('evset_'), false);
  });

  it('자료와 근거 번호를 보여주지 않는다', () => {
    for (const field of ['sourceSupport', 'sources', 'provenance', 'evidenceIds', 'src_']) {
      assert.equal(serialized.includes(field), false, field);
    }
  });

  it('연구 우선순위 판단용 값을 보여주지 않는다', () => {
    for (const field of ['distinctnessFromActiveCoverage', 'researchConfidence']) {
      assert.equal(serialized.includes(field), false, field);
    }
  });

  it('고를 수 없는 본문을 보여주지 않는다', () => {
    assert.equal(serialized.includes('rejectedPassages'), false);
    assert.equal(serialized.includes('rejectionReason'), false);
  });

  it('사람의 이야기가 오지 않는다', () => {
    for (const field of FORBIDDEN_MODEL_INPUT_FIELDS) {
      assert.equal(serialized.includes(`"${field}"`), false, field);
    }
  });

  it('통째로 펼쳐 담지 않는다', () => {
    // { ...researchResult } 를 쓰면 연구 결과에 항목이 느는 날 조용히 함께 넘어간다.
    assert.equal(/\.\.\.\s*researchResult/.test(CONTRACT_SOURCE), false);
    assert.equal(/\.\.\.\s*result\b/.test(CONTRACT_SOURCE), false);
    assert.equal(/\.\.\.\s*entry\b/.test(CONTRACT_SOURCE), false);
  });

  it('빼기로 한 것마다 이유를 적어 두었다', () => {
    for (const [field, reason] of Object.entries(MODEL_INPUT_EXCLUSIONS)) {
      assert.equal(typeof reason, 'string', field);
      assert.ok(reason.trim().length > 0, field);
    }
    for (const field of [
      'evidenceVersion',
      'prioritizerSnapshotId',
      'evidenceSetHash',
      'rejectedPassages',
      'distinctnessFromActiveCoverage',
      'researchConfidence',
      'sourceSupport',
      'researchResultHash',
    ]) {
      assert.ok(field in MODEL_INPUT_EXCLUSIONS, field);
    }
  });
});

/* ================================================================== */
/* C. 모델이 돌려줄 수 있는 것                                          */
/* ================================================================== */

describe('생성 계약 · C. 대답의 모양', () => {
  it('대답은 두 종류뿐이다', () => {
    assert.deepEqual([...GENERATION_DECISIONS], ['generate', 'defer']);
  });

  it('썼다는 대답은 통과한다', () => {
    const checked = check(generate());
    assert.deepEqual(checked.errors, []);
    assert.equal(checked.valid, true);
  });

  it('못 쓰겠다는 대답도 통과한다', () => {
    const checked = check(defer());
    assert.deepEqual(checked.errors, []);
    assert.equal(checked.valid, true);
  });

  it('첫 번호와 마지막 번호를 모두 고를 수 있다', () => {
    const last = INPUT.candidatePassages.length - 1;
    assert.equal(check(generate({ draft: draft({ selectedPassageIndex: 0 }) })).valid, true);
    assert.equal(check(generate({ draft: draft({ selectedPassageIndex: last }) })).valid, true);
  });

  it('대답 종류가 없거나 모르는 값이면 막는다', () => {
    for (const bad of [undefined, null, '', 'GENERATE', 'skip', 'retry', 3, {}]) {
      const value = { ...generate() } as Record<string, unknown>;
      if (bad === undefined) delete value.decision;
      else value.decision = bad;
      assert.equal(check(value).valid, false, String(bad));
    }
  });

  it('모르는 종류는 종류를 보는 자리에서 막는다', () => {
    // 뒤쪽 검사가 우연히 대신 잡아 주는 것에 기대지 않는다.
    // 어느 자리가 막았는지까지 확인해야, 그 자리를 없앴을 때 드러난다.
    const checked = check({ decision: 'skip', reason: 'needs_more_research' });
    assert.equal(checked.valid, false);
    assert.ok(checked.errors.some((e) => e.includes('대답 종류를 알 수 없습니다')), checked.errors.join(' / '));
  });

  it('썼다면서 초안이 없으면 막는다', () => {
    const value = { ...generate() } as Record<string, unknown>;
    delete value.draft;
    const checked = check(value);
    assert.equal(checked.valid, false);
    assert.ok(checked.errors.some((e) => e.includes('빠진 항목입니다')), checked.errors.join(' / '));
  });

  it('썼다면서 보류 이유를 담으면 막는다', () => {
    assert.equal(check(generate({ reason: 'needs_more_research' })).valid, false);
  });

  it('못 쓰겠다면서 이유가 없으면 막는다', () => {
    const value = { ...defer() } as Record<string, unknown>;
    delete value.reason;
    const checked = check(value);
    assert.equal(checked.valid, false);
    assert.ok(checked.errors.some((e) => e.includes('빠진 항목입니다')), checked.errors.join(' / '));
  });

  it('못 쓰겠다면서 초안을 담으면 막는다', () => {
    assert.equal(check(defer({ draft: draft() })).valid, false);
  });

  it('정해지지 않은 보류 이유는 막는다', () => {
    for (const bad of ['unknown', 'model_error', 'timeout', '', null, 3]) {
      assert.equal(check(defer({ reason: bad })).valid, false, String(bad));
    }
  });

  it('보류 이유는 하나뿐이다', () => {
    assert.deepEqual([...GENERATION_DEFER_REASONS], ['needs_more_research']);
  });

  it('대답에 낯선 항목이 있으면 막는다', () => {
    assert.equal(check(generate({ note: '내부 메모' })).valid, false);
    assert.equal(check(defer({ note: '내부 메모' })).valid, false);
  });

  it('객체가 아니면 예외를 던지지 않고 막는다', () => {
    for (const bad of [null, undefined, 'x', 3, []]) {
      assert.equal(check(bad).valid, false, String(bad));
    }
  });

  it('대답 항목이 종류마다 정해져 있다', () => {
    assert.deepEqual([...GENERATE_RESPONSE_FIELDS], ['decision', 'draft']);
    assert.deepEqual([...DEFER_RESPONSE_FIELDS], ['decision', 'reason']);
  });
});

/* ================================================================== */
/* D. 모델이 정할 수 없는 것                                            */
/* ================================================================== */

describe('생성 계약 · D. 권위 항목', () => {
  it('대답 바깥에 실어 보내면 막는다', () => {
    for (const field of AUTHORITATIVE_CANDIDATE_FIELDS) {
      const checked = check(generate({ [field]: 'x' }));
      assert.equal(checked.valid, false, field);
      assert.ok(checked.errors.some((e) => e.includes('모델이 정할 수 없는 항목입니다')), field);
    }
  });

  it('초안 안에 실어 보내도 막는다', () => {
    for (const field of AUTHORITATIVE_CANDIDATE_FIELDS) {
      const checked = check(generate({ draft: draft({ [field]: 'x' }) }));
      assert.equal(checked.valid, false, field);
    }
  });

  it('못 쓰겠다는 대답에 실어 보내도 막는다', () => {
    for (const field of AUTHORITATIVE_CANDIDATE_FIELDS) {
      assert.equal(check(defer({ [field]: 'x' })).valid, false, field);
    }
  });

  it('본문 좌표를 돌려줄 자리가 없다', () => {
    // 좌표를 적게 하면 한 글자만 틀려도 다른 본문이 되고, 알아채기 어렵다.
    for (const field of ['book', 'chapter', 'startVerse', 'endVerse', 'verse', 'passages']) {
      assert.equal(check(generate({ draft: draft({ [field]: 'Genesis' }) })).valid, false, field);
      assert.equal(check(generate({ [field]: 'Genesis' })).valid, false, field);
    }
  });

  it('본문 이름을 지어낼 자리가 없다', () => {
    assert.equal(check(generate({ draft: draft({ referenceLabel: '창세기 1:1' }) })).valid, false);
    assert.equal(check(generate({ referenceLabel: '창세기 1:1' })).valid, false);
  });

  it('조용히 지우지 않고 거절한다', () => {
    const checked = check(generate({ draft: draft({ targetDomain: 'other_domain' }) }));
    assert.equal(checked.valid, false);
    assert.ok(checked.errors.length > 0);
  });
});

/* ================================================================== */
/* E. 본문 선택                                                         */
/* ================================================================== */

describe('생성 계약 · E. 본문 선택', () => {
  it('보여 주지 않은 번호는 막는다', () => {
    const beyond = INPUT.candidatePassages.length;
    for (const index of [beyond, beyond + 1, 99]) {
      const checked = check(generate({ draft: draft({ selectedPassageIndex: index }) }));
      assert.equal(checked.valid, false, String(index));
    }
  });

  it('음수와 소수와 글자는 막는다', () => {
    for (const bad of [-1, 0.5, '0', NaN, null]) {
      assert.equal(
        check(generate({ draft: draft({ selectedPassageIndex: bad }) })).valid,
        false,
        String(bad),
      );
    }
  });

  it('본문이 하나뿐이면 0만 고를 수 있다', () => {
    const single = buildCandidateModelGenerationInput(
      researchResult({ candidatePassages: [passage(PSALM_56)] }),
    ) as CandidateModelGenerationInput;

    assert.equal(check(generate({ draft: draft({ selectedPassageIndex: 0 }) }), single).valid, true);
    assert.equal(check(generate({ draft: draft({ selectedPassageIndex: 1 }) }), single).valid, false);
  });

  it('목록 순서를 좋은 순서로 보지 않는다', () => {
    assert.equal(PASSAGE_SELECTION_POLICY.listOrderIsRanking, false);
  });

  it('모델이 돌려주는 선택 값은 번호 하나뿐이다', () => {
    assert.equal(PASSAGE_SELECTION_POLICY.modelReturns, 'selectedPassageIndex');
    assert.equal(PASSAGE_SELECTION_POLICY.modelMayReturnCoordinates, false);
  });

  it('고를 만한 것이 없으면 못 쓰겠다고 말한다', () => {
    assert.equal(PASSAGE_SELECTION_POLICY.noSuitablePassageBecomesDefer, true);
    assert.equal(PASSAGE_SELECTION_POLICY.criteria.length, 5);
  });
});

/* ================================================================== */
/* F. 못 쓰겠다는 대답                                                  */
/* ================================================================== */

describe('생성 계약 · F. 보류', () => {
  it('보류에는 초안도 번호도 글도 태그도 없다', () => {
    const value = defer();
    assert.deepEqual(Object.keys(value).sort(), [...DEFER_RESPONSE_FIELDS].sort());

    const serialized = JSON.stringify(value) ?? '';
    for (const field of [...CANDIDATE_DRAFT_FIELDS, 'draft']) {
      assert.equal(serialized.includes(field), false, field);
    }
  });

  it('보류가 반쪽짜리 글이 아니라는 것을 적어 두었다', () => {
    assert.ok(
      CONTRACT_SOURCE.includes('못 쓰겠다는 대답에는 초안이 없다. 조립하는 쪽으로 넘기지 않는다.'),
    );
  });

  it('언제 보류하는지 적어 두었다', () => {
    assert.ok(DEFER_CONDITIONS.length >= 5);
    for (const condition of DEFER_CONDITIONS) {
      assert.equal(typeof condition, 'string');
      assert.ok(condition.trim().length > 0);
    }
  });

  it('근거가 모자라면 지어내지 않는다', () => {
    assert.equal(GROUNDING_POLICY.insufficientEvidenceBecomesDefer, true);
  });
});

/* ================================================================== */
/* G. 무엇을 근거로 쓰는가                                              */
/* ================================================================== */

describe('생성 계약 · G. 근거', () => {
  it('연구 결과 밖으로 넓히지 않는다', () => {
    assert.equal(GROUNDING_POLICY.expandBeyondResearchResult, false);
  });

  it('모델이 아는 것으로 빈자리를 메우지 않는다', () => {
    assert.equal(GROUNDING_POLICY.fillGapsWithModelKnowledge, false);
  });

  it('본문은 보여 준 것 중에서만 고른다', () => {
    assert.equal(GROUNDING_POLICY.selectOnlyFromCandidatePassages, true);
  });

  it('성경 참조를 새로 만들지 않는다', () => {
    assert.equal(GROUNDING_POLICY.mayCreateNewScriptureReference, false);
  });

  it('성경 본문 문장을 옮겨 적지 않는다', () => {
    // 본문의 주인은 성경 데이터다. 모델이 쓰는 것이 아니다.
    assert.equal(GROUNDING_POLICY.mayQuoteScriptureText, false);
  });
});

/* ================================================================== */
/* H. 태그 사전                                                         */
/* ================================================================== */

describe('생성 계약 · H. 태그', () => {
  it('기존 사전 안의 값으로 제한하지 않는다', () => {
    // 앞 계약이 일부러 그렇게 했다. 여기서 뒤집지 않는다.
    assert.equal(TAG_VOCABULARY_POLICY.mode, 'open');
    assert.equal(TAG_VOCABULARY_POLICY.restrictToExistingTaxonomy, false);
  });

  it('새 사전을 만들지 않는다', () => {
    assert.equal(TAG_VOCABULARY_POLICY.createsNewVocabulary, false);
    assert.equal(CONTRACT_SOURCE.includes('analysis-taxonomy.ts'), false);
    assert.equal(CONTRACT_SOURCE.includes('SITUATION_TAGS'), false);
    assert.equal(CONTRACT_SOURCE.includes('isKnownTag'), false);
  });

  it('태그가 맞는지는 사람이 본다', () => {
    assert.equal(TAG_VOCABULARY_POLICY.judgedBy, 'taggingFit');
    assert.ok((REVIEW_CHECKS as readonly string[]).includes('taggingFit'));
  });

  it('기존 사전에 없는 태그도 통과한다', () => {
    const checked = check(
      generate({ draft: draft({ situationTags: ['이 사전에 아직 없는 새 상황'] }) }),
    );
    assert.equal(checked.valid, true);
  });
});

/* ================================================================== */
/* I. 열 항목의 역할                                                    */
/* ================================================================== */

describe('생성 계약 · I. 항목의 역할', () => {
  it('모델이 쓰는 항목이 열 개다', () => {
    assert.equal(MODEL_SYNTHESIS_FIELDS.length, 10);
  });

  it('초안 열하나에서 번호를 빼면 열이 된다', () => {
    assert.equal(MODEL_DRAFT_FIELDS.length, 11);
    const withoutSelection = MODEL_DRAFT_FIELDS.filter((f) => f !== 'selectedPassageIndex');
    assert.deepEqual([...withoutSelection].sort(), [...MODEL_SYNTHESIS_FIELDS].sort());
  });

  it('열 항목 모두 역할이 적혀 있다', () => {
    assert.deepEqual(
      Object.keys(FIELD_RESPONSIBILITIES).sort(),
      [...MODEL_SYNTHESIS_FIELDS].sort(),
    );
  });

  it('각 역할에 하는 일과 하지 않는 일이 적혀 있다', () => {
    for (const [field, meaning] of Object.entries(FIELD_RESPONSIBILITIES)) {
      assert.ok(meaning.purpose.trim().length > 0, field);
      assert.ok(meaning.notFor.trim().length > 0, field);
    }
  });

  it('사람이 보는 항목 이름을 그대로 쓴다', () => {
    // 새 말을 만들면 검토 화면과 여기가 서로 다른 말을 하게 된다.
    for (const [field, meaning] of Object.entries(FIELD_RESPONSIBILITIES)) {
      assert.ok(
        (REVIEW_CHECKS as readonly string[]).includes(meaning.reviewedBy),
        `${field}: ${meaning.reviewedBy}`,
      );
    }
  });

  it('기도 방향과 기도문의 역할을 나눈다', () => {
    assert.ok(FIELD_RESPONSIBILITIES.prayerDirection.notFor.includes('기도문'));
  });

  it('문맥 설명과 신학적 의미의 역할을 나눈다', () => {
    assert.ok(FIELD_RESPONSIBILITIES.contextSummary.notFor.includes('문맥'));
    assert.ok(FIELD_RESPONSIBILITIES.theologicalInsight.notFor.includes('문맥'));
  });

  it('사용자에게 보여줄 글의 언어가 한국어다', () => {
    assert.equal(USER_FACING_LANGUAGE, 'ko');
  });
});

/* ================================================================== */
/* J. 이 계약이 하지 않는 일                                            */
/* ================================================================== */

describe('생성 계약 · J. 경계', () => {
  it('프롬프트가 없다', () => {
    for (const banned of ['systemPrompt', 'userPrompt', 'PROMPT', '당신은 ', 'You are ']) {
      assert.equal(CONTRACT_SOURCE.includes(banned), false, banned);
    }
  });

  it('모델을 부르지 않는다', () => {
    for (const banned of [
      'openai',
      'OpenAI',
      'chat.completions',
      'responses.create',
      'temperature',
      'max_tokens',
      'maxTokens',
      'reasoning_effort',
      'gpt-',
    ]) {
      assert.equal(CONTRACT_SOURCE.includes(banned), false, banned);
    }
  });

  it('바깥을 부르거나 표를 열지 않는다', () => {
    for (const banned of [
      'fetch(',
      'createClient',
      'supabase',
      'service_role',
      'Deno.env',
      'process.env',
      'store_published_content_candidate',
    ]) {
      assert.equal(CONTRACT_SOURCE.includes(banned), false, banned);
    }
  });

  it('부를 때마다 같은 답을 낸다', () => {
    for (const banned of ['Date.now', 'Math.random', 'randomUUID', 'new Date(']) {
      assert.equal(CONTRACT_SOURCE.includes(banned), false, banned);
    }
  });

  it('지문을 만들지 않는다', () => {
    for (const banned of ['crypto', 'digest', 'SHA-256', 'stableStringify', 'computeResearch']) {
      assert.equal(CONTRACT_SOURCE.includes(banned), false, banned);
    }
  });

  it('초안 검사기를 베끼지 않고 그대로 쓴다', () => {
    assert.ok(CONTRACT_SOURCE.includes('validateCandidateGenerationDraft'));
    assert.ok(CONTRACT_SOURCE.includes("from './published-content-candidate-builder.ts'"));
  });

  it('초안 항목 목록을 두 번째로 정의하지 않는다', () => {
    // 두 벌이 되면 언젠가 서로 달라진다.
    // 같은 값을 가리키는 것이 아니라 같은 것이어야 한다.
    assert.equal(MODEL_DRAFT_FIELDS, CANDIDATE_DRAFT_FIELDS);

    // 목록으로 다시 적은 자리가 없는지도 본다.
    // 이름을 언급하는 것(modelReturns 같은)은 목록이 아니므로 줄 전체를 본다.
    const listLine = CONTRACT_SOURCE.split('\n').find(
      (line) => line.trim() === "'selectedPassageIndex',",
    );
    assert.equal(listLine, undefined, listLine ?? '');
  });

  it('가져오는 곳이 모두 같은 저장소의 계약이다', () => {
    const specifiers = [...CONTRACT_SOURCE.matchAll(/from '([^']+)'/g)].map((m) => m[1] as string);
    assert.ok(specifiers.length > 0);
    for (const path of specifiers) {
      assert.ok(path.startsWith('./'), path);
    }
  });

  it('다루지 않는 것을 적어 두었다', () => {
    const text = (
      CONTRACT_SOURCE.match(/NOT_IN_THIS_CONTRACT = \[([\s\S]*?)\] as const;/)?.[1] ?? ''
    );
    assert.ok(text.includes('프롬프트'));
    assert.ok(text.includes('모델 이름'));
  });
});
