import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  parseArgs,
  runStage,
  FUNCTIONS_BASE_URL,
  PRODUCTION_PROJECT_REF,
  STAGE_CREDENTIALS,
  type OperatorDeps,
  type ParsedCommand,
  type TransportRequest,
  type HttpResponse,
} from './research-pipeline-operator.ts';
import { computeResearchResultHash } from '../../supabase/functions/_shared/research-result-store-contract.ts';

const FAKE_TOKEN = 'fake-secret-token-should-never-leak-0123456789';
const DECISION_ID = '11111111-1111-4111-8111-111111111111';
const HANDOFF_ID = '22222222-2222-4222-8222-222222222222';
const SNAPSHOT_ID = `snap_${'a'.repeat(64)}`;
const RESEARCH_HASH = `rres_${'b'.repeat(64)}`;

type Call = { spec: { service: string; account: string } } | TransportRequest;

function makeDeps(overrides: {
  secretValue?: string | null;
  transportImpl?: (req: TransportRequest) => Promise<HttpResponse>;
}) {
  const secretCalls: { service: string; account: string }[] = [];
  const transportCalls: TransportRequest[] = [];

  const deps: OperatorDeps = {
    secretReader: async (spec) => {
      secretCalls.push(spec);
      return overrides.secretValue === undefined ? FAKE_TOKEN : overrides.secretValue;
    },
    transport: async (req) => {
      transportCalls.push(req);
      if (overrides.transportImpl) return overrides.transportImpl(req);
      return { status: 200, json: { ok: true, result: { status: 'no_eligible_research' } } };
    },
  };

  return { deps, secretCalls, transportCalls };
}

const asOk = (cmd: ParsedCommand) => {
  assert.equal(cmd.ok, true);
  return cmd as Extract<ParsedCommand, { ok: true }>;
};

describe('research-pipeline-operator · A. parser', () => {
  it('refresh를 인식한다', () => {
    const cmd = parseArgs(['refresh']);
    assert.deepEqual(cmd, { ok: true, stage: 'refresh', execute: false });
  });

  it('prioritize를 인식한다', () => {
    const cmd = parseArgs(['prioritize', '--execute']);
    assert.deepEqual(cmd, { ok: true, stage: 'prioritize', execute: true });
  });

  it('harvest는 네 개 식별자를 모두 요구한다', () => {
    const cmd = asOk(
      parseArgs([
        'harvest',
        '--decision-id',
        DECISION_ID,
        '--target-domain',
        'loneliness_isolation',
        '--evidence-version',
        '3',
        '--snapshot-id',
        SNAPSHOT_ID,
      ]),
    );
    assert.equal(cmd.stage, 'harvest');
    if (cmd.stage === 'harvest') {
      assert.equal(cmd.decisionId, DECISION_ID);
      assert.equal(cmd.targetDomain, 'loneliness_isolation');
      assert.equal(cmd.evidenceVersion, 3);
      assert.equal(cmd.prioritizerSnapshotId, SNAPSHOT_ID);
      assert.equal(cmd.execute, false);
    }
  });

  it('harvest는 식별자 하나만 빠져도 거절한다', () => {
    const cmd = parseArgs(['harvest', '--decision-id', DECISION_ID]);
    assert.deepEqual(cmd, { ok: false, error: 'MISSING_ARGUMENT' });
  });

  it('research <handoffId>를 인식한다', () => {
    const cmd = parseArgs(['research', HANDOFF_ID]);
    assert.deepEqual(cmd, { ok: true, stage: 'research', execute: false, handoffId: HANDOFF_ID });
  });

  it('candidate <researchResultHash>를 인식한다', () => {
    const cmd = parseArgs(['candidate', RESEARCH_HASH]);
    assert.deepEqual(cmd, {
      ok: true,
      stage: 'candidate',
      execute: false,
      researchResultHash: RESEARCH_HASH,
    });
  });

  it('알 수 없는 stage를 거절한다', () => {
    assert.deepEqual(parseArgs(['run-pipeline']), { ok: false, error: 'UNKNOWN_STAGE' });
    assert.deepEqual(parseArgs(['--all']), { ok: false, error: 'UNKNOWN_STAGE' });
  });

  it('식별자가 없으면 거절한다', () => {
    assert.deepEqual(parseArgs(['research']), { ok: false, error: 'MISSING_ARGUMENT' });
    assert.deepEqual(parseArgs(['candidate']), { ok: false, error: 'MISSING_ARGUMENT' });
  });

  it('식별자 모양이 틀리면 거절한다', () => {
    assert.deepEqual(parseArgs(['research', 'not-a-uuid']), {
      ok: false,
      error: 'INVALID_ARGUMENT_FORMAT',
    });
    assert.deepEqual(parseArgs(['candidate', 'not-a-hash']), {
      ok: false,
      error: 'INVALID_ARGUMENT_FORMAT',
    });
  });

  it('여러 stage를 동시에 지정할 수 없다', () => {
    assert.deepEqual(parseArgs(['prioritize', 'harvest']), { ok: false, error: 'MULTIPLE_STAGES' });
  });

  it('인자가 아예 없으면 거절한다', () => {
    assert.deepEqual(parseArgs([]), { ok: false, error: 'MISSING_STAGE' });
  });
});

