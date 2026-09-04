/**
 * Scripture Card V1
 *
 * 카드에는 성경 원문을 저장하지 않습니다.
 * 카드는 "어떤 본문인지 + 본문의 의미 + 적용 방향"만 담고,
 * 실제 개역한글 원문은 항상 src/data/bible/krv1961.json 에서 가져옵니다.
 *
 * 앞으로 AI가 고르는 것도 성경 문장이 아니라 카드 id(예: SC-001)입니다.
 */

import type { SituationDomain } from './situation-domains.ts';

/** krv1961.json 안의 본문 위치. book은 JSON에 들어 있는 영문 책 이름입니다. */
export type PassageRef = {
  book: string;
  chapter: number;
  startVerse: number;
  endVerse: number;
};

export type ScriptureCard = {
  id: string;
  /** 이 카드가 다루는 상황 영역. V1에서는 카드마다 하나만 둔다. */
  domains: SituationDomain[];
  referenceLabel: string;
  /** 대표 본문 위치. 여러 장에 걸친 카드는 passages의 첫 번째 범위와 같습니다. */
  passage: PassageRef;
  /** 한 장을 넘어가는 본문일 때만 사용합니다. 없으면 passage 하나만 읽습니다. */
  passages?: PassageRef[];
  /** 사용자의 실제 상황 */
  situationTags: string[];
  /** 사용자가 표현할 수 있는 감정 */
  emotionTags: string[];
  /** 말씀 앞에서 다루게 될 신앙적 질문 */
  spiritualQuestionTags: string[];
  /** 탄식, 간구, 감사, 회개, 찬양 등 */
  prayerModes: string[];
  /** 이 본문이 수행하는 목회적 역할 */
  pastoralFunction: string[];
  /** 본문의 원래 흐름을 내부적으로 이해하기 위한 정보 */
  contextSummary: string;
  /** 본문의 핵심 신학적 통찰 */
  theologicalInsight: string;
  /** 실제 앱에서 일반 사용자가 읽게 될 짧은 설명 */
  userExplanation: string;
  /** 말씀으로 어떻게 기도할지 안내 */
  prayerDirection: string;
  /** 본문을 잘못 적용하지 않기 위한 안전장치 */
  misuseGuards: string[];
};

// SC-006은 요한일서 1장과 2장에 걸쳐 있어 같은 위치 정보를 두 번 적지 않도록 따로 둡니다.
const FIRST_JOHN_1_8_10: PassageRef = {
  book: '1John',
  chapter: 1,
  startVerse: 8,
  endVerse: 10,
};

