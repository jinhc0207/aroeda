/**
 * 실제로 부르기 직전의 경계.
 *
 * 앞 계층들이 여기까지 왔다.
 *   무엇을 물을지(프롬프트), 어떻게 부를지(설정), 어떤 모양으로 받을지(형식),
 *   받은 답을 어떻게 읽을지(어댑터)까지는 정해졌다.
 *
 * 남은 것이 둘이다.
 *   부를 열쇠가 있는가.
 *   부르다 실패했으면 그것이 무엇이었는가.
 *
 * 이 파일은 그 둘만 정한다.
 *
 * 여기서 하지 않는 일이 더 중요하다.
 *
 * 열쇠 값을 읽지 않는다.
 * 이 파일이 아는 것은 열쇠가 담긴 환경변수의 **이름**뿐이다.
 * 값 자체는 실행 지점이 읽어 넘기고, 이 파일은 그것이 쓸 수 있는 상태인지만 답한다.
 * 그 답에도 값은 담기지 않는다.
 *
 * 열쇠가 없는 것을 "연구 근거가 모자랍니다"로 바꾸지 않는다.
 * 이것이 가장 조심한 부분이다.
 * 설정이 빠진 것은 사람이 고칠 일이고, 연구가 모자란 것은 모델이 판단한 일이다.
 * 둘을 섞으면 화면에서는 멀쩡해 보이는데, 정작 아무도 설정을 고치지 않는다.
 *
 * 실패했다고 다시 부르지 않는다.
 * 너무 자주 불렀다는 답이 와도, 저쪽 서버가 흔들려도, 여기서 한 번 더 부르지 않는다.
 * 다시 해야 한다면 밖에서 새 시도로 다룬다.
 *
 * 상태 숫자를 큰 범주로 바꾸는 규칙은 이미 저장소에 있다.
 * 그것을 여기에 다시 적지 않고 그대로 가져다 쓴다.
 * 두 벌이 되면 언젠가 한쪽만 고쳐진다.
 *
 * 실제 부르는 코드는 여기 없다. 네트워크도, 열쇠 읽기도, 시간을 재는 장치도 없다.
 */

import {
  classifyOpenAIHttpStatus,
  type OpenAIHttpFailureCategory,
} from './openai-transport.ts';
import {
  mapCandidateGenerationProviderCallFailure,
  type ProviderCallFailureKind,
} from './published-content-candidate-generation-openai-adapter-contract.ts';
import { CANDIDATE_GENERATION_RUNTIME_CONFIG } from './published-content-candidate-generation-runtime-config.ts';
import type { CandidateGenerationTransportOutcome } from './published-content-candidate-generation-transport-contract.ts';

/* ------------------------------------------------------------------ */
/* 1. 열쇠는 어디에 있는가                                              */
/* ------------------------------------------------------------------ */

/**
 * 열쇠가 담긴 환경변수의 이름.
 *
 * 이 저장소의 서버 쪽 함수 여섯은 모두 이 이름 하나를 쓰고 있다.
 * 검토 대상 글을 만드는 이 단계만 다른 이름을 쓰면,
 * 배포할 때 한 곳에만 넣어 두고 나머지가 조용히 멈춘다.
 *
 * 그래서 새 이름을 만들지 않고 이미 쓰던 이름을 그대로 쓴다.
 *
 * 여기 있는 것은 이름뿐이다. 값은 이 파일에 들어오지 않는다.
 */
export const CANDIDATE_GENERATION_OPENAI_CREDENTIAL_ENV_NAME = 'OPENAI_API_KEY';

/**
 * 열쇠는 서버에서만 쓴다.
 *
 * 앱 안에 열쇠를 넣으면 그 앱을 받은 사람 누구나 꺼낼 수 있다.
 * 숨겨 넣어도 마찬가지다. 배포된 파일 안에 들어 있는 것은 숨긴 것이 아니다.
 *
 * 그래서 앱에 실려 나가는 이름 앞자리(공개 접두사)를 붙이지 않는다.
 * 그 접두사가 붙은 값은 설계상 앱에 함께 담기게 되어 있다.
 */
