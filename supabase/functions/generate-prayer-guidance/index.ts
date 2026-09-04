/**
 * Supabase Edge Function · generate-prayer-guidance
 *
 * 사용자가 말씀 화면에서 기도 도움을 눌렀을 때만 불린다.
 * 앱에서 부르는 기능이므로 recommend-scripture와 같은 자격 방식을 쓴다.
 * 연구용 기능의 서버 전용 토큰 방식을 가져오지 않는다.
 *
 * 이 파일이 맡는 일은 바깥으로 나가는 연결뿐이다.
 *   사용량 확인, API Key 읽기, OpenAI 호출, 시간 재기.
 * 실제 판단은 handler.ts에 있다.
 *
 * 부르는 DB 함수는 사용량 확인 하나뿐이다. 표에 직접 접근하지 않는다.
 * 비밀값은 서버 환경에서만 읽고 로그나 응답에 남기지 않는다.
 */

import { createSupabaseQuotaChecker } from '../_shared/rate-limit.ts';
import { handlePreflight } from '../_shared/cors.ts';
import { PRAYER_GUIDANCE_MODEL_TIMEOUT_MS } from '../_shared/prayer-guidance-contract.ts';
import { handlePrayerGuidance } from './handler.ts';

// Deno 런타임 타입 (이 프로젝트의 TypeScript 설정은 Node 기준이라 최소한만 선언한다)
declare const Deno: {
  env: { get(key: string): string | undefined };
  serve(handler: (request: Request) => Promise<Response> | Response): unknown;
};

const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';

/** 사용량 확인은 recommend-scripture와 같은 표를 쓴다. 새 한도를 만들지 않는다. */
const checkQuota = createSupabaseQuotaChecker({
  url: Deno.env.get('SUPABASE_URL'),
  apiKey: Deno.env.get('SUPABASE_ANON_KEY'),
});

/**
 * OpenAI Responses API를 한 번 부른다.
 *
 * 두 가지 시간이 걸린다.
 *   이 호출 하나에 거는 시간, 그리고 요청 전체에 걸린 시간.
 *   둘 중 먼저 끝나는 쪽이 요청을 끊는다.
 *
 * 전체 시계가 이미 울렸으면 아예 보내지 않는다.
 * 다시 부르지 않는다.
 *
 * 응답 본문이 오류일 때 그 내용을 밖으로 내보내거나 로그에 남기지 않는다.
 * 기다리는 시간은 부르는 쪽이 정한다. 여기서 새로 정하지 않는다.
 */
async function callWithTimeout(
  payload: Record<string, unknown>,
  apiKey: string,
  options: { timeoutMs?: number; signal?: AbortSignal },
): Promise<unknown> {
  const controller = new AbortController();

  // 전체 시계가 울리면 이 요청도 함께 끊는다.
  if (options.signal) {
    if (options.signal.aborted) throw new Error('aborted');
    options.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  const timeoutMs = options.timeoutMs ?? PRAYER_GUIDANCE_MODEL_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(OPENAI_RESPONSES_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!response.ok) {
      // 상세 오류 메시지는 읽지도, 전달하지도 않는다. 상태 숫자만 남긴다.
      throw new Error(`openai_http_${response.status}`);
    }

    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 상황을 다시 살피는 호출.
 *
 * 요청 처리 본체가 남은 시간과 전체 시계를 함께 넘긴다.
 * 넘기지 않으면 개별 시간만 걸린다.
 */
async function callOpenAI(
  payload: Record<string, unknown>,
  apiKey: string,
  options?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<unknown> {
  return await callWithTimeout(payload, apiKey, options ?? {});
}

Deno.serve((request: Request) => {
  // 브라우저 사전 요청(OPTIONS)은 여기서 바로 끝낸다. API Key도 읽지 않고 OpenAI도 부르지 않는다.
  const preflight = handlePreflight(request);
  if (preflight) return preflight;

  return handlePrayerGuidance(request, {
    checkQuota,
    getApiKey: () => Deno.env.get('OPENAI_API_KEY'),
    callOpenAI,
    callGuidance: callWithTimeout,
    // 사용자 문장, 말씀 자료, 모델 원본 응답은 로그에 남기지 않는다.
    log: (message) => console.log(message),
    requestId: () => crypto.randomUUID().slice(0, 8),
  });
});
