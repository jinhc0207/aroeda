/**
 * generate-prayer-guidance · 요청 처리 본체
 *
 * 사용자가 말씀 화면에서 "기도를 시작하는 도움 받기"를 눌렀을 때만 불린다.
 * 직접 기도하는 길에서는 부르지 않는다.
 *
 * 받는 것은 세 가지뿐이다.
 *   지금 나의 상황, 지금 보고 있는 말씀의 번호, 그 말씀을 받은 삶의 영역(selectedDomain).
 *
 * selectedDomain도 믿지 않는다:
 *   다시 분석한 결과 안에 그 영역이 실제로 있어야 한다(needs_choice의 두 후보, 또는 resolved의 primary·secondary).
 *   요청으로 받았다는 이유로 분석 결과에 끼워 넣지 않는다.
 *   안전 신호는 영역을 골랐다고 넘어갈 수 없다. 영역을 보기 전에 먼저 막는다.
 *
 * 부르는 쪽을 믿지 않는다:
 *   말씀 설명과 기도 방향을 받지 않는다. 서버가 자기 것을 읽는다.
 *   안전 판정도 받지 않는다. 서버가 다시 살핀다.
 *
 * 왜 다시 살피는가:
 *   이 기능은 앱을 거치지 않고 직접 부를 수 있다.
 *   앱 화면의 순서만 믿으면, 안전이 먼저인 상황에서도 기도 도움이 나가게 된다.
 *   그래서 여기서 상황 분석과 추천 판단을 그대로 다시 돌린다.
 *   새 안전 규칙을 만들지 않고 이미 있는 것을 다시 쓴다.
 *
 * 순서를 지킨다:
 *   POST → 본문 모양(선택 영역 포함) → 아는 말씀인가 → 상황 분석(사용량 확인 포함)
 *   → 안전 → 선택 영역이 분석에 있는가 → 그 영역 기준 추천 판단 → 이 영역에 맞는 말씀인가
 *   → 서버의 말씀 자료 → 기도 도움
 *
 * 실패했을 때:
 *   왜 실패했는지 밖으로 나누지 않는다.
 *   안전 때문에 막힌 것인지, 모델이 늦은 것인지 구분되면 안 된다.
 *   부르는 쪽은 어느 경우든 기존 안내로 넘어가면 된다.
 */

import {
  analyzeSituationRequest,
  jsonResponse,
  type EdgeDeps,
} from '../_shared/edge-analyzer.ts';
import type { QuotaDecision } from '../_shared/rate-limit.ts';
import { runRecommendationGate } from '../_shared/recommendation-gate.ts';
import { resolveAnalysisForChosenDomain } from '../_shared/domain-choice-resolution.ts';
import { getScriptureCard, type ScriptureCard } from '../_shared/scripture-cards.ts';
import { extractOutputText } from '../_shared/openai-response.ts';
import {
  PRAYER_GUIDANCE_MODEL,
  PRAYER_GUIDANCE_MODEL_TIMEOUT_MS,
  PRAYER_GUIDANCE_TOTAL_BUDGET_MS,
  buildPrayerGuidancePayload,
  containsProhibitedPrayerPattern,
  parsePrayerGuidanceRequest,
  validatePrayerGuidance,
  type PrayerGuidance,
} from '../_shared/prayer-guidance-contract.ts';

/** 밖으로 나가는 실패는 이 하나뿐이다. 까닭을 나누지 않는다. */
export const PRAYER_GUIDANCE_UNAVAILABLE = 'PRAYER_GUIDANCE_UNAVAILABLE';

export type PrayerGuidanceErrorBody = { ok: false; error: typeof PRAYER_GUIDANCE_UNAVAILABLE };
export type PrayerGuidanceSuccessBody = { ok: true; guidance: PrayerGuidance };

export type PrayerGuidanceDeps = Omit<EdgeDeps, 'checkQuota' | 'callOpenAI'> & {
  /** 사용량 확인. 전체 시간이 끝나면 이 요청도 함께 끊는다. */
  checkQuota: (
    request: Request,
    options?: { signal?: AbortSignal },
  ) => Promise<QuotaDecision>;
  /** 상황을 다시 살피는 요청. 개별 시간과 전체 시간을 함께 받는다. */
  callOpenAI: (
    payload: Record<string, unknown>,
    apiKey: string,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ) => Promise<unknown>;
  /**
   * 기도 도움을 만드는 요청 하나. 정확히 한 번만 불린다.
   * 남은 시간을 함께 넘긴다. 이 파일은 시간을 재는 장치를 갖지 않는다.
   */
  callGuidance: (
    payload: Record<string, unknown>,
    apiKey: string,
    options: { timeoutMs: number; signal?: AbortSignal },
  ) => Promise<unknown>;
  /**
   * 추천 판단에 쓸 카드 목록. 시험에서만 작은 목록을 바꿔 넣는다.
   * 없으면 서버의 검수된 카드 전체를 쓴다. 요청 본문으로는 바꿀 수 없다.
   */
  cards?: ScriptureCard[];
  /** 지금 시각. 시험에서 바꿔 넣는다. */
  now?: () => number;
  /**
   * 전체 시간이 끝났을 때 알려 주는 장치. 취소하는 함수를 돌려준다.
   * 없으면 보통의 타이머를 쓴다. 시험에서만 바꿔 넣는다.
   */
  scheduleDeadline?: (onDeadline: () => void, ms: number) => () => void;
};

