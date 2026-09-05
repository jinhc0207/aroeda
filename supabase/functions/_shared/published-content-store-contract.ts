/**
 * 게시 콘텐츠 보관과 사람의 검토 — 쓰기 경계 설계
 *
 * 무엇을 정하는가
 *   앞 계약(published-content-contract.ts)이 "무엇을 승인하는가"를 정했다.
 *   이 파일은 "누가 그 승인을 기록할 수 있는가"를 정한다.
 *
 *   표를 만들지 않는다. SQL을 쓰지 않는다.
 *   앞으로 만들 표와 함수가 지켜야 할 약속만 코드로 적어 둔다.
 *
 * 왜 권한을 둘로 나누는가
 *   검토 대상 글을 적어 두는 일과, 그것을 승인하는 일은 성격이 다르다.
 *
 *   글을 적어 두는 것은 아직 승인이 아니다. 서버가 해도 된다.
 *   승인은 사람이 읽고 판단하는 일이다. 서버 열쇠로 할 수 있으면 안 된다.
 *
 *   그래서 승인 함수에는 service_role 실행 권한을 주지 않는다.
 *   로그인한 사람 중에서도 검토자 명단에 있는 사람만 부를 수 있게 한다.
 *
 * 누가 검토했는지는 요청에서 받지 않는다
 *   부르는 쪽이 "나는 사람이다", "내 번호는 이것이다"라고 적어 보내게 하면
 *   그 말을 그대로 믿는 구조가 된다. 그러면 경계가 없는 것과 같다.
 *
 *   검토자 번호는 DB가 인증 문맥에서 직접 읽는다(auth.uid()).
 *   요청 본문에는 그 자리를 아예 만들지 않았다.
 *
 * 이 경계가 보장하는 것과 하지 못하는 것 — 분명히 적어 둔다
 *
 *   보장하려는 것
 *     정상적인 애플리케이션 권한 경로에서
 *     서버 열쇠(service_role)로 도는 자동화와 사람의 승인 권한을 분리한다.
 *     검토자 번호를 요청 본문에서 지어낼 수 없다.
 *     승인은 그 글의 지문에 묶여, 다른 글에 옮겨 쓸 수 없다.
 *
 *   보장하지 못하는 것
 *     "실제로 사람이 버튼을 눌렀다"를 증명하지는 못한다.
 *     검토자 계정이 털리면, Supabase 관리자 권한이 있으면,
 *     postgres 주인이면, 인증 관리 권한으로 남을 사칭하면
 *     이 경계는 위가 아니라 아래에서 열린다.
 *
 *   그러니 "AI가 절대 승인할 수 없다"고 적지 않는다.
 *   정확히는 "서버 열쇠와 사람의 승인 권한을 분리한다"까지다.
 *
 * 이 파일이 하지 않는 일
 *   지문을 새로 계산하지 않는다. 확인 항목이나 반려 이유를 다시 정의하지 않는다.
 *   앞 계약에 있는 것을 그대로 가져다 쓴다.
 *   바깥을 부르지 않고, 시각이나 난수를 만들지 않는다.
 */

import {
  CANDIDATE_HASH_FORMAT,
  REJECTION_REASONS,
  REVIEW_CHECKS,
  REVIEW_DECISIONS,
  computePublishedContentCandidateHash,
  validatePublishedContentCandidate,
  type PublishedContent,
  type PublishedContentCandidate,
  type PublishedContentReview,
  type PublishValidation,
  type RejectionReason,
  type ReviewChecklist,
  type ReviewDecision,
} from './published-content-contract.ts';
import { RESEARCH_RESULT_HASH_FORMAT } from './research-result-store-contract.ts';

/* ------------------------------------------------------------------ */
/* 앞으로 만들 표                                                       */
/* ------------------------------------------------------------------ */

/**
 * 표 이름을 여기서 미리 정해 둔다.
 *
 * 앞의 보관소들과 같은 자리(private 스키마)에 둔다.
 * 이 이름들은 다음 단계에서 만들 migration이 따라야 할 약속이다.
 * 지금은 아무 표도 존재하지 않는다.
 */
export const PUBLISHED_CONTENT_TABLES = {
  /** 사람이 읽고 판단할 글. 한 번 적으면 고치지 않는다. */
  candidate: 'private.published_content_candidate',
  /** 사람이 내린 결정. 한 번 적으면 고치지 않는다. */
  review: 'private.published_content_review',
  /** 승인을 통과한 글. 한 번 적으면 고치지 않는다. */
  published: 'private.published_content',
  /** 누가 검토할 수 있는지. 이것만 켜고 끌 수 있다. */
  reviewer: 'private.published_content_reviewer',
} as const;

