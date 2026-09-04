/**
 * Recovery Ticket 저장소 계약 (순수 로직)
 *
 * 무엇을 위한 것인가:
 *   2단계(Verification)가 받은 주소를 충분히 열어 보지 못하고 끝났을 때,
 *   그때까지의 결과를 잠깐 맡겼다가 "남은 주소만 마저 확인하는" 두 번째 요청에서 꺼내 쓴다.
 *
 * 이 파일이 하는 일: 표에 담을 값이 규칙에 맞는지 확인하고, 꺼낸 값을 다시 확인한다.
 * 하지 않는 일: DB 접근, 네트워크, 환경변수 읽기, 실제 Recovery 실행.
 *
 * 누가 쓰는가:
 *   처음 시작하는 요청은 확인 범위가 모자라면 이 검사를 거쳐 표를 만든다.
 *   이어서 확인하는 요청은 그 표를 한 번에 꺼내(consume) 남은 주소를 마저 확인한다.
 *   두 경우 모두 실제 DB 연결(주소, 서비스 역할 키, fetch)은
 *   여기가 아니라 Edge Function 쪽에 있다. 이 파일은 값의 모양만 본다.
 *
 * 수명: 표는 30분 뒤 만료되고, 한 번 쓰이면 그 줄이 DB에서 사라진다.
 * 그래서 상태 값(pending/처리중/완료)이 없다. 줄이 있으면 아직 안 쓴 것이다.
 *
 * 목록은 여기서 다시 적지 않는다:
 *   연구 대상 영역, 자료 종류, 확인 수준, 용도, 제외 사유는 모두 기존 계약 파일에서 가져온다.
 *   주소를 정리하는 규칙도 기존 normalizeSourceUrl 하나만 쓴다.
 */

import { normalizeSourceUrl } from './source-harvester.ts';
import type { RejectedSource } from './source-harvester.ts';
import {
  ACCEPTED_MAX,
  MODEL_REJECTION_REASONS,
  REJECTED_SOURCE_MAX,
  RESEARCHABLE_DOMAINS,
  VERIFICATION_DRAFT_REJECTED_FIELDS,
  type VerificationDraftSource,
} from './source-harvest-contract.ts';
import { checkVerificationDraftSource } from './verification-draft-source.ts';

/** 표의 수명. 서버가 정하며 부르는 쪽이 바꿀 수 없다. (DB 함수의 값과 같아야 한다) */
export const RECOVERY_TICKET_TTL_MINUTES = 30;

/** 우선순위 판단 시점 id의 모양 */
const SNAPSHOT_ID = /^snap_[0-9a-f]{64}$/;

/** SHA-256 지문의 모양 */
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** 표 id의 모양 */
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** 도구를 어디에 몇 번 썼는지. 숫자 6개뿐이다. (VerificationToolDiagnostics와 같은 모양) */
export const TICKET_TOOL_COUNT_FIELDS = [
  'webSearchCallCount',
  'searchActionCount',
  'openPageActionCount',
  'findInPageActionCount',
  'unknownActionCount',
  'uniqueInspectedUrlCount',
] as const;

export type TicketToolCounts = {
  webSearchCallCount: number;
  searchActionCount: number;
  openPageActionCount: number;
  findInPageActionCount: number;
  unknownActionCount: number;
  uniqueInspectedUrlCount: number;
};

