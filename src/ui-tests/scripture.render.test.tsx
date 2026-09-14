/**
 * 말씀 화면 · 실제 렌더 테스트
 *
 * 실행: npm run test:ui
 *
 * 이 화면은 사용자 여정의 한가운데다.
 *   상황 입력 → 추천 → [말씀] → 기도
 * 앞으로 카드가 늘어나고 내용이 바뀔 때 가장 많이 흔들릴 자리이므로,
 * 지금 눈에 보이는 약속을 못으로 박아 둔다.
 *
 * 무엇을 검사하고 무엇을 검사하지 않는가:
 *   검사한다 — 카드에 들어 있는 값이 실제로 화면에 나타나는가.
 *   검사하지 않는다 — 그 설명이 신학적으로 옳은가.
 *   본문과 해설의 옳고 그름은 이미 계약 테스트들이 맡고 있다.
 *   여기서는 "제대로 보이는가"만 본다.
 *
 * 가짜 말씀을 새로 지어내지 않는다.
 *   이미 검수된 카드(SC-001)를 그대로 쓰고,
 *   본문도 성경 데이터에서 읽어 온 값과 맞춰 본다.
 *   테스트에 성경 구절을 손으로 옮겨 적지 않는다.
 *
 * 이 화면은 서버를 부르지 않는다. 그 사실도 함께 확인한다.
 */

// describe / it / expect / jest 를 여기서 직접 가져온다.
// 이 프로젝트의 TypeScript 설정은 전역 타입을 node 하나로 좁혀 두었다.
import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { useEffect } from 'react';

import ScriptureScreen from '@/app/scripture';
import { getPassage, TRANSLATION_NAME } from '@/data/bible';
import { getCardPassages, getScriptureCard } from '@/data/scripture-cards';
import { SituationProvider, useSituation } from '@/state/situation';

