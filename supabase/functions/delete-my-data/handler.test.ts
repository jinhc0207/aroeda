/**
 * delete-my-data · 요청 처리 계약 테스트
 *
 * 실행: npm test
 *
 * 이 기능은 되돌릴 수 없는 일을 한다. 그래서 두 가지를 가장 무겁게 본다.
 *
 *   1. 누구를 지우는가.
 *      요청 본문에 적힌 번호로도, 토큰을 뜯어 꺼낸 번호로도 지우지 않는다.
 *      Auth 서버가 확인해 준 사람만 지운다. 그리고 익명인 사람만 지운다.
 *
 *   2. 무엇을 성공이라 부르는가.
 *      관리자 삭제가 성공했다고 답한 경우에만 성공이다.
 *      인증 오류, 통신 실패, 읽을 수 없는 답을 성공으로 바꾸지 않는다.
 *
 * 바깥으로 나가지 않는다. Auth 호출은 전부 주입해서 바꿔 끼운다.
 * 실제 사용자를 지우지 않는다. 실제 DB를 건드리지 않는다.
 *
 * 이 테스트가 확인하지 않는 것:
 *   외래키(on delete cascade)로 사용량 기록이 실제로 지워지는지.
 *   그것은 DB 동작이고, 여기의 가짜 함수로는 증명할 수 없다.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  AUTH_REJECTION_CODES,
  DELETE_METHOD_NOT_ALLOWED,
  DELETE_NOT_ANONYMOUS,
  DELETE_UNAUTHENTICATED,
  DELETE_UNAVAILABLE,
  handleDeleteMyData,
  isDefiniteAuthRejection,
  readBearerToken,
  type DeleteMyDataDeps,
  type DeleteUserResult,
  type GetUserResult,
} from './handler.ts';

/** 주석을 뺀 본문 (설명 문장에 적힌 낱말 때문에 잘못 걸리지 않도록) */
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '');

/** 이 값들이 응답이나 로그에 새어 나오면 안 된다. */
const ANON_USER_ID = '11111111-2222-3333-4444-555555555555';
const OTHER_USER_ID = '99999999-8888-7777-6666-555555555555';
const USER_TOKEN = 'TEST_USER_ACCESS_TOKEN';

type Recorded = {
  lookupTokens: string[];
  deletedIds: string[];
  logs: string[];
};

type Options = {
  method?: string;
  authorization?: string | null;
  body?: string;
  hasAdminCredentials?: boolean;
  lookup?: GetUserResult | (() => Promise<GetUserResult>);
  removal?: DeleteUserResult | (() => Promise<DeleteUserResult>);
};

/** 익명 사용자가 정상적으로 확인된 경우의 Auth 답. */
const anonymousLookup = (): GetUserResult => ({
  data: { user: { id: ANON_USER_ID, is_anonymous: true } },
  error: null,
});

async function run(options: Options = {}) {
  const recorded: Recorded = { lookupTokens: [], deletedIds: [], logs: [] };

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const authorization =
    options.authorization === undefined ? `Bearer ${USER_TOKEN}` : options.authorization;
  if (authorization !== null) headers.authorization = authorization;

  const request = new Request('https://example.test/delete-my-data', {
    method: options.method ?? 'POST',
    headers,
    ...(options.body !== undefined ? { body: options.body } : {}),
  });

  const deps: DeleteMyDataDeps = {
    hasAdminCredentials: () => options.hasAdminCredentials ?? true,
    getUserByToken: async (accessToken) => {
      recorded.lookupTokens.push(accessToken);
      const lookup = options.lookup ?? anonymousLookup();
      return typeof lookup === 'function' ? await lookup() : lookup;
    },
    deleteUser: async (userId) => {
      recorded.deletedIds.push(userId);
      const removal = options.removal ?? { data: null, error: null };
      return typeof removal === 'function' ? await removal() : removal;
    },
    log: (message) => recorded.logs.push(message),
    requestId: () => 'testreq',
  };

  const response = await handleDeleteMyData(request, deps);
  const text = await response.text();
  const parsed = JSON.parse(text) as Record<string, unknown>;

  return { response, parsed, text, recorded };
}

/* ================================================================== */
/* A. 누구를 지우는가                                                   */
/* ================================================================== */

