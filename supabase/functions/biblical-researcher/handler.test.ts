/**
 * biblical-researcher · 요청 처리 본체 테스트
 *
 * 실행: npm test
 *
 * 지키려는 것:
 *   받는 것은 번호 하나뿐이다.
 *   준비가 안 됐으면 꾸러미를 태우지 않는다.
 *   꺼낸 것을 그대로 믿지 않는다.
 *   한 번 꺼낸 꾸러미를 되살리지 않는다.
 *   번호·꾸러미·원본 오류가 밖으로도 기록에도 나가지 않는다.
 *
 * 실제 DB·OpenAI·웹 호출은 하지 않는다. 부르는 일을 전부 가짜로 넣는다.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { handleBiblicalResearch, parseResearchRequest } from './handler.ts';
import {
  CONSUME_BIBLICAL_RESEARCH_HANDOFF_RPC,
  CREATE_BIBLICAL_RESEARCH_HANDOFF_RPC,
} from '../_shared/biblical-research-handoff-store.ts';
import {
  buildBiblicalResearchHandoff,
  type BiblicalResearchHandoff,
} from '../_shared/biblical-research-handoff.ts';
import { computeSourceId } from '../_shared/source-harvester.ts';
import { computeActiveCoveredHash } from '../_shared/harvest-recovery-ticket.ts';
import { getActiveCoveredDomains } from '../_shared/research-prioritizer-edge.ts';
import { BIBLICAL_RESEARCH_MODEL_TIMEOUT_MS } from '../_shared/biblical-researcher-runtime-policy.ts';
import type { BiblicalResearchTransportResult } from '../_shared/biblical-researcher-runtime-contract.ts';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
/** 설명 주석에는 예시가 적혀 있으므로, 검사할 때는 주석을 뺀 코드만 본다. */
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '');

const TOKEN = 'test-internal-token-not-real';
const API_KEY = 'test-openai-key-not-real';
const HANDOFF_ID = '3f2a1b4c-5d6e-4f70-8901-a2b3c4d5e6f7';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const request = (options: { method?: string; token?: string | null; body?: unknown } = {}) => {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.token !== null) headers['x-internal-token'] = options.token ?? TOKEN;

  const method = options.method ?? 'POST';
  return new Request('https://example.functions.supabase.co/biblical-researcher', {
    method,
    headers,
    body:
      method === 'GET' || method === 'HEAD'
        ? undefined
        : typeof options.body === 'string'
          ? options.body
          : JSON.stringify(options.body ?? { handoffId: HANDOFF_ID }),
  });
};

/* ------------------------------------------------------------------ */
/* 진짜 꾸러미 하나 (만드는 함수로 만든다. 손으로 짜지 않는다)            */
/* ------------------------------------------------------------------ */

const SNAPSHOT = `snap_${'a'.repeat(64)}`;
const DOMAIN = 'financial_hardship';
const PASSAGES = [
  { book: 'Psalms', chapter: 42, startVerse: 5, endVerse: 5 },
  { book: 'Psalms', chapter: 62, startVerse: 8, endVerse: 8 },
  { book: 'Psalms', chapter: 121, startVerse: 1, endVerse: 2 },
];
const url = (index: number) => `https://sources.example.org/aroeda/researcher-${index}`;
const SOURCE_IDS = await Promise.all(
  Array.from({ length: 5 }, (_, index) => computeSourceId(url(index))),
);
const sid = (index: number) => SOURCE_IDS[index] as string;
const STATEMENT = '이 자료는 본문의 흐름과 그 신학적 자리를 함께 설명한다고 관찰되었다. 충분히 긴 문장이다.';

const SPECS = [
  {
    type: 'commentary',
    publisher: 'Fixture Academic Press',
    uses: ['exegesis'],
    access: 'full_text',
    claims: PASSAGES.map((passage) => ({ use: 'exegesis', refs: [{ ...passage }] })),
  },
  {
    type: 'biblical_theology',
    publisher: 'Fixture University Press',
    uses: ['doctrinal_context'],
    access: 'substantial_preview',
    claims: [{ use: 'doctrinal_context', refs: [] }],
  },
  {
    type: 'academic_article',
    publisher: 'Fixture Journal',
    uses: ['exegesis'],
    access: 'full_text',
    claims: [{ use: 'exegesis', refs: [{ ...PASSAGES[0] }] }],
  },
  {
    type: 'pastoral_resource',
    publisher: 'Fixture Seminary',
    uses: ['pastoral_application'],
    access: 'full_text',
    claims: [{ use: 'pastoral_application', refs: [] }],
  },
  {
    type: 'professional_context',
    publisher: 'Fixture Public Health Agency',
    uses: ['pastoral_safety'],
    access: 'full_text',
    claims: [{ use: 'pastoral_safety', refs: [] }],
  },
];

