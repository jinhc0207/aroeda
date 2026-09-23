/**
 * Supabase Edge Function · analyze-situation
 *
 * 입력:  { "situation": "사용자가 입력한 한국어 문장" }
 * 출력:  { "ok": true, "analysis": { ... } }
 *
 * 이 파일은 Deno에서 실행된다. 실제 처리 내용은 handler.ts에 있다.
 * 여기서는 API Key를 읽고 OpenAI를 호출하는 부분만 연결한다.
 *
 * 아직 배포하지 않았다. 배포는 사용자가 직접 결정한다.
 */

import { handlePreflight } from '../_shared/cors.ts';
import { createSupabaseQuotaChecker } from '../_shared/rate-limit.ts';
import { createScriptureCatalogRuntimeLoader } from '../_shared/automatic-scripture-catalog-runtime-fetch-transport.ts';
import { handleAnalyzeSituation } from './handler.ts';

// Deno 런타임 타입 (이 프로젝트의 TypeScript 설정은 Node 기준이라 최소한만 선언한다)
declare const Deno: {
  env: { get(key: string): string | undefined };
  serve(handler: (request: Request) => Promise<Response> | Response): unknown;
};

const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';

/**
 * 사용량 제한 확인기.
 * 두 Edge Function이 같은 모듈을 써서 하나의 quota를 공유한다.
 * 사용자 JWT는 요청에 담겨 온 것을 그대로 전달하고 로그에 남기지 않는다.
 */
const checkQuota = createSupabaseQuotaChecker({
  url: Deno.env.get('SUPABASE_URL'),
  apiKey: Deno.env.get('SUPABASE_ANON_KEY'),
});
const loadCatalogRuntime = createScriptureCatalogRuntimeLoader({
  supabaseUrl: Deno.env.get('SUPABASE_URL'),
  serviceRoleKey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
});

async function callOpenAI(payload: Record<string, unknown>, apiKey: string): Promise<unknown> {
  const response = await fetch(OPENAI_RESPONSES_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    // 상세 오류 메시지는 사용자에게 전달하지 않는다. 상태 코드만 남긴다.
    throw new Error(`openai_http_${response.status}`);
  }

  return await response.json();
}

Deno.serve((request: Request) => {
  // 브라우저 사전 요청(OPTIONS)은 여기서 바로 끝낸다. API Key도 읽지 않고 OpenAI도 부르지 않는다.
  const preflight = handlePreflight(request);
  if (preflight) return preflight;

  return handleAnalyzeSituation(request, {
    loadCatalogRuntime,
    checkQuota,
    getApiKey: () => Deno.env.get('OPENAI_API_KEY'),
    callOpenAI,
    // 사용자 문장과 OpenAI 원본 응답은 로그에 남기지 않는다.
    log: (message) => console.log(message),
    requestId: () => crypto.randomUUID().slice(0, 8),
  });
});
