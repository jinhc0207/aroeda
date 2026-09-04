/**
 * 첫 화면 → 서버 추천 요청 테스트
 *
 * 실행: npm test
 *
 * 실제 Supabase나 OpenAI를 부르지 않는다. 가짜 함수로 흐름만 확인한다.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { SessionSummary } from './anonymous-session.ts';
import {
  requestRecommendation,
  type InvokeOutcome,
  type RecommendationDeps,
} from './request-recommendation.ts';
import { SCRIPTURE_CARDS } from '../data/scripture-cards.ts';

const readySession: SessionSummary = { sessionExists: true, isAnonymous: true, source: 'restored' };
const failedSession: SessionSummary = {
  sessionExists: false,
  isAnonymous: false,
  source: 'failed',
  errorName: 'AuthApiError',
};

const cardExists = (cardId: string) => SCRIPTURE_CARDS.some((card) => card.id === cardId);

const gatePayload = (route: string, selectedCardId: string | null) => ({
  ok: true,
  result: {
    route,
    reason: route === 'recommend' ? 'CARD_SELECTED' : 'PRIMARY_DOMAIN_NOT_COVERED',
    primaryDomain: 'fear_uncertainty',
    secondaryDomains: [],
    safety: { level: 'normal', categories: [] },
    coverage: { primaryDomain: 'fear_uncertainty', covered: true, cardIds: ['SC-001'] },
    eligibleDomains: ['fear_uncertainty'],
    eligibleCardIds: ['SC-001'],
    rankedCandidates: [],
    selectedCardId,
    isTie: false,
  },
});

function fakeDeps(options: {
  session?: SessionSummary;
  sessionThrows?: boolean;
  outcome?: InvokeOutcome;
  invokeThrows?: boolean;
}) {
  const calls = { ensureSession: 0, invoke: 0 };
  const sent: { situation: string }[] = [];

  const deps: RecommendationDeps = {
    async ensureSession() {
      calls.ensureSession += 1;
      if (options.sessionThrows) throw new Error('network');
      return options.session ?? readySession;
    },
    async invokeRecommendScripture(body) {
      calls.invoke += 1;
      sent.push(body);
      if (options.invokeThrows) throw new Error('failed to fetch');
      return options.outcome ?? { ok: true, data: gatePayload('recommend', 'SC-001') };
    },
    cardExists,
  };

  return { deps, calls, sent };
}

describe('말씀 추천 요청', () => {
  it('빈 입력이면 세션도 서버도 부르지 않는다', async () => {
    for (const situation of ['', '   ', '\n\t']) {
      const { deps, calls } = fakeDeps({});
      const outcome = await requestRecommendation(situation, deps);

      assert.equal(calls.ensureSession, 0);
      assert.equal(calls.invoke, 0);
      assert.equal(outcome.status, 'error');
    }
  });

  it('세션 준비에 실패하면 서버를 부르지 않는다', async () => {
    for (const options of [{ session: failedSession }, { sessionThrows: true }]) {
      const { deps, calls } = fakeDeps(options);
      const outcome = await requestRecommendation('두렵습니다.', deps);

      assert.equal(calls.invoke, 0, '서버를 호출했습니다.');
      assert.deepEqual(outcome, { status: 'error', kind: 'auth' });
    }
  });

  it('recommend면 카드 id를 돌려주고 서버는 한 번만 부른다', async () => {
    const { deps, calls, sent } = fakeDeps({});
    const outcome = await requestRecommendation('두렵습니다.', deps);

    assert.equal(calls.invoke, 1);
    assert.deepEqual(sent, [{ situation: '두렵습니다.' }]);
    assert.deepEqual(outcome, { status: 'recommend', cardId: 'SC-001' });
  });

  it('서버가 고른 다른 카드도 그대로 쓴다', async () => {
    const { deps } = fakeDeps({ outcome: { ok: true, data: gatePayload('recommend', 'SC-009') } });
    const outcome = await requestRecommendation('어머니가 돌아가셨어요.', deps);

    assert.deepEqual(outcome, { status: 'recommend', cardId: 'SC-009' });
  });

  it('no_coverage / safety / ambiguous는 각각 그대로 전달한다', async () => {
    for (const route of ['no_coverage', 'safety', 'ambiguous'] as const) {
      const { deps } = fakeDeps({ outcome: { ok: true, data: gatePayload(route, null) } });
      const outcome = await requestRecommendation('상황입니다.', deps);

      assert.deepEqual(outcome, { status: 'route', route });
    }
  });

  it('429는 사용량 제한으로 구분한다', async () => {
    const { deps } = fakeDeps({ outcome: { ok: false, httpStatus: 429 } });
    const outcome = await requestRecommendation('두렵습니다.', deps);

    assert.deepEqual(outcome, { status: 'error', kind: 'rate_limited' });
  });

  it('503과 네트워크 실패는 일반 오류로 다룬다', async () => {
    for (const options of [
      { outcome: { ok: false as const, httpStatus: 503 } },
      { outcome: { ok: false as const, httpStatus: 500 } },
      { outcome: { ok: false as const } },
      { invokeThrows: true },
    ]) {
      const { deps } = fakeDeps(options);
      const outcome = await requestRecommendation('두렵습니다.', deps);

      assert.deepEqual(outcome, { status: 'error', kind: 'general' });
    }
  });

  it('이상한 응답에는 임의의 카드로 대체하지 않는다', async () => {
    const brokenPayloads = [
      null,
      'ok',
      { ok: false, error: 'RATE_LIMITED' },
      { ok: true },
      { ok: true, result: {} },
      { ok: true, result: { route: 'unknown_route', selectedCardId: 'SC-001' } },
      { ok: true, result: { route: 'recommend', selectedCardId: null } },
      { ok: true, result: { route: 'recommend', selectedCardId: 42 } },
    ];

    for (const data of brokenPayloads) {
      const { deps } = fakeDeps({ outcome: { ok: true, data } });
      const outcome = await requestRecommendation('두렵습니다.', deps);

      assert.deepEqual(
        outcome,
        { status: 'error', kind: 'general' },
        `${JSON.stringify(data)}가 통과되었습니다.`,
      );
    }
  });

  it('우리가 모르는 카드 id면 SC-001로 되돌리지 않는다', async () => {
    for (const cardId of ['SC-999', 'SC-000', '', ' SC-001']) {
      const { deps } = fakeDeps({ outcome: { ok: true, data: gatePayload('recommend', cardId) } });
      const outcome = await requestRecommendation('두렵습니다.', deps);

      assert.deepEqual(outcome, { status: 'error', kind: 'general' }, `${cardId}가 통과되었습니다.`);
      assert.equal(JSON.stringify(outcome).includes('SC-001'), false);
    }
  });

  it('결과에 사용자 문장이 담기지 않는다', async () => {
    const situation = '아무에게도 말하지 못한 개인적인 이야기입니다.';
    const { deps } = fakeDeps({});
    const outcome = await requestRecommendation(situation, deps);

    assert.equal(JSON.stringify(outcome).includes(situation), false);
    assert.equal(JSON.stringify(outcome).includes('개인적인'), false);
  });
});
