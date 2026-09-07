/**
 * 지금까지 정한 것들을 제공자 쪽 모양으로 옮기는 자리.
 *
 * 여기서 하는 일은 둘이다.
 *   보낼 것을 만든다.
 *   받은 것을 우리 상태 하나로 옮긴다.
 *
 * 부르지는 않는다. 열쇠도 읽지 않는다.
 * 실제로 부르는 코드는 다음 계층의 몫이고, 그 계층은 이 파일이 만든 것을 그대로 보낸다.
 *
 *
 * 프롬프트와 schema가 서로 다른 모양을 말하던 문제를 여기서 푼다.
 *
 * 프롬프트는 우리 대답의 모양을 설명한다. { decision, draft } 또는 { decision, reason }.
 * 그런데 제공자는 맨 바깥이 객체여야 해서, schema는 한 겹을 씌운 모양을 강제한다.
 *
 * 프롬프트를 고쳐 한 겹을 넣을 수도 있었다. 그렇게 하지 않았다.
 * 그 한 겹은 우리 뜻이 아니라 제공자 사정이고,
 * 프롬프트에 넣어 두면 제공자가 바뀌는 날 뜻과 사정이 뒤엉킨 채로 남는다.
 *
 * 그래서 프롬프트는 그대로 두고, 보낼 때만 한 줄을 덧붙인다.
 * 덧붙이는 말은 "그 모양을 이 한 겹 아래에 담아라"까지다.
 * 항목 이름도, 결정 종류도, 보류 이유도 거기서 다시 말하지 않는다.
 *
 *
 * 받는 쪽에서 조심한 것.
 *
 * 답하기를 거절한 것과 못 쓰겠다고 판단한 것은 다르다.
 * 오다 만 것과 아무것도 안 온 것도 다르다.
 * 그 넷을 하나로 뭉치면, 사람은 늘 "연구가 부족했나 보다"라고 읽게 된다.
 * 그래서 순서를 정해 두고 그 순서대로만 판단한다.
 */

import {
  CANDIDATE_GENERATION_STRUCTURED_OUTPUT_ENVELOPE_KEY,
  CANDIDATE_GENERATION_STRUCTURED_OUTPUT_SCHEMA,
} from './published-content-candidate-generation-structured-output-schema.ts';
import { CANDIDATE_GENERATION_RUNTIME_CONFIG } from './published-content-candidate-generation-runtime-config.ts';
import {
  createCandidateGenerationModelResponseOutcome,
  createCandidateGenerationTransportFailure,
  interpretCandidateGenerationTransportPayload,
  type CandidateGenerationTransportOutcome,
  type ProviderFailureKind,
} from './published-content-candidate-generation-transport-contract.ts';
import type { CandidateGenerationPrompt } from './published-content-candidate-generation-prompt.ts';
import type { CandidateModelGenerationInput } from './published-content-candidate-generation-contract.ts';

/* ------------------------------------------------------------------ */
/* 1. 보낼 때 덧붙이는 말                                               */
/* ------------------------------------------------------------------ */

/**
 * 프롬프트 끝에 붙이는 한 줄.
 *
 * 우리가 쓴 말이다. 연구 데이터에서 만들어지지 않는다.
 * 그래서 이 자리에는 사람의 이야기도, 연구 내용도 섞이지 않는다.
 *
 * 말하는 것은 담는 자리뿐이다.
 * 어떤 항목이 있는지, 어떤 낱말을 쓰는지는 앞에서 이미 다 말했고
 * 여기서 다시 말하면 두 벌이 된다.
 */
export const PROVIDER_SERIALIZATION_INSTRUCTION = [
  '',
  '## 8. 보낼 때의 담는 자리',
  '',
  `- 위에서 설명한 대답을 그대로 두되, 맨 바깥에 "${CANDIDATE_GENERATION_STRUCTURED_OUTPUT_ENVELOPE_KEY}"라는 자리 하나를 두고 그 안에 담는다.`,
  '- 담는 자리는 이 요청의 형식 때문에 생긴 것이다. 대답의 항목이나 뜻은 하나도 바뀌지 않는다.',
  '- 맨 바깥에 그 자리 말고 다른 것을 두지 않는다.',
].join('\n');

/**
 * 프롬프트를 고치지 않고 여기서만 붙이는 이유.
 *
 * 담는 자리는 제공자 사정이지 우리 뜻이 아니다.
 * 제공자가 바뀌면 이 한 줄만 사라지고, 프롬프트는 그대로 남는다.
 */
