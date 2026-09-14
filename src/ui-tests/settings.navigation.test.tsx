/**
 * 설정 화면 · 실제 라우터에서의 이탈 방지
 *
 * 실행: npm run test:ui
 *
 * expo-router/testing-library의 renderRouter로 실제 Expo Router(안에 든 React Navigation)를 띄운다.
 * 화면 부품을 흉내 내지 않고, 앱의 레이아웃·홈·설정 화면을 그대로 올린다.
 *
 * 확인하는 것:
 *   삭제 요청이나 이 기기 정리가 진행 중일 때, 설정 화면을 없애는 이동
 *   (back, replace, dismiss)이 실제 내비게이션 상태에서 막히는가.
 *   끝나면(성공·실패 모두) 다시 정상적으로 이동할 수 있는가.
 *   설정 화면이 하나 더 열려도 삭제 요청은 한 번뿐인가.
 *   navigate('/')처럼 설정 화면을 없애지 않고 위에 홈을 쌓는 이동은 막지 않는다.
 *   대신 그렇게 열린 홈에서 새 추천이 시작되지 않는가.
 *
 * 확인하지 않는 것:
 *   Android 기기의 실제 뒤로가기 버튼과 iOS의 실제 스와이프.
 *   Android 뒤로가기 버튼은 내비게이션 안에서 goBack을 부른다.
 *   여기서는 그와 같은 back을 직접 부를 뿐, 기기의 버튼 동작은 기기에서 확인해야 한다.
 *
 * 서버는 실제로 부르지 않는다. supabase 모듈을 가짜로 바꾸고, fetch도 막는다.
 */

import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { router } from 'expo-router';
import { act, fireEvent, renderRouter, screen, waitFor } from 'expo-router/testing-library';

import RootLayout from '@/app/_layout';
import SituationScreen from '@/app/index';
import SettingsScreen from '@/app/settings';

jest.mock('@/lib/supabase', () => ({
  supabase: {
    functions: { invoke: jest.fn() },
    auth: { getSession: jest.fn(), signOut: jest.fn(), signInAnonymously: jest.fn() },
  },
}));

/* eslint-disable @typescript-eslint/no-require-imports */
const { supabase } = require('@/lib/supabase') as {
  supabase: {
    functions: { invoke: jest.Mock };
    auth: { getSession: jest.Mock; signOut: jest.Mock; signInAnonymously: jest.Mock };
  };
};
/* eslint-enable @typescript-eslint/no-require-imports */

const { invoke } = supabase.functions;
const { getSession, signOut, signInAnonymously } = supabase.auth;

const SESSION = { access_token: 'NAV_TEST_TOKEN', user: { id: 'nav-test-user', is_anonymous: true } };
const present = { data: { session: SESSION }, error: null };
const absent = { data: { session: null }, error: null };
const DELETED = { data: { ok: true, deleted: true }, error: null, response: { status: 200 } };

const ROUTES = { _layout: RootLayout, index: SituationScreen, settings: SettingsScreen };

type Opened = {
  getPathname: () => string;
  /** 지금 스택에 쌓인 화면 이름들. 아래부터 위로. */
  getStackNames: () => string[];
};

/**
 * 홈에서 시작해 설정 화면을 연다. 뒤로 갈 곳(홈)이 있는 실제 스택이 된다.
 *
 * renderRouter의 결과는 Promise에 getPathname 등을 덧붙인 것이다.
 * async 함수에서 그대로 돌려주면 Promise가 풀리면서 그 함수들이 사라지므로 따로 감싸 돌려준다.
 */
async function openSettings(): Promise<Opened> {
  const view = renderRouter(ROUTES, { initialUrl: '/' });
  await view;
  await act(async () => {
    router.push('/settings');
  });
  expect(view.getPathname()).toBe('/settings');

  return {
    getPathname: () => view.getPathname(),
    getStackNames: () => {
      const root = view.getRouterState()?.routes?.[0] as
        | { state?: { routes?: Array<{ name: string }> } }
        | undefined;
      return root?.state?.routes?.map((route) => route.name) ?? [];
    },
  };
}

