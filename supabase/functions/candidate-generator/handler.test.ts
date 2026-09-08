/**
 * candidate-generator · 요청 처리 본체 테스트
 *
 * 실행: npm test
 *
 * 지키려는 것:
 *   권한 확인이 가장 먼저다. 통과 못 하면 본문도, DB도, 모델도 건드리지 않는다.
 *   받는 것은 지문 하나뿐이다. 그 밖의 어떤 모양도 DB에 가기 전에 거절된다.
 *   실제로 쓰는 연구 결과는 DB에서 지문으로 읽어 온 것뿐이다.
 *     호출자가 무엇을 함께 보내도 그것이 모델 입력이 되지 않는다.
 *   읽기가 실패하면 모델을 부르지 않는다.
 *   Store가 실패해도 다시 부르지 않는다.
 *   실패 응답 어디에도 토큰·지문 원문·연구 결과·글·원본 오류가 없다.
 *   CORS 헤더가 없다.
 *
 * 실제 DB·OpenAI·웹 호출은 하지 않는다. 부르는 일을 전부 가짜로 넣는다.
 * request validator, orchestration taxonomy, hash 계산, Builder 판단은
 * 재구현하지 않는다. 전부 committed authority를 그대로 부른다.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { handleCandidateGeneration, type HandlerDeps } from './handler.ts';
import { computeResearchResultHash } from '../_shared/research-result-store-contract.ts';
import {
  GET_RESEARCH_RESULT_FOR_CANDIDATE_GENERATION_RPC,
  type ResearchResultReadOutcome,
} from '../_shared/candidate-research-result-read-boundary-contract.ts';
import { STORE_PUBLISHED_CONTENT_CANDIDATE_RPC } from '../_shared/published-content-store-contract.ts';
import type { CandidateGenerationStoreOutcome } from '../_shared/published-content-candidate-generation-orchestration-contract.ts';
import type { CandidateStoreInput } from '../_shared/published-content-store-contract.ts';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
/** 설명 주석에는 예시가 적혀 있으므로, 검사할 때는 주석을 뺀 코드만 본다. */
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '');

const INDEX = './index.ts';
const HANDLER = './handler.ts';

/* ------------------------------------------------------------------ */
/* fixtures — orchestrator/read-boundary 시험과 같은 모양               */
/* ------------------------------------------------------------------ */