describe('delete-my-data · A. 누구를 지우는가', () => {
  it('Auth 서버가 확인해 준 사람만 지운다', async () => {
    const { response, parsed, recorded } = await run();

    assert.equal(response.status, 200);
    assert.deepEqual(parsed, { ok: true, deleted: true });
    assert.deepEqual(recorded.deletedIds, [ANON_USER_ID]);
  });

  it('요청 본문에 적힌 사용자 번호로 지우지 않는다', async () => {
    const { response, recorded } = await run({
      body: JSON.stringify({ userId: OTHER_USER_ID, user_id: OTHER_USER_ID, sub: OTHER_USER_ID }),
    });

    assert.equal(response.status, 200);
    // 본문에 적힌 번호가 아니라 Auth 서버가 준 번호로만 지운다.
    assert.deepEqual(recorded.deletedIds, [ANON_USER_ID]);
    assert.equal(recorded.deletedIds.includes(OTHER_USER_ID), false);
  });

  it('본문이 JSON이 아니어도 결과가 달라지지 않는다', async () => {
    // 본문을 아예 읽지 않기 때문이다.
    const { response, recorded } = await run({ body: '{{{ not json' });

    assert.equal(response.status, 200);
    assert.deepEqual(recorded.deletedIds, [ANON_USER_ID]);
  });

  it('토큰을 뜯어보지 않고 Auth 서버에 그대로 물어본다', async () => {
    const { recorded } = await run();

    assert.deepEqual(recorded.lookupTokens, [USER_TOKEN]);
  });

  it('삭제 함수에는 사용자 번호만 넘어가고 토큰은 넘어가지 않는다', async () => {
    const { recorded } = await run();

    for (const id of recorded.deletedIds) {
      assert.equal(id.includes(USER_TOKEN), false);
      assert.equal(id, ANON_USER_ID);
    }
  });

  it('handler는 JWT를 직접 해독하지 않는다', () => {
    // 설명 문장에 적힌 낱말 때문에 잘못 걸리지 않도록 주석을 떼고 본다.
    const code = stripComments(readFileSync(new URL('./handler.ts', import.meta.url), 'utf8'));

    // sub 클레임을 꺼내 쓰는 길을 아예 만들지 않았다.
    for (const banned of ['atob(', 'JSON.parse(', "split('.')", 'split(".")', 'sub']) {
      assert.equal(code.includes(banned), false, banned);
    }
  });
});

/* ================================================================== */
/* B. 익명 사용자만 지운다                                              */
/* ================================================================== */

describe('delete-my-data · B. 익명 사용자만', () => {
  it('익명이 아니면 403이고 지우지 않는다', async () => {
    const { response, parsed, recorded } = await run({
      lookup: { data: { user: { id: OTHER_USER_ID, is_anonymous: false } }, error: null },
    });

    assert.equal(response.status, 403);
    assert.deepEqual(parsed, { ok: false, error: DELETE_NOT_ANONYMOUS });
    assert.deepEqual(recorded.deletedIds, []);
  });

  it('is_anonymous가 없으면 지우지 않는다', async () => {
    const { response, parsed, recorded } = await run({
      lookup: { data: { user: { id: OTHER_USER_ID } }, error: null },
    });

    assert.equal(response.status, 403);
    assert.deepEqual(parsed, { ok: false, error: DELETE_NOT_ANONYMOUS });
    assert.deepEqual(recorded.deletedIds, []);
  });

  it('true를 흉내 낸 값에 속지 않는다', async () => {
    // 'true' 문자열이나 1을 참으로 읽으면 일반 계정이 지워질 수 있다.
    for (const value of ['true', 1, {}, [], 'anonymous']) {
      const { response, recorded } = await run({
        lookup: { data: { user: { id: OTHER_USER_ID, is_anonymous: value } }, error: null },
      });

      assert.equal(response.status, 403, JSON.stringify(value));
      assert.deepEqual(recorded.deletedIds, [], JSON.stringify(value));
    }
  });
});

/* ================================================================== */
/* C. 인증 오류를 삭제 성공으로 바꾸지 않는다                            */
/* ================================================================== */

