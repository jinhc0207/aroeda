/**
 * Biblical Researcher 실행 순서 · 테스트
 *
 * 실행: npm test
 *
 * 지키려는 것:
 *   요청 본문이 정해진 정책 그대로다.
 *   모델이 보는 데이터가 한 글자도 줄지 않는다.
 *   꾸러미 지문은 모델에게 보이지 않고, 최종 결과에는 붙는다.
 *   요청은 정확히 한 번이다.
 *   실패하면 그 자리에서 멈추고, 그 뒤 단계를 하지 않는다.
 *   실패 결과에 원본 오류나 모델이 쓴 글이 남지 않는다.
 *
 * 실제 OpenAI·웹·DB 호출은 하지 않는다. 보내는 일은 가짜로 넣어 준다.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  BIBLICAL_RESEARCH_RESPONSE_SCHEMA_NAME,
  buildBiblicalResearchResponsesRequest,
  executeBiblicalResearchRuntime,
  type BiblicalResearchResponsesTransport,
  type BiblicalResearchTransportResult,
} from '../../supabase/functions/_shared/biblical-researcher-runtime-contract.ts';
import {
  BIBLICAL_RESEARCH_API_FAMILY,
  BIBLICAL_RESEARCH_FAILURES,
  BIBLICAL_RESEARCH_MAX_OUTPUT_TOKENS,
  BIBLICAL_RESEARCH_MODEL,
  BIBLICAL_RESEARCH_MODEL_TIMEOUT_MS,
  BIBLICAL_RESEARCH_REASONING_EFFORT,
  BIBLICAL_RESEARCH_RETRY_COUNT,
  BIBLICAL_RESEARCH_STORE,
  BIBLICAL_RESEARCH_TOOLS,
  BIBLICAL_RESEARCH_TRUNCATION,
} from '../../supabase/functions/_shared/biblical-researcher-runtime-policy.ts';
import { buildBiblicalResearchExecutionPlan } from '../../supabase/functions/_shared/biblical-researcher-execution-contract.ts';
import { BIBLICAL_RESEARCH_SCHEMA } from '../../supabase/functions/_shared/biblical-research-contract.ts';
import {
  buildBiblicalResearchHandoff,
  type BiblicalResearchHandoff,
} from '../../supabase/functions/_shared/biblical-research-handoff.ts';
import { computeSourceId } from '../../supabase/functions/_shared/source-harvester.ts';
import { getActiveCoveredDomains } from '../../supabase/functions/_shared/research-prioritizer-edge.ts';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '');

const RUNTIME = '../../supabase/functions/_shared/biblical-researcher-runtime-contract.ts';

/* ------------------------------------------------------------------ */
/* 근거 꾸러미 하나                                                      */
/* ------------------------------------------------------------------ */

const SNAPSHOT = `snap_${'a'.repeat(64)}`;
const DOMAIN = 'financial_hardship';
const VERSION = 4;

/** 후보 세 개가 다룰 본문. 서로 겹치지 않는다. */
const PASSAGES = [
  { book: 'Psalms', chapter: 42, startVerse: 5, endVerse: 5 },
  { book: 'Psalms', chapter: 62, startVerse: 8, endVerse: 8 },
  { book: 'Psalms', chapter: 121, startVerse: 1, endVerse: 2 },
];

const fixtureUrl = (index: number) => `https://sources.example.org/aroeda/runtime-${index}`;
const SOURCE_IDS = await Promise.all(
  Array.from({ length: 5 }, (_, index) => computeSourceId(fixtureUrl(index))),
);
const sid = (index: number) => SOURCE_IDS[index] as string;

const STATEMENT = '이 자료는 본문의 흐름과 그 신학적 자리를 함께 설명한다고 관찰되었다. 충분히 긴 문장이다.';

/** 자료 다섯 건. 첫 자료가 후보 셋의 주해 근거를 모두 들고 있다. */
const SPECS = [
  {
    type: 'commentary',
    publisher: 'Fixture Academic Press',
    uses: ['exegesis'],
    access: 'full_text',
    claims: PASSAGES.map((passage) => ({ use: 'exegesis', refs: [{ ...passage }] })),
  },
  {
    type: 'biblical_theology',
    publisher: 'Fixture University Press',
    uses: ['doctrinal_context'],
    access: 'substantial_preview',
    claims: [{ use: 'doctrinal_context', refs: [] }],
  },
  {
    type: 'academic_article',
    publisher: 'Fixture Journal',
    uses: ['exegesis'],
    access: 'full_text',
    claims: [{ use: 'exegesis', refs: [{ ...PASSAGES[0] }] }],
  },
  {
    type: 'pastoral_resource',
    publisher: 'Fixture Seminary',
    uses: ['pastoral_application'],
    access: 'full_text',
    claims: [{ use: 'pastoral_application', refs: [] }],
  },
  {
    type: 'professional_context',
    publisher: 'Fixture Public Health Agency',
    uses: ['pastoral_safety'],
    access: 'full_text',
    claims: [{ use: 'pastoral_safety', refs: [] }],
  },
];