export const CANDIDATE_GENERATION_CREDENTIAL_BOUNDARY = {
  /** 서버에서만 읽는다. */
  serverOnly: true,
  /** 브라우저에 내보내지 않는다. */
  browserExposureAllowed: false,
  /** 앱에 함께 실어 보내지 않는다. */
  clientBundleAllowed: false,
  /** 앱 쪽 저장소에 두지 않는다. */
  clientStorageAllowed: false,
  /** 공개되는 설정에 두지 않는다. */
  publicAppConfigAllowed: false,
  /** 앱에 실려 나가는 공개 접두사를 붙이지 않는다. */
  expoPublicPrefixAllowed: false,
  /** 제공자 라이브러리의 브라우저 허용 설정을 켜지 않는다. */
  dangerouslyAllowBrowser: false,
  /** 이 단계만의 별도 열쇠 이름을 만들지 않는다. */
  candidateSpecificCredentialName: null,
} as const;

/**
 * 열쇠를 두지 않는 곳.
 *
 * 한 번 어딘가에 적히면, 그것을 지웠는지 아무도 확인하지 못한다.
 */
export const CREDENTIAL_NOT_STORED_IN = [
  '표(DB)',
  '파일',
  '앱 쪽 저장소',
  '검토 대상 글',
  '연구 결과',
  '근거 기록',
  '검토 꾸러미',
  '기록(log)',
  '오래 살아 있는 임시 보관',
] as const;

/* ------------------------------------------------------------------ */
/* 2. 열쇠가 쓸 수 있는 상태인가                                        */
/* ------------------------------------------------------------------ */

/**
 * 세 가지뿐이다.
 *
 * 없는 것과 잘못 온 것을 나눈 이유가 있다.
 *   없는 것은 아직 넣지 않은 것이다. 넣으면 된다.
 *   잘못 온 것은 넣긴 넣었는데 글자가 아닌 무언가가 온 것이다. 부르는 쪽이 잘못됐다.
 * 고칠 곳이 다르므로 이름을 나눠 둔다.
 *
 * 다만 둘 다 부를 수 없다는 결론은 같다.
 */
export const CANDIDATE_GENERATION_CREDENTIAL_STATES = ['available', 'missing', 'invalid'] as const;

export type CandidateGenerationCredentialState =
  (typeof CANDIDATE_GENERATION_CREDENTIAL_STATES)[number];

/** 부를 수 없는 상태. */
export const CREDENTIAL_UNUSABLE_STATES = ['missing', 'invalid'] as const;

/**
 * 열쇠가 쓸 수 있는 상태인지만 답한다.
 *
 * 보는 것은 둘뿐이다. 글자인가. 앞뒤 공백을 털고도 남는 것이 있는가.
 *
 * 열쇠처럼 생겼는지는 보지 않는다.
 * 앞자리가 무엇인지, 길이가 얼마인지 검사하지 않는다.
 * 제공자가 언제든 형식을 바꿀 수 있고, 그때 우리 검사가 멀쩡한 열쇠를 막게 된다.
 * 진짜로 쓸 수 있는 열쇠인지는 불러 봐야만 알 수 있고, 그것은 여기서 할 일이 아니다.
 *
 * 돌려주는 것에 열쇠 값을 담지 않는다.
 * 담아 두면 그 값이 오류나 기록을 타고 어딘가에 남는다.
 */
export function classifyCandidateGenerationOpenAICredentialValue(value: unknown): {
  state: CandidateGenerationCredentialState;
} {
  if (value === undefined || value === null) {
    return { state: 'missing' };
  }

  if (typeof value !== 'string') {
    // 넣긴 넣었는데 글자가 아니다. 없는 것과 다르다.
    return { state: 'invalid' };
  }

  return value.trim().length === 0 ? { state: 'missing' } : { state: 'available' };
}

/* ------------------------------------------------------------------ */
/* 3. 열쇠가 없으면 부르지 않는다                                       */
/* ------------------------------------------------------------------ */

