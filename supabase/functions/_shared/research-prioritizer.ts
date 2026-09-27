/**
 * Research Prioritizer v1 (순수 로직)
 *
 * 하는 일: 지금 Research Queue 중 어떤 영역을 다음 연구 대상으로 볼지 정하는 판단까지.
 * 하지 않는 일: 성경본문 선택, Scripture Card 작성, 기도문 작성, 새 영역 생성,
 *               taxonomy 변경, DB 쓰기, 상태 변경.
 *
 * 실제 AI 호출은 아직 없다. 이 파일은
 *   1) AI에 보낼 후보를 코드로 먼저 걸러내고
 *   2) 판단 시점을 식별하는 snapshotId를 만들고
 *   3) 두 Evaluator의 결과를 검증하고
 *   4) 합의 여부만 판단한다.
 *
 * 개인정보: 사용자 문장, 사용자 id, JWT, IP, 세션·기기 정보, 감정·신앙질문 태그,
 *          기도 내용, OpenAI 원본 응답은 이 파일 어디에도 들어오지 않는다.
 */

import { CARD_COVERED_DOMAINS, DOMAIN_DESCRIPTIONS } from './situation-domains.ts';
import {
  DEMAND_INTERPRETATIONS,
  InvalidCoverageSnapshotError,
  REASON_MAX_LENGTH,
  RESEARCHABLE_DOMAINS,
  SCORE_MAX,
  SCORE_MIN,
  sanitizeActiveCoveredDomains,
  type DemandInterpretation,
} from './research-prioritizer-contract.ts';

/** Research Queue 한 줄에서 이 판단에 필요한 부분만. */
export type ResearchQueueItem = {
  targetDomain: string;
  researchKind: string;
  status: string;
  totalGapCount: number;
  recent7dCount: number;
  recent30dCount: number;
  firstDetectedDate: string;
  lastDetectedDate: string;
  evidenceVersion: number;
};

declare const eligibleBrand: unique symbol;

/**
 * 후보 검사를 통과한 항목에만 붙는 표시.
 * selectEligibleCandidates()를 거치지 않은 raw Queue는 타입 단계에서 payload로 갈 수 없다.
 */
export type EligibleResearchQueueItem = ResearchQueueItem & {
  readonly [eligibleBrand]: true;
};

/** AI에게 보낼 후보 하나. 여기 없는 정보는 보내지 않는다. */
export type EvaluationCandidate = {
  targetDomain: string;
  domainDescription: string;
  totalGapCount: number;
  recent7dCount: number;
  recent30dCount: number;
  firstDetectedDate: string;
  lastDetectedDate: string;
  evidenceVersion: number;
  /** 현재 정적 카탈로그에서 이 영역을 다루는 활성 Scripture Card가 있는지 */
  hasActiveScriptureCard: boolean;
};

export type EvaluationPayload = {
  snapshotId: string;
  candidates: EvaluationCandidate[];
  /** 기존 handoff·지문 계약이 비교하는 초기 연구 기준선 10개 */
  initialResearchBaselineDomains: string[];
  /** 현재 카드가 실제로 있는 17개 */
  cardCoveredDomains: string[];
};

export type CandidateEvaluation = {
  targetDomain: string;
  evidenceVersion: number;
  pastoralNeed: number;
  coverageGapDistinctness: number;
  researchReadiness: number;
  demandInterpretation: DemandInterpretation;
  recommendedRank: number;
  reason: string;
  confidence: number;
};

export type EvaluatorResult = { snapshotId: string; evaluations: CandidateEvaluation[] };

export type ValidationResult = { valid: boolean; errors: string[] };

export type PrioritizerOutcome =
  | { status: 'consensus'; recommendedDomain: string; evidenceVersion: number; snapshotId: string }
  | { status: 'recheck'; recommendedDomain: null; reason: string }
  | { status: 'no_eligible_research'; recommendedDomain: null }
  | { status: 'stale_evidence'; recommendedDomain: null };

