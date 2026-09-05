/**
 * 게시 콘텐츠 계약 — 무엇을 사람이 검토하고, 무엇이 승인된 글이 되는가
 *
 * 왜 필요한가
 *   연구 결과는 이제 영구히 남는다. 하지만 그것은 연구자를 위한 재료다.
 *   사용자가 읽을 글이 아니다.
 *
 *   연구 결과에는 "아직 확실하지 않다"는 정보가 함께 들어 있다.
 *   남은 질문, 오용 위험, 확신 정도 같은 것들이다.
 *   그것을 떼어 내고 본문만 뽑아 화면에 올리면,
 *   앱은 불확실한 것을 확실한 것처럼 말하게 된다.
 *
 *   그래서 사이에 사람이 선다.
 *
 *     연구 결과 → 검토 대상 → 사람의 승인 → 게시 콘텐츠
 *
 *   이 파일은 그 경계를 코드로 고정한다.
 *
 * 이 계약이 막는 것
 *   연구 결과 하나만 가지고 게시 콘텐츠를 만드는 길은 없다.
 *   그런 함수를 두지 않았다. 사람의 승인 기록이 없으면 만들 수 없다.
 *
 *   승인한 뒤에 글을 고치면 이전 승인은 쓸 수 없다.
 *   글 전체의 지문이 달라지고, 승인은 그 지문에 묶여 있기 때문이다.
 *
 * 이 계약이 막지 못하는 것 — 분명히 적어 둔다
 *   reviewAuthority에 'human'이라고 적혀 있다는 것이
 *   실제로 사람이 눌렀다는 증거는 아니다. 그것은 글자 하나일 뿐이다.
 *
 *   이 계약이 보장하는 것은 여기까지다.
 *     "게시 콘텐츠를 만들려면 사람 권한의 검토 기록이 반드시 있어야 한다."
 *
 *   그 기록을 사람만 만들 수 있게 하는 일은
 *   저장 계층의 쓰기 권한과 관리자 인증이 맡는다. 여기서 하지 않는다.
 *
 * 이 계약이 하지 않는 일
 *   글을 대신 써 주지 않는다. 설명도, 기도 방향도, 태그도 만들지 않는다.
 *   "어떤 모양을 검토하고 승인할 것인가"만 정한다.
 *
 *   Scripture Card 번호를 붙이지 않는다. 아직 카드가 아니다.
 *   표를 만들지 않고, 저장하지 않고, 바깥을 부르지 않는다.
 */

import { computeResearchResultHash } from './research-result-store-contract.ts';
import type { BiblicalResearchResult } from './biblical-researcher.ts';
import type { PassageRef } from './scripture-cards.ts';
import { RESEARCHABLE_DOMAINS } from './research-prioritizer-contract.ts';

/* ------------------------------------------------------------------ */
/* 크기 한도                                                            */
/* ------------------------------------------------------------------ */

/**
 * 한도는 지어내지 않고 지금 카드 10개에서 재어 정했다.
 *
 * 실제 값(2026-09-05 기준):
 *   상황 태그   3~5개, 가장 긴 것 16자
 *   감정 태그   3~4개, 가장 긴 것 4자
 *   신앙 질문   2~3개, 가장 긴 것 9자
 *   기도 방식   1~3개, 가장 긴 것 2자
 *   목회 역할   2~3개, 가장 긴 것 5자
 *   오용 방지   1~3개, 가장 긴 것 46자
 *   설명 글들   56~124자
 *
 * 한도는 그보다 넉넉하게 둔다.
 * 좁게 잡으면 새 영역의 카드가 들어올 자리가 없어진다.
 * 이 숫자들이 막으려는 것은 "긴 글"이 아니라
 * 연구 결과 전체를 그대로 붙여 넣는 것 같은 명백한 사고다.
 */
