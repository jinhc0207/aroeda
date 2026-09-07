/**
 * 제공자 쪽 모양으로 옮기는 자리 · 테스트
 *
 * 실행: npm test
 *
 * 지키려는 것 여섯 가지.
 *
 *   1. 보낼 값을 여기서 새로 정하지 않는다. 이미 정해 둔 곳에서 가져온다.
 *   2. 프롬프트를 고치지 않고, 담는 자리 설명만 보낼 때 덧붙인다.
 *   3. 거절·오다 만 것·못 읽은 것·못 쓰겠다는 판단을 뭉치지 않는다.
 *   4. 담는 자리를 벗긴 뒤에야 이미 있는 검사기에 넘긴다.
 *   5. 모양이 맞다고 뜻이 맞는 것은 아니다.
 *   6. 원문도 거절 문구도 생각한 흔적도 남기지 않는다.
 *
 * 모델을 부르지 않는다. 받았다고 치는 값을 손으로 만들어 넣는다.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  ADAPTER_DOES_NOT_INCLUDE,
  ADAPTER_PERSISTENCE_POLICY,
  ADAPTER_RETRY_POLICY,
  OPENAI_REQUEST_BODY_FIELDS,
  PROMPT_ENVELOPE_RESOLUTION,
  PROVIDER_CALL_FAILURE_KINDS,
  PROVIDER_SERIALIZATION_INSTRUCTION,
  RESPONSE_INTERPRETATION_ORDER,
  buildCandidateGenerationOpenAIRequestSpec,
  interpretCandidateGenerationOpenAIResponse,
  mapCandidateGenerationProviderCallFailure,
} from '../../supabase/functions/_shared/published-content-candidate-generation-openai-adapter-contract.ts';
import {
  CANDIDATE_GENERATION_STRUCTURED_OUTPUT_ENVELOPE_KEY,
  CANDIDATE_GENERATION_STRUCTURED_OUTPUT_SCHEMA,
} from '../../supabase/functions/_shared/published-content-candidate-generation-structured-output-schema.ts';
import { CANDIDATE_GENERATION_RUNTIME_CONFIG } from '../../supabase/functions/_shared/published-content-candidate-generation-runtime-config.ts';
import {
  TRANSPORT_OUTCOMES,
  canInvokeCandidateBuilder,
} from '../../supabase/functions/_shared/published-content-candidate-generation-transport-contract.ts';
import {
  GENERATION_DEFER_REASONS,
  MODEL_DRAFT_FIELDS,
  buildCandidateModelGenerationInput,
  type CandidateModelGenerationInput,
} from '../../supabase/functions/_shared/published-content-candidate-generation-contract.ts';
import { buildCandidateGenerationPrompt } from '../../supabase/functions/_shared/published-content-candidate-generation-prompt.ts';

const ADAPTER_PATH =
  '../../supabase/functions/_shared/published-content-candidate-generation-openai-adapter-contract.ts';
const ADAPTER_SOURCE = readFileSync(new URL(ADAPTER_PATH, import.meta.url), 'utf8');

const ENVELOPE = CANDIDATE_GENERATION_STRUCTURED_OUTPUT_ENVELOPE_KEY;
const config = CANDIDATE_GENERATION_RUNTIME_CONFIG;

/* ------------------------------------------------------------------ */
/* fixture                                                             */
/* ------------------------------------------------------------------ */

const PSALM_56 = { book: 'Psalms', chapter: 56, startVerse: 3, endVerse: 4 };

const researchResult = () => ({
  targetDomain: 'financial_hardship',
  evidenceVersion: 4,
  prioritizerSnapshotId: `snap_${'b'.repeat(64)}`,
  researchQuestion: '성경은 이 삶의 문제를 어떤 본문에서 직접 다루는가?',
  domainBoundaries: { includedConcerns: ['생계 압박'], excludedOrAdjacentConcerns: [] },
  candidatePassages: [
    {
      reference: PSALM_56,
      additionalReferences: [],
      canonicalContext: '이 본문이 놓인 원래 흐름에 대한 연구 메모입니다.',
      theologicalContribution: '이 본문이 이 영역에 주는 신학적 기여에 대한 메모입니다.',
      domainFit: '이 삶의 문제를 직접 다루기 때문입니다.',
      pastoralUse: ['위로'],
      misuseRisks: ['결과 보장으로 사용하지 않는다.'],
      distinctnessFromActiveCoverage: { distinct: true, nearestExistingDomain: 'x', explanation: 'y' },
      researchConfidence: 0.6,
      sourceSupport: {
        exegesisEvidenceIds: [], theologyEvidenceIds: [], pastoralEvidenceIds: [], safetyEvidenceIds: [],
        exegesisSourceIds: [], theologySourceIds: [], pastoralSourceIds: [], safetySourceIds: [],
      },
    },
  ],
  rejectedPassages: [],
  unresolvedQuestions: [],
  evidenceSetHash: `evset_${'c'.repeat(64)}`,
});

