/**
 * 기도 도움 · 계약 테스트
 *
 * 실행: npm test
 *
 * 지키려는 것:
 *   부르는 쪽이 보내는 것은 상황과 말씀 번호 둘뿐이다.
 *   안전 판단을 건너뛸 길이 없다.
 *   말씀 해설의 주인은 서버다.
 *   사용자가 적는 기도는 어디로도 가지 않는다.
 *   도움이 실패해도 기도를 막지 않는다.
 *
 * 실제 OpenAI·Supabase 호출은 하지 않는다.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  MAX_PRAYER_TEXT_LENGTH,
  PRAYER_GUIDANCE_FIELDS,
  PRAYER_GUIDANCE_MODEL,
  PRAYER_GUIDANCE_MODEL_TIMEOUT_MS,
  PRAYER_GUIDANCE_REQUEST_FIELDS,
  PRAYER_GUIDANCE_RETRY_COUNT,
  PRAYER_GUIDANCE_SCHEMA,
  PRAYER_GUIDANCE_TOTAL_BUDGET_MS,
  containsProhibitedPrayerPattern,
  buildPrayerGuidancePayload,
  parsePrayerGuidanceRequest,
  validatePrayerGuidance,
} from '../../supabase/functions/_shared/prayer-guidance-contract.ts';
import {
  handlePrayerGuidance,
  type PrayerGuidanceDeps,
} from '../../supabase/functions/generate-prayer-guidance/handler.ts';
import { getScriptureCard, SCRIPTURE_CARDS } from '../../supabase/functions/_shared/scripture-cards.ts';
import { MODEL as ANALYZER_MODEL } from '../../supabase/functions/_shared/analyzer-contract.ts';
import { requestPrayerGuidance, parsePrayerGuidanceResponse } from './request-prayer-guidance.ts';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '');

const CONTRACT = '../../supabase/functions/_shared/prayer-guidance-contract.ts';
const HANDLER = '../../supabase/functions/generate-prayer-guidance/handler.ts';
const INDEX = '../../supabase/functions/generate-prayer-guidance/index.ts';
const HELPER = './request-prayer-guidance.ts';
const PRAYER_SCREEN = '../app/prayer.tsx';

/* ------------------------------------------------------------------ */
/* fixture                                                             */
/* ------------------------------------------------------------------ */

/** 카드가 다루는 영역 그대로여야 gate가 recommend를 준다. */
const CARD = getScriptureCard('SC-001');
const SITUATION = '앞일이 어떻게 될지 몰라서 마음이 불안합니다.';

const analysis = (overrides: Record<string, unknown> = {}) => ({
  primaryDomain: CARD.domains[0],
  secondaryDomains: [],
  situationTags: [],
  emotionTags: [],
  spiritualQuestionTags: [],
  prayerModes: [],
  pastoralFunctions: [],
  safety: { level: 'normal', categories: [] },
  confidence: 0.8,
  ...overrides,
});

const analyzerResponse = (value: unknown) => ({
  output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }],
});

const goodGuidance = () => ({
  prayerText:
    '하나님, 지금 마음이 두렵고 불안합니다. 결과를 알 수 없는 이 순간에도 주님을 의지하게 하시고, 저를 붙드시는 손길을 신뢰하며 오늘을 살아가게 해주세요.',
});

const guidanceResponse = (value: unknown) => ({
  output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }],
});

type Options = {
  analysisOverrides?: Record<string, unknown>;
  guidance?: unknown;
  guidanceThrows?: boolean;
  apiKey?: string | undefined;
  quota?: 'allowed' | 'limited' | 'unavailable';
  body?: unknown;
  cardId?: string;
  clock?: number[];
  /** 분석 호출이 답하지 않는 상황 */
  analyzerHangs?: boolean;
  /** 기도 도움 호출이 답하지 않는 상황 */
  guidanceHangs?: boolean;
  /** 사용량 확인이 답하지 않는 상황 */
  quotaHangs?: boolean;
  /** 분석 호출 자체가 실패하는 상황 */
  analyzerThrows?: boolean;
  /** 분석 답이 약속과 다른 상황 */
  analysisInvalid?: boolean;
  /** 전체 시계를 곧바로 울린다 */
  fireDeadline?: boolean;
  /** 신호를 무시하고 끝내 답하지 않는 요청 */
  ignoresSignal?: boolean;
};

