/**
 * Sol·Astra 신학 평가자를 위한 OpenAI Responses API 요청/응답 경계.
 *
 * 이 파일이 하는 일은 둘이다.
 *   1. TheologyEvaluationRequest에서 보낼 요청을 결정적으로 만든다.
 *   2. 받은 응답을 이미 있는 관례(오류 → incomplete → 상태 → 거절 → 글 → JSON → 담는 자리 →
 *      모양·차례·판정)를 그대로 따라 읽고, 카드마다 rubric criterion 아홉 개 전부의 판정
 *      {criterionId, verdict}만 담은 배열로 돌려준다.
 *
 * 모델은 카드의 최종 verdict를 내지 않는다. criterion 하나하나만 판정한다.
 * 카드 하나가 pass인지 fail인지는 이 파일이 정하지 않는다 — criterion 판정을 받은 쪽(실행기)이
 * "criterion 하나라도 fail이면 카드는 fail"이라는 규칙으로 코드에서 계산한다. 그래서 모델의
 * 출력에는 criterionId·verdict 말고는 아무것도 없다. 카드 verdict, 설명, 근거, confidence도 없다.
 *
 * 이 파일이 하지 않는 일.
 *   실제로 요청을 보내는 일(fetch), 열쇠를 찾거나 읽는 일, 시간을 실제로 재는 일,
 *   모델 원문을 남기거나 로그하는 일. 그런 일은 이 경계를 감싸는 별도 계층(전송)의 몫이다.
 *
 * 모델은 registry가 정한 것만 쓴다.
 *   이 파일은 SOL_MODEL_ID·ASTRA_MODEL_ID 같은 상수를 알지 못한다.
 *   요청에 실려 온 request.modelId를 그대로 옮길 뿐이다. criterion 목록도 request.rubric에서
 *   그대로 읽을 뿐, 이 파일이 rubric의 아홉 기준을 손으로 적어 두지 않는다.
 */

import { canonicalJson } from './automatic-scripture-catalog-contract.ts';
import { extractOutputText, hasRefusal } from './openai-response.ts';
import type { TheologyEvaluationRequest } from './automatic-scripture-catalog-validator-executor.ts';

/* ------------------------------------------------------------------ */
/* 1. 불러 쓸 값 — 여기서 새로 정하지 않는다                              */
/* ------------------------------------------------------------------ */

export const THEOLOGY_EVALUATION_INPUT_CONTRACT_VERSION = 'automatic-scripture-catalog-theology-evaluation-input/v1';

/**
 * 어떻게 부를지 정한 값. 실제로 부르는 코드는 다음 계층(전송)의 몫이다.
 * 표본 조정(temperature·top_p)은 여기 없다 — 정하지 않은 것이지 빠뜨린 것이 아니다.
 */
export const THEOLOGY_EVALUATION_RUNTIME_CONFIG = {
  provider: 'openai',
  api: 'responses',
  reasoningEffort: 'medium',
  timeoutMs: 60_000,
  maxOutputTokens: 2_048,
  structuredOutput: {
    type: 'json_schema',
    strict: true,
    schemaName: 'aroeda_theology_evaluation_v1',
  },
  /** 모델 쪽에 답을 남겨 두지 않는다. */
  store: false,
  /** 조금씩 받지 않는다. 완성된 답 하나만 받아 검사한다. */
  stream: false,
  /** 맡겨 두고 나중에 찾아오지 않는다. */
  background: false,
  truncation: 'disabled',
  serviceTier: 'default',
  /** 검색도 함수 호출도 없다. rubric과 넘겨준 증거뿐이다. */
  toolsAllowed: false,
  /** 다시 부르지 않는다. 오다 말았다고 늘려 다시 부르지 않는다. */
  automaticRetries: 0,
  fallbackModelAllowed: false,
} as const;

/* ------------------------------------------------------------------ */
/* 2. 보낼 때 담는 자리 — provider가 맨 바깥을 객체로 요구해서 생긴 자리   */
/* ------------------------------------------------------------------ */

/** 판정 배열을 담는 바깥 자리 이름. 우리 계약의 항목이 아니라 provider 사정으로 생긴 자리다. */
export const THEOLOGY_EVALUATION_ENVELOPE_KEY = 'cardEvaluations';

