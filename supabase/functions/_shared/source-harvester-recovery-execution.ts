/**
 * Request B (이어서 확인하기) 실행 본체 · 순수 로직
 *
 * 하는 일:
 *   표에서 꺼낸 상태를 다시 확인하고, 남은 주소를 마저 확인하도록 모델을 한 번 부르고,
 *   실제로 열어 본 기록만 근거로 삼아 첫 번째 결과와 합친다.
 *
 * 이 파일이 하지 않는 일:
 *   네트워크 호출, DB 접근, 환경변수 읽기, 표 꺼내기, 재시도,
 *   자료 완성(sourceId·확인 날짜 만들기).
 *   모델 요청은 주입받은 callRecovery로만 나간다.
 *
 * 규칙은 새로 쓰지 않는다:
 *   표 상태 검사   → harvest-recovery-ticket.ts
 *   주소 정리      → source-harvester.ts의 normalizeSourceUrl
 *   응답 읽기·초안 검사·도구 기록 → source-harvester-execution.ts
 *   범위·요청서·실패 사유 → source-harvester-recovery-contract.ts
 *
 * 표는 이 함수에 들어오기 전에 이미 DB에서 꺼내어져(줄이 삭제되어) 있다.
 * 그렇더라도 DB에서 왔다는 이유로 그 값을 믿지 않는다. 여기서 다시 확인한다.
 *
 * 누가 쓰는가:
 *   이 파일의 runSourceHarvestRecovery는 지금 쓰이지 않는다.
 *   두 번째 요청은 주소를 하나씩 나누어 확인하는 쪽
 *   (source-harvester-parallel-recovery-execution.ts)으로 바뀌었다.
 *   견주어 볼 수 있게 코드와 시험을 지우지 않고 남겨 두었다.
 *
 *   다만 이 파일의 다음 것들은 지금도 쓰인다.
 *     validateStoredPrimaryAuthority, combineInspectedUrls,
 *     mergePrimaryAndRecoveryDrafts  → 병렬 실행 본체가 쓴다
 *     buildRecoveryMaterializationEvidence → handler가 자료를 완성할 때 쓴다
 */

import { ACCEPTED_MAX, REJECTED_SOURCE_MAX } from './source-harvest-contract.ts';
import {
  buildSourceHarvestBrief,
  normalizeSourceUrl,
  type RejectedSource,
  type SourceHarvestBrief,
} from './source-harvester.ts';
import {
  extractVerificationToolDiagnostics,
  extractWebSearchEvidence,
  parseVerificationResponse,
  validateHarvestDraft,
  type SourceHarvestDraftResult,
  type VerificationToolDiagnostics,
  type VerifiedSourceDraft,
  type WebSearchEvidence,
} from './source-harvester-execution.ts';
import {
  parseHarvestRecoveryTicketState,
  type HarvestRecoveryTicketState,
} from './harvest-recovery-ticket.ts';
import {
  buildRecoveryVerificationPayload,
  deriveRecoveryScope,
  matchesRecoveryCoverageSnapshot,
  type RecoveryRecheckReason,
  type RecoveryScope,
} from './source-harvester-recovery-contract.ts';

/* ------------------------------------------------------------------ */
/* 결과 모양                                                            */
/* ------------------------------------------------------------------ */

/**
 * 이어서 확인하기 한 번의 결과.
 *
 * ready_to_materialize는 아직 완성된 자료가 아니다.
 * "이제 자료를 만들어도 되는 상태"라는 뜻이며, 실제로 만드는 일은 다음 단계가 한다.
 * 그래서 여기에는 sourceId도, 확인 날짜도 없다.
 *
 * 이 결과는 밖으로 나가는 HTTP 응답이 아니다. 서버 안에서만 쓴다.
 */
export type RecoveryOutcome =
  | {
      status: 'ready_to_materialize';
      brief: SourceHarvestBrief;
      /** 첫 번째와 두 번째를 합친 가공 전 초안 */
      mergedDraft: SourceHarvestDraftResult;
      /** 두 번을 합쳐 실제로 열어 본 주소. 1단계에서 받은 순서를 따른다. */
      combinedInspectedUrls: string[];
      recoveryToolDiagnostics: VerificationToolDiagnostics;
    }
  | {
      status: 'recheck';
      reason: RecoveryRecheckReason;
      /** 모델을 부르기 전에 끝난 경우에는 없다. 숫자만 들어간다. */
      recoveryToolDiagnostics?: VerificationToolDiagnostics;
    };

