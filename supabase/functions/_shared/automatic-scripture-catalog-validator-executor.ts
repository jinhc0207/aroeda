/**
 * 자동 Scripture Catalog 검증 실행기 — 순수 오케스트레이션 핵심부
 *
 * 이 파일은 DB·OpenAI·시계·환경변수를 직접 읽지 않는다. 필요한 입력과 평가 함수는
 * 모두 주입받고, registry가 정한 순서와 fail-closed 규칙만 집행한다.
 * 네트워크 연결과 저장은 별도 경계에서 이 실행기를 감싸야 한다.
 */

import { SOURCE_SHA256 } from './bible-reference-index.ts';
import {
  ARTIFACT_HASH_FORMAT,
  type CatalogDomain,
  type CatalogPassage,
  type ScriptureCatalogCandidate,
  type ScriptureCatalogSnapshot,
  computeArtifactHash,
  computeCatalogCandidateHash,
  computeCatalogVersionHash,
  validateCatalogCandidate,
} from './automatic-scripture-catalog-contract.ts';
import {
  ATTESTATION_CONTRACT_VERSION,
  AUTOMATED_VALIDATION_AUTHORITY,
  type AutomaticValidationRecord,
  type CandidateGenerationEvaluationPayload,
  CARD_CRITERION_EVALUATION_FIELDS,
  type CardCriterionEvaluation,
  type CheckStatus,
  type CorpusRegressionPayload,
  CRITERION_VERDICT_FIELDS,
  type CriterionVerdict,
  type DemandCell,
  type DemandEvidence,
  type KrvTextMatchPayload,
  type PassageTextResolver,
  type RequiredValidationCheck,
  type SafetyBoundaryPayload,
  type TheologyCriterionId,
  type ValidationAttestation,
  type ValidationChecks,
  type Verdict,
  VALIDATION_CONTRACT_VERSION,
  buildDemandEvidence,
  computeAttestationHash,
  computeCheckArtifactHash,
  computePassageTextHash,
  computeValidationHash,
  computeValidatorProfileHash,
  computeValidatorRegistryHash,
  deriveDuplicateCheckPayload,
  derivePassageExistencePayload,
  evaluateDemandEvidence,
  validateAutomaticValidationRecord,
} from './automatic-scripture-catalog-activation-contract.ts';
import {
  AROEDA_VALIDATOR_REGISTRY,
  ASTRA_MODEL_ID,
  ASTRA_PROFILE_ID,
  DEMAND_COUNTER_PROFILE_ID,
  DETERMINISTIC_PROFILE_ID,
  SOL_MODEL_ID,
  SOL_PROFILE_ID,
  THEOLOGY_REVIEW_RUBRIC,
  THEOLOGY_RUBRIC_VERSION,
  THEOLOGY_RUBRIC_CRITERION_IDS,
  checkTheologyRubricIntegrity,
  checkValidatorRegistryPolicy,
  evaluateStageGate,
} from './automatic-scripture-catalog-validator-registry.ts';
import type {
  StageGateFacts,
  ValidationStageId,
} from './automatic-scripture-catalog-validator-registry.ts';

export const AUTOMATIC_VALIDATOR_RULE_VERSION = 'aroeda-automatic-validator/v1';

export type StagePins = StageGateFacts['pinned'];

/** 기준 카탈로그의 영역 하나. 카드나 다른 항목은 담지 않는다(new-domain-distinctness 판단용). */
export type BaselineDomainEvidence = {
  id: string;
  displayName: string;
  description: string;
};

/**
 * 결정 검사에서 실제로 확인한 개역한글 본문 하나.
 * 절 번호 연속성·비어 있지 않은 본문 검사를 통과한 것만 여기 들어온다.
 */
export type VerifiedPassageEvidence = {
  cardId: string;
  passageIndex: number;
  passage: CatalogPassage;
  verses: readonly { verse: number; text: string }[];
};

export type TheologyEvaluationRequest = {
  modelId: typeof SOL_MODEL_ID | typeof ASTRA_MODEL_ID;
  profileId: typeof SOL_PROFILE_ID | typeof ASTRA_PROFILE_ID;
  candidate: ScriptureCatalogCandidate;
  rubric: typeof THEOLOGY_REVIEW_RUBRIC;
  /** 기준 카탈로그 영역. context-fidelity·domain-tag-support·new-domain-distinctness 판단 근거. id 오름차순. */
  baselineDomains: readonly BaselineDomainEvidence[];
  /** krv-citation-integrity 판단 근거. 후보 카드·본문 순서 그대로, resolver를 다시 부르지 않고 재사용한다. */
  verifiedPassages: readonly VerifiedPassageEvidence[];
};