const INPUT = buildCandidateModelGenerationInput(researchResult()) as CandidateModelGenerationInput;
const PROMPT = buildCandidateGenerationPrompt(INPUT);

const draft = (over: Record<string, unknown> = {}) => ({
  selectedPassageIndex: 0,
  situationTags: ['생계가 흔들림'],
  emotionTags: ['막막함'],
  spiritualQuestionTags: ['하나님의 돌보심'],
  prayerModes: ['간구'],
  pastoralFunction: ['위로'],
  contextSummary: '이 본문이 놓인 흐름을 짧게 정리한 내부 설명입니다.',
  theologicalInsight: '이 본문이 붙드는 신학적 중심을 한 문장으로 적은 것입니다.',
  userExplanation: '지금 형편이 막막할 때 이 말씀이 무엇을 말하는지 쉬운 말로 설명합니다.',
  prayerDirection: '이 말씀을 붙들고 무엇을 아뢸 수 있는지 방향을 짧게 안내합니다.',
  misuseGuards: ['형편이 곧 나아진다는 약속으로 읽지 않는다.'],
  ...over,
});

const envelopeText = (inner: unknown) => JSON.stringify({ [ENVELOPE]: inner });

/** 제공자가 이렇게 돌려줬다고 치는 값. 실제로 부르지 않는다. */
const providerResponse = (over: Record<string, unknown> = {}) => ({
  status: 'completed',
  error: null,
  output: [{ type: 'message', content: [{ type: 'output_text', text: 'x' }] }],
  output_text: envelopeText({ decision: 'generate', draft: draft() }),
  ...over,
});

const read = (response: unknown) => interpretCandidateGenerationOpenAIResponse(response, INPUT);

/* ================================================================== */
/* A. 보낼 것 — 값의 출처                                               */
/* ================================================================== */

