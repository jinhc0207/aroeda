/** Automatic Scripture Catalog · 신학 평가 OpenAI fetch transport 테스트. 실제 네트워크는 쓰지 않는다. */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  buildTheologyEvaluationOpenAIRequestSpec,
} from '../../supabase/functions/_shared/automatic-scripture-catalog-theology-openai-adapter.ts';
import {
  OPENAI_RESPONSES_URL,
  THEOLOGY_EVALUATION_FETCH_TRANSPORT_POLICY,
  TheologyEvaluationTransportError,
  callTheologyEvaluationOpenAIFetchTransport,
  createTheologyEvaluationOpenAIFetchTransport,
} from '../../supabase/functions/_shared/automatic-scripture-catalog-theology-openai-fetch-transport.ts';
import {
  ASTRA_MODEL_ID,
  ASTRA_PROFILE_ID,
  SOL_MODEL_ID,
  SOL_PROFILE_ID,
  THEOLOGY_REVIEW_RUBRIC,
} from '../../supabase/functions/_shared/automatic-scripture-catalog-validator-registry.ts';
import type {
  TheologyEvaluationRequest,
} from '../../supabase/functions/_shared/automatic-scripture-catalog-validator-executor.ts';
import {
  buildBaselineCatalog,
  makeNewDomainCandidate,
  resolveKrvPassage,
} from './automatic-scripture-catalog-test-fixtures.ts';

const FAKE_KEY = 'test-key-not-a-real-secret-transport';
const SECRET_MARKER = 'DO-NOT-LEAK-SECRET-7f81';
const ERROR_MARKER = 'DO-NOT-LEAK-PROVIDER-ERROR-92ac';
const TRANSPORT_SOURCE = new URL(
  '../../supabase/functions/_shared/automatic-scripture-catalog-theology-openai-fetch-transport.ts',
  import.meta.url,
);

async function makeRequest(
  modelId: typeof SOL_MODEL_ID | typeof ASTRA_MODEL_ID = SOL_MODEL_ID,
): Promise<TheologyEvaluationRequest> {
  const base = buildBaselineCatalog();
  const { candidate } = await makeNewDomainCandidate(base);
  const verifiedPassages = candidate.cards.flatMap((card) =>
    card.passages.map((passage, passageIndex) => {
      const verses = resolveKrvPassage(passage);
      assert.ok(verses);
      return { cardId: card.id, passageIndex, passage, verses };
    }),
  );
  return {
    modelId,
    profileId: modelId === SOL_MODEL_ID ? SOL_PROFILE_ID : ASTRA_PROFILE_ID,
    candidate,
    rubric: THEOLOGY_REVIEW_RUBRIC,
    baselineDomains: base.domains.map((domain) => ({ ...domain })),
    verifiedPassages,
  };
}

const expectedEvaluations = (request: TheologyEvaluationRequest, failedCriterion?: string) =>
  request.candidate.cards.map((card) => ({
    cardId: card.id,
    criteria: request.rubric.criteria.map((criterion) => ({
      criterionId: criterion.criterionId,
      verdict: criterion.criterionId === failedCriterion ? 'fail' as const : 'pass' as const,
    })),
  }));

const rawResponse = (request: TheologyEvaluationRequest, evaluations = expectedEvaluations(request)) => ({
  status: 'completed',
  error: null,
  output: [{
    type: 'message',
    content: [{ type: 'output_text', text: JSON.stringify({ cardEvaluations: evaluations }) }],
  }],
});

type FetchCall = { url: unknown; init: RequestInit };
const fakeFetch = (respond: (call: FetchCall) => Promise<Response> | Response) => {
  const calls: FetchCall[] = [];
  const impl = (async (url: unknown, init: RequestInit) => {
    calls.push({ url, init });
    return await respond({ url, init });
  }) as unknown as typeof fetch;
  return { calls, impl };
};

const ok = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
const guardedNonOk = (status: number) => {
  const forbidden = () => { throw new Error('NON_OK_BODY_MUST_NOT_BE_READ'); };
  return { ok: false, status, json: forbidden, text: forbidden } as unknown as Response;
};

async function expectFailure(
  run: () => Promise<unknown>,
  kind: TheologyEvaluationTransportError['kind'],
) {
  await assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof TheologyEvaluationTransportError);
    assert.equal(error.kind, kind);
    assert.equal(error.message, kind);
    return true;
  });
}