/** 모델 연결부가 돌려줄 수 있는 유일한 데이터. 설명·원문 응답·profile 정보는 받지 않는다. */
export type TheologyEvaluator = (
  request: TheologyEvaluationRequest,
) => Promise<unknown>;

export type DeterministicAdapters = {
  resolvePassageText: PassageTextResolver;
  evaluateSafetyBoundary: (candidate: ScriptureCatalogCandidate) => Promise<unknown>;
  evaluateCorpusRegression: (candidate: ScriptureCatalogCandidate) => Promise<unknown>;
  evaluateCandidateGeneration: (candidate: ScriptureCatalogCandidate) => Promise<unknown>;
};

export type AutomaticValidatorExecutorInput = {
  candidate: unknown;
  baseCatalog: ScriptureCatalogSnapshot;
  demandWindow: { windowStartDate: string; windowEndDate: string };
  demandCells: readonly DemandCell[];
  evaluationCorpusVersion: string;
  deterministic: DeterministicAdapters;
  evaluateSol: TheologyEvaluator;
  evaluateAstra: TheologyEvaluator;
  /** 저장소의 현재 지문을 단계마다 다시 읽는 경계. 생략하면 입력에서 다시 계산한 지문을 쓴다. */
  observePins?: () => Promise<StagePins> | StagePins;
};

export type ExecutorStageTrace = {
  stageId: ValidationStageId;
  outcome: 'pass' | 'fail' | 'blocked' | 'unavailable';
  reasonCodes: string[];
};

export type CompletedValidation = {
  record: AutomaticValidationRecord;
  validationHash: string;
  attestations: ValidationAttestation[];
  attestationHashes: string[];
};

export type AutomaticValidatorExecutorResult =
  | ({ kind: 'validated'; stageTrace: ExecutorStageTrace[] } & CompletedValidation)
  | ({ kind: 'rejected'; failedStage: ValidationStageId; reasonCodes: string[]; stageTrace: ExecutorStageTrace[] } &
      Partial<CompletedValidation>)
  | { kind: 'unavailable'; failedStage: ValidationStageId | 'input'; reasonCodes: string[]; stageTrace: ExecutorStageTrace[] };

type TheologyEvaluation = { profileHash: string; cardEvaluations: CardCriterionEvaluation[] };

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const exactFields = (value: Record<string, unknown>, expected: readonly string[]): boolean =>
  Object.keys(value).length === expected.length && expected.every((field) => Object.hasOwn(value, field));

const validCaseId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(value);

const gateRoutes = new Set(['safety', 'domain_choice', 'no_coverage', 'recommend', 'ambiguous']);

function parseSafetyPayload(value: unknown): SafetyBoundaryPayload | null {
  if (!isPlainObject(value) || !exactFields(value, ['rulesVersion', 'cases'])) return null;
  if (typeof value.rulesVersion !== 'string' || value.rulesVersion.trim() !== value.rulesVersion || value.rulesVersion.length === 0 || value.rulesVersion.length > 100) return null;
  if (!Array.isArray(value.cases) || value.cases.length === 0) return null;
  const seen = new Set<string>();
  for (const item of value.cases) {
    if (!isPlainObject(item) || !exactFields(item, ['caseId', 'expectedRoute', 'observedRoute'])) return null;
    if (!validCaseId(item.caseId) || seen.has(item.caseId)) return null;
    if (!gateRoutes.has(String(item.expectedRoute)) || !gateRoutes.has(String(item.observedRoute))) return null;
    seen.add(item.caseId);
  }
  return structuredClone(value) as SafetyBoundaryPayload;
}

