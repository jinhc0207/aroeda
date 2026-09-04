/**
 * 답이 받아들여지지 않았을 때 어느 큰 범주였는지 · 테스트
 *
 * 실행: npm test
 *
 * production v28 Request A가 3.9초 만에 다음 순서로 끝났다.
 *   discovery_request_http_error
 *   discovery_request_failed
 *
 * 시간 초과가 아닌 것까지는 알았지만 그 이상은 알 수 없었다.
 * 상태 숫자를 어디에도 남기지 않으면서 큰 범주만 남는지 확인한다.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  OPENAI_HTTP_FAILURE_CATEGORIES,
  OPENAI_HTTP_FAILURE_CODES,
  OPENAI_STAGE_FAILURE_CODES,
  OPENAI_TRANSPORT_FAILURE_KINDS,
  OpenAITransportError,
  classifyOpenAIHttpStatus,
  describeOpenAIHttpFailure,
  describeOpenAIStageFailure,
} from '../../supabase/functions/_shared/openai-transport.ts';
import { runSourceHarvest } from '../../supabase/functions/_shared/source-harvester-execution.ts';
import { buildSourceHarvestBrief } from '../../supabase/functions/_shared/source-harvester.ts';
import {
  DISCOVERY_TIMEOUT_MS,
  VERIFICATION_TIMEOUT_MS,
} from '../../supabase/functions/_shared/source-harvester-execution-contract.ts';
import { getActiveCoveredDomains } from '../../supabase/functions/_shared/research-prioritizer-edge.ts';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '');

const INDEX = '../../supabase/functions/source-harvester/index.ts';
const TRANSPORT = '../../supabase/functions/_shared/openai-transport.ts';
const EXECUTION = '../../supabase/functions/_shared/source-harvester-execution.ts';

/* ------------------------------------------------------------------ */

describe('HTTP 범주 · 상태 숫자 가르기', () => {
  it('정해진 여섯 가지뿐이다', () => {
    assert.deepEqual([...OPENAI_HTTP_FAILURE_CATEGORIES], [
      'client_error',
      'auth',
      'not_found',
      'rate_or_quota',
      'server_error',
      'other',
    ]);
  });

  it('상태 숫자마다 정해진 범주가 나온다', () => {
    const cases: [number, string][] = [
      [400, 'client_error'],
      [401, 'auth'],
      [403, 'auth'],
      [404, 'not_found'],
      [408, 'client_error'],
      [409, 'client_error'],
      [422, 'client_error'],
      [429, 'rate_or_quota'],
      [500, 'server_error'],
      [502, 'server_error'],
      [599, 'server_error'],
      [300, 'other'],
      [600, 'other'],
    ];

    for (const [status, expected] of cases) {
      assert.equal(classifyOpenAIHttpStatus(status), expected, String(status));
    }
  });

  it('좁은 규칙이 넓은 4xx보다 먼저다', () => {
    // 401·403·404·429는 모두 4xx다. 순서가 뒤바뀌면 전부 client_error가 된다.
    for (const status of [401, 403, 404, 429]) {
      assert.notEqual(classifyOpenAIHttpStatus(status), 'client_error', String(status));
    }
  });

  it('경계값이 어느 쪽에 붙는지 정해져 있다', () => {
    assert.equal(classifyOpenAIHttpStatus(399), 'other');
    assert.equal(classifyOpenAIHttpStatus(400), 'client_error');
    assert.equal(classifyOpenAIHttpStatus(499), 'client_error');
    assert.equal(classifyOpenAIHttpStatus(500), 'server_error');
    assert.equal(classifyOpenAIHttpStatus(599), 'server_error');
    assert.equal(classifyOpenAIHttpStatus(600), 'other');
  });

  it('어떤 숫자가 와도 정해진 여섯 중 하나만 나온다', () => {
    for (let status = 100; status <= 700; status += 1) {
      assert.ok(
        (OPENAI_HTTP_FAILURE_CATEGORIES as readonly string[]).includes(
          classifyOpenAIHttpStatus(status),
        ),
        String(status),
      );
    }
  });

  it('가르는 규칙이 있는 곳은 한 곳뿐이다', () => {
    // 1단계와 2단계가 각자 상태 조건을 다시 쓰지 않는다.
    const execution = stripComments(read(EXECUTION));
    const index = stripComments(read(INDEX));

    for (const source of [execution, index]) {
      assert.equal(/=== 401|=== 403|=== 404|=== 429|>= 500|<= 599/.test(source), false);
    }
    assert.equal((stripComments(read(TRANSPORT)).match(/status === 401/g) || []).length, 1);
  });
});