/**
 * 표에 담는 초안.
 *
 * 무엇을 담는가:
 *   2단계가 쓴 **가공 전 초안(raw draft)** 중 실제로 열어 본 주소에 해당하는 부분만 담는다.
 *   서버가 만든 최종 결과(HarvestedSource/ResearchSource)를 담는 것이 아니다.
 *   그래서 sourceId와 accessedAt은 여기에 없다.
 *   그 둘은 실제로 열어 본 주소에 대해서만 materializeHarvestResult가 붙이는 값이다.
 *   확인 범위가 모자라 멈춘 실행에서는 그 단계에 도달하지 못했으므로 만들어진 적도 없다.
 *
 * 최종 수집 결과와 달리 targetDomain·evidenceVersion·prioritizerSnapshotId도 담지 않는다.
 * 그 세 값은 표의 칸으로 따로 있으므로, 초안 안에 또 두면
 * 두 번째 요청이 그중 하나만 바꿔치기할 자리가 생긴다.
 *
 * 아직 완성된 결과가 아니므로 채택 자료 최소 개수(5개)는 요구하지 않는다.
 * 상한만 지킨다.
 */
export type HarvestPrimaryDraft = {
  sources: VerificationDraftSource[];
  /** 모델이 직접 남긴 기록만 담긴다. 서버 전용 사유(not_inspected)는 아직 붙지 않았다. */
  rejectedSources: RejectedSource[];
  unresolvedSourceQuestions: string[];
};

/**
 * 표에 담을 값.
 *
 * primaryDraft에 대한 약속:
 *   2단계가 **실제로 열어 본 주소**에 대해서만 쓴 초안만 들어온다.
 *   열어 보지 않은 주소를 두고 미리 적어 둔 자료 설명은 표에 담지 않는다.
 *   페이지를 보지 않고 쓴 제목·저자·발행처를 나중에 승인하는 일이 없도록 하기 위해서다.
 *
 *   이 걸러내는 일(실제로 열어 본 주소만 남기기)은 나중에 1단계 요청 쪽에서 한다.
 *   여기서는 초안의 "구조"가 그 약속에 맞는지만 본다.
 *   초안의 주소와 실제 열어 본 기록을 대조하는 일은 아직 하지 않는다.
 */
export type HarvestRecoveryTicketInput = {
  targetDomain: string;
  evidenceVersion: number;
  prioritizerSnapshotId: string;
  /** 표를 만들 때 카드가 다루던 영역 목록의 SHA-256 */
  activeCoveredHash: string;
  /** 1단계에서 실제로 발견된 주소 (정리된 모양, 순서 보존) */
  discoveredUrls: string[];
  /** 그중 2단계가 실제로 열어 본 주소 */
  primaryInspectedUrls: string[];
  /** 실제로 열어 본 주소에 대해서만 쓴 초안 */
  primaryDraft: HarvestPrimaryDraft;
  primaryToolCounts: TicketToolCounts;
};

/** 표에서 꺼낸 값. 담을 때와 같은 모양이다. */
export type HarvestRecoveryTicketState = HarvestRecoveryTicketInput;

export type TicketValidation = { valid: boolean; errors: string[] };

const INPUT_FIELDS = [
  'targetDomain',
  'evidenceVersion',
  'prioritizerSnapshotId',
  'activeCoveredHash',
  'discoveredUrls',
  'primaryInspectedUrls',
  'primaryDraft',
  'primaryToolCounts',
] as const;

/**
 * DB 칸 이름과 앱 안에서 쓰는 이름의 대응표.
 *
 * 이름을 바꾸는 곳은 이 한 곳뿐이다. 다른 데서 또 바꾸지 않는다.
 * 순서는 INPUT_FIELDS와 같다.
 */
export const TICKET_ROW_COLUMNS = {
  target_domain: 'targetDomain',
  evidence_version: 'evidenceVersion',
  prioritizer_snapshot_id: 'prioritizerSnapshotId',
  active_covered_hash: 'activeCoveredHash',
  discovered_urls: 'discoveredUrls',
  primary_inspected_urls: 'primaryInspectedUrls',
  primary_draft: 'primaryDraft',
  primary_tool_counts: 'primaryToolCounts',
} as const;

const ROW_FIELDS = Object.keys(TICKET_ROW_COLUMNS) as (keyof typeof TICKET_ROW_COLUMNS)[];

