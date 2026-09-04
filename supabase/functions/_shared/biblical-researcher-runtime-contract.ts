/**
 * Biblical Researcher 실행 순서 (순수 로직)
 *
 * 지금까지 따로 만들어 둔 것들을 실제 순서로 잇는다.
 *
 *   근거 꾸러미
 *   → 실행 계획
 *   → 요청 본문
 *   → (주입받은) 한 번의 요청
 *   → 응답 상태
 *   → 거절 여부
 *   → 답변 문장
 *   → JSON 읽기
 *   → 초안 검사
 *   → 근거에 묶기
 *   → 최종 연구 결과
 *
 * 이 파일이 하지 않는 일:
 *   실제로 요청을 보내지 않는다. 네트워크를 모른다.
 *   주소도, 열쇠도, 머리글도, 시간을 재는 장치도 여기 없다.
 *   그것은 다음 단계(Edge Function)가 만든다.
 *
 *   이 파일이 책임지는 것은 "정확히 90초를 건네준다"까지다.
 *
 * 다시 부르지 않는다:
 *   요청은 한 번이다. 다시 부르는 코드 자체를 두지 않는다.
 *   실패하면 그 자리에서 끝낸다. 다음 단계로 넘어가지 않는다.
 *
 * 밖으로 내보내지 않는 것:
 *   원본 오류, 응답 본문, 상태 숫자, 모델이 쓴 글, 검사 실패 사유.
 *   실패했을 때 남는 것은 어느 경계에서 멈췄는지 하나뿐이다.
 */

import {
  buildBiblicalResearchExecutionPlan,
  type BiblicalResearchExecutionPlan,
} from './biblical-researcher-execution-contract.ts';
import {
  BIBLICAL_RESEARCH_MAX_OUTPUT_TOKENS,
  BIBLICAL_RESEARCH_MODEL,
  BIBLICAL_RESEARCH_MODEL_TIMEOUT_MS,
  BIBLICAL_RESEARCH_REASONING_EFFORT,
  BIBLICAL_RESEARCH_TRUNCATION,
  type BiblicalResearchFailure,
} from './biblical-researcher-runtime-policy.ts';
import { bindBiblicalResearchEvidence } from './biblical-research-evidence-binding.ts';
import {
  validateBiblicalResearchDraftResult,
  type BiblicalResearchDraftResult,
  type BiblicalResearchResult,
} from './biblical-researcher.ts';
import { extractOutputText, hasRefusal } from './openai-response.ts';
import type { BiblicalResearchHandoff } from './biblical-research-handoff.ts';

/**
 * 형식이 정해진 답에 붙이는 이름.
 *
 * 이 값은 요청을 표현하기 위한 이름표일 뿐이다.
 * 연구가 어느 꾸러미에서 나왔는지를 가리키는 값들과 섞지 않는다.
 *
 * 이 저장소의 다른 요청들과 같은 방식으로 짓는다
 * (source_harvest_draft, research_prioritization).
 */
export const BIBLICAL_RESEARCH_RESPONSE_SCHEMA_NAME = 'biblical_research_draft';

/* ------------------------------------------------------------------ */
/* 요청 본문                                                            */
/* ------------------------------------------------------------------ */

/**
 * 근거 꾸러미 하나로 요청 본문을 만든다.
 *
 * 부르는 쪽이 정할 수 있는 것은 없다.
 * 모델, 생각하는 정도, 출력 한도, 도구, 저장 여부, 자르지 않음, 응답 형식은
 * 모두 정해진 계약과 정책에서만 온다. 인자로 받지 않는다.
 *
 * 모델이 보는 데이터는 실행 계획이 만든 것 그대로다.
 * 여기서 줄이거나, 고르거나, 요약하거나, 설명을 덧붙이지 않는다.
 */
export function buildBiblicalResearchResponsesRequest(input: {
  handoff: BiblicalResearchHandoff;
}): Record<string, unknown> {
  const plan: BiblicalResearchExecutionPlan = buildBiblicalResearchExecutionPlan({
    handoff: input.handoff,
  });

  return {
    model: BIBLICAL_RESEARCH_MODEL,
    instructions: plan.instructions,
    // 이 저장소의 다른 요청과 같은 방식이다. 읽어서 되돌리면 modelInput 그대로다.
    input: JSON.stringify(plan.modelInput),
    reasoning: { effort: BIBLICAL_RESEARCH_REASONING_EFFORT },
    max_output_tokens: BIBLICAL_RESEARCH_MAX_OUTPUT_TOKENS,
    tools: plan.tools,
    store: plan.store,
    truncation: BIBLICAL_RESEARCH_TRUNCATION,
    text: {
      format: {
        type: 'json_schema',
        name: BIBLICAL_RESEARCH_RESPONSE_SCHEMA_NAME,
        strict: true,
        // 형식의 주인은 하나다. 베껴 적지 않고 그 객체를 그대로 넘긴다.
        schema: plan.structuredOutputSchema,
      },
    },
  };
}

