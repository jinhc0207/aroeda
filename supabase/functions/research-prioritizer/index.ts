/**
 * Supabase Edge Function · research-prioritizer (내부 전용)
 *
 * 앱 사용자가 부르는 기능이 아니다.
 * 서버 전용 자격으로만 호출한다. 아직 배포하지 않았다.
 *
 * 이 파일은 Deno에서 실행된다. 실제 처리 내용은 handler.ts에 있다.
 * 여기서는 자격 확인, DB 읽기, OpenAI 호출만 연결한다.
 *
 * 비밀값은 서버 환경에서만 읽고 로그나 응답에 남기지 않는다.
 */

import { isAuthorizedInternalRequest } from '../_shared/internal-auth.ts';
import {
  EVALUATOR_TIMEOUT_MS,
  QUEUE_TIMEOUT_MS,
} from '../_shared/research-prioritizer-edge.ts';
import { handleResearchPrioritizer } from './handler.ts';

// Deno 런타임 타입 (이 프로젝트의 TypeScript 설정은 Node 기준이라 최소한만 선언한다)
declare const Deno: {
  env: { get(key: string): string | undefined };
  serve(handler: (request: Request) => Promise<Response> | Response): unknown;
};

const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';
const QUEUE_RPC_PATH = '/rest/v1/rpc/get_content_research_queue_for_prioritizer';
const CREATE_DECISION_RPC_PATH = '/rest/v1/rpc/create_prioritizer_decision';

/**
 * 내부 호출인지 확인한다.
 *
 * 값 자체를 직접 비교하지 않고, 각각의 SHA-256 지문을 만들어 고정 길이로 비교한다.
 * 비교 방법은 _shared/internal-auth.ts 한 곳에만 두고 내부 기능들이 같이 쓴다.
 * 토큰 값은 로그에 남기지 않는다.
 */
async function isAuthorized(request: Request): Promise<boolean> {
  return isAuthorizedInternalRequest(request, Deno.env.get('RESEARCH_PRIORITIZER_TOKEN'));
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

/** Research Queue를 읽기 전용 RPC로만 읽는다. 표를 직접 읽지 않는다. */
async function fetchQueue(): Promise<unknown> {
  const url = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !serviceRoleKey) throw new Error('queue_config_missing');

  const response = await fetchWithTimeout(
    `${url}${QUEUE_RPC_PATH}`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${serviceRoleKey}`,
        apikey: serviceRoleKey,
        'content-type': 'application/json',
      },
      body: '{}',
    },
    QUEUE_TIMEOUT_MS,
  );

  if (!response.ok) throw new Error(`queue_http_${response.status}`);

  return await response.json();
}

/**
 * 합의된 판단을 표에 적고 번호를 받아 온다.
 *
 * 표를 직접 건드리지 않는다. 정해진 함수 하나만 부른다.
 * 열쇠 값은 로그에 남기지 않는다. 원본 응답도 옮기지 않는다.
 * 다시 부르지 않는다.
 */
async function createPrioritizerDecision(input: {
  prioritizerSnapshotId: string;
  targetDomain: string;
  evidenceVersion: number;
  activeCoveredHash: string;
}): Promise<unknown> {
  const url = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !serviceRoleKey) throw new Error('decision_config_missing');

  const response = await fetchWithTimeout(
    `${url}${CREATE_DECISION_RPC_PATH}`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${serviceRoleKey}`,
        apikey: serviceRoleKey,
        'content-type': 'application/json',
      },
      // 표가 받는 네 값만 보낸다. 그 밖의 것은 보내지 않는다.
      body: JSON.stringify({
        p_prioritizer_snapshot_id: input.prioritizerSnapshotId,
        p_target_domain: input.targetDomain,
        p_evidence_version: input.evidenceVersion,
        p_active_covered_hash: input.activeCoveredHash,
      }),
    },
    // Queue를 읽을 때와 같은 시간 제한을 쓴다. 새 값을 만들지 않는다.
    QUEUE_TIMEOUT_MS,
  );

  // 상세 오류는 밖으로 전달하지 않는다. 본문을 열지 않는다.
  if (!response.ok) throw new Error('decision_rpc_failed');

  return await response.json();
}

async function callOpenAI(payload: Record<string, unknown>, apiKey: string): Promise<unknown> {
  const response = await fetchWithTimeout(
    OPENAI_RESPONSES_URL,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    },
    EVALUATOR_TIMEOUT_MS,
  );

  if (!response.ok) {
    // 상세 오류 메시지는 밖으로 전달하지 않는다.
    throw new Error(`openai_http_${response.status}`);
  }

  return await response.json();
}

Deno.serve((request: Request) =>
  handleResearchPrioritizer(request, {
    isAuthorized,
    fetchQueue,
    createPrioritizerDecision,
    getApiKey: () => Deno.env.get('OPENAI_API_KEY'),
    callOpenAI,
    // 토큰, Queue 원본, OpenAI 원본은 로그에 남기지 않는다.
    log: (message) => console.log(message),
    requestId: () => crypto.randomUUID().slice(0, 8),
  }),
);