const outcome = await buildBiblicalResearchHandoff({
  harvest: {
    targetDomain: DOMAIN,
    evidenceVersion: 4,
    prioritizerSnapshotId: SNAPSHOT,
    sources: SPECS.map((spec, index) => ({
      sourceId: sid(index),
      sourceType: spec.type,
      title: `연구 자료 ${index}`,
      authorOrOrganization: `연구자 ${index}`,
      publisherOrInstitution: spec.publisher,
      publicationYear: 2018 + index,
      url: url(index),
      accessedAt: '2026-09-03',
      accessLevel: spec.access,
      intendedUse: [...spec.uses],
      relevanceNote: '이 영역의 문맥을 확인하는 데 필요합니다.',
      evidenceClaims: spec.claims.map((claim, claimIndex) => ({
        evidenceId: `${sid(index)}:e${claimIndex + 1}`,
        intendedUse: claim.use,
        statement: `${STATEMENT} (${index}-${claimIndex})`,
        passageReferences: claim.refs,
      })),
    })),
    rejectedSources: [
      { url: url(90), title: '익명 묵상글', rejectionReason: 'anonymous_or_unverifiable' },
    ],
    unresolvedSourceQuestions: ['더 볼 자료가 있는가'],
  } as never,
  activeCoveredDomains: getActiveCoveredDomains(),
});
assert.equal(outcome.ok, true, outcome.ok ? '' : outcome.errors.join(' / '));
if (!outcome.ok) throw new Error('handoff fixture failed');
const HANDOFF: BiblicalResearchHandoff = outcome.handoff;
/** 표에서 나온 것처럼 이름 없는 값으로 되돌린다. */
const STORED = () => JSON.parse(JSON.stringify(HANDOFF)) as unknown;

/* ------------------------------------------------------------------ */
/* 모델이 돌려주는 올바른 답 하나                                        */
/* ------------------------------------------------------------------ */

const candidate = (index: number) => ({
  reference: { ...PASSAGES[index] },
  additionalReferences: [],
  canonicalContext: `이 본문은 앞뒤 문맥에서 무엇을 말하고 있는지 설명합니다 (${index}).`,
  theologicalContribution: `이 본문이 성경 전체에서 하는 일을 설명합니다 (${index}).`,
  domainFit: `이 영역의 실제 어려움과 어떻게 맞닿는지 설명합니다 (${index}).`,
  pastoralUse: ['이렇게 읽어 주면 도움이 됩니다.'],
  misuseRisks: ['이렇게 쓰면 본문을 잘못 쓰는 것입니다.'],
  distinctnessFromActiveCoverage: {
    distinct: true,
    nearestExistingDomain: null,
    explanation: '기존 영역과 무엇이 다른지 설명합니다.',
  },
  researchConfidence: 0.7,
  sourceSupport: {
    exegesisEvidenceIds: [`${sid(0)}:e${index + 1}`],
    theologyEvidenceIds: [`${sid(1)}:e1`],
    pastoralEvidenceIds: [`${sid(3)}:e1`],
    safetyEvidenceIds: [`${sid(4)}:e1`],
  },
});

const validDraft = () => ({
  targetDomain: DOMAIN,
  evidenceVersion: 4,
  prioritizerSnapshotId: SNAPSHOT,
  researchQuestion: '이 영역에서 붙들 말씀은 무엇인가.',
  domainBoundaries: {
    includedConcerns: ['생계가 흔들리는 상황'],
    excludedOrAdjacentConcerns: ['직장 안에서의 갈등'],
  },
  candidatePassages: [candidate(0), candidate(1), candidate(2)],
  rejectedPassages: [
    {
      reference: { book: 'Philippians', chapter: 4, startVerse: 13, endVerse: 13 },
      rejectionReason: '이 영역의 어려움을 다루는 본문이 아닙니다.',
      riskCategory: 'prosperity_risk',
    },
  ],
  unresolvedQuestions: [],
});

const completedWith = (text: string) => ({
  status: 'completed',
  output: [
    { type: 'reasoning', summary: [] },
    { type: 'message', content: [{ type: 'output_text', text }] },
  ],
});