export const PROMPT_ENVELOPE_RESOLUTION = {
  canonicalPromptModified: false,
  providerSuffixAppendedAtAdapter: true,
  envelopeKeyAuthority: 'structured_output_schema',
  semanticFieldsRestatedInSuffix: false,
  status: 'RESOLVED_AT_PROVIDER_ADAPTER_BOUNDARY',
} as const;

/* ------------------------------------------------------------------ */
/* 2. 보낼 것                                                           */
/* ------------------------------------------------------------------ */

/**
 * 보낼 것을 적어 둔 것. 아직 보내지 않는다.
 *
 * 기다리는 시간은 본문 밖에 둔다. 그것은 보낼 내용이 아니라 부르는 쪽의 사정이다.
 */
export type CandidateGenerationOpenAIRequestSpec = {
  api: string;
  body: Record<string, unknown>;
  timeoutMs: number;
};

/** 본문에 담는 항목. 이것 말고 다른 것을 넣지 않는다. */
export const OPENAI_REQUEST_BODY_FIELDS = [
  'model',
  'instructions',
  'input',
  'reasoning',
  'max_output_tokens',
  'text',
  'store',
  'stream',
  'background',
  'truncation',
  'service_tier',
  'tools',
] as const;

/**
 * 보낼 것을 만든다.
 *
 * 값은 하나도 여기서 정하지 않는다. 이미 정해 둔 곳에서 가져온다.
 * 모양도 여기서 다시 만들지 않는다. 이미 만들어 둔 것을 그대로 넣는다.
 *
 * 받은 프롬프트를 고치지 않는다. 같은 프롬프트면 같은 것이 나온다.
 */
export function buildCandidateGenerationOpenAIRequestSpec(
  prompt: CandidateGenerationPrompt,
): CandidateGenerationOpenAIRequestSpec {
  const config = CANDIDATE_GENERATION_RUNTIME_CONFIG;

  return {
    api: config.api,
    timeoutMs: config.timeoutMs,
    body: {
      model: config.model,
      // 우리가 쓴 프롬프트 뒤에 담는 자리 설명만 덧붙인다.
      instructions: `${prompt.systemPrompt}\n${PROVIDER_SERIALIZATION_INSTRUCTION}`,
      input: prompt.userPrompt,
      reasoning: { effort: config.reasoningEffort },
      max_output_tokens: config.maxOutputTokens,
      text: {
        format: {
          type: config.structuredOutput.type,
          name: config.structuredOutput.schemaName,
          strict: config.structuredOutput.strict,
          // 모양은 이미 만들어 둔 것을 그대로 쓴다. 여기서 다시 짓지 않는다.
          schema: CANDIDATE_GENERATION_STRUCTURED_OUTPUT_SCHEMA,
        },
      },
      store: config.store,
      stream: config.stream,
      background: config.background,
      truncation: config.truncation,
      service_tier: config.serviceTier,
      // 도구를 주지 않기로 정해 두었다(toolsAllowed = false). 그래서 빈 목록이다.
      // 값을 조건으로 갈라 두지 않는다. 갈라 두면 쓰지 않는 쪽이 남아 언젠가 켜진다.
      tools: [],
    },
  };
}

/* ------------------------------------------------------------------ */
/* 3. 받은 것을 읽는 순서                                               */
/* ------------------------------------------------------------------ */

/**
 * 제공자가 알려 주는 진행 상태들.
 *
 * 이것은 제공자의 말이지 우리 말이 아니다.
 * 우리 상태로 옮기는 데만 쓰고, 이 이름을 다른 곳에서 쓰지 않는다.
 */
export const PROVIDER_RESPONSE_STATUSES = [
  'completed',
  'incomplete',
  'failed',
  'cancelled',
  'queued',
  'in_progress',
] as const;

/**
 * 읽는 순서.
 *
 * 순서가 중요하다. 뒤엣것을 먼저 보면 앞엣것이 가려진다.
 * 예를 들어 오류가 있는데 상태만 보고 "오다 말았다"로 읽으면,
 * 실제로는 무언가 잘못된 것을 정상적인 중단으로 적게 된다.
 */
