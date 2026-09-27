/**
 * research-prioritizer 순수 테스트
 *
 * 실행: npm test
 *
 * 실제 Supabase나 OpenAI를 부르지 않는다. 가짜 함수로 흐름만 확인한다.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { handleResearchPrioritizer, type Handlerdeps } from './handler.ts';
import { COVERED_DOMAINS } from '../_shared/situation-domains.ts';
import {
  EVALUATOR_LENSES,
  EVALUATOR_MAX_OUTPUT_TOKENS,
  EVALUATOR_TIMEOUT_MS,
  QUEUE_TIMEOUT_MS,
  getActiveCoveredDomains,
} from '../_shared/research-prioritizer-edge.ts';
import { computeSnapshotId, selectEligibleCandidates } from '../_shared/research-prioritizer.ts';

const queueRow = (overrides: Record<string, unknown> = {}) => ({
  target_domain: 'financial_hardship',
  research_kind: 'domain_expansion',
  status: 'queued',
  total_gap_count: 12,
  recent_7d_count: 4,
  recent_30d_count: 9,
  first_detected_date: '2026-08-01',
  last_detected_date: '2026-08-29',
  evidence_version: 3,
  ...overrides,
});

const queueItemOf = (row: Record<string, unknown>) => ({
  targetDomain: row.target_domain as string,
  researchKind: row.research_kind as string,
  status: row.status as string,
  totalGapCount: row.total_gap_count as number,
  recent7dCount: row.recent_7d_count as number,
  recent30dCount: row.recent_30d_count as number,
  firstDetectedDate: row.first_detected_date as string,
  lastDetectedDate: row.last_detected_date as string,
  evidenceVersion: row.evidence_version as number,
});

const evaluationFor = (targetDomain: string, evidenceVersion: number, rank: number) => ({
  targetDomain,
  evidenceVersion,
  pastoralNeed: 4,
  coverageGapDistinctness: 4,
  researchReadiness: 4,
  demandInterpretation: 'moderate' as const,
  recommendedRank: rank,
  reason: '최근 30일 동안 반복해서 나타났고 지금 다루는 영역들과 삶의 문제가 구분된다.',
  confidence: 0.7,
});

const openAIResponse = (result: unknown) => ({
  output: [
    { type: 'reasoning', summary: [] },
    { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(result) }] },
  ],
  usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
});

const post = (body: unknown = {}) =>
  new Request('http://localhost/research-prioritizer', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

/** 기본 준비물: 후보 하나, A/B 모두 같은 1위 */
/** 표가 돌려주는 번호. 실제 DB가 아니라 시험용 고정 값이다. */
const DECISION_ID = '9b1f0c52-4b3a-4a8e-8f2c-1d6e7a0b3c45';

function makeDeps(options: {
  rows?: unknown;
  queueThrows?: boolean;
  authorized?: boolean;
  apiKey?: string | undefined;
  responseFor?: (payload: Record<string, unknown>, index: number) => unknown;
  openAIThrows?: boolean;
  /** 판단을 표에 적는 자리. 값을 주지 않으면 번호 하나를 돌려준다. */
  createDecision?: (input: unknown) => Promise<unknown>;
  withoutDecisionDep?: boolean;
} = {}) {
  const rows = 'rows' in options ? options.rows : [queueRow()];
  const calls: { queue: number; openai: number; decision: number } = {
    queue: 0,
    openai: 0,
    decision: 0,
  };
  const sentPayloads: Record<string, unknown>[] = [];
  const decisionInputs: unknown[] = [];

  const createPrioritizerDecision = async (input: unknown) => {
    calls.decision += 1;
    decisionInputs.push(input);
    return options.createDecision
      ? await options.createDecision(input)
      : DECISION_ID;
  };

  const deps: Handlerdeps = {
    isAuthorized: () => options.authorized ?? true,
    fetchQueue: async () => {
      calls.queue += 1;
      if (options.queueThrows) throw new Error('rpc down');
      return rows;
    },
    getApiKey: () => ('apiKey' in options ? options.apiKey : 'test-key-not-real'),
    callOpenAI: async (payload) => {
      const index = calls.openai;
      calls.openai += 1;
      sentPayloads.push(payload);
      if (options.openAIThrows) throw new Error('openai down');

      if (options.responseFor) return options.responseFor(payload, index);

      const items = Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
      const eligible = selectEligibleCandidates(items.map(queueItemOf), getActiveCoveredDomains());
      const snapshotId = await computeSnapshotId(eligible, getActiveCoveredDomains());

      return openAIResponse({
        snapshotId,
        evaluations: eligible.map((item, position) =>
          evaluationFor(item.targetDomain, item.evidenceVersion, position + 1),
        ),
      });
    },
    ...(options.withoutDecisionDep ? {} : { createPrioritizerDecision }),
  };

  return { deps, calls, sentPayloads, decisionInputs };
}

