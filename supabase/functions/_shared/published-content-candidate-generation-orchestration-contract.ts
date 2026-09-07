/**
 * Candidate Generation 전체를 어떤 순서로 이을 것인가.
 *
 * 지금까지 만든 조각은 전부 따로 놀 수 있다.
 *   연구 결과를 모델 입력으로 바꾸는 것, 프롬프트를 쓰는 것,
 *   실제로 부르는 것, 조립하는 것, 적어 두는 것.
 *
 * 이 파일은 그것들을 부르지 않는다. 순서만 못 박는다.
 *
 * 왜 순서가 계약이어야 하는가.
 *
 * 잘못된 연구 결과로도 모델을 부를 수는 있다. 프롬프트도 만들어지고
 * 요청도 나간다. 다만 그 요청은 이미 돈이 든다.
 *
 * 그런데 연구 지문이 맞지 않는 결과는 애초에 조립 단계에서 거절된다
 * (published-content-candidate-builder.ts의 RESEARCH_RESULT_HASH_MISMATCH).
 * 그 사실을 모델을 부르기 전에 미리 알 수 있다면, 부르지 않는 편이 낫다.
 *
 * 그래서 이 계약은 "모델을 부르기 전에 연구 지문부터 맞춰 본다"를
 * 우연이 아니라 못 박은 순서로 만든다.
 *
 * 이 파일이 하지 않는 일.
 *
 * 실제로 아무것도 부르지 않는다. fetch도, DB도, Deno.env도 없다.
 * 그래서 이 파일 안의 함수는 injected dependency를 받지 않는다.
 * 받는다는 것 자체가 "부르는 자리"라는 뜻이기 때문이다.
 *
 * 부르는 자리(orchestrator)는 다음 단계의 몫이다.
 * 이 계약이 하는 일은 그 자리가 지켜야 할 순서, 조건, 결과 이름을
 * 미리 정해서, 나중에 그 자리가 이 순서를 어겼는지 시험할 수 있게 하는 것이다.
 *
 * 여기서 다시 정의하지 않는 것.
 *
 * Candidate의 열다섯 항목, 초안의 열한 항목, transport의 열 가지 결과,
 * HTTP 상태 대응표, 모델 이름, 시간 제한, 주소, 프롬프트, schema, 해시 방식,
 * Store의 SQL 동작 — 전부 이미 주인이 있다. 이 파일은 가져다 쓸 뿐이다.
 */

import {
  RESEARCH_RESULT_HASH_FORMAT,
  computeResearchResultHash,
} from './research-result-store-contract.ts';
import {
  buildCandidateModelGenerationInput,
  type CandidateModelGenerationInput,
} from './published-content-candidate-generation-contract.ts';
import { ADAPTER_RETRY_POLICY } from './published-content-candidate-generation-openai-adapter-contract.ts';
import { callCandidateGenerationOpenAIFetchTransport } from './published-content-candidate-generation-openai-fetch-transport.ts';
import {
  canInvokeCandidateBuilder,
  type CandidateGenerationTransportOutcome,
} from './published-content-candidate-generation-transport-contract.ts';
import { buildPublishedContentCandidate } from './published-content-candidate-builder.ts';
import type { BiblicalResearchResult } from './biblical-researcher.ts';
import type { CandidateStoreInput } from './published-content-store-contract.ts';

/* ------------------------------------------------------------------ */
/* 1. 이 계층이 받는 것                                                 */
/* ------------------------------------------------------------------ */

/**
 * 부르는 쪽이 넘겨야 할 최소한의 사업적 입력.
 *
 * researchResult를 호출자가 직접 준다고 해서 그것을 그대로 믿는다는 뜻이 아니다.
 * "믿을 수 있는가"는 아래 lineage 확인이 판단한다.
 *
 * 이 연구가 실제로 서버에 저장돼 있었는가는 여기서 보지 않는다.
 * 그 판단은 Candidate Store의 외래키(research_result_hash)가 이미 하고 있고,
 * 여기서 같은 것을 다시 검사하면 규칙의 주인이 둘이 된다.
 */
export type CandidateGenerationOrchestrationInput = {
  researchResultHash: string;
  researchResult: unknown;
};

/* ------------------------------------------------------------------ */
/* 2. 순서 — 이 계약의 핵심                                             */
/* ------------------------------------------------------------------ */

