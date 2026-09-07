/**
 * 실제로 부르기 직전의 경계 · 테스트
 *
 * 실행: npm test
 *
 * 지키려는 것 여섯 가지.
 *
 *   1. 열쇠 이름은 이미 저장소가 쓰던 그 이름 하나다. 새로 만들지 않는다.
 *   2. 열쇠가 없으면 한 번도 부르지 않고 끝낸다.
 *   3. 설정이 빠진 것을 모델의 판단으로 바꾸지 않는다.
 *   4. 상태 숫자를 읽는 규칙은 이미 있는 것을 그대로 쓴다. 두 벌로 만들지 않는다.
 *   5. 무슨 일이 있어도 다시 부르지 않는다.
 *   6. 열쇠 값도 오류 문구도 어디에도 남지 않는다.
 *
 * 열쇠를 읽지 않는다. 부르지 않는다. 손으로 만든 값만 넣는다.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  CANDIDATE_GENERATION_CREDENTIAL_BOUNDARY,
  CANDIDATE_GENERATION_CREDENTIAL_STATES,
  CANDIDATE_GENERATION_OPENAI_CREDENTIAL_ENV_NAME,
  CLIENT_RETRY_OVERRIDE_REQUIREMENT,
  CREDENTIAL_FAILURE_POLICY,
  CREDENTIAL_NOT_STORED_IN,
  CREDENTIAL_PRIVACY_POLICY,
  CREDENTIAL_UNUSABLE_STATES,
  IMPLEMENTATION_METHOD_DISCOVERY,
  OBSERVATION_DOES_NOT_CARRY,
  PROVIDER_FAILURE_OBSERVATION_KINDS,
  RUNTIME_BOUNDARY_DOES_NOT_INCLUDE,
  RUNTIME_BOUNDARY_LOGGING_POLICY,
  RUNTIME_BOUNDARY_RETRY_POLICY,
  RUNTIME_BOUNDARY_TIMEOUT_POLICY,
  TRANSPORT_FAILURE_AND_RESPONSE_SEMANTICS_ARE_SEPARATE,
  classifyCandidateGenerationOpenAICredentialValue,
  classifyCandidateGenerationProviderFailure,
  preflightCandidateGenerationOpenAICredential,
  type CandidateGenerationProviderFailureObservation,
} from '../../supabase/functions/_shared/published-content-candidate-generation-openai-runtime-boundary.ts';
import {
  OPENAI_HTTP_FAILURE_CATEGORIES,
  classifyOpenAIHttpStatus,
} from '../../supabase/functions/_shared/openai-transport.ts';
import { CANDIDATE_GENERATION_RUNTIME_CONFIG } from '../../supabase/functions/_shared/published-content-candidate-generation-runtime-config.ts';
import {
  PROVIDER_FAILURE_OUTCOMES,
  TRANSPORT_OUTCOMES,
  TRANSPORT_RUNTIME_CONFIG_POLICY,
} from '../../supabase/functions/_shared/published-content-candidate-generation-transport-contract.ts';

const BOUNDARY_PATH =
  '../../supabase/functions/_shared/published-content-candidate-generation-openai-runtime-boundary.ts';

const BOUNDARY_SOURCE = readFileSync(new URL(BOUNDARY_PATH, import.meta.url), 'utf8');

/** 진짜처럼 보이는 값을 쓰지 않는다. 한눈에 가짜여야 한다. */
const PLACEHOLDER = 'test-credential-placeholder';

/** 결과 안에 어떤 글자도 남지 않았는지 통째로 확인할 때 쓴다. */
const dump = (value: unknown): string => JSON.stringify(value);

const http = (status: number): CandidateGenerationProviderFailureObservation => ({
  kind: 'http',
  status,
});

const outcomeOf = (observation: CandidateGenerationProviderFailureObservation): string =>
  classifyCandidateGenerationProviderFailure(observation).outcome;

/* ================================================================== */
/* 1. 이미 있는 것을 다시 만들지 않았는가                                */
/* ================================================================== */

