/**
 * 첫 화면 · 실제 렌더 테스트 — 개발 진단 계측
 *
 * 실행: npm run test:ui
 *
 * 이 화면에서 실제 사용자 submit이 실패했을 때(2026-09-09 smoke 실패)
 * auth / function invoke / response 단계 중 어디서 멈췄는지 구분할 수 없었다.
 * 그래서 개발 모드에서만 보이는 안전한 진단 문구를 추가했다.
 *
 * 지켜야 할 약속:
 *   1. 사용자에게 보이는 notice 문구는 이번 계측으로 바뀌지 않는다.
 *   2. 진단 문구에는 토큰·세션·상황 원문·원본 오류가 절대 담기지 않는다.
 *   3. 진단 추가로 서버 호출 횟수가 늘지 않는다.
 *
 * 서버는 실제로 부르지 않는다. supabase 모듈을 통째로 가짜로 바꾼다.
 */

import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen } from '@testing-library/react-native';

import SituationScreen from '@/app/index';
import { SituationProvider } from '@/state/situation';

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
const { router } = require('expo-router') as { router: { push: jest.Mock } };
const { supabase } = require('@/lib/supabase') as {
  supabase: {
    functions: { invoke: jest.Mock };
    auth: { getSession: jest.Mock; signInAnonymously: jest.Mock };
  };
};
/* eslint-enable @typescript-eslint/no-require-imports */

const invoke = supabase.functions.invoke;
const getSession = supabase.auth.getSession;
const signInAnonymously = supabase.auth.signInAnonymously;

const SITUATION = 'UI_TEST_실제_상황_문장_노출되면_안됨';
const FAKE_TOKEN = 'sb_publishable_ui_test_should_never_leak';

const restoredSession = () =>
  getSession.mockResolvedValue({
    data: { session: { user: { is_anonymous: true } } },
    error: null,
  } as never);

const authPrepFails = () => {
  getSession.mockResolvedValue({ data: { session: null }, error: null } as never);
  signInAnonymously.mockResolvedValue({
    data: { session: null },
    error: { name: 'AuthApiError' },
  } as never);
};

const respondGate = (route: string, extra: Record<string, unknown> = {}) =>
  invoke.mockResolvedValue({
    data: {
      ok: true,
      result: {
        route,
        primaryDomain: 'fear_uncertainty',
        secondaryDomains: [],
        safety: { level: 'normal', categories: [] },
        coverage: { primaryDomain: 'fear_uncertainty', covered: true, cardIds: ['SC-001'] },
        eligibleDomains: ['fear_uncertainty'],
        eligibleCardIds: ['SC-001'],
        rankedCandidates: [],
        selectedCardId: route === 'recommend' ? 'SC-001' : null,
        isTie: false,
        ...extra,
      },
    },
    error: null,
  } as never);

const respondHttpFailure = (status: number) =>
  invoke.mockResolvedValue({ data: null, error: { context: { status } } } as never);

const respondNetworkFailure = () =>
  invoke.mockResolvedValue({ data: null, error: { message: 'network' } } as never);

const respondInvokeThrows = () => invoke.mockRejectedValue(new Error('failed to fetch') as never);

const respondMalformed = () =>
  invoke.mockResolvedValue({ data: { ok: true, result: null }, error: null } as never);

const submit = async () => {
  await fireEvent.changeText(screen.getByLabelText('지금 나의 상황'), SITUATION);
  await fireEvent.press(screen.getByLabelText('말씀을 찾아주세요'));
};

const renderScreen = () =>
  render(
    <SituationProvider>
      <SituationScreen />
    </SituationProvider>,
  );

beforeEach(() => {
  invoke.mockReset();
  getSession.mockReset();
  signInAnonymously.mockReset();
  router.push.mockReset();
  restoredSession();
});