export const TAG_LIST_MAX = 8;
export const TAG_TEXT_MAX = 40;
export const MISUSE_GUARD_LIST_MAX = 6;
export const MISUSE_GUARD_TEXT_MAX = 200;
export const REFERENCE_LABEL_MAX = 60;
export const PROSE_MAX = 600;

/* ------------------------------------------------------------------ */
/* 검토 대상                                                            */
/* ------------------------------------------------------------------ */

/** 사용자가 읽게 될 글이 들어가는 자리. */
export const CANDIDATE_PROSE_FIELDS = [
  'contextSummary',
  'theologicalInsight',
  'userExplanation',
  'prayerDirection',
] as const;

/** 태그 목록이 들어가는 자리. */
export const CANDIDATE_TAG_FIELDS = [
  'situationTags',
  'emotionTags',
  'spiritualQuestionTags',
  'prayerModes',
  'pastoralFunction',
] as const;

/** 검토 대상 한 건이 가질 수 있는 항목. 이것 말고는 받지 않는다. */
export const CANDIDATE_FIELDS = [
  'researchResultHash',
  'targetDomain',
  'passage',
  'additionalPassages',
  'referenceLabel',
  ...CANDIDATE_TAG_FIELDS,
  ...CANDIDATE_PROSE_FIELDS,
  'misuseGuards',
] as const;

/**
 * 사람이 읽고 판단할 한 건.
 *
 * 아직 Scripture Card가 아니다. 번호가 없다.
 * 연구 결과로 돌아갈 실마리는 지문 하나뿐이다.
 * 자료 목록과 근거 문장은 여기 오지 않는다. 필요하면 연구 보관소에서 찾는다.
 */
export type PublishedContentCandidate = {
  /** 어느 연구에서 나왔는지. computeResearchResultHash가 만든 값이다. */
  researchResultHash: string;
  /** 연구가 다룬 영역. 새로 지어낼 수 없다. */
  targetDomain: string;

  /** 연구가 후보로 올린 본문 중 하나. 여기서 새 본문을 고를 수 없다. */
  passage: PassageRef;
  /** 여러 장에 걸친 본문일 때만. 없으면 빈 배열. */
  additionalPassages: PassageRef[];

  referenceLabel: string;
  situationTags: string[];
  emotionTags: string[];
  spiritualQuestionTags: string[];
  prayerModes: string[];
  pastoralFunction: string[];
  contextSummary: string;
  theologicalInsight: string;
  userExplanation: string;
  prayerDirection: string;
  misuseGuards: string[];
};

/**
 * 이 계층에 절대 오면 안 되는 이름들.
 *
 * 앞쪽은 사람의 이야기와 자격이다. 이 경로에 올 일이 없다.
 * 가운데는 자료와 근거다. 그것의 주인은 연구 보관소다. 여기 베껴 두면 주인이 둘이 된다.
 * 뒤쪽은 일의 진행 상태다. 그것은 저장 계층의 몫이지 글의 일부가 아니다.
 *
 * 깊이 숨겨 넣어도 걸리도록 전체를 훑는다.
 */
export const FORBIDDEN_CANDIDATE_FIELDS = [
  'situation',
  'rawSituation',
  'prayer',
  'prayerDraft',
  'userId',
  'user_id',
  'uid',
  'sessionId',
  'deviceId',
  'jwt',
  'token',
  'apiKey',
  'source',
  'sources',
  'sourceId',
  'sourceIds',
  'evidenceId',
  'evidenceIds',
  'url',
  'rawResponse',
  'status',
  'reviewedAt',
  'publishedAt',
  'reviewerId',
  'scriptureCardId',
  'cardId',
] as const;

/* ------------------------------------------------------------------ */
/* 지문                                                                 */
/* ------------------------------------------------------------------ */

/** 지문 계산 방식의 판본. 방식이 바뀌면 이 값도 바뀐다. */
export const CANDIDATE_HASH_VERSION = 'v1|published-content-candidate';

