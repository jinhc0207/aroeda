/**
 * 안전 화면의 도움 연락처 · 계약 테스트
 *
 * 실행: npm test
 *
 * 왜 원본을 읽어서 검사하는가:
 *   이 저장소에는 아직 화면을 실제로 그려 보는 시험 도구가 없다.
 *   새 꾸러미를 설치하지 않기로 했으므로 화면 원본이 약속을 지키는지 글자로 확인한다.
 *   눌러 보는 시험이 아니다. 그 한계를 그대로 적어 둔다.
 *
 * 지키려는 것:
 *   위급할 때 걸 수 있는 번호가 화면에 그대로 보인다.
 *   누르기 전에는 전화가 걸리지 않는다.
 *   연결이 안 되어도 앱이 멈추지 않는다.
 *   이 화면은 서버를 부르지 않는다.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  SAFETY_CONTACTS,
  SAFETY_CONTACTS_REGION,
} from '../constants/safety-contacts.ts';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '');

const SCREEN = stripComments(read('../app/safety.tsx'));
const CONTACTS_SOURCE = read('../constants/safety-contacts.ts');

/* ================================================================== */
/* A. 번호                                                             */
/* ================================================================== */

describe('안전 연락처 · A. 번호', () => {
  it('네 곳이 정해진 차례로 있다', () => {
    assert.deepEqual(
      SAFETY_CONTACTS.map((c) => c.display),
      ['112', '119', '109', '1577-0199'],
    );
  });

  it('걸 번호와 보여줄 번호가 맞는다', () => {
    assert.deepEqual(
      SAFETY_CONTACTS.map((c) => c.dial),
      ['112', '119', '109', '15770199'],
    );
    // 하이픈은 보여줄 때만 쓰고, 걸 때는 뺀다.
    for (const contact of SAFETY_CONTACTS) {
      assert.equal(contact.dial, contact.display.replace(/-/g, ''), contact.label);
    }
  });

  it('각 번호의 이름이 무엇을 하는 곳인지 알려준다', () => {
    // 안전 화면이므로 이름이 조용히 바뀌면 안 된다. 정확히 고정한다.
    assert.deepEqual(
      SAFETY_CONTACTS.map((c) => c.label),
      ['경찰', '구급·응급', '자살예방 상담', '정신건강 위기상담'],
    );
    for (const contact of SAFETY_CONTACTS) {
      assert.ok(contact.purpose.trim().length > 0, contact.display);
    }
  });

  it('네 곳이 서로 다른 곳이다', () => {
    assert.equal(new Set(SAFETY_CONTACTS.map((c) => c.dial)).size, 4);
    assert.equal(new Set(SAFETY_CONTACTS.map((c) => c.label)).size, 4);
  });

  it('자살예방 상담에 24시간이 적혀 있다', () => {
    const line = SAFETY_CONTACTS.find((c) => c.display === '109');
    assert.ok(line);
    assert.equal(line!.note, '24시간');
  });

  it('어느 나라 번호인지 알린다', () => {
    assert.equal(SAFETY_CONTACTS_REGION, '대한민국 기준');
    assert.ok(SCREEN.includes('SAFETY_CONTACTS_REGION'));
  });

  it('확인한 날짜와 출처를 코드에 남겼다', () => {
    assert.ok(CONTACTS_SOURCE.includes('2026-09-04'));
    for (const source of ['자살예방', '정신건강 위기상담', '경찰', '소방청']) {
      assert.ok(CONTACTS_SOURCE.includes(source), source);
    }
  });
});

/* ================================================================== */
/* B. 화면에 그대로 보인다                                              */
/* ================================================================== */

describe('안전 연락처 · B. 화면에 그대로 보인다', () => {
  it('번호를 감추지 않고 글자로 보여준다', () => {
    assert.ok(SCREEN.includes('{contact.display}'));
    assert.ok(SCREEN.includes('{contact.label}'));
    assert.ok(SCREEN.includes('{contact.purpose}'));
  });

  it('네 곳을 모두 그린다', () => {
    assert.ok(SCREEN.includes('SAFETY_CONTACTS.map'));
    // 목록에서 일부만 골라 보여주지 않는다.
    assert.equal(SCREEN.includes('SAFETY_CONTACTS.slice'), false);
    assert.equal(SCREEN.includes('SAFETY_CONTACTS.filter'), false);
  });

  it('누르기 쉬운 크기다', () => {
    assert.ok(/minHeight: 7\d/.test(SCREEN) || /minHeight: [8-9]\d/.test(SCREEN));
    assert.ok(SCREEN.includes('accessibilityRole="button"'));
    assert.ok(SCREEN.includes('에 전화하기'));
  });

  it('안전이 먼저라는 말이 남아 있다', () => {
    assert.ok(SCREEN.includes('지금은 당신의 안전이 먼저예요'));
    assert.ok(SCREEN.includes('말씀이나 기도보다 먼저 현실의 도움을 요청해 주세요'));
  });

  it('믿을 수 있는 사람 이야기는 강요하지 않는다', () => {
    assert.ok(SCREEN.includes('가능하다면 지금 상황을 믿을 수 있는 사람에게 알려주세요'));
    // 특정 사람에게 연락하라고 단정하지 않는다.
    for (const banned of ['가족에게 연락하세요', '부모님께', '배우자에게']) {
      assert.equal(SCREEN.includes(banned), false, banned);
    }
  });

  it('기도로 해결된다고 말하지 않는다', () => {
    for (const banned of ['기도하면', '믿음이 부족', '신앙이 약', '기도로 해결']) {
      assert.equal(SCREEN.includes(banned), false, banned);
    }
    // 이 화면에서 기도를 새로 권하지 않는다.
    assert.equal(SCREEN.includes('기도하기'), false);
    assert.equal(SCREEN.includes('/prayer'), false);
  });
});