export const SCRIPTURE_CARDS: ScriptureCard[] = [
  {
    id: 'SC-001',
    domains: ['fear_uncertainty'],
    referenceLabel: '시편 56:3–4',
    passage: { book: 'Psalms', chapter: 56, startVerse: 3, endVerse: 4 },
    situationTags: ['두려운 일을 앞둠', '불확실한 결과', '위협', '미래 걱정'],
    emotionTags: ['두려움', '불안', '긴장'],
    spiritualQuestionTags: ['신뢰', '두려움 속의 믿음'],
    prayerModes: ['간구', '신뢰'],
    pastoralFunction: ['위로', '신뢰'],
    contextSummary:
      '시편 기자는 실제 위협과 두려움 속에서 하나님께 도움을 구하며, 두려운 순간에도 하나님을 의지하겠다고 고백한다.',
    theologicalInsight:
      '믿음은 두려움이 완전히 사라진 상태가 아니라, 두려움을 느끼는 순간에도 하나님께 시선을 돌리고 그분을 의지하는 신뢰다.',
    userExplanation:
      '시편 기자도 실제로 두려움을 느꼈습니다. 이 말씀은 두려움이 완전히 사라진 뒤에야 하나님을 신뢰할 수 있다고 말하지 않습니다. 두려운 바로 그 순간에도 하나님께 나아가 그분을 의지할 수 있음을 보여줍니다.',
    prayerDirection:
      '지금 가장 두려운 마음을 숨기지 말고 하나님께 그대로 말씀드려보세요. 모든 결과를 미리 알게 해달라고만 구하기보다, 알 수 없는 지금도 하나님을 의지할 수 있도록 구해보세요.',
    misuseGuards: [
      '실제 위험을 무시하게 하지 않는다.',
      '두려움을 느끼는 것을 믿음 없음으로 정죄하지 않는다.',
    ],
  },
  {
    id: 'SC-002',
    domains: ['decision_guidance'],
    referenceLabel: '잠언 3:5–6',
    passage: { book: 'Proverbs', chapter: 3, startVerse: 5, endVerse: 6 },
    situationTags: ['중요한 결정', '진로', '이사', '미래 선택', '방향을 모름'],
    emotionTags: ['혼란', '걱정', '불확실함'],
    spiritualQuestionTags: ['인도', '신뢰', '분별'],
    prayerModes: ['간구', '결단'],
    pastoralFunction: ['지혜', '인도'],
    contextSummary:
      '잠언은 자신의 판단만을 절대화하지 않고 삶의 모든 길에서 하나님을 인정하며 그분을 신뢰하도록 가르친다.',
    theologicalInsight:
      '믿음은 미래의 모든 답을 미리 알아내는 것이 아니라, 내가 이해할 수 있는 것만 의지하지 않고 삶의 길에서 하나님을 인정하며 지혜롭게 걸어가는 것이다.',
    userExplanation:
      '모든 답을 미리 알아야만 평안할 수 있는 것은 아닙니다. 이 말씀은 내 생각만을 붙들기보다, 아직 알 수 없는 길에서도 하나님을 인정하고 신뢰하며 걸어가도록 우리를 초대합니다.',
    prayerDirection:
      '정답을 빨리 보여달라고만 구하기보다, 필요한 때에 지혜를 주시고 두려움이나 욕심에 끌리지 않도록 하나님께 구해보세요.',
    misuseGuards: [
      '특정 선택지를 하나님이 초자연적으로 알려주신다고 약속하지 않는다.',
      '기도 후 처음 떠오른 생각을 하나님의 계시라고 단정하지 않는다.',
    ],
  },
  {
    id: 'SC-003',
    domains: ['waiting_unanswered_prayer'],
    referenceLabel: '시편 13:1–6',
    passage: { book: 'Psalms', chapter: 13, startVerse: 1, endVerse: 6 },
    situationTags: ['오래된 기도', '응답이 보이지 않음', '기다림', '상황이 변하지 않음'],
    emotionTags: ['지침', '답답함', '슬픔', '낙심'],
    spiritualQuestionTags: ['하나님의 침묵', '기다림', '소망'],
    prayerModes: ['탄식', '간구', '신뢰'],
    pastoralFunction: ['탄식', '소망'],
    contextSummary:
      "시편 기자는 '어느 때까지니이까'라고 반복해서 묻고 자신의 고통을 숨기지 않는다. 탄식은 간구로 이어지고, 그는 해결되지 않은 상황 속에서도 하나님께 계속 향한다.",
    theologicalInsight:
      '성경은 답답함과 실망을 숨긴 채 믿음 좋은 사람처럼 행동하라고 요구하지 않는다. 하나님께 묻고 탄식하는 것 역시 하나님을 향하고 있다면 기도가 될 수 있다.',
    userExplanation:
      '오랫동안 달라지는 것이 없을 때 하나님께 서운하고 지칠 수 있습니다. 시편 기자도 “어느 때까지입니까?”라고 하나님께 물었습니다. 이 말씀은 답을 모르는 순간에도 하나님께 말하는 것을 멈추지 않아도 된다는 것을 보여줍니다.',
    prayerDirection:
      '괜찮은 척하지 말고 지친 마음과 답답함을 하나님께 그대로 말씀드려보세요. 아직 해결되지 않은 상황에서도 하나님께 계속 부르짖을 수 있도록 구해보세요.',
    misuseGuards: [
      "'하나님의 때가 곧 올 것이다'라고 쉽게 단정하지 않는다.",
      '빠른 긍정으로 사용자의 탄식을 덮지 않는다.',
    ],
  },
  {
    id: 'SC-004',
    domains: ['gratitude_joy'],
    referenceLabel: '시편 100:1–5',
    passage: { book: 'Psalms', chapter: 100, startVerse: 1, endVerse: 5 },
    situationTags: ['좋은 일이 생김', '감사하고 싶음', '기쁜 소식', '은혜를 기억함'],
    emotionTags: ['기쁨', '감사', '감격'],
    spiritualQuestionTags: ['감사', '하나님의 선하심'],
    prayerModes: ['감사', '찬양'],
    pastoralFunction: ['감사', '찬양'],
    contextSummary:
      '시편은 하나님의 백성을 기쁨과 감사로 그분께 나아가도록 부르며, 하나님의 선하심과 인자하심을 기억하게 한다.',
    theologicalInsight:
      '감사는 좋은 일이 생긴 사실에만 머물지 않고, 그 기쁨을 하나님께 가져가 하나님의 선하심을 기억하며 응답하는 것이다.',
    userExplanation:
      '기쁜 일을 하나님께 가져가는 것도 소중한 기도입니다. 이 시편은 받은 기쁨을 그냥 지나치지 않고, 하나님이 선하시며 우리를 돌보시는 분임을 기억하며 감사하도록 초대합니다.',
    prayerDirection:
      '오늘 기뻤던 일을 구체적으로 하나님께 말씀드리고, 그 기쁨을 주신 하나님께 감사와 찬양을 드려보세요.',
    misuseGuards: [
      '사용자의 기쁨 속에 숨겨진 불안이나 문제를 억지로 만들어내지 않는다.',
      '좋은 일이 특별한 신앙적 보상의 결과라고 단정하지 않는다.',
    ],
  },
  {
    id: 'SC-005',
    domains: ['quiet_communion'],
    referenceLabel: '시편 131:1–3',
    passage: { book: 'Psalms', chapter: 131, startVerse: 1, endVerse: 3 },
    situationTags: ['특별한 문제가 없음', '조용히 하나님과 있고 싶음', '마음을 쉬고 싶음'],
    emotionTags: ['평안', '고요함', '쉼'],
    spiritualQuestionTags: ['하나님과의 교제', '쉼', '맡김'],
    prayerModes: ['교제', '신뢰'],
    pastoralFunction: ['쉼', '교제'],
    contextSummary:
      '시편 기자는 자신이 감당하기 어려운 큰일을 붙들려 하기보다 젖 뗀 아이처럼 하나님 앞에서 자신의 영혼을 고요하게 한다.',
    theologicalInsight:
      '기도는 반드시 문제를 해결하거나 무엇인가를 얻기 위한 시간일 필요가 없다. 하나님 앞에 조용히 머무는 것 자체도 믿음의 응답이 될 수 있다.',
    userExplanation:
      '특별히 해결해야 할 일이 없어도 하나님께 나아갈 수 있습니다. 이 시편은 모든 것을 말하거나 해결하려 하기보다 하나님 앞에서 마음을 고요히 하고 그분과 함께 머무는 모습을 보여줍니다.',
    prayerDirection:
      '많은 말을 하려고 애쓰지 않아도 괜찮습니다. 오늘의 마음을 하나님 앞에 내려놓고 잠시 그분과 함께 머물러보세요.',
    misuseGuards: ['사용자에게 숨겨진 문제나 불안을 임의로 찾아내지 않는다.'],
  },
  {
    id: 'SC-006',
    domains: ['repentance_guilt'],
    referenceLabel: '요한일서 1:8–2:2',
    passage: FIRST_JOHN_1_8_10,
    passages: [
      FIRST_JOHN_1_8_10,
      { book: '1John', chapter: 2, startVerse: 1, endVerse: 2 },
    ],
    situationTags: ['같은 죄를 반복함', '죄책감', '회개하고 싶음'],
    emotionTags: ['죄책감', '부끄러움', '낙심'],
    spiritualQuestionTags: ['회개', '용서', '은혜'],
    prayerModes: ['회개', '간구'],
    pastoralFunction: ['회개', '은혜', '확신'],
    contextSummary:
      '요한은 죄가 없다고 스스로 속이지 말고 죄를 인정하고 고백하도록 권한다. 동시에 범죄한 성도에게 예수 그리스도가 대언자이며 화목제물이 되심을 가르친다.',
    theologicalInsight:
      '복음은 죄를 가볍게 여기게 하지도, 죄 때문에 하나님께 돌아갈 수 없다고 절망하게 하지도 않는다. 죄를 정직하게 인정하면서 그리스도의 은혜를 의지해 다시 하나님께 나아가게 한다.',
    userExplanation:
      '같은 죄를 반복했다는 사실 때문에 하나님께 나아갈 자격이 없다고 느낄 수 있습니다. 그러나 이 말씀은 죄를 숨기지 말고 하나님께 고백하라고 하면서도, 동시에 예수 그리스도의 은혜를 바라보게 합니다.',
    prayerDirection:
      '잘못을 변명하지 않고 하나님께 정직하게 고백해보세요. 동시에 자기 정죄에만 머물지 않고, 다시 하나님께 돌아가 변화된 삶을 살 수 있도록 은혜를 구해보세요.',
    misuseGuards: [
      '죄를 가볍게 만들지 않는다.',
      '반복된 죄를 이유로 사용자를 절망적 자기정죄에 가두지 않는다.',
    ],
  },
  {
    id: 'SC-007',
    domains: ['comparison_identity'],
    referenceLabel: '요한복음 21:20–22',
    passage: { book: 'John', chapter: 21, startVerse: 20, endVerse: 22 },
    situationTags: ['다른 사람과 비교', '뒤처진 것 같음', '다른 사람의 성공이 신경 쓰임'],
    emotionTags: ['열등감', '질투', '불안', '초조함'],
    spiritualQuestionTags: ['비교', '정체성', '소명'],
    prayerModes: ['결단', '간구'],
    pastoralFunction: ['관점 전환', '소명'],
    contextSummary:
      "베드로가 다른 제자의 미래를 묻자 예수께서는 다른 사람의 길보다 자신이 받은 부르심에 집중하도록 '너는 나를 따르라'고 말씀하신다.",
    theologicalInsight:
      '믿음의 길은 다른 사람의 속도와 결과를 끊임없이 비교하는 데 있지 않고, 오늘 내가 예수님을 어떻게 따를 것인가에 시선을 돌리는 데 있다.',
    userExplanation:
      '다른 사람의 삶을 바라보다 보면 내 길이 늦거나 부족하게 느껴질 수 있습니다. 예수님은 베드로의 시선을 다른 사람의 미래에서 돌려 “너는 나를 따르라”고 말씀하셨습니다.',
    prayerDirection:
      '다른 사람의 속도와 결과에 붙잡힌 마음을 하나님께 말씀드리고, 오늘 내게 맡겨진 자리에서 예수님을 충실히 따를 수 있도록 구해보세요.',
    misuseGuards: ['개인의 모든 직업 선택을 특정한 하나님의 비밀 소명으로 단정하지 않는다.'],
  },
  {
    id: 'SC-008',
    domains: ['injustice_mistreatment'],
    referenceLabel: '시편 10:14–18',
    passage: { book: 'Psalms', chapter: 10, startVerse: 14, endVerse: 18 },
    situationTags: ['억울한 일을 당함', '부당대우', '괴롭힘', '불의'],
    emotionTags: ['분노', '억울함', '두려움', '상처'],
    spiritualQuestionTags: ['정의', '악', '하나님의 돌보심'],
    prayerModes: ['탄식', '간구'],
    pastoralFunction: ['탄식', '정의'],
    contextSummary:
      '시편 기자는 악과 억압을 하나님께 호소하며 고통받는 사람을 하나님께서 보고 계심을 고백하고 하나님의 정의로운 개입을 구한다.',
    theologicalInsight:
      '성경은 부당한 일을 당한 사람에게 먼저 분노를 없애라고 요구하지 않는다. 억울함과 불의를 하나님께 가져가며 하나님의 정의를 구하는 것도 기도다.',
    userExplanation:
      '부당한 일을 당했다면 억울하고 화가 나는 것이 자연스럽습니다. 이 시편은 악과 억압을 외면하지 않고 하나님께 그대로 호소하며, 고통받는 사람을 하나님께서 보고 계심을 기억하게 합니다.',
    prayerDirection:
      '억울했던 일과 마음을 하나님께 숨기지 말고 말씀드려보세요. 복수하고 싶은 마음에 자신을 맡기기보다, 필요한 보호와 도움을 구하며 정의를 하나님께 맡겨보세요.',
    misuseGuards: [
      '피해자의 분노부터 죄로 규정하지 않는다.',
      '학대나 폭력을 참고 견디게 하지 않는다.',
      '신고, 보호, 경계 설정 등 현실적인 안전 행동을 막지 않는다.',
    ],
  },
  {
    id: 'SC-009',
    domains: ['grief_loss'],
    referenceLabel: '요한복음 11:32–36',
    passage: { book: 'John', chapter: 11, startVerse: 32, endVerse: 36 },
    situationTags: ['사별', '상실', '죽음', '소중한 것을 잃음'],
    emotionTags: ['슬픔', '그리움', '허탈함'],
    spiritualQuestionTags: ['슬픔', '하나님의 함께하심', '소망'],
    prayerModes: ['탄식', '간구', '교제'],
    pastoralFunction: ['위로', '애도'],
    contextSummary:
      '나사로의 죽음 앞에서 마리아와 사람들이 울었고 예수님도 눈물을 흘리셨다. 예수께서는 슬픔을 무시하거나 인간의 고통을 냉정하게 바라보지 않으셨다.',
    theologicalInsight:
      '믿음은 슬픔을 빨리 떨쳐내는 능력이 아니다. 예수님도 사랑하는 이를 잃은 사람들과 함께 우셨으며, 성경은 우리의 눈물도 하나님 앞에 가져갈 수 있음을 보여준다.',
    userExplanation:
      '사랑하는 사람이나 소중한 것을 잃은 슬픔은 몇 마디 위로로 사라지지 않습니다. 예수님도 나사로의 죽음 앞에서 사람들과 함께 우셨습니다. 하나님 앞에서는 슬퍼하고 우는 것조차 기도가 될 수 있습니다.',
    prayerDirection:
      '괜찮아지려고 서두르지 않아도 됩니다. 지금 느끼는 슬픔과 그리움을 하나님께 그대로 말씀드리고, 이 시간을 견딜 수 있도록 함께해주시기를 구해보세요.',
    misuseGuards: [
      '슬픔을 빨리 극복하라고 요구하지 않는다.',
      '모든 상실 뒤에 숨은 하나님의 목적이 있다고 단정하지 않는다.',
    ],
  },
  {
    id: 'SC-010',
    domains: ['wisdom_discernment'],
    referenceLabel: '야고보서 1:5–8',
    passage: { book: 'James', chapter: 1, startVerse: 5, endVerse: 8 },
    situationTags: ['어떻게 해야 할지 모름', '판단이 어려움', '지혜가 필요함'],
    emotionTags: ['혼란', '막막함', '불확실함'],
    spiritualQuestionTags: ['지혜', '분별', '인도'],
    prayerModes: ['간구'],
    pastoralFunction: ['지혜', '인도'],
    contextSummary:
      '야고보는 시험과 어려움 속에서 지혜가 부족한 사람이 하나님께 구하도록 권한다. 하나님은 구하는 자에게 후히 주시는 분으로 묘사된다.',
    theologicalInsight:
      '하나님께 지혜를 구한다는 것은 미래를 점치듯 정답을 받아내는 것이 아니라, 어려운 상황 속에서 하나님을 신뢰하며 바르게 판단하고 살아갈 지혜를 구하는 것이다.',
    userExplanation:
      '무엇을 선택해야 할지 모를 때 모든 답을 혼자 만들어내야 하는 것은 아닙니다. 야고보는 지혜가 부족할 때 하나님께 구하라고 권합니다.',
    prayerDirection:
      '특정 답을 억지로 얻으려 하기보다, 상황을 바르게 보고 판단할 지혜와 필요한 용기를 하나님께 구해보세요.',
    misuseGuards: [
      '기도 뒤 처음 떠오른 생각을 하나님의 직접적인 응답이라고 단정하지 않는다.',
      '지혜를 구하는 기도를 현실적인 정보 수집과 숙고를 대신하는 것으로 사용하지 않는다.',
    ],
  },
];

/** 카드 id로 카드를 찾습니다. 없는 id면 오류를 냅니다. */
export function getScriptureCard(id: string): ScriptureCard {
  const card = SCRIPTURE_CARDS.find((item) => item.id === id);
  if (!card) {
    throw new Error(`없는 Scripture Card id입니다: ${id}`);
  }
  return card;
}

/** 카드가 가리키는 본문 위치 목록. 여러 장에 걸친 카드도 같은 방식으로 다룹니다. */
export function getCardPassages(card: ScriptureCard): PassageRef[] {
  return card.passages ?? [card.passage];
}
