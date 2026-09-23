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
import { isChoosableDomain } from './domain-choice-resolution.ts';
import type { SituationDomain } from '../data/situation-domains.ts';
import {
  DOMAIN_ID_FORMAT,
} from '../../supabase/functions/_shared/automatic-scripture-catalog-contract.ts';
import {
  SCRIPTURE_CATALOG_RUNTIME_CLIENT_VERSION,
  parseRuntimeCardView,
  parseRuntimeDomainView,
  type RuntimeCardView,
} from '../../supabase/functions/_shared/automatic-scripture-catalog-runtime.ts';

export const GATE_ROUTES = ['recommend', 'no_coverage', 'safety', 'ambiguous', 'domain_choice'] as const;
export type GateRouteName = (typeof GATE_ROUTES)[number];

/** domain_choice에서 후보 영역 하나를 골랐을 때의 결과. `docs/RECOMMENDATION_GATE.md` 참고. */
export type DomainChoiceResolution = 'recommend' | 'ambiguous' | 'no_coverage';

const DOMAIN_CHOICE_RESOLUTIONS: readonly DomainChoiceResolution[] = ['recommend', 'ambiguous', 'no_coverage'];
const isDomainChoiceResolution = (value: unknown): value is DomainChoiceResolution =>
  typeof value === 'string' && (DOMAIN_CHOICE_RESOLUTIONS as readonly string[]).includes(value);

export type DomainChoiceOption = {
  domain: string;
  /** 활성 카탈로그가 제공한 사용자 표시 이름. 예전 정적 응답에서는 없을 수 있다. */
  displayName?: string;
  resolution: DomainChoiceResolution;
  /** resolution이 recommend일 때만 카드 번호가 있다. */
  selectedCardId: string | null;
  selectedCard?: RuntimeCardView;
};

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
  invokeRecommendScripture: (body: {
    situation: string;
    catalogRuntimeVersion: typeof SCRIPTURE_CATALOG_RUNTIME_CLIENT_VERSION;
  }) => Promise<InvokeOutcome>;
  /** 로컬 Scripture Card에 실제로 있는 id인지 확인한다. */
  cardExists: (cardId: string) => boolean;
  /** 카드가 실제로 그 영역에 속하는지 확인한다. recommend와 domain_choice option 검증에 쓴다. */
  cardBelongsToDomain: (cardId: string, domain: SituationDomain) => boolean;
};

export type RecommendationOutcome =
  | { status: 'recommend'; cardId: string; selectedDomain: string; card?: RuntimeCardView }
  /** 중심 영역을 하나로 정할 근거가 없어, 사용자가 고를 두 후보를 그대로 전달한다. */
  | { status: 'domain_choice'; options: [DomainChoiceOption, DomainChoiceOption] }
  | { status: 'route'; route: Exclude<GateRouteName, 'recommend' | 'domain_choice'> }
  /**
   * auth: 세션 준비 실패 / rate_limited: 사용량 제한 / general: 그 밖의 실패
   * diagnostic은 개발 모드에서만 화면에 낸다. 사용자 문구(kind)는 바꾸지 않는다.
   */
  | { status: 'error'; kind: 'auth' | 'rate_limited' | 'general'; diagnostic: DevDiagnosticCode };

const isGateRoute = (value: unknown): value is GateRouteName =>
  typeof value === 'string' && (GATE_ROUTES as readonly string[]).includes(value);

const INVALID_RESPONSE = {
  status: 'error',
  kind: 'general',
  diagnostic: 'FUNCTION_RESPONSE_INVALID',
} as const;

/** 응답에서 이 흐름이 쓸 값만 꺼낸다. 모양이 다르면 null. */
function parseGateResponse(data: unknown): {
  route: GateRouteName;
  selectedCardId: unknown;
  primaryDomain: unknown;
  domainChoiceCandidates: unknown;
  domainChoiceOptions: unknown;
  cards: unknown;
  domains: unknown;
} | null {
  if (typeof data !== 'object' || data === null) return null;

  const { ok, result, cards, domains } = data as {
    ok?: unknown; result?: unknown; cards?: unknown; domains?: unknown;
  };
  if (ok !== true) return null;
  if (typeof result !== 'object' || result === null) return null;

  const { route, selectedCardId, primaryDomain, domainChoiceCandidates, domainChoiceOptions } =
    result as Record<string, unknown>;
  if (!isGateRoute(route)) return null;

  return { route, selectedCardId, primaryDomain, domainChoiceCandidates, domainChoiceOptions, cards, domains };
}

function parseRuntimeViews(cards: unknown, domains: unknown) {
  if (cards === undefined && domains === undefined) return { cards: new Map<string, RuntimeCardView>(), domains: new Map<string, string>(), legacy: true };
  if (!Array.isArray(cards) || !Array.isArray(domains)) return null;
  const cardMap = new Map<string, RuntimeCardView>();
  for (const raw of cards) {
    const card = parseRuntimeCardView(raw);
    if (!card || cardMap.has(card.id)) return null;
    cardMap.set(card.id, card);
  }
  const domainMap = new Map<string, string>();
  for (const raw of domains) {
    const domain = parseRuntimeDomainView(raw);
    if (!domain || domainMap.has(domain.id)) return null;
    domainMap.set(domain.id, domain.displayName);
  }
  return { cards: cardMap, domains: domainMap, legacy: false };
}