describe('research-pipeline-operator · B. execute guard', () => {
  it('refresh: --execute 없이는 network와 secret 조회가 0이다', async () => {
    const cmd = asOk(parseArgs(['refresh']));
    const { deps, secretCalls, transportCalls } = makeDeps({});
    const outcome = await runStage(cmd, deps);
    assert.deepEqual(outcome, { ok: true, stage: 'refresh', status: 'execution_required' });
    assert.equal(secretCalls.length, 0);
    assert.equal(transportCalls.length, 0);
  });

  it('prioritize: --execute 없이는 network와 secret 조회가 0이다', async () => {
    const cmd = asOk(parseArgs(['prioritize']));
    const { deps, secretCalls, transportCalls } = makeDeps({});
    const outcome = await runStage(cmd, deps);
    assert.deepEqual(outcome, { ok: true, stage: 'prioritize', status: 'execution_required' });
    assert.equal(secretCalls.length, 0);
    assert.equal(transportCalls.length, 0);
  });

  it('harvest/research/candidate도 동일하다', async () => {
    for (const argv of [
      ['harvest', '--decision-id', DECISION_ID, '--target-domain', 'x', '--evidence-version', '1', '--snapshot-id', SNAPSHOT_ID],
      ['research', HANDOFF_ID],
      ['candidate', RESEARCH_HASH],
    ]) {
      const cmd = asOk(parseArgs(argv));
      const { deps, secretCalls, transportCalls } = makeDeps({});
      const outcome = await runStage(cmd, deps);
      assert.equal(outcome.ok, true);
      assert.equal((outcome as { status: string }).status, 'execution_required');
      assert.equal(secretCalls.length, 0);
      assert.equal(transportCalls.length, 0);
    }
  });
});

describe('research-pipeline-operator · C. production target lock', () => {
  it('base URL이 정확한 production project ref를 쓴다', () => {
    assert.equal(PRODUCTION_PROJECT_REF, 'vcxgzdlllselhhdwuisq');
    assert.equal(FUNCTIONS_BASE_URL, `https://${PRODUCTION_PROJECT_REF}.supabase.co/functions/v1`);
  });

  it('다른 project ref를 주입할 CLI 옵션이 없다', () => {
    assert.deepEqual(parseArgs(['prioritize', '--project-ref', 'mylingo']), {
      ok: false,
      error: 'UNKNOWN_FLAG',
    });
    assert.deepEqual(
      parseArgs([
        'harvest',
        '--decision-id',
        DECISION_ID,
        '--target-domain',
        'x',
        '--evidence-version',
        '1',
        '--snapshot-id',
        SNAPSHOT_ID,
        '--project-ref',
        'mylingo',
      ]),
      { ok: false, error: 'UNKNOWN_FLAG' },
    );
  });

  it('실제 실행에서도 항상 production URL로만 나간다', async () => {
    const cmd = asOk(parseArgs(['prioritize', '--execute']));
    const { deps, transportCalls } = makeDeps({});
    await runStage(cmd, deps);
    assert.equal(transportCalls.length, 1);
    assert.ok(transportCalls[0].url.startsWith(FUNCTIONS_BASE_URL));
  });
});

