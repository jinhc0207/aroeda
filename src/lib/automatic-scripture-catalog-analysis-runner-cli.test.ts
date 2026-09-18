/**
 * 자동 Scripture Catalog — 분석 실행기 안전 CLI 테스트
 *
 * 실행: npm run test:logic
 *
 * 무엇을 증명하는가
 *   `--dry-run`/`--execute` 중 정확히 하나가 없으면(둘 다 없거나 둘 다 있으면) OpenAI
 *   client·analyze·파일 쓰기를 전혀 하지 않고 사용법만 낸다는 것. `--dry-run`은 어떤
 *   경우에도 client·analyze·쓰기를 하지 않는다는 것. `--execute`는 인자 네 개가 모두
 *   명시적으로 있어야 하고(특히 `--max-cases`는 생략도 0도 거절), checkpoint·snapshot
 *   경로가 같으면 거절하며, 기존 체크포인트 검증이 끝난 뒤에만 OpenAI client를
 *   만든다는 것(지연 생성으로 검증). analyzer/provider가 예외로 무엇을 던지든 그
 *   원문이 CLI의 출력·반환값 어디에도 나타나지 않는다는 것. 재실행하면 저장된 다음
 *   사례부터 이어간다는 것.
 *
 * 무엇을 증명하지 않는가
 *   실제 OpenAI 호출·실제 네트워크(이 파일에 전혀 없다 — analyzeCaseText는 항상
 *   fake다). 마지막 2개 테스트만 실제 파일 시스템(임시 디렉터리)을 함께 검증하고,
 *   그 밖의 모든 테스트는 checkpoint/snapshot 저장을 인메모리 가짜로 대신한다.
 */

import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { buildDeterministicAnalysisPlan } from '../../scripts/automatic-scripture-catalog-analysis-snapshot-builder.ts';
import {
  type AnalysisRunnerCheckpoint,
  ANALYSIS_RUNNER_CHECKPOINT_CONTRACT_VERSION,
  computeAnalysisPlanFingerprint,
} from '../../scripts/automatic-scripture-catalog-analysis-snapshot-runner.ts';
import { type CliDependencies, runCli } from '../../scripts/automatic-scripture-catalog-analysis-runner-cli.ts';
import {
  preflightJsonFileTarget,
  readJsonFile,
  writeJsonFileAtomic,
} from '../../scripts/automatic-scripture-catalog-analysis-runner-file-store.ts';
import { buildCurrentAnalysisSnapshotEnvironment } from '../../supabase/functions/_shared/automatic-scripture-catalog-analysis-environment.ts';
import type {
  CorpusRegressionCaseExpectation,
  SafetyBoundaryCaseExpectation,
} from '../../supabase/functions/_shared/automatic-scripture-catalog-analysis-snapshot-contract.ts';
import type { SituationAnalysis } from '../../supabase/functions/_shared/situation-analysis.ts';

const BASELINE_HASH = `scat_${'a'.repeat(64)}`;
const PLAN = buildDeterministicAnalysisPlan();
const planByCaseId = new Map(PLAN.map((item) => [item.caseId, item] as const));

/** runner 테스트와 같은 fixture 생성 규칙(교차 일관성을 만족하는 최소 유효 분석). */
function buildValidAnalysisForCaseId(caseId: string): SituationAnalysis {
  const planCase = planByCaseId.get(caseId);
  assert.ok(planCase, `테스트 fixture 오류: ${caseId}가 계획에 없습니다.`);

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
    confidence: 0.9,
  };
}

async function buildCheckpointForPrefix(count: number): Promise<AnalysisRunnerCheckpoint> {
  const environment = await buildCurrentAnalysisSnapshotEnvironment(BASELINE_HASH);
  const planFingerprint = await computeAnalysisPlanFingerprint(PLAN);
  const results = PLAN.slice(0, count).map((planCase) => ({
    caseId: planCase.caseId,
    text: planCase.text,
    analysis: buildValidAnalysisForCaseId(planCase.caseId),
  }));
  return {
    contractVersion: ANALYSIS_RUNNER_CHECKPOINT_CONTRACT_VERSION,
    planFingerprint,
    environment,
    results,
  };
}

type SpyDeps = CliDependencies & {
  printedLines: string[];
  createClientCalls: number;
  analyzeCalls: string[];
  preflightCalls: string[];
};

