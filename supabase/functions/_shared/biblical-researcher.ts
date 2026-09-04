/**
 * Biblical Researcher v1 (순수 로직)
 *
 * 하는 일: 연구 의뢰서(brief)를 만들고, 돌아온 연구 결과가 규칙을 지켰는지 확인한다.
 * 하지 않는 일: 실제 조사, 본문 확정, 카드 작성, DB 접근, AI 호출.
 *
 * 개인정보: 사용자 문장, 사용자 id, 세션·기기 정보, Prioritizer의 점수·이유·확신은
 *          이 경로 어디에도 들어오지 않는다. 필요한 것은 "이 영역이 연구 대상으로 정해졌다"는 사실뿐이다.
 */

import {
  BIBLICAL_RESEARCH_SCHEMA,
  CANDIDATE_MAX,
  CANDIDATE_MIN,
  REASON_TEXT_MAX,
  REJECTED_MAX,
  REJECTED_MIN,
  RESEARCHABLE_DOMAINS,
  RISK_CATEGORIES,
  type RiskCategory,
} from './biblical-research-contract.ts';
import { checkBibleReference } from './bible-reference.ts';
import {
  SUPPORT_ROLES,
  SUPPORT_ROLE_RULES,
  isSourceAllowedForRole,
  type ResearchSource,
  type SupportRole,
} from './research-source.ts';
import { sanitizeActiveCoveredDomains } from './research-prioritizer-contract.ts';
import { DOMAIN_DESCRIPTIONS, isSituationDomain } from './situation-domains.ts';
import type { PassageRef } from './scripture-cards.ts';

export { BIBLICAL_RESEARCH_SCHEMA };

/** 연구 의뢰서. Prioritizer가 정한 사실만 담는다. */
export type BiblicalResearchBrief = {
  targetDomain: string;
  domainDescription: string;
  evidenceVersion: number;
  prioritizerSnapshotId: string;
  activeCoveredDomains: string[];
};

// 자료 타입 정의는 research-source.ts 한 곳에만 둔다.
export type { ResearchSource };

export type DistinctnessNote = {
  distinct: boolean;
  nearestExistingDomain: string | null;
  explanation: string;
};

export type CandidatePassage = {
  reference: PassageRef;
  /** 여러 장에 걸친 본문일 때만 사용한다. 없으면 빈 배열. */
  additionalReferences: PassageRef[];
  canonicalContext: string;
  theologicalContribution: string;
  domainFit: string;
  pastoralUse: string[];
  misuseRisks: string[];
  distinctnessFromActiveCoverage: DistinctnessNote;
  researchConfidence: number;
  /**
   * 어떤 주장을 어떤 근거에 기댔는가.
   *
   * 자료 metadata는 여기 없다. 근거 번호(모델이 고른 것)와
   * 그 번호의 주인인 자료 id(서버가 뽑은 것)만 있다.
   */
  sourceSupport: SourceSupport;
};

/**
 * 역할별 근거 자료.
 *
 * 한 자료가 여러 역할에 실제로 맞으면 여러 곳에 함께 들어갈 수 있다.
 * 다만 각 배열 안에서는 같은 자료가 두 번 나올 수 없다.
 */
export type SourceSupportDraft = {
  exegesisEvidenceIds: string[];
  theologyEvidenceIds: string[];
  pastoralEvidenceIds: string[];
  safetyEvidenceIds: string[];
};

/**
 * 최종 결과의 역할별 근거.
 *
 * 근거 번호는 모델이 고른다. 자료 id는 서버가 그 번호의 주인을 찾아 붙인다.
 * 모델이 자료 id를 직접 고르지 않으므로, 근거와 자료가 어긋날 길이 없다.
 */
export type SourceSupport = SourceSupportDraft & {
  exegesisSourceIds: string[];
  theologySourceIds: string[];
  pastoralSourceIds: string[];
  safetySourceIds: string[];
};