export const CANDIDATE_HASH_FORMAT = /^pcand_[0-9a-f]{64}$/;

/**
 * 항목 순서에 흔들리지 않게 정렬해서 글자로 만든다.
 *
 * 배열은 정렬하지 않는다. 글에서는 차례가 뜻을 가진다.
 * 오용 방지 문구의 순서가 바뀌면 다른 글이다.
 *
 * 연구 보관소 계약에도 같은 모양의 함수가 있다.
 * 그쪽은 밖으로 내보내지 않고, 이번 단계에서 그 파일을 고치지 않기로 했으므로
 * 여기에 같은 규칙을 한 벌 더 둔다. 규칙이 갈라지면 지문도 갈라진다는 점을 적어 둔다.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
}

/**
 * 검토 대상 한 건의 지문.
 *
 * 이 값이 하는 일은 하나다.
 *   "사람이 본 것이 정확히 이 글이었는가"를 묶어 둔다.
 *
 * 승인한 뒤에 한 글자라도 고치면 이 값이 달라진다.
 * 그러면 이전 승인은 그 글에 붙지 않는다.
 * 조용히 문구를 바꿔 놓고 예전 승인을 재사용하는 일을 막는다.
 *
 * 앞머리를 다른 지문들과 다르게 둔다.
 *   snap_   우선순위 판단 시점
 *   evset_  근거 꾸러미
 *   rres_   연구 결과
 *   pcand_  검토 대상 글      ← 이것
 */
export async function computePublishedContentCandidateHash(
  candidate: PublishedContentCandidate,
): Promise<string> {
  const bytes = new TextEncoder().encode(
    stableStringify([CANDIDATE_HASH_VERSION, candidate]),
  );
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');

  return `pcand_${hex}`;
}

/* ------------------------------------------------------------------ */
/* 사람의 검토                                                          */
/* ------------------------------------------------------------------ */

/**
 * 사람이 눈으로 확인해야 하는 것들.
 *
 * 승인하려면 일곱 개가 모두 참이어야 한다.
 * 하나라도 아니면 승인이 되지 않는다. "대체로 괜찮다"는 없다.
 */
export const REVIEW_CHECKS = [
  /** 이 글이 실제 연구와 그 본문에 이어져 있는가. */
  'researchTraceability',
  /** 본문의 원래 문맥을 비틀지 않았는가. */
  'canonicalContext',
  /** 신학적으로 받아들일 만한가. */
  'theologicalFaithfulness',
  /** 결과를 보장하거나, 진단하거나, 피해자를 몰아세우지 않는가. */
  'pastoralSafety',
  /** 잘못 쓰이지 않도록 하는 문구가 충분한가. */
  'misuseGuardsAdequate',
  /** 일반 사용자가 읽기에 분명하고 부풀려지지 않았는가. */
  'userFacingClarity',
  /** 영역과 태그가 실제 삶의 문제와 맞는가. */
  'taggingFit',
] as const;

export type ReviewCheck = (typeof REVIEW_CHECKS)[number];
export type ReviewChecklist = Record<ReviewCheck, boolean>;

/**
 * 검토할 수 있는 자격.
 *
 * 지금은 사람뿐이다. 모델이나 자동 절차가 들어올 자리를 만들지 않는다.
 * 자리를 만들어 두면 언젠가 그 자리로 들어온다.
 */
export const REVIEW_AUTHORITIES = ['human'] as const;
export type ReviewAuthority = (typeof REVIEW_AUTHORITIES)[number];

export const REVIEW_DECISIONS = ['approve', 'reject'] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

/**
 * 물리지 않은 이유.
 *
 * 자유롭게 적는 글이 아니라 정해진 것 중에서 고른다.
 * 그래야 나중에 무엇 때문에 물렸는지 세어 볼 수 있다.
 */
