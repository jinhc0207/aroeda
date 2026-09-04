/**
 * Biblical Researcher · 실제로 요청을 보내는 부분 · 테스트
 *
 * 실행: npm test
 *
 * 지키려는 것:
 *   정해진 곳에 한 번만 보낸다.
 *   요청 본문을 고치지 않는다.
 *   기다리는 시간은 부르는 쪽이 준 값을 그대로 쓴다.
 *   우리가 끊었을 때만 시간 초과다.
 *   열쇠와 응답 본문이 밖으로 새지 않는다.
 *
 * 실제 인터넷 요청은 하지 않는다. 보내는 일을 가짜로 넣는다.
 * 실제로 90초를 기다리지 않는다.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  OPENAI_RESPONSES_URL,
  createBiblicalResearchResponsesTransport,
} from '../../supabase/functions/_shared/biblical-researcher-openai-transport.ts';
import { BIBLICAL_RESEARCH_MODEL_TIMEOUT_MS } from '../../supabase/functions/_shared/biblical-researcher-runtime-policy.ts';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '');

const TRANSPORT = '../../supabase/functions/_shared/biblical-researcher-openai-transport.ts';

/** 시험용 가짜 열쇠. 실제 열쇠가 아니다. */
const FAKE_KEY = 'test-key-not-a-real-secret-0000';

const REQUEST = {
  model: 'gpt-5.6-sol',
  instructions: '지시문',
  input: '{"targetDomain":"financial_hardship"}',
  reasoning: { effort: 'medium' },
  max_output_tokens: 16_000,
  tools: [],
  store: false,
  truncation: 'disabled',
  text: { format: { type: 'json_schema', name: 'biblical_research_draft', strict: true, schema: {} } },
};

type FetchCall = { url: unknown; init: RequestInit };

/** 정해진 답을 돌려주는 가짜 fetch. 몇 번 어떻게 불렸는지 기록한다. */
const fakeFetch = (respond: (call: FetchCall) => Promise<Response> | Response) => {
  const calls: FetchCall[] = [];
  const impl = (async (url: unknown, init: RequestInit) => {
    calls.push({ url, init });
    return await respond({ url, init });
  }) as unknown as typeof fetch;
  return { impl, calls };
};

const okResponse = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

const send = async (
  respond: (call: FetchCall) => Promise<Response> | Response,
  timeoutMs = BIBLICAL_RESEARCH_MODEL_TIMEOUT_MS,
) => {
  const { impl, calls } = fakeFetch(respond);
  const transport = createBiblicalResearchResponsesTransport({ apiKey: FAKE_KEY, fetchImpl: impl });
  const result = await transport(REQUEST, { timeoutMs });
  return { result, calls };
};

/* ================================================================== */

describe('보내는 일 · A. 어디로 어떻게 보내는가', () => {
  it('정해진 곳에 POST로 보낸다', async () => {
    const { calls } = await send(() => okResponse({ status: 'completed' }));
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, OPENAI_RESPONSES_URL);
    assert.equal(OPENAI_RESPONSES_URL, 'https://api.openai.com/v1/responses');
    assert.equal(calls[0]?.init.method, 'POST');
  });

  it('열쇠와 형식을 머리글에 담는다', async () => {
    const { calls } = await send(() => okResponse({ status: 'completed' }));
    const headers = calls[0]?.init.headers as Record<string, string>;
    assert.equal(headers.authorization, `Bearer ${FAKE_KEY}`);
    assert.equal(headers['content-type'], 'application/json');
  });

  it('요청 본문을 한 글자도 고치지 않는다', async () => {
    const { calls } = await send(() => okResponse({ status: 'completed' }));
    assert.deepEqual(JSON.parse(calls[0]?.init.body as string), REQUEST);
  });

  it('요청 본문을 만들지 않는다', () => {
    const code = stripComments(read(TRANSPORT));
    for (const banned of [
      'model:',
      'reasoning',
      'max_output_tokens',
      'truncation',
      'json_schema',
      'BIBLICAL_RESEARCH_MODEL',
      'buildBiblicalResearchResponsesRequest',
      'executeBiblicalResearchRuntime',
    ]) {
      assert.equal(code.includes(banned), false, banned);
    }
  });

  it('취소할 수 있는 표시를 함께 보낸다', async () => {
    const { calls } = await send(() => okResponse({ status: 'completed' }));
    assert.ok(calls[0]?.init.signal);
    assert.equal((calls[0]?.init.signal as AbortSignal).aborted, false);
  });

  it('정확히 한 번만 보낸다', async () => {
    const { calls } = await send(() => new Response('', { status: 500 }));
    assert.equal(calls.length, 1);
  });
});

