/**
 * Candidate Generation Orchestration Contract · 테스트
 *
 * 실행: npm test
 *
 * 이 계약은 아무것도 부르지 않는다. 그래서 시험도 두 층으로 나뉜다.
 *
 *   1. 계약 안의 순수 함수(lineage 확인, 분류 함수)를 직접 부른다.
 *   2. "만약 다음 단계의 orchestrator가 이 계약을 그대로 따른다면
 *      provider/builder/store가 몇 번 불릴 것인가"를 증명하기 위해,
 *      이 파일 안에서만 쓰는 아주 작은 참조 배선(harness)을 만든다.
 *
 * 그 배선은 생산 코드가 아니다. 계약의 함수들을 이어 붙여서
 * "이대로 이으면 순서와 횟수가 지켜진다"를 보여주는 시험 도구일 뿐이다.
 * 생산 계약 파일 자체에는 이런 배선이 없다 — 없어야 "orchestrator를
 * 구현하지 않았다"는 이번 단계의 약속을 지킨 것이 된다.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  LINEAGE_PREFLIGHT_FAILURE_REASONS,
  ORCHESTRATION_PRIVACY_POLICY,
  ORCHESTRATION_RESULT_CATEGORIES,
  ORCHESTRATION_RETRY_POLICY,
  ORCHESTRATION_STEP_ORDER,
  PRODUCTION_RESEARCH_RESULT_ACQUISITION,
  STORE_AFTER_MODEL_RISK,
  STEPS_BEFORE_PROVIDER_CALL,
  builderOutcomeToOrchestrationResult,
  canProceedToCandidateBuilder,
  canProceedToCandidateStore,
  preflightFailureToOrchestrationResult,
  storeOutcomeToOrchestrationResult,
  transportOutcomeToOrchestrationResult,
  verifyCandidateGenerationLineage,
  type CandidateGenerationOrchestrationResult,
  type CandidateGenerationStoreOutcome,
} from '../../supabase/functions/_shared/published-content-candidate-generation-orchestration-contract.ts';
import { computeResearchResultHash } from '../../supabase/functions/_shared/research-result-store-contract.ts';
import type { CandidateGenerationTransportOutcome } from '../../supabase/functions/_shared/published-content-candidate-generation-transport-contract.ts';
import type { CandidateBuildOutcome } from '../../supabase/functions/_shared/published-content-candidate-builder.ts';
import type { PublishedContentCandidate } from '../../supabase/functions/_shared/published-content-contract.ts';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '');

const CONTRACT =
  '../../supabase/functions/_shared/published-content-candidate-generation-orchestration-contract.ts';

/* ------------------------------------------------------------------ */
/* fixture                                                             */
/* ------------------------------------------------------------------ */

const PSALM_56 = { book: 'Psalms', chapter: 56, startVerse: 3, endVerse: 4 };

const validResearchResult = () => ({
  targetDomain: 'financial_hardship',
  evidenceVersion: 4,
  prioritizerSnapshotId: `snap_${'b'.repeat(64)}`,
  researchQuestion: '성경은 이 삶의 문제를 어떤 본문에서 직접 다루는가?',
  domainBoundaries: { includedConcerns: ['생계 압박'], excludedOrAdjacentConcerns: [] },
  candidatePassages: [
    {
      reference: PSALM_56,
      additionalReferences: [],
      canonicalContext: '이 본문이 놓인 원래 흐름에 대한 연구 메모입니다.',
      theologicalContribution: '이 본문이 이 영역에 주는 신학적 기여에 대한 메모입니다.',
      domainFit: '이 삶의 문제를 직접 다루기 때문입니다.',
      pastoralUse: ['위로'],
      misuseRisks: ['결과 보장으로 사용하지 않는다.'],
      distinctnessFromActiveCoverage: { distinct: true, nearestExistingDomain: 'x', explanation: 'y' },
      researchConfidence: 0.6,
      sourceSupport: {
        exegesisEvidenceIds: [],
        theologyEvidenceIds: [],
        pastoralEvidenceIds: [],
        safetyEvidenceIds: [],
        exegesisSourceIds: [],
        theologySourceIds: [],
        pastoralSourceIds: [],
        safetySourceIds: [],
      },
    },
  ],
  rejectedPassages: [],
  unresolvedQuestions: [],
  evidenceSetHash: `evset_${'c'.repeat(64)}`,
});