describe('첫 화면 · 개발 진단 — auth 단계', () => {
  it('세션 준비 실패: 기존 일반 문구 그대로 + 진단은 AUTH_SESSION_PREP_FAILED, 서버 호출 0', async () => {
    authPrepFails();
    await renderScreen();

    await submit();

    expect(await screen.findByText('지금은 말씀을 찾지 못했어요. 잠시 후 다시 시도해주세요.')).toBeTruthy();
    expect(screen.getByLabelText('개발 진단').props.children).toBe('개발 진단: AUTH_SESSION_PREP_FAILED');
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('첫 화면 · 개발 진단 — function invoke 단계', () => {
  it('401: 일반 문구 + FUNCTION_HTTP_401', async () => {
    respondHttpFailure(401);
    await renderScreen();

    await submit();

    expect(await screen.findByText('지금은 말씀을 찾지 못했어요. 잠시 후 다시 시도해주세요.')).toBeTruthy();
    expect(screen.getByLabelText('개발 진단').props.children).toBe('개발 진단: FUNCTION_HTTP_401');
  });

  it('429: 기존 사용량 제한 문구 그대로 + FUNCTION_HTTP_429', async () => {
    respondHttpFailure(429);
    await renderScreen();

    await submit();

    expect(await screen.findByText('잠시 쉬었다가 다시 말씀을 찾아주세요.')).toBeTruthy();
    expect(screen.getByLabelText('개발 진단').props.children).toBe('개발 진단: FUNCTION_HTTP_429');
  });

  it('5xx: 일반 문구 + FUNCTION_HTTP_5XX', async () => {
    respondHttpFailure(503);
    await renderScreen();

    await submit();

    expect(await screen.findByText('지금은 말씀을 찾지 못했어요. 잠시 후 다시 시도해주세요.')).toBeTruthy();
    expect(screen.getByLabelText('개발 진단').props.children).toBe('개발 진단: FUNCTION_HTTP_5XX');
  });

  it('상태 코드 없는 실패(네트워크 계열): FUNCTION_NETWORK_FAILED', async () => {
    respondNetworkFailure();
    await renderScreen();

    await submit();

    expect(await screen.findByText('지금은 말씀을 찾지 못했어요. 잠시 후 다시 시도해주세요.')).toBeTruthy();
    expect(screen.getByLabelText('개발 진단').props.children).toBe('개발 진단: FUNCTION_NETWORK_FAILED');
  });

  it('invoke 자체가 예외를 던지면: FUNCTION_INVOKE_FAILED', async () => {
    respondInvokeThrows();
    await renderScreen();

    await submit();

    expect(await screen.findByText('지금은 말씀을 찾지 못했어요. 잠시 후 다시 시도해주세요.')).toBeTruthy();
    expect(screen.getByLabelText('개발 진단').props.children).toBe('개발 진단: FUNCTION_INVOKE_FAILED');
  });
});

describe('첫 화면 · 개발 진단 — response 단계', () => {
  it('모양이 이상한 응답: FUNCTION_RESPONSE_INVALID', async () => {
    respondMalformed();
    await renderScreen();

    await submit();

    expect(await screen.findByText('지금은 말씀을 찾지 못했어요. 잠시 후 다시 시도해주세요.')).toBeTruthy();
    expect(screen.getByLabelText('개발 진단').props.children).toBe('개발 진단: FUNCTION_RESPONSE_INVALID');
  });
});

describe('첫 화면 · 개발 진단 — 성공/정상 경로', () => {
  it('성공(recommend)이면 진단 문구가 없다', async () => {
    respondGate('recommend');
    await renderScreen();

    await submit();

    expect(router.push).toHaveBeenCalledWith('/scripture');
    expect(screen.queryByLabelText('개발 진단')).toBeNull();
  });

  it('route 전환(no_coverage 등)이면 진단 문구가 없다', async () => {
    respondGate('no_coverage');
    await renderScreen();

    await submit();

    expect(router.push).toHaveBeenCalledWith('/no-coverage');
    expect(screen.queryByLabelText('개발 진단')).toBeNull();
  });
});

describe('첫 화면 · 개발 진단 — 개인정보/호출 횟수', () => {
  it('진단 문구에 토큰·세션 원본·상황 문장이 들어가지 않는다', async () => {
    respondHttpFailure(401);
    await renderScreen();

    await submit();

    const diagnosticText = screen.getByLabelText('개발 진단').props.children as string;
    expect(diagnosticText.includes(FAKE_TOKEN)).toBe(false);
    expect(diagnosticText.includes(SITUATION)).toBe(false);
    expect(diagnosticText.includes('AuthApiError')).toBe(false);
    expect(diagnosticText.includes('Bearer')).toBe(false);
  });

  it('진단 추가로 서버 호출 횟수가 늘지 않는다(제출 1회 = invoke 1회)', async () => {
    respondHttpFailure(500);
    await renderScreen();

    await submit();
    await screen.findByLabelText('개발 진단');

    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