/**
 * 앞으로 만들 DB 함수. 정확히 둘이다.
 *
 * 게시만 따로 하는 함수를 두지 않는다. 그 이유는 아래 경계 약속에 적었다.
 * 이름은 기존 관례(create_ / consume_ / store_)를 따랐다.
 */
export const STORE_PUBLISHED_CONTENT_CANDIDATE_RPC = 'store_published_content_candidate';
export const REVIEW_PUBLISHED_CONTENT_CANDIDATE_RPC = 'review_published_content_candidate';

/* ------------------------------------------------------------------ */
/* 검토 대상 적어 두기                                                  */
/* ------------------------------------------------------------------ */

export const CANDIDATE_STORE_INPUT_FIELDS = [
  'candidateHash',
  'researchResultHash',
  'candidate',
] as const;

/**
 * 검토 대상을 적어 둘 때 넘기는 값.
 *
 * 글 안에도 연구 지문이 이미 있는데 밖에 한 번 더 두는 이유가 있다.
 * 표에서 연구 보관소와 이어 두려면(FK) 칸이 필요하기 때문이다.
 *
 * 다만 두 값이 서로 다를 수 있는 상태를 만들면 안 된다.
 * 그래서 여기서도 같은지 보고, 앞으로 표에서도 같아야만 적히도록 한다.
 * 겹치는 것은 괜찮다. 어긋나는 것이 문제다.
 *
 * 영역 이름 같은 값은 밖에 또 두지 않는다. 그것은 이을 곳이 없다.
 */
export type CandidateStoreInput = {
  candidateHash: string;
  researchResultHash: string;
  candidate: PublishedContentCandidate;
};

/** 적힌 줄 하나. 번호와 시각은 표가 붙인다. */
export type CandidateStoreRow = CandidateStoreInput & {
  /** 표가 붙인다. */
  createdAt: string;
};

/**
 * 적어 둘 수 있는 값인지 본다.
 *
 * 글 자체의 검사는 앞 계약이 한다. 여기서 같은 규칙을 다시 만들지 않는다.
 * 지문도 앞 계약의 함수로 다시 계산해서 맞춰 본다.
 *
 * 연구 결과가 실제로 보관소에 있는지는 보지 않는다.
 * 그것은 표의 이음(FK)이 할 일이고, 여기서 DB를 부르지 않는다.
 */
export async function validateCandidateStoreInput(value: unknown): Promise<PublishValidation> {
  const errors: string[] = [];

  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return { valid: false, errors: ['적어 둘 값이 객체가 아닙니다.'] };
    }

    const input = value as Record<string, unknown>;

    for (const key of Object.keys(input)) {
      if (!(CANDIDATE_STORE_INPUT_FIELDS as readonly string[]).includes(key)) {
        errors.push(`적어 두기에 없는 항목입니다: ${key}`);
      }
    }
    for (const key of CANDIDATE_STORE_INPUT_FIELDS) {
      if (!(key in input)) errors.push(`빠진 항목입니다: ${key}`);
    }

    if (typeof input.candidateHash !== 'string' || !CANDIDATE_HASH_FORMAT.test(input.candidateHash)) {
      errors.push('글 지문의 모양이 맞지 않습니다.');
    }
    if (
      typeof input.researchResultHash !== 'string' ||
      !RESEARCH_RESULT_HASH_FORMAT.test(input.researchResultHash)
    ) {
      errors.push('연구 지문의 모양이 맞지 않습니다.');
    }

    const candidateCheck = validatePublishedContentCandidate(input.candidate);
    if (!candidateCheck.valid) return { valid: false, errors: candidateCheck.errors };

    if (errors.length > 0) return { valid: false, errors };

    const candidate = input.candidate as PublishedContentCandidate;

    // 밖에 적은 연구 지문과 글 안의 것이 어긋나면 적지 않는다.
    if (candidate.researchResultHash !== input.researchResultHash) {
      errors.push('글 안의 연구 지문과 밖에 적은 값이 다릅니다.');
    }

    // 지문은 앞 계약이 계산한다. 여기서 만들지 않는다.
    const expected = await computePublishedContentCandidateHash(candidate);
    if (input.candidateHash !== expected) {
      errors.push('글 지문이 내용과 맞지 않습니다.');
    }

    return { valid: errors.length === 0, errors };
  } catch {
    return { valid: false, errors: ['적어 둘 값을 확인하지 못했습니다.'] };
  }
}