describe('research-prioritizer · 내부 전용 접근', () => {
  it('권한이 없으면 Queue도 OpenAI도 부르지 않는다', async () => {
    const { deps, calls } = makeDeps({ authorized: false });
    const response = await handleResearchPrioritizer(post(), deps);

    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { ok: false, error: 'UNAUTHORIZED' });
    assert.equal(calls.queue, 0);
    assert.equal(calls.openai, 0);
  });

  it('권한 확인 중 오류가 나도 통과시키지 않는다', async () => {
    const { deps, calls } = makeDeps();
    const response = await handleResearchPrioritizer(post(), {
      ...deps,
      isAuthorized: () => {
        throw new Error('boom');
      },
    });

    assert.equal(response.status, 401);
    assert.equal(calls.openai, 0);
  });

  it('POST가 아니면 405이고 아무것도 부르지 않는다', async () => {
    for (const method of ['GET', 'PUT', 'DELETE']) {
      const { deps, calls } = makeDeps();
      const response = await handleResearchPrioritizer(
        new Request('http://localhost/research-prioritizer', { method }),
        deps,
      );
      assert.equal(response.status, 405);
      assert.equal(calls.queue, 0);
      assert.equal(calls.openai, 0);
    }
  });

  it('OPTIONS도 허용하지 않는다 (내부 전용)', async () => {
    const { deps, calls } = makeDeps();
    const response = await handleResearchPrioritizer(
      new Request('http://localhost/research-prioritizer', { method: 'OPTIONS' }),
      deps,
    );
    assert.equal(response.status, 405);
    assert.deepEqual(await response.json(), { ok: false, error: 'METHOD_NOT_ALLOWED' });
    assert.equal(calls.queue, 0);
    assert.equal(calls.openai, 0);
  });

  it('응답에 공개 CORS 헤더를 붙이지 않는다', async () => {
    const { deps } = makeDeps();
    for (const request of [
      post(),
      new Request('http://localhost/research-prioritizer', { method: 'OPTIONS' }),
    ]) {
      const response = await handleResearchPrioritizer(request, deps);
      assert.equal(response.headers.get('access-control-allow-origin'), null);
      assert.equal(response.headers.get('access-control-allow-headers'), null);
      assert.equal(response.headers.get('access-control-allow-methods'), null);
      assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
    }
  });
});

