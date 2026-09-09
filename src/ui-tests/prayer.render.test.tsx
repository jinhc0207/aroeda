/**
 * 기도 화면 · 실제 렌더 테스트
 *
 * 실행: npm run test:ui
 *
 * 이 화면은 앱에서 가장 조심스러운 자리다.
 * 한 화면 안에 다음이 모두 들어 있다.
 *   직접 기도하는 길 / 도움받는 길 / 사용자가 적는 기도 /
 *   서버 요청 / 성공 / 실패 / 마치는 흐름
 *
 * 지켜야 할 약속 중 가장 무거운 것 둘:
 *   1. 직접 기도하기를 골랐으면 서버를 부르지 않는다.
 *   2. 사용자가 적은 기도는 어떤 경우에도 서버로 나가지 않는다.
 *
 * 검사하는 것과 하지 않는 것:
 *   검사한다 — 어떤 길로 들어왔을 때 무엇이 보이는가, 무엇이 서버로 나가는가.
 *   검사하지 않는다 — 안내 문구가 신학적으로 옳은가.
 *   그 판단은 이미 계약 테스트들이 맡고 있다.
 *
 * 서버는 실제로 부르지 않는다.
 *   supabase 모듈을 통째로 가짜로 바꿔 두었고,
 *   혹시 다른 길로 나가려 하면 fetch에서 막힌다.
 */

// describe / it / expect / jest 를 여기서 직접 가져온다.
// 이 프로젝트의 TypeScript 설정은 전역 타입을 node 하나로 좁혀 두었다.
import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { useEffect } from 'react';

import PrayerScreen from '@/app/prayer';
import { getScriptureCard } from '@/data/scripture-cards';
import { SituationProvider, useSituation } from '@/state/situation';

// 이 화면이 실제로 쓰는 것만 흉내 낸다.
jest.mock('expo-router', () => ({
  router: {
    push: jest.fn(),
    replace: jest.fn(),
    back: jest.fn(),
    canGoBack: jest.fn(() => false),
  },
  useLocalSearchParams: jest.fn(() => ({})),
}));

// 진짜 서버로 나가지 않도록 Supabase 모듈 자체를 바꾼다.
jest.mock('@/lib/supabase', () => ({
  supabase: { functions: { invoke: jest.fn() } },
}));

/* eslint-disable @typescript-eslint/no-require-imports */
const { router, useLocalSearchParams } = require('expo-router') as {
  router: { push: jest.Mock; replace: jest.Mock; back: jest.Mock; canGoBack: jest.Mock };
  useLocalSearchParams: jest.Mock;
};
const { supabase } = require('@/lib/supabase') as {
  supabase: { functions: { invoke: jest.Mock } };
};
/* eslint-enable @typescript-eslint/no-require-imports */

const invoke = supabase.functions.invoke;

/** 이미 검수된 카드 하나. 테스트용으로 새로 만들지 않는다. */
const CARD = getScriptureCard('SC-001');

/** 상황 문장은 서버로 나가는 값이므로 알아보기 쉬운 표시를 쓴다. */
const SITUATION = '내일 결과 발표를 앞두고 잠이 오지 않습니다.';

/**
 * 사용자가 적는 기도에 넣어 볼 표시.
 *
 * 신학 내용이 아니라, 이 글자가 서버 요청에 섞였는지만 보기 위한 표식이다.
 */
const PRIVATE_DRAFT = 'UI_TEST_PRIVATE_PRAYER_DRAFT';

/**
 * 서버가 잘 응답했을 때의 모양.
 *
 * 기존 계약 테스트(src/lib/prayer-guidance.test.ts)가 쓰는 값을 그대로 가져왔다.
 * 기도 안내 문구를 이 테스트 때문에 새로 지어내지 않는다.
 */
const GUIDANCE_FIXTURE = {
  prayerText:
    '하나님, 지금 마음이 두렵고 불안합니다. 결과를 알 수 없는 이 순간에도 주님을 의지하게 하시고, 저를 붙드시는 손길을 신뢰하며 오늘을 살아가게 해주세요.',
};

/**
 * 실제 Provider를 그대로 쓴다.
 *
 * 이 화면은 상황과 카드를 Situation Context에서 받는다.
 * 둘이 채워지기 전에는 화면을 그리지 않는다.
 * 그래야 "말씀이 없습니다" 화면을 잘못 검사하지 않는다.
 */
