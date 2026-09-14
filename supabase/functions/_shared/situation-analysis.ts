/**
 * Situation Analyzer 표준 출력 규격
 *
 * 계약 문서: docs/SITUATION_ANALYZER.md
 *
 * 이번 단계에서는 실제 분석 기능을 만들지 않는다.
 * 앞으로 OpenAI가 돌려줄 결과의 모양과, 그 결과가 규격을 지키는지 확인하는 검증 함수만 둔다.
 */

import { TAXONOMY, unknownTags, type TaxonomyKind } from './analysis-taxonomy.ts';
import { FALLBACK_DOMAIN, isSituationDomain, type SituationDomain } from './situation-domains.ts';

/**
 * 영역 우선순위 판단 상태.
 *
 * resolved: 문장에서 중심 영역(primaryDomain)을 정할 수 있다.
 * needs_choice: 서로 독립적인 두 영역이 함께 있지만, 문장에서 어느 쪽을 먼저 다룰지 정할 근거가 부족하다.
 *   두 문제의 실제 중요도가 같다고 단정하는 뜻이 아니다. 두 후보의 배열 순서도 우선순위가 아니다.
 */
export const DOMAIN_PRIORITY_STATUSES = ['resolved', 'needs_choice'] as const;
export type DomainPriorityStatus = (typeof DOMAIN_PRIORITY_STATUSES)[number];

/** needs_choice일 때 후보는 정확히 이 개수다. */
export const DOMAIN_CHOICE_CANDIDATE_COUNT = 2;

export const SAFETY_LEVELS = ['normal', 'caution', 'urgent'] as const;
export type SafetyLevel = (typeof SAFETY_LEVELS)[number];

export const SAFETY_CATEGORIES = [
  'self_harm',
  'suicide',
  'violence_to_others',
  'abuse',
  'immediate_danger',
  'urgent_medical',
] as const;
export type SafetyCategory = (typeof SAFETY_CATEGORIES)[number];

export type SafetyAssessment = {
  level: SafetyLevel;
  categories: SafetyCategory[];
};

export type SituationAnalysis = {
  /** 중심 영역을 정할 수 있는지. 조건 관계는 validateSituationAnalysis가 확인한다. */
  domainPriority: DomainPriorityStatus;
  /**
   * 사용자가 처한 삶의 핵심 상황. 가장 강한 감정을 고르는 자리가 아니다.
   * resolved면 반드시 표준 domain, needs_choice면 반드시 null이다.
   */
  primaryDomain: SituationDomain | null;
  /**
   * needs_choice일 때 사용자에게 먼저 다룰 영역을 물어볼 후보. 서로 다른 표준 domain 정확히 2개.
   * other_uncovered는 들어갈 수 없다. resolved면 빈 배열이다. 순서는 우선순위가 아니다.
   */
  domainChoiceCandidates: SituationDomain[];
  /**
   * resolved일 때 복합 상황에서 실제로 함께 존재하는 다른 문제만 넣는다. 없으면 빈 배열.
   * needs_choice면 반드시 빈 배열이다.
   */
  secondaryDomains: SituationDomain[];
  situationTags: string[];
  emotionTags: string[];
  spiritualQuestionTags: string[];
  prayerModes: string[];
  pastoralFunctions: string[];
  safety: SafetyAssessment;
  /** 0~1 */
  confidence: number;
};

export type ValidationResult = {
  valid: boolean;
  errors: string[];
};

const TAG_FIELDS: TaxonomyKind[] = [
  'situationTags',
  'emotionTags',
  'spiritualQuestionTags',
  'prayerModes',
  'pastoralFunctions',
];

const safetyLevelSet = new Set<string>(SAFETY_LEVELS);
const safetyCategorySet = new Set<string>(SAFETY_CATEGORIES);

/**
 * 분석 결과가 표준 규격을 지키는지 확인한다.
 * 규격을 어긴 이유를 모두 모아서 돌려준다.
 */
