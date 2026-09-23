/** Git 고정 분석 산출물과 safetyBoundary·corpusRegression adapter의 실제 계약 테스트. */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  canonicalJson,
  computeCatalogVersionHash,
  type ScriptureCatalogCandidate,
} from '../../supabase/functions/_shared/automatic-scripture-catalog-contract.ts';
import { THEOLOGY_RUBRIC_CRITERION_IDS } from '../../supabase/functions/_shared/automatic-scripture-catalog-validator-registry.ts';
import { executeAutomaticScriptureCatalogValidation } from '../../supabase/functions/_shared/automatic-scripture-catalog-validator-executor.ts';
import { validateAnalysisSnapshot } from '../../supabase/functions/_shared/automatic-scripture-catalog-analysis-snapshot-contract.ts';
import { validateAnalysisSnapshotAgainstCurrentEnvironment } from '../../supabase/functions/_shared/automatic-scripture-catalog-analysis-environment.ts';
import { FROZEN_ANALYSIS_SNAPSHOT_V1 } from '../../supabase/functions/_shared/automatic-scripture-catalog-analysis-snapshot-v1.ts';
import {
  buildFrozenAnalysisDeterministicAdapters,
  buildVersionedFrozenAnalysisDeterministicAdapters,
  catalogSnapshotToGateCards,
} from '../../supabase/functions/_shared/automatic-scripture-catalog-frozen-analysis-adapter.ts';
import {
  buildBaselineCatalog,
  finalizeCandidate,
  FIXTURE_DEMAND_WINDOW,
  makeExistingDomainCandidate,
  makeDemandCells,
  makeNewDomainCandidate,
  resolveKrvPassage,
} from './automatic-scripture-catalog-test-fixtures.ts';

const EXPECTED = {
  fingerprint: 'sart_2ef11743f6cbb60390b1b083114f15e1dcbfeb88ef2fcd94da7f2bfd7ed869c4',
  sourceCorpusArtifactHash: 'sart_747941fe33c21d7f765464a69cfe6bb3045f7aa5b215e2cd9923d02c9b4711f4',
  frozenAnalysisArtifactHash: 'sart_30fd74c9376bb3a1bf798d05376ee02320a3a37a26606c099aa9b2905dca1183',
  baselineCatalogVersionHash: 'scat_7d27e84df2148b85cbadcdb31b402e762a5ce9d4477722426b13bc5bff337110',
} as const;

async function adapters() {
  const result = await buildVersionedFrozenAnalysisDeterministicAdapters(buildBaselineCatalog());
  if (!result.ok) throw new Error(result.errors.join(' / '));
  assert.equal(result.ok, true);
  return result.adapters;
}

function walkKeys(value: unknown, keys: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) walkKeys(item, keys);
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      keys.push(key);
      walkKeys(child, keys);
    }
  }
  return keys;
}