/**
 * 열두 단계. 이 순서를 어기지 않는다.
 *
 * 앞 다섯이 전부 끝나야 그다음(프롬프트 이후)으로 간다.
 * 모델을 부르는 여덟째보다 지문을 맞춰 보는 둘째·셋째가 먼저다.
 *
 * 이 배열은 문서가 아니라 시험 대상이다.
 * 실제 순서가 이 배열과 달라지면 이 상수부터 고쳐야 하고,
 * 그러면 그 변경이 리뷰에서 눈에 띈다.
 */
export const ORCHESTRATION_STEP_ORDER = [
  'input_shape_preflight',
  'canonical_hash_computation',
  'hash_equality_verification',
  'generation_input_projection',
  'projection_failure_check',
  'prompt_build',
  'request_spec_build',
  'transport_call',
  'transport_outcome_branch',
  'builder_invocation',
  'store_invocation',
  'success',
] as const;

export type OrchestrationStep = (typeof ORCHESTRATION_STEP_ORDER)[number];

/** 모델을 부르기 전에 반드시 끝나 있어야 하는 앞 다섯 단계. */
export const STEPS_BEFORE_PROVIDER_CALL = ORCHESTRATION_STEP_ORDER.slice(0, 5);

/* ------------------------------------------------------------------ */
/* 3. Deterministic Preflight — lineage 확인                            */
/* ------------------------------------------------------------------ */

/**
 * 모델을 부르기 전에 멈추는 이유들.
 *
 * 이 다섯은 전부 "모델이 판단한 것"이 아니다. 모델은 아직 불리지도 않았다.
 * 그래서 이 실패를 validated_defer와 섞지 않는다.
 * 섞으면 "모델이 못 쓰겠다고 했다"와 "우리가 부르기도 전에 멈췄다"가
 * 같은 것으로 보이고, 비용이 들지 않은 실패와 든 실패를 구분할 수 없게 된다.
 */
export const LINEAGE_PREFLIGHT_FAILURE_REASONS = [
  /** 입력 자체가 받을 수 있는 모양이 아니다(객체가 아니다 등). */
  'input_not_object',
  /** 넘겨받은 지문이 애초에 정한 모양(rres_ + 64자리)이 아니다. */
  'hash_format_invalid',
  /** 연구 결과가 객체가 아니다. 지문을 계산해도 의미가 없다. */
  'research_result_not_object',
  /** 지문 계산 자체가 실패했다(직렬화 불가 등). */
  'canonical_hash_computation_failed',
  /** 계산한 지문이 넘겨받은 지문과 다르다. 이 연구가 아니다. */
  'hash_mismatch',
  /** 지문은 맞는데, 이 연구로는 모델에게 보여줄 입력을 만들 수 없다. */
  'generation_input_projection_failed',
] as const;

export type LineagePreflightFailureReason = (typeof LINEAGE_PREFLIGHT_FAILURE_REASONS)[number];

/**
 * 통과했거나, 다섯 이유 중 하나로 멈췄거나.
 *
 * 통과했을 때만 모델에게 보여줄 입력을 함께 담는다.
 * 실패했을 때는 이유 이름만 남는다. 원본 연구 결과를 그대로 담지 않는다.
 * 담으면 그것이 오류 로그나 응답을 타고 밖으로 나갈 수 있다.
 */
export type CandidateGenerationLineagePreflightOutcome =
  | { ok: true; generationInput: CandidateModelGenerationInput }
  | { ok: false; reason: LineagePreflightFailureReason };

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * 모델을 부르기 전, 딱 다섯 단계(ORCHESTRATION_STEP_ORDER의 앞 다섯).
 *
 * 이 함수는 아무것도 부르지 않는다. fetch도, DB도 없다.
 * 순수하게 받은 값만 보고 답한다. 그래서 같은 입력이면 항상 같은 답이 나온다.
 *
 * 여기서 실패하면 그 뒤(프롬프트, 요청, 모델 호출)는 아예 만들어지지 않는다.
 * 이 함수를 부르는 자리가 그 뒤를 잇지 않으면 되는 것이지,
 * 이 함수 스스로 무언가를 막는 것이 아니다 — 애초에 막을 수단(fetch 등)이 없다.
 */