describe('저장소에 이미 있는 규칙을 그대로 쓴다', () => {
  it('상태 숫자를 범주로 바꾸는 규칙을 여기에 다시 적지 않았다', () => {
    // 그 규칙이 있는 곳은 openai-transport.ts 한 곳뿐이어야 한다.
    // 여기에 숫자별 분기가 다시 생기면 두 벌이 되고 언젠가 한쪽만 고쳐진다.
    for (const status of ['401', '403', '404', '429', '500', '599', '499']) {
      assert.equal(BOUNDARY_SOURCE.includes(status), false, status);
    }
  });

  it('범주 이름을 새로 짓지 않고 이미 있는 것을 그대로 받는다', () => {
    const table = [...BOUNDARY_SOURCE.matchAll(/^ {2}(\w+): '(\w+)',$/gm)];
    const categoryKeys = table
      .map((m) => m[1] as string)
      .filter((key) => (OPENAI_HTTP_FAILURE_CATEGORIES as readonly string[]).includes(key));

    // 모든 범주가 전부 다뤄져야 한다. 하나라도 빠지면 그 경우가 조용히 undefined가 된다.
    assert.equal(new Set(categoryKeys).size, OPENAI_HTTP_FAILURE_CATEGORIES.length);
  });

  it('숫자를 읽는 함수를 직접 부른다', () => {
    assert.ok(BOUNDARY_SOURCE.includes('classifyOpenAIHttpStatus('));
  });

  it('결과를 만드는 일도 이미 있는 것에 맡긴다', () => {
    assert.ok(BOUNDARY_SOURCE.includes('mapCandidateGenerationProviderCallFailure('));
    // 결과 모양을 손으로 다시 만들지 않는다.
    assert.equal(BOUNDARY_SOURCE.includes('{ outcome:'), false);
  });

  it('실패 사유 이름을 손으로 적지 않는다', () => {
    for (const outcome of PROVIDER_FAILURE_OUTCOMES) {
      assert.equal(BOUNDARY_SOURCE.includes(`'${outcome}'`), false, outcome);
    }
  });

  it('부르기 실패의 종류를 새로 정의하지 않는다', () => {
    assert.equal(BOUNDARY_SOURCE.includes('PROVIDER_CALL_FAILURE_KINDS ='), false);
    assert.equal(BOUNDARY_SOURCE.includes('OPENAI_HTTP_FAILURE_CATEGORIES ='), false);
    assert.equal(BOUNDARY_SOURCE.includes('OPENAI_TRANSPORT_FAILURE_KINDS'), false);
  });

  it('가져다 쓰는 곳은 저장소 안의 계약 넷뿐이다', () => {
    const specifiers = [...BOUNDARY_SOURCE.matchAll(/from '([^']+)'/g)].map((m) => m[1] as string);

    assert.deepEqual(specifiers, [
      './openai-transport.ts',
      './published-content-candidate-generation-openai-adapter-contract.ts',
      './published-content-candidate-generation-runtime-config.ts',
      './published-content-candidate-generation-transport-contract.ts',
    ]);
  });
});

/* ================================================================== */
/* 2. 열쇠 이름                                                        */
/* ================================================================== */

describe('열쇠 이름', () => {
  it('저장소가 이미 쓰던 이름 그대로다', () => {
    assert.equal(CANDIDATE_GENERATION_OPENAI_CREDENTIAL_ENV_NAME, 'OPENAI_API_KEY');
  });

  it('이 단계만의 별도 열쇠 이름을 만들지 않았다', () => {
    for (const forbidden of [
      'AROEDA_OPENAI_KEY',
      'CANDIDATE_OPENAI_API_KEY',
      'PUBLISHED_CONTENT_OPENAI_API_KEY',
      'OPENAI_API_KEY_CANDIDATE',
    ]) {
      assert.equal(BOUNDARY_SOURCE.includes(forbidden), false, forbidden);
    }

    assert.equal(CANDIDATE_GENERATION_CREDENTIAL_BOUNDARY.candidateSpecificCredentialName, null);
  });

  it('앱에 실려 나가는 공개 접두사가 붙어 있지 않다', () => {
    assert.equal(
      CANDIDATE_GENERATION_OPENAI_CREDENTIAL_ENV_NAME.startsWith('EXPO_PUBLIC_'),
      false,
    );
    assert.equal(CANDIDATE_GENERATION_CREDENTIAL_BOUNDARY.expoPublicPrefixAllowed, false);
  });

  it('열쇠 이름 말고 다른 환경변수를 알지 못한다', () => {
    const quoted = [...BOUNDARY_SOURCE.matchAll(/'([A-Z][A-Z0-9_]{3,})'/g)].map(
      (m) => m[1] as string,
    );

    assert.deepEqual(quoted, ['OPENAI_API_KEY']);
  });
});

/* ================================================================== */
/* 3. 열쇠가 쓸 수 있는 상태인가                                        */
/* ================================================================== */