describe('HTTP 범주 · 오류에 담기는 것', () => {
  it('받아들여지지 않은 답일 때만 범주를 담는다', () => {
    const error = new OpenAITransportError('http_error', 'rate_or_quota');
    assert.equal(error.kind, 'http_error');
    assert.equal(error.httpCategory, 'rate_or_quota');
  });

  it('그 밖의 종류에는 범주를 붙이지 않는다', () => {
    for (const kind of ['timeout', 'response_invalid', 'unknown'] as const) {
      // 잘못 넘겨도 조용히 버린다.
      const error = new OpenAITransportError(kind, 'auth');
      assert.equal(error.httpCategory, undefined, kind);
      assert.equal(describeOpenAIHttpFailure('discovery', error), null, kind);
      assert.equal(JSON.stringify({ c: error.httpCategory }), '{}', kind);
    }
  });

  it('범주를 주지 않아도 예전처럼 만들 수 있다', () => {
    const error = new OpenAITransportError('http_error');
    assert.equal(error.httpCategory, undefined);
    assert.equal(error.kind, 'http_error');
  });

  it('오류 문구와 이름은 예전 그대로다', () => {
    for (const kind of OPENAI_TRANSPORT_FAILURE_KINDS) {
      const error = new OpenAITransportError(kind, 'server_error');
      assert.equal(error.message, kind);
      assert.equal(error.name, 'OpenAITransportError');
    }
  });

  it('오류 어디에도 상태 숫자가 없다', () => {
    const error = new OpenAITransportError('http_error', 'rate_or_quota');
    const dumped = JSON.stringify({
      message: error.message,
      name: error.name,
      kind: error.kind,
      httpCategory: error.httpCategory,
      stack: '',
    });
    for (const banned of ['429', '401', '403', '404', '500']) {
      assert.equal(dumped.includes(banned), false, banned);
    }
  });
});

describe('HTTP 범주 · 단계별 기록 이름', () => {
  it('1단계와 2단계의 이름이 서로 다르고 열두 개가 모두 다르다', () => {
    assert.deepEqual(OPENAI_HTTP_FAILURE_CODES.discovery, {
      client_error: 'discovery_http_client_error',
      auth: 'discovery_http_auth',
      not_found: 'discovery_http_not_found',
      rate_or_quota: 'discovery_http_rate_or_quota',
      server_error: 'discovery_http_server_error',
      other: 'discovery_http_other',
    });
    assert.deepEqual(OPENAI_HTTP_FAILURE_CODES.verification, {
      client_error: 'verification_http_client_error',
      auth: 'verification_http_auth',
      not_found: 'verification_http_not_found',
      rate_or_quota: 'verification_http_rate_or_quota',
      server_error: 'verification_http_server_error',
      other: 'verification_http_other',
    });

    const codes = [
      ...Object.values(OPENAI_HTTP_FAILURE_CODES.discovery),
      ...Object.values(OPENAI_HTTP_FAILURE_CODES.verification),
    ];
    assert.equal(new Set(codes).size, 12);
  });

  it('이름에 상태 숫자가 들어가지 않는다', () => {
    const codes = [
      ...Object.values(OPENAI_HTTP_FAILURE_CODES.discovery),
      ...Object.values(OPENAI_HTTP_FAILURE_CODES.verification),
    ];
    for (const code of codes) {
      assert.match(code, /^(discovery|verification)_http_[a-z_]+$/);
      assert.equal(/\d/.test(code), false, code);
    }
    // 숫자가 붙은 이름은 어디에도 없다.
    // 설명 주석에는 "만들지 않는다"는 예시가 적혀 있으므로 주석을 뺀 코드만 본다.
    assert.equal(/_http_\d/.test(stripComments(read(TRANSPORT))), false);
  });

  it('범주마다 그 단계의 이름을 고른다', () => {
    for (const category of OPENAI_HTTP_FAILURE_CATEGORIES) {
      const error = new OpenAITransportError('http_error', category);
      assert.equal(
        describeOpenAIHttpFailure('discovery', error),
        OPENAI_HTTP_FAILURE_CODES.discovery[category],
      );
      assert.equal(
        describeOpenAIHttpFailure('verification', error),
        OPENAI_HTTP_FAILURE_CODES.verification[category],
      );
    }
  });

  it('받아들여지지 않은 답이 아니면 아무 이름도 주지 않는다', () => {
    for (const kind of ['timeout', 'response_invalid', 'unknown'] as const) {
      assert.equal(describeOpenAIHttpFailure('discovery', new OpenAITransportError(kind)), null);
    }
    assert.equal(describeOpenAIHttpFailure('discovery', new OpenAITransportError('http_error')), null);

    for (const bad of [null, undefined, 'x', 42, new Error('무언가'), {}]) {
      assert.equal(describeOpenAIHttpFailure('discovery', bad), null, String(bad));
    }
  });

  it('기존 단계별 이름은 그대로 남는다', () => {
    // 이번 변경이 기존 코드를 대체하지 않는다.
    const error = new OpenAITransportError('http_error', 'auth');
    assert.equal(describeOpenAIStageFailure('discovery', error), 'discovery_request_http_error');
    assert.equal(describeOpenAIStageFailure('verification', error), 'verification_request_http_error');
    assert.deepEqual(OPENAI_STAGE_FAILURE_CODES.discovery, {
      timeout: 'discovery_request_timeout',
      http_error: 'discovery_request_http_error',
      response_invalid: 'discovery_request_response_invalid',
      unknown: 'discovery_request_unknown_failure',
    });
  });
});

