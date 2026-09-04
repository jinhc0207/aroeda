/**
 * Source Harvester 실행 본체 (순수 로직)
 *
 * 하는 일:
 *   1단계 응답에서 실제로 검색된 주소를 뽑고
 *   2단계 응답의 초안을 받아, 실제로 열어 본 주소인지 대조하고
 *   서버가 sourceId와 확인 날짜를 붙여 canonical 결과로 만든다.
 *
 * 하지 않는 일: 네트워크 호출, DB 접근, 재시도, 규칙 재작성.
 *
 * 규칙은 새로 쓰지 않는다.
 *   주소 정리·검증 → source-harvester.ts의 normalizeSourceUrl
 *   자료 id       → source-harvester.ts의 computeSourceId
 *   최종 판정      → source-harvester.ts의 validateSourceHarvestResult
 *
 * 원본 응답과 웹페이지 내용은 어디에도 남기지 않는다.
 * 모델이 "확인했다"고 말하는 것은 근거가 아니다. 실제 도구 사용 기록만 근거다.
 */

import { extractOutputText, hasRefusal } from './openai-response.ts';
import { isValidVerificationDraftSource } from './verification-draft-source.ts';
import { describeOpenAIHttpFailure, describeOpenAIStageFailure } from './openai-transport.ts';
import type { VerificationInvalidDiagnostic } from './verification-invalid-diagnostics.ts';
import {
  DISCOVERY_MAX_URLS,
  DISCOVERY_MIN_URLS,
  buildDiscoveryPayload,
  buildVerificationPayload,
  getVerificationInspectionTarget,
  type HarvestRecheckReason,
} from './source-harvester-execution-contract.ts';
import {
  computeSourceId,
  countPublisherDiversity,
  isScholarlyCoreType,
  normalizeSourceUrl,
  validateSourceHarvestResult,
  type HarvestEvidence,
  type HarvestedSource,
  type RejectedSource,
  type SourceHarvestBrief,
  type SourceHarvestResult,
} from './source-harvester.ts';
import {
  MODEL_REJECTION_REASONS,
  REJECTED_SOURCE_MAX,
  SERVER_ONLY_REJECTION_REASONS,
  VERIFICATION_DRAFT_REJECTED_FIELDS,
  type AccessLevel,
  type HarvestableSourceType,
  type HarvestEvidenceDraft,
  type IntendedUse,
  type VerificationDraftSource,
} from './source-harvest-contract.ts';
import {
  RECOVERY_TICKET_CREATE_DIAGNOSTIC_CODES,
  RECOVERY_TICKET_CREATE_HASH_FAILED,
  RECOVERY_TICKET_CREATE_INPUT_INVALID,
  RECOVERY_TICKET_CREATE_NOT_CONFIGURED,
  computeActiveCoveredHash,
  describeRecoveryTicketCreateFailure,
  isRecoveryId,
  validateHarvestRecoveryTicketInput,
  type HarvestPrimaryDraft,
  type HarvestRecoveryTicketInput,
} from './harvest-recovery-ticket.ts';

/**
 * 모델이 만들 수 있는 자료 초안. sourceId와 확인 날짜는 여기에 없다.
 * 정의는 source-harvest-contract.ts 한 곳에 있다. 이름만 여기서 이어 쓴다.
 */
export type VerifiedSourceDraft = VerificationDraftSource;

export type SourceHarvestDraftResult = {
  targetDomain: string;
  evidenceVersion: number;
  prioritizerSnapshotId: string;
  sources: VerifiedSourceDraft[];
  rejectedSources: RejectedSource[];
  unresolvedSourceQuestions: string[];
};

/** 응답에서 실제로 관찰된 주소들 */
export type WebSearchEvidence = {
  /** 검색 결과 목록에 나타난 주소 */
  searchSourceUrls: string[];
  /** 실제로 열어 보거나 본문을 찾아본 주소 */
  inspectedUrls: string[];
  /** 답변에 인용으로 붙은 주소 (참고용이며 채택 근거가 아니다) */
  citedUrls: string[];
  /** 정리하기 전 모습 그대로의 주소. 잘못된 주소를 기록으로 남길 때만 쓴다. */
  rawObservedUrls: string[];
};

/**
 * 실행 결과를 이해하기 위한 집계 숫자.
 *
 * 여기에는 숫자만 들어간다.
 * 주소, 제목, 저자, 발행처 이름, sourceId, 자료 메모, 웹 내용, 모델 응답은 들어가지 않는다.
 *
 * 판정에 쓰이는 값이 아니다. 무슨 일이 있었는지 보기 위한 것뿐이다.
 */
export type HarvestDiagnostics = {
  /** 모델이 채택하겠다고 제안한 자료 수 */
  proposedAcceptedCount: number;
  /** 그중 실제로 열어 본 기록이 있어 채택 후보로 남은 수 */
  inspectedAcceptedCount: number;
  /** 열어 본 기록이 없어 서버가 뺀 수 */
  demotedNotInspectedCount: number;

  /** 모델이 스스로 제외한 자료 수 */
  aiRejectedCount: number;
  /** 서버가 뺀 자료까지 합친 최종 제외 기록 수 (같은 주소는 한 번만) */
  finalRejectedCount: number;

  /** 뺀 뒤 남은 자료 중 학술적 핵심 자료 수 */
  scholarlyCoreCount: number;
  /** 뺀 뒤 남은 자료의 서로 다른 발행처 수 */
  publisherDiversityCount: number;
};