export const REJECTION_REASONS = [
  'insufficient_research_support',
  'passage_context_problem',
  'theological_problem',
  'pastoral_safety_problem',
  'misuse_guard_problem',
  'user_facing_copy_problem',
  'tagging_problem',
  'needs_more_research',
] as const;
export type RejectionReason = (typeof REJECTION_REASONS)[number];

export const REVIEW_FIELDS = [
  'candidateHash',
  'reviewAuthority',
  'decision',
  'checklist',
  'rejectionReasons',
] as const;

/**
 * 사람이 내린 결정 한 건.
 *
 * "아직 안 봤다"는 상태를 두지 않았다.
 * 글은 있는데 결정이 없으면 그것이 곧 아직 안 본 것이다.
 * 상태를 따로 두면 그 상태를 누가 언제 바꿨는지를 또 지켜야 한다.
 */
export type PublishedContentReview = {
  /** 무엇을 보고 결정했는지. 그 글의 지문이다. */
  candidateHash: string;
  reviewAuthority: ReviewAuthority;
  decision: ReviewDecision;
  checklist: ReviewChecklist;
  /** 물렸을 때만 채운다. 승인이면 비어 있어야 한다. */
  rejectionReasons: RejectionReason[];
};

/* ------------------------------------------------------------------ */
/* 승인된 글                                                            */
/* ------------------------------------------------------------------ */

/**
 * 사람이 승인한 글.
 *
 * 이 객체가 있다는 것 자체가 승인을 통과했다는 뜻이다.
 * 그래서 안에 '승인됨' 같은 상태 칸을 두지 않는다.
 * 두면 객체의 존재와 그 칸이 서로 어긋날 수 있고, 그때 어느 쪽이 진짜인지 알 수 없다.
 *
 * 검토 항목과 물린 이유는 여기 베껴 두지 않는다.
 * 그것은 검토 기록의 것이다. 글과 결정은 따로 둔다.
 *
 * 아직 Scripture Card가 아니다. 번호를 붙이지 않았다.
 * 카드로 만드는 일은 다음 단계의 몫이다.
 */
export type PublishedContent = {
  /** 사람이 본 그 글의 지문. */
  candidateHash: string;
  /** 그 글이 나온 연구의 지문. */
  researchResultHash: string;
  targetDomain: string;

  passage: PassageRef;
  additionalPassages: PassageRef[];

  referenceLabel: string;
  situationTags: string[];
  emotionTags: string[];
  spiritualQuestionTags: string[];
  prayerModes: string[];
  pastoralFunction: string[];
  contextSummary: string;
  theologicalInsight: string;
  userExplanation: string;
  prayerDirection: string;
  misuseGuards: string[];
};

/* ------------------------------------------------------------------ */
/* 검사                                                                 */
/* ------------------------------------------------------------------ */

export type PublishValidation = { valid: boolean; errors: string[] };

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isText = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max;

const isPassageRef = (value: unknown): value is PassageRef => {
  if (!isPlainObject(value)) return false;
  if (Object.keys(value).length !== 4) return false;
  return (
    typeof value.book === 'string' &&
    value.book.trim().length > 0 &&
    Number.isInteger(value.chapter) &&
    Number.isInteger(value.startVerse) &&
    Number.isInteger(value.endVerse)
  );
};

const samePassage = (a: PassageRef, b: PassageRef) =>
  a.book === b.book &&
  a.chapter === b.chapter &&
  a.startVerse === b.startVerse &&
  a.endVerse === b.endVerse;

const samePassageList = (a: readonly PassageRef[], b: readonly PassageRef[]) =>
  a.length === b.length && a.every((item, index) => samePassage(item, b[index] as PassageRef));