export const RESPONSE_INTERPRETATION_ORDER = [
  '받은 것이 객체가 아니면 거기서 끝낸다.',
  '오류가 담겨 있으면 상태를 보기 전에 끝낸다.',
  '오다 말았으면 그렇게 끝낸다.',
  '끝난 것이 아니면 모두 문제로 본다. 기다렸다가 다시 보지 않는다.',
  '끝났으면 거절이 섞여 있는지 먼저 본다.',
  '거절이 없으면 답의 글을 읽는다.',
  '글을 JSON으로 읽고, 담는 자리를 확인하고, 벗긴다.',
  '벗긴 것을 이미 있는 검사기에 넘긴다.',
] as const;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * 거절이 섞여 있는가.
 *
 * 첫 항목만 보지 않는다. 온 것을 다 훑는다.
 * 거절이 두 번째 항목에, 또는 한 항목 안의 두 번째 조각에 있을 수 있다.
 *
 * 거절하며 적은 말은 읽지 않는다. 읽지 않으면 흘릴 일도 없다.
 */
const hasRefusal = (output: unknown): boolean => {
  if (!Array.isArray(output)) return false;

  for (const item of output) {
    if (!isPlainObject(item)) continue;

    const content = item.content;
    if (!Array.isArray(content)) continue;

    for (const part of content) {
      if (!isPlainObject(part)) continue;
      if (part.type === 'refusal') return true;
      if (typeof part.refusal === 'string') return true;
    }
  }

  return false;
};

/**
 * 받은 것을 우리 상태 하나로 옮긴다.
 *
 * 새 상태를 만들지 않는다. 이미 있는 열 가지 중 하나로만 끝난다.
 *
 * 답의 뜻이 맞는지는 여기서 보지 않는다.
 * 담는 자리를 벗긴 뒤 이미 있는 검사기에 넘기고, 그것이 판단한다.
 *
 * 어떤 경우에도 기술적인 실패를 "못 쓰겠다"로 바꾸지 않는다.
 */
export function interpretCandidateGenerationOpenAIResponse(
  response: unknown,
  input: CandidateModelGenerationInput,
): CandidateGenerationTransportOutcome {
  try {
    // ① 받은 것이 객체가 아니면 더 볼 것이 없다.
    if (!isPlainObject(response)) {
      return createCandidateGenerationTransportFailure('provider_error');
    }

    // ② 오류가 담겨 있으면 상태보다 먼저 본다.
    //    오류가 있는데 상태가 "오다 말았다"인 모순된 답을 정상으로 축소하지 않는다.
    if (response.error !== null && response.error !== undefined) {
      return createCandidateGenerationTransportFailure('provider_error');
    }

    const status = response.status;

    // ③ 오다 말았다.
    if (status === 'incomplete') {
      return createCandidateGenerationModelResponseOutcome('response_incomplete');
    }

    // ④ 끝난 것이 아니면 전부 문제로 본다.
    //    나눠 받지도, 맡겨 두지도 않기로 했으므로 기다렸다가 다시 볼 일이 없다.
    if (status !== 'completed') {
      return createCandidateGenerationTransportFailure('provider_error');
    }

    // ⑤ 거절이 섞여 있으면 글이 함께 와 있어도 거절이다.
    //    반쯤 온 글을 살려 쓰지 않는다.
    if (hasRefusal(response.output)) {
      return createCandidateGenerationModelResponseOutcome('model_refusal');
    }

    // ⑥ 답의 글. 온 것들 중에서 우리가 고르지 않는다. 제공자가 모아 준 것을 쓴다.
    const text = response.output_text;

    if (text === undefined || text === null) {
      return { outcome: 'empty_response' };
    }
    if (typeof text !== 'string') {
      // 글이 와야 할 자리에 다른 것이 와 있다. 비어 있는 것과 다르다.
      return createCandidateGenerationTransportFailure('provider_error');
    }

    const trimmed = text.trim();
    if (trimmed.length === 0) {
      return { outcome: 'empty_response' };
    }

    // ⑦ 정확히 한 번 읽는다. 코드 블록을 벗기거나 앞뒤를 잘라 내지 않는다.
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return { outcome: 'json_parse_failed' };
    }

    // ⑧ 담는 자리가 약속대로인가.
    const envelopeCheck = readEnvelope(parsed);
    if (!envelopeCheck.ok) {
      return { outcome: 'response_contract_invalid', errors: envelopeCheck.errors };
    }

    // ⑨ 벗긴 것을 이미 있는 검사기에 넘긴다.
    //    글자가 아니라 값으로 넘긴다. 같은 글을 두 번 읽지 않는다.
    return interpretCandidateGenerationTransportPayload(envelopeCheck.value, input);
  } catch {
    return createCandidateGenerationTransportFailure('provider_error');
  }
}