describe('열쇠 상태를 가린다', () => {
  it('상태는 셋뿐이다', () => {
    assert.deepEqual([...CANDIDATE_GENERATION_CREDENTIAL_STATES], [
      'available',
      'missing',
      'invalid',
    ]);
  });

  it('없으면 없다고 한다', () => {
    assert.equal(classifyCandidateGenerationOpenAICredentialValue(undefined).state, 'missing');
    assert.equal(classifyCandidateGenerationOpenAICredentialValue(null).state, 'missing');
  });

  it('비어 있으면 없는 것과 같다', () => {
    assert.equal(classifyCandidateGenerationOpenAICredentialValue('').state, 'missing');
  });

  it('공백만 있으면 없는 것과 같다', () => {
    for (const blank of [' ', '   ', '\t', '\n', ' \t\n ']) {
      assert.equal(
        classifyCandidateGenerationOpenAICredentialValue(blank).state,
        'missing',
        JSON.stringify(blank),
      );
    }
  });

  it('글자가 아니면 잘못 온 것이다', () => {
    for (const wrong of [0, 1, true, false, {}, [], () => PLACEHOLDER, Symbol('x')]) {
      assert.equal(
        classifyCandidateGenerationOpenAICredentialValue(wrong).state,
        'invalid',
        String(typeof wrong),
      );
    }
  });

  it('글자가 있으면 쓸 수 있다고 한다', () => {
    assert.equal(classifyCandidateGenerationOpenAICredentialValue(PLACEHOLDER).state, 'available');
    // 앞뒤 공백이 있어도 알맹이가 있으면 쓸 수 있다.
    assert.equal(
      classifyCandidateGenerationOpenAICredentialValue(`  ${PLACEHOLDER}  `).state,
      'available',
    );
  });

  it('열쇠처럼 생겼는지는 보지 않는다', () => {
    // 앞자리·길이로 거르면, 제공자가 형식을 바꾸는 날 멀쩡한 열쇠가 막힌다.
    assert.equal(classifyCandidateGenerationOpenAICredentialValue('a').state, 'available');
    assert.equal(classifyCandidateGenerationOpenAICredentialValue('열쇠').state, 'available');

    assert.equal(BOUNDARY_SOURCE.includes('sk-'), false);
    assert.equal(BOUNDARY_SOURCE.includes('startsWith'), false);
    assert.equal(BOUNDARY_SOURCE.includes('.length >'), false);
    assert.equal(BOUNDARY_SOURCE.includes('.length <'), false);
  });

  it('돌려주는 것에 열쇠 값이 없다', () => {
    const result = classifyCandidateGenerationOpenAICredentialValue(PLACEHOLDER);

    assert.deepEqual(Object.keys(result), ['state']);
    assert.equal(dump(result).includes(PLACEHOLDER), false);
  });

  it('같은 값을 넣으면 언제나 같은 답이 나온다', () => {
    for (const value of [undefined, null, '', ' ', 7, PLACEHOLDER]) {
      const first = classifyCandidateGenerationOpenAICredentialValue(value);
      const second = classifyCandidateGenerationOpenAICredentialValue(value);
      assert.deepEqual(first, second);
    }
  });
});

/* ================================================================== */
/* 4. 열쇠가 없으면 부르지 않는다                                       */
/* ================================================================== */

