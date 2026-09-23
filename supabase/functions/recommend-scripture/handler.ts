/**
 * recommend-scripture · 요청 처리 본체
 *
 * 흐름:
 *   사용자 문장
 *   → OpenAI Situation Analyzer (analyze-situation과 완전히 같은 규칙)
 *   → validateSituationAnalysis
 *   → Recommendation Gate
 *   → route 반환
 *
 * 이번 단계에서는 Gate 판단까지만 한다.
 * 성경 원문, 사용자용 설명, 기도 방향, 안전 안내 문구는 여기서 만들지 않는다.
 *
 * 이 파일에는 Deno 전용 코드를 넣지 않는다. Node에서도 그대로 테스트한다.
 *
 * 개인정보 원칙:
 *   - 사용자의 문장을 저장하지 않는다.
 *   - 로그에 문장 원문이나 OpenAI 응답 전체를 남기지 않는다.
 *   - OpenAI 요청은 store: false로 보낸다.
 *   - 제품 응답에 OpenAI 원본과 usage를 넣지 않는다.
 */

import {
  MAX_SITUATION_LENGTH,
  analyzeSituationRequest,
  buildOpenAIPayload,
  errorResponse,
  extractOutputText,
  jsonResponse,
  type EdgeDeps,
  type ErrorBody,
  type ErrorCode,
} from '../_shared/edge-analyzer.ts';
import {
  recordCoverageGapIfNeeded,
  type CoverageGapRecorder,
} from '../_shared/coverage-gap.ts';
import { runRecommendationGate, type GateResult } from '../_shared/recommendation-gate.ts';
import {
  parseScriptureCatalogClientMode,
  projectRuntimeCardView,
  scriptureCatalogRuntimeForClient,
  type RuntimeCardView,
  type RuntimeDomainView,
} from '../_shared/automatic-scripture-catalog-runtime.ts';

export {
  MAX_SITUATION_LENGTH,
  buildOpenAIPayload,
  extractOutputText,
  errorResponse,
  jsonResponse,
};
export type { ErrorCode, ErrorBody };

/**
 * analyze-situation과 같은 형태의 의존성 +
 * no_coverage 통계 기록기(선택). 통계는 실패해도 응답을 막지 않는다(fail-open).
 */
export type Handlerdeps = EdgeDeps & {
  recordCoverageGap?: CoverageGapRecorder;
};

export type DynamicCatalogSuccessBody = {
  ok: true;
  result: GateResult<string>;
  cards: RuntimeCardView[];
  domains: RuntimeDomainView[];
};
export type LegacyCatalogSuccessBody = { ok: true; result: GateResult<string> };
export type SuccessBody = DynamicCatalogSuccessBody | LegacyCatalogSuccessBody;

/**
 * 새 앱만 동적 카탈로그 응답을 받는다. 표시가 없는 구 앱은 정적 id 계약을 유지한다.
 * JSON·method·situation 검증 자체는 공용 analyzer가 담당하므로 여기서는 capability만 읽는다.
 */
async function readClientCatalogMode(request: Request) {
  if (request.method !== 'POST') return 'legacy';
  let body: unknown;
  try {
    body = await request.clone().json();
  } catch {
    return 'legacy';
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return 'legacy';
  return parseScriptureCatalogClientMode(body);
}

export async function handleRecommendScripture(
  request: Request,
  deps: Handlerdeps,
): Promise<Response> {
  const clientMode = await readClientCatalogMode(request);
  if (clientMode === 'invalid') return errorResponse('INVALID_INPUT', 400);

  // 구 앱도 먼저 활성 카탈로그를 정상 조회해야 한다. DB 오류 때 정적 카드로 우회하지 않는다.
  // 조회가 성공한 경우에만 구 앱이 이해하는 기존 정적 Analyzer·Gate 계약을 사용한다.
  const analysisDeps: Handlerdeps = clientMode === 'dynamic'
    ? deps
    : {
        ...deps,
        loadCatalogRuntime: async (options) => {
          const active = await deps.loadCatalogRuntime(options);
          return scriptureCatalogRuntimeForClient(active, 'legacy');
        },
      };
  const step = await analyzeSituationRequest(request, analysisDeps);
  if (!step.ok) return step.response;

  // 분석 결과를 손대지 않고 그대로 Gate에 넘긴다. 태그를 보정하지 않는다.
  // Analyzer가 본 것과 정확히 같은 활성 카탈로그 스냅샷의 카드만 Gate에 넘긴다.
  const result = runRecommendationGate(step.analysis, step.runtime.cards);

  // Gate 판단이 끝난 뒤, no_coverage일 때만 영역 이름 하나를 통계에 기록한다.
  // 사용자 문장은 넘기지 않는다. 실패해도 아래 응답은 그대로 나간다.
  await recordCoverageGapIfNeeded(result, deps.recordCoverageGap);

  // 구 앱은 cards/domains를 해석할 수 없으며 로컬 정적 카드만 안다. 기존 응답 모양을 유지한다.
  if (clientMode === 'legacy') {
    return jsonResponse({ ok: true, result } satisfies LegacyCatalogSuccessBody, 200);
  }

  const selectedIds = new Set([
    result.selectedCardId,
    ...result.domainChoiceOptions.map((option) => option.selectedCardId),
  ].filter((id): id is string => id !== null));
  const cards = step.runtime.cards
    .filter((card) => selectedIds.has(card.id))
    .map(projectRuntimeCardView);
  const domainIds = new Set([
    result.primaryDomain,
    ...result.domainChoiceCandidates,
  ].filter((id): id is string => id !== null));
  const domains = step.runtime.catalog.domains
    .filter((domain) => domainIds.has(domain.id))
    .map(({ id, displayName }) => ({ id, displayName }));

  return jsonResponse({ ok: true, result, cards, domains } satisfies DynamicCatalogSuccessBody, 200);
}
