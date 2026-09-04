/**
 * Biblical Researcher 실행 정책 (값만 정한다)
 *
 * 무엇을 정하는가:
 *   어느 모델을 쓸 것인가, 얼마나 생각하게 할 것인가,
 *   얼마나 기다릴 것인가, 얼마나 쓸 것인가, 실패하면 어떻게 할 것인가.
 *
 * 무엇을 하지 않는가:
 *   요청을 만들지 않는다. 보내지 않는다. 답을 읽지 않는다.
 *   네트워크, DB, 환경변수를 모른다.
 *
 * 왜 값을 따로 두는가:
 *   실행 계약(biblical-researcher-execution-contract.ts)은
 *   "무엇을 보여주고 무엇을 받을 것인가"를 정한다.
 *   그 계약은 어느 모델을 쓰는지 몰라도 성립한다.
 *   그래서 모델·시간·비용 정책만 이 파일에 모은다.
 *
 * 같은 값의 주인이 둘이 되지 않게 한다.
 *   도구 없음, 요청 한 번, 저장하지 않음은 실행 계약이 주인이다.
 *   여기서는 그대로 가져다 쓴다.
 */

import {
  BIBLICAL_RESEARCH_EXPECTED_MODEL_CALLS,
  BIBLICAL_RESEARCH_STORE,
  BIBLICAL_RESEARCH_TOOLS,
} from './biblical-researcher-execution-contract.ts';

// 도구 없음, 요청 한 번, 저장하지 않음은 실행 계약이 정한다.
// 여기서 다시 정의하지 않는다. 가져다 쓰기만 한다.
export {
  BIBLICAL_RESEARCH_EXPECTED_MODEL_CALLS,
  BIBLICAL_RESEARCH_STORE,
  BIBLICAL_RESEARCH_TOOLS,
};

/**
 * 어느 API를 쓰는가.
 *
 * 형식이 정해진 답과 생각하는 정도를 함께 쓰려면 이 계열이어야 한다.
 * 다른 계열로 물러나는 길은 두지 않는다.
 *
 * 여기서 정하는 것은 계열 하나뿐이다. 실제 요청은 만들지 않는다.
 */
export const BIBLICAL_RESEARCH_API_FAMILY = 'responses' as const;

/**
 * 쓰는 모델.
 *
 * 이 단계는 분류나 잦은 처리가 아니다.
 * 이미 확인된 여러 자료와 근거를 함께 읽고
 * 본문의 문맥, 성경 전체에서의 자리, 교리적 적합성, 목회적 적용,
 * 오용 위험, 기존 영역과의 구별을 한 번에 판단해야 한다.
 *
 * 그래서 복합적인 전문 작업을 위한 모델을 쓴다.
 * 다른 단계가 쓰는 모델을 "비슷한 일이니까"로 가져오지 않는다.
 */
export const BIBLICAL_RESEARCH_MODEL = 'gpt-5.6-sol' as const;

/**
 * 얼마나 생각하게 할 것인가.
 *
 * 균형점에서 시작한다.
 * 아직 실제 연구 사례로 medium과 high를 견주어 본 적이 없다.
 * 근거 없이 처음부터 높이지 않는다.
 */
export const BIBLICAL_RESEARCH_REASONING_EFFORT = 'medium' as const;

/**
 * 한 번의 요청에서 모델이 쓸 수 있는 최대 출력량.
 *
 * 이 값은 눈에 보이는 답변과 모델이 속으로 생각하는 부분을 함께 센다.
 *
 * 연구 결과에는 후보 3~7개와 제외 1~5개가 들어가고,
 * 후보마다 문맥·신학적 기여·영역 적합·목회적 쓰임·오용 위험·구별·근거가 붙는다.
 * 너무 작게 잡으면 형식이 맞는 답이 중간에 끊긴다.
 *
 * 끊긴 답은 살려 쓰지 않고 버린다. 그래서 넉넉하되 끝까지 열어 두지는 않는다.
 */
export const BIBLICAL_RESEARCH_MAX_OUTPUT_TOKENS = 16_000;

/**
 * 모델 요청 하나를 기다리는 시간.
 *
 * 도구도 웹 검색도 없는 한 번의 요청이다.
 * 이 시간이 지나고 나서도 답을 읽고, 검사하고, 근거에 묶고,
 * 돌려줄 답을 꾸밀 시간이 남아야 한다.
 *
 * 다른 단계의 시간 값을 옮겨 오지 않았다. 이 단계의 값이다.
 * 전체 요청 예산은 실제 실행을 만들 때 따로 계산한다.
 */
