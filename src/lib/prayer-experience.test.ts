/**
 * 기도 경험 · 화면 계약 테스트
 *
 * 실행: npm test
 *
 * 왜 원본을 읽어서 검사하는가:
 *   이 저장소에는 아직 화면을 실제로 그려 보는 시험 도구가 없다.
 *   (@testing-library/react-native, jest 같은 것이 없다.)
 *   새 꾸러미를 설치하지 않기로 했으므로, 화면 원본이 약속을 지키는지
 *   글자로 확인한다. 눌러 보는 시험이 아니다. 그 한계를 그대로 적어 둔다.
 *
 * 지키려는 것:
 *   말씀 화면에서 기도로 가는 길이 실제로 있다.
 *   기도한 내용이 밖으로 나가지 않는다.
 *   붙들 말씀이 없으면 아무 말씀이나 대신 보여주지 않는다.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { SCRIPTURE_CARDS } from '../../supabase/functions/_shared/scripture-cards.ts';
import { GATE_ROUTES } from './request-recommendation.ts';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '');

const SCRIPTURE = stripComments(read('../app/scripture.tsx'));
const PRAYER = stripComments(read('../app/prayer.tsx'));

/* ================================================================== */
/* A. 말씀 화면에서 기도로 가는 길                                      */
/* ================================================================== */

describe('기도 경험 · A. 말씀 화면에서 기도로', () => {
  it('기도로 가는 길이 하나 있다', () => {
    assert.ok(PRAYER.length > 0);
    assert.ok(SCRIPTURE.includes("router.push('/prayer')"));
    assert.ok(SCRIPTURE.includes('이 말씀으로 기도해보기'));
  });

  it('기도 방식을 먼저 고르게 하지 않는다(옛 두 갈래 CTA가 없다)', () => {
    assert.equal(SCRIPTURE.includes("mode: 'direct'"), false);
    assert.equal(SCRIPTURE.includes("mode: 'guided'"), false);
    assert.equal(SCRIPTURE.includes('직접 기도하기'), false);
    assert.equal(SCRIPTURE.includes('기도를 시작하는 도움 받기'), false);
  });

  it('기도 CTA는 실제로 화면을 옮긴다', () => {
    // 누르면 아무 일도 하지 않는 버튼이 아니다.
    assert.equal((SCRIPTURE.match(/router\.push\('\/prayer'\)/g) || []).length, 1);
  });

  it('아무 일도 하지 않던 옛 버튼이 사라졌다', () => {
    assert.equal(SCRIPTURE.includes('기도문은 다음 단계에서 연결됩니다'), false);
    assert.equal(SCRIPTURE.includes('기도문을 함께 읽을게요'), false);
    // 그 버튼만 쓰던 상태와 칸도 함께 치웠다.
    assert.equal(SCRIPTURE.includes('setNotice'), false);
    assert.equal(SCRIPTURE.includes('noticeText'), false);
  });
});

/* ================================================================== */
/* B. 하나의 기도 흐름                                                  */
/* ================================================================== */

describe('기도 경험 · B. 하나의 기도 흐름', () => {
  it('들어오는 방식을 나누지 않는다(옛 direct/guided 분기가 없다)', () => {
    assert.equal(PRAYER.includes('PRAYER_MODES'), false);
    assert.equal(PRAYER.includes('isPrayerMode'), false);
    assert.equal(PRAYER.includes('useLocalSearchParams'), false);
    assert.equal(PRAYER.includes("params.mode"), false);
  });

  it('아뢰다가 준비한 짧은 기도문을 읽기 전용으로 보여준다', () => {
    assert.ok(PRAYER.includes('guidanceState.guidance.prayerText'));
    // 옛 3단계(GUIDE_STEPS) 구조는 더 이상 없다.
    assert.equal(PRAYER.includes('GUIDE_STEPS'), false);
  });

  it('생성된 기도문을 카드나 화면이 새로 지어내지 않는다', () => {
    // 카드에 기도문 칸을 새로 만들지 않았다. 서버가 매번 생성한다.
    for (const card of SCRIPTURE_CARDS) {
      assert.equal('prayerText' in card, false, card.id);
    }
  });

  it('본문 전체를 다시 길게 반복하지 않는다', () => {
    assert.equal(PRAYER.includes('getPassage'), false);
    assert.ok(PRAYER.includes('card.referenceLabel'));
  });

  it('기도문을 받지 못하면 기도 방향을 솔직하게 대신 보여준다', () => {
    assert.ok(PRAYER.includes('지금은 기도문을 준비하지 못했어요'));
    assert.ok(PRAYER.includes('기도 방향'));
    assert.ok(PRAYER.includes('card.prayerDirection'));
    // 카드마다 그 값이 실제로 채워져 있어야 화면이 빈 채로 나오지 않는다.
    for (const card of SCRIPTURE_CARDS) {
      assert.ok(
        typeof card.prayerDirection === 'string' && card.prayerDirection.trim().length > 0,
        card.id,
      );
    }
  });
});

