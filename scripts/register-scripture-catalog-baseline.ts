/**
 * 운영 Scripture Catalog 기준판 등록 도구.
 *
 * 기본 실행은 dry-run이다. `--execute`가 있을 때만 환경변수를 읽고 Supabase RPC를 부른다.
 * 활성판이 비어 있을 때만 정적 51장 기준판을 등록하며, 이미 다른 활성판이 있으면 덮어쓰지 않는다.
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import {
  buildCatalogSnapshotFromStaticCards,
  canonicalJson,
  computeCatalogVersionHash,
  sha256Hex,
  validateCatalogSnapshot,
  type ScriptureCatalogSnapshot,
} from '../supabase/functions/_shared/automatic-scripture-catalog-contract.ts';
import {
  GET_ACTIVE_SCRIPTURE_CATALOG_RUNTIME_RPC,
  parseScriptureCatalogRuntimeResponse,
} from '../supabase/functions/_shared/automatic-scripture-catalog-runtime.ts';
import { REGISTER_SCRIPTURE_CATALOG_BASELINE_RPC } from '../supabase/functions/_shared/automatic-scripture-catalog-activation-contract.ts';
import { SCRIPTURE_CARDS } from '../supabase/functions/_shared/scripture-cards.ts';
import { DOMAIN_DESCRIPTIONS } from '../supabase/functions/_shared/situation-domains.ts';

const DOMAIN_LABEL_COUNT = 17;
const URL_FORMAT = /^https:\/\/[a-z0-9-]+\.supabase\.co$/;
const REQUEST_TIMEOUT_MS = 10_000;

export type BaselineRegistrationPlan = {
  requestId: string;
  versionHash: string;
  catalog: ScriptureCatalogSnapshot;
};

export type BaselineRegistrationResult =
  | { status: 'dry_run'; requestId: string; versionHash: string; cardCount: number; domainCount: number }
  | { status: 'registered' | 'already_registered'; requestId: string; versionHash: string; pointerRevision: number }
  | { status: 'failed'; reason: 'invalid_arguments' | 'baseline_invalid' | 'configuration_error' | 'runtime_read_failed' | 'active_catalog_conflict' | 'registration_failed' | 'verification_failed' };

type BaselineSource = {
  cards?: typeof SCRIPTURE_CARDS;
  domainDescriptions?: Readonly<Record<string, string>>;
  domainDisplayNames?: Readonly<Record<string, string>>;
};

type Dependencies = {
  getEnv(name: string): string | undefined;
  fetchImpl: typeof fetch;
  write(value: string): void;
  buildPlan?: () => Promise<BaselineRegistrationPlan>;
};

const defaultDependencies: Dependencies = {
  getEnv: (name) => process.env[name],
  fetchImpl: fetch,
  write: (value) => console.log(value),
};

/** 앱 표시 이름 파일에서 선언된 17개 값만 읽는다. 실행 코드나 임의 표현식은 평가하지 않는다. */
export function readStaticDomainLabels(): Record<string, string> {
  const source = readFileSync(new URL('../src/data/domain-labels.ts', import.meta.url), 'utf8');
  const start = source.indexOf('export const DOMAIN_LABELS');
  const end = source.indexOf('};', start);
  if (start < 0 || end < 0) throw new Error('domain_labels_unavailable');
  const block = source.slice(start, end);
  const entries = [...block.matchAll(/^\s+([a-z_]+): '([^']+)',$/gm)].map((match) => [match[1], match[2]]);
  if (entries.length !== DOMAIN_LABEL_COUNT) throw new Error('domain_labels_invalid');
  return Object.fromEntries(entries);
}

export async function buildBaselineRegistrationPlan(source: BaselineSource = {}): Promise<BaselineRegistrationPlan> {
  const catalog = buildCatalogSnapshotFromStaticCards(
    source.cards ?? SCRIPTURE_CARDS,
    source.domainDescriptions ?? DOMAIN_DESCRIPTIONS,
    source.domainDisplayNames ?? readStaticDomainLabels(),
  );
  const checked = validateCatalogSnapshot(catalog);
  if (!checked.valid) throw new Error('baseline_catalog_invalid');
  const versionHash = await computeCatalogVersionHash(catalog);
  const runtimeCheck = await parseScriptureCatalogRuntimeResponse({ activeVersionHash: versionHash, pointerRevision: 1, catalog });
  if (!runtimeCheck.ok) throw new Error('baseline_catalog_invalid');
  const requestSeed = canonicalJson({ operation: 'register-scripture-catalog-baseline/v1', versionHash });
  const requestId = `screq_${(await sha256Hex(requestSeed)).slice(0, 32)}`;
  return { requestId, versionHash, catalog };
}

function parseMode(args: readonly string[]): 'dry_run' | 'execute' | null {
  if (args.length === 0 || (args.length === 1 && args[0] === '--dry-run')) return 'dry_run';
  if (args.length === 1 && args[0] === '--execute') return 'execute';
  return null;
}

