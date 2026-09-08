/**
 * 첫 화면에서 서버에 말씀 추천을 요청하는 흐름
 *
 *   사용자 문장 → 익명 세션 확인 → recommend-scripture 호출 → Gate 결과 확인
 *
 * 원칙
 *   - 사용자의 문장을 저장하거나 로그에 남기지 않는다. 메모리에서만 쓴다.
 *   - 서버 응답을 그대로 믿지 않는다. 모양이 이상하면 임의의 카드로 대체하지 않는다.
 *   - 추천 카드가 실제 로컬 Scripture Card에 있어야만 recommend로 인정한다.
 *   - 어떤 경우에도 SC-001 같은 기본 카드로 되돌리지 않는다.
 *
 * 이 파일은 Supabase 클라이언트를 직접 불러오지 않는다.
 * 필요한 동작만 인자로 받기 때문에 실제 서버 없이도 테스트할 수 있다.
 */

import type { SessionSummary } from './anonymous-session.ts';

export const GATE_ROUTES = ['recommend', 'no_coverage', 'safety', 'ambiguous'] as const;
export type GateRouteName = (typeof GATE_ROUTES)[number];

/**
 * 개발자만 보는 실패 진단 코드.
 *
 * 사용자에게 보이는 문구(kind)는 그대로 두고, 어느 단계에서 왜 멈췄는지만
 * 개발 모드에서 구분해 볼 수 있게 한다. 토큰·세션·응답 본문은 담지 않는다.
 *
 *   NONE                      — 실패가 아니거나, 어느 단계에도 닿지 못했다(빈 입력 등)
 *   AUTH_SESSION_PREP_FAILED  — 익명 세션 준비 실패
 *   FUNCTION_INVOKE_FAILED    — invoke 호출 자체가 예외를 던졌다
 *   FUNCTION_NETWORK_FAILED   — invoke는 끝났지만 상태 코드를 알 수 없다(네트워크 계열)
 *   FUNCTION_HTTP_401         — 인증 거부
 *   FUNCTION_HTTP_429         — 사용량 제한
 *   FUNCTION_HTTP_5XX         — 서버 오류
 *   FUNCTION_HTTP_OTHER       — 그 밖의 상태 코드
 *   FUNCTION_RESPONSE_INVALID — 응답은 받았지만 모양이 계약과 다르다
 */
export type DevDiagnosticCode =
  | 'NONE'
  | 'AUTH_SESSION_PREP_FAILED'
  | 'FUNCTION_INVOKE_FAILED'
  | 'FUNCTION_NETWORK_FAILED'
  | 'FUNCTION_HTTP_401'
  | 'FUNCTION_HTTP_429'
  | 'FUNCTION_HTTP_5XX'
  | 'FUNCTION_HTTP_OTHER'
  | 'FUNCTION_RESPONSE_INVALID';

/** 화면에서 서버 호출을 감싸 넘겨주는 결과. supabase 오류를 여기서 단순한 모양으로 바꾼다. */
export type InvokeOutcome =
  | { ok: true; data: unknown }
  | { ok: false; httpStatus?: number };

export type RecommendationDeps = {
  ensureSession: () => Promise<SessionSummary>;
  invokeRecommendScripture: (body: { situation: string }) => Promise<InvokeOutcome>;
  /** 로컬 Scripture Card에 실제로 있는 id인지 확인한다. */
  cardExists: (cardId: string) => boolean;
};

export type RecommendationOutcome =
  | { status: 'recommend'; cardId: string }
  | { status: 'route'; route: Exclude<GateRouteName, 'recommend'> }
  /**
   * auth: 세션 준비 실패 / rate_limited: 사용량 제한 / general: 그 밖의 실패
   * diagnostic은 개발 모드에서만 화면에 낸다. 사용자 문구(kind)는 바꾸지 않는다.
   */
  | { status: 'error'; kind: 'auth' | 'rate_limited' | 'general'; diagnostic: DevDiagnosticCode };

