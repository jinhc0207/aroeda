/**
 * 한글 성경 참조 표기 · 테스트
 *
 * 실행: npm test
 *
 * 지키려는 것 다섯 가지.
 *
 *   1. 66권이 하나도 빠지거나 더해지지 않는다.
 *   2. 열쇠가 성경 데이터의 책 이름과 정확히 같다.
 *   3. 표기 규칙이 이미 있는 카드 열 장과 같다. 특히 대시 글자.
 *   4. 모르는 책 이름을 그대로 내보내지 않는다.
 *   5. 장을 넘어가는 본문은 붙어 있을 때만 한 줄로 줄인다.
 *
 * 이름을 여기 손으로 다시 적지 않는다.
 * 66권 목록은 실제 성경 데이터에서 가져와 대조한다.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  KOREAN_BIBLE_BOOK_NAMES,
  REFERENCE_RANGE_DASH,
  formatKoreanBibleReference,
  formatKoreanBibleReferenceSequence,
  koreanBibleBookName,
} from '../../supabase/functions/_shared/bible-reference-label.ts';
import {
  BIBLE_BOOK_IDS,
  BOOK_COUNT,
} from '../../supabase/functions/_shared/bible-reference-index.ts';
import { getLastVerse } from '../../supabase/functions/_shared/bible-reference.ts';
import { SCRIPTURE_CARDS } from '../../supabase/functions/_shared/scripture-cards.ts';

/* ================================================================== */
/* A. 66권                                                             */
/* ================================================================== */

describe('한글 성경 표기 · A. 66권', () => {
  it('성경 데이터가 아는 책이 66권이다', () => {
    assert.equal(BIBLE_BOOK_IDS.length, 66);
    assert.equal(BOOK_COUNT, 66);
  });

  it('표의 열쇠도 66개다', () => {
    assert.equal(Object.keys(KOREAN_BIBLE_BOOK_NAMES).length, 66);
  });

  it('표의 열쇠가 성경 데이터의 책 이름과 정확히 같다', () => {
    // 빠진 것도, 더 있는 것도, 철자가 다른 것도 여기서 걸린다.
    const mapped = [...Object.keys(KOREAN_BIBLE_BOOK_NAMES)].sort();
    const canonical = [...BIBLE_BOOK_IDS].sort();
    assert.deepEqual(mapped, canonical);
  });

  it('빠진 책이 없다', () => {
    const missing = BIBLE_BOOK_IDS.filter(
      (id) => !Object.hasOwn(KOREAN_BIBLE_BOOK_NAMES, id),
    );
    assert.deepEqual(missing, []);
  });

  it('성경에 없는 이름을 더해 두지 않았다', () => {
    const canonical = new Set(BIBLE_BOOK_IDS);
    const extra = Object.keys(KOREAN_BIBLE_BOOK_NAMES).filter((id) => !canonical.has(id));
    assert.deepEqual(extra, []);
  });

  it('모든 한글 이름이 비어 있지 않다', () => {
    for (const [id, name] of Object.entries(KOREAN_BIBLE_BOOK_NAMES)) {
      assert.equal(typeof name, 'string', id);
      assert.ok(name.trim().length > 0, id);
    }
  });

  it('같은 한글 이름이 두 책에 붙지 않았다', () => {
    // 실수로 복사하면 두 책이 같은 이름을 갖게 된다.
    const names = Object.values(KOREAN_BIBLE_BOOK_NAMES);
    assert.equal(new Set(names).size, names.length);
  });

  it('구약 대표 몇 권', () => {
    assert.equal(koreanBibleBookName('Genesis'), '창세기');
    assert.equal(koreanBibleBookName('Psalms'), '시편');
    assert.equal(koreanBibleBookName('SongofSolomon'), '아가');
    assert.equal(koreanBibleBookName('1Chronicles'), '역대상');
    assert.equal(koreanBibleBookName('2Chronicles'), '역대하');
    assert.equal(koreanBibleBookName('Malachi'), '말라기');
  });

  it('신약 대표 몇 권', () => {
    assert.equal(koreanBibleBookName('Matthew'), '마태복음');
    assert.equal(koreanBibleBookName('John'), '요한복음');
    assert.equal(koreanBibleBookName('1Corinthians'), '고린도전서');
    assert.equal(koreanBibleBookName('1John'), '요한일서');
    assert.equal(koreanBibleBookName('3John'), '요한삼서');
    assert.equal(koreanBibleBookName('Revelation'), '요한계시록');
  });

  it('상하권을 뒤바꾸지 않았다', () => {
    // 전/후, 상/하가 바뀌는 것은 눈에 잘 띄지 않는 실수다.
    assert.equal(koreanBibleBookName('1Samuel'), '사무엘상');
    assert.equal(koreanBibleBookName('2Samuel'), '사무엘하');
    assert.equal(koreanBibleBookName('1Kings'), '열왕기상');
    assert.equal(koreanBibleBookName('2Kings'), '열왕기하');
    assert.equal(koreanBibleBookName('1Thessalonians'), '데살로니가전서');
    assert.equal(koreanBibleBookName('2Thessalonians'), '데살로니가후서');
    assert.equal(koreanBibleBookName('1Peter'), '베드로전서');
    assert.equal(koreanBibleBookName('2Peter'), '베드로후서');
  });
});