/** in-memory 가짜 의존성. checkpoint/snapshot store는 Map 하나로 흉내 낸다(재실행 테스트에서 재사용). */
function createSpyDeps(options: {
  checkpointStore?: Map<string, unknown>;
  snapshotStore?: Map<string, unknown>;
  analyzeThrows?: Error;
  analyzeOverrides?: Record<string, SituationAnalysis>;
  preflightFailsFor?: ReadonlySet<string>;
} = {}): SpyDeps {
  const checkpointStore = options.checkpointStore ?? new Map<string, unknown>();
  const snapshotStore = options.snapshotStore ?? new Map<string, unknown>();
  const printedLines: string[] = [];
  const analyzeCalls: string[] = [];
  const preflightCalls: string[] = [];
  let createClientCalls = 0;

  const deps: SpyDeps = {
    printedLines,
    analyzeCalls,
    preflightCalls,
    get createClientCalls() {
      return createClientCalls;
    },
    preflightWritableTarget: async (path) => {
      preflightCalls.push(path);
      if (options.preflightFailsFor?.has(path)) {
        throw new Error('preflight failed (fake) — must never leak this text');
      }
    },
    createOpenAIClient: () => {
      createClientCalls += 1;
      return { fake: 'client' };
    },
    analyzeCaseText: async (_client, text) => {
      analyzeCalls.push(text);
      if (options.analyzeThrows) throw options.analyzeThrows;
      const planCase = PLAN.find((item) => item.text === text);
      assert.ok(planCase, `테스트 fixture 오류: 계획에 없는 문장입니다: ${text}`);
      if (options.analyzeOverrides && planCase.caseId in options.analyzeOverrides) {
        return options.analyzeOverrides[planCase.caseId];
      }
      return buildValidAnalysisForCaseId(planCase.caseId);
    },
    loadCheckpointFile: async (path) => (checkpointStore.has(path) ? checkpointStore.get(path) : null),
    saveCheckpointFile: async (path, checkpoint) => {
      checkpointStore.set(path, checkpoint);
    },
    saveSnapshotFile: async (path, snapshot) => {
      snapshotStore.set(path, snapshot);
    },
    print: (line) => {
      printedLines.push(line);
    },
  };
  return deps;
}

function lastPrinted(deps: SpyDeps): Record<string, unknown> {
  assert.ok(deps.printedLines.length > 0, '아무 것도 출력되지 않았습니다.');
  return JSON.parse(deps.printedLines.at(-1)!);
}

describe('automatic-scripture-catalog-analysis-runner-cli · 모드 게이트', () => {
  it('1) 모드가 없으면 사용법만 내고 client·analyze·쓰기 0회다', async () => {
    const deps = createSpyDeps();
    const code = await runCli([], deps);
    assert.equal(code, 2);
    assert.equal(deps.createClientCalls, 0);
    assert.equal(deps.analyzeCalls.length, 0);
    assert.match(deps.printedLines.join('\n'), /usage:/);
  });

  it('2) --dry-run과 --execute를 동시에 주면 사용법만 내고 client·analyze·쓰기 0회다', async () => {
    const deps = createSpyDeps();
    const code = await runCli(
      [
        '--dry-run',
        '--execute',
        '--checkpoint=/tmp/x.json',
        '--snapshot=/tmp/y.json',
        `--baseline-catalog-version-hash=${BASELINE_HASH}`,
        '--max-cases=1',
      ],
      deps,
    );
    assert.equal(code, 2);
    assert.equal(deps.createClientCalls, 0);
    assert.equal(deps.analyzeCalls.length, 0);
  });

  it('3) 알 수 없는 형태의 인자가 있으면 사용법만 내고 0회다', async () => {
    const deps = createSpyDeps();
    const code = await runCli(['--dry-run', 'not-a-flag'], deps);
    assert.equal(code, 2);
    assert.equal(deps.createClientCalls, 0);
  });

  it('[재현] --dry-run이 두 번 나와도 거절하고 0회다(반복도 조용히 넘어가지 않는다)', async () => {
    const deps = createSpyDeps();
    const code = await runCli(['--dry-run', '--dry-run'], deps);
    assert.equal(code, 2);
    assert.equal(deps.createClientCalls, 0);
    assert.equal(deps.analyzeCalls.length, 0);
  });

  it('[재현] --execute가 두 번 나와도 거절하고 0회다', async () => {
    const deps = createSpyDeps();
    const code = await runCli(
      [
        '--execute',
        '--execute',
        '--checkpoint=/tmp/checkpoint.json',
        '--snapshot=/tmp/snapshot.json',
        `--baseline-catalog-version-hash=${BASELINE_HASH}`,
        '--max-cases=1',
      ],
      deps,
    );
    assert.equal(code, 2);
    assert.equal(deps.createClientCalls, 0);
    assert.equal(deps.analyzeCalls.length, 0);
  });
});