describe('제공자 연결 · A. 보낼 것', () => {
  const spec = buildCandidateGenerationOpenAIRequestSpec(PROMPT);

  it('보낼 것의 겉모양이 셋이다', () => {
    assert.deepEqual(Object.keys(spec).sort(), ['api', 'body', 'timeoutMs']);
  });

  it('부르는 방식이 정해 둔 것과 같다', () => {
    assert.equal(spec.api, config.api);
  });

  it('본문 항목이 열둘뿐이다', () => {
    assert.equal(OPENAI_REQUEST_BODY_FIELDS.length, 12);
    assert.deepEqual(Object.keys(spec.body).sort(), [...OPENAI_REQUEST_BODY_FIELDS].sort());
  });

  it('모델과 생각하는 정도가 정해 둔 것과 같다', () => {
    assert.equal(spec.body.model, config.model);
    assert.deepEqual(spec.body.reasoning, { effort: config.reasoningEffort });
  });

  it('출력 한도가 정해 둔 것과 같다', () => {
    assert.equal(spec.body.max_output_tokens, config.maxOutputTokens);
  });

  it('형식이 정해 둔 것과 같다', () => {
    const format = (spec.body.text as Record<string, unknown>).format as Record<string, unknown>;
    assert.equal(format.type, config.structuredOutput.type);
    assert.equal(format.name, config.structuredOutput.schemaName);
    assert.equal(format.strict, config.structuredOutput.strict);
  });

  it('모양을 새로 짓지 않고 있던 것을 그대로 쓴다', () => {
    const format = (spec.body.text as Record<string, unknown>).format as Record<string, unknown>;
    // 같은 값이 아니라 같은 것이어야 한다.
    assert.equal(format.schema, CANDIDATE_GENERATION_STRUCTURED_OUTPUT_SCHEMA);
  });

  it('남기지 않고, 나눠 받지 않고, 맡겨 두지 않는다', () => {
    assert.equal(spec.body.store, config.store);
    assert.equal(spec.body.stream, config.stream);
    assert.equal(spec.body.background, config.background);
    assert.equal(spec.body.store, false);
  });

  it('앞부분을 버리지 않고 처리 방식을 맡기지 않는다', () => {
    assert.equal(spec.body.truncation, config.truncation);
    assert.equal(spec.body.service_tier, config.serviceTier);
  });

  it('도구를 주지 않는다', () => {
    assert.deepEqual(spec.body.tools, []);
    assert.equal(config.toolsAllowed, false);
  });

  it('기다리는 시간은 본문 밖에 둔다', () => {
    // 보낼 내용이 아니라 부르는 쪽의 사정이다.
    assert.equal(spec.timeoutMs, config.timeoutMs);
    assert.equal('timeout' in spec.body, false);
    assert.equal('timeoutMs' in spec.body, false);
  });

  it('표본 설정을 넣지 않는다', () => {
    for (const field of ['temperature', 'top_p', 'topP', 'seed']) {
      assert.equal(field in spec.body, false, field);
    }
  });

  it('넣지 않기로 한 것들이 없다', () => {
    for (const field of [
      'previous_response_id',
      'conversation',
      'include',
      'metadata',
      'user',
      'safety_identifier',
      'tool_choice',
      'parallel_tool_calls',
      'prompt',
    ]) {
      assert.equal(field in spec.body, false, field);
    }
  });

  it('같은 프롬프트면 같은 것이 나온다', () => {
    assert.deepEqual(
      buildCandidateGenerationOpenAIRequestSpec(PROMPT),
      buildCandidateGenerationOpenAIRequestSpec(PROMPT),
    );
  });

  it('받은 프롬프트를 고치지 않는다', () => {
    const prompt = buildCandidateGenerationPrompt(INPUT);
    const before = JSON.stringify(prompt);
    buildCandidateGenerationOpenAIRequestSpec(prompt);
    assert.equal(JSON.stringify(prompt), before);
  });
});

/* ================================================================== */
/* B. 담는 자리 설명                                                    */
/* ================================================================== */

describe('제공자 연결 · B. 담는 자리', () => {
  const spec = buildCandidateGenerationOpenAIRequestSpec(PROMPT);

  it('프롬프트를 고치지 않는다', () => {
    assert.equal(PROMPT_ENVELOPE_RESOLUTION.canonicalPromptModified, false);
    assert.equal(PROMPT_ENVELOPE_RESOLUTION.providerSuffixAppendedAtAdapter, true);
  });

  it('보낼 때만 뒤에 덧붙인다', () => {
    assert.ok((spec.body.instructions as string).startsWith(PROMPT.systemPrompt));
    assert.ok((spec.body.instructions as string).includes(PROVIDER_SERIALIZATION_INSTRUCTION));
  });

  it('사용자 쪽 글은 그대로 보낸다', () => {
    assert.equal(spec.body.input, PROMPT.userPrompt);
  });

  it('담는 자리 이름을 이미 정한 곳에서 가져온다', () => {
    assert.ok(PROVIDER_SERIALIZATION_INSTRUCTION.includes(`"${ENVELOPE}"`));
    assert.equal(ADAPTER_SOURCE.includes("'response'"), false);
    assert.equal(PROMPT_ENVELOPE_RESOLUTION.envelopeKeyAuthority, 'structured_output_schema');
  });

  it('덧붙이는 말에 항목 이름을 다시 적지 않는다', () => {
    for (const field of MODEL_DRAFT_FIELDS) {
      assert.equal(PROVIDER_SERIALIZATION_INSTRUCTION.includes(field), false, field);
    }
    assert.equal(PROMPT_ENVELOPE_RESOLUTION.semanticFieldsRestatedInSuffix, false);
  });

  it('덧붙이는 말에 낱말을 다시 적지 않는다', () => {
    for (const reason of GENERATION_DEFER_REASONS) {
      assert.equal(PROVIDER_SERIALIZATION_INSTRUCTION.includes(reason), false, reason);
    }
  });

  it('덧붙이는 말이 연구 데이터에서 만들어지지 않는다', () => {
    // 우리가 쓴 글이다. 받은 값에 따라 달라지지 않는다.
    const other = buildCandidateModelGenerationInput(
      researchResult(),
    ) as CandidateModelGenerationInput;
    const otherSpec = buildCandidateGenerationOpenAIRequestSpec(buildCandidateGenerationPrompt(other));

    assert.ok((otherSpec.body.instructions as string).includes(PROVIDER_SERIALIZATION_INSTRUCTION));
    assert.equal(PROVIDER_SERIALIZATION_INSTRUCTION.includes('생계'), false);
  });

  it('어긋남이 이 자리에서 풀렸다고 기록했다', () => {
    assert.equal(PROMPT_ENVELOPE_RESOLUTION.status, 'RESOLVED_AT_PROVIDER_ADAPTER_BOUNDARY');
  });
});

