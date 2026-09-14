/**
 * 내 정보 삭제 · 판단과 연결 계약 테스트
 *
 * 실행: npm test
 *
 * 되돌릴 수 없는 일을 앱이 시작하는 자리다. 세 가지를 가장 무겁게 본다.
 *
 *   1. 무엇을 성공이라 부르는가.
 *      2xx와 { ok: true, deleted: true }가 함께 왔을 때만이다.
 *   2. 이 기기의 로그인 정보를 언제 지우는가.
 *      서버가 삭제를 확인한 뒤에만. 실패·확인 불가에서는 절대 지우지 않는다.
 *   3. 정리가 끝났다는 것을 어떻게 아는가.
 *      정리 함수가 끝났다는 것으로는 부족하다. 다시 읽어서 남아 있지 않은지 본다.
 *
 * 실제 네트워크를 쓰지 않는다. Supabase 클라이언트는 가짜로 바꿔 넣는다.
 * 실제 사용자를 지우지 않는다.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DELETE_MY_DATA_FUNCTION,
  DELETE_REQUEST_TIMEOUT_MS,
  classifyDeleteResponse,
  createSupabaseDeletionDeps,
  requestDataDeletion,
  retryLocalCleanup,
  type DeleteResponse,
  type DeletionClient,
  type DeletionDeps,
  type LocalSessionState,
} from './request-account-deletion.ts';

const FAKE_UID = '11111111-2222-3333-4444-555555555555';
const FAKE_TOKEN = 'TEST_ACCESS_TOKEN_SHOULD_NEVER_LEAK';
const SESSION = { access_token: FAKE_TOKEN, user: { id: FAKE_UID, is_anonymous: true } };

const response = (status: number, body: unknown): DeleteResponse => ({
  kind: 'response',
  status,
  body,
});
const DELETED = { ok: true, deleted: true };

/* ================================================================== */
/* A. 서버 답 판정                                                      */
/* ================================================================== */

describe('내 정보 삭제 · A. 서버 답 판정', () => {
  it('2xx와 { ok: true, deleted: true }가 함께일 때만 삭제 확인이다', () => {
    assert.equal(classifyDeleteResponse(response(200, DELETED)), 'deleted');
    assert.equal(classifyDeleteResponse(response(204, DELETED)), 'deleted');
  });

  it('2xx라도 약속과 다른 본문은 확인 불가다', () => {
    for (const body of [
      null,
      undefined,
      'ok',
      [],
      {},
      { ok: true },
      { deleted: true },
      { ok: true, deleted: false },
      { ok: 'true', deleted: true },
      { ok: true, deleted: 'true' },
      { ok: false, deleted: true },
    ]) {
      assert.equal(classifyDeleteResponse(response(200, body)), 'unconfirmed', JSON.stringify(body));
    }
  });

  it('2xx가 아니면 본문이 무엇이든 성공이 아니다', () => {
    for (const status of [301, 400, 401, 404, 405, 409, 429, 500, 502, 503, 504]) {
      assert.equal(classifyDeleteResponse(response(status, DELETED)), 'unconfirmed', String(status));
    }
  });

  it('403과 DELETE_NOT_ANONYMOUS가 함께일 때만 익명 아님이다', () => {
    assert.equal(
      classifyDeleteResponse(response(403, { ok: false, error: 'DELETE_NOT_ANONYMOUS' })),
      'not-anonymous',
    );
    for (const body of [null, {}, { error: 'DELETE_NOT_ANONYMOUS' }, { ok: false, error: 'X' }]) {
      assert.equal(classifyDeleteResponse(response(403, body)), 'unconfirmed', JSON.stringify(body));
    }
    // 다른 상태에 같은 코드가 붙어 와도 익명 아님으로 읽지 않는다.
    assert.equal(
      classifyDeleteResponse(response(401, { ok: false, error: 'DELETE_NOT_ANONYMOUS' })),
      'unconfirmed',
    );
  });

  it('응답을 받지 못하면 확인 불가다', () => {
    assert.equal(classifyDeleteResponse({ kind: 'no-response' }), 'unconfirmed');
  });
});

/* ================================================================== */
/* B. 흐름의 순서                                                       */
/* ================================================================== */

type Step = 'readLocalSession' | 'invoke' | 'clearAppState' | 'clearLocalAuth';

