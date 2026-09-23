/**
 * Sol·Astra OpenAI adapter 계약 테스트 — 요청 spec 결정성, criterion 단위 응답 해석 순서, fail-closed.
 *
 * 이 계약의 핵심: 모델은 카드마다 rubric criterion 전부를 개별 판정하고, 카드의 최종 verdict는
 * 절대 내지 않는다. 코드(실행기)가 "criterion 하나라도 fail이면 카드는 fail"로 계산한다.
 *
 * 실제 fetch를 쓰지 않는다(beforeEach에서 fetch를 막아 둔다).
 * 고정 기대값은 구현이 만든 값을 그대로 믿지 않고 이 파일에 별도로 적는다.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { canonicalJson } from '../../supabase/functions/_shared/automatic-scripture-catalog-contract.ts';
import {
  ASTRA_MODEL_ID,
  ASTRA_PROFILE_ID,
  SOL_MODEL_ID,
  SOL_PROFILE_ID,
  THEOLOGY_REVIEW_RUBRIC,
} from '../../supabase/functions/_shared/automatic-scripture-catalog-validator-registry.ts';
import {
  executeAutomaticScriptureCatalogValidation,
} from '../../supabase/functions/_shared/automatic-scripture-catalog-validator-executor.ts';
import type {
  AutomaticValidatorExecutorInput,
  TheologyEvaluationRequest,
} from '../../supabase/functions/_shared/automatic-scripture-catalog-validator-executor.ts';
import type { CandidateGenerationEvaluationPayload, CorpusRegressionPayload, SafetyBoundaryPayload } from '../../supabase/functions/_shared/automatic-scripture-catalog-activation-contract.ts';
import type { ScriptureCatalogCandidate } from '../../supabase/functions/_shared/automatic-scripture-catalog-contract.ts';
import {
  THEOLOGY_EVALUATION_ADAPTER_DOES_NOT_INCLUDE,
  THEOLOGY_EVALUATION_ADAPTER_PERSISTENCE_POLICY,
  THEOLOGY_EVALUATION_ADAPTER_RETRY_POLICY,
  THEOLOGY_EVALUATION_ENVELOPE_KEY,
  THEOLOGY_EVALUATION_INPUT_CONTRACT_VERSION,
  THEOLOGY_EVALUATION_INSTRUCTIONS,
  THEOLOGY_EVALUATION_REQUEST_BODY_FIELDS,
  THEOLOGY_EVALUATION_RUNTIME_CONFIG,
  buildTheologyEvaluationOpenAIRequestSpec,
  interpretTheologyEvaluationOpenAIResponse,
} from '../../supabase/functions/_shared/automatic-scripture-catalog-theology-openai-adapter.ts';
import {
  FIXTURE_DEMAND_WINDOW,
  buildBaselineCatalog,
  makeDemandCells,
  makeExistingDomainCandidate,
  makeNewDomainCandidate,
  resolveKrvPassage,
} from './automatic-scripture-catalog-test-fixtures.ts';

/* ------------------------------------------------------------------ */
/* 실제 실행기로 Sol·Astra 요청을 그대로 받아 고정 fixture로 쓴다            */
/* ------------------------------------------------------------------ */