/* ================================================================== */
/* C. 받은 것 — 진행 상태                                               */
/* ================================================================== */

describe('제공자 연결 · C. 진행 상태', () => {
  it('끝났으면 글을 읽는 길로 간다', () => {
    assert.equal(read(providerResponse()).outcome, 'validated_generate');
  });

  it('오다 말았으면 그렇게 끝낸다', () => {
    assert.equal(read(providerResponse({ status: 'incomplete' })).outcome, 'response_incomplete');
  });

  it('끝난 것이 아니면 모두 문제로 본다', () => {
    for (const status of ['failed', 'cancelled', 'queued', 'in_progress', 'unknown', '']) {
      assert.equal(read(providerResponse({ status })).outcome, 'provider_error', status);
    }
  });

  it('진행 상태가 없어도 문제로 본다', () => {
    const response = providerResponse() as Record<string, unknown>;
    delete response.status;
    assert.equal(read(response).outcome, 'provider_error');
  });

  it('기다렸다가 다시 보지 않는다', () => {
    // 나눠 받지도 맡겨 두지도 않기로 했으므로 다시 물어볼 일이 없다.
    assert.equal(config.stream, false);
    assert.equal(config.background, false);
    assert.equal(read(providerResponse({ status: 'queued' })).outcome, 'provider_error');
  });

  it('받은 것이 객체가 아니면 문제로 본다', () => {
    for (const bad of [null, undefined, 'x', 3, []]) {
      assert.equal(read(bad).outcome, 'provider_error', String(bad));
    }
  });
});

/* ================================================================== */
/* D. 오류가 먼저다                                                     */
/* ================================================================== */

describe('제공자 연결 · D. 오류 우선', () => {
  it('끝났다고 해도 오류가 있으면 문제로 본다', () => {
    const response = providerResponse({ error: { message: '무언가 잘못됨' } });
    assert.equal(read(response).outcome, 'provider_error');
  });

  it('오다 말았다고 적혀 있어도 오류가 있으면 문제로 본다', () => {
    // 앞뒤가 맞지 않는 답을 정상적인 중단으로 축소하지 않는다.
    const response = providerResponse({ status: 'incomplete', error: { message: 'x' } });
    assert.equal(read(response).outcome, 'provider_error');
  });

  it('실패했고 오류도 있으면 문제로 본다', () => {
    assert.equal(
      read(providerResponse({ status: 'failed', error: { message: 'x' } })).outcome,
      'provider_error',
    );
  });

  it('오류 문구를 결과에 담지 않는다', () => {
    const marker = 'PROVIDER_ERROR_MARKER_0001';
    const outcome = read(providerResponse({ error: { message: marker } }));

    assert.equal(JSON.stringify(outcome).includes(marker), false);
    assert.deepEqual(Object.keys(outcome), ['outcome']);
  });

  it('오류를 못 쓰겠다는 판단으로 바꾸지 않는다', () => {
    const outcome = read(providerResponse({ error: { message: 'x' } }));
    assert.notEqual(outcome.outcome, 'validated_defer');
    assert.equal(JSON.stringify(outcome).includes(GENERATION_DEFER_REASONS[0] as string), false);
  });
});

/* ================================================================== */
/* E. 거절                                                              */
/* ================================================================== */

