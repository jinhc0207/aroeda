/**
 * 개인정보 및 내 정보 화면 · 실제 렌더 테스트
 *
 * 실행: npm run test:ui
 *
 * 되돌릴 수 없는 삭제를 시작하는 화면이다. 지켜야 할 약속:
 *   1. 확인하기 전에는 서버에 아무것도 보내지 않는다. 연속으로 눌러도 요청은 한 번이다.
 *   2. 서버가 삭제를 확인하기 전에는 이 기기의 로그인 정보를 지우지 않는다.
 *   3. 확인하지 못한 것을 "삭제했어요"라고 말하지 않는다. 결과마다 정확한 말을 한다.
 *   4. 삭제 흐름이 새 익명 이용자를 만들지 않는다.
 *   5. 사용자 번호, 토큰은 화면에 나오지 않는다.
 *
 * 서버는 실제로 부르지 않는다. supabase 모듈을 통째로 가짜로 바꾸고, fetch도 막는다.
 */

import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Linking } from 'react-native';

import SettingsScreen, { PRIVACY_POLICY_URL } from '@/app/settings';
import { SituationProvider, useSituation } from '@/state/situation';

/*
 * 이 파일은 실제 내비게이션을 쓰지 않는다. 화면이 이탈 방지를 어떻게 요청하는지(hook 계약)만 본다.
 *   beforeRemove에 무엇을 등록하는지, Stack.Screen에 어떤 옵션을 주는지를 기록한다.
 * 실제 라우터에서 화면 제거가 막히는지는 settings.navigation.test.tsx가 확인한다.
 */
jest.mock('expo-router', () => {
  const listeners: Array<{ event: string; callback: (event: unknown) => void; removed: boolean }> = [];
  const screenOptions: Array<Record<string, unknown>> = [];
  return {
    router: { push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: jest.fn(() => true) },
    useNavigation: () => ({
      addListener: (event: string, callback: (event: unknown) => void) => {
        const entry = { event, callback, removed: false };
        listeners.push(entry);
        return () => {
          entry.removed = true;
        };
      },
    }),
    Stack: {
      Screen: ({ options }: { options: Record<string, unknown> }) => {
        screenOptions.push(options);
        return null;
      },
    },
    __navigationRecords: { listeners, screenOptions },
  };
});

jest.mock('@/lib/supabase', () => ({
  supabase: {
    functions: { invoke: jest.fn() },
    auth: { getSession: jest.fn(), signOut: jest.fn(), signInAnonymously: jest.fn() },
  },
}));

/* eslint-disable @typescript-eslint/no-require-imports */
const { router } = require('expo-router') as {
  router: { push: jest.Mock; replace: jest.Mock; back: jest.Mock; canGoBack: jest.Mock };
};
const { supabase } = require('@/lib/supabase') as {
  supabase: {
    functions: { invoke: jest.Mock };
    auth: { getSession: jest.Mock; signOut: jest.Mock; signInAnonymously: jest.Mock };
  };
};
/* eslint-enable @typescript-eslint/no-require-imports */

const { invoke } = supabase.functions;
const { getSession, signOut, signInAnonymously } = supabase.auth;
const openURL = jest.spyOn(Linking, 'openURL');

const FAKE_UID = '11111111-2222-3333-4444-555555555555';
const FAKE_TOKEN = 'UI_TEST_ACCESS_TOKEN_SHOULD_NEVER_LEAK';
const SITUATION = 'UI_TEST_삭제_전에_남아_있던_상황';
const SESSION = { access_token: FAKE_TOKEN, user: { id: FAKE_UID, is_anonymous: true } };

const COPY = {
  deleted: '삭제했어요.',
  localFailed: '서버 기록은 삭제했어요.',
  unconfirmed: '삭제 여부를 확인하지 못했어요. 잠시 후 다시 시도해 주세요.',
  noSession: '이 기기에서 삭제할 서버 기록을 확인할 수 없어요.',
  unreadable: '이 기기의 로그인 정보를 확인하지 못했어요. 잠시 후 다시 시도해 주세요.',
  notAnonymous: '익명 이용자로 확인되지 않아 삭제하지 않았어요.',
};

/** 화면 밖에서 앱 상태를 넣고 확인하기 위한 창. */
let probe: ReturnType<typeof useSituation> | null = null;
function Probe() {
  probe = useSituation();
  return null;
}