const validResearchResult = () => ({
  targetDomain: 'financial_hardship',
  evidenceVersion: 4,
  prioritizerSnapshotId: `snap_${'b'.repeat(64)}`,
  researchQuestion: '성경은 이 삶의 문제를 어떤 본문에서 직접 다루는가?',
  domainBoundaries: { includedConcerns: ['생계 압박'], excludedOrAdjacentConcerns: [] },
  candidatePassages: [
    {
      reference: { book: 'Psalms', chapter: 56, startVerse: 3, endVerse: 4 },
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

/** OpenAI Responses API가 실제로 보내는 모양. */
const rawResponseBody = (envelopeInner: unknown) => ({
  status: 'completed',
  output: [{ content: [{ type: 'output_text', text: JSON.stringify({ response: envelopeInner }) }] }],
});

const successBody = () => rawResponseBody({ decision: 'generate', draft: draft() });
const deferBody = () => rawResponseBody({ decision: 'defer', reason: 'needs_more_research' });

type FakeResponse = { ok: boolean; status: number; json: () => Promise<unknown> };
const okResponse = (body: unknown): FakeResponse => ({ ok: true, status: 200, json: async () => body });
const httpErrorResponse = (status: number): FakeResponse => ({
  ok: false,
  status,
  json: async () => {
    throw new Error('본문을 열지 않아야 하는데 열렸습니다.');
  },
});

const FAKE_API_KEY = 'sk-test-key-not-real';
const TOKEN = 'test-internal-token-not-real';

type Recorder = { calls: unknown[][] };
const recorder = (): Recorder => ({ calls: [] });

/** 저장된 연구 결과를 흉내 낸다. 실제 DB를 부르지 않는다. */
function makeReadResearchResult(
  rec: Recorder,
  outcome: ResearchResultReadOutcome | ((hash: string) => ResearchResultReadOutcome),
): (hash: string) => Promise<ResearchResultReadOutcome> {
  return async (hash: string) => {
    rec.calls.push([hash]);
    return typeof outcome === 'function' ? outcome(hash) : outcome;
  };
}

function makeFakeFetch(rec: Recorder, respond: () => FakeResponse | Promise<FakeResponse>) {
  return (async (...args: unknown[]) => {
    rec.calls.push(args);
    return respond();
  }) as unknown as typeof fetch;
}

function makeFakeStore(
  rec: Recorder,
  outcome: CandidateGenerationStoreOutcome,
): (input: CandidateStoreInput) => Promise<CandidateGenerationStoreOutcome> {
  return async (input: CandidateStoreInput) => {
    rec.calls.push([input]);
    return outcome;
  };
}

const request = (options: { method?: string; token?: string | null; body?: unknown } = {}) => {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.token !== null) headers['x-internal-token'] = options.token ?? TOKEN;

  const method = options.method ?? 'POST';
  return new Request('https://example.functions.supabase.co/candidate-generator', {
    method,
    headers,
    body: method === 'GET' || method === 'HEAD' ? undefined : JSON.stringify(options.body ?? {}),
  });
};

/** 인가는 항상 통과시키는 기본 deps. 개별 시험이 필요한 부분만 덮어쓴다. */
function baseDeps(overrides: Partial<HandlerDeps> = {}): HandlerDeps {
  return {
    isAuthorized: (req) => req.headers.get('x-internal-token') === TOKEN,
    readResearchResult: async () => ({ ok: false, reason: 'not_found' }),
    apiKey: FAKE_API_KEY,
    storeCandidate: async () => ({ ok: false }),
    ...overrides,
  };
}

/* ================================================================== */
/* A. method                                                           */
/* ================================================================== */

describe('candidate-generator · A. method', () => {
  it('POST가 아니면 405, read/provider/store 0', async () => {
    const readRec = recorder();
    const fetchRec = recorder();
    const storeRec = recorder();

    const res = await handleCandidateGeneration(
      request({ method: 'GET' }),
      baseDeps({
        readResearchResult: makeReadResearchResult(readRec, { ok: false, reason: 'not_found' }),
        fetchImpl: makeFakeFetch(fetchRec, () => okResponse(successBody())),
        storeCandidate: makeFakeStore(storeRec, { ok: true, candidateHash: 'x' }),
      }),
    );

    assert.equal(res.status, 405);
    assert.deepEqual(await res.json(), { ok: false, error: 'METHOD_NOT_ALLOWED' });
    assert.equal(readRec.calls.length, 0);
    assert.equal(fetchRec.calls.length, 0);
    assert.equal(storeRec.calls.length, 0);
  });

  it('OPTIONS도 특별 취급 없이 405', async () => {
    const res = await handleCandidateGeneration(request({ method: 'OPTIONS' }), baseDeps());
    assert.equal(res.status, 405);
  });
});

/* ================================================================== */
/* B. unauthorized                                                     */
/* ================================================================== */

describe('candidate-generator · B. 권한', () => {
  it('토큰이 틀리면 401, 본문/데이터 경로 0', async () => {
    const readRec = recorder();
    const fetchRec = recorder();
    const storeRec = recorder();

    const res = await handleCandidateGeneration(
      request({ token: 'wrong-token' }),
      baseDeps({
        readResearchResult: makeReadResearchResult(readRec, { ok: false, reason: 'not_found' }),
        fetchImpl: makeFakeFetch(fetchRec, () => okResponse(successBody())),
        storeCandidate: makeFakeStore(storeRec, { ok: true, candidateHash: 'x' }),
      }),
    );

    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { ok: false, error: 'UNAUTHORIZED' });
    assert.equal(readRec.calls.length, 0);
    assert.equal(fetchRec.calls.length, 0);
    assert.equal(storeRec.calls.length, 0);
  });

  it('토큰이 없으면 401, 본문을 읽지 않는다', async () => {
    let bodyRead = false;
    const req = request({ token: null });
    const originalJson = req.json.bind(req);
    req.json = async () => {
      bodyRead = true;
      return originalJson();
    };

    const res = await handleCandidateGeneration(req, baseDeps());
    assert.equal(res.status, 401);
    assert.equal(bodyRead, false);
  });
});

/* ================================================================== */
/* C. invalid JSON                                                     */
/* ================================================================== */

describe('candidate-generator · C. 잘못된 JSON', () => {
  it('본문 parse 실패 → 400, read/provider/store 0', async () => {
    const readRec = recorder();
    const fetchRec = recorder();
    const storeRec = recorder();

    const req = new Request('https://example.functions.supabase.co/candidate-generator', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-token': TOKEN },
      body: '{not valid json',
    });

    const res = await handleCandidateGeneration(
      req,
      baseDeps({
        readResearchResult: makeReadResearchResult(readRec, { ok: false, reason: 'not_found' }),
        fetchImpl: makeFakeFetch(fetchRec, () => okResponse(successBody())),
        storeCandidate: makeFakeStore(storeRec, { ok: true, candidateHash: 'x' }),
      }),
    );

    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { ok: false, error: 'INVALID_JSON' });
    assert.equal(readRec.calls.length, 0);
    assert.equal(fetchRec.calls.length, 0);
    assert.equal(storeRec.calls.length, 0);
  });
});

