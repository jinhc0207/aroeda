/**
 * source-harvester 운영 오류 경로 · 로컬 시뮬레이션 테스트
 *
 * 실행: npm test
 *
 * 왜 필요한가:
 *   HTTP 오류 내부 진단이 운영에 배포됐다.
 *   실제 OpenAI 요청을 보내기 전에, 운영과 같은 실행 경로를 네트워크 없이 재현해
 *   오류 분류가 정확히 남는지, 공개 결과로 아무것도 새지 않는지 확인한다.
 *
 * 다른 테스트와 무엇이 다른가:
 *   openai-http-diagnostics.test.ts는 이미 만들어진 오류 객체를 넣어 확인한다.
 *   이 파일은 그보다 한 단계 앞, 실제 응답의 상태 숫자에서 시작한다.
 *   Edge Function의 입구(index.ts)를 그대로 불러와서
 *   fetch만 가짜로 바꾸고, 요청 → 응답 → 분류 → 기록 → 공개 결과까지 한 번에 지나간다.
 *
 * 하지 않는 일:
 *   실제 네트워크 요청, 실제 OpenAI 호출, 실제 Supabase 접근.
 *   실제 환경변수·API Key 읽기(아래 값은 모두 이 파일 안에서 만든 가짜 값이다).
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { computeActiveCoveredHash } from '../../supabase/functions/_shared/harvest-recovery-ticket.ts';
import { getActiveCoveredDomains } from '../../supabase/functions/_shared/research-prioritizer-edge.ts';
import {
  OPENAI_HTTP_FAILURE_CODES,
  type OpenAIHttpFailureCategory,
} from '../../supabase/functions/_shared/openai-transport.ts';

/* ------------------------------------------------------------------ */
/* 가짜 실행 환경                                                        */
/* ------------------------------------------------------------------ */

/**
 * 아래 네 값은 이 파일 안에서만 쓰는 가짜 값이다.
 * 실제 환경변수, .env, Keychain은 읽지 않는다.
 */
const FAKE_ENV: Record<string, string> = {
  SOURCE_HARVESTER_TOKEN: 'local-simulation-internal-token',
  OPENAI_API_KEY: 'local-simulation-openai-key',
  SUPABASE_URL: 'https://local-simulation.invalid',
  SUPABASE_SERVICE_ROLE_KEY: 'local-simulation-service-role-key',
};

const OPENAI_URL = 'https://api.openai.com/v1/responses';
const RPC_PREFIX = `${FAKE_ENV.SUPABASE_URL}/rest/v1/rpc/`;

/** 실패한 응답의 본문. 코드가 이 본문을 열지 않는다는 것을 보이기 위한 표식이다. */
const ERROR_BODY = {
  error: {
    message: 'SIMULATED_OPENAI_ERROR_MESSAGE',
    type: 'SIMULATED_OPENAI_ERROR_TYPE',
    code: 'SIMULATED_OPENAI_ERROR_CODE',
  },
};

type ServeHandler = (request: Request) => Promise<Response> | Response;

type GlobalWithDeno = typeof globalThis & { Deno?: unknown };

let serve: ServeHandler;

/** 테스트를 시작하기 전 globalThis.Deno가 어땠는지. 끝나면 이대로 되돌린다. */
let hadDeno = false;
let originalDeno: unknown;

before(async () => {
  // 원래 상태를 먼저 적어 둔다.
  hadDeno = 'Deno' in globalThis;
  originalDeno = (globalThis as GlobalWithDeno).Deno;

  // Edge Function 입구는 Deno에서 실행된다. 여기서는 필요한 두 가지만 흉내 낸다.
  (globalThis as GlobalWithDeno).Deno = {
    env: { get: (key: string) => FAKE_ENV[key] },
    serve: (handler: ServeHandler) => {
      serve = handler;
    },
  };

  // 이 import가 곧 운영에 올라간 그 파일이다. 여기서 실제 callOpenAI가 붙는다.
  await import('../../supabase/functions/source-harvester/index.ts');
  assert.equal(typeof serve, 'function');
});