function cleanConfig(value: string | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

async function withRequestTimeout<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const TIMEOUT = Symbol('timeout');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMEOUT>((resolve) => {
    timer = setTimeout(() => { controller.abort(); resolve(TIMEOUT); }, REQUEST_TIMEOUT_MS);
  });
  const request = Promise.resolve().then(() => operation(controller.signal))
    .then((value) => ({ ok: true as const, value }), () => ({ ok: false as const }));
  try {
    const result = await Promise.race([request, timeout]);
    if (result === TIMEOUT || !result.ok) throw new Error('request_failed');
    return result.value;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function postRpc(fetchImpl: typeof fetch, url: string, key: string, rpc: string, body: unknown): Promise<Response> {
  return withRequestTimeout((signal) => fetchImpl(`${url}/rest/v1/rpc/${rpc}`, {
    method: 'POST',
    headers: { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    redirect: 'manual',
    signal,
  }));
}

async function readRuntime(fetchImpl: typeof fetch, url: string, key: string): Promise<unknown> {
  return withRequestTimeout(async (signal) => {
    const response = await fetchImpl(`${url}/rest/v1/rpc/${GET_ACTIVE_SCRIPTURE_CATALOG_RUNTIME_RPC}`, {
      method: 'POST',
      headers: { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: '{}',
      redirect: 'manual',
      signal,
    });
    if (!response.ok) throw new Error('runtime_read_failed');
    return response.json();
  });
}

export async function runBaselineRegistration(
  args: readonly string[],
  dependencies: Dependencies = defaultDependencies,
): Promise<BaselineRegistrationResult> {
  const mode = parseMode(args);
  if (!mode) return { status: 'failed', reason: 'invalid_arguments' };

  let plan: BaselineRegistrationPlan;
  try {
    plan = await (dependencies.buildPlan ?? buildBaselineRegistrationPlan)();
  } catch {
    return { status: 'failed', reason: 'baseline_invalid' };
  }
  if (mode === 'dry_run') {
    const result: BaselineRegistrationResult = {
      status: 'dry_run', requestId: plan.requestId, versionHash: plan.versionHash,
      cardCount: plan.catalog.cards.length, domainCount: plan.catalog.domains.length,
    };
    dependencies.write(JSON.stringify(result));
    return result;
  }

  const url = cleanConfig(dependencies.getEnv('SUPABASE_URL'));
  const key = cleanConfig(dependencies.getEnv('SUPABASE_SERVICE_ROLE_KEY'));
  if (!url || !URL_FORMAT.test(url) || !key) return { status: 'failed', reason: 'configuration_error' };

  let current: unknown;
  try {
    current = await readRuntime(dependencies.fetchImpl, url, key);
  } catch {
    return { status: 'failed', reason: 'runtime_read_failed' };
  }

  if (current !== null) {
    const parsed = await parseScriptureCatalogRuntimeResponse(current);
    if (!parsed.ok) return { status: 'failed', reason: 'runtime_read_failed' };
    if (parsed.runtime.activeVersionHash !== plan.versionHash || canonicalJson(parsed.runtime.catalog) !== canonicalJson(plan.catalog)) {
      return { status: 'failed', reason: 'active_catalog_conflict' };
    }
    return { status: 'already_registered', requestId: plan.requestId, versionHash: plan.versionHash, pointerRevision: parsed.runtime.pointerRevision };
  }

  let registrationSucceeded = false;
  try {
    const response = await postRpc(dependencies.fetchImpl, url, key, REGISTER_SCRIPTURE_CATALOG_BASELINE_RPC, {
      p_request_id: plan.requestId,
      p_version_hash: plan.versionHash,
      p_catalog: plan.catalog,
    });
    registrationSucceeded = response.ok;
  } catch {
    registrationSucceeded = false;
  }

  if (!registrationSucceeded) {
    try {
      const recovered = await readRuntime(dependencies.fetchImpl, url, key);
      if (recovered !== null) {
        const parsed = await parseScriptureCatalogRuntimeResponse(recovered);
        if (parsed.ok) {
          if (parsed.runtime.activeVersionHash === plan.versionHash
            && canonicalJson(parsed.runtime.catalog) === canonicalJson(plan.catalog)) {
            return {
              status: 'already_registered', requestId: plan.requestId,
              versionHash: plan.versionHash, pointerRevision: parsed.runtime.pointerRevision,
            };
          }
          return { status: 'failed', reason: 'active_catalog_conflict' };
        }
      }
    } catch {
      // 등록 실패 뒤 상태 확인도 실패하면 원래의 정제된 실패로 닫는다.
    }
    return { status: 'failed', reason: 'registration_failed' };
  }

  try {
    const verified = await readRuntime(dependencies.fetchImpl, url, key);
    const parsed = await parseScriptureCatalogRuntimeResponse(verified);
    if (!parsed.ok || parsed.runtime.pointerRevision !== 1 || parsed.runtime.activeVersionHash !== plan.versionHash
      || canonicalJson(parsed.runtime.catalog) !== canonicalJson(plan.catalog)) {
      return { status: 'failed', reason: 'verification_failed' };
    }
    return { status: 'registered', requestId: plan.requestId, versionHash: plan.versionHash, pointerRevision: 1 };
  } catch {
    return { status: 'failed', reason: 'verification_failed' };
  }
}

async function main() {
  const result = await runBaselineRegistration(process.argv.slice(2));
  if (result.status !== 'dry_run') console.log(JSON.stringify(result));
  if (result.status === 'failed') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
