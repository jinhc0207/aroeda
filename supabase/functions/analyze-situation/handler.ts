/**
 * analyze-situation · 요청 처리 본체
 *
 * 이 파일에는 Deno 전용 코드를 넣지 않는다.
 * API Key 읽기와 서버 시작은 index.ts가 맡고, 여기서는 순수하게 요청 → 응답만 처리한다.
 * 그래야 실제 OpenAI 호출 없이 Node에서도 테스트할 수 있다.
 *
 * 하는 일:
 *   사용자 문장 → OpenAI Situation Analyzer → validateSituationAnalysis → JSON 반환
 *
 * 입력 규칙과 Analyzer 호출은 recommend-scripture와 똑같이 ../_shared/edge-analyzer.ts를 쓴다.
 * Recommendation Gate는 여기서 실행하지 않는다. recommend-scripture가 담당한다.
 *
 * 개인정보 원칙:
 *   - 사용자의 문장을 저장하지 않는다.
 *   - 로그에 문장 원문이나 OpenAI 응답 전체를 남기지 않는다.
 *   - OpenAI 요청은 store: false로 보낸다.
 */

import {
  MAX_SITUATION_LENGTH,
  analyzeSituationRequest,
  buildOpenAIPayload,
  errorResponse,
  extractOutputText,
  jsonResponse,
  toAnalysisPayload,
  type EdgeDeps,
  type ErrorBody,
  type ErrorCode,
} from '../_shared/edge-analyzer.ts';
import type { SituationAnalysis } from '../_shared/situation-analysis.ts';

export {
  MAX_SITUATION_LENGTH,
  buildOpenAIPayload,
  extractOutputText,
  errorResponse,
  jsonResponse,
};
export type { ErrorCode, ErrorBody };

export type SuccessBody = { ok: true; analysis: SituationAnalysis };

/** 기존 이름을 유지한다. 내용은 공용 EdgeDeps와 같다. */
export type Handlerdeps = EdgeDeps;

export async function handleAnalyzeSituation(
  request: Request,
  deps: Handlerdeps,
): Promise<Response> {
  const step = await analyzeSituationRequest(request, deps);
  if (!step.ok) return step.response;

  // OpenAI 원본 응답과 usage는 제품 응답에 포함하지 않는다.
  return jsonResponse({ ok: true, analysis: toAnalysisPayload(step.analysis) } satisfies SuccessBody, 200);
}