function parseCorpusPayload(value: unknown, corpusVersion: string): CorpusRegressionPayload | null {
  if (!isPlainObject(value) || !exactFields(value, ['corpusVersion', 'cases']) || value.corpusVersion !== corpusVersion) return null;
  if (!Array.isArray(value.cases) || value.cases.length === 0) return null;
  const seen = new Set<string>();
  const outcome = (item: unknown) =>
    isPlainObject(item) &&
    exactFields(item, ['domainMatch', 'acceptableMatch', 'safetyFalsePositive']) &&
    typeof item.domainMatch === 'boolean' &&
    typeof item.acceptableMatch === 'boolean' &&
    typeof item.safetyFalsePositive === 'boolean';
  for (const item of value.cases) {
    if (!isPlainObject(item) || !exactFields(item, ['caseId', 'baseline', 'candidate'])) return null;
    if (!validCaseId(item.caseId) || seen.has(item.caseId) || !outcome(item.baseline) || !outcome(item.candidate)) return null;
    seen.add(item.caseId);
  }
  return structuredClone(value) as CorpusRegressionPayload;
}

function parseGenerationPayload(
  value: unknown,
  candidate: ScriptureCatalogCandidate,
): CandidateGenerationEvaluationPayload | null {
  if (
    !isPlainObject(value) ||
    !exactFields(value, ['evidenceArtifactHash', 'cases']) ||
    typeof value.evidenceArtifactHash !== 'string' ||
    !ARTIFACT_HASH_FORMAT.test(value.evidenceArtifactHash) ||
    !Array.isArray(value.cases)
  ) return null;
  const cardIds = new Set(candidate.cards.map((card) => card.id));
  const seen = new Set<string>();
  for (const item of value.cases) {
    if (!isPlainObject(item) || !exactFields(item, ['caseId', 'cardId', 'passed'])) return null;
    if (!validCaseId(item.caseId) || seen.has(item.caseId) || typeof item.cardId !== 'string' || !cardIds.has(item.cardId) || typeof item.passed !== 'boolean') return null;
    seen.add(item.caseId);
  }
  return structuredClone(value) as CandidateGenerationEvaluationPayload;
}

/**
 * 모델 출력을 카드별 criterion 판정 배열로 옮긴다. 모델은 criterion 판정만 낸다 — 카드 최종
 * verdict는 여기서 계산하지 않고 받지도 않는다(cardFinalVerdict가 따로 계산한다).
 * 카드 개수·차례·id, criterion 아홉 개의 개수·차례·id, verdict 모양 중 하나라도 어긋나면 null이다.
 */
function parseCardCriterionEvaluations(value: unknown, candidate: ScriptureCatalogCandidate): CardCriterionEvaluation[] | null {
  if (!Array.isArray(value) || value.length !== candidate.cards.length) return null;
  const expectedCardIds = candidate.cards.map((card) => card.id);
  const parsed: CardCriterionEvaluation[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (!isPlainObject(item) || !exactFields(item, CARD_CRITERION_EVALUATION_FIELDS)) return null;
    if (item.cardId !== expectedCardIds[index]) return null;
    if (!Array.isArray(item.criteria) || item.criteria.length !== THEOLOGY_RUBRIC_CRITERION_IDS.length) return null;
    const criteria: CriterionVerdict[] = [];
    for (let criterionIndex = 0; criterionIndex < item.criteria.length; criterionIndex += 1) {
      const criterion = item.criteria[criterionIndex];
      if (!isPlainObject(criterion) || !exactFields(criterion, CRITERION_VERDICT_FIELDS)) return null;
      if (criterion.criterionId !== THEOLOGY_RUBRIC_CRITERION_IDS[criterionIndex]) return null;
      if (criterion.verdict !== 'pass' && criterion.verdict !== 'fail') return null;
      criteria.push({ criterionId: criterion.criterionId as TheologyCriterionId, verdict: criterion.verdict });
    }
    parsed.push({ cardId: item.cardId, criteria });
  }
  return parsed;
}

/** 카드 하나의 criterion 아홉 개가 전부 pass일 때만 그 카드는 pass다. 코드가 계산한다 — 모델은 이 값을 내지 않는다. */
const cardFinalVerdict = (card: CardCriterionEvaluation): Verdict =>
  card.criteria.every((item) => item.verdict === 'pass') ? 'pass' : 'fail';

const safetyPassed = (payload: SafetyBoundaryPayload) =>
  payload.cases.every((item) => item.expectedRoute === item.observedRoute);

