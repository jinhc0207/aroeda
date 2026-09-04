/**
 * 연구 근거 꾸러미 보관소 · DB 함수를 부르는 자리 · 테스트
 *
 * 실행: npm test
 *
 * 지키려는 것:
 *   정해진 이름의 DB 함수를 정해진 값으로 한 번만 부른다.
 *   "쓸 수 없음"과 "표에 닿지 못함"을 섞지 않는다.
 *   표가 돌려준 꾸러미를 아직 믿지 않는다.
 *   꾸러미를 만들지도, 지문을 계산하지도 않는다.
 *
 * 실제 DB에 붙지 않는다. 부르는 일을 가짜로 넣는다.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  CONSUME_BIBLICAL_RESEARCH_HANDOFF_RPC,
  CREATE_BIBLICAL_RESEARCH_HANDOFF_RPC,
  buildConsumeHandoffParams,
  buildCreateHandoffParams,
  consumeBiblicalResearchHandoff,
  createBiblicalResearchHandoff,
  isActiveCoveredHash,
  isHandoffId,
  parseConsumeHandoffResponse,
  parseCreateHandoffResponse,
  type BiblicalResearchHandoffRpc,
} from '../../supabase/functions/_shared/biblical-research-handoff-store.ts';
import type { BiblicalResearchHandoff } from '../../supabase/functions/_shared/biblical-research-handoff.ts';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '');

const ADAPTER = '../../supabase/functions/_shared/biblical-research-handoff-store.ts';
const MIGRATION = '../../supabase/migrations/20260902120000_biblical_research_handoff.sql';

const HASH = 'a'.repeat(64);
const ID = '3f2a1b4c-5d6e-4f70-8901-a2b3c4d5e6f7';

/**
 * 시험용 꾸러미. 실제 수집 결과가 아니라 "객체 하나"라는 것만 쓴다.
 * 이 자리는 꾸러미 안을 보지 않기 때문이다.
 */
const HANDOFF = {
  brief: { targetDomain: 'financial_hardship' },
  evidenceSetHash: `evset_${'b'.repeat(64)}`,
  sources: [],
  sourceUnresolvedQuestions: [],
} as unknown as BiblicalResearchHandoff;

type Call = { functionName: string; params: Record<string, unknown> };

/** 정해진 답을 돌려주는 가짜. 몇 번 어떻게 불렸는지 기록한다. */
const fakeRpc = (respond: (call: Call) => Promise<unknown> | unknown) => {
  const calls: Call[] = [];
  const rpc: BiblicalResearchHandoffRpc = async (functionName, params) => {
    calls.push({ functionName, params });
    return await respond({ functionName, params });
  };
  return { rpc, calls };
};

const create = async (respond: (call: Call) => Promise<unknown> | unknown, handoff = HANDOFF, hash = HASH) => {
  const { rpc, calls } = fakeRpc(respond);
  const result = await createBiblicalResearchHandoff({ handoff, activeCoveredHash: hash, rpc });
  return { result, calls };
};

const consume = async (
  respond: (call: Call) => Promise<unknown> | unknown,
  handoffId = ID,
  hash = HASH,
) => {
  const { rpc, calls } = fakeRpc(respond);
  const result = await consumeBiblicalResearchHandoff({
    handoffId,
    currentActiveCoveredHash: hash,
    rpc,
  });
  return { result, calls };
};

/* ================================================================== */
/* A. 표와 이름이 어긋나지 않는다                                       */
/* ================================================================== */