describe('Git 고정 분석 스냅샷 v1', () => {
  it('156건·두 종류·세 지문·기준 catalog 지문을 생성 당시 값으로 고정한다', () => {
    const snapshot = FROZEN_ANALYSIS_SNAPSHOT_V1;
    assert.equal(snapshot.cases.length, 156);
    assert.equal(snapshot.cases.filter((item) => item.kind === 'corpus_regression').length, 153);
    assert.equal(snapshot.cases.filter((item) => item.kind === 'safety_boundary').length, 3);
    assert.equal(snapshot.fingerprint, EXPECTED.fingerprint);
    assert.equal(snapshot.sourceCorpusArtifactHash, EXPECTED.sourceCorpusArtifactHash);
    assert.equal(snapshot.frozenAnalysisArtifactHash, EXPECTED.frozenAnalysisArtifactHash);
    assert.equal(snapshot.environment.baselineCatalogVersionHash, EXPECTED.baselineCatalogVersionHash);
  });

  it('저장 계약의 하위 해시·최상위 fingerprint를 실제 cases에서 다시 계산해 통과한다', async () => {
    assert.deepEqual(await validateAnalysisSnapshot(FROZEN_ANALYSIS_SNAPSHOT_V1), { valid: true, errors: [] });
  });

  it('현재 Git의 기준 catalog·Analyzer·Gate·Matcher 환경과 정확히 결속된다', async () => {
    const baseHash = await computeCatalogVersionHash(buildBaselineCatalog());
    assert.equal(baseHash, EXPECTED.baselineCatalogVersionHash);
    assert.deepEqual(
      await validateAnalysisSnapshotAgainstCurrentEnvironment(FROZEN_ANALYSIS_SNAPSHOT_V1, baseHash),
      { valid: true, errors: [] },
    );
  });

  it('raw response·reasoning·token usage·사용자 식별 필드를 저장하지 않는다', () => {
    const forbidden = new Set([
      'rawResponse',
      'reasoning',
      'tokenUsage',
      'usage',
      'userId',
      'sessionId',
      'email',
      'phone',
      'ipAddress',
    ]);
    const found = [...new Set(walkKeys(FROZEN_ANALYSIS_SNAPSHOT_V1).filter((key) => forbidden.has(key)))];
    assert.deepEqual(found, []);
  });

  it('생성 산출물은 런타임 파일·네트워크·환경변수 접근 코드를 포함하지 않는다', () => {
    const source = readFileSync(
      new URL('../../supabase/functions/_shared/automatic-scripture-catalog-analysis-snapshot-v1.ts', import.meta.url),
      'utf8',
    );
    for (const marker of ['readFile', 'writeFile', 'fetch(', 'Deno.', 'process.env', 'OPENAI_API_KEY']) {
      assert.equal(source.includes(marker), false, marker);
    }
  });
});