/* ------------------------------------------------------------------ */
/* 사람의 검토                                                          */
/* ------------------------------------------------------------------ */

/**
 * 검토자 명단 한 줄.
 *
 * 이름이나 메일 주소를 여기 베껴 두지 않는다. 인증 쪽에 이미 있다.
 * 필요한 것은 "누가, 지금도 검토할 수 있는가" 둘뿐이다.
 *
 * 이 표만 고칠 수 있다. 권한을 주고 거두는 일이 있어야 하기 때문이다.
 * 나머지 셋은 한 번 적으면 고치지 않는다.
 */
export type PublishedContentReviewer = {
  /** 인증이 아는 그 사람의 번호. auth.uid()와 같은 값이다. */
  userId: string;
  isActive: boolean;
  /** 표가 붙인다. */
  createdAt: string;
};

/**
 * 사람이 보낼 수 있는 값. 정확히 넷뿐이다.
 *
 * 여기 없는 것을 눈여겨보아야 한다.
 *   검토자 번호가 없다. 자격이 없다. 글 본문이 없다.
 *
 * 검토자 번호는 DB가 인증 문맥에서 직접 읽는다.
 * 자격('human')은 명단을 통과한 뒤 서버가 붙인다. 선언해서 얻는 것이 아니다.
 * 글은 이미 적혀 있는 것을 쓴다. 승인하는 순간에 본문을 다시 보내지 않는다.
 *   다시 보내게 하면, 사람이 읽은 글과 승인된 글이 달라질 수 있다.
 */
export const REVIEW_WRITE_INPUT_FIELDS = [
  'candidateHash',
  'decision',
  'checklist',
  'rejectionReasons',
] as const;

/** 이 자리에 오면 안 되는 이름들. 오면 그 요청은 무효다. */
export const FORBIDDEN_REVIEW_INPUT_FIELDS = [
  'reviewerId',
  'reviewerUserId',
  'reviewAuthority',
  'authority',
  'candidate',
  'content',
  'publishedContent',
  'researchResult',
  'targetDomain',
  'passage',
  'userExplanation',
  'prayerDirection',
  'sources',
  'evidenceIds',
  'status',
  'createdAt',
  'reviewId',
] as const;

export type ReviewWriteInput = {
  candidateHash: string;
  decision: ReviewDecision;
  checklist: ReviewChecklist;
  rejectionReasons: RejectionReason[];
};

/**
 * 적힌 검토 기록 한 줄.
 *
 * 검토자 번호는 여기 남는다. 나중에 누가 판단했는지 물을 수 있어야 하기 때문이다.
 * 그러나 이 값은 승인된 글 안으로 들어가지 않는다.
 *
 * 사용자의 상황이나 기도와는 성격이 다른 값이다.
 * 그것은 서비스를 쓰는 사람의 이야기이고, 이것은 콘텐츠를 책임진 사람의 이름표다.
 */
export type ReviewStoreRow = {
  /** 표가 붙인다. */
  reviewId: string;
  candidateHash: string;
  /** 표가 auth.uid()에서 읽는다. 요청에서 받지 않는다. */
  reviewerUserId: string;
  review: PublishedContentReview;
  /** 표가 붙인다. */
  createdAt: string;
};

/**
 * 사람이 보낸 값이 받을 수 있는 모양인지 본다.
 *
 * 확인 항목과 반려 이유의 규칙은 앞 계약과 같아야 한다.
 * 새 결정 종류를 만들지 않는다.
 */