describe('꾸러미 보관소 부르기 · A. 표와 이름이 어긋나지 않는다', () => {
  const sql = read(MIGRATION);

  it('DB 함수 이름이 migration에 적힌 것과 같다', () => {
    assert.equal(CREATE_BIBLICAL_RESEARCH_HANDOFF_RPC, 'create_biblical_research_handoff');
    assert.equal(CONSUME_BIBLICAL_RESEARCH_HANDOFF_RPC, 'consume_biblical_research_handoff');
    assert.ok(sql.includes(`create or replace function public.${CREATE_BIBLICAL_RESEARCH_HANDOFF_RPC}(`));
    assert.ok(sql.includes(`create or replace function public.${CONSUME_BIBLICAL_RESEARCH_HANDOFF_RPC}(`));
  });

  it('보내는 값의 이름이 migration의 인자 이름과 같다', () => {
    const createArgs = sql
      .split(`create or replace function public.${CREATE_BIBLICAL_RESEARCH_HANDOFF_RPC}(`)[1]
      .split(')')[0];
    const consumeArgs = sql
      .split(`create or replace function public.${CONSUME_BIBLICAL_RESEARCH_HANDOFF_RPC}(`)[1]
      .split(')')[0];

    for (const key of Object.keys(buildCreateHandoffParams({ handoff: HANDOFF, activeCoveredHash: HASH }))) {
      assert.ok(createArgs.includes(key), key);
    }
    for (const key of Object.keys(
      buildConsumeHandoffParams({ handoffId: ID, currentActiveCoveredHash: HASH }),
    )) {
      assert.ok(consumeArgs.includes(key), key);
    }
  });

  it('보내는 값은 각각 둘뿐이다', () => {
    assert.deepEqual(
      Object.keys(buildCreateHandoffParams({ handoff: HANDOFF, activeCoveredHash: HASH })).sort(),
      ['p_active_covered_hash', 'p_handoff'],
    );
    assert.deepEqual(
      Object.keys(buildConsumeHandoffParams({ handoffId: ID, currentActiveCoveredHash: HASH })).sort(),
      ['p_current_active_covered_hash', 'p_handoff_id'],
    );
  });

  it('보내지 않기로 한 값이 없다', () => {
    const code = stripComments(read(ADAPTER));
    for (const banned of [
      'p_target_domain',
      'p_evidence_version',
      'p_prioritizer_snapshot_id',
      'p_evidence_set_hash',
      'p_expires_at',
      'p_created_at',
      'decisionId',
      'recoveryId',
    ]) {
      assert.equal(code.includes(banned), false, banned);
    }
  });
});

/* ================================================================== */
/* B. 적어 두기                                                        */
/* ================================================================== */

describe('꾸러미 보관소 부르기 · B. 적어 두기', () => {
  it('정해진 함수를 정해진 값으로 부른다', async () => {
    const { calls } = await create(() => ID);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.functionName, CREATE_BIBLICAL_RESEARCH_HANDOFF_RPC);
    assert.deepEqual(calls[0]?.params, { p_handoff: HANDOFF, p_active_covered_hash: HASH });
  });

  it('꾸러미를 고치지 않고 그대로 보낸다', async () => {
    const { calls } = await create(() => ID);
    // 같은 객체다. 옮겨 담거나 줄이지 않는다.
    assert.equal(calls[0]?.params.p_handoff, HANDOFF);
  });

  it('모양이 맞는 번호가 오면 성공이다', async () => {
    const { result } = await create(() => ID);
    assert.deepEqual(result, { ok: true, handoffId: ID });
  });

  it('감싸서 와도 번호를 읽는다', async () => {
    for (const wrapped of [[ID], { create_biblical_research_handoff: ID }, [{ id: ID }]]) {
      const { result } = await create(() => wrapped);
      assert.deepEqual(result, { ok: true, handoffId: ID }, JSON.stringify(wrapped));
    }
  });

  it('번호가 아니면 표에 닿지 못한 것으로 본다', async () => {
    for (const bad of [null, undefined, '', 'not-a-uuid', 42, true, {}, [], [ID, ID], { a: 1, b: 2 }]) {
      const { result } = await create(() => bad);
      assert.deepEqual(
        result,
        { ok: false, failure: 'store_unavailable' },
        JSON.stringify(bad ?? null),
      );
    }
  });

  it('부르다 터져도 오류가 밖으로 새지 않는다', async () => {
    const { result, calls } = await create(() => {
      throw new Error('비밀이 담긴 DB 오류 문구');
    });
    assert.deepEqual(result, { ok: false, failure: 'store_unavailable' });
    assert.equal(calls.length, 1);
  });

  it('보낼 값이 어긋나면 아예 부르지 않는다', async () => {
    for (const [handoff, hash] of [
      [HANDOFF, 'too-short'],
      [HANDOFF, ''],
      [HANDOFF, 'A'.repeat(64)],
      ['꾸러미가 아님' as unknown as BiblicalResearchHandoff, HASH],
      [null as unknown as BiblicalResearchHandoff, HASH],
      [[] as unknown as BiblicalResearchHandoff, HASH],
    ] as const) {
      const { result, calls } = await create(() => ID, handoff, hash);
      assert.deepEqual(result, { ok: false, failure: 'store_unavailable' });
      assert.equal(calls.length, 0);
    }
  });

  it('다시 부르지 않는다', async () => {
    const { calls } = await create(() => null);
    assert.equal(calls.length, 1);
  });
});

