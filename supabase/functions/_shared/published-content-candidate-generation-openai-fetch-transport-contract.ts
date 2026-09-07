/**
 * 실제로 요청을 보내는 자리의 약속.
 *
 * 앞 계층들이 전부 준비됐다.
 *   무엇을 물을지, 어떻게 부를지, 어떤 모양으로 받을지,
 *   열쇠가 있는지, 실패했으면 무엇이었는지까지.
 *
 * 남은 것은 "보내고 받는 동안 무슨 일이 일어나는가"뿐이다.
 * 이 파일은 그 순서와, 받은 것을 다음 계층에 넘기기 전에
 * 반드시 해야 하는 한 가지 손질만 정한다.
 *
 * 그 한 가지가 이 파일이 생긴 이유다.
 *
 * 저장소를 살펴보다 알게 된 것이 있다.
 * 우리 어댑터는 답에서 `output_text`라는 자리를 읽는다.
 * 그런데 그 자리는 제공자가 HTTP로 보내 주는 것이 아니라
 * 제공자의 라이브러리가 계산해서 붙여 주는 편의 항목이다.
 *
 * 우리는 라이브러리를 쓰지 않고 직접 요청을 보낸다.
 * 그러니 받은 것을 그대로 어댑터에 주면 그 자리가 비어 있고,
 * 잘 온 답도 매번 "받은 것이 없다"로 끝난다. 조용히, 한 번도 성공하지 못한 채.
 *
 * 그래서 이 계층이 그 값을 채워서 넘긴다.
 * 새로 계산하지 않는다. 이 저장소가 이미 여섯 곳에서 쓰고 있는
 * 같은 함수를 그대로 가져다 쓴다.
 *
 * 이것은 답을 고치는 것이 아니다.
 * 라이브러리가 하던 계산을 우리가 대신 하는 것뿐이고, 답의 내용은 하나도 달라지지 않는다.
 *
 * 여기서 하지 않는 일이 더 많다.
 *   실제로 보내지 않는다. 시간을 재지 않는다. 열쇠를 읽지 않는다.
 *   거절인지, 오다 만 것인지, 무슨 실패인지 판단하지 않는다.
 *   그 판단들은 이미 각자 주인이 있다. 여기서 다시 하지 않는다.
 */

import { extractOutputText } from './openai-response.ts';
import {
  OPENAI_REQUEST_BODY_FIELDS,
  type CandidateGenerationOpenAIRequestSpec,
} from './published-content-candidate-generation-openai-adapter-contract.ts';
import {
  CANDIDATE_GENERATION_OPENAI_CREDENTIAL_ENV_NAME,
  RUNTIME_BOUNDARY_LOGGING_POLICY,
  RUNTIME_BOUNDARY_RETRY_POLICY,
  RUNTIME_BOUNDARY_TIMEOUT_POLICY,
  classifyCandidateGenerationProviderFailure,
  type CandidateGenerationProviderFailureObservation,
} from './published-content-candidate-generation-openai-runtime-boundary.ts';
import type { CandidateGenerationTransportOutcome } from './published-content-candidate-generation-transport-contract.ts';

/* ------------------------------------------------------------------ */
/* 1. 받은 것을 어댑터에게 넘길 수 있는 모양으로                        */
/* ------------------------------------------------------------------ */

/**
 * 어댑터가 실제로 읽는 자리는 넷뿐이다.
 *
 * 제공자가 보내 주는 답에는 이보다 훨씬 많은 것이 들어 있지만,
 * 우리가 읽는 것은 이 넷이다. 그러니 이 넷이 온전히 넘어가면 된다.
 *
 * 제공자 라이브러리의 답 타입을 통째로 베껴 오지 않는다.
 * 베껴 오면 그쪽이 바뀔 때마다 여기도 따라 바뀌어야 하고,
 * 우리가 쓰지도 않는 자리 때문에 고치게 된다.
 */
export const ADAPTER_INPUT_FIELDS = ['status', 'error', 'output', 'output_text'] as const;

/**
 * 채워 넣는 자리의 이름.
 *
 * 이 이름의 주인은 우리가 아니라 제공자다.
 * 어댑터가 읽는 이름과 같아야 하므로 여기서 다르게 짓지 않는다.
 */