const SUPPORT_FIELD: Readonly<Record<SupportRole, keyof SourceSupport>> = {
  exegesis: 'exegesisSourceIds',
  theology: 'theologySourceIds',
  pastoral: 'pastoralSourceIds',
  safety: 'safetySourceIds',
};

/** 역할마다 모델이 고르는 근거 번호 칸 */
export const SUPPORT_EVIDENCE_FIELD: Readonly<Record<SupportRole, keyof SourceSupportDraft>> = {
  exegesis: 'exegesisEvidenceIds',
  theology: 'theologyEvidenceIds',
  pastoral: 'pastoralEvidenceIds',
  safety: 'safetyEvidenceIds',
};

/** 역할이 받을 수 있는 근거의 용도. research-source.ts의 규칙을 그대로 쓴다. */
export const SUPPORT_ROLE_EVIDENCE_USES: Readonly<Record<SupportRole, readonly string[]>> = {
  exegesis: SUPPORT_ROLE_RULES.exegesis.requiredUses,
  theology: SUPPORT_ROLE_RULES.theology.requiredUses,
  pastoral: SUPPORT_ROLE_RULES.pastoral.requiredUses,
  safety: SUPPORT_ROLE_RULES.safety.requiredUses,
};

/** 모델이 쓰는 후보. 서버가 붙이는 값은 여기 없다. */
export type CandidatePassageDraft = Omit<CandidatePassage, 'sourceSupport'> & {
  sourceSupport: SourceSupportDraft;
};

export type RejectedPassage = {
  reference: PassageRef;
  rejectionReason: string;
  riskCategory: RiskCategory;
};

/** 모델이 쓰는 연구 결과. 꾸러미 지문은 여기 없다. 서버가 붙인다. */
export type BiblicalResearchDraftResult = {
  targetDomain: string;
  evidenceVersion: number;
  prioritizerSnapshotId: string;
  researchQuestion: string;
  domainBoundaries: {
    includedConcerns: string[];
    excludedOrAdjacentConcerns: string[];
  };
  candidatePassages: CandidatePassageDraft[];
  rejectedPassages: RejectedPassage[];
  unresolvedQuestions: string[];
};

export type BiblicalResearchResult = {
  targetDomain: string;
  evidenceVersion: number;
  prioritizerSnapshotId: string;
  researchQuestion: string;
  domainBoundaries: {
    includedConcerns: string[];
    excludedOrAdjacentConcerns: string[];
  };
  /**
   * 자료 목록은 여기에 없다.
   * 자료는 Source Harvester가 정하고, 연구 결과는 그 sourceId만 가리킨다.
   * 그래서 연구 단계에서 자료의 종류·용도·확인 수준·주소를 바꾸는 일 자체가 불가능하다.
   */
  candidatePassages: CandidatePassage[];
  rejectedPassages: RejectedPassage[];
  unresolvedQuestions: string[];
  /**
   * 이 연구가 어느 근거 꾸러미를 보고 나왔는지.
   * 서버가 붙인다. 모델이 만들 수 없다.
   */
  evidenceSetHash: string;
};

export type ValidationResult = { valid: boolean; errors: string[] };

/** 연구 대상이 될 수 없는 영역이 들어왔을 때 던진다. */
export class InvalidResearchBriefError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidResearchBriefError';
  }
}

const researchable = new Set(RESEARCHABLE_DOMAINS);
const riskCategories = new Set<string>(RISK_CATEGORIES);

/**
 * 연구 의뢰서를 만든다.
 *
 * 지금 카드가 없는 7개 영역만 연구 대상이다.
 * other_uncovered, 이미 카드가 있는 영역, 모르는 값은 모두 거절한다.
 * 영역 설명은 새로 쓰지 않고 기존 정의를 그대로 가져온다.
 */