const outcome = await buildBiblicalResearchHandoff({
  harvest: {
    targetDomain: DOMAIN,
    evidenceVersion: VERSION,
    prioritizerSnapshotId: SNAPSHOT,
    sources: SPECS.map((spec, index) => ({
      sourceId: sid(index),
      sourceType: spec.type,
      title: `연구 자료 ${index}`,
      authorOrOrganization: `연구자 ${index}`,
      publisherOrInstitution: spec.publisher,
      publicationYear: 2018 + index,
      url: fixtureUrl(index),
      accessedAt: '2026-09-02',
      accessLevel: spec.access,
      intendedUse: [...spec.uses],
      relevanceNote: '이 영역의 문맥을 확인하는 데 필요합니다.',
      evidenceClaims: spec.claims.map((claim, claimIndex) => ({
        evidenceId: `${sid(index)}:e${claimIndex + 1}`,
        intendedUse: claim.use,
        statement: `${STATEMENT} (${index}-${claimIndex})`,
        passageReferences: claim.refs,
      })),
    })),
    rejectedSources: [
      { url: fixtureUrl(90), title: '익명 묵상글', rejectionReason: 'anonymous_or_unverifiable' },
    ],
    unresolvedSourceQuestions: ['더 볼 자료가 있는가', '학회 자료를 볼 수 있는가'],
  } as never,
  activeCoveredDomains: getActiveCoveredDomains(),
});
assert.equal(outcome.ok, true, outcome.ok ? '' : outcome.errors.join(' / '));
if (!outcome.ok) throw new Error('handoff fixture failed');
const HANDOFF: BiblicalResearchHandoff = outcome.handoff;

/* ------------------------------------------------------------------ */
/* 올바른 초안 하나                                                      */
/* ------------------------------------------------------------------ */

const candidate = (index: number) => ({
  reference: { ...PASSAGES[index] },
  additionalReferences: [],
  canonicalContext: `이 본문은 앞뒤 문맥에서 무엇을 말하고 있는지 설명합니다 (${index}).`,
  theologicalContribution: `이 본문이 성경 전체에서 하는 일을 설명합니다 (${index}).`,
  domainFit: `이 영역의 실제 어려움과 어떻게 맞닿는지 설명합니다 (${index}).`,
  pastoralUse: ['이렇게 읽어 주면 도움이 됩니다.'],
  misuseRisks: ['이렇게 쓰면 본문을 잘못 쓰는 것입니다.'],
  distinctnessFromActiveCoverage: {
    distinct: true,
    nearestExistingDomain: null,
    explanation: '기존 영역과 무엇이 다른지 설명합니다.',
  },
  researchConfidence: 0.7,
  sourceSupport: {
    exegesisEvidenceIds: [`${sid(0)}:e${index + 1}`],
    theologyEvidenceIds: [`${sid(1)}:e1`],
    pastoralEvidenceIds: [`${sid(3)}:e1`],
    safetyEvidenceIds: [`${sid(4)}:e1`],
  },
});

const validDraft = () => ({
  targetDomain: DOMAIN,
  evidenceVersion: VERSION,
  prioritizerSnapshotId: SNAPSHOT,
  researchQuestion: '이 영역에서 붙들 말씀은 무엇인가.',
  domainBoundaries: {
    includedConcerns: ['생계가 흔들리는 상황'],
    excludedOrAdjacentConcerns: ['직장 안에서의 갈등'],
  },
  candidatePassages: [candidate(0), candidate(1), candidate(2)],
  rejectedPassages: [
    {
      reference: { book: 'Philippians', chapter: 4, startVerse: 13, endVerse: 13 },
      rejectionReason: '이 영역의 어려움을 다루는 본문이 아닙니다.',
      riskCategory: 'prosperity_risk',
    },
  ],
  unresolvedQuestions: [],
});

/* ------------------------------------------------------------------ */
/* 가짜 transport                                                      */
/* ------------------------------------------------------------------ */

type Call = { request: Record<string, unknown>; options: { timeoutMs: number } };

/** 정해진 답을 그대로 돌려주는 가짜. 몇 번 불렸는지 센다. */
const stubTransport = (result: BiblicalResearchTransportResult) => {
  const calls: Call[] = [];
  const transport: BiblicalResearchResponsesTransport = async (request, options) => {
    calls.push({ request, options });
    return result;
  };
  return { transport, calls };
};

/** 답변 문장 하나가 들어 있는 응답. 배열의 첫 자리에 두지 않는다. */
const completedWith = (text: string) => ({
  status: 'completed',
  output: [
    { type: 'reasoning', summary: [] },
    { type: 'message', content: [{ type: 'output_text', text }] },
  ],
});

