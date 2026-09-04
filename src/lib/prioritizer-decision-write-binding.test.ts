/**
 * Prioritizer가 합의를 표에 적어 두는가 · 테스트
 *
 * 실행: npm test
 *
 * 합의가 났을 때만 적는다. 적지 못하면 합의를 성공으로 내보내지 않는다.
 * 이 단계에서는 Source Harvester가 그 번호를 쓰지 않는다.
 *
 * 실제 DB와 OpenAI를 부르지 않는다. 흉내 낸 자리만 쓴다.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  handleResearchPrioritizer,
  type Handlerdeps,
} from '../../supabase/functions/research-prioritizer/handler.ts';
import {
  DECISION_CREATE_FAILURE_CODES,
  DECISION_INPUT_FIELDS,
  describeDecisionCreateFailure,
  isDecisionId,
  validatePrioritizerDecisionInput,
} from '../../supabase/functions/_shared/prioritizer-decision.ts';
import { computeActiveCoveredHash } from '../../supabase/functions/_shared/harvest-recovery-ticket.ts';
import {
  computeSnapshotId,
  selectEligibleCandidates,
} from '../../supabase/functions/_shared/research-prioritizer.ts';
import {
  getActiveCoveredDomains,
  QUEUE_TIMEOUT_MS,
  EVALUATOR_TIMEOUT_MS,
} from '../../supabase/functions/_shared/research-prioritizer-edge.ts';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '');

const DECISION_ID = '9b1f0c52-4b3a-4a8e-8f2c-1d6e7a0b3c45';

/* ------------------------------------------------------------------ */
/* fixture                                                             */
/* ------------------------------------------------------------------ */

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

/** Queue 한 줄을 판단 로직이 보는 모양으로 옮긴다. 기존 handler 테스트와 같은 방식이다. */
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

const post = () =>
  new Request('http://localhost/research-prioritizer', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });

type Options = {
  rows?: unknown;
  createDecision?: (input: unknown) => Promise<unknown>;
  withoutDecisionDep?: boolean;
  openAIThrows?: boolean;
  responseFor?: (payload: Record<string, unknown>, index: number) => unknown;
};

