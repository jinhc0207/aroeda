/**
 * research-prioritizer · 요청 처리 본체
 *
 * 내부 전용 기능이다. 앱 사용자가 부르는 기능이 아니다.
 *
 * 흐름:
 *   POST 확인 → 내부 권한 확인 → Queue 읽기(RPC) → 지금 카드가 다루는 영역
 *   → 후보 선별 → snapshotId → Evaluator A/B 각각 독립 호출 → 검증 → 합의 판단
 *   → 합의가 났을 때만 그 판단을 표에 적고(RPC) 번호를 받아 함께 돌려준다
 *
 * 표에 적는 것은 합의 뒤 한 번뿐이다.
 * 적지 못하면 합의를 성공으로 내보내지 않는다. 번호 없는 판단은 넘겨줄 수 없기 때문이다.
 *
 * 하지 않는 일:
 *   - Queue 상태·근거·Coverage Gap·Scripture Card 수정 (읽기만 한다)
 *   - refresh_content_research_queue() 호출
 *   - 사용자용 사용량 제한(consume_openai_quota) 사용
 *   - 임의 tie-break, Arbiter
 *
 * 로그와 응답에 토큰, Authorization 값, Queue 원본, OpenAI 원본, evaluator 내용은 남기지 않는다.
 *
 * 브라우저에서 부르는 기능이 아니므로 CORS 헤더를 붙이지 않는다.
 * POST가 아닌 요청(OPTIONS 포함)은 모두 거절한다.
 */

import {
  buildEvaluatorRequest,
  getActiveCoveredDomains,
  parseEvaluatorResult,
  toResearchQueue,
  type EvaluatorName,
} from '../_shared/research-prioritizer-edge.ts';
import {
  buildEvaluationPayload,
  computeSnapshotId,
  decidePriority,
  selectEligibleCandidates,
  type PrioritizerOutcome,
} from '../_shared/research-prioritizer.ts';
import { computeActiveCoveredHash } from '../_shared/harvest-recovery-ticket.ts';
import {
  describeDecisionCreateFailure,
  isDecisionId,
  validatePrioritizerDecisionInput,
  type PrioritizerDecisionInput,
} from '../_shared/prioritizer-decision.ts';

export type ErrorCode =
  | 'METHOD_NOT_ALLOWED'
  | 'UNAUTHORIZED'
  | 'QUEUE_UNAVAILABLE'
  | 'INVALID_QUEUE_RESPONSE'
  | 'OPENAI_API_KEY_MISSING'
  | 'EVALUATOR_REQUEST_FAILED'
  // 합의는 났지만 그 판단을 서버가 적어 두지 못했다. Queue를 읽지 못한 경우와 같은 자리다.
  | 'DECISION_STORE_UNAVAILABLE'
  | 'INTERNAL_ERROR';

export type ErrorBody = { ok: false; error: ErrorCode };

/** 밖으로 내보내는 결과. 점수·순위·reason·confidence·원본 응답은 넣지 않는다. */
export type PublicResult =
  | {
      status: 'consensus';
      recommendedDomain: string;
      evidenceVersion: number;
      snapshotId: string;
      /** 이 판단을 한 번만 쓸 수 있는 번호. 표의 내용도, 수명도 함께 나가지 않는다. */
      decisionId: string;
    }
  | { status: 'recheck' }
  | { status: 'no_eligible_research' }
  | { status: 'stale_evidence' };

export type SuccessBody = { ok: true; result: PublicResult };

