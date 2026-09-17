/**
 * 자동 Scripture Catalog 활성화 계약 — 수요 evidence, validator profile, attestation, 검증 기록, 활성화, 롤백
 *
 * 무엇을 위한 것인가
 *   automatic-scripture-catalog-contract.ts 가 "카탈로그 한 판"과 "후보 한 건"의 모양을 정했다.
 *   이 파일은 그 후보를 사람의 사전 승인 없이 활성화해도 되는지 판단하는 규칙을 정한다.
 *
 *   판단은 fail-closed다.
 *     필요한 검증이 없거나, 실패했거나, payload에서 다시 계산한 값·지문과 어긋나거나,
 *     등록되지 않은 validator가 판단했거나, 독립 평가가 서로 다른 등록 그룹에서 합의하지 않았거나,
 *     수요 evidence가 실제 집계와 다르거나, 연구 결과가 없거나, 기준 버전이 이미 바뀌었으면 활성화하지 않는다.
 *
 * 스스로 적은 "pass"를 믿지 않는 방법
 *   1. 검증 항목마다 결과를 담은 payload를 두고, artifactHash는 {checkName, payload}에서 다시 계산한다.
 *   2. 통과 여부는 payload에서 규칙으로 다시 계산한다. 적힌 status가 다르면 기록 자체가 무효다.
 *   3. 항목마다 등록된 validator profile의 불변 attestation이 따로 있어야 한다.
 *      attestation은 payload 지문과 profile 지문에 묶이고, profile은 버전형 registry에 있어야 한다.
 *   4. 독립성은 평가자 이름 문자열이 아니라 registry에 등록된 independenceGroup으로만 판단한다.
 *
 * 사람 검토와 권한을 섞지 않는다
 *   자동 결정은 AUTOMATED_VALIDATION_AUTHORITY, 롤백·기준 등록은 AUTOMATED_OPERATIONS_AUTHORITY 로만 적는다.
 *
 * 계획 함수(plan*)에 대해
 *   DB가 없는 로컬에서도 규칙을 실제로 돌려 보기 위한 "참조 의미"다.
 *   입력 상태를 바꾸지 않고, 성공이면 다음 상태 전체를, 실패면 이유만 돌려준다.
 *   migration의 SQL 함수가 같은 규칙을 한 트랜잭션 안에서 다시 구현한다.
 *   SQL이 실제로 같은 동작을 하는지는 이 파일로 증명되지 않는다 — 적용 전 실제 DB에서 확인해야 한다.
 *
 * 이 파일이 하지 않는 일
 *   OpenAI를 부르지 않고, 카드를 만들지 않고, DB에 쓰지 않고, 공지를 보내지 않는다.
 *   validator profile을 등록하지 않는다. registry는 검토된 migration으로만 바뀐다.
 */

import { referencesOverlap } from './bible-reference.ts';
import { SOURCE_SHA256 } from './bible-reference-index.ts';
import {
  ARTIFACT_HASH_FORMAT,
  CATALOG_CANDIDATE_HASH_FORMAT,
  CATALOG_VERSION_HASH_FORMAT,
  type CandidateKind,
  type CatalogPassage,
  type ContractCheck,
  DEMAND_BINDING_KINDS,
  DOMAIN_ID_FORMAT,
  type DemandBinding,
  type DemandBindingKind,
  type ScriptureCatalogCandidate,
  type ScriptureCatalogSnapshot,
  THEME_FINGERPRINT_FORMAT,
  canonicalJson,
  computeArtifactHash,
  computeCatalogCandidateHash,
  computeCatalogVersionHash,
  scanForbiddenContent,
  sha256Hex,
  validateCatalogCandidate,
  validateCatalogSnapshot,
} from './automatic-scripture-catalog-contract.ts';

/* ------------------------------------------------------------------ */
/* 이름 · 권한 · SQL 사본 대상 상수                                       */
/* ------------------------------------------------------------------ */

// v3: contextTheologyReview.payload.evaluations[].cardVerdicts(카드 최종 verdict 하나)를
// cardEvaluations(카드마다 rubric criterion 아홉 개 개별 판정)로 바꾼 호환 불가능한 변경.
// SQL 쪽은 20260916141221_upgrade_automatic_scripture_catalog_validation_v3.sql이 맞춘다.
export const VALIDATION_CONTRACT_VERSION = 'automatic-scripture-catalog-validation/v3';
export const DEMAND_EVIDENCE_CONTRACT_VERSION = 'scripture-demand-evidence/v1';
export const VALIDATOR_PROFILE_CONTRACT_VERSION = 'scripture-catalog-validator-profile/v1';
export const VALIDATOR_REGISTRY_CONTRACT_VERSION = 'scripture-catalog-validator-registry/v1';
export const ATTESTATION_CONTRACT_VERSION = 'scripture-catalog-attestation/v1';

/** 자동 검증을 통과한 활성화에만 쓰는 authority. 사람 검토의 'human'과 다르다. */
export const AUTOMATED_VALIDATION_AUTHORITY = 'automated_validation';
/** 기준 카탈로그 등록과 롤백에 쓰는 authority. 역시 사람 검토가 아니다. */
export const AUTOMATED_OPERATIONS_AUTHORITY = 'automated_operations';
/** 게시 콘텐츠 사람 검토 경계의 authority. 이 계약에서는 비교 대상으로만 둔다. */
export const HUMAN_REVIEW_AUTHORITY = 'human';

export const VALIDATION_HASH_FORMAT = /^scval_[0-9a-f]{64}$/;
export const VALIDATOR_PROFILE_HASH_FORMAT = /^svp_[0-9a-f]{64}$/;
export const VALIDATOR_REGISTRY_HASH_FORMAT = /^svreg_[0-9a-f]{64}$/;
export const ATTESTATION_HASH_FORMAT = /^satt_[0-9a-f]{64}$/;
export const REQUEST_ID_FORMAT = /^screq_[0-9a-f]{32}$/;
export const DATE_FORMAT = /^\d{4}-\d{2}-\d{2}$/;
export const VALIDATOR_NAME_FORMAT = /^[a-z][a-z0-9_-]{2,48}$/;
export const PROFILE_VERSION_FORMAT = /^v[1-9][0-9]{0,3}$/;
export const CASE_ID_FORMAT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
const SHORT_TEXT_MAX = 100;

export const CHECK_STATUSES = ['pass', 'fail', 'not_run'] as const;
export type CheckStatus = (typeof CHECK_STATUSES)[number];
export const VERDICTS = ['pass', 'fail'] as const;
export type Verdict = (typeof VERDICTS)[number];

/** 활성화에 반드시 있어야 하는 자동 검증 항목. 하나라도 없으면 활성화하지 않는다. */
export const REQUIRED_VALIDATION_CHECKS = [
  'demandSignal',
  'passageExistence',
  'krvTextMatch',
  'contextTheologyReview',
  'safetyBoundary',
  'duplicateCheck',
  'corpusRegression',
  'candidateGenerationEvaluation',
] as const;
export type RequiredValidationCheck = (typeof REQUIRED_VALIDATION_CHECKS)[number];

export const VALIDATOR_KINDS = ['aggregate_counter', 'deterministic', 'model_evaluator'] as const;
export type ValidatorKind = (typeof VALIDATOR_KINDS)[number];

/** 검증 항목마다 attestation을 낼 수 있는 validator 종류. 한 종류가 모든 항목을 판정하지 못하게 나눈다. */
export const CHECK_VALIDATOR_KIND: Readonly<Record<RequiredValidationCheck, ValidatorKind>> = {
  demandSignal: 'aggregate_counter',
  passageExistence: 'deterministic',
  krvTextMatch: 'deterministic',
  contextTheologyReview: 'model_evaluator',
  safetyBoundary: 'deterministic',
  duplicateCheck: 'deterministic',
  corpusRegression: 'deterministic',
  candidateGenerationEvaluation: 'deterministic',
};

/**
 * 신학 검수 rubric이 요구하는 criterion id 아홉 개, 정확한 순서.
 *
 * rubric의 실제 문구·버전·지문(THEOLOGY_REVIEW_RUBRIC)은 validator registry에 있다.
 * 이 계약은 registry를 참조하지 않는다(순환 참조가 생긴다) — registry가 이 계약을 참조하는 방향이다.
 * 그래서 이 파일은 "카드마다 이 아홉 개를 정확한 순서로 담아야 한다"는 모양만 여기 고정해 둔다.
 * 값이 registry의 rubric.criteria 순서와 실제로 같은지는 registry 쪽 테스트가 대조해 고정한다.
 */
export const THEOLOGY_CRITERION_IDS = [
  'context-fidelity',
  'no-unpromised-outcome',
  'no-divine-intent-claim',
  'domain-tag-support',
  'crisis-guidance-precedence',
  'no-coerced-reconciliation',
  'krv-citation-integrity',
  'new-domain-distinctness',
  'uncertainty-defaults-to-fail',
] as const;
export type TheologyCriterionId = (typeof THEOLOGY_CRITERION_IDS)[number];

export const MIN_INDEPENDENT_EVALUATIONS = 2;
export const MIN_DEMAND_OCCURRENCES = 30;
export const MIN_DEMAND_ACTIVE_DAYS = 7;
/** 이보다 작은 하루 횟수는 0으로 가려서 내보낸다. 작은 수로 사람을 짐작하지 못하게 하기 위해서다. */
export const MIN_REPORTABLE_DAILY_COUNT = 5;
export const MAX_DEMAND_WINDOW_DAYS = 90;
/** 새 카드 한 장마다 필요한 전용 생성 평가 사례 수. */
export const MIN_GENERATION_CASES_PER_CARD = 3;
export const GATE_ROUTES = ['safety', 'domain_choice', 'no_coverage', 'recommend', 'ambiguous'] as const;

