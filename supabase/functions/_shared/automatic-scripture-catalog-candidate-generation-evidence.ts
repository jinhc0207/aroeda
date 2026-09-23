/**
 * 후보 카드별 생성 사례의 append-only 증거 계약과 결정적 재생 adapter.
 *
 * 사례 작성 모델은 후보 생성 모델과 다른 independenceGroup이어야 한다. 모델은 합성 문장만
 * 만들고, 사례 id·후보 연결·분석·판정·지문은 코드가 만든다. 이 모듈은 네트워크·DB·시계·
 * 환경변수를 읽지 않는다.
 *
 * 사례 저작 설정의 결속
 *   profile은 이름표(promptVersion·schemaVersion)만 들고 있으면 안 된다. 이름표만 있으면
 *   지시문을 고쳐도 봉인된 증거가 바이트 단위로 그대로여서, 옛 설정으로 만든 증거를 지금
 *   증거로 받아들이게 된다. 그래서 두 가지를 실제 원본에서 다시 계산해 묶는다.
 *
 *     - `caseAuthorProfile.instructionsHash` — 정적. 실제 요청에 쓰는 지시문 원문의 지문.
 *     - `caseAuthorRequest.schemaHash`       — 후보별. 실제 전송하는 text.format의 지문.
 *                                              스키마에 후보의 카드 id가 들어가므로 정적
 *                                              profile에 담을 수 없고, 검증할 때 같은
 *                                              후보의 카드 id로 다시 만들어 대조한다.
 *     - `analysisRequest.requestHash`        — 생성용 Analyzer 요청 설정의 지문. 전송 본문에서
 *                                              사례 문장(input)만 뺀 나머지 전부를 묶는다.
 *                                              공용 environment는 모델·지시문·스키마만 담아
 *                                              출력 상한·도구·스트리밍·잘라내기 설정을 잡지
 *                                              못하므로 따로 둔다.
 *
 *   원본은 `automatic-scripture-catalog-case-author-contract.ts` 한 곳에만 둔다. 요청
 *   생성·증거 봉인·증거 재검증이 모두 그 파일을 쓰므로 세 곳이 갈라질 수 없다.
 *
 * 이 지문들이 증명하지 않는 것
 *   설정의 동일성만 말한다. 실제로 모델을 불렀다는 증명도 전자서명도 아니다. 증거를 쓸 수
 *   있는 주체는 하위 지문과 최상위 지문을 모두 다시 계산해 사례를 지어낼 수 있다. 그 경계는
 *   권한이 제한된 append-only 저장과 활성화 시 재검증으로만 좁혀진다.
 */

import {
  ARTIFACT_HASH_FORMAT,
  CATALOG_CANDIDATE_HASH_FORMAT,
  type ScriptureCatalogCandidate,
  type ScriptureCatalogSnapshot,
  canonicalJson,
  computeArtifactHash,
  computeCatalogCandidateHash,
  scanForbiddenContent,
  validateCatalogCandidate,
} from './automatic-scripture-catalog-contract.ts';
import type { CandidateGenerationEvaluationPayload } from './automatic-scripture-catalog-activation-contract.ts';
import {
  type AnalysisSnapshotEnvironmentBinding,
  validateFrozenSituationAnalysisShape,
} from './automatic-scripture-catalog-analysis-snapshot-contract.ts';
import { buildCandidateGenerationAnalysisEnvironment } from './automatic-scripture-catalog-analysis-environment.ts';
import {
  STATIC_ANALYZER_DOMAIN_MANIFEST,
  analyzerDomainIds,
  buildCandidateAnalyzerDomainManifest,
  type AnalyzerDomainManifest,
} from './automatic-scripture-catalog-analyzer-domain-manifest.ts';
import {
  CANDIDATE_GENERATION_CASES_PER_CARD,
  CASE_AUTHOR_TEXT_MAX_LENGTH,
  computeCaseAuthorInstructionsHash,
  computeCaseAuthorSchemaHash,
} from './automatic-scripture-catalog-case-author-contract.ts';
import { computeCandidateGenerationAnalysisRequestHash } from './automatic-scripture-catalog-generation-analysis-request.ts';
import { catalogSnapshotToGateCards } from './automatic-scripture-catalog-frozen-analysis-adapter.ts';
import {
  ASTRA_MODEL_ID,
  EVALUATOR_MODEL_FAMILIES,
  lookupEvaluatorModel,
} from './automatic-scripture-catalog-validator-registry.ts';
import { CANDIDATE_GENERATION_RUNTIME_CONFIG } from './published-content-candidate-generation-runtime-config.ts';
import { runRecommendationGate } from './recommendation-gate.ts';
import { type SituationAnalysis, validateSituationAnalysisForDomains } from './situation-analysis.ts';