describe('제공자 연결 · E. 거절', () => {
  const refusalItem = { type: 'message', content: [{ type: 'refusal', refusal: '답할 수 없습니다' }] };

  it('거절이 있으면 거절로 끝낸다', () => {
    assert.equal(read(providerResponse({ output: [refusalItem] })).outcome, 'model_refusal');
  });

  it('첫 항목이 아니어도 찾는다', () => {
    const output = [
      { type: 'reasoning', summary: [] },
      { type: 'message', content: [{ type: 'output_text', text: 'x' }] },
      refusalItem,
    ];
    assert.equal(read(providerResponse({ output })).outcome, 'model_refusal');
  });

  it('한 항목 안에서 첫 조각이 아니어도 찾는다', () => {
    const output = [
      { type: 'message', content: [{ type: 'output_text', text: 'x' }, { type: 'refusal', refusal: 'n' }] },
    ];
    assert.equal(read(providerResponse({ output })).outcome, 'model_refusal');
  });

  it('글이 함께 와 있어도 거절이 먼저다', () => {
    // 반쯤 온 글을 살려 쓰지 않는다.
    const response = providerResponse({
      output: [refusalItem],
      output_text: envelopeText({ decision: 'generate', draft: draft() }),
    });
    assert.equal(read(response).outcome, 'model_refusal');
  });

  it('거절하며 적은 말을 담지 않는다', () => {
    const marker = 'REFUSAL_MARKER_0001';
    const output = [{ type: 'message', content: [{ type: 'refusal', refusal: marker }] }];
    const outcome = read(providerResponse({ output }));

    assert.equal(JSON.stringify(outcome).includes(marker), false);
    assert.deepEqual(Object.keys(outcome), ['outcome']);
  });

  it('거절을 못 쓰겠다는 판단으로 바꾸지 않는다', () => {
    const outcome = read(providerResponse({ output: [refusalItem] }));
    assert.notEqual(outcome.outcome, 'validated_defer');
    assert.equal(JSON.stringify(outcome).includes(GENERATION_DEFER_REASONS[0] as string), false);
  });

  it('조립으로 넘어가지 않는다', () => {
    assert.equal(canInvokeCandidateBuilder(read(providerResponse({ output: [refusalItem] }))), false);
  });
});

/* ================================================================== */
/* F. 답의 글                                                           */
/* ================================================================== */

describe('제공자 연결 · F. 답의 글', () => {
  it('아무 글도 오지 않으면 비어 있는 것이다', () => {
    for (const text of [undefined, null, '', '   ', '\n']) {
      const response = providerResponse() as Record<string, unknown>;
      if (text === undefined) delete response.output_text;
      else response.output_text = text;
      assert.equal(read(response).outcome, 'empty_response', JSON.stringify(text));
    }
  });

  it('글이 와야 할 자리에 다른 것이 오면 문제로 본다', () => {
    for (const bad of [3, {}, [], true]) {
      assert.equal(
        read(providerResponse({ output_text: bad })).outcome,
        'provider_error',
        JSON.stringify(bad),
      );
    }
  });

  it('온 것들 중에서 우리가 골라 쓰지 않는다', () => {
    // 제공자가 모아 준 글만 쓴다. output 안을 뒤져 다른 것을 쓰지 않는다.
    const response = providerResponse({
      output: [{ type: 'message', content: [{ type: 'output_text', text: '{"decision":"defer"}' }] }],
      output_text: envelopeText({ decision: 'defer', reason: 'needs_more_research' }),
    });
    assert.equal(read(response).outcome, 'validated_defer');
  });

  it('생각한 흔적을 글로 쓰지 않는다', () => {
    const response = providerResponse({
      output: [
        { type: 'reasoning', summary: [{ type: 'summary_text', text: '이렇게 골랐습니다' }] },
        { type: 'message', content: [{ type: 'output_text', text: 'x' }] },
      ],
    });
    const outcome = read(response);

    assert.equal(outcome.outcome, 'validated_generate');
    assert.equal(JSON.stringify(outcome).includes('이렇게 골랐습니다'), false);
  });
});

/* ================================================================== */
/* G. 담는 자리 벗기기                                                  */
/* ================================================================== */

