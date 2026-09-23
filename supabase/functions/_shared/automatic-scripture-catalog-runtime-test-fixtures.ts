/** Edge Function 테스트가 앱(src/)을 역방향 import하지 않도록 둔 순수 runtime fixture. */

import {
  CATALOG_CONTRACT_VERSION,
  buildCatalogSnapshotFromStaticCards,
  computeCatalogVersionHash,
  type ScriptureCatalogSnapshot,
} from './automatic-scripture-catalog-contract.ts';
import { buildCatalogAnalyzerDomainManifest } from './automatic-scripture-catalog-analyzer-domain-manifest.ts';
import { catalogSnapshotToGateCards } from './automatic-scripture-catalog-frozen-analysis-adapter.ts';
import type { ScriptureCatalogRuntime } from './automatic-scripture-catalog-runtime.ts';
import { SCRIPTURE_CARDS } from './scripture-cards.ts';
import { DOMAIN_DESCRIPTIONS } from './situation-domains.ts';

const displayNames: Record<string, string> = {
  fear_uncertainty: '두려움과 불확실함',
  decision_guidance: '중요한 결정 앞에서',
  waiting_unanswered_prayer: '오래된 기다림',
  gratitude_joy: '감사와 기쁨',
  quiet_communion: '조용히 하나님과 머물고 싶은 마음',
  repentance_guilt: '죄책감과 회개',
  comparison_identity: '비교와 정체성',
  injustice_mistreatment: '억울함과 부당한 대우',
  grief_loss: '사별과 상실',
  wisdom_discernment: '지혜와 분별이 필요한 순간',
  loneliness_isolation: '외로움과 고립',
  family_parenting_conflict: '가족과 자녀 문제',
  burnout_exhaustion: '지치고 소진된 마음',
  spiritual_dryness: '영적으로 메마른 시간',
  financial_hardship: '생계와 경제적 어려움',
  chronic_illness: '질병과 함께하는 삶',
  relationship_conflict_forgiveness: '관계의 갈등과 용서',
};

export const buildTestBaselineCatalog = (): ScriptureCatalogSnapshot =>
  buildCatalogSnapshotFromStaticCards(SCRIPTURE_CARDS, DOMAIN_DESCRIPTIONS, displayNames);

export async function buildTestCatalogRuntime(
  catalog = buildTestBaselineCatalog(),
  pointerRevision = 1,
): Promise<ScriptureCatalogRuntime> {
  return {
    activeVersionHash: await computeCatalogVersionHash(catalog),
    pointerRevision,
    catalog,
    manifest: buildCatalogAnalyzerDomainManifest(catalog),
    cards: catalogSnapshotToGateCards(catalog),
  };
}

export async function buildTestDynamicCatalogRuntime(): Promise<ScriptureCatalogRuntime> {
  const base = buildTestBaselineCatalog();
  const domainId = 'caregiving_strain';
  const situationTags = ['오래 돌봄', '돌봄 피로', '돌봄 부담'];
  const cards = base.cards.slice(0, 3).map((card, index) => ({
    ...structuredClone(card),
    id: `SC-90${index}`,
    domainId,
    situationTags: [situationTags[index]!],
  }));
  const catalog: ScriptureCatalogSnapshot = {
    contractVersion: CATALOG_CONTRACT_VERSION,
    domains: [
      ...base.domains.map((domain) => ({ ...domain })),
      { id: domainId, displayName: '오래 돌보는 무게', description: '오랜 돌봄 부담을 다루는 시험 영역입니다.' },
    ].sort((left, right) => left.id.localeCompare(right.id)),
    cards: [...base.cards.map((card) => structuredClone(card)), ...cards]
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
  return buildTestCatalogRuntime(catalog, 2);
}
