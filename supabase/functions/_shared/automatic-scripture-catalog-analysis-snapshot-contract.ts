/**
 * 자동 Scripture Catalog — 고정 분석 스냅샷 계약 (v1)
 *
 * 무엇을 위한 것인가
 *   자동 validator의 `safetyBoundary`·`corpusRegression` 두 결정적 검사는 지금 실행기 자리만
 *   있고 그 안을 채울 판단 근거가 없다(docs/AUTOMATIC_SCRIPTURE_CATALOG_FOUNDATION_2026-09-15.md
 *   §10). adapter가 자기 일관된 payload를 스스로 만들어도, 오늘의 검증 기록 재확인은 그 payload의
 *   모양만 보고 원본 코퍼스나 Analyzer를 다시 돌려 확인하지 않는다 — adapter가 양쪽 값을 지어내도
 *   통과한다.
 *
 *   이 파일은 그 공백을 메울 "고정 분석 스냅샷"의 모양과 지문 계산·검증만 정의한다. 여기서
 *   "고정"은 사람이 미리 승인했다는 뜻이 아니다 — 정책은 자동 검증 → 자동 활성화 → 소유자
 *   공지이며 활성화 전 사람 승인을 요구하지 않는다. Git에 고정한 합성 문장과, 자동으로 만든 뒤
 *   독립적으로 검증할 `SituationAnalysis`를 동결해 하나로 묶어, 코퍼스나 분석이나 실행 환경 중
 *   무엇 하나가 바뀌어도 지문이 달라지게 한다.
 *
 * 이 파일이 하지 않는 일
 *   실제 스냅샷 데이터를 만들지 않는다. Gate나 Matcher를 실행하지 않는다. executor나
 *   `validateAutomaticValidationRecord`에 연결하지 않는다. DB에 쓰지 않는다. OpenAI를 부르지
 *   않는다. 이 계약만으로는 자동 활성화가 열리지 않는다 — 아래 "아직 하지 않은 것" 참고.
 *
 * candidate_generation은 왜 없는가
 *   후보 카드별 생성 사례는 후보가 생길 때마다 새로 생기므로 이 파일처럼 Git에 미리 고정할 수
 *   없다. 후속 작업에서 append-only DB 기록으로 설계하며, 최소한 다음 값에 결속돼야 한다.
 *     - candidateHash (automatic-scripture-catalog-contract.ts의 CATALOG_CANDIDATE_HASH_FORMAT)
 *     - 후보의 research-result artifact hash (research-result-store-contract.ts)
 *     - 자동 사례 저작 profile과 그 profile의 independence group
 *       (오늘의 validator-registry.ts는 후보 생성 모델과 사례 저작 모델을 구분하는 장치가 없다 —
 *       사례를 후보 생성 모델이 스스로 짓는 자기 채점을 막으려면 이 결속이 반드시 필요하다)
 *     - 분석 환경 지문(아래 AnalysisSnapshotEnvironmentBinding과 같은 종류)
 *   이 파일은 이 사실을 문서로만 남긴다. `validateAnalysisSnapshot`은 kind가
 *   candidate_generation인 사례를 명시적으로 거절한다.
 *
 * 개인정보 경계
 *   이 경로는 라이브 사용자 입력을 받지 않는다 — cases는 Git에 고정한 합성 문장만 담는다.
 *   `SituationAnalysis`에는 사용자 식별자·원문 필드가 애초에 없고, 이 파일의 스키마 어디에도
 *   사용자 id·세션·토큰·raw 응답이 들어갈 필드 자리가 없다(exactFields가 스키마에 없는 모든
 *   필드를 거절한다). 사례 `text` 값 자체는 scanForbiddenContent로 이메일·jwt·ip·uuid·비밀키
 *   패턴을 추가로 확인한다. 다만 이 계약은 형식·자리·패턴만 볼 뿐, 문장의 의미를 읽어 "이것이
 *   진짜 합성 문장인가"까지 판단하지 않는다 — PII 부재를 의미적으로 완전히 증명하지 않는다.
 *
 * 아직 하지 않은 것 (후속 작업)
 *   - 실제 스냅샷 데이터 생성(자동 생성 + 독립 검증 예정 — 자동 producer profile과 독립성
 *     attestation을 registry에 등록하는 것은 후속 작업이다. 사람 승인 단계를 끼워 넣는 뜻이 아니다)과
 *     Git 커밋
 *   - `automatic-scripture-catalog-validator-executor.ts`의 DeterministicAdapters 구현과 연결
 *   - `validateAutomaticValidationRecord`가 이 스냅샷의 지문을 실제로 재확인하도록 강화
 *   - 새 영역(`new_domain_with_cards`) 후보의 생성 증거는 별도 후보별 동적 manifest를 쓴다.
 *     이 고정 스냅샷 계약은 기존 156개 회귀 사례와 정적 SituationDomain 목록만 표현한다.
 *   자동 producer profile과 독립성 attestation이 registry에 연결되기 전까지는, 이 계약이
 *   존재한다는 사실이 activation-ready를 뜻하지 않는다.
 */

