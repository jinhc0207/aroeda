/**
 * Candidate Generation · 실제로 요청을 보내는 자리 · 테스트
 *
 * 실행: npm test
 *
 * 지키려는 것.
 *
 *   1. 보낼 것을 여기서 새로 만들지 않는다. Adapter가 만든 것 그대로 나간다.
 *   2. 열쇠가 쓸 수 없으면 한 번도 부르지 않는다.
 *   3. 한 번만 보낸다. 실패해도 다시 보내지 않는다.
 *   4. 받아들여지지 않은 답의 본문을 절대 열지 않는다.
 *   5. raw HTTP 응답에는 없는 output_text 자리를 이미 있는 함수로 채워서 Adapter에 넘긴다.
 *   6. 시간이 지났는지는 우리가 건 타이머가 실제로 끊었는지로만 판단한다.
 *   7. 열쇠·오류 문구·주소가 결과 어디에도 남지 않는다.
 *
 * 실제 네트워크 요청은 하지 않는다. 보내는 일을 가짜로 넣는다.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  OPENAI_RESPONSES_URL,
  callCandidateGenerationOpenAIFetchTransport,
} from '../../supabase/functions/_shared/published-content-candidate-generation-openai-fetch-transport.ts';
import { buildCandidateGenerationOpenAIRequestSpec } from '../../supabase/functions/_shared/published-content-candidate-generation-openai-adapter-contract.ts';
import { buildCandidateGenerationPrompt } from '../../supabase/functions/_shared/published-content-candidate-generation-prompt.ts';
import {
  buildCandidateModelGenerationInput,
  type CandidateModelGenerationInput,
} from '../../supabase/functions/_shared/published-content-candidate-generation-contract.ts';
import { CANDIDATE_GENERATION_STRUCTURED_OUTPUT_ENVELOPE_KEY } from '../../supabase/functions/_shared/published-content-candidate-generation-structured-output-schema.ts';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '');

const TRANSPORT =
  '../../supabase/functions/_shared/published-content-candidate-generation-openai-fetch-transport.ts';

const ENVELOPE = CANDIDATE_GENERATION_STRUCTURED_OUTPUT_ENVELOPE_KEY;

/** 시험용 가짜 열쇠. 실제 열쇠가 아니다. */
const FAKE_KEY = 'test-key-not-a-real-secret-0000';

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
        exegesisEvidenceIds: [],
        theologyEvidenceIds: [],
        pastoralEvidenceIds: [],
        safetyEvidenceIds: [],
        exegesisSourceIds: [],
        theologySourceIds: [],
        pastoralSourceIds: [],
        safetySourceIds: [],
      },
    },
  ],
  rejectedPassages: [],
  unresolvedQuestions: [],
  evidenceSetHash: `evset_${'c'.repeat(64)}`,
});

const INPUT = buildCandidateModelGenerationInput(researchResult()) as CandidateModelGenerationInput;
const PROMPT = buildCandidateGenerationPrompt(INPUT);
const SPEC = buildCandidateGenerationOpenAIRequestSpec(PROMPT);

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

/**
 * 실제 raw HTTP 응답의 모양.
 *
 * 이 계층이 존재하는 이유가 바로 이것이다. 맨 바깥에 output_text 자리가 없다.
 * 그 자리는 라이브러리가 계산해 주는 편의 항목이지 제공자가 HTTP로 보내는 것이 아니다.
 */
const rawResponse = (output: unknown[], over: Record<string, unknown> = {}) => ({
  status: 'completed',
  error: null,
  output,
  ...over,
});

const messageOutput = (text: string) => [{ type: 'message', content: [{ type: 'output_text', text }] }];

const generateOutput = (overDraft: Record<string, unknown> = {}) =>
  messageOutput(envelopeText({ decision: 'generate', draft: draft(overDraft) }));

const deferOutput = () => messageOutput(envelopeText({ decision: 'defer', reason: 'needs_more_research' }));

type FetchCall = { url: unknown; init: RequestInit };

/** 정해진 답을 돌려주는 가짜 fetch. 몇 번 어떻게 불렸는지 기록한다. */
const fakeFetch = (respond: (call: FetchCall) => Promise<Response> | Response) => {
  const calls: FetchCall[] = [];
  const impl = (async (url: unknown, init: RequestInit) => {
    calls.push({ url, init });
    return await respond({ url, init });
  }) as unknown as typeof fetch;
  return { impl, calls };
};

