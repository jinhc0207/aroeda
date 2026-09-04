/**
 * 익명 세션 준비 테스트
 *
 * 실행: npm test
 *
 * 실제 Supabase를 부르지 않는다. 가짜 auth 객체로 동작만 확인한다.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ensureAnonymousSession, type AuthLike, type SessionLike } from './anonymous-session.ts';

type Calls = { getSession: number; signInAnonymously: number };

const anonymousSession = (id = 'user-id-should-not-leak'): SessionLike => ({
  user: { id, is_anonymous: true },
});

function fakeAuth(options: {
  existing?: SessionLike;
  existingError?: unknown;
  created?: SessionLike;
  createError?: unknown;
  throwOnGetSession?: boolean;
}): { auth: AuthLike; calls: Calls } {
  const calls: Calls = { getSession: 0, signInAnonymously: 0 };

  const auth: AuthLike = {
    async getSession() {
      calls.getSession += 1;
      if (options.throwOnGetSession) throw Object.assign(new Error('network down'), { name: 'AuthRetryableFetchError' });
      return { data: { session: options.existing ?? null }, error: options.existingError ?? null };
    },
    async signInAnonymously() {
      calls.signInAnonymously += 1;
      const created = 'created' in options ? options.created : anonymousSession();
      return {
        data: { session: options.createError ? null : (created ?? null) },
        error: options.createError ?? null,
      };
    },
  };

  return { auth, calls };
}

describe('익명 세션 준비', () => {
  it('기존 세션이 있으면 새 익명 사용자를 만들지 않는다', async () => {
    const { auth, calls } = fakeAuth({ existing: anonymousSession() });
    const summary = await ensureAnonymousSession(auth);

    assert.equal(calls.signInAnonymously, 0, '새 익명 로그인을 호출했습니다.');
    assert.equal(calls.getSession, 1);
    assert.deepEqual(summary, { sessionExists: true, isAnonymous: true, source: 'restored' });
  });

  it('세션이 없으면 익명 로그인을 한 번만 한다', async () => {
    const { auth, calls } = fakeAuth({ existing: null });
    const summary = await ensureAnonymousSession(auth);

    assert.equal(calls.signInAnonymously, 1);
    assert.deepEqual(summary, { sessionExists: true, isAnonymous: true, source: 'created' });
  });

  it('익명이 아닌 기존 세션도 그대로 이어 쓴다', async () => {
    const { auth, calls } = fakeAuth({ existing: { user: { id: 'x', is_anonymous: false } } });
    const summary = await ensureAnonymousSession(auth);

    assert.equal(calls.signInAnonymously, 0);
    assert.equal(summary.source, 'restored');
    assert.equal(summary.isAnonymous, false);
  });

  it('익명 로그인이 실패해도 오류를 던지지 않는다', async () => {
    const { auth } = fakeAuth({
      existing: null,
      createError: Object.assign(new Error('anonymous sign-ins are disabled'), { name: 'AuthApiError' }),
    });
    const summary = await ensureAnonymousSession(auth);

    assert.deepEqual(summary, {
      sessionExists: false,
      isAnonymous: false,
      source: 'failed',
      errorName: 'AuthApiError',
    });
  });

  it('세션이 돌아오지 않아도 안전하게 처리한다', async () => {
    const { auth } = fakeAuth({ existing: null, created: null });
    const summary = await ensureAnonymousSession(auth);

    assert.equal(summary.source, 'failed');
    assert.equal(summary.sessionExists, false);
    assert.equal(summary.errorName, 'NoSessionReturned');
  });

  it('네트워크 오류로 예외가 나도 앱이 멈추지 않는다', async () => {
    const { auth } = fakeAuth({ throwOnGetSession: true });
    const summary = await ensureAnonymousSession(auth);

    assert.equal(summary.source, 'failed');
    assert.equal(summary.errorName, 'AuthRetryableFetchError');
  });

  it('요약에 토큰이나 사용자 id가 들어가지 않는다', async () => {
    const sessionWithTokens = {
      access_token: 'access-token-secret',
      refresh_token: 'refresh-token-secret',
      user: { id: 'uuid-should-not-leak', is_anonymous: true },
    } as SessionLike;

    for (const options of [{ existing: sessionWithTokens }, { existing: null, created: sessionWithTokens }]) {
      const { auth } = fakeAuth(options);
      const summary = await ensureAnonymousSession(auth);
      const text = JSON.stringify(summary);

      assert.equal(text.includes('access-token-secret'), false);
      assert.equal(text.includes('refresh-token-secret'), false);
      assert.equal(text.includes('uuid-should-not-leak'), false);
      assert.deepEqual(Object.keys(summary).sort(), ['isAnonymous', 'sessionExists', 'source']);
    }
  });
});
