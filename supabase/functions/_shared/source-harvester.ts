/**
 * Source Harvester v1 (순수 로직)
 *
 * 하는 일: 수집 의뢰서를 만들고, 돌아온 자료 목록이 근거로 쓸 수 있는 것인지 확인한다.
 * 하지 않는 일: 실제 웹 검색, 페이지 접속, 성경 해석, 카드 작성, DB 접근, AI 호출.
 *
 * 이 파일은 주소를 열어 보지 않는다. 주소의 모양만 본다.
 *
 * 개인정보: 사용자 문장, 사용자 id, 세션·기기 정보, Prioritizer의 점수·이유·확신은
 *          이 경로 어디에도 들어오지 않는다.
 */

import {
  ACCEPTED_MAX,
  ACCEPTED_MIN,
  ACCESS_LEVELS,
  HARVESTABLE_SOURCE_TYPES,
  INTENDED_USES,
  PUBLICATION_YEAR_MAX,
  PUBLICATION_YEAR_MIN,
  PUBLISHER_MIN,
  FINAL_REJECTED_SOURCE_MAX,
  REJECTED_SOURCE_MAX,
  RELEVANCE_NOTE_MAX,
  SERVER_ONLY_REJECTION_REASONS,
  SERVER_REJECTED_SOURCE_MAX,
  SCHOLARLY_CORE_MIN,
  SCHOLARLY_CORE_TYPES,
  EVIDENCE_CLAIM_MAX,
  EVIDENCE_CLAIM_MIN,
  EVIDENCE_DRAFT_FIELDS,
  SOURCE_HARVEST_SCHEMA,
  SOURCE_REJECTION_REASONS,
  type HarvestEvidenceDraft,
  type HarvestableSourceType,
  type SourceRejectionReason,
} from './source-harvest-contract.ts';
import {
  InvalidResearchBriefError,
  buildResearchBrief,
  type BiblicalResearchBrief,
} from './biblical-researcher.ts';
import {
  RESEARCH_SOURCE_FIELDS,
  isSourceTypeAllowedForUse,
  type ResearchSource,
} from './research-source.ts';

export { SOURCE_HARVEST_SCHEMA, InvalidResearchBriefError };

/**
 * 수집 의뢰서.
 * Biblical Researcher의 연구 의뢰서와 같은 구조를 쓴다. 따로 만들지 않는다.
 */
export type SourceHarvestBrief = BiblicalResearchBrief;

/**
 * 채택된 자료 한 건.
 *
 * 연구 단계에서 쓰는 ResearchSource에 수집 단계에서만 필요한 메모 하나를 더한 것이다.
 * 자료의 역할 정보(sourceType, intendedUse, accessLevel)는 ResearchSource 안에 있으므로
 * 연구 단계로 넘어갈 때 사라지지 않는다.
 */
/**
 * 서버가 번호를 붙인 연구 근거 한 조각.
 *
 * 번호는 서버가 만든다. 모델은 만들 수도, 고를 수도 없다.
 * 문장 자체는 모델이 쓴 것을 그대로 둔다. 서버가 다시 쓰지 않는다.
 */
export type HarvestEvidence = HarvestEvidenceDraft & {
  evidenceId: string;
};

export type HarvestedSource = ResearchSource & {
  sourceType: HarvestableSourceType;
  /** 왜 이 자료가 이 연구에 필요한가. 자료 내용을 요약하는 자리가 아니다. */
  relevanceNote: string;
  /**
   * 실제로 연 페이지에서 관찰한 것을 짧게 적은 연구 근거.
   *
   * 이것은 서버가 원문과 대조해 확인한 인용이 아니다. 모델이 진술한 관찰이다.
   * 서버가 보증하는 것은 "이 자료를 실제로 열었다"와 "모양이 규칙을 지켰다"까지다.
   */
  evidenceClaims: HarvestEvidence[];
};

