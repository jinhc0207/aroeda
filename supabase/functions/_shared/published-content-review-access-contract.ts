/**
 * 검토자 관리와 읽기 경계.
 *
 * 앞 단계에서 "사람이 승인해야만 글이 게시된다"는 쓰기 경계를 만들었고
 * 그 표와 함수는 이미 production에 있다.
 *
 * 그런데 지금 상태로는 아무도 검토할 수 없다.
 *   하나. 검토자 명단이 비어 있다.
 *   둘. 검토자가 무엇을 읽을 수 있는지 정해진 길이 없다.
 *
 * 이 파일은 그 둘을 정한다. 만들지는 않는다.
 *
 * 여기에는 SQL도, DB 연결도, 화면도 없다.
 * 타입과 약속과 순수 검사기뿐이다.
 * 다음 단계에서 만들 migration이 이 약속을 따라야 하고,
 * 그때 실제 SQL과 여기 적힌 값을 대조한다.
 *
 * 앞 계약에 이런 문장이 있었다.
 *   "읽기 길은 다음 단계에서 만든다. 관리 화면에 service_role을 두지 않고,
 *    같은 검토자 명단을 쓰는 별도 경계로 만든다."
 * 이 파일이 그 다음 단계다.
 */

import type { PassageRef } from './scripture-cards.ts';
import type { BiblicalResearchResult } from './biblical-researcher.ts';
import {
  CANDIDATE_HASH_FORMAT,
  type PublishValidation,
  type PublishedContentCandidate,
} from './published-content-contract.ts';
import {
  PUBLISHED_CONTENT_TABLES,
  REVIEW_PUBLISHED_CONTENT_CANDIDATE_RPC,
  type CandidateStoreRow,
  validateCandidateStoreInput,
} from './published-content-store-contract.ts';
import {
  RESEARCH_RESULT_HASH_FORMAT,
  type ResearchResultProvenance,
  validateResearchResultInsert,
} from './research-result-store-contract.ts';

/* ------------------------------------------------------------------ */
/* 1. 검토자를 누가 관리하는가                                          */
/* ------------------------------------------------------------------ */

/**
 * V1에서 검토자 관리는 애플리케이션 기능이 아니다.
 *
 * 즉 register_reviewer 같은 DB 함수를 만들지 않는다.
 * 로그인한 사람도, 서버 열쇠도, 화면도 검토자를 늘리거나 줄일 수 없다.
 *
 * 왜 서버 열쇠(service_role)에게도 주지 않는가.
 *
 * 서버 열쇠는 검토 대상 글을 적어 두는 일에는 쓴다. 그것은 아직 승인이 아니다.
 * 그런데 검토자 명단을 고치는 일까지 서버 열쇠로 열어 두면,
 * 자동화가 스스로 검토자를 하나 만들어 자기 글을 승인하는 길이 생긴다.
 * 자동화의 권한과 사람의 승인 권한을 나눈 의미가 사라진다.
 *
 * 여기서 과장하지 않는다.
 * "서버 열쇠가 DB 관리자를 절대 우회할 수 없다"는 뜻이 아니다.
 * 정확히는, 정상적인 애플리케이션 경로에 그 길을 만들지 않는다는 뜻이다.
 * 프로젝트 관리자 권한을 가진 사람은 여전히 표를 직접 고칠 수 있다.
 */