/**
 * 표에 절대 담을 수 없는 항목 이름 (어느 깊이에 있든).
 *
 * 앞쪽은 웹페이지 내용·인용문을 저장하려는 시도,
 * 뒤쪽은 사용자 정보와 Prioritizer의 판단 근거가 흘러드는 것을 막는다.
 *
 * 기존 Source Harvester 결과의 금지 목록과 같은 뜻을 갖도록 맞춰 둔다.
 * (그 목록은 내보내지 않는 값이라 여기서 다시 적되, 빠진 이름이 없는지는 테스트로 지킨다.)
 */
const BANNED_TICKET_FIELDS = [
  // 서버만 만드는 값. 실제로 열어 본 주소에 대해서만 materialization이 붙인다.
  // 가공 전 초안에 있으면 그 자체로 잘못이다.
  'sourceid',
  'accessedat',
  'evidenceid',
  // 웹페이지 내용·인용문
  'rawhtml',
  'html',
  'pagecontent',
  'webpagecontent',
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
  // 모델 원본 응답
  'rawresponse',
  // 다음 단계의 결과물
  'scripture',
  'prayer',
  'prayertext',
  'card',
  // 사용자 정보
  'situation',
  'rawsituation',
  'usersituation',
  'userid',
  'user_id',
  'uid',
  'sessionid',
  'deviceid',
  'ip',
  'jwt',
  'token',
  'apikey',
  'api_key',
  'emotiontags',
  // Prioritizer의 판단 근거
  'prioritizerreason',
  'prioritizerscore',
  'prioritizerconfidence',
  'reason',
  'score',
  'confidence',
  'rank',
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isSafeCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const researchableDomains = new Set<string>(RESEARCHABLE_DOMAINS);
// 가공 전 초안이므로 모델이 고를 수 있는 사유만 쓸 수 있다.
// 서버 전용 사유(not_inspected)는 materialization 단계에서 붙는다. 실행 본체와 같은 규칙이다.
const rejectionReasons = new Set<string>(MODEL_REJECTION_REASONS);

/** 초안의 최상위 항목. 딱 이 셋뿐이다. */
const DRAFT_FIELDS = ['sources', 'rejectedSources', 'unresolvedSourceQuestions'] as const;

/** 제외 기록 한 건의 항목 */
const DRAFT_REJECTED_FIELDS = VERIFICATION_DRAFT_REJECTED_FIELDS;

/** 표 id가 UUID 모양인가. */
export function isRecoveryId(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

/* ------------------------------------------------------------------ */
/* 표를 만들지 못한 까닭                                                 */
/* ------------------------------------------------------------------ */

/**
 * 표를 만들지 못한 까닭의 종류.
 *
 * 왜 나누는가:
 *   밖으로 나가는 사유는 "표를 만들지 못했다" 하나뿐이다. 그건 그대로 둔다.
 *   하지만 서버 안에서까지 하나로 뭉쳐 두면, 실제로 무슨 일이 있었는지 알 길이 없다.
 *   production에서 이 실패가 났을 때 설정 문제인지, 시간이 넘은 것인지,
 *   DB가 거절한 것인지, 답을 못 읽은 것인지 구분하지 못했다.
 *
 * 여기에는 고정된 이름만 들어간다.
 * 주소, 서비스 역할 키, 표 번호, 영역 이름, 응답 본문, 원본 오류 문구는 담지 않는다.
 */
export const RECOVERY_TICKET_RPC_FAILURE_KINDS = [
  /** DB 주소나 서버 자격이 없다 */
  'config_missing',
  /** 정해진 시간 안에 답이 오지 않았다 */
  'timeout',
  /** 답은 왔지만 DB가 받아들이지 않았다 */
  'http_error',
  /** 답을 읽을 수 없거나, 읽었지만 쓸 수 없는 값이었다 */
  'response_invalid',
  /** 위 어디에도 확실히 들어가지 않는다 */
  'unknown',
] as const;
export type RecoveryTicketRpcFailureKind = (typeof RECOVERY_TICKET_RPC_FAILURE_KINDS)[number];

/**
 * 표를 다루는 DB 함수가 실패했을 때 던지는 오류.
 *
 * 메시지에는 종류 이름만 담는다.
 * 원본 오류 문구나 응답 본문을 옮겨 담지 않는다. 그 안에 무엇이 들어 있을지 모르기 때문이다.
 */
export class RecoveryTicketRpcError extends Error {
  readonly kind: RecoveryTicketRpcFailureKind;

  constructor(kind: RecoveryTicketRpcFailureKind) {
    super(kind);
    this.name = 'RecoveryTicketRpcError';
    this.kind = kind;
  }
}

/** 서버 기록에만 남기는 이름. 밖으로 나가는 사유와 다르다. */
export const RECOVERY_TICKET_CREATE_DIAGNOSTIC_CODES = {
  config_missing: 'recovery_ticket_create_config_missing',
  timeout: 'recovery_ticket_create_timeout',
  http_error: 'recovery_ticket_create_http_error',
  response_invalid: 'recovery_ticket_create_response_invalid',
  unknown: 'recovery_ticket_create_unknown_failure',
} as const;

/** 표를 만들 준비조차 되지 않은 세 경우. RPC까지 가지도 못한다. */
export const RECOVERY_TICKET_CREATE_INPUT_INVALID = 'recovery_ticket_create_input_invalid';
export const RECOVERY_TICKET_CREATE_NOT_CONFIGURED = 'recovery_ticket_create_not_configured';
/** 영역 목록의 지문을 만들지 못했다 */
export const RECOVERY_TICKET_CREATE_HASH_FAILED = 'recovery_ticket_create_hash_failed';

/**
 * DB 함수를 부르다 실패했을 때 어느 종류인지 가린다.
 *
 * stage는 어디까지 갔는지다.
 *   request — 요청을 보내다 실패했다 (답 자체를 못 받음)
 *   body    — 답은 받았지만 그 내용을 읽다 실패했다
 *
 * aborted는 **우리가 건 시간 제한**이 실제로 끊었는지다.
 * 그 경우에만 시간 초과로 본다. 확실하지 않은 것은 추측하지 않는다.
 *
 * 답을 읽는 도중에 시간이 넘을 수도 있다.
 * 그때를 "읽을 수 없는 답"으로 적으면 원인을 잘못 짚게 된다.
 */
export function classifyRecoveryTicketRpcFailure(
  stage: 'request' | 'body',
  aborted: boolean,
): RecoveryTicketRpcFailureKind {
  if (aborted) return 'timeout';
  return stage === 'body' ? 'response_invalid' : 'unknown';
}

/**
 * 표를 만들지 못한 오류에서 서버 기록에 남길 이름을 고른다.
 *
 * 어떤 값이 오더라도 정해진 이름 중 하나만 돌려준다.
 * 오류 안에 들어 있던 문구를 그대로 내보내지 않는다.
 */
export function describeRecoveryTicketCreateFailure(error: unknown): string {
  const kind =
    error instanceof RecoveryTicketRpcError
      ? error.kind
      : ((): RecoveryTicketRpcFailureKind => 'unknown')();

  return RECOVERY_TICKET_CREATE_DIAGNOSTIC_CODES[kind];
}

/**
 * 카드가 다루고 있는 영역 목록의 지문을 만든다.
 *
 * 왜 목록을 그대로 담지 않는가:
 *   두 번째 요청 때 그 사이에 새 카드가 생겼는지만 알면 된다.
 *   목록 자체는 표에 담을 이유가 없다.
 *
 * 같은 영역들이면 순서가 달라도, 같은 이름이 두 번 들어 있어도 같은 지문이 나온다.
 * 영역 하나만 달라져도 다른 지문이 나온다.
 *
 * 입력은 이미 검증된 활성 영역 목록(의뢰서의 activeCoveredDomains)이다.
 * 사용자 문장이나 사용자 정보는 이 계산에 들어오지 않는다.
 */
export async function computeActiveCoveredHash(domains: readonly string[]): Promise<string> {
  const unique = [...new Set(domains)].sort();
  const canonical = `v1|covered:${unique.join(',')}`;

  const bytes = new TextEncoder().encode(canonical);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);

  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** 어느 깊이에 있든 담으면 안 되는 이름이 있으면 잡아낸다. */
function scanBannedFields(value: unknown, errors: string[], path = ''): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanBannedFields(item, errors, `${path}[${index}]`));
    return;
  }
  if (!isRecord(value)) return;

  for (const [key, child] of Object.entries(value)) {
    if (BANNED_TICKET_FIELDS.includes(key.toLowerCase())) {
      errors.push(`표에 담을 수 없는 항목이 있습니다: ${path}${path ? '.' : ''}${key}`);
    }
    scanBannedFields(child, errors, `${path}${path ? '.' : ''}${key}`);
  }
}