/**
 * 태그 목록 하나를 본다.
 *
 * 지금 카드에 있는 태그만 쓰라고 하지 않는다. 일부러 그렇게 하지 않았다.
 *
 * 이 앱의 태그 사전은 따로 손으로 적는 것이 아니라
 * 지금 있는 카드 10개에서 자동으로 모은 것이다.
 * 그러니 "사전에 있는 값만 써라"라고 하면,
 * 새 영역의 카드는 기존 카드의 태그만으로 자기를 설명해야 한다.
 * 새 영역이라서 만드는 카드인데 새 말은 못 쓰는 셈이 된다.
 *
 * 그래서 새 태그를 허용하되, 그 판단을 사람에게 맡긴다(taggingFit).
 * 여기서 보는 것은 모양뿐이다. 비지 않았는가, 겹치지 않는가, 너무 많거나 길지 않은가.
 */
function checkTagList(value: unknown, label: string, errors: string[]): void {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`${label}이(가) 비어 있습니다.`);
    return;
  }
  if (value.length > TAG_LIST_MAX) {
    errors.push(`${label}이(가) 너무 많습니다.`);
  }
  for (const item of value) {
    if (!isText(item, TAG_TEXT_MAX)) {
      errors.push(`${label}에 쓸 수 없는 값이 있습니다.`);
      return;
    }
  }
  if (new Set(value as string[]).size !== value.length) {
    errors.push(`${label}에 같은 값이 두 번 있습니다.`);
  }
}

/** 어느 깊이에 숨겨 넣어도 걸리도록 전체를 훑는다. */
function findForbiddenField(value: unknown): string | null {
  const serialized = JSON.stringify(value) ?? '';
  for (const forbidden of FORBIDDEN_CANDIDATE_FIELDS) {
    if (serialized.includes(`"${forbidden}":`)) return forbidden;
  }
  return null;
}

/**
 * 검토 대상 한 건이 모양을 갖췄는지 본다.
 *
 * 여기서 보는 것은 글의 모양이지 내용의 옳고 그름이 아니다.
 * 신학적으로 맞는지, 목회적으로 안전한지는 사람이 본다.
 *
 * 어떤 이상한 값이 들어와도 예외를 던지지 않는다. 판단이 안 되면 막는다.
 */
export function validatePublishedContentCandidate(value: unknown): PublishValidation {
  const errors: string[] = [];

  try {
    if (!isPlainObject(value)) {
      return { valid: false, errors: ['검토 대상이 객체가 아닙니다.'] };
    }

    for (const key of Object.keys(value)) {
      if (!(CANDIDATE_FIELDS as readonly string[]).includes(key)) {
        errors.push(`검토 대상에 없는 항목입니다: ${key}`);
      }
    }
    for (const key of CANDIDATE_FIELDS) {
      if (!(key in value)) errors.push(`빠진 항목입니다: ${key}`);
    }

    const forbidden = findForbiddenField(value);
    if (forbidden !== null) {
      errors.push(`이 계층에 올 수 없는 항목입니다: ${forbidden}`);
    }

    if (typeof value.researchResultHash !== 'string' || value.researchResultHash.length === 0) {
      errors.push('연구 지문이 없습니다.');
    }

    // 영역 이름은 새로 지어낼 수 없다. 이미 정해진 것 중 하나여야 한다.
    if (
      typeof value.targetDomain !== 'string' ||
      !RESEARCHABLE_DOMAINS.includes(value.targetDomain)
    ) {
      errors.push('연구 대상 영역이 정해진 목록에 없습니다.');
    }

    if (!isPassageRef(value.passage)) errors.push('본문 위치가 올바르지 않습니다.');
    if (!Array.isArray(value.additionalPassages) || !value.additionalPassages.every(isPassageRef)) {
      errors.push('덧붙인 본문 위치가 올바르지 않습니다.');
    }

    if (!isText(value.referenceLabel, REFERENCE_LABEL_MAX)) {
      errors.push('본문 이름이 올바르지 않습니다.');
    }

    for (const field of CANDIDATE_TAG_FIELDS) {
      checkTagList(value[field], field, errors);
    }

    for (const field of CANDIDATE_PROSE_FIELDS) {
      if (!isText(value[field], PROSE_MAX)) errors.push(`${field}이(가) 올바르지 않습니다.`);
    }

    if (!Array.isArray(value.misuseGuards) || value.misuseGuards.length === 0) {
      errors.push('오용을 막는 문구가 없습니다.');
    } else {
      if (value.misuseGuards.length > MISUSE_GUARD_LIST_MAX) {
        errors.push('오용을 막는 문구가 너무 많습니다.');
      }
      for (const item of value.misuseGuards) {
        if (!isText(item, MISUSE_GUARD_TEXT_MAX)) {
          errors.push('오용을 막는 문구에 쓸 수 없는 값이 있습니다.');
          break;
        }
      }
    }

    return { valid: errors.length === 0, errors };
  } catch {
    return { valid: false, errors: ['검토 대상을 확인하지 못했습니다.'] };
  }
}

