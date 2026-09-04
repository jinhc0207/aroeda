/**
 * Request B (이어서 확인하기) 계약 · 순수 로직
 *
 * 무엇을 위한 것인가:
 *   첫 번째 요청(Request A)의 2단계가 받은 주소를 충분히 열어 보지 못하고 멈추면,
 *   그때까지의 결과가 표(Recovery Ticket)에 남는다.
 *   이 파일은 "그 표를 들고 와서 남은 주소를 마저 확인하는" 두 번째 요청의 규격이다.
 *
 * 이 파일이 하는 일:
 *   두 번째 요청의 입력 모양을 정하고, 무엇을 얼마나 더 확인해야 하는지 계산하고,
 *   모델에게 보낼 요청서를 만든다.
 *
 * 이 파일이 하지 않는 일:
 *   DB 접근, 네트워크, 환경변수 읽기, 실제 실행, 결과 합치기, 자료 완성.
 *
 * 누가 쓰는가:
 *   source-harvester의 두 번째 요청 경로가 이 규격을 쓴다.
 *   표를 실제로 꺼내는 일은 handler.ts와 index.ts가,
 *   남은 주소 확인과 두 결과 합치기는 source-harvester-recovery-execution.ts가,
 *   자료 완성은 handler.ts가 기존 materializeHarvestResult로 맡는다.
 *
 * 규칙은 새로 쓰지 않는다:
 *   표 번호 모양      → harvest-recovery-ticket.ts의 isRecoveryId
 *   영역 목록 지문     → harvest-recovery-ticket.ts의 computeActiveCoveredHash
 *   확인할 주소 수     → source-harvester-execution-contract.ts의 getVerificationInspectionTarget
 *   응답 구조         → source-harvester-execution-contract.ts의 buildSourceHarvestDraftSchema
 *   모델·도구·출력 상한 → source-harvester-execution-contract.ts의 상수
 */

import { RESEARCH_CONSTITUTION } from './biblical-research-contract.ts';
import {
  RESPONSE_INCLUDE,
  SOURCE_HARVEST_MODEL,
  UNTRUSTED_WEB_CONTENT_RULE,
  VERIFICATION_MAX_OUTPUT_TOKENS,
  VERIFICATION_MAX_TOOL_CALLS,
  WEB_SEARCH_TOOL,
  buildSourceHarvestDraftSchema,
  getVerificationInspectionTarget,
} from './source-harvester-execution-contract.ts';
import { isRecoveryId, computeActiveCoveredHash } from './harvest-recovery-ticket.ts';

/* ------------------------------------------------------------------ */
/* 두 번째 요청의 입력                                                   */
/* ------------------------------------------------------------------ */

/**
 * 두 번째 요청이 받는 것은 표 번호 하나뿐이다.
 *
 * 영역, 근거 판본, 판단 시점 id, 활성 영역 목록, 발견된 주소, 앞서 쓴 초안은
 * 전부 표 안에 있거나 서버가 지금 알고 있는 값이다. 부르는 쪽이 다시 제출하지 않는다.
 * 다시 받으면 두 번째 요청이 그중 하나를 바꿔치기할 자리가 생긴다.
 */
export type SourceHarvestRecoveryRequest = {
  recoveryId: string;
};

const RECOVERY_REQUEST_FIELDS = ['recoveryId'] as const;

/**
 * 두 번째 요청 본문을 검사한다.
 *
 * 표 번호 모양은 새로 정하지 않고 기존 isRecoveryId를 그대로 쓴다.
 * 잘못된 값은 그대로 버린다. 그 값을 로그나 응답에 남기지 않는다.
 */
export function parseSourceHarvestRecoveryRequest(
  body: unknown,
): { ok: true; input: SourceHarvestRecoveryRequest } | { ok: false } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { ok: false };

  const value = body as Record<string, unknown>;

  for (const key of Object.keys(value)) {
    if (!(RECOVERY_REQUEST_FIELDS as readonly string[]).includes(key)) return { ok: false };
  }
  for (const key of RECOVERY_REQUEST_FIELDS) {
    if (!(key in value)) return { ok: false };
  }

  if (!isRecoveryId(value.recoveryId)) return { ok: false };

  return { ok: true, input: { recoveryId: value.recoveryId } };
}