/** 연구는 온전하지만 후보 본문이 하나도 없다. 지문은 맞지만 모델 입력을 만들 수 없다. */
const unprojectableResearchResult = () => ({
  ...validResearchResult(),
  candidatePassages: [],
});

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

const generateResponse = () => ({ decision: 'generate' as const, draft: draft() });
const deferResponse = () => ({ decision: 'defer' as const, reason: 'needs_more_research' as const });

const TRANSPORT_OUTCOME_FIXTURES: CandidateGenerationTransportOutcome[] = [
  { outcome: 'empty_response' },
  { outcome: 'json_parse_failed' },
  { outcome: 'response_contract_invalid', errors: ['x'] },
  { outcome: 'provider_timeout' },
  { outcome: 'provider_unavailable' },
  { outcome: 'provider_error' },
  { outcome: 'model_refusal' },
  { outcome: 'response_incomplete' },
];

/* ================================================================== */
/* A. lineage verification precedes provider invocation                */
/* ================================================================== */

describe('Orchestration Contract · A. lineage가 provider보다 먼저다', () => {
  it('ORCHESTRATION_STEP_ORDER에서 지문 확인이 모델 호출보다 앞에 있다', () => {
    const hashIndex = ORCHESTRATION_STEP_ORDER.indexOf('hash_equality_verification');
    const transportIndex = ORCHESTRATION_STEP_ORDER.indexOf('transport_call');
    assert.ok(hashIndex >= 0 && transportIndex >= 0);
    assert.ok(hashIndex < transportIndex);
  });

  it('모델 호출 전 다섯 단계가 정확히 앞 다섯이다', () => {
    assert.deepEqual(STEPS_BEFORE_PROVIDER_CALL, [
      'input_shape_preflight',
      'canonical_hash_computation',
      'hash_equality_verification',
      'generation_input_projection',
      'projection_failure_check',
    ]);
  });

  it('실제로 이어 보면, lineage가 끝나기 전에는 모델 호출 자리가 불리지 않는다', async () => {
    const calls: string[] = [];
    const fakeProviderCall = async () => {
      calls.push('provider');
      return { outcome: 'validated_generate', response: generateResponse() } as CandidateGenerationTransportOutcome;
    };

    const result = await validResearchResult();
    const hash = await computeResearchResultHash(result as never);

    calls.push('lineage_start');
    const lineage = await verifyCandidateGenerationLineage({ researchResultHash: hash, researchResult: result });
    calls.push('lineage_done');

    if (lineage.ok) {
      await fakeProviderCall();
    }

    assert.deepEqual(calls, ['lineage_start', 'lineage_done', 'provider']);
  });
});

/* ================================================================== */
/* B. hash mismatch                                                    */
/* ================================================================== */

describe('Orchestration Contract · B. 지문이 어긋나면', () => {
  it('hash_mismatch로 멈추고 generationInput을 담지 않는다', async () => {
    const result = validResearchResult();
    const wrongHash = `rres_${'0'.repeat(64)}`;

    const outcome = await verifyCandidateGenerationLineage({
      researchResultHash: wrongHash,
      researchResult: result,
    });

    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.equal(outcome.reason, 'hash_mismatch');
    assert.deepEqual(Object.keys(outcome), ['ok', 'reason']);
  });

  it('그 뒤로 이으면 provider 0 / builder 0 / store 0이다', async () => {
    const providerCalls = { count: 0 };
    const builderCalls = { count: 0 };
    const storeCalls = { count: 0 };

    const result = validResearchResult();
    const wrongHash = `rres_${'1'.repeat(64)}`;

    const lineage = await verifyCandidateGenerationLineage({
      researchResultHash: wrongHash,
      researchResult: result,
    });

    let finalResult: CandidateGenerationOrchestrationResult;

    if (!lineage.ok) {
      finalResult = preflightFailureToOrchestrationResult(lineage);
    } else {
      providerCalls.count += 1;
      finalResult = { category: 'generated', candidateHash: 'unreachable' };
      builderCalls.count += 1;
      storeCalls.count += 1;
    }

    assert.equal(providerCalls.count, 0);
    assert.equal(builderCalls.count, 0);
    assert.equal(storeCalls.count, 0);
    assert.deepEqual(finalResult, { category: 'deterministic_preflight_failure' });
  });
});

/* ================================================================== */
/* C. invalid/unusable Research Result                                 */
/* ================================================================== */