export function buildResearchBrief(input: {
  targetDomain: string;
  evidenceVersion: number;
  prioritizerSnapshotId: string;
  activeCoveredDomains: readonly string[];
}): BiblicalResearchBrief {
  if (!researchable.has(input.targetDomain)) {
    throw new InvalidResearchBriefError(`연구 대상 영역이 아닙니다: ${input.targetDomain}`);
  }

  const activeCoveredDomains = sanitizeActiveCoveredDomains(input.activeCoveredDomains);
  if (activeCoveredDomains.includes(input.targetDomain)) {
    throw new InvalidResearchBriefError(`이미 카드가 있는 영역입니다: ${input.targetDomain}`);
  }

  if (!Number.isInteger(input.evidenceVersion) || input.evidenceVersion < 1) {
    throw new InvalidResearchBriefError('evidenceVersion이 올바르지 않습니다.');
  }
  if (typeof input.prioritizerSnapshotId !== 'string' || input.prioritizerSnapshotId.length === 0) {
    throw new InvalidResearchBriefError('prioritizerSnapshotId가 없습니다.');
  }

  return {
    targetDomain: input.targetDomain,
    domainDescription: DOMAIN_DESCRIPTIONS[input.targetDomain as never] ?? '',
    evidenceVersion: input.evidenceVersion,
    prioritizerSnapshotId: input.prioritizerSnapshotId,
    activeCoveredDomains,
  };
}

const TOP_LEVEL_FIELDS = [
  'targetDomain',
  'evidenceVersion',
  'prioritizerSnapshotId',
  'researchQuestion',
  'domainBoundaries',
  'candidatePassages',
  'rejectedPassages',
  'unresolvedQuestions',
  // 서버가 붙이는 값. 모델 초안에는 없다.
  'evidenceSetHash',
] as const;

/** 모델이 쓰는 초안의 최상위 항목. 꾸러미 지문은 여기 없다. */
export const DRAFT_TOP_LEVEL_FIELDS = TOP_LEVEL_FIELDS.filter(
  (field) => field !== 'evidenceSetHash',
);

const CANDIDATE_FIELDS = [
  'reference',
  'additionalReferences',
  'canonicalContext',
  'theologicalContribution',
  'domainFit',
  'pastoralUse',
  'misuseRisks',
  'distinctnessFromActiveCoverage',
  'researchConfidence',
  'sourceSupport',
] as const;

const SUPPORT_FIELDS = [
  'exegesisEvidenceIds',
  'theologyEvidenceIds',
  'pastoralEvidenceIds',
  'safetyEvidenceIds',
  'exegesisSourceIds',
  'theologySourceIds',
  'pastoralSourceIds',
  'safetySourceIds',
] as const;

/** 모델이 쓰는 초안의 근거 칸. 서버가 뽑는 자료 id는 여기 없다. */
export const SUPPORT_DRAFT_FIELDS = [
  'exegesisEvidenceIds',
  'theologyEvidenceIds',
  'pastoralEvidenceIds',
  'safetyEvidenceIds',
] as const;

const REJECTED_FIELDS = ['reference', 'rejectionReason', 'riskCategory'] as const;
const REFERENCE_FIELDS = ['book', 'chapter', 'startVerse', 'endVerse'] as const;
const DISTINCTNESS_FIELDS = ['distinct', 'nearestExistingDomain', 'explanation'] as const;
const BOUNDARY_FIELDS = ['includedConcerns', 'excludedOrAdjacentConcerns'] as const;

/**
 * 연구 결과에 절대 있으면 안 되는 항목 이름 (어느 깊이에 있든).
 *
 * 앞쪽은 성경 원문·카드 문안을 지어내려는 시도,
 * 가운데는 자료 metadata를 다시 적어 보내려는 시도(자료는 Source Harvester만 정한다),
 * 뒤쪽은 사용자 정보와 Prioritizer 판단 근거가 흘러드는 것을 막는다.
 */
