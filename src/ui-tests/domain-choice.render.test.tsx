/**
 * 영역 선택(domain_choice) 화면 · 실제 렌더 테스트
 *
 * 실행: npm run test:ui
 *
 * 뒤로가기로 같은 선택 화면에 돌아올 수 있어야 한다(2026-09-15 back navigation fix).
 *   지켜야 할 것:
 *     1. 고를 때는 router.replace가 아니라 router.push를 쓴다.
 *        말씀·ambiguous·no_coverage 화면 밑에 이 선택 화면이 스택에 그대로 남는다.
 *     2. applyDomainChoiceOption은 카드·영역만 바꾸고 domainChoiceOptions는 그대로 둔다.
 *        그래서 뒤로 돌아오면 같은 두 버튼이 다시 보이고, 다른 쪽을 또 고를 수 있다.
 *     3. 연속 탭 가드는 포커스 단위다. 같은 포커스에서는 첫 탭만 효력이 있고,
 *        뒤로 돌아와 이 화면이 다시 포커스되면 가드가 풀린다.
 *     4. 화면이 포커스되지 않은 동안(다른 화면이 앞에 있는 동안) 삭제 등으로 option이 비워져도
 *        지금 앞에 있는 화면을 잘못 바꾸지 않는다. 이 화면이 다시 포커스됐을 때만 홈으로 보낸다.
 *     5. 내부 영문 domain 코드는 화면 어디에도, 접근성 문구에도 보이지 않는다.
 *     6. 선택 동작은 네트워크 호출이 없다.
 *
 * expo-router 전체를 가짜로 바꾸므로, useFocusEffect도 실제 React Navigation과 같은 계약
 * (현재 포커스면 즉시 실행, focus/blur 이벤트에 반응, effect 참조가 바뀌면 포커스 중에는 다시 실행)을
 * 최소한으로 흉내 낸 가짜 내비게이션으로 재현한다. 테스트가 mockNav.focus()/blur()로
 * "뒤로 갔다가 돌아오는 것"을 직접 흉내 낸다.
 */

import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { useEffect } from 'react';

import DomainChoiceScreen from '@/app/domain-choice';
import { domainLabel } from '@/data/domain-labels';
import { getScriptureCard } from '@/data/scripture-cards';
import type { DomainChoiceOption } from '@/lib/request-recommendation';
import { SituationProvider, useSituation } from '@/state/situation';

/**
 * React Navigation의 useFocusEffect 계약을 최소한으로 재현한 가짜 내비게이션.
 *   - 새로 push된 화면은 이미 포커스된 채로 마운트된다(focused 기본값 true).
 *   - focus()/blur()로 테스트가 직접 포커스를 옮긴다.
 *   - 실제 구현(node_modules/expo-router/build/useFocusEffect.js)과 같은 순서로 동작한다:
 *     지금 포커스면 즉시 실행하고, 이후 focus 이벤트마다 실행하며 blur마다 정리한다.
 */
class FakeNavigation {
  private focused = true;
  private focusListeners = new Set<() => void>();
  private blurListeners = new Set<() => void>();

  isFocused() {
    return this.focused;
  }
  addListener(type: 'focus' | 'blur', cb: () => void) {
    const set = type === 'focus' ? this.focusListeners : this.blurListeners;
    set.add(cb);
    return () => set.delete(cb);
  }
  /** 뒤로 돌아와 이 화면이 다시 포커스되는 것을 흉내 낸다. */
  focus() {
    if (this.focused) return;
    this.focused = true;
    this.focusListeners.forEach((cb) => cb());
  }
  /** 다른 화면(말씀 등)으로 넘어가 이 화면이 뒤로 밀리는 것을 흉내 낸다. */
  blur() {
    if (!this.focused) return;
    this.focused = false;
    this.blurListeners.forEach((cb) => cb());
  }
}

let mockNav = new FakeNavigation();

