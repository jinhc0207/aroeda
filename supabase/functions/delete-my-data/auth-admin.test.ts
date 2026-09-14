/**
 * delete-my-data · Auth 연결 계약 테스트
 *
 * 실행: npm test
 *
 * handler.test.ts는 "무엇을 지울지 판단하는 규칙"을 본다.
 * 이 파일은 그 아래, "실제로 어떤 요청이 나가는지"를 본다.
 *
 * 여기서 확인하는 것:
 *   신원 확인에는 이용자 토큰이, 삭제에는 서버 전용 키가 쓰이는가.
 *   확인된 사용자 번호만 삭제 주소에 들어가는가.
 *   실패한 응답에서 기계 판독용 코드만 꺼내는가.
 *   머리말만 오고 본문이 멈추면 시계가 요청을 끊는가.
 *   성공하든 실패하든 시계를 끄는가.
 *
 * 실제 네트워크를 쓰지 않는다. fetch와 시계를 전부 인자로 바꿔 넣는다.
 * 실제 사용자를 지우지 않는다. 실제 DB를 건드리지 않는다.
 *
 * 이 테스트가 확인하지 않는 것:
 *   Supabase Auth 서버가 실제로 어떤 본문을 주는지.
 *   서버 전용 키가 실제로 삭제 권한을 갖는지.
 *   그것들은 배포 뒤에만 확인할 수 있다.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createAuthAdmin, type AuthAdminConfig } from './auth-admin.ts';
import { handleDeleteMyData, isDefiniteAuthRejection, type AuthCallError } from './handler.ts';

const URL_BASE = 'https://project.example.test';
const SERVICE_ROLE_KEY = 'TEST_SERVICE_ROLE_KEY';
const USER_TOKEN = 'TEST_USER_ACCESS_TOKEN';
const USER_ID = '11111111-2222-3333-4444-555555555555';
const TIMEOUT_MS = 5_000;

type Call = {
  url: string;
  method: string;
  authorization: string;
  apikey: string;
  signal: AbortSignal | undefined;
};

type Harness = {
  admin: ReturnType<typeof createAuthAdmin>;
  calls: Call[];
  /** schedule이 걸린 횟수와 취소된 횟수. 시계가 정리됐는지 본다. */
  timers: { scheduled: number; cancelled: number; ms: number[] };
  /** 걸려 있는 시계를 지금 울린다. */
  fireTimeout: () => void;
};

/** 가짜 응답 하나. json()이 무엇을 할지 시험마다 정한다. */
function fakeResponse(init: {
  ok?: boolean;
  status?: number;
  json?: (signal: AbortSignal | undefined) => Promise<unknown>;
}) {
  const status = init.status ?? 200;
  // 실제 fetch처럼, 본문은 그 요청에 실린 signal이 끊기면 함께 끊긴다.
  return (call: Call) =>
    ({
      ok: init.ok ?? (status >= 200 && status < 300),
      status,
      json: () =>
        init.json
          ? init.json(call.signal)
          : Promise.reject(new Error('이 시험은 본문을 정하지 않았습니다.')),
    }) as unknown as Response;
}

function makeHarness(respond: (call: Call) => Response | Promise<Response>): Harness {
  const calls: Call[] = [];
  const timers = { scheduled: 0, cancelled: 0, ms: [] as number[] };
  let pending: (() => void) | null = null;

  const config: AuthAdminConfig = {
    url: URL_BASE,
    serviceRoleKey: SERVICE_ROLE_KEY,
    timeoutMs: TIMEOUT_MS,
    fetchImpl: (async (input: unknown, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const call: Call = {
        url: String(input),
        method: init?.method ?? 'GET',
        authorization: headers.authorization ?? '',
        apikey: headers.apikey ?? '',
        signal: init?.signal ?? undefined,
      };
      calls.push(call);
      return await respond(call);
    }) as unknown as typeof fetch,
    schedule: (onTimeout, ms) => {
      timers.scheduled += 1;
      timers.ms.push(ms);
      pending = onTimeout;
      return () => {
        timers.cancelled += 1;
        pending = null;
      };
    },
  };

  return {
    admin: createAuthAdmin(config),
    calls,
    timers,
    fireTimeout: () => pending?.(),
  };
}

/** 본문이 영영 오지 않다가, 시계가 끊으면 그제야 실패하는 응답. */
const stalledBody = (signal: AbortSignal | undefined) =>
  new Promise<unknown>((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });

/**
 * 약속이 이미 끝났는지 본다.
 *
 * 대기열을 몇 번 비워 준 뒤에도 끝나지 않았으면 아직 기다리는 중이다.
 * 시계를 울리기 전에 끝나 버리면 시간 제한이 걸려 있지 않다는 뜻이다.
 */
async function settled(promise: Promise<unknown>): Promise<boolean> {
  const marker = Symbol('pending');
  const idle = new Promise<typeof marker>((resolve) => setImmediate(() => resolve(marker)));
  return (await Promise.race([promise.catch(() => marker), idle])) !== marker;
}

/** 같은 transport를 실제 handler에 물려서 밖으로 나가는 응답까지 본다. */
function respondThrough(harness: Harness, body?: string): Promise<Response> {
  return handleDeleteMyData(
    new Request('https://example.test/delete-my-data', {
      method: 'POST',
      headers: { authorization: `Bearer ${USER_TOKEN}` },
      ...(body === undefined ? {} : { body }),
    }),
    {
      hasAdminCredentials: () => true,
      getUserByToken: harness.admin.getUserByToken,
      deleteUser: harness.admin.deleteUser,
      log: () => {},
      requestId: () => 'testreq',
    },
  );
}

/* ================================================================== */
/* A. 신원 확인은 이용자 토큰으로                                       */
/* ================================================================== */

describe('delete-my-data auth · A. 신원 확인', () => {
  it('이용자 Bearer 토큰으로 /auth/v1/user를 부른다', async () => {
    const harness = makeHarness(
      fakeResponse({ status: 200, json: async () => ({ id: USER_ID, is_anonymous: true }) }),
    );

    const result = await harness.admin.getUserByToken(USER_TOKEN);

    assert.equal(harness.calls.length, 1);
    assert.equal(harness.calls[0].url, `${URL_BASE}/auth/v1/user`);
    assert.equal(harness.calls[0].method, 'GET');
    assert.equal(harness.calls[0].authorization, `Bearer ${USER_TOKEN}`);
    // 관리자 경로를 쓰지 않는다.
    assert.equal(harness.calls[0].url.includes('/admin/'), false);

    assert.equal(result.error, null);
    assert.deepEqual(result.data?.user, { id: USER_ID, is_anonymous: true });
  });

  it('신원 확인에 서버 전용 키를 Bearer로 쓰지 않는다', async () => {
    const harness = makeHarness(fakeResponse({ status: 200, json: async () => ({ id: USER_ID }) }));

    await harness.admin.getUserByToken(USER_TOKEN);

    // apikey 자리에는 들어가지만, 권한 머리말이 서버 키로 덮이면 안 된다.
    assert.equal(harness.calls[0].authorization.includes(SERVICE_ROLE_KEY), false);
    assert.equal(harness.calls[0].apikey, SERVICE_ROLE_KEY);
  });

  it('사용자 JSON을 그대로 넘긴다', async () => {
    const body = { id: USER_ID, is_anonymous: true, email: null };
    const harness = makeHarness(fakeResponse({ status: 200, json: async () => body }));

    const result = await harness.admin.getUserByToken(USER_TOKEN);

    assert.deepEqual(result.data?.user, body);
  });

  it('200인데 본문이 JSON이 아니면 사용자도 오류 코드도 없다', async () => {
    const harness = makeHarness(
      fakeResponse({
        status: 200,
        json: async () => {
          throw new SyntaxError('Unexpected token');
        },
      }),
    );

    const result = await harness.admin.getUserByToken(USER_TOKEN);

    // 성공이라고 말하지 않는다. handler가 이 모양을 503으로 읽는다.
    assert.equal(result.data, null);
    assert.equal(result.error, null);
  });
});

/* ================================================================== */
/* B. 오류 코드만 꺼낸다                                                */
/* ================================================================== */