describe('research-prioritizer · Queue 읽기', () => {
  it('Queue 호출이 실패하면 AI를 부르지 않는다', async () => {
    const { deps, calls } = makeDeps({ queueThrows: true });
    const response = await handleResearchPrioritizer(post(), deps);

    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { ok: false, error: 'QUEUE_UNAVAILABLE' });
    assert.equal(calls.openai, 0);
  });

  it('Queue 응답 모양이 다르면 AI를 부르지 않는다', async () => {
    for (const rows of [null, 'rows', {}, [{ target_domain: 'financial_hardship' }], [42]]) {
      const { deps, calls } = makeDeps({ rows });
      const response = await handleResearchPrioritizer(post(), deps);

      assert.equal(response.status, 502, JSON.stringify(rows));
      assert.deepEqual(await response.json(), { ok: false, error: 'INVALID_QUEUE_RESPONSE' });
      assert.equal(calls.openai, 0);
    }
  });

  it('Queue가 비어 있으면 no_eligible_research이고 AI를 부르지 않는다', async () => {
    const { deps, calls } = makeDeps({ rows: [] });
    const response = await handleResearchPrioritizer(post(), deps);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, result: { status: 'no_eligible_research' } });
    assert.equal(calls.openai, 0);
  });

  it('RPC가 줄 수 없는 줄이 오면 조용히 버리지 않고 거절한다', async () => {
    // 읽기 전용 RPC는 이런 줄을 돌려줄 수 없다. 오면 계약이 어긋난 것이다.
    const rows = [
      queueRow({ target_domain: 'other_uncovered', research_kind: 'taxonomy_discovery', status: 'blocked' }),
      queueRow({ target_domain: 'burnout_exhaustion', status: 'blocked' }),
      queueRow({ target_domain: 'chronic_illness', status: 'researching' }),
    ];
    const { deps, calls } = makeDeps({ rows });
    const response = await handleResearchPrioritizer(post(), deps);

    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { ok: false, error: 'INVALID_QUEUE_RESPONSE' });
    assert.equal(calls.openai, 0);
  });

  it('API Key가 없으면 AI를 부르지 않는다', async () => {
    const { deps, calls } = makeDeps({ apiKey: undefined });
    const response = await handleResearchPrioritizer(post(), deps);

    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { ok: false, error: 'OPENAI_API_KEY_MISSING' });
    assert.equal(calls.openai, 0);
  });
});

describe('research-prioritizer · Evaluator A/B', () => {
  it('후보가 있으면 정확히 두 번 부른다', async () => {
    const { deps, calls } = makeDeps();
    const response = await handleResearchPrioritizer(post(), deps);

    assert.equal(response.status, 200);
    assert.equal(calls.openai, 2, '호출 횟수가 2회가 아닙니다.');
    assert.equal(calls.queue, 1);
  });

  it('두 요청의 근거와 snapshotId가 같다', async () => {
    const { deps, sentPayloads } = makeDeps();
    await handleResearchPrioritizer(post(), deps);

    assert.equal(sentPayloads.length, 2);
    assert.equal(sentPayloads[0].input, sentPayloads[1].input, '두 요청의 입력이 다릅니다.');

    const payload = JSON.parse(sentPayloads[0].input as string);
    const eligible = selectEligibleCandidates([queueItemOf(queueRow())], getActiveCoveredDomains());
    assert.equal(payload.snapshotId, await computeSnapshotId(eligible, getActiveCoveredDomains()));
  });

  it('보는 관점(lens)만 서로 다르다', async () => {
    const { deps, sentPayloads } = makeDeps();
    await handleResearchPrioritizer(post(), deps);

    const [a, b] = sentPayloads.map((payload) => payload.instructions as string);
    assert.notEqual(a, b, '두 지시문이 같습니다.');
    assert.ok(a.includes(EVALUATOR_LENSES.A));
    assert.ok(b.includes(EVALUATOR_LENSES.B));
    assert.equal(a.includes(EVALUATOR_LENSES.B), false);
    assert.equal(b.includes(EVALUATOR_LENSES.A), false);

    // 관점 문장을 뺀 나머지 규칙은 같다.
    assert.equal(a.replace(EVALUATOR_LENSES.A, ''), b.replace(EVALUATOR_LENSES.B, ''));
  });

  it('서로의 응답을 상대 입력에 넣지 않는다', async () => {
    const marker = { A: 'MARKER_FROM_A', B: 'MARKER_FROM_B' };
    const { deps, sentPayloads } = makeDeps({
      responseFor: (_payload, index) =>
        openAIResponse({
          snapshotId: index === 0 ? marker.A : marker.B,
          evaluations: [evaluationFor('financial_hardship', 3, 1)],
        }),
    });

    await handleResearchPrioritizer(post(), deps);

    for (const payload of sentPayloads) {
      const text = JSON.stringify(payload);
      assert.equal(text.includes(marker.A), false);
      assert.equal(text.includes(marker.B), false);
    }
  });

  it('두 요청 모두 store:false와 같은 응답 구조를 쓴다', async () => {
    const { deps, sentPayloads } = makeDeps();
    await handleResearchPrioritizer(post(), deps);

    for (const payload of sentPayloads) {
      assert.equal(payload.store, false);
      assert.equal(payload.model, 'gpt-5.6-luna');

      const format = (payload.text as { format: Record<string, unknown> }).format;
      assert.equal(format.type, 'json_schema');
      assert.equal(format.strict, true);
      assert.equal(format.name, 'research_prioritization');
    }

    assert.deepEqual(
      JSON.stringify((sentPayloads[0].text as { format: { schema: unknown } }).format.schema),
      JSON.stringify((sentPayloads[1].text as { format: { schema: unknown } }).format.schema),
    );
  });

  it('AI 호출이 실패하면 502로 끝낸다', async () => {
    const { deps } = makeDeps({ openAIThrows: true });
    const response = await handleResearchPrioritizer(post(), deps);

    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { ok: false, error: 'EVALUATOR_REQUEST_FAILED' });
  });
});