after(() => {
  // 흉내 낸 Deno를 치운다. 원래 없었으면 없는 상태로, 있었으면 그 값으로 되돌린다.
  if (hadDeno) {
    (globalThis as GlobalWithDeno).Deno = originalDeno;
  } else {
    delete (globalThis as GlobalWithDeno).Deno;
  }
});

/* ------------------------------------------------------------------ */
/* fixture                                                             */
/* ------------------------------------------------------------------ */

const SNAPSHOT_ID = `snap_${'a'.repeat(64)}`;
const DECISION_ID = '3f2a91d4-6c7b-4e58-9a10-2b8c5d4e6f70';
const RECOVERY_ID = '6f9619ff-8b86-4d11-b42d-00c04fc964ff';
const HANDOFF_ID = '3f2a1b4c-5d6e-4f70-8901-a2b3c4d5e6f7';

const activeCovered = getActiveCoveredDomains();

const url = (index: number) => `https://sources.example.org/aroeda/fixture-${index}`;
const urls = (count: number) => Array.from({ length: count }, (_, index) => url(index));

const searchCall = (found: readonly string[]) => ({
  type: 'web_search_call',
  status: 'completed',
  action: { type: 'search', query: 'q', sources: found.map((item) => ({ type: 'url', url: item })) },
});

const openPageCall = (target: string) => ({
  type: 'web_search_call',
  status: 'completed',
  action: { type: 'open_page', url: target },
});

const SPECS = [
  { sourceType: 'commentary', publisherOrInstitution: 'Fixture Academic Press', intendedUse: ['exegesis'], accessLevel: 'full_text' },
  { sourceType: 'biblical_theology', publisherOrInstitution: 'Fixture University Press', intendedUse: ['biblical_theology'], accessLevel: 'substantial_preview' },
  { sourceType: 'academic_article', publisherOrInstitution: 'Fixture Journal', intendedUse: ['exegesis'], accessLevel: 'abstract_only' },
  { sourceType: 'pastoral_resource', publisherOrInstitution: 'Fixture Seminary', intendedUse: ['pastoral_application'], accessLevel: 'full_text' },
  { sourceType: 'professional_context', publisherOrInstitution: 'Fixture Public Health Agency', intendedUse: ['pastoral_safety'], accessLevel: 'full_text' },
] as const;

const sourceFor = (target: string, index = 0, overrides: Record<string, unknown> = {}) => {
  const spec = SPECS[index % SPECS.length];
  return {
    sourceType: spec.sourceType,
    title: `연구 자료 ${index}`,
    authorOrOrganization: `연구자 ${index}`,
    publisherOrInstitution: spec.publisherOrInstitution,
    publicationYear: 2020,
    url: target,
    accessLevel: spec.accessLevel,
    intendedUse: [...spec.intendedUse],
    relevanceNote: '이 연구에 필요한 자료입니다.',
    evidenceClaims: [
      {
        intendedUse: spec.intendedUse[0],
        statement:
          '이 자료는 해당 영역을 다루면서 본문의 문맥과 그 신학적 자리를 함께 설명한다고 관찰되었다.',
        passageReferences:
          spec.intendedUse[0] === 'exegesis'
            ? [{ book: 'Psalms', chapter: 42, startVerse: 5, endVerse: 5 }]
            : [],
      },
    ],
    ...overrides,
  };
};

const draft = () => ({
  targetDomain: 'financial_hardship',
  evidenceVersion: 4,
  prioritizerSnapshotId: SNAPSHOT_ID,
  sources: SPECS.map((_, index) => sourceFor(url(index), index)),
  rejectedSources: [],
  unresolvedSourceQuestions: [],
});

const discoveryResponse = () => ({
  status: 'completed',
  output: [
    searchCall(urls(10)),
    { type: 'message', content: [{ type: 'output_text', text: '설명', annotations: [] }] },
  ],
});

/** 지시문이 요구하는 확인 범위(서로 다른 8개)를 채운 2단계 정상 응답 */
const verificationResponse = () => ({
  status: 'completed',
  output: [
    searchCall(urls(10)),
    ...urls(8).map((target) => openPageCall(target)),
    {
      type: 'message',
      content: [{ type: 'output_text', text: JSON.stringify(draft()), annotations: [] }],
    },
  ],
});