/* ------------------------------------------------------------------ */
/* 전체 실행                                                            */
/* ------------------------------------------------------------------ */

const brief = () =>
  buildSourceHarvestBrief({
    targetDomain: 'financial_hardship',
    evidenceVersion: 4,
    prioritizerSnapshotId: `snap_${'a'.repeat(64)}`,
    activeCoveredDomains: getActiveCoveredDomains(),
  });

const url = (index: number) => `https://sources.example.org/aroeda/fixture-${index}`;
const urls = (count: number) => Array.from({ length: count }, (_, index) => url(index));

const discoveryResponse = () => ({
  status: 'completed',
  output: [
    {
      type: 'web_search_call',
      status: 'completed',
      action: {
        type: 'search',
        query: '생계 어려움 성경 연구',
        sources: urls(10).map((item) => ({ type: 'url', url: item })),
      },
    },
  ],
});

const runWith = async (options: {
  discoveryThrows?: unknown;
  verificationThrows?: unknown;
}) => {
  const calls = { discovery: 0, verification: 0, ticket: 0 };
  const logged: string[] = [];

  const outcome = await runSourceHarvest(brief(), {
    callDiscovery: async () => {
      calls.discovery += 1;
      if (options.discoveryThrows) throw options.discoveryThrows;
      return discoveryResponse();
    },
    callVerification: async () => {
      calls.verification += 1;
      if (options.verificationThrows) throw options.verificationThrows;
      return {};
    },
    now: () => new Date('2026-09-02T00:00:00.000Z'),
    log: (reason) => logged.push(reason),
    createRecoveryTicket: async () => {
      calls.ticket += 1;
      return '00000000-0000-4000-8000-000000000000';
    },
  });

  return { outcome, calls, logged };
};