const run = async (options: Options = {}) => {
  const rows = 'rows' in options ? options.rows : [queueRow()];
  const calls = { queue: 0, openai: 0, decision: 0 };
  const decisionInputs: unknown[] = [];
  const logged: string[] = [];

  const createPrioritizerDecision = async (input: unknown) => {
    calls.decision += 1;
    decisionInputs.push(input);
    return options.createDecision ? await options.createDecision(input) : DECISION_ID;
  };

  const deps: Handlerdeps = {
    isAuthorized: () => true,
    fetchQueue: async () => {
      calls.queue += 1;
      return rows;
    },
    getApiKey: () => 'test-key-not-real',
    callOpenAI: async (payload) => {
      const index = calls.openai;
      calls.openai += 1;
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
    log: (message) => logged.push(message),
    requestId: () => 'req',
    ...(options.withoutDecisionDep ? {} : { createPrioritizerDecision }),
  };

  const response = await handleResearchPrioritizer(post(), deps);
  const text = await response.text();

  return { response, text, body: JSON.parse(text), calls, decisionInputs, logged };
};

/* ------------------------------------------------------------------ */

describe('판단 넘겨주기 · 언제 적는가', () => {
  it('A. 합의가 나면 정확히 한 번 적는다', async () => {
    const { response, calls, body } = await run();

    assert.equal(response.status, 200);
    assert.equal(body.result.status, 'consensus');
    assert.equal(calls.decision, 1);
  });

  it('E. 후보가 없으면 적지 않는다', async () => {
    const { calls, body } = await run({ rows: [] });

    assert.equal(body.result.status, 'no_eligible_research');
    assert.equal(calls.decision, 0);
  });

  it('E. 두 평가가 다른 1위를 고르면 적지 않는다', async () => {
    const rows = [queueRow(), queueRow({ target_domain: 'burnout_exhaustion', evidence_version: 2 })];

    const { calls, body } = await run({
      rows,
      responseFor: async (_payload, index) => {
        const eligible = selectEligibleCandidates(rows.map(queueItemOf), getActiveCoveredDomains());
        const snapshotId = await computeSnapshotId(eligible, getActiveCoveredDomains());
        // A와 B가 서로 다른 것을 1위로 고른다.
        const ordered = index === 0 ? eligible : [...eligible].reverse();
        return openAIResponse({
          snapshotId,
          evaluations: ordered.map((item, position) =>
            evaluationFor(item.targetDomain, item.evidenceVersion, position + 1),
          ),
        });
      },
    });

    assert.equal(body.result.status, 'recheck');
    assert.equal(calls.decision, 0);
  });

  it('F. 평가자 호출이 실패하면 적지 않는다', async () => {
    const { calls, body } = await run({ openAIThrows: true });

    assert.equal(body.ok, false);
    assert.equal(calls.decision, 0);
  });

  it('F. 평가 결과를 읽지 못하면 적지 않는다', async () => {
    const { calls, body } = await run({ responseFor: () => ({ status: 'completed', output: [] }) });

    assert.equal(body.result.status, 'recheck');
    assert.equal(calls.decision, 0);
  });

  it('G. 근거가 낡았으면 적지 않는다', async () => {
    const { calls, body } = await run({
      responseFor: () =>
        openAIResponse({
          // 지금 판단 시점과 다른 값이다.
          snapshotId: `snap_${'0'.repeat(64)}`,
          evaluations: [evaluationFor('financial_hardship', 3, 1)],
        }),
    });

    assert.equal(body.result.status, 'stale_evidence');
    assert.equal(calls.decision, 0);
  });
});

describe('판단 넘겨주기 · 무엇을 적는가', () => {
  it('B. 합의 내용과 canonical 지문을 그대로 보낸다', async () => {
    const { decisionInputs, body } = await run();

    assert.equal(decisionInputs.length, 1);
    const input = decisionInputs[0] as Record<string, unknown>;

    assert.equal(input.prioritizerSnapshotId, body.result.snapshotId);
    assert.equal(input.targetDomain, body.result.recommendedDomain);
    assert.equal(input.evidenceVersion, body.result.evidenceVersion);
    assert.equal(input.targetDomain, 'financial_hardship');

    // 지문은 Harvester가 쓰는 그 함수로 만든 값과 같아야 한다.
    assert.equal(input.activeCoveredHash, await computeActiveCoveredHash(getActiveCoveredDomains()));
    assert.match(input.activeCoveredHash as string, /^[0-9a-f]{64}$/);
  });

  it('보내는 항목은 정확히 넷이다', async () => {
    const { decisionInputs } = await run();
    assert.deepEqual(
      Object.keys(decisionInputs[0] as object).sort(),
      [...DECISION_INPUT_FIELDS].sort(),
    );
    assert.equal(DECISION_INPUT_FIELDS.length, 4);
  });

  it('평가자의 점수·이유와 후보 목록은 보내지 않는다', async () => {
    const { decisionInputs } = await run();
    const dumped = JSON.stringify(decisionInputs[0]);

    for (const banned of ['reason', 'confidence', 'recommendedRank', 'pastoralNeed', 'candidates']) {
      assert.equal(dumped.includes(banned), false, banned);
    }
  });
});

describe('판단 넘겨주기 · 밖으로 나가는 결과', () => {
  it('C. 번호를 받으면 기존 결과에 번호만 더해 돌려준다', async () => {
    const { body } = await run();

    assert.deepEqual(Object.keys(body.result).sort(), [
      'decisionId',
      'evidenceVersion',
      'recommendedDomain',
      'snapshotId',
      'status',
    ]);
    assert.equal(body.result.decisionId, DECISION_ID);
    assert.ok(isDecisionId(body.result.decisionId));
  });

  it('K. 표에만 있는 것은 함께 나가지 않는다', async () => {
    const { text } = await run();

    for (const banned of [
      'activeCoveredHash',
      'expiresAt',
      'createdAt',
      'expires_at',
      'created_at',
      'active_covered_hash',
      'decision_id',
      'evaluations',
      'output_text',
    ]) {
      assert.equal(text.includes(banned), false, banned);
    }
  });

  it('D. 두 번 실행하면 각각 한 번씩 적는다', async () => {
    const first = await run();
    const second = await run();

    assert.equal(first.calls.decision, 1);
    assert.equal(second.calls.decision, 1);
    // 번호가 겹치지 않게 하는 것은 표의 몫이다. 여기서는 매번 새로 부르는 것만 본다.
    assert.equal(first.body.result.status, 'consensus');
    assert.equal(second.body.result.status, 'consensus');
  });
});

describe('판단 넘겨주기 · 적지 못하면 성공으로 내보내지 않는다', () => {
  it('H. 표가 실패하면 합의를 성공으로 돌려주지 않는다', async () => {
    const { response, body, calls } = await run({
      createDecision: async () => {
        throw new Error('rpc down');
      },
    });

    assert.equal(response.status, 503);
    assert.equal(body.ok, false);
    assert.equal(body.error, 'DECISION_STORE_UNAVAILABLE');
    assert.equal(calls.decision, 1);
    // 합의 내용이 밖으로 새지 않는다.
    assert.equal(JSON.stringify(body).includes('financial_hardship'), false);
  });

  it('I. 번호가 아닌 것을 돌려주면 실패로 본다', async () => {
    for (const bad of [null, undefined, '', 'not-a-uuid', 42, {}, ['x'], DECISION_ID + 'x']) {
      const { response, body } = await run({ createDecision: async () => bad });

      assert.equal(response.status, 503, String(bad));
      assert.equal(body.ok, false, String(bad));
      assert.equal(body.error, 'DECISION_STORE_UNAVAILABLE', String(bad));
    }
  });

  it('적는 자리가 아예 없으면 실패로 본다', async () => {
    const { response, body, calls } = await run({ withoutDecisionDep: true });

    assert.equal(response.status, 503);
    assert.equal(body.error, 'DECISION_STORE_UNAVAILABLE');
    assert.equal(calls.decision, 0);
  });

  it('번호 없는 합의는 어떤 경우에도 나가지 않는다', async () => {
    const failures: Options[] = [
      { createDecision: async () => null },
      { createDecision: async () => 'nope' },
      { createDecision: async () => { throw new Error('x'); } },
      { withoutDecisionDep: true },
    ];

    for (const options of failures) {
      const { body } = await run(options);
      assert.notEqual(body.result?.status, 'consensus');
      assert.equal(body.result?.decisionId, undefined);
    }
  });

  it('까닭은 서버 기록에만, 고정된 이름으로 남는다', async () => {
    const cases: [string, Options][] = [
      [DECISION_CREATE_FAILURE_CODES.unknown, { createDecision: async () => { throw new Error('x'); } }],
      [DECISION_CREATE_FAILURE_CODES.response_invalid, { createDecision: async () => 'nope' }],
      [DECISION_CREATE_FAILURE_CODES.not_configured, { withoutDecisionDep: true }],
    ];

    for (const [expected, options] of cases) {
      const { logged, text } = await run(options);
      assert.ok(logged.some((line) => line.includes(expected)), expected);
      // 밖으로는 나가지 않는다.
      assert.equal(text.includes(expected), false, expected);
    }
  });

  it('J. 다시 부르지 않는다', async () => {
    const { calls } = await run({ createDecision: async () => { throw new Error('x'); } });
    assert.equal(calls.decision, 1);

    const source = stripComments(read('../../supabase/functions/research-prioritizer/handler.ts'));
    assert.equal(/retry|retries|attemptAgain/i.test(source), false);
  });
});

describe('판단 넘겨주기 · 순수 규칙', () => {
  it('번호 모양을 본다', () => {
    assert.equal(isDecisionId(DECISION_ID), true);
    assert.equal(isDecisionId(DECISION_ID.toUpperCase()), true);
    for (const bad of [null, undefined, '', 'x', 42, {}, `${DECISION_ID} `]) {
      assert.equal(isDecisionId(bad), false, String(bad));
    }
  });

  it('보낼 값을 미리 본다', async () => {
    const good = {
      prioritizerSnapshotId: `snap_${'a'.repeat(64)}`,
      targetDomain: 'financial_hardship',
      evidenceVersion: 1,
      activeCoveredHash: 'b'.repeat(64),
    };
    assert.equal(validatePrioritizerDecisionInput(good).valid, true);

    const bad: Record<string, unknown>[] = [
      { ...good, prioritizerSnapshotId: 'snap_zzz' },
      { ...good, targetDomain: 'grief_loss' },
      { ...good, targetDomain: 'other_uncovered' },
      { ...good, evidenceVersion: 0 },
      { ...good, evidenceVersion: 1.5 },
      { ...good, activeCoveredHash: 'short' },
      { ...good, extra: 1 },
    ];
    for (const value of bad) {
      assert.equal(validatePrioritizerDecisionInput(value).valid, false, JSON.stringify(value).slice(0, 60));
    }

    for (const value of [null, undefined, 'x', 42, []]) {
      assert.equal(validatePrioritizerDecisionInput(value).valid, false, String(value));
    }
  });

  it('기록 이름은 정해진 다섯뿐이다', () => {
    const codes = Object.values(DECISION_CREATE_FAILURE_CODES);
    assert.equal(new Set(codes).size, 5);
    for (const code of codes) assert.match(code, /^prioritizer_decision_[a-z_]+$/);

    for (const bad of [null, undefined, 'nope', 42, {}]) {
      assert.equal(describeDecisionCreateFailure(bad), DECISION_CREATE_FAILURE_CODES.unknown);
    }
  });

  it('규칙 파일은 실행 환경을 모른다', () => {
    const code = stripComments(read('../../supabase/functions/_shared/prioritizer-decision.ts'));
    for (const banned of ['Deno.env', 'fetch(', 'process.env', '/rest/v1/', 'SERVICE_ROLE']) {
      assert.equal(code.includes(banned), false, banned);
    }
  });
});

describe('판단 넘겨주기 · 바깥층과 다른 계약', () => {
  const index = () => read('../../supabase/functions/research-prioritizer/index.ts');

  it('L. 새 비밀값이나 새 시간 제한을 만들지 않았다', () => {
    const code = stripComments(index());

    // 이미 쓰던 두 값만 읽는다.
    assert.ok(code.includes("Deno.env.get('SUPABASE_URL')"));
    assert.ok(code.includes("Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')"));
    // Queue를 읽을 때와 같은 시간 제한을 쓴다.
    assert.equal((code.match(/QUEUE_TIMEOUT_MS/g) || []).length, 3);
    assert.equal(QUEUE_TIMEOUT_MS, 5000);
    assert.equal(EVALUATOR_TIMEOUT_MS, 60000);
    // 새 환경변수를 만들지 않았다.
    const envKeys = [...code.matchAll(/Deno\.env\.get\('([A-Z_]+)'\)/g)].map((match) => match[1]);
    assert.deepEqual([...new Set(envKeys)].sort(), [
      'OPENAI_API_KEY',
      'RESEARCH_PRIORITIZER_TOKEN',
      'SUPABASE_SERVICE_ROLE_KEY',
      'SUPABASE_URL',
    ]);
  });

  it('네 값만 보내고 응답 본문을 열지 않는다', () => {
    const code = stripComments(index());
    // 인자 타입도 '}'로 끝나므로 함수 경계는 다음 함수 선언까지로 잡는다.
    const fn = code
      .split('async function createPrioritizerDecision')[1]
      .split('async function callOpenAI')[0];

    for (const param of [
      'p_prioritizer_snapshot_id',
      'p_target_domain',
      'p_evidence_version',
      'p_active_covered_hash',
    ]) {
      assert.ok(fn.includes(param), param);
    }
    assert.equal((fn.match(/p_[a-z_]+:/g) || []).length, 4);

    // 실패했을 때 본문도 상태 숫자도 옮기지 않는다.
    assert.ok(fn.includes("if (!response.ok) throw new Error('decision_rpc_failed');"));
    assert.equal(fn.includes('response.status'), false);
    assert.equal(fn.includes('response.text()'), false);
    // 열쇠 값을 기록하지 않는다.
    assert.equal(fn.includes('console.log'), false);
  });

  it('M. 판단을 적는 일은 Source Harvester가 하지 않는다', () => {
    // Harvester는 꺼내 쓰기만 한다. 적는 함수는 부르지 않는다.
    for (const path of [
      '../../supabase/functions/source-harvester/index.ts',
      '../../supabase/functions/source-harvester/handler.ts',
      '../../supabase/functions/_shared/source-harvester-execution.ts',
      '../../supabase/functions/_shared/source-harvester-execution-contract.ts',
      '../../supabase/functions/_shared/harvest-recovery-ticket.ts',
    ]) {
      const code = read(path);
      assert.equal(code.includes('create_prioritizer_decision'), false, path);
      assert.equal(code.includes('createPrioritizerDecision'), false, path);
    }

    // 순수 계약·실행 파일은 번호 자체를 모른다.
    for (const path of [
      '../../supabase/functions/_shared/source-harvester-execution.ts',
      '../../supabase/functions/_shared/source-harvester-execution-contract.ts',
      '../../supabase/functions/_shared/harvest-recovery-ticket.ts',
    ]) {
      assert.equal(read(path).includes('decisionId'), false, path);
    }

    // Request A가 받는 항목은 다섯이고, 번호가 맨 앞이다.
    const handler = read('../../supabase/functions/source-harvester/handler.ts');
    const fields = handler.split('const REQUEST_FIELDS = [')[1].split(']')[0];
    assert.deepEqual(
      [...fields.matchAll(/'([a-zA-Z]+)'/g)].map((match) => match[1]),
      ['decisionId', 'targetDomain', 'evidenceVersion', 'prioritizerSnapshotId', 'activeCoveredDomains'],
    );
  });

  it('지문 규칙은 한 곳에만 있다', () => {
    // Prioritizer가 지문 계산을 새로 적지 않고 기존 함수를 그대로 쓴다.
    const handler = stripComments(read('../../supabase/functions/research-prioritizer/handler.ts'));
    assert.ok(handler.includes('computeActiveCoveredHash(activeCoveredDomains)'));
    assert.equal(handler.includes('SHA-256'), false);
    assert.equal(handler.includes('v1|covered:'), false);
  });
});