/* ================================================================== */
/* D~G. invalid request shapes                                         */
/* ================================================================== */

describe('candidate-generator · D~G. 받을 수 없는 요청 모양', () => {
  const cases: Array<[string, unknown]> = [
    ['지문이 없다', {}],
    ['지문 모양이 틀렸다', { researchResultHash: 'not-a-hash' }],
    ['모르는 필드가 함께 왔다', { researchResultHash: `rres_${'a'.repeat(64)}`, extra: 1 }],
    [
      '연구 결과 전체가 함께 왔다',
      { researchResultHash: `rres_${'a'.repeat(64)}`, researchResult: validResearchResult() },
    ],
  ];

  for (const [label, body] of cases) {
    it(`${label} → 400, read 0`, async () => {
      const readRec = recorder();
      const fetchRec = recorder();
      const storeRec = recorder();

      const res = await handleCandidateGeneration(
        request({ body }),
        baseDeps({
          readResearchResult: makeReadResearchResult(readRec, { ok: false, reason: 'not_found' }),
          fetchImpl: makeFakeFetch(fetchRec, () => okResponse(successBody())),
          storeCandidate: makeFakeStore(storeRec, { ok: true, candidateHash: 'x' }),
        }),
      );

      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { ok: false, error: 'INVALID_REQUEST' });
      assert.equal(readRec.calls.length, 0);
      assert.equal(fetchRec.calls.length, 0);
      assert.equal(storeRec.calls.length, 0);
    });
  }
});

/* ================================================================== */
/* H~I. read outcomes                                                  */
/* ================================================================== */

describe('candidate-generator · H~I. 연구 결과 읽기 실패', () => {
  it('not_found → 404, provider/store 0', async () => {
    const readRec = recorder();
    const fetchRec = recorder();
    const storeRec = recorder();
    const hash = `rres_${'a'.repeat(64)}`;

    const res = await handleCandidateGeneration(
      request({ body: { researchResultHash: hash } }),
      baseDeps({
        readResearchResult: makeReadResearchResult(readRec, { ok: false, reason: 'not_found' }),
        fetchImpl: makeFakeFetch(fetchRec, () => okResponse(successBody())),
        storeCandidate: makeFakeStore(storeRec, { ok: true, candidateHash: 'x' }),
      }),
    );

    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { ok: false, error: 'RESEARCH_RESULT_NOT_FOUND' });
    assert.deepEqual(readRec.calls, [[hash]]);
    assert.equal(fetchRec.calls.length, 0);
    assert.equal(storeRec.calls.length, 0);
  });

  it('read_unavailable → 503, provider/store 0', async () => {
    const readRec = recorder();
    const fetchRec = recorder();
    const storeRec = recorder();
    const hash = `rres_${'a'.repeat(64)}`;

    const res = await handleCandidateGeneration(
      request({ body: { researchResultHash: hash } }),
      baseDeps({
        readResearchResult: makeReadResearchResult(readRec, { ok: false, reason: 'read_unavailable' }),
        fetchImpl: makeFakeFetch(fetchRec, () => okResponse(successBody())),
        storeCandidate: makeFakeStore(storeRec, { ok: true, candidateHash: 'x' }),
      }),
    );

    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { ok: false, error: 'RESEARCH_RESULT_UNAVAILABLE' });
    assert.equal(fetchRec.calls.length, 0);
    assert.equal(storeRec.calls.length, 0);
  });
});

