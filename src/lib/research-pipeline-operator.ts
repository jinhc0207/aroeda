/**
 * Research Pipeline Local Operator (엔진)
 *
 * aroeda production research pipeline(
 *   refresh → prioritize → harvest → research → candidate
 * )을 한 단계씩만, 사용자의 명시적 승인(--execute) 아래 실행하기 위한 순수 로직이다.
 *
 * 이 파일은 network를 직접 만들지 않는다. HTTP 전송과 Keychain 조회는
 * 호출하는 쪽(scripts/research-pipeline-operator.ts)이 인자로 넘겨준다.
 * 그래서 실제 서버 없이도 테스트할 수 있다.
 *
 * 원칙:
 *   - 한 번의 실행은 정확히 한 stage만 수행한다. 다음 stage를 자동으로 부르지 않는다.
 *   - --execute가 없으면 network·secret 조회 모두 0이다.
 *   - 실패해도 자동 재시도하지 않는다.
 *   - stdout에는 안전한 상태값과 식별자만 낸다. 토큰, 원본 응답, 연구 결과 본문은 내지 않는다.
 */

import { isDecisionId } from '../../supabase/functions/_shared/prioritizer-decision.ts';
import { isHandoffId } from '../../supabase/functions/_shared/biblical-research-handoff-store.ts';
import { getActiveCoveredDomains } from '../../supabase/functions/_shared/research-prioritizer-edge.ts';
import { computeResearchResultHash } from '../../supabase/functions/_shared/research-result-store-contract.ts';
import { validateResearchResultReadRequest } from '../../supabase/functions/_shared/candidate-research-result-read-boundary-contract.ts';

/** production project ref. 값을 바꾸는 CLI 옵션을 만들지 않는다. */
export const PRODUCTION_PROJECT_REF = 'vcxgzdlllselhhdwuisq';
export const FUNCTIONS_BASE_URL = `https://${PRODUCTION_PROJECT_REF}.supabase.co/functions/v1`;

export const STAGE_NAMES = ['refresh', 'prioritize', 'harvest', 'research', 'candidate'] as const;
export type Stage = (typeof STAGE_NAMES)[number];

/** source-harvester/handler.ts의 SNAPSHOT_ID 모양과 같다. 그 파일에서 export하지 않으므로 형식만 그대로 옮긴다. */
const SNAPSHOT_ID_FORMAT = /^snap_[0-9a-f]{64}$/;

export type CredentialSpec = { service: string; account: string };

/** refresh는 안전한 로컬 credential 경로가 없다(§7). service_role 재사용 등 금지된 우회를 쓰지 않는다. */
export const STAGE_CREDENTIALS: Record<Stage, CredentialSpec | null> = {
  refresh: null,
  prioritize: { service: 'aroeda.production.edge.internal-token', account: 'RESEARCH_PRIORITIZER_TOKEN' },
  harvest: { service: 'aroeda.production.edge.internal-token', account: 'SOURCE_HARVESTER_TOKEN' },
  research: { service: 'aroeda.production.edge.internal-token', account: 'BIBLICAL_RESEARCHER_TOKEN' },
  candidate: { service: 'com.aroeda.app.candidate-generator', account: 'CANDIDATE_GENERATOR_TOKEN' },
};

/** operator 자신의 HTTP client timeout. 서버 내부 timeout과는 별개다. retry는 하지 않는다. */
export const STAGE_TIMEOUT_MS: Record<Exclude<Stage, 'refresh'>, number> = {
  prioritize: 90_000,
  harvest: 120_000,
  research: 110_000,
  candidate: 90_000,
};

/* ------------------------------------------------------------------ */
/* 인자 파싱                                                            */
/* ------------------------------------------------------------------ */

export type ParseError =
  | 'MISSING_STAGE'
  | 'UNKNOWN_STAGE'
  | 'MULTIPLE_STAGES'
  | 'MISSING_ARGUMENT'
  | 'INVALID_ARGUMENT_FORMAT'
  | 'UNKNOWN_FLAG';

export type ParsedCommand =
  | { ok: false; error: ParseError }
  | { ok: true; stage: 'refresh'; execute: boolean }
  | { ok: true; stage: 'prioritize'; execute: boolean }
  | {
      ok: true;
      stage: 'harvest';
      execute: boolean;
      decisionId: string;
      targetDomain: string;
      evidenceVersion: number;
      prioritizerSnapshotId: string;
    }
  | { ok: true; stage: 'research'; execute: boolean; handoffId: string }
  | { ok: true; stage: 'candidate'; execute: boolean; researchResultHash: string };