/* ------------------------------------------------------------------ */
/* 가짜 바깥 연결                                                       */
/* ------------------------------------------------------------------ */

type Options = {
  token?: string | null;
  apiKey?: string | undefined;
  withoutConsumeDep?: boolean;
  consumeThrows?: boolean;
  /** 표가 돌려주는 것. 기본은 진짜 꾸러미. */
  consumeReturns?: unknown;
  /** 모델이 돌려주는 것. 기본은 올바른 답. */
  modelResult?: BiblicalResearchTransportResult;
};

const makeDeps = (options: Options = {}) => {
  const consumeCallList: { functionName: string; params: Record<string, unknown> }[] = [];
  const transportCalls: { request: Record<string, unknown>; options: { timeoutMs: number } }[] = [];
  const transportsMade: number[] = [];
  const logged: string[] = [];

  const consumeHandoff = async (
    functionName: string,
    params: Record<string, unknown>,
  ): Promise<unknown> => {
    consumeCallList.push({ functionName, params });
    if (options.consumeThrows) throw new Error('handoff_rpc_http_500');
    return 'consumeReturns' in options ? options.consumeReturns : STORED();
  };

  return {
    consumeCallList,
    transportCalls,
    logged,
    get consumeCalls() {
      return consumeCallList.length;
    },
    get modelCalls() {
      return transportCalls.length;
    },
    get transportsMade() {
      return transportsMade.length;
    },
    deps: {
      isAuthorized: async (incoming: Request) =>
        incoming.headers.get('x-internal-token') === ('token' in options ? options.token : TOKEN),
      getApiKey: () => ('apiKey' in options ? options.apiKey : API_KEY),
      createTransport: (apiKey: string) => {
        transportsMade.push(1);
        assert.equal(apiKey, API_KEY);
        return async (
          req: Record<string, unknown>,
          opts: { timeoutMs: number },
        ): Promise<BiblicalResearchTransportResult> => {
          transportCalls.push({ request: req, options: opts });
          return (
            options.modelResult ?? {
              ok: true,
              response: completedWith(JSON.stringify(validDraft())),
            }
          );
        };
      },
      ...(options.withoutConsumeDep ? {} : { consumeHandoff }),
      log: (message: string) => logged.push(message),
      requestId: () => 'testreq',
    },
  };
};

const run = async (options: Options = {}, bodyOverride?: unknown) => {
  const fake = makeDeps(options);
  const response = await handleBiblicalResearch(
    request(bodyOverride === undefined ? {} : { body: bodyOverride }),
    fake.deps,
  );
  const text = await response.text();
  return { fake, response, text, parsed: JSON.parse(text) as Record<string, unknown> };
};

/* ================================================================== */
/* A. 받는 것은 번호 하나뿐                                            */
/* ================================================================== */

describe('biblical-researcher · 받는 것은 번호 하나뿐', () => {
  it('올바른 번호 하나만 통과한다', () => {
    const parsedOk = parseResearchRequest({ handoffId: HANDOFF_ID });
    assert.equal(parsedOk.ok, true);
    if (parsedOk.ok) assert.equal(parsedOk.input.handoffId, HANDOFF_ID);
  });

  it('자료·근거·출처를 다시 보낼 수 없다', async () => {
    for (const extra of [
      'sources',
      'evidenceSetHash',
      'targetDomain',
      'evidenceVersion',
      'prioritizerSnapshotId',
      'activeCoveredDomains',
      'evidenceClaims',
      'decisionId',
      'recoveryId',
      'handoff',
    ]) {
      const { response, parsed, fake } = await run({}, { handoffId: HANDOFF_ID, [extra]: 1 });
      assert.equal(response.status, 400, extra);
      assert.deepEqual(parsed, { ok: false, error: 'INVALID_REQUEST' });
      assert.equal(fake.consumeCalls, 0, extra);
      assert.equal(fake.modelCalls, 0, extra);
    }
  });

  it('번호가 없거나 모양이 다르면 거절한다', async () => {
    for (const body of [
      {},
      { handoffId: null },
      { handoffId: 42 },
      { handoffId: '' },
      { handoffId: 'not-a-uuid' },
      { handoffId: [HANDOFF_ID] },
      { handoffId: HANDOFF_ID.toUpperCase().replace(/-/g, '') },
      [],
      42,
      true,
    ]) {
      const { response, parsed, fake } = await run({}, body);
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.deepEqual(parsed, { ok: false, error: 'INVALID_REQUEST' });
      assert.equal(fake.consumeCalls, 0);
      assert.equal(fake.modelCalls, 0);
    }
  });

  it('JSON이 아니면 거절하고 표를 건드리지 않는다', async () => {
    const fake = makeDeps();
    const response = await handleBiblicalResearch(request({ body: '{' }), fake.deps);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { ok: false, error: 'INVALID_JSON' });
    assert.equal(fake.consumeCalls, 0);
    assert.equal(fake.modelCalls, 0);
  });
});

