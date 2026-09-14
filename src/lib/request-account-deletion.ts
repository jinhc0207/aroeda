/**
 * 내 정보 삭제 · 판단과 연결
 *
 * 설정 화면에서 "내 정보 삭제하기"를 확인했을 때의 흐름이다.
 *
 *   이 기기에 로그인 정보가 있는가 → delete-my-data 호출 → 서버 답 판정
 *   → (서버가 삭제를 확인했을 때만) 앱 상태 비우기 → 이 기기의 로그인 정보 정리 → 정리 확인
 *
 * 가장 무겁게 지키는 약속:
 *   1. 서버가 삭제를 확인하기 전에는 이 기기의 로그인 정보를 지우지 않는다.
 *      먼저 지우면 서버 삭제가 실패했을 때 다시 시도할 방법이 사라진다.
 *   2. 확인하지 못한 것을 성공이라 부르지 않는다.
 *      401, 403, 405, 503, 통신 실패, 시간 초과, 약속과 다른 답은 모두 성공이 아니다.
 *   3. 로그인 정보 정리가 끝났다는 것은 정리 함수가 끝났다는 뜻이 아니다.
 *      정리한 뒤 실제로 로그인 정보가 남아 있지 않은지 다시 확인한다.
 *   4. 삭제를 위해 새 익명 이용자를 만들지 않는다.
 *
 * SDK가 스스로 하는 정리와 이 앱이 하는 정리는 다르다.
 *   Supabase SDK는 로그인 정보를 읽다가 갱신이 끝내 안 되면 스스로 지우기도 한다.
 *   그것은 SDK의 동작이다. 이 파일은 서버 확인 전에 signOut을 부르거나
 *   저장된 로그인 정보를 직접 지우는 일을 하지 않는다.
 *
 * 앞부분(판단)은 바깥 연결을 인자로 받는다. 실제 서버 없이 시험할 수 있다.
 * 뒷부분(연결)은 Supabase 클라이언트를 인자로 받아 판단에 필요한 모양으로 바꾼다.
 * 이 파일은 Supabase 클라이언트를 직접 불러오지 않는다.
 *
 * 사용자 번호, 토큰, 원본 오류는 결과에 담지 않고 로그에도 남기지 않는다.
 */

export const DELETE_MY_DATA_FUNCTION = 'delete-my-data';

/**
 * 삭제 요청 전체를 기다리는 시간.
 *
 * 서버는 Auth 호출 두 번에 각각 5초를 건다. 그보다 넉넉하게 둔다.
 * 시간이 지나면 확인 불가로 끝낸다. 자동으로 다시 보내지 않는다.
 */
export const DELETE_REQUEST_TIMEOUT_MS = 15_000;

/** 403 응답의 본문을 읽는 데 거는 시간. 본문이 멈추면 확인 불가로 끝낸다. */
export const ERROR_BODY_TIMEOUT_MS = 3_000;

/* ================================================================== */
/* 판단                                                                */
/* ================================================================== */

/**
 * 삭제 흐름의 결과.
 *
 *   no-local-session             이 기기에 로그인 정보가 없다. 서버에서 무엇을 지울지 알 수 없다.
 *                                "서버에도 없다"는 뜻이 아니다.
 *   local-session-unreadable     이 기기의 로그인 정보를 읽지 못했다. 서버에 요청하지 않았다.
 *   deleted                      서버가 삭제를 확인했고, 이 기기의 정리도 확인했다.
 *   deleted-local-cleanup-failed 서버가 삭제를 확인했지만, 이 기기의 로그인 정보가 남아 있다.
 *   unconfirmed                  서버에서 삭제됐는지 확인하지 못했다.
 *   not-anonymous                익명 이용자가 아니어서 서버가 삭제하지 않았다.
 */
export type DeletionResult =
  | 'no-local-session'
  | 'local-session-unreadable'
  | 'deleted'
  | 'deleted-local-cleanup-failed'
  | 'unconfirmed'
  | 'not-anonymous';

export type LocalSessionState = 'present' | 'absent' | 'unreadable';

/** 서버 호출의 결과. 응답을 받았으면 상태와 본문, 받지 못했으면 no-response. */
export type DeleteResponse =
  | { kind: 'response'; status: number; body: unknown }
  | { kind: 'no-response' };

export type DeletionDeps = {
  /** 이 기기에 로그인 정보가 있는지 본다. 지우지 않는다. */
  readLocalSession: () => Promise<LocalSessionState>;
  /** delete-my-data를 한 번 부른다. */
  invokeDeleteMyData: () => Promise<DeleteResponse>;
  /** 앱이 들고 있는 상황·말씀 선택을 비운다. 서버 삭제가 확인된 뒤에만 불린다. */
  clearAppState: () => void;
  /** 이 기기의 로그인 정보를 정리하고, 실제로 남아 있지 않은지 확인한다. */
  clearLocalAuth: () => Promise<'cleared' | 'remains'>;
};

