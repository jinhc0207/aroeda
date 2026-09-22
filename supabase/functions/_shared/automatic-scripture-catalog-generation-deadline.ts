/**
 * 후보 생성 실행의 시간 예산과 취소 신호.
 *
 * 두 층의 제한
 *   요청별 제한과 실행 전체 제한은 다른 것이다. 요청별 제한만 있으면 한 번의 호출은
 *   60초 안에 끝나지만 저작 1회 + 분석 최대 15회가 순차로 이어져 전체는 960초까지
 *   늘어난다. 그래서 실행 하나가 통째로 쓰는 예산을 따로 둔다.
 *
 *     요청별 실제 제한 = min(요청 지정값, transport 설정값, 60초, 실행의 남은 시간)
 *     실행 전체 제한   = 기본·최대 120초. 호출자와 테스트는 더 짧게만 정할 수 있다.
 *
 *   단계가 바뀌어도 예산은 초기화되지 않는다. 저작과 모든 분석이 같은 마감 시각 하나를
 *   나눠 쓴다.
 *
 * 왜 단조 증가 시계인가
 *   `Date.now()`는 시스템 시각이 뒤로 조정되면 경과 시간이 음수가 되어 마감이 밀린다.
 *   `performance.now()`는 뒤로 가지 않는다. 테스트가 기다리지 않고도 예산 소진을
 *   재현할 수 있도록 시계는 주입할 수 있게 열어 둔다.
 *
 * 남은 시간의 반올림
 *   `remainingMs()`는 소수를 그대로 돌려준다. 이 값으로 타이머를 잡는 쪽은 **올림**해야
 *   한다. 내림하면 요청 타이머가 실제 마감보다 최대 1ms 먼저 울려서, 전체 마감이 아니라
 *   요청 시간 초과처럼 보이게 된다. 어느 타이머가 먼저 울렸든 끝난 이유는 타이머가 아니라
 *   단조 시계가 정한다 — 그래서 실패를 만들 때마다 `done()`으로 시계를 다시 본다.
 *
 *   전체 마감 타이머도 같은 규칙을 따른다. 올림해 예약하고, 콜백에서 시계를 **다시 본 뒤**
 *   아직 남아 있으면 마감을 확정하지 않고 남은 시간으로 재예약한다. 그래서 타이머가 일찍
 *   울려도 예산이 남은 실행이 끊기지 않는다.
 *
 * 왜 Promise.race만으로는 부족한가
 *   경주에서 진 쪽은 사라지지 않는다. 의존 함수가 취소 신호를 무시하고 한참 뒤에
 *   완료하면, 그 결과가 다음 분석을 부르거나 성공으로 반환될 수 있다. 그래서 `race`는
 *   한 번만 확정되는 빗장을 두고, 늦게 온 성공·실패를 모두 받아 삼킨다(받지 않으면
 *   처리되지 않은 rejection이 된다). 확정된 뒤의 값은 어디에도 쓰이지 않는다.
 *
 * 취소가 보장하지 않는 것
 *   취소 신호는 우리 쪽 대기를 끝내고 in-flight 요청에 abort를 전달할 뿐이다. 이미
 *   제공자에 도달한 작업이 서버에서 계속 수행되는 것, 그에 따른 과금, 이미 시작된
 *   부수효과를 되돌리지는 않는다. 우리가 그 결과를 쓰지 않는다는 것만 보장한다.
 *
 * 이 파일이 하지 않는 일
 *   네트워크·DB·파일·환경변수를 읽지 않는다. 자동 재시도나 부분 결과 재개를 하지 않는다.
 */

import { CandidateGenerationError } from './automatic-scripture-catalog-generation-failure.ts';

/** 요청 하나의 상한. 어떤 설정도 이 값을 넘길 수 없다. */
export const CANDIDATE_GENERATION_REQUEST_MAX_MS = 60_000;