/* ================================================================== */
/* B. 모르는 이름                                                       */
/* ================================================================== */

describe('한글 성경 표기 · B. 모르는 이름', () => {
  it('성경에 없는 책 이름은 null이다', () => {
    for (const bad of ['UnknownBook', 'psalms', 'Psalm', 'SongOfSolomon', '1 John', '']) {
      assert.equal(koreanBibleBookName(bad), null, bad);
    }
  });

  it('문자열이 아니면 null이다', () => {
    for (const bad of [null, undefined, 3, {}, [], true]) {
      assert.equal(koreanBibleBookName(bad), null, String(bad));
    }
  });

  it('모르는 책 이름을 그대로 내보내지 않는다', () => {
    // UnknownBook 3:1 같은 것이 화면에 나가면 안 된다.
    const label = formatKoreanBibleReference({
      book: 'UnknownBook',
      chapter: 3,
      startVerse: 1,
      endVerse: 1,
    });
    assert.equal(label, null);
  });

  it('물려받은 속성을 책 이름으로 인정하지 않는다', () => {
    // Object 에 있는 이름들이 우연히 통과하면 안 된다.
    for (const bad of ['toString', 'constructor', 'hasOwnProperty', '__proto__']) {
      assert.equal(koreanBibleBookName(bad), null, bad);
    }
  });
});

/* ================================================================== */
/* C. 표기 규칙                                                         */
/* ================================================================== */

describe('한글 성경 표기 · C. 규칙', () => {
  it('한 절이면 범위를 적지 않는다', () => {
    assert.equal(
      formatKoreanBibleReference({ book: 'Psalms', chapter: 56, startVerse: 3, endVerse: 3 }),
      '시편 56:3',
    );
  });

  it('여러 절이면 범위로 적는다', () => {
    assert.equal(
      formatKoreanBibleReference({ book: 'Psalms', chapter: 56, startVerse: 3, endVerse: 4 }),
      '시편 56:3–4',
    );
  });

  it('범위를 잇는 글자가 엔 대시다', () => {
    assert.equal(REFERENCE_RANGE_DASH, '–');
    assert.equal(REFERENCE_RANGE_DASH.codePointAt(0), 0x2013);
  });

  it('보통 하이픈을 쓰지 않는다', () => {
    // 눈으로는 거의 같지만 다른 글자다. 섞이면 같은 본문이 두 표기를 갖는다.
    const label = formatKoreanBibleReference({
      book: 'Psalms',
      chapter: 56,
      startVerse: 3,
      endVerse: 4,
    }) as string;

    assert.ok(label.includes('–'));
    assert.equal(label.includes('-'), false);
    assert.equal(label.includes('—'), false);
  });

  it('책 이름과 장 사이는 보통 빈칸 하나다', () => {
    const label = formatKoreanBibleReference({
      book: 'Psalms',
      chapter: 56,
      startVerse: 3,
      endVerse: 4,
    }) as string;

    assert.equal(label.startsWith('시편 56'), true);
    assert.equal(label.charCodeAt('시편'.length), 0x20);
  });

  it('장과 절 사이는 콜론이다', () => {
    const label = formatKoreanBibleReference({
      book: 'Psalms',
      chapter: 56,
      startVerse: 3,
      endVerse: 4,
    }) as string;
    assert.ok(label.includes(':'));
  });

  it('실제로 없는 위치는 만들어 주지 않는다', () => {
    const lastPsalm56 = getLastVerse('Psalms', 56) as number;

    const cases: unknown[] = [
      // 없는 장
      { book: 'Psalms', chapter: 999, startVerse: 1, endVerse: 1 },
      // 그 장에 없는 절
      { book: 'Psalms', chapter: 56, startVerse: 1, endVerse: lastPsalm56 + 1 },
      // 거꾸로 된 범위
      { book: 'Psalms', chapter: 56, startVerse: 4, endVerse: 3 },
      // 0절
      { book: 'Psalms', chapter: 56, startVerse: 0, endVerse: 1 },
      // 모양이 아예 다름
      '시편 56:3',
      null,
      undefined,
      { book: 'Psalms', chapter: 56 },
    ];

    for (const bad of cases) {
      assert.equal(formatKoreanBibleReference(bad), null, JSON.stringify(bad));
    }
  });
});

