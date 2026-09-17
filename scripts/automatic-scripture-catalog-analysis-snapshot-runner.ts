/**
 * 자동 Scripture Catalog — 재개 가능한 분석 실행기 핵심 (v1)
 *
 * 무엇을 위한 것인가
 *   `automatic-scripture-catalog-analysis-snapshot-builder.ts`는 156개 결정적 계획을
 *   만들고, 외부에서 얻은 156개 분석 결과를 한 번에 스냅샷으로 조립하는 순수 함수만
 *   가지고 있었다 — "그 156개 결과를 실제로 어떻게, 몇 번에 나눠, 중단됐다 이어서
 *   얻을 것인가"는 없었다. 이 파일이 그 자리를 채운다.
 *
 *   156개 계획을 처음부터 순서대로 하나씩 분석하고, 성공할 때마다 체크포인트에 그
 *   결과를 더해 저장한다. 프로세스가 중간에 죽어도, 다음 실행이 저장된 체크포인트
 *   다음 사례부터 이어간다. 156개가 모두 모이면 기존 builder로 최종 고정 스냅샷을
 *   만든다.
 *
 * 이 파일이 하지 않는 일
 *   OpenAI SDK를 부르지 않는다. 실제 파일·DB에 쓰지 않는다. 환경변수·네트워크를
 *   읽지 않는다. 분석 함수(`analyze`)와 체크포인트 읽기·쓰기(`loadCheckpoint`/
 *   `saveCheckpoint`)는 전부 호출자가 주입한다 — 이 파일은 그 세 함수를 **어떤 순서로,
 *   언제 부르고, 실패하면 어떻게 멈출지**만 정한다. 실제 OpenAI transport나 파일
 *   저장소 구현은 후속 작업이다.
 *
 * "정확히 한 번"을 주장하지 않는다
 *   analyze 호출과 체크포인트 저장은 원자적일 수 없다. 이 실행기는 항상 "분석 성공 →
 *   저장 성공"의 순서로만 다음 사례로 넘어가고, 저장이 성공한 뒤에만 그 결과를
 *   신뢰한다. 하지만 analyze가 성공적으로 값을 돌려준 **직후**, `saveCheckpoint`가
 *   끝나기 **전**에 프로세스가 죽으면, 그 결과는 어디에도 저장되지 않은 채 사라진다.
 *   다음 실행은 저장된 체크포인트만 보고 다시 시작하므로, 그 사례는 **다시 analyze가
 *   호출된다** — 즉 장애 시 최대 한 건(직전에 저장되지 않은 사례)이 다시 호출될 수
 *   있다. 이 실행기는 체크포인트에 실제로 저장된 결과만 진행으로 인정하며, 그 이상을
 *   주장하지 않는다.
 *
 * 체크포인트 계약
 *   `contractVersion`·`planFingerprint`(지금 156개 계획의 지문)·`environment`(지금
 *   저장소의 실제 분석 환경 결속)·`results`(계획 맨 앞에서부터 이어지는, 성공적으로
 *   검증된 결과의 연속 prefix)만 담는다. 각 결과는 정확히 `{caseId, text, analysis}`뿐이다.
 *   raw response·provider 오류 원문·token usage·API key·사용자/세션 식별자·시각·사람
 *   승인·서명 필드는 이 계약 어디에도 들어갈 자리가 없다.
 */

import type { SituationAnalysis } from '../supabase/functions/_shared/situation-analysis.ts';
import {
  CATALOG_VERSION_HASH_FORMAT,
  canonicalJson,
  computeArtifactHash,
} from '../supabase/functions/_shared/automatic-scripture-catalog-contract.ts';
import {
  type AnalysisSnapshotEnvironmentBinding,
  type FrozenAnalysisSnapshot,
  validateAnalysisSnapshotCase,
} from '../supabase/functions/_shared/automatic-scripture-catalog-analysis-snapshot-contract.ts';
import { buildCurrentAnalysisSnapshotEnvironment } from '../supabase/functions/_shared/automatic-scripture-catalog-analysis-environment.ts';
import {
  type AnalysisSnapshotPlanCase,
  type ExternalAnalysisResult,
  buildDeterministicAnalysisPlan,
  buildFrozenAnalysisSnapshot,
} from './automatic-scripture-catalog-analysis-snapshot-builder.ts';