/* ================================================================== */
/* C. 전화는 누른 뒤에만                                                */
/* ================================================================== */

describe('안전 연락처 · C. 전화는 누른 뒤에만', () => {
  it('tel: 주소로 전화 앱을 연다', () => {
    assert.ok(SCREEN.includes('Linking.openURL(`tel:${dial}`)'));
    for (const contact of SAFETY_CONTACTS) {
      // 걸 번호가 실제로 그 주소에 들어간다.
      assert.ok(contact.dial.length >= 3, contact.display);
    }
  });

  it('화면에 들어왔다고 저절로 걸지 않는다', () => {
    // 자동으로 도는 자리가 없다.
    assert.equal(SCREEN.includes('useEffect'), false);
    assert.equal(SCREEN.includes('setTimeout'), false);
    // 전화 여는 자리는 누를 때뿐이다.
    assert.equal((SCREEN.match(/Linking\.openURL/g) || []).length, 1);
    assert.ok(SCREEN.includes('onPress={() => callNumber(contact.dial)}'));
  });

  it('연결이 안 되어도 앱이 멈추지 않는다', () => {
    assert.ok(SCREEN.includes('.catch(()'));
    // 오류를 화면이나 기록에 남기지 않는다.
    assert.equal(SCREEN.includes('console.'), false);
    assert.equal(SCREEN.includes('Alert.'), false);
  });

  it('번호는 실패해도 화면에 남는다', () => {
    // 번호를 상태로 감추지 않는다. 언제나 그려진다.
    assert.equal(SCREEN.includes('useState'), false);
    assert.ok(SCREEN.includes('{contact.display}'));
  });
});

/* ================================================================== */
/* D. 이 화면은 서버를 부르지 않는다                                    */
/* ================================================================== */

describe('안전 연락처 · D. 서버를 부르지 않는다', () => {
  it('추천도 기도 도움도 부르지 않는다', () => {
    for (const banned of [
      'functions.invoke',
      'recommend-scripture',
      'generate-prayer-guidance',
      'requestPrayerGuidance',
      'requestRecommendation',
      'supabase',
      'fetch(',
    ]) {
      assert.equal(SCREEN.includes(banned), false, banned);
    }
  });

  it('저장하거나 기록하지 않는다', () => {
    for (const banned of ['AsyncStorage', 'SecureStore', 'analytics', 'track(', 'console.']) {
      assert.equal(SCREEN.includes(banned), false, banned);
    }
    // 어느 번호를 눌렀는지 남기지 않는다.
    assert.equal(SCREEN.includes('logCall'), false);
    assert.equal(SCREEN.includes('recordContact'), false);
  });

  it('사용자 상황을 다루지 않는다', () => {
    assert.equal(SCREEN.includes('useSituation'), false);
    assert.equal(SCREEN.includes('situation'), false);
  });
});

/* ================================================================== */
/* E. 기존 흐름이 그대로다                                              */
/* ================================================================== */

describe('안전 연락처 · E. 기존 흐름은 그대로', () => {
  it('처음으로 돌아가는 길이 남아 있다', () => {
    assert.ok(SCREEN.includes('처음으로 돌아가기'));
    assert.ok(SCREEN.includes("router.replace('/')"));
  });

  it('안전 판단 규칙을 화면이 새로 만들지 않는다', () => {
    for (const banned of ['self_harm', 'SAFETY_LEVELS', 'safety.level', 'categories']) {
      assert.equal(SCREEN.includes(banned), false, banned);
    }
  });

  it('안전 경로 자체가 그대로다', () => {
    const index = stripComments(read('../app/index.tsx'));
    assert.ok(index.includes("outcome.status === 'route'"));
    assert.ok(index.includes('`/${outcome.route}`'));
  });

  it('서버 계약을 새로 만들지 않았다', () => {
    // 안전의 종류를 화면까지 보내도록 계약을 바꾸지 않았다.
    const helper = stripComments(read('./request-recommendation.ts'));
    assert.ok(helper.includes('const { route, selectedCardId } = result'));
    assert.equal(helper.includes('safetyLevel'), false);
    assert.equal(helper.includes('safetyCategories'), false);
  });
});
