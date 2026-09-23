/**
 * 자동 Scripture Catalog 테스트 전용 fixture
 *
 * 여기 카드·validator profile·수요 집계·평가 결과는 모두 시험용이다. 실제 카드나 실제 validator가 아니며
 * 런타임·카탈로그·DB 어디에도 들어가지 않는다.
 *
 * 실제 데이터에서 읽는 것은 둘뿐이다.
 *   - 본문 글자: 실제 개역한글 JSON. KRV 지문 재계산이 실제 데이터로 검증된다.
 *   - 영역 표시 이름: 앱이 실제로 쓰는 src/data/domain-labels.ts.
 *     그 파일은 확장자 없는 import를 써서 node --test가 직접 불러올 수 없으므로 글자로 읽는다.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import {
  type CatalogCard,
  type CatalogPassage,
  type DemandBinding,
  type ScriptureCatalogCandidate,
  type ScriptureCatalogSnapshot,
  applyCandidateToCatalog,
  buildCatalogSnapshotFromStaticCards,
  canonicalJson,
  computeCatalogCandidateHash,
  computeCatalogVersionHash,
  computeThemeFingerprint,
  formatCatalogReferenceLabel,
} from '../../supabase/functions/_shared/automatic-scripture-catalog-contract.ts';
import {
  ATTESTATION_CONTRACT_VERSION,
  AUTOMATED_VALIDATION_AUTHORITY,
  type AutomaticValidationRecord,
  type CardCriterionEvaluation,
  type DemandCell,
  type PassageTextResolver,
  REQUIRED_VALIDATION_CHECKS,
  THEOLOGY_CRITERION_IDS,
  VALIDATION_CONTRACT_VERSION,
  VALIDATOR_PROFILE_CONTRACT_VERSION,
  VALIDATOR_REGISTRY_CONTRACT_VERSION,
  type ValidationAttestation,
  type ValidationContext,
  type ValidatorProfile,
  type ValidatorRegistry,
  buildDemandEvidence,
  computeCheckArtifactHash,
  computePassageTextHash,
  computeValidatorRegistryHash,
  deriveDuplicateCheckPayload,
  derivePassageExistencePayload,
} from '../../supabase/functions/_shared/automatic-scripture-catalog-activation-contract.ts';
import { SOURCE_SHA256 } from '../../supabase/functions/_shared/bible-reference-index.ts';
import { SCRIPTURE_CARDS } from '../../supabase/functions/_shared/scripture-cards.ts';
import { DOMAIN_DESCRIPTIONS } from '../../supabase/functions/_shared/situation-domains.ts';

type BibleJson = { book: string; chapters: { chapter: number; verses: { verse: number; text: string }[] }[] }[];

export const BIBLE_JSON_BYTES = readFileSync(new URL('../data/bible/krv1961.json', import.meta.url));
const BIBLE: BibleJson = JSON.parse(BIBLE_JSON_BYTES.toString('utf8'));

/** 실제 개역한글 JSON에서 원문 그대로 읽는다. 한 절이라도 없으면 null. */
export const resolveKrvPassage: PassageTextResolver = (passage: CatalogPassage) => {
  const chapter = BIBLE.find((book) => book.book === passage.book)?.chapters.find((item) => item.chapter === passage.chapter);
  if (!chapter) return null;
  const verses = [];
  for (let verse = passage.startVerse; verse <= passage.endVerse; verse += 1) {
    const found = chapter.verses.find((item) => item.verse === verse);
    if (!found) return null;
    verses.push({ verse: found.verse, text: found.text });
  }
  return verses;
};

