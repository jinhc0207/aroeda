/**
 * 모델이 검토 대상 글의 초안을 쓸 때 지켜야 할 것.
 *
 * 여기에 프롬프트 문장은 없다. 모델 이름도, 호출 코드도 없다.
 * 정하는 것은 셋이다.
 *   모델에게 무엇을 보여줄 것인가.
 *   모델이 무엇을 돌려줄 수 있는가.
 *   모델이 무엇을 해서는 안 되는가.
 *
 * 왜 프롬프트보다 이것을 먼저 만드는가.
 *
 * 프롬프트는 부탁이다. 모델이 안 들을 수 있다.
 * 그래서 "하지 마세요"라고 적는 대신, 할 수 있는 통로 자체를 없앤다.
 *   본문 좌표를 돌려줄 자리가 없으면 본문을 지어낼 수 없다.
 *   연구 지문을 보지 못하면 다른 연구의 지문을 붙일 수 없다.
 *   고를 수 있는 것이 번호뿐이면 연구가 올리지 않은 본문을 쓸 수 없다.
 *
 * 그리고 못 쓰겠다고 말할 길을 열어 둔다.
 * 근거가 모자란데도 억지로 열한 항목을 채우게 하면,
 * 모델은 채운다. 그게 더 위험하다.
 */

import {
  AUTHORITATIVE_CANDIDATE_FIELDS,
  CANDIDATE_DRAFT_FIELDS,
  type CandidateGenerationDraft,
  validateCandidateGenerationDraft,
} from './published-content-candidate-builder.ts';
import {
  CANDIDATE_PROSE_FIELDS,
  CANDIDATE_TAG_FIELDS,
  type PublishValidation,
} from './published-content-contract.ts';
import type { BiblicalResearchResult, CandidatePassage } from './biblical-researcher.ts';
import type { PassageRef } from './scripture-cards.ts';

/* ------------------------------------------------------------------ */
/* 1. 모델에게 보여줄 것                                                */
/* ------------------------------------------------------------------ */

/**
 * 연구 결과 하나에서 모델이 볼 수 있는 부분.
 *
 * 통째로 넘기지 않는다. 필요한 것만 골라 담는다.
 *
 * 통째로 넘기면 지금 당장은 아무 문제가 없어 보인다.
 * 그런데 연구 결과에 항목이 하나 늘어나는 날, 그것이 조용히 함께 넘어간다.
 * 아무도 그러기로 결정한 적이 없는데도.
 */
export type CandidateModelGenerationInput = {
  /** 이 연구가 다룬 삶의 문제. 글이 다룰 범위이기도 하다. */
  targetDomain: string;
  /** 연구가 답하려던 질문. 글이 그 밖으로 나가지 않게 하는 테두리다. */
  researchQuestion: string;
  /** 무엇이 이 영역 안이고 무엇이 밖인지. */
  domainBoundaries: {
    includedConcerns: string[];
    excludedOrAdjacentConcerns: string[];
  };
  /** 연구가 아직 답하지 못한 것. 못 쓰겠다고 말할 근거가 된다. */
  unresolvedQuestions: string[];
  /** 고를 수 있는 본문들. 번호가 붙어 있다. */
  candidatePassages: CandidateModelPassageOption[];
};

/**
 * 고를 수 있는 본문 하나.
 *
 * 번호가 붙어 있는 이유가 있다.
 * 모델은 이 번호만 돌려준다. 좌표를 다시 적지 않는다.
 * 좌표를 적게 하면 한 글자만 틀려도 다른 본문이 되고, 그것을 알아채기 어렵다.
 */
export type CandidateModelPassageOption = {
  /** 0부터 차례로. 이것이 모델이 돌려주는 유일한 선택 값이다. */
  index: number;
  /** 어디를 가리키는지 보여만 준다. 돌려받지 않는다. */
  reference: PassageRef;
  additionalReferences: PassageRef[];
  /** 이 본문이 놓인 원래 흐름. */
  canonicalContext: string;
  /** 이 본문이 이 영역에 주는 신학적 기여. */
  theologicalContribution: string;
  /** 왜 이 영역에 맞는지. */
  domainFit: string;
  /** 목회적으로 어떻게 쓰이는지. */
  pastoralUse: string[];
  /** 잘못 쓰일 수 있는 지점. */
  misuseRisks: string[];
};