const isStage = (value: string): value is Stage => (STAGE_NAMES as readonly string[]).includes(value);

/**
 * CLI 인자를 정확히 한 stage 명령으로 해석한다.
 *
 * 여러 stage 이름이 섞여 있으면(체이닝 시도) MULTIPLE_STAGES로 거절한다.
 * `--all`, `run-pipeline` 같은 이름은 애초에 STAGE_NAMES에 없으므로 UNKNOWN_STAGE가 된다.
 */
export function parseArgs(argv: readonly string[]): ParsedCommand {
  if (argv.length === 0) return { ok: false, error: 'MISSING_STAGE' };

  const [stageToken, ...rest] = argv;
  if (!isStage(stageToken)) return { ok: false, error: 'UNKNOWN_STAGE' };

  for (const token of rest) {
    if (isStage(token)) return { ok: false, error: 'MULTIPLE_STAGES' };
  }

  let execute = false;
  const positionals: string[] = [];
  const flags = new Map<string, string>();

  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (token === '--execute') {
      execute = true;
      continue;
    }
    if (token.startsWith('--')) {
      const name = token.slice(2);
      const value = rest[i + 1];
      if (value === undefined || value.startsWith('--')) {
        return { ok: false, error: 'MISSING_ARGUMENT' };
      }
      flags.set(name, value);
      i += 1;
      continue;
    }
    positionals.push(token);
  }

  if (stageToken === 'refresh') {
    if (flags.size > 0 || positionals.length > 0) return { ok: false, error: 'UNKNOWN_FLAG' };
    return { ok: true, stage: 'refresh', execute };
  }

  if (stageToken === 'prioritize') {
    if (flags.size > 0 || positionals.length > 0) return { ok: false, error: 'UNKNOWN_FLAG' };
    return { ok: true, stage: 'prioritize', execute };
  }

  if (stageToken === 'harvest') {
    if (positionals.length > 0) return { ok: false, error: 'UNKNOWN_FLAG' };
    const required = ['decision-id', 'target-domain', 'evidence-version', 'snapshot-id'];
    for (const name of required) {
      if (!flags.has(name)) return { ok: false, error: 'MISSING_ARGUMENT' };
    }
    for (const name of flags.keys()) {
      if (!required.includes(name)) return { ok: false, error: 'UNKNOWN_FLAG' };
    }

    const decisionId = flags.get('decision-id')!;
    const targetDomain = flags.get('target-domain')!;
    const evidenceVersionRaw = flags.get('evidence-version')!;
    const prioritizerSnapshotId = flags.get('snapshot-id')!;

    if (!isDecisionId(decisionId)) return { ok: false, error: 'INVALID_ARGUMENT_FORMAT' };
    if (targetDomain.trim().length === 0) return { ok: false, error: 'INVALID_ARGUMENT_FORMAT' };
    if (!SNAPSHOT_ID_FORMAT.test(prioritizerSnapshotId)) {
      return { ok: false, error: 'INVALID_ARGUMENT_FORMAT' };
    }
    if (!/^[0-9]+$/.test(evidenceVersionRaw)) return { ok: false, error: 'INVALID_ARGUMENT_FORMAT' };
    const evidenceVersion = Number(evidenceVersionRaw);
    if (!Number.isSafeInteger(evidenceVersion) || evidenceVersion < 1) {
      return { ok: false, error: 'INVALID_ARGUMENT_FORMAT' };
    }

    return {
      ok: true,
      stage: 'harvest',
      execute,
      decisionId,
      targetDomain,
      evidenceVersion,
      prioritizerSnapshotId,
    };
  }

  if (stageToken === 'research') {
    if (flags.size > 0) return { ok: false, error: 'UNKNOWN_FLAG' };
    if (positionals.length === 0) return { ok: false, error: 'MISSING_ARGUMENT' };
    if (positionals.length > 1) return { ok: false, error: 'UNKNOWN_FLAG' };
    const [handoffId] = positionals;
    if (!isHandoffId(handoffId)) return { ok: false, error: 'INVALID_ARGUMENT_FORMAT' };
    return { ok: true, stage: 'research', execute, handoffId };
  }

  // candidate
  if (flags.size > 0) return { ok: false, error: 'UNKNOWN_FLAG' };
  if (positionals.length === 0) return { ok: false, error: 'MISSING_ARGUMENT' };
  if (positionals.length > 1) return { ok: false, error: 'UNKNOWN_FLAG' };
  const [researchResultHash] = positionals;
  if (!validateResearchResultReadRequest({ researchResultHash }).ok) {
    return { ok: false, error: 'INVALID_ARGUMENT_FORMAT' };
  }
  return { ok: true, stage: 'candidate', execute, researchResultHash };
}