describe('research-pipeline-operator · D. Keychain mapping', () => {
  it('stage별 service/account가 정확히 다르다', () => {
    assert.deepEqual(STAGE_CREDENTIALS.prioritize, {
      service: 'aroeda.production.edge.internal-token',
      account: 'RESEARCH_PRIORITIZER_TOKEN',
    });
    assert.deepEqual(STAGE_CREDENTIALS.harvest, {
      service: 'aroeda.production.edge.internal-token',
      account: 'SOURCE_HARVESTER_TOKEN',
    });
    assert.deepEqual(STAGE_CREDENTIALS.research, {
      service: 'aroeda.production.edge.internal-token',
      account: 'BIBLICAL_RESEARCHER_TOKEN',
    });
    assert.deepEqual(STAGE_CREDENTIALS.candidate, {
      service: 'com.aroeda.app.candidate-generator',
      account: 'CANDIDATE_GENERATOR_TOKEN',
    });
    assert.deepEqual(STAGE_CREDENTIALS.refresh, {
      service: 'aroeda.production.edge.internal-token',
      account: 'RESEARCH_QUEUE_REFRESH_TOKEN',
    });
  });

  it('실행 시 올바른 spec으로 secretReader를 정확히 한 번 부른다', async () => {
    const cmd = asOk(parseArgs(['research', HANDOFF_ID, '--execute']));
    const { deps, secretCalls } = makeDeps({
      transportImpl: async () => ({ status: 200, json: { ok: true, result: { note: 'ok' } } }),
    });
    await runStage(cmd, deps);
    assert.equal(secretCalls.length, 1);
    assert.deepEqual(secretCalls[0], STAGE_CREDENTIALS.research);
  });
});

describe('research-pipeline-operator · E. secret redaction', () => {
  it('토큰 문자열이 outcome 어디에도 등장하지 않는다', async () => {
    const cmd = asOk(parseArgs(['candidate', RESEARCH_HASH, '--execute']));
    const { deps } = makeDeps({
      transportImpl: async () => ({ status: 200, json: { ok: true, candidateHash: 'cand_abc' } }),
    });
    const outcome = await runStage(cmd, deps);
    const serialized = JSON.stringify(outcome);
    assert.ok(!serialized.includes(FAKE_TOKEN));
  });

  it('요청 header에 담긴 토큰도 outcome에 나오지 않는다', async () => {
    const cmd = asOk(parseArgs(['prioritize', '--execute']));
    const { deps, transportCalls } = makeDeps({
      transportImpl: async () => ({ status: 401, json: { ok: false, error: 'UNAUTHORIZED' } }),
    });
    const outcome = await runStage(cmd, deps);
    assert.equal(transportCalls[0].headers['x-internal-token'], FAKE_TOKEN);
    assert.ok(!JSON.stringify(outcome).includes(FAKE_TOKEN));
  });
});

describe('research-pipeline-operator · F. exact request contract', () => {
  it('prioritize: POST, x-internal-token, body 없음', async () => {
    const cmd = asOk(parseArgs(['prioritize', '--execute']));
    const { deps, transportCalls } = makeDeps({});
    await runStage(cmd, deps);
    const req = transportCalls[0];
    assert.equal(req.method, 'POST');
    assert.equal(req.url, `${FUNCTIONS_BASE_URL}/research-prioritizer`);
    assert.equal(req.headers['x-internal-token'], FAKE_TOKEN);
    assert.equal(req.body, undefined);
  });

  it('harvest: 정확히 5개 key', async () => {
    const cmd = asOk(
      parseArgs([
        'harvest',
        '--decision-id',
        DECISION_ID,
        '--target-domain',
        'loneliness_isolation',
        '--evidence-version',
        '2',
        '--snapshot-id',
        SNAPSHOT_ID,
        '--execute',
      ]),
    );
    const { deps, transportCalls } = makeDeps({
      transportImpl: async () => ({
        status: 200,
        json: { ok: true, result: { status: 'ready', handoffId: HANDOFF_ID } },
      }),
    });
    await runStage(cmd, deps);
    const req = transportCalls[0];
    assert.equal(req.method, 'POST');
    assert.equal(req.url, `${FUNCTIONS_BASE_URL}/source-harvester`);
    assert.equal(req.headers['x-internal-token'], FAKE_TOKEN);
    const body = JSON.parse(req.body!);
    assert.deepEqual(Object.keys(body).sort(), [
      'activeCoveredDomains',
      'decisionId',
      'evidenceVersion',
      'prioritizerSnapshotId',
      'targetDomain',
    ]);
    assert.equal(body.decisionId, DECISION_ID);
    assert.equal(body.targetDomain, 'loneliness_isolation');
    assert.equal(body.evidenceVersion, 2);
    assert.equal(body.prioritizerSnapshotId, SNAPSHOT_ID);
    assert.ok(Array.isArray(body.activeCoveredDomains));
  });

  it('research: 정확히 {handoffId} 하나', async () => {
    const cmd = asOk(parseArgs(['research', HANDOFF_ID, '--execute']));
    const { deps, transportCalls } = makeDeps({
      transportImpl: async () => ({ status: 200, json: { ok: true, result: { note: 'ok' } } }),
    });
    await runStage(cmd, deps);
    const req = transportCalls[0];
    assert.equal(req.url, `${FUNCTIONS_BASE_URL}/biblical-researcher`);
    const body = JSON.parse(req.body!);
    assert.deepEqual(Object.keys(body), ['handoffId']);
    assert.equal(body.handoffId, HANDOFF_ID);
  });

  it('candidate: 정확히 {researchResultHash} 하나', async () => {
    const cmd = asOk(parseArgs(['candidate', RESEARCH_HASH, '--execute']));
    const { deps, transportCalls } = makeDeps({
      transportImpl: async () => ({ status: 200, json: { ok: true, candidateHash: 'cand_x' } }),
    });
    await runStage(cmd, deps);
    const req = transportCalls[0];
    assert.equal(req.url, `${FUNCTIONS_BASE_URL}/candidate-generator`);
    const body = JSON.parse(req.body!);
    assert.deepEqual(Object.keys(body), ['researchResultHash']);
    assert.equal(body.researchResultHash, RESEARCH_HASH);
  });
});

