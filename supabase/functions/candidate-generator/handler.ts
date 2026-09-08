/**
 * candidate-generator · 요청 처리 본체 (내부 전용)
 *
 * 앱 사용자가 부르는 기능이 아니다. 서버 전용 자격으로만 호출한다.
 *
 * 받는 것은 지문 하나뿐이다.
 *
 *   { researchResultHash }
 *
 *   연구 결과 본문은 받지 않는다. 부르는 쪽이 무엇을 보내든
 *   실제로 쓰는 연구 결과는 서버가 지문으로 다시 읽어 온 것뿐이다.
 *
 * 순서를 지킨다.
 *   POST 확인 → 내부 권한 확인 → 본문 검사 → 지문 모양 확인
 *   → 연구 결과 읽기(최대 1회) → 읽기 성공 확인
 *   → 기존 orchestrator(지문 재확인 → 모델 요청 최대 1회 → 조립 → 적어 두기)
 *   → 응답
 *
 * 권한 확인이 가장 먼저인 이유:
 *   인증되지 않은 호출자가 본문을 이용해 어떤 지문이 존재하는지
 *   두드려 볼 수 있으면 안 된다. 그래서 본문조차 읽기 전에 막는다.
 *
 * 이 파일이 하지 않는 일:
 *   지문 검증, 프롬프트 작성, 모델 호출, 초안 조립, 재시도 판단 —
 *   전부 orchestrator와 그 아래 계약이 갖고 있다. 여기서 다시 만들지 않는다.
 *   이 파일이 하는 일은 자격 확인과 바깥 연결(연구 결과 읽기, orchestrator 호출)뿐이다.
 *
 * 이 함수 자체는 DB에도 OpenAI에도 닿지 않는다. 실제 연결은 index.ts에 있다.
 *
 * 브라우저에서 부르는 기능이 아니므로 CORS 헤더를 붙이지 않는다.
 * POST가 아닌 요청(OPTIONS 포함)은 모두 거절한다.
 *
 * 로그와 응답에 토큰, API Key, 지문 전체, 연구 결과, 완성된 글,
 * 모델의 원본 응답, DB의 원본 오류를 남기지 않는다.
 */

import {
  validateResearchResultReadRequest,
  canProceedToProviderAfterRead,
  buildOrchestrationInputFromRead,
  type ResearchResultReadOutcome,
} from '../_shared/candidate-research-result-read-boundary-contract.ts';
import {
  runCandidateGenerationOrchestrator,
  type CandidateGenerationOrchestratorDependencies,
} from '../_shared/published-content-candidate-generation-orchestrator.ts';

export type ErrorCode =
  | 'METHOD_NOT_ALLOWED'
  | 'UNAUTHORIZED'
  | 'INVALID_JSON'
  | 'INVALID_REQUEST'
  /** 지문의 모양은 맞지만 그런 연구 결과가 서버에 없다. */
  | 'RESEARCH_RESULT_NOT_FOUND'
  /** 있는지 없는지조차 지금 알 수 없다. DB의 상세 사유는 옮기지 않는다. */
  | 'RESEARCH_RESULT_UNAVAILABLE'
  /**
   * 모델이 답한 뒤 조립·전처리 확인 중 하나가 실패했다.
   *
   * deterministic_preflight_failure(모델을 부르기도 전에 멈춤)와
   * candidate_build_failure(모델 답 이후 조립 실패)를 밖에서는 하나로 알린다.
   * 어느 쪽인지는 서버 기록에만 남긴다. operator가 재시도로 무엇을 바꿔야
   * 하는지는 둘 다 같다 — 다시 부를 수단이 없다.
   */
  | 'CANDIDATE_PROCESSING_FAILED'
  /** 모델 호출 자체가 실패했다(거절, 시간초과, 오류 등). 상세는 옮기지 않는다. */
  | 'CANDIDATE_GENERATION_UNAVAILABLE'
  | 'INTERNAL_ERROR';

export type ErrorBody = { ok: false; error: ErrorCode };
export type DeferredBody = { ok: true; category: 'deferred' };
export type GeneratedBody = { ok: true; candidateHash: string };
export type SuccessBody = GeneratedBody | DeferredBody;

/** 요청 본문에 올 수 있는 항목. 지문 하나뿐이다. */
export type CandidateGenerationRequestInput = { researchResultHash: string };

export type HandlerDeps = CandidateGenerationOrchestratorDependencies & {
  /** 내부 호출인지 확인한다. 실패하면 본문도 읽지 않고 DB도 건드리지 않는다. */
  isAuthorized: (request: Request) => boolean | Promise<boolean>;
  /**
   * 지문 하나로 authoritative 연구 결과를 읽어 온다.
   *
   * 실제 RPC 호출은 이 함수를 만드는 쪽(index.ts)이 한다.
   * 여기서는 결과만 받아서 committed read-boundary outcome으로 분기한다.
   */
  readResearchResult: (researchResultHash: string) => Promise<ResearchResultReadOutcome>;
  /** 이유 코드만 남긴다. 토큰, 지문, 연구 결과, 원본 응답은 남기지 않는다. */
  log?: (message: string) => void;
  requestId?: () => string;
};