/**
 * 2단계에서 도구를 어디에 얼마나 썼는지 보기 위한 집계 숫자.
 *
 * 여기에도 숫자만 들어간다. 주소, 검색어, 제목, 원본 기록은 들어가지 않는다.
 * 모델이 "확인했다"고 쓴 문장이나 인용은 세지 않는다. 실제 도구 사용 기록만 센다.
 *
 * 판정에 쓰이는 값이 아니다. 18회라는 도구 예산이 어디에 쓰였는지 보기 위한 것뿐이다.
 */
export type VerificationToolDiagnostics = {
  /** 도구를 부른 총 횟수 */
  webSearchCallCount: number;
  /** 그중 검색에 쓴 횟수 */
  searchActionCount: number;
  /** 페이지를 연 횟수 */
  openPageActionCount: number;
  /** 페이지 안에서 내용을 찾아본 횟수 */
  findInPageActionCount: number;
  /** 위 셋 중 어느 것도 아닌 횟수 (기록이 없거나 모르는 종류) */
  unknownActionCount: number;
  /** 실제로 확인한 서로 다른 주소 수 */
  uniqueInspectedUrlCount: number;
};

export type HarvestOutcome =
  | {
      status: 'ready';
      result: SourceHarvestResult;
      diagnostics: HarvestDiagnostics;
      verificationToolDiagnostics?: VerificationToolDiagnostics;
    }
  /**
   * 확인 범위가 모자라 여기서 끝내되, 이어서 할 표를 만들어 둔 경우.
   *
   * 자료를 만들지 않았으므로 결과도, 집계 숫자도 없다.
   * 밖으로 나가는 것은 표 번호와 도구 사용 숫자 6개뿐이다.
   * 영역 이름, 주소, 초안, 지문은 나가지 않는다.
   */
  | {
      status: 'recovery_required';
      recoveryId: string;
      verificationToolDiagnostics: VerificationToolDiagnostics;
    }
  /** 자료를 만드는 단계까지 가지 못한 경우에는 집계 숫자가 없다. 억지로 만들지 않는다. */
  | {
      status: 'recheck';
      reason: HarvestRecheckReason;
      diagnostics?: HarvestDiagnostics;
      verificationToolDiagnostics?: VerificationToolDiagnostics;
    };

// 초안에서는 모델이 고를 수 있는 사유만 받는다. 서버 전용 사유는 여기서 거절된다.
const rejectionReasons = new Set<string>(MODEL_REJECTION_REASONS);

/* ------------------------------------------------------------------ */
/* 응답에서 실제 관찰 기록 뽑기                                          */
/* ------------------------------------------------------------------ */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** 순서를 유지하면서 정리된 주소만 모은다. 잘못된 주소와 중복은 버린다. */
function addUrl(url: unknown, into: string[], seen: Set<string>): void {
  const canonical = normalizeSourceUrl(url);
  if (canonical === null || seen.has(canonical)) return;
  seen.add(canonical);
  into.push(canonical);
}

/**
 * 응답에서 실제 도구 사용 기록을 뽑는다.
 *
 * 모델이 답변 문장에 적은 주소는 여기에 들어오지 않는다.
 * 주소의 근거는 오직 web_search_call 기록이다.
 */
export function extractWebSearchEvidence(response: unknown): WebSearchEvidence {
  const searchSourceUrls: string[] = [];
  const inspectedUrls: string[] = [];
  const citedUrls: string[] = [];
  const rawObservedUrls: string[] = [];

  const searchSeen = new Set<string>();
  const inspectedSeen = new Set<string>();
  const citedSeen = new Set<string>();
  const rawSeen = new Set<string>();

  const rememberRaw = (url: unknown) => {
    if (typeof url !== 'string' || url.trim().length === 0) return;
    const trimmed = url.trim();
    if (rawSeen.has(trimmed)) return;
    rawSeen.add(trimmed);
    rawObservedUrls.push(trimmed);
  };

  if (!isRecord(response) || !Array.isArray(response.output)) {
    return { searchSourceUrls, inspectedUrls, citedUrls, rawObservedUrls };
  }

  for (const item of response.output) {
    if (!isRecord(item)) continue;

    if (item.type === 'web_search_call') {
      const action = item.action;
      if (!isRecord(action)) continue;

      // 검색 결과 목록
      if (Array.isArray(action.sources)) {
        for (const source of action.sources) {
          const url = isRecord(source) ? source.url : undefined;
          rememberRaw(url);
          addUrl(url, searchSourceUrls, searchSeen);
        }
      }

      // 실제로 페이지를 연 기록
      if (action.type === 'open_page' || action.type === 'find_in_page') {
        rememberRaw(action.url);
        addUrl(action.url, inspectedUrls, inspectedSeen);
      }
      continue;
    }

    // 답변에 붙은 인용. 참고용으로만 모은다.
    if (Array.isArray(item.content)) {
      for (const part of item.content) {
        if (!isRecord(part) || !Array.isArray(part.annotations)) continue;
        for (const annotation of part.annotations) {
          if (!isRecord(annotation) || annotation.type !== 'url_citation') continue;
          addUrl(annotation.url, citedUrls, citedSeen);
        }
      }
    }
  }

  return { searchSourceUrls, inspectedUrls, citedUrls, rawObservedUrls };
}

/**
 * 2단계에서 도구를 어디에 썼는지 센다.
 *
 * 모델이 쓴 문장, 인용, sources 목록은 보지 않는다.
 * 응답 안의 web_search_call 기록과 그 action 종류만 본다.
 *
 * 이 함수는 주소나 검색어를 밖으로 내보내지 않는다. 숫자만 돌려준다.
 */