/**
 * 주소 목록을 확인한다.
 * 주소를 정리하는 규칙은 새로 만들지 않고 기존 normalizeSourceUrl을 그대로 쓴다.
 * 이미 정리된 모양이어야 하고, 중복이 없어야 하며, 순서는 그대로 둔다.
 */
function checkUrlList(value: unknown, label: string, errors: string[]): string[] | null {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    errors.push(`${label}: 문자열 목록이 아닙니다.`);
    return null;
  }

  const list = value as string[];
  const seen = new Set<string>();
  let ok = true;

  for (const [index, url] of list.entries()) {
    const canonical = normalizeSourceUrl(url);
    if (canonical === null) {
      errors.push(`${label}[${index}]: 받을 수 없는 주소입니다.`);
      ok = false;
      continue;
    }
    if (canonical !== url) {
      errors.push(`${label}[${index}]: 정리된 모양이 아닙니다.`);
      ok = false;
      continue;
    }
    if (seen.has(url)) {
      errors.push(`${label}[${index}]: 같은 주소가 두 번 있습니다.`);
      ok = false;
      continue;
    }
    seen.add(url);
  }

  return ok ? list : null;
}

/** 도구 사용 숫자를 확인한다. 정확히 6개, 전부 0 이상의 정수. */
function checkToolCounts(
  value: unknown,
  inspectedCount: number | null,
  errors: string[],
): void {
  if (!isRecord(value)) {
    errors.push('primaryToolCounts가 객체가 아닙니다.');
    return;
  }

  for (const key of Object.keys(value)) {
    if (!(TICKET_TOOL_COUNT_FIELDS as readonly string[]).includes(key)) {
      errors.push(`primaryToolCounts에 허용되지 않는 항목이 있습니다 (${key})`);
    }
  }

  let complete = true;
  for (const key of TICKET_TOOL_COUNT_FIELDS) {
    if (!isSafeCount(value[key])) {
      errors.push(`primaryToolCounts.${key}가 0 이상의 정수가 아닙니다.`);
      complete = false;
    }
  }
  if (!complete) return;

  const counts = value as unknown as TicketToolCounts;
  const sum =
    counts.searchActionCount +
    counts.openPageActionCount +
    counts.findInPageActionCount +
    counts.unknownActionCount;

  if (counts.webSearchCallCount !== sum) {
    errors.push('primaryToolCounts: 총 도구 사용 횟수가 종류별 합과 다릅니다.');
  }

  // 실제로 열어 본 주소 수와 기록이 어긋나면 둘 중 하나가 잘못된 것이다.
  if (inspectedCount !== null && counts.uniqueInspectedUrlCount !== inspectedCount) {
    errors.push('primaryToolCounts: 확인한 주소 수가 주소 목록의 길이와 다릅니다.');
  }
}