const makeDeps = (options: Options = {}) => {
  const analyzerCalls: Record<string, unknown>[] = [];
  const guidanceCalls: { payload: Record<string, unknown>; timeoutMs: number }[] = [];
  const logged: string[] = [];
  const ticks = [...(options.clock ?? [])];
  let clock = 0;

  const quotaSignals: (AbortSignal | undefined)[] = [];
  const analyzerSignals: (AbortSignal | undefined)[] = [];
  const guidanceSignals: (AbortSignal | undefined)[] = [];
  let deadlineScheduledMs: number | null = null;
  let deadlineCancelled = false;

  /**
   * 답하지 않는 가짜 요청.
   *
   * 보통은 신호가 끊기면 함께 끝난다.
   * ignoresSignal이면 신호를 무시하고 영영 답하지 않는다.
   * 그때도 사용자가 갇히지 않아야 한다. 그것을 확인하기 위한 것이다.
   */
  const hang = <T,>(signal?: AbortSignal): Promise<T> =>
    new Promise<T>((_resolve, reject) => {
      if (options.ignoresSignal) return;
      if (!signal) return;
      if (signal.aborted) return reject(new Error('aborted'));
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });

  const deps: PrayerGuidanceDeps = {
    checkQuota: async (_request, quotaOptions) => {
      quotaSignals.push(quotaOptions?.signal);
      if (options.quotaHangs) return await hang<never>(quotaOptions?.signal);
      const status = options.quota ?? 'allowed';
      if (status === 'limited') return { status: 'limited', retryAfterSeconds: 30 };
      return { status } as { status: 'allowed' | 'unavailable' };
    },
    getApiKey: () => ('apiKey' in options ? options.apiKey : 'test-key'),
    callOpenAI: async (payload, _apiKey, callOptions) => {
      analyzerCalls.push(payload);
      analyzerSignals.push(callOptions?.signal);
      if (options.analyzerHangs) return await hang<unknown>(callOptions?.signal);
      if (options.analyzerThrows) throw new Error('openai_http_500');
      if (options.analysisInvalid) return analyzerResponse({ primaryDomain: '없는영역' });
      return analyzerResponse(analysis(options.analysisOverrides));
    },
    callGuidance: async (payload, _apiKey, callOptions) => {
      guidanceCalls.push({ payload, timeoutMs: callOptions.timeoutMs });
      guidanceSignals.push(callOptions.signal);
      if (options.guidanceHangs) return await hang<unknown>(callOptions.signal);
      if (options.guidanceThrows) throw new Error('openai_http_500');
      return guidanceResponse('guidance' in options ? options.guidance : goodGuidance());
    },
    scheduleDeadline: (onDeadline, ms) => {
      deadlineScheduledMs = ms;
      // 실제로 20초를 기다리지 않는다.
      // 다만 곧바로 울리면 아무것도 시작하기 전에 끝나 버리므로,
      // 기다리는 일들이 자리를 잡은 뒤에 울리게 한다.
      if (options.fireDeadline) setTimeout(onDeadline, 0);
      return () => {
        deadlineCancelled = true;
      };
    },
    now: () => {
      // 정해 준 값을 차례로 쓰고, 다 쓰면 마지막 값을 계속 돌려준다.
      if (ticks.length > 1) return ticks.shift() as number;
      if (ticks.length === 1) return ticks[0] as number;
      clock += 1;
      return clock;
    },
    log: (message) => logged.push(message),
    requestId: () => 'testreq',
  };

  return {
    deps,
    analyzerCalls,
    guidanceCalls,
    logged,
    quotaSignals,
    analyzerSignals,
    guidanceSignals,
    get deadlineScheduledMs() {
      return deadlineScheduledMs;
    },
    get deadlineCancelled() {
      return deadlineCancelled;
    },
  };
};

