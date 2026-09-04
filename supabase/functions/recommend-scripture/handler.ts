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

export type SuccessBody = { ok: true; result: GateResult };

export async function handleRecommendScripture(
  request: Request,
  deps: Handlerdeps,
): Promise<Response> {
  const step = await analyzeSituationRequest(request, deps);
  if (!step.ok) return step.response;

  // 분석 결과를 손대지 않고 그대로 Gate에 넘긴다. 태그를 보정하지 않는다.
  const result = runRecommendationGate(step.analysis);

  // Gate 판단이 끝난 뒤, no_coverage일 때만 영역 이름 하나를 통계에 기록한다.
  // 사용자 문장은 넘기지 않는다. 실패해도 아래 응답은 그대로 나간다.
  await recordCoverageGapIfNeeded(result, deps.recordCoverageGap);

  return jsonResponse({ ok: true, result } satisfies SuccessBody, 200);
}
