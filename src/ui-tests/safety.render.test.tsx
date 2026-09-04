/**
 * 안전 화면 · 실제 렌더 테스트
 *
 * 실행: npm run test:ui
 *
 * 기존 safety-contacts.test.ts와 무엇이 다른가:
 *   그 테스트는 화면 원본을 "글자로 읽어서" 검사한다.
 *   이 테스트는 화면을 실제로 그린 다음, 그려진 결과에서 찾는다.
 *
 *   원본에 번호가 적혀 있는 것과
 *   그 번호가 실제로 사용자 눈에 보이는 것은 다른 이야기다.
 *   조건문 하나가 잘못 들어가면 앞의 검사는 통과하고 뒤의 검사만 실패한다.
 *   이 화면은 위급할 때 쓰는 화면이라 그 차이가 중요하다.
 *
 * 왜 await을 붙이는가:
 *   지금 쓰는 도구(RNTL 14)에서는 render와 press가 기다려야 하는 일이다.
 *   React 19가 화면을 곧바로 그리지 않고 나눠서 그리기 때문이다.
 *   기다리지 않으면 아직 그려지지 않은 화면을 들여다보게 된다.
 *
 * 이 테스트는 진짜 전화를 걸지 않는다.
 *   react-native의 Linking을 가짜로 바꿔 두었다.
 *   그래서 어느 번호를 눌러도 현실에서는 아무 일도 일어나지 않는다.
 *
 * 이 화면은 서버를 부르지 않으므로 Supabase 흉내도 만들지 않았다.
 * 필요 없는 가짜는 두지 않는다.
 */

// describe / it / expect / jest 를 여기서 직접 가져온다.
// 이 프로젝트의 TypeScript 설정은 전역 타입을 node 하나로 좁혀 두었고,
// 화면 테스트 하나 때문에 그 설정을 넓히지 않는 편이 안전하다.
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { Linking } from 'react-native';

import SafetyScreen from '@/app/safety';

// 화면이 쓰는 것만 최소로 흉내 낸다. 화면 이동 자체는 이 테스트의 대상이 아니다.
jest.mock('expo-router', () => ({
  router: {
    canGoBack: jest.fn(() => false),
    back: jest.fn(),
    replace: jest.fn(),
  },
}));

// 진짜 전화 앱을 열지 않도록 막는다.
const openURL = jest.spyOn(Linking, 'openURL');

beforeEach(() => {
  openURL.mockReset();
  openURL.mockResolvedValue(true);
});

/* ================================================================== */
/* 1. 번호가 실제로 화면에 보인다                                       */
/* ================================================================== */

describe('안전 화면 · 실제로 그려 보기', () => {
  it('네 곳의 번호가 화면에 보인다', async () => {
    await render(<SafetyScreen />);

    // 원본에 적혀 있는지가 아니라, 그려진 화면에서 찾는다.
    expect(screen.getByText('112')).toBeTruthy();
    expect(screen.getByText('119')).toBeTruthy();
    expect(screen.getByText('109')).toBeTruthy();
    expect(screen.getByText('1577-0199')).toBeTruthy();
  });

  it('어디에 거는 곳인지도 함께 보인다', async () => {
    await render(<SafetyScreen />);

    expect(screen.getByText('경찰')).toBeTruthy();
    expect(screen.getByText('구급·응급')).toBeTruthy();
    expect(screen.getByText('자살예방 상담')).toBeTruthy();
    expect(screen.getByText('정신건강 위기상담')).toBeTruthy();
  });

  it('24시간이라는 안내가 화면에 보인다', async () => {
    await render(<SafetyScreen />);

    // 쓰임 설명 뒤에 붙여 그리므로 한 덩어리 안에서 찾는다.
    expect(screen.getByText(/24시간/)).toBeTruthy();
  });

  it('어느 나라 번호인지 화면에 보인다', async () => {
    await render(<SafetyScreen />);

    expect(screen.getByText('대한민국 기준')).toBeTruthy();
  });

  it('안전이 먼저라는 말이 화면에 남아 있다', async () => {
    await render(<SafetyScreen />);

    expect(screen.getByText(/지금은 당신의 안전이 먼저예요/)).toBeTruthy();
  });
});

/* ================================================================== */
/* 2. 그리기만 해서는 전화가 걸리지 않는다                              */
/* ================================================================== */

describe('안전 화면 · 저절로 걸지 않는다', () => {
  it('화면에 들어온 것만으로는 전화 앱이 열리지 않는다', async () => {
    await render(<SafetyScreen />);

    // 화면이 실제로 그려졌는지 먼저 확인한다.
    // 이 줄이 없으면, 화면이 아예 안 그려져도 "전화가 안 걸렸다"고 통과해 버린다.
    // 전화가 안 걸린 것과 화면이 없는 것은 전혀 다른 이야기다.
    expect(screen.getByText('109')).toBeTruthy();

    // 위급한 사람이 화면을 열었을 뿐인데 전화가 걸리면 안 된다.
    expect(openURL).not.toHaveBeenCalled();
  });
});

/* ================================================================== */
/* 3. 눌렀을 때만 걸린다                                                */
/* ================================================================== */

describe('안전 화면 · 누르면 그 번호로', () => {
  it('자살예방 상담을 누르면 tel:109 가 정확히 한 번 열린다', async () => {
    await render(<SafetyScreen />);

    await fireEvent.press(screen.getByLabelText('자살예방 상담 109에 전화하기'));

    expect(openURL).toHaveBeenCalledTimes(1);
    expect(openURL).toHaveBeenCalledWith('tel:109');
  });

  it('하이픈이 있는 번호는 하이픈을 빼고 건다', async () => {
    await render(<SafetyScreen />);

    await fireEvent.press(screen.getByLabelText('정신건강 위기상담 1577-0199에 전화하기'));

    // 화면에는 1577-0199로 보이지만 전화 앱에는 하이픈 없이 넘긴다.
    expect(openURL).toHaveBeenCalledWith('tel:15770199');
  });

  it('누르지 않은 번호는 걸리지 않는다', async () => {
    await render(<SafetyScreen />);

    await fireEvent.press(screen.getByLabelText('자살예방 상담 109에 전화하기'));

    expect(openURL).toHaveBeenCalledTimes(1);
    expect(openURL).not.toHaveBeenCalledWith('tel:112');
    expect(openURL).not.toHaveBeenCalledWith('tel:119');
  });
});

/* ================================================================== */
/* 4. 전화 앱이 열리지 않아도 화면은 살아 있다                          */
/* ================================================================== */

describe('안전 화면 · 실패해도 멈추지 않는다', () => {
  it('전화 앱을 열지 못해도 화면이 죽지 않고 번호도 그대로 남는다', async () => {
    // 기기에 전화 기능이 없거나 막혀 있는 경우를 흉내 낸다.
    openURL.mockRejectedValue(new Error('열 수 없음'));

    await render(<SafetyScreen />);

    // 여기서 예외가 새어 나오면 화면이 통째로 멈춘다.
    await expect(
      fireEvent.press(screen.getByLabelText('경찰 112에 전화하기')),
    ).resolves.not.toThrow();

    // 실패했다고 번호를 감추면 안 된다. 다른 방법으로라도 걸 수 있어야 한다.
    expect(screen.getByText('112')).toBeTruthy();
    expect(screen.getByText('119')).toBeTruthy();
    expect(screen.getByText('109')).toBeTruthy();
    expect(screen.getByText('1577-0199')).toBeTruthy();
  });
});
