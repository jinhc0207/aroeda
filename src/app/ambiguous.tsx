import { router } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors } from '@/constants/aroeda-theme';

/**
 * Recommendation Gate의 route가 ambiguous일 때 보여줄 화면.
 *
 * 두 개 이상의 카드가 정확히 같은 최고점을 받아 한 장을 임의로 고르지 않은 경우다.
 * 오류가 아니다. "애매하면 임의로 고르지 않는다"는 원칙을 조용히 전한다.
 *
 * 사용자에게 카드 목록이나 점수를 보여주고 고르게 하지 않는다.
 * 새 입력칸도 만들지 않는다. 첫 화면으로 돌아가 원하면 상황을 덧붙이게 한다.
 *
 * 아직 서버와 연결하지 않았다. 화면만 준비한 상태다.
 * 사용자가 적은 상황은 여기서 지우지 않는다. 앱 전체 상태(SituationProvider)에 그대로 남는다.
 */
export default function AmbiguousScreen() {
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
            <Text style={styles.title}>조금 더 신중하게 말씀을 찾고 싶어요</Text>

            <View style={styles.divider} />

            <Text style={styles.body}>
              지금 나누어주신 이야기에는 함께 살펴볼 수 있는 말씀이 두 가지 이상 있어요.
            </Text>
            <Text style={styles.body}>
              아뢰다가 임의로 하나를 고르기보다, 지금의 상황을 조금 더 들은 뒤 더 잘 맞는 말씀을
              찾는 편이 좋겠습니다.
            </Text>
          </View>

          <View style={styles.actions}>
            <Pressable
              style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
              onPress={handleBack}
              accessibilityRole="button"
              accessibilityLabel="조금 더 이야기하기">
              <Text style={styles.buttonLabel}>조금 더 이야기하기</Text>
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
  // no-coverage 화면과 가족처럼 보이되 같은 화면으로 착각하지 않도록 얇은 선 하나만 둔다.
  divider: {
    marginTop: 24,
    width: 48,
    height: 2,
    borderRadius: 1,
    backgroundColor: colors.sand,
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
