/**
 * 개역한글(1961) 성경 데이터를 읽는 유틸리티.
 *
 * 원문은 src/data/bible/krv1961.json 에서 그대로 읽어옵니다.
 * 이 파일에서는 본문을 가공, 교정, 현대어화하지 않습니다.
 */

export type BibleVerse = {
  verse: number;
  text: string;
};

type BibleChapter = {
  chapter: number;
  verses: BibleVerse[];
};

type BibleBook = {
  book: string;
  chapters: BibleChapter[];
};

// 6MB가 넘는 JSON이므로 타입 검사 대상에서 제외하기 위해 require로 불러옵니다.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const books = require('./krv1961.json') as BibleBook[];

export const TRANSLATION_NAME = '성경전서 개역한글판(1961)';

export class PassageNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PassageNotFoundError';
  }
}

export type PassageRequest = {
  /** JSON에 들어 있는 영문 책 이름 (예: 'Psalms') */
  book: string;
  chapter: number;
  startVerse: number;
  /** 생략하면 startVerse 한 절만 가져옵니다. */
  endVerse?: number;
};

/**
 * 요청한 범위의 절을 원문 그대로 돌려줍니다.
 * 해당 장절이 없으면 다른 본문으로 대체하지 않고 PassageNotFoundError를 던집니다.
 */
export function getPassage({
  book,
  chapter,
  startVerse,
  endVerse = startVerse,
}: PassageRequest): BibleVerse[] {
  if (!Number.isInteger(chapter) || !Number.isInteger(startVerse) || !Number.isInteger(endVerse)) {
    throw new PassageNotFoundError('장절 번호는 정수여야 합니다.');
  }
  if (endVerse < startVerse) {
    throw new PassageNotFoundError(`끝 절이 시작 절보다 앞섭니다: ${book} ${chapter}:${startVerse}-${endVerse}`);
  }

  const foundBook = books.find((item) => item.book === book);
  if (!foundBook) {
    throw new PassageNotFoundError(`성경에 없는 책입니다: ${book}`);
  }

  const foundChapter = foundBook.chapters.find((item) => item.chapter === chapter);
  if (!foundChapter) {
    throw new PassageNotFoundError(`없는 장입니다: ${book} ${chapter}장`);
  }

  const verses: BibleVerse[] = [];
  for (let number = startVerse; number <= endVerse; number += 1) {
    const found = foundChapter.verses.find((item) => item.verse === number);
    if (!found) {
      throw new PassageNotFoundError(`없는 절입니다: ${book} ${chapter}:${number}`);
    }
    verses.push({ verse: found.verse, text: found.text });
  }

  return verses;
}