export type LocalCleanupDeps = Pick<DeletionDeps, 'clearAppState' | 'clearLocalAuth'>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/**
 * 서버 답을 판정한다.
 *
 * 성공은 HTTP 성공(2xx)과 { ok: true, deleted: true }를 모두 확인한 경우뿐이다.
 * 익명이 아니라는 답은 403과 정해진 오류 코드가 함께 왔을 때만이다.
 * 그 밖은 전부 확인 불가다.
 */
export function classifyDeleteResponse(
  response: DeleteResponse,
): 'deleted' | 'not-anonymous' | 'unconfirmed' {
  if (response.kind !== 'response') return 'unconfirmed';

  const { status, body } = response;

  if (status >= 200 && status < 300) {
    return isRecord(body) && body.ok === true && body.deleted === true ? 'deleted' : 'unconfirmed';
  }

  if (status === 403 && isRecord(body) && body.ok === false && body.error === 'DELETE_NOT_ANONYMOUS') {
    return 'not-anonymous';
  }

  return 'unconfirmed';
}

/**
 * 서버 삭제가 확인된 뒤의 정리.
 *
 * 앱 상태를 먼저 비우고, 그다음 이 기기의 로그인 정보를 정리한다.
 * 둘 중 하나라도 확인되지 않으면 정리 실패로 돌려준다. 서버에 다시 요청하지 않는다.
 */
async function finishLocalCleanup(deps: LocalCleanupDeps) {
  let appStateCleared = true;
  try {
    deps.clearAppState();
  } catch {
    appStateCleared = false;
  }

  let auth: 'cleared' | 'remains';
  try {
    auth = await deps.clearLocalAuth();
  } catch {
    auth = 'remains';
  }

  return appStateCleared && auth === 'cleared' ? 'deleted' : 'deleted-local-cleanup-failed';
}

/**
 * 내 정보 삭제를 한 번 진행한다.
 * 어떤 경우에도 예외를 밖으로 던지지 않는다.
 */
export async function requestDataDeletion(deps: DeletionDeps): Promise<DeletionResult> {
  let session: LocalSessionState;
  try {
    session = await deps.readLocalSession();
  } catch {
    session = 'unreadable';
  }

  if (session === 'absent') return 'no-local-session';
  if (session !== 'present') return 'local-session-unreadable';

  let response: DeleteResponse;
  try {
    response = await deps.invokeDeleteMyData();
  } catch {
    response = { kind: 'no-response' };
  }

  const verdict = classifyDeleteResponse(response);
  // 서버가 삭제를 확인하지 않았으면 이 기기에서 아무것도 지우지 않는다.
  if (verdict !== 'deleted') return verdict;

  return finishLocalCleanup(deps);
}

/**
 * 서버 삭제는 이미 확인됐고, 이 기기의 정리만 다시 해 본다.
 * 서버에 삭제를 다시 요청하지 않는다.
 */
export function retryLocalCleanup(
  deps: LocalCleanupDeps,
): Promise<'deleted' | 'deleted-local-cleanup-failed'> {
  return finishLocalCleanup(deps);
}

/* ================================================================== */
/* Supabase 연결                                                       */
/* ================================================================== */

/** 이 파일이 쓰는 Supabase 클라이언트의 부분. 실제 클라이언트와 가짜 둘 다 이 모양이다. */
export type DeletionClient = {
  auth: {
    getSession: () => Promise<{ data: { session: unknown } | null; error: unknown }>;
    signOut: (options: { scope: 'local' }) => Promise<{ error: unknown }>;
  };
  functions: {
    invoke: (
      functionName: string,
      options: { method: 'POST'; timeout: number },
    ) => Promise<{ data: unknown; error: unknown; response?: unknown }>;
  };
};

/** 시간이 다 됐을 때 알려 주는 장치. 취소하는 함수를 돌려준다. 시험에서만 바꿔 넣는다. */
export type Schedule = (onTimeout: () => void, ms: number) => () => void;

const defaultSchedule: Schedule = (onTimeout, ms) => {
  const timer = setTimeout(onTimeout, ms);
  return () => clearTimeout(timer);
};

const statusOf = (value: unknown): number | null =>
  isRecord(value) && typeof value.status === 'number' ? value.status : null;

/**
 * 응답 본문을 정해진 시간 안에만 읽는다.
 * 읽지 못하거나 시간이 지나면 null이다. 모르는 것을 아는 척하지 않는다.
 */