const okResponse = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

/** 열리면 안 되는 본문. 열리면 시험이 그 자리에서 실패한다. */
const nonOkResponse = (status: number) => {
  const guard = () => {
    throw new Error('MUST_NOT_READ_NON_OK_BODY');
  };
  const resp = { ok: false, status, json: guard, text: guard } as unknown as Response;
  return resp;
};

const send = async (
  respond: (call: FetchCall) => Promise<Response> | Response,
  options: { apiKey?: unknown; timeoutMs?: number; input?: CandidateModelGenerationInput } = {},
) => {
  const { impl, calls } = fakeFetch(respond);
  const spec = options.timeoutMs === undefined ? SPEC : { ...SPEC, timeoutMs: options.timeoutMs };
  // 'apiKey' in options로 본다. options.apiKey ?? FAKE_KEY를 쓰면
  // 일부러 넘긴 undefined가 FAKE_KEY로 조용히 바뀌어 그 경우를 시험할 수 없다.
  const apiKey = 'apiKey' in options ? options.apiKey : FAKE_KEY;
  const result = await callCandidateGenerationOpenAIFetchTransport(spec, options.input ?? INPUT, {
    apiKey,
    fetchImpl: impl,
  });
  return { result, calls };
};

/* ================================================================== */
/* A. 보낼 것                                                           */
/* ================================================================== */

describe('실제로 보내는 자리 · A. 보낼 것', () => {
  it('정해진 곳에 POST로 보낸다', async () => {
    const { calls } = await send(() => okResponse(rawResponse(generateOutput())));
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, OPENAI_RESPONSES_URL);
    assert.equal(OPENAI_RESPONSES_URL, 'https://api.openai.com/v1/responses');
    assert.equal(calls[0]?.init.method, 'POST');
  });

  it('열쇠와 형식을 머리글에 담는다', async () => {
    const { calls } = await send(() => okResponse(rawResponse(generateOutput())));
    const headers = calls[0]?.init.headers as Record<string, string>;
    assert.equal(headers.authorization, `Bearer ${FAKE_KEY}`);
    assert.equal(headers['content-type'], 'application/json');
  });

  it('Adapter가 만든 본문을 그대로 보낸다', async () => {
    const { calls } = await send(() => okResponse(rawResponse(generateOutput())));
    assert.deepEqual(JSON.parse(calls[0]?.init.body as string), SPEC.body);
  });

  it('보낸 뒤에도 원래 Spec이 바뀌지 않는다', async () => {
    const before = JSON.stringify(SPEC);
    await send(() => okResponse(rawResponse(generateOutput())));
    assert.equal(JSON.stringify(SPEC), before);
  });

  it('취소할 수 있는 표시를 함께 보낸다', async () => {
    const { calls } = await send(() => okResponse(rawResponse(generateOutput())));
    assert.ok(calls[0]?.init.signal);
    assert.equal((calls[0]?.init.signal as AbortSignal).aborted, false);
  });

  it('정확히 한 번만 보낸다', async () => {
    const { calls } = await send(() => nonOkResponse(500));
    assert.equal(calls.length, 1);
  });
});

/* ================================================================== */
/* B. 성공한 답                                                         */
/* ================================================================== */

