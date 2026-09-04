/**
 * Supabase 클라이언트 (앱에서 쓰는 쪽)
 *
 * 여기서 쓰는 두 값은 EXPO_PUBLIC_ 로 시작하는 공개 설정값이다.
 * 앱 번들 안에 그대로 들어가고, 앱을 뜯어보면 누구나 볼 수 있다.
 * 그래서 publishable key만 쓴다.
 *
 * OPENAI_API_KEY, Supabase secret key, service_role key는 절대 여기 두지 않는다.
 * 그 키들은 서버(Supabase Edge Function 시크릿)에만 있다.
 *
 * 세션은 기기 저장소(AsyncStorage)에 보관해서 앱을 다시 열어도 이어지게 한다.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabasePublishableKey = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

/** 환경 변수가 없으면 앱을 죽이지 않고, 연결 준비가 안 된 상태로 둔다. */
export const isSupabaseConfigured = Boolean(supabaseUrl && supabasePublishableKey);

/**
 * 웹 빌드는 화면을 서버에서 한 번 미리 그린다(SSR). 그때는 브라우저 저장소가 없다.
 * 그래서 저장소가 없는 환경에서는 세션을 저장하지 않도록 한다.
 * iOS / Android 앱과 실제 브라우저에서는 평소대로 AsyncStorage를 쓴다.
 */
const hasBrowserStorage = typeof window !== 'undefined';

export const supabase = createClient(supabaseUrl ?? '', supabasePublishableKey ?? '', {
  auth: {
    storage: hasBrowserStorage ? AsyncStorage : undefined,
    autoRefreshToken: hasBrowserStorage,
    persistSession: hasBrowserStorage,
    // 앱에는 로그인 콜백 URL이 없다. 웹 주소에서 세션을 찾지 않는다.
    detectSessionInUrl: false,
  },
});