export function extractVerificationToolDiagnostics(response: unknown): VerificationToolDiagnostics {
  let webSearchCallCount = 0;
  let searchActionCount = 0;
  let openPageActionCount = 0;
  let findInPageActionCount = 0;
  let unknownActionCount = 0;

  if (isRecord(response) && Array.isArray(response.output)) {
    for (const item of response.output) {
      if (!isRecord(item) || item.type !== 'web_search_call') continue;

      webSearchCallCount += 1;

      const action = item.action;
      const type = isRecord(action) ? action.type : undefined;

      // 기록이 없거나 모르는 종류는 모두 unknown으로 센다.
      if (type === 'search') searchActionCount += 1;
      else if (type === 'open_page') openPageActionCount += 1;
      else if (type === 'find_in_page') findInPageActionCount += 1;
      else unknownActionCount += 1;
    }
  }

  // 실제로 확인한 주소 수는 기존 evidence helper가 센 것과 같은 기준을 쓴다.
  const uniqueInspectedUrlCount = extractWebSearchEvidence(response).inspectedUrls.length;

  return {
    webSearchCallCount,
    searchActionCount,
    openPageActionCount,
    findInPageActionCount,
    unknownActionCount,
    uniqueInspectedUrlCount,
  };
}

/**
 * 1단계에서 실제로 발견된 주소 목록을 만든다.
 *
 * 검색 결과에 나타난 주소를 먼저 두고, 그 뒤에 열어 본 주소를 둔다. 순서는 항상 같다.
 * 모델의 점수나 평가로 정렬하지 않는다.
 * 상한을 넘으면 이 순서 그대로 앞에서부터 상한까지만 쓰고, 잘렸다는 사실을 함께 돌려준다.
 */
export function collectDiscoveryUrls(
  response: unknown,
): { ok: true; urls: string[]; capped: boolean } | { ok: false; reason: HarvestRecheckReason } {
  if (!isRecord(response) || !Array.isArray(response.output)) {
    return { ok: false, reason: 'discovery_response_invalid' };
  }

  // 중간에 끊긴 응답은 절반만 쓰지 않는다. 2단계 응답과 같은 방식으로 다시 본다.
  // 끊긴 이유의 상세 내용은 남기지 않는다.
  if (response.status === 'incomplete' || response.incomplete_details) {
    return { ok: false, reason: 'discovery_incomplete' };
  }

  const evidence = extractWebSearchEvidence(response);

  const seen = new Set<string>();
  const urls: string[] = [];
  for (const url of [...evidence.searchSourceUrls, ...evidence.inspectedUrls]) {
    if (seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }

  if (urls.length < DISCOVERY_MIN_URLS) {
    return { ok: false, reason: 'insufficient_discovery_sources' };
  }

  const capped = urls.length > DISCOVERY_MAX_URLS;
  return { ok: true, urls: capped ? urls.slice(0, DISCOVERY_MAX_URLS) : urls, capped };
}

/* ------------------------------------------------------------------ */
/* 2단계 응답 읽기                                                      */
/* ------------------------------------------------------------------ */

/**
 * 밖으로 나가는 사유와 함께, 서버 기록에만 남길 큰 범주를 담는 실패 결과.
 *
 * diagnostic은 공개 응답에 넣지 않는다. 부르는 쪽이 기록에만 쓴다.
 * 끊김·거절처럼 이미 사유가 따로 있는 경우에는 붙이지 않는다.
 */
type VerificationInvalidFailure = {
  ok: false;
  reason: HarvestRecheckReason;
  diagnostic?: VerificationInvalidDiagnostic;
};

/**
 * 2단계 응답에서 초안을 읽는다.
 * 중간에 끊겼거나, 거절했거나, 답이 없거나, JSON이 아니면 쓰지 않는다.
 * 원본 응답은 남기지 않는다.
 */
export function parseVerificationResponse(
  response: unknown,
): { ok: true; draft: unknown } | VerificationInvalidFailure {
  const invalid = (diagnostic: VerificationInvalidDiagnostic): VerificationInvalidFailure => ({
    ok: false,
    reason: 'verification_response_invalid',
    diagnostic,
  });

  if (!isRecord(response)) return invalid('verification_invalid_response_shape');

  // 끊김과 거절은 이미 사유가 따로 있다. 새 범주를 붙이지 않는다.
  if (response.status === 'incomplete' || response.incomplete_details) {
    return { ok: false, reason: 'verification_incomplete' };
  }
  if (hasRefusal(response)) {
    return { ok: false, reason: 'verification_refusal' };
  }

  const text = extractOutputText(response);
  if (text === null) return invalid('verification_invalid_output_text');

  try {
    const parsed = JSON.parse(text);
    if (!isRecord(parsed)) return invalid('verification_invalid_json');
    return { ok: true, draft: parsed };
  } catch {
    return invalid('verification_invalid_json');
  }
}

/* ------------------------------------------------------------------ */
/* 초안 검사                                                            */
/* ------------------------------------------------------------------ */

const DRAFT_TOP_LEVEL_FIELDS = [
  'targetDomain',
  'evidenceVersion',
  'prioritizerSnapshotId',
  'sources',
  'rejectedSources',
  'unresolvedSourceQuestions',
] as const;

// 자료 한 건의 항목 목록은 verification-draft-source.ts가 본다. 여기서 다시 보지 않는다.
const DRAFT_REJECTED_FIELDS = VERIFICATION_DRAFT_REJECTED_FIELDS;

/**
 * 초안에 절대 있으면 안 되는 항목 이름.
 * sourceId와 확인 날짜는 서버가 만드는 값이므로 모델이 적으면 그 자체로 잘못이다.
 */
const BANNED_DRAFT_FIELDS = [
  'sourceid',
  'accessedat',
  // 근거 번호도 서버가 붙인다. 모델이 적으면 그 자체로 잘못이다.
  'evidenceid',
  'rawhtml',
  'html',
  'pagecontent',
  'content',
  'body',
  'snippet',
  'summary',
  'excerpt',
  'quote',
  'quotes',
  'quotation',
  'fulltext',
  'text',
  'usersituation',
  'situation',
  'userid',
  'user_id',
  'sessionid',
  'deviceid',
  'jwt',
  'token',
  'prioritizerreason',
  'prioritizerscore',
  'prioritizerconfidence',
  'reason',
  'score',
  'confidence',
  'rank',
];

function scanBannedFields(value: unknown, found: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((item) => scanBannedFields(item, found));
    return;
  }
  if (!isRecord(value)) return;

  for (const [key, child] of Object.entries(value)) {
    if (BANNED_DRAFT_FIELDS.includes(key.toLowerCase())) found.push(key);
    scanBannedFields(child, found);
  }
}

