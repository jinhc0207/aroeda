/**
 * 검토 대상 글 조립 · 테스트
 *
 * 실행: npm test
 *
 * 지키려는 것 여섯 가지.
 *
 *   1. 모델이 정할 수 없는 다섯 항목은 코드가 정한다.
 *   2. 모델이 그것을 보내오면 무시하지 않고 거절한다.
 *   3. 본문은 연구가 올린 후보에서 번호로 고른다. 좌표를 모델이 적지 않는다.
 *   4. 본문 이름은 성경 데이터로 만든다. 모델이 지어내지 않는다.
 *   5. 같은 입력이면 언제나 같은 글과 같은 지문이 나온다.
 *   6. 어긋나면 고쳐서 통과시키지 않고 멈춘다.
 *
 * fixture는 지어내지 않는다.
 * 본문 좌표는 실제 성경 데이터에 있는 위치를 쓰고,
 * 지문도 실제 함수로 계산해 대조한다.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  AUTHORITATIVE_CANDIDATE_FIELDS,
  CANDIDATE_BUILDER_ERROR_CODES,
  CANDIDATE_DRAFT_FIELDS,
  buildPublishedContentCandidate,
  validateCandidateGenerationDraft,
  type CandidateGenerationDraft,
} from '../../supabase/functions/_shared/published-content-candidate-builder.ts';
import {
  CANDIDATE_FIELDS,
  computePublishedContentCandidateHash,
  validatePublishedContentCandidate,
} from '../../supabase/functions/_shared/published-content-contract.ts';
import { getLastVerse } from '../../supabase/functions/_shared/bible-reference.ts';
import { computeResearchResultHash } from '../../supabase/functions/_shared/research-result-store-contract.ts';

const BUILDER_PATH = '../../supabase/functions/_shared/published-content-candidate-builder.ts';
const BUILDER_SOURCE = readFileSync(new URL(BUILDER_PATH, import.meta.url), 'utf8');

/* ------------------------------------------------------------------ */
/* fixture                                                             */
/* ------------------------------------------------------------------ */

/** 시편 56:3–4. 한 장 안에서 끝난다. */
const PSALM_56 = { book: 'Psalms', chapter: 56, startVerse: 3, endVerse: 4 };

/** 잠언 3:5–6. 두 번째 후보. */
const PROVERBS_3 = { book: 'Proverbs', chapter: 3, startVerse: 5, endVerse: 6 };

/** 요한일서 1:8–2:2. 장을 넘어간다. 앞이 1장 마지막 절에서 끝난다. */
const FIRST_JOHN_1 = { book: '1John', chapter: 1, startVerse: 8, endVerse: 10 };
const FIRST_JOHN_2 = { book: '1John', chapter: 2, startVerse: 1, endVerse: 2 };

/**
 * 연구 결과.
 *
 * 조립에 실제로 쓰이는 것은 영역과 본문 후보 목록뿐이다.
 * 나머지 항목은 이 계층이 보지 않는다.
 */
const researchResult = (overrides: Record<string, unknown> = {}) =>
  ({
    targetDomain: 'financial_hardship',
    evidenceVersion: 4,
    prioritizerSnapshotId: `snap_${'b'.repeat(64)}`,
    researchQuestion: '성경은 이 삶의 문제를 어떤 본문에서 직접 다루는가?',
    domainBoundaries: { includedConcerns: ['생계 압박'], excludedOrAdjacentConcerns: [] },
    candidatePassages: [
      { reference: PSALM_56, additionalReferences: [] },
      { reference: PROVERBS_3, additionalReferences: [] },
      { reference: FIRST_JOHN_1, additionalReferences: [FIRST_JOHN_2] },
    ],
    rejectedPassages: [],
    unresolvedQuestions: [],
    evidenceSetHash: `evset_${'c'.repeat(64)}`,
    ...overrides,
  }) as never;

const draft = (overrides: Record<string, unknown> = {}) =>
  ({
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
    ...overrides,
  }) as unknown;

/**
 * 연구 결과의 진짜 지문을 구한다.
 *
 * 지어낸 값을 쓰지 않는다. 지문은 그 연구의 신원이라
 * 아무 값이나 붙이면 조립하는 쪽이 막아야 정상이다.
 */
