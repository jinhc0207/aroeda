/**
 * 후보 생성용 Analyzer 요청 본문의 단일 출처.
 *
 * 운영과 무엇이 다른가
 *   운영 `analyze-situation`은 `buildOpenAIPayload(text)`가 만든 것만 보낸다
 *   (`model`·`store`·`instructions`·`input`·`text`). 후보 생성용 분석은 여기에 다섯 가지를
 *   더 얹는다 — `max_output_tokens`, `tools`, `stream`, `background`, `truncation`. 검증용
 *   호출이므로 출력 상한을 두고, 도구·스트리밍·백그라운드·앞부분 잘라내기를 모두 막는다.
 *
 *   그래서 동결된 분석은 운영과 **같은 모델·지시문·스키마**로 만들되 **요청 설정은 다르다.**
 *   이 차이를 증거에 남기지 않으면, 설정을 바꾼 뒤에도 이전 설정으로 만든 증거가 그대로
 *   통과한다. 이 파일이 그 지문의 출처다.
 *
 * 왜 따로 두는가
 *   본문을 만드는 곳(transport)과 지문을 다시 계산하는 곳(증거 검증)이 같은 함수를 써야
 *   한다. 증거 모듈이 transport를 import하면 순환이 되므로, 양쪽이 함께 의존하는 순수
 *   계층으로 둔다. 이 파일은 네트워크·DB·파일·환경변수·시계를 읽지 않는다.
 *
 * 지문이 보장하는 것과 보장하지 않는 것
 *   보장: 우리가 **명시적으로 보낸 요청 설정**이 지금과 같다는 것. 모델 id, 지시문,
 *   Structured Output 설정, 위 다섯 가지가 모두 들어간다.
 *
 *   보장하지 않음: 같은 설정이 같은 출력을 낸다는 것(모델은 결정적이지 않다), 제공자가
 *   우리가 보내지 않은 값에 적용하는 숨은 기본값이 그대로라는 것, 그리고 실제로 그 요청을
 *   보냈다는 것. 마지막 것은 증거를 쓸 수 있는 주체가 지문을 다시 계산할 수 있으므로
 *   지문만으로는 증명되지 않는다.
 */

import { computeArtifactHash } from './automatic-scripture-catalog-contract.ts';
import { buildOpenAIPayload } from './edge-analyzer.ts';

/**
 * 운영 payload 위에 더 얹는 후보 생성 전용 설정.
 *
 * 값을 바꾸면 지문이 달라지고, 이전 설정으로 봉인한 증거는 거절된다.
 */
export const CANDIDATE_GENERATION_ANALYSIS_REQUEST_OVERRIDES = Object.freeze({
  /** 답이 중간에 끊기면 살려 쓰지 않고 버린다. 넉넉하되 끝까지 열어 두지 않는다. */
  max_output_tokens: 8_192,
  /** 검색도 함수 호출도 주지 않는다. 모델이 밖에서 근거를 더 가져오면 재현할 수 없다. */
  tools: [] as unknown[],
  /** 완성된 답 하나를 받아 검사한다. */
  stream: false,
  /** 맡겨 두고 나중에 찾아오지 않는다. */
  background: false,
  /** 들어갈 수 없으면 앞부분을 조용히 버리지 않고 끝낸다. */
  truncation: 'disabled',
});

/** 실제로 전송하는 본문. transport와 지문 계산이 같은 값을 쓴다. */
export function buildCandidateGenerationAnalysisRequest(text: string): Record<string, unknown> {
  return {
    ...buildOpenAIPayload(text),
    ...structuredClone(CANDIDATE_GENERATION_ANALYSIS_REQUEST_OVERRIDES),
  };
}

/**
 * 지문에 넣을 부분만 남긴다 — 사례 문장인 `input`만 뺀 **나머지 전부**.
 *
 * `input`은 사례마다 달라지고 이미 `cases[].text`와 최상위 지문으로 결속돼 있다. 그래서
 * 설정 지문은 문장과 무관해야 하고, 같은 설정이면 어떤 문장에서도 같은 값이 나온다.
 */
export function projectAnalysisRequestForHash(body: Record<string, unknown>): Record<string, unknown> {
  const { input: _input, ...rest } = body;
  return rest;
}

/** 지금 코드가 보내는 요청 설정의 지문. 인증 헤더·키·응답·토큰 사용량은 들어가지 않는다. */
export async function computeCandidateGenerationAnalysisRequestHash(): Promise<string> {
  return computeArtifactHash(projectAnalysisRequestForHash(buildCandidateGenerationAnalysisRequest('')));
}