/** 이어서 확인하는 요청(Request B)이 표에서 꺼내는 한 줄 */
const ticketRow = async () => ({
  target_domain: 'financial_hardship',
  evidence_version: 4,
  prioritizer_snapshot_id: SNAPSHOT_ID,
  active_covered_hash: await computeActiveCoveredHash(activeCovered),
  discovered_urls: urls(30),
  primary_inspected_urls: urls(4),
  primary_draft: {
    sources: [sourceFor(url(0), 0, { title: '첫 요청 자료' })],
    rejectedSources: [
      { url: url(1), title: '익명 묵상글', rejectionReason: 'anonymous_or_unverifiable' },
    ],
    unresolvedSourceQuestions: [],
  },
  primary_tool_counts: {
    webSearchCallCount: 4,
    searchActionCount: 0,
    openPageActionCount: 4,
    findInPageActionCount: 0,
    unknownActionCount: 0,
    uniqueInspectedUrlCount: 4,
  },
});

const startBody = () => ({
  decisionId: DECISION_ID,
  targetDomain: 'financial_hardship',
  evidenceVersion: 4,
  prioritizerSnapshotId: SNAPSHOT_ID,
  activeCoveredDomains: [...activeCovered],
});

/* ------------------------------------------------------------------ */
/* 가짜 fetch로 한 요청을 처음부터 끝까지 실행하기                        */
/* ------------------------------------------------------------------ */

/** OpenAI로 나갈 뻔한 요청 하나에 대해 무엇을 돌려줄지 */
type OpenAIReply = { status: number; body?: unknown };

type Simulation = {
  body: unknown;
  /** callIndex는 0부터. 처음 시작하는 요청에서는 0=1단계, 1=2단계다. */
  openai: (callIndex: number, timeoutMs?: number) => OpenAIReply;
  /** DB 함수가 돌려줄 값. 정하지 않으면 기본값을 쓴다. */
  rpc?: (name: string) => unknown;
};

const defaultRpc = (name: string): unknown => {
  if (name === 'consume_prioritizer_decision') return true;
  if (name === 'create_harvest_recovery_ticket') return RECOVERY_ID;
  if (name === 'create_biblical_research_handoff') return HANDOFF_ID;
  if (name === 'consume_harvest_recovery_ticket') return [];
  return null;
};

const run = async (simulation: Simulation) => {
  const openaiCalls: { authorization: string | null; hasSignal: boolean }[] = [];
  const rpcCalls: string[] = [];
  const otherTargets: string[] = [];
  const logged: string[] = [];

  const originalFetch = globalThis.fetch;
  const originalLog = console.log;

  console.log = ((message?: unknown) => {
    logged.push(String(message));
  }) as typeof console.log;

  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const target = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;

    if (target === OPENAI_URL) {
      const callIndex = openaiCalls.length;
      openaiCalls.push({
        authorization: headers.authorization ?? null,
        hasSignal: init?.signal !== undefined,
      });
      const reply = simulation.openai(callIndex);
      return new Response(JSON.stringify(reply.body ?? ERROR_BODY), {
        status: reply.status,
        headers: { 'content-type': 'application/json' },
      });
    }

    if (target.startsWith(RPC_PREFIX)) {
      const name = target.slice(RPC_PREFIX.length);
      rpcCalls.push(name);
      const answer = simulation.rpc ? simulation.rpc(name) : defaultRpc(name);
      return new Response(JSON.stringify(answer), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    // 그 밖의 주소로는 나가지 않아야 한다. 실제 요청도 보내지 않는다.
    otherTargets.push(target);
    throw new Error('unexpected_fetch_target');
  }) as typeof globalThis.fetch;

  try {
    const response = await serve(
      new Request('https://local-simulation.invalid/source-harvester', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal-token': FAKE_ENV.SOURCE_HARVESTER_TOKEN,
        },
        body: JSON.stringify(simulation.body),
      }),
    );
    const text = await response.text();
    const parsed = JSON.parse(text) as Record<string, unknown>;

    return {
      response,
      text,
      parsed,
      result: (parsed.result ?? {}) as Record<string, unknown>,
      // 기록 앞에 붙는 요청 번호는 실행할 때마다 달라진다. 이름만 남긴다.
      logged: logged.map((line) => line.replace(/^\[[0-9a-f]{8}\] /, '')),
      rawLogged: logged,
      openaiCalls,
      rpcCalls,
      otherTargets,
    };
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
  }
};

