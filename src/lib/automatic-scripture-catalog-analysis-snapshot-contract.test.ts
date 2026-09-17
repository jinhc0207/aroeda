/**
 * 자동 Scripture Catalog 분석 스냅샷 계약 테스트 — 지문 결속과 fail-closed 거절
 *
 * 실행: npm run test:logic
 *
 * 무엇을 증명하는가
 *   sourceCorpusArtifactHash·frozenAnalysisArtifactHash가 cases에서 직접 재계산한 값과
 *   대조된다는 것(형식만 맞는 임의의 해시로는 top-level fingerprint를 아무리 다시 맞춰도
 *   통과하지 못한다). safety_boundary·corpus_regression 두 종류가 각각 최소 1개 있어야
 *   한다는 것. frozen analysis와 expected가 서로 다른 사건을 가리키면(예: urgent 분석에
 *   normal expectedSafety, 또는 recommend route인데 다른 domain) 거절된다는 것.
 *   candidate_generation·사람 승인 필드·사용자 식별정보 형태 필드·raw response류 필드가
 *   구조적으로 거절된다는 것.
 *
 * 무엇을 증명하지 않는가
 *   이 계약이 executor나 활성화 경로에 연결됐다는 것(아직 연결하지 않았다). 실제 Gate·Matcher·
 *   Analyzer를 이 스냅샷으로 실행했을 때의 결과. 그런 실행은 이 파일 어디에도 없다. 자동
 *   producer profile·독립성 attestation이 registry에 연결됐다는 것(아직 없다).
 */

import assert from 'node:assert/strict';
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
import type { SituationAnalysis } from '../../supabase/functions/_shared/situation-analysis.ts';

/* ------------------------------------------------------------------ */
/* 고정 자료 — SC-001(두려움·불확실성) 카드의 실제 태그만 사용한다.           */
/* ------------------------------------------------------------------ */

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

const DOMAIN_CHOICE_ANALYSIS: SituationAnalysis = {
  domainPriority: 'needs_choice',
  primaryDomain: null,
  domainChoiceCandidates: ['fear_uncertainty', 'decision_guidance'],
  secondaryDomains: [],
  situationTags: [],
  emotionTags: [],
  spiritualQuestionTags: [],
  prayerModes: [],
  pastoralFunctions: [],
  safety: { level: 'normal', categories: [] },
  confidence: 0.8,
};