describe('delete-my-data · C. 인증 오류는 성공이 아니다', () => {
  it('Authorization이 없으면 401이고 Auth를 부르지 않는다', async () => {
    const { response, parsed, recorded } = await run({ authorization: null });

    assert.equal(response.status, 401);
    assert.deepEqual(parsed, { ok: false, error: DELETE_UNAUTHENTICATED });
    assert.deepEqual(recorded.lookupTokens, []);
    assert.deepEqual(recorded.deletedIds, []);
  });

  it('Bearer 형식이 아니면 401이다', async () => {
    for (const header of ['', '   ', 'Basic abc', 'Bearer', 'Bearer    ', USER_TOKEN]) {
      const { response, parsed, recorded } = await run({ authorization: header });

      assert.equal(response.status, 401, header);
      assert.deepEqual(parsed, { ok: false, error: DELETE_UNAUTHENTICATED }, header);
      assert.deepEqual(recorded.lookupTokens, [], header);
    }
  });

  it('Auth가 분명히 거절하면 401이고 지우지 않는다', async () => {
    // 허용 목록에 있는 기계 판독용 코드가 왔을 때만 거절이다. 상태 숫자로 판단하지 않는다.
    for (const [status, code] of [
      [401, 'no_authorization'],
      [422, 'bad_jwt'],
      [401, 'session_expired'],
      [422, 'session_not_found'],
      [403, 'user_not_found'],
    ] as const) {
      const { response, parsed, recorded } = await run({
        lookup: { data: null, error: { status, code } },
      });

      assert.equal(response.status, 401, code);
      assert.deepEqual(parsed, { ok: false, error: DELETE_UNAUTHENTICATED }, code);
      assert.deepEqual(recorded.deletedIds, [], code);
    }
  });

  it('사용자를 찾지 못한 경우를 삭제 성공으로 돌려주지 않는다', async () => {
    const { response, parsed } = await run({
      lookup: { data: null, error: { status: 403, code: 'user_not_found' } },
    });

    assert.equal(response.status, 401);
    assert.equal(parsed.ok, false);
    // deleted를 담은 성공 분기는 이 경우에 존재하지 않는다.
    assert.equal('deleted' in parsed, false);
  });
});

/* ================================================================== */
/* D. 확인하지 못한 것은 503이다                                        */
/* ================================================================== */

describe('delete-my-data · D. 확인 실패는 503', () => {
  it('Auth 통신이 끊기면 503이고 지우지 않는다', async () => {
    const { response, parsed, recorded } = await run({
      lookup: async () => {
        throw new Error('network down');
      },
    });

    assert.equal(response.status, 503);
    assert.deepEqual(parsed, { ok: false, error: DELETE_UNAVAILABLE });
    assert.deepEqual(recorded.deletedIds, []);
  });

  it('Auth가 서버 오류를 주면 503이다', async () => {
    for (const status of [500, 502, 503, 504]) {
      const { response, parsed, recorded } = await run({
        lookup: { data: null, error: { status, code: null } },
      });

      assert.equal(response.status, 503, String(status));
      assert.deepEqual(parsed, { ok: false, error: DELETE_UNAVAILABLE }, String(status));
      assert.deepEqual(recorded.deletedIds, [], String(status));
    }
  });

  it('잠시 뒤 다시 하면 될 수 있는 문제는 인증 실패로 부르지 않는다', async () => {
    // 429·408·409는 400번대이지만 인증이 거절된 것이 아니다.
    // 이것을 401로 부르면 이용자는 다시 시도해야 할 상황에서 잘못된 안내를 받는다.
    for (const [status, code] of [
      [429, 'over_request_rate_limit'],
      [408, 'request_timeout'],
      [409, 'conflict'],
    ] as const) {
      const { response, parsed, recorded } = await run({
        lookup: { data: null, error: { status, code } },
      });

      assert.equal(response.status, 503, code);
      assert.deepEqual(parsed, { ok: false, error: DELETE_UNAVAILABLE }, code);
      assert.deepEqual(recorded.deletedIds, [], code);
    }
  });

  it('코드 없는 404를 사용자 없음으로 추정하지 않는다', async () => {
    // 주소가 틀려도 404가 온다. 코드가 없으면 무엇인지 모르는 것이다.
    const { response, parsed } = await run({
      lookup: { data: null, error: { status: 404, code: null } },
    });

    assert.equal(response.status, 503);
    assert.deepEqual(parsed, { ok: false, error: DELETE_UNAVAILABLE });
  });

  it('모르는 오류 코드와 모양은 503이다', async () => {
    for (const error of [
      new Error('boom'),
      { message: 'boom' },
      'boom',
      { status: 'nope' },
      { status: 400, code: null },
      { status: 400, code: 'some_new_code_we_do_not_know' },
      { status: 401, code: 42 },
    ]) {
      const { response, parsed, recorded } = await run({ lookup: { data: null, error } });

      assert.equal(response.status, 503, JSON.stringify(error));
      assert.deepEqual(recorded.deletedIds, [], JSON.stringify(error));
      assert.deepEqual(parsed, { ok: false, error: DELETE_UNAVAILABLE });
    }
  });

  it('오류도 사용자도 없는 답은 503이다', async () => {
    // 이것을 "지울 사람이 없었다"로 읽고 성공을 돌려주면 안 된다.
    for (const lookup of [
      { data: null, error: null },
      { data: {}, error: null },
      { data: { user: null }, error: null },
      { data: { user: 'not-an-object' as unknown as null }, error: null },
    ]) {
      const { response, parsed, recorded } = await run({ lookup: lookup as GetUserResult });

      assert.equal(response.status, 503, JSON.stringify(lookup));
      assert.deepEqual(parsed, { ok: false, error: DELETE_UNAVAILABLE });
      assert.deepEqual(recorded.deletedIds, []);
    }
  });

  it('사용자 번호를 읽을 수 없으면 503이고 지우지 않는다', async () => {
    for (const id of [undefined, null, '', '   ', 123, {}]) {
      const { response, recorded } = await run({
        lookup: { data: { user: { id, is_anonymous: true } }, error: null },
      });

      assert.equal(response.status, 503, JSON.stringify(id));
      assert.deepEqual(recorded.deletedIds, [], JSON.stringify(id));
    }
  });

  it('서버 자격이 없으면 503이고 Auth를 부르지 않는다', async () => {
    const { response, parsed, recorded } = await run({ hasAdminCredentials: false });

    assert.equal(response.status, 503);
    assert.deepEqual(parsed, { ok: false, error: DELETE_UNAVAILABLE });
    assert.deepEqual(recorded.lookupTokens, []);
    assert.deepEqual(recorded.deletedIds, []);
  });

  it('삭제가 실패하면 503이다', async () => {
    const { response, parsed, recorded } = await run({
      removal: { data: null, error: { status: 500 } },
    });

    assert.equal(response.status, 503);
    assert.deepEqual(parsed, { ok: false, error: DELETE_UNAVAILABLE });
    // 시도는 했다. 그러나 성공이라고 말하지 않는다.
    assert.deepEqual(recorded.deletedIds, [ANON_USER_ID]);
  });

  it('삭제가 거절당해도 성공으로 바꾸지 않는다', async () => {
    const { response, parsed } = await run({
      removal: { data: null, error: { status: 404 } },
    });

    assert.equal(response.status, 503);
    assert.equal(parsed.ok, false);
    assert.equal('deleted' in parsed, false);
  });

  it('삭제 중 통신이 끊기면 503이다', async () => {
    const { response, parsed } = await run({
      removal: async () => {
        throw new Error('network down');
      },
    });

    assert.equal(response.status, 503);
    assert.deepEqual(parsed, { ok: false, error: DELETE_UNAVAILABLE });
  });
});