export const THEOLOGY_EVALUATION_INSTRUCTIONS = [
  '당신은 자동 Scripture Catalog 후보를 신학적으로 검수하는 평가자다.',
  '입력(input)에는 판정 기준(rubric), 판정할 후보(candidate), 기준 카탈로그의 기존 영역 목록(baselineDomains),',
  '그리고 실제로 확인된 개역한글 본문(verifiedPassages)이 들어 있다.',
  '',
  '## 판정 방법',
  '- rubric.criteria에 있는 criterion 아홉 개 각각을 독립적으로 판정한다. rubric에 없는 기준을 만들어 쓰지 않는다.',
  '- verifiedPassages는 이미 실제 개역한글 본문에서 확인된 값이다. 본문을 새로 찾거나 다시 옮겨 적지 않는다.',
  '- baselineDomains는 candidate.targetDomainId가 기존 영역과 구분되는지(new-domain-distinctness) 판단하는 데만 쓴다.',
  '- candidate.cards에 있는 카드 각각에 대해, rubric.criteria의 criterion 아홉 개 전부를 rubric에 적힌 순서 그대로 판정한다.',
  '  카드 하나마다 criterion을 빠뜨리거나 더하거나 순서를 바꾸지 않는다.',
  '- criterion 하나의 판정은 정확히 pass 또는 fail 둘 중 하나다.',
  '- **카드 전체의 최종 판정(카드가 통과인지 실패인지)은 절대 내지 않는다.** 그것은 당신이 낸 criterion 판정을 모아',
  '  뒤에서 코드로 계산한다. criterion 판정 말고 다른 것(카드 최종 verdict, 설명, 근거, 확신도, 그 밖의 어떤 말)도',
  '  덧붙이지 않는다.',
  '',
  '## 담는 자리',
  `- 결과는 맨 바깥의 "${THEOLOGY_EVALUATION_ENVELOPE_KEY}" 자리 하나에 그대로 둔다.`,
  '- 그 자리는 이 요청 형식 때문에 생긴 것이다. 맨 바깥에 그 자리 말고 다른 것을 두지 않는다.',
].join('\n');

/* ------------------------------------------------------------------ */
/* 3. 답의 모양(schema) — 후보 카드·rubric criterion 집합에 맞춰 그때그때 만든다 */
/* ------------------------------------------------------------------ */

type JsonSchemaNode =
  | { type: 'object'; properties: Record<string, JsonSchemaNode>; required: string[]; additionalProperties: false }
  | { type: 'string'; enum: string[] }
  | { type: 'array'; items: JsonSchemaNode };

/**
 * 후보 카드 id·rubric criterion id 집합에서 답의 모양을 만든다.
 *
 * cardId·criterionId는 이 요청의 후보·rubric에 실제로 있는 것만 허용 목록으로 둔다
 * (provider 쪽에서 한 겹 더 막는다). 그렇다고 이것만 믿지 않는다. 받은 뒤 해석 함수가
 * 차례·개수·중복을 다시 본다. 모델의 verdict는 criterion 하나에 대한 것뿐이고,
 * 카드 최종 verdict를 담을 자리는 이 schema 어디에도 없다.
 */
function buildCardCriterionEvaluationSchema(cardIds: readonly string[], criterionIds: readonly string[]): JsonSchemaNode {
  return {
    type: 'object',
    properties: {
      [THEOLOGY_EVALUATION_ENVELOPE_KEY]: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            cardId: { type: 'string', enum: [...cardIds] },
            criteria: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  criterionId: { type: 'string', enum: [...criterionIds] },
                  verdict: { type: 'string', enum: ['pass', 'fail'] },
                },
                required: ['criterionId', 'verdict'],
                additionalProperties: false,
              },
            },
          },
          required: ['cardId', 'criteria'],
          additionalProperties: false,
        },
      },
    },
    required: [THEOLOGY_EVALUATION_ENVELOPE_KEY],
    additionalProperties: false,
  };
}

/* ------------------------------------------------------------------ */
/* 4. 보낼 것을 만든다                                                  */
/* ------------------------------------------------------------------ */

export type TheologyEvaluationOpenAIRequestSpec = {
  api: string;
  body: Record<string, unknown>;
  timeoutMs: number;
};