const NO_COVERAGE_ANALYSIS: SituationAnalysis = {
  domainPriority: 'resolved',
  primaryDomain: 'other_uncovered',
  domainChoiceCandidates: [],
  secondaryDomains: [],
  situationTags: [],
  emotionTags: [],
  spiritualQuestionTags: [],
  prayerModes: [],
  pastoralFunctions: [],
  safety: { level: 'normal', categories: [] },
  confidence: 0.7,
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

const CORP_DOMAIN_CHOICE_CASE: AnalysisSnapshotCase = {
  caseId: 'CORP-002',
  kind: 'corpus_regression',
  text: '진로도 고민되고 앞일도 막막해요.',
  analysis: DOMAIN_CHOICE_ANALYSIS,
  expected: {
    expectedRoute: 'domain_choice',
    expectedPrimaryDomain: null,
    expectedDomainChoiceCandidates: ['fear_uncertainty', 'decision_guidance'],
  },
};

const CORP_NO_COVERAGE_CASE: AnalysisSnapshotCase = {
  caseId: 'CORP-003',
  kind: 'corpus_regression',
  text: '이건 지금 분류에 들어맞지 않는 상황이에요.',
  analysis: NO_COVERAGE_ANALYSIS,
  expected: { expectedRoute: 'no_coverage', expectedPrimaryDomain: 'other_uncovered' },
};

async function buildEnvironment(): Promise<AnalysisSnapshotEnvironmentBinding> {
  return {
    analyzerModel: 'gpt-5.6-luna',
    analyzerInstructionsHash: await computeArtifactHash({ fixture: 'instructions' }),
    analyzerSchemaHash: await computeArtifactHash({ fixture: 'schema' }),
    analysisTaxonomyHash: await computeArtifactHash({ fixture: 'taxonomy' }),
    analyzerDomainManifestHash: await computeArtifactHash({ fixture: 'domain-manifest' }),
    recommendationGate: { kind: 'version', version: 'recommendation-gate/fixture-v1' },
    scriptureMatcher: { kind: 'version', version: 'scripture-matcher/fixture-v1' },
    baselineCatalogVersionHash: `scat_${'a'.repeat(64)}`,
  };
}

function defaultCases(): AnalysisSnapshotCase[] {
  return [CORP_RECOMMEND_CASE, SAFE_CASE];
}

/**
 * 주어진 알맹이(cases 포함)에서 두 하위 해시와 top-level fingerprint를 모두 cases에서
 * 직접 재계산해 붙인다. 저장된 값을 신뢰하지 않는다 — "정상적으로 갱신한" 스냅샷을 만들 때만 쓴다.
 */
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

async function buildValidSnapshot(cases: readonly AnalysisSnapshotCase[] = defaultCases()): Promise<FrozenAnalysisSnapshot> {
  return sealWithCases({ contractVersion: ANALYSIS_SNAPSHOT_CONTRACT_VERSION, environment: await buildEnvironment() }, cases);
}

/** top-level fingerprint만 cases와 무관하게 다시 계산해 붙인다. 두 하위 해시는 그대로 둔다(위조 흉내). */
async function sealTopOnly(
  core: Omit<FrozenAnalysisSnapshot, 'fingerprint'> | FrozenAnalysisSnapshot,
): Promise<FrozenAnalysisSnapshot> {
  const { fingerprint: _drop, ...rest } = core as FrozenAnalysisSnapshot;
  return { ...rest, fingerprint: await computeAnalysisSnapshotFingerprint(rest) };
}

/** 원본은 그대로 두고, patch만 얕게 덮어써 새 스냅샷을 만든다. 어떤 해시도 다시 계산하지 않는다 — 위조·갱신 누락을 흉내낸다. */
function stale(base: FrozenAnalysisSnapshot, patch: Partial<FrozenAnalysisSnapshot>): FrozenAnalysisSnapshot {
  return { ...base, ...patch };
}

describe('automatic-scripture-catalog-analysis-snapshot-contract', () => {
  it('정상 스냅샷은 통과한다(safety_boundary·corpus_regression 함께, 두 하위 해시도 cases와 일치)', async () => {
    const result = await validateAnalysisSnapshot(await buildValidSnapshot());
    assert.deepEqual(result, { valid: true, errors: [] });
  });

  it('객체가 아니면 거절한다', async () => {
    for (const bad of [null, 'x', 42, [], undefined]) {
      const result = await validateAnalysisSnapshot(bad);
      assert.equal(result.valid, false);
    }
  });

  it('최상위 필드가 하나 빠지면 거절한다', async () => {
    const snapshot = await buildValidSnapshot();
    const { environment: _drop, ...withoutEnvironment } = snapshot;
    const result = await validateAnalysisSnapshot(withoutEnvironment);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((message) => message.includes('빠진 항목입니다: environment')));
  });

  it('최상위에 알 수 없는 필드를 더하면 거절한다', async () => {
    const snapshot = await buildValidSnapshot();
    const result = await validateAnalysisSnapshot({ ...snapshot, extra: 'x' });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((message) => message.includes('계약에 없는 항목입니다: extra')));
  });

  it('contractVersion이 다르면 거절한다', async () => {
    const snapshot = await buildValidSnapshot();
    const result = await validateAnalysisSnapshot({ ...snapshot, contractVersion: 'scripture-catalog-analysis-snapshot/v2' });
    assert.equal(result.valid, false);
  });

  it('cases가 빈 배열이면 거절한다', async () => {
    const snapshot = await buildValidSnapshot();
    const result = await validateAnalysisSnapshot(stale(snapshot, { cases: [] }));
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((message) => message.includes('cases')));
  });

  it('caseId 순서를 뒤바꾸면(지문은 그 순서에 맞게 다시 계산해도) 거절한다', async () => {
    const snapshot = await buildValidSnapshot();
    const reordered = [snapshot.cases[1], snapshot.cases[0]];
    const sealedButUnsorted = await sealTopOnly({ ...snapshot, cases: reordered });
    const result = await validateAnalysisSnapshot(sealedButUnsorted);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((message) => message.includes('오름차순')));
  });

  it('caseId를 중복시키면(지문을 다시 계산해도) 거절한다', async () => {
    const snapshot = await buildValidSnapshot();
    const duplicated = [snapshot.cases[0], { ...snapshot.cases[0] }];
    const sealedButDuplicated = await sealTopOnly({ ...snapshot, cases: duplicated });
    const result = await validateAnalysisSnapshot(sealedButDuplicated);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((message) => message.includes('오름차순') || message.includes('중복')));
  });

  it('caseId 형식이 어긋나면 거절한다', async () => {
    const snapshot = await buildValidSnapshot();
    const bad = [{ ...snapshot.cases[0], caseId: '이건 caseId 형식이 아니다' }, snapshot.cases[1]];
    const result = await validateAnalysisSnapshot(await sealTopOnly({ ...snapshot, cases: bad }));
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((message) => message.includes('caseId')));
  });

  it('잘못된 SituationAnalysis는(지문을 다시 계산해도) validateSituationAnalysis가 잡는다', async () => {
    const snapshot = await buildValidSnapshot();
    const brokenAnalysis: SituationAnalysis = { ...RECOMMEND_ANALYSIS, domainPriority: 'resolved', primaryDomain: null };
    const cases = [{ ...snapshot.cases[0], analysis: brokenAnalysis }, snapshot.cases[1]];
    const result = await validateAnalysisSnapshot(await sealTopOnly({ ...snapshot, cases }));
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((message) => message.includes('.analysis:')));
  });

  it('candidate_generation 사례를 넣으면 명시적으로 거절한다', async () => {
    const snapshot = await buildValidSnapshot();
    const withCandidateGeneration = [
      ...snapshot.cases,
      {
        caseId: 'ZZZZ-999',
        kind: 'candidate_generation',
        text: '이 문장은 통과하면 안 된다.',
        analysis: RECOMMEND_ANALYSIS,
        expected: { cardId: 'SC-001', passed: true },
      },
    ];
    const result = await validateAnalysisSnapshot(stale(snapshot, { cases: withCandidateGeneration as unknown as FrozenAnalysisSnapshot['cases'] }));
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((message) => message.includes('candidate_generation')));
  });

  for (const forbiddenField of ['reviewedBy', 'reviewedAt', 'humanApproval', 'humanSignature']) {
    it(`사람 승인 필드(${forbiddenField})를 최상위에 넣으면 거절한다`, async () => {
      const snapshot = await buildValidSnapshot();
      const result = await validateAnalysisSnapshot({ ...snapshot, [forbiddenField]: 'x' });
      assert.equal(result.valid, false);
      assert.ok(result.errors.some((message) => message.includes(`계약에 없는 항목입니다: ${forbiddenField}`)));
    });
  }

  for (const forbiddenField of ['rawResponse', 'reasoning', 'tokenUsage', 'providerErrorMessage']) {
    it(`raw response류 필드(${forbiddenField})를 사례 안에 넣으면 거절한다`, async () => {
      const snapshot = await buildValidSnapshot();
      const cases = [{ ...snapshot.cases[0], [forbiddenField]: 'x' }, snapshot.cases[1]];
      const result = await validateAnalysisSnapshot(stale(snapshot, { cases: cases as unknown as FrozenAnalysisSnapshot['cases'] }));
      assert.equal(result.valid, false);
      assert.ok(result.errors.some((message) => message.includes(`계약에 없는 항목입니다: ${forbiddenField}`)));
    });
  }

  it('sessionId 같은 개인정보 키 이름을 확장 필드로 넣어도(스키마에 자리가 없으므로) 거절한다', async () => {
    const snapshot = await buildValidSnapshot();
    const result = await validateAnalysisSnapshot({ ...snapshot, sessionId: 'abc-123' });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((message) => message.includes('계약에 없는 항목입니다: sessionId')));
  });

  it('문장에 이메일처럼 보이는 값이 있으면 scanForbiddenContent가 잡는다', async () => {
    const snapshot = await buildValidSnapshot();
    const cases = [{ ...snapshot.cases[0], text: 'contact me at test@example.com' }, snapshot.cases[1]];
    const result = await validateAnalysisSnapshot(await sealTopOnly({ ...snapshot, cases }));
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((message) => message.includes('개인정보·자격 증명처럼 보이는 값')));
  });

  it('구조 위반이 없을 때는 정상 스냅샷의 오류가 하나도 없다(위 이메일 검사와 대조군)', async () => {
    const snapshot = await buildValidSnapshot();
    const result = await validateAnalysisSnapshot(snapshot);
    assert.equal(result.errors.length, 0);
  });

  /* ================================================================
   * 수정 전 재현 — 하위 해시가 cases와 무관해도 top-level fingerprint만
   * 맞추면 통과하던 결함. 이 스위트는 지금 구현이 이를 실제로 거절하는지 고정한다.
   * ================================================================ */

  it('[재현] cases와 무관한 sourceCorpusArtifactHash + 임의 Gate/Matcher version이어도, 수정 전이면 통과했다 — 지금은 거절한다', async () => {
    const environment = await buildEnvironment();
    const forgedEnvironment: AnalysisSnapshotEnvironmentBinding = {
      ...environment,
      recommendationGate: { kind: 'version', version: 'recommendation-gate/아무-버전' },
      scriptureMatcher: { kind: 'version', version: 'scripture-matcher/아무-버전' },
    };
    const cases = [SAFE_CASE]; // safety_boundary 하나만, corpus_regression 0개
    const forgedSourceHash = await computeArtifactHash({ arbitrary: 'not-derived-from-cases' });
    const forgedFrozenHash = await computeArtifactHash({ arbitrary: 'also-not-derived-from-cases' });
    // "위 값으로 최상위 fingerprint만 다시 계산" — top-level만 자기 일관되게 맞춘다.
    const forged = await sealTopOnly({
      contractVersion: ANALYSIS_SNAPSHOT_CONTRACT_VERSION,
      sourceCorpusArtifactHash: forgedSourceHash,
      frozenAnalysisArtifactHash: forgedFrozenHash,
      environment: forgedEnvironment,
      cases,
    });
    const result = await validateAnalysisSnapshot(forged);
    assert.equal(result.valid, false);
    // 두 하위 해시가 cases와 무관하다는 것과, corpus_regression이 없다는 것을 모두 잡아야 한다.
    assert.ok(result.errors.includes('snapshot.cases: corpus_regression 사례가 최소 1개 있어야 합니다.'));
  });

  /* ================================================================
   * 수정 1 — 하위 해시를 cases에서 직접 재계산
   * ================================================================ */

  it('1) source corpus hash가 cases와 무관하면 top-level fingerprint를 다시 계산해도 거절한다', async () => {
    const valid = await buildValidSnapshot();
    const forgedSourceHash = await computeArtifactHash({ arbitrary: 'unrelated-to-cases' });
    const forged = await sealTopOnly({ ...valid, sourceCorpusArtifactHash: forgedSourceHash });
    const result = await validateAnalysisSnapshot(forged);
    assert.deepEqual(result.errors, ['snapshot.sourceCorpusArtifactHash: cases에서 다시 계산한 값과 다릅니다.']);
  });

  it('2) frozen analysis hash가 cases와 무관하면 top-level fingerprint를 다시 계산해도 거절한다', async () => {
    const valid = await buildValidSnapshot();
    const forgedFrozenHash = await computeArtifactHash({ arbitrary: 'unrelated-to-cases' });
    const forged = await sealTopOnly({ ...valid, frozenAnalysisArtifactHash: forgedFrozenHash });
    const result = await validateAnalysisSnapshot(forged);
    assert.deepEqual(result.errors, ['snapshot.frozenAnalysisArtifactHash: cases에서 다시 계산한 값과 다릅니다.']);
  });

  it('3) text 변경 후 source hash와 top-level fingerprint를 갱신하지 않으면 거절한다', async () => {
    const snapshot = await buildValidSnapshot();
    const cases = [{ ...snapshot.cases[0], text: `${snapshot.cases[0].text}!` }, snapshot.cases[1]];
    // sourceCorpusArtifactHash도 fingerprint도 갱신하지 않는다 — "수정을 깜빡한" 상태를 흉내낸다.
    const result = await validateAnalysisSnapshot(stale(snapshot, { cases: cases as unknown as FrozenAnalysisSnapshot['cases'] }));
    assert.deepEqual(result.errors, ['snapshot.sourceCorpusArtifactHash: cases에서 다시 계산한 값과 다릅니다.']);
  });

  it('4) analysis 변경 후 frozen hash와 top-level fingerprint를 갱신하지 않으면 거절한다', async () => {
    const snapshot = await buildValidSnapshot();
    const mutatedAnalysis: SituationAnalysis = { ...RECOMMEND_ANALYSIS, situationTags: [...RECOMMEND_ANALYSIS.situationTags, '위협'] };
    const cases = [{ ...snapshot.cases[0], analysis: mutatedAnalysis }, snapshot.cases[1]];
    const result = await validateAnalysisSnapshot(stale(snapshot, { cases: cases as unknown as FrozenAnalysisSnapshot['cases'] }));
    assert.deepEqual(result.errors, ['snapshot.frozenAnalysisArtifactHash: cases에서 다시 계산한 값과 다릅니다.']);
  });

  it('5) 두 하위 해시와 top-level fingerprint를 모두 올바르게 재생성하면 통과한다', async () => {
    const snapshot = await buildValidSnapshot();
    const mutatedCase = { ...snapshot.cases[0], text: '완전히 새로 고정한 다른 문장이에요.' };
    const cases = [mutatedCase, snapshot.cases[1]];
    const resealed = await sealWithCases({ contractVersion: snapshot.contractVersion, environment: snapshot.environment }, cases);
    const result = await validateAnalysisSnapshot(resealed);
    assert.deepEqual(result, { valid: true, errors: [] });
  });

  /* ================================================================
   * 수정 2 — 두 검사 종류가 모두 존재해야 함
   * ================================================================ */

  it('6) safety_boundary 사례만 있으면 거절한다', async () => {
    const valid = await buildValidSnapshot();
    const onlySafety = stale(valid, { cases: [SAFE_CASE] });
    const result = await validateAnalysisSnapshot(onlySafety);
    assert.deepEqual(result.errors, ['snapshot.cases: corpus_regression 사례가 최소 1개 있어야 합니다.']);
  });

  it('7) corpus_regression 사례만 있으면 거절한다', async () => {
    const valid = await buildValidSnapshot();
    const onlyCorpus = stale(valid, { cases: [CORP_RECOMMEND_CASE] });
    const result = await validateAnalysisSnapshot(onlyCorpus);
    assert.deepEqual(result.errors, ['snapshot.cases: safety_boundary 사례가 최소 1개 있어야 합니다.']);
  });

  /* ================================================================
   * 수정 3 — frozen analysis와 expected의 교차 일관성
   * ================================================================ */

  it('8) urgent analysis + normal expectedSafety는 거절한다', async () => {
    const valid = await buildValidSnapshot();
    const mutatedSafeCase = { ...SAFE_CASE, expected: { ...SAFE_CASE.expected, expectedSafety: { level: 'normal' as const, categories: [] } } };
    const result = await validateAnalysisSnapshot(stale(valid, { cases: [CORP_RECOMMEND_CASE, mutatedSafeCase] }));
    assert.deepEqual(result.errors, ['snapshot.cases[1]: expectedSafety가 analysis.safety와 canonical 값까지 정확히 같아야 합니다.']);
  });

  it('9) urgent analysis + recommend route는 거절한다', async () => {
    const valid = await buildValidSnapshot();
    const mutatedSafeCase = { ...SAFE_CASE, expected: { ...SAFE_CASE.expected, expectedRoute: 'recommend' as const } };
    const result = await validateAnalysisSnapshot(stale(valid, { cases: [CORP_RECOMMEND_CASE, mutatedSafeCase] }));
    assert.deepEqual(result.errors, [
      'snapshot.cases[1]: analysis.safety.level이 normal이 아니면 expectedRoute는 반드시 safety여야 합니다.',
    ]);
  });

  it('10) normal analysis + safety route는 거절한다', async () => {
    const valid = await buildValidSnapshot();
    const normalSafetyAnalysis: SituationAnalysis = { ...SAFETY_ANALYSIS, safety: { level: 'normal', categories: [] } };
    const mutatedSafeCase = {
      ...SAFE_CASE,
      analysis: normalSafetyAnalysis,
      expected: { ...SAFE_CASE.expected, expectedSafety: { level: 'normal' as const, categories: [] } },
    };
    const result = await validateAnalysisSnapshot(stale(valid, { cases: [CORP_RECOMMEND_CASE, mutatedSafeCase] }));
    assert.deepEqual(result.errors, [
      'snapshot.cases[1]: analysis.safety.level이 normal이면 expectedRoute는 safety일 수 없습니다.',
    ]);
  });

  it('11) recommend의 expectedPrimaryDomain과 analysis.primaryDomain 불일치는 거절한다', async () => {
    const valid = await buildValidSnapshot();
    const mismatchedAnalysis: SituationAnalysis = { ...RECOMMEND_ANALYSIS, primaryDomain: 'decision_guidance' };
    const mutatedCorpCase = { ...CORP_RECOMMEND_CASE, analysis: mismatchedAnalysis };
    const result = await validateAnalysisSnapshot(stale(valid, { cases: [mutatedCorpCase, SAFE_CASE] }));
    assert.deepEqual(result.errors, ['snapshot.cases[0]: analysis.primaryDomain이 expectedPrimaryDomain과 정확히 같아야 합니다.']);
  });

  it('12) domain_choice 후보 불일치(순서 변경 포함)는 거절한다', async () => {
    // caseId 오름차순: CORP-002 < SAFE-001
    const baseline = await buildValidSnapshot([CORP_DOMAIN_CHOICE_CASE, SAFE_CASE]);
    assert.deepEqual((await validateAnalysisSnapshot(baseline)).errors, []); // 대조군: 뒤바꾸기 전엔 통과

    const reorderedCandidates = {
      ...CORP_DOMAIN_CHOICE_CASE,
      expected: { ...CORP_DOMAIN_CHOICE_CASE.expected, expectedDomainChoiceCandidates: ['decision_guidance', 'fear_uncertainty'] as const },
    };
    const result = await validateAnalysisSnapshot(stale(baseline, { cases: [reorderedCandidates, SAFE_CASE] }));
    assert.deepEqual(result.errors, [
      'snapshot.cases[0]: expectedDomainChoiceCandidates가 analysis.domainChoiceCandidates와 순서까지 정확히 같아야 합니다.',
    ]);
  });

  it('13) no_coverage인데 analysis.primaryDomain이 fallback이 아니면 거절한다', async () => {
    // caseId 오름차순: CORP-003 < SAFE-001
    const baseline = await buildValidSnapshot([CORP_NO_COVERAGE_CASE, SAFE_CASE]);
    assert.deepEqual((await validateAnalysisSnapshot(baseline)).errors, []); // 대조군

    const wrongPrimary = { ...CORP_NO_COVERAGE_CASE, analysis: { ...NO_COVERAGE_ANALYSIS, primaryDomain: 'fear_uncertainty' as const } };
    const result = await validateAnalysisSnapshot(stale(baseline, { cases: [wrongPrimary, SAFE_CASE] }));
    assert.deepEqual(result.errors, [
      "snapshot.cases[0]: expectedRoute가 no_coverage면 analysis.primaryDomain이 'other_uncovered'이어야 합니다.",
    ]);
  });

  it('14) corpus_regression에 non-normal safety가 있으면 거절한다', async () => {
    const valid = await buildValidSnapshot();
    const urgentCorpusAnalysis: SituationAnalysis = { ...RECOMMEND_ANALYSIS, safety: { level: 'urgent', categories: ['immediate_danger'] } };
    const mutatedCorpCase = { ...CORP_RECOMMEND_CASE, analysis: urgentCorpusAnalysis };
    const result = await validateAnalysisSnapshot(stale(valid, { cases: [mutatedCorpCase, SAFE_CASE] }));
    assert.deepEqual(result.errors, [
      'snapshot.cases[0]: corpus_regression 사례는 analysis.safety.level이 normal이어야 합니다(안전 route를 표현하지 않는다).',
    ]);
  });

  /* ================================================================
   * 중첩 추가 필드 거절 보완 — analysis(및 analysis.safety) 여분 필드
   *
   * 공용 validateSituationAnalysis는 알려진 필드의 값만 검사할 뿐, 거기 없는 필드가
   * 얹혀 있어도 거절하지 않는다. 아래 "[재현]" 두 테스트는 그 공백을 먼저 고정한다 —
   * 이 스위트가 검증하는 exactFields(analysis)·exactFields(analysis.safety) 호출을
   * 걷어내면(수동으로 확인함, 아래 "검증" 참고) 다시 통과하는 fixture다.
   * ================================================================ */

  it('[재현] analysis에 rawResponse·userId를 얹고 모든 해시를 올바르게 재계산해도 거절한다', async () => {
    const pollutedAnalysis = { ...RECOMMEND_ANALYSIS, rawResponse: 'provider output', userId: 'user-123' } as unknown as SituationAnalysis;
    const snapshot = await sealWithCases(
      { contractVersion: ANALYSIS_SNAPSHOT_CONTRACT_VERSION, environment: await buildEnvironment() },
      [{ ...CORP_RECOMMEND_CASE, analysis: pollutedAnalysis }, SAFE_CASE],
    );
    const result = await validateAnalysisSnapshot(snapshot);
    assert.equal(result.valid, false);
    assert.ok(result.errors.includes('snapshot.cases[0].analysis: 계약에 없는 항목입니다: rawResponse'));
    assert.ok(result.errors.includes('snapshot.cases[0].analysis: 계약에 없는 항목입니다: userId'));
  });

  it('[재현] corpus 사례의 analysis.safety에 sessionId를 얹어도(canonical 비교와 무관하게) 거절한다', async () => {
    // safety_boundary가 아니라 corpus_regression에 넣는다 — safety_boundary였다면
    // expectedSafety canonical 비교(교차 일관성)가 먼저 걸릴 수 있어, exact-fields
    // 검사 자체의 부재를 가려 재현하지 못했을 것이다.
    const pollutedAnalysis = {
      ...RECOMMEND_ANALYSIS,
      safety: { ...RECOMMEND_ANALYSIS.safety, sessionId: 'sess-1' },
    } as unknown as SituationAnalysis;
    const snapshot = await sealWithCases(
      { contractVersion: ANALYSIS_SNAPSHOT_CONTRACT_VERSION, environment: await buildEnvironment() },
      [{ ...CORP_RECOMMEND_CASE, analysis: pollutedAnalysis }, SAFE_CASE],
    );
    const result = await validateAnalysisSnapshot(snapshot);
    assert.deepEqual(result.errors, ['snapshot.cases[0].analysis.safety: 계약에 없는 항목입니다: sessionId']);
  });

  for (const field of ['userId', 'rawResponse', 'tokenUsage']) {
    it(`analysis.${field}는(하위 해시·fingerprint를 올바르게 재계산해도) 거절한다`, async () => {
      const polluted = { ...RECOMMEND_ANALYSIS, [field]: 'x' } as unknown as SituationAnalysis;
      const snapshot = await sealWithCases(
        { contractVersion: ANALYSIS_SNAPSHOT_CONTRACT_VERSION, environment: await buildEnvironment() },
        [{ ...CORP_RECOMMEND_CASE, analysis: polluted }, SAFE_CASE],
      );
      const result = await validateAnalysisSnapshot(snapshot);
      assert.deepEqual(result.errors, [`snapshot.cases[0].analysis: 계약에 없는 항목입니다: ${field}`]);
    });
  }

  for (const field of ['sessionId', 'providerErrorMessage']) {
    it(`analysis.safety.${field}는(하위 해시·fingerprint를 올바르게 재계산해도) 거절한다`, async () => {
      const polluted = { ...RECOMMEND_ANALYSIS, safety: { ...RECOMMEND_ANALYSIS.safety, [field]: 'x' } } as unknown as SituationAnalysis;
      const snapshot = await sealWithCases(
        { contractVersion: ANALYSIS_SNAPSHOT_CONTRACT_VERSION, environment: await buildEnvironment() },
        [{ ...CORP_RECOMMEND_CASE, analysis: polluted }, SAFE_CASE],
      );
      const result = await validateAnalysisSnapshot(snapshot);
      assert.deepEqual(result.errors, [`snapshot.cases[0].analysis.safety: 계약에 없는 항목입니다: ${field}`]);
    });
  }

  it('6) 정상 analysis는(하위 해시·fingerprint를 올바르게 재계산한 뒤에도) 그대로 통과한다', async () => {
    const snapshot = await buildValidSnapshot();
    const result = await validateAnalysisSnapshot(snapshot);
    assert.deepEqual(result, { valid: true, errors: [] });
  });

  /* ================================================================
   * 회귀 15·16 — environment·하위 해시 필드의 fingerprint 민감도
   * ================================================================ */

  for (const field of ['analyzerModel', 'analyzerInstructionsHash', 'analyzerSchemaHash', 'analysisTaxonomyHash', 'analyzerDomainManifestHash'] as const) {
    it(`15) environment.${field}를 바꾸면(cases는 그대로, fingerprint는 갱신 안 하면) 거절한다`, async () => {
      const snapshot = await buildValidSnapshot();
      const newValue = field === 'analyzerModel' ? 'gpt-6-astra' : await computeArtifactHash({ fixture: `different-${field}` });
      const environment: AnalysisSnapshotEnvironmentBinding = { ...snapshot.environment, [field]: newValue };
      const result = await validateAnalysisSnapshot(stale(snapshot, { environment }));
      assert.deepEqual(result.errors, ['snapshot.fingerprint: 저장된 값이 다시 계산한 지문과 다릅니다.']);
    });
  }

  it('environment.recommendationGate 결속을 바꾸면(지문은 그대로 두면) fingerprint 불일치로 거절한다', async () => {
    const snapshot = await buildValidSnapshot();
    const environment = { ...snapshot.environment, recommendationGate: { kind: 'version' as const, version: 'recommendation-gate/fixture-v2' } };
    const result = await validateAnalysisSnapshot(stale(snapshot, { environment }));
    assert.deepEqual(result.errors, ['snapshot.fingerprint: 저장된 값이 다시 계산한 지문과 다릅니다.']);
  });

  it('environment.scriptureMatcher 결속을 바꾸면(지문은 그대로 두면) fingerprint 불일치로 거절한다', async () => {
    const snapshot = await buildValidSnapshot();
    const environment = { ...snapshot.environment, scriptureMatcher: { kind: 'version' as const, version: 'scripture-matcher/fixture-v2' } };
    const result = await validateAnalysisSnapshot(stale(snapshot, { environment }));
    assert.deepEqual(result.errors, ['snapshot.fingerprint: 저장된 값이 다시 계산한 지문과 다릅니다.']);
  });

  it('environment.baselineCatalogVersionHash를 바꾸면(지문은 그대로 두면) fingerprint 불일치로 거절한다', async () => {
    const snapshot = await buildValidSnapshot();
    const environment = { ...snapshot.environment, baselineCatalogVersionHash: `scat_${'b'.repeat(64)}` };
    const result = await validateAnalysisSnapshot(stale(snapshot, { environment }));
    assert.deepEqual(result.errors, ['snapshot.fingerprint: 저장된 값이 다시 계산한 지문과 다릅니다.']);
  });

  it('16a) sourceCorpusArtifactHash만 다른 값으로 바꾸고 fingerprint를 갱신하지 않으면 거절한다', async () => {
    const snapshot = await buildValidSnapshot();
    const forged = stale(snapshot, { sourceCorpusArtifactHash: await computeArtifactHash({ fixture: 'swapped-source' }) });
    const result = await validateAnalysisSnapshot(forged);
    assert.deepEqual(result.errors, ['snapshot.sourceCorpusArtifactHash: cases에서 다시 계산한 값과 다릅니다.']);
  });

  it('16b) frozenAnalysisArtifactHash만 다른 값으로 바꾸고 fingerprint를 갱신하지 않으면 거절한다', async () => {
    const snapshot = await buildValidSnapshot();
    const forged = stale(snapshot, { frozenAnalysisArtifactHash: await computeArtifactHash({ fixture: 'swapped-frozen' }) });
    const result = await validateAnalysisSnapshot(forged);
    assert.deepEqual(result.errors, ['snapshot.frozenAnalysisArtifactHash: cases에서 다시 계산한 값과 다릅니다.']);
  });

  it('저장된 fingerprint 자체를 위조하면 거절한다', async () => {
    const snapshot = await buildValidSnapshot();
    const forged = stale(snapshot, { fingerprint: `sart_${'0'.repeat(64)}` });
    const result = await validateAnalysisSnapshot(forged);
    assert.deepEqual(result.errors, ['snapshot.fingerprint: 저장된 값이 다시 계산한 지문과 다릅니다.']);
  });

  it('fingerprint 형식이 아예 어긋나면 재계산 없이 형식 오류로 거절한다', async () => {
    const snapshot = await buildValidSnapshot();
    const result = await validateAnalysisSnapshot(stale(snapshot, { fingerprint: 'not-a-hash' }));
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((message) => message.includes('fingerprint: 형식이 올바르지 않습니다')));
  });

  it('sourceCorpusArtifactHash·frozenAnalysisArtifactHash 형식이 어긋나면 거절한다', async () => {
    const snapshot = await buildValidSnapshot();
    const result = await validateAnalysisSnapshot({ ...snapshot, sourceCorpusArtifactHash: 'not-a-hash', frozenAnalysisArtifactHash: 'also-not-a-hash' });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((message) => message.includes('sourceCorpusArtifactHash')));
    assert.ok(result.errors.some((message) => message.includes('frozenAnalysisArtifactHash')));
  });

  it('computeAnalysisSnapshotFingerprint는 결정적이다(같은 입력 → 같은 출력)', async () => {
    const snapshot = await buildValidSnapshot();
    const { fingerprint: _drop, ...core } = snapshot;
    const first = await computeAnalysisSnapshotFingerprint(core);
    const second = await computeAnalysisSnapshotFingerprint(core);
    assert.equal(first, second);
    assert.equal(first, snapshot.fingerprint);
  });

  it('computeSourceCorpusArtifactHash·computeFrozenAnalysisArtifactHash는 결정적이고 cases 순서에 민감하다', async () => {
    const cases = defaultCases();
    const forward = await computeSourceCorpusArtifactHash(cases);
    const forwardAgain = await computeSourceCorpusArtifactHash(cases);
    const reversed = await computeSourceCorpusArtifactHash([...cases].reverse());
    assert.equal(forward, forwardAgain);
    assert.notEqual(forward, reversed);

    const frozenForward = await computeFrozenAnalysisArtifactHash(cases);
    const frozenReversed = await computeFrozenAnalysisArtifactHash([...cases].reverse());
    assert.notEqual(frozenForward, frozenReversed);
  });
});