const hashOf = async (result: unknown): Promise<string> => {
  try {
    return await computeResearchResultHash(result as never);
  } catch {
    // 애초에 연구 결과가 아닌 값을 넣어 보는 시험들. 조립 전에 걸린다.
    return `rres_${'0'.repeat(64)}`;
  }
};

/** 기본 fixture의 진짜 지문. */
const RESEARCH_HASH = await hashOf(researchResult());

/**
 * 조립을 부른다.
 *
 * 지문은 마지막에 실린 연구 결과에서 계산한다.
 * 미리 정해 두면, 연구 결과를 바꾼 시험이 정작 보려던 규칙이 아니라
 * 지문 검사에 걸려서 통과해 버린다. 지문 자체를 시험할 때만 따로 지정한다.
 */
const build = async (overrides: Record<string, unknown> = {}) => {
  const merged = {
    researchResult: researchResult(),
    draft: draft(),
    ...overrides,
  } as Record<string, unknown>;

  if (!('researchResultHash' in overrides)) {
    merged.researchResultHash = await hashOf(merged.researchResult);
  }

  return buildPublishedContentCandidate(merged as never);
};

/* ================================================================== */
/* A. 모델이 정하는 것과 정하지 않는 것                                 */
/* ================================================================== */

describe('글 조립 · A. 누가 무엇을 정하는가', () => {
  it('초안의 항목은 열한 개다', () => {
    assert.equal(CANDIDATE_DRAFT_FIELDS.length, 11);
    assert.deepEqual(
      [...CANDIDATE_DRAFT_FIELDS],
      [
        'selectedPassageIndex',
        'situationTags',
        'emotionTags',
        'spiritualQuestionTags',
        'prayerModes',
        'pastoralFunction',
        'contextSummary',
        'theologicalInsight',
        'userExplanation',
        'prayerDirection',
        'misuseGuards',
      ],
    );
  });

  it('글의 항목은 열다섯 개다', () => {
    // 초안 열하나와 헷갈리지 않아야 한다.
    assert.equal(CANDIDATE_FIELDS.length, 15);
  });

  it('모델이 정할 수 없는 것이 여섯이다', () => {
    assert.deepEqual(
      [...AUTHORITATIVE_CANDIDATE_FIELDS],
      [
        'researchResultHash',
        'targetDomain',
        'passage',
        'additionalPassages',
        'referenceLabel',
        'candidateHash',
      ],
    );
  });

  it('초안과 코드가 정하는 것이 겹치지 않는다', () => {
    for (const field of AUTHORITATIVE_CANDIDATE_FIELDS) {
      assert.equal(
        (CANDIDATE_DRAFT_FIELDS as readonly string[]).includes(field),
        false,
        field,
      );
    }
  });

  it('초안 열 개와 코드 다섯 개를 합치면 글의 열다섯이 된다', () => {
    const fromDraft = CANDIDATE_DRAFT_FIELDS.filter((f) => f !== 'selectedPassageIndex');
    const fromCode = AUTHORITATIVE_CANDIDATE_FIELDS.filter((f) => f !== 'candidateHash');
    assert.equal(fromDraft.length, 10);
    assert.equal(fromCode.length, 5);
    assert.deepEqual([...fromDraft, ...fromCode].sort(), [...CANDIDATE_FIELDS].sort());
  });
});

/* ================================================================== */
/* B. 제대로 만들어지는가                                               */
/* ================================================================== */