const isNonEmptyString = (value: unknown) => typeof value === 'string' && value.trim().length > 0;

/**
 * 초안의 모양을 확인한다.
 * 자료가 몇 개인지는 여기서 따지지 않는다. 그 판단은 마지막 canonical 검증이 한다.
 *
 * 판정 규칙과 검사 순서는 그대로다. 실패했을 때 서버 기록에 남길 큰 범주만 함께 돌려준다.
 *
 * 어느 범주로 묶는가:
 *   세 목록(sources·rejectedSources·unresolvedSourceQuestions)이 아예 배열이 아니면
 *   그것은 초안의 큰 틀 문제이므로 draft_shape로 본다.
 *   배열 안쪽 내용의 문제는 그 목록의 범주로 본다.
 */
export function validateHarvestDraft(
  draft: unknown,
  brief: SourceHarvestBrief,
): { ok: true; draft: SourceHarvestDraftResult } | VerificationInvalidFailure {
  const invalid = (diagnostic: VerificationInvalidDiagnostic): VerificationInvalidFailure => ({
    ok: false,
    reason: 'verification_response_invalid',
    diagnostic,
  });

  if (!isRecord(draft)) return invalid('verification_invalid_draft_shape');

  for (const key of Object.keys(draft)) {
    if (!(DRAFT_TOP_LEVEL_FIELDS as readonly string[]).includes(key)) {
      return invalid('verification_invalid_draft_shape');
    }
  }
  for (const key of DRAFT_TOP_LEVEL_FIELDS) {
    if (!(key in draft)) return invalid('verification_invalid_draft_shape');
  }

  const banned: string[] = [];
  scanBannedFields(draft, banned);
  // 어떤 이름이었는지는 남기지 않는다. 있었다는 사실만 범주로 남긴다.
  if (banned.length > 0) return invalid('verification_invalid_banned_field');

  if (
    draft.targetDomain !== brief.targetDomain ||
    draft.evidenceVersion !== brief.evidenceVersion ||
    draft.prioritizerSnapshotId !== brief.prioritizerSnapshotId
  ) {
    return invalid('verification_invalid_provenance');
  }

  if (!Array.isArray(draft.sources)) return invalid('verification_invalid_draft_shape');
  for (const entry of draft.sources) {
    // 자료 한 건의 규칙은 여기서 따로 적지 않는다.
    // 표에 담을 때 보는 것과 똑같은 규칙 하나를 본다.
    // 예전에는 이 자리가 더 느슨해서, 2단계는 통과했는데 표에는 담을 수 없는 초안이 나왔다.
    //
    // 어느 항목을 어떻게 어겼는지는 기록하지 않는다. 그것까지 남기면 자료 내용이 새어 나간다.
    if (!isValidVerificationDraftSource(entry)) return invalid('verification_invalid_source_metadata');
  }

  if (!Array.isArray(draft.rejectedSources)) return invalid('verification_invalid_draft_shape');
  if (draft.rejectedSources.length > REJECTED_SOURCE_MAX) {
    return invalid('verification_invalid_rejected_source');
  }
  for (const entry of draft.rejectedSources) {
    if (!isRecord(entry)) return invalid('verification_invalid_rejected_source');

    for (const key of Object.keys(entry)) {
      if (!(DRAFT_REJECTED_FIELDS as readonly string[]).includes(key)) {
        return invalid('verification_invalid_rejected_source');
      }
    }
    for (const key of DRAFT_REJECTED_FIELDS) {
      if (!(key in entry)) return invalid('verification_invalid_rejected_source');
    }

    if (!isNonEmptyString(entry.url)) return invalid('verification_invalid_rejected_source');
    if (entry.title !== null && !isNonEmptyString(entry.title)) {
      return invalid('verification_invalid_rejected_source');
    }
    if (typeof entry.rejectionReason !== 'string' || !rejectionReasons.has(entry.rejectionReason)) {
      return invalid('verification_invalid_rejected_source');
    }
  }

  if (!Array.isArray(draft.unresolvedSourceQuestions)) {
    return invalid('verification_invalid_draft_shape');
  }
  if (draft.unresolvedSourceQuestions.some((item) => typeof item !== 'string')) {
    return invalid('verification_invalid_unresolved_questions');
  }

  return { ok: true, draft: draft as unknown as SourceHarvestDraftResult };
}