export const ROLLBACK_REASON_CODES = [
  'regression_detected',
  'safety_concern',
  'validation_evidence_invalidated',
  'owner_requested',
  'operational_incident',
] as const;
export type RollbackReasonCode = (typeof ROLLBACK_REASON_CODES)[number];

export const OWNER_NOTIFICATION_KINDS = ['baseline_registered', 'catalog_activated', 'catalog_rolled_back'] as const;
export type OwnerNotificationKind = (typeof OWNER_NOTIFICATION_KINDS)[number];

export const AUTOMATIC_CATALOG_TABLES = {
  version: 'scripture_catalog_version',
  candidate: 'scripture_catalog_candidate',
  validatorProfile: 'scripture_catalog_validator_profile',
  weakMatchDemand: 'scripture_demand_weak_match_daily',
  themeDemand: 'scripture_demand_theme_daily',
  validation: 'scripture_catalog_validation',
  attestation: 'scripture_catalog_validation_attestation',
  activePointer: 'scripture_catalog_active_pointer',
  baseline: 'scripture_catalog_baseline',
  activation: 'scripture_catalog_activation',
  rollback: 'scripture_catalog_rollback',
  ownerNotification: 'scripture_catalog_owner_notification',
} as const;

export const REGISTER_SCRIPTURE_CATALOG_BASELINE_RPC = 'register_scripture_catalog_baseline';
export const RECORD_SCRIPTURE_DEMAND_WEAK_MATCH_RPC = 'record_scripture_demand_weak_match';
export const RECORD_SCRIPTURE_DEMAND_THEME_RPC = 'record_scripture_demand_theme';
export const STORE_SCRIPTURE_CATALOG_CANDIDATE_RPC = 'store_scripture_catalog_candidate';
export const STORE_SCRIPTURE_CATALOG_VALIDATION_RPC = 'store_scripture_catalog_validation';
export const ACTIVATE_SCRIPTURE_CATALOG_CANDIDATE_RPC = 'activate_scripture_catalog_candidate';
export const ROLLBACK_SCRIPTURE_CATALOG_VERSION_RPC = 'rollback_scripture_catalog_version';

export const AUTOMATIC_CATALOG_RPCS = [
  REGISTER_SCRIPTURE_CATALOG_BASELINE_RPC,
  RECORD_SCRIPTURE_DEMAND_WEAK_MATCH_RPC,
  RECORD_SCRIPTURE_DEMAND_THEME_RPC,
  STORE_SCRIPTURE_CATALOG_CANDIDATE_RPC,
  STORE_SCRIPTURE_CATALOG_VALIDATION_RPC,
  ACTIVATE_SCRIPTURE_CATALOG_CANDIDATE_RPC,
  ROLLBACK_SCRIPTURE_CATALOG_VERSION_RPC,
] as const;

/* ------------------------------------------------------------------ */
/* 공통 검사 도구                                                        */
/* ------------------------------------------------------------------ */

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const isShortText = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value === value.trim() && value.length <= SHORT_TEXT_MAX;

const isHash = (value: unknown, format: RegExp): value is string => typeof value === 'string' && format.test(value);

function exactFields(value: Record<string, unknown>, fields: readonly string[], label: string): string[] {
  const errors: string[] = [];
  for (const key of Object.keys(value)) if (!fields.includes(key)) errors.push(`${label}: 계약에 없는 항목입니다: ${key}`);
  for (const key of fields) if (!Object.hasOwn(value, key)) errors.push(`${label}: 빠진 항목입니다: ${key}`);
  return errors;
}
/* ------------------------------------------------------------------ */
/* 수요 evidence                                                        */
/* ------------------------------------------------------------------ */

/**
 * 집계 저장소 한 칸. 날짜·집계 종류·대상 키·횟수뿐이다.
 *   weak_match       : subjectKey = 기존 영역 id
 *   normalized_theme : subjectKey = 정규화 주제 지문(sthm_…)
 * 사용자 문장, 사용자 번호, 기기 정보는 들어갈 자리가 없다.
 */
export type DemandCell = { evidenceKind: DemandBindingKind; subjectKey: string; bucketDate: string; count: number };

export type DemandEvidence = {
  contractVersion: typeof DEMAND_EVIDENCE_CONTRACT_VERSION;
  evidenceKind: DemandBindingKind;
  subjectKey: string;
  windowStartDate: string;
  windowEndDate: string;
  /** 기간의 모든 날짜를 빠짐없이, 오름차순으로. 작은 수는 0으로 가린 값이다. */
  dailyCounts: { date: string; count: number }[];
};

export const DEMAND_EVIDENCE_FIELDS = [
  'contractVersion',
  'evidenceKind',
  'subjectKey',
  'windowStartDate',
  'windowEndDate',
  'dailyCounts',
] as const;

export const suppressDailyCount = (raw: number): number => (raw >= MIN_REPORTABLE_DAILY_COUNT ? raw : 0);

export const demandSubjectKey = (binding: DemandBinding): string =>
  binding.kind === 'weak_match' ? binding.domainId : binding.themeFingerprint;

/** start부터 end까지 날짜 목록(UTC 달력). 모양이 틀리거나 기간이 너무 길면 null. */
export function enumerateDemandWindow(start: string, end: string): string[] | null {
  if (!DATE_FORMAT.test(start) || !DATE_FORMAT.test(end)) return null;
  const startMs = Date.parse(`${start}T00:00:00Z`);
  const endMs = Date.parse(`${end}T00:00:00Z`);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs > endMs) return null;
  if (new Date(startMs).toISOString().slice(0, 10) !== start || new Date(endMs).toISOString().slice(0, 10) !== end) {
    return null;
  }
  const days = (endMs - startMs) / 86_400_000 + 1;
  if (days > MAX_DEMAND_WINDOW_DAYS) return null;
  return Array.from({ length: days }, (_, index) => new Date(startMs + index * 86_400_000).toISOString().slice(0, 10));
}

/** 집계 칸에서 evidence를 결정적으로 만든다. SQL 활성화 함수가 같은 규칙으로 다시 만든다. */
export function buildDemandEvidence(
  binding: DemandBinding,
  window: { windowStartDate: string; windowEndDate: string },
  cells: readonly DemandCell[],
): DemandEvidence | null {
  const dates = enumerateDemandWindow(window.windowStartDate, window.windowEndDate);
  if (!dates) return null;
  const subjectKey = demandSubjectKey(binding);
  const raw = new Map<string, number>();
  for (const cell of cells) {
    if (cell.evidenceKind === binding.kind && cell.subjectKey === subjectKey) {
      raw.set(cell.bucketDate, (raw.get(cell.bucketDate) ?? 0) + cell.count);
    }
  }
  return {
    contractVersion: DEMAND_EVIDENCE_CONTRACT_VERSION,
    evidenceKind: binding.kind,
    subjectKey,
    windowStartDate: window.windowStartDate,
    windowEndDate: window.windowEndDate,
    dailyCounts: dates.map((date) => ({ date, count: suppressDailyCount(raw.get(date) ?? 0) })),
  };
}

export type DemandEvidenceCheck = ContractCheck & { meetsThreshold: boolean; occurrenceCount: number; activeDayCount: number };

/** evidence가 후보의 수요 연결에 정확히 묶여 있고, 가림 규칙을 지키고, 기준을 넘는지 본다. */
export function evaluateDemandEvidence(value: unknown, binding: DemandBinding): DemandEvidenceCheck {
  const fail = (errors: string[]): DemandEvidenceCheck => ({ valid: false, errors, meetsThreshold: false, occurrenceCount: 0, activeDayCount: 0 });
  if (!isPlainObject(value)) return fail(['demandSignal.payload: 객체가 아닙니다.']);
  const errors = exactFields(value, DEMAND_EVIDENCE_FIELDS, 'demandSignal.payload');
  if (errors.length > 0) return fail(errors);
  if (value.contractVersion !== DEMAND_EVIDENCE_CONTRACT_VERSION) errors.push('demandSignal.payload: 계약 버전이 맞지 않습니다.');
  if (value.evidenceKind !== binding.kind) errors.push('demandSignal.payload.evidenceKind: 후보의 수요 연결 종류와 다릅니다.');
  if (value.subjectKey !== demandSubjectKey(binding)) errors.push('demandSignal.payload.subjectKey: 후보의 영역·주제 지문과 다릅니다.');
  const dates =
    typeof value.windowStartDate === 'string' && typeof value.windowEndDate === 'string'
      ? enumerateDemandWindow(value.windowStartDate, value.windowEndDate)
      : null;
  if (!dates) return fail([...errors, 'demandSignal.payload: 집계 기간이 올바르지 않습니다.']);
  if (!Array.isArray(value.dailyCounts) || value.dailyCounts.length !== dates.length) {
    return fail([...errors, 'demandSignal.payload.dailyCounts: 기간의 모든 날짜가 있어야 합니다.']);
  }
  let occurrenceCount = 0;
  let activeDayCount = 0;
  value.dailyCounts.forEach((entry: unknown, index: number) => {
    if (
      !isPlainObject(entry) ||
      exactFields(entry, ['date', 'count'], 'entry').length > 0 ||
      entry.date !== dates[index] ||
      !isNonNegativeInteger(entry.count) ||
      (entry.count !== 0 && entry.count < MIN_REPORTABLE_DAILY_COUNT)
    ) {
      errors.push(`demandSignal.payload.dailyCounts[${index}]: 날짜 순서나 가림 규칙이 맞지 않습니다.`);
      return;
    }
    occurrenceCount += entry.count as number;
    if ((entry.count as number) > 0) activeDayCount += 1;
  });
  if (errors.length > 0) return fail(errors);
  return {
    valid: true,
    errors: [],
    occurrenceCount,
    activeDayCount,
    meetsThreshold: occurrenceCount >= MIN_DEMAND_OCCURRENCES && activeDayCount >= MIN_DEMAND_ACTIVE_DAYS,
  };
}

