/**
 * 내부 Edge Function 토큰 검사 회귀 테스트
 *
 * 실제 Supabase를 호출하지 않고 순수 인증 helper만 확인한다.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  INTERNAL_TOKEN_HEADER,
  constantTimeEqual,
  isAuthorizedInternalRequest,
  isInternalTokenValid,
} from '../../supabase/functions/_shared/internal-auth.ts';

const EXPECTED_TOKEN = 'fixture-internal-token-0123456789';

describe('내부 Edge Function 토큰 검사', () => {
  it('서버의 기대 토큰이 없거나 공백뿐이면 모든 요청을 막는다', async () => {
    for (const expected of [undefined, null, '', ' ', '\t\n']) {
      assert.equal(await isInternalTokenValid(expected, EXPECTED_TOKEN), false);
    }
  });

  it('요청 토큰이 없거나 빈 문자열이면 막는다', async () => {
    for (const provided of [undefined, null, '']) {
      assert.equal(await isInternalTokenValid(EXPECTED_TOKEN, provided), false);
    }
  });

  it('정확히 같은 토큰만 허용하고 공백을 임의로 정규화하지 않는다', async () => {
    assert.equal(await isInternalTokenValid(EXPECTED_TOKEN, EXPECTED_TOKEN), true);
    assert.equal(await isInternalTokenValid(EXPECTED_TOKEN, `${EXPECTED_TOKEN}-wrong`), false);
    assert.equal(await isInternalTokenValid(EXPECTED_TOKEN, ` ${EXPECTED_TOKEN}`), false);
    assert.equal(await isInternalTokenValid(` ${EXPECTED_TOKEN}`, ` ${EXPECTED_TOKEN}`), true);
  });

  it('고정 길이 바이트 비교는 같은 값만 허용한다', () => {
    assert.equal(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3])), true);
    assert.equal(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4])), false);
    assert.equal(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2])), false);
  });

  it('정해진 헤더의 정확한 토큰만 요청으로 인정한다', async () => {
    const request = (token?: string) => new Request('https://example.test/internal', {
      method: 'POST',
      headers: token === undefined ? undefined : { [INTERNAL_TOKEN_HEADER]: token },
    });

    assert.equal(await isAuthorizedInternalRequest(request(EXPECTED_TOKEN), EXPECTED_TOKEN), true);
    assert.equal(await isAuthorizedInternalRequest(request('wrong-token'), EXPECTED_TOKEN), false);
    assert.equal(await isAuthorizedInternalRequest(request(), EXPECTED_TOKEN), false);
    assert.equal(await isAuthorizedInternalRequest(request(EXPECTED_TOKEN), undefined), false);
  });

  it('공용 helper는 실행 환경이나 로그에 토큰을 넘기지 않는다', () => {
    const source = readFileSync(
      new URL('../../supabase/functions/_shared/internal-auth.ts', import.meta.url),
      'utf8',
    ).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '');

    for (const forbidden of ['Deno.env', 'process.env', 'console.', 'JSON.stringify']) {
      assert.equal(source.includes(forbidden), false, `${forbidden} 사용이 발견됐습니다.`);
    }
  });
});
