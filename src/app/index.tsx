import { router } from 'expo-router';
import { useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors } from '@/constants/aroeda-theme';
import { APP_RECOMMENDATION_DEPS } from '@/lib/app-recommendation-deps';
import {
  formatRateLimitNotice,
  formatDevDiagnostic,
  requestRecommendation,
  type DevDiagnosticCode,
} from '@/lib/request-recommendation';
import { useSituation } from '@/state/situation';

export default function SituationScreen() {
  const {
    situation,
    setSituation,
    setRecommendation,
    setDomainChoiceOptions,
    clearRecommendation,
    getResetCount,
    beginRecommendation,
    endRecommendation,
  } = useSituation();
  const [isFocused, setIsFocused] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  // 개발 모드에서만 화면에 낸다. 사용자에게 보이는 notice 문구는 바꾸지 않는다.
  const [devDiagnostic, setDevDiagnostic] = useState<DevDiagnosticCode | null>(null);

  const handleChangeText = (value: string) => {
    setSituation(value);
    if (notice) {
      setNotice(null);
    }
  };

  const handleSubmit = async () => {
    // 한 번의 제출은 한 번의 서버 호출이어야 한다.
    if (isSubmitting) return;

    if (situation.trim().length === 0) {
      setNotice('지금의 상황을 먼저 이야기해주세요.');
      return;
    }

    // 내 정보 삭제가 진행 중이면 새 추천을 시작하지 않는다.
    // 삭제 중에 새 익명 이용자가 만들어지거나, 지워질 정보로 요청이 나가지 않게 한다.
    // 추천을 기다리는 동안에는 반대로 삭제가 시작되지 않는다.
    if (!beginRecommendation()) {
      setNotice('내 정보 삭제가 끝난 뒤에 다시 시도해주세요.');
      return;
    }

    setNotice(null);
    setDevDiagnostic(null);
    setIsSubmitting(true);
    // 새로 요청할 때 이전 추천(카드·영역·영역 선택지)이 남아 있지 않게 한다.
    clearRecommendation();

    // 이 요청을 보낸 뒤 내 정보 삭제가 있었는지 알아보기 위해 지금 값을 기억한다.
    const resetCountAtStart = getResetCount();

    // 결과가 어떻든(예외 포함) 기다림 표시와 추천 잠금을 반드시 푼다.
    const outcome = await requestRecommendation(situation, APP_RECOMMENDATION_DEPS).finally(() => {
      setIsSubmitting(false);
      endRecommendation();
    });

    // 기다리는 동안 내 정보가 삭제됐다면 이 답은 버린다.
    // 지운 상황과 말씀을 되살리거나 다른 화면으로 옮기지 않는다.
    // 서버에서 이미 시작한 처리를 취소하는 것은 아니다. 답을 쓰지 않을 뿐이다.
    if (getResetCount() !== resetCountAtStart) return;

    if (outcome.status === 'recommend') {
      setRecommendation({
        cardId: outcome.cardId,
        selectedDomain: outcome.selectedDomain,
        ...(outcome.card ? { card: outcome.card } : {}),
      });
      router.push('/scripture');
      return;
    }

    if (outcome.status === 'domain_choice') {
      setDomainChoiceOptions(outcome.options);
      router.push('/domain-choice');
      return;
    }

    if (outcome.status === 'route') {
      router.push(outcome.route === 'no_coverage' ? '/no-coverage' : `/${outcome.route}`);
      return;
    }

    setNotice(
      outcome.kind === 'rate_limited'
        ? formatRateLimitNotice(outcome.retryAfterSeconds)
        : '지금은 말씀을 찾지 못했어요. 잠시 후 다시 시도해주세요.',
    );
    setDevDiagnostic(outcome.diagnostic);
  };

  const devDiagnosticText = formatDevDiagnostic(__DEV__, devDiagnostic);

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'bottom']}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          style={styles.flex}
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          showsVerticalScrollIndicator={false}>
          <View style={styles.content}>
            <Text style={styles.brand}>아뢰다</Text>

            <View style={styles.headingBlock}>
              <Text style={styles.heading}>지금, 어떤 상황에 있나요?</Text>
              <Text style={styles.guide}>지금의 상황을 편하게 적어주세요.</Text>
              <Text style={styles.guide}>짧게 적어도 괜찮아요.</Text>
            </View>

            <TextInput
              style={[styles.input, isFocused && styles.inputFocused]}
              value={situation}
              onChangeText={handleChangeText}
              onFocus={() => setIsFocused(true)}
              onBlur={() => setIsFocused(false)}
              placeholder="지금 나의 상황"
              placeholderTextColor={colors.textSubtle}
              multiline
              textAlignVertical="top"
              scrollEnabled={false}
              accessibilityLabel="지금 나의 상황"
            />

            <Pressable
              style={({ pressed }) => [
                styles.button,
                pressed && styles.buttonPressed,
                isSubmitting && styles.buttonWaiting,
              ]}
              onPress={handleSubmit}
              disabled={isSubmitting}
              accessibilityRole="button"
              accessibilityState={{ disabled: isSubmitting }}
              accessibilityLabel={isSubmitting ? '말씀을 찾고 있어요' : '말씀을 찾아주세요'}>
              <Text style={styles.buttonLabel}>
                {isSubmitting ? '말씀을 찾고 있어요' : '말씀을 찾아주세요'}
              </Text>
            </Pressable>

            {notice ? (
              <View style={styles.notice}>
                <Text style={styles.noticeText}>{notice}</Text>
              </View>
            ) : null}

            {devDiagnosticText ? (
              <Text style={styles.devDiagnostic} accessibilityLabel="개발 진단">
                {devDiagnosticText}
              </Text>
            ) : null}

            <View style={styles.footer}>
              <Text style={styles.footerText}>당신의 상황에 귀 기울이고,</Text>
              <Text style={styles.footerText}>함께 붙들 말씀을 찾아드릴게요.</Text>

              {/* 말씀을 찾는 동안에는 설정으로 가지 않는다. 기다리던 답이 삭제 뒤에 도착하지 않게 한다. */}
              <Pressable
                style={({ pressed }) => [styles.footerLink, pressed && styles.buttonPressed]}
                onPress={() => router.push('/settings')}
                disabled={isSubmitting}
                accessibilityRole="button"
                accessibilityState={{ disabled: isSubmitting }}
                accessibilityLabel="개인정보 및 내 정보"
                hitSlop={8}>
                <Text style={styles.footerLinkLabel}>개인정보 및 내 정보</Text>
              </Pressable>
            </View>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
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
    paddingBottom: 28,
  },
  brand: {
    fontSize: 15,
    lineHeight: 22,
    fontWeight: '600',
    letterSpacing: 1,
    color: colors.sage,
  },
  headingBlock: {
    marginTop: 52,
  },
  heading: {
    fontSize: 24,
    lineHeight: 36,
    fontWeight: '600',
    color: colors.text,
  },
  guide: {
    marginTop: 12,
    fontSize: 15,
    lineHeight: 25,
    color: colors.textMuted,
  },
  input: {
    marginTop: 32,
    minHeight: 168,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: colors.inputBorder,
    backgroundColor: colors.inputBackground,
    paddingHorizontal: 18,
    paddingTop: 18,
    paddingBottom: 18,
    fontSize: 16,
    lineHeight: 26,
    color: colors.text,
  },
  inputFocused: {
    borderColor: colors.sage,
  },
  button: {
    marginTop: 20,
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
  buttonWaiting: {
    opacity: 0.6,
  },
  buttonLabel: {
    fontSize: 17,
    lineHeight: 24,
    fontWeight: '600',
    color: colors.background,
  },
  notice: {
    marginTop: 16,
    borderRadius: 14,
    paddingVertical: 14,
    paddingHorizontal: 16,
    backgroundColor: colors.noticeBackground,
  },
  noticeText: {
    fontSize: 14,
    lineHeight: 22,
    textAlign: 'center',
    color: colors.text,
  },
  devDiagnostic: {
    marginTop: 8,
    fontSize: 11,
    lineHeight: 16,
    textAlign: 'center',
    color: colors.textSubtle,
  },
  footer: {
    marginTop: 'auto',
    paddingTop: 40,
    alignItems: 'center',
  },
  footerText: {
    fontSize: 13,
    lineHeight: 21,
    textAlign: 'center',
    color: colors.textSubtle,
  },
  footerLink: {
    marginTop: 20,
    paddingVertical: 6,
    paddingHorizontal: 10,
  },
  footerLinkLabel: {
    fontSize: 13,
    lineHeight: 20,
    textAlign: 'center',
    textDecorationLine: 'underline',
    color: colors.textMuted,
  },
});