/* ------------------------------------------------------------------ */
/* 체크포인트 계약                                                       */
/* ------------------------------------------------------------------ */

export const ANALYSIS_RUNNER_CHECKPOINT_CONTRACT_VERSION = 'scripture-catalog-analysis-runner-checkpoint/v1';

/** 체크포인트에 담는 결과 한 건. 정확히 이 세 필드만 허용한다. */
export type AnalysisRunnerCheckpointResult = {
  caseId: string;
  text: string;
  analysis: SituationAnalysis;
};

export type AnalysisRunnerCheckpoint = {
  contractVersion: typeof ANALYSIS_RUNNER_CHECKPOINT_CONTRACT_VERSION;
  /** 지금 156개 계획(`computeAnalysisPlanFingerprint`)의 지문. 계획이 바뀌면 거절된다. */
  planFingerprint: string;
  /** 지금 저장소의 실제 분석 환경 결속. 하나라도 다르면 거절된다. */
  environment: AnalysisSnapshotEnvironmentBinding;
  /** 계획 맨 앞에서부터 이어지는 연속 prefix. 중간이 비거나 순서가 다르면 거절된다. */
  results: readonly AnalysisRunnerCheckpointResult[];
};

const CHECKPOINT_FIELDS = ['contractVersion', 'planFingerprint', 'environment', 'results'] as const;
const CHECKPOINT_RESULT_FIELDS = ['caseId', 'text', 'analysis'] as const;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function exactFields(value: Record<string, unknown>, fields: readonly string[], label: string): string[] {
  const errors: string[] = [];
  for (const key of Object.keys(value)) if (!fields.includes(key)) errors.push(`${label}: 계약에 없는 항목입니다: ${key}`);
  for (const key of fields) if (!Object.hasOwn(value, key)) errors.push(`${label}: 빠진 항목입니다: ${key}`);
  return errors;
}

/**
 * 156개 계획에서 `{caseId, kind, text, expected}`만 뽑아 지문을 낸다. 계획이 조금이라도
 * 바뀌면(코퍼스 원본이 바뀌거나 SAFE 매핑이 바뀌면) 다른 지문이 나온다. 기존
 * `computeArtifactHash`·`canonicalJson`을 그대로 재사용한다.
 */
export async function computeAnalysisPlanFingerprint(plan: readonly AnalysisSnapshotPlanCase[]): Promise<string> {
  return computeArtifactHash(plan.map((item) => ({ caseId: item.caseId, kind: item.kind, text: item.text, expected: item.expected })));
}

export type AnalysisRunnerCheckpointValidationExpectation = {
  planFingerprint: string;
  environment: AnalysisSnapshotEnvironmentBinding;
  plan: readonly AnalysisSnapshotPlanCase[];
};

export type AnalysisRunnerCheckpointValidationResult =
  | { ok: true; checkpoint: AnalysisRunnerCheckpoint }
  | { ok: false; errors: string[] };

/**
 * 체크포인트가 계약을 지키는지 확인한다: exact-fields, `contractVersion`, 지금 계획의
 * 지문, 지금 저장소의 실제 environment, 그리고 `results`가 계획 맨 앞에서부터 이어지는
 * 연속 prefix인지(순서·중복·계획 밖 사례·text 변경을 한 번에 잡는다 — 위치 i의 결과가
 * `plan[i]`의 caseId·text와 정확히 같아야 한다는 규칙 하나로 전부 표현된다). 각 결과의
 * `analysis`는 `validateAnalysisSnapshotCase`로 다시 검증한다(exact-fields·
 * `validateSituationAnalysis`·교차 일관성 전부 포함).
 *
 * 오류를 고치거나 추정하지 않는다 — 하나라도 어긋나면 부분 체크포인트 없이
 * `{ok:false, errors}`만 돌려준다.
 */