const researchable = new Set(RESEARCHABLE_DOMAINS);
const cardCovered = new Set<string>(CARD_COVERED_DOMAINS);
const demandValues = new Set<string>(DEMAND_INTERPRETATIONS);

const isPositiveInt = (value: unknown) =>
  typeof value === 'number' && Number.isInteger(value) && value > 0;

const isNonNegativeInt = (value: unknown) =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;

/** YYYY-MM-DD 형태이고 실제로 존재하는 날짜인지 */
export function isValidQueueDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(time)) return false;
  return new Date(time).toISOString().slice(0, 10) === value;
}

/**
 * AI를 부르기 전에 코드가 후보를 정한다.
 *
 * other_uncovered, taxonomy_discovery, blocked/ready/researching/completed는 절대 후보가 되지 않는다.
 * 초기 연구 기준선(activeCoveredDomains)에 포함된 영역도 제외한다.
 * activeCoveredDomains라는 이름은 기존 handoff·저장 계약 때문에 유지한다.
 * 숫자와 날짜가 앞뒤가 맞지 않는 행도 제외한다. (DB 제약이 있어도 여기서 한 번 더 본다)
 */
export function selectEligibleCandidates(
  queue: ResearchQueueItem[],
  activeCoveredDomains: readonly string[],
): EligibleResearchQueueItem[] {
  // 모르는 값이 섞여 있으면 여기서 멈춘다. 조용히 넘어가지 않는다.
  const covered = new Set(sanitizeActiveCoveredDomains(activeCoveredDomains));

  return queue.filter((item): item is EligibleResearchQueueItem => {
    if (item.researchKind !== 'domain_expansion') return false;
    if (item.status !== 'queued') return false;
    if (!researchable.has(item.targetDomain)) return false;
    if (covered.has(item.targetDomain)) return false;

    if (!isPositiveInt(item.totalGapCount)) return false;
    if (!isNonNegativeInt(item.recent7dCount)) return false;
    if (!isNonNegativeInt(item.recent30dCount)) return false;
    if (item.recent7dCount > item.recent30dCount) return false;
    if (item.recent30dCount > item.totalGapCount) return false;

    if (!isPositiveInt(item.evidenceVersion)) return false;

    if (!isValidQueueDate(item.firstDetectedDate) || !isValidQueueDate(item.lastDetectedDate)) return false;
    if (item.firstDetectedDate > item.lastDetectedDate) return false;

    return true;
  });
}

/** 문자열을 SHA-256 hex로 바꾼다. Node와 Deno 모두에 있는 Web Crypto만 쓴다. */
async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * 판단 시점을 식별하는 값.
 *
 * 후보의 근거 수치가 하나라도 달라지거나, 후보가 늘거나 줄거나,
 * 초기 연구 기준선 목록이 달라지면 값이 달라진다.
 * 입력 순서가 달라도 같은 상태면 같은 값이 나온다. 개인정보는 들어가지 않는다.
 */
export async function computeSnapshotId(
  candidates: readonly ResearchQueueItem[],
  activeCoveredDomains: readonly string[],
): Promise<string> {
  const coveredPart = sanitizeActiveCoveredDomains(activeCoveredDomains).join(',');

  const candidatePart = candidates
    .map((item) =>
      [
        item.targetDomain,
        item.evidenceVersion,
        item.totalGapCount,
        item.recent7dCount,
        item.recent30dCount,
        item.firstDetectedDate,
        item.lastDetectedDate,
      ].join(':'),
    )
    .sort()
    .join('|');

  const canonical = `v2|candidates:${candidatePart}|covered:${coveredPart}`;

  return `snap_${await sha256Hex(canonical)}`;
}

/**
 * AI에 보낼 입력을 만든다.
 * 후보 검사를 통과한 항목만 받는다. 그래도 런타임에서 한 번 더 걸러 낸다.
 */
