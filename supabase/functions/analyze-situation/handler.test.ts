/**
 * analyze-situation 순수 테스트
 *
 * 실행: npm test
 *
 * 실제 OpenAI를 부르지 않는다. 가짜 응답을 넣어 처리 흐름만 확인한다.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MAX_SITUATION_LENGTH,
  buildOpenAIPayload,
  extractOutputText,
  handleAnalyzeSituation,
  type Handlerdeps,
} from './handler.ts';
import { INSTRUCTIONS, MODEL } from '../_shared/analyzer-contract.ts';
import type { SituationAnalysis } from '../_shared/situation-analysis.ts';

const validAnalysis: SituationAnalysis = {
  primaryDomain: 'grief_loss',
  secondaryDomains: [],
  situationTags: ['사별'],
  emotionTags: ['슬픔'],
  spiritualQuestionTags: ['슬픔'],
  prayerModes: ['탄식'],
  pastoralFunctions: ['위로'],
  safety: { level: 'normal', categories: [] },
  confidence: 0.8,
};

const openAIResponse = (analysis: unknown) => ({
  output: [
    { type: 'reasoning', summary: [] },
    { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(analysis) }] },
  ],
  usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
});

const allowQuota = async () => ({ status: 'allowed' }) as const;

const depsWith = (overrides: Partial<Handlerdeps> = {}): Handlerdeps => ({
  checkQuota: allowQuota,
  getApiKey: () => 'test-key-not-real',
  callOpenAI: async () => openAIResponse(validAnalysis),
  ...overrides,
});

const post = (body: unknown) =>
  new Request('http://localhost/analyze-situation', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

describe('analyze-situation · 입력 검증', () => {
  it('POST가 아니면 405', async () => {
    for (const method of ['GET', 'PUT', 'DELETE']) {
      const response = await handleAnalyzeSituation(
        new Request('http://localhost/analyze-situation', { method }),
        depsWith(),
      );
      assert.equal(response.status, 405);
      assert.deepEqual(await response.json(), { ok: false, error: 'METHOD_NOT_ALLOWED' });
    }
  });

  it('JSON이 아니면 400', async () => {
    const response = await handleAnalyzeSituation(post('이건 JSON이 아닙니다'), depsWith());
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { ok: false, error: 'INVALID_JSON' });
  });

  it('situation이 없으면 400', async () => {
    const response = await handleAnalyzeSituation(post({}), depsWith());
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { ok: false, error: 'INVALID_INPUT' });
  });

  it('situation이 문자열이 아니면 400', async () => {
    const response = await handleAnalyzeSituation(post({ situation: 123 }), depsWith());
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { ok: false, error: 'INVALID_INPUT' });
  });

  it('빈 문자열과 공백만 있으면 400', async () => {
    for (const situation of ['', '   ', '\n\t ']) {
      const response = await handleAnalyzeSituation(post({ situation }), depsWith());
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { ok: false, error: 'INVALID_INPUT' });
    }
  });

  it(`${MAX_SITUATION_LENGTH}자를 넘으면 400`, async () => {
    const response = await handleAnalyzeSituation(
      post({ situation: '가'.repeat(MAX_SITUATION_LENGTH + 1) }),
      depsWith(),
    );
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { ok: false, error: 'SITUATION_TOO_LONG' });
  });

  it(`${MAX_SITUATION_LENGTH}자까지는 통과한다`, async () => {
    const response = await handleAnalyzeSituation(
      post({ situation: '가'.repeat(MAX_SITUATION_LENGTH) }),
      depsWith(),
    );
    assert.equal(response.status, 200);
  });
});

describe('analyze-situation · API Key', () => {
  it('키가 없으면 500 OPENAI_API_KEY_MISSING', async () => {
    for (const key of [undefined, '', '   ']) {
      const response = await handleAnalyzeSituation(
        post({ situation: '어머니가 돌아가셨어요.' }),
        depsWith({ getApiKey: () => key }),
      );
      assert.equal(response.status, 500);
      assert.deepEqual(await response.json(), { ok: false, error: 'OPENAI_API_KEY_MISSING' });
    }
  });

  it('키가 없으면 OpenAI를 부르지 않는다', async () => {
    let called = false;
    await handleAnalyzeSituation(
      post({ situation: '어머니가 돌아가셨어요.' }),
      depsWith({
        getApiKey: () => undefined,
        callOpenAI: async () => {
          called = true;
          return openAIResponse(validAnalysis);
        },
      }),
    );
    assert.equal(called, false);
  });

  it('응답 어디에도 키가 들어가지 않는다', async () => {
    const response = await handleAnalyzeSituation(
      post({ situation: '어머니가 돌아가셨어요.' }),
      depsWith({ getApiKey: () => 'super-secret-key-value' }),
    );
    const text = await response.text();
    assert.equal(text.includes('super-secret-key-value'), false);
  });
});

describe('analyze-situation · OpenAI 호출', () => {
  it('검증된 설정을 그대로 보낸다', () => {
    const payload = buildOpenAIPayload('어머니가 돌아가셨어요.');
    assert.equal(payload.model, MODEL);
    assert.equal(payload.store, false);
    assert.equal(payload.instructions, INSTRUCTIONS);
    assert.equal(payload.input, '어머니가 돌아가셨어요.');
    assert.equal('max_output_tokens' in payload, false, 'max_output_tokens를 넣지 않습니다.');

    const format = (payload.text as { format: Record<string, unknown> }).format;
    assert.equal(format.type, 'json_schema');
    assert.equal(format.strict, true);
    assert.equal(format.name, 'situation_analysis');
  });

  it('OpenAI 호출이 실패하면 502', async () => {
    const response = await handleAnalyzeSituation(
      post({ situation: '어머니가 돌아가셨어요.' }),
      depsWith({
        callOpenAI: async () => {
          throw new Error('openai_http_500');
        },
      }),
    );
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { ok: false, error: 'OPENAI_REQUEST_FAILED' });
  });

  it('OpenAI 상세 오류 메시지를 사용자에게 보여주지 않는다', async () => {
    const response = await handleAnalyzeSituation(
      post({ situation: '어머니가 돌아가셨어요.' }),
      depsWith({
        callOpenAI: async () => {
          throw new Error('rate limit exceeded for org-1234');
        },
      }),
    );
    const text = await response.text();
    assert.equal(text.includes('rate limit'), false);
    assert.equal(text.includes('org-1234'), false);
  });

  it('응답에서 모델이 쓴 텍스트만 꺼낸다', () => {
    assert.equal(extractOutputText(openAIResponse({ a: 1 })), JSON.stringify({ a: 1 }));
    assert.equal(extractOutputText({ output: [] }), null);
    assert.equal(extractOutputText({}), null);
    assert.equal(extractOutputText(null), null);
  });
});

describe('analyze-situation · 결과 검증', () => {
  it('정상 입력이면 200과 analysis를 돌려준다', async () => {
    const response = await handleAnalyzeSituation(
      post({ situation: '어머니가 돌아가신 뒤 너무 보고 싶습니다.' }),
      depsWith(),
    );
    assert.equal(response.status, 200);

    const body = (await response.json()) as { ok: boolean; analysis: SituationAnalysis };
    assert.equal(body.ok, true);
    assert.deepEqual(body.analysis, validAnalysis);
  });

  it('OpenAI 원본 응답과 usage는 돌려주지 않는다', async () => {
    const response = await handleAnalyzeSituation(
      post({ situation: '어머니가 돌아가셨어요.' }),
      depsWith(),
    );
    const body = (await response.json()) as Record<string, unknown>;
    assert.deepEqual(Object.keys(body).sort(), ['analysis', 'ok']);
    assert.equal('usage' in body, false);
    assert.equal('output' in body, false);
  });

  it('규격을 어긴 AI 결과는 성공 응답으로 나가지 않는다', async () => {
    const brokenResults = [
      { ...validAnalysis, primaryDomain: 'made_up_domain' },
      { ...validAnalysis, emotionTags: ['없는감정'] },
      { ...validAnalysis, confidence: 1.7 },
      { ...validAnalysis, safety: { level: 'normal', categories: ['suicide'] } },
      { ...validAnalysis, secondaryDomains: undefined },
      { hello: 'world' },
    ];

    for (const broken of brokenResults) {
      const response = await handleAnalyzeSituation(
        post({ situation: '어머니가 돌아가셨어요.' }),
        depsWith({ callOpenAI: async () => openAIResponse(broken) }),
      );
      assert.equal(response.status, 502, `${JSON.stringify(broken)}가 통과되었습니다.`);
      assert.deepEqual(await response.json(), { ok: false, error: 'INVALID_ANALYSIS_RESPONSE' });
    }
  });

  it('JSON이 아닌 응답도 502로 막는다', async () => {
    const response = await handleAnalyzeSituation(
      post({ situation: '어머니가 돌아가셨어요.' }),
      depsWith({
        callOpenAI: async () => ({
          output: [{ type: 'message', content: [{ type: 'output_text', text: '분석 결과입니다' }] }],
        }),
      }),
    );
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { ok: false, error: 'INVALID_ANALYSIS_RESPONSE' });
  });

  it('safety 정보를 그대로 전달한다', async () => {
    const safetyAnalysis: SituationAnalysis = {
      ...validAnalysis,
      primaryDomain: 'injustice_mistreatment',
      safety: { level: 'urgent', categories: ['abuse', 'immediate_danger'] },
    };
    const response = await handleAnalyzeSituation(
      post({ situation: '지금 위험한 상황입니다.' }),
      depsWith({ callOpenAI: async () => openAIResponse(safetyAnalysis) }),
    );
    const body = (await response.json()) as { analysis: SituationAnalysis };
    assert.deepEqual(body.analysis.safety, { level: 'urgent', categories: ['abuse', 'immediate_danger'] });
  });
});

describe('analyze-situation · 개인정보', () => {
  it('로그에 사용자 문장을 남기지 않는다', async () => {
    const situation = '아무에게도 말하지 못한 매우 개인적인 이야기입니다.';
    const logs: string[] = [];

    await handleAnalyzeSituation(
      post({ situation }),
      depsWith({ log: (message) => logs.push(message) }),
    );
    await handleAnalyzeSituation(
      post({ situation }),
      depsWith({
        log: (message) => logs.push(message),
        callOpenAI: async () => openAIResponse({ hello: 'world' }),
      }),
    );
    await handleAnalyzeSituation(
      post({ situation }),
      depsWith({
        log: (message) => logs.push(message),
        getApiKey: () => undefined,
      }),
    );

    for (const message of logs) {
      assert.equal(message.includes(situation), false, `로그에 원문이 있습니다: ${message}`);
      assert.equal(message.includes('개인적인'), false);
    }
  });
});

describe('analyze-situation · CORS', () => {
  const options = () =>
    new Request('http://localhost/analyze-situation', { method: 'OPTIONS' });

  it('사전 요청(OPTIONS)에 CORS 헤더로 답한다', async () => {
    let openAICalled = false;
    let keyRead = false;
    const response = await handleAnalyzeSituation(options(), {
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
    const response = await handleAnalyzeSituation(options(), depsWith());
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
    const response = await handleAnalyzeSituation(post({ situation: '어머니가 돌아가셨어요.' }), depsWith());
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
  });

  it('400 오류 응답에도 CORS 헤더가 있다', async () => {
    const response = await handleAnalyzeSituation(post({}), depsWith());
    assert.equal(response.status, 400);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
  });

  it('405 오류 응답에도 CORS 헤더가 있다', async () => {
    const response = await handleAnalyzeSituation(
      new Request('http://localhost/analyze-situation', { method: 'GET' }),
      depsWith(),
    );
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
  });

  it('500 오류 응답에도 CORS 헤더가 있다', async () => {
    const response = await handleAnalyzeSituation(post({ situation: '어머니가 돌아가셨어요.' }), depsWith({ getApiKey: () => undefined }));
    assert.equal(response.status, 500);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
  });

  it('502 오류 응답에도 CORS 헤더가 있다', async () => {
    const response = await handleAnalyzeSituation(post({ situation: '어머니가 돌아가셨어요.' }), depsWith({
        callOpenAI: async () => {
          throw new Error('openai_http_500');
        },
      }));
    assert.equal(response.status, 502);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
  });
});

describe('analyze-situation · 사용량 제한', () => {
  const countingDeps = (
    quota: () => Promise<{ status: 'allowed' } | { status: 'limited'; retryAfterSeconds: number } | { status: 'unavailable' }>,
  ) => {
    const calls = { quota: 0, openai: 0 };
    const deps: Handlerdeps = {
      ...depsWith(),
      checkQuota: async () => {
        calls.quota += 1;
        return quota();
      },
      callOpenAI: async () => {
        calls.openai += 1;
        return openAIResponse(validAnalysis);
      },
    };
    return { deps, calls };
  };

  it('허용되면 OpenAI를 한 번 부른다', async () => {
    const { deps, calls } = countingDeps(async () => ({ status: 'allowed' }));
    const response = await handleAnalyzeSituation(post({ situation: '어머니가 돌아가셨어요.' }), deps);

    assert.equal(response.status, 200);
    assert.equal(calls.quota, 1);
    assert.equal(calls.openai, 1);
  });

  it('1시간 제한을 넘으면 429이고 OpenAI를 부르지 않는다', async () => {
    const { deps, calls } = countingDeps(async () => ({ status: 'limited', retryAfterSeconds: 1800 }));
    const response = await handleAnalyzeSituation(post({ situation: '어머니가 돌아가셨어요.' }), deps);

    assert.equal(response.status, 429);
    assert.deepEqual(await response.json(), { ok: false, error: 'RATE_LIMITED' });
    assert.equal(response.headers.get('retry-after'), '1800');
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    assert.equal(calls.openai, 0, 'OpenAI를 불렀습니다.');
  });

  it('24시간 제한을 넘어도 429이고 OpenAI를 부르지 않는다', async () => {
    const { deps, calls } = countingDeps(async () => ({ status: 'limited', retryAfterSeconds: 43200 }));
    const response = await handleAnalyzeSituation(post({ situation: '어머니가 돌아가셨어요.' }), deps);

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
      const response = await handleAnalyzeSituation(post({ situation: '어머니가 돌아가셨어요.' }), deps);

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
      await handleAnalyzeSituation(request, deps);
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
      const response = await handleAnalyzeSituation(post({ situation: '어머니가 돌아가셨어요.' }), deps);
      const body = (await response.json()) as Record<string, unknown>;

      assert.deepEqual(Object.keys(body).sort(), ['error', 'ok']);
      const text = JSON.stringify(body).toLowerCase();
      for (const banned of ['user', 'uuid', 'jwt', 'bearer', 'authorization', 'sql', 'postgres']) {
        assert.equal(text.includes(banned), false, `${banned}가 응답에 있습니다.`);
      }
    }
  });
});