describe('theology fetch transport · 정상 요청', () => {
  it('정해진 주소에 adapter 본문 그대로 한 번 POST한다', async () => {
    const request = await makeRequest();
    const spec = buildTheologyEvaluationOpenAIRequestSpec(request);
    const { calls, impl } = fakeFetch(() => ok(rawResponse(request)));
    const before = structuredClone(request);
    const result = await createTheologyEvaluationOpenAIFetchTransport({ apiKey: FAKE_KEY, fetchImpl: impl })(request);
    assert.deepEqual(result, expectedEvaluations(request));
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, OPENAI_RESPONSES_URL);
    assert.equal(calls[0]?.init.method, 'POST');
    assert.deepEqual(calls[0]?.init.headers, {
      authorization: `Bearer ${FAKE_KEY}`,
      'content-type': 'application/json',
    });
    assert.deepEqual(JSON.parse(calls[0]?.init.body as string), spec.body);
    assert.ok(calls[0]?.init.signal);
    assert.deepEqual(request, before);
  });

  it('criterion fail도 기술 성공으로 그대로 돌려주며 카드 최종 판정을 만들지 않는다', async () => {
    const request = await makeRequest();
    const evaluations = expectedEvaluations(request, request.rubric.criteria[3]!.criterionId);
    const { impl } = fakeFetch(() => ok(rawResponse(request, evaluations)));
    assert.deepEqual(
      await createTheologyEvaluationOpenAIFetchTransport({ apiKey: FAKE_KEY, fetchImpl: impl })(request),
      evaluations,
    );
    assert.equal('verdict' in evaluations[0]!, false);
  });

  it('Sol과 Astra model id를 각각 그대로 전송한다', async () => {
    for (const modelId of [SOL_MODEL_ID, ASTRA_MODEL_ID] as const) {
      const request = await makeRequest(modelId);
      const { calls, impl } = fakeFetch(() => ok(rawResponse(request)));
      await createTheologyEvaluationOpenAIFetchTransport({ apiKey: FAKE_KEY, fetchImpl: impl })(request);
      assert.equal(JSON.parse(calls[0]!.init.body as string).model, modelId);
    }
  });

  it('여러 output_text 조각을 기존 helper가 순서대로 합친다', async () => {
    const request = await makeRequest();
    const text = JSON.stringify({ cardEvaluations: expectedEvaluations(request) });
    const middle = Math.floor(text.length / 2);
    const raw = {
      status: 'completed', error: null,
      output: [
        { type: 'message', content: [{ type: 'output_text', text: text.slice(0, middle) }] },
        { type: 'message', content: [{ type: 'output_text', text: text.slice(middle) }] },
      ],
    };
    const { impl } = fakeFetch(() => ok(raw));
    assert.deepEqual(
      await createTheologyEvaluationOpenAIFetchTransport({ apiKey: FAKE_KEY, fetchImpl: impl })(request),
      expectedEvaluations(request),
    );
  });

  it('보낸 spec과 받은 raw 응답 객체를 바꾸지 않는다', async () => {
    const request = await makeRequest();
    const spec = buildTheologyEvaluationOpenAIRequestSpec(request);
    const raw = rawResponse(request);
    const specBefore = structuredClone(spec);
    const rawBefore = structuredClone(raw);
    const { impl } = fakeFetch(() => ok(raw));
    await callTheologyEvaluationOpenAIFetchTransport(spec, request, { apiKey: FAKE_KEY, fetchImpl: impl });
    assert.deepEqual(spec, specBefore);
    assert.deepEqual(raw, rawBefore);
  });

  it('성공 뒤에는 timer를 정리해 AbortSignal이 나중에 바뀌지 않는다', async () => {
    const request = await makeRequest();
    const spec = { ...buildTheologyEvaluationOpenAIRequestSpec(request), timeoutMs: 5 };
    const observed: { signal: AbortSignal | null } = { signal: null };
    const { impl } = fakeFetch(({ init }) => {
      observed.signal = init.signal ?? null;
      return ok(rawResponse(request));
    });
    await callTheologyEvaluationOpenAIFetchTransport(spec, request, { apiKey: FAKE_KEY, fetchImpl: impl });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(observed.signal);
    assert.equal(observed.signal.aborted, false);
  });
});