describe('automatic-scripture-catalog-analysis-runner-cli · dry-run', () => {
  it('4) --checkpoint 없이 dry-run하면 156개 계획·미완료·EVAL-001부터를 보고하고 0회다', async () => {
    const deps = createSpyDeps();
    const code = await runCli(['--dry-run'], deps);
    assert.equal(code, 0);
    assert.equal(deps.createClientCalls, 0);
    assert.equal(deps.analyzeCalls.length, 0);
    const output = lastPrinted(deps);
    assert.deepEqual(output, {
      mode: 'dry_run',
      planCaseCount: PLAN.length,
      checkpointConfigured: false,
      checkpointExists: false,
      completedCount: 0,
      nextCaseId: PLAN[0].caseId,
      plannedThisRun: PLAN.length,
    });
  });

  it('5) 체크포인트가 있으면 완료 수·다음 caseId·이번 예정 수를 정확히 보고한다', async () => {
    const checkpointStore = new Map<string, unknown>();
    checkpointStore.set('/tmp/checkpoint.json', await buildCheckpointForPrefix(3));
    const deps = createSpyDeps({ checkpointStore });

    const code = await runCli(['--dry-run', '--checkpoint=/tmp/checkpoint.json', '--max-cases=2'], deps);
    assert.equal(code, 0);
    const output = lastPrinted(deps);
    assert.deepEqual(output, {
      mode: 'dry_run',
      planCaseCount: PLAN.length,
      checkpointConfigured: true,
      checkpointExists: true,
      completedCount: 3,
      nextCaseId: PLAN[3].caseId,
      plannedThisRun: 2,
    });
    assert.equal(deps.createClientCalls, 0);
    assert.equal(deps.analyzeCalls.length, 0);
  });

  it('6) dry-run 출력에는 사례 문장·분석 내용이 전혀 없다(식별자만 나온다)', async () => {
    const checkpointStore = new Map<string, unknown>();
    checkpointStore.set('/tmp/checkpoint.json', await buildCheckpointForPrefix(2));
    const deps = createSpyDeps({ checkpointStore });

    await runCli(['--dry-run', '--checkpoint=/tmp/checkpoint.json'], deps);
    const raw = deps.printedLines.join('\n');
    for (const planCase of PLAN.slice(0, 2)) {
      assert.equal(raw.includes(planCase.text), false, `dry-run 출력에 사례 문장이 있으면 안 됩니다: ${planCase.text}`);
    }
  });

  it('7) --max-cases가 0이거나 정수가 아니면 사용법만 내고 0회다', async () => {
    for (const bad of ['0', '-1', '1.5', 'abc']) {
      const deps = createSpyDeps();
      const code = await runCli(['--dry-run', `--max-cases=${bad}`], deps);
      assert.equal(code, 2, `--max-cases=${bad}`);
      assert.equal(deps.createClientCalls, 0);
    }
  });
});