/* ================================================================== */
/* E. 메서드                                                            */
/* ================================================================== */

describe('delete-my-data · E. 메서드', () => {
  it('POST가 아니면 405이고 아무것도 부르지 않는다', async () => {
    for (const method of ['GET', 'PUT', 'PATCH', 'DELETE', 'HEAD']) {
      const { response, parsed, recorded } = await run({ method });

      assert.equal(response.status, 405, method);
      assert.deepEqual(parsed, { ok: false, error: DELETE_METHOD_NOT_ALLOWED }, method);
      assert.deepEqual(recorded.lookupTokens, [], method);
      assert.deepEqual(recorded.deletedIds, [], method);
    }
  });
});

/* ================================================================== */
/* F. 밖으로 새지 않는다                                                */
/* ================================================================== */

describe('delete-my-data · F. 밖으로 새지 않는다', () => {
  it('성공 응답에 사용자 번호와 토큰이 없다', async () => {
    const { text } = await run();

    assert.equal(text.includes(ANON_USER_ID), false);
    assert.equal(text.includes(USER_TOKEN), false);
  });

  it('실패 응답에 원본 오류가 섞이지 않는다', async () => {
    const { text } = await run({
      lookup: { data: null, error: { status: 500, message: 'internal gotrue detail' } },
    });

    assert.equal(text.includes('gotrue'), false);
    assert.equal(text.includes('internal'), false);
    assert.equal(text.includes(ANON_USER_ID), false);
  });

  it('로그에 사용자 번호와 토큰이 남지 않는다', async () => {
    for (const options of [
      {},
      { authorization: null },
      { lookup: { data: null, error: { status: 401 } } as GetUserResult },
      { lookup: { data: { user: { id: OTHER_USER_ID, is_anonymous: false } }, error: null } },
      { removal: { data: null, error: { status: 500 } } as DeleteUserResult },
    ] satisfies Options[]) {
      const { recorded } = await run(options);

      for (const line of recorded.logs) {
        assert.equal(line.includes(ANON_USER_ID), false, line);
        assert.equal(line.includes(OTHER_USER_ID), false, line);
        assert.equal(line.includes(USER_TOKEN), false, line);
      }
    }
  });

  it('응답에 CORS 머리말과 JSON 형식이 붙는다', async () => {
    const { response } = await run();

    assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
    assert.ok(response.headers.get('content-type')?.includes('application/json'));
  });
});