const runWith = async (response: unknown) => {
  const { transport, calls } = stubTransport({ ok: true, response });
  const result = await executeBiblicalResearchRuntime({ handoff: HANDOFF, transport });
  return { result, calls };
};

const runWithText = (text: string) => runWith(completedWith(text));
const runWithDraft = (draft: unknown) => runWithText(JSON.stringify(draft));

/* ================================================================== */
/* A. 요청 본문                                                        */
/* ================================================================== */

describe('실행 순서 · A. 요청 본문', () => {
  const request = buildBiblicalResearchResponsesRequest({ handoff: HANDOFF });

  it('Responses 계열의 모양이다', () => {
    assert.equal(BIBLICAL_RESEARCH_API_FAMILY, 'responses');
    // 지시문과 입력이 따로 있고, 응답 형식이 text.format에 있다.
    assert.equal(typeof request.instructions, 'string');
    assert.equal(typeof request.input, 'string');
    assert.ok(request.text);
    // 옛 방식의 자리는 없다.
    assert.equal('messages' in request, false);
    assert.equal('response_format' in request, false);
    assert.equal('functions' in request, false);
  });

  it('모델은 정해진 하나다', () => {
    assert.equal(request.model, BIBLICAL_RESEARCH_MODEL);
    assert.equal(request.model, 'gpt-5.6-sol');
  });

  it('생각하는 정도가 정책 그대로다', () => {
    assert.deepEqual(request.reasoning, { effort: BIBLICAL_RESEARCH_REASONING_EFFORT });
    assert.deepEqual(request.reasoning, { effort: 'medium' });
  });

  it('출력 한도가 정책 그대로다', () => {
    assert.equal(request.max_output_tokens, BIBLICAL_RESEARCH_MAX_OUTPUT_TOKENS);
    assert.equal(request.max_output_tokens, 16_000);
  });

  it('저장하지 않고, 도구가 없고, 자르지 않는다', () => {
    assert.equal(request.store, BIBLICAL_RESEARCH_STORE);
    assert.equal(request.store, false);
    assert.deepEqual(request.tools, []);
    assert.equal(request.tools, BIBLICAL_RESEARCH_TOOLS);
    assert.equal(request.truncation, BIBLICAL_RESEARCH_TRUNCATION);
    assert.equal(request.truncation, 'disabled');
  });

  it('형식이 정해진 답을 엄격하게 받는다', () => {
    const format = (request.text as { format: Record<string, unknown> }).format;
    assert.equal(format.type, 'json_schema');
    assert.equal(format.strict, true);
    assert.equal(format.name, BIBLICAL_RESEARCH_RESPONSE_SCHEMA_NAME);
    assert.equal(typeof BIBLICAL_RESEARCH_RESPONSE_SCHEMA_NAME, 'string');
  });

  it('응답 형식은 원래 객체 그 자체다', () => {
    const format = (request.text as { format: Record<string, unknown> }).format;
    // 베껴 적지 않았다. 같은 객체다.
    assert.equal(format.schema, BIBLICAL_RESEARCH_SCHEMA);
    assert.equal(
      format.schema,
      buildBiblicalResearchExecutionPlan({ handoff: HANDOFF }).structuredOutputSchema,
    );
  });

  it('지시문은 실행 계약이 만든 것 그대로다', () => {
    assert.equal(
      request.instructions,
      buildBiblicalResearchExecutionPlan({ handoff: HANDOFF }).instructions,
    );
  });

  it('정책에 없는 설정을 마음대로 넣지 않는다', () => {
    for (const banned of [
      'temperature',
      'top_p',
      'background',
      'previous_response_id',
      'conversation',
      'metadata',
      'user',
      'safety_identifier',
      'prompt_cache_key',
      'max_tool_calls',
      'include',
      'n',
      'seed',
    ]) {
      assert.equal(banned in request, false, banned);
    }
  });

  it('부르는 쪽이 정책을 바꿔 넣을 자리가 없다', () => {
    const code = stripComments(read(RUNTIME));
    // 인자로 받는 것은 꾸러미와 보내는 일 둘뿐이다.
    assert.equal(code.includes('handoff: BiblicalResearchHandoff;'), true);
    assert.equal(code.includes('transport: BiblicalResearchResponsesTransport;'), true);
    for (const banned of ['model?', 'timeoutMs?', 'effort?', 'maxOutputTokens?', 'override']) {
      assert.equal(code.includes(banned), false, banned);
    }
  });
});

/* ================================================================== */
/* B. 모델이 보는 데이터                                               */
/* ================================================================== */