/**
 * 초안에 담긴 자료 한 건을 확인한다.
 *
 * 가공 전 초안이므로 sourceId와 accessedAt은 없어야 한다.
 * 없는지 확인하는 일은 금지 항목 검사가 맡는다. 여기서는 만들지도, 요구하지도 않는다.
 *
 * 허용 목록은 모두 기존 계약에서 가져온 것이다.
 */
function checkDraftSource(
  entry: unknown,
  label: string,
  seenUrls: Set<string>,
  errors: string[],
): void {
  if (!isRecord(entry)) {
    errors.push(`${label}: 객체가 아닙니다.`);
    return;
  }

  // 자료 한 건의 규칙은 여기서 따로 적지 않는다.
  // 2단계 응답을 볼 때와 똑같은 규칙 하나를 본다.
  // 까닭은 고정된 이름뿐이라 자료 내용이 새지 않는다.
  for (const issue of checkVerificationDraftSource(entry)) {
    errors.push(`${label}: ${issue}`);
  }

  // 여러 자료 사이의 규칙은 여기서 본다. 같은 주소가 두 번 들어올 수는 없다.
  const canonical = normalizeSourceUrl(entry.url);
  if (canonical !== null) {
    if (seenUrls.has(canonical)) errors.push(`${label}: 같은 자료가 두 번 들어 있습니다.`);
    seenUrls.add(canonical);
  }
}

