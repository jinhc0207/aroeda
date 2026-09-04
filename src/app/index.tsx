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
import { ensureAnonymousSession } from '@/lib/anonymous-session';
import { requestRecommendation } from '@/lib/request-recommendation';
import { supabase } from '@/lib/supabase';
import { SCRIPTURE_CARDS } from '@/data/scripture-cards';
import { useSituation } from '@/state/situation';

/** 서버가 준 카드 id가 실제로 우리가 가진 카드인지 확인한다. */
const cardExists = (cardId: string) => SCRIPTURE_CARDS.some((card) => card.id === cardId);

/**
 * supabase.functions.invoke 결과를 단순한 모양으로 바꾼다.
 * 사용량 제한(429)만 구분할 수 있으면 된다. 원본 오류는 남기지 않는다.
 */
async function invokeRecommendScripture(body: { situation: string }) {
  const { data, error } = await supabase.functions.invoke('recommend-scripture', { body });

  if (error) {
    const status = (error as { context?: { status?: unknown } }).context?.status;
    return { ok: false as const, httpStatus: typeof status === 'number' ? status : undefined };
  }

  return { ok: true as const, data };
}

export default function SituationScreen() {
  const { situation, setSituation, setSelectedCardId } = useSituation();
  const [isFocused, setIsFocused] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

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

    setNotice(null);
    setIsSubmitting(true);
    // 새로 요청할 때 이전 추천이 남아 있지 않게 한다.
    setSelectedCardId(null);

    const outcome = await requestRecommendation(situation, {
      ensureSession: () => ensureAnonymousSession(supabase.auth),
      invokeRecommendScripture,
      cardExists,
    });

    if (outcome.status === 'recommend') {
      setSelectedCardId(outcome.cardId);
      setIsSubmitting(false);
      router.push('/scripture');
      return;
    }

    if (outcome.status === 'route') {
      setIsSubmitting(false);
      router.push(outcome.route === 'no_coverage' ? '/no-coverage' : `/${outcome.route}`);
      return;
    }

    setNotice(
      outcome.kind === 'rate_limited'
        ? '잠시 쉬었다가 다시 말씀을 찾아주세요.'
        : '지금은 말씀을 찾지 못했어요. 잠시 후 다시 시도해주세요.',
    );
    setIsSubmitting(false);
  };

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

            <View style={styles.footer}>
              <Text style={styles.footerText}>당신의 상황에 귀 기울이고,</Text>
              <Text style={styles.footerText}>함께 붙들 말씀을 찾아드릴게요.</Text>
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
});
