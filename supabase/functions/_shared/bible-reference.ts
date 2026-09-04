/**
 * 성경 본문 위치(reference) 검증
 *
 * 하는 일: "이 책 이 장 이 절이 개역한글 성경에 실제로 있는가"를 결정적으로 확인한다.
 * 하지 않는 일: 본문 문장을 읽거나 돌려주지 않는다. 네트워크, DB, AI를 쓰지 않는다.
 *
 * 판단 근거는 bible-reference-index.ts 하나뿐이다.
 * 그 파일은 실제 성경 데이터에서 스크립트로 만든 것이며 사람이 장·절 수를 입력하지 않았다.
 *
 * 없는 책, 없는 장, 없는 절은 모두 거절한다(fail-closed).
 * AI가 후보라고 주장해도 여기에 없으면 쓰지 않는다.
 */

import { BIBLE_REFERENCE_INDEX } from './bible-reference-index.ts';

export type BibleReference = {
  book: string;
  chapter: number;
  startVerse: number;
  endVerse: number;
};

export type ReferenceCheck = { valid: boolean; errors: string[] };

/** 1 이상의 안전한 정수인가. 소수, NaN, Infinity, 숫자가 아닌 값은 모두 거절한다. */
function isPositiveSafeInteger(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value > 0
  );
}

/** 이 책이 성경 66권 안에 있는가. */
export function isBibleBook(book: unknown): book is string {
  return typeof book === 'string' && Object.hasOwn(BIBLE_REFERENCE_INDEX, book);
}

/** 이 책 이 장의 마지막 절 번호. 없으면 null. */
export function getLastVerse(book: string, chapter: number): number | null {
  if (!isBibleBook(book) || !isPositiveSafeInteger(chapter)) return null;
  const chapters = BIBLE_REFERENCE_INDEX[book];
  if (chapter > chapters.length) return null;
  return chapters[chapter - 1];
}

/**
 * 본문 위치 하나를 검증한다.
 *
 * 한 위치는 한 장 안에서만 끝나야 한다.
 * "1장 8절부터 2장 2절까지" 같은 표현은 만들지 않는다. 여러 장이면 위치를 여러 개 쓴다.
 */
export function checkBibleReference(reference: unknown, label = 'reference'): ReferenceCheck {
  const errors: string[] = [];

  if (typeof reference !== 'object' || reference === null || Array.isArray(reference)) {
    return { valid: false, errors: [`${label}: 본문 위치가 객체가 아닙니다.`] };
  }

  const value = reference as Record<string, unknown>;

  if (!isBibleBook(value.book)) {
    return { valid: false, errors: [`${label}: 성경에 없는 책입니다.`] };
  }

  if (!isPositiveSafeInteger(value.chapter)) {
    errors.push(`${label}: 장 번호가 1 이상의 정수가 아닙니다.`);
  }
  if (!isPositiveSafeInteger(value.startVerse)) {
    errors.push(`${label}: 시작 절이 1 이상의 정수가 아닙니다.`);
  }
  if (!isPositiveSafeInteger(value.endVerse)) {
    errors.push(`${label}: 끝 절이 1 이상의 정수가 아닙니다.`);
  }
  if (errors.length > 0) return { valid: false, errors };

  const chapter = value.chapter as number;
  const startVerse = value.startVerse as number;
  const endVerse = value.endVerse as number;

  if (endVerse < startVerse) {
    return { valid: false, errors: [`${label}: 끝 절이 시작 절보다 앞섭니다.`] };
  }

  const lastVerse = getLastVerse(value.book, chapter);
  if (lastVerse === null) {
    return { valid: false, errors: [`${label}: 이 책에 없는 장입니다.`] };
  }
  if (startVerse > lastVerse) {
    errors.push(`${label}: 이 장에 없는 시작 절입니다.`);
  }
  if (endVerse > lastVerse) {
    errors.push(`${label}: 이 장에 없는 끝 절입니다.`);
  }

  return { valid: errors.length === 0, errors };
}

/** 실제 성경에 있는 위치인지만 참/거짓으로 알려준다. */
export function isValidBibleReference(reference: unknown): boolean {
  return checkBibleReference(reference).valid;
}

/**
 * 여러 장에 걸친 본문을 검증한다.
 * 각 위치를 따로 본다. 하나라도 잘못되면 전체가 잘못된 것이다.
 */
export function checkBibleReferences(references: unknown, label = 'passages'): ReferenceCheck {
  if (!Array.isArray(references)) {
    return { valid: false, errors: [`${label}: 본문 위치 목록이 배열이 아닙니다.`] };
  }
  if (references.length === 0) {
    return { valid: false, errors: [`${label}: 본문 위치가 하나도 없습니다.`] };
  }

  const errors = references.flatMap(
    (reference, index) => checkBibleReference(reference, `${label}[${index}]`).errors,
  );

  return { valid: errors.length === 0, errors };
}

/**
 * 두 본문 위치가 실제로 겹치는가.
 *
 * 새 규칙을 만드는 것이 아니다. 이미 검증된 네 값(책·장·시작절·끝절)으로
 * 같은 책, 같은 장인지 보고 절 범위가 겹치는지만 계산한다.
 * 문자열을 해석하거나 책 이름을 바꾸어 맞추지 않는다.
 *
 * 두 값 중 하나라도 성경에 없는 위치면 겹치지 않는 것으로 본다.
 */
export function referencesOverlap(a: unknown, b: unknown): boolean {
  if (!isValidBibleReference(a) || !isValidBibleReference(b)) return false;

  const first = a as BibleReference;
  const second = b as BibleReference;

  if (first.book !== second.book) return false;
  if (first.chapter !== second.chapter) return false;

  // 한 위치는 한 장 안에서 끝나므로 절 범위만 비교하면 된다.
  return first.startVerse <= second.endVerse && second.startVerse <= first.endVerse;
}
