/**
 * 2단계 응답을 쓸 수 없을 때, 어느 큰 범주였는지 (순수 로직)
 *
 * 왜 필요한가:
 *   production에서 Request A가 `verification_response_invalid`로 끝났다.
 *   그런데 이 사유 하나를 쓰는 자리가 코드 안에 여러 곳이라,
 *   응답만 보고는 어디서 막혔는지 알 수 없었다.
 *
 *   밖으로 나가는 사유는 그대로 하나로 둔다.
 *   서버 기록에만 어느 큰 범주였는지 남긴다.
 *
 * 얼마나 자세히 남기는가:
 *   큰 범주까지만이다. 그 이상은 남기지 않는다.
 *
 *   특히 자료 한 건의 세부 위반 이름(어느 항목이 왜 틀렸는지)은 남기지 않는다.
 *   그것을 남기면 "연도가 이상하다", "메모가 너무 길다" 같은 식으로
 *   자료 내용을 조금씩 되짚을 수 있게 된다.
 *   자료 한 건의 문제는 전부 verification_invalid_source_metadata 하나로 묶는다.
 *
 * 이 파일이 하지 않는 일:
 *   판정 규칙을 바꾸지 않는다. 이름만 정한다.
 *   네트워크, DB, 환경변수 읽기.
 *   제목·저자·발행처·주소·연도·메모·원본 응답을 담지 않는다.
 */

/** 2단계 응답을 쓸 수 없었던 큰 범주. 고정된 이름뿐이다. */
export const VERIFICATION_INVALID_DIAGNOSTICS = [
  /** 응답 자체가 우리가 아는 모양이 아니었다 */
  'verification_invalid_response_shape',
  /** 응답은 왔지만 모델이 쓴 본문을 꺼낼 수 없었다 */
  'verification_invalid_output_text',
  /** 본문은 있었지만 JSON으로 읽을 수 없었다 */
  'verification_invalid_json',
  /** JSON은 읽혔지만 초안의 큰 틀이 약속과 달랐다 */
  'verification_invalid_draft_shape',
  /** 모델이 적으면 안 되는 항목을 적었다 */
  'verification_invalid_banned_field',
  /** 의뢰서의 영역·근거 판본·판단 시점과 맞지 않았다 */
  'verification_invalid_provenance',
  /** 채택한 자료 한 건이 자료 규칙을 어겼다 */
  'verification_invalid_source_metadata',
  /** 뺀 자료 목록이 규칙을 어겼다 */
  'verification_invalid_rejected_source',
  /** 남은 물음 목록이 규칙을 어겼다 */
  'verification_invalid_unresolved_questions',
] as const;

export type VerificationInvalidDiagnostic = (typeof VERIFICATION_INVALID_DIAGNOSTICS)[number];
