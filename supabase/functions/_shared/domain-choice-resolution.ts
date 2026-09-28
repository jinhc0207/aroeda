/**
 * 영역 선택 해석 (순수 로직)
 *
 * 규칙 문서: docs/RECOMMENDATION_GATE.md
 *
 * 사용자가 고른 삶의 영역(chosenDomain)을 기준으로
 * 분석 결과를 "중심 영역이 정해진(resolved)" 분석으로 바꾼다.
 *
 * 쓰는 곳:
 *   - Recommendation Gate: domain_choice일 때 두 후보 각각의 카드 결과를 미리 계산한다.
 *   - 기도 도움 서버: 다시 분석한 결과에 사용자가 고른 영역이 실제로 있는지 확인한다.
 *
 * 지키는 것:
 *   - 분석 결과에 실제로 있는 영역만 고를 수 있다. 요청으로 받은 영역을 억지로 끼워 넣지 않는다.
 *   - 태그·safety·confidence는 바꾸지 않는다. 안전 신호는 영역 선택으로 우회되지 않는다.
 *   - 네트워크, DB, 모델 호출이 없다.
 */

import { FALLBACK_DOMAIN, SITUATION_DOMAINS, isSituationDomain, type SituationDomain } from './situation-domains.ts';
import type { SituationAnalysis } from './situation-analysis.ts';

/** 사용자가 고를 수 있는 표준 영역인가. other_uncovered는 고를 수 없다. */
export function isChoosableDomain(value: unknown): value is SituationDomain {
  return isSituationDomain(value) && value !== FALLBACK_DOMAIN;
}

/**
 * 고른 영역을 중심으로 한 resolved 분석을 돌려준다.
 * 고른 영역이 분석 결과에 없거나 고를 수 없는 값이면 null이다.
 *
 * needs_choice: 두 후보 중 하나일 때만 성공. 고르지 않은 후보는 secondaryDomains로 간다.
 * resolved: 고른 영역이 primaryDomain이거나 secondaryDomains 중 하나일 때 성공.
 *   고른 영역이 primary가 되고, 기존 primary와 나머지 secondary는 중복 없이 secondary로 남는다.
 */
export function resolveAnalysisForChosenDomain<TDomain extends string>(
  analysis: SituationAnalysis<TDomain>,
  chosenDomain: unknown,
  allowedDomains: readonly string[] = SITUATION_DOMAINS,
  fallbackDomain: string = FALLBACK_DOMAIN,
): SituationAnalysis<TDomain> | null {
  if (
    typeof chosenDomain !== 'string' ||
    chosenDomain === fallbackDomain ||
    !allowedDomains.includes(chosenDomain)
  ) return null;
  const chosen = chosenDomain as TDomain;

  // 중심 영역 후보 자체가 없는 정보 부족 상태에서는 사용자가 고른 값을 끼워 넣지 않는다.
  if (analysis.domainPriority === 'needs_detail') return null;

  if (analysis.domainPriority === 'needs_choice') {
    if (!analysis.domainChoiceCandidates.includes(chosen)) return null;
    return {
      ...analysis,
      domainPriority: 'resolved',
      primaryDomain: chosen,
      domainChoiceCandidates: [],
      secondaryDomains: unique(analysis.domainChoiceCandidates.filter((domain) => domain !== chosen)),
    };
  }

  if (analysis.domainPriority !== 'resolved' || analysis.primaryDomain === null) return null;

  const detected = analysis.primaryDomain === chosen || analysis.secondaryDomains.includes(chosen);
  if (!detected) return null;

  return {
    ...analysis,
    domainPriority: 'resolved',
    primaryDomain: chosen,
    domainChoiceCandidates: [],
    secondaryDomains: unique(
      [analysis.primaryDomain, ...analysis.secondaryDomains].filter((domain) => domain !== chosen),
    ),
  };
}

function unique<TDomain extends string>(domains: TDomain[]): TDomain[] {
  return [...new Set(domains)];
}
