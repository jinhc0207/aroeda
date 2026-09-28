/**
 * Recommendation Gate V2
 *
 * 규칙 문서: docs/RECOMMENDATION_GATE.md
 *
 * 순서가 중요하다.
 *   1. 안전이 먼저다.
 *   2. 먼저 다룰 삶의 영역이 정해졌는지 본다(domainPriority).
 *      정보가 부족하면(needs_detail) 추가 질문 사유로, 두 영역 사이 선택이면(needs_choice)
 *      domain_choice로 돌려준다.
 *   3. 사용자의 핵심 상황(primaryDomain)을 지금 카드가 다룰 수 있는지 본다.
 *   4. 다룰 수 있을 때만 후보 카드를 만든다. 후보는 primaryDomain의 카드뿐이다.
 *   5. 그 후보들 사이에서만 기존 Matcher 점수를 쓰고, 최고점이 동점이면 임의로 고르지 않는다.
 *
 * domain_choice와 ambiguous는 다른 개념이다.
 *   domain_choice: 먼저 다룰 삶의 영역을 정하지 못했다. top-level 카드는 고르지 않는다.
 *     대신 두 후보 각각을 사용자가 골랐을 때의 결과(domainChoiceOptions)를 미리 계산해 둔다.
 *     사용자가 영역을 고를 때 OpenAI를 다시 부르지 않기 위해서다.
 *   ambiguous: primaryDomain은 정해졌지만 그 영역 카드들의 최고점이 동점이다.
 *
 * Matcher의 배점과 계산 방식은 이 파일에서 바꾸지 않는다. 결과를 걸러 쓰기만 한다.
 * score threshold는 아직 만들지 않는다.
 */

import { SCRIPTURE_CARDS, type ScriptureCard } from './scripture-cards.ts';
import { FALLBACK_DOMAIN, type SituationDomain } from './situation-domains.ts';
import { getCoverage, type CoverageResult } from './scripture-coverage.ts';
import { matchScriptureCards, type CardScore } from './scripture-matcher.ts';
import type { DomainPriorityStatus, SafetyAssessment, SituationAnalysis } from './situation-analysis.ts';
import { resolveAnalysisForChosenDomain } from './domain-choice-resolution.ts';

/**
 * 이 Gate가 후보를 고르는 규칙의 명시적 버전. 자동 스냅샷 environment 결속
 * (automatic-scripture-catalog-analysis-environment.ts)이 "이 스냅샷을 만들 때와 지금
 * 저장소의 Gate가 같은 규칙을 쓰는가"를 대조할 때 이 상수를 그대로 결속값으로 쓴다.
 *
 * 선택 결과(어느 route로 가는지, 어느 카드가 뽑히는지)에 영향을 주는 규칙이 하나라도
 * 바뀌면 반드시 이 버전을 올린다. 주석·서식만 바꾸는 것으로는 올리지 않는다.
 * needs_detail 분기를 추가해 route의 의미가 바뀌었으므로 v2다.
 */
export const RECOMMENDATION_GATE_CONTRACT_VERSION = 'recommendation-gate/v2';

export type GateRoute = 'safety' | 'domain_choice' | 'no_coverage' | 'recommend' | 'ambiguous';

/** 내부 개발 확인용 코드. 사용자에게 보여줄 문장은 아직 만들지 않는다. */
export type GateReason =
  | 'SAFETY_FIRST'
  | 'DOMAIN_PRIORITY_UNRESOLVED'
  | 'PRIMARY_DOMAIN_UNDETERMINED'
  | 'PRIMARY_DOMAIN_NOT_COVERED'
  | 'CARD_SELECTED'
  | 'TOP_SCORE_TIE';

/** 한 후보 영역을 골랐을 때 이어질 결과. 기존 Primary-First 규칙으로 계산한다. */
export type DomainChoiceResolution = 'recommend' | 'ambiguous' | 'no_coverage';

/**
 * domain_choice에서 후보 영역 하나를 골랐을 때의 결과.
 * 태그·점수 상세·분석 결과 전체는 넣지 않는다.
 */
export type DomainChoiceOption<TDomain extends string = SituationDomain> = {
  domain: TDomain;
  resolution: DomainChoiceResolution;
  /** resolution이 recommend일 때만 카드 번호가 있다. */
  selectedCardId: string | null;
};

