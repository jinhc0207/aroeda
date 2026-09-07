/**
 * 모델 응답을 받는 자리 · 계약 테스트
 *
 * 실행: npm test
 *
 * 지키려는 것 다섯 가지.
 *
 *   1. 못 읽은 것과 계약을 어긴 것과 모델이 판단한 것을 섞지 않는다.
 *   2. 기술적 실패를 "연구 근거 부족"으로 바꾸지 않는다.
 *   3. 어긋난 글을 고쳐서 통과시키지 않는다.
 *   4. 안에서 조용히 다시 부르거나 다른 모델로 갈아타지 않는다.
 *   5. 대답의 옳고 그름은 이미 있는 검사기가 본다. 여기서 다시 만들지 않는다.
 *
 * 모델을 부르지 않는다. 받았다고 치는 값을 손으로 만들어 넣는다.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  BUILDER_ELIGIBLE_OUTCOMES,
  MODEL_RESPONSE_OUTCOMES,
  NO_SILENT_DOWNGRADE,
  PROVIDER_FAILURE_OUTCOMES,
  TRANSPORT_DOES_NOT_INCLUDE,
  TRANSPORT_OUTCOMES,
  TRANSPORT_PERSISTENCE_POLICY,
  TRANSPORT_RUNTIME_CONFIG_POLICY,
  canInvokeCandidateBuilder,
  createCandidateGenerationModelResponseOutcome,
  createCandidateGenerationTransportFailure,
  interpretCandidateGenerationTransportPayload,
  type CandidateGenerationTransportOutcome,
} from '../../supabase/functions/_shared/published-content-candidate-generation-transport-contract.ts';
import {
  GENERATION_DEFER_REASONS,
  buildCandidateModelGenerationInput,
  type CandidateModelGenerationInput,
} from '../../supabase/functions/_shared/published-content-candidate-generation-contract.ts';
import {
  AUTHORITATIVE_CANDIDATE_FIELDS,
  CANDIDATE_DRAFT_FIELDS,
} from '../../supabase/functions/_shared/published-content-candidate-builder.ts';

const TRANSPORT_PATH =
  '../../supabase/functions/_shared/published-content-candidate-generation-transport-contract.ts';
const TRANSPORT_SOURCE = readFileSync(new URL(TRANSPORT_PATH, import.meta.url), 'utf8');

/* ------------------------------------------------------------------ */
/* fixture                                                             */
/* ------------------------------------------------------------------ */

const PSALM_56 = { book: 'Psalms', chapter: 56, startVerse: 3, endVerse: 4 };
const PROVERBS_3 = { book: 'Proverbs', chapter: 3, startVerse: 5, endVerse: 6 };

const passage = (reference: unknown) => ({
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
});

