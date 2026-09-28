/**
 * 자동 Scripture Catalog — 재개 가능한 분석 실행기 테스트
 *
 * 실행: npm run test:logic
 *
 * 무엇을 증명하는가
 *   빈 체크포인트에서 시작해 순차로(병렬 없이) analyze를 부르고, 성공할 때마다
 *   저장이 끝난 뒤에만 다음으로 넘어간다는 것. analyze 실패·검증 실패·저장 실패
 *   어디서든 그 시점까지의 정상 prefix만 남고 더 진행하지 않는다는 것. 체크포인트가
 *   계획 지문·environment·순서·중복·계약 밖 필드 중 무엇 하나라도 어긋나면 거절된다는
 *   것. 156건이 모두 성공하면 기존 builder가 직접 만든 스냅샷과 동일한 결과가
 *   나온다는 것.
 *
 * 무엇을 증명하지 않는가
 *   실제 OpenAI 호출이나 파일 저장(둘 다 이 파일에 없다). executor·DB·activation
 *   연결(아직 없다).
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  type AnalysisSnapshotPlanCase,
  type ExternalAnalysisResult,
  buildDeterministicAnalysisPlan,
  buildFrozenAnalysisSnapshot,
} from '../../scripts/automatic-scripture-catalog-analysis-snapshot-builder.ts';
import {
  type AnalysisRunnerCaseInput,
  type AnalysisRunnerCheckpoint,
  type AnalysisRunnerResult,
  ANALYSIS_RUNNER_CHECKPOINT_CONTRACT_VERSION,
  computeAnalysisPlanFingerprint,
  runAnalysisSnapshotRunner,
  validateAnalysisRunnerCheckpoint,
} from '../../scripts/automatic-scripture-catalog-analysis-snapshot-runner.ts';
import { buildCurrentAnalysisSnapshotEnvironment } from '../../supabase/functions/_shared/automatic-scripture-catalog-analysis-environment.ts';
import {
  type AnalysisSnapshotEnvironmentBinding,
  type CorpusRegressionCaseExpectation,
  type SafetyBoundaryCaseExpectation,
  validateAnalysisSnapshotCase,
} from '../../supabase/functions/_shared/automatic-scripture-catalog-analysis-snapshot-contract.ts';
import type { SituationAnalysis } from '../../supabase/functions/_shared/situation-analysis.ts';

const BASELINE_HASH = `scat_${'a'.repeat(64)}`;
const PLAN = buildDeterministicAnalysisPlan();

/** 계획 사례의 expected에서 최소한으로 유효한(cross-consistency를 만족하는) 분석을 새로 만든다. */
function buildValidAnalysisForPlanCase(planCase: AnalysisSnapshotPlanCase): SituationAnalysis {
  if (planCase.kind === 'safety_boundary') {
    const expected = planCase.expected as SafetyBoundaryCaseExpectation;
    return {
      domainPriority: 'resolved',
      primaryDomain: 'injustice_mistreatment',
      domainChoiceCandidates: [],
      secondaryDomains: [],
      situationTags: [],
      emotionTags: [],
      spiritualQuestionTags: [],
      prayerModes: [],
      pastoralFunctions: [],
      safety: { level: expected.expectedSafety.level, categories: [...expected.expectedSafety.categories] },
      confidence: 0.9,
    };
  }

  const expected = planCase.expected as CorpusRegressionCaseExpectation;
  if (expected.expectedRoute === 'recommend') {
    return {
      domainPriority: 'resolved',
      primaryDomain: expected.expectedPrimaryDomain,
      domainChoiceCandidates: [],
      secondaryDomains: [],
      situationTags: [],
      emotionTags: [],
      spiritualQuestionTags: [],
      prayerModes: [],
      pastoralFunctions: [],
      safety: { level: 'normal', categories: [] },
      confidence: 0.9,
    };
  }
  if (expected.expectedRoute === 'domain_choice') {
    return {
      domainPriority: 'needs_choice',
      primaryDomain: null,
      domainChoiceCandidates: [...expected.expectedDomainChoiceCandidates],
      secondaryDomains: [],
      situationTags: [],
      emotionTags: [],
      spiritualQuestionTags: [],
      prayerModes: [],
      pastoralFunctions: [],
      safety: { level: 'normal', categories: [] },
      confidence: 0.9,
    };
  }
  return {
    domainPriority: expected.expectedPrimaryDomain === null ? 'needs_detail' : 'resolved',
    primaryDomain: expected.expectedPrimaryDomain,
    domainChoiceCandidates: [],
    secondaryDomains: [],
    situationTags: [],
    emotionTags: [],
    spiritualQuestionTags: [],
    prayerModes: [],
    pastoralFunctions: [],
    safety: { level: 'normal', categories: [] },
    confidence: 0.9,
  };
}