export type Handlerdeps = {
  /** 내부 호출인지 확인한다. 실패하면 Queue도 OpenAI도 부르지 않는다. */
  isAuthorized: (request: Request) => boolean | Promise<boolean>;
  /** get_content_research_queue_for_prioritizer() 결과 */
  fetchQueue: () => Promise<unknown>;
  getApiKey: () => string | undefined;
  /** Evaluator 한 명분 호출. A/B를 각각 따로 부른다. */
  callOpenAI: (payload: Record<string, unknown>, apiKey: string) => Promise<unknown>;
  /** 지금 카드가 다루는 영역 (기본값은 canonical 카드 데이터에서 뽑는다) */
  getActiveCoveredDomains?: () => string[];
  /**
   * 합의된 판단을 표에 적고 번호를 돌려준다. 합의가 났을 때만, 최대 한 번 부른다.
   *
   * 실제 DB 연결(주소, 서비스 역할 키, fetch)은 여기서 하지 않는다.
   * 없으면 판단을 적을 수 없는 것으로 보고 합의를 성공으로 돌려주지 않는다.
   */
  createPrioritizerDecision?: (input: PrioritizerDecisionInput) => Promise<unknown>;
  log?: (message: string) => void;
  requestId?: () => string;
};

const jsonResponse = (body: SuccessBody | ErrorBody, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

/** Gate 결과에서 밖으로 낼 수 있는 값만 남긴다. */
function toPublicResult(outcome: PrioritizerOutcome, decisionId?: string): PublicResult {
  if (outcome.status === 'consensus') {
    // 번호 없이 합의를 성공으로 내보내지 않는다. 여기까지 왔다면 번호가 있다.
    return {
      status: 'consensus',
      recommendedDomain: outcome.recommendedDomain,
      evidenceVersion: outcome.evidenceVersion,
      snapshotId: outcome.snapshotId,
      decisionId: decisionId as string,
    };
  }
  // recheck의 내부 사유 코드도 밖으로 내보내지 않는다.
  return { status: outcome.status };
}

export async function handleResearchPrioritizer(
  request: Request,
  deps: Handlerdeps,
): Promise<Response> {
  const log = deps.log ?? (() => {});
  const requestId = deps.requestId ? deps.requestId() : 'req';
  const fail = (code: ErrorCode, status: number) => {
    log(`[${requestId}] ${code} ${status}`);
    return jsonResponse({ ok: false, error: code }, status);
  };

  // 사전 요청(OPTIONS)도 따로 허용하지 않는다. 내부 전용 endpoint다.
  if (request.method !== 'POST') {
    return fail('METHOD_NOT_ALLOWED', 405);
  }

  // 내부 권한 확인이 먼저다. 실패하면 Queue도 OpenAI도 부르지 않는다.
  let authorized = false;
  try {
    authorized = await deps.isAuthorized(request);
  } catch {
    authorized = false;
  }
  if (!authorized) {
    return fail('UNAUTHORIZED', 401);
  }

  let rawQueue: unknown;
  try {
    rawQueue = await deps.fetchQueue();
  } catch {
    return fail('QUEUE_UNAVAILABLE', 503);
  }

  const queue = toResearchQueue(rawQueue);
  if (!queue) {
    // Queue 원본은 로그에도 남기지 않는다.
    return fail('INVALID_QUEUE_RESPONSE', 502);
  }

  const activeCoveredDomains = (deps.getActiveCoveredDomains ?? getActiveCoveredDomains)();

  let candidates: ReturnType<typeof selectEligibleCandidates>;
  try {
    candidates = selectEligibleCandidates(queue, activeCoveredDomains);
  } catch {
    return fail('INTERNAL_ERROR', 500);
  }

  // 후보가 없으면 AI를 부르지 않는다.
  if (candidates.length === 0) {
    return jsonResponse({ ok: true, result: { status: 'no_eligible_research' } }, 200);
  }

  const apiKey = deps.getApiKey();
  if (!apiKey || apiKey.trim().length === 0) {
    return fail('OPENAI_API_KEY_MISSING', 500);
  }

  let evaluationA: unknown;
  let evaluationB: unknown;
  try {
    const payload = await buildEvaluationPayload(candidates, activeCoveredDomains);

    // A와 B는 서로의 결과를 보지 않는다. 같은 근거로 각각 따로 부른다.
    const requestFor = (evaluator: EvaluatorName) =>
      deps.callOpenAI(buildEvaluatorRequest(evaluator, payload, activeCoveredDomains), apiKey);

    const [rawA, rawB] = await Promise.all([requestFor('A'), requestFor('B')]);

    evaluationA = parseEvaluatorResult(rawA);
    evaluationB = parseEvaluatorResult(rawB);
  } catch {
    // 요청 자체가 실패한 경우다. 원본 오류는 남기지 않는다.
    return fail('EVALUATOR_REQUEST_FAILED', 502);
  }

  // 요청은 됐지만 평가 결과를 얻지 못한 경우(빈 응답, JSON 아님, 거절, 중간에 끊김).
  // 근거가 낡은 것이 아니라 판단이 이뤄지지 않은 것이므로 다시 본다. 자동 재시도는 하지 않는다.
  if (evaluationA === null || evaluationB === null) {
    log(`[${requestId}] evaluator_result_unusable`);
    return jsonResponse({ ok: true, result: { status: 'recheck' } }, 200);
  }

  let outcome: PrioritizerOutcome;
  try {
    outcome = await decidePriority({
      queue,
      activeCoveredDomains,
      evaluationA,
      evaluationB,
    });
  } catch {
    return fail('INTERNAL_ERROR', 500);
  }

  // 합의가 아니면 표에 적지 않는다.
  // 낡은 근거, 의견 불일치, 후보 없음은 모두 여기서 그대로 끝난다.
  if (outcome.status !== 'consensus') {
    return jsonResponse({ ok: true, result: toPublicResult(outcome) }, 200);
  }

  // 여기서부터는 합의가 확정된 뒤다.
  //
  // 판단을 서버가 적어 두어야 나중에 Source Harvester가
  // "정말 이 영역을 연구하기로 했는가"를 대조할 수 있다.
  // 적지 못했다면 합의를 성공으로 내보내지 않는다. 번호 없는 합의는 넘겨줄 수 없다.
  const storeFailed = (kind: string): Response => {
    // 밖으로 나가는 사유는 하나지만, 어느 자리에서 멈췄는지는 서버 기록에 남긴다.
    log(`[${requestId}] ${describeDecisionCreateFailure(kind)}`);
    return fail('DECISION_STORE_UNAVAILABLE', 503);
  };

  let activeCoveredHash: string;
  try {
    // 지문 규칙은 새로 만들지 않는다. Harvester가 쓰는 것과 같은 함수를 쓴다.
    activeCoveredHash = await computeActiveCoveredHash(activeCoveredDomains);
  } catch {
    return storeFailed('hash_failed');
  }

  const decisionInput: PrioritizerDecisionInput = {
    prioritizerSnapshotId: outcome.snapshotId,
    targetDomain: outcome.recommendedDomain,
    evidenceVersion: outcome.evidenceVersion,
    activeCoveredHash,
  };

  // 표에 보내기 전에 확인한다. 보내고 나서 확인하지 않는다.
  if (!validatePrioritizerDecisionInput(decisionInput).valid) {
    return storeFailed('input_invalid');
  }

  if (!deps.createPrioritizerDecision) {
    return storeFailed('not_configured');
  }

  let decisionId: unknown;
  try {
    // 정확히 한 번만 부른다. 실패해도 다시 부르지 않는다.
    decisionId = await deps.createPrioritizerDecision(decisionInput);
  } catch {
    // 원본 오류는 옮기지 않는다.
    return storeFailed('unknown');
  }

  // 표가 무엇을 돌려주든 그대로 믿지 않는다. 모양이 맞는 번호일 때만 쓴다.
  if (!isDecisionId(decisionId)) {
    return storeFailed('response_invalid');
  }

  return jsonResponse({ ok: true, result: toPublicResult(outcome, decisionId) }, 200);
}