describe('research-prioritizer · 판단 결과', () => {
  const twoRows = [queueRow(), queueRow({ target_domain: 'burnout_exhaustion', evidence_version: 2 })];

  const resultWithTop = async (top: string, snapshotOverride?: string) => {
    const eligible = selectEligibleCandidates(twoRows.map(queueItemOf), getActiveCoveredDomains());
    const snapshotId = snapshotOverride ?? (await computeSnapshotId(eligible, getActiveCoveredDomains()));
    return {
      snapshotId,
      evaluations: eligible.map((item) =>
        evaluationFor(item.targetDomain, item.evidenceVersion, item.targetDomain === top ? 1 : 2),
      ),
    };
  };

  it('두 평가가 같은 1위를 고르면 consensus를 돌려준다', async () => {
    const { deps } = makeDeps({
      rows: twoRows,
      responseFor: () => openAIResponse(undefined),
    });

    const consensus = await resultWithTop('financial_hardship');
    const response = await handleResearchPrioritizer(post(), {
      ...deps,
      callOpenAI: async () => openAIResponse(consensus),
    });

    const body = (await response.json()) as { ok: boolean; result: Record<string, unknown> };
    assert.equal(body.ok, true);
    assert.equal(body.result.status, 'consensus');
    assert.equal(body.result.recommendedDomain, 'financial_hardship');
    assert.equal(body.result.evidenceVersion, 3);
    assert.match(String(body.result.snapshotId), /^snap_[0-9a-f]{64}$/);
  });

  it('1위가 갈리면 recheck만 돌려준다', async () => {
    const first = await resultWithTop('financial_hardship');
    const second = await resultWithTop('burnout_exhaustion');
    const { deps } = makeDeps({
      rows: twoRows,
      responseFor: (_payload, index) => openAIResponse(index === 0 ? first : second),
    });

    const response = await handleResearchPrioritizer(post(), deps);
    assert.deepEqual(await response.json(), { ok: true, result: { status: 'recheck' } });
  });

  it('한쪽 결과가 규칙을 어기면 recheck다', async () => {
    const good = await resultWithTop('financial_hardship');
    const broken = {
      ...good,
      evaluations: good.evaluations.map((item) => ({ ...item, confidence: 9 })),
    };
    const { deps } = makeDeps({
      rows: twoRows,
      responseFor: (_payload, index) => openAIResponse(index === 0 ? good : broken),
    });

    const response = await handleResearchPrioritizer(post(), deps);
    assert.deepEqual(await response.json(), { ok: true, result: { status: 'recheck' } });
  });

  it('판단 시점이 다르면 stale_evidence다', async () => {
    const stale = await resultWithTop('financial_hardship', `snap_${'a'.repeat(64)}`);
    const { deps } = makeDeps({
      rows: twoRows,
      responseFor: () => openAIResponse(stale),
    });

    const response = await handleResearchPrioritizer(post(), deps);
    assert.deepEqual(await response.json(), { ok: true, result: { status: 'stale_evidence' } });
  });

  it('응답에 점수·순위·reason·confidence·원본이 없다', async () => {
    const consensus = await resultWithTop('financial_hardship');
    const { deps } = makeDeps({
      rows: twoRows,
      responseFor: () => openAIResponse(consensus),
    });

    const response = await handleResearchPrioritizer(post(), deps);
    const text = await response.text();

    for (const banned of [
      'pastoralNeed',
      'coverageGapDistinctness',
      'researchReadiness',
      'recommendedRank',
      'reason',
      'confidence',
      'demandInterpretation',
      'usage',
      'output_text',
      'evaluations',
      // 표에만 있는 것들. 번호 말고는 아무것도 함께 나가지 않는다.
      'activeCoveredHash',
      'expiresAt',
      'createdAt',
      'expires_at',
      'created_at',
    ]) {
      assert.equal(text.includes(banned), false, `${banned}가 응답에 있습니다.`);
    }

    const body = JSON.parse(text) as { result: Record<string, unknown> };
    assert.deepEqual(Object.keys(body.result).sort(), [
      'decisionId',
      'evidenceVersion',
      'recommendedDomain',
      'snapshotId',
      'status',
    ]);
  });

  it('recheck 응답에는 내부 사유 코드도 넣지 않는다', async () => {
    const first = await resultWithTop('financial_hardship');
    const second = await resultWithTop('burnout_exhaustion');
    const { deps } = makeDeps({
      rows: twoRows,
      responseFor: (_payload, index) => openAIResponse(index === 0 ? first : second),
    });

    const response = await handleResearchPrioritizer(post(), deps);
    const body = (await response.json()) as { result: Record<string, unknown> };
    assert.deepEqual(Object.keys(body.result), ['status']);
  });
});