describe('열쇠가 없을 때', () => {
  const UNUSABLE: unknown[] = [undefined, null, '', '   ', 42, {}, []];

  it('쓸 수 없는 상태는 둘이다', () => {
    assert.deepEqual([...CREDENTIAL_UNUSABLE_STATES], ['missing', 'invalid']);
  });

  it('부를 수 없다고 답한다', () => {
    for (const value of UNUSABLE) {
      const result = preflightCandidateGenerationOpenAICredential(value);
      assert.equal(result.canCallProvider, false, String(value));
    }
  });

  it('끝나는 사유는 그 밖의 문제다', () => {
    for (const value of UNUSABLE) {
      const result = preflightCandidateGenerationOpenAICredential(value);
      assert.equal(result.canCallProvider, false);
      assert.equal(result.outcome.outcome, 'provider_error', String(value));
    }
  });

  it('부를 수 없음으로 분류하지 않는다', () => {
    // 저쪽이 흔들린 것이 아니다. 우리 쪽 설정이 빠진 것이다.
    const result = preflightCandidateGenerationOpenAICredential(undefined);
    assert.equal(result.canCallProvider, false);
    assert.notEqual(result.outcome.outcome, 'provider_unavailable');
  });

  it('시간 초과로 분류하지 않는다', () => {
    const result = preflightCandidateGenerationOpenAICredential(undefined);
    assert.equal(result.canCallProvider, false);
    assert.notEqual(result.outcome.outcome, 'provider_timeout');
  });

  it('모델의 판단으로 바꾸지 않는다', () => {
    for (const value of UNUSABLE) {
      const result = preflightCandidateGenerationOpenAICredential(value);
      assert.equal(result.canCallProvider, false);
      assert.notEqual(result.outcome.outcome, 'validated_defer');
      assert.notEqual(result.outcome.outcome, 'empty_response');
      assert.equal(dump(result).includes('needs_more_research'), false);
    }
  });

  it('결과에 사유 이름 하나뿐이다', () => {
    const result = preflightCandidateGenerationOpenAICredential(null);
    assert.equal(result.canCallProvider, false);
    assert.deepEqual(Object.keys(result.outcome), ['outcome']);
  });

  it('열쇠가 있으면 부를 수 있다고 하고, 값을 돌려주지 않는다', () => {
    const result = preflightCandidateGenerationOpenAICredential(PLACEHOLDER);

    assert.equal(result.canCallProvider, true);
    assert.equal(result.state, 'available');
    assert.deepEqual(Object.keys(result), ['state', 'canCallProvider']);
    assert.equal(dump(result).includes(PLACEHOLDER), false);
  });

  it('잘못 온 값도 결과에 실려 나가지 않는다', () => {
    const secretish = { token: PLACEHOLDER };
    const result = preflightCandidateGenerationOpenAICredential(secretish);

    assert.equal(dump(result).includes(PLACEHOLDER), false);
    assert.equal(dump(result).includes('token'), false);
  });

  it('부르지 않기로 한 약속이 전부 아니오다', () => {
    assert.deepEqual(CREDENTIAL_FAILURE_POLICY, {
      providerCallAttempted: false,
      automaticRetry: false,
      fallbackCredentialAllowed: false,
      fallbackProviderAllowed: false,
      fallbackModelAllowed: false,
      userFacingContentProduced: false,
      becomesDefer: false,
      becomesNeedsMoreResearch: false,
      becomesEmptyResponse: false,
      becomesProviderTimeout: false,
      becomesProviderUnavailable: false,
      credentialNameMayBeReported: true,
    });
  });
});

/* ================================================================== */
/* 5. 열쇠는 서버에만 있다                                              */
/* ================================================================== */

describe('열쇠를 두는 자리', () => {
  it('서버에서만 쓴다', () => {
    assert.deepEqual(CANDIDATE_GENERATION_CREDENTIAL_BOUNDARY, {
      serverOnly: true,
      browserExposureAllowed: false,
      clientBundleAllowed: false,
      clientStorageAllowed: false,
      publicAppConfigAllowed: false,
      expoPublicPrefixAllowed: false,
      dangerouslyAllowBrowser: false,
      candidateSpecificCredentialName: null,
    });
  });

  it('두지 않는 자리를 적어 두었다', () => {
    assert.ok(CREDENTIAL_NOT_STORED_IN.length >= 7);
    for (const place of CREDENTIAL_NOT_STORED_IN) {
      assert.equal(typeof place, 'string');
      assert.ok(place.length > 0);
    }
  });

  it('이 파일이 열쇠 값을 읽지 않는다', () => {
    assert.equal(BOUNDARY_SOURCE.includes('Deno.env'), false);
    assert.equal(BOUNDARY_SOURCE.includes('process.env'), false);
    assert.equal(BOUNDARY_SOURCE.includes('.env.get'), false);
    assert.equal(BOUNDARY_SOURCE.includes('getApiKey'), false);
  });

  it('열쇠 값이 갈 수 없는 곳이 전부 아니오다', () => {
    assert.deepEqual(CREDENTIAL_PRIVACY_POLICY, {
      credentialValueLogged: false,
      credentialValuePersisted: false,
      credentialValueReturnedInOutcome: false,
      credentialValueIncludedInError: false,
      credentialValueIncludedInCandidate: false,
      credentialValueIncludedInProvenance: false,
      credentialValueIncludedInProviderFailureDetail: false,
      credentialNameMayBeReported: true,
    });
  });
});

/* ================================================================== */
/* 6. 부르다 실패했을 때 무엇으로 보는가                                 */
/* ================================================================== */