/**
 * 열쇠 문제로 끝날 때 쓰는 사유.
 *
 * 시간 초과도 아니고, 저쪽이 흔들린 것도 아니다.
 * 우리 쪽 설정이 빠진 것이므로 그 밖의 문제로 끝낸다.
 *
 * 새 사유를 하나 더 만들고 싶어질 수 있지만 만들지 않는다.
 * 사유가 늘면 그것을 다루는 곳이 전부 늘어난 만큼 갈라진다.
 */
const CREDENTIAL_FAILURE_CALL_KIND: ProviderCallFailureKind = 'other';

export type CandidateGenerationCredentialPreflight =
  | { state: 'available'; canCallProvider: true }
  | {
      state: 'missing' | 'invalid';
      canCallProvider: false;
      outcome: CandidateGenerationTransportOutcome;
    };

/**
 * 부르기 전에 한 번 본다.
 *
 * 쓸 수 없으면 부르지 않는다. 한 번도 부르지 않는다.
 * 일단 불러 보고 거절당하면 그때 알자는 방식을 쓰지 않는다.
 * 그렇게 하면 열쇠가 빠진 배포에서 요청이 계속 나가게 된다.
 *
 * 다른 열쇠로 갈아타지 않는다. 다른 제공자로도 가지 않는다.
 * 갈아탈 수 있게 해 두면, 어느 열쇠로 만들어진 글인지 나중에 알 수 없다.
 *
 * 통과했을 때도 열쇠 값을 돌려주지 않는다.
 * 값을 가진 쪽은 부르는 쪽이고, 여기는 판단만 돌려준다.
 */
export function preflightCandidateGenerationOpenAICredential(
  value: unknown,
): CandidateGenerationCredentialPreflight {
  const { state } = classifyCandidateGenerationOpenAICredentialValue(value);

  if (state === 'available') {
    return { state, canCallProvider: true };
  }

  return {
    state,
    canCallProvider: false,
    outcome: mapCandidateGenerationProviderCallFailure(CREDENTIAL_FAILURE_CALL_KIND),
  };
}

/**
 * 열쇠 문제일 때의 약속.
 *
 * 이름은 말해도 된다. "OPENAI_API_KEY가 설정되지 않았습니다"는 고칠 사람에게 필요한 말이다.
 * 값은 어디에도 말하지 않는다.
 */
export const CREDENTIAL_FAILURE_POLICY = {
  /** 부르지 않는다. */
  providerCallAttempted: false,
  /** 다시 부르지 않는다. */
  automaticRetry: false,
  /** 다른 열쇠로 가지 않는다. */
  fallbackCredentialAllowed: false,
  /** 다른 제공자로 가지 않는다. */
  fallbackProviderAllowed: false,
  /** 다른 모델로 가지 않는다. */
  fallbackModelAllowed: false,
  /** 사람에게 보일 글을 만들지 않는다. */
  userFacingContentProduced: false,
  /** 설정 문제를 모델의 판단으로 바꾸지 않는다. */
  becomesDefer: false,
  becomesNeedsMoreResearch: false,
  becomesEmptyResponse: false,
  becomesProviderTimeout: false,
  becomesProviderUnavailable: false,
  /** 이름은 진단에 쓸 수 있다. */
  credentialNameMayBeReported: true,
} as const;

/**
 * 열쇠 값이 가면 안 되는 곳.
 *
 * 전부 아니오다. 하나라도 예가 되면 그 값은 되돌릴 수 없다.
 */
export const CREDENTIAL_PRIVACY_POLICY = {
  credentialValueLogged: false,
  credentialValuePersisted: false,
  credentialValueReturnedInOutcome: false,
  credentialValueIncludedInError: false,
  credentialValueIncludedInCandidate: false,
  credentialValueIncludedInProvenance: false,
  credentialValueIncludedInProviderFailureDetail: false,
  credentialNameMayBeReported: true,
} as const;

/* ------------------------------------------------------------------ */
/* 4. 부르다 실패했으면 무엇이었는가                                    */
/* ------------------------------------------------------------------ */

