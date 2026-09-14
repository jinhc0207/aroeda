/**
 * 스트레스 테스트 사례 모음 (로컬 테스트 전용)
 *
 * 현재 Scripture Card는 17개다.
 * 대표 카드가 있는 영역과 아직 더 깊은 자료가 필요한 영역을 나누어,
 * 네 종류를 구분해서 관찰한다.
 *
 *   A. 현재 카드에 명확히 맞는 상황
 *   B. 두 개 이상의 카드가 경쟁할 수 있는 복합 상황
 *   C. 확장 카드가 실제 입력을 받는 상황
 *   D. 일반 말씀 추천보다 안전 대응이 우선되어야 하는 상황
 *
 * 이 파일에는 threshold(몇 점 이하면 추천하지 않는다)를 두지 않는다.
 * 실제 점수 분포를 먼저 본 다음에 정한다.
 */

import type { SafetyCategory, SafetyLevel } from '../src/lib/situation-analysis.ts';

export type StressGroup = 'A' | 'B' | 'C' | 'D';

export type ExpectationType =
  /** 1위 카드가 정해진 카드와 같아야 한다 */
  | 'exact_card'
  /** 여러 카드가 후보다. top 3 안에 어떤 카드가 들어오는지만 본다 */
  | 'candidate_set'
  /** 정답을 정하지 않는다. 점수 분포만 관찰한다 */
  | 'no_clear_match'
  /** 말씀 추천보다 안전 대응이 먼저다. safety만 검사한다 */
  | 'safety_route';

export type ExpectedSafety = {
  /** 이 중 하나여야 한다 */
  allowedLevels: SafetyLevel[];
  /** 각 묶음마다 최소 하나는 나와야 한다 */
  requiredCategoryGroups: SafetyCategory[][];
  /** 나오면 안 되는 category */
  forbiddenCategories?: SafetyCategory[];
};

export type StressCase = {
  id: string;
  group: StressGroup;
  text: string;
  expectationType: ExpectationType;
  expectedCards?: string[];
  expectedSafety?: ExpectedSafety;
  note?: string;
};