const renderSettings = async () => {
  await render(
    <SituationProvider>
      <Probe />
      <SettingsScreen />
    </SituationProvider>,
  );
  // 삭제 전에 앱이 들고 있던 상황과 말씀.
  await act(async () => {
    probe!.setSituation(SITUATION);
    probe!.setSelectedCardId('SC-001');
  });
};

const present = { data: { session: SESSION }, error: null };
const absent = { data: { session: null }, error: null };

/** getSession 답을 차례로 정한다. 첫 번째는 삭제 전 확인, 두 번째는 정리 뒤 확인. */
const sessions = (...answers: unknown[]) => {
  for (const answer of answers) getSession.mockResolvedValueOnce(answer as never);
};

const respondDeleted = () =>
  invoke.mockResolvedValue({
    data: { ok: true, deleted: true },
    error: null,
    response: { status: 200 },
  } as never);

const respondHttp = (status: number, body: unknown = null) =>
  invoke.mockResolvedValue({
    data: null,
    error: { name: 'FunctionsHttpError', context: { status, json: async () => body } },
  } as never);

const confirmDeletion = async () => {
  await fireEvent.press(screen.getByLabelText('내 정보 삭제하기'));
  await fireEvent.press(screen.getByLabelText('삭제하기'));
};

const renderedText = () => JSON.stringify(screen.toJSON());

beforeAll(() => {
  global.fetch = (() => {
    throw new Error('설정 화면은 이 테스트에서 실제 서버를 부르지 않아야 합니다.');
  }) as unknown as typeof fetch;
});

beforeEach(() => {
  invoke.mockReset();
  getSession.mockReset();
  signOut.mockReset();
  signInAnonymously.mockReset();
  openURL.mockReset();
  openURL.mockResolvedValue(true);
  router.back.mockReset();
  router.replace.mockReset();
  router.canGoBack.mockReturnValue(true);
  signOut.mockResolvedValue({ error: null } as never);
  probe = null;
});

/* ================================================================== */
/* A. 확인 전에는 아무것도 보내지 않는다                                 */
/* ================================================================== */

