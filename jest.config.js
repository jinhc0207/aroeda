/**
 * 화면을 실제로 그려 보는 테스트 설정
 *
 * 이 프로젝트에는 테스트 러너가 둘 있다. 일부러 나눠 두었다.
 *
 *   npm run test:logic
 *     Node에 원래 있는 러너. 계산과 약속(계약)을 검사한다.
 *     supabase/functions 안의 코드는 Deno용이라 .ts 확장자를 붙여 불러오는데,
 *     Jest는 그걸 그대로 읽지 못한다. 그래서 그쪽은 건드리지 않는다.
 *
 *   npm run test:ui  (이 설정)
 *     화면을 실제로 그려서 눈에 보이는 것을 검사한다.
 *     react-native 본체는 Flow라는 다른 문법으로 쓰여 있어서
 *     Node가 그대로 읽지 못한다. jest-expo가 그 번역을 맡는다.
 *
 * 그래서 아래 testMatch가 중요하다.
 * Jest는 src/ui-tests 안의 파일만 본다.
 * 기존 44개 테스트 파일을 두 번 실행하면 안 된다.
 */

module.exports = {
  preset: 'jest-expo',

  // 화면 테스트만 Jest가 맡는다. 기존 테스트는 건드리지 않는다.
  testMatch: ['<rootDir>/src/ui-tests/**/*.test.tsx'],

  // moduleNameMapper는 일부러 적지 않는다.
  // jest-expo preset이 이미 @/ 를 src/ 로 이어 주고,
  // 그와 함께 react-native를 한 곳으로 모으는 규칙도 갖고 있다.
  // 여기서 다시 적으면 preset의 규칙 전체가 덮여 사라진다.
};