describe('research-prioritizer · 안전 장치', () => {
  it('초기 연구 기준선은 canonical 카드 데이터에 실제로 있는 10개만 쓴다', () => {
    assert.deepEqual(getActiveCoveredDomains(), [...COVERED_DOMAINS].sort());
    assert.equal(getActiveCoveredDomains().length, 10);
  });

  it('로그에 토큰이나 Queue 원본을 남기지 않는다', async () => {
    const logs: string[] = [];
    const secret = 'super-secret-internal-token';
    const request = new Request('http://localhost/research-prioritizer', {
      method: 'POST',
      headers: { 'x-internal-token': secret },
    });

    const { deps } = makeDeps({ queueThrows: true });
    await handleResearchPrioritizer(request, { ...deps, log: (message) => logs.push(message) });

    for (const message of logs) {
      assert.equal(message.includes(secret), false);
      assert.equal(message.includes('financial_hardship'), false);
    }
    assert.ok(logs.some((message) => message.includes('QUEUE_UNAVAILABLE')));
  });

  it('handler에 DB 쓰기나 refresh 호출이 없다', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('./handler.ts', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|\s)\/\/.*$/gm, '');

    for (const banned of [
      'refresh_content_research_queue',
      'consume_openai_quota',
      'record_coverage_gap',
      'insert into',
      'update ',
      'delete ',
    ]) {
      assert.equal(source.includes(banned), false, `${banned}가 있습니다.`);
    }
  });
});