export function validateReviewWriteInput(value: unknown): PublishValidation {
  const errors: string[] = [];

  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return { valid: false, errors: ['검토 요청이 객체가 아닙니다.'] };
    }

    const input = value as Record<string, unknown>;

    for (const key of Object.keys(input)) {
      if ((FORBIDDEN_REVIEW_INPUT_FIELDS as readonly string[]).includes(key)) {
        errors.push(`검토 요청에 올 수 없는 항목입니다: ${key}`);
        continue;
      }
      if (!(REVIEW_WRITE_INPUT_FIELDS as readonly string[]).includes(key)) {
        errors.push(`검토 요청에 없는 항목입니다: ${key}`);
      }
    }
    for (const key of REVIEW_WRITE_INPUT_FIELDS) {
      if (!(key in input)) errors.push(`빠진 항목입니다: ${key}`);
    }

    if (typeof input.candidateHash !== 'string' || !CANDIDATE_HASH_FORMAT.test(input.candidateHash)) {
      errors.push('검토할 글의 지문 모양이 맞지 않습니다.');
    }

    if (
      typeof input.decision !== 'string' ||
      !(REVIEW_DECISIONS as readonly string[]).includes(input.decision)
    ) {
      errors.push('결정이 승인도 반려도 아닙니다.');
    }

    const checklist = input.checklist;
    if (typeof checklist !== 'object' || checklist === null || Array.isArray(checklist)) {
      errors.push('확인 항목이 없습니다.');
    } else {
      const list = checklist as Record<string, unknown>;
      for (const key of Object.keys(list)) {
        if (!(REVIEW_CHECKS as readonly string[]).includes(key)) {
          errors.push(`확인 항목에 없는 이름입니다: ${key}`);
        }
      }
      for (const check of REVIEW_CHECKS) {
        if (typeof list[check] !== 'boolean') errors.push(`확인하지 않은 항목입니다: ${check}`);
      }
    }

    const reasons = input.rejectionReasons;
    if (!Array.isArray(reasons)) {
      errors.push('반려 이유가 목록이 아닙니다.');
    } else {
      for (const reason of reasons) {
        if (
          typeof reason !== 'string' ||
          !(REJECTION_REASONS as readonly string[]).includes(reason)
        ) {
          errors.push('정해진 반려 이유가 아닙니다.');
          break;
        }
      }
    }

    if (errors.length > 0) return { valid: false, errors };

    if (input.decision === 'approve') {
      const list = checklist as ReviewChecklist;
      for (const check of REVIEW_CHECKS) {
        if (list[check] !== true) errors.push(`확인되지 않은 항목이 있어 승인할 수 없습니다: ${check}`);
      }
      if ((reasons as unknown[]).length > 0) {
        errors.push('승인인데 반려 이유가 적혀 있습니다.');
      }
    }

    if (input.decision === 'reject' && (reasons as unknown[]).length === 0) {
      errors.push('반려하려면 이유가 있어야 합니다.');
    }

    return { valid: errors.length === 0, errors };
  } catch {
    return { valid: false, errors: ['검토 요청을 확인하지 못했습니다.'] };
  }
}

/* ------------------------------------------------------------------ */
/* 같은 요청이 두 번 왔을 때                                            */
/* ------------------------------------------------------------------ */

const sameStringList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((item, index) => item === b[index]);

/**
 * 이미 적힌 검토와 지금 온 요청이 정말 같은 것인지 본다.
 *
 * 그물이 끊겨 같은 사람이 같은 결정을 다시 보내는 일은 흔하다.
 * 그때는 새로 적지 않고 원래 기록을 돌려주면 된다.
 *
 * 그러나 "같다"의 기준에 검토자까지 넣는다.
 * 다른 사람이 우연히 똑같은 내용을 보냈다고 해서
 * 앞사람의 검토를 자기 것으로 성공 처리하면 안 된다.
 * 그 순간 누가 판단했는지가 흐려진다.
 */
export function isExactReviewRetry(
  existing: { reviewerUserId: string; review: PublishedContentReview },
  incoming: { reviewerUserId: string; input: ReviewWriteInput },
): boolean {
  if (existing.reviewerUserId !== incoming.reviewerUserId) return false;
  if (existing.review.candidateHash !== incoming.input.candidateHash) return false;
  if (existing.review.decision !== incoming.input.decision) return false;

  for (const check of REVIEW_CHECKS) {
    if (existing.review.checklist[check] !== incoming.input.checklist[check]) return false;
  }

  return sameStringList(existing.review.rejectionReasons, incoming.input.rejectionReasons);
}

/* ------------------------------------------------------------------ */
/* 승인된 글                                                            */
/* ------------------------------------------------------------------ */

/**
 * 적힌 게시 콘텐츠 한 줄.
 *
 * 글의 지문이 곧 이 줄의 이름이다. 같은 글이 두 번 게시되지 않는다.
 * 진행 상태 칸을 두지 않는다. 줄이 있다는 것이 곧 승인됐다는 뜻이다.
 * 검토자 번호를 여기 넣지 않는다. 그것은 검토 기록의 것이다.
 */
export type PublishedContentRow = {
  candidateHash: string;
  content: PublishedContent;
  /** 표가 붙인다. */
  createdAt: string;
};

/* ------------------------------------------------------------------ */
/* 앞으로 만들 표와 함수가 지켜야 할 약속                                */
/* ------------------------------------------------------------------ */

/**
 * 아래는 아직 구현이 아니다.
 *
 * 지금 이 값들이 참이라고 해서 DB가 그렇게 되어 있다는 뜻이 아니다.
 * 표도 함수도 아직 없다.
 *
 * 이것은 다음 단계에서 만들 migration이 따라야 할 약속이고,
 * 그때 이 값들과 실제 SQL이 맞는지 대조하기 위해 먼저 적어 두는 것이다.
 */