export type RecoveryDeps = {
  /** 이어서 확인하기 요청. 정확히 한 번만 부른다. 실패해도 다시 부르지 않는다. */
  callRecovery: (payload: Record<string, unknown>) => Promise<unknown>;
  /** 이유 코드만 남긴다. 주소, 원본 응답, 웹페이지 내용은 남기지 않는다. */
  log?: (reason: string) => void;
};

/* ------------------------------------------------------------------ */
/* 표에 담겨 있던 첫 번째 결과를 다시 확인한다                             */
/* ------------------------------------------------------------------ */

/**
 * 표에 담긴 첫 번째 초안이 여전히 약속을 지키고 있는가.
 *
 * 표를 만들 때 이미 걸러 낸 것이지만 여기서 다시 본다.
 * 그 사이에 DB가 손상됐거나, 옛 코드가 만든 표이거나, 나중에 규칙이 어긋날 수 있기 때문이다.
 *
 * 확인하는 것: 초안에 적힌 주소가 모두 1단계에서 받은 주소이면서
 *             1단계에서 실제로 열어 본 주소일 것.
 *
 * 반대로, 열어 봤지만 초안에 적히지 않은 주소가 있는 것은 정상이다.
 * 열어 보고 나서 채택하지도 제외하지도 않을 수 있다.
 */
export function validateStoredPrimaryAuthority(state: HarvestRecoveryTicketState): boolean {
  const discovered = new Set(state.discoveredUrls);
  const inspected = new Set(state.primaryInspectedUrls);

  const accepted = new Set<string>();
  for (const entry of state.primaryDraft.sources) {
    const canonical = normalizeSourceUrl(entry.url);
    if (canonical === null) return false;
    if (!discovered.has(canonical) || !inspected.has(canonical)) return false;
    if (accepted.has(canonical)) return false;
    accepted.add(canonical);
  }

  const rejected = new Set<string>();
  for (const entry of state.primaryDraft.rejectedSources) {
    const canonical = normalizeSourceUrl(entry.url);
    if (canonical === null) return false;
    if (!discovered.has(canonical) || !inspected.has(canonical)) return false;
    if (rejected.has(canonical)) return false;
    // 같은 자료를 채택하면서 동시에 제외할 수는 없다.
    if (accepted.has(canonical)) return false;
    rejected.add(canonical);
  }

  return true;
}

/* ------------------------------------------------------------------ */
/* 이번에 실제로 확인한 것만 남긴다                                       */
/* ------------------------------------------------------------------ */

/** 이번 요청에서 실제로 열어 본 주소에 대해서만 쓴 초안 */
export type AuthoritativeRecoveryDraft = {
  sources: VerifiedSourceDraft[];
  rejectedSources: RejectedSource[];
  unresolvedSourceQuestions: string[];
};

/**
 * 이어서 확인하기 초안에서 실제로 열어 본 주소의 것만 남긴다.
 *
 * 응답 구조에서 이미 남은 주소만 고를 수 있게 묶어 두었지만 여기서 다시 본다.
 * 구조 제한을 서버 확인의 대체물로 삼지 않는다.
 *
 * sourceId와 확인 날짜는 여기서도 만들지 않는다.
 */