/* ================================================================== */
/* G. 작은 조각들                                                       */
/* ================================================================== */

describe('delete-my-data · G. 작은 조각들', () => {
  it('Bearer 토큰만 꺼낸다', () => {
    const make = (authorization?: string) =>
      new Request('https://example.test/', {
        method: 'POST',
        ...(authorization === undefined ? {} : { headers: { authorization } }),
      });

    assert.equal(readBearerToken(make(`Bearer ${USER_TOKEN}`)), USER_TOKEN);
    assert.equal(readBearerToken(make(`bearer ${USER_TOKEN}`)), USER_TOKEN);
    assert.equal(readBearerToken(make(`  Bearer   ${USER_TOKEN}  `)), USER_TOKEN);

    assert.equal(readBearerToken(make()), null);
    assert.equal(readBearerToken(make('Bearer')), null);
    assert.equal(readBearerToken(make('Basic abc')), null);
    assert.equal(readBearerToken(make(USER_TOKEN)), null);
  });

  it('허용 목록의 오류 코드만 분명한 거절로 읽는다', () => {
    assert.deepEqual([...AUTH_REJECTION_CODES], [
      'no_authorization',
      'bad_jwt',
      'session_expired',
      'session_not_found',
      'user_not_found',
    ]);

    for (const code of AUTH_REJECTION_CODES) {
      // 400번대 응답에 붙어 온 코드만 거절이다.
      for (const status of [400, 401, 403, 404, 422]) {
        assert.equal(isDefiniteAuthRejection({ status, code }), true, `${status} ${code}`);
      }
      // 서버 오류에 거절 코드가 붙어 온 모순된 답은 거절로 읽지 않는다.
      for (const status of [500, 502, 503]) {
        assert.equal(isDefiniteAuthRejection({ status, code }), false, `${status} ${code}`);
      }
      // 상태가 없거나 숫자가 아니면 코드만으로 판단하지 않는다.
      assert.equal(isDefiniteAuthRejection({ code }), false, code);
      assert.equal(isDefiniteAuthRejection({ status: '401', code }), false, code);
    }

    for (const error of [
      { status: 429, code: 'over_request_rate_limit' },
      { status: 408, code: 'request_timeout' },
      { status: 409, code: 'conflict' },
      { status: 404, code: null },
      { status: 401, code: null },
      { status: 400, code: 'unknown_future_code' },
      { status: 401, code: 401 },
      { status: 500 },
      { message: 'x' },
      null,
      undefined,
      'boom',
      new Error('boom'),
    ]) {
      assert.equal(isDefiniteAuthRejection(error), false, JSON.stringify(error));
    }
  });

  it('밖으로 나가는 코드는 넷뿐이다', () => {
    assert.deepEqual(
      [
        DELETE_METHOD_NOT_ALLOWED,
        DELETE_UNAUTHENTICATED,
        DELETE_NOT_ANONYMOUS,
        DELETE_UNAVAILABLE,
      ],
      [
        'DELETE_METHOD_NOT_ALLOWED',
        'DELETE_UNAUTHENTICATED',
        'DELETE_NOT_ANONYMOUS',
        'DELETE_UNAVAILABLE',
      ],
    );
  });
});

/* ================================================================== */
/* H. 바깥 연결 파일의 자격 분리                                        */
/* ================================================================== */

describe('delete-my-data · H. 바깥 연결 파일', () => {
  const index = stripComments(readFileSync(new URL('./index.ts', import.meta.url), 'utf8'));

  /*
   * 두 호출의 자격이 실제로 분리되어 있는지는 여기서 글자로 보지 않는다.
   * auth-admin.test.ts가 진짜 요청을 만들어 머리말을 확인한다.
   * 이 자리에는 그 방식으로 확인할 수 없는 것만 남긴다.
   */

  it('표에 직접 접근하지 않고 OpenAI도 부르지 않는다', () => {
    assert.equal(index.includes('/rest/v1/'), false);
    assert.equal(index.includes('openai'), false);
    assert.equal(index.includes('OPENAI'), false);
  });

  it('서버 전용 키는 서버 환경에서만 읽는다', () => {
    assert.ok(index.includes("Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')"));
    // 키를 응답이나 로그로 내보내는 자리를 만들지 않았다.
    assert.equal(/log\([^)]*SERVICE_ROLE_KEY/.test(index), false);
    assert.equal(/jsonResponse\([^)]*SERVICE_ROLE_KEY/.test(index), false);
  });
});
