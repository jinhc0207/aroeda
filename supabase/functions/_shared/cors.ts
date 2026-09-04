/**
 * Edge Function 공용 CORS 설정
 *
 * 브라우저에서 supabase.functions.invoke()로 부를 수 있게 하기 위한 것이다.
 * 두 함수가 서로 다른 규칙을 갖지 않도록 여기 한 곳에만 둔다.
 *
 * Access-Control-Allow-Credentials는 쓰지 않는다.
 * 지금은 모든 출처(*)를 허용하고 있어서, 쿠키 기반 자격증명과 함께 쓰면 안 된다.
 * 호출자는 Supabase 익명 로그인으로 받은 사용자 JWT를 Authorization 헤더로 보낸다.
 */

export const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  // 사전 요청(preflight) 결과를 하루 동안 재사용하게 해서 왕복을 줄인다.
  'Access-Control-Max-Age': '86400',
  // 429 응답의 Retry-After를 브라우저 코드가 읽을 수 있게 한다.
  'Access-Control-Expose-Headers': 'Retry-After',
};

/**
 * 브라우저가 본 요청 전에 보내는 사전 요청(OPTIONS) 응답.
 * 여기서는 Analyzer도 OpenAI도 부르지 않고, API Key도 읽지 않는다.
 */
export function preflightResponse(): Response {
  return new Response('ok', { status: 200, headers: corsHeaders });
}

/** OPTIONS면 사전 요청 응답을, 아니면 null을 돌려준다. */
export function handlePreflight(request: Request): Response | null {
  return request.method === 'OPTIONS' ? preflightResponse() : null;
}