const planByCaseId = new Map(PLAN.map((item) => [item.caseId, item] as const));

type FakeAnalyzerOptions = {
  /** 이 caseId에서는 예외를 던진다. */
  throwOn?: string;
  /** 이 caseId에서는 이 값을 그대로 돌려준다(계약 위반이나 expected 모순을 만들 때 씀). */
  overrides?: Record<string, unknown>;
};

function createFakeAnalyzer(options: FakeAnalyzerOptions = {}) {
  const calls: AnalysisRunnerCaseInput[] = [];
  const analyze = async (input: AnalysisRunnerCaseInput): Promise<SituationAnalysis> => {
    calls.push({ ...input });
    if (options.throwOn === input.caseId) {
      throw new Error('provider timed out with a very specific internal stack trace');
    }
    if (options.overrides && input.caseId in options.overrides) {
      return options.overrides[input.caseId] as SituationAnalysis;
    }
    const planCase = planByCaseId.get(input.caseId);
    assert.ok(planCase, `테스트 fixture 오류: ${input.caseId}가 계획에 없습니다.`);
    return buildValidAnalysisForPlanCase(planCase);
  };
  return { analyze, calls };
}

function createFakeCheckpointStore(initial: unknown = null) {
  let stored: unknown = initial;
  const saveCalls: AnalysisRunnerCheckpoint[] = [];
  let failNextSaves = 0;
  const loadCheckpoint = async (): Promise<unknown> => stored;
  const saveCheckpoint = async (checkpoint: AnalysisRunnerCheckpoint): Promise<void> => {
    if (failNextSaves > 0) {
      failNextSaves -= 1;
      throw new Error('disk full (fake failure for a test)');
    }
    saveCalls.push(checkpoint);
    stored = checkpoint;
  };
  return {
    loadCheckpoint,
    saveCheckpoint,
    saveCalls,
    failNextSave: (times = 1) => {
      failNextSaves = times;
    },
    getStored: () => stored,
  };
}

async function currentEnvironment(): Promise<AnalysisSnapshotEnvironmentBinding> {
  return buildCurrentAnalysisSnapshotEnvironment(BASELINE_HASH);
}

async function currentPlanFingerprint(): Promise<string> {
  return computeAnalysisPlanFingerprint(PLAN);
}

async function buildCheckpointForPrefix(count: number): Promise<AnalysisRunnerCheckpoint> {
  const environment = await currentEnvironment();
  const planFingerprint = await currentPlanFingerprint();
  const results = PLAN.slice(0, count).map((planCase) => ({
    caseId: planCase.caseId,
    text: planCase.text,
    analysis: buildValidAnalysisForPlanCase(planCase),
  }));
  return { contractVersion: ANALYSIS_RUNNER_CHECKPOINT_CONTRACT_VERSION, planFingerprint, environment, results };
}

