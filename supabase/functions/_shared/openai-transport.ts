/**
 * OpenAI 요청이 실패한 까닭 · 순수 로직
 *
 * 왜 필요한가:
 *   production에서 1단계 요청이 실패해 `discovery_request_failed`로 끝난 적이 두 번 있다.
 *   둘 다 61초 언저리라 시간 초과처럼 보였지만, 코드가 원인을 구분하지 않고 있었다.
 *   시간이 60초 근처였다는 것만으로 시간 초과라고 단정할 수는 없다.
 *
 *   밖으로 나가는 사유는 그대로 둔다.
 *   서버 기록에만 어느 까닭이었는지 남긴다.
 *
 * 이 파일이 하지 않는 일:
 *   네트워크, DB, 환경변수 읽기.
 *   원본 오류 문구·응답 본문·HTTP 상태·주소를 옮겨 담지 않는다.
 *
 * 표를 다루는 DB 함수의 실패(RecoveryTicketRpcError)와 뜻이 비슷하지만
 * 같은 타입으로 합치지 않는다. 역할이 다르면 경계도 따로 둔다.
 */

/** OpenAI 요청이 실패한 까닭의 종류 */
export const OPENAI_TRANSPORT_FAILURE_KINDS = [
  /** 우리가 건 시간 제한이 실제로 끊었다 */
  'timeout',
  /** 답은 왔지만 OpenAI가 받아들이지 않았다 */
  'http_error',
  /** 답을 읽을 수 없었다 */
  'response_invalid',
  /** 위 어디에도 확실히 들어가지 않는다 */
  'unknown',
] as const;
export type OpenAITransportFailureKind = (typeof OPENAI_TRANSPORT_FAILURE_KINDS)[number];

/**
 * 답은 왔지만 받아들여지지 않았을 때, 어느 큰 범주였는가.
 *
 * production에서 1단계 요청이 3.9초 만에 http_error로 끝난 적이 있다.
 * 시간 초과는 아니라는 것까지는 알았지만, 그 이상은 알 수 없었다.
 *
 * 상태 숫자 자체는 어디에도 남기지 않는다. 큰 범주 이름만 남긴다.
 */
export const OPENAI_HTTP_FAILURE_CATEGORIES = [
  /** 우리가 보낸 요청에 문제가 있다 (아래 세 가지에 해당하지 않는 4xx) */
  'client_error',
  /** 열쇠·권한 문제 */
  'auth',
  /** 부르는 주소가 없다 */
  'not_found',
  /** 너무 자주 불렀거나, 쓸 수 있는 양을 다 썼다 */
  'rate_or_quota',
  /** 저쪽 서버 문제 */
  'server_error',
  /** 위 어디에도 들어가지 않는다 */
  'other',
] as const;
export type OpenAIHttpFailureCategory = (typeof OPENAI_HTTP_FAILURE_CATEGORIES)[number];

/**
 * 상태 숫자를 큰 범주 하나로 바꾼다. 이 규칙이 있는 곳은 여기 한 곳뿐이다.
 *
 * 검사 순서가 중요하다.
 * 401·403·404·429는 모두 4xx이므로, 일반 4xx보다 **먼저** 걸러야 한다.
 *
 * 숫자는 여기서 들어와 범주 이름 하나로 나간다. 밖으로 다시 나가지 않는다.
 */
export function classifyOpenAIHttpStatus(status: number): OpenAIHttpFailureCategory {
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_or_quota';
  if (status >= 500 && status <= 599) return 'server_error';
  if (status >= 400 && status <= 499) return 'client_error';
  return 'other';
}

/**
 * OpenAI 요청이 실패했을 때 던지는 오류.
 * 메시지에는 종류 이름만 담는다. 그 밖의 것은 담지 않는다.
 *
 * httpCategory는 kind가 'http_error'일 때만 담긴다.
 * 상태 숫자 자체는 담지 않는다. 메시지도 예전 그대로 종류 이름 하나다.
 */
export class OpenAITransportError extends Error {
  readonly kind: OpenAITransportFailureKind;
  readonly httpCategory?: OpenAIHttpFailureCategory;