/**
 * 사람이 내린 결정 한 건이 모양을 갖췄는지 본다.
 *
 * 승인은 일곱 항목이 모두 참일 때만 성립한다.
 * 물렸다면 이유가 최소한 하나는 있어야 한다.
 */
export function validatePublishedContentReview(value: unknown): PublishValidation {
  const errors: string[] = [];

  try {
    if (!isPlainObject(value)) {
      return { valid: false, errors: ['검토 기록이 객체가 아닙니다.'] };
    }

    for (const key of Object.keys(value)) {
      if (!(REVIEW_FIELDS as readonly string[]).includes(key)) {
        errors.push(`검토 기록에 없는 항목입니다: ${key}`);
      }
    }
    for (const key of REVIEW_FIELDS) {
      if (!(key in value)) errors.push(`빠진 항목입니다: ${key}`);
    }

    if (typeof value.candidateHash !== 'string' || !CANDIDATE_HASH_FORMAT.test(value.candidateHash)) {
      errors.push('검토한 글의 지문 모양이 맞지 않습니다.');
    }

    // 사람만 검토할 수 있다. 모델이나 자동 절차가 들어올 자리를 두지 않는다.
    if (
      typeof value.reviewAuthority !== 'string' ||
      !(REVIEW_AUTHORITIES as readonly string[]).includes(value.reviewAuthority)
    ) {
      errors.push('사람이 검토한 기록이 아닙니다.');
    }

    if (
      typeof value.decision !== 'string' ||
      !(REVIEW_DECISIONS as readonly string[]).includes(value.decision)
    ) {
      errors.push('결정이 승인도 반려도 아닙니다.');
    }

    const checklist = value.checklist;
    if (!isPlainObject(checklist)) {
      errors.push('확인 항목이 없습니다.');
    } else {
      for (const key of Object.keys(checklist)) {
        if (!(REVIEW_CHECKS as readonly string[]).includes(key)) {
          errors.push(`확인 항목에 없는 이름입니다: ${key}`);
        }
      }
      for (const check of REVIEW_CHECKS) {
        if (typeof checklist[check] !== 'boolean') errors.push(`확인하지 않은 항목입니다: ${check}`);
      }
    }

    const reasons = value.rejectionReasons;
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

    if (value.decision === 'approve') {
      const list = checklist as ReviewChecklist;
      for (const check of REVIEW_CHECKS) {
        if (list[check] !== true) errors.push(`확인되지 않은 항목이 있어 승인할 수 없습니다: ${check}`);
      }
      if ((reasons as unknown[]).length > 0) {
        errors.push('승인인데 반려 이유가 적혀 있습니다.');
      }
    }

    if (value.decision === 'reject' && (reasons as unknown[]).length === 0) {
      errors.push('반려하려면 이유가 있어야 합니다.');
    }

    return { valid: errors.length === 0, errors };
  } catch {
    return { valid: false, errors: ['검토 기록을 확인하지 못했습니다.'] };
  }
}

/* ------------------------------------------------------------------ */
/* 게시                                                                 */
/* ------------------------------------------------------------------ */

