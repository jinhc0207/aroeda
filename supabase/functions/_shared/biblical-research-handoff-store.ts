/**
 * 연구 근거 꾸러미 보관소 · DB 함수를 부르는 자리
 *
 * 왜 필요한가:
 *   수집이 끝난 근거 꾸러미가 서버에 남지 않아서, 다음 단계가 받은 꾸러미가
 *   실제 수집에서 나온 것인지 확인할 방법이 없었다.
 *   이제 꾸러미를 표에 적어 두고 번호 하나만 넘긴다.
 *
 * 이 파일이 하는 일:
 *   표에 보낼 값을 만들고, 표가 돌려준 것을 읽는다. 그 둘뿐이다.
 *
 * 이 파일이 하지 않는 일:
 *   DB에 연결하지 않는다. 주소도, 열쇠도, 시간을 재는 장치도 여기 없다.
 *   부르는 방법은 바깥에서 받는다.
 *
 *   꾸러미를 만들지 않는다. 지문을 계산하지 않는다.
 *   활성 영역이 무엇인지 알지 못한다. 이미 계산된 값을 받기만 한다.
 *
 *   꾸러미 안을 들여다보지 않는다. 자료 수도 근거도 보지 않는다.
 *   그 판단은 앞뒤 단계의 검사기가 한다. 여기서 하면 규칙의 주인이 둘이 된다.
 *
 *   다시 부르지 않는다. 한 번 부르고 끝낸다.
 *
 * 밖으로 내보내지 않는 것:
 *   원본 오류 문구, 응답 본문, HTTP 상태, 주소, 번호, 지문.
 *   이 파일은 기록을 남기지 않는다.
 *
 * 두 가지 실패를 섞지 않는다:
 *   쓸 수 없음 — 없는 번호, 만료, 이미 쓴 것, 영역이 달라진 것.
 *                표는 넷을 구분해 주지 않고, 여기서도 짐작하지 않는다.
 *   표에 닿지 못함 — 부르지 못했거나, 답이 약속과 달랐다.
 *
 *   앞은 요청이 늦었거나 어긋난 것이고, 뒤는 서버가 준비되지 않은 것이다.
 *   나중에 바깥층이 이 둘을 다른 답으로 바꾼다.
 */

import type { BiblicalResearchHandoff } from './biblical-research-handoff.ts';

/** 표를 다루는 DB 함수 이름. migration에 적힌 것과 글자가 같아야 한다. */
export const CREATE_BIBLICAL_RESEARCH_HANDOFF_RPC = 'create_biblical_research_handoff';
export const CONSUME_BIBLICAL_RESEARCH_HANDOFF_RPC = 'consume_biblical_research_handoff';

/**
 * DB 함수 하나를 부르는 일. 바깥에서 넣어 준다.
 *
 * 얼마나 기다릴지는 여기서 정하지 않는다. 실제로 부르는 쪽이 정한다.
 * 같은 시간 값을 두 곳에 두면 언젠가 서로 어긋난다.
 */
export type BiblicalResearchHandoffRpc = (
  functionName: string,
  params: Record<string, unknown>,
) => Promise<unknown>;

export type HandoffCreateResult =
  | { ok: true; handoffId: string }
  | { ok: false; failure: 'store_unavailable' };