describe('theology fetch transport · 자격과 HTTP 실패', () => {
  it('쓸 수 없는 자격은 fetch를 한 번도 부르지 않는다', async () => {
    for (const apiKey of [undefined, null, 7, {}, '', '   ']) {
      const request = await makeRequest();
      const { calls, impl } = fakeFetch(() => ok(rawResponse(request)));
      await expectFailure(
        () => createTheologyEvaluationOpenAIFetchTransport({ apiKey, fetchImpl: impl })(request),
        'configuration_error',
      );
      assert.equal(calls.length, 0);
    }
  });

  it('fetch reject는 provider_error이고 재시도하지 않는다', async () => {
    const request = await makeRequest();
    const { calls, impl } = fakeFetch(() => { throw new Error(ERROR_MARKER); });
    await expectFailure(
      () => createTheologyEvaluationOpenAIFetchTransport({ apiKey: FAKE_KEY, fetchImpl: impl })(request),
      'provider_error',
    );
    assert.equal(calls.length, 1);
  });

  it('실제로 timer가 끊은 fetch만 provider_timeout이다', async () => {
    const request = await makeRequest();
    const spec = { ...buildTheologyEvaluationOpenAIRequestSpec(request), timeoutMs: 1 };
    const { calls, impl } = fakeFetch(({ init }) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error(ERROR_MARKER)), { once: true });
    }));
    await expectFailure(
      () => callTheologyEvaluationOpenAIFetchTransport(spec, request, { apiKey: FAKE_KEY, fetchImpl: impl }),
      'provider_timeout',
    );
    assert.equal(calls.length, 1);
  });

  it('HTTP 상태를 timeout·unavailable·error로 나누고 오류 본문은 읽지 않는다', async () => {
    const cases = [
      [400, 'provider_error'], [401, 'provider_error'], [403, 'provider_error'], [404, 'provider_error'],
      [408, 'provider_timeout'], [429, 'provider_unavailable'], [500, 'provider_unavailable'],
    ] as const;
    for (const [status, kind] of cases) {
      const request = await makeRequest();
      const { calls, impl } = fakeFetch(() => guardedNonOk(status));
      await expectFailure(
        () => createTheologyEvaluationOpenAIFetchTransport({ apiKey: FAKE_KEY, fetchImpl: impl })(request),
        kind,
      );
      assert.equal(calls.length, 1);
    }
  });

  it('본문 JSON 읽기 실패는 provider_error다', async () => {
    const request = await makeRequest();
    const response = { ok: true, status: 200, json: async () => { throw new Error(ERROR_MARKER); } } as unknown as Response;
    const { impl } = fakeFetch(() => response);
    await expectFailure(
      () => createTheologyEvaluationOpenAIFetchTransport({ apiKey: FAKE_KEY, fetchImpl: impl })(request),
      'provider_error',
    );
  });

  it('본문을 읽는 동안 timer가 끊으면 provider_timeout이다', async () => {
    const request = await makeRequest();
    const spec = { ...buildTheologyEvaluationOpenAIRequestSpec(request), timeoutMs: 1 };
    const response = {
      ok: true,
      status: 200,
      json: () => new Promise((_resolve, reject) => setTimeout(() => reject(new Error(ERROR_MARKER)), 5)),
    } as unknown as Response;
    const { impl } = fakeFetch(() => response);
    await expectFailure(
      () => callTheologyEvaluationOpenAIFetchTransport(spec, request, { apiKey: FAKE_KEY, fetchImpl: impl }),
      'provider_timeout',
    );
  });
});