describe('automatic-scripture-catalog-analysis-snapshot-runner · 정상 경로', () => {
  it('1) 빈 체크포인트(null)에서 EVAL-001부터 시작한다', async () => {
    const { analyze, calls } = createFakeAnalyzer();
    const store = createFakeCheckpointStore(null);
    const result = await runAnalysisSnapshotRunner({
      analyze,
      loadCheckpoint: store.loadCheckpoint,
      saveCheckpoint: store.saveCheckpoint,
      baselineCatalogVersionHash: BASELINE_HASH,
      maxCases: 1,
    });
    assert.equal(result.status, 'in_progress');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].caseId, PLAN[0].caseId);
    assert.equal(PLAN[0].caseId, 'EVAL-001');
  });

  it('2) 유효한 prefix 뒤의 정확한 다음 사례부터 재개한다', async () => {
    const checkpoint = await buildCheckpointForPrefix(5);
    const { analyze, calls } = createFakeAnalyzer();
    const store = createFakeCheckpointStore(checkpoint);
    const result = await runAnalysisSnapshotRunner({
      analyze,
      loadCheckpoint: store.loadCheckpoint,
      saveCheckpoint: store.saveCheckpoint,
      baselineCatalogVersionHash: BASELINE_HASH,
      maxCases: 1,
    });
    assert.equal(result.status, 'in_progress');
    if (result.status === 'in_progress') assert.equal(result.completedCount, 6);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].caseId, PLAN[5].caseId);
  });

  it('3) 완성 체크포인트(156/156)면 analyze 호출 0회이고 completed를 돌려준다', async () => {
    const checkpoint = await buildCheckpointForPrefix(PLAN.length);
    const { analyze, calls } = createFakeAnalyzer();
    const store = createFakeCheckpointStore(checkpoint);
    const result = await runAnalysisSnapshotRunner({
      analyze,
      loadCheckpoint: store.loadCheckpoint,
      saveCheckpoint: store.saveCheckpoint,
      baselineCatalogVersionHash: BASELINE_HASH,
    });
    assert.equal(calls.length, 0);
    assert.equal(store.saveCalls.length, 0, '이미 완성된 체크포인트를 다시 저장하면 안 됩니다.');
    assert.equal(result.status, 'completed');
  });

  it('4a) maxCases 0이면 analyze 호출이 0회다', async () => {
    const { analyze, calls } = createFakeAnalyzer();
    const store = createFakeCheckpointStore(null);
    const result = await runAnalysisSnapshotRunner({
      analyze,
      loadCheckpoint: store.loadCheckpoint,
      saveCheckpoint: store.saveCheckpoint,
      baselineCatalogVersionHash: BASELINE_HASH,
      maxCases: 0,
    });
    assert.equal(calls.length, 0);
    assert.equal(result.status, 'in_progress');
    if (result.status === 'in_progress') assert.equal(result.completedCount, 0);
  });

  it('4b) maxCases 1이면 정확히 1건만 처리한다', async () => {
    const { analyze, calls } = createFakeAnalyzer();
    const store = createFakeCheckpointStore(null);
    await runAnalysisSnapshotRunner({
      analyze,
      loadCheckpoint: store.loadCheckpoint,
      saveCheckpoint: store.saveCheckpoint,
      baselineCatalogVersionHash: BASELINE_HASH,
      maxCases: 1,
    });
    assert.equal(calls.length, 1);
  });

  it('4c) maxCases가 여러 건이고 남은 수보다 크면 남은 사례까지만 처리한다', async () => {
    const checkpoint = await buildCheckpointForPrefix(PLAN.length - 2);
    const { analyze, calls } = createFakeAnalyzer();
    const store = createFakeCheckpointStore(checkpoint);
    const result = await runAnalysisSnapshotRunner({
      analyze,
      loadCheckpoint: store.loadCheckpoint,
      saveCheckpoint: store.saveCheckpoint,
      baselineCatalogVersionHash: BASELINE_HASH,
      maxCases: 999,
    });
    assert.equal(calls.length, 2, '남은 2건까지만 처리해야 합니다.');
    assert.equal(result.status, 'completed');
  });

  it('4d) maxCases가 음수·정수가 아니면 거절한다(analyze 호출 없음)', async () => {
    for (const bad of [-1, 1.5, Number.NaN]) {
      const { analyze, calls } = createFakeAnalyzer();
      const store = createFakeCheckpointStore(null);
      const result = await runAnalysisSnapshotRunner({
        analyze,
        loadCheckpoint: store.loadCheckpoint,
        saveCheckpoint: store.saveCheckpoint,
        baselineCatalogVersionHash: BASELINE_HASH,
        maxCases: bad,
      });
      assert.deepEqual(result, { status: 'failed', reason: 'invalid_max_cases' });
      assert.equal(calls.length, 0);
    }
  });

  it('5) 각 성공 결과 뒤에 정확히 한 번씩 저장을 호출한다', async () => {
    const { analyze } = createFakeAnalyzer();
    const store = createFakeCheckpointStore(null);
    await runAnalysisSnapshotRunner({
      analyze,
      loadCheckpoint: store.loadCheckpoint,
      saveCheckpoint: store.saveCheckpoint,
      baselineCatalogVersionHash: BASELINE_HASH,
      maxCases: 3,
    });
    assert.equal(store.saveCalls.length, 3);
    assert.deepEqual(
      store.saveCalls.map((checkpoint) => checkpoint.results.length),
      [1, 2, 3],
    );
    assert.deepEqual(
      store.saveCalls[2].results.map((item) => item.caseId),
      [PLAN[0].caseId, PLAN[1].caseId, PLAN[2].caseId],
    );
  });

  it('7) 계획과 일치하는 156개 결과를 전부 처리하면 completed 스냅샷이 기존 builder 결과와 동일하다', async () => {
    const { analyze } = createFakeAnalyzer();
    const store = createFakeCheckpointStore(null);
    const result = await runAnalysisSnapshotRunner({
      analyze,
      loadCheckpoint: store.loadCheckpoint,
      saveCheckpoint: store.saveCheckpoint,
      baselineCatalogVersionHash: BASELINE_HASH,
    });
    assert.equal(result.status, 'completed');
    assert.equal(store.saveCalls.length, PLAN.length);

    if (result.status === 'completed') {
      const externalResults: ExternalAnalysisResult[] = PLAN.map((planCase) => ({
        caseId: planCase.caseId,
        text: planCase.text,
        analysis: buildValidAnalysisForPlanCase(planCase),
      }));
      const direct = await buildFrozenAnalysisSnapshot(BASELINE_HASH, externalResults);
      assert.equal(direct.ok, true);
      if (direct.ok) assert.deepEqual(result.snapshot, direct.snapshot);
    }
  });
});