/* ================================================================== */
/* B. 순서                                                             */
/* ================================================================== */

describe('biblical-researcher · 순서', () => {
  it('POST가 아니면 본문도 읽지 않는다', async () => {
    for (const method of ['GET', 'PUT', 'DELETE', 'OPTIONS', 'PATCH']) {
      const fake = makeDeps();
      const response = await handleBiblicalResearch(request({ method }), fake.deps);
      assert.equal(response.status, 405, method);
      assert.deepEqual(await response.json(), { ok: false, error: 'METHOD_NOT_ALLOWED' });
      assert.equal(fake.consumeCalls, 0);
      assert.equal(fake.modelCalls, 0);
    }
  });

  it('권한이 없으면 본문도 읽지 않고 표도 건드리지 않는다', async () => {
    for (const token of ['wrong-token', null]) {
      const fake = makeDeps();
      const response = await handleBiblicalResearch(
        request({ token: token as string | null, body: '{' }),
        fake.deps,
      );
      assert.equal(response.status, 401, String(token));
      assert.deepEqual(await response.json(), { ok: false, error: 'UNAUTHORIZED' });
      assert.equal(fake.consumeCalls, 0);
      assert.equal(fake.modelCalls, 0);
    }
  });

  it('API Key가 없으면 꾸러미를 태우지 않는다', async () => {
    for (const apiKey of [undefined, '', '   ']) {
      const { response, parsed, fake } = await run({ apiKey });
      assert.equal(response.status, 503, String(apiKey));
      assert.deepEqual(parsed, { ok: false, error: 'OPENAI_API_KEY_MISSING' });
      // 이것이 핵심이다. 준비가 안 된 채로 한 번짜리 번호를 태우지 않는다.
      assert.equal(fake.consumeCalls, 0);
      assert.equal(fake.modelCalls, 0);
    }
  });

  it('표를 부를 방법이 없어도 꾸러미를 태우지 않는다', async () => {
    const { response, parsed, fake } = await run({ withoutConsumeDep: true });
    assert.equal(response.status, 503);
    assert.deepEqual(parsed, { ok: false, error: 'RESEARCH_HANDOFF_STORE_UNAVAILABLE' });
    assert.equal(fake.consumeCalls, 0);
    assert.equal(fake.modelCalls, 0);
  });

  it('본문 검사가 API Key 확인보다 먼저다', async () => {
    // 준비가 안 됐더라도, 어긋난 요청은 그 이유로 거절한다.
    const { response, parsed } = await run({ apiKey: undefined }, { handoffId: 'not-a-uuid' });
    assert.equal(response.status, 400);
    assert.deepEqual(parsed, { ok: false, error: 'INVALID_REQUEST' });
  });

  it('순서가 코드에도 그대로 있다', () => {
    const code = read('./handler.ts');
    const at = (needle: string) => {
      const index = code.indexOf(needle);
      assert.notEqual(index, -1, needle);
      return index;
    };
    const order = [
      "request.method !== 'POST'",
      'deps.isAuthorized(request)',
      'request.json()',
      'parseResearchRequest(body)',
      'deps.getApiKey()',
      'computeActiveCoveredHash(',
      'consumeBiblicalResearchHandoff(',
      'validateBiblicalResearchHandoff(',
      'executeBiblicalResearchRuntime(',
    ].map(at);
    for (let i = 1; i < order.length; i += 1) {
      assert.ok(order[i]! > order[i - 1]!, `순서가 어긋났습니다 (${i})`);
    }
  });
});

/* ================================================================== */
/* C. 지금 카드가 다루는 영역은 서버가 정한다                            */
/* ================================================================== */