/** 앱의 실제 영역 표시 이름을 글자로 읽는다. */
function readAppDomainLabels(): Record<string, string> {
  const source = readFileSync(new URL('../data/domain-labels.ts', import.meta.url), 'utf8');
  const block = source.slice(source.indexOf('DOMAIN_LABELS'), source.indexOf('};', source.indexOf('DOMAIN_LABELS')));
  const labels = Object.fromEntries([...block.matchAll(/^\s+([a-z_]+): '([^']+)',$/gm)].map((match) => [match[1], match[2]]));
  if (Object.keys(labels).length !== 17) throw new Error('앱 영역 표시 이름 17개를 읽지 못했습니다.');
  return labels;
}
export const APP_DOMAIN_LABELS: Readonly<Record<string, string>> = readAppDomainLabels();

export const buildBaselineCatalog = (): ScriptureCatalogSnapshot =>
  buildCatalogSnapshotFromStaticCards(SCRIPTURE_CARDS, DOMAIN_DESCRIPTIONS, APP_DOMAIN_LABELS);

export const requestId = (n: number) => `screq_${n.toString(16).padStart(32, '0')}`;
export const FIXTURE_RESEARCH_RESULT_HASH = `rres_${'5'.repeat(64)}`;
export const FIXTURE_DEMAND_WINDOW = { windowStartDate: '2026-08-01', windowEndDate: '2026-08-30' } as const;
export const FIXTURE_ACTIVATION_DATE = '2026-09-16';

/* ------------------------------------------------------------------ */
/* validator registry                                                  */
/* ------------------------------------------------------------------ */

const profile = (overrides: Partial<ValidatorProfile> & Pick<ValidatorProfile, 'profileId'>): ValidatorProfile => ({
  contractVersion: VALIDATOR_PROFILE_CONTRACT_VERSION,
  profileVersion: 'v1',
  validatorKind: 'deterministic',
  authorizedChecks: [],
  independenceGroup: 'fixture-deterministic',
  modelId: null,
  rubricVersion: null,
  ...overrides,
});

export const FIXTURE_VALIDATOR_REGISTRY: ValidatorRegistry = {
  contractVersion: VALIDATOR_REGISTRY_CONTRACT_VERSION,
  registryVersion: 'fixture-registry/v1',
  profiles: [
    profile({
      profileId: 'fixture-demand-counter',
      validatorKind: 'aggregate_counter',
      authorizedChecks: ['demandSignal'],
      independenceGroup: 'fixture-aggregate',
    }),
    profile({
      profileId: 'fixture-deterministic-checker',
      authorizedChecks: [
        'passageExistence',
        'krvTextMatch',
        'safetyBoundary',
        'duplicateCheck',
        'corpusRegression',
        'candidateGenerationEvaluation',
      ],
    }),
    profile({
      profileId: 'fixture-theology-evaluator-a',
      validatorKind: 'model_evaluator',
      authorizedChecks: ['contextTheologyReview'],
      independenceGroup: 'fixture-evaluator-group-a',
      modelId: 'fixture-eval-model-a',
      rubricVersion: 'fixture-rubric/v1',
    }),
    profile({
      profileId: 'fixture-theology-evaluator-b',
      validatorKind: 'model_evaluator',
      authorizedChecks: ['contextTheologyReview'],
      independenceGroup: 'fixture-evaluator-group-b',
      modelId: 'fixture-eval-model-b',
      rubricVersion: 'fixture-rubric/v1',
    }),
  ],
};

/** 계약의 computeValidatorProfileHash와 같은 값을 동기로 계산한다(같은 canonical JSON + SHA-256). */
export const syncProfileHash = (value: ValidatorProfile) => `svp_${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
export const profileHashById = (profileId: string, registry: ValidatorRegistry = FIXTURE_VALIDATOR_REGISTRY) =>
  syncProfileHash(registry.profiles.find((item) => item.profileId === profileId)!);

/* ------------------------------------------------------------------ */
/* 후보                                                                */
/* ------------------------------------------------------------------ */

const fixtureCard = (overrides: Partial<CatalogCard> & Pick<CatalogCard, 'id' | 'domainId' | 'passages'>): CatalogCard => ({
  referenceLabel: formatCatalogReferenceLabel(overrides.passages)!,
  situationTags: ['시험용 상황'],
  emotionTags: ['걱정'],
  spiritualQuestionTags: ['지혜'],
  prayerModes: ['간구'],
  pastoralFunction: ['위로'],
  contextSummary: '시험용 문맥 요약입니다.',
  theologicalInsight: '시험용 신학적 통찰입니다.',
  userExplanation: '시험용 사용자 설명입니다.',
  prayerDirection: '시험용 기도 방향입니다.',
  misuseGuards: ['시험용 오용 방지 문장입니다.'],
  ...overrides,
});

/** base에 대어 proposedVersionHash를 채운 후보를 만든다. */
export async function finalizeCandidate(
  base: ScriptureCatalogSnapshot,
  draft: Omit<ScriptureCatalogCandidate, 'baseVersionHash' | 'proposedVersionHash'>,
): Promise<{ candidate: ScriptureCatalogCandidate; candidateHash: string; proposedCatalog: ScriptureCatalogSnapshot }> {
  const baseVersionHash = await computeCatalogVersionHash(base);
  const withBase = { ...draft, baseVersionHash, proposedVersionHash: baseVersionHash } as ScriptureCatalogCandidate;
  const proposedCatalog = applyCandidateToCatalog(base, withBase);
  const candidate = { ...withBase, proposedVersionHash: await computeCatalogVersionHash(proposedCatalog) };
  return { candidate, candidateHash: await computeCatalogCandidateHash(candidate), proposedCatalog };
}

export async function makeExistingDomainCandidate(base: ScriptureCatalogSnapshot, cardId = 'SC-052') {
  return finalizeCandidate(base, {
    contractVersion: 'scripture-catalog-candidate/v1',
    candidateKind: 'existing_domain_card',
    targetDomainId: 'decision_guidance',
    newDomain: null,
    cards: [
      fixtureCard({
        id: cardId,
        domainId: 'decision_guidance',
        passages: [{ book: 'Proverbs', chapter: 16, startVerse: 1, endVerse: 3 }],
        emotionTags: ['혼란', '걱정'],
        spiritualQuestionTags: ['인도', '지혜'],
        pastoralFunction: ['인도'],
      }),
    ],
    demandBinding: { kind: 'weak_match', domainId: 'decision_guidance' },
    sourceResearchResultHash: FIXTURE_RESEARCH_RESULT_HASH,
    generation: { method: 'automated', modelId: 'fixture-generator-model', promptVersion: 'fixture-prompt/v1' },
  });
}

export const FIXTURE_THEME_KEY = 'caregiving_strain';

export async function makeNewDomainCandidate(base: ScriptureCatalogSnapshot) {
  const domainId = 'caregiving_strain';
  return finalizeCandidate(base, {
    contractVersion: 'scripture-catalog-candidate/v1',
    candidateKind: 'new_domain_with_cards',
    targetDomainId: domainId,
    newDomain: { id: domainId, displayName: '오래 돌보는 무게', description: '시험용 새 영역 설명입니다.' },
    cards: [
      fixtureCard({ id: 'SC-053', domainId, passages: [{ book: 'Galatians', chapter: 6, startVerse: 2, endVerse: 2 }] }),
      fixtureCard({ id: 'SC-054', domainId, passages: [{ book: 'Isaiah', chapter: 40, startVerse: 29, endVerse: 31 }] }),
      fixtureCard({ id: 'SC-055', domainId, passages: [{ book: 'Psalms', chapter: 55, startVerse: 22, endVerse: 22 }] }),
    ],
    demandBinding: {
      kind: 'normalized_theme',
      themeKey: FIXTURE_THEME_KEY,
      themeFingerprint: await computeThemeFingerprint(FIXTURE_THEME_KEY),
    },
    sourceResearchResultHash: FIXTURE_RESEARCH_RESULT_HASH,
    generation: { method: 'automated', modelId: 'fixture-generator-model', promptVersion: 'fixture-prompt/v1' },
  });
}

/* ------------------------------------------------------------------ */
/* 수요 집계                                                            */
/* ------------------------------------------------------------------ */

/** 기간 안에서 18일은 하루 6회(보고 대상), 4일은 하루 3회(가림 대상)인 집계 칸. */
export function makeDemandCells(binding: DemandBinding): DemandCell[] {
  const subjectKey = binding.kind === 'weak_match' ? binding.domainId : binding.themeFingerprint;
  const cells: DemandCell[] = [];
  for (let day = 1; day <= 22; day += 1) {
    cells.push({
      evidenceKind: binding.kind,
      subjectKey,
      bucketDate: `2026-08-${String(day).padStart(2, '0')}`,
      count: day <= 18 ? 6 : 3,
    });
  }
  return cells;
}

/* ------------------------------------------------------------------ */
/* 검증 기록 · attestation                                              */
/* ------------------------------------------------------------------ */

/** payload가 바뀐 기록의 artifactHash와 전체 결과를 다시 봉인한다(사실대로 적은 기록을 만들 때). */
export async function resealRecord(record: AutomaticValidationRecord): Promise<AutomaticValidationRecord> {
  for (const name of REQUIRED_VALIDATION_CHECKS) {
    record.checks[name].artifactHash = await computeCheckArtifactHash(name, record.checks[name].payload);
  }
  record.overallStatus = REQUIRED_VALIDATION_CHECKS.every((name) => record.checks[name].status === 'pass') ? 'pass' : 'fail';
  return record;
}

/**
 * 카드마다 rubric criterion 아홉 개(THEOLOGY_CRITERION_IDS) 전부를 담은 평가를 만든다.
 * 기본은 전부 pass. verdictFor로 특정 카드·criterion만 fail로 만들 수 있다.
 * 모델은 criterion 판정만 낸다 — 카드 최종 verdict는 여기 없다(코드가 계산한다).
 */
export function makeCardCriterionEvaluations(
  candidate: ScriptureCatalogCandidate,
  verdictFor: (cardId: string, criterionId: string) => 'pass' | 'fail' = () => 'pass',
): CardCriterionEvaluation[] {
  return candidate.cards.map((card) => ({
    cardId: card.id,
    criteria: THEOLOGY_CRITERION_IDS.map((criterionId) => ({ criterionId, verdict: verdictFor(card.id, criterionId) })),
  }));
}

/** 모든 필수 항목이 payload에서 다시 계산해도 통과하는 검증 기록을 만든다. */
export async function makePassingValidationRecord(
  candidate: ScriptureCatalogCandidate,
  candidateHash: string,
  base: ScriptureCatalogSnapshot,
  registry: ValidatorRegistry = FIXTURE_VALIDATOR_REGISTRY,
): Promise<AutomaticValidationRecord> {
  const passageTextHashes = [];
  for (const card of candidate.cards) {
    for (let passageIndex = 0; passageIndex < card.passages.length; passageIndex += 1) {
      const passage = card.passages[passageIndex];
      passageTextHashes.push({
        cardId: card.id,
        passageIndex,
        textHash: await computePassageTextHash(passage, resolveKrvPassage(passage)!),
      });
    }
  }
  const cardEvaluations = makeCardCriterionEvaluations(candidate);
  const record = {
    contractVersion: VALIDATION_CONTRACT_VERSION,
    validationAuthority: AUTOMATED_VALIDATION_AUTHORITY,
    candidateHash,
    candidateKind: candidate.candidateKind,
    baseVersionHash: candidate.baseVersionHash,
    proposedVersionHash: candidate.proposedVersionHash,
    validatorRuleVersion: 'fixture-validator/v1',
    validatorRegistryHash: await computeValidatorRegistryHash(registry),
    dataVersions: { bibleSourceSha256: SOURCE_SHA256, evaluationCorpusVersion: 'fixture-corpus/v1' },
    modelIdentifiers: { generation: candidate.generation.modelId, evaluators: ['fixture-eval-model-a', 'fixture-eval-model-b'] },
    checks: {
      demandSignal: {
        status: 'pass',
        payload: buildDemandEvidence(candidate.demandBinding, FIXTURE_DEMAND_WINDOW, makeDemandCells(candidate.demandBinding))!,
        artifactHash: '',
      },
      passageExistence: { status: 'pass', payload: derivePassageExistencePayload(candidate), artifactHash: '' },
      krvTextMatch: { status: 'pass', payload: { bibleSourceSha256: SOURCE_SHA256, passageTextHashes }, artifactHash: '' },
      contextTheologyReview: {
        status: 'pass',
        payload: {
          evaluations: [
            { profileHash: profileHashById('fixture-theology-evaluator-a', registry), cardEvaluations },
            { profileHash: profileHashById('fixture-theology-evaluator-b', registry), cardEvaluations: structuredClone(cardEvaluations) },
          ],
        },
        artifactHash: '',
      },
      safetyBoundary: {
        status: 'pass',
        payload: {
          rulesVersion: 'fixture-safety/v1',
          cases: Array.from({ length: 12 }, (_, index) => ({
            caseId: `SAFE-${String(index + 1).padStart(3, '0')}`,
            expectedRoute: 'safety' as const,
            observedRoute: 'safety' as const,
          })),
        },
        artifactHash: '',
      },
      duplicateCheck: { status: 'pass', payload: deriveDuplicateCheckPayload(candidate, base), artifactHash: '' },
      corpusRegression: {
        status: 'pass',
        payload: {
          corpusVersion: 'fixture-corpus/v1',
          cases: Array.from({ length: 10 }, (_, index) => ({
            caseId: `EVAL-${String(index + 1).padStart(3, '0')}`,
            baseline: { domainMatch: index % 3 !== 0, acceptableMatch: index % 4 !== 0, safetyFalsePositive: false },
            candidate: { domainMatch: true, acceptableMatch: true, safetyFalsePositive: false },
          })),
        },
        artifactHash: '',
      },
      candidateGenerationEvaluation: {
        status: 'pass',
        payload: {
          evidenceArtifactHash: `sart_${'e'.repeat(64)}`,
          cases: candidate.cards.flatMap((card, cardIndex) =>
            Array.from({ length: 3 }, (_, index) => ({ caseId: `GEN-${cardIndex + 1}-${index + 1}`, cardId: card.id, passed: true })),
          ),
        },
        artifactHash: '',
      },
    },
    overallStatus: 'pass',
  } as AutomaticValidationRecord;
  return resealRecord(record);
}

/** 기록의 각 항목에 등록된 validator attestation을 붙인다. 판정은 기록된 status를 그대로 따른다. */
export function makeAttestations(
  record: AutomaticValidationRecord,
  registry: ValidatorRegistry = FIXTURE_VALIDATOR_REGISTRY,
): ValidationAttestation[] {
  const attestations: ValidationAttestation[] = [];
  for (const name of REQUIRED_VALIDATION_CHECKS) {
    const check = record.checks[name];
    if (check.status === 'not_run') continue;
    const profileHashes =
      name === 'contextTheologyReview'
        ? record.checks.contextTheologyReview.payload.evaluations.map((item) => item.profileHash)
        : registry.profiles.filter((item) => item.authorizedChecks.includes(name)).map(syncProfileHash);
    for (const profileHash of profileHashes) {
      attestations.push({
        contractVersion: ATTESTATION_CONTRACT_VERSION,
        candidateHash: record.candidateHash,
        checkName: name,
        payloadHash: check.artifactHash,
        profileHash,
        verdict: check.status as 'pass' | 'fail',
      });
    }
  }
  return attestations;
}

/** 검증 문맥 한 벌. 기록 원본에 붙인 attestation을 쓴다. */
export function validationContextFor(fixture: {
  candidate: ScriptureCatalogCandidate;
  base: ScriptureCatalogSnapshot;
  record: AutomaticValidationRecord;
}): ValidationContext {
  return {
    candidate: fixture.candidate,
    baseCatalog: fixture.base,
    resolvePassageText: resolveKrvPassage,
    validatorRegistry: FIXTURE_VALIDATOR_REGISTRY,
    attestations: makeAttestations(fixture.record),
  };
}