export type RejectedSource = {
  url: string;
  /** 확인하지 못하면 null */
  title: string | null;
  rejectionReason: SourceRejectionReason;
};

export type SourceHarvestResult = {
  targetDomain: string;
  evidenceVersion: number;
  prioritizerSnapshotId: string;
  sources: HarvestedSource[];
  rejectedSources: RejectedSource[];
  unresolvedSourceQuestions: string[];
};

export type ValidationResult = { valid: boolean; errors: string[] };

/**
 * 수집 의뢰서를 만든다.
 * 허용되는 대상 영역, 거절 규칙, 활성 영역 정리는 모두 연구 의뢰서와 같은 helper를 쓴다.
 */
export function buildSourceHarvestBrief(input: {
  targetDomain: string;
  evidenceVersion: number;
  prioritizerSnapshotId: string;
  activeCoveredDomains: readonly string[];
}): SourceHarvestBrief {
  return buildResearchBrief(input);
}

/* ------------------------------------------------------------------ */
/* 주소 검증                                                            */
/* ------------------------------------------------------------------ */

/**
 * 주소의 뜻과 상관없이 붙는 추적용 값들. 같은 자료를 다른 주소로 보이게 만든다.
 *
 * 여기에는 광고·메일 추적용으로만 쓰이는, 뜻이 분명한 이름만 넣는다.
 * source, ref, ref_src 같은 흔한 이름은 넣지 않는다.
 * 사이트에 따라 그 값이 실제로 다른 자료를 가리킬 수 있기 때문이다.
 *
 * 지켜야 하는 원칙: 뜻이 다른 두 주소를 같은 주소로 합치지 않는다.
 */
const TRACKING_PARAMS = new Set([
  'gclid',
  'fbclid',
  'igshid',
  'mc_cid',
  'mc_eid',
  'msclkid',
  'yclid',
]);

const TRACKING_PREFIXES = ['utm_'];

const IPV4 = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

function isDisallowedHost(hostname: string): boolean {
  // IPv6는 URL에서 대괄호로 감싸여 온다. 주소를 직접 가리키는 자료는 받지 않는다.
  if (hostname.startsWith('[')) return true;

  // 숫자 주소(IPv4)는 사설·내부 주소인지 구분하기 어려우므로 전부 받지 않는다.
  if (IPV4.test(hostname)) return true;

  if (hostname === 'localhost') return true;
  if (hostname.endsWith('.localhost')) return true;
  if (hostname.endsWith('.local')) return true;
  if (hostname.endsWith('.internal')) return true;

  // 점이 없는 이름은 내부망 이름일 가능성이 높다.
  if (!hostname.includes('.')) return true;

  return false;
}

/**
 * 주소를 하나의 기준 모양으로 정리한다.
 *
 * 같은 자료를 가리키는 주소는 같은 결과가 나와야 한다.
 * 단 주소의 뜻이 바뀔 정도로 고치지 않는다. (경로의 대소문자는 그대로 둔다)
 *
 * 받을 수 없는 주소면 null을 돌려준다. 이 함수는 주소에 접속하지 않는다.
 */