export const REVIEWER_MANAGEMENT_BOUNDARY = {
  /** 운영자가 직접, 명시적으로 한다. 애플리케이션 기능이 아니다. */
  reviewerManagementMode: 'operator_only',

  /** 검토자를 관리하는 DB 함수를 만들지 않는다. */
  applicationManagementRpc: false,

  /** 로그인한 사람은 검토자를 관리할 수 없다. 검토자 자신도 마찬가지다. */
  authenticatedCanManageReviewers: false,

  /** 서버 열쇠도 관리할 수 없다. 위 설명이 이유다. */
  serviceRoleCanManageReviewers: false,

  /** 로그인하지 않은 쪽은 당연히 할 수 없다. */
  anonCanManageReviewers: false,

  /** 앱이나 관리 화면에서 관리하지 않는다. */
  clientCanManageReviewers: false,

  /** 켤 때 그 번호가 실제 인증 사용자인지 그 자리에서 확인한다. */
  activationRequiresExistingAuthUser: true,

  /** 켜는 일은 사용자의 명시적 승인을 받은 뒤에만 한다. */
  activationRequiresExplicitOperatorApproval: true,

  /** 뺄 때는 줄을 지우지 않고 is_active 를 false 로 둔다. */
  deactivationUsesIsActiveFalse: true,

  /** 가입했다고 검토자가 되지 않는다. */
  automaticReviewerPromotion: false,

  /** migration 에 검토자를 미리 넣어 두지 않는다. */
  seedReviewer: false,

  /** 고칠 수 있는 표는 검토자 명단 하나뿐이다. */
  managedTable: PUBLISHED_CONTENT_TABLES.reviewer,
} as const;

/**
 * 첫 검토자를 어떻게 등록하는가.
 *
 * 지금 명단이 비어 있어서 아무도 검토할 수 없다. 이 상태가 정상이다.
 * 잠긴 문을 열어 두는 것보다 잠긴 채로 두는 편이 안전하다.
 *
 * 첫 사람을 넣을 때도 자동으로 하지 않는다. 아래 순서를 지킨다.
 */
export const REVIEWER_BOOTSTRAP_STEPS = [
  '그 번호가 실제 인증 사용자로 있는지 확인한다.',
  '사용자에게 누구를 검토자로 세우는지 알리고 명시적 승인을 받는다.',
  '운영자 권한으로 명단에 한 줄을 넣고 is_active 를 켠다.',
] as const;

/**
 * 인증 표를 가리키지 않기로 한 것과, 켤 때 확인하는 것은 다른 이야기다.
 *
 * 명단은 auth.users 를 가리키지 않는다(FK 없음).
 * 사람이 탈퇴해도 "누가 승인했는가"는 남아야 하기 때문이다.
 *
 * 그러나 처음 켜는 순간에는 그 번호가 실제 사용자여야 한다.
 * 아무 번호나 켜 두면 존재하지 않는 사람 앞으로 권한이 열린다.
 *
 * 표가 늘 강제하는 규칙(FK)과, 켜는 그 시점에 사람이 확인하는 일은 별개다.
 */
export const REVIEWER_AUTH_USER_RULE =
  '명단은 auth.users 를 가리키지 않는다. 다만 켜는 시점에는 그 번호가 실제 인증 사용자인지 확인한다.';

/**
 * 검토자를 뺄 때 줄을 지우지 않는 이유.
 *
 * 지난 결정에는 누가 판단했는지가 남아 있다(reviewer_user_id).
 * 명단에서 줄을 지워도 그 값은 그대로 남는다. 결정 기록은 고칠 수 없기 때문이다.
 * 그래서 지우면 "이 번호가 누구였는지" 확인할 곳만 사라진다.
 *
 * is_active 를 끄면 앞으로 읽지도 승인하지도 못하게 되고,
 * 지난 결정은 그대로 유효하다. 그것이 우리가 원하는 상태다.
 */
export const REVIEWER_DEACTIVATION_RULE =
  '줄을 지우지 않고 is_active 를 false 로 둔다. 지난 결정은 그대로 유효하고, 앞으로의 읽기와 승인만 막힌다.';

/**
 * 지금 명단이 알려주지 못하는 것.
 *
 * 표에 있는 것은 user_id, is_active, created_at 셋뿐이다.
 * 그래서 "지금 누가 검토자인가"는 알 수 있지만
 * "누가 언제 켰고 껐는가"는 남지 않는다.
 *
 * 지금은 관리자가 한 사람이고 등록도 운영자가 직접 하므로 이것이 문제가 아니다.
 * 관리자가 여럿이 되거나 기록을 요구받게 되면 그때 따로 설계한다.
 * 지금 표를 늘리지 않는다.
 */