export async function buildEvaluationPayload(
  candidates: EligibleResearchQueueItem[],
  initialResearchBaselineDomains: readonly string[],
): Promise<EvaluationPayload> {
  // 모르는 값이 섞여 있으면 여기서 멈춘다.
  const baseline = sanitizeActiveCoveredDomains(initialResearchBaselineDomains);
  // 타입을 우회해 raw Queue가 들어와도 여기서 다시 막는다.
  const safe = selectEligibleCandidates(candidates as ResearchQueueItem[], baseline);

  return {
    snapshotId: await computeSnapshotId(safe, baseline),
    candidates: safe.map((item) => ({
      targetDomain: item.targetDomain,
      domainDescription: DOMAIN_DESCRIPTIONS[item.targetDomain as never] ?? '',
      totalGapCount: item.totalGapCount,
      recent7dCount: item.recent7dCount,
      recent30dCount: item.recent30dCount,
      firstDetectedDate: item.firstDetectedDate,
      lastDetectedDate: item.lastDetectedDate,
      evidenceVersion: item.evidenceVersion,
      hasActiveScriptureCard: cardCovered.has(item.targetDomain),
    })),
    initialResearchBaselineDomains: baseline,
    cardCoveredDomains: sanitizeActiveCoveredDomains(CARD_COVERED_DOMAINS),
  };
}

/**
 * 해서는 안 되는 말이 결과에 들어왔는지 본다.
 * 규칙을 어긴 결과는 쓰지 않는다.
 */
const BANNED_REASON_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /사용자\s*수|이용자\s*수|고유\s*사용자|users?\b/i, label: 'gap_count를 사용자 수로 표현' },
  { pattern: /\d+\s*(회|건|명|사람)/, label: '발생 횟수를 숫자로 다시 씀' },
  { pattern: /시편|잠언|요한|마태|로마서|야고보|성경\s*구절|본문\s*추천/i, label: '성경본문 언급' },
  { pattern: /카드\s*(초안|문안|작성)|scripture\s*card\s*draft/i, label: 'Scripture Card 작성' },
  { pattern: /기도문/, label: '기도문 작성' },
  { pattern: /하나님의\s*(뜻|계획|의도)/, label: '하나님의 뜻 추측' },
  { pattern: /진단|우울증|불안장애/, label: '개별 사용자 진단 추측' },
];

const isScore = (value: unknown) =>
  typeof value === 'number' && Number.isInteger(value) && value >= SCORE_MIN && value <= SCORE_MAX;

const EVALUATION_FIELDS = [
  'targetDomain',
  'evidenceVersion',
  'pastoralNeed',
  'coverageGapDistinctness',
  'researchReadiness',
  'demandInterpretation',
  'recommendedRank',
  'reason',
  'confidence',
] as const;

/**
 * Evaluator 결과가 규칙을 지켰는지 확인한다.
 * 후보에 없는 영역, 범위 위반, 순위 이상, 금지된 표현은 모두 무효다.
 */