describe('automatic-scripture-catalog-analysis-runner-cli · execute 인자 검증', () => {
  const validArgs = () => [
    '--execute',
    '--checkpoint=/tmp/checkpoint.json',
    '--snapshot=/tmp/snapshot.json',
    `--baseline-catalog-version-hash=${BASELINE_HASH}`,
    '--max-cases=1',
  ];

  it('8) 필수 인자 중 하나라도 빠지면 client·analyze·쓰기 0회다', async () => {
    const required = ['--checkpoint=', '--snapshot=', '--baseline-catalog-version-hash=', '--max-cases='];
    for (const missingPrefix of required) {
      const deps = createSpyDeps();
      const args = validArgs().filter((arg) => !arg.startsWith(missingPrefix));
      const code = await runCli(args, deps);
      assert.equal(code, 2, `누락: ${missingPrefix}`);
      assert.equal(deps.createClientCalls, 0);
      assert.equal(deps.analyzeCalls.length, 0);
    }
  });

  it('9) checkpoint와 snapshot 경로가 같으면 거절하고 0회다', async () => {
    const deps = createSpyDeps();
    const code = await runCli(
      [
        '--execute',
        '--checkpoint=/tmp/same.json',
        '--snapshot=/tmp/same.json',
        `--baseline-catalog-version-hash=${BASELINE_HASH}`,
        '--max-cases=1',
      ],
      deps,
    );
    assert.equal(code, 2);
    assert.equal(lastPrinted(deps).reason, 'checkpoint_snapshot_same_path');
    assert.equal(deps.createClientCalls, 0);
  });

  it('10) 잘못된 baseline hash 형식이면 거절하고 0회다', async () => {
    const deps = createSpyDeps();
    const code = await runCli(
      ['--execute', '--checkpoint=/tmp/c.json', '--snapshot=/tmp/s.json', '--baseline-catalog-version-hash=not-a-hash', '--max-cases=1'],
      deps,
    );
    assert.equal(code, 2);
    assert.equal(lastPrinted(deps).reason, 'invalid_baseline_hash');
    assert.equal(deps.createClientCalls, 0);
  });

  it('11) max-cases가 0이거나 정수가 아니면 거절하고 0회다(0도 execute에서는 거절)', async () => {
    for (const bad of ['0', '-3', '2.5', 'all']) {
      const deps = createSpyDeps();
      const args = validArgs()
        .filter((arg) => !arg.startsWith('--max-cases='))
        .concat(`--max-cases=${bad}`);
      const code = await runCli(args, deps);
      assert.equal(code, 2, `--max-cases=${bad}`);
      assert.equal(lastPrinted(deps).reason, 'invalid_max_cases');
      assert.equal(deps.createClientCalls, 0);
    }
  });

  it('12) 알려지지 않은 플래그가 섞이면 거절하고 0회다', async () => {
    const deps = createSpyDeps();
    const code = await runCli([...validArgs(), '--unexpected=1'], deps);
    assert.equal(code, 2);
    assert.equal(deps.createClientCalls, 0);
  });

  it('[재현] --max-cases가 두 번 나오면(값이 달라도) 마지막 값으로 조용히 넘어가지 않고 거절한다', async () => {
    const deps = createSpyDeps();
    const code = await runCli([...validArgs(), '--max-cases=156'], deps);
    assert.equal(code, 2, '--max-cases=1 --max-cases=156 은 비용 상한을 조용히 156으로 키우면 안 됩니다.');
    assert.equal(deps.createClientCalls, 0);
    assert.equal(deps.analyzeCalls.length, 0);
  });

  it('중복된 --checkpoint/--snapshot/--baseline-catalog-version-hash도 거절하고 0회다', async () => {
    const duplicateVariants: Array<[string, string]> = [
      ['--checkpoint=', '--checkpoint=/tmp/checkpoint-2.json'],
      ['--snapshot=', '--snapshot=/tmp/snapshot-2.json'],
      ['--baseline-catalog-version-hash=', `--baseline-catalog-version-hash=scat_${'b'.repeat(64)}`],
    ];
    for (const [prefix, extra] of duplicateVariants) {
      const deps = createSpyDeps();
      const code = await runCli([...validArgs(), extra], deps);
      assert.equal(code, 2, `중복: ${prefix}`);
      assert.equal(deps.createClientCalls, 0, `중복: ${prefix}`);
      assert.equal(deps.analyzeCalls.length, 0, `중복: ${prefix}`);
    }
  });
});