/* ================================================================== */
/* D. 이미 있는 카드와 같은가                                           */
/* ================================================================== */

describe('한글 성경 표기 · D. 기존 카드', () => {
  /** 한 장 안에서 끝나는 카드는 위치 하나로 그대로 만들 수 있어야 한다. */
  const singleChapterCards = SCRIPTURE_CARDS.filter(
    (card) => !card.passages || card.passages.length <= 1,
  );

  it('한 장짜리 카드가 여러 장 있다', () => {
    assert.ok(singleChapterCards.length >= 8);
  });

  it('손으로 적은 표기와 계산한 표기가 같다', () => {
    // 하나라도 다르면 지금까지 적어 둔 것 중에 틀린 것이 있다는 뜻이다.
    for (const card of singleChapterCards) {
      assert.equal(
        formatKoreanBibleReference(card.passage),
        card.referenceLabel,
        `${card.id} / ${card.referenceLabel}`,
      );
    }
  });

  it('여러 장에 걸친 카드도 같다', () => {
    const multi = SCRIPTURE_CARDS.filter((card) => card.passages && card.passages.length > 1);
    assert.ok(multi.length >= 1);

    for (const card of multi) {
      const all = card.passages as typeof card.passage[];
      // 카드의 passages 는 첫 범위까지 포함한다. 덧붙인 것만 따로 넘긴다.
      const [first, ...rest] = all;
      assert.equal(
        formatKoreanBibleReferenceSequence(first, rest),
        card.referenceLabel,
        `${card.id} / ${card.referenceLabel}`,
      );
    }
  });

  it('카드 열 장 모두 계산으로 되살릴 수 있다', () => {
    for (const card of SCRIPTURE_CARDS) {
      const rest = card.passages ? card.passages.slice(1) : [];
      assert.equal(
        formatKoreanBibleReferenceSequence(card.passage, rest),
        card.referenceLabel,
        card.id,
      );
    }
  });
});

/* ================================================================== */
/* E. 장을 넘어가는 본문                                                */
/* ================================================================== */

