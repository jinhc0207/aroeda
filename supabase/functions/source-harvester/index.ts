/**
 * Supabase Edge Function · source-harvester (내부 전용)
 *
 * 앱 사용자가 부르는 기능이 아니다.
 * 서버 전용 자격(x-internal-token)으로만 호출한다.
 *
 * 이 파일은 Deno에서 실행된다. 실제 처리 내용은 handler.ts에 있다.
 * 여기서는 자격 확인과 바깥으로 나가는 연결(OpenAI, DB)만 맡는다.
 *
 * 부르는 DB 함수는 정확히 셋이다.
 *   consume_prioritizer_decision    — 시작하기 전에 넘겨받은 판단이 진짜인지 대조하고 소비한다
 *   create_harvest_recovery_ticket  — 확인 범위가 모자라 멈췄을 때 표를 만든다
 *   consume_harvest_recovery_ticket — 이어서 확인하는 요청에서 그 표를 꺼낸다
 *
 * 표에 직접 접근하지 않고(SELECT·INSERT·DELETE 없음), 그 밖의 표에는 손대지 않는다.
 * 서비스 역할 키는 위 세 함수를 부를 때만 쓴다.
 *
 * 비밀값은 서버 환경에서만 읽고 로그나 응답에 남기지 않는다.
 */

import { isAuthorizedInternalRequest } from '../_shared/internal-auth.ts';
import {
  OpenAITransportError,
  classifyOpenAIHttpStatus,
  classifyOpenAITransportFailure,
} from '../_shared/openai-transport.ts';
import {
  RecoveryTicketRpcError,
  classifyRecoveryTicketRpcFailure,
  parseCreateTicketResponse,
  type HarvestRecoveryTicketInput,
} from '../_shared/harvest-recovery-ticket.ts';
import { CREATE_BIBLICAL_RESEARCH_HANDOFF_RPC } from '../_shared/biblical-research-handoff-store.ts';
import { handleSourceHarvest } from './handler.ts';

// Deno 런타임 타입 (이 프로젝트의 TypeScript 설정은 Node 기준이라 최소한만 선언한다)
declare const Deno: {
  env: { get(key: string): string | undefined };
  serve(handler: (request: Request) => Promise<Response> | Response): unknown;
};

const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';

/** 표를 다루는 DB 함수는 이 셋뿐이다. 표에 직접 접근하는 경로는 쓰지 않는다. */
const CREATE_RECOVERY_TICKET_PATH = '/rest/v1/rpc/create_harvest_recovery_ticket';
const CONSUME_RECOVERY_TICKET_PATH = '/rest/v1/rpc/consume_harvest_recovery_ticket';
const CONSUME_DECISION_PATH = '/rest/v1/rpc/consume_prioritizer_decision';
const CREATE_RESEARCH_HANDOFF_PATH = '/rest/v1/rpc/create_biblical_research_handoff';

/**
 * DB 함수 한 번을 기다리는 시간. 세 함수 모두 같은 값을 쓴다.
 * 넘으면 그 일을 하지 못한 것으로 보고 다시 부르지 않는다.
 *
 * 이 시간은 각 요청의 다른 시간 제한과 함께 쌓인다.
 *   처음 시작하는 요청: 판단 대조 5 + 1단계 60 + 2단계 75 + 마지막 표 하나 5 = 145초
 *   이어서 확인하는 요청: 표 꺼내기 5 + 확인 묶음 45 × 최대 2회 + 꾸러미 적어 두기 5 = 100초
 * Supabase가 한 요청을 기다려 주는 시간은 150초다.
 *
 * 마지막 표는 하나뿐이다.
 * 이어서 할 표를 만들었으면 꾸러미는 적지 않고, 꾸러미를 적었으면 이어서 할 표는 없다.
 * 그래서 두 시간이 함께 쌓이지 않는다.
 */
const RECOVERY_TICKET_RPC_TIMEOUT_MS = 5_000;

/**
 * 내부 호출인지 확인한다.
 *
 * Research Prioritizer와 다른 토큰을 쓴다. 역할이 다른 기능이므로 자격도 따로 둔다.
 * 비교 방법은 _shared/internal-auth.ts에 있다. 토큰 값은 로그에 남기지 않는다.
 */
async function isAuthorized(request: Request): Promise<boolean> {
  return isAuthorizedInternalRequest(request, Deno.env.get('SOURCE_HARVESTER_TOKEN'));
}

/**
 * Responses API를 한 번 부른다.
 *
 * 정해진 시간 안에 끝나지 않으면 요청을 취소한다. 자동 재시도는 하지 않는다.
 * 응답 본문이 오류일 때 그 내용을 밖으로 내보내거나 로그에 남기지 않는다.
 */