export function buildAuthoritativeRecoveryDraft(input: {
  draft: SourceHarvestDraftResult;
  remainingUrls: readonly string[];
  recoveryInspectedUrls: readonly string[];
}): { ok: true; draft: AuthoritativeRecoveryDraft } | { ok: false; reason: RecoveryRecheckReason } {
  const remaining = new Set(input.remainingUrls);
  const inspected = new Set(input.recoveryInspectedUrls);

  const sources: VerifiedSourceDraft[] = [];
  const seenAccepted = new Set<string>();

  for (const entry of input.draft.sources) {
    const canonical = normalizeSourceUrl(entry.url);
    if (canonical === null) return { ok: false, reason: 'recovery_response_invalid' };
    // 이번에 다룰 수 있는 주소가 아니다. 첫 번째에서 이미 본 주소도 여기에 없다.
    if (!remaining.has(canonical)) return { ok: false, reason: 'recovery_url_out_of_scope' };
    if (seenAccepted.has(canonical)) return { ok: false, reason: 'recovery_contract_invalid' };
    seenAccepted.add(canonical);

    // 열어 본 기록이 없는 자료는 남기지 않는다. 페이지를 보지 않고 쓴 설명이기 때문이다.
    if (!inspected.has(canonical)) continue;

    sources.push({
      sourceType: entry.sourceType,
      title: entry.title,
      authorOrOrganization: entry.authorOrOrganization,
      publisherOrInstitution: entry.publisherOrInstitution,
      publicationYear: entry.publicationYear,
      url: canonical,
      accessLevel: entry.accessLevel,
      intendedUse: [...entry.intendedUse],
      relevanceNote: entry.relevanceNote,
      // 근거는 그대로 옮긴다. 서버가 다시 쓰거나 덧붙이지 않는다.
      evidenceClaims: entry.evidenceClaims.map((claim) => ({
        intendedUse: claim.intendedUse,
        statement: claim.statement,
        passageReferences: claim.passageReferences.map((reference) => ({ ...reference })),
      })),
    });
  }

  const rejectedSources: RejectedSource[] = [];
  const seenRejected = new Set<string>();

  for (const entry of input.draft.rejectedSources) {
    const canonical = normalizeSourceUrl(entry.url);
    if (canonical === null) return { ok: false, reason: 'recovery_response_invalid' };
    if (!remaining.has(canonical)) return { ok: false, reason: 'recovery_url_out_of_scope' };
    if (seenRejected.has(canonical)) return { ok: false, reason: 'recovery_contract_invalid' };
    if (seenAccepted.has(canonical)) return { ok: false, reason: 'recovery_contract_invalid' };
    seenRejected.add(canonical);

    if (!inspected.has(canonical)) continue;

    rejectedSources.push({
      url: canonical,
      title: entry.title,
      rejectionReason: entry.rejectionReason,
    });
  }

  return {
    ok: true,
    draft: {
      sources,
      rejectedSources,
      unresolvedSourceQuestions: [...input.draft.unresolvedSourceQuestions],
    },
  };
}

/* ------------------------------------------------------------------ */
/* 두 결과를 합친다                                                      */
/* ------------------------------------------------------------------ */

/**
 * 첫 번째 초안과 이어서 확인한 초안을 합친다.
 *
 * 순서는 언제나 같다. 첫 번째 것을 먼저 두고 두 번째 것을 뒤에 잇는다.
 * 정렬하지도, 점수로 고르지도, 겹치는 질문을 임의로 지우지도 않는다.
 * 같은 입력이면 언제나 같은 결과가 나와야 하기 때문이다.
 *
 * 두 단계는 원래 서로 다른 주소를 다루므로 겹칠 일이 없지만, 그래도 여기서 다시 본다.
 */
export function mergePrimaryAndRecoveryDrafts(input: {
  brief: SourceHarvestBrief;
  primaryDraft: HarvestRecoveryTicketState['primaryDraft'];
  recoveryDraft: AuthoritativeRecoveryDraft;
}): { ok: true; draft: SourceHarvestDraftResult } | { ok: false; reason: RecoveryRecheckReason } {
  const sources = [...input.primaryDraft.sources, ...input.recoveryDraft.sources];
  const rejectedSources = [...input.primaryDraft.rejectedSources, ...input.recoveryDraft.rejectedSources];

  const accepted = new Set<string>();
  for (const entry of sources) {
    const canonical = normalizeSourceUrl(entry.url);
    if (canonical === null) return { ok: false, reason: 'recovery_contract_invalid' };
    if (accepted.has(canonical)) return { ok: false, reason: 'recovery_contract_invalid' };
    accepted.add(canonical);
  }

  const rejected = new Set<string>();
  for (const entry of rejectedSources) {
    const canonical = normalizeSourceUrl(entry.url);
    if (canonical === null) return { ok: false, reason: 'recovery_contract_invalid' };
    if (rejected.has(canonical)) return { ok: false, reason: 'recovery_contract_invalid' };
    if (accepted.has(canonical)) return { ok: false, reason: 'recovery_contract_invalid' };
    rejected.add(canonical);
  }

  // 각 단계가 상한을 지켰다고 해서 합친 결과가 지켜지는 것은 아니다.
  // 최종 검증이 쓰는 것과 같은 상수를 여기서도 본다.
  if (sources.length > ACCEPTED_MAX) return { ok: false, reason: 'recovery_contract_invalid' };
  // 두 단계의 제외 기록은 모두 모델이 남긴 것이다. 서버가 붙이는 기록은 아직 없다.
  if (rejectedSources.length > REJECTED_SOURCE_MAX) {
    return { ok: false, reason: 'recovery_contract_invalid' };
  }

  return {
    ok: true,
    draft: {
      targetDomain: input.brief.targetDomain,
      evidenceVersion: input.brief.evidenceVersion,
      prioritizerSnapshotId: input.brief.prioritizerSnapshotId,
      sources,
      rejectedSources,
      unresolvedSourceQuestions: [
        ...input.primaryDraft.unresolvedSourceQuestions,
        ...input.recoveryDraft.unresolvedSourceQuestions,
      ],
    },
  };
}