describe('research-pipeline-operator · G. retry', () => {
  it('transport 실패 후 재시도하지 않는다(호출 횟수 정확히 1)', async () => {
    const cmd = asOk(parseArgs(['prioritize', '--execute']));
    const { deps, transportCalls } = makeDeps({
      transportImpl: async () => {
        throw new Error('network down');
      },
    });
    const outcome = await runStage(cmd, deps);
    assert.equal(transportCalls.length, 1);
    assert.deepEqual(outcome, { ok: false, stage: 'prioritize', code: 'TRANSPORT_FAILED' });
  });

  it('503 실패 후에도 재시도하지 않는다', async () => {
    const cmd = asOk(parseArgs(['harvest', '--decision-id', DECISION_ID, '--target-domain', 'x', '--evidence-version', '1', '--snapshot-id', SNAPSHOT_ID, '--execute']));
    const { deps, transportCalls } = makeDeps({
      transportImpl: async () => ({ status: 503, json: { ok: false, error: 'RESEARCH_HANDOFF_STORE_UNAVAILABLE' } }),
    });
    await runStage(cmd, deps);
    assert.equal(transportCalls.length, 1);
  });
});

describe('research-pipeline-operator · H. stage isolation', () => {
  it('한 stage 성공 후 다른 stage의 credential/transport는 0이다', async () => {
    const calls: { service: string; account: string }[] = [];
    const transportCalls: TransportRequest[] = [];
    const deps: OperatorDeps = {
      secretReader: async (spec) => {
        calls.push(spec);
        return FAKE_TOKEN;
      },
      transport: async (req) => {
        transportCalls.push(req);
        return { status: 200, json: { ok: true, result: { status: 'no_eligible_research' } } };
      },
    };

    const cmd = asOk(parseArgs(['prioritize', '--execute']));
    await runStage(cmd, deps);

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], STAGE_CREDENTIALS.prioritize);
    assert.notDeepEqual(calls[0], STAGE_CREDENTIALS.harvest);
    assert.notDeepEqual(calls[0], STAGE_CREDENTIALS.research);
    assert.notDeepEqual(calls[0], STAGE_CREDENTIALS.candidate);
    assert.equal(transportCalls.length, 1);
    assert.ok(transportCalls[0].url.endsWith('/research-prioritizer'));
  });
});