describe('automatic-scripture-catalog-analysis-runner-cli · execute 정상/실패 경로', () => {
  it('13) 기존 체크포인트가 무효면 client를 만들지 않는다(검증 실패 → analyze도 0회)', async () => {
    const checkpointStore = new Map<string, unknown>();
    checkpointStore.set('/tmp/checkpoint.json', { not: 'a valid checkpoint' });
    const deps = createSpyDeps({ checkpointStore });

    const code = await runCli(
      ['--execute', '--checkpoint=/tmp/checkpoint.json', '--snapshot=/tmp/snapshot.json', `--baseline-catalog-version-hash=${BASELINE_HASH}`, '--max-cases=1'],
      deps,
    );
    assert.equal(code, 1);
    assert.equal(lastPrinted(deps).reason, 'checkpoint_invalid');
    assert.equal(deps.createClientCalls, 0, '무효한 체크포인트에서는 client를 만들면 안 됩니다.');
    assert.equal(deps.analyzeCalls.length, 0);
  });

  it('14) 체크포인트가 없으면(첫 실행) 검증을 통과해 client가 지연 생성되고 analyze 1회·checkpoint 저장 1회다', async () => {
    const checkpointStore = new Map<string, unknown>();
    const deps = createSpyDeps({ checkpointStore });

    const code = await runCli(
      ['--execute', '--checkpoint=/tmp/checkpoint.json', '--snapshot=/tmp/snapshot.json', `--baseline-catalog-version-hash=${BASELINE_HASH}`, '--max-cases=1'],
      deps,
    );
    assert.equal(code, 0);
    assert.equal(deps.createClientCalls, 1, 'analyze가 실제로 필요했던 첫 순간에 정확히 한 번 만들어야 합니다.');
    assert.equal(deps.analyzeCalls.length, 1);
    assert.equal(checkpointStore.size, 1);
    const output = lastPrinted(deps);
    assert.equal(output.mode, 'execute');
    assert.equal(output.status, 'in_progress');
    assert.equal(output.completedCount, 1);
    assert.equal(output.totalCount, PLAN.length);
  });

  it('15) 중간 상태에서는 snapshot을 저장하지 않는다', async () => {
    const checkpointStore = new Map<string, unknown>();
    const snapshotStore = new Map<string, unknown>();
    const deps = createSpyDeps({ checkpointStore, snapshotStore });

    await runCli(
      ['--execute', '--checkpoint=/tmp/checkpoint.json', '--snapshot=/tmp/snapshot.json', `--baseline-catalog-version-hash=${BASELINE_HASH}`, '--max-cases=5'],
      deps,
    );
    assert.equal(snapshotStore.size, 0);
  });

  it('16) 156건이 모두 완료되면 snapshot을 정확히 한 번 원자 저장한다', async () => {
    const checkpointStore = new Map<string, unknown>();
    checkpointStore.set('/tmp/checkpoint.json', await buildAllButOneCheckpoint());
    const snapshotStore = new Map<string, unknown>();
    const deps = createSpyDeps({ checkpointStore, snapshotStore });

    const code = await runCli(
      ['--execute', '--checkpoint=/tmp/checkpoint.json', '--snapshot=/tmp/snapshot.json', `--baseline-catalog-version-hash=${BASELINE_HASH}`, '--max-cases=1'],
      deps,
    );
    assert.equal(code, 0);
    assert.equal(deps.analyzeCalls.length, 1);
    assert.equal(snapshotStore.size, 1);
    const output = lastPrinted(deps);
    assert.equal(output.status, 'completed');
    assert.equal(output.totalCount, PLAN.length);
  });

  it('17) analyze 예외의 원문은 출력·반환값 어디에도 없다', async () => {
    const checkpointStore = new Map<string, unknown>();
    const deps = createSpyDeps({
      checkpointStore,
      analyzeThrows: new Error('provider leaked a very specific internal secret token XYZ-SECRET'),
    });

    const code = await runCli(
      ['--execute', '--checkpoint=/tmp/checkpoint.json', '--snapshot=/tmp/snapshot.json', `--baseline-catalog-version-hash=${BASELINE_HASH}`, '--max-cases=1'],
      deps,
    );
    assert.equal(code, 1);
    const output = lastPrinted(deps);
    assert.equal(output.reason, 'analyze_failed');
    const rawOutput = JSON.stringify(output);
    assert.equal(rawOutput.includes('XYZ-SECRET'), false);
    assert.equal(deps.printedLines.join('\n').includes('XYZ-SECRET'), false);
  });

  it('18) 재실행하면 저장된 다음 사례부터 이어간다', async () => {
    const checkpointStore = new Map<string, unknown>();
    const snapshotStore = new Map<string, unknown>();
    const deps = createSpyDeps({ checkpointStore, snapshotStore });
    const args = [
      '--execute',
      '--checkpoint=/tmp/checkpoint.json',
      '--snapshot=/tmp/snapshot.json',
      `--baseline-catalog-version-hash=${BASELINE_HASH}`,
      '--max-cases=1',
    ];

    await runCli(args, deps);
    assert.deepEqual(deps.analyzeCalls, [PLAN[0].text]);

    await runCli(args, deps);
    assert.deepEqual(deps.analyzeCalls, [PLAN[0].text, PLAN[1].text]);
    assert.equal(deps.createClientCalls, 2, '각 실행은 독립적인 CLI 호출이므로 client도 각각 새로 만들어진다.');
  });
});