  constructor(kind: OpenAITransportFailureKind, httpCategory?: OpenAIHttpFailureCategory) {
    super(kind);
    this.name = 'OpenAITransportError';
    this.kind = kind;
    // 종류가 http_error가 아니면 범주를 갖지 않는다. 잘못 붙여도 조용히 버린다.
    if (kind === 'http_error' && httpCategory !== undefined) {
      this.httpCategory = httpCategory;
    }
  }
}

/**
 * 어디까지 갔다가 실패했는지로 까닭을 가린다.
 *
 * stage
 *   request — 요청을 보내다 실패했다 (답 자체를 못 받음)
 *   body    — 답은 받았지만 그 내용을 읽다 실패했다
 *
 * aborted는 **우리가 건 시간 제한**이 실제로 끊었는지다.
 * 그 경우에만 시간 초과로 본다. 걸린 시간이 얼마였는지로 짐작하지 않는다.
 */
export function classifyOpenAITransportFailure(
  stage: 'request' | 'body',
  aborted: boolean,
): OpenAITransportFailureKind {
  if (aborted) return 'timeout';
  return stage === 'body' ? 'response_invalid' : 'unknown';
}

/** 어느 단계에서 부른 요청인가. 기록에 남길 이름을 정하는 데만 쓴다. */
export type OpenAIStage = 'discovery' | 'verification';

/**
 * 서버 기록에만 남기는 이름. 밖으로 나가는 사유와 다르다.
 *
 * 예) discovery_request_timeout, verification_request_http_error
 */
export const OPENAI_STAGE_FAILURE_CODES: Readonly<
  Record<OpenAIStage, Readonly<Record<OpenAITransportFailureKind, string>>>
> = {
  discovery: {
    timeout: 'discovery_request_timeout',
    http_error: 'discovery_request_http_error',
    response_invalid: 'discovery_request_response_invalid',
    unknown: 'discovery_request_unknown_failure',
  },
  verification: {
    timeout: 'verification_request_timeout',
    http_error: 'verification_request_http_error',
    response_invalid: 'verification_request_response_invalid',
    unknown: 'verification_request_unknown_failure',
  },
};

/**
 * 실패한 오류에서 기록에 남길 이름을 고른다.
 *
 * 어떤 값이 오더라도 정해진 이름 중 하나만 돌려준다.
 * 오류 안에 들어 있던 문구를 그대로 내보내지 않는다.
 */
export function describeOpenAIStageFailure(stage: OpenAIStage, error: unknown): string {
  const kind: OpenAITransportFailureKind =
    error instanceof OpenAITransportError ? error.kind : 'unknown';

  return OPENAI_STAGE_FAILURE_CODES[stage][kind];
}

/**
 * 답이 받아들여지지 않았을 때만 쓰는, 한 단계 더 자세한 기록 이름.
 *
 * 예) discovery_http_rate_or_quota, verification_http_auth
 *
 * 상태 숫자는 이름에 넣지 않는다. discovery_http_429 같은 이름은 만들지 않는다.
 */
export const OPENAI_HTTP_FAILURE_CODES: Readonly<
  Record<OpenAIStage, Readonly<Record<OpenAIHttpFailureCategory, string>>>
> = {
  discovery: {
    client_error: 'discovery_http_client_error',
    auth: 'discovery_http_auth',
    not_found: 'discovery_http_not_found',
    rate_or_quota: 'discovery_http_rate_or_quota',
    server_error: 'discovery_http_server_error',
    other: 'discovery_http_other',
  },
  verification: {
    client_error: 'verification_http_client_error',
    auth: 'verification_http_auth',
    not_found: 'verification_http_not_found',
    rate_or_quota: 'verification_http_rate_or_quota',
    server_error: 'verification_http_server_error',
    other: 'verification_http_other',
  },
};

/**
 * 답이 받아들여지지 않은 경우에만 이름 하나를 돌려준다.
 *
 * 그 밖의 실패(시간 초과, 읽을 수 없는 답, 알 수 없음)에는 null이다.
 * 원본 오류를 읽지 않는다. 우리가 담아 둔 범주만 본다.
 */
export function describeOpenAIHttpFailure(stage: OpenAIStage, error: unknown): string | null {
  if (!(error instanceof OpenAITransportError)) return null;
  if (error.kind !== 'http_error') return null;
  if (error.httpCategory === undefined) return null;

  return OPENAI_HTTP_FAILURE_CODES[stage][error.httpCategory];
}