export const DERIVED_OUTPUT_TEXT_FIELD = 'output_text';

/**
 * 그 값을 어디서 얻는가.
 *
 * 이 저장소에 이미 있는 함수 하나뿐이다.
 * 여기서 답을 훑는 방법을 다시 쓰지 않는다.
 *
 * 다시 쓰면 두 벌이 되고, 언젠가 한쪽만 고쳐진다.
 * 그리고 그 한쪽이 거절한 말이나 생각한 흔적을 답에 섞어 넣기 시작해도
 * 아무도 알아채지 못한다.
 */
export const DERIVED_OUTPUT_TEXT_AUTHORITY = 'extractOutputText';

/**
 * 이미 붙어 있는 편의 항목을 믿지 않는다.
 *
 * 시험용으로 만든 답이나 라이브러리를 거쳐 온 답에는
 * 그 자리가 이미 채워져 있을 수 있다.
 *
 * 그래도 그것을 쓰지 않고 답의 알맹이에서 다시 구한다.
 *
 * 우리가 실제로 지나는 길에는 그 자리가 없기 때문이다.
 * 있을 때만 잘 되고 없을 때 조용히 실패하는 코드를 만들지 않는다.
 * 어차피 구할 값이면 언제나 같은 곳에서 구하는 편이 낫다.
 */
export const RAW_CONVENIENCE_FIELD_TRUSTED = false;

/**
 * 손질했다고 알맹이를 걷어내지 않는다.
 *
 * 글을 뽑았으니 원래 것은 필요 없다고 여기기 쉽지만, 그렇지 않다.
 * 거절이 섞여 있는지는 어댑터가 답의 알맹이를 훑어서 판단한다.
 * 걷어내면 그 판단이 통째로 사라지고, 거절한 답이 멀쩡한 답처럼 지나간다.
 */
export const RAW_STRUCTURE_PRESERVED = true;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * 받은 답을 어댑터가 읽을 수 있는 모양으로 만든다.
 *
 * 하는 일은 하나뿐이다. 글을 담는 자리를 채운다.
 * 나머지는 손대지 않고 그대로 옮긴다.
 *
 * 받은 것을 고치지 않는다.
 * 받은 객체에 직접 써 넣으면, 넘겨준 쪽이 들고 있던 것도 함께 바뀐다.
 * 그러면 "손질 전"이 어디에도 남지 않는다. 그래서 새로 하나 만들어 돌려준다.
 *
 * 객체가 아닌 것이 오면 그대로 돌려보낸다.
 * 억지로 답처럼 보이게 만들지 않는다.
 * 이상한 것이 왔으면 이상한 채로 어댑터에 닿아야 거기서 문제로 끝난다.
 * 여기서 그럴듯하게 만들어 주면, 무엇이 잘못됐는지 아무도 모르게 된다.
 */
export function normalizeCandidateGenerationOpenAIHttpResponseForAdapter(raw: unknown): unknown {
  if (!isPlainObject(raw)) {
    return raw;
  }

  return {
    ...raw,
    // 이미 들어 있던 값이 있어도 여기서 덮는다. 주인은 답의 알맹이다.
    [DERIVED_OUTPUT_TEXT_FIELD]: extractOutputText(raw),
  };
}

/**
 * 손질하는 쪽이 판단하지 않는 것.
 *
 * 이 셋은 전부 어댑터의 몫이다.
 * 여기서 한 발이라도 들여놓으면 같은 판단이 두 곳에서 나고,
 * 두 곳이 다르게 말하기 시작하면 어느 쪽이 맞는지 가릴 방법이 없다.
 */
export const NORMALIZATION_DOES_NOT_DECIDE = [
  '거절인지 아닌지',
  '오다 말았는지 아닌지',
  '제공자 쪽 문제인지 아닌지',
] as const;

/* ------------------------------------------------------------------ */
/* 2. 보내고 받는 동안의 순서                                           */
/* ------------------------------------------------------------------ */

/**
 * 한 번의 요청이 지나가는 자리들.
 *
 * 순서를 적어 두는 이유가 있다.
 * 시간을 재기 시작하는 자리가 한 칸만 뒤로 밀려도,
 * 답을 읽는 동안 걸린 시간은 아무도 재지 않게 된다.
 * 그러면 거기서 멈춘 요청이 영영 끝나지 않는다.
 */