describe('제공자 연결 · G. 벗기기', () => {
  it('망가진 JSON은 읽기 실패다', () => {
    for (const bad of ['{', '{"a":', 'not json']) {
      assert.equal(read(providerResponse({ output_text: bad })).outcome, 'json_parse_failed', bad);
    }
  });

  it('코드 블록이나 앞뒤 설명을 잘라 주지 않는다', () => {
    const inner = envelopeText({ decision: 'defer', reason: 'needs_more_research' });
    const cases = [
      ['```json', inner, '```'].join('\n'),
      `여기 결과입니다:\n${inner}`,
      `${inner}\n완료했습니다.`,
      `${inner}\n${inner}`,
    ];
    for (const text of cases) {
      assert.equal(read(providerResponse({ output_text: text })).outcome, 'json_parse_failed');
    }
  });

  it('담는 자리가 약속과 다르면 계약 위반이다', () => {
    const inner = { decision: 'defer', reason: 'needs_more_research' };
    const cases: Array<[string, unknown]> = [
      ['목록', [inner]],
      ['값 하나', 3],
      ['담는 자리 없음', { payload: inner }],
      ['다른 이름', { data: inner }],
      ['함께 온 것이 있음', { [ENVELOPE]: inner, note: 'x' }],
      ['빈 객체', {}],
    ];

    for (const [name, value] of cases) {
      const outcome = read(providerResponse({ output_text: JSON.stringify(value) }));
      assert.equal(outcome.outcome, 'response_contract_invalid', name);
    }
  });

  it('읽기 실패와 계약 위반을 구분한다', () => {
    assert.equal(read(providerResponse({ output_text: '{' })).outcome, 'json_parse_failed');
    assert.equal(read(providerResponse({ output_text: '[]' })).outcome, 'response_contract_invalid');
  });

  it('담는 자리 문제를 못 쓰겠다는 판단으로 바꾸지 않는다', () => {
    const outcome = read(providerResponse({ output_text: JSON.stringify({ other: 1 }) }));
    assert.notEqual(outcome.outcome, 'validated_defer');
  });

  it('같은 글을 두 번 읽지 않는다', () => {
    // 벗긴 뒤에는 글자가 아니라 값으로 넘긴다.
    assert.equal((ADAPTER_SOURCE.match(/JSON\.parse/g) ?? []).length, 1);
  });
});

/* ================================================================== */
/* H. 벗긴 뒤에는 이미 있는 검사기가 본다                               */
/* ================================================================== */

describe('제공자 연결 · H. 검사기', () => {
  it('제대로 된 초안이면 통과한다', () => {
    const outcome = read(providerResponse());
    assert.equal(outcome.outcome, 'validated_generate');
    assert.ok(outcome.outcome === 'validated_generate' && outcome.response.decision === 'generate');
  });

  it('못 쓰겠다는 대답도 통과한다', () => {
    const response = providerResponse({
      output_text: envelopeText({ decision: 'defer', reason: 'needs_more_research' }),
    });
    const outcome = read(response);

    assert.equal(outcome.outcome, 'validated_defer');
    assert.equal(canInvokeCandidateBuilder(outcome), false);
  });

  it('모양은 맞는데 뜻이 어긋나면 막는다', () => {
    // 본문 후보가 하나뿐이라 5번은 없는 번호다.
    // 담는 자리도 JSON도 정상이지만 검사기가 막는다.
    const response = providerResponse({
      output_text: envelopeText({ decision: 'generate', draft: draft({ selectedPassageIndex: 5 }) }),
    });
    assert.equal(read(response).outcome, 'response_contract_invalid');
  });

  it('모델이 정할 수 없는 항목을 실어 오면 막는다', () => {
    const response = providerResponse({
      output_text: envelopeText({
        decision: 'generate',
        draft: draft({ referenceLabel: '창세기 1:1' }),
      }),
    });
    assert.equal(read(response).outcome, 'response_contract_invalid');
  });

  it('검사기를 우회하지 않는다', () => {
    assert.ok(ADAPTER_SOURCE.includes('interpretCandidateGenerationTransportPayload'));
  });

  it('통과했다고 조립까지 끝난 것은 아니다', () => {
    const outcome = read(providerResponse());
    assert.equal(canInvokeCandidateBuilder(outcome), true);
    // 조립은 여기서 하지 않는다.
    assert.equal(ADAPTER_SOURCE.includes('buildPublishedContentCandidate'), false);
  });
});

/* ================================================================== */
/* I. 부르지 못했을 때                                                  */
/* ================================================================== */