const BANNED_FIELD_NAMES = [
  'text',
  'versetext',
  'passagetext',
  'scripturetext',
  'scripture',
  'verses',
  'userexplanation',
  'prayerdirection',
  'prayer',
  'card',
  'sources',
  'source',
  'sourceids',
  'sourcetype',
  'intendeduse',
  'accesslevel',
  'accessedat',
  'publisherorinstitution',
  'publicationyear',
  'authororganization',
  'relevancenote',
  'url',
  'situation',
  'rawsituation',
  'userid',
  'user_id',
  'uid',
  'sessionid',
  'deviceid',
  'jwt',
  'token',
];

const isNonEmptyString = (value: unknown) => typeof value === 'string' && value.trim().length > 0;

const isStringArray = (value: unknown) =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

const referenceKey = (reference: PassageRef) =>
  `${reference.book}:${reference.chapter}:${reference.startVerse}-${reference.endVerse}`;

/**
 * 본문 위치를 확인한다.
 *
 * 구조(허용된 항목만 있는지)를 본 다음, 개역한글 성경에 실제로 있는 장·절인지까지 확인한다.
 * 판단은 canonical Bible reference index가 한다. 여기서 장·절 수를 따로 세지 않는다.
 */
function checkReference(value: unknown, label: string, errors: string[]): PassageRef | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    errors.push(`${label}: 본문 위치가 객체가 아닙니다.`);
    return null;
  }

  const reference = value as Record<string, unknown>;
  for (const key of Object.keys(reference)) {
    if (!(REFERENCE_FIELDS as readonly string[]).includes(key)) {
      errors.push(`${label}: 본문 위치에 허용되지 않는 항목이 있습니다 (${key})`);
    }
  }

  const outcome = checkBibleReference(reference, label);
  if (!outcome.valid) {
    errors.push(...outcome.errors);
    return null;
  }

  return reference as unknown as PassageRef;
}

/** 어느 깊이에 있든 금지된 항목 이름이 있으면 잡아낸다. */
function scanBannedFields(value: unknown, errors: string[], path = ''): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanBannedFields(item, errors, `${path}[${index}]`));
    return;
  }
  if (typeof value !== 'object' || value === null) return;

  for (const [key, child] of Object.entries(value)) {
    if (BANNED_FIELD_NAMES.includes(key.toLowerCase())) {
      errors.push(`허용되지 않는 항목이 있습니다: ${path}${path ? '.' : ''}${key}`);
    }
    scanBannedFields(child, errors, `${path}${path ? '.' : ''}${key}`);
  }
}

/**
 * 후보 본문의 역할별 근거를 확인한다.
 *
 * 자료마다 할 수 있는 역할이 정해져 있고, 그 판단은 research-source.ts의 canonical 규칙이 한다.
 * 여기서 허용 목록을 다시 적지 않는다.
 */