export async function verifyCandidateGenerationLineage(
  input: CandidateGenerationOrchestrationInput,
): Promise<CandidateGenerationLineagePreflightOutcome> {
  try {
    // ① 입력 모양.
    if (!isPlainObject(input)) {
      return { ok: false, reason: 'input_not_object' };
    }

    if (typeof input.researchResultHash !== 'string' || !RESEARCH_RESULT_HASH_FORMAT.test(input.researchResultHash)) {
      return { ok: false, reason: 'hash_format_invalid' };
    }

    if (!isPlainObject(input.researchResult)) {
      return { ok: false, reason: 'research_result_not_object' };
    }

    // ② 지문 계산. 계산 방식의 주인은 연구 보관소 계약이다. 여기서 다시 만들지 않는다.
    let canonicalHash: string;
    try {
      canonicalHash = await computeResearchResultHash(input.researchResult as BiblicalResearchResult);
    } catch {
      return { ok: false, reason: 'canonical_hash_computation_failed' };
    }

    // ③ 같은 연구인가. 계산한 값으로 조용히 바꿔 끼우지 않는다. 어긋나면 여기서 끝이다.
    if (canonicalHash !== input.researchResultHash) {
      return { ok: false, reason: 'hash_mismatch' };
    }

    // ④ 모델에게 보여줄 입력을 만들 수 있는가. 이 시점부터는 지문이 맞다고 확인된 연구다.
    const generationInput = buildCandidateModelGenerationInput(input.researchResult);

    // ⑤ 만들 수 없으면 여기서 멈춘다. 이것은 모델의 판단(defer)이 아니다.
    // 모델은 아직 한 번도 불리지 않았다.
    if (generationInput === null) {
      return { ok: false, reason: 'generation_input_projection_failed' };
    }

    return { ok: true, generationInput };
  } catch {
    return { ok: false, reason: 'input_not_object' };
  }
}

/* ------------------------------------------------------------------ */
/* 4. 부르는 자리가 주입해야 할 것들 — 타입만 정한다                     */
/* ------------------------------------------------------------------ */

/**
 * 모델을 실제로 부르는 자리의 모양.
 *
 * 새로 적지 않는다. 이미 있는 함수의 모양을 그대로 가리킨다.
 * 여기 손으로 다시 적으면, 그 함수의 서명이 바뀌는 날 이 계약만 옛 모양으로 남는다.
 */
export type CandidateGenerationTransportCall = typeof callCandidateGenerationOpenAIFetchTransport;

/**
 * 조립하는 자리의 모양.
 *
 * 마찬가지로 이미 있는 함수를 가리키기만 한다.
 */
export type CandidateGenerationBuilderCall = typeof buildPublishedContentCandidate;

/**
 * 적어 두는 자리가 아직 없다.
 *
 * Candidate Store RPC(store_published_content_candidate)는 DB에 있지만,
 * 그것을 실제로 부르는 코드는 이번 계약 범위 밖이다.
 * 그래서 이 타입은 "장차 그 자리가 이런 모양이어야 한다"는 약속이지,
 * 이미 있는 함수를 가리키는 것이 아니다.
 *
 * 인자 모양은 이미 있는 CandidateStoreInput 그대로 쓴다. 여기서 다시 적지 않는다.
 */
export type CandidateGenerationStoreOutcome =
  | { ok: true; candidateHash: string }
  | { ok: false };

export type CandidateGenerationStoreCall = (
  input: CandidateStoreInput,
) => Promise<CandidateGenerationStoreOutcome>;

/* ------------------------------------------------------------------ */
/* 5. 다음 단계로 넘어가도 되는가 — 각 경계의 문                        */
/* ------------------------------------------------------------------ */

/**
 * 모델 답을 조립으로 넘겨도 되는가.
 *
 * 새 목록을 만들지 않는다. transport 계약의 것을 그대로 쓴다.
 */
export const canProceedToCandidateBuilder = canInvokeCandidateBuilder;

/**
 * 조립 결과를 적어 두기로 넘겨도 되는가.
 *
 * 조립이 성공했을 때만 그렇다. 성공의 뜻은 Builder의 CandidateBuildOutcome이 정한다.
 * 여기서 하는 일은 그 결과의 ok만 보는 것뿐이다.
 */
export function canProceedToCandidateStore(
  builderOutcome: Awaited<ReturnType<CandidateGenerationBuilderCall>>,
): boolean {
  return builderOutcome.ok === true;
}

/* ------------------------------------------------------------------ */
/* 6. 이 실행의 최종 결과 — 내부 전용 다섯 가지                          */
/* ------------------------------------------------------------------ */

/**
 * 밖으로 나가는 이름이 아니다.
 *
 * Edge Function의 HTTP 응답 모양, 상태 코드, operator에게 보여줄 문구는
 * 이 계약의 범위 밖이다(다음 단계의 몫). 여기서는 orchestration 내부에서
 * "무엇이 일어났는가"를 다섯 가지로만 나눈다.
 *
 * provider_timeout, provider_error 같은 세부 transport 이유는 여기 없다.
 * 그것들은 이미 transport 계약이 갖고 있고, 여기서 다시 나열하면 두 벌이 된다.
 * 'generation_failure' 하나가 그 여섯 가지 실패 이유를 전부 대표한다.
 */
