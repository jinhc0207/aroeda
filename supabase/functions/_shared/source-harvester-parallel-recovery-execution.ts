/**
 * 이어서 확인하기 · 주소 하나씩 나눠 확인하는 실행 본체 (순수 로직)
 *
 * 무엇이 달라지는가:
 *   지금까지는 한 번의 모델 요청에 남은 주소를 전부 주고 "서로 다른 N개를 열어라"라고 맡겼다.
 *   여기서는 주소 하나마다 요청 하나를 만들어 동시에 보내고,
 *   맡은 주소를 실제로 연 요청만 성공으로 센다.
 *   몇 개를 열지를 모델이 아니라 서버가 정한다.
 *
 * 규칙은 새로 쓰지 않는다:
 *   표 상태·앞선 결과 검사 → harvest-recovery-ticket.ts, source-harvester-recovery-execution.ts
 *   영역 지문·범위 계산     → source-harvester-recovery-contract.ts
 *   계획·요청서            → source-harvester-single-inspection-contract.ts
 *   응답 읽기·초안 검사·도구 기록 → source-harvester-execution.ts
 *   합치기·개수 상한        → source-harvester-recovery-execution.ts, source-harvest-contract.ts
 *
 * 누가 쓰는가:
 *   source-harvester의 두 번째 요청 처리(handler.ts)가 이 파일을 쓴다.
 *   이어서 확인하기의 병렬 진행은 여기서만 정한다.
 *   handler는 표에서 꺼낸 값과 지금의 영역 목록, 그리고 모델을 부르는 방법만 넘긴다.
 *
 * 이 파일이 하지 않는 일:
 *   DB 접근, 환경변수 읽기, 직접 fetch, 표 꺼내기,
 *   자료 완성(materializeHarvestResult, sourceId·확인 날짜 만들기).
 *   모델 요청은 주입받은 callInspection으로만 나간다.
 *
 * 지금 돌아가는 서버의 두 번째 요청이 이 길을 쓴다.
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
} from './source-harvester-execution.ts';
import { parseHarvestRecoveryTicketState } from './harvest-recovery-ticket.ts';
import {
  deriveRecoveryScope,
  matchesRecoveryCoverageSnapshot,
  type RecoveryRecheckReason,
} from './source-harvester-recovery-contract.ts';
import {
  combineInspectedUrls,
  mergePrimaryAndRecoveryDrafts,
  validateStoredPrimaryAuthority,
  type AuthoritativeRecoveryDraft,
} from './source-harvester-recovery-execution.ts';
import {
  SINGLE_INSPECTION_MAX_CONCURRENCY,
  SINGLE_INSPECTION_TIMEOUT_MS,
  buildSingleInspectionPayload,
  planSingleUrlRecoveryInspections,
  type SingleInspectionTask,
} from './source-harvester-single-inspection-contract.ts';

/* ------------------------------------------------------------------ */
/* 숫자로만 남기는 기록                                                  */
/* ------------------------------------------------------------------ */

/**
 * 이번 확인 묶음에서 무슨 일이 있었는지 보기 위한 숫자.
 *
 * 주소, 제목, 자료 정보, 원본 오류 문구는 여기에 들어가지 않는다.
 */
export type ParallelInspectionDiagnostics = {
  /** 계획한 확인 작업 수 (여유분 포함) */
  plannedTaskCount: number;
  /** 실제로 보낸 작업 수 */
  attemptedTaskCount: number;
  /** 맡은 주소를 실제로 열고 답까지 온전했던 작업 수 */
  successfulTaskCount: number;
  /** 그 밖의 작업 수 */
  failedTaskCount: number;
  /** 몇 번에 나누어 보냈는가 */
  wavesExecuted: number;

  /** 아래 여섯은 보낸 작업들의 도구 사용 기록을 합친 것이다. */
  webSearchCallCount: number;
  searchActionCount: number;
  openPageActionCount: number;
  findInPageActionCount: number;
  unknownActionCount: number;
  /**
   * 보낸 작업들의 응답에서 실제로 관찰된 서로 다른 주소 수.
   *
   * 성공한 작업 수와 같은 뜻이 아니다.
   * 맡은 주소가 아닌 곳을 연 실패 작업의 주소도 여기에는 들어간다.
   * 성공 판정에는 이 숫자를 쓰지 않는다.
   */
  uniqueInspectedUrlCount: number;
};

/** 확인에 성공한 작업 하나의 결과. 밖으로 나가는 값이 아니다. */
export type SuccessfulTaskResult = {
  taskIndex: number;
  targetUrl: string;
  draft: {
    sources: VerifiedSourceDraft[];
    rejectedSources: RejectedSource[];
    unresolvedSourceQuestions: string[];
  };
  toolDiagnostics: VerificationToolDiagnostics;
};

