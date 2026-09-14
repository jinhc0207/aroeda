/**
 * delete-my-data · 요청 처리 본체
 *
 * 이용자가 자기 정보를 지워 달라고 할 때 불린다.
 *
 * 무엇을 지우는가:
 *   Supabase 익명 사용자 한 명.
 *   그 사용자의 사용량 기록(private.openai_rate_limit_state)은
 *   외래키(on delete cascade)를 타고 함께 사라진다. 여기서 따로 지우지 않는다.
 *
 * 누구를 지우는가 — 부르는 쪽을 믿지 않는다:
 *   요청 본문을 읽지 않는다. 본문에 적힌 사용자 번호로는 아무것도 지우지 않는다.
 *   JWT를 이 파일에서 뜯어 sub를 꺼내 쓰지도 않는다.
 *   Auth 서버에 토큰을 보내 "지금 이 토큰이 누구냐"를 물어보고,
 *   그 답으로 돌아온 번호로만 지운다.
 *
 * 익명 사용자만 지운다:
 *   Auth 서버가 확인해 준 사용자가 익명이 아니면 지우지 않는다.
 *   이 기능은 앱을 쓰는 익명 이용자를 위한 것이고,
 *   운영자 계정 같은 일반 계정을 지우는 통로가 되면 안 된다.
 *
 * 성공은 확인된 성공뿐이다:
 *   관리자 삭제가 성공했다고 답한 경우에만 200을 돌려준다.
 *   "지울 사람이 없었다"를 성공으로 바꾸지 않는다.
 *   확인하지 못한 것은 실패로 돌려보내 다시 시도할 수 있게 둔다.
 *
 * 밖으로 나가는 값에 사용자 번호, 토큰, Auth 서버 원본 오류를 담지 않는다.
 */

import { corsHeaders } from '../_shared/cors.ts';

/** 밖으로 나가는 실패 코드. 이 셋뿐이다. */
export const DELETE_METHOD_NOT_ALLOWED = 'DELETE_METHOD_NOT_ALLOWED';
export const DELETE_UNAUTHENTICATED = 'DELETE_UNAUTHENTICATED';
export const DELETE_NOT_ANONYMOUS = 'DELETE_NOT_ANONYMOUS';
export const DELETE_UNAVAILABLE = 'DELETE_UNAVAILABLE';

export type DeleteMyDataErrorCode =
  | typeof DELETE_METHOD_NOT_ALLOWED
  | typeof DELETE_UNAUTHENTICATED
  | typeof DELETE_NOT_ANONYMOUS
  | typeof DELETE_UNAVAILABLE;

export type DeleteMyDataErrorBody = { ok: false; error: DeleteMyDataErrorCode };
export type DeleteMyDataSuccessBody = { ok: true; deleted: true };

/**
 * Auth 서버가 돌려준 사용자.
 *
 * 이 파일이 보는 것은 두 가지뿐이다. 그 밖의 값(메일 주소 등)은 읽지 않는다.
 */
export type AdminUser = {
  id?: unknown;
  is_anonymous?: unknown;
};

/**
 * Auth 서버가 실패를 알려 온 모양.
 *
 * code는 기계가 읽는 오류 코드다. 본문을 읽지 못했으면 null이다.
 * 사람에게 보여주는 설명 문구는 여기에 담지 않는다.
 */
export type AuthCallError = { status: number; code: string | null };

/**
 * Auth 호출 결과.
 *
 * supabase-js의 관리자 API와 같은 모양이다. 오류를 던지지 않고 error에 담아 돌려준다.
 * 다만 통신이 끊기면 실제로 예외가 날 수 있으므로, 이 파일은 두 경우를 모두 다룬다.
 */
export type AuthCallResult<T> = { data: T | null; error: unknown };

export type GetUserResult = AuthCallResult<{ user?: AdminUser | null }>;
export type DeleteUserResult = AuthCallResult<unknown>;

export type DeleteMyDataDeps = {
  /** 서버 전용 자격이 준비되어 있는지. 없으면 Auth를 부르지 않는다. */
  hasAdminCredentials: () => boolean;
  /**
   * 이 토큰이 지금 누구인지 Auth 서버에 물어본다.
   * 토큰 서명·만료 확인과 "그 사용자가 아직 있는가"를 서버가 함께 판단한다.
   */
  getUserByToken: (accessToken: string) => Promise<GetUserResult>;
  /**
   * 사용자를 지운다. 관리자 자격으로만 부른다.
   * 사용자 토큰을 여기에 넘기지 않는다. 넘길 자리를 만들지 않았다.
   */
  deleteUser: (userId: string) => Promise<DeleteUserResult>;
  log?: (message: string) => void;
  requestId?: () => string;
};

const jsonResponse = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'content-type': 'application/json; charset=utf-8' },
  });

/**
 * Authorization 헤더에서 토큰만 꺼낸다.
 *
 * 값이 없거나 Bearer 형식이 아니면 null이다. 헤더 값을 로그에 남기지 않는다.
 */
export function readBearerToken(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (!header) return null;

  const match = /^bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return null;

  const token = match[1].trim();
  return token.length > 0 ? token : null;
}

/**
 * "이 토큰으로는 누구인지 확인할 수 없다"를 뜻하는 Auth 오류 코드.
 *
 * Supabase Auth가 돌려주는 기계 판독용 코드 중에서, 이 요청을 다시 보내도
 * 답이 달라지지 않는 것만 골랐다. 여기 없는 코드는 전부 "확인 실패"로 다룬다.
 *
 * 상태 숫자로 판단하지 않는 이유:
 *   400번대에는 429(요청이 몰림), 408(처리가 오래 걸림), 409(동시 요청 충돌)처럼
 *   잠시 뒤에 다시 하면 성공할 수 있는 것들이 섞여 있다.
 *   그것들을 인증 거절로 부르면, 이용자는 다시 시도해야 할 상황에서
 *   "인증이 안 된다"는 잘못된 안내를 받게 된다.
 *
 *   404도 마찬가지다. 주소가 틀려도 404가 나온다.
 *   사용자가 없다는 뜻은 user_not_found라는 코드가 함께 왔을 때만이다.
 */
