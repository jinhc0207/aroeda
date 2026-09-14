/**
 * Supabase Edge Function · delete-my-data
 *
 * 앱 이용자가 자기 정보를 지워 달라고 할 때 부르는 기능이다.
 * recommend-scripture, generate-prayer-guidance와 같은 자격 방식(사용자 JWT)을 쓴다.
 * 연구용 기능의 서버 전용 토큰 방식을 가져오지 않는다.
 *
 * 이 파일이 맡는 일은 실행 환경을 이어 주는 것뿐이다.
 *   서버 자격 읽기, 진짜 fetch와 진짜 시계 넘겨 주기.
 * Auth 서버로 나가는 두 연결은 auth-admin.ts에, 실제 판단은 handler.ts에 있다.
 *
 * 표에 직접 접근하지 않는다. 사용량 기록은 외래키(on delete cascade)를 타고 함께 지워진다.
 * OpenAI를 부르지 않는다.
 *
 * 비밀값은 서버 환경에서만 읽고 로그나 응답에 남기지 않는다.
 */

import { handlePreflight } from '../_shared/cors.ts';
import { createAuthAdmin } from './auth-admin.ts';
import { handleDeleteMyData } from './handler.ts';

// Deno 런타임 타입 (이 프로젝트의 TypeScript 설정은 Node 기준이라 최소한만 선언한다)
declare const Deno: {
  env: { get(key: string): string | undefined };
  serve(handler: (request: Request) => Promise<Response> | Response): unknown;
};

const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

/** Auth 호출 하나를 기다리는 시간. 본문을 다 읽을 때까지 유지된다. */
const AUTH_TIMEOUT_MS = 5_000;

const hasAdminCredentials = () =>
  Boolean(SUPABASE_URL && SERVICE_ROLE_KEY && SERVICE_ROLE_KEY.trim().length > 0);

const authAdmin = createAuthAdmin({
  url: SUPABASE_URL ?? '',
  serviceRoleKey: SERVICE_ROLE_KEY ?? '',
  timeoutMs: AUTH_TIMEOUT_MS,
  fetchImpl: fetch,
  schedule: (onTimeout, ms) => {
    const timer = setTimeout(onTimeout, ms);
    return () => clearTimeout(timer);
  },
});

Deno.serve((request: Request) => {
  // 브라우저 사전 요청(OPTIONS)은 여기서 바로 끝낸다. 서버 자격도 읽지 않는다.
  const preflight = handlePreflight(request);
  if (preflight) return preflight;

  return handleDeleteMyData(request, {
    hasAdminCredentials,
    getUserByToken: authAdmin.getUserByToken,
    deleteUser: authAdmin.deleteUser,
    // 사용자 번호, 토큰, Auth 서버 원본 오류는 로그에 남기지 않는다.
    log: (message) => console.log(message),
    requestId: () => crypto.randomUUID().slice(0, 8),
  });
});
