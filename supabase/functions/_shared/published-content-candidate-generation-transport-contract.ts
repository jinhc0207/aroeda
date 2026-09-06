/**
 * 모델에게 물어보고 답을 받는 자리의 경계.
 *
 * 여기가 하는 일은 넷이다.
 *   받은 것을 JSON으로 읽는다.
 *   이미 있는 검사기에 넘긴다.
 *   무슨 일이 있었는지 여덟 가지 중 하나로 알린다.
 *   그것뿐이다.
 *
 * 여기가 하지 않는 일이 더 중요하다.
 *
 * 조용히 고치지 않는다.
 * 모델이 JSON 앞에 인사말을 붙였거나 코드 블록으로 감쌌으면,
 * 그것을 잘라내고 통과시키지 않는다. 계약을 어긴 것이기 때문이다.
 * 한 번 잘라 주기 시작하면 무엇을 잘랐는지 아무도 모르게 된다.
 *
 * 조용히 다시 부르지 않는다.
 * 같은 질문에 모델은 다른 글을 쓴다.
 * 안에서 한 번 더 부르면, 한 번의 시도가 사실은 두 번이 되고
 * 그중 어느 것이 나온 글인지 밖에서 알 수 없다.
 *
 * 기술적 실패를 신학적 판단으로 바꾸지 않는다.
 * 이것이 이 파일에서 가장 조심한 부분이다.
 * 시간이 초과됐다고 해서 "연구 근거가 모자랍니다"라고 적으면,
 * 사람은 연구가 부족했다고 읽는다. 실제로는 그냥 연결이 끊긴 것인데.
 *
 * 모델 이름도, 호출 설정도, 실제 호출도 여기 없다.
 * 그것들은 다음 계층의 몫이고, 그 값을 정하는 일은 따로 승인받아야 한다.
 */

import {
  validateCandidateModelGenerationResponse,
  type CandidateModelGenerationInput,
  type CandidateModelGenerationResponse,
} from './published-content-candidate-generation-contract.ts';
import type { CandidateGenerationPrompt } from './published-content-candidate-generation-prompt.ts';

/* ------------------------------------------------------------------ */
/* 1. 무엇을 받아서 시작하는가                                          */
/* ------------------------------------------------------------------ */

/**
 * 이 계층이 받는 것은 이미 만들어진 프롬프트다.
 *
 * 연구 결과도, 연구 지문도, 근거 기록도 여기까지 오지 않는다.
 * 같은 모양의 타입을 새로 만들지 않고 프롬프트의 것을 그대로 쓴다.
 */
export type CandidateGenerationTransportRequest = CandidateGenerationPrompt;

/* ------------------------------------------------------------------ */
/* 2. 무슨 일이 있었는가                                                */
/* ------------------------------------------------------------------ */

/**
 * 여덟 가지. 서로 섞이지 않는다.
 *
 * 섞이면 안 되는 이유가 각각 다르다.
 *   못 읽은 것과 읽었는데 계약을 어긴 것은, 고칠 곳이 다르다.
 *   모델이 못 쓰겠다고 한 것과 우리가 못 받은 것은, 전혀 다른 일이다.
 *   연결이 끊긴 것과 모델이 판단한 것은, 사람에게 다르게 보여야 한다.
 */
export const TRANSPORT_OUTCOMES = [
  /** 읽었고, 계약을 통과했고, 초안이 들어 있다. */
  'validated_generate',
  /** 읽었고, 계약을 통과했고, 모델이 못 쓰겠다고 했다. 실패가 아니다. */
  'validated_defer',
  /** 받은 것이 비어 있다. */
  'empty_response',
  /** JSON으로 읽지 못했다. */
  'json_parse_failed',
  /** 읽기는 했는데 계약을 어겼다. */
  'response_contract_invalid',
  /** 정해 둔 시간을 넘겼다. */
  'provider_timeout',
  /** 부를 수 없었다. */
  'provider_unavailable',
  /** 그 밖의 문제. */
  'provider_error',
] as const;

