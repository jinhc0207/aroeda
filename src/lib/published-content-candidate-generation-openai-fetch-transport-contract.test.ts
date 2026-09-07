/**
 * 실제로 요청을 보내는 자리의 약속 · 테스트
 *
 * 실행: npm test
 *
 * 지키려는 것 일곱 가지.
 *
 *   1. HTTP로 받은 답에는 글 담는 자리가 없다. 그것을 채워야 한다.
 *   2. 채우는 값은 이미 있는 함수에서만 나온다. 훑는 방법을 여기서 다시 쓰지 않는다.
 *   3. 채웠다고 알맹이를 걷어내지 않는다. 거절은 여전히 어댑터가 찾아야 한다.
 *   4. 받은 것을 고치지 않는다.
 *   5. 이미 붙어 있는 편의 값을 믿지 않는다.
 *   6. 어디서 실패했는지에 따라 뜻이 다르고, 최종 판단은 이미 있는 곳이 한다.
 *   7. 실제로 보내지 않는다. 시간을 재지 않는다. 열쇠를 읽지 않는다.
 *
 * 부르지 않는다. 받았다고 치는 값을 손으로 만들어 넣는다.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  ADAPTER_INPUT_FIELDS,
  AUTHORITY_MAP,
  BODY_READ_FAILURE_IS_NOT_MODEL_JSON_FAILURE,
  CREDENTIAL_POLICY,
  DERIVED_OUTPUT_TEXT_AUTHORITY,
  DERIVED_OUTPUT_TEXT_FIELD,
  FETCH_ATTEMPTS,
  FETCH_FAILURE_STAGES,
  FETCH_TRANSPORT_DOES_NOT_INCLUDE,
  FETCH_TRANSPORT_LIFECYCLE,
  FETCH_TRANSPORT_LOGGING_POLICY,
  FETCH_TRANSPORT_PERSISTENCE_POLICY,
  HTTP_FAILURE_POLICY,
  NORMALIZATION_DOES_NOT_DECIDE,
  PROVIDER_PROTOCOL,
  RAW_CONVENIENCE_FIELD_TRUSTED,
  RAW_STRUCTURE_PRESERVED,
  REQUEST_SPEC_POLICY,
  TIMED_OUT_FLAG_POLICY,
  TIMEOUT_LIFECYCLE_POLICY,
  classifyCandidateGenerationFetchFailure,
  normalizeCandidateGenerationOpenAIHttpResponseForAdapter,
  observeCandidateGenerationFetchFailure,
} from '../../supabase/functions/_shared/published-content-candidate-generation-openai-fetch-transport-contract.ts';
import { extractOutputText } from '../../supabase/functions/_shared/openai-response.ts';
import {
  OPENAI_REQUEST_BODY_FIELDS,
  interpretCandidateGenerationOpenAIResponse,
} from '../../supabase/functions/_shared/published-content-candidate-generation-openai-adapter-contract.ts';
import {
  CANDIDATE_GENERATION_OPENAI_CREDENTIAL_ENV_NAME,
  RUNTIME_BOUNDARY_LOGGING_POLICY,
  RUNTIME_BOUNDARY_RETRY_POLICY,
  RUNTIME_BOUNDARY_TIMEOUT_POLICY,
  classifyCandidateGenerationProviderFailure,
} from '../../supabase/functions/_shared/published-content-candidate-generation-openai-runtime-boundary.ts';
import { CANDIDATE_GENERATION_RUNTIME_CONFIG } from '../../supabase/functions/_shared/published-content-candidate-generation-runtime-config.ts';
import { CANDIDATE_GENERATION_STRUCTURED_OUTPUT_ENVELOPE_KEY } from '../../supabase/functions/_shared/published-content-candidate-generation-structured-output-schema.ts';
import {
  buildCandidateModelGenerationInput,
  type CandidateModelGenerationInput,
} from '../../supabase/functions/_shared/published-content-candidate-generation-contract.ts';

const TRANSPORT_PATH =
  '../../supabase/functions/_shared/published-content-candidate-generation-openai-fetch-transport-contract.ts';
const TRANSPORT_SOURCE = readFileSync(new URL(TRANSPORT_PATH, import.meta.url), 'utf8');

const ENVELOPE = CANDIDATE_GENERATION_STRUCTURED_OUTPUT_ENVELOPE_KEY;

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

const draft = () => ({
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
});

const envelopeText = (inner: unknown) => JSON.stringify({ [ENVELOPE]: inner });

const GENERATE_TEXT = envelopeText({ decision: 'generate', draft: draft() });
const DEFER_TEXT = envelopeText({ decision: 'defer', reason: 'needs_more_research' });

const messageItem = (...texts: string[]) => ({
  type: 'message',
  role: 'assistant',
  content: texts.map((text) => ({ type: 'output_text', text })),
});

const reasoningItem = (text: string) => ({
  type: 'reasoning',
  content: [{ type: 'reasoning_text', text }],
});

const refusalItem = (text: string) => ({
  type: 'message',
  role: 'assistant',
  content: [{ type: 'refusal', refusal: text }],
});

/**
 * HTTP로 직접 받았을 때의 답.
 *
 * 맨 위에 output_text가 **없다**. 그 자리는 라이브러리가 붙여 주는 것이고
 * 우리는 라이브러리를 쓰지 않기 때문이다.
 */