describe('제공자 연결 · I. 부르기 실패', () => {
  it('세 가지를 우리 상태로 옮긴다', () => {
    assert.deepEqual([...PROVIDER_CALL_FAILURE_KINDS], ['timeout', 'unavailable', 'other']);
    assert.equal(mapCandidateGenerationProviderCallFailure('timeout').outcome, 'provider_timeout');
    assert.equal(mapCandidateGenerationProviderCallFailure('unavailable').outcome, 'provider_unavailable');
    assert.equal(mapCandidateGenerationProviderCallFailure('other').outcome, 'provider_error');
  });

  it('오류 객체를 들여다보지 않는다', () => {
    for (const banned of ['instanceof Error', 'error.message', 'statusCode', 'err.name']) {
      assert.equal(ADAPTER_SOURCE.includes(banned), false, banned);
    }
  });

  it('부르기 실패를 못 쓰겠다는 판단으로 바꾸지 않는다', () => {
    for (const kind of PROVIDER_CALL_FAILURE_KINDS) {
      const outcome = mapCandidateGenerationProviderCallFailure(kind);
      assert.notEqual(outcome.outcome, 'validated_defer');
      assert.deepEqual(Object.keys(outcome), ['outcome']);
    }
  });
});

/* ================================================================== */
/* J. 상태를 늘리지 않는다                                              */
/* ================================================================== */

describe('제공자 연결 · J. 상태', () => {
  it('끝나는 상태가 이미 있는 열 가지뿐이다', () => {
    const refusalItem = { type: 'message', content: [{ type: 'refusal', refusal: 'n' }] };
    const observed = [
      read(providerResponse()).outcome,
      read(providerResponse({ output_text: envelopeText({ decision: 'defer', reason: 'needs_more_research' }) })).outcome,
      read(providerResponse({ output_text: '' })).outcome,
      read(providerResponse({ output_text: '{' })).outcome,
      read(providerResponse({ output_text: '[]' })).outcome,
      mapCandidateGenerationProviderCallFailure('timeout').outcome,
      mapCandidateGenerationProviderCallFailure('unavailable').outcome,
      read(providerResponse({ status: 'failed' })).outcome,
      read(providerResponse({ output: [refusalItem] })).outcome,
      read(providerResponse({ status: 'incomplete' })).outcome,
    ];

    assert.equal(new Set(observed).size, 10);
    assert.deepEqual([...observed].sort(), [...TRANSPORT_OUTCOMES].sort());
  });

  it('새 상태를 만들지 않았다', () => {
    for (const banned of ['adapter_', 'openai_error', 'sdk_', 'candidate_success']) {
      assert.equal(ADAPTER_SOURCE.includes(`'${banned}`), false, banned);
    }
  });

  it('읽는 순서를 적어 두었다', () => {
    assert.ok(RESPONSE_INTERPRETATION_ORDER.length >= 8);
    const text = RESPONSE_INTERPRETATION_ORDER.join(' ');
    assert.ok(text.includes('오류가 담겨 있으면 상태를 보기 전에'));
    assert.ok(text.includes('거절이 섞여 있는지 먼저'));
  });
});

/* ================================================================== */
/* K. 남기지 않고 다시 부르지 않는다                                    */
/* ================================================================== */

describe('제공자 연결 · K. 남기지 않기', () => {
  it('원문도 거절 문구도 오류 문구도 남기지 않는다', () => {
    for (const [name, value] of Object.entries(ADAPTER_PERSISTENCE_POLICY)) {
      assert.equal(value, false, name);
    }
  });

  it('다시 부르지 않고 갈아타지 않고 고치지 않는다', () => {
    assert.equal(ADAPTER_RETRY_POLICY.automaticRetries, 0);
    assert.equal(ADAPTER_RETRY_POLICY.fallbackModelAllowed, false);
    assert.equal(ADAPTER_RETRY_POLICY.automaticJsonRepair, false);
    assert.equal(ADAPTER_RETRY_POLICY.outputBudgetRaisedOnIncomplete, false);
  });

  it('그 값을 정해 둔 곳에서 가져온다', () => {
    assert.equal(ADAPTER_RETRY_POLICY.automaticRetries, config.automaticRetries);
    assert.equal(ADAPTER_RETRY_POLICY.fallbackModelAllowed, config.fallbackModelAllowed);
    assert.equal(ADAPTER_RETRY_POLICY.automaticJsonRepair, config.automaticJsonRepair);
  });

  it('여기서 하지 않는 일을 적어 두었다', () => {
    assert.ok(ADAPTER_DOES_NOT_INCLUDE.length >= 5);
    const text = ADAPTER_DOES_NOT_INCLUDE.join(' ');
    assert.ok(text.includes('열쇠'));
    assert.ok(text.includes('기다리는 시간'));
  });
});

