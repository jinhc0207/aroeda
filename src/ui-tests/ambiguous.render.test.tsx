/**
 * ambiguous 화면 · 뒤로가기 내비게이션 계약
 *
 * 실행: npm run test:ui
 *
 * 2026-09-15 back navigation fix로 domain-choice → ambiguous 경로가 push로 바뀌면서,
 * 이 화면의 "조금 더 이야기하기"가 실제로 canGoBack 계약을 지키는지가 중요해졌다.
 * 스택에 이전 화면(도메인 선택 등)이 있으면 되돌아가야지, 매번 홈으로 이동해 버리면
 * 사용자가 domain_choice의 다른 후보를 다시 고를 수 없다.
 */

import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen } from '@testing-library/react-native';

import AmbiguousScreen from '@/app/ambiguous';

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: jest.fn(() => false) },
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { router } = require('expo-router') as {
  router: { push: jest.Mock; replace: jest.Mock; back: jest.Mock; canGoBack: jest.Mock };
};

beforeEach(() => {
  router.push.mockReset();
  router.replace.mockReset();
  router.back.mockReset();
  router.canGoBack.mockReset();
});

describe('ambiguous 화면 · 뒤로가기 계약', () => {
  it('뒤로 갈 곳이 있으면(canGoBack true) router.back()을 쓴다 — 선택 화면으로 돌아간다', async () => {
    router.canGoBack.mockReturnValue(true);
    await render(<AmbiguousScreen />);

    await fireEvent.press(screen.getByLabelText('조금 더 이야기하기'));

    expect(router.back).toHaveBeenCalledTimes(1);
    expect(router.replace).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
  });

  it('뒤로 갈 곳이 없으면(canGoBack false) 홈으로 replace한다', async () => {
    router.canGoBack.mockReturnValue(false);
    await render(<AmbiguousScreen />);

    await fireEvent.press(screen.getByLabelText('조금 더 이야기하기'));

    expect(router.replace).toHaveBeenCalledWith('/');
    expect(router.back).not.toHaveBeenCalled();
  });
});
