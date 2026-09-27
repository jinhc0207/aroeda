/** ambiguous 화면 · 추가 질문과 내비게이션 계약 */

import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { useEffect } from 'react';

import AmbiguousScreen from '@/app/ambiguous';
import { SituationProvider, useSituation } from '@/state/situation';

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: jest.fn(() => false) },
}));

jest.mock('@/lib/supabase', () => ({
  supabase: {
    functions: { invoke: jest.fn() },
    auth: { getSession: jest.fn(), signInAnonymously: jest.fn() },
  },
}));

/* eslint-disable @typescript-eslint/no-require-imports */
const { router } = require('expo-router') as {
  router: { push: jest.Mock; replace: jest.Mock; back: jest.Mock; canGoBack: jest.Mock };
};
const { supabase } = require('@/lib/supabase') as {
  supabase: {
    functions: { invoke: jest.Mock };
    auth: { getSession: jest.Mock; signInAnonymously: jest.Mock };
  };
};
/* eslint-enable @typescript-eslint/no-require-imports */

const invoke = supabase.functions.invoke;
const getSession = supabase.auth.getSession;

let probe: ReturnType<typeof useSituation> | null = null;
function Probe() {
  probe = useSituation();
  return null;
}

function InitialSituation({ children }: { children: React.ReactNode }) {
  const { situation, setSituation } = useSituation();
  useEffect(() => {
    setSituation('생활비가 모자라요');
  }, [setSituation]);
  if (!situation) return null;
  return children;
}

const renderScreen = () =>
  render(
    <SituationProvider>
      <Probe />
      <InitialSituation>
        <AmbiguousScreen />
      </InitialSituation>
    </SituationProvider>,
  );

const gateResponse = (result: Record<string, unknown>) => ({
  data: { ok: true, result },
  error: null,
});

const ambiguousResponse = () =>
  gateResponse({ route: 'ambiguous', primaryDomain: 'financial_hardship', selectedCardId: null });

beforeEach(() => {
  invoke.mockReset();
  getSession.mockReset();
  getSession.mockResolvedValue({
    data: { session: { user: { is_anonymous: true } } },
    error: null,
  } as never);
  router.push.mockReset();
  router.replace.mockReset();
  router.back.mockReset();
  router.canGoBack.mockReset();
  probe = null;
});