function recordingDeps(options: {
  session?: LocalSessionState | 'throws';
  invoke?: DeleteResponse | 'throws';
  clearAppState?: 'ok' | 'throws';
  clearLocalAuth?: 'cleared' | 'remains' | 'throws';
}) {
  const steps: Step[] = [];
  const deps: DeletionDeps = {
    readLocalSession: async () => {
      steps.push('readLocalSession');
      if (options.session === 'throws') throw new Error('storage');
      return options.session ?? 'present';
    },
    invokeDeleteMyData: async () => {
      steps.push('invoke');
      if (options.invoke === 'throws') throw new Error('network');
      return options.invoke ?? response(200, DELETED);
    },
    clearAppState: () => {
      steps.push('clearAppState');
      if (options.clearAppState === 'throws') throw new Error('state');
    },
    clearLocalAuth: async () => {
      steps.push('clearLocalAuth');
      if (options.clearLocalAuth === 'throws') throw new Error('signout');
      return options.clearLocalAuth ?? 'cleared';
    },
  };
  return { deps, steps };
}

describe('내 정보 삭제 · B. 흐름의 순서', () => {
  it('서버 확인 뒤에만 앱 상태와 로그인 정보를 정리한다', async () => {
    const { deps, steps } = recordingDeps({});

    assert.equal(await requestDataDeletion(deps), 'deleted');
    assert.deepEqual(steps, ['readLocalSession', 'invoke', 'clearAppState', 'clearLocalAuth']);
  });

  it('로그인 정보가 없으면 서버에 묻지도, 아무것도 지우지도 않는다', async () => {
    const { deps, steps } = recordingDeps({ session: 'absent' });

    assert.equal(await requestDataDeletion(deps), 'no-local-session');
    assert.deepEqual(steps, ['readLocalSession']);
  });

  it('로그인 정보를 읽지 못한 것은 "없음"과 구분한다', async () => {
    for (const session of ['unreadable', 'throws'] as const) {
      const { deps, steps } = recordingDeps({ session });

      assert.equal(await requestDataDeletion(deps), 'local-session-unreadable', session);
      assert.deepEqual(steps, ['readLocalSession'], session);
    }
  });

  it('성공이 아닌 모든 답에서 이 기기의 정리를 하지 않는다', async () => {
    const cases: Array<[DeleteResponse | 'throws', string]> = [
      [response(401, { ok: false, error: 'DELETE_UNAUTHENTICATED' }), 'unconfirmed'],
      [response(403, { ok: false, error: 'DELETE_NOT_ANONYMOUS' }), 'not-anonymous'],
      [response(403, null), 'unconfirmed'],
      [response(405, { ok: false, error: 'DELETE_METHOD_NOT_ALLOWED' }), 'unconfirmed'],
      [response(503, { ok: false, error: 'DELETE_UNAVAILABLE' }), 'unconfirmed'],
      [response(200, { ok: true }), 'unconfirmed'],
      [response(200, 'not json'), 'unconfirmed'],
      [{ kind: 'no-response' }, 'unconfirmed'],
      ['throws', 'unconfirmed'],
    ];

    for (const [invoke, expected] of cases) {
      const { deps, steps } = recordingDeps({ invoke });

      assert.equal(await requestDataDeletion(deps), expected, JSON.stringify(invoke));
      assert.deepEqual(steps, ['readLocalSession', 'invoke'], JSON.stringify(invoke));
    }
  });

  it('한 번의 삭제는 서버 요청 한 번이다', async () => {
    const { deps, steps } = recordingDeps({ clearLocalAuth: 'remains' });

    await requestDataDeletion(deps);

    assert.equal(steps.filter((step) => step === 'invoke').length, 1);
  });

  it('로그인 정보가 남으면 정리 실패로 구분한다', async () => {
    for (const clearLocalAuth of ['remains', 'throws'] as const) {
      const { deps } = recordingDeps({ clearLocalAuth });
      assert.equal(await requestDataDeletion(deps), 'deleted-local-cleanup-failed', clearLocalAuth);
    }
  });

  it('앱 상태 비우기가 실패해도 로그인 정리는 시도하고, 성공이라 하지 않는다', async () => {
    const { deps, steps } = recordingDeps({ clearAppState: 'throws' });

    assert.equal(await requestDataDeletion(deps), 'deleted-local-cleanup-failed');
    assert.ok(steps.includes('clearLocalAuth'));
  });

  it('정리 재시도는 서버에 삭제를 다시 요청하지 않는다', async () => {
    const { deps, steps } = recordingDeps({});

    assert.equal(await retryLocalCleanup(deps), 'deleted');
    assert.deepEqual(steps, ['clearAppState', 'clearLocalAuth']);

    const failing = recordingDeps({ clearLocalAuth: 'remains' });
    assert.equal(await retryLocalCleanup(failing.deps), 'deleted-local-cleanup-failed');
    assert.equal(failing.steps.includes('invoke'), false);
  });
});