describe('research-prioritizer · Queue 값 검증', () => {
  const expectInvalid = async (rows: unknown, label: string) => {
    const { deps, calls } = makeDeps({ rows });
    const response = await handleResearchPrioritizer(post(), deps);

    assert.equal(response.status, 502, label);
    assert.deepEqual(await response.json(), { ok: false, error: 'INVALID_QUEUE_RESPONSE' }, label);
    assert.equal(calls.openai, 0, label);
  };

  it('bigint 문자열도 정상 처리한다', async () => {
    const { deps, calls } = makeDeps({
      rows: [
        queueRow({
          total_gap_count: '12',
          recent_7d_count: '4',
          recent_30d_count: '9',
          evidence_version: '3',
        }),
      ],
    });
    const response = await handleResearchPrioritizer(post(), deps);

    assert.equal(response.status, 200);
    assert.equal(calls.openai, 2);
  });

  it('안전한 정수 범위를 넘으면 거절한다', async () => {
    await expectInvalid([queueRow({ total_gap_count: '9007199254740993' })], 'MAX_SAFE_INTEGER 초과');
    await expectInvalid([queueRow({ total_gap_count: Number.MAX_SAFE_INTEGER + 2 })], 'number 초과');
  });

  it('소수·음수·숫자가 아닌 값은 거절한다', async () => {
    await expectInvalid([queueRow({ total_gap_count: '12.5' })], '소수 문자열');
    await expectInvalid([queueRow({ recent_7d_count: 2.5 })], '소수');
    await expectInvalid([queueRow({ recent_7d_count: -1 })], '음수');
    await expectInvalid([queueRow({ evidence_version: 0 })], '0');
    await expectInvalid([queueRow({ total_gap_count: 'many' })], '숫자 아님');
  });

  it('수치가 앞뒤로 맞지 않으면 거절한다', async () => {
    await expectInvalid([queueRow({ recent_7d_count: 10, recent_30d_count: 9 })], '7d > 30d');
    await expectInvalid([queueRow({ recent_30d_count: 20, total_gap_count: 12 })], '30d > total');
  });

  it('날짜가 이상하면 거절한다', async () => {
    await expectInvalid([queueRow({ first_detected_date: '2026-02-30' })], '없는 날짜');
    await expectInvalid([queueRow({ last_detected_date: 'yesterday' })], '형식 아님');
    await expectInvalid(
      [queueRow({ first_detected_date: '2026-08-29', last_detected_date: '2026-08-01' })],
      'first > last',
    );
  });

  it('RPC 계약을 벗어난 종류·상태·영역은 거절한다', async () => {
    await expectInvalid([queueRow({ research_kind: 'taxonomy_discovery' })], '종류');
    await expectInvalid([queueRow({ status: 'blocked' })], '상태');
    await expectInvalid([queueRow({ target_domain: 'other_uncovered' })], 'other_uncovered');
    await expectInvalid([queueRow({ target_domain: 'grief_loss' })], '초기 연구 기준선 영역');
    await expectInvalid([queueRow({ target_domain: 'made_up_domain' })], '모르는 영역');
  });

  it('후보가 초기 연구 기준선에 편입되어 빠지는 것은 오류가 아니다', async () => {
    const { deps, calls } = makeDeps();
    const response = await handleResearchPrioritizer(post(), {
      ...deps,
      // financial_hardship가 초기 연구 기준선에 편입됐다고 가정한다.
      getActiveCoveredDomains: () => [...getActiveCoveredDomains(), 'financial_hardship'].sort(),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, result: { status: 'no_eligible_research' } });
    assert.equal(calls.openai, 0);
  });
});