/* ================================================================== */
/* J. authoritative read                                               */
/* ================================================================== */

describe('candidate-generator · J. 읽어 온 값만 쓴다', () => {
  it('호출자가 보낸 값은 애초에 존재하지 않고, DB 값만 provider에 전달된다', async () => {
    const researchResult = validResearchResult();
    const hash = await computeResearchResultHash(researchResult as never);
    const readRec = recorder();
    const fetchRec = recorder();
    const storeRec = recorder();

    // 호출자는 지문 하나만 보낸다. researchResult를 실어 보낼 방법이 없다(4단계에서 거절됨).
    const res = await handleCandidateGeneration(
      request({ body: { researchResultHash: hash } }),
      baseDeps({
        readResearchResult: makeReadResearchResult(readRec, { ok: true, researchResultHash: hash, researchResult: researchResult as never }),
        fetchImpl: makeFakeFetch(fetchRec, () => okResponse(successBody())),
        storeCandidate: makeFakeStore(storeRec, { ok: true, candidateHash: 'stored-hash' }),
      }),
    );

    assert.equal(res.status, 200);
    assert.deepEqual(readRec.calls, [[hash]]);
    // 실제로 provider가 불렸다는 것 자체가, lineage 재확인이
    // DB에서 읽어 온 값을 갖고 통과했다는 뜻이다(다른 값이면 preflight에서 멈춘다).
    assert.equal(fetchRec.calls.length, 1);
  });
});

/* ================================================================== */
/* K~O. orchestration category → HTTP                                  */
/* ================================================================== */

describe('candidate-generator · K. 정상 생성', () => {
  it('provider 1 · store 1 · 200 · candidateHash만', async () => {
    const researchResult = validResearchResult();
    const hash = await computeResearchResultHash(researchResult as never);
    const readRec = recorder();
    const fetchRec = recorder();
    const storeRec = recorder();

    const res = await handleCandidateGeneration(
      request({ body: { researchResultHash: hash } }),
      baseDeps({
        readResearchResult: makeReadResearchResult(readRec, { ok: true, researchResultHash: hash, researchResult: researchResult as never }),
        fetchImpl: makeFakeFetch(fetchRec, () => okResponse(successBody())),
        storeCandidate: makeFakeStore(storeRec, { ok: true, candidateHash: 'stored-hash' }),
      }),
    );

    assert.equal(res.status, 200);
    const json = await res.json();
    assert.deepEqual(json, { ok: true, candidateHash: 'stored-hash' });
    assert.equal(fetchRec.calls.length, 1);
    assert.equal(storeRec.calls.length, 1);
  });
});

describe('candidate-generator · L. deferred', () => {
  it('provider 1 · store 0 · 200 deferred', async () => {
    const researchResult = validResearchResult();
    const hash = await computeResearchResultHash(researchResult as never);
    const readRec = recorder();
    const fetchRec = recorder();
    const storeRec = recorder();

    const res = await handleCandidateGeneration(
      request({ body: { researchResultHash: hash } }),
      baseDeps({
        readResearchResult: makeReadResearchResult(readRec, { ok: true, researchResultHash: hash, researchResult: researchResult as never }),
        fetchImpl: makeFakeFetch(fetchRec, () => okResponse(deferBody())),
        storeCandidate: makeFakeStore(storeRec, { ok: true, candidateHash: 'unused' }),
      }),
    );

    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, category: 'deferred' });
    assert.equal(fetchRec.calls.length, 1);
    assert.equal(storeRec.calls.length, 0);
  });
});

