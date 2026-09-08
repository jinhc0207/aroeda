/**
 * research-queue-refresh · 요청 처리 본체 테스트
 *
 * 실행: npm test
 *
 * 지키려는 것:
 *   권한 확인이 가장 먼저다. 통과 못 하면 본문도 RPC도 건드리지 않는다.
 *   받는 것은 없다. 본문이 비어 있지 않으면(빈 object 포함 예외) 거절한다.
 *   RPC는 정확히 한 번만 부른다. 실패해도 다시 부르지 않는다.
 *   RPC 원본을 그대로 내보내지 않는다. items_touched 하나만 믿는다.
 *   실패 응답 어디에도 토큰·서비스 역할 키·RPC 원본·DB 상세 오류가 없다.
 *   CORS 헤더가 없다.
 *
 * 실제 DB 호출은 하지 않는다. RPC 호출을 전부 가짜로 넣는다.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  handleQueueRefresh,
  parseRefreshRequest,
  parseRefreshRpcResult,
  REFRESH_CONTENT_RESEARCH_QUEUE_RPC,
  type HandlerDeps,
} from './handler.ts';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '');

const INDEX = './index.ts';
const HANDLER = './handler.ts';

const TOKEN_HEADER = 'x-internal-token';
const TEST_TOKEN = 'test-internal-token-not-real';

const req = (init: {
  method?: string;
  token?: string | null;
  body?: string | null;
}): Request => {
  const headers = new Headers();
  if (init.token !== undefined && init.token !== null) headers.set(TOKEN_HEADER, init.token);
  return new Request('https://example.invalid/research-queue-refresh', {
    method: init.method ?? 'POST',
    headers,
    body: init.body ?? undefined,
  });
};

function makeDeps(overrides: Partial<HandlerDeps> & { authorized?: boolean } = {}) {
  const logs: string[] = [];
  let refreshCalls = 0;
  const deps: HandlerDeps = {
    isAuthorized: overrides.isAuthorized ?? (() => overrides.authorized ?? true),
    refreshQueue:
      overrides.refreshQueue ??
      (async () => {
        refreshCalls += 1;
        return { refreshed_at: '2026-09-09T00:00:00Z', items_touched: 0 };
      }),
    log: (message) => logs.push(message),
    requestId: () => 'test-id',
  };
  return {
    deps,
    logs,
    refreshCallCount: () => refreshCalls,
  };
}

const authedNoBody = () => req({ token: TEST_TOKEN });

describe('research-queue-refresh · A. method', () => {
  it('GET은 405이고 adapter를 부르지 않는다', async () => {
    let calls = 0;
    const { deps } = makeDeps({ refreshQueue: async () => { calls += 1; return { items_touched: 0 }; } });
    const res = await handleQueueRefresh(req({ method: 'GET', token: TEST_TOKEN }), deps);
    assert.equal(res.status, 405);
    assert.deepEqual(await res.json(), { ok: false, error: 'METHOD_NOT_ALLOWED' });
    assert.equal(calls, 0);
  });

  it('OPTIONS도 405이고 CORS 헤더가 없다', async () => {
    let calls = 0;
    const { deps } = makeDeps({ refreshQueue: async () => { calls += 1; return { items_touched: 0 }; } });
    const res = await handleQueueRefresh(req({ method: 'OPTIONS', token: TEST_TOKEN }), deps);
    assert.equal(res.status, 405);
    assert.equal(res.headers.get('access-control-allow-origin'), null);
    assert.equal(calls, 0);
  });
});

describe('research-queue-refresh · B. 권한', () => {
  it('토큰이 없으면 401이고 본문도 adapter도 건드리지 않는다', async () => {
    let bodyRead = false;
    let calls = 0;
    const { deps } = makeDeps({
      isAuthorized: () => false,
      refreshQueue: async () => { calls += 1; return { items_touched: 0 }; },
    });
    const request = req({ token: null, body: '{"unexpected":true}' });
    const originalText = request.text.bind(request);
    request.text = async () => {
      bodyRead = true;
      return originalText();
    };
    const res = await handleQueueRefresh(request, deps);
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { ok: false, error: 'UNAUTHORIZED' });
    assert.equal(bodyRead, false);
    assert.equal(calls, 0);
  });

  it('토큰이 틀려도 401이고 adapter를 부르지 않는다', async () => {
    let calls = 0;
    const { deps } = makeDeps({
      isAuthorized: () => false,
      refreshQueue: async () => { calls += 1; return { items_touched: 0 }; },
    });
    const res = await handleQueueRefresh(req({ token: 'wrong-token' }), deps);
    assert.equal(res.status, 401);
    assert.equal(calls, 0);
  });
});

describe('research-queue-refresh · C~F. 요청 본문', () => {
  it('본문이 없으면 성공하고 adapter가 정확히 한 번 불린다', async () => {
    const { deps, refreshCallCount } = makeDeps();
    const res = await handleQueueRefresh(authedNoBody(), deps);
    assert.equal(res.status, 200);
    assert.equal(refreshCallCount(), 1);
  });

  it('빈 object {}도 성공한다', async () => {
    const { deps, refreshCallCount } = makeDeps();
    const res = await handleQueueRefresh(req({ token: TEST_TOKEN, body: '{}' }), deps);
    assert.equal(res.status, 200);
    assert.equal(refreshCallCount(), 1);
  });

  it('malformed JSON은 400 INVALID_JSON이고 adapter를 부르지 않는다', async () => {
    let calls = 0;
    const { deps } = makeDeps({ refreshQueue: async () => { calls += 1; return { items_touched: 0 }; } });
    const res = await handleQueueRefresh(req({ token: TEST_TOKEN, body: '{"bad' }), deps);
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { ok: false, error: 'INVALID_JSON' });
    assert.equal(calls, 0);
  });

  it('key가 있는 object는 400 INVALID_REQUEST', async () => {
    let calls = 0;
    const { deps } = makeDeps({ refreshQueue: async () => { calls += 1; return { items_touched: 0 }; } });
    const res = await handleQueueRefresh(
      req({ token: TEST_TOKEN, body: '{"domain":"loneliness_isolation"}' }),
      deps,
    );
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { ok: false, error: 'INVALID_REQUEST' });
    assert.equal(calls, 0);
  });

  it('null, 배열, 문자열, 숫자, 불리언은 모두 400 INVALID_REQUEST', async () => {
    for (const body of ['null', '[]', '"x"', '1', 'true']) {
      let calls = 0;
      const { deps } = makeDeps({ refreshQueue: async () => { calls += 1; return { items_touched: 0 }; } });
      const res = await handleQueueRefresh(req({ token: TEST_TOKEN, body }), deps);
      assert.equal(res.status, 400, body);
      assert.deepEqual(await res.json(), { ok: false, error: 'INVALID_REQUEST' }, body);
      assert.equal(calls, 0, body);
    }
  });
});

describe('research-queue-refresh · parseRefreshRequest', () => {
  it('undefined와 빈 object만 허용한다', () => {
    assert.deepEqual(parseRefreshRequest(undefined), { ok: true });
    assert.deepEqual(parseRefreshRequest({}), { ok: true });
  });

  it('그 밖의 모든 모양을 거절한다', () => {
    for (const value of [null, [], 'x', 1, true, { a: 1 }]) {
      assert.deepEqual(parseRefreshRequest(value), { ok: false }, JSON.stringify(value));
    }
  });
});

describe('research-queue-refresh · J~Q. RPC 결과', () => {
  it('items_touched 0 → 200, itemsTouched 0', async () => {
    const { deps } = makeDeps({ refreshQueue: async () => ({ refreshed_at: 'x', items_touched: 0 }) });
    const res = await handleQueueRefresh(authedNoBody(), deps);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, status: 'refreshed', itemsTouched: 0 });
  });

  it('items_touched 양수 → 정확한 payload', async () => {
    const { deps } = makeDeps({ refreshQueue: async () => ({ refreshed_at: 'x', items_touched: 7 }) });
    const res = await handleQueueRefresh(authedNoBody(), deps);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { ok: true, status: 'refreshed', itemsTouched: 7 });
    assert.deepEqual(Object.keys(body).sort(), ['itemsTouched', 'ok', 'status']);
  });

  it('RPC network 실패 → 503, 호출 1회', async () => {
    let calls = 0;
    const { deps } = makeDeps({
      refreshQueue: async () => {
        calls += 1;
        throw new Error('network down');
      },
    });
    const res = await handleQueueRefresh(authedNoBody(), deps);
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { ok: false, error: 'QUEUE_REFRESH_UNAVAILABLE' });
    assert.equal(calls, 1);
  });

  it('RPC timeout(추상화된 실패) → 503, 호출 1회', async () => {
    let calls = 0;
    const { deps } = makeDeps({
      refreshQueue: async () => {
        calls += 1;
        throw new Error('refresh_http_408');
      },
    });
    const res = await handleQueueRefresh(authedNoBody(), deps);
    assert.equal(res.status, 503);
    assert.equal(calls, 1);
  });

  it('RPC non-OK(추상화된 실패) → 503, 호출 1회', async () => {
    let calls = 0;
    const { deps } = makeDeps({
      refreshQueue: async () => {
        calls += 1;
        throw new Error('refresh_http_500');
      },
    });
    const res = await handleQueueRefresh(authedNoBody(), deps);
    assert.equal(res.status, 503);
    assert.equal(calls, 1);
  });

  it('items_touched 필드 없음 → 502', async () => {
    const { deps } = makeDeps({ refreshQueue: async () => ({ refreshed_at: 'x' }) });
    const res = await handleQueueRefresh(authedNoBody(), deps);
    assert.equal(res.status, 502);
    assert.deepEqual(await res.json(), { ok: false, error: 'INVALID_REFRESH_RESPONSE' });
  });

  it('items_touched 음수/실수/문자열 → 502', async () => {
    for (const bad of [-1, 1.5, '3', null, [1, 2]]) {
      const { deps } = makeDeps({ refreshQueue: async () => ({ items_touched: bad }) });
      const res = await handleQueueRefresh(authedNoBody(), deps);
      assert.equal(res.status, 502, JSON.stringify(bad));
      assert.deepEqual(await res.json(), { ok: false, error: 'INVALID_REFRESH_RESPONSE' }, JSON.stringify(bad));
    }
  });

  it('RPC가 배열/스칼라를 돌려주면 502', async () => {
    for (const bad of [null, [], 'x', 1, true]) {
      const { deps } = makeDeps({ refreshQueue: async () => bad });
      const res = await handleQueueRefresh(authedNoBody(), deps);
      assert.equal(res.status, 502, JSON.stringify(bad));
    }
  });

  it('RPC의 extra field(refreshed_at 등)는 성공 응답에 나타나지 않는다', async () => {
    const { deps } = makeDeps({
      refreshQueue: async () => ({
        refreshed_at: '2026-09-09T00:00:00Z',
        items_touched: 3,
        unexpected_secret_looking_field: 'do-not-leak',
      }),
    });
    const res = await handleQueueRefresh(authedNoBody(), deps);
    const body = await res.json();
    assert.deepEqual(Object.keys(body).sort(), ['itemsTouched', 'ok', 'status']);
    const serialized = JSON.stringify(body);
    assert.ok(!serialized.includes('refreshed_at'));
    assert.ok(!serialized.includes('do-not-leak'));
  });
});

describe('research-queue-refresh · parseRefreshRpcResult', () => {
  it('items_touched만 안전하게 꺼낸다', () => {
    assert.deepEqual(parseRefreshRpcResult({ refreshed_at: 'x', items_touched: 5 }), {
      ok: true,
      itemsTouched: 5,
    });
  });

  it('모양이 다르면 실패한다', () => {
    for (const bad of [null, [], 'x', 1, {}, { items_touched: -1 }, { items_touched: 1.2 }]) {
      assert.deepEqual(parseRefreshRpcResult(bad), { ok: false }, JSON.stringify(bad));
    }
  });
});

describe('research-queue-refresh · 개인정보/토큰 유출 없음', () => {
  it('fake token이 어떤 응답에도 등장하지 않는다', async () => {
    const { deps } = makeDeps({
      isAuthorized: () => false,
      refreshQueue: async () => ({ items_touched: 0 }),
    });
    const res = await handleQueueRefresh(req({ token: TEST_TOKEN }), deps);
    const body = await res.json();
    assert.ok(!JSON.stringify(body).includes(TEST_TOKEN));
  });

  it('가짜 DB 오류 문자열이 응답에 등장하지 않는다', async () => {
    const { deps } = makeDeps({
      refreshQueue: async () => {
        throw new Error('pg_error: relation "private.coverage_gap_daily" leaked detail');
      },
    });
    const res = await handleQueueRefresh(authedNoBody(), deps);
    const body = await res.json();
    assert.ok(!JSON.stringify(body).includes('leaked detail'));
    assert.ok(!JSON.stringify(body).includes('pg_error'));
  });
});

describe('research-queue-refresh · T. index.ts 배선', () => {
  const indexSrc = stripComments(read(INDEX));
  const handlerSrc = stripComments(read(HANDLER));

  it('필요한 env 이름이 정확히 셋이다', () => {
    const envReads = [...indexSrc.matchAll(/Deno\.env\.get\('([^']+)'\)/g)].map((m) => m[1]);
    assert.deepEqual(
      Array.from(new Set(envReads)).sort(),
      ['RESEARCH_QUEUE_REFRESH_TOKEN', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_URL'].sort(),
    );
  });

  it('handler.ts는 Deno.env를 읽지 않는다', () => {
    assert.equal(handlerSrc.includes('Deno.env'), false);
  });

  it('RPC 이름을 상수에서 가져와 쓴다(하드코딩 문자열이 아니다)', () => {
    assert.ok(indexSrc.includes('REFRESH_CONTENT_RESEARCH_QUEUE_RPC'));
    assert.equal(indexSrc.includes(`'${REFRESH_CONTENT_RESEARCH_QUEUE_RPC}'`), false);
  });

  it('retry loop이 없다', () => {
    for (const banned of ['for (', 'while (', '.retry(']) {
      assert.equal(indexSrc.includes(banned), false, banned);
      assert.equal(handlerSrc.includes(banned), false, banned);
    }
  });

  it('CORS를 추가하지 않는다', () => {
    assert.equal(indexSrc.toLowerCase().includes('cors'), false);
    assert.equal(handlerSrc.toLowerCase().includes('cors'), false);
    assert.equal(indexSrc.toLowerCase().includes('access-control'), false);
  });

  it('OpenAI를 부르지 않는다', () => {
    assert.equal(indexSrc.includes('api.openai.com'), false);
    assert.equal(indexSrc.includes('OPENAI'), false);
    assert.equal(handlerSrc.includes('OPENAI'), false);
  });

  it('production project ref나 실제 URL을 하드코딩하지 않는다', () => {
    assert.equal(/https:\/\/[a-z0-9-]+\.supabase\.co/.test(indexSrc), false);
  });

  it('실제 비밀 값을 리터럴로 담지 않는다(Deno.env.get 형태로만 읽는다)', () => {
    assert.equal(/sk-[a-zA-Z0-9]{10,}/.test(indexSrc), false);
  });

  it('index.ts가 정확히 한 번만 refreshQueue를 handler에 넘긴다', () => {
    const occurrences = indexSrc.split('refreshQueue').length - 1;
    assert.ok(occurrences >= 1);
    assert.equal(indexSrc.split('handleQueueRefresh(').length - 1, 1);
  });
});