/** 내부 진단 이름 14개 전부 */
const ALL_HTTP_CODES = [
  ...Object.values(OPENAI_HTTP_FAILURE_CODES.discovery),
  ...Object.values(OPENAI_HTTP_FAILURE_CODES.verification),
];

const countHttpCodeLines = (logged: readonly string[]) =>
  logged.filter((line) => ALL_HTTP_CODES.includes(line)).length;

/**
 * 기록 앞에 붙는 요청 번호는 crypto.randomUUID로 그때그때 만드는 값이다.
 * 8자리 16진수라 우연히 401·403 같은 숫자를 품을 수 있으므로,
 * 모양만 확인하고 새는지 검사할 때는 떼어 낸 줄을 본다.
 */
const assertRequestIdPrefix = (rawLogged: readonly string[], label: string) => {
  for (const line of rawLogged) {
    assert.match(line, /^\[[0-9a-f]{8}\] [a-z_]+$/, `${label} · ${line}`);
  }
};

/** 어떤 경우에도 밖으로 나가면 안 되는 것들 */
const assertNothingLeaked = (
  dumped: string,
  label: string,
  options: { statuses?: readonly number[] } = {},
) => {
  const banned = [
    'SIMULATED_OPENAI_ERROR_MESSAGE',
    'SIMULATED_OPENAI_ERROR_TYPE',
    'SIMULATED_OPENAI_ERROR_CODE',
    FAKE_ENV.OPENAI_API_KEY,
    FAKE_ENV.SUPABASE_SERVICE_ROLE_KEY,
    FAKE_ENV.SOURCE_HARVESTER_TOKEN,
    'Bearer',
    'api.openai.com',
    '/rest/v1/',
    ...(options.statuses ?? []).map(String),
  ];

  for (const item of banned) {
    assert.equal(dumped.includes(item), false, `${label} · ${item}`);
  }
};

/** 운영에서 실제로 볼 수 있는 상태 숫자와 그때 남아야 할 내부 범주 */
const HTTP_CASES: readonly [number, OpenAIHttpFailureCategory][] = [
  [401, 'auth'],
  [403, 'permission'],
  [404, 'not_found'],
  [429, 'rate_or_quota'],
  [500, 'server_error'],
];

/* ------------------------------------------------------------------ */

describe('운영 오류 경로 시뮬레이션 · 준비', () => {
  it('실제 네트워크로 나가지 않는다', async () => {
    const { openaiCalls, rpcCalls, otherTargets } = await run({
      body: startBody(),
      openai: () => ({ status: 401 }),
    });

    // 나간 요청은 전부 가짜 fetch가 받았다. 그 밖의 주소로는 한 번도 나가지 않았다.
    assert.deepEqual(otherTargets, []);
    assert.equal(openaiCalls.length, 1);
    assert.deepEqual(rpcCalls, ['consume_prioritizer_decision']);

    // 요청은 실제 운영과 같은 모양으로 만들어졌다(열쇠와 시간 제한이 붙는다).
    assert.equal(openaiCalls[0].authorization, `Bearer ${FAKE_ENV.OPENAI_API_KEY}`);
    assert.equal(openaiCalls[0].hasSignal, true);
  });
});

