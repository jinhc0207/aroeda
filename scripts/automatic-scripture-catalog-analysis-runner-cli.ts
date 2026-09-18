/**
 * 자동 Scripture Catalog — 분석 실행기 안전 CLI (v1)
 *
 * 무엇을 위한 것인가
 *   `automatic-scripture-catalog-analysis-snapshot-runner.ts`(재개 가능한 실행기 핵심)와
 *   `automatic-scripture-catalog-analysis-runner-file-store.ts`(원자적 로컬 파일 저장소)를
 *   실제로 이어 붙이는 명령줄 도구다. 이 파일 스스로는 `--execute`/`--dry-run` 없이는
 *   아무 것도 하지 않는다 — import만으로 실행되지 않도록 실제 실행 로직을
 *   `runCli(args, deps)`로 뽑아 두고, 파일 맨 아래에서 "이 파일이 직접 실행됐을 때만"
 *   실제 의존성(OpenAI client·실제 파일 I/O·`console.log`)을 연결한다.
 *
 * 허용 모드
 *   `--dry-run`과 `--execute` 중 정확히 하나가 있어야 한다. 없거나 둘 다 있으면
 *   사용법만 출력하고 끝난다(OpenAI client 생성 0회). `--dry-run`·`--execute`가
 *   반복되거나, 같은 `--key=value` flag가 두 번 나오면(값이 같아도) 마지막 값이
 *   조용히 이기게 두지 않고 똑같이 거절한다 — 특히 `--max-cases`가 중복되면 비용
 *   상한을 조용히 무시하는 셈이 되기 때문이다.
 *
 * dry-run
 *   OpenAI client·analyze·체크포인트/스냅샷 쓰기를 전혀 하지 않는다. `--checkpoint`를
 *   주면 그 파일을 읽어서(쓰지 않는다) 대략적인 진행 상황만 훑어본다 — 계획 156개 중
 *   몇 건이 이미 있는지 개수만 세지, `validateAnalysisRunnerCheckpoint`로 완전히
 *   검증하지 않는다(그러려면 baseline hash·environment가 필요한데, dry-run은 그런
 *   입력 없이도 안전하게 돌아가야 한다). 정확한 재개 지점은 `--execute`가 전체
 *   검증을 통해 확정한다. 사례 문장·분석 내용·API key는 출력하지 않는다 — caseId
 *   같은 식별자만 낸다.
 *
 * execute
 *   `--checkpoint`·`--snapshot`·`--baseline-catalog-version-hash`·`--max-cases`
 *   네 인자가 모두 명시적으로 있어야 한다. `--max-cases`는 생략할 수 없고, 0도
 *   거절한다(양수만 허용 — 한 번에 얼마나 비용을 쓸지 항상 명시하게 한다).
 *   checkpoint와 snapshot 경로가 같으면 거절한다.
 *
 *   **preflight**: OpenAI client를 만들거나 analyze를 부르기 전에, checkpoint·
 *   snapshot 두 경로 각각에 대해 `preflightJsonFileTarget`(파일 저장소)로 "나중에
 *   실제로 쓸 수 있는가"를 먼저 확인한다. 이 확인 없이는 잘못된 checkpoint 경로가
 *   첫 유료 analyze 호출이 끝난 뒤(체크포인트를 저장하려는 순간)에야 드러나거나,
 *   잘못된 snapshot 경로가 156건을 전부 분석한 뒤(최종 저장 순간)에야 드러날 수
 *   있다. 어느 한쪽이라도 preflight에 실패하면 client·analyze·checkpoint 저장·
 *   snapshot 저장이 전부 0회다.
 *
 *   OpenAI client는 **지연 생성**한다 — `runAnalysisSnapshotRunner`는 항상 인자
 *   검증 → 기존 체크포인트 완전 검증 → (그 다음에야) 첫 analyze 호출의 순서로
 *   진행하므로, client 생성을 "실제로 analyze를 처음 부르는 순간"으로 미루면 그
 *   생성이 자동으로 "인자와 기존 체크포인트가 둘 다 검증된 뒤"에만 일어난다.
 *   검증 로직을 이 파일에서 다시 베끼지 않고도 그 순서를 보장하는 방법이다.
 *
 *   최종 스냅샷은 `runAnalysisSnapshotRunner`가 156건 전부 검증에 성공했을 때만
 *   돌려주고, 이 CLI가 그 경우에만 원자적으로 파일에 저장한다 — `in_progress`나
 *   `failed`일 때는 스냅샷 파일을 만들거나 건드리지 않는다.
 *
 * 이 파일이 하지 않는 일(이번 작업)
 *   실제로 `--execute`를 실행하지 않는다. 실제 OpenAI client를 만들지 않는다.
 *   Supabase·DB·Edge Function을 부르지 않는다. 검증은 `--dry-run`과 fake
 *   dependency를 주입한 테스트로만 한다.
 */

import { resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';

import OpenAI from 'openai';

import { CATALOG_VERSION_HASH_FORMAT } from '../supabase/functions/_shared/automatic-scripture-catalog-contract.ts';
import type { FrozenAnalysisSnapshot } from '../supabase/functions/_shared/automatic-scripture-catalog-analysis-snapshot-contract.ts';
import type { SituationAnalysis } from '../supabase/functions/_shared/situation-analysis.ts';
import { analyzeSituation } from './analyzer-prompt.ts';
import { buildDeterministicAnalysisPlan } from './automatic-scripture-catalog-analysis-snapshot-builder.ts';
import {
  type AnalysisRunnerCaseInput,
  type AnalysisRunnerCheckpoint,
  type AnalyzeCaseFunction,
  runAnalysisSnapshotRunner,
} from './automatic-scripture-catalog-analysis-snapshot-runner.ts';
import {
  preflightJsonFileTarget,
  readJsonFile,
  writeJsonFileAtomic,
} from './automatic-scripture-catalog-analysis-runner-file-store.ts';

/* ------------------------------------------------------------------ */
/* 의존성 — 테스트는 전부 여기만 가짜로 바꾼다                                    */
/* ------------------------------------------------------------------ */

export type CliDependencies = {
  /**
   * execute 모드에서, OpenAI client를 만들거나 analyze를 부르기 전에 checkpoint·snapshot
   * 두 경로 각각에 대해 먼저 부른다(preflight). 실제로 쓰지는 않고 "나중에 쓸 수 있는가"만
   * 확인한다 — 어느 한쪽이라도 실패하면 client·analyze·checkpoint 저장·snapshot 저장이
   * 전부 0회여야 한다. 실패는 예외로만 알린다(경로·OS 원문 없이).
   */
  preflightWritableTarget: (path: string) => Promise<void>;
  /** execute 모드에서, 실제로 첫 analyze가 필요한 순간에만 정확히 한 번 부른다. */
  createOpenAIClient: () => unknown;
  /** client와 사례 문장만 받는다 — caseId·expected는 넘기지 않는다. 실패는 예외로만 알린다(원문 없이). */
  analyzeCaseText: (client: unknown, text: string) => Promise<SituationAnalysis>;
  /** 파일이 없으면 null. 손상·symlink 등은 예외. */
  loadCheckpointFile: (path: string) => Promise<unknown>;
  saveCheckpointFile: (path: string, checkpoint: AnalysisRunnerCheckpoint) => Promise<void>;
  saveSnapshotFile: (path: string, snapshot: FrozenAnalysisSnapshot) => Promise<void>;
  /** 유일한 출력 통로. 실제 실행에서는 console.log로 연결한다. */
  print: (line: string) => void;
};

/* ------------------------------------------------------------------ */
/* 인자 구문 분석                                                        */
/* ------------------------------------------------------------------ */

const USAGE = [
  'usage:',
  '  --dry-run [--checkpoint=<path>] [--max-cases=<positive integer>]',
  '  --execute --checkpoint=<path> --snapshot=<path> --baseline-catalog-version-hash=<scat_...> --max-cases=<positive integer>',
  '',
  '--dry-run과 --execute 중 정확히 하나만 지정해야 합니다.',
].join('\n');

type ParsedFlags = {
  dryRun: boolean;
  execute: boolean;
  values: Map<string, string>;
  malformed: boolean;
};

function parseFlags(args: readonly string[]): ParsedFlags {
  let dryRunCount = 0;
  let executeCount = 0;
  let malformed = false;
  const values = new Map<string, string>();

  for (const token of args) {
    if (token === '--dry-run') {
      dryRunCount += 1;
      continue;
    }
    if (token === '--execute') {
      executeCount += 1;
      continue;
    }
    const match = /^--([a-z][a-z0-9-]*)=(.*)$/.exec(token);
    if (!match) {
      malformed = true;
      continue;
    }
    const [, key, value] = match;
    // 같은 key가 두 번 나오면(값이 같아도) 조용히 덮어쓰지 않고 거절한다 — 특히
    // `--max-cases`가 두 번 나올 때 마지막 값이 이긴다면 비용 상한을 조용히 무시하는
    // 셈이 된다.
    if (values.has(key)) {
      malformed = true;
      continue;
    }
    values.set(key, value);
  }

  // --dry-run이나 --execute를 반복해도(값이 없는 flag라 위 Map 검사에 걸리지 않으므로)
  // 똑같이 "조용히 무시되는 중복"이 될 수 있어 별도로 거절한다.
  if (dryRunCount > 1 || executeCount > 1) malformed = true;

  return { dryRun: dryRunCount > 0, execute: executeCount > 0, values, malformed };
}

const POSITIVE_INTEGER = /^[1-9][0-9]*$/;

function parsePositiveInteger(raw: string): number | null {
  return POSITIVE_INTEGER.test(raw) ? Number(raw) : null;
}

function rejectExtraKeys(values: Map<string, string>, allowed: ReadonlySet<string>): boolean {
  for (const key of values.keys()) if (!allowed.has(key)) return true;
  return false;
}

/* ------------------------------------------------------------------ */
/* dry-run                                                              */
/* ------------------------------------------------------------------ */

const DRY_RUN_ALLOWED_KEYS = new Set(['checkpoint', 'max-cases']);

/** 체크포인트 파일의 대략적인 진행 개수만 센다 — 계약 검증(exact-fields·순서·environment)은 하지 않는다. */
function peekCompletedCount(raw: unknown, planLength: number): number {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return 0;
  const results = (raw as Record<string, unknown>).results;
  if (!Array.isArray(results)) return 0;
  return Math.min(results.length, planLength);
}

async function runDryRun(values: Map<string, string>, deps: CliDependencies): Promise<number> {
  if (rejectExtraKeys(values, DRY_RUN_ALLOWED_KEYS)) {
    deps.print(USAGE);
    return 2;
  }

  const plan = buildDeterministicAnalysisPlan();

  const maxCasesRaw = values.get('max-cases');
  let maxCases: number | undefined;
  if (maxCasesRaw !== undefined) {
    const parsed = parsePositiveInteger(maxCasesRaw);
    if (parsed === null) {
      deps.print(USAGE);
      return 2;
    }
    maxCases = parsed;
  }

  const checkpointPath = values.get('checkpoint');
  const checkpointConfigured = checkpointPath !== undefined;
  let checkpointExists = false;
  let completedCount = 0;

  if (checkpointPath !== undefined) {
    let raw: unknown;
    try {
      raw = await deps.loadCheckpointFile(checkpointPath);
    } catch {
      // 읽기 실패(손상·symlink 등)의 원문은 담지 않는다 — 상태만 보고한다.
      deps.print(
        JSON.stringify({
          mode: 'dry_run',
          planCaseCount: plan.length,
          checkpointConfigured: true,
          checkpointReadable: false,
        }),
      );
      return 1;
    }
    if (raw !== null && raw !== undefined) {
      checkpointExists = true;
      completedCount = peekCompletedCount(raw, plan.length);
    }
  }

  const remaining = plan.length - completedCount;
  const plannedThisRun = maxCases === undefined ? remaining : Math.min(maxCases, remaining);
  const nextCaseId = completedCount < plan.length ? plan[completedCount].caseId : null;

  deps.print(
    JSON.stringify({
      mode: 'dry_run',
      planCaseCount: plan.length,
      checkpointConfigured,
      checkpointExists,
      completedCount,
      nextCaseId,
      plannedThisRun,
    }),
  );
  return 0;
}

/* ------------------------------------------------------------------ */
/* execute                                                              */
/* ------------------------------------------------------------------ */

const EXECUTE_REQUIRED_KEYS = ['checkpoint', 'snapshot', 'baseline-catalog-version-hash', 'max-cases'] as const;
const EXECUTE_ALLOWED_KEYS = new Set<string>(EXECUTE_REQUIRED_KEYS);

async function runExecute(values: Map<string, string>, deps: CliDependencies): Promise<number> {
  if (rejectExtraKeys(values, EXECUTE_ALLOWED_KEYS)) {
    deps.print(USAGE);
    return 2;
  }
  for (const key of EXECUTE_REQUIRED_KEYS) {
    if (!values.has(key)) {
      deps.print(USAGE);
      return 2;
    }
  }

  const checkpointPath = values.get('checkpoint')!;
  const snapshotPath = values.get('snapshot')!;
  const baselineHash = values.get('baseline-catalog-version-hash')!;
  const maxCasesRaw = values.get('max-cases')!;

  if (resolvePath(checkpointPath) === resolvePath(snapshotPath)) {
    deps.print(JSON.stringify({ mode: 'execute', status: 'rejected', reason: 'checkpoint_snapshot_same_path' }));
    return 2;
  }
  if (!CATALOG_VERSION_HASH_FORMAT.test(baselineHash)) {
    deps.print(JSON.stringify({ mode: 'execute', status: 'rejected', reason: 'invalid_baseline_hash' }));
    return 2;
  }
  const maxCases = parsePositiveInteger(maxCasesRaw);
  if (maxCases === null) {
    // 0도 여기서 걸린다 — POSITIVE_INTEGER는 1 이상만 통과시킨다.
    deps.print(JSON.stringify({ mode: 'execute', status: 'rejected', reason: 'invalid_max_cases' }));
    return 2;
  }

  // OpenAI client를 만들거나 analyze를 부르기 전에 두 출력 경로 모두 "나중에 쓸 수
  // 있는가"를 먼저 확인한다 — 그러지 않으면 잘못된 checkpoint 경로에서도 첫 유료
  // analyze 호출까지 끝난 뒤에야(체크포인트 저장 시점에) 실패하거나, 156건을 전부
  // 분석한 뒤에야(최종 스냅샷 저장 시점에) 실패할 수 있다.
  try {
    await deps.preflightWritableTarget(checkpointPath);
  } catch {
    deps.print(JSON.stringify({ mode: 'execute', status: 'failed', reason: 'checkpoint_target_unwritable' }));
    return 1;
  }
  try {
    await deps.preflightWritableTarget(snapshotPath);
  } catch {
    deps.print(JSON.stringify({ mode: 'execute', status: 'failed', reason: 'snapshot_target_unwritable' }));
    return 1;
  }

  const planLength = buildDeterministicAnalysisPlan().length;

  let client: unknown = null;
  const analyze: AnalyzeCaseFunction = async (input: AnalysisRunnerCaseInput): Promise<SituationAnalysis> => {
    // 지연 생성: 여기 도달했다는 것 자체가 runAnalysisSnapshotRunner의 인자·기존
    // 체크포인트 검증을 이미 통과했다는 뜻이다(그 검증은 첫 analyze 호출보다 먼저
    // 끝난다) — 그래서 이 한 줄만으로 "검증된 뒤에만 client 생성"이 보장된다.
    if (client === null) {
      client = deps.createOpenAIClient();
    }
    return deps.analyzeCaseText(client, input.text);
  };

  const result = await runAnalysisSnapshotRunner({
    analyze,
    loadCheckpoint: () => deps.loadCheckpointFile(checkpointPath),
    saveCheckpoint: (checkpoint) => deps.saveCheckpointFile(checkpointPath, checkpoint),
    baselineCatalogVersionHash: baselineHash,
    maxCases,
  });

  if (result.status === 'completed') {
    try {
      await deps.saveSnapshotFile(snapshotPath, result.snapshot);
    } catch {
      deps.print(JSON.stringify({ mode: 'execute', status: 'failed', reason: 'snapshot_save_failed' }));
      return 1;
    }
    deps.print(JSON.stringify({ mode: 'execute', status: 'completed', totalCount: planLength }));
    return 0;
  }

  if (result.status === 'in_progress') {
    deps.print(
      JSON.stringify({
        mode: 'execute',
        status: 'in_progress',
        completedCount: result.completedCount,
        totalCount: result.totalCount,
      }),
    );
    return 0;
  }

  deps.print(
    JSON.stringify({
      mode: 'execute',
      status: 'failed',
      reason: result.reason,
      ...(result.caseId !== undefined ? { caseId: result.caseId } : {}),
    }),
  );
  return 1;
}

/* ------------------------------------------------------------------ */
/* 진입점 — 이 함수는 import만으로는 절대 실행되지 않는다                            */
/* ------------------------------------------------------------------ */

export async function runCli(args: readonly string[], deps: CliDependencies): Promise<number> {
  const parsed = parseFlags(args);

  if (parsed.malformed || parsed.dryRun === parsed.execute) {
    // dryRun === execute: 정확히 하나만 있어야 하는데 둘 다 없거나(false===false) 둘 다 있다(true===true).
    deps.print(USAGE);
    return 2;
  }

  return parsed.dryRun ? runDryRun(parsed.values, deps) : runExecute(parsed.values, deps);
}

/* ------------------------------------------------------------------ */
/* 실제 의존성 연결 — 이 파일이 직접 실행됐을 때만 아래 블록이 돈다                     */
/* ------------------------------------------------------------------ */

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}