export function normalizeSourceUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;

  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  // https만 받는다. javascript:, data:, file:, ftp:, http는 모두 거절한다.
  if (url.protocol !== 'https:') return null;

  // 주소 안에 아이디·비밀번호가 들어 있으면 받지 않는다.
  if (url.username.length > 0 || url.password.length > 0) return null;

  // 기본 포트(443)가 아니면 받지 않는다.
  if (url.port.length > 0 && url.port !== '443') return null;

  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if (hostname.length === 0 || isDisallowedHost(hostname)) return null;

  // 표시 위치(#뒤)는 자료를 구분하지 않는다.
  const params = new URLSearchParams(url.search);
  for (const key of [...params.keys()]) {
    const lower = key.toLowerCase();
    if (TRACKING_PARAMS.has(lower) || TRACKING_PREFIXES.some((prefix) => lower.startsWith(prefix))) {
      params.delete(key);
    }
  }

  // 남은 값의 순서는 원래 순서 그대로 둔다. 정렬하지 않는다.
  // 같은 이름이 여러 번 나올 때 그 순서가 사이트에 따라 뜻을 가질 수 있기 때문이다.
  //
  // 직접 `이름=값`으로 이어 붙이지도 않는다.
  // 값 안에 &나 = 같은 글자가 들어 있으면 주소의 뜻이 바뀌기 때문이다.
  // 표준 방식으로 다시 만들어 그런 글자가 반드시 부호로 바뀌게 한다.
  const canonicalParams = new URLSearchParams();
  for (const [key, item] of params.entries()) {
    canonicalParams.append(key, item);
  }
  const query = canonicalParams.toString();

  // 경로는 고치지 않는다.
  // 맨 끝의 /를 떼면 /article//이 정리할 때마다 달라지고,
  // /article과 /article/이 서로 다른 자료일 수도 있는데 억지로 합치게 된다.
  // 다만 아무 경로가 없는 / 하나는 없는 것과 같으므로 비운다.
  const path = url.pathname === '/' ? '' : url.pathname;

  return `https://${hostname}${path}${query.length > 0 ? `?${query}` : ''}`;
}

/** 주소가 받을 수 있는 모양인지 참/거짓으로 알려준다. */
export function isValidSourceUrl(raw: unknown): boolean {
  return normalizeSourceUrl(raw) !== null;
}

/**
 * 정리된 주소에서 자료 id를 만든다.
 * 같은 자료를 가리키면 항상 같은 id가 나온다. AI가 임의로 지어낼 수 없다.
 */
export async function computeSourceId(rawUrl: unknown): Promise<string | null> {
  const canonical = normalizeSourceUrl(rawUrl);
  if (canonical === null) return null;

  const bytes = new TextEncoder().encode(canonical);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');

  return `src_${hex}`;
}

/* ------------------------------------------------------------------ */
/* 결과 검증                                                            */
/* ------------------------------------------------------------------ */

const TOP_LEVEL_FIELDS = [
  'targetDomain',
  'evidenceVersion',
  'prioritizerSnapshotId',
  'sources',
  'rejectedSources',
  'unresolvedSourceQuestions',
] as const;

const SOURCE_FIELDS = [...RESEARCH_SOURCE_FIELDS, 'relevanceNote', 'evidenceClaims'] as const;

/** 최종 결과의 근거 한 조각이 가질 수 있는 항목. 초안의 셋 + 서버가 붙인 번호. */
const EVIDENCE_FIELDS = [...EVIDENCE_DRAFT_FIELDS, 'evidenceId'] as const;

const REJECTED_FIELDS = ['url', 'title', 'rejectionReason'] as const;

/**
 * 결과에 절대 있으면 안 되는 항목 이름 (어느 깊이에 있든).
 *
 * 앞쪽은 웹페이지 내용·인용문을 저장하려는 시도,
 * 뒤쪽은 사용자 정보와 Prioritizer의 판단 근거가 흘러드는 것을 막는다.
 */
const BANNED_FIELD_NAMES = [
  'rawhtml',
  'html',
  'pagecontent',
  'content',
  'body',
  'snippet',
  'summary',
  'excerpt',
  'quote',
  'quotes',
  'quotation',
  'fulltext',
  'text',
  'scripture',
  'prayer',
  'card',
  'situation',
  'rawsituation',
  'userid',
  'user_id',
  'uid',
  'sessionid',
  'deviceid',
  'jwt',
  'token',
  'reason',
  'score',
  'confidence',
  'rank',
];

const harvestableTypes = new Set<string>(HARVESTABLE_SOURCE_TYPES);
// 서버 전용 사유 목록은 canonical 정의를 그대로 쓴다. 여기서 다시 적지 않는다.
const serverOnlyReasons = new Set<string>(SERVER_ONLY_REJECTION_REASONS);
const scholarlyCore = new Set<string>(SCHOLARLY_CORE_TYPES);