describe('운영 오류 경로 시뮬레이션 · 1단계(discovery) 응답 오류', () => {
  it('상태 숫자마다 내부 범주가 정확히 한 번 남는다', async () => {
    for (const [status, category] of HTTP_CASES) {
      const label = String(status);
      const { response, result, logged, openaiCalls, rpcCalls } = await run({
        body: startBody(),
        openai: () => ({ status }),
      });

      // 내부 기록: 좁은 범주 → 큰 종류 → 공개 사유 순서로 세 줄.
      assert.deepEqual(
        logged,
        [
          OPENAI_HTTP_FAILURE_CODES.discovery[category],
          'discovery_request_http_error',
          'discovery_request_failed',
        ],
        label,
      );
      // 범주 이름은 정확히 한 번만 남는다. 다른 범주가 함께 남지 않는다.
      assert.equal(countHttpCodeLines(logged), 1, label);

      // 공개 결과는 예전 그대로다.
      assert.equal(response.status, 200, label);
      assert.equal(result.status, 'recheck', label);
      assert.equal(result.reason, 'discovery_request_failed', label);
      assert.deepEqual(Object.keys(result).sort(), ['reason', 'status'], label);

      // 다시 부르지 않는다. 표도 만들지 않는다.
      assert.equal(openaiCalls.length, 1, label);
      assert.deepEqual(rpcCalls, ['consume_prioritizer_decision'], label);
    }
  });

  it('상태 숫자·응답 본문·열쇠·주소가 어디에도 남지 않는다', async () => {
    for (const [status] of HTTP_CASES) {
      const { text, logged, rawLogged } = await run({
        body: startBody(),
        openai: () => ({ status }),
      });

      assertRequestIdPrefix(rawLogged, String(status));
      assertNothingLeaked(JSON.stringify({ text, logged }), String(status), {
        statuses: HTTP_CASES.map(([code]) => code),
      });
    }
  });
});

describe('운영 오류 경로 시뮬레이션 · 2단계(verification) 응답 오류', () => {
  it('상태 숫자마다 내부 범주가 정확히 한 번 남는다', async () => {
    for (const [status, category] of HTTP_CASES) {
      const label = String(status);
      const { response, result, logged, openaiCalls } = await run({
        body: startBody(),
        // 1단계는 정상, 2단계만 실패한다.
        openai: (callIndex) =>
          callIndex === 0 ? { status: 200, body: discoveryResponse() } : { status },
      });

      assert.deepEqual(
        logged,
        [
          OPENAI_HTTP_FAILURE_CODES.verification[category],
          'verification_request_http_error',
          'verification_request_failed',
        ],
        label,
      );
      assert.equal(countHttpCodeLines(logged), 1, label);

      assert.equal(response.status, 200, label);
      assert.equal(result.status, 'recheck', label);
      assert.equal(result.reason, 'verification_request_failed', label);
      assert.deepEqual(Object.keys(result).sort(), ['reason', 'status'], label);

      // 1단계 한 번, 2단계 한 번. 재시도는 없다.
      assert.equal(openaiCalls.length, 2, label);
    }
  });

  it('1단계 범주와 2단계 범주가 섞이지 않는다', async () => {
    const { logged } = await run({
      body: startBody(),
      openai: (callIndex) =>
        callIndex === 0 ? { status: 200, body: discoveryResponse() } : { status: 403 },
    });

    assert.ok(logged.includes('verification_http_permission'));
    assert.equal(logged.some((line) => line.startsWith('discovery_http_')), false);
  });

  it('상태 숫자·응답 본문·열쇠·주소가 어디에도 남지 않는다', async () => {
    for (const [status] of HTTP_CASES) {
      const { text, logged, rawLogged } = await run({
        body: startBody(),
        openai: (callIndex) =>
          callIndex === 0 ? { status: 200, body: discoveryResponse() } : { status },
      });

      assertRequestIdPrefix(rawLogged, String(status));
      assertNothingLeaked(JSON.stringify({ text, logged }), String(status), {
        statuses: HTTP_CASES.map(([code]) => code),
      });
    }
  });
});