export const BIBLICAL_RESEARCH_MODEL_TIMEOUT_MS = 90_000;

/**
 * 다시 부르지 않는다.
 *
 * 요청은 한 번이다. 실패하면 실패로 끝낸다.
 * 자동으로 다시 부르면 비용이 두 배가 되고,
 * 무엇보다 서로 다른 연구 결과가 조용히 바뀌어 들어올 수 있다.
 */
export const BIBLICAL_RESEARCH_RETRY_COUNT = 0;

/** 답이 길어져도 잘라 이어 붙이지 않는다. 끊긴 답은 쓰지 않는다. */
export const BIBLICAL_RESEARCH_TRUNCATION = 'disabled' as const;

/** 형식이 정해진 답만 받는다. 형식 자체는 BIBLICAL_RESEARCH_SCHEMA가 주인이다. */
export const BIBLICAL_RESEARCH_REQUIRES_STRUCTURED_OUTPUT = true;

/* ------------------------------------------------------------------ */
/* 실패의 종류                                                          */
/* ------------------------------------------------------------------ */

/**
 * 어디에서 실패했는지 가리는 이름.
 *
 * 밖으로 내보내려고 만든 것이 아니다.
 * 서버가 어느 경계에서 멈췄는지 결정적으로 구분하기 위한 것이다.
 * 원본 오류 문구, 응답 본문, 상태 숫자를 여기에 담지 않는다.
 *
 * 실행을 만들 때 이 목록 밖의 이름을 새로 지어내지 않는다.
 */
export const BIBLICAL_RESEARCH_FAILURES = [
  /** 정해진 시간 안에 답이 오지 않았다 */
  'model_timeout',
  /** 요청 자체가 실패했다 (연결, 전송) */
  'model_transport_error',
  /** 답은 왔지만 정상 완료가 아니었다 */
  'model_non_success',
  /** 모델이 답하기를 거절했다 (hasRefusal) */
  'model_refusal',
  /** 답이 중간에 끊겼다. 부분을 살려 쓰지 않는다 */
  'model_incomplete',
  /** 답에서 본문을 꺼낼 수 없었다 (extractOutputText) */
  'model_output_missing',
  /** 본문을 JSON으로 읽을 수 없었다 */
  'model_output_invalid_json',
  /** JSON은 읽혔지만 초안의 약속과 달랐다 */
  'model_draft_invalid',
  /** 초안을 실제 근거에 묶지 못했다 (bindBiblicalResearchEvidence) */
  'evidence_binding_failed',
] as const;

export type BiblicalResearchFailure = (typeof BIBLICAL_RESEARCH_FAILURES)[number];

/**
 * 실패했을 때 하지 않는 일.
 *
 * 아래 어느 경우든 연구 결과를 만들지 않는다.
 * 이 목록은 글로만 있는 약속이 아니라, 실행을 만들 때 지켜야 할 경계다.
 */
export const BIBLICAL_RESEARCH_FAIL_CLOSED_RULES: readonly string[] = [
  '실패하면 연구 결과를 만들지 않는다. 일부만 돌려주지 않는다.',
  '끊긴 답에서 후보 몇 개만 건져 쓰지 않는다.',
  '근거가 맞지 않는 후보를 서버가 고쳐서 통과시키지 않는다.',
  '근거 번호를 다른 것으로 바꾸어 맞추지 않는다.',
  '같은 요청을 다시 부르지 않는다.',
  '다른 모델로 바꾸어 다시 부르지 않는다.',
  '생각하는 정도를 높여 다시 부르지 않는다.',
  '근거에 묶지 못한 결과를 최종 결과로 돌려주지 않는다.',
];

/**
 * 이 값들을 언제 다시 볼 것인가.
 *
 * 지금 바꾸지 않는다. 실제 실행에서 아래가 확인될 때 다시 논의한다.
 */
export const BIBLICAL_RESEARCH_POLICY_REVISION_TRIGGERS: readonly string[] = [
  '정상적인 후보 수의 답이 출력 한도 때문에 자꾸 끊긴다.',
  '생각하는 부분이 출력 한도의 대부분을 쓴다.',
  '형식이 맞는 답이 끝까지 나오는 비율이 낮다.',
  '같은 사례에서 medium이 본문 문맥·근거 귀속·역할·안전 판단을 반복해서 그르치고, high가 실제로 나아진다.',
  '같은 근거 꾸러미에서 다른 모델이 계약 준수·주해 품질·신학적 적합·목회적 안전·근거 충실도에서 실질적으로 같다고 확인된다.',
];
