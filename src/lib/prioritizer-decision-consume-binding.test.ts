/**
 * Source Harvester가 넘겨받은 판단을 대조하는가 · 테스트
 *
 * 실행: npm test
 *
 * 시작하기 전에 서버가 적어 둔 판단과 대조하고, 그것을 한 번 소비한다.
 * 대조에 실패하면 OpenAI를 부르지 않는다.
 *
 * 이어서 확인하는 요청(Request B)은 판단을 소비하지 않는다.
 * 그쪽 권한은 이미 만들어 둔 표가 이어받기 때문이다.
 *
 * 실제 DB와 OpenAI를 부르지 않는다. 흉내 낸 자리만 쓴다.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  handleSourceHarvest,
  parseHarvestRequest,
  type HandlerDeps,
} from '../../supabase/functions/source-harvester/handler.ts';
import { computeActiveCoveredHash } from '../../supabase/functions/_shared/harvest-recovery-ticket.ts';
import { getActiveCoveredDomains } from '../../supabase/functions/_shared/research-prioritizer-edge.ts';
import {
  DISCOVERY_TIMEOUT_MS,
  VERIFICATION_TIMEOUT_MS,
} from '../../supabase/functions/_shared/source-harvester-execution-contract.ts';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '');

const HANDLER = '../../supabase/functions/source-harvester/handler.ts';
const INDEX = '../../supabase/functions/source-harvester/index.ts';

const TOKEN = 'test-token-not-real';
const DECISION_ID = '3f2a91d4-6c7b-4e58-9a10-2b8c5d4e6f70';
const RECOVERY_ID = '6f9619ff-8b86-4d11-b42d-00c04fc964ff';
const SNAPSHOT_ID = `snap_${'a'.repeat(64)}`;

const activeCovered = getActiveCoveredDomains();

const validBody = () => ({
  decisionId: DECISION_ID,
  targetDomain: 'financial_hardship',
  evidenceVersion: 4,
  prioritizerSnapshotId: SNAPSHOT_ID,
  activeCoveredDomains: [...activeCovered],
});

const request = (options: { body?: unknown; token?: string | null; method?: string } = {}) => {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.token !== null) headers['x-internal-token'] = options.token ?? TOKEN;

  const method = options.method ?? 'POST';
  // GET/HEAD 요청은 본문을 가질 수 없다.
  if (method === 'GET' || method === 'HEAD') {
    return new Request('http://localhost/source-harvester', { method, headers });
  }

  return new Request('http://localhost/source-harvester', {
    method,
    headers,
    body: typeof options.body === 'string' ? options.body : JSON.stringify(options.body ?? validBody()),
  });
};

type Options = {
  apiKey?: string | undefined;
  decisionReturns?: unknown;
  decisionThrows?: boolean;
  withoutDecisionDep?: boolean;
  discoveryThrows?: boolean;
};

const run = async (options: Options = {}, incoming?: Request) => {
  const calls = { openai: 0, decision: 0, ticketCreate: 0, ticketConsume: 0 };
  const decisionInputs: unknown[] = [];
  const logged: string[] = [];

  const deps: HandlerDeps = {
    isAuthorized: (req) => req.headers.get('x-internal-token') === TOKEN,
    getApiKey: () => ('apiKey' in options ? options.apiKey : 'openai-key-not-real'),
    callOpenAI: async () => {
      calls.openai += 1;
      if (options.discoveryThrows) throw new Error('discovery down');
      // 1단계에서 주소를 못 찾은 것으로 끝낸다. 이 시험의 관심은 그 앞의 관문이다.
      return { status: 'completed', output: [] };
    },
    now: () => new Date('2026-09-02T00:00:00.000Z'),
    createRecoveryTicket: async () => {
      calls.ticketCreate += 1;
      return RECOVERY_ID;
    },
    consumeRecoveryTicket: async () => {
      calls.ticketConsume += 1;
      return [];
    },
    log: (message) => logged.push(message),
    requestId: () => 'testreq',
    ...(options.withoutDecisionDep
      ? {}
      : {
          consumePrioritizerDecision: async (input) => {
            calls.decision += 1;
            decisionInputs.push(input);
            if (options.decisionThrows) throw new Error('rpc down');
            return 'decisionReturns' in options ? options.decisionReturns : true;
          },
        }),
  };

  const response = await handleSourceHarvest(incoming ?? request(), deps);
  const text = await response.text();

  return { response, text, body: JSON.parse(text), calls, decisionInputs, logged };
};

/* ------------------------------------------------------------------ */

