/**
 * Research Prioritizer 계약 (지시문 + 응답 구조)
 *
 * 이 파일은 "다음에 어떤 삶의 영역을 Scripture Card 연구 대상으로 살펴볼지"만 판단하는
 * AI Evaluator에게 주는 규칙이다.
 *
 * 여기서는 실행 환경에 묶인 코드(OpenAI SDK, Deno.env, process.env)를 넣지 않는다.
 * 아직 실제 AI를 부르지 않는다. 규격만 준비한 상태다.
 */

import {
  CARD_COVERED_DOMAINS,
  DOMAIN_DESCRIPTIONS,
  FALLBACK_DOMAIN,
  isSituationDomain,
} from './situation-domains.ts';

/**
 * 확장 연구 정책이 다루는 7개 영역(other_uncovered 제외).
 *
 * 카드 보유 여부와 독립된 정책 목록이다. 2026-09-15 확장 뒤 일곱 영역 모두 카드가 3장씩
 * 있지만, 기존 연구 이력·스키마·게시 후보 계약을 읽을 수 있도록 명시적으로 유지한다.
 * 현재 coverage-gap 경로에서는 새 근거가 생기지 않는다.
 */
export const RESEARCHABLE_DOMAINS: readonly string[] = [
  'loneliness_isolation',
  'family_parenting_conflict',
  'burnout_exhaustion',
  'spiritual_dryness',
  'financial_hardship',
  'chronic_illness',
  'relationship_conflict_forgiveness',
];

export const DEMAND_INTERPRETATIONS = ['low', 'moderate', 'high'] as const;
export type DemandInterpretation = (typeof DEMAND_INTERPRETATIONS)[number];

export const SCORE_MIN = 1;
export const SCORE_MAX = 5;

/** reason은 짧게 쓴다. 길게 쓰면서 사실을 지어내지 않게 한다. */
export const REASON_MAX_LENGTH = 300;

const domainList = (domains: readonly string[]) =>
  domains.map((domain) => `- ${domain}: ${DOMAIN_DESCRIPTIONS[domain as never] ?? ''}`).join('\n');

/** 알 수 없는 값이 프롬프트나 입력에 섞이려 할 때 던진다. 조용히 넘어가지 않는다. */
export class InvalidCoverageSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidCoverageSnapshotError';
  }
}

/**
 * 연구 파이프라인이 보관하는 영역 snapshot을 안전하게 정리한다.
 *
 * - 아뢰다가 아는 영역만 허용한다. 모르는 문자열이 하나라도 있으면 실패한다(fail-closed).
 * - other_uncovered는 카드가 있는 영역이 아니므로 여기에 올 수 없다.
 * - 중복을 없애고 정렬한다.
 *
 * 함수 이름은 기존 저장·handoff 계약을 위해 유지한다. 현재 호출자가 넣는 값은
 * 현재 카드 coverage 17개가 아니라 초기 연구 기준선 10개다.
 */
export function sanitizeActiveCoveredDomains(domains: readonly string[]): string[] {
  if (!Array.isArray(domains)) {
    throw new InvalidCoverageSnapshotError('활성 영역 목록이 배열이 아닙니다.');
  }

  for (const domain of domains) {
    if (!isSituationDomain(domain)) {
      throw new InvalidCoverageSnapshotError(`알 수 없는 영역이 들어왔습니다: ${String(domain)}`);
    }
    if (domain === FALLBACK_DOMAIN) {
      throw new InvalidCoverageSnapshotError(`${FALLBACK_DOMAIN}는 활성 영역으로 쓸 수 없습니다.`);
    }
  }

  return [...new Set(domains)].sort();
}

/**
 * 지시문을 만든다.
 * 지금 다루고 있는 영역 목록은 상수로 굳히지 않고, 판단 시점의 snapshot을 받아서 넣는다.
 * 받은 목록은 그대로 쓰지 않고 아는 영역만 남긴다.
 */