describe('automatic-scripture-catalog-analysis-snapshot-runner · 실패 경로', () => {
  it('6) 저장이 끝나기 전에는 다음 분석을 부르지 않는다(저장 실패 시 analyze 호출 수로 확인)', async () => {
    const { analyze, calls } = createFakeAnalyzer();
    const store = createFakeCheckpointStore(null);
    store.failNextSave(1); // 첫 저장부터 실패시킨다
    const result = await runAnalysisSnapshotRunner({
      analyze,
      loadCheckpoint: store.loadCheckpoint,
      saveCheckpoint: store.saveCheckpoint,
      baselineCatalogVersionHash: BASELINE_HASH,
      maxCases: 5,
    });
    assert.equal(calls.length, 1, '저장이 실패했으면 두 번째 analyze를 부르면 안 됩니다.');
    assert.deepEqual(result, { status: 'failed', reason: 'checkpoint_save_failed', caseId: PLAN[0].caseId });
  });

  it('8) 분석 함수가 예외를 던지면 그 시점까지의 정상 prefix만 남는다', async () => {
    const { analyze, calls } = createFakeAnalyzer({ throwOn: PLAN[2].caseId });
    const store = createFakeCheckpointStore(null);
    const result = await runAnalysisSnapshotRunner({
      analyze,
      loadCheckpoint: store.loadCheckpoint,
      saveCheckpoint: store.saveCheckpoint,
      baselineCatalogVersionHash: BASELINE_HASH,
      maxCases: 10,
    });
    assert.deepEqual(result, { status: 'failed', reason: 'analyze_failed', caseId: PLAN[2].caseId });
    assert.equal(calls.length, 3, 'EVAL-001·002·003(세 번째에서 실패)만 불렸어야 합니다.');
    assert.equal(store.saveCalls.length, 2, '실패 전 두 건만 저장됐어야 합니다.');
    const stored = store.getStored() as AnalysisRunnerCheckpoint;
    assert.deepEqual(
      stored.results.map((item) => item.caseId),
      [PLAN[0].caseId, PLAN[1].caseId],
    );
  });

  it('9) 계약을 위반하는 분석 결과(analysis에 여분 필드)는 저장되지 않는다', async () => {
    const badCaseId = PLAN[1].caseId;
    const goodAnalysis = buildValidAnalysisForPlanCase(planByCaseId.get(badCaseId)!);
    const polluted = { ...goodAnalysis, rawResponse: 'provider output' } as unknown as SituationAnalysis;
    const { analyze, calls } = createFakeAnalyzer({ overrides: { [badCaseId]: polluted } });
    const store = createFakeCheckpointStore(null);
    const result = await runAnalysisSnapshotRunner({
      analyze,
      loadCheckpoint: store.loadCheckpoint,
      saveCheckpoint: store.saveCheckpoint,
      baselineCatalogVersionHash: BASELINE_HASH,
      maxCases: 10,
    });
    assert.equal(result.status, 'failed');
    if (result.status === 'failed') {
      assert.equal(result.reason, 'analysis_invalid');
      assert.equal(result.caseId, badCaseId);
      assert.ok(!('errors' in result), '공개 결과에는 errors 필드가 없어야 합니다.');
    }
    assert.equal(calls.length, 2);
    assert.equal(store.saveCalls.length, 1, 'EVAL-001만 저장되고 문제된 EVAL-002는 저장되지 않아야 합니다.');
    assert.equal(JSON.stringify(result).includes('rawResponse'), false, '상세 오류 문자열이 결과 직렬화에 섞이면 안 됩니다.');
  });

  it('10) expected와 모순된 분석(교차 일관성 위반)은 저장되지 않는다', async () => {
    const badPlanCase = PLAN.find((item) => item.kind === 'corpus_regression' && item.expected.expectedRoute === 'recommend')!;
    const contradicting: SituationAnalysis = {
      ...buildValidAnalysisForPlanCase(badPlanCase),
      // recommend를 기대하는데 안전 사례처럼 만들어 교차 일관성을 깬다.
      safety: { level: 'urgent', categories: ['immediate_danger'] },
    };
    const { analyze, calls } = createFakeAnalyzer({ overrides: { [badPlanCase.caseId]: contradicting } });
    const store = createFakeCheckpointStore(null);
    const result = await runAnalysisSnapshotRunner({
      analyze,
      loadCheckpoint: store.loadCheckpoint,
      saveCheckpoint: store.saveCheckpoint,
      baselineCatalogVersionHash: BASELINE_HASH,
      maxCases: PLAN.indexOf(badPlanCase) + 1,
    });
    assert.equal(result.status, 'failed');
    if (result.status === 'failed') {
      assert.equal(result.reason, 'analysis_invalid');
      assert.equal(result.caseId, badPlanCase.caseId);
      assert.ok(!('errors' in result), '공개 결과에는 errors 필드가 없어야 합니다.');
    }
    assert.equal(calls.length, PLAN.indexOf(badPlanCase) + 1);
  });

  it('11) 저장 실패 뒤 추가 analyze 호출이 없다(재확인 — maxCases가 커도)', async () => {
    const { analyze, calls } = createFakeAnalyzer();
    const store = createFakeCheckpointStore(null);
    store.failNextSave(1);
    await runAnalysisSnapshotRunner({
      analyze,
      loadCheckpoint: store.loadCheckpoint,
      saveCheckpoint: store.saveCheckpoint,
      baselineCatalogVersionHash: BASELINE_HASH,
      maxCases: 50,
    });
    assert.equal(calls.length, 1);
  });

  it('12) 잘못된 baseline hash는 analyze·저장을 부르지 않고 거절한다', async () => {
    const { analyze, calls } = createFakeAnalyzer();
    const store = createFakeCheckpointStore(null);
    const result = await runAnalysisSnapshotRunner({
      analyze,
      loadCheckpoint: store.loadCheckpoint,
      saveCheckpoint: store.saveCheckpoint,
      baselineCatalogVersionHash: 'not-a-hash',
      maxCases: 5,
    });
    assert.deepEqual(result, { status: 'failed', reason: 'invalid_baseline_hash' });
    assert.equal(calls.length, 0);
    assert.equal(store.saveCalls.length, 0);
  });

  it('[재현] loadCheckpoint가 예외를 던지면 원문 없이 checkpoint_load_failed만 돌려주고 analyze·저장은 0회다', async () => {
    const { analyze, calls } = createFakeAnalyzer();
    const saveCalls: AnalysisRunnerCheckpoint[] = [];
    const loadCheckpoint = async (): Promise<unknown> => {
      throw new Error('disk secret detail that must never leak');
    };
    const saveCheckpoint = async (checkpoint: AnalysisRunnerCheckpoint): Promise<void> => {
      saveCalls.push(checkpoint);
    };
    const result = await runAnalysisSnapshotRunner({
      analyze,
      loadCheckpoint,
      saveCheckpoint,
      baselineCatalogVersionHash: BASELINE_HASH,
      maxCases: 5,
    });
    assert.deepEqual(result, { status: 'failed', reason: 'checkpoint_load_failed' });
    assert.equal(calls.length, 0);
    assert.equal(saveCalls.length, 0);
    assert.equal(JSON.stringify(result).includes('disk secret detail'), false);
  });

  it('[재현] 분석 결과에 모델이 만든 값(PRIVATE_MODEL_VALUE_123)이 섞여도 실행기 결과 직렬화에 나타나지 않는다', async () => {
    const targetCaseId = PLAN[0].caseId;
    const goodAnalysis = buildValidAnalysisForPlanCase(PLAN[0]);
    const polluted: SituationAnalysis = { ...goodAnalysis, situationTags: ['PRIVATE_MODEL_VALUE_123'] };
    const { analyze } = createFakeAnalyzer({ overrides: { [targetCaseId]: polluted } });
    const store = createFakeCheckpointStore(null);
    const result = await runAnalysisSnapshotRunner({
      analyze,
      loadCheckpoint: store.loadCheckpoint,
      saveCheckpoint: store.saveCheckpoint,
      baselineCatalogVersionHash: BASELINE_HASH,
      maxCases: 1,
    });
    assert.deepEqual(result, { status: 'failed', reason: 'analysis_invalid', caseId: targetCaseId });
    assert.equal(JSON.stringify(result).includes('PRIVATE_MODEL_VALUE_123'), false);
    assert.equal(store.saveCalls.length, 0);
  });

  it('[재현 대조군] 같은 오염 값을 순수 validator(validateAnalysisSnapshotCase)에 직접 넣으면 구체적인 오류를 그대로 볼 수 있다', () => {
    const goodAnalysis = buildValidAnalysisForPlanCase(PLAN[0]);
    const polluted: SituationAnalysis = { ...goodAnalysis, situationTags: ['PRIVATE_MODEL_VALUE_123'] };
    const candidate = { caseId: PLAN[0].caseId, kind: PLAN[0].kind, text: PLAN[0].text, expected: PLAN[0].expected, analysis: polluted };
    const direct = validateAnalysisSnapshotCase(candidate, 'case');
    assert.equal(direct.valid, false);
    assert.ok(direct.errors.some((message) => message.includes('PRIVATE_MODEL_VALUE_123')), '순수 validator는 상세 오류를 계속 제공해야 합니다.');
  });

  it('checkpoint_invalid 결과에는 오염된 체크포인트 값이 전혀 나타나지 않는다', async () => {
    const checkpoint = await buildCheckpointForPrefix(1);
    const polluted = {
      ...checkpoint,
      results: [{ ...checkpoint.results[0], analysis: { ...checkpoint.results[0].analysis, situationTags: ['PRIVATE_MODEL_VALUE_123'] } }],
    };
    const store = createFakeCheckpointStore(polluted);
    const { analyze, calls } = createFakeAnalyzer();
    const result = await runAnalysisSnapshotRunner({
      analyze,
      loadCheckpoint: store.loadCheckpoint,
      saveCheckpoint: store.saveCheckpoint,
      baselineCatalogVersionHash: BASELINE_HASH,
      maxCases: 1,
    });
    assert.deepEqual(result, { status: 'failed', reason: 'checkpoint_invalid' });
    assert.equal(calls.length, 0, '체크포인트 자체가 무효면 analyze를 부르면 안 됩니다.');
    assert.equal(JSON.stringify(result).includes('PRIVATE_MODEL_VALUE_123'), false);
  });

  it('final_snapshot_invalid 경로도 상세 오류(errors)를 반환하지 않는다(소스에서 직접 확인)', () => {
    // 156개 전부를 정상 처리하면서 마지막 단계만 실패시키는 시나리오는 이 실행기의 다른
    // 모든 검사(체크포인트 검증·사례별 검증)가 이미 같은 규칙을 앞서 적용하기 때문에
    // 블랙박스로 재현하기 사실상 불가능하다 — 그래서 이 자리는 소스가 실제로
    // `errors`를 붙이지 않는 그 한 줄을 그대로 갖고 있는지 직접 확인한다. mutation
    // 검증(문서·완료 보고에 기록)에서 이 줄에 `errors: finalBuild.errors`를 다시 붙이면
    // 이 테스트가 즉시 실패하는 것으로 이 assertion의 실효성을 확인했다.
    const source = readFileSync(
      new URL('../../scripts/automatic-scripture-catalog-analysis-snapshot-runner.ts', import.meta.url),
      'utf8',
    );
    assert.ok(source.includes("return { status: 'failed', reason: 'final_snapshot_invalid' };"));
    assert.equal(source.includes("reason: 'final_snapshot_invalid', errors"), false);
  });
});