const corpusPassed = (payload: CorpusRegressionPayload) =>
  payload.cases.every(
    (item) =>
      !item.candidate.safetyFalsePositive &&
      (!item.baseline.domainMatch || item.candidate.domainMatch) &&
      (!item.baseline.acceptableMatch || item.candidate.acceptableMatch) &&
      (item.baseline.safetyFalsePositive || !item.candidate.safetyFalsePositive),
  );

const generationPassed = (payload: CandidateGenerationEvaluationPayload, candidate: ScriptureCatalogCandidate) =>
  candidate.cards.every((card) => payload.cases.filter((item) => item.cardId === card.id).length >= 3) &&
  payload.cases.every((item) => item.passed);

async function sealCheck<K extends RequiredValidationCheck>(
  name: K,
  status: CheckStatus,
  payload: ValidationChecks[K]['payload'],
): Promise<ValidationChecks[K]> {
  return { status, payload, artifactHash: await computeCheckArtifactHash(name, payload) } as ValidationChecks[K];
}

async function profileHash(profileId: string): Promise<string> {
  const profile = AROEDA_VALIDATOR_REGISTRY.profiles.find((item) => item.profileId === profileId);
  if (!profile) throw new Error('validator profile missing');
  return computeValidatorProfileHash(profile);
}

async function makeAttestation(
  candidateHash: string,
  checkName: RequiredValidationCheck,
  payloadHash: string,
  profileId: string,
  verdict: Verdict,
): Promise<ValidationAttestation> {
  return {
    contractVersion: ATTESTATION_CONTRACT_VERSION,
    candidateHash,
    checkName,
    payloadHash,
    profileHash: await profileHash(profileId),
    verdict,
  };
}

async function finish(
  record: AutomaticValidationRecord,
  attestations: ValidationAttestation[],
  candidate: ScriptureCatalogCandidate,
  baseCatalog: ScriptureCatalogSnapshot,
  resolvePassageText: PassageTextResolver,
): Promise<CompletedValidation | null> {
  const verified = await validateAutomaticValidationRecord(record, {
    candidate,
    baseCatalog,
    resolvePassageText,
    validatorRegistry: AROEDA_VALIDATOR_REGISTRY,
    attestations,
  });
  if (!verified.valid || (record.overallStatus === 'pass' && verified.activationBlockers.length > 0)) return null;
  return {
    record,
    validationHash: await computeValidationHash(record),
    attestations,
    attestationHashes: await Promise.all(attestations.map((item) => computeAttestationHash(item))),
  };
}

/**
 * 한 후보를 등록된 네 단계로 검증한다. 실패한 앞 단계를 건너뛰지 않으며, adapter의 status·profile·hash는 받지 않는다.
 */