export const FETCH_TRANSPORT_LIFECYCLE = [
  '열쇠가 쓸 수 있는 상태인지 먼저 본다',
  '보낼 것을 어댑터에게서 받는다',
  '시간 재기를 시작한다',
  '한 번 보낸다',
  '보내다 실패했으면 그것으로 끝낸다',
  '답을 받는다',
  '받아들여지지 않은 답이면 그것으로 끝낸다',
  '답의 본문을 읽는다',
  '읽은 것에 글 담는 자리를 채운다',
  '어댑터에게 넘겨 무슨 일이었는지 정한다',
  '어떤 길로 끝났든 시간 재기를 정리한다',
] as const;

/**
 * 몇 번 보내는가.
 *
 * 한 번이다.
 *
 * 숫자를 여기서 새로 정하지 않는다.
 * 다시 부르지 않기로 한 약속에서 그대로 따라 나온다.
 * 그 약속이 바뀌면 이 숫자도 함께 바뀌어야 하기 때문이다.
 */
export const FETCH_ATTEMPTS = RUNTIME_BOUNDARY_RETRY_POLICY.automaticRetries + 1;

/**
 * 시간을 어떻게 재는가.
 *
 * 답을 받는 순간이 아니라 답의 본문을 다 읽는 순간까지 재야 한다.
 *
 * 머리만 오고 본문이 오지 않는 경우가 있다.
 * 그때 시계를 이미 껐으면 그 요청은 아무도 끊지 않는다.
 *
 * 정리는 어느 길로 끝나든 반드시 한 번 한다.
 * 성공했을 때만 정리하면, 실패한 요청의 시계가 계속 돌아간다.
 */
export const TIMEOUT_LIFECYCLE_POLICY = {
  timeoutMs: RUNTIME_BOUNDARY_TIMEOUT_POLICY.timeoutMs,
  startsBeforeNetworkAttempt: true,
  coversResponseBodyRead: true,
  cleanupAlways: true,
  cleanupCount: 1,
  /** 실제로 시간을 재는 장치는 여기 없다. 다음 단계의 몫이다. */
  implementedHere: false,
} as const;

/**
 * 끊긴 것이 우리 때문인지 어떻게 아는가.
 *
 * 요청이 끊겼다는 사실만으로는 알 수 없다.
 * 우리가 끊을 수도 있고, 저쪽이나 중간에서 끊길 수도 있다.
 *
 * 그래서 우리가 끊을 때 그 사실을 따로 적어 두고, 그것만 본다.
 * 끊겼다는 표시만 보고 시간 초과라고 적으면,
 * 연결이 끊어진 것도 전부 시간 초과가 된다.
 * 그러면 기다리는 시간을 아무리 늘려도 나아지지 않는다.
 *
 * 이 저장소의 연구 단계가 이미 그렇게 하고 있다. 같은 방식을 따른다.
 */
export const TIMED_OUT_FLAG_POLICY = {
  explicitFlagRequired: true,
  abortedAloneIsEnough: false,
  reason: '끊겼다는 표시만으로는 우리가 끊은 것인지 알 수 없다.',
} as const;

/* ------------------------------------------------------------------ */
/* 3. 실패했으면 무엇으로 보는가                                        */
/* ------------------------------------------------------------------ */

/**
 * 실패가 일어날 수 있는 자리 셋.
 *
 * 어디서 실패했는지에 따라 뜻이 다르다.
 *   보내다 실패한 것은 닿지도 못한 것이다.
 *   받아들여지지 않은 것은 닿았는데 거절당한 것이다.
 *   본문을 읽다 실패한 것은 답이 오다 만 것이다.
 *
 * 셋을 뭉뚱그리면 고칠 곳을 알 수 없다.
 */
export type CandidateGenerationFetchFailureEvent =
  | { stage: 'fetch_rejected'; timedOut: boolean }
  | { stage: 'http_not_ok'; status: number }
  | { stage: 'body_read_failed'; timedOut: boolean };

export const FETCH_FAILURE_STAGES = [
  'fetch_rejected',
  'http_not_ok',
  'body_read_failed',
] as const;