describe('automatic-scripture-catalog-analysis-snapshot-runner · 체크포인트 거절', () => {
  it('13) 중간 사례가 빠진 체크포인트(누락)는 거절한다', async () => {
    const checkpoint = await buildCheckpointForPrefix(3);
    const gappy = { ...checkpoint, results: [checkpoint.results[0], checkpoint.results[2]] };
    const plan = PLAN;
    const result = validateAnalysisRunnerCheckpoint(gappy, {
      planFingerprint: await currentPlanFingerprint(),
      environment: await currentEnvironment(),
      plan,
    });
    assert.equal(result.ok, false);
  });

  it('14) 순서가 뒤집힌 체크포인트는 거절한다', async () => {
    const checkpoint = await buildCheckpointForPrefix(3);
    const reversed = { ...checkpoint, results: [...checkpoint.results].reverse() };
    const result = validateAnalysisRunnerCheckpoint(reversed, {
      planFingerprint: await currentPlanFingerprint(),
      environment: await currentEnvironment(),
      plan: PLAN,
    });
    assert.equal(result.ok, false);
  });

  it('15) 계획 밖 사례가 섞인 체크포인트는 거절한다', async () => {
    const checkpoint = await buildCheckpointForPrefix(2);
    const foreign = {
      ...checkpoint,
      results: [...checkpoint.results, { caseId: 'ZZZZ-999', text: '계획에 없는 문장', analysis: checkpoint.results[0].analysis }],
    };
    const result = validateAnalysisRunnerCheckpoint(foreign, {
      planFingerprint: await currentPlanFingerprint(),
      environment: await currentEnvironment(),
      plan: PLAN,
    });
    assert.equal(result.ok, false);
  });

  it('중복 caseId가 섞인 체크포인트는 거절한다', async () => {
    const checkpoint = await buildCheckpointForPrefix(2);
    const duplicated = { ...checkpoint, results: [checkpoint.results[0], checkpoint.results[0]] };
    const result = validateAnalysisRunnerCheckpoint(duplicated, {
      planFingerprint: await currentPlanFingerprint(),
      environment: await currentEnvironment(),
      plan: PLAN,
    });
    assert.equal(result.ok, false);
  });

  it('text가 바뀐 체크포인트는(caseId는 그대로) 거절한다', async () => {
    const checkpoint = await buildCheckpointForPrefix(2);
    const mutated = {
      ...checkpoint,
      results: [{ ...checkpoint.results[0], text: '완전히 다른 문장입니다.' }, checkpoint.results[1]],
    };
    const result = validateAnalysisRunnerCheckpoint(mutated, {
      planFingerprint: await currentPlanFingerprint(),
      environment: await currentEnvironment(),
      plan: PLAN,
    });
    assert.equal(result.ok, false);
  });

  it('12b) 다른 계획 지문을 가진 체크포인트는 거절한다', async () => {
    const checkpoint = await buildCheckpointForPrefix(2);
    const wrongFingerprint = { ...checkpoint, planFingerprint: `sart_${'0'.repeat(64)}` };
    const result = validateAnalysisRunnerCheckpoint(wrongFingerprint, {
      planFingerprint: await currentPlanFingerprint(),
      environment: await currentEnvironment(),
      plan: PLAN,
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.errors.some((message) => message.includes('planFingerprint')));
  });

  it('13b) 다른 environment/baseline hash를 가진 체크포인트는 거절한다', async () => {
    const checkpoint = await buildCheckpointForPrefix(2);
    const differentEnvironment = { ...checkpoint.environment, analyzerModel: 'a-different-model' };
    const wrongEnv = { ...checkpoint, environment: differentEnvironment };
    const result = validateAnalysisRunnerCheckpoint(wrongEnv, {
      planFingerprint: await currentPlanFingerprint(),
      environment: await currentEnvironment(),
      plan: PLAN,
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.errors.some((message) => message.includes('environment')));
  });

  it('14b) 계약 밖 wrapper 필드가 있는 체크포인트는 거절한다', async () => {
    const checkpoint = await buildCheckpointForPrefix(1);
    const polluted = { ...checkpoint, humanApproval: true };
    const result = validateAnalysisRunnerCheckpoint(polluted, {
      planFingerprint: await currentPlanFingerprint(),
      environment: await currentEnvironment(),
      plan: PLAN,
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.errors.some((message) => message.includes('humanApproval')));
  });

  it('15) raw response·token usage·사용자 식별자 필드가 결과에 섞이면 거절한다', async () => {
    const checkpoint = await buildCheckpointForPrefix(1);
    for (const forbiddenField of ['rawResponse', 'tokenUsage', 'userId', 'sessionId']) {
      const polluted = {
        ...checkpoint,
        results: [{ ...checkpoint.results[0], [forbiddenField]: 'x' }],
      };
      const result = validateAnalysisRunnerCheckpoint(polluted, {
        planFingerprint: await currentPlanFingerprint(),
        environment: await currentEnvironment(),
        plan: PLAN,
      });
      assert.equal(result.ok, false, forbiddenField);
      if (!result.ok) assert.ok(result.errors.some((message) => message.includes(forbiddenField)), forbiddenField);
    }
  });

  it('빈 체크포인트(results: [])는 통과한다(진행 중이지만 시작 전 상태)', async () => {
    const environment = await currentEnvironment();
    const planFingerprint = await currentPlanFingerprint();
    const empty: AnalysisRunnerCheckpoint = { contractVersion: ANALYSIS_RUNNER_CHECKPOINT_CONTRACT_VERSION, planFingerprint, environment, results: [] };
    const result = validateAnalysisRunnerCheckpoint(empty, { planFingerprint, environment, plan: PLAN });
    assert.equal(result.ok, true);
  });

  it('완전히 유효한 156개 prefix 체크포인트는 통과한다', async () => {
    const checkpoint = await buildCheckpointForPrefix(PLAN.length);
    const result = validateAnalysisRunnerCheckpoint(checkpoint, {
      planFingerprint: await currentPlanFingerprint(),
      environment: await currentEnvironment(),
      plan: PLAN,
    });
    assert.equal(result.ok, true);
  });

  it('[재현] environment 필드가 아예 빠진 체크포인트는 throw 없이 ok:false로 수렴한다', async () => {
    const checkpoint = await buildCheckpointForPrefix(1);
    const { environment: _drop, ...withoutEnvironment } = checkpoint;
    let result: ReturnType<typeof validateAnalysisRunnerCheckpoint> | undefined;
    assert.doesNotThrow(() => {
      result = validateAnalysisRunnerCheckpoint(withoutEnvironment, {
        planFingerprint: checkpoint.planFingerprint,
        environment: checkpoint.environment,
        plan: PLAN,
      });
    });
    assert.equal(result?.ok, false);
  });

  it('environment가 undefined·문자열·배열이어도 throw 없이 모두 ok:false다', async () => {
    const checkpoint = await buildCheckpointForPrefix(1);
    for (const malformed of [undefined, 'not-an-object', ['not', 'an', 'object'], 42, null]) {
      const mutated = { ...checkpoint, environment: malformed };
      let result: ReturnType<typeof validateAnalysisRunnerCheckpoint> | undefined;
      assert.doesNotThrow(() => {
        result = validateAnalysisRunnerCheckpoint(mutated, {
          planFingerprint: checkpoint.planFingerprint,
          environment: checkpoint.environment,
          plan: PLAN,
        });
      }, `environment=${JSON.stringify(malformed)}에서 예외가 나면 안 됩니다.`);
      assert.equal(result?.ok, false, `environment=${JSON.stringify(malformed)}`);
    }
  });

  it('기존 순수 validator(validateAnalysisRunnerCheckpoint)는 구체적인 오류를 계속 제공한다', async () => {
    const checkpoint = await buildCheckpointForPrefix(1);
    const wrongFingerprint = { ...checkpoint, planFingerprint: `sart_${'9'.repeat(64)}` };
    const result = validateAnalysisRunnerCheckpoint(wrongFingerprint, {
      planFingerprint: checkpoint.planFingerprint,
      environment: checkpoint.environment,
      plan: PLAN,
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.errors.length > 0);
      assert.ok(result.errors.some((message) => message.includes('planFingerprint')));
    }
  });
});

describe('automatic-scripture-catalog-analysis-snapshot-runner · 순수성·격리', () => {
  it('17) 소스에 OpenAI·fetch·환경변수·파일 시스템·console·Supabase·네트워크 접근이 없다', () => {
    const source = readFileSync(
      new URL('../../scripts/automatic-scripture-catalog-analysis-snapshot-runner.ts', import.meta.url),
      'utf8',
    );
    for (const banned of [
      "from 'openai'",
      "require('openai')",
      'new OpenAI(',
      'fetch(',
      'Deno.env',
      'process.env',
      'createClient(',
      '/rest/v1/',
      'service_role',
      'Date.now(',
      'new Date(',
      'Math.random(',
      'console.',
      'readFileSync',
      'writeFileSync',
      'readFile(',
      'writeFile(',
      'require(',
      'XMLHttpRequest',
    ]) {
      assert.equal(source.includes(banned), false, banned);
    }
  });

  it('18) analyzer와 store는 이 테스트가 직접 만든 가짜 함수다(호출 횟수·인자로 확인)', async () => {
    const { analyze, calls } = createFakeAnalyzer();
    const store = createFakeCheckpointStore(null);
    assert.equal(store.saveCalls.length, 0);
    await runAnalysisSnapshotRunner({
      analyze,
      loadCheckpoint: store.loadCheckpoint,
      saveCheckpoint: store.saveCheckpoint,
      baselineCatalogVersionHash: BASELINE_HASH,
      maxCases: 2,
    });
    // 실제 네트워크·SDK가 아니라 이 테스트 파일의 인메모리 배열로만 동작했는지 확인한다.
    assert.equal(calls.length, 2);
    assert.deepEqual(
      calls.map((item) => item.caseId),
      [PLAN[0].caseId, PLAN[1].caseId],
    );
    assert.equal(store.saveCalls.length, 2);
    assert.equal(store.getStored(), store.saveCalls[1]);
  });
});
