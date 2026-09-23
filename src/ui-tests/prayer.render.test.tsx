/**
 * 기도 화면 · 실제 렌더 테스트
 *
 * 실행: npm run test:ui
 *
 * 이 화면은 앱에서 가장 조심스러운 자리다.
 * 한 화면 안에 다음이 모두 들어 있다.
 *   기도문 준비 / 성공 / 실패 / 자기 말로 적는 선택 자리 / 마치는 흐름
 *
 * 지켜야 할 약속 중 가장 무거운 것 둘:
 *   1. 화면에 들어올 때 기도문 요청은 최대 한 번뿐이다.
 *   2. 사용자가 적은 기도는 어떤 경우에도 서버로 나가지 않는다.
 *
 * 그리고 새 약속 하나:
 *   3. 자기 말로 적는 입력창은 기본으로 열려 있지 않다.
 *      "내 말로 적어보기"를 직접 고른 경우에만 나타난다.
 *
 * 검사하는 것과 하지 않는 것:
 *   검사한다 — 무엇이 보이는가, 무엇이 서버로 나가는가.
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
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { useEffect } from 'react';

import PrayerScreen from '@/app/prayer';
import { getScriptureCard } from '@/data/scripture-cards';
import { SituationProvider, useSituation } from '@/state/situation';
import {
  SCRIPTURE_CATALOG_RUNTIME_CLIENT_VERSION,
  type RuntimeCardView,
} from '../../supabase/functions/_shared/automatic-scripture-catalog-runtime';

// 이 화면이 실제로 쓰는 것만 흉내 낸다.
jest.mock('expo-router', () => ({
  router: {
    push: jest.fn(),
    replace: jest.fn(),
    back: jest.fn(),
    canGoBack: jest.fn(() => false),
  },
}));

// 진짜 서버로 나가지 않도록 Supabase 모듈 자체를 바꾼다.
jest.mock('@/lib/supabase', () => ({
  supabase: { functions: { invoke: jest.fn() } },
}));

/* eslint-disable @typescript-eslint/no-require-imports */
const { router } = require('expo-router') as {
  router: { push: jest.Mock; replace: jest.Mock; back: jest.Mock; canGoBack: jest.Mock };
};
const { supabase } = require('@/lib/supabase') as {
  supabase: { functions: { invoke: jest.Mock } };
};
/* eslint-enable @typescript-eslint/no-require-imports */

const invoke = supabase.functions.invoke;

/** 이미 검수된 카드 하나. 테스트용으로 새로 만들지 않는다. */
const CARD = getScriptureCard('SC-001');
const DYNAMIC_CARD: RuntimeCardView = {
  id: 'SC-999',
  domains: ['caregiving_strain'],
  referenceLabel: CARD.referenceLabel,
  passages: CARD.passages ?? [CARD.passage],
  userExplanation: '동적 카드 설명입니다.',
  prayerDirection: '돌봄 가운데 필요한 힘과 쉼을 구합니다.',
};

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
  const { situation: current, selectedCardId, setSituation, setRecommendation } = useSituation();
  const selectedDomain = getScriptureCard(cardId).domains[0]!;

  useEffect(() => {
    setSituation(situation);
    setRecommendation({ cardId, selectedDomain });
    // 설정 함수는 Provider가 새로 만들 수 있으므로 값만 본다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardId, situation]);

  if (selectedCardId !== cardId || current !== situation) return null;
  return <PrayerScreen />;
}

const renderPrayer = () =>
  render(
    <SituationProvider>
      <WithSituation cardId={CARD.id} situation={SITUATION} />
    </SituationProvider>,
  );

function WithRuntimeSituation({ card, situation }: { card: RuntimeCardView; situation: string }) {
  const { situation: current, selectedCardId, selectedCard, setSituation, setRecommendation } = useSituation();

  useEffect(() => {
    setSituation(situation);
    setRecommendation({ cardId: card.id, selectedDomain: card.domains[0]!, card });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card.id, situation]);

  if (selectedCardId !== card.id || selectedCard?.id !== card.id || current !== situation) return null;
  return <PrayerScreen />;
}

const renderDynamicPrayer = () =>
  render(
    <SituationProvider>
      <WithRuntimeSituation card={DYNAMIC_CARD} situation={SITUATION} />
    </SituationProvider>,
  );

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
});

