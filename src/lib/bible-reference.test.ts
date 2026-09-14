/**
 * Bible Reference Index 테스트
 *
 * 실행: npm test
 *
 * 실제 성경 원문 파일에서 만든 index가 맞는지, 그리고 없는 장·절을 확실히 거절하는지 본다.
 * 네트워크, DB, AI를 쓰지 않는다.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  BIBLE_BOOK_IDS,
  BIBLE_REFERENCE_INDEX,
  BOOK_COUNT,
  CHAPTER_COUNT,
  SOURCE_SHA256,
  VERSE_COUNT,
} from '../../supabase/functions/_shared/bible-reference-index.ts';
import {
  checkBibleReference,
  checkBibleReferences,
  getLastVerse,
  isBibleBook,
  isValidBibleReference,
} from '../../supabase/functions/_shared/bible-reference.ts';
import {
  SCRIPTURE_CARDS,
  getCardPassages,
} from '../../supabase/functions/_shared/scripture-cards.ts';

const BIBLE_JSON_PATH = new URL('../data/bible/krv1961.json', import.meta.url);

describe('Bible Reference Index · 데이터 무결성', () => {
  it('66권이 모두 들어 있다', () => {
    assert.equal(BOOK_COUNT, 66);
    assert.equal(BIBLE_BOOK_IDS.length, 66);
    assert.equal(Object.keys(BIBLE_REFERENCE_INDEX).length, 66);
    assert.equal(new Set(BIBLE_BOOK_IDS).size, 66);
  });

  it('1189장이 모두 들어 있다', () => {
    const counted = BIBLE_BOOK_IDS.reduce(
      (total, book) => total + BIBLE_REFERENCE_INDEX[book].length,
      0,
    );
    assert.equal(CHAPTER_COUNT, 1189);
    assert.equal(counted, 1189);
  });

  it('31,102절과 일치한다', () => {
    const counted = BIBLE_BOOK_IDS.reduce(
      (total, book) => total + BIBLE_REFERENCE_INDEX[book].reduce((sum, last) => sum + last, 0),
      0,
    );
    assert.equal(VERSE_COUNT, 31102);
    assert.equal(counted, 31102);
  });

  it('모든 장의 마지막 절이 1 이상의 정수다', () => {
    for (const book of BIBLE_BOOK_IDS) {
      for (const [position, lastVerse] of BIBLE_REFERENCE_INDEX[book].entries()) {
        assert.ok(
          Number.isSafeInteger(lastVerse) && lastVerse > 0,
          `${book} ${position + 1}장의 절 수가 이상합니다.`,
        );
      }
    }
  });

  it('index에는 성경 본문 문장이 들어 있지 않다', () => {
    // 숫자와 영문 책 이름만 있어야 한다. 한글이 있으면 본문이 섞여 들어간 것이다.
    const values = JSON.stringify(BIBLE_REFERENCE_INDEX);
    assert.equal(/[가-힣]/.test(values), false);
  });
});

describe('Bible Reference Index · 원본 변경 감지', () => {
  it('생성 당시 원본 파일의 SHA-256과 지금 원본이 같다', () => {
    const actual = createHash('sha256').update(readFileSync(BIBLE_JSON_PATH)).digest('hex');
    assert.equal(
      SOURCE_SHA256,
      actual,
      '성경 데이터가 바뀌었습니다. node scripts/generate-bible-reference-index.ts 로 index를 다시 만들어야 합니다.',
    );
  });

  it('기록된 해시는 64자리 SHA-256 형식이다', () => {
    assert.match(SOURCE_SHA256, /^[0-9a-f]{64}$/);
  });
});

describe('Bible Reference · 본문 위치 검증', () => {
  it('실제로 있는 위치는 통과한다', () => {
    for (const reference of [
      { book: 'Psalms', chapter: 56, startVerse: 3, endVerse: 4 },
      { book: 'Psalms', chapter: 119, startVerse: 176, endVerse: 176 },
      { book: 'Genesis', chapter: 1, startVerse: 1, endVerse: 1 },
      { book: 'Revelation', chapter: 22, startVerse: 20, endVerse: 21 },
      { book: 'Jude', chapter: 1, startVerse: 24, endVerse: 25 },
    ]) {
      const outcome = checkBibleReference(reference);
      assert.equal(outcome.valid, true, `${JSON.stringify(reference)} → ${outcome.errors.join(' / ')}`);
    }
  });

  it('성경에 없는 책은 거절한다', () => {
    for (const book of ['Hezekiah', 'psalms', '시편', '', 'Book of Mormon', 'Maccabees']) {
      assert.equal(isBibleBook(book), false, book);
      assert.equal(isValidBibleReference({ book, chapter: 1, startVerse: 1, endVerse: 1 }), false, book);
    }
    // 객체가 원래 갖고 있는 이름을 책 이름으로 착각하지 않는다.
    assert.equal(isBibleBook('toString'), false);
    assert.equal(isBibleBook('constructor'), false);
  });

  it('0장이나 없는 장은 거절한다', () => {
    assert.equal(isValidBibleReference({ book: 'Psalms', chapter: 0, startVerse: 1, endVerse: 1 }), false);
    assert.equal(isValidBibleReference({ book: 'Psalms', chapter: -3, startVerse: 1, endVerse: 1 }), false);
    // 시편은 150편까지다.
    assert.equal(getLastVerse('Psalms', 150) !== null, true);
    assert.equal(getLastVerse('Psalms', 151), null);
    assert.equal(isValidBibleReference({ book: 'Psalms', chapter: 151, startVerse: 1, endVerse: 1 }), false);
    // 유다서는 1장뿐이다.
    assert.equal(isValidBibleReference({ book: 'Jude', chapter: 2, startVerse: 1, endVerse: 1 }), false);
  });

  it('0절이나 없는 절은 거절한다', () => {
    assert.equal(isValidBibleReference({ book: 'Psalms', chapter: 1, startVerse: 0, endVerse: 3 }), false);
    assert.equal(isValidBibleReference({ book: 'Psalms', chapter: 1, startVerse: 1, endVerse: 0 }), false);

    // 시편 117편은 2절까지다.
    assert.equal(getLastVerse('Psalms', 117), 2);
    assert.equal(isValidBibleReference({ book: 'Psalms', chapter: 117, startVerse: 1, endVerse: 2 }), true);
    assert.equal(isValidBibleReference({ book: 'Psalms', chapter: 117, startVerse: 1, endVerse: 3 }), false);
    assert.equal(isValidBibleReference({ book: 'Psalms', chapter: 117, startVerse: 3, endVerse: 3 }), false);
  });

  it('끝 절이 시작 절보다 앞서면 거절한다', () => {
    assert.equal(isValidBibleReference({ book: 'Psalms', chapter: 23, startVerse: 4, endVerse: 2 }), false);
  });

  it('소수, NaN, Infinity, 숫자가 아닌 값은 모두 거절한다', () => {
    const bad: unknown[] = [
      { book: 'Psalms', chapter: 1.5, startVerse: 1, endVerse: 2 },
      { book: 'Psalms', chapter: 1, startVerse: 1.2, endVerse: 2 },
      { book: 'Psalms', chapter: 1, startVerse: 1, endVerse: 2.7 },
      { book: 'Psalms', chapter: Number.NaN, startVerse: 1, endVerse: 2 },
      { book: 'Psalms', chapter: 1, startVerse: Number.NaN, endVerse: 2 },
      { book: 'Psalms', chapter: 1, startVerse: 1, endVerse: Number.NaN },
      { book: 'Psalms', chapter: Number.POSITIVE_INFINITY, startVerse: 1, endVerse: 2 },
      { book: 'Psalms', chapter: 1, startVerse: 1, endVerse: Number.POSITIVE_INFINITY },
      { book: 'Psalms', chapter: 1, startVerse: 1, endVerse: Number.NEGATIVE_INFINITY },
      { book: 'Psalms', chapter: Number.MAX_SAFE_INTEGER + 2, startVerse: 1, endVerse: 2 },
      { book: 'Psalms', chapter: '1', startVerse: 1, endVerse: 2 },
      { book: 'Psalms', chapter: 1, startVerse: null, endVerse: 2 },
      { book: 'Psalms', chapter: 1, startVerse: 1 },
      { book: 123, chapter: 1, startVerse: 1, endVerse: 2 },
      null,
      'Psalms 1:1',
      [],
      42,
    ];

    for (const reference of bad) {
      assert.equal(isValidBibleReference(reference), false, JSON.stringify(reference));
    }
  });

  it('한 위치가 장을 넘어가는 표현은 만들 수 없다', () => {
    // 시편 1편은 6절까지다. "1편 5절부터 2편 2절까지" 같은 표현은 절 번호로 나타낼 수 없고 거절된다.
    assert.equal(getLastVerse('Psalms', 1), 6);
    assert.equal(isValidBibleReference({ book: 'Psalms', chapter: 1, startVerse: 5, endVerse: 8 }), false);
  });
});

describe('Bible Reference · 여러 장에 걸친 본문', () => {
  it('전부 실제로 있으면 통과한다', () => {
    const outcome = checkBibleReferences([
      { book: '1John', chapter: 1, startVerse: 8, endVerse: 10 },
      { book: '1John', chapter: 2, startVerse: 1, endVerse: 2 },
    ]);
    assert.equal(outcome.valid, true, outcome.errors.join(' / '));
  });

  it('하나라도 없으면 전체가 거절된다', () => {
    const outcome = checkBibleReferences([
      { book: '1John', chapter: 1, startVerse: 8, endVerse: 10 },
      { book: '1John', chapter: 99, startVerse: 1, endVerse: 2 },
    ]);
    assert.equal(outcome.valid, false);
  });

  it('빈 목록이나 배열이 아닌 값은 거절한다', () => {
    assert.equal(checkBibleReferences([]).valid, false);
    assert.equal(checkBibleReferences(null).valid, false);
    assert.equal(checkBibleReferences({ book: 'Psalms' }).valid, false);
  });
});

describe('Bible Reference · 지금 쓰고 있는 Scripture Card', () => {
  it('카드 51개의 모든 본문 위치가 실제 성경에 있다', () => {
    assert.equal(SCRIPTURE_CARDS.length, 51);

    for (const card of SCRIPTURE_CARDS) {
      const single = checkBibleReference(card.passage, `${card.id}.passage`);
      assert.equal(single.valid, true, single.errors.join(' / '));

      const all = checkBibleReferences(getCardPassages(card), `${card.id}.passages`);
      assert.equal(all.valid, true, all.errors.join(' / '));
    }
  });
});