function checkSourceSupport(
  value: unknown,
  label: string,
  sourceById: Map<string, ResearchSource>,
  errors: string[],
): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    errors.push(`${label}: sourceSupport가 객체가 아닙니다.`);
    return;
  }

  const support = value as Record<string, unknown>;
  for (const key of Object.keys(support)) {
    if (!(SUPPORT_FIELDS as readonly string[]).includes(key)) {
      errors.push(`${label}: sourceSupport에 허용되지 않는 항목이 있습니다 (${key})`);
    }
  }

  for (const role of SUPPORT_ROLES) {
    const field = SUPPORT_FIELD[role];
    const rule = SUPPORT_ROLE_RULES[role];
    const ids = support[field];

    if (!isStringArray(ids)) {
      errors.push(`${label}: ${field}가 문자열 목록이 아닙니다.`);
      continue;
    }

    const list = ids as string[];
    if (list.length < rule.minSources) {
      errors.push(`${label}: ${field}가 ${rule.minSources}개 이상이어야 합니다.`);
    }

    // 같은 역할 안에서 같은 자료를 두 번 세지 않는다.
    if (new Set(list).size !== list.length) {
      errors.push(`${label}: ${field}에 같은 자료가 두 번 들어 있습니다.`);
    }

    for (const id of list) {
      const source = sourceById.get(id);
      if (!source) {
        errors.push(`${label}: 존재하지 않는 근거 자료를 가리킵니다 (${id})`);
        continue;
      }
      if (!isSourceAllowedForRole(source, role)) {
        errors.push(`${label}: ${source.sourceType} 자료를 ${field}의 근거로 쓸 수 없습니다 (${id})`);
      }
    }

    // 근거 번호 쪽도 목록이어야 하고, 같은 번호가 두 번 오면 안 된다.
    const evidenceField = SUPPORT_EVIDENCE_FIELD[role];
    const evidenceIds = support[evidenceField];
    if (!isStringArray(evidenceIds)) {
      errors.push(`${label}: ${evidenceField}가 문자열 목록이 아닙니다.`);
      continue;
    }

    const evidenceList = evidenceIds as string[];
    if (new Set(evidenceList).size !== evidenceList.length) {
      errors.push(`${label}: ${evidenceField}에 같은 근거가 두 번 들어 있습니다.`);
    }

    // 자료 id는 근거 번호에서 나온 것이어야 한다.
    // 근거가 하나도 없는데 자료만 적혀 있으면 서버가 뽑은 값이 아니다.
    if (evidenceList.length === 0 && list.length > 0) {
      errors.push(`${label}: ${field}에 근거 없이 자료만 들어 있습니다.`);
    }
    if (evidenceList.length > 0 && list.length === 0) {
      errors.push(`${label}: ${evidenceField}가 있는데 ${field}가 비어 있습니다.`);
    }
  }

  // 같은 근거를 여러 역할에 나누어 세지 않는다.
  // 근거 하나에는 용도가 하나뿐이므로, 두 역할에 동시에 맞을 수 없다.
  const usedEvidence = new Set<string>();
  for (const role of SUPPORT_ROLES) {
    const evidenceIds = support[SUPPORT_EVIDENCE_FIELD[role]];
    if (!isStringArray(evidenceIds)) continue;
    for (const id of evidenceIds as string[]) {
      if (usedEvidence.has(id)) {
        errors.push(`${label}: 같은 근거를 여러 역할에 썼습니다 (${id})`);
      }
      usedEvidence.add(id);
    }
  }
}

/**
 * 모델 초안의 역할별 근거 칸을 확인한다.
 *
 * 여기서 보는 것은 모양뿐이다.
 *   - 초안이 쓸 수 있는 칸만 있는가 (자료 id 칸은 서버 몫이므로 있으면 잘못)
 *   - 각 칸이 문자열 목록인가
 *
 * 그 근거가 실제로 꾸러미에 있는지, 그 역할을 맡을 수 있는지,
 * 그 후보 본문을 다루는지는 여기서 보지 않는다.
 * 그것은 근거에 묶는 단계(bindBiblicalResearchEvidence)가 authoritative하게 판단한다.
 * 같은 판단을 두 곳에서 하면 언젠가 서로 달라진다.
 */
function checkDraftSourceSupport(value: unknown, label: string, errors: string[]): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    errors.push(`${label}: sourceSupport가 객체가 아닙니다.`);
    return;
  }

  const support = value as Record<string, unknown>;
  for (const key of Object.keys(support)) {
    if (!(SUPPORT_DRAFT_FIELDS as readonly string[]).includes(key)) {
      // 자료 id는 서버가 뽑는다. 초안에 있으면 그 자체로 잘못이다.
      errors.push(`${label}: sourceSupport에 허용되지 않는 항목이 있습니다 (${key})`);
    }
  }

  for (const field of SUPPORT_DRAFT_FIELDS) {
    if (!isStringArray(support[field])) {
      errors.push(`${label}: ${field}가 문자열 목록이 아닙니다.`);
    }
  }
}

/**
 * 연구 결과의 본문 규칙. 초안과 최종 결과가 이 하나를 함께 쓴다.
 *
 * 규칙 목록을 두 벌 만들지 않는다.
 * 초안과 최종 결과의 차이는 딱 두 가지뿐이다.
 *   - 최상위에 꾸러미 지문이 있는가 (allowedFields)
 *   - 근거 칸에 서버가 뽑은 자료 id가 있는가 (checkSupport)
 */