describe('delete-my-data auth · B. 오류에서 코드만', () => {
  it('error_code를 꺼내고 설명 문구는 버린다', async () => {
    const harness = makeHarness(
      fakeResponse({
        status: 403,
        json: async () => ({
          code: 403,
          error_code: 'user_not_found',
          msg: '사용자 원본 설명이 여기 들어올 수 있다',
        }),
      }),
    );

    const result = await harness.admin.getUserByToken(USER_TOKEN);
    const error = result.error as AuthCallError;

    assert.deepEqual(error, { status: 403, code: 'user_not_found' });
    // 설명 문구를 담지 않았다.
    assert.equal(JSON.stringify(error).includes('원본 설명'), false);
    assert.equal('msg' in (error as object), false);
  });

  it('error_code가 없으면 문자열 code를 쓴다', async () => {
    const harness = makeHarness(
      fakeResponse({ status: 401, json: async () => ({ code: 'bad_jwt', msg: 'x' }) }),
    );

    const result = await harness.admin.getUserByToken(USER_TOKEN);

    assert.deepEqual(result.error, { status: 401, code: 'bad_jwt' });
  });

  it('숫자 code만 있으면 코드를 모르는 것으로 둔다', async () => {
    const harness = makeHarness(
      fakeResponse({ status: 400, json: async () => ({ code: 400, msg: 'x' }) }),
    );

    const result = await harness.admin.getUserByToken(USER_TOKEN);

    assert.deepEqual(result.error, { status: 400, code: null });
  });

  it('오류 본문을 읽지 못하면 코드를 모르는 것으로 둔다', async () => {
    const harness = makeHarness(
      fakeResponse({
        status: 502,
        json: async () => {
          throw new SyntaxError('not json');
        },
      }),
    );

    const result = await harness.admin.getUserByToken(USER_TOKEN);

    assert.deepEqual(result.error, { status: 502, code: null });
  });
});

/* ================================================================== */
/* C. 실제 코드가 어떻게 분류되는가                                     */
/* ================================================================== */

describe('delete-my-data auth · C. 코드별 분류', () => {
  const classify = async (status: number, errorCode: string | undefined) => {
    const harness = makeHarness(
      fakeResponse({
        status,
        json: async () => (errorCode === undefined ? {} : { error_code: errorCode }),
      }),
    );
    const result = await harness.admin.getUserByToken(USER_TOKEN);
    return isDefiniteAuthRejection(result.error) ? 401 : 503;
  };

  it('인증 거부 코드만 401이다', async () => {
    assert.equal(await classify(401, 'no_authorization'), 401);
    assert.equal(await classify(422, 'bad_jwt'), 401);
    assert.equal(await classify(401, 'session_expired'), 401);
    assert.equal(await classify(422, 'session_not_found'), 401);
    assert.equal(await classify(403, 'user_not_found'), 401);
  });

  it('일시적인 문제는 503이다', async () => {
    // 잠시 뒤 다시 하면 성공할 수 있는 것들. 인증 거절이 아니다.
    assert.equal(await classify(429, 'over_request_rate_limit'), 503);
    assert.equal(await classify(408, 'request_timeout'), 503);
    assert.equal(await classify(409, 'conflict'), 503);
  });

  it('코드 없는 404를 사용자 없음으로 읽지 않는다', async () => {
    // 주소가 틀려도 404가 온다. user_not_found 코드가 있을 때만 거절이다.
    assert.equal(await classify(404, undefined), 503);
    assert.equal(await classify(404, 'user_not_found'), 401);
  });

  it('알 수 없는 4xx와 5xx는 503이다', async () => {
    assert.equal(await classify(400, undefined), 503);
    assert.equal(await classify(418, 'teapot'), 503);
    assert.equal(await classify(451, 'unavailable_for_legal_reasons'), 503);
    assert.equal(await classify(500, undefined), 503);
    assert.equal(await classify(502, 'bad_gateway'), 503);
    assert.equal(await classify(503, undefined), 503);
  });

  it('서버 오류에 거절 코드가 붙어 와도 503이다', async () => {
    // 고장 났다는 답과 거절했다는 답이 섞인 모순된 응답이다. 거절로 읽지 않는다.
    assert.equal(await classify(500, 'bad_jwt'), 503);
    assert.equal(await classify(502, 'user_not_found'), 503);
    assert.equal(await classify(503, 'session_expired'), 503);
  });
});

/* ================================================================== */
/* D. 삭제는 서버 전용 키로                                             */
/* ================================================================== */

