/**
 * 아뢰다 표준 태그 사전
 *
 * 목록을 사람이 직접 적지 않고, 현재 Scripture Card 10개에 실제로 들어 있는 값에서
 * 자동으로 뽑아 만든다. 카드에 없는 태그는 이 사전에도 존재하지 않는다.
 *
 * 앞으로 OpenAI(Situation Analyzer)는 이 목록 안에 있는 값만 돌려주도록 한다.
 */

import { SCRIPTURE_CARDS, type ScriptureCard } from './scripture-cards.ts';

const collect = (pick: (card: ScriptureCard) => string[]): string[] =>
  [...new Set(SCRIPTURE_CARDS.flatMap(pick))].sort((a, b) => a.localeCompare(b, 'ko'));

export const SITUATION_TAGS = collect((card) => card.situationTags);
export const EMOTION_TAGS = collect((card) => card.emotionTags);
export const SPIRITUAL_QUESTION_TAGS = collect((card) => card.spiritualQuestionTags);
export const PRAYER_MODES = collect((card) => card.prayerModes);
export const PASTORAL_FUNCTIONS = collect((card) => card.pastoralFunction);

export const TAXONOMY = {
  situationTags: SITUATION_TAGS,
  emotionTags: EMOTION_TAGS,
  spiritualQuestionTags: SPIRITUAL_QUESTION_TAGS,
  prayerModes: PRAYER_MODES,
  pastoralFunctions: PASTORAL_FUNCTIONS,
} as const;

export type TaxonomyKind = keyof typeof TAXONOMY;

const TAXONOMY_SETS: Record<TaxonomyKind, Set<string>> = {
  situationTags: new Set(SITUATION_TAGS),
  emotionTags: new Set(EMOTION_TAGS),
  spiritualQuestionTags: new Set(SPIRITUAL_QUESTION_TAGS),
  prayerModes: new Set(PRAYER_MODES),
  pastoralFunctions: new Set(PASTORAL_FUNCTIONS),
};

/** 표준 사전에 있는 태그인지 확인한다. */
export function isKnownTag(kind: TaxonomyKind, tag: string): boolean {
  return TAXONOMY_SETS[kind].has(tag);
}

/** 표준 사전에 없는 태그만 골라낸다. */
export function unknownTags(kind: TaxonomyKind, tags: string[]): string[] {
  return tags.filter((tag) => !TAXONOMY_SETS[kind].has(tag));
}
