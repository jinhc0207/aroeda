import { router } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors } from '@/constants/aroeda-theme';

/**
 * Recommendation Gate의 route가 no_coverage일 때 보여줄 화면.
 *
 * 아뢰다의 원칙: 적절한 말씀이 없는데 억지로 비슷한 말씀을 추천하지 않는다.
 * 그 원칙이 사용자에게 실패처럼 느껴지지 않도록 차분하게 전한다.
 *
 * 아직 서버와 연결하지 않았다. 화면만 준비한 상태다.
 * 사용자가 적은 상황은 여기서 지우지 않는다. 앱 전체 상태(SituationProvider)에 그대로 남는다.
 */
export default function NoCoverageScreen() {
  const handleBack = () => {
    if (router.canGoBack()) {
      router.back();
      return;
    }
    router.replace('/');
  };

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'bottom']}>
      <ScrollView
        style={styles.flex}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}>
        <View style={styles.content}>
          <Text style={styles.brand}>아뢰다</Text>

          <View style={styles.block}>
            <Text style={styles.title}>지금은 말씀을 서둘러 고르지 않을게요</Text>

            <Text style={styles.body}>
              지금 나누어주신 상황을 충분히 담을 수 있는 말씀을 아뢰다가 아직 준비하지 못했어요.
            </Text>
            <Text style={styles.body}>
              비슷해 보이는 말씀을 억지로 연결하기보다, 조금 더 신중하게 말씀을 준비하겠습니다.
            </Text>
          </View>

          <View style={styles.actions}>
            <Pressable
              style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
              onPress={handleBack}
              accessibilityRole="button"
              accessibilityLabel="다시 이야기하기">
              <Text style={styles.buttonLabel}>다시 이야기하기</Text>
            </Pressable>
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
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
  block: {
    marginTop: 56,
  },
  title: {
    fontSize: 23,
    lineHeight: 36,
    fontWeight: '600',
    color: colors.text,
  },
  body: {
    marginTop: 22,
    fontSize: 16,
    lineHeight: 30,
    color: colors.textMuted,
  },
  actions: {
    marginTop: 'auto',
    paddingTop: 48,
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
  buttonLabel: {
    fontSize: 17,
    lineHeight: 24,
    fontWeight: '600',
    color: colors.background,
  },
});