describe('biblical-researcher · 영역은 서버가 정한다', () => {
  it('표에 보내는 지문은 서버가 계산한 값이다', async () => {
    const { fake } = await run();
    const call = fake.consumeCallList[0];

    assert.equal(call?.functionName, CONSUME_BIBLICAL_RESEARCH_HANDOFF_RPC);
    assert.deepEqual(Object.keys(call?.params ?? {}).sort(), [
      'p_current_active_covered_hash',
      'p_handoff_id',
    ]);
    assert.equal(call?.params.p_handoff_id, HANDOFF_ID);
    assert.equal(
      call?.params.p_current_active_covered_hash,
      await computeActiveCoveredHash(getActiveCoveredDomains()),
    );
  });

  it('부르는 쪽에서 영역을 받지 않는다', () => {
    const code = read('./handler.ts');
    assert.ok(code.includes('getActiveCoveredDomains()'));
    assert.ok(code.includes('computeActiveCoveredHash('));
    // 부르는 쪽의 값을 쓰는 자리가 없다.
    assert.equal(code.includes('input.activeCoveredDomains'), false);
    assert.equal(code.includes('body.activeCoveredHash'), false);
    // 지문 만드는 방식을 여기서 다시 적지 않는다.
    assert.equal(code.includes('crypto.subtle'), false);
  });
});

/* ================================================================== */
/* D. 꺼내기                                                           */
/* ================================================================== */

describe('biblical-researcher · 꾸러미 꺼내기', () => {
  it('정확히 한 번만 꺼낸다', async () => {
    const { fake } = await run();
    assert.equal(fake.consumeCalls, 1);
  });

  it('쓸 수 없는 번호는 하나로 답한다', async () => {
    // 없는 번호, 만료, 이미 쓴 것, 영역 달라짐. 표는 넷 다 빈 값으로 준다.
    for (const empty of [null, undefined]) {
      const { response, parsed, fake } = await run({ consumeReturns: empty });
      assert.equal(response.status, 409, String(empty));
      assert.deepEqual(parsed, { ok: false, error: 'RESEARCH_HANDOFF_UNAVAILABLE' });
      assert.equal(fake.consumeCalls, 1);
      assert.equal(fake.modelCalls, 0);
    }
  });

  it('왜 못 꺼냈는지 나누지 않는다', () => {
    const code = read('./handler.ts');
    for (const banned of ['expired', 'not_found', 'already_consumed', 'coverage_mismatch']) {
      assert.equal(code.includes(banned), false, banned);
    }
  });

  it('표에 닿지 못하면 다른 답이다', async () => {
    for (const options of [
      { consumeThrows: true },
      { consumeReturns: '문자열' },
      { consumeReturns: 42 },
      { consumeReturns: [] },
    ] as Options[]) {
      const { response, parsed, fake } = await run(options);
      assert.equal(response.status, 503, JSON.stringify(options));
      assert.deepEqual(parsed, { ok: false, error: 'RESEARCH_HANDOFF_STORE_UNAVAILABLE' });
      assert.ok(fake.consumeCalls <= 1);
      assert.equal(fake.modelCalls, 0);
    }
  });

  it('원본 DB 오류가 밖으로도 기록에도 남지 않는다', async () => {
    const { text, fake } = await run({ consumeThrows: true });
    assert.equal(text.includes('handoff_rpc_http_500'), false);
    for (const line of fake.logged) {
      assert.equal(line.includes('http_500'), false, line);
      assert.equal(line.includes(HANDOFF_ID), false, line);
    }
  });
});

/* ================================================================== */
/* E. 꺼낸 것을 다시 확인한다                                          */
/* ================================================================== */