const passingSafety = (): SafetyBoundaryPayload => ({
  rulesVersion: 'adapter-safety/v1',
  cases: Array.from({ length: 12 }, (_, index) => ({
    caseId: `SAFE-${String(index + 1).padStart(3, '0')}`,
    expectedRoute: 'safety',
    observedRoute: 'safety',
  })),
});
const passingCorpus = (): CorpusRegressionPayload => ({
  corpusVersion: 'adapter-corpus/v1',
  cases: Array.from({ length: 10 }, (_, index) => ({
    caseId: `EVAL-${String(index + 1).padStart(3, '0')}`,
    baseline: { domainMatch: index % 2 === 0, acceptableMatch: index % 3 === 0, safetyFalsePositive: false },
    candidate: { domainMatch: true, acceptableMatch: true, safetyFalsePositive: false },
  })),
});
const passingGeneration = (candidate: ScriptureCatalogCandidate): CandidateGenerationEvaluationPayload => ({
  evidenceArtifactHash: `sart_${'e'.repeat(64)}`,
  cases: candidate.cards.flatMap((card, cardIndex) =>
    Array.from({ length: 3 }, (_, index) => ({ caseId: `GEN-${cardIndex + 1}-${index + 1}`, cardId: card.id, passed: true })),
  ),
});
/** 카드마다 rubric criterion 전부를 pass로 채운, 실행기가 받아들일 모양의 결과. */
const passingCardEvaluations = (candidate: ScriptureCatalogCandidate) =>
  candidate.cards.map((card) => ({
    cardId: card.id,
    criteria: THEOLOGY_REVIEW_RUBRIC.criteria.map((criterion) => ({ criterionId: criterion.criterionId, verdict: 'pass' as const })),
  }));

/** 실행기를 실제로 돌려 Sol·Astra가 받는 진짜 TheologyEvaluationRequest 한 쌍을 잡아낸다. */
async function captureTheologyEvaluationRequests(
  candidateKind: 'existing' | 'new-domain' = 'new-domain',
): Promise<{ sol: TheologyEvaluationRequest; astra: TheologyEvaluationRequest }> {
  const base = buildBaselineCatalog();
  const fixture =
    candidateKind === 'new-domain' ? await makeNewDomainCandidate(base) : await makeExistingDomainCandidate(base);
  const candidate = fixture.candidate;
  let sol: TheologyEvaluationRequest | undefined;
  let astra: TheologyEvaluationRequest | undefined;
  const input: AutomaticValidatorExecutorInput = {
    candidate,
    baseCatalog: base,
    demandWindow: FIXTURE_DEMAND_WINDOW,
    demandCells: makeDemandCells(candidate.demandBinding),
    evaluationCorpusVersion: 'adapter-corpus/v1',
    deterministic: {
      resolvePassageText: resolveKrvPassage,
      evaluateSafetyBoundary: async () => passingSafety(),
      evaluateCorpusRegression: async () => passingCorpus(),
      evaluateCandidateGeneration: async () => passingGeneration(candidate),
    },
    evaluateSol: async (request) => {
      sol = request;
      return passingCardEvaluations(request.candidate);
    },
    evaluateAstra: async (request) => {
      astra = request;
      return passingCardEvaluations(request.candidate);
    },
  };
  const result = await executeAutomaticScriptureCatalogValidation(input);
  assert.equal(result.kind, 'validated');
  assert.ok(sol && astra);
  return { sol: sol!, astra: astra! };
}

let originalFetch: typeof globalThis.fetch | undefined;
beforeEach(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error('adapter 테스트에서 외부 호출을 시도했습니다.');
  }) as typeof globalThis.fetch;
});
afterEach(() => {
  if (originalFetch) globalThis.fetch = originalFetch;
});

/* ------------------------------------------------------------------ */
/* A. 요청 spec                                                        */
/* ------------------------------------------------------------------ */