describe('실행 순서 · B. 모델이 보는 데이터', () => {
  const request = buildBiblicalResearchResponsesRequest({ handoff: HANDOFF });
  const plan = buildBiblicalResearchExecutionPlan({ handoff: HANDOFF });
  const sent = JSON.parse(request.input as string);

  it('읽어서 되돌리면 실행 계획이 만든 것 그대로다', () => {
    assert.deepEqual(sent, plan.modelInput);
  });

  it('자료도 근거도 하나 줄지 않았다', () => {
    assert.equal(sent.sources.length, HANDOFF.sources.length);
    for (const [index, source] of HANDOFF.sources.entries()) {
      assert.equal(sent.sources[index].sourceId, source.sourceId);
      assert.equal(sent.sources[index].evidenceClaims.length, source.evidenceClaims.length);
      for (const [claimIndex, claim] of source.evidenceClaims.entries()) {
        const carried = sent.sources[index].evidenceClaims[claimIndex];
        assert.equal(carried.evidenceId, claim.evidenceId);
        assert.equal(carried.intendedUse, claim.intendedUse);
        assert.equal(carried.statement, claim.statement);
        assert.deepEqual(carried.passageReferences, claim.passageReferences);
      }
    }
  });

  it('남은 물음도 그대로 간다', () => {
    assert.deepEqual(sent.sourceUnresolvedQuestions, HANDOFF.sourceUnresolvedQuestions);
  });

  it('꾸러미 지문은 모델에게 보이지 않는다', () => {
    assert.equal((request.input as string).includes(HANDOFF.evidenceSetHash), false);
    assert.equal(JSON.stringify(request).includes(HANDOFF.evidenceSetHash), false);
    assert.equal('evidenceSetHash' in sent, false);
  });

  it('자료 고른 이유와 버린 자료는 보이지 않는다', () => {
    const serialized = request.input as string;
    assert.equal(serialized.includes('relevanceNote'), false);
    assert.equal(serialized.includes('rejectedSources'), false);
  });

  it('사용자 정보와 내부 표 번호가 없다', () => {
    const serialized = JSON.stringify(request);
    for (const banned of [
      'rawSituation',
      'userSituation',
      'userId',
      'user_id',
      'sessionId',
      'deviceId',
      'prayerText',
      'decisionId',
      'recoveryId',
      'prioritizerReason',
      'prioritizerScore',
    ]) {
      assert.equal(serialized.includes(banned), false, banned);
    }
  });
});

/* ================================================================== */
/* C. 보내는 일                                                        */
/* ================================================================== */