export type TransportOutcomeKind = (typeof TRANSPORT_OUTCOMES)[number];

/** 모델 쪽 문제로 분류되는 것들. 앞으로 어댑터가 여기에 맞춰 옮겨 담는다. */
export const PROVIDER_FAILURE_OUTCOMES = [
  'provider_timeout',
  'provider_unavailable',
  'provider_error',
] as const;

export type ProviderFailureKind = (typeof PROVIDER_FAILURE_OUTCOMES)[number];

type GenerateResponse = Extract<CandidateModelGenerationResponse, { decision: 'generate' }>;
type DeferResponse = Extract<CandidateModelGenerationResponse, { decision: 'defer' }>;

/**
 * 결과 하나.
 *
 * 통과한 경우에만 대답을 함께 담는다.
 * 못 읽은 글이나 계약을 어긴 글의 원문은 담지 않는다. 아래에 이유를 적었다.
 */
export type CandidateGenerationTransportOutcome =
  | { outcome: 'validated_generate'; response: GenerateResponse }
  | { outcome: 'validated_defer'; response: DeferResponse }
  | { outcome: 'empty_response' }
  | { outcome: 'json_parse_failed' }
  | { outcome: 'response_contract_invalid'; errors: string[] }
  | { outcome: 'provider_timeout' }
  | { outcome: 'provider_unavailable' }
  | { outcome: 'provider_error' };

/**
 * 통과했다는 것이 글이 만들어졌다는 뜻은 아니다.
 *
 * validated_generate 는 "모델의 대답이 계약을 통과했다"까지다.
 * 아직 연구와의 이음도, 본문 이름도, 글의 검사도, 지문도 남아 있다.
 *
 * 그래서 이 이름을 candidate_success 나 published 로 짓지 않았다.
 * 이름이 실제보다 앞서가면, 읽는 사람이 끝난 줄 안다.
 */
export const VALIDATED_GENERATE_IS_NOT_CANDIDATE_SUCCESS =
  'validated_generate 는 모델 대답이 계약을 통과했다는 뜻이다. 글이 만들어졌다는 뜻이 아니다.';

/* ------------------------------------------------------------------ */
/* 3. 바꿔치기 금지                                                     */
/* ------------------------------------------------------------------ */

/**
 * 기술적 실패를 판단으로 위장하지 않는다.
 *
 * 시간 초과, 연결 실패, 못 읽은 글, 계약 위반.
 * 이 넷 중 어느 것도 "연구 근거가 모자랍니다"가 되지 않는다.
 *
 * needs_more_research 는 모델이 계약에 맞는 대답으로
 * 직접 그렇게 판단했을 때만 성립한다.
 *
 * 왜 이렇게까지 적어 두는가.
 * 그렇게 바꿔 두면 화면에서는 아무 문제 없어 보인다.
 * 사람은 연구가 부족했다고 읽고, 연구를 더 시킨다.
 * 정작 고쳐야 할 것은 연결이었는데 아무도 그것을 모른다.
 */
export const NO_SILENT_DOWNGRADE = {
  parseFailureBecomesDefer: false,
  contractFailureBecomesDefer: false,
  emptyResponseBecomesDefer: false,
  providerFailureBecomesDefer: false,
  providerFailureBecomesNeedsMoreResearch: false,
  deferTreatedAsFailure: false,
} as const;

/* ------------------------------------------------------------------ */
/* 4. 어떻게 부를 것인가                                                */
/* ------------------------------------------------------------------ */

/**
 * 부르는 방식에 대한 약속.
 *
 * 실제 값은 여기서 정하지 않는다.
 * 어떤 모델을 쓸지, 얼마나 기다릴지, 얼마나 길게 받을지는
 * 별도로 정하고 승인받아야 하는 일이다.
 *
 * 다만 "정하지 않으면 부를 수 없다"는 것만 여기서 못 박는다.
 * 기본값을 하나 넣어 두면 아무도 그 값을 정한 적이 없는데 그대로 쓰이게 된다.
 */