export const CANDIDATE_GENERATION_EVIDENCE_CONTRACT_VERSION =
  'scripture-catalog-candidate-generation-evidence/v1';
export const CANDIDATE_GENERATION_CASE_AUTHOR_PROFILE_CONTRACT_VERSION =
  'scripture-catalog-candidate-generation-case-author-profile/v1';
/** 원본은 case-author-contract에 있다. 스키마의 minItems·maxItems와 같은 값이어야 한다. */
export { CANDIDATE_GENERATION_CASES_PER_CARD };

export type CandidateGenerationCaseAuthorProfile = {
  contractVersion: typeof CANDIDATE_GENERATION_CASE_AUTHOR_PROFILE_CONTRACT_VERSION;
  profileId: string;
  profileVersion: string;
  modelId: string;
  independenceGroup: string;
  promptVersion: string;
  /** promptVersion 이름표가 아니라 지시문 원문의 지문. 지시문이 바뀌면 옛 증거가 거절된다. */
  instructionsHash: string;
  schemaVersion: string;
};

export const CANDIDATE_GENERATION_CASE_AUTHOR_PROFILE: Readonly<CandidateGenerationCaseAuthorProfile> =
  Object.freeze({
    contractVersion: CANDIDATE_GENERATION_CASE_AUTHOR_PROFILE_CONTRACT_VERSION,
    profileId: 'aroeda-candidate-generation-case-author-astra',
    profileVersion: 'v1',
    modelId: ASTRA_MODEL_ID,
    independenceGroup: EVALUATOR_MODEL_FAMILIES[ASTRA_MODEL_ID].independenceGroup,
    promptVersion: 'aroeda-candidate-generation-case-author/v1',
    // 하드코딩한 지문이 아니라 실제 요청에 쓰는 지시문에서 모듈 적재 시점에 계산한다.
    instructionsHash: await computeCaseAuthorInstructionsHash(),
    schemaVersion: 'aroeda-candidate-generation-case-author-schema/v1',
  });

/**
 * 후보별 요청 결속.
 *
 * 전송 스키마에는 이 후보의 카드 id가 들어가므로 정적 profile에 담을 수 없다. 검증할 때
 * 같은 후보의 카드 id로 다시 계산해 대조한다.
 */
export type CandidateGenerationCaseAuthorRequestBinding = {
  /** 실제 전송한 text.format 전체(name·strict·스키마)의 지문. */
  schemaHash: string;
};

/**
 * 후보 생성용 Analyzer 요청 설정의 결속.
 *
 * 운영 `analyze-situation`과 달리 생성용 분석은 출력 상한·도구 없음·비스트리밍·비백그라운드·
 * 잘라내기 금지를 함께 보낸다. 공용 `environment`는 모델·지시문·스키마만 담으므로 이
 * 차이를 잡지 못한다. 그래서 실제 전송 본문에서 사례 문장(`input`)만 뺀 나머지 전부를
 * 지문으로 묶는다.
 */
export type CandidateGenerationAnalysisRequestBinding = {
  /** 전송 본문에서 input을 뺀 전체 객체의 지문. 문장과 무관하다. */
  requestHash: string;
};