const rawHttpResponse = (over: Record<string, unknown> = {}) => ({
  id: 'resp_x',
  object: 'response',
  status: 'completed',
  error: null,
  output: [messageItem(GENERATE_TEXT)],
  ...over,
});

const through = (raw: unknown) =>
  interpretCandidateGenerationOpenAIResponse(
    normalizeCandidateGenerationOpenAIHttpResponseForAdapter(raw),
    INPUT,
  );

const outcomeOf = (raw: unknown) => through(raw).outcome;

/* ================================================================== */
/* 1. 이미 있는 함수를 그대로 쓴다                                       */
/* ================================================================== */

describe('글을 모으는 규칙은 이미 있는 것을 쓴다', () => {
  it('그 함수를 가져다 쓴다', () => {
    assert.ok(TRANSPORT_SOURCE.includes("import { extractOutputText } from './openai-response.ts';"));
    assert.ok(TRANSPORT_SOURCE.includes('extractOutputText(raw)'));
    assert.equal(DERIVED_OUTPUT_TEXT_AUTHORITY, 'extractOutputText');
  });

  it('답을 훑는 방법을 여기서 다시 쓰지 않았다', () => {
    for (const banned of [
      'output[0]',
      'content[0]',
      '.join(',
      "=== 'output_text'",
      'Array.isArray(output)',
      'Array.isArray(content)',
      'part.text',
      'item.content',
    ]) {
      assert.equal(TRANSPORT_SOURCE.includes(banned), false, banned);
    }
  });

  it('반복문이 하나도 없다', () => {
    for (const banned of ['for (', 'while (', '.map(', '.filter(', '.reduce(']) {
      assert.equal(TRANSPORT_SOURCE.includes(banned), false, banned);
    }
  });

  it('채워 넣는 자리 이름이 어댑터가 읽는 이름과 같다', () => {
    assert.equal(DERIVED_OUTPUT_TEXT_FIELD, 'output_text');
    assert.ok((ADAPTER_INPUT_FIELDS as readonly string[]).includes(DERIVED_OUTPUT_TEXT_FIELD));
  });

  it('어댑터가 읽는 자리는 넷이다', () => {
    assert.deepEqual([...ADAPTER_INPUT_FIELDS], ['status', 'error', 'output', 'output_text']);
  });
});

/* ================================================================== */
/* 2. 글 담는 자리를 채운다                                             */
/* ================================================================== */

describe('글 담는 자리를 채운다', () => {
  it('HTTP로 받은 답에는 그 자리가 없다', () => {
    // 이 파일이 존재하는 이유다. 없다는 것부터 못 박아 둔다.
    assert.equal('output_text' in rawHttpResponse(), false);
  });

  it('채우고 나면 어댑터가 읽을 수 있다', () => {
    const normalized = normalizeCandidateGenerationOpenAIHttpResponseForAdapter(rawHttpResponse());
    assert.equal((normalized as Record<string, unknown>).output_text, GENERATE_TEXT);
  });

  it('채운 값은 이미 있는 함수가 낸 값과 같다', () => {
    const raw = rawHttpResponse();
    const normalized = normalizeCandidateGenerationOpenAIHttpResponseForAdapter(raw);
    assert.equal((normalized as Record<string, unknown>).output_text, extractOutputText(raw));
  });

  it('채울 것이 없으면 없다고 둔다', () => {
    const raw = rawHttpResponse({ output: [reasoningItem('속으로 생각한 것')] });
    const normalized = normalizeCandidateGenerationOpenAIHttpResponseForAdapter(raw);
    assert.equal((normalized as Record<string, unknown>).output_text, null);
  });

  it('빈 글을 지어내지 않는다', () => {
    const raw = rawHttpResponse({ output: [] });
    const normalized = normalizeCandidateGenerationOpenAIHttpResponseForAdapter(raw);
    assert.notEqual((normalized as Record<string, unknown>).output_text, '');
    assert.notEqual((normalized as Record<string, unknown>).output_text, '{}');
  });
});