const jsonResponse = (body: SuccessBody | ErrorBody, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

/**
 * Candidate Generation 요청 하나를 처리한다.
 *
 * 실패는 모두 fail closed다. 반쯤 된 결과를 돌려주지 않는다.
 * 어느 실패에서도 다시 부르지 않는다.
 */
export async function handleCandidateGeneration(
  request: Request,
  deps: HandlerDeps,
): Promise<Response> {
  const log = deps.log ?? (() => {});
  const requestId = deps.requestId?.() ?? '';

  const fail = (code: ErrorCode, status: number) => {
    log(`[${requestId}] ${code}`);
    return jsonResponse({ ok: false, error: code }, status);
  };

  try {
    // 1. 브라우저에서 부르는 기능이 아니다. POST 말고는 받지 않는다.
    if (request.method !== 'POST') return fail('METHOD_NOT_ALLOWED', 405);

    // 2. 권한부터 본다. 통과하지 못하면 본문도 읽지 않고 어떤 자료 경로에도 닿지 않는다.
    if (!(await deps.isAuthorized(request))) return fail('UNAUTHORIZED', 401);

    // 3. 본문
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return fail('INVALID_JSON', 400);
    }

    // 4. 받기로 한 모양(지문 하나)인지 committed validator로 확인한다.
    // 이유(unknown_field / hash_format_invalid)는 밖으로 세분해서 알리지 않는다.
    const parsed = validateResearchResultReadRequest(body);
    if (!parsed.ok) return fail('INVALID_REQUEST', 400);

    // 5. authoritative 연구 결과를 지문으로 읽어 온다. 부르는 쪽이 보낸
    // researchResult 본문 같은 것은 애초에 존재하지 않는다(4에서 이미 거절됨).
    const readOutcome = await deps.readResearchResult(parsed.request.researchResultHash);

    // 6. 읽기가 성공했을 때만 모델을 부를 수 있다.
    if (!canProceedToProviderAfterRead(readOutcome)) {
      if (!readOutcome.ok) {
        if (readOutcome.reason === 'not_found') {
          return fail('RESEARCH_RESULT_NOT_FOUND', 404);
        }
        if (readOutcome.reason === 'read_unavailable') {
          return fail('RESEARCH_RESULT_UNAVAILABLE', 503);
        }
      }
      // unknown_field / hash_format_invalid는 여기 도달하면 안 된다.
      // 4에서 이미 같은 검사기로 걸렀기 때문이다. 그래도 도달했다면
      // 안전한 쪽(일반 실패)으로 fail closed 한다.
      log(`[${requestId}] research_result_read_unexpected_reason`);
      return fail('RESEARCH_RESULT_UNAVAILABLE', 503);
    }

    // 7. 읽어 온 authoritative 값만 orchestrator 입력으로 넘긴다.
    const orchestrationInput = buildOrchestrationInputFromRead(readOutcome);
    if (orchestrationInput === null) {
      // ok:true를 위에서 이미 확인했으므로 이 분기는 도달하지 않는다.
      // 그래도 타입상 null이 가능하므로 안전하게 막는다.
      return fail('RESEARCH_RESULT_UNAVAILABLE', 503);
    }

    // 8. 기존 orchestrator를 그대로 부른다. 새 orchestration logic을 만들지 않는다.
    const result = await runCandidateGenerationOrchestrator(orchestrationInput, deps);

    // 9. orchestration category를 sanitized HTTP 응답으로 바꾼다.
    switch (result.category) {
      case 'generated':
        log(`[${requestId}] generated`);
        return jsonResponse({ ok: true, candidateHash: result.candidateHash }, 200);
      case 'deferred':
        log(`[${requestId}] deferred`);
        return jsonResponse({ ok: true, category: 'deferred' }, 200);
      case 'deterministic_preflight_failure':
        log(`[${requestId}] deterministic_preflight_failure`);
        return fail('CANDIDATE_PROCESSING_FAILED', 500);
      case 'generation_failure':
        log(`[${requestId}] generation_failure`);
        return fail('CANDIDATE_GENERATION_UNAVAILABLE', 503);
      case 'candidate_build_failure':
        log(`[${requestId}] candidate_build_failure`);
        return fail('CANDIDATE_PROCESSING_FAILED', 500);
      case 'candidate_store_failure':
        // Store가 실패해도 여기서 다시 부르지 않는다. RUNTIME_RISK_DEFERRED 그대로 둔다.
        log(`[${requestId}] candidate_store_failure`);
        return fail('CANDIDATE_PROCESSING_FAILED', 500);
    }
  } catch {
    return fail('INTERNAL_ERROR', 500);
  }
}
