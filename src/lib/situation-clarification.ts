import { domainLabel } from '../data/domain-labels.ts';
import type { DomainChoiceOption } from './request-recommendation';

/** 추가 설명 한 번에 받는 최대 길이. 첫 입력과 합친 전체 길이는 서버 계약(3000자)을 따른다. */
export const MAX_CLARIFICATION_DETAIL_LENGTH = 600;
export const MAX_RECOMMENDATION_SITUATION_LENGTH = 3000;
/** 같은 상황에서 추가 분석을 반복하는 최대 횟수. 그 뒤에는 두 주제를 직접 고르게 한다. */
export const MAX_CLARIFICATION_ROUNDS = 3;

export type SituationClarificationPrompt = {
  question: string;
  guide: string;
  labels: [string, string];
};

const optionLabel = (option: DomainChoiceOption): string | null => {
  const displayName = option.displayName?.trim();
  return displayName || domainLabel(option.domain);
};

/**
 * 첫 분석이 고른 두 후보를 사용자용 추가 질문으로 바꾼다.
 * 모델을 다시 부르지 않으며 내부 domain id는 문구에 넣지 않는다.
 */
export function buildSituationClarificationPrompt(
  options: readonly DomainChoiceOption[],
  round = 0,
): SituationClarificationPrompt | null {
  if (!Number.isInteger(round) || round < 0 || round >= MAX_CLARIFICATION_ROUNDS) return null;
  if (options.length !== 2) return null;
  const first = optionLabel(options[0]!);
  const second = optionLabel(options[1]!);
  if (!first || !second || first === second) return null;

  const labels: [string, string] = [first, second];
  if (round === 0) {
    return {
      question: `‘${first}’, ‘${second}’ 두 주제가 함께 느껴지는 상황에서, 지금 가장 마음에 걸리는 장면은 무엇인가요?`,
      guide: '누가 옳은지 판단하기보다, 실제로 있었던 일을 편한 만큼 적어주세요.',
      labels,
    };
  }
  if (round === 1) {
    return {
      question: '그 장면에서 마음이 가장 힘들었던 순간은 언제였나요?',
      guide: '그때 들었던 감정이나 생각을 한두 문장으로 적어주세요.',
      labels,
    };
  }
  return {
    question: '그 일이 지금 나에게 어떤 영향을 주고 있으며, 가장 바라는 도움은 무엇인가요?',
    guide: '위로, 용기, 관계의 회복, 결정의 지혜처럼 말씀으로 붙들고 싶은 부분을 적어주세요.',
    labels,
  };
}

export type CombinedSituationResult =
  | { ok: true; situation: string }
  | { ok: false; reason: 'empty_original' | 'empty_detail' | 'too_long' };

/** 사용자가 쓴 두 문장을 내용 변경 없이 줄바꿈으로만 이어 붙인다. */
export function combineSituationWithClarification(
  original: string,
  detail: string,
): CombinedSituationResult {
  const normalizedOriginal = original.trim();
  const normalizedDetail = detail.trim();
  if (!normalizedOriginal) return { ok: false, reason: 'empty_original' };
  if (!normalizedDetail) return { ok: false, reason: 'empty_detail' };

  const situation = `${normalizedOriginal}\n${normalizedDetail}`;
  if (situation.length > MAX_RECOMMENDATION_SITUATION_LENGTH) {
    return { ok: false, reason: 'too_long' };
  }
  return { ok: true, situation };
}