describe('candidate-generator · M. 모델 호출 실패', () => {
  it('store 0 · 503 일반화', async () => {
    const researchResult = validResearchResult();
    const hash = await computeResearchResultHash(researchResult as never);
    const readRec = recorder();
    const fetchRec = recorder();
    const storeRec = recorder();

    const res = await handleCandidateGeneration(
      request({ body: { researchResultHash: hash } }),
      baseDeps({
        readResearchResult: makeReadResearchResult(readRec, { ok: true, researchResultHash: hash, researchResult: researchResult as never }),
        fetchImpl: makeFakeFetch(fetchRec, () => httpErrorResponse(500)),
        storeCandidate: makeFakeStore(storeRec, { ok: true, candidateHash: 'unused' }),
      }),
    );

    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { ok: false, error: 'CANDIDATE_GENERATION_UNAVAILABLE' });
    assert.equal(storeRec.calls.length, 0);
  });
});

describe('candidate-generator · N. 조립 실패', () => {
  it('본문 없는 초안(조립 실패) → store 0 · 500 일반화', async () => {
    // draft가 조립을 통과하지 못하도록 필수 필드를 비운다.
    const researchResult = validResearchResult();
    const hash = await computeResearchResultHash(researchResult as never);
    const readRec = recorder();
    const fetchRec = recorder();
    const storeRec = recorder();

    const brokenBody = rawResponseBody({
      decision: 'generate',
      draft: draft({ situationTags: [] }),
    });

    const res = await handleCandidateGeneration(
      request({ body: { researchResultHash: hash } }),
      baseDeps({
        readResearchResult: makeReadResearchResult(readRec, { ok: true, researchResultHash: hash, researchResult: researchResult as never }),
        fetchImpl: makeFakeFetch(fetchRec, () => okResponse(brokenBody)),
        storeCandidate: makeFakeStore(storeRec, { ok: true, candidateHash: 'unused' }),
      }),
    );

    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { ok: false, error: 'CANDIDATE_PROCESSING_FAILED' });
    assert.equal(storeRec.calls.length, 0);
  });
});

describe('candidate-generator · O. 적어 두기 실패', () => {
  it('provider 1 · store 1 · retry 0 · 500 일반화 · DB 상세 없음', async () => {
    const researchResult = validResearchResult();
    const hash = await computeResearchResultHash(researchResult as never);
    const readRec = recorder();
    const fetchRec = recorder();
    const storeRec = recorder();

    const res = await handleCandidateGeneration(
      request({ body: { researchResultHash: hash } }),
      baseDeps({
        readResearchResult: makeReadResearchResult(readRec, { ok: true, researchResultHash: hash, researchResult: researchResult as never }),
        fetchImpl: makeFakeFetch(fetchRec, () => okResponse(successBody())),
        storeCandidate: makeFakeStore(storeRec, { ok: false }),
      }),
    );

    assert.equal(res.status, 500);
    const json = await res.json();
    assert.deepEqual(json, { ok: false, error: 'CANDIDATE_PROCESSING_FAILED' });
    assert.equal(fetchRec.calls.length, 1);
    assert.equal(storeRec.calls.length, 1);
  });
});

/* ================================================================== */
/* P. 읽기 이후 lineage 재확인 실패                                     */
/* ================================================================== */