function WithSituation({ cardId, situation }: { cardId: string; situation: string }) {
  const { situation: current, selectedCardId, setSituation, setSelectedCardId } = useSituation();

  useEffect(() => {
    setSituation(situation);
    setSelectedCardId(cardId);
    // 설정 함수는 Provider가 새로 만들 수 있으므로 값만 본다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardId, situation]);

  if (selectedCardId !== cardId || current !== situation) return null;
  return <PrayerScreen />;
}

const renderPrayer = (mode: 'direct' | 'guided') => {
  useLocalSearchParams.mockReturnValue({ mode });
  return render(
    <SituationProvider>
      <WithSituation cardId={CARD.id} situation={SITUATION} />
    </SituationProvider>,
  );
};

/** 서버가 잘 응답한 경우. */
const respondOk = () =>
  invoke.mockResolvedValue({ data: { ok: true, guidance: GUIDANCE_FIXTURE }, error: null } as never);

/** 서버가 응답하지 못한 경우. */
const respondError = () =>
  invoke.mockResolvedValue({ data: null, error: { message: 'boom' } } as never);

beforeAll(() => {
  // 다른 길로 바깥에 나가려 하면 그 자리에서 실패해야 한다.
  global.fetch = (() => {
    throw new Error('기도 화면은 이 테스트에서 실제 서버를 부르지 않아야 합니다.');
  }) as unknown as typeof fetch;
});

beforeEach(() => {
  invoke.mockReset();
  router.push.mockReset();
  router.replace.mockReset();
  router.back.mockReset();
  router.canGoBack.mockReturnValue(false);
  useLocalSearchParams.mockReturnValue({});
});

/* ================================================================== */
/* A. 직접 기도하는 길                                                  */
/* ================================================================== */

describe('기도 화면 · 직접 기도하는 길', () => {
  it('직접 기도하는 자리가 그려진다', async () => {
    await renderPrayer('direct');

    expect(screen.getByText('이 말씀으로 아뢰어 보세요')).toBeTruthy();
    expect(screen.getByLabelText('기도 적는 곳')).toBeTruthy();
    expect(screen.getByText(CARD.referenceLabel)).toBeTruthy();

    // 오늘 말씀의 기도 방향은 그대로 두되, 서버가 만든 기도문은 없어야 한다.
    expect(screen.getByText(CARD.prayerDirection)).toBeTruthy();
    expect(screen.queryByText(GUIDANCE_FIXTURE.prayerText)).toBeNull();
  });

  it('직접 기도하기를 골랐으면 서버를 부르지 않는다', async () => {
    respondOk();

    await renderPrayer('direct');

    // 화면이 실제로 그려졌는지 먼저 확인한다.
    // 이 줄이 없으면 화면이 안 그려져도 "서버를 안 불렀다"고 통과해 버린다.
    expect(screen.getByLabelText('기도 적는 곳')).toBeTruthy();

    // 직접 기도하겠다고 했는데 상황이 다시 서버로 나가면 안 된다.
    expect(invoke).not.toHaveBeenCalled();
  });
});

/* ================================================================== */
/* B. 도움받는 길 — 잘 되었을 때                                        */
/* ================================================================== */

describe('기도 화면 · 도움받는 길', () => {
  it('서버가 준 생성된 기도문이 화면에 보인다', async () => {
    respondOk();

    await renderPrayer('guided');

    expect(await screen.findByText(GUIDANCE_FIXTURE.prayerText)).toBeTruthy();
  });

  it('생성된 기도문이 있어도 사용자가 적는 자리는 비어 있다', async () => {
    respondOk();

    await renderPrayer('guided');
    await screen.findByText(GUIDANCE_FIXTURE.prayerText);

    // 이 앱의 약속이다. 아뢰다가 기도문을 제안해도 그것을 적는 자리에 대신 채우지 않는다.
    // 기도는 그대로 읽거나, 자기 말로 바꾸거나, 사용자가 정한다.
    expect(screen.getByLabelText('기도 적는 곳').props.value).toBe('');
  });

  it('서버로 나가는 것은 상황과 말씀 번호 둘뿐이다', async () => {
    respondOk();

    await renderPrayer('guided');
    await screen.findByText(GUIDANCE_FIXTURE.prayerText);

    expect(invoke).toHaveBeenCalledTimes(1);
    const [functionName, options] = invoke.mock.calls[0] as [string, { body: unknown }];
    expect(functionName).toBe('generate-prayer-guidance');

    const body = options.body as Record<string, unknown>;
    // 딱 두 가지만. 하나라도 더 붙으면 여기서 걸린다.
    expect(Object.keys(body).sort()).toEqual(['cardId', 'situation']);
    expect(body.situation).toBe(SITUATION);
    expect(body.cardId).toBe(CARD.id);
  });

  it('말씀 설명과 기도 방향을 우리 쪽에서 보내지 않는다', async () => {
    respondOk();

    await renderPrayer('guided');
    await screen.findByText(GUIDANCE_FIXTURE.prayerText);

    // 서버는 자기 것을 쓴다. 화면이 가진 본문 해설을 실어 보내지 않는다.
    const sent = JSON.stringify(invoke.mock.calls);
    expect(sent.includes(CARD.userExplanation)).toBe(false);
    expect(sent.includes(CARD.prayerDirection)).toBe(false);
  });
});

/* ================================================================== */
/* C. 사용자가 적은 기도는 나가지 않는다                                 */
/* ================================================================== */

describe('기도 화면 · 적은 기도는 나가지 않는다', () => {
  it('적은 기도가 서버 요청 어디에도 들어 있지 않다', async () => {
    respondOk();

    await renderPrayer('guided');
    await screen.findByText(GUIDANCE_FIXTURE.prayerText);

    const input = screen.getByLabelText('기도 적는 곳');
    await fireEvent.changeText(input, PRIVATE_DRAFT);

    // 적은 글이 화면에는 남아 있어야 한다.
    expect(screen.getByLabelText('기도 적는 곳').props.value).toBe(PRIVATE_DRAFT);

    // 그러나 서버로 나간 것 어디에도 있으면 안 된다.
    expect(JSON.stringify(invoke.mock.calls).includes(PRIVATE_DRAFT)).toBe(false);

    // 적었다는 이유로 서버를 다시 부르지도 않는다.
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('직접 기도하는 길에서는 적어도 서버를 전혀 부르지 않는다', async () => {
    respondOk();

    await renderPrayer('direct');

    await fireEvent.changeText(screen.getByLabelText('기도 적는 곳'), PRIVATE_DRAFT);

    expect(screen.getByLabelText('기도 적는 곳').props.value).toBe(PRIVATE_DRAFT);
    expect(invoke).not.toHaveBeenCalled();
  });
});

/* ================================================================== */
/* D. 도움받지 못했을 때                                                */
/* ================================================================== */

describe('기도 화면 · 도움을 받지 못해도', () => {
  it('기도문을 준비하지 못했다고 솔직히 알리고, 기도 방향을 대신 보여준다', async () => {
    respondError();

    await renderPrayer('guided');

    expect(await screen.findByText('지금은 기도문을 준비하지 못했어요.')).toBeTruthy();
    expect(screen.getByText('기도 방향')).toBeTruthy();
    // prayerDirection을 기도문인 척 quote하지 않고, '기도 방향'이라는 이름으로만 보여준다.
    expect(screen.getByText(CARD.prayerDirection)).toBeTruthy();

    // 서버가 준 생성 기도문은 당연히 없다.
    expect(screen.queryByText(GUIDANCE_FIXTURE.prayerText)).toBeNull();
  });

  it('기도를 막지 않는다', async () => {
    respondError();

    await renderPrayer('guided');
    await screen.findByText('지금은 기도문을 준비하지 못했어요.');

    // 도움을 못 받았다고 해서 기도하는 자리까지 사라지면 안 된다.
    expect(screen.getByLabelText('기도 적는 곳')).toBeTruthy();
    expect(screen.getByLabelText('기도 마치기')).toBeTruthy();
  });

  it('무엇이 잘못됐는지 기술적인 말로 알리지 않는다', async () => {
    respondError();

    await renderPrayer('guided');
    await screen.findByText('지금은 기도문을 준비하지 못했어요.');

    // 기도하러 온 사람에게 서버 사정을 설명하지 않는다.
    for (const word of ['boom', 'Supabase', 'supabase', '503', 'Edge Function', 'OpenAI']) {
      expect(screen.queryByText(new RegExp(word))).toBeNull();
    }
  });
});

/* ================================================================== */
/* E. 기도를 마치는 흐름                                                */
/* ================================================================== */

describe('기도 화면 · 마치는 흐름', () => {
  it('적지 않아도 기도를 마칠 수 있다', async () => {
    await renderPrayer('direct');

    // 소리 내어 기도한 사람에게 글쓰기를 요구하지 않는다.
    expect(screen.getByLabelText('기도 적는 곳').props.value).toBe('');
    await fireEvent.press(screen.getByLabelText('기도 마치기'));

    expect(screen.getByText('오늘의 기도를 마쳤어요.')).toBeTruthy();
    expect(screen.getByText(CARD.referenceLabel)).toBeTruthy();
  });

  it('처음으로 돌아가면 적은 기도가 남지 않는다', async () => {
    await renderPrayer('direct');

    await fireEvent.changeText(screen.getByLabelText('기도 적는 곳'), PRIVATE_DRAFT);
    await fireEvent.press(screen.getByLabelText('기도 마치기'));
    await fireEvent.press(screen.getByLabelText('처음으로 돌아가기'));

    expect(router.replace).toHaveBeenCalledTimes(1);
    expect(router.replace).toHaveBeenCalledWith('/');

    // 돌아가는 길에 적은 기도가 화면에서 사라져야 한다.
    expect(screen.queryByText(PRIVATE_DRAFT)).toBeNull();
  });
});
