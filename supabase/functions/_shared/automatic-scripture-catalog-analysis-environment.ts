/**
 * 자동 Scripture Catalog — 고정 분석 스냅샷의 "현재 환경" 결속 계층
 *
 * 무엇을 위한 것인가
 *   `automatic-scripture-catalog-analysis-snapshot-contract.ts`의 `validateAnalysisSnapshot`은
 *   스냅샷 "안에서" 값들이 서로 일관되는지만 본다 — environment의 각 필드가 지문에 결속돼
 *   몰래 바뀔 수 없다는 것은 보장하지만, 그 값 자체가 **지금 저장소의 실제 Analyzer·Gate·
 *   Matcher·기준 카탈로그와 같은가**는 확인하지 않는다(그 파일의 주석에 이미 그렇게 적혀
 *   있다). 그래서 `analyzerModel: 'arbitrary-model'`처럼 완전히 임의의 값으로도 내부적으로
 *   일관된(하위 해시·top-level fingerprint가 전부 맞는) 스냅샷을 만들 수 있고, 그런
 *   스냅샷도 `validateAnalysisSnapshot` 혼자로는 통과한다.
 *
 *   이 파일은 그 공백을 메우는 순수 함수만 둔다. "지금 코드에서 결정적으로 나오는 진짜
 *   environment"를 만들고(`buildCurrentAnalysisSnapshotEnvironment`), 스냅샷이 주장하는
 *   environment와 그 값을 필드별로 대조한다(`validateAnalysisSnapshotAgainstCurrentEnvironment`).
 *
 * 이 파일이 하지 않는 일
 *   실제 스냅샷 데이터를 만들지 않는다. executor에 연결하지 않는다. activation contract를
 *   고치지 않는다. DB나 validation-context RPC를 부르지 않는다. 환경변수·파일 시스템·시계·
 *   네트워크를 읽지 않는다 — 모든 입력은 이 저장소의 다른 TypeScript 파일에서 정적으로
 *   가져온 값이거나 함수 인자다.
 *
 * 기준 catalog hash의 신뢰 경계
 *   `baselineCatalogVersionHash`는 이 파일의 함수들에 **인자로 주입**한다. 후보(candidate)나
 *   모델 응답이 스스로 선언한 값을 여기서 신뢰하지 않는다 — 이번 단계는 그 값을 어디서
 *   가져올지 결정하지 않고 호출자에게 맡긴다. 후속 executor 연결 단계에서는 이 인자를
 *   candidate payload가 아니라 validation-context RPC(automatic-scripture-catalog-
 *   validation-context.ts)가 읽어 온 **활성 기준 카탈로그 버전**에서 가져와야 한다. 이번
 *   작업은 그 RPC나 DB에 연결하지 않는다.
 *
 * 새 영역(new_domain_with_cards) 정책
 *   고정 스냅샷은 아래 정적 builder를 계속 쓴다. 후보 생성 증거와 운영 런타임은 검증된
 *   카탈로그에서 manifest를 만들고 prompt·schema·runtime validator와 같은 영역·상황 태그를
 *   쓴다. 활성 포인터 읽기와 롤백 원자성은 runtime RPC 계약이 맡는다.
 */

import {
  CATALOG_VERSION_HASH_FORMAT,
  canonicalJson,
  computeArtifactHash,
} from './automatic-scripture-catalog-contract.ts';
import {
  type AnalysisSnapshotEnvironmentBinding,
  type AnalysisSnapshotValidationResult,
  type FrozenAnalysisSnapshot,
  validateAnalysisSnapshot,
} from './automatic-scripture-catalog-analysis-snapshot-contract.ts';
import {
  INSTRUCTIONS,
  MODEL,
  SITUATION_ANALYSIS_SCHEMA,
  buildAnalyzerInstructions,
  buildSituationAnalysisSchema,
} from './analyzer-contract.ts';
import { TAXONOMY } from './analysis-taxonomy.ts';
import {
  STATIC_ANALYZER_DOMAIN_MANIFEST,
  buildCandidateAnalyzerDomainManifest,
  projectAnalyzerDomainManifestForHash,
  type AnalyzerDomainManifest,
} from './automatic-scripture-catalog-analyzer-domain-manifest.ts';
import type {
  ScriptureCatalogCandidate,
  ScriptureCatalogSnapshot,
} from './automatic-scripture-catalog-contract.ts';
import { RECOMMENDATION_GATE_CONTRACT_VERSION } from './recommendation-gate.ts';
import { SCRIPTURE_MATCHER_CONTRACT_VERSION } from './scripture-matcher.ts';

/**
 * 지금 이 저장소의 코드에서 결정적으로 만든 "진짜" environment 결속. 환경변수·파일
 * 시스템·시계·네트워크·DB를 읽지 않는다 — 전부 정적 import와 함수 인자에서만 나온다.
 */