/**
 * 학술적 핵심 자료인가.
 * 검증과 집계가 같은 기준을 쓰도록 이 함수 하나만 본다.
 */
export function isScholarlyCoreType(sourceType: unknown): boolean {
  return typeof sourceType === 'string' && scholarlyCore.has(sourceType);
}

/**
 * 발행처 이름을 비교용으로 정리한다.
 * 앞뒤 공백을 없애고 대소문자를 맞춘다. 이름이 비어 있으면 null.
 * 검증과 집계가 같은 기준으로 "서로 다른 발행처"를 센다.
 */
export function normalizePublisherName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

/** 자료 목록에 서로 다른 발행처가 몇 곳인가. */
export function countPublisherDiversity(
  sources: readonly { publisherOrInstitution?: unknown }[],
): number {
  const publishers = new Set<string>();
  for (const source of sources) {
    const name = normalizePublisherName(source?.publisherOrInstitution);
    if (name !== null) publishers.add(name);
  }
  return publishers.size;
}
const intendedUses = new Set<string>(INTENDED_USES);
const accessLevels = new Set<string>(ACCESS_LEVELS);
const rejectionReasons = new Set<string>(SOURCE_REJECTION_REASONS);

const isNonEmptyString = (value: unknown) => typeof value === 'string' && value.trim().length > 0;

const isStringArray = (value: unknown) =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

/** YYYY-MM-DD 이고 실제로 있는 날짜인지 본다. */
function isIsoDate(value: unknown): boolean {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** 어느 깊이에 있든 금지된 항목 이름이 있으면 잡아낸다. */
function scanBannedFields(value: unknown, errors: string[], path = ''): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanBannedFields(item, errors, `${path}[${index}]`));
    return;
  }
  if (typeof value !== 'object' || value === null) return;

  for (const [key, child] of Object.entries(value)) {
    if (BANNED_FIELD_NAMES.includes(key.toLowerCase())) {
      errors.push(`허용되지 않는 항목이 있습니다: ${path}${path ? '.' : ''}${key}`);
    }
    scanBannedFields(child, errors, `${path}${path ? '.' : ''}${key}`);
  }
}

/**
 * 수집 결과가 규칙을 지켰는지 확인한다.
 * 하나라도 어기면 결과 전체를 쓰지 않는다(fail-closed).
 */