describe('실패한 까닭을 옮긴다', () => {
  it('부른 쪽이 넘기는 것은 네 가지뿐이다', () => {
    assert.deepEqual([...PROVIDER_FAILURE_OBSERVATION_KINDS], [
      'timeout',
      'connection',
      'http',
      'unknown',
    ]);
  });

  it('우리가 끊었으면 시간 초과다', () => {
    assert.equal(outcomeOf({ kind: 'timeout' }), 'provider_timeout');
  });

  it('답을 받기 전에 끊겼으면 부를 수 없었던 것이다', () => {
    assert.equal(outcomeOf({ kind: 'connection' }), 'provider_unavailable');
  });

  it('알 수 없으면 그 밖의 문제로 끝낸다', () => {
    // 짐작해서 시간 초과라고 적지 않는다.
    assert.equal(outcomeOf({ kind: 'unknown' }), 'provider_error');
  });

  it('연결이 끊긴 것을 답이 비었다고 하지 않는다', () => {
    for (const kind of ['timeout', 'connection', 'unknown'] as const) {
      const outcome = outcomeOf({ kind });
      assert.notEqual(outcome, 'empty_response');
      assert.notEqual(outcome, 'response_incomplete');
      assert.notEqual(outcome, 'validated_defer');
    }
  });
});

/* ================================================================== */
/* 7. 답은 왔는데 받아들여지지 않은 경우                                 */
/* ================================================================== */

describe('상태 숫자를 옮긴다', () => {
  it('408은 시간 초과다', () => {
    assert.equal(outcomeOf(http(408)), 'provider_timeout');
  });

  it('우리가 끊은 것과 저쪽이 알려 온 것은 끝이 같다', () => {
    assert.equal(outcomeOf({ kind: 'timeout' }), outcomeOf(http(408)));
  });

  it('429는 잠시 부를 수 없는 것이다', () => {
    assert.equal(outcomeOf(http(429)), 'provider_unavailable');
  });

  it('5xx는 잠시 부를 수 없는 것이다', () => {
    for (const status of [500, 501, 502, 503, 504, 520, 599]) {
      assert.equal(outcomeOf(http(status)), 'provider_unavailable', String(status));
    }
  });

  it('열쇠·권한 문제는 그 밖의 문제다', () => {
    // 기다린다고 나아지지 않는다. 잠시 못 부르는 것으로 적으면 사람이 기다리게 된다.
    assert.equal(outcomeOf(http(401)), 'provider_error');
    assert.equal(outcomeOf(http(403)), 'provider_error');
  });

  it('그 밖의 4xx도 그 밖의 문제다', () => {
    for (const status of [400, 404, 409, 422, 405, 415]) {
      assert.equal(outcomeOf(http(status)), 'provider_error', String(status));
    }
  });

  it('401·403을 잠시 못 부르는 것으로 보지 않는다', () => {
    assert.notEqual(outcomeOf(http(401)), 'provider_unavailable');
    assert.notEqual(outcomeOf(http(403)), 'provider_unavailable');
  });

  it('409를 잠시 못 부르는 것으로 보지 않는다', () => {
    assert.notEqual(outcomeOf(http(409)), 'provider_unavailable');
  });

  it('400번대와 500번대를 뭉치지 않는다', () => {
    assert.notEqual(outcomeOf(http(400)), outcomeOf(http(500)));
  });

  it('이미 있는 규칙과 어긋나지 않는다', () => {
    // 여기서 정한 답이 저장소의 규칙과 따로 놀지 않는지 다른 길로 한 번 더 본다.
    const expected: Record<string, string> = {
      auth: 'provider_error',
      permission: 'provider_error',
      not_found: 'provider_error',
      client_error: 'provider_error',
      rate_or_quota: 'provider_unavailable',
      server_error: 'provider_unavailable',
      other: 'provider_error',
    };

    for (let status = 200; status <= 599; status += 1) {
      if (status === 408) continue;
      assert.equal(
        outcomeOf(http(status)),
        expected[classifyOpenAIHttpStatus(status)],
        String(status),
      );
    }
  });

  it('300번대나 200번대가 와도 그 밖의 문제로 끝낸다', () => {
    for (const status of [200, 204, 301, 302, 399]) {
      assert.equal(outcomeOf(http(status)), 'provider_error', String(status));
    }
  });
});

/* ================================================================== */
/* 8. 숫자가 아닌 것이 왔을 때                                          */
/* ================================================================== */

