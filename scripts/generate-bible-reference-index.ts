/**
 * Bible Reference Index 생성 스크립트 (개발용)
 *
 * 실행: node scripts/generate-bible-reference-index.ts
 *
 * 하는 일:
 *   src/data/bible/krv1961.json 을 읽어서
 *   "각 책에 몇 장이 있고, 각 장의 마지막 절이 몇 절인가"만 뽑아
 *   supabase/functions/_shared/bible-reference-index.ts 로 저장한다.
 *
 * 하지 않는 일:
 *   성경 본문 문장을 복사하지 않는다. 장·절 수를 사람이 입력하지 않는다.
 *   인터넷에서 아무것도 가져오지 않는다. 원본 JSON을 수정하지 않는다.
 *
 * 이 스크립트는 개발용이며 Edge Function 배포에 포함되지 않는다.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

type BibleVerse = { verse: number; text: string };
type BibleChapter = { chapter: number; verses: BibleVerse[] };
type BibleBook = { book: string; chapters: BibleChapter[] };

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = join(projectRoot, 'src/data/bible/krv1961.json');
const outputPath = join(projectRoot, 'supabase/functions/_shared/bible-reference-index.ts');

const raw = readFileSync(sourcePath);
const sourceSha256 = createHash('sha256').update(raw).digest('hex');
const books = JSON.parse(raw.toString('utf8')) as BibleBook[];

const index: Record<string, number[]> = {};
let chapterCount = 0;
let verseCount = 0;

for (const book of books) {
  if (typeof book.book !== 'string' || book.book.length === 0) {
    throw new Error('책 이름이 없습니다.');
  }
  if (book.book in index) {
    throw new Error(`책 이름이 중복됩니다: ${book.book}`);
  }

  const lastVerses: number[] = [];

  book.chapters.forEach((chapter, position) => {
    // 장 번호는 1부터 빠짐없이 이어져야 한다. 그래야 배열 위치로 장을 찾을 수 있다.
    if (chapter.chapter !== position + 1) {
      throw new Error(`장 번호가 이어지지 않습니다: ${book.book} ${chapter.chapter}장`);
    }

    const numbers = chapter.verses.map((verse) => verse.verse);
    const last = numbers[numbers.length - 1];

    // 절 번호도 1부터 빠짐없이 이어져야 한다. 그래야 "마지막 절 번호"만으로 범위를 판단할 수 있다.
    numbers.forEach((verse, versePosition) => {
      if (verse !== versePosition + 1) {
        throw new Error(`절 번호가 이어지지 않습니다: ${book.book} ${chapter.chapter}:${verse}`);
      }
    });
    if (numbers.length === 0 || last !== numbers.length) {
      throw new Error(`절 수가 맞지 않습니다: ${book.book} ${chapter.chapter}장`);
    }

    lastVerses.push(last);
    chapterCount += 1;
    verseCount += numbers.length;
  });

  index[book.book] = lastVerses;
}

const bookCount = books.length;

const entries = Object.entries(index)
  .map(([book, chapters]) => `  ${JSON.stringify(book)}: [${chapters.join(', ')}],`)
  .join('\n');

const file = `/**
 * Bible Reference Index (자동 생성 파일 · 직접 고치지 마세요)
 *
 * 생성: node scripts/generate-bible-reference-index.ts
 * 원본: src/data/bible/krv1961.json (성경전서 개역한글판 1961)
 *
 * 담고 있는 것: 각 책의 장 수와, 각 장의 마지막 절 번호뿐이다.
 * 담고 있지 않은 것: 성경 본문 문장. 이 파일에는 성경 원문이 한 글자도 들어 있지 않다.
 *
 * 배열의 첫 번째 값이 1장이다. (index 0 = chapter 1)
 */

/** 원본 성경 JSON 파일의 SHA-256. 원본이 바뀌면 이 파일도 다시 만들어야 한다. */
export const SOURCE_SHA256 = '${sourceSha256}';

export const BOOK_COUNT = ${bookCount};
export const CHAPTER_COUNT = ${chapterCount};
export const VERSE_COUNT = ${verseCount};

export const BIBLE_REFERENCE_INDEX: Readonly<Record<string, readonly number[]>> = {
${entries}
};

export const BIBLE_BOOK_IDS: readonly string[] = Object.keys(BIBLE_REFERENCE_INDEX);
`;

writeFileSync(outputPath, file, 'utf8');

console.log(`books=${bookCount} chapters=${chapterCount} verses=${verseCount}`);
console.log(`sha256=${sourceSha256}`);
console.log(`wrote ${outputPath}`);