describe('theology openai adapter · 요청 spec', () => {
  it('본문 필드가 정확히 고정된 열두 개다(temperature·top_p가 없다)', async () => {
    const { sol } = await captureTheologyEvaluationRequests();
    const spec = buildTheologyEvaluationOpenAIRequestSpec(sol);
    assert.deepEqual(Object.keys(spec.body).sort(), [...THEOLOGY_EVALUATION_REQUEST_BODY_FIELDS].sort());
    assert.equal('temperature' in spec.body, false);
    assert.equal('top_p' in spec.body, false);
  });

  it('store·stream·background는 false, tools는 빈 배열, Responses API를 쓴다', async () => {
    const { sol } = await captureTheologyEvaluationRequests();
    const spec = buildTheologyEvaluationOpenAIRequestSpec(sol);
    assert.equal(spec.api, 'responses');
    assert.equal(spec.body.store, false);
    assert.equal(spec.body.stream, false);
    assert.equal(spec.body.background, false);
    assert.deepEqual(spec.body.tools, []);
    assert.equal((spec.body.text as { format: { strict: boolean; type: string } }).format.strict, true);
    assert.equal((spec.body.text as { format: { strict: boolean; type: string } }).format.type, 'json_schema');
  });

  it('자동 재시도·fallback 모델이 정책상 없다', () => {
    assert.equal(THEOLOGY_EVALUATION_ADAPTER_RETRY_POLICY.automaticRetries, 0);
    assert.equal(THEOLOGY_EVALUATION_ADAPTER_RETRY_POLICY.fallbackModelAllowed, false);
    assert.equal(THEOLOGY_EVALUATION_RUNTIME_CONFIG.automaticRetries, 0);
    assert.equal(THEOLOGY_EVALUATION_RUNTIME_CONFIG.fallbackModelAllowed, false);
  });

  it('model은 request.modelId를 그대로 옮긴 것이다(Sol·Astra를 스스로 고르지 않는다)', async () => {
    const { sol, astra } = await captureTheologyEvaluationRequests();
    assert.equal(sol.modelId, SOL_MODEL_ID);
    assert.equal(astra.modelId, ASTRA_MODEL_ID);
    assert.equal(buildTheologyEvaluationOpenAIRequestSpec(sol).body.model, SOL_MODEL_ID);
    assert.equal(buildTheologyEvaluationOpenAIRequestSpec(astra).body.model, ASTRA_MODEL_ID);
  });

  it('Sol·Astra 요청 body는 model 하나만 다르고 나머지는 완전히 같다', async () => {
    const { sol, astra } = await captureTheologyEvaluationRequests();
    const solBody = buildTheologyEvaluationOpenAIRequestSpec(sol).body;
    const astraBody = buildTheologyEvaluationOpenAIRequestSpec(astra).body;
    const { model: solModel, ...solRest } = solBody;
    const { model: astraModel, ...astraRest } = astraBody;
    assert.notEqual(solModel, astraModel);
    assert.equal(canonicalJson(solRest), canonicalJson(astraRest));
  });

  it('같은 요청(깊은 복사본)은 같은 요청 spec을 만든다', async () => {
    const { sol } = await captureTheologyEvaluationRequests();
    const clone = structuredClone(sol);
    const a = buildTheologyEvaluationOpenAIRequestSpec(sol);
    const b = buildTheologyEvaluationOpenAIRequestSpec(clone);
    assert.equal(canonicalJson(a.body), canonicalJson(b.body));
    assert.equal(a.timeoutMs, b.timeoutMs);
    assert.equal(a.api, b.api);
  });

  it('input 문자열은 키를 정렬해 만든다(단순 JSON.stringify로 삽입 순서를 따르지 않는다)', async () => {
    const { sol } = await captureTheologyEvaluationRequests();
    const spec = buildTheologyEvaluationOpenAIRequestSpec(sol);
    const inputString = spec.body.input as string;
    const topLevelKeys = ['baselineDomains', 'candidate', 'contractVersion', 'rubric', 'verifiedPassages'];
    const positions = topLevelKeys.map((key) => inputString.indexOf(`"${key}":`));
    assert.ok(positions.every((position) => position >= 0), positions.join(','));
    assert.deepEqual(positions, [...positions].sort((a, b) => a - b), '최상위 키가 알파벳 순으로 정렬돼 있지 않습니다.');
    // canonicalJson을 안 쓰고 그냥 JSON.stringify했다면(삽입 순서 그대로) 이 문자열과 같아져 버린다.
    const naiveInsertionOrder = JSON.stringify({
      contractVersion: THEOLOGY_EVALUATION_INPUT_CONTRACT_VERSION,
      rubric: sol.rubric,
      candidate: sol.candidate,
      baselineDomains: sol.baselineDomains,
      verifiedPassages: sol.verifiedPassages,
    });
    assert.notEqual(inputString, naiveInsertionOrder);
  });

  it('input에는 rubric 전체·candidate·baselineDomains·verifiedPassages가 그대로 들어 있고, 사용자 원문·API 키는 없다', async () => {
    const { sol } = await captureTheologyEvaluationRequests();
    const spec = buildTheologyEvaluationOpenAIRequestSpec(sol);
    const embedded = JSON.parse(spec.body.input as string);
    assert.equal(embedded.contractVersion, THEOLOGY_EVALUATION_INPUT_CONTRACT_VERSION);
    assert.deepEqual(embedded.rubric, THEOLOGY_REVIEW_RUBRIC);
    assert.deepEqual(embedded.candidate, sol.candidate);
    assert.deepEqual(embedded.baselineDomains, sol.baselineDomains);
    assert.deepEqual(embedded.verifiedPassages, sol.verifiedPassages);
    const raw = JSON.stringify(embedded);
    for (const forbidden of ['sk-', 'situationText', 'userText', 'apiKey', 'OPENAI_API_KEY', 'password']) {
      assert.equal(raw.includes(forbidden), false, forbidden);
    }
  });

  it('instructions는 고정 문구이고, criterion 단위 판정과 담는 자리를 지시하며, 카드 최종 verdict는 내지 말라고 못 박는다', async () => {
    const { sol, astra } = await captureTheologyEvaluationRequests();
    const solSpec = buildTheologyEvaluationOpenAIRequestSpec(sol);
    const astraSpec = buildTheologyEvaluationOpenAIRequestSpec(astra);
    assert.equal(solSpec.body.instructions, THEOLOGY_EVALUATION_INSTRUCTIONS);
    assert.equal(astraSpec.body.instructions, THEOLOGY_EVALUATION_INSTRUCTIONS);
    const text = solSpec.body.instructions as string;
    assert.ok(text.includes(THEOLOGY_EVALUATION_ENVELOPE_KEY));
    assert.ok(text.includes('criterion'), 'criterion 단위 판정을 지시해야 합니다.');
    assert.ok(text.includes('카드 전체의 최종 판정'), '카드 최종 verdict를 내지 말라는 지시가 있어야 합니다.');
    // 지시문 자체에 후보 카드 내용을 되풀이해 적지 않는다(자료는 input에만 있다).
    for (const card of sol.candidate.cards) {
      assert.equal(text.includes(card.id), false);
    }
  });

  it('답의 모양은 카드마다 criteria 배열만 요구하고, 카드 최종 verdict를 담을 자리가 없다(strict schema)', async () => {
    const { sol } = await captureTheologyEvaluationRequests();
    const spec = buildTheologyEvaluationOpenAIRequestSpec(sol);
    const schema = (spec.body.text as { format: { schema: unknown } }).format.schema as {
      properties: Record<string, unknown>;
      required: string[];
      additionalProperties: boolean;
    };
    assert.deepEqual(schema.required, [THEOLOGY_EVALUATION_ENVELOPE_KEY]);
    assert.equal(schema.additionalProperties, false);

    const cardNode = (schema.properties[THEOLOGY_EVALUATION_ENVELOPE_KEY] as { items: Record<string, unknown> }).items as {
      properties: Record<string, unknown>;
      required: string[];
      additionalProperties: boolean;
    };
    // 카드 자리에는 cardId·criteria만 있다. verdict라는 이름의 카드 최종 판정 자리는 없다.
    assert.deepEqual(Object.keys(cardNode.properties).sort(), ['cardId', 'criteria']);
    assert.deepEqual(cardNode.required.sort(), ['cardId', 'criteria']);
    assert.equal(cardNode.additionalProperties, false);
    assert.equal('verdict' in cardNode.properties, false, '카드 자리에 최종 verdict가 있으면 안 됩니다.');

    const cardIdNode = cardNode.properties.cardId as { enum: string[] };
    assert.deepEqual(cardIdNode.enum, sol.candidate.cards.map((card) => card.id));

    const criterionNode = (cardNode.properties.criteria as { items: Record<string, unknown> }).items as {
      properties: { criterionId: { enum: string[] }; verdict: { enum: string[] } };
      required: string[];
      additionalProperties: boolean;
    };
    assert.deepEqual(criterionNode.properties.criterionId.enum, sol.rubric.criteria.map((criterion) => criterion.criterionId));
    assert.deepEqual(criterionNode.properties.verdict.enum, ['pass', 'fail']);
    assert.deepEqual(criterionNode.required.sort(), ['criterionId', 'verdict']);
    assert.equal(criterionNode.additionalProperties, false);
  });

  it('모델 원문·거절 문구·오류 메시지·설명·confidence·카드 최종 verdict를 남기지 않기로 정해 두었다', () => {
    assert.deepEqual(THEOLOGY_EVALUATION_ADAPTER_PERSISTENCE_POLICY, {
      rawResponsePersisted: false,
      rawOutputTextPersisted: false,
      refusalTextPersisted: false,
      providerErrorMessagePersisted: false,
      explanationRequested: false,
      explanationPersisted: false,
      confidencePersisted: false,
      cardFinalVerdictRequestedFromModel: false,
    });
    assert.ok(THEOLOGY_EVALUATION_ADAPTER_DOES_NOT_INCLUDE.some((item) => item.includes('요청을 보내는')));
    assert.ok(THEOLOGY_EVALUATION_ADAPTER_DOES_NOT_INCLUDE.some((item) => item.includes('카드 최종 verdict')));
  });

  it('이 파일은 fetch·Deno·환경변수·console을 쓰지 않는다', async () => {
    const fs = await import('node:fs');
    const source = fs.readFileSync(
      new URL('../../supabase/functions/_shared/automatic-scripture-catalog-theology-openai-adapter.ts', import.meta.url),
      'utf8',
    );
    const code = source.split('\n').filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line)).join('\n');
    for (const token of ['fetch(', 'Deno.', 'process.env', 'console.', "from 'openai'", 'XMLHttpRequest', 'createClient(']) {
      assert.equal(code.includes(token), false, token);
    }
  });
});

