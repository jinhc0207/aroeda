/**
 * Automatic Scripture Catalog · Sol/Astra 신학 평가 OpenAI fetch transport.
 *
 * Adapter가 만든 요청을 정확히 한 번 보내고, 받은 raw Responses API 응답을
 * Adapter에게 돌려주는 일만 맡는다. 모델 선택·criterion 판정·카드 최종 판정·
 * DB 저장·환경변수 읽기는 이 파일의 일이 아니다.
 */

import { classifyOpenAIHttpStatus } from './openai-transport.ts';
import {
  buildTheologyEvaluationOpenAIRequestSpec,
  interpretTheologyEvaluationOpenAIResponse,
  type CardCriterionEvaluationResult,
  type TheologyEvaluationOpenAIRequestSpec,
  type TheologyEvaluationResponseOutcomeKind,
} from './automatic-scripture-catalog-theology-openai-adapter.ts';
import type {
  TheologyEvaluationRequest,
  TheologyEvaluator,
} from './automatic-scripture-catalog-validator-executor.ts';

export const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';
export const THEOLOGY_EVALUATION_OPENAI_CREDENTIAL_ENV_NAME = 'OPENAI_API_KEY';

export const THEOLOGY_EVALUATION_TRANSPORT_FAILURE_KINDS = [
  'configuration_error',
  'provider_timeout',
  'provider_unavailable',
  'provider_error',
  'response_incomplete',
  'model_refusal',
  'empty_response',
  'json_parse_failed',
  'response_contract_invalid',
] as const;

export type TheologyEvaluationTransportFailureKind =
  (typeof THEOLOGY_EVALUATION_TRANSPORT_FAILURE_KINDS)[number];

/** 원본 오류·상태·응답·열쇠를 담지 않는 정제된 오류. */
export class TheologyEvaluationTransportError extends Error {
  readonly kind: TheologyEvaluationTransportFailureKind;

  constructor(kind: TheologyEvaluationTransportFailureKind) {
    super(kind);
    this.name = 'TheologyEvaluationTransportError';
    this.kind = kind;
  }
}

export type TheologyEvaluationFetchTransportConfig = {
  /** 서버 환경에서 읽어 주입한다. 이 파일은 환경변수를 직접 읽지 않는다. */
  apiKey: unknown;
  /** 테스트에서만 바꾼다. 실제 실행은 전역 fetch를 쓴다. */
  fetchImpl?: typeof fetch;
};

const isUsableCredential = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

function mapHttpFailure(status: number): TheologyEvaluationTransportFailureKind {
  if (status === 408) return 'provider_timeout';
  const category = classifyOpenAIHttpStatus(status);
  if (category === 'rate_or_quota' || category === 'server_error') return 'provider_unavailable';
  return 'provider_error';
}

function mapAdapterFailure(
  outcome: Exclude<TheologyEvaluationResponseOutcomeKind, 'success'>,
): TheologyEvaluationTransportFailureKind {
  const mapping: Record<
    Exclude<TheologyEvaluationResponseOutcomeKind, 'success'>,
    TheologyEvaluationTransportFailureKind
  > = {
    provider_error: 'provider_error',
    incomplete: 'response_incomplete',
    model_refusal: 'model_refusal',
    empty_response: 'empty_response',
    json_parse_failed: 'json_parse_failed',
    response_contract_invalid: 'response_contract_invalid',
  };
  return mapping[outcome];
}

/**
 * 이미 만들어진 spec을 한 번 보내는 하위 경계.
 * request는 응답의 카드·criterion 순서를 Adapter가 대조하는 데만 쓴다.
 */
export async function callTheologyEvaluationOpenAIFetchTransport(
  requestSpec: TheologyEvaluationOpenAIRequestSpec,
  request: TheologyEvaluationRequest,
  config: TheologyEvaluationFetchTransportConfig,
): Promise<CardCriterionEvaluationResult[]> {
  if (!isUsableCredential(config.apiKey)) {
    throw new TheologyEvaluationTransportError('configuration_error');
  }

  const doFetch = config.fetchImpl ?? fetch;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, requestSpec.timeoutMs);

  try {
    let response: Response;
    try {
      response = await doFetch(OPENAI_RESPONSES_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(requestSpec.body),
        signal: controller.signal,
      });
    } catch {
      throw new TheologyEvaluationTransportError(timedOut ? 'provider_timeout' : 'provider_error');
    }

    if (!response.ok) {
      throw new TheologyEvaluationTransportError(mapHttpFailure(response.status));
    }

    let raw: unknown;
    try {
      raw = await response.json();
    } catch {
      throw new TheologyEvaluationTransportError(timedOut ? 'provider_timeout' : 'provider_error');
    }

    const interpreted = interpretTheologyEvaluationOpenAIResponse(
      raw,
      request.candidate.cards.map((card) => card.id),
      request.rubric.criteria.map((criterion) => criterion.criterionId),
    );
    if (interpreted.outcome === 'success') return interpreted.cardEvaluations;
    throw new TheologyEvaluationTransportError(mapAdapterFailure(interpreted.outcome));
  } finally {
    clearTimeout(timer);
  }
}

/** Executor의 evaluateSol/evaluateAstra 자리에 그대로 넣는 실제 구현. */
export function createTheologyEvaluationOpenAIFetchTransport(
  config: TheologyEvaluationFetchTransportConfig,
): TheologyEvaluator {
  return async (request) =>
    callTheologyEvaluationOpenAIFetchTransport(
      buildTheologyEvaluationOpenAIRequestSpec(request),
      request,
      config,
    );
}

export const THEOLOGY_EVALUATION_FETCH_TRANSPORT_POLICY = {
  attempts: 1,
  automaticRetries: 0,
  fallbackModelAllowed: false,
  fallbackCredentialAllowed: false,
  nonOkBodyRead: false,
  rawResponsePersisted: false,
  providerErrorMessagePersisted: false,
  environmentReadHere: false,
  databaseAccessHere: false,
} as const;