/* ------------------------------------------------------------------ */
/* Validator profile · registry · attestation                           */
/* ------------------------------------------------------------------ */

export type ValidatorProfile = {
  contractVersion: typeof VALIDATOR_PROFILE_CONTRACT_VERSION;
  profileId: string;
  profileVersion: string;
  validatorKind: ValidatorKind;
  /** 이 profile이 attestation을 낼 수 있는 항목. 종류별로 정해진 항목만 가능하다. */
  authorizedChecks: RequiredValidationCheck[];
  /** 독립성의 단위. 같은 모델 계열·같은 운영 주체면 같은 그룹이다. registry가 정한다. */
  independenceGroup: string;
  /** model_evaluator만 가진다. 그 밖에는 null. */
  modelId: string | null;
  rubricVersion: string | null;
};

/** 버전형 allowlist. 검토된 migration으로만 DB에 들어간다. 런타임이 추가하지 않는다. */
export type ValidatorRegistry = {
  contractVersion: typeof VALIDATOR_REGISTRY_CONTRACT_VERSION;
  registryVersion: string;
  profiles: ValidatorProfile[];
};

export type ValidationAttestation = {
  contractVersion: typeof ATTESTATION_CONTRACT_VERSION;
  candidateHash: string;
  checkName: RequiredValidationCheck;
  /** 그 항목 payload의 지문(= artifactHash). payload가 바뀌면 attestation은 쓸모없어진다. */
  payloadHash: string;
  profileHash: string;
  verdict: Verdict;
};

export const VALIDATOR_PROFILE_FIELDS = [
  'contractVersion',
  'profileId',
  'profileVersion',
  'validatorKind',
  'authorizedChecks',
  'independenceGroup',
  'modelId',
  'rubricVersion',
] as const;
export const ATTESTATION_FIELDS = ['contractVersion', 'candidateHash', 'checkName', 'payloadHash', 'profileHash', 'verdict'] as const;

export async function computeValidatorProfileHash(profile: ValidatorProfile): Promise<string> {
  return `svp_${await sha256Hex(canonicalJson(profile))}`;
}
export async function computeValidatorRegistryHash(registry: ValidatorRegistry): Promise<string> {
  return `svreg_${await sha256Hex(canonicalJson(registry))}`;
}
export async function computeAttestationHash(attestation: ValidationAttestation): Promise<string> {
  return `satt_${await sha256Hex(canonicalJson(attestation))}`;
}

export function validateValidatorProfile(value: unknown, label = 'profile'): ContractCheck {
  if (!isPlainObject(value)) return { valid: false, errors: [`${label}: 객체가 아닙니다.`] };
  const errors = exactFields(value, VALIDATOR_PROFILE_FIELDS, label);
  if (errors.length > 0) return { valid: false, errors };
  if (value.contractVersion !== VALIDATOR_PROFILE_CONTRACT_VERSION) errors.push(`${label}: 계약 버전이 맞지 않습니다.`);
  if (typeof value.profileId !== 'string' || !VALIDATOR_NAME_FORMAT.test(value.profileId)) errors.push(`${label}.profileId: 모양이 맞지 않습니다.`);
  if (typeof value.profileVersion !== 'string' || !PROFILE_VERSION_FORMAT.test(value.profileVersion)) {
    errors.push(`${label}.profileVersion: 모양이 맞지 않습니다.`);
  }
  if (typeof value.independenceGroup !== 'string' || !VALIDATOR_NAME_FORMAT.test(value.independenceGroup)) {
    errors.push(`${label}.independenceGroup: 모양이 맞지 않습니다.`);
  }
  if (!(VALIDATOR_KINDS as readonly unknown[]).includes(value.validatorKind)) {
    errors.push(`${label}.validatorKind: 알 수 없는 종류입니다.`);
    return { valid: false, errors };
  }
  const checks = value.authorizedChecks;
  if (
    !Array.isArray(checks) ||
    checks.length === 0 ||
    new Set(checks).size !== checks.length ||
    checks.some((name) => !(REQUIRED_VALIDATION_CHECKS as readonly unknown[]).includes(name)) ||
    canonicalJson(checks) !== canonicalJson(REQUIRED_VALIDATION_CHECKS.filter((name) => checks.includes(name)))
  ) {
    errors.push(`${label}.authorizedChecks: 필수 항목 순서대로, 중복 없이 하나 이상이어야 합니다.`);
  } else if (checks.some((name) => CHECK_VALIDATOR_KIND[name as RequiredValidationCheck] !== value.validatorKind)) {
    errors.push(`${label}.authorizedChecks: 이 validator 종류가 판정할 수 없는 항목이 있습니다.`);
  }
  if (value.validatorKind === 'model_evaluator') {
    if (!isShortText(value.modelId)) errors.push(`${label}.modelId: 모델 평가자는 모델 식별자가 필요합니다.`);
    if (!isShortText(value.rubricVersion)) errors.push(`${label}.rubricVersion: 모델 평가자는 평가 기준 버전이 필요합니다.`);
  } else if (value.modelId !== null || value.rubricVersion !== null) {
    errors.push(`${label}: 모델 평가자가 아니면 modelId·rubricVersion은 null이어야 합니다.`);
  }
  return { valid: errors.length === 0, errors };
}

export function validateValidatorRegistry(value: unknown): ContractCheck {
  if (!isPlainObject(value)) return { valid: false, errors: ['registry: 객체가 아닙니다.'] };
  const errors = exactFields(value, ['contractVersion', 'registryVersion', 'profiles'], 'registry');
  if (errors.length > 0) return { valid: false, errors };
  if (value.contractVersion !== VALIDATOR_REGISTRY_CONTRACT_VERSION) errors.push('registry: 계약 버전이 맞지 않습니다.');
  if (!isShortText(value.registryVersion)) errors.push('registry.registryVersion: 버전이 필요합니다.');
  if (!Array.isArray(value.profiles) || value.profiles.length === 0) {
    return { valid: false, errors: [...errors, 'registry.profiles: 하나 이상 있어야 합니다.'] };
  }
  value.profiles.forEach((profile, index) => errors.push(...validateValidatorProfile(profile, `registry.profiles[${index}]`).errors));
  if (errors.length > 0) return { valid: false, errors };
  const keys = (value.profiles as ValidatorProfile[]).map((profile) => `${profile.profileId}@${profile.profileVersion}`);
  if (!keys.every((key, index) => index === 0 || keys[index - 1] < key)) {
    errors.push('registry.profiles: profileId@profileVersion 오름차순이어야 하고 중복이 없어야 합니다.');
  }
  errors.push(...scanForbiddenContent(value, 'registry'));
  return { valid: errors.length === 0, errors };
}

/* ------------------------------------------------------------------ */
/* 검증 항목 payload                                                     */
/* ------------------------------------------------------------------ */

export type PassageExistencePayload = {
  passages: { cardId: string; passageIndex: number; book: string; chapter: number; startVerse: number; endVerse: number }[];
};
export type KrvTextMatchPayload = {
  bibleSourceSha256: string;
  passageTextHashes: { cardId: string; passageIndex: number; textHash: string }[];
};
/** 카드 하나, criterion 하나의 판정. 모델은 이 판정만 낸다 — 카드 최종 verdict는 여기 없다. */
export type CriterionVerdict = { criterionId: TheologyCriterionId; verdict: Verdict };
/** 카드 하나에 대한 rubric 아홉 개 전부의 판정, THEOLOGY_CRITERION_IDS 순서 그대로. */
export type CardCriterionEvaluation = { cardId: string; criteria: CriterionVerdict[] };
export const CRITERION_VERDICT_FIELDS = ['criterionId', 'verdict'] as const;
export const CARD_CRITERION_EVALUATION_FIELDS = ['cardId', 'criteria'] as const;

export type ContextTheologyReviewPayload = {
  evaluations: { profileHash: string; cardEvaluations: CardCriterionEvaluation[] }[];
};
export type SafetyBoundaryPayload = {
  rulesVersion: string;
  cases: { caseId: string; expectedRoute: (typeof GATE_ROUTES)[number]; observedRoute: (typeof GATE_ROUTES)[number] }[];
};
export type DuplicateCheckPayload = {
  comparedCardIds: string[];
  overlaps: { cardId: string; passageIndex: number; overlapsCardId: string }[];
};
export type CorpusOutcome = { domainMatch: boolean; acceptableMatch: boolean; safetyFalsePositive: boolean };
export type CorpusRegressionPayload = {
  corpusVersion: string;
  cases: { caseId: string; baseline: CorpusOutcome; candidate: CorpusOutcome }[];
};
export type CandidateGenerationEvaluationPayload = {
  cases: { caseId: string; cardId: string; passed: boolean }[];
};

export type CheckPayloads = {
  demandSignal: DemandEvidence;
  passageExistence: PassageExistencePayload;
  krvTextMatch: KrvTextMatchPayload;
  contextTheologyReview: ContextTheologyReviewPayload;
  safetyBoundary: SafetyBoundaryPayload;
  duplicateCheck: DuplicateCheckPayload;
  corpusRegression: CorpusRegressionPayload;
  candidateGenerationEvaluation: CandidateGenerationEvaluationPayload;
};

export type ValidationCheck<P> = { status: CheckStatus; payload: P; artifactHash: string };
export type ValidationChecks = { [K in RequiredValidationCheck]: ValidationCheck<CheckPayloads[K]> };
export const CHECK_FIELDS = ['status', 'payload', 'artifactHash'] as const;

export type AutomaticValidationRecord = {
  contractVersion: typeof VALIDATION_CONTRACT_VERSION;
  validationAuthority: typeof AUTOMATED_VALIDATION_AUTHORITY;
  candidateHash: string;
  candidateKind: CandidateKind;
  baseVersionHash: string;
  proposedVersionHash: string;
  validatorRuleVersion: string;
  /** 판단에 쓴 validator registry의 지문. registry가 바뀌면 이 기록은 다시 만들어야 한다. */
  validatorRegistryHash: string;
  dataVersions: { bibleSourceSha256: string; evaluationCorpusVersion: string };
  modelIdentifiers: { generation: string; evaluators: string[] };
  checks: ValidationChecks;
  overallStatus: 'pass' | 'fail';
};

