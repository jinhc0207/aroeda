/**
 * Scripture Card Coverage 확인
 *
 * 지금 카드 DB가 사용자의 핵심 상황(primaryDomain)을 실제로 다룰 수 있는지만 본다.
 *
 * 이 파일은 추천 여부를 결정하지 않는다.
 * threshold, Recommendation Gate, fallback card는 아직 만들지 않는다.
 */

import { SCRIPTURE_CARDS, type ScriptureCard } from './scripture-cards.ts';
import { isSituationDomain, type SituationDomain } from './situation-domains.ts';

export type CoverageResult = {
  primaryDomain: string | null;
  covered: boolean;
  cardIds: string[];
};

/**
 * 해당 domain을 다루는 카드가 있는지 확인한다.
 * 표준 domain이 아니거나 값이 없으면 covered: false로 돌려준다. 억지로 카드를 찾지 않는다.
 */
export function getCoverage(
  primaryDomain: unknown,
  cards?: ScriptureCard[],
): CoverageResult {
  if (typeof primaryDomain !== 'string' || primaryDomain.length === 0) {
    return { primaryDomain: null, covered: false, cardIds: [] };
  }
  // 인자를 생략한 옛 정적 호출은 기존 18개 domain 계약을 유지한다. 활성 카탈로그를 명시적으로
  // 넘긴 Gate만 그 카탈로그가 검증한 새 domain을 사용할 수 있다.
  if (cards === undefined && !isSituationDomain(primaryDomain)) {
    return { primaryDomain: null, covered: false, cardIds: [] };
  }
  const source = cards ?? SCRIPTURE_CARDS;

  const cardIds = source
    .filter((card) => card.domains.some((domain) => domain === primaryDomain))
    .map((card) => card.id);

  return { primaryDomain, covered: cardIds.length > 0, cardIds };
}

/** 분석 결과에서 바로 확인할 때 쓴다. */
export function getCoverageForAnalysis(analysis: {
  primaryDomain?: string;
}): CoverageResult {
  return getCoverage(analysis.primaryDomain);
}

/** 지금 카드가 다루는 domain 목록 (개발자 확인용) */
export function coveredDomainsInCards(cards: ScriptureCard[] = SCRIPTURE_CARDS): SituationDomain[] {
  return [...new Set(cards.flatMap((card) => card.domains))];
}