/* ================================================================== */
/* A. 들어오면 기도문을 준비한다                                         */
/* ================================================================== */

describe('기도 화면 · 들어오면 기도문을 준비한다', () => {
  it('기도하는 자리가 그려지고, 기도문 요청은 한 번 나간다', async () => {
    respondOk();

    await renderPrayer();

    expect(screen.getByText('이 말씀으로 기도해요')).toBeTruthy();
    expect(screen.getByText(CARD.referenceLabel)).toBeTruthy();
    expect(await screen.findByText(GUIDANCE_FIXTURE.prayerText)).toBeTruthy();

    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('서버로 나가는 사용자 자료는 상황·말씀 번호·선택 영역뿐이다', async () => {
    respondOk();

    await renderPrayer();
    await screen.findByText(GUIDANCE_FIXTURE.prayerText);

    expect(invoke).toHaveBeenCalledTimes(1);
    const [functionName, options] = invoke.mock.calls[0] as [string, { body: unknown }];
    expect(functionName).toBe('generate-prayer-guidance');

    const body = options.body as Record<string, unknown>;
    // 사용자 자료 셋과 고정된 앱 capability뿐이다.
    expect(Object.keys(body).sort()).toEqual([
      'cardId', 'catalogRuntimeVersion', 'selectedDomain', 'situation',
    ]);
    expect(body.situation).toBe(SITUATION);
    expect(body.cardId).toBe(CARD.id);
    expect(body.selectedDomain).toBe(CARD.domains[0]);
    expect(body.catalogRuntimeVersion).toBe(SCRIPTURE_CATALOG_RUNTIME_CLIENT_VERSION);
  });

  it('말씀 설명과 기도 방향을 우리 쪽에서 보내지 않는다', async () => {
    respondOk();

    await renderPrayer();
    await screen.findByText(GUIDANCE_FIXTURE.prayerText);

    // 서버는 자기 것을 쓴다. 화면이 가진 본문 해설을 실어 보내지 않는다.
    const sent = JSON.stringify(invoke.mock.calls);
    expect(sent.includes(CARD.userExplanation)).toBe(false);
    expect(sent.includes(CARD.prayerDirection)).toBe(false);
  });

  it('로컬 목록에 없는 활성 카드도 같은 id·새 영역으로 기도 요청하고 화면에 유지한다', async () => {
    respondOk();

    await renderDynamicPrayer();
    expect(screen.getByText(DYNAMIC_CARD.referenceLabel)).toBeTruthy();
    expect(await screen.findByText(GUIDANCE_FIXTURE.prayerText)).toBeTruthy();

    const [, options] = invoke.mock.calls[0] as [string, { body: Record<string, unknown> }];
    expect(options.body.cardId).toBe(DYNAMIC_CARD.id);
    expect(options.body.selectedDomain).toBe('caregiving_strain');
    expect(JSON.stringify(options.body)).not.toContain(DYNAMIC_CARD.userExplanation);
    expect(JSON.stringify(options.body)).not.toContain(DYNAMIC_CARD.prayerDirection);
  });
});

/* ================================================================== */
/* B. 자기 말로 적는 자리는 골라야 열린다                                */
/* ================================================================== */

describe('기도 화면 · 적는 자리는 골라야 열린다', () => {
  it('기도문이 와도 적는 칸은 기본으로 없다', async () => {
    respondOk();

    await renderPrayer();
    await screen.findByText(GUIDANCE_FIXTURE.prayerText);

    // 아뢰다가 기도문을 제안해도, 사용자에게 적기를 과제로 주지 않는다.
    expect(screen.queryByLabelText('기도 적는 곳')).toBeNull();
    expect(screen.getByLabelText('내 말로 적어보기')).toBeTruthy();
  });

  it('내 말로 적어보기를 고르면 그때 입력창과 안내가 나온다', async () => {
    respondOk();

    await renderPrayer();
    await screen.findByText(GUIDANCE_FIXTURE.prayerText);

    await fireEvent.press(screen.getByLabelText('내 말로 적어보기'));

    expect(screen.getByLabelText('기도 적는 곳')).toBeTruthy();
    expect(screen.getByLabelText('기도 적는 곳').props.value).toBe('');
    // 저장하지 않는다는 안내는 입력창이 열린 뒤에 함께 보인다.
    expect(screen.getByText('적으신 기도는 어디에도 저장되지 않고, 이 화면에서만 머물러요.')).toBeTruthy();
  });

  it('적는 자리를 열어도 서버를 다시 부르지 않는다', async () => {
    respondOk();

    await renderPrayer();
    await screen.findByText(GUIDANCE_FIXTURE.prayerText);

    await fireEvent.press(screen.getByLabelText('내 말로 적어보기'));
    await fireEvent.changeText(screen.getByLabelText('기도 적는 곳'), PRIVATE_DRAFT);

    expect(screen.getByLabelText('기도 적는 곳').props.value).toBe(PRIVATE_DRAFT);
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});

/* ================================================================== */
/* C. 적은 기도는 나가지 않는다                                          */
/* ================================================================== */

describe('기도 화면 · 적은 기도는 나가지 않는다', () => {
  it('적은 기도가 서버 요청 어디에도 들어 있지 않다', async () => {
    respondOk();

    await renderPrayer();
    await screen.findByText(GUIDANCE_FIXTURE.prayerText);

    await fireEvent.press(screen.getByLabelText('내 말로 적어보기'));
    await fireEvent.changeText(screen.getByLabelText('기도 적는 곳'), PRIVATE_DRAFT);

    // 적은 글이 화면에는 남아 있어야 한다.
    expect(screen.getByLabelText('기도 적는 곳').props.value).toBe(PRIVATE_DRAFT);

    // 그러나 서버로 나간 것 어디에도 있으면 안 된다.
    expect(JSON.stringify(invoke.mock.calls).includes(PRIVATE_DRAFT)).toBe(false);
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});

/* ================================================================== */
/* D. 도움받지 못했을 때                                                */
/* ================================================================== */

describe('기도 화면 · 기도문을 받지 못해도', () => {
  it('솔직히 알리고, 기도 방향을 대신 보여준다', async () => {
    respondError();

    await renderPrayer();

    expect(await screen.findByText('지금은 기도문을 준비하지 못했어요.')).toBeTruthy();
    expect(screen.getByText('기도 방향')).toBeTruthy();
    // prayerDirection을 기도문인 척 quote하지 않고, '기도 방향'이라는 이름으로만 보여준다.
    expect(screen.getByText(CARD.prayerDirection)).toBeTruthy();

    // 서버가 준 생성 기도문은 당연히 없다.
    expect(screen.queryByText(GUIDANCE_FIXTURE.prayerText)).toBeNull();
  });

  it('기도를 막지 않고, 적는 자리도 고르면 열 수 있다', async () => {
    respondError();

    await renderPrayer();
    await screen.findByText('지금은 기도문을 준비하지 못했어요.');

    expect(screen.getByLabelText('기도 마치기')).toBeTruthy();

    // 실패했을 때도 적는 칸은 기본으로 닫혀 있다.
    expect(screen.queryByLabelText('기도 적는 곳')).toBeNull();

    await fireEvent.press(screen.getByLabelText('내 말로 적어보기'));
    expect(screen.getByLabelText('기도 적는 곳')).toBeTruthy();
  });

  it('실패해도 서버를 다시 부르지 않는다', async () => {
    respondError();

    await renderPrayer();
    await screen.findByText('지금은 기도문을 준비하지 못했어요.');

    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('무엇이 잘못됐는지 기술적인 말로 알리지 않는다', async () => {
    respondError();

    await renderPrayer();
    await screen.findByText('지금은 기도문을 준비하지 못했어요.');

    // 기도하러 온 사람에게 서버 사정을 설명하지 않는다.
    for (const word of ['boom', 'Supabase', 'supabase', '503', 'Edge Function', 'OpenAI']) {
      expect(screen.queryByText(new RegExp(word))).toBeNull();
    }
  });
});

/* ================================================================== */
/* E. 기다리는 동안                                                     */
/* ================================================================== */

describe('기도 화면 · 기다리는 동안', () => {
  it('기도문을 준비하는 동안에는 적는 과제를 주지 않는다', async () => {
    // 답을 미뤄 두어 loading 상태를 붙잡는다.
    invoke.mockReturnValue(new Promise(() => {}) as never);

    await renderPrayer();

    expect(screen.getByText('이 말씀으로 기도를 시작할 수 있도록 잠시 함께 정리하고 있어요.')).toBeTruthy();
    expect(screen.queryByLabelText('기도 적는 곳')).toBeNull();
    expect(screen.queryByLabelText('내 말로 적어보기')).toBeNull();
  });
});

/* ================================================================== */
/* F. 기도를 마치는 흐름                                                */
/* ================================================================== */

describe('기도 화면 · 마치는 흐름', () => {
  it('아무것도 적지 않아도 기도를 마칠 수 있다', async () => {
    respondOk();

    await renderPrayer();
    await screen.findByText(GUIDANCE_FIXTURE.prayerText);

    // 소리 내어 기도했거나, 그대로 읽었을 수 있다. 글쓰기를 요구하지 않는다.
    expect(screen.queryByLabelText('기도 적는 곳')).toBeNull();
    await fireEvent.press(screen.getByLabelText('기도 마치기'));

    expect(screen.getByText('오늘의 기도를 마쳤어요.')).toBeTruthy();
    expect(screen.getByText(CARD.referenceLabel)).toBeTruthy();
  });

  it('처음으로 돌아가면 적은 기도가 남지 않는다', async () => {
    respondOk();

    await renderPrayer();
    await screen.findByText(GUIDANCE_FIXTURE.prayerText);

    await fireEvent.press(screen.getByLabelText('내 말로 적어보기'));
    await fireEvent.changeText(screen.getByLabelText('기도 적는 곳'), PRIVATE_DRAFT);
    await fireEvent.press(screen.getByLabelText('기도 마치기'));
    await fireEvent.press(screen.getByLabelText('처음으로 돌아가기'));

    expect(router.replace).toHaveBeenCalledTimes(1);
    expect(router.replace).toHaveBeenCalledWith('/');

    // 돌아가는 길에 적은 기도가 화면에서 사라져야 한다.
    expect(screen.queryByText(PRIVATE_DRAFT)).toBeNull();
  });

  it('말씀을 다시 볼 수도 있다', async () => {
    respondOk();

    await renderPrayer();
    await screen.findByText(GUIDANCE_FIXTURE.prayerText);

    await fireEvent.press(screen.getByLabelText('기도 마치기'));
    await fireEvent.press(screen.getByLabelText('말씀 다시 보기'));

    expect(router.replace).toHaveBeenCalledWith('/scripture');
  });
});

/* ================================================================== */
/* 내 정보 삭제와 겹칠 때                                                */
/* ================================================================== */

/*
 * 화면이 언제나 사라진다고 기대하지 않는다.
 * 그래서 삭제 뒤에도 기도 화면을 내리지 않고 그대로 둔 채 확인한다.
 */

let probe: ReturnType<typeof useSituation> | null = null;

function KeepMounted() {
  const context = useSituation();
  probe = context;

  useEffect(() => {
    context.setSituation(SITUATION);
    context.setRecommendation({ cardId: CARD.id, selectedDomain: CARD.domains[0]! });
    // 처음 한 번만 채운다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <PrayerScreen />;
}

const renderKeepMounted = () =>
  render(
    <SituationProvider>
      <KeepMounted />
    </SituationProvider>,
  );

const NEXT_SITUATION = 'UI_TEST_삭제_뒤_다시_이야기한_상황';
const STALE_PRAYER = 'UI_TEST_삭제_전_요청으로_준비된_기도문';

describe('기도 화면 · 내 정보 삭제와 겹칠 때', () => {
  it('삭제 전에 보낸 기도문 요청의 답이 늦게 와도 보여 주지 않는다', async () => {
    const finishers: Array<(value: unknown) => void> = [];
    invoke.mockImplementation(() => new Promise((resolve) => finishers.push(resolve)));

    await renderKeepMounted();
    expect(invoke).toHaveBeenCalledTimes(1);

    // 기다리는 동안 내 정보가 삭제된다. 화면은 뒤에 그대로 남아 있다.
    await act(async () => probe!.clearAfterDataDeletion());
    expect(screen.getByText('먼저 함께 붙들 말씀을 찾아볼게요.')).toBeTruthy();

    // 그 뒤 같은 화면에 새 상황으로 다시 말씀이 들어온다.
    await act(async () => {
      probe!.setSituation(NEXT_SITUATION);
      probe!.setRecommendation({ cardId: CARD.id, selectedDomain: CARD.domains[0]! });
    });
    expect(invoke).toHaveBeenCalledTimes(2);

    // 이제서야 삭제 전 요청의 답이 도착한다.
    await act(async () => {
      finishers[0]({ data: { ok: true, guidance: { prayerText: STALE_PRAYER } }, error: null });
    });
    expect(screen.queryByText(STALE_PRAYER)).toBeNull();
    expect(screen.getByText(/잠시 함께 정리하고 있어요/)).toBeTruthy();

    await act(async () => {
      finishers[1]({ data: { ok: true, guidance: GUIDANCE_FIXTURE }, error: null });
    });
    expect(screen.getByText(GUIDANCE_FIXTURE.prayerText)).toBeTruthy();
    expect(screen.queryByText(STALE_PRAYER)).toBeNull();

    // 새 요청에는 새 상황만 실린다.
    const [, options] = invoke.mock.calls[1] as [string, { body: Record<string, unknown> }];
    expect(options.body.situation).toBe(NEXT_SITUATION);
  });

  it('삭제 뒤에는 화면이 남아 있어도 적던 기도와 입력창 상태를 비운다', async () => {
    respondOk();

    await renderKeepMounted();
    await screen.findByText(GUIDANCE_FIXTURE.prayerText);
    await fireEvent.press(screen.getByLabelText('내 말로 적어보기'));
    await fireEvent.changeText(screen.getByLabelText('기도 적는 곳'), PRIVATE_DRAFT);

    await act(async () => probe!.clearAfterDataDeletion());
    expect(screen.queryByLabelText('기도 적는 곳')).toBeNull();
    expect(screen.queryByText(PRIVATE_DRAFT)).toBeNull();

    await act(async () => {
      probe!.setSituation(NEXT_SITUATION);
      probe!.setRecommendation({ cardId: CARD.id, selectedDomain: CARD.domains[0]! });
    });
    await screen.findByText(GUIDANCE_FIXTURE.prayerText);

    // 입력창은 다시 닫혀 있고, 열어도 적던 기도는 남아 있지 않다.
    expect(screen.queryByLabelText('기도 적는 곳')).toBeNull();
    await fireEvent.press(screen.getByLabelText('내 말로 적어보기'));
    expect(screen.getByLabelText('기도 적는 곳').props.value).toBe('');
  });
});