jest.mock('expo-router', () => {
  const React = require('react');
  return {
    router: { push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: jest.fn(() => false) },
    useFocusEffect: (effect: () => void | (() => void)) => {
      React.useEffect(() => {
        const nav = mockNav;
        let isFocused = false;
        let cleanup: void | (() => void);
        const callback = () => effect();

        if (nav.isFocused()) {
          cleanup = callback();
          isFocused = true;
        }
        const unsubscribeFocus = nav.addListener('focus', () => {
          if (isFocused) return;
          if (cleanup) cleanup();
          cleanup = callback();
          isFocused = true;
        });
        const unsubscribeBlur = nav.addListener('blur', () => {
          if (cleanup) cleanup();
          cleanup = undefined;
          isFocused = false;
        });
        return () => {
          if (cleanup) cleanup();
          unsubscribeFocus();
          unsubscribeBlur();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [effect]);
    },
  };
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { router } = require('expo-router') as {
  router: { push: jest.Mock; replace: jest.Mock; back: jest.Mock; canGoBack: jest.Mock };
};

/** 테스트 fixture의 domain은 언제나 이름이 있는 선택 가능한 영역이다. */
const label = (domain: DomainChoiceOption['domain']) => {
  const value = domainLabel(domain);
  if (!value) throw new Error(`이름이 없는 영역입니다: ${domain}`);
  return value;
};

const RECOMMEND_OPTION: DomainChoiceOption = {
  domain: 'fear_uncertainty',
  resolution: 'recommend',
  selectedCardId: 'SC-001',
};
const NO_COVERAGE_OPTION: DomainChoiceOption = {
  domain: 'financial_hardship',
  resolution: 'no_coverage',
  selectedCardId: null,
};
const AMBIGUOUS_OPTION: DomainChoiceOption = {
  domain: 'family_parenting_conflict',
  resolution: 'ambiguous',
  selectedCardId: null,
};
const STATIC_CARD = getScriptureCard('SC-001');
const DYNAMIC_CARD = {
  id: 'SC-999',
  domains: ['caregiving_strain'],
  referenceLabel: STATIC_CARD.referenceLabel,
  passages: STATIC_CARD.passages ?? [STATIC_CARD.passage],
  userExplanation: '동적 카드 설명입니다.',
  prayerDirection: '동적 카드 기도 방향입니다.',
};
const DYNAMIC_OPTION: DomainChoiceOption = {
  domain: 'caregiving_strain',
  displayName: '오래 돌보는 무게',
  resolution: 'recommend',
  selectedCardId: DYNAMIC_CARD.id,
  selectedCard: DYNAMIC_CARD,
};

/** 화면 밖에서 앱 상태를 보고 바꾸기 위한 창. */
let probe: ReturnType<typeof useSituation> | null = null;
function Probe() {
  probe = useSituation();
  return null;
}

/**
 * 실제 앱에서는 index.tsx가 domainChoiceOptions를 채운 "다음에" 이 화면으로 이동하므로,
 * 화면이 마운트되는 시점에는 이미 옵션이 채워져 있다. 이 wrapper도 그것을 흉내 낸다:
 * 옵션이 실제로 채워지기 전까지는(비동기 useEffect 한 틱) 화면을 그리지 않는다.
 * 그래야 DomainChoiceScreen의 useFocusEffect가 빈 배열([])을 보고
 * 실제로는 없는 "옵션 없이 들어왔다" 리다이렉트를 테스트 부트스트랩 과정에서 잘못 만들지 않는다.
 */
function WithOptions({ options }: { options: DomainChoiceOption[] }) {
  const { domainChoiceOptions, setDomainChoiceOptions } = useSituation();

  useEffect(() => {
    setDomainChoiceOptions(options);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (domainChoiceOptions !== options) return null;
  return <DomainChoiceScreen />;
}

const renderScreen = (options: DomainChoiceOption[]) =>
  render(
    <SituationProvider>
      <Probe />
      <WithOptions options={options} />
    </SituationProvider>,
  );

/**
 * WithOptions는 domainChoiceOptions가 처음 넣은 값과 달라지는 순간(옵션이 밖에서 비워지는 순간)
 * 화면째 내려 버려서, 화면 자신이 "밖에서 비워졌다"를 실제로 처리하는지 확인할 수 없다.
 * KeepMounted는 처음 한 번만 옵션을 채우고, 그 뒤로는 화면을 내리지 않는다.
 * push 스택에서 화면이 뒤로 밀려도(포커스만 잃고) 계속 마운트돼 있는 실제 동작과도 같다.
 * (부트스트랩 첫 틱에 빈 배열을 잠깐 보게 되므로, 그 직후 발생하는 호출은 각 테스트에서 정리한다.)
 */
function KeepMounted({ options }: { options: DomainChoiceOption[] }) {
  const context = useSituation();

  useEffect(() => {
    context.setDomainChoiceOptions(options);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <DomainChoiceScreen />;
}

const renderKeepMounted = (options: DomainChoiceOption[]) =>
  render(
    <SituationProvider>
      <Probe />
      <KeepMounted options={options} />
    </SituationProvider>,
  );

beforeAll(() => {
  // 이 화면이 바깥으로 나가려 하면 테스트가 그 자리에서 실패해야 한다.
  global.fetch = (() => {
    throw new Error('영역 선택 화면은 서버를 부르지 않아야 합니다.');
  }) as unknown as typeof fetch;
});

beforeEach(() => {
  router.push.mockReset();
  router.replace.mockReset();
  mockNav = new FakeNavigation();
});

describe('영역 선택 화면 · 그려 보기', () => {
  it('제목과 안내가 보인다', async () => {
    await renderScreen([RECOMMEND_OPTION, NO_COVERAGE_OPTION]);

    expect(screen.getByText('어느 쪽부터 말씀을 볼까요?')).toBeTruthy();
    expect(
      screen.getByText('두 상황이 함께 보여요. 지금 먼저 말씀으로 살펴보고 싶은 쪽을 골라주세요.'),
    ).toBeTruthy();
  });

  it('두 후보가 한국어 이름으로 보이고, 내부 영문 domain 코드는 보이지 않는다', async () => {
    await renderScreen([RECOMMEND_OPTION, NO_COVERAGE_OPTION]);

    expect(screen.getByLabelText(label(RECOMMEND_OPTION.domain))).toBeTruthy();
    expect(screen.getByLabelText(label(NO_COVERAGE_OPTION.domain))).toBeTruthy();
    expect(screen.queryByText('fear_uncertainty')).toBeNull();
    expect(screen.queryByText('financial_hardship')).toBeNull();
    expect(screen.queryByLabelText('fear_uncertainty')).toBeNull();
  });

  it('새 영역은 서버가 검증해 보낸 한국어 이름으로 보이고 내부 id는 숨긴다', async () => {
    await renderScreen([DYNAMIC_OPTION, NO_COVERAGE_OPTION]);

    expect(screen.getByLabelText('오래 돌보는 무게')).toBeTruthy();
    expect(screen.queryByText('caregiving_strain')).toBeNull();
    expect(screen.queryByLabelText('caregiving_strain')).toBeNull();
  });
});

/* ================================================================== */
/* 고르면 push로 이동하고, option은 그대로 남는다                        */
/* ================================================================== */

describe('영역 선택 화면 · 고르면 push로 이동하고 option을 보존한다', () => {
  it('recommend 후보를 고르면 카드·영역을 저장하고 push로 말씀 화면으로 간다(option 보존)', async () => {
    await renderScreen([RECOMMEND_OPTION, NO_COVERAGE_OPTION]);

    await fireEvent.press(screen.getByLabelText(label(RECOMMEND_OPTION.domain)));

    expect(router.push).toHaveBeenCalledWith('/scripture');
    expect(router.push).toHaveBeenCalledTimes(1);
    expect(router.replace).not.toHaveBeenCalled();

    expect(probe!.selectedCardId).toBe(RECOMMEND_OPTION.selectedCardId);
    expect(probe!.selectedDomain).toBe(RECOMMEND_OPTION.domain);
    // setRecommendation과 달리 option을 비우지 않는다 — 뒤로 돌아와 다시 고를 수 있어야 한다.
    expect(probe!.domainChoiceOptions).toEqual([RECOMMEND_OPTION, NO_COVERAGE_OPTION]);
  });

  it('새 영역 후보를 고르면 공개 카드 객체도 말씀·기도 화면용 상태에 보존한다', async () => {
    await renderScreen([DYNAMIC_OPTION, NO_COVERAGE_OPTION]);

    await fireEvent.press(screen.getByLabelText('오래 돌보는 무게'));

    expect(router.push).toHaveBeenCalledWith('/scripture');
    expect(probe!.selectedCardId).toBe(DYNAMIC_CARD.id);
    expect(probe!.selectedCard).toEqual(DYNAMIC_CARD);
    expect(probe!.selectedDomain).toBe('caregiving_strain');
    expect(probe!.domainChoiceOptions).toEqual([DYNAMIC_OPTION, NO_COVERAGE_OPTION]);
  });

  it('no_coverage 후보를 고르면 카드·영역만 비우고 push로 기존 no-coverage 화면으로 간다(option 보존)', async () => {
    await renderScreen([RECOMMEND_OPTION, NO_COVERAGE_OPTION]);

    await fireEvent.press(screen.getByLabelText(label(NO_COVERAGE_OPTION.domain)));

    expect(router.push).toHaveBeenCalledWith('/no-coverage');
    expect(router.push).toHaveBeenCalledTimes(1);
    expect(router.replace).not.toHaveBeenCalled();

    expect(probe!.selectedCardId).toBeNull();
    expect(probe!.selectedDomain).toBeNull();
    expect(probe!.domainChoiceOptions).toEqual([RECOMMEND_OPTION, NO_COVERAGE_OPTION]);
  });

  it('ambiguous 후보를 고르면 카드·영역만 비우고 push로 기존 ambiguous 화면으로 간다(option 보존)', async () => {
    await renderScreen([RECOMMEND_OPTION, AMBIGUOUS_OPTION]);

    await fireEvent.press(screen.getByLabelText(label(AMBIGUOUS_OPTION.domain)));

    expect(router.push).toHaveBeenCalledWith('/ambiguous');
    expect(router.push).toHaveBeenCalledTimes(1);
    expect(router.replace).not.toHaveBeenCalled();

    expect(probe!.selectedCardId).toBeNull();
    expect(probe!.selectedDomain).toBeNull();
    expect(probe!.domainChoiceOptions).toEqual([RECOMMEND_OPTION, AMBIGUOUS_OPTION]);
  });
});

/* ================================================================== */
/* 뒤로 돌아오면 다시 고를 수 있다                                       */
/* ================================================================== */

describe('영역 선택 화면 · 뒤로 돌아오면 다시 고를 수 있다', () => {
  it('같은 포커스에서 연속 탭하면 첫 선택만 처리하고, 뒤로 돌아와 새 포커스가 되면 다시 고를 수 있다', async () => {
    await renderScreen([RECOMMEND_OPTION, NO_COVERAGE_OPTION]);

    const recommendButton = screen.getByLabelText(label(RECOMMEND_OPTION.domain));
    const noCoverageButton = screen.getByLabelText(label(NO_COVERAGE_OPTION.domain));

    // 같은 포커스 안에서 recommend를 먼저, no_coverage를 바로 이어서 누른다(연속 탭).
    await act(async () => {
      fireEvent.press(recommendButton);
      fireEvent.press(noCoverageButton);
    });

    // 첫 탭(recommend)만 효력이 있다.
    expect(router.push).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenCalledWith('/scripture');
    expect(probe!.selectedCardId).toBe(RECOMMEND_OPTION.selectedCardId);

    // 말씀 화면으로 넘어가며 이 화면은 뒤로 밀린다(포커스만 잃는다. push라서 마운트는 유지).
    await act(async () => mockNav.blur());

    // 뒤로가기로 이 화면에 돌아온다.
    await act(async () => mockNav.focus());

    // 두 버튼이 다시 보인다(option이 그대로 남아 있었으므로 계속 보였을 것이다).
    expect(screen.getByLabelText(label(RECOMMEND_OPTION.domain))).toBeTruthy();
    expect(screen.getByLabelText(label(NO_COVERAGE_OPTION.domain))).toBeTruthy();

    // 이번에는 처음과 다른 option(no_coverage)을 고른다.
    await fireEvent.press(screen.getByLabelText(label(NO_COVERAGE_OPTION.domain)));

    expect(router.push).toHaveBeenCalledTimes(2);
    expect(router.push).toHaveBeenNthCalledWith(2, '/no-coverage');

    // 상태가 두 번째 선택 결과로 갱신됐다.
    expect(probe!.selectedCardId).toBeNull();
    expect(probe!.selectedDomain).toBeNull();
    expect(probe!.domainChoiceOptions).toEqual([RECOMMEND_OPTION, NO_COVERAGE_OPTION]);
  });
});

describe('영역 선택 화면 · 옵션 없이 들어오면', () => {
  it('첫 화면으로 돌아간다', async () => {
    await renderScreen([]);

    expect(router.replace).toHaveBeenCalledWith('/');
    expect(screen.queryByText('어느 쪽부터 말씀을 볼까요?')).toBeNull();
  });
});

/* ================================================================== */
/* 내 정보 삭제                                                        */
/* ================================================================== */

describe('영역 선택 화면 · 내 정보 삭제', () => {
  it('선택 화면이 포커스된(열린) 상태에서 삭제하면 버튼이 사라지고 홈으로 이동한다', async () => {
    // WithOptions는 domainChoiceOptions가 비워지는 순간 화면째 내려 버리므로,
    // 화면 자신의 처리를 보려면 KeepMounted를 쓴다.
    await renderKeepMounted([RECOMMEND_OPTION, NO_COVERAGE_OPTION]);

    // 부트스트랩 첫 틱의 빈 배열 때문에 잠깐 replace('/')가 불릴 수 있다.
    // 실제로 버튼이 뜬 뒤부터 새로 센다.
    expect(await screen.findByLabelText(label(RECOMMEND_OPTION.domain))).toBeTruthy();
    router.replace.mockReset();
    router.push.mockReset();

    await act(async () => probe!.clearAfterDataDeletion());

    expect(screen.queryByLabelText(label(RECOMMEND_OPTION.domain))).toBeNull();
    expect(screen.queryByLabelText(label(NO_COVERAGE_OPTION.domain))).toBeNull();
    expect(screen.queryByText('어느 쪽부터 말씀을 볼까요?')).toBeNull();
    expect(router.replace).toHaveBeenCalledWith('/');
    expect(router.push).not.toHaveBeenCalled();
    expect(probe!.domainChoiceOptions).toEqual([]);
  });

  it('선택 화면이 뒤에 있는(포커스 없는) 동안 삭제되면 지금 앞 화면을 잘못 바꾸지 않는다', async () => {
    await renderKeepMounted([RECOMMEND_OPTION, NO_COVERAGE_OPTION]);
    expect(await screen.findByLabelText(label(RECOMMEND_OPTION.domain))).toBeTruthy();

    // 말씀 화면으로 넘어가 이 화면이 뒤로 밀린다.
    await act(async () => mockNav.blur());
    router.replace.mockReset();
    router.push.mockReset();

    // 뒤에 있는 동안 삭제가 일어난다.
    await act(async () => probe!.clearAfterDataDeletion());

    // 포커스가 없으므로 지금(가상의) 앞 화면을 이 화면이 멋대로 바꾸지 않는다.
    expect(router.replace).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();

    // 이후 선택 화면이 다시 포커스되면 그제서야 옵션이 없다는 것을 보고 홈으로 이동한다.
    await act(async () => mockNav.focus());

    expect(router.replace).toHaveBeenCalledWith('/');
    // 삭제된 option으로는 말씀 화면에 갈 수 없다 — 버튼이 없고, push도 없었다.
    expect(screen.queryByLabelText(label(RECOMMEND_OPTION.domain))).toBeNull();
    expect(router.push).not.toHaveBeenCalled();
    expect(probe!.domainChoiceOptions).toEqual([]);
  });
});