describe('글 조립 · B. 정상', () => {
  it('제대로 된 값이면 글이 만들어진다', async () => {
    const outcome = await build();
    assert.equal(outcome.ok, true);
  });

  it('만들어진 글의 항목이 계약과 정확히 같다', async () => {
    const outcome = await build();
    assert.ok(outcome.ok);
    assert.deepEqual(Object.keys(outcome.candidate).sort(), [...CANDIDATE_FIELDS].sort());
  });

  it('연구 지문을 그대로 옮긴다', async () => {
    const outcome = await build();
    assert.ok(outcome.ok);
    assert.equal(outcome.candidate.researchResultHash, RESEARCH_HASH);
  });

  it('연구가 다룬 영역을 그대로 옮긴다', async () => {
    const outcome = await build();
    assert.ok(outcome.ok);
    assert.equal(outcome.candidate.targetDomain, 'financial_hardship');
  });

  it('0번을 고르면 첫 본문이 온다', async () => {
    const outcome = await build();
    assert.ok(outcome.ok);
    assert.deepEqual(outcome.candidate.passage, PSALM_56);
    assert.deepEqual(outcome.candidate.additionalPassages, []);
  });

  it('다른 번호를 고르면 그 본문이 온다', async () => {
    const outcome = await build({ draft: draft({ selectedPassageIndex: 1 }) });
    assert.ok(outcome.ok);
    assert.deepEqual(outcome.candidate.passage, PROVERBS_3);
  });

  it('덧붙인 본문이 있으면 함께 온다', async () => {
    const outcome = await build({ draft: draft({ selectedPassageIndex: 2 }) });
    assert.ok(outcome.ok);
    assert.deepEqual(outcome.candidate.passage, FIRST_JOHN_1);
    assert.deepEqual(outcome.candidate.additionalPassages, [FIRST_JOHN_2]);
  });

  it('초안의 열 항목이 그대로 들어간다', async () => {
    const outcome = await build();
    assert.ok(outcome.ok);
    const source = draft() as CandidateGenerationDraft;

    for (const field of CANDIDATE_DRAFT_FIELDS) {
      if (field === 'selectedPassageIndex') continue;
      assert.deepEqual(
        outcome.candidate[field as keyof typeof outcome.candidate],
        source[field as keyof CandidateGenerationDraft],
        field,
      );
    }
  });

  it('고른 번호는 글에 남지 않는다', async () => {
    const outcome = await build();
    assert.ok(outcome.ok);
    assert.equal('selectedPassageIndex' in outcome.candidate, false);
    assert.equal(JSON.stringify(outcome.candidate).includes('selectedPassageIndex'), false);
  });

  it('지문이 pcand_ 로 시작한다', async () => {
    const outcome = await build();
    assert.ok(outcome.ok);
    assert.match(outcome.candidateHash, /^pcand_[0-9a-f]{64}$/);
  });

  it('지문은 앞 계약이 계산한 값과 같다', async () => {
    const outcome = await build();
    assert.ok(outcome.ok);
    const expected = await computePublishedContentCandidateHash(outcome.candidate);
    assert.equal(outcome.candidateHash, expected);
  });

  it('만들어진 글은 앞 계약의 검사기를 통과한다', async () => {
    // 조립하는 쪽이 검사기를 우회하지 않는다.
    const outcome = await build();
    assert.ok(outcome.ok);
    const checked = validatePublishedContentCandidate(outcome.candidate);
    assert.deepEqual(checked.errors, []);
    assert.equal(checked.valid, true);
  });

  it('연구 결과와 초안을 고치지 않는다', async () => {
    const research = researchResult();
    const modelDraft = draft();
    const researchBefore = JSON.stringify(research);
    const draftBefore = JSON.stringify(modelDraft);

    await buildPublishedContentCandidate({
      researchResultHash: await hashOf(research),
      researchResult: research,
      draft: modelDraft,
    } as never);

    assert.equal(JSON.stringify(research), researchBefore);
    assert.equal(JSON.stringify(modelDraft), draftBefore);
  });
});

/* ================================================================== */
/* C. 본문 이름                                                         */
/* ================================================================== */

describe('글 조립 · C. 본문 이름', () => {
  it('본문에서 이름을 만든다', async () => {
    const outcome = await build();
    assert.ok(outcome.ok);
    assert.equal(outcome.candidate.referenceLabel, '시편 56:3–4');
  });

  it('다른 본문이면 다른 이름이 나온다', async () => {
    const outcome = await build({ draft: draft({ selectedPassageIndex: 1 }) });
    assert.ok(outcome.ok);
    assert.equal(outcome.candidate.referenceLabel, '잠언 3:5–6');
  });

  it('장을 넘어가는 본문도 만든다', async () => {
    // 앞이 그 장 마지막 절에서 끝난다는 것이 성경 데이터로 확인된다.
    assert.equal(getLastVerse('1John', 1), FIRST_JOHN_1.endVerse);

    const outcome = await build({ draft: draft({ selectedPassageIndex: 2 }) });
    assert.ok(outcome.ok);
    assert.equal(outcome.candidate.referenceLabel, '요한일서 1:8–2:2');
  });

  it('모델이 이름을 넣을 통로가 없다', async () => {
    // 초안에 referenceLabel 을 실으면 글이 만들어지지 않는다.
    const outcome = await build({ draft: draft({ referenceLabel: '창세기 1:1' }) });
    assert.equal(outcome.ok, false);
    assert.ok(!outcome.ok && outcome.code === 'INVALID_MODEL_DRAFT');
  });

  it('이름을 만들지 못하면 모델에게 맡기지 않고 멈춘다', async () => {
    // 떨어져 있는 두 곳은 이어 적는 형식이 정해진 적이 없다.
    const apart = {
      reference: { book: 'Psalms', chapter: 100, startVerse: 1, endVerse: 2 },
      additionalReferences: [{ book: 'Psalms', chapter: 103, startVerse: 1, endVerse: 2 }],
    };
    const outcome = await build({
      researchResult: researchResult({ candidatePassages: [apart] }),
    });

    assert.equal(outcome.ok, false);
    assert.ok(!outcome.ok && outcome.code === 'REFERENCE_LABEL_UNFORMATTABLE');
  });

  it('성경에 없는 본문이면 이름을 만들지 않는다', async () => {
    const nowhere = {
      reference: { book: 'Psalms', chapter: 999, startVerse: 1, endVerse: 1 },
      additionalReferences: [],
    };
    const outcome = await build({
      researchResult: researchResult({ candidatePassages: [nowhere] }),
    });

    assert.equal(outcome.ok, false);
    assert.ok(!outcome.ok && outcome.code === 'REFERENCE_LABEL_UNFORMATTABLE');
  });
});

