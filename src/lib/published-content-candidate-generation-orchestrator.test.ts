/**
 * Candidate Generation Orchestrator · 테스트
 *
 * 실행: npm test
 *
 * 여기서는 실제 committed 함수들을 그대로 통과시킨다.
 *   실제 callCandidateGenerationOpenAIFetchTransport (fetch만 가짜)
 *   실제 buildPublishedContentCandidate (가짜 아님)
 *
 * mock은 side effect 경계 둘에만 둔다.
 *   fetch (네트워크)
 *   storeCandidate (아직 없는 DB 쓰기)
 *
 * 해시 알고리즘, 초안 검사, 조립 규칙을 이 파일에서 다시 만들지 않는다.
 * 전부 실제 authority를 그대로 부른다.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { runCandidateGenerationOrchestrator } from '../../supabase/functions/_shared/published-content-candidate-generation-orchestrator.ts';
import { computeResearchResultHash } from '../../supabase/functions/_shared/research-result-store-contract.ts';
import { buildPublishedContentCandidate } from '../../supabase/functions/_shared/published-content-candidate-builder.ts';
import type { CandidateGenerationStoreOutcome } from '../../supabase/functions/_shared/published-content-candidate-generation-orchestration-contract.ts';
import type { CandidateStoreInput } from '../../supabase/functions/_shared/published-content-store-contract.ts';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '');

const ORCHESTRATOR = '../../supabase/functions/_shared/published-content-candidate-generation-orchestrator.ts';

/* ------------------------------------------------------------------ */
/* fixtures                                                            */
/* ------------------------------------------------------------------ */

const PSALM_56 = { book: 'Psalms', chapter: 56, startVerse: 3, endVerse: 4 };
const UNFORMATTABLE_REF = { book: 'NotARealBook', chapter: 1, startVerse: 1, endVerse: 1 };