export function buildPrioritizerInstructions(initialResearchBaselineDomains: readonly string[]): string {
  const safeBaseline = sanitizeActiveCoveredDomains(initialResearchBaselineDomains);
  const currentCardCovered = sanitizeActiveCoveredDomains(CARD_COVERED_DOMAINS);
  return `당신은 아뢰다의 Research Prioritizer입니다.

당신이 하는 일은 하나뿐입니다.
지금 주어진 후보 영역들 중 어떤 영역을 다음 Scripture Card 연구 대상으로 먼저 살펴볼 가치가 있는지 판단합니다.

절대 하지 않는 일:

- 성경본문을 고르거나 추천하지 않는다.
- Scripture Card나 그 초안을 쓰지 않는다.
- 신학적 설명이나 기도문을 쓰지 않는다.
- 새로운 영역(domain) 이름이나 분류를 만들지 않는다.
- 하나님의 뜻이나 숨은 의도를 추측하지 않는다.
- 개별 사용자의 상태, 심각도, 진단을 추측하지 않는다.
- 주어진 후보 목록 밖의 영역을 평가하지 않는다.

[숫자의 의미]

gap_count는 과거 coverage-gap 수집 시점에 "그 영역에서 카드로 다룰 수 없다고 판정된 횟수"입니다.
현재 카드 보유 여부를 뜻하지 않으며, 후보 영역에는 지금 활성 Scripture Card가 있을 수 있습니다.
고유 사용자 수가 아닙니다. 사용자 수, 사람 수, 몇 명이라고 표현하지 마십시오.

숫자는 이미 계산되어 주어집니다. 다시 계산하거나 바꾸지 마십시오.
주어지지 않은 사실을 지어내지 마십시오.

reason에는 gap count 숫자를 다시 적지 말고, 반복성과 최근성을 정성적으로 설명하십시오.
("최근 7일", "최근 30일" 같은 기간 표현은 써도 됩니다.)
reason은 ${REASON_MAX_LENGTH}자를 넘기지 마십시오.

빈도가 높다는 이유만으로 순위를 정하지 마십시오.

[평가 관점]

A. pastoralNeed (1~5)
그 영역을 아뢰다가 지금 다루지 못하는 것이,
기도의 방향을 찾는 사람에게 얼마나 의미 있는 목회적 공백이 될 수 있는가.
개별 사용자의 심각도를 추측하지 않습니다.

B. coverageGapDistinctness (1~5)
현재 카드 보유 영역들의 핵심 삶의 문제와 견주어,
이 영역을 추가로 연구하는 일이 기존 카드와 구분되는 보강 가치를 갖는가.
감정이 비슷하다는 이유만으로 같은 영역으로 묶지 마십시오.
독립적일수록 점수가 높습니다.

당신에게는 실제 Scripture Card의 내용이 주어지지 않습니다.
따라서 특정 성경본문이나 카드가 이 영역을 신학적으로 대신할 수 있는지는 판단하지 마십시오.

C. researchReadiness (1~5)
영역의 정의가 Scripture Card 연구를 시작할 만큼 분명하고 독립적인가.

D. demandInterpretation ('low' | 'moderate' | 'high')
전체 누적, 최근 30일, 최근 7일, 최초·최근 발생일을 보고
반복성과 최근성을 해석만 합니다. 숫자를 바꾸지 않습니다.

[확신]

근거가 부족하면 confidence를 낮추십시오. 0에서 1 사이의 숫자입니다.
확실하지 않은데 확신을 높게 쓰지 마십시오.

[순위]

recommendedRank는 1부터 시작하는 정수이며, 후보마다 서로 다른 값을 씁니다.
가장 먼저 살펴볼 영역이 1입니다.

[출력]

주어진 snapshotId를 그대로 돌려주십시오.
주어진 후보를 모두 평가하고, 정해진 항목만 채웁니다.
성경 구절, 카드 문안, 기도문, 새 분류 이름을 출력에 넣지 마십시오.

현재 정적 기준 카탈로그에서 Scripture Card가 있는 영역(${currentCardCovered.length}개, 사실 확인용):

${domainList(currentCardCovered)}

초기 연구 기준선 영역(10개, 비교용이며 현재 카드 coverage 전체가 아님):

${safeBaseline.length > 0 ? domainList(safeBaseline) : '- (없음)'}`;
}

/**
 * Structured Outputs용 JSON Schema.
 * 성경본문·카드·기도문을 넣을 자리 자체를 만들지 않는다.
 */
export const PRIORITIZER_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    snapshotId: { type: 'string' },
    evaluations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          targetDomain: { type: 'string', enum: [...RESEARCHABLE_DOMAINS] },
          evidenceVersion: { type: 'integer' },
          pastoralNeed: { type: 'integer' },
          coverageGapDistinctness: { type: 'integer' },
          researchReadiness: { type: 'integer' },
          demandInterpretation: { type: 'string', enum: [...DEMAND_INTERPRETATIONS] },
          recommendedRank: { type: 'integer' },
          reason: { type: 'string' },
          confidence: { type: 'number' },
        },
        required: [
          'targetDomain',
          'evidenceVersion',
          'pastoralNeed',
          'coverageGapDistinctness',
          'researchReadiness',
          'demandInterpretation',
          'recommendedRank',
          'reason',
          'confidence',
        ],
        additionalProperties: false,
      },
    },
  },
  required: ['snapshotId', 'evaluations'],
  additionalProperties: false,
} as const;
