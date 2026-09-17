/**
 * 자동 Scripture Catalog 분석 스냅샷 — 현재 환경 결속 계층 테스트
 *
 * 실행: npm run test:logic
 *
 * 무엇을 증명하는가
 *   `validateAnalysisSnapshot`(스냅샷 내부 일관성만 봄)만으로는 임의의 environment도
 *   내부적으로 일관되면 통과한다는 것을 먼저 재현한다. 그 위에서
 *   `validateAnalysisSnapshotAgainstCurrentEnvironment`가 environment의 여덟 필드를 지금
 *   저장소의 실제 Analyzer·Gate·Matcher·기준 카탈로그 값과 대조해, 하나만 달라도 그 필드
 *   경로가 드러나는 오류로 거절한다는 것을 고정한다. `buildCurrentAnalysisSnapshotEnvironment`가
 *   결정적이고 환경변수·파일 시스템·시계·네트워크·DB를 읽지 않는다는 것도 고정한다.
 *
 * 무엇을 증명하지 않는가
 *   executor·activation·DB 연결(아직 없다). baselineCatalogVersionHash를 어디서 가져올지
 *   (이번 단계는 인자로만 받는다 — 파일 머리말 "기준 catalog hash의 신뢰 경계" 참고).
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { computeArtifactHash } from '../../supabase/functions/_shared/automatic-scripture-catalog-contract.ts';
import {
  ANALYSIS_SNAPSHOT_CONTRACT_VERSION,
  type AnalysisSnapshotCase,
  type AnalysisSnapshotEnvironmentBinding,
  type FrozenAnalysisSnapshot,
  computeAnalysisSnapshotFingerprint,
  computeFrozenAnalysisArtifactHash,
  computeSourceCorpusArtifactHash,
  validateAnalysisSnapshot,
} from '../../supabase/functions/_shared/automatic-scripture-catalog-analysis-snapshot-contract.ts';
import {
  buildCurrentAnalysisSnapshotEnvironment,
  validateAnalysisSnapshotAgainstCurrentEnvironment,
} from '../../supabase/functions/_shared/automatic-scripture-catalog-analysis-environment.ts';
import type { SituationAnalysis } from '../../supabase/functions/_shared/situation-analysis.ts';

/* ------------------------------------------------------------------ */
/* 고정 자료 — SC-001(두려움·불확실성) 카드의 실제 태그만 사용한다.           */
/* ------------------------------------------------------------------ */

const BASELINE_HASH = `scat_${'a'.repeat(64)}`;

const RECOMMEND_ANALYSIS: SituationAnalysis = {
  domainPriority: 'resolved',
  primaryDomain: 'fear_uncertainty',
  domainChoiceCandidates: [],
  secondaryDomains: [],
  situationTags: ['두려운 일을 앞둠', '불확실한 결과'],
  emotionTags: ['두려움', '불안'],
  spiritualQuestionTags: ['신뢰'],
  prayerModes: ['간구'],
  pastoralFunctions: ['위로'],
  safety: { level: 'normal', categories: [] },
  confidence: 0.9,
};

const SAFETY_ANALYSIS: SituationAnalysis = {
  domainPriority: 'resolved',
  primaryDomain: 'fear_uncertainty',
  domainChoiceCandidates: [],
  secondaryDomains: [],
  situationTags: ['위협'],
  emotionTags: ['두려움'],
  spiritualQuestionTags: ['신뢰'],
  prayerModes: ['간구'],
  pastoralFunctions: ['위로'],
  safety: { level: 'urgent', categories: ['immediate_danger'] },
  confidence: 0.95,
};

const CORP_RECOMMEND_CASE: AnalysisSnapshotCase = {
  caseId: 'CORP-001',
  kind: 'corpus_regression',
  text: '앞으로 어떤 일이 벌어질지 몰라서 막연히 두려워요.',
  analysis: RECOMMEND_ANALYSIS,
  expected: {
    expectedRoute: 'recommend',
    expectedPrimaryDomain: 'fear_uncertainty',
    preferredCardId: 'SC-001',
    acceptableCardIds: ['SC-001'],
  },
};

const SAFE_CASE: AnalysisSnapshotCase = {
  caseId: 'SAFE-001',
  kind: 'safety_boundary',
  text: '지금 누군가 나를 해치려고 위협해서 무서워요.',
  analysis: SAFETY_ANALYSIS,
  expected: {
    expectedRoute: 'safety',
    expectedSafety: { level: 'urgent', categories: ['immediate_danger'] },
  },
};