/** 후보 전체 실행의 기본값이자 상한. 호출자는 더 짧게만 정할 수 있다. */
export const CANDIDATE_GENERATION_RUN_BUDGET_MAX_MS = 120_000;

/** 뒤로 가지 않는 시계. 테스트에서만 바꾼다. */
export type MonotonicNow = () => number;

export const monotonicNow: MonotonicNow = () => performance.now();

/** 밀리초로 쓸 수 있는 값인가. 0·음수·소수·NaN·Infinity·다른 타입은 모두 거짓이다. */
export function isUsableDurationMs(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

/**
 * 후보들 중 가장 짧은 제한을 고른다.
 *
 * `undefined`는 "정하지 않음"이라 건너뛴다. 그 밖에 쓸 수 없는 값이 하나라도 있으면
 * null을 돌려주어 호출자가 외부 호출 전에 거절하게 한다. `maxMs`는 언제나 함께 적용되므로
 * 큰 값을 넣어 상한을 늘릴 수 없다.
 */
export function resolveRequestTimeoutMs(values: readonly unknown[], maxMs: number): number | null {
  if (!isUsableDurationMs(maxMs)) return null;
  let limit = maxMs;
  for (const value of values) {
    if (value === undefined) continue;
    if (!isUsableDurationMs(value)) return null;
    if (value < limit) limit = value;
  }
  return limit >= 1 ? limit : null;
}

export type RunDeadlineFailure = 'run_deadline_exceeded' | 'run_cancelled';

export type RunDeadline = {
  /**
   * 이 마감이 쓰는 단조 시계를 그대로 읽는다.
   *
   * 요청 타이머가 자기 마감을 잴 때 같은 시계를 써야 한다. 서로 다른 시계를 쓰면 어느
   * 쪽이 먼저인지 비교할 수 없고, 테스트도 시계 하나로 두 마감을 제어할 수 없다.
   */
  now(): number;
  /** 남은 시간(ms). 이미 지났으면 0. */
  remainingMs(): number;
  /** 마감했거나 취소되었는가. 확인하는 것만으로 부작용이 없도록 신호만 맞춘다. */
  done(): boolean;
  /** 끝난 이유. 아직 살아 있으면 null. */
  failureReason(): RunDeadlineFailure | null;
  /** 진행 중 요청에 전달할 취소 신호. */
  readonly signal: AbortSignal;
  /** 의존 함수가 취소를 무시해도 정해진 시간에 끝나도록 감싼다. */
  race<T>(work: Promise<T>): Promise<T>;
  /** 타이머·리스너 정리. 여러 번 불러도 안전하다. */
  dispose(): void;
};

export type RunDeadlineOptions = {
  /** 실행 전체 예산. 기본·최대 120초. */
  budgetMs?: number;
  /** 호출자의 취소 신호. */
  signal?: AbortSignal;
  /** 단조 증가 시계. 테스트에서만 바꾼다. */
  now?: MonotonicNow;
};

/**
 * 실행 하나가 통째로 쓰는 마감을 만든다.
 *
 * 쓸 수 없는 예산이나 시계가 오면 어떤 외부 호출도 하기 전에 configuration_error로 던진다.
 */
export function createCandidateGenerationRunDeadline(options: RunDeadlineOptions = {}): RunDeadline {
  // `??`를 쓰면 null도 기본값으로 바뀐다. 생략(undefined)만 기본값이고 나머지는 전부 검사 대상이다.
  const budgetMs = options.budgetMs === undefined ? CANDIDATE_GENERATION_RUN_BUDGET_MAX_MS : options.budgetMs;
  const now = options.now === undefined ? monotonicNow : options.now;
  const callerSignal = options.signal;
  if (
    !isUsableDurationMs(budgetMs) ||
    budgetMs > CANDIDATE_GENERATION_RUN_BUDGET_MAX_MS ||
    typeof now !== 'function' ||
    (callerSignal !== undefined &&
      (callerSignal === null || typeof (callerSignal as AbortSignal).addEventListener !== 'function'))
  ) {
    throw new CandidateGenerationError('configuration_error');
  }

  const startedAt = now();
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) {
    throw new CandidateGenerationError('configuration_error');
  }

  const controller = new AbortController();
  let reason: RunDeadlineFailure | null = null;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function clearTimer(): void {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
  }

  function finish(next: RunDeadlineFailure): void {
    if (reason !== null) return;
    reason = next;
    // 마감이 확정되면 예약된(또는 재예약된) 타이머는 더 볼 일이 없다.
    clearTimer();
    controller.abort();
  }

  function remainingMs(): number {
    const elapsed = now() - startedAt;
    // 시계가 이상한 값을 주면 남은 시간을 넉넉히 보지 않고 즉시 소진으로 본다.
    if (!Number.isFinite(elapsed)) return 0;
    const left = budgetMs - Math.max(elapsed, 0);
    return left > 0 ? left : 0;
  }

  function done(): boolean {
    if (callerSignal?.aborted) finish('run_cancelled');
    if (reason !== null) return true;
    if (remainingMs() <= 0) {
      finish('run_deadline_exceeded');
      return true;
    }
    return false;
  }

  /**
   * 의존 함수가 취소를 무시하고 영원히 붙잡고 있어도 이 타이머가 실행기를 풀어 준다.
   *
   * 남은 시간은 **올림**해 예약한다. 소수를 그대로 넘기면 setTimeout이 소수부를 잘라
   * 실제 마감보다 먼저 울린다.
   */
  function scheduleExpiry(): void {
    if (reason !== null || disposed) return;
    timer = setTimeout(onExpiryTick, Math.max(Math.ceil(remainingMs()), 0));
  }

  /**
   * 타이머가 울렸다고 곧장 마감을 확정하지 않는다.
   *
   * 마감을 정하는 것은 타이머가 아니라 단조 시계다. 아직 시간이 남아 있으면 확정하지 않고
   * 남은 시간으로 다시 예약한다. 재예약된 타이머도 `finish`·`dispose`가 함께 정리한다.
   */
  function onExpiryTick(): void {
    timer = undefined;
    if (reason !== null || disposed) return;
    if (callerSignal?.aborted) {
      finish('run_cancelled');
      return;
    }
    if (remainingMs() > 0) {
      scheduleExpiry();
      return;
    }
    finish('run_deadline_exceeded');
  }

  const onCallerAbort = () => finish('run_cancelled');
  callerSignal?.addEventListener('abort', onCallerAbort, { once: true });

  if (callerSignal?.aborted) finish('run_cancelled');
  else scheduleExpiry();

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    clearTimer();
    callerSignal?.removeEventListener('abort', onCallerAbort);
  }

  function race<T>(work: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      // 한 번만 열리는 빗장. 늦게 온 성공·실패는 여기서 조용히 버려진다.
      let settled = false;
      let onAbort: (() => void) | undefined;

      const close = () => {
        if (onAbort) controller.signal.removeEventListener('abort', onAbort);
        onAbort = undefined;
      };
      const failNow = () => {
        if (settled) return;
        settled = true;
        close();
        reject(new CandidateGenerationError(reason ?? 'run_deadline_exceeded'));
      };

      if (done()) {
        // 이미 끝난 실행이면 work의 결과를 기다리지 않는다. 다만 붙잡아 두어야
        // 늦은 rejection이 처리되지 않은 채 떠돌지 않는다.
        void Promise.resolve(work).then(() => {}, () => {});
        failNow();
        return;
      }

      onAbort = failNow;
      controller.signal.addEventListener('abort', onAbort, { once: true });

      Promise.resolve(work).then(
        (value) => {
          if (settled) return;
          settled = true;
          close();
          resolve(value);
        },
        (error) => {
          if (settled) return;
          settled = true;
          close();
          reject(error);
        },
      );
    });
  }

  return {
    now,
    remainingMs,
    done,
    failureReason: () => reason,
    get signal() {
      return controller.signal;
    },
    race,
    dispose,
  };
}
