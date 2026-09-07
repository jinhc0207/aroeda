/**
 * Candidate Generation · 실제로 요청을 보내는 자리.
 *
 * 앞 계층들이 전부 준비됐다.
 *   보낼 것은 Adapter가 만들었다.
 *   손질하는 방법(Fetch Transport Contract)과 실패를 가르는 규칙(Runtime Boundary)도 정해졌다.
 *
 * 이 파일이 하는 일은 그것들을 실제로 잇는 것뿐이다.
 *   열쇠가 쓸 수 있는지 본다 → 보낸다 → 시간을 잰다 → 받는다
 *   → 글 담는 자리를 채운다 → Adapter에게 넘긴다.
 *
 * 새 규칙을 만들지 않는다.
 *   상태 숫자가 무슨 뜻인지, 답이 거절인지, 계약을 지켰는지 —
 *   전부 이미 주인이 있고, 여기서는 그 주인을 부를 뿐이다.
 *
 * 이 파일이 하지 않는 일:
 *   환경변수를 읽지 않는다. 열쇠는 부르는 쪽이 넘긴다.
 *   보낼 것을 고치지 않는다. Adapter가 만든 것을 그대로 보낸다.
 *   다시 부르지 않는다. 한 번 실패하면 그것으로 끝낸다.
 *   받아들여지지 않은 답의 본문을 읽지 않는다.
 */

import {
  preflightCandidateGenerationOpenAICredential,
} from './published-content-candidate-generation-openai-runtime-boundary.ts';
import {
  PROVIDER_PROTOCOL,
  classifyCandidateGenerationFetchFailure,
  normalizeCandidateGenerationOpenAIHttpResponseForAdapter,
  type CandidateGenerationFetchTransportRequest,
} from './published-content-candidate-generation-openai-fetch-transport-contract.ts';
import {
  interpretCandidateGenerationOpenAIResponse,
} from './published-content-candidate-generation-openai-adapter-contract.ts';
import type { CandidateGenerationTransportOutcome } from './published-content-candidate-generation-transport-contract.ts';
import type { CandidateModelGenerationInput } from './published-content-candidate-generation-contract.ts';

/**
 * 요청을 보내는 곳.
 *
 * 이 저장소의 다른 기능들과 같은 주소다.
 * 여기서 정하지 않기로 한 곳(Fetch Transport Contract)이 아니라
 * 실제로 보내는 이 자리에서 정한다.
 */
export const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';

export type CandidateGenerationFetchTransportConfig = {
  /**
   * 서버 전용 열쇠.
   *
   * 값 자체를 검사하지 않는다. 쓸 수 있는지는 Runtime Boundary의 preflight가 판단한다.
   * 여기서 새로 sk- 접두어나 길이를 검사하지 않는다.
   */
  apiKey: unknown;
  /** 시험에서만 바꾼다. 실제로는 그냥 fetch를 쓴다. */
  fetchImpl?: typeof fetch;
};

/**
 * Candidate 전용 OpenAI Responses API 요청을 한 번 보낸다.
 *
 * 열쇠가 쓸 수 없으면 아예 보내지 않는다. 몇 번을 불러도 한 번도 나가지 않는다.
 *
 * 시간이 지났는지는 우리가 건 타이머가 실제로 끊었는지로만 판단한다.
 * 답을 다 읽을 때까지 그 표시를 들고 있는다.
 */
export async function callCandidateGenerationOpenAIFetchTransport(
  requestSpec: CandidateGenerationFetchTransportRequest,
  input: CandidateModelGenerationInput,
  config: CandidateGenerationFetchTransportConfig,
): Promise<CandidateGenerationTransportOutcome> {
  const preflight = preflightCandidateGenerationOpenAICredential(config.apiKey);

  if (!preflight.canCallProvider) {
    return preflight.outcome;
  }

  // preflight가 'available'을 돌려준 것은 문자열이고 비어 있지 않다는 뜻이다.
  // 그 판단을 여기서 다시 하지 않는다.
  const apiKey = config.apiKey as string;
  const doFetch = config.fetchImpl ?? fetch;

  const controller = new AbortController();
  // 우리가 끊었는지를 우리가 들고 있는 값으로 기억한다. 끊겼다는 표시만으로는 알 수 없다.
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, requestSpec.timeoutMs);

  try {
    let response: Response;
    try {
      response = await doFetch(OPENAI_RESPONSES_URL, {
        method: PROVIDER_PROTOCOL.method,
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': PROVIDER_PROTOCOL.contentType,
        },
        // Adapter가 만든 것 그대로. 여기서 항목을 더하거나 빼거나 바꾸지 않는다.
        body: JSON.stringify(requestSpec.body),
        signal: controller.signal,
      });
    } catch {
      // 원본 오류 문구는 읽지도, 옮기지도 않는다.
      return classifyCandidateGenerationFetchFailure({ stage: 'fetch_rejected', timedOut });
    }

    if (!response.ok) {
      // 본문을 열지 않는다. 열지 않으면 흘릴 일도 없다.
      return classifyCandidateGenerationFetchFailure({ stage: 'http_not_ok', status: response.status });
    }

    let raw: unknown;
    try {
      raw = await response.json();
    } catch {
      // 답을 읽는 도중에도 시간이 넘을 수 있다.
      // 이것은 모델이 쓴 글을 읽지 못한 것과 다른 일이다. 같은 사유로 적지 않는다.
      return classifyCandidateGenerationFetchFailure({ stage: 'body_read_failed', timedOut });
    }

    // 라이브러리를 쓰지 않아 비어 있는 자리를 이미 있는 함수로 채운다. 새로 훑지 않는다.
    const normalized = normalizeCandidateGenerationOpenAIHttpResponseForAdapter(raw);

    // 뜻을 읽는 일은 전부 Adapter의 몫이다. 여기서 다시 판단하지 않는다.
    return interpretCandidateGenerationOpenAIResponse(normalized, input);
  } finally {
    clearTimeout(timer);
  }
}
