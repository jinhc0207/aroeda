/**
 * source-harvester · 요청 처리 본체 (내부 전용)
 *
 * 앱 사용자가 부르는 기능이 아니다. 서버 전용 자격으로만 호출한다.
 *
 * 두 가지 요청을 같은 입구에서 받는다.
 *
 *   처음 시작하는 요청(판단 번호·영역·근거 판본·판단 시점·활성 영역 다섯 개):
 *     POST 확인 → 내부 권한 확인 → 입력 검사 → 의뢰서 생성(서버가) → API Key 확인
 *     → 지금 카드 상태가 그때와 같은지 대조 → 넘겨받은 판단을 한 번 소비
 *     → 자료 수집 실행
 *     확인 범위가 모자라면 이어서 할 표를 하나 만들고 끝낸다.
 *
 *   이어서 확인하는 요청(표 번호 하나):
 *     POST 확인 → 내부 권한 확인 → 표 번호 검사 → API Key 확인 → 표 꺼내기
 *     → 남은 주소를 하나씩 나누어 동시에 확인 → 합치기 → 자료 완성
 *     이 요청은 판단을 다시 소비하지 않는다. 그 권한은 표가 이어받았다.
 *
 * DB에 대해:
 *   - Research Queue, Coverage Gap, Scripture Card는 읽지도 쓰지도 않는다.
 *   - 하는 일은 셋뿐이다.
 *       처음 요청 시작 전  — Prioritizer가 적어 둔 판단을 대조하고 소비한다
 *       확인 범위가 모자랄 때 — 이어서 할 표를 만든다
 *       이어서 하는 요청     — 그 표를 꺼낸다
 *   - 이 파일 자체는 DB에 닿지 않는다. 실제 연결은 index.ts에 있다.
 *
 * 하지 않는 일:
 *   - 우선순위 판단, 성경 연구, 카드 작성
 *   - 사용자 요청 처리
 *
 * 브라우저에서 부르는 기능이 아니므로 CORS 헤더를 붙이지 않는다.
 * POST가 아닌 요청(OPTIONS 포함)은 모두 거절한다.
 *
 * 로그와 응답에 토큰, API Key, 주소 목록, 원본 응답, 웹페이지 내용은 남기지 않는다.
 */

import {
  InvalidResearchBriefError,
  buildSourceHarvestBrief,
  type SourceHarvestBrief,
  type SourceHarvestResult,
} from '../_shared/source-harvester.ts';
import {
  DISCOVERY_TIMEOUT_MS,
  VERIFICATION_TIMEOUT_MS,
  type HarvestRecheckReason,
} from '../_shared/source-harvester-execution-contract.ts';
import {
  materializeHarvestResult,
  runSourceHarvest,
  type HarvestDiagnostics,
  type VerificationToolDiagnostics,
} from '../_shared/source-harvester-execution.ts';
import {
  computeActiveCoveredHash,
  parseConsumeTicketResponse,
  type HarvestRecoveryTicketInput,
} from '../_shared/harvest-recovery-ticket.ts';
import { isDecisionId } from '../_shared/prioritizer-decision.ts';
import {
  parseSourceHarvestRecoveryRequest,
  type RecoveryRecheckReason,
} from '../_shared/source-harvester-recovery-contract.ts';
import { buildRecoveryMaterializationEvidence } from '../_shared/source-harvester-recovery-execution.ts';
import {
  runParallelSourceHarvestRecovery,
  type ParallelInspectionDiagnostics,
} from '../_shared/source-harvester-parallel-recovery-execution.ts';
import { getActiveCoveredDomains } from '../_shared/research-prioritizer-edge.ts';
import { buildBiblicalResearchHandoff } from '../_shared/biblical-research-handoff.ts';
import {
  createBiblicalResearchHandoff,
  type BiblicalResearchHandoffRpc,
} from '../_shared/biblical-research-handoff-store.ts';

