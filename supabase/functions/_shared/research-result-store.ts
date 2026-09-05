/**
 * 연구 결과 보관소 · DB 함수 어댑터
 *
 * 무엇을 하는가
 *   연구가 끝난 결과 한 건을 표에 적어 두는 길이다.
 *   부르는 DB 함수는 하나뿐이다.
 *
 *     store_biblical_research_result — 적고 번호를 돌려준다
 *
 *   꺼내 읽는 함수도, 고치는 함수도 없다. 이 표는 새로 적기만 한다.
 *
 * 왜 여기서 지문을 계산하는가
 *   지문의 주인은 계약(research-result-store-contract.ts) 하나뿐이다.
 *   부르는 쪽마다 따로 계산하면 언젠가 서로 다른 답이 나온다.
 *   그래서 그 계산을 여기서 한 번만 부르고, 결과를 그대로 보낸다.
 *
 * 왜 여기서 한 번 더 검사하는가
 *   표의 조건은 모양만 본다. 사용자 이야기가 섞였는지,
 *   게시용 문구가 들어왔는지, 근거가 결과와 어긋나는지는 보지 못한다.
 *   그 판단은 애플리케이션의 일이므로 보내기 전에 여기서 끝낸다.
 *
 *   검사를 통과하지 못하면 부르지 않는다. 표에 닿기 전에 멈춘다.
 *
 * 실패는 한 가지로만 알린다
 *   왜 실패했는지 부르는 쪽이 알 필요가 없다.
 *   DB가 뭐라고 했는지, 어느 항목이 어긋났는지 옮기지 않는다.
 *   옮기면 그것이 곧 응답과 기록을 타고 밖으로 나간다.
 *
 * 이 파일은 Supabase 클라이언트를 직접 불러오지 않는다.
 * 함수를 부르는 일만 인자로 받는다. 그래서 실제 서버 없이도 시험할 수 있다.
 */

import type { BiblicalResearchHandoff } from './biblical-research-handoff.ts';
import type { BiblicalResearchResult } from './biblical-researcher.ts';
import {
  computeResearchResultHash,
  validateResearchResultInsert,
  type ResearchResultProvenance,
} from './research-result-store-contract.ts';

/** 이 표를 다루는 DB 함수는 이것 하나뿐이다. */
export const STORE_BIBLICAL_RESEARCH_RESULT_RPC = 'store_biblical_research_result';

/** DB 함수를 부르는 일. 어떻게 부를지는 부르는 쪽이 정한다. */
export type ResearchResultStoreRpc = (
  functionName: string,
  params: Record<string, unknown>,
) => Promise<unknown>;

export type ResearchResultStoreOutcome =
  | { ok: true; researchResultId: string }
  /** 까닭을 나누지 않는다. 적히지 않았다는 사실 하나만 남는다. */
  | { ok: false; failure: 'store_unavailable' };

const UUID_FORMAT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 오래 남길 근거를 꾸러미에서 골라 담는다.
 *
 * 통째로 옮기지 않는다. 필요한 넷만 이름을 하나씩 적어 가져온다.
 * 통째로 옮기면 나중에 꾸러미에 무엇이 늘어나도 그대로 따라 들어온다.
 * 그때 사용자 이야기 같은 것이 섞여도 아무도 눈치채지 못한다.
 *
 * 연구 결과 안에 이미 있는 값(영역 이름, 근거 판본, 판단 시점, 꾸러미 지문)은
 * 여기서 가져오지 않는다. 두 곳에 두면 언젠가 서로 달라진다.
 */
export function buildResearchResultProvenance(
  handoff: BiblicalResearchHandoff,
): ResearchResultProvenance {
  return {
    domainDescription: handoff.brief.domainDescription,
    activeCoveredDomains: [...handoff.brief.activeCoveredDomains],
    sources: handoff.sources,
    sourceUnresolvedQuestions: [...handoff.sourceUnresolvedQuestions],
  };
}

/** DB 함수에 넘길 값. 이름은 표 함수가 정한 그대로다. */
export function buildStoreResearchResultParams(input: {
  resultHash: string;
  result: BiblicalResearchResult;
  provenance: ResearchResultProvenance;
}): Record<string, unknown> {
  return {
    p_result_hash: input.resultHash,
    p_result: input.result,
    p_provenance: input.provenance,
  };
}

/**
 * 표가 돌려준 것에서 번호만 꺼낸다.
 *
 * 번호가 아니면 적히지 않은 것으로 본다.
 * 돌아온 값이 이상할 때 "아마 됐겠지"로 넘기지 않는다.
 */
export function parseStoreResearchResultResponse(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return UUID_FORMAT.test(value) ? value : null;
}

/**
 * 연구 결과 한 건을 적어 둔다.
 *
 * 부르는 것은 최대 한 번이다. 실패해도 다시 부르지 않는다.
 * 같은 결과를 다시 보내면 표 함수가 알아서 원래 번호를 돌려준다.
 * 그러니 여기서 다시 부를 이유가 없다.
 */
export async function storeBiblicalResearchResult(input: {
  result: BiblicalResearchResult;
  provenance: ResearchResultProvenance;
  rpc: ResearchResultStoreRpc;
}): Promise<ResearchResultStoreOutcome> {
  const unavailable: ResearchResultStoreOutcome = { ok: false, failure: 'store_unavailable' };

  let resultHash: string;
  try {
    // 지문은 계약이 계산한다. 여기서 다시 만들지 않는다.
    resultHash = await computeResearchResultHash(input.result);
  } catch {
    return unavailable;
  }

  // 보내도 되는 값인지 여기서 끝낸다. 어긋나면 표를 부르지 않는다.
  // 어디가 어긋났는지는 옮기지 않는다.
  const checked = await validateResearchResultInsert({
    result: input.result,
    provenance: input.provenance,
    resultHash,
  });
  if (!checked.valid) return unavailable;

  let answer: unknown;
  try {
    answer = await input.rpc(
      STORE_BIBLICAL_RESEARCH_RESULT_RPC,
      buildStoreResearchResultParams({
        resultHash,
        result: input.result,
        provenance: input.provenance,
      }),
    );
  } catch {
    // 원본 오류는 읽지도 옮기지도 않는다.
    return unavailable;
  }

  const researchResultId = parseStoreResearchResultResponse(answer);
  if (researchResultId === null) return unavailable;

  return { ok: true, researchResultId };
}
