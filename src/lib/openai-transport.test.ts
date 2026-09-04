/**
 * OpenAI 요청 실패의 까닭 테스트
 *
 * 실행: npm test
 *
 * production에서 1단계 요청이 두 번 실패했는데, 둘 다 원인을 증명할 수 없었다.
 * 밖으로 나가는 사유는 그대로 두고, 서버 기록에만 까닭을 남기는지 확인한다.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  OPENAI_STAGE_FAILURE_CODES,
  OPENAI_TRANSPORT_FAILURE_KINDS,
  OpenAITransportError,
  classifyOpenAITransportFailure,
  describeOpenAIStageFailure,
} from '../../supabase/functions/_shared/openai-transport.ts';
import {
  DISCOVERY_TIMEOUT_MS,
  VERIFICATION_TIMEOUT_MS,
} from '../../supabase/functions/_shared/source-harvester-execution-contract.ts';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const INDEX = '../../supabase/functions/source-harvester/index.ts';

describe('OpenAI 실패 · 까닭 가리기', () => {
  it('요청을 보내다 우리 시간 제한으로 끊기면 시간 초과다', () => {
    assert.equal(classifyOpenAITransportFailure('request', true), 'timeout');
  });

  it('요청을 보내다 그 밖의 이유로 실패하면 알 수 없음이다', () => {
    assert.equal(classifyOpenAITransportFailure('request', false), 'unknown');
  });

  it('답을 읽는 도중 시간 제한으로 끊겨도 시간 초과다', () => {
    assert.equal(classifyOpenAITransportFailure('body', true), 'timeout');
  });

  it('답을 읽지 못했고 끊긴 것도 아니면 읽을 수 없는 답이다', () => {
    assert.equal(classifyOpenAITransportFailure('body', false), 'response_invalid');
  });

  it('걸린 시간으로 시간 초과를 짐작하지 않는다', () => {
    // 설명 주석에는 실제 관측 시간이 적혀 있으므로, 주석을 뺀 코드만 본다.
    const source = read('../../supabase/functions/_shared/openai-transport.ts');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '');

    // 판정에 쓰는 것은 넘겨받은 aborted 하나뿐이다.
    assert.equal(/Date\.now|performance\.now|elapsed|setTimeout|60_000/.test(code), false);
    assert.ok(code.includes('if (aborted) return'));
  });

  it('가려낸 종류는 정해진 넷뿐이다', () => {
    assert.deepEqual([...OPENAI_TRANSPORT_FAILURE_KINDS], [
      'timeout',
      'http_error',
      'response_invalid',
      'unknown',
    ]);
    for (const stage of ['request', 'body'] as const) {
      for (const aborted of [true, false]) {
        const kind = classifyOpenAITransportFailure(stage, aborted);
        assert.ok((OPENAI_TRANSPORT_FAILURE_KINDS as readonly string[]).includes(kind));
      }
    }
  });
});

describe('OpenAI 실패 · 단계별 기록 이름', () => {
  it('1단계와 2단계의 이름이 서로 다르다', () => {
    assert.deepEqual(OPENAI_STAGE_FAILURE_CODES.discovery, {
      timeout: 'discovery_request_timeout',
      http_error: 'discovery_request_http_error',
      response_invalid: 'discovery_request_response_invalid',
      unknown: 'discovery_request_unknown_failure',
    });
    assert.deepEqual(OPENAI_STAGE_FAILURE_CODES.verification, {
      timeout: 'verification_request_timeout',
      http_error: 'verification_request_http_error',
      response_invalid: 'verification_request_response_invalid',
      unknown: 'verification_request_unknown_failure',
    });
  });

  it('종류마다 그 단계의 이름을 고른다', () => {
    for (const kind of OPENAI_TRANSPORT_FAILURE_KINDS) {
      assert.equal(
        describeOpenAIStageFailure('discovery', new OpenAITransportError(kind)),
        OPENAI_STAGE_FAILURE_CODES.discovery[kind],
      );
      assert.equal(
        describeOpenAIStageFailure('verification', new OpenAITransportError(kind)),
        OPENAI_STAGE_FAILURE_CODES.verification[kind],
      );
    }
  });

  it('모르는 값이 와도 정해진 이름 하나만 나온다', () => {
    for (const bad of [null, undefined, 'x', 42, new Error('무언가'), {}]) {
      assert.equal(
        describeOpenAIStageFailure('discovery', bad),
        'discovery_request_unknown_failure',
        String(bad),
      );
    }
  });

  it('오류에 담기는 것은 종류 이름뿐이다', () => {
    for (const kind of OPENAI_TRANSPORT_FAILURE_KINDS) {
      const error = new OpenAITransportError(kind);
      assert.equal(error.kind, kind);
      assert.equal(error.message, kind);
      assert.equal(error.name, 'OpenAITransportError');
    }
  });

  it('이름이 모두 다르고 고정 문자열이다', () => {
    const codes = [
      ...Object.values(OPENAI_STAGE_FAILURE_CODES.discovery),
      ...Object.values(OPENAI_STAGE_FAILURE_CODES.verification),
    ];
    assert.equal(new Set(codes).size, 8);
    for (const code of codes) assert.match(code, /^(discovery|verification)_request_[a-z_]+$/);
  });
});

describe('OpenAI 실패 · Edge Function이 이 규칙을 쓴다', () => {
  it('요청 실패와 답 읽기 실패 두 자리에서 같은 규칙을 쓴다', () => {
    const index = read(INDEX);
    const openai = index.split('async function callOpenAI')[1].split('\n}')[0];

    assert.equal((openai.match(/classifyOpenAITransportFailure\(/g) || []).length, 2);
    assert.ok(openai.includes("classifyOpenAITransportFailure('request'"));
    assert.ok(openai.includes("classifyOpenAITransportFailure('body'"));
  });

  it('답이 잘못된 상태에서는 본문을 열지 않는다', () => {
    const index = read(INDEX);
    const openai = index.split('async function callOpenAI')[1].split('\n}')[0];

    assert.ok(openai.includes("throw new OpenAITransportError('http_error'"));
    assert.equal(openai.includes('response.text()'), false);
    assert.equal(openai.includes('response.json()') && !openai.includes('return await response.json()'), false);
    // 예전에 상태 숫자를 오류 문구에 넣던 방식은 사라졌다.
    assert.equal(index.includes('openai_http_'), false);
  });

  it('상태 숫자는 범주로 바꾸는 데만 쓰고 어디에도 남기지 않는다', () => {
    const index = read(INDEX);
    const openai = index.split('async function callOpenAI')[1].split('\n}')[0];

    // response.status가 나오는 자리는 분류 함수의 입력 한 곳뿐이다.
    assert.equal((openai.match(/response\.status/g) || []).length, 1);
    assert.ok(openai.includes('classifyOpenAIHttpStatus(response.status)'));

    // 숫자를 문자로 바꾸거나 기록으로 내보내는 자리가 없다.
    for (const banned of [
      'String(response.status)',
      '${response.status}',
      'console.log(response.status)',
      'log(response.status)',
    ]) {
      assert.equal(openai.includes(banned), false, banned);
    }
  });

  it('표를 다루는 오류와 타입을 섞지 않는다', () => {
    const index = read(INDEX);
    // OpenAI 실패와 DB 함수 실패는 서로 다른 타입을 쓴다.
    assert.ok(index.includes('OpenAITransportError'));
    assert.ok(index.includes('RecoveryTicketRpcError'));

    // 설명 주석에 이름이 나오는 것은 참조가 아니므로 import 문으로 본다.
    const transport = read('../../supabase/functions/_shared/openai-transport.ts');
    const imports = [...transport.matchAll(/from '([^']+)'/g)].map((match) => match[1]);
    assert.deepEqual(imports, []);

    const code = transport.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '');
    assert.equal(code.includes('RecoveryTicketRpcError'), false);
  });

  it('까닭을 가리는 파일은 실행 환경을 모른다', () => {
    const transport = read('../../supabase/functions/_shared/openai-transport.ts');
    const code = transport.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '');
    for (const banned of ['Deno.env', 'fetch(', 'process.env', 'api.openai.com', '/rest/v1/']) {
      assert.equal(code.includes(banned), false, banned);
    }
  });
});

describe('OpenAI 실패 · 시간 예산은 그대로다', () => {
  it('이번에 시간 값을 바꾸지 않았다', () => {
    assert.equal(DISCOVERY_TIMEOUT_MS, 60_000);
    assert.equal(VERIFICATION_TIMEOUT_MS, 75_000);

    const index = read(INDEX);
    assert.ok(index.includes('RECOVERY_TICKET_RPC_TIMEOUT_MS = 5_000'));
    // 처음 시작하는 요청의 합은 그대로 140초다.
    assert.equal(DISCOVERY_TIMEOUT_MS + VERIFICATION_TIMEOUT_MS + 5_000, 140_000);
  });

  it('재시도를 넣지 않았다', () => {
    const index = read(INDEX);
    assert.equal(/retry|retries|attemptAgain/i.test(index), false);
  });
});