describe('설정 화면 · 확인 전', () => {
  it('무엇이 지워지고 무엇이 지워지지 않는지 사실대로 알린다', async () => {
    await renderSettings();

    expect(screen.getByText('개인정보 및 내 정보')).toBeTruthy();
    expect(screen.getByText(/익명 이용자 식별자가 하나/)).toBeTruthy();
    expect(screen.getByText(/개발자 서버에 있는 익명 이용자 식별자와, 그 식별자에 연결된 사용 횟수 기록이/)).toBeTruthy();
    expect(screen.getByText(/영역별 집계와, 외부 서비스가 자체 정책에 따라 보관하는 기록은/)).toBeTruthy();

    // 과장된 약속을 하지 않는다.
    for (const banned of ['기기를 구분하는 번호', '앱을 삭제하면', '모든 정보가', '모두 삭제']) {
      expect(renderedText().includes(banned)).toBe(false);
    }
  });

  it('화면에 들어오기만 해서는 서버도 로그인 정보도 건드리지 않는다', async () => {
    await renderSettings();

    expect(invoke).not.toHaveBeenCalled();
    expect(getSession).not.toHaveBeenCalled();
    expect(signOut).not.toHaveBeenCalled();
  });

  it('삭제하기를 누르면 확인만 묻고 요청하지 않는다', async () => {
    await renderSettings();

    await fireEvent.press(screen.getByLabelText('내 정보 삭제하기'));

    expect(screen.getByText('정말 삭제할까요?')).toBeTruthy();
    expect(screen.getByText(/삭제한 뒤에는 되돌릴 수 없어요/)).toBeTruthy();
    expect(invoke).not.toHaveBeenCalled();
    expect(getSession).not.toHaveBeenCalled();
  });

  it('취소하면 처음으로 돌아가고 요청하지 않는다', async () => {
    await renderSettings();

    await fireEvent.press(screen.getByLabelText('내 정보 삭제하기'));
    await fireEvent.press(screen.getByLabelText('취소'));

    expect(screen.getByLabelText('내 정보 삭제하기')).toBeTruthy();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('확인을 연속으로 눌러도 요청은 한 번이다', async () => {
    sessions(present, absent);
    respondDeleted();
    await renderSettings();

    await fireEvent.press(screen.getByLabelText('내 정보 삭제하기'));
    // 화면이 다시 그려지기 전에 같은 버튼이 세 번 눌린 상황.
    // 하나의 act 안에서 누르면, 세 번째까지 누를 동안 화면이 다시 그려지지 않는다.
    const confirm = screen.getByLabelText('삭제하기');
    await act(async () => {
      void fireEvent.press(confirm);
      void fireEvent.press(confirm);
      void fireEvent.press(confirm);
    });

    expect(await screen.findByText(COPY.deleted)).toBeTruthy();
    expect(invoke).toHaveBeenCalledTimes(1);
    // 로그인 정보 확인도 한 번의 흐름만큼만(삭제 전 1번, 정리 뒤 1번) 일어났다.
    expect(getSession).toHaveBeenCalledTimes(2);
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it('말씀을 찾는 중에는 삭제를 시작할 수 없다', async () => {
    await renderSettings();
    await act(async () => {
      probe!.beginRecommendation();
    });

    expect(screen.getByText('말씀을 찾는 중에는 삭제를 시작할 수 없어요.')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('내 정보 삭제하기'));

    expect(screen.queryByText('정말 삭제할까요?')).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });
});

/* ================================================================== */
/* B. 서버가 삭제를 확인한 경우                                          */
/* ================================================================== */

describe('설정 화면 · 삭제 확인', () => {
  it('서버 확인 뒤에 로그인 정보를 정리하고, 앱 상태도 비운다', async () => {
    sessions(present, absent);
    respondDeleted();
    await renderSettings();

    await confirmDeletion();

    expect(await screen.findByText(COPY.deleted)).toBeTruthy();
    expect(screen.getByText(/이 기기의 로그인 정보도 정리했어요/)).toBeTruthy();

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0][0]).toBe('delete-my-data');
    expect(signOut).toHaveBeenCalledWith({ scope: 'local' });
    // 서버 요청이 먼저, 로그인 정보 정리가 나중이다.
    expect(signOut.mock.invocationCallOrder[0]).toBeGreaterThan(invoke.mock.invocationCallOrder[0]);

    expect(probe!.situation).toBe('');
    expect(probe!.selectedCardId).toBeNull();
    expect(signInAnonymously).not.toHaveBeenCalled();
  });

  it('처음으로 돌아가기는 뒤로 간다', async () => {
    sessions(present, absent);
    respondDeleted();
    await renderSettings();
    await confirmDeletion();
    await screen.findByText(COPY.deleted);

    await fireEvent.press(screen.getByLabelText('처음으로 돌아가기'));

    expect(router.back).toHaveBeenCalledTimes(1);
  });
});

/* ================================================================== */
/* C. 로그인 정보 정리가 확인되지 않은 경우                              */
/* ================================================================== */

describe('설정 화면 · 이 기기 정리 실패', () => {
  it('서버 삭제와 기기 정리 실패를 구분해 알리고, 정리만 다시 한다', async () => {
    // 정리 뒤에도 로그인 정보가 남아 있다.
    sessions(present, present);
    respondDeleted();
    await renderSettings();

    await confirmDeletion();

    expect(await screen.findByText(COPY.localFailed)).toBeTruthy();
    expect(screen.getByText(/이 기기에 남은 로그인 정보를 정리하지 못했어요/)).toBeTruthy();

    // 다시 시도: 이번에는 정리된다.
    sessions(absent);
    await fireEvent.press(screen.getByLabelText('이 기기 정리 다시 시도'));

    expect(await screen.findByText(COPY.deleted)).toBeTruthy();
    // 서버에 삭제를 다시 요청하지 않았다.
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(signOut).toHaveBeenCalledTimes(2);
  });

  it('signOut이 예외를 던지고 로그인 정보가 남으면 성공이라 하지 않는다', async () => {
    sessions(present, present);
    respondDeleted();
    signOut.mockRejectedValue(new Error('storage') as never);
    await renderSettings();

    await confirmDeletion();

    expect(await screen.findByText(COPY.localFailed)).toBeTruthy();
    expect(screen.queryByText(COPY.deleted)).toBeNull();
  });

  it('signOut이 오류를 돌려줘도 로그인 정보가 없으면 정리된 것이다', async () => {
    sessions(present, absent);
    respondDeleted();
    signOut.mockResolvedValue({ error: { name: 'AuthRetryableFetchError' } } as never);
    await renderSettings();

    await confirmDeletion();

    expect(await screen.findByText(COPY.deleted)).toBeTruthy();
  });
});

/* ================================================================== */
/* D. 삭제하지 않았거나 확인하지 못한 경우                                */
/* ================================================================== */

describe('설정 화면 · 삭제되지 않은 경우', () => {
  it('로그인 정보가 없으면 서버에 묻지 않고, "서버에도 없다"고 말하지 않는다', async () => {
    sessions(absent);
    await renderSettings();

    await confirmDeletion();

    expect(await screen.findByText(COPY.noSession)).toBeTruthy();
    expect(invoke).not.toHaveBeenCalled();
    expect(signOut).not.toHaveBeenCalled();
    expect(renderedText().includes('삭제할 데이터가 없')).toBe(false);
    expect(probe!.situation).toBe(SITUATION);
  });

  it('로그인 정보를 읽지 못한 것은 "없음"과 다르게 알린다', async () => {
    sessions({ data: { session: null }, error: { name: 'AuthError' } });
    await renderSettings();

    await confirmDeletion();

    expect(await screen.findByText(COPY.unreadable)).toBeTruthy();
    expect(screen.getByText('아직 서버에 삭제를 요청하지 않았어요.')).toBeTruthy();
    expect(screen.queryByText(COPY.noSession)).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  const unconfirmedCases: Array<[string, () => void]> = [
    ['401', () => respondHttp(401, { ok: false, error: 'DELETE_UNAUTHENTICATED' })],
    ['405', () => respondHttp(405, { ok: false, error: 'DELETE_METHOD_NOT_ALLOWED' })],
    ['503', () => respondHttp(503, { ok: false, error: 'DELETE_UNAVAILABLE' })],
    ['403 다른 본문', () => respondHttp(403, { ok: false, error: 'SOMETHING_ELSE' })],
    [
      '통신 실패·시간 초과',
      () => invoke.mockResolvedValue({ data: null, error: { name: 'FunctionsFetchError' } } as never),
    ],
    ['호출 예외', () => invoke.mockRejectedValue(new Error('network') as never)],
    [
      '2xx인데 약속과 다른 본문',
      () =>
        invoke.mockResolvedValue({ data: { ok: true }, error: null, response: { status: 200 } } as never),
    ],
  ];

  for (const [name, arrange] of unconfirmedCases) {
    it(`${name}: 확인 불가로 알리고 이 기기에서 아무것도 지우지 않는다`, async () => {
      sessions(present);
      arrange();
      await renderSettings();

      await confirmDeletion();

      expect(await screen.findByText(COPY.unconfirmed)).toBeTruthy();
      expect(screen.queryByText(COPY.deleted)).toBeNull();
      expect(signOut).not.toHaveBeenCalled();
      expect(probe!.situation).toBe(SITUATION);
      expect(signInAnonymously).not.toHaveBeenCalled();
    });
  }

  it('확인 불가 뒤 다시 시도는 확인 단계부터 다시 거친다', async () => {
    sessions(present);
    respondHttp(503);
    await renderSettings();
    await confirmDeletion();
    await screen.findByText(COPY.unconfirmed);

    await fireEvent.press(screen.getByLabelText('다시 시도'));

    expect(screen.getByText('정말 삭제할까요?')).toBeTruthy();
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('익명 이용자가 아니면 그렇게 알리고 아무것도 지우지 않는다', async () => {
    sessions(present);
    respondHttp(403, { ok: false, error: 'DELETE_NOT_ANONYMOUS' });
    await renderSettings();

    await confirmDeletion();

    expect(await screen.findByText(COPY.notAnonymous)).toBeTruthy();
    expect(signOut).not.toHaveBeenCalled();
    expect(probe!.situation).toBe(SITUATION);
  });
});

/* ================================================================== */
/* E. 민감정보                                                         */
/* ================================================================== */

describe('설정 화면 · 민감정보', () => {
  // 결과마다 한 번씩 따로 그린다. 한 테스트 안에서 여러 번 그렸다 지우지 않는다.
  const sensitiveCases: Array<[string, () => void]> = [
    [
      '삭제 확인',
      () => {
        sessions(present, absent);
        respondDeleted();
      },
    ],
    [
      '이 기기 정리 실패',
      () => {
        sessions(present, present);
        respondDeleted();
      },
    ],
    [
      '확인 불가',
      () => {
        sessions(present);
        respondHttp(401);
      },
    ],
    [
      '익명 아님',
      () => {
        sessions(present);
        respondHttp(403, { ok: false, error: 'DELETE_NOT_ANONYMOUS' });
      },
    ],
  ];

  for (const [name, arrange] of sensitiveCases) {
    it(`${name}: 사용자 번호와 토큰이 화면에 나오지 않는다`, async () => {
      arrange();
      await renderSettings();

      await confirmDeletion();
      await screen.findByLabelText(/처음으로 돌아가기|다시 시도/);

      const text = renderedText();
      expect(text.includes(FAKE_UID)).toBe(false);
      expect(text.includes(FAKE_TOKEN)).toBe(false);
    });
  }

  it('게시된 개인정보처리방침 링크를 열고 편집 주소나 가짜 주소를 만들지 않는다', async () => {
    await renderSettings();

    expect(screen.getByLabelText('개인정보처리방침 읽기')).toBeTruthy();
    expect(renderedText().includes('/edit')).toBe(false);

    await fireEvent.press(screen.getByLabelText('개인정보처리방침 읽기'));

    expect(openURL).toHaveBeenCalledTimes(1);
    expect(openURL).toHaveBeenCalledWith(PRIVACY_POLICY_URL);
  });
});

/* ================================================================== */
/* F. 이탈 방지 요청 (hook 계약)                                        */
/* ================================================================== */

/*
 * 실제 내비게이션이 아니다. 화면이 내비게이션에 무엇을 요청하는지만 기록해서 본다.
 * 실제로 막히는지는 settings.navigation.test.tsx가 실제 라우터로 확인한다.
 */

type NavigationRecords = {
  listeners: Array<{ event: string; callback: (event: unknown) => void; removed: boolean }>;
  screenOptions: Array<Record<string, unknown>>;
};

/* eslint-disable-next-line @typescript-eslint/no-require-imports */
const records = (require('expo-router') as { __navigationRecords: NavigationRecords })
  .__navigationRecords;

const activeBeforeRemove = () =>
  records.listeners.filter((entry) => entry.event === 'beforeRemove' && !entry.removed);
const lastScreenOptions = () => records.screenOptions[records.screenOptions.length - 1];

const DELETED_RESPONSE = { data: { ok: true, deleted: true }, error: null, response: { status: 200 } };

/** 서버 응답을 붙잡아 두고, 나중에 원하는 때 돌려준다. */
const holdInvoke = () => {
  const finishers: Array<(value: unknown) => void> = [];
  invoke.mockImplementation(() => new Promise((resolve) => finishers.push(resolve)));
  return finishers;
};

describe('설정 화면 · 이탈 방지 요청(hook 계약)', () => {
  beforeEach(() => {
    records.listeners.length = 0;
    records.screenOptions.length = 0;
  });

  it('작업이 없을 때는 막지 않는다', async () => {
    await renderSettings();

    expect(activeBeforeRemove()).toHaveLength(0);
    expect(lastScreenOptions()).toEqual({ gestureEnabled: true });
  });

  it('삭제 요청 대기 중에는 화면 제거를 막고 스와이프를 끄며, 끝나면 푼다', async () => {
    sessions(present, absent);
    const finishers = holdInvoke();
    await renderSettings();

    await confirmDeletion();
    await act(async () => {});
    expect(invoke).toHaveBeenCalledTimes(1);

    const active = activeBeforeRemove();
    expect(active).toHaveLength(1);
    const event = { preventDefault: jest.fn() };
    active[0].callback(event);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(lastScreenOptions()).toEqual({ gestureEnabled: false });
    expect(screen.getByLabelText('뒤로 가기').props.accessibilityState).toMatchObject({
      disabled: true,
    });

    await act(async () => {
      finishers[0](DELETED_RESPONSE);
    });
    expect(await screen.findByText(COPY.deleted)).toBeTruthy();
    expect(activeBeforeRemove()).toHaveLength(0);
    expect(lastScreenOptions()).toEqual({ gestureEnabled: true });
  });

  it('이 기기 정리 대기 중에도 막고, 끝나면 푼다', async () => {
    sessions(present, present);
    respondDeleted();
    await renderSettings();
    await confirmDeletion();
    await screen.findByText(COPY.localFailed);

    let releaseSignOut: (value: unknown) => void = () => {};
    signOut.mockImplementation(() => new Promise((resolve) => (releaseSignOut = resolve)));
    sessions(absent);
    await fireEvent.press(screen.getByLabelText('이 기기 정리 다시 시도'));

    expect(activeBeforeRemove()).toHaveLength(1);
    expect(lastScreenOptions()).toEqual({ gestureEnabled: false });

    await act(async () => {
      releaseSignOut({ error: null });
    });
    expect(await screen.findByText(COPY.deleted)).toBeTruthy();
    expect(activeBeforeRemove()).toHaveLength(0);
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});

/* ================================================================== */
/* G. 화면이 다시 만들어지거나 사라져도                                  */
/* ================================================================== */

describe('설정 화면 · 화면과 작업의 분리', () => {
  it('설정 화면이 두 개 떠 있어도 삭제 요청은 한 번뿐이다', async () => {
    sessions(present, absent);
    const finishers = holdInvoke();
    await render(
      <SituationProvider>
        <Probe />
        <SettingsScreen />
        <SettingsScreen />
      </SituationProvider>,
    );

    await fireEvent.press(screen.getAllByLabelText('내 정보 삭제하기')[0]);
    await fireEvent.press(screen.getByLabelText('삭제하기'));
    await act(async () => {});

    // 다른 화면도 진행 중인 작업을 보여 주고, 삭제 버튼을 내놓지 않는다.
    expect(screen.getAllByLabelText('삭제하고 있어요')).toHaveLength(2);
    expect(screen.queryAllByLabelText('내 정보 삭제하기')).toHaveLength(0);

    await act(async () => {
      finishers[0](DELETED_RESPONSE);
    });
    expect(await screen.findAllByText(COPY.deleted)).toHaveLength(2);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it('작업 중 화면이 사라져도, 서버가 확인한 삭제의 이 기기 정리는 끝까지 한다', async () => {
    sessions(present, absent);
    const finishers = holdInvoke();
    const view = await render(
      <SituationProvider>
        <Probe />
        <SettingsScreen />
      </SituationProvider>,
    );
    await act(async () => {
      probe!.setSituation(SITUATION);
    });

    await confirmDeletion();
    await act(async () => {});
    expect(invoke).toHaveBeenCalledTimes(1);

    // 화면이 사라진다. 앱 전체 상태는 그대로 남는다.
    await view.rerender(
      <SituationProvider>
        <Probe />
      </SituationProvider>,
    );
    expect(screen.queryByText('개인정보 및 내 정보')).toBeNull();

    await act(async () => {
      finishers[0](DELETED_RESPONSE);
    });

    // 사라진 화면 대신 앱 전체 상태에서 끝까지 정리했다.
    expect(signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(probe!.situation).toBe('');
    expect(probe!.deletionTask).toBe('idle');
    expect(probe!.deletionOutcome).toBe('deleted');

    // 다시 들어오면 결과를 볼 수 있다.
    await view.rerender(
      <SituationProvider>
        <Probe />
        <SettingsScreen />
      </SituationProvider>,
    );
    expect(screen.getByText(COPY.deleted)).toBeTruthy();
  });

  it('정리가 남은 결과는 화면을 떠났다 돌아와도 남아 있어 다시 정리할 수 있다', async () => {
    sessions(present, present);
    respondDeleted();
    const view = await render(
      <SituationProvider>
        <Probe />
        <SettingsScreen />
      </SituationProvider>,
    );
    await confirmDeletion();
    await screen.findByText(COPY.localFailed);

    await view.rerender(
      <SituationProvider>
        <Probe />
      </SituationProvider>,
    );
    await view.rerender(
      <SituationProvider>
        <Probe />
        <SettingsScreen />
      </SituationProvider>,
    );

    expect(screen.getByText(COPY.localFailed)).toBeTruthy();
    sessions(absent);
    await fireEvent.press(screen.getByLabelText('이 기기 정리 다시 시도'));
    expect(await screen.findByText(COPY.deleted)).toBeTruthy();
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('작업이 예외를 던져도 성공으로 바꾸지 않고 잠금을 푼다', async () => {
    await renderSettings();

    await act(async () => {
      await probe!.runDeletionTask('deleting', () => Promise.reject(new Error('boom')));
    });
    expect(probe!.deletionOutcome).toBe('unconfirmed');
    expect(probe!.deletionTask).toBe('idle');

    await act(async () => {
      await probe!.runDeletionTask('cleaning', () => Promise.reject(new Error('boom')));
    });
    // 정리 재시도는 서버 삭제가 확인된 뒤에만 하므로 그 사실은 유지한다.
    expect(probe!.deletionOutcome).toBe('deleted-local-cleanup-failed');
    expect(probe!.deletionTask).toBe('idle');

    // 잠금이 풀려 다음 작업을 시작할 수 있다.
    let started = false;
    await act(async () => {
      started = await probe!.runDeletionTask('cleaning', async () => 'deleted');
    });
    expect(started).toBe(true);
    expect(probe!.deletionOutcome).toBe('deleted');
  });
});