export function validateEvaluation(
  result: unknown,
  candidates: readonly ResearchQueueItem[],
  snapshotId?: string,
): ValidationResult {
  const errors: string[] = [];

  if (typeof result !== 'object' || result === null || Array.isArray(result)) {
    return { valid: false, errors: ['결과가 객체가 아닙니다.'] };
  }

  const top = result as Record<string, unknown>;

  // 최상위에는 정해진 두 항목만 허용한다.
  for (const key of Object.keys(top)) {
    if (key !== 'snapshotId' && key !== 'evaluations') {
      errors.push(`허용되지 않는 최상위 항목이 있습니다 (${key})`);
    }
  }

  if (typeof top.snapshotId !== 'string' || top.snapshotId.length === 0) {
    errors.push('snapshotId가 없습니다.');
  } else if (snapshotId !== undefined && top.snapshotId !== snapshotId) {
    errors.push('snapshotId가 지금 판단 시점과 다릅니다.');
  }

  const evaluations = top.evaluations;
  if (!Array.isArray(evaluations) || evaluations.length === 0) {
    return { valid: false, errors: [...errors, 'evaluations가 비어 있습니다.'] };
  }

  const candidateVersions = new Map(candidates.map((item) => [item.targetDomain, item.evidenceVersion]));
  const seenDomains = new Set<string>();
  const ranks: number[] = [];

  for (const entry of evaluations) {
    if (typeof entry !== 'object' || entry === null) {
      errors.push('평가 항목이 객체가 아닙니다.');
      continue;
    }

    const item = entry as Record<string, unknown>;
    const domain = item.targetDomain;

    if (typeof domain !== 'string' || !candidateVersions.has(domain)) {
      errors.push(`후보에 없는 영역입니다: ${String(domain)}`);
      continue;
    }
    if (!researchable.has(domain)) {
      errors.push(`연구 대상이 아닌 영역입니다: ${domain}`);
      continue;
    }
    if (seenDomains.has(domain)) {
      errors.push(`같은 영역이 두 번 평가되었습니다: ${domain}`);
      continue;
    }
    seenDomains.add(domain);

    for (const field of ['pastoralNeed', 'coverageGapDistinctness', 'researchReadiness'] as const) {
      if (!isScore(item[field])) {
        errors.push(`${domain}: ${field} 점수가 ${SCORE_MIN}~${SCORE_MAX} 정수가 아닙니다.`);
      }
    }

    if (typeof item.demandInterpretation !== 'string' || !demandValues.has(item.demandInterpretation)) {
      errors.push(`${domain}: demandInterpretation 값이 올바르지 않습니다.`);
    }

    if (
      typeof item.confidence !== 'number' ||
      !Number.isFinite(item.confidence) ||
      item.confidence < 0 ||
      item.confidence > 1
    ) {
      errors.push(`${domain}: confidence는 0과 1 사이여야 합니다.`);
    }

    if (
      typeof item.recommendedRank !== 'number' ||
      !Number.isInteger(item.recommendedRank) ||
      item.recommendedRank < 1
    ) {
      errors.push(`${domain}: recommendedRank가 1 이상의 정수가 아닙니다.`);
    } else {
      ranks.push(item.recommendedRank);
    }

    if (typeof item.evidenceVersion !== 'number' || item.evidenceVersion !== candidateVersions.get(domain)) {
      errors.push(`${domain}: evidenceVersion이 현재 근거와 다릅니다.`);
    }

    if (typeof item.reason !== 'string' || item.reason.trim().length === 0) {
      errors.push(`${domain}: reason이 비어 있습니다.`);
    } else {
      if (item.reason.length > REASON_MAX_LENGTH) {
        errors.push(`${domain}: reason이 ${REASON_MAX_LENGTH}자를 넘습니다.`);
      }
      for (const { pattern, label } of BANNED_REASON_PATTERNS) {
        if (pattern.test(item.reason)) errors.push(`${domain}: 허용되지 않는 내용 (${label})`);
      }
    }

    // 정해진 항목 외에 다른 것을 붙여 오면 쓰지 않는다.
    const allowed = new Set<string>(EVALUATION_FIELDS);
    for (const key of Object.keys(item)) {
      if (!allowed.has(key)) errors.push(`${domain}: 허용되지 않는 항목이 있습니다 (${key})`);
    }
  }

  if (seenDomains.size !== candidates.length) {
    errors.push('모든 후보를 평가하지 않았습니다.');
  }

  const sortedRanks = [...ranks].sort((a, b) => a - b);
  const expected = sortedRanks.map((_, index) => index + 1);
  if (sortedRanks.length !== expected.length || sortedRanks.some((rank, index) => rank !== expected[index])) {
    errors.push('recommendedRank가 1부터 이어지는 서로 다른 값이 아닙니다.');
  }

  return { valid: errors.length === 0, errors };
}