/** 서버 응답을 붙잡아 두고, 나중에 원하는 때 돌려준다. */
function holdInvoke() {
  const finishers: Array<(value: unknown) => void> = [];
  invoke.mockImplementation(() => new Promise((resolve) => finishers.push(resolve)));
  return finishers;
}

async function startDeletion() {
  await fireEvent.press(screen.getByLabelText('내 정보 삭제하기'));
  await fireEvent.press(screen.getByLabelText('삭제하기'));
}

/** 설정 화면을 스택에서 없애는 이동을 차례로 시도한다. */
async function tryToRemoveSettings() {
  await act(async () => {
    router.back();
  });
  await act(async () => {
    router.replace('/');
  });
  await act(async () => {
    router.dismiss();
  });
}

beforeAll(() => {
  global.fetch = (() => {
    throw new Error('이 테스트는 실제 서버를 부르지 않아야 합니다.');
  }) as unknown as typeof fetch;
});

beforeEach(() => {
  invoke.mockReset();
  getSession.mockReset();
  signOut.mockReset();
  signInAnonymously.mockReset();
  signOut.mockResolvedValue({ error: null } as never);
});

describe('설정 화면 · 실제 라우터 · 삭제 요청 대기 중', () => {
  it('뒤로가기·교체·닫기로 설정 화면을 없앨 수 없고, 끝나면 이동할 수 있다', async () => {
    getSession.mockResolvedValueOnce(present as never).mockResolvedValueOnce(absent as never);
    const finishers = holdInvoke();
    const view = await openSettings();

    await startDeletion();
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    expect(screen.getByLabelText('삭제하고 있어요')).toBeTruthy();

    await tryToRemoveSettings();
    expect(view.getPathname()).toBe('/settings');
    expect(view.getStackNames()).toEqual(['index', 'settings']);
    expect(screen.getByLabelText('삭제하고 있어요')).toBeTruthy();

    // 끝나면 다시 정상적으로 이동할 수 있다.
    await act(async () => {
      finishers[0](DELETED);
    });
    expect(await screen.findByText('삭제했어요.')).toBeTruthy();

    await act(async () => {
      router.back();
    });
    expect(view.getPathname()).toBe('/');
    expect(view.getStackNames()).toEqual(['index']);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('실패로 끝나도 잠금이 풀리고 이동할 수 있다', async () => {
    getSession.mockResolvedValueOnce(present as never);
    const finishers = holdInvoke();
    const view = await openSettings();

    await startDeletion();
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    await tryToRemoveSettings();
    expect(view.getPathname()).toBe('/settings');

    await act(async () => {
      finishers[0]({
        data: null,
        error: { name: 'FunctionsHttpError', context: { status: 503, json: async () => null } },
      });
    });
    expect(
      await screen.findByText('삭제 여부를 확인하지 못했어요. 잠시 후 다시 시도해 주세요.'),
    ).toBeTruthy();
    expect(signOut).not.toHaveBeenCalled();

    await act(async () => {
      router.back();
    });
    expect(view.getPathname()).toBe('/');
  });

  it('설정 화면이 하나 더 열려도 삭제 요청은 한 번뿐이다', async () => {
    getSession.mockResolvedValueOnce(present as never).mockResolvedValueOnce(absent as never);
    const finishers = holdInvoke();
    const view = await openSettings();

    await startDeletion();
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));

    // 화면을 없애는 이동은 막히지만, 위에 새로 여는 것은 막지 않는다(예: 주소로 다시 열기).
    await act(async () => {
      router.push('/settings');
    });
    expect(view.getStackNames()).toEqual(['index', 'settings', 'settings']);

    // 새로 열린 화면도 진행 중인 작업을 보여 주고, 삭제 버튼을 내놓지 않는다.
    expect(screen.getAllByLabelText('삭제하고 있어요').length).toBeGreaterThanOrEqual(1);
    expect(screen.queryAllByLabelText('내 정보 삭제하기')).toHaveLength(0);

    await act(async () => {
      finishers[0](DELETED);
    });
    await waitFor(() => expect(screen.getAllByText('삭제했어요.').length).toBeGreaterThanOrEqual(1));
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it('홈을 위에 쌓는 이동은 설정 화면을 없애지 않고, 그 홈에서 새 추천이 시작되지 않는다', async () => {
    getSession.mockResolvedValueOnce(present as never).mockResolvedValueOnce(absent as never);
    const finishers = holdInvoke();
    const view = await openSettings();

    await startDeletion();
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));

    // navigate('/')는 설정 화면을 없애지 않고 그 위에 홈을 새로 쌓는다.
    await act(async () => {
      router.navigate('/');
    });
    expect(view.getPathname()).toBe('/');
    expect(view.getStackNames()).toEqual(['index', 'settings', 'index']);

    // 맨 위에 열린 홈에서 상황을 제출해도 추천은 시작되지 않는다.
    const inputs = screen.getAllByLabelText('지금 나의 상황');
    const buttons = screen.getAllByLabelText('말씀을 찾아주세요');
    await fireEvent.changeText(inputs[inputs.length - 1], 'NAV_TEST_상황');
    await fireEvent.press(buttons[buttons.length - 1]);

    expect(screen.getByText('내 정보 삭제가 끝난 뒤에 다시 시도해주세요.')).toBeTruthy();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0][0]).toBe('delete-my-data');
    expect(signInAnonymously).not.toHaveBeenCalled();

    // 삭제 작업은 아래에 남은 설정 화면과 상관없이 끝까지 진행된다.
    await act(async () => {
      finishers[0](DELETED);
    });
    await waitFor(() => expect(signOut).toHaveBeenCalledTimes(1));
  });
});

