/**
 * Research Prioritizer Edge 보조 도구
 *
 * 판단 규칙 자체는 research-prioritizer.ts에 있다. 여기서는
 *   1) DB RPC가 준 줄을 안전하게 우리 구조로 옮기고
 *   2) 지금 카드가 다루는 영역 목록을 만들고
 *   3) Evaluator A/B에게 보낼 요청 본문을 만든다.
 *
 * 실행 환경에 묶인 코드(Deno.env, 네트워크 호출)는 넣지 않는다.
 * 사용자 문장이나 식별자는 이 경로 어디에도 들어오지 않는다.
 */

import { MODEL } from './analyzer-contract.ts';
import { extractOutputText } from './edge-analyzer.ts';
import {
  PRIORITIZER_RESULT_SCHEMA,
  buildPrioritizerInstructions,
} from './research-prioritizer-contract.ts';
import { isValidQueueDate } from './research-prioritizer.ts';
import type { EvaluationPayload, ResearchQueueItem } from './research-prioritizer.ts';
import { SCRIPTURE_CARDS } from './scripture-cards.ts';

/**
 * 지금 카드가 다루고 있는 영역 목록.
 *
 * 별도 배열을 새로 적지 않고 카드 데이터에서 뽑는다.
 * 나중에 카드 공개 상태(release status) 시스템이 생기면 이 함수만 바꾸면 된다.
 */
export function getActiveCoveredDomains(cards = SCRIPTURE_CARDS): string[] {
  return [...new Set(cards.flatMap((card) => card.domains))].sort();
}

/** RPC가 돌려줄 수 있는 영역 (읽기 전용 RPC의 필터와 같은 목록) */
export const QUEUE_ALLOWED_DOMAINS: readonly string[] = [
  'loneliness_isolation',
  'family_parenting_conflict',
  'burnout_exhaustion',
  'spiritual_dryness',
  'financial_hardship',
  'chronic_illness',
  'relationship_conflict_forgiveness',
];

/**
 * bigint 열은 문자열로 올 수 있다.
 * 정수 문자열만 받고, 안전한 정수 범위를 벗어나면 받지 않는다.
 */