describe('판단 대조 · 요청 본문 (Request A)', () => {
  it('A. 받는 항목은 정확히 다섯이다', () => {
    const parsed = parseHarvestRequest(validBody());
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.deepEqual(Object.keys(parsed.input).sort(), [
      'activeCoveredDomains',
      'decisionId',
      'evidenceVersion',
      'prioritizerSnapshotId',
      'targetDomain',
    ]);
  });

  it('B. 올바른 번호는 통과한다', () => {
    assert.equal(parseHarvestRequest(validBody()).ok, true);
    // 대문자 UUID도 모양은 맞다.
    assert.equal(
      parseHarvestRequest({ ...validBody(), decisionId: DECISION_ID.toUpperCase() }).ok,
      true,
    );
  });

  it('C. 번호가 없으면 거절한다', () => {
    const body = validBody() as Record<string, unknown>;
    delete body.decisionId;
    assert.equal(parseHarvestRequest(body).ok, false);
  });

  it('D. 번호 모양이 다르면 거절한다', () => {
    for (const bad of [null, '', 'not-a-uuid', 42, {}, [], `${DECISION_ID} `, `${DECISION_ID}x`]) {
      assert.equal(parseHarvestRequest({ ...validBody(), decisionId: bad }).ok, false, String(bad));
    }
  });

  it('E. 모르는 항목이 있으면 거절한다', () => {
    assert.equal(parseHarvestRequest({ ...validBody(), extra: 1 }).ok, false);
  });

  it('F. 예전 네 항목짜리 요청은 이제 거절한다', () => {
    const old = {
      targetDomain: 'financial_hardship',
      evidenceVersion: 4,
      prioritizerSnapshotId: SNAPSHOT_ID,
      activeCoveredDomains: [...activeCovered],
    };
    assert.equal(parseHarvestRequest(old).ok, false);
  });
});

describe('판단 대조 · 이어서 확인하는 요청 (Request B)', () => {
  it('G. 표 번호 하나짜리 요청은 그대로 통과한다', async () => {
    const { calls, body } = await run({}, request({ body: { recoveryId: RECOVERY_ID } }));

    assert.equal(body.ok, true);
    assert.equal(calls.ticketConsume, 1);
    // H. 판단은 여기서 소비하지 않는다.
    assert.equal(calls.decision, 0);
    assert.equal(calls.openai, 0);
  });

  it('H. 표 번호에 다른 값을 섞으면 두 갈래 어디에도 맞지 않는다', async () => {
    const mixed = { recoveryId: RECOVERY_ID, decisionId: DECISION_ID };
    const { response, body, calls } = await run({}, request({ body: mixed }));

    assert.equal(response.status, 400);
    assert.equal(body.error, 'INVALID_REQUEST');
    assert.equal(calls.decision, 0);
    assert.equal(calls.ticketConsume, 0);
  });

  it('이어서 확인하는 요청의 본문 계약은 그대로다', () => {
    const contract = stripComments(
      read('../../supabase/functions/_shared/source-harvester-recovery-contract.ts'),
    );
    assert.ok(contract.includes("const RECOVERY_REQUEST_FIELDS = ['recoveryId'] as const;"));
    assert.equal(contract.includes('decisionId'), false);
  });
});