describe('실행 순서 · C. 보내는 일', () => {
  it('정확히 한 번만 부른다', async () => {
    const { calls } = await runWithDraft(validDraft());
    assert.equal(calls.length, 1);
  });

  it('기다리는 시간은 정해진 값 그대로 건넨다', async () => {
    const { calls } = await runWithDraft(validDraft());
    assert.equal(calls[0]?.options.timeoutMs, BIBLICAL_RESEARCH_MODEL_TIMEOUT_MS);
    assert.equal(calls[0]?.options.timeoutMs, 90_000);
  });

  it('보낸 것은 이 계약이 만든 요청 본문이다', async () => {
    const { calls } = await runWithDraft(validDraft());
    assert.deepEqual(calls[0]?.request, buildBiblicalResearchResponsesRequest({ handoff: HANDOFF }));
  });

  it('시간이 지나면 시간 지남으로 끝난다', async () => {
    const { transport, calls } = stubTransport({ ok: false, failure: 'model_timeout' });
    const result = await executeBiblicalResearchRuntime({ handoff: HANDOFF, transport });
    assert.deepEqual(result, { ok: false, failure: 'model_timeout' });
    assert.equal(calls.length, 1);
  });

  it('요청 자체가 실패하면 전송 실패로 끝난다', async () => {
    const { transport, calls } = stubTransport({ ok: false, failure: 'model_transport_error' });
    const result = await executeBiblicalResearchRuntime({ handoff: HANDOFF, transport });
    assert.deepEqual(result, { ok: false, failure: 'model_transport_error' });
    assert.equal(calls.length, 1);
  });

  it('보내는 쪽이 그냥 터져도 오류가 밖으로 새지 않는다', async () => {
    let called = 0;
    const transport: BiblicalResearchResponsesTransport = async () => {
      called += 1;
      throw new Error('비밀이 담긴 오류 문구');
    };
    const result = await executeBiblicalResearchRuntime({ handoff: HANDOFF, transport });
    assert.deepEqual(result, { ok: false, failure: 'model_transport_error' });
    assert.equal(called, 1);
  });

  it('돌려준 것이 응답 모양이 아니면 정상 완료 실패로 본다', async () => {
    // 보내는 일은 이미 끝났다. 전송 실패가 아니다.
    for (const shape of ['응답이 아니라 그냥 문자열', null, [], 42, true]) {
      const { result } = await runWith(shape);
      assert.deepEqual(result, { ok: false, failure: 'model_non_success' }, JSON.stringify(shape));
    }
  });

  it('전송 실패는 보내는 일이 실패했을 때만이다', () => {
    const code = stripComments(read(RUNTIME));
    // 밖에서 그렇게 말했을 때, 또는 그냥 터졌을 때. 그 두 곳뿐이다.
    assert.equal((code.match(/failed\('model_transport_error'\)/g) || []).length, 1);
    assert.ok(code.includes('return failed(sent.failure);'));
    // 응답을 받은 뒤에는 전송 실패로 분류하지 않는다.
    assert.ok(
      code.indexOf("failed('model_transport_error')") < code.indexOf('if (!sent.ok)'),
    );
    // 시간 지남은 밖에서 그렇게 말했을 때만이다.
    assert.equal((code.match(/failed\('model_timeout'\)/g) || []).length, 0);
  });

  it('다시 부르는 코드가 아예 없다', () => {
    const code = stripComments(read(RUNTIME));
    for (const banned of [
      'for (',
      'while (',
      'retry',
      'attempt',
      'fallback',
      'secondaryTransport',
      'Promise.all',
      'setTimeout',
    ]) {
      assert.equal(code.includes(banned), false, banned);
    }
    assert.equal(BIBLICAL_RESEARCH_RETRY_COUNT, 0);
    // transport를 부르는 자리는 한 곳뿐이다.
    assert.equal((code.match(/await transport\(/g) || []).length, 1);
  });
});

/* ================================================================== */
/* D. 응답 상태                                                        */
/* ================================================================== */

describe('실행 순서 · D. 응답 상태', () => {
  it('온전히 끝난 답만 다음 단계로 간다', async () => {
    const { result } = await runWithDraft(validDraft());
    assert.equal(result.ok, true);
  });

  it('끊긴 답은 끊김으로 끝난다', async () => {
    const { result } = await runWith({
      ...completedWith(JSON.stringify(validDraft())),
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
    });
    assert.deepEqual(result, { ok: false, failure: 'model_incomplete' });
  });

  it('끊긴 답에 쓸 만한 내용이 있어도 읽지 않는다', () => {
    const code = stripComments(read(RUNTIME));
    // 왜 끊겼는지 읽어서 다르게 행동하지 않는다.
    assert.equal(code.includes('incomplete_details'), false);
    // 끊김 판정이 답을 꺼내는 것보다 먼저 나온다.
    assert.ok(code.indexOf("'model_incomplete'") < code.indexOf('extractOutputText('));
  });

  it('끝나지 않은 다른 상태는 모두 하나로 본다', async () => {
    for (const status of ['failed', 'cancelled', 'queued', 'in_progress', 'unknown_status']) {
      const { result } = await runWith({
        ...completedWith(JSON.stringify(validDraft())),
        status,
      });
      assert.deepEqual(result, { ok: false, failure: 'model_non_success' }, status);
    }
  });

  it('상태가 아예 없으면 끝나지 않은 것으로 본다', async () => {
    const { result } = await runWith({
      output: completedWith(JSON.stringify(validDraft())).output,
    });
    assert.deepEqual(result, { ok: false, failure: 'model_non_success' });
  });

  it('상태별로 새 이름을 만들지 않는다', () => {
    const code = stripComments(read(RUNTIME));
    for (const banned of ['model_failed', 'model_cancelled', 'model_queued', 'model_in_progress']) {
      assert.equal(code.includes(banned), false, banned);
    }
  });
});

/* ================================================================== */
/* E. 거절과 답변 문장                                                  */
/* ================================================================== */

describe('실행 순서 · E. 거절과 답변 문장', () => {
  it('모델이 거절하면 거절로 끝난다', async () => {
    const { result } = await runWith({
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'refusal', refusal: '답할 수 없습니다.' }] }],
    });
    assert.deepEqual(result, { ok: false, failure: 'model_refusal' });
  });

  it('답변 문장이 없으면 없음으로 끝난다', async () => {
    const { result } = await runWith({ status: 'completed', output: [] });
    assert.deepEqual(result, { ok: false, failure: 'model_output_missing' });
  });

  it('빈 문장도 없음으로 본다', async () => {
    const { result } = await runWithText('   ');
    assert.deepEqual(result, { ok: false, failure: 'model_output_missing' });
  });

  it('답이 배열 어느 자리에 있든 찾는다', async () => {
    // 앞에 다른 항목이 두 개 있어도 된다.
    const { result } = await runWith({
      status: 'completed',
      output: [
        { type: 'reasoning', summary: [] },
        { type: 'web_search_call', status: 'completed' },
        { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(validDraft()) }] },
      ],
    });
    assert.equal(result.ok, true);
  });

  it('거절과 답 꺼내기는 공용 helper를 그대로 쓴다', () => {
    const code = stripComments(read(RUNTIME));
    assert.ok(code.includes("from './openai-response.ts'"));
    assert.ok(code.includes('hasRefusal(response)'));
    assert.ok(code.includes('extractOutputText(response)'));
    // 답을 찾는 자리를 여기서 짐작하지 않는다.
    for (const banned of ['output[0]', '.output.find', "'output_text'", "'refusal'"]) {
      assert.equal(code.includes(banned), false, banned);
    }
  });
});

