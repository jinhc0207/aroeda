/**
 * 연구 결과와 모델이 쓴 초안을 합쳐 검토 대상 글 한 건을 만든다.
 *
 * 여기서 모델을 부르지 않는다. 표도 열지 않는다.
 * 이미 받아 둔 값 둘을 합치고, 합친 것이 계약에 맞는지 보고, 지문을 붙인다. 그것뿐이다.
 *
 * 왜 모델 호출과 조립을 나누는가.
 *
 * 글의 열다섯 항목 중 다섯은 모델이 정하면 안 되는 것들이다.
 *   어느 연구에서 나왔는지, 어느 영역인지, 어느 본문인지,
 *   덧붙인 본문이 무엇인지, 그 본문의 이름이 무엇인지.
 *
 * 이것들을 모델에게 물으면, 모델이 연구가 고르지 않은 본문을 끼워 넣거나
 * 시편을 보면서 창세기라고 적을 수 있다. 그런 글도 모양은 멀쩡해 보인다.
 *
 * 그래서 모델에게는 "몇 번째 본문인가"만 묻고, 나머지 넷은 여기서 계산한다.
 * 본문 이름은 성경 데이터에서 만든다. 모델이 지어내지 않는다.
 *
 * 모델이 그 다섯을 함께 보내오면 무시하지 않고 거절한다.
 * 조용히 지워 두면, 모델이 그것을 정할 수 있다고 착각한 채로 오래 남는다.
 */

import {
  CANDIDATE_PROSE_FIELDS,
  CANDIDATE_TAG_FIELDS,
  type PublishValidation,
  type PublishedContentCandidate,
  computePublishedContentCandidateHash,
  validatePublishedContentCandidate,
} from './published-content-contract.ts';
import {
  RESEARCH_RESULT_HASH_FORMAT,
  computeResearchResultHash,
} from './research-result-store-contract.ts';
import { formatKoreanBibleReferenceSequence } from './bible-reference-label.ts';
import type { BiblicalResearchResult } from './biblical-researcher.ts';

/* ------------------------------------------------------------------ */
/* 1. 모델이 정하는 것과 정하지 않는 것                                 */
/* ------------------------------------------------------------------ */

/**
 * 모델이 보내는 초안의 항목. 정확히 열한 개다.
 *
 * 글의 항목이 열다섯인 것과 헷갈리지 않아야 한다.
 * 여기 없는 다섯은 모델의 몫이 아니다.
 *
 * 맨 앞 하나는 글이 아니라 선택이다.
 * 연구가 올린 본문 후보 중 몇 번째를 쓸 것인가.
 */
export const CANDIDATE_DRAFT_FIELDS = [
  'selectedPassageIndex',
  ...CANDIDATE_TAG_FIELDS,
  ...CANDIDATE_PROSE_FIELDS,
  'misuseGuards',
] as const;

/**
 * 모델이 보내면 거절하는 이름들.
 *
 * 이 다섯에 지문 하나를 더한다.
 * 지문은 글이 다 만들어진 뒤에 계산되는 값이라, 미리 받을 수 있는 것이 아니다.
 */
export const AUTHORITATIVE_CANDIDATE_FIELDS = [
  'researchResultHash',
  'targetDomain',
  'passage',
  'additionalPassages',
  'referenceLabel',
  'candidateHash',
] as const;

