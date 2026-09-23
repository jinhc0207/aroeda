/** 활성 Scripture Catalog를 사용자 요청에서 쓰기 위한 읽기 전용 계약. */

import {
  DOMAIN_DISPLAY_NAME_FORMAT,
  DOMAIN_ID_FORMAT,
  CARD_ID_FORMAT,
  CATALOG_VERSION_HASH_FORMAT,
  DOMAIN_DISPLAY_NAME_MAX,
  DOMAIN_DISPLAY_NAME_MIN,
  MAX_PASSAGES_PER_CARD,
  type CatalogPassage,
  type ScriptureCatalogSnapshot,
  computeCatalogVersionHash,
  validateCatalogSnapshot,
} from './automatic-scripture-catalog-contract.ts';
import {
  type AnalyzerDomainManifest,
  STATIC_ANALYZER_DOMAIN_MANIFEST,
  buildCatalogAnalyzerDomainManifest,
} from './automatic-scripture-catalog-analyzer-domain-manifest.ts';
import { catalogSnapshotToGateCards } from './automatic-scripture-catalog-frozen-analysis-adapter.ts';
import { SCRIPTURE_CARDS, type ScriptureCard } from './scripture-cards.ts';
import { formatCatalogReferenceLabel } from './automatic-scripture-catalog-contract.ts';
import { isValidBibleReference } from './bible-reference.ts';
import { PROSE_MAX, REFERENCE_LABEL_MAX } from './published-content-contract.ts';

export const GET_ACTIVE_SCRIPTURE_CATALOG_RUNTIME_RPC =
  'get_active_scripture_catalog_runtime';
/** 새 앱이 동적 영역·카드를 안전하게 표시할 수 있음을 추천 요청에서 명시한다. */
export const SCRIPTURE_CATALOG_RUNTIME_CLIENT_VERSION =
  'scripture-catalog-runtime/v1';
export const SCRIPTURE_CATALOG_RUNTIME_CLIENT_FIELD = 'catalogRuntimeVersion';
export type ScriptureCatalogClientMode = 'dynamic' | 'legacy' | 'invalid';

/** 요청 본문에서 동적 카탈로그 표시 capability를 읽는다. 표시가 없을 때만 구 앱이다. */
export function parseScriptureCatalogClientMode(value: unknown): ScriptureCatalogClientMode {
  if (!isPlainObject(value) || !Object.hasOwn(value, SCRIPTURE_CATALOG_RUNTIME_CLIENT_FIELD)) {
    return 'legacy';
  }
  return value[SCRIPTURE_CATALOG_RUNTIME_CLIENT_FIELD] === SCRIPTURE_CATALOG_RUNTIME_CLIENT_VERSION
    ? 'dynamic'
    : 'invalid';
}
export const SCRIPTURE_CATALOG_RUNTIME_RESPONSE_FIELDS = [
  'activeVersionHash',
  'pointerRevision',
  'catalog',
] as const;

export type ScriptureCatalogRuntime = {
  activeVersionHash: string;
  pointerRevision: number;
  catalog: ScriptureCatalogSnapshot;
  manifest: AnalyzerDomainManifest;
  cards: ScriptureCard[];
};

export type ScriptureCatalogRuntimeLoader = (
  options?: { signal?: AbortSignal },
) => Promise<ScriptureCatalogRuntime>;

/**
 * 구 앱은 로컬에 들어 있는 정적 id·본문만 표시할 수 있다. 활성판 조회 성공은 유지하면서
 * Analyzer·Gate·카드 조회 재료만 그 앱과 같은 정적 계약으로 맞춘다.
 */
export function scriptureCatalogRuntimeForClient(
  active: ScriptureCatalogRuntime,
  mode: Exclude<ScriptureCatalogClientMode, 'invalid'>,
): ScriptureCatalogRuntime {
  if (mode === 'dynamic') return active;
  return {
    ...active,
    manifest: STATIC_ANALYZER_DOMAIN_MANIFEST,
    cards: SCRIPTURE_CARDS,
  };
}

export const RUNTIME_CARD_VIEW_FIELDS = [
  'id', 'domains', 'referenceLabel', 'passages', 'userExplanation', 'prayerDirection',
] as const;
export type RuntimeCardView = {
  id: string;
  domains: string[];
  referenceLabel: string;
  passages: CatalogPassage[];
  userExplanation: string;
  prayerDirection: string;
};
export const RUNTIME_DOMAIN_VIEW_FIELDS = ['id', 'displayName'] as const;
export type RuntimeDomainView = { id: string; displayName: string };

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasExactFields = (value: Record<string, unknown>, fields: readonly string[]) =>
  Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field));