/** 초안에 담긴 제외 기록 한 건을 확인한다. */
function checkDraftRejected(entry: unknown, label: string, errors: string[]): void {
  if (!isRecord(entry)) {
    errors.push(`${label}: 객체가 아닙니다.`);
    return;
  }

  for (const key of Object.keys(entry)) {
    if (!(DRAFT_REJECTED_FIELDS as readonly string[]).includes(key)) {
      errors.push(`${label}: 허용되지 않는 항목이 있습니다 (${key})`);
    }
  }
  for (const key of DRAFT_REJECTED_FIELDS) {
    if (!(key in entry)) errors.push(`${label}: 필수 항목이 없습니다 (${key})`);
  }

  // 왜 걸렀는지 남기는 기록이므로 주소 자체는 잘못된 것이어도 된다.
  if (!isNonEmptyString(entry.url)) errors.push(`${label}: url이 비어 있습니다.`);
  if (entry.title !== null && !isNonEmptyString(entry.title)) {
    errors.push(`${label}: title은 확인한 제목이거나 null이어야 합니다.`);
  }
  if (typeof entry.rejectionReason !== 'string' || !rejectionReasons.has(entry.rejectionReason)) {
    errors.push(`${label}: 알 수 없는 rejectionReason입니다.`);
  }
}

/**
 * 표에 담을 초안이 authoritative draft 계약에 맞는지 확인한다.
 *
 * 최상위 항목은 정확히 셋뿐이고, 자료·제외 기록의 세부 모양은 기존 계약의 목록을 그대로 쓴다.
 * 아직 완성된 결과가 아니므로 최소 개수는 요구하지 않는다.
 */