/** 밖으로 나가는 답은 언제나 이것 하나다. */
const unavailableResponse = () =>
  jsonResponse(
    { ok: false, error: PRAYER_GUIDANCE_UNAVAILABLE } satisfies PrayerGuidanceErrorBody,
    503,
  );

/**
 * 요청 하나를 처리한다.
 *
 * 전체 시간을 여기서 건다.
 *   시작할 때 20초 시계를 켠다.
 *   그 시계가 울리면 나가 있는 요청을 모두 끊고, 어느 단계에 있든 그 자리에서 끝낸다.
 *
 * 왜 개별 시간만으로 부족한가:
 *   모델 호출마다 8초를 걸어도, 그 앞의 사용량 확인이 늦으면 전체가 늘어난다.
 *   사용자는 각 단계가 아니라 전체를 기다린다. 그래서 전체에도 시계를 건다.
 */
export async function handlePrayerGuidance(
  request: Request,
  deps: PrayerGuidanceDeps,
): Promise<Response> {
  const log = deps.log ?? (() => {});
  const requestId = deps.requestId ? deps.requestId() : 'req';

  const controller = new AbortController();
  const schedule =
    deps.scheduleDeadline ??
    ((onDeadline: () => void, ms: number) => {
      const timer = setTimeout(onDeadline, ms);
      return () => clearTimeout(timer);
    });

  let cancelDeadline = () => {};
  const deadline = new Promise<Response>((resolve) => {
    cancelDeadline = schedule(() => {
      // 나가 있는 요청을 실제로 끊는다. 그리고 기다리지 않고 끝낸다.
      controller.abort();
      log(`[${requestId}] prayer_guidance_deadline`);
      resolve(unavailableResponse());
    }, PRAYER_GUIDANCE_TOTAL_BUDGET_MS);
  });

  try {
    return await Promise.race([
      runPrayerGuidance(request, deps, controller.signal, log, requestId),
      deadline,
    ]);
  } finally {
    cancelDeadline();
  }
}