/** 본문에 담는 항목. 이것 말고 다른 것을 넣지 않는다(temperature·top_p는 여기 없다). */
export const THEOLOGY_EVALUATION_REQUEST_BODY_FIELDS = [
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
 * 보낼 것을 만든다. 부르지는 않는다.
 *
 * 같은 request(candidate·rubric·baselineDomains·verifiedPassages·modelId)면 같은 것이 나온다.
 * 모델 id는 request.modelId를 그대로 옮길 뿐, 이 파일이 Sol·Astra를 구분해 고르지 않는다.
 * criterion 목록도 request.rubric.criteria에서 그대로 읽을 뿐 손으로 다시 적지 않는다.
 */
export function buildTheologyEvaluationOpenAIRequestSpec(
  request: TheologyEvaluationRequest,
): TheologyEvaluationOpenAIRequestSpec {
  const config = THEOLOGY_EVALUATION_RUNTIME_CONFIG;
  const cardIds = request.candidate.cards.map((card) => card.id);
  const criterionIds = request.rubric.criteria.map((criterion) => criterion.criterionId);

  // 보낼 증거. rubric 전체 + 후보 + 기준 영역 + 검증된 본문. 사용자 원문·열쇠·인증값은 여기 없다.
  const evidence = {
    contractVersion: THEOLOGY_EVALUATION_INPUT_CONTRACT_VERSION,
    rubric: request.rubric,
    candidate: request.candidate,
    baselineDomains: request.baselineDomains,
    verifiedPassages: request.verifiedPassages,
  };

  return {
    api: config.api,
    timeoutMs: config.timeoutMs,
    body: {
      model: request.modelId,
      instructions: THEOLOGY_EVALUATION_INSTRUCTIONS,
      // 키 순서에 기대지 않는다. canonicalJson이 정렬해 항상 같은 글자를 만든다.
      input: canonicalJson(evidence),
      reasoning: { effort: config.reasoningEffort },
      max_output_tokens: config.maxOutputTokens,
      text: {
        format: {
          type: config.structuredOutput.type,
          name: config.structuredOutput.schemaName,
          strict: config.structuredOutput.strict,
          schema: buildCardCriterionEvaluationSchema(cardIds, criterionIds),
        },
      },
      store: config.store,
      stream: config.stream,
      background: config.background,
      truncation: config.truncation,
      service_tier: config.serviceTier,
      // 도구를 주지 않는다. 웹 검색도, 함수 호출도 없다. 값을 조건으로 갈라 두지 않는다.
      tools: [],
    },
  };
}

/* ------------------------------------------------------------------ */
/* 5. 받은 것을 읽는 순서                                                */
/* ------------------------------------------------------------------ */

/**
 * 읽는 순서. 기존 후보 생성 어댑터의 관례를 그대로 따른다.
 * 순서가 중요하다. 뒤엣것을 먼저 보면 앞엣것이 가려진다.
 */
export const THEOLOGY_EVALUATION_RESPONSE_INTERPRETATION_ORDER = [
  '받은 것이 객체가 아니면 거기서 끝낸다.',
  '오류가 담겨 있으면 상태를 보기 전에 끝낸다.',
  '오다 말았으면 그렇게 끝낸다(글이 함께 와 있어도).',
  '끝난 것이 아니면 모두 문제로 본다.',
  '거절이 섞여 있는지 먼저 본다(정상 글과 함께 와도 거절이다).',
  '답의 글을 읽는다. 없거나 비어 있으면 빈 응답이다.',
  '글을 JSON으로 정확히 한 번 읽는다. 코드 블록을 벗기지 않는다.',
  '담는 자리가 약속과 같은지 본다.',
  '카드 개수·차례·id, criterion 개수·차례·id, verdict가 정확히 같은지 본다.',
  '전부 맞으면 카드별 {cardId, criteria: [{criterionId, verdict}]} 배열만 돌려준다.',
] as const;

export const THEOLOGY_EVALUATION_RESPONSE_OUTCOME_KINDS = [
  'success',
  'provider_error',
  'incomplete',
  'model_refusal',
  'empty_response',
  'json_parse_failed',
  'response_contract_invalid',
] as const;
export type TheologyEvaluationResponseOutcomeKind = (typeof THEOLOGY_EVALUATION_RESPONSE_OUTCOME_KINDS)[number];

export type CriterionVerdictResult = { criterionId: string; verdict: 'pass' | 'fail' };
export type CardCriterionEvaluationResult = { cardId: string; criteria: CriterionVerdictResult[] };

export type TheologyEvaluationOpenAIResponseOutcome =
  | { outcome: 'success'; cardEvaluations: CardCriterionEvaluationResult[] }
  | { outcome: 'response_contract_invalid'; errors: string[] }
  | { outcome: Exclude<TheologyEvaluationResponseOutcomeKind, 'success' | 'response_contract_invalid'> };

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const exactFields = (value: Record<string, unknown>, expected: readonly string[]): boolean =>
  Object.keys(value).length === expected.length && expected.every((field) => Object.hasOwn(value, field));

/**
 * 받은 것을 카드별 criterion 판정 배열 하나(또는 실패 종류 하나)로 옮긴다.
 *
 * expectedCardIds는 이 요청이 판정을 부탁한 후보 카드의 id 목록, candidate.cards 순서 그대로다.
 * expectedCriterionIds는 이 요청이 보낸 rubric의 criterion id 목록, rubric.criteria 순서 그대로다.
 * 카드마다 이 criterion 아홉 개 전부가 같은 순서로 있어야 한다 — 하나라도 빠지거나 늘거나
 * 순서가 바뀌거나 모르는 criterionId가 오면 무효다.
 *
 * 기술적으로 실패한 것과 모델이 유효한 모양으로 criterion에 fail을 낸 것을 구분한다 — 후자는 success다.
 * 카드의 최종 verdict는 여기서 계산하지 않는다. 그것은 이 배열을 받는 쪽(실행기)의 몫이다.
 *
 * 무엇을 남기지 않는가: 모델 원문, 거절 문구, 오류 메시지, 생각한 흔적. 이 함수는 그런 것을
 * 어디에도 기록하지 않는다. 실패하면 종류 이름 하나(와 필요할 때만 모양 오류 목록)만 돌려준다.
 */
export function interpretTheologyEvaluationOpenAIResponse(
  response: unknown,
  expectedCardIds: readonly string[],
  expectedCriterionIds: readonly string[],
): TheologyEvaluationOpenAIResponseOutcome {
  try {
    // ① 받은 것이 객체가 아니면 더 볼 것이 없다.
    if (!isPlainObject(response)) return { outcome: 'provider_error' };

    // ② 오류가 담겨 있으면 상태보다 먼저 본다. completed와 함께 와도 오류가 이긴다.
    if (response.error !== null && response.error !== undefined) return { outcome: 'provider_error' };

    const status = response.status;

    // ③ 오다 말았다. 글이 함께 와 있어도 살려 쓰지 않는다.
    if (status === 'incomplete') return { outcome: 'incomplete' };

    // ④ 끝난 것이 아니면 전부 문제로 본다. 기다렸다가 다시 보지 않는다.
    if (status !== 'completed') return { outcome: 'provider_error' };

    // ⑤ 거절이 섞여 있으면 정상 글이 함께 와 있어도 거절이다.
    if (hasRefusal(response)) return { outcome: 'model_refusal' };

    // ⑥ 답의 글. 제공자가 모아 준 것을 그대로 쓴다.
    const text = extractOutputText(response);
    if (text === null || text.trim().length === 0) return { outcome: 'empty_response' };

    // ⑦ 정확히 한 번 읽는다. 코드 블록을 벗기거나 앞뒤를 잘라 내지 않는다.
    let parsed: unknown;
    try {
      parsed = JSON.parse(text.trim());
    } catch {
      return { outcome: 'json_parse_failed' };
    }

    // ⑧ 담는 자리가 약속대로인가. 그 자리 말고 다른 것이 함께 오면 약속을 어긴 것이다.
    if (!isPlainObject(parsed) || !exactFields(parsed, [THEOLOGY_EVALUATION_ENVELOPE_KEY])) {
      return { outcome: 'response_contract_invalid', errors: ['담는 자리가 약속과 다릅니다.'] };
    }
    const cardEvaluationsValue = parsed[THEOLOGY_EVALUATION_ENVELOPE_KEY];

    // ⑨ 카드 개수·차례·id, criterion 개수·차례·id·verdict가 정확히 후보·rubric과 같은가.
    if (!Array.isArray(cardEvaluationsValue) || cardEvaluationsValue.length !== expectedCardIds.length) {
      return { outcome: 'response_contract_invalid', errors: ['카드 개수가 후보와 다릅니다.'] };
    }
    const cardEvaluations: CardCriterionEvaluationResult[] = [];
    for (let cardIndex = 0; cardIndex < cardEvaluationsValue.length; cardIndex += 1) {
      const cardItem = cardEvaluationsValue[cardIndex];
      if (!isPlainObject(cardItem) || !exactFields(cardItem, ['cardId', 'criteria'])) {
        return { outcome: 'response_contract_invalid', errors: [`[${cardIndex}]: 모양이 맞지 않습니다.`] };
      }
      if (cardItem.cardId !== expectedCardIds[cardIndex]) {
        return { outcome: 'response_contract_invalid', errors: [`[${cardIndex}]: 후보 카드 차례·번호와 다릅니다.`] };
      }
      if (!Array.isArray(cardItem.criteria) || cardItem.criteria.length !== expectedCriterionIds.length) {
        return { outcome: 'response_contract_invalid', errors: [`[${cardIndex}].criteria: criterion 개수가 rubric과 다릅니다.`] };
      }
      const criteria: CriterionVerdictResult[] = [];
      for (let criterionIndex = 0; criterionIndex < cardItem.criteria.length; criterionIndex += 1) {
        const criterionItem = cardItem.criteria[criterionIndex];
        if (!isPlainObject(criterionItem) || !exactFields(criterionItem, ['criterionId', 'verdict'])) {
          return { outcome: 'response_contract_invalid', errors: [`[${cardIndex}].criteria[${criterionIndex}]: 모양이 맞지 않습니다.`] };
        }
        if (criterionItem.criterionId !== expectedCriterionIds[criterionIndex]) {
          return {
            outcome: 'response_contract_invalid',
            errors: [`[${cardIndex}].criteria[${criterionIndex}]: criterion 차례·id가 rubric과 다릅니다.`],
          };
        }
        if (criterionItem.verdict !== 'pass' && criterionItem.verdict !== 'fail') {
          return { outcome: 'response_contract_invalid', errors: [`[${cardIndex}].criteria[${criterionIndex}]: pass·fail이 아닙니다.`] };
        }
        criteria.push({ criterionId: criterionItem.criterionId, verdict: criterionItem.verdict });
      }
      cardEvaluations.push({ cardId: cardItem.cardId, criteria });
    }

    // ⑩ 전부 맞았다. 모델의 criterion fail도 여기서는 성공이다 — 기술적 실패가 아니라 정상 평가 결과다.
    return { outcome: 'success', cardEvaluations };
  } catch {
    return { outcome: 'provider_error' };
  }
}

/* ------------------------------------------------------------------ */
/* 6. 남기지 않는 것 · 여기서 하지 않는 일                                */
/* ------------------------------------------------------------------ */

export const THEOLOGY_EVALUATION_ADAPTER_PERSISTENCE_POLICY = {
  rawResponsePersisted: false,
  rawOutputTextPersisted: false,
  refusalTextPersisted: false,
  providerErrorMessagePersisted: false,
  explanationRequested: false,
  explanationPersisted: false,
  confidencePersisted: false,
  /** 모델은 카드 최종 verdict를 내지 않으므로 이 자리는 애초에 요청도 저장도 하지 않는다. */
  cardFinalVerdictRequestedFromModel: false,
} as const;

export const THEOLOGY_EVALUATION_ADAPTER_RETRY_POLICY = {
  automaticRetries: THEOLOGY_EVALUATION_RUNTIME_CONFIG.automaticRetries,
  fallbackModelAllowed: THEOLOGY_EVALUATION_RUNTIME_CONFIG.fallbackModelAllowed,
  outputBudgetRaisedOnIncomplete: false,
} as const;

export const THEOLOGY_EVALUATION_ADAPTER_DOES_NOT_INCLUDE = [
  '실제로 요청을 보내는 일',
  '열쇠를 찾거나 읽는 일',
  '기다리는 시간을 실제로 재는 일',
  'modelId를 스스로 고르는 일(request.modelId를 그대로 옮길 뿐이다)',
  '카드 최종 verdict를 계산하는 일(criterion 판정만 받는다. 최종 계산은 실행기의 몫이다)',
  '모델 원문·거절 문구·오류 메시지를 남기는 일',
] as const;