export type ErrorCode =
  | 'METHOD_NOT_ALLOWED'
  | 'UNAUTHORIZED'
  | 'INVALID_JSON'
  | 'INVALID_REQUEST'
  | 'OPENAI_API_KEY_MISSING'
  // 넘겨받은 판단을 쓸 수 없다. 왜인지는 밖으로 나누지 않는다.
  | 'PRIORITIZER_DECISION_UNAVAILABLE'
  // 판단을 보관한 표에 닿지 못했거나 답이 약속과 달랐다.
  | 'PRIORITIZER_DECISION_STORE_UNAVAILABLE'
  /**
   * 자료는 다 모았지만 연구 단계로 넘길 번호를 발급하지 못했다.
   *
   * 이때 자료만 돌려주지 않는다.
   * 번호 없는 결과는 다음 단계가 쓸 수 없고, 손으로 옮겨 담게 만든다.
   */
  | 'RESEARCH_HANDOFF_STORE_UNAVAILABLE'
  | 'INTERNAL_ERROR';

export type ErrorBody = { ok: false; error: ErrorCode };

export type PublicResult =
  | {
      status: 'ready';
      /**
       * 이 결과를 연구 단계로 넘길 때 쓰는 한 번짜리 번호.
       * 서버가 만들고, 근거 꾸러미는 서버가 들고 있다.
       * 다음 단계는 이 번호만 보내고 자료를 다시 보내지 않는다.
       */
      handoffId: string;
      harvest: SourceHarvestResult;
      diagnostics: HarvestDiagnostics;
      /** 첫 번째 요청으로 끝난 경우의 2단계 도구 숫자 */
      verificationToolDiagnostics?: VerificationToolDiagnostics;
      /** 이어서 확인해서 끝난 경우의 숫자. 첫 번째 요청의 이름과 섞지 않는다. */
      parallelInspectionDiagnostics?: ParallelInspectionDiagnostics;
    }
  /**
   * 확인 범위가 모자라 여기서 끝냈지만, 이어서 할 표를 만들어 둔 경우.
   * 표 번호와 도구 사용 숫자만 나간다. 영역 이름, 주소, 초안은 나가지 않는다.
   */
  | {
      status: 'recovery_required';
      recoveryId: string;
      verificationToolDiagnostics: VerificationToolDiagnostics;
    }
  /** 자료를 만드는 단계까지 가지 못한 경우에는 집계 숫자가 없다. */
  | {
      status: 'recheck';
      reason: HarvestRecheckReason | RecoveryRecheckReason;
      diagnostics?: HarvestDiagnostics;
      verificationToolDiagnostics?: VerificationToolDiagnostics;
      parallelInspectionDiagnostics?: ParallelInspectionDiagnostics;
    };

export type SuccessBody = { ok: true; result: PublicResult };

/** 요청 본문에 올 수 있는 항목. 이 다섯뿐이다. */
export type HarvestRequestInput = {
  /** Prioritizer가 넘겨준 한 번짜리 번호. 이것이 없으면 시작하지 않는다. */
  decisionId: string;
  targetDomain: string;
  evidenceVersion: number;
  prioritizerSnapshotId: string;
  activeCoveredDomains: string[];
};

const REQUEST_FIELDS = [
  'decisionId',
  'targetDomain',
  'evidenceVersion',
  'prioritizerSnapshotId',
  'activeCoveredDomains',
] as const;

/** 우선순위 판단 시점 id의 모양. snap_ 뒤에 소문자 16진수 64자리. */
const SNAPSHOT_ID = /^snap_[0-9a-f]{64}$/;

/**
 * 요청 본문을 검사한다.
 *
 * domainDescription은 받지 않는다. 부르는 쪽이 영역 설명을 바꿀 수 없어야 하기 때문이다.
 * 설명은 서버가 기존 영역 정의에서 가져온다.
 */