export type PublishOutcome =
  | { ok: true; content: PublishedContent }
  | { ok: false; errors: string[] };

/**
 * 사람이 승인한 글을 게시 콘텐츠로 만든다.
 *
 * 이것이 게시 콘텐츠를 만드는 유일한 길이다.
 * 연구 결과만 받아 만드는 함수는 없다. 일부러 두지 않았다.
 *
 * 어긋나는 것이 하나라도 있으면 만들지 않는다.
 * 본문을 대신 고치지 않고, 영역을 바꾸지 않고, 지문을 다시 써서 맞추지 않고,
 * 태그를 지워서 통과시키지 않는다. 멈추고 알린다.
 *
 * 고칠 것이 있으면 사람이 글을 고치고 다시 검토받는다.
 * 다른 본문을 쓰고 싶으면 연구 단계로 돌아간다. 여기서 바꾸지 않는다.
 */
export async function publishReviewedContent(input: {
  candidate: unknown;
  researchResult: BiblicalResearchResult;
  review: unknown;
}): Promise<PublishOutcome> {
  try {
    const candidateCheck = validatePublishedContentCandidate(input.candidate);
    if (!candidateCheck.valid) return { ok: false, errors: candidateCheck.errors };

    const reviewCheck = validatePublishedContentReview(input.review);
    if (!reviewCheck.valid) return { ok: false, errors: reviewCheck.errors };

    const candidate = input.candidate as PublishedContentCandidate;
    const review = input.review as PublishedContentReview;
    const errors: string[] = [];

    // 승인이 아니면 여기서 끝이다.
    if (review.decision !== 'approve') {
      return { ok: false, errors: ['승인된 글이 아닙니다.'] };
    }

    // 어느 연구에서 나왔는지. 지문은 연구 보관소 계약이 계산한다. 여기서 만들지 않는다.
    const expectedResearchHash = await computeResearchResultHash(input.researchResult);
    if (candidate.researchResultHash !== expectedResearchHash) {
      errors.push('이 글이 가리키는 연구가 실제 연구와 다릅니다.');
    }

    if (candidate.targetDomain !== input.researchResult.targetDomain) {
      errors.push('연구가 다룬 영역과 글의 영역이 다릅니다.');
    }

    // 연구가 후보로 올리지 않은 본문을 편집 단계에서 끼워 넣을 수 없다.
    const matched = input.researchResult.candidatePassages.find(
      (entry) =>
        samePassage(entry.reference, candidate.passage) &&
        samePassageList(entry.additionalReferences, candidate.additionalPassages),
    );
    if (!matched) {
      errors.push('연구가 후보로 올린 본문이 아닙니다.');
    }

    // 사람이 본 것이 정확히 이 글이었는지.
    const candidateHash = await computePublishedContentCandidateHash(candidate);
    if (review.candidateHash !== candidateHash) {
      errors.push('사람이 검토한 글과 지금 글이 다릅니다.');
    }

    if (errors.length > 0) return { ok: false, errors };

    return {
      ok: true,
      content: {
        candidateHash,
        researchResultHash: candidate.researchResultHash,
        targetDomain: candidate.targetDomain,
        passage: candidate.passage,
        additionalPassages: candidate.additionalPassages,
        referenceLabel: candidate.referenceLabel,
        situationTags: candidate.situationTags,
        emotionTags: candidate.emotionTags,
        spiritualQuestionTags: candidate.spiritualQuestionTags,
        prayerModes: candidate.prayerModes,
        pastoralFunction: candidate.pastoralFunction,
        contextSummary: candidate.contextSummary,
        theologicalInsight: candidate.theologicalInsight,
        userExplanation: candidate.userExplanation,
        prayerDirection: candidate.prayerDirection,
        misuseGuards: candidate.misuseGuards,
      },
    };
  } catch {
    return { ok: false, errors: ['게시할 수 있는지 확인하지 못했습니다.'] };
  }
}