export const VALIDATION_RECORD_FIELDS = [
  'contractVersion',
  'validationAuthority',
  'candidateHash',
  'candidateKind',
  'baseVersionHash',
  'proposedVersionHash',
  'validatorRuleVersion',
  'validatorRegistryHash',
  'dataVersions',
  'modelIdentifiers',
  'checks',
  'overallStatus',
] as const;

/** 검증 항목 payload의 지문. 항목 이름을 함께 넣어 다른 항목의 payload로 바꿔 끼우지 못하게 한다. */
export const computeCheckArtifactHash = (checkName: RequiredValidationCheck, payload: unknown) =>
  computeArtifactHash({ checkName, payload });

export async function computeValidationHash(record: AutomaticValidationRecord): Promise<string> {
  return `scval_${await sha256Hex(canonicalJson(record))}`;
}

/** 개역한글 본문 한 위치를 원문 그대로 돌려준다. 없으면 null. 런타임마다 읽는 방법이 달라 주입한다. */
export type PassageTextResolver = (passage: CatalogPassage) => readonly { verse: number; text: string }[] | null;

/** 본문 위치와 원문 글자를 함께 묶은 지문. 같은 글자라도 위치가 다르면 다른 지문이다. */
export async function computePassageTextHash(
  passage: CatalogPassage,
  verses: readonly { verse: number; text: string }[],
): Promise<string> {
  return computeArtifactHash({
    bibleSourceSha256: SOURCE_SHA256,
    passage: { book: passage.book, chapter: passage.chapter, startVerse: passage.startVerse, endVerse: passage.endVerse },
    verses: verses.map(({ verse, text }) => ({ verse, text })),
  });
}

const allPassagesOf = (candidate: ScriptureCatalogCandidate) =>
  candidate.cards.flatMap((card) => card.passages.map((passage, passageIndex) => ({ cardId: card.id, passageIndex, passage })));

/** 후보에서 본문 존재 payload를 결정적으로 만든다. */
export function derivePassageExistencePayload(candidate: ScriptureCatalogCandidate): PassageExistencePayload {
  return {
    passages: allPassagesOf(candidate).map(({ cardId, passageIndex, passage }) => ({
      cardId,
      passageIndex,
      book: passage.book,
      chapter: passage.chapter,
      startVerse: passage.startVerse,
      endVerse: passage.endVerse,
    })),
  };
}

/** 기준 카탈로그와 후보에서 중복 payload를 결정적으로 만든다. */
export function deriveDuplicateCheckPayload(
  candidate: ScriptureCatalogCandidate,
  base: ScriptureCatalogSnapshot,
): DuplicateCheckPayload {
  const overlaps: DuplicateCheckPayload['overlaps'] = [];
  const passages = allPassagesOf(candidate);
  for (const item of passages) {
    const others = [
      ...base.cards.map((card) => ({ id: card.id, passages: card.passages })),
      ...candidate.cards.filter((card) => card.id !== item.cardId).map((card) => ({ id: card.id, passages: card.passages })),
    ].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const other of others) {
      if (other.passages.some((passage) => referencesOverlap(passage, item.passage))) {
        overlaps.push({ cardId: item.cardId, passageIndex: item.passageIndex, overlapsCardId: other.id });
      }
    }
  }
  return { comparedCardIds: base.cards.map((card) => card.id), overlaps };
}

/* ------------------------------------------------------------------ */
/* 검증 기록 확인                                                        */
/* ------------------------------------------------------------------ */

export type ValidationDependencies = {
  resolvePassageText: PassageTextResolver | null;
  validatorRegistry: ValidatorRegistry | null;
};

export type ValidationContext = ValidationDependencies & {
  candidate: unknown;
  baseCatalog: ScriptureCatalogSnapshot;
  attestations: readonly unknown[];
};

export type ValidationRecordCheck = ContractCheck & {
  /** 기록은 사실과 맞지만(valid) 활성화를 막는 이유. 비어 있어야 활성화할 수 있다. */
  activationBlockers: string[];
};

type Evaluation = { errors: string[]; pass: boolean; blockers?: string[] };

/**
 * 자동 검증 기록 한 건과 그 attestation들을 후보·기준 카탈로그·실제 성경 본문·validator registry에 대어 확인한다.
 *
 * valid = false (무효): 모양이 틀림, 지문 연결이 틀림, artifactHash가 payload와 다름, 적힌 status가
 *   payload에서 다시 계산한 결과와 다름, 등록되지 않았거나 권한 없는 validator, attestation 누락·불일치.
 *   무효 기록은 보관하지도 않는다.
 * activationBlockers (막음): 기록은 사실대로이지만 실패·미실행·원문 재확인 불가.
 *
 * 어떤 값이 와도 예외를 던지지 않는다.
 */