/* ------------------------------------------------------------------ */
/* canonical 결과로 만들기                                              */
/* ------------------------------------------------------------------ */

/**
 * 초안을 실제 결과로 만든다.
 *
 * 채택 자료는 두 가지를 모두 만족해야 한다.
 *   1. 1단계에서 실제로 발견된 주소일 것
 *   2. 2단계에서 실제로 열어 본 주소일 것
 *
 * 두 경우를 다르게 다룬다.
 *
 *   1단계에 없던 주소를 모델이 만들어 냈다면 → 전체를 다시 본다.
 *     없는 주소를 지어낸 것이므로 그 응답 전체를 믿을 수 없다.
 *
 *   1단계에는 있었지만 열어 본 기록이 없다면 → 그 자료만 근거에서 뺀다.
 *     주소를 지어낸 것은 아니므로, 확인된 나머지 자료까지 함께 버릴 이유는 없다.
 *
 * 어느 쪽이든 열어 보지 않은 자료가 채택되는 일은 없다. 이 규칙은 그대로다.
 *
 * sourceId와 확인 날짜는 여기서 서버가 만든다. 모델이 준 값을 쓸 경로가 없다.
 */
/**
 * 근거 조각마다 서버가 번호를 붙인다.
 *
 * 번호는 그 자료의 id와 순서에서 만든다. 모델이 정할 수 없고, DB도 필요 없다.
 * 같은 순서로 다시 만들면 같은 번호가 나온다.
 *
 * 문장은 모델이 쓴 것을 그대로 둔다. 서버가 다시 쓰지 않는다.
 */
function materializeEvidenceClaims(
  sourceId: string,
  claims: readonly HarvestEvidenceDraft[],
): HarvestEvidence[] {
  return claims.map((claim, index) => ({
    evidenceId: `${sourceId}:e${index + 1}`,
    intendedUse: claim.intendedUse,
    statement: claim.statement,
    passageReferences: claim.passageReferences.map((reference) => ({ ...reference })),
  }));
}

export async function materializeHarvestResult(input: {
  brief: SourceHarvestBrief;
  draft: SourceHarvestDraftResult;
  discoveredUrls: readonly string[];
  evidence: WebSearchEvidence;
  now: () => Date;
  // 이 단계는 표를 만들지 않는다. 여기까지 왔다면 확인 범위는 이미 충분하다.
}): Promise<Exclude<HarvestOutcome, { status: 'recovery_required' }>> {
  const { brief, draft, discoveredUrls, evidence, now } = input;

  const discovered = new Set(discoveredUrls);
  const inspected = new Set(evidence.inspectedUrls);
  const rawObserved = new Set(evidence.rawObservedUrls);

  const accessedAt = now().toISOString().slice(0, 10);

  const sources: HarvestedSource[] = [];
  const acceptedUrls = new Set<string>();
  const seenCanonical = new Set<string>();
  /** 발견은 됐지만 열어 본 기록이 없어 근거에서 뺀 주소. 순서를 그대로 유지한다. */
  const demotedUrls: string[] = [];

  for (const entry of draft.sources) {
    const canonical = normalizeSourceUrl(entry.url);
    if (canonical === null) return { status: 'recheck', reason: 'verification_response_invalid' };

    // 1단계에 없던 주소는 지어낸 것이다. 전체를 다시 본다.
    if (!discovered.has(canonical)) return { status: 'recheck', reason: 'source_not_discovered' };

    if (seenCanonical.has(canonical)) {
      return { status: 'recheck', reason: 'verification_response_invalid' };
    }
    seenCanonical.add(canonical);

    // 열어 본 기록이 없으면 여기서 끝낸다.
    // sourceId도, 확인 날짜도 만들지 않는다. 확인한 자료가 아니기 때문이다.
    if (!inspected.has(canonical)) {
      demotedUrls.push(canonical);
      continue;
    }

    const sourceId = await computeSourceId(canonical);
    if (sourceId === null) return { status: 'recheck', reason: 'verification_response_invalid' };

    acceptedUrls.add(canonical);
    sources.push({
      sourceId,
      sourceType: entry.sourceType,
      title: entry.title,
      authorOrOrganization: entry.authorOrOrganization,
      publisherOrInstitution: entry.publisherOrInstitution,
      publicationYear: entry.publicationYear,
      url: canonical,
      accessedAt,
      accessLevel: entry.accessLevel,
      intendedUse: [...entry.intendedUse],
      relevanceNote: entry.relevanceNote,
      evidenceClaims: materializeEvidenceClaims(sourceId, entry.evidenceClaims),
    });
  }

  // 채택하지 않은 자료도 1단계에서 실제로 본 주소여야 한다.
  // 주소 자체가 잘못되어 정리할 수 없는 경우에만, 정리 전 모습 그대로 본 적이 있으면 기록을 남긴다.
  const rejectedSources: RejectedSource[] = [];
  const rejectedKeys = new Set<string>();

  for (const entry of draft.rejectedSources) {
    const canonical = normalizeSourceUrl(entry.url);

    if (canonical === null) {
      if (entry.rejectionReason !== 'invalid_url' || !rawObserved.has(entry.url.trim())) {
        return { status: 'recheck', reason: 'source_not_discovered' };
      }
    } else if (!discovered.has(canonical)) {
      return { status: 'recheck', reason: 'source_not_discovered' };
    }

    // 서버만 쓸 수 있는 사유를 모델이 적었다면 그 응답을 믿지 않는다.
    if ((SERVER_ONLY_REJECTION_REASONS as readonly string[]).includes(entry.rejectionReason)) {
      return { status: 'recheck', reason: 'verification_response_invalid' };
    }

    const key = canonical ?? entry.url.trim();
    if (rejectedKeys.has(key)) return { status: 'recheck', reason: 'verification_response_invalid' };
    // 같은 자료를 채택하면서 동시에 제외할 수는 없다.
    if (canonical !== null && acceptedUrls.has(canonical)) {
      return { status: 'recheck', reason: 'verification_response_invalid' };
    }
    rejectedKeys.add(key);

    rejectedSources.push({
      url: canonical ?? entry.url,
      title: entry.title,
      rejectionReason: entry.rejectionReason,
    });
  }

  // 열어 본 기록이 없어 뺀 자료를 기록으로 남긴다.
  // 모델이 이미 같은 주소를 제외 기록에 남겼다면 그 기록을 그대로 두고 여기서 더하지 않는다.
  // 제목은 null이다. 페이지를 열지 않았으므로 모델이 적은 제목을 믿을 근거가 없다.
  for (const canonical of demotedUrls) {
    if (rejectedKeys.has(canonical)) continue;
    rejectedKeys.add(canonical);
    rejectedSources.push({ url: canonical, title: null, rejectionReason: 'not_inspected' });
  }

  const result: SourceHarvestResult = {
    targetDomain: brief.targetDomain,
    evidenceVersion: brief.evidenceVersion,
    prioritizerSnapshotId: brief.prioritizerSnapshotId,
    sources,
    rejectedSources,
    unresolvedSourceQuestions: [...draft.unresolvedSourceQuestions],
  };

  // 무슨 일이 있었는지 보기 위한 숫자. 판정에는 쓰지 않는다.
  // 학술 핵심 자료와 발행처는 검증이 쓰는 것과 같은 helper로 센다.
  const diagnostics: HarvestDiagnostics = {
    proposedAcceptedCount: draft.sources.length,
    inspectedAcceptedCount: sources.length,
    demotedNotInspectedCount: demotedUrls.length,
    aiRejectedCount: draft.rejectedSources.length,
    finalRejectedCount: rejectedSources.length,
    scholarlyCoreCount: sources.filter((source) => isScholarlyCoreType(source.sourceType)).length,
    publisherDiversityCount: countPublisherDiversity(sources),
  };

  // 마지막 판정은 기존 canonical 검증이 한다. 여기서 규칙을 다시 적지 않는다.
  // 검증이 낸 오류 문구는 밖으로 내보내지 않는다. 자료 정보가 섞여 있을 수 있기 때문이다.
  const validation = await validateSourceHarvestResult(result, brief);
  if (!validation.valid) {
    return { status: 'recheck', reason: 'harvest_contract_invalid', diagnostics };
  }

  return { status: 'ready', result, diagnostics };
}