/* ================================================================== */
/* 3. 알맹이를 그대로 둔다                                              */
/* ================================================================== */

describe('받은 것을 그대로 둔다', () => {
  it('상태·오류·알맹이가 그대로 넘어간다', () => {
    const raw = rawHttpResponse({ status: 'completed', error: null });
    const normalized = normalizeCandidateGenerationOpenAIHttpResponseForAdapter(raw) as Record<
      string,
      unknown
    >;

    assert.equal(normalized.status, 'completed');
    assert.equal(normalized.error, null);
    assert.deepEqual(normalized.output, raw.output);
    assert.equal(RAW_STRUCTURE_PRESERVED, true);
  });

  it('알맹이를 걷어내지 않는다', () => {
    const raw = rawHttpResponse({ output: [refusalItem('답할 수 없습니다'), messageItem(GENERATE_TEXT)] });
    const normalized = normalizeCandidateGenerationOpenAIHttpResponseForAdapter(raw) as Record<
      string,
      unknown
    >;

    // 거절을 찾는 일은 어댑터의 몫이다. 여기서 지우면 그 일이 통째로 사라진다.
    assert.equal(JSON.stringify(normalized.output).includes('refusal'), true);
  });

  it('받은 것을 고치지 않는다', () => {
    const raw = rawHttpResponse();
    const before = JSON.parse(JSON.stringify(raw));

    normalizeCandidateGenerationOpenAIHttpResponseForAdapter(raw);

    assert.deepEqual(raw, before);
    assert.equal('output_text' in raw, false);
  });

  it('돌려준 것은 새것이다', () => {
    const raw = rawHttpResponse();
    const normalized = normalizeCandidateGenerationOpenAIHttpResponseForAdapter(raw);
    assert.notEqual(normalized, raw);
  });

  it('얼려 둔 것을 넣어도 잘 돌아간다', () => {
    const raw = Object.freeze(rawHttpResponse());
    // 받은 것에 직접 써 넣는 방식이면 여기서 터진다.
    const normalized = normalizeCandidateGenerationOpenAIHttpResponseForAdapter(raw);
    assert.equal((normalized as Record<string, unknown>).output_text, GENERATE_TEXT);
  });

  it('같은 것을 넣으면 같은 것이 나온다', () => {
    const raw = rawHttpResponse();
    assert.deepEqual(
      normalizeCandidateGenerationOpenAIHttpResponseForAdapter(raw),
      normalizeCandidateGenerationOpenAIHttpResponseForAdapter(raw),
    );
  });
});

/* ================================================================== */
/* 4. 이미 붙어 있는 값을 믿지 않는다                                    */
/* ================================================================== */

describe('이미 붙어 있는 편의 값', () => {
  it('믿지 않기로 했다', () => {
    assert.equal(RAW_CONVENIENCE_FIELD_TRUSTED, false);
  });

  it('붙어 있어도 알맹이에서 다시 구한다', () => {
    const raw = rawHttpResponse({ output_text: '엉뚱한 값' });
    const normalized = normalizeCandidateGenerationOpenAIHttpResponseForAdapter(raw) as Record<
      string,
      unknown
    >;

    assert.equal(normalized.output_text, GENERATE_TEXT);
    assert.notEqual(normalized.output_text, '엉뚱한 값');
  });

  it('붙어 있는 값이 오염돼 있어도 결과가 흔들리지 않는다', () => {
    const good = outcomeOf(rawHttpResponse());
    const polluted = outcomeOf(rawHttpResponse({ output_text: '{"response":{"decision":"defer"}}' }));

    assert.equal(good, 'validated_generate');
    assert.equal(polluted, 'validated_generate');
  });

  it('알맹이가 비었는데 편의 값만 있으면 비어 있는 것으로 본다', () => {
    // 있으면 되고 없으면 안 되는 길을 만들지 않는다.
    assert.equal(outcomeOf(rawHttpResponse({ output: [], output_text: GENERATE_TEXT })), 'empty_response');
  });
});

/* ================================================================== */
/* 5. 어댑터까지 이어 붙였을 때                                          */
/* ================================================================== */