export const FUTURE_WRITE_BOUNDARY = {
  /** 글을 적어 두는 일은 서버가 해도 된다. 아직 승인이 아니기 때문이다. */
  candidateStoreExecute: 'service_role',

  /** 승인은 로그인한 사람만 부를 수 있다. */
  reviewExecute: 'authenticated',

  /** 서버 열쇠로는 승인할 수 없다. 이것이 이 설계의 중심이다. */
  reviewServiceRoleExecute: false,

  /** 로그인하지 않은 쪽은 부를 수 없다. */
  reviewAnonExecute: false,

  /** 검토자 번호는 요청에서 받지 않고 인증 문맥에서 읽는다. */
  reviewIdentitySource: 'auth.uid()',

  /** 로그인했다는 것만으로는 부족하다. 명단에 있고 켜져 있어야 한다. */
  reviewerAllowlistRequired: true,

  /** 표를 직접 열지 않는다. 어느 역할에도 직접 쓰기 권한을 주지 않는다. */
  directTableWrites: false,

  /** 한 글에 최종 결정은 하나뿐이다. */
  oneFinalReviewPerCandidateHash: true,

  /** 같은 사람이 같은 결정을 다시 보낸 경우에만 다시 적지 않는다. */
  exactRetryOnly: true,

  /** 반려된 글을 나중에 승인으로 바꾸지 않는다. 고치려면 새 글이다. */
  rejectCanBecomeApprove: false,

  /** 승인과 게시를 같은 묶음에서 끝낸다. */
  approveMaterializesPublishedAtomically: true,

  /** 게시만 따로 하는 함수를 두지 않는다. */
  separatePublishRpc: false,

  /** 게시할 글은 이미 적혀 있는 것에서 가져온다. 승인 요청에서 받지 않는다. */
  publishedContentSource: 'stored_candidate',

  /** 검토자 명단만 켜고 끌 수 있다. 나머지 셋은 고치지 않는다. */
  mutableObjects: [PUBLISHED_CONTENT_TABLES.reviewer],

  /** 한 번 적으면 고치지도 지우지도 않는다. */
  immutableObjects: [
    PUBLISHED_CONTENT_TABLES.candidate,
    PUBLISHED_CONTENT_TABLES.review,
    PUBLISHED_CONTENT_TABLES.published,
  ],

  /** 글은 실제로 남아 있는 연구 결과에만 붙을 수 있다. */
  candidateResearchForeignKey: 'private.research_result(result_hash)',

  /** 밖에 적은 연구 지문과 글 안의 것이 어긋난 상태를 표가 허용하지 않는다. */
  researchHashEqualityConstraint: true,
} as const;

/**
 * 왜 게시만 따로 하는 함수를 두지 않는가.
 *
 * 승인은 로그인한 검토자의 권한이다.
 * 그런데 게시를 나중에 서버 열쇠로 하는 함수로 떼어 두면 두 가지가 생긴다.
 *
 *   하나. 자동화가 그 함수만 불러 승인 경계를 돌아갈 수 있다.
 *   둘. 승인은 됐는데 게시가 안 된 어중간한 상태가 생긴다.
 *
 * 그래서 승인이 성립하는 그 묶음 안에서 게시까지 끝낸다.
 * 게시에 실패하면 승인 기록도 함께 없던 일이 된다.
 * "승인은 됐는데 글이 없다"는 상태를 아예 만들지 않는다.
 */
export const SINGLE_BOUNDARY_REASON =
  '승인과 게시를 나누면 자동화가 승인을 건너뛰거나, 승인만 있고 글이 없는 상태가 생긴다.';

/**
 * 검토자가 글을 읽는 길에 대해.
 *
 * 사람이 판단하려면 글과 연구를 읽을 수 있어야 한다.
 * 그러나 이번 단계는 쓰기 경계만 정한다. 읽기 길은 만들지 않았다.
 *
 * 앞으로 관리 화면을 만들 때 지켜야 할 것 하나를 적어 둔다.
 *   서버 열쇠를 화면 쪽에 두지 않는다.
 *   읽는 길도 같은 검토자 명단을 쓰는 별도 경계로 만든다.
 */
export const REVIEWER_READ_BOUNDARY_NOTE =
  '읽기 길은 다음 단계에서 만든다. 관리 화면에 service_role을 두지 않고, 같은 검토자 명단을 쓰는 별도 경계로 만든다.';