const researchResult = () => ({
  targetDomain: 'financial_hardship',
  evidenceVersion: 4,
  prioritizerSnapshotId: `snap_${'b'.repeat(64)}`,
  researchQuestion: '성경은 이 삶의 문제를 어떤 본문에서 직접 다루는가?',
  domainBoundaries: {
    includedConcerns: ['생계 압박'],
    excludedOrAdjacentConcerns: ['일반적인 미래 불안'],
  },
  candidatePassages: [passage(PSALM_56), passage(PROVERBS_3)],
  rejectedPassages: [],
  unresolvedQuestions: ['이 영역의 사회적 배경을 더 확인해야 합니다.'],
  evidenceSetHash: `evset_${'c'.repeat(64)}`,
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

const generateResponse = (over: Record<string, unknown> = {}) => ({
  decision: 'generate',
  draft: draft(),
  ...over,
});

const deferResponse = () => ({ decision: 'defer', reason: 'needs_more_research' });

const read = (payload: unknown, input: CandidateModelGenerationInput = INPUT) =>
  interpretCandidateGenerationTransportPayload(payload, input);

/* ================================================================== */
/* A. 결과의 종류                                                       */
/* ================================================================== */

describe('모델 응답 수신 · A. 결과 종류', () => {
  it('결과는 열 가지다', () => {
    assert.deepEqual(
      [...TRANSPORT_OUTCOMES],
      [
        'validated_generate',
        'validated_defer',
        'empty_response',
        'json_parse_failed',
        'response_contract_invalid',
        'provider_timeout',
        'provider_unavailable',
        'provider_error',
        'model_refusal',
        'response_incomplete',
      ],
    );
  });

  it('먼저 있던 여덟은 이름이 그대로다', () => {
    // 새 상태를 더하면서 기존 이름을 바꾸거나 지우지 않았다.
    for (const kind of [
      'validated_generate',
      'validated_defer',
      'empty_response',
      'json_parse_failed',
      'response_contract_invalid',
      'provider_timeout',
      'provider_unavailable',
      'provider_error',
    ]) {
      assert.ok((TRANSPORT_OUTCOMES as readonly string[]).includes(kind), kind);
    }
  });

  it('모델 쪽 문제는 셋이다', () => {
    assert.deepEqual(
      [...PROVIDER_FAILURE_OUTCOMES],
      ['provider_timeout', 'provider_unavailable', 'provider_error'],
    );
    for (const kind of PROVIDER_FAILURE_OUTCOMES) {
      assert.ok((TRANSPORT_OUTCOMES as readonly string[]).includes(kind), kind);
    }
  });

  it('닿았는데 쓸 답이 없는 경우는 둘이다', () => {
    assert.deepEqual([...MODEL_RESPONSE_OUTCOMES], ['model_refusal', 'response_incomplete']);
    for (const kind of MODEL_RESPONSE_OUTCOMES) {
      assert.ok((TRANSPORT_OUTCOMES as readonly string[]).includes(kind), kind);
      // 부르는 데 실패한 것이 아니므로 모델 쪽 문제 목록에는 들어가지 않는다.
      assert.equal((PROVIDER_FAILURE_OUTCOMES as readonly string[]).includes(kind), false, kind);
    }
  });

  it('통과가 곧 글이 만들어졌다는 뜻이 아니다', () => {
    for (const banned of ['candidate_success', 'published', 'stored', 'completed']) {
      assert.equal((TRANSPORT_OUTCOMES as readonly string[]).includes(banned), false, banned);
    }
    assert.ok(TRANSPORT_SOURCE.includes('글이 만들어졌다는 뜻이 아니다'));
  });
});

/* ================================================================== */
/* B. 제대로 온 경우                                                    */
/* ================================================================== */

describe('모델 응답 수신 · B. 정상', () => {
  it('초안이 담긴 값이면 통과한다', () => {
    const outcome = read(generateResponse());
    assert.equal(outcome.outcome, 'validated_generate');
    assert.ok(outcome.outcome === 'validated_generate' && outcome.response.decision === 'generate');
  });

  it('초안이 담긴 글자여도 통과한다', () => {
    const outcome = read(JSON.stringify(generateResponse()));
    assert.equal(outcome.outcome, 'validated_generate');
  });

  it('못 쓰겠다는 값이면 그대로 통과한다', () => {
    const outcome = read(deferResponse());
    assert.equal(outcome.outcome, 'validated_defer');
    assert.ok(outcome.outcome === 'validated_defer' && outcome.response.decision === 'defer');
  });

  it('못 쓰겠다는 글자여도 통과한다', () => {
    const outcome = read(JSON.stringify(deferResponse()));
    assert.equal(outcome.outcome, 'validated_defer');
  });

  it('앞뒤 공백은 털어 준다', () => {
    assert.equal(read(`  \n${JSON.stringify(deferResponse())}\n  `).outcome, 'validated_defer');
  });

  it('못 쓰겠다는 결과에 실패 표시를 붙이지 않는다', () => {
    const outcome = read(deferResponse()) as Record<string, unknown>;
    for (const field of ['error', 'errors', 'failure', 'reasonCode']) {
      assert.equal(field in outcome, false, field);
    }
    assert.equal(NO_SILENT_DOWNGRADE.deferTreatedAsFailure, false);
  });

  it('다른 본문 번호를 골라도 통과한다', () => {
    const last = INPUT.candidatePassages.length - 1;
    const outcome = read(generateResponse({ draft: draft({ selectedPassageIndex: last }) }));
    assert.equal(outcome.outcome, 'validated_generate');
  });
});

/* ================================================================== */
/* C. 읽지 못한 경우                                                    */
/* ================================================================== */

describe('모델 응답 수신 · C. 읽기 실패', () => {
  it('빈 글자는 비어 있는 것이다', () => {
    assert.equal(read('').outcome, 'empty_response');
  });

  it('공백뿐인 글자도 비어 있는 것이다', () => {
    for (const blank of ['   ', '\n', '\t\n  ']) {
      assert.equal(read(blank).outcome, 'empty_response', JSON.stringify(blank));
    }
  });

  it('아무것도 오지 않아도 비어 있는 것이다', () => {
    // 계약을 어긴 것이 아니라 받은 것이 없는 것이다.
    assert.equal(read(null).outcome, 'empty_response');
    assert.equal(read(undefined).outcome, 'empty_response');
  });

  it('망가진 JSON은 읽기 실패다', () => {
    for (const bad of ['{', '{"decision":', '{decision: "defer"}', 'not json at all']) {
      assert.equal(read(bad).outcome, 'json_parse_failed', bad);
    }
  });

  it('코드 블록으로 감싼 글은 벗겨 주지 않는다', () => {
    const fenced = ['```json', JSON.stringify(deferResponse()), '```'].join('\n');
    assert.equal(read(fenced).outcome, 'json_parse_failed');
  });

  it('앞에 설명이 붙은 글은 잘라 주지 않는다', () => {
    const prefixed = `여기 결과입니다:\n${JSON.stringify(deferResponse())}`;
    assert.equal(read(prefixed).outcome, 'json_parse_failed');
  });

  it('뒤에 설명이 붙은 글도 잘라 주지 않는다', () => {
    const suffixed = `${JSON.stringify(deferResponse())}\n완료했습니다.`;
    assert.equal(read(suffixed).outcome, 'json_parse_failed');
  });

  it('JSON이 둘이면 첫 번째만 고르지 않는다', () => {
    const twice = `${JSON.stringify(deferResponse())}\n${JSON.stringify(deferResponse())}`;
    assert.equal(read(twice).outcome, 'json_parse_failed');
  });

  it('읽기 실패를 못 쓰겠다는 대답으로 바꾸지 않는다', () => {
    const fenced = ['```json', JSON.stringify(deferResponse()), '```'].join('\n');
    assert.notEqual(read(fenced).outcome, 'validated_defer');
    assert.equal(NO_SILENT_DOWNGRADE.parseFailureBecomesDefer, false);
  });
});

/* ================================================================== */
/* D. 읽었지만 계약을 어긴 경우                                         */
/* ================================================================== */

describe('모델 응답 수신 · D. 계약 위반', () => {
  const invalidCases: Array<[string, unknown]> = [
    ['모르는 대답 종류', { decision: 'skip', reason: 'needs_more_research' }],
    ['초안 없는 generate', { decision: 'generate' }],
    ['틀린 보류 이유', { decision: 'defer', reason: 'timeout' }],
    ['낯선 항목', { ...generateResponse(), note: '메모' }],
    ['범위 밖 번호', generateResponse({ draft: draft({ selectedPassageIndex: 99 }) })],
    ['본문 좌표', generateResponse({ draft: draft({ book: 'Genesis' }) })],
    ['판단 과정', generateResponse({ draft: draft({ reasoning: '이렇게 골랐습니다' }) })],
    ['객체가 아님', 3],
    ['배열', []],
  ];

  it('계약을 어기면 계약 위반이다', () => {
    for (const [name, value] of invalidCases) {
      assert.equal(read(value).outcome, 'response_contract_invalid', name);
    }
  });

  it('글자로 와도 마찬가지다', () => {
    for (const [name, value] of invalidCases) {
      if (typeof value === 'undefined') continue;
      assert.equal(read(JSON.stringify(value)).outcome, 'response_contract_invalid', name);
    }
  });

  it('정할 수 없는 항목을 실어 오면 계약 위반이다', () => {
    for (const field of AUTHORITATIVE_CANDIDATE_FIELDS) {
      const outcome = read(generateResponse({ draft: draft({ [field]: 'x' }) }));
      assert.equal(outcome.outcome, 'response_contract_invalid', field);
    }
  });

  it('읽기 실패와 구분한다', () => {
    // 고칠 곳이 다르다. 하나는 출력 형식이고 하나는 내용이다.
    assert.equal(read('{').outcome, 'json_parse_failed');
    assert.equal(read({ decision: 'skip' }).outcome, 'response_contract_invalid');
  });

  it('계약 위반을 못 쓰겠다는 대답으로 바꾸지 않는다', () => {
    assert.notEqual(read({ decision: 'skip' }).outcome, 'validated_defer');
    assert.equal(NO_SILENT_DOWNGRADE.contractFailureBecomesDefer, false);
  });

  it('왜 막혔는지는 검사기가 준 사유만 담는다', () => {
    const outcome = read({ decision: 'skip' });
    assert.ok(outcome.outcome === 'response_contract_invalid');
    assert.ok(outcome.outcome === 'response_contract_invalid' && outcome.errors.length > 0);
  });

  it('프롬프트나 모델 원문을 오류에 담지 않는다', () => {
    // 읽는 데 실패한 글은 물론이고,
    // 읽히긴 했는데 계약을 어긴 글의 원문도 담지 않는다.
    // 뒤쪽이 더 중요하다. 그 자리에는 담을 수 있는 값이 실제로 손에 있기 때문이다.
    const marker = 'LEAK_MARKER_XYZ_0001';

    const unreadable = read(`설명이 앞에 붙은 ${marker} {"decision":"defer"}`);
    assert.equal(unreadable.outcome, 'json_parse_failed');
    assert.equal(JSON.stringify(unreadable).includes(marker), false);

    const readableButInvalid = read(JSON.stringify({ decision: 'skip', note: marker }));
    assert.equal(readableButInvalid.outcome, 'response_contract_invalid');
    assert.equal(
      JSON.stringify(readableButInvalid).includes(marker),
      false,
      JSON.stringify(readableButInvalid),
    );

    assert.equal(TRANSPORT_PERSISTENCE_POLICY.promptIncludedInErrors, false);
    assert.equal(TRANSPORT_PERSISTENCE_POLICY.rawModelOutputPersisted, false);
  });

  it('판단 과정을 뽑아 두지 않는다', () => {
    const outcome = read(generateResponse({ draft: draft({ reasoning: '내부 판단 과정입니다' }) }));
    const serialized = JSON.stringify(outcome);
    assert.equal(serialized.includes('내부 판단 과정입니다'), false);
    assert.equal(TRANSPORT_PERSISTENCE_POLICY.reasoningExtracted, false);
    assert.equal(TRANSPORT_PERSISTENCE_POLICY.reasoningPersisted, false);
  });
});

/* ================================================================== */
/* E. 모델 쪽 문제                                                      */
/* ================================================================== */

describe('모델 응답 수신 · E. 모델 쪽 문제', () => {
  it('세 가지 상태를 만들 수 있다', () => {
    for (const kind of PROVIDER_FAILURE_OUTCOMES) {
      assert.equal(createCandidateGenerationTransportFailure(kind).outcome, kind);
    }
  });

  it('셋이 서로 다르다', () => {
    const kinds = PROVIDER_FAILURE_OUTCOMES.map(
      (kind) => createCandidateGenerationTransportFailure(kind).outcome,
    );
    assert.equal(new Set(kinds).size, 3);
  });

  it('모델 쪽 문제를 못 쓰겠다는 대답으로 바꾸지 않는다', () => {
    // 연결이 끊긴 것을 "연구 근거가 모자랍니다"로 적으면
    // 사람은 연구를 더 시키고, 정작 끊긴 연결은 아무도 못 본다.
    for (const kind of PROVIDER_FAILURE_OUTCOMES) {
      const outcome = createCandidateGenerationTransportFailure(kind);
      assert.notEqual(outcome.outcome, 'validated_defer');
      assert.equal(JSON.stringify(outcome).includes(GENERATION_DEFER_REASONS[0] as string), false);
    }
    assert.equal(NO_SILENT_DOWNGRADE.providerFailureBecomesDefer, false);
    assert.equal(NO_SILENT_DOWNGRADE.providerFailureBecomesNeedsMoreResearch, false);
  });

  it('오류 객체나 상태 코드를 들여다보지 않는다', () => {
    for (const banned of ['statusCode', 'status ===', 'instanceof Error', 'error.message']) {
      assert.equal(TRANSPORT_SOURCE.includes(banned), false, banned);
    }
  });

  it('모델의 오류 문구를 글이나 보류 이유로 쓰지 않는다', () => {
    assert.equal(TRANSPORT_PERSISTENCE_POLICY.providerErrorUsedAsCandidateContent, false);
    assert.equal(TRANSPORT_PERSISTENCE_POLICY.providerErrorUsedAsDeferReason, false);
  });

  it('결과에 담기는 것은 상태 이름뿐이다', () => {
    // 오류 문구를 함께 담아 두면 그 문장이 어딘가에서 쓰이게 된다.
    for (const kind of PROVIDER_FAILURE_OUTCOMES) {
      const outcome = createCandidateGenerationTransportFailure(kind);
      assert.deepEqual(Object.keys(outcome), ['outcome'], kind);
    }
  });
});

/* ================================================================== */
/* F. 여덟 가지가 서로 다른가                                           */
/* ================================================================== */

describe('모델 응답 수신 · F. 구분', () => {
  it('같은 상황에서 나오는 상태가 서로 다르다', () => {
    const observed = [
      read(generateResponse()).outcome,
      read(deferResponse()).outcome,
      read('').outcome,
      read('{').outcome,
      read({ decision: 'skip' }).outcome,
      createCandidateGenerationTransportFailure('provider_timeout').outcome,
      createCandidateGenerationTransportFailure('provider_unavailable').outcome,
      createCandidateGenerationTransportFailure('provider_error').outcome,
      createCandidateGenerationModelResponseOutcome('model_refusal').outcome,
      createCandidateGenerationModelResponseOutcome('response_incomplete').outcome,
    ];

    assert.equal(new Set(observed).size, 10);
    assert.deepEqual(observed.sort(), [...TRANSPORT_OUTCOMES].sort());
  });

  it('섞이면 안 되는 여섯이 서로 다르다', () => {
    const six = [
      read(deferResponse()).outcome,
      read('{').outcome,
      read({ decision: 'skip' }).outcome,
      createCandidateGenerationTransportFailure('provider_timeout').outcome,
      createCandidateGenerationModelResponseOutcome('model_refusal').outcome,
      createCandidateGenerationModelResponseOutcome('response_incomplete').outcome,
    ];

    assert.deepEqual(six, [
      'validated_defer',
      'json_parse_failed',
      'response_contract_invalid',
      'provider_timeout',
      'model_refusal',
      'response_incomplete',
    ]);
    assert.equal(new Set(six).size, 6);
  });
});

/* ================================================================== */
/* F-2. 모델이 답하기를 거절한 경우                                     */
/* ================================================================== */

describe('모델 응답 수신 · F-2. 거절', () => {
  const refusal = createCandidateGenerationModelResponseOutcome('model_refusal');

  it('따로 있는 상태다', () => {
    assert.equal(refusal.outcome, 'model_refusal');
  });

  it('못 쓰겠다는 대답이 아니다', () => {
    // 거절은 요청 자체에 답하지 않겠다는 것이고,
    // 보류는 연구 근거를 보고 내린 판단이다. 사람에게 다르게 보여야 한다.
    assert.notEqual(refusal.outcome, 'validated_defer');
    assert.equal(JSON.stringify(refusal).includes(GENERATION_DEFER_REASONS[0] as string), false);
    assert.equal(NO_SILENT_DOWNGRADE.modelRefusalBecomesDefer, false);
  });

  it('부르는 데 실패한 것이 아니다', () => {
    assert.notEqual(refusal.outcome, 'provider_error');
    assert.notEqual(refusal.outcome, 'provider_unavailable');
    assert.notEqual(refusal.outcome, 'provider_timeout');
  });

  it('계약을 어긴 것도 아니다', () => {
    assert.notEqual(refusal.outcome, 'response_contract_invalid');
    assert.notEqual(refusal.outcome, 'json_parse_failed');
  });

  it('조립으로 넘어가지 않는다', () => {
    assert.equal(canInvokeCandidateBuilder(refusal), false);
  });

  it('다시 부르지 않는다', () => {
    assert.equal(TRANSPORT_RUNTIME_CONFIG_POLICY.automaticRetries, 0);
    assert.equal(TRANSPORT_RUNTIME_CONFIG_POLICY.fallbackModelAllowed, false);
  });

  it('거절하며 적은 말을 남기지 않는다', () => {
    assert.equal(TRANSPORT_PERSISTENCE_POLICY.rawRefusalPersisted, false);
    assert.equal(TRANSPORT_PERSISTENCE_POLICY.refusalTextUsedAsCandidateContent, false);
    assert.equal(TRANSPORT_PERSISTENCE_POLICY.refusalTextUsedAsDeferReason, false);

    // 결과에 담기는 것은 상태 이름뿐이다.
    assert.deepEqual(Object.keys(refusal), ['outcome']);
  });
});

/* ================================================================== */
/* F-3. 답이 오다 만 경우                                               */
/* ================================================================== */

describe('모델 응답 수신 · F-3. 잘림', () => {
  const incomplete = createCandidateGenerationModelResponseOutcome('response_incomplete');

  it('따로 있는 상태다', () => {
    assert.equal(incomplete.outcome, 'response_incomplete');
  });

  it('아무것도 안 온 것과 다르다', () => {
    // 온 것은 있다. 끝까지 오지 않았을 뿐이다.
    assert.notEqual(incomplete.outcome, 'empty_response');
    assert.notEqual(read('').outcome, incomplete.outcome);
  });

  it('시간 초과와 다르다', () => {
    assert.notEqual(incomplete.outcome, 'provider_timeout');
    assert.notEqual(
      createCandidateGenerationTransportFailure('provider_timeout').outcome,
      incomplete.outcome,
    );
  });

  it('읽기 실패나 계약 위반과 다르다', () => {
    assert.notEqual(incomplete.outcome, 'json_parse_failed');
    assert.notEqual(incomplete.outcome, 'response_contract_invalid');
  });

  it('못 쓰겠다는 대답이 아니다', () => {
    assert.notEqual(incomplete.outcome, 'validated_defer');
    assert.equal(JSON.stringify(incomplete).includes(GENERATION_DEFER_REASONS[0] as string), false);
    assert.equal(NO_SILENT_DOWNGRADE.responseIncompleteBecomesDefer, false);
  });

  it('조립으로 넘어가지 않는다', () => {
    assert.equal(canInvokeCandidateBuilder(incomplete), false);
  });

  it('길이를 늘려 다시 부르지 않는다', () => {
    // 받는 길이가 모자라 보여도 여기서 스스로 늘려 다시 부르지 않는다.
    assert.equal(TRANSPORT_RUNTIME_CONFIG_POLICY.automaticRetries, 0);
    assert.equal(TRANSPORT_RUNTIME_CONFIG_POLICY.outputBudgetMustBeExplicitlyConfigured, true);
    assert.equal(TRANSPORT_RUNTIME_CONFIG_POLICY.defaultOutputBudget, null);
  });
});

/* ================================================================== */
/* G. 조립으로 넘어가도 되는가                                          */
/* ================================================================== */

describe('모델 응답 수신 · G. 조립 자격', () => {
  it('넘어갈 수 있는 결과는 하나뿐이다', () => {
    assert.deepEqual([...BUILDER_ELIGIBLE_OUTCOMES], ['validated_generate']);
  });

  it('초안이 있을 때만 넘어간다', () => {
    assert.equal(canInvokeCandidateBuilder(read(generateResponse())), true);
  });

  it('나머지 아홉은 넘어가지 않는다', () => {
    const others: CandidateGenerationTransportOutcome[] = [
      read(deferResponse()),
      read(''),
      read('{'),
      read({ decision: 'skip' }),
      createCandidateGenerationTransportFailure('provider_timeout'),
      createCandidateGenerationTransportFailure('provider_unavailable'),
      createCandidateGenerationTransportFailure('provider_error'),
      createCandidateGenerationModelResponseOutcome('model_refusal'),
      createCandidateGenerationModelResponseOutcome('response_incomplete'),
    ];

    assert.equal(others.length, 9);
    assert.equal(new Set(others.map((o) => o.outcome)).size, 9);
    for (const outcome of others) {
      assert.equal(canInvokeCandidateBuilder(outcome), false, outcome.outcome);
    }
  });

  it('못 쓰겠다는 대답도 넘기지 않는다', () => {
    // 실패라서가 아니라 넘길 초안이 없기 때문이다.
    assert.equal(canInvokeCandidateBuilder(read(deferResponse())), false);
  });

  it('이 계층이 조립하는 쪽을 부르지 않는다', () => {
    for (const banned of [
      'buildPublishedContentCandidate',
      'computePublishedContentCandidateHash',
      'validatePublishedContentCandidate',
      'buildCandidateModelGenerationInput',
      'buildCandidateGenerationPrompt',
    ]) {
      assert.equal(TRANSPORT_SOURCE.includes(banned), false, banned);
    }
    assert.ok(TRANSPORT_DOES_NOT_INCLUDE.length >= 5);
  });
});

/* ================================================================== */
/* H. 부르는 방식                                                       */
/* ================================================================== */

describe('모델 응답 수신 · H. 호출 정책', () => {
  it('안에서 다시 부르지 않는다', () => {
    assert.equal(TRANSPORT_RUNTIME_CONFIG_POLICY.automaticRetries, 0);
  });

  it('다른 모델로 갈아타지 않는다', () => {
    assert.equal(TRANSPORT_RUNTIME_CONFIG_POLICY.fallbackModelAllowed, false);
  });

  it('어긋난 글을 고쳐서 통과시키지 않는다', () => {
    assert.equal(TRANSPORT_RUNTIME_CONFIG_POLICY.automaticJsonRepair, false);
  });

  it('모델이 보낸 원문을 남기지 않는다', () => {
    assert.equal(TRANSPORT_RUNTIME_CONFIG_POLICY.rawModelOutputPersisted, false);
  });

  it('정하지 않으면 부를 수 없다', () => {
    assert.equal(TRANSPORT_RUNTIME_CONFIG_POLICY.modelMustBeExplicitlyConfigured, true);
    assert.equal(TRANSPORT_RUNTIME_CONFIG_POLICY.timeoutMustBeExplicitlyConfigured, true);
    assert.equal(TRANSPORT_RUNTIME_CONFIG_POLICY.outputBudgetMustBeExplicitlyConfigured, true);
  });

  it('기본값을 하나도 두지 않는다', () => {
    // 기본값이 있으면 아무도 정한 적 없는 값이 그대로 쓰이게 된다.
    assert.equal(TRANSPORT_RUNTIME_CONFIG_POLICY.defaultModel, null);
    assert.equal(TRANSPORT_RUNTIME_CONFIG_POLICY.defaultTimeoutMs, null);
    assert.equal(TRANSPORT_RUNTIME_CONFIG_POLICY.defaultOutputBudget, null);
  });

  it('실제 모델 이름이나 숫자를 적어 두지 않는다', () => {
    const numbers = [...TRANSPORT_SOURCE.matchAll(/default(?:Model|TimeoutMs|OutputBudget):\s*([^,\n]+)/g)]
      .map((m) => (m[1] as string).trim());
    assert.deepEqual(numbers, ['null', 'null', 'null']);

    for (const banned of ['gpt-', 'claude-', 'temperature', 'reasoning_effort', 'max_tokens']) {
      assert.equal(TRANSPORT_SOURCE.includes(banned), false, banned);
    }
  });

  it('부르기 전에 값을 정해야 한다고 적어 두었다', () => {
    assert.ok(TRANSPORT_SOURCE.includes('승인받기 전에는 부르지 않는다'));
  });

  it('왜 다시 부르지 않는지 적어 두었다', () => {
    assert.ok(TRANSPORT_SOURCE.includes('모델은 다른 글을 쓴다'));
  });
});

/* ================================================================== */
/* I. 바꿔치기 금지                                                     */
/* ================================================================== */

describe('모델 응답 수신 · I. 바꿔치기', () => {
  it('여덟 가지 바꿔치기를 모두 막는다', () => {
    for (const [name, value] of Object.entries(NO_SILENT_DOWNGRADE)) {
      assert.equal(value, false, name);
    }
    assert.equal(Object.keys(NO_SILENT_DOWNGRADE).length, 8);
  });

  it('어떤 실패에도 needs_more_research가 붙지 않는다', () => {
    const failures: CandidateGenerationTransportOutcome[] = [
      read(''),
      read('{'),
      read({ decision: 'skip' }),
      createCandidateGenerationTransportFailure('provider_timeout'),
      createCandidateGenerationTransportFailure('provider_unavailable'),
      createCandidateGenerationTransportFailure('provider_error'),
      createCandidateGenerationModelResponseOutcome('model_refusal'),
      createCandidateGenerationModelResponseOutcome('response_incomplete'),
    ];

    for (const outcome of failures) {
      const serialized = JSON.stringify(outcome);
      assert.equal(
        serialized.includes(GENERATION_DEFER_REASONS[0] as string),
        false,
        outcome.outcome,
      );
      assert.notEqual(outcome.outcome, 'validated_defer', outcome.outcome);
    }
  });
});

/* ================================================================== */
/* J. 되풀이해도 같은가                                                 */
/* ================================================================== */

describe('모델 응답 수신 · J. 되풀이', () => {
  it('같은 값이면 같은 결과가 나온다', () => {
    assert.deepEqual(read(generateResponse()), read(generateResponse()));
    assert.deepEqual(read('{'), read('{'));
  });

  it('받은 값을 고치지 않는다', () => {
    const payload = generateResponse();
    const before = JSON.stringify(payload);
    const inputBefore = JSON.stringify(INPUT);

    read(payload);

    assert.equal(JSON.stringify(payload), before);
    assert.equal(JSON.stringify(INPUT), inputBefore);
  });
});

/* ================================================================== */
/* K. 규칙의 주인이 아니다                                              */
/* ================================================================== */

describe('모델 응답 수신 · K. 권위', () => {
  it('이미 있는 검사기를 그대로 쓴다', () => {
    assert.ok(TRANSPORT_SOURCE.includes('validateCandidateModelGenerationResponse'));
    assert.ok(
      TRANSPORT_SOURCE.includes("from './published-content-candidate-generation-contract.ts'"),
    );
  });

  it('초안 항목 목록을 다시 적지 않는다', () => {
    for (const field of CANDIDATE_DRAFT_FIELDS) {
      assert.equal(TRANSPORT_SOURCE.includes(`'${field}'`), false, field);
    }
  });

  it('정할 수 없는 항목 목록을 다시 적지 않는다', () => {
    for (const field of AUTHORITATIVE_CANDIDATE_FIELDS) {
      assert.equal(TRANSPORT_SOURCE.includes(`'${field}'`), false, field);
    }
  });

  it('보류 이유를 다시 적지 않는다', () => {
    for (const reason of GENERATION_DEFER_REASONS) {
      assert.equal(TRANSPORT_SOURCE.includes(`'${reason}'`), false, reason);
    }
  });

  it('대답 검사 규칙을 다시 만들지 않는다', () => {
    for (const banned of [
      'GENERATE_RESPONSE_FIELDS = [',
      'DEFER_RESPONSE_FIELDS = [',
      'GENERATION_DECISIONS = [',
      'GENERATION_DEFER_REASONS = [',
      'FIELD_RESPONSIBILITIES = {',
      'TAG_VOCABULARY_POLICY = {',
      'selectedPassageIndex',
    ]) {
      assert.equal(TRANSPORT_SOURCE.includes(banned), false, banned);
    }
  });

  it('프롬프트 타입을 새로 정의하지 않는다', () => {
    assert.equal(TRANSPORT_SOURCE.includes('systemPrompt: string'), false);
    assert.equal(TRANSPORT_SOURCE.includes('userPrompt: string'), false);
    assert.ok(TRANSPORT_SOURCE.includes('CandidateGenerationPrompt'));
  });
});

/* ================================================================== */
/* L. 이 파일이 하지 않는 일                                            */
/* ================================================================== */

describe('모델 응답 수신 · L. 경계', () => {
  it('모델을 부르지 않는다', () => {
    for (const banned of [
      'openai',
      'OpenAI',
      'gpt-',
      'responses.create',
      'chat.completions',
      'anthropic',
    ]) {
      assert.equal(TRANSPORT_SOURCE.includes(banned), false, banned);
    }
  });

  it('특정 제공자의 응답 구조를 알지 못한다', () => {
    // 거절과 잘림을 어떤 응답에서 알아내는지는 앞으로 어댑터가 정한다.
    // 여기가 그것을 알기 시작하면 이 파일이 한 제공자에 묶인다.
    // 우리가 지은 이름(model_refusal 등)이 아니라
    // 제공자 응답에서만 나오는 모양을 본다.
    for (const banned of [
      'response.output',
      'response.status',
      'incomplete_details',
      'output_text',
      '.refusal',
      'finish_reason',
      'stop_reason',
      'choices[',
    ]) {
      assert.equal(TRANSPORT_SOURCE.includes(banned), false, banned);
    }
  });

  it('읽는 함수는 거절이나 잘림을 찾으려 하지 않는다', () => {
    // 그 둘은 JSON 안에 들어 있는 것이 아니라 응답의 성격이다.
    // 어댑터가 읽는 함수보다 앞에서 정한다.
    const start = TRANSPORT_SOURCE.indexOf('export function interpretCandidateGenerationTransportPayload');
    assert.notEqual(start, -1);
    const body = TRANSPORT_SOURCE.slice(start);

    for (const kind of MODEL_RESPONSE_OUTCOMES) {
      assert.equal(body.includes(`'${kind}'`), false, kind);
    }
  });

  it('바깥을 부르지 않는다', () => {
    for (const banned of [
      'fetch(',
      'createClient',
      'supabase',
      'service_role',
      'Deno.env',
      'process.env',
      'setTimeout',
      'AbortController',
    ]) {
      assert.equal(TRANSPORT_SOURCE.includes(banned), false, banned);
    }
  });

  it('부를 때마다 같은 답을 낸다', () => {
    for (const banned of ['Date.now', 'Math.random', 'randomUUID', 'new Date(']) {
      assert.equal(TRANSPORT_SOURCE.includes(banned), false, banned);
    }
  });

  it('JSON 읽기는 정확히 한 번만 쓴다', () => {
    assert.equal((TRANSPORT_SOURCE.match(/JSON\.parse/g) ?? []).length, 1);
  });

  it('글을 뽑아내거나 고치는 도구를 쓰지 않는다', () => {
    for (const banned of ['indexOf(', 'slice(', 'substring(', 'replace(', 'match(', 'exec(']) {
      assert.equal(TRANSPORT_SOURCE.includes(banned), false, banned);
    }
  });

  it('가져오는 곳이 모두 같은 저장소의 계약이다', () => {
    const specifiers = [...TRANSPORT_SOURCE.matchAll(/from '([^']+)'/g)].map((m) => m[1] as string);
    assert.ok(specifiers.length > 0);
    for (const path of specifiers) {
      assert.ok(path.startsWith('./'), path);
    }
  });
});