const run = async (options: Options = {}) => {
  const fake = makeDeps(options);
  const body =
    'body' in options
      ? options.body
      : { situation: SITUATION, cardId: options.cardId ?? CARD.id };

  const request = new Request('https://example.functions.supabase.co/generate-prayer-guidance', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer test' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

  const response = await handlePrayerGuidance(request, fake.deps);
  const parsed = (await response.json()) as Record<string, unknown>;
  return { ...fake, response, parsed };
};

/* ================================================================== */
/* A. 요청 계약                                                        */
/* ================================================================== */

describe('기도 도움 · A. 요청 계약', () => {
  it('보낼 수 있는 것은 두 가지뿐이다', () => {
    assert.deepEqual([...PRAYER_GUIDANCE_REQUEST_FIELDS], ['situation', 'cardId']);
  });

  it('올바른 요청은 통과한다', () => {
    const parsed = parsePrayerGuidanceRequest({ situation: SITUATION, cardId: CARD.id });
    assert.equal(parsed.ok, true);
  });

  it('모르는 항목이 붙으면 거절한다', async () => {
    for (const extra of [
      { prayer: '제가 적은 기도입니다' },
      { userExplanation: '내가 쓴 해설' },
      { prayerDirection: '내가 쓴 기도 방향' },
      { safety: { level: 'normal' } },
      { analysis: {} },
      { eligibleCardIds: ['SC-001'] },
    ]) {
      const parsed = parsePrayerGuidanceRequest({
        situation: SITUATION,
        cardId: CARD.id,
        ...extra,
      });
      assert.equal(parsed.ok, false, JSON.stringify(extra));
    }
  });

  it('빠진 항목이 있으면 거절한다', () => {
    assert.equal(parsePrayerGuidanceRequest({ situation: SITUATION }).ok, false);
    assert.equal(parsePrayerGuidanceRequest({ cardId: CARD.id }).ok, false);
    assert.equal(parsePrayerGuidanceRequest({}).ok, false);
  });

  it('모양이 아닌 값은 거절한다', () => {
    for (const bad of [null, undefined, [], '문자열', 42, true]) {
      assert.equal(parsePrayerGuidanceRequest(bad).ok, false, String(bad));
    }
    assert.equal(parsePrayerGuidanceRequest({ situation: '  ', cardId: CARD.id }).ok, false);
    assert.equal(parsePrayerGuidanceRequest({ situation: SITUATION, cardId: 42 }).ok, false);
  });

  it('모르는 말씀 번호면 모델을 부르지 않는다', async () => {
    const { response, parsed, analyzerCalls, guidanceCalls } = await run({ cardId: 'SC-999' });
    assert.equal(response.status, 503);
    assert.equal(parsed.error, 'PRAYER_GUIDANCE_UNAVAILABLE');
    assert.equal(analyzerCalls.length, 0);
    assert.equal(guidanceCalls.length, 0);
  });

  it('문장 길이는 기존 분석기 규칙이 본다', () => {
    const contract = stripComments(read(CONTRACT));
    // 길이 한도를 여기서 새로 만들지 않는다.
    assert.equal(contract.includes('MAX_SITUATION_LENGTH'), false);
    const handler = stripComments(read(HANDLER));
    assert.ok(handler.includes('analyzeSituationRequest(request, analysisDeps)'));
  });
});

/* ================================================================== */
/* B. 응답 계약                                                        */
/* ================================================================== */

describe('기도 도움 · B. 응답 계약', () => {
  it('받는 것은 prayerText 하나뿐이다', () => {
    assert.deepEqual([...PRAYER_GUIDANCE_FIELDS], ['prayerText']);
  });

  it('올바른 결과는 통과한다', () => {
    const checked = validatePrayerGuidance(goodGuidance());
    assert.equal(checked.ok, true);
    if (!checked.ok) return;
    assert.equal(checked.guidance.prayerText, goodGuidance().prayerText);
  });

  it('앞뒤 공백은 다듬는다', () => {
    const padded = { prayerText: `  ${goodGuidance().prayerText}  ` };
    const checked = validatePrayerGuidance(padded);
    assert.equal(checked.ok, true);
    if (!checked.ok) return;
    assert.equal(checked.guidance.prayerText, goodGuidance().prayerText);
  });

  it('빈 글은 거절한다', () => {
    assert.equal(validatePrayerGuidance({ prayerText: '' }).ok, false);
    assert.equal(validatePrayerGuidance({ prayerText: '   ' }).ok, false);
  });

  it('문자열이 아니면 거절한다', () => {
    for (const bad of [null, undefined, 42, true, [], {}]) {
      assert.equal(validatePrayerGuidance({ prayerText: bad }).ok, false, String(bad));
    }
  });

  it('모양이 object가 아니면 거절한다', () => {
    for (const bad of [null, undefined, [], '문자열', 42, true]) {
      assert.equal(validatePrayerGuidance(bad).ok, false, String(bad));
    }
  });

  it('모르는 항목이 붙으면 거절한다', () => {
    for (const extra of [
      { prayerText: goodGuidance().prayerText, intro: '안내' },
      { prayerText: goodGuidance().prayerText, steps: [] },
      { prayerText: goodGuidance().prayerText, title: '제목' },
    ]) {
      assert.equal(validatePrayerGuidance(extra).ok, false, JSON.stringify(extra));
    }
  });

  it('예전 3단계 모양은 거절한다', () => {
    const oldShape = {
      intro: '지금 마음에 있는 것을 그대로 말씀드려 보세요.',
      steps: [{ kind: 'tell', prompt: '말씀드려 보세요.', starter: null }],
    };
    assert.equal(validatePrayerGuidance(oldShape).ok, false);
  });

  it('너무 긴 글은 거절한다', () => {
    const tooLong = { prayerText: '가'.repeat(MAX_PRAYER_TEXT_LENGTH + 1) };
    assert.equal(validatePrayerGuidance(tooLong).ok, false);
  });

  it('길이 상한 바로 그 값은 통과한다', () => {
    const exact = { prayerText: '가'.repeat(MAX_PRAYER_TEXT_LENGTH) };
    assert.equal(validatePrayerGuidance(exact).ok, true);
  });

  it('최소 길이 규칙은 두지 않는다(짧은 글도 통과)', () => {
    assert.equal(validatePrayerGuidance({ prayerText: '하나님, 감사합니다.' }).ok, true);
  });

  it('성공 응답의 모양이 정해져 있다', async () => {
    const { response, parsed } = await run();
    assert.equal(response.status, 200);
    assert.equal(parsed.ok, true);
    assert.deepEqual(Object.keys(parsed).sort(), ['guidance', 'ok']);
    const guidance = parsed.guidance as Record<string, unknown>;
    assert.deepEqual(Object.keys(guidance).sort(), ['prayerText']);
  });
});

/* ================================================================== */
/* B-2. 생성 뒤 마지막 안전판                                            */
/* ================================================================== */

describe('기도 도움 · B-2. 생성 뒤 마지막 안전판', () => {
  it('하나님이 개인에게 직접 말씀하신 것처럼 선언하면 막는다', () => {
    for (const bad of [
      '하나님이 당신에게 이 일을 그만두라고 말씀하십니다.',
      '하나님께서 당신에게 새로운 길을 보이셨습니다.',
    ]) {
      assert.equal(containsProhibitedPrayerPattern(bad), true, bad);
    }
  });

  it('"반드시" 근처의 결과 보장 표현을 막는다', () => {
    for (const bad of ['반드시 잘 될 것입니다.', '반드시 병이 나을 것입니다.', '반드시 해결될 것입니다.']) {
      assert.equal(containsProhibitedPrayerPattern(bad), true, bad);
    }
  });

  it('평범한 신뢰·지혜 기도는 막지 않는다', () => {
    for (const ok of [
      goodGuidance().prayerText,
      '하나님, 제가 결과를 붙들려 하기보다 주님을 신뢰하게 해주세요.',
      '지금 이 기쁨을 주셔서 감사드립니다.',
      '이 일을 반드시 제 힘으로만 해내려 하지 않게 해주세요.',
    ]) {
      assert.equal(containsProhibitedPrayerPattern(ok), false, ok);
    }
  });

  it('거대한 금칙어 사전이 아니라 좁은 패턴 두 개뿐이다', () => {
    const contract = stripComments(read(CONTRACT));
    const match = contract.match(/PROHIBITED_PRAYER_PATTERNS[\s\S]*?=\s*\[([\s\S]*?)\];/);
    assert.ok(match, 'PROHIBITED_PRAYER_PATTERNS를 찾지 못했습니다.');
    const entries = (match![1].match(/^\s*\/.+\/,?\s*$/gm) || []).length;
    assert.equal(entries, 2);
  });

  it('안전판에 걸리면 재시도하지 않고 다른 실패와 같은 답을 낸다', async () => {
    const { response, parsed, guidanceCalls } = await run({
      guidance: { prayerText: '하나님이 당신에게 반드시 그 일을 이루어 주실 것입니다.' },
    });
    assert.equal(response.status, 503);
    assert.deepEqual(parsed, { ok: false, error: 'PRAYER_GUIDANCE_UNAVAILABLE' });
    assert.equal(guidanceCalls.length, 1);
  });
});

/* ================================================================== */
/* C. 안전과 신뢰 경계                                                  */
/* ================================================================== */

describe('기도 도움 · C. 안전이 먼저다', () => {
  it('안전이 먼저인 상황이면 기도 도움을 만들지 않는다', async () => {
    const { response, parsed, guidanceCalls } = await run({
      analysisOverrides: { safety: { level: 'urgent', categories: ['self_harm'] } },
    });
    assert.equal(response.status, 503);
    assert.equal(parsed.error, 'PRAYER_GUIDANCE_UNAVAILABLE');
    assert.equal(guidanceCalls.length, 0);
  });

  it('지금 다룰 수 없는 영역이면 만들지 않는다', async () => {
    const { guidanceCalls, response } = await run({
      analysisOverrides: { primaryDomain: 'other_uncovered' },
    });
    assert.equal(response.status, 503);
    assert.equal(guidanceCalls.length, 0);
  });

  it('왜 막혔는지 밖으로 나누지 않는다', async () => {
    const safety = await run({
      analysisOverrides: { safety: { level: 'urgent', categories: ['self_harm'] } },
    });
    const coverage = await run({ analysisOverrides: { primaryDomain: 'other_uncovered' } });
    const failed = await run({ guidanceThrows: true });

    // 셋 다 같은 답이어야 한다. 다르면 안전 판정이 밖에서 보인다.
    assert.deepEqual(safety.parsed, coverage.parsed);
    assert.deepEqual(safety.parsed, failed.parsed);
    assert.equal(safety.response.status, coverage.response.status);
  });

  it('앱의 화면 순서를 믿지 않고 서버가 다시 살핀다', () => {
    const handler = stripComments(read(HANDLER));
    assert.ok(handler.includes('analyzeSituationRequest(request, analysisDeps)'));
    assert.ok(handler.includes('runRecommendationGate(analyzed.analysis)'));
    assert.ok(handler.includes("gate.route !== 'recommend'"));
    // 새 안전 규칙을 만들지 않는다.
    assert.equal(handler.includes('self_harm'), false);
    assert.equal(handler.includes('SAFETY_LEVELS'), false);
  });

  it('지금 상황에 맞는 말씀이 아니면 만들지 않는다', async () => {
    // 다른 영역으로 분석되면 이 카드는 후보가 아니다.
    const other = SCRIPTURE_CARDS.find((c) => c.domains[0] !== CARD.domains[0]);
    assert.ok(other);
    const { response, guidanceCalls } = await run({
      analysisOverrides: { primaryDomain: other!.domains[0] },
    });
    assert.equal(response.status, 503);
    assert.equal(guidanceCalls.length, 0);
  });

  it('아무 말씀으로도 대신하지 않는다', () => {
    const handler = stripComments(read(HANDLER));
    assert.equal(handler.includes('SC-001'), false);
    assert.equal(/SCRIPTURE_CARDS\[0\]/.test(handler), false);
    assert.equal(handler.includes('selectedCardId'), false);
    // 후보 목록으로 확인하고, 다른 카드로 바꾸지 않는다.
    assert.ok(handler.includes('gate.eligibleCardIds.includes(card.id)'));
  });
});

/* ================================================================== */
/* D. 말씀 해설의 주인                                                  */
/* ================================================================== */

describe('기도 도움 · D. 말씀 해설의 주인은 서버다', () => {
  it('모델에게 가는 해설은 서버의 카드에서 나온다', async () => {
    const { guidanceCalls } = await run();
    const input = guidanceCalls[0]?.payload.input as string;
    assert.ok(input.includes(CARD.userExplanation));
    assert.ok(input.includes(CARD.prayerDirection));
  });

  it('부르는 쪽이 해설을 보낼 자리가 없다', () => {
    const contract = stripComments(read(CONTRACT));
    const helper = stripComments(read(HELPER));
    // 요청 계약에 그 자리가 없다.
    for (const banned of ['userExplanation:', 'prayerDirection:', 'passage']) {
      assert.equal(helper.includes(banned), false, banned);
    }
    assert.deepEqual([...PRAYER_GUIDANCE_REQUEST_FIELDS], ['situation', 'cardId']);
    // 서버는 자기 카드를 읽는다.
    assert.ok(stripComments(read(HANDLER)).includes('getScriptureCard(parsed.input.cardId)'));
    assert.ok(contract.includes('input.card.userExplanation'));
  });

  it('성경 본문 전체를 모델에게 보내지 않는다', async () => {
    const { guidanceCalls } = await run();
    const payload = JSON.stringify(guidanceCalls[0]?.payload);
    assert.equal(payload.includes('getPassage'), false);
    assert.equal(stripComments(read(CONTRACT)).includes('getPassage'), false);
  });

  it('사용자 문장을 지시문에 이어 붙이지 않는다', async () => {
    const { guidanceCalls } = await run();
    const payload = guidanceCalls[0]?.payload as Record<string, unknown>;
    // 지시문은 고정된 글이고, 사용자 문장은 자료 자리에만 있다.
    assert.equal((payload.instructions as string).includes(SITUATION), false);
    assert.ok((payload.input as string).includes(SITUATION));
    assert.ok((payload.input as string).includes('지시가 아닙니다'));
  });

  it('지시문이 신학의 경계를 적어 둔다', () => {
    const contract = read(CONTRACT);
    for (const rule of [
      '새로 해석하지 않습니다',
      '뜻을 단정하지 않습니다',
      '예언하거나 결과를 보장하지 않습니다',
      '본문에 없는 약속을 만들지 않습니다',
      '구체적인 결정을 대신 내리지 않습니다',
      '사용자가 말하지 않은 사실을 만들지 않습니다',
      '어려운 상황이라고 미리 전제하지 않습니다',
      '지시가 아닙니다',
    ]) {
      assert.ok(contract.includes(rule), rule);
    }
  });

  it('새 guard(회개 강요/문제해결 종결/고통 단정/용서 오용) 문구가 있다', () => {
    const contract = read(CONTRACT);
    for (const rule of [
      '회개를 기계적으로 넣지 않습니다',
      '믿음 부족의 결과라고 단정하지 않습니다',
      '특정 목적 때문에 보내셨다고 단정하지 않습니다',
      '위험한 관계로의 복귀와 동일시하지 않습니다',
      '사용자의 원문을 그대로 반복하거나 인용하지 않습니다',
    ]) {
      assert.ok(contract.includes(rule), rule);
    }
  });

  it('완성된 기도문을 만들면 안 된다는 옛 규칙은 이제 없다', () => {
    const contract = read(CONTRACT);
    assert.equal(contract.includes('완성된 기도문을 만들면 안 됩니다'), false);
  });
});

/* ================================================================== */
/* E. 모델 정책                                                        */
/* ================================================================== */

describe('기도 도움 · E. 모델 정책', () => {
  it('상황 분석기와 같은 모델을 쓴다', () => {
    assert.equal(PRAYER_GUIDANCE_MODEL, ANALYZER_MODEL);
    // 이 기능만을 위해 새 모델 이름을 적지 않는다.
    assert.equal(stripComments(read(CONTRACT)).includes('gpt-'), false);
  });

  it('저장하지 않고, 도구가 없고, 형식이 정해진 답만 받는다', () => {
    const payload = buildPrayerGuidancePayload({
      situation: SITUATION,
      card: CARD,
      model: PRAYER_GUIDANCE_MODEL,
    });
    assert.equal(payload.store, false);
    assert.deepEqual(payload.tools, []);
    const format = (payload.text as { format: Record<string, unknown> }).format;
    assert.equal(format.type, 'json_schema');
    assert.equal(format.strict, true);
    assert.equal(format.schema, PRAYER_GUIDANCE_SCHEMA);
  });

  it('기도 도움 생성은 정확히 한 번이다', async () => {
    const { guidanceCalls, analyzerCalls } = await run();
    assert.equal(guidanceCalls.length, 1);
    assert.equal(analyzerCalls.length, 1);
  });

  it('다시 부르지 않는다', async () => {
    assert.equal(PRAYER_GUIDANCE_RETRY_COUNT, 0);

    for (const source of [HANDLER, INDEX, HELPER]) {
      const code = stripComments(read(source));
      for (const banned of ['retry', 'attempt', 'fallbackModel', 'while (']) {
        assert.equal(code.includes(banned), false, `${source}: ${banned}`);
      }
    }

    // 부르는 자리가 각각 한 곳뿐이다.
    assert.equal((stripComments(read(HANDLER)).match(/deps\.callGuidance\(/g) || []).length, 1);
    assert.equal(
      (stripComments(read(HELPER)).match(/deps\.invokePrayerGuidance\(/g) || []).length,
      1,
    );

    // 실패해도 두 번째 요청이 없다.
    let calls = 0;
    await requestPrayerGuidance(
      { situation: SITUATION, cardId: CARD.id },
      {
        invokePrayerGuidance: async () => {
          calls += 1;
          return { ok: false };
        },
      },
    );
    assert.equal(calls, 1);

    const failed = await run({ guidanceThrows: true });
    assert.equal(failed.guidanceCalls.length, 1);
  });

  it('정해진 시간만 기다린다', async () => {
    assert.equal(PRAYER_GUIDANCE_MODEL_TIMEOUT_MS, 8_000);
    assert.equal(PRAYER_GUIDANCE_TOTAL_BUDGET_MS, 20_000);

    const { guidanceCalls } = await run();
    assert.ok((guidanceCalls[0]?.timeoutMs ?? 0) <= PRAYER_GUIDANCE_MODEL_TIMEOUT_MS);

    // 바깥층이 실제로 요청을 끊는다.
    const index = stripComments(read(INDEX));
    assert.ok(index.includes('AbortController'));
    assert.ok(index.includes('signal: controller.signal'));
    assert.ok(index.includes('clearTimeout(timer)'));
  });

  it('전체 시간을 넘기면 모델을 부르지 않는다', async () => {
    // 시작한 뒤 이미 예산을 다 썼다.
    const { guidanceCalls, analyzerCalls, response, parsed } = await run({
      clock: [0, PRAYER_GUIDANCE_TOTAL_BUDGET_MS + 1],
    });
    assert.equal(analyzerCalls.length, 0);
    assert.equal(guidanceCalls.length, 0);
    assert.equal(response.status, 503);
    assert.deepEqual(parsed, { ok: false, error: 'PRAYER_GUIDANCE_UNAVAILABLE' });
  });

  it('남은 시간이 짧으면 그만큼만 기다린다', async () => {
    const { guidanceCalls } = await run({
      clock: [0, PRAYER_GUIDANCE_TOTAL_BUDGET_MS - 2_000],
    });
    assert.equal(guidanceCalls[0]?.timeoutMs, 2_000);
  });
});

/* ================================================================== */
/* F. 사용량 한도                                                      */
/* ================================================================== */

describe('기도 도움 · F. 사용량 한도', () => {
  it('기존 한도를 그대로 쓴다', () => {
    const index = stripComments(read(INDEX));
    assert.ok(index.includes('createSupabaseQuotaChecker'));
    // 새 한도 표나 우회 경로를 만들지 않는다.
    assert.equal(index.includes('migration'), false);
    assert.equal(index.includes('hour_limit'), false);
    assert.equal(stripComments(read(HANDLER)).includes('skipQuota'), false);
  });

  it('한도에 걸리면 모델을 부르지 않는다', async () => {
    const { response, parsed, guidanceCalls } = await run({ quota: 'limited' });
    // 한도에 걸렸다는 사실도 밖으로 나누지 않는다. 답은 언제나 하나다.
    assert.equal(response.status, 503);
    assert.deepEqual(parsed, { ok: false, error: 'PRAYER_GUIDANCE_UNAVAILABLE' });
    assert.equal(guidanceCalls.length, 0);
  });

  it('한도를 확인하지 못하면 통과시키지 않는다', async () => {
    const { response, guidanceCalls } = await run({ quota: 'unavailable' });
    assert.equal(response.status, 503);
    assert.equal(guidanceCalls.length, 0);
  });
});

/* ================================================================== */
/* G. 개인정보                                                         */
/* ================================================================== */

describe('기도 도움 · G. 사용자가 적는 기도는 가지 않는다', () => {
  it('요청을 만드는 함수가 기도를 받을 자리가 없다', () => {
    const helper = stripComments(read(HELPER));
    // prayerText는 서버가 만든 결과를 담는 응답 필드일 뿐이다.
    // 요청 쪽(invokePrayerGuidance로 보내는 값)에는 사용자 draft를 받을 자리가 없어야 한다.
    for (const banned of ['prayerDraft', 'draft']) {
      assert.equal(helper.includes(banned), false, banned);
    }
    const requestBody = helper.split('invokePrayerGuidance({')[1]?.split('});')[0] ?? '';
    assert.notEqual(requestBody, '');
    assert.equal(requestBody.includes('prayerText'), false, requestBody);
    // 보내는 값은 둘뿐이다.
    assert.ok(helper.includes('situation: input.situation'));
    assert.ok(helper.includes('cardId: input.cardId'));
  });

  it('화면이 기도 입력을 서버로 넘기지 않는다', () => {
    const screen = stripComments(read(PRAYER_SCREEN));
    // 요청에 넘기는 값에 기도가 없다.
    const call = screen.split('requestPrayerGuidance(')[1]?.split(');')[0] ?? '';
    assert.notEqual(call, '');
    assert.equal(call.includes('prayer'), false, call);
    assert.ok(call.includes('situation'));
    assert.ok(call.includes('cardId'));
  });

  it('저장하거나 기록하지 않는다', () => {
    const screen = stripComments(read(PRAYER_SCREEN));
    for (const banned of ['AsyncStorage', 'SecureStore', 'localStorage', 'console.', 'analytics']) {
      assert.equal(screen.includes(banned), false, banned);
    }
    for (const source of [HANDLER, CONTRACT, HELPER]) {
      assert.equal(stripComments(read(source)).includes('console.'), false, source);
    }
  });

  it('로그에 문장과 말씀 자료가 남지 않는다', async () => {
    const { logged } = await run();
    for (const line of logged) {
      assert.equal(line.includes(SITUATION), false, line);
      assert.equal(line.includes(CARD.userExplanation), false, line);
      assert.equal(line.includes(CARD.prayerDirection), false, line);
    }
  });

  it('실패 응답에 원본 오류나 모델 답이 없다', async () => {
    const { parsed } = await run({ guidanceThrows: true });
    assert.deepEqual(parsed, { ok: false, error: 'PRAYER_GUIDANCE_UNAVAILABLE' });
    const text = JSON.stringify(parsed);
    for (const banned of ['openai_http_500', SITUATION, CARD.userExplanation, 'safety', 'eligible']) {
      assert.equal(text.includes(banned), false, banned);
    }
  });
});

/* ================================================================== */
/* H. 실패해도 기도를 막지 않는다                                        */
/* ================================================================== */

describe('기도 도움 · H. 실패해도 기도를 막지 않는다', () => {
  it('서버가 답하지 않으면 쓸 수 없음으로 끝난다', async () => {
    const outcome = await requestPrayerGuidance(
      { situation: SITUATION, cardId: CARD.id },
      { invokePrayerGuidance: async () => ({ ok: false }) },
    );
    assert.deepEqual(outcome, { status: 'unavailable' });
  });

  it('부르다 터져도 예외를 밖으로 던지지 않는다', async () => {
    const outcome = await requestPrayerGuidance(
      { situation: SITUATION, cardId: CARD.id },
      {
        invokePrayerGuidance: async () => {
          throw new Error('network');
        },
      },
    );
    assert.deepEqual(outcome, { status: 'unavailable' });
  });

  it('약속과 다른 답은 쓰지 않는다', () => {
    for (const bad of [
      null,
      {},
      { ok: false },
      { ok: true },
      { ok: true, guidance: {} },
      { ok: true, guidance: { prayerText: '' } },
      { ok: true, guidance: { prayerText: '   ' } },
      { ok: true, guidance: { intro: '안내', steps: [] } },
      { ok: true, guidance: { intro: '안내', steps: [{ kind: 'hold', prompt: 'a', starter: null }] } },
    ]) {
      assert.equal(parsePrayerGuidanceResponse(bad), null, JSON.stringify(bad));
    }
  });

  it('화면은 실패하면 기도 방향을 솔직하게 보여준다', () => {
    const screen = stripComments(read(PRAYER_SCREEN));

    // 도움을 받지 못한 경우가 실제로 fallback으로 이어져야 한다.
    // 타입에 이름이 적혀 있는 것만으로는 부족하다.
    const mapping = screen
      .split('setGuidanceState(')
      .slice(1)
      .map((part) => part.split(');')[0] ?? '')
      .find((part) => part.includes('outcome.status'));
    assert.ok(mapping, '받아 온 결과를 상태로 옮기는 자리를 찾지 못했습니다.');
    assert.ok(mapping!.includes("outcome.status === 'guidance'"), mapping);
    assert.ok(mapping!.includes(": { status: 'fallback' }"), mapping);

    // 기도문을 준비하지 못했다고 솔직히 말하고, prayerDirection을 기도문인 척 보여주지 않는다.
    assert.ok(screen.includes('지금은 기도문을 준비하지 못했어요'));
    assert.ok(screen.includes('기도 방향'));
    assert.ok(screen.includes('card.prayerDirection'));
    assert.equal(screen.includes('GUIDE_STEPS'), false);
    // 오류 화면으로 보내지 않는다.
    assert.equal(screen.includes("router.push('/error"), false);
    assert.equal(screen.includes('오류'), false);
    assert.equal(screen.includes('실패'), false);
  });

  it('기다리는 동안 보여줄 말이 있고, AI라고 말하지 않는다', () => {
    const screen = stripComments(read(PRAYER_SCREEN));
    assert.ok(screen.includes("status: 'loading'"));
    assert.ok(screen.includes('잠시 함께 정리하고 있어요'));
    for (const banned of ['AI', '생성 중', 'GPT', '인공지능']) {
      assert.equal(screen.includes(banned), false, banned);
    }
  });
});

/* ================================================================== */
/* I. 화면 동작                                                        */
/* ================================================================== */

describe('기도 도움 · I. 화면 동작', () => {
  const screen = stripComments(read(PRAYER_SCREEN));

  it('직접 기도하는 길에서는 서버를 부르지 않는다', () => {
    assert.ok(screen.includes("if (mode !== 'guided') return;"));
  });

  it('한 번 들어올 때 한 번만 부른다', () => {
    assert.ok(screen.includes('askedRef'));
    assert.ok(screen.includes('if (askedRef.current) return;'));
    assert.ok(screen.includes('askedRef.current = true;'));
  });

  it('화면을 벗어난 뒤에는 상태를 바꾸지 않는다', () => {
    assert.ok(screen.includes('let alive = true;'));
    assert.ok(screen.includes('if (!alive) return;'));
    assert.ok(screen.includes('alive = false;'));
  });

  it('성공하면 생성된 기도문을 읽기 전용으로 보여준다', () => {
    assert.ok(screen.includes("guidanceState.status === 'guidance'"));
    assert.ok(screen.includes('guidanceState.guidance.prayerText'));
    // 3단계로 나누어 보여주던 옛 구조가 남아 있지 않다.
    assert.equal(screen.includes('.steps.map'), false);
    assert.equal(screen.includes('step.prompt'), false);
    assert.equal(screen.includes('step.starter'), false);
  });

  it('도움 뒤에 사용자가 적는 자리가 그대로 있다', () => {
    assert.equal((screen.match(/<TextInput/g) || []).length, 1);
    assert.ok(screen.indexOf('<TextInput') > screen.indexOf('guidanceState.guidance.prayerText'));
  });

  it('v1-A의 약속이 그대로다', () => {
    assert.ok(screen.includes('기도 마치기'));
    assert.ok(screen.includes('오늘의 기도를 마쳤어요'));
    assert.ok(screen.includes('처음으로 돌아가기'));
    assert.ok(screen.includes('먼저 함께 붙들 말씀을 찾아볼게요'));
    assert.equal(screen.includes('SC-001'), false);
    // 빈 입력이어도 마칠 수 있다.
    assert.equal(/disabled=\{[^}]*prayer/.test(screen), false);
  });
});

/* ================================================================== */
/* J. 밖으로 나가는 답은 하나뿐이다                                     */
/* ================================================================== */

describe('기도 도움 · J. 밖으로 나가는 답은 하나뿐이다', () => {
  /** 분석기가 만드는 실패는 여러 가지다. 그중 어느 것도 밖으로 나가면 안 된다. */
  const analyzerFailures: [string, Options][] = [
    ['사용량 제한', { quota: 'limited' }],
    ['사용량 확인 불가', { quota: 'unavailable' }],
    ['API Key 없음', { apiKey: undefined }],
    ['분석 호출 실패', { analyzerThrows: true }],
    ['분석 답이 약속과 다름', { analysisInvalid: true }],
    ['본문이 JSON이 아님', { body: '{{{' }],
  ];

  for (const [label, options] of analyzerFailures) {
    it(`밖으로는 같은 답이다 — ${label}`, async () => {
      const { response, parsed } = await run(options);
      assert.equal(response.status, 503, label);
      assert.deepEqual(parsed, { ok: false, error: 'PRAYER_GUIDANCE_UNAVAILABLE' }, label);
    });
  }

  it('분석기 내부 사유가 응답에 섞이지 않는다', async () => {
    for (const [, options] of analyzerFailures) {
      const { parsed } = await run(options);
      const text = JSON.stringify(parsed);
      for (const leaked of [
        'RATE_LIMITED',
        'RATE_LIMIT_UNAVAILABLE',
        'OPENAI_API_KEY_MISSING',
        'OPENAI_REQUEST_FAILED',
        'INVALID_ANALYSIS_RESPONSE',
        'INVALID_JSON',
        'INVALID_INPUT',
        'METHOD_NOT_ALLOWED',
      ]) {
        assert.equal(text.includes(leaked), false, leaked);
      }
    }
  });

  it('사용량 제한이어도 Retry-After를 흘리지 않는다', async () => {
    const { response } = await run({ quota: 'limited' });
    assert.equal(response.headers.get('Retry-After'), null);
  });

  it('분석기 응답을 그대로 내보내는 자리가 없다', () => {
    const handler = stripComments(read(HANDLER));
    assert.equal(handler.includes('return analyzed.response'), false);
    assert.ok(handler.includes("return unavailable('prayer_guidance_analysis_failed')"));
  });

  it('막힌 까닭 넷이 모두 같은 답이다', async () => {
    const results = await Promise.all([
      run({ quota: 'limited' }),
      run({ analysisOverrides: { safety: { level: 'urgent', categories: ['self_harm'] } } }),
      run({ analysisOverrides: { primaryDomain: 'other_uncovered' } }),
      run({ guidanceThrows: true }),
    ]);
    for (const r of results) {
      assert.equal(r.response.status, 503);
      assert.deepEqual(r.parsed, results[0]!.parsed);
    }
  });
});

/* ================================================================== */
/* K. 전체 20초가 진짜 마감이다                                         */
/* ================================================================== */

describe('기도 도움 · K. 전체 20초가 진짜 마감이다', () => {
  it('시작하자마자 전체 시계를 건다', async () => {
    const fake = await run();
    assert.equal(fake.deadlineScheduledMs, PRAYER_GUIDANCE_TOTAL_BUDGET_MS);
  });

  it('끝나면 시계를 치운다', async () => {
    const ok = await run();
    assert.equal(ok.deadlineCancelled, true);
    const failed = await run({ guidanceThrows: true });
    assert.equal(failed.deadlineCancelled, true);
  });

  it('사용량 확인이 늦어도 마감에서 끝난다', async () => {
    const { response, parsed, analyzerCalls, guidanceCalls } = await run({
      quotaHangs: true,
      fireDeadline: true,
    });
    assert.equal(response.status, 503);
    assert.deepEqual(parsed, { ok: false, error: 'PRAYER_GUIDANCE_UNAVAILABLE' });
    // 사용량 확인에서 멈췄으므로 모델은 한 번도 부르지 않았다.
    assert.equal(analyzerCalls.length, 0);
    assert.equal(guidanceCalls.length, 0);
  });

  it('분석이 늦어도 마감에서 끝나고 기도 도움은 부르지 않는다', async () => {
    const { response, parsed, analyzerCalls, guidanceCalls } = await run({
      analyzerHangs: true,
      fireDeadline: true,
    });
    assert.equal(response.status, 503);
    assert.deepEqual(parsed, { ok: false, error: 'PRAYER_GUIDANCE_UNAVAILABLE' });
    assert.equal(analyzerCalls.length, 1);
    assert.equal(guidanceCalls.length, 0);
  });

  it('기도 도움이 늦어도 마감에서 끝난다', async () => {
    const { response, parsed, guidanceCalls } = await run({
      guidanceHangs: true,
      fireDeadline: true,
    });
    assert.equal(response.status, 503);
    assert.deepEqual(parsed, { ok: false, error: 'PRAYER_GUIDANCE_UNAVAILABLE' });
    assert.equal(guidanceCalls.length, 1);
  });

  it('마감이 되면 나가 있는 요청을 실제로 끊는다', async () => {
    const fake = await run({ quotaHangs: true, fireDeadline: true });
    const signal = fake.quotaSignals[0];
    assert.ok(signal, '사용량 확인에 신호가 가지 않았습니다.');
    assert.equal(signal!.aborted, true);
  });

  it('세 바깥 연결이 모두 같은 신호를 받는다', async () => {
    const fake = await run();
    assert.ok(fake.quotaSignals[0], '사용량 확인에 신호 없음');
    assert.ok(fake.analyzerSignals[0], '분석 호출에 신호 없음');
    assert.ok(fake.guidanceSignals[0], '기도 도움 호출에 신호 없음');
    // 하나의 시계가 셋을 함께 끊는다.
    assert.equal(fake.quotaSignals[0], fake.analyzerSignals[0]);
    assert.equal(fake.analyzerSignals[0], fake.guidanceSignals[0]);
  });

  it('분석 호출도 남은 시간을 넘겨 기다리지 않는다', async () => {
    const fake = await run({ clock: [0, PRAYER_GUIDANCE_TOTAL_BUDGET_MS - 3_000] });
    // 분석기에 넘어간 시간은 개별 8초와 남은 시간 중 짧은 쪽이다.
    const handler = stripComments(read(HANDLER));
    assert.ok(handler.includes('timeoutMs: remainingTimeout()'));
    assert.ok(handler.includes('Math.min(PRAYER_GUIDANCE_MODEL_TIMEOUT_MS, remaining)'));
    assert.equal(fake.guidanceCalls[0]?.timeoutMs, 3_000);
  });

  it('마감 뒤에도 다시 부르지 않는다', async () => {
    const fake = await run({ analyzerHangs: true, fireDeadline: true });
    assert.equal(fake.analyzerCalls.length, 1);
    assert.equal(fake.guidanceCalls.length, 0);
  });

  it('요청이 신호를 무시해도 사용자는 갇히지 않는다', async () => {
    // 바깥 연결이 취소를 듣지 않는 최악의 경우다.
    // 그때도 마감이 오면 함수는 답을 돌려주고 끝나야 한다.
    const { response, parsed } = await run({
      quotaHangs: true,
      ignoresSignal: true,
      fireDeadline: true,
    });
    assert.equal(response.status, 503);
    assert.deepEqual(parsed, { ok: false, error: 'PRAYER_GUIDANCE_UNAVAILABLE' });
  });

  it('마감 사유를 밖으로 알리지 않는다', async () => {
    const { parsed } = await run({ quotaHangs: true, fireDeadline: true });
    const text = JSON.stringify(parsed);
    for (const banned of ['TIMEOUT', 'DEADLINE', 'QUOTA', 'abort', 'budget']) {
      assert.equal(text.includes(banned), false, banned);
    }
  });

  it('바깥층이 전체 신호를 실제 요청에 잇는다', () => {
    const index = stripComments(read(INDEX));
    assert.ok(index.includes("options.signal.addEventListener('abort'"));
    assert.ok(index.includes('signal: controller.signal'));
    assert.ok(index.includes('clearTimeout(timer)'));
    // 이미 끊긴 뒤에는 보내지 않는다.
    assert.ok(index.includes('if (options.signal.aborted) throw new Error'));
  });

  it('사용량 확인도 신호를 실제 요청에 잇는다', () => {
    const rate = stripComments(read('../../supabase/functions/_shared/rate-limit.ts'));
    assert.ok(rate.includes('options?.signal ? { signal: options.signal } : {}'));
  });
});
