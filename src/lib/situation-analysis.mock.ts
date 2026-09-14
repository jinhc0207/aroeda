/**
 * Situation Analyzer 테스트용 mock 결과
 *
 * OpenAI를 연결하기 전에 규격과 매칭 흐름을 확인하기 위한 데이터다.
 * 실제 앱 화면에는 연결하지 않는다.
 *
 * 태그는 모두 표준 태그 사전(src/data/analysis-taxonomy.ts) 안에 있는 값만 사용한다.
 * 사용자가 말하지 않은 감정이나 사건은 넣지 않는다.
 */

import type { SafetyAssessment, SituationAnalysis } from './situation-analysis.ts';

export type MockAnalysisCase = {
  name: string;
  /** 사용자가 입력했다고 가정한 '지금 나의 상황' */
  userText: string;
  analysis: SituationAnalysis;
  expectedCardId: string;
};

export const MOCK_ANALYSIS_CASES: MockAnalysisCase[] = [
  {
    name: 'CASE 1 · 이사 앞에서',
    userText: '내년에 이사를 해야 하는데 어디로 가야 할지 벌써부터 마음이 무거워요.',
    analysis: {
      domainPriority: 'resolved',
      primaryDomain: 'decision_guidance',
      domainChoiceCandidates: [],
      secondaryDomains: [],
      situationTags: ['이사', '미래 선택', '방향을 모름'],
      emotionTags: ['걱정'],
      spiritualQuestionTags: ['인도', '분별'],
      prayerModes: ['간구'],
      pastoralFunctions: ['인도'],
      safety: { level: 'normal', categories: [] },
      confidence: 0.82,
    },
    expectedCardId: 'SC-002',
  },
  {
    name: 'CASE 2 · 아들의 합격',
    userText: '오늘 아들이 바라던 학교에 합격했어요. 너무 기쁘고 하나님께 감사하고 싶어요.',
    analysis: {
      domainPriority: 'resolved',
      primaryDomain: 'gratitude_joy',
      domainChoiceCandidates: [],
      secondaryDomains: [],
      situationTags: ['좋은 일이 생김', '기쁜 소식', '감사하고 싶음'],
      emotionTags: ['기쁨', '감사'],
      spiritualQuestionTags: ['감사'],
      prayerModes: ['감사'],
      pastoralFunctions: ['감사'],
      safety: { level: 'normal', categories: [] },
      confidence: 0.9,
    },
    expectedCardId: 'SC-004',
  },
  {
    name: 'CASE 3 · 몇 년째 달라지지 않는 기도',
    userText: '몇 년째 기도하고 있는데 아무것도 달라지지 않아요. 이제 기도하는 것도 지쳤어요.',
    analysis: {
      domainPriority: 'resolved',
      primaryDomain: 'waiting_unanswered_prayer',
      domainChoiceCandidates: [],
      secondaryDomains: [],
      situationTags: ['오래된 기도', '응답이 보이지 않음', '상황이 변하지 않음'],
      emotionTags: ['지침', '답답함'],
      spiritualQuestionTags: ['하나님의 침묵', '기다림'],
      prayerModes: ['탄식', '간구'],
      pastoralFunctions: ['탄식'],
      safety: { level: 'normal', categories: [] },
      confidence: 0.85,
    },
    expectedCardId: 'SC-003',
  },
  {
    name: 'CASE 4 · 뒤처지는 것 같은 마음',
    userText: '친구들은 다 잘되는 것 같은데 저만 뒤처지는 것 같아서 속상해요.',
    analysis: {
      domainPriority: 'resolved',
      primaryDomain: 'comparison_identity',
      domainChoiceCandidates: [],
      secondaryDomains: [],
      situationTags: ['다른 사람과 비교', '뒤처진 것 같음', '다른 사람의 성공이 신경 쓰임'],
      emotionTags: ['열등감'],
      spiritualQuestionTags: ['비교'],
      prayerModes: ['간구'],
      pastoralFunctions: ['관점 전환'],
      safety: { level: 'normal', categories: [] },
      confidence: 0.8,
    },
    expectedCardId: 'SC-007',
  },
  {
    name: 'CASE 5 · 반복되는 모욕',
    userText: '직장 상사가 사람들 앞에서 반복적으로 저를 모욕합니다. 너무 화가 나고 억울해요.',
    analysis: {
      domainPriority: 'resolved',
      primaryDomain: 'injustice_mistreatment',
      domainChoiceCandidates: [],
      secondaryDomains: [],
      situationTags: ['괴롭힘', '부당대우', '억울한 일을 당함'],
      emotionTags: ['분노', '억울함'],
      spiritualQuestionTags: ['정의'],
      prayerModes: ['탄식', '간구'],
      pastoralFunctions: ['탄식', '정의'],
      // 직장 내 괴롭힘이 계속되고 있으나 즉각적인 신체 위험은 문장에 드러나지 않는다.
      safety: { level: 'caution', categories: ['abuse'] },
      confidence: 0.78,
    },
    expectedCardId: 'SC-008',
  },
  {
    name: 'CASE 6 · 어머니를 잃은 뒤',
    userText: '어머니가 돌아가신 뒤 계속 생각나고 너무 보고 싶어요.',
    analysis: {
      domainPriority: 'resolved',
      primaryDomain: 'grief_loss',
      domainChoiceCandidates: [],
      secondaryDomains: [],
      situationTags: ['사별', '상실', '죽음'],
      emotionTags: ['슬픔', '그리움'],
      spiritualQuestionTags: ['슬픔'],
      prayerModes: ['탄식'],
      pastoralFunctions: ['위로', '애도'],
      safety: { level: 'normal', categories: [] },
      confidence: 0.88,
    },
    expectedCardId: 'SC-009',
  },
  {
    name: 'CASE 7 · 같은 죄를 다시 지음',
    userText: '하나님께 죄송하다고 했는데 또 같은 죄를 지었어요.',
    analysis: {
      domainPriority: 'resolved',
      primaryDomain: 'repentance_guilt',
      domainChoiceCandidates: [],
      secondaryDomains: [],
      situationTags: ['같은 죄를 반복함', '회개하고 싶음'],
      emotionTags: ['죄책감'],
      spiritualQuestionTags: ['회개', '용서'],
      prayerModes: ['회개'],
      pastoralFunctions: ['회개'],
      safety: { level: 'normal', categories: [] },
      confidence: 0.86,
    },
    expectedCardId: 'SC-006',
  },
  {
    name: 'CASE 8 · 조용히 하나님과',
    userText: '오늘은 특별한 일은 없어요. 그냥 하나님과 조용히 이야기하고 싶어요.',
    analysis: {
      domainPriority: 'resolved',
      primaryDomain: 'quiet_communion',
      domainChoiceCandidates: [],
      secondaryDomains: [],
      situationTags: ['특별한 문제가 없음', '조용히 하나님과 있고 싶음'],
      emotionTags: ['고요함'],
      spiritualQuestionTags: ['하나님과의 교제'],
      prayerModes: ['교제'],
      pastoralFunctions: ['교제'],
      safety: { level: 'normal', categories: [] },
      confidence: 0.8,
    },
    expectedCardId: 'SC-005',
  },
];

export type MockSafetyCase = {
  name: string;
  userText: string;
  safety: SafetyAssessment;
};

/**
 * 안전 상황 표현용 mock.
 * 실제 위험 판단은 아직 만들지 않는다. safety 구조가 이런 상황을 담을 수 있는지만 확인한다.
 * 이 경우 말씀 추천과 기도문보다 현실적인 안전 안내가 먼저다.
 */
export const MOCK_SAFETY_CASES: MockSafetyCase[] = [
  {
    name: '안전 A · 자살 생각',
    userText: '죽고 싶다는 생각이 계속 들어요.',
    safety: { level: 'urgent', categories: ['suicide', 'self_harm'] },
  },
  {
    name: '안전 B · 진행 중인 폭력',
    userText: '남편이 지금 저를 때리고 있어요.',
    safety: { level: 'urgent', categories: ['abuse', 'immediate_danger'] },
  },
  {
    name: '안전 C · 긴급 의료',
    userText: '숨을 쉬기가 너무 어렵고 가슴 통증이 심해요.',
    safety: { level: 'urgent', categories: ['urgent_medical', 'immediate_danger'] },
  },
];
