/**
 * Scripture Matching Engine
 *
 * 실제 내용은 supabase/functions/_shared 에 있다.
 * Supabase Edge Function이 폴더 바깥을 참조하지 않고도 배포될 수 있도록
 * 공용 규칙의 원본(canonical source)을 그쪽에 두고, 여기서는 그대로 다시 내보내기만 한다.
 *
 * 앱과 로컬 테스트는 지금까지처럼 이 경로를 그대로 쓰면 된다.
 */

export * from '../../supabase/functions/_shared/scripture-matcher.ts';
