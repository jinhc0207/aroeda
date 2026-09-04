/**
 * Biblical Researcher · 실제로 요청을 보내는 부분
 *
 * 실행 순서(biblical-researcher-runtime-contract.ts)가 "보내는 일"을 밖에서 받는다.
 * 그 자리에 끼워 넣을 실제 구현이 이 파일이다.
 *
 * 이 파일이 하는 일:
 *   요청 본문을 그대로 보낸다 → 시간을 잰다 → 답을 읽는다 → 셋 중 하나로 돌려준다.
 *
 * 이 파일이 하지 않는 일:
 *   요청 본문을 고치지 않는다.
 *     모델, 생각하는 정도, 도구, 저장 여부, 출력 한도, 응답 형식은
 *     이미 정해진 계약과 정책이 정한 것이다. 여기서 손대면 정책이 둘이 된다.
 *   기다리는 시간을 스스로 정하지 않는다. 부르는 쪽이 넘겨준 값을 그대로 쓴다.
 *   다시 부르지 않는다. 요청은 한 번뿐이다.
 *   환경변수를 읽지 않는다. 열쇠는 만들 때 받는다.
 *
 * 밖으로 내보내지 않는 것:
 *   열쇠, 머리글, 상태 숫자, 응답 본문, 원본 오류 문구.
 *   실패하면 남는 것은 "시간이 지났다" 또는 "요청이 실패했다" 둘뿐이다.
 *   오류 본문은 읽지도 않는다. 읽지 않으면 흘릴 일도 없다.
 */

import type {
  BiblicalResearchResponsesTransport,
  BiblicalResearchTransportResult,
} from './biblical-researcher-runtime-contract.ts';

/** 요청을 보내는 곳. 이 저장소의 다른 기능들과 같은 주소다. */
export const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';

export type BiblicalResearchTransportConfig = {
  /** 서버 전용 열쇠. 부르는 쪽이 넘겨준다. 이 파일은 환경변수를 읽지 않는다. */
  apiKey: string;
  /** 시험에서만 바꾼다. 실제로는 그냥 fetch를 쓴다. */
  fetchImpl?: typeof fetch;
};

/**
 * 실제로 요청을 보내는 일을 하나 만든다.
 *
 * 열쇠가 없으면 요청을 아예 보내지 않는다.
 * 무엇이 없는지는 밖으로 알리지 않는다. 실패 이름 하나만 남는다.
 *
 * 시간이 지났는지는 우리가 건 타이머가 실제로 끊었는지로만 판단한다.
 * 오류의 이름이나 걸린 시간으로 짐작하지 않는다.
 * 그래야 다른 이유로 끊긴 요청을 시간 초과로 잘못 적지 않는다.
 */
export function createBiblicalResearchResponsesTransport(
  config: BiblicalResearchTransportConfig,
): BiblicalResearchResponsesTransport {
  const doFetch = config.fetchImpl ?? fetch;

  return async (request, options): Promise<BiblicalResearchTransportResult> => {
    // 열쇠가 없으면 아무것도 보내지 않는다.
    if (typeof config.apiKey !== 'string' || config.apiKey.trim().length === 0) {
      return { ok: false, failure: 'model_transport_error' };
    }

    const controller = new AbortController();
    // 우리가 끊었는지를 우리가 들고 있는 값으로 기억한다.
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, options.timeoutMs);

    try {
      let response: Response;
      try {
        response = await doFetch(OPENAI_RESPONSES_URL, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${config.apiKey}`,
            'content-type': 'application/json',
          },
          // 실행 순서가 만든 요청 본문 그대로다. 한 항목도 더하거나 빼지 않는다.
          body: JSON.stringify(request),
          signal: controller.signal,
        });
      } catch {
        // 원본 오류 문구는 읽지도, 옮기지도 않는다.
        return { ok: false, failure: timedOut ? 'model_timeout' : 'model_transport_error' };
      }

      // 답이 오긴 했지만 정상 응답이 아니다.
      // 상태 숫자도 본문도 열지 않는다. 열지 않으면 흘릴 일이 없다.
      if (!response.ok) {
        return { ok: false, failure: 'model_transport_error' };
      }

      try {
        return { ok: true, response: await response.json() };
      } catch {
        // 답을 읽는 도중에도 시간이 넘을 수 있다.
        // 그때를 "읽을 수 없는 답"으로 적으면 원인을 잘못 짚게 된다.
        return { ok: false, failure: timedOut ? 'model_timeout' : 'model_transport_error' };
      }
    } finally {
      clearTimeout(timer);
    }
  };
}