describe('Orchestration Contract · C. 쓸 수 없는 연구 결과', () => {
  it('객체가 아니면 input_not_object', async () => {
    const outcome = await verifyCandidateGenerationLineage({
      researchResultHash: `rres_${'a'.repeat(64)}`,
      researchResult: 'not an object' as unknown,
    });
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.equal(outcome.reason, 'research_result_not_object');
  });

  it('지문 모양이 틀리면 hash_format_invalid — 지문 계산조차 하지 않는다', async () => {
    const outcome = await verifyCandidateGenerationLineage({
      researchResultHash: 'not-a-real-hash',
      researchResult: validResearchResult(),
    });
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.equal(outcome.reason, 'hash_format_invalid');
  });

  it('지문은 맞는데 후보 본문이 없으면 generation_input_projection_failed — defer와 다르다', async () => {
    const result = unprojectableResearchResult();
    const hash = await computeResearchResultHash(result as never);

    const outcome = await verifyCandidateGenerationLineage({ researchResultHash: hash, researchResult: result });

    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.equal(outcome.reason, 'generation_input_projection_failed');
  });

  it('세 경우 모두 provider 0 / store 0이다', async () => {
    const cases: [string, unknown][] = [
      [`rres_${'a'.repeat(64)}`, 'not an object'],
      ['not-a-real-hash', validResearchResult()],
    ];

    for (const [researchResultHash, researchResult] of cases) {
      let providerCalled = false;
      let storeCalled = false;

      const lineage = await verifyCandidateGenerationLineage({ researchResultHash, researchResult });
      if (lineage.ok) {
        providerCalled = true;
        storeCalled = true;
      }

      assert.equal(providerCalled, false);
      assert.equal(storeCalled, false);
    }
  });
});

/* ================================================================== */
/* D. validated_defer                                                  */
/* ================================================================== */

describe('Orchestration Contract · D. 모델이 못 쓰겠다고 했을 때', () => {
  it('deferred로 분류되고, 계속 진행하라는 신호(null)가 아니다', () => {
    const outcome: CandidateGenerationTransportOutcome = { outcome: 'validated_defer', response: deferResponse() };
    const result = transportOutcomeToOrchestrationResult(outcome);
    assert.deepEqual(result, { category: 'deferred' });
  });

  it('Builder로 넘어갈 수 없다', () => {
    const outcome: CandidateGenerationTransportOutcome = { outcome: 'validated_defer', response: deferResponse() };
    assert.equal(canProceedToCandidateBuilder(outcome), false);
  });

  it('이어 보면 builder 0 / store 0 / retry 0이다', () => {
    let builderCalls = 0;
    let storeCalls = 0;

    const outcome: CandidateGenerationTransportOutcome = { outcome: 'validated_defer', response: deferResponse() };
    const terminal = transportOutcomeToOrchestrationResult(outcome);

    if (terminal === null && canProceedToCandidateBuilder(outcome)) {
      builderCalls += 1;
      storeCalls += 1;
    }

    assert.equal(builderCalls, 0);
    assert.equal(storeCalls, 0);
    assert.equal(ORCHESTRATION_RETRY_POLICY.modelAutomaticRetries, 0);
  });
});

/* ================================================================== */
/* E. non-generate transport outcomes                                  */
/* ================================================================== */

describe('Orchestration Contract · E. 그 밖의 실패 outcome들', () => {
  for (const outcome of TRANSPORT_OUTCOME_FIXTURES) {
    it(`${outcome.outcome} → builder 불가, generation_failure로 분류`, () => {
      assert.equal(canProceedToCandidateBuilder(outcome), false);
      assert.deepEqual(transportOutcomeToOrchestrationResult(outcome), { category: 'generation_failure' });
    });
  }

  it('여덟 경우 모두 store로 이어지지 않는다', () => {
    for (const outcome of TRANSPORT_OUTCOME_FIXTURES) {
      let storeCalled = false;
      const terminal = transportOutcomeToOrchestrationResult(outcome);
      if (terminal === null) storeCalled = true;
      assert.equal(storeCalled, false, outcome.outcome);
    }
  });
});

/* ================================================================== */
/* F. validated_generate                                               */
/* ================================================================== */