export const REVIEWER_REGISTRY_AUDIT_LIMITATION =
  '명단은 현재 상태만 담는다. 누가 언제 켜고 껐는지의 이력은 남지 않는다. 관리자가 여럿이 되면 그때 따로 설계한다.';

/* ------------------------------------------------------------------ */
/* 2. 검토자가 무엇을 읽는가                                            */
/* ------------------------------------------------------------------ */

/** 검토할 글의 목록을 보는 함수. 아직 만들지 않았다. */
export const LIST_PUBLISHED_CONTENT_REVIEW_QUEUE_RPC = 'list_published_content_review_queue';

/** 글 한 건을 검토하기 위해 필요한 것을 모아 오는 함수. 아직 만들지 않았다. */
export const GET_PUBLISHED_CONTENT_REVIEW_PACKET_RPC = 'get_published_content_review_packet';

/** 한 번에 가져올 수 있는 최대 건수. 부르는 쪽이 늘릴 수 없다. */
export const REVIEW_QUEUE_MAX_ITEMS = 50;

/**
 * 목록 순서.
 *
 * 오래 기다린 글이 먼저다. 같은 시각이면 지문 순서로 정한다.
 * 두 번째 기준이 없으면 같은 시각의 글 순서가 호출마다 달라질 수 있다.
 */
export const REVIEW_QUEUE_ORDER = ['created_at asc', 'candidate_hash asc'] as const;

/**
 * 읽는 길이 지켜야 할 약속.
 *
 * 아직 구현이 아니다. 다음 단계 migration 이 따라야 할 값이다.
 *
 * 핵심은 읽기와 쓰기가 같은 신분 경계를 쓴다는 것이다.
 * 승인은 명단에 있는 사람만 할 수 있는데 읽기는 아무나 할 수 있으면,
 * 아직 사람이 검토하지 않은 글이 밖으로 나가는 길이 생긴다.
 */
export const FUTURE_READ_BOUNDARY = {
  queueRpc: LIST_PUBLISHED_CONTENT_REVIEW_QUEUE_RPC,
  packetRpc: GET_PUBLISHED_CONTENT_REVIEW_PACKET_RPC,

  /** 로그인한 사람만 부를 수 있다. */
  authenticatedExecute: true,

  /** 서버 열쇠로는 읽을 수 없다. 승인과 같은 경계다. */
  serviceRoleExecute: false,

  /** 로그인하지 않은 쪽은 부를 수 없다. */
  anonExecute: false,

  /** 아무에게나 열린 권한을 두지 않는다. */
  publicExecute: false,

  /** 누가 부르는지는 요청에서 받지 않고 인증 문맥에서 읽는다. */
  identitySource: 'auth.uid()',

  /** 로그인했다는 것만으로는 부족하다. 명단에 있고 켜져 있어야 한다. */
  activeReviewerRequired: true,

  /** 표를 직접 열어 주지 않는다. 읽기도 함수를 통해서만 한다. */
  directTableRead: false,

  /** 한 번에 가져올 수 있는 최대 건수. */
  maxQueueItems: REVIEW_QUEUE_MAX_ITEMS,

  /** 목록에는 아직 결정이 없는 글만 나온다. */
  queuePendingOnly: true,

  /** 검토 꾸러미도 아직 결정이 없는 글에만 준다. */
  packetPendingOnly: true,

  /** 읽는 것만으로 그 글을 맡게 되지 않는다. */
  readCreatesReservation: false,

  /** 읽는 동안 그 줄을 붙잡아 두지 않는다. */
  readLocksCandidate: false,

  /** 최종 판단은 여전히 기존 승인 함수의 몫이다. */
  finalWriteAuthority: REVIEW_PUBLISHED_CONTENT_CANDIDATE_RPC,

  /** 화면 쪽에 서버 열쇠를 두지 않는다. 검토자 본인의 로그인으로 읽는다. */
  serviceRoleClientUse: false,
} as const;

