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
  /** auth: 세션 준비 실패 / rate_limited: 사용량 제한 / general: 그 밖의 실패 */
  | { status: 'error'; kind: 'auth' | 'rate_limited' | 'general' };

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
    return { status: 'error', kind: 'general' };
  }

  let session: SessionSummary;
  try {
    session = await deps.ensureSession();
  } catch {
    return { status: 'error', kind: 'auth' };
  }

  if (!session.sessionExists) {
    return { status: 'error', kind: 'auth' };
  }

  let outcome: InvokeOutcome;
  try {
    outcome = await deps.invokeRecommendScripture({ situation });
  } catch {
    return { status: 'error', kind: 'general' };
  }

  if (!outcome.ok) {
    // 사용량 제한만 따로 구분한다. 나머지는 모두 일반 오류로 다룬다.
    return { status: 'error', kind: outcome.httpStatus === 429 ? 'rate_limited' : 'general' };
  }

  const parsed = parseGateResponse(outcome.data);
  if (!parsed) {
    return { status: 'error', kind: 'general' };
  }

  if (parsed.route !== 'recommend') {
    return { status: 'route', route: parsed.route };
  }

  // recommend인데 카드가 없거나 우리가 모르는 id면 임의의 카드로 대체하지 않는다.
  if (typeof parsed.selectedCardId !== 'string' || !deps.cardExists(parsed.selectedCardId)) {
    return { status: 'error', kind: 'general' };
  }

  return { status: 'recommend', cardId: parsed.selectedCardId };
}