/* ------------------------------------------------------------------ */
/* 요청을 보내는 일은 밖에서 받는다                                       */
/* ------------------------------------------------------------------ */

/**
 * 요청 한 번의 결과.
 *
 * 네트워크에서 일어난 일을 여기까지 들고 오지 않는다.
 * 온전한 응답이거나, 시간이 지났거나, 요청 자체가 실패했거나. 셋뿐이다.
 */
export type BiblicalResearchTransportResult =
  | { ok: true; response: unknown }
  | { ok: false; failure: 'model_timeout' | 'model_transport_error' };

/** 실제로 요청을 보내는 일. 다음 단계가 만들어 넣어 준다. */
export type BiblicalResearchResponsesTransport = (
  request: Record<string, unknown>,
  options: { timeoutMs: number },
) => Promise<BiblicalResearchTransportResult>;

/** 실행 결과. 실패하면 어느 경계에서 멈췄는지만 남는다. */
export type BiblicalResearchRuntimeResult =
  | { ok: true; result: BiblicalResearchResult }
  | { ok: false; failure: BiblicalResearchFailure };

const failed = (failure: BiblicalResearchFailure): BiblicalResearchRuntimeResult => ({
  ok: false,
  failure,
});

/* ------------------------------------------------------------------ */
/* 실행                                                                */
/* ------------------------------------------------------------------ */

/**
 * 연구 한 번을 실행한다.
 *
 * 권위 있는 입력은 근거 꾸러미 하나다.
 * 모델이나 시간을 인자로 받지 않는다. 받으면 정책이 둘이 된다.
 *
 * 요청은 정확히 한 번이다. 실패해도 다시 부르지 않고,
 * 다른 모델로 바꾸지 않고, 남은 것을 건져 쓰지 않는다.
 *
 * 근거에 묶인 결과만 성공이다. 초안을 최종 결과로 돌려주는 길은 없다.
 */
export async function executeBiblicalResearchRuntime(input: {
  handoff: BiblicalResearchHandoff;
  transport: BiblicalResearchResponsesTransport;
}): Promise<BiblicalResearchRuntimeResult> {
  const { handoff, transport } = input;

  const request = buildBiblicalResearchResponsesRequest({ handoff });

  // 1~2. 요청 한 번. 기다리는 시간은 정해진 값 그대로 건넨다.
  let sent: BiblicalResearchTransportResult;
  try {
    sent = await transport(request, { timeoutMs: BIBLICAL_RESEARCH_MODEL_TIMEOUT_MS });
  } catch {
    // 보내는 쪽이 그냥 터져도 그 오류를 밖으로 내보내지 않는다.
    return failed('model_transport_error');
  }

  if (!sent.ok) return failed(sent.failure);

  // 보내는 일 자체는 이미 끝났다. 여기서부터는 전송 실패가 아니다.
  // 응답이라 할 수 없는 모양이면 온전히 끝난 답이 아닌 것으로 본다.
  if (
    typeof sent.response !== 'object' ||
    sent.response === null ||
    Array.isArray(sent.response)
  ) {
    return failed('model_non_success');
  }

  const response = sent.response as Record<string, unknown>;

  // 3. 답이 중간에 끊겼다. 왜 끊겼는지는 보지 않는다. 살려 쓰지 않는다.
  if (response.status === 'incomplete') return failed('model_incomplete');

  // 4. 온전히 끝나지 않았다. failed, cancelled, queued, in_progress, 알 수 없는 값, 없음.
  if (response.status !== 'completed') return failed('model_non_success');

  // 5. 모델이 답하기를 거절했다.
  if (hasRefusal(response)) return failed('model_refusal');

  // 6. 답변 문장을 꺼낸다. 어디에 있는지는 공용 helper가 안다.
  const text = extractOutputText(response);
  if (text === null || text.trim().length === 0) return failed('model_output_missing');

  // 7. 한 번만 읽는다. 다듬어서 다시 읽지 않는다.
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return failed('model_output_invalid_json');
  }

  // 8. 읽혔다는 것과 약속을 지켰다는 것은 다른 말이다.
  const checked = validateBiblicalResearchDraftResult(parsed, handoff.brief);
  if (!checked.valid) return failed('model_draft_invalid');

  // 9. 계획을 만들 때 쓴 그 꾸러미에 묶는다. 응답으로 꾸러미를 다시 만들지 않는다.
  const bound = bindBiblicalResearchEvidence({
    draft: parsed as BiblicalResearchDraftResult,
    handoff,
  });
  if (!bound.ok) return failed('evidence_binding_failed');

  return { ok: true, result: bound.result };
}