/** 모델에게 보여줄 상위 항목. 이것 말고는 담지 않는다. */
export const MODEL_INPUT_FIELDS = [
  'targetDomain',
  'researchQuestion',
  'domainBoundaries',
  'unresolvedQuestions',
  'candidatePassages',
] as const;

/** 본문 하나에서 보여줄 항목. */
export const MODEL_INPUT_PASSAGE_FIELDS = [
  'index',
  'reference',
  'additionalReferences',
  'canonicalContext',
  'theologicalContribution',
  'domainFit',
  'pastoralUse',
  'misuseRisks',
] as const;

/**
 * 연구 결과에 있지만 모델에게 보여주지 않는 것들과 그 이유.
 *
 * "나중에 검토자가 볼 수 있다"와 "지금 모델이 봐야 한다"는 다른 이야기다.
 * 검토자는 연구까지 되짚어야 하니 자료와 근거를 본다.
 * 모델은 글을 쓸 뿐이라 그것이 필요하지 않다.
 */
export const MODEL_INPUT_EXCLUSIONS = {
  evidenceVersion: '운영상의 판번호. 글의 내용과 관계가 없다.',
  prioritizerSnapshotId: '운영상의 번호. 글의 내용과 관계가 없다.',
  evidenceSetHash: '근거 꾸러미의 지문. 글을 쓰는 데 쓰이지 않는다.',
  rejectedPassages: '고를 수 없는 본문들. 번호로만 고르므로 애초에 닿지 않는다.',
  distinctnessFromActiveCoverage: '어느 영역을 연구할지 정할 때 쓰는 값이다. 글을 쓸 때가 아니다.',
  researchConfidence: '연구 단계 모델이 자기 판단에 매긴 점수. 그것을 보고 글의 확신을 조절하게 하지 않는다.',
  sourceSupport: '어떤 근거에 기댔는지의 번호들. 검토자가 보는 것이고 글을 쓰는 데 쓰이지 않는다.',
  researchResultHash: '연구의 신원. 모델이 보면 다른 연구의 지문을 붙일 길이 생긴다.',
} as const;

/**
 * 사람의 이야기는 이 경로에 올 일이 없다.
 *
 * 검토 대상 글은 한 사람의 사정에 답하는 것이 아니라,
 * 같은 문제를 겪는 여러 사람이 두고 볼 수 있는 공용 글이다.
 * 그래서 누구의 이야기도 재료가 되지 않는다.
 */
export const FORBIDDEN_MODEL_INPUT_FIELDS = [
  'userId',
  'sessionId',
  'deviceId',
  'email',
  'situation',
  'situationText',
  'rawSituation',
  'userMessage',
  'prayer',
  'prayerDraft',
  'auth',
  'jwt',
  'apiKey',
  'researchResultHash',
  'candidateHash',
  'provenance',
  'sources',
  'reviewerUserId',
  'createdAt',
] as const;

/**
 * 연구 결과에서 모델이 볼 부분만 골라 담는다.
 *
 * 통째로 펼치지 않는다. 항목을 하나씩 적는다.
 * 손이 더 가지만, 새 항목이 저절로 따라 들어오는 일이 없다.
 *
 * 여기서 하는 일은 고르는 것뿐이다.
 * 글을 쓰지 않고, 본문을 정하지 않고, 태그를 만들지 않고, 지문을 계산하지 않는다.
 *
 * 쓸 수 없는 연구 결과면 null 이다. 모델에게 넘기지 않는다.
 *
 * 연구 내용이 신학적으로 온전한지까지는 여기서 보지 않는다.
 * 그 검사(validateBiblicalResearchResult)는 연구 요청서와 자료 목록이 함께 있어야 하고,
 * 이 자리에는 그 둘이 없다. 같은 검사를 반쪽만 베껴 두지 않는다.
 */