export type ParallelRecoveryOutcome =
  | {
      status: 'ready_to_materialize';
      brief: SourceHarvestBrief;
      mergedDraft: SourceHarvestDraftResult;
      combinedInspectedUrls: string[];
      parallelInspectionDiagnostics: ParallelInspectionDiagnostics;
    }
  | {
      status: 'recheck';
      reason: RecoveryRecheckReason;
      /** 모델을 부르기 전에 끝난 경우에는 없다. */
      parallelInspectionDiagnostics?: ParallelInspectionDiagnostics;
    };

export type ParallelRecoveryDeps = {
  /**
   * 확인 작업 하나를 보낸다. 작업마다 최대 한 번만 불린다.
   * 실패해도 그 작업만 실패하고 다시 부르지 않는다.
   */
  callInspection: (
    payload: Record<string, unknown>,
    options: { timeoutMs: number },
  ) => Promise<unknown>;
  /** 이유 코드만 남긴다. 주소, 원본 응답, 웹페이지 내용은 남기지 않는다. */
  log?: (reason: string) => void;
};

/* ------------------------------------------------------------------ */
/* 확인 작업 하나                                                        */
/* ------------------------------------------------------------------ */

type TaskAttempt = {
  /** 맡은 주소를 실제로 열고 답까지 온전했는가 */
  ok: boolean;
  result?: SuccessfulTaskResult;
  /** 응답이 왔다면 그 응답의 도구 사용 숫자 */
  toolDiagnostics?: VerificationToolDiagnostics;
  /** 응답에서 실제로 관찰된 주소들 (실패한 작업 것도 포함) */
  observedInspectedUrls: string[];
};

/**
 * 확인 작업 하나를 보내고, 그 답을 믿을 수 있는지 본다.
 *
 * 순서를 지킨다.
 *   응답 읽기 → 초안 형식 → 실제 도구 기록 → 맡은 주소를 열었는가
 *   → 다른 주소를 열지 않았는가 → 초안이 맡은 주소만 다루는가
 *
 * 맡은 주소를 열었더라도 답이 온전하지 않으면 실패로 본다.
 * 근거와 자료 설명을 함께 믿을 수 있는 작업만 성공으로 센다.
 */