function checkPrimaryDraft(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push('primaryDraft가 객체가 아닙니다.');
    return;
  }

  for (const key of Object.keys(value)) {
    if (!(DRAFT_FIELDS as readonly string[]).includes(key)) {
      errors.push(`primaryDraft에 허용되지 않는 항목이 있습니다 (${key})`);
    }
  }
  for (const key of DRAFT_FIELDS) {
    if (!(key in value)) errors.push(`primaryDraft에 필수 항목이 없습니다 (${key})`);
  }

  if (!Array.isArray(value.sources)) {
    errors.push('primaryDraft.sources가 배열이 아닙니다.');
  } else {
    if (value.sources.length > ACCEPTED_MAX) {
      errors.push(`primaryDraft.sources는 ${ACCEPTED_MAX}개까지입니다.`);
    }
    const seenUrls = new Set<string>();
    for (const [index, entry] of value.sources.entries()) {
      checkDraftSource(entry, `primaryDraft.sources[${index}]`, seenUrls, errors);
    }
  }

  if (!Array.isArray(value.rejectedSources)) {
    errors.push('primaryDraft.rejectedSources가 배열이 아닙니다.');
  } else {
    // 모델이 직접 남긴 기록만 있으므로 모델 쪽 상한을 쓴다.
    // 서버 기록까지 더한 22개 상한은 materialization 뒤의 최종 결과에만 해당한다.
    if (value.rejectedSources.length > REJECTED_SOURCE_MAX) {
      errors.push(`primaryDraft.rejectedSources는 ${REJECTED_SOURCE_MAX}개까지입니다.`);
    }
    for (const [index, entry] of value.rejectedSources.entries()) {
      checkDraftRejected(entry, `primaryDraft.rejectedSources[${index}]`, errors);
    }
  }

  if (
    !Array.isArray(value.unresolvedSourceQuestions) ||
    !value.unresolvedSourceQuestions.every((item) => typeof item === 'string')
  ) {
    errors.push('primaryDraft.unresolvedSourceQuestions가 문자열 목록이 아닙니다.');
  }
}

/**
 * 표에 담을 값이 규칙을 지켰는지 확인한다.
 * 하나라도 어기면 표를 만들지 않는다(fail-closed).
 */
export function validateHarvestRecoveryTicketInput(value: unknown): TicketValidation {
  const errors: string[] = [];

  if (!isRecord(value)) {
    return { valid: false, errors: ['표에 담을 값이 객체가 아닙니다.'] };
  }

  for (const key of Object.keys(value)) {
    if (!(INPUT_FIELDS as readonly string[]).includes(key)) {
      errors.push(`허용되지 않는 항목이 있습니다 (${key})`);
    }
  }
  for (const key of INPUT_FIELDS) {
    if (!(key in value)) errors.push(`필수 항목이 없습니다 (${key})`);
  }

  scanBannedFields(value, errors);

  // 연구 대상 영역은 canonical 목록 안에 있어야 한다.
  // 이미 카드가 있는 영역(fear_uncertainty 등)과 other_uncovered는 연구 대상이 아니다.
  if (typeof value.targetDomain !== 'string' || !researchableDomains.has(value.targetDomain)) {
    errors.push('targetDomain이 연구 대상 영역이 아닙니다.');
  }
  if (
    typeof value.evidenceVersion !== 'number' ||
    !Number.isSafeInteger(value.evidenceVersion) ||
    value.evidenceVersion < 1
  ) {
    errors.push('evidenceVersion이 1 이상의 정수가 아닙니다.');
  }
  if (typeof value.prioritizerSnapshotId !== 'string' || !SNAPSHOT_ID.test(value.prioritizerSnapshotId)) {
    errors.push('prioritizerSnapshotId의 모양이 다릅니다.');
  }
  if (typeof value.activeCoveredHash !== 'string' || !SHA256_HEX.test(value.activeCoveredHash)) {
    errors.push('activeCoveredHash의 모양이 다릅니다.');
  }

  const discovered = checkUrlList(value.discoveredUrls, 'discoveredUrls', errors);
  if (discovered !== null && discovered.length === 0) {
    errors.push('discoveredUrls가 비어 있습니다.');
  }

  const inspected = checkUrlList(value.primaryInspectedUrls, 'primaryInspectedUrls', errors);

  // 열어 본 주소는 반드시 발견된 주소 안에 있어야 한다.
  if (discovered !== null && inspected !== null) {
    const found = new Set(discovered);
    for (const [index, url] of inspected.entries()) {
      if (!found.has(url)) {
        errors.push(`primaryInspectedUrls[${index}]: 발견된 주소 목록에 없습니다.`);
      }
    }
  }

  checkPrimaryDraft(value.primaryDraft, errors);

  checkToolCounts(value.primaryToolCounts, inspected === null ? null : inspected.length, errors);

  return { valid: errors.length === 0, errors };
}

