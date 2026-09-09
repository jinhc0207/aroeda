/**
 * 기도 화면에서 서버에 기도 도움을 요청하는 흐름
 *
 *   지금 나의 상황 + 지금 보고 있는 말씀 번호 → generate-prayer-guidance → 짧은 기도문
 *
 * 원칙
 *   - 사용자가 적고 있는 기도는 보내지 않는다. 받을 자리 자체를 만들지 않는다.
 *   - 말씀 설명과 기도 방향도 보내지 않는다. 서버가 자기 것을 쓴다.
 *   - 서버 응답을 그대로 믿지 않는다. 모양이 어긋나면 실패로 본다.
 *   - 실패는 한 가지다. 왜 실패했는지 화면이 알 필요가 없다.
 *     어느 경우든 화면은 기존 안내로 넘어가면 된다.
 *
 * 이 파일은 Supabase 클라이언트를 직접 불러오지 않는다.
 * 필요한 동작만 인자로 받기 때문에 실제 서버 없이도 시험할 수 있다.
 */

export type PrayerGuidance = {
  prayerText: string;
};

/** 화면에서 서버 호출을 감싸 넘겨주는 결과. */
export type GuidanceInvokeOutcome = { ok: true; data: unknown } | { ok: false };

export type PrayerGuidanceDeps = {
  /**
   * 보내는 값은 이 둘뿐이다.
   * 사용자가 적고 있는 기도를 넘길 자리가 없다.
   */
  invokePrayerGuidance: (body: {
    situation: string;
    cardId: string;
  }) => Promise<GuidanceInvokeOutcome>;
};

export type PrayerGuidanceOutcome =
  | { status: 'guidance'; guidance: PrayerGuidance }
  /** 까닭을 나누지 않는다. 화면은 기존 안내로 넘어간다. */
  | { status: 'unavailable' };

const UNAVAILABLE: PrayerGuidanceOutcome = { status: 'unavailable' };

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

/** 서버가 준 것이 약속한 모양인지 본다. 아니면 쓰지 않는다. */
export function parsePrayerGuidanceResponse(data: unknown): PrayerGuidance | null {
  if (typeof data !== 'object' || data === null) return null;

  const { ok, guidance } = data as { ok?: unknown; guidance?: unknown };
  if (ok !== true) return null;
  if (typeof guidance !== 'object' || guidance === null || Array.isArray(guidance)) return null;

  const { prayerText } = guidance as { prayerText?: unknown };
  if (!isNonEmptyString(prayerText)) return null;

  return { prayerText };
}

/**
 * 기도 도움을 한 번 요청한다.
 *
 * 다시 부르지 않는다. 어떤 경우에도 예외를 밖으로 던지지 않는다.
 * 실패하면 화면이 기존 안내를 그대로 쓰면 된다.
 */
export async function requestPrayerGuidance(
  input: { situation: string; cardId: string },
  deps: PrayerGuidanceDeps,
): Promise<PrayerGuidanceOutcome> {
  if (input.situation.trim().length === 0) return UNAVAILABLE;
  if (input.cardId.trim().length === 0) return UNAVAILABLE;

  let outcome: GuidanceInvokeOutcome;
  try {
    outcome = await deps.invokePrayerGuidance({
      situation: input.situation,
      cardId: input.cardId,
    });
  } catch {
    return UNAVAILABLE;
  }

  if (!outcome.ok) return UNAVAILABLE;

  const guidance = parsePrayerGuidanceResponse(outcome.data);
  if (!guidance) return UNAVAILABLE;

  return { status: 'guidance', guidance };
}