function readJsonWithin(response: unknown, ms: number, schedule: Schedule): Promise<unknown> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: unknown) => {
      if (settled) return;
      settled = true;
      cancel();
      resolve(value);
    };
    const cancel = schedule(() => finish(null), ms);

    Promise.resolve()
      .then(() => (response as { json: () => Promise<unknown> }).json())
      .then(finish, () => finish(null));
  });
}

/**
 * 실제 Supabase 클라이언트를 판단에 필요한 모양으로 바꾼다.
 *
 * clearAppState는 화면이 넘겨준다. 이 파일은 화면 상태를 알지 못한다.
 */
export function createSupabaseDeletionDeps(
  client: DeletionClient,
  clearAppState: () => void,
  options: { schedule?: Schedule; errorBodyTimeoutMs?: number } = {},
): DeletionDeps {
  const schedule = options.schedule ?? defaultSchedule;
  const errorBodyTimeoutMs = options.errorBodyTimeoutMs ?? ERROR_BODY_TIMEOUT_MS;

  /**
   * getSession의 답을 세 가지로 읽는다.
   * 로그인 정보가 없다는 답은 session이 정확히 null일 때뿐이다.
   * 모양이 예상과 다르면 없다고 추정하지 않고 "읽지 못함"으로 둔다.
   */
  const sessionStateOf = (data: unknown): LocalSessionState => {
    if (!isRecord(data)) return 'unreadable';
    if (data.session === null) return 'absent';
    return isRecord(data.session) ? 'present' : 'unreadable';
  };

  const readLocalSession = async (): Promise<LocalSessionState> => {
    try {
      const { data, error } = await client.auth.getSession();
      if (error) return 'unreadable';
      return sessionStateOf(data);
    } catch {
      return 'unreadable';
    }
  };

  const invokeDeleteMyData = async (): Promise<DeleteResponse> => {
    const result = await client.functions.invoke(DELETE_MY_DATA_FUNCTION, {
      method: 'POST',
      timeout: DELETE_REQUEST_TIMEOUT_MS,
    });

    if (!result.error) {
      // SDK는 2xx일 때만 오류 없이 돌려준다. 그래도 상태 숫자를 직접 확인한다.
      const status = statusOf(result.response);
      if (status === null) return { kind: 'no-response' };
      return { kind: 'response', status, body: result.data };
    }

    // 서버가 2xx가 아닌 응답을 준 경우만 상태를 읽는다.
    // 요청을 보내지 못했거나(FunctionsFetchError), 중계가 실패했으면(FunctionsRelayError)
    // 서버 판단을 받지 못한 것이다.
    const error = result.error as { name?: unknown; context?: unknown };
    if (error.name !== 'FunctionsHttpError') return { kind: 'no-response' };

    const status = statusOf(error.context);
    if (status === null) return { kind: 'no-response' };

    // 본문이 판정에 필요한 것은 403뿐이다. 그 밖의 상태는 본문을 읽지 않는다.
    if (status !== 403) return { kind: 'response', status, body: null };

    const body = await readJsonWithin(error.context, errorBodyTimeoutMs, schedule);
    return { kind: 'response', status, body };
  };

  /**
   * 이 기기의 로그인 정보를 정리하고 확인한다.
   *
   * signOut의 결과만 믿지 않는다.
   *   SDK는 로그인 정보를 지운 뒤에도 오류를 돌려줄 수 있고,
   *   로그인 정보를 읽는 단계에서 막히면 지우지 않은 채 오류를 돌려주기도 한다.
   *   예외를 던질 수도 있다.
   * 그래서 정리한 뒤 로그인 정보가 실제로 남아 있지 않은지 다시 읽어서 판단한다.
   *
   * scope: 'local' — 이 기기의 로그인 정보만 정리한다.
   * 기기 저장소 전체를 비우지 않는다. 다른 데이터는 건드리지 않는다.
   */
  const clearLocalAuth = async (): Promise<'cleared' | 'remains'> => {
    try {
      await client.auth.signOut({ scope: 'local' });
    } catch {
      // 판단은 아래에서 직접 확인한 결과로 한다.
    }

    try {
      const { data, error } = await client.auth.getSession();
      if (error) return 'remains';
      // 정확히 "없음"으로 읽힐 때만 정리됐다고 한다. 모양을 모르면 남아 있는 것으로 둔다.
      return sessionStateOf(data) === 'absent' ? 'cleared' : 'remains';
    } catch {
      return 'remains';
    }
  };

  return { readLocalSession, invokeDeleteMyData, clearAppState, clearLocalAuth };
}