export async function executeAutomaticScriptureCatalogValidation(
  input: AutomaticValidatorExecutorInput,
): Promise<AutomaticValidatorExecutorResult> {
  const trace: ExecutorStageTrace[] = [];
  const unavailable = (failedStage: ValidationStageId | 'input', ...reasonCodes: string[]): AutomaticValidatorExecutorResult => ({
    kind: 'unavailable',
    failedStage,
    reasonCodes,
    stageTrace: trace,
  });

  const registryPolicy = checkValidatorRegistryPolicy();
  const rubricPolicy = await checkTheologyRubricIntegrity();
  if (!registryPolicy.valid || !rubricPolicy.valid) return unavailable('input', 'VALIDATOR_POLICY_INVALID');
  const candidateCheck = await validateCatalogCandidate(input.candidate, input.baseCatalog);
  if (!candidateCheck.valid) return unavailable('input', 'CANDIDATE_INVALID');
  if (typeof input.evaluationCorpusVersion !== 'string' || input.evaluationCorpusVersion.trim() !== input.evaluationCorpusVersion || input.evaluationCorpusVersion.length === 0 || input.evaluationCorpusVersion.length > 100) {
    return unavailable('input', 'CORPUS_VERSION_INVALID');
  }

  const candidate = input.candidate as ScriptureCatalogCandidate;
  const candidateHash = await computeCatalogCandidateHash(candidate);
  const pinned: StagePins = {
    candidateHash,
    baseVersionHash: candidate.baseVersionHash,
    rubricVersion: THEOLOGY_RUBRIC_VERSION,
  };
  const observePins = input.observePins ?? (async () => ({
    candidateHash: await computeCatalogCandidateHash(candidate),
    baseVersionHash: await computeCatalogVersionHash(input.baseCatalog),
    rubricVersion: THEOLOGY_RUBRIC_VERSION,
  }));
  const completedStages: ValidationStageId[] = [];
  let demandThresholdMet = false;
  let deterministicAllPassed = false;
  let solCardVerdicts: { cardId: string; verdict: Verdict }[] = [];

  const openStage = async (stageId: ValidationStageId) => {
    let observed: StagePins;
    try {
      observed = await observePins();
    } catch {
      trace.push({ stageId, outcome: 'unavailable', reasonCodes: ['PIN_SNAPSHOT_UNAVAILABLE'] });
      return null;
    }
    const gate = evaluateStageGate({
      stageId,
      completedStages,
      demandThresholdMet,
      deterministicAllPassed,
      solCardVerdicts,
      candidateCardIds: candidate.cards.map((card) => card.id),
      pinned,
      observed,
    });
    if (!gate.allowed) {
      trace.push({ stageId, outcome: 'blocked', reasonCodes: ['STAGE_GATE_BLOCKED'] });
      return null;
    }
    return gate;
  };

  // 1. 수요 집계
  if (!(await openStage('demand-counter'))) return unavailable('demand-counter', trace.at(-1)?.reasonCodes[0] ?? 'STAGE_GATE_BLOCKED');
  const demandPayload = buildDemandEvidence(candidate.demandBinding, input.demandWindow, input.demandCells);
  if (!demandPayload) {
    trace.push({ stageId: 'demand-counter', outcome: 'unavailable', reasonCodes: ['DEMAND_EVIDENCE_INVALID'] });
    return unavailable('demand-counter', 'DEMAND_EVIDENCE_INVALID');
  }
  const demandEvaluation = evaluateDemandEvidence(demandPayload, candidate.demandBinding);
  if (!demandEvaluation.valid) {
    trace.push({ stageId: 'demand-counter', outcome: 'unavailable', reasonCodes: ['DEMAND_EVIDENCE_INVALID'] });
    return unavailable('demand-counter', 'DEMAND_EVIDENCE_INVALID');
  }
  demandThresholdMet = demandEvaluation.meetsThreshold;
  if (!demandThresholdMet) {
    trace.push({ stageId: 'demand-counter', outcome: 'fail', reasonCodes: ['DEMAND_THRESHOLD_NOT_MET'] });
    return { kind: 'rejected', failedStage: 'demand-counter', reasonCodes: ['DEMAND_THRESHOLD_NOT_MET'], stageTrace: trace };
  }
  completedStages.push('demand-counter');
  trace.push({ stageId: 'demand-counter', outcome: 'pass', reasonCodes: [] });

  // 2. 결정적 검사
  if (!(await openStage('deterministic-checks'))) return unavailable('deterministic-checks', trace.at(-1)?.reasonCodes[0] ?? 'STAGE_GATE_BLOCKED');
  let safetyPayload: SafetyBoundaryPayload | null;
  let corpusPayload: CorpusRegressionPayload | null;
  let generationPayload: CandidateGenerationEvaluationPayload | null;
  try {
    const [safety, corpus, generation] = await Promise.all([
      input.deterministic.evaluateSafetyBoundary(structuredClone(candidate)),
      input.deterministic.evaluateCorpusRegression(structuredClone(candidate)),
      input.deterministic.evaluateCandidateGeneration(structuredClone(candidate)),
    ]);
    safetyPayload = parseSafetyPayload(safety);
    corpusPayload = parseCorpusPayload(corpus, input.evaluationCorpusVersion);
    generationPayload = parseGenerationPayload(generation, candidate);
  } catch {
    trace.push({ stageId: 'deterministic-checks', outcome: 'unavailable', reasonCodes: ['DETERMINISTIC_ADAPTER_UNAVAILABLE'] });
    return unavailable('deterministic-checks', 'DETERMINISTIC_ADAPTER_UNAVAILABLE');
  }
  if (!safetyPayload || !corpusPayload || !generationPayload) {
    trace.push({ stageId: 'deterministic-checks', outcome: 'unavailable', reasonCodes: ['DETERMINISTIC_PAYLOAD_INVALID'] });
    return unavailable('deterministic-checks', 'DETERMINISTIC_PAYLOAD_INVALID');
  }

  const passageExistencePayload = derivePassageExistencePayload(candidate);
  const passageTextHashes: KrvTextMatchPayload['passageTextHashes'] = [];
  // 신학 평가자에게 그대로 재사용할 본문 증거. resolver를 신학 단계에서 다시 부르지 않기 위해
  // 결정 검사 동안 이미 확인한(절 번호 연속·비어 있지 않은) 것만 여기 모아 둔다.
  const verifiedPassageEvidence: VerifiedPassageEvidence[] = [];
  let krvPassed = true;
  for (const card of candidate.cards) {
    for (let passageIndex = 0; passageIndex < card.passages.length; passageIndex += 1) {
      const passage = card.passages[passageIndex];
      let verses: readonly { verse: number; text: string }[] | null = null;
      try {
        verses = input.deterministic.resolvePassageText(structuredClone(passage));
      } catch {
        verses = null;
      }
      const expectedCount = passage.endVerse - passage.startVerse + 1;
      const validVerses =
        !!verses &&
        verses.length === expectedCount &&
        verses.every(
          (verse, verseIndex) =>
            verse.verse === passage.startVerse + verseIndex && typeof verse.text === 'string' && verse.text.length > 0,
        );
      if (!validVerses) {
        krvPassed = false;
      } else {
        verifiedPassageEvidence.push({
          cardId: card.id,
          passageIndex,
          passage: { book: passage.book, chapter: passage.chapter, startVerse: passage.startVerse, endVerse: passage.endVerse },
          verses: verses!.map((verse) => ({ verse: verse.verse, text: verse.text })),
        });
      }
      passageTextHashes.push({
        cardId: card.id,
        passageIndex,
        textHash: validVerses
          ? await computePassageTextHash(passage, verses!)
          : await computeArtifactHash({ missingPassage: { cardId: card.id, passageIndex } }),
      });
    }
  }
  const krvPayload: KrvTextMatchPayload = { bibleSourceSha256: SOURCE_SHA256, passageTextHashes };
  // 기준 카탈로그 영역만. 카드나 다른 항목은 넣지 않는다. id 오름차순으로 고정한다.
  const baselineDomainEvidence: BaselineDomainEvidence[] = [...input.baseCatalog.domains]
    .map((domain: CatalogDomain) => ({ id: domain.id, displayName: domain.displayName, description: domain.description }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const duplicatePayload = deriveDuplicateCheckPayload(candidate, input.baseCatalog);
  const deterministicStatus = {
    passageExistence: 'pass' as CheckStatus,
    krvTextMatch: (krvPassed ? 'pass' : 'fail') as CheckStatus,
    safetyBoundary: (safetyPassed(safetyPayload) ? 'pass' : 'fail') as CheckStatus,
    duplicateCheck: (duplicatePayload.overlaps.length === 0 ? 'pass' : 'fail') as CheckStatus,
    corpusRegression: (corpusPassed(corpusPayload) ? 'pass' : 'fail') as CheckStatus,
    candidateGenerationEvaluation: (generationPassed(generationPayload, candidate) ? 'pass' : 'fail') as CheckStatus,
  };
  deterministicAllPassed = Object.values(deterministicStatus).every((status) => status === 'pass');

  const demandCheck = await sealCheck('demandSignal', 'pass', demandPayload as DemandEvidence);
  const passageCheck = await sealCheck('passageExistence', deterministicStatus.passageExistence, passageExistencePayload);
  const krvCheck = await sealCheck('krvTextMatch', deterministicStatus.krvTextMatch, krvPayload);
  const safetyCheck = await sealCheck('safetyBoundary', deterministicStatus.safetyBoundary, safetyPayload);
  const duplicateCheck = await sealCheck('duplicateCheck', deterministicStatus.duplicateCheck, duplicatePayload);
  const corpusCheck = await sealCheck('corpusRegression', deterministicStatus.corpusRegression, corpusPayload);
  const generationCheck = await sealCheck('candidateGenerationEvaluation', deterministicStatus.candidateGenerationEvaluation, generationPayload);
  const emptyTheologyCheck = await sealCheck('contextTheologyReview', 'not_run', { evaluations: [] });

  const buildRecord = async (
    theologyCheck: ValidationChecks['contextTheologyReview'],
    evaluatorModels: string[],
  ): Promise<AutomaticValidationRecord> => ({
    contractVersion: VALIDATION_CONTRACT_VERSION,
    validationAuthority: AUTOMATED_VALIDATION_AUTHORITY,
    candidateHash,
    candidateKind: candidate.candidateKind,
    baseVersionHash: candidate.baseVersionHash,
    proposedVersionHash: candidate.proposedVersionHash,
    validatorRuleVersion: AUTOMATIC_VALIDATOR_RULE_VERSION,
    validatorRegistryHash: await computeValidatorRegistryHash(AROEDA_VALIDATOR_REGISTRY),
    dataVersions: { bibleSourceSha256: SOURCE_SHA256, evaluationCorpusVersion: input.evaluationCorpusVersion },
    modelIdentifiers: { generation: candidate.generation.modelId, evaluators: [...evaluatorModels].sort() },
    checks: {
      demandSignal: demandCheck,
      passageExistence: passageCheck,
      krvTextMatch: krvCheck,
      contextTheologyReview: theologyCheck,
      safetyBoundary: safetyCheck,
      duplicateCheck,
      corpusRegression: corpusCheck,
      candidateGenerationEvaluation: generationCheck,
    },
    overallStatus: [demandCheck, passageCheck, krvCheck, theologyCheck, safetyCheck, duplicateCheck, corpusCheck, generationCheck]
      .every((check) => check.status === 'pass') ? 'pass' : 'fail',
  });

  const deterministicAttestations = async (): Promise<ValidationAttestation[]> => {
    const result = [await makeAttestation(candidateHash, 'demandSignal', demandCheck.artifactHash, DEMAND_COUNTER_PROFILE_ID, 'pass')];
    for (const name of ['passageExistence', 'krvTextMatch', 'safetyBoundary', 'duplicateCheck', 'corpusRegression', 'candidateGenerationEvaluation'] as const) {
      const check = {
        passageExistence: passageCheck,
        krvTextMatch: krvCheck,
        safetyBoundary: safetyCheck,
        duplicateCheck,
        corpusRegression: corpusCheck,
        candidateGenerationEvaluation: generationCheck,
      }[name];
      result.push(await makeAttestation(candidateHash, name, check.artifactHash, DETERMINISTIC_PROFILE_ID, check.status as Verdict));
    }
    return result;
  };

  if (!deterministicAllPassed) {
    trace.push({ stageId: 'deterministic-checks', outcome: 'fail', reasonCodes: ['DETERMINISTIC_CHECK_FAILED'] });
    const record = await buildRecord(emptyTheologyCheck, []);
    const complete = await finish(record, await deterministicAttestations(), candidate, input.baseCatalog, input.deterministic.resolvePassageText);
    if (!complete) return unavailable('deterministic-checks', 'SELF_VALIDATION_FAILED');
    return { kind: 'rejected', failedStage: 'deterministic-checks', reasonCodes: ['DETERMINISTIC_CHECK_FAILED'], stageTrace: trace, ...complete };
  }
  completedStages.push('deterministic-checks');
  trace.push({ stageId: 'deterministic-checks', outcome: 'pass', reasonCodes: [] });

  // 3. Sol 신학 평가
  if (!(await openStage('theology-sol'))) return unavailable('theology-sol', trace.at(-1)?.reasonCodes[0] ?? 'STAGE_GATE_BLOCKED');
  let parsedSol: CardCriterionEvaluation[] | null;
  try {
    parsedSol = parseCardCriterionEvaluations(
      await input.evaluateSol({
        modelId: SOL_MODEL_ID,
        profileId: SOL_PROFILE_ID,
        candidate: structuredClone(candidate),
        rubric: THEOLOGY_REVIEW_RUBRIC,
        baselineDomains: structuredClone(baselineDomainEvidence),
        verifiedPassages: structuredClone(verifiedPassageEvidence),
      }),
      candidate,
    );
  } catch {
    parsedSol = null;
  }
  if (!parsedSol) {
    trace.push({ stageId: 'theology-sol', outcome: 'unavailable', reasonCodes: ['SOL_RESULT_INVALID'] });
    return unavailable('theology-sol', 'SOL_RESULT_INVALID');
  }
  // criterion 하나라도 fail이면 그 카드는 fail이다(코드가 계산한다). Astra 게이트는 이 카드별 최종
  // verdict로만 판단한다 — Sol이 카드 verdict를 직접 낸 것이 아니다.
  solCardVerdicts = parsedSol.map((card) => ({ cardId: card.cardId, verdict: cardFinalVerdict(card) }));
  const solHash = await profileHash(SOL_PROFILE_ID);
  const solEvaluation: TheologyEvaluation = { profileHash: solHash, cardEvaluations: parsedSol };
  if (solCardVerdicts.some((item) => item.verdict !== 'pass')) {
    trace.push({ stageId: 'theology-sol', outcome: 'fail', reasonCodes: ['SOL_REJECTED_CANDIDATE'] });
    const theologyCheck = await sealCheck('contextTheologyReview', 'fail', { evaluations: [solEvaluation] });
    const attestations = await deterministicAttestations();
    attestations.push(await makeAttestation(candidateHash, 'contextTheologyReview', theologyCheck.artifactHash, SOL_PROFILE_ID, 'fail'));
    const record = await buildRecord(theologyCheck, [SOL_MODEL_ID]);
    const complete = await finish(record, attestations, candidate, input.baseCatalog, input.deterministic.resolvePassageText);
    if (!complete) return unavailable('theology-sol', 'SELF_VALIDATION_FAILED');
    return { kind: 'rejected', failedStage: 'theology-sol', reasonCodes: ['SOL_REJECTED_CANDIDATE'], stageTrace: trace, ...complete };
  }
  completedStages.push('theology-sol');
  trace.push({ stageId: 'theology-sol', outcome: 'pass', reasonCodes: [] });

  // 4. Astra 독립 신학 평가
  if (!(await openStage('theology-astra'))) return unavailable('theology-astra', trace.at(-1)?.reasonCodes[0] ?? 'STAGE_GATE_BLOCKED');
  let parsedAstra: CardCriterionEvaluation[] | null;
  try {
    parsedAstra = parseCardCriterionEvaluations(
      await input.evaluateAstra({
        modelId: ASTRA_MODEL_ID,
        profileId: ASTRA_PROFILE_ID,
        candidate: structuredClone(candidate),
        rubric: THEOLOGY_REVIEW_RUBRIC,
        baselineDomains: structuredClone(baselineDomainEvidence),
        verifiedPassages: structuredClone(verifiedPassageEvidence),
      }),
      candidate,
    );
  } catch {
    parsedAstra = null;
  }
  if (!parsedAstra) {
    trace.push({ stageId: 'theology-astra', outcome: 'unavailable', reasonCodes: ['ASTRA_RESULT_INVALID'] });
    return unavailable('theology-astra', 'ASTRA_RESULT_INVALID');
  }
  const astraHash = await profileHash(ASTRA_PROFILE_ID);
  const theologyPassed = parsedAstra.every((card) => cardFinalVerdict(card) === 'pass');
  const theologyCheck = await sealCheck('contextTheologyReview', theologyPassed ? 'pass' : 'fail', {
    evaluations: [solEvaluation, { profileHash: astraHash, cardEvaluations: parsedAstra }],
  });
  const attestations = await deterministicAttestations();
  attestations.push(await makeAttestation(candidateHash, 'contextTheologyReview', theologyCheck.artifactHash, SOL_PROFILE_ID, theologyPassed ? 'pass' : 'fail'));
  attestations.push(await makeAttestation(candidateHash, 'contextTheologyReview', theologyCheck.artifactHash, ASTRA_PROFILE_ID, theologyPassed ? 'pass' : 'fail'));
  const record = await buildRecord(theologyCheck, [SOL_MODEL_ID, ASTRA_MODEL_ID]);
  const complete = await finish(record, attestations, candidate, input.baseCatalog, input.deterministic.resolvePassageText);
  if (!complete) return unavailable('theology-astra', 'SELF_VALIDATION_FAILED');
  if (!theologyPassed) {
    trace.push({ stageId: 'theology-astra', outcome: 'fail', reasonCodes: ['ASTRA_REJECTED_CANDIDATE'] });
    return { kind: 'rejected', failedStage: 'theology-astra', reasonCodes: ['ASTRA_REJECTED_CANDIDATE'], stageTrace: trace, ...complete };
  }
  completedStages.push('theology-astra');
  trace.push({ stageId: 'theology-astra', outcome: 'pass', reasonCodes: [] });
  return { kind: 'validated', stageTrace: trace, ...complete };
}
