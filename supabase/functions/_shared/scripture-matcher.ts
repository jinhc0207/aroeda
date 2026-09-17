/**
 * Scripture Matching Engine (테스트용 V1)
 *
 * 규칙 문서: docs/SCRIPTURE_MATCHING.md
 *
 * 이번 단계에서는 사용자의 자유문장을 해석하지 않는다.
 * 이미 태그로 정리되어 있다고 가정한 입력을 받아 Scripture Card와 점수를 비교하기만 한다.
 * 안전 확인과 misuseGuards 검수는 아직 이 파일에 없다. 점수와 분리된 단계로 나중에 추가한다.
 */

// 별도 도구 없이 `npm test`로도 실행할 수 있도록 상대 경로와 확장자를 그대로 적는다.
import { SCRIPTURE_CARDS, type ScriptureCard } from './scripture-cards.ts';

/**
 * 이 Matcher가 점수를 매기는 규칙의 명시적 버전. 자동 스냅샷 environment 결속
 * (automatic-scripture-catalog-analysis-environment.ts)이 "이 스냅샷을 만들 때와 지금
 * 저장소의 Matcher가 같은 규칙을 쓰는가"를 대조할 때 이 상수를 그대로 결속값으로 쓴다.
 *
 * 배점·계산 방식 등 선택 결과(카드 점수·순위)에 영향을 주는 규칙이 하나라도 바뀌면
 * 반드시 이 버전을 올린다. 주석·서식만 바꾸는 것으로는 올리지 않는다. 이번 작업(환경
 * 결속 계층 추가)은 이 파일의 동작을 바꾸지 않았으므로 v1을 유지한다.
 */
export const SCRIPTURE_MATCHER_CONTRACT_VERSION = 'scripture-matcher/v1';

/** 이미 구조화되었다고 가정하는 입력. 모든 항목은 없어도 된다. */
export type MatchInput = {
  situationTags?: string[];
  emotionTags?: string[];
  spiritualQuestionTags?: string[];
  prayerModes?: string[];
  pastoralFunctions?: string[];
};

export const MAX_SCORES = {
  spiritualQuestion: 30,
  situation: 25,
  pastoralFunction: 20,
  emotion: 15,
  prayerMode: 10,
} as const;

export const TOTAL_MAX_SCORE = 100;

export type CardScore = {
  cardId: string;
  totalScore: number;
  situationScore: number;
  emotionScore: number;
  spiritualQuestionScore: number;
  prayerModeScore: number;
  pastoralFunctionScore: number;
  /** 어떤 태그가 실제로 일치했는지 (확인용) */
  matchedTags: {
    situation: string[];
    emotion: string[];
    spiritualQuestion: string[];
    prayerMode: string[];
    pastoralFunction: string[];
  };
};

export type MatchResult = {
  /** 점수가 높은 순서로 정렬된 전체 카드 결과 */
  scores: CardScore[];
  /** 가장 높은 점수를 받은 카드. 동점이면 여러 장이 들어간다. */
  topCards: CardScore[];
  /** 최고 점수가 여러 장이면 true */
  isTie: boolean;
  /** 최고 점수 (모든 점수가 0이면 0) */
  topScore: number;
};

const round1 = (value: number) => Math.round(value * 10) / 10;

/** 입력 태그 중 카드 태그에 그대로 들어 있는 것들 */
function matchTags(inputTags: string[] | undefined, cardTags: string[] | undefined): string[] {
  if (!Array.isArray(inputTags) || inputTags.length === 0) return [];
  if (!Array.isArray(cardTags) || cardTags.length === 0) return [];
  const cardTagSet = new Set(cardTags);
  const seen = new Set<string>();
  const matched: string[] = [];
  for (const tag of inputTags) {
    if (typeof tag !== 'string' || seen.has(tag)) continue;
    seen.add(tag);
    if (cardTagSet.has(tag)) matched.push(tag);
  }
  return matched;
}

/** 요소 점수 = 최대 점수 × (일치한 입력 태그 수 ÷ 입력 태그 수) */
function scoreDimension(
  inputTags: string[] | undefined,
  cardTags: string[] | undefined,
  maxScore: number,
): { score: number; matched: string[] } {
  const matched = matchTags(inputTags, cardTags);
  const uniqueInput = new Set(
    (Array.isArray(inputTags) ? inputTags : []).filter((tag) => typeof tag === 'string'),
  );
  if (uniqueInput.size === 0) {
    return { score: 0, matched };
  }
  return { score: round1((maxScore * matched.length) / uniqueInput.size), matched };
}

export function scoreCard(input: MatchInput, card: ScriptureCard): CardScore {
  const spiritualQuestion = scoreDimension(
    input.spiritualQuestionTags,
    card.spiritualQuestionTags,
    MAX_SCORES.spiritualQuestion,
  );
  const situation = scoreDimension(input.situationTags, card.situationTags, MAX_SCORES.situation);
  const pastoralFunction = scoreDimension(
    input.pastoralFunctions,
    card.pastoralFunction,
    MAX_SCORES.pastoralFunction,
  );
  const emotion = scoreDimension(input.emotionTags, card.emotionTags, MAX_SCORES.emotion);
  const prayerMode = scoreDimension(input.prayerModes, card.prayerModes, MAX_SCORES.prayerMode);

  return {
    cardId: card.id,
    totalScore: round1(
      spiritualQuestion.score +
        situation.score +
        pastoralFunction.score +
        emotion.score +
        prayerMode.score,
    ),
    situationScore: situation.score,
    emotionScore: emotion.score,
    spiritualQuestionScore: spiritualQuestion.score,
    prayerModeScore: prayerMode.score,
    pastoralFunctionScore: pastoralFunction.score,
    matchedTags: {
      situation: situation.matched,
      emotion: emotion.matched,
      spiritualQuestion: spiritualQuestion.matched,
      prayerMode: prayerMode.matched,
      pastoralFunction: pastoralFunction.matched,
    },
  };
}

/**
 * 입력 태그를 Scripture Card 전체와 비교한다.
 * 알 수 없는 태그나 빈 입력이 들어와도 오류를 내지 않고 0점으로 처리한다.
 * 동점은 감추지 않고 topCards에 모두 담아 돌려준다.
 */
export function matchScriptureCards(
  input: MatchInput,
  cards: ScriptureCard[] = SCRIPTURE_CARDS,
): MatchResult {
  const safeInput: MatchInput = input ?? {};
  const scores = cards
    .map((card) => scoreCard(safeInput, card))
    .sort((a, b) => b.totalScore - a.totalScore);

  const topScore = scores.length > 0 ? scores[0].totalScore : 0;
  const topCards = scores.filter((item) => item.totalScore === topScore);

  return {
    scores,
    topCards,
    isTie: topCards.length > 1,
    topScore,
  };
}