describe('실제로 보내는 자리 · B. 성공한 답', () => {
  it('유효한 생성 답이 통과한다', async () => {
    const { result } = await send(() => okResponse(rawResponse(generateOutput())));
    assert.equal(result.outcome, 'validated_generate');
  });

  it('유효한 보류 답이 통과한다', async () => {
    const { result } = await send(() => okResponse(rawResponse(deferOutput())));
    assert.equal(result.outcome, 'validated_defer');
  });

  it('여러 조각으로 나뉜 글을 모아서 읽는다', async () => {
    // extractOutputText가 이미 하는 일이다. 여기서 다시 훑지 않는다.
    const whole = envelopeText({ decision: 'generate', draft: draft() });
    const mid = Math.floor(whole.length / 2);
    const output = [
      { type: 'message', content: [{ type: 'output_text', text: whole.slice(0, mid) }] },
      { type: 'message', content: [{ type: 'output_text', text: whole.slice(mid) }] },
    ];
    const { result } = await send(() => okResponse(rawResponse(output)));
    assert.equal(result.outcome, 'validated_generate');
  });

  it('raw 응답에는 원래 output_text 자리가 없다', async () => {
    // 이 계층이 생긴 이유. 라이브러리가 계산해 주는 자리이지 HTTP로 오는 것이 아니다.
    const raw = rawResponse(generateOutput());
    assert.equal('output_text' in raw, false);
  });

  it('이미 붙어 있는 output_text를 믿지 않고 다시 구한다', async () => {
    const raw = rawResponse(generateOutput(), { output_text: envelopeText({ decision: 'defer', reason: 'needs_more_research' }) });
    const { result } = await send(() => okResponse(raw));
    // output 알맹이(generate)가 이긴다. 붙어 있던 편의 항목(defer)을 쓰지 않는다.
    assert.equal(result.outcome, 'validated_generate');
  });
});

/* ================================================================== */
/* C. 거절과 오다 만 것                                                 */
/* ================================================================== */

describe('실제로 보내는 자리 · C. 거절과 오다 만 것', () => {
  it('거절이 섞여 있으면 글이 함께 와도 거절이다', async () => {
    const output = [
      { type: 'message', content: [{ type: 'refusal', refusal: '거절합니다' }] },
      ...generateOutput(),
    ];
    const { result } = await send(() => okResponse(rawResponse(output)));
    assert.equal(result.outcome, 'model_refusal');
    assert.equal(JSON.stringify(result).includes('거절합니다'), false);
  });

  it('오다 말았으면 그렇게 끝낸다', async () => {
    const { result } = await send(() => okResponse(rawResponse(generateOutput(), { status: 'incomplete' })));
    assert.equal(result.outcome, 'response_incomplete');
  });
});

/* ================================================================== */
/* D. 비어 있거나 이상한 것                                             */
/* ================================================================== */

describe('실제로 보내는 자리 · D. 비어 있거나 이상한 것', () => {
  it('글이 하나도 없으면 비어 있는 것이다', async () => {
    const { result } = await send(() => okResponse(rawResponse([])));
    assert.equal(result.outcome, 'empty_response');
  });

  it('겉모양 자체가 이상하면 그 밖의 문제로 본다', async () => {
    for (const bad of [null, 'a string', [], 3, true]) {
      const { result } = await send(() => okResponse(bad));
      assert.equal(result.outcome, 'provider_error', JSON.stringify(bad));
    }
  });
});

/* ================================================================== */
/* E. 받아들여지지 않은 답                                              */
/* ================================================================== */

describe('실제로 보내는 자리 · E. 받아들여지지 않은 답', () => {
  const cases: [number, string][] = [
    [400, 'provider_error'],
    [401, 'provider_error'],
    [403, 'provider_error'],
    [404, 'provider_error'],
    [408, 'provider_timeout'],
    [429, 'provider_unavailable'],
    [500, 'provider_unavailable'],
    [503, 'provider_unavailable'],
  ];

  for (const [status, expected] of cases) {
    it(`${status} → ${expected}, 본문은 절대 열지 않는다`, async () => {
      const { result } = await send(() => nonOkResponse(status));
      assert.equal(result.outcome, expected, String(status));
    });
  }

  it('그 자리에서 본문을 열면 시험 자체가 실패로 끝난다', async () => {
    // nonOkResponse의 json()/text()는 호출되면 던진다.
    // 위 여덟 개 시험이 전부 통과했다는 것 자체가 한 번도 불리지 않았다는 증거다.
    for (const [status] of cases) {
      await assert.doesNotReject(() => send(() => nonOkResponse(status)));
    }
  });
});

/* ================================================================== */
/* F. 보내다 실패했을 때                                                */
/* ================================================================== */

describe('실제로 보내는 자리 · F. 보내다 실패했을 때', () => {
  it('우리가 끊은 것이 아니면 부를 수 없는 것으로 본다', async () => {
    const { result } = await send(() => {
      throw new Error('SIMULATED_CONNECTION_FAILURE_MESSAGE');
    });
    assert.equal(result.outcome, 'provider_unavailable');
  });

  it('우리가 끊었으면 시간 초과다', async () => {
    const { result } = await send(
      (call) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = call.init.signal as AbortSignal;
          signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
      { timeoutMs: 5 },
    );
    assert.equal(result.outcome, 'provider_timeout');
  });
});