/** 내부 신학 검증 필드와 태그를 앱 응답에 내보내지 않는 명시적 projection. */
export function projectRuntimeCardView(card: ScriptureCard): RuntimeCardView {
  return {
    id: card.id,
    domains: [...card.domains],
    referenceLabel: card.referenceLabel,
    passages: (card.passages ?? [card.passage]).map((passage) => ({ ...passage })),
    userExplanation: card.userExplanation,
    prayerDirection: card.prayerDirection,
  };
}

/** 앱이 서버 응답을 그대로 믿지 않도록 공개 카드의 모양·본문 위치·표기를 다시 확인한다. */
export function parseRuntimeCardView(value: unknown): RuntimeCardView | null {
  if (!isPlainObject(value) || !hasExactFields(value, RUNTIME_CARD_VIEW_FIELDS)) return null;
  if (
    typeof value.id !== 'string' || !CARD_ID_FORMAT.test(value.id) ||
    !Array.isArray(value.domains) || value.domains.length !== 1 ||
    typeof value.domains[0] !== 'string' || !DOMAIN_ID_FORMAT.test(value.domains[0]) ||
    typeof value.referenceLabel !== 'string' ||
    value.referenceLabel !== value.referenceLabel.trim() || value.referenceLabel.length > REFERENCE_LABEL_MAX ||
    !Array.isArray(value.passages) || value.passages.length === 0 || value.passages.length > MAX_PASSAGES_PER_CARD ||
    typeof value.userExplanation !== 'string' || value.userExplanation !== value.userExplanation.trim() ||
    value.userExplanation.length === 0 || value.userExplanation.length > PROSE_MAX ||
    typeof value.prayerDirection !== 'string' || value.prayerDirection !== value.prayerDirection.trim() ||
    value.prayerDirection.length === 0 || value.prayerDirection.length > PROSE_MAX
  ) return null;
  const passages: CatalogPassage[] = [];
  for (const passage of value.passages) {
    if (!isPlainObject(passage) || !hasExactFields(passage, ['book', 'chapter', 'startVerse', 'endVerse'])) return null;
    if (!isValidBibleReference(passage)) return null;
    passages.push({
      book: passage.book as string,
      chapter: passage.chapter as number,
      startVerse: passage.startVerse as number,
      endVerse: passage.endVerse as number,
    });
  }
  if (formatCatalogReferenceLabel(passages) !== value.referenceLabel) return null;
  return {
    id: value.id,
    domains: [value.domains[0]],
    referenceLabel: value.referenceLabel,
    passages,
    userExplanation: value.userExplanation,
    prayerDirection: value.prayerDirection,
  };
}

export function parseRuntimeDomainView(value: unknown): RuntimeDomainView | null {
  if (!isPlainObject(value) || !hasExactFields(value, RUNTIME_DOMAIN_VIEW_FIELDS)) return null;
  if (
    typeof value.id !== 'string' || !DOMAIN_ID_FORMAT.test(value.id) ||
    typeof value.displayName !== 'string' ||
    value.displayName.length < DOMAIN_DISPLAY_NAME_MIN ||
    value.displayName.length > DOMAIN_DISPLAY_NAME_MAX ||
    !DOMAIN_DISPLAY_NAME_FORMAT.test(value.displayName)
  ) return null;
  return { id: value.id, displayName: value.displayName };
}

/** DB의 version 이름을 믿지 않고 catalog 내용에서 다시 계산한 뒤 런타임 재료를 만든다. */
export async function parseScriptureCatalogRuntimeResponse(
  value: unknown,
): Promise<{ ok: true; runtime: ScriptureCatalogRuntime } | { ok: false }> {
  try {
    if (!isPlainObject(value) || !hasExactFields(value, SCRIPTURE_CATALOG_RUNTIME_RESPONSE_FIELDS)) {
      return { ok: false };
    }
    if (
      typeof value.activeVersionHash !== 'string' ||
      !CATALOG_VERSION_HASH_FORMAT.test(value.activeVersionHash) ||
      !Number.isSafeInteger(value.pointerRevision) ||
      (value.pointerRevision as number) <= 0
    ) return { ok: false };

    const catalogCheck = validateCatalogSnapshot(value.catalog);
    if (!catalogCheck.valid) return { ok: false };
    const catalog = structuredClone(value.catalog as ScriptureCatalogSnapshot);
    if ((await computeCatalogVersionHash(catalog)) !== value.activeVersionHash) return { ok: false };

    const manifest = buildCatalogAnalyzerDomainManifest(catalog);
    const cards = catalogSnapshotToGateCards(catalog);
    return {
      ok: true,
      runtime: {
        activeVersionHash: value.activeVersionHash,
        pointerRevision: value.pointerRevision as number,
        catalog,
        manifest,
        cards,
      },
    };
  } catch {
    return { ok: false };
  }
}

export const SCRIPTURE_CATALOG_RUNTIME_PRIVACY_POLICY = {
  acceptsUserText: false,
  returnsUserText: false,
  returnsUserId: false,
  returnsCredential: false,
  readOnly: true,
  fallbackToStaticCatalog: false,
} as const;
