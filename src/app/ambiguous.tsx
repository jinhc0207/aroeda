import { router } from 'expo-router';
import { useRef, useState } from 'react';
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
  formatDevDiagnostic,
  formatRateLimitNotice,
  requestRecommendation,
  type DevDiagnosticCode,
} from '@/lib/request-recommendation';
import {
  buildAmbiguousClarificationPrompt,
  combineSituationWithClarification,
  MAX_CLARIFICATION_DETAIL_LENGTH,
  MAX_CLARIFICATION_ROUNDS,
  MAX_RECOMMENDATION_SITUATION_LENGTH,
} from '@/lib/situation-clarification';
import { useSituation } from '@/state/situation';

/**
 * 한 말씀을 고르기 어려운 상황에서 추가 설명을 듣는 화면.
 * 영역이 아직 정해지지 않았거나 여러 말씀이 동점이면 최대 3번 상황을 더 들은 뒤
 * 같은 추천 절차를 다시 실행한다.
 * domain_choice와 질문 횟수를 공유하므로 두 경로를 오가더라도 총 3번을 넘지 않는다.
 */
export default function AmbiguousScreen() {
  const {
    situation,
    setSituation,
    setRecommendation,
    setDomainChoiceOptions,
    clarificationRound,
    setClarificationRound,
    getResetCount,
    beginRecommendation,
    endRecommendation,
  } = useSituation();
  const didSubmitRef = useRef(false);
  const [detail, setDetail] = useState('');
  const [isFocused, setIsFocused] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [devDiagnostic, setDevDiagnostic] = useState<DevDiagnosticCode | null>(null);

  const clarification = buildAmbiguousClarificationPrompt(clarificationRound);
  const remainingLength = Math.max(0, MAX_RECOMMENDATION_SITUATION_LENGTH - situation.trim().length - 1);
  const detailMaxLength = Math.min(MAX_CLARIFICATION_DETAIL_LENGTH, remainingLength);
  const visibleNotice =
    notice ??
    (clarification && detailMaxLength === 0
      ? '처음 입력한 내용이 길어서 설명을 더 붙일 수 없어요. 처음 화면에서 내용을 조금 줄여주세요.'
      : null);

  const handleBack = () => {
    if (router.canGoBack()) {
      router.back();
      return;
    }
    router.replace('/');
  };

  const handleClarify = async () => {
    if (didSubmitRef.current || isSubmitting) return;

    const combined = combineSituationWithClarification(situation, detail);
    if (!combined.ok) {
      setNotice(
        combined.reason === 'empty_detail'
          ? '조금 더 들려주고 싶은 내용을 먼저 적어주세요.'
          : combined.reason === 'too_long'
            ? '전체 내용이 너무 길어요. 처음 상황이나 추가 설명을 조금 줄여주세요.'
            : '처음 상황으로 돌아가 다시 적어주세요.',
      );
      return;
    }

    if (!beginRecommendation()) {
      setNotice('내 정보 삭제가 끝난 뒤에 다시 시도해주세요.');
      return;
    }

    didSubmitRef.current = true;
    setNotice(null);
    setDevDiagnostic(null);
    setIsSubmitting(true);
    setSituation(combined.situation);
    const resetCountAtStart = getResetCount();

    const outcome = await requestRecommendation(combined.situation, APP_RECOMMENDATION_DEPS).finally(() => {
      setIsSubmitting(false);
      endRecommendation();
    });

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
      setClarificationRound(clarificationRound + 1);
      setDomainChoiceOptions(outcome.options);
      router.push('/domain-choice');
      return;
    }

    if (outcome.status === 'route') {
      if (outcome.route === 'ambiguous' ||
          (outcome.route === 'no_coverage' && outcome.needsClarification)) {
        const nextRound = clarificationRound + 1;
        setClarificationRound(nextRound);
        setDetail('');
        setNotice(
          nextRound >= MAX_CLARIFICATION_ROUNDS
            ? '여전히 한 말씀으로 좁히기 어려워요. 임의로 고르지 않고 여기서 질문을 멈출게요.'
            : null,
        );
        didSubmitRef.current = false;
        return;
      }
      router.push(outcome.route === 'no_coverage' ? '/no-coverage' : `/${outcome.route}`);
      return;
    }

    setNotice(
      outcome.kind === 'rate_limited'
        ? formatRateLimitNotice(outcome.retryAfterSeconds)
        : '지금은 말씀을 찾지 못했어요. 잠시 후 다시 시도해주세요.',
    );
    setDevDiagnostic(outcome.diagnostic);
    didSubmitRef.current = false;
  };

  const devDiagnosticText = formatDevDiagnostic(__DEV__, devDiagnostic);

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'bottom']}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          style={styles.flex}
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          showsVerticalScrollIndicator={false}>
          <View style={styles.content}>
            <Text style={styles.brand}>아뢰다</Text>

            <View style={styles.block}>
              <Text style={styles.title}>
                {clarification ? '조금만 더 들려주세요' : '조금 더 신중하게 말씀을 찾고 싶어요'}
              </Text>
              <View style={styles.divider} />
              {clarification ? (
                <>
                  <Text style={styles.question}>{clarification.question}</Text>
                  <Text style={styles.guide}>{clarification.guide}</Text>
                </>
              ) : (
                <Text style={styles.body}>
                  지금까지 들려주신 내용만으로는 한 말씀을 임의로 고르지 않는 편이 좋겠습니다.
                </Text>
              )}
            </View>

            {clarification ? (
              <>
                <TextInput
                  style={[styles.input, isFocused && styles.inputFocused]}
                  value={detail}
                  onChangeText={(value) => {
                    setDetail(value);
                    if (notice) setNotice(null);
                  }}
                  onFocus={() => setIsFocused(true)}
                  onBlur={() => setIsFocused(false)}
                  placeholder="예: 지금 가장 힘든 점이나 바라는 도움"
                  placeholderTextColor={colors.textSubtle}
                  multiline
                  textAlignVertical="top"
                  maxLength={detailMaxLength}
                  accessibilityLabel="추가 상황 설명"
                />
                <Pressable
                  style={({ pressed }) => [
                    styles.button,
                    pressed && styles.buttonPressed,
                    isSubmitting && styles.buttonWaiting,
                  ]}
                  onPress={handleClarify}
                  disabled={isSubmitting || detailMaxLength === 0}
                  accessibilityRole="button"
                  accessibilityState={{ disabled: isSubmitting || detailMaxLength === 0 }}
                  accessibilityLabel={isSubmitting ? '다시 말씀을 찾고 있어요' : '추가 설명으로 다시 말씀 찾기'}>
                  <Text style={styles.buttonLabel}>
                    {isSubmitting ? '다시 말씀을 찾고 있어요' : '추가 설명으로 다시 말씀 찾기'}
                  </Text>
                </Pressable>
              </>
            ) : null}

            {visibleNotice ? (
              <View style={styles.notice}>
                <Text style={styles.noticeText}>{visibleNotice}</Text>
              </View>
            ) : null}
            {devDiagnosticText ? (
              <Text style={styles.devDiagnostic} accessibilityLabel="개발 진단">
                {devDiagnosticText}
              </Text>
            ) : null}

            <Pressable
              style={({ pressed }) => [styles.secondaryButton, pressed && styles.buttonPressed]}
              onPress={handleBack}
              disabled={isSubmitting}
              accessibilityRole="button"
              accessibilityState={{ disabled: isSubmitting }}
              accessibilityLabel="이전 화면으로 돌아가기">
              <Text style={styles.secondaryButtonLabel}>이전 화면으로 돌아가기</Text>
            </Pressable>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  safeArea: { flex: 1, backgroundColor: colors.background },
  scrollContent: { flexGrow: 1 },
  content: {
    flex: 1,
    width: '100%',
    maxWidth: 520,
    alignSelf: 'center',
    paddingHorizontal: 24,
    paddingTop: 16,
    paddingBottom: 32,
  },
  brand: { fontSize: 15, lineHeight: 22, fontWeight: '600', letterSpacing: 1, color: colors.sage },
  block: { marginTop: 56 },
  title: { fontSize: 23, lineHeight: 36, fontWeight: '600', color: colors.text },
  divider: { marginTop: 24, width: 48, height: 2, borderRadius: 1, backgroundColor: colors.sand },
  question: { marginTop: 22, fontSize: 17, lineHeight: 28, fontWeight: '600', color: colors.text },
  guide: { marginTop: 8, fontSize: 15, lineHeight: 25, color: colors.textMuted },
  body: { marginTop: 22, fontSize: 16, lineHeight: 30, color: colors.textMuted },
  input: {
    marginTop: 28,
    minHeight: 116,
    borderWidth: 1,
    borderColor: colors.inputBorder,
    borderRadius: 18,
    backgroundColor: colors.inputBackground,
    paddingHorizontal: 18,
    paddingVertical: 16,
    fontSize: 16,
    lineHeight: 25,
    color: colors.text,
  },
  inputFocused: { borderColor: colors.sage },
  button: {
    marginTop: 18,
    minHeight: 58,
    borderRadius: 18,
    backgroundColor: colors.text,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
  },
  buttonWaiting: { opacity: 0.7 },
  buttonPressed: { opacity: 0.85 },
  buttonLabel: { fontSize: 17, lineHeight: 24, fontWeight: '600', color: colors.background },
  notice: { marginTop: 18, borderRadius: 14, backgroundColor: colors.noticeBackground, padding: 16 },
  noticeText: { fontSize: 14, lineHeight: 22, color: colors.textMuted },
  devDiagnostic: { marginTop: 12, fontSize: 12, lineHeight: 18, color: colors.textSubtle },
  secondaryButton: { marginTop: 'auto', paddingTop: 40, minHeight: 64, alignItems: 'center' },
  secondaryButtonLabel: { fontSize: 15, lineHeight: 22, fontWeight: '600', color: colors.textMuted },
});