/* ================================================================== */
/* F. JSON 읽기                                                        */
/* ================================================================== */

describe('실행 순서 · F. JSON 읽기', () => {
  it('올바른 JSON은 다음 단계로 간다', async () => {
    const { result } = await runWithDraft(validDraft());
    assert.equal(result.ok, true);
  });

  it('JSON이 아니면 읽기 실패로 끝난다', async () => {
    const { result } = await runWithText('JSON이 아닙니다');
    assert.deepEqual(result, { ok: false, failure: 'model_output_invalid_json' });
  });

  it('```로 감싼 JSON은 살려 쓰지 않는다', async () => {
    const { result } = await runWithText('```json\n' + JSON.stringify(validDraft()) + '\n```');
    assert.deepEqual(result, { ok: false, failure: 'model_output_invalid_json' });
  });

  it('앞뒤에 말이 붙은 JSON도 살려 쓰지 않는다', async () => {
    const { result } = await runWithText('답입니다: ' + JSON.stringify(validDraft()) + ' 끝.');
    assert.deepEqual(result, { ok: false, failure: 'model_output_invalid_json' });
  });

  it('중간에 끊긴 JSON도 살려 쓰지 않는다', async () => {
    const text = JSON.stringify(validDraft());
    const { result } = await runWithText(text.slice(0, Math.floor(text.length / 2)));
    assert.deepEqual(result, { ok: false, failure: 'model_output_invalid_json' });
  });

  it('고쳐 읽는 코드가 없다', () => {
    const code = stripComments(read(RUNTIME));
    assert.equal((code.match(/JSON\.parse\(/g) || []).length, 1);
    for (const banned of ['```', 'replace(', 'indexOf(', 'lastIndexOf(', 'slice(', 'match(', 'eval(']) {
      assert.equal(code.includes(banned), false, banned);
    }
  });
});

/* ================================================================== */
/* G. 초안 검사                                                        */
/* ================================================================== */

describe('실행 순서 · G. 초안 검사', () => {
  const invalid = async (mutate: (draft: Record<string, unknown>) => void) => {
    const draft = validDraft() as unknown as Record<string, unknown>;
    mutate(draft);
    const { result } = await runWithDraft(draft);
    return result;
  };

  it('읽혔다고 그냥 믿지 않는다', () => {
    const code = stripComments(read(RUNTIME));
    assert.ok(code.includes('validateBiblicalResearchDraftResult(parsed, handoff.brief)'));
    // 검사보다 먼저 초안으로 단정하지 않는다.
    assert.ok(
      code.indexOf('validateBiblicalResearchDraftResult(') <
        code.indexOf('bindBiblicalResearchEvidence('),
    );
  });

  it('JSON이지만 객체가 아니면 초안 잘못이다', async () => {
    const { result } = await runWithText('[1, 2, 3]');
    assert.deepEqual(result, { ok: false, failure: 'model_draft_invalid' });
  });

  it('모델이 꾸러미 지문을 적어 오면 거절한다', async () => {
    const result = await invalid((draft) => {
      draft.evidenceSetHash = HANDOFF.evidenceSetHash;
    });
    assert.deepEqual(result, { ok: false, failure: 'model_draft_invalid' });
  });

  it('모델이 자료 id를 적어 오면 거절한다', async () => {
    const result = await invalid((draft) => {
      const support = (draft.candidatePassages as Record<string, unknown>[])[0]
        ?.sourceSupport as Record<string, unknown>;
      support.exegesisSourceIds = [sid(0)];
    });
    assert.deepEqual(result, { ok: false, failure: 'model_draft_invalid' });
  });

  it('빠진 항목이 있으면 거절한다', async () => {
    const result = await invalid((draft) => {
      delete draft.researchQuestion;
    });
    assert.deepEqual(result, { ok: false, failure: 'model_draft_invalid' });
  });

  it('없는 항목을 더 적어 오면 거절한다', async () => {
    const result = await invalid((draft) => {
      draft.extraNote = '덧붙임';
    });
    assert.deepEqual(result, { ok: false, failure: 'model_draft_invalid' });
  });

  it('성경에 없는 장·절이면 거절한다', async () => {
    const result = await invalid((draft) => {
      const first = (draft.candidatePassages as Record<string, unknown>[])[0] as Record<string, unknown>;
      first.reference = { book: 'Psalms', chapter: 999, startVerse: 1, endVerse: 1 };
    });
    assert.deepEqual(result, { ok: false, failure: 'model_draft_invalid' });
  });

  it('후보 수가 정해진 범위를 벗어나면 거절한다', async () => {
    const result = await invalid((draft) => {
      draft.candidatePassages = [(draft.candidatePassages as unknown[])[0]];
    });
    assert.deepEqual(result, { ok: false, failure: 'model_draft_invalid' });
  });

  it('확신도가 0과 1 사이가 아니면 거절한다', async () => {
    const result = await invalid((draft) => {
      const first = (draft.candidatePassages as Record<string, unknown>[])[0] as Record<string, unknown>;
      first.researchConfidence = 1.5;
    });
    assert.deepEqual(result, { ok: false, failure: 'model_draft_invalid' });
  });

  it('성경 원문이나 기도문을 지어 오면 거절한다', async () => {
    const result = await invalid((draft) => {
      const first = (draft.candidatePassages as Record<string, unknown>[])[0] as Record<string, unknown>;
      first.verseText = '내 영혼아 네가 어찌하여 낙망하며';
    });
    assert.deepEqual(result, { ok: false, failure: 'model_draft_invalid' });
  });

  it('검사 사유와 모델이 쓴 글을 밖으로 내보내지 않는다', async () => {
    const result = await invalid((draft) => {
      delete draft.researchQuestion;
    });
    assert.deepEqual(Object.keys(result).sort(), ['failure', 'ok']);
  });
});

/* ================================================================== */
/* H. 근거에 묶기                                                       */
/* ================================================================== */

describe('실행 순서 · H. 근거에 묶기', () => {
  const bindFail = async (mutate: (support: Record<string, unknown>) => void) => {
    const draft = validDraft();
    mutate(draft.candidatePassages[0].sourceSupport as unknown as Record<string, unknown>);
    const { result } = await runWithDraft(draft);
    return result;
  };

  it('묶인 결과만 성공이다', async () => {
    const { result } = await runWithDraft(validDraft());
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.result.targetDomain, DOMAIN);
    assert.equal(result.result.candidatePassages.length, 3);
  });

  it('서버가 자료 id를 붙여 준다', async () => {
    const { result } = await runWithDraft(validDraft());
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const support = result.result.candidatePassages[0]?.sourceSupport;
    assert.deepEqual(support?.exegesisSourceIds, [sid(0)]);
    assert.deepEqual(support?.theologySourceIds, [sid(1)]);
  });

  it('꾸러미에 없는 근거는 묶기 실패다', async () => {
    const result = await bindFail((support) => {
      support.exegesisEvidenceIds = [`${sid(0)}:e9`];
    });
    assert.deepEqual(result, { ok: false, failure: 'evidence_binding_failed' });
  });

  it('역할에 맞지 않는 근거는 묶기 실패다', async () => {
    const result = await bindFail((support) => {
      // 주해 자리에 안전 근거를 넣었다.
      support.exegesisEvidenceIds = [`${sid(4)}:e1`];
    });
    assert.deepEqual(result, { ok: false, failure: 'evidence_binding_failed' });
  });

  it('이 본문을 다루지 않는 주해 근거는 묶기 실패다', async () => {
    const result = await bindFail((support) => {
      // 두 번째 후보의 본문을 다루는 근거를 첫 후보에 붙였다.
      support.exegesisEvidenceIds = [`${sid(0)}:e2`];
    });
    assert.deepEqual(result, { ok: false, failure: 'evidence_binding_failed' });
  });

  it('같은 근거를 두 역할에 쓰면 묶기 실패다', async () => {
    const result = await bindFail((support) => {
      support.theologyEvidenceIds = [`${sid(0)}:e1`];
    });
    assert.deepEqual(result, { ok: false, failure: 'evidence_binding_failed' });
  });

  it('묶기는 계획을 만들 때 쓴 그 꾸러미로 한 번만 한다', () => {
    const code = stripComments(read(RUNTIME));
    assert.equal((code.match(/bindBiblicalResearchEvidence\(/g) || []).length, 1);
    assert.ok(code.includes('handoff,'));
    // 응답으로 꾸러미를 새로 만들지 않는다.
    assert.equal(code.includes('buildBiblicalResearchHandoff'), false);
    assert.equal(code.includes('computeBiblicalResearchEvidenceSetHash'), false);
  });

  it('묶기 실패 사유를 밖으로 내보내지 않는다', async () => {
    const result = await bindFail((support) => {
      support.exegesisEvidenceIds = [`${sid(0)}:e9`];
    });
    assert.deepEqual(Object.keys(result).sort(), ['failure', 'ok']);
  });
});

/* ================================================================== */
/* I. 꾸러미 지문                                                       */
/* ================================================================== */

describe('실행 순서 · I. 꾸러미 지문', () => {
  it('모델은 못 보지만 최종 결과에는 붙는다', async () => {
    const request = buildBiblicalResearchResponsesRequest({ handoff: HANDOFF });
    assert.equal((request.input as string).includes(HANDOFF.evidenceSetHash), false);

    const { result } = await runWithDraft(validDraft());
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.result.evidenceSetHash, HANDOFF.evidenceSetHash);
  });
});

