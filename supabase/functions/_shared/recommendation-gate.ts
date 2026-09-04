/**
 * Recommendation Gate V1
 *
 * 규칙 문서: docs/RECOMMENDATION_GATE.md
 *
 * 순서가 중요하다.
 *   1. 안전이 먼저다.
 *   2. 사용자의 핵심 상황(primaryDomain)을 지금 카드가 다룰 수 있는지 본다.
 *   3. 다룰 수 있을 때만 후보 카드를 만든다.
 *   4. 그 후보들 사이에서만 기존 Matcher 점수를 쓴다.
 *   5. 최고점이 동점이면 임의로 고르지 않는다.
 *
 * Matcher의 배점과 계산 방식은 이 파일에서 바꾸지 않는다. 결과를 걸러 쓰기만 한다.
 * score threshold는 아직 만들지 않는다.
 */

import { SCRIPTURE_CARDS, type ScriptureCard } from './scripture-cards.ts';
import type { SituationDomain } from './situation-domains.ts';
import { getCoverage, type CoverageResult } from './scripture-coverage.ts';
import { matchScriptureCards, type CardScore } from './scripture-matcher.ts';
import type { SafetyAssessment, SituationAnalysis } from './situation-analysis.ts';

export type GateRoute = 'safety' | 'no_coverage' | 'recommend' | 'ambiguous';

/** 내부 개발 확인용 코드. 사용자에게 보여줄 문장은 아직 만들지 않는다. */
export type GateReason =
  | 'SAFETY_FIRST'
  | 'PRIMARY_DOMAIN_NOT_COVERED'
  | 'CARD_SELECTED'
  | 'TOP_SCORE_TIE';

export type GateResult = {
  route: GateRoute;
  primaryDomain: SituationDomain;
  secondaryDomains: SituationDomain[];
  safety: SafetyAssessment;
  coverage: CoverageResult;
  /** 후보가 될 수 있는 domain. primaryDomain은 반드시 포함된다. */
  eligibleDomains: SituationDomain[];
  /** 위 domain을 가진 카드만 최종 후보가 된다. */
  eligibleCardIds: string[];
  /** 후보 카드만 점수순으로 정렬한 결과 */
  rankedCandidates: CardScore[];
  selectedCardId: string | null;
  isTie: boolean;
  reason: GateReason;
};

export type TieDecision = {
  selectedCardId: string | null;
  isTie: boolean;
  topCards: CardScore[];
};

/**
 * 점수순으로 정렬된 후보에서 한 장을 고른다.
 * 최고점이 여러 장이면 임의로 첫 번째를 고르지 않는다.
 */
export function selectFromRanked(rankedCandidates: CardScore[]): TieDecision {
  if (rankedCandidates.length === 0) {
    return { selectedCardId: null, isTie: false, topCards: [] };
  }
  const topScore = rankedCandidates[0].totalScore;
  const topCards = rankedCandidates.filter((card) => card.totalScore === topScore);
  if (topCards.length === 1) {
    return { selectedCardId: topCards[0].cardId, isTie: false, topCards };
  }
  return { selectedCardId: null, isTie: true, topCards };
}

export function runRecommendationGate(
  analysis: SituationAnalysis,
  cards: ScriptureCard[] = SCRIPTURE_CARDS,
): GateResult {
  const { primaryDomain, secondaryDomains, safety } = analysis;
  const coverage = getCoverage(primaryDomain, cards);

  const base = {
    primaryDomain,
    secondaryDomains,
    safety,
    coverage,
    eligibleDomains: [] as SituationDomain[],
    eligibleCardIds: [] as string[],
    rankedCandidates: [] as CardScore[],
    selectedCardId: null,
    isTie: false,
  };

  // STEP 1 · 안전이 먼저다.
  // 점수를 계산할 수는 있어도 그 결과를 일반 말씀 추천으로 쓰지 않는다.
  if (safety.level !== 'normal') {
    return { ...base, route: 'safety', reason: 'SAFETY_FIRST' };
  }

  // STEP 2 · 핵심 상황을 지금 카드가 다룰 수 있는가.
  // secondaryDomains에 covered domain이 있어도 primaryDomain이 uncovered면 진행하지 않는다.
  if (!coverage.covered) {
    return { ...base, route: 'no_coverage', reason: 'PRIMARY_DOMAIN_NOT_COVERED' };
  }

  // STEP 3 · 후보 domain과 후보 카드.
  const eligibleDomains = [
    primaryDomain,
    ...secondaryDomains.filter((domain) => getCoverage(domain, cards).covered),
  ].filter((domain, index, list) => list.indexOf(domain) === index);

  const eligibleDomainSet = new Set<string>(eligibleDomains);
  const eligibleCardIds = cards
    .filter((card) => card.domains.some((domain) => eligibleDomainSet.has(domain)))
    .map((card) => card.id);

  // STEP 4 · 기존 Matcher 결과에서 후보 카드만 추린다. 배점은 그대로 둔다.
  const eligibleCardIdSet = new Set(eligibleCardIds);
  const rankedCandidates = matchScriptureCards(analysis, cards).scores.filter((score) =>
    eligibleCardIdSet.has(score.cardId),
  );

  // STEP 5 · 결과. 동점이면 한 장을 임의로 고르지 않는다.
  const decision = selectFromRanked(rankedCandidates);

  if (rankedCandidates.length === 0) {
    // coverage가 true면 후보가 최소 하나 있어야 한다. 여기 오면 데이터가 어긋난 것이다.
    return {
      ...base,
      route: 'no_coverage',
      eligibleDomains,
      eligibleCardIds,
      reason: 'PRIMARY_DOMAIN_NOT_COVERED',
    };
  }

  return {
    primaryDomain,
    secondaryDomains,
    safety,
    coverage,
    eligibleDomains,
    eligibleCardIds,
    rankedCandidates,
    selectedCardId: decision.selectedCardId,
    isTie: decision.isTie,
    route: decision.isTie ? 'ambiguous' : 'recommend',
    reason: decision.isTie ? 'TOP_SCORE_TIE' : 'CARD_SELECTED',
  };
}
