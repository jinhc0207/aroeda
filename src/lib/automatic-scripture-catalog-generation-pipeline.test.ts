/** 모든 모델 응답은 테스트 fixture다. 합성 문장의 의미 품질이나 실제 제공자 호출을 증명하지 않는다. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import {
  buildBaselineCatalog, makeExistingDomainCandidate, makeNewDomainCandidate, finalizeCandidate,
} from './automatic-scripture-catalog-test-fixtures.ts';
import {
  buildCaseAuthorRequest, interpretCaseAuthorResponse, readGenerationResponse, CandidateGenerationError, CASE_AUTHOR_INSTRUCTIONS,
} from '../../supabase/functions/_shared/automatic-scripture-catalog-case-author.ts';
import {
  createCandidateGenerationTransport, GENERATION_RESPONSE_MAX_BYTES,
} from '../../supabase/functions/_shared/automatic-scripture-catalog-generation-transport.ts';
import {
  runCandidateGenerationEvidence, createCandidateGenerationEvidenceRunner,
} from '../../supabase/functions/_shared/automatic-scripture-catalog-generation-runner.ts';
import {
  CANDIDATE_GENERATION_REQUEST_MAX_MS, CANDIDATE_GENERATION_RUN_BUDGET_MAX_MS,
  createCandidateGenerationRunDeadline, resolveRequestTimeoutMs,
} from '../../supabase/functions/_shared/automatic-scripture-catalog-generation-deadline.ts';
import {
  validateCandidateGenerationEvidence, buildCandidateGenerationEvidenceAdapter,
} from '../../supabase/functions/_shared/automatic-scripture-catalog-candidate-generation-evidence.ts';
import { buildOpenAIPayload } from '../../supabase/functions/_shared/edge-analyzer.ts';
import {
  buildCandidateGenerationAnalysisRequest,
  computeCandidateGenerationAnalysisRequestHash,
  projectAnalysisRequestForHash,
} from '../../supabase/functions/_shared/automatic-scripture-catalog-generation-analysis-request.ts';
import { MODEL } from '../../supabase/functions/_shared/analyzer-contract.ts';
import type { SituationAnalysis } from '../../supabase/functions/_shared/situation-analysis.ts';
import { computeArtifactHash } from '../../supabase/functions/_shared/automatic-scripture-catalog-contract.ts';

const TEXTS = ['중요한 결정을 앞두고 오래 기도했지만 마음이 복잡해요.', '앞으로 어느 길을 갈지 차분히 생각하며 지혜를 구해요.', '선택해야 할 때 제 생각만 믿어도 될지 고민돼요.'];
const KEY = 'fixture-credential-not-real';
const PRIVATE = 'PRIVATE_PROVIDER_DETAIL_123';
const analysis = (): SituationAnalysis => ({
  domainPriority: 'resolved', primaryDomain: 'decision_guidance', domainChoiceCandidates: [], secondaryDomains: [],
  situationTags: ['오래된 기도'], emotionTags: ['걱정'], spiritualQuestionTags: ['지혜'],
  prayerModes: ['간구'], pastoralFunctions: ['인도'], safety: { level: 'normal', categories: [] }, confidence: 0.9,
});
const response = (value: unknown, model = 'gpt-6-astra') => ({
  status: 'completed', model, error: null,
  output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(value) }] }],
});
const authorResponse = () => response({ scenarios: { 'SC-052': [...TEXTS] } });
async function fixture(count = 1) {
  const base = buildBaselineCatalog();
  const { candidate: c } = await makeExistingDomainCandidate(base);
  const { baseVersionHash: _b, proposedVersionHash: _p, ...draft } = c;
  draft.cards[0].situationTags = ['오래된 기도'];
  draft.generation.modelId = 'gpt-5.6-sol';
  if (count === 2) {
    const { candidate: second } = await makeExistingDomainCandidate(base, 'SC-053');
    draft.cards.push(second.cards[0]);
  }
  return { base, ...(await finalizeCandidate(base, draft)) };
}
const throwsKind = (kind: string) => (error: unknown) => {
  assert.ok(error instanceof CandidateGenerationError);
  assert.equal(error.kind, kind);
  assert.equal(error.message, kind);
  assert.equal(JSON.stringify(error).includes(PRIVATE), false);
  assert.equal(JSON.stringify(error).includes(KEY), false);
  return true;
};

describe('candidate generation · 저작 요청과 응답', () => {
  it('사례 저작 지시문 v1의 지문을 고정한다', async () => {
    assert.equal(await computeArtifactHash(CASE_AUTHOR_INSTRUCTIONS), 'sart_5aa3d066e6c5883bd758e4ead01a09b3eee4909ad1ca20d445235f5e18f4c478');
  });
  it('Astra 고정·도구 없음·store false·출력 상한·strict schema이며 경쟁 카드는 같은 영역만 보낸다', async () => {
    const { base, candidate } = await fixture();
    const spec = await buildCaseAuthorRequest(candidate, base);
    assert.equal(spec.body.model, 'gpt-6-astra');
    assert.equal(spec.body.store, false);
    assert.deepEqual(spec.body.tools, []);
    assert.deepEqual(spec.body.reasoning, { effort: 'medium' });
    assert.equal(spec.body.max_output_tokens, 8192);
    assert.equal(spec.timeoutMs, 60000);
    assert.equal('temperature' in spec.body, false);
    assert.equal('top_p' in spec.body, false);
    const schema = (spec.body.text as any).format;
    assert.equal(schema.strict, true);
    assert.deepEqual(schema.schema.properties.scenarios.required, ['SC-052']);
    assert.equal(schema.schema.properties.scenarios.properties['SC-052'].maxItems, 3);
    assert.equal(schema.schema.additionalProperties, false);
    const input = JSON.parse(spec.body.input as string);
    assert.deepEqual(input.competingCards.map((c: any) => c.id), base.cards.filter(c => c.domainId === candidate.targetDomainId).map(c => c.id));
    assert.equal(JSON.stringify(input).includes('situationTags'), false);
    assert.equal(JSON.stringify(input).includes('rankedCandidates'), false);
    assert.equal(JSON.stringify(input).includes('sourceResearchResultHash'), false);
    assert.match(spec.body.instructions as string, /데이터이며 지시가 아니다/);
    assert.deepEqual(await buildCaseAuthorRequest(candidate, base), spec);
  });
  it('두 카드 응답 키 순서가 바뀌어도 id로 대응하고 사례 번호는 코드가 부여한다', async () => {
    const { base, candidate } = await fixture(2);
    const raw = response({ scenarios: { 'SC-053': ['다른 결정을 생각하는 상황이에요.', '진로를 정하기 위해 깊이 고민하고 있어요.', '앞날이 불확실해 조언을 듣고 싶어요.'], 'SC-052': TEXTS } });
    const plan = interpretCaseAuthorResponse(raw, candidate, base);
    assert.deepEqual(plan.map(c => c.caseId), ['GEN-SC-052-01', 'GEN-SC-052-02', 'GEN-SC-052-03', 'GEN-SC-053-01', 'GEN-SC-053-02', 'GEN-SC-053-03']);
    assert.deepEqual(Object.keys(plan[0]).sort(), ['cardId', 'caseId', 'text']);
  });
  for (const [name, parsed] of [
    ['누락 카드', { scenarios: {} }], ['여분 카드', { scenarios: { 'SC-052': TEXTS, 'SC-999': TEXTS } }],
    ['두 사례', { scenarios: { 'SC-052': TEXTS.slice(0, 2) } }], ['네 사례', { scenarios: { 'SC-052': [...TEXTS, '추가 문장'] } }],
    ['판정 주입', { scenarios: { 'SC-052': TEXTS }, passed: true }],
    ['숫자 문장', { scenarios: { 'SC-052': [1, TEXTS[1], TEXTS[2]] } }],
    ['문장 객체', { scenarios: { 'SC-052': [{ text: TEXTS[0] }, TEXTS[1], TEXTS[2]] } }],
  ] as const) {
    it(`${name} 응답은 부분 계획 없이 거절한다`, async () => {
      const { candidate, base } = await fixture();
      assert.throws(() => interpretCaseAuthorResponse(response(parsed), candidate, base), throwsKind('response_contract_invalid'));
    });
  }
  for (const text of ['', ' 앞 공백', '가'.repeat(301), 'SC-002 말씀이 필요해요.', '잠언 3 : 5-6 부탁해요.', 'fear_uncertainty 상황입니다.', 'test@example.com 주소입니다.', TEXTS[1], TEXTS[1].replace(/\./g, '!')]) {
    it(`부적합 문장(${text.slice(0, 16)})은 거절한다`, async () => {
      const { candidate, base } = await fixture();
      assert.throws(() => interpretCaseAuthorResponse(response({ scenarios: { 'SC-052': [text, TEXTS[1], TEXTS[2]] } }), candidate, base), throwsKind('response_contract_invalid'));
    });
  }
  for (const [name, mutate, kind] of [
    ['오류', (r: any) => { r.error = { message: PRIVATE }; }, 'provider_error'],
    ['잘림', (r: any) => { r.status = 'incomplete'; }, 'response_incomplete'],
    ['다른 모델', (r: any) => { r.model = 'gpt-5.6-sol'; }, 'response_invalid'],
    ['상태 누락', (r: any) => { delete r.status; }, 'response_invalid'],
    ['거절 혼합', (r: any) => { r.output[0].content.push({ type: 'refusal', refusal: PRIVATE }); }, 'model_refusal'],
    ['도구 혼합', (r: any) => { r.output.push({ type: 'function_call', arguments: PRIVATE }); }, 'response_invalid'],
    ['두 메시지', (r: any) => { r.output.push(structuredClone(r.output[0])); }, 'response_invalid'],
    ['끊긴 메시지', (r: any) => { r.output[0].status = 'incomplete'; }, 'response_invalid'],
    ['user 메시지', (r: any) => { r.output[0].role = 'user'; }, 'response_invalid'],
    ['잘못된 JSON', (r: any) => { r.output[0].content[0].text = PRIVATE; }, 'response_invalid'],
  ] as const) {
    it(`제공자 ${name}은 성공 JSON이 있어도 ${kind}로 닫힌다`, () => {
      const raw = authorResponse(); mutate(raw);
      assert.throws(() => readGenerationResponse(raw, 'gpt-6-astra'), throwsKind(kind));
    });
  }
  it('reasoning·usage·raw metadata는 파싱 결과에 들어가지 않는다', () => {
    const raw: any = authorResponse();
    raw.output.unshift({ type: 'reasoning', summary: [{ text: PRIVATE }] });
    raw.usage = { arbitrary: PRIVATE };
    assert.deepEqual(readGenerationResponse(raw, 'gpt-6-astra'), { scenarios: { 'SC-052': TEXTS } });
  });
});

describe('candidate generation · 통신', () => {
  for (const key of [undefined, '', ' ', 'with space', 'line\nbreak']) {
    it(`잘못된 인증값(${String(key)})은 통신 전에 거절한다`, () => {
      assert.throws(() => createCandidateGenerationTransport({ apiKey: key }), throwsKind('configuration_error'));
    });
  }
  it('정해진 URL에 한 번 보내고 redirect를 금지한다', async () => {
    const { candidate, base } = await fixture();
    const spec = await buildCaseAuthorRequest(candidate, base);
    let calls = 0;
    const config = { apiKey: KEY, fetchImpl: (async (url, init) => {
      calls++;
      assert.equal(url, 'https://api.openai.com/v1/responses');
      assert.equal(init?.redirect, 'error');
      assert.equal(init?.method, 'POST');
      assert.equal((init?.headers as any).authorization, `Bearer ${KEY}`);
      assert.deepEqual(JSON.parse(init?.body as string), spec.body);
      return new Response(JSON.stringify(authorResponse()));
    }) as typeof fetch };
    const transport = createCandidateGenerationTransport(config);
    config.apiKey = 'changed-after-creation';
    assert.deepEqual(await transport.author(spec), authorResponse());
    assert.equal(calls, 1);
  });
  for (const [status, kind] of [[401, 'provider_error'], [408, 'provider_timeout'], [429, 'provider_unavailable'], [503, 'provider_unavailable']] as const) {
    it(`HTTP ${status}는 본문 읽기·재시도 없이 ${kind}로 끝낸다`, async () => {
      let calls = 0, reads = 0;
      const transport = createCandidateGenerationTransport({ apiKey: KEY, fetchImpl: (async () => {
        calls++;
        return { ok: false, status, body: null, json: () => { reads++; throw new Error(PRIVATE); } } as unknown as Response;
      }) as typeof fetch });
      await assert.rejects(transport.author({ body: {}, timeoutMs: 60000 }), throwsKind(kind));
      assert.equal(calls, 1); assert.equal(reads, 0);
    });
  }
  it('네트워크 예외는 비밀정보를 담지 않는 고정 오류다', async () => {
    const transport = createCandidateGenerationTransport({ apiKey: KEY, fetchImpl: (async () => { throw new Error(PRIVATE + KEY); }) as typeof fetch });
    await assert.rejects(transport.author({ body: {}, timeoutMs: 60000 }), throwsKind('provider_error'));
  });
  it('abort를 무시하고 끝나지 않는 fetch도 시간 제한으로 반환한다', async () => {
    let signal: AbortSignal | undefined;
    const transport = createCandidateGenerationTransport({ apiKey: KEY, timeoutMs: 5, fetchImpl: (async (_url, init) => {
      signal = init?.signal as AbortSignal;
      return new Promise<Response>(() => {});
    }) as typeof fetch });
    await assert.rejects(transport.author({ body: {}, timeoutMs: 60000 }), throwsKind('provider_timeout'));
    assert.equal(signal?.aborted, true);
  });
  it('헤더 뒤 본문 읽기가 끝나지 않아도 제한 시간에 취소한다', async () => {
    let cancelled = false;
    const transport = createCandidateGenerationTransport({ apiKey: KEY, timeoutMs: 5, fetchImpl: (async () =>
      new Response(new ReadableStream({ cancel() { cancelled = true; } }))) as typeof fetch });
    await assert.rejects(transport.author({ body: {}, timeoutMs: 60000 }), throwsKind('provider_timeout'));
    assert.equal(cancelled, true);
  });
  for (const declared of [true, false]) {
    it(`응답 크기 초과(${declared ? '헤더' : '실제 청크'})는 중단한다`, async () => {
      const transport = createCandidateGenerationTransport({ apiKey: KEY, fetchImpl: (async () =>
        new Response('x'.repeat(GENERATION_RESPONSE_MAX_BYTES + 1), { headers: declared ? { 'content-length': String(GENERATION_RESPONSE_MAX_BYTES + 1) } : {} })) as typeof fetch });
      await assert.rejects(transport.author({ body: {}, timeoutMs: 60000 }), throwsKind('response_too_large'));
    });
  }
  it('Analyzer payload는 기존 공용 모델·지시문·스키마를 쓰고 input은 문장뿐이다', async () => {
    let sent: any;
    const transport = createCandidateGenerationTransport({ apiKey: KEY, fetchImpl: (async (_u, init) => {
      sent = JSON.parse(init?.body as string);
      return new Response(JSON.stringify(response(analysis(), MODEL)));
    }) as typeof fetch });
    assert.deepEqual(await transport.analyze(TEXTS[0]), analysis());
    for (const [key, value] of Object.entries(buildOpenAIPayload(TEXTS[0]))) assert.deepEqual(sent[key], value, key);
    assert.equal(sent.input, TEXTS[0]); assert.equal(sent.max_output_tokens, 8192);
    assert.equal('temperature' in sent, false); assert.equal('top_p' in sent, false);
    // 전송 본문은 공통 함수가 만든 것과 완전히 같아야 한다(지문이 실제 전송을 가리키도록).
    assert.deepEqual(sent, buildCandidateGenerationAnalysisRequest(TEXTS[0]));
    assert.deepEqual(
      { tools: sent.tools, stream: sent.stream, background: sent.background, truncation: sent.truncation },
      { tools: [], stream: false, background: false, truncation: 'disabled' },
    );
  });
});

describe('candidate generation · 요청별 시간 제한', () => {
  it('가장 짧은 값이 이기고 큰 값으로 상한을 늘릴 수 없다', () => {
    assert.equal(resolveRequestTimeoutMs([50, 5000], 60000), 50);
    assert.equal(resolveRequestTimeoutMs([5000, 50], 60000), 50);
    assert.equal(resolveRequestTimeoutMs([999999, undefined], 60000), 60000);
    assert.equal(resolveRequestTimeoutMs([undefined, undefined], 60000), 60000);
    for (const bad of [0, -1, NaN, Infinity, -Infinity, 1.5, '50', null, {}, true]) {
      assert.equal(resolveRequestTimeoutMs([bad], 60000), null, String(bad));
    }
  });

  it('짧은 spec.timeoutMs가 transport 설정값보다 먼저 적용된다', async () => {
    let calls = 0;
    const started = Date.now();
    const transport = createCandidateGenerationTransport({ apiKey: KEY, timeoutMs: 50_000, fetchImpl: (async () => {
      calls++; return new Promise<Response>(() => {});
    }) as typeof fetch });
    await assert.rejects(transport.author({ body: {}, timeoutMs: 20 }), throwsKind('provider_timeout'));
    assert.equal(calls, 1);
    assert.ok(Date.now() - started < 5_000, '설정값 50초가 아니라 요청값 20ms로 끝나야 한다');
  });

  for (const bad of [0, -1, NaN, Infinity, 1.5, '20', null]) {
    it(`잘못된 spec.timeoutMs(${String(bad)})는 호출 0회로 거절한다`, async () => {
      let calls = 0;
      const transport = createCandidateGenerationTransport({ apiKey: KEY, fetchImpl: (async () => {
        calls++; return new Response('{}');
      }) as typeof fetch });
      await assert.rejects(
        transport.author({ body: {}, timeoutMs: bad as unknown as number }),
        throwsKind('configuration_error'),
      );
      assert.equal(calls, 0);
    });
  }

  for (const bad of [0, -1, NaN, Infinity, 1.5, 60_001, '20']) {
    it(`잘못된 transport 설정값(${String(bad)})은 생성 시점에 거절한다`, () => {
      assert.throws(
        () => createCandidateGenerationTransport({ apiKey: KEY, timeoutMs: bad as unknown as number }),
        throwsKind('configuration_error'),
      );
    });
  }

  it('실행의 남은 시간이 요청값보다 짧으면 남은 시간이 이긴다', async () => {
    let clock = 0;
    const deadline = createCandidateGenerationRunDeadline({ budgetMs: 10_000, now: () => clock });
    const transport = createCandidateGenerationTransport({ apiKey: KEY, fetchImpl: (async () =>
      new Promise<Response>(() => {})) as typeof fetch });
    clock = 9_980; // 요청값 60초가 아니라 남은 20ms가 제한이 된다
    const startedAt = Date.now();
    setTimeout(() => { clock = 10_000; }, 10);
    await assert.rejects(
      transport.author({ body: {}, timeoutMs: 60_000 }, deadline),
      throwsKind('run_deadline_exceeded'),
    );
    assert.ok(Date.now() - startedAt < 5_000, '요청값 60초를 기다리지 않는다');
    deadline.dispose();
  });

  it('남은 시간이 없으면 보내지 않는다', async () => {
    let calls = 0;
    let clock = 0;
    const deadline = createCandidateGenerationRunDeadline({ budgetMs: 100, now: () => clock });
    const transport = createCandidateGenerationTransport({ apiKey: KEY, fetchImpl: (async () => {
      calls++; return new Response('{}');
    }) as typeof fetch });
    clock = 100;
    await assert.rejects(transport.author({ body: {}, timeoutMs: 60_000 }, deadline), throwsKind('run_deadline_exceeded'));
    assert.equal(calls, 0);
    deadline.dispose();
  });

  it('헤더 뒤 본문이 끝나지 않으면 실행 마감으로 취소한다', async () => {
    let cancelled = false;
    const deadline = createCandidateGenerationRunDeadline({ budgetMs: 30 });
    const transport = createCandidateGenerationTransport({ apiKey: KEY, fetchImpl: (async () =>
      new Response(new ReadableStream({ cancel() { cancelled = true; } }))) as typeof fetch });
    await assert.rejects(transport.author({ body: {}, timeoutMs: 60_000 }, deadline), throwsKind('run_deadline_exceeded'));
    assert.equal(cancelled, true);
    deadline.dispose();
  });

  it('저작 요청 spec의 상한은 60초이며 계약 상수와 같다', async () => {
    const { base, candidate } = await fixture();
    const spec = await buildCaseAuthorRequest(candidate, base);
    assert.equal(spec.timeoutMs, CANDIDATE_GENERATION_REQUEST_MAX_MS);
    assert.equal(CANDIDATE_GENERATION_REQUEST_MAX_MS, 60_000);
  });
});

describe('candidate generation · 전체 실행 마감과 취소', () => {
  const okDeps = (counts: { author: number; analyze: number }) => ({
    author: async () => { counts.author++; return authorResponse(); },
    analyze: async () => { counts.analyze++; return analysis(); },
  });

  it('기본 예산은 120초이며 더 길게 설정할 수 없다', async () => {
    assert.equal(CANDIDATE_GENERATION_RUN_BUDGET_MAX_MS, 120_000);
    const { candidate, base } = await fixture();
    const counts = { author: 0, analyze: 0 };
    const result = await runCandidateGenerationEvidence(candidate, base, okDeps(counts), { budgetMs: 120_001 });
    assert.deepEqual(result, { status: 'failed', reason: 'configuration_error' });
    assert.deepEqual(counts, { author: 0, analyze: 0 });
  });

  for (const bad of [0, -1, NaN, Infinity, 1.5, '1000']) {
    it(`잘못된 budgetMs(${String(bad)})는 호출 0회로 거절한다`, async () => {
      const { candidate, base } = await fixture();
      const counts = { author: 0, analyze: 0 };
      const result = await runCandidateGenerationEvidence(
        candidate, base, okDeps(counts), { budgetMs: bad as unknown as number },
      );
      assert.deepEqual(result, { status: 'failed', reason: 'configuration_error' });
      assert.deepEqual(counts, { author: 0, analyze: 0 });
    });
  }

  it('이미 취소된 실행은 저작·분석을 한 번도 부르지 않는다', async () => {
    const { candidate, base } = await fixture();
    const counts = { author: 0, analyze: 0 };
    const controller = new AbortController();
    controller.abort();
    const result = await runCandidateGenerationEvidence(candidate, base, okDeps(counts), { signal: controller.signal });
    assert.deepEqual(result, { status: 'failed', reason: 'run_cancelled' });
    assert.deepEqual(counts, { author: 0, analyze: 0 });
  });

  it('취소를 무시하고 끝나지 않는 author에서도 실행기가 반환한다', async () => {
    const { candidate, base } = await fixture();
    let analyzed = 0;
    const result = await runCandidateGenerationEvidence(candidate, base, {
      author: () => new Promise<unknown>(() => {}),
      analyze: async () => { analyzed++; return analysis(); },
    }, { budgetMs: 40 });
    assert.deepEqual(result, { status: 'failed', reason: 'run_deadline_exceeded' });
    assert.equal(analyzed, 0);
  });

  it('취소를 무시하고 끝나지 않는 analyze에서도 실행기가 반환한다', async () => {
    const { candidate, base } = await fixture();
    let analyzed = 0;
    const result = await runCandidateGenerationEvidence(candidate, base, {
      author: async () => authorResponse(),
      analyze: () => { analyzed++; return new Promise<unknown>(() => {}); },
    }, { budgetMs: 40 });
    assert.equal(result.status, 'failed');
    if (result.status !== 'failed') throw new Error('failed expected');
    assert.equal(result.reason, 'run_deadline_exceeded');
    assert.equal(result.caseId, 'GEN-SC-052-01');
    assert.equal(analyzed, 1, '마감 뒤에는 다음 분석을 시작하지 않는다');
  });

  it('중간 분석에서 예산을 다 쓰면 다음 분석을 부르지 않는다', async () => {
    const { candidate, base } = await fixture(2);
    let clock = 0;
    let analyzed = 0;
    const result = await runCandidateGenerationEvidence(candidate, base, {
      author: async () => response({ scenarios: { 'SC-052': TEXTS, 'SC-053': ['진로 문제로 고민해요.', '새 직장을 고르기 어려워요.', '여러 선택지 앞에서 지혜가 필요해요.'] } }),
      analyze: async () => { analyzed++; if (analyzed === 3) clock = 10_000; return analysis(); },
    }, { budgetMs: 10_000, now: () => clock });
    assert.equal(result.status, 'failed');
    if (result.status !== 'failed') throw new Error('failed expected');
    assert.equal(result.reason, 'run_deadline_exceeded');
    // 세 번째 호출 도중에 예산이 끝났으므로 그 결과는 쓰지 않고 그 사례에서 멈춘다.
    assert.equal(result.caseId, 'GEN-SC-052-03');
    assert.equal(analyzed, 3, '계획 6건 중 3건만 부르고 네 번째는 시작하지 않는다');
  });

  it('단계가 바뀌어도 예산이 초기화되지 않는다', async () => {
    const { candidate, base } = await fixture();
    let clock = 0;
    let analyzed = 0;
    // 저작에서 950ms, 분석 한 건마다 60ms를 쓴다. 예산 1000ms는 첫 분석 중에 소진된다.
    const result = await runCandidateGenerationEvidence(candidate, base, {
      author: async () => { clock += 950; return authorResponse(); },
      analyze: async () => { analyzed++; clock += 60; return analysis(); },
    }, { budgetMs: 1_000, now: () => clock });
    assert.equal(result.status, 'failed');
    if (result.status !== 'failed') throw new Error('failed expected');
    assert.equal(result.reason, 'run_deadline_exceeded');
    assert.equal(analyzed, 1, '예산이 단계마다 되살아났다면 세 건을 모두 끝냈을 것이다');
  });

  it('늦게 완료된 author는 분석을 부르거나 결과를 바꾸지 못한다', async () => {
    const { candidate, base } = await fixture();
    let analyzed = 0;
    let releaseAuthor!: (value: unknown) => void;
    const late = new Promise<unknown>(resolve => { releaseAuthor = resolve; });
    const result = await runCandidateGenerationEvidence(candidate, base, {
      author: () => late,
      analyze: async () => { analyzed++; return analysis(); },
    }, { budgetMs: 40 });
    assert.deepEqual(result, { status: 'failed', reason: 'run_deadline_exceeded' });
    releaseAuthor(authorResponse());
    await new Promise<void>(resolve => setTimeout(resolve, 20));
    assert.equal(analyzed, 0, '뒤늦은 성공이 분석을 부르면 안 된다');
  });

  it('늦게 실패한 analyze는 결과를 바꾸지 못하고 처리되지 않은 rejection도 남기지 않는다', async () => {
    const { candidate, base } = await fixture();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      let rejectAnalyze!: (error: unknown) => void;
      const late = new Promise<unknown>((_, reject) => { rejectAnalyze = reject; });
      let calls = 0;
      const result = await runCandidateGenerationEvidence(candidate, base, {
        author: async () => authorResponse(),
        analyze: () => { calls++; return late; },
      }, { budgetMs: 40 });
      assert.equal(result.status, 'failed');
      if (result.status !== 'failed') throw new Error('failed expected');
      assert.equal(result.reason, 'run_deadline_exceeded');
      rejectAnalyze(new Error(PRIVATE + KEY));
      await new Promise<void>(resolve => setTimeout(resolve, 30));
      assert.equal(calls, 1);
      assert.deepEqual(unhandled, []);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('마감 실패에도 원본 오류·키·문장이 담기지 않는다', async () => {
    const { candidate, base } = await fixture();
    const result = await runCandidateGenerationEvidence(candidate, base, {
      author: () => new Promise<unknown>(() => {}),
      analyze: () => new Promise<unknown>(() => {}),
    }, { budgetMs: 30 });
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes(PRIVATE), false);
    assert.equal(serialized.includes(KEY), false);
    assert.deepEqual(Object.keys(result).sort(), ['reason', 'status']);
  });

  it('실제 transport 경로에서도 전체 마감이 남은 분석을 막는다', async () => {
    const { candidate, base } = await fixture();
    let sent = 0;
    const runner = createCandidateGenerationEvidenceRunner({ apiKey: KEY, fetchImpl: (async (_u, init) => {
      sent++;
      const body = JSON.parse(init?.body as string);
      if (body.model === 'gpt-6-astra') return new Response(JSON.stringify(authorResponse()));
      return new Promise<Response>(() => {});
    }) as typeof fetch });
    const result = await runner(candidate, base, { budgetMs: 60 });
    assert.equal(result.status, 'failed');
    if (result.status !== 'failed') throw new Error('failed expected');
    assert.equal(result.reason, 'run_deadline_exceeded');
    assert.equal(sent, 2, '저작 1회 + 첫 분석 1회에서 멈춘다');
  });

  it('예산이 넉넉하면 정상 실행·지문 결속·다른 후보 재사용 차단이 그대로다', async () => {
    const { candidate, base } = await fixture();
    const counts = { author: 0, analyze: 0 };
    const result = await runCandidateGenerationEvidence(candidate, base, okDeps(counts), { budgetMs: 120_000 });
    assert.equal(result.status, 'completed');
    if (result.status !== 'completed') throw new Error('completed expected');
    assert.deepEqual(counts, { author: 1, analyze: 3 });
    assert.deepEqual(
      await validateCandidateGenerationEvidence(result.evidence, candidate, base),
      { valid: true, errors: [] },
    );
    const other = await fixture();
    const crossed = await validateCandidateGenerationEvidence(result.evidence, other.candidate, other.base);
    assert.equal(crossed.valid, true, '같은 후보 구성이면 지문이 같다');
    const { candidate: differentCandidate, base: differentBase } = await fixture(2);
    const rejected = await validateCandidateGenerationEvidence(result.evidence, differentCandidate, differentBase);
    assert.equal(rejected.valid, false);
    assert.equal(rejected.errors.some(e => e.includes('후보에서 다시 계산')), true);
  });

  it('options 없이 부르면 기존 동작 그대로 완료한다', async () => {
    const { candidate, base } = await fixture();
    const counts = { author: 0, analyze: 0 };
    const result = await runCandidateGenerationEvidence(candidate, base, okDeps(counts));
    assert.equal(result.status, 'completed');
    assert.deepEqual(counts, { author: 1, analyze: 3 });
  });
});

describe('candidate generation · 취소 즉시 종료와 마감 원인 구분', () => {
  const hangingFetch = (onCall?: () => void) => (async () => {
    onCall?.();
    return new Promise<Response>(() => {});
  }) as typeof fetch;

  it('취소하면 transport 대기도 곧바로 끝나고 요청 타이머가 남지 않는다', async () => {
    const controller = new AbortController();
    const deadline = createCandidateGenerationRunDeadline({ budgetMs: 50_000, signal: controller.signal });
    const transport = createCandidateGenerationTransport({ apiKey: KEY, timeoutMs: 50_000, fetchImpl: hangingFetch() });
    let state = 'pending';
    const pending = transport.author({ body: {}, timeoutMs: 50_000 }, deadline).then(
      () => { state = 'resolved'; },
      (error) => { state = (error as CandidateGenerationError).kind; },
    );
    await new Promise<void>(resolve => setTimeout(resolve, 10));
    assert.equal(state, 'pending');
    controller.abort();
    await pending;
    // 50초 타이머가 살아 있었다면 여기까지 오는 데 50초가 걸렸을 것이다.
    assert.equal(state, 'run_cancelled');
    deadline.dispose();
  });

  it('전체 마감이면 transport 대기도 곧바로 끝난다', async () => {
    const deadline = createCandidateGenerationRunDeadline({ budgetMs: 25 });
    const transport = createCandidateGenerationTransport({ apiKey: KEY, timeoutMs: 50_000, fetchImpl: hangingFetch() });
    await assert.rejects(
      transport.author({ body: {}, timeoutMs: 50_000 }, deadline),
      throwsKind('run_deadline_exceeded'),
    );
    deadline.dispose();
  });

  it('취소 뒤 늦은 성공·실패가 결과를 바꾸지 않고 rejection도 남기지 않는다', async () => {
    const { candidate, base } = await fixture();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const controller = new AbortController();
      let sent = 0;
      let releaseAuthor!: (value: Response) => void;
      let failAnalyze!: (error: unknown) => void;
      const runner = createCandidateGenerationEvidenceRunner({ apiKey: KEY, fetchImpl: (async (_u, init) => {
        sent += 1;
        const body = JSON.parse(init?.body as string);
        setTimeout(() => controller.abort(), 15);
        return body.model === 'gpt-6-astra'
          ? new Promise<Response>(resolve => { releaseAuthor = resolve; })
          : new Promise<Response>((_, reject) => { failAnalyze = reject; });
      }) as typeof fetch });
      const result = await runner(candidate, base, { signal: controller.signal, budgetMs: 50_000 });
      assert.deepEqual(result, { status: 'failed', reason: 'run_cancelled' });
      assert.equal(sent, 1, '취소 뒤 후속 호출은 없다');
      // 취소된 뒤에 제공자가 뒤늦게 응답하거나 실패해도 달라지는 것이 없어야 한다.
      releaseAuthor(new Response(JSON.stringify(authorResponse())));
      if (failAnalyze) failAnalyze(new Error(PRIVATE + KEY));
      await new Promise<void>(resolve => setTimeout(resolve, 40));
      assert.equal(sent, 1);
      assert.deepEqual(unhandled, []);
      assert.equal(JSON.stringify(result).includes(KEY), false);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('요청 타이머가 먼저 울려도 시계가 마감이면 저작 실패가 아니라 전체 마감이다', async () => {
    const { candidate, base } = await fixture();
    // 예산 5000ms의 전체 마감 타이머는 멀리 있고, 요청 타이머는 100ms 뒤에 확실히 먼저 운다.
    // 그 사이 시계는 이미 예산을 넘긴다 — 원인은 타이머 순서가 아니라 시계가 정해야 한다.
    let clock = 0;
    let sent = 0;
    const runner = createCandidateGenerationEvidenceRunner({ apiKey: KEY, timeoutMs: 100, fetchImpl: hangingFetch(() => {
      sent += 1;
      // 후보·manifest 사전 검증이 끝나 실제 요청이 시작된 뒤 시계만 전체 마감 너머로 보낸다.
      // transport의 100ms 요청 타이머가 5초짜리 전체 타이머보다 먼저 이 상태를 관측한다.
      setTimeout(() => { clock = 5_001; }, 5);
    }) });
    const startedAt = Date.now();
    const running = runner(candidate, base, { budgetMs: 5_000, now: () => clock });
    const result = await running;
    assert.equal(result.status, 'failed');
    if (result.status !== 'failed') throw new Error('failed expected');
    assert.equal(result.reason, 'run_deadline_exceeded');
    assert.equal(sent, 1);
    assert.ok(Date.now() - startedAt < 1_000, '전체 마감 타이머를 기다리지 않고 시계로 판정해야 한다');
  });

  it('분석 단계에서도 요청 타이머가 먼저 울려도 전체 마감으로 보고한다', async () => {
    const { candidate, base } = await fixture();
    let clock = 0;
    let sent = 0;
    const runner = createCandidateGenerationEvidenceRunner({ apiKey: KEY, fetchImpl: (async (_u, init) => {
      sent += 1;
      const body = JSON.parse(init?.body as string);
      if (body.model === 'gpt-6-astra') {
        // 저작이 끝난 시점에 예산을 거의 다 쓴 상태로 만든다. 분석 요청은 남은 99.75ms로 한도를 잡는다.
        clock = 4_900.25;
        setTimeout(() => { clock = 5_001; }, 5);
        return new Response(JSON.stringify(authorResponse()));
      }
      return new Promise<Response>(() => {});
    }) as typeof fetch });
    const startedAt = Date.now();
    const result = await runner(candidate, base, { budgetMs: 5_000, now: () => clock });
    assert.equal(result.status, 'failed');
    if (result.status !== 'failed') throw new Error('failed expected');
    assert.equal(result.reason, 'run_deadline_exceeded');
    assert.equal(result.caseId, 'GEN-SC-052-01');
    assert.equal(sent, 2, '저작 1회 + 첫 분석 1회에서 멈춘다');
    // 원인은 시계가 정한다. 전체 마감 타이머(5초)를 기다려서 알아낸 것이 아니어야 한다.
    assert.ok(Date.now() - startedAt < 1_000, '요청 타이머가 울린 시점에 이미 원인을 알아야 한다');
  });

  it('남은 시간이 1ms 미만이어도 실제 마감 전에는 끊지 않는다', async () => {
    // 남은 0.5ms를 내림하면 0이 되어 실제 마감 전에 끊긴다. 올림해야 한 번은 보낸다.
    let clock = 0;
    let calls = 0;
    const deadline = createCandidateGenerationRunDeadline({ budgetMs: 120, now: () => clock });
    clock = 119.5;
    assert.equal(deadline.remainingMs(), 0.5);
    const transport = createCandidateGenerationTransport({ apiKey: KEY, fetchImpl: hangingFetch(() => { calls += 1; }) });
    let settled = 'pending';
    const pending = transport.author({ body: {}, timeoutMs: 60_000 }, deadline).then(
      () => { settled = 'resolved'; },
      (error) => { settled = (error as CandidateGenerationError).kind; },
    );
    await new Promise<void>(resolve => setTimeout(resolve, 30));
    assert.equal(calls, 1, '아직 마감 전이므로 보내야 한다');
    assert.equal(settled, 'pending', '0.5ms가 남았는데 끊으면 안 된다');
    clock = 120; // 실제 마감
    await pending;
    assert.equal(settled, 'run_deadline_exceeded');
    deadline.dispose();
  });

  it('더 짧은 요청별 제한은 전체 마감으로 둔갑하지 않는다', async () => {
    const { candidate, base } = await fixture();
    let sent = 0;
    const runner = createCandidateGenerationEvidenceRunner({
      apiKey: KEY, timeoutMs: 20, fetchImpl: hangingFetch(() => { sent += 1; }),
    });
    const result = await runner(candidate, base, { budgetMs: 100_000 });
    assert.deepEqual(result, { status: 'failed', reason: 'author_failed' });
    assert.equal(sent, 1);
  });

  for (const bad of [null, '1000', {}, []] as const) {
    it(`budgetMs가 ${JSON.stringify(bad)}이면 기본값으로 바뀌지 않고 호출 0회로 거절한다`, async () => {
      const { candidate, base } = await fixture();
      let calls = 0;
      const result = await runCandidateGenerationEvidence(candidate, base, {
        author: async () => { calls += 1; return authorResponse(); },
        analyze: async () => { calls += 1; return analysis(); },
      }, { budgetMs: bad as unknown as number });
      assert.deepEqual(result, { status: 'failed', reason: 'configuration_error' });
      assert.equal(calls, 0);
    });
  }

  for (const [name, options] of [
    ['now', { now: null }], ['signal', { signal: null }],
  ] as const) {
    it(`${name}이 null이면 기본값으로 바뀌지 않고 호출 0회로 거절한다`, async () => {
      const { candidate, base } = await fixture();
      let calls = 0;
      const result = await runCandidateGenerationEvidence(candidate, base, {
        author: async () => { calls += 1; return authorResponse(); },
        analyze: async () => { calls += 1; return analysis(); },
      }, options as unknown as { budgetMs?: number });
      assert.deepEqual(result, { status: 'failed', reason: 'configuration_error' });
      assert.equal(calls, 0);
    });
  }

  it('budgetMs를 생략하면 기본 120초로 정상 완료한다', async () => {
    const { candidate, base } = await fixture();
    const result = await runCandidateGenerationEvidence(candidate, base, {
      author: async () => authorResponse(), analyze: async () => analysis(),
    }, {});
    assert.equal(result.status, 'completed');
  });
});

describe('candidate generation · 전체 마감 타이머의 반올림과 재예약', () => {
  const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

  /**
   * 시계를 타이머보다 느리게 흘려 "조기 콜백"을 만든다. 예산 30ms짜리 타이머가 울 때
   * 시계는 29.5ms만 지나 있으므로 아직 0.5ms가 남아 있다.
   *
   * 주입한 시계가 멈춰 있으면 재예약이 계속되므로 어떤 경우에도 dispose로 정리한다.
   */
  async function earlyTick(options: { signal?: AbortSignal } = {}) {
    let clock = 0;
    const deadline = createCandidateGenerationRunDeadline({
      budgetMs: 30, now: () => clock, signal: options.signal,
    });
    setTimeout(() => { clock = 29.5; }, 5);
    await sleep(45);
    return { deadline, setClock: (value: number) => { clock = value; } };
  }

  it('전체 마감 타이머를 올림해 예약한다', () => {
    // 재현 조건: startedAt = 0, 예약 시각 = 0.25, 남은 시간 = 119.75.
    // 소수를 그대로 넘기면 지연이 119로 잘려 실제 마감보다 0.75ms 먼저 울린다.
    const realSetTimeout = globalThis.setTimeout;
    const delays: unknown[] = [];
    let reads = 0;
    const now = () => (reads++ === 0 ? 0 : 0.25);
    let deadline: ReturnType<typeof createCandidateGenerationRunDeadline> | undefined;
    try {
      (globalThis as unknown as { setTimeout: unknown }).setTimeout = ((fn: () => void, ms?: number) => {
        delays.push(ms);
        return realSetTimeout(fn, ms);
      }) as unknown as typeof setTimeout;
      deadline = createCandidateGenerationRunDeadline({ budgetMs: 120, now });
    } finally {
      (globalThis as unknown as { setTimeout: unknown }).setTimeout = realSetTimeout;
    }
    try {
      assert.deepEqual(delays, [120], '119.75를 잘라 119로 예약하면 안 된다');
    } finally { deadline?.dispose(); }
  });

  it('타이머가 일찍 울어도 시계에 시간이 남으면 마감을 확정하지 않는다', async () => {
    const { deadline } = await earlyTick();
    try {
      assert.equal(deadline.failureReason(), null, '남은 시간이 있으면 확정하지 않는다');
      assert.equal(deadline.signal.aborted, false, '조기 콜백이 abort를 확정하면 안 된다');
      assert.equal(deadline.remainingMs(), 0.5);
      assert.equal(deadline.done(), false);
    } finally { deadline.dispose(); }
  });

  it('재예약된 타이머가 실제 마감에서 종료한다', async () => {
    const { deadline, setClock } = await earlyTick();
    try {
      assert.equal(deadline.failureReason(), null);
      setClock(30);
      await sleep(25);
      assert.equal(deadline.failureReason(), 'run_deadline_exceeded');
      assert.equal(deadline.signal.aborted, true);
    } finally { deadline.dispose(); }
  });

  it('재예약된 타이머는 취소로 정리되고 사유가 덮이지 않는다', async () => {
    const controller = new AbortController();
    const { deadline, setClock } = await earlyTick({ signal: controller.signal });
    try {
      assert.equal(deadline.failureReason(), null);
      controller.abort();
      assert.equal(deadline.failureReason(), 'run_cancelled');
      setClock(1_000); // 예산을 넘겨도 사유는 취소 그대로다
      await sleep(25);
      assert.equal(deadline.failureReason(), 'run_cancelled');
    } finally { deadline.dispose(); }
  });

  it('재예약된 타이머는 dispose로 정리되어 더는 마감을 확정하지 않는다', async () => {
    const { deadline, setClock } = await earlyTick();
    assert.equal(deadline.failureReason(), null);
    deadline.dispose();
    setClock(1_000);
    await sleep(25);
    assert.equal(deadline.failureReason(), null, 'dispose 뒤 타이머가 남아 있으면 안 된다');
  });

  it('시계가 마감을 지나면 재예약 없이 곧바로 종료한다', async () => {
    let clock = 0;
    const deadline = createCandidateGenerationRunDeadline({ budgetMs: 25, now: () => clock });
    try {
      setTimeout(() => { clock = 500; }, 5);
      await sleep(40);
      assert.equal(deadline.failureReason(), 'run_deadline_exceeded');
    } finally { deadline.dispose(); }
  });

  it('조기 콜백은 실행 중인 요청의 취소 신호를 올리지 않는다', async () => {
    const { deadline, setClock } = await earlyTick();
    try {
      let aborted = false;
      deadline.signal.addEventListener('abort', () => { aborted = true; });
      await sleep(15);
      assert.equal(aborted, false, '예산이 남았는데 in-flight 요청을 끊으면 안 된다');
      setClock(30);
      await sleep(25);
      assert.equal(aborted, true, '실제 마감에서는 끊어야 한다');
    } finally { deadline.dispose(); }
  });
});