describe('상태 숫자가 온전하지 않으면', () => {
  const BROKEN: unknown[] = [
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    '429',
    '500',
    null,
    undefined,
    404.5,
    -1,
    {},
    [],
  ];

  it('뜻을 읽지 않고 그 밖의 문제로 끝낸다', () => {
    for (const status of BROKEN) {
      const observation = { kind: 'http', status } as CandidateGenerationProviderFailureObservation;
      assert.equal(outcomeOf(observation), 'provider_error', String(status));
    }
  });

  it('글자로 온 숫자를 숫자처럼 읽지 않는다', () => {
    // '429'를 429로 읽어 주기 시작하면, 어디까지 읽어 주는지 아무도 모르게 된다.
    const observation = { kind: 'http', status: '429' } as unknown as
      CandidateGenerationProviderFailureObservation;
    assert.notEqual(outcomeOf(observation), 'provider_unavailable');
  });

  it('소수를 가까운 범주로 밀어 넣지 않는다', () => {
    const observation = { kind: 'http', status: 503.2 } as CandidateGenerationProviderFailureObservation;
    assert.notEqual(outcomeOf(observation), 'provider_unavailable');
  });
});

/* ================================================================== */
/* 9. 다시 부르지 않는다                                                */
/* ================================================================== */

describe('다시 부르지 않는다', () => {
  it('다시 부르는 횟수는 0이다', () => {
    assert.equal(RUNTIME_BOUNDARY_RETRY_POLICY.automaticRetries, 0);
  });

  it('그 값의 주인은 앞 계약이다', () => {
    assert.equal(
      RUNTIME_BOUNDARY_RETRY_POLICY.automaticRetries,
      TRANSPORT_RUNTIME_CONFIG_POLICY.automaticRetries,
    );
    assert.ok(
      BOUNDARY_SOURCE.includes(
        'automaticRetries: CANDIDATE_GENERATION_RUNTIME_CONFIG.automaticRetries',
      ),
    );
  });

  it('어떤 실패에도 다시 부르지 않는다', () => {
    assert.deepEqual(RUNTIME_BOUNDARY_RETRY_POLICY, {
      automaticRetries: 0,
      fallbackModelAllowed: false,
      fallbackCredentialAllowed: false,
      fallbackProviderAllowed: false,
      retryOnTimeout: false,
      retryOnConnection: false,
      retryOnRateOrQuota: false,
      retryOnServerError: false,
      outputBudgetRaisedOnFailure: false,
    });
  });

  it('라이브러리를 쓰게 되면 그 기능을 반드시 꺼야 한다고 적어 두었다', () => {
    assert.equal(CLIENT_RETRY_OVERRIDE_REQUIREMENT.mustBeExplicitlyDisabled, true);
    assert.equal(CLIENT_RETRY_OVERRIDE_REQUIREMENT.defaultClientRetryAllowed, false);
  });

  it('여기에 다시 부르는 코드가 없다', () => {
    for (const banned of ['for (', 'while (', 'do {']) {
      assert.equal(BOUNDARY_SOURCE.includes(banned), false, banned);
    }
  });
});

/* ================================================================== */
/* 10. 기다리는 시간                                                    */
/* ================================================================== */

describe('기다리는 시간', () => {
  it('주인은 앞서 정한 설정이다', () => {
    assert.equal(
      RUNTIME_BOUNDARY_TIMEOUT_POLICY.timeoutMs,
      CANDIDATE_GENERATION_RUNTIME_CONFIG.timeoutMs,
    );
  });

  it('여기에 숫자를 다시 적지 않았다', () => {
    // 위의 비교만으로는 부족하다. 같은 숫자를 손으로 적어 두면 그 비교도 통과한다.
    for (const literal of ['60_000', '60000', '60 * 1000']) {
      assert.equal(BOUNDARY_SOURCE.includes(literal), false, literal);
    }
    assert.ok(
      BOUNDARY_SOURCE.includes('timeoutMs: CANDIDATE_GENERATION_RUNTIME_CONFIG.timeoutMs'),
    );
  });

  it('기본값에 기대지 않는다', () => {
    assert.equal(RUNTIME_BOUNDARY_TIMEOUT_POLICY.mustBeExplicitlySet, true);
    assert.equal(RUNTIME_BOUNDARY_TIMEOUT_POLICY.defaultClientTimeoutAllowed, false);
  });

  it('시간을 실제로 재는 장치는 여기 없다', () => {
    assert.equal(RUNTIME_BOUNDARY_TIMEOUT_POLICY.timeoutMechanismImplementedHere, false);
    for (const banned of ['AbortController', 'AbortSignal', 'setTimeout', 'clearTimeout']) {
      assert.equal(BOUNDARY_SOURCE.includes(banned), false, banned);
    }
  });
});