describe('research-prioritizer · 평가 결과를 얻지 못한 경우', () => {
  const expectRecheck = async (
    responseFor: (payload: Record<string, unknown>, index: number) => unknown,
    label: string,
  ) => {
    const { deps, calls } = makeDeps({ responseFor });
    const response = await handleResearchPrioritizer(post(), deps);

    assert.equal(response.status, 200, label);
    assert.deepEqual(await response.json(), { ok: true, result: { status: 'recheck' } }, label);
    assert.equal(calls.openai, 2, `${label}: 재시도가 있었습니다.`);
  };

  const goodResult = async () => {
    const eligible = selectEligibleCandidates([queueItemOf(queueRow())], getActiveCoveredDomains());
    return {
      snapshotId: await computeSnapshotId(eligible, getActiveCoveredDomains()),
      evaluations: eligible.map((item, index) =>
        evaluationFor(item.targetDomain, item.evidenceVersion, index + 1),
      ),
    };
  };

  it('A의 응답에 결과 텍스트가 없으면 recheck다', async () => {
    const good = await goodResult();
    await expectRecheck(
      (_payload, index) => (index === 0 ? { output: [] } : openAIResponse(good)),
      'A 빈 응답',
    );
  });

  it('B의 응답에 결과 텍스트가 없으면 recheck다', async () => {
    const good = await goodResult();
    await expectRecheck(
      (_payload, index) => (index === 0 ? openAIResponse(good) : { output: [] }),
      'B 빈 응답',
    );
  });

  it('JSON이 아니면 recheck다', async () => {
    const good = await goodResult();
    await expectRecheck(
      (_payload, index) =>
        index === 0
          ? { output: [{ type: 'message', content: [{ type: 'output_text', text: '판단 결과입니다' }] }] }
          : openAIResponse(good),
      'JSON 아님',
    );
  });

  it('모델이 거절하면 recheck다', async () => {
    const good = await goodResult();
    await expectRecheck(
      (_payload, index) =>
        index === 0
          ? { output: [{ type: 'message', content: [{ type: 'refusal', refusal: '도와드릴 수 없습니다' }] }] }
          : openAIResponse(good),
      '거절',
    );
  });

  it('중간에 끊긴 응답도 recheck다', async () => {
    const good = await goodResult();
    await expectRecheck(
      (_payload, index) =>
        index === 0
          ? { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] }
          : openAIResponse(good),
      '중간에 끊김',
    );
  });

  it('이런 경우를 stale_evidence로 잘못 처리하지 않는다', async () => {
    const { deps } = makeDeps({ responseFor: () => ({ output: [] }) });
    const response = await handleResearchPrioritizer(post(), deps);
    const body = (await response.json()) as { result: { status: string } };

    assert.notEqual(body.result.status, 'stale_evidence');
    assert.equal(body.result.status, 'recheck');
  });
});

describe('research-prioritizer · 출력 상한과 시간 제한', () => {
  it('두 요청 모두 출력 상한을 정해서 보낸다', async () => {
    const { deps, sentPayloads } = makeDeps();
    await handleResearchPrioritizer(post(), deps);

    for (const payload of sentPayloads) {
      assert.equal(payload.max_output_tokens, EVALUATOR_MAX_OUTPUT_TOKENS);
    }
    assert.ok(EVALUATOR_MAX_OUTPUT_TOKENS > 0 && EVALUATOR_MAX_OUTPUT_TOKENS <= 8000);
  });

  it('Queue와 OpenAI 요청에 시간 제한 값이 정해져 있다', async () => {
    const { readFileSync } = await import('node:fs');
    const index = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');

    assert.ok(index.includes('QUEUE_TIMEOUT_MS'));
    assert.ok(index.includes('EVALUATOR_TIMEOUT_MS'));
    assert.ok(index.includes('AbortController'));
    assert.ok(QUEUE_TIMEOUT_MS > 0 && EVALUATOR_TIMEOUT_MS > 0);
  });

  it('내부 토큰을 문자열로 직접 비교하지 않는다', async () => {
    const { readFileSync } = await import('node:fs');
    const strip = (source: string) =>
      source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '');

    const index = strip(readFileSync(new URL('./index.ts', import.meta.url), 'utf8'));
    // 비교 방법은 _shared/internal-auth.ts 한 곳에 있고 내부 기능들이 같이 쓴다.
    const auth = strip(
      readFileSync(new URL('../_shared/internal-auth.ts', import.meta.url), 'utf8'),
    );

    assert.equal(index.includes('provided === expected'), false);
    assert.equal(auth.includes('provided === expected'), false);
    assert.ok(auth.includes("crypto.subtle.digest('SHA-256'"));
    assert.ok(auth.includes('constantTimeEqual'));
    assert.ok(auth.includes('diff |='), 'XOR 누적 비교가 없습니다.');

    // 토큰 값 자체는 코드에 없다. 이 기능이 읽는 secret 이름만 있다.
    assert.ok(index.includes("Deno.env.get('RESEARCH_PRIORITIZER_TOKEN')"));
    assert.equal(auth.includes('Deno.env'), false, '공용 helper는 실행 환경을 직접 읽지 않는다.');
  });
});