async function attemptInspectionTask(
  task: SingleInspectionTask,
  brief: SourceHarvestBrief,
  deps: ParallelRecoveryDeps,
): Promise<TaskAttempt> {
  let response: unknown;
  try {
    response = await deps.callInspection(
      buildSingleInspectionPayload({ brief, targetUrl: task.targetUrl }),
      { timeoutMs: SINGLE_INSPECTION_TIMEOUT_MS },
    );
  } catch {
    // 요청 자체가 실패했다. 다시 부르지 않는다.
    return { ok: false, observedInspectedUrls: [] };
  }

  // 응답이 왔다면 그 기록은 남긴다. 답이 잘못됐더라도 무엇을 했는지는 셀 수 있다.
  const evidence = extractWebSearchEvidence(response);
  const toolDiagnostics = extractVerificationToolDiagnostics(response);
  const failed: TaskAttempt = {
    ok: false,
    toolDiagnostics,
    observedInspectedUrls: [...evidence.inspectedUrls],
  };

  const read = parseVerificationResponse(response);
  if (!read.ok) return failed;

  const checked = validateHarvestDraft(read.draft, brief);
  if (!checked.ok) return failed;

  // 맡은 주소를 실제로 열었는가. 모델이 쓴 문장은 보지 않는다.
  if (!evidence.inspectedUrls.includes(task.targetUrl)) return failed;

  // 맡지 않은 주소를 열었다면 그 작업 전체가 실패다.
  // 밖의 주소만 조용히 빼고 나머지를 성공으로 세지 않는다.
  if (evidence.inspectedUrls.some((url) => url !== task.targetUrl)) return failed;

  // 응답 구조로 주소를 묶어 두었지만 여기서 다시 본다.
  const sources: VerifiedSourceDraft[] = [];
  for (const entry of checked.draft.sources) {
    const canonical = normalizeSourceUrl(entry.url);
    if (canonical === null || canonical !== task.targetUrl) return failed;
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
  for (const entry of checked.draft.rejectedSources) {
    const canonical = normalizeSourceUrl(entry.url);
    if (canonical === null || canonical !== task.targetUrl) return failed;
    rejectedSources.push({
      url: canonical,
      title: entry.title,
      rejectionReason: entry.rejectionReason,
    });
  }

  // 한 작업은 주소 하나만 다룬다. 자료도 제외 기록도 많아야 하나씩이다.
  if (sources.length > 1 || rejectedSources.length > 1) return failed;
  // 같은 주소를 채택하면서 동시에 제외할 수는 없다.
  if (sources.length === 1 && rejectedSources.length === 1) return failed;

  return {
    ok: true,
    toolDiagnostics,
    observedInspectedUrls: [...evidence.inspectedUrls],
    result: {
      taskIndex: task.index,
      targetUrl: task.targetUrl,
      draft: {
        sources,
        rejectedSources,
        unresolvedSourceQuestions: [...checked.draft.unresolvedSourceQuestions],
      },
      toolDiagnostics,
    },
  };
}

/* ------------------------------------------------------------------ */
/* 성공한 작업들을 하나의 초안으로 모은다                                  */
/* ------------------------------------------------------------------ */

/**
 * 성공한 작업들의 자료 설명을 모아 하나의 초안으로 만든다.
 *
 * 순서는 끝난 순서가 아니라 작업 번호(받은 주소 순서)다.
 *
 * 개수 상한:
 *   첫 번째 요청에서 이미 담은 것과 합쳐 최종 상한을 넘을 수 없다.
 *   자리가 다 차면 그 뒤 작업의 자료 설명은 최종 초안에 넣지 않는다.
 *   다만 그 주소를 확인했다는 사실 자체는 지우지 않는다.
 *   확인하지 않은 것처럼 만들지도, 없는 제외 기록을 지어내지도 않는다.
 */
export function aggregateSuccessfulInspections(input: {
  successful: readonly SuccessfulTaskResult[];
  primarySourceCount: number;
  primaryRejectedCount: number;
}): { ok: true; draft: AuthoritativeRecoveryDraft } | { ok: false; reason: RecoveryRecheckReason } {
  const acceptedCapacity = ACCEPTED_MAX - input.primarySourceCount;
  const rejectedCapacity = REJECTED_SOURCE_MAX - input.primaryRejectedCount;

  if (acceptedCapacity < 0 || rejectedCapacity < 0) {
    return { ok: false, reason: 'recovery_contract_invalid' };
  }

  const ordered = [...input.successful].sort((a, b) => a.taskIndex - b.taskIndex);

  const sources: VerifiedSourceDraft[] = [];
  const rejectedSources: RejectedSource[] = [];
  const unresolvedSourceQuestions: string[] = [];

  for (const task of ordered) {
    for (const entry of task.draft.sources) {
      if (sources.length >= acceptedCapacity) break;
      sources.push(entry);
    }
    for (const entry of task.draft.rejectedSources) {
      if (rejectedSources.length >= rejectedCapacity) break;
      rejectedSources.push(entry);
    }
    // 모르는 것은 모델이 적은 그대로 옮긴다. 겹치는 문장도 임의로 지우지 않는다.
    unresolvedSourceQuestions.push(...task.draft.unresolvedSourceQuestions);
  }

  return { ok: true, draft: { sources, rejectedSources, unresolvedSourceQuestions } };
}

/* ------------------------------------------------------------------ */
/* 전체 실행                                                            */
/* ------------------------------------------------------------------ */

const emptyDiagnostics = (): ParallelInspectionDiagnostics => ({
  plannedTaskCount: 0,
  attemptedTaskCount: 0,
  successfulTaskCount: 0,
  failedTaskCount: 0,
  wavesExecuted: 0,
  webSearchCallCount: 0,
  searchActionCount: 0,
  openPageActionCount: 0,
  findInPageActionCount: 0,
  unknownActionCount: 0,
  uniqueInspectedUrlCount: 0,
});

/**
 * 이어서 확인하기 한 번을 실행한다. 주소 하나씩 나누어 동시에 확인한다.
 *
 * 모델을 부르기 전 검사는 기존과 같은 순서다.
 *   표 상태 → 표에 담긴 첫 번째 결과 → 영역 변화 → 범위 → 의뢰서
 *
 * 그다음 계획을 세우고, 동시에 보낼 수 있는 수만큼씩 나누어 보낸다.
 * 앞 묶음만으로 필요한 수를 채웠으면 뒤 묶음은 보내지 않는다.
 * 여유분은 다시 시도하는 것이 아니라 아직 열지 않은 다른 주소다.
 */
export async function runParallelSourceHarvestRecovery(
  input: {
    ticketState: unknown;
    activeCoveredDomains: readonly string[];
  },
  deps: ParallelRecoveryDeps,
): Promise<ParallelRecoveryOutcome> {
  const log = deps.log ?? (() => {});
  const stop = (reason: RecoveryRecheckReason): ParallelRecoveryOutcome => {
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
  const scope = scoped.scope;

  // 5. 의뢰서는 표의 값과 지금의 영역 목록으로 서버가 다시 만든다.
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

  // 6. 몇 개를 어떤 순서로 확인할지 정한다. 규칙은 계약 파일에 있다.
  const planned = planSingleUrlRecoveryInspections({
    remainingUrls: scope.remainingUrls,
    requiredAdditionalInspections: scope.requiredAdditionalInspections,
  });
  if (!planned.ok) return stop('recovery_scope_invalid');
  const plan = planned.plan;

  // 7. 동시에 보낼 수 있는 수만큼씩 나누어 보낸다.
  const diagnostics = emptyDiagnostics();
  diagnostics.plannedTaskCount = plan.tasks.length;

  const successful: SuccessfulTaskResult[] = [];
  const observedInspected = new Set<string>();

  for (let start = 0; start < plan.tasks.length; start += SINGLE_INSPECTION_MAX_CONCURRENCY) {
    // 앞 묶음만으로 필요한 수를 채웠으면 더 보내지 않는다.
    if (successful.length >= plan.requiredSuccessCount) break;

    const wave = plan.tasks.slice(start, start + SINGLE_INSPECTION_MAX_CONCURRENCY);
    diagnostics.wavesExecuted += 1;

    // 묶음 안의 요청은 동시에 나간다.
    // 하나가 실패해도 같은 묶음의 다른 결과를 잃지 않는다.
    const settled = await Promise.allSettled(
      wave.map((task) => attemptInspectionTask(task, brief, deps)),
    );

    for (const entry of settled) {
      diagnostics.attemptedTaskCount += 1;

      if (entry.status !== 'fulfilled') {
        diagnostics.failedTaskCount += 1;
        continue;
      }

      const attempt = entry.value;
      if (attempt.toolDiagnostics) {
        diagnostics.webSearchCallCount += attempt.toolDiagnostics.webSearchCallCount;
        diagnostics.searchActionCount += attempt.toolDiagnostics.searchActionCount;
        diagnostics.openPageActionCount += attempt.toolDiagnostics.openPageActionCount;
        diagnostics.findInPageActionCount += attempt.toolDiagnostics.findInPageActionCount;
        diagnostics.unknownActionCount += attempt.toolDiagnostics.unknownActionCount;
      }
      for (const url of attempt.observedInspectedUrls) observedInspected.add(url);

      if (attempt.ok && attempt.result) {
        diagnostics.successfulTaskCount += 1;
        successful.push(attempt.result);
      } else {
        diagnostics.failedTaskCount += 1;
      }
    }
  }

  diagnostics.uniqueInspectedUrlCount = observedInspected.size;

  const stopWithCounts = (reason: RecoveryRecheckReason): ParallelRecoveryOutcome => {
    log(reason);
    return { status: 'recheck', reason, parallelInspectionDiagnostics: diagnostics };
  };

  // 8. 서로 다른 주소를 충분히 확인했는가.
  //    판단에 쓰는 것은 성공한 작업 수다. 관찰된 주소 수가 아니다.
  if (successful.length < plan.requiredSuccessCount) {
    return stopWithCounts('insufficient_recovery_inspection');
  }

  // 9. 성공한 작업의 자료 설명을 모은다. 순서는 작업 번호다.
  const aggregated = aggregateSuccessfulInspections({
    successful,
    primarySourceCount: state.primaryDraft.sources.length,
    primaryRejectedCount: state.primaryDraft.rejectedSources.length,
  });
  if (!aggregated.ok) return stopWithCounts(aggregated.reason);

  // 10. 두 번을 합쳐 처음 목표를 채웠는가.
  //     필요한 수를 넘겨 성공한 확인도 실제로 확인한 것이므로 모두 넣는다.
  const orderedTargets = [...successful]
    .sort((a, b) => a.taskIndex - b.taskIndex)
    .map((task) => task.targetUrl);

  const combinedInspectedUrls = combineInspectedUrls({
    discoveredUrls: state.discoveredUrls,
    primaryInspectedUrls: state.primaryInspectedUrls,
    recoveryInspectedUrls: orderedTargets,
  });
  if (combinedInspectedUrls.length < scope.originalInspectionTarget) {
    return stopWithCounts('recovery_contract_invalid');
  }

  // 11. 두 초안을 합친다. 합치는 규칙은 기존 helper 하나만 쓴다.
  const merged = mergePrimaryAndRecoveryDrafts({
    brief,
    primaryDraft: state.primaryDraft,
    recoveryDraft: aggregated.draft,
  });
  if (!merged.ok) return stopWithCounts(merged.reason);

  // 자료를 완성하지 않는다. sourceId도 확인 날짜도 여기서 만들지 않는다.
  log('ready_to_materialize');
  return {
    status: 'ready_to_materialize',
    brief,
    mergedDraft: merged.draft,
    combinedInspectedUrls,
    parallelInspectionDiagnostics: diagnostics,
  };
}