/* ------------------------------------------------------------------ */
/* 실행 (DI: transport, secretReader)                                  */
/* ------------------------------------------------------------------ */

export type HttpResponse = { status: number; json: unknown };

export type TransportRequest = {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
};

/** 실제 fetch 구현은 CLI 쪽(scripts/)에서 넘긴다. 이 함수는 정확히 한 번만 불려야 한다(retry 0). */
export type Transport = (request: TransportRequest) => Promise<HttpResponse>;

/** 실제 Keychain 조회는 CLI 쪽에서 넘긴다. 값이 없거나 조회 실패면 null. */
export type SecretReader = (spec: CredentialSpec) => Promise<string | null>;

export type OperatorDeps = {
  transport: Transport;
  secretReader: SecretReader;
};

export type StageOutcome =
  | { ok: true; stage: Stage; status: string; identifiers?: Record<string, string | number> }
  | { ok: false; stage: Stage; code: string; httpStatus?: number };

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** 서버가 이미 sanitize한 ErrorCode 값만 그대로 통과시킨다. 모르는 값은 UNKNOWN_ERROR로 뭉갠다. */
function passthroughErrorCode(json: unknown, allowed: readonly string[]): string {
  if (isPlainObject(json) && typeof json.error === 'string' && allowed.includes(json.error)) {
    return json.error;
  }
  return 'UNKNOWN_ERROR';
}

const PRIORITIZE_ERROR_CODES = [
  'METHOD_NOT_ALLOWED',
  'UNAUTHORIZED',
  'QUEUE_UNAVAILABLE',
  'INVALID_QUEUE_RESPONSE',
  'OPENAI_API_KEY_MISSING',
  'EVALUATOR_REQUEST_FAILED',
  'DECISION_STORE_UNAVAILABLE',
  'INTERNAL_ERROR',
] as const;

const HARVEST_ERROR_CODES = [
  'METHOD_NOT_ALLOWED',
  'UNAUTHORIZED',
  'INVALID_JSON',
  'INVALID_REQUEST',
  'OPENAI_API_KEY_MISSING',
  'PRIORITIZER_DECISION_UNAVAILABLE',
  'PRIORITIZER_DECISION_STORE_UNAVAILABLE',
  'RESEARCH_HANDOFF_STORE_UNAVAILABLE',
  'INTERNAL_ERROR',
] as const;

const RESEARCH_ERROR_CODES = [
  'METHOD_NOT_ALLOWED',
  'UNAUTHORIZED',
  'INVALID_JSON',
  'INVALID_REQUEST',
  'OPENAI_API_KEY_MISSING',
  'RESEARCH_HANDOFF_UNAVAILABLE',
  'RESEARCH_HANDOFF_STORE_UNAVAILABLE',
  'BIBLICAL_RESEARCH_FAILED',
  'INTERNAL_ERROR',
] as const;

const CANDIDATE_ERROR_CODES = [
  'METHOD_NOT_ALLOWED',
  'UNAUTHORIZED',
  'INVALID_JSON',
  'INVALID_REQUEST',
  'RESEARCH_RESULT_NOT_FOUND',
  'RESEARCH_RESULT_UNAVAILABLE',
  'CANDIDATE_PROCESSING_FAILED',
  'CANDIDATE_GENERATION_UNAVAILABLE',
  'INTERNAL_ERROR',
] as const;