export async function validateAutomaticValidationRecord(
  value: unknown,
  context: ValidationContext,
): Promise<ValidationRecordCheck> {
  const fail = (errors: string[]): ValidationRecordCheck => ({ valid: false, errors, activationBlockers: [] });
  try {
    const candidateCheck = await validateCatalogCandidate(context.candidate, context.baseCatalog);
    if (!candidateCheck.valid) return fail(['후보가 올바르지 않습니다.', ...candidateCheck.errors]);
    const candidate = context.candidate as ScriptureCatalogCandidate;
    const base = context.baseCatalog;

    const registryCheck = validateValidatorRegistry(context.validatorRegistry);
    if (!registryCheck.valid) return fail(['validator registry를 확인할 수 없습니다.', ...registryCheck.errors]);
    const registry = context.validatorRegistry as ValidatorRegistry;
    const profilesByHash = new Map<string, ValidatorProfile>();
    for (const profile of registry.profiles) profilesByHash.set(await computeValidatorProfileHash(profile), profile);

    if (!isPlainObject(value)) return fail(['검증 기록이 객체가 아닙니다.']);
    const errors = exactFields(value, VALIDATION_RECORD_FIELDS, 'validation');
    errors.push(...scanForbiddenContent(value, 'validation'));
    if (errors.length > 0) return fail(errors);
    const record = value as unknown as AutomaticValidationRecord;

    if (record.contractVersion !== VALIDATION_CONTRACT_VERSION) errors.push('validation: 계약 버전이 맞지 않습니다.');
    if (record.validationAuthority !== AUTOMATED_VALIDATION_AUTHORITY) {
      errors.push('validation.validationAuthority: 자동 검증 authority가 아닙니다.');
    }
    if (!isHash(record.candidateHash, CATALOG_CANDIDATE_HASH_FORMAT) || record.candidateHash !== (await computeCatalogCandidateHash(candidate))) {
      errors.push('validation.candidateHash: 후보의 지문과 다릅니다.');
    }
    if (record.candidateKind !== candidate.candidateKind) errors.push('validation.candidateKind: 후보 종류와 다릅니다.');
    if (!isHash(record.baseVersionHash, CATALOG_VERSION_HASH_FORMAT) || record.baseVersionHash !== candidate.baseVersionHash) {
      errors.push('validation.baseVersionHash: 후보의 기준 버전과 다릅니다.');
    }
    if (!isHash(record.proposedVersionHash, CATALOG_VERSION_HASH_FORMAT) || record.proposedVersionHash !== candidate.proposedVersionHash) {
      errors.push('validation.proposedVersionHash: 후보의 결과 버전과 다릅니다.');
    }
    if (!isShortText(record.validatorRuleVersion)) errors.push('validation.validatorRuleVersion: 규칙 버전이 필요합니다.');
    if (record.validatorRegistryHash !== (await computeValidatorRegistryHash(registry))) {
      errors.push('validation.validatorRegistryHash: 판단에 쓴 validator registry와 다릅니다.');
    }
    if (!isPlainObject(record.dataVersions) || exactFields(record.dataVersions, ['bibleSourceSha256', 'evaluationCorpusVersion'], 'd').length > 0) {
      errors.push('validation.dataVersions: 모양이 맞지 않습니다.');
    } else {
      if (record.dataVersions.bibleSourceSha256 !== SOURCE_SHA256) errors.push('validation.dataVersions.bibleSourceSha256: 현재 개역한글 데이터와 다릅니다.');
      if (!isShortText(record.dataVersions.evaluationCorpusVersion)) errors.push('validation.dataVersions.evaluationCorpusVersion: 버전이 필요합니다.');
    }
    if (!isPlainObject(record.modelIdentifiers) || exactFields(record.modelIdentifiers, ['generation', 'evaluators'], 'm').length > 0) {
      errors.push('validation.modelIdentifiers: 모양이 맞지 않습니다.');
    } else if (record.modelIdentifiers.generation !== candidate.generation.modelId) {
      errors.push('validation.modelIdentifiers.generation: 후보 생성 모델과 다릅니다.');
    }
    if (!isPlainObject(record.checks)) return fail([...errors, 'validation.checks: 객체가 아닙니다.']);
    errors.push(...exactFields(record.checks, REQUIRED_VALIDATION_CHECKS, 'validation.checks'));
    for (const name of REQUIRED_VALIDATION_CHECKS) {
      const check = (record.checks as Record<string, unknown>)[name];
      if (!isPlainObject(check)) {
        errors.push(`validation.checks.${name}: 검증 항목이 없습니다.`);
        continue;
      }
      errors.push(...exactFields(check, CHECK_FIELDS, `validation.checks.${name}`));
      if (!(CHECK_STATUSES as readonly unknown[]).includes(check.status)) errors.push(`validation.checks.${name}.status: 알 수 없는 상태입니다.`);
      if (!isHash(check.artifactHash, ARTIFACT_HASH_FORMAT)) {
        errors.push(`validation.checks.${name}.artifactHash: 산출물 지문 모양이 맞지 않습니다.`);
      } else if (Object.hasOwn(check, 'payload') && check.artifactHash !== (await computeCheckArtifactHash(name, check.payload))) {
        errors.push(`validation.checks.${name}.artifactHash: payload에서 다시 계산한 지문과 다릅니다.`);
      }
    }
    if (errors.length > 0) return fail(errors);

    const checks = record.checks;
    const passages = allPassagesOf(candidate);
    const blockers: string[] = [];
    const evaluations: Record<RequiredValidationCheck, Evaluation> = {
      demandSignal: (() => {
        const demand = evaluateDemandEvidence(checks.demandSignal.payload, candidate.demandBinding);
        return { errors: demand.errors, pass: demand.valid && demand.meetsThreshold };
      })(),
      passageExistence: {
        errors:
          canonicalJson(checks.passageExistence.payload) === canonicalJson(derivePassageExistencePayload(candidate))
            ? []
            : ['passageExistence.payload: 후보의 본문 위치와 다릅니다.'],
        // 후보 검사를 통과했다면 모든 위치가 성경에 실제로 있다.
        pass: true,
      },
      krvTextMatch: await (async (): Promise<Evaluation> => {
        const payload = checks.krvTextMatch.payload as unknown;
        if (
          !isPlainObject(payload) ||
          exactFields(payload, ['bibleSourceSha256', 'passageTextHashes'], 'p').length > 0 ||
          payload.bibleSourceSha256 !== SOURCE_SHA256 ||
          !Array.isArray(payload.passageTextHashes) ||
          payload.passageTextHashes.length !== passages.length
        ) {
          return { errors: ['krvTextMatch.payload: 모양·데이터 버전·위치 수가 맞지 않습니다.'], pass: false };
        }
        const shapeErrors: string[] = [];
        payload.passageTextHashes.forEach((entry: unknown, index: number) => {
          if (
            !isPlainObject(entry) ||
            exactFields(entry, ['cardId', 'passageIndex', 'textHash'], 'e').length > 0 ||
            entry.cardId !== passages[index].cardId ||
            entry.passageIndex !== passages[index].passageIndex ||
            !isHash(entry.textHash, ARTIFACT_HASH_FORMAT)
          ) {
            shapeErrors.push(`krvTextMatch.payload.passageTextHashes[${index}]: 순서나 모양이 맞지 않습니다.`);
          }
        });
        if (shapeErrors.length > 0) return { errors: shapeErrors, pass: false };
        if (context.resolvePassageText === null) {
          return { errors: [], pass: false, blockers: ['krvTextMatch: 원문을 읽을 수 없어 다시 확인하지 못했습니다.'] };
        }
        let pass = true;
        for (let index = 0; index < passages.length; index += 1) {
          let verses: readonly { verse: number; text: string }[] | null = null;
          try {
            verses = context.resolvePassageText(structuredClone(passages[index].passage));
          } catch {
            verses = null;
          }
          const expectedCount = passages[index].passage.endVerse - passages[index].passage.startVerse + 1;
          if (
            !verses ||
            verses.length !== expectedCount ||
            verses.some(
              (verse, verseIndex) =>
                verse.verse !== passages[index].passage.startVerse + verseIndex ||
                typeof verse.text !== 'string' ||
                verse.text.length === 0,
            ) ||
            payload.passageTextHashes[index].textHash !== (await computePassageTextHash(passages[index].passage, verses))
          ) {
            pass = false;
          }
        }
        return { errors: [], pass };
      })(),
      contextTheologyReview: (() => {
        const payload = checks.contextTheologyReview.payload as unknown;
        if (!isPlainObject(payload) || exactFields(payload, ['evaluations'], 'p').length > 0 || !Array.isArray(payload.evaluations)) {
          return { errors: ['contextTheologyReview.payload: 모양이 맞지 않습니다.'], pass: false };
        }
        const cardIds = candidate.cards.map((card) => card.id);
        const shapeErrors: string[] = [];
        const groups: string[] = [];
        const models: string[] = [];
        let allPass = true;
        payload.evaluations.forEach((evaluation: unknown, index: number) => {
          const label = `contextTheologyReview.payload.evaluations[${index}]`;
          if (!isPlainObject(evaluation) || exactFields(evaluation, ['profileHash', 'cardEvaluations'], label).length > 0) {
            shapeErrors.push(`${label}: 모양이 맞지 않습니다.`);
            return;
          }
          const profile = typeof evaluation.profileHash === 'string' ? profilesByHash.get(evaluation.profileHash) : undefined;
          if (!profile || !profile.authorizedChecks.includes('contextTheologyReview')) {
            shapeErrors.push(`${label}.profileHash: 등록되지 않았거나 이 항목을 판정할 수 없는 validator입니다.`);
            return;
          }
          groups.push(profile.independenceGroup);
          models.push(profile.modelId!);
          if (
            !Array.isArray(evaluation.cardEvaluations) ||
            canonicalJson(evaluation.cardEvaluations.map((item: unknown) => (isPlainObject(item) ? item.cardId : null))) !==
              canonicalJson(cardIds)
          ) {
            shapeErrors.push(`${label}.cardEvaluations: 후보 카드마다 한 번씩, 순서대로 있어야 합니다.`);
            return;
          }
          let cardsOk = true;
          const cardFinalVerdicts: Verdict[] = [];
          (evaluation.cardEvaluations as unknown[]).forEach((cardEvaluation: unknown, cardIndex: number) => {
            const cardLabel = `${label}.cardEvaluations[${cardIndex}]`;
            if (!isPlainObject(cardEvaluation) || exactFields(cardEvaluation, CARD_CRITERION_EVALUATION_FIELDS, cardLabel).length > 0) {
              shapeErrors.push(`${cardLabel}: 모양이 맞지 않습니다.`);
              cardsOk = false;
              return;
            }
            if (
              !Array.isArray(cardEvaluation.criteria) ||
              canonicalJson(cardEvaluation.criteria.map((item: unknown) => (isPlainObject(item) ? item.criterionId : null))) !==
                canonicalJson(THEOLOGY_CRITERION_IDS) ||
              cardEvaluation.criteria.some(
                (item: unknown) =>
                  !isPlainObject(item) ||
                  exactFields(item, CRITERION_VERDICT_FIELDS, 'c').length > 0 ||
                  !(VERDICTS as readonly unknown[]).includes(item.verdict),
              )
            ) {
              shapeErrors.push(`${cardLabel}.criteria: rubric의 criterion 9개를 정확한 순서로, 빠짐없이 담아야 합니다.`);
              cardsOk = false;
              return;
            }
            const cardPass = (cardEvaluation.criteria as CriterionVerdict[]).every((item) => item.verdict === 'pass');
            cardFinalVerdicts.push(cardPass ? 'pass' : 'fail');
          });
          if (!cardsOk) return;
          if (cardFinalVerdicts.some((verdict) => verdict !== 'pass')) allPass = false;
        });
        if (shapeErrors.length > 0) return { errors: shapeErrors, pass: false };
        const profileHashes = (payload.evaluations as { profileHash: string }[]).map((item) => item.profileHash);
        const extra: string[] = [];
        if (new Set(profileHashes).size !== profileHashes.length) extra.push('contextTheologyReview.payload: 같은 validator가 두 번 평가했습니다.');
        const expectedModels = [...new Set(models)].sort();
        if (canonicalJson(record.modelIdentifiers.evaluators) !== canonicalJson(expectedModels)) {
          extra.push('validation.modelIdentifiers.evaluators: 등록된 평가 validator의 모델 목록과 다릅니다.');
        }
        const independent = new Set(groups).size >= MIN_INDEPENDENT_EVALUATIONS && new Set(groups).size === groups.length;
        return {
          errors: extra,
          pass: independent && allPass,
          blockers: independent ? [] : ['contextTheologyReview: 서로 다른 등록 독립 그룹의 평가가 부족합니다.'],
        };
      })(),
      safetyBoundary: (() => {
        const payload = checks.safetyBoundary.payload as unknown;
        if (
          !isPlainObject(payload) ||
          exactFields(payload, ['rulesVersion', 'cases'], 'p').length > 0 ||
          !isShortText(payload.rulesVersion) ||
          !Array.isArray(payload.cases) ||
          payload.cases.some(
            (item: unknown) =>
              !isPlainObject(item) ||
              exactFields(item, ['caseId', 'expectedRoute', 'observedRoute'], 'c').length > 0 ||
              typeof item.caseId !== 'string' ||
              !CASE_ID_FORMAT.test(item.caseId) ||
              !(GATE_ROUTES as readonly unknown[]).includes(item.expectedRoute) ||
              !(GATE_ROUTES as readonly unknown[]).includes(item.observedRoute),
          ) ||
          new Set((payload.cases as { caseId: string }[]).map((item) => item.caseId)).size !== payload.cases.length
        ) {
          return { errors: ['safetyBoundary.payload: 모양이 맞지 않습니다.'], pass: false };
        }
        const cases = payload.cases as SafetyBoundaryPayload['cases'];
        return { errors: [], pass: cases.length > 0 && cases.every((item) => item.expectedRoute === item.observedRoute) };
      })(),
      duplicateCheck: (() => {
        const expected = deriveDuplicateCheckPayload(candidate, base);
        return {
          errors:
            canonicalJson(checks.duplicateCheck.payload) === canonicalJson(expected)
              ? []
              : ['duplicateCheck.payload: 기준 카탈로그와 후보에서 다시 계산한 중복과 다릅니다.'],
          pass: expected.overlaps.length === 0,
        };
      })(),
      corpusRegression: (() => {
        const payload = checks.corpusRegression.payload as unknown;
        const outcomeOk = (outcome: unknown) =>
          isPlainObject(outcome) &&
          exactFields(outcome, ['domainMatch', 'acceptableMatch', 'safetyFalsePositive'], 'o').length === 0 &&
          typeof outcome.domainMatch === 'boolean' &&
          typeof outcome.acceptableMatch === 'boolean' &&
          typeof outcome.safetyFalsePositive === 'boolean';
        if (
          !isPlainObject(payload) ||
          exactFields(payload, ['corpusVersion', 'cases'], 'p').length > 0 ||
          payload.corpusVersion !== record.dataVersions.evaluationCorpusVersion ||
          !Array.isArray(payload.cases) ||
          payload.cases.some(
            (item: unknown) =>
              !isPlainObject(item) ||
              exactFields(item, ['caseId', 'baseline', 'candidate'], 'c').length > 0 ||
              typeof item.caseId !== 'string' ||
              !CASE_ID_FORMAT.test(item.caseId) ||
              !outcomeOk(item.baseline) ||
              !outcomeOk(item.candidate),
          ) ||
          new Set((payload.cases as { caseId: string }[]).map((item) => item.caseId)).size !== payload.cases.length
        ) {
          return { errors: ['corpusRegression.payload: 모양이나 코퍼스 버전이 맞지 않습니다.'], pass: false };
        }
        const cases = payload.cases as CorpusRegressionPayload['cases'];
        const regressed = cases.filter(
          (item) =>
            (item.baseline.domainMatch && !item.candidate.domainMatch) ||
            (item.baseline.acceptableMatch && !item.candidate.acceptableMatch) ||
            (!item.baseline.safetyFalsePositive && item.candidate.safetyFalsePositive),
        );
        return {
          errors: [],
          pass: cases.length > 0 && regressed.length === 0 && cases.every((item) => !item.candidate.safetyFalsePositive),
        };
      })(),
      candidateGenerationEvaluation: (() => {
        const payload = checks.candidateGenerationEvaluation.payload as unknown;
        const cardIds = new Set(candidate.cards.map((card) => card.id));
        if (
          !isPlainObject(payload) ||
          exactFields(payload, ['cases'], 'p').length > 0 ||
          !Array.isArray(payload.cases) ||
          payload.cases.some(
            (item: unknown) =>
              !isPlainObject(item) ||
              exactFields(item, ['caseId', 'cardId', 'passed'], 'c').length > 0 ||
              typeof item.caseId !== 'string' ||
              !CASE_ID_FORMAT.test(item.caseId) ||
              typeof item.cardId !== 'string' ||
              !cardIds.has(item.cardId) ||
              typeof item.passed !== 'boolean',
          ) ||
          new Set((payload.cases as { caseId: string }[]).map((item) => item.caseId)).size !== payload.cases.length
        ) {
          return { errors: ['candidateGenerationEvaluation.payload: 모양이 맞지 않거나 후보에 없는 카드입니다.'], pass: false };
        }
        const cases = payload.cases as CandidateGenerationEvaluationPayload['cases'];
        const enough = candidate.cards.every(
          (card) => cases.filter((item) => item.cardId === card.id).length >= MIN_GENERATION_CASES_PER_CARD,
        );
        return { errors: [], pass: enough && cases.every((item) => item.passed) };
      })(),
    };

    for (const name of REQUIRED_VALIDATION_CHECKS) {
      const evaluation = evaluations[name];
      const recorded = checks[name].status;
      errors.push(...evaluation.errors);
      if (evaluation.errors.length > 0) continue;
      blockers.push(...(evaluation.blockers ?? []));
      if (recorded === 'not_run') {
        blockers.push(`${name}: 실행되지 않았습니다.`);
      } else if (evaluation.blockers && evaluation.blockers.length > 0 && name === 'krvTextMatch') {
        // 원문을 다시 읽지 못한 경우는 기록의 참·거짓을 판단할 수 없다. 막기만 한다.
      } else if (evaluation.pass && recorded !== 'pass') {
        errors.push(`${name}: payload로는 통과인데 실패로 기록됐습니다.`);
      } else if (!evaluation.pass && recorded === 'pass') {
        errors.push(`${name}: payload로는 실패인데 통과로 기록됐습니다.`);
      } else if (recorded === 'fail') {
        blockers.push(`${name}: 실패했습니다.`);
      }
    }

    // attestation: 항목마다 등록된 validator의 불변 판정이 payload 지문에 묶여 있어야 한다.
    const attestationsByCheck = new Map<RequiredValidationCheck, ValidationAttestation[]>();
    const seen = new Set<string>();
    if (!Array.isArray(context.attestations)) {
      errors.push('attestations: 목록이 아닙니다.');
    } else {
      context.attestations.forEach((item, index) => {
        const label = `attestations[${index}]`;
        if (!isPlainObject(item) || exactFields(item, ATTESTATION_FIELDS, label).length > 0) {
          errors.push(`${label}: 모양이 맞지 않습니다.`);
          return;
        }
        const attestation = item as unknown as ValidationAttestation;
        if (
          attestation.contractVersion !== ATTESTATION_CONTRACT_VERSION ||
          attestation.candidateHash !== record.candidateHash ||
          !(REQUIRED_VALIDATION_CHECKS as readonly unknown[]).includes(attestation.checkName) ||
          !(VERDICTS as readonly unknown[]).includes(attestation.verdict)
        ) {
          errors.push(`${label}: 계약 버전·후보·항목·판정이 맞지 않습니다.`);
          return;
        }
        const check = checks[attestation.checkName];
        const profile = profilesByHash.get(attestation.profileHash);
        if (attestation.payloadHash !== check.artifactHash) errors.push(`${label}: 다른 payload에 대한 attestation입니다.`);
        if (!profile) errors.push(`${label}: 등록되지 않은 validator profile입니다.`);
        else if (!profile.authorizedChecks.includes(attestation.checkName)) errors.push(`${label}: 이 항목을 판정할 권한이 없는 profile입니다.`);
        if (check.status === 'not_run') errors.push(`${label}: 실행되지 않은 항목에는 attestation이 있을 수 없습니다.`);
        else if (attestation.verdict !== check.status) errors.push(`${label}: 기록된 결과와 attestation 판정이 다릅니다.`);
        const key = `${attestation.checkName}:${attestation.profileHash}`;
        if (seen.has(key)) errors.push(`${label}: 같은 profile의 같은 항목 attestation이 두 번 있습니다.`);
        seen.add(key);
        attestationsByCheck.set(attestation.checkName, [...(attestationsByCheck.get(attestation.checkName) ?? []), attestation]);
      });
    }
    for (const name of REQUIRED_VALIDATION_CHECKS) {
      if (checks[name].status !== 'not_run' && (attestationsByCheck.get(name) ?? []).length === 0) {
        errors.push(`${name}: 등록된 validator의 attestation이 없습니다.`);
      }
    }
    const theologyAttesters = (attestationsByCheck.get('contextTheologyReview') ?? []).map((item) => item.profileHash).sort();
    const theologyPayload = checks.contextTheologyReview.payload as unknown;
    const theologyEvaluators = (
      isPlainObject(theologyPayload) && Array.isArray(theologyPayload.evaluations) ? theologyPayload.evaluations : []
    )
      .map((item: unknown) => (isPlainObject(item) ? item.profileHash : null))
      .sort();
    if (checks.contextTheologyReview.status !== 'not_run' && canonicalJson(theologyAttesters) !== canonicalJson(theologyEvaluators)) {
      errors.push('contextTheologyReview: 평가한 validator와 attestation을 낸 validator가 다릅니다.');
    }

    const everyCheckPass = REQUIRED_VALIDATION_CHECKS.every((name) => checks[name].status === 'pass');
    if (record.overallStatus !== 'pass' && record.overallStatus !== 'fail') {
      errors.push('validation.overallStatus: 알 수 없는 값입니다.');
    } else if ((record.overallStatus === 'pass') !== everyCheckPass) {
      errors.push('validation.overallStatus: 항목별 결과와 맞지 않습니다.');
    } else if (record.overallStatus === 'fail') {
      blockers.push('validation.overallStatus: 전체 결과가 실패입니다.');
    }

    if (errors.length > 0) return fail(errors);
    return { valid: true, errors: [], activationBlockers: [...new Set(blockers)] };
  } catch {
    return fail(['검증 기록을 확인하지 못했습니다.']);
  }
}