export type CandidateGenerationEvidenceCase = {
  caseId: string;
  cardId: string;
  text: string;
  analysis: SituationAnalysis<string>;
};

export type CandidateGenerationEvidence = {
  contractVersion: typeof CANDIDATE_GENERATION_EVIDENCE_CONTRACT_VERSION;
  candidateHash: string;
  baseVersionHash: string;
  proposedVersionHash: string;
  sourceResearchResultHash: string;
  candidateGeneration: { modelId: string; promptVersion: string };
  caseAuthorProfile: CandidateGenerationCaseAuthorProfile;
  caseAuthorProfileHash: string;
  caseAuthorRequest: CandidateGenerationCaseAuthorRequestBinding;
  analysisRequest: CandidateGenerationAnalysisRequestBinding;
  environment: AnalysisSnapshotEnvironmentBinding;
  cases: CandidateGenerationEvidenceCase[];
  artifactHash: string;
};

export type CandidateGenerationEvidenceValidation = { valid: boolean; errors: string[] };

const TOP_FIELDS = [
  'contractVersion',
  'candidateHash',
  'baseVersionHash',
  'proposedVersionHash',
  'sourceResearchResultHash',
  'candidateGeneration',
  'caseAuthorProfile',
  'caseAuthorProfileHash',
  'caseAuthorRequest',
  'analysisRequest',
  'environment',
  'cases',
  'artifactHash',
] as const;
const GENERATION_FIELDS = ['modelId', 'promptVersion'] as const;
const PROFILE_FIELDS = [
  'contractVersion',
  'profileId',
  'profileVersion',
  'modelId',
  'independenceGroup',
  'promptVersion',
  'instructionsHash',
  'schemaVersion',
] as const;
const REQUEST_FIELDS = ['schemaHash'] as const;
const ANALYSIS_REQUEST_FIELDS = ['requestHash'] as const;
const CASE_FIELDS = ['caseId', 'cardId', 'text', 'analysis'] as const;
const TEXT_MAX = CASE_AUTHOR_TEXT_MAX_LENGTH;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function exactFields(value: Record<string, unknown>, allowed: readonly string[], label: string): string[] {
  const allowedSet = new Set(allowed);
  const errors = Object.keys(value)
    .filter((key) => !allowedSet.has(key))
    .sort()
    .map((key) => `${label}: 계약에 없는 항목입니다: ${key}`);
  for (const field of allowed) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) errors.push(`${label}.${field}: 항목이 없습니다.`);
  }
  return errors;
}

const expectedCaseId = (cardId: string, index: number) =>
  `GEN-${cardId}-${String(index + 1).padStart(2, '0')}`;

const artifactProjection = (evidence: Omit<CandidateGenerationEvidence, 'artifactHash'>) => ({ ...evidence });

export async function computeCandidateGenerationCaseAuthorProfileHash(
  profile: CandidateGenerationCaseAuthorProfile,
): Promise<string> {
  return computeArtifactHash(profile);
}

export async function computeCandidateGenerationEvidenceArtifactHash(
  evidence: Omit<CandidateGenerationEvidence, 'artifactHash'>,
): Promise<string> {
  return computeArtifactHash(artifactProjection(evidence));
}