describe('어댑터까지 이어 붙인다', () => {
  it('쓸 수 있다는 답이 통과한다', () => {
    const result = through(rawHttpResponse());
    assert.equal(result.outcome, 'validated_generate');
  });

  it('못 쓰겠다는 답도 통과한다', () => {
    const result = through(rawHttpResponse({ output: [messageItem(DEFER_TEXT)] }));
    assert.equal(result.outcome, 'validated_defer');
  });

  it('생각한 흔적이 앞에 있어도 통과한다', () => {
    assert.equal(
      outcomeOf(rawHttpResponse({ output: [reasoningItem('견주어 본 것'), messageItem(GENERATE_TEXT)] })),
      'validated_generate',
    );
  });

  it('생각한 흔적이 글에 섞이지 않는다', () => {
    const raw = rawHttpResponse({
      output: [reasoningItem('속으로 한 말'), messageItem(GENERATE_TEXT), reasoningItem('또 한 말')],
    });
    const normalized = normalizeCandidateGenerationOpenAIHttpResponseForAdapter(raw) as Record<
      string,
      unknown
    >;

    assert.equal(normalized.output_text, GENERATE_TEXT);
    assert.equal(String(normalized.output_text).includes('속으로 한 말'), false);
    assert.equal(String(normalized.output_text).includes('또 한 말'), false);
  });

  it('거절이 섞여 있으면 거절로 끝난다', () => {
    assert.equal(outcomeOf(rawHttpResponse({ output: [refusalItem('답할 수 없습니다')] })), 'model_refusal');
  });

  it('거절이 글보다 앞선다', () => {
    // 쓸 만한 글이 함께 와 있어도 거절이 먼저다.
    assert.equal(
      outcomeOf(rawHttpResponse({ output: [messageItem(GENERATE_TEXT), refusalItem('답할 수 없습니다')] })),
      'model_refusal',
    );
  });

  it('거절한 말이 글에 섞이지 않는다', () => {
    const raw = rawHttpResponse({ output: [refusalItem('이 요청에는 답하지 않겠습니다')] });
    const normalized = normalizeCandidateGenerationOpenAIHttpResponseForAdapter(raw) as Record<
      string,
      unknown
    >;

    assert.equal(normalized.output_text, null);
  });

  it('오다 만 답은 오다 만 것으로 끝난다', () => {
    assert.equal(outcomeOf(rawHttpResponse({ status: 'incomplete' })), 'response_incomplete');
  });

  it('오다 만 것을 끝난 것으로 바꾸지 않는다', () => {
    const raw = rawHttpResponse({ status: 'incomplete' });
    const normalized = normalizeCandidateGenerationOpenAIHttpResponseForAdapter(raw) as Record<
      string,
      unknown
    >;
    assert.equal(normalized.status, 'incomplete');
  });

  it('글이 하나도 없으면 받은 것이 없는 것이다', () => {
    assert.equal(outcomeOf(rawHttpResponse({ output: [] })), 'empty_response');
    assert.equal(outcomeOf(rawHttpResponse({ output: [reasoningItem('생각만 함')] })), 'empty_response');
  });

  it('오류가 담겨 있으면 상태보다 먼저 본다', () => {
    assert.equal(
      outcomeOf(rawHttpResponse({ status: 'incomplete', error: { code: 'x' } })),
      'provider_error',
    );
  });

  it('글이 여러 조각이면 이미 있는 함수가 정한 대로 이어 붙는다', () => {
    const half = GENERATE_TEXT.slice(0, 20);
    const rest = GENERATE_TEXT.slice(20);
    const raw = rawHttpResponse({ output: [messageItem(half, rest)] });

    const normalized = normalizeCandidateGenerationOpenAIHttpResponseForAdapter(raw) as Record<
      string,
      unknown
    >;

    assert.equal(normalized.output_text, extractOutputText(raw));
    assert.equal(outcomeOf(raw), 'validated_generate');
  });

  it('여러 덩어리에 나뉘어 있어도 이어 붙는다', () => {
    const half = DEFER_TEXT.slice(0, 15);
    const rest = DEFER_TEXT.slice(15);
    assert.equal(
      outcomeOf(rawHttpResponse({ output: [messageItem(half), messageItem(rest)] })),
      'validated_defer',
    );
  });

  it('약속을 어긴 글은 어긴 것으로 끝난다', () => {
    assert.equal(
      outcomeOf(rawHttpResponse({ output: [messageItem('{"decision":"generate"}')] })),
      'response_contract_invalid',
    );
  });

  it('읽을 수 없는 글은 읽지 못한 것으로 끝난다', () => {
    assert.equal(outcomeOf(rawHttpResponse({ output: [messageItem('{')] })), 'json_parse_failed');
  });
});

/* ================================================================== */
/* 6. 이상한 것이 왔을 때                                                */
/* ================================================================== */