/**
 * "아직 결정이 없다"를 어떻게 아는가.
 *
 * 진행 상태 칸을 만들지 않는다. 칸을 만들면 그 값과 실제가 어긋날 수 있다.
 *
 * 대신 이렇게 읽는다.
 *   검토 대상 글에 줄이 있고, 결정 표에 그 지문의 줄이 없다.
 *
 * 두 표를 보면 알 수 있는 것을 세 번째 자리에 또 적어 두지 않는다.
 */
export const PENDING_DERIVATION =
  '검토 대상 글에 줄이 있고 결정 표에 그 지문의 줄이 없으면 아직 결정이 없는 것이다. 진행 상태 칸을 두지 않는다.';

/**
 * 두 사람이 같은 글을 동시에 열면.
 *
 * 검토자 A가 꾸러미를 읽는 동안 검토자 B가 먼저 결정할 수 있다.
 * 이것을 읽기 쪽에서 막지 않는다. 막으려면 읽는 동안 줄을 붙잡아야 하는데,
 * 사람이 글을 읽는 시간은 길고 그 사이 화면을 닫으면 글이 잠긴 채로 남는다.
 *
 * 그래서 읽기는 예약이 아니다.
 * 나중에 A가 결정을 보내면 기존 승인 함수가 막는다.
 * 한 글에 결정은 하나뿐이고(UNIQUE), 다른 사람의 결정을 자기 것으로 성공 처리하지 않는다.
 */
export const REVIEW_READ_RACE_NOTE =
  '읽는 것은 예약이 아니다. 두 사람이 같은 글을 열 수 있고, 최종 판단은 승인 함수의 한 글 한 결정 규칙이 정한다.';

/**
 * 이 경계가 지키는 것과 지키지 못하는 것.
 *
 * 지키는 것은 정상적인 애플리케이션 경로에서의 권한 분리다.
 *   그냥 로그인한 사람, 자동화 서버, 실제 검토자가 서로 다른 일을 한다.
 *
 * 지키지 못하는 것을 분명히 적어 둔다. 적어 두지 않으면 지킨다고 착각하게 된다.
 */
export const READ_BOUNDARY_LIMITATION = {
  guarantees: '정상 애플리케이션 경로에서 일반 로그인 사용자, 자동화, 검토자의 권한을 나눈다.',
  doesNotGuarantee: [
    '프로젝트 관리자 권한을 가진 사람이 표를 직접 읽거나 고치는 것',
    'postgres 소유자 권한으로 하는 일',
    '인증 관리 권한으로 다른 사람인 척하는 것',
    '검토자 계정 자체를 빼앗겼을 때',
    '화면 앞에 있는 사람이 그 계정의 주인이라는 물리적 증명',
  ],
} as const;

/* ------------------------------------------------------------------ */
/* 3. 목록에 무엇을 담는가                                              */
/* ------------------------------------------------------------------ */

/**
 * 목록은 "무엇을 검토할지 고르는" 자리다. "검토하는" 자리가 아니다.
 *
 * 그래서 연구 결과 전체나 자료 목록을 여기 담지 않는다.
 * 고를 때 필요한 만큼만 담는다. 실제 판단에 필요한 것은 꾸러미에 있다.
 */
export const REVIEW_QUEUE_ITEM_FIELDS = [
  'candidateHash',
  'researchResultHash',
  'targetDomain',
  'referenceLabel',
  'passage',
  'candidateCreatedAt',
] as const;

export type ReviewQueueItem = {
  candidateHash: string;
  researchResultHash: string;
  targetDomain: string;
  referenceLabel: string;
  /** 어느 본문인지. 글에 이미 있는 값을 그대로 쓴다. */
  passage: PassageRef;
  /** 표가 붙인 시각. 오래 기다린 글을 먼저 보기 위해 쓴다. */
  candidateCreatedAt: string;
};