export function parseHarvestRequest(
  body: unknown,
): { ok: true; input: HarvestRequestInput } | { ok: false } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { ok: false };

  const value = body as Record<string, unknown>;

  for (const key of Object.keys(value)) {
    if (!(REQUEST_FIELDS as readonly string[]).includes(key)) return { ok: false };
  }
  for (const key of REQUEST_FIELDS) {
    if (!(key in value)) return { ok: false };
  }

  // 번호 모양은 Prioritizer 쪽 규칙 한 곳에서만 본다. 여기서 다시 적지 않는다.
  if (!isDecisionId(value.decisionId)) return { ok: false };

  if (typeof value.targetDomain !== 'string' || value.targetDomain.length === 0) return { ok: false };

  if (
    typeof value.evidenceVersion !== 'number' ||
    !Number.isSafeInteger(value.evidenceVersion) ||
    value.evidenceVersion < 1
  ) {
    return { ok: false };
  }

  if (typeof value.prioritizerSnapshotId !== 'string' || !SNAPSHOT_ID.test(value.prioritizerSnapshotId)) {
    return { ok: false };
  }

  if (
    !Array.isArray(value.activeCoveredDomains) ||
    value.activeCoveredDomains.some((item) => typeof item !== 'string')
  ) {
    return { ok: false };
  }

  return {
    ok: true,
    input: {
      decisionId: value.decisionId,
      targetDomain: value.targetDomain,
      evidenceVersion: value.evidenceVersion,
      prioritizerSnapshotId: value.prioritizerSnapshotId,
      activeCoveredDomains: value.activeCoveredDomains as string[],
    },
  };
}

export type HandlerDeps = {
  /** 내부 호출인지 확인한다. 실패하면 본문도 읽지 않고 OpenAI도 부르지 않는다. */
  isAuthorized: (request: Request) => boolean | Promise<boolean>;
  getApiKey: () => string | undefined;
  /** Responses API 한 번 호출. 재시도는 하지 않는다. */
  callOpenAI: (
    payload: Record<string, unknown>,
    options: { apiKey: string; timeoutMs: number },
  ) => Promise<unknown>;
  now: () => Date;
  /**
   * 이어서 할 표를 하나 만들고 표 번호를 돌려준다.
   * 확인 범위가 모자랄 때만, 최대 한 번 불린다. 없으면 표를 만들지 않고 끝낸다.
   */
  createRecoveryTicket?: (input: HarvestRecoveryTicketInput) => Promise<unknown>;
  /**
   * 이어서 할 표를 꺼낸다(지우면서 가져온다). 두 번째 요청에서만, 최대 한 번 불린다.
   * 없으면 표를 꺼낼 수 없는 것으로 보고 그대로 끝낸다.
   */
  consumeRecoveryTicket?: (recoveryId: string) => Promise<unknown>;
  /**
   * Prioritizer가 적어 둔 판단을 대조하면서 한 번 소비한다.
   *
   * 처음 시작하는 요청에서만, OpenAI를 부르기 전에, 최대 한 번 불린다.
   * 다섯 값이 모두 맞고 아직 만료되지 않았을 때만 참이다.
   * 이어서 확인하는 요청(Request B)에서는 부르지 않는다.
   */
  consumePrioritizerDecision?: (input: {
    decisionId: string;
    prioritizerSnapshotId: string;
    targetDomain: string;
    evidenceVersion: number;
    activeCoveredHash: string;
  }) => Promise<unknown>;
  /**
   * 근거 꾸러미를 표에 적어 두는 DB 함수를 부른다.
   *
   * 자료를 다 모은 뒤에만, 최대 한 번 불린다.
   * 이어서 할 표를 만드는 경우에는 부르지 않는다. 끝나는 길은 둘 중 하나다.
   *
   * 꺼내 쓰기는 여기서 부르지 않는다. 그것은 연구 단계의 몫이다.
   */
  issueResearchHandoff?: BiblicalResearchHandoffRpc;
  /** 이유 코드만 남긴다. 주소, 원본 응답, 웹페이지 내용은 남기지 않는다. */
  log?: (message: string) => void;
  requestId?: () => string;
};