describe('ambiguous 화면 · 추가 질문', () => {
  it('생활비처럼 카드가 동점인 짧은 입력은 즉시 추가 질문과 입력칸을 보여준다', async () => {
    await renderScreen();

    expect(await screen.findByText('조금만 더 들려주세요')).toBeTruthy();
    expect(
      screen.getByText('지금 말씀해주신 상황에서, 가장 시급하거나 마음을 무겁게 하는 어려움은 무엇인가요?'),
    ).toBeTruthy();
    expect(screen.getByLabelText('추가 상황 설명')).toBeTruthy();
  });

  it('추가 설명을 원문에 붙여 다시 분석하고 말씀이 정해지면 즉시 이동한다', async () => {
    invoke.mockResolvedValue(
      gateResponse({ route: 'recommend', primaryDomain: 'financial_hardship', selectedCardId: 'SC-015' }) as never,
    );
    await renderScreen();

    await fireEvent.changeText(
      screen.getByLabelText('추가 상황 설명'),
      '이번 달 월세를 내면 식비가 남지 않는 것이 가장 걱정돼요.',
    );
    await fireEvent.press(screen.getByLabelText('추가 설명으로 다시 말씀 찾기'));

    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/scripture'));
    expect(invoke).toHaveBeenCalledWith('recommend-scripture', {
      body: {
        situation: '생활비가 모자라요\n이번 달 월세를 내면 식비가 남지 않는 것이 가장 걱정돼요.',
        catalogRuntimeVersion: 'scripture-catalog-runtime/v1',
      },
    });
    expect(probe!.selectedCardId).toBe('SC-015');
  });

  it('계속 동점이면 질문을 세 번만 하고 임의의 말씀을 고르지 않는다', async () => {
    invoke.mockResolvedValue(ambiguousResponse() as never);
    await renderScreen();

    await fireEvent.changeText(screen.getByLabelText('추가 상황 설명'), '돈이 부족한 것 자체가 힘들어요.');
    await fireEvent.press(screen.getByLabelText('추가 설명으로 다시 말씀 찾기'));
    expect(await screen.findByText('그 어려움이 가장 크게 느껴지는 구체적인 순간은 언제인가요?')).toBeTruthy();

    await fireEvent.changeText(screen.getByLabelText('추가 상황 설명'), '공과금 고지서를 볼 때 가장 막막해요.');
    await fireEvent.press(screen.getByLabelText('추가 설명으로 다시 말씀 찾기'));
    expect(
      await screen.findByText('그 일이 지금 나에게 어떤 영향을 주고 있으며, 가장 바라는 도움은 무엇인가요?'),
    ).toBeTruthy();

    await fireEvent.changeText(screen.getByLabelText('추가 상황 설명'), '불안을 견딜 위로와 지혜가 필요해요.');
    await fireEvent.press(screen.getByLabelText('추가 설명으로 다시 말씀 찾기'));

    expect(
      await screen.findByText('여전히 한 말씀으로 좁히기 어려워요. 임의로 고르지 않고 여기서 질문을 멈출게요.'),
    ).toBeTruthy();
    expect(screen.queryByLabelText('추가 상황 설명')).toBeNull();
    expect(invoke).toHaveBeenCalledTimes(3);
    expect(probe!.selectedCardId).toBeNull();
    expect(probe!.clarificationRound).toBe(3);
  });

  it('추가 분석이 영역 선택을 요구하면 같은 질문 횟수를 유지한 채 영역 선택 화면으로 간다', async () => {
    invoke.mockResolvedValue(
      gateResponse({
        route: 'domain_choice',
        primaryDomain: null,
        selectedCardId: null,
        domainChoiceCandidates: ['fear_uncertainty', 'financial_hardship'],
        domainChoiceOptions: [
          { domain: 'fear_uncertainty', resolution: 'recommend', selectedCardId: 'SC-001' },
          { domain: 'financial_hardship', resolution: 'recommend', selectedCardId: 'SC-015' },
        ],
      }) as never,
    );
    await renderScreen();

    await fireEvent.changeText(screen.getByLabelText('추가 상황 설명'), '앞으로 더 나빠질까 봐 두려워요.');
    await fireEvent.press(screen.getByLabelText('추가 설명으로 다시 말씀 찾기'));

    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/domain-choice'));
    expect(probe!.domainChoiceOptions).toHaveLength(2);
    expect(probe!.clarificationRound).toBe(1);
  });

  it('추가 분석이 안전 경로를 고르면 후속 질문보다 안전 안내를 우선한다', async () => {
    invoke.mockResolvedValue(
      gateResponse({ route: 'safety', primaryDomain: null, selectedCardId: null }) as never,
    );
    await renderScreen();

    await fireEvent.changeText(screen.getByLabelText('추가 상황 설명'), '지금은 제 안전이 걱정돼요.');
    await fireEvent.press(screen.getByLabelText('추가 설명으로 다시 말씀 찾기'));

    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/safety'));
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});

describe('ambiguous 화면 · 이전 화면으로 돌아가기', () => {
  it('뒤로 갈 곳이 있으면 router.back()을 쓴다', async () => {
    router.canGoBack.mockReturnValue(true);
    await renderScreen();

    await fireEvent.press(screen.getByLabelText('이전 화면으로 돌아가기'));

    expect(router.back).toHaveBeenCalledTimes(1);
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('뒤로 갈 곳이 없으면 홈으로 replace한다', async () => {
    router.canGoBack.mockReturnValue(false);
    await renderScreen();

    await fireEvent.press(screen.getByLabelText('이전 화면으로 돌아가기'));

    expect(router.replace).toHaveBeenCalledWith('/');
    expect(router.back).not.toHaveBeenCalled();
  });
});