describe('theology fetch transport · Adapter 실패 매핑', () => {
  const cases: Array<[string, (request: TheologyEvaluationRequest) => unknown, TheologyEvaluationTransportError['kind']]> = [
    ['provider error', () => ({ status: 'completed', error: { message: ERROR_MARKER }, output: [] }), 'provider_error'],
    ['incomplete', () => ({ status: 'incomplete', error: null, output: [] }), 'response_incomplete'],
    ['refusal', () => ({ status: 'completed', error: null, output: [{ type: 'message', content: [{ type: 'refusal', refusal: ERROR_MARKER }] }] }), 'model_refusal'],
    ['empty', () => ({ status: 'completed', error: null, output: [] }), 'empty_response'],
    ['json parse', () => ({ status: 'completed', error: null, output: [{ type: 'message', content: [{ type: 'output_text', text: '{' }] }] }), 'json_parse_failed'],
    ['envelope', () => ({ status: 'completed', error: null, output: [{ type: 'message', content: [{ type: 'output_text', text: '{}' }] }] }), 'response_contract_invalid'],
    ['card missing', (request) => rawResponse(request, expectedEvaluations(request).slice(0, -1)), 'response_contract_invalid'],
    ['card added', (request) => rawResponse(request, [...expectedEvaluations(request), expectedEvaluations(request)[0]!]), 'response_contract_invalid'],
    ['card order', (request) => rawResponse(request, expectedEvaluations(request).toReversed()), 'response_contract_invalid'],
    ['card wrong id', (request) => {
      const values = expectedEvaluations(request);
      values[0] = { ...values[0]!, cardId: 'SC-WRONG' };
      return rawResponse(request, values);
    }, 'response_contract_invalid'],
    ['card extra field', (request) => {
      const values = expectedEvaluations(request) as Array<Record<string, unknown>>;
      values[0] = { ...values[0]!, extra: true };
      return rawResponse(request, values as never);
    }, 'response_contract_invalid'],
    ['criterion missing', (request) => {
      const values = expectedEvaluations(request);
      values[0] = { ...values[0]!, criteria: values[0]!.criteria.slice(0, -1) };
      return rawResponse(request, values);
    }, 'response_contract_invalid'],
    ['criterion duplicate', (request) => {
      const values = expectedEvaluations(request);
      values[0]!.criteria[1] = { ...values[0]!.criteria[0]! };
      return rawResponse(request, values);
    }, 'response_contract_invalid'],
    ['criterion order', (request) => {
      const values = expectedEvaluations(request);
      values[0] = { ...values[0]!, criteria: values[0]!.criteria.toReversed() };
      return rawResponse(request, values);
    }, 'response_contract_invalid'],
    ['criterion wrong id', (request) => {
      const values = expectedEvaluations(request) as Array<{cardId: string; criteria: Array<Record<string, unknown>>}>;
      values[0]!.criteria[0] = { ...values[0]!.criteria[0]!, criterionId: 'unknown-criterion' };
      return rawResponse(request, values as never);
    }, 'response_contract_invalid'],
    ['criterion extra field', (request) => {
      const values = expectedEvaluations(request) as Array<{cardId: string; criteria: Array<Record<string, unknown>>}>;
      values[0]!.criteria[0] = { ...values[0]!.criteria[0]!, extra: true };
      return rawResponse(request, values as never);
    }, 'response_contract_invalid'],
    ['bad verdict', (request) => {
      const values = expectedEvaluations(request) as Array<{cardId: string; criteria: Array<Record<string, unknown>>}>;
      values[0]!.criteria[0] = { ...values[0]!.criteria[0]!, verdict: 'maybe' };
      return rawResponse(request, values as never);
    }, 'response_contract_invalid'],
  ];

  for (const [name, makeRaw, kind] of cases) {
    it(`${name}을 ${kind}로 fail-closed 처리한다`, async () => {
      const request = await makeRequest();
      const { impl } = fakeFetch(() => ok(makeRaw(request)));
      await expectFailure(
        () => createTheologyEvaluationOpenAIFetchTransport({ apiKey: FAKE_KEY, fetchImpl: impl })(request),
        kind,
      );
    });
  }
});

describe('theology fetch transport · 비밀정보와 책임 경계', () => {
  it('열쇠와 provider 오류 원문을 오류에 남기지 않는다', async () => {
    const request = await makeRequest();
    const { impl } = fakeFetch(() => { throw new Error(`${ERROR_MARKER}:${SECRET_MARKER}`); });
    try {
      await createTheologyEvaluationOpenAIFetchTransport({ apiKey: SECRET_MARKER, fetchImpl: impl })(request);
      assert.fail('실패해야 합니다.');
    } catch (error) {
      const serialized = JSON.stringify(error);
      const visible = `${String(error)} ${serialized}`;
      assert.equal(visible.includes(SECRET_MARKER), false);
      assert.equal(visible.includes(ERROR_MARKER), false);
    }
  });

  it('정책은 1회 호출·재시도 없음·본문/오류 비보관을 고정한다', () => {
    assert.deepEqual(THEOLOGY_EVALUATION_FETCH_TRANSPORT_POLICY, {
      attempts: 1,
      automaticRetries: 0,
      fallbackModelAllowed: false,
      fallbackCredentialAllowed: false,
      nonOkBodyRead: false,
      rawResponsePersisted: false,
      providerErrorMessagePersisted: false,
      environmentReadHere: false,
      databaseAccessHere: false,
    });
  });

  it('소스가 환경변수·DB·로그·재시도·하드코딩 모델을 갖지 않는다', () => {
    const source = readFileSync(TRANSPORT_SOURCE, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '');
    for (const banned of [
      'Deno.env', 'process.env', 'console.', 'createClient(', '/rest/v1/', 'SUPABASE_',
      'gpt-5.6-sol', 'gpt-6-astra', 'while (', 'for (;;', '.text()', 'response.text',
    ]) {
      assert.equal(source.includes(banned), false, banned);
    }
    assert.ok(source.includes('buildTheologyEvaluationOpenAIRequestSpec'));
    assert.ok(source.includes('interpretTheologyEvaluationOpenAIResponse'));
    assert.ok(source.includes('classifyOpenAIHttpStatus'));
  });
});
