/**
 * Coverage Gap Collector v1 (서버 전용)
 *
 * 지금 카드로 다룰 수 없는 상황(no_coverage)이 어떤 영역에서 얼마나 생기는지만 센다.
 * 앞으로 어떤 Scripture Card를 먼저 만들지 정하기 위한 자료다.
 *
 * 원칙
 *   - 사용자의 상황 문장을 받지도, 넘기지도 않는다. 넘기는 값은 primaryDomain 하나뿐이다.
 *   - 사용자 id, JWT, 세션 정보를 다루지 않는다.
 *   - route가 정확히 no_coverage일 때만 기록한다. safety / recommend / ambiguous는 기록하지 않는다.
 *   - 기록이 실패해도 사용자 응답을 실패시키지 않는다(fail-open).
 *     Rate Limit의 fail-closed 정책과는 다르다. 섞지 않는다.
 */

import { FALLBACK_DOMAIN, UNCOVERED_DOMAINS } from './situation-domains.ts';

/** 기록할 수 있는 영역: 지금 카드가 없는 8개 (기존 domain 정의를 그대로 쓴다) */
export const COVERAGE_GAP_DOMAINS: readonly string[] = [...UNCOVERED_DOMAINS, FALLBACK_DOMAIN];

const allowedDomains = new Set(COVERAGE_GAP_DOMAINS);

export const isCoverageGapDomain = (value: unknown): value is string =>
  typeof value === 'string' && allowedDomains.has(value);

/** 영역 이름 하나만 받는다. 다른 값을 받을 자리를 만들지 않는다. */
export type CoverageGapRecorder = (primaryDomain: string) => Promise<void>;

export type CoverageGapConfig = {
  url: string | undefined;
  /** 서버 전용 키. 클라이언트나 EXPO_PUBLIC 환경 변수로 옮기지 않는다. */
  serviceRoleKey: string | undefined;
  fetchImpl?: typeof fetch;
  /** 실패 시 남길 로그. 고정 문자열만 남긴다. */
  log?: (message: string) => void;
  /** 통계 기록에 기다려줄 최대 시간(ms). 테스트에서만 바꾼다. */
  timeoutMs?: number;
};

const RPC_PATH = '/rest/v1/rpc/record_coverage_gap';

/**
 * 통계 기록 때문에 사용자 응답이 늦어지면 안 된다.
 * 이 시간이 지나면 요청을 취소하고 그냥 넘어간다.
 */
export const COVERAGE_GAP_TIMEOUT_MS = 1500;

const TIMED_OUT = Symbol('coverage_gap_timeout');

/** 실제 DB에 기록하는 collector를 만든다. */
export function createSupabaseCoverageGapRecorder(config: CoverageGapConfig): CoverageGapRecorder {
  const doFetch = config.fetchImpl ?? fetch;
  const log = config.log ?? (() => {});

  return async (primaryDomain: string): Promise<void> => {
    if (!config.url || !config.serviceRoleKey) {
      log('coverage_gap_write_failed');
      return;
    }

    const timeoutMs = config.timeoutMs ?? COVERAGE_GAP_TIMEOUT_MS;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;

    // 정해진 시간이 지나면 요청을 취소하고, 취소가 통하지 않는 경우에도 바로 빠져나온다.
    const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(TIMED_OUT);
      }, timeoutMs);
    });

    try {
      const request = doFetch(`${config.url}${RPC_PATH}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.serviceRoleKey}`,
          apikey: config.serviceRoleKey,
          'content-type': 'application/json',
        },
        // 넘기는 값은 영역 이름 하나뿐이다.
        body: JSON.stringify({ p_primary_domain: primaryDomain }),
        signal: controller.signal,
      });

      const result = await Promise.race([request, timeout]);

      if (result === TIMED_OUT || !result.ok) log('coverage_gap_write_failed');
    } catch {
      // 원본 오류, 키, 사용자 정보는 남기지 않는다.
      log('coverage_gap_write_failed');
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
}

/**
 * Gate 결과를 보고 필요할 때만 기록한다.
 * 어떤 경우에도 예외를 밖으로 던지지 않는다. 통계 때문에 사용자 응답이 실패하면 안 된다.
 */
export async function recordCoverageGapIfNeeded(
  result: { route: string; primaryDomain: string },
  recorder: CoverageGapRecorder | undefined,
): Promise<void> {
  if (!recorder) return;
  if (result.route !== 'no_coverage') return;
  if (!isCoverageGapDomain(result.primaryDomain)) return;

  try {
    await recorder(result.primaryDomain);
  } catch {
    // fail-open: 여기서 끝낸다.
  }
}