describe('판단 대조 · 언제 부르는가', () => {
  it('1. 권한이 없으면 대조하지 않는다', async () => {
    const { response, calls } = await run({}, request({ token: 'wrong' }));
    assert.equal(response.status, 401);
    assert.equal(calls.decision, 0);
    assert.equal(calls.openai, 0);
  });

  it('2. 본문이 JSON이 아니면 대조하지 않는다', async () => {
    const { response, calls } = await run({}, request({ body: '{ 깨진' }));
    assert.equal(response.status, 400);
    assert.equal(calls.decision, 0);
  });

  it('3. 요청 항목이 어긋나면 대조하지 않는다', async () => {
    const { response, calls } = await run({}, request({ body: { ...validBody(), extra: 1 } }));
    assert.equal(response.status, 400);
    assert.equal(calls.decision, 0);
  });

  it('4. 연구 대상 영역이 아니면 대조하지 않는다', async () => {
    const { response, calls } = await run(
      {},
      request({ body: { ...validBody(), targetDomain: 'grief_loss' } }),
    );
    assert.equal(response.status, 400);
    assert.equal(calls.decision, 0);
  });

  it('5. OpenAI 열쇠가 없으면 대조하지 않는다', async () => {
    const { response, body, calls } = await run({ apiKey: undefined });
    assert.equal(response.status, 503);
    assert.equal(body.error, 'OPENAI_API_KEY_MISSING');
    assert.equal(calls.decision, 0);
    assert.equal(calls.openai, 0);
  });

  it('7. 앞이 모두 갖춰지면 정확히 한 번 부른다', async () => {
    const { calls } = await run();
    assert.equal(calls.decision, 1);
  });

  it('POST가 아니면 아무것도 하지 않는다', async () => {
    const { calls } = await run({}, request({ method: 'GET' }));
    assert.equal(calls.decision, 0);
    assert.equal(calls.openai, 0);
  });
});

describe('판단 대조 · 지금 카드 상태가 그때와 같은가', () => {
  it('6. 달라졌으면 대조하지 않고 끝낸다', async () => {
    // 그때는 한 영역이 덜 다뤄지고 있었다는 요청.
    const stale = { ...validBody(), activeCoveredDomains: activeCovered.slice(0, -1) };
    const { response, body, calls, logged } = await run({}, request({ body: stale }));

    assert.equal(response.status, 409);
    assert.equal(body.error, 'PRIORITIZER_DECISION_UNAVAILABLE');
    // 멀쩡한 한 번짜리 번호를 헛되이 태우지 않는다.
    assert.equal(calls.decision, 0);
    assert.equal(calls.openai, 0);
    assert.equal(calls.ticketCreate, 0);

    assert.ok(logged.some((line) => line.includes('prioritizer_decision_coverage_stale')));
  });

  it('영역이 하나만 달라도 걸린다', async () => {
    const swapped = [...activeCovered.slice(0, -1), 'other_uncovered'];
    const { response, calls } = await run({}, request({ body: { ...validBody(), activeCoveredDomains: swapped } }));

    // 알 수 없는 영역이면 그 앞 단계에서 이미 걸린다. 어느 쪽이든 대조는 하지 않는다.
    assert.ok(response.status === 400 || response.status === 409);
    assert.equal(calls.decision, 0);
  });

  it('순서가 달라도 같은 상태로 본다', async () => {
    const shuffled = [...activeCovered].reverse();
    const { calls } = await run({}, request({ body: { ...validBody(), activeCoveredDomains: shuffled } }));
    assert.equal(calls.decision, 1);
  });

  it('지문 규칙을 새로 만들지 않았다', () => {
    const handler = stripComments(read(HANDLER));
    assert.ok(handler.includes('computeActiveCoveredHash(parsed.input.activeCoveredDomains)'));
    assert.ok(handler.includes('computeActiveCoveredHash(getActiveCoveredDomains())'));
    assert.equal(handler.includes('SHA-256'), false);
    assert.equal(handler.includes('v1|covered:'), false);
  });
});

/** 대조 자리에 실제로 넘어간 값 하나를 꺼낸다. */
const decisionInputsOf = (result: { decisionInputs: unknown[] }) => result.decisionInputs[0];