describe('고정 분석 deterministic adapter', () => {
  it('CatalogCard를 Gate 카드로 모든 본문·태그·설명을 보존해 투영한다', () => {
    const base = buildBaselineCatalog();
    const cards = catalogSnapshotToGateCards(base);
    assert.equal(cards.length, base.cards.length);
    for (const card of cards) {
      const source = base.cards.find((item) => item.id === card.id)!;
      assert.equal(card.domains[0], source.domainId);
      assert.deepEqual(card.passages, source.passages);
      assert.deepEqual(card.passage, source.passages[0]);
      assert.equal(card.referenceLabel, source.referenceLabel);
      assert.deepEqual(card.situationTags, source.situationTags);
      assert.deepEqual(card.misuseGuards, source.misuseGuards);
    }
  });

  it('스냅샷 fingerprint를 evaluation corpus version으로 내보낸다', async () => {
    assert.equal((await adapters()).evaluationCorpusVersion, EXPECTED.fingerprint);
  });

  it('버전 진입점은 저장소의 v1 산출물을 직접 선택하며 임의 snapshot 인자를 받지 않는다', () => {
    assert.equal(buildVersionedFrozenAnalysisDeterministicAdapters.length, 1);
  });

  it('유효하지만 다른 기준 catalog면 부분 adapter 없이 거절한다', async () => {
    const base = buildBaselineCatalog();
    base.domains[0].description += ' 변경';
    const result = await buildFrozenAnalysisDeterministicAdapters(FROZEN_ANALYSIS_SNAPSHOT_V1, base);
    assert.equal(result.ok, false);
    if (result.ok) throw new Error('거절되어야 합니다.');
    assert.deepEqual(result.errors, [
      'environment.baselineCatalogVersionHash: 스냅샷 값이 지금 저장소의 실제 값과 다릅니다.',
    ]);
  });

  it('safetyBoundary 3건을 후보 catalog로 실행하고 기대 route와 전부 일치시킨다', async () => {
    const base = buildBaselineCatalog();
    const { candidate } = await makeExistingDomainCandidate(base);
    const payload = await (await adapters()).evaluateSafetyBoundary(candidate);
    assert.equal(payload.rulesVersion, EXPECTED.fingerprint);
    assert.deepEqual(payload.cases.map((item) => item.caseId), ['SAFE-001', 'SAFE-002', 'SAFE-003']);
    assert.equal(payload.cases.every((item) => item.expectedRoute === item.observedRoute), true);
  });

  it('corpusRegression 153건을 오름차순으로 만들고 기준 결과를 실제 Gate에서 계산한다', async () => {
    const base = buildBaselineCatalog();
    const { candidate } = await makeExistingDomainCandidate(base);
    const payload = await (await adapters()).evaluateCorpusRegression(candidate);
    assert.equal(payload.corpusVersion, EXPECTED.fingerprint);
    assert.equal(payload.cases.length, 153);
    assert.deepEqual(
      payload.cases.map((item) => item.caseId),
      [...payload.cases.map((item) => item.caseId)].sort(),
    );
    assert.equal(payload.cases.filter((item) => item.baseline.domainMatch).length, 153);
    assert.equal(payload.cases.filter((item) => item.baseline.acceptableMatch).length, 143);
    assert.equal(payload.cases.some((item) => item.baseline.safetyFalsePositive), false);
  });

  it('기존 영역과 겹치지 않는 새 영역 후보는 고정 코퍼스 결과를 바꾸지 않는다', async () => {
    const base = buildBaselineCatalog();
    const { candidate } = await makeNewDomainCandidate(base);
    const payload = await (await adapters()).evaluateCorpusRegression(candidate);
    for (const item of payload.cases) assert.deepEqual(item.candidate, item.baseline, item.caseId);
  });

  it('기존 SC-002와 같은 의미 점수를 내는 새 카드가 허용 결과를 가로채면 회귀로 드러낸다', async () => {
    const base = buildBaselineCatalog();
    const { candidate: template } = await makeExistingDomainCandidate(base);
    const source = structuredClone(base.cards.find((item) => item.id === 'SC-002')!);
    const { candidate } = await finalizeCandidate(base, {
      contractVersion: template.contractVersion,
      candidateKind: template.candidateKind,
      targetDomainId: template.targetDomainId,
      newDomain: null,
      cards: [
        {
          ...source,
          id: template.cards[0].id,
          referenceLabel: template.cards[0].referenceLabel,
          passages: structuredClone(template.cards[0].passages),
        },
      ],
      demandBinding: structuredClone(template.demandBinding),
      sourceResearchResultHash: template.sourceResearchResultHash,
      generation: structuredClone(template.generation),
    });
    const payload = await (await adapters()).evaluateCorpusRegression(candidate);
    const regressions = payload.cases
      .filter((item) => item.baseline.acceptableMatch && !item.candidate.acceptableMatch)
      .map((item) => item.caseId);
    assert.deepEqual(regressions, [
      'EVAL-008',
      'EVAL-010',
      'EVAL-011',
      'EVAL-015',
      'EVAL-016',
      'EVAL-017',
      'EVAL-088',
      'EVAL-089',
      'EVAL-090',
    ]);
  });

  it('반환 payload를 바꿔도 다음 실행과 고정 스냅샷은 변하지 않는다', async () => {
    const base = buildBaselineCatalog();
    const { candidate } = await makeNewDomainCandidate(base);
    const evaluator = await adapters();
    const first = await evaluator.evaluateCorpusRegression(candidate);
    const originalSnapshot = canonicalJson(FROZEN_ANALYSIS_SNAPSHOT_V1);
    first.cases[0].candidate.acceptableMatch = !first.cases[0].candidate.acceptableMatch;
    first.cases.reverse();
    const second = await evaluator.evaluateCorpusRegression(candidate);
    assert.equal(second.cases[0].caseId, 'EVAL-001');
    assert.deepEqual(second.cases[0].candidate, second.cases[0].baseline);
    assert.equal(canonicalJson(FROZEN_ANALYSIS_SNAPSHOT_V1), originalSnapshot);
  });

  it('생성 뒤 호출자가 원본 snapshot·baseCatalog를 바꿔도 검증 시점 복제본만 사용한다', async () => {
    const base = buildBaselineCatalog();
    const snapshot = structuredClone(FROZEN_ANALYSIS_SNAPSHOT_V1);
    const { candidate } = await makeExistingDomainCandidate(base);
    const built = await buildFrozenAnalysisDeterministicAdapters(snapshot, base);
    if (!built.ok) throw new Error(built.errors.join(' / '));
    assert.equal(built.ok, true);
    const beforeSafety = await built.adapters.evaluateSafetyBoundary(candidate);
    const beforeCorpus = await built.adapters.evaluateCorpusRegression(candidate);

    snapshot.fingerprint = `sart_${'0'.repeat(64)}`;
    snapshot.cases = [...snapshot.cases].reverse();
    snapshot.cases[0].analysis.safety.level = 'urgent';
    base.cards.splice(0, base.cards.length);
    base.domains[0].description = '검증 뒤 바꾼 값';

    assert.deepEqual(await built.adapters.evaluateSafetyBoundary(candidate), beforeSafety);
    assert.deepEqual(await built.adapters.evaluateCorpusRegression(candidate), beforeCorpus);
    assert.equal(built.adapters.evaluationCorpusVersion, EXPECTED.fingerprint);
  });

  it('후보 지문·내용 계약이 어긋나면 payload를 만들지 않고 예외로 닫힌다', async () => {
    const base = buildBaselineCatalog();
    const { candidate } = await makeExistingDomainCandidate(base);
    const broken = structuredClone(candidate) as ScriptureCatalogCandidate;
    broken.proposedVersionHash = `scat_${'0'.repeat(64)}`;
    await assert.rejects(() => (adapters()).then((item) => item.evaluateCorpusRegression(broken)), /후보가 기준 카탈로그 계약/);
  });

  it('executor가 두 실제 adapter payload를 파싱·봉인한다(candidateGeneration은 명시적 fixture)', async () => {
    const base = buildBaselineCatalog();
    const { candidate } = await makeExistingDomainCandidate(base);
    const frozen = await adapters();
    const generationCases = candidate.cards.flatMap((card, cardIndex) =>
      Array.from({ length: 3 }, (_, caseIndex) => ({
        caseId: `GEN-${cardIndex + 1}-${caseIndex + 1}`,
        cardId: card.id,
        passed: true,
      })),
    );
    const theology = async () =>
      candidate.cards.map((card) => ({
        cardId: card.id,
        criteria: THEOLOGY_RUBRIC_CRITERION_IDS.map((criterionId) => ({ criterionId, verdict: 'pass' as const })),
      }));
    const result = await executeAutomaticScriptureCatalogValidation({
      candidate,
      baseCatalog: base,
      demandWindow: FIXTURE_DEMAND_WINDOW,
      demandCells: makeDemandCells(candidate.demandBinding),
      evaluationCorpusVersion: frozen.evaluationCorpusVersion,
      deterministic: {
        resolvePassageText: resolveKrvPassage,
        evaluateSafetyBoundary: frozen.evaluateSafetyBoundary,
        evaluateCorpusRegression: frozen.evaluateCorpusRegression,
        // 이 단계는 아직 구현 대상이다. 빈 결과로 속이지 않고 테스트 fixture라고 명시한다.
        evaluateCandidateGeneration: async () => ({ evidenceArtifactHash: `sart_${'e'.repeat(64)}`, cases: generationCases }),
      },
      evaluateSol: theology,
      evaluateAstra: theology,
    });
    assert.equal(result.kind, 'validated');
    if (result.kind !== 'validated') throw new Error(JSON.stringify(result));
    assert.equal(result.record.checks.safetyBoundary.status, 'pass');
    assert.equal(result.record.checks.corpusRegression.status, 'pass');
    assert.equal(result.record.checks.safetyBoundary.payload.cases.length, 3);
    assert.equal(result.record.checks.corpusRegression.payload.cases.length, 153);
    assert.equal(result.record.dataVersions.evaluationCorpusVersion, EXPECTED.fingerprint);
  });

  it('adapter 구현도 파일·네트워크·환경변수·시계를 읽지 않는다', () => {
    const source = readFileSync(
      new URL('../../supabase/functions/_shared/automatic-scripture-catalog-frozen-analysis-adapter.ts', import.meta.url),
      'utf8',
    );
    for (const marker of ['node:fs', 'readFile', 'writeFile', 'fetch(', 'Deno.', 'process.env', 'Date.now', 'new Date']) {
      assert.equal(source.includes(marker), false, marker);
    }
  });
});