// 이 화면이 실제로 쓰는 네 가지만 흉내 낸다.
jest.mock('expo-router', () => ({
  router: {
    push: jest.fn(),
    canGoBack: jest.fn(() => false),
    back: jest.fn(),
    replace: jest.fn(),
  },
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { router } = require('expo-router') as {
  router: { push: jest.Mock; canGoBack: jest.Mock; back: jest.Mock; replace: jest.Mock };
};

/** 이미 검수된 카드 하나. 테스트용으로 새로 만들지 않는다. */
const CARD = getScriptureCard('SC-001');

/** 화면이 보여줄 절들. 성경 데이터에서 그대로 읽어 온다. */
const VERSES = getCardPassages(CARD).flatMap((passage) => getPassage(passage));

/**
 * 실제 Provider를 그대로 쓴다.
 *
 * 이 화면은 어느 카드를 보여줄지 route가 아니라 Situation Context에서 받는다.
 * 그래서 가짜 Context를 만들지 않고, 진짜 Provider 안에서 카드를 골라 준 뒤 화면을 그린다.
 * 고르기 전에는 화면을 그리지 않는다. "추천 없음" 화면을 잘못 검사하지 않기 위해서다.
 */
function WithSelectedCard({ cardId }: { cardId: string | null }) {
  const { selectedCardId, setSelectedCardId } = useSituation();

  useEffect(() => {
    setSelectedCardId(cardId);
    // setSelectedCardId는 Provider가 매번 새로 만들 수 있으므로 cardId만 본다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardId]);

  if (selectedCardId !== cardId) return null;
  return <ScriptureScreen />;
}

const renderWithCard = (cardId: string | null) =>
  render(
    <SituationProvider>
      <WithSelectedCard cardId={cardId} />
    </SituationProvider>,
  );

beforeAll(() => {
  // 이 화면이 바깥으로 나가려 하면 테스트가 그 자리에서 실패해야 한다.
  global.fetch = (() => {
    throw new Error('말씀 화면은 서버를 부르지 않아야 합니다.');
  }) as unknown as typeof fetch;
});

beforeEach(() => {
  router.push.mockReset();
  router.replace.mockReset();
  router.back.mockReset();
  router.canGoBack.mockReturnValue(false);
});

/* ================================================================== */
/* A. 말씀이 실제로 보인다                                              */
/* ================================================================== */

describe('말씀 화면 · 실제로 그려 보기', () => {
  it('말씀 화면이 그려진다', async () => {
    await renderWithCard(CARD.id);

    expect(screen.getByText('오늘 함께 붙들 말씀')).toBeTruthy();
  });

  it('어느 본문인지 화면에 보인다', async () => {
    await renderWithCard(CARD.id);

    // 카드에 적힌 값과 화면에 보이는 값이 같아야 한다.
    expect(screen.getByText(CARD.referenceLabel)).toBeTruthy();
  });

  it('성경 본문이 절마다 실제로 보인다', async () => {
    await renderWithCard(CARD.id);

    // 절 번호와 본문이 한 덩어리로 그려지므로 본문을 품고 있는지로 찾는다.
    expect(VERSES.length).toBeGreaterThan(0);
    for (const verse of VERSES) {
      expect(screen.getByText(new RegExp(escapeForSearch(verse.text)))).toBeTruthy();
    }

    // 어느 번역인지도 밝힌다. 이 앱은 본문을 지어내지 않는다.
    expect(screen.getByText(TRANSLATION_NAME)).toBeTruthy();
  });

  it('이 말씀이 무슨 뜻인지 설명이 보인다', async () => {
    await renderWithCard(CARD.id);

    // 내용이 옳은지가 아니라, 카드의 설명이 그대로 화면에 나오는지를 본다.
    expect(screen.getByText(CARD.userExplanation)).toBeTruthy();
  });

  it('어떻게 기도할지 방향이 보인다', async () => {
    await renderWithCard(CARD.id);

    expect(screen.getByText(CARD.prayerDirection)).toBeTruthy();
  });

  it('본문의 의미와 삶의 방향이라는 위계로 소개된다(기도가 먼저 보이지 않는다)', async () => {
    await renderWithCard(CARD.id);

    // 새 제품 철학: 말씀의 의미와 방향 재정립이 먼저다.
    expect(screen.getByText('이 말씀이 보여주는 것')).toBeTruthy();
    expect(screen.getByText('이제 이렇게 바라볼 수 있어요')).toBeTruthy();

    // 기도를 필수 다음 단계처럼 부르던 예전 문구는 없어야 한다.
    expect(screen.queryByText('이 말씀을 붙들고 기도해 보세요.')).toBeNull();
  });

  it('기도 초대 문구가 선택적으로 들린다(필수처럼 강요하지 않는다)', async () => {
    await renderWithCard(CARD.id);

    expect(screen.getByText('원한다면, 이 말씀을 기도로 이어가 보세요.')).toBeTruthy();

    // 기도를 강요하는 표현이 화면 어디에도 없어야 한다.
    for (const forced of ['반드시', '이제 기도해야', '기도로 마무리', '완료하려면']) {
      expect(screen.queryByText(new RegExp(forced))).toBeNull();
    }
  });
});

/* ================================================================== */
/* B. 기도로 넘어가는 길                                                */
/* ================================================================== */

describe('말씀 화면 · 기도로 가는 길', () => {
  it('기도 CTA가 하나뿐이다', async () => {
    await renderWithCard(CARD.id);

    // 기도 방식을 먼저 고르게 하지 않는다. 길은 하나다.
    expect(screen.queryByLabelText('직접 기도하기')).toBeNull();
    expect(screen.queryByLabelText('기도를 시작하는 도움 받기')).toBeNull();
    expect(screen.getByLabelText('이 말씀으로 기도해보기')).toBeTruthy();
  });

  it('이 말씀으로 기도해보기를 누르면 기도 화면으로 간다(mode 구분 없이)', async () => {
    await renderWithCard(CARD.id);

    await fireEvent.press(screen.getByLabelText('이 말씀으로 기도해보기'));

    expect(router.push).toHaveBeenCalledTimes(1);
    // 기도 방식을 미리 정해 보내지 않는다. 경로 하나뿐이다.
    expect(router.push).toHaveBeenCalledWith('/prayer');
    const arg = router.push.mock.calls[0][0];
    expect(typeof arg === 'string' ? arg : JSON.stringify(arg)).not.toContain('mode');
  });
});

/* ================================================================== */
/* B-2. 뒤로가기 계약 (2026-09-15 back navigation fix)                  */
/* ================================================================== */

describe('말씀 화면 · 뒤로가기 계약', () => {
  it('뒤로 갈 곳이 있으면(canGoBack true) router.back()을 쓴다', async () => {
    router.canGoBack.mockReturnValue(true);
    await renderWithCard(CARD.id);

    await fireEvent.press(screen.getByLabelText('뒤로 가기'));

    expect(router.back).toHaveBeenCalledTimes(1);
    expect(router.replace).not.toHaveBeenCalled();
    // 복합 경로에서 domain-choice가 push로 스택에 남아 있으면 back()이 거기로 돌려보낸다.
    // 이 화면은 그 대상을 알 필요가 없다 — canGoBack 하나만 지키면 된다.
  });

  it('뒤로 갈 곳이 없으면(canGoBack false) 홈으로 replace한다', async () => {
    router.canGoBack.mockReturnValue(false);
    await renderWithCard(CARD.id);

    await fireEvent.press(screen.getByLabelText('뒤로 가기'));

    expect(router.replace).toHaveBeenCalledWith('/');
    expect(router.back).not.toHaveBeenCalled();
  });
});

/* ================================================================== */
/* C. 추천이 없으면 아무 말씀이나 보여주지 않는다                        */
/* ================================================================== */

describe('말씀 화면 · 없는 추천을 지어내지 않는다', () => {
  it('모르는 카드가 오면 다른 말씀으로 대신하지 않는다', async () => {
    await renderWithCard('SC-존재하지-않는-카드');

    // 이것이 이 화면의 가장 중요한 약속이다.
    // 추천이 없을 때 아무 말씀이나 대신 보여주면,
    // 사용자는 자기 상황에 맞지 않는 본문을 하나님의 응답으로 받게 된다.
    expect(screen.getByText('추천된 말씀이 없습니다.')).toBeTruthy();
    expect(screen.getByText('다시 상황을 이야기해주세요.')).toBeTruthy();

    // 기본 카드로 조용히 되돌아가지 않는다.
    expect(screen.queryByText(CARD.referenceLabel)).toBeNull();
    expect(screen.queryByText(CARD.userExplanation)).toBeNull();
    expect(screen.queryByText('오늘 함께 붙들 말씀')).toBeNull();
  });
});

/** 본문에 정규식 특수문자가 있어도 그대로 찾도록 막아 준다. */
function escapeForSearch(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