/**
 * 실제로 부른 쪽이 본 것을, 가장 적은 말로 옮긴 것.
 *
 * 제공자 라이브러리의 오류 종류나 응답 덩어리를 여기로 가져오지 않는다.
 * 가져오면 이 파일이 그 라이브러리에 묶이고, 라이브러리를 바꾸는 날 전부 다시 써야 한다.
 * 그리고 그 덩어리 안에는 우리가 보낸 글과 열쇠가 함께 들어 있을 수 있다.
 *
 * 그래서 부른 쪽이 네 가지 중 하나로 줄여서 넘긴다.
 * 답이 왔던 경우에만 상태 숫자가 함께 온다.
 */
export const PROVIDER_FAILURE_OBSERVATION_KINDS = [
  /** 정해 둔 시간이 실제로 끊었다. */
  'timeout',
  /** 답을 받기 전에 끊겼다. */
  'connection',
  /** 답은 왔는데 받아들여지지 않았다. */
  'http',
  /** 위 어디에도 확실히 들어가지 않는다. */
  'unknown',
] as const;

export type ProviderFailureObservationKind = (typeof PROVIDER_FAILURE_OBSERVATION_KINDS)[number];

export type CandidateGenerationProviderFailureObservation =
  | { kind: 'timeout' }
  | { kind: 'connection' }
  | { kind: 'http'; status: number }
  | { kind: 'unknown' };

/**
 * 이 관찰에 담지 않는 것.
 *
 * 담을 수 있게 열어 두면 언젠가 담긴다.
 */
export const OBSERVATION_DOES_NOT_CARRY = [
  '오류 본문',
  '오류 문구',
  '부른 주소',
  '보낸 요청 본문',
  '프롬프트',
  '사용자가 쓴 글',
  '열쇠',
  '요청에 붙인 인증 값',
] as const;

/**
 * 답을 받기 전에 실패한 경우들.
 *
 * 시간 초과와 연결 끊김을 나눠 둔 이유가 있다.
 * 저장소에 이미 그 교훈이 적혀 있다. 61초 언저리라는 것만으로 시간 초과라고 단정했다가
 * 원인을 두 번 놓친 적이 있다. 실제로 우리가 끊었을 때만 시간 초과다.
 */
const NON_HTTP_OBSERVATION_TO_CALL_FAILURE: Record<
  Exclude<ProviderFailureObservationKind, 'http'>,
  ProviderCallFailureKind
> = {
  timeout: 'timeout',
  connection: 'unavailable',
  unknown: 'other',
};

/**
 * 답은 왔는데 받아들여지지 않은 경우.
 *
 * 숫자를 큰 범주로 바꾸는 규칙은 이미 저장소에 하나 있다.
 * 그것을 그대로 쓰고, 여기서는 그 범주를 우리 사유로 옮기기만 한다.
 * 숫자별 규칙을 여기 다시 적으면 두 벌이 되고, 언젠가 한쪽만 고쳐진다.
 *
 * 너무 자주 불렀거나 저쪽 서버가 흔들린 것은 잠시 못 부르는 것이다.
 * 열쇠·권한 문제, 주소 문제, 우리가 보낸 요청의 문제는 잠시가 아니다.
 * 기다린다고 나아지지 않으므로 그 밖의 문제로 끝낸다.
 */
const HTTP_CATEGORY_TO_CALL_FAILURE: Record<OpenAIHttpFailureCategory, ProviderCallFailureKind> = {
  client_error: 'other',
  auth: 'other',
  not_found: 'other',
  rate_or_quota: 'unavailable',
  server_error: 'unavailable',
  other: 'other',
};

/**
 * 답이 왔지만 "시간이 걸려 끊었다"는 뜻의 상태.
 *
 * 우리가 끊은 것이 아니라 저쪽이 그렇게 알려 온 것이다.
 * 원인이 어디였든 사람에게는 같은 일이므로, 끝나는 이름도 같게 둔다.
 *
 * 이 숫자는 일반적인 4xx보다 **먼저** 걸러야 한다.
 * 뒤로 밀면 "우리가 보낸 요청의 문제"로 묶여 버린다.
 */
const HTTP_REQUEST_TIMEOUT_STATUS = 408;