/* ================================================================== */
/* D. 초안을 거절하는 경우                                              */
/* ================================================================== */

describe('글 조립 · D. 초안 거절', () => {
  it('모델이 정할 수 없는 항목을 보내면 거절한다', async () => {
    // 무시하고 지워 버리지 않는다.
    for (const field of AUTHORITATIVE_CANDIDATE_FIELDS) {
      const outcome = await build({ draft: draft({ [field]: 'x' }) });
      assert.equal(outcome.ok, false, field);
      assert.ok(!outcome.ok && outcome.code === 'INVALID_MODEL_DRAFT', field);
      assert.ok(
        !outcome.ok && outcome.errors.some((e) => e.includes('모델이 정할 수 없는 항목입니다')),
        field,
      );
    }
  });

  it('계약에 없는 항목을 보내면 거절한다', async () => {
    const outcome = await build({ draft: draft({ modelNote: '내부 메모' }) });
    assert.equal(outcome.ok, false);
    assert.ok(!outcome.ok && outcome.errors.some((e) => e.includes('초안에 없는 항목입니다')));
  });

  it('빠진 항목이 있으면 거절한다', async () => {
    for (const field of CANDIDATE_DRAFT_FIELDS) {
      const incomplete = draft() as Record<string, unknown>;
      delete incomplete[field];
      const outcome = await build({ draft: incomplete });
      assert.equal(outcome.ok, false, field);
      assert.ok(!outcome.ok && outcome.errors.some((e) => e.includes('빠진 항목입니다')), field);
    }
  });

  it('고른 번호가 정수가 아니면 거절한다', async () => {
    for (const bad of ['0', 0.5, NaN, Infinity, null, undefined, [0], {}]) {
      const outcome = await build({ draft: draft({ selectedPassageIndex: bad }) });
      assert.equal(outcome.ok, false, String(bad));
      assert.ok(!outcome.ok && outcome.code === 'INVALID_MODEL_DRAFT', String(bad));
    }
  });

  it('고른 번호가 음수면 거절한다', async () => {
    const outcome = await build({ draft: draft({ selectedPassageIndex: -1 }) });
    assert.equal(outcome.ok, false);
    assert.ok(!outcome.ok && outcome.code === 'INVALID_MODEL_DRAFT');
  });

  it('연구가 올리지 않은 번호면 거절한다', async () => {
    // 후보가 셋이므로 3은 없는 번호다.
    for (const index of [3, 10, 999]) {
      const outcome = await build({ draft: draft({ selectedPassageIndex: index }) });
      assert.equal(outcome.ok, false, String(index));
      assert.ok(!outcome.ok && outcome.code === 'SELECTED_PASSAGE_OUT_OF_RANGE', String(index));
    }
  });

  it('태그가 글자 목록이 아니면 거절한다', async () => {
    for (const bad of ['생계', 3, null, [1, 2], [{}]]) {
      const outcome = await build({ draft: draft({ situationTags: bad }) });
      assert.equal(outcome.ok, false, JSON.stringify(bad));
      assert.ok(!outcome.ok && outcome.code === 'INVALID_MODEL_DRAFT', JSON.stringify(bad));
    }
  });

  it('글이 글자가 아니면 거절한다', async () => {
    for (const bad of [null, 3, {}, ['글']]) {
      const outcome = await build({ draft: draft({ userExplanation: bad }) });
      assert.equal(outcome.ok, false, JSON.stringify(bad));
      assert.ok(!outcome.ok && outcome.code === 'INVALID_MODEL_DRAFT', JSON.stringify(bad));
    }
  });

  it('오용을 막는 문구가 목록이 아니면 거절한다', async () => {
    const outcome = await build({ draft: draft({ misuseGuards: '읽지 않는다.' }) });
    assert.equal(outcome.ok, false);
    assert.ok(!outcome.ok && outcome.code === 'INVALID_MODEL_DRAFT');
  });

  it('초안이 객체가 아니면 거절한다', async () => {
    for (const bad of [null, undefined, 'x', 3, []]) {
      const outcome = await build({ draft: bad });
      assert.equal(outcome.ok, false, String(bad));
      assert.ok(!outcome.ok && outcome.code === 'INVALID_MODEL_DRAFT', String(bad));
    }
  });

  it('모양은 맞지만 계약을 어기는 글은 앞 검사기가 막는다', async () => {
    // 빈 글자는 초안 검사기를 지나가지만 글의 검사기가 막는다.
    const outcome = await build({ draft: draft({ userExplanation: '' }) });
    assert.equal(outcome.ok, false);
    assert.ok(!outcome.ok && outcome.code === 'CANDIDATE_VALIDATION_FAILED');
  });

  it('오용을 막는 문구가 비어 있으면 막는다', async () => {
    const outcome = await build({ draft: draft({ misuseGuards: [] }) });
    assert.equal(outcome.ok, false);
    assert.ok(!outcome.ok && outcome.code === 'CANDIDATE_VALIDATION_FAILED');
  });
});