/* ------------------------------------------------------------------ */
/* B. 응답 해석 — criterion 단위                                          */
/* ------------------------------------------------------------------ */

const CARD_IDS = ['SC-901', 'SC-902', 'SC-903'];
const CRITERION_IDS = ['crit-context', 'crit-citation', 'crit-domain'];

const completed = (outputText: string, extra: Record<string, unknown> = {}) => ({
  status: 'completed',
  output: [{ type: 'message', content: [{ type: 'output_text', text: outputText }] }],
  ...extra,
});

const envelope = (cardEvaluations: unknown[]) => JSON.stringify({ [THEOLOGY_EVALUATION_ENVELOPE_KEY]: cardEvaluations });
const criteria = (verdicts: readonly ('pass' | 'fail')[]) =>
  CRITERION_IDS.map((criterionId, index) => ({ criterionId, verdict: verdicts[index] }));
const allPassCardEvaluations = () => CARD_IDS.map((cardId) => ({ cardId, criteria: criteria(['pass', 'pass', 'pass']) }));
const interpret = (response: unknown, cardIds: readonly string[] = CARD_IDS, criterionIds: readonly string[] = CRITERION_IDS) =>
  interpretTheologyEvaluationOpenAIResponse(response, cardIds, criterionIds);

describe('theology openai adapter · 응답 해석 · 정상', () => {
  it('정상 응답은 success와 카드·criterion 순서 그대로의 판정을 낸다', () => {
    const cardEvaluations = allPassCardEvaluations();
    const outcome = interpret(completed(envelope(cardEvaluations)));
    assert.deepEqual(outcome, { outcome: 'success', cardEvaluations });
  });

  it('criterion 하나가 fail이어도(카드 전체가 아니라) 기술적 실패가 아니라 성공이다', () => {
    const mixed = [
      { cardId: CARD_IDS[0], criteria: criteria(['pass', 'fail', 'pass']) },
      { cardId: CARD_IDS[1], criteria: criteria(['fail', 'fail', 'fail']) },
      { cardId: CARD_IDS[2], criteria: criteria(['pass', 'pass', 'pass']) },
    ];
    const outcome = interpret(completed(envelope(mixed)));
    assert.equal(outcome.outcome, 'success');
    assert.deepEqual(outcome.outcome === 'success' ? outcome.cardEvaluations : null, mixed);
  });

  it('동적 카드·criterion 집합이 바뀌어도(카드 1장, criterion 1개·5개) 그 순서로 정확히 맞춰 읽는다', () => {
    for (const ids of [['SC-001'], ['SC-011', 'SC-012', 'SC-013', 'SC-014', 'SC-015']]) {
      for (const critIds of [['only-one'], ['c1', 'c2', 'c3', 'c4', 'c5']]) {
        const items = ids.map((cardId) => ({ cardId, criteria: critIds.map((criterionId) => ({ criterionId, verdict: 'pass' as const })) }));
        const outcome = interpret(completed(envelope(items)), ids, critIds);
        assert.deepEqual(outcome, { outcome: 'success', cardEvaluations: items });
      }
    }
  });

  it('success 결과에는 카드마다 cardId·criteria만 있고, 각 criterion에는 criterionId·verdict만 있다 — 카드 최종 verdict는 없다', () => {
    const cardEvaluations = allPassCardEvaluations();
    const outcome = interpret(completed(envelope(cardEvaluations)));
    assert.deepEqual(Object.keys(outcome).sort(), ['cardEvaluations', 'outcome']);
    if (outcome.outcome === 'success') {
      for (const card of outcome.cardEvaluations) {
        assert.deepEqual(Object.keys(card).sort(), ['cardId', 'criteria']);
        assert.equal('verdict' in card, false, '카드에 최종 verdict가 있으면 안 됩니다.');
        for (const item of card.criteria) assert.deepEqual(Object.keys(item).sort(), ['criterionId', 'verdict']);
      }
    }
  });
});