import {
  ARTIFACT_HASH_FORMAT,
  CARD_ID_FORMAT,
  CATALOG_VERSION_HASH_FORMAT,
  canonicalJson,
  computeArtifactHash,
  scanForbiddenContent,
} from './automatic-scripture-catalog-contract.ts';
import { CASE_ID_FORMAT, GATE_ROUTES } from './automatic-scripture-catalog-activation-contract.ts';
import {
  SAFETY_CATEGORIES,
  SAFETY_LEVELS,
  type SafetyAssessment,
  type SituationAnalysis,
  validateSituationAnalysis,
} from './situation-analysis.ts';
import { FALLBACK_DOMAIN, isSituationDomain, type SituationDomain } from './situation-domains.ts';

/* ------------------------------------------------------------------ */
/* 이름과 모양                                                          */
/* ------------------------------------------------------------------ */

export const ANALYSIS_SNAPSHOT_CONTRACT_VERSION = 'scripture-catalog-analysis-snapshot/v1';

/** 이 계약이 Git에 고정하는 사례 종류. */
export const ANALYSIS_SNAPSHOT_CASE_KINDS = ['safety_boundary', 'corpus_regression'] as const;
export type AnalysisSnapshotCaseKind = (typeof ANALYSIS_SNAPSHOT_CASE_KINDS)[number];

/** 아직 이 계약이 담지 않는 종류. 문서화 목적으로만 남긴다 — 위 파일 머리말 참고. */
export const DEFERRED_ANALYSIS_SNAPSHOT_CASE_KINDS = ['candidate_generation'] as const;

const SNAPSHOT_CASE_TEXT_MAX = 300;

/** 사례 문장은 합성 문장이다. 자리 자체가 사용자 원문·식별자를 담을 수 없다 — PERSONAL_DATA_KEYS 참고. */
const isSyntheticText = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.trim().length > 0 &&
  value === value.trim() &&
  value.length <= SNAPSHOT_CASE_TEXT_MAX;

const isNonEmptyShortText = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value === value.trim() && value.length <= max;

/**
 * 실행 환경 한 항목의 결속. `recommendationGate`·`scriptureMatcher`처럼 오늘 저장소에
 * 지문을 낼 산출물이 따로 없는 항목은 명시적 version 문자열로, 산출물이 있는 항목은
 * artifact hash로 결속할 수 있다.
 */
export type EnvironmentArtifactBinding =
  | { kind: 'artifact_hash'; artifactHash: string }
  | { kind: 'version'; version: string };

/**
 * 스냅샷이 어떤 실행 환경에서 만들어졌는지 결속한다. 이 중 하나라도 지금 저장소의 실제 값과
 * 달라지면(analyzer-contract.ts의 모델·프롬프트·스키마, analysis-taxonomy.ts, 정적 domain
 * 목록, Gate/Matcher, 기준 카탈로그) 스냅샷은 무효로 봐야 한다. 이 파일은 "지금 값과 같은가"를
 * 확인하지 않는다 — 그건 실행기 연결 단계의 몫이다. 이 파일은 "스냅샷 안에서 이 값들이 통째로
 * 지문에 결속돼 있어 몰래 바뀔 수 없는가"만 보장한다.
 */
export type AnalysisSnapshotEnvironmentBinding = {
  analyzerModel: string;
  analyzerInstructionsHash: string;
  analyzerSchemaHash: string;
  analysisTaxonomyHash: string;
  /** 오늘은 정적 SituationDomain 목록의 지문이다. 동적 manifest 도입 전까지는 이 값이 전부다. */
  analyzerDomainManifestHash: string;
  recommendationGate: EnvironmentArtifactBinding;
  scriptureMatcher: EnvironmentArtifactBinding;
  baselineCatalogVersionHash: string;
};

type AnalysisSnapshotCaseCommon = {
  /** CASE_ID_FORMAT. cases 배열 안에서 오름차순 정렬·중복 없음이 강제된다. */
  caseId: string;
  /** 합성 문장. 실제 사용자 문장을 담지 않는다. */
  text: string;
  /** 동결된 분석. 타입상 맞아 보여도 validateAnalysisSnapshot은 매번 validateSituationAnalysis로 다시 확인한다. */
  analysis: SituationAnalysis;
};

/**
 * safetyBoundary는 후보 카드 품질을 증명하지 않는다. Gate의 안전 판정(STEP 1)은 candidate
 * 카드를 보기 전에 끝나므로, 이 사례는 전체 추천 파이프라인이 안전 경계를 올바르게 지키는지
 * 보는 후보-무관 전역 회귀 가드다. expectedRoute가 항상 'safety'일 필요는 없다 — 위험하지
 * 않은데도 과도하게 안전 경로로 넘기지 않는지 보는 경계 사례도 포함할 수 있다.
 */
export type SafetyBoundaryCaseExpectation = {
  expectedRoute: (typeof GATE_ROUTES)[number];
  expectedSafety: SafetyAssessment;
};

export type SafetyBoundarySnapshotCase = AnalysisSnapshotCaseCommon & {
  kind: 'safety_boundary';
  expected: SafetyBoundaryCaseExpectation;
};