/* ================================================================== */
/* E. 저장된 값을 거절하는 경우                                         */
/* ================================================================== */

describe('글 조립 · E. 연구 입력 거절', () => {
  it('연구 지문의 모양이 틀리면 거절한다', async () => {
    for (const bad of ['rres_짧음', 'pcand_' + 'a'.repeat(64), '', null, 3]) {
      const outcome = await build({ researchResultHash: bad });
      assert.equal(outcome.ok, false, String(bad));
      assert.ok(!outcome.ok && outcome.code === 'INVALID_RESEARCH_INPUT', String(bad));
    }
  });

  it('연구 결과가 객체가 아니면 거절한다', async () => {
    for (const bad of [null, 'x', 3, []]) {
      const outcome = await build({ researchResult: bad });
      assert.equal(outcome.ok, false, String(bad));
      assert.ok(!outcome.ok && outcome.code === 'INVALID_RESEARCH_INPUT', String(bad));
    }
  });

  it('본문 후보가 없으면 거절한다', async () => {
    for (const bad of [[], null, 'x']) {
      const outcome = await build({
        researchResult: researchResult({ candidatePassages: bad }),
      });
      assert.equal(outcome.ok, false, JSON.stringify(bad));
      assert.ok(!outcome.ok && outcome.code === 'INVALID_RESEARCH_INPUT', JSON.stringify(bad));
    }
  });

  it('영역이 없으면 거절한다', async () => {
    const outcome = await build({ researchResult: researchResult({ targetDomain: null }) });
    assert.equal(outcome.ok, false);
    assert.ok(!outcome.ok && outcome.code === 'INVALID_RESEARCH_INPUT');
  });

  it('연구가 정한 영역이 목록에 없으면 앞 검사기가 막는다', async () => {
    const outcome = await build({
      researchResult: researchResult({ targetDomain: 'made_up_domain' }),
    });
    assert.equal(outcome.ok, false);
    assert.ok(!outcome.ok && outcome.code === 'CANDIDATE_VALIDATION_FAILED');
  });

  it('덧붙인 본문이 목록이 아니면 거절한다', async () => {
    const outcome = await build({
      researchResult: researchResult({
        candidatePassages: [{ reference: PSALM_56, additionalReferences: '없음' }],
      }),
    });
    assert.equal(outcome.ok, false);
    assert.ok(!outcome.ok && outcome.code === 'INVALID_RESEARCH_INPUT');
  });

  it('멈추는 이유가 정해진 일곱 가지뿐이다', () => {
    assert.deepEqual(
      [...CANDIDATE_BUILDER_ERROR_CODES],
      [
        'INVALID_RESEARCH_INPUT',
        'RESEARCH_RESULT_HASH_MISMATCH',
        'INVALID_MODEL_DRAFT',
        'SELECTED_PASSAGE_OUT_OF_RANGE',
        'REFERENCE_LABEL_UNFORMATTABLE',
        'CANDIDATE_VALIDATION_FAILED',
        'CANDIDATE_HASH_FAILED',
      ],
    );
  });

  it('멈출 때는 글을 돌려주지 않는다', async () => {
    const outcome = await build({ draft: draft({ selectedPassageIndex: 99 }) });
    assert.equal(outcome.ok, false);
    assert.equal('candidate' in outcome, false);
    assert.equal('candidateHash' in outcome, false);
  });
});