function createRealOpenAIClient(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || apiKey.trim() === '') {
    throw new Error('missing_api_key');
  }
  return new OpenAI({ apiKey });
}

async function realAnalyzeCaseText(client: unknown, text: string): Promise<SituationAnalysis> {
  let outcome: Awaited<ReturnType<typeof analyzeSituation>>;
  try {
    outcome = await analyzeSituation(client as OpenAI, text);
  } catch {
    throw new Error('analyze_failed');
  }
  if (outcome.analysis === null) throw new Error('analyze_failed');
  return outcome.analysis;
}

if (isDirectExecution()) {
  const realDeps: CliDependencies = {
    preflightWritableTarget: (path) => preflightJsonFileTarget(path),
    createOpenAIClient: createRealOpenAIClient,
    analyzeCaseText: realAnalyzeCaseText,
    loadCheckpointFile: (path) => readJsonFile(path),
    saveCheckpointFile: (path, checkpoint) => writeJsonFileAtomic(path, checkpoint),
    saveSnapshotFile: (path, snapshot) => writeJsonFileAtomic(path, snapshot),
    print: (line) => {
      console.log(line);
    },
  };

  runCli(process.argv.slice(2), realDeps)
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      console.log(JSON.stringify({ mode: 'unknown', status: 'failed', reason: 'internal_error' }));
      process.exitCode = 1;
    });
}