export async function validateSourceHarvestResult(
  result: unknown,
  brief: SourceHarvestBrief,
): Promise<ValidationResult> {
  const errors: string[] = [];

  if (typeof result !== 'object' || result === null || Array.isArray(result)) {
    return { valid: false, errors: ['수집 결과가 객체가 아닙니다.'] };
  }

  const value = result as Record<string, unknown>;

  for (const key of Object.keys(value)) {
    if (!(TOP_LEVEL_FIELDS as readonly string[]).includes(key)) {
      errors.push(`허용되지 않는 최상위 항목이 있습니다 (${key})`);
    }
  }
  for (const key of TOP_LEVEL_FIELDS) {
    if (!(key in value)) errors.push(`필수 항목이 없습니다 (${key})`);
  }

  scanBannedFields(value, errors);

  if (value.targetDomain !== brief.targetDomain) {
    errors.push('targetDomain이 의뢰서와 다릅니다.');
  }
  if (value.evidenceVersion !== brief.evidenceVersion) {
    errors.push('evidenceVersion이 의뢰서와 다릅니다.');
  }
  if (value.prioritizerSnapshotId !== brief.prioritizerSnapshotId) {
    errors.push('prioritizerSnapshotId가 의뢰서와 다릅니다.');
  }

  // 채택 자료
  const seenIds = new Set<string>();
  const seenUrls = new Set<string>();
  const publishers = new Set<string>();
  let scholarlyCount = 0;

  if (!Array.isArray(value.sources)) {
    errors.push('sources가 배열이 아닙니다.');
  } else {
    const count = value.sources.length;
    if (count < ACCEPTED_MIN || count > ACCEPTED_MAX) {
      errors.push(`채택 자료는 ${ACCEPTED_MIN}~${ACCEPTED_MAX}개여야 합니다 (지금 ${count}개).`);
    }

    for (const [index, entry] of value.sources.entries()) {
      const label = `sources[${index}]`;
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        errors.push(`${label}: 객체가 아닙니다.`);
        continue;
      }
      const source = entry as Record<string, unknown>;

      for (const key of Object.keys(source)) {
        if (!(SOURCE_FIELDS as readonly string[]).includes(key)) {
          errors.push(`${label}: 허용되지 않는 항목이 있습니다 (${key})`);
        }
      }

      for (const key of ['title', 'authorOrOrganization', 'publisherOrInstitution'] as const) {
        if (!isNonEmptyString(source[key])) errors.push(`${label}: ${key}가 비어 있습니다.`);
      }

      if (!isNonEmptyString(source.relevanceNote)) {
        errors.push(`${label}: relevanceNote가 비어 있습니다.`);
      } else if ((source.relevanceNote as string).length > RELEVANCE_NOTE_MAX) {
        errors.push(`${label}: relevanceNote가 ${RELEVANCE_NOTE_MAX}자를 넘습니다.`);
      }

      // 연구 근거. 최종 결과에는 반드시 있어야 하고, 번호는 서버가 붙인 것이어야 한다.
      const claims = source.evidenceClaims;
      if (!Array.isArray(claims)) {
        errors.push(`${label}: evidenceClaims가 배열이 아닙니다.`);
      } else if (claims.length < EVIDENCE_CLAIM_MIN || claims.length > EVIDENCE_CLAIM_MAX) {
        errors.push(
          `${label}: 연구 근거는 ${EVIDENCE_CLAIM_MIN}~${EVIDENCE_CLAIM_MAX}개여야 합니다 (지금 ${claims.length}개).`,
        );
      } else {
        for (const [claimIndex, claim] of claims.entries()) {
          const claimLabel = `${label}.evidenceClaims[${claimIndex}]`;
          if (typeof claim !== 'object' || claim === null || Array.isArray(claim)) {
            errors.push(`${claimLabel}: 객체가 아닙니다.`);
            continue;
          }
          const value = claim as Record<string, unknown>;

          for (const key of Object.keys(value)) {
            if (!(EVIDENCE_FIELDS as readonly string[]).includes(key)) {
              errors.push(`${claimLabel}: 허용되지 않는 항목이 있습니다 (${key})`);
            }
          }
          // 번호는 서버가 붙인다. 자료 id와 순서까지 정확히 맞아야 한다.
          //
          // 앞자리만 보면 :e2가 첫 번째에 오거나 :e99 같은 값도 통과한다.
          // 그러면 근거의 순서가 서버가 만든 것과 달라도 알아채지 못한다.
          if (value.evidenceId !== `${source.sourceId}:e${claimIndex + 1}`) {
            errors.push(`${claimLabel}: 번호가 서버가 붙인 것과 다릅니다.`);
          }
        }
      }

      if (!isIsoDate(source.accessedAt)) {
        errors.push(`${label}: accessedAt이 YYYY-MM-DD 형식의 실제 날짜가 아닙니다.`);
      }

      if (
        source.publicationYear !== null &&
        (typeof source.publicationYear !== 'number' ||
          !Number.isSafeInteger(source.publicationYear) ||
          source.publicationYear < PUBLICATION_YEAR_MIN ||
          source.publicationYear > PUBLICATION_YEAR_MAX)
      ) {
        errors.push(`${label}: publicationYear가 연도이거나 null이어야 합니다.`);
      }

      // 자료 종류
      const sourceType = source.sourceType;
      if (typeof sourceType !== 'string' || !harvestableTypes.has(sourceType)) {
        errors.push(`${label}: 알 수 없는 sourceType입니다.`);
      } else if (isScholarlyCoreType(sourceType)) {
        scholarlyCount += 1;
      }

      // 확인 수준. metadata만 확인한 자료는 채택 자료가 아니다.
      if (typeof source.accessLevel !== 'string' || !accessLevels.has(source.accessLevel)) {
        errors.push(`${label}: 내용을 확인한 수준(accessLevel)이 올바르지 않습니다.`);
      }

      // 용도
      if (!Array.isArray(source.intendedUse) || source.intendedUse.length === 0) {
        errors.push(`${label}: intendedUse가 비어 있습니다.`);
      } else if (!isStringArray(source.intendedUse)) {
        errors.push(`${label}: intendedUse가 문자열 목록이 아닙니다.`);
      } else {
        const uses = source.intendedUse as string[];
        if (new Set(uses).size !== uses.length) {
          errors.push(`${label}: intendedUse가 중복됩니다.`);
        }
        for (const use of uses) {
          if (!intendedUses.has(use)) {
            errors.push(`${label}: 알 수 없는 intendedUse입니다 (${use})`);
            continue;
          }
          // 허용 조합은 research-source.ts의 canonical 규칙 하나만 본다.
          if (typeof sourceType === 'string' && harvestableTypes.has(sourceType)) {
            if (!isSourceTypeAllowedForUse(sourceType, use)) {
              errors.push(`${label}: ${sourceType} 자료를 ${use} 용도로 쓸 수 없습니다.`);
            }
          }
        }
      }

      // 주소와 자료 id
      const canonical = normalizeSourceUrl(source.url);
      if (canonical === null) {
        errors.push(`${label}: 받을 수 없는 주소입니다.`);
      } else {
        if (seenUrls.has(canonical)) errors.push(`${label}: 같은 자료가 두 번 들어 있습니다.`);
        seenUrls.add(canonical);

        const expectedId = await computeSourceId(canonical);
        if (source.sourceId !== expectedId) {
          errors.push(`${label}: sourceId가 주소에서 만들어진 값과 다릅니다.`);
        }
      }

      if (typeof source.sourceId !== 'string' || source.sourceId.length === 0) {
        errors.push(`${label}: sourceId가 없습니다.`);
      } else {
        if (seenIds.has(source.sourceId)) errors.push(`${label}: sourceId가 중복됩니다.`);
        seenIds.add(source.sourceId);
      }

      const publisher = normalizePublisherName(source.publisherOrInstitution);
      if (publisher !== null) publishers.add(publisher);
    }

    if (scholarlyCount < SCHOLARLY_CORE_MIN) {
      errors.push(`학술적 핵심 자료가 ${SCHOLARLY_CORE_MIN}개 이상이어야 합니다 (지금 ${scholarlyCount}개).`);
    }
    if (publishers.size < PUBLISHER_MIN) {
      errors.push(`서로 다른 발행처가 ${PUBLISHER_MIN}곳 이상이어야 합니다 (지금 ${publishers.size}곳).`);
    }
  }

  // 채택하지 않은 자료
  //
  // 기록은 두 곳에서 나온다. 나온 곳이 다르므로 따로 센다.
  //   모델이 직접 남긴 기록  → 최대 REJECTED_SOURCE_MAX
  //   서버가 자동으로 남긴 기록(열어 본 적 없어 뺀 자료) → 최대 SERVER_REJECTED_SOURCE_MAX
  //
  // 서버가 안전하게 자료를 뺀 것 때문에 결과 전체가 실패하면 안 된다.
  // 어느 쪽 기록인지는 rejectionReason으로 구분한다. 따로 표시를 붙이지 않는다.
  let modelRejectedCount = 0;
  let serverRejectedCount = 0;

  if (!Array.isArray(value.rejectedSources)) {
    errors.push('rejectedSources가 배열이 아닙니다.');
  } else {
    for (const [index, entry] of value.rejectedSources.entries()) {
      const label = `rejectedSources[${index}]`;
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        errors.push(`${label}: 객체가 아닙니다.`);
        continue;
      }
      const rejected = entry as Record<string, unknown>;

      for (const key of Object.keys(rejected)) {
        if (!(REJECTED_FIELDS as readonly string[]).includes(key)) {
          errors.push(`${label}: 허용되지 않는 항목이 있습니다 (${key})`);
        }
      }

      // 왜 걸렀는지 남기는 기록이므로 주소 자체는 잘못된 것이어도 된다.
      if (!isNonEmptyString(rejected.url)) errors.push(`${label}: url이 비어 있습니다.`);
      if (rejected.title !== null && !isNonEmptyString(rejected.title)) {
        errors.push(`${label}: title은 확인한 제목이거나 null이어야 합니다.`);
      }
      if (
        typeof rejected.rejectionReason !== 'string' ||
        !rejectionReasons.has(rejected.rejectionReason)
      ) {
        errors.push(`${label}: 알 수 없는 rejectionReason입니다.`);
      } else if (serverOnlyReasons.has(rejected.rejectionReason)) {
        serverRejectedCount += 1;
      } else {
        modelRejectedCount += 1;
      }
    }

    if (modelRejectedCount > REJECTED_SOURCE_MAX) {
      errors.push(`모델이 남긴 제외 기록은 ${REJECTED_SOURCE_MAX}개까지입니다.`);
    }
    if (serverRejectedCount > SERVER_REJECTED_SOURCE_MAX) {
      errors.push(`서버가 남긴 제외 기록은 ${SERVER_REJECTED_SOURCE_MAX}개까지입니다.`);
    }
    // 이중 안전장치. 위 두 상한을 지켰다면 자연히 통과한다.
    if (value.rejectedSources.length > FINAL_REJECTED_SOURCE_MAX) {
      errors.push(`제외 기록 전체는 ${FINAL_REJECTED_SOURCE_MAX}개까지입니다.`);
    }
  }

  // 모르는 것은 남겨도 된다. 빈 배열도 정상이다.
  if (!isStringArray(value.unresolvedSourceQuestions)) {
    errors.push('unresolvedSourceQuestions가 문자열 목록이 아닙니다.');
  }

  return { valid: errors.length === 0, errors };
}