function checkResearchBody(
  value: Record<string, unknown>,
  brief: BiblicalResearchBrief,
  allowedFields: readonly string[],
  checkSupport: (support: unknown, label: string, errors: string[]) => void,
  errors: string[],
): void {

  for (const key of Object.keys(value)) {
    if (!allowedFields.includes(key)) {
      errors.push(`허용되지 않는 최상위 항목이 있습니다 (${key})`);
    }
  }
  for (const key of allowedFields) {
    if (!(key in value)) errors.push(`필수 항목이 없습니다 (${key})`);
  }

  scanBannedFields(value, errors);

  // 의뢰서와 같은 대상인지
  if (value.targetDomain !== brief.targetDomain) {
    errors.push('targetDomain이 의뢰서와 다릅니다.');
  }
  if (value.evidenceVersion !== brief.evidenceVersion) {
    errors.push('evidenceVersion이 의뢰서와 다릅니다.');
  }
  if (value.prioritizerSnapshotId !== brief.prioritizerSnapshotId) {
    errors.push('prioritizerSnapshotId가 의뢰서와 다릅니다.');
  }

  if (!isNonEmptyString(value.researchQuestion)) {
    errors.push('researchQuestion이 비어 있습니다.');
  } else if ((value.researchQuestion as string).length > REASON_TEXT_MAX) {
    errors.push(`researchQuestion이 ${REASON_TEXT_MAX}자를 넘습니다.`);
  }

  // 영역 경계
  const boundaries = value.domainBoundaries;
  if (typeof boundaries !== 'object' || boundaries === null || Array.isArray(boundaries)) {
    errors.push('domainBoundaries가 객체가 아닙니다.');
  } else {
    for (const key of Object.keys(boundaries)) {
      if (!(BOUNDARY_FIELDS as readonly string[]).includes(key)) {
        errors.push(`domainBoundaries에 허용되지 않는 항목이 있습니다 (${key})`);
      }
    }
    const record = boundaries as Record<string, unknown>;
    if (!isStringArray(record.includedConcerns) || (record.includedConcerns as string[]).length === 0) {
      errors.push('includedConcerns가 비어 있습니다.');
    }
    if (!isStringArray(record.excludedOrAdjacentConcerns)) {
      errors.push('excludedOrAdjacentConcerns가 문자열 목록이 아닙니다.');
    }
  }

  // 후보 본문
  const candidateKeys = new Set<string>();
  if (!Array.isArray(value.candidatePassages)) {
    errors.push('candidatePassages가 배열이 아닙니다.');
  } else {
    const count = value.candidatePassages.length;
    if (count < CANDIDATE_MIN || count > CANDIDATE_MAX) {
      errors.push(`후보 본문은 ${CANDIDATE_MIN}~${CANDIDATE_MAX}개여야 합니다 (지금 ${count}개).`);
    }

    for (const [index, entry] of value.candidatePassages.entries()) {
      const label = `candidatePassages[${index}]`;
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        errors.push(`${label}: 객체가 아닙니다.`);
        continue;
      }
      const candidate = entry as Record<string, unknown>;

      for (const key of Object.keys(candidate)) {
        if (!(CANDIDATE_FIELDS as readonly string[]).includes(key)) {
          errors.push(`${label}: 허용되지 않는 항목이 있습니다 (${key})`);
        }
      }

      const reference = checkReference(candidate.reference, label, errors);
      if (reference) {
        const key = referenceKey(reference);
        if (candidateKeys.has(key)) errors.push(`${label}: 같은 본문이 두 번 후보로 올라왔습니다.`);
        candidateKeys.add(key);
      }

      if (!Array.isArray(candidate.additionalReferences)) {
        errors.push(`${label}: additionalReferences가 배열이 아닙니다.`);
      } else {
        candidate.additionalReferences.forEach((extra, extraIndex) =>
          checkReference(extra, `${label}.additionalReferences[${extraIndex}]`, errors),
        );
      }

      for (const field of ['canonicalContext', 'theologicalContribution', 'domainFit'] as const) {
        if (!isNonEmptyString(candidate[field])) {
          errors.push(`${label}: ${field}가 비어 있습니다.`);
        } else if ((candidate[field] as string).length > REASON_TEXT_MAX) {
          errors.push(`${label}: ${field}가 ${REASON_TEXT_MAX}자를 넘습니다.`);
        }
      }

      if (!isStringArray(candidate.pastoralUse) || (candidate.pastoralUse as string[]).length === 0) {
        errors.push(`${label}: pastoralUse가 비어 있습니다.`);
      }
      if (!isStringArray(candidate.misuseRisks) || (candidate.misuseRisks as string[]).length === 0) {
        errors.push(`${label}: misuseRisks가 비어 있습니다.`);
      }

      // 기존 영역과의 구별
      const distinctness = candidate.distinctnessFromActiveCoverage;
      if (typeof distinctness !== 'object' || distinctness === null || Array.isArray(distinctness)) {
        errors.push(`${label}: distinctnessFromActiveCoverage가 객체가 아닙니다.`);
      } else {
        const note = distinctness as Record<string, unknown>;
        for (const key of Object.keys(note)) {
          if (!(DISTINCTNESS_FIELDS as readonly string[]).includes(key)) {
            errors.push(`${label}: distinctness에 허용되지 않는 항목이 있습니다 (${key})`);
          }
        }
        if (typeof note.distinct !== 'boolean') {
          errors.push(`${label}: distinct가 true/false가 아닙니다.`);
        }
        if (note.nearestExistingDomain !== null && !isSituationDomain(note.nearestExistingDomain)) {
          errors.push(`${label}: nearestExistingDomain이 아는 영역이 아닙니다.`);
        }
        if (!isNonEmptyString(note.explanation)) {
          errors.push(`${label}: distinctness 설명이 비어 있습니다.`);
        }
      }

      const confidence = candidate.researchConfidence;
      if (
        typeof confidence !== 'number' ||
        !Number.isFinite(confidence) ||
        confidence < 0 ||
        confidence > 1
      ) {
        errors.push(`${label}: researchConfidence는 0과 1 사이여야 합니다.`);
      }

      checkSupport(candidate.sourceSupport, label, errors);
    }
  }

  // 채택하지 않은 본문
  const rejectedKeys = new Set<string>();
  if (!Array.isArray(value.rejectedPassages)) {
    errors.push('rejectedPassages가 배열이 아닙니다.');
  } else {
    const count = value.rejectedPassages.length;
    if (count < REJECTED_MIN || count > REJECTED_MAX) {
      errors.push(`채택하지 않은 본문은 ${REJECTED_MIN}~${REJECTED_MAX}개여야 합니다 (지금 ${count}개).`);
    }

    for (const [index, entry] of value.rejectedPassages.entries()) {
      const label = `rejectedPassages[${index}]`;
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        errors.push(`${label}: 객체가 아닙니다.`);
        continue;
      }
      const rejected = entry as Record<string, unknown>;

      for (const key of Object.keys(rejected)) {
        if (!(REJECTED_FIELDS as readonly string[]).includes(key)) {
          errors.push(`${label}: 허용되지 않는 항목이 있습니다 (${key})`);
        }
      }

      const reference = checkReference(rejected.reference, label, errors);
      if (reference) {
        const key = referenceKey(reference);
        if (rejectedKeys.has(key)) errors.push(`${label}: 같은 본문이 두 번 들어 있습니다.`);
        rejectedKeys.add(key);
        if (candidateKeys.has(key)) {
          errors.push(`${label}: 후보와 제외 목록에 같은 본문이 함께 있습니다.`);
        }
      }

      if (!isNonEmptyString(rejected.rejectionReason)) {
        errors.push(`${label}: rejectionReason이 비어 있습니다.`);
      }
      if (typeof rejected.riskCategory !== 'string' || !riskCategories.has(rejected.riskCategory)) {
        errors.push(`${label}: 알 수 없는 riskCategory입니다.`);
      }
    }
  }

  // 모르는 것은 남겨도 된다. 빈 배열도 정상이다.
  if (!isStringArray(value.unresolvedQuestions)) {
    errors.push('unresolvedQuestions가 문자열 목록이 아닙니다.');
  }
}