/** 검증 전에 쓸 증거를 봉인한다. 이 함수는 유효성을 대신 판단하지 않는다. */
export async function sealCandidateGenerationEvidence(input: {
  candidate: ScriptureCatalogCandidate;
  environment: AnalysisSnapshotEnvironmentBinding;
  cases: CandidateGenerationEvidenceCase[];
  caseAuthorProfile?: CandidateGenerationCaseAuthorProfile;
  analyzerDomainManifest?: AnalyzerDomainManifest;
}): Promise<CandidateGenerationEvidence> {
  const profile = structuredClone(input.caseAuthorProfile ?? CANDIDATE_GENERATION_CASE_AUTHOR_PROFILE);
  const withoutHash: Omit<CandidateGenerationEvidence, 'artifactHash'> = {
    contractVersion: CANDIDATE_GENERATION_EVIDENCE_CONTRACT_VERSION,
    candidateHash: await computeCatalogCandidateHash(input.candidate),
    baseVersionHash: input.candidate.baseVersionHash,
    proposedVersionHash: input.candidate.proposedVersionHash,
    sourceResearchResultHash: input.candidate.sourceResearchResultHash,
    candidateGeneration: {
      modelId: input.candidate.generation.modelId,
      promptVersion: input.candidate.generation.promptVersion,
    },
    caseAuthorProfile: profile,
    caseAuthorProfileHash: await computeCandidateGenerationCaseAuthorProfileHash(profile),
    caseAuthorRequest: {
      schemaHash: await computeCaseAuthorSchemaHash(input.candidate.cards.map((card) => card.id)),
    },
    analysisRequest: {
      requestHash: await computeCandidateGenerationAnalysisRequestHash(
        input.analyzerDomainManifest ?? STATIC_ANALYZER_DOMAIN_MANIFEST,
      ),
    },
    environment: structuredClone(input.environment),
    cases: structuredClone(input.cases),
  };
  return { ...withoutHash, artifactHash: await computeCandidateGenerationEvidenceArtifactHash(withoutHash) };
}

function validateCase(
  value: unknown,
  label: string,
  expectedId: string,
  cardId: string,
  domainId: string,
  forbiddenLiterals: readonly string[],
  manifest: AnalyzerDomainManifest,
): string[] {
  if (!isPlainObject(value)) return [`${label}: 객체가 아닙니다.`];
  const errors = exactFields(value, CASE_FIELDS, label);
  if (value.caseId !== expectedId) errors.push(`${label}.caseId: '${expectedId}'이어야 합니다.`);
  if (value.cardId !== cardId) errors.push(`${label}.cardId: 카드 순서와 맞지 않습니다.`);
  if (typeof value.text !== 'string' || value.text.trim() !== value.text || value.text.length === 0 || value.text.length > TEXT_MAX) {
    errors.push(`${label}.text: 빈 값이거나 너무 깁니다.`);
  } else {
    errors.push(...scanForbiddenContent(value.text, `${label}.text`));
    for (const literal of forbiddenLiterals) {
      if (literal.length > 0 && value.text.includes(literal)) {
        errors.push(`${label}.text: 카드·영역 id나 성경 표기를 직접 포함할 수 없습니다.`);
        break;
      }
    }
  }

  const shapeErrors = validateFrozenSituationAnalysisShape(value.analysis, `${label}.analysis`);
  errors.push(...shapeErrors);
  const analysisCheck = validateSituationAnalysisForDomains(
    value.analysis,
    analyzerDomainIds(manifest),
    manifest.fallbackDomain.id,
    manifest.situationTags,
  );
  if (!analysisCheck.valid) errors.push(...analysisCheck.errors.map((message) => `${label}.analysis: ${message}`));
  if (shapeErrors.length === 0 && analysisCheck.valid) {
    const analysis = value.analysis as SituationAnalysis<string>;
    if (analysis.safety.level !== 'normal') errors.push(`${label}.analysis.safety: normal이어야 합니다.`);
    if (analysis.domainPriority !== 'resolved') errors.push(`${label}.analysis.domainPriority: resolved여야 합니다.`);
    if (analysis.primaryDomain !== domainId) errors.push(`${label}.analysis.primaryDomain: 대상 카드 영역과 같아야 합니다.`);
    if (analysis.domainChoiceCandidates.length !== 0) {
      errors.push(`${label}.analysis.domainChoiceCandidates: 비어 있어야 합니다.`);
    }
  }
  return errors;
}