describe('보내는 일 · B. 답이 왔을 때', () => {
  it('정상 답은 그대로 넘긴다', async () => {
    const payload = { status: 'completed', output: [{ type: 'message', content: [] }] };
    const { result } = await send(() => okResponse(payload));
    assert.deepEqual(result, { ok: true, response: payload });
  });

  it('2xx가 아니면 요청 실패로 본다', async () => {
    for (const status of [400, 401, 403, 404, 429, 500, 503]) {
      const { result } = await send(() => new Response('{"error":"비밀 문구"}', { status }));
      assert.deepEqual(result, { ok: false, failure: 'model_transport_error' }, String(status));
    }
  });

  it('오류일 때 본문을 아예 열지 않는다', () => {
    const code = stripComments(read(TRANSPORT));
    assert.equal(code.includes('response.text()'), false);
    assert.equal(code.includes('response.status'), false);
    assert.equal(code.includes('console.'), false);
    // 답을 읽는 곳은 한 곳뿐이고, 그것도 2xx일 때뿐이다.
    assert.equal((code.match(/response\.json\(\)/g) || []).length, 1);
  });

  it('답을 읽을 수 없으면 요청 실패로 본다', async () => {
    const { result } = await send(() => new Response('JSON이 아닙니다', { status: 200 }));
    assert.deepEqual(result, { ok: false, failure: 'model_transport_error' });
  });

  it('보내다 그냥 터져도 오류가 밖으로 새지 않는다', async () => {
    const { result } = await send(() => {
      throw new Error('비밀이 담긴 오류 문구');
    });
    assert.deepEqual(result, { ok: false, failure: 'model_transport_error' });
  });
});

describe('보내는 일 · C. 시간', () => {
  it('부르는 쪽이 준 시간을 그대로 쓴다', () => {
    const code = stripComments(read(TRANSPORT));
    assert.ok(code.includes('options.timeoutMs'));
    // 여기서 시간을 다시 정하지 않는다.
    assert.equal(code.includes('90_000'), false);
    assert.equal(code.includes('90000'), false);
    assert.equal(code.includes('TIMEOUT_MS ='), false);
  });

  it('우리가 끊으면 시간 초과다', async () => {
    // 아주 짧은 시간을 주고, 답이 오지 않는 상황을 만든다.
    const { result } = await send(
      (call) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = call.init.signal as AbortSignal;
          signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
      5,
    );
    assert.deepEqual(result, { ok: false, failure: 'model_timeout' });
  });

  it('답을 읽는 도중에 끊겨도 시간 초과다', async () => {
    const { result } = await send(
      (call) => ({
        ok: true,
        json: () =>
          new Promise((_resolve, reject) => {
            const signal = call.init.signal as AbortSignal;
            signal.addEventListener('abort', () => reject(new Error('aborted')));
          }),
      }) as unknown as Response,
      5,
    );
    assert.deepEqual(result, { ok: false, failure: 'model_timeout' });
  });

  it('우리가 끊은 것이 아니면 시간 초과가 아니다', async () => {
    // 다른 이유로 난 AbortError를 시간 초과로 잘못 적지 않는다.
    const { result } = await send(() => {
      const error = new Error('The operation was aborted.');
      error.name = 'AbortError';
      throw error;
    });
    assert.deepEqual(result, { ok: false, failure: 'model_transport_error' });
  });

  it('오류의 이름으로 짐작하지 않는다', () => {
    const code = stripComments(read(TRANSPORT));
    for (const banned of ['AbortError', 'error.name', '.name ===', 'TimeoutError']) {
      assert.equal(code.includes(banned), false, banned);
    }
    // 우리가 끊었는지를 우리가 들고 있는 값으로 기억한다.
    assert.ok(code.includes('timedOut = true'));
    assert.equal(code.includes('signal.aborted'), false);
  });

  it('성공해도 실패해도 타이머를 치운다', async () => {
    const code = stripComments(read(TRANSPORT));
    assert.ok(code.includes('} finally {'));
    assert.equal((code.match(/clearTimeout\(timer\)/g) || []).length, 1);

    // 타이머가 남아 있으면 이 시험 자체가 끝나지 않는다.
    await send(() => okResponse({ status: 'completed' }));
    await send(() => new Response('', { status: 500 }));
    await send(() => {
      throw new Error('실패');
    });
  });
});