/**
 * 표에서 꺼낸 값을 다시 확인한다.
 * 담을 때와 같은 규칙을 쓴다. DB에서 왔다는 이유로 그냥 믿지 않는다.
 */
export function parseHarvestRecoveryTicketState(
  value: unknown,
): { ok: true; state: HarvestRecoveryTicketState } | { ok: false; errors: string[] } {
  const outcome = validateHarvestRecoveryTicketInput(value);
  if (!outcome.valid) return { ok: false, errors: outcome.errors };
  return { ok: true, state: value as HarvestRecoveryTicketState };
}

/**
 * DB에서 온 한 줄(snake_case)을 앱 안에서 쓰는 모양(camelCase)으로 바꾼다.
 *
 * 이름을 바꾸는 곳은 여기 한 곳뿐이다.
 * DB 줄을 검사 함수에 그대로 넘기지 않는다. 이름이 달라 전부 "모르는 항목"이 되기 때문이다.
 *
 * 모르는 칸이 하나라도 있거나 필요한 칸이 하나라도 없으면 쓰지 않는다(fail-closed).
 * 그래서 camelCase 객체를 DB 줄인 것처럼 넣으면 통과하지 못한다.
 */
export function mapTicketRowToState(
  row: unknown,
): { ok: true; state: HarvestRecoveryTicketState } | { ok: false; errors: string[] } {
  if (!isRecord(row)) {
    return { ok: false, errors: ['표에서 꺼낸 줄이 객체가 아닙니다.'] };
  }

  const errors: string[] = [];

  for (const key of Object.keys(row)) {
    if (!(ROW_FIELDS as readonly string[]).includes(key)) {
      errors.push(`표에 없는 칸이 있습니다 (${key})`);
    }
  }
  for (const key of ROW_FIELDS) {
    if (!(key in row)) errors.push(`표에 있어야 할 칸이 없습니다 (${key})`);
  }

  if (errors.length > 0) return { ok: false, errors };

  const mapped: Record<string, unknown> = {};
  for (const key of ROW_FIELDS) {
    mapped[TICKET_ROW_COLUMNS[key]] = row[key];
  }

  return parseHarvestRecoveryTicketState(mapped);
}

/**
 * 표 만들기 결과를 읽는다. 표 id 하나만 나온다.
 * 주소나 자료 설명이 함께 오면 그 응답을 쓰지 않는다.
 */
export function parseCreateTicketResponse(value: unknown): string | null {
  if (isRecoveryId(value)) return value;

  // PostgREST는 스칼라 반환을 배열이나 객체로 감싸서 줄 수 있다.
  if (Array.isArray(value) && value.length === 1) return parseCreateTicketResponse(value[0]);

  if (isRecord(value)) {
    const keys = Object.keys(value);
    if (keys.length !== 1) return null;
    return parseCreateTicketResponse(value[keys[0]]);
  }

  return null;
}

/**
 * 표 꺼내기 결과를 읽는다.
 *
 * 없는 id, 만료된 id, 이미 쓴 id는 모두 똑같이 빈 결과다.
 * 어느 쪽인지 구분해서 알려주지 않는다.
 *
 * DB가 준 줄은 반드시 mapTicketRowToState를 지나간다.
 */
export function parseConsumeTicketResponse(
  value: unknown,
): { ok: true; state: HarvestRecoveryTicketState } | { ok: false; reason: 'empty' | 'invalid' } {
  if (!Array.isArray(value)) return { ok: false, reason: 'invalid' };
  if (value.length === 0) return { ok: false, reason: 'empty' };
  if (value.length > 1) return { ok: false, reason: 'invalid' };

  const parsed = mapTicketRowToState(value[0]);
  return parsed.ok ? { ok: true, state: parsed.state } : { ok: false, reason: 'invalid' };
}
