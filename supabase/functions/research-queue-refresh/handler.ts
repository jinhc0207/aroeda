/**
 * research-queue-refresh · 요청 처리 본체 (내부 전용)
 *
 * 앱 사용자가 부르는 기능이 아니다. 서버 전용 자격으로만 호출한다.
 *
 * 하는 일은 하나뿐이다. Coverage Gap 집계를 읽어 연구 과제 근거 수치를
 * 갱신하는 DB 함수(refresh_content_research_queue)를 정확히 한 번 부르고,
 * 그 결과에서 안전한 숫자 하나만 꺼내 돌려준다.
 *
 * 받는 것은 없다. 본문이 없거나, 빈 문자열이거나, `{}`이면 같은 요청으로 본다.
 * 그 밖의 모양(다른 키가 있는 object, null, 배열, 문자열/숫자/불리언)은 전부 거절한다.
 * caller가 RPC 이름·도메인·개수·표 상태·SQL을 지정할 방법은 없다.
 *
 * 순서:
 *   POST 확인 → 내부 권한 확인 → 본문이 비어 있는지 확인 → RPC 호출(최대 1회)
 *   → RPC 결과 모양 확인(items_touched만) → 응답
 *
 * 이 파일이 하지 않는 일:
 *   Deno.env 접근, 실제 RPC 호출, 서비스 역할 키 사용 — 전부 index.ts가 한다.
 *   여기서는 자격 확인 결과와 RPC 결과만 받아 흐름을 잇는다.
 *
 * 브라우저에서 부르는 기능이 아니므로 CORS 헤더를 붙이지 않는다.
 * POST가 아닌 요청(OPTIONS 포함)은 모두 거절한다.
 *
 * 로그와 응답에 토큰, 서비스 역할 키, RPC 원본 응답, DB 원본 오류를 남기지 않는다.
 */

export type ErrorCode =
  | 'METHOD_NOT_ALLOWED'
  | 'UNAUTHORIZED'
  | 'INVALID_JSON'
  | 'INVALID_REQUEST'
  /** RPC에 닿지 못했거나, 시간을 넘겼거나, 정상 응답이 아니었다. DB 상세 사유는 옮기지 않는다. */
  | 'QUEUE_REFRESH_UNAVAILABLE'
  /** RPC는 답했지만 그 모양이 계약과 다르다. 원본은 옮기지 않는다. */
  | 'INVALID_REFRESH_RESPONSE'
  | 'INTERNAL_ERROR';

export type ErrorBody = { ok: false; error: ErrorCode };
export type SuccessBody = { ok: true; status: 'refreshed'; itemsTouched: number };

/** DB 함수 이름은 이 상수 하나뿐이다. index.ts가 이 값으로 RPC 경로를 만든다. */
export const REFRESH_CONTENT_RESEARCH_QUEUE_RPC = 'refresh_content_research_queue';

export type HandlerDeps = {
  /** 내부 호출인지 확인한다. 실패하면 본문도 RPC도 건드리지 않는다. */
  isAuthorized: (request: Request) => boolean | Promise<boolean>;
  /** 실제 RPC 호출은 index.ts가 만든다. 여기서는 결과만 받는다. 인자가 없다. */
  refreshQueue: () => Promise<unknown>;
  /** 이유 코드만 남긴다. 토큰, 서비스 역할 키, RPC 원본은 남기지 않는다. */
  log?: (message: string) => void;
  requestId?: () => string;
};

const jsonResponse = (body: SuccessBody | ErrorBody, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

/**
 * 요청 본문을 검사한다.
 *
 * 허용: 본문 없음(undefined), 빈 object({}).
 * 거절: null, 배열, 문자열/숫자/불리언, key가 하나라도 있는 object.
 * 알 수 없는 field를 조용히 무시하지 않는다 — key가 있으면 그 자체로 거절이다.
 */
export function parseRefreshRequest(body: unknown): { ok: true } | { ok: false } {
  if (body === undefined) return { ok: true };
  if (body === null) return { ok: false };
  if (Array.isArray(body)) return { ok: false };
  if (typeof body !== 'object') return { ok: false };
  return Object.keys(body).length === 0 ? { ok: true } : { ok: false };
}

/**
 * RPC가 돌려준 값에서 items_touched만 안전하게 꺼낸다.
 *
 * refreshed_at을 포함한 그 밖의 모든 필드는 버린다.
 * 모양이 다르거나 값이 음수/실수/문자열이면 실패로 본다.
 */
export function parseRefreshRpcResult(raw: unknown): { ok: true; itemsTouched: number } | { ok: false } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false };
  const itemsTouched = (raw as Record<string, unknown>).items_touched;
  if (typeof itemsTouched !== 'number' || !Number.isInteger(itemsTouched) || itemsTouched < 0) {
    return { ok: false };
  }
  return { ok: true, itemsTouched };
}

/**
 * Research Queue Refresh 요청 하나를 처리한다.
 *
 * 실패는 모두 fail closed다. 어느 실패에서도 다시 부르지 않는다.
 */
export async function handleQueueRefresh(request: Request, deps: HandlerDeps): Promise<Response> {
  const log = deps.log ?? (() => {});
  const requestId = deps.requestId?.() ?? '';

  const fail = (code: ErrorCode, status: number) => {
    log(`[${requestId}] ${code}`);
    return jsonResponse({ ok: false, error: code }, status);
  };

  try {
    // 1. 브라우저에서 부르는 기능이 아니다. POST 말고는 받지 않는다.
    if (request.method !== 'POST') return fail('METHOD_NOT_ALLOWED', 405);

    // 2. 권한부터 본다. 통과하지 못하면 본문도 읽지 않고 RPC도 부르지 않는다.
    if (!(await deps.isAuthorized(request))) return fail('UNAUTHORIZED', 401);

    // 3. 본문. 없어도 되지만, 있다면 정확히 빈 모양이어야 한다.
    let rawText: string;
    try {
      rawText = await request.text();
    } catch {
      return fail('INVALID_JSON', 400);
    }

    let body: unknown;
    if (rawText.trim().length === 0) {
      body = undefined;
    } else {
      try {
        body = JSON.parse(rawText);
      } catch {
        return fail('INVALID_JSON', 400);
      }
    }

    const parsedRequest = parseRefreshRequest(body);
    if (!parsedRequest.ok) return fail('INVALID_REQUEST', 400);

    // 4. RPC를 정확히 한 번 부른다.
    let rpcResult: unknown;
    try {
      rpcResult = await deps.refreshQueue();
    } catch {
      return fail('QUEUE_REFRESH_UNAVAILABLE', 503);
    }

    // 5. 응답 모양을 본다. items_touched 하나만 믿는다.
    const parsedResult = parseRefreshRpcResult(rpcResult);
    if (!parsedResult.ok) return fail('INVALID_REFRESH_RESPONSE', 502);

    log(`[${requestId}] refreshed`);
    return jsonResponse({ ok: true, status: 'refreshed', itemsTouched: parsedResult.itemsTouched }, 200);
  } catch {
    return fail('INTERNAL_ERROR', 500);
  }
}