/**
 * 다 모은 자료를 연구 단계로 넘길 수 있게 만든다.
 *
 * 순서를 지킨다.
 *   최종 검증을 통과한 자료 → 꾸러미 만들기 → 표에 적어 두기 → 번호 하나
 *
 * 꾸러미는 여기서 조립하지 않는다. 이미 있는 만드는 함수를 그대로 쓴다.
 * 지문도 다시 계산하지 않는다.
 *
 * 지금 카드가 다루는 영역은 서버가 정한다. 부르는 쪽에서 받지 않는다.
 * 꾸러미를 만들 때 쓴 목록과 표에 적는 지문이 같은 값에서 나오게 한다.
 *
 * 하나라도 어긋나면 번호를 만들지 않는다. 다시 부르지 않는다.
 * 앞에서 이미 써 버린 판단이나 표를 되살리지 않는다.
 */
async function issueResearchHandoff(
  harvest: SourceHarvestResult,
  deps: HandlerDeps,
  log: (message: string) => void,
  requestId: string,
): Promise<{ ok: true; handoffId: string } | { ok: false }> {
  if (!deps.issueResearchHandoff) {
    log(`[${requestId}] research_handoff_not_configured`);
    return { ok: false };
  }

  // 서버가 정하는 값 하나에서 목록과 지문이 함께 나온다.
  const activeCoveredDomains = getActiveCoveredDomains();

  let activeCoveredHash: string;
  try {
    activeCoveredHash = await computeActiveCoveredHash(activeCoveredDomains);
  } catch {
    log(`[${requestId}] research_handoff_hash_failed`);
    return { ok: false };
  }

  let built: Awaited<ReturnType<typeof buildBiblicalResearchHandoff>>;
  try {
    built = await buildBiblicalResearchHandoff({ harvest, activeCoveredDomains });
  } catch {
    log(`[${requestId}] research_handoff_build_failed`);
    return { ok: false };
  }

  if (!built.ok) {
    // 어디가 어긋났는지는 밖으로 나누지 않는다.
    log(`[${requestId}] research_handoff_build_failed`);
    return { ok: false };
  }

  const issued = await createBiblicalResearchHandoff({
    handoff: built.handoff,
    activeCoveredHash,
    rpc: deps.issueResearchHandoff,
  });

  if (!issued.ok) {
    log(`[${requestId}] research_handoff_create_failed`);
    return { ok: false };
  }

  // 번호는 기록에 남기지 않는다. 그 자체가 한 번짜리 권한이다.
  log(`[${requestId}] research_handoff_issued`);
  return { ok: true, handoffId: issued.handoffId };
}

