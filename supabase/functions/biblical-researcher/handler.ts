/**
 * biblical-researcher · 요청 처리 본체 (내부 전용)
 *
 * 앱 사용자가 부르는 기능이 아니다. 서버 전용 자격으로만 호출한다.
 *
 * 받는 것은 번호 하나뿐이다.
 *
 *   { handoffId }
 *
 *   자료도, 근거도, 영역도, 지문도 받지 않는다.
 *   부르는 쪽이 보낼 것이 번호밖에 없으면 지어낼 것도 없다.
 *   근거 꾸러미는 서버가 표에 들고 있고, 그것만 쓴다.
 *
 * 순서를 지킨다.
 *   POST 확인 → 내부 권한 확인 → 본문 검사 → 번호 모양 확인
 *   → API Key 확인 → 지금 카드가 다루는 영역 계산
 *   → 꾸러미 꺼내기(최대 1회) → 꺼낸 것을 다시 확인
 *   → 연구 실행(모델 요청 최대 1회) → 결과
 *
 * API Key를 꺼내기 전에 보는 이유:
 *   꾸러미는 한 번 꺼내면 사라진다.
 *   서버가 실행 준비도 안 된 상태에서 멀쩡한 번호를 태우지 않기 위해서다.
 *
 * 꺼낸 것을 그대로 믿지 않는 이유:
 *   표에서 나왔다는 것과 그것이 온전한 꾸러미라는 것은 다른 말이다.
 *   다시 확인한 뒤에만 연구에 쓴다.
 *
 * 한 번 꺼낸 꾸러미는 되살리지 않는다.
 *   그 뒤에 무엇이 실패해도 다시 꺼내지 않고, 다시 부르지 않고,
 *   앞 단계를 다시 돌리지 않는다.
 *
 * DB에 대해:
 *   하는 일은 하나뿐이다. 꾸러미를 한 번 꺼내는 것.
 *   적어 두는 일은 자료 수집 단계의 몫이다. 여기서 하지 않는다.
 *   이 파일 자체는 DB에 닿지 않는다. 실제 연결은 index.ts에 있다.
 *
 * 브라우저에서 부르는 기능이 아니므로 CORS 헤더를 붙이지 않는다.
 * POST가 아닌 요청(OPTIONS 포함)은 모두 거절한다.
 *
 * 로그와 응답에 토큰, API Key, 번호, 꾸러미, 근거 문장, 원본 응답,
 * 모델이 쓴 글을 남기지 않는다.
 */

import { getActiveCoveredDomains } from '../_shared/research-prioritizer-edge.ts';
import { computeActiveCoveredHash } from '../_shared/harvest-recovery-ticket.ts';
import {
  consumeBiblicalResearchHandoff,
  isHandoffId,
  type BiblicalResearchHandoffRpc,
} from '../_shared/biblical-research-handoff-store.ts';
import { validateBiblicalResearchHandoff } from '../_shared/biblical-research-handoff.ts';
import {
  executeBiblicalResearchRuntime,
  type BiblicalResearchResponsesTransport,
} from '../_shared/biblical-researcher-runtime-contract.ts';
import type { BiblicalResearchResult } from '../_shared/biblical-researcher.ts';

export type ErrorCode =
  | 'METHOD_NOT_ALLOWED'
  | 'UNAUTHORIZED'
  | 'INVALID_JSON'
  | 'INVALID_REQUEST'
  | 'OPENAI_API_KEY_MISSING'
  /**
   * 그 번호로는 꾸러미를 쓸 수 없다.
   *
   * 없는 번호인지, 만료됐는지, 이미 썼는지, 그 사이에 카드가 늘었는지
   * 여기서 나누지 않는다. 표가 그 구분을 내보내지 않기로 했고 여기서도 짐작하지 않는다.
   */
  | 'RESEARCH_HANDOFF_UNAVAILABLE'
  /** 꾸러미를 보관한 표에 닿지 못했거나, 꺼낸 것이 약속과 달랐다. */
  | 'RESEARCH_HANDOFF_STORE_UNAVAILABLE'
  /**
   * 근거는 제대로 받았지만 연구를 끝내지 못했다.
   *
   * 어디에서 멈췄는지는 서버 기록에만 남긴다.
   * 밖으로는 하나로만 알린다. 모델이 무엇을 했는지 알려 줄 이유가 없다.
   */
  | 'BIBLICAL_RESEARCH_FAILED'
  | 'INTERNAL_ERROR';

export type ErrorBody = { ok: false; error: ErrorCode };
export type SuccessBody = { ok: true; result: BiblicalResearchResult };

/** 요청 본문에 올 수 있는 항목. 이것 하나뿐이다. */
export type ResearchRequestInput = { handoffId: string };

const REQUEST_FIELDS = ['handoffId'] as const;

/**
 * 요청 본문을 검사한다.
 *
 * 자료, 근거, 영역, 근거 판본, 판단 시점, 지문은 받지 않는다.
 * 받으면 부르는 쪽이 그 값을 정할 수 있게 되고, 그 순간 출처가 사라진다.
 *
 * 앞 단계의 한 번짜리 번호도 받지 않는다. 그 권한은 이미 꾸러미가 이어받았다.
 */
export function parseResearchRequest(
  body: unknown,
): { ok: true; input: ResearchRequestInput } | { ok: false } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { ok: false };

  const value = body as Record<string, unknown>;

  for (const key of Object.keys(value)) {
    if (!(REQUEST_FIELDS as readonly string[]).includes(key)) return { ok: false };
  }
  if (!isHandoffId(value.handoffId)) return { ok: false };

  return { ok: true, input: { handoffId: value.handoffId } };
}