export function validateSituationAnalysis(value: unknown): ValidationResult {
  const errors: string[] = [];

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { valid: false, errors: ['분석 결과가 객체가 아닙니다.'] };
  }

  const analysis = value as Record<string, unknown>;

  for (const field of TAG_FIELDS) {
    const tags = analysis[field];
    if (!Array.isArray(tags)) {
      errors.push(`${field}가 배열이 아닙니다.`);
      continue;
    }
    if (tags.some((tag) => typeof tag !== 'string')) {
      errors.push(`${field}에 문자열이 아닌 값이 있습니다.`);
      continue;
    }
    const stringTags = tags as string[];
    if (new Set(stringTags).size !== stringTags.length) {
      errors.push(`${field}에 같은 태그가 중복되어 있습니다.`);
    }
    const unknown = unknownTags(field, stringTags);
    if (unknown.length > 0) {
      errors.push(`${field}에 표준 사전에 없는 태그가 있습니다: ${unknown.join(', ')}`);
    }
  }

  // 영역 우선순위 상태는 필수다. 이 값에 따라 primaryDomain·후보·secondaryDomains의 규칙이 달라진다.
  const priority = analysis.domainPriority;
  const priorityKnown =
    typeof priority === 'string' && (DOMAIN_PRIORITY_STATUSES as readonly string[]).includes(priority);
  if (priority === undefined) {
    errors.push('domainPriority가 없습니다.');
  } else if (!priorityKnown) {
    errors.push(`domainPriority 값이 허용되지 않습니다: ${String(priority)}`);
  }

  // primaryDomain: 값이 있으면 표준 domain이어야 한다. null 허용 여부는 상태별로 아래에서 본다.
  if (analysis.primaryDomain === undefined) {
    errors.push('primaryDomain이 없습니다. needs_choice면 null을 넣습니다.');
  } else if (analysis.primaryDomain !== null && !isSituationDomain(analysis.primaryDomain)) {
    errors.push(`primaryDomain 값이 표준 domain이 아닙니다: ${String(analysis.primaryDomain)}`);
  }

  // domainChoiceCandidates: 항상 배열이어야 한다.
  const candidates = analysis.domainChoiceCandidates;
  const candidatesAreArray = Array.isArray(candidates);
  if (candidates === undefined) {
    errors.push('domainChoiceCandidates가 없습니다. 없으면 빈 배열을 넣습니다.');
  } else if (!candidatesAreArray) {
    errors.push('domainChoiceCandidates가 배열이 아닙니다.');
  } else {
    const unknownCandidates = candidates.filter((domain) => !isSituationDomain(domain));
    if (unknownCandidates.length > 0) {
      errors.push(
        `domainChoiceCandidates에 표준 domain이 아닌 값이 있습니다: ${unknownCandidates.map(String).join(', ')}`,
      );
    }
    if (new Set(candidates).size !== candidates.length) {
      errors.push('domainChoiceCandidates에 같은 domain이 중복되어 있습니다.');
    }
    if (candidates.includes(FALLBACK_DOMAIN)) {
      errors.push(`domainChoiceCandidates에 ${FALLBACK_DOMAIN}은 넣을 수 없습니다.`);
    }
  }

  const secondaryAreArray = Array.isArray(analysis.secondaryDomains);
  if (analysis.secondaryDomains === undefined) {
    errors.push('secondaryDomains가 없습니다. 없으면 빈 배열을 넣습니다.');
  } else {
    if (!secondaryAreArray) {
      errors.push('secondaryDomains가 배열이 아닙니다.');
    } else {
      const secondaryDomains = analysis.secondaryDomains as unknown[];
      const unknownDomains = secondaryDomains.filter((domain) => !isSituationDomain(domain));
      if (unknownDomains.length > 0) {
        errors.push(
          `secondaryDomains에 표준 domain이 아닌 값이 있습니다: ${unknownDomains.map(String).join(', ')}`,
        );
      }
      if (new Set(secondaryDomains).size !== secondaryDomains.length) {
        errors.push('secondaryDomains에 같은 domain이 중복되어 있습니다.');
      }
      if (
        analysis.primaryDomain !== undefined &&
        analysis.primaryDomain !== null &&
        secondaryDomains.includes(analysis.primaryDomain)
      ) {
        errors.push('secondaryDomains에 primaryDomain이 중복으로 들어 있습니다.');
      }
    }
  }

  // 상태별 관계 규칙.
  if (priority === 'resolved') {
    if (analysis.primaryDomain === null) {
      errors.push('domainPriority가 resolved면 primaryDomain이 null이면 안 됩니다.');
    }
    if (candidatesAreArray && (candidates as unknown[]).length > 0) {
      errors.push('domainPriority가 resolved면 domainChoiceCandidates는 비어 있어야 합니다.');
    }
  } else if (priority === 'needs_choice') {
    if (analysis.primaryDomain !== null && analysis.primaryDomain !== undefined) {
      errors.push('domainPriority가 needs_choice면 primaryDomain은 null이어야 합니다.');
    }
    if (candidatesAreArray && (candidates as unknown[]).length !== DOMAIN_CHOICE_CANDIDATE_COUNT) {
      errors.push(
        `domainPriority가 needs_choice면 domainChoiceCandidates는 정확히 ${DOMAIN_CHOICE_CANDIDATE_COUNT}개여야 합니다.`,
      );
    }
    if (secondaryAreArray && (analysis.secondaryDomains as unknown[]).length > 0) {
      errors.push('domainPriority가 needs_choice면 secondaryDomains는 비어 있어야 합니다.');
    }
  }

  const safety = analysis.safety;
  if (typeof safety !== 'object' || safety === null || Array.isArray(safety)) {
    errors.push('safety가 객체가 아닙니다.');
  } else {
    const { level, categories } = safety as Record<string, unknown>;

    if (typeof level !== 'string' || !safetyLevelSet.has(level)) {
      errors.push(`safety.level 값이 허용되지 않습니다: ${String(level)}`);
    }

    if (!Array.isArray(categories)) {
      errors.push('safety.categories가 배열이 아닙니다.');
    } else {
      const unknownCategories = categories.filter(
        (category) => typeof category !== 'string' || !safetyCategorySet.has(category),
      );
      if (unknownCategories.length > 0) {
        errors.push(
          `safety.categories에 허용되지 않은 값이 있습니다: ${unknownCategories.map(String).join(', ')}`,
        );
      }
      if (new Set(categories).size !== categories.length) {
        errors.push('safety.categories에 같은 값이 중복되어 있습니다.');
      }
      // level과 categories가 서로 맞는지 확인한다.
      if (level === 'normal' && categories.length > 0) {
        errors.push('safety.level이 normal이면 categories는 비어 있어야 합니다.');
      }
      if ((level === 'caution' || level === 'urgent') && categories.length === 0) {
        errors.push(`safety.level이 ${level}이면 categories가 최소 하나 있어야 합니다.`);
      }
    }
  }

  const confidence = analysis.confidence;
  if (typeof confidence !== 'number' || !Number.isFinite(confidence)) {
    errors.push('confidence가 숫자가 아닙니다.');
  } else if (confidence < 0 || confidence > 1) {
    errors.push(`confidence는 0과 1 사이여야 합니다: ${confidence}`);
  }

  return { valid: errors.length === 0, errors };
}

/** 검증에 실패하면 오류를 던진다. */
export function assertSituationAnalysis(value: unknown): SituationAnalysis {
  const { valid, errors } = validateSituationAnalysis(value);
  if (!valid) {
    throw new Error(`Situation Analyzer 규격 위반: ${errors.join(' / ')}`);
  }
  return value as SituationAnalysis;
}

/** 표준 태그 사전을 그대로 다시 내보낸다. 프롬프트를 만들 때 사용할 예정이다. */
export { TAXONOMY };