export type HandoffConsumeResult =
  /**
   * 표가 돌려준 것을 그대로 담는다.
   *
   * 아직 BiblicalResearchHandoff라고 부르지 않는다.
   * 그 판단은 다음 단계의 검사기가 한다. 여기서 단정하면 아무것도 확인하지 않은 것이다.
   */
  | { ok: true; payload: unknown }
  | { ok: false; failure: 'unavailable' | 'store_unavailable' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_HEX = /^[0-9a-f]{64}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** 표가 돌려준 번호가 쓸 만한가. 모양이 맞는 번호 하나일 때만 참이다. */
export function isHandoffId(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

/** 활성 영역 지문의 모양. 앞의 두 보관소가 쓰는 것과 같은 조건이다. */
export function isActiveCoveredHash(value: unknown): value is string {
  return typeof value === 'string' && SHA256_HEX.test(value);
}

/* ------------------------------------------------------------------ */
/* 표에 보낼 값                                                         */
/* ------------------------------------------------------------------ */

/**
 * 적어 두기에 보낼 값. 둘뿐이다.
 *
 * 꾸러미 안의 값을 따로 보내지 않는다. 따로 보내면 꾸러미와 어긋날 수 있다.
 */
export function buildCreateHandoffParams(input: {
  handoff: BiblicalResearchHandoff;
  activeCoveredHash: string;
}): Record<string, unknown> {
  return {
    p_handoff: input.handoff,
    p_active_covered_hash: input.activeCoveredHash,
  };
}

/**
 * 꺼내 쓰기에 보낼 값. 둘뿐이다.
 *
 * 지금의 지문은 서버가 계산해서 넘겨준 것이다. 부르는 쪽이 적어 보내지 않는다.
 */
export function buildConsumeHandoffParams(input: {
  handoffId: string;
  currentActiveCoveredHash: string;
}): Record<string, unknown> {
  return {
    p_handoff_id: input.handoffId,
    p_current_active_covered_hash: input.currentActiveCoveredHash,
  };
}

/* ------------------------------------------------------------------ */
/* 표가 돌려준 것 읽기                                                  */
/* ------------------------------------------------------------------ */

/**
 * 적어 두기 결과를 읽는다. 번호 하나만 나온다.
 *
 * 값 하나를 돌려주는 함수는 그 값이 그대로 오지만,
 * 배열이나 한 칸짜리 객체로 감싸여 올 수도 있다. 앞의 보관소와 같은 방식으로 읽는다.
 */
export function parseCreateHandoffResponse(value: unknown): string | null {
  if (isHandoffId(value)) return value;

  if (Array.isArray(value) && value.length === 1) return parseCreateHandoffResponse(value[0]);

  if (isRecord(value)) {
    const keys = Object.keys(value);
    if (keys.length !== 1) return null;
    return parseCreateHandoffResponse(value[keys[0] as string]);
  }

  return null;
}

/**
 * 꺼내 쓰기 결과를 읽는다.
 *
 * 여기서는 감싼 것을 벗기지 않는다. 꾸러미 자체가 객체이기 때문이다.
 * 벗기려 들면 칸이 하나뿐인 꾸러미를 그 안의 값으로 잘못 읽는다.
 *
 * 없는 번호, 만료, 이미 쓴 것, 영역이 달라진 것은 모두 빈 값 하나로 온다.
 * 어느 쪽인지 구분해서 알려주지 않는다.
 *
 * 꾸러미 안이 약속대로인지는 보지 않는다. 그것은 다음 단계의 검사기가 한다.
 */
export function parseConsumeHandoffResponse(
  value: unknown,
): { ok: true; payload: unknown } | { ok: false; reason: 'empty' | 'invalid' } {
  if (value === null || value === undefined) return { ok: false, reason: 'empty' };
  if (!isRecord(value)) return { ok: false, reason: 'invalid' };
  return { ok: true, payload: value };
}

/* ------------------------------------------------------------------ */
/* 부르기                                                              */
/* ------------------------------------------------------------------ */

/**
 * 꾸러미를 표에 적어 두고 번호를 받는다.
 *
 * 정확히 한 번 부른다. 실패해도 다시 부르지 않는다.
 *
 * 번호, 수명, 만든 때는 표가 정한다. 여기서 보내지 않는다.
 * 보낼 값이 모양부터 어긋나면 부르지 않는다. 헛되이 부를 이유가 없다.
 */
export async function createBiblicalResearchHandoff(input: {
  handoff: BiblicalResearchHandoff;
  activeCoveredHash: string;
  rpc: BiblicalResearchHandoffRpc;
}): Promise<HandoffCreateResult> {
  const unavailable: HandoffCreateResult = { ok: false, failure: 'store_unavailable' };

  // 꾸러미 안은 보지 않는다. 표에 담길 수 있는 모양인지만 본다.
  if (!isRecord(input.handoff)) return unavailable;
  // 지문은 서버가 계산한 값이다. 모양이 다르면 서버 쪽이 준비되지 않은 것이다.
  if (!isActiveCoveredHash(input.activeCoveredHash)) return unavailable;

  let answer: unknown;
  try {
    answer = await input.rpc(
      CREATE_BIBLICAL_RESEARCH_HANDOFF_RPC,
      buildCreateHandoffParams({
        handoff: input.handoff,
        activeCoveredHash: input.activeCoveredHash,
      }),
    );
  } catch {
    // 원본 오류는 옮기지 않는다.
    return unavailable;
  }

  const handoffId = parseCreateHandoffResponse(answer);
  if (handoffId === null) return unavailable;

  return { ok: true, handoffId };
}

/**
 * 번호로 꾸러미를 한 번 꺼낸다.
 *
 * 정확히 한 번 부른다. 꺼내는 순간 그 줄은 표에서 사라진다.
 * 실패해도 다시 부르지 않고, 사라진 줄을 되살리지 않는다.
 *
 * 번호의 모양이 다르면 부르지 않는다.
 * 그 번호로 가리킬 줄이 애초에 없으므로, 없는 번호와 같은 답이다.
 *
 * 지금의 지문은 서버가 계산한 값이다.
 * 그 모양이 다르면 요청이 어긋난 것이 아니라 서버가 준비되지 않은 것이다.
 */
export async function consumeBiblicalResearchHandoff(input: {
  handoffId: string;
  currentActiveCoveredHash: string;
  rpc: BiblicalResearchHandoffRpc;
}): Promise<HandoffConsumeResult> {
  if (!isActiveCoveredHash(input.currentActiveCoveredHash)) {
    return { ok: false, failure: 'store_unavailable' };
  }
  if (!isHandoffId(input.handoffId)) {
    return { ok: false, failure: 'unavailable' };
  }

  let answer: unknown;
  try {
    answer = await input.rpc(
      CONSUME_BIBLICAL_RESEARCH_HANDOFF_RPC,
      buildConsumeHandoffParams({
        handoffId: input.handoffId,
        currentActiveCoveredHash: input.currentActiveCoveredHash,
      }),
    );
  } catch {
    // 줄이 사라졌는지조차 알 수 없다. 다시 부르지 않는다.
    return { ok: false, failure: 'store_unavailable' };
  }

  const read = parseConsumeHandoffResponse(answer);
  if (read.ok) return { ok: true, payload: read.payload };

  // 빈 값은 쓸 수 없다는 뜻이고, 그 밖의 모양은 표가 약속을 어긴 것이다.
  return { ok: false, failure: read.reason === 'empty' ? 'unavailable' : 'store_unavailable' };
}