describe('보내는 일 · D. 다시 부르지 않는다', () => {
  it('다시 부르는 코드가 없다', () => {
    const code = stripComments(read(TRANSPORT));
    for (const banned of ['for (', 'while (', 'retry', 'attempt', 'fallback', 'Promise.all']) {
      assert.equal(code.includes(banned), false, banned);
    }
    assert.equal((code.match(/doFetch\(/g) || []).length, 1);
  });

  it('2xx가 아니어도 다시 보내지 않는다', async () => {
    const { calls } = await send(() => new Response('', { status: 429 }));
    assert.equal(calls.length, 1);
  });

  it('시간이 지나도 다시 보내지 않는다', async () => {
    const { calls } = await send(
      (call) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = call.init.signal as AbortSignal;
          signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
      5,
    );
    assert.equal(calls.length, 1);
  });
});

describe('보내는 일 · E. 열쇠가 새지 않는다', () => {
  it('결과 어디에도 열쇠가 없다', async () => {
    const cases = [
      await send(() => okResponse({ status: 'completed' })),
      await send(() => new Response('', { status: 401 })),
      await send(() => {
        throw new Error('실패');
      }),
    ];
    for (const { result } of cases) {
      assert.equal(JSON.stringify(result).includes(FAKE_KEY), false);
    }
  });

  it('요청 본문에 열쇠가 없다', async () => {
    const { calls } = await send(() => okResponse({ status: 'completed' }));
    assert.equal((calls[0]?.init.body as string).includes(FAKE_KEY), false);
  });

  it('열쇠가 없으면 아예 보내지 않는다', async () => {
    for (const apiKey of ['', '   ']) {
      const { impl, calls } = fakeFetch(() => okResponse({ status: 'completed' }));
      const transport = createBiblicalResearchResponsesTransport({ apiKey, fetchImpl: impl });
      const result = await transport(REQUEST, { timeoutMs: BIBLICAL_RESEARCH_MODEL_TIMEOUT_MS });
      assert.deepEqual(result, { ok: false, failure: 'model_transport_error' });
      assert.equal(calls.length, 0);
    }
  });

  it('환경변수를 읽지 않는다', () => {
    const code = stripComments(read(TRANSPORT));
    for (const banned of [
      'Deno.env',
      'process.env',
      'OPENAI_API_KEY',
      'Deno.serve',
      'createClient',
      'SUPABASE',
      'console.',
    ]) {
      assert.equal(code.includes(banned), false, banned);
    }
  });

  it('실패 결과에는 이름 하나만 남는다', async () => {
    const { result } = await send(() => new Response('{"error":{"message":"비밀"}}', { status: 500 }));
    assert.equal(result.ok, false);
    assert.deepEqual(Object.keys(result).sort(), ['failure', 'ok']);
  });

  it('돌려주는 모양은 실행 순서가 정한 것 그대로다', () => {
    const code = stripComments(read(TRANSPORT));
    assert.ok(code.includes("from './biblical-researcher-runtime-contract.ts'"));
    // 새 결과 모양을 만들지 않는다.
    assert.equal(code.includes('export type BiblicalResearchTransportResult'), false);
    assert.equal(code.includes('model_incomplete'), false);
    assert.equal(code.includes('model_non_success'), false);
  });
});

describe('보내는 일 · F. 입구는 이것을 가져다 쓴다', () => {
  it('입구가 모델 부르는 일을 새로 만들지 않았다', () => {
    const index = read('../../supabase/functions/biblical-researcher/index.ts');
    assert.ok(index.includes('createBiblicalResearchResponsesTransport('));

    // 모델 쪽 주소·시간 제한은 이 파일이 소유한다. 입구가 다시 적지 않는다.
    // (입구에도 authorization 머리글이 있지만 그것은 DB 표를 부를 때 쓰는 것이다.)
    for (const banned of ['/v1/responses', 'api.openai.com', 'Bearer ${apiKey}', '90_000']) {
      assert.equal(index.includes(banned), false, banned);
    }
    // 열쇠는 만들 때 한 번 넘기는 것이 전부다.
    assert.equal((index.match(/OPENAI_API_KEY/g) || []).length, 1);
  });
});
