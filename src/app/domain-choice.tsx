import { router, useFocusEffect } from 'expo-router';
import { useCallback, useRef } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors } from '@/constants/aroeda-theme';
import { domainLabel } from '@/data/domain-labels';
import type { DomainChoiceOption } from '@/lib/request-recommendation';
import { useSituation } from '@/state/situation';

/**
 * 영역 선택 화면
 *
 * Recommendation Gate의 route가 domain_choice일 때만 연다.
 * 첫 화면이 사용자 문장 하나로 이미 두 후보 각각의 결과(domainChoiceOptions)를 받아 왔으므로,
 * 여기서는 그 결과를 보여주고 고르게 할 뿐 서버를 다시 부르지 않는다. 분석도 새로 하지 않는다.
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
  const { domainChoiceOptions, applyDomainChoiceOption } = useSituation();
  const didChooseRef = useRef(false);

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

  const handleChoose = (option: DomainChoiceOption) => {
    // 이미 이번 포커스에서 선택이 시작됐으면(연속 탭 등) 다시 실행하지 않는다.
    if (didChooseRef.current) return;
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

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'bottom']}>
      <ScrollView
        style={styles.flex}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}>
        <View style={styles.content}>
          <Text style={styles.brand}>아뢰다</Text>

          <View style={styles.headingBlock}>
            <Text style={styles.heading}>어느 쪽부터 말씀을 볼까요?</Text>
            <Text style={styles.guide}>
              두 상황이 함께 보여요. 지금 먼저 말씀으로 살펴보고 싶은 쪽을 골라주세요.
            </Text>
          </View>

          <View style={styles.options}>
            {domainChoiceOptions.map((option) => {
              const label = domainLabel(option.domain);
              if (!label) return null;

              return (
                <Pressable
                  key={option.domain}
                  style={({ pressed }) => [styles.optionButton, pressed && styles.optionButtonPressed]}
                  onPress={() => handleChoose(option)}
                  accessibilityRole="button"
                  accessibilityLabel={label}>
                  <Text style={styles.optionLabel}>{label}</Text>
                </Pressable>
              );
            })}
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
  // 두 후보는 우선순위를 뜻하지 않는다. 동일한 크기·색상·강조로 나란히 둔다.
  options: {
    marginTop: 40,
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