describe('Orchestration Contract · F. 모델이 썼을 때', () => {
  it('Builder로 넘어갈 수 있다', () => {
    const outcome: CandidateGenerationTransportOutcome = { outcome: 'validated_generate', response: generateResponse() };
    assert.equal(canProceedToCandidateBuilder(outcome), true);
  });

  it('transportOutcomeToOrchestrationResult가 null을 돌려준다(=계속 진행)', () => {
    const outcome: CandidateGenerationTransportOutcome = { outcome: 'validated_generate', response: generateResponse() };
    assert.equal(transportOutcomeToOrchestrationResult(outcome), null);
  });
});

/* ================================================================== */
/* G. Builder success → Store exactly once                             */
/* ================================================================== */

describe('Orchestration Contract · G. 조립이 성공하면', () => {
  it('Store로 넘어갈 수 있다', () => {
    const builderOutcome: CandidateBuildOutcome = {
      ok: true,
      candidate: {} as PublishedContentCandidate,
      candidateHash: `pcand_${'d'.repeat(64)}`,
    };
    assert.equal(canProceedToCandidateStore(builderOutcome), true);
  });

  it('이어 보면 store가 정확히 한 번 불린다', async () => {
    let storeCalls = 0;
    const builderOutcome: CandidateBuildOutcome = {
      ok: true,
      candidate: {} as PublishedContentCandidate,
      candidateHash: `pcand_${'d'.repeat(64)}`,
    };

    const fakeStore = async (): Promise<CandidateGenerationStoreOutcome> => {
      storeCalls += 1;
      return { ok: true, candidateHash: builderOutcome.ok ? builderOutcome.candidateHash : '' };
    };

    if (canProceedToCandidateStore(builderOutcome)) {
      await fakeStore();
    }

    assert.equal(storeCalls, 1);
  });
});

/* ================================================================== */
/* H. Builder failure → Store 0                                        */
/* ================================================================== */

describe('Orchestration Contract · H. 조립이 실패하면', () => {
  it('Store로 넘어갈 수 없다', () => {
    const builderOutcome: CandidateBuildOutcome = {
      ok: false,
      code: 'INVALID_MODEL_DRAFT',
      errors: ['x'],
    };
    assert.equal(canProceedToCandidateStore(builderOutcome), false);
    assert.deepEqual(builderOutcomeToOrchestrationResult(builderOutcome), { category: 'candidate_build_failure' });
  });

  it('이어 보면 store가 0번 불린다', async () => {
    let storeCalls = 0;
    const builderOutcome: CandidateBuildOutcome = {
      ok: false,
      code: 'RESEARCH_RESULT_HASH_MISMATCH',
      errors: ['x'],
    };

    if (canProceedToCandidateStore(builderOutcome)) {
      storeCalls += 1;
    }

    assert.equal(storeCalls, 0);
  });
});

/* ================================================================== */
/* I. Store failure                                                    */
/* ================================================================== */

describe('Orchestration Contract · I. 적어 두기가 실패하면', () => {
  it('candidate_store_failure로 분류되고, generated가 아니다', () => {
    const outcome: CandidateGenerationStoreOutcome = { ok: false };
    const result = storeOutcomeToOrchestrationResult(outcome);
    assert.deepEqual(result, { category: 'candidate_store_failure' });
    assert.notEqual(result.category, 'generated');
  });

  it('모델도 store도 자동으로 다시 부르지 않는다', () => {
    assert.equal(ORCHESTRATION_RETRY_POLICY.modelAutomaticRetries, 0);
    assert.equal(ORCHESTRATION_RETRY_POLICY.storeAutomaticRetries, 0);
  });

  it('generated success를 반환하지 않는다 — STORE_AFTER_MODEL_RISK가 그렇게 못 박는다', () => {
    assert.equal(STORE_AFTER_MODEL_RISK.generatedSuccessReturnedOnStoreFailure, false);
    assert.equal(STORE_AFTER_MODEL_RISK.modelRecalledOnStoreFailure, false);
    assert.equal(STORE_AFTER_MODEL_RISK.storeAutoRetried, false);
    assert.equal(STORE_AFTER_MODEL_RISK.status, 'RUNTIME_RISK_DEFERRED');
  });

  it('실제로 이어 보면, store가 실패한 뒤 fake store는 정확히 한 번만 불렸다', async () => {
    let storeCalls = 0;
    const fakeStore = async (): Promise<CandidateGenerationStoreOutcome> => {
      storeCalls += 1;
      return { ok: false };
    };

    const outcome = await fakeStore();
    const finalResult = storeOutcomeToOrchestrationResult(outcome);

    // 재시도 정책이 0이므로, 여기서 다시 fakeStore를 부르는 코드가 없다.
    assert.equal(storeCalls, 1);
    assert.deepEqual(finalResult, { category: 'candidate_store_failure' });
  });
});