/** 모델이 보내는 초안. 오래 남기지 않는다. 글이 만들어지면 역할이 끝난다. */
export type CandidateGenerationDraft = {
  /** 연구가 올린 본문 후보 중 몇 번째인가. 본문 좌표를 직접 적지 않는다. */
  selectedPassageIndex: number;

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

/** 조립에 필요한, 이미 저장된 값. */
export type CandidateBuildInput = {
  /** 연구 보관소가 준 지문. 여기서 다시 계산하지 않는다. */
  researchResultHash: string;
  researchResult: BiblicalResearchResult;
  draft: unknown;
};

/* ------------------------------------------------------------------ */
/* 2. 멈추는 이유                                                       */
/* ------------------------------------------------------------------ */

/**
 * 멈춘 자리를 기계가 구분할 수 있게 둔다.
 *
 * 이 값은 서버 안에서만 쓴다. 사용자에게 보여주는 문구가 아니다.
 */
export const CANDIDATE_BUILDER_ERROR_CODES = [
  'INVALID_RESEARCH_INPUT',
  'RESEARCH_RESULT_HASH_MISMATCH',
  'INVALID_MODEL_DRAFT',
  'SELECTED_PASSAGE_OUT_OF_RANGE',
  'REFERENCE_LABEL_UNFORMATTABLE',
  'CANDIDATE_VALIDATION_FAILED',
  'CANDIDATE_HASH_FAILED',
] as const;

export type CandidateBuilderErrorCode = (typeof CANDIDATE_BUILDER_ERROR_CODES)[number];

/**
 * 만들었거나, 못 만들었거나.
 *
 * 어중간하게 반쯤 만든 글을 돌려주지 않는다.
 * 모양은 앞 계약의 PublishOutcome 과 같게 두고, 멈춘 자리만 code 로 더 알린다.
 */
export type CandidateBuildOutcome =
  | { ok: true; candidate: PublishedContentCandidate; candidateHash: string }
  | { ok: false; code: CandidateBuilderErrorCode; errors: string[] };

const fail = (code: CandidateBuilderErrorCode, errors: string[]): CandidateBuildOutcome => ({
  ok: false,
  code,
  errors,
});

/* ------------------------------------------------------------------ */
/* 3. 초안이 받을 수 있는 모양인가                                      */
/* ------------------------------------------------------------------ */

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

/**
 * 모델이 보낸 초안을 본다.
 *
 * 여기서 보는 것은 모양뿐이다.
 * 문구가 너무 긴지, 태그가 겹치는지 같은 것은 앞 계약의 검사기가 본다.
 * 같은 규칙을 두 벌 만들면 언젠가 서로 달라진다.
 *
 * 고를 수 있는 번호인지도 여기서 보지 않는다.
 * 연구 결과를 봐야 알 수 있는 일이라, 조립하는 쪽에서 본다.
 */
export function validateCandidateGenerationDraft(value: unknown): PublishValidation {
  const errors: string[] = [];

  try {
    if (!isPlainObject(value)) {
      return { valid: false, errors: ['초안이 객체가 아닙니다.'] };
    }

    for (const key of Object.keys(value)) {
      if ((AUTHORITATIVE_CANDIDATE_FIELDS as readonly string[]).includes(key)) {
        // 조용히 지우지 않는다. 지우면 모델이 정할 수 있다고 착각한 채로 남는다.
        errors.push(`모델이 정할 수 없는 항목입니다: ${key}`);
        continue;
      }
      if (!(CANDIDATE_DRAFT_FIELDS as readonly string[]).includes(key)) {
        errors.push(`초안에 없는 항목입니다: ${key}`);
      }
    }
    for (const key of CANDIDATE_DRAFT_FIELDS) {
      if (!(key in value)) errors.push(`빠진 항목입니다: ${key}`);
    }

    // 몇 번째인가. 소수도, 음수도, 글자도 아니어야 한다.
    if (!Number.isSafeInteger(value.selectedPassageIndex)) {
      errors.push('고른 본문 번호가 정수가 아닙니다.');
    } else if ((value.selectedPassageIndex as number) < 0) {
      errors.push('고른 본문 번호가 0보다 작습니다.');
    }

    for (const field of CANDIDATE_TAG_FIELDS) {
      if (!isStringArray(value[field])) errors.push(`${field}이(가) 글자 목록이 아닙니다.`);
    }

    for (const field of CANDIDATE_PROSE_FIELDS) {
      if (typeof value[field] !== 'string') errors.push(`${field}이(가) 글이 아닙니다.`);
    }

    if (!isStringArray(value.misuseGuards)) {
      errors.push('오용을 막는 문구가 글자 목록이 아닙니다.');
    }

    return { valid: errors.length === 0, errors };
  } catch {
    return { valid: false, errors: ['초안을 확인하지 못했습니다.'] };
  }
}

/* ------------------------------------------------------------------ */
/* 4. 조립                                                              */
/* ------------------------------------------------------------------ */

/**
 * 검토 대상 글 한 건을 만든다.
 *
 * 순서를 지킨다.
 *   ① 저장된 값이 쓸 수 있는 것인가
 *   ② 초안이 받을 수 있는 모양인가
 *   ③ 고른 번호가 실제로 있는가
 *   ④ 그 번호의 본문을 꺼낸다
 *   ⑤ 본문 이름을 성경 데이터로 만든다
 *   ⑥ 열다섯 항목을 합친다
 *   ⑦ 앞 계약의 검사기가 본다
 *   ⑧ 지문을 붙인다
 *
 * 어느 자리에서든 어긋나면 만들지 않는다.
 * 값을 고쳐서 통과시키지 않고, 빠진 것을 채워 넣지 않는다. 멈추고 알린다.
 *
 * 받은 값을 고치지 않는다. 연구 결과도 초안도 들어온 그대로 남는다.
 */
export async function buildPublishedContentCandidate(
  input: CandidateBuildInput,
): Promise<CandidateBuildOutcome> {
  try {
    // ① 저장된 값.
    if (!isPlainObject(input)) {
      return fail('INVALID_RESEARCH_INPUT', ['조립할 값이 객체가 아닙니다.']);
    }

    const { researchResultHash, researchResult } = input;

    if (
      typeof researchResultHash !== 'string' ||
      !RESEARCH_RESULT_HASH_FORMAT.test(researchResultHash)
    ) {
      return fail('INVALID_RESEARCH_INPUT', ['연구 지문의 모양이 맞지 않습니다.']);
    }

    if (!isPlainObject(researchResult)) {
      return fail('INVALID_RESEARCH_INPUT', ['연구 결과가 객체가 아닙니다.']);
    }

    if (typeof researchResult.targetDomain !== 'string') {
      return fail('INVALID_RESEARCH_INPUT', ['연구가 다룬 영역이 없습니다.']);
    }

    const passages = researchResult.candidatePassages;
    if (!Array.isArray(passages) || passages.length === 0) {
      return fail('INVALID_RESEARCH_INPUT', ['연구가 올린 본문 후보가 없습니다.']);
    }

    // ①-b 넘겨받은 지문이 정말 이 연구의 지문인가.
    //
    // 모양만 보는 것으로는 부족하다. rres_ 로 시작하는 64자리면 무엇이든 통과한다.
    // 그러면 A 연구의 지문을 붙인 B 연구의 글이 만들어질 수 있다.
    //
    // 그런 글도 겉보기에는 멀쩡하다. 그래서 사람이 검토할 때
    // "연구까지 되짚을 수 있는가"를 엉뚱한 연구를 보며 판단하게 된다.
    //
    // 지문은 부르는 쪽이 붙이는 꼬리표가 아니라 그 연구 자체의 신원이다.
    // 그러니 여기서 다시 계산해서 맞춰 본다. 계산 방식의 주인은 연구 보관소 계약이다.
    let canonicalResearchResultHash: string;
    try {
      canonicalResearchResultHash = await computeResearchResultHash(
        researchResult as unknown as BiblicalResearchResult,
      );
    } catch {
      return fail('INVALID_RESEARCH_INPUT', ['연구 결과의 지문을 계산하지 못했습니다.']);
    }

    // 어긋나면 여기서 끝이다.
    //
    // 계산한 값으로 조용히 바꿔 끼우지 않는다.
    // 그렇게 하면 잘못된 값을 보낸 쪽은 자기가 틀린 줄 모른 채로 계속 그렇게 보낸다.
    if (canonicalResearchResultHash !== researchResultHash) {
      return fail('RESEARCH_RESULT_HASH_MISMATCH', [
        'researchResultHash가 researchResult와 일치하지 않습니다.',
      ]);
    }

    // ② 초안.
    const draftCheck = validateCandidateGenerationDraft(input.draft);
    if (!draftCheck.valid) return fail('INVALID_MODEL_DRAFT', draftCheck.errors);

    const draft = input.draft as CandidateGenerationDraft;

    // ③ 고른 번호가 실제로 있는가. 연구 결과를 봐야 알 수 있는 일이라 여기서 본다.
    if (draft.selectedPassageIndex >= passages.length) {
      return fail('SELECTED_PASSAGE_OUT_OF_RANGE', ['연구가 올리지 않은 본문 번호입니다.']);
    }

    // ④ 그 번호의 본문. 모델이 보낸 좌표가 아니라 연구가 적어 둔 좌표다.
    const selected = passages[draft.selectedPassageIndex];
    if (!isPlainObject(selected)) {
      return fail('INVALID_RESEARCH_INPUT', ['고른 본문 후보가 올바르지 않습니다.']);
    }

    const passage = selected.reference;
    const additionalPassages = selected.additionalReferences;

    if (!Array.isArray(additionalPassages)) {
      return fail('INVALID_RESEARCH_INPUT', ['덧붙인 본문 위치가 목록이 아닙니다.']);
    }

    // ⑤ 본문 이름. 성경 데이터에서 만든다. 모델에게 물어볼 자리가 없다.
    //
    // 만들지 못하면 거기서 멈춘다. 모델에게 대신 지어 달라고 하지 않는다.
    // 그렇게 하면 본문과 이름이 어긋난 글이 생길 수 있고,
    // 지금 계약은 그 어긋남을 검사하지 않는다.
    const referenceLabel = formatKoreanBibleReferenceSequence(passage, additionalPassages);
    if (referenceLabel === null) {
      return fail('REFERENCE_LABEL_UNFORMATTABLE', ['본문 이름을 만들지 못했습니다.']);
    }

    // ⑥ 열다섯 항목. 앞의 다섯은 여기서 정하고, 뒤의 열은 초안에서 온다.
    //
    // 고른 번호는 담지 않는다. 그것은 만드는 동안만 필요한 값이다.
    const candidate: PublishedContentCandidate = {
      researchResultHash,
      targetDomain: researchResult.targetDomain,
      passage: passage as PublishedContentCandidate['passage'],
      additionalPassages: additionalPassages as PublishedContentCandidate['additionalPassages'],
      referenceLabel,

      situationTags: draft.situationTags,
      emotionTags: draft.emotionTags,
      spiritualQuestionTags: draft.spiritualQuestionTags,
      prayerModes: draft.prayerModes,
      pastoralFunction: draft.pastoralFunction,

      contextSummary: draft.contextSummary,
      theologicalInsight: draft.theologicalInsight,
      userExplanation: draft.userExplanation,
      prayerDirection: draft.prayerDirection,
      misuseGuards: draft.misuseGuards,
    };

    // ⑦ 글이 계약에 맞는지는 앞 계약의 검사기가 본다. 여기서 다시 만들지 않는다.
    const candidateCheck = validatePublishedContentCandidate(candidate);
    if (!candidateCheck.valid) {
      return fail('CANDIDATE_VALIDATION_FAILED', candidateCheck.errors);
    }

    // ⑧ 지문. 계산 방식의 주인은 앞 계약이다.
    const candidateHash = await computePublishedContentCandidateHash(candidate);

    return { ok: true, candidate, candidateHash };
  } catch {
    return fail('CANDIDATE_HASH_FAILED', ['글을 만들지 못했습니다.']);
  }
}