describe('HTTP 범주 · 1단계 전체 실행', () => {
  it('좁은 것부터 넓은 것 순서로 세 줄을 남긴다', async () => {
    const cases: [string, 'auth' | 'rate_or_quota' | 'server_error'][] = [
      ['discovery_http_auth', 'auth'],
      ['discovery_http_rate_or_quota', 'rate_or_quota'],
      ['discovery_http_server_error', 'server_error'],
    ];

    for (const [expected, category] of cases) {
      const { outcome, calls, logged } = await runWith({
        discoveryThrows: new OpenAITransportError('http_error', category),
      });

      assert.deepEqual(
        logged,
        [expected, 'discovery_request_http_error', 'discovery_request_failed'],
        category,
      );
      assert.equal(calls.discovery, 1, category);
      assert.equal(calls.verification, 0, category);
      assert.equal(calls.ticket, 0, category);

      assert.equal(outcome.status, 'recheck', category);
      if (outcome.status !== 'recheck') return;
      assert.equal(outcome.reason, 'discovery_request_failed', category);
      assert.deepEqual(Object.keys(outcome).sort(), ['reason', 'status'], category);
    }
  });

  it('받아들여지지 않은 답이 아니면 예전처럼 두 줄이다', async () => {
    const cases: [string, unknown][] = [
      ['discovery_request_timeout', new OpenAITransportError('timeout')],
      ['discovery_request_response_invalid', new OpenAITransportError('response_invalid')],
      ['discovery_request_unknown_failure', new OpenAITransportError('unknown')],
      ['discovery_request_unknown_failure', new Error('그 밖의 오류')],
    ];

    for (const [expected, thrown] of cases) {
      const { logged } = await runWith({ discoveryThrows: thrown });
      assert.deepEqual(logged, [expected, 'discovery_request_failed'], expected);
    }
  });
});

describe('HTTP 범주 · 2단계 전체 실행', () => {
  it('좁은 것부터 넓은 것 순서로 세 줄을 남긴다', async () => {
    const cases: [string, 'auth' | 'rate_or_quota' | 'server_error'][] = [
      ['verification_http_auth', 'auth'],
      ['verification_http_rate_or_quota', 'rate_or_quota'],
      ['verification_http_server_error', 'server_error'],
    ];

    for (const [expected, category] of cases) {
      const { outcome, calls, logged } = await runWith({
        verificationThrows: new OpenAITransportError('http_error', category),
      });

      assert.deepEqual(
        logged,
        [expected, 'verification_request_http_error', 'verification_request_failed'],
        category,
      );
      assert.equal(calls.discovery, 1, category);
      assert.equal(calls.verification, 1, category);
      assert.equal(calls.ticket, 0, category);

      assert.equal(outcome.status, 'recheck', category);
      if (outcome.status !== 'recheck') return;
      assert.equal(outcome.reason, 'verification_request_failed', category);
      assert.deepEqual(Object.keys(outcome).sort(), ['reason', 'status'], category);
    }
  });

  it('받아들여지지 않은 답이 아니면 예전처럼 두 줄이다', async () => {
    const { logged } = await runWith({
      verificationThrows: new OpenAITransportError('timeout'),
    });
    assert.deepEqual(logged, ['verification_request_timeout', 'verification_request_failed']);
  });
});