/**
 * 두 번에 걸쳐 실제로 열어 본 주소를 하나로 모은다.
 *
 * 순서는 도구를 쓴 순서가 아니라 1단계에서 받은 주소 목록의 순서를 따른다.
 * 그래야 같은 입력이면 언제나 같은 결과가 나온다.
 */
export function combineInspectedUrls(input: {
  discoveredUrls: readonly string[];
  primaryInspectedUrls: readonly string[];
  recoveryInspectedUrls: readonly string[];
}): string[] {
  const combined = new Set([...input.primaryInspectedUrls, ...input.recoveryInspectedUrls]);
  return input.discoveredUrls.filter((url) => combined.has(url));
}

/**
 * 자료를 완성하는 단계에 넘길 "실제로 확인한 기록".
 *
 * 두 번에 걸쳐 실제로 연 주소만 담는다.
 * 검색 결과나 인용 기록은 비워 둔다. 없었다는 뜻이지, 지어내지 않는다는 뜻이기도 하다.
 *
 * 받은 주소 전체나 남은 주소 전체를 여기에 넣으면 안 된다.
 * 그러면 열어 보지 않은 자료가 채택될 수 있다.
 */
export function buildRecoveryMaterializationEvidence(
  combinedInspectedUrls: readonly string[],
): WebSearchEvidence {
  return {
    inspectedUrls: [...combinedInspectedUrls],
    searchSourceUrls: [],
    citedUrls: [],
    rawObservedUrls: [],
  };
}

/* ------------------------------------------------------------------ */
/* 전체 실행                                                            */
/* ------------------------------------------------------------------ */

/**
 * 이어서 확인하기 한 번을 실행한다.
 *
 * 모델 요청은 최대 한 번뿐이다. 실패해도 다시 부르지 않고, 새 표도 만들지 않는다.
 * 세 번째 요청은 없다.
 *
 * 검사 순서를 지킨다.
 *   응답 읽기 → 초안 형식 → 실제 도구 기록 → 열어 본 주소 범위
 *   → 초안 주소 범위·중복·충돌 → 그 다음에 확인 범위(개수) 판단
 *
 * 잘못된 초안을 "어차피 개수가 모자라니까"로 덮지 않기 위해서다.
 */