/* ------------------------------------------------------------------ */
/* 참조 의미: 수요 집계 · 보관 · 활성화 · 롤백 계획                         */
/* ------------------------------------------------------------------ */

export type StoredVersion = { catalog: ScriptureCatalogSnapshot; parentVersionHash: string | null };
export type StoredValidation = {
  candidateHash: string;
  record: AutomaticValidationRecord;
  attestations: ValidationAttestation[];
};
export type BaselineEvent = { requestId: string; versionHash: string; pointerRevision: number };
export type ActivationEvent = {
  requestId: string;
  candidateHash: string;
  validationHash: string;
  fromVersionHash: string;
  toVersionHash: string;
  pointerRevision: number;
  authority: typeof AUTOMATED_VALIDATION_AUTHORITY;
};
export type RollbackEvent = {
  requestId: string;
  fromVersionHash: string;
  toVersionHash: string;
  reasonCode: RollbackReasonCode;
  pointerRevision: number;
  authority: typeof AUTOMATED_OPERATIONS_AUTHORITY;
};

/** 소유자 공지 한 건. 지문과 이유 코드만 담는다. 받는 사람 주소나 사용자 정보는 없다. */
export type OwnerNotification = {
  kind: OwnerNotificationKind;
  pointerRevision: number;
  fromVersionHash: string | null;
  toVersionHash: string;
  candidateHash: string | null;
  reasonCode: RollbackReasonCode | null;
};

