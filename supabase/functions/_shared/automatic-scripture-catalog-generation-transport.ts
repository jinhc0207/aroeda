/**
 * 후보 시험 전용 일회 통신. 키는 호출자가 주입하며 이 모듈은 기록하지 않는다.
 *
 * 요청 하나의 실제 제한
 *   min(요청이 지정한 값, transport 설정값, 60초, 실행 전체의 남은 시간)
 *
 *   네 값 중 가장 짧은 것이 이긴다. 큰 값을 넣어 상한을 늘릴 수 없다. 0·음수·소수·NaN·
 *   Infinity·다른 타입은 `doFetch`를 부르기 전에 configuration_error로 거절한다. 제한에는
 *   응답 본문을 다 읽는 시간까지 포함한다 — 헤더만 빨리 오고 본문이 끝나지 않는 경우도
 *   같은 마감에 걸린다.
 *
 * 실행 전체 마감과의 연결
 *   `deadline`을 받으면 그 취소 신호를 이 요청의 AbortController에 잇는다. 실행이 마감되면
 *   진행 중인 fetch와 본문 읽기가 함께 취소되고, 남은 시간이 없으면 아예 보내지 않는다.
 *   취소는 이미 제공자에 도달한 작업과 과금을 되돌리지 않는다(deadline 모듈 머리말 참고).
 *
 * 자동 재시도는 없다. 한 번 보내고 끝낸다.
 */
import { readGenerationResponse, type CaseAuthorSpec } from './automatic-scripture-catalog-case-author.ts';
import { CandidateGenerationError } from './automatic-scripture-catalog-generation-failure.ts';
import {
  CANDIDATE_GENERATION_REQUEST_MAX_MS,
  type RunDeadline,
  monotonicNow,
  resolveRequestTimeoutMs,
} from './automatic-scripture-catalog-generation-deadline.ts';
import { buildCandidateGenerationAnalysisRequest } from './automatic-scripture-catalog-generation-analysis-request.ts';
import { MODEL } from './analyzer-contract.ts';

export const GENERATION_RESPONSE_MAX_BYTES = 262_144;
export type GenerationTransportConfig = {
  apiKey: unknown;
  fetchImpl?: typeof fetch;
  /** 테스트에서는 줄일 수 있지만 요청별 상한 60초를 늘릴 수 없다. */
  timeoutMs?: number;
};

export type CandidateGenerationTransport = {
  author: (spec: CaseAuthorSpec, deadline?: RunDeadline) => Promise<unknown>;
  analyze: (text: string, deadline?: RunDeadline) => Promise<unknown>;
};

