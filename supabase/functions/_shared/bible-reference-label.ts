/**
 * 본문 위치를 사람이 읽는 한글 표기로 바꾼다.
 *
 * 성경 데이터의 책 이름은 영문이다(`Psalms`, `1John`).
 * 사람에게 보여줄 때는 한글이어야 한다(`시편`, `요한일서`).
 * 그 사이를 잇는 표 하나와 조립 규칙이 지금까지 없었다.
 *
 * 없어서 어떻게 됐는가.
 * 지금 있는 카드 열 장의 `시편 56:3–4` 같은 표기는 전부 손으로 적은 것이다.
 * 손으로 적으면 본문 위치와 이름이 어긋나도 아무도 모른다.
 *
 * 그래서 여기서 만든다. 모델에게 맡기지 않는다.
 * 성경 참조는 지어내는 것이 아니라 계산되는 것이다.
 *
 * 이 파일은 표시만 담당한다.
 *   성경 본문 문장을 다루지 않는다.
 *   검토 대상 글이나 연구 결과를 알지 못한다.
 *   바깥을 부르지 않고, 아무것도 저장하지 않는다.
 */

import { getLastVerse, isValidBibleReference } from './bible-reference.ts';
import type { PassageRef } from './scripture-cards.ts';

/**
 * 범위를 잇는 글자.
 *
 * 이미 있는 카드 열 장이 모두 엔 대시(–, U+2013)를 쓴다.
 * 보통 하이픈(-, U+002D)과 눈으로는 거의 같아 보이지만 다른 글자다.
 * 섞이면 같은 본문이 두 가지 표기를 갖게 되므로 여기서 하나로 고정한다.
 */
export const REFERENCE_RANGE_DASH = '–';

/**
 * 성경 66권의 한글 이름.
 *
 * 열쇠는 성경 데이터가 쓰는 영문 이름 그대로다. 다른 표기를 덧붙이지 않는다.
 * `SongofSolomon`처럼 가운데가 소문자인 것도 데이터 쪽을 따른다.
 *
 * 타입으로 66권을 강제하고 싶었지만 그럴 수 없었다.
 * BIBLE_BOOK_IDS 가 Object.keys 로 만들어져서 그냥 string[] 이기 때문이다.
 * 그래서 "이 표의 열쇠가 66권과 정확히 같다"는 것을 계약 테스트가 대신 지킨다.
 */
export const KOREAN_BIBLE_BOOK_NAMES = {
  // 구약
  Genesis: '창세기',
  Exodus: '출애굽기',
  Leviticus: '레위기',
  Numbers: '민수기',
  Deuteronomy: '신명기',
  Joshua: '여호수아',
  Judges: '사사기',
  Ruth: '룻기',
  '1Samuel': '사무엘상',
  '2Samuel': '사무엘하',
  '1Kings': '열왕기상',
  '2Kings': '열왕기하',
  '1Chronicles': '역대상',
  '2Chronicles': '역대하',
  Ezra: '에스라',
  Nehemiah: '느헤미야',
  Esther: '에스더',
  Job: '욥기',
  Psalms: '시편',
  Proverbs: '잠언',
  Ecclesiastes: '전도서',
  SongofSolomon: '아가',
  Isaiah: '이사야',
  Jeremiah: '예레미야',
  Lamentations: '예레미야애가',
  Ezekiel: '에스겔',
  Daniel: '다니엘',
  Hosea: '호세아',
  Joel: '요엘',
  Amos: '아모스',
  Obadiah: '오바댜',
  Jonah: '요나',
  Micah: '미가',
  Nahum: '나훔',
  Habakkuk: '하박국',
  Zephaniah: '스바냐',
  Haggai: '학개',
  Zechariah: '스가랴',
  Malachi: '말라기',

  // 신약
  Matthew: '마태복음',
  Mark: '마가복음',
  Luke: '누가복음',
  John: '요한복음',
  Acts: '사도행전',
  Romans: '로마서',
  '1Corinthians': '고린도전서',
  '2Corinthians': '고린도후서',
  Galatians: '갈라디아서',
  Ephesians: '에베소서',
  Philippians: '빌립보서',
  Colossians: '골로새서',
  '1Thessalonians': '데살로니가전서',
  '2Thessalonians': '데살로니가후서',
  '1Timothy': '디모데전서',
  '2Timothy': '디모데후서',
  Titus: '디도서',
  Philemon: '빌레몬서',
  Hebrews: '히브리서',
  James: '야고보서',
  '1Peter': '베드로전서',
  '2Peter': '베드로후서',
  '1John': '요한일서',
  '2John': '요한이서',
  '3John': '요한삼서',
  Jude: '유다서',
  Revelation: '요한계시록',
} as const;

