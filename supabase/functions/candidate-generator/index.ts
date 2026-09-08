/**
 * Supabase Edge Function · candidate-generator (내부 전용)
 *
 * 앱 사용자가 부르는 기능이 아니다.
 * 서버 전용 자격(x-internal-token)으로만 호출한다. 아직 배포하지 않았다.
 *
 * 이 파일은 Deno에서 실행된다. 실제 처리 내용은 handler.ts에 있다.
 * 여기서는 자격 확인과 바깥으로 나가는 연결(DB 읽기/적기, OpenAI)만 잇는다.
 *
 * 부르는 DB 함수는 정확히 둘이다.
 *   get_biblical_research_result_for_candidate_generation — 연구 결과를 지문으로 한 번 읽는다
 *   store_published_content_candidate                     — 완성된 글을 한 번 적는다
 *
 * 표에 직접 접근하지 않는다(SELECT·INSERT·UPDATE 없음). 그 밖의 표에는 손대지 않는다.
 * 서비스 역할 키는 그 두 함수를 부를 때만 쓴다.
 *
 * 모델을 부르는 일, 지문을 다시 맞춰 보는 일, 프롬프트를 쓰는 일, 조립하는 일은
 * 전부 기존 orchestrator와 그 아래 계약이 갖고 있다. 여기서 다시 만들지 않는다.
 *
 * 비밀값은 서버 환경에서만 읽고 로그나 응답에 남기지 않는다.
 */

import { isAuthorizedInternalRequest } from '../_shared/internal-auth.ts';
import {
  GET_RESEARCH_RESULT_FOR_CANDIDATE_GENERATION_RPC,
  type ResearchResultReadOutcome,
} from '../_shared/candidate-research-result-read-boundary-contract.ts';
import {
  STORE_PUBLISHED_CONTENT_CANDIDATE_RPC,
  type CandidateStoreInput,
} from '../_shared/published-content-store-contract.ts';
import type { CandidateGenerationStoreOutcome } from '../_shared/published-content-candidate-generation-orchestration-contract.ts';
import { handleCandidateGeneration } from './handler.ts';

// Deno 런타임 타입 (이 프로젝트의 TypeScript 설정은 Node 기준이라 최소한만 선언한다)
declare const Deno: {
  env: { get(key: string): string | undefined };
  serve(handler: (request: Request) => Promise<Response> | Response): unknown;
};

/** 연구 결과 표를 다루는 DB 함수는 이 하나뿐이다. 이름을 여기서 다시 짓지 않는다. */
const READ_RESEARCH_RESULT_PATH = `/rest/v1/rpc/${GET_RESEARCH_RESULT_FOR_CANDIDATE_GENERATION_RPC}`;

/** 글 표를 다루는 DB 함수도 이 하나뿐이다. */
const STORE_CANDIDATE_PATH = `/rest/v1/rpc/${STORE_PUBLISHED_CONTENT_CANDIDATE_RPC}`;

/**
 * DB 함수 한 번을 기다리는 시간.
 *
 * 다른 내부 기능의 표 함수와 같은 값이다(biblical-researcher). 새 숫자를 만들지 않았다.
 */
const RPC_TIMEOUT_MS = 5_000;

/**
 * 내부 호출인지 확인한다.
 *
 * 다른 기능들과 다른, 이 기능 전용 토큰을 쓴다. 비교 방법은
 * _shared/internal-auth.ts 한 곳에만 두고 내부 기능들이 같이 쓴다.
 */
async function isAuthorized(request: Request): Promise<boolean> {
  return isAuthorizedInternalRequest(request, Deno.env.get('CANDIDATE_GENERATOR_TOKEN'));
}

/** 정해진 시간 안에 끝나지 않으면 요청을 취소한다. 자동 재시도는 하지 않는다. */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 지문 하나로 authoritative 연구 결과를 읽어 온다.
 *
 * 200 + 값 있음: 읽기 성공.
 * 200 + null: 그런 연구가 없다.
 * 그 밖의 모든 경우(HTTP 실패, 시간 초과, 응답을 읽지 못함): read_unavailable.
 *
 * DB의 원본 상태/본문/오류 문구는 이 함수 밖으로 옮기지 않는다.
 */