/* ================================================================== */
/* J. 실패하면 그 자리에서 멈춘다                                        */
/* ================================================================== */

describe('실행 순서 · J. 실패하면 그 자리에서 멈춘다', () => {
  it('실패 이름은 정해진 아홉 가지뿐이다', () => {
    const code = stripComments(read(RUNTIME));
    const used = new Set((code.match(/failed\('([a-z_]+)'\)/g) || []).map((m) => m.slice(8, -2)));
    for (const name of used) {
      assert.ok((BIBLICAL_RESEARCH_FAILURES as readonly string[]).includes(name), name);
    }
    // 아홉 가지가 모두 실제로 닿을 수 있다.
    assert.equal(used.size + 1, BIBLICAL_RESEARCH_FAILURES.length);
  });

  it('경계의 순서가 정해진 대로다', () => {
    const code = stripComments(read(RUNTIME));
    const at = (needle: string) => {
      const index = code.indexOf(needle);
      assert.notEqual(index, -1, needle);
      return index;
    };
    const order = [
      'await transport(',
      // 끊김을 먼저 보고, 그다음에 끝나지 않은 나머지를 본다.
      "response.status === 'incomplete'",
      "response.status !== 'completed'",
      'hasRefusal(',
      'extractOutputText(',
      'JSON.parse(',
      'validateBiblicalResearchDraftResult(',
      'bindBiblicalResearchEvidence(',
    ].map(at);
    for (let i = 1; i < order.length; i += 1) {
      assert.ok(order[i]! > order[i - 1]!, `순서가 어긋났습니다 (${i})`);
    }
  });

  it('끊긴 답에는 묶기까지 가지 않는다', async () => {
    // 묶기가 불리면 터지는 꾸러미를 준다. 불리지 않아야 통과한다.
    const { result } = await runWith({
      status: 'incomplete',
      output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(validDraft()) }] }],
    });
    assert.deepEqual(result, { ok: false, failure: 'model_incomplete' });
  });

  it('실패 결과에는 이름 하나만 남는다', async () => {
    const cases: unknown[] = [
      'JSON이 아닙니다',
      JSON.stringify({ targetDomain: DOMAIN }),
    ];
    for (const text of cases) {
      const { result } = await runWithText(text as string);
      assert.equal(result.ok, false);
      assert.deepEqual(Object.keys(result).sort(), ['failure', 'ok']);
      for (const banned of ['rawError', 'message', 'stack', 'responseBody', 'outputText', 'draft', 'errors', 'status']) {
        assert.equal(banned in result, false, banned);
      }
    }
  });
});