/* ================================================================== */
/* 11. 어떻게 부를지는 아직 정하지 않았다                                */
/* ================================================================== */

describe('부르는 방법', () => {
  it('이 단계에서 못 박지 않았다', () => {
    assert.equal(IMPLEMENTATION_METHOD_DISCOVERY.frozenHere, false);
    assert.equal(IMPLEMENTATION_METHOD_DISCOVERY.isFrozenAuthority, false);
  });

  it('살펴본 사실만 적어 두었다', () => {
    assert.equal(IMPLEMENTATION_METHOD_DISCOVERY.serverPrecedent, 'direct request');
    assert.equal(IMPLEMENTATION_METHOD_DISCOVERY.serverClientLibraryPrecedent, null);
    assert.equal(IMPLEMENTATION_METHOD_DISCOVERY.preferredNextCandidate, 'direct request');
  });
});

/* ================================================================== */
/* 12. 사유가 늘어나지 않았는가                                          */
/* ================================================================== */

describe('사유를 늘리지 않는다', () => {
  it('결과 사유는 여전히 열 가지다', () => {
    assert.equal(TRANSPORT_OUTCOMES.length, 10);
  });

  it('열쇠가 없다고 열한 번째 사유를 만들지 않았다', () => {
    const result = preflightCandidateGenerationOpenAICredential(undefined);
    assert.equal(result.canCallProvider, false);
    assert.ok((TRANSPORT_OUTCOMES as readonly string[]).includes(result.outcome.outcome));
  });

  it('이 계층이 내는 사유는 셋뿐이다', () => {
    const produced = new Set<string>();

    produced.add(
      (preflightCandidateGenerationOpenAICredential(undefined) as { outcome: { outcome: string } })
        .outcome.outcome,
    );
    for (const kind of ['timeout', 'connection', 'unknown'] as const) {
      produced.add(outcomeOf({ kind }));
    }
    for (let status = 200; status <= 599; status += 1) {
      produced.add(outcomeOf(http(status)));
    }

    assert.deepEqual([...produced].sort(), [...PROVIDER_FAILURE_OUTCOMES].sort());
  });

  it('거절과 오다 만 것은 여기서 다루지 않는다', () => {
    assert.equal(BOUNDARY_SOURCE.includes('model_refusal'), false);
    assert.equal(BOUNDARY_SOURCE.includes('response_incomplete'), false);
    assert.equal(BOUNDARY_SOURCE.includes('refusal'), false);
    assert.equal(BOUNDARY_SOURCE.includes('output_text'), false);

    assert.ok(
      RUNTIME_BOUNDARY_DOES_NOT_INCLUDE.some((item) => item.includes('거절')),
    );
    assert.ok(
      RUNTIME_BOUNDARY_DOES_NOT_INCLUDE.some((item) => item.includes('오다 말')),
    );
    assert.ok(TRANSPORT_FAILURE_AND_RESPONSE_SEMANTICS_ARE_SEPARATE.length > 0);
  });

  it('받은 답을 읽는 일도 하지 않는다', () => {
    assert.equal(BOUNDARY_SOURCE.includes('JSON.parse'), false);
    assert.equal(BOUNDARY_SOURCE.includes('interpretCandidateGenerationTransportPayload'), false);
    assert.equal(BOUNDARY_SOURCE.includes('buildPublishedContentCandidate'), false);
  });
});

/* ================================================================== */
/* 13. 바꿔치기 금지                                                    */
/* ================================================================== */

