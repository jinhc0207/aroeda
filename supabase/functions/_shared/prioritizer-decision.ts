/**
 * Prioritizer 판단 넘겨주기 · 순수 로직
 *
 * 왜 필요한가:
 *   Prioritizer가 "다음은 이 영역"이라고 정하면 그 판단은 응답으로 나가고 사라졌다.
 *   Source Harvester는 부르는 쪽이 적어 보낸 값을 모양만 보고 실행했다.
 *   그래서 다른 영역의 판단 시점 id를 붙여도 서버가 틀렸다는 것을 알 수 없었다.
 *
 *   이제 합의가 확정되면 서버가 그 판단을 표에 적어 두고,
 *   그 줄의 번호(decisionId)를 넘겨준다. 번호는 한 번만 쓸 수 있다.
 *
 * 이 파일이 하는 일:
 *   표에 보낼 값이 온전한지 보고, 표가 돌려준 번호가 쓸 만한지 본다.
 *
 * 이 파일이 하지 않는 일:
 *   네트워크, DB, 환경변수 읽기.
 *   원본 오류 문구·응답 본문·HTTP 상태·주소를 옮겨 담지 않는다.
 *   값을 고치지 않는다. 어긋나면 그대로 실패로 본다.
 */

import { RESEARCHABLE_DOMAINS } from './research-prioritizer-contract.ts';

// 판단의 수명은 표가 정한다. 여기에 적어 두지 않는다.
// 같은 숫자를 두 곳에 두면 언젠가 서로 어긋난다. 적는 쪽은 수명을 알 필요가 없다.

const UUID =/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SNAPSHOT_ID = /^snap_[0-9a-f]{64}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

const researchable = new Set<string>(RESEARCHABLE_DOMAINS);

/** 표에 적어 달라고 보낼 값. 네 개뿐이다. */
export type PrioritizerDecisionInput = {
  prioritizerSnapshotId: string;
  targetDomain: string;
  evidenceVersion: number;
  activeCoveredHash: string;
};

/**
 * 표가 돌려준 번호가 쓸 만한가.
 *
 * 표가 무엇을 돌려주든 그대로 믿지 않는다.
 * 모양이 맞는 번호 하나일 때만 참이다.
 */
export function isDecisionId(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

/**
 * 표에 보내기 전에 값을 본다. 보내고 나서 보지 않는다.
 *
 * 어긋난 것을 모두 모아 돌려준다. 실제 값은 담지 않는다.
 */
export function validatePrioritizerDecisionInput(input: unknown): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { valid: false, errors: ['판단 내용이 없습니다.'] };
  }

  const value = input as Record<string, unknown>;

  for (const key of Object.keys(value)) {
    if (!DECISION_INPUT_FIELDS.includes(key as (typeof DECISION_INPUT_FIELDS)[number])) {
      errors.push('보내지 않기로 한 항목이 있습니다.');
      break;
    }
  }

  if (typeof value.prioritizerSnapshotId !== 'string' || !SNAPSHOT_ID.test(value.prioritizerSnapshotId)) {
    errors.push('판단 시점 id의 모양이 다릅니다.');
  }

  if (typeof value.targetDomain !== 'string' || !researchable.has(value.targetDomain)) {
    errors.push('연구 대상 영역이 아닙니다.');
  }

  if (
    typeof value.evidenceVersion !== 'number' ||
    !Number.isSafeInteger(value.evidenceVersion) ||
    value.evidenceVersion < 1
  ) {
    errors.push('근거 판본이 올바르지 않습니다.');
  }

  if (typeof value.activeCoveredHash !== 'string' || !SHA256_HEX.test(value.activeCoveredHash)) {
    errors.push('활성 영역 지문의 모양이 다릅니다.');
  }

  return { valid: errors.length === 0, errors };
}

/** 표에 보내는 항목 이름. 이 넷 말고는 보내지 않는다. */
export const DECISION_INPUT_FIELDS = [
  'prioritizerSnapshotId',
  'targetDomain',
  'evidenceVersion',
  'activeCoveredHash',
] as const;

/**
 * 판단을 적어 두지 못한 까닭. 서버 기록에만 남긴다.
 *
 * 고정된 이름뿐이다. 원본 오류, 응답 본문, HTTP 상태, 주소는 담지 않는다.
 */
export const DECISION_CREATE_FAILURE_CODES = {
  /** 보낼 값이 규칙에 맞지 않았다 */
  input_invalid: 'prioritizer_decision_input_invalid',
  /** DB 주소나 열쇠가 설정돼 있지 않다 */
  not_configured: 'prioritizer_decision_not_configured',
  /** 활성 영역 지문을 만들지 못했다 */
  hash_failed: 'prioritizer_decision_hash_failed',
  /** 표가 돌려준 것이 쓸 만한 번호가 아니었다 */
  response_invalid: 'prioritizer_decision_response_invalid',
  /** 위 어디에도 확실히 들어가지 않는다 */
  unknown: 'prioritizer_decision_create_failed',
} as const;

export type DecisionCreateFailureKind = keyof typeof DECISION_CREATE_FAILURE_CODES;

/**
 * 기록에 남길 이름을 고른다.
 *
 * 어떤 값이 오더라도 정해진 이름 중 하나만 돌려준다.
 */
export function describeDecisionCreateFailure(kind: unknown): string {
  if (typeof kind === 'string' && kind in DECISION_CREATE_FAILURE_CODES) {
    return DECISION_CREATE_FAILURE_CODES[kind as DecisionCreateFailureKind];
  }
  return DECISION_CREATE_FAILURE_CODES.unknown;
}
