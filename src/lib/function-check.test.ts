/**
 * 서버 연결 점검 테스트
 *
 * 실행: npm test
 *
 * 실제 Supabase나 OpenAI를 부르지 않는다. 가짜 함수로 흐름만 확인한다.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { SessionSummary } from './anonymous-session.ts';
import {
  EXPECTED,
  FUNCTION_CHECK_SITUATION,
  runFunctionCheck,
  type FunctionCheckDeps,
} from './function-check.ts';

const readySession: SessionSummary = { sessionExists: true, isAnonymous: true, source: 'restored' };
const failedSession: SessionSummary = {
  sessionExists: false,
  isAnonymous: false,
  source: 'failed',
  errorName: 'AuthApiError',
};

const goodPayload = {
  ok: true,
  result: {
    route: EXPECTED.route,
    reason: 'CARD_SELECTED',
    primaryDomain: EXPECTED.primaryDomain,
    secondaryDomains: [],
    safety: { level: EXPECTED.safetyLevel, categories: [] },
    coverage: { primaryDomain: EXPECTED.primaryDomain, covered: true, cardIds: ['SC-001'] },
    eligibleDomains: ['fear_uncertainty'],
    eligibleCardIds: ['SC-001'],
    rankedCandidates: [{ cardId: 'SC-001', totalScore: 80 }],
    selectedCardId: EXPECTED.selectedCardId,
    isTie: false,
  },
};

function fakeDeps(options: {
  session?: SessionSummary;
  sessionThrows?: boolean;
  data?: unknown;
  error?: unknown;
  invokeThrows?: boolean;
}) {
  const calls = { ensureSession: 0, invoke: 0 };
  const sentBodies: { situation: string }[] = [];

  const deps: FunctionCheckDeps = {
    async ensureSession() {
      calls.ensureSession += 1;
      if (options.sessionThrows) throw new Error('network');
      return options.session ?? readySession;
    },
    async invokeRecommendScripture(body) {
      calls.invoke += 1;
      sentBodies.push(body);
      if (options.invokeThrows) throw new Error('failed to fetch');
      return { data: 'data' in options ? options.data : goodPayload, error: options.error ?? null };
    },
  };

  return { deps, calls, sentBodies };
}

describe('서버 연결 점검', () => {
  it('세션 준비에 실패하면 Edge Function을 부르지 않는다', async () => {
    const { deps, calls } = fakeDeps({ session: failedSession });
    const result = await runFunctionCheck(deps);

    assert.equal(calls.invoke, 0, 'Edge Function을 호출했습니다.');
    assert.deepEqual(result, { status: 'failed', sessionReady: false, failure: 'AUTH_FAILED' });
  });

  it('세션 확인 중 예외가 나도 호출하지 않는다', async () => {
    const { deps, calls } = fakeDeps({ sessionThrows: true });
    const result = await runFunctionCheck(deps);

    assert.equal(calls.invoke, 0);
    assert.equal(result.status, 'failed');
  });

  it('세션이 준비되면 recommend-scripture를 한 번만 부른다', async () => {
    const { deps, calls, sentBodies } = fakeDeps({});
    const result = await runFunctionCheck(deps);

    assert.equal(calls.ensureSession, 1);
    assert.equal(calls.invoke, 1);
    assert.deepEqual(sentBodies, [{ situation: FUNCTION_CHECK_SITUATION }]);
    assert.equal(result.status, 'ok');
  });

  it('정상 응답을 요약해서 돌려준다', async () => {
    const { deps } = fakeDeps({});
    const result = await runFunctionCheck(deps);

    assert.deepEqual(result, {
      status: 'ok',
      sessionReady: true,
      route: 'recommend',
      primaryDomain: 'fear_uncertainty',
      selectedCardId: 'SC-001',
      safetyLevel: 'normal',
      matchesExpectation: true,
    });
  });

  it('연결은 되었지만 기대와 다른 결과는 구분한다', async () => {
    const { deps } = fakeDeps({
      data: {
        ok: true,
        result: {
          route: 'no_coverage',
          primaryDomain: 'financial_hardship',
          selectedCardId: null,
          safety: { level: 'normal', categories: [] },
        },
      },
    });
    const result = await runFunctionCheck(deps);

    assert.equal(result.status, 'ok');
    if (result.status === 'ok') {
      assert.equal(result.matchesExpectation, false);
      assert.equal(result.route, 'no_coverage');
    }
  });

  it('호출이 실패하면 FUNCTION_FAILED로 처리한다', async () => {
    for (const options of [{ invokeThrows: true }, { error: { message: 'Edge Function returned 500' } }]) {
      const { deps } = fakeDeps(options);
      const result = await runFunctionCheck(deps);
      assert.deepEqual(result, { status: 'failed', sessionReady: true, failure: 'FUNCTION_FAILED' });
    }
  });

  it('이상한 응답은 UNEXPECTED_RESPONSE로 막는다', async () => {
    const brokenPayloads = [
      null,
      'hello',
      { ok: false, error: 'INVALID_INPUT' },
      { ok: true },
      { ok: true, result: { route: 'recommend' } },
      { ok: true, result: { route: 1, primaryDomain: 'fear_uncertainty', selectedCardId: null, safety: { level: 'normal' } } },
      { ok: true, result: { route: 'recommend', primaryDomain: 'fear_uncertainty', selectedCardId: null } },
    ];

    for (const data of brokenPayloads) {
      const { deps } = fakeDeps({ data });
      const result = await runFunctionCheck(deps);
      assert.deepEqual(
        result,
        { status: 'failed', sessionReady: true, failure: 'UNEXPECTED_RESPONSE' },
        `${JSON.stringify(data)}가 통과되었습니다.`,
      );
    }
  });

  it('결과에 토큰이나 사용자 id가 섞이지 않는다', async () => {
    const { deps } = fakeDeps({
      data: {
        ok: true,
        result: {
          ...goodPayload.result,
          // 서버가 실수로 민감한 값을 보내더라도 요약에는 담기지 않아야 한다.
          access_token: 'access-token-secret',
          user: { id: 'uuid-should-not-leak' },
        },
      },
    });
    const result = await runFunctionCheck(deps);
    const text = JSON.stringify(result).toLowerCase();

    for (const banned of ['access-token-secret', 'uuid-should-not-leak', 'authorization', 'bearer', 'jwt']) {
      assert.equal(text.includes(banned), false, `${banned}가 결과에 있습니다.`);
    }
  });
});