/**
 * corpusRegression 기대값. 기존 153개 자연어 평가 코퍼스(scripts/scripture-recommendation-
 * evaluation-cases.ts)의 RecommendationExpectation/DomainChoiceExpectation/NoCoverageExpectation과
 * 같은 정보를 표현한다. Edge Function은 scripts/ 폴더 바깥을 참조할 수 없으므로 타입을 그대로
 * import하지 않고 이 파일 안에 같은 뜻으로 다시 정의한다. 오늘의 153개 코퍼스는 'safety'·
 * 'ambiguous' route를 쓰지 않으므로 이 v1에는 넣지 않았다 — 필요해지면 확장한다.
 */
export type CorpusRegressionCaseExpectation =
  | {
      expectedRoute: 'recommend';
      expectedPrimaryDomain: SituationDomain;
      preferredCardId: string;
      acceptableCardIds: readonly string[];
    }
  | {
      expectedRoute: 'domain_choice';
      expectedPrimaryDomain: null;
      expectedDomainChoiceCandidates: readonly [SituationDomain, SituationDomain];
    }
  | {
      expectedRoute: 'no_coverage';
      /** null은 추가 정보 필요, other_uncovered는 실제 지원 범위 밖을 뜻한다. */
      expectedPrimaryDomain: typeof FALLBACK_DOMAIN | null;
    };

export type CorpusRegressionSnapshotCase = AnalysisSnapshotCaseCommon & {
  kind: 'corpus_regression';
  expected: CorpusRegressionCaseExpectation;
};

export type AnalysisSnapshotCase = SafetyBoundarySnapshotCase | CorpusRegressionSnapshotCase;

/**
 * Git에 고정하는 분석 스냅샷. "고정"은 사람 승인을 뜻하지 않는다 — 자동으로 생성되고
 * 독립적으로 검증될 예정이다(사람 승인 필드는 이 타입 어디에도 없다). safety_boundary와
 * corpus_regression 사례를 함께 담을 수 있지만, 이 계약은 "저장 모양과 cases와의 정합성이
 * 올바른가"만 본다 — 두 종류를 실행 시점에 절대 합치지 않고 safety_boundary를 가장 먼저
 * 실행하는 것은 이 계약을 소비하는 쪽(실행기, 아직 미연결)의 책임이다.
 */
export type FrozenAnalysisSnapshot = {
  contractVersion: typeof ANALYSIS_SNAPSHOT_CONTRACT_VERSION;
  /**
   * cases마다 {caseId, kind, text, expected}만 뽑은 목록의 지문. ARTIFACT_HASH_FORMAT.
   * `computeSourceCorpusArtifactHash(cases)`와 정확히 같아야 한다 — validateAnalysisSnapshot이
   * cases에서 직접 재계산해 대조하므로, 이 값을 cases와 무관하게 지어내면 거절된다.
   */
  sourceCorpusArtifactHash: string;
  /**
   * cases마다 {caseId, analysis}만 뽑은 목록의 지문. ARTIFACT_HASH_FORMAT.
   * `computeFrozenAnalysisArtifactHash(cases)`와 정확히 같아야 한다. 코퍼스(문장·기대값)는
   * 그대로인데 분석만 다시 만들어진 경우와, 코퍼스 자체가 바뀐 경우를 구분해 알아볼 수 있게
   * 위 sourceCorpusArtifactHash와 분리했다.
   */
  frozenAnalysisArtifactHash: string;
  environment: AnalysisSnapshotEnvironmentBinding;
  /** caseId 오름차순, 중복 없음. */
  cases: readonly AnalysisSnapshotCase[];
  /** computeAnalysisSnapshotFingerprint의 결과와 정확히 같아야 한다. */
  fingerprint: string;
};

export type AnalysisSnapshotValidationResult = { valid: boolean; errors: string[] };

/* ------------------------------------------------------------------ */
/* 공통 검사 도구 (이 파일 전용 — 저장소의 다른 계약 파일들과 같은 관례)         */
/* ------------------------------------------------------------------ */

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isHash = (value: unknown, format: RegExp): value is string => typeof value === 'string' && format.test(value);

function exactFields(value: Record<string, unknown>, fields: readonly string[], label: string): string[] {
  const errors: string[] = [];
  for (const key of Object.keys(value)) if (!fields.includes(key)) errors.push(`${label}: 계약에 없는 항목입니다: ${key}`);
  for (const key of fields) if (!Object.hasOwn(value, key)) errors.push(`${label}: 빠진 항목입니다: ${key}`);
  return errors;
}

const TOP_LEVEL_FIELDS = [
  'contractVersion',
  'sourceCorpusArtifactHash',
  'frozenAnalysisArtifactHash',
  'environment',
  'cases',
  'fingerprint',
] as const;

const ENVIRONMENT_FIELDS = [
  'analyzerModel',
  'analyzerInstructionsHash',
  'analyzerSchemaHash',
  'analysisTaxonomyHash',
  'analyzerDomainManifestHash',
  'recommendationGate',
  'scriptureMatcher',
  'baselineCatalogVersionHash',
] as const;

const ARTIFACT_BINDING_HASH_FIELDS = ['kind', 'artifactHash'] as const;
const ARTIFACT_BINDING_VERSION_FIELDS = ['kind', 'version'] as const;

const CASE_COMMON_FIELDS = ['caseId', 'kind', 'text', 'analysis', 'expected'] as const;