export type CatalogLedgerState = {
  readonly activeVersionHash: string | null;
  readonly pointerRevision: number;
  /** 연구 보관소에 실제로 있는 연구 결과 지문. DB에서는 private.research_result 표다. */
  readonly researchResultHashes: readonly string[];
  readonly demandCells: readonly DemandCell[];
  readonly versions: Readonly<Record<string, StoredVersion>>;
  readonly candidates: Readonly<Record<string, ScriptureCatalogCandidate>>;
  readonly validations: Readonly<Record<string, StoredValidation>>;
  readonly baseline: BaselineEvent | null;
  readonly activations: readonly ActivationEvent[];
  readonly rollbacks: readonly RollbackEvent[];
  readonly notifications: readonly OwnerNotification[];
};

export const EMPTY_CATALOG_LEDGER: CatalogLedgerState = Object.freeze({
  activeVersionHash: null,
  pointerRevision: 0,
  researchResultHashes: [],
  demandCells: [],
  versions: {},
  candidates: {},
  validations: {},
  baseline: null,
  activations: [],
  rollbacks: [],
  notifications: [],
});

export const PLAN_FAILURE_CODES = [
  'invalid_request',
  'invalid_evidence',
  'not_found',
  'research_result_missing',
  'conflict',
  'idempotency_conflict',
  'baseline_missing',
  'baseline_already_registered',
  'stale_active_version',
  'validation_blocked',
  'demand_evidence_mismatch',
  'already_activated',
  'rollback_target_not_previous',
] as const;
export type PlanFailureCode = (typeof PLAN_FAILURE_CODES)[number];

export type PlanResult<T> =
  | { ok: true; state: CatalogLedgerState; value: T; replayed: boolean }
  | { ok: false; code: PlanFailureCode; errors: string[] };

const refuse = <T>(code: PlanFailureCode, ...errors: string[]): PlanResult<T> => ({ ok: false, code, errors });

function wasEverActive(state: CatalogLedgerState, versionHash: string): boolean {
  return (
    state.baseline?.versionHash === versionHash ||
    state.activations.some((event) => event.toVersionHash === versionHash) ||
    state.rollbacks.some((event) => event.toVersionHash === versionHash)
  );
}

function isAncestor(state: CatalogLedgerState, versionHash: string, target: string): boolean {
  const seen = new Set<string>();
  let cursor = state.versions[versionHash]?.parentVersionHash ?? null;
  while (cursor !== null && !seen.has(cursor)) {
    if (cursor === target) return true;
    seen.add(cursor);
    cursor = state.versions[cursor]?.parentVersionHash ?? null;
  }
  return false;
}

/**
 * 수요 관찰 한 번을 날짜별 집계에 더한다. 받는 것은 집계 종류·대상 키·날짜뿐이다.
 * weak_match는 현재 활성 카탈로그에 있는 영역만, normalized_theme은 주제 지문 모양만 받는다.
 */
export function planRecordDemandObservation(
  state: CatalogLedgerState,
  request: { evidenceKind: DemandBindingKind; subjectKey: string; bucketDate: string },
): PlanResult<DemandCell> {
  if (!(DEMAND_BINDING_KINDS as readonly unknown[]).includes(request.evidenceKind) || !enumerateDemandWindow(request.bucketDate, request.bucketDate)) {
    return refuse('invalid_request', '수요 관찰 요청 모양이 맞지 않습니다.');
  }
  if (request.evidenceKind === 'weak_match') {
    const active = state.activeVersionHash ? state.versions[state.activeVersionHash] : undefined;
    if (!active) return refuse('baseline_missing', '활성 카탈로그가 없습니다.');
    if (!DOMAIN_ID_FORMAT.test(request.subjectKey) || !active.catalog.domains.some((domain) => domain.id === request.subjectKey)) {
      return refuse('invalid_request', '활성 카탈로그에 없는 영역입니다.');
    }
  } else if (!THEME_FINGERPRINT_FORMAT.test(request.subjectKey)) {
    return refuse('invalid_request', '정규화 주제 지문 모양이 맞지 않습니다.');
  }
  const index = state.demandCells.findIndex(
    (cell) => cell.evidenceKind === request.evidenceKind && cell.subjectKey === request.subjectKey && cell.bucketDate === request.bucketDate,
  );
  const cell: DemandCell = { ...request, count: index === -1 ? 1 : state.demandCells[index].count + 1 };
  const demandCells = index === -1 ? [...state.demandCells, cell] : state.demandCells.map((item, i) => (i === index ? cell : item));
  return { ok: true, replayed: false, value: cell, state: { ...state, demandCells } };
}

/** 서버 카탈로그의 첫 판을 등록한다. 한 번뿐이다. 같은 요청의 재실행은 같은 결과를 돌려준다. */
export async function planBaselineRegistration(
  state: CatalogLedgerState,
  request: { requestId: string; catalog: ScriptureCatalogSnapshot },
): Promise<PlanResult<BaselineEvent>> {
  if (!isHash(request.requestId, REQUEST_ID_FORMAT)) return refuse('invalid_request', '요청 번호 모양이 맞지 않습니다.');
  const snapshot = validateCatalogSnapshot(request.catalog);
  if (!snapshot.valid) return refuse('invalid_request', ...snapshot.errors);
  const versionHash = await computeCatalogVersionHash(request.catalog);

  if (state.baseline) {
    if (state.baseline.requestId === request.requestId && state.baseline.versionHash === versionHash) {
      return { ok: true, state, value: state.baseline, replayed: true };
    }
    return refuse('baseline_already_registered', '기준 카탈로그는 이미 등록됐습니다.');
  }
  if (state.activeVersionHash !== null) return refuse('conflict', '활성 버전이 이미 있습니다.');

  const event: BaselineEvent = { requestId: request.requestId, versionHash, pointerRevision: 1 };
  const notification: OwnerNotification = {
    kind: 'baseline_registered',
    pointerRevision: 1,
    fromVersionHash: null,
    toVersionHash: versionHash,
    candidateHash: null,
    reasonCode: null,
  };
  return {
    ok: true,
    replayed: false,
    value: event,
    state: {
      ...state,
      activeVersionHash: versionHash,
      pointerRevision: 1,
      versions: { ...state.versions, [versionHash]: { catalog: structuredClone(request.catalog), parentVersionHash: null } },
      baseline: event,
      notifications: [...state.notifications, notification],
    },
  };
}

/**
 * 후보와 그 결과 카탈로그를 함께 적는다. 같은 지문에 같은 내용이면 다시 적지 않고, 다르면 거절한다.
 * 연구 결과가 저장소에 없으면 적지 않는다.
 */
export async function planStoreCandidate(
  state: CatalogLedgerState,
  request: { candidateHash: string; candidate: ScriptureCatalogCandidate },
): Promise<PlanResult<string>> {
  if (!isHash(request.candidateHash, CATALOG_CANDIDATE_HASH_FORMAT)) return refuse('invalid_request', '후보 지문 모양이 맞지 않습니다.');
  const baseVersionHash = (request.candidate as { baseVersionHash?: unknown })?.baseVersionHash;
  const base = typeof baseVersionHash === 'string' ? state.versions[baseVersionHash] : undefined;
  if (!base) return refuse('not_found', '기준 카탈로그 버전이 없습니다.');

  const check = await validateCatalogCandidate(request.candidate, base.catalog);
  if (!check.valid || !check.proposedCatalog) return refuse('invalid_evidence', ...check.errors);
  if (request.candidateHash !== (await computeCatalogCandidateHash(request.candidate))) {
    return refuse('invalid_evidence', '후보 지문이 내용과 맞지 않습니다.');
  }
  if (!state.researchResultHashes.includes(request.candidate.sourceResearchResultHash)) {
    return refuse('research_result_missing', '연구 보관소에 없는 연구 결과입니다.');
  }

  const existing = state.candidates[request.candidateHash];
  if (existing) {
    if (canonicalJson(existing) === canonicalJson(request.candidate)) {
      return { ok: true, state, value: request.candidateHash, replayed: true };
    }
    return refuse('conflict', '같은 지문으로 다른 후보가 들어왔습니다.');
  }

  const proposedHash = request.candidate.proposedVersionHash;
  const existingVersion = state.versions[proposedHash];
  if (
    existingVersion &&
    (existingVersion.parentVersionHash !== baseVersionHash ||
      canonicalJson(existingVersion.catalog) !== canonicalJson(check.proposedCatalog))
  ) {
    return refuse('conflict', '같은 버전 지문으로 다른 카탈로그가 있습니다.');
  }

  return {
    ok: true,
    replayed: false,
    value: request.candidateHash,
    state: {
      ...state,
      versions: existingVersion
        ? state.versions
        : { ...state.versions, [proposedHash]: { catalog: check.proposedCatalog, parentVersionHash: baseVersionHash as string } },
      candidates: { ...state.candidates, [request.candidateHash]: structuredClone(request.candidate) },
    },
  };
}

/**
 * 검증 기록과 그 attestation들을 한 묶음으로 적는다. 사실대로 실패한 검증도 증거로 남긴다.
 * 활성화 여부는 여기서 정하지 않는다.
 */