const jsonResponse = (body: SuccessBody | ErrorBody, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

/**
 * 이어서 확인하는 요청 하나를 처리한다.
 *
 * 순서를 지킨다.
 *   API Key 확인 → 표 꺼내기(최대 1회) → 이어서 확인하기 실행 → 자료 완성(최대 1회)
 *
 * API Key를 먼저 보는 이유:
 *   서버가 실행 준비도 안 된 상태에서 표를 태워 버리지 않기 위해서다.
 *   표는 한 번 꺼내면 사라진다.
 *
 * 어떤 이유로 실패하든 새 표를 만들지 않고, 다시 부르지도 않는다.
 */
async function handleRecoveryRequest(
  recoveryId: string,
  deps: HandlerDeps,
  log: (message: string) => void,
  requestId: string,
  fail: (code: ErrorCode, status: number) => Response,
): Promise<Response> {
  const recheck = (
    reason: RecoveryRecheckReason,
    parallelInspectionDiagnostics?: ParallelInspectionDiagnostics,
  ) => {
    log(`[${requestId}] ${reason}`);
    return jsonResponse(
      {
        ok: true,
        result: {
          status: 'recheck',
          reason,
          ...(parallelInspectionDiagnostics ? { parallelInspectionDiagnostics } : {}),
        },
      },
      200,
    );
  };

  // 표를 꺼내기 전에 준비 상태부터 본다.
  const apiKey = deps.getApiKey();
  if (!apiKey || apiKey.trim().length === 0) {
    return fail('OPENAI_API_KEY_MISSING', 503);
  }

  if (!deps.consumeRecoveryTicket) return recheck('recovery_ticket_consume_failed');

  // 표를 꺼낸다. 정확히 한 번. 꺼내는 순간 그 줄은 DB에서 사라진다.
  let consumed: unknown;
  try {
    consumed = await deps.consumeRecoveryTicket(recoveryId);
  } catch {
    // 표가 있었는지조차 알 수 없다. 다시 부르지 않는다.
    return recheck('recovery_ticket_consume_failed');
  }

  const ticket = parseConsumeTicketResponse(consumed);
  if (!ticket.ok) {
    // 없는 표, 만료된 표, 이미 쓴 표는 모두 같은 답이다.
    // 꺼냈지만 담긴 값을 쓸 수 없는 경우는 그와 구분한다. 그 줄은 이미 사라졌고 되돌리지 않는다.
    return recheck(ticket.reason === 'empty' ? 'recovery_ticket_unavailable' : 'recovery_ticket_invalid');
  }

  // 지금 카드가 다루는 영역은 서버가 정한다. 부르는 쪽에서 받지 않는다.
  //
  // 남은 주소를 몇 개 확인할지, 몇 개씩 동시에 보낼지, 몇 번에 나눌지는
  // 전부 실행 본체가 정한다. 여기서는 무엇으로 보낼지만 넘긴다.
  // 요청 하나의 시간 제한도 실행 본체가 정해서 알려 준다.
  const outcome = await runParallelSourceHarvestRecovery(
    { ticketState: ticket.state, activeCoveredDomains: getActiveCoveredDomains() },
    {
      callInspection: (payload, options) =>
        deps.callOpenAI(payload, { apiKey, timeoutMs: options.timeoutMs }),
      log: (reason) => log(`[${requestId}] ${reason}`),
    },
  );

  if (outcome.status === 'recheck') {
    return recheck(outcome.reason, outcome.parallelInspectionDiagnostics);
  }

  // 여기서만 자료를 완성한다. sourceId와 확인 날짜는 이 안에서 서버가 만든다.
  const materialized = await materializeHarvestResult({
    brief: outcome.brief,
    draft: outcome.mergedDraft,
    discoveredUrls: ticket.state.discoveredUrls,
    // 실제로 연 주소만 근거다. 받은 주소 전체나 남은 주소 전체를 넣지 않는다.
    evidence: buildRecoveryMaterializationEvidence(outcome.combinedInspectedUrls),
    now: deps.now,
  });

  if (materialized.status !== 'ready') {
    // 첫 번째 요청 쪽 사유를 그대로 내보내지 않는다. 이어서 하기의 최종 계약 실패로 다룬다.
    return recheck('recovery_contract_invalid', outcome.parallelInspectionDiagnostics);
  }

  // 자료를 다 모았다. 이제 연구 단계로 넘길 번호를 하나 발급한다.
  // 번호를 만들지 못하면 자료만 돌려주지 않는다.
  const issued = await issueResearchHandoff(materialized.result, deps, log, requestId);
  if (!issued.ok) return fail('RESEARCH_HANDOFF_STORE_UNAVAILABLE', 503);

  log(`[${requestId}] ready`);
  return jsonResponse(
    {
      ok: true,
      result: {
        status: 'ready',
        handoffId: issued.handoffId,
        harvest: materialized.result,
        diagnostics: materialized.diagnostics,
        parallelInspectionDiagnostics: outcome.parallelInspectionDiagnostics,
      },
    },
    200,
  );
}

export async function handleSourceHarvest(
  request: Request,
  deps: HandlerDeps,
): Promise<Response> {
  const log = deps.log ?? (() => {});
  const requestId = deps.requestId ? deps.requestId() : 'req';
  const fail = (code: ErrorCode, status: number) => {
    log(`[${requestId}] ${code} ${status}`);
    return jsonResponse({ ok: false, error: code }, status);
  };

  // 사전 요청(OPTIONS)도 따로 허용하지 않는다. 내부 전용 endpoint다.
  if (request.method !== 'POST') {
    return fail('METHOD_NOT_ALLOWED', 405);
  }

  // 권한 확인이 먼저다. 실패하면 본문도 읽지 않는다.
  let authorized = false;
  try {
    authorized = await deps.isAuthorized(request);
  } catch {
    authorized = false;
  }
  if (!authorized) {
    return fail('UNAUTHORIZED', 401);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail('INVALID_JSON', 400);
  }

  // 두 가지 요청을 같은 입구에서 받는다.
  //   처음 시작하는 요청  → 판단 번호·영역·근거 판본·판단 시점·활성 영역 다섯 개
  //   이어서 확인하는 요청 → 표 번호 하나
  //
  // 두 검사 모두 "정확히 이 항목만" 방식이므로 섞인 본문은 어느 쪽도 통과하지 못한다.
  const recovery = parseSourceHarvestRecoveryRequest(body);
  if (recovery.ok) {
    try {
      return await handleRecoveryRequest(recovery.input.recoveryId, deps, log, requestId, fail);
    } catch {
      // 예상 못한 실패. 자세한 내용은 밖으로 내보내지 않는다. 다시 시도하지 않는다.
      return fail('INTERNAL_ERROR', 500);
    }
  }

  const parsed = parseHarvestRequest(body);
  if (!parsed.ok) {
    return fail('INVALID_REQUEST', 400);
  }

  // 영역 설명은 서버가 정한다. 부르는 쪽이 넘긴 값을 쓰지 않는다.
  let brief: SourceHarvestBrief;
  try {
    brief = buildSourceHarvestBrief(parsed.input);
  } catch (error) {
    // 연구 대상이 아닌 영역, 모르는 활성 영역 등. 원인 문구는 밖으로 내보내지 않는다.
    if (error instanceof InvalidResearchBriefError || error instanceof Error) {
      return fail('INVALID_REQUEST', 400);
    }
    return fail('INTERNAL_ERROR', 500);
  }

  const apiKey = deps.getApiKey();
  if (!apiKey || apiKey.trim().length === 0) {
    return fail('OPENAI_API_KEY_MISSING', 503);
  }

  // ------------------------------------------------------------------
  // 넘겨받은 판단이 진짜인지 여기서 본다. OpenAI를 부르기 전이다.
  //
  // 이 관문이 없으면, 다른 영역에서 나온 멀쩡한 모양의 값을 붙여 보내도
  // 서버가 틀렸다는 것을 알 방법이 없다. 대조할 원본이 서버에 있어야 한다.
  // ------------------------------------------------------------------

  // 먼저 지금 카드가 다루는 영역이 그때와 같은지 본다.
  //
  // 달라졌다면 그 판단은 더 이상 맞지 않는다.
  // 이때는 판단을 소비하지 않는다. 멀쩡한 한 번짜리 번호를 헛되이 태우지 않기 위해서다.
  // 그 판단은 지우지 않고 수명이 다할 때까지 그대로 둔다.
  let requestActiveCoveredHash: string;
  let currentActiveCoveredHash: string;
  try {
    // 지문 규칙은 새로 만들지 않는다. 이어서 할 표가 쓰는 것과 같은 함수를 쓴다.
    requestActiveCoveredHash = await computeActiveCoveredHash(parsed.input.activeCoveredDomains);
    currentActiveCoveredHash = await computeActiveCoveredHash(getActiveCoveredDomains());
  } catch {
    return fail('PRIORITIZER_DECISION_STORE_UNAVAILABLE', 503);
  }

  if (requestActiveCoveredHash !== currentActiveCoveredHash) {
    // 어느 영역이 달라졌는지는 밖에도 기록에도 남기지 않는다.
    log(`[${requestId}] prioritizer_decision_coverage_stale`);
    return fail('PRIORITIZER_DECISION_UNAVAILABLE', 409);
  }

  if (!deps.consumePrioritizerDecision) {
    log(`[${requestId}] prioritizer_decision_not_configured`);
    return fail('PRIORITIZER_DECISION_STORE_UNAVAILABLE', 503);
  }

  let accepted: unknown;
  try {
    // 정확히 한 번만 부른다. 실패해도 다시 부르지 않는다.
    accepted = await deps.consumePrioritizerDecision({
      decisionId: parsed.input.decisionId,
      prioritizerSnapshotId: parsed.input.prioritizerSnapshotId,
      targetDomain: parsed.input.targetDomain,
      evidenceVersion: parsed.input.evidenceVersion,
      activeCoveredHash: requestActiveCoveredHash,
    });
  } catch {
    // 원본 오류는 옮기지 않는다.
    log(`[${requestId}] prioritizer_decision_consume_failed`);
    return fail('PRIORITIZER_DECISION_STORE_UNAVAILABLE', 503);
  }

  // 표는 참·거짓 하나만 돌려준다. 그 밖의 것이 오면 약속이 어긋난 것이다.
  if (typeof accepted !== 'boolean') {
    log(`[${requestId}] prioritizer_decision_response_invalid`);
    return fail('PRIORITIZER_DECISION_STORE_UNAVAILABLE', 503);
  }

  if (!accepted) {
    // 없는 번호인지, 이미 썼는지, 만료됐는지, 값이 다른지 여기서 나누지 않는다.
    // 표가 그 구분을 밖으로 내보내지 않기로 했고, 여기서 짐작하지 않는다.
    log(`[${requestId}] prioritizer_decision_rejected`);
    return fail('PRIORITIZER_DECISION_UNAVAILABLE', 409);
  }

  // 여기서부터 그 판단은 소비됐다. 다시 살아나지 않는다.
  // 아래에서 무엇이 실패하든 이 번호를 다시 쓰지 못한다. 그렇게 하기로 한 설계다.

  try {
    const outcome = await runSourceHarvest(brief, {
      callDiscovery: (payload) =>
        deps.callOpenAI(payload, { apiKey, timeoutMs: DISCOVERY_TIMEOUT_MS }),
      callVerification: (payload) =>
        deps.callOpenAI(payload, { apiKey, timeoutMs: VERIFICATION_TIMEOUT_MS }),
      now: deps.now,
      createRecoveryTicket: deps.createRecoveryTicket,
      log: (reason) => log(`[${requestId}] ${reason}`),
    });

    // 도구 사용 숫자는 집계 숫자가 있는 결과에만 함께 온다.
    const toolDiagnostics = outcome.verificationToolDiagnostics
      ? { verificationToolDiagnostics: outcome.verificationToolDiagnostics }
      : {};

    if (outcome.status === 'ready') {
      // 자료를 다 모았다. 이제 연구 단계로 넘길 번호를 하나 발급한다.
      // 이 길로 왔다면 이어서 할 표는 만들지 않았다. 끝나는 길은 둘 중 하나다.
      const issued = await issueResearchHandoff(outcome.result, deps, log, requestId);
      if (!issued.ok) return fail('RESEARCH_HANDOFF_STORE_UNAVAILABLE', 503);

      return jsonResponse(
        {
          ok: true,
          result: {
            status: 'ready',
            handoffId: issued.handoffId,
            harvest: outcome.result,
            diagnostics: outcome.diagnostics,
            ...toolDiagnostics,
          },
        },
        200,
      );
    }

    // 표를 만들어 둔 경우. 표 번호와 도구 사용 숫자만 나간다.
    if (outcome.status === 'recovery_required') {
      return jsonResponse(
        {
          ok: true,
          result: {
            status: 'recovery_required',
            recoveryId: outcome.recoveryId,
            verificationToolDiagnostics: outcome.verificationToolDiagnostics,
          },
        },
        200,
      );
    }

    // 집계 숫자가 있을 때만 함께 돌려준다. 없는 것을 억지로 만들지 않는다.
    return jsonResponse(
      {
        ok: true,
        result: {
          status: 'recheck',
          reason: outcome.reason,
          ...(outcome.diagnostics ? { diagnostics: outcome.diagnostics } : {}),
          ...toolDiagnostics,
        },
      },
      200,
    );
  } catch {
    return fail('INTERNAL_ERROR', 500);
  }
}