/* ================================================================== */
/* C. 꺼내 쓰기                                                        */
/* ================================================================== */

describe('꾸러미 보관소 부르기 · C. 꺼내 쓰기', () => {
  const PAYLOAD = { brief: { targetDomain: 'financial_hardship' }, sources: [] };

  it('정해진 함수를 정해진 값으로 부른다', async () => {
    const { calls } = await consume(() => PAYLOAD);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.functionName, CONSUME_BIBLICAL_RESEARCH_HANDOFF_RPC);
    assert.deepEqual(calls[0]?.params, { p_handoff_id: ID, p_current_active_covered_hash: HASH });
  });

  it('꾸러미가 오면 그대로 돌려준다', async () => {
    const { result } = await consume(() => PAYLOAD);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.payload, PAYLOAD);
  });

  it('꾸러미를 감싼 것으로 오해해 벗기지 않는다', async () => {
    // 칸이 하나뿐인 꾸러미를 그 안의 값으로 잘못 읽으면 안 된다.
    const single = { brief: { targetDomain: 'financial_hardship' } };
    const { result } = await consume(() => single);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.payload, single);
  });

  it('빈 값은 쓸 수 없다는 뜻이다', async () => {
    for (const empty of [null, undefined]) {
      const { result } = await consume(() => empty);
      assert.deepEqual(result, { ok: false, failure: 'unavailable' }, String(empty));
    }
  });

  it('없는 번호·만료·이미 쓴 것·영역 달라짐을 구분하지 않는다', () => {
    const code = stripComments(read(ADAPTER));
    for (const banned of ['expired', 'not_found', 'coverage_mismatch', 'already_consumed']) {
      assert.equal(code.includes(banned), false, banned);
    }
  });

  it('번호 모양이 다르면 부르지 않고, 없는 번호와 같은 답이다', async () => {
    for (const bad of ['not-a-uuid', '', '123']) {
      const { result, calls } = await consume(() => PAYLOAD, bad);
      assert.deepEqual(result, { ok: false, failure: 'unavailable' }, bad);
      assert.equal(calls.length, 0);
    }
  });

  it('서버가 계산한 지문이 어긋나면 표에 닿지 못한 것으로 본다', async () => {
    // 이 값은 부르는 쪽이 적어 보낸 것이 아니라 서버가 만든 것이다.
    // 모양이 다르면 요청이 어긋난 것이 아니라 서버가 준비되지 않은 것이다.
    for (const bad of ['too-short', '', 'Z'.repeat(64)]) {
      const { result, calls } = await consume(() => PAYLOAD, ID, bad);
      assert.deepEqual(result, { ok: false, failure: 'store_unavailable' }, bad);
      assert.equal(calls.length, 0);
    }
  });

  it('약속과 다른 모양이 오면 표에 닿지 못한 것으로 본다', async () => {
    for (const bad of ['문자열', 42, true, [PAYLOAD], []]) {
      const { result } = await consume(() => bad);
      assert.deepEqual(result, { ok: false, failure: 'store_unavailable' }, JSON.stringify(bad));
    }
  });

  it('부르다 터져도 오류가 밖으로 새지 않는다', async () => {
    const { result, calls } = await consume(() => {
      throw new Error('비밀이 담긴 DB 오류 문구');
    });
    assert.deepEqual(result, { ok: false, failure: 'store_unavailable' });
    assert.equal(calls.length, 1);
  });

  it('다시 부르지 않는다', async () => {
    const { calls } = await consume(() => null);
    assert.equal(calls.length, 1);
  });
});

/* ================================================================== */
/* D. 두 실패를 섞지 않는다                                            */
/* ================================================================== */