/**
 * `SituationAnalysis`가 허용하는 필드 전체. 공용 `situation-analysis.ts`의 타입과 같은 뜻이지만,
 * 그 파일은 수정하지 않는다 — `validateSituationAnalysis`는 알려진 필드의 값만 검사할 뿐 여분의
 * 필드를 거절하지 않으므로(§9-10 수정 5), 이 계약 안에서만 exact-fields로 별도로 막는다.
 */
const SITUATION_ANALYSIS_FIELDS = [
  'domainPriority',
  'primaryDomain',
  'domainChoiceCandidates',
  'secondaryDomains',
  'situationTags',
  'emotionTags',
  'spiritualQuestionTags',
  'prayerModes',
  'pastoralFunctions',
  'safety',
  'confidence',
] as const;

const SAFETY_EXPECTATION_FIELDS = ['expectedRoute', 'expectedSafety'] as const;
/** `analysis.safety`와 `expected.expectedSafety` 둘 다 이 필드만 허용한다. */
const SAFETY_ASSESSMENT_FIELDS = ['level', 'categories'] as const;

const CORPUS_RECOMMEND_FIELDS = ['expectedRoute', 'expectedPrimaryDomain', 'preferredCardId', 'acceptableCardIds'] as const;
const CORPUS_DOMAIN_CHOICE_FIELDS = ['expectedRoute', 'expectedPrimaryDomain', 'expectedDomainChoiceCandidates'] as const;
const CORPUS_NO_COVERAGE_FIELDS = ['expectedRoute', 'expectedPrimaryDomain'] as const;

function validateEnvironmentArtifactBinding(value: unknown, label: string): string[] {
  if (!isPlainObject(value)) return [`${label}: 객체가 아닙니다.`];
  if (value.kind === 'artifact_hash') {
    const errors = exactFields(value, ARTIFACT_BINDING_HASH_FIELDS, label);
    if (!isHash(value.artifactHash, ARTIFACT_HASH_FORMAT)) errors.push(`${label}.artifactHash: 형식이 올바르지 않습니다.`);
    return errors;
  }
  if (value.kind === 'version') {
    const errors = exactFields(value, ARTIFACT_BINDING_VERSION_FIELDS, label);
    if (!isNonEmptyShortText(value.version, 64)) errors.push(`${label}.version: 빈 값이거나 너무 깁니다.`);
    return errors;
  }
  return [`${label}.kind: 'artifact_hash' 또는 'version'이어야 합니다.`];
}

function validateEnvironmentBinding(value: unknown): string[] {
  if (!isPlainObject(value)) return ['environment: 객체가 아닙니다.'];
  const errors = exactFields(value, ENVIRONMENT_FIELDS, 'environment');

  if (!isNonEmptyShortText(value.analyzerModel, 64)) errors.push('environment.analyzerModel: 빈 값이거나 너무 깁니다.');
  for (const field of ['analyzerInstructionsHash', 'analyzerSchemaHash', 'analysisTaxonomyHash', 'analyzerDomainManifestHash'] as const) {
    if (!isHash(value[field], ARTIFACT_HASH_FORMAT)) errors.push(`environment.${field}: 형식이 올바르지 않습니다.`);
  }
  if (!isHash(value.baselineCatalogVersionHash, CATALOG_VERSION_HASH_FORMAT)) {
    errors.push('environment.baselineCatalogVersionHash: 형식이 올바르지 않습니다.');
  }
  errors.push(...validateEnvironmentArtifactBinding(value.recommendationGate, 'environment.recommendationGate'));
  errors.push(...validateEnvironmentArtifactBinding(value.scriptureMatcher, 'environment.scriptureMatcher'));

  return errors;
}

function validateSafetyAssessmentShape(value: unknown, label: string): string[] {
  if (!isPlainObject(value)) return [`${label}: 객체가 아닙니다.`];
  const errors = exactFields(value, SAFETY_ASSESSMENT_FIELDS, label);
  const level = value.level;
  const categories = value.categories;
  const levelKnown = typeof level === 'string' && (SAFETY_LEVELS as readonly string[]).includes(level);
  if (!levelKnown) errors.push(`${label}.level: 허용되지 않는 값입니다: ${String(level)}`);
  if (!Array.isArray(categories) || categories.some((item) => typeof item !== 'string' || !(SAFETY_CATEGORIES as readonly string[]).includes(item))) {
    errors.push(`${label}.categories: 허용되지 않는 값이 있습니다.`);
  } else {
    if (new Set(categories).size !== categories.length) errors.push(`${label}.categories: 중복된 값이 있습니다.`);
    if (levelKnown && level === 'normal' && categories.length > 0) errors.push(`${label}: level이 normal이면 categories는 비어 있어야 합니다.`);
    if (levelKnown && level !== 'normal' && categories.length === 0) errors.push(`${label}: level이 ${String(level)}이면 categories가 최소 하나 있어야 합니다.`);
  }
  return errors;
}