export async function runSourceHarvestRecovery(
  input: {
    /** 표에서 꺼낸 상태. DB에서 왔더라도 여기서 다시 확인한다. */
    ticketState: unknown;
    /** 지금 카드가 다루고 있는 영역 목록 */
    activeCoveredDomains: readonly string[];
  },
  deps: RecoveryDeps,
): Promise<RecoveryOutcome> {
  const log = deps.log ?? (() => {});
  const stop = (reason: RecoveryRecheckReason): RecoveryOutcome => {
    log(reason);
    return { status: 'recheck', reason };
  };

  // 1. 표에서 꺼낸 값이 담을 때의 규칙을 지키는가
  const parsed = parseHarvestRecoveryTicketState(input.ticketState);
  if (!parsed.ok) return stop('recovery_ticket_invalid');
  const state = parsed.state;

  // 2. 표에 담겨 있던 첫 번째 초안이 여전히 약속을 지키는가
  if (!validateStoredPrimaryAuthority(state)) return stop('recovery_ticket_invalid');

  // 3. 그 사이에 카드가 다루는 영역이 달라졌는가
  let sameCoverage: boolean;
  try {
    sameCoverage = await matchesRecoveryCoverageSnapshot(
      state.activeCoveredHash,
      input.activeCoveredDomains,
    );
  } catch {
    return stop('recovery_coverage_changed');
  }
  if (!sameCoverage) return stop('recovery_coverage_changed');

  // 4. 무엇을 얼마나 더 확인해야 하는가
  const scoped = deriveRecoveryScope({
    discoveredUrls: state.discoveredUrls,
    primaryInspectedUrls: state.primaryInspectedUrls,
  });
  if (!scoped.ok) return stop('recovery_scope_invalid');
  const scope: RecoveryScope = scoped.scope;

  // 5. 의뢰서는 표의 값과 지금의 영역 목록으로 서버가 다시 만든다.
  //    영역 설명을 표에서 가져오거나 부르는 쪽에서 받지 않는다.
  let brief: SourceHarvestBrief;
  try {
    brief = buildSourceHarvestBrief({
      targetDomain: state.targetDomain,
      evidenceVersion: state.evidenceVersion,
      prioritizerSnapshotId: state.prioritizerSnapshotId,
      activeCoveredDomains: input.activeCoveredDomains,
    });
  } catch {
    return stop('recovery_ticket_invalid');
  }

  // 6. 모델 요청. 정확히 한 번.
  let response: unknown;
  try {
    response = await deps.callRecovery(
      buildRecoveryVerificationPayload({
        targetDomain: brief.targetDomain,
        domainDescription: brief.domainDescription,
        evidenceVersion: brief.evidenceVersion,
        prioritizerSnapshotId: brief.prioritizerSnapshotId,
        remainingUrls: scope.remainingUrls,
        requiredAdditionalInspections: scope.requiredAdditionalInspections,
      }),
    );
  } catch {
    return stop('recovery_request_failed');
  }

  // 7. 응답 읽기. 기존 helper의 사유를 이 단계의 사유로 옮긴다.
  const read = parseVerificationResponse(response);
  if (!read.ok) {
    if (read.reason === 'verification_incomplete') return stop('recovery_incomplete');
    if (read.reason === 'verification_refusal') return stop('recovery_refusal');
    return stop('recovery_response_invalid');
  }

  // 8. 초안 형식. 영역·근거 판본·판단 시점 id가 의뢰서와 다르면 여기서 걸린다.
  const checked = validateHarvestDraft(read.draft, brief);
  if (!checked.ok) return stop('recovery_response_invalid');

  // 9. 실제 도구 기록. 모델이 "확인했다"고 쓴 문장은 보지 않는다.
  const evidence = extractWebSearchEvidence(response);
  const recoveryToolDiagnostics = extractVerificationToolDiagnostics(response);
  const stopWithCounts = (reason: RecoveryRecheckReason): RecoveryOutcome => {
    log(reason);
    return { status: 'recheck', reason, recoveryToolDiagnostics };
  };

  // 10. 실제로 연 주소가 이번에 다룰 범위 안인가.
  //     밖의 주소를 조용히 빼고 나머지만 세지 않는다.
  const remaining = new Set(scope.remainingUrls);
  if (evidence.inspectedUrls.some((url) => !remaining.has(url))) {
    return stopWithCounts('recovery_url_out_of_scope');
  }

  // 11. 초안의 주소 범위·중복·충돌을 보고, 실제로 확인한 것만 남긴다.
  const authoritative = buildAuthoritativeRecoveryDraft({
    draft: checked.draft,
    remainingUrls: scope.remainingUrls,
    recoveryInspectedUrls: evidence.inspectedUrls,
  });
  if (!authoritative.ok) return stopWithCounts(authoritative.reason);

  // 12. 이번에 서로 다른 주소를 충분히 열어 봤는가. 개수 판단은 마지막이다.
  if (evidence.inspectedUrls.length < scope.requiredAdditionalInspections) {
    return stopWithCounts('insufficient_recovery_inspection');
  }

  // 13. 두 번을 합쳐 처음 목표를 채웠는가
  const combinedInspectedUrls = combineInspectedUrls({
    discoveredUrls: state.discoveredUrls,
    primaryInspectedUrls: state.primaryInspectedUrls,
    recoveryInspectedUrls: evidence.inspectedUrls,
  });
  if (combinedInspectedUrls.length < scope.originalInspectionTarget) {
    return stopWithCounts('recovery_contract_invalid');
  }

  // 14. 두 초안을 합친다
  const merged = mergePrimaryAndRecoveryDrafts({
    brief,
    primaryDraft: state.primaryDraft,
    recoveryDraft: authoritative.draft,
  });
  if (!merged.ok) return stopWithCounts(merged.reason);

  // 자료를 완성하지 않는다. sourceId도 확인 날짜도 여기서 만들지 않는다.
  log('ready_to_materialize');
  return {
    status: 'ready_to_materialize',
    brief,
    mergedDraft: merged.draft,
    combinedInspectedUrls,
    recoveryToolDiagnostics,
  };
}