/** 이 표가 아는 책 이름. */
export type KoreanBibleBookId = keyof typeof KOREAN_BIBLE_BOOK_NAMES;

/**
 * 영문 책 이름을 한글로 바꾼다. 모르는 이름이면 null.
 *
 * 모르는 이름을 그대로 돌려주지 않는다.
 * 그렇게 하면 화면에 `UnknownBook 3:1` 같은 것이 나가고,
 * 잘못된 것이 잘못된 줄 모르는 채로 사람 앞에 놓인다.
 *
 * null 을 돌려주는 방식은 같은 계층의 getLastVerse 와 같다.
 * 부르는 쪽이 반드시 없을 때를 처리하게 만든다.
 */
export function koreanBibleBookName(bookId: unknown): string | null {
  if (typeof bookId !== 'string') return null;
  if (!Object.hasOwn(KOREAN_BIBLE_BOOK_NAMES, bookId)) return null;
  return KOREAN_BIBLE_BOOK_NAMES[bookId as KoreanBibleBookId];
}

/**
 * 본문 위치 하나를 한글 표기로 만든다.
 *
 *   { Psalms, 56, 3, 3 }  →  시편 56:3
 *   { Psalms, 56, 3, 4 }  →  시편 56:3–4
 *
 * 실제로 있는 위치인지는 이미 있는 검사기가 본다. 같은 규칙을 여기서 다시 만들지 않는다.
 * 없는 장이나 없는 절이면 null 이다.
 */
export function formatKoreanBibleReference(passage: unknown): string | null {
  if (!isValidBibleReference(passage)) return null;

  const { book, chapter, startVerse, endVerse } = passage as PassageRef;

  const name = koreanBibleBookName(book);
  if (name === null) return null;

  if (startVerse === endVerse) return `${name} ${chapter}:${startVerse}`;

  return `${name} ${chapter}:${startVerse}${REFERENCE_RANGE_DASH}${endVerse}`;
}

/**
 * 장을 넘어가는 본문 하나를 한글 표기로 만든다.
 *
 *   { 1John, 1, 8, 10 } + [{ 1John, 2, 1, 2 }]  →  요한일서 1:8–2:2
 *
 * 왜 위치를 여러 개 받는가.
 * 본문 위치 하나는 한 장 안에서 끝나야 한다는 것이 이미 정해진 규칙이다.
 * "1장 8절부터 2장 2절까지"는 위치 하나로 적을 수 없고, 위치 둘로 적는다.
 *
 * 붙어 있을 때만 한 줄로 줄인다.
 * 붙어 있다는 것은 앞 위치가 그 장의 마지막 절에서 끝나고
 * 다음 위치가 바로 다음 장 1절에서 시작한다는 뜻이다.
 * 그래서 성경 데이터에 물어봐야 알 수 있고, 여기서 지어낼 수 없다.
 *
 * 떨어져 있는 두 곳을 한 줄로 적는 방법은 정하지 않았다.
 * 지금 저장소에 그런 예가 하나도 없어서, 쉼표든 세미콜론이든
 * 여기서 새로 만들면 그것이 곧 아무도 합의하지 않은 규칙이 된다.
 * 그래서 그 경우는 null 이다. 실제로 필요해지면 그때 정한다.
 */
export function formatKoreanBibleReferenceSequence(
  passage: unknown,
  additionalPassages: unknown,
): string | null {
  if (!Array.isArray(additionalPassages)) return null;

  // 덧붙인 곳이 없으면 위치 하나짜리와 같다.
  if (additionalPassages.length === 0) return formatKoreanBibleReference(passage);

  const ranges = [passage, ...additionalPassages];
  for (const range of ranges) {
    if (!isValidBibleReference(range)) return null;
  }

  const parts = ranges as PassageRef[];
  const first = parts[0] as PassageRef;

  const name = koreanBibleBookName(first.book);
  if (name === null) return null;

  for (let i = 1; i < parts.length; i += 1) {
    const previous = parts[i - 1] as PassageRef;
    const current = parts[i] as PassageRef;

    // 다른 책으로 넘어가는 본문은 한 줄로 줄이지 않는다.
    if (current.book !== previous.book) return null;

    // 앞이 그 장 끝까지 가고, 다음이 바로 다음 장 1절에서 시작해야 붙어 있는 것이다.
    if (current.chapter !== previous.chapter + 1) return null;
    if (current.startVerse !== 1) return null;
    if (previous.endVerse !== getLastVerse(previous.book, previous.chapter)) return null;
  }

  const last = parts[parts.length - 1] as PassageRef;

  return (
    `${name} ${first.chapter}:${first.startVerse}` +
    `${REFERENCE_RANGE_DASH}${last.chapter}:${last.endVerse}`
  );
}