describe('답 같지 않은 것이 왔을 때', () => {
  const BROKEN: unknown[] = [null, undefined, [], 'string', 123, true, false];

  it('억지로 답처럼 만들지 않는다', () => {
    for (const raw of BROKEN) {
      assert.equal(
        normalizeCandidateGenerationOpenAIHttpResponseForAdapter(raw),
        raw,
        String(raw),
      );
    }
  });

  it('끝은 제공자 쪽 문제다', () => {
    for (const raw of BROKEN) {
      assert.equal(outcomeOf(raw), 'provider_error', String(raw));
    }
  });

  it('조용히 축소하지 않는다', () => {
    for (const raw of BROKEN) {
      const outcome = outcomeOf(raw);
      assert.notEqual(outcome, 'validated_defer', String(raw));
      assert.notEqual(outcome, 'empty_response', String(raw));
    }
  });

  it('배열을 객체로 바꾸지 않는다', () => {
    const raw: unknown[] = [];
    assert.ok(Array.isArray(normalizeCandidateGenerationOpenAIHttpResponseForAdapter(raw)));
  });
});

/* ================================================================== */
/* 7. 판단은 여기서 하지 않는다                                          */
/* ================================================================== */

describe('손질하는 쪽은 판단하지 않는다', () => {
  it('무엇을 판단하지 않는지 적어 두었다', () => {
    assert.equal(NORMALIZATION_DOES_NOT_DECIDE.length, 3);
  });

  it('결과 이름을 만들지 않는다', () => {
    for (const banned of [
      'model_refusal',
      'response_incomplete',
      'empty_response',
      'json_parse_failed',
      'validated_generate',
      'validated_defer',
      'response_contract_invalid',
      'needs_more_research',
    ]) {
      assert.equal(TRANSPORT_SOURCE.includes(banned), false, banned);
    }
  });

  it('거절이나 상태를 들여다보지 않는다', () => {
    for (const banned of ['refusal', "'completed'", "'incomplete'", 'hasRefusal', 'JSON.parse']) {
      assert.equal(TRANSPORT_SOURCE.includes(banned), false, banned);
    }
  });

  it('어댑터를 건너뛰지 않는다', () => {
    // 검사기를 직접 부르면 어댑터의 순서(오류 → 상태 → 거절 → 글)가 통째로 빠진다.
    assert.equal(TRANSPORT_SOURCE.includes('interpretCandidateGenerationTransportPayload'), false);
    assert.equal(TRANSPORT_SOURCE.includes('validateCandidateModelGenerationResponse'), false);
    assert.equal(TRANSPORT_SOURCE.includes('buildPublishedContentCandidate'), false);
  });
});

/* ================================================================== */
/* 8. 실패했을 때 무엇으로 보는가                                        */
/* ================================================================== */

describe('실패한 자리를 옮긴다', () => {
  it('실패할 수 있는 자리는 셋이다', () => {
    assert.deepEqual([...FETCH_FAILURE_STAGES], ['fetch_rejected', 'http_not_ok', 'body_read_failed']);
  });

  it('보내다 실패했는데 우리가 끊었으면 시간 초과다', () => {
    assert.deepEqual(observeCandidateGenerationFetchFailure({ stage: 'fetch_rejected', timedOut: true }), {
      kind: 'timeout',
    });
    assert.equal(
      classifyCandidateGenerationFetchFailure({ stage: 'fetch_rejected', timedOut: true }).outcome,
      'provider_timeout',
    );
  });

  it('보내다 실패했는데 우리가 끊은 것이 아니면 닿지 못한 것이다', () => {
    assert.deepEqual(observeCandidateGenerationFetchFailure({ stage: 'fetch_rejected', timedOut: false }), {
      kind: 'connection',
    });
    assert.equal(
      classifyCandidateGenerationFetchFailure({ stage: 'fetch_rejected', timedOut: false }).outcome,
      'provider_unavailable',
    );
  });

  it('본문을 읽다 실패했는데 우리가 끊었으면 시간 초과다', () => {
    assert.equal(
      classifyCandidateGenerationFetchFailure({ stage: 'body_read_failed', timedOut: true }).outcome,
      'provider_timeout',
    );
  });

  it('본문을 읽다 실패했는데 우리가 끊은 것이 아니면 알 수 없는 것이다', () => {
    assert.deepEqual(observeCandidateGenerationFetchFailure({ stage: 'body_read_failed', timedOut: false }), {
      kind: 'unknown',
    });
    assert.equal(
      classifyCandidateGenerationFetchFailure({ stage: 'body_read_failed', timedOut: false }).outcome,
      'provider_error',
    );
  });

  it('본문을 읽다 실패한 것을 닿지 못한 것으로 적지 않는다', () => {
    // 연결은 됐다. 답도 왔다. 읽지 못했을 뿐이다.
    assert.notEqual(
      classifyCandidateGenerationFetchFailure({ stage: 'body_read_failed', timedOut: false }).outcome,
      'provider_unavailable',
    );
  });

  it('본문을 읽지 못한 것과 모델의 글을 읽지 못한 것은 다르다', () => {
    const bodyRead = classifyCandidateGenerationFetchFailure({
      stage: 'body_read_failed',
      timedOut: false,
    }).outcome;
    const modelJson = outcomeOf(rawHttpResponse({ output: [messageItem('{')] }));

    assert.equal(bodyRead, 'provider_error');
    assert.equal(modelJson, 'json_parse_failed');
    assert.notEqual(bodyRead, modelJson);
    assert.ok(BODY_READ_FAILURE_IS_NOT_MODEL_JSON_FAILURE.length > 0);
  });

  it('받아들여지지 않은 답은 숫자를 그대로 넘긴다', () => {
    assert.deepEqual(observeCandidateGenerationFetchFailure({ stage: 'http_not_ok', status: 429 }), {
      kind: 'http',
      status: 429,
    });
  });
});