/* ------------------------------------------------------------------ */
/* 표의 수명 (약속만 적어 둔다. 실행은 handler/index)                     */
/* ------------------------------------------------------------------ */

/**
 * 표를 언제 꺼내는가에 대한 약속.
 *
 * 두 번째 요청은 **모델을 부르기 전에** 표를 꺼낸다(consume).
 * 꺼내는 순간 그 줄은 DB에서 사라지므로, 줄이 남아 있다는 것은 아직 안 썼다는 뜻이다.
 *
 * 그래서 실패해도:
 *   새 표를 만들지 않는다. 다시 부르지 않는다. 세 번째 요청을 만들지 않는다.
 *
 * 이 순서를 뒤집으면(모델을 먼저 부르고 나중에 꺼내면) 같은 표로 두 번 연구가 돌 수 있다.
 * 실제로 꺼내는 코드는 index.ts와 handler.ts에 있다. 여기에는 그 약속만 적어 둔다.
 */
export const RECOVERY_TICKET_LIFECYCLE = {
  /** 표를 꺼내는 시점: 모델을 부르기 전 */
  consumeBeforeModelCall: true,
  /** 실패해도 다시 부르지 않는다 */
  maxRecoveryModelCalls: 1,
  /** 실패해도 새 표를 만들지 않는다 */
  createsNewTicketOnFailure: false,
  /** 첫 번째 요청과 달리 새로 찾는 단계(Discovery)가 없다 */
  discoveryCalls: 0,
} as const;

/**
 * 최종 자료를 만드는 일에 대한 약속.
 *
 * 첫 번째 요청에서 확인한 주소와 두 번째 요청에서 확인한 주소를 합쳐
 * 처음에 정한 확인 목표를 채웠을 때에만, 최대 한 번 자료를 완성한다.
 *
 * 두 번째 요청에서도 모자라면: 자료를 만들지 않고, 새 표도 만들지 않고, 다시 부르지도 않는다.
 * 합치는 일은 source-harvester-recovery-execution.ts가,
 * 완성하는 일은 handler.ts가 기존 materializeHarvestResult로 한다.
 */
export const RECOVERY_MATERIALIZATION_RULE = {
  requiresCombinedInspectionTarget: true,
  maxMaterializations: 1,
  materializesOnShortBreadth: false,
} as const;

/* ------------------------------------------------------------------ */
/* 카드가 다루는 영역이 그 사이에 달라졌는가                              */
/* ------------------------------------------------------------------ */

/**
 * 표를 만들 때와 지금, 카드가 다루던 영역 목록이 같은가.
 *
 * 그 사이에 새 카드가 생겼다면 이 연구는 전제가 달라진 것이므로 이어서 하지 않는다.
 * 지문을 만드는 방법은 새로 정하지 않고 기존 computeActiveCoveredHash를 그대로 쓴다.
 */
export async function matchesRecoveryCoverageSnapshot(
  ticketHash: string,
  currentActiveCoveredDomains: readonly string[],
): Promise<boolean> {
  if (typeof ticketHash !== 'string' || ticketHash.length === 0) return false;
  return ticketHash === (await computeActiveCoveredHash(currentActiveCoveredDomains));
}

/* ------------------------------------------------------------------ */
/* 무엇을 얼마나 더 확인해야 하는가                                       */
/* ------------------------------------------------------------------ */

/**
 * 두 번째 요청이 다룰 범위.
 *
 * remainingUrls: 아직 열어 보지 않은 주소. 1단계에서 받은 순서를 그대로 유지한다.
 * originalInspectionTarget: 처음에 정한 "서로 다른 주소 몇 개를 열어야 하는가".
 * requiredAdditionalInspections: 목표까지 앞으로 몇 개를 더 열어야 하는가.
 */
export type RecoveryScope = {
  remainingUrls: string[];
  originalInspectionTarget: number;
  primaryInspectedCount: number;
  requiredAdditionalInspections: number;
};

/** 범위를 정할 수 없는 이유. 조용히 고쳐서 진행하지 않는다. */
export type RecoveryScopeError =
  /** 표에 담긴 주소 목록의 모양이 잘못됐다 */
  | 'invalid_url_lists'
  /** 열어 본 주소가 받은 주소 목록 밖에 있다 */
  | 'inspected_not_discovered'
  /** 이미 목표를 채웠다. 이어서 할 일이 없다 */
  | 'target_already_met'
  /** 남은 주소가 없다 */
  | 'no_remaining_urls'
  /** 남은 주소가 더 열어야 하는 수보다 적다 */
  | 'remaining_shorter_than_required';