function defaultCases(): AnalysisSnapshotCase[] {
  return [CORP_RECOMMEND_CASE, SAFE_CASE];
}

async function buildRealEnvironment(): Promise<AnalysisSnapshotEnvironmentBinding> {
  return buildCurrentAnalysisSnapshotEnvironment(BASELINE_HASH);
}

/** 지금 저장소와 아무 관련이 없는, 형식만 유효한 environment. 공백 재현용. */
async function buildArbitraryEnvironment(): Promise<AnalysisSnapshotEnvironmentBinding> {
  return {
    analyzerModel: 'arbitrary-model',
    analyzerInstructionsHash: await computeArtifactHash({ fixture: 'arbitrary-instructions' }),
    analyzerSchemaHash: await computeArtifactHash({ fixture: 'arbitrary-schema' }),
    analysisTaxonomyHash: await computeArtifactHash({ fixture: 'arbitrary-taxonomy' }),
    analyzerDomainManifestHash: await computeArtifactHash({ fixture: 'arbitrary-domain-manifest' }),
    recommendationGate: { kind: 'version', version: 'recommendation-gate/arbitrary-v9' },
    scriptureMatcher: { kind: 'version', version: 'scripture-matcher/arbitrary-v9' },
    baselineCatalogVersionHash: `scat_${'b'.repeat(64)}`,
  };
}

/** 두 하위 해시와 top-level fingerprint를 cases에서 직접 재계산해 붙인다. */
async function sealWithCases(
  core: Pick<FrozenAnalysisSnapshot, 'contractVersion' | 'environment'>,
  cases: readonly AnalysisSnapshotCase[],
): Promise<FrozenAnalysisSnapshot> {
  const sourceCorpusArtifactHash = await computeSourceCorpusArtifactHash(cases);
  const frozenAnalysisArtifactHash = await computeFrozenAnalysisArtifactHash(cases);
  const withoutFingerprint = { ...core, sourceCorpusArtifactHash, frozenAnalysisArtifactHash, cases };
  const fingerprint = await computeAnalysisSnapshotFingerprint(withoutFingerprint);
  return { ...withoutFingerprint, fingerprint };
}

async function buildRealSnapshot(): Promise<FrozenAnalysisSnapshot> {
  return sealWithCases({ contractVersion: ANALYSIS_SNAPSHOT_CONTRACT_VERSION, environment: await buildRealEnvironment() }, defaultCases());
}

async function buildArbitrarySnapshot(): Promise<FrozenAnalysisSnapshot> {
  return sealWithCases({ contractVersion: ANALYSIS_SNAPSHOT_CONTRACT_VERSION, environment: await buildArbitraryEnvironment() }, defaultCases());
}

/** 실제 environment에서 필드 하나만 바꾸고, 모든 해시·fingerprint를 다시 올바르게 계산한다. */
async function buildRealSnapshotWithOneEnvironmentFieldChanged(
  patch: Partial<AnalysisSnapshotEnvironmentBinding>,
): Promise<FrozenAnalysisSnapshot> {
  const environment: AnalysisSnapshotEnvironmentBinding = { ...(await buildRealEnvironment()), ...patch };
  return sealWithCases({ contractVersion: ANALYSIS_SNAPSHOT_CONTRACT_VERSION, environment }, defaultCases());
}