/* ------------------------------------------------------------------ */
/* 이어서 할 표에 담을 초안 만들기                                        */
/* ------------------------------------------------------------------ */

/**
 * 2단계 초안에서 **실제로 열어 본 주소에 대한 부분만** 남긴다.
 *
 * 왜 걸러내는가:
 *   열어 보지 않은 주소에 대해 모델이 미리 적어 둔 제목·저자·발행처를
 *   표에 담아 두면, 두 번째 요청이 그것을 그대로 승인해 버릴 수 있다.
 *   페이지를 보지 않고 쓴 자료 설명이 근거가 되는 길을 막는다.
 *
 * 여기서 하지 않는 일:
 *   sourceId·확인 날짜를 만들지 않는다. 자료를 완성하지 않는다.
 *   그 둘은 materializeHarvestResult만 만든다.
 *
 * 기존 안전장치는 그대로 지킨다.
 *   1단계에 없던 주소를 지어냈다면 표를 만들지 않고 끝낸다.
 *   같은 주소를 채택과 제외 양쪽에 넣었다면 표를 만들지 않고 끝낸다.
 *   확인 범위가 모자란 실행이라고 해서 이 규칙을 느슨하게 하지 않는다.
 */
export function buildAuthoritativePrimaryDraft(input: {
  draft: SourceHarvestDraftResult;
  discoveredUrls: readonly string[];
  primaryInspectedUrls: readonly string[];
}): { ok: true; draft: HarvestPrimaryDraft } | { ok: false; reason: HarvestRecheckReason } {
  const discovered = new Set(input.discoveredUrls);
  const inspected = new Set(input.primaryInspectedUrls);

  const sources: VerificationDraftSource[] = [];
  const seenCanonical = new Set<string>();

  for (const entry of input.draft.sources) {
    const canonical = normalizeSourceUrl(entry.url);
    if (canonical === null) return { ok: false, reason: 'verification_response_invalid' };

    // 1단계에 없던 주소는 지어낸 것이다. 표를 만들지 않는다.
    if (!discovered.has(canonical)) return { ok: false, reason: 'source_not_discovered' };

    if (seenCanonical.has(canonical)) {
      return { ok: false, reason: 'verification_response_invalid' };
    }
    seenCanonical.add(canonical);

    // 열어 본 기록이 없는 자료는 표에 담지 않는다. 지금 판정하지도 않는다.
    // 남은 주소를 마저 확인하는 두 번째 요청이 다시 볼 몫이다.
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

  const rejectedSources: HarvestPrimaryDraft['rejectedSources'] = [];
  const rejectedKeys = new Set<string>();

  for (const entry of input.draft.rejectedSources) {
    const canonical = normalizeSourceUrl(entry.url);

    // 주소 자체가 잘못된 기록(invalid_url 등)은 이어서 할 표에 담지 않는다.
    // 표는 최종 결과가 아니라 "어디까지 했는가"이고, 그 기록은 이어서 할 일이 없다.
    if (canonical === null) continue;

    if (!discovered.has(canonical)) return { ok: false, reason: 'source_not_discovered' };
    if (rejectedKeys.has(canonical)) return { ok: false, reason: 'verification_response_invalid' };
    // 같은 자료를 채택하면서 동시에 제외할 수는 없다.
    if (seenCanonical.has(canonical)) return { ok: false, reason: 'verification_response_invalid' };
    rejectedKeys.add(canonical);

    // 열어 보지 않은 주소의 제목과 제외 사유는 표에 남기지 않는다.
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
      // 모르는 것은 모델이 적은 그대로 옮긴다. 새로 만들거나 다시 묻지 않는다.
      unresolvedSourceQuestions: [...input.draft.unresolvedSourceQuestions],
    },
  };
}

