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
import { act, fireEvent, render, screen } from '@testing-library/react-native';

import SituationScreen from '@/app/index';
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
const { router } = require('expo-router') as { router: { push: jest.Mock; replace: jest.Mock } };
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

const respondHttpFailure = (status: number, retryAfter?: string) =>
  invoke.mockResolvedValue({
    data: null,
    error: {
      context: {
        status,
        headers: { get: (name: string) => name.toLowerCase() === 'retry-after' ? retryAfter ?? null : null },
      },
    },
  } as never);

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

  it('429: 서버가 계산한 남은 시간 + FUNCTION_HTTP_429', async () => {
    respondHttpFailure(429, '43200');
    await renderScreen();

    await submit();

    expect(await screen.findByText('약 12시간 후 다시 말씀을 찾아주세요.')).toBeTruthy();
    expect(screen.getByLabelText('개발 진단').props.children).toBe('개발 진단: FUNCTION_HTTP_429');
  });

  it('429에 안전한 대기시간이 없으면 기존 안내를 사용한다', async () => {
    respondHttpFailure(429, 'not-a-number');
    await renderScreen();

    await submit();

    expect(await screen.findByText('잠시 쉬었다가 다시 말씀을 찾아주세요.')).toBeTruthy();
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
    // 단일 상황 경로도 push다 — 뒤로가기로 입력 화면에 돌아올 수 있어야 한다.
    expect(router.replace).not.toHaveBeenCalled();
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

/* ================================================================== */
/* 개인정보 및 내 정보 · 내 정보 삭제와 겹칠 때                          */
/* ================================================================== */

/** 화면 밖에서 앱 상태를 보고 바꾸기 위한 창. */
let probe: ReturnType<typeof useSituation> | null = null;
function Probe() {
  probe = useSituation();
  return null;
}

const renderWithProbe = () =>
  render(
    <SituationProvider>
      <Probe />
      <SituationScreen />
    </SituationProvider>,
  );

const RECOMMEND_RESPONSE = {
  data: { ok: true, result: { route: 'recommend', selectedCardId: 'SC-001' } },
  error: null,
};

describe('첫 화면 · 개인정보 및 내 정보', () => {
  it('하단 링크로 설정 화면에 간다', async () => {
    await renderWithProbe();

    await fireEvent.press(screen.getByLabelText('개인정보 및 내 정보'));

    expect(router.push).toHaveBeenCalledWith('/settings');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('말씀을 찾는 동안에는 링크가 비활성이고, 끝나면 다시 쓸 수 있다', async () => {
    const finishers: Array<(value: unknown) => void> = [];
    invoke.mockImplementation(() => new Promise((resolve) => finishers.push(resolve)));
    await renderWithProbe();

    await fireEvent.changeText(screen.getByLabelText('지금 나의 상황'), SITUATION);
    // 답을 기다리는 동안은 끝나지 않으므로 기다리지 않는다.
    const pressing = fireEvent.press(screen.getByLabelText('말씀을 찾아주세요'));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const link = screen.getByLabelText('개인정보 및 내 정보');
    expect(link.props.accessibilityState).toMatchObject({ disabled: true });
    expect(probe!.isRecommending).toBe(true);

    await fireEvent.press(link);
    expect(router.push).not.toHaveBeenCalledWith('/settings');

    await act(async () => {
      finishers[0]({ data: null, error: { context: { status: 503 } } });
    });
    await pressing;

    expect(probe!.isRecommending).toBe(false);
    expect(screen.getByLabelText('개인정보 및 내 정보').props.accessibilityState).toMatchObject({
      disabled: false,
    });
  });

  it('기다리는 동안 내 정보가 삭제되면, 늦게 온 추천을 버리고 화면을 옮기지 않는다', async () => {
    invoke.mockImplementation(async () => {
      // 추천 답보다 삭제가 먼저 끝난 상황.
      probe!.clearAfterDataDeletion();
      return RECOMMEND_RESPONSE;
    });
    await renderWithProbe();

    await submit();
    await screen.findByLabelText('말씀을 찾아주세요');

    expect(invoke).toHaveBeenCalledTimes(1);
    // 지운 말씀을 되살리지 않고, 다른 화면으로 옮기지 않는다.
    expect(router.push).not.toHaveBeenCalled();
    expect(probe!.selectedCardId).toBeNull();
    expect(probe!.situation).toBe('');
    expect(screen.getByLabelText('지금 나의 상황').props.value).toBe('');
    expect(probe!.isRecommending).toBe(false);
    expect(signInAnonymously).not.toHaveBeenCalled();
  });

  it('늦게 온 실패도 삭제 뒤에는 안내를 띄우지 않는다', async () => {
    invoke.mockImplementation(async () => {
      probe!.clearAfterDataDeletion();
      return { data: null, error: { context: { status: 503 } } };
    });
    await renderWithProbe();

    await submit();
    await screen.findByLabelText('말씀을 찾아주세요');

    expect(screen.queryByText('지금은 말씀을 찾지 못했어요. 잠시 후 다시 시도해주세요.')).toBeNull();
    expect(router.push).not.toHaveBeenCalled();
  });

  it('삭제 뒤에는 새 익명 이용자를 만들지 않고, 다음에 직접 제출할 때만 만든다', async () => {
    await renderWithProbe();

    await act(async () => probe!.clearAfterDataDeletion());
    expect(signInAnonymously).not.toHaveBeenCalled();
    expect(getSession).not.toHaveBeenCalled();

    // 이 기기에 로그인 정보가 없는 상태에서 사용자가 다시 상황을 제출한다.
    getSession.mockResolvedValue({ data: { session: null }, error: null } as never);
    signInAnonymously.mockResolvedValue({
      data: { session: { user: { is_anonymous: true } } },
      error: null,
    } as never);
    respondGate('recommend');

    await submit();

    expect(router.push).toHaveBeenCalledWith('/scripture');
    expect(signInAnonymously).toHaveBeenCalledTimes(1);
  });

  it('내 정보 삭제 작업이 진행 중이면 새 추천을 시작하지 않고, 끝나면 다시 시작할 수 있다', async () => {
    await renderWithProbe();

    // 설정 화면에서 시작한 삭제 작업이 아직 끝나지 않았다.
    let finish: (value: 'unconfirmed') => void = () => {};
    await act(async () => {
      void probe!.runDeletionTask(
        'deleting',
        () => new Promise<'unconfirmed'>((resolve) => (finish = resolve)),
      );
    });
    expect(probe!.deletionTask).toBe('deleting');

    await submit();

    expect(screen.getByText('내 정보 삭제가 끝난 뒤에 다시 시도해주세요.')).toBeTruthy();
    expect(invoke).not.toHaveBeenCalled();
    expect(getSession).not.toHaveBeenCalled();
    expect(signInAnonymously).not.toHaveBeenCalled();
    expect(probe!.isRecommending).toBe(false);

    await act(async () => finish('unconfirmed'));
    expect(probe!.deletionTask).toBe('idle');

    respondGate('recommend');
    await submit();

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenCalledWith('/scripture');
  });

  it('추천을 기다리는 동안에는 삭제 작업이 시작되지 않는다', async () => {
    const finishers: Array<(value: unknown) => void> = [];
    invoke.mockImplementation(() => new Promise((resolve) => finishers.push(resolve)));
    await renderWithProbe();

    await fireEvent.changeText(screen.getByLabelText('지금 나의 상황'), SITUATION);
    const pressing = fireEvent.press(screen.getByLabelText('말씀을 찾아주세요'));
    await new Promise((resolve) => setTimeout(resolve, 0));

    let started: boolean | null = null;
    await act(async () => {
      started = await probe!.runDeletionTask('deleting', async () => 'deleted');
    });
    expect(started).toBe(false);
    expect(probe!.deletionTask).toBe('idle');

    await act(async () => {
      finishers[0]({ data: null, error: { context: { status: 503 } } });
    });
    await pressing;
    expect(probe!.isRecommending).toBe(false);
  });
});

/* ================================================================== */
/* 영역 선택(domain_choice)                                            */
/* ================================================================== */

const DOMAIN_CHOICE_OPTIONS = [
  { domain: 'fear_uncertainty', resolution: 'recommend', selectedCardId: 'SC-001' },
  { domain: 'financial_hardship', resolution: 'no_coverage', selectedCardId: null },
];

describe('첫 화면 · 영역 선택(domain_choice)', () => {
  it('domain_choice면 옵션을 저장하고 영역 선택 화면으로 이동하며, 진단 문구가 없다', async () => {
    respondGate('domain_choice', {
      primaryDomain: null,
      domainChoiceCandidates: ['fear_uncertainty', 'financial_hardship'],
      domainChoiceOptions: DOMAIN_CHOICE_OPTIONS,
    });
    await renderWithProbe();

    await submit();

    expect(router.push).toHaveBeenCalledWith('/domain-choice');
    // 복합 상황 경로는 push로만 구성된다 — 선택 화면이 스택에 남아야 뒤로가기로 돌아올 수 있다.
    expect(router.replace).not.toHaveBeenCalled();
    expect(probe!.domainChoiceOptions).toEqual(DOMAIN_CHOICE_OPTIONS);
    expect(probe!.selectedCardId).toBeNull();
    expect(probe!.selectedDomain).toBeNull();
    expect(screen.queryByLabelText('개발 진단')).toBeNull();
  });

  it('새로 제출할 때 이전 추천의 카드·영역·옵션이 남아 있지 않는다', async () => {
    respondGate('recommend');
    await renderWithProbe();
    await submit();
    expect(probe!.selectedCardId).toBe('SC-001');
    expect(probe!.selectedDomain).toBe('fear_uncertainty');

    respondGate('domain_choice', {
      primaryDomain: null,
      domainChoiceCandidates: ['fear_uncertainty', 'financial_hardship'],
      domainChoiceOptions: DOMAIN_CHOICE_OPTIONS,
    });
    await submit();

    expect(probe!.selectedCardId).toBeNull();
    expect(probe!.selectedDomain).toBeNull();
    expect(probe!.domainChoiceOptions).toEqual(DOMAIN_CHOICE_OPTIONS);
  });

  it('영역이나 카드 관계가 이상한 domain_choice 응답은 일반 오류로 처리하고 옮기지 않는다', async () => {
    respondGate('domain_choice', {
      primaryDomain: null,
      // 후보 순서와 option의 domain 순서가 다르다.
      domainChoiceCandidates: ['fear_uncertainty', 'financial_hardship'],
      domainChoiceOptions: [
        { domain: 'financial_hardship', resolution: 'no_coverage', selectedCardId: null },
        { domain: 'fear_uncertainty', resolution: 'recommend', selectedCardId: 'SC-001' },
      ],
    });
    await renderWithProbe();

    await submit();

    expect(await screen.findByText('지금은 말씀을 찾지 못했어요. 잠시 후 다시 시도해주세요.')).toBeTruthy();
    expect(router.push).not.toHaveBeenCalled();
    expect(probe!.domainChoiceOptions).toEqual([]);
  });
});