describe('한글 성경 표기 · E. 장을 넘어감', () => {
  const first = { book: '1John', chapter: 1, startVerse: 8, endVerse: 10 };
  const second = { book: '1John', chapter: 2, startVerse: 1, endVerse: 2 };

  it('붙어 있으면 한 줄로 줄인다', () => {
    assert.equal(formatKoreanBibleReferenceSequence(first, [second]), '요한일서 1:8–2:2');
  });

  it('붙어 있다는 근거가 실제 성경 데이터에 있다', () => {
    // 앞이 그 장 마지막 절에서 끝나야 붙어 있는 것이다. 지어낸 규칙이 아니다.
    assert.equal(getLastVerse('1John', 1), first.endVerse);
    assert.equal(second.chapter, first.chapter + 1);
    assert.equal(second.startVerse, 1);
  });

  it('덧붙인 곳이 없으면 위치 하나짜리와 같다', () => {
    const single = { book: 'Psalms', chapter: 56, startVerse: 3, endVerse: 4 };
    assert.equal(
      formatKoreanBibleReferenceSequence(single, []),
      formatKoreanBibleReference(single),
    );
  });

  it('앞이 장 끝까지 가지 않으면 줄이지 않는다', () => {
    // 1장 8–9절이면 10절이 빠진다. 그 사이를 건너뛴 표기를 만들지 않는다.
    const short = { book: '1John', chapter: 1, startVerse: 8, endVerse: 9 };
    assert.equal(formatKoreanBibleReferenceSequence(short, [second]), null);
  });

  it('다음이 1절에서 시작하지 않으면 줄이지 않는다', () => {
    const notFromStart = { book: '1John', chapter: 2, startVerse: 2, endVerse: 3 };
    assert.equal(formatKoreanBibleReferenceSequence(first, [notFromStart]), null);
  });

  it('장이 이어지지 않으면 줄이지 않는다', () => {
    const skipped = { book: '1John', chapter: 3, startVerse: 1, endVerse: 2 };
    assert.equal(formatKoreanBibleReferenceSequence(first, [skipped]), null);
  });

  it('다른 책으로 넘어가면 줄이지 않는다', () => {
    // 장 번호만 보면 이어지는 것처럼 보이는 경우를 고른다.
    // 요한복음 2장은 실제로 있고 1절에서 시작하므로,
    // 책을 확인하지 않으면 요한일서 1:8–2:2 라는 엉뚱한 표기가 나온다.
    const otherBook = { book: 'John', chapter: 2, startVerse: 1, endVerse: 2 };
    assert.equal(otherBook.chapter, first.chapter + 1);
    assert.equal(getLastVerse('1John', first.chapter), first.endVerse);

    assert.equal(formatKoreanBibleReferenceSequence(first, [otherBook]), null);
  });

  it('떨어져 있는 곳을 잇는 표기를 지어내지 않는다', () => {
    // 쉼표나 세미콜론 형식을 여기서 새로 만들지 않는다. 정해진 적이 없다.
    const apart = { book: 'Psalms', chapter: 100, startVerse: 1, endVerse: 2 };
    const far = { book: 'Psalms', chapter: 103, startVerse: 1, endVerse: 2 };
    const label = formatKoreanBibleReferenceSequence(apart, [far]);

    assert.equal(label, null);
  });

  it('덧붙인 것이 목록이 아니면 null이다', () => {
    for (const bad of [null, undefined, 'x', {}, 3]) {
      assert.equal(formatKoreanBibleReferenceSequence(first, bad), null, String(bad));
    }
  });

  it('덧붙인 것 중 하나라도 잘못되면 null이다', () => {
    assert.equal(
      formatKoreanBibleReferenceSequence(first, [{ book: '1John', chapter: 2 }]),
      null,
    );
  });

  it('세 장에 걸쳐도 붙어 있으면 줄인다', () => {
    const a = { book: '1John', chapter: 1, startVerse: 1, endVerse: getLastVerse('1John', 1) };
    const b = { book: '1John', chapter: 2, startVerse: 1, endVerse: getLastVerse('1John', 2) };
    const c = { book: '1John', chapter: 3, startVerse: 1, endVerse: 3 };

    assert.equal(formatKoreanBibleReferenceSequence(a, [b, c]), '요한일서 1:1–3:3');
  });
});

/* ================================================================== */
/* F. 이 파일이 하지 않는 일                                            */
/* ================================================================== */

describe('한글 성경 표기 · F. 경계', () => {
  it('검토 대상 글이나 모델을 알지 못한다', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(
      new URL('../../supabase/functions/_shared/bible-reference-label.ts', import.meta.url),
      'utf8',
    );

    for (const banned of [
      'PublishedContentCandidate',
      'candidateHash',
      'researchResultHash',
      'userExplanation',
      'prayerDirection',
      'store_published_content_candidate',
      'OpenAI',
      'openai',
      'Deno.env',
      'process.env',
      'fetch(',
      'createClient',
      'Date.now',
      'randomUUID',
    ]) {
      assert.equal(source.includes(banned), false, banned);
    }
  });

  it('부를 때마다 같은 답을 낸다', () => {
    const passage = { book: 'Psalms', chapter: 56, startVerse: 3, endVerse: 4 };
    assert.equal(formatKoreanBibleReference(passage), formatKoreanBibleReference(passage));
  });
});