describe('automatic-scripture-catalog-analysis-runner-cli · 출력 경로 preflight', () => {
  const execArgs = () => [
    '--execute',
    '--checkpoint=/tmp/checkpoint.json',
    '--snapshot=/tmp/snapshot.json',
    `--baseline-catalog-version-hash=${BASELINE_HASH}`,
    '--max-cases=1',
  ];

  it('[재현] checkpoint 경로가 preflight에 실패하면 client·analyze·checkpoint 저장·snapshot 저장이 모두 0회다', async () => {
    const checkpointStore = new Map<string, unknown>();
    const snapshotStore = new Map<string, unknown>();
    const deps = createSpyDeps({
      checkpointStore,
      snapshotStore,
      preflightFailsFor: new Set(['/tmp/checkpoint.json']),
    });

    const code = await runCli(execArgs(), deps);
    assert.equal(code, 1);
    assert.equal(lastPrinted(deps).reason, 'checkpoint_target_unwritable');
    assert.equal(deps.createClientCalls, 0, 'checkpoint 경로가 기록 불가능하면 client를 만들면 안 됩니다.');
    assert.equal(deps.analyzeCalls.length, 0, 'checkpoint 경로가 기록 불가능하면 analyze를 부르면 안 됩니다.');
    assert.equal(checkpointStore.size, 0);
    assert.equal(snapshotStore.size, 0);
  });

  it('[재현] snapshot 경로가 preflight에 실패하면 client·analyze·checkpoint 저장·snapshot 저장이 모두 0회다', async () => {
    const checkpointStore = new Map<string, unknown>();
    const snapshotStore = new Map<string, unknown>();
    const deps = createSpyDeps({
      checkpointStore,
      snapshotStore,
      preflightFailsFor: new Set(['/tmp/snapshot.json']),
    });

    const code = await runCli(execArgs(), deps);
    assert.equal(code, 1);
    assert.equal(lastPrinted(deps).reason, 'snapshot_target_unwritable');
    assert.equal(deps.createClientCalls, 0, 'snapshot 경로가 기록 불가능해도 156건째 분석 전에 미리 막아야 합니다.');
    assert.equal(deps.analyzeCalls.length, 0);
    assert.equal(checkpointStore.size, 0);
    assert.equal(snapshotStore.size, 0);
  });

  it('checkpoint·snapshot 두 경로 모두 client 생성보다 먼저 preflight된다', async () => {
    const deps = createSpyDeps();
    await runCli(execArgs(), deps);
    assert.deepEqual(new Set(deps.preflightCalls), new Set(['/tmp/checkpoint.json', '/tmp/snapshot.json']));
    assert.equal(deps.preflightCalls.length, 2, 'preflight는 각 경로마다 정확히 한 번만 불러야 합니다.');
  });

  it('preflight 실패 사유(원본 오류 문구)는 출력·반환값 어디에도 없다', async () => {
    const deps = createSpyDeps({ preflightFailsFor: new Set(['/tmp/checkpoint.json']) });
    await runCli(execArgs(), deps);
    const raw = deps.printedLines.join('\n');
    assert.equal(raw.includes('preflight failed (fake)'), false);
  });
});