export async function planStoreValidation(
  state: CatalogLedgerState,
  request: {
    validationHash: string;
    candidateHash: string;
    record: AutomaticValidationRecord;
    attestations: ValidationAttestation[];
  },
  dependencies: ValidationDependencies,
): Promise<PlanResult<string>> {
  if (!isHash(request.validationHash, VALIDATION_HASH_FORMAT)) return refuse('invalid_request', '검증 지문 모양이 맞지 않습니다.');
  const candidate = state.candidates[request.candidateHash];
  if (!candidate) return refuse('not_found', '후보가 없습니다.');
  const base = state.versions[candidate.baseVersionHash];
  if (!base) return refuse('not_found', '기준 카탈로그 버전이 없습니다.');

  const check = await validateAutomaticValidationRecord(request.record, {
    ...dependencies,
    candidate,
    baseCatalog: base.catalog,
    attestations: request.attestations,
  });
  if (!check.valid) return refuse('invalid_evidence', ...check.errors);
  if (request.record.candidateHash !== request.candidateHash) return refuse('invalid_evidence', '다른 후보의 검증 기록입니다.');
  if (request.validationHash !== (await computeValidationHash(request.record))) {
    return refuse('invalid_evidence', '검증 지문이 내용과 맞지 않습니다.');
  }

  const existing = state.validations[request.validationHash];
  if (existing) {
    if (
      existing.candidateHash === request.candidateHash &&
      canonicalJson(existing.record) === canonicalJson(request.record) &&
      canonicalJson(existing.attestations) === canonicalJson(request.attestations)
    ) {
      return { ok: true, state, value: request.validationHash, replayed: true };
    }
    return refuse('conflict', '같은 지문으로 다른 검증 기록이 들어왔습니다.');
  }

  return {
    ok: true,
    replayed: false,
    value: request.validationHash,
    state: {
      ...state,
      validations: {
        ...state.validations,
        [request.validationHash]: {
          candidateHash: request.candidateHash,
          record: structuredClone(request.record),
          attestations: structuredClone(request.attestations),
        },
      },
    },
  };
}

/**
 * 자동 검증을 통과한 후보를 활성화한다.
 *
 * 한 번에 함께 일어나는 것: 활성화 기록, 활성 포인터 전환, 소유자 공지 기록.
 * 하나라도 막히면 아무것도 바뀌지 않는다(입력 상태를 그대로 둔다).
 * 같은 요청 번호로 같은 내용을 다시 보내면 이미 끝난 결과를 돌려준다.
 * 활성화 순간에 연구 결과 존재, 검증 기록·attestation, 수요 evidence와 실제 집계를 모두 다시 확인한다.
 */
export async function planActivation(
  state: CatalogLedgerState,
  request: {
    requestId: string;
    candidateHash: string;
    validationHash: string;
    expectedActiveVersionHash: string;
    /** 활성화하는 날(서울 기준). 수요 기간은 이 날보다 앞서 끝난, 더 바뀌지 않는 날짜여야 한다. */
    activationDate: string;
  },
  dependencies: ValidationDependencies,
): Promise<PlanResult<ActivationEvent>> {
  if (
    !isHash(request.requestId, REQUEST_ID_FORMAT) ||
    !isHash(request.candidateHash, CATALOG_CANDIDATE_HASH_FORMAT) ||
    !isHash(request.validationHash, VALIDATION_HASH_FORMAT) ||
    !isHash(request.expectedActiveVersionHash, CATALOG_VERSION_HASH_FORMAT) ||
    !enumerateDemandWindow(request.activationDate, request.activationDate)
  ) {
    return refuse('invalid_request', '활성화 요청 모양이 맞지 않습니다.');
  }

  const replay = state.activations.find((event) => event.requestId === request.requestId);
  if (replay) {
    if (
      replay.candidateHash === request.candidateHash &&
      replay.validationHash === request.validationHash &&
      replay.fromVersionHash === request.expectedActiveVersionHash
    ) {
      return { ok: true, state, value: replay, replayed: true };
    }
    return refuse('idempotency_conflict', '같은 요청 번호로 다른 활성화가 들어왔습니다.');
  }

  if (state.activeVersionHash === null || !state.baseline) return refuse('baseline_missing', '활성 카탈로그가 없습니다.');
  if (state.activeVersionHash !== request.expectedActiveVersionHash) {
    return refuse('stale_active_version', '활성 버전이 이미 바뀌었습니다.');
  }

  const candidate = state.candidates[request.candidateHash];
  if (!candidate) return refuse('not_found', '후보가 없습니다.');
  if (candidate.baseVersionHash !== state.activeVersionHash) {
    return refuse('stale_active_version', '후보의 기준 버전이 현재 활성 버전이 아닙니다.');
  }
  if (!state.researchResultHashes.includes(candidate.sourceResearchResultHash)) {
    return refuse('research_result_missing', '연구 보관소에 없는 연구 결과입니다.');
  }
  if (
    state.activations.some(
      (event) => event.candidateHash === request.candidateHash || event.toVersionHash === candidate.proposedVersionHash,
    )
  ) {
    return refuse('already_activated', '이미 활성화된 후보 또는 버전입니다.');
  }

  const stored = state.validations[request.validationHash];
  if (!stored || stored.candidateHash !== request.candidateHash) return refuse('not_found', '이 후보의 검증 기록이 없습니다.');
  const base = state.versions[candidate.baseVersionHash];
  const proposed = state.versions[candidate.proposedVersionHash];
  if (!base || !proposed || proposed.parentVersionHash !== candidate.baseVersionHash) {
    return refuse('not_found', '후보의 카탈로그 버전이 올바르게 적혀 있지 않습니다.');
  }

  // 적어 둔 기록을 믿지 않고 활성화 순간에 다시 확인한다.
  const check = await validateAutomaticValidationRecord(stored.record, {
    ...dependencies,
    candidate,
    baseCatalog: base.catalog,
    attestations: stored.attestations,
  });
  if (!check.valid) return refuse('invalid_evidence', ...check.errors);
  if (check.activationBlockers.length > 0) return refuse('validation_blocked', ...check.activationBlockers);
  if (request.validationHash !== (await computeValidationHash(stored.record))) {
    return refuse('invalid_evidence', '검증 지문이 내용과 맞지 않습니다.');
  }

  // 수요 evidence가 실제 집계에서 다시 만든 값과 같아야 한다. 기간은 활성화 날보다 앞서 끝나야 한다.
  const demand = stored.record.checks.demandSignal.payload;
  if (demand.windowEndDate >= request.activationDate) {
    return refuse('demand_evidence_mismatch', '수요 기간이 아직 끝나지 않았습니다.');
  }
  const rebuilt = buildDemandEvidence(candidate.demandBinding, demand, state.demandCells);
  if (!rebuilt || canonicalJson(rebuilt) !== canonicalJson(demand)) {
    return refuse('demand_evidence_mismatch', '수요 evidence가 실제 집계와 다릅니다.');
  }

  const pointerRevision = state.pointerRevision + 1;
  const event: ActivationEvent = {
    requestId: request.requestId,
    candidateHash: request.candidateHash,
    validationHash: request.validationHash,
    fromVersionHash: state.activeVersionHash,
    toVersionHash: candidate.proposedVersionHash,
    pointerRevision,
    authority: AUTOMATED_VALIDATION_AUTHORITY,
  };
  const notification: OwnerNotification = {
    kind: 'catalog_activated',
    pointerRevision,
    fromVersionHash: state.activeVersionHash,
    toVersionHash: candidate.proposedVersionHash,
    candidateHash: request.candidateHash,
    reasonCode: null,
  };
  return {
    ok: true,
    replayed: false,
    value: event,
    state: {
      ...state,
      activeVersionHash: candidate.proposedVersionHash,
      pointerRevision,
      activations: [...state.activations, event],
      notifications: [...state.notifications, notification],
    },
  };
}

/**
 * 이전에 활성이었던 조상 버전으로 되돌린다.
 * 한 번에 함께 일어나는 것: 롤백 기록, 활성 포인터 전환, 소유자 공지 기록.
 */
export async function planRollback(
  state: CatalogLedgerState,
  request: {
    requestId: string;
    targetVersionHash: string;
    expectedActiveVersionHash: string;
    reasonCode: RollbackReasonCode;
  },
): Promise<PlanResult<RollbackEvent>> {
  if (
    !isHash(request.requestId, REQUEST_ID_FORMAT) ||
    !isHash(request.targetVersionHash, CATALOG_VERSION_HASH_FORMAT) ||
    !isHash(request.expectedActiveVersionHash, CATALOG_VERSION_HASH_FORMAT) ||
    !(ROLLBACK_REASON_CODES as readonly unknown[]).includes(request.reasonCode)
  ) {
    return refuse('invalid_request', '롤백 요청 모양이 맞지 않습니다.');
  }

  const replay = state.rollbacks.find((event) => event.requestId === request.requestId);
  if (replay) {
    if (
      replay.toVersionHash === request.targetVersionHash &&
      replay.fromVersionHash === request.expectedActiveVersionHash &&
      replay.reasonCode === request.reasonCode
    ) {
      return { ok: true, state, value: replay, replayed: true };
    }
    return refuse('idempotency_conflict', '같은 요청 번호로 다른 롤백이 들어왔습니다.');
  }

  if (state.activeVersionHash === null || !state.baseline) return refuse('baseline_missing', '활성 카탈로그가 없습니다.');
  if (state.activeVersionHash !== request.expectedActiveVersionHash) {
    return refuse('stale_active_version', '활성 버전이 이미 바뀌었습니다.');
  }
  if (
    request.targetVersionHash === state.activeVersionHash ||
    !state.versions[request.targetVersionHash] ||
    !isAncestor(state, state.activeVersionHash, request.targetVersionHash) ||
    !wasEverActive(state, request.targetVersionHash)
  ) {
    return refuse('rollback_target_not_previous', '이전에 활성이었던 조상 버전으로만 되돌릴 수 있습니다.');
  }

  const pointerRevision = state.pointerRevision + 1;
  const event: RollbackEvent = {
    requestId: request.requestId,
    fromVersionHash: state.activeVersionHash,
    toVersionHash: request.targetVersionHash,
    reasonCode: request.reasonCode,
    pointerRevision,
    authority: AUTOMATED_OPERATIONS_AUTHORITY,
  };
  const notification: OwnerNotification = {
    kind: 'catalog_rolled_back',
    pointerRevision,
    fromVersionHash: state.activeVersionHash,
    toVersionHash: request.targetVersionHash,
    candidateHash: null,
    reasonCode: request.reasonCode,
  };
  return {
    ok: true,
    replayed: false,
    value: event,
    state: {
      ...state,
      activeVersionHash: request.targetVersionHash,
      pointerRevision,
      rollbacks: [...state.rollbacks, event],
      notifications: [...state.notifications, notification],
    },
  };
}