/* ================================================================== */
/* 9. 숫자의 뜻은 이미 정해져 있다                                       */
/* ================================================================== */

describe('상태 숫자의 뜻을 여기서 정하지 않는다', () => {
  const http = (status: number) =>
    classifyCandidateGenerationFetchFailure({ stage: 'http_not_ok', status }).outcome;

  it('이미 있는 판단과 한 글자도 다르지 않다', () => {
    for (let status = 200; status <= 599; status += 1) {
      assert.equal(
        http(status),
        classifyCandidateGenerationProviderFailure({ kind: 'http', status }).outcome,
        String(status),
      );
    }
  });

  it('정해진 대로 나온다', () => {
    assert.equal(http(408), 'provider_timeout');
    assert.equal(http(429), 'provider_unavailable');
    for (const status of [500, 502, 503, 504]) {
      assert.equal(http(status), 'provider_unavailable', String(status));
    }
    for (const status of [400, 401, 403, 404, 409, 422]) {
      assert.equal(http(status), 'provider_error', String(status));
    }
  });

  it('숫자 표를 여기에 다시 만들지 않았다', () => {
    for (const status of ['408', '429', '500', '502', '503', '504', '401', '403', '404', '409', '422']) {
      assert.equal(TRANSPORT_SOURCE.includes(status), false, status);
    }
  });

  it('사유 이름을 손으로 적지 않았다', () => {
    for (const outcome of ['provider_timeout', 'provider_unavailable', 'provider_error']) {
      assert.equal(TRANSPORT_SOURCE.includes(outcome), false, outcome);
    }
  });

  it('이미 있는 판단을 부른다', () => {
    assert.ok(TRANSPORT_SOURCE.includes('classifyCandidateGenerationProviderFailure('));
  });

  it('오류 본문을 열지 않는다', () => {
    assert.deepEqual(HTTP_FAILURE_POLICY, {
      errorBodyRead: false,
      errorMessageCaptured: false,
      statusUsedOnlyForClassification: true,
      statusPreservedInOutcome: false,
      urlPreserved: false,
    });
  });

  it('숫자가 결과에 남지 않는다', () => {
    const result = classifyCandidateGenerationFetchFailure({ stage: 'http_not_ok', status: 503 });
    assert.deepEqual(Object.keys(result), ['outcome']);
    assert.equal(JSON.stringify(result).includes('503'), false);
  });
});

/* ================================================================== */
/* 10. 보내고 받는 동안의 순서                                           */
/* ================================================================== */

