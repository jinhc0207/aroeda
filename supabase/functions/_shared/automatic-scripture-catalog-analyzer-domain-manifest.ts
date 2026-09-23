/**
 * 후보 생성과 활성 카탈로그 런타임이 함께 쓰는 동적 Analyzer manifest.
 *
 * 운영 Analyzer의 정적 17개 영역을 기준으로 시작해, 활성 카탈로그에 이미 들어온 동적
 * 영역과 이번 후보의 새 영역을 합치고, 카탈로그 카드의 상황 태그 합집합도 함께 묶는다.
 * prompt·schema·runtime validator·환경 지문은 이 한 값을 함께 써야 한다.
 * 네트워크·DB·파일·환경변수·시계를 읽지 않는다.
 */
import {
  type ScriptureCatalogCandidate,
  type ScriptureCatalogSnapshot,
  validateCatalogCandidate,
  validateCatalogSnapshot,
} from './automatic-scripture-catalog-contract.ts';
import {
  COVERED_DOMAINS,
  DOMAIN_DESCRIPTIONS,
  FALLBACK_DOMAIN,
  UNCOVERED_DOMAINS,
} from './situation-domains.ts';
import { SITUATION_TAGS } from './analysis-taxonomy.ts';

export type AnalyzerDomainDefinition = Readonly<{ id: string; description: string }>;
export type AnalyzerDomainManifest = Readonly<{
  coveredDomains: readonly AnalyzerDomainDefinition[];
  uncoveredDomains: readonly AnalyzerDomainDefinition[];
  fallbackDomain: AnalyzerDomainDefinition;
  /** 정적 카드와 활성 카탈로그 카드가 실제로 사용하는 상황 태그의 합집합. */
  situationTags: readonly string[];
}>;

const definition = (id: string, description: string): AnalyzerDomainDefinition =>
  Object.freeze({ id, description });

export const STATIC_ANALYZER_DOMAIN_MANIFEST: AnalyzerDomainManifest = Object.freeze({
  coveredDomains: Object.freeze(COVERED_DOMAINS.map((id) => definition(id, DOMAIN_DESCRIPTIONS[id]))),
  uncoveredDomains: Object.freeze(UNCOVERED_DOMAINS.map((id) => definition(id, DOMAIN_DESCRIPTIONS[id]))),
  fallbackDomain: definition(FALLBACK_DOMAIN, DOMAIN_DESCRIPTIONS[FALLBACK_DOMAIN]),
  situationTags: Object.freeze([...SITUATION_TAGS]),
});

export function analyzerDomainIds(manifest: AnalyzerDomainManifest): string[] {
  return [
    ...manifest.coveredDomains.map((domain) => domain.id),
    ...manifest.uncoveredDomains.map((domain) => domain.id),
    manifest.fallbackDomain.id,
  ];
}

/** 환경 지문은 기존 정적 표현을 유지하면서 동적 영역 id까지 결속한다. */
export function projectAnalyzerDomainManifestForHash(manifest: AnalyzerDomainManifest) {
  return { domains: analyzerDomainIds(manifest), fallbackDomain: manifest.fallbackDomain.id };
}

/**
 * 검증된 활성 카탈로그 한 판에서 운영 Analyzer manifest를 만든다.
 * 정적 영역의 설명과 분류는 코드 계약을 유지하고, 카탈로그가 추가한 영역만 covered에 보탠다.
 */
export function buildCatalogAnalyzerDomainManifest(
  catalog: ScriptureCatalogSnapshot,
): AnalyzerDomainManifest {
  const checked = validateCatalogSnapshot(catalog);
  if (!checked.valid) throw new Error('invalid scripture catalog');

  const staticIds = new Set(analyzerDomainIds(STATIC_ANALYZER_DOMAIN_MANIFEST));
  const dynamicDomains = catalog.domains
    .filter((domain) => !staticIds.has(domain.id))
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((domain) => definition(domain.id, domain.description));
  const situationTags = [...new Set(catalog.cards.flatMap((card) => card.situationTags))]
    .sort((left, right) => left.localeCompare(right, 'ko'));

  return Object.freeze({
    coveredDomains: Object.freeze([
      ...STATIC_ANALYZER_DOMAIN_MANIFEST.coveredDomains,
      ...dynamicDomains,
    ]),
    uncoveredDomains: STATIC_ANALYZER_DOMAIN_MANIFEST.uncoveredDomains,
    fallbackDomain: STATIC_ANALYZER_DOMAIN_MANIFEST.fallbackDomain,
    situationTags: Object.freeze(situationTags),
  });
}

/**
 * 검증된 후보를 기준으로 manifest를 만든다. 기준 카탈로그의 동적 영역도 보존하므로 새 영역을
 * 여러 번 활성화해도 이전에 추가된 영역이 사라지지 않는다. 카드가 있는 영역은 covered다.
 */
export async function buildCandidateAnalyzerDomainManifest(
  candidate: ScriptureCatalogCandidate,
  baseCatalog: ScriptureCatalogSnapshot,
): Promise<AnalyzerDomainManifest> {
  const checked = await validateCatalogCandidate(candidate, baseCatalog);
  if (!checked.valid || checked.proposedCatalog === null) throw new Error('invalid catalog candidate');

  return buildCatalogAnalyzerDomainManifest(checked.proposedCatalog);
}