export function validateAnalysisRunnerCheckpoint(
  value: unknown,
  expected: AnalysisRunnerCheckpointValidationExpectation,
): AnalysisRunnerCheckpointValidationResult {
  if (!isPlainObject(value)) return { ok: false, errors: ['checkpoint: 객체가 아닙니다.'] };

  const errors = exactFields(value, CHECKPOINT_FIELDS, 'checkpoint');

  if (value.contractVersion !== ANALYSIS_RUNNER_CHECKPOINT_CONTRACT_VERSION) {
    errors.push(`checkpoint.contractVersion: '${ANALYSIS_RUNNER_CHECKPOINT_CONTRACT_VERSION}'이어야 합니다.`);
  }
  if (typeof value.planFingerprint !== 'string' || value.planFingerprint !== expected.planFingerprint) {
    errors.push('checkpoint.planFingerprint: 지금 156개 계획의 지문과 다릅니다.');
  }
  // canonicalJson은 undefined 같은 "지문을 만들 수 없는 값"에 예외를 던진다(예: environment
  // 필드가 아예 없어서 value.environment가 undefined인 경우). 이 함수는 검증기이지 신뢰할
  // 수 있는 입력만 받는 내부 도우미가 아니므로, 그 예외가 밖으로 새어 나가면 안 된다 —
  // 비교가 어떤 이유로 실패하든 "같지 않다"는 검증 결과로만 수렴시킨다.
  let environmentMatches: boolean;
  try {
    environmentMatches = canonicalJson(value.environment) === canonicalJson(expected.environment);
  } catch {
    environmentMatches = false;
  }
  if (!environmentMatches) {
    errors.push('checkpoint.environment: 지금 저장소의 실제 분석 환경과 다릅니다.');
  }

  if (!Array.isArray(value.results)) {
    errors.push('checkpoint.results: 배열이어야 합니다.');
    return { ok: false, errors };
  }
  if (value.results.length > expected.plan.length) {
    errors.push(`checkpoint.results: 계획(${expected.plan.length}개)보다 많은 결과를 담고 있습니다(${value.results.length}개).`);
  }

  const validated: AnalysisRunnerCheckpointResult[] = [];
  value.results.forEach((item: unknown, index: number) => {
    const label = `checkpoint.results[${index}]`;
    if (!isPlainObject(item)) {
      errors.push(`${label}: 객체가 아닙니다.`);
      return;
    }
    const shapeErrors = exactFields(item, CHECKPOINT_RESULT_FIELDS, label);
    if (shapeErrors.length > 0) {
      errors.push(...shapeErrors);
      return;
    }

    const planCase = expected.plan[index];
    if (!planCase || planCase.caseId !== item.caseId) {
      errors.push(
        `${label}.caseId: 계획의 이 위치와 다릅니다(이 자리는 caseId=${planCase?.caseId ?? '(계획 범위 밖)'}이어야 하는데 ` +
          `${String(item.caseId)}입니다) — 연속된 prefix가 아니거나 순서·중복이 잘못됐을 수 있습니다.`,
      );
      return;
    }
    if (planCase.text !== item.text) {
      errors.push(`${label}.text: 계획의 caseId=${planCase.caseId} 문장과 다릅니다.`);
      return;
    }

    const candidate = {
      caseId: planCase.caseId,
      kind: planCase.kind,
      text: planCase.text,
      expected: planCase.expected,
      analysis: item.analysis,
    };
    const caseCheck = validateAnalysisSnapshotCase(candidate, label);
    if (!caseCheck.valid) {
      errors.push(...caseCheck.errors);
      return;
    }

    validated.push({ caseId: planCase.caseId, text: planCase.text, analysis: item.analysis as SituationAnalysis });
  });

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    checkpoint: {
      contractVersion: ANALYSIS_RUNNER_CHECKPOINT_CONTRACT_VERSION,
      planFingerprint: expected.planFingerprint,
      environment: expected.environment,
      results: validated,
    },
  };
}

/* ------------------------------------------------------------------ */
/* 재개 가능한 순차 실행기                                                */
/* ------------------------------------------------------------------ */

/** analyze는 caseId·text만 받는다 — expected를 절대 넘기지 않는다(분석이 정답을 미리 알면 교차 일관성 검사가 무의미해진다). */
export type AnalysisRunnerCaseInput = { caseId: string; text: string };
export type AnalyzeCaseFunction = (input: AnalysisRunnerCaseInput) => Promise<SituationAnalysis>;