describe('기술적 실패를 판단으로 바꾸지 않는다', () => {
  const ALL: CandidateGenerationProviderFailureObservation[] = [
    { kind: 'timeout' },
    { kind: 'connection' },
    { kind: 'unknown' },
    http(408),
    http(429),
    http(500),
    http(503),
    http(401),
    http(409),
  ];

  it('어느 것도 못 쓰겠다는 판단이 되지 않는다', () => {
    for (const observation of ALL) {
      assert.notEqual(outcomeOf(observation), 'validated_defer', dump(observation));
      assert.notEqual(outcomeOf(observation), 'validated_generate', dump(observation));
    }
  });

  it('어느 것도 "연구 근거가 모자랍니다"가 되지 않는다', () => {
    assert.equal(BOUNDARY_SOURCE.includes('needs_more_research'), false);
    assert.equal(BOUNDARY_SOURCE.includes('validated_defer'), false);
    assert.equal(BOUNDARY_SOURCE.includes('validated_generate'), false);
  });

  it('어느 것도 답이 비었다는 뜻이 되지 않는다', () => {
    for (const observation of ALL) {
      assert.notEqual(outcomeOf(observation), 'empty_response', dump(observation));
    }
    assert.equal(BOUNDARY_SOURCE.includes('empty_response'), false);
  });

  it('너무 자주 불렀다는 답을 연구 부족으로 읽지 않는다', () => {
    assert.equal(outcomeOf(http(429)), 'provider_unavailable');
  });

  it('저쪽 서버 문제를 연구 부족으로 읽지 않는다', () => {
    assert.equal(outcomeOf(http(503)), 'provider_unavailable');
  });
});

/* ================================================================== */
/* 14. 남기지 않는다                                                    */
/* ================================================================== */

describe('남기지 않는다', () => {
  it('기록에 관한 약속이 전부 아니오다', () => {
    assert.deepEqual(RUNTIME_BOUNDARY_LOGGING_POLICY, {
      debugLoggingAllowed: false,
      rawRequestLoggingAllowed: false,
      rawResponseLoggingAllowed: false,
      credentialLoggingAllowed: false,
      providerErrorBodyPersistenceAllowed: false,
      providerErrorMessagePersistenceAllowed: false,
    });
  });

  it('실제로 기록하는 코드가 없다', () => {
    for (const banned of ['console.', 'logger', 'log(']) {
      assert.equal(BOUNDARY_SOURCE.includes(banned), false, banned);
    }
  });

  it('관찰에 담지 않는 것을 적어 두었다', () => {
    assert.ok(OBSERVATION_DOES_NOT_CARRY.length >= 6);
  });

  it('결과에는 사유 이름 하나뿐이다', () => {
    for (const observation of [
      { kind: 'timeout' } as const,
      { kind: 'connection' } as const,
      { kind: 'unknown' } as const,
      http(429),
      http(401),
    ]) {
      const result = classifyCandidateGenerationProviderFailure(observation);
      assert.deepEqual(Object.keys(result), ['outcome']);
    }
  });

  it('넘긴 관찰이 결과에 실려 나가지 않는다', () => {
    const result = classifyCandidateGenerationProviderFailure(http(429));
    assert.equal(dump(result).includes('429'), false);
    assert.equal(dump(result).includes('status'), false);
    assert.equal(dump(result).includes('http'), false);
  });
});

/* ================================================================== */
/* 15. 이 파일이 실제로 하지 않는 일                                     */
/* ================================================================== */

describe('이 파일은 부르지 않는다', () => {
  it('제공자 라이브러리를 가져오지 않는다', () => {
    for (const banned of ['new OpenAI', "from 'openai'", 'from "openai"', 'import OpenAI']) {
      assert.equal(BOUNDARY_SOURCE.includes(banned), false, banned);
    }
  });

  it('직접 부르지 않는다', () => {
    for (const banned of [
      'fetch(',
      'api.openai.com',
      'https://',
      'responses.create',
      'responses.parse',
      'XMLHttpRequest',
    ]) {
      assert.equal(BOUNDARY_SOURCE.includes(banned), false, banned);
    }
  });

  it('요청에 인증 값을 붙이지 않는다', () => {
    for (const banned of ['Authorization', 'authorization', 'Bearer']) {
      assert.equal(BOUNDARY_SOURCE.includes(banned), false, banned);
    }
  });

  it('표를 만지지 않는다', () => {
    for (const banned of ['createClient', 'supabase', 'service_role', '/rest/v1/', 'SUPABASE_']) {
      assert.equal(BOUNDARY_SOURCE.includes(banned), false, banned);
    }
  });

  it('바깥 세계를 읽지 않는다', () => {
    for (const banned of [
      'Date.now',
      'Math.random',
      'randomUUID',
      'readFile',
      'writeFile',
      'AsyncStorage',
    ]) {
      assert.equal(BOUNDARY_SOURCE.includes(banned), false, banned);
    }
  });

  it('하지 않는 일을 적어 두었다', () => {
    assert.ok(RUNTIME_BOUNDARY_DOES_NOT_INCLUDE.length >= 8);
  });
});