describe('candidate-generator · P. 읽기 이후 지문이 어긋나면', () => {
  it('DB가 돌려준 지문과 값이 어긋나면 provider 0 · 500 일반화', async () => {
    // 있을 수 없는 상황을 흉내 낸다: 요청한 지문과 DB가 돌려준 연구 내용이 서로 다르다.
    const researchResult = validResearchResult();
    const requestedHash = `rres_${'f'.repeat(64)}`; // 실제 researchResult의 지문이 아니다.
    const readRec = recorder();
    const fetchRec = recorder();
    const storeRec = recorder();

    const res = await handleCandidateGeneration(
      request({ body: { researchResultHash: requestedHash } }),
      baseDeps({
        readResearchResult: makeReadResearchResult(readRec, {
          ok: true,
          researchResultHash: requestedHash,
          researchResult: researchResult as never,
        }),
        fetchImpl: makeFakeFetch(fetchRec, () => okResponse(successBody())),
        storeCandidate: makeFakeStore(storeRec, { ok: true, candidateHash: 'unused' }),
      }),
    );

    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { ok: false, error: 'CANDIDATE_PROCESSING_FAILED' });
    assert.equal(fetchRec.calls.length, 0);
    assert.equal(storeRec.calls.length, 0);
  });
});

/* ================================================================== */
/* Q. 비밀/상세 유출 없음                                               */
/* ================================================================== */

describe('candidate-generator · Q. 실패 응답에 상세가 없다', () => {
  it('모든 실패 응답 body는 {ok:false, error:<코드>} 뿐이다', async () => {
    const researchResult = validResearchResult();
    const hash = await computeResearchResultHash(researchResult as never);

    const scenarios: Array<[string, HandlerDeps]> = [
      ['method', baseDeps()],
      ['auth', baseDeps()],
      [
        'not_found',
        baseDeps({
          readResearchResult: async () => ({ ok: false, reason: 'not_found' }),
        }),
      ],
      [
        'read_unavailable',
        baseDeps({
          readResearchResult: async () => ({ ok: false, reason: 'read_unavailable' }),
        }),
      ],
      [
        'generation_failure',
        baseDeps({
          readResearchResult: async () => ({ ok: true, researchResultHash: hash, researchResult: researchResult as never }),
          fetchImpl: (async () => httpErrorResponse(500)) as unknown as typeof fetch,
        }),
      ],
      [
        'store_failure',
        baseDeps({
          readResearchResult: async () => ({ ok: true, researchResultHash: hash, researchResult: researchResult as never }),
          fetchImpl: (async () => okResponse(successBody())) as unknown as typeof fetch,
          storeCandidate: async () => ({ ok: false }),
        }),
      ],
    ];

    for (const [label, deps] of scenarios) {
      const req =
        label === 'method'
          ? request({ method: 'GET' })
          : label === 'auth'
            ? request({ token: 'wrong' })
            : request({ body: { researchResultHash: hash } });

      const res = await handleCandidateGeneration(req, deps);
      const json = (await res.json()) as Record<string, unknown>;

      assert.equal(json.ok, false, label);
      assert.deepEqual(Object.keys(json).sort(), ['error', 'ok'], label);
      const text = JSON.stringify(json);
      for (const secret of [TOKEN, FAKE_API_KEY, hash, '생계', 'situationTags']) {
        assert.equal(text.includes(secret), false, `${label} leaked ${secret}`);
      }
    }
  });
});

/* ================================================================== */
/* R. CORS 없음                                                        */
/* ================================================================== */

describe('candidate-generator · R. CORS', () => {
  it('CORS 관련 헤더가 없다', async () => {
    const res = await handleCandidateGeneration(request({ method: 'GET' }), baseDeps());
    for (const header of res.headers.keys()) {
      assert.equal(header.toLowerCase().startsWith('access-control-'), false, header);
    }
  });
});

/* ================================================================== */
/* S. 성공 응답에 Candidate 본문 없음                                   */
/* ================================================================== */

describe('candidate-generator · S. 성공 응답 최소화', () => {
  it('generated 응답에 candidateHash 외 다른 값이 없다', async () => {
    const researchResult = validResearchResult();
    const hash = await computeResearchResultHash(researchResult as never);

    const res = await handleCandidateGeneration(
      request({ body: { researchResultHash: hash } }),
      baseDeps({
        readResearchResult: async () => ({ ok: true, researchResultHash: hash, researchResult: researchResult as never }),
        fetchImpl: (async () => okResponse(successBody())) as unknown as typeof fetch,
        storeCandidate: async () => ({ ok: true, candidateHash: 'stored-hash' }),
      }),
    );

    const json = (await res.json()) as Record<string, unknown>;
    assert.deepEqual(Object.keys(json).sort(), ['candidateHash', 'ok']);
  });
});