export function createCandidateGenerationTransport(config: GenerationTransportConfig): CandidateGenerationTransport {
  // 다른 요청이 config 객체를 바꿔도 키·fetch·시간 제한은 생성 시점 값으로 고정한다.
  const apiKey = config.apiKey;
  const doFetch = config.fetchImpl ?? globalThis.fetch;
  const configuredTimeoutMs = config.timeoutMs;
  // 설정값은 상한을 넘으면 조용히 깎지 않고 거절한다. 운영 설정이 잘못된 것은 드러나야 한다.
  if (typeof apiKey !== 'string' || !/^[\x21-\x7e]+$/.test(apiKey) || apiKey.length > 1024 ||
      typeof doFetch !== 'function' ||
      resolveRequestTimeoutMs([configuredTimeoutMs], CANDIDATE_GENERATION_REQUEST_MAX_MS) === null ||
      (configuredTimeoutMs !== undefined && configuredTimeoutMs > CANDIDATE_GENERATION_REQUEST_MAX_MS)) {
    throw new CandidateGenerationError('configuration_error');
  }

  async function request(
    body: Record<string, unknown>,
    requestedTimeoutMs: unknown,
    deadline: RunDeadline | undefined,
  ): Promise<unknown> {
    // 1) 설정부터 본다. 여기서 걸리면 fetch를 한 번도 부르지 않는다.
    const configured = resolveRequestTimeoutMs(
      [requestedTimeoutMs, configuredTimeoutMs],
      CANDIDATE_GENERATION_REQUEST_MAX_MS,
    );
    if (configured === null) throw new CandidateGenerationError('configuration_error');

    // 2) 실행 전체의 남은 시간을 함께 본다. 남은 시간이 없으면 보내지 않는다.
    if (deadline) {
      if (deadline.done()) throw new CandidateGenerationError(deadline.failureReason() ?? 'run_deadline_exceeded');
      // 올림한다. 내림하면 요청 타이머가 실제 마감보다 먼저 울려 원인이 뒤바뀐다.
      if (Math.ceil(deadline.remainingMs()) < 1) throw new CandidateGenerationError('run_deadline_exceeded');
    }

    // 3) 요청별 마감은 **절대 시각으로 한 번만** 고정한다. 재예약해도 예산이 다시 시작하지 않는다.
    //    전체 마감과 같은 시계를 써야 둘 중 어느 쪽이 먼저인지 비교할 수 있다.
    const clock = deadline ? () => deadline.now() : monotonicNow;
    const requestDeadlineAt = clock() + configured;

    const controller = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    /**
     * 끝난 이유는 어느 타이머가 먼저 울렸는지가 아니라 단조 시계가 정한다.
     * 소수점 절삭이나 타이머 실행 순서 때문에 전체 마감이 요청 시간 초과로 둔갑하지 않는다.
     */
    const stopReason = () => {
      if (deadline?.done()) return deadline.failureReason() ?? 'run_deadline_exceeded';
      return 'provider_timeout' as const;
    };

    const abortNow = () => {
      controller.abort();
      if (reader) void reader.cancel().catch(() => {});
    };

    // 실행 전체가 마감·취소되면 이 요청도 함께 끊는다.
    const onRunAbort = abortNow;
    deadline?.signal.addEventListener('abort', onRunAbort, { once: true });

    /**
     * 두 마감 중 먼저 오는 쪽까지 남은 시간. 올림해서 실제 마감보다 일찍 울지 않게 한다.
     * 요청별 남은 시간은 항상 유한하므로(상한 60초) 결과도 유한하다.
     */
    const nextDelayMs = () => {
      const requestLeft = requestDeadlineAt - clock();
      const runLeft = deadline ? deadline.remainingMs() : Number.POSITIVE_INFINITY;
      const left = Math.min(requestLeft, runLeft);
      return left > 0 ? Math.ceil(left) : 0;
    };

    /**
     * 타이머가 울렸다고 곧장 끊지 않는다.
     *
     * setTimeout은 지연의 소수부를 잘라 실제 마감보다 먼저 콜백을 부를 수 있다. 그래서
     * 먼저 두 마감을 시계로 확인하고, 둘 다 아직 오지 않았으면 abort도 reject도 하지 않고
     * 남은 시간으로 다시 예약한다. 요청별 마감은 절대 시각이라 재예약해도 늘어나지 않는다.
     */
    const onRequestTick = () => {
      timer = undefined;
      if (controller.signal.aborted) return;
      if (deadline?.done()) {
        abortNow();
        rejectTimeout(new CandidateGenerationError(deadline.failureReason() ?? 'run_deadline_exceeded'));
        return;
      }
      if (clock() >= requestDeadlineAt) {
        abortNow();
        rejectTimeout(new CandidateGenerationError('provider_timeout'));
        return;
      }
      scheduleRequestTick();
    };

    const scheduleRequestTick = () => {
      if (controller.signal.aborted) return;
      timer = setTimeout(onRequestTick, nextDelayMs());
    };

    let rejectTimeout!: (error: unknown) => void;
    const timeout = new Promise<never>((_, reject) => { rejectTimeout = reject; });
    scheduleRequestTick();

    /**
     * 취소 신호만으로 이 대기를 끝낸다.
     *
     * 제공자가 abort를 무시하고 영원히 붙잡고 있으면, 이것이 없을 때 transport promise가
     * 미완료로 남고 finally가 실행되지 않아 최대 60초짜리 요청 타이머가 살아 있게 된다.
     * 이 racer가 있으면 취소 즉시 finally가 돌아 타이머와 리스너가 정리된다.
     *
     * 다만 이것은 **우리 쪽 대기**를 끝낼 뿐이다. 이미 제공자에 도달한 작업이 서버에서
     * 계속 수행되는 것과 그 과금을 멈추지는 않는다.
     */
    let onCancel: (() => void) | undefined;
    const cancelled = new Promise<never>((_, reject) => {
      onCancel = () => reject(new CandidateGenerationError(stopReason()));
      if (controller.signal.aborted) onCancel();
      else controller.signal.addEventListener('abort', onCancel, { once: true });
    });
    try {
      return await Promise.race([timeout, cancelled, (async () => {
        const response = await doFetch('https://api.openai.com/v1/responses', {
          method: 'POST', redirect: 'error',
          headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify(body), signal: controller.signal,
        });
        if (controller.signal.aborted) {
          void response.body?.cancel().catch(() => {});
          throw new CandidateGenerationError(stopReason());
        }
        if (!response.ok) {
          void response.body?.cancel().catch(() => {});
          throw new CandidateGenerationError(response.status === 408 ? 'provider_timeout' :
            response.status === 429 || response.status >= 500 ? 'provider_unavailable' : 'provider_error');
        }
        const declared = response.headers.get('content-length');
        if (declared !== null && Number(declared) > GENERATION_RESPONSE_MAX_BYTES) {
          void response.body?.cancel().catch(() => {});
          throw new CandidateGenerationError('response_too_large');
        }
        if (!response.body) throw new CandidateGenerationError('response_invalid');
        reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8', { fatal: true });
        let bytes = 0;
        let text = '';
        // 본문 읽기도 같은 마감 안에서 끝나야 한다.
        while (true) {
          const chunk = await reader.read();
          if (controller.signal.aborted) throw new CandidateGenerationError(stopReason());
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > GENERATION_RESPONSE_MAX_BYTES) throw new CandidateGenerationError('response_too_large');
          text += decoder.decode(chunk.value, { stream: true });
        }
        text += decoder.decode();
        return JSON.parse(text);
      })()]);
    } catch (error) {
      // 마감·취소가 났다면 그 원인이 제공자 오류보다 우선한다.
      if (deadline?.done()) throw new CandidateGenerationError(deadline.failureReason() ?? 'run_deadline_exceeded');
      if (error instanceof CandidateGenerationError) throw error;
      throw new CandidateGenerationError(controller.signal.aborted ? 'provider_timeout' : 'provider_error');
    } finally {
      // 성공·실패·취소 어느 경로로 끝나도 재예약된 요청 타이머까지 정리한다.
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      deadline?.signal.removeEventListener('abort', onRunAbort);
      if (onCancel) controller.signal.removeEventListener('abort', onCancel);
      // 늦게 오는 rejection이 처리되지 않은 채 떠돌지 않도록 받아 둔다.
      void cancelled.catch(() => {});
      void timeout.catch(() => {});
      controller.abort();
      if (reader) void reader.cancel().catch(() => {});
    }
  }

  return {
    /** spec은 실행기가 검증된 후보에서 만든다. 외부 사용자 요청 본문을 받는 엔드포인트가 아니다. */
    author: (spec: CaseAuthorSpec, deadline?: RunDeadline) => request(spec?.body, spec?.timeoutMs, deadline),
    /** Analyzer에는 합성 문장만 전달한다. 목표 카드·영역·Astra 출력의 다른 필드는 보내지 않는다. */
    analyze: async (text: string, deadline?: RunDeadline): Promise<unknown> => {
      const raw = await request(
        buildCandidateGenerationAnalysisRequest(text), CANDIDATE_GENERATION_REQUEST_MAX_MS, deadline);
      return readGenerationResponse(raw, MODEL);
    },
  };
}