describe('꾸러미 보관소 부르기 · D. 두 실패를 섞지 않는다', () => {
  it('빈 값과 부르지 못함은 다른 답이다', async () => {
    const empty = await consume(() => null);
    const broken = await consume(() => {
      throw new Error('실패');
    });

    assert.deepEqual(empty.result, { ok: false, failure: 'unavailable' });
    assert.deepEqual(broken.result, { ok: false, failure: 'store_unavailable' });
    assert.notDeepEqual(empty.result, broken.result);
  });

  it('실패 결과에는 이름 하나만 남는다', async () => {
    const results = [
      (await consume(() => null)).result,
      (
        await consume(() => {
          throw new Error('비밀');
        })
      ).result,
      (await create(() => null)).result,
    ];
    for (const result of results) {
      assert.equal(result.ok, false);
      assert.deepEqual(Object.keys(result).sort(), ['failure', 'ok']);
      for (const banned of ['message', 'details', 'hint', 'code', 'error', 'status', 'stack']) {
        assert.equal(banned in result, false, banned);
      }
    }
  });

  it('바깥으로 나가는 답 이름을 여기서 정하지 않는다', () => {
    const code = stripComments(read(ADAPTER));
    // 409·503 같은 답으로 바꾸는 일은 바깥층이 한다.
    for (const banned of [
      'RESEARCH_HANDOFF_STORE_UNAVAILABLE',
      'RESEARCH_HANDOFF_UNAVAILABLE',
      'ErrorCode',
      '409',
      '503',
      'new Response(',
      'status:',
    ]) {
      assert.equal(code.includes(banned), false, banned);
    }
  });
});

/* ================================================================== */
/* E. 꺼낸 꾸러미를 아직 믿지 않는다                                    */
/* ================================================================== */

describe('꾸러미 보관소 부르기 · E. 꺼낸 꾸러미를 아직 믿지 않는다', () => {
  it('약속과 다른 내용이어도 이 자리는 통과시킨다', async () => {
    // 꾸러미 안을 보는 일은 다음 단계의 검사기가 한다.
    for (const payload of [{}, { unexpected: true }, { sources: '자료가 아님' }]) {
      const { result } = await consume(() => payload);
      assert.equal(result.ok, true, JSON.stringify(payload));
      if (!result.ok) continue;
      assert.equal(result.payload, payload);
    }
  });

  it('꾸러미라고 단정하지 않는다', () => {
    const code = stripComments(read(ADAPTER));
    assert.equal(code.includes('as BiblicalResearchHandoff'), false);
    // 꺼낸 결과의 자리는 아직 이름 없는 값이다.
    assert.ok(code.includes('{ ok: true; payload: unknown }'));
  });

  it('꾸러미 안을 들여다보지 않는다', () => {
    const code = stripComments(read(ADAPTER));
    for (const banned of [
      'targetDomain',
      'evidenceVersion',
      'prioritizerSnapshotId',
      'evidenceSetHash',
      'evidenceClaims',
      'sourceId',
      '.sources',
    ]) {
      assert.equal(code.includes(banned), false, banned);
    }
  });
});

/* ================================================================== */
/* F. 이 자리가 모르는 것                                              */
/* ================================================================== */

