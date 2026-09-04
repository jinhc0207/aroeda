/**
 * Situation Domain 사전 (V1)
 *
 * Domain은 세부 태그보다 상위에 있는 아뢰다 전체의 상황 분류 체계다.
 * Scripture Card의 태그에서 자동으로 뽑지 않는다. 여기서 직접 정한다.
 *
 * Domain의 목적은 "어떤 카드가 가장 높은 점수인가"가 아니라
 * "지금 Scripture Card DB가 이 사용자의 핵심 상황을 실제로 다룰 수 있는가"를 보는 것이다.
 *
 * 새 Domain을 임의로 추가하지 않는다.
 */

/** 현재 Scripture Card로 다룰 수 있는 상황 */
export const COVERED_DOMAINS = [
  'fear_uncertainty',
  'decision_guidance',
  'waiting_unanswered_prayer',
  'gratitude_joy',
  'quiet_communion',
  'repentance_guilt',
  'comparison_identity',
  'injustice_mistreatment',
  'grief_loss',
  'wisdom_discernment',
] as const;

/** 아뢰다가 분류는 하지만 아직 카드가 없는 상황 */
export const UNCOVERED_DOMAINS = [
  'loneliness_isolation',
  'family_parenting_conflict',
  'burnout_exhaustion',
  'spiritual_dryness',
  'financial_hardship',
  'chronic_illness',
  'relationship_conflict_forgiveness',
] as const;

/** 현재 분류체계 어디에도 들어가지 않는 상황 */
export const FALLBACK_DOMAIN = 'other_uncovered';

export const SITUATION_DOMAINS = [
  ...COVERED_DOMAINS,
  ...UNCOVERED_DOMAINS,
  FALLBACK_DOMAIN,
] as const;

export type CoveredDomain = (typeof COVERED_DOMAINS)[number];
export type UncoveredDomain = (typeof UNCOVERED_DOMAINS)[number];
export type SituationDomain = (typeof SITUATION_DOMAINS)[number];

/** 개발자가 읽기 위한 설명. 사용자 화면에는 쓰지 않는다. */
export const DOMAIN_DESCRIPTIONS: Record<SituationDomain, string> = {
  fear_uncertainty: '결과를 알 수 없는 일 앞에서의 두려움과 불확실함',
  decision_guidance: '중요한 선택과 방향 결정',
  waiting_unanswered_prayer: '오래된 기도와 달라지지 않는 상황, 기다림',
  gratitude_joy: '좋은 일과 감사, 기쁨',
  quiet_communion: '특별한 문제 없이 하나님과 조용히 머물고 싶은 상태',
  repentance_guilt: '자신의 죄와 죄책감, 하나님 앞에서의 회개',
  comparison_identity: '다른 사람과의 비교, 뒤처짐, 부르심과 정체성',
  injustice_mistreatment: '억울함, 부당대우, 괴롭힘과 불의',
  grief_loss: '사별과 상실, 애도',
  wisdom_discernment: '어떻게 판단해야 할지 모를 때 구하는 지혜와 분별',

  loneliness_isolation: '외로움과 관계적 고립',
  family_parenting_conflict: '가족 관계와 자녀 양육에서의 갈등',
  burnout_exhaustion: '소진, 의욕 상실, 지속적인 탈진',
  spiritual_dryness: '하나님이 멀게 느껴지는 영적 침체',
  financial_hardship: '생계와 경제적 어려움',
  chronic_illness: '만성질환 진단과 질병과 함께 살아가는 삶',
  relationship_conflict_forgiveness: '타인과의 갈등, 용서와 관계 회복',

  other_uncovered: '현재 분류체계 어디에도 적절히 들어가지 않는 상황',
};

const domainSet = new Set<string>(SITUATION_DOMAINS);
const coveredSet = new Set<string>(COVERED_DOMAINS);

export function isSituationDomain(value: unknown): value is SituationDomain {
  return typeof value === 'string' && domainSet.has(value);
}

/** 분류체계에는 있지만 아직 카드가 없는 domain인지 여부는 여기서 판단하지 않는다. */
export function isCoveredDomainName(value: string): value is CoveredDomain {
  return coveredSet.has(value);
}