const validResearchResult = (reference: unknown = PSALM_56) => ({
  targetDomain: 'financial_hardship',
  evidenceVersion: 4,
  prioritizerSnapshotId: `snap_${'b'.repeat(64)}`,
  researchQuestion: '성경은 이 삶의 문제를 어떤 본문에서 직접 다루는가?',
  domainBoundaries: { includedConcerns: ['생계 압박'], excludedOrAdjacentConcerns: [] },
  candidatePassages: [
    {
      reference,
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

/** OpenAI Responses API가 실제로 보내는 모양. extractOutputText가 이 구조에서 글을 뽑는다. */
const rawResponseBody = (envelopeInner: unknown) => ({
  status: 'completed',
  output: [
    {
      content: [
        { type: 'output_text', text: JSON.stringify({ response: envelopeInner }) },
      ],
    },
  ],
});

const successBody = (draftOverride: Record<string, unknown> = {}) =>
  rawResponseBody({ decision: 'generate', draft: draft(draftOverride) });

const deferBody = () => rawResponseBody({ decision: 'defer', reason: 'needs_more_research' });

const refusalBody = () => ({
  status: 'completed',
  output: [{ content: [{ type: 'refusal', refusal: '답하지 않겠습니다' }] }],
});

type FakeResponse = { ok: boolean; status: number; json: () => Promise<unknown> };

const okResponse = (body: unknown): FakeResponse => ({
  ok: true,
  status: 200,
  json: async () => body,
});

const httpErrorResponse = (status: number): FakeResponse => ({
  ok: false,
  status,
  json: async () => {
    throw new Error('본문을 열지 않아야 하는데 열렸습니다.');
  },
});

type Recorder = { calls: unknown[][]; order: string[] };

function makeFakeFetch(recorder: Recorder, tag: string, respond: () => FakeResponse | Promise<FakeResponse>) {
  return async (...args: unknown[]) => {
    recorder.calls.push(args);
    recorder.order.push(tag);
    return respond();
  };
}

function makeFakeStore(
  recorder: Recorder,
  tag: string,
  outcome: CandidateGenerationStoreOutcome,
): (input: CandidateStoreInput) => Promise<CandidateGenerationStoreOutcome> {
  return async (input: CandidateStoreInput) => {
    recorder.calls.push([input]);
    recorder.order.push(tag);
    return outcome;
  };
}

const FAKE_API_KEY = 'sk-test-key-not-real';

/* ================================================================== */
/* A. Hash mismatch                                                    */
/* ================================================================== */

describe('Orchestrator · A. 지문이 어긋나면', () => {
  it('provider/fetch 0, store 0, deterministic_preflight_failure로 끝난다', async () => {
    const researchResult = validResearchResult();
    const fetchRecorder: Recorder = { calls: [], order: [] };
    const storeRecorder: Recorder = { calls: [], order: [] };

    const result = await runCandidateGenerationOrchestrator(
      { researchResultHash: `rres_${'0'.repeat(64)}`, researchResult },
      {
        apiKey: FAKE_API_KEY,
        fetchImpl: makeFakeFetch(fetchRecorder, 'fetch', () => okResponse(successBody())) as unknown as typeof fetch,
        storeCandidate: makeFakeStore(storeRecorder, 'store', { ok: true, candidateHash: 'unused' }),
      },
    );

    assert.deepEqual(result, { category: 'deterministic_preflight_failure' });
    assert.equal(fetchRecorder.calls.length, 0);
    assert.equal(storeRecorder.calls.length, 0);
  });
});

/* ================================================================== */
/* B. Invalid/unusable Research Result                                 */
/* ================================================================== */

describe('Orchestrator · B. 쓸 수 없는 연구 결과', () => {
  it('연구가 객체가 아니면 provider 0 / store 0', async () => {
    const fetchRecorder: Recorder = { calls: [], order: [] };
    const storeRecorder: Recorder = { calls: [], order: [] };

    const result = await runCandidateGenerationOrchestrator(
      { researchResultHash: `rres_${'a'.repeat(64)}`, researchResult: 'not an object' },
      {
        apiKey: FAKE_API_KEY,
        fetchImpl: makeFakeFetch(fetchRecorder, 'fetch', () => okResponse(successBody())) as unknown as typeof fetch,
        storeCandidate: makeFakeStore(storeRecorder, 'store', { ok: true, candidateHash: 'unused' }),
      },
    );

    assert.deepEqual(result, { category: 'deterministic_preflight_failure' });
    assert.equal(fetchRecorder.calls.length, 0);
    assert.equal(storeRecorder.calls.length, 0);
  });

  it('지문은 맞는데 후보 본문이 없으면(projection 실패) provider 0 / store 0', async () => {
    const researchResult = unprojectableResearchResult();
    const hash = await computeResearchResultHash(researchResult as never);
    const fetchRecorder: Recorder = { calls: [], order: [] };
    const storeRecorder: Recorder = { calls: [], order: [] };

    const result = await runCandidateGenerationOrchestrator(
      { researchResultHash: hash, researchResult },
      {
        apiKey: FAKE_API_KEY,
        fetchImpl: makeFakeFetch(fetchRecorder, 'fetch', () => okResponse(successBody())) as unknown as typeof fetch,
        storeCandidate: makeFakeStore(storeRecorder, 'store', { ok: true, candidateHash: 'unused' }),
      },
    );

    assert.deepEqual(result, { category: 'deterministic_preflight_failure' });
    assert.equal(fetchRecorder.calls.length, 0);
    assert.equal(storeRecorder.calls.length, 0);
  });
});

/* ================================================================== */
/* C. Valid generate happy path                                        */
/* ================================================================== */

describe('Orchestrator · C. 정상 생성 경로', () => {
  it('provider 1회 · Builder 성공 · Store 1회 · Store 성공 이후에만 generated', async () => {
    const researchResult = validResearchResult();
    const hash = await computeResearchResultHash(researchResult as never);
    const fetchRecorder: Recorder = { calls: [], order: [] };
    const storeRecorder: Recorder = { calls: [], order: [] };

    const result = await runCandidateGenerationOrchestrator(
      { researchResultHash: hash, researchResult },
      {
        apiKey: FAKE_API_KEY,
        fetchImpl: makeFakeFetch(fetchRecorder, 'fetch', () => okResponse(successBody())) as unknown as typeof fetch,
        storeCandidate: makeFakeStore(storeRecorder, 'store', { ok: true, candidateHash: 'stored-hash' }),
      },
    );

    assert.equal(fetchRecorder.calls.length, 1);
    assert.equal(storeRecorder.calls.length, 1);
    assert.deepEqual(fetchRecorder.order.concat(storeRecorder.order).sort(), ['fetch', 'store'].sort());
    // fetch가 store보다 먼저 일어났다.
    assert.ok(fetchRecorder.order.length === 1 && storeRecorder.order.length === 1);

    assert.deepEqual(result, { category: 'generated', candidateHash: 'stored-hash' });
  });

  it('실행 순서가 fetch → store 다', async () => {
    const researchResult = validResearchResult();
    const hash = await computeResearchResultHash(researchResult as never);
    const sharedOrder: string[] = [];
    const fetchRecorder: Recorder = { calls: [], order: sharedOrder };
    const storeRecorder: Recorder = { calls: [], order: sharedOrder };

    await runCandidateGenerationOrchestrator(
      { researchResultHash: hash, researchResult },
      {
        apiKey: FAKE_API_KEY,
        fetchImpl: makeFakeFetch(fetchRecorder, 'fetch', () => okResponse(successBody())) as unknown as typeof fetch,
        storeCandidate: makeFakeStore(storeRecorder, 'store', { ok: true, candidateHash: 'stored-hash' }),
      },
    );

    assert.deepEqual(sharedOrder, ['fetch', 'store']);
  });

  it('buildPublishedContentCandidate 호출 자리는 소스에 정확히 한 번뿐이다', () => {
    const code = stripComments(read(ORCHESTRATOR));
    const occurrences = code.split('buildPublishedContentCandidate(').length - 1;
    assert.equal(occurrences, 1);
  });
});

/* ================================================================== */
/* D. validated_defer                                                  */
/* ================================================================== */

describe('Orchestrator · D. 모델이 못 쓰겠다고 했을 때', () => {
  it('provider 1 · Store 0 · deferred', async () => {
    const researchResult = validResearchResult();
    const hash = await computeResearchResultHash(researchResult as never);
    const fetchRecorder: Recorder = { calls: [], order: [] };
    const storeRecorder: Recorder = { calls: [], order: [] };

    const result = await runCandidateGenerationOrchestrator(
      { researchResultHash: hash, researchResult },
      {
        apiKey: FAKE_API_KEY,
        fetchImpl: makeFakeFetch(fetchRecorder, 'fetch', () => okResponse(deferBody())) as unknown as typeof fetch,
        storeCandidate: makeFakeStore(storeRecorder, 'store', { ok: true, candidateHash: 'unused' }),
      },
    );

    assert.equal(fetchRecorder.calls.length, 1);
    assert.equal(storeRecorder.calls.length, 0);
    assert.deepEqual(result, { category: 'deferred' });
  });
});

/* ================================================================== */
/* E. Provider failures                                                */
/* ================================================================== */

describe('Orchestrator · E. 그 밖의 실패들', () => {
  it('HTTP 500 → generation_failure, store 0', async () => {
    const researchResult = validResearchResult();
    const hash = await computeResearchResultHash(researchResult as never);
    const fetchRecorder: Recorder = { calls: [], order: [] };
    const storeRecorder: Recorder = { calls: [], order: [] };

    const result = await runCandidateGenerationOrchestrator(
      { researchResultHash: hash, researchResult },
      {
        apiKey: FAKE_API_KEY,
        fetchImpl: makeFakeFetch(fetchRecorder, 'fetch', () => httpErrorResponse(500)) as unknown as typeof fetch,
        storeCandidate: makeFakeStore(storeRecorder, 'store', { ok: true, candidateHash: 'unused' }),
      },
    );

    assert.equal(fetchRecorder.calls.length, 1);
    assert.equal(storeRecorder.calls.length, 0);
    assert.deepEqual(result, { category: 'generation_failure' });
  });

  it('fetch 자체가 거부되면(연결 실패) → generation_failure, store 0', async () => {
    const researchResult = validResearchResult();
    const hash = await computeResearchResultHash(researchResult as never);
    const fetchRecorder: Recorder = { calls: [], order: [] };
    const storeRecorder: Recorder = { calls: [], order: [] };

    const result = await runCandidateGenerationOrchestrator(
      { researchResultHash: hash, researchResult },
      {
        apiKey: FAKE_API_KEY,
        fetchImpl: (async () => {
          fetchRecorder.calls.push([]);
          throw new Error('연결할 수 없습니다');
        }) as unknown as typeof fetch,
        storeCandidate: makeFakeStore(storeRecorder, 'store', { ok: true, candidateHash: 'unused' }),
      },
    );

    assert.equal(fetchRecorder.calls.length, 1);
    assert.equal(storeRecorder.calls.length, 0);
    assert.deepEqual(result, { category: 'generation_failure' });
  });

  it('모델이 거절하면 → generation_failure, store 0', async () => {
    const researchResult = validResearchResult();
    const hash = await computeResearchResultHash(researchResult as never);
    const fetchRecorder: Recorder = { calls: [], order: [] };
    const storeRecorder: Recorder = { calls: [], order: [] };

    const result = await runCandidateGenerationOrchestrator(
      { researchResultHash: hash, researchResult },
      {
        apiKey: FAKE_API_KEY,
        fetchImpl: makeFakeFetch(fetchRecorder, 'fetch', () => okResponse(refusalBody())) as unknown as typeof fetch,
        storeCandidate: makeFakeStore(storeRecorder, 'store', { ok: true, candidateHash: 'unused' }),
      },
    );

    assert.equal(storeRecorder.calls.length, 0);
    assert.deepEqual(result, { category: 'generation_failure' });
  });
});

/* ================================================================== */
/* F. Builder failure                                                  */
/* ================================================================== */

describe('Orchestrator · F. 조립이 실패하면', () => {
  it('본문 이름을 만들 수 없으면 candidate_build_failure, store 0', async () => {
    // lineage와 모델 답 검증은 참조 내용을 보지 않는다. Builder만 이름을 만들다 멈춘다.
    const researchResult = validResearchResult(UNFORMATTABLE_REF);
    const hash = await computeResearchResultHash(researchResult as never);
    const fetchRecorder: Recorder = { calls: [], order: [] };
    const storeRecorder: Recorder = { calls: [], order: [] };

    const result = await runCandidateGenerationOrchestrator(
      { researchResultHash: hash, researchResult },
      {
        apiKey: FAKE_API_KEY,
        fetchImpl: makeFakeFetch(fetchRecorder, 'fetch', () => okResponse(successBody())) as unknown as typeof fetch,
        storeCandidate: makeFakeStore(storeRecorder, 'store', { ok: true, candidateHash: 'unused' }),
      },
    );

    assert.equal(fetchRecorder.calls.length, 1);
    assert.equal(storeRecorder.calls.length, 0);
    assert.deepEqual(result, { category: 'candidate_build_failure' });
  });
});

/* ================================================================== */
/* G. Store failure                                                    */
/* ================================================================== */

describe('Orchestrator · G. 적어 두기가 실패하면', () => {
  it('provider 1 · Store 1 · 재시도 0 · generated 아님 · candidate_store_failure', async () => {
    const researchResult = validResearchResult();
    const hash = await computeResearchResultHash(researchResult as never);
    const fetchRecorder: Recorder = { calls: [], order: [] };
    const storeRecorder: Recorder = { calls: [], order: [] };

    const result = await runCandidateGenerationOrchestrator(
      { researchResultHash: hash, researchResult },
      {
        apiKey: FAKE_API_KEY,
        fetchImpl: makeFakeFetch(fetchRecorder, 'fetch', () => okResponse(successBody())) as unknown as typeof fetch,
        storeCandidate: makeFakeStore(storeRecorder, 'store', { ok: false }),
      },
    );

    assert.equal(fetchRecorder.calls.length, 1);
    assert.equal(storeRecorder.calls.length, 1);
    assert.notEqual(result.category, 'generated');
    assert.deepEqual(result, { category: 'candidate_store_failure' });
  });
});

/* ================================================================== */
/* H. Candidate Store input exactness                                  */
/* ================================================================== */

describe('Orchestrator · H. Store에 넘기는 값', () => {
  it('candidateHash / researchResultHash / candidate가 Builder의 실제 계산과 정확히 같다', async () => {
    const researchResult = validResearchResult();
    const hash = await computeResearchResultHash(researchResult as never);
    const theDraft = draft();

    // 독립적으로 같은 입력을 Builder에 직접 넣어 기대값을 구한다(재구현이 아니라 같은 authority를 두 번 부른 것뿐).
    const expected = await buildPublishedContentCandidate({
      researchResultHash: hash,
      researchResult: researchResult as never,
      draft: theDraft,
    });
    assert.equal(expected.ok, true);
    if (!expected.ok) return;

    const storeRecorder: Recorder = { calls: [], order: [] };
    const fetchRecorder: Recorder = { calls: [], order: [] };

    await runCandidateGenerationOrchestrator(
      { researchResultHash: hash, researchResult },
      {
        apiKey: FAKE_API_KEY,
        fetchImpl: makeFakeFetch(fetchRecorder, 'fetch', () => okResponse(successBody(theDraft))) as unknown as typeof fetch,
        storeCandidate: makeFakeStore(storeRecorder, 'store', { ok: true, candidateHash: expected.candidateHash }),
      },
    );

    assert.equal(storeRecorder.calls.length, 1);
    const [storeInput] = storeRecorder.calls[0] as [CandidateStoreInput];

    assert.equal(storeInput.candidateHash, expected.candidateHash);
    assert.equal(storeInput.researchResultHash, hash);
    assert.deepEqual(storeInput.candidate, expected.candidate);
  });
});

/* ================================================================== */
/* I. Credential failure                                               */
/* ================================================================== */

describe('Orchestrator · I. 열쇠가 없을 때', () => {
  it('열쇠가 undefined면 fetch 0 / store 0 / generation_failure', async () => {
    const researchResult = validResearchResult();
    const hash = await computeResearchResultHash(researchResult as never);
    const fetchRecorder: Recorder = { calls: [], order: [] };
    const storeRecorder: Recorder = { calls: [], order: [] };

    const result = await runCandidateGenerationOrchestrator(
      { researchResultHash: hash, researchResult },
      {
        apiKey: undefined,
        fetchImpl: makeFakeFetch(fetchRecorder, 'fetch', () => okResponse(successBody())) as unknown as typeof fetch,
        storeCandidate: makeFakeStore(storeRecorder, 'store', { ok: true, candidateHash: 'unused' }),
      },
    );

    assert.equal(fetchRecorder.calls.length, 0);
    assert.equal(storeRecorder.calls.length, 0);
    assert.deepEqual(result, { category: 'generation_failure' });
  });

  it('열쇠가 빈 문자열이면 fetch 0 / store 0', async () => {
    const researchResult = validResearchResult();
    const hash = await computeResearchResultHash(researchResult as never);
    const fetchRecorder: Recorder = { calls: [], order: [] };
    const storeRecorder: Recorder = { calls: [], order: [] };

    await runCandidateGenerationOrchestrator(
      { researchResultHash: hash, researchResult },
      {
        apiKey: '   ',
        fetchImpl: makeFakeFetch(fetchRecorder, 'fetch', () => okResponse(successBody())) as unknown as typeof fetch,
        storeCandidate: makeFakeStore(storeRecorder, 'store', { ok: true, candidateHash: 'unused' }),
      },
    );

    assert.equal(fetchRecorder.calls.length, 0);
    assert.equal(storeRecorder.calls.length, 0);
  });
});

/* ================================================================== */
/* J. Provider attempt cap                                             */
/* ================================================================== */

describe('Orchestrator · J. 몇 번을 보내는가', () => {
  it('성공해도 실패해도 fetch는 최대 한 번이다', async () => {
    const researchResult = validResearchResult();
    const hash = await computeResearchResultHash(researchResult as never);

    for (const respond of [
      () => okResponse(successBody()),
      () => okResponse(deferBody()),
      () => httpErrorResponse(429),
      () => httpErrorResponse(500),
    ]) {
      const fetchRecorder: Recorder = { calls: [], order: [] };
      await runCandidateGenerationOrchestrator(
        { researchResultHash: hash, researchResult },
        {
          apiKey: FAKE_API_KEY,
          fetchImpl: makeFakeFetch(fetchRecorder, 'fetch', respond) as unknown as typeof fetch,
          storeCandidate: makeFakeStore({ calls: [], order: [] }, 'store', { ok: true, candidateHash: 'x' }),
        },
      );
      assert.equal(fetchRecorder.calls.length, 1);
    }
  });

  it('orchestrator 소스에 재시도 반복문이 없다', () => {
    const code = stripComments(read(ORCHESTRATOR));
    for (const banned of ['for (', 'for(', 'while (', 'while(', '.retry', 'attempt++', 'attempts++']) {
      assert.equal(code.includes(banned), false, banned);
    }
  });
});

/* ================================================================== */
/* K. Privacy                                                          */
/* ================================================================== */

describe('Orchestrator · K. 아무것도 새지 않는다', () => {
  it('실패 결과에 apiKey/researchResult 원문이 없다', async () => {
    const secretMarker = '표식-오케스트레이터-비밀-7c1';
    const researchResult = { ...validResearchResult(), researchQuestion: secretMarker };
    const wrongHash = `rres_${'9'.repeat(64)}`;

    const result = await runCandidateGenerationOrchestrator(
      { researchResultHash: wrongHash, researchResult },
      {
        apiKey: FAKE_API_KEY,
        fetchImpl: (async () => okResponse(successBody())) as unknown as typeof fetch,
        storeCandidate: async () => ({ ok: true, candidateHash: 'x' }),
      },
    );

    const dumped = JSON.stringify(result);
    assert.equal(dumped.includes(secretMarker), false);
    assert.equal(dumped.includes(FAKE_API_KEY), false);
  });

  it('성공 결과에는 category와 candidateHash만 있다', async () => {
    const researchResult = validResearchResult();
    const hash = await computeResearchResultHash(researchResult as never);

    const result = await runCandidateGenerationOrchestrator(
      { researchResultHash: hash, researchResult },
      {
        apiKey: FAKE_API_KEY,
        fetchImpl: (async () => okResponse(successBody())) as unknown as typeof fetch,
        storeCandidate: async () => ({ ok: true, candidateHash: 'stored-hash' }),
      },
    );

    assert.deepEqual(Object.keys(result).sort(), ['candidateHash', 'category']);
  });

  it('console을 쓰지 않는다', () => {
    const code = stripComments(read(ORCHESTRATOR));
    assert.equal(code.includes('console.'), false);
  });

  it('Deno.env나 실제 Supabase client 생성이 없다', () => {
    const code = stripComments(read(ORCHESTRATOR));
    for (const banned of ['Deno.env.get', 'Deno.env[', 'createClient(', 'Deno.serve']) {
      assert.equal(code.includes(banned), false, banned);
    }
  });
});

/* ================================================================== */
/* L. Frozen/immutable input                                           */
/* ================================================================== */

describe('Orchestrator · L. 얼린 입력', () => {
  it('얼린 researchResult로도 정상 동작하고 값이 바뀌지 않는다', async () => {
    const researchResult = Object.freeze({
      ...validResearchResult(),
      domainBoundaries: Object.freeze({ includedConcerns: Object.freeze(['생계 압박']), excludedOrAdjacentConcerns: Object.freeze([]) }),
      candidatePassages: Object.freeze([
        Object.freeze({
          ...validResearchResult().candidatePassages[0],
          reference: Object.freeze(PSALM_56),
        }),
      ]),
    });
    const hash = await computeResearchResultHash(researchResult as never);
    const before = JSON.stringify(researchResult);

    const result = await runCandidateGenerationOrchestrator(
      { researchResultHash: hash, researchResult },
      {
        apiKey: FAKE_API_KEY,
        fetchImpl: (async () => okResponse(successBody())) as unknown as typeof fetch,
        storeCandidate: async () => ({ ok: true, candidateHash: 'x' }),
      },
    );

    assert.equal(result.category, 'generated');
    assert.equal(JSON.stringify(researchResult), before);
  });
});

/* ================================================================== */
/* M. 기존 authority 복제 금지                                          */
/* ================================================================== */

describe('Orchestrator · M. 새 authority를 만들지 않는다', () => {
  it('HTTP 상태 숫자를 다시 나열하지 않는다', () => {
    const code = stripComments(read(ORCHESTRATOR));
    for (const banned of ['400', '401', '403', '404', '408', '429', '500', '503']) {
      assert.equal(code.includes(banned), false, banned);
    }
  });

  it('모델 이름·시간 제한·주소·환경변수 이름을 복제하지 않는다', () => {
    const code = stripComments(read(ORCHESTRATOR));
    for (const banned of ['gpt-5.6-sol', '60000', 'api.openai.com', 'OPENAI_API_KEY']) {
      assert.equal(code.includes(banned), false, banned);
    }
  });

  it('해시 알고리즘을 다시 구현하지 않는다', () => {
    const code = stripComments(read(ORCHESTRATOR));
    assert.equal(code.includes('SHA-256'), false);
    assert.equal(code.includes('digest('), false);
  });

  it('Candidate 15개 필드·transport 10-outcome 목록을 다시 나열하지 않는다', () => {
    const code = stripComments(read(ORCHESTRATOR));
    for (const banned of [
      'situationTags',
      'emotionTags',
      'theologicalInsight',
      'userExplanation',
      'prayerDirection',
      "'empty_response'",
      "'json_parse_failed'",
      "'provider_timeout'",
      "'model_refusal'",
    ]) {
      assert.equal(code.includes(banned), false, banned);
    }
  });

  it('실제 authority를 그대로 가져다 쓴다', () => {
    const code = stripComments(read(ORCHESTRATOR));
    for (const required of [
      'verifyCandidateGenerationLineage',
      'buildCandidateGenerationPrompt',
      'buildCandidateGenerationOpenAIRequestSpec',
      'callCandidateGenerationOpenAIFetchTransport',
      'buildPublishedContentCandidate',
      'canProceedToCandidateBuilder',
      'canProceedToCandidateStore',
    ]) {
      assert.ok(code.includes(required), required);
    }
  });
});