describe('theology openai adapter · 응답 해석 · 기술적 실패', () => {
  it('객체가 아니면 provider_error다', () => {
    for (const bad of [null, undefined, 'text', 42, [], true]) {
      assert.deepEqual(interpret(bad), { outcome: 'provider_error' });
    }
  });

  it('error가 담겨 있으면 completed여도 provider_error다', () => {
    const outcome = interpret({ ...completed(envelope(allPassCardEvaluations())), error: { message: '문제 발생' } });
    assert.deepEqual(outcome, { outcome: 'provider_error' });
  });

  it('error와 status:incomplete가 함께 있으면 오류가 먼저다(incomplete가 아니라 provider_error)', () => {
    const outcome = interpret({ status: 'incomplete', error: { message: '문제 발생' }, output: [] });
    assert.deepEqual(outcome, { outcome: 'provider_error' });
  });

  it('incomplete는 text가 있어도 incomplete다', () => {
    const outcome = interpret({ ...completed(envelope(allPassCardEvaluations())), status: 'incomplete' });
    assert.deepEqual(outcome, { outcome: 'incomplete' });
  });

  it('completed·incomplete가 아닌 상태는 모두 provider_error다', () => {
    for (const status of ['failed', 'cancelled', 'queued', 'in_progress', undefined, 'weird']) {
      const outcome = interpret({ ...completed(envelope(allPassCardEvaluations())), status });
      assert.deepEqual(outcome, { outcome: 'provider_error' }, String(status));
    }
  });

  it('거절이 섞여 있으면(정상 글과 함께 와도) model_refusal이다', () => {
    const withRefusalOnly = {
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'refusal', refusal: '판정할 수 없습니다' }] }],
    };
    assert.deepEqual(interpret(withRefusalOnly), { outcome: 'model_refusal' });

    const withBoth = {
      status: 'completed',
      output: [
        {
          type: 'message',
          content: [{ type: 'refusal', refusal: '판정할 수 없습니다' }, { type: 'output_text', text: envelope(allPassCardEvaluations()) }],
        },
      ],
    };
    assert.deepEqual(interpret(withBoth), { outcome: 'model_refusal' });
  });

  it('빈 응답(output_text 없음·빈 문자열·공백)은 empty_response다', () => {
    assert.deepEqual(interpret({ status: 'completed', output: [] }), { outcome: 'empty_response' });
    assert.deepEqual(interpret(completed('')), { outcome: 'empty_response' });
    assert.deepEqual(interpret(completed('   \n  ')), { outcome: 'empty_response' });
  });

  it('JSON이 아니면 json_parse_failed다', () => {
    assert.deepEqual(interpret(completed('이것은 JSON이 아닙니다')), { outcome: 'json_parse_failed' });
  });

  it('코드 블록으로 감싼 JSON은 벗기지 않고 그대로 json_parse_failed다', () => {
    const fenced = '```json\n' + envelope(allPassCardEvaluations()) + '\n```';
    assert.deepEqual(interpret(completed(fenced)), { outcome: 'json_parse_failed' });
  });
});

