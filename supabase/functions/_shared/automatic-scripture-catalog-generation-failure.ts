/**
 * 후보 생성 실행의 실패 분류.
 *
 * 왜 따로 두는가
 *   시간 제한 모듈과 요청 계약 모듈이 함께 이 타입을 쓴다. 어느 한쪽에 두면 다른 쪽이
 *   그쪽을 import하면서 순환이 생긴다. 이 파일은 아무것도 import하지 않는 잎사귀다.
 *
 * 무엇을 담지 않는가
 *   오류 원문·제공자 응답·API 키·사용자 문장·모델 출력을 담지 않는다. 분류값 하나가
 *   메시지의 전부이며, 그래서 로그나 응답에 그대로 실어도 새어 나갈 내용이 없다.
 */

export type GenerationFailure =
  | 'input_invalid'
  | 'configuration_error'
  | 'provider_timeout'
  | 'provider_unavailable'
  | 'provider_error'
  | 'response_too_large'
  | 'response_invalid'
  | 'response_incomplete'
  | 'model_refusal'
  | 'response_contract_invalid'
  /** 후보 전체 실행의 시간 예산을 다 썼다. */
  | 'run_deadline_exceeded'
  /** 호출자가 실행을 취소했다. */
  | 'run_cancelled';

/** 오류 원문·키·모델 출력·문장을 담지 않는다. */
export class CandidateGenerationError extends Error {
  readonly kind: GenerationFailure;
  constructor(kind: GenerationFailure) {
    super(kind);
    this.name = 'CandidateGenerationError';
    this.kind = kind;
  }
}
