/**
 * Supabase Edge Function · research-queue-refresh (내부 전용)
 *
 * 앱 사용자가 부르는 기능이 아니다.
 * 서버 전용 자격(x-internal-token)으로만 호출한다. 아직 배포하지 않았다.
 *
 * 이 파일은 Deno에서 실행된다. 실제 처리 내용은 handler.ts에 있다.
 * 여기서는 자격 확인과 바깥으로 나가는 연결(DB RPC 하나)만 잇는다.
 *
 * 부르는 DB 함수는 정확히 하나다.
 *   refresh_content_research_queue — Coverage Gap 집계를 읽어 연구 과제 근거를 갱신한다
 *
 * 표에 직접 접근하지 않는다(SELECT·INSERT·UPDATE 없음). 이 RPC 하나만 부른다.
 * 서비스 역할 키는 이 RPC를 부를 때만 쓴다.
 *
 * OpenAI를 부르지 않는다. 사용자 입력을 받지 않는다.
 *
 * 비밀값은 서버 환경에서만 읽고 로그나 응답에 남기지 않는다.
 */

import { isAuthorizedInternalRequest } from '../_shared/internal-auth.ts';
import { handleQueueRefresh, REFRESH_CONTENT_RESEARCH_QUEUE_RPC } from './handler.ts';

// Deno 런타임 타입 (이 프로젝트의 TypeScript 설정은 Node 기준이라 최소한만 선언한다)
declare const Deno: {
  env: { get(key: string): string | undefined };
  serve(handler: (request: Request) => Promise<Response> | Response): unknown;
};

/** Queue를 갱신하는 DB 함수는 이 하나뿐이다. 이름을 여기서 다시 짓지 않는다. */
const REFRESH_QUEUE_PATH = `/rest/v1/rpc/${REFRESH_CONTENT_RESEARCH_QUEUE_RPC}`;

/**
 * RPC 한 번을 기다리는 시간.
 *
 * 다른 내부 기능의 표 함수와 같은 값이다(biblical-researcher, candidate-generator).
 * 새 숫자를 만들지 않았다.
 */
const RPC_TIMEOUT_MS = 5_000;

/**
 * 내부 호출인지 확인한다.
 *
 * 이 기능 전용 토큰을 쓴다. 비교 방법은 _shared/internal-auth.ts 한 곳에만 두고
 * 내부 기능들이 같이 쓴다.
 */
async function isAuthorized(request: Request): Promise<boolean> {
  return isAuthorizedInternalRequest(request, Deno.env.get('RESEARCH_QUEUE_REFRESH_TOKEN'));
}

/** 정해진 시간 안에 끝나지 않으면 요청을 취소한다. 자동 재시도는 하지 않는다. */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Coverage Gap 집계를 읽어 연구 과제 근거 수치를 갱신한다.
 *
 * 인자가 없다. RPC 이름은 위 상수 하나뿐이고 caller가 지정할 방법이 없다.
 * 실패해도 여기서 다시 부르지 않는다.
 */
async function refreshQueue(): Promise<unknown> {
  const baseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

  if (!baseUrl || baseUrl.trim().length === 0) throw new Error('refresh_config_missing');
  if (!serviceRoleKey || serviceRoleKey.trim().length === 0) throw new Error('refresh_config_missing');

  const response = await fetchWithTimeout(
    `${baseUrl.replace(/\/+$/, '')}${REFRESH_QUEUE_PATH}`,
    {
      method: 'POST',
      headers: {
        apikey: serviceRoleKey,
        authorization: `Bearer ${serviceRoleKey}`,
        'content-type': 'application/json',
      },
      body: '{}',
    },
    RPC_TIMEOUT_MS,
  );

  // 상세 오류는 밖으로 전달하지 않는다. 본문을 열지 않는다.
  if (!response.ok) throw new Error(`refresh_http_${response.status}`);

  return await response.json();
}

Deno.serve((request: Request) =>
  handleQueueRefresh(request, {
    isAuthorized,
    refreshQueue,
    // 토큰, 서비스 역할 키, RPC 원본 응답은 로그에 남기지 않는다.
    log: (message) => console.log(message),
    requestId: () => crypto.randomUUID().slice(0, 8),
  }),
);