describe('theology openai adapter · 응답 해석 · 카드 단위 모양·차례 위반', () => {
  it('담는 자리 밖에 다른 것이 함께 오면 무효다', () => {
    const withExtra = JSON.stringify({ [THEOLOGY_EVALUATION_ENVELOPE_KEY]: allPassCardEvaluations(), extra: true });
    assert.equal(interpret(completed(withExtra)).outcome, 'response_contract_invalid');
  });

  it('담는 자리 이름이 다르면 무효다', () => {
    const wrongKey = JSON.stringify({ evaluations: allPassCardEvaluations() });
    assert.equal(interpret(completed(wrongKey)).outcome, 'response_contract_invalid');
  });

  it('카드에 최종 verdict를 끼워 넣으면(모델이 카드 판정을 스스로 냈다면) 무효다', () => {
    const withCardVerdict = [
      { cardId: CARD_IDS[0], criteria: criteria(['pass', 'pass', 'pass']), verdict: 'pass' },
      ...CARD_IDS.slice(1).map((cardId) => ({ cardId, criteria: criteria(['pass', 'pass', 'pass']) })),
    ];
    assert.equal(interpret(completed(envelope(withCardVerdict))).outcome, 'response_contract_invalid');
  });

  it('카드가 누락되면 무효다(앞쪽이 빠져도, 뒤쪽이 빠져도)', () => {
    const all = allPassCardEvaluations();
    assert.equal(interpret(completed(envelope(all.slice(1)))).outcome, 'response_contract_invalid');
    // 앞쪽 카드들은 순서대로 정확히 맞는 채 뒤쪽만 빠진 경우. 개수 자체를 반드시 대조해야 잡힌다.
    assert.equal(interpret(completed(envelope(all.slice(0, -1)))).outcome, 'response_contract_invalid');
  });

  it('카드가 중복되면 무효다', () => {
    const all = allPassCardEvaluations();
    const duplicated = [all[0], all[0], all[2]];
    assert.equal(interpret(completed(envelope(duplicated))).outcome, 'response_contract_invalid');
  });

  it('카드 순서가 뒤바뀌면 무효다', () => {
    const reversed = [...allPassCardEvaluations()].reverse();
    assert.equal(interpret(completed(envelope(reversed))).outcome, 'response_contract_invalid');
  });

  it('후보 밖 카드 id가 오면 무효다', () => {
    const outside = [{ cardId: 'SC-999', criteria: criteria(['pass', 'pass', 'pass']) }, ...allPassCardEvaluations().slice(1)];
    assert.equal(interpret(completed(envelope(outside))).outcome, 'response_contract_invalid');
  });
});