export const TRANSPORT_RUNTIME_CONFIG_POLICY = {
  /** 어떤 모델을 쓸지 명시적으로 정해야 한다. */
  modelMustBeExplicitlyConfigured: true,
  defaultModel: null,

  /** 얼마나 기다릴지 명시적으로 정해야 한다. */
  timeoutMustBeExplicitlyConfigured: true,
  defaultTimeoutMs: null,

  /** 얼마나 길게 받을지 명시적으로 정해야 한다. */
  outputBudgetMustBeExplicitlyConfigured: true,
  defaultOutputBudget: null,

  /** 실패했다고 다른 모델로 갈아타지 않는다. */
  fallbackModelAllowed: false,

  /** 안에서 조용히 다시 부르지 않는다. */
  automaticRetries: 0,

  /** 어긋난 글을 고쳐서 통과시키지 않는다. */
  automaticJsonRepair: false,

  /** 모델이 보낸 원문을 남겨 두지 않는다. */
  rawModelOutputPersisted: false,
} as const;

/**
 * 실제로 부르려면 먼저 값을 정해야 한다.
 *
 * 이 계약은 "무엇을 정해야 하는가"까지만 말한다.
 * 그 값을 정하는 일은 따로 승인받는 단계다. 여기서 미리 정해 두지 않는다.
 */
export const RUNTIME_CONFIG_FREEZE_REQUIRED_BEFORE_CALLING =
  '모델, 기다리는 시간, 받는 길이를 명시적으로 정하고 승인받기 전에는 부르지 않는다.';

/**
 * 왜 안에서 다시 부르지 않는가.
 *
 * 같은 질문에 모델은 매번 다른 글을 쓴다.
 * 그래서 다시 부르는 것은 "같은 일을 한 번 더"가 아니라 "다른 일"이다.
 *
 * 다시 해야 한다면 밖에서 새 시도로 다룬다.
 * 그래야 몇 번 물었고 어느 답을 썼는지가 드러난다.
 */
export const NO_AUTOMATIC_RETRY_REASON =
  '같은 질문에도 모델은 다른 글을 쓴다. 안에서 다시 부르면 한 번의 시도가 몰래 여러 번이 된다.';

/**
 * 남기지 않는 것.
 *
 * 모델이 보낸 원문에는 계약 밖의 것이 섞여 있을 수 있다.
 * 판단 과정 같은 것을 뽑아 두면, 그것도 어딘가에 남는다.
 * 애초에 요구하지 않았고, 받아도 담지 않는다.
 *
 * 오류에 담는 것은 이미 있는 검사기가 돌려준 사유뿐이다.
 * 프롬프트 전문도, 모델 원문도, 열쇠도 담지 않는다.
 */
export const TRANSPORT_PERSISTENCE_POLICY = {
  rawModelOutputPersisted: false,
  reasoningExtracted: false,
  reasoningPersisted: false,
  promptIncludedInErrors: false,
  providerErrorUsedAsCandidateContent: false,
  providerErrorUsedAsDeferReason: false,
} as const;

/* ------------------------------------------------------------------ */
/* 5. 이 계층이 하지 않는 일                                            */
/* ------------------------------------------------------------------ */

/**
 * 여기서 끝나는 자리를 분명히 해 둔다.
 *
 * 조립하는 쪽을 여기서 부르지 않는다.
 * 부르면 "모델이 답했다"와 "글이 만들어졌다"가 한 덩어리가 되고,
 * 어디서 틀어졌는지 나중에 가려낼 수 없게 된다.
 */
