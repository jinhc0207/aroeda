/**
 * 내부 전용 기능의 호출 자격 확인
 *
 * 앱 사용자가 부르는 기능이 아니라, 서버가 서버를 부를 때 쓰는 확인 방법이다.
 *
 * 토큰 값을 문자열로 바로 비교하지 않는다.
 * 각각의 SHA-256 지문을 만들어 고정 길이로 비교하고, 다른 위치를 찾아도 일찍 멈추지 않는다.
 * 비교에 걸리는 시간으로 토큰을 조금씩 알아내는 일을 막기 위해서다.
 *
 * 토큰 값은 어디에도 남기지 않는다. 이 파일은 로그를 쓰지 않는다.
 * 실행 환경에 묶인 코드(Deno.env, 네트워크)는 넣지 않는다. 값은 부르는 쪽이 넘겨준다.
 */

/** 내부 호출에 쓰는 헤더 이름 */
export const INTERNAL_TOKEN_HEADER = 'x-internal-token';

/** 문자열을 SHA-256 32바이트로 만든다. 길이가 달라도 비교 시간이 같아지도록 한다. */
export async function digestSha256(value: string): Promise<Uint8Array> {
  const bytes = new TextEncoder().encode(value);
  return new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
}

/** 두 바이트 배열을 처음부터 끝까지 모두 훑어 비교한다. 다른 위치를 찾아도 일찍 멈추지 않는다. */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) {
    diff |= a[index] ^ b[index];
  }
  return diff === 0;
}

/**
 * 토큰이 맞는지 확인한다.
 *
 * 서버에 기대하는 토큰 자체가 없으면 어떤 요청도 통과시키지 않는다(fail-closed).
 * 요청이 토큰을 보내지 않아도 통과시키지 않는다.
 */
export async function isInternalTokenValid(
  expected: string | undefined | null,
  provided: string | undefined | null,
): Promise<boolean> {
  if (typeof expected !== 'string' || expected.trim().length === 0) return false;
  if (typeof provided !== 'string' || provided.length === 0) return false;

  const [expectedDigest, providedDigest] = await Promise.all([
    digestSha256(expected),
    digestSha256(provided),
  ]);

  return constantTimeEqual(expectedDigest, providedDigest);
}

/** 요청 헤더에서 토큰을 꺼내 확인한다. */
export async function isAuthorizedInternalRequest(
  request: Request,
  expected: string | undefined | null,
): Promise<boolean> {
  return isInternalTokenValid(expected, request.headers.get(INTERNAL_TOKEN_HEADER));
}