describe('delete-my-data auth · D. 삭제', () => {
  it('관리자 Bearer로 확인된 사용자 번호만 지운다', async () => {
    const harness = makeHarness(fakeResponse({ status: 200, json: async () => ({}) }));

    const result = await harness.admin.deleteUser(USER_ID);

    assert.equal(harness.calls.length, 1);
    assert.equal(harness.calls[0].url, `${URL_BASE}/auth/v1/admin/users/${USER_ID}`);
    assert.equal(harness.calls[0].method, 'DELETE');
    assert.equal(harness.calls[0].authorization, `Bearer ${SERVICE_ROLE_KEY}`);
    assert.equal(result.error, null);
  });

  it('삭제 요청에 이용자 토큰이 섞이지 않는다', async () => {
    const harness = makeHarness(fakeResponse({ status: 200, json: async () => ({}) }));

    await harness.admin.deleteUser(USER_ID);

    const call = harness.calls[0];
    assert.equal(call.authorization.includes(USER_TOKEN), false);
    assert.equal(call.apikey.includes(USER_TOKEN), false);
    assert.equal(call.url.includes(USER_TOKEN), false);
  });

  it('사용자 번호를 주소에 안전하게 넣는다', async () => {
    const harness = makeHarness(fakeResponse({ status: 200, json: async () => ({}) }));

    await harness.admin.deleteUser('a/../../admin b');

    assert.equal(harness.calls[0].url, `${URL_BASE}/auth/v1/admin/users/a%2F..%2F..%2Fadmin%20b`);
  });

  it('삭제 실패를 성공으로 바꾸지 않는다', async () => {
    for (const status of [400, 401, 403, 404, 429, 500, 503]) {
      const harness = makeHarness(
        fakeResponse({ status, json: async () => ({ error_code: 'whatever' }) }),
      );

      const result = await harness.admin.deleteUser(USER_ID);

      assert.notEqual(result.error, null, String(status));
      assert.deepEqual(result.error, { status, code: 'whatever' }, String(status));
    }
  });

  it('삭제 중 통신 예외는 그대로 올라간다', async () => {
    const harness = makeHarness(() => {
      throw new Error('network down');
    });

    await assert.rejects(() => harness.admin.deleteUser(USER_ID));
    // 시계는 정리되어야 한다.
    assert.equal(harness.timers.cancelled, 1);
  });
});

/* ================================================================== */
/* E. 시간 제한은 본문까지 유지된다                                     */
/* ================================================================== */

describe('delete-my-data auth · E. 본문까지 시계를 유지한다', () => {
  it('머리말만 오고 본문이 멈추면 시계가 끝낼 때까지 끝나지 않는다', async () => {
    const harness = makeHarness(fakeResponse({ status: 200, json: stalledBody }));

    const pending = harness.admin.getUserByToken(USER_TOKEN);

    // fetch는 이미 돌아왔다. 예전 구현이라면 여기서 시계가 꺼져 있었다.
    assert.equal(await settled(pending), false, '본문을 기다리는 동안 끝나면 안 됩니다.');
    assert.equal(harness.calls.length, 1);
    assert.equal(harness.timers.cancelled, 0, '본문을 읽는 동안 시계가 살아 있어야 합니다.');

    // 시계가 울리면 본문 읽기가 끊기고 그 자리에서 끝난다.
    harness.fireTimeout();

    const result = await pending;
    assert.equal(harness.timers.cancelled, 1);
    // 사용자를 확인하지 못했다. 성공이 아니다.
    assert.equal(result.data, null);
  });

  it('본문이 멈춘 신원 확인은 503이 된다', async () => {
    const harness = makeHarness(fakeResponse({ status: 200, json: stalledBody }));

    const pending = respondThrough(harness);
    assert.equal(await settled(pending), false);

    harness.fireTimeout();
    const response = await pending;

    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { ok: false, error: 'DELETE_UNAVAILABLE' });
  });

  it('오류 응답의 본문이 멈춰도 시계가 끝내고 503이 된다', async () => {
    const harness = makeHarness(fakeResponse({ status: 500, json: stalledBody }));

    const pending = respondThrough(harness);
    assert.equal(await settled(pending), false);
    assert.equal(harness.timers.cancelled, 0);

    harness.fireTimeout();
    const response = await pending;

    assert.equal(harness.timers.cancelled, 1);
    assert.equal(response.status, 503);
  });

  it('삭제 응답의 본문이 멈춰도 시계가 끝낸다', async () => {
    const harness = makeHarness(fakeResponse({ status: 500, json: stalledBody }));

    const pending = harness.admin.deleteUser(USER_ID);
    assert.equal(await settled(pending), false);
    assert.equal(harness.timers.cancelled, 0);

    harness.fireTimeout();
    const result = await pending;

    assert.equal(harness.timers.cancelled, 1);
    // 지웠는지 확인하지 못했다. 성공이 아니다.
    assert.notEqual(result.error, null);
  });

  it('요청마다 정해진 시간을 건다', async () => {
    const harness = makeHarness(fakeResponse({ status: 200, json: async () => ({ id: USER_ID }) }));

    await harness.admin.getUserByToken(USER_TOKEN);
    await harness.admin.deleteUser(USER_ID);

    assert.equal(harness.timers.scheduled, 2);
    assert.deepEqual(harness.timers.ms, [TIMEOUT_MS, TIMEOUT_MS]);
  });

  it('요청에 끊을 수 있는 신호가 실린다', async () => {
    const harness = makeHarness(fakeResponse({ status: 200, json: async () => ({ id: USER_ID }) }));

    await harness.admin.getUserByToken(USER_TOKEN);

    assert.ok(harness.calls[0].signal, '요청에 signal이 실려야 합니다.');
    assert.equal(harness.calls[0].signal?.aborted, false);
  });
});