/**
 * 목록에 오면 안 되는 이름들.
 *
 * 앞쪽은 연구 근거다. 그것은 꾸러미의 몫이다.
 * 가운데는 검토자 신분이다. 읽을 자격을 확인하는 데만 쓰고 돌려주지 않는다.
 * 뒤쪽은 사람의 이야기다. 이 경로에 올 일이 없다.
 */
export const FORBIDDEN_QUEUE_FIELDS = [
  'researchResult',
  'researchProvenance',
  'provenance',
  'sources',
  'sourceUnresolvedQuestions',
  'evidenceIds',
  'evidenceSetHash',
  'candidatePassages',
  'url',
  'reviewerUserId',
  'reviewerId',
  'currentReviewerId',
  'isActive',
  'email',
  'situation',
  'rawSituation',
  'prayer',
  'prayerDraft',
  'userId',
  'sessionId',
  'deviceId',
  'jwt',
  'apiKey',
] as const;

/* ------------------------------------------------------------------ */
/* 4. 꾸러미에 무엇을 담는가                                            */
/* ------------------------------------------------------------------ */

/**
 * 사람이 실제로 판단할 때 보는 것.
 *
 * 확인 항목에는 이런 것들이 있다.
 *   연구까지 되짚을 수 있는가, 본문의 문맥을 지켰는가,
 *   신학적으로 맞는가, 목회적으로 안전한가, 오용을 막는 말이 충분한가.
 *
 * 글만 보고는 이 중 절반을 판단할 수 없다.
 * 어떤 자료를 보고 나온 말인지 모르면 "되짚을 수 있는가"에 답할 수 없다.
 * 그래서 검토자에게는 연구 결과와 근거 기록까지 보여준다.
 *
 * 이것은 검토자만 보는 것이다. 승인된 글에는 옮겨 적지 않는다.
 */
export const REVIEW_PACKET_FIELDS = [
  'candidateHash',
  'candidate',
  'candidateCreatedAt',
  'researchResultHash',
  'researchResult',
  'researchProvenance',
  'researchResultCreatedAt',
] as const;

export type PublishedContentReviewPacket = {
  candidateHash: string;
  candidate: PublishedContentCandidate;
  /** 표가 붙인 시각. */
  candidateCreatedAt: string;
  researchResultHash: string;
  researchResult: BiblicalResearchResult;
  researchProvenance: ResearchResultProvenance;
  /** 표가 붙인 시각. */
  researchResultCreatedAt: string;
};

/**
 * 자료와 근거는 어디까지 갈 수 있는가.
 *
 *   연구 보관소   있다. 그것의 주인이다.
 *   검토 꾸러미   있다. 사람이 판단하려면 필요하다.
 *   목록          없다. 고르는 데 필요하지 않다.
 *   승인된 글     없다. 앞 계약이 이미 막고 있다.
 *   사용자 화면   없다.
 *
 * 같은 정보라도 누가 보느냐에 따라 자리가 다르다.
 */
export const REVIEWER_ONLY_EVIDENCE_NOTE =
  '자료와 근거는 검토자만 보는 것이다. 목록에도, 승인된 글에도, 사용자 화면에도 옮기지 않는다.';

/**
 * 꾸러미 어디에도 오면 안 되는 이름들.
 *
 * 자료(sources)는 여기서 막지 않는다. 검토자가 보아야 하는 것이기 때문이다.
 * 대신 사람의 이야기와 검토자 신분을 막는다.
 *
 * 글 안쪽의 금지 항목은 앞 계약이 이미 본다. 여기서 같은 규칙을 다시 만들지 않는다.
 */
export const FORBIDDEN_PACKET_FIELDS = [
  'situation',
  'rawSituation',
  'prayer',
  'prayerDraft',
  'sessionId',
  'deviceId',
  'jwt',
  'apiKey',
  'userId',
  'currentReviewerId',
  'reviewerUserId',
  'reviewerId',
  'email',
  'decision',
  'checklist',
  'rejectionReasons',
] as const;