async function callOpenAI(
  payload: Record<string, unknown>,
  options: { apiKey: string; timeoutMs: number },
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);

  try {
    let response: Response;
    try {
      response = await fetch(OPENAI_RESPONSES_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch {
      // 우리가 건 시간 제한으로 끊긴 것인지, 그 밖의 문제인지만 가른다.
      // 원본 오류 문구는 읽지도, 옮기지도 않는다.
      throw new OpenAITransportError(
        classifyOpenAITransportFailure('request', controller.signal.aborted),
      );
    }

    // 상세 오류 메시지는 읽지도, 전달하지도 않는다. 본문을 아예 열지 않는다.
    // 상태 숫자는 여기서 범주 하나로 바꾸는 데만 쓰고, 오류에도 기록에도 담지 않는다.
    if (!response.ok) {
      throw new OpenAITransportError('http_error', classifyOpenAIHttpStatus(response.status));
    }

    try {
      return await response.json();
    } catch {
      // 답을 읽는 도중에도 시간이 넘을 수 있다.
      throw new OpenAITransportError(
        classifyOpenAITransportFailure('body', controller.signal.aborted),
      );
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 정해진 DB 함수 하나를 부른다.
 *
 * 정해진 세 함수 말고 다른 곳으로는 가지 않는다. 표에 직접 접근하지 않는다.
 * 서비스 역할 키는 이 함수 안에서만 읽고, 로그·응답·오류 문구에 남기지 않는다.
 * 실패하면 그대로 던진다. 다시 부르지 않는다.
 */
async function callTicketRpc(path: string, body: Record<string, unknown>): Promise<unknown> {
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
  const timer = setTimeout(() => controller.abort(), RECOVERY_TICKET_RPC_TIMEOUT_MS);

  try {
    let response: Response;
    try {
      response = await fetch(`${baseUrl.replace(/\/+$/, '')}${path}`, {
        method: 'POST',
        headers: {
          apikey: serviceRoleKey,
          authorization: `Bearer ${serviceRoleKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
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
      // 그때를 "읽을 수 없는 답"으로 적으면 원인을 잘못 짚게 된다.
      throw new RecoveryTicketRpcError(
        classifyRecoveryTicketRpcFailure('body', controller.signal.aborted),
      );
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 이어서 할 표를 하나 만든다.
 * 인자 이름은 DB 함수가 받는 이름 그대로다. 그 밖의 값은 보내지 않는다.
 */
async function createRecoveryTicket(input: HarvestRecoveryTicketInput): Promise<unknown> {
  const payload = await callTicketRpc(CREATE_RECOVERY_TICKET_PATH, {
    p_target_domain: input.targetDomain,
    p_evidence_version: input.evidenceVersion,
    p_prioritizer_snapshot_id: input.prioritizerSnapshotId,
    p_active_covered_hash: input.activeCoveredHash,
    p_discovered_urls: input.discoveredUrls,
    p_primary_inspected_urls: input.primaryInspectedUrls,
    p_primary_draft: input.primaryDraft,
    p_primary_tool_counts: input.primaryToolCounts,
  });

  const recoveryId = parseCreateTicketResponse(payload);
  if (recoveryId === null) throw new RecoveryTicketRpcError('response_invalid');

  return recoveryId;
}

/**
 * 이어서 할 표를 꺼낸다. 꺼내는 순간 그 줄은 DB에서 사라진다.
 *
 * 없는 표, 만료된 표, 이미 쓴 표는 모두 빈 결과로 온다.
 * 여기서는 그 결과를 그대로 넘긴다. 무슨 뜻인지는 부르는 쪽이 판단한다.
 */
async function consumeRecoveryTicket(recoveryId: string): Promise<unknown> {
  return await callTicketRpc(CONSUME_RECOVERY_TICKET_PATH, { p_recovery_id: recoveryId });
}

/**
 * Prioritizer가 적어 둔 판단을 대조하면서 한 번 소비한다.
 *
 * 다섯 값이 모두 맞고 아직 만료되지 않은 줄만 사라지고 참이 온다.
 * 하나라도 어긋나면 아무 줄도 지워지지 않고 거짓이 온다.
 * 어느 쪽이 어긋났는지는 표가 알려 주지 않는다. 여기서도 짐작하지 않는다.
 *
 * 표에 보내는 값은 이 다섯뿐이다. 만든 때, 수명, 원본 응답은 오가지 않는다.
 */
async function consumePrioritizerDecision(input: {
  decisionId: string;
  prioritizerSnapshotId: string;
  targetDomain: string;
  evidenceVersion: number;
  activeCoveredHash: string;
}): Promise<unknown> {
  return await callTicketRpc(CONSUME_DECISION_PATH, {
    p_decision_id: input.decisionId,
    p_prioritizer_snapshot_id: input.prioritizerSnapshotId,
    p_target_domain: input.targetDomain,
    p_evidence_version: input.evidenceVersion,
    p_active_covered_hash: input.activeCoveredHash,
  });
}

/**
 * 연구 근거 꾸러미를 표에 적어 두는 DB 함수를 부른다.
 *
 * 이 기능이 부르는 꾸러미 표 함수는 적어 두기 하나뿐이다.
 * 꺼내 쓰기는 연구 단계의 몫이므로 여기서는 부를 수 없다.
 *
 * 무엇을 보낼지는 꾸러미 보관소 쪽이 정한다. 여기서는 보내기만 한다.
 * 기다리는 시간은 다른 표 함수와 같다. 새로 정하지 않는다.
 */
async function issueResearchHandoff(
  functionName: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  if (functionName !== CREATE_BIBLICAL_RESEARCH_HANDOFF_RPC) {
    throw new RecoveryTicketRpcError('config_missing');
  }
  return await callTicketRpc(CREATE_RESEARCH_HANDOFF_PATH, params);
}

Deno.serve((request: Request) =>
  handleSourceHarvest(request, {
    isAuthorized,
    getApiKey: () => Deno.env.get('OPENAI_API_KEY'),
    callOpenAI,
    createRecoveryTicket,
    consumeRecoveryTicket,
    consumePrioritizerDecision,
    issueResearchHandoff,
    now: () => new Date(),
    // 이유 코드만 남긴다. 토큰, API Key, 주소, 원본 응답은 남기지 않는다.
    log: (message) => console.log(message),
    requestId: () => crypto.randomUUID().slice(0, 8),
  }),
);
