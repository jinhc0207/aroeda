/**
 * delete-my-data · Auth 서버로 나가는 두 연결
 *
 * 이 파일이 하는 일은 두 가지뿐이다.
 *   이 토큰이 누구인지 묻기, 그리고 그 사람을 지우기.
 * 무엇을 지울지 판단하지 않는다. 그 판단은 handler.ts에 있다.
 *
 * 두 호출의 자격이 서로 다르다. 이것이 이 파일에서 가장 중요한 규칙이다.
 *   신원 확인 — 이용자의 Bearer 토큰으로 부른다. "이 토큰이 누구냐"를 묻는 것이므로 그렇다.
 *   사용자 삭제 — 서버 전용 키로만 부른다. 이용자의 토큰을 실을 자리를 만들지 않았다.
 *
 * 시간 제한은 응답이 끝날 때까지 걸어 둔다.
 *   머리말만 도착하고 본문이 멈추는 경우가 있다.
 *   머리말을 받은 순간 시계를 끄면 그 뒤로는 아무도 기다림을 끊지 못한다.
 *   그래서 본문을 읽고 해석하는 데까지 같은 시계를 유지한다.
 *   자동 재시도는 하지 않는다.
 *
 * 오류에서 꺼내는 값은 기계가 읽는 코드 하나뿐이다.
 *   사람에게 보여주는 설명 문구(msg, error_description)는 읽지 않는다.
 *   그 안에 무엇이 적혀 있을지 우리가 정하지 않기 때문이다.
 *
 * 바깥 연결(fetch)과 시계를 인자로 받는다. 그래서 실제 네트워크 없이 시험할 수 있다.
 */

import type { AdminUser, AuthCallError, DeleteUserResult, GetUserResult } from './handler.ts';

export type AuthAdminConfig = {
  /** Supabase 프로젝트 URL */
  url: string;
  /** 서버 전용 키. 관리자 호출과 apikey 머리말에만 쓴다. */
  serviceRoleKey: string;
  /** 호출 하나에 거는 시간. 본문을 다 읽을 때까지 유지된다. */
  timeoutMs: number;
  fetchImpl: typeof fetch;
  /**
   * 시간이 다 됐을 때 알려 주는 장치. 취소하는 함수를 돌려준다.
   * 실제 실행에서는 setTimeout을 쓰고, 시험에서만 바꿔 넣는다.
   */
  schedule: (onTimeout: () => void, ms: number) => () => void;
};

export type AuthAdmin = {
  getUserByToken: (accessToken: string) => Promise<GetUserResult>;
  deleteUser: (userId: string) => Promise<DeleteUserResult>;
};

/**
 * 응답 하나를 끝까지 읽는 동안 시계를 유지한다.
 *
 * run 안에서 fetch와 본문 읽기를 모두 한다.
 * 시계가 울리면 signal이 끊기고, 진행 중이던 본문 읽기도 함께 끊긴다.
 * 성공하든 실패하든 finally에서 시계를 반드시 끈다.
 */
async function withDeadline<T>(
  config: AuthAdminConfig,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const cancel = config.schedule(() => controller.abort(), config.timeoutMs);
  try {
    return await run(controller.signal);
  } finally {
    cancel();
  }
}

/**
 * 실패한 응답에서 기계가 읽는 오류 코드만 꺼낸다.
 *
 * 본문을 읽지 못하면 코드를 모르는 것이다. 모르는 것을 아는 척하지 않고 null로 둔다.
 * handler는 코드가 허용 목록에 있을 때만 인증 거절로 읽는다.
 */
async function readAuthError(response: Response): Promise<AuthCallError> {
  let code: string | null = null;

  try {
    const body: unknown = await response.json();
    if (typeof body === 'object' && body !== null) {
      const { error_code: errorCode, code: legacyCode } = body as {
        error_code?: unknown;
        code?: unknown;
      };
      // 설명 문구(msg, error_description)는 읽지 않는다.
      if (typeof errorCode === 'string' && errorCode.length > 0) code = errorCode;
      else if (typeof legacyCode === 'string' && legacyCode.length > 0) code = legacyCode;
    }
  } catch {
    // 본문이 없거나 JSON이 아니다. 코드를 모른 채로 둔다.
  }

  return { status: response.status, code };
}

/** 실제 Auth 서버로 나가는 두 연결을 만든다. */
export function createAuthAdmin(config: AuthAdminConfig): AuthAdmin {
  return {
    /**
     * 이 토큰이 지금 누구인지 Auth 서버에 묻는다.
     *
     * 이용자의 토큰으로 부른다. 서명·만료와 "그 사용자가 아직 있는가"를 서버가 함께 판단한다.
     * 여기서 토큰을 뜯어보지 않는다.
     */
    getUserByToken: (accessToken: string) =>
      withDeadline(config, async (signal): Promise<GetUserResult> => {
        const response = await config.fetchImpl(`${config.url}/auth/v1/user`, {
          method: 'GET',
          headers: {
            authorization: `Bearer ${accessToken}`,
            apikey: config.serviceRoleKey,
          },
          signal,
        });

        if (!response.ok) return { data: null, error: await readAuthError(response) };

        try {
          // 모양을 여기서 판단하지 않는다. handler가 id와 is_anonymous를 직접 확인한다.
          const user = (await response.json()) as AdminUser;
          return { data: { user }, error: null };
        } catch {
          // 200인데 본문을 읽지 못했다. 누구인지 확인하지 못한 것이므로 성공이 아니다.
          return { data: null, error: null };
        }
      }),

    /**
     * 사용자를 지운다.
     *
     * 서버 전용 키로만 부른다. 이 함수는 이용자의 토큰을 받지 않는다.
     * 사용자 번호는 handler가 Auth 서버 답에서 얻은 값이며, 요청 본문에서 온 값이 아니다.
     */
    deleteUser: (userId: string) =>
      withDeadline(config, async (signal): Promise<DeleteUserResult> => {
        const response = await config.fetchImpl(
          `${config.url}/auth/v1/admin/users/${encodeURIComponent(userId)}`,
          {
            method: 'DELETE',
            headers: {
              authorization: `Bearer ${config.serviceRoleKey}`,
              apikey: config.serviceRoleKey,
            },
            signal,
          },
        );

        if (!response.ok) return { data: null, error: await readAuthError(response) };
        return { data: null, error: null };
      }),
  };
}