export const ORCHESTRATION_RESULT_CATEGORIES = [
  /** 지문을 부르기도 전에 멈췄다. 모델 비용이 들지 않았다. */
  'deterministic_preflight_failure',
  /** 모델이 답했지만 그중 하나의 실패 이유로 끝났다(거절, 잘림, 시간초과 등 포함). */
  'generation_failure',
  /** 모델이 계약대로 답했고, 못 쓰겠다고 판단했다. 실패가 아니다. */
  'deferred',
  /** 모델의 대답은 통과했지만 조립이 실패했다. */
  'candidate_build_failure',
  /** 조립은 성공했지만 적어 두기가 실패했다. */
  'candidate_store_failure',
  /** 모델이 썼고, 조립됐고, 적혔다. */
  'generated',
] as const;

export type OrchestrationResultCategory = (typeof ORCHESTRATION_RESULT_CATEGORIES)[number];

/**
 * 밖에 남기는 것.
 *
 * 성공했을 때는 candidateHash 하나만 남는다. 그 값은 원래 사람이 검토할 글의
 * 공개된 이름이라 감출 이유가 없다. 실패했을 때는 category 하나뿐이다.
 *
 * 여기 없는 것: apiKey, 원본 응답, 원본 오류 문구, 거절/생각한 흔적,
 * researchResult 원문. 실패했다고 해서 무엇을 받았었는지 되돌려 보여주지 않는다.
 */
export type CandidateGenerationOrchestrationResult =
  | { category: 'generated'; candidateHash: string }
  | { category: 'deferred' }
  | { category: 'deterministic_preflight_failure' }
  | { category: 'generation_failure' }
  | { category: 'candidate_build_failure' }
  | { category: 'candidate_store_failure' };

/** lineage preflight가 실패했을 때. 모델은 불린 적이 없다. */
export function preflightFailureToOrchestrationResult(
  outcome: Extract<CandidateGenerationLineagePreflightOutcome, { ok: false }>,
): CandidateGenerationOrchestrationResult {
  void outcome; // 이유 코드는 서버 내부 판단용이다. 밖으로 옮기지 않는다.
  return { category: 'deterministic_preflight_failure' };
}

/**
 * transport outcome을 본다.
 *
 * null을 돌려주면 "조립으로 계속 가라"는 뜻이다.
 * 그 자리에서 최종 결과가 이미 정해지면 그 결과를 돌려준다.
 */
export function transportOutcomeToOrchestrationResult(
  outcome: CandidateGenerationTransportOutcome,
): CandidateGenerationOrchestrationResult | null {
  if (outcome.outcome === 'validated_generate') return null;
  if (outcome.outcome === 'validated_defer') return { category: 'deferred' };
  return { category: 'generation_failure' };
}

/** Builder 결과를 본다. null이면 Store로 계속 간다. */
export function builderOutcomeToOrchestrationResult(
  outcome: Awaited<ReturnType<CandidateGenerationBuilderCall>>,
): CandidateGenerationOrchestrationResult | null {
  if (outcome.ok) return null;
  return { category: 'candidate_build_failure' };
}

/** Store 결과를 본다. 여기가 마지막 갈림길이다. */
export function storeOutcomeToOrchestrationResult(
  outcome: CandidateGenerationStoreOutcome,
): CandidateGenerationOrchestrationResult {
  if (outcome.ok) return { category: 'generated', candidateHash: outcome.candidateHash };
  return { category: 'candidate_store_failure' };
}

/* ------------------------------------------------------------------ */
/* 7. 밖으로 새지 않는다                                                */
/* ------------------------------------------------------------------ */

/**
 * orchestration 결과에 담지 않는 것들.
 *
 * 위 CandidateGenerationOrchestrationResult 타입이 이미 그렇게 생겼다
 * (category 하나, 성공했을 때만 candidateHash 하나).
 * 이 객체는 그 모양을 말로 다시 확인해 두는 것이다. 실제로 막는 것은 타입과
 * 아래 분류 함수들이다 — 이 객체 자체가 무언가를 막지는 않는다.
 */
export const ORCHESTRATION_PRIVACY_POLICY = {
  apiKeyInResult: false,
  authorizationHeaderInResult: false,
  providerEndpointInResult: false,
  rawProviderBodyInResult: false,
  providerExceptionMessageInResult: false,
  refusalTextInResult: false,
  reasoningTextInResult: false,
  rawModelOutputInResult: false,
  /** 실패했을 때 받았던 researchResult를 결과에 되비추지 않는다. */
  researchResultEchoedOnFailure: false,
  /** 왜 전처리에서 멈췄는지(reason)도 orchestration 결과 밖으로 옮기지 않는다. */
  preflightReasonExposedInResult: false,
} as const;