const isGateRoute = (value: unknown): value is GateRouteName =>
  typeof value === 'string' && (GATE_ROUTES as readonly string[]).includes(value);

/** 응답에서 route와 카드 id만 꺼낸다. 모양이 다르면 null. */
function parseGateResponse(data: unknown): { route: GateRouteName; selectedCardId: unknown } | null {
  if (typeof data !== 'object' || data === null) return null;

  const { ok, result } = data as { ok?: unknown; result?: unknown };
  if (ok !== true) return null;
  if (typeof result !== 'object' || result === null) return null;

  const { route, selectedCardId } = result as { route?: unknown; selectedCardId?: unknown };
  if (!isGateRoute(route)) return null;

  return { route, selectedCardId };
}

/**
 * 말씀 추천을 한 번 요청한다.
 * 세션이 준비되지 않으면 서버를 부르지 않는다.
 * 어떤 경우에도 예외를 밖으로 던지지 않는다.
 */
export async function requestRecommendation(
  situation: string,
  deps: RecommendationDeps,
): Promise<RecommendationOutcome> {
  if (situation.trim().length === 0) {
    return { status: 'error', kind: 'general', diagnostic: 'NONE' };
  }

  let session: SessionSummary;
  try {
    session = await deps.ensureSession();
  } catch {
    return { status: 'error', kind: 'auth', diagnostic: 'AUTH_SESSION_PREP_FAILED' };
  }

  if (!session.sessionExists) {
    return { status: 'error', kind: 'auth', diagnostic: 'AUTH_SESSION_PREP_FAILED' };
  }

  let outcome: InvokeOutcome;
  try {
    outcome = await deps.invokeRecommendScripture({ situation });
  } catch {
    return { status: 'error', kind: 'general', diagnostic: 'FUNCTION_INVOKE_FAILED' };
  }

  if (!outcome.ok) {
    // 사용량 제한만 따로 구분한다. 나머지는 모두 일반 오류로 다룬다.
    return {
      status: 'error',
      kind: outcome.httpStatus === 429 ? 'rate_limited' : 'general',
      diagnostic: diagnosticForHttpFailure(outcome.httpStatus),
    };
  }

  const parsed = parseGateResponse(outcome.data);
  if (!parsed) {
    return { status: 'error', kind: 'general', diagnostic: 'FUNCTION_RESPONSE_INVALID' };
  }

  if (parsed.route !== 'recommend') {
    return { status: 'route', route: parsed.route };
  }

  // recommend인데 카드가 없거나 우리가 모르는 id면 임의의 카드로 대체하지 않는다.
  if (typeof parsed.selectedCardId !== 'string' || !deps.cardExists(parsed.selectedCardId)) {
    return { status: 'error', kind: 'general', diagnostic: 'FUNCTION_RESPONSE_INVALID' };
  }

  return { status: 'recommend', cardId: parsed.selectedCardId };
}

/** invoke가 실패로 끝났을 때 상태 코드만으로 안전하게 분류한다. 응답 본문은 보지 않는다. */
function diagnosticForHttpFailure(httpStatus: number | undefined): DevDiagnosticCode {
  if (httpStatus === undefined) return 'FUNCTION_NETWORK_FAILED';
  if (httpStatus === 401) return 'FUNCTION_HTTP_401';
  if (httpStatus === 429) return 'FUNCTION_HTTP_429';
  if (httpStatus >= 500) return 'FUNCTION_HTTP_5XX';
  return 'FUNCTION_HTTP_OTHER';
}

/**
 * 개발 모드에서만 보여줄 진단 문구를 만든다.
 *
 * production에서는 항상 null이다. isDev를 인자로 받기 때문에
 * 전역 __DEV__를 건드리지 않고도 두 경우를 모두 테스트할 수 있다.
 */
export function formatDevDiagnostic(isDev: boolean, diagnostic: DevDiagnosticCode | null): string | null {
  if (!isDev) return null;
  if (!diagnostic || diagnostic === 'NONE') return null;
  return `개발 진단: ${diagnostic}`;
}