async function runPrayerGuidance(
  request: Request,
  deps: PrayerGuidanceDeps,
  signal: AbortSignal,
  log: (message: string) => void,
  requestId: string,
): Promise<Response> {
  const now = deps.now ?? (() => Date.now());
  const startedAt = now();

  /**
   * 지금 이 호출에 걸 시간.
   *
   * 개별 호출은 8초를 넘지 않고, 전체 예산에서 남은 만큼도 넘지 않는다.
   * 둘 중 짧은 쪽이다.
   */
  const remainingTimeout = () => {
    const remaining = PRAYER_GUIDANCE_TOTAL_BUDGET_MS - (now() - startedAt);
    return Math.min(PRAYER_GUIDANCE_MODEL_TIMEOUT_MS, remaining);
  };

  /** 까닭은 서버 기록에만 남긴다. 밖으로는 언제나 같은 답이다. */
  const unavailable = (reason: string) => {
    log(`[${requestId}] ${reason}`);
    return unavailableResponse();
  };

  // 본문은 한 번만 읽을 수 있다. 사본으로 먼저 모양을 보고, 원본은 분석기에게 넘긴다.
  // 모양이 어긋난 요청 때문에 사용량을 쓰지 않기 위해서다.
  let body: unknown;
  try {
    body = await request.clone().json();
  } catch {
    return unavailable('prayer_guidance_invalid_body');
  }

  const parsed = parsePrayerGuidanceRequest(body);
  if (!parsed.ok) return unavailable('prayer_guidance_invalid_request');

  // 아는 말씀인지 먼저 본다. 모르는 번호면 분석까지 갈 이유가 없다.
  let card;
  try {
    card = getScriptureCard(parsed.input.cardId);
  } catch {
    return unavailable('prayer_guidance_unknown_card');
  }

  // 상황을 다시 살핀다. 사용량 확인과 API Key 확인도 이 안에서 함께 이루어진다.
  //
  // 이 안에서 쓰는 두 바깥 연결에 전체 시간 신호를 함께 넘긴다.
  // 분석기 자체는 고치지 않는다. 여기서 감싸서 넘기기만 한다.
  // 분석을 시작하기 전에도 남은 시간을 본다. 시간이 없으면 부르지 않는다.
  if (remainingTimeout() <= 0) return unavailable('prayer_guidance_budget_exhausted');

  const analysisDeps: EdgeDeps = {
    ...deps,
    checkQuota: (incoming) => deps.checkQuota(incoming, { signal }),
    callOpenAI: (payload, apiKey) =>
      deps.callOpenAI(payload, apiKey, {
        timeoutMs: remainingTimeout(),
        signal,
      }),
  };

  const analyzed = await analyzeSituationRequest(request, analysisDeps);
  if (!analyzed.ok) {
    // 분석기가 만든 답을 그대로 내보내지 않는다.
    // 사용량 제한인지, 열쇠가 없는지, 모델이 실패했는지 밖에서 구분되면 안 된다.
    // 부르는 쪽은 어느 경우든 기존 안내로 넘어가면 된다.
    return unavailable('prayer_guidance_analysis_failed');
  }

  if (signal.aborted) return unavailable('prayer_guidance_aborted');

  // 안전이 먼저다. 선택 영역을 보기 전에 막는다. 영역을 골랐다고 안전을 넘어갈 수 없다.
  if (analyzed.analysis.safety.level !== 'normal') {
    return unavailable('prayer_guidance_safety_first');
  }

  // 사용자가 고른 영역이 다시 살핀 결과 안에 실제로 있는가.
  // needs_choice면 두 후보 중 하나, resolved면 primary 또는 secondary여야 한다.
  // 없으면 거절한다. 요청 값을 분석 결과에 억지로 넣지 않는다.
  const resolved = resolveAnalysisForChosenDomain(analyzed.analysis, parsed.input.selectedDomain);
  if (resolved === null) {
    return unavailable('prayer_guidance_domain_not_detected');
  }

  // 고른 영역을 중심으로 추천 판단을 다시 돌린다. 규칙은 기존 Primary-First 그대로다.
  const gate = runRecommendationGate(resolved, deps.cards);

  if (gate.route !== 'recommend') {
    // 안전인지, 다룰 수 없는 영역인지, 모호한지 밖으로 나누지 않는다.
    return unavailable('prayer_guidance_not_eligible');
  }

  // 지금 보고 있는 말씀이 고른 영역에 맞는 후보인가.
  // 다시 살핀 결과가 조금 달라질 수 있으므로 선택된 한 장이 아니라 후보 목록으로 본다.
  if (!gate.eligibleCardIds.includes(card.id)) {
    return unavailable('prayer_guidance_card_not_eligible');
  }

  const apiKey = deps.getApiKey();
  if (!apiKey || apiKey.trim().length === 0) {
    return unavailable('prayer_guidance_api_key_missing');
  }

  // 여기까지 오는 데 쓴 시간을 빼고, 남은 만큼만 기다린다.
  const timeoutMs = remainingTimeout();
  if (timeoutMs <= 0) return unavailable('prayer_guidance_budget_exhausted');

  let raw: unknown;
  try {
    // 정확히 한 번 부른다. 실패해도 다시 부르지 않는다.
    raw = await deps.callGuidance(
      buildPrayerGuidancePayload({
        situation: parsed.input.situation,
        card,
        model: PRAYER_GUIDANCE_MODEL,
      }),
      apiKey,
      { timeoutMs, signal },
    );
  } catch {
    // 원본 오류는 옮기지 않는다.
    return unavailable('prayer_guidance_request_failed');
  }

  const text = extractOutputText(raw);
  if (!text) return unavailable('prayer_guidance_empty_response');

  let read: unknown;
  try {
    read = JSON.parse(text);
  } catch {
    return unavailable('prayer_guidance_invalid_json');
  }

  const checked = validatePrayerGuidance(read);
  if (!checked.ok) return unavailable('prayer_guidance_invalid_guidance');

  // 마지막 안전판. 아주 명백한 단정/보장 표현만 걸러낸다. 다시 부르지 않는다.
  if (containsProhibitedPrayerPattern(checked.guidance.prayerText)) {
    return unavailable('prayer_guidance_prohibited_pattern');
  }

  log(`[${requestId}] prayer_guidance_ready`);
  return jsonResponse(
    { ok: true, guidance: checked.guidance } satisfies PrayerGuidanceSuccessBody,
    200,
  );
}
