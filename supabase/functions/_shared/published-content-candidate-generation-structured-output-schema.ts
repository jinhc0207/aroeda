/**
 * 모델에게 답의 모양을 강제하기 위한 schema.
 *
 * 이것은 규칙의 주인이 아니다. 규칙의 주인은 생성 계약이다.
 * 여기 있는 것은 그 계약을 제공자가 강제할 수 있는 형태로 옮겨 놓은 사본이다.
 * 그래서 항목 이름도, 결정 종류도, 보류 이유도 전부 계약에서 가져와 만든다.
 *
 * 한 겹을 더 씌운 이유.
 *
 * 우리 대답은 둘 중 하나다. 썼거나, 못 쓰겠거나.
 * 그것을 그대로 적으면 맨 바깥이 "둘 중 하나(anyOf)"가 된다.
 * 그런데 제공자는 맨 바깥이 객체여야 한다고 요구한다. 둘 중 하나를 맨 바깥에 둘 수 없다.
 *
 * 방법이 두 가지 있었다.
 *   하나. 대답을 { decision, draft, reason } 하나로 합치고 안 쓰는 쪽을 비워 둔다.
 *   둘. 바깥에 한 겹을 씌운다.
 *
 * 첫째를 고르면 우리 계약이 바뀐다.
 * 지금 계약은 "쓸 수 있으면 draft만, 못 쓰겠으면 reason만"이고,
 * 그 엄격함이 반쯤 채운 대답을 막고 있다. 그것을 제공자 사정으로 풀 수 없다.
 *
 * 그래서 둘째를 골랐다.
 * 씌운 한 겹은 제공자에게만 있는 것이고, 우리 쪽 어디에도 들어가지 않는다.
 * 받은 뒤 그 한 겹을 벗기면 지금까지의 계약이 그대로 이어진다.
 *
 * 이 파일은 모양만 강제한다. 뜻이 맞는지는 여전히 계약 검사기가 본다.
 * 두 겹으로 둔다. 하나가 느슨해도 다른 하나가 잡는다.
 */

import {
  DEFER_RESPONSE_FIELDS,
  GENERATE_RESPONSE_FIELDS,
  GENERATION_DECISIONS,
  GENERATION_DEFER_REASONS,
  MODEL_DRAFT_FIELDS,
  type CandidateModelGenerationResponse,
} from './published-content-candidate-generation-contract.ts';
import {
  CANDIDATE_PROSE_FIELDS,
  CANDIDATE_TAG_FIELDS,
} from './published-content-contract.ts';

/* ------------------------------------------------------------------ */
/* 1. 씌우는 한 겹                                                      */
/* ------------------------------------------------------------------ */

/**
 * 바깥에 씌우는 이름.
 *
 * 이것은 글의 항목이 아니다. 연구의 항목도, 검토의 항목도 아니다.
 * 제공자가 맨 바깥을 객체로 요구해서 생긴 자리일 뿐이다.
 *
 * 그래서 이 이름은 우리 쪽 어느 계약에도 들어가지 않는다.
 */
export const CANDIDATE_GENERATION_STRUCTURED_OUTPUT_ENVELOPE_KEY = 'response';

/** 받은 그대로의 모양. 한 겹을 벗기면 지금까지의 대답이 나온다. */
export type CandidateGenerationStructuredOutputEnvelope = {
  response: CandidateModelGenerationResponse;
};

/**
 * 왜 한 겹이 필요한지, 그리고 그것이 무엇이 아닌지.
 *
 * 앞으로 어댑터가 할 일도 여기 적어 둔다.
 * 받은 것에서 한 겹을 벗기고, 벗긴 것을 지금 있는 검사기에 넘긴다.
 * 어댑터가 그 검사기를 대신하지 않는다.
 */
export const PROVIDER_ENVELOPE_NOTE = {
  providerEnvelopeRequired: true,
  reason: '제공자는 맨 바깥이 객체여야 한다. 우리 대답은 둘 중 하나라 맨 바깥에 그대로 둘 수 없다.',
  belongsToApplicationContract: false,
  applicationResponseChanged: false,
  adapterMustUnwrapBeforeValidating: true,
} as const;

/* ------------------------------------------------------------------ */
/* 2. 모양                                                              */
/* ------------------------------------------------------------------ */

/**
 * 쓰는 낱말을 좁게 둔다.
 *
 * 제공자가 받아 주는 것 중에서도 꼭 필요한 것만 쓴다.
 * 넓게 쓰면 어느 날 제공자가 받지 않는 것이 섞여 들어와도 알아채기 어렵다.
 */
type SchemaNode =
  | { type: 'object'; properties: Record<string, SchemaNode>; required: string[]; additionalProperties: false }
  | { type: 'string'; enum?: string[] }
  | { type: 'integer' }
  | { type: 'array'; items: SchemaNode }
  | { anyOf: SchemaNode[] };

const objectNode = (properties: Record<string, SchemaNode>): SchemaNode => ({
  type: 'object',
  properties,
  // 적어 둔 항목은 모두 있어야 한다. 제공자가 그렇게 요구한다.
  required: Object.keys(properties),
  additionalProperties: false,
});