describe('판단 대조 · 무엇을 보내는가', () => {
  it('보내는 값은 정해진 다섯이다', async () => {
    const { decisionInputs } = await run();
    assert.equal(decisionInputs.length, 1);

    const input = decisionInputs[0] as Record<string, unknown>;
    assert.deepEqual(Object.keys(input).sort(), [
      'activeCoveredHash',
      'decisionId',
      'evidenceVersion',
      'prioritizerSnapshotId',
      'targetDomain',
    ]);

    assert.equal(input.decisionId, DECISION_ID);
    assert.equal(input.prioritizerSnapshotId, SNAPSHOT_ID);
    assert.equal(input.targetDomain, 'financial_hardship');
    assert.equal(input.evidenceVersion, 4);
  });

  it('지문은 요청이 들고 온 목록에서 만든다', async () => {
    const { decisionInputs } = await run();
    const input = decisionInputs[0] as Record<string, unknown>;

    assert.equal(input.activeCoveredHash, await computeActiveCoveredHash(activeCovered));
    // 그리고 그 값이 지금 서버가 보는 상태와 같음이 이미 확인된 뒤다.
    assert.equal(input.activeCoveredHash, await computeActiveCoveredHash(getActiveCoveredDomains()));
    assert.match(input.activeCoveredHash as string, /^[0-9a-f]{64}$/);
  });

  it('표에 보내는 값에 군더더기가 없다', async () => {
    const dumped = JSON.stringify(decisionInputsOf(await run()));

    for (const banned of [
      'situation',
      'userId',
      'session',
      'reason',
      'score',
      'candidates',
      'expiresAt',
      'createdAt',
      'apikey',
      'authorization',
      'domainDescription',
    ]) {
      assert.equal(dumped.includes(banned), false, banned);
    }
  });

  it('대조 값과 기록에 사용자 정보가 없다', async () => {
    const { text, logged } = await run();
    const dumped = JSON.stringify({ text, logged });

    for (const banned of [
      'situation',
      'userId',
      'sessionId',
      'deviceId',
      'apikey',
      'authorization',
      'Bearer',
      'expiresAt',
      'createdAt',
    ]) {
      assert.equal(dumped.includes(banned), false, banned);
    }
    // 활성 영역 목록과 지문 자체를 밖으로 내보내지 않는다.
    assert.equal(text.includes('activeCoveredDomains'), false);
    assert.equal(text.includes('activeCoveredHash'), false);
  });
});

