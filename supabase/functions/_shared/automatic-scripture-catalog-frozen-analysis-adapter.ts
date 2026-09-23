/**
 * Git에 고정된 분석 스냅샷으로 safetyBoundary와 corpusRegression payload를 만든다.
 *
 * 이 모듈은 네트워크·DB·환경변수·파일 시스템을 읽지 않는다. 스냅샷과 기준
 * 카탈로그를 생성 시점에 검증하고, 각 후보는 기존 후보 계약으로 다시 검증한 뒤
 * 기준/후보 카탈로그에 같은 분석을 넣어 Gate 결과만 비교한다.
 */

import {
  type ScriptureCatalogCandidate,
  type ScriptureCatalogSnapshot,
  computeCatalogVersionHash,
  validateCatalogCandidate,
  validateCatalogSnapshot,
} from './automatic-scripture-catalog-contract.ts';
import {
  type CorpusOutcome,
  type CorpusRegressionPayload,
  type SafetyBoundaryPayload,
} from './automatic-scripture-catalog-activation-contract.ts';
import {
  type CorpusRegressionCaseExpectation,
  type CorpusRegressionSnapshotCase,
  type FrozenAnalysisSnapshot,
  type SafetyBoundarySnapshotCase,
} from './automatic-scripture-catalog-analysis-snapshot-contract.ts';
import { validateAnalysisSnapshotAgainstCurrentEnvironment } from './automatic-scripture-catalog-analysis-environment.ts';
import { FROZEN_ANALYSIS_SNAPSHOT_V1 } from './automatic-scripture-catalog-analysis-snapshot-v1.ts';
import { runRecommendationGate, type GateResult } from './recommendation-gate.ts';
import type { ScriptureCard } from './scripture-cards.ts';
import type { SituationDomain } from './situation-domains.ts';

export type FrozenAnalysisDeterministicAdapters = {
  /** executor의 evaluationCorpusVersion에도 같은 값을 넣어야 한다. */
  evaluationCorpusVersion: string;
  evaluateSafetyBoundary: (candidate: ScriptureCatalogCandidate) => Promise<SafetyBoundaryPayload>;
  evaluateCorpusRegression: (candidate: ScriptureCatalogCandidate) => Promise<CorpusRegressionPayload>;
};

export type FrozenAnalysisAdapterBuildResult =
  | { ok: true; adapters: FrozenAnalysisDeterministicAdapters }
  | { ok: false; errors: string[] };

const compareStrings = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

/** CatalogCard를 Gate가 이미 쓰는 ScriptureCard 모양으로 손실 없이 투영한다. */
export function catalogSnapshotToGateCards(snapshot: ScriptureCatalogSnapshot): ScriptureCard[] {
  return snapshot.cards.map((card) => {
    const passages = card.passages.map((passage) => ({ ...passage }));
    if (passages.length === 0) throw new Error(`${card.id}: 본문 위치가 없습니다.`);
    return {
      id: card.id,
      // 새 영역 id는 운영 앱의 정적 SituationDomain union 밖일 수 있다. 후보 생성 증거는
      // 동적 manifest로 별도 검증하며, 이 cast는 문자열 기반 Gate에 catalog 카드를 투영하는
      // 기존 경계다.
      domains: [card.domainId as SituationDomain],
      referenceLabel: card.referenceLabel,
      passage: { ...passages[0] },
      passages,
      situationTags: [...card.situationTags],
      emotionTags: [...card.emotionTags],
      spiritualQuestionTags: [...card.spiritualQuestionTags],
      prayerModes: [...card.prayerModes],
      pastoralFunction: [...card.pastoralFunction],
      contextSummary: card.contextSummary,
      theologicalInsight: card.theologicalInsight,
      userExplanation: card.userExplanation,
      prayerDirection: card.prayerDirection,
      misuseGuards: [...card.misuseGuards],
    };
  });
}

function domainsMatch(result: GateResult, expected: CorpusRegressionCaseExpectation): boolean {
  if (expected.expectedRoute === 'domain_choice') {
    return (
      result.primaryDomain === null &&
      result.domainChoiceCandidates.length === 2 &&
      result.domainChoiceCandidates[0] === expected.expectedDomainChoiceCandidates[0] &&
      result.domainChoiceCandidates[1] === expected.expectedDomainChoiceCandidates[1]
    );
  }
  return result.primaryDomain === expected.expectedPrimaryDomain;
}

function acceptableMatches(result: GateResult, expected: CorpusRegressionCaseExpectation): boolean {
  if (expected.expectedRoute === 'recommend') {
    return (
      result.route === 'recommend' &&
      result.selectedCardId !== null &&
      expected.acceptableCardIds.includes(result.selectedCardId)
    );
  }
  if (expected.expectedRoute === 'domain_choice') {
    return result.route === 'domain_choice' && domainsMatch(result, expected);
  }
  return result.route === 'no_coverage';
}