/* ================================================================== */
/* C. Supabase 연결                                                     */
/* ================================================================== */

type ClientCall = 'getSession' | 'invoke' | 'signOut' | 'signInAnonymously';

type FakeOptions = {
  /** getSession을 부를 때마다 차례로 돌려줄 답. 마지막 것을 계속 쓴다. */
  sessions?: Array<{ data: unknown; error: unknown } | 'throws'>;
  invoke?: () => Promise<{ data: unknown; error: unknown; response?: unknown }>;
  signOut?: () => Promise<{ error: unknown }>;
};

function fakeClient(options: FakeOptions = {}) {
  const calls: ClientCall[] = [];
  const invokeArgs: unknown[][] = [];
  const signOutArgs: unknown[] = [];
  const sessions = options.sessions ?? [{ data: { session: SESSION }, error: null }];
  let sessionIndex = 0;

  const client = {
    auth: {
      getSession: async () => {
        calls.push('getSession');
        const next = sessions[Math.min(sessionIndex, sessions.length - 1)];
        sessionIndex += 1;
        if (next === 'throws') throw new Error('storage');
        return next as { data: { session: unknown } | null; error: unknown };
      },
      signOut: async (arg: { scope: 'local' }) => {
        calls.push('signOut');
        signOutArgs.push(arg);
        return options.signOut ? options.signOut() : { error: null };
      },
      // 삭제 흐름은 이것을 부르면 안 된다. 불리는지 지켜보려고 둔다.
      signInAnonymously: async () => {
        calls.push('signInAnonymously');
        return { data: { session: SESSION }, error: null };
      },
    },
    functions: {
      invoke: async (...args: unknown[]) => {
        calls.push('invoke');
        invokeArgs.push(args);
        return options.invoke
          ? options.invoke()
          : { data: DELETED, error: null, response: { status: 200 } };
      },
    },
  };

  return { client: client as unknown as DeletionClient, calls, invokeArgs, signOutArgs };
}

const httpError = (status: number, json?: () => Promise<unknown>) => ({
  data: null,
  error: {
    name: 'FunctionsHttpError',
    context: { status, json: json ?? (async () => ({})) },
  },
});

describe('내 정보 삭제 · C. 로그인 정보 읽기', () => {
  const read = async (sessions: FakeOptions['sessions']) =>
    createSupabaseDeletionDeps(fakeClient({ sessions }).client, () => {}).readLocalSession();

  it('세션이 있으면 present, 정확히 null이면 absent', async () => {
    assert.equal(await read([{ data: { session: SESSION }, error: null }]), 'present');
    assert.equal(await read([{ data: { session: null }, error: null }]), 'absent');
  });

  it('오류·예외·예상 밖 모양은 없다고 추정하지 않는다', async () => {
    assert.equal(await read([{ data: { session: null }, error: { name: 'AuthError' } }]), 'unreadable');
    assert.equal(await read(['throws']), 'unreadable');
    assert.equal(await read([{ data: null, error: null }]), 'unreadable');
    assert.equal(await read([{ data: {}, error: null }]), 'unreadable');
    assert.equal(await read([{ data: { session: 'x' }, error: null }]), 'unreadable');
  });
});