/* ================================================================== */
/* E-2. 지문이 정말 그 연구의 것인가                                    */
/* ================================================================== */

describe('글 조립 · E-2. 연구와 지문의 이음', () => {
  it('제대로 짝지어진 연구와 지문은 통과한다', async () => {
    const result = researchResult();
    const hash = await computeResearchResultHash(result as never);

    const outcome = await buildPublishedContentCandidate({
      researchResultHash: hash,
      researchResult: result,
      draft: draft(),
    } as never);

    assert.ok(outcome.ok);
    assert.equal(outcome.candidate.researchResultHash, hash);
  });

  it('A 연구의 지문에 B 연구의 결과를 붙이면 거절한다', async () => {
    // 둘 다 그 자체로는 멀쩡한 연구 결과다. 어긋난 것은 둘의 짝이다.
    const resultA = researchResult({ researchQuestion: '연구 A 의 질문입니다. 무엇을 말하는가?' });
    const resultB = researchResult({ researchQuestion: '연구 B 의 질문입니다. 전혀 다른 연구다.' });

    const hashA = await computeResearchResultHash(resultA as never);
    const hashB = await computeResearchResultHash(resultB as never);
    assert.notEqual(hashA, hashB);

    const outcome = await buildPublishedContentCandidate({
      researchResultHash: hashA,
      researchResult: resultB,
      draft: draft(),
    } as never);

    assert.equal(outcome.ok, false);
    assert.ok(!outcome.ok && outcome.code === 'RESEARCH_RESULT_HASH_MISMATCH');
  });

  it('모양만 맞는 지문은 거절한다', async () => {
    // 예전에는 정규식만 봤다. rres_ 로 시작하는 64자리면 무엇이든 통과했다.
    const outcome = await build({ researchResultHash: `rres_${'f'.repeat(64)}` });

    assert.equal(outcome.ok, false);
    assert.ok(!outcome.ok && outcome.code === 'RESEARCH_RESULT_HASH_MISMATCH');
  });

  it('어긋나면 글도 지문도 돌려주지 않는다', async () => {
    const outcome = await build({ researchResultHash: `rres_${'f'.repeat(64)}` });

    assert.equal(outcome.ok, false);
    assert.equal('candidate' in outcome, false);
    assert.equal('candidateHash' in outcome, false);
  });

  it('어긋난 값을 계산한 값으로 조용히 고쳐 주지 않는다', async () => {
    // 자동으로 고쳐 주면, 잘못된 값을 보낸 쪽은 자기가 틀린 줄 모른 채로 계속 보낸다.
    const outcome = await build({ researchResultHash: `rres_${'f'.repeat(64)}` });

    assert.equal(outcome.ok, false);
    assert.ok(!outcome.ok && outcome.code !== 'CANDIDATE_VALIDATION_FAILED');
  });

  it('연구 내용이 한 글자만 달라도 지문이 어긋난다', async () => {
    const outcome = await build({
      // 지문은 원래 fixture 의 것을 그대로 두고 연구만 바꾼다.
      researchResultHash: RESEARCH_HASH,
      researchResult: researchResult({
        researchQuestion: '성경은 이 삶의 문제를 어떤 본문에서 직접 다루는가?!',
      }),
    });

    assert.equal(outcome.ok, false);
    assert.ok(!outcome.ok && outcome.code === 'RESEARCH_RESULT_HASH_MISMATCH');
  });

  it('지문 검사는 조립보다 먼저 온다', async () => {
    // 초안이 함께 잘못돼 있어도 이음이 먼저 걸려야 한다.
    const outcome = await build({
      researchResultHash: `rres_${'f'.repeat(64)}`,
      draft: draft({ selectedPassageIndex: 999 }),
    });

    assert.equal(outcome.ok, false);
    assert.ok(!outcome.ok && outcome.code === 'RESEARCH_RESULT_HASH_MISMATCH');
  });

  it('지문 계산의 주인은 연구 보관소 계약이다', () => {
    assert.ok(BUILDER_SOURCE.includes('computeResearchResultHash'));
    assert.ok(BUILDER_SOURCE.includes("from './research-result-store-contract.ts'"));
  });

  it('글에는 넘겨받은 지문을 그대로 담는다', () => {
    // 계산한 값을 대신 담으면 어긋난 입력이 조용히 고쳐진 것처럼 보인다.
    // 지금은 앞의 검사가 막아서 결과가 같지만, 그 검사가 느슨해지는 순간
    // 여기가 자동 교정 장치로 변한다. 그래서 이 자리도 함께 못 박는다.
    const start = BUILDER_SOURCE.indexOf('const candidate: PublishedContentCandidate = {');
    assert.notEqual(start, -1);
    const block = BUILDER_SOURCE.slice(start, BUILDER_SOURCE.indexOf('\n    };', start));

    const line = block
      .split('\n')
      .find((text) => text.trim().startsWith('researchResultHash'));

    assert.notEqual(line, undefined);
    assert.equal((line as string).trim(), 'researchResultHash,');
  });
});