export function deriveCorpusOutcome(result: GateResult, expected: CorpusRegressionCaseExpectation): CorpusOutcome {
  return {
    domainMatch: domainsMatch(result, expected),
    acceptableMatch: acceptableMatches(result, expected),
    safetyFalsePositive: result.route === 'safety',
  };
}

async function proposedCards(
  candidate: ScriptureCatalogCandidate,
  baseCatalog: ScriptureCatalogSnapshot,
): Promise<ScriptureCard[]> {
  let isolatedCandidate: ScriptureCatalogCandidate;
  try {
    isolatedCandidate = structuredClone(candidate);
  } catch {
    throw new Error('후보를 안전하게 복제할 수 없습니다.');
  }
  const checked = await validateCatalogCandidate(isolatedCandidate, baseCatalog);
  if (!checked.valid || checked.proposedCatalog === null) throw new Error('후보가 기준 카탈로그 계약과 맞지 않습니다.');
  return catalogSnapshotToGateCards(checked.proposedCatalog);
}

/**
 * 스냅샷과 기준 카탈로그를 한 번 검증한 뒤 executor에 주입할 두 adapter를 만든다.
 * 오류 때 부분 adapter를 돌려주지 않는다.
 */
export async function buildFrozenAnalysisDeterministicAdapters(
  snapshot: FrozenAnalysisSnapshot,
  baseCatalog: ScriptureCatalogSnapshot,
): Promise<FrozenAnalysisAdapterBuildResult> {
  let isolatedSnapshot: FrozenAnalysisSnapshot;
  let isolatedBaseCatalog: ScriptureCatalogSnapshot;
  try {
    isolatedSnapshot = structuredClone(snapshot);
    isolatedBaseCatalog = structuredClone(baseCatalog);
  } catch {
    return { ok: false, errors: ['snapshot/baseCatalog: 안전하게 복제할 수 없습니다.'] };
  }

  const catalogCheck = validateCatalogSnapshot(isolatedBaseCatalog);
  if (!catalogCheck.valid) return { ok: false, errors: ['baseCatalog: 계약에 맞지 않습니다.'] };

  const baseVersionHash = await computeCatalogVersionHash(isolatedBaseCatalog);
  const snapshotCheck = await validateAnalysisSnapshotAgainstCurrentEnvironment(isolatedSnapshot, baseVersionHash);
  if (!snapshotCheck.valid) return { ok: false, errors: [...snapshotCheck.errors] };

  const safetyCases = isolatedSnapshot.cases
    .filter((item): item is SafetyBoundarySnapshotCase => item.kind === 'safety_boundary')
    .sort((left, right) => compareStrings(left.caseId, right.caseId));
  const corpusCases = isolatedSnapshot.cases
    .filter((item): item is CorpusRegressionSnapshotCase => item.kind === 'corpus_regression')
    .sort((left, right) => compareStrings(left.caseId, right.caseId));
  if (safetyCases.length === 0 || corpusCases.length === 0) {
    return { ok: false, errors: ['snapshot.cases: 두 결정적 검사에 필요한 사례가 모두 있어야 합니다.'] };
  }

  const baselineCards = catalogSnapshotToGateCards(isolatedBaseCatalog);
  const evaluationCorpusVersion = isolatedSnapshot.fingerprint;
  return {
    ok: true,
    adapters: {
      evaluationCorpusVersion,
      evaluateSafetyBoundary: async (candidate) => {
        const candidateCards = await proposedCards(candidate, isolatedBaseCatalog);
        return {
          rulesVersion: evaluationCorpusVersion,
          cases: safetyCases.map((item) => ({
            caseId: item.caseId,
            expectedRoute: item.expected.expectedRoute,
            observedRoute: runRecommendationGate(structuredClone(item.analysis), candidateCards).route,
          })),
        };
      },
      evaluateCorpusRegression: async (candidate) => {
        const candidateCards = await proposedCards(candidate, isolatedBaseCatalog);
        return {
          corpusVersion: evaluationCorpusVersion,
          cases: corpusCases.map((item) => ({
            caseId: item.caseId,
            baseline: deriveCorpusOutcome(
              runRecommendationGate(structuredClone(item.analysis), baselineCards),
              item.expected,
            ),
            candidate: deriveCorpusOutcome(
              runRecommendationGate(structuredClone(item.analysis), candidateCards),
              item.expected,
            ),
          })),
        };
      },
    },
  };
}

/**
 * 운영 조립부가 임의 스냅샷을 주입하지 않고, 저장소가 버전 관리하는 v1 산출물만
 * 선택하도록 하는 진입점. 나머지 resolvePassageText·candidateGeneration adapter는
 * executor 조립 경계에서 별도로 넣어야 하며 이 함수는 그것을 통과한 척 만들지 않는다.
 */
export async function buildVersionedFrozenAnalysisDeterministicAdapters(
  baseCatalog: ScriptureCatalogSnapshot,
): Promise<FrozenAnalysisAdapterBuildResult> {
  return buildFrozenAnalysisDeterministicAdapters(FROZEN_ANALYSIS_SNAPSHOT_V1, baseCatalog);
}