export type GateResult<TDomain extends string = SituationDomain> = {
  route: GateRoute;
  domainPriority: DomainPriorityStatus;
  /** resolved면 분석 결과의 중심 영역, needs_choice면 null. */
  primaryDomain: TDomain | null;
  /** needs_choice일 때 분석 결과의 두 후보를 그대로 보존한다. 그 밖의 경우 빈 배열. 순서는 우선순위가 아니다. */
  domainChoiceCandidates: TDomain[];
  /**
   * domain_choice일 때 domainChoiceCandidates 순서 그대로 두 개. 그 밖의 route는 빈 배열.
   * 순서는 우선순위가 아니다.
   */
  domainChoiceOptions: DomainChoiceOption<TDomain>[];
  secondaryDomains: TDomain[];
  safety: SafetyAssessment;
  /**
   * primaryDomain을 지금 카드가 다룰 수 있는지.
   * primaryDomain이 정해지지 않은 경우(needs_choice)에는 계산하지 않고 null이다.
   * null은 "지원하지 않는 영역"이 아니라 "아직 영역이 정해지지 않아 판단하지 않음"을 뜻한다.
   */
  coverage: CoverageResult | null;
  /** 후보가 될 수 있는 domain. 추천 경로에서는 정확히 [primaryDomain]이다. */
  eligibleDomains: TDomain[];
  /** primaryDomain을 가진 카드만 최종 후보가 된다. secondaryDomains의 카드는 들어오지 않는다. */
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

export function runRecommendationGate<TDomain extends string = SituationDomain>(
  analysis: SituationAnalysis<TDomain>,
  cards: ScriptureCard[] = SCRIPTURE_CARDS,
): GateResult<TDomain> {
  const { domainPriority, primaryDomain, safety } = analysis;
  const needsChoice = domainPriority === 'needs_choice';
  const needsDetail = domainPriority === 'needs_detail';
  const unresolved = needsChoice || needsDetail;

  // STEP 1 · 안전이 먼저다.
  // 영역 선택이 필요한 사연이어도 safety가 먼저이고, 영역 선택과 후보별 결과를 내보내지 않는다.
  if (safety.level !== 'normal') {
    return {
      ...emptyResult(analysis),
      primaryDomain: unresolved ? null : primaryDomain,
      secondaryDomains: unresolved ? [] : analysis.secondaryDomains,
      coverage: unresolved ? null : getCoverage(primaryDomain, cards),
      route: 'safety',
      reason: 'SAFETY_FIRST',
    };
  }

  // STEP 2-1 · 중심 영역을 정할 정보가 아직 충분한가.
  // 가능한 영역을 추측하지 않고, 앱이 상담형 추가 질문을 할 수 있는 이유를 명시한다.
  if (needsDetail) {
    return {
      ...emptyResult(analysis),
      primaryDomain: null,
      secondaryDomains: [],
      coverage: null,
      route: 'no_coverage',
      reason: 'PRIMARY_DOMAIN_UNDETERMINED',
    };
  }

  // STEP 2-2 · 먼저 다룰 영역이 정해졌는가.
  // 정해지지 않았으면 top-level 카드는 고르지 않고 두 후보를 보존한다. no_coverage로 표현하지 않는다.
  // 두 후보 각각은 고른 영역 기준 resolved 분석으로 바꾼 뒤 같은 Primary-First 계산을 한 번씩만 한다.
  // (runResolvedGate는 runRecommendationGate를 다시 부르지 않는다.)
  if (needsChoice) {
    const domainChoiceOptions = analysis.domainChoiceCandidates.map((domain): DomainChoiceOption<TDomain> => {
      const runtimeDomains = [...new Set(cards.flatMap((card) => card.domains as readonly string[]))];
      const resolved = resolveAnalysisForChosenDomain(
        analysis,
        domain,
        [...runtimeDomains, ...analysis.domainChoiceCandidates],
        FALLBACK_DOMAIN,
      );
      if (resolved === null || resolved.primaryDomain === null) {
        throw new Error('domainChoiceCandidates에 고를 수 없는 영역이 있습니다. 분석 결과를 먼저 검증해야 합니다.');
      }
      const option = runResolvedGate(resolved, resolved.primaryDomain, cards);
      return {
        domain,
        resolution: option.route,
        selectedCardId: option.route === 'recommend' ? option.selectedCardId : null,
      };
    });

    return {
      ...emptyResult(analysis),
      primaryDomain: null,
      domainChoiceCandidates: [...analysis.domainChoiceCandidates],
      domainChoiceOptions,
      secondaryDomains: [],
      // 영역이 정해지지 않았으면 top-level coverage를 계산하지 않는다. 지원하지 않는 영역으로 오해하지 않게 한다.
      coverage: null,
      route: 'domain_choice',
      reason: 'DOMAIN_PRIORITY_UNRESOLVED',
    };
  }

  // resolved인데 primaryDomain이 없으면 validator를 거치지 않은 잘못된 입력이다.
  // 임의의 route로 바꾸지 않고 드러낸다.
  if (primaryDomain === null) {
    throw new Error('domainPriority가 resolved인데 primaryDomain이 없습니다. 분석 결과를 먼저 검증해야 합니다.');
  }

  const resolved = runResolvedGate(analysis, primaryDomain, cards);
  return { ...emptyResult(analysis), ...resolved };
}

/** 모든 route가 공유하는 기본값. 카드 관련 필드와 영역 선택 필드는 비어 있다. */
function emptyResult<TDomain extends string>(analysis: SituationAnalysis<TDomain>) {
  return {
    domainPriority: analysis.domainPriority,
    domainChoiceCandidates: [] as TDomain[],
    domainChoiceOptions: [] as DomainChoiceOption<TDomain>[],
    safety: analysis.safety,
    eligibleDomains: [] as TDomain[],
    eligibleCardIds: [] as string[],
    rankedCandidates: [] as CardScore[],
    selectedCardId: null as string | null,
    isTie: false,
  };
}

type ResolvedGatePart<TDomain extends string> = {
  route: DomainChoiceResolution;
  reason: 'PRIMARY_DOMAIN_NOT_COVERED' | 'CARD_SELECTED' | 'TOP_SCORE_TIE';
  primaryDomain: TDomain;
  secondaryDomains: TDomain[];
  coverage: CoverageResult;
  eligibleDomains: TDomain[];
  eligibleCardIds: string[];
  rankedCandidates: CardScore[];
  selectedCardId: string | null;
  isTie: boolean;
};

/**
 * 중심 영역이 정해진 분석의 Primary-First 계산 (STEP 3~5).
 * safety 판단은 이미 끝났다고 보고, 여기서는 다시 보지 않는다.
 * 이 함수는 runRecommendationGate를 부르지 않는다.
 */
function runResolvedGate<TDomain extends string>(
  analysis: SituationAnalysis<TDomain>,
  primaryDomain: TDomain,
  cards: ScriptureCard[],
): ResolvedGatePart<TDomain> {
  const coverage = getCoverage(primaryDomain, cards);
  const empty = {
    primaryDomain,
    secondaryDomains: analysis.secondaryDomains,
    coverage,
    eligibleDomains: [] as TDomain[],
    eligibleCardIds: [] as string[],
    rankedCandidates: [] as CardScore[],
    selectedCardId: null,
    isTie: false,
  };

  // STEP 3 · 핵심 상황을 지금 카드가 다룰 수 있는가.
  // secondaryDomains에 covered domain이 있어도 primaryDomain이 uncovered면 진행하지 않는다.
  if (!coverage.covered) {
    return { ...empty, route: 'no_coverage', reason: 'PRIMARY_DOMAIN_NOT_COVERED' };
  }

  // STEP 4 · 후보 domain과 후보 카드. 중심 영역(primaryDomain)만 후보가 된다.
  //
  // 복합 사연에서 보조 영역(secondaryDomains)의 카드를 후보에 넣으면,
  // 보조 영역 카드가 태그 점수로 중심 영역의 말씀을 밀어낼 수 있다.
  // 그래서 secondaryDomains는 결과와 분석 데이터에 그대로 남기되,
  // 그 영역에 속한다는 이유만으로 카드를 후보에 추가하지 않는다.
  // secondaryDomains를 태그로 바꾸거나 점수·가중치·threshold를 새로 만들지 않는다.
  const eligibleDomains: TDomain[] = [primaryDomain];

  const eligibleCardIds = cards
    .filter((card) => card.domains.some((domain) => domain === primaryDomain))
    .map((card) => card.id);

  // STEP 5 · 기존 Matcher 결과에서 후보 카드만 추린다. 배점은 그대로 둔다.
  // Matcher에는 분석 결과 전체를 그대로 넘긴다. 복합 사연에서 분석기가 붙인 실제 태그는
  // 중심 영역 카드들 사이의 순위를 정하는 데에만 쓰인다.
  const eligibleCardIdSet = new Set(eligibleCardIds);
  const rankedCandidates = matchScriptureCards(analysis, cards).scores.filter((score) =>
    eligibleCardIdSet.has(score.cardId),
  );

  if (rankedCandidates.length === 0) {
    // coverage가 true면 후보가 최소 하나 있어야 한다. 여기 오면 데이터가 어긋난 것이다.
    return {
      ...empty,
      eligibleDomains,
      eligibleCardIds,
      route: 'no_coverage',
      reason: 'PRIMARY_DOMAIN_NOT_COVERED',
    };
  }

  // 결과. 동점이면 한 장을 임의로 고르지 않는다.
  const decision = selectFromRanked(rankedCandidates);

  return {
    ...empty,
    eligibleDomains,
    eligibleCardIds,
    rankedCandidates,
    selectedCardId: decision.selectedCardId,
    isTie: decision.isTie,
    route: decision.isTie ? 'ambiguous' : 'recommend',
    reason: decision.isTie ? 'TOP_SCORE_TIE' : 'CARD_SELECTED',
  };
}