/* ================================================================== */
/* F. 시계 정리                                                        */
/* ================================================================== */

describe('delete-my-data auth · F. 시계를 반드시 끈다', () => {
  it('성공한 뒤 시계를 끈다', async () => {
    const harness = makeHarness(fakeResponse({ status: 200, json: async () => ({ id: USER_ID }) }));

    await harness.admin.getUserByToken(USER_TOKEN);

    assert.equal(harness.timers.scheduled, 1);
    assert.equal(harness.timers.cancelled, 1);
  });

  it('실패한 뒤에도 시계를 끈다', async () => {
    const harness = makeHarness(
      fakeResponse({ status: 500, json: async () => ({ error_code: 'x' }) }),
    );

    await harness.admin.getUserByToken(USER_TOKEN);

    assert.equal(harness.timers.cancelled, 1);
  });

  it('fetch가 예외를 던져도 시계를 끈다', async () => {
    const harness = makeHarness(() => {
      throw new Error('network down');
    });

    await assert.rejects(() => harness.admin.getUserByToken(USER_TOKEN));

    assert.equal(harness.timers.scheduled, 1);
    assert.equal(harness.timers.cancelled, 1);
  });
});

/* ================================================================== */
/* G. 실제 연결을 handler에 물려서                                      */
/* ================================================================== */

/*
 * 위의 A~F는 연결 조각을 따로 본다. 여기서는 진짜 연결 코드를 진짜 handler에 그대로 물린다.
 * 조각마다 맞아도 이어 붙였을 때 틀릴 수 있기 때문이다.
 * 여전히 네트워크는 쓰지 않는다. Auth 서버 자리에 주소별로 답하는 가짜를 둔다.
 */

const OTHER_USER_ID = '99999999-8888-7777-6666-555555555555';

/** 주소에 따라 다른 답을 주는 가짜 Auth 서버. 모르는 주소로 가면 시험이 실패한다. */
function authServer(options: {
  lookup: (call: Call) => Response;
  remove?: (call: Call) => Response;
}) {
  return (call: Call): Response => {
    if (call.url === `${URL_BASE}/auth/v1/user`) return options.lookup(call);
    if (options.remove && call.url.startsWith(`${URL_BASE}/auth/v1/admin/users/`)) {
      return options.remove(call);
    }
    throw new Error(`예상하지 못한 주소: ${call.url}`);
  };
}

const anonymousUser = fakeResponse({
  status: 200,
  json: async () => ({ id: USER_ID, is_anonymous: true }),
});