async function runPrioritize(
  command: Extract<ParsedCommand, { stage: 'prioritize'; ok: true }>,
  deps: OperatorDeps,
): Promise<StageOutcome> {
  const spec = STAGE_CREDENTIALS.prioritize!;
  const token = await deps.secretReader(spec);
  if (!token) return { ok: false, stage: 'prioritize', code: 'OPERATOR_CREDENTIAL_MISSING' };

  let response: HttpResponse;
  try {
    response = await deps.transport({
      url: `${FUNCTIONS_BASE_URL}/research-prioritizer`,
      method: 'POST',
      headers: { 'x-internal-token': token },
      timeoutMs: STAGE_TIMEOUT_MS.prioritize,
    });
  } catch {
    return { ok: false, stage: 'prioritize', code: 'TRANSPORT_FAILED' };
  }

  if (response.status !== 200) {
    return {
      ok: false,
      stage: 'prioritize',
      code: passthroughErrorCode(response.json, PRIORITIZE_ERROR_CODES),
      httpStatus: response.status,
    };
  }

  const body = response.json;
  if (!isPlainObject(body) || body.ok !== true || !isPlainObject(body.result)) {
    return { ok: false, stage: 'prioritize', code: 'UNEXPECTED_RESPONSE_SHAPE' };
  }
  const result = body.result;
  const status = result.status;

  if (status === 'consensus') {
    const { recommendedDomain, evidenceVersion, snapshotId, decisionId } = result as Record<string, unknown>;
    if (
      typeof recommendedDomain !== 'string' ||
      typeof evidenceVersion !== 'number' ||
      typeof snapshotId !== 'string' ||
      typeof decisionId !== 'string'
    ) {
      return { ok: false, stage: 'prioritize', code: 'UNEXPECTED_RESPONSE_SHAPE' };
    }
    return {
      ok: true,
      stage: 'prioritize',
      status: 'consensus',
      identifiers: {
        decisionId,
        targetDomain: recommendedDomain,
        evidenceVersion,
        prioritizerSnapshotId: snapshotId,
      },
    };
  }

  if (status === 'recheck' || status === 'no_eligible_research' || status === 'stale_evidence') {
    return { ok: true, stage: 'prioritize', status };
  }

  return { ok: false, stage: 'prioritize', code: 'UNEXPECTED_RESPONSE_SHAPE' };
}

async function runHarvest(
  command: Extract<ParsedCommand, { stage: 'harvest'; ok: true }>,
  deps: OperatorDeps,
): Promise<StageOutcome> {
  const spec = STAGE_CREDENTIALS.harvest!;
  const token = await deps.secretReader(spec);
  if (!token) return { ok: false, stage: 'harvest', code: 'OPERATOR_CREDENTIAL_MISSING' };

  // activeCoveredDomains는 operator가 로컬 Scripture Card 목록에서 직접 만든다.
  // 사용자가 값을 복사해서 넘기지 않는다.
  const activeCoveredDomains = getActiveCoveredDomains();

  let response: HttpResponse;
  try {
    response = await deps.transport({
      url: `${FUNCTIONS_BASE_URL}/source-harvester`,
      method: 'POST',
      headers: { 'x-internal-token': token, 'content-type': 'application/json' },
      body: JSON.stringify({
        decisionId: command.decisionId,
        targetDomain: command.targetDomain,
        evidenceVersion: command.evidenceVersion,
        prioritizerSnapshotId: command.prioritizerSnapshotId,
        activeCoveredDomains,
      }),
      timeoutMs: STAGE_TIMEOUT_MS.harvest,
    });
  } catch {
    return { ok: false, stage: 'harvest', code: 'TRANSPORT_FAILED' };
  }

  if (response.status !== 200) {
    return {
      ok: false,
      stage: 'harvest',
      code: passthroughErrorCode(response.json, HARVEST_ERROR_CODES),
      httpStatus: response.status,
    };
  }

  const body = response.json;
  if (!isPlainObject(body) || body.ok !== true || !isPlainObject(body.result)) {
    return { ok: false, stage: 'harvest', code: 'UNEXPECTED_RESPONSE_SHAPE' };
  }
  const result = body.result as Record<string, unknown>;

  if (result.status === 'ready' && typeof result.handoffId === 'string') {
    return { ok: true, stage: 'harvest', status: 'ready', identifiers: { handoffId: result.handoffId } };
  }
  if (result.status === 'recovery_required' && typeof result.recoveryId === 'string') {
    // 이 operator는 recovery 이어하기(§9 범위 밖)를 구현하지 않는다. 식별자만 낸다.
    return {
      ok: true,
      stage: 'harvest',
      status: 'recovery_required',
      identifiers: { recoveryId: result.recoveryId },
    };
  }
  if (result.status === 'recheck' && typeof result.reason === 'string') {
    return { ok: true, stage: 'harvest', status: 'recheck', identifiers: { reason: result.reason } };
  }

  return { ok: false, stage: 'harvest', code: 'UNEXPECTED_RESPONSE_SHAPE' };
}