/**
 * 검증을 통과한 수집 결과에서 Biblical Researcher가 쓸 자료 목록을 만든다.
 *
 * 떨어져 나가는 것은 수집 단계 메모(relevanceNote) 하나뿐이다.
 * 자료의 역할을 정하는 정보(sourceType, intendedUse, accessLevel, 발행처, 연도)는
 * 그대로 연구 단계로 넘어간다. 수집 단계에서 세운 권한 경계가 연구 단계에서도 살아 있어야 하기 때문이다.
 *
 * Biblical Researcher는 이 목록의 sourceId만 가리킨다. 새 자료를 지어낼 수 없다.
 */
export function toResearchSources(result: SourceHarvestResult): ResearchSource[] {
  // 떨어져 나가는 것은 수집 단계에서만 쓰는 두 값이다.
  //   relevanceNote  — 왜 이 자료를 골랐는가에 대한 메모
  //   evidenceClaims — 다음 단계가 쓸 연구 근거
  //
  // 근거를 여기서 떨어뜨리는 이유는 ResearchSource가 연구 단계의 계약이고,
  // 그 계약을 이번 단계에서 바꾸지 않기로 했기 때문이다.
  // 근거는 ready.harvest.sources 안에 그대로 남아 있다.
  return result.sources.map(
    ({ relevanceNote: _relevanceNote, evidenceClaims: _evidenceClaims, ...source }) => ({
      ...source,
    }),
  );
}