/**
 * 연구 결과가 규칙을 지켰는지 확인한다.
 *
 * sources는 결과가 아니라 입력이다.
 * Source Harvester가 검증해 넘긴 자료 목록을 그대로 받아서, 결과가 그 안의 sourceId만
 * 가리키는지, 그리고 각 자료가 그 역할을 맡을 자격이 있는지 확인한다.
 *
 * 의뢰서와 다른 영역·근거 버전·판단 시점이면 쓰지 않는다.
 */
export function validateBiblicalResearchResult(
  result: unknown,
  brief: BiblicalResearchBrief,
  sources: readonly ResearchSource[],
): ValidationResult {
  const errors: string[] = [];

  if (typeof result !== 'object' || result === null || Array.isArray(result)) {
    return { valid: false, errors: ['연구 결과가 객체가 아닙니다.'] };
  }

  // 입력 자료 목록. Source Harvester가 만든 것이며 여기서 고치지 않는다.
  const sourceById = new Map<string, ResearchSource>();
  if (!Array.isArray(sources) || sources.length === 0) {
    errors.push('연구에 쓸 자료 목록이 없습니다.');
  } else {
    for (const source of sources) {
      if (typeof source?.sourceId !== 'string' || source.sourceId.length === 0) {
        errors.push('자료 목록에 sourceId가 없는 자료가 있습니다.');
        continue;
      }
      if (sourceById.has(source.sourceId)) {
        errors.push(`자료 목록에 같은 sourceId가 두 번 있습니다 (${source.sourceId})`);
      }
      sourceById.set(source.sourceId, source);
    }
  }

  checkResearchBody(
    result as Record<string, unknown>,
    brief,
    TOP_LEVEL_FIELDS,
    (support, label, list) => checkSourceSupport(support, label, sourceById, list),
    errors,
  );

  return { valid: errors.length === 0, errors };
}