export async function buildCurrentAnalysisSnapshotEnvironment(
  baselineCatalogVersionHash: string,
): Promise<AnalysisSnapshotEnvironmentBinding> {
  return {
    analyzerModel: MODEL,
    analyzerInstructionsHash: await computeArtifactHash(INSTRUCTIONS),
    analyzerSchemaHash: await computeArtifactHash(SITUATION_ANALYSIS_SCHEMA),
    analysisTaxonomyHash: await computeArtifactHash(TAXONOMY),
    // 고정 156건 스냅샷과 운영 정적 Analyzer는 기존 목록의 지문을 유지한다.
    analyzerDomainManifestHash: await computeArtifactHash(
      projectAnalyzerDomainManifestForHash(STATIC_ANALYZER_DOMAIN_MANIFEST),
    ),
    recommendationGate: { kind: 'version', version: RECOMMENDATION_GATE_CONTRACT_VERSION },
    scriptureMatcher: { kind: 'version', version: SCRIPTURE_MATCHER_CONTRACT_VERSION },
    baselineCatalogVersionHash,
  };
}

/** 동적 manifest의 prompt·schema·validator 목록과 같은 값을 지문으로 묶는다. */
export async function buildAnalysisSnapshotEnvironmentForManifest(
  baselineCatalogVersionHash: string,
  manifest: AnalyzerDomainManifest,
): Promise<AnalysisSnapshotEnvironmentBinding> {
  return {
    analyzerModel: MODEL,
    analyzerInstructionsHash: await computeArtifactHash(buildAnalyzerInstructions(manifest)),
    analyzerSchemaHash: await computeArtifactHash(buildSituationAnalysisSchema(manifest)),
    analysisTaxonomyHash: await computeArtifactHash({
      ...TAXONOMY,
      situationTags: [...manifest.situationTags],
    }),
    analyzerDomainManifestHash: await computeArtifactHash(projectAnalyzerDomainManifestForHash(manifest)),
    recommendationGate: { kind: 'version', version: RECOMMENDATION_GATE_CONTRACT_VERSION },
    scriptureMatcher: { kind: 'version', version: SCRIPTURE_MATCHER_CONTRACT_VERSION },
    baselineCatalogVersionHash,
  };
}

export async function buildCandidateGenerationAnalysisEnvironment(
  candidate: ScriptureCatalogCandidate,
  baseCatalog: ScriptureCatalogSnapshot,
): Promise<AnalysisSnapshotEnvironmentBinding> {
  const manifest = await buildCandidateAnalyzerDomainManifest(candidate, baseCatalog);
  return buildAnalysisSnapshotEnvironmentForManifest(candidate.baseVersionHash, manifest);
}

/** 오류 메시지에 어떤 필드가 어긋났는지 정확히 드러내기 위한 목록. */
const ENVIRONMENT_FIELD_LABELS: ReadonlyArray<[keyof AnalysisSnapshotEnvironmentBinding, string]> = [
  ['analyzerModel', 'environment.analyzerModel'],
  ['analyzerInstructionsHash', 'environment.analyzerInstructionsHash'],
  ['analyzerSchemaHash', 'environment.analyzerSchemaHash'],
  ['analysisTaxonomyHash', 'environment.analysisTaxonomyHash'],
  ['analyzerDomainManifestHash', 'environment.analyzerDomainManifestHash'],
  ['recommendationGate', 'environment.recommendationGate'],
  ['scriptureMatcher', 'environment.scriptureMatcher'],
  ['baselineCatalogVersionHash', 'environment.baselineCatalogVersionHash'],
];

/**
 * 스냅샷이 계약을 지키는지(`validateAnalysisSnapshot`)를 먼저 본 뒤에만, 스냅샷이 주장하는
 * environment 각 필드가 **지금 저장소의 실제 값**과 같은지 대조한다. 완전히 봉인된(하위
 * 해시·fingerprint가 전부 스스로와 맞는) 스냅샷이라도 지금 환경과 다르면 거절한다.
 *
 * 검사 순서
 *   1. validateAnalysisSnapshot(snapshot) — 실패하면 그 오류를 그대로 돌려주고 아래를
 *      진행하지 않는다(오염된 구조에서 굳이 "현재 환경"을 계산해 혼란스러운 오류를 더하지
 *      않는다).
 *   2. baselineCatalogVersionHash 인자 자체의 형식을 확인한다(호출자가 넘긴 값이므로).
 *   3. buildCurrentAnalysisSnapshotEnvironment로 지금 환경을 만든다.
 *   4. snapshot.environment의 여덟 필드를 각각 canonicalJson으로 대조해, 다른 필드마다
 *      경로가 드러나는 오류를 하나씩 낸다(전체가 다르다고 뭉뚱그리지 않는다).
 */
export async function validateAnalysisSnapshotAgainstCurrentEnvironment(
  snapshot: unknown,
  baselineCatalogVersionHash: string,
): Promise<AnalysisSnapshotValidationResult> {
  const structural = await validateAnalysisSnapshot(snapshot);
  if (!structural.valid) return structural;

  if (!CATALOG_VERSION_HASH_FORMAT.test(baselineCatalogVersionHash)) {
    return { valid: false, errors: ['baselineCatalogVersionHash: 형식이 올바르지 않습니다.'] };
  }

  const current = await buildCurrentAnalysisSnapshotEnvironment(baselineCatalogVersionHash);
  const snapshotEnvironment = (snapshot as FrozenAnalysisSnapshot).environment;

  const errors: string[] = [];
  for (const [field, label] of ENVIRONMENT_FIELD_LABELS) {
    if (canonicalJson(snapshotEnvironment[field]) !== canonicalJson(current[field])) {
      errors.push(`${label}: 스냅샷 값이 지금 저장소의 실제 값과 다릅니다.`);
    }
  }

  return { valid: errors.length === 0, errors };
}
