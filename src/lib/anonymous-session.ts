/**
 * 익명 세션 준비
 *
 * 아뢰다는 사용자에게 로그인 화면을 보여주지 않는다.
 * 대신 익명 세션 하나를 만들어 두고, 앱을 다시 열면 그 세션을 이어 쓴다.
 *
 * 규칙:
 *   - 앱을 열 때마다 새 익명 사용자를 만들지 않는다.
 *   - 반드시 기존 세션을 먼저 확인하고, 없을 때만 새로 만든다.
 *   - 토큰, 세션 전체, 사용자 id는 로그나 화면에 남기지 않는다.
 *
 * 이 파일은 Supabase 클라이언트를 직접 불러오지 않는다.
 * 필요한 부분만 인자로 받기 때문에 실제 서버 없이도 테스트할 수 있다.
 */

/** 세션에서 이 파일이 보는 부분만 정의한다. */
export type SessionLike = {
  user?: { id?: string; is_anonymous?: boolean } | null;
} | null;

export type AuthLike = {
  getSession(): Promise<{ data: { session: SessionLike }; error: unknown }>;
  signInAnonymously(): Promise<{ data: { session: SessionLike }; error: unknown }>;
};

/** 화면과 로그에 쓸 수 있는 요약. 토큰과 사용자 id는 들어가지 않는다. */
export type SessionSummary = {
  sessionExists: boolean;
  isAnonymous: boolean;
  /** created: 이번에 새로 만듦 / restored: 저장돼 있던 세션을 이어 씀 / failed: 준비하지 못함 */
  source: 'created' | 'restored' | 'failed';
  /** 실패했을 때만 채운다. Supabase 원본 메시지가 아니라 종류만 남긴다. */
  errorName?: string;
};

const isAnonymousSession = (session: SessionLike) => session?.user?.is_anonymous === true;

const errorNameOf = (error: unknown) => {
  if (error && typeof error === 'object' && 'name' in error) {
    const name = (error as { name?: unknown }).name;
    if (typeof name === 'string' && name.length > 0) return name;
  }
  return 'AuthError';
};

/**
 * 익명 세션을 준비한다.
 * 이미 세션이 있으면 그대로 쓰고, 없을 때만 새 익명 사용자를 만든다.
 * 어떤 경우에도 예외를 밖으로 던지지 않는다. 앱이 멈추지 않게 하기 위해서다.
 */
export async function ensureAnonymousSession(auth: AuthLike): Promise<SessionSummary> {
  try {
    const existing = await auth.getSession();

    if (!existing.error && existing.data?.session) {
      return {
        sessionExists: true,
        isAnonymous: isAnonymousSession(existing.data.session),
        source: 'restored',
      };
    }

    const created = await auth.signInAnonymously();

    if (created.error || !created.data?.session) {
      return {
        sessionExists: false,
        isAnonymous: false,
        source: 'failed',
        errorName: created.error ? errorNameOf(created.error) : 'NoSessionReturned',
      };
    }

    return {
      sessionExists: true,
      isAnonymous: isAnonymousSession(created.data.session),
      source: 'created',
    };
  } catch (error) {
    return {
      sessionExists: false,
      isAnonymous: false,
      source: 'failed',
      errorName: errorNameOf(error),
    };
  }
}