describe('automatic-scripture-catalog-analysis-runner-cli · 실제 파일 저장소와의 통합', () => {
  it('19) 실제 파일 시스템에 checkpoint를 원자적으로 저장하고, 재실행 시 그 파일에서 이어간다', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aroeda-analysis-cli-'));
    try {
      const checkpointPath = join(dir, 'checkpoint.json');
      const snapshotPath = join(dir, 'snapshot.json');
      const deps = createRealFileDeps();
      const args = [
        '--execute',
        `--checkpoint=${checkpointPath}`,
        `--snapshot=${snapshotPath}`,
        `--baseline-catalog-version-hash=${BASELINE_HASH}`,
        '--max-cases=1',
      ];

      const firstCode = await runCli(args, deps);
      assert.equal(firstCode, 0);
      const storedAfterFirst = await readJsonFile(checkpointPath);
      assert.ok(storedAfterFirst && typeof storedAfterFirst === 'object');
      assert.equal((storedAfterFirst as { results: unknown[] }).results.length, 1);

      const secondCode = await runCli(args, deps);
      assert.equal(secondCode, 0);
      const storedAfterSecond = await readJsonFile(checkpointPath);
      assert.equal((storedAfterSecond as { results: unknown[] }).results.length, 2);

      const rawFileText = await readFile(checkpointPath, 'utf8');
      assert.equal(rawFileText, JSON.stringify(await readJsonFile(checkpointPath), sortKeysReplacerForTest, 2));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('20) 실제 파일 시스템으로 156건을 완료하면 snapshot 파일이 원자적으로 정확히 한 번 만들어진다', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aroeda-analysis-cli-'));
    try {
      const checkpointPath = join(dir, 'checkpoint.json');
      const snapshotPath = join(dir, 'snapshot.json');
      await writeJsonFileAtomic(checkpointPath, await buildAllButOneCheckpoint());
      const deps = createRealFileDeps();

      const code = await runCli(
        ['--execute', `--checkpoint=${checkpointPath}`, `--snapshot=${snapshotPath}`, `--baseline-catalog-version-hash=${BASELINE_HASH}`, '--max-cases=1'],
        deps,
      );
      assert.equal(code, 0);
      const savedSnapshot = await readJsonFile(snapshotPath);
      assert.ok(savedSnapshot && typeof savedSnapshot === 'object');
      assert.equal((savedSnapshot as { cases: unknown[] }).cases.length, PLAN.length);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('[재현] checkpoint 부모 디렉터리가 실제로 없으면(실제 preflight) client·analyze 없이 즉시 실패한다', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aroeda-analysis-cli-'));
    try {
      const checkpointPath = join(dir, 'no-such-subdir', 'checkpoint.json');
      const snapshotPath = join(dir, 'snapshot.json');
      const deps = createRealFileDeps();

      const code = await runCli(
        [
          '--execute',
          `--checkpoint=${checkpointPath}`,
          `--snapshot=${snapshotPath}`,
          `--baseline-catalog-version-hash=${BASELINE_HASH}`,
          '--max-cases=1',
        ],
        deps,
      );

      assert.equal(code, 1);
      assert.equal(lastPrinted(deps).reason, 'checkpoint_target_unwritable');
      assert.equal(deps.createClientCalls, 0);
      assert.equal(deps.analyzeCalls.length, 0);
      const entries = await readdir(dir);
      assert.deepEqual(entries, [], '없는 부모 디렉터리를 임의로 만들면 안 됩니다.');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

function createRealFileDeps(): SpyDeps {
  const printedLines: string[] = [];
  const analyzeCalls: string[] = [];
  const preflightCalls: string[] = [];
  let createClientCalls = 0;
  return {
    printedLines,
    analyzeCalls,
    preflightCalls,
    get createClientCalls() {
      return createClientCalls;
    },
    preflightWritableTarget: async (path) => {
      preflightCalls.push(path);
      await preflightJsonFileTarget(path);
    },
    createOpenAIClient: () => {
      createClientCalls += 1;
      return { fake: 'client' };
    },
    analyzeCaseText: async (_client, text) => {
      analyzeCalls.push(text);
      const planCase = PLAN.find((item) => item.text === text);
      assert.ok(planCase, `테스트 fixture 오류: 계획에 없는 문장입니다: ${text}`);
      return buildValidAnalysisForCaseId(planCase.caseId);
    },
    loadCheckpointFile: (path) => readJsonFile(path),
    saveCheckpointFile: (path, checkpoint) => writeJsonFileAtomic(path, checkpoint),
    saveSnapshotFile: (path, snapshot) => writeJsonFileAtomic(path, snapshot),
    print: (line) => {
      printedLines.push(line);
    },
  };
}

/** 156개 중 마지막 한 건만 남긴 체크포인트 — "156건 완료" 시나리오를 analyze 1회로 재현한다. */
async function buildAllButOneCheckpoint(): Promise<AnalysisRunnerCheckpoint> {
  return buildCheckpointForPrefix(PLAN.length - 1);
}

function sortKeysReplacerForTest(_key: string, val: unknown): unknown {
  if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(val as Record<string, unknown>).sort()) {
      sorted[key] = (val as Record<string, unknown>)[key];
    }
    return sorted;
  }
  return val;
}