async function runResearch(
  command: Extract<ParsedCommand, { stage: 'research'; ok: true }>,
  deps: OperatorDeps,
): Promise<StageOutcome> {
  const spec = STAGE_CREDENTIALS.research!;
  const token = await deps.secretReader(spec);
  if (!token) return { ok: false, stage: 'research', code: 'OPERATOR_CREDENTIAL_MISSING' };

  let response: HttpResponse;
  try {
    response = await deps.transport({
      url: `${FUNCTIONS_BASE_URL}/biblical-researcher`,
      method: 'POST',
      headers: { 'x-internal-token': token, 'content-type': 'application/json' },
      body: JSON.stringify({ handoffId: command.handoffId }),
      timeoutMs: STAGE_TIMEOUT_MS.research,
    });
  } catch {
    return { ok: false, stage: 'research', code: 'TRANSPORT_FAILED' };
  }

  if (response.status !== 200) {
    return {
      ok: false,
      stage: 'research',
      code: passthroughErrorCode(response.json, RESEARCH_ERROR_CODES),
      httpStatus: response.status,
    };
  }

  const body = response.json;
  if (!isPlainObject(body) || body.ok !== true || !isPlainObject(body.result)) {
    return { ok: false, stage: 'research', code: 'UNEXPECTED_RESPONSE_SHAPE' };
  }

  // 연구 결과 본문은 hash 계산에만 쓰고 그 밖에는 절대 옮기지 않는다.
  let researchResultHash: string;
  try {
    researchResultHash = await computeResearchResultHash(body.result as never);
  } catch {
    return { ok: false, stage: 'research', code: 'HASH_COMPUTATION_FAILED' };
  }

  return { ok: true, stage: 'research', status: 'stored', identifiers: { researchResultHash } };
}

async function runCandidate(
  command: Extract<ParsedCommand, { stage: 'candidate'; ok: true }>,
  deps: OperatorDeps,
): Promise<StageOutcome> {
  const spec = STAGE_CREDENTIALS.candidate!;
  const token = await deps.secretReader(spec);
  if (!token) return { ok: false, stage: 'candidate', code: 'OPERATOR_CREDENTIAL_MISSING' };

  let response: HttpResponse;
  try {
    response = await deps.transport({
      url: `${FUNCTIONS_BASE_URL}/candidate-generator`,
      method: 'POST',
      headers: { 'x-internal-token': token, 'content-type': 'application/json' },
      body: JSON.stringify({ researchResultHash: command.researchResultHash }),
      timeoutMs: STAGE_TIMEOUT_MS.candidate,
    });
  } catch {
    return { ok: false, stage: 'candidate', code: 'TRANSPORT_FAILED' };
  }

  if (response.status !== 200) {
    return {
      ok: false,
      stage: 'candidate',
      code: passthroughErrorCode(response.json, CANDIDATE_ERROR_CODES),
      httpStatus: response.status,
    };
  }

  const body = response.json;
  if (!isPlainObject(body) || body.ok !== true) {
    return { ok: false, stage: 'candidate', code: 'UNEXPECTED_RESPONSE_SHAPE' };
  }
  if (typeof body.candidateHash === 'string') {
    return { ok: true, stage: 'candidate', status: 'generated', identifiers: { candidateHash: body.candidateHash } };
  }
  if (body.category === 'deferred') {
    return { ok: true, stage: 'candidate', status: 'deferred' };
  }
  return { ok: false, stage: 'candidate', code: 'UNEXPECTED_RESPONSE_SHAPE' };
}

/**
 * 파싱된 명령 하나를 실행한다. 정확히 한 stage, 정확히 한 번의 transport 호출(성공 시).
 *
 * `--execute`가 없으면 credential 조회도 network도 하지 않고 `execution_required`만 낸다.
 * refresh는 execute 여부와 무관하게 항상 OPERATOR_CREDENTIAL_MISSING이다(§7 — 안전한 로컬 경로 없음).
 */
export async function runStage(
  command: Extract<ParsedCommand, { ok: true }>,
  deps: OperatorDeps,
): Promise<StageOutcome> {
  if (command.stage === 'refresh') {
    return { ok: false, stage: 'refresh', code: 'OPERATOR_CREDENTIAL_MISSING' };
  }

  if (!command.execute) {
    return { ok: true, stage: command.stage, status: 'execution_required' };
  }

  switch (command.stage) {
    case 'prioritize':
      return runPrioritize(command, deps);
    case 'harvest':
      return runHarvest(command, deps);
    case 'research':
      return runResearch(command, deps);
    case 'candidate':
      return runCandidate(command, deps);
  }
}