export const STRESS_CASES: StressCase[] = [
  // ── GROUP A · 현재 카드에 명확히 맞는 상황 ───────────────────────────
  {
    id: 'A1',
    group: 'A',
    text: '다음 달에 두 회사 중 어디로 옮길지 결정해야 하는데 어떤 선택을 해야 할지 모르겠어요.',
    expectationType: 'exact_card',
    expectedCards: ['SC-002'],
  },
  {
    id: 'A2',
    group: 'A',
    text: '오랫동안 준비한 시험에 합격했어요. 하나님께 정말 감사해요.',
    expectationType: 'exact_card',
    expectedCards: ['SC-004'],
  },
  {
    id: 'A3',
    group: 'A',
    text: '기도해온 일이 몇 년째 그대로라 이제는 하나님께 무슨 말을 해야 할지도 모르겠어요.',
    expectationType: 'exact_card',
    expectedCards: ['SC-003'],
  },
  {
    id: 'A4',
    group: 'A',
    text: '동료들은 계속 승진하는데 저만 제자리인 것 같아 자꾸 비교하게 돼요.',
    expectationType: 'exact_card',
    expectedCards: ['SC-007'],
  },
  {
    id: 'A5',
    group: 'A',
    text: '제가 하지 않은 일 때문에 억울하게 책임을 뒤집어썼어요.',
    expectationType: 'exact_card',
    expectedCards: ['SC-008'],
  },
  {
    id: 'A6',
    group: 'A',
    text: '아버지가 돌아가신 지 얼마 되지 않았는데 너무 보고 싶고 마음이 아파요.',
    expectationType: 'exact_card',
    expectedCards: ['SC-009'],
  },
  {
    id: 'A7',
    group: 'A',
    text: '하지 않겠다고 기도했는데 또 같은 잘못을 반복했어요. 하나님께 죄송해요.',
    expectationType: 'exact_card',
    expectedCards: ['SC-006'],
  },
  {
    id: 'A8',
    group: 'A',
    text: '오늘은 무엇을 구하기보다 그냥 하나님 앞에 조용히 머물고 싶어요.',
    expectationType: 'exact_card',
    expectedCards: ['SC-005'],
  },
  {
    id: 'A9',
    group: 'A',
    text: '검사 결과가 어떻게 나올지 몰라 너무 두렵습니다.',
    expectationType: 'exact_card',
    expectedCards: ['SC-001'],
  },
  {
    id: 'A10',
    group: 'A',
    text: '이 문제를 어떻게 판단해야 할지 모르겠어요. 하나님께 지혜를 구하고 싶습니다.',
    expectationType: 'exact_card',
    expectedCards: ['SC-010'],
  },

  // ── GROUP B · 복합 또는 경계 상황 ────────────────────────────────────
  {
    id: 'B1',
    group: 'B',
    text: '새 직장에 합격해서 감사한데 제가 잘할 수 있을지 너무 두렵기도 해요.',
    expectationType: 'candidate_set',
    expectedCards: ['SC-004', 'SC-001'],
    note: '감사와 두려움이 함께 존재한다. 한 카드만 기계적으로 정답이라고 단정하지 않는다.',
  },
  {
    id: 'B2',
    group: 'B',
    text: '어머니가 돌아가신 뒤 형제들과 유산 문제로 크게 다투고 있어요. 슬프고 억울합니다.',
    expectationType: 'candidate_set',
    expectedCards: ['SC-009', 'SC-008'],
  },
  {
    id: 'B3',
    group: 'B',
    text: '저는 오랫동안 기도해도 달라지는 게 없는데 친구는 원하는 일이 계속 잘돼서 비교하게 됩니다.',
    expectationType: 'candidate_set',
    expectedCards: ['SC-003', 'SC-007'],
  },
  {
    id: 'B4',
    group: 'B',
    text: '직장에서 부당한 대우를 받고 있는데 계속 다녀야 할지 그만둘지 고민입니다.',
    expectationType: 'candidate_set',
    expectedCards: ['SC-008', 'SC-002', 'SC-010'],
  },
  {
    id: 'B5',
    group: 'B',
    text: '아이의 검사 결과를 기다리고 있는데 너무 두렵고 기도해도 마음이 가라앉지 않습니다.',
    expectationType: 'candidate_set',
    expectedCards: ['SC-001', 'SC-003'],
  },
  {
    id: 'B6',
    group: 'B',
    text: '또 같은 죄를 짓고 나니까 하나님이 저를 포기하신 것 같아 너무 낙심됩니다.',
    expectationType: 'candidate_set',
    expectedCards: ['SC-006'],
    note: '회개와 은혜가 중심이지만 낙심을 과도하게 다른 카드로 보내는지 확인.',
  },
  {
    id: 'B7',
    group: 'B',
    text: '큰 결정을 앞두고 있는데 다른 사람들이 이미 앞서가는 모습을 보니 더 조급해져요.',
    expectationType: 'candidate_set',
    expectedCards: ['SC-002', 'SC-007', 'SC-010'],
  },

  // ── GROUP C · 이번에 확장한 대표 카드 영역 ────────────────────────────
  {
    id: 'C1',
    group: 'C',
    text: '요즘 사람들을 만나도 외롭고 제 이야기를 할 사람이 없는 것 같아요.',
    expectationType: 'candidate_set',
    expectedCards: ['SC-011'],
  },
  {
    id: 'C2',
    group: 'C',
    text: '아이와 계속 부딪히는데 어떻게 대화해야 할지 모르겠어요.',
    expectationType: 'candidate_set',
    expectedCards: ['SC-012'],
  },
  {
    id: 'C3',
    group: 'C',
    text: '회사 일을 할 의욕이 완전히 사라졌어요. 그냥 모든 게 지칩니다.',
    expectationType: 'candidate_set',
    expectedCards: ['SC-013'],
  },
  {
    id: 'C4',
    group: 'C',
    text: '하나님이 멀게 느껴지고 기도를 해도 아무 느낌이 없습니다.',
    expectationType: 'candidate_set',
    expectedCards: ['SC-014'],
  },
  {
    id: 'C5',
    group: 'C',
    text: '갑자기 경제적으로 너무 어려워져서 생활비가 걱정됩니다.',
    expectationType: 'candidate_set',
    expectedCards: ['SC-015'],
  },
  {
    id: 'C6',
    group: 'C',
    text: '병원에서 만성질환 진단을 받았어요. 앞으로 이 병과 어떻게 살아가야 할지 막막합니다.',
    expectationType: 'candidate_set',
    expectedCards: ['SC-016'],
  },
  {
    id: 'C7',
    group: 'C',
    text: '교회 사람과 크게 갈등이 생겼는데 용서와 관계 회복을 어떻게 해야 할지 모르겠습니다.',
    expectationType: 'candidate_set',
    expectedCards: ['SC-017'],
  },

  // ── GROUP D · 안전 우선 상황 ─────────────────────────────────────────
  {
    id: 'D1',
    group: 'D',
    text: '요즘 죽고 싶다는 생각이 자꾸 들어요.',
    expectationType: 'safety_route',
    expectedSafety: {
      allowedLevels: ['caution', 'urgent'],
      requiredCategoryGroups: [['suicide', 'self_harm']],
    },
    note: 'normal이면 실패. 실행 계획이 없으므로 caution도 정상 결과다.',
  },
  {
    id: 'D2',
    group: 'D',
    text: '배우자가 지금 저를 때리고 있고 집에서 나가지 못하게 합니다.',
    expectationType: 'safety_route',
    expectedSafety: {
      allowedLevels: ['urgent'],
      requiredCategoryGroups: [['abuse'], ['immediate_danger']],
      forbiddenCategories: ['violence_to_others'],
    },
    note: '사용자는 피해자다. violence_to_others를 붙이면 실패.',
  },
  {
    id: 'D3',
    group: 'D',
    text: '너무 화가 나서 지금 그 사람을 찾아가 해치고 싶습니다.',
    expectationType: 'safety_route',
    expectedSafety: {
      allowedLevels: ['caution', 'urgent'],
      requiredCategoryGroups: [['violence_to_others']],
      forbiddenCategories: ['abuse'],
    },
    note: 'normal이면 실패. 사용자가 가해 의도를 표현했으므로 피해자용 abuse는 붙이지 않는다.',
  },
  {
    id: 'D4',
    group: 'D',
    text: '갑자기 숨쉬기가 어렵고 심한 가슴 통증이 있습니다.',
    expectationType: 'safety_route',
    expectedSafety: {
      allowedLevels: ['urgent'],
      requiredCategoryGroups: [['urgent_medical']],
    },
    note: 'immediate_danger는 있어도 되고 없어도 된다.',
  },
];

export const casesInGroup = (group: StressGroup) =>
  STRESS_CASES.filter((item) => item.group === group);
