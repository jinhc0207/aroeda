/**
 * Situation Analyzer 표준 출력 규격
 *
 * 계약 문서: docs/SITUATION_ANALYZER.md
 *
 * 이번 단계에서는 실제 분석 기능을 만들지 않는다.
 * 앞으로 OpenAI가 돌려줄 결과의 모양과, 그 결과가 규격을 지키는지 확인하는 검증 함수만 둔다.
 */

import { TAXONOMY, unknownTags, type TaxonomyKind } from './analysis-taxonomy.ts';
import { isSituationDomain, type SituationDomain } from './situation-domains.ts';

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
  /** 사용자가 처한 삶의 핵심 상황. 가장 강한 감정을 고르는 자리가 아니다. */
  primaryDomain: SituationDomain;
  /** 복합 상황에서 실제로 함께 존재하는 다른 문제만 넣는다. 없으면 빈 배열. */
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

  // domain은 필수다. primaryDomain은 하나, secondaryDomains는 없으면 빈 배열.
  if (analysis.primaryDomain === undefined) {
    errors.push('primaryDomain이 없습니다.');
  } else if (!isSituationDomain(analysis.primaryDomain)) {
    errors.push(`primaryDomain 값이 표준 domain이 아닙니다: ${String(analysis.primaryDomain)}`);
  }

  if (analysis.secondaryDomains === undefined) {
    errors.push('secondaryDomains가 없습니다. 없으면 빈 배열을 넣습니다.');
  } else {
    if (!Array.isArray(analysis.secondaryDomains)) {
      errors.push('secondaryDomains가 배열이 아닙니다.');
    } else {
      const unknownDomains = analysis.secondaryDomains.filter(
        (domain) => !isSituationDomain(domain),
      );
      if (unknownDomains.length > 0) {
        errors.push(
          `secondaryDomains에 표준 domain이 아닌 값이 있습니다: ${unknownDomains.map(String).join(', ')}`,
        );
      }
      if (new Set(analysis.secondaryDomains).size !== analysis.secondaryDomains.length) {
        errors.push('secondaryDomains에 같은 domain이 중복되어 있습니다.');
      }
      if (
        analysis.primaryDomain !== undefined &&
        analysis.secondaryDomains.includes(analysis.primaryDomain)
      ) {
        errors.push('secondaryDomains에 primaryDomain이 중복으로 들어 있습니다.');
      }
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