/* ------------------------------------------------------------------ */
/* 전체 실행                                                            */
/* ------------------------------------------------------------------ */

export type HarvestDeps = {
  /** 1단계 요청. 정확히 한 번만 부른다. 실패하면 다시 부르지 않는다. */
  callDiscovery: (payload: Record<string, unknown>) => Promise<unknown>;
  /** 2단계 요청. 1단계가 실패하면 아예 부르지 않는다. */
  callVerification: (payload: Record<string, unknown>) => Promise<unknown>;
  /** 확인 날짜를 정할 때 쓰는 지금 시각 */
  now: () => Date;
  /**
   * 이어서 할 표를 하나 만들고 표 번호를 돌려준다. 최대 한 번만 부른다.
   *
   * 확인 범위가 모자랄 때만 부른다. 그 외의 경우에는 아예 부르지 않는다.
   * 실패하면 다시 부르지 않는다.
   *
   * 실제 DB 연결(주소, 서비스 역할 키, fetch)은 여기서 하지 않는다.
   * 이 파일은 무엇을 할지만 정하고, 어떻게 보낼지는 Edge Function 쪽에 둔다.
   * 없으면 표를 만들 수 없는 것으로 보고 그대로 끝낸다.
   */
  createRecoveryTicket?: (input: HarvestRecoveryTicketInput) => Promise<unknown>;
  /** 이유 코드만 남긴다. 주소, 원본 응답, 웹페이지 내용은 남기지 않는다. */
  log?: (reason: string) => void;
};

/**
 * 자료 수집 한 번을 실행한다.
 *
 * 모델 요청은 최대 두 번(1단계 1회, 2단계 1회)이다.
 * 실패해도 다시 부르지 않는다. 다시 보기(recheck)로 끝내고 판단은 사람에게 남긴다.
 */