export const AUTH_REJECTION_CODES = [
  'no_authorization',
  'bad_jwt',
  'session_expired',
  'session_not_found',
  'user_not_found',
] as const;

/**
 * Auth 오류가 "분명한 거절"인지 "확인 실패"인지 가른다.
 *
 * 400번대 응답이면서, 허용 목록에 있는 코드가 함께 왔을 때만 거절이다. → 401
 * 코드를 모르거나(본문을 읽지 못함), 목록에 없거나, 오류 모양을 알 수 없으면 → 503
 * 서버 오류(5xx)에 거절 코드가 붙어 온 답도 → 503
 *   서버가 고장 났다고 말하면서 동시에 인증을 거절했다고 말하는 모순된 답이다.
 *   어느 쪽이 맞는지 우리가 알 수 없으므로 아는 척하지 않는다.
 *
 * 판단하지 못한 것을 거절로 바꾸지 않는다. 반대도 하지 않는다.
 * 어느 쪽이든 삭제 성공으로 바꾸지 않는다.
 */
export function isDefiniteAuthRejection(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;

  const { status, code } = error as { status?: unknown; code?: unknown };

  // 상태만으로는 판단하지 않지만, 상태와 코드가 서로 맞지 않는 답도 믿지 않는다.
  if (typeof status !== 'number' || status < 400 || status >= 500) return false;

  return typeof code === 'string' && (AUTH_REJECTION_CODES as readonly string[]).includes(code);
}

/**
 * 요청 하나를 처리한다.
 *
 * 순서를 지킨다:
 *   메서드 → Authorization → 서버 자격 → 누구인가 → 익명인가 → 삭제 → 확인된 성공
 *
 * 앞 단계를 통과하지 못하면 뒤 단계를 시작하지 않는다.
 * 특히 신원이 확인되기 전에는 삭제를 시도하지 않는다.
 */
export async function handleDeleteMyData(
  request: Request,
  deps: DeleteMyDataDeps,
): Promise<Response> {
  const log = deps.log ?? (() => {});
  const requestId = deps.requestId ? deps.requestId() : 'req';

  /** 까닭은 서버 기록에만 남긴다. 사용자 번호와 토큰은 남기지 않는다. */
  const fail = (code: DeleteMyDataErrorCode, status: number, reason: string) => {
    log(`[${requestId}] ${reason}`);
    return jsonResponse({ ok: false, error: code } satisfies DeleteMyDataErrorBody, status);
  };

  if (request.method !== 'POST') {
    return fail(DELETE_METHOD_NOT_ALLOWED, 405, 'delete_my_data_method_not_allowed');
  }

  // 본문은 읽지 않는다. 본문에 무엇이 적혀 있든 삭제 대상에 영향을 주지 않는다.
  const token = readBearerToken(request);
  if (!token) {
    return fail(DELETE_UNAUTHENTICATED, 401, 'delete_my_data_missing_bearer');
  }

  if (!deps.hasAdminCredentials()) {
    // 서버 준비가 안 된 것을 인증 거절로 바꾸지 않는다.
    return fail(DELETE_UNAVAILABLE, 503, 'delete_my_data_admin_unconfigured');
  }

  let lookup: GetUserResult;
  try {
    lookup = await deps.getUserByToken(token);
  } catch {
    // 통신이 끊겼거나 시간이 지났다. 누구인지 확인하지 못했다.
    return fail(DELETE_UNAVAILABLE, 503, 'delete_my_data_auth_lookup_threw');
  }

  if (lookup.error) {
    return isDefiniteAuthRejection(lookup.error)
      ? fail(DELETE_UNAUTHENTICATED, 401, 'delete_my_data_auth_rejected')
      : fail(DELETE_UNAVAILABLE, 503, 'delete_my_data_auth_lookup_failed');
  }

  // 오류도 없고 사용자도 없다. 어느 쪽인지 알 수 없는 답이다.
  // 이것을 "지울 사람이 없다"로 읽고 성공을 돌려주지 않는다.
  const user = lookup.data?.user;
  if (typeof user !== 'object' || user === null) {
    return fail(DELETE_UNAVAILABLE, 503, 'delete_my_data_auth_lookup_unreadable');
  }

  const userId = user.id;
  if (typeof userId !== 'string' || userId.trim().length === 0) {
    return fail(DELETE_UNAVAILABLE, 503, 'delete_my_data_user_id_unreadable');
  }

  // 익명 사용자만 지운다. 값이 정확히 true가 아니면 지우지 않는다.
  if (user.is_anonymous !== true) {
    return fail(DELETE_NOT_ANONYMOUS, 403, 'delete_my_data_not_anonymous');
  }

  let removal: DeleteUserResult;
  try {
    removal = await deps.deleteUser(userId);
  } catch {
    return fail(DELETE_UNAVAILABLE, 503, 'delete_my_data_delete_threw');
  }

  if (removal.error) {
    // 지웠는지 알 수 없다. 성공이라고 말하지 않는다.
    return fail(DELETE_UNAVAILABLE, 503, 'delete_my_data_delete_failed');
  }

  log(`[${requestId}] delete_my_data_deleted`);
  return jsonResponse({ ok: true, deleted: true } satisfies DeleteMyDataSuccessBody, 200);
}
