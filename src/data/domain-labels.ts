/**
 * 삶의 영역(Situation Domain) 사용자용 한국어 이름
 *
 * `situation-domains.ts`의 DOMAIN_DESCRIPTIONS는 개발자가 읽기 위한 설명이고
 * 화면에는 쓰지 않는다고 명시되어 있다. 이 파일은 그 반대로,
 * 사용자가 실제로 읽는 화면(영역 선택 화면 등)에만 쓸 짧은 이름이다.
 *
 * 지키는 것:
 *   - 내부 영문 domain 코드(fear_uncertainty 등)는 어떤 화면에도, 접근성 문구에도 노출하지 않는다.
 *   - 17개 covered + uncovered 영역을 모두 정의한다. other_uncovered는 사용자가 고를 수 없으므로 넣지 않는다.
 *   - 개발자용 설명(DOMAIN_DESCRIPTIONS)을 화면에 그대로 옮기지 않는다. 버튼에 쓸 만큼 짧게 줄인 이름이다.
 */

import { COVERED_DOMAINS, UNCOVERED_DOMAINS, type CoveredDomain, type UncoveredDomain } from './situation-domains';

export type ChoosableDomain = CoveredDomain | UncoveredDomain;

export const DOMAIN_LABELS: Record<ChoosableDomain, string> = {
  fear_uncertainty: '두려움과 불확실함',
  decision_guidance: '중요한 결정 앞에서',
  waiting_unanswered_prayer: '오래된 기다림',
  gratitude_joy: '감사와 기쁨',
  quiet_communion: '조용히 하나님과 머물고 싶은 마음',
  repentance_guilt: '죄책감과 회개',
  comparison_identity: '비교와 정체성',
  injustice_mistreatment: '억울함과 부당한 대우',
  grief_loss: '사별과 상실',
  wisdom_discernment: '지혜와 분별이 필요한 순간',

  loneliness_isolation: '외로움과 고립',
  family_parenting_conflict: '가족과 자녀 문제',
  burnout_exhaustion: '지치고 소진된 마음',
  spiritual_dryness: '영적으로 메마른 시간',
  financial_hardship: '생계와 경제적 어려움',
  chronic_illness: '질병과 함께하는 삶',
  relationship_conflict_forgiveness: '관계의 갈등과 용서',
};

const choosableDomainSet = new Set<string>([...COVERED_DOMAINS, ...UNCOVERED_DOMAINS]);

/** other_uncovered를 포함한 모르는 값이 들어와도 예외를 던지지 않는다. */
export function isLabeledDomain(value: unknown): value is ChoosableDomain {
  return typeof value === 'string' && choosableDomainSet.has(value);
}

/** 이름이 없는 값(예: other_uncovered)이 들어오면 null을 돌려준다. 화면이 빈 문구를 임의로 채우지 않는다. */
export function domainLabel(domain: unknown): string | null {
  return isLabeledDomain(domain) ? DOMAIN_LABELS[domain] : null;
}