describe('판단 대조 · 결과에 따른 행동', () => {
  it('8. 참이면 그다음 단계로 간다', async () => {
    const { calls, body } = await run();

    assert.equal(calls.decision, 1);
    assert.equal(calls.openai, 1, '1단계 요청까지 갔어야 합니다.');
    assert.equal(body.ok, true);
  });

  it('9. 거짓이면 OpenAI를 부르지 않는다', async () => {
    const { response, body, calls, logged } = await run({ decisionReturns: false });

    assert.equal(response.status, 409);
    assert.equal(body.error, 'PRIORITIZER_DECISION_UNAVAILABLE');
    assert.equal(calls.openai, 0);
    assert.equal(calls.ticketCreate, 0);
    assert.ok(logged.some((line) => line.includes('prioritizer_decision_rejected')));
  });

  it('10. 대조가 실패하면 OpenAI를 부르지 않는다', async () => {
    const { response, body, calls, logged } = await run({ decisionThrows: true });

    assert.equal(response.status, 503);
    assert.equal(body.error, 'PRIORITIZER_DECISION_STORE_UNAVAILABLE');
    assert.equal(calls.decision, 1);
    assert.equal(calls.openai, 0);
    assert.ok(logged.some((line) => line.includes('prioritizer_decision_consume_failed')));
  });

  it('11. 참·거짓이 아닌 답이면 OpenAI를 부르지 않는다', async () => {
    for (const bad of [null, undefined, 'true', 1, 0, {}, [], [true]]) {
      const { response, body, calls } = await run({ decisionReturns: bad });

      assert.equal(response.status, 503, String(bad));
      assert.equal(body.error, 'PRIORITIZER_DECISION_STORE_UNAVAILABLE', String(bad));
      assert.equal(calls.openai, 0, String(bad));
    }
  });

  it('대조할 방법 자체가 없으면 시작하지 않는다', async () => {
    const { response, body, calls, logged } = await run({ withoutDecisionDep: true });

    assert.equal(response.status, 503);
    assert.equal(body.error, 'PRIORITIZER_DECISION_STORE_UNAVAILABLE');
    assert.equal(calls.decision, 0);
    assert.equal(calls.openai, 0);
    assert.ok(logged.some((line) => line.includes('prioritizer_decision_not_configured')));
  });

  it('12. 참이 된 뒤 뒤에서 실패해도 다시 대조하지 않는다', async () => {
    const { calls, body } = await run({ discoveryThrows: true });

    assert.equal(calls.decision, 1, '한 번뿐이어야 합니다.');
    assert.equal(body.ok, true);
    assert.equal(body.result.status, 'recheck');
    assert.equal(body.result.reason, 'discovery_request_failed');
  });

  it('거절 사유를 밖에서 나누지 않는다', async () => {
    // 없는 번호인지, 이미 썼는지, 값이 다른지 모두 같은 답이다.
    const { body } = await run({ decisionReturns: false });
    const dumped = JSON.stringify(body);

    for (const banned of ['expired', 'not_found', 'mismatch', 'already', 'replay', 'domain']) {
      assert.equal(dumped.includes(banned), false, banned);
    }
    assert.deepEqual(Object.keys(body).sort(), ['error', 'ok']);
  });

  it('다시 부르지 않는다', () => {
    const handler = stripComments(read(HANDLER));
    assert.equal((handler.match(/await deps\.consumePrioritizerDecision\(/g) || []).length, 1);
    assert.equal(/retry|retries|attemptAgain/i.test(handler), false);
  });
});

describe('판단 대조 · 이어서 할 표는 그대로다', () => {
  it('표에 번호를 담지 않는다', () => {
    const handler = stripComments(read(HANDLER));
    const ticket = handler.split('createRecoveryTicket: deps.createRecoveryTicket')[0];
    assert.ok(ticket.length > 0);

    // 표 계약 자체에 번호 자리가 없다.
    const contract = read('../../supabase/functions/_shared/harvest-recovery-ticket.ts');
    assert.equal(contract.includes('decisionId'), false);
    const sql = read('../../supabase/migrations/20260831143037_harvest_recovery_ticket.sql');
    assert.equal(sql.includes('decision_id'), false);
  });

  it('이어서 확인하는 요청의 상태 대조는 그대로다', () => {
    // 그 검사는 병렬 실행 본체에 있다. 이번에 손대지 않았다.
    const parallel = read(
      '../../supabase/functions/_shared/source-harvester-parallel-recovery-execution.ts',
    );
    assert.ok(parallel.includes('matchesRecoveryCoverageSnapshot'));
    assert.equal(parallel.includes('decisionId'), false);
  });
});

describe('판단 대조 · 바깥층과 시간 예산', () => {
  it('DB로 나가는 길은 넷이고 새 비밀값이 없다', () => {
    const code = stripComments(read(INDEX));

    const paths = [...code.matchAll(/\/rest\/v1\/[a-z0-9_/]*/g)].map((match) => match[0]);
    assert.deepEqual([...new Set(paths)].sort(), [
      '/rest/v1/rpc/consume_harvest_recovery_ticket',
      '/rest/v1/rpc/consume_prioritizer_decision',
      '/rest/v1/rpc/create_biblical_research_handoff',
      '/rest/v1/rpc/create_harvest_recovery_ticket',
    ]);

    const envKeys = [...code.matchAll(/Deno\.env\.get\('([A-Z_]+)'\)/g)].map((match) => match[1]);
    assert.deepEqual([...new Set(envKeys)].sort(), [
      'OPENAI_API_KEY',
      'SOURCE_HARVESTER_TOKEN',
      'SUPABASE_SERVICE_ROLE_KEY',
      'SUPABASE_URL',
    ]);
  });

  it('보내는 인자는 표가 받는 다섯과 같다', () => {
    const code = stripComments(read(INDEX));
    const fn = code
      .split('async function consumePrioritizerDecision')[1]
      .split('Deno.serve')[0];

    for (const param of [
      'p_decision_id: input.decisionId',
      'p_prioritizer_snapshot_id: input.prioritizerSnapshotId',
      'p_target_domain: input.targetDomain',
      'p_evidence_version: input.evidenceVersion',
      'p_active_covered_hash: input.activeCoveredHash',
    ]) {
      assert.ok(fn.includes(param), param);
    }
    assert.equal((fn.match(/p_[a-z_]+:/g) || []).length, 5);
  });

  it('DB 함수 시간 제한은 5초 그대로다', () => {
    const code = stripComments(read(INDEX));
    assert.ok(code.includes('const RECOVERY_TICKET_RPC_TIMEOUT_MS = 5_000;'));
    // 새 시간 상수를 만들지 않았다.
    assert.equal((code.match(/TIMEOUT_MS = /g) || []).length, 1);
  });

  it('처음 시작하는 요청의 최악 시간이 145초다', () => {
    assert.equal(DISCOVERY_TIMEOUT_MS, 60_000);
    assert.equal(VERIFICATION_TIMEOUT_MS, 75_000);
    // 판단 대조 5 + 60 + 75 + 마지막 표 하나 5 = 145초. 한도는 150초다.
    //
    // 마지막 표는 하나뿐이다. 이어서 할 표를 만들었으면 꾸러미는 적지 않고,
    // 꾸러미를 적었으면 이어서 할 표는 없다. 그래서 두 시간이 함께 쌓이지 않는다.
    assert.equal(5_000 + DISCOVERY_TIMEOUT_MS + VERIFICATION_TIMEOUT_MS + 5_000, 145_000);
    assert.ok(read(INDEX).includes('판단 대조 5 + 1단계 60 + 2단계 75 + 마지막 표 하나 5 = 145초'));
  });
});

describe('판단 대조 · 연구 규칙은 건드리지 않았다', () => {
  it('모델·도구·상한·프롬프트·형식이 그대로다', () => {
    const contract = read('../../supabase/functions/_shared/source-harvester-execution-contract.ts');
    assert.ok(contract.includes("export const SOURCE_HARVEST_MODEL = 'gpt-5.6-terra';"));
    assert.ok(contract.includes('export const DISCOVERY_MAX_TOOL_CALLS = 6;'));
    assert.ok(contract.includes('export const VERIFICATION_MAX_TOOL_CALLS = 18;'));
    assert.ok(contract.includes('export const DISCOVERY_MIN_URLS = 8;'));
    // 이 파일은 이번에 손대지 않았으므로 번호를 모른다.
    assert.equal(contract.includes('decisionId'), false);
  });

  it('실행 본체와 병렬 확인은 번호를 모른다', () => {
    for (const path of [
      '../../supabase/functions/_shared/source-harvester-execution.ts',
      '../../supabase/functions/_shared/source-harvester-parallel-recovery-execution.ts',
      '../../supabase/functions/_shared/source-harvester-single-inspection-contract.ts',
    ]) {
      const code = read(path);
      assert.equal(code.includes('decisionId'), false, path);
      assert.equal(code.includes('prioritizer_decision'), false, path);
    }
  });

  it('Prioritizer 쪽 파일은 이번에 바뀌지 않았다', () => {
    const handler = read('../../supabase/functions/research-prioritizer/handler.ts');
    // 적는 쪽 계약은 그대로다.
    assert.ok(handler.includes("fail('DECISION_STORE_UNAVAILABLE', 503)"));
    assert.equal(handler.includes('consume_prioritizer_decision'), false);
  });
});
