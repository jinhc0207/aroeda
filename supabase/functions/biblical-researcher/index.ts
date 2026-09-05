/**
 * Supabase Edge Function · biblical-researcher (내부 전용)
 *
 * 앱 사용자가 부르는 기능이 아니다.
 * 서버 전용 자격(x-internal-token)으로만 호출한다.
 *
 * 이 파일은 Deno에서 실행된다. 실제 처리 내용은 handler.ts에 있다.
 * 여기서는 자격 확인과 바깥으로 나가는 연결(OpenAI, DB)만 맡는다.
 *
 * 부르는 DB 함수는 정확히 둘이다.
 *   consume_biblical_research_handoff — 근거 꾸러미를 한 번 꺼낸다
 *   store_biblical_research_result    — 연구 결과를 한 번 적는다
 *
 * 꾸러미를 적어 두는 함수는 부르지 않는다. 그것은 자료 수집 단계의 몫이다.
 * 표에 직접 접근하지 않고(SELECT·INSERT·DELETE 없음), 그 밖의 표에는 손대지 않는다.
 * 서비스 역할 키는 그 두 함수를 부를 때만 쓴다.
 *
 * 모델을 부르는 일은 이미 있는 것을 그대로 쓴다.
 * 주소, 머리글, 시간 제한, 답 읽기는 그쪽이 소유한다. 여기서 다시 만들지 않는다.
 *
 * 비밀값은 서버 환경에서만 읽고 로그나 응답에 남기지 않는다.
 */

import { isAuthorizedInternalRequest } from '../_shared/internal-auth.ts';
import {
  RecoveryTicketRpcError,
  classifyRecoveryTicketRpcFailure,
} from '../_shared/harvest-recovery-ticket.ts';
import { CONSUME_BIBLICAL_RESEARCH_HANDOFF_RPC } from '../_shared/biblical-research-handoff-store.ts';
import { STORE_BIBLICAL_RESEARCH_RESULT_RPC } from '../_shared/research-result-store.ts';
import { createBiblicalResearchResponsesTransport } from '../_shared/biblical-researcher-openai-transport.ts';
import { handleBiblicalResearch } from './handler.ts';

// Deno 런타임 타입 (이 프로젝트의 TypeScript 설정은 Node 기준이라 최소한만 선언한다)
declare const Deno: {
  env: { get(key: string): string | undefined };
  serve(handler: (request: Request) => Promise<Response> | Response): unknown;
};

/** 꾸러미 표를 다루는 DB 함수는 이 하나뿐이다. 꾸러미 적어 두기는 여기서 부르지 않는다. */
const CONSUME_RESEARCH_HANDOFF_PATH = '/rest/v1/rpc/consume_biblical_research_handoff';

/** 연구 결과 표를 다루는 DB 함수도 이 하나뿐이다. 읽기도 고치기도 부르지 않는다. */
const STORE_RESEARCH_RESULT_PATH = '/rest/v1/rpc/store_biblical_research_result';

/**
 * DB 함수 한 번을 기다리는 시간.
 *
 * 다른 기능의 표 함수와 같은 값이다. 새 숫자를 만들지 않았다.
 * Edge Function끼리 서로를 가져다 쓰지 않으므로 이 파일이 자기 값을 갖는다.
 *
 * 두 표 함수가 같은 값을 쓴다. 하는 일의 크기가 비슷해서 나눌 이유가 없다.
 *
 * 이 시간은 이 요청의 다른 시간 제한과 함께 쌓인다.
 *   꾸러미 꺼내기 5 + 모델 요청 90 + 결과 적어 두기 5 = 100초
 * Supabase가 한 요청을 기다려 주는 시간은 150초다.
 *
 * 셋은 차례로 일어난다. 동시에 하지 않는다.
 */
const RPC_TIMEOUT_MS = 5_000;

/**
 * 내부 호출인지 확인한다.
 *
 * 다른 기능들과 다른 토큰을 쓴다. 역할이 다른 기능이므로 자격도 따로 둔다.
 * 비교 방법은 _shared/internal-auth.ts에 있다. 토큰 값은 로그에 남기지 않는다.
 */