/**
 * 관찰 하나를 결과 하나로 바꾼다.
 *
 * 여기서 새 결과 이름을 만들지 않는다.
 * 이미 있는 셋(시간 초과·부를 수 없음·그 밖) 중 하나로만 끝난다.
 *
 * 애매하면 그 밖의 문제로 끝낸다. 짐작해서 시간 초과라고 적지 않는다.
 * 잘못 적힌 사유는 없는 사유보다 나쁘다. 엉뚱한 곳을 고치게 만든다.
 */
export function classifyCandidateGenerationProviderFailure(
  observation: CandidateGenerationProviderFailureObservation,
): CandidateGenerationTransportOutcome {
  if (observation.kind !== 'http') {
    return mapCandidateGenerationProviderCallFailure(
      NON_HTTP_OBSERVATION_TO_CALL_FAILURE[observation.kind],
    );
  }

  const status = observation.status;

  // 숫자가 아니거나 온전한 정수가 아니면 뜻을 읽지 않는다.
  // 반올림하거나 가까운 범주로 밀어 넣지 않는다.
  if (!Number.isInteger(status)) {
    return mapCandidateGenerationProviderCallFailure('other');
  }

  if (status === HTTP_REQUEST_TIMEOUT_STATUS) {
    return mapCandidateGenerationProviderCallFailure('timeout');
  }

  return mapCandidateGenerationProviderCallFailure(
    HTTP_CATEGORY_TO_CALL_FAILURE[classifyOpenAIHttpStatus(status)],
  );
}

/* ------------------------------------------------------------------ */
/* 5. 다시 부르지 않는다                                                */
/* ------------------------------------------------------------------ */

/**
 * 다시 부르는 규칙은 앞 계약이 주인이다. 여기서 새로 정하지 않는다.
 *
 * 너무 자주 불렀다는 답이 와도, 저쪽 서버가 흔들려도 한 번 더 부르지 않는다.
 * 그런 경우는 다시 부르면 될 것처럼 보여서 가장 위험하다.
 * 안에서 한 번 더 부르면 한 번의 시도가 몰래 여러 번이 되고,
 * 그중 어느 답이 글이 됐는지 밖에서 알 수 없다.
 */
export const RUNTIME_BOUNDARY_RETRY_POLICY = {
  automaticRetries: CANDIDATE_GENERATION_RUNTIME_CONFIG.automaticRetries,
  fallbackModelAllowed: CANDIDATE_GENERATION_RUNTIME_CONFIG.fallbackModelAllowed,
  fallbackCredentialAllowed: false,
  fallbackProviderAllowed: false,
  retryOnTimeout: false,
  retryOnConnection: false,
  retryOnRateOrQuota: false,
  retryOnServerError: false,
  outputBudgetRaisedOnFailure: false,
} as const;

/**
 * 만약 라이브러리를 쓰게 되면, 그 라이브러리가 스스로 다시 부르는 기능을
 * 반드시 꺼야 한다는 것만 적어 둔다.
 *
 * 기본값에 기대면 "우리는 다시 부르지 않는다"고 적어 두고도
 * 실제로는 여러 번 부르고 있게 된다.
 *
 * 숫자는 여기서 정하지 않는다. 위의 값이 그대로 주인이다.
 */
export const CLIENT_RETRY_OVERRIDE_REQUIREMENT = {
  mustBeExplicitlyDisabled: true,
  defaultClientRetryAllowed: false,
  valueSource: 'candidate generation transport authority',
} as const;

/* ------------------------------------------------------------------ */
/* 6. 기다리는 시간                                                     */
/* ------------------------------------------------------------------ */

/**
 * 기다리는 시간은 앞서 정한 설정이 주인이다.
 *
 * 여기에 숫자를 다시 적지 않는다.
 * 적어 두면 어느 날 한쪽만 바뀌고, 실제로 몇 초를 기다리는지 아무도 모르게 된다.
 *
 * 시간을 실제로 재는 장치는 이 파일에 없다.
 * 그것은 진짜로 부르는 계층의 몫이다.
 */
export const RUNTIME_BOUNDARY_TIMEOUT_POLICY = {
  timeoutMs: CANDIDATE_GENERATION_RUNTIME_CONFIG.timeoutMs,
  mustBeExplicitlySet: true,
  defaultClientTimeoutAllowed: false,
  timeoutMechanismImplementedHere: false,
  valueSource: 'candidate generation runtime config',
} as const;

