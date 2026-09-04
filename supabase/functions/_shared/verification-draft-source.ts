/**
 * 자료 한 건의 규칙 · 한 곳에만 둔다 (순수 로직)
 *
 * 왜 만드는가:
 *   같은 자료 한 건을 두 곳에서 각각 검사하고 있었다.
 *     2단계 응답 검사(validateHarvestDraft)
 *     이어서 할 표에 담을 값 검사(checkDraftSource)
 *
 *   두 검사의 기준이 달랐다. 뒤쪽이 더 엄격했다.
 *   그래서 2단계는 통과했는데 표에는 담을 수 없는 초안이 생겼고,
 *   production에서 "표를 만들지 못했다"로 끝났다.
 *   실제 원인은 DB도 시간 초과도 아니라 자료 한 건의 규칙 차이였다.
 *
 *   느슨한 쪽에 맞추지 않는다. 엄격한 쪽 규칙을 두 곳이 함께 본다.
 *
 * 이 파일이 하는 일:
 *   자료 한 건이 규칙을 지켰는지 판단한다.
 *
 * 이 파일이 하지 않는 일:
 *   자료를 고치지 않는다.
 *   길이를 자르거나, 연도를 바꾸거나, 용도를 지우거나, 종류를 바꾸지 않는다.
 *   모델이 쓴 값을 서버가 임의로 보정하는 길을 만들지 않는다.
 *
 *   여러 자료 사이의 규칙(같은 주소가 두 번인가, 발견 목록 안인가)은 여기서 보지 않는다.
 *   그것은 부르는 쪽이 각자 자기 맥락에서 본다.
 *
 * 목록과 숫자는 새로 적지 않는다. 전부 기존 계약에서 가져온다.
 */

import {
  ACCESS_LEVELS,
  EVIDENCE_CLAIM_MAX,
  EVIDENCE_CLAIM_MIN,
  EVIDENCE_DRAFT_FIELDS,
  EVIDENCE_PASSAGE_MAX,
  EVIDENCE_STATEMENT_MAX,
  EVIDENCE_STATEMENT_MIN,
  HARVESTABLE_SOURCE_TYPES,
  INTENDED_USES,
  PUBLICATION_YEAR_MAX,
  PUBLICATION_YEAR_MIN,
  RELEVANCE_NOTE_MAX,
  VERIFICATION_DRAFT_SOURCE_FIELDS,
  type VerificationDraftSource,
} from './source-harvest-contract.ts';
import { checkBibleReference } from './bible-reference.ts';
import { isSourceTypeAllowedForUse } from './research-source.ts';
import { normalizeSourceUrl } from './source-harvester.ts';

/**
 * 자료 한 건이 규칙을 어긴 까닭.
 *
 * 고정된 이름뿐이다. 제목·저자·발행처·주소 같은 실제 값은 담지 않는다.
 * 기록에 남기더라도 자료 내용이 새지 않게 하기 위해서다.
 */
export const DRAFT_SOURCE_ISSUES = [
  'not_an_object',
  'unknown_field',
  'missing_field',
  'source_type_invalid',
  'title_empty',
  'author_empty',
  'publisher_empty',
  'publication_year_invalid',
  'url_unacceptable',
  'access_level_invalid',
  'intended_use_empty',
  'intended_use_invalid',
  'intended_use_duplicated',
  'intended_use_incompatible',
  'relevance_note_empty',
  'relevance_note_too_long',
  // 연구 근거 쪽
  'evidence_not_array',
  'evidence_count_invalid',
  'evidence_not_an_object',
  'evidence_unknown_field',
  'evidence_missing_field',
  'evidence_use_invalid',
  'evidence_use_not_in_source',
  'evidence_statement_too_short',
  'evidence_statement_too_long',
  'evidence_passages_invalid',
  'evidence_passages_too_many',
  'evidence_passages_duplicated',
  'evidence_exegesis_needs_passage',
] as const;
export type DraftSourceIssue = (typeof DRAFT_SOURCE_ISSUES)[number];