/* ================================================================== */
/* T. index.ts 정적 검사                                                */
/* ================================================================== */

describe('candidate-generator · T. index.ts 배선', () => {
  const indexSrc = stripComments(read(INDEX));
  const handlerSrc = stripComments(read(HANDLER));

  it('필요한 env 이름이 정확히 넷이다', () => {
    const envReads = [...indexSrc.matchAll(/Deno\.env\.get\('([^']+)'\)/g)].map((m) => m[1]);
    assert.deepEqual(
      Array.from(new Set(envReads)).sort(),
      ['CANDIDATE_GENERATOR_TOKEN', 'OPENAI_API_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_URL'].sort(),
    );
  });

  it('handler.ts는 Deno.env를 읽지 않는다', () => {
    assert.equal(handlerSrc.includes('Deno.env'), false);
  });

  it('RPC 이름을 상수에서 가져와 쓴다(하드코딩 문자열이 아니다)', () => {
    assert.ok(indexSrc.includes('GET_RESEARCH_RESULT_FOR_CANDIDATE_GENERATION_RPC'));
    assert.ok(indexSrc.includes('STORE_PUBLISHED_CONTENT_CANDIDATE_RPC'));
    assert.equal(indexSrc.includes(`'${GET_RESEARCH_RESULT_FOR_CANDIDATE_GENERATION_RPC}'`), false);
    assert.equal(indexSrc.includes(`'${STORE_PUBLISHED_CONTENT_CANDIDATE_RPC}'`), false);
  });

  it('Read RPC 인자 이름이 정확히 p_research_result_hash다', () => {
    assert.ok(indexSrc.includes('p_research_result_hash'));
  });

  it('Store RPC 인자 이름이 정확히 셋이다', () => {
    for (const param of ['p_candidate_hash', 'p_research_result_hash', 'p_candidate']) {
      assert.ok(indexSrc.includes(param), param);
    }
  });

  it('retry loop이 없다', () => {
    for (const banned of ['for (', 'while (', '.retry(']) {
      assert.equal(indexSrc.includes(banned), false, banned);
      assert.equal(handlerSrc.includes(banned), false, banned);
    }
  });

  it('CORS를 추가하지 않는다', () => {
    assert.equal(indexSrc.toLowerCase().includes('cors'), false);
    assert.equal(handlerSrc.toLowerCase().includes('cors'), false);
    assert.equal(indexSrc.toLowerCase().includes('access-control'), false);
  });

  it('OpenAI 주소를 index.ts가 직접 갖지 않는다(transport가 소유)', () => {
    assert.equal(indexSrc.includes('api.openai.com'), false);
  });

  it('Candidate Builder를 index.ts/handler.ts가 직접 부르지 않는다', () => {
    assert.equal(indexSrc.includes('buildPublishedContentCandidate'), false);
    assert.equal(handlerSrc.includes('buildPublishedContentCandidate'), false);
  });

  it('Candidate hash를 index.ts/handler.ts가 다시 계산하지 않는다', () => {
    assert.equal(indexSrc.includes('computeResearchResultHash'), false);
    assert.equal(handlerSrc.includes('computeResearchResultHash'), false);
  });

  it('production project ref나 실제 URL을 하드코딩하지 않는다', () => {
    assert.equal(/https:\/\/[a-z0-9-]+\.supabase\.co/.test(indexSrc), false);
  });

  it('실제 비밀 값을 리터럴로 담지 않는다(Deno.env.get 형태로만 읽는다)', () => {
    assert.equal(/sk-[a-zA-Z0-9]{10,}/.test(indexSrc), false);
  });

  it('handler.ts는 orchestrator를 새로 만들지 않고 기존 함수를 그대로 부른다', () => {
    const occurrences = handlerSrc.split('runCandidateGenerationOrchestrator(').length - 1;
    assert.equal(occurrences, 1);
  });
});