export function parseQueueCount(raw: unknown): number | null {
  if (typeof raw === 'number') {
    return Number.isSafeInteger(raw) ? raw : null;
  }
  if (typeof raw === 'string' && /^-?\d+$/.test(raw)) {
    const parsed = Number(raw);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

/** DB RPC가 돌려준 줄 하나를 우리 구조로 옮긴다. 모양이나 값이 계약과 다르면 null. */
export function toResearchQueueItem(row: unknown): ResearchQueueItem | null {
  if (typeof row !== 'object' || row === null || Array.isArray(row)) return null;

  const value = row as Record<string, unknown>;
  const text = (key: string) => (typeof value[key] === 'string' ? (value[key] as string) : null);
  const count = (key: string) => parseQueueCount(value[key]);

  const targetDomain = text('target_domain');
  const researchKind = text('research_kind');
  const status = text('status');
  const firstDetectedDate = text('first_detected_date');
  const lastDetectedDate = text('last_detected_date');
  const totalGapCount = count('total_gap_count');
  const recent7dCount = count('recent_7d_count');
  const recent30dCount = count('recent_30d_count');
  const evidenceVersion = count('evidence_version');

  if (
    targetDomain === null ||
    researchKind === null ||
    status === null ||
    firstDetectedDate === null ||
    lastDetectedDate === null ||
    totalGapCount === null ||
    recent7dCount === null ||
    recent30dCount === null ||
    evidenceVersion === null
  ) {
    return null;
  }

  // RPC 계약을 벗어난 값은 조용히 버리지 않는다. 여기서 null을 돌려주면 전체가 실패한다.
  if (researchKind !== 'domain_expansion') return null;
  if (status !== 'queued') return null;
  if (!QUEUE_ALLOWED_DOMAINS.includes(targetDomain)) return null;

  if (totalGapCount <= 0) return null;
  if (recent7dCount < 0 || recent30dCount < 0) return null;
  if (recent7dCount > recent30dCount) return null;
  if (recent30dCount > totalGapCount) return null;
  if (evidenceVersion < 1) return null;

  if (!isValidQueueDate(firstDetectedDate) || !isValidQueueDate(lastDetectedDate)) return null;
  if (firstDetectedDate > lastDetectedDate) return null;

  return {
    targetDomain,
    researchKind,
    status,
    totalGapCount,
    recent7dCount,
    recent30dCount,
    firstDetectedDate,
    lastDetectedDate,
    evidenceVersion,
  };
}

/** RPC 결과 전체를 옮긴다. 한 줄이라도 모양이 다르면 null(fail-closed). */
export function toResearchQueue(rows: unknown): ResearchQueueItem[] | null {
  if (!Array.isArray(rows)) return null;

  const items: ResearchQueueItem[] = [];
  for (const row of rows) {
    const item = toResearchQueueItem(row);
    if (!item) return null;
    items.push(item);
  }
  return items;
}

export type EvaluatorName = 'A' | 'B';

/**
 * 두 Evaluator는 같은 근거, 같은 snapshotId, 같은 규칙, 같은 응답 구조를 쓴다.
 * 보는 관점(lens)만 다르다. 점수 항목이나 스키마는 바꾸지 않는다.
 */
export const EVALUATOR_LENSES: Record<EvaluatorName, string> = {
  A: `[당신의 관점: Pastoral Gap Reviewer]

당신이 특히 무겁게 보는 것은 pastoralNeed와 coverageGapDistinctness입니다.

스스로에게 묻습니다.
"아뢰다가 이 삶의 문제를 따로 다루지 못하는 것이 얼마나 의미 있는 목회적 공백인가?"

다만 반복 신호(demandInterpretation)와 researchReadiness를 무시하지 마십시오.
근거가 약하면 confidence를 낮추십시오.`,

  B: `[당신의 관점: Evidence & Readiness Reviewer]

당신이 특히 무겁게 보는 것은 demandInterpretation과 researchReadiness입니다.

스스로에게 묻습니다.
"실제 반복 신호와 영역 정의의 명확성을 볼 때, 지금 연구를 시작할 근거가 충분한가?"

다만 빈도만으로 순위를 정하지 마십시오.
pastoralNeed와 coverageGapDistinctness도 함께 보십시오.
근거가 약하면 confidence를 낮추십시오.`,
};

/**
 * Evaluator 한 명이 만들 수 있는 출력 상한.
 * 후보 7개 × (점수 몇 개 + 300자 이내 reason) 정도면 충분하다. 넉넉하되 무제한은 아니다.
 */
export const EVALUATOR_MAX_OUTPUT_TOKENS = 4000;

/** 서버 요청이 오래 붙잡히지 않게 하는 상한 */
export const QUEUE_TIMEOUT_MS = 5000;
export const EVALUATOR_TIMEOUT_MS = 60000;

/**
 * OpenAI 응답에서 구조화된 결과만 꺼낸다.
 *
 * 요청 자체는 성공했지만 모델이 답을 만들지 못한 경우(빈 응답, JSON 아님, 거절, 중간에 끊김)는
 * null을 돌려준다. 이것은 근거가 낡은 것이 아니라 평가가 이뤄지지 않은 것이다.
 * 원본 응답은 남기지 않는다.
 */
export function parseEvaluatorResult(raw: unknown): unknown | null {
  if (typeof raw !== 'object' || raw === null) return null;

  const payload = raw as Record<string, unknown>;

  // 중간에 끊긴 응답은 쓰지 않는다.
  if (payload.status === 'incomplete' || payload.incomplete_details) return null;

  // 모델이 거절한 경우도 쓰지 않는다.
  const output = payload.output;
  if (Array.isArray(output)) {
    for (const item of output) {
      if (typeof item !== 'object' || item === null) continue;
      const content = (item as { content?: unknown }).content;
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        if (typeof part === 'object' && part !== null && (part as { type?: unknown }).type === 'refusal') {
          return null;
        }
      }
    }
  }

  const text = extractOutputText(raw);
  if (!text) return null;

  try {
    const parsed = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Evaluator 한 명에게 보낼 OpenAI 요청 본문.
 * 사용자 문장은 존재하지 않는다. 후보 근거만 보낸다.
 */
export function buildEvaluatorRequest(
  evaluator: EvaluatorName,
  payload: EvaluationPayload,
  activeCoveredDomains: readonly string[],
): Record<string, unknown> {
  return {
    model: MODEL,
    store: false,
    max_output_tokens: EVALUATOR_MAX_OUTPUT_TOKENS,
    instructions: `${buildPrioritizerInstructions(activeCoveredDomains)}\n\n${EVALUATOR_LENSES[evaluator]}`,
    input: JSON.stringify(payload),
    text: {
      format: {
        type: 'json_schema',
        name: 'research_prioritization',
        strict: true,
        schema: PRIORITIZER_RESULT_SCHEMA,
      },
    },
  };
}