function validateCaseExpectation(kind: AnalysisSnapshotCaseKind, value: unknown, label: string): string[] {
  if (!isPlainObject(value)) return [`${label}: 객체가 아닙니다.`];

  if (kind === 'safety_boundary') {
    const errors = exactFields(value, SAFETY_EXPECTATION_FIELDS, label);
    if (!(GATE_ROUTES as readonly unknown[]).includes(value.expectedRoute)) {
      errors.push(`${label}.expectedRoute: 허용되지 않는 값입니다: ${String(value.expectedRoute)}`);
    }
    errors.push(...validateSafetyAssessmentShape(value.expectedSafety, `${label}.expectedSafety`));
    return errors;
  }

  // corpus_regression
  if (value.expectedRoute === 'recommend') {
    const errors = exactFields(value, CORPUS_RECOMMEND_FIELDS, label);
    if (!isSituationDomain(value.expectedPrimaryDomain) || value.expectedPrimaryDomain === FALLBACK_DOMAIN) {
      errors.push(`${label}.expectedPrimaryDomain: recommend 경로에 맞는 표준 domain이 아닙니다.`);
    }
    if (!isHash(value.preferredCardId, CARD_ID_FORMAT)) errors.push(`${label}.preferredCardId: 카드 id 형식이 아닙니다.`);
    if (
      !Array.isArray(value.acceptableCardIds) ||
      value.acceptableCardIds.length === 0 ||
      value.acceptableCardIds.some((id: unknown) => !isHash(id, CARD_ID_FORMAT)) ||
      new Set(value.acceptableCardIds).size !== value.acceptableCardIds.length ||
      (typeof value.preferredCardId === 'string' && !value.acceptableCardIds.includes(value.preferredCardId))
    ) {
      errors.push(`${label}.acceptableCardIds: preferredCardId를 포함한, 중복 없는 카드 id 목록이어야 합니다.`);
    }
    return errors;
  }

  if (value.expectedRoute === 'domain_choice') {
    const errors = exactFields(value, CORPUS_DOMAIN_CHOICE_FIELDS, label);
    if (value.expectedPrimaryDomain !== null) errors.push(`${label}.expectedPrimaryDomain: domain_choice면 null이어야 합니다.`);
    const candidates = value.expectedDomainChoiceCandidates;
    if (
      !Array.isArray(candidates) ||
      candidates.length !== 2 ||
      candidates.some((domain) => !isSituationDomain(domain) || domain === FALLBACK_DOMAIN) ||
      candidates[0] === candidates[1]
    ) {
      errors.push(`${label}.expectedDomainChoiceCandidates: 서로 다른 표준 domain 정확히 2개여야 합니다.`);
    }
    return errors;
  }

  if (value.expectedRoute === 'no_coverage') {
    const errors = exactFields(value, CORPUS_NO_COVERAGE_FIELDS, label);
    if (value.expectedPrimaryDomain !== FALLBACK_DOMAIN && value.expectedPrimaryDomain !== null) {
      errors.push(`${label}.expectedPrimaryDomain: no_coverage면 '${FALLBACK_DOMAIN}' 또는 null이어야 합니다.`);
    }
    return errors;
  }

  return [`${label}.expectedRoute: corpus_regression에서 허용되지 않는 값입니다: ${String(value.expectedRoute)}`];
}

/**
 * `analysis`(그리고 `analysis.safety`)에 `SituationAnalysis`가 선언하지 않은 여분의 필드가
 * 없는지 본다. 공용 `validateSituationAnalysis`는 알려진 필드의 값만 검사할 뿐, 거기 없는
 * 필드가 얹혀 있어도 거절하지 않는다 — `rawResponse`·`userId`·`sessionId` 같은 값을 frozen
 * analysis 자리에 얹어도 그 함수 혼자서는 잡지 못한다(§9-10 수정 5). 이 계약은 공용 파일을 고치지
 * 않고 이 안에서만 그 여분의 필드를 막는다.
 */
export function validateFrozenSituationAnalysisShape(value: unknown, label: string): string[] {
  if (!isPlainObject(value)) return [`${label}: 객체가 아닙니다.`];
  const errors = exactFields(value, SITUATION_ANALYSIS_FIELDS, label);
  if (isPlainObject(value.safety)) {
    errors.push(...exactFields(value.safety, SAFETY_ASSESSMENT_FIELDS, `${label}.safety`));
  }
  return errors;
}

/**
 * frozen analysis와 expected가 서로 다른 이야기를 하지 않는지 본다. `validateSituationAnalysis`와
 * `validateCaseExpectation`이 각각 자기 모양은 맞다고 확인해 준 뒤에만 부른다 — 그래야
 * `analysis.safety`·`analysis.primaryDomain` 같은 값에 안전하게 접근할 수 있다.
 *
 * 이 검사가 없으면(수정 전 상태) safety_boundary 사례가 `analysis.safety.level = 'urgent'`이면서
 * `expectedRoute = 'recommend'`·`expectedSafety.level = 'normal'`이라고 우겨도 통과했다 —
 * 두 값이 서로 다른 사건을 가리켜도 형식만 맞으면 막지 못했다.
 */