const stringNode = (): SchemaNode => ({ type: 'string' });
const stringEnumNode = (values: readonly string[]): SchemaNode => ({ type: 'string', enum: [...values] });
const stringArrayNode = (): SchemaNode => ({ type: 'array', items: stringNode() });
const integerNode = (): SchemaNode => ({ type: 'integer' });

/** 결정 종류 둘. 계약이 적어 둔 차례를 그대로 쓴다. */
const [GENERATE_DECISION, DEFER_DECISION] = GENERATION_DECISIONS;

/**
 * 모델이 쓰는 열한 항목의 모양.
 *
 * 항목 이름을 여기 손으로 적지 않는다. 계약의 목록을 그대로 돈다.
 * 계약에 항목이 하나 늘면 여기도 함께 는다.
 *
 * 각 항목의 종류는 이미 나뉘어 있는 부류에서 가져온다.
 *   태그 다섯은 글자 목록, 산문 넷은 글자, 오용을 막는 문구는 글자 목록.
 *   나머지 하나는 몇 번째인가를 가리키는 수다.
 */
const draftProperties = (): Record<string, SchemaNode> => {
  const properties: Record<string, SchemaNode> = {};

  for (const field of MODEL_DRAFT_FIELDS) {
    if ((CANDIDATE_TAG_FIELDS as readonly string[]).includes(field)) {
      properties[field] = stringArrayNode();
      continue;
    }
    if ((CANDIDATE_PROSE_FIELDS as readonly string[]).includes(field)) {
      properties[field] = stringNode();
      continue;
    }
    if (field === 'misuseGuards') {
      properties[field] = stringArrayNode();
      continue;
    }
    // 남는 것은 몇 번째 본문인가 하나뿐이다.
    properties[field] = integerNode();
  }

  return properties;
};

/**
 * 태그에 낱말 목록을 붙이지 않는다.
 *
 * 지금 있는 카드에서 모은 사전으로 가두면
 * 새 영역의 글이 새 말을 쓰지 못하게 된다.
 * 그 판단은 사람이 한다. 앞 계약이 그렇게 정했고 여기서 뒤집지 않는다.
 */
const generateBranch = (): SchemaNode => {
  const properties: Record<string, SchemaNode> = {};

  for (const field of GENERATE_RESPONSE_FIELDS) {
    properties[field] =
      field === 'decision'
        ? stringEnumNode([GENERATE_DECISION as string])
        : objectNode(draftProperties());
  }

  return objectNode(properties);
};

const deferBranch = (): SchemaNode => {
  const properties: Record<string, SchemaNode> = {};

  for (const field of DEFER_RESPONSE_FIELDS) {
    properties[field] =
      field === 'decision'
        ? stringEnumNode([DEFER_DECISION as string])
        : stringEnumNode(GENERATION_DEFER_REASONS);
  }

  return objectNode(properties);
};

/**
 * 제공자에게 넘길 모양.
 *
 * 맨 바깥은 객체 하나이고, 그 안에 한 자리만 있다.
 * 둘 중 하나를 고르는 일은 그 한 자리 안에서 일어난다.
 */
export const CANDIDATE_GENERATION_STRUCTURED_OUTPUT_SCHEMA: SchemaNode = objectNode({
  [CANDIDATE_GENERATION_STRUCTURED_OUTPUT_ENVELOPE_KEY]: {
    anyOf: [generateBranch(), deferBranch()],
  },
});

/* ------------------------------------------------------------------ */
/* 3. 이 모양이 대신하지 않는 것                                        */
/* ------------------------------------------------------------------ */

/**
 * 모양이 맞다고 뜻이 맞는 것은 아니다.
 *
 * 이 모양은 항목이 무엇인지, 종류가 무엇인지까지만 강제한다.
 * 글이 너무 길지 않은지, 고른 번호가 실제로 있는 번호인지,
 * 태그가 겹치지 않는지 같은 것은 여기서 보지 않는다.
 *
 * 그것을 여기 다 옮기면 규칙이 두 벌이 되고,
 * 계약이 바뀌는 날 모델은 옛 모양으로 답하고 검사기는 새 규칙으로 막는다.
 *
 * 그래서 여기는 얇게 두고, 판단은 계약 검사기에 남긴다.
 */
export const SCHEMA_IS_STRUCTURAL_ONLY = {
  classification: 'provider_enforcement_mirror',
  semanticAuthority: 'validateCandidateModelGenerationResponse',
  enforcesLengthBounds: false,
  enforcesSelectedPassageRange: false,
  enforcesTagVocabulary: false,
  replacesApplicationValidator: false,
} as const;

/**
 * 여기서 정하지 않는 것.
 *
 * 이 모양을 어떤 이름으로 부르는지, 엄격하게 쓸 것인지는
 * 이미 정해 둔 곳이 있다. 여기서 다시 정하지 않는다.
 */
export const SCHEMA_NAME_AND_MODE_AUTHORITY =
  '이 모양의 이름과 엄격하게 쓸지 여부는 부르는 방식을 정한 곳에 있다. 여기서 다시 정하지 않는다.';
