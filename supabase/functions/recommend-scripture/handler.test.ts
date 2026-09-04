/**
 * recommend-scripture 순수 테스트
 *
 * 실행: npm test
 *
 * 실제 OpenAI를 부르지 않는다. 분석 결과를 가짜로 넣어 Gate까지의 흐름만 확인한다.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MAX_SITUATION_LENGTH, handleRecommendScripture, type Handlerdeps } from './handler.ts';
import type { GateResult } from '../_shared/recommendation-gate.ts';
import { createSupabaseCoverageGapRecorder } from '../_shared/coverage-gap.ts';
import type { SituationAnalysis } from '../_shared/situation-analysis.ts';

const baseAnalysis: SituationAnalysis = {
  primaryDomain: 'fear_uncertainty',
  secondaryDomains: [],
  situationTags: [],
  emotionTags: [],
  spiritualQuestionTags: [],
  prayerModes: [],
  pastoralFunctions: [],
  safety: { level: 'normal', categories: [] },
  confidence: 0.8,
};

const analysisOf = (overrides: Partial<SituationAnalysis>): SituationAnalysis => ({
  ...baseAnalysis,
  ...overrides,
});

const openAIResponse = (analysis: unknown) => ({
  output: [
    { type: 'reasoning', summary: [] },
    { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(analysis) }] },
  ],
  usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
});

const allowQuota = async () => ({ status: 'allowed' }) as const;

const depsReturning = (analysis: unknown, overrides: Partial<Handlerdeps> = {}): Handlerdeps => ({
  checkQuota: allowQuota,
  getApiKey: () => 'test-key-not-real',
  callOpenAI: async () => openAIResponse(analysis),
  ...overrides,
});

const post = (body: unknown) =>
  new Request('http://localhost/recommend-scripture', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

async function gateFor(analysis: SituationAnalysis, situation = '지금 나의 상황입니다.') {
  const response = await handleRecommendScripture(post({ situation }), depsReturning(analysis));
  assert.equal(response.status, 200);
  const body = (await response.json()) as { ok: boolean; result: GateResult };
  assert.equal(body.ok, true);
  return body.result;
}

describe('recommend-scripture · Gate 흐름', () => {
  it('CASE 1 · 두려움 → recommend / SC-001', async () => {
    const result = await gateFor(
      analysisOf({
        primaryDomain: 'fear_uncertainty',
        situationTags: ['두려운 일을 앞둠', '불확실한 결과'],
        emotionTags: ['두려움'],
        spiritualQuestionTags: ['신뢰'],
        prayerModes: ['간구'],
        pastoralFunctions: ['위로'],
      }),
    );
    assert.equal(result.route, 'recommend');
    assert.equal(result.reason, 'CARD_SELECTED');
    assert.equal(result.selectedCardId, 'SC-001');
    assert.equal(result.isTie, false);
  });

  it('CASE 2 · 경제적 어려움 + 불안 → no_coverage (SC-001 우회 추천 금지)', async () => {
    const result = await gateFor(
      analysisOf({
        primaryDomain: 'financial_hardship',
        secondaryDomains: ['fear_uncertainty'],
        situationTags: ['미래 걱정'],
        emotionTags: ['불안', '걱정'],
        spiritualQuestionTags: ['신뢰'],
        prayerModes: ['간구'],
        pastoralFunctions: ['위로'],
      }),
    );
    assert.equal(result.route, 'no_coverage');
    assert.equal(result.reason, 'PRIMARY_DOMAIN_NOT_COVERED');
    assert.equal(result.selectedCardId, null);
    assert.deepEqual(result.eligibleCardIds, []);
    assert.deepEqual(result.rankedCandidates, []);
  });

  it('CASE 3 · safety caution → safety', async () => {
    const result = await gateFor(
      analysisOf({
        primaryDomain: 'waiting_unanswered_prayer',
        emotionTags: ['낙심'],
        safety: { level: 'caution', categories: ['suicide'] },
      }),
    );
    assert.equal(result.route, 'safety');
    assert.equal(result.reason, 'SAFETY_FIRST');
    assert.equal(result.selectedCardId, null);
    assert.deepEqual(result.safety, { level: 'caution', categories: ['suicide'] });
  });

  it('CASE 4 · safety urgent → safety', async () => {
    const result = await gateFor(
      analysisOf({
        primaryDomain: 'injustice_mistreatment',
        situationTags: ['괴롭힘'],
        safety: { level: 'urgent', categories: ['abuse', 'immediate_danger'] },
      }),
    );
    assert.equal(result.route, 'safety');
    assert.equal(result.selectedCardId, null);
    assert.deepEqual(result.rankedCandidates, []);
  });

  it('CASE 5 · gratitude_joy + fear_uncertainty → 후보는 두 domain 카드만', async () => {
    const result = await gateFor(
      analysisOf({
        primaryDomain: 'gratitude_joy',
        secondaryDomains: ['fear_uncertainty'],
        situationTags: ['좋은 일이 생김', '두려운 일을 앞둠'],
        emotionTags: ['기쁨', '감사', '두려움'],
        spiritualQuestionTags: ['감사', '신뢰'],
        prayerModes: ['감사', '간구'],
        pastoralFunctions: ['감사', '위로'],
      }),
    );
    assert.deepEqual(result.eligibleDomains, ['gratitude_joy', 'fear_uncertainty']);
    assert.deepEqual(result.eligibleCardIds.slice().sort(), ['SC-001', 'SC-004']);
    assert.ok(['SC-004', 'SC-001'].includes(result.selectedCardId ?? ''));
  });

  it('CASE 6 · decision_guidance + wisdom_discernment → SC-002 / SC-010만', async () => {
    const result = await gateFor(
      analysisOf({
        primaryDomain: 'decision_guidance',
        secondaryDomains: ['wisdom_discernment'],
        situationTags: ['중요한 결정', '판단이 어려움'],
        emotionTags: ['혼란'],
        spiritualQuestionTags: ['인도', '지혜'],
        prayerModes: ['간구'],
        pastoralFunctions: ['인도', '지혜'],
      }),
    );
    assert.deepEqual(result.eligibleCardIds.slice().sort(), ['SC-002', 'SC-010']);
    assert.equal(result.rankedCandidates.length, 2);
  });

  it('CASE 7 · 동점 → ambiguous / selectedCardId null / isTie true', async () => {
    const result = await gateFor(
      analysisOf({
        primaryDomain: 'decision_guidance',
        secondaryDomains: ['wisdom_discernment'],
        spiritualQuestionTags: ['인도', '분별'],
        prayerModes: ['간구'],
        pastoralFunctions: ['인도'],
      }),
    );
    assert.equal(result.route, 'ambiguous');
    assert.equal(result.reason, 'TOP_SCORE_TIE');
    assert.equal(result.selectedCardId, null);
    assert.equal(result.isTie, true);
    assert.equal(result.rankedCandidates[0].totalScore, result.rankedCandidates[1].totalScore);
  });
});

describe('recommend-scripture · 응답 구조', () => {
  it('result에 Gate 결과 필드가 모두 들어 있다', async () => {
    const result = await gateFor(
      analysisOf({
        primaryDomain: 'grief_loss',
        situationTags: ['사별'],
        emotionTags: ['슬픔'],
      }),
    );
    for (const field of [
      'route',
      'reason',
      'primaryDomain',
      'secondaryDomains',
      'safety',
      'coverage',
      'eligibleDomains',
      'eligibleCardIds',
      'rankedCandidates',
      'selectedCardId',
      'isTie',
    ]) {
      assert.ok(field in result, `${field}가 없습니다.`);
    }
  });

  it('OpenAI 원본 응답과 usage는 돌려주지 않는다', async () => {
    const response = await handleRecommendScripture(
      post({ situation: '어머니가 돌아가셨어요.' }),
      depsReturning(analysisOf({ primaryDomain: 'grief_loss', situationTags: ['사별'] })),
    );
    const body = (await response.json()) as Record<string, unknown>;
    assert.deepEqual(Object.keys(body).sort(), ['ok', 'result']);
    assert.equal('usage' in body, false);
    assert.equal('output' in body, false);
  });
});

describe('recommend-scripture · 입력과 오류 처리', () => {
  it('POST가 아니면 405', async () => {
    for (const method of ['GET', 'PUT', 'DELETE']) {
      const response = await handleRecommendScripture(
        new Request('http://localhost/recommend-scripture', { method }),
        depsReturning(baseAnalysis),
      );
      assert.equal(response.status, 405);
      assert.deepEqual(await response.json(), { ok: false, error: 'METHOD_NOT_ALLOWED' });
    }
  });

  it('JSON이 아니면 400 INVALID_JSON', async () => {
    const response = await handleRecommendScripture(
      post('이건 JSON이 아닙니다'),
      depsReturning(baseAnalysis),
    );
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { ok: false, error: 'INVALID_JSON' });
  });

  it('situation이 없거나 비었으면 400 INVALID_INPUT', async () => {
    for (const body of [{}, { situation: 123 }, { situation: '' }, { situation: '   ' }]) {
      const response = await handleRecommendScripture(post(body), depsReturning(baseAnalysis));
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { ok: false, error: 'INVALID_INPUT' });
    }
  });

  it(`${MAX_SITUATION_LENGTH}자를 넘으면 400 SITUATION_TOO_LONG`, async () => {
    const response = await handleRecommendScripture(
      post({ situation: '가'.repeat(MAX_SITUATION_LENGTH + 1) }),
      depsReturning(baseAnalysis),
    );
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { ok: false, error: 'SITUATION_TOO_LONG' });
  });

  it('API Key가 없으면 500이고 OpenAI를 부르지 않는다', async () => {
    let called = false;
    const response = await handleRecommendScripture(
      post({ situation: '어머니가 돌아가셨어요.' }),
      depsReturning(baseAnalysis, {
        getApiKey: () => undefined,
        callOpenAI: async () => {
          called = true;
          return openAIResponse(baseAnalysis);
        },
      }),
    );
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { ok: false, error: 'OPENAI_API_KEY_MISSING' });
    assert.equal(called, false);
  });

  it('OpenAI 호출이 실패하면 502 OPENAI_REQUEST_FAILED', async () => {
    const response = await handleRecommendScripture(
      post({ situation: '어머니가 돌아가셨어요.' }),
      depsReturning(baseAnalysis, {
        callOpenAI: async () => {
          throw new Error('rate limit exceeded for org-1234');
        },
      }),
    );
    assert.equal(response.status, 502);
    const text = await response.text();
    assert.ok(text.includes('OPENAI_REQUEST_FAILED'));
    assert.equal(text.includes('rate limit'), false);
  });

  it('규격을 어긴 AI 결과는 Gate로 넘어가지 않는다', async () => {
    const broken = [
      { ...baseAnalysis, primaryDomain: 'made_up_domain' },
      { ...baseAnalysis, emotionTags: ['없는감정'] },
      { ...baseAnalysis, confidence: 1.7 },
      { hello: 'world' },
    ];
    for (const value of broken) {
      const response = await handleRecommendScripture(
        post({ situation: '어머니가 돌아가셨어요.' }),
        depsReturning(value),
      );
      assert.equal(response.status, 502, `${JSON.stringify(value)}가 통과되었습니다.`);
      assert.deepEqual(await response.json(), { ok: false, error: 'INVALID_ANALYSIS_RESPONSE' });
    }
  });
});

describe('recommend-scripture · 개인정보', () => {
  it('로그에 사용자 문장을 남기지 않는다', async () => {
    const situation = '아무에게도 말하지 못한 매우 개인적인 이야기입니다.';
    const logs: string[] = [];

    await handleRecommendScripture(
      post({ situation }),
      depsReturning(baseAnalysis, { log: (message) => logs.push(message) }),
    );
    await handleRecommendScripture(
      post({ situation }),
      depsReturning({ hello: 'world' }, { log: (message) => logs.push(message) }),
    );
    await handleRecommendScripture(
      post({ situation }),
      depsReturning(baseAnalysis, {
        log: (message) => logs.push(message),
        getApiKey: () => undefined,
      }),
    );

    for (const message of logs) {
      assert.equal(message.includes(situation), false, `로그에 원문이 있습니다: ${message}`);
      assert.equal(message.includes('개인적인'), false);
    }
  });

  it('응답 어디에도 API Key가 들어가지 않는다', async () => {
    const response = await handleRecommendScripture(
      post({ situation: '어머니가 돌아가셨어요.' }),
      depsReturning(baseAnalysis, { getApiKey: () => 'super-secret-key-value' }),
    );
    const text = await response.text();
    assert.equal(text.includes('super-secret-key-value'), false);
  });
});

describe('recommend-scripture · CORS', () => {
  const options = () =>
    new Request('http://localhost/recommend-scripture', { method: 'OPTIONS' });

  it('사전 요청(OPTIONS)에 CORS 헤더로 답한다', async () => {
    let openAICalled = false;
    let keyRead = false;
    const response = await handleRecommendScripture(options(), {
      checkQuota: allowQuota,
      getApiKey: () => {
        keyRead = true;
        return 'test-key-not-real';
      },
      callOpenAI: async () => {
        openAICalled = true;
        return {};
      },
    });

    assert.ok([200, 204].includes(response.status), `status: ${response.status}`);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    assert.equal(openAICalled, false, 'OPTIONS에서 OpenAI를 불렀습니다.');
    assert.equal(keyRead, false, 'OPTIONS에서 API Key를 읽었습니다.');
  });

  it('허용 헤더와 메서드가 들어 있다', async () => {
    const response = await handleRecommendScripture(options(), depsReturning(baseAnalysis));
    const allowHeaders = (response.headers.get('access-control-allow-headers') ?? '').toLowerCase();
    for (const header of ['authorization', 'x-client-info', 'apikey', 'content-type']) {
      assert.ok(allowHeaders.includes(header), `${header}가 없습니다.`);
    }

    const allowMethods = (response.headers.get('access-control-allow-methods') ?? '').toUpperCase();
    assert.ok(allowMethods.includes('POST'));
    assert.ok(allowMethods.includes('OPTIONS'));

    // wildcard origin과 credentials를 함께 쓰지 않는다.
    assert.equal(response.headers.get('access-control-allow-credentials'), null);
  });

  it('성공 응답에도 CORS 헤더가 있다', async () => {
    const response = await handleRecommendScripture(post({ situation: '어머니가 돌아가셨어요.' }), depsReturning(baseAnalysis));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
  });

  it('400 오류 응답에도 CORS 헤더가 있다', async () => {
    const response = await handleRecommendScripture(post({}), depsReturning(baseAnalysis));
    assert.equal(response.status, 400);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
  });

  it('405 오류 응답에도 CORS 헤더가 있다', async () => {
    const response = await handleRecommendScripture(
      new Request('http://localhost/recommend-scripture', { method: 'GET' }),
      depsReturning(baseAnalysis),
    );
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
  });

  it('500 오류 응답에도 CORS 헤더가 있다', async () => {
    const response = await handleRecommendScripture(post({ situation: '어머니가 돌아가셨어요.' }), depsReturning(baseAnalysis, { getApiKey: () => undefined }));
    assert.equal(response.status, 500);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
  });

  it('502 오류 응답에도 CORS 헤더가 있다', async () => {
    const response = await handleRecommendScripture(post({ situation: '어머니가 돌아가셨어요.' }), depsReturning(baseAnalysis, {
        callOpenAI: async () => {
          throw new Error('openai_http_500');
        },
      }));
    assert.equal(response.status, 502);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
  });
});

describe('recommend-scripture · 사용량 제한', () => {
  const countingDeps = (
    quota: () => Promise<{ status: 'allowed' } | { status: 'limited'; retryAfterSeconds: number } | { status: 'unavailable' }>,
  ) => {
    const calls = { quota: 0, openai: 0 };
    const deps: Handlerdeps = {
      ...depsReturning(baseAnalysis),
      checkQuota: async () => {
        calls.quota += 1;
        return quota();
      },
      callOpenAI: async () => {
        calls.openai += 1;
        return openAIResponse(baseAnalysis);
      },
    };
    return { deps, calls };
  };

  it('허용되면 OpenAI를 한 번 부른다', async () => {
    const { deps, calls } = countingDeps(async () => ({ status: 'allowed' }));
    const response = await handleRecommendScripture(post({ situation: '어머니가 돌아가셨어요.' }), deps);

    assert.equal(response.status, 200);
    assert.equal(calls.quota, 1);
    assert.equal(calls.openai, 1);
  });

  it('1시간 제한을 넘으면 429이고 OpenAI를 부르지 않는다', async () => {
    const { deps, calls } = countingDeps(async () => ({ status: 'limited', retryAfterSeconds: 1800 }));
    const response = await handleRecommendScripture(post({ situation: '어머니가 돌아가셨어요.' }), deps);

    assert.equal(response.status, 429);
    assert.deepEqual(await response.json(), { ok: false, error: 'RATE_LIMITED' });
    assert.equal(response.headers.get('retry-after'), '1800');
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    assert.equal(calls.openai, 0, 'OpenAI를 불렀습니다.');
  });

  it('24시간 제한을 넘어도 429이고 OpenAI를 부르지 않는다', async () => {
    const { deps, calls } = countingDeps(async () => ({ status: 'limited', retryAfterSeconds: 43200 }));
    const response = await handleRecommendScripture(post({ situation: '어머니가 돌아가셨어요.' }), deps);

    assert.equal(response.status, 429);
    assert.equal(response.headers.get('retry-after'), '43200');
    assert.equal(calls.openai, 0);
  });

  it('사용량 확인이 실패하면 503이고 OpenAI를 부르지 않는다 (fail-closed)', async () => {
    for (const quota of [
      async () => ({ status: 'unavailable' }) as const,
      async () => {
        throw new Error('db down');
      },
    ]) {
      const { deps, calls } = countingDeps(quota as never);
      const response = await handleRecommendScripture(post({ situation: '어머니가 돌아가셨어요.' }), deps);

      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { ok: false, error: 'RATE_LIMIT_UNAVAILABLE' });
      assert.equal(response.headers.get('access-control-allow-origin'), '*');
      assert.equal(calls.openai, 0);
    }
  });

  it('잘못된 요청은 사용량을 쓰지 않는다', async () => {
    const badRequests = [
      post('이건 JSON이 아닙니다'),
      post({}),
      post({ situation: '   ' }),
      post({ situation: '가'.repeat(MAX_SITUATION_LENGTH + 1) }),
      new Request('http://localhost/x', { method: 'GET' }),
      new Request('http://localhost/x', { method: 'OPTIONS' }),
    ];

    for (const request of badRequests) {
      const { deps, calls } = countingDeps(async () => ({ status: 'allowed' }));
      await handleRecommendScripture(request, deps);
      assert.equal(calls.quota, 0, `사용량을 소비했습니다: ${request.method}`);
      assert.equal(calls.openai, 0);
    }
  });

  it('429 / 503 응답에 사용자 정보나 원본 오류가 없다', async () => {
    for (const quota of [
      async () => ({ status: 'limited', retryAfterSeconds: 60 }) as const,
      async () => ({ status: 'unavailable' }) as const,
    ]) {
      const { deps } = countingDeps(quota as never);
      const response = await handleRecommendScripture(post({ situation: '어머니가 돌아가셨어요.' }), deps);
      const body = (await response.json()) as Record<string, unknown>;

      assert.deepEqual(Object.keys(body).sort(), ['error', 'ok']);
      const text = JSON.stringify(body).toLowerCase();
      for (const banned of ['user', 'uuid', 'jwt', 'bearer', 'authorization', 'sql', 'postgres']) {
        assert.equal(text.includes(banned), false, `${banned}가 응답에 있습니다.`);
      }
    }
  });
});

describe('recommend-scripture · Coverage Gap 수집', () => {
  const collectingDeps = (options: { fail?: boolean } = {}) => {
    const recorded: string[] = [];
    const deps: Handlerdeps = {
      ...depsReturning(baseAnalysis),
      recordCoverageGap: async (primaryDomain: string) => {
        recorded.push(primaryDomain);
        if (options.fail) throw new Error('db down');
      },
    };
    return { deps, recorded };
  };

  const runWith = async (analysis: SituationAnalysis, options: { fail?: boolean } = {}) => {
    const { deps, recorded } = collectingDeps(options);
    const response = await handleRecommendScripture(post({ situation: '지금 나의 상황입니다.' }), {
      ...deps,
      callOpenAI: async () => openAIResponse(analysis),
    });
    return { response, recorded };
  };

  it('no_coverage면 영역 이름 하나만 기록한다', async () => {
    const { response, recorded } = await runWith(
      analysisOf({
        primaryDomain: 'financial_hardship',
        secondaryDomains: ['fear_uncertainty'],
        situationTags: ['미래 걱정'],
        emotionTags: ['걱정'],
      }),
    );

    const body = (await response.json()) as { result: GateResult };
    assert.equal(body.result.route, 'no_coverage');
    assert.deepEqual(recorded, ['financial_hardship']);
  });

  it('다른 uncovered 영역도 정상 기록한다', async () => {
    for (const domain of [
      'loneliness_isolation',
      'family_parenting_conflict',
      'burnout_exhaustion',
      'spiritual_dryness',
      'chronic_illness',
      'relationship_conflict_forgiveness',
      'other_uncovered',
    ] as const) {
      const { response, recorded } = await runWith(analysisOf({ primaryDomain: domain }));
      const body = (await response.json()) as { result: GateResult };

      assert.equal(body.result.route, 'no_coverage');
      assert.deepEqual(recorded, [domain]);
    }
  });

  it('recommend면 기록하지 않는다', async () => {
    const { response, recorded } = await runWith(
      analysisOf({
        primaryDomain: 'fear_uncertainty',
        situationTags: ['두려운 일을 앞둠'],
        emotionTags: ['두려움'],
      }),
    );

    const body = (await response.json()) as { result: GateResult };
    assert.equal(body.result.route, 'recommend');
    assert.deepEqual(recorded, []);
  });

  it('safety면 기록하지 않는다 (other_uncovered로도 새지 않는다)', async () => {
    for (const primaryDomain of ['other_uncovered', 'financial_hardship', 'grief_loss'] as const) {
      const { response, recorded } = await runWith(
        analysisOf({
          primaryDomain,
          safety: { level: 'urgent', categories: ['suicide'] },
        }),
      );

      const body = (await response.json()) as { result: GateResult };
      assert.equal(body.result.route, 'safety');
      assert.deepEqual(recorded, [], `${primaryDomain} safety가 기록되었습니다.`);
    }
  });

  it('ambiguous면 기록하지 않는다', async () => {
    const { response, recorded } = await runWith(
      analysisOf({
        primaryDomain: 'decision_guidance',
        secondaryDomains: ['wisdom_discernment'],
        spiritualQuestionTags: ['인도', '분별'],
        prayerModes: ['간구'],
        pastoralFunctions: ['인도'],
      }),
    );

    const body = (await response.json()) as { result: GateResult };
    assert.equal(body.result.route, 'ambiguous');
    assert.deepEqual(recorded, []);
  });

  it('기록에 실패해도 사용자 응답은 그대로 성공한다 (fail-open)', async () => {
    const { response, recorded } = await runWith(analysisOf({ primaryDomain: 'burnout_exhaustion' }), {
      fail: true,
    });

    assert.equal(response.status, 200);
    const body = (await response.json()) as { ok: boolean; result: GateResult };
    assert.equal(body.ok, true);
    assert.equal(body.result.route, 'no_coverage');
    assert.deepEqual(recorded, ['burnout_exhaustion']);
  });

  it('통계 기록기가 없어도 정상 동작한다', async () => {
    const response = await handleRecommendScripture(
      post({ situation: '지금 나의 상황입니다.' }),
      depsReturning(analysisOf({ primaryDomain: 'chronic_illness' })),
    );
    assert.equal(response.status, 200);
  });

  it('기록에 넘어가는 값은 영역 이름 문자열 하나뿐이다', async () => {
    const situation = '아무에게도 말하지 못한 개인적인 이야기입니다.';
    const passed: unknown[] = [];

    await handleRecommendScripture(post({ situation }), {
      ...depsReturning(analysisOf({ primaryDomain: 'financial_hardship', situationTags: ['미래 걱정'] })),
      recordCoverageGap: async (...args: unknown[]) => {
        passed.push(args);
      },
    });

    assert.deepEqual(passed, [['financial_hardship']]);
    const text = JSON.stringify(passed);
    assert.equal(text.includes(situation), false);
    assert.equal(text.includes('개인적인'), false);
    for (const banned of ['user', 'uuid', 'jwt', 'bearer', 'token']) {
      assert.equal(text.toLowerCase().includes(banned), false, `${banned}가 전달되었습니다.`);
    }
  });
});

describe('recommend-scripture · 통계 기록이 느려도 응답은 그대로', () => {
  it('통계 DB가 응답하지 않아도 no_coverage 200을 바로 돌려준다', async () => {
    // 2초 걸리는 통계 요청을 30ms 제한으로 감싼다.
    const slowFetch = ((_url: string, init: RequestInit) =>
      new Promise((resolve) => {
        const timer = setTimeout(() => resolve(new Response('true', { status: 200 })), 2000);
        init.signal?.addEventListener('abort', () => clearTimeout(timer));
      })) as unknown as typeof fetch;

    const analysis = analysisOf({ primaryDomain: 'financial_hardship', situationTags: ['미래 걱정'] });
    const startedAt = Date.now();

    const response = await handleRecommendScripture(post({ situation: '생활비가 부족합니다.' }), {
      ...depsReturning(analysis),
      recordCoverageGap: createSupabaseCoverageGapRecorder({
        url: 'https://x.supabase.co',
        serviceRoleKey: 'server-only-key',
        fetchImpl: slowFetch,
        timeoutMs: 30,
      }),
    });

    const elapsed = Date.now() - startedAt;
    assert.equal(response.status, 200);

    const body = (await response.json()) as { ok: boolean; result: GateResult };
    assert.equal(body.ok, true);
    assert.equal(body.result.route, 'no_coverage');
    assert.ok(elapsed < 1000, `응답이 통계 때문에 지연되었습니다: ${elapsed}ms`);
  });
});