function validateCrossConsistency(
  kind: AnalysisSnapshotCaseKind,
  analysis: SituationAnalysis,
  expected: SafetyBoundaryCaseExpectation | CorpusRegressionCaseExpectation,
  label: string,
): string[] {
  const errors: string[] = [];

  if (kind === 'safety_boundary') {
    const exp = expected as SafetyBoundaryCaseExpectation;
    if (canonicalJson(analysis.safety) !== canonicalJson(exp.expectedSafety)) {
      errors.push(`${label}: expectedSafety가 analysis.safety와 canonical 값까지 정확히 같아야 합니다.`);
    }
    if (analysis.safety.level !== 'normal' && exp.expectedRoute !== 'safety') {
      errors.push(`${label}: analysis.safety.level이 normal이 아니면 expectedRoute는 반드시 safety여야 합니다.`);
    }
    if (analysis.safety.level === 'normal' && exp.expectedRoute === 'safety') {
      errors.push(`${label}: analysis.safety.level이 normal이면 expectedRoute는 safety일 수 없습니다.`);
    }
    return errors;
  }

  // corpus_regression — 이 종류는 안전 route를 표현하지 않는다.
  const exp = expected as CorpusRegressionCaseExpectation;
  if (analysis.safety.level !== 'normal') {
    errors.push(`${label}: corpus_regression 사례는 analysis.safety.level이 normal이어야 합니다(안전 route를 표현하지 않는다).`);
  }

  if (exp.expectedRoute === 'recommend') {
    if (analysis.domainPriority !== 'resolved') {
      errors.push(`${label}: expectedRoute가 recommend면 analysis.domainPriority가 resolved여야 합니다.`);
    }
    if (analysis.primaryDomain !== exp.expectedPrimaryDomain) {
      errors.push(`${label}: analysis.primaryDomain이 expectedPrimaryDomain과 정확히 같아야 합니다.`);
    }
    if (analysis.primaryDomain === FALLBACK_DOMAIN) {
      errors.push(`${label}: recommend의 primary domain은 '${FALLBACK_DOMAIN}'일 수 없습니다.`);
    }
  } else if (exp.expectedRoute === 'domain_choice') {
    if (analysis.domainPriority !== 'needs_choice') {
      errors.push(`${label}: expectedRoute가 domain_choice면 analysis.domainPriority가 needs_choice여야 합니다.`);
    }
    if (analysis.primaryDomain !== null) {
      errors.push(`${label}: expectedRoute가 domain_choice면 analysis.primaryDomain이 null이어야 합니다.`);
    }
    if (canonicalJson(exp.expectedDomainChoiceCandidates) !== canonicalJson(analysis.domainChoiceCandidates)) {
      errors.push(`${label}: expectedDomainChoiceCandidates가 analysis.domainChoiceCandidates와 순서까지 정확히 같아야 합니다.`);
    }
  } else if (exp.expectedRoute === 'no_coverage') {
    if (exp.expectedPrimaryDomain === null) {
      if (analysis.domainPriority !== 'needs_detail') {
        errors.push(`${label}: expectedPrimaryDomain이 null인 no_coverage면 analysis.domainPriority가 needs_detail이어야 합니다.`);
      }
      if (analysis.primaryDomain !== null) {
        errors.push(`${label}: expectedPrimaryDomain이 null인 no_coverage면 analysis.primaryDomain이 null이어야 합니다.`);
      }
    } else {
      if (analysis.domainPriority !== 'resolved') {
        errors.push(`${label}: 실제 범위 밖 no_coverage면 analysis.domainPriority가 resolved여야 합니다.`);
      }
      if (analysis.primaryDomain !== FALLBACK_DOMAIN) {
        errors.push(`${label}: 실제 범위 밖 no_coverage면 analysis.primaryDomain이 '${FALLBACK_DOMAIN}'이어야 합니다.`);
      }
    }
  }

  return errors;
}

function validateCase(value: unknown, label: string): string[] {
  if (!isPlainObject(value)) return [`${label}: 객체가 아닙니다.`];

  if ((DEFERRED_ANALYSIS_SNAPSHOT_CASE_KINDS as readonly unknown[]).includes(value.kind)) {
    return [`${label}.kind: candidate_generation은 이 스냅샷 계약이 지원하지 않습니다. 후보별 생성 사례는 별도 append-only 기록으로 설계한다.`];
  }
  if (!(ANALYSIS_SNAPSHOT_CASE_KINDS as readonly unknown[]).includes(value.kind)) {
    return [`${label}.kind: 허용되지 않는 값입니다: ${String(value.kind)}`];
  }
  const kind = value.kind as AnalysisSnapshotCaseKind;

  const errors = exactFields(value, CASE_COMMON_FIELDS, label);
  if (!isHash(value.caseId, CASE_ID_FORMAT)) errors.push(`${label}.caseId: 형식이 올바르지 않습니다.`);
  if (!isSyntheticText(value.text)) {
    errors.push(`${label}.text: 빈 값이거나 너무 깁니다.`);
  } else {
    // 값 자체가 이메일·jwt·ip·uuid·비밀키처럼 보이는지만 본다. 이 파일의 스키마는 애초에
    // 사용자 식별자·세션·토큰이 들어갈 필드 자리가 없다(exactFields가 그 자리를 막는다) —
    // 여기서는 "합성 문장이어야 할 자리에 그런 값이 실제로 섞였는가"만 본다.
    errors.push(...scanForbiddenContent(value.text, `${label}.text`));
  }

  // 1~3단계: analysis(그리고 analysis.safety)에 여분의 필드가 없는지 먼저 본다.
  const analysisShapeErrors = validateFrozenSituationAnalysisShape(value.analysis, `${label}.analysis`);
  errors.push(...analysisShapeErrors);

  // 4단계: 알려진 필드들의 값 자체가 규격을 지키는지는 공용 validateSituationAnalysis에 맡긴다.
  const analysisCheck = validateSituationAnalysis(value.analysis);
  if (!analysisCheck.valid) {
    errors.push(...analysisCheck.errors.map((message) => `${label}.analysis: ${message}`));
  }

  // 5단계: expectation 모양, 그다음 analysis·expected 교차 일관성.
  const expectationErrors = validateCaseExpectation(kind, value.expected, `${label}.expected`);
  errors.push(...expectationErrors);

  // 세 모양(analysis 여분 필드 없음·analysis 값 규격·expected 모양)이 각각 맞다고 확인된
  // 뒤에만 서로 같은 이야기를 하는지 본다 — 모양이 이미 어긋난 analysis·expected에
  // 안전하지 않게 접근하지 않기 위해서다.
  if (analysisShapeErrors.length === 0 && analysisCheck.valid && expectationErrors.length === 0) {
    errors.push(
      ...validateCrossConsistency(
        kind,
        value.analysis as SituationAnalysis,
        value.expected as SafetyBoundaryCaseExpectation | CorpusRegressionCaseExpectation,
        label,
      ),
    );
  }

  return errors;
}