/**
 * 표에 담긴 상태에서 두 번째 요청의 범위를 계산한다.
 *
 * 잘못된 상태를 조용히 보정하지 않는다. 하나라도 어긋나면 이유와 함께 멈춘다.
 * 목표 숫자는 새로 정하지 않고 첫 번째 요청과 같은 helper를 쓴다.
 */
export function deriveRecoveryScope(input: {
  discoveredUrls: readonly string[];
  primaryInspectedUrls: readonly string[];
}): { ok: true; scope: RecoveryScope } | { ok: false; reason: RecoveryScopeError } {
  const { discoveredUrls, primaryInspectedUrls } = input;

  const isStringList = (value: readonly unknown[]) =>
    Array.isArray(value) && value.every((item) => typeof item === 'string' && item.length > 0);

  if (!isStringList(discoveredUrls) || !isStringList(primaryInspectedUrls)) {
    return { ok: false, reason: 'invalid_url_lists' };
  }
  if (discoveredUrls.length === 0) return { ok: false, reason: 'invalid_url_lists' };

  // 같은 주소가 두 번 있으면 셈이 어긋난다. 하나만 남기고 넘어가지 않는다.
  if (new Set(discoveredUrls).size !== discoveredUrls.length) {
    return { ok: false, reason: 'invalid_url_lists' };
  }
  if (new Set(primaryInspectedUrls).size !== primaryInspectedUrls.length) {
    return { ok: false, reason: 'invalid_url_lists' };
  }

  const discovered = new Set(discoveredUrls);
  for (const url of primaryInspectedUrls) {
    if (!discovered.has(url)) return { ok: false, reason: 'inspected_not_discovered' };
  }

  const inspected = new Set(primaryInspectedUrls);
  // 받은 순서를 그대로 둔다. 정렬하지 않고, 주소를 다시 다듬지도 않는다.
  const remainingUrls = discoveredUrls.filter((url) => !inspected.has(url));

  const originalInspectionTarget = getVerificationInspectionTarget(discoveredUrls);
  const primaryInspectedCount = primaryInspectedUrls.length;
  const requiredAdditionalInspections = originalInspectionTarget - primaryInspectedCount;

  // 표는 확인 범위가 모자랄 때만 만들어진다. 이미 채웠다면 그 표가 잘못된 것이다.
  if (requiredAdditionalInspections <= 0) return { ok: false, reason: 'target_already_met' };
  if (remainingUrls.length === 0) return { ok: false, reason: 'no_remaining_urls' };
  if (requiredAdditionalInspections > remainingUrls.length) {
    return { ok: false, reason: 'remaining_shorter_than_required' };
  }

  return {
    ok: true,
    scope: {
      remainingUrls,
      originalInspectionTarget,
      primaryInspectedCount,
      requiredAdditionalInspections,
    },
  };
}

/* ------------------------------------------------------------------ */
/* 실패 사유                                                            */
/* ------------------------------------------------------------------ */

/**
 * 두 번째 요청이 끝날 수 있는 이유들.
 *
 * 서로 다른 원인을 하나로 뭉치지 않는다. 무엇 때문에 멈췄는지 알 수 없게 되기 때문이다.
 * 아직 어느 실행 코드에도 연결되어 있지 않다.
 */