/* ------------------------------------------------------------------ */
/* 7. 어떻게 부를지는 아직 정하지 않았다                                */
/* ------------------------------------------------------------------ */

/**
 * 실제로 어떤 방법으로 부를지는 이 단계에서 정하지 않는다.
 *
 * 저장소를 살펴본 사실만 적어 둔다.
 * 지금 서버 쪽 함수들은 전부 직접 요청을 보내는 방식을 쓰고 있고,
 * 서버에서 제공자 라이브러리를 쓴 전례는 없다.
 *
 * 그러니 다음 단계에서 같은 방식을 이어 가는 편이 자연스러워 보인다.
 * 다만 이것은 살펴본 결과일 뿐 여기서 못 박은 약속이 아니다.
 * 못 박는 것은 따로 승인받을 일이다.
 */
export const IMPLEMENTATION_METHOD_DISCOVERY = {
  frozenHere: false,
  serverPrecedent: 'direct request',
  serverClientLibraryPrecedent: null,
  preferredNextCandidate: 'direct request',
  isFrozenAuthority: false,
  note: '살펴본 결과다. 이 단계에서 정한 약속이 아니다.',
} as const;

/* ------------------------------------------------------------------ */
/* 8. 남기지 않는 것                                                    */
/* ------------------------------------------------------------------ */

/**
 * 실패했을 때 남기는 것은 사유 이름 하나뿐이다.
 *
 * 왜 실패했는지 자세히 남기고 싶어지는 순간이 반드시 온다.
 * 그런데 제공자가 보내 오는 오류 본문에는 우리가 보낸 것이 그대로 되비쳐 오기도 한다.
 * 거기에는 프롬프트가, 때로는 요청에 붙인 인증 값이 섞여 있다.
 *
 * 한 번 남기기 시작하면 무엇이 남았는지 아무도 확인하지 않는다.
 * 그래서 처음부터 남기지 않는다.
 */
export const RUNTIME_BOUNDARY_LOGGING_POLICY = {
  debugLoggingAllowed: false,
  rawRequestLoggingAllowed: false,
  rawResponseLoggingAllowed: false,
  credentialLoggingAllowed: false,
  providerErrorBodyPersistenceAllowed: false,
  providerErrorMessagePersistenceAllowed: false,
} as const;

/* ------------------------------------------------------------------ */
/* 9. 여기서 하지 않는 일                                               */
/* ------------------------------------------------------------------ */

/**
 * 모델이 답하기를 거절한 것과 답이 오다 만 것은 여기서 다루지 않는다.
 *
 * 그 둘은 부르는 데 성공한 경우다. 답을 받았고, 그 답이 쓸 수 없을 뿐이다.
 * 부르지 못한 것과 같은 자리에서 다루면 그 차이가 사라진다.
 *
 * 어댑터가 이미 그 둘을 가려내고 있다. 여기서 다시 보지 않는다.
 */
export const RUNTIME_BOUNDARY_DOES_NOT_INCLUDE = [
  '열쇠 값을 읽는 일',
  '실제로 요청을 보내는 일',
  '기다리는 시간을 실제로 재는 일',
  '모델이 거절했는지 가리는 일',
  '답이 오다 말았는지 가리는 일',
  '받은 답을 읽고 검사하는 일',
  '검토 대상 글을 조립하는 일',
  '글을 적어 두는 일',
  '표를 읽거나 쓰는 일',
] as const;

/**
 * 부르는 데 실패한 것과, 부른 뒤 답이 이상한 것을 섞지 않는다.
 *
 * 섞으면 고칠 곳을 알 수 없다.
 * 앞의 것은 설정과 연결의 문제이고, 뒤의 것은 모델과 계약의 문제다.
 */
export const TRANSPORT_FAILURE_AND_RESPONSE_SEMANTICS_ARE_SEPARATE =
  '부르지 못한 것과 답이 쓸 수 없는 것은 다른 일이다. 한자리에서 다루지 않는다.';