describe('candidate generation · 요청 타이머의 조기 콜백', () => {
  const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

  /**
   * 보고된 재현 조건: 전체 예산 30ms, 요청 제한 60초.
   * 시계가 29.75ms일 때 요청 타이머 콜백이 조기 실행된다 — 아직 0.25ms가 남아 있다.
   */
  function earlyRequestTick(body: 'headers' | 'never') {
    let clock = 0;
    let bodyCancelled = false;
    let calls = 0;
    const deadline = createCandidateGenerationRunDeadline({ budgetMs: 30, now: () => clock });
    const transport = createCandidateGenerationTransport({ apiKey: KEY, fetchImpl: (async () => {
      calls += 1;
      if (body === 'never') return new Promise<Response>(() => {});
      // 헤더는 돌려주지만 본문은 끝나지 않는다.
      return new Response(new ReadableStream({ cancel() { bodyCancelled = true; } }));
    }) as typeof fetch });
    return {
      deadline, transport,
      calls: () => calls,
      bodyCancelled: () => bodyCancelled,
      setClock: (value: number) => { clock = value; },
    };
  }

  for (const stage of ['never', 'headers'] as const) {
    it(`조기 콜백은 ${stage === 'never' ? '헤더 대기' : '본문 대기'} 중인 요청을 끊지 않는다`, async () => {
      const ctx = earlyRequestTick(stage);
      try {
        let settled = 'pending';
        const pending = ctx.transport.author({ body: {}, timeoutMs: 60_000 }, ctx.deadline).then(
          () => { settled = 'resolved'; },
          (error) => { settled = (error as CandidateGenerationError).kind; },
        );
        // 타이머는 30ms에 울지만 시계는 29.75ms다 — 아직 0.25ms 남았다.
        setTimeout(() => ctx.setClock(29.75), 5);
        await sleep(45);
        assert.equal(ctx.calls(), 1);
        assert.equal(settled, 'pending', '예산이 남았는데 끊으면 안 된다');
        assert.equal(ctx.bodyCancelled(), false, '본문도 취소하면 안 된다');
        assert.equal(ctx.deadline.signal.aborted, false);

        ctx.setClock(30); // 실제 마감
        await pending;
        assert.equal(settled, 'run_deadline_exceeded');
      } finally { ctx.deadline.dispose(); }
    });
  }

  it('재예약해도 요청별 예산이 다시 시작하지 않는다', async () => {
    // 요청 제한 40ms, 전체 예산은 넉넉하다. 시계를 조금씩 올려 콜백을 여러 번 조기 실행시킨다.
    let clock = 0;
    const deadline = createCandidateGenerationRunDeadline({ budgetMs: 100_000, now: () => clock });
    const transport = createCandidateGenerationTransport({ apiKey: KEY, fetchImpl: (async () =>
      new Promise<Response>(() => {})) as typeof fetch });
    try {
      let settled = 'pending';
      const pending = transport.author({ body: {}, timeoutMs: 40 }, deadline).then(
        () => { settled = 'resolved'; },
        (error) => { settled = (error as CandidateGenerationError).kind; },
      );
      for (const value of [10, 20, 30, 39.5]) {
        clock = value;
        await sleep(12);
        assert.equal(settled, 'pending', `시계 ${value}ms에서는 아직 요청 마감 전이다`);
      }
      // 재예약이 예산을 되살렸다면 40ms를 지나도 끝나지 않았을 것이다.
      clock = 40;
      await pending;
      assert.equal(settled, 'provider_timeout', '요청별 마감은 절대 시각이라 늘어나지 않는다');
    } finally { deadline.dispose(); }
  });

  it('전체 마감·취소·요청별 제한을 각각 구분한다', async () => {
    const hanging = (async () => new Promise<Response>(() => {})) as typeof fetch;
    // (1) 요청별 제한이 먼저
    const short = createCandidateGenerationRunDeadline({ budgetMs: 100_000 });
    try {
      await assert.rejects(
        createCandidateGenerationTransport({ apiKey: KEY, fetchImpl: hanging })
          .author({ body: {}, timeoutMs: 20 }, short),
        throwsKind('provider_timeout'),
      );
    } finally { short.dispose(); }
    // (2) 전체 마감이 먼저
    const budget = createCandidateGenerationRunDeadline({ budgetMs: 20 });
    try {
      await assert.rejects(
        createCandidateGenerationTransport({ apiKey: KEY, fetchImpl: hanging })
          .author({ body: {}, timeoutMs: 60_000 }, budget),
        throwsKind('run_deadline_exceeded'),
      );
    } finally { budget.dispose(); }
    // (3) 호출자 취소
    const controller = new AbortController();
    const cancelled = createCandidateGenerationRunDeadline({ budgetMs: 100_000, signal: controller.signal });
    try {
      setTimeout(() => controller.abort(), 10);
      await assert.rejects(
        createCandidateGenerationTransport({ apiKey: KEY, fetchImpl: hanging })
          .author({ body: {}, timeoutMs: 60_000 }, cancelled),
        throwsKind('run_cancelled'),
      );
    } finally { cancelled.dispose(); }
  });

  it('성공으로 끝나도 재예약된 요청 타이머가 남지 않는다', async () => {
    const { candidate, base } = await fixture();
    let clock = 0;
    const runner = createCandidateGenerationEvidenceRunner({ apiKey: KEY, fetchImpl: (async (_u, init) => {
      // 매 요청마다 시계를 조금씩 올려 콜백이 여러 번 조기 실행되게 한다.
      clock += 1.25;
      const body = JSON.parse(init?.body as string);
      return new Response(JSON.stringify(
        body.model === 'gpt-6-astra' ? authorResponse() : response(analysis(), MODEL)));
    }) as typeof fetch });

    // 실행 동안 만들어진 타이머를 추적한다. 끝난 뒤 살아 있는 것이 있으면 정리가 샌 것이다.
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    const live = new Set<unknown>();
    let result;
    try {
      (globalThis as unknown as { setTimeout: unknown }).setTimeout = ((fn: () => void, ms?: number) => {
        const handle: unknown = realSetTimeout(() => { live.delete(handle); fn(); }, ms);
        live.add(handle);
        return handle;
      }) as unknown as typeof setTimeout;
      (globalThis as unknown as { clearTimeout: unknown }).clearTimeout = ((handle: unknown) => {
        live.delete(handle);
        return realClearTimeout(handle as Parameters<typeof clearTimeout>[0]);
      }) as unknown as typeof clearTimeout;
      result = await runner(candidate, base, { budgetMs: 100_000, now: () => clock });
    } finally {
      (globalThis as unknown as { setTimeout: unknown }).setTimeout = realSetTimeout;
      (globalThis as unknown as { clearTimeout: unknown }).clearTimeout = realClearTimeout;
      // 샌 타이머가 있어도 이 테스트 프로세스가 붙들리지 않도록 실제로는 꺼 준다.
      for (const handle of live) realClearTimeout(handle as Parameters<typeof clearTimeout>[0]);
    }
    assert.equal(result.status, 'completed');
    assert.equal(live.size, 0, '완료 뒤 남아 있는 타이머가 있으면 안 된다');
  });
});