/* ================================================================== */
/* F. 같은 입력이면 같은 결과                                           */
/* ================================================================== */

describe('글 조립 · F. 되풀이', () => {
  it('두 번 불러도 같은 글과 같은 지문이 나온다', async () => {
    const first = await build();
    const second = await build();
    assert.ok(first.ok && second.ok);
    assert.deepEqual(first.candidate, second.candidate);
    assert.equal(first.candidateHash, second.candidateHash);
  });

  it('글을 한 글자만 바꿔도 지문이 달라진다', async () => {
    const before = await build();
    const after = await build({
      draft: draft({ userExplanation: '지금 형편이 막막할 때 이 말씀이 무엇을 말하는지 설명합니다.' }),
    });
    assert.ok(before.ok && after.ok);
    assert.notEqual(before.candidateHash, after.candidateHash);
  });

  it('고른 본문을 바꾸면 지문이 달라진다', async () => {
    const before = await build();
    const after = await build({ draft: draft({ selectedPassageIndex: 1 }) });
    assert.ok(before.ok && after.ok);
    assert.notEqual(before.candidateHash, after.candidateHash);
  });

  it('다른 연구에서 나온 글이면 지문이 달라진다', async () => {
    // 지문 글자만 바꿔서 시험하지 않는다. 그것은 이제 어긋난 입력이라 거절된다.
    // 연구 내용을 바꾸면 그 연구의 지문이 바뀌고, 따라 글의 지문도 바뀐다.
    const before = await build();
    const after = await build({
      researchResult: researchResult({
        researchQuestion: '다른 연구 질문입니다. 성경은 이 문제를 어떻게 말하는가?',
      }),
    });
    assert.ok(before.ok && after.ok);
    assert.notEqual(before.candidate.researchResultHash, after.candidate.researchResultHash);
    assert.notEqual(before.candidateHash, after.candidateHash);
  });

  it('연구가 올린 본문 좌표가 바뀌면 지문이 달라진다', async () => {
    const before = await build();
    const after = await build({
      researchResult: researchResult({
        candidatePassages: [
          { reference: { ...PSALM_56, endVerse: 5 }, additionalReferences: [] },
        ],
      }),
    });
    assert.ok(before.ok && after.ok);
    assert.notEqual(before.candidateHash, after.candidateHash);
  });
});

/* ================================================================== */
/* G. 이 파일이 하지 않는 일                                            */
/* ================================================================== */