/* ------------------------------------------------------------------ */
/* 8. 다시 부르지 않는다 / 맡겨 두지 않는다                              */
/* ------------------------------------------------------------------ */

/**
 * 이번 orchestration v1 전체의 재시도 정책.
 *
 * 모델 쪽 세 값은 새로 정하지 않는다. Adapter 계약의 것을 그대로 가져온다.
 * Store 쪽은 이 계층에서 처음 정하는 값이다. 그것을 소유한 기존 계약이 없기 때문이다.
 */
export const ORCHESTRATION_RETRY_POLICY = {
  modelAutomaticRetries: ADAPTER_RETRY_POLICY.automaticRetries,
  fallbackModelAllowed: ADAPTER_RETRY_POLICY.fallbackModelAllowed,
  automaticJsonRepair: ADAPTER_RETRY_POLICY.automaticJsonRepair,
  /** Store가 일시적으로 실패해도 안에서 다시 부르지 않는다. */
  storeAutomaticRetries: 0,
  /** 실패를 줄에 넣어 나중에 다시 시도하지 않는다. */
  queueEnabled: false,
  /** 맡겨 두고 나중에 몰래 다시 시도하지 않는다. */
  backgroundRetryEnabled: false,
  /** 한 번의 operator 호출에서 모델은 최대 한 번만 불린다. */
  maxProviderAttemptsPerInvocation: 1,
} as const;

/* ------------------------------------------------------------------ */
/* 9. 얼려 둔 두 가지 위험 — 이번 v1에서 풀지 않는다                     */
/* ------------------------------------------------------------------ */

/**
 * 모델이 성공한 뒤 Store가 실패하는 경우.
 *
 * 이미 발견된 위험이다(Runtime Integration Discovery v1).
 * 이번 계약은 그 위험을 없애지 않는다. 다만 무엇을 하지 않을지는 못 박는다.
 *
 * operator가 나중에 손으로 다시 부르면, 모델이 또 불리고 비용이 또 든다.
 * 답이 매번 같다는 보장이 없으므로(SAMPLING_POLICY.overridden = false),
 * 다른 초안이 나올 수도 있다. 그 위험은 이번 v1에서 없애지 않고 남겨 둔다.
 */
export const STORE_AFTER_MODEL_RISK = {
  status: 'RUNTIME_RISK_DEFERRED',
  modelRecalledOnStoreFailure: false,
  storeAutoRetried: false,
  fallbackOnStoreFailure: false,
  candidateReportedStoredOnFailure: false,
  generatedSuccessReturnedOnStoreFailure: false,
  knownOperatorRisk: 'manual_retry_may_incur_additional_model_cost_and_a_different_draft',
} as const;

/**
 * 운영 환경에서 researchResult를 실제로 어디서 구할 것인가.
 *
 * 이 계약은 "호출자가 이미 갖고 있다"고 가정한 입력만 정의한다.
 * 그 값이 실제로 어디서 오는가(호출자가 직접 들고 있는가, 서버가 DB에서 읽어오는가)는
 * Edge 통합 단계의 결정이다. 이번 local 계약/구현이 migration 없이 끝난다는 판정은
 * 이 범위(local orchestration)에 한한다.
 */
export const PRODUCTION_RESEARCH_RESULT_ACQUISITION = {
  status: 'DEFERRED_TO_EDGE_INTEGRATION',
  localOrchestrationInputAssumption: 'caller_supplied_full_payload',
  migrationRequiredForThisContract: false,
  futureOptionsUnderConsideration: ['caller_supplied', 'service_role_read_rpc'],
} as const;

/* ------------------------------------------------------------------ */
/* 10. 이 계약이 하지 않는 일                                           */
/* ------------------------------------------------------------------ */

export const ORCHESTRATION_CONTRACT_DOES_NOT_INCLUDE = [
  'HTTP 상태나 응답 모양',
  'operator 인증',
  '서버 실행 환경의 비밀값을 읽는 일',
  'Supabase client를 만드는 일',
  '실제 RPC 호출',
  'researchResult를 운영에서 어떻게 확보하는가',
  'CORS',
  '배포',
  '실제로 fetch/DB를 부르는 일 그 자체(다음 단계의 orchestrator가 한다)',
] as const;
