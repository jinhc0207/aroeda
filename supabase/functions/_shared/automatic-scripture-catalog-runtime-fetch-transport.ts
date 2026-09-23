/** service_role 전용 RPC에서 활성 카탈로그 런타임을 한 번 읽는다. */

import {
  GET_ACTIVE_SCRIPTURE_CATALOG_RUNTIME_RPC,
  type ScriptureCatalogRuntime,
  parseScriptureCatalogRuntimeResponse,
} from './automatic-scripture-catalog-runtime.ts';

export const SCRIPTURE_CATALOG_RUNTIME_FETCH_TIMEOUT_MS = 1500;

export class ScriptureCatalogRuntimeFetchError extends Error {
  readonly kind: 'configuration_error' | 'timeout' | 'cancelled' | 'unavailable' | 'response_invalid';
  constructor(kind: ScriptureCatalogRuntimeFetchError['kind']) {
    super(kind);
    this.name = 'ScriptureCatalogRuntimeFetchError';
    this.kind = kind;
  }
}

export type ScriptureCatalogRuntimeFetchConfig = {
  supabaseUrl: unknown;
  serviceRoleKey: unknown;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

const usableSecret = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

function rpcUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0) return null;
  try {
    const parsed = new URL(value);
    if (
      !['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password ||
      parsed.search || parsed.hash
    ) return null;
    parsed.pathname = `${parsed.pathname.replace(/\/$/, '')}/rest/v1/rpc/${GET_ACTIVE_SCRIPTURE_CATALOG_RUNTIME_RPC}`;
    return parsed.toString();
  } catch {
    return null;
  }
}

export function createScriptureCatalogRuntimeLoader(
  config: ScriptureCatalogRuntimeFetchConfig,
): (options?: { signal?: AbortSignal }) => Promise<ScriptureCatalogRuntime> {
  return async (options = {}) => {
    const url = rpcUrl(config.supabaseUrl);
    const serviceRoleKey = config.serviceRoleKey;
    const timeout = config.timeoutMs ?? SCRIPTURE_CATALOG_RUNTIME_FETCH_TIMEOUT_MS;
    if (
      !url || !usableSecret(serviceRoleKey) ||
      !Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 10_000
    ) throw new ScriptureCatalogRuntimeFetchError('configuration_error');

    const controller = new AbortController();
    const externalSignal = options.signal;
    if (externalSignal?.aborted) throw new ScriptureCatalogRuntimeFetchError('cancelled');
    let timedOut = false;
    const TIMED_OUT = Symbol('scripture_catalog_runtime_timeout');
    const CANCELLED = Symbol('scripture_catalog_runtime_cancelled');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutResult = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        resolve(TIMED_OUT);
      }, timeout);
    });
    let removeAbortListener = () => {};
    const cancelledResult = new Promise<typeof CANCELLED>((resolve) => {
      if (!externalSignal) return;
      const onAbort = () => {
        controller.abort();
        resolve(CANCELLED);
      };
      externalSignal.addEventListener('abort', onAbort, { once: true });
      removeAbortListener = () => externalSignal.removeEventListener('abort', onAbort);
    });
    try {
      const request = (config.fetchImpl ?? fetch)(url, {
          method: 'POST',
          headers: {
            apikey: serviceRoleKey,
            authorization: `Bearer ${serviceRoleKey}`,
            'content-type': 'application/json',
          },
          body: '{}',
          signal: controller.signal,
        }).then(
          (response) => ({ ok: true as const, response }),
          () => ({ ok: false as const }),
        );
      const fetched = await Promise.race([request, timeoutResult, cancelledResult]);
      if (fetched === TIMED_OUT) throw new ScriptureCatalogRuntimeFetchError('timeout');
      if (fetched === CANCELLED) throw new ScriptureCatalogRuntimeFetchError('cancelled');
      if (!fetched.ok) throw new ScriptureCatalogRuntimeFetchError(timedOut ? 'timeout' : 'unavailable');
      const response = fetched.response;
      if (!response.ok) throw new ScriptureCatalogRuntimeFetchError('unavailable');
      const body = Promise.resolve().then(() => response.json()).then(
        (raw) => ({ ok: true as const, raw }),
        () => ({ ok: false as const }),
      );
      const read = await Promise.race([body, timeoutResult, cancelledResult]);
      if (read === TIMED_OUT) throw new ScriptureCatalogRuntimeFetchError('timeout');
      if (read === CANCELLED) throw new ScriptureCatalogRuntimeFetchError('cancelled');
      if (!read.ok) throw new ScriptureCatalogRuntimeFetchError(timedOut ? 'timeout' : 'unavailable');
      const raw = read.raw;
      const parsed = await parseScriptureCatalogRuntimeResponse(raw);
      if (!parsed.ok) throw new ScriptureCatalogRuntimeFetchError('response_invalid');
      return parsed.runtime;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      removeAbortListener();
    }
  };
}

export const SCRIPTURE_CATALOG_RUNTIME_FETCH_POLICY = {
  attempts: 1,
  automaticRetries: 0,
  fallbackToStaticCatalog: false,
  nonOkBodyRead: false,
  logsHere: false,
  databaseWriteHere: false,
} as const;