describe('운영 오류 경로 시뮬레이션 · 200 정상 응답', () => {
  it('두 단계가 모두 정상이면 예전과 같은 결과 구조가 나온다', async () => {
    const { response, result, logged, openaiCalls, rpcCalls } = await run({
      body: startBody(),
      openai: (callIndex) =>
        callIndex === 0
          ? { status: 200, body: discoveryResponse() }
          : { status: 200, body: verificationResponse() },
    });

    assert.equal(response.status, 200);
    assert.equal(result.status, 'ready');
    assert.deepEqual(Object.keys(result).sort(), [
      'diagnostics',
      'handoffId',
      'harvest',
      'status',
      'verificationToolDiagnostics',
    ]);
    assert.equal(result.handoffId, HANDOFF_ID);

    const harvest = result.harvest as Record<string, unknown>;
    assert.equal(harvest.targetDomain, 'financial_hardship');
    assert.equal((harvest.sources as unknown[]).length, 5);

    const diagnostics = result.diagnostics as Record<string, number>;
    assert.equal(diagnostics.proposedAcceptedCount, 5);
    assert.equal(diagnostics.inspectedAcceptedCount, 5);
    assert.equal(diagnostics.demotedNotInspectedCount, 0);

    // 정상 응답에는 HTTP 오류 범주가 하나도 남지 않는다.
    assert.equal(countHttpCodeLines(logged), 0);
    assert.equal(logged.some((line) => line.includes('_request_http_error')), false);

    assert.equal(openaiCalls.length, 2);
    assert.deepEqual(rpcCalls, [
      'consume_prioritizer_decision',
      'create_biblical_research_handoff',
    ]);
  });

  it('정상 응답에도 열쇠·주소·본문이 새지 않는다', async () => {
    const { text, logged, rawLogged } = await run({
      body: startBody(),
      openai: (callIndex) =>
        callIndex === 0
          ? { status: 200, body: discoveryResponse() }
          : { status: 200, body: verificationResponse() },
    });

    assertRequestIdPrefix(rawLogged, '200');
    // 정상 결과에는 자료 주소가 들어 있으므로 주소 자체는 금지 항목이 아니다.
    assertNothingLeaked(JSON.stringify({ text, logged }), '200');
  });
});

describe('운영 오류 경로 시뮬레이션 · 이어서 확인하는 요청(Request B)', () => {
  it('표가 없으면 예전 사유 그대로 끝나고 OpenAI를 부르지 않는다', async () => {
    const { response, result, logged, openaiCalls, rpcCalls } = await run({
      body: { recoveryId: RECOVERY_ID },
      openai: () => ({ status: 500 }),
    });

    assert.equal(response.status, 200);
    assert.equal(result.status, 'recheck');
    assert.equal(result.reason, 'recovery_ticket_unavailable');

    // 표를 꺼내는 함수 하나만 부른다. 판단을 다시 소비하지 않는다.
    assert.deepEqual(rpcCalls, ['consume_harvest_recovery_ticket']);
    assert.equal(openaiCalls.length, 0);
    assert.equal(countHttpCodeLines(logged), 0);
  });

  it('확인 요청이 모두 실패해도 예전 사유와 숫자만 나간다', async () => {
    const row = await ticketRow();
    const { response, result, logged, openaiCalls, rpcCalls } = await run({
      body: { recoveryId: RECOVERY_ID },
      // 이어서 확인하는 요청의 모든 호출이 권한 오류로 실패한다.
      openai: () => ({ status: 403 }),
      rpc: (name) => (name === 'consume_harvest_recovery_ticket' ? [row] : defaultRpc(name)),
    });

    assert.equal(response.status, 200);
    assert.equal(result.status, 'recheck');
    assert.equal(result.reason, 'insufficient_recovery_inspection');

    // 나가는 숫자는 도구 사용 집계뿐이다.
    assert.deepEqual(Object.keys(result).sort(), [
      'parallelInspectionDiagnostics',
      'reason',
      'status',
    ]);

    // Request B는 새 내부 범주를 쓰지 않는다. 실행 조건도 그대로다.
    assert.equal(countHttpCodeLines(logged), 0);
    assert.equal(logged.some((line) => line.includes('_http_')), false);
    assert.deepEqual(rpcCalls, ['consume_harvest_recovery_ticket']);
    assert.ok(openaiCalls.length > 0);

    assertNothingLeaked(JSON.stringify({ result, logged }), 'B403', { statuses: [403] });
  });
});