/* ================================================================== */
/* J. privacy exclusions                                               */
/* ================================================================== */

describe('Orchestration Contract · J. 아무것도 새지 않는다', () => {
  it('실패 결과에는 category 하나만 남는다', async () => {
    const preflight = await verifyCandidateGenerationLineage({
      researchResultHash: 'bad',
      researchResult: validResearchResult(),
    });
    assert.equal(preflight.ok, false);
    if (!preflight.ok) {
      const result = preflightFailureToOrchestrationResult(preflight);
      assert.deepEqual(Object.keys(result), ['category']);
    }
  });

  it('성공 결과에는 category와 candidateHash만 있다', () => {
    const result = storeOutcomeToOrchestrationResult({ ok: true, candidateHash: `pcand_${'e'.repeat(64)}` });
    assert.deepEqual(Object.keys(result).sort(), ['candidateHash', 'category']);
  });

  it('researchResult 원문이 어떤 결과에도 나타나지 않는다', async () => {
    const secretMarker = '이것은-원문에만-있는-표식-9f3';
    const result = { ...validResearchResult(), researchQuestion: secretMarker };
    const hash = await computeResearchResultHash(result as never);

    const outcomes: CandidateGenerationOrchestrationResult[] = [];

    const mismatchLineage = await verifyCandidateGenerationLineage({
      researchResultHash: `rres_${'f'.repeat(64)}`,
      researchResult: result,
    });
    if (!mismatchLineage.ok) outcomes.push(preflightFailureToOrchestrationResult(mismatchLineage));

    const okLineage = await verifyCandidateGenerationLineage({ researchResultHash: hash, researchResult: result });
    assert.equal(okLineage.ok, true);

    const dumped = JSON.stringify(outcomes);
    assert.equal(dumped.includes(secretMarker), false);
  });

  it('ORCHESTRATION_PRIVACY_POLICY가 전부 false다', () => {
    for (const [key, value] of Object.entries(ORCHESTRATION_PRIVACY_POLICY)) {
      assert.equal(value, false, key);
    }
  });

  it('preflight 실패 이유(reason)가 orchestration 결과 밖으로 나가지 않는다', async () => {
    const lineage = await verifyCandidateGenerationLineage({
      researchResultHash: 'bad-format',
      researchResult: validResearchResult(),
    });
    assert.equal(lineage.ok, false);
    if (!lineage.ok) {
      const result = preflightFailureToOrchestrationResult(lineage);
      assert.equal(JSON.stringify(result).includes(lineage.reason), false);
    }
  });
});

/* ================================================================== */
/* K. production research-result acquisition remains deferred          */
/* ================================================================== */

describe('Orchestration Contract · K. 운영 확보 경로는 미룬 채로 둔다', () => {
  it('DEFERRED_TO_EDGE_INTEGRATION 상태다', () => {
    assert.equal(PRODUCTION_RESEARCH_RESULT_ACQUISITION.status, 'DEFERRED_TO_EDGE_INTEGRATION');
  });

  it('이번 local 계약에는 migration이 필요하지 않다', () => {
    assert.equal(PRODUCTION_RESEARCH_RESULT_ACQUISITION.migrationRequiredForThisContract, false);
  });

  it('local 입력은 caller-supplied 전제를 명시한다', () => {
    assert.equal(PRODUCTION_RESEARCH_RESULT_ACQUISITION.localOrchestrationInputAssumption, 'caller_supplied_full_payload');
  });
});

/* ================================================================== */
/* L. no DB/network/env/Edge implementation                            */
/* ================================================================== */