/**
 * 읽는 길에서 쓰는 길로 넘어가지 않는다.
 *
 * 꾸러미는 판단할 재료를 줄 뿐, 결정을 미리 채워 두지 않는다.
 * 승인 요청을 대신 만들어 주지도 않는다. 기본값을 승인으로 두지도 않는다.
 * 그래서 위 금지 목록에 decision, checklist, rejectionReasons 가 들어 있다.
 */
export const NO_READ_TO_WRITE_ESCALATION =
  '꾸러미는 결정을 담지 않는다. 승인 요청을 대신 만들지 않고 기본값도 두지 않는다.';

/* ------------------------------------------------------------------ */
/* 5. 순수 검사기                                                       */
/* ------------------------------------------------------------------ */

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

/**
 * 시각의 모양만 본다.
 *
 * 진짜 그 시각이 맞는지는 여기서 알 수 없다. 표가 붙인 값이기 때문이다.
 * 지금 시각을 읽지 않는다. 이 파일은 부를 때마다 같은 답을 내야 한다.
 */
const TIMESTAMP_SHAPE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/;

const isTimestampText = (value: unknown): value is string =>
  typeof value === 'string' && TIMESTAMP_SHAPE.test(value);

const isPassageRef = (value: unknown): value is PassageRef =>
  isPlainObject(value) &&
  isNonEmptyString(value.book) &&
  Number.isInteger(value.chapter) &&
  Number.isInteger(value.startVerse) &&
  Number.isInteger(value.endVerse);

/** 이름이 그대로 들어 있는지만 본다. 긴 이름의 앞부분과 섞이지 않게 따옴표까지 함께 본다. */
const findForbiddenKey = (value: unknown, forbidden: readonly string[]): string | null => {
  const serialized = JSON.stringify(value) ?? '';
  for (const name of forbidden) {
    if (serialized.includes(`"${name}":`)) return name;
  }
  return null;
};

/**
 * 목록 한 줄이 받을 수 있는 모양인지 본다.
 *
 * 표를 부르지 않는다. 값의 모양만 본다.
 * 어떤 이상한 값이 들어와도 예외를 던지지 않는다. 판단이 서지 않으면 막는다.
 */
export function validateReviewQueueItem(value: unknown): PublishValidation {
  const errors: string[] = [];

  try {
    if (!isPlainObject(value)) {
      return { valid: false, errors: ['목록 한 줄이 객체가 아닙니다.'] };
    }

    for (const key of Object.keys(value)) {
      if (!(REVIEW_QUEUE_ITEM_FIELDS as readonly string[]).includes(key)) {
        errors.push(`목록에 없는 항목입니다: ${key}`);
      }
    }
    for (const key of REVIEW_QUEUE_ITEM_FIELDS) {
      if (!(key in value)) errors.push(`빠진 항목입니다: ${key}`);
    }

    const forbidden = findForbiddenKey(value, FORBIDDEN_QUEUE_FIELDS);
    if (forbidden !== null) {
      errors.push(`목록에 올 수 없는 항목입니다: ${forbidden}`);
    }

    if (typeof value.candidateHash !== 'string' || !CANDIDATE_HASH_FORMAT.test(value.candidateHash)) {
      errors.push('글 지문의 모양이 맞지 않습니다.');
    }
    if (
      typeof value.researchResultHash !== 'string' ||
      !RESEARCH_RESULT_HASH_FORMAT.test(value.researchResultHash)
    ) {
      errors.push('연구 지문의 모양이 맞지 않습니다.');
    }
    if (!isNonEmptyString(value.targetDomain)) errors.push('영역이 없습니다.');
    if (!isNonEmptyString(value.referenceLabel)) errors.push('본문 이름이 없습니다.');
    if (!isPassageRef(value.passage)) errors.push('본문 위치의 모양이 맞지 않습니다.');
    if (!isTimestampText(value.candidateCreatedAt)) errors.push('적힌 시각의 모양이 맞지 않습니다.');

    return { valid: errors.length === 0, errors };
  } catch {
    return { valid: false, errors: ['목록 한 줄을 확인하지 못했습니다.'] };
  }
}