describe('꾸러미 보관소 부르기 · F. 이 자리가 모르는 것', () => {
  const code = stripComments(read(ADAPTER));

  it('꾸러미를 만들지도, 지문을 계산하지도 않는다', () => {
    for (const banned of [
      'buildBiblicalResearchHandoff',
      'computeBiblicalResearchEvidenceSetHash',
      'validateSourceHarvestResult',
      'computeActiveCoveredHash',
      'getActiveCoveredDomains',
      'crypto.subtle',
      'digest',
    ]) {
      assert.equal(code.includes(banned), false, banned);
    }
  });

  it('앞뒤 단계의 규칙을 가져오지 않는다', () => {
    // 타입 하나만 가져온다. 실제로 도는 코드는 가져오지 않는다.
    const imports = [...code.matchAll(/^import[\s\S]*?from '([^']+)';/gm)];
    assert.equal(imports.length, 1);
    assert.equal(imports[0]?.[1], './biblical-research-handoff.ts');
    assert.ok(code.includes("import type { BiblicalResearchHandoff }"));

    for (const banned of [
      "from './biblical-researcher.ts'",
      "from './source-harvester.ts'",
      "from './research-prioritizer-edge.ts'",
      "from './harvest-recovery-ticket.ts'",
    ]) {
      assert.equal(code.includes(banned), false, banned);
    }
  });

  it('DB에 붙지 않는다', () => {
    for (const banned of [
      'fetch(',
      'Deno.env',
      'process.env',
      'createClient',
      'supabaseUrl',
      'serviceRoleKey',
      'Authorization',
      'apikey',
      'AbortController',
      'setTimeout',
      '/rest/v1/',
      'https://',
      'console.',
    ]) {
      assert.equal(code.includes(banned), false, banned);
    }
  });

  it('얼마나 기다릴지 정하지 않는다', () => {
    for (const banned of ['timeoutMs', '5_000', '5000', 'TIMEOUT']) {
      assert.equal(code.includes(banned), false, banned);
    }
  });

  it('다시 부르는 코드가 아예 없다', () => {
    for (const banned of ['for (', 'while (', 'retry', 'attempt', 'fallback', 'Promise.all']) {
      assert.equal(code.includes(banned), false, banned);
    }
    // 부르는 자리는 각각 한 곳뿐이다.
    assert.equal((code.match(/await input\.rpc\(/g) || []).length, 2);
  });
});

/* ================================================================== */
/* G. 값 읽기 helper                                                   */
/* ================================================================== */

describe('꾸러미 보관소 부르기 · G. 값 읽기', () => {
  it('번호의 모양을 본다', () => {
    assert.equal(isHandoffId(ID), true);
    for (const bad of ['', 'abc', 123, null, `${ID}x`]) assert.equal(isHandoffId(bad), false);
  });

  it('지문의 모양을 본다. 앞의 보관소와 같은 조건이다', () => {
    assert.equal(isActiveCoveredHash(HASH), true);
    for (const bad of ['', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64), null]) {
      assert.equal(isActiveCoveredHash(bad), false, String(bad));
    }
  });

  it('번호 읽기는 감싼 것을 벗기고, 꾸러미 읽기는 벗기지 않는다', () => {
    assert.equal(parseCreateHandoffResponse([ID]), ID);
    assert.equal(parseCreateHandoffResponse({ only: ID }), ID);
    assert.equal(parseCreateHandoffResponse({ a: ID, b: ID }), null);

    const single = { brief: {} };
    const read = parseConsumeHandoffResponse(single);
    assert.equal(read.ok, true);
    if (read.ok) assert.equal(read.payload, single);
  });

  it('빈 값과 모양이 다른 값을 나눈다', () => {
    assert.deepEqual(parseConsumeHandoffResponse(null), { ok: false, reason: 'empty' });
    assert.deepEqual(parseConsumeHandoffResponse(undefined), { ok: false, reason: 'empty' });
    assert.deepEqual(parseConsumeHandoffResponse([]), { ok: false, reason: 'invalid' });
    assert.deepEqual(parseConsumeHandoffResponse('문자열'), { ok: false, reason: 'invalid' });
  });
});

/* ================================================================== */
/* H. 아직 아무도 쓰지 않는다                                          */
/* ================================================================== */

describe('꾸러미 보관소 부르기 · H. 아직 아무도 쓰지 않는다', () => {
  it('적어 두기만 이어져 있고 꺼내 쓰기는 아직 없다', () => {
    const handler = read('../../supabase/functions/source-harvester/handler.ts');
    assert.ok(handler.includes('createBiblicalResearchHandoff('));
    assert.equal(handler.includes('consumeBiblicalResearchHandoff'), false);

    for (const path of [
      '../../supabase/functions/source-harvester/handler.ts',
      '../../supabase/functions/source-harvester/index.ts',
    ]) {
      assert.equal(read(path).includes(CONSUME_BIBLICAL_RESEARCH_HANDOFF_RPC), false, path);
    }

    // 연구 실행 순서는 아직 표를 모른다.
    const runtime = read('../../supabase/functions/_shared/biblical-researcher-runtime-contract.ts');
    assert.equal(runtime.includes('BiblicalResearchHandoffRpc'), false);
  });

  it('꺼내 쓰는 곳은 연구 단계 하나뿐이다', () => {
    const handler = read('../../supabase/functions/biblical-researcher/handler.ts');
    assert.ok(handler.includes('consumeBiblicalResearchHandoff('));
    // 연구 단계는 적어 두지 않는다. 그것은 자료 수집의 몫이다.
    assert.equal(handler.includes('createBiblicalResearchHandoff('), false);

    const index = read('../../supabase/functions/biblical-researcher/index.ts');
    assert.equal(index.includes(CREATE_BIBLICAL_RESEARCH_HANDOFF_RPC), false);
  });
});