/* ================================================================== */
/* C. 자기 말로 적는 자리는 선택이다                                     */
/* ================================================================== */

describe('기도 경험 · C. 적는 자리는 선택이다', () => {
  it('입력창은 기본으로 열려 있지 않고, 고른 경우에만 펼쳐진다', () => {
    assert.ok(PRAYER.includes("const [showPersonalPrayer, setShowPersonalPrayer] = useState(false)"));
    assert.ok(PRAYER.includes('setShowPersonalPrayer(true)'));
    assert.ok(PRAYER.includes('내 말로 적어보기'));
    // 입력창은 showPersonalPrayer가 참일 때만 그려진다.
    assert.ok(/showPersonalPrayer \?\s*\(\s*<View[\s\S]*?<TextInput/.test(PRAYER));
  });

  it('입력 칸은 한 곳뿐이고, 기도문 다음에 온다', () => {
    assert.equal((PRAYER.match(/<TextInput/g) || []).length, 1);
    const guided = PRAYER.indexOf('guidanceState.guidance.prayerText');
    assert.notEqual(guided, -1);
    assert.ok(PRAYER.indexOf('<TextInput') > guided);
  });

  it('입력창을 열면 저장하지 않는다는 안내가 함께 보인다', () => {
    assert.ok(PRAYER.includes('multiline'));
    assert.ok(PRAYER.includes('지금 하나님께 아뢰고 싶은 말을 적어보세요'));
    assert.ok(PRAYER.includes('accessibilityLabel="기도 적는 곳"'));
    assert.ok(PRAYER.includes('어디에도 저장되지 않고'));
  });

  it('적지 않아도 기도를 마칠 수 있다', () => {
    assert.equal(/disabled=\{[^}]*prayer/.test(PRAYER), false);
    assert.equal(PRAYER.includes('prayer.trim().length === 0'), false);
    assert.ok(PRAYER.includes('소리 내어 기도하셨다면'));
  });
});

/* ================================================================== */
/* D. 기도한 내용은 밖으로 나가지 않는다                                 */
/* ================================================================== */

describe('기도 경험 · D. 기도는 이 화면에만 있다', () => {
  it('저장하거나 기록하지 않는다', () => {
    for (const banned of [
      'fetch(',
      'AsyncStorage',
      'SecureStore',
      'localStorage',
      'console.',
      'analytics',
      'track(',
    ]) {
      assert.equal(PRAYER.includes(banned), false, banned);
    }
  });

  it('서버를 부르더라도 기도는 실리지 않는다', () => {
    // v1-B에서 기도 도움을 받아 오려고 서버를 부른다.
    // 그때 보내는 값에 사용자가 적는 기도가 없어야 한다.
    const bodies = PRAYER.match(/invokePrayerGuidance\(body:[^)]*\)/g) || [];
    for (const body of bodies) assert.equal(body.includes('prayer'), false, body);

    const call = PRAYER.split('requestPrayerGuidance(')[1]?.split(');')[0] ?? '';
    assert.notEqual(call, '');
    assert.equal(call.includes('prayer'), false, call);
    assert.ok(call.includes('situation'));
    assert.ok(call.includes('cardId'));

    // 서버로 나가는 자리는 기도 도움 하나뿐이다.
    assert.equal((PRAYER.match(/functions\.invoke\(/g) || []).length, 1);
    assert.ok(PRAYER.includes("functions.invoke('generate-prayer-guidance'"));
  });

  it('적은 기도는 이 화면의 상태로만 있다', () => {
    assert.ok(PRAYER.includes("const [prayer, setPrayer] = useState('')"));
    // 화면 밖으로 올려 보내는 자리가 없다.
    assert.equal(PRAYER.includes('setSituation(prayer'), false);
    assert.equal(PRAYER.includes('prayer)'), false);
  });

  it('주소나 화면 이동에 기도가 실리지 않는다', () => {
    const pushes = PRAYER.match(/router\.(push|replace)\([^)]*\)/g) || [];
    for (const call of pushes) {
      assert.equal(call.includes('prayer,'), false, call);
      assert.equal(call.includes('${prayer'), false, call);
    }
  });

  it('사용자에게도 저장하지 않는다고 알린다', () => {
    assert.ok(PRAYER.includes('어디에도 저장되지 않고'));
  });
});

/* ================================================================== */
/* E. 기도를 마치는 자리                                               */
/* ================================================================== */