export async function runSourceHarvest(
  brief: SourceHarvestBrief,
  deps: HarvestDeps,
): Promise<HarvestOutcome> {
  const log = deps.log ?? (() => {});
  const stop = (reason: HarvestRecheckReason): HarvestOutcome => {
    log(reason);
    return { status: 'recheck', reason };
  };

  let discoveryResponse: unknown;
  try {
    discoveryResponse = await deps.callDiscovery(
      buildDiscoveryPayload({
        targetDomain: brief.targetDomain,
        domainDescription: brief.domainDescription,
      }),
    );
  } catch (error) {
    // 밖으로 나가는 사유는 하나지만, 어느 까닭이었는지는 서버 기록에 남긴다.
    // 원본 오류 문구는 옮기지 않는다. 정해진 이름 하나만 고른다.
    //
    // 답이 받아들여지지 않은 경우에만 한 줄이 더 앞에 붙는다.
    // 좁은 것부터 넓은 것 순서로 남긴다.
    const http = describeOpenAIHttpFailure('discovery', error);
    if (http) log(http);
    log(describeOpenAIStageFailure('discovery', error));
    return stop('discovery_request_failed');
  }

  const discovered = collectDiscoveryUrls(discoveryResponse);
  if (!discovered.ok) return stop(discovered.reason);

  let verificationResponse: unknown;
  try {
    verificationResponse = await deps.callVerification(
      buildVerificationPayload({
        targetDomain: brief.targetDomain,
        domainDescription: brief.domainDescription,
        evidenceVersion: brief.evidenceVersion,
        prioritizerSnapshotId: brief.prioritizerSnapshotId,
        discoveredUrls: discovered.urls,
      }),
    );
  } catch (error) {
    const http = describeOpenAIHttpFailure('verification', error);
    if (http) log(http);
    log(describeOpenAIStageFailure('verification', error));
    return stop('verification_request_failed');
  }

  const parsed = parseVerificationResponse(verificationResponse);
  if (!parsed.ok) {
    // 밖으로 나가는 사유는 하나지만, 어느 큰 범주였는지는 서버 기록에 남긴다.
    // 원본 응답도, 항목 값도, 세부 위반 이름도 옮기지 않는다.
    if (parsed.diagnostic) log(parsed.diagnostic);
    return stop(parsed.reason);
  }

  const checked = validateHarvestDraft(parsed.draft, brief);
  if (!checked.ok) {
    if (checked.diagnostic) log(checked.diagnostic);
    return stop(checked.reason);
  }

  // 응답을 한 번만 읽어 두고 아래에서 다시 쓴다.
  const evidence = extractWebSearchEvidence(verificationResponse);
  const verificationToolDiagnostics = extractVerificationToolDiagnostics(verificationResponse);

  // 최종 답변을 쓰기 전에 서로 다른 주소를 충분히 열어 봤는지 확인한다.
  //
  // 모델이 "확인했다"고 쓴 문장은 보지 않는다. 실제로 페이지를 연 기록만 센다.
  // 부족하면 여기서 끝낸다. 자료를 만들지 않으므로 sourceId도, 확인 날짜도,
  // 뺀 자료 기록도 만들지 않는다. 다시 부르지도 않는다.
  //
  // 이 확인은 응답 형식 검사(끊김·거절·형식 오류) 뒤에 온다.
  // 형식 문제를 이 사유로 가리지 않기 위해서다.
  // 열어 본 주소가 모두 1단계에서 받은 주소인지 먼저 본다.
  //
  // 이 확인이 없으면, 받은 적 없는 주소를 몇 개 열어서 "충분히 확인했다"는 숫자를 채울 수 있다.
  // 받은 목록 5개 + 밖의 주소 3개를 열면 8개를 확인한 것처럼 보이게 된다.
  //
  // 밖의 주소를 조용히 빼고 나머지만 세지 않는다.
  // 정해 준 범위를 벗어난 것이므로 그 실행 전체를 다시 본다.
  const discoveredSet = new Set(discovered.urls);
  if (evidence.inspectedUrls.some((url) => !discoveredSet.has(url))) {
    return stop('source_not_discovered');
  }

  // 여기서부터 열어 본 주소는 모두 받은 목록 안에 있다.
  const inspectionTarget = getVerificationInspectionTarget(discovered.urls);
  if (evidence.inspectedUrls.length < inspectionTarget) {
    log('insufficient_verification_inspection');

    // 여기서부터는 결과를 버리지 않는다.
    // 지금까지 확인한 것만 표에 맡겨 두고, 남은 주소는 다음 요청이 마저 확인한다.
    const stopRecovery = (reason: HarvestRecheckReason): HarvestOutcome => {
      log(reason);
      return { status: 'recheck', reason, verificationToolDiagnostics };
    };

    // 표를 만들지 못한 까닭은 서버 기록에만 따로 남긴다.
    // 밖으로 나가는 사유는 어느 경우든 recovery_ticket_create_failed 하나뿐이다.
    const failedToCreate = (diagnosticCode: string): HarvestOutcome => {
      log(diagnosticCode);
      return stopRecovery('recovery_ticket_create_failed');
    };

    const authoritative = buildAuthoritativePrimaryDraft({
      draft: checked.draft,
      discoveredUrls: discovered.urls,
      primaryInspectedUrls: evidence.inspectedUrls,
    });
    if (!authoritative.ok) return stopRecovery(authoritative.reason);

    let activeCoveredHash: string;
    try {
      // 지문은 이 의뢰서를 만들 때 이미 검증된 활성 영역 목록에서만 계산한다.
      activeCoveredHash = await computeActiveCoveredHash(brief.activeCoveredDomains);
    } catch {
      // 원본 오류는 남기지 않는다. 어느 자리에서 멈췄는지만 남긴다.
      return failedToCreate(RECOVERY_TICKET_CREATE_HASH_FAILED);
    }

    const ticketInput: HarvestRecoveryTicketInput = {
      targetDomain: brief.targetDomain,
      evidenceVersion: brief.evidenceVersion,
      prioritizerSnapshotId: brief.prioritizerSnapshotId,
      activeCoveredHash,
      discoveredUrls: [...discovered.urls],
      primaryInspectedUrls: [...evidence.inspectedUrls],
      primaryDraft: authoritative.draft,
      primaryToolCounts: verificationToolDiagnostics,
    };

    // DB에 보내기 전에 확인한다. 보내고 나서 확인하지 않는다.
    if (!validateHarvestRecoveryTicketInput(ticketInput).valid) {
      return failedToCreate(RECOVERY_TICKET_CREATE_INPUT_INVALID);
    }

    if (!deps.createRecoveryTicket) {
      return failedToCreate(RECOVERY_TICKET_CREATE_NOT_CONFIGURED);
    }

    let recoveryId: unknown;
    try {
      // 정확히 한 번만 부른다. 실패해도 다시 부르지 않는다.
      recoveryId = await deps.createRecoveryTicket(ticketInput);
    } catch (error) {
      // 오류 안의 문구를 그대로 옮기지 않는다. 정해진 이름 하나만 고른다.
      return failedToCreate(describeRecoveryTicketCreateFailure(error));
    }
    if (!isRecoveryId(recoveryId)) {
      return failedToCreate(RECOVERY_TICKET_CREATE_DIAGNOSTIC_CODES.response_invalid);
    }

    // 표 번호는 로그에 남기지 않는다. 응답으로만 나간다.
    log('recovery_required');
    return { status: 'recovery_required', recoveryId, verificationToolDiagnostics };
  }

  const outcome = await materializeHarvestResult({
    brief,
    draft: checked.draft,
    discoveredUrls: discovered.urls,
    evidence,
    now: deps.now,
  });

  if (outcome.status === 'recheck') log(outcome.reason);

  // 집계 숫자가 만들어진 결과에만 도구 사용 숫자를 함께 붙인다.
  // 자료를 만드는 단계까지 가지 못한 결과에는 붙이지 않는다.
  if (!outcome.diagnostics) return outcome;

  return outcome.status === 'ready'
    ? { ...outcome, verificationToolDiagnostics }
    : { ...outcome, verificationToolDiagnostics };
}