/**
 * 실패를 가장 적은 말로 옮긴다.
 *
 * 여기서 최종 사유를 정하지 않는다. 본 것을 그대로 옮기기만 한다.
 * 최종 사유를 정하는 곳은 이미 따로 있고, 거기 한 곳뿐이어야 한다.
 *
 * 본문을 읽다 실패한 것을 "연결이 끊겼다"로 적지 않는다.
 * 연결은 됐다. 답도 왔다. 읽지 못했을 뿐이다.
 * 그러니 그 밖의 문제로 남긴다. 짐작해서 이름을 붙이지 않는다.
 */
export function observeCandidateGenerationFetchFailure(
  event: CandidateGenerationFetchFailureEvent,
): CandidateGenerationProviderFailureObservation {
  if (event.stage === 'http_not_ok') {
    // 상태 숫자는 여기서 읽지 않는다. 그대로 넘긴다.
    return { kind: 'http', status: event.status };
  }

  if (event.timedOut) {
    return { kind: 'timeout' };
  }

  // 보내다 실패했으면 닿지 못한 것이고, 읽다 실패했으면 알 수 없는 것이다.
  return event.stage === 'fetch_rejected' ? { kind: 'connection' } : { kind: 'unknown' };
}

/**
 * 옮긴 것을 이미 있는 판단에 넘긴다.
 *
 * 숫자별 규칙을 여기 다시 적지 않는다.
 * 어떤 숫자가 무슨 뜻인지는 이미 정해져 있고, 그 주인은 한 곳뿐이다.
 */
export function classifyCandidateGenerationFetchFailure(
  event: CandidateGenerationFetchFailureEvent,
): CandidateGenerationTransportOutcome {
  return classifyCandidateGenerationProviderFailure(observeCandidateGenerationFetchFailure(event));
}

/**
 * 본문을 읽지 못한 것과, 모델이 쓴 글을 읽지 못한 것은 다른 일이다.
 *
 * 이름이 비슷해서 섞이기 쉬운데, 고칠 곳이 전혀 다르다.
 *
 * 앞엣것은 제공자와 우리 사이의 문제다. 연결이나 설정을 봐야 한다.
 * 뒤엣것은 모델이 약속을 어긴 것이다. 프롬프트나 형식을 봐야 한다.
 *
 * 앞엣것을 뒤엣것으로 적으면, 아무 잘못 없는 프롬프트를 계속 고치게 된다.
 */
export const BODY_READ_FAILURE_IS_NOT_MODEL_JSON_FAILURE =
  '답의 본문을 읽지 못한 것과 모델이 쓴 글을 읽지 못한 것은 다른 일이다. 섞지 않는다.';

/**
 * 받아들여지지 않은 답을 어떻게 다루는가.
 *
 * 본문을 열지 않는다. 열지 않으면 흘릴 일도 없다.
 * 제공자가 보내는 오류 본문에는 우리가 보낸 것이 그대로 되비쳐 오기도 한다.
 *
 * 상태 숫자는 어느 쪽인지 가리는 데만 쓰고, 그 뒤로는 남지 않는다.
 */
export const HTTP_FAILURE_POLICY = {
  errorBodyRead: false,
  errorMessageCaptured: false,
  statusUsedOnlyForClassification: true,
  statusPreservedInOutcome: false,
  urlPreserved: false,
} as const;

/* ------------------------------------------------------------------ */
/* 4. 보낼 것은 여기서 만들지 않는다                                    */
/* ------------------------------------------------------------------ */

/**
 * 보낼 것의 주인은 어댑터다.
 *
 * 어댑터가 이미 다 만들어 놓은 것을 받아서 그대로 보낸다.
 * 여기서 한 항목이라도 더하거나 빼거나 바꾸면,
 * 정해 둔 값과 실제로 나가는 값이 달라진다.
 * 그러면 설정 파일을 아무리 들여다봐도 무엇이 나갔는지 알 수 없다.
 */
export const REQUEST_SPEC_POLICY = {
  bodyFieldCount: OPENAI_REQUEST_BODY_FIELDS.length,
  bodyRebuiltHere: false,
  bodyFieldsAddedHere: false,
  bodyFieldsRemovedHere: false,
  bodyFieldsModifiedHere: false,
  serializedExactlyOnce: true,
  timeoutTakenFromSpec: true,
} as const;

export type CandidateGenerationFetchTransportRequest = CandidateGenerationOpenAIRequestSpec;