describe('글 조립 · G. 경계', () => {
  it('모델을 부르지 않는다', () => {
    for (const banned of [
      'openai',
      'OpenAI',
      'gpt',
      'systemPrompt',
      'temperature',
      'maxTokens',
      'responses.create',
    ]) {
      assert.equal(BUILDER_SOURCE.includes(banned), false, banned);
    }
  });

  it('표를 열거나 바깥을 부르지 않는다', () => {
    for (const banned of [
      'createClient',
      'supabase',
      'service_role',
      'store_published_content_candidate',
      'fetch(',
      'Deno.env',
      'process.env',
    ]) {
      assert.equal(BUILDER_SOURCE.includes(banned), false, banned);
    }
  });

  it('부를 때마다 같은 답을 낸다', () => {
    for (const banned of ['Date.now', 'Math.random', 'randomUUID', 'new Date(']) {
      assert.equal(BUILDER_SOURCE.includes(banned), false, banned);
    }
  });

  it('지문을 새로 만들지 않는다', () => {
    for (const banned of ['crypto', 'digest', 'SHA-256', 'stableStringify']) {
      assert.equal(BUILDER_SOURCE.includes(banned), false, banned);
    }
    assert.ok(BUILDER_SOURCE.includes('computePublishedContentCandidateHash'));
  });

  it('이미 있는 검사기와 표기 규칙을 그대로 쓴다', () => {
    assert.ok(BUILDER_SOURCE.includes('validatePublishedContentCandidate'));
    assert.ok(BUILDER_SOURCE.includes('formatKoreanBibleReferenceSequence'));
    assert.ok(BUILDER_SOURCE.includes('RESEARCH_RESULT_HASH_FORMAT'));
  });

  it('가져오는 곳이 모두 같은 저장소의 계약이다', () => {
    const specifiers = [...BUILDER_SOURCE.matchAll(/from '([^']+)'/g)].map((m) => m[1] as string);
    assert.ok(specifiers.length > 0);
    for (const path of specifiers) {
      assert.ok(path.startsWith('./'), path);
    }
  });

  it('막는 검사를 꺼 둔 자리가 없다', () => {
    assert.equal(/if\s*\(\s*false\s*[)&]/.test(BUILDER_SOURCE), false);
    assert.equal(BUILDER_SOURCE.includes('// eslint-disable'), false);
  });

  it('합치는 자리에서 초안의 권위 항목을 읽지 않는다', () => {
    // 초안 검사기가 이미 그 항목들을 거절한다. 하지만 그것 하나에만 기대면,
    // 검사기가 언젠가 느슨해지는 순간 곧바로 모델 값이 글에 들어간다.
    // 그래서 합치는 자리 자체가 초안을 보지 않는다는 것도 함께 못 박는다.
    const start = BUILDER_SOURCE.indexOf('const candidate: PublishedContentCandidate = {');
    assert.notEqual(start, -1);
    const block = BUILDER_SOURCE.slice(start, BUILDER_SOURCE.indexOf('\n    };', start));

    for (const field of [
      'researchResultHash',
      'targetDomain',
      'passage',
      'additionalPassages',
      'referenceLabel',
    ]) {
      const line = block
        .split('\n')
        .find((text) => text.trim().startsWith(`${field},`) || text.trim().startsWith(`${field}:`));

      assert.notEqual(line, undefined, field);
      assert.equal((line as string).includes('draft'), false, `${field}: ${line}`);
    }
  });

  it('지문을 초안에서 가져오지 않는다', () => {
    const line = BUILDER_SOURCE.split('\n').find((text) =>
      text.includes('const candidateHash ='),
    );
    assert.notEqual(line, undefined);
    assert.ok((line as string).includes('computePublishedContentCandidateHash'));
    assert.equal((line as string).includes('draft'), false, line as string);
  });
});

/* ================================================================== */
/* H. 초안 검사기 단독                                                  */
/* ================================================================== */

describe('글 조립 · H. 초안 검사기', () => {
  it('제대로 된 초안은 통과한다', () => {
    const checked = validateCandidateGenerationDraft(draft());
    assert.deepEqual(checked.errors, []);
    assert.equal(checked.valid, true);
  });

  it('고를 수 있는 번호인지는 여기서 보지 않는다', () => {
    // 연구 결과를 봐야 알 수 있는 일이라 조립하는 쪽이 본다.
    const checked = validateCandidateGenerationDraft(draft({ selectedPassageIndex: 999 }));
    assert.equal(checked.valid, true);
  });

  it('어떤 이상한 값에도 예외를 던지지 않는다', () => {
    for (const bad of [null, undefined, 'x', 3, [], () => {}, Symbol('x')]) {
      const checked = validateCandidateGenerationDraft(bad);
      assert.equal(checked.valid, false, String(bad));
    }
  });
});