export function buildCandidateModelGenerationInput(
  researchResult: unknown,
): CandidateModelGenerationInput | null {
  try {
    if (typeof researchResult !== 'object' || researchResult === null) return null;
    if (Array.isArray(researchResult)) return null;

    const result = researchResult as BiblicalResearchResult;

    if (typeof result.targetDomain !== 'string' || result.targetDomain.trim().length === 0) {
      return null;
    }
    if (typeof result.researchQuestion !== 'string') return null;
    if (!Array.isArray(result.unresolvedQuestions)) return null;

    const boundaries = result.domainBoundaries;
    if (typeof boundaries !== 'object' || boundaries === null) return null;
    if (!Array.isArray(boundaries.includedConcerns)) return null;
    if (!Array.isArray(boundaries.excludedOrAdjacentConcerns)) return null;

    if (!Array.isArray(result.candidatePassages) || result.candidatePassages.length === 0) {
      return null;
    }

    const candidatePassages: CandidateModelPassageOption[] = [];

    for (let index = 0; index < result.candidatePassages.length; index += 1) {
      const entry = result.candidatePassages[index] as CandidatePassage;
      if (typeof entry !== 'object' || entry === null) return null;
      if (typeof entry.reference !== 'object' || entry.reference === null) return null;
      if (!Array.isArray(entry.additionalReferences)) return null;
      if (typeof entry.canonicalContext !== 'string') return null;
      if (typeof entry.theologicalContribution !== 'string') return null;
      if (typeof entry.domainFit !== 'string') return null;
      if (!Array.isArray(entry.pastoralUse)) return null;
      if (!Array.isArray(entry.misuseRisks)) return null;

      candidatePassages.push({
        index,
        reference: entry.reference,
        additionalReferences: entry.additionalReferences,
        canonicalContext: entry.canonicalContext,
        theologicalContribution: entry.theologicalContribution,
        domainFit: entry.domainFit,
        pastoralUse: entry.pastoralUse,
        misuseRisks: entry.misuseRisks,
      });
    }

    return {
      targetDomain: result.targetDomain,
      researchQuestion: result.researchQuestion,
      domainBoundaries: {
        includedConcerns: boundaries.includedConcerns,
        excludedOrAdjacentConcerns: boundaries.excludedOrAdjacentConcerns,
      },
      unresolvedQuestions: result.unresolvedQuestions,
      candidatePassages,
    };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* 2. 모델이 돌려줄 수 있는 것                                          */
/* ------------------------------------------------------------------ */

/** 모델이 할 수 있는 대답은 둘뿐이다. */
export const GENERATION_DECISIONS = ['generate', 'defer'] as const;
export type GenerationDecision = (typeof GENERATION_DECISIONS)[number];

/**
 * 못 쓰겠다고 말하는 이유.
 *
 * 지금은 하나뿐이다. 종류를 늘리면 모델이 그 중 하나를 고르는 일이 또 생긴다.
 * 지금 필요한 것은 "썼다"와 "못 쓰겠다"의 구분뿐이다.
 */
export const GENERATION_DEFER_REASONS = ['needs_more_research'] as const;
export type GenerationDeferReason = (typeof GENERATION_DEFER_REASONS)[number];

/**
 * 모델의 대답.
 *
 * 반쯤 쓴 것을 돌려줄 자리가 없다.
 * 못 쓰겠으면 초안을 담지 않고, 쓸 수 있으면 이유를 담지 않는다.
 */
export type CandidateModelGenerationResponse =
  | { decision: 'generate'; draft: CandidateGenerationDraft }
  | { decision: 'defer'; reason: GenerationDeferReason };

export const GENERATE_RESPONSE_FIELDS = ['decision', 'draft'] as const;
export const DEFER_RESPONSE_FIELDS = ['decision', 'reason'] as const;

/**
 * 언제 못 쓰겠다고 말해야 하는가.
 *
 * 이것은 실패가 아니다. 근거 없는 글을 만들지 않는 것이 이 단계의 성공이다.
 * 잘못된 글이 하나 만들어지면 사람이 그것을 읽고 판단하는 시간이 든다.
 * 그 시간은 사람이 아니라 우리가 아껴 줘야 한다.
 */
export const DEFER_CONDITIONS = [
  '올라온 본문 중에 이 영역을 직접 다루는 것이 없다.',
  '본문의 원래 흐름이 이 쓰임을 뒷받침하는지 연구만으로 알 수 없다.',
  '신학적으로 어떻게 말해야 할지 연구가 충분히 말해 주지 않는다.',
  '목회적으로 안전한지 판단할 근거가 모자란다.',
  '잘못 쓰일 지점을 막을 문구를 충분히 만들 수 없다.',
  '연구만으로는 사용자에게 쉬운 말로 설명할 수 없다.',
] as const;

/**
 * 못 쓰겠다는 대답은 반쪽짜리 글이 아니다.
 *
 * 앞으로 이 대답을 받은 쪽은 그것을 조립하는 쪽에 넘기지 않는다.
 * 넘길 만한 것이 애초에 없다. 초안이 들어 있지 않기 때문이다.
 */
export const DEFER_IS_NOT_PARTIAL_CANDIDATE =
  '못 쓰겠다는 대답에는 초안이 없다. 조립하는 쪽으로 넘기지 않는다.';

/* ------------------------------------------------------------------ */
/* 3. 모델이 해서는 안 되는 것                                          */
/* ------------------------------------------------------------------ */

/**
 * 무엇을 근거로 쓰는가.
 *
 * 모델은 성경을 안다. 그것이 문제다.
 * 연구가 말해 주지 않은 것을 자기가 아는 것으로 조용히 메울 수 있고,
 * 그렇게 메운 자리는 겉보기에 다른 문장과 구별되지 않는다.
 *
 * 그래서 모자라면 메우지 말고 못 쓰겠다고 말하게 한다.
 */
export const GROUNDING_POLICY = {
  /** 연구 결과 밖의 사실로 넓히지 않는다. */
  expandBeyondResearchResult: false,
  /** 모델이 아는 성경 지식으로 연구의 빈자리를 메우지 않는다. */
  fillGapsWithModelKnowledge: false,
  /** 본문은 연구가 올린 것 중에서만 고른다. */
  selectOnlyFromCandidatePassages: true,
  /** 성경 참조를 새로 만들지 않는다. */
  mayCreateNewScriptureReference: false,
  /** 성경 본문 문장을 옮겨 적지 않는다. 그것의 주인은 성경 데이터다. */
  mayQuoteScriptureText: false,
  /** 근거가 모자라면 지어내지 않고 못 쓰겠다고 말한다. */
  insufficientEvidenceBecomesDefer: true,
} as const;

/**
 * 본문을 무엇을 보고 고르는가.
 *
 * 순서에 대해 한 가지 분명히 해 둔다.
 * 연구 결과의 본문 목록이 좋은 순서라는 약속은 어디에도 없다.
 * 그러니 "앞의 것을 먼저"라는 규칙을 여기서 만들지 않는다.
 * 다섯 가지를 보고 고르되, 고를 만한 것이 없으면 고르지 않는다.
 */
export const PASSAGE_SELECTION_POLICY = {
  criteria: [
    '이 영역의 문제를 직접 다루는가.',
    '본문이 놓인 원래 흐름이 이 쓰임을 뒷받침하는가.',
    '신학적 기여가 본문의 중심 의미와 맞는가.',
    '잘못 쓰일 지점을 막을 수 있는 정도인가.',
    '사용자에게 설명하고 기도 방향으로 옮길 때 뒤틀리지 않는가.',
  ],
  /** 목록 순서를 좋은 순서로 보지 않는다. */
  listOrderIsRanking: false,
  /** 모델이 돌려주는 선택 값은 번호 하나뿐이다. */
  modelReturns: 'selectedPassageIndex',
  /** 좌표를 다시 적게 하지 않는다. */
  modelMayReturnCoordinates: false,
  /** 고를 만한 것이 없으면 못 쓰겠다고 말한다. */
  noSuitablePassageBecomesDefer: true,
} as const;

/**
 * 태그를 기존 사전 안의 값으로 제한하지 않는다.
 *
 * 이것은 이번에 새로 정한 것이 아니라 앞 계약의 결정을 그대로 따르는 것이다.
 *
 * 표준 사전(analysis-taxonomy)은 지금 있는 카드 열 장에서 자동으로 모은 것이고,
 * 상황 분석기가 쓰도록 만들어진 것이다.
 * 새 영역의 글을 만들면서 기존 카드의 말만 쓰라고 하면,
 * 새 영역이라 만드는 글인데 새 말은 못 쓰는 셈이 된다.
 *
 * 그래서 새 태그를 허용하고, 그것이 실제 삶의 문제와 맞는지는 사람이 본다(taggingFit).
 * 여기서 새 사전을 만들지 않는다.
 */
export const TAG_VOCABULARY_POLICY = {
  mode: 'open',
  restrictToExistingTaxonomy: false,
  reason: '표준 사전은 상황 분석기의 것이고, 지금 있는 카드에서 모은 값이다. 새 영역의 글이 새 말을 못 쓰게 된다.',
  judgedBy: 'taggingFit',
  createsNewVocabulary: false,
} as const;

/* ------------------------------------------------------------------ */
/* 4. 열 항목이 각각 무엇인가                                           */
/* ------------------------------------------------------------------ */

/**
 * 모델이 쓰는 열 항목의 역할.
 *
 * 이름만 보면 비슷해 보이는 것들이 있어서 적어 둔다.
 * 문맥 설명과 신학적 의미가 섞이거나,
 * 기도 방향이 기도문이 되어 버리는 일을 막기 위해서다.
 *
 * 사람이 검토할 때 보는 항목 이름을 그대로 쓴다. 새 말을 만들지 않는다.
 */
export const FIELD_RESPONSIBILITIES = {
  situationTags: {
    purpose: '어떤 삶의 상황에서 이 글을 찾게 되는가.',
    notFor: '사용자에게 보여줄 문장이 아니다. 찾기 위한 이름표다.',
    reviewedBy: 'taggingFit',
  },
  emotionTags: {
    purpose: '그때 어떤 마음인가.',
    notFor: '감정을 단정하거나 진단하지 않는다.',
    reviewedBy: 'taggingFit',
  },
  spiritualQuestionTags: {
    purpose: '그 상황에서 하나님께 묻게 되는 것.',
    notFor: '답을 담지 않는다.',
    reviewedBy: 'taggingFit',
  },
  prayerModes: {
    purpose: '어떤 결의 기도가 되는가.',
    notFor: '기도문이 아니다.',
    reviewedBy: 'taggingFit',
  },
  pastoralFunction: {
    purpose: '이 글이 하는 목회적 역할.',
    notFor: '효과를 약속하지 않는다.',
    reviewedBy: 'taggingFit',
  },
  contextSummary: {
    purpose: '고른 본문이 놓인 원래 흐름을 짧게 정리한다.',
    notFor: '적용도 기도문도 아니다. 문맥 설명이다.',
    reviewedBy: 'canonicalContext',
  },
  theologicalInsight: {
    purpose: '이 본문이 드러내는 신학적 의미.',
    notFor: '문맥 설명을 다시 쓰는 자리가 아니고, 일반적인 격려 문구도 아니다.',
    reviewedBy: 'theologicalFaithfulness',
  },
  userExplanation: {
    purpose: '전문 용어 없이 쉬운 한국어로 이 말씀이 무엇을 말하는지 설명한다.',
    notFor: '연구 과정이나 자료를 설명하지 않는다. 새 성경 좌표를 만들지 않는다.',
    reviewedBy: 'userFacingClarity',
  },
  prayerDirection: {
    purpose: '이 말씀을 붙들고 어느 방향으로 아뢸 수 있는지 안내한다.',
    notFor: '완성된 기도문이 아니다. 기도문은 따로 있는 계층의 몫이다.',
    reviewedBy: 'pastoralSafety',
  },
  misuseGuards: {
    purpose: '연구가 짚은 오용 위험을 이 글을 쓸 때의 금지 규칙으로 옮긴다.',
    notFor: '본문과 무관한 일반 면책 문구 목록이 아니다.',
    reviewedBy: 'misuseGuardsAdequate',
  },
} as const;

/**
 * 사용자에게 보여줄 글의 언어.
 *
 * 지금 있는 카드 열 장의 설명과 기도 방향이 모두 한국어이고,
 * 앱 화면도 한국어다. 그래서 한국어를 기본으로 둔다.
 */
export const USER_FACING_LANGUAGE = 'ko';

/* ------------------------------------------------------------------ */
/* 5. 모델의 대답이 받을 수 있는 모양인가                               */
/* ------------------------------------------------------------------ */

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * 모델이 돌려준 것을 본다.
 *
 * 초안 자체의 모양은 조립하는 쪽의 검사기가 본다. 같은 규칙을 여기서 다시 만들지 않는다.
 * 여기서 더 보는 것은 대답의 겉모양과, 고른 번호가 실제로 있는 번호인가다.
 *
 * 어떤 이상한 값이 와도 예외를 던지지 않는다. 판단이 서지 않으면 막는다.
 */
export function validateCandidateModelGenerationResponse(
  value: unknown,
  input: CandidateModelGenerationInput,
): PublishValidation {
  const errors: string[] = [];

  try {
    if (!isPlainObject(value)) {
      return { valid: false, errors: ['모델의 대답이 객체가 아닙니다.'] };
    }

    const decision = value.decision;
    if (typeof decision !== 'string' || !(GENERATION_DECISIONS as readonly string[]).includes(decision)) {
      return { valid: false, errors: ['모델의 대답 종류를 알 수 없습니다.'] };
    }

    const allowed: readonly string[] =
      decision === 'generate' ? GENERATE_RESPONSE_FIELDS : DEFER_RESPONSE_FIELDS;

    for (const key of Object.keys(value)) {
      if ((AUTHORITATIVE_CANDIDATE_FIELDS as readonly string[]).includes(key)) {
        errors.push(`모델이 정할 수 없는 항목입니다: ${key}`);
        continue;
      }
      if (!allowed.includes(key)) {
        errors.push(`대답에 올 수 없는 항목입니다: ${key}`);
      }
    }
    for (const key of allowed) {
      if (!(key in value)) errors.push(`빠진 항목입니다: ${key}`);
    }

    if (errors.length > 0) return { valid: false, errors };

    if (decision === 'defer') {
      const reason = value.reason;
      if (
        typeof reason !== 'string' ||
        !(GENERATION_DEFER_REASONS as readonly string[]).includes(reason)
      ) {
        return { valid: false, errors: ['정해진 보류 이유가 아닙니다.'] };
      }
      return { valid: true, errors: [] };
    }

    // 초안의 모양은 조립하는 쪽의 검사기가 본다.
    const draftCheck = validateCandidateGenerationDraft(value.draft);
    if (!draftCheck.valid) return { valid: false, errors: draftCheck.errors };

    // 고른 번호가 실제로 보여 준 번호인가. 보여 준 것 밖을 고를 수 없다.
    const draft = value.draft as CandidateGenerationDraft;
    if (draft.selectedPassageIndex >= input.candidatePassages.length) {
      return { valid: false, errors: ['보여 주지 않은 본문 번호입니다.'] };
    }

    return { valid: true, errors: [] };
  } catch {
    return { valid: false, errors: ['모델의 대답을 확인하지 못했습니다.'] };
  }
}

/* ------------------------------------------------------------------ */
/* 6. 이 계약이 다루지 않는 것                                          */
/* ------------------------------------------------------------------ */

/**
 * 여기에 없는 것들.
 *
 * 프롬프트 문장, 모델 이름, 호출 설정, 재시도, 시간 제한.
 * 그것들은 다음 계층의 몫이고, 그 계층이 이 계약을 지키게 된다.
 *
 * 순서를 이렇게 둔 이유가 있다.
 * 프롬프트를 먼저 쓰면, 프롬프트가 지켜 주는 것과 구조가 지켜 주는 것이 섞인다.
 * 그러면 나중에 프롬프트를 손볼 때 무엇이 무너지는지 알기 어렵다.
 */
export const NOT_IN_THIS_CONTRACT = [
  '프롬프트 문장',
  '모델 이름과 호출 설정',
  '재시도와 시간 제한',
  '연구 결과를 읽어 오는 일',
  '만들어진 글을 적어 두는 일',
] as const;

/** 초안의 항목 수를 다른 곳에서 다시 세지 않도록, 조립하는 쪽의 것을 그대로 쓴다. */
export const MODEL_DRAFT_FIELDS = CANDIDATE_DRAFT_FIELDS;

/** 모델이 쓰는 열 항목. 번호 고르기는 글쓰기가 아니라 선택이라 따로 둔다. */
export const MODEL_SYNTHESIS_FIELDS = [
  ...CANDIDATE_TAG_FIELDS,
  ...CANDIDATE_PROSE_FIELDS,
  'misuseGuards',
] as const;
