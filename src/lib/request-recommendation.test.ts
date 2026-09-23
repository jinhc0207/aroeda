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
  formatDevDiagnostic,
  type DomainChoiceOption,
  type InvokeOutcome,
  type RecommendationDeps,
} from './request-recommendation.ts';
import { SCRIPTURE_CARDS, getScriptureCard } from '../data/scripture-cards.ts';
import {
  SCRIPTURE_CATALOG_RUNTIME_CLIENT_VERSION,
  projectRuntimeCardView,
} from '../../supabase/functions/_shared/automatic-scripture-catalog-runtime.ts';

const readySession: SessionSummary = { sessionExists: true, isAnonymous: true, source: 'restored' };
const failedSession: SessionSummary = {
  sessionExists: false,
  isAnonymous: false,
  source: 'failed',
  errorName: 'AuthApiError',
};

const cardExists = (cardId: string) => SCRIPTURE_CARDS.some((card) => card.id === cardId);
const cardBelongsToDomain = (cardId: string, domain: string) => {
  const card = SCRIPTURE_CARDS.find((item) => item.id === cardId);
  return card ? card.domains.includes(domain as never) : false;
};

/**
 * primaryDomain 인자를 아예 주지 않으면(undefined) selectedCardId가 실제로 속한 영역을 그대로 쓴다
 * (모르는 id면 fear_uncertainty). null 등 값을 직접 넘기면 그 값을 그대로 쓴다 — 잘못된 값도 시험해야 하므로
 * "지정 안 함"과 "null을 지정함"을 구분한다.
 */
