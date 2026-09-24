import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildBaselineRegistrationPlan,
  readStaticDomainLabels,
  runBaselineRegistration,
} from '../../scripts/register-scripture-catalog-baseline.ts';
import { makeExistingDomainCandidate } from './automatic-scripture-catalog-test-fixtures.ts';
import { SCRIPTURE_CARDS } from '../../supabase/functions/_shared/scripture-cards.ts';

const URL = 'https://example.supabase.co';
const KEY = 'local-test-service-role-key';

const deps = (responses: Response[]) => {
  let envCalls = 0;
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const output: string[] = [];
  return {
    value: {
      getEnv(name: string) { envCalls += 1; return name === 'SUPABASE_URL' ? URL : KEY; },
      fetchImpl: (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        const next = responses.shift();
        if (!next) throw new Error('unexpected fetch');
        return next;
      }) as typeof fetch,
      write(value: string) { output.push(value); },
    },
    calls,
    output,
    envCalls: () => envCalls,
  };
};

describe('운영 기준 Scripture Catalog 등록 도구', () => {
  it('정적 51장·17영역과 알려진 기준 지문으로 결정적 계획을 만든다', async () => {
    const first = await buildBaselineRegistrationPlan();
    const second = await buildBaselineRegistrationPlan();
    assert.deepEqual(second, first);
    assert.equal(first.catalog.cards.length, 51);
    assert.equal(first.catalog.domains.length, 17);
    assert.equal(first.versionHash, 'scat_7d27e84df2148b85cbadcdb31b402e762a5ce9d4477722426b13bc5bff337110');
    assert.match(first.requestId, /^screq_[0-9a-f]{32}$/);
  });

  it('공백·영문 표시 이름은 지문 계산·등록 전에 거절한다', async () => {
    const labels = readStaticDomainLabels();
    for (const displayName of [' ', 'Grief and Loss']) {
      await assert.rejects(
        () => buildBaselineRegistrationPlan({ domainDisplayNames: { ...labels, grief_loss: displayName } }),
        /baseline_catalog_invalid/,
      );
    }
  });

  it('계약을 어긴 카드 4종을 지문 계산·등록 전에 거절한다', async () => {
    const mutations: Array<(cards: typeof SCRIPTURE_CARDS) => void> = [
      (cards) => { cards[0] = { ...cards[0]!, userExplanation: '가'.repeat(601) }; },
      (cards) => { cards[0] = { ...cards[0]!, referenceLabel: '잘못된 표시' }; },
      (cards) => { cards[0] = { ...cards[0]!, prayerDirection: '' }; },
      (cards) => { cards[0] = { ...cards[0]!, situationTags: [] }; },
    ];
    for (const mutate of mutations) {
      const invalidCards = structuredClone(SCRIPTURE_CARDS);
      mutate(invalidCards);
      await assert.rejects(
        () => buildBaselineRegistrationPlan({ cards: invalidCards }),
        /baseline_catalog_invalid/,
      );
    }
  });

  it('계획 생성이 실패하면 정제된 baseline_invalid이고 환경변수·network는 0회다', async () => {
    let envCalls = 0;
    let fetchCalls = 0;
    const result = await runBaselineRegistration(['--execute'], {
      buildPlan: async () => { throw new Error('private source detail'); },
      getEnv: () => { envCalls += 1; return 'must-not-read'; },
      fetchImpl: (async () => { fetchCalls += 1; throw new Error('must-not-call'); }) as typeof fetch,
      write: () => {},
    });
    assert.deepEqual(result, { status: 'failed', reason: 'baseline_invalid' });
    assert.equal(envCalls, 0);
    assert.equal(fetchCalls, 0);
  });

  it('인자 없음과 --dry-run은 환경변수·network를 전혀 읽지 않는다', async () => {
    for (const args of [[], ['--dry-run']]) {
      const d = deps([]);
      const result = await runBaselineRegistration(args, d.value);
      assert.equal(result.status, 'dry_run');
      assert.equal(d.envCalls(), 0);
      assert.equal(d.calls.length, 0);
      assert.equal(d.output.length, 1);
    }
  });

  it('알 수 없거나 중복된 실행 인자는 환경변수·network 전에 거절한다', async () => {
    for (const args of [['--execute', '--execute'], ['--execute', '--dry-run'], ['--unknown']]) {
      const d = deps([]);
      assert.deepEqual(await runBaselineRegistration(args, d.value), { status: 'failed', reason: 'invalid_arguments' });
      assert.equal(d.envCalls(), 0);
      assert.equal(d.calls.length, 0);
    }
  });

  it('실행 설정이 없거나 URL이 올바르지 않으면 network 전에 거절한다', async () => {
    for (const values of [
      {} as Record<string, string>,
      { SUPABASE_URL: URL },
      { SUPABASE_URL: 'http://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: KEY },
      { SUPABASE_URL: 'https://example.supabase.co.evil.test', SUPABASE_SERVICE_ROLE_KEY: KEY },
    ]) {
      let calls = 0;
      const result = await runBaselineRegistration(['--execute'], {
        getEnv: (name) => values[name],
        fetchImpl: (async () => { calls += 1; throw new Error('must not call'); }) as typeof fetch,
        write: () => {},
      });
      assert.deepEqual(result, { status: 'failed', reason: 'configuration_error' });
      assert.equal(calls, 0);
    }
  });

  it('빈 활성판만 등록하고 같은 기준판을 재조회한 뒤 성공한다', async () => {
    const plan = await buildBaselineRegistrationPlan();
    const runtime = { activeVersionHash: plan.versionHash, pointerRevision: 1, catalog: plan.catalog };
    const d = deps([
      new Response('null', { status: 200 }),
      new Response(JSON.stringify('baseline-id'), { status: 200 }),
      new Response(JSON.stringify(runtime), { status: 200 }),
    ]);
    const result = await runBaselineRegistration(['--execute'], d.value);
    assert.equal(result.status, 'registered');
    assert.equal(d.calls.length, 3);
    assert.equal(d.calls.every((call) => call.init.redirect === 'manual' && call.init.signal instanceof AbortSignal), true);
    const body = JSON.parse(String(d.calls[1]?.init.body));
    assert.deepEqual(Object.keys(body).sort(), ['p_catalog', 'p_request_id', 'p_version_hash']);
    assert.equal(body.p_version_hash, plan.versionHash);
    assert.equal(body.p_request_id, plan.requestId);
  });

  it('이미 같은 기준판이면 쓰기 없이 성공한다', async () => {
    const plan = await buildBaselineRegistrationPlan();
    const d = deps([new Response(JSON.stringify({ activeVersionHash: plan.versionHash, pointerRevision: 4, catalog: plan.catalog }), { status: 200 })]);
    const result = await runBaselineRegistration(['--execute'], d.value);
    assert.equal(result.status, 'already_registered');
    assert.equal(d.calls.length, 1);
  });

  it('다른 활성판이면 자동으로 덮어쓰지 않는다', async () => {
    const plan = await buildBaselineRegistrationPlan();
    const other = await makeExistingDomainCandidate(plan.catalog);
    const d = deps([new Response(JSON.stringify({
      activeVersionHash: other.candidate.proposedVersionHash,
      pointerRevision: 2,
      catalog: other.proposedCatalog,
    }), { status: 200 })]);
    assert.deepEqual(await runBaselineRegistration(['--execute'], d.value), { status: 'failed', reason: 'active_catalog_conflict' });
    assert.equal(d.calls.length, 1);
  });

  it('잘못된 응답·비정상 HTTP를 성공으로 보거나 원문 노출하지 않는다', async () => {
    const scenarios: Array<[Response[], string]> = [
      [[new Response('{bad json', { status: 200 })], 'runtime_read_failed'],
      [[new Response('private database detail', { status: 503 })], 'runtime_read_failed'],
      [[new Response('null', { status: 200 }), new Response('private registration detail', { status: 409 })], 'registration_failed'],
    ];
    for (const [responses, reason] of scenarios) {
      const d = deps(responses);
      const result = await runBaselineRegistration(['--execute'], d.value);
      assert.deepEqual(result, { status: 'failed', reason });
      assert.equal(JSON.stringify(result).includes('private'), false);
    }
  });

  it('등록 뒤 지문·revision·catalog가 다르면 성공으로 보지 않는다', async () => {
    const plan = await buildBaselineRegistrationPlan();
    const d = deps([
      new Response('null', { status: 200 }),
      new Response(JSON.stringify('baseline-id'), { status: 200 }),
      new Response(JSON.stringify({ activeVersionHash: plan.versionHash, pointerRevision: 2, catalog: plan.catalog }), { status: 200 }),
    ]);
    assert.deepEqual(await runBaselineRegistration(['--execute'], d.value), { status: 'failed', reason: 'verification_failed' });
  });

  it('동시 등록이 먼저 성공해 RPC가 실패하면 runtime 재조회로 already_registered에 수렴한다', async () => {
    const plan = await buildBaselineRegistrationPlan();
    const runtime = { activeVersionHash: plan.versionHash, pointerRevision: 1, catalog: plan.catalog };
    const d = deps([
      new Response('null', { status: 200 }),
      new Response('duplicate key detail', { status: 409 }),
      new Response(JSON.stringify(runtime), { status: 200 }),
    ]);
    const result = await runBaselineRegistration(['--execute'], d.value);
    assert.equal(result.status, 'already_registered');
    assert.equal(d.calls.length, 3);
  });
});
