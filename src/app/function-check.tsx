import { useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors } from '@/constants/aroeda-theme';
import { ensureAnonymousSession } from '@/lib/anonymous-session';
import { runFunctionCheck, type FunctionCheckResult } from '@/lib/function-check';
import { isSupabaseConfigured, supabase } from '@/lib/supabase';

/**
 * 개발 확인용 화면.
 *
 * 제품 화면 어디에도 이 화면으로 가는 버튼이나 링크를 두지 않는다.
 * 주소(/function-check)를 직접 열었을 때만 보인다.
 *
 * 화면에 들어오는 것만으로는 아무것도 호출하지 않는다.
 * 버튼을 눌렀을 때만 recommend-scripture를 한 번 부른다. (OpenAI 비용이 든다)
 *
 * 토큰, JWT, Authorization 헤더, 사용자 id, key, OpenAI 원본 응답은
 * 화면에도 콘솔에도 남기지 않는다.
 */
export default function FunctionCheckScreen() {
  const [status, setStatus] = useState<'idle' | 'running' | 'done'>('idle');
  const [result, setResult] = useState<FunctionCheckResult | null>(null);

  const handlePress = async () => {
    if (status !== 'idle') return;
    setStatus('running');

    if (!isSupabaseConfigured) {
      setResult({ status: 'failed', sessionReady: false, failure: 'AUTH_FAILED' });
      setStatus('done');
      return;
    }

    const checked = await runFunctionCheck({
      ensureSession: () => ensureAnonymousSession(supabase.auth),
      // Authorization 헤더를 직접 만들지 않는다.
      // 지금 로그인된 익명 세션의 JWT를 supabase-js가 알아서 붙인다.
      invokeRecommendScripture: (body) => supabase.functions.invoke('recommend-scripture', { body }),
    });

    setResult(checked);
    // 한 번 확인하면 이 화면에서는 다시 부르지 않는다.
    setStatus('done');
  };

  const buttonDisabled = status !== 'idle';

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'bottom']}>
      <ScrollView style={styles.flex} contentContainerStyle={styles.scrollContent}>
        <View style={styles.content}>
          <Text style={styles.brand}>아뢰다</Text>
          <Text style={styles.title}>아뢰다 서버 연결 확인</Text>

          {result === null ? (
            <Text style={styles.guide}>
              아래 버튼을 한 번 누르면 서버에 딱 한 번 확인 요청을 보냅니다.
            </Text>
          ) : result.status === 'ok' ? (
            <View style={styles.rows}>
              <Row label="익명 세션" value="준비됨" />
              <Row label="Edge Function" value="연결됨" />
              <Row label="결과" value={result.route} />
              <Row label="상황 영역" value={result.primaryDomain} />
              <Row label="선택 카드" value={result.selectedCardId ?? '없음'} />
              <Row label="안전 상태" value={result.safetyLevel} />
              {!result.matchesExpectation ? (
                <Text style={styles.mismatch}>연결은 되었지만 기대한 결과와 다릅니다.</Text>
              ) : null}
            </View>
          ) : (
            <View style={styles.rows}>
              <Text style={styles.failure}>서버 연결을 확인하지 못했습니다.</Text>
              <Row label="구분" value={result.failure} />
            </View>
          )}

          <View style={styles.actions}>
            <Pressable
              style={({ pressed }) => [
                styles.button,
                pressed && styles.buttonPressed,
                buttonDisabled && styles.buttonDisabled,
              ]}
              onPress={handlePress}
              disabled={buttonDisabled}
              accessibilityRole="button"
              accessibilityState={{ disabled: buttonDisabled }}
              accessibilityLabel="서버 연결 한 번 확인하기">
              {status === 'running' ? (
                <ActivityIndicator color={colors.background} />
              ) : (
                <Text style={styles.buttonLabel}>서버 연결 한 번 확인하기</Text>
              )}
            </Pressable>

            {status === 'done' ? (
              <Text style={styles.note}>
                확인이 끝났습니다. 다시 확인하려면 이 화면을 새로고침해주세요.
              </Text>
            ) : null}

            <Text style={styles.note}>개발 확인용 화면입니다. 제품 화면에는 나오지 않습니다.</Text>
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  safeArea: {
    flex: 1,
    backgroundColor: colors.background,
  },
  scrollContent: {
    flexGrow: 1,
  },
  content: {
    flex: 1,
    width: '100%',
    maxWidth: 520,
    alignSelf: 'center',
    paddingHorizontal: 24,
    paddingTop: 16,
    paddingBottom: 32,
  },
  brand: {
    fontSize: 15,
    lineHeight: 22,
    fontWeight: '600',
    letterSpacing: 1,
    color: colors.sage,
  },
  title: {
    marginTop: 44,
    fontSize: 23,
    lineHeight: 34,
    fontWeight: '600',
    color: colors.text,
  },
  guide: {
    marginTop: 20,
    fontSize: 15,
    lineHeight: 26,
    color: colors.textMuted,
  },
  rows: {
    marginTop: 28,
    gap: 14,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 16,
    borderBottomWidth: 1,
    borderBottomColor: colors.hairline,
    paddingBottom: 14,
  },
  rowLabel: {
    fontSize: 15,
    lineHeight: 24,
    color: colors.textMuted,
  },
  rowValue: {
    fontSize: 16,
    lineHeight: 24,
    fontWeight: '600',
    color: colors.text,
  },
  mismatch: {
    marginTop: 8,
    fontSize: 14,
    lineHeight: 24,
    color: colors.text,
  },
  failure: {
    fontSize: 16,
    lineHeight: 28,
    color: colors.text,
  },
  actions: {
    marginTop: 'auto',
    paddingTop: 40,
    gap: 14,
  },
  button: {
    minHeight: 58,
    borderRadius: 18,
    backgroundColor: colors.text,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
  },
  buttonPressed: {
    opacity: 0.85,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  buttonLabel: {
    fontSize: 17,
    lineHeight: 24,
    fontWeight: '600',
    color: colors.background,
  },
  note: {
    fontSize: 13,
    lineHeight: 21,
    color: colors.textSubtle,
  },
});
