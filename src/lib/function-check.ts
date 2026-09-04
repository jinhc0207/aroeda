/**
 * 개발 확인용 서버 연결 점검
 *
 * 브라우저 → 저장된 익명 세션 → 사용자 JWT → verify_jwt → CORS → recommend-scripture
 * 이 통신 경로가 실제로 이어지는지 딱 한 번 확인하기 위한 코드다.
 *
 * 추천 품질을 다시 평가하는 것이 목적이 아니다.
 * 제품 화면에서는 쓰지 않는다.
 *
 * 이 파일은 Supabase 클라이언트를 직접 불러오지 않는다.
 * 필요한 동작만 인자로 받기 때문에 실제 서버 없이도 테스트할 수 있다.
 */

import type { SessionSummary } from './anonymous-session.ts';

/** 개발 테스트용 고정 문장. 사용자 입력을 서버로 보내지 않는다. */
export const FUNCTION_CHECK_SITUATION =
  '다음 주 검사 결과가 나오는데 나쁜 결과일까 봐 너무 무섭습니다.';

/** 이 문장에 대해 서버에서 나와야 하는 값 */
export const EXPECTED = {
  route: 'recommend',
  primaryDomain: 'fear_uncertainty',
  selectedCardId: 'SC-001',
  safetyLevel: 'normal',
} as const;

export type FunctionCheckDeps = {
  /** 익명 세션을 준비한다. 이미 있으면 그대로 쓴다. */
  ensureSession: () => Promise<SessionSummary>;
  /** recommend-scripture 호출. Authorization 헤더는 supabase-js가 알아서 붙인다. */
  invokeRecommendScripture: (body: { situation: string }) => Promise<{
    data: unknown;
    error: unknown;
  }>;
};

export type FunctionCheckFailure = 'AUTH_FAILED' | 'FUNCTION_FAILED' | 'UNEXPECTED_RESPONSE';

export type FunctionCheckResult =
  | {
      status: 'ok';
      sessionReady: true;
      route: string;
      primaryDomain: string;
      selectedCardId: string | null;
      safetyLevel: string;
      /** 기대한 결과와 같은지 */
      matchesExpectation: boolean;
    }
  | {
      status: 'failed';
      sessionReady: boolean;
      failure: FunctionCheckFailure;
    };

type ParsedResult = {
  route: string;
  primaryDomain: string;
  selectedCardId: string | null;
  safetyLevel: string;
};

/** 서버 응답을 그대로 믿지 않는다. 필요한 필드가 기대한 모양인지 확인한다. */
function parseResponse(data: unknown): ParsedResult | null {
  if (typeof data !== 'object' || data === null) return null;

  const { ok, result } = data as { ok?: unknown; result?: unknown };
  if (ok !== true) return null;
  if (typeof result !== 'object' || result === null) return null;

  const { route, primaryDomain, selectedCardId, safety } = result as {
    route?: unknown;
    primaryDomain?: unknown;
    selectedCardId?: unknown;
    safety?: unknown;
  };

  if (typeof route !== 'string' || typeof primaryDomain !== 'string') return null;
  if (selectedCardId !== null && typeof selectedCardId !== 'string') return null;
  if (typeof safety !== 'object' || safety === null) return null;

  const { level } = safety as { level?: unknown };
  if (typeof level !== 'string') return null;

  return { route, primaryDomain, selectedCardId, safetyLevel: level };
}

/**
 * 서버 연결을 한 번 확인한다.
 * 세션이 준비되지 않으면 Edge Function을 아예 부르지 않는다.
 * 어떤 경우에도 예외를 밖으로 던지지 않고, 민감한 값은 결과에 담지 않는다.
 */
export async function runFunctionCheck(deps: FunctionCheckDeps): Promise<FunctionCheckResult> {
  let session: SessionSummary;
  try {
    session = await deps.ensureSession();
  } catch {
    return { status: 'failed', sessionReady: false, failure: 'AUTH_FAILED' };
  }

  if (!session.sessionExists) {
    return { status: 'failed', sessionReady: false, failure: 'AUTH_FAILED' };
  }

  let response: { data: unknown; error: unknown };
  try {
    response = await deps.invokeRecommendScripture({ situation: FUNCTION_CHECK_SITUATION });
  } catch {
    // 원본 오류는 화면에도 콘솔에도 남기지 않는다.
    return { status: 'failed', sessionReady: true, failure: 'FUNCTION_FAILED' };
  }

  if (response.error) {
    return { status: 'failed', sessionReady: true, failure: 'FUNCTION_FAILED' };
  }

  const parsed = parseResponse(response.data);
  if (!parsed) {
    return { status: 'failed', sessionReady: true, failure: 'UNEXPECTED_RESPONSE' };
  }

  return {
    status: 'ok',
    sessionReady: true,
    route: parsed.route,
    primaryDomain: parsed.primaryDomain,
    selectedCardId: parsed.selectedCardId,
    safetyLevel: parsed.safetyLevel,
    matchesExpectation:
      parsed.route === EXPECTED.route &&
      parsed.primaryDomain === EXPECTED.primaryDomain &&
      parsed.selectedCardId === EXPECTED.selectedCardId &&
      parsed.safetyLevel === EXPECTED.safetyLevel,
  };
}