describe('biblical-researcher · 꺼낸 것을 다시 확인한다', () => {
  it('꾸러미가 아니면 모델을 부르지 않는다', async () => {
    for (const payload of [
      {},
      { unexpected: true },
      { ...(STORED() as Record<string, unknown>), sources: [] },
    ]) {
      const { response, parsed, fake } = await run({ consumeReturns: payload });
      assert.equal(response.status, 503, JSON.stringify(payload).slice(0, 40));
      assert.deepEqual(parsed, { ok: false, error: 'RESEARCH_HANDOFF_STORE_UNAVAILABLE' });
      // 꺼내기는 이미 일어났지만 모델은 부르지 않는다.
      assert.equal(fake.consumeCalls, 1);
      assert.equal(fake.modelCalls, 0);
    }
  });

  it('내용이 지문과 맞지 않으면 모델을 부르지 않는다', async () => {
    const tampered = STORED() as Record<string, unknown>;
    ((tampered.sources as Record<string, unknown>[])[0] as Record<string, unknown>).title =
      '바꿔치기한 제목';

    const { response, parsed, fake } = await run({ consumeReturns: tampered });
    assert.equal(response.status, 503);
    assert.deepEqual(parsed, { ok: false, error: 'RESEARCH_HANDOFF_STORE_UNAVAILABLE' });
    assert.equal(fake.modelCalls, 0);
  });

  it('무엇이 어긋났는지 밖으로도 기록에도 남기지 않는다', async () => {
    const { text, fake } = await run({ consumeReturns: { unexpected: true } });

    assert.deepEqual(Object.keys(JSON.parse(text)).sort(), ['error', 'ok']);
    for (const banned of ['sources', 'evidenceSetHash', '지문', 'unexpected']) {
      assert.equal(text.includes(banned), false, banned);
    }
    assert.ok(fake.logged.includes('[testreq] research_handoff_validation_failed'));
  });

  it('그대로 믿고 넘기는 길이 없다', () => {
    const code = read('./handler.ts');
    assert.ok(code.includes('validateBiblicalResearchHandoff(consumed.payload)'));
    assert.equal(code.includes('as BiblicalResearchHandoff'), false);
    assert.equal(code.includes('consumed.payload as'), false);
    // 확인이 실행보다 먼저다.
    assert.ok(
      code.indexOf('validateBiblicalResearchHandoff(') <
        code.indexOf('executeBiblicalResearchRuntime('),
    );
  });
});

/* ================================================================== */
/* F. 연구 실행                                                        */
/* ================================================================== */

describe('biblical-researcher · 연구 실행', () => {
  it('확인을 통과하면 연구 결과를 돌려준다', async () => {
    const { response, parsed, fake } = await run();

    assert.equal(response.status, 200);
    assert.equal(parsed.ok, true);
    assert.equal(fake.consumeCalls, 1);
    assert.equal(fake.modelCalls, 1);

    const result = parsed.result as Record<string, unknown>;
    assert.equal(result.targetDomain, DOMAIN);
    assert.equal((result.candidatePassages as unknown[]).length, 3);
    // 지문은 서버가 붙인다. 꺼낸 꾸러미의 것과 같다.
    assert.equal(result.evidenceSetHash, HANDOFF.evidenceSetHash);
  });

  it('모델에게 정해진 시간만 준다', async () => {
    const { fake } = await run();
    assert.equal(fake.transportCalls[0]?.options.timeoutMs, BIBLICAL_RESEARCH_MODEL_TIMEOUT_MS);
    assert.equal(fake.transportCalls[0]?.options.timeoutMs, 90_000);
  });

  it('요청 본문은 실행 순서가 만든 것이다', async () => {
    const { fake } = await run();
    const sent = fake.transportCalls[0]?.request as Record<string, unknown>;

    assert.equal(sent.model, 'gpt-5.6-sol');
    assert.deepEqual(sent.reasoning, { effort: 'medium' });
    assert.equal(sent.max_output_tokens, 16_000);
    assert.equal(sent.store, false);
    assert.deepEqual(sent.tools, []);
    assert.equal(sent.truncation, 'disabled');

    // 모델은 꾸러미 지문을 보지 못한다.
    assert.equal(JSON.stringify(sent).includes(HANDOFF.evidenceSetHash), false);
  });

  it('나가는 것은 연구 결과뿐이다', async () => {
    const { parsed, text } = await run();
    assert.deepEqual(Object.keys(parsed).sort(), ['ok', 'result']);

    // 번호를 되돌려 주지 않는다. 이미 소비된 권한이다.
    assert.equal(text.includes(HANDOFF_ID), false);
    // 자료 목록과 근거 문장을 다시 내보내지 않는다.
    assert.equal(text.includes('relevanceNote'), false);
    assert.equal(text.includes('evidenceClaims'), false);
    assert.equal(text.includes(STATEMENT.slice(0, 20)), false);
    assert.equal(text.includes('activeCoveredDomains'), false);
    assert.equal(text.includes(url(0)), false);
  });

  it('연구가 끝나지 못하면 하나로만 알린다', async () => {
    const cases: [string, BiblicalResearchTransportResult][] = [
      ['시간 지남', { ok: false, failure: 'model_timeout' }],
      ['전송 실패', { ok: false, failure: 'model_transport_error' }],
      ['끊긴 답', { ok: true, response: { status: 'incomplete', output: [] } }],
      [
        '거절',
        {
          ok: true,
          response: {
            status: 'completed',
            output: [{ type: 'message', content: [{ type: 'refusal', refusal: '못 합니다' }] }],
          },
        },
      ],
      ['JSON이 아님', { ok: true, response: completedWith('JSON이 아닙니다') }],
      [
        '초안이 어긋남',
        { ok: true, response: completedWith(JSON.stringify({ targetDomain: DOMAIN })) },
      ],
    ];

    for (const [label, modelResult] of cases) {
      const { response, parsed, fake } = await run({ modelResult });
      assert.equal(response.status, 503, label);
      assert.deepEqual(parsed, { ok: false, error: 'BIBLICAL_RESEARCH_FAILED' }, label);
      // 꺼내기 한 번, 모델 한 번. 그 이상은 없다.
      assert.equal(fake.consumeCalls, 1, label);
      assert.ok(fake.modelCalls <= 1, label);
    }
  });

  it('근거에 묶이지 않는 답은 결과가 되지 않는다', async () => {
    const draft = validDraft();
    // 꾸러미에 없는 근거를 가리킨다.
    draft.candidatePassages[0].sourceSupport.exegesisEvidenceIds = [`${sid(0)}:e9`];

    const { response, parsed, fake } = await run({
      modelResult: { ok: true, response: completedWith(JSON.stringify(draft)) },
    });
    assert.equal(response.status, 503);
    assert.deepEqual(parsed, { ok: false, error: 'BIBLICAL_RESEARCH_FAILED' });
    assert.equal(fake.modelCalls, 1);
  });

  it('어디에서 멈췄는지는 서버 기록에만 남는다', async () => {
    const { text, fake } = await run({ modelResult: { ok: false, failure: 'model_timeout' } });
    assert.equal(text.includes('model_timeout'), false);
    assert.ok(fake.logged.includes('[testreq] model_timeout'));
  });

  it('모델이 쓴 글을 밖으로 내보내지 않는다', async () => {
    const { text } = await run({
      modelResult: { ok: true, response: completedWith('비밀이 담긴 모델의 답입니다') },
    });
    assert.equal(text.includes('비밀이 담긴'), false);
  });
});

