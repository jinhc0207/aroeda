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
    situationTags: [
      '중요한 결정',
      '진로',
      '이사',
      '미래 선택',
      '방향을 모름',
      '무엇을 선택할지 모름',
      '새 직장으로 옮긴 선택을 돌아봄',
    ],
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
  {
    id: 'SC-011',
    domains: ['loneliness_isolation'],
    referenceLabel: '시편 27:7–10',
    passage: { book: 'Psalms', chapter: 27, startVerse: 7, endVerse: 10 },
    situationTags: ['외로움', '관계적 고립', '내 이야기를 할 사람이 없음'],
    emotionTags: ['외로움', '슬픔', '허탈함'],
    spiritualQuestionTags: ['하나님의 함께하심', '위로', '맡김'],
    prayerModes: ['탄식', '간구', '교제'],
    pastoralFunction: ['위로', '교제'],
    contextSummary:
      '시편 기자는 도움을 구하며 하나님께 얼굴을 찾고, 가장 가까운 관계가 흔들리는 순간에도 하나님께서 받아주신다는 소망을 고백한다.',
    theologicalInsight:
      '외로움은 믿음이 부족해서 생긴 감정으로 단정할 수 없다. 관계의 부재와 상처를 하나님께 가져가며, 하나님께서 버리지 않으신다는 약속 안에서 도움을 구할 수 있다.',
    userExplanation:
      '사람들 사이에 있어도 내 마음을 나눌 사람이 없으면 깊이 외로울 수 있습니다. 이 시편은 가까운 관계가 흔들리는 순간에도 하나님께 도움을 구하고 그분께 받아들여질 수 있음을 보여줍니다.',
    prayerDirection:
      '외롭고 단절된 마음을 하나님께 숨기지 말고 말씀드려보세요. 오늘 연락할 수 있는 안전한 사람이나 도움의 자원을 한 걸음 찾아갈 용기도 함께 구해보세요.',
    misuseGuards: [
      '외로움을 느끼는 것을 믿음 없음으로 정죄하지 않는다.',
      '하나님만 의지하라며 필요한 인간관계와 전문적인 도움을 끊게 하지 않는다.',
    ],
  },
  {
    id: 'SC-012',
    domains: ['family_parenting_conflict'],
    referenceLabel: '야고보서 1:19–20',
    passage: { book: 'James', chapter: 1, startVerse: 19, endVerse: 20 },
    situationTags: ['가족 갈등', '자녀와 갈등', '아이와 대화가 어려움', '아이와 대화할 때 서로 화냄', '부모-자녀 갈등'],
    emotionTags: ['분노', '답답함', '지침', '상처'],
    spiritualQuestionTags: ['관계 회복', '지혜', '온유'],
    prayerModes: ['간구', '회개', '결단'],
    pastoralFunction: ['지혜', '관계 회복'],
    contextSummary:
      '야고보는 공동체 안의 갈등을 다루며 듣기는 속히 하고 말하기와 성내기는 더디 하라고 권한다. 사람의 분노가 하나님의 의를 이루지 못함을 함께 가르친다.',
    theologicalInsight:
      '가족 갈등에서 믿음은 상대를 빨리 바꾸는 기술이 아니라, 서로의 말을 듣고 분노에 끌려가지 않도록 자신을 하나님께 맡기는 태도에서 시작한다.',
    userExplanation:
      '가족과 부딪힐 때 바로 해결하려다 말이 더 커질 수 있습니다. 이 말씀은 먼저 듣고, 서둘러 말하거나 화내지 않도록 자신을 돌아보며 관계를 다시 세울 길을 찾게 합니다.',
    prayerDirection:
      '상대에게 하고 싶은 말과 내 안의 화를 하나님께 먼저 말씀드려보세요. 오늘 한 번은 끼어들지 않고 듣고, 필요하다면 안전한 때에 차분히 대화할 지혜를 구해보세요.',
    misuseGuards: [
      '폭력과 학대 상황에서 무조건 참고 대화하라고 하지 않는다.',
      '갈등의 책임을 한 사람에게만 돌리거나 자녀를 정죄하지 않는다.',
    ],
  },
  {
    id: 'SC-013',
    domains: ['burnout_exhaustion'],
    referenceLabel: '마태복음 11:28–30',
    passage: { book: 'Matthew', chapter: 11, startVerse: 28, endVerse: 30 },
    situationTags: [
      '소진',
      '의욕 상실',
      '지속적인 탈진',
      '모든 것이 지침',
      '실수 뒤 모든 것을 포기하고 싶을 만큼 지침',
      '아침에 일어나는 것부터 버거움',
    ],
    emotionTags: ['지침', '무기력', '답답함', '낙심'],
    spiritualQuestionTags: ['쉼', '맡김', '위로'],
    prayerModes: ['간구', '신뢰', '교제'],
    pastoralFunction: ['쉼', '위로'],
    contextSummary:
      '예수께서는 수고하고 무거운 짐 진 사람들을 부르시며 자신의 멍에를 메고 배우라고 하신다. 쉼은 현실의 책임을 부정하는 말이 아니라 예수께 나아오는 초대다.',
    theologicalInsight:
      '소진한 사람에게 쉼은 나약함의 증거가 아니다. 예수께 짐을 가지고 나아가며 몸과 마음의 한계를 인정하고 필요한 도움을 받는 것도 믿음의 한 걸음이다.',
    userExplanation:
      '계속 버티다 보면 무엇을 해도 힘이 나지 않을 수 있습니다. 예수님은 지친 사람에게 더 노력하라고 먼저 말씀하지 않고, 무거운 짐을 가지고 자신에게 오라고 초대하십니다.',
    prayerDirection:
      '지금 감당하기 어려운 일과 몸의 피로를 하나님께 구체적으로 말씀드려보세요. 오늘 꼭 쉬어야 할 일 한 가지와 도움을 요청할 사람 한 명을 정해보세요.',
    misuseGuards: [
      '휴식과 도움 요청을 게으름이나 믿음 없음으로 부르지 않는다.',
      '심한 우울, 수면 문제, 일상 기능 저하를 기도만으로 해결하라고 하지 않는다.',
    ],
  },
  {
    id: 'SC-014',
    domains: ['spiritual_dryness'],
    referenceLabel: '시편 42:1–5',
    passage: { book: 'Psalms', chapter: 42, startVerse: 1, endVerse: 5 },
    situationTags: ['하나님이 멀게 느껴짐', '기도해도 아무 느낌이 없음', '영적 침체', '버림받은 것 같음'],
    emotionTags: ['목마름', '낙심', '슬픔', '답답함'],
    spiritualQuestionTags: ['하나님의 침묵', '하나님의 함께하심', '소망'],
    prayerModes: ['탄식', '간구', '신뢰'],
    pastoralFunction: ['탄식', '소망', '위로', '교제'],
    contextSummary:
      '시편 기자는 하나님을 찾는 목마름과 깊은 낙심을 숨기지 않고 하나님께 묻는다. 그는 자신의 영혼에게 다시 하나님을 바라보라고 말하며 소망을 붙든다.',
    theologicalInsight:
      '하나님을 느끼지 못하는 시간이 곧 하나님이 떠났다는 증거는 아니다. 성경은 영적 메마름과 질문을 하나님께 솔직히 가져가면서도 소망을 놓지 않는 기도를 허락한다.',
    userExplanation:
      '기도해도 아무 느낌이 없고 하나님이 멀게 느껴질 때가 있습니다. 시편 기자도 그런 목마름과 낙심을 겪었지만, 그 마음을 숨기지 않고 하나님께 가져갔습니다.',
    prayerDirection:
      '느낌을 만들어내려 애쓰기보다 지금의 메마름을 그대로 하나님께 말씀드려보세요. 짧은 말씀 한 구절을 읽고, 오늘 붙들 수 있는 작은 소망을 구해보세요.',
    misuseGuards: [
      '하나님을 느끼지 못하는 것을 곧바로 죄나 믿음 없음으로 판단하지 않는다.',
      '즉각적인 감정 변화나 특별한 체험을 약속하지 않는다.',
    ],
  },
  {
    id: 'SC-015',
    domains: ['financial_hardship'],
    referenceLabel: '마태복음 6:25–34',
    passage: { book: 'Matthew', chapter: 6, startVerse: 25, endVerse: 34 },
    situationTags: ['생활비 부족', '경제적 어려움', '생계 걱정', '돈 문제', '돈 걱정으로 잠을 못 잠'],
    emotionTags: ['불안', '걱정', '두려움', '막막함'],
    spiritualQuestionTags: ['하나님의 돌보심', '신뢰', '맡김'],
    prayerModes: ['간구', '신뢰'],
    pastoralFunction: ['위로', '신뢰'],
    contextSummary:
      '예수께서는 먹을 것과 입을 것을 염려하는 사람들에게 하나님 아버지께서 필요를 아신다고 가르치신다. 동시에 오늘의 책임을 오늘 감당하라고 말씀하신다.',
    theologicalInsight:
      '하나님의 돌보심은 부자가 되거나 문제가 즉시 해결된다는 약속이 아니다. 경제적 걱정을 하나님께 맡기면서도 실제 예산, 지원 제도, 주변의 도움을 함께 살피게 한다.',
    userExplanation:
      '생활비와 빚이 걱정되면 마음이 하루 종일 붙잡힐 수 있습니다. 예수님은 그 필요를 가볍게 여기지 않으시면서, 오늘 필요한 일을 감당하고 하나님께 도움을 구하도록 초대하십니다.',
    prayerDirection:
      '당장 필요한 금액과 걱정을 하나님께 구체적으로 말씀드려보세요. 동시에 상담, 복지 제도, 가족이나 신뢰할 사람의 도움을 알아볼 용기를 구해보세요.',
    misuseGuards: [
      '헌금이나 긍정적인 생각만으로 경제 문제가 해결된다고 약속하지 않는다.',
      '가난을 개인의 믿음 부족이나 죄의 결과로 단정하지 않는다.',
    ],
  },
  {
    id: 'SC-016',
    domains: ['chronic_illness'],
    referenceLabel: '고린도후서 12:7–10',
    passage: { book: '2Corinthians', chapter: 12, startVerse: 7, endVerse: 10 },
    situationTags: ['만성질환', '질병 진단', '아픈 몸과 함께 살아감', '치료가 길어짐', '좋아졌다가 다시 아파짐'],
    emotionTags: ['지침', '두려움', '낙심', '슬픔'],
    spiritualQuestionTags: ['하나님의 함께하심', '은혜', '맡김'],
    prayerModes: ['탄식', '간구', '신뢰'],
    pastoralFunction: ['위로', '인내'],
    contextSummary:
      '바울은 자신을 괴롭히는 가시를 없애달라고 세 번 간구했지만, 주님의 은혜가 충분하다는 말씀을 듣는다. 그는 약함 속에서 그리스도의 능력을 의지한다고 고백한다.',
    theologicalInsight:
      '질병이 낫지 않았다는 사실만으로 하나님의 부재나 개인의 실패를 결론 내릴 수 없다. 은혜는 치료의 결과와 별개로 아픈 몸을 살아가는 사람과 함께하며 필요한 힘과 도움을 준다.',
    userExplanation:
      '오래 아픈 몸으로 살아가는 일은 매일의 계획과 마음을 함께 흔듭니다. 바울도 자신의 고통이 없어지기를 구했지만, 응답을 기다리는 동안 주님의 은혜를 붙들었습니다.',
    prayerDirection:
      '통증과 두려움, 지치는 치료 과정을 하나님께 그대로 말씀드려보세요. 낫게 해달라는 기도와 함께 오늘 필요한 의료적 도움과 견딜 힘도 구해보세요.',
    misuseGuards: [
      '기도하면 반드시 병이 낫는다고 약속하지 않는다.',
      '치료 중단이나 의료진의 도움 거부를 신앙으로 포장하지 않는다.',
    ],
  },
  {
    id: 'SC-017',
    domains: ['relationship_conflict_forgiveness'],
    referenceLabel: '골로새서 3:12–13',
    passage: { book: 'Colossians', chapter: 3, startVerse: 12, endVerse: 13 },
    situationTags: ['관계 갈등', '용서하고 싶음', '관계를 회복하고 싶음', '상처 준 사람'],
    emotionTags: ['분노', '상처', '서운함', '답답함'],
    spiritualQuestionTags: ['용서', '관계 회복', '긍휼'],
    prayerModes: ['탄식', '간구', '결단'],
    pastoralFunction: ['관계 회복', '용서', '위로'],
    contextSummary:
      '바울은 성도들이 긍휼과 겸손과 오래 참음을 입고 서로 용납하며 주께서 용서하신 것처럼 서로 용서하라고 권한다.',
    theologicalInsight:
      '용서는 잘못을 없던 일로 만들거나 신뢰를 즉시 회복하는 뜻이 아니다. 하나님께 받은 긍휼을 기억하며 복수에 붙잡히지 않되, 필요한 경계와 책임을 함께 세울 수 있다.',
    userExplanation:
      '상처 준 사람을 용서하고 싶어도 마음이 따라오지 않을 수 있습니다. 이 말씀은 억지로 괜찮은 척하라고 하지 않고, 하나님께 받은 긍휼을 기억하며 한 걸음씩 관계의 방향을 다시 살피게 합니다.',
    prayerDirection:
      '상처와 분노를 하나님께 정직하게 말씀드려보세요. 당장 화해를 서두르기보다, 내가 내려놓을 복수심과 지켜야 할 경계를 분별할 지혜를 구해보세요.',
    misuseGuards: [
      '용서를 이유로 가해자와 즉시 만나거나 관계를 회복하도록 강요하지 않는다.',
      '폭력·학대·범죄의 책임과 피해자의 안전을 가볍게 여기지 않는다.',
    ],
  },
  {
    id: 'SC-018',
    domains: ['loneliness_isolation'],
    referenceLabel: '히브리서 13:5–6',
    passage: { book: 'Hebrews', chapter: 13, startVerse: 5, endVerse: 6 },
    situationTags: ['버림받은 것 같음', '혼자 견딤', '도움이 필요함', '연락할 사람이 없어 혼자 견딤'],
    emotionTags: ['두려움', '외로움', '불안'],
    spiritualQuestionTags: ['하나님의 함께하심', '맡김', '신뢰'],
    prayerModes: ['간구', '신뢰'],
    pastoralFunction: ['위로', '신뢰'],
    contextSummary: '히브리서는 돈과 사람의 인정에 매이지 말고 하나님께서 떠나지 않으신다는 약속을 붙들라고 권한다.',
    theologicalInsight: '하나님의 함께하심은 외로움이 즉시 사라진다는 뜻이 아니라, 도움을 구하며 두려움에 홀로 맡겨지지 않았다는 고백의 근거다.',
    userExplanation: '혼자 버티는 시간이 길어지면 누구에게도 기대기 어렵다고 느낄 수 있습니다. 이 말씀은 하나님이 떠나지 않으신다는 약속을 붙들며 도움을 요청할 용기를 줍니다.',
    prayerDirection: '혼자 견디고 있는 일을 하나님께 구체적으로 말씀드리고, 오늘 연락할 수 있는 안전한 사람이나 기관을 찾게 해달라고 구해보세요.',
    misuseGuards: ['하나님만 있으면 사람의 도움은 필요 없다고 말하지 않는다.', '위험하거나 학대적인 관계로 돌아가라고 권하지 않는다.'],
  },
  {
    id: 'SC-019',
    domains: ['loneliness_isolation'],
    referenceLabel: '로마서 12:4–5',
    passage: { book: 'Romans', chapter: 12, startVerse: 4, endVerse: 5 },
    situationTags: ['소속되고 싶음', '공동체가 필요함', '사람들과 연결되고 싶음'],
    emotionTags: ['외로움', '기대', '불안'],
    spiritualQuestionTags: ['공동체', '하나님의 함께하심', '사랑'],
    prayerModes: ['간구', '결단', '교제'],
    pastoralFunction: ['교제', '소망'],
    contextSummary: '바울은 여러 지체가 한 몸을 이루듯 믿는 사람들이 서로 연결되어 있음을 설명한다.',
    theologicalInsight: '소속은 나의 가치를 증명해야 얻는 보상이 아니라 서로 돌보도록 부름받은 공동체 안에서 자라난다.',
    userExplanation: '어디에도 속하지 못한 것처럼 느껴질 때가 있습니다. 성경은 혼자 완벽해져야 공동체에 들어갈 수 있다고 말하지 않고, 서로 연결된 사람으로 부릅니다.',
    prayerDirection: '내가 원하는 공동체의 모습을 하나님께 말씀드리고, 부담스럽지 않은 작은 만남이나 도움 요청부터 시작할 지혜를 구해보세요.',
    misuseGuards: ['어떤 공동체든 무조건 머물러야 한다고 하지 않는다.', '배제나 차별을 당하는 사람에게 적응 책임을 돌리지 않는다.'],
  },
  {
    id: 'SC-020',
    domains: ['family_parenting_conflict'],
    referenceLabel: '잠언 15:1–2',
    passage: { book: 'Proverbs', chapter: 15, startVerse: 1, endVerse: 2 },
    situationTags: ['말다툼', '거친 말', '차분히 대화하고 싶음', '배우자와 양육 방식이 다름'],
    emotionTags: ['분노', '답답함', '상처'],
    spiritualQuestionTags: ['온유', '지혜', '관계 회복'],
    prayerModes: ['간구', '결단'],
    pastoralFunction: ['지혜', '관계 회복'],
    contextSummary: '잠언은 부드러운 대답이 분노를 쉬게 하지만 과격한 말은 화를 일으킨다고 가르친다.',
    theologicalInsight: '온유한 말은 잘못을 덮는 말이 아니라 갈등을 더 키우지 않도록 진실을 다루는 방식이다.',
    userExplanation: '가족과 이야기할수록 말이 거칠어질 때가 있습니다. 이 말씀은 내 말을 무조건 참으라는 뜻이 아니라, 관계를 더 상하게 하지 않는 말의 속도를 배우게 합니다.',
    prayerDirection: '오늘 대화에서 꼭 전해야 할 한 문장과 잠시 멈춰야 할 순간을 하나님께 구해보세요.',
    misuseGuards: ['폭언과 위협을 당해도 부드럽게만 답하라고 하지 않는다.', '상대의 잘못을 피해자가 감당해야 한다고 말하지 않는다.'],
  },
  {
    id: 'SC-021',
    domains: ['family_parenting_conflict'],
    referenceLabel: '에베소서 6:1–4',
    passage: { book: 'Ephesians', chapter: 6, startVerse: 1, endVerse: 4 },
    situationTags: ['자녀 양육', '부모의 기대', '아이를 노엽게 함'],
    emotionTags: ['걱정', '죄책감', '지침'],
    spiritualQuestionTags: ['양육', '지혜', '사랑'],
    prayerModes: ['회개', '간구', '결단'],
    pastoralFunction: ['지혜', '관계 회복'],
    contextSummary: '바울은 자녀와 부모 모두에게 책임을 말하며, 부모가 자녀를 노엽게 하지 말고 주의 가르침으로 양육하라고 권한다.',
    theologicalInsight: '양육은 통제와 성취를 강요하는 일이 아니라 자녀를 한 사람으로 존중하며 책임 있게 돌보는 과정이다.',
    userExplanation: '아이를 잘 키우고 싶은 마음이 오히려 압박과 잔소리가 될 수 있습니다. 이 말씀은 부모의 권리만이 아니라 자녀를 낙심시키지 않을 책임도 함께 보여줍니다.',
    prayerDirection: '아이에게 기대하는 것과 아이의 실제 필요를 구분할 지혜를 구하고, 오늘 한 번은 먼저 아이의 말을 들어보세요.',
    misuseGuards: ['부모의 권위를 이용해 통제와 폭력을 정당화하지 않는다.', '자녀에게 모든 갈등의 책임을 돌리지 않는다.'],
  },
  {
    id: 'SC-022',
    domains: ['burnout_exhaustion'],
    referenceLabel: '열왕기상 19:4–8',
    passage: { book: '1Kings', chapter: 19, startVerse: 4, endVerse: 8 },
    situationTags: ['완전히 지침', '쉬고 싶음', '아무것도 못하겠음'],
    emotionTags: ['무기력', '낙심', '지침'],
    spiritualQuestionTags: ['쉼', '하나님의 돌보심', '맡김'],
    prayerModes: ['탄식', '교제', '간구'],
    pastoralFunction: ['쉼', '위로'],
    contextSummary: '엘리야는 지쳐 쓰러져 죽기를 구했고, 하나님은 그를 책망하기보다 잠과 음식으로 회복하게 하신다.',
    theologicalInsight: '지친 사람에게 필요한 것은 언제나 더 큰 결심이 아니다. 몸의 한계를 인정하고 쉬며 다시 걸을 힘을 받는 과정도 하나님의 돌보심 안에 있다.',
    userExplanation: '아무것도 할 수 없을 만큼 지칠 때 자신을 책망하기 쉽습니다. 엘리야도 쓰러졌고, 하나님은 먼저 그가 쉬고 먹도록 돌보셨습니다.',
    prayerDirection: '지금 몸이 보내는 신호를 하나님께 말씀드리고, 오늘 미뤄도 되는 일과 도움을 요청할 사람을 하나 정해보세요.',
    misuseGuards: ['휴식과 치료를 게으름으로 부르지 않는다.', '우울과 자살 사고를 단순한 피곤함으로 축소하지 않는다.'],
  },
  {
    id: 'SC-023',
    domains: ['burnout_exhaustion'],
    referenceLabel: '시편 23:1–3',
    passage: { book: 'Psalms', chapter: 23, startVerse: 1, endVerse: 3 },
    situationTags: ['회복이 필요함', '일을 멈추기 어려움', '마음의 쉼'],
    emotionTags: ['지침', '불안', '평안'],
    spiritualQuestionTags: ['쉼', '인도', '하나님의 돌보심'],
    prayerModes: ['신뢰', '교제'],
    pastoralFunction: ['쉼', '인도'],
    contextSummary: '시편은 목자가 양을 푸른 풀밭과 쉴 만한 물가로 인도하고 영혼을 소생시킨다고 노래한다.',
    theologicalInsight: '하나님의 인도는 성과를 계속 내게 하는 압박이 아니라, 생명을 회복하도록 멈추고 방향을 다시 세우는 돌봄이다.',
    userExplanation: '계속 달리기만 하면 내 마음이 어디로 가는지도 잊을 수 있습니다. 이 시편은 하나님이 지친 사람을 회복의 자리로 이끄신다고 노래합니다.',
    prayerDirection: '오늘 몸과 마음이 쉴 수 있는 짧은 시간을 하나님께 맡기고, 회복을 방해하는 한 가지 부담을 내려놓아 보세요.',
    misuseGuards: ['모든 문제의 해결을 즉시 평안해지는 것으로 약속하지 않는다.', '휴식만으로 심각한 정신건강 문제를 해결한다고 하지 않는다.'],
  },
  {
    id: 'SC-024',
    domains: ['spiritual_dryness'],
    referenceLabel: '시편 63:1–5',
    passage: { book: 'Psalms', chapter: 63, startVerse: 1, endVerse: 5 },
    situationTags: ['영혼의 목마름', '하나님을 찾음', '예배의 기쁨을 잃음', '신앙생활이 습관만 남음'],
    emotionTags: ['목마름', '허탈함', '낙심'],
    spiritualQuestionTags: ['하나님을 찾음', '하나님의 함께하심', '소망'],
    prayerModes: ['탄식', '간구', '찬양'],
    pastoralFunction: ['소망', '교제'],
    contextSummary: '시편 기자는 메마른 땅에서 하나님을 갈망하며, 환경이 아니라 하나님을 향한 갈망을 노래한다.',
    theologicalInsight: '영적 갈망은 이미 모든 답을 가진 상태가 아니라, 메마름 속에서도 하나님을 다시 찾는 움직임이다.',
    userExplanation: '마음이 메마르면 하나님을 찾고 싶은 마음조차 약해질 수 있습니다. 시편 기자는 그런 목마름을 숨기지 않고 하나님께 가져갑니다.',
    prayerDirection: '짧은 한 문장으로 지금 하나님께 바라는 것을 말하고, 억지 감정 대신 정직한 갈망을 드려보세요.',
    misuseGuards: ['감정이 생겨야 진짜 믿음이라고 말하지 않는다.', '특별한 체험을 얻는 방법처럼 말씀을 사용하지 않는다.'],
  },
  {
    id: 'SC-025',
    domains: ['spiritual_dryness'],
    referenceLabel: '마가복음 9:23–24',
    passage: { book: 'Mark', chapter: 9, startVerse: 23, endVerse: 24 },
    situationTags: ['믿음이 흔들림', '의심이 생김', '믿고 싶음'],
    emotionTags: ['두려움', '혼란', '낙심'],
    spiritualQuestionTags: ['믿음', '의심', '도움이 필요함'],
    prayerModes: ['간구', '탄식'],
    pastoralFunction: ['위로', '소망'],
    contextSummary: '한 아버지는 믿고 싶지만 믿음이 약하다고 고백하며 예수께 도와달라고 간구한다.',
    theologicalInsight: '믿음과 의심이 뒤섞인 고백도 하나님께 드릴 수 있다. 완벽한 확신을 연기해야만 하나님께 나아갈 수 있는 것은 아니다.',
    userExplanation: '믿고 싶지만 마음에 의심이 생길 때 스스로를 비난할 수 있습니다. 이 아버지는 그 복잡한 마음을 숨기지 않고 예수님께 도움을 구했습니다.',
    prayerDirection: '“믿고 싶지만 어렵습니다”라는 말 그대로 하나님께 드리고, 오늘 붙들 수 있는 작은 신뢰를 구해보세요.',
    misuseGuards: ['의심을 죄로 단정해 질문을 막지 않는다.', '믿음의 크기가 문제 해결의 조건이라고 약속하지 않는다.'],
  },
  {
    id: 'SC-026',
    domains: ['financial_hardship'],
    referenceLabel: '잠언 30:8–9',
    passage: { book: 'Proverbs', chapter: 30, startVerse: 8, endVerse: 9 },
    situationTags: ['일용할 필요', '생활비 부족', '정직하게 살고 싶음', '월세 후 식비가 부족함'],
    emotionTags: ['걱정', '불안', '부끄러움'],
    spiritualQuestionTags: ['일용할 양식', '정직', '자족'],
    prayerModes: ['간구', '결단'],
    pastoralFunction: ['지혜', '신뢰'],
    contextSummary: '잠언 기자는 거짓과 과도한 가난을 피하게 하시고 날마다 필요한 양식을 달라고 기도한다.',
    theologicalInsight: '성경의 경제적 기도는 부를 약속하는 주문이 아니라 필요한 것을 정직하게 구하고 삶의 균형을 찾는 간구다.',
    userExplanation: '돈이 부족할 때 욕심을 숨기거나 가난을 부끄러워할 필요는 없습니다. 이 기도는 오늘 필요한 것을 정직하게 구하는 기도입니다.',
    prayerDirection: '이번 주에 꼭 필요한 것을 구체적으로 적어 하나님께 말씀드리고, 이용할 수 있는 지원과 상담을 찾아보세요.',
    misuseGuards: ['가난을 믿음 부족으로 해석하지 않는다.', '헌금이나 금전 제공을 조건으로 하나님의 도움을 약속하지 않는다.'],
  },
  {
    id: 'SC-027',
    domains: ['financial_hardship'],
    referenceLabel: '빌립보서 4:10–13',
    passage: { book: 'Philippians', chapter: 4, startVerse: 10, endVerse: 13 },
    situationTags: ['수입 변화', '구직 중', '형편이 달라짐', '수입이 줄어 교육비를 감당하기 어려움'],
    emotionTags: ['불안', '낙심', '감사'],
    spiritualQuestionTags: ['자족', '하나님의 돌보심', '인내'],
    prayerModes: ['간구', '감사', '신뢰'],
    pastoralFunction: ['인내', '신뢰'],
    contextSummary: '바울은 풍부함과 궁핍을 모두 경험하며 어떤 형편에서도 자족하는 법을 배웠다고 고백한다.',
    theologicalInsight: '자족은 경제적 어려움을 부정하거나 도움을 거절하는 태도가 아니라, 형편의 변화 속에서도 사람의 존엄과 하나님의 도움을 놓지 않는 태도다.',
    userExplanation: '수입이 줄거나 일자리를 찾는 시간이 길어지면 마음도 흔들립니다. 바울의 고백은 어려움을 없던 일로 만들지 않으면서도 그 안에서 버틸 힘을 찾게 합니다.',
    prayerDirection: '현재 필요한 도움과 구직의 길을 하나님께 구하고, 오늘 할 수 있는 현실적인 한 걸음을 정해보세요.',
    misuseGuards: ['“모든 것을 할 수 있다”를 경제적 성공 보장으로 해석하지 않는다.', '도움을 받는 일을 부끄럽게 만들지 않는다.'],
  },
  {
    id: 'SC-028',
    domains: ['chronic_illness'],
    referenceLabel: '시편 73:25–26',
    passage: { book: 'Psalms', chapter: 73, startVerse: 25, endVerse: 26 },
    situationTags: ['몸이 약해짐', '치료가 길어짐', '한계가 느껴짐'],
    emotionTags: ['지침', '두려움', '낙심'],
    spiritualQuestionTags: ['하나님의 함께하심', '맡김', '소망'],
    prayerModes: ['탄식', '신뢰'],
    pastoralFunction: ['위로', '소망'],
    contextSummary: '시편 기자는 몸과 마음이 쇠약해지는 가운데서도 하나님이 마음의 반석이 되신다고 고백한다.',
    theologicalInsight: '몸의 약함은 사람의 가치가 줄었다는 뜻이 아니다. 건강의 한계 속에서도 하나님께 기대며 도움을 받을 수 있다.',
    userExplanation: '몸이 예전 같지 않으면 나 자신까지 작아진 것처럼 느껴질 수 있습니다. 이 시편은 약해진 몸을 부정하지 않으면서 하나님을 의지할 수 있다고 말합니다.',
    prayerDirection: '오늘 몸의 한계와 마음의 두려움을 하나님께 말씀드리고, 필요한 돌봄을 요청할 용기를 구해보세요.',
    misuseGuards: ['질병을 영적 실패로 해석하지 않는다.', '치료와 보조기기 사용을 믿음 부족으로 몰지 않는다.'],
  },
  {
    id: 'SC-029',
    domains: ['chronic_illness'],
    referenceLabel: '로마서 8:22–26',
    passage: { book: 'Romans', chapter: 8, startVerse: 22, endVerse: 26 },
    situationTags: ['말할 힘이 없음', '오래 아픔', '신음과 기다림'],
    emotionTags: ['지침', '슬픔', '답답함'],
    spiritualQuestionTags: ['성령의 도우심', '소망', '탄식'],
    prayerModes: ['탄식', '간구'],
    pastoralFunction: ['위로', '인내'],
    contextSummary: '바울은 피조물과 성도가 함께 탄식한다고 말하며, 말할 수 없는 탄식 가운데 성령께서 도우신다고 가르친다.',
    theologicalInsight: '오래된 질병의 신음은 믿음이 없다는 증거가 아니다. 말로 다 표현하지 못하는 고통도 하나님께 드려질 수 있다.',
    userExplanation: '아픈 시간이 길어지면 기도할 말조차 사라질 수 있습니다. 성경은 그런 신음도 하나님께서 아시고 도우신다고 말합니다.',
    prayerDirection: '말 대신 한숨이나 짧은 단어로라도 하나님께 마음을 내어드리고, 오늘 필요한 사람의 도움을 받아보세요.',
    misuseGuards: ['고통을 참는 것이 믿음의 목표라고 하지 않는다.', '치료 지연이나 악화를 하나님의 뜻으로 단정하지 않는다.'],
  },
  {
    id: 'SC-030',
    domains: ['relationship_conflict_forgiveness'],
    referenceLabel: '로마서 12:17–21',
    passage: { book: 'Romans', chapter: 12, startVerse: 17, endVerse: 21 },
    situationTags: ['복수하고 싶음', '악의 반복', '갈등을 멈추고 싶음'],
    emotionTags: ['분노', '상처', '두려움'],
    spiritualQuestionTags: ['용서', '정의', '관계 회복'],
    prayerModes: ['탄식', '간구', '결단'],
    pastoralFunction: ['정의', '관계 회복', '위로'],
    contextSummary: '바울은 악을 악으로 갚지 말고 가능한 한 평화를 이루되, 원수 갚는 일은 하나님께 맡기라고 권한다.',
    theologicalInsight: '복수를 내려놓는 것은 불의를 승인하는 일이 아니다. 필요한 보호와 정의를 구하면서도 자신을 파괴하는 보복의 사슬에서 벗어나는 길이다.',
    userExplanation: '상처를 받은 뒤 똑같이 갚아주고 싶은 마음이 들 수 있습니다. 이 말씀은 그 분노를 숨기지 않으면서도 복수에 내 삶을 맡기지 않도록 돕습니다.',
    prayerDirection: '상대에게 당한 일을 하나님께 구체적으로 말씀드리고, 안전을 지키면서 내가 내려놓을 보복 행동을 하나 정해보세요.',
    misuseGuards: ['폭력과 범죄를 참고 평화롭게만 해결하라고 하지 않는다.', '피해 신고와 법적 보호를 막지 않는다.'],
  },
  {
    id: 'SC-031',
    domains: ['relationship_conflict_forgiveness'],
    referenceLabel: '마태복음 18:15–17',
    passage: { book: 'Matthew', chapter: 18, startVerse: 15, endVerse: 17 },
    situationTags: ['문제를 직접 말하고 싶음', '사과와 책임', '갈등을 풀고 싶음'],
    emotionTags: ['두려움', '답답함', '상처'],
    spiritualQuestionTags: ['진실', '관계 회복', '책임'],
    prayerModes: ['간구', '결단'],
    pastoralFunction: ['관계 회복', '정의'],
    contextSummary: '예수께서는 공동체 안의 잘못을 다룰 때 당사자에게 말하고, 필요하면 신뢰할 수 있는 사람의 도움을 받는 단계를 가르치신다.',
    theologicalInsight: '관계 회복은 문제를 덮는 일이 아니라 사실을 안전하게 말하고 책임을 확인하는 과정이다.',
    userExplanation: '갈등을 피하다 보면 상처가 더 커질 수 있습니다. 예수님은 혼자 폭발하거나 소문내기보다 안전하고 정직한 절차로 문제를 다루도록 가르치십니다.',
    prayerDirection: '말해야 할 사실과 지켜야 할 경계를 정리하고, 혼자 감당하지 않도록 믿을 수 있는 중재자를 구해보세요.',
    misuseGuards: ['가해자와 피해자를 무조건 마주 앉히지 않는다.', '안전이 확보되지 않은 상황에서 화해 절차를 강요하지 않는다.'],
  },
  {
    id: 'SC-032',
    domains: ['fear_uncertainty'],
    referenceLabel: '빌립보서 4:4–7',
    passage: { book: 'Philippians', chapter: 4, startVerse: 4, endVerse: 7 },
    situationTags: ['검사 결과를 기다림', '면접이나 시험 결과를 기다림', '중요한 평가를 앞둠'],
    emotionTags: ['불안', '초조함', '긴장'],
    spiritualQuestionTags: ['신뢰', '맡김'],
    prayerModes: ['간구', '신뢰'],
    pastoralFunction: ['위로', '신뢰'],
    contextSummary:
      '바울은 갇힌 형편에서 빌립보 교회에 기쁨과 관용을 권하고, 염려를 숨기거나 부정하기보다 구체적인 요청을 감사와 함께 하나님께 아뢰라고 한다.',
    theologicalInsight:
      '하나님의 평강은 원하는 결과를 보장하는 예고가 아니라, 결과를 아직 모르는 동안에도 마음과 생각을 지키시는 하나님의 돌보심이다.',
    userExplanation:
      '결과를 기다리는 동안 불안한 것은 이상한 일이 아닙니다. 바울은 걱정을 억지로 없애라고만 하지 않고, 무엇이 두려운지 구체적으로 하나님께 아뢰도록 권합니다. 아직 결과를 몰라도 마음을 지켜 달라고 구할 수 있습니다.',
    prayerDirection:
      '기다리고 있는 결과와 가장 두려운 가능성을 하나님께 솔직히 말씀드리고, 원하는 결과만이 아니라 기다리는 동안 마음과 생각을 지켜 달라고 구해보세요.',
    misuseGuards: [
      '불안을 느끼는 것을 믿음 부족으로 정죄하지 않는다.',
      '기도가 상담·진료·검사 결과 확인 같은 현실의 도움을 대신한다고 말하지 않는다.',
      '기도하면 원하는 결과가 나온다고 약속하지 않는다.',
    ],
  },
  {
    id: 'SC-033',
    domains: ['fear_uncertainty'],
    referenceLabel: '이사야 41:8–10',
    passage: { book: 'Isaiah', chapter: 41, startVerse: 8, endVerse: 10 },
    situationTags: ['새로운 환경을 앞둠', '낯선 곳에 적응해야 함', '예상하지 못한 일을 걱정함'],
    emotionTags: ['두려움', '불확실함', '막막함'],
    spiritualQuestionTags: ['하나님의 함께하심', '신뢰', '위로'],
    prayerModes: ['간구', '신뢰'],
    pastoralFunction: ['위로', '확신'],
    contextSummary:
      '이사야는 포로와 위협의 기억 속에 있는 이스라엘을 하나님이 자신의 종으로 부르고 버리지 않으셨다고 선언하며, 두려움 속에서도 하나님의 동행과 붙드심을 바라보게 한다.',
    theologicalInsight:
      '이 약속의 중심은 위험이 전혀 생기지 않는다는 보장이 아니라, 하나님이 자기 백성을 버리지 않고 두려운 길에서 붙드신다는 언약적 동행이다.',
    userExplanation:
      '낯선 환경과 변화를 앞두면 앞날을 알 수 없어 두려울 수 있습니다. 이 말씀은 아무 일도 생기지 않을 것이라고 장담하기보다, 두려운 길에서도 하나님이 버리지 않고 함께하신다는 약속을 바라보게 합니다.',
    prayerDirection:
      '새로운 환경에서 특히 두려운 점을 말씀드리고, 모든 변수를 통제하게 해달라고만 구하기보다 그 길에서 하나님의 동행을 신뢰하도록 구해보세요.',
    misuseGuards: [
      '이스라엘에게 주어진 문맥을 지우고 모든 개인의 계획이 성공한다는 약속으로 바꾸지 않는다.',
      '사고·질병·실패가 절대 없을 것이라고 단정하지 않는다.',
      '필요한 준비나 안전 계획을 멈추게 하지 않는다.',
    ],
  },
  {
    id: 'SC-034',
    domains: ['decision_guidance'],
    referenceLabel: '잠언 15:22–23',
    passage: { book: 'Proverbs', chapter: 15, startVerse: 22, endVerse: 23 },
    situationTags: [
      '여러 사람의 조언을 구함',
      '관계에 대한 선택',
      '결혼이나 재혼 여부를 결정함',
      '가족과 상의할 결정',
    ],
    emotionTags: ['혼란', '걱정', '불확실함'],
    spiritualQuestionTags: ['지혜', '공동체'],
    prayerModes: ['간구', '결단'],
    pastoralFunction: ['지혜', '인도'],
    contextSummary:
      '잠언은 중요한 계획을 혼자 확정하기보다 숙고하고 적절한 조언을 들으며, 때에 맞는 지혜로운 말을 분별하는 삶을 가르친다.',
    theologicalInsight:
      '하나님의 인도는 언제나 혼자 받은 즉각적인 확신의 형태로만 오지 않으며, 신뢰할 만한 사람의 조언과 충분한 숙고를 통해서도 구체화될 수 있다.',
    userExplanation:
      '중요한 선택을 혼자 감당하려 하면 생각이 한쪽으로 기울 수 있습니다. 이 말씀은 결정을 남에게 떠넘기라는 뜻이 아니라, 믿을 만한 조언을 듣고 충분히 생각하며 책임 있게 결정하도록 돕습니다.',
    prayerDirection:
      '누구의 조언을 들어야 할지 지혜를 구하고, 듣기 좋은 말만 고르지 않도록 기도해보세요. 조언을 들은 뒤에는 자신의 책임으로 정직하게 결정할 용기도 구해보세요.',
    misuseGuards: [
      '조언자의 다수결을 곧 하나님의 뜻이라고 단정하지 않는다.',
      '이해관계가 있거나 안전하지 않은 사람에게 반드시 상담하라고 하지 않는다.',
      '사용자의 선택 책임과 현실 정보 확인을 없애지 않는다.',
    ],
  },
  {
    id: 'SC-035',
    domains: ['decision_guidance'],
    referenceLabel: '누가복음 14:28–33',
    passage: { book: 'Luke', chapter: 14, startVerse: 28, endVerse: 33 },
    situationTags: ['큰 비용이 드는 결정', '결정의 대가를 따져봄', '새 일을 시작할지 고민함', '창업과 안정적인 길 사이에서 고민함'],
    emotionTags: ['막막함', '걱정', '혼란'],
    spiritualQuestionTags: ['지혜', '책임', '인도'],
    prayerModes: ['간구', '결단'],
    pastoralFunction: ['지혜', '관점 전환'],
    contextSummary:
      '예수님은 제자도의 실제 대가를 설명하며 망대와 전쟁의 비유를 드신다. 두 비유는 시작 전에 필요한 대가와 책임을 진지하게 헤아리는 태도를 보여준다.',
    theologicalInsight:
      '믿음의 결정은 충동이나 막연한 확신과 같지 않다. 하나님 앞의 헌신은 현실의 비용과 책임을 정직하게 살피는 숙고를 포함한다.',
    userExplanation:
      '큰돈이나 긴 책임이 따르는 결정은 마음만 급하게 정해도, 두려워서 계속 미뤄도 어렵습니다. 예수님의 비유는 중요한 약속을 시작하기 전에 실제 대가와 감당할 책임을 차분히 살펴보게 합니다.',
    prayerDirection:
      '얻을 것만 아니라 시간·비용·관계·책임을 정직하게 보게 해달라고 구하세요. 두려움이나 욕심 때문에 중요한 사실을 외면하지 않도록 기도해보세요.',
    misuseGuards: [
      '이 본문의 직접 문맥이 일반 재정 조언이 아니라 제자도의 대가임을 지운 채 성공 공식으로 쓰지 않는다.',
      '특정 구매·투자·이직을 하나님이 승인하셨다고 단정하지 않는다.',
      '법률·의료·재정 같은 전문 판단이 필요한 결정을 말씀 한 구절로 대신하지 않는다.',
    ],
  },
  {
    id: 'SC-036',
    domains: ['waiting_unanswered_prayer'],
    referenceLabel: '시편 130:1–8',
    passage: { book: 'Psalms', chapter: 130, startVerse: 1, endVerse: 8 },
    situationTags: ['기다림이 길어짐', '말씀을 붙들고 기다림', '응답을 기다리며 지침', '오래 기도했지만 상황이 그대로임'],
    emotionTags: ['지침', '낙심', '답답함'],
    spiritualQuestionTags: ['기다림', '소망', '하나님의 침묵'],
    prayerModes: ['탄식', '신뢰'],
    pastoralFunction: ['소망', '인내'],
    contextSummary:
      '시편 기자는 깊은 곳에서 자비를 구하고, 파수꾼이 아침을 기다리는 것보다 더 간절히 주님과 그 말씀을 기다린다. 개인의 기다림은 공동체를 향한 소망으로 넓어진다.',
    theologicalInsight:
      '성경의 기다림은 결과 시점을 알아내는 기술이 아니라, 깊은 고통 속에서도 하나님께 부르짖고 그분의 인자와 구속을 바라보는 지속적인 신뢰다.',
    userExplanation:
      '기다림이 길어지면 기도할 말도 줄고 마음이 지칠 수 있습니다. 이 시편은 깊은 곳에서 부르짖는 사람을 책망하지 않고, 어둠 속에서 아침을 기다리듯 하나님께 계속 마음을 두는 모습을 보여줍니다.',
    prayerDirection:
      '얼마나 오래 기다렸는지와 지금 지친 마음을 숨기지 말고 말씀드리세요. 답의 날짜를 알아내려 하기보다 오늘 하루 소망을 놓지 않도록 구해보세요.',
    misuseGuards: [
      '응답이 늦는 이유를 사용자의 죄나 믿음 부족으로 단정하지 않는다.',
      '곧 원하는 응답이 온다고 약속하지 않는다.',
      '기다림을 필요한 치료·신고·상담·현실 행동을 미루는 이유로 사용하지 않는다.',
    ],
  },
  {
    id: 'SC-037',
    domains: ['waiting_unanswered_prayer'],
    referenceLabel: '누가복음 18:1–8',
    passage: { book: 'Luke', chapter: 18, startVerse: 1, endVerse: 8 },
    situationTags: ['같은 기도를 계속함', '기도를 포기하고 싶음', '오래 구한 일을 다시 아룀'],
    emotionTags: ['낙심', '지침', '서운함'],
    spiritualQuestionTags: ['기다림', '인내', '믿음'],
    prayerModes: ['간구', '신뢰'],
    pastoralFunction: ['인내', '소망'],
    contextSummary:
      '예수님은 불의한 재판관과 끈질긴 과부의 대비를 통해 제자들이 하나님 나라의 완성을 기다리는 동안 낙심하지 않고 기도하도록 가르치신다. 과부의 요청은 정의를 향한 능동적인 호소다.',
    theologicalInsight:
      '하나님은 마지못해 움직이는 불의한 재판관과 같지 않다. 끈질긴 기도는 하나님을 조종하는 수단이 아니라, 지연과 불의 속에서도 믿음으로 하나님께 계속 향하는 행위다.',
    userExplanation:
      '같은 기도를 오래 드리다 보면 이제 그만해야 하나 싶을 수 있습니다. 예수님은 낙심하지 않고 계속 아뢰는 믿음을 말씀하십니다. 이것은 같은 말을 많이 하면 원하는 결과를 얻는다는 공식이 아니라, 침묵처럼 느껴지는 시간에도 하나님께 등을 돌리지 않는 기도입니다.',
    prayerDirection:
      '포기하고 싶은 마음까지 하나님께 말씀드리고, 오늘 다시 한 번 필요한 것을 아뢰어보세요. 기다리는 동안 해야 할 정직하고 안전한 행동을 볼 수 있도록도 구해보세요.',
    misuseGuards: [
      '불의한 재판관을 하나님의 성품과 동일시하지 않는다.',
      '반복 횟수가 많으면 원하는 응답을 받아낸다고 말하지 않는다.',
      '정의나 안전을 위한 현실 행동을 수동적인 기다림으로 바꾸지 않는다.',
    ],
  },
  {
    id: 'SC-038',
    domains: ['gratitude_joy'],
    referenceLabel: '누가복음 17:11–19',
    passage: { book: 'Luke', chapter: 17, startVerse: 11, endVerse: 19 },
    situationTags: ['기도가 응답됨', '건강이 회복됨', '오래 기다린 좋은 결과를 받음'],
    emotionTags: ['감사', '감격', '기쁨'],
    spiritualQuestionTags: ['감사', '하나님의 선하심', '은혜'],
    prayerModes: ['감사', '찬양'],
    pastoralFunction: ['감사', '찬양'],
    contextSummary:
      '예수님께 자비를 구한 열 사람이 깨끗함을 받았지만, 그중 사마리아인 한 사람만 돌아와 하나님께 영광을 돌리고 예수님께 감사한다. 이야기의 초점은 은혜를 알아보고 응답하는 믿음에 있다.',
    theologicalInsight:
      '감사는 받은 좋은 결과를 자기 힘이나 당연한 몫으로 넘기지 않고, 자비를 베푸신 하나님께 돌아가 그 은혜를 인정하는 믿음의 응답이다.',
    userExplanation:
      '오래 바라던 일이 이루어졌을 때 그 기쁨을 하나님께 가져가는 것도 믿음입니다. 이 이야기는 도움을 받은 사람이 멈추어 돌아와 감사를 표현하는 모습을 보여줍니다.',
    prayerDirection:
      '무엇이 달라졌고 어떤 도움을 받았는지 구체적으로 말씀드리며 감사해보세요. 기쁨을 주신 하나님께 영광을 돌리고, 받은 은혜를 이웃과 나눌 방법도 구해보세요.',
    misuseGuards: [
      '이 사건을 모든 질병이 같은 방식으로 낫는다는 약속으로 바꾸지 않는다.',
      '회복을 사용자의 믿음 수준에 대한 보상으로 설명하지 않는다.',
      '고대의 질병·정결 표현을 현대 환자에 대한 낙인으로 사용하지 않는다.',
    ],
  },
  {
    id: 'SC-039',
    domains: ['gratitude_joy'],
    referenceLabel: '골로새서 3:15–17',
    passage: { book: 'Colossians', chapter: 3, startVerse: 15, endVerse: 17 },
    situationTags: ['평범한 하루에 감사함', '가족과 함께한 시간에 감사함', '감사를 생활로 표현함'],
    emotionTags: ['감사', '평안', '기쁨'],
    spiritualQuestionTags: ['감사', '공동체', '하나님의 선하심'],
    prayerModes: ['감사', '찬양'],
    pastoralFunction: ['감사', '교제'],
    contextSummary:
      '바울은 그리스도 안에서 새 사람으로 살아가는 공동체에게 평강과 말씀이 삶을 이끌게 하고, 말과 행동의 모든 영역에서 하나님께 감사하라고 권한다.',
    theologicalInsight:
      '감사는 특별한 사건에만 붙는 감정이 아니라, 그리스도의 평강과 말씀이 공동체의 말과 행동을 빚도록 허락하는 일상의 태도다.',
    userExplanation:
      '특별한 기적이 없어도 평범한 하루와 함께한 사람들을 돌아보며 감사할 수 있습니다. 바울은 감사가 마음속 느낌에만 머물지 않고 우리의 말과 행동에도 스며들도록 권합니다.',
    prayerDirection:
      '오늘 당연하게 지나친 사람과 일을 하나씩 떠올려 감사하고, 그 감사가 따뜻한 말과 작은 행동으로 이어지게 해달라고 구해보세요.',
    misuseGuards: [
      '감사하라는 말로 현재의 슬픔이나 부당함을 덮지 않는다.',
      '감사하지 못하는 순간을 죄책감으로 몰아가지 않는다.',
      '본문의 공동체적 맥락을 개인의 긍정 사고만으로 축소하지 않는다.',
    ],
  },
  {
    id: 'SC-040',
    domains: ['quiet_communion'],
    referenceLabel: '마가복음 6:30–32',
    passage: { book: 'Mark', chapter: 6, startVerse: 30, endVerse: 32 },
    situationTags: ['분주한 하루를 멈춤', '바빠서 쉴 틈이 없음', '하나님과 따로 쉬고 싶음'],
    emotionTags: ['지침', '평안', '쉼'],
    spiritualQuestionTags: ['쉼', '하나님과의 교제', '맡김'],
    prayerModes: ['교제', '간구'],
    pastoralFunction: ['쉼', '교제'],
    contextSummary:
      '사명을 마치고 돌아온 제자들이 먹을 겨를도 없을 만큼 분주하자 예수님은 그들의 보고를 들으시고 한적한 곳에서 잠깐 쉬자고 부르신다.',
    theologicalInsight:
      '예수님의 돌보심은 사람의 영적 열심만이 아니라 몸의 한계와 식사와 휴식 같은 실제 필요도 귀하게 본다.',
    userExplanation:
      '바쁜 하루를 멈추는 것은 게으름이 아닙니다. 예수님은 지쳐 돌아온 제자들의 이야기를 들으시고 잠깐 쉬도록 부르셨습니다. 짧은 쉼도 하나님과 함께 누릴 수 있습니다.',
    prayerDirection:
      '오늘 해낸 일과 남은 일을 예수님께 말씀드리고, 잠시 멈추어 몸과 마음을 돌볼 수 있도록 구해보세요. 쉬는 동안 성과가 아니라 하나님과 함께 있다는 사실에 머물러보세요.',
    misuseGuards: [
      '이 짧은 장면을 모든 책임에서 무기한 물러나라는 명령으로 만들지 않는다.',
      '쉼을 과로의 구조적 원인이나 치료가 필요한 소진을 외면하는 방법으로 쓰지 않는다.',
      '본문 뒤에 쉼이 방해받는 흐름도 있으므로 완벽한 고요가 보장된다고 말하지 않는다.',
    ],
  },
  {
    id: 'SC-041',
    domains: ['quiet_communion'],
    referenceLabel: '시편 62:1–8',
    passage: { book: 'Psalms', chapter: 62, startVerse: 1, endVerse: 8 },
    situationTags: ['복잡한 생각을 내려놓음', '말없이 하나님을 바라봄', '하나님 앞에 마음을 쏟음'],
    emotionTags: ['고요함', '평안', '쉼'],
    spiritualQuestionTags: ['하나님과의 교제', '신뢰', '맡김'],
    prayerModes: ['교제', '신뢰'],
    pastoralFunction: ['교제', '신뢰', '쉼'],
    contextSummary:
      '시편 기자는 공격과 거짓말이 있는 현실 속에서도 하나님만을 바라며 잠잠히 기다린다. 동시에 공동체에게 하나님 앞에 마음을 쏟으라고 권한다.',
    theologicalInsight:
      '하나님 앞의 고요는 감정을 없애는 침묵이 아니다. 하나님을 피난처로 신뢰하기 때문에 마음을 숨김없이 쏟고 그분을 바라보는 관계적 쉼이다.',
    userExplanation:
      '조용히 기도한다는 것은 아무 감정도 없어야 한다는 뜻이 아닙니다. 이 시편은 하나님 앞에서 잠잠히 기다리면서도 마음을 모두 쏟아놓으라고 말합니다. 말이 많아도 적어도 하나님께 머물 수 있습니다.',
    prayerDirection:
      '먼저 마음에 떠오르는 생각을 그대로 하나님께 쏟아놓고, 잠시 말하지 않아도 괜찮다는 마음으로 그분을 바라보세요.',
    misuseGuards: [
      '침묵을 감정 억압이나 문제 회피로 가르치지 않는다.',
      '위협이나 학대 상황에서 조용히 참고만 있으라고 적용하지 않는다.',
    ],
  },
  {
    id: 'SC-042',
    domains: ['repentance_guilt'],
    referenceLabel: '시편 51:1–12',
    passage: { book: 'Psalms', chapter: 51, startVerse: 1, endVerse: 12 },
    situationTags: ['구체적인 잘못을 인정함', '숨긴 일을 고백하고 싶음', '숨긴 일 때문에 하나님 앞에 나가기 힘듦', '새로운 마음을 구함'],
    emotionTags: ['죄책감', '부끄러움', '슬픔'],
    spiritualQuestionTags: ['회개', '은혜', '진실'],
    prayerModes: ['회개', '간구'],
    pastoralFunction: ['회개', '은혜'],
    contextSummary:
      '표제는 다윗이 밧세바와 우리아에게 저지른 심각한 죄를 나단에게 지적받은 뒤 드린 기도로 이 시편을 읽게 한다. 시인은 죄를 인정하고 자비와 정결, 새 마음과 회복을 구한다.',
    theologicalInsight:
      '회개는 막연한 자기혐오나 벌주기가 아니라 구체적인 죄를 진실하게 인정하고, 하나님의 자비 안에서 마음의 새로움과 실제 변화로 나아가는 것이다.',
    userExplanation:
      '잘못을 인정하는 일은 아프지만, 자신을 끝없이 미워하는 것과 회개는 다릅니다. 시편 기자는 잘못을 숨기지 않고 하나님의 자비를 구하며, 새 마음과 바른 삶을 요청합니다.',
    prayerDirection:
      '막연히 “제가 나쁩니다”라고만 하지 말고, 무엇을 잘못했는지 정직하게 말씀드리세요. 용서뿐 아니라 사과·회복·책임 있는 행동을 감당할 새 마음도 구해보세요.',
    misuseGuards: [
      '다윗의 죄가 실제 피해자에게 끼친 해를 지우지 않는다.',
      '“주께만 범죄했다”는 표현으로 피해자에 대한 사과·책임·회복을 면제하지 않는다.',
      '학대나 조종을 당한 사람에게 거짓 죄책감을 떠맡기지 않는다.',
    ],
  },
  {
    id: 'SC-043',
    domains: ['repentance_guilt'],
    referenceLabel: '누가복음 15:17–24',
    passage: { book: 'Luke', chapter: 15, startVerse: 17, endVerse: 24 },
    situationTags: ['신앙에서 멀어짐', '기도를 다시 시작하고 싶음', '하나님께 돌아가고 싶음'],
    emotionTags: ['죄책감', '그리움', '낙심'],
    spiritualQuestionTags: ['회개', '은혜', '하나님을 찾음'],
    prayerModes: ['회개', '신뢰'],
    pastoralFunction: ['회개', '은혜'],
    contextSummary:
      '잃은 자를 맞아들이시는 하나님의 기쁨을 보여주는 누가복음 15장의 세 비유 가운데, 집을 떠난 아들은 돌아가기로 하고 아버지는 아직 먼 곳에 있는 그를 먼저 보고 달려가 맞아들인다.',
    theologicalInsight:
      '하나님께 돌아가는 길은 자격을 완전히 회복한 뒤 시작되는 것이 아니다. 회개하며 돌아서는 사람을 먼저 불쌍히 여기고 맞아들이시는 은혜가 회복의 근거다.',
    userExplanation:
      '오랫동안 기도하지 못했거나 하나님에게서 멀어졌다고 느껴도 돌아가는 첫걸음을 시작할 수 있습니다. 예수님의 이야기는 모든 것을 정리한 사람만 환영받는 것이 아니라, 돌아오는 사람을 기쁘게 맞으시는 은혜를 보여줍니다.',
    prayerDirection:
      '멀어진 시간과 돌아가기 두려운 이유를 그대로 말씀드리고, 오늘 할 수 있는 작은 시작을 구해보세요. 숨겨 둔 잘못이 있다면 진실하게 인정할 용기도 구해보세요.',
    misuseGuards: [
      '하나님 아버지의 환대를 폭력적이거나 안전하지 않은 현실의 부모·가정으로 돌아가라는 명령과 동일시하지 않는다.',
      '환대를 책임 회피나 피해 회복 생략의 근거로 삼지 않는다.',
      '비유의 큰 문맥에 형의 이야기도 이어진다는 점을 지우고 값싼 용서로 축소하지 않는다.',
    ],
  },
  {
    id: 'SC-044',
    domains: ['comparison_identity'],
    referenceLabel: '시편 139:13–18',
    passage: { book: 'Psalms', chapter: 139, startVerse: 13, endVerse: 18 },
    situationTags: ['외모를 다른 사람과 비교함', '가족에게 비교당함', '존재 가치가 흔들림'],
    emotionTags: ['열등감', '부끄러움', '불안'],
    spiritualQuestionTags: ['정체성', '은혜', '감사'],
    prayerModes: ['감사', '신뢰'],
    pastoralFunction: ['확신', '관점 전환'],
    contextSummary:
      '시편 기자는 자신을 철저히 아시고 어디서도 떠나지 않으시는 하나님을 노래하며, 자신의 몸과 생명이 하나님의 창조와 돌보심 안에 있음을 경이롭게 바라본다.',
    theologicalInsight:
      '사람의 가치는 외모·성과·가족의 비교표에서 생기지 않는다. 하나님께 알려지고 지음 받은 존재라는 사실이 비교가 빼앗을 수 없는 존엄의 근거다.',
    userExplanation:
      '다른 사람의 외모나 평가를 기준으로 자신을 보면 내 모습이 부족하게만 느껴질 수 있습니다. 이 시편은 하나님이 나를 대충 보지 않으시고 깊이 아시며, 내 존재를 귀하게 지으셨다는 관점으로 돌아오게 합니다.',
    prayerDirection:
      '비교 때문에 싫어진 자신의 모습을 솔직히 말씀드리고, 다른 사람의 기준보다 하나님께 알려지고 지음 받은 존재라는 사실을 받아들이도록 구해보세요.',
    misuseGuards: [
      '외모·장애·질병에 대한 실제 고통을 단순한 긍정 문구로 덮지 않는다.',
      '현재의 몸 상태나 고통이 하나님의 특별한 의도라고 추측하지 않는다.',
      '이 본문을 타인의 몸을 평가하는 기준으로 사용하지 않는다.',
    ],
  },
  {
    id: 'SC-045',
    domains: ['comparison_identity'],
    referenceLabel: '고린도전서 12:14–27',
    passage: { book: '1Corinthians', chapter: 12, startVerse: 14, endVerse: 27 },
    situationTags: ['능력을 다른 사람과 비교함', '내 역할이 쓸모없게 느껴짐', '다른 사람의 성과에 위축됨'],
    emotionTags: ['열등감', '질투', '외로움'],
    spiritualQuestionTags: ['정체성', '공동체', '소명'],
    prayerModes: ['간구', '감사'],
    pastoralFunction: ['소명', '관점 전환'],
    contextSummary:
      '바울은 은사의 우열과 분열 문제가 있던 고린도 교회에 몸의 비유를 들어, 서로 다른 지체가 모두 필요하며 약하게 보이는 지체를 더욱 존중하고 함께 돌봐야 한다고 가르친다.',
    theologicalInsight:
      '그리스도의 몸에서 다름은 열등함의 증거가 아니다. 은사와 역할은 개인의 서열을 세우기 위해서가 아니라 공동체가 서로 돌보고 함께 살아가기 위해 주어진다.',
    userExplanation:
      '다른 사람의 능력이 커 보이면 내 몫은 필요 없다고 느낄 수 있습니다. 바울은 몸의 어느 부분도 다른 부분에게 쓸데없다고 말할 수 없다고 합니다. 서로 다른 역할은 비교의 서열이 아니라 함께 돌보기 위한 다양성입니다.',
    prayerDirection:
      '부러움과 위축된 마음을 숨기지 말고 말씀드리세요. 내게 맡겨진 역할을 과장하거나 낮추지 않고, 다른 사람의 기쁨과 아픔에도 함께할 수 있도록 구해보세요.',
    misuseGuards: [
      '본문을 교회 직분이나 역할을 강제로 고정하는 근거로 쓰지 않는다.',
      '해로운 공동체에 남거나 학대를 견디라고 요구하지 않는다.',
      '은사의 차이를 능력 경쟁이나 영적 서열로 바꾸지 않는다.',
    ],
  },
  {
    id: 'SC-046',
    domains: ['injustice_mistreatment'],
    referenceLabel: '시편 37:1–9',
    passage: { book: 'Psalms', chapter: 37, startVerse: 1, endVerse: 9 },
    situationTags: ['불의한 사람이 잘되는 것을 봄', '억울함 때문에 분노함', '분노를 내려놓기 어려움'],
    emotionTags: ['억울함', '분노', '상처'],
    spiritualQuestionTags: ['정의', '맡김', '악'],
    prayerModes: ['탄식', '신뢰'],
    pastoralFunction: ['정의', '신뢰'],
    contextSummary:
      '지혜 시편인 시편 37편은 악을 행하는 사람이 잘되는 현실 때문에 타오르는 분노와 시기를 다루며, 그 분노가 또 다른 악으로 이어지지 않도록 하나님을 신뢰하고 선을 행하라고 권한다.',
    theologicalInsight:
      '불의에 대한 분노 자체를 부정하는 대신, 하나님께 정의를 맡긴다는 것은 복수의 악순환에 자신을 내주지 않고 선을 선택하는 길이다.',
    userExplanation:
      '부당한 일을 겪거나 악한 사람이 잘되는 모습을 보면 분노하는 것이 자연스럽습니다. 이 시편은 그 분노를 없었던 일처럼 만들지 않으면서도, 분노 때문에 같은 악을 되풀이하지 않도록 하나님께 맡기고 선을 선택하게 합니다.',
    prayerDirection:
      '무엇이 부당했고 얼마나 화가 나는지 솔직히 말씀드리세요. 복수에 끌려가지 않으면서도 필요한 도움과 정당한 절차를 찾을 지혜를 구해보세요.',
    misuseGuards: [
      '피해자에게 화를 느끼지 말라고 정죄하지 않는다.',
      '하나님께 맡김을 신고·법적 절차·거리 두기·지원 요청을 포기하라는 뜻으로 쓰지 않는다.',
      '언제 어떤 방식으로 공개적으로 인정받을지 약속하지 않는다.',
    ],
  },
  {
    id: 'SC-047',
    domains: ['injustice_mistreatment'],
    referenceLabel: '이사야 1:16–17',
    passage: { book: 'Isaiah', chapter: 1, startVerse: 16, endVerse: 17 },
    situationTags: ['약한 사람이 부당한 일을 당함', '불공정한 현실을 목격함', '정의를 위해 행동하고 싶음'],
    emotionTags: ['억울함', '분노', '무기력'],
    spiritualQuestionTags: ['정의', '긍휼', '책임'],
    prayerModes: ['간구', '결단'],
    pastoralFunction: ['정의', '지혜'],
    contextSummary:
      '이사야 1장은 예배를 드리면서도 불의를 행한 유다 공동체를 꾸짖는다. 하나님이 원하시는 돌이킴은 악을 그치고 선을 배우며, 억압받는 이와 고아와 과부를 위해 정의를 구하는 실제 행동을 포함한다.',
    theologicalInsight:
      '하나님을 향한 예배와 이웃을 향한 정의는 분리되지 않는다. 불의를 본 신앙 공동체는 말로만 안타까워하지 않고 약한 이의 편에 서는 책임 있는 행동을 배워야 한다.',
    userExplanation:
      '불공정한 일을 보고도 아무것도 할 수 없다고 느낄 때가 있습니다. 이사야는 하나님을 섬기는 삶이 불의를 외면하지 않고, 피해 입은 사람을 돕고 정의를 구하는 행동과 이어져야 한다고 말합니다.',
    prayerDirection:
      '분노만 커지거나 무력감에 머물지 않도록 기도하고, 지금 안전하게 할 수 있는 작은 행동과 함께할 사람을 보여 달라고 구해보세요.',
    misuseGuards: [
      '피해자에게 자기 피해를 직접 해결할 책임까지 떠넘기지 않는다.',
      '위험한 가해자와 혼자 대면하거나 무리한 행동을 하라고 권하지 않는다.',
      '법률·노동·학교·안전 문제에는 적절한 전문기관과 지원체계를 이용할 수 있음을 막지 않는다.',
    ],
  },
  {
    id: 'SC-048',
    domains: ['grief_loss'],
    referenceLabel: '전도서 3:4',
    passage: { book: 'Ecclesiastes', chapter: 3, startVerse: 4, endVerse: 4 },
    situationTags: ['애도할 시간이 필요함', '기일이나 계절에 슬픔이 돌아옴', '상실을 서둘러 정리하기 어려움'],
    emotionTags: ['슬픔', '그리움', '허탈함'],
    spiritualQuestionTags: ['슬픔', '탄식', '위로'],
    prayerModes: ['탄식', '교제'],
    pastoralFunction: ['애도', '탄식'],
    contextSummary:
      '전도자는 인간이 통제할 수 없는 여러 때를 시로 나열하며, 삶에는 울고 슬퍼하는 때도 웃고 춤추는 때와 함께 실제로 존재한다고 말한다.',
    theologicalInsight:
      '성경은 모든 순간을 빠르게 기쁨으로 바꾸라고 요구하지 않는다. 상실 뒤에 울고 애도하는 시간도 인간의 유한한 삶 안에 있는 정당한 때다.',
    userExplanation:
      '상실 뒤 슬픔이 오래가거나 기일마다 다시 찾아와도 잘못된 것은 아닙니다. 전도서는 삶에 울 때와 슬퍼할 때가 있음을 인정합니다. 지금은 서둘러 괜찮아지기보다 애도할 시간을 가져도 됩니다.',
    prayerDirection:
      '잃은 존재와 함께했던 기억, 오늘 다시 찾아온 슬픔을 하나님께 말씀드리세요. 회복을 재촉하기보다 오늘의 애도를 견딜 힘과 곁에 있어 줄 사람을 구해보세요.',
    misuseGuards: [
      '각 사람의 애도에 정해진 기간이나 순서를 강요하지 않는다.',
      '“때가 있다”는 말로 죽음이나 상실의 이유를 하나님이 정하셨다고 단정하지 않는다.',
      '슬픔이 일상 기능을 심하게 무너뜨리거나 위험 신호가 있을 때 도움을 구하는 것을 막지 않는다.',
    ],
  },
  {
    id: 'SC-049',
    domains: ['grief_loss'],
    referenceLabel: '요한계시록 21:1–5',
    passage: { book: 'Revelation', chapter: 21, startVerse: 1, endVerse: 5 },
    situationTags: [
      '사별 후 소망이 필요함',
      '죽음과 이별 앞에서 슬픔',
      '깊은 상실 뒤 미래가 보이지 않음',
      '아이를 잃은 슬픔',
      '상실을 서둘러 정리하기 어려움',
    ],
    emotionTags: ['슬픔', '그리움', '낙심'],
    spiritualQuestionTags: ['소망', '위로', '하나님의 함께하심'],
    prayerModes: ['탄식', '신뢰', '간구'],
    pastoralFunction: ['소망', '위로', '애도'],
    contextSummary:
      '요한계시록의 마지막 환상은 폭력과 고난을 견디는 공동체에게 하나님이 사람들과 함께 거하시고, 죽음과 애통과 고통이 사라지는 새 창조를 보여준다.',
    theologicalInsight:
      '기독교의 소망은 현재의 눈물을 부정하는 낙관이 아니라, 죽음과 고통이 하나님의 마지막 말이 아니며 하나님이 창조를 새롭게 하신다는 약속에 뿌리를 둔다.',
    userExplanation:
      '큰 상실 앞에서는 앞으로도 계속 이렇게 아플 것처럼 느껴질 수 있습니다. 이 말씀은 지금의 눈물을 서둘러 멈추라고 하지 않습니다. 하나님이 마침내 죽음과 애통을 끝내고 함께 거하실 새 창조를 소망하게 합니다.',
    prayerDirection:
      '지금의 눈물과 그리움을 그대로 말씀드리고, 오늘 슬픔을 견딜 힘과 죽음이 마지막이 아니라는 소망을 붙들게 해달라고 구해보세요.',
    misuseGuards: [
      '미래 소망으로 현재의 애도와 기억을 서둘러 끝내게 하지 않는다.',
      '특정 고인의 구원 상태나 사후 운명을 앱이 단정하지 않는다.',
      '현재의 고통이 즉시 사라진다고 약속하지 않는다.',
    ],
  },
  {
    id: 'SC-050',
    domains: ['wisdom_discernment'],
    referenceLabel: '잠언 18:13, 17',
    passage: { book: 'Proverbs', chapter: 18, startVerse: 13, endVerse: 13 },
    passages: [
      { book: 'Proverbs', chapter: 18, startVerse: 13, endVerse: 13 },
      { book: 'Proverbs', chapter: 18, startVerse: 17, endVerse: 17 },
    ],
    situationTags: [
      '한쪽 말만 듣고 판단하기 어려움',
      '사실을 더 확인해야 함',
      '엇갈린 설명을 듣고 혼란스러움',
      '여러 사람의 조언을 구함',
    ],
    emotionTags: ['혼란', '불확실함', '걱정'],
    spiritualQuestionTags: ['분별', '지혜', '진실'],
    prayerModes: ['간구', '결단'],
    pastoralFunction: ['지혜', '관점 전환'],
    contextSummary:
      '잠언 18장은 말을 듣기 전에 대답하는 성급함을 경계하고, 처음 들은 주장도 다른 설명과 질문을 거치기 전에는 충분히 밝혀진 것이 아닐 수 있음을 가르친다.',
    theologicalInsight:
      '지혜로운 분별은 첫인상이나 한쪽 주장에 즉시 확신하는 것이 아니라, 충분히 듣고 사실을 확인하며 자신의 판단이 틀릴 가능성도 인정하는 겸손을 포함한다.',
    userExplanation:
      '서로 다른 말을 들으면 먼저 들은 쪽이 더 맞는 것처럼 느껴질 수 있습니다. 잠언은 충분히 듣기 전에 결론 내리지 말고, 다른 설명과 사실도 살피라고 가르칩니다.',
    prayerDirection:
      '내가 이미 정해 둔 결론이나 편견이 무엇인지 보게 해달라고 구하고, 필요한 질문을 차분히 하며 사실을 정직하게 확인할 지혜를 구해보세요.',
    misuseGuards: [
      '상대의 마음이나 숨은 의도를 읽을 수 있다고 말하지 않는다.',
      '모든 증언을 똑같이 의심하거나 피해자의 말을 자동으로 불신하게 하지 않는다.',
      '법률·의료·재정 등 중요한 판단은 적절한 증거와 전문가 확인을 대신하지 않는다.',
    ],
  },
  {
    id: 'SC-051',
    domains: ['wisdom_discernment'],
    referenceLabel: '빌립보서 1:9–11',
    passage: { book: 'Philippians', chapter: 1, startVerse: 9, endVerse: 11 },
    situationTags: ['사랑과 진실을 함께 고려함', '믿을 만한 가르침인지 살핌'],
    emotionTags: ['혼란', '막막함', '불확실함'],
    spiritualQuestionTags: ['분별', '사랑', '지혜'],
    prayerModes: ['간구', '결단'],
    pastoralFunction: ['지혜', '인도'],
    contextSummary:
      '바울은 빌립보 교회의 사랑이 지식과 모든 분별 안에서 자라, 무엇이 더 나은지 시험하고 그리스도 안의 열매로 이어지기를 기도한다.',
    theologicalInsight:
      '성경적 분별은 차가운 정보나 강한 느낌 하나에 기대지 않는다. 사랑이 지식과 통찰 안에서 자라며, 실제로 선한 열매를 맺는지를 함께 살피는 과정이다.',
    userExplanation:
      '여러 말과 가르침 중 무엇이 믿을 만한지 혼란스러울 때, 느낌만 강한 쪽을 따르는 것이 분별은 아닙니다. 바울은 사랑과 지식, 통찰이 함께 자라 더 나은 것을 살피도록 기도합니다.',
    prayerDirection:
      '좋아 보이는 말에 급히 끌리지 않고 사실과 열매를 살피게 해달라고 구하세요. 사랑을 잃지 않으면서도 진실을 분별할 지혜를 구해보세요.',
    misuseGuards: [
      '기도 중 든 느낌을 하나님의 직접 계시라고 단정하지 않는다.',
      '특정 교사·교회·해석이 옳다고 앱이 판정하지 않는다.',
      '분별을 끝없는 의심이나 결정 회피의 이유로 사용하지 않는다.',
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