/**
 * 사례 하나(`{caseId, kind, text, analysis, expected}`)만 독립적으로 검증하고 싶은
 * 호출자를 위해 내부 `validateCase`를 그대로(로직을 복제하지 않고) 공개한다 — exact-fields,
 * caseId 형식, 금지 패턴, `analysis`·`analysis.safety`의 exact-fields, 공용
 * `validateSituationAnalysis`, 그리고 `analysis`와 `expected`의 교차 일관성까지 전부
 * `validateAnalysisSnapshot`이 스냅샷 전체를 볼 때와 정확히 같은 규칙으로 확인한다.
 *
 * 예: 재개 가능한 실행기(automatic-scripture-catalog-analysis-snapshot-runner.ts)가 모델
 * 분석 결과 하나를 체크포인트에 넣기 전에, 스냅샷 전체를 만들지 않고도 이 함수로 미리
 * 검증한다.
 */
export function validateAnalysisSnapshotCase(value: unknown, label = 'case'): AnalysisSnapshotValidationResult {
  const errors = validateCase(value, label);
  return { valid: errors.length === 0, errors };
}

/* ------------------------------------------------------------------ */
/* 지문                                                                 */
/* ------------------------------------------------------------------ */

/**
 * cases마다 {caseId, kind, text, expected}만 뽑아 지문을 낸다 — frozen analysis는 뺀,
 * "무엇을 물었고 무엇을 기대했는가"만의 원본이다. `validateAnalysisSnapshot`이 저장된
 * `sourceCorpusArtifactHash`를 이 값과 직접 대조하므로, cases와 무관한 임의의 해시를
 * 넣어 두면 (top-level fingerprint를 아무리 다시 맞춰도) 거절된다.
 */
export async function computeSourceCorpusArtifactHash(cases: readonly AnalysisSnapshotCase[]): Promise<string> {
  return computeArtifactHash(
    cases.map((item) => ({ caseId: item.caseId, kind: item.kind, text: item.text, expected: item.expected })),
  );
}

/**
 * cases마다 {caseId, analysis}만 뽑아 지문을 낸다. `validateAnalysisSnapshot`이 저장된
 * `frozenAnalysisArtifactHash`를 이 값과 직접 대조한다 — 코퍼스(문장·기대값)는 그대로 두고
 * 분석만 다시 만들었을 때, 그 변화가 이 지문에만 나타나고 source corpus 지문에는 나타나지
 * 않는 것이 정상이다.
 */
export async function computeFrozenAnalysisArtifactHash(cases: readonly AnalysisSnapshotCase[]): Promise<string> {
  return computeArtifactHash(cases.map((item) => ({ caseId: item.caseId, analysis: item.analysis })));
}

/**
 * fingerprint 자기 자신을 뺀 나머지 전체에서 결정적으로 계산한다. canonicalJson이 객체 key
 * 순서에는 흔들리지 않으면서 배열(cases) 순서는 그대로 지문에 반영하므로, cases 하나의 text·
 * analysis·expected 또는 environment 값 하나만 바뀌어도 다른 지문이 나온다.
 *
 * 이 함수만으로는 sourceCorpusArtifactHash·frozenAnalysisArtifactHash "자체"가 cases에서
 * 정직하게 나온 값인지 보증하지 못한다 — 두 값을 무엇으로 채우든 그 값 그대로를 지문에 섞을
 * 뿐이다. 그 정직성은 `computeSourceCorpusArtifactHash`/`computeFrozenAnalysisArtifactHash`로
 * cases에서 직접 재계산해 대조하는 `validateAnalysisSnapshot`의 몫이다.
 */
export async function computeAnalysisSnapshotFingerprint(
  snapshot: Omit<FrozenAnalysisSnapshot, 'fingerprint'>,
): Promise<string> {
  return computeArtifactHash({
    contractVersion: snapshot.contractVersion,
    sourceCorpusArtifactHash: snapshot.sourceCorpusArtifactHash,
    frozenAnalysisArtifactHash: snapshot.frozenAnalysisArtifactHash,
    environment: snapshot.environment,
    cases: snapshot.cases,
  });
}