describe('내 정보 삭제 · C. 서버 호출', () => {
  it('delete-my-data를 POST로, 시간 제한을 걸어, 본문 없이 부른다', async () => {
    const fake = fakeClient();

    await createSupabaseDeletionDeps(fake.client, () => {}).invokeDeleteMyData();

    assert.equal(fake.invokeArgs.length, 1);
    const [name, options] = fake.invokeArgs[0] as [string, Record<string, unknown>];
    assert.equal(name, DELETE_MY_DATA_FUNCTION);
    assert.equal(name, 'delete-my-data');
    assert.deepEqual(options, { method: 'POST', timeout: DELETE_REQUEST_TIMEOUT_MS });
    // 사용자 번호를 실어 보내지 않는다. 서버는 토큰으로만 판단한다.
    assert.equal('body' in options, false);
  });

  it('2xx 응답은 상태와 본문을 그대로 넘긴다', async () => {
    const fake = fakeClient();
    const result = await createSupabaseDeletionDeps(fake.client, () => {}).invokeDeleteMyData();

    assert.deepEqual(result, { kind: 'response', status: 200, body: DELETED });
  });

  it('오류가 없어도 상태 숫자를 확인할 수 없으면 응답을 받지 못한 것으로 둔다', async () => {
    const fake = fakeClient({ invoke: async () => ({ data: DELETED, error: null }) });
    const result = await createSupabaseDeletionDeps(fake.client, () => {}).invokeDeleteMyData();

    assert.deepEqual(result, { kind: 'no-response' });
  });

  it('403이 아닌 오류 응답은 본문을 읽지 않는다', async () => {
    for (const status of [401, 405, 500, 503]) {
      let read = 0;
      const fake = fakeClient({
        invoke: async () =>
          httpError(status, async () => {
            read += 1;
            return DELETED;
          }),
      });
      const result = await createSupabaseDeletionDeps(fake.client, () => {}).invokeDeleteMyData();

      assert.deepEqual(result, { kind: 'response', status, body: null }, String(status));
      assert.equal(read, 0, String(status));
    }
  });

  it('403은 본문을 읽어 익명 아님인지 확인한다', async () => {
    const fake = fakeClient({
      invoke: async () => httpError(403, async () => ({ ok: false, error: 'DELETE_NOT_ANONYMOUS' })),
    });
    const result = await createSupabaseDeletionDeps(fake.client, () => {}).invokeDeleteMyData();

    assert.deepEqual(result, {
      kind: 'response',
      status: 403,
      body: { ok: false, error: 'DELETE_NOT_ANONYMOUS' },
    });
  });

  it('403 본문을 읽지 못하면 null이다', async () => {
    const fake = fakeClient({
      invoke: async () =>
        httpError(403, async () => {
          throw new SyntaxError('not json');
        }),
    });
    const result = await createSupabaseDeletionDeps(fake.client, () => {}).invokeDeleteMyData();

    assert.deepEqual(result, { kind: 'response', status: 403, body: null });
  });

  it('403 본문이 멈추면 시간이 다 됐을 때 null로 끝난다', async () => {
    let fire: (() => void) | null = null;
    let cancelled = 0;
    const fake = fakeClient({
      invoke: async () => httpError(403, () => new Promise(() => {})),
    });
    const deps = createSupabaseDeletionDeps(fake.client, () => {}, {
      schedule: (onTimeout) => {
        fire = onTimeout;
        return () => {
          cancelled += 1;
        };
      },
    });

    const pending = deps.invokeDeleteMyData();
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(fire, '본문을 기다리는 동안 시계가 걸려 있어야 합니다.');

    (fire as unknown as () => void)();
    assert.deepEqual(await pending, { kind: 'response', status: 403, body: null });
    assert.equal(cancelled, 1);
  });

  it('요청을 보내지 못했거나 중계가 실패하면 응답을 받지 못한 것이다', async () => {
    for (const error of [
      { name: 'FunctionsFetchError', context: new Error('aborted') },
      { name: 'FunctionsRelayError', context: { status: 502, json: async () => DELETED } },
      { name: 'SomethingElse' },
      { message: 'boom' },
    ]) {
      const fake = fakeClient({ invoke: async () => ({ data: null, error }) });
      const result = await createSupabaseDeletionDeps(fake.client, () => {}).invokeDeleteMyData();

      assert.deepEqual(result, { kind: 'no-response' }, JSON.stringify(error));
    }
  });
});

