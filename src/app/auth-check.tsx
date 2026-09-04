import { useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors } from '@/constants/aroeda-theme';
import { ensureAnonymousSession, type SessionSummary } from '@/lib/anonymous-session';
import { isSupabaseConfigured, supabase } from '@/lib/supabase';

/**
 * 개발 확인용 화면.
 *
 * 제품 화면 어디에도 이 화면으로 가는 버튼이나 링크를 두지 않는다.
 * 주소(/auth-check)를 직접 열었을 때만 보인다.
 *
 * 토큰, JWT, 사용자 id, publishable key는 화면에 표시하지 않는다.
 * 세션이 준비되었는지와 새로 만들었는지 이어 썼는지만 보여준다.
 */
export default function AuthCheckScreen() {
  const [summary, setSummary] = useState<SessionSummary | null>(null);

  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      if (!isSupabaseConfigured) {
        if (!cancelled) {
          setSummary({ sessionExists: false, isAnonymous: false, source: 'failed', errorName: 'NotConfigured' });
        }
        return;
      }

      const result = await ensureAnonymousSession(supabase.auth);
      if (!cancelled) setSummary(result);
      // 민감한 값은 남기지 않는다. 종류만 남긴다.
      console.log(
        `[auth-check] sessionExists: ${result.sessionExists} / isAnonymous: ${result.isAnonymous} / source: ${result.source}` +
          (result.errorName ? ` / error: ${result.errorName}` : ''),
      );
    };

    run();
    return () => {
      cancelled = true;
    };
  }, []);

  const sourceLabel = (() => {
    if (!summary) return null;
    if (summary.source === 'created') return '새로 생성됨';
    if (summary.source === 'restored') return '기존 세션 복원됨';
    return null;
  })();

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'bottom']}>
      <ScrollView style={styles.flex} contentContainerStyle={styles.scrollContent}>
        <View style={styles.content}>
          <Text style={styles.brand}>아뢰다</Text>
          <Text style={styles.title}>아뢰다 연결 확인</Text>

          {!summary ? (
            <View style={styles.loading}>
              <ActivityIndicator color={colors.sage} />
              <Text style={styles.loadingText}>확인하는 중이에요</Text>
            </View>
          ) : summary.source === 'failed' ? (
            <Text style={styles.failure}>Supabase 연결을 준비하지 못했습니다.</Text>
          ) : (
            <View style={styles.rows}>
              <Row label="Supabase" value="연결됨" />
              <Row label="익명 세션" value={summary.isAnonymous ? '준비됨' : '준비됨 (익명 아님)'} />
              <Row label="세션 상태" value={sourceLabel ?? '-'} />
            </View>
          )}

          <Text style={styles.note}>개발 확인용 화면입니다. 제품 화면에는 나오지 않습니다.</Text>
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
  loading: {
    marginTop: 32,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  loadingText: {
    fontSize: 15,
    lineHeight: 24,
    color: colors.textMuted,
  },
  failure: {
    marginTop: 32,
    fontSize: 16,
    lineHeight: 28,
    color: colors.text,
  },
  rows: {
    marginTop: 32,
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
  note: {
    marginTop: 'auto',
    paddingTop: 40,
    fontSize: 13,
    lineHeight: 21,
    color: colors.textSubtle,
  },
});