const harvestableTypes = new Set<string>(HARVESTABLE_SOURCE_TYPES);
const accessLevels = new Set<string>(ACCESS_LEVELS);
const intendedUses = new Set<string>(INTENDED_USES);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

/**
 * 자료 한 건을 검사한다.
 *
 * 어긴 것을 모두 모아 돌려준다. 첫 번째에서 멈추지 않는다.
 * 어느 한 곳이라도 어기면 그 자료는 쓰지 않는다(fail-closed).
 */
export function checkVerificationDraftSource(entry: unknown): DraftSourceIssue[] {
  if (!isRecord(entry)) return ['not_an_object'];

  const issues: DraftSourceIssue[] = [];

  for (const key of Object.keys(entry)) {
    if (!(VERIFICATION_DRAFT_SOURCE_FIELDS as readonly string[]).includes(key)) {
      issues.push('unknown_field');
      break;
    }
  }
  for (const key of VERIFICATION_DRAFT_SOURCE_FIELDS) {
    if (!(key in entry)) {
      issues.push('missing_field');
      break;
    }
  }

  const sourceType = entry.sourceType;
  if (typeof sourceType !== 'string' || !harvestableTypes.has(sourceType)) {
    issues.push('source_type_invalid');
  }

  if (!isNonEmptyString(entry.title)) issues.push('title_empty');
  if (!isNonEmptyString(entry.authorOrOrganization)) issues.push('author_empty');
  if (!isNonEmptyString(entry.publisherOrInstitution)) issues.push('publisher_empty');

  // 확인하지 못했으면 null이다. 그 밖에는 실제로 있을 수 있는 연도여야 한다.
  if (
    entry.publicationYear !== null &&
    (typeof entry.publicationYear !== 'number' ||
      !Number.isSafeInteger(entry.publicationYear) ||
      entry.publicationYear < PUBLICATION_YEAR_MIN ||
      entry.publicationYear > PUBLICATION_YEAR_MAX)
  ) {
    issues.push('publication_year_invalid');
  }

  // 주소를 정리하는 규칙은 새로 만들지 않는다.
  // 이미 정리된 모양일 것을 요구하지도 않는다. 받을 수 있는 주소인지만 본다.
  if (normalizeSourceUrl(entry.url) === null) issues.push('url_unacceptable');

  if (typeof entry.accessLevel !== 'string' || !accessLevels.has(entry.accessLevel)) {
    issues.push('access_level_invalid');
  }

  if (!Array.isArray(entry.intendedUse) || entry.intendedUse.length === 0) {
    issues.push('intended_use_empty');
  } else if (!entry.intendedUse.every((use) => typeof use === 'string')) {
    issues.push('intended_use_invalid');
  } else {
    const uses = entry.intendedUse as string[];
    if (new Set(uses).size !== uses.length) issues.push('intended_use_duplicated');

    for (const use of uses) {
      if (!intendedUses.has(use)) {
        if (!issues.includes('intended_use_invalid')) issues.push('intended_use_invalid');
        continue;
      }
      // 어떤 종류의 자료를 어떤 용도로 쓸 수 있는지는 research-source.ts 한 곳에만 있다.
      if (typeof sourceType === 'string' && harvestableTypes.has(sourceType)) {
        if (!isSourceTypeAllowedForUse(sourceType, use)) {
          if (!issues.includes('intended_use_incompatible')) {
            issues.push('intended_use_incompatible');
          }
        }
      }
    }
  }

  if (!isNonEmptyString(entry.relevanceNote)) {
    issues.push('relevance_note_empty');
  } else if ((entry.relevanceNote as string).length > RELEVANCE_NOTE_MAX) {
    // 왜 이 자료가 필요한지 적는 짧은 메모다. 자료 내용을 옮겨 적는 자리가 아니다.
    issues.push('relevance_note_too_long');
  }

  checkEvidenceClaims(entry.evidenceClaims, entry.intendedUse, issues);

  return issues;
}