/* ================================================================== */
/* G. 답의 본문을 읽다 실패했을 때                                      */
/* ================================================================== */

describe('실제로 보내는 자리 · G. 답의 본문을 읽다 실패했을 때', () => {
  it('시간과 무관하게 읽지 못했으면 그 밖의 문제다', async () => {
    const { result } = await send(
      () =>
        ({
          ok: true,
          json: async () => {
            throw new Error('SIMULATED_BODY_READ_FAILURE_MESSAGE');
          },
        }) as unknown as Response,
    );
    // 모델이 쓴 글을 못 읽은 것과 다른 일이다. json_parse_failed가 아니다.
    assert.equal(result.outcome, 'provider_error');
  });

  it('본문을 읽는 도중에 끊겼으면 시간 초과다', async () => {
    const { result } = await send(
      (call) =>
        ({
          ok: true,
          json: () =>
            new Promise((_resolve, reject) => {
              const signal = call.init.signal as AbortSignal;
              signal.addEventListener('abort', () => reject(new Error('aborted')));
            }),
        }) as unknown as Response,
      { timeoutMs: 5 },
    );
    assert.equal(result.outcome, 'provider_timeout');
  });
});

/* ================================================================== */
/* H. 시간과 다시 부르지 않음                                           */
/* ================================================================== */