export const TRANSPORT_DOES_NOT_INCLUDE = [
  '연구 결과에서 모델 입력을 만드는 일',
  '프롬프트를 쓰는 일',
  '검토 대상 글을 조립하는 일',
  '글의 지문을 계산하는 일',
  '글을 적어 두는 일',
  '표를 읽거나 쓰는 일',
] as const;

/* ------------------------------------------------------------------ */
/* 6. 받은 것을 읽는다                                                  */
/* ------------------------------------------------------------------ */

/**
 * 모델이 보낸 것을 읽어 무슨 일이 있었는지 정한다.
 *
 * 글자로 왔으면 앞뒤 공백만 털고 그대로 JSON으로 읽는다.
 * 코드 블록을 벗기거나, 인사말을 지우거나, 가운데의 JSON만 골라내지 않는다.
 * 그런 글은 계약을 어긴 것이고, 어긴 것은 어겼다고 알린다.
 *
 * 이미 값으로 왔으면 읽는 단계 없이 검사기로 넘긴다.
 *
 * 대답의 옳고 그름은 여기서 보지 않는다. 이미 있는 검사기가 본다.
 * 같은 규칙을 두 벌 만들면 언젠가 서로 달라진다.
 *
 * 받은 값을 고치지 않는다. 부를 때마다 같은 답을 낸다.
 */
export function interpretCandidateGenerationTransportPayload(
  payload: unknown,
  input: CandidateModelGenerationInput,
): CandidateGenerationTransportOutcome {
  try {
    // 아무것도 오지 않은 경우. 계약을 어긴 것이 아니라 받은 것이 없는 것이다.
    if (payload === null || payload === undefined) {
      return { outcome: 'empty_response' };
    }

    let value: unknown = payload;

    if (typeof payload === 'string') {
      const text = payload.trim();
      if (text.length === 0) return { outcome: 'empty_response' };

      try {
        // 정확히 한 번 읽는다. 실패하면 실패한 것이다.
        value = JSON.parse(text);
      } catch {
        return { outcome: 'json_parse_failed' };
      }
    }

    const checked = validateCandidateModelGenerationResponse(value, input);
    if (!checked.valid) {
      return { outcome: 'response_contract_invalid', errors: checked.errors };
    }

    const response = value as CandidateModelGenerationResponse;

    if (response.decision === 'defer') {
      return { outcome: 'validated_defer', response };
    }

    return { outcome: 'validated_generate', response };
  } catch {
    // 여기까지 오면 우리 쪽 문제다. 모델의 판단으로 바꾸지 않는다.
    return { outcome: 'provider_error' };
  }
}

/* ------------------------------------------------------------------ */
/* 7. 모델 쪽 문제                                                      */
/* ------------------------------------------------------------------ */

/**
 * 모델 쪽 문제를 결과 하나로 만든다.
 *
 * 어떤 오류가 어디에 해당하는지는 앞으로 어댑터가 정한다.
 * 여기서는 오류 객체를 들여다보지 않는다. HTTP 상태도 보지 않는다.
 * 그런 것을 여기서 알기 시작하면 이 파일이 특정 제공자에 묶인다.
 */
export function createCandidateGenerationTransportFailure(
  kind: ProviderFailureKind,
): CandidateGenerationTransportOutcome {
  return { outcome: kind };
}

/* ------------------------------------------------------------------ */
/* 8. 조립으로 넘어가도 되는가                                          */
/* ------------------------------------------------------------------ */

/**
 * 조립하는 쪽으로 넘어갈 수 있는 결과는 하나뿐이다.
 *
 * 못 쓰겠다는 대답도 넘기지 않는다. 넘길 초안이 없기 때문이다.
 * 그것은 실패가 아니라 정상적인 끝이다.
 */
export const BUILDER_ELIGIBLE_OUTCOMES = ['validated_generate'] as const;

export function canInvokeCandidateBuilder(
  outcome: CandidateGenerationTransportOutcome,
): boolean {
  return (BUILDER_ELIGIBLE_OUTCOMES as readonly string[]).includes(outcome.outcome);
}