/**
 * domain_choice 응답의 두 후보와 두 option을 검증한다.
 *
 *   - 후보와 option 모두 정확히 둘이고, 같은 순서로 짝지어진다 (순서는 우선순위를 뜻하지 않는다).
 *   - 후보는 서로 다른, 사용자가 고를 수 있는 표준 영역이어야 한다(other_uncovered 불가, 중복 불가).
 *   - resolution이 recommend면 카드가 실제로 있고 그 영역에 속해야 한다.
 *   - resolution이 ambiguous/no_coverage면 카드 번호가 없어야 한다.
 *
 * 하나라도 어긋나면 null이다. 서버 응답을 그대로 믿고 화면에 넘기지 않는다.
 */
function parseDomainChoiceOptions(
  domainChoiceCandidates: unknown,
  domainChoiceOptions: unknown,
  deps: Pick<RecommendationDeps, 'cardExists' | 'cardBelongsToDomain'>,
  views: NonNullable<ReturnType<typeof parseRuntimeViews>>,
): [DomainChoiceOption, DomainChoiceOption] | null {
  if (!Array.isArray(domainChoiceCandidates) || domainChoiceCandidates.length !== 2) return null;
  if (!domainChoiceCandidates.every((domain) =>
    typeof domain === 'string' && domain !== 'other_uncovered' &&
    (isChoosableDomain(domain) || (DOMAIN_ID_FORMAT.test(domain) && views.domains.has(domain))))) return null;
  const candidates = domainChoiceCandidates as string[];
  if (candidates[0] === candidates[1]) return null;

  if (!Array.isArray(domainChoiceOptions) || domainChoiceOptions.length !== 2) return null;

  const options: DomainChoiceOption[] = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const raw = domainChoiceOptions[index];
    if (typeof raw !== 'object' || raw === null) return null;

    const { domain, resolution, selectedCardId } = raw as Record<string, unknown>;
    // 순서가 일치해야 한다: option[i]는 candidates[i]에 대한 결과여야 한다.
    // 이 시점부터 candidates[index]가 검증된 값이므로 domain 대신 그 값을 쓴다.
    if (domain !== candidates[index]) return null;
    const optionDomain = candidates[index]!;
    if (!isDomainChoiceResolution(resolution)) return null;

    if (resolution === 'recommend') {
      if (typeof selectedCardId !== 'string') return null;
      const card = views.cards.get(selectedCardId);
      if (card) {
        if (!card.domains.includes(optionDomain)) return null;
      } else {
        if (!views.legacy || !deps.cardExists(selectedCardId)) return null;
        if (!deps.cardBelongsToDomain(selectedCardId, optionDomain as SituationDomain)) return null;
      }
      options.push({
        domain: optionDomain,
        ...(views.domains.has(optionDomain) ? { displayName: views.domains.get(optionDomain)! } : {}),
        resolution,
        selectedCardId,
        ...(card ? { selectedCard: card } : {}),
      });
    } else {
      if (selectedCardId !== null) return null;
      options.push({
        domain: optionDomain,
        ...(views.domains.has(optionDomain) ? { displayName: views.domains.get(optionDomain)! } : {}),
        resolution,
        selectedCardId: null,
      });
    }
  }

  return [options[0]!, options[1]!];
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
    outcome = await deps.invokeRecommendScripture({
      situation,
      catalogRuntimeVersion: SCRIPTURE_CATALOG_RUNTIME_CLIENT_VERSION,
    });
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
    return INVALID_RESPONSE;
  }
  const views = parseRuntimeViews(parsed.cards, parsed.domains);
  if (!views) return INVALID_RESPONSE;

  if (parsed.route === 'domain_choice') {
    // domain_choice는 top-level 카드를 고르지 않은 상태다. 문서(RECOMMENDATION_GATE.md STEP 1-1)대로
    // primaryDomain과 top-level selectedCardId가 모두 비어 있어야 한다. 둘 중 하나라도 값이 있으면
    // option이 아무리 멀쩡해도 서로 모순된 응답이므로 option을 읽기 전에 거절한다.
    if (parsed.primaryDomain !== null || parsed.selectedCardId !== null) {
      return INVALID_RESPONSE;
    }

    const options = parseDomainChoiceOptions(parsed.domainChoiceCandidates, parsed.domainChoiceOptions, deps, views);
    if (!options) return INVALID_RESPONSE;
    return { status: 'domain_choice', options };
  }

  if (parsed.route !== 'recommend') {
    return { status: 'route', route: parsed.route };
  }

  // recommend인데 카드가 없거나 우리가 모르는 id면 임의의 카드로 대체하지 않는다.
  if (typeof parsed.selectedCardId !== 'string') {
    return INVALID_RESPONSE;
  }

  const runtimeCard = views.cards.get(parsed.selectedCardId);
  if (!runtimeCard && (!views.legacy || !deps.cardExists(parsed.selectedCardId))) return INVALID_RESPONSE;

  // 영역이 표준값이 아니거나, 고른 카드가 실제로 그 영역에 속하지 않으면 믿지 않는다.
  const domainAllowed = typeof parsed.primaryDomain === 'string' && parsed.primaryDomain !== 'other_uncovered' &&
    (isChoosableDomain(parsed.primaryDomain) ||
      (DOMAIN_ID_FORMAT.test(parsed.primaryDomain) && views.domains.has(parsed.primaryDomain)));
  const cardBelongs = runtimeCard
    ? typeof parsed.primaryDomain === 'string' && runtimeCard.domains.includes(parsed.primaryDomain)
    : domainAllowed && deps.cardBelongsToDomain(parsed.selectedCardId, parsed.primaryDomain as SituationDomain);
  if (!domainAllowed || !cardBelongs) {
    return INVALID_RESPONSE;
  }

  return {
    status: 'recommend', cardId: parsed.selectedCardId, selectedDomain: parsed.primaryDomain as string,
    ...(runtimeCard ? { card: runtimeCard } : {}),
  };
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