describe('delete-my-data auth · G. handler와 이어서', () => {
  it('본문의 번호를 무시하고, 확인된 번호만 관리자 자격으로 지운다', async () => {
    const harness = makeHarness(
      authServer({
        lookup: anonymousUser,
        remove: fakeResponse({ status: 200, json: async () => ({}) }),
      }),
    );

    const response = await respondThrough(
      harness,
      JSON.stringify({ userId: OTHER_USER_ID, user_id: OTHER_USER_ID, sub: OTHER_USER_ID }),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, deleted: true });

    assert.equal(harness.calls.length, 2);
    const [lookup, removal] = harness.calls;

    // 신원 확인: 이용자 토큰
    assert.equal(lookup.method, 'GET');
    assert.equal(lookup.url, `${URL_BASE}/auth/v1/user`);
    assert.equal(lookup.authorization, `Bearer ${USER_TOKEN}`);

    // 삭제: 서버 전용 키, Auth가 확인해 준 번호
    assert.equal(removal.method, 'DELETE');
    assert.equal(removal.url, `${URL_BASE}/auth/v1/admin/users/${USER_ID}`);
    assert.equal(removal.authorization, `Bearer ${SERVICE_ROLE_KEY}`);
    assert.equal(removal.authorization.includes(USER_TOKEN), false);

    // 본문에 적힌 번호는 어느 요청에도 쓰이지 않았다.
    for (const call of harness.calls) {
      assert.equal(call.url.includes(OTHER_USER_ID), false);
    }
  });

  it('인증 거부 코드면 401이고 삭제 요청이 나가지 않는다', async () => {
    const harness = makeHarness(
      authServer({
        lookup: fakeResponse({ status: 403, json: async () => ({ error_code: 'user_not_found' }) }),
      }),
    );

    const response = await respondThrough(harness);

    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { ok: false, error: 'DELETE_UNAUTHENTICATED' });
    assert.equal(harness.calls.length, 1);
  });

  it('익명이 아니면 403이고 삭제 요청이 나가지 않는다', async () => {
    const harness = makeHarness(
      authServer({
        lookup: fakeResponse({
          status: 200,
          json: async () => ({ id: OTHER_USER_ID, is_anonymous: false }),
        }),
      }),
    );

    const response = await respondThrough(harness);

    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { ok: false, error: 'DELETE_NOT_ANONYMOUS' });
    assert.equal(harness.calls.length, 1);
  });

  it('429·408·409는 503이고 삭제 요청이 나가지 않는다', async () => {
    for (const [status, code] of [
      [429, 'over_request_rate_limit'],
      [408, 'request_timeout'],
      [409, 'conflict'],
    ] as const) {
      const harness = makeHarness(
        authServer({ lookup: fakeResponse({ status, json: async () => ({ error_code: code }) }) }),
      );

      const response = await respondThrough(harness);

      assert.equal(response.status, 503, code);
      assert.deepEqual(await response.json(), { ok: false, error: 'DELETE_UNAVAILABLE' }, code);
      assert.equal(harness.calls.length, 1, code);
    }
  });

  it('관리자 삭제가 실패하면 503이고, "이미 없음"도 성공으로 바꾸지 않는다', async () => {
    for (const status of [400, 403, 404, 500, 503]) {
      const harness = makeHarness(
        authServer({
          lookup: anonymousUser,
          remove: fakeResponse({ status, json: async () => ({ error_code: 'user_not_found' }) }),
        }),
      );

      const response = await respondThrough(harness);
      const body = (await response.json()) as Record<string, unknown>;

      assert.equal(response.status, 503, String(status));
      assert.deepEqual(body, { ok: false, error: 'DELETE_UNAVAILABLE' }, String(status));
      assert.equal('deleted' in body, false, String(status));
      assert.equal(harness.calls.length, 2, String(status));
    }
  });

  it('관리자 삭제 중 통신이 끊기면 503이고 두 시계가 모두 정리된다', async () => {
    const harness = makeHarness(
      authServer({
        lookup: anonymousUser,
        remove: () => {
          throw new Error('network down');
        },
      }),
    );

    const response = await respondThrough(harness);

    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { ok: false, error: 'DELETE_UNAVAILABLE' });
    assert.equal(harness.timers.scheduled, 2);
    assert.equal(harness.timers.cancelled, 2);
  });

  it('머리말이 오기 전에 멈춰도 시계가 끝내고 503이 된다', async () => {
    // 응답이 아예 오지 않는 경우. fetch 자체가 signal이 끊길 때까지 기다린다.
    const harness = makeHarness(
      (call) =>
        new Promise<Response>((_resolve, reject) => {
          call.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        }),
    );

    const pending = respondThrough(harness);
    assert.equal(await settled(pending), false, '시계가 울리기 전에 끝나면 안 됩니다.');
    assert.equal(harness.timers.cancelled, 0);

    harness.fireTimeout();
    const response = await pending;

    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { ok: false, error: 'DELETE_UNAVAILABLE' });
    assert.equal(harness.timers.cancelled, 1);
    // 신원을 확인하지 못했으니 삭제는 시도하지 않았다.
    assert.equal(harness.calls.length, 1);
  });

  it('성공한 경우에도 두 시계가 모두 정리된다', async () => {
    const harness = makeHarness(
      authServer({
        lookup: anonymousUser,
        remove: fakeResponse({ status: 200, json: async () => ({}) }),
      }),
    );

    const response = await respondThrough(harness);

    assert.equal(response.status, 200);
    assert.equal(harness.timers.scheduled, 2);
    assert.equal(harness.timers.cancelled, 2);
  });
});