describe('automatic-scripture-catalog-analysis-environment', () => {
  it('1) 현재 실제 환경으로 만든 스냅샷은 통과한다', async () => {
    const result = await validateAnalysisSnapshotAgainstCurrentEnvironment(await buildRealSnapshot(), BASELINE_HASH);
    assert.deepEqual(result, { valid: true, errors: [] });
  });

  it('2) [공백 재현] 기존 validateAnalysisSnapshot만으로는 임의 environment도 내부적으로 일관되면 통과한다', async () => {
    const result = await validateAnalysisSnapshot(await buildArbitrarySnapshot());
    assert.deepEqual(result, { valid: true, errors: [] });
  });

  it('3) 신규 환경 validator는 같은 임의 environment 스냅샷을 거절한다(여덟 필드 전부 다름)', async () => {
    const result = await validateAnalysisSnapshotAgainstCurrentEnvironment(await buildArbitrarySnapshot(), BASELINE_HASH);
    assert.equal(result.valid, false);
    assert.deepEqual(
      [...result.errors].sort(),
      [
        'environment.analyzerModel: 스냅샷 값이 지금 저장소의 실제 값과 다릅니다.',
        'environment.analyzerInstructionsHash: 스냅샷 값이 지금 저장소의 실제 값과 다릅니다.',
        'environment.analyzerSchemaHash: 스냅샷 값이 지금 저장소의 실제 값과 다릅니다.',
        'environment.analysisTaxonomyHash: 스냅샷 값이 지금 저장소의 실제 값과 다릅니다.',
        'environment.analyzerDomainManifestHash: 스냅샷 값이 지금 저장소의 실제 값과 다릅니다.',
        'environment.recommendationGate: 스냅샷 값이 지금 저장소의 실제 값과 다릅니다.',
        'environment.scriptureMatcher: 스냅샷 값이 지금 저장소의 실제 값과 다릅니다.',
        'environment.baselineCatalogVersionHash: 스냅샷 값이 지금 저장소의 실제 값과 다릅니다.',
      ].sort(),
    );
  });

  it('4) Analyzer model만 바꾸고 모든 해시를 재생성해도 거절한다', async () => {
    const snapshot = await buildRealSnapshotWithOneEnvironmentFieldChanged({ analyzerModel: 'a-different-model' });
    const result = await validateAnalysisSnapshotAgainstCurrentEnvironment(snapshot, BASELINE_HASH);
    assert.deepEqual(result.errors, ['environment.analyzerModel: 스냅샷 값이 지금 저장소의 실제 값과 다릅니다.']);
  });

  it('5) instructions hash만 바꾸고 재봉인해도 거절한다', async () => {
    const snapshot = await buildRealSnapshotWithOneEnvironmentFieldChanged({
      analyzerInstructionsHash: await computeArtifactHash({ fixture: 'different-instructions' }),
    });
    const result = await validateAnalysisSnapshotAgainstCurrentEnvironment(snapshot, BASELINE_HASH);
    assert.deepEqual(result.errors, ['environment.analyzerInstructionsHash: 스냅샷 값이 지금 저장소의 실제 값과 다릅니다.']);
  });

  it('6) schema hash만 바꾸고 재봉인해도 거절한다', async () => {
    const snapshot = await buildRealSnapshotWithOneEnvironmentFieldChanged({
      analyzerSchemaHash: await computeArtifactHash({ fixture: 'different-schema' }),
    });
    const result = await validateAnalysisSnapshotAgainstCurrentEnvironment(snapshot, BASELINE_HASH);
    assert.deepEqual(result.errors, ['environment.analyzerSchemaHash: 스냅샷 값이 지금 저장소의 실제 값과 다릅니다.']);
  });

  it('7) taxonomy hash만 바꾸고 재봉인해도 거절한다', async () => {
    const snapshot = await buildRealSnapshotWithOneEnvironmentFieldChanged({
      analysisTaxonomyHash: await computeArtifactHash({ fixture: 'different-taxonomy' }),
    });
    const result = await validateAnalysisSnapshotAgainstCurrentEnvironment(snapshot, BASELINE_HASH);
    assert.deepEqual(result.errors, ['environment.analysisTaxonomyHash: 스냅샷 값이 지금 저장소의 실제 값과 다릅니다.']);
  });

  it('8) domain manifest hash만 바꾸고 재봉인해도 거절한다', async () => {
    const snapshot = await buildRealSnapshotWithOneEnvironmentFieldChanged({
      analyzerDomainManifestHash: await computeArtifactHash({ fixture: 'different-domain-manifest' }),
    });
    const result = await validateAnalysisSnapshotAgainstCurrentEnvironment(snapshot, BASELINE_HASH);
    assert.deepEqual(result.errors, ['environment.analyzerDomainManifestHash: 스냅샷 값이 지금 저장소의 실제 값과 다릅니다.']);
  });

  it('9) Gate version만 바꾸고 재봉인해도 거절한다', async () => {
    const snapshot = await buildRealSnapshotWithOneEnvironmentFieldChanged({
      recommendationGate: { kind: 'version', version: 'recommendation-gate/v9-different' },
    });
    const result = await validateAnalysisSnapshotAgainstCurrentEnvironment(snapshot, BASELINE_HASH);
    assert.deepEqual(result.errors, ['environment.recommendationGate: 스냅샷 값이 지금 저장소의 실제 값과 다릅니다.']);
  });

  it('10) Matcher version만 바꾸고 재봉인해도 거절한다', async () => {
    const snapshot = await buildRealSnapshotWithOneEnvironmentFieldChanged({
      scriptureMatcher: { kind: 'version', version: 'scripture-matcher/v9-different' },
    });
    const result = await validateAnalysisSnapshotAgainstCurrentEnvironment(snapshot, BASELINE_HASH);
    assert.deepEqual(result.errors, ['environment.scriptureMatcher: 스냅샷 값이 지금 저장소의 실제 값과 다릅니다.']);
  });

  it('11) baseline catalog version만 바꾸고 재봉인해도 거절한다', async () => {
    const snapshot = await buildRealSnapshotWithOneEnvironmentFieldChanged({
      baselineCatalogVersionHash: `scat_${'c'.repeat(64)}`,
    });
    const result = await validateAnalysisSnapshotAgainstCurrentEnvironment(snapshot, BASELINE_HASH);
    assert.deepEqual(result.errors, ['environment.baselineCatalogVersionHash: 스냅샷 값이 지금 저장소의 실제 값과 다릅니다.']);
  });

  it('12) 잘못된 baseline hash 인자는 (스냅샷은 정상이어도) 거절한다', async () => {
    const snapshot = await buildRealSnapshot();
    const result = await validateAnalysisSnapshotAgainstCurrentEnvironment(snapshot, 'not-a-hash');
    assert.deepEqual(result, { valid: false, errors: ['baselineCatalogVersionHash: 형식이 올바르지 않습니다.'] });
  });

  it('13) 스냅샷 구조 자체가 잘못되면 환경 계산 전에 기존 오류를 그대로 돌려준다', async () => {
    const badSnapshot = { not: 'a snapshot' };
    const structural = await validateAnalysisSnapshot(badSnapshot);
    assert.equal(structural.valid, false);
    const result = await validateAnalysisSnapshotAgainstCurrentEnvironment(badSnapshot, BASELINE_HASH);
    assert.deepEqual(result, structural);
    // 환경 불일치 오류가 섞여 들어가지 않았는지도 직접 확인한다.
    assert.ok(!result.errors.some((message) => message.includes('지금 저장소의 실제 값과 다릅니다')));
  });

  it('13b) 잘못된 baseline hash보다 스냅샷 구조 오류가 먼저 보고된다', async () => {
    const badSnapshot = { not: 'a snapshot' };
    const structural = await validateAnalysisSnapshot(badSnapshot);
    const result = await validateAnalysisSnapshotAgainstCurrentEnvironment(badSnapshot, 'also-not-a-hash');
    assert.deepEqual(result, structural);
  });

  it('14) buildCurrentAnalysisSnapshotEnvironment는 같은 입력에서 결정적이다', async () => {
    const first = await buildCurrentAnalysisSnapshotEnvironment(BASELINE_HASH);
    const second = await buildCurrentAnalysisSnapshotEnvironment(BASELINE_HASH);
    assert.deepEqual(first, second);
  });

  it('14b) baselineCatalogVersionHash 인자를 그대로 돌려준다(다른 필드는 인자와 무관하게 결정적)', async () => {
    const other = `scat_${'d'.repeat(64)}`;
    const a = await buildCurrentAnalysisSnapshotEnvironment(BASELINE_HASH);
    const b = await buildCurrentAnalysisSnapshotEnvironment(other);
    assert.equal(a.baselineCatalogVersionHash, BASELINE_HASH);
    assert.equal(b.baselineCatalogVersionHash, other);
    const { baselineCatalogVersionHash: _a, ...restA } = a;
    const { baselineCatalogVersionHash: _b, ...restB } = b;
    assert.deepEqual(restA, restB);
  });

  it('15) 소스에 네트워크·환경변수·파일 시스템·시계 접근이 없다', () => {
    const source = readFileSync(
      new URL('../../supabase/functions/_shared/automatic-scripture-catalog-analysis-environment.ts', import.meta.url),
      'utf8',
    );
    for (const banned of [
      'fetch(',
      'Deno.env',
      'process.env',
      'createClient(',
      '/rest/v1/',
      'service_role',
      'Date.now(',
      'new Date(',
      'readFileSync',
      'readFile(',
      'require(',
    ]) {
      assert.equal(source.includes(banned), false, banned);
    }
  });
});