describe('실제로 보내는 자리 · H. 시간과 다시 부르지 않음', () => {
  it('부르는 쪽이 준 시간을 그대로 쓴다', () => {
    const code = stripComments(read(TRANSPORT));
    assert.ok(code.includes('requestSpec.timeoutMs'));
    assert.equal(code.includes('60_000'), false);
    assert.equal(code.includes('60000'), false);
  });

  it('성공해도 실패해도 타이머를 치운다', async () => {
    const code = stripComments(read(TRANSPORT));
    assert.ok(code.includes('} finally {'));
    assert.equal((code.match(/clearTimeout\(timer\)/g) || []).length, 1);

    // 타이머가 남아 있으면 이 시험 자체가 끝나지 않는다.
    await send(() => okResponse(rawResponse(generateOutput())));
    await send(() => nonOkResponse(500));
    await send(() => {
      throw new Error('실패');
    });
  });

  it('오류의 이름으로 짐작하지 않는다', () => {
    const code = stripComments(read(TRANSPORT));
    for (const banned of ['AbortError', 'error.name', '.name ===', 'TimeoutError', 'signal.aborted']) {
      assert.equal(code.includes(banned), false, banned);
    }
    assert.ok(code.includes('timedOut = true'));
  });

  it('다시 보내는 코드가 없다', () => {
    const code = stripComments(read(TRANSPORT));
    for (const banned of ['for (', 'while (', 'retry', 'attempt', 'fallback', 'Promise.all']) {
      assert.equal(code.includes(banned), false, banned);
    }
    assert.equal((code.match(/doFetch\(/g) || []).length, 1);
  });

  it('2xx가 아니어도, 시간이 지나도 다시 보내지 않는다', async () => {
    const { calls: c1 } = await send(() => nonOkResponse(429));
    assert.equal(c1.length, 1);

    const { calls: c2 } = await send(
      (call) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = call.init.signal as AbortSignal;
          signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
      { timeoutMs: 5 },
    );
    assert.equal(c2.length, 1);
  });
});

/* ================================================================== */
/* I. 열쇠가 쓸 수 없을 때                                              */
/* ================================================================== */

describe('실제로 보내는 자리 · I. 열쇠가 쓸 수 없을 때', () => {
  it('없거나 잘못된 열쇠면 아예 보내지 않는다', async () => {
    for (const apiKey of [undefined, null, '', '   ', 123, {}]) {
      const { result, calls } = await send(() => okResponse(rawResponse(generateOutput())), { apiKey });
      assert.equal(result.outcome, 'provider_error', JSON.stringify(apiKey));
      assert.equal(calls.length, 0, JSON.stringify(apiKey));
    }
  });

  it('열쇠 형식을 새로 검사하지 않는다', () => {
    const code = stripComments(read(TRANSPORT));
    for (const banned of ['sk-', '.length <', '.length >', 'startsWith(']) {
      assert.equal(code.includes(banned), false, banned);
    }
  });

  it('환경변수를 읽지 않는다', () => {
    const code = stripComments(read(TRANSPORT));
    for (const banned of ['Deno.env', 'process.env', "'OPENAI_API_KEY'", 'Deno.serve', 'createClient', 'console.']) {
      assert.equal(code.includes(banned), false, banned);
    }
  });
});

/* ================================================================== */
/* J. 아무것도 새지 않는다                                              */
/* ================================================================== */

describe('실제로 보내는 자리 · J. 아무것도 새지 않는다', () => {
  it('결과 어디에도 열쇠·주소·오류 문구가 없다', async () => {
    const outcomes = await Promise.all([
      send(() => okResponse(rawResponse(generateOutput()))),
      send(() => nonOkResponse(500)),
      send(() => {
        throw new Error('SIMULATED_CONNECTION_FAILURE_MESSAGE');
      }),
      send(
        () =>
          ({
            ok: true,
            json: async () => {
              throw new Error('SIMULATED_BODY_READ_FAILURE_MESSAGE');
            },
          }) as unknown as Response,
      ),
      send(() => okResponse(rawResponse(generateOutput())), { apiKey: '' }),
    ]);

    const dumped = JSON.stringify(outcomes.map((o) => o.result));
    for (const banned of [
      FAKE_KEY,
      'Bearer',
      OPENAI_RESPONSES_URL,
      'api.openai.com',
      'SIMULATED_CONNECTION_FAILURE_MESSAGE',
      'SIMULATED_BODY_READ_FAILURE_MESSAGE',
      '500',
      '401',
    ]) {
      assert.equal(dumped.includes(banned), false, banned);
    }
  });

  it('실패 결과에는 사유 이름 하나만 남는다', async () => {
    const { result } = await send(() => nonOkResponse(500));
    assert.deepEqual(Object.keys(result), ['outcome']);
  });

  it('거절한 말과 생각한 흔적을 옮기지 않는다', async () => {
    const output = [
      { type: 'reasoning', summary: [{ type: 'summary_text', text: '이렇게 골랐습니다' }] },
      ...generateOutput(),
    ];
    const { result } = await send(() => okResponse(rawResponse(output)));
    assert.equal(result.outcome, 'validated_generate');
    assert.equal(JSON.stringify(result).includes('이렇게 골랐습니다'), false);
  });
});

/* ================================================================== */
/* K. 새 규칙을 만들지 않는다                                           */
/* ================================================================== */

describe('실제로 보내는 자리 · K. 새 규칙을 만들지 않는다', () => {
  it('숫자별 HTTP 규칙을 여기 다시 적지 않는다', () => {
    const code = stripComments(read(TRANSPORT));
    for (const banned of ['401', '403', '404', '408', '429', '500', '503', '>= 500', '<= 599']) {
      assert.equal(code.includes(banned), false, banned);
    }
    assert.ok(code.includes('classifyCandidateGenerationFetchFailure'));
  });

  it('답의 알맹이를 훑는 규칙을 여기 다시 적지 않는다', () => {
    const code = stripComments(read(TRANSPORT));
    for (const banned of ['output_text', "'refusal'", 'hasRefusal', 'item.content', 'part.content', 'output.map', 'output.find']) {
      assert.equal(code.includes(banned), false, banned);
    }
    assert.ok(code.includes('normalizeCandidateGenerationOpenAIHttpResponseForAdapter'));
    assert.ok(code.includes('interpretCandidateGenerationOpenAIResponse'));
  });

  it('검토 대상 글의 항목을 여기서 검사하지 않는다', () => {
    const code = stripComments(read(TRANSPORT));
    for (const banned of ['selectedPassageIndex', 'situationTags', 'misuseGuards', 'validateCandidateGenerationDraft']) {
      assert.equal(code.includes(banned), false, banned);
    }
  });

  it('보낼 것을 새로 만들지 않는다', () => {
    const code = stripComments(read(TRANSPORT));
    for (const banned of ['model:', 'reasoning', 'max_output_tokens', 'buildCandidateGenerationOpenAIRequestSpec']) {
      assert.equal(code.includes(banned), false, banned);
    }
  });
});