describe('기도 경험 · E. 기도를 마치기', () => {
  it('마치는 버튼이 있다', () => {
    assert.ok(PRAYER.includes('기도 마치기'));
    assert.ok(PRAYER.includes('setIsDone(true)'));
  });

  it('적지 않아도 마칠 수 있다', () => {
    // 소리 내어 기도했을 수 있다. 빈 칸을 막지 않는다.
    assert.equal(/disabled=\{[^}]*prayer/.test(PRAYER), false);
    assert.equal(PRAYER.includes('prayer.trim().length === 0'), false);
    assert.ok(PRAYER.includes('소리 내어 기도하셨다면'));
  });

  it('마친 뒤 보여줄 말이 있다', () => {
    assert.ok(PRAYER.includes('오늘의 기도를 마쳤어요'));
    assert.ok(PRAYER.includes('붙든 말씀을 오늘 하루 천천히 기억해 보세요'));
  });

  it('처음으로 돌아가는 길이 있다', () => {
    assert.ok(PRAYER.includes('처음으로 돌아가기'));
    assert.ok(PRAYER.includes("router.replace('/')"));
    // 새 이야기를 위해 앞의 것(상황·카드·영역·영역 선택지)을 비운다.
    assert.ok(PRAYER.includes("setSituation('')"));
    assert.ok(PRAYER.includes('clearRecommendation()'));
  });

  it('말씀을 다시 볼 수도 있다', () => {
    assert.ok(PRAYER.includes('말씀 다시 보기'));
    assert.ok(PRAYER.includes("router.replace('/scripture')"));
  });
});

/* ================================================================== */
/* F. 붙들 말씀이 없을 때                                              */
/* ================================================================== */

describe('기도 경험 · F. 붙들 말씀이 없을 때', () => {
  it('아무 말씀이나 대신 보여주지 않는다', () => {
    assert.equal(PRAYER.includes('SC-001'), false);
    assert.equal(/SCRIPTURE_CARDS\[0\]/.test(PRAYER), false);
    assert.equal(PRAYER.includes('?? SCRIPTURE_CARDS'), false);
    // 말씀 화면도 그대로다.
    assert.equal(SCRIPTURE.includes('SC-001'), false);
  });

  it('없으면 없다고 하고 안전한 길을 준다', () => {
    assert.ok(PRAYER.includes('if (!card)'));
    assert.ok(PRAYER.includes('먼저 함께 붙들 말씀을 찾아볼게요'));
    assert.ok(PRAYER.includes('상황 이야기하기'));
  });

  it('카드를 못 찾아도 터지지 않는다', () => {
    assert.ok(PRAYER.includes('try {'));
    assert.ok(PRAYER.includes('return getScriptureCard(selectedCardId)'));
    assert.ok(PRAYER.includes('} catch {'));
  });
});

/* ================================================================== */
/* G. 앞의 흐름을 건드리지 않았다                                       */
/* ================================================================== */

describe('기도 경험 · G. 앞의 흐름은 그대로', () => {
  it('말씀 화면의 앞부분이 그대로다', () => {
    for (const kept of [
      '오늘 함께 붙들 말씀',
      'card.referenceLabel',
      'TRANSLATION_NAME',
      '이 말씀이 보여주는 것',
      'card.userExplanation',
      '이제 이렇게 바라볼 수 있어요',
      'card.prayerDirection',
      '추천된 말씀이 없습니다',
    ]) {
      assert.ok(SCRIPTURE.includes(kept), kept);
    }
  });

  it('추천 흐름과 안전 경로를 건드리지 않았다', () => {
    const index = stripComments(read('../app/index.tsx'));
    assert.ok(index.includes("supabase.functions.invoke('recommend-scripture'"));
    assert.ok(index.includes("router.push('/scripture')"));

    // 안전·미다룸·모호는 gate가 준 이름으로 그대로 옮겨 간다.
    // 첫 화면은 그 이름을 직접 적지 않고 받은 값을 쓴다.
    assert.ok(index.includes("outcome.status === 'route'"));
    assert.ok(index.includes("outcome.route === 'no_coverage' ? '/no-coverage'"));
    assert.ok(index.includes('`/${outcome.route}`'));

    // 그 이름의 주인은 여전히 요청 계약 쪽이다.
    assert.deepEqual([...GATE_ROUTES], ['recommend', 'no_coverage', 'safety', 'ambiguous', 'domain_choice']);
  });

  it('기도 화면은 상태를 새로 만들지 않고 기존 것을 쓴다', () => {
    assert.ok(PRAYER.includes("from '@/state/situation'"));
    assert.equal(PRAYER.includes('createContext'), false);
    assert.equal(PRAYER.includes('zustand'), false);
  });

  it('키보드와 안전 영역을 앞 화면과 같은 방식으로 다룬다', () => {
    assert.ok(PRAYER.includes('KeyboardAvoidingView'));
    assert.ok(PRAYER.includes('SafeAreaView'));
    assert.ok(PRAYER.includes("edges={['top', 'bottom']}"));
  });
});
