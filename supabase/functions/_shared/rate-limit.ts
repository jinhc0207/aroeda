/**
 * OpenAI 사용량 제한 (서버 전용)
 *
 * 비용 악용을 막기 위한 장치다. 추천 품질이나 점수와는 관계가 없다.
 *
 * 원칙
 *   - 횟수는 서버(DB)에서만 센다. 앱이 조작되어도 서버가 막는다.
 *   - analyze-situation과 recommend-scripture가 같은 quota를 함께 쓴다.
 *     둘 다 이 파일의 같은 함수를 통해 확인한다.
 *   - 확인에 실패하면 통과시키지 않는다(fail-closed). 보호 장치를 우회해 OpenAI를 부르지 않는다.
 *   - Authorization 헤더, JWT, 사용자 id는 로그에 남기지 않는다.
 *
 * 실제 사용량 계산은 DB 함수 public.consume_openai_quota() 안에서 원자적으로 이뤄진다.
 * 사용자 id를 인자로 보내지 않는다. DB가 auth.uid()로 판단한다.
 */

export type QuotaDecision =
  | { status: 'allowed' }
  | { status: 'limited'; retryAfterSeconds: number }
  | { status: 'unavailable' };

/**
 * 요청 하나에 대해 사용량을 한 번 소비한다.
 *
 * options는 없어도 된다. 넘기지 않으면 지금까지와 똑같이 동작한다.
 * 전체 시간 예산이 있는 기능만 그 신호를 함께 넘긴다.
 */
export type QuotaChecker = (
  request: Request,
  options?: { signal?: AbortSignal },
) => Promise<QuotaDecision>;

export type SupabaseQuotaConfig = {
  /** Supabase 프로젝트 URL */
  url: string | undefined;
  /** REST 호출에 필요한 공개 키 (anon / publishable) */
  apiKey: string | undefined;
  fetchImpl?: typeof fetch;
};

const RPC_PATH = '/rest/v1/rpc/consume_openai_quota';

/** DB가 돌려준 값을 안전한 형태로 바꾼다. 모양이 예상과 다르면 통과시키지 않는다. */
export function parseQuotaResponse(payload: unknown): QuotaDecision {
  const value = Array.isArray(payload) ? payload[0] : payload;
  if (typeof value !== 'object' || value === null) return { status: 'unavailable' };

  const { allowed, retry_after_seconds: retryAfter } = value as {
    allowed?: unknown;
    retry_after_seconds?: unknown;
  };

  if (allowed === true) return { status: 'allowed' };
  if (allowed !== false) return { status: 'unavailable' };

  const seconds = typeof retryAfter === 'number' && Number.isFinite(retryAfter) ? Math.max(1, Math.ceil(retryAfter)) : 60;
  return { status: 'limited', retryAfterSeconds: seconds };
}

/**
 * 실제 Supabase DB로 사용량을 확인하는 checker를 만든다.
 *
 * 요청에 담겨 온 사용자 JWT를 그대로 전달한다.
 * 헤더 값을 읽어 로그에 남기거나 따로 저장하지 않는다.
 * 사용자 JWT가 없으면 DB의 auth.uid()가 비어 통과되지 않는다.
 */
export function createSupabaseQuotaChecker(config: SupabaseQuotaConfig): QuotaChecker {
  const doFetch = config.fetchImpl ?? fetch;

  return async (
    request: Request,
    options?: { signal?: AbortSignal },
  ): Promise<QuotaDecision> => {
    if (!config.url || !config.apiKey) return { status: 'unavailable' };

    const authorization = request.headers.get('authorization');
    if (!authorization) return { status: 'unavailable' };

    try {
      const response = await doFetch(`${config.url}${RPC_PATH}`, {
        method: 'POST',
        headers: {
          authorization,
          apikey: config.apiKey,
          'content-type': 'application/json',
        },
        body: '{}',
        // 신호를 주지 않은 기존 기능은 지금까지와 똑같이 동작한다.
        ...(options?.signal ? { signal: options.signal } : {}),
      });

      if (!response.ok) return { status: 'unavailable' };

      return parseQuotaResponse(await response.json());
    } catch {
      // 원본 오류는 남기지 않는다. 실패하면 통과시키지 않는다.
      return { status: 'unavailable' };
    }
  };
}