describe('research-pipeline-operator · I. research hash', () => {
  it('기존 computeResearchResultHash와 정확히 같은 값을 낸다', async () => {
    const fixtureResult = {
      queryDate: '2026-09-08',
      passageRef: { book: 'John', chapter: 3, startVerse: 16, endVerse: 16 },
      sourcesUsed: ['https://example.com/a'],
      theologicalInsight: '고정된 fixture 문장',
      userExplanation: '고정된 fixture 설명',
      misuseGuards: ['guard-1'],
    };
    const expectedHash = await computeResearchResultHash(fixtureResult as never);

    const cmd = asOk(parseArgs(['research', HANDOFF_ID, '--execute']));
    let capturedStdoutLikeSerialization = '';
    const { deps } = makeDeps({
      transportImpl: async () => ({ status: 200, json: { ok: true, result: fixtureResult } }),
    });
    const outcome = await runStage(cmd, deps);
    capturedStdoutLikeSerialization = JSON.stringify(outcome);

    assert.equal(outcome.ok, true);
    if (outcome.ok) {
      assert.equal(outcome.identifiers?.researchResultHash, expectedHash);
    }
    // 연구 결과 본문(fixture 고유 문장)이 outcome 어디에도 나오지 않는다.
    assert.ok(!capturedStdoutLikeSerialization.includes('고정된 fixture 문장'));
    assert.ok(!capturedStdoutLikeSerialization.includes('고정된 fixture 설명'));
  });
});

describe('research-pipeline-operator · J. candidate hash-only body', () => {
  it('연구 결과 본문을 보낼 방법이 없다(request는 hash 한 field만 만들 수 있다)', async () => {
    const cmd = asOk(parseArgs(['candidate', RESEARCH_HASH, '--execute']));
    const { deps, transportCalls } = makeDeps({
      transportImpl: async () => ({ status: 200, json: { ok: true, candidateHash: 'cand_y' } }),
    });
    await runStage(cmd, deps);
    const body = JSON.parse(transportCalls[0].body!);
    assert.deepEqual(Object.keys(body), ['researchResultHash']);
  });
});

describe('research-pipeline-operator · K. safe output', () => {
  it('harvest ready 응답의 raw harvest/diagnostics가 outcome에 나오지 않는다', async () => {
    const cmd = asOk(
      parseArgs([
        'harvest',
        '--decision-id',
        DECISION_ID,
        '--target-domain',
        'x',
        '--evidence-version',
        '1',
        '--snapshot-id',
        SNAPSHOT_ID,
        '--execute',
      ]),
    );
    const { deps } = makeDeps({
      transportImpl: async () => ({
        status: 200,
        json: {
          ok: true,
          result: {
            status: 'ready',
            handoffId: HANDOFF_ID,
            harvest: { rawSecretLookingField: 'raw-web-body-should-not-leak' },
            diagnostics: { toolCalls: 99 },
          },
        },
      }),
    });
    const outcome = await runStage(cmd, deps);
    const serialized = JSON.stringify(outcome);
    assert.ok(!serialized.includes('raw-web-body-should-not-leak'));
    assert.ok(!serialized.includes('toolCalls'));
    assert.deepEqual(outcome, {
      ok: true,
      stage: 'harvest',
      status: 'ready',
      identifiers: { handoffId: HANDOFF_ID },
    });
  });
});