/** 저장된 체크포인트가 없으면 `null`(또는 `undefined`)을 돌려준다. */
export type LoadCheckpointFunction = () => Promise<unknown>;
/** 저장에 실패하면(디스크 오류 등) 예외를 던진다 — 성공을 가장하지 않는다. */
export type SaveCheckpointFunction = (checkpoint: AnalysisRunnerCheckpoint) => Promise<void>;

export type AnalysisRunnerOptions = {
  analyze: AnalyzeCaseFunction;
  loadCheckpoint: LoadCheckpointFunction;
  saveCheckpoint: SaveCheckpointFunction;
  /** candidate나 모델 응답이 아니라 신뢰 경계(장차 validation-context RPC)에서 얻은 값이어야 한다. */
  baselineCatalogVersionHash: string;
  /** 이번 호출에서 최대 몇 건을 새로 분석할지. 생략하면 남은 사례를 전부 처리한다. */
  maxCases?: number;
};

export const ANALYSIS_RUNNER_FAILURE_REASONS = [
  'invalid_baseline_hash',
  'invalid_max_cases',
  'checkpoint_load_failed',
  'checkpoint_invalid',
  'analyze_failed',
  'analysis_invalid',
  'checkpoint_save_failed',
  'final_snapshot_invalid',
] as const;
export type AnalysisRunnerFailureReason = (typeof ANALYSIS_RUNNER_FAILURE_REASONS)[number];

/**
 * 공개 결과는 `reason`(과 사례 단위 실패일 때만 `caseId`)만 담는다 — 상세 검증 오류나
 * analyze/loadCheckpoint/saveCheckpoint가 던진 예외의 원문은 절대 담지 않는다. 모델이나
 * provider가 만든 값(예: 표준 사전에 없는 태그 이름 자체)이 이 결과를 통해 호출자 로그로
 * 새어 나가지 않도록 하기 위해서다. 그 값을 직접 보려면(개발용) `validateAnalysisSnapshotCase`·
 * `validateAnalysisRunnerCheckpoint` 같은 순수 validator를 호출자가 직접 불러야 한다 —
 * 이 실행기는 그 함수들을 감싸기만 할 뿐, 그 반환값의 `errors`를 공개 결과에 옮기지 않는다.
 */
export type AnalysisRunnerResult =
  | { status: 'completed'; snapshot: FrozenAnalysisSnapshot }
  | { status: 'in_progress'; completedCount: number; totalCount: number }
  | { status: 'failed'; reason: AnalysisRunnerFailureReason; caseId?: string };

/**
 * 실행 순서
 *   1. 156개 결정적 계획 생성
 *   2. 지금 environment와 계획 지문 계산
 *   3. `loadCheckpoint()`를 부른다 — 이 호출이 예외를 던지면(디스크 오류 등) 그 원문을
 *      담지 않고 `checkpoint_load_failed`로만 멈춘다. analyze·저장은 아직 0회다.
 *   4. 기존 체크포인트가 있으면 `validateAnalysisRunnerCheckpoint`로 완전 검증
 *   5. 체크포인트 결과 다음 사례부터(없으면 맨 처음부터) 한 건씩 순차 분석
 *   6. 분석 결과를 `validateAnalysisSnapshotCase`로 검증
 *   7. 성공한 결과 한 건을 더한 새 체크포인트를 저장
 *   8. 저장이 성공한 뒤에만 다음 사례로 진행 — 저장 전에 다음 analyze를 부르지 않는다
 *   9. 156개가 모두 모이면 기존 `buildFrozenAnalysisSnapshot`으로 최종 스냅샷을 만든다
 *   10. 그 최종 검증이 완전히 성공한 경우에만 `completed`를 돌려준다
 *
 * 병렬 호출은 하지 않는다 — 모든 analyze 호출은 `for` 루프 안에서 순서대로 `await`한다.
 *
 * 실패하면(loadCheckpoint 예외, 체크포인트 검증 실패, analyze 예외, 분석 검증 실패,
 * 저장 실패, 최종 검증 실패) 그 시점까지 이미 저장된 정상 prefix는 그대로 두고,
 * **`reason`(사례 단위 실패면 `caseId`까지)만** 돌려준다. `AnalysisRunnerResult`에는
 * `errors` 필드가 없다 — provider 오류 원문도, 순수 validator가 만든 상세 오류 문자열도
 * (그 안에 모델이 만든 값 자체가 섞여 있을 수 있으므로) 공개 결과로 옮기지 않는다.
 * 그 상세 오류가 필요하면 `validateAnalysisRunnerCheckpoint`·`validateAnalysisSnapshotCase`를
 * 직접 불러야 한다.
 */