/** rank 1 항목을 찾는다. 없으면 null. */
function topDomain(result: EvaluatorResult): CandidateEvaluation | null {
  return result.evaluations.find((item) => item.recommendedRank === 1) ?? null;
}

/** Evaluator가 본 판단 시점이 지금과 같은지 확인한다. */
function isStale(result: unknown, snapshotId: string, candidates: readonly ResearchQueueItem[]): boolean {
  if (typeof result !== 'object' || result === null) return true;

  const top = result as Record<string, unknown>;
  if (typeof top.snapshotId !== 'string' || top.snapshotId !== snapshotId) return true;

  const evaluations = top.evaluations;
  if (!Array.isArray(evaluations)) return false;

  const versions = new Map(candidates.map((item) => [item.targetDomain, item.evidenceVersion]));
  return evaluations.some((entry) => {
    if (typeof entry !== 'object' || entry === null) return false;
    const { targetDomain, evidenceVersion } = entry as Record<string, unknown>;
    if (typeof targetDomain !== 'string' || !versions.has(targetDomain)) return false;
    return evidenceVersion !== versions.get(targetDomain);
  });
}

/**
 * 두 Evaluator의 결과로 우선순위를 정한다.
 * 두 결과가 같은 영역을 1위로 꼽았을 때만 합의로 본다. 갈리면 임의로 고르지 않는다.
 * DB는 건드리지 않는다.
 */
export async function decidePriority(input: {
  queue: ResearchQueueItem[];
  activeCoveredDomains: readonly string[];
  evaluationA: unknown;
  evaluationB: unknown;
}): Promise<PrioritizerOutcome> {
  let candidates: EligibleResearchQueueItem[];
  let covered: string[];
  try {
    covered = sanitizeActiveCoveredDomains(input.activeCoveredDomains);
    candidates = selectEligibleCandidates(input.queue, covered);
  } catch (error) {
    // 모르는 영역이 섞여 있으면 판단하지 않는다.
    if (error instanceof InvalidCoverageSnapshotError) {
      return { status: 'recheck', recommendedDomain: null, reason: 'invalid_coverage_snapshot' };
    }
    throw error;
  }

  if (candidates.length === 0) {
    return { status: 'no_eligible_research', recommendedDomain: null };
  }

  const snapshotId = await computeSnapshotId(candidates, covered);

  // 판단 시점이 달라진 뒤의 결과는 쓰지 않는다. 다시 평가해야 한다.
  if (isStale(input.evaluationA, snapshotId, candidates) || isStale(input.evaluationB, snapshotId, candidates)) {
    return { status: 'stale_evidence', recommendedDomain: null };
  }

  const checkA = validateEvaluation(input.evaluationA, candidates, snapshotId);
  const checkB = validateEvaluation(input.evaluationB, candidates, snapshotId);

  if (!checkA.valid || !checkB.valid) {
    return { status: 'recheck', recommendedDomain: null, reason: 'invalid_evaluation' };
  }

  const topA = topDomain(input.evaluationA as EvaluatorResult);
  const topB = topDomain(input.evaluationB as EvaluatorResult);

  if (!topA || !topB) {
    return { status: 'recheck', recommendedDomain: null, reason: 'missing_top_rank' };
  }

  if (topA.targetDomain !== topB.targetDomain) {
    return { status: 'recheck', recommendedDomain: null, reason: 'no_agreement' };
  }

  const version = candidates.find((item) => item.targetDomain === topA.targetDomain)?.evidenceVersion;
  if (version === undefined) {
    return { status: 'recheck', recommendedDomain: null, reason: 'unknown_domain' };
  }

  return {
    status: 'consensus',
    recommendedDomain: topA.targetDomain,
    evidenceVersion: version,
    snapshotId,
  };
}