const gatePayload = (route: string, selectedCardId: string | null, primaryDomain?: string | null) => ({
  ok: true,
  result: {
    route,
    reason: route === 'recommend' ? 'CARD_SELECTED' : 'PRIMARY_DOMAIN_NOT_COVERED',
    primaryDomain:
      primaryDomain !== undefined
        ? primaryDomain
        : selectedCardId && cardExists(selectedCardId)
          ? getScriptureCard(selectedCardId).domains[0]
          : 'fear_uncertainty',
    domainChoiceCandidates: [],
    domainChoiceOptions: [],
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

/**
 * top-level primaryDomain/selectedCardId는 기본으로 null이다(문서의 domain_choice 불변식).
 * 모순 응답을 시험할 때만 overrides로 값을 채워 넣는다.
 */
const domainChoicePayload = (
  candidates: string[],
  options: DomainChoiceOption[],
  overrides: { primaryDomain?: unknown; selectedCardId?: unknown } = {},
) => ({
  ok: true,
  result: {
    route: 'domain_choice',
    reason: 'DOMAIN_PRIORITY_UNRESOLVED',
    primaryDomain: 'primaryDomain' in overrides ? overrides.primaryDomain : null,
    domainChoiceCandidates: candidates,
    domainChoiceOptions: options,
    secondaryDomains: [],
    safety: { level: 'normal', categories: [] },
    coverage: null,
    eligibleDomains: [],
    eligibleCardIds: [],
    rankedCandidates: [],
    selectedCardId: 'selectedCardId' in overrides ? overrides.selectedCardId : null,
    isTie: false,
  },
});

const dynamicCard = {
  ...projectRuntimeCardView(getScriptureCard('SC-001')),
  id: 'SC-999',
  domains: ['caregiving_strain'],
};
const withRuntimeViews = <T extends object>(payload: T, cards = [dynamicCard]) => ({
  ...payload,
  cards,
  domains: [{ id: 'caregiving_strain', displayName: '오래 돌보는 무게' }],
});

function fakeDeps(options: {
  session?: SessionSummary;
  sessionThrows?: boolean;
  outcome?: InvokeOutcome;
  invokeThrows?: boolean;
}) {
  const calls = { ensureSession: 0, invoke: 0 };
  const sent: { situation: string; catalogRuntimeVersion: string }[] = [];

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
    cardBelongsToDomain,
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
      assert.deepEqual(outcome, { status: 'error', kind: 'general', diagnostic: 'NONE' });
    }
  });

  it('세션 준비에 실패하면 서버를 부르지 않는다', async () => {
    for (const options of [{ session: failedSession }, { sessionThrows: true }]) {
      const { deps, calls } = fakeDeps(options);
      const outcome = await requestRecommendation('두렵습니다.', deps);

      assert.equal(calls.invoke, 0, '서버를 호출했습니다.');
      assert.deepEqual(outcome, {
        status: 'error',
        kind: 'auth',
        diagnostic: 'AUTH_SESSION_PREP_FAILED',
      });
    }
  });

  it('recommend면 카드 id와 그 카드의 영역을 돌려주고 서버는 한 번만 부른다', async () => {
    const { deps, calls, sent } = fakeDeps({});
    const outcome = await requestRecommendation('두렵습니다.', deps);

    assert.equal(calls.invoke, 1);
    assert.deepEqual(sent, [{
      situation: '두렵습니다.',
      catalogRuntimeVersion: SCRIPTURE_CATALOG_RUNTIME_CLIENT_VERSION,
    }]);
    assert.deepEqual(outcome, { status: 'recommend', cardId: 'SC-001', selectedDomain: 'fear_uncertainty' });
  });

  it('서버가 고른 다른 카드도 그대로 쓴다', async () => {
    const { deps } = fakeDeps({ outcome: { ok: true, data: gatePayload('recommend', 'SC-009') } });
    const outcome = await requestRecommendation('어머니가 돌아가셨어요.', deps);

    assert.deepEqual(outcome, { status: 'recommend', cardId: 'SC-009', selectedDomain: 'grief_loss' });
  });

  it('활성 카탈로그가 보낸 새 영역 카드도 모양·본문·영역을 검증해 그대로 돌려준다', async () => {
    const payload = withRuntimeViews(gatePayload('recommend', dynamicCard.id, 'caregiving_strain'));
    const { deps } = fakeDeps({ outcome: { ok: true, data: payload } });
    const result = await requestRecommendation('오래 돌보느라 지쳤어요.', deps);
    assert.deepEqual(result, {
      status: 'recommend',
      cardId: dynamicCard.id,
      selectedDomain: 'caregiving_strain',
      card: dynamicCard,
    });
  });

  it('새 카드 공개 모양에 내부 필드·틀린 본문 표기·영역 불일치가 있으면 거절한다', async () => {
    for (const card of [
      { ...dynamicCard, theologicalInsight: '내부 전용' },
      { ...dynamicCard, referenceLabel: '틀린 표기' },
      { ...dynamicCard, domains: ['fear_uncertainty'] },
    ]) {
      const { deps } = fakeDeps({
        outcome: { ok: true, data: withRuntimeViews(gatePayload('recommend', dynamicCard.id, 'caregiving_strain'), [card]) },
      });
      assert.deepEqual(await requestRecommendation('상황', deps), {
        status: 'error', kind: 'general', diagnostic: 'FUNCTION_RESPONSE_INVALID',
      });
    }
  });

  it('카드가 primaryDomain에 실제로 속하지 않으면 믿지 않는다', async () => {
    // SC-001은 fear_uncertainty 카드인데, 서버가 다른 영역을 primaryDomain이라고 우긴다.
    const { deps } = fakeDeps({
      outcome: { ok: true, data: gatePayload('recommend', 'SC-001', 'grief_loss') },
    });
    const outcome = await requestRecommendation('두렵습니다.', deps);

    assert.deepEqual(outcome, {
      status: 'error',
      kind: 'general',
      diagnostic: 'FUNCTION_RESPONSE_INVALID',
    });
  });

  it('primaryDomain이 other_uncovered이거나 모르는 값이면 믿지 않는다', async () => {
    for (const primaryDomain of ['other_uncovered', '없는영역', null, 42]) {
      const { deps } = fakeDeps({
        outcome: { ok: true, data: gatePayload('recommend', 'SC-001', primaryDomain as never) },
      });
      const outcome = await requestRecommendation('두렵습니다.', deps);

      assert.deepEqual(
        outcome,
        { status: 'error', kind: 'general', diagnostic: 'FUNCTION_RESPONSE_INVALID' },
        JSON.stringify(primaryDomain),
      );
    }
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

    assert.deepEqual(outcome, {
      status: 'error',
      kind: 'rate_limited',
      diagnostic: 'FUNCTION_HTTP_429',
    });
  });

  it('401은 일반 오류 문구를 쓰되 진단은 따로 구분한다', async () => {
    const { deps } = fakeDeps({ outcome: { ok: false, httpStatus: 401 } });
    const outcome = await requestRecommendation('두렵습니다.', deps);

    assert.deepEqual(outcome, {
      status: 'error',
      kind: 'general',
      diagnostic: 'FUNCTION_HTTP_401',
    });
  });

  it('5xx / 네트워크 계열 / 그 밖의 상태 코드 / invoke 예외를 각각 구분한다', async () => {
    const cases: { options: { outcome?: InvokeOutcome; invokeThrows?: boolean }; diagnostic: string }[] = [
      { options: { outcome: { ok: false, httpStatus: 503 } }, diagnostic: 'FUNCTION_HTTP_5XX' },
      { options: { outcome: { ok: false, httpStatus: 500 } }, diagnostic: 'FUNCTION_HTTP_5XX' },
      { options: { outcome: { ok: false } }, diagnostic: 'FUNCTION_NETWORK_FAILED' },
      { options: { outcome: { ok: false, httpStatus: 400 } }, diagnostic: 'FUNCTION_HTTP_OTHER' },
      { options: { invokeThrows: true }, diagnostic: 'FUNCTION_INVOKE_FAILED' },
    ];

    for (const { options, diagnostic } of cases) {
      const { deps } = fakeDeps(options);
      const outcome = await requestRecommendation('두렵습니다.', deps);

      assert.deepEqual(
        outcome,
        { status: 'error', kind: 'general', diagnostic },
        `${JSON.stringify(options)} -> ${JSON.stringify(outcome)}`,
      );
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
        { status: 'error', kind: 'general', diagnostic: 'FUNCTION_RESPONSE_INVALID' },
        `${JSON.stringify(data)}가 통과되었습니다.`,
      );
    }
  });

  it('우리가 모르는 카드 id면 SC-001로 되돌리지 않는다', async () => {
    for (const cardId of ['SC-999', 'SC-000', '', ' SC-001']) {
      const { deps } = fakeDeps({ outcome: { ok: true, data: gatePayload('recommend', cardId) } });
      const outcome = await requestRecommendation('두렵습니다.', deps);

      assert.deepEqual(
        outcome,
        { status: 'error', kind: 'general', diagnostic: 'FUNCTION_RESPONSE_INVALID' },
        `${cardId}가 통과되었습니다.`,
      );
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

  it('실패 결과에도 토큰/세션/응답 원문이 담기지 않는다', async () => {
    const FAKE_TOKEN = 'sb_publishable_should_never_leak_here';
    for (const options of [
      { session: failedSession },
      { outcome: { ok: false as const, httpStatus: 401 } },
      { outcome: { ok: true, data: { ok: true, result: null } } },
      { invokeThrows: true },
    ]) {
      const { deps } = fakeDeps(options);
      const outcome = await requestRecommendation('두렵습니다.', deps);
      const serialized = JSON.stringify(outcome);

      assert.ok(!serialized.includes(FAKE_TOKEN));
      assert.ok(!serialized.includes('AuthApiError'));
      assert.ok(!serialized.includes('network'));
      assert.ok(!serialized.includes('failed to fetch'));
    }
  });
});

describe('영역 선택(domain_choice) 응답', () => {
  const recommendOption = (domain: string, cardId: string): DomainChoiceOption => ({
    domain: domain as never,
    resolution: 'recommend',
    selectedCardId: cardId,
  });
  const noCoverageOption = (domain: string): DomainChoiceOption => ({
    domain: domain as never,
    resolution: 'no_coverage',
    selectedCardId: null,
  });
  const ambiguousOption = (domain: string): DomainChoiceOption => ({
    domain: domain as never,
    resolution: 'ambiguous',
    selectedCardId: null,
  });

  it('후보 둘·option 둘이 순서대로 맞으면 그대로 돌려준다', async () => {
    const options = [recommendOption('fear_uncertainty', 'SC-001'), noCoverageOption('financial_hardship')];
    const { deps } = fakeDeps({
      outcome: {
        ok: true,
        data: domainChoicePayload(['fear_uncertainty', 'financial_hardship'], options),
      },
    });

    const outcome = await requestRecommendation('생활비도 걱정, 면접도 걱정입니다.', deps);

    assert.deepEqual(outcome, { status: 'domain_choice', options });
  });

  it('활성 카탈로그의 새 영역 선택지는 한국어 이름과 공개 카드를 함께 보존한다', async () => {
    const rawOptions = [
      recommendOption('caregiving_strain', dynamicCard.id),
      noCoverageOption('financial_hardship'),
    ];
    const payload = withRuntimeViews(
      domainChoicePayload(['caregiving_strain', 'financial_hardship'], rawOptions),
    );
    const { deps } = fakeDeps({ outcome: { ok: true, data: payload } });

    assert.deepEqual(await requestRecommendation('돌봄과 생활비가 함께 버거워요.', deps), {
      status: 'domain_choice',
      options: [
        {
          domain: 'caregiving_strain',
          displayName: '오래 돌보는 무게',
          resolution: 'recommend',
          selectedCardId: dynamicCard.id,
          selectedCard: dynamicCard,
        },
        {
          domain: 'financial_hardship',
          resolution: 'no_coverage',
          selectedCardId: null,
        },
      ],
    });
  });

  it('option은 멀쩡해도 top-level primaryDomain이 문자열이면 거절한다', async () => {
    // option 판독까지 가면 통과할 완전히 유효한 후보·option인데도, top-level primaryDomain이
    // 채워져 있으면 domain_choice의 불변식(아직 영역이 정해지지 않았다)에 어긋난다.
    const options = [recommendOption('fear_uncertainty', 'SC-001'), noCoverageOption('financial_hardship')];
    const { deps } = fakeDeps({
      outcome: {
        ok: true,
        data: domainChoicePayload(['fear_uncertainty', 'financial_hardship'], options, {
          primaryDomain: 'fear_uncertainty',
        }),
      },
    });

    const outcome = await requestRecommendation('상황입니다.', deps);

    assert.deepEqual(outcome, { status: 'error', kind: 'general', diagnostic: 'FUNCTION_RESPONSE_INVALID' });
  });

  it('option은 멀쩡해도 top-level selectedCardId가 카드 번호면 거절한다', async () => {
    const options = [recommendOption('fear_uncertainty', 'SC-001'), noCoverageOption('financial_hardship')];
    const { deps } = fakeDeps({
      outcome: {
        ok: true,
        data: domainChoicePayload(['fear_uncertainty', 'financial_hardship'], options, {
          selectedCardId: 'SC-001',
        }),
      },
    });

    const outcome = await requestRecommendation('상황입니다.', deps);

    assert.deepEqual(outcome, { status: 'error', kind: 'general', diagnostic: 'FUNCTION_RESPONSE_INVALID' });
  });

  it('primaryDomain과 selectedCardId가 둘 다 채워져 있어도 거절한다', async () => {
    const options = [recommendOption('fear_uncertainty', 'SC-001'), noCoverageOption('financial_hardship')];
    const { deps } = fakeDeps({
      outcome: {
        ok: true,
        data: domainChoicePayload(['fear_uncertainty', 'financial_hardship'], options, {
          primaryDomain: 'fear_uncertainty',
          selectedCardId: 'SC-001',
        }),
      },
    });

    const outcome = await requestRecommendation('상황입니다.', deps);

    assert.deepEqual(outcome, { status: 'error', kind: 'general', diagnostic: 'FUNCTION_RESPONSE_INVALID' });
  });

  it('resolution이 recommend가 아니면 cardId가 null이 아닐 때 거절한다', async () => {
    for (const bad of [
      { domain: 'fear_uncertainty', resolution: 'ambiguous', selectedCardId: 'SC-001' },
      { domain: 'fear_uncertainty', resolution: 'no_coverage', selectedCardId: 'SC-001' },
    ]) {
      const options = [bad, noCoverageOption('financial_hardship')];
      const { deps } = fakeDeps({
        outcome: { ok: true, data: domainChoicePayload(['fear_uncertainty', 'financial_hardship'], options as never) },
      });

      const outcome = await requestRecommendation('상황입니다.', deps);

      assert.deepEqual(outcome, { status: 'error', kind: 'general', diagnostic: 'FUNCTION_RESPONSE_INVALID' });
    }
  });

  it('recommend option의 카드가 실제로 없거나 그 영역 카드가 아니면 거절한다', async () => {
    for (const badCardId of ['SC-999', 'SC-015']) {
      // SC-015는 실제 카드이지만 financial_hardship이지 fear_uncertainty가 아니다.
      const options = [recommendOption('fear_uncertainty', badCardId), noCoverageOption('financial_hardship')];
      const { deps } = fakeDeps({
        outcome: {
          ok: true,
          data: domainChoicePayload(['fear_uncertainty', 'financial_hardship'], options),
        },
      });

      const outcome = await requestRecommendation('상황입니다.', deps);

      assert.deepEqual(
        outcome,
        { status: 'error', kind: 'general', diagnostic: 'FUNCTION_RESPONSE_INVALID' },
        badCardId,
      );
    }
  });

  it('후보가 둘이 아니거나 서로 같거나 other_uncovered/모르는 영역이면 거절한다', async () => {
    const badCandidateSets: string[][] = [
      ['fear_uncertainty'],
      ['fear_uncertainty', 'financial_hardship', 'grief_loss'],
      ['fear_uncertainty', 'fear_uncertainty'],
      ['fear_uncertainty', 'other_uncovered'],
      ['fear_uncertainty', '없는영역'],
    ];

    for (const candidates of badCandidateSets) {
      const options = candidates
        .slice(0, 2)
        .map((domain) => noCoverageOption(domain)) as [DomainChoiceOption, DomainChoiceOption];
      const { deps } = fakeDeps({
        outcome: { ok: true, data: domainChoicePayload(candidates, options) },
      });

      const outcome = await requestRecommendation('상황입니다.', deps);

      assert.deepEqual(
        outcome,
        { status: 'error', kind: 'general', diagnostic: 'FUNCTION_RESPONSE_INVALID' },
        JSON.stringify(candidates),
      );
    }
  });

  it('option 순서가 후보 순서와 다르면 거절한다', async () => {
    // candidates는 [fear_uncertainty, financial_hardship] 순인데 option은 뒤바뀌어 있다.
    const options = [noCoverageOption('financial_hardship'), recommendOption('fear_uncertainty', 'SC-001')];
    const { deps } = fakeDeps({
      outcome: { ok: true, data: domainChoicePayload(['fear_uncertainty', 'financial_hardship'], options) },
    });

    const outcome = await requestRecommendation('상황입니다.', deps);

    assert.deepEqual(outcome, { status: 'error', kind: 'general', diagnostic: 'FUNCTION_RESPONSE_INVALID' });
  });

  it('option이 둘이 아니거나 모양이 다르면 거절한다', async () => {
    const brokenOptionSets: unknown[] = [
      [recommendOption('fear_uncertainty', 'SC-001')],
      [recommendOption('fear_uncertainty', 'SC-001'), noCoverageOption('financial_hardship'), ambiguousOption('grief_loss')],
      [null, noCoverageOption('financial_hardship')],
      ['recommend', noCoverageOption('financial_hardship')],
    ];

    for (const options of brokenOptionSets) {
      const { deps } = fakeDeps({
        outcome: {
          ok: true,
          data: domainChoicePayload(['fear_uncertainty', 'financial_hardship'], options as never),
        },
      });

      const outcome = await requestRecommendation('상황입니다.', deps);

      assert.deepEqual(
        outcome,
        { status: 'error', kind: 'general', diagnostic: 'FUNCTION_RESPONSE_INVALID' },
        JSON.stringify(options),
      );
    }
  });

  it('결과에 사용자 문장이 담기지 않는다', async () => {
    const situation = '아무에게도 말하지 못한 개인적인 이야기이고, 다른 걱정도 함께 있습니다.';
    const options = [recommendOption('fear_uncertainty', 'SC-001'), noCoverageOption('financial_hardship')];
    const { deps } = fakeDeps({
      outcome: { ok: true, data: domainChoicePayload(['fear_uncertainty', 'financial_hardship'], options) },
    });

    const outcome = await requestRecommendation(situation, deps);

    assert.equal(JSON.stringify(outcome).includes(situation), false);
    assert.equal(JSON.stringify(outcome).includes('개인적인'), false);
  });
});

describe('formatDevDiagnostic', () => {
  it('production(isDev=false)에서는 항상 null이다', () => {
    assert.equal(formatDevDiagnostic(false, 'AUTH_SESSION_PREP_FAILED'), null);
    assert.equal(formatDevDiagnostic(false, 'FUNCTION_HTTP_401'), null);
    assert.equal(formatDevDiagnostic(false, null), null);
  });

  it('개발 모드에서도 NONE/null이면 아무것도 보여주지 않는다', () => {
    assert.equal(formatDevDiagnostic(true, 'NONE'), null);
    assert.equal(formatDevDiagnostic(true, null), null);
  });

  it('개발 모드에서 실제 실패면 안전한 코드 문자열을 낸다', () => {
    assert.equal(formatDevDiagnostic(true, 'AUTH_SESSION_PREP_FAILED'), '개발 진단: AUTH_SESSION_PREP_FAILED');
    assert.equal(formatDevDiagnostic(true, 'FUNCTION_HTTP_401'), '개발 진단: FUNCTION_HTTP_401');
  });
});