async function isAuthorized(request: Request): Promise<boolean> {
  return isAuthorizedInternalRequest(request, Deno.env.get('BIBLICAL_RESEARCHER_TOKEN'));
}

/**
 * 정해진 DB 함수 하나를 부른다.
 *
 * 무엇을 보낼지는 보관소 쪽이 정한다. 여기서는 보내기만 한다.
 * 서비스 역할 키는 이 함수 안에서만 읽고, 로그·응답·오류 문구에 남기지 않는다.
 * 실패하면 그대로 던진다. 다시 부르지 않는다.
 *
 * 부를 수 있는 길은 아래 두 자리에서 미리 정해 넘긴다.
 * 부르는 쪽이 주소를 정하지 못한다.
 */
async function callRpc(path: string, params: Record<string, unknown>): Promise<unknown> {
  const baseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

  // 설정이 없으면 아무것도 하지 않는다. 어떤 값이 없는지는 밖으로 알리지 않는다.
  if (!baseUrl || baseUrl.trim().length === 0) {
    throw new RecoveryTicketRpcError('config_missing');
  }
  if (!serviceRoleKey || serviceRoleKey.trim().length === 0) {
    throw new RecoveryTicketRpcError('config_missing');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);

  try {
    let response: Response;
    try {
      response = await fetch(
        `${baseUrl.replace(/\/+$/, '')}${path}`,
        {
          method: 'POST',
          headers: {
            apikey: serviceRoleKey,
            authorization: `Bearer ${serviceRoleKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(params),
          signal: controller.signal,
        },
      );
    } catch {
      // 우리가 건 시간 제한으로 끊긴 것인지, 그 밖의 문제인지만 가른다.
      // 원본 오류 문구는 읽지도, 옮기지도 않는다.
      throw new RecoveryTicketRpcError(
        classifyRecoveryTicketRpcFailure('request', controller.signal.aborted),
      );
    }

    // 상세 오류 메시지는 읽지도, 전달하지도 않는다. 본문을 아예 열지 않는다.
    if (!response.ok) throw new RecoveryTicketRpcError('http_error');

    try {
      return await response.json();
    } catch {
      // 답을 읽는 도중에도 시간이 넘을 수 있다.
      throw new RecoveryTicketRpcError(
        classifyRecoveryTicketRpcFailure('body', controller.signal.aborted),
      );
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 근거 꾸러미를 꺼내는 길.
 *
 * 이 이름 말고는 부르지 않는다. 이름이 다르면 주소를 찾기 전에 멈춘다.
 */
async function consumeHandoff(
  functionName: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  if (functionName !== CONSUME_BIBLICAL_RESEARCH_HANDOFF_RPC) {
    throw new RecoveryTicketRpcError('config_missing');
  }
  return await callRpc(CONSUME_RESEARCH_HANDOFF_PATH, params);
}

/**
 * 연구 결과를 적어 두는 길.
 *
 * 적어 두기 하나뿐이다. 읽는 함수도 고치는 함수도 여기서 부를 수 없다.
 */
async function storeResearchResult(
  functionName: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  if (functionName !== STORE_BIBLICAL_RESEARCH_RESULT_RPC) {
    throw new RecoveryTicketRpcError('config_missing');
  }
  return await callRpc(STORE_RESEARCH_RESULT_PATH, params);
}

Deno.serve((request: Request) =>
  handleBiblicalResearch(request, {
    isAuthorized,
    getApiKey: () => Deno.env.get('OPENAI_API_KEY'),
    // 모델을 부르는 일은 이미 있는 것을 그대로 쓴다. 여기서 다시 만들지 않는다.
    createTransport: (apiKey) => createBiblicalResearchResponsesTransport({ apiKey }),
    consumeHandoff,
    storeResearchResult,
    // 이유 코드만 남긴다. 토큰, API Key, 번호, 꾸러미, 원본 응답은 남기지 않는다.
    log: (message) => console.log(message),
    requestId: () => crypto.randomUUID().slice(0, 8),
  }),
);