/**
 * 모델이 만든 연구 결과 초안이 규칙을 지켰는지 확인한다.
 *
 * 왜 따로 있는가:
 *   JSON으로 읽혔다는 것과 연구 계약을 지켰다는 것은 다른 말이다.
 *   읽히자마자 BiblicalResearchDraftResult로 단정하면 아무것도 확인하지 않은 것이다.
 *
 * 무엇이 최종 검사와 다른가:
 *   초안에는 꾸러미 지문이 없고, 근거 칸에 자료 id도 없다. 둘 다 서버가 붙인다.
 *   그 두 가지 말고는 같은 규칙을 그대로 쓴다.
 *
 * 무엇을 보지 않는가:
 *   근거가 실제로 꾸러미에 있는지, 그 역할에 맞는지, 그 본문을 다루는지.
 *   그것은 근거에 묶는 단계가 판단한다.
 */
export function validateBiblicalResearchDraftResult(
  draft: unknown,
  brief: BiblicalResearchBrief,
): ValidationResult {
  if (typeof draft !== 'object' || draft === null || Array.isArray(draft)) {
    return { valid: false, errors: ['연구 결과가 객체가 아닙니다.'] };
  }

  const errors: string[] = [];
  checkResearchBody(
    draft as Record<string, unknown>,
    brief,
    DRAFT_TOP_LEVEL_FIELDS,
    checkDraftSourceSupport,
    errors,
  );

  return { valid: errors.length === 0, errors };
}