describe('내 정보 삭제 · C. 이 기기의 로그인 정보 정리', () => {
  const clear = async (options: FakeOptions) => {
    const fake = fakeClient(options);
    const result = await createSupabaseDeletionDeps(fake.client, () => {}).clearLocalAuth();
    return { result, fake };
  };

  it('이 기기의 로그인 정보만 정리한다', async () => {
    const { fake } = await clear({ sessions: [{ data: { session: null }, error: null }] });

    assert.deepEqual(fake.signOutArgs, [{ scope: 'local' }]);
  });

  it('정리 뒤 다시 읽어서 없을 때만 cleared다', async () => {
    const { result, fake } = await clear({ sessions: [{ data: { session: null }, error: null }] });

    assert.equal(result, 'cleared');
    assert.deepEqual(fake.calls, ['signOut', 'getSession']);
  });

  it('signOut이 오류 없이 끝나도 로그인 정보가 남아 있으면 remains다', async () => {
    const { result } = await clear({ sessions: [{ data: { session: SESSION }, error: null }] });

    assert.equal(result, 'remains');
  });

  it('signOut의 오류 반환과 예외만으로 판단하지 않는다', async () => {
    // SDK는 지운 뒤에도 오류를 돌려줄 수 있다.
    assert.equal(
      (
        await clear({
          signOut: async () => ({ error: { name: 'AuthRetryableFetchError' } }),
          sessions: [{ data: { session: null }, error: null }],
        })
      ).result,
      'cleared',
    );
    // 로그인 정보를 읽다 막히면 지우지 않은 채 오류를 돌려주기도 한다.
    assert.equal(
      (
        await clear({
          signOut: async () => ({ error: { name: 'AuthApiError' } }),
          sessions: [{ data: { session: SESSION }, error: null }],
        })
      ).result,
      'remains',
    );
    // 예외를 던져도 확인한 결과로 판단한다.
    for (const [session, expected] of [
      [null, 'cleared'],
      [SESSION, 'remains'],
    ] as const) {
      const { result } = await clear({
        signOut: async () => {
          throw new Error('storage');
        },
        sessions: [{ data: { session }, error: null }],
      });
      assert.equal(result, expected);
    }
  });

  it('다시 읽기가 실패하면 정리됐다고 하지 않는다', async () => {
    for (const next of [
      { data: { session: null }, error: { name: 'AuthError' } },
      'throws' as const,
      { data: null, error: null },
    ]) {
      const { result } = await clear({ sessions: [next] });
      assert.equal(result, 'remains', JSON.stringify(next));
    }
  });
});

describe('내 정보 삭제 · C. 연결을 이어서', () => {
  const run = async (options: FakeOptions) => {
    const fake = fakeClient(options);
    let appCleared = 0;
    const result = await requestDataDeletion(
      createSupabaseDeletionDeps(fake.client, () => {
        appCleared += 1;
      }),
    );
    return { result, fake, appCleared };
  };

  it('성공하면 호출 순서가 읽기 → 삭제 요청 → 정리 → 확인이다', async () => {
    const { result, fake, appCleared } = await run({
      sessions: [
        { data: { session: SESSION }, error: null },
        { data: { session: null }, error: null },
      ],
    });

    assert.equal(result, 'deleted');
    assert.deepEqual(fake.calls, ['getSession', 'invoke', 'signOut', 'getSession']);
    assert.equal(appCleared, 1);
  });

  it('실패하면 signOut을 부르지 않고 앱 상태도 비우지 않는다', async () => {
    for (const invoke of [
      async () => httpError(401),
      async () => httpError(503),
      async () => httpError(403, async () => ({ ok: false, error: 'DELETE_NOT_ANONYMOUS' })),
      async () => ({ data: { ok: true }, error: null, response: { status: 200 } }),
      async () => ({ data: null, error: { name: 'FunctionsFetchError' } }),
      async () => {
        throw new Error('network');
      },
    ]) {
      const { fake, appCleared } = await run({ invoke });

      assert.equal(fake.calls.includes('signOut'), false);
      assert.equal(appCleared, 0);
    }
  });

  it('어떤 경우에도 새 익명 이용자를 만들지 않는다', async () => {
    for (const options of [
      {},
      { sessions: [{ data: { session: null }, error: null }] },
      { invoke: async () => httpError(401) },
      { signOut: async () => ({ error: { name: 'AuthApiError' } }) },
    ] satisfies FakeOptions[]) {
      const { fake } = await run(options);
      assert.equal(fake.calls.includes('signInAnonymously'), false);
    }
  });

  it('결과에 사용자 번호와 토큰이 담기지 않는다', async () => {
    const { result } = await run({});
    assert.equal(JSON.stringify(result).includes(FAKE_UID), false);
    assert.equal(JSON.stringify(result).includes(FAKE_TOKEN), false);
  });
});