export async function runAnalysisSnapshotRunner(options: AnalysisRunnerOptions): Promise<AnalysisRunnerResult> {
  const { analyze, loadCheckpoint, saveCheckpoint, baselineCatalogVersionHash, maxCases } = options;

  if (!CATALOG_VERSION_HASH_FORMAT.test(baselineCatalogVersionHash)) {
    return { status: 'failed', reason: 'invalid_baseline_hash' };
  }
  if (maxCases !== undefined && (!Number.isInteger(maxCases) || maxCases < 0)) {
    return { status: 'failed', reason: 'invalid_max_cases' };
  }

  const plan = buildDeterministicAnalysisPlan();
  const environment = await buildCurrentAnalysisSnapshotEnvironment(baselineCatalogVersionHash);
  const planFingerprint = await computeAnalysisPlanFingerprint(plan);

  let existing: unknown;
  try {
    existing = await loadCheckpoint();
  } catch {
    // 읽기 오류 원문(예: 디스크 경로·내부 스택)을 담지 않는다. analyze·저장은 아직 부르지 않았다.
    return { status: 'failed', reason: 'checkpoint_load_failed' };
  }

  let results: AnalysisRunnerCheckpointResult[];
  if (existing === null || existing === undefined) {
    results = [];
  } else {
    const checkpointCheck = validateAnalysisRunnerCheckpoint(existing, { planFingerprint, environment, plan });
    if (!checkpointCheck.ok) return { status: 'failed', reason: 'checkpoint_invalid' };
    results = [...checkpointCheck.checkpoint.results];
  }

  const remaining = plan.length - results.length;
  const toProcess = maxCases === undefined ? remaining : Math.min(maxCases, remaining);

  for (let step = 0; step < toProcess; step += 1) {
    const planCase = plan[results.length];

    let analysis: SituationAnalysis;
    try {
      analysis = await analyze({ caseId: planCase.caseId, text: planCase.text });
    } catch {
      // provider 오류 원문을 담지 않는다 — 안전한 내부 코드와 caseId만 돌려준다.
      return { status: 'failed', reason: 'analyze_failed', caseId: planCase.caseId };
    }

    const candidate = {
      caseId: planCase.caseId,
      kind: planCase.kind,
      text: planCase.text,
      expected: planCase.expected,
      analysis,
    };
    const caseCheck = validateAnalysisSnapshotCase(candidate);
    if (!caseCheck.valid) {
      // caseCheck.errors는 모델이 만든 값(예: 알 수 없는 태그 이름 자체)을 그대로 담고 있을
      // 수 있다 — 공개 결과에는 caseId까지만 남기고 옮기지 않는다.
      return { status: 'failed', reason: 'analysis_invalid', caseId: planCase.caseId };
    }

    const nextResults = [...results, { caseId: planCase.caseId, text: planCase.text, analysis }];
    const nextCheckpoint: AnalysisRunnerCheckpoint = {
      contractVersion: ANALYSIS_RUNNER_CHECKPOINT_CONTRACT_VERSION,
      planFingerprint,
      environment,
      results: nextResults,
    };

    try {
      await saveCheckpoint(nextCheckpoint);
    } catch {
      // 저장 실패 — 다음 analyze를 부르지 않는다. 저장됐다고 가정하지 않는다(results를 갱신하지 않는다).
      return { status: 'failed', reason: 'checkpoint_save_failed', caseId: planCase.caseId };
    }

    results = nextResults;
  }

  if (results.length < plan.length) {
    return { status: 'in_progress', completedCount: results.length, totalCount: plan.length };
  }

  const externalResults: ExternalAnalysisResult[] = results.map((item) => ({
    caseId: item.caseId,
    text: item.text,
    analysis: item.analysis,
  }));
  const finalBuild = await buildFrozenAnalysisSnapshot(baselineCatalogVersionHash, externalResults);
  if (!finalBuild.ok) return { status: 'failed', reason: 'final_snapshot_invalid' };

  return { status: 'completed', snapshot: finalBuild.snapshot };
}