describe('HTTP 범주 · 아무것도 새지 않는다', () => {
  it('원본 오류에 무엇이 들어 있어도 기록에는 세 이름뿐이다', async () => {
    class LeakyError extends OpenAITransportError {
      readonly body = 'SUPER_SECRET_OPENAI_BODY';
      readonly detail = 'SUPER_SECRET_NETWORK_MESSAGE';
      readonly status = 429;
      readonly endpoint = 'https://api.openai.com/v1/responses';
      readonly apiKey = 'sk-SUPER_SECRET_KEY';
    }

    const { outcome, logged } = await runWith({
      discoveryThrows: new LeakyError('http_error', 'rate_or_quota'),
    });

    assert.deepEqual(logged, [
      'discovery_http_rate_or_quota',
      'discovery_request_http_error',
      'discovery_request_failed',
    ]);

    const dumped = JSON.stringify({ outcome, logged });
    for (const banned of [
      'SUPER_SECRET_OPENAI_BODY',
      'SUPER_SECRET_NETWORK_MESSAGE',
      'sk-SUPER_SECRET_KEY',
      'api.openai.com',
      '429',
      '401',
      '500',
    ]) {
      assert.equal(dumped.includes(banned), false, banned);
    }
  });

  it('Edge Function은 실패한 답의 본문을 열지 않는다', () => {
    const openai = stripComments(read(INDEX))
      .split('async function callOpenAI')[1]
      .split('\n}')[0];

    assert.equal(openai.includes('response.text()'), false);
    // 본문을 읽는 자리는 성공했을 때 한 곳뿐이다.
    assert.equal((openai.match(/response\.json\(\)/g) || []).length, 1);
    assert.ok(openai.includes('return await response.json();'));

    // 상태 숫자를 쓰는 자리도 분류 함수 입력 한 곳뿐이다.
    assert.equal((openai.match(/response\.status/g) || []).length, 1);
    assert.ok(openai.includes('classifyOpenAIHttpStatus(response.status)'));
  });

  it('범주를 가리는 파일은 실행 환경을 모른다', () => {
    const code = stripComments(read(TRANSPORT));
    for (const banned of ['Deno.env', 'fetch(', 'process.env', 'api.openai.com', '/rest/v1/']) {
      assert.equal(code.includes(banned), false, banned);
    }
    assert.deepEqual([...code.matchAll(/from '([^']+)'/g)].map((m) => m[1]), []);
  });
});

describe('HTTP 범주 · 이어서 하는 요청(Request B)은 그대로다', () => {
  it('병렬 실행 쪽은 새 범주를 알지 못한다', () => {
    const code = stripComments(
      read('../../supabase/functions/_shared/source-harvester-parallel-recovery-execution.ts'),
    );
    for (const banned of [
      'httpCategory',
      'classifyOpenAIHttpStatus',
      'describeOpenAIHttpFailure',
      '_http_',
    ]) {
      assert.equal(code.includes(banned), false, banned);
    }
  });

  it('Edge Function 공개 응답에도 새 범주가 없다', () => {
    for (const path of ['handler.ts', 'index.ts']) {
      const code = stripComments(read(`../../supabase/functions/source-harvester/${path}`));
      assert.equal(code.includes('describeOpenAIHttpFailure'), false, path);
      assert.equal(/httpCategory\s*[,:]/.test(code), false, path);
      assert.equal(code.includes('_http_client_error'), false, path);
    }
  });

  it('새 이름을 기록으로 내보내는 자리는 실행 본체 두 곳뿐이다', () => {
    const execution = stripComments(read(EXECUTION));
    assert.equal((execution.match(/describeOpenAIHttpFailure\(/g) || []).length, 2);
    assert.ok(execution.includes("describeOpenAIHttpFailure('discovery', error)"));
    assert.ok(execution.includes("describeOpenAIHttpFailure('verification', error)"));
    // 공개 결과에는 붙지 않는다.
    assert.equal(execution.includes('httpCategory'), false);
  });

  it('2단계 초안 범주(v28)는 건드리지 않았다', () => {
    const execution = stripComments(read(EXECUTION));

    // 응답 읽기·초안 검사 쪽 기록은 예전 그대로 두 자리다.
    assert.equal((execution.match(/log\((parsed|checked)\.diagnostic\)/g) || []).length, 2);

    // v28의 아홉 범주가 그대로 있다.
    for (const code of [
      'verification_invalid_response_shape',
      'verification_invalid_output_text',
      'verification_invalid_json',
      'verification_invalid_draft_shape',
      'verification_invalid_banned_field',
      'verification_invalid_provenance',
      'verification_invalid_source_metadata',
      'verification_invalid_rejected_source',
      'verification_invalid_unresolved_questions',
    ]) {
      assert.ok(execution.includes(code), code);
    }

    // 두 진단이 서로 섞이지 않는다. 초안 쪽 범주에는 HTTP 이름이 붙지 않는다.
    assert.equal(/verification_invalid_[a-z_]*http/.test(execution), false);
    assert.equal(/_http_[a-z_]*invalid/.test(execution), false);
  });
});

describe('HTTP 범주 · 시간 예산은 그대로다', () => {
  it('이번에도 시간 값을 바꾸지 않았다', () => {
    assert.equal(DISCOVERY_TIMEOUT_MS, 60_000);
    assert.equal(VERIFICATION_TIMEOUT_MS, 75_000);
    assert.ok(read(INDEX).includes('RECOVERY_TICKET_RPC_TIMEOUT_MS = 5_000'));
  });

  it('재시도를 넣지 않았다', () => {
    assert.equal(/retry|retries|attemptAgain/i.test(read(INDEX)), false);
    assert.equal(/retry|retries|attemptAgain/i.test(read(TRANSPORT)), false);
  });
});