/**
 * 고정 분석 스냅샷이 계약을 지키는지 확인한다. 저장된 두 하위 해시(sourceCorpusArtifactHash·
 * frozenAnalysisArtifactHash)를 cases에서 직접 재계산해 대조하고, 그 뒤에야 저장된 top-level
 * fingerprint를 신뢰하지 않고 다시 계산해 대조한다 — 세 해시 중 어느 것도 "형식만 맞으면
 * 통과"하지 않는다. 이 함수가 통과해도 activation이 열리지 않는다 — 파일 머리말
 * "아직 하지 않은 것" 참고.
 */
export async function validateAnalysisSnapshot(value: unknown): Promise<AnalysisSnapshotValidationResult> {
  const errors: string[] = [];

  if (!isPlainObject(value)) return { valid: false, errors: ['snapshot: 객체가 아닙니다.'] };
  errors.push(...exactFields(value, TOP_LEVEL_FIELDS, 'snapshot'));

  if (value.contractVersion !== ANALYSIS_SNAPSHOT_CONTRACT_VERSION) {
    errors.push(`snapshot.contractVersion: '${ANALYSIS_SNAPSHOT_CONTRACT_VERSION}'이어야 합니다.`);
  }
  if (!isHash(value.sourceCorpusArtifactHash, ARTIFACT_HASH_FORMAT)) {
    errors.push('snapshot.sourceCorpusArtifactHash: 형식이 올바르지 않습니다.');
  }
  if (!isHash(value.frozenAnalysisArtifactHash, ARTIFACT_HASH_FORMAT)) {
    errors.push('snapshot.frozenAnalysisArtifactHash: 형식이 올바르지 않습니다.');
  }

  errors.push(...validateEnvironmentBinding(value.environment));

  if (!Array.isArray(value.cases) || value.cases.length === 0) {
    errors.push('snapshot.cases: 비어 있지 않은 배열이어야 합니다.');
  } else {
    const cases = value.cases as unknown[];
    cases.forEach((item, index) => errors.push(...validateCase(item, `snapshot.cases[${index}]`)));

    const caseIds = cases.map((item) => (isPlainObject(item) && typeof item.caseId === 'string' ? item.caseId : null));
    for (let index = 1; index < caseIds.length; index += 1) {
      const previous = caseIds[index - 1];
      const current = caseIds[index];
      if (previous !== null && current !== null && !(previous < current)) {
        errors.push(`snapshot.cases: caseId가 오름차순이 아니거나 중복입니다 (${previous} → ${current}).`);
      }
    }

    // 한 종류만 있는 스냅샷은 safetyBoundary·corpusRegression 중 하나를 아예 검증하지 않은
    // 채로 통과했다는 뜻이다 — 상한이나 정확한 개수는 두지 않고, 두 종류가 각각 최소 1개
    // 있는지만 fail-closed로 본다.
    const kindsPresent = new Set(cases.map((item) => (isPlainObject(item) ? item.kind : null)));
    for (const requiredKind of ANALYSIS_SNAPSHOT_CASE_KINDS) {
      if (!kindsPresent.has(requiredKind)) {
        errors.push(`snapshot.cases: ${requiredKind} 사례가 최소 1개 있어야 합니다.`);
      }
    }
  }

  // 두 하위 해시를 cases에서 직접 재계산해 대조한다. 형식만 맞는 임의의 해시를 넣고 top-level
  // fingerprint만 그 값에 맞춰 다시 계산해도, 여기서 cases와 무관하다는 것이 드러난다.
  // 앞선 검사가 이미 실패했다면(모양이 이미 어긋난 cases 등) 재계산을 시도하지 않는다.
  if (errors.length === 0) {
    const cases = value.cases as readonly AnalysisSnapshotCase[];
    const recomputedSource = await computeSourceCorpusArtifactHash(cases);
    if (recomputedSource !== value.sourceCorpusArtifactHash) {
      errors.push('snapshot.sourceCorpusArtifactHash: cases에서 다시 계산한 값과 다릅니다.');
    }
  }
  if (errors.length === 0) {
    const cases = value.cases as readonly AnalysisSnapshotCase[];
    const recomputedFrozen = await computeFrozenAnalysisArtifactHash(cases);
    if (recomputedFrozen !== value.frozenAnalysisArtifactHash) {
      errors.push('snapshot.frozenAnalysisArtifactHash: cases에서 다시 계산한 값과 다릅니다.');
    }
  }

  if (!isHash(value.fingerprint, ARTIFACT_HASH_FORMAT)) {
    errors.push('snapshot.fingerprint: 형식이 올바르지 않습니다.');
  } else if (errors.length === 0) {
    const recomputed = await computeAnalysisSnapshotFingerprint(value as unknown as FrozenAnalysisSnapshot);
    if (recomputed !== value.fingerprint) {
      errors.push('snapshot.fingerprint: 저장된 값이 다시 계산한 지문과 다릅니다.');
    }
  }

  return { valid: errors.length === 0, errors };
}