/**
 * 적혀 있는 글 한 줄에서 목록 한 줄을 만든다.
 *
 * 새 값을 지어내지 않는다. 이미 적혀 있는 것에서 골라 담기만 한다.
 * 이렇게 해 두면 목록에 담을 수 있는 것이 자연히 제한된다.
 */
export function buildReviewQueueItem(row: CandidateStoreRow): ReviewQueueItem {
  return {
    candidateHash: row.candidateHash,
    researchResultHash: row.researchResultHash,
    targetDomain: row.candidate.targetDomain,
    referenceLabel: row.candidate.referenceLabel,
    passage: row.candidate.passage,
    candidateCreatedAt: row.createdAt,
  };
}

/**
 * 검토 꾸러미가 받을 수 있는 모양인지 본다.
 *
 * 글의 검사도, 연구의 검사도 여기서 새로 만들지 않는다.
 * 이미 있는 두 검사기를 그대로 부른다. 같은 규칙을 두 벌 만들면 언젠가 서로 달라진다.
 *
 * 그 둘이 이미 다음을 본다.
 *   글 지문이 글 내용과 맞는가, 연구 지문이 연구 내용과 맞는가,
 *   글 안의 연구 지문과 밖에 적은 값이 같은가.
 *
 * 여기서 더 보는 것은 꾸러미 자체의 모양과 시각, 그리고 오면 안 되는 이름들이다.
 *
 * 이 검사는 어긋난 것을 드러내는 장치이지, 못 바꾸게 막는 잠금장치가 아니다.
 * 실제로 못 바꾸게 하는 일은 표의 쓰기 권한과 고쳐 쓰지 않는 규칙이 맡는다.
 */
export async function validatePublishedContentReviewPacket(
  value: unknown,
): Promise<PublishValidation> {
  const errors: string[] = [];

  try {
    if (!isPlainObject(value)) {
      return { valid: false, errors: ['검토 꾸러미가 객체가 아닙니다.'] };
    }

    for (const key of Object.keys(value)) {
      if (!(REVIEW_PACKET_FIELDS as readonly string[]).includes(key)) {
        errors.push(`검토 꾸러미에 없는 항목입니다: ${key}`);
      }
    }
    for (const key of REVIEW_PACKET_FIELDS) {
      if (!(key in value)) errors.push(`빠진 항목입니다: ${key}`);
    }

    const forbidden = findForbiddenKey(value, FORBIDDEN_PACKET_FIELDS);
    if (forbidden !== null) {
      errors.push(`검토 꾸러미에 올 수 없는 항목입니다: ${forbidden}`);
    }

    if (!isTimestampText(value.candidateCreatedAt)) {
      errors.push('글이 적힌 시각의 모양이 맞지 않습니다.');
    }
    if (!isTimestampText(value.researchResultCreatedAt)) {
      errors.push('연구가 적힌 시각의 모양이 맞지 않습니다.');
    }

    // 모양이 어긋났으면 더 보지 않는다. 지문 계산이 의미가 없다.
    if (errors.length > 0) return { valid: false, errors };

    const candidateCheck = await validateCandidateStoreInput({
      candidateHash: value.candidateHash,
      researchResultHash: value.researchResultHash,
      candidate: value.candidate,
    });
    if (!candidateCheck.valid) return { valid: false, errors: candidateCheck.errors };

    const researchCheck = await validateResearchResultInsert({
      result: value.researchResult,
      provenance: value.researchProvenance,
      resultHash: value.researchResultHash,
    });
    if (!researchCheck.valid) return { valid: false, errors: researchCheck.errors };

    return { valid: true, errors: [] };
  } catch {
    return { valid: false, errors: ['검토 꾸러미를 확인하지 못했습니다.'] };
  }
}