describe('설정 화면 · 실제 라우터 · 이 기기 정리 대기 중', () => {
  it('정리를 다시 하는 동안에도 화면을 없앨 수 없고, 끝나면 이동할 수 있다', async () => {
    // 첫 정리는 실패한다(정리 뒤에도 로그인 정보가 남음).
    getSession.mockResolvedValueOnce(present as never).mockResolvedValueOnce(present as never);
    invoke.mockResolvedValue(DELETED as never);
    const view = await openSettings();

    await startDeletion();
    expect(await screen.findByText('서버 기록은 삭제했어요.')).toBeTruthy();

    // 다시 정리할 때는 signOut을 붙잡아 둔다.
    let releaseSignOut: (value: unknown) => void = () => {};
    signOut.mockImplementation(() => new Promise((resolve) => (releaseSignOut = resolve)));
    getSession.mockResolvedValueOnce(absent as never);

    await fireEvent.press(screen.getByLabelText('이 기기 정리 다시 시도'));
    expect(await screen.findByLabelText('이 기기를 정리하고 있어요')).toBeTruthy();

    await tryToRemoveSettings();
    expect(view.getPathname()).toBe('/settings');
    expect(view.getStackNames()).toEqual(['index', 'settings']);

    await act(async () => {
      releaseSignOut({ error: null });
    });
    expect(await screen.findByText('삭제했어요.')).toBeTruthy();
    // 서버에 삭제를 다시 요청하지 않았다.
    expect(invoke).toHaveBeenCalledTimes(1);

    await act(async () => {
      router.back();
    });
    expect(view.getPathname()).toBe('/');
  });
});

describe('설정 화면 · 실제 라우터 · 작업이 없을 때', () => {
  it('평소에는 뒤로가기가 막히지 않는다', async () => {
    const view = await openSettings();

    await act(async () => {
      router.back();
    });

    expect(view.getPathname()).toBe('/');
    expect(invoke).not.toHaveBeenCalled();
  });
});