/* ================================================================== */
/* L. 값을 새로 정하지 않는다                                           */
/* ================================================================== */

describe('제공자 연결 · L. 권위', () => {
  it('정해 둔 값을 여기 다시 적지 않았다', () => {
    for (const literal of [
      'gpt-5.6-sol',
      "'medium'",
      '60_000',
      '60000',
      '8_192',
      '8192',
      'json_schema',
      'aroeda_candidate_generation_v1',
      "'disabled'",
      "'default'",
    ]) {
      assert.equal(ADAPTER_SOURCE.includes(literal), false, literal);
    }
  });

  it('모양을 여기서 다시 만들지 않았다', () => {
    for (const banned of ['additionalProperties', 'properties:', 'anyOf', 'required:']) {
      assert.equal(ADAPTER_SOURCE.includes(banned), false, banned);
    }
  });

  it('항목 이름과 낱말을 여기 다시 적지 않았다', () => {
    for (const field of MODEL_DRAFT_FIELDS) {
      assert.equal(ADAPTER_SOURCE.includes(`'${field}'`), false, field);
    }
    for (const reason of GENERATION_DEFER_REASONS) {
      assert.equal(ADAPTER_SOURCE.includes(`'${reason}'`), false, reason);
    }
  });

  it('정해 둔 곳에서 가져온다', () => {
    for (const name of [
      'CANDIDATE_GENERATION_RUNTIME_CONFIG',
      'CANDIDATE_GENERATION_STRUCTURED_OUTPUT_SCHEMA',
      'CANDIDATE_GENERATION_STRUCTURED_OUTPUT_ENVELOPE_KEY',
      'interpretCandidateGenerationTransportPayload',
      'createCandidateGenerationTransportFailure',
      'createCandidateGenerationModelResponseOutcome',
    ]) {
      assert.ok(ADAPTER_SOURCE.includes(name), name);
    }
  });

  it('가져오는 곳이 모두 같은 저장소의 계약이다', () => {
    const specifiers = [...ADAPTER_SOURCE.matchAll(/from '([^']+)'/g)].map((m) => m[1] as string);
    assert.ok(specifiers.length > 0);
    for (const path of specifiers) {
      assert.ok(path.startsWith('./'), path);
    }
  });
});

/* ================================================================== */
/* M. 이 파일이 하지 않는 일                                            */
/* ================================================================== */

describe('제공자 연결 · M. 경계', () => {
  it('제공자 라이브러리를 쓰지 않는다', () => {
    for (const banned of [
      'import OpenAI',
      'new OpenAI',
      "from 'openai'",
      'from "openai"',
      'responses.create',
      'responses.parse',
      'chat.completions',
      'zodTextFormat',
      'zodResponseFormat',
    ]) {
      assert.equal(ADAPTER_SOURCE.includes(banned), false, banned);
    }
  });

  it('부르지 않고 열쇠도 읽지 않는다', () => {
    for (const banned of [
      'fetch(',
      'api.openai.com',
      'Authorization',
      'OPENAI_API_KEY',
      'apiKey',
      'Deno.env',
      'process.env',
    ]) {
      assert.equal(ADAPTER_SOURCE.includes(banned), false, banned);
    }
  });

  it('시간을 실제로 재지 않는다', () => {
    for (const banned of ['setTimeout', 'AbortController', 'AbortSignal', 'clearTimeout']) {
      assert.equal(ADAPTER_SOURCE.includes(banned), false, banned);
    }
  });

  it('표를 열지 않는다', () => {
    for (const banned of ['createClient', 'supabase', 'service_role', 'store_published_content']) {
      assert.equal(ADAPTER_SOURCE.includes(banned), false, banned);
    }
  });

  it('부를 때마다 같은 답을 낸다', () => {
    for (const banned of ['Date.now', 'Math.random', 'randomUUID', 'new Date(']) {
      assert.equal(ADAPTER_SOURCE.includes(banned), false, banned);
    }
    assert.deepEqual(read(providerResponse()), read(providerResponse()));
  });

  it('받은 값을 고치지 않는다', () => {
    const response = providerResponse();
    const before = JSON.stringify(response);
    const inputBefore = JSON.stringify(INPUT);

    read(response);

    assert.equal(JSON.stringify(response), before);
    assert.equal(JSON.stringify(INPUT), inputBefore);
  });
});