async function readResearchResult(researchResultHash: string): Promise<ResearchResultReadOutcome> {
  const baseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

  if (!baseUrl || baseUrl.trim().length === 0) return { ok: false, reason: 'read_unavailable' };
  if (!serviceRoleKey || serviceRoleKey.trim().length === 0) {
    return { ok: false, reason: 'read_unavailable' };
  }

  let response: Response;
  try {
    response = await fetchWithTimeout(
      `${baseUrl.replace(/\/+$/, '')}${READ_RESEARCH_RESULT_PATH}`,
      {
        method: 'POST',
        headers: {
          apikey: serviceRoleKey,
          authorization: `Bearer ${serviceRoleKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ p_research_result_hash: researchResultHash }),
      },
      RPC_TIMEOUT_MS,
    );
  } catch {
    // 우리가 건 시간 제한으로 끊긴 것인지, 그 밖의 network 문제인지 밖으로 구분해 알리지 않는다.
    return { ok: false, reason: 'read_unavailable' };
  }

  if (!response.ok) return { ok: false, reason: 'read_unavailable' };

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, reason: 'read_unavailable' };
  }

  if (body === null) return { ok: false, reason: 'not_found' };

  // 함수가 jsonb 하나(연구 결과 본문)만 돌려주기로 되어 있다.
  // 그 밖의 모양이면 안전하게 읽기 불가로 본다.
  if (typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, reason: 'read_unavailable' };
  }

  return {
    ok: true,
    researchResultHash,
    researchResult: body as ResearchResultReadOutcome extends { ok: true; researchResult: infer R }
      ? R
      : never,
  };
}

/**
 * 완성된 글을 한 번 적는다.
 *
 * DB가 돌려준 지문이 우리가 보낸 지문과 정확히 같아야 성공이다.
 * 다르면(있을 수 없는 일이지만) 적힌 것을 믿지 않는다.
 * 실패해도 여기서 다시 부르지 않는다. RUNTIME_RISK_DEFERRED 그대로 둔다.
 */
async function storeCandidate(input: CandidateStoreInput): Promise<CandidateGenerationStoreOutcome> {
  const baseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

  if (!baseUrl || baseUrl.trim().length === 0) return { ok: false };
  if (!serviceRoleKey || serviceRoleKey.trim().length === 0) return { ok: false };

  let response: Response;
  try {
    response = await fetchWithTimeout(
      `${baseUrl.replace(/\/+$/, '')}${STORE_CANDIDATE_PATH}`,
      {
        method: 'POST',
        headers: {
          apikey: serviceRoleKey,
          authorization: `Bearer ${serviceRoleKey}`,
          'content-type': 'application/json',
        },
        // 표가 받는 세 값만 보낸다. 그 밖의 것은 보내지 않는다.
        body: JSON.stringify({
          p_candidate_hash: input.candidateHash,
          p_research_result_hash: input.researchResultHash,
          p_candidate: input.candidate,
        }),
      },
      RPC_TIMEOUT_MS,
    );
  } catch {
    return { ok: false };
  }

  if (!response.ok) return { ok: false };

  let returnedHash: unknown;
  try {
    returnedHash = await response.json();
  } catch {
    return { ok: false };
  }

  if (returnedHash !== input.candidateHash) return { ok: false };

  return { ok: true, candidateHash: input.candidateHash };
}

Deno.serve((request: Request) =>
  handleCandidateGeneration(request, {
    isAuthorized,
    readResearchResult,
    apiKey: Deno.env.get('OPENAI_API_KEY'),
    storeCandidate,
    // 토큰, 지문, 연구 결과, 글, 원본 응답은 로그에 남기지 않는다.
    log: (message) => console.log(message),
    requestId: () => crypto.randomUUID().slice(0, 8),
  }),
);
