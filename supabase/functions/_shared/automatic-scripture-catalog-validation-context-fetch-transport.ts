/**
 * Automatic Scripture Catalog validator용 Supabase validation-context fetch transport.
 *
 * 활성 카탈로그와 한 수요 대상의 과거 집계를 service_role 전용 RPC에서 읽는 일만 맡는다.
 * 환경변수·DB 저장·로그·재시도·검증 실행은 이 파일의 책임이 아니다.
 */

import type { DemandBinding } from './automatic-scripture-catalog-contract.ts';
import {
  type ScriptureCatalogValidationContext,
  type ValidationContextWindow,
  buildValidationContextRpcSpec,
  parseValidationContextRpcResponse,
} from './automatic-scripture-catalog-validation-context.ts';

export const VALIDATION_CONTEXT_FETCH_TIMEOUT_MS = 10_000;

export const VALIDATION_CONTEXT_FETCH_FAILURE_KINDS = [
  'configuration_error',
  'request_invalid',
  'provider_timeout',
  'provider_unavailable',
  'provider_error',
  'response_contract_invalid',
] as const;

export type ValidationContextFetchFailureKind =
  (typeof VALIDATION_CONTEXT_FETCH_FAILURE_KINDS)[number];

/** 원본 URL·열쇠·HTTP 상태·응답·오류 문구를 담지 않는 정제된 오류. */
export class ValidationContextFetchError extends Error {
  readonly kind: ValidationContextFetchFailureKind;

  constructor(kind: ValidationContextFetchFailureKind) {
    super(kind);
    this.name = 'ValidationContextFetchError';
    this.kind = kind;
  }
}

export type ValidationContextFetchTransportConfig = {
  /** 서버 환경에서 읽어 주입한다. 이 파일은 환경변수를 직접 읽지 않는다. */
  supabaseUrl: unknown;
  serviceRoleKey: unknown;
  /** 테스트에서만 바꾼다. 실제 실행은 전역 fetch를 쓴다. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

const usableSecret = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

function rpcUrl(value: unknown, functionName: string): string | null {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0) return null;
  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
      parsed.username !== '' ||
      parsed.password !== '' ||
      parsed.search !== '' ||
      parsed.hash !== ''
    ) return null;
    parsed.pathname = `${parsed.pathname.replace(/\/$/, '')}/rest/v1/rpc/${functionName}`;
    return parsed.toString();
  } catch {
    return null;
  }
}

function timeoutMs(value: number | undefined): number | null {
  const actual = value ?? VALIDATION_CONTEXT_FETCH_TIMEOUT_MS;
  return Number.isSafeInteger(actual) && actual > 0 && actual <= 60_000 ? actual : null;
}

function mapHttpFailure(status: number): ValidationContextFetchFailureKind {
  if (status === 408) return 'provider_timeout';
  if (status === 429 || status >= 500) return 'provider_unavailable';
  return 'provider_error';
}

export async function fetchScriptureCatalogValidationContext(
  binding: DemandBinding,
  window: ValidationContextWindow,
  config: ValidationContextFetchTransportConfig,
): Promise<ScriptureCatalogValidationContext> {
  const spec = buildValidationContextRpcSpec(binding, window);
  if (!spec) throw new ValidationContextFetchError('request_invalid');
  const url = rpcUrl(config.supabaseUrl, spec.functionName);
  const limit = timeoutMs(config.timeoutMs);
  if (!url || !usableSecret(config.serviceRoleKey) || !limit) {
    throw new ValidationContextFetchError('configuration_error');
  }

  const doFetch = config.fetchImpl ?? fetch;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, limit);

  try {
    let response: Response;
    try {
      response = await doFetch(url, {
        method: 'POST',
        headers: {
          apikey: config.serviceRoleKey,
          authorization: `Bearer ${config.serviceRoleKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(spec.params),
        signal: controller.signal,
      });
    } catch {
      throw new ValidationContextFetchError(timedOut ? 'provider_timeout' : 'provider_error');
    }

    if (!response.ok) throw new ValidationContextFetchError(mapHttpFailure(response.status));

    let raw: unknown;
    try {
      raw = await response.json();
    } catch {
      throw new ValidationContextFetchError(timedOut ? 'provider_timeout' : 'provider_error');
    }
    const parsed = await parseValidationContextRpcResponse(raw, binding, window);
    if (!parsed.ok) throw new ValidationContextFetchError('response_contract_invalid');
    return parsed.context;
  } finally {
    clearTimeout(timer);
  }
}

export const VALIDATION_CONTEXT_FETCH_TRANSPORT_POLICY = {
  attempts: 1,
  automaticRetries: 0,
  nonOkBodyRead: false,
  rawResponsePersisted: false,
  providerErrorMessagePersisted: false,
  environmentReadHere: false,
  databaseWriteHere: false,
  logsHere: false,
} as const;