/**
 * 어떻게 보내는가.
 *
 * 이 저장소의 서버 쪽 요청 여섯이 전부 같은 방식이다. 그대로 따른다.
 *
 * 주소는 여기서 정하지 않는다.
 * 이미 여섯 곳에 적혀 있는 것을 일곱 번째로 적을 이유가 없다.
 * 실제로 보내는 자리에서 그중 하나를 쓰면 된다.
 */
export const PROVIDER_PROTOCOL = {
  method: 'POST',
  contentType: 'application/json',
  endpointDefinedHere: false,
  headersBuiltHere: false,
} as const;

/* ------------------------------------------------------------------ */
/* 5. 열쇠                                                              */
/* ------------------------------------------------------------------ */

/**
 * 열쇠는 받아서 쓰기만 한다.
 *
 * 이 파일은 열쇠를 찾지도, 읽지도, 들고 있지도 않는다.
 * 이름만 안다.
 *
 * 그리고 열쇠를 붙인 머리글을 만들어 돌려주지 않는다.
 * 한 번 만들어 돌려주기 시작하면, 그것이 어디로 가는지 따라갈 수 없다.
 * 만드는 일은 실제로 보내는 그 자리에서만 한다.
 */
export const CREDENTIAL_POLICY = {
  envName: CANDIDATE_GENERATION_OPENAI_CREDENTIAL_ENV_NAME,
  envReadHere: false,
  receivedAsParameter: true,
  authorizationHeaderBuiltHere: false,
  credentialInPureResult: false,
  preflightAuthority: 'candidate generation openai runtime boundary',
} as const;

/* ------------------------------------------------------------------ */
/* 6. 남기지 않는다                                                     */
/* ------------------------------------------------------------------ */

/**
 * 기록에 관한 약속은 앞 계층이 주인이다. 그대로 가져온다.
 * 여기서 다시 적으면 두 곳이 어긋날 수 있다.
 */
export const FETCH_TRANSPORT_LOGGING_POLICY = RUNTIME_BOUNDARY_LOGGING_POLICY;

/**
 * 손질한 결과는 어댑터에게 넘기는 동안만 있는 것이다.
 *
 * 뽑아낸 글도 남기지 않는다.
 * 남겨 두면 그것이 사람이 검토할 글이 아닌데도 언젠가 그렇게 쓰인다.
 */
export const FETCH_TRANSPORT_PERSISTENCE_POLICY = {
  rawResponsePersisted: false,
  derivedOutputTextPersisted: false,
  rawRefusalPersisted: false,
  reasoningExtracted: false,
  reasoningPersisted: false,
  providerErrorBodyPersisted: false,
  providerErrorMessagePersisted: false,
} as const;

/* ------------------------------------------------------------------ */
/* 7. 누가 무엇의 주인인가                                              */
/* ------------------------------------------------------------------ */

/**
 * 여기까지 계층이 여럿이 됐다.
 * 어느 것이 무엇을 정하는지 한자리에 적어 둔다.
 *
 * 적어 두지 않으면, 급할 때 가까운 자리에 한 줄 더 넣게 된다.
 * 그렇게 들어간 한 줄이 나중에 다른 곳과 다른 말을 한다.
 */
export const AUTHORITY_MAP = {
  outputTextAggregation: 'extractOutputText',
  responseSemantics: 'candidate generation openai adapter contract',
  failureClassification: 'candidate generation openai runtime boundary',
  timeoutAndRetry: 'candidate generation runtime config',
  requestBody: 'candidate generation openai adapter request spec',
  transportLifecycle: 'candidate generation openai fetch transport contract',
} as const;

/** 이 계층이 하지 않는 일. */
export const FETCH_TRANSPORT_DOES_NOT_INCLUDE = [
  '실제로 요청을 보내는 일',
  '시간을 실제로 재는 일',
  '열쇠를 찾거나 읽는 일',
  '보낼 것을 만드는 일',
  '답에서 글을 훑어 모으는 규칙을 정하는 일',
  '거절인지 오다 만 것인지 가리는 일',
  '상태 숫자가 무슨 뜻인지 정하는 일',
  '검토 대상 글을 조립하는 일',
  '글을 적어 두는 일',
  '표를 읽거나 쓰는 일',
] as const;