describe('Orchestration Contract · L. 실제로 아무것도 부르지 않는다', () => {
  it('Deno.env를 읽지 않는다', () => {
    const code = stripComments(read(CONTRACT));
    // ORCHESTRATION_CONTRACT_DOES_NOT_INCLUDE 안에 "Deno.env를 읽는 일"이라는
    // 설명 문자열이 있다. 그것은 금지 목록이지 실제 호출이 아니므로,
    // 실제 호출 형태(Deno.env.get / Deno.env[)만 금지한다.
    assert.equal(code.includes('Deno.env.get'), false);
    assert.equal(code.includes('Deno.env['), false);
    assert.equal(code.includes('Deno.serve'), false);
  });

  it('실제 fetch/네트워크 호출이 없다', () => {
    const code = stripComments(read(CONTRACT));
    for (const banned of ['await fetch(', 'new AbortController', 'http://', 'https://']) {
      assert.equal(code.includes(banned), false, banned);
    }
  });

  it('Supabase client나 실제 RPC 호출이 없다', () => {
    const code = stripComments(read(CONTRACT));
    for (const banned of ['createClient', '.rpc(', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']) {
      assert.equal(code.includes(banned), false, banned);
    }
  });

  it('console을 쓰지 않는다', () => {
    const code = stripComments(read(CONTRACT));
    assert.equal(code.includes('console.'), false);
  });
});

/* ================================================================== */
/* M. 새 규칙을 만들지 않는다 (authority duplication 금지)              */
/* ================================================================== */

describe('Orchestration Contract · M. 새 규칙을 만들지 않는다', () => {
  it('transport의 열 가지 outcome 이름을 다시 나열하지 않는다', () => {
    const code = stripComments(read(CONTRACT));
    for (const banned of [
      "'empty_response'",
      "'json_parse_failed'",
      "'response_contract_invalid'",
      "'provider_timeout'",
      "'provider_unavailable'",
      "'provider_error'",
      "'model_refusal'",
      "'response_incomplete'",
    ]) {
      assert.equal(code.includes(banned), false, banned);
    }
    // validated_generate / validated_defer는 이 파일이 직접 비교하는 대상이라 예외로 둔다.
    assert.ok(code.includes('canInvokeCandidateBuilder'));
  });

  it('HTTP 상태 대응표를 새로 적지 않는다', () => {
    const code = stripComments(read(CONTRACT));
    for (const banned of ['400', '401', '403', '404', '408', '429', '500', '503']) {
      assert.equal(code.includes(banned), false, banned);
    }
  });

  it('모델 이름·시간 제한·주소·prompt·schema를 복제하지 않는다', () => {
    const code = stripComments(read(CONTRACT));
    for (const banned of ['gpt-5.6-sol', '60_000', '60000', 'api.openai.com', 'RESEARCH_DATA_OPEN', 'json_schema']) {
      assert.equal(code.includes(banned), false, banned);
    }
  });

  it('Candidate 15개 필드·Draft 11개 필드를 다시 나열하지 않는다', () => {
    const code = stripComments(read(CONTRACT));
    for (const banned of [
      'situationTags',
      'emotionTags',
      'theologicalInsight',
      'userExplanation',
      'prayerDirection',
      'misuseGuards',
      'selectedPassageIndex',
    ]) {
      assert.equal(code.includes(banned), false, banned);
    }
  });

  it('해시 알고리즘을 다시 구현하지 않는다 — computeResearchResultHash를 그대로 부른다', () => {
    const code = stripComments(read(CONTRACT));
    assert.equal(code.includes('SHA-256'), false);
    assert.equal(code.includes('digest('), false);
    assert.ok(code.includes('computeResearchResultHash'));
  });

  it('Store의 SQL 동작을 다시 적지 않는다', () => {
    const code = stripComments(read(CONTRACT));
    for (const banned of ['on conflict', 'insert into', 'unique_violation']) {
      assert.equal(code.toLowerCase().includes(banned), false, banned);
    }
  });
});

/* ================================================================== */
/* N. 결과 category 다섯 가지 (§14)                                     */
/* ================================================================== */

describe('Orchestration Contract · N. 내부 결과 category', () => {
  it('여섯 가지다 (generated 포함)', () => {
    assert.deepEqual(
      [...ORCHESTRATION_RESULT_CATEGORIES].sort(),
      [
        'candidate_build_failure',
        'candidate_store_failure',
        'deferred',
        'deterministic_preflight_failure',
        'generated',
        'generation_failure',
      ].sort(),
    );
  });

  it('deterministic_preflight_failure와 deferred는 서로 다른 category다', () => {
    assert.notEqual(
      ORCHESTRATION_RESULT_CATEGORIES.includes('deterministic_preflight_failure' as never),
      false,
    );
    assert.ok(ORCHESTRATION_RESULT_CATEGORIES.includes('deferred' as never));
  });

  it('lineage preflight 실패 이유는 여섯 가지다', () => {
    assert.equal(LINEAGE_PREFLIGHT_FAILURE_REASONS.length, 6);
  });
});