/* ================================================================== */
/* K. 바깥과 닿지 않는다                                                */
/* ================================================================== */

describe('실행 순서 · K. 바깥과 닿지 않는다', () => {
  it('네트워크·열쇠·환경변수를 모른다', () => {
    const code = stripComments(read(RUNTIME));
    for (const banned of [
      'fetch(',
      'AbortController',
      'Deno.env',
      'process.env',
      'createClient',
      'OpenAI(',
      'api.openai.com',
      'Authorization',
      'apiKey',
      'API_KEY',
      'SUPABASE',
      'Deno.serve',
      'headers',
      'endpoint',
      'https://',
    ]) {
      assert.equal(code.includes(banned), false, banned);
    }
  });

  it('시간 값과 API 계열을 여기서 다시 적지 않는다', () => {
    const code = stripComments(read(RUNTIME));
    assert.equal(code.includes('90_000'), false);
    assert.equal(code.includes('90000'), false);
    assert.ok(code.includes('BIBLICAL_RESEARCH_MODEL_TIMEOUT_MS'));
    // API 계열은 정책이 주인이다. 여기서 다시 정하지 않는다.
    assert.equal(code.includes("'responses'"), false);
    assert.equal(code.includes('API_FAMILY'), false);
  });

  it('모델 이름과 형식을 여기서 다시 적지 않는다', () => {
    const code = stripComments(read(RUNTIME));
    assert.equal(code.includes('gpt-'), false);
    assert.equal(code.includes('additionalProperties'), false);
    assert.equal(code.includes('candidatePassages:'), false);
  });

  it('입구가 이 실행 순서를 그대로 가져다 쓴다', () => {
    const handler = read('../../supabase/functions/biblical-researcher/handler.ts');
    assert.ok(handler.includes('executeBiblicalResearchRuntime('));

    // 요청 본문·형식·묶기를 입구에서 다시 만들지 않는다.
    for (const banned of [
      'buildBiblicalResearchResponsesRequest',
      'bindBiblicalResearchEvidence',
      'BIBLICAL_RESEARCH_SCHEMA',
      'json_schema',
    ]) {
      assert.equal(handler.includes(banned), false, banned);
    }
  });
});