export const RECOVERY_RECHECK_REASONS = [
  /**
   * 표가 있는지 없는지조차 알 수 없었다.
   * DB 설정이 없거나, 요청이 실패했거나, 시간이 넘었거나, 응답을 읽을 수 없었다.
   * 아래 두 사유와 다르다. 저 둘은 DB가 정상으로 답을 준 경우다.
   */
  'recovery_ticket_consume_failed',
  /** 표가 없거나, 만료됐거나, 이미 쓰였다. 셋을 구분해서 알려주지 않는다. */
  'recovery_ticket_unavailable',
  /** 표를 꺼냈지만 담긴 값이 계약에 맞지 않는다 */
  'recovery_ticket_invalid',
  /** 표를 만든 뒤 카드가 다루는 영역이 달라졌다 */
  'recovery_coverage_changed',
  /** 남은 주소와 더 열어야 하는 수를 정할 수 없다 */
  'recovery_scope_invalid',
  /** 모델 요청 자체가 실패했다 (시간 초과, HTTP 오류 등) */
  'recovery_request_failed',
  /** 응답을 읽을 수 없거나 구조가 맞지 않는다 */
  'recovery_response_invalid',
  /** 응답이 중간에 끊겼다 */
  'recovery_incomplete',
  /** 모델이 답하기를 거절했다 */
  'recovery_refusal',
  /** 남은 주소 목록 밖의 주소를 열거나 초안에 적었다 */
  'recovery_url_out_of_scope',
  /** 첫 번째와 합쳐도 열어 본 서로 다른 주소가 목표에 못 미친다 */
  'insufficient_recovery_inspection',
  /** 합친 결과가 최종 자료 계약을 지키지 못했다 */
  'recovery_contract_invalid',
] as const;
export type RecoveryRecheckReason = (typeof RECOVERY_RECHECK_REASONS)[number];

/* ------------------------------------------------------------------ */
/* 시간 제한                                                            */
/* ------------------------------------------------------------------ */

/**
 * 이어서 확인하기 요청 하나를 기다리는 시간.
 *
 * 두 번째 요청은 첫 번째와 별개의 HTTP 요청이므로 시간 예산도 따로 잡는다.
 * 이 요청에서 일어나는 일은 두 가지뿐이다.
 *   표 꺼내기(5초) + 모델 한 번(120초) = 125초
 *
 * Supabase가 한 요청을 기다려 주는 시간은 150초다.
 * 남은 25초는 응답을 읽고, 검사하고, 두 초안을 합치고, 자료를 완성하고,
 * 돌려줄 답을 꾸미는 데 쓴다. 그 시간은 위 합에 들어 있지 않다.
 *
 * 첫 번째 요청의 시간 제한(60 / 75 / 5)은 이 값과 무관하며 바뀌지 않는다.
 */
export const RECOVERY_VERIFICATION_TIMEOUT_MS = 120_000;

/* ------------------------------------------------------------------ */
/* 모델에게 보낼 요청서                                                  */
/* ------------------------------------------------------------------ */

/**
 * 이어서 확인하기 지시문.
 *
 * 새로 찾는 단계가 아니다. 이미 받은 주소 중 아직 열어 보지 않은 것만 다룬다.
 * 첫 번째 요청에서 이미 확인한 주소는 목록에 넣지 않는다.
 * 그 주소를 다시 열어서 확인한 수를 채우는 길을 아예 만들지 않기 위해서다.
 */