describe('한 번의 요청이 지나가는 자리', () => {
  it('열한 자리를 적어 두었다', () => {
    assert.equal(FETCH_TRANSPORT_LIFECYCLE.length, 11);
  });

  it('열쇠를 먼저 보고 마지막에 정리한다', () => {
    assert.ok(FETCH_TRANSPORT_LIFECYCLE[0]?.includes('열쇠'));
    assert.ok(FETCH_TRANSPORT_LIFECYCLE[FETCH_TRANSPORT_LIFECYCLE.length - 1]?.includes('정리'));
  });

  it('한 번만 보낸다', () => {
    assert.equal(FETCH_ATTEMPTS, 1);
    assert.equal(RUNTIME_BOUNDARY_RETRY_POLICY.automaticRetries, 0);
  });

  it('보내는 횟수를 여기서 새로 정하지 않았다', () => {
    assert.ok(TRANSPORT_SOURCE.includes('RUNTIME_BOUNDARY_RETRY_POLICY.automaticRetries + 1'));
  });

  it('시간 재기는 보내기 전에 시작해 본문을 다 읽을 때까지 간다', () => {
    assert.equal(TIMEOUT_LIFECYCLE_POLICY.startsBeforeNetworkAttempt, true);
    assert.equal(TIMEOUT_LIFECYCLE_POLICY.coversResponseBodyRead, true);
  });

  it('어느 길로 끝나든 한 번 정리한다', () => {
    assert.equal(TIMEOUT_LIFECYCLE_POLICY.cleanupAlways, true);
    assert.equal(TIMEOUT_LIFECYCLE_POLICY.cleanupCount, 1);
  });

  it('기다리는 시간의 주인은 앞서 정한 곳이다', () => {
    assert.equal(TIMEOUT_LIFECYCLE_POLICY.timeoutMs, RUNTIME_BOUNDARY_TIMEOUT_POLICY.timeoutMs);
    assert.equal(TIMEOUT_LIFECYCLE_POLICY.timeoutMs, CANDIDATE_GENERATION_RUNTIME_CONFIG.timeoutMs);

    for (const literal of ['60_000', '60000', '60 * 1000']) {
      assert.equal(TRANSPORT_SOURCE.includes(literal), false, literal);
    }
  });

  it('끊겼다는 표시만으로 시간 초과라고 하지 않는다', () => {
    assert.equal(TIMED_OUT_FLAG_POLICY.explicitFlagRequired, true);
    assert.equal(TIMED_OUT_FLAG_POLICY.abortedAloneIsEnough, false);
  });
});

/* ================================================================== */
/* 11. 보낼 것과 열쇠                                                    */
/* ================================================================== */

describe('보낼 것은 여기서 만들지 않는다', () => {
  it('본문 항목 수의 주인은 어댑터다', () => {
    assert.equal(REQUEST_SPEC_POLICY.bodyFieldCount, OPENAI_REQUEST_BODY_FIELDS.length);
    assert.equal(REQUEST_SPEC_POLICY.bodyFieldCount, 12);
  });

  it('본문을 다시 만들거나 고치지 않는다', () => {
    assert.equal(REQUEST_SPEC_POLICY.bodyRebuiltHere, false);
    assert.equal(REQUEST_SPEC_POLICY.bodyFieldsAddedHere, false);
    assert.equal(REQUEST_SPEC_POLICY.bodyFieldsRemovedHere, false);
    assert.equal(REQUEST_SPEC_POLICY.bodyFieldsModifiedHere, false);
    assert.equal(REQUEST_SPEC_POLICY.serializedExactlyOnce, true);
  });

  it('본문 항목 이름을 여기서 다시 적지 않았다', () => {
    for (const field of OPENAI_REQUEST_BODY_FIELDS) {
      // 값으로 적은 것도, 자리 이름으로 적은 것도 둘 다 막는다.
      // 하나만 막으면 다른 형태로 본문을 다시 조립할 수 있다.
      assert.equal(TRANSPORT_SOURCE.includes(`'${field}'`), false, field);
      assert.equal(TRANSPORT_SOURCE.includes(`${field}:`), false, `${field}:`);
    }
  });

  it('보낼 것을 만드는 함수를 부르지 않는다', () => {
    assert.equal(TRANSPORT_SOURCE.includes('buildCandidateGenerationOpenAIRequestSpec'), false);
  });

  it('열쇠 이름만 안다', () => {
    assert.equal(CREDENTIAL_POLICY.envName, CANDIDATE_GENERATION_OPENAI_CREDENTIAL_ENV_NAME);
    assert.equal(CREDENTIAL_POLICY.envName, 'OPENAI_API_KEY');
    assert.equal(TRANSPORT_SOURCE.includes("'OPENAI_API_KEY'"), false);
  });

  it('열쇠를 읽지도, 머리글을 만들지도 않는다', () => {
    assert.equal(CREDENTIAL_POLICY.envReadHere, false);
    assert.equal(CREDENTIAL_POLICY.receivedAsParameter, true);
    assert.equal(CREDENTIAL_POLICY.authorizationHeaderBuiltHere, false);
    assert.equal(CREDENTIAL_POLICY.credentialInPureResult, false);
  });

  it('주소를 일곱 번째로 적지 않았다', () => {
    assert.equal(PROVIDER_PROTOCOL.endpointDefinedHere, false);
    assert.equal(PROVIDER_PROTOCOL.headersBuiltHere, false);
    assert.equal(PROVIDER_PROTOCOL.method, 'POST');
  });
});

/* ================================================================== */
/* 12. 누가 무엇의 주인인가                                              */
/* ================================================================== */