/**
 * 연구 근거 목록을 본다.
 *
 * 여기서 보는 것은 모양과 경계뿐이다.
 * 문장이 원문의 뜻을 옳게 옮겼는지는 서버가 알 수 없다. 그것은 보증하지 않는다.
 *
 * 대신 다음은 확실히 막는다.
 *   - 그 자료가 갖지 않은 용도로 근거를 다는 것
 *   - 너무 짧거나 긴 문장
 *   - 성경에 없는 본문 위치
 *   - 주해 근거인데 어느 본문을 다루는지 밝히지 않는 것
 */
function checkEvidenceClaims(
  value: unknown,
  sourceUses: unknown,
  issues: DraftSourceIssue[],
): void {
  if (!Array.isArray(value)) {
    issues.push('evidence_not_array');
    return;
  }
  if (value.length < EVIDENCE_CLAIM_MIN || value.length > EVIDENCE_CLAIM_MAX) {
    issues.push('evidence_count_invalid');
  }

  // 자료가 실제로 가진 용도. 근거는 이 밖으로 나갈 수 없다.
  const allowedUses = new Set<string>(
    Array.isArray(sourceUses) ? sourceUses.filter((use): use is string => typeof use === 'string') : [],
  );

  const push = (issue: DraftSourceIssue) => {
    if (!issues.includes(issue)) issues.push(issue);
  };

  for (const claim of value) {
    if (!isRecord(claim)) {
      push('evidence_not_an_object');
      continue;
    }

    for (const key of Object.keys(claim)) {
      if (!(EVIDENCE_DRAFT_FIELDS as readonly string[]).includes(key)) {
        push('evidence_unknown_field');
        break;
      }
    }
    for (const key of EVIDENCE_DRAFT_FIELDS) {
      if (!(key in claim)) {
        push('evidence_missing_field');
        break;
      }
    }

    const use = claim.intendedUse;
    if (typeof use !== 'string' || !intendedUses.has(use)) {
      push('evidence_use_invalid');
    } else if (!allowedUses.has(use)) {
      // 자료 정책을 근거로 우회하지 못하게 한다.
      push('evidence_use_not_in_source');
    }

    if (typeof claim.statement !== 'string' || claim.statement.trim().length < EVIDENCE_STATEMENT_MIN) {
      push('evidence_statement_too_short');
    } else if (claim.statement.length > EVIDENCE_STATEMENT_MAX) {
      push('evidence_statement_too_long');
    }

    const references = claim.passageReferences;
    if (!Array.isArray(references)) {
      push('evidence_passages_invalid');
      continue;
    }
    if (references.length > EVIDENCE_PASSAGE_MAX) push('evidence_passages_too_many');

    const seen = new Set<string>();
    for (const reference of references) {
      // 본문 위치 규칙은 새로 적지 않는다. 이미 있는 것을 그대로 쓴다.
      if (!checkBibleReference(reference).valid) {
        push('evidence_passages_invalid');
        continue;
      }
      const key = JSON.stringify([
        (reference as Record<string, unknown>).book,
        (reference as Record<string, unknown>).chapter,
        (reference as Record<string, unknown>).startVerse,
        (reference as Record<string, unknown>).endVerse,
      ]);
      if (seen.has(key)) push('evidence_passages_duplicated');
      seen.add(key);
    }

    // 주해 근거라면 어느 본문을 두고 하는 말인지 밝혀야 한다.
    if (use === 'exegesis' && references.length === 0) {
      push('evidence_exegesis_needs_passage');
    }
  }
}

/** 자료 한 건이 규칙을 모두 지켰는가. */
export function isValidVerificationDraftSource(
  entry: unknown,
): entry is VerificationDraftSource {
  return checkVerificationDraftSource(entry).length === 0;
}