export function buildRecoveryVerificationInstructions(input: {
  targetDomain: string;
  domainDescription: string;
  remainingUrls: readonly string[];
  requiredAdditionalInspections: number;
}): string {
  const required = input.requiredAdditionalInspections;

  return `당신은 아뢰다의 Source Harvester입니다. 앞서 하던 자료 확인을 이어서 합니다.

연구 대상 영역: ${input.targetDomain}
영역 설명: ${input.domainDescription}

앞선 요청에서 이미 확인한 주소가 있습니다.
그 주소들은 아래 목록에 없습니다. 다시 찾지 마십시오.
아래 목록은 아직 확인하지 않은 주소입니다.

이것은 새 자료를 찾는 단계가 아닙니다.
아래 목록 밖에서 자료를 찾지 마십시오.

최종 JSON의 url에는 전달받은 주소 문자열을 그대로 골라 넣으십시오.
주소를 다시 쓰거나, 고치거나, 다른 주소로 바꾸지 마십시오.

절대 하지 않는 일:

- 목록에 없는 새 주소를 만들지 않는다.
- 검색 결과 요약만 보고 자료를 승인하지 않는다.
- 성경 본문을 고르거나 해석하지 않는다.
- 자료의 내용을 그대로 옮겨 적거나 길게 인용하지 않는다.
- sourceId나 확인 날짜를 적지 않는다. 그 값은 서버가 만듭니다.

[sources에 넣기 전에 반드시 그 페이지를 여십시오]

자료를 sources에 넣기 전에, 먼저 그 주소를 실제로 열어 내용이나 초록을 확인하십시오.
검색 결과에 나온 요약문은 확인이 아닙니다.
페이지를 열지 못한 주소는 채택 후보가 아닙니다. sources에 넣지 마십시오.

[최종 답변 전에 확인할 범위]

최종 JSON을 쓰기 전에, 아래 목록에서 서로 다른 주소를 최소 ${required}개 열어
내용이나 초록을 확인하십시오.

이 숫자는 채택해야 하는 자료 수가 아닙니다. 열어 볼 주소의 수입니다.
${required}개를 열어 본 뒤 채택할 만한 자료가 적다면, 적은 대로 두십시오.
숫자를 맞추려고 낮은 품질의 자료를 sources에 넣지 마십시오.

같은 주소를 여러 번 열거나 같은 페이지 안에서 다시 찾아보는 것으로
서로 다른 주소를 확인한 것을 대신할 수 없습니다.

[확인해야 하는 정보]

페이지를 실제로 확인한 뒤 제목, 저자 또는 작성 기관, 발행처 또는 소속 기관, 출판 연도를 적으십시오.
확인되지 않은 것을 추측해서 적지 마십시오.
출판 연도를 확인하지 못했으면 null로 두십시오.

[내용을 어디까지 확인했는가]

- full_text: 주요 본문을 확인했다
- substantial_preview: 연구에 필요한 부분을 실제로 확인했다
- abstract_only: 초록까지만 확인했다

초록만 확인했더라도 그 초록 페이지를 실제로 열어야 합니다.

[자료의 역할]

의료·법률·재정·상담 자료는 현실의 안전과 전문적 도움의 경계를 확인하는 용도입니다.
성경 해석의 근거로 쓰지 마십시오.
목회 보조자료도 성경 해석의 핵심 근거가 될 수 없습니다.

[채택하지 않은 자료]

목록에 있었지만 쓰지 않기로 한 자료도 이유와 함께 남기십시오.
정해진 최대 수까지 채울 필요는 없습니다.

${UNTRUSTED_WEB_CONTENT_RULE}

[아뢰다 원칙]

${RESEARCH_CONSTITUTION.join('\n')}

[아직 확인하지 않은 주소 목록]

${input.remainingUrls.map((url) => `- ${url}`).join('\n')}`;
}

/**
 * 이어서 확인하기 요청 본문.
 *
 * 표 번호는 여기에 들어가지 않는다. 모델이 알 필요가 없고, 밖으로 나갈 이유도 없다.
 * 앞서 쓴 초안도 보내지 않는다. 이미 확인한 자료를 다시 판단하는 단계가 아니다.
 *
 * 모델·도구·출력 상한은 2단계와 같은 상수를 그대로 쓴다.
 * 응답 구조도 같은 builder를 쓰되, 고를 수 있는 주소만 남은 주소로 좁힌다.
 */
export function buildRecoveryVerificationPayload(input: {
  targetDomain: string;
  domainDescription: string;
  evidenceVersion: number;
  prioritizerSnapshotId: string;
  remainingUrls: readonly string[];
  requiredAdditionalInspections: number;
}): Record<string, unknown> {
  return {
    model: SOURCE_HARVEST_MODEL,
    store: false,
    instructions: buildRecoveryVerificationInstructions({
      targetDomain: input.targetDomain,
      domainDescription: input.domainDescription,
      remainingUrls: input.remainingUrls,
      requiredAdditionalInspections: input.requiredAdditionalInspections,
    }),
    input: JSON.stringify({
      targetDomain: input.targetDomain,
      evidenceVersion: input.evidenceVersion,
      prioritizerSnapshotId: input.prioritizerSnapshotId,
      remainingUrls: [...input.remainingUrls],
      requiredAdditionalInspections: input.requiredAdditionalInspections,
    }),
    tools: [{ ...WEB_SEARCH_TOOL }],
    max_tool_calls: VERIFICATION_MAX_TOOL_CALLS,
    max_output_tokens: VERIFICATION_MAX_OUTPUT_TOKENS,
    include: [...RESPONSE_INCLUDE],
    text: {
      format: {
        type: 'json_schema',
        name: 'source_harvest_draft',
        strict: true,
        // 고를 수 있는 주소는 아직 확인하지 않은 것뿐이다.
        // 이미 확인한 주소를 다시 적어 확인한 수를 채울 수 없다.
        schema: buildSourceHarvestDraftSchema(input.remainingUrls),
      },
    },
  };
}