export type HandlerDeps = {
  /** 내부 호출인지 확인한다. 실패하면 본문도 읽지 않고 표도 건드리지 않는다. */
  isAuthorized: (request: Request) => boolean | Promise<boolean>;
  getApiKey: () => string | undefined;
  /**
   * 실제로 모델을 부르는 일을 만든다.
   *
   * 어디로 보낼지, 얼마나 기다릴지는 이 함수가 만드는 쪽이 정한다.
   * 여기서는 열쇠를 넘겨 만들기만 한다.
   */
  createTransport: (apiKey: string) => BiblicalResearchResponsesTransport;
  /**
   * 꾸러미 표 함수를 부른다. 꺼내 쓰기 하나뿐이다.
   * 요청당 최대 한 번 불린다. 없으면 꺼낼 수 없는 것으로 보고 끝낸다.
   */
  consumeHandoff?: BiblicalResearchHandoffRpc;
  /** 이유 코드만 남긴다. 번호, 꾸러미, 원본 응답은 남기지 않는다. */
  log?: (message: string) => void;
  requestId?: () => string;
};

const jsonResponse = (body: SuccessBody | ErrorBody, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

/**
 * 연구 요청 하나를 처리한다.
 *
 * 실패는 모두 fail closed다. 반쯤 된 결과를 돌려주지 않는다.
 * 어느 실패에서도 다시 부르지 않고, 사라진 꾸러미를 되살리지 않는다.
 */
export async function handleBiblicalResearch(
  request: Request,
  deps: HandlerDeps,
): Promise<Response> {
  const log = deps.log ?? (() => {});
  const requestId = deps.requestId?.() ?? '';

  const fail = (code: ErrorCode, status: number) => {
    log(`[${requestId}] ${code}`);
    return jsonResponse({ ok: false, error: code }, status);
  };

  try {
    // 1. 브라우저에서 부르는 기능이 아니다. POST 말고는 받지 않는다.
    if (request.method !== 'POST') return fail('METHOD_NOT_ALLOWED', 405);

    // 2. 권한부터 본다. 통과하지 못하면 본문도 읽지 않는다.
    if (!(await deps.isAuthorized(request))) return fail('UNAUTHORIZED', 401);

    // 3. 본문
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return fail('INVALID_JSON', 400);
    }

    // 4~5. 번호 하나뿐인지, 그 모양이 맞는지.
    const parsed = parseResearchRequest(body);
    if (!parsed.ok) return fail('INVALID_REQUEST', 400);

    // 6. 실행할 준비가 됐는지 먼저 본다. 꾸러미는 한 번 꺼내면 사라진다.
    const apiKey = deps.getApiKey();
    if (!apiKey || apiKey.trim().length === 0) {
      return fail('OPENAI_API_KEY_MISSING', 503);
    }

    if (!deps.consumeHandoff) {
      log(`[${requestId}] research_handoff_not_configured`);
      return fail('RESEARCH_HANDOFF_STORE_UNAVAILABLE', 503);
    }

    // 7~8. 지금 카드가 다루는 영역은 서버가 정한다. 부르는 쪽에서 받지 않는다.
    let currentActiveCoveredHash: string;
    try {
      currentActiveCoveredHash = await computeActiveCoveredHash(getActiveCoveredDomains());
    } catch {
      log(`[${requestId}] research_handoff_hash_failed`);
      return fail('RESEARCH_HANDOFF_STORE_UNAVAILABLE', 503);
    }

    // 9. 꾸러미를 꺼낸다. 정확히 한 번. 꺼내는 순간 그 줄은 사라진다.
    const consumed = await consumeBiblicalResearchHandoff({
      handoffId: parsed.input.handoffId,
      currentActiveCoveredHash,
      rpc: deps.consumeHandoff,
    });

    // 10. 쓸 수 없음과 표에 닿지 못함을 섞지 않는다.
    if (!consumed.ok) {
      if (consumed.failure === 'unavailable') {
        return fail('RESEARCH_HANDOFF_UNAVAILABLE', 409);
      }
      return fail('RESEARCH_HANDOFF_STORE_UNAVAILABLE', 503);
    }

    // 11~12. 표에서 나왔다고 그대로 믿지 않는다. 다시 확인한 뒤에만 쓴다.
    const checked = await validateBiblicalResearchHandoff(consumed.payload);
    if (!checked.valid) {
      // 어디가 어긋났는지는 밖으로도 기록에도 남기지 않는다.
      // 이것은 부르는 쪽의 잘못이 아니라 서버가 들고 있던 값의 문제다.
      log(`[${requestId}] research_handoff_validation_failed`);
      return fail('RESEARCH_HANDOFF_STORE_UNAVAILABLE', 503);
    }

    // 13. 연구를 실행한다. 모델 요청은 그 안에서 한 번뿐이다.
    const outcome = await executeBiblicalResearchRuntime({
      handoff: checked.handoff,
      transport: deps.createTransport(apiKey),
    });

    if (!outcome.ok) {
      // 어느 경계에서 멈췄는지는 서버 기록에만 남긴다.
      // 사라진 꾸러미를 되살리지 않고, 다시 부르지도 않는다.
      log(`[${requestId}] ${outcome.failure}`);
      return jsonResponse({ ok: false, error: 'BIBLICAL_RESEARCH_FAILED' }, 503);
    }

    // 14. 나가는 것은 연구 결과뿐이다. 번호도 꾸러미도 함께 나가지 않는다.
    log(`[${requestId}] ready`);
    return jsonResponse({ ok: true, result: outcome.result }, 200);
  } catch {
    return fail('INTERNAL_ERROR', 500);
  }
}