/** 어떤 입력에서도 예외 대신 실패 결과로 닫힌다. */
export async function validateCandidateGenerationEvidence(
  value: unknown,
  candidate: ScriptureCatalogCandidate,
  baseCatalog: ScriptureCatalogSnapshot,
): Promise<CandidateGenerationEvidenceValidation> {
  try {
    const candidateCheck = await validateCatalogCandidate(candidate, baseCatalog);
    if (!candidateCheck.valid) return { valid: false, errors: ['candidate: 기준 카탈로그 계약과 맞지 않습니다.'] };
    const manifest = await buildCandidateAnalyzerDomainManifest(candidate, baseCatalog);
    if (!isPlainObject(value)) return { valid: false, errors: ['evidence: 객체가 아닙니다.'] };

    const errors = exactFields(value, TOP_FIELDS, 'evidence');
    if (value.contractVersion !== CANDIDATE_GENERATION_EVIDENCE_CONTRACT_VERSION) {
      errors.push(`evidence.contractVersion: '${CANDIDATE_GENERATION_EVIDENCE_CONTRACT_VERSION}'이어야 합니다.`);
    }
    const candidateHash = await computeCatalogCandidateHash(candidate);
    if (typeof value.candidateHash !== 'string' || !CATALOG_CANDIDATE_HASH_FORMAT.test(value.candidateHash)) {
      errors.push('evidence.candidateHash: 형식이 올바르지 않습니다.');
    } else if (value.candidateHash !== candidateHash) {
      errors.push('evidence.candidateHash: 후보에서 다시 계산한 값과 다릅니다.');
    }
    for (const field of ['baseVersionHash', 'proposedVersionHash', 'sourceResearchResultHash'] as const) {
      if (value[field] !== candidate[field]) errors.push(`evidence.${field}: 후보와 다릅니다.`);
    }

    if (!isPlainObject(value.candidateGeneration)) {
      errors.push('evidence.candidateGeneration: 객체가 아닙니다.');
    } else {
      errors.push(...exactFields(value.candidateGeneration, GENERATION_FIELDS, 'evidence.candidateGeneration'));
      if (
        value.candidateGeneration.modelId !== candidate.generation.modelId ||
        value.candidateGeneration.promptVersion !== candidate.generation.promptVersion
      ) {
        errors.push('evidence.candidateGeneration: 후보의 생성 정보와 다릅니다.');
      }
    }
    if (candidate.generation.modelId !== CANDIDATE_GENERATION_RUNTIME_CONFIG.model) {
      errors.push('candidate.generation.modelId: 현재 자동 후보 생성 모델과 다릅니다.');
    }

    if (!isPlainObject(value.caseAuthorProfile)) {
      errors.push('evidence.caseAuthorProfile: 객체가 아닙니다.');
    } else {
      errors.push(...exactFields(value.caseAuthorProfile, PROFILE_FIELDS, 'evidence.caseAuthorProfile'));
      if (canonicalJson(value.caseAuthorProfile) !== canonicalJson(CANDIDATE_GENERATION_CASE_AUTHOR_PROFILE)) {
        errors.push('evidence.caseAuthorProfile: 등록된 Astra 사례 작성 profile과 다릅니다.');
      }
      const profileHash = await computeCandidateGenerationCaseAuthorProfileHash(
        value.caseAuthorProfile as CandidateGenerationCaseAuthorProfile,
      );
      if (value.caseAuthorProfileHash !== profileHash) {
        errors.push('evidence.caseAuthorProfileHash: profile에서 다시 계산한 값과 다릅니다.');
      }
      // 이름표가 아니라 지금 실제로 보내는 지시문 원문에서 다시 계산해 대조한다.
      if (value.caseAuthorProfile.instructionsHash !== (await computeCaseAuthorInstructionsHash())) {
        errors.push('evidence.caseAuthorProfile.instructionsHash: 지금 사례 저작 지시문에서 다시 계산한 값과 다릅니다.');
      }
    }

    // 전송 스키마는 후보의 카드 id를 담으므로 같은 후보로 다시 만들어 대조한다.
    if (!isPlainObject(value.caseAuthorRequest)) {
      errors.push('evidence.caseAuthorRequest: 객체가 아닙니다.');
    } else {
      errors.push(...exactFields(value.caseAuthorRequest, REQUEST_FIELDS, 'evidence.caseAuthorRequest'));
      const schemaHash = await computeCaseAuthorSchemaHash(candidate.cards.map((card) => card.id));
      if (value.caseAuthorRequest.schemaHash !== schemaHash) {
        errors.push('evidence.caseAuthorRequest.schemaHash: 이 후보의 실제 전송 스키마에서 다시 계산한 값과 다릅니다.');
      }
    }

    const generator = lookupEvaluatorModel(candidate.generation.modelId);
    const authorModel = isPlainObject(value.caseAuthorProfile) && typeof value.caseAuthorProfile.modelId === 'string'
      ? lookupEvaluatorModel(value.caseAuthorProfile.modelId)
      : null;
    if (generator === null) errors.push('candidate.generation.modelId: independenceGroup을 확인할 수 없는 모델입니다.');
    if (authorModel === null) errors.push('evidence.caseAuthorProfile.modelId: independenceGroup을 확인할 수 없는 모델입니다.');
    if (generator !== null && authorModel !== null && generator.independenceGroup === authorModel.independenceGroup) {
      errors.push('evidence.caseAuthorProfile: 후보 생성 모델과 독립된 모델 계열이어야 합니다.');
    }

    // 생성용 분석 요청 설정은 지금 요청 생성 함수에서 다시 계산해 대조한다.
    if (!isPlainObject(value.analysisRequest)) {
      errors.push('evidence.analysisRequest: 객체가 아닙니다.');
    } else {
      errors.push(...exactFields(value.analysisRequest, ANALYSIS_REQUEST_FIELDS, 'evidence.analysisRequest'));
      const requestHash = await computeCandidateGenerationAnalysisRequestHash(manifest);
      if (value.analysisRequest.requestHash !== requestHash) {
        errors.push('evidence.analysisRequest.requestHash: 지금 생성용 Analyzer 요청 설정에서 다시 계산한 값과 다릅니다.');
      }
    }

    const currentEnvironment = await buildCandidateGenerationAnalysisEnvironment(candidate, baseCatalog);
    if (!isPlainObject(value.environment)) {
      errors.push('evidence.environment: 객체가 아닙니다.');
    } else if (canonicalJson(value.environment) !== canonicalJson(currentEnvironment)) {
      errors.push('evidence.environment: 현재 Analyzer 환경과 다릅니다.');
    }

    if (!Array.isArray(value.cases)) {
      errors.push('evidence.cases: 배열이 아닙니다.');
    } else {
      const expectedCount = candidate.cards.length * CANDIDATE_GENERATION_CASES_PER_CARD;
      if (value.cases.length !== expectedCount) {
        errors.push(`evidence.cases: 카드마다 정확히 ${CANDIDATE_GENERATION_CASES_PER_CARD}건이어야 합니다.`);
      }
      const forbiddenLiterals = [candidate.targetDomainId, ...candidate.cards.flatMap((card) => [card.id, card.referenceLabel])];
      let cursor = 0;
      for (const card of candidate.cards) {
        for (let index = 0; index < CANDIDATE_GENERATION_CASES_PER_CARD; index += 1) {
          errors.push(
            ...validateCase(
              value.cases[cursor],
              `evidence.cases[${cursor}]`,
              expectedCaseId(card.id, index),
              card.id,
              card.domainId,
              forbiddenLiterals,
              manifest,
            ),
          );
          cursor += 1;
        }
      }
      const ids = value.cases.map((item) => (isPlainObject(item) ? item.caseId : null));
      const texts = value.cases.map((item) => (isPlainObject(item) ? item.text : null));
      if (new Set(ids).size !== ids.length) errors.push('evidence.cases: caseId가 중복됩니다.');
      if (new Set(texts).size !== texts.length) errors.push('evidence.cases: text가 중복됩니다.');
    }

    if (typeof value.artifactHash !== 'string' || !ARTIFACT_HASH_FORMAT.test(value.artifactHash)) {
      errors.push('evidence.artifactHash: 형식이 올바르지 않습니다.');
    } else if (errors.length === 0) {
      const { artifactHash: _stored, ...withoutHash } = value as unknown as CandidateGenerationEvidence;
      const recomputed = await computeCandidateGenerationEvidenceArtifactHash(withoutHash);
      if (value.artifactHash !== recomputed) {
        errors.push('evidence.artifactHash: 내용에서 다시 계산한 값과 다릅니다.');
      }
    }
    return { valid: errors.length === 0, errors };
  } catch {
    return { valid: false, errors: ['evidence: 안전하게 검증할 수 없습니다.'] };
  }
}