describe('theology openai adapter · 응답 해석 · criterion 단위 모양·차례 위반', () => {
  it('criterion이 누락되면 무효다(앞쪽이 빠져도, 뒤쪽이 빠져도)', () => {
    const missingFirst = [
      { cardId: CARD_IDS[0], criteria: criteria(['pass', 'pass', 'pass']).slice(1) },
      ...allPassCardEvaluations().slice(1),
    ];
    assert.equal(interpret(completed(envelope(missingFirst))).outcome, 'response_contract_invalid');
    // 앞쪽 criterion들은 순서대로 정확히 맞는 채 마지막 하나만 빠진 경우. 차례 비교가 짧은 배열
    // 안에서는 전부 들어맞아 버리므로, criterion 개수 자체를 반드시 대조해야 잡힌다.
    const missingLast = [
      { cardId: CARD_IDS[0], criteria: criteria(['pass', 'pass', 'pass']).slice(0, -1) },
      ...allPassCardEvaluations().slice(1),
    ];
    assert.equal(interpret(completed(envelope(missingLast))).outcome, 'response_contract_invalid');
  });

  it('criterion이 더 많으면(여분 criterion) 무효다', () => {
    const extra = [
      { cardId: CARD_IDS[0], criteria: [...criteria(['pass', 'pass', 'pass']), { criterionId: 'crit-extra', verdict: 'pass' }] },
      ...allPassCardEvaluations().slice(1),
    ];
    assert.equal(interpret(completed(envelope(extra))).outcome, 'response_contract_invalid');
  });

  it('criterion이 중복되면 무효다', () => {
    const duplicated = [
      { cardId: CARD_IDS[0], criteria: [criteria(['pass', 'pass', 'pass'])[0], criteria(['pass', 'pass', 'pass'])[0], criteria(['pass', 'pass', 'pass'])[2]] },
      ...allPassCardEvaluations().slice(1),
    ];
    assert.equal(interpret(completed(envelope(duplicated))).outcome, 'response_contract_invalid');
  });

  it('criterion 순서가 뒤바뀌면 무효다', () => {
    const reordered = [
      { cardId: CARD_IDS[0], criteria: [...criteria(['pass', 'pass', 'pass'])].reverse() },
      ...allPassCardEvaluations().slice(1),
    ];
    assert.equal(interpret(completed(envelope(reordered))).outcome, 'response_contract_invalid');
  });

  it('잘못된(rubric에 없는) criterionId가 오면 무효다', () => {
    const wrongId = [
      { cardId: CARD_IDS[0], criteria: [{ criterionId: 'not-a-real-criterion', verdict: 'pass' }, ...criteria(['pass', 'pass']).slice(1)] },
      ...allPassCardEvaluations().slice(1),
    ];
    assert.equal(interpret(completed(envelope(wrongId))).outcome, 'response_contract_invalid');
  });

  it('criterion 항목에 여분 필드(설명 등)가 있으면 무효다', () => {
    const withExplanation = [
      {
        cardId: CARD_IDS[0],
        criteria: [{ criterionId: CRITERION_IDS[0], verdict: 'pass', explanation: '왜냐하면' }, ...criteria(['pass', 'pass']).slice(1)],
      },
      ...allPassCardEvaluations().slice(1),
    ];
    assert.equal(interpret(completed(envelope(withExplanation))).outcome, 'response_contract_invalid');
  });

  it('pass·fail 이외의 criterion 판정은 무효다', () => {
    const weird = [
      { cardId: CARD_IDS[0], criteria: [{ criterionId: CRITERION_IDS[0], verdict: 'maybe' }, ...criteria(['pass', 'pass']).slice(1)] },
      ...allPassCardEvaluations().slice(1),
    ];
    assert.equal(interpret(completed(envelope(weird))).outcome, 'response_contract_invalid');
  });
});

describe('theology openai adapter · 바깥 호출 부재', () => {
  it('fetch를 막아 두어도 요청 spec 생성과 응답 해석이 그대로 돈다', async () => {
    const { sol } = await captureTheologyEvaluationRequests();
    assert.doesNotThrow(() => buildTheologyEvaluationOpenAIRequestSpec(sol));
    assert.doesNotThrow(() => interpret(completed(envelope(allPassCardEvaluations()))));
  });
});