describe('research-pipeline-operator · L. refresh stage', () => {
  it('dry-run(no --execute)은 network 0, secret 조회 0이다', async () => {
    const cmd = asOk(parseArgs(['refresh']));
    const { deps, secretCalls, transportCalls } = makeDeps({});
    const outcome = await runStage(cmd, deps);
    assert.deepEqual(outcome, { ok: true, stage: 'refresh', status: 'execution_required' });
    assert.equal(secretCalls.length, 0);
    assert.equal(transportCalls.length, 0);
  });

  it('Keychain에 토큰이 없으면 network 0으로 OPERATOR_CREDENTIAL_MISSING', async () => {
    const cmd = asOk(parseArgs(['refresh', '--execute']));
    const { deps, transportCalls } = makeDeps({ secretValue: null });
    const outcome = await runStage(cmd, deps);
    assert.deepEqual(outcome, { ok: false, stage: 'refresh', code: 'OPERATOR_CREDENTIAL_MISSING' });
    assert.equal(transportCalls.length, 0);
  });

  it('정확한 endpoint · method · auth header · 빈 body로 정확히 한 번 요청한다', async () => {
    const cmd = asOk(parseArgs(['refresh', '--execute']));
    const { deps, secretCalls, transportCalls } = makeDeps({
      transportImpl: async () => ({ status: 200, json: { ok: true, status: 'refreshed', itemsTouched: 0 } }),
    });
    const outcome = await runStage(cmd, deps);
    assert.equal(secretCalls.length, 1);
    assert.deepEqual(secretCalls[0], STAGE_CREDENTIALS.refresh);
    assert.equal(transportCalls.length, 1);
    const req = transportCalls[0];
    assert.equal(req.method, 'POST');
    assert.equal(req.url, `${FUNCTIONS_BASE_URL}/research-queue-refresh`);
    assert.equal(req.headers['x-internal-token'], FAKE_TOKEN);
    assert.equal(req.body, undefined);
    assert.deepEqual(outcome, {
      ok: true,
      stage: 'refresh',
      status: 'refreshed',
      identifiers: { itemsTouched: 0 },
    });
  });

  it('itemsTouched가 양수여도 정확히 전달된다', async () => {
    const cmd = asOk(parseArgs(['refresh', '--execute']));
    const { deps } = makeDeps({
      transportImpl: async () => ({ status: 200, json: { ok: true, status: 'refreshed', itemsTouched: 4 } }),
    });
    const outcome = await runStage(cmd, deps);
    assert.deepEqual(outcome, {
      ok: true,
      stage: 'refresh',
      status: 'refreshed',
      identifiers: { itemsTouched: 4 },
    });
  });

  it('Edge 응답의 extra field는 outcome에 나타나지 않는다', async () => {
    const cmd = asOk(parseArgs(['refresh', '--execute']));
    const { deps } = makeDeps({
      transportImpl: async () => ({
        status: 200,
        json: { ok: true, status: 'refreshed', itemsTouched: 2, unexpectedRawField: 'do-not-leak' },
      }),
    });
    const outcome = await runStage(cmd, deps);
    const serialized = JSON.stringify(outcome);
    assert.ok(!serialized.includes('do-not-leak'));
    assert.deepEqual(outcome, {
      ok: true,
      stage: 'refresh',
      status: 'refreshed',
      identifiers: { itemsTouched: 2 },
    });
  });

  it('실패해도 재시도하지 않는다(호출 횟수 정확히 1)', async () => {
    const cmd = asOk(parseArgs(['refresh', '--execute']));
    const { deps, transportCalls } = makeDeps({
      transportImpl: async () => ({ status: 503, json: { ok: false, error: 'QUEUE_REFRESH_UNAVAILABLE' } }),
    });
    const outcome = await runStage(cmd, deps);
    assert.equal(transportCalls.length, 1);
    assert.deepEqual(outcome, {
      ok: false,
      stage: 'refresh',
      code: 'QUEUE_REFRESH_UNAVAILABLE',
      httpStatus: 503,
    });
  });

  it('토큰 문자열이 outcome 어디에도 등장하지 않는다', async () => {
    const cmd = asOk(parseArgs(['refresh', '--execute']));
    const { deps } = makeDeps({
      transportImpl: async () => ({ status: 401, json: { ok: false, error: 'UNAUTHORIZED' } }),
    });
    const outcome = await runStage(cmd, deps);
    assert.ok(!JSON.stringify(outcome).includes(FAKE_TOKEN));
  });

  it('다른 project ref를 주입할 CLI 옵션이 없다', () => {
    assert.deepEqual(parseArgs(['refresh', '--project-ref', 'mylingo']), {
      ok: false,
      error: 'UNKNOWN_FLAG',
    });
  });

  it('refresh 성공 후 prioritize transport가 자동으로 불리지 않는다', async () => {
    const cmd = asOk(parseArgs(['refresh', '--execute']));
    const { deps, transportCalls } = makeDeps({
      transportImpl: async () => ({ status: 200, json: { ok: true, status: 'refreshed', itemsTouched: 1 } }),
    });
    await runStage(cmd, deps);
    assert.equal(transportCalls.length, 1);
    assert.ok(transportCalls.every((r) => !r.url.includes('research-prioritizer')));
  });
});

describe('research-pipeline-operator · credential missing (non-refresh)', () => {
  it('secretReader가 null을 주면 network 0으로 OPERATOR_CREDENTIAL_MISSING', async () => {
    const cmd = asOk(parseArgs(['prioritize', '--execute']));
    const { deps, transportCalls } = makeDeps({ secretValue: null });
    const outcome = await runStage(cmd, deps);
    assert.deepEqual(outcome, { ok: false, stage: 'prioritize', code: 'OPERATOR_CREDENTIAL_MISSING' });
    assert.equal(transportCalls.length, 0);
  });
});