describe('주인이 겹치지 않는다', () => {
  it('여섯 가지가 각각 한 주인을 갖는다', () => {
    assert.deepEqual(Object.keys(AUTHORITY_MAP), [
      'outputTextAggregation',
      'responseSemantics',
      'failureClassification',
      'timeoutAndRetry',
      'requestBody',
      'transportLifecycle',
    ]);
    assert.equal(new Set(Object.values(AUTHORITY_MAP)).size, 6);
  });

  it('가져다 쓰는 곳은 저장소 안의 넷뿐이다', () => {
    const specifiers = [...TRANSPORT_SOURCE.matchAll(/from '([^']+)'/g)].map((m) => m[1] as string);

    assert.deepEqual(specifiers, [
      './openai-response.ts',
      './published-content-candidate-generation-openai-adapter-contract.ts',
      './published-content-candidate-generation-openai-runtime-boundary.ts',
      './published-content-candidate-generation-transport-contract.ts',
    ]);
  });

  it('하지 않는 일을 적어 두었다', () => {
    assert.ok(FETCH_TRANSPORT_DOES_NOT_INCLUDE.length >= 8);
  });
});

/* ================================================================== */
/* 13. 남기지 않는다                                                    */
/* ================================================================== */

describe('남기지 않는다', () => {
  it('기록에 관한 약속을 앞 계층에서 그대로 가져왔다', () => {
    assert.equal(FETCH_TRANSPORT_LOGGING_POLICY, RUNTIME_BOUNDARY_LOGGING_POLICY);
    assert.equal(FETCH_TRANSPORT_LOGGING_POLICY.debugLoggingAllowed, false);
    assert.equal(FETCH_TRANSPORT_LOGGING_POLICY.rawRequestLoggingAllowed, false);
    assert.equal(FETCH_TRANSPORT_LOGGING_POLICY.rawResponseLoggingAllowed, false);
  });

  it('무엇도 남기지 않는다', () => {
    assert.deepEqual(FETCH_TRANSPORT_PERSISTENCE_POLICY, {
      rawResponsePersisted: false,
      derivedOutputTextPersisted: false,
      rawRefusalPersisted: false,
      reasoningExtracted: false,
      reasoningPersisted: false,
      providerErrorBodyPersisted: false,
      providerErrorMessagePersisted: false,
    });
  });

  it('실제로 기록하는 코드가 없다', () => {
    for (const banned of ['console.', 'logger', 'log(']) {
      assert.equal(TRANSPORT_SOURCE.includes(banned), false, banned);
    }
  });
});

/* ================================================================== */
/* 14. 실제로는 아무것도 부르지 않는다                                    */
/* ================================================================== */

describe('이 파일은 부르지 않는다', () => {
  it('보내지 않는다', () => {
    for (const banned of [
      'fetch(',
      'api.openai.com',
      'https://',
      'new Request',
      'new Headers',
      'new Response',
      'XMLHttpRequest',
    ]) {
      assert.equal(TRANSPORT_SOURCE.includes(banned), false, banned);
    }
  });

  it('제공자 라이브러리를 가져오지 않는다', () => {
    for (const banned of ['import OpenAI', "from 'openai'", 'from "openai"', 'new OpenAI', 'responses.create', 'responses.parse']) {
      assert.equal(TRANSPORT_SOURCE.includes(banned), false, banned);
    }
  });

  it('시간을 실제로 재지 않는다', () => {
    assert.equal(TIMEOUT_LIFECYCLE_POLICY.implementedHere, false);
    for (const banned of ['AbortController', 'AbortSignal', 'setTimeout', 'clearTimeout']) {
      assert.equal(TRANSPORT_SOURCE.includes(banned), false, banned);
    }
  });

  it('열쇠와 인증 값을 만지지 않는다', () => {
    // 머리글을 실제로 만드는 형태만 막는다. 만들지 않는다고 적어 둔 이름은 정상이다.
    for (const banned of ['Deno.env', 'process.env', 'authorization:', 'Authorization', 'Bearer']) {
      assert.equal(TRANSPORT_SOURCE.includes(banned), false, banned);
    }
  });

  it('표를 만지지 않는다', () => {
    for (const banned of ['createClient', 'supabase', 'service_role', '/rest/v1/']) {
      assert.equal(TRANSPORT_SOURCE.includes(banned), false, banned);
    }
  });

  it('바깥 세계를 읽지 않는다', () => {
    for (const banned of ['Date.now', 'Math.random', 'randomUUID', 'readFile', 'writeFile']) {
      assert.equal(TRANSPORT_SOURCE.includes(banned), false, banned);
    }
  });
});