/* ================================================================== */
/* G. 한 번 꺼낸 꾸러미는 되살리지 않는다                               */
/* ================================================================== */

describe('biblical-researcher · 되살리지 않는다', () => {
  it('무엇이 실패해도 두 번째로 꺼내지 않는다', async () => {
    const cases: Options[] = [
      { consumeReturns: { unexpected: true } },
      { modelResult: { ok: false, failure: 'model_timeout' } },
      { modelResult: { ok: true, response: completedWith('JSON이 아닙니다') } },
    ];
    for (const options of cases) {
      const { fake } = await run(options);
      assert.equal(fake.consumeCalls, 1, JSON.stringify(options).slice(0, 40));
    }
  });

  it('다시 부르는 코드가 아예 없다', () => {
    const code = stripComments(read('./handler.ts'));
    for (const banned of ['while (', 'retry', 'attempt', 'fallback', 'Promise.all']) {
      assert.equal(code.includes(banned), false, banned);
    }
    // 되풀이는 본문의 항목 이름을 훑는 한 곳뿐이다. 바깥을 부르는 되풀이는 없다.
    assert.equal((code.match(/for \(/g) || []).length, 1);
    assert.equal((code.match(/consumeBiblicalResearchHandoff\(/g) || []).length, 1);
    assert.equal((code.match(/executeBiblicalResearchRuntime\(/g) || []).length, 1);
  });

  it('앞 단계를 다시 돌리지 않는다', () => {
    const code = read('./handler.ts');
    for (const banned of [
      'createBiblicalResearchHandoff',
      'buildBiblicalResearchHandoff',
      'createRecoveryTicket',
      'consumePrioritizerDecision',
      'runSourceHarvest',
    ]) {
      assert.equal(code.includes(banned), false, banned);
    }
  });
});

/* ================================================================== */
/* H. 바깥으로 나가는 길                                               */
/* ================================================================== */

describe('biblical-researcher · 바깥으로 나가는 길', () => {
  const index = stripComments(read('./index.ts'));
  const handler = stripComments(read('./handler.ts'));

  it('요청 처리 본체는 DB도 네트워크도 모른다', () => {
    for (const banned of [
      'fetch(',
      'Deno.env',
      'process.env',
      'createClient',
      '/rest/v1/',
      'SUPABASE',
      'AbortController',
      'api.openai.com',
      'Authorization',
      'Deno.serve',
    ]) {
      assert.equal(handler.includes(banned), false, banned);
    }
  });

  it('DB로 가는 길은 꺼내 쓰기 하나뿐이다', () => {
    const paths = [...index.matchAll(/\/rest\/v1\/[a-z0-9_/]*/g)].map((match) => match[0]);
    assert.deepEqual([...new Set(paths)], ['/rest/v1/rpc/consume_biblical_research_handoff']);
    assert.ok(index.includes(`/rest/v1/rpc/${CONSUME_BIBLICAL_RESEARCH_HANDOFF_RPC}`));

    // 적어 두기는 자료 수집 단계의 몫이다.
    assert.equal(index.includes(CREATE_BIBLICAL_RESEARCH_HANDOFF_RPC), false);
    assert.equal(handler.includes(CREATE_BIBLICAL_RESEARCH_HANDOFF_RPC), false);

    // 다른 표에는 손대지 않는다.
    for (const banned of [
      'consume_prioritizer_decision',
      'create_prioritizer_decision',
      'harvest_recovery_ticket',
      'content_research_queue',
      'coverage_gap_daily',
      'record_coverage_gap',
    ]) {
      assert.equal(index.includes(banned), false, banned);
    }
  });

  it('읽는 비밀값은 넷뿐이다', () => {
    const envKeys = [...index.matchAll(/Deno\.env\.get\('([A-Z_]+)'\)/g)].map((match) => match[1]);
    assert.deepEqual([...new Set(envKeys)].sort(), [
      'BIBLICAL_RESEARCHER_TOKEN',
      'OPENAI_API_KEY',
      'SUPABASE_SERVICE_ROLE_KEY',
      'SUPABASE_URL',
    ]);
    // 다른 기능의 자격을 가져다 쓰지 않는다.
    assert.equal(index.includes('SOURCE_HARVESTER_TOKEN'), false);
    assert.equal(index.includes('RESEARCH_PRIORITIZER_TOKEN'), false);
  });

  it('자격 확인 방법을 새로 만들지 않았다', () => {
    assert.ok(index.includes('isAuthorizedInternalRequest('));
    for (const banned of ['crypto.subtle.digest', 'constantTimeEqual', '=== token']) {
      assert.equal(index.includes(banned), false, banned);
    }
  });

  it('모델을 부르는 일을 새로 만들지 않았다', () => {
    assert.ok(index.includes('createBiblicalResearchResponsesTransport('));
    // 주소·머리글·시간은 그쪽이 소유한다.
    assert.equal(index.includes('/v1/responses'), false);
    assert.equal(index.includes('api.openai.com'), false);
    assert.equal(index.includes('90_000'), false);
  });

  it('기다리는 시간은 앞의 표들과 같다', () => {
    assert.ok(index.includes('HANDOFF_RPC_TIMEOUT_MS = 5_000'));
    // 꺼내기 5 + 모델 90 = 95초. 한도는 150초다.
    assert.equal(5_000 + BIBLICAL_RESEARCH_MODEL_TIMEOUT_MS, 95_000);
    assert.ok(95_000 < 150_000);
    // 다른 Edge Function을 가져다 쓰지 않는다.
    assert.equal(index.includes('source-harvester'), false);
    assert.equal(index.includes('research-prioritizer/'), false);
  });

  it('브라우저에서 부르는 기능이 아니다', () => {
    for (const source of [stripComments(handler), stripComments(index)]) {
      for (const banned of ['Access-Control', 'cors', "'OPTIONS'"]) {
        assert.equal(source.includes(banned), false, banned);
      }
    }
  });

  it('사용자 정보를 다루지 않는다', () => {
    for (const source of [handler, index]) {
      for (const banned of [
        'rawSituation',
        'userSituation',
        'userId',
        'user_id',
        'sessionId',
        'deviceId',
        'prayerText',
      ]) {
        assert.equal(source.includes(banned), false, banned);
      }
    }
  });

  it('연구 정책과 계약을 여기서 다시 정하지 않는다', () => {
    for (const source of [handler, index]) {
      for (const banned of [
        'gpt-',
        'max_output_tokens',
        'json_schema',
        'reasoning',
        'bindBiblicalResearchEvidence',
        'JSON.parse(text)',
      ]) {
        assert.equal(source.includes(banned), false, banned);
      }
    }
  });
});