export type CandidateGenerationEvidenceAdapterBuildResult =
  | {
      ok: true;
      evaluateCandidateGeneration: (
        candidate: ScriptureCatalogCandidate,
      ) => Promise<CandidateGenerationEvaluationPayload>;
    }
  | { ok: false; errors: string[] };

/** 검증된 동결 분석만 후보 catalog의 실제 Gate에 재생해 pass를 계산한다. */
export async function buildCandidateGenerationEvidenceAdapter(
  evidence: CandidateGenerationEvidence,
  candidate: ScriptureCatalogCandidate,
  baseCatalog: ScriptureCatalogSnapshot,
): Promise<CandidateGenerationEvidenceAdapterBuildResult> {
  let isolatedEvidence: CandidateGenerationEvidence;
  let isolatedCandidate: ScriptureCatalogCandidate;
  let isolatedBase: ScriptureCatalogSnapshot;
  try {
    isolatedEvidence = structuredClone(evidence);
    isolatedCandidate = structuredClone(candidate);
    isolatedBase = structuredClone(baseCatalog);
  } catch {
    return { ok: false, errors: ['evidence/candidate/baseCatalog: 안전하게 복제할 수 없습니다.'] };
  }
  const checked = await validateCandidateGenerationEvidence(isolatedEvidence, isolatedCandidate, isolatedBase);
  if (!checked.valid) return { ok: false, errors: checked.errors };
  const candidateCheck = await validateCatalogCandidate(isolatedCandidate, isolatedBase);
  if (!candidateCheck.valid || candidateCheck.proposedCatalog === null) {
    return { ok: false, errors: ['candidate: 기준 카탈로그 계약과 맞지 않습니다.'] };
  }
  const cards = catalogSnapshotToGateCards(candidateCheck.proposedCatalog);
  const sealedCases = structuredClone(isolatedEvidence.cases);
  return {
    ok: true,
    evaluateCandidateGeneration: async (runtimeCandidate) => {
      let isolatedRuntimeCandidate: ScriptureCatalogCandidate;
      try {
        isolatedRuntimeCandidate = structuredClone(runtimeCandidate);
      } catch {
        throw new Error('실행 후보를 안전하게 복제할 수 없습니다.');
      }
      if ((await computeCatalogCandidateHash(isolatedRuntimeCandidate)) !== isolatedEvidence.candidateHash) {
        throw new Error('실행 후보가 증거에 결속된 후보와 다릅니다.');
      }
      return {
        evidenceArtifactHash: isolatedEvidence.artifactHash,
        cases: sealedCases.map((item) => {
          // Gate의 런타임 비교는 문자열 기반이며 catalogSnapshotToGateCards도 동적 id를 같은
          // 방식으로 투영한다. 정적 union은 운영 앱 계약용이므로 이 경계에서만 좁힌다.
          const result = runRecommendationGate(
            structuredClone(item.analysis) as SituationAnalysis,
            cards,
          );
          return {
            caseId: item.caseId,
            cardId: item.cardId,
            passed: result.route === 'recommend' && result.selectedCardId === item.cardId,
          };
        }),
      };
    },
  };
}
