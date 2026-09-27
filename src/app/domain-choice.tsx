import { router, useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
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
import { domainLabel } from '@/data/domain-labels';
import { APP_RECOMMENDATION_DEPS } from '@/lib/app-recommendation-deps';
import {
  formatDevDiagnostic,
  formatRateLimitNotice,
  requestRecommendation,
  type DevDiagnosticCode,
  type DomainChoiceOption,
} from '@/lib/request-recommendation';
import {
  buildSituationClarificationPrompt,
  combineSituationWithClarification,
  MAX_CLARIFICATION_DETAIL_LENGTH,
  MAX_CLARIFICATION_ROUNDS,
  MAX_RECOMMENDATION_SITUATION_LENGTH,
} from '@/lib/situation-clarification';
import { useSituation } from '@/state/situation';

/**
 * 영역 선택 화면
 *
 * Recommendation Gate의 route가 domain_choice일 때만 연다.
 * 첫 화면이 사용자 문장 하나로 이미 두 후보 각각의 결과(domainChoiceOptions)를 받아 왔다.
 * 사용자는 두 후보 중 하나를 바로 고를 수도 있고, 두 후보에서 만든 질문에 상황을 한두 문장
 * 더 적어 기존 추천 절차를 다시 실행할 수도 있다. 추가 질문은 최대 3번이고, 바로 고르면 서버를
 * 다시 부르지 않는다.
 *
 * 내부 영문 domain 코드(fear_uncertainty 등)는 화면 어디에도, 접근성 문구에도 내지 않는다.
 * DOMAIN_LABELS의 한국어 이름만 보여준다.
 *
 * 뒤로가기로 같은 선택 화면에 돌아올 수 있어야 한다.
 *   그래서 고를 때 router.replace가 아니라 router.push를 쓴다(스택에 이 화면이 남는다).
 *   applyDomainChoiceOption은 카드·영역만 바꾸고 domainChoiceOptions는 건드리지 않으므로,
 *   말씀·ambiguous·no_coverage 화면에서 뒤로 돌아오면 같은 두 후보가 그대로 남아 있다.
 *
 * 연속 탭 가드(didChooseRef)는 포커스 단위다.
 *   useFocusEffect로 이 화면이 (다시) 포커스될 때마다 가드를 풀어, 뒤로 돌아와 다른 option을
 *   또 고를 수 있게 한다. 포커스되지 않은 동안(다른 화면이 앞에 있는 동안) 삭제 등으로
 *   domainChoiceOptions가 비워져도 지금 화면을 갑자기 바꾸지 않고, 이 화면이 다시 포커스됐을 때만
 *   옵션이 없다는 것을 보고 홈으로 보낸다. 옵션 없이 직접 들어온 경우도 같은 길로 처리된다.
 */
export default function DomainChoiceScreen() {
  const {
    situation,
    setSituation,
    domainChoiceOptions,
    setDomainChoiceOptions,
    applyDomainChoiceOption,
    getResetCount,
    beginRecommendation,
    endRecommendation,
  } = useSituation();
  const didChooseRef = useRef(false);
  const [detail, setDetail] = useState('');
  const [isFocused, setIsFocused] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [clarificationRound, setClarificationRound] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [devDiagnostic, setDevDiagnostic] = useState<DevDiagnosticCode | null>(null);

  useFocusEffect(
    useCallback(() => {
      // 포커스될 때마다(처음 들어올 때, 뒤로 돌아올 때 모두) 탭 가드를 다시 연다.
      didChooseRef.current = false;

      // 지금 옵션이 유효한지 포커스 시점에 본다.
      // 포커스되지 않은 동안 옵션이 바뀌어도 이 검사는 다음 포커스까지 기다린다.
      if (domainChoiceOptions.length !== 2) {
        router.replace('/');
      }
    }, [domainChoiceOptions]),
  );

  if (domainChoiceOptions.length !== 2) {
    return <SafeAreaView style={styles.safeArea} edges={['top', 'bottom']} />;
  }

  const clarification = buildSituationClarificationPrompt(domainChoiceOptions, clarificationRound);
  const remainingLength = Math.max(
    0,
    MAX_RECOMMENDATION_SITUATION_LENGTH - situation.trim().length - 1,
  );
  const detailMaxLength = Math.min(MAX_CLARIFICATION_DETAIL_LENGTH, remainingLength);
  const visibleNotice =
    notice ??
    (clarification && detailMaxLength === 0
      ? '처음 입력한 내용이 길어서 설명을 더 붙일 수 없어요. 아래에서 가까운 쪽을 골라주세요.'
      : null);

  const handleChoose = (option: DomainChoiceOption) => {
    // 이미 이번 포커스에서 선택이 시작됐으면(연속 탭 등) 다시 실행하지 않는다.
    if (didChooseRef.current || isSubmitting) return;
    didChooseRef.current = true;

    // domainChoiceOptions는 그대로 둔 채 카드·영역만 반영한다.
    // 그래야 뒤로 돌아왔을 때 같은 두 후보에서 다른 쪽을 다시 고를 수 있다.
    applyDomainChoiceOption(option);

    if (option.resolution === 'recommend' && option.selectedCardId) {
      router.push('/scripture');
      return;
    }

    router.push(option.resolution === 'ambiguous' ? '/ambiguous' : '/no-coverage');
  };

  const handleClarify = async () => {
    if (didChooseRef.current || isSubmitting) return;

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

    didChooseRef.current = true;
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
      // 기존 두 option은 뒤로 돌아왔을 때 보존한다. 선택 화면의 포커스 가드도 그대로 유지된다.
      applyDomainChoiceOption({
        domain: outcome.selectedDomain,
        resolution: 'recommend',
        selectedCardId: outcome.cardId,
        ...(outcome.card ? { selectedCard: outcome.card } : {}),
      });
      router.push('/scripture');
      return;
    }

    if (outcome.status === 'domain_choice') {
      setDomainChoiceOptions(outcome.options);
      setDetail('');
      const nextRound = clarificationRound + 1;
      setClarificationRound(nextRound);
      setNotice(
        nextRound >= MAX_CLARIFICATION_ROUNDS
          ? '여전히 두 상황이 함께 보여요. 계속 질문하지 않고, 아래에서 지금 더 가까운 쪽을 골라주세요.'
          : null,
      );
      didChooseRef.current = false;
      return;
    }

    if (outcome.status === 'route') {
      // 카드는 비우되 두 option은 보존해 뒤로 돌아올 수 있게 한다.
      applyDomainChoiceOption({
        domain: domainChoiceOptions[0].domain,
        resolution: outcome.route === 'ambiguous' ? 'ambiguous' : 'no_coverage',
        selectedCardId: null,
      });
      router.push(outcome.route === 'no_coverage' ? '/no-coverage' : `/${outcome.route}`);
      return;
    }

    setNotice(
      outcome.kind === 'rate_limited'
        ? formatRateLimitNotice(outcome.retryAfterSeconds)
        : '지금은 말씀을 찾지 못했어요. 잠시 후 다시 시도해주세요.',
    );
    setDevDiagnostic(outcome.diagnostic);
    didChooseRef.current = false;
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
              <Text style={styles.heading}>조금만 더 들려주세요</Text>
              {clarification ? (
                <>
                  <Text style={styles.question}>{clarification.question}</Text>
                  <Text style={styles.guide}>{clarification.guide}</Text>
                </>
              ) : null}
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
                  placeholder="예: 가장 마음에 걸리는 일이나 힘든 점"
                  placeholderTextColor={colors.textSubtle}
                  multiline
                  textAlignVertical="top"
                  maxLength={detailMaxLength}
                  accessibilityLabel="추가 상황 설명"
                />

                <Pressable
                  style={({ pressed }) => [
                    styles.clarifyButton,
                    pressed && styles.optionButtonPressed,
                    isSubmitting && styles.buttonWaiting,
                  ]}
                  onPress={handleClarify}
                  disabled={isSubmitting || detailMaxLength === 0}
                  accessibilityRole="button"
                  accessibilityState={{ disabled: isSubmitting || detailMaxLength === 0 }}
                  accessibilityLabel={isSubmitting ? '다시 말씀을 찾고 있어요' : '추가 설명으로 다시 말씀 찾기'}>
                  <Text style={styles.clarifyButtonLabel}>
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

            <Text style={styles.orGuide}>
              {clarificationRound >= MAX_CLARIFICATION_ROUNDS
                ? '지금 더 가까운 쪽을 골라주세요.'
                : '더 적기 어렵다면, 지금 더 가까운 쪽을 바로 골라도 괜찮아요.'}
            </Text>

            <View style={styles.options}>
              {domainChoiceOptions.map((option) => {
                const label = option.displayName ?? domainLabel(option.domain);
                if (!label) return null;

                return (
                  <Pressable
                    key={option.domain}
                    style={({ pressed }) => [styles.optionButton, pressed && styles.optionButtonPressed]}
                    onPress={() => handleChoose(option)}
                    disabled={isSubmitting}
                    accessibilityRole="button"
                    accessibilityState={{ disabled: isSubmitting }}
                    accessibilityLabel={label}>
                    <Text style={styles.optionLabel}>{label}</Text>
                  </Pressable>
                );
              })}
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
    paddingBottom: 32,
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
  question: {
    marginTop: 18,
    fontSize: 17,
    lineHeight: 28,
    fontWeight: '600',
    color: colors.text,
  },
  guide: {
    marginTop: 8,
    fontSize: 15,
    lineHeight: 25,
    color: colors.textMuted,
  },
  input: {
    marginTop: 28,
    minHeight: 116,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: colors.inputBorder,
    backgroundColor: colors.inputBackground,
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 16,
    fontSize: 16,
    lineHeight: 25,
    color: colors.text,
  },
  inputFocused: {
    borderColor: colors.sage,
  },
  clarifyButton: {
    marginTop: 14,
    minHeight: 56,
    borderRadius: 17,
    backgroundColor: colors.sage,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
  },
  clarifyButtonLabel: {
    fontSize: 16,
    lineHeight: 24,
    fontWeight: '600',
    color: colors.inputBackground,
  },
  buttonWaiting: {
    opacity: 0.6,
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
  orGuide: {
    marginTop: 30,
    fontSize: 14,
    lineHeight: 23,
    textAlign: 'center',
    color: colors.textMuted,
  },
  // 두 후보는 우선순위를 뜻하지 않는다. 동일한 크기·색상·강조로 나란히 둔다.
  options: {
    marginTop: 16,
    gap: 14,
  },
  optionButton: {
    minHeight: 64,
    borderRadius: 18,
    backgroundColor: colors.text,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
    paddingVertical: 14,
  },
  optionButtonPressed: {
    opacity: 0.85,
  },
  optionLabel: {
    fontSize: 17,
    lineHeight: 26,
    fontWeight: '600',
    textAlign: 'center',
    color: colors.background,
  },
});