/**
 * 담는 자리를 확인하고 벗긴다.
 *
 * 맨 바깥이 객체여야 하고, 그 안에 약속한 자리 하나만 있어야 한다.
 * 다른 것이 함께 와 있으면 약속을 어긴 것이다. 그것을 조용히 무시하지 않는다.
 */
const readEnvelope = (
  value: unknown,
): { ok: true; value: unknown } | { ok: false; errors: string[] } => {
  if (!isPlainObject(value)) {
    return { ok: false, errors: ['담는 자리가 객체가 아닙니다.'] };
  }

  const keys = Object.keys(value);

  if (!keys.includes(CANDIDATE_GENERATION_STRUCTURED_OUTPUT_ENVELOPE_KEY)) {
    return { ok: false, errors: ['약속한 담는 자리가 없습니다.'] };
  }
  if (keys.length !== 1) {
    return { ok: false, errors: ['담는 자리 밖에 다른 것이 함께 왔습니다.'] };
  }

  return { ok: true, value: value[CANDIDATE_GENERATION_STRUCTURED_OUTPUT_ENVELOPE_KEY] };
};

/* ------------------------------------------------------------------ */
/* 4. 부르지 못했을 때                                                  */
/* ------------------------------------------------------------------ */

/**
 * 부르는 중에 실패한 경우를 우리 상태로 옮긴다.
 *
 * 어떤 오류가 어느 쪽인지 가리는 일은 실제로 부르는 계층이 한다.
 * 여기서는 이미 가려진 것을 받아 옮기기만 한다.
 * 오류 객체를 들여다보지 않는다.
 */
export const PROVIDER_CALL_FAILURE_KINDS = ['timeout', 'unavailable', 'other'] as const;

export type ProviderCallFailureKind = (typeof PROVIDER_CALL_FAILURE_KINDS)[number];

const CALL_FAILURE_TO_OUTCOME: Record<ProviderCallFailureKind, ProviderFailureKind> = {
  timeout: 'provider_timeout',
  unavailable: 'provider_unavailable',
  other: 'provider_error',
};

export function mapCandidateGenerationProviderCallFailure(
  kind: ProviderCallFailureKind,
): CandidateGenerationTransportOutcome {
  return createCandidateGenerationTransportFailure(CALL_FAILURE_TO_OUTCOME[kind]);
}

/* ------------------------------------------------------------------ */
/* 5. 여기서 하지 않는 일                                               */
/* ------------------------------------------------------------------ */

/**
 * 받은 것에서 남기지 않는 것들.
 *
 * 원문도, 거절하며 적은 말도, 오류 문구도, 생각한 흔적도 담지 않는다.
 * 한 번 담아 두면 그것이 언젠가 어딘가에 쓰인다.
 */
export const ADAPTER_PERSISTENCE_POLICY = {
  rawResponsePersisted: false,
  rawOutputTextPersisted: false,
  refusalTextPersisted: false,
  providerErrorMessagePersisted: false,
  reasoningExtracted: false,
  reasoningPersisted: false,
} as const;

/**
 * 다시 부르지 않는다.
 *
 * 오다 말았다고 해서 받는 길이를 늘려 다시 부르지 않는다.
 * 거절했다고 해서 다른 모델로 갈아타지 않는다.
 * 그런 판단은 밖에서 새 시도로 다뤄야 몇 번 물었는지가 드러난다.
 */
export const ADAPTER_RETRY_POLICY = {
  automaticRetries: CANDIDATE_GENERATION_RUNTIME_CONFIG.automaticRetries,
  fallbackModelAllowed: CANDIDATE_GENERATION_RUNTIME_CONFIG.fallbackModelAllowed,
  automaticJsonRepair: CANDIDATE_GENERATION_RUNTIME_CONFIG.automaticJsonRepair,
  outputBudgetRaisedOnIncomplete: false,
} as const;

/** 이 계층이 하지 않는 일. */
export const ADAPTER_DOES_NOT_INCLUDE = [
  '실제로 요청을 보내는 일',
  '열쇠를 찾거나 읽는 일',
  '기다리는 시간을 실제로 재는 일',
  '검토 대상 글을 조립하는 일',
  '글을 적어 두는 일',
] as const;