describe('candidate generation · 증거 실행기', () => {
  it('카드 두 장이면 정확히 저작 1회·분석 6회를 실행한다', async () => {
    const { candidate, base } = await fixture(2); let authored = 0, analyzed = 0;
    const result = await runCandidateGenerationEvidence(candidate, base, {
      author: async () => { authored++; return response({ scenarios: { 'SC-052': TEXTS, 'SC-053': ['진로 문제로 고민해요.', '새 직장을 고르기 어려워요.', '여러 선택지 앞에서 지혜가 필요해요.'] } }); },
      analyze: async () => { analyzed++; return analysis(); },
    });
    assert.equal(result.status, 'completed'); assert.equal(authored, 1); assert.equal(analyzed, 6);
    if (result.status === 'completed') assert.equal(result.evidence.cases.length, 6);
  });
  it('첫 분석 완료 전에는 다음 분석을 시작하지 않는다', async () => {
    const { candidate, base } = await fixture();
    let resolveFirst!: (a: SituationAnalysis) => void;
    const first = new Promise<SituationAnalysis>(resolve => { resolveFirst = resolve; });
    let notifyStarted!: () => void;
    const started = new Promise<void>(resolve => { notifyStarted = resolve; });
    let calls = 0;
    const running = runCandidateGenerationEvidence(candidate, base, {
      author: async () => authorResponse(), analyze: async () => { calls++; notifyStarted(); return calls === 1 ? first : analysis(); },
    });
    await started; await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(calls, 1); resolveFirst(analysis());
    assert.equal((await running).status, 'completed'); assert.equal(calls, 3);
  });
  it('후보 카드가 선택되지 않는 유효 분석도 재작성 없이 증거로 남기고 Gate가 실패를 계산한다', async () => {
    const { candidate, base } = await fixture(); let authored = 0, analyzed = 0;
    const result = await runCandidateGenerationEvidence(candidate, base, {
      author: async () => { authored++; return authorResponse(); },
      analyze: async () => { analyzed++; return { ...analysis(), situationTags: ['중요한 결정', '진로'], emotionTags: ['혼란', '걱정'], spiritualQuestionTags: ['인도', '신뢰'], pastoralFunctions: ['지혜', '인도'] }; },
    });
    if (result.status !== 'completed') throw new Error('expected completed evidence');
    const adapter = await buildCandidateGenerationEvidenceAdapter(result.evidence, candidate, base);
    if (!adapter.ok) throw new Error('expected adapter');
    assert.equal((await adapter.evaluateCandidateGeneration(candidate)).cases.every(c => !c.passed), true);
    assert.equal(authored, 1); assert.equal(analyzed, 3);
  });
  it('실제 factory 연결에서 Astra 1회+Analyzer 3회, 검증된 증거와 Gate 결과를 만든다', async () => {
    const { candidate, base } = await fixture();
    const sent: any[] = [];
    const runner = createCandidateGenerationEvidenceRunner({ apiKey: KEY, fetchImpl: (async (_u, init) => {
      const body = JSON.parse(init?.body as string); sent.push(body);
      return new Response(JSON.stringify(body.model === 'gpt-6-astra' ? authorResponse() : response(analysis(), MODEL)));
    }) as typeof fetch });
    assert.equal(sent.length, 0);
    const result = await runner(candidate, base);
    assert.equal(result.status, 'completed');
    if (result.status !== 'completed') throw new Error('completed expected');
    assert.deepEqual(sent.map(r => r.model), ['gpt-6-astra', MODEL, MODEL, MODEL]);
    assert.deepEqual(sent.slice(1).map(r => r.input), TEXTS);
    // 봉인된 설정 지문은 실제로 나간 지시문·스키마에서 나온 값이어야 한다.
    assert.equal(result.evidence.caseAuthorRequest.schemaHash, await computeArtifactHash(sent[0].text.format));
    assert.equal(result.evidence.caseAuthorProfile.instructionsHash, await computeArtifactHash(sent[0].instructions));
    // 분석 요청 설정도 실제로 나간 본문에서 input만 뺀 지문과 같아야 한다.
    for (const analyzed of sent.slice(1)) {
      assert.equal(
        result.evidence.analysisRequest.requestHash,
        await computeArtifactHash(projectAnalysisRequestForHash(analyzed)),
      );
    }
    assert.equal(
      result.evidence.analysisRequest.requestHash,
      await computeCandidateGenerationAnalysisRequestHash(),
    );
    assert.deepEqual(await validateCandidateGenerationEvidence(result.evidence, candidate, base), { valid: true, errors: [] });
    const adapter = await buildCandidateGenerationEvidenceAdapter(result.evidence, candidate, base);
    if (!adapter.ok) throw new Error(adapter.errors.join(' / '));
    assert.equal((await adapter.evaluateCandidateGeneration(candidate)).cases.every(c => c.passed), true);
    assert.equal(JSON.stringify(result).includes(KEY), false);
  });
  for (const mode of ['invalid', 'new_domain', 'wrong_generator'] as const) {
    it(`${mode} 후보는 author·Analyzer 호출 없이 종료한다`, async () => {
      let { candidate, base } = await fixture();
      if (mode === 'invalid') candidate.proposedVersionHash = 'invalid';
      if (mode === 'new_domain') candidate = (await makeNewDomainCandidate(base)).candidate;
      if (mode === 'wrong_generator') candidate.generation.modelId = 'gpt-6-astra';
      let calls = 0;
      const result = await runCandidateGenerationEvidence(candidate, base, { author: async () => { calls++; }, analyze: async () => { calls++; } });
      assert.deepEqual(result, { status: 'failed', reason: 'input_invalid' });
      assert.equal(calls, 0);
    });
  }
  it('저작 실패는 원문 누출·Analyzer 호출 없이 끝난다', async () => {
    const { candidate, base } = await fixture(); let calls = 0;
    const result = await runCandidateGenerationEvidence(candidate, base, { author: async () => { throw new Error(PRIVATE); }, analyze: async () => { calls++; } });
    assert.deepEqual(result, { status: 'failed', reason: 'author_failed' }); assert.equal(calls, 0);
  });
  it('마지막 저작 문장이 잘못돼도 첫 분석을 시작하지 않는다', async () => {
    const { candidate, base } = await fixture(); let calls = 0;
    const result = await runCandidateGenerationEvidence(candidate, base, {
      author: async () => response({ scenarios: { 'SC-052': [TEXTS[0], TEXTS[1], 'SC-052 정답'] } }), analyze: async () => { calls++; },
    });
    assert.deepEqual(result, { status: 'failed', reason: 'author_response_invalid' }); assert.equal(calls, 0);
  });
  for (const [name, mutate] of [
    ['raw response', (a: any) => { a.rawResponse = PRIVATE; }],
    ['safety session', (a: any) => { a.safety.sessionId = PRIVATE; }],
    ['알 수 없는 태그', (a: any) => { a.situationTags = [PRIVATE]; }],
    ['다른 영역', (a: any) => { a.primaryDomain = 'fear_uncertainty'; }],
    ['안전 위험', (a: any) => { a.safety = { level: 'urgent', categories: ['abuse'] }; }],
    ['영역 선택', (a: any) => { a.domainPriority = 'needs_choice'; a.primaryDomain = null; a.domainChoiceCandidates = ['decision_guidance', 'fear_uncertainty']; }],
  ] as const) {
    it(`두 번째 분석의 ${name}은 세 번째 분석·부분 증거 없이 종료한다`, async () => {
      const { candidate, base } = await fixture(); let calls = 0;
      const result = await runCandidateGenerationEvidence(candidate, base, {
        author: async () => authorResponse(), analyze: async () => { const a = analysis(); if (++calls === 2) mutate(a); return a; },
      });
      assert.deepEqual(result, { status: 'failed', reason: 'analysis_invalid', caseId: 'GEN-SC-052-02' }); assert.equal(calls, 2);
    });
  }
  it('분석 예외는 재시도하지 않고 실패 caseId만 돌려준다', async () => {
    const { candidate, base } = await fixture(); let calls = 0;
    const result = await runCandidateGenerationEvidence(candidate, base, {
      author: async () => authorResponse(), analyze: async () => { calls++; throw new Error(PRIVATE); },
    });
    assert.deepEqual(result, { status: 'failed', reason: 'analyze_failed', caseId: 'GEN-SC-052-01' }); assert.equal(calls, 1);
  });
  it('호출 뒤 원본·이전 분석 객체를 바꿔도 저장될 증거는 실행 시점 복제본을 쓴다', async () => {
    const { candidate, base } = await fixture(); const originalCandidate = structuredClone(candidate), originalBase = structuredClone(base);
    let last: SituationAnalysis | undefined;
    const resultPromise = runCandidateGenerationEvidence(candidate, base, {
      author: async (spec) => { spec.body.model = PRIVATE; return authorResponse(); },
      analyze: async () => { if (last) last.primaryDomain = 'fear_uncertainty'; last = analysis(); return last; },
    });
    candidate.cards = []; base.cards = [];
    const result = await resultPromise;
    assert.equal(result.status, 'completed'); if (result.status !== 'completed') throw new Error('expected completed');
    assert.deepEqual(await validateCandidateGenerationEvidence(result.evidence, originalCandidate, originalBase), { valid: true, errors: [] });
  });
  it('동일 입력·동일 가짜 응답은 같은 증거 지문을 만든다', async () => {
    const { candidate, base } = await fixture(); const deps = { author: async () => authorResponse(), analyze: async () => analysis() };
    assert.deepEqual(await runCandidateGenerationEvidence(candidate, base, deps), await runCandidateGenerationEvidence(candidate, base, deps));
  });
  it('다섯 모듈은 환경변수·파일·DB·로그를 직접 읽거나 쓰지 않는다', () => {
    for (const filename of ['case-author', 'generation-transport', 'generation-runner', 'generation-failure', 'generation-deadline']) {
      const source = readFileSync(new URL(`../../supabase/functions/_shared/automatic-scripture-catalog-${filename}.ts`, import.meta.url), 'utf8');
      for (const token of ['process.env', 'Deno.env', 'console.', 'node:fs', '.rpc(', 'supabase-js']) assert.equal(source.includes(token), false, `${filename}: ${token}`);
    }
  });
});
