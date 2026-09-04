import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
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
import { getScriptureCard } from '@/data/scripture-cards';
import { requestPrayerGuidance, type PrayerGuidance } from '@/lib/request-prayer-guidance';
import { supabase } from '@/lib/supabase';
import { useSituation } from '@/state/situation';

/**
 * 기도 화면
 *
 * 말씀을 읽은 다음, 사용자가 직접 하나님께 아뢰는 자리입니다.
 *
 * 두 가지로 들어옵니다.
 *   direct — 바로 기도합니다.
 *   guided — 어떻게 시작할지 막막할 때, 시작하는 말만 몇 가지 놓아 둡니다.
 *
 * 어느 쪽이든 마지막은 사용자가 자기 말로 기도하는 자리입니다.
 * 완성된 기도문을 대신 읽어 주고 끝내지 않습니다.
 *
 * 사용자가 적은 기도는 이 화면의 메모리에만 있습니다.
 * 서버로 보내지 않고, 기기에 저장하지 않고, 기록에도 남기지 않습니다.
 * 화면을 벗어나면 사라집니다. 이번 판에서 그렇게 하기로 정했습니다.
 */

/**
 * supabase.functions.invoke 결과를 단순한 모양으로 바꾼다.
 * 왜 실패했는지는 화면이 알 필요가 없다. 어느 경우든 기존 안내로 넘어간다.
 */
async function invokePrayerGuidance(body: { situation: string; cardId: string }) {
  const { data, error } = await supabase.functions.invoke('generate-prayer-guidance', { body });
  if (error) return { ok: false as const };
  return { ok: true as const, data };
}

/**
 * 기도 도움을 받아 오는 동안의 상태.
 *
 *   idle     아직 요청하지 않았다 (직접 기도하는 길)
 *   loading  기다리는 중
 *   guidance 상황에 맞는 도움을 받았다
 *   fallback 받지 못했다. 정해진 세 걸음을 그대로 쓴다
 */
type GuidanceState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'guidance'; guidance: PrayerGuidance }
  | { status: 'fallback' };

const PRAYER_MODES = ['direct', 'guided'] as const;
type PrayerMode = (typeof PRAYER_MODES)[number];

const isPrayerMode = (value: unknown): value is PrayerMode =>
  typeof value === 'string' && (PRAYER_MODES as readonly string[]).includes(value);

/**
 * 기도를 시작하는 말.
 *
 * 완성된 기도문이 아닙니다. 첫 마디만 놓아 둡니다.
 * 가운데 한 가지는 오늘 붙든 말씀에서 가져옵니다.
 */
const GUIDE_STEPS = [
  {
    title: '지금 마음을 그대로 말씀드려 보세요',
    opener: '하나님, 지금 저는…',
  },
  {
    title: '오늘 말씀에서 붙들고 싶은 것을 말해 보세요',
    /** 본문은 카드의 기도 방향을 그대로 씁니다. 여기서 새로 쓰지 않습니다. */
    opener: null,
  },
  {
    title: '맡기고 싶은 것을 말씀드려 보세요',
    opener: '주님께 맡기고 싶은 것은…',
  },
] as const;

export default function PrayerScreen() {
  const params = useLocalSearchParams<{ mode?: string }>();
  const mode: PrayerMode = isPrayerMode(params.mode) ? params.mode : 'direct';

  const { situation, selectedCardId, setSituation, setSelectedCardId } = useSituation();

  // 사용자가 적는 기도. 이 화면 안에만 있습니다.
  // 이 값은 서버로 보내지 않습니다. 보낼 자리 자체를 만들지 않았습니다.
  const [prayer, setPrayer] = useState('');
  const [isFocused, setIsFocused] = useState(false);
  const [isDone, setIsDone] = useState(false);
  const [guidanceState, setGuidanceState] = useState<GuidanceState>({ status: 'idle' });

  // 추천된 카드가 없거나 모르는 id면 다른 말씀으로 대체하지 않습니다.
  const card = useMemo(() => {
    if (!selectedCardId) return null;
    try {
      return getScriptureCard(selectedCardId);
    } catch {
      return null;
    }
  }, [selectedCardId]);

  /**
   * 기도 도움은 화면에 한 번 들어올 때 한 번만 받아 옵니다.
   *
   * 다시 그려질 때마다 또 부르지 않도록 이미 물어봤는지 기억합니다.
   * 실패해도 다시 부르지 않습니다. 정해진 세 걸음이 그대로 남아 있습니다.
   */
  const askedRef = useRef(false);

  useEffect(() => {
    // 직접 기도하는 길에서는 서버를 부르지 않습니다.
    if (mode !== 'guided') return;
    if (!card || situation.trim().length === 0) return;
    if (askedRef.current) return;

    askedRef.current = true;
    let alive = true;
    setGuidanceState({ status: 'loading' });

    void (async () => {
      const outcome = await requestPrayerGuidance(
        { situation, cardId: card.id },
        { invokePrayerGuidance },
      );

      // 답을 기다리는 동안 화면을 벗어났으면 아무것도 바꾸지 않습니다.
      if (!alive) return;

      setGuidanceState(
        outcome.status === 'guidance'
          ? { status: 'guidance', guidance: outcome.guidance }
          : { status: 'fallback' },
      );
    })();

    return () => {
      alive = false;
    };
  }, [mode, card, situation]);

  const goBack = () => {
    if (router.canGoBack()) {
      router.back();
      return;
    }
    router.replace('/');
  };

  /** 기도를 마치고 처음으로. 다음 사람이 아니라 다음 이야기를 위해 비웁니다. */
  const goHome = () => {
    setPrayer('');
    setSituation('');
    setSelectedCardId(null);
    router.replace('/');
  };

  /* 붙들 말씀이 없으면 기도 화면을 열지 않습니다. */
  if (!card) {
    return (
      <SafeAreaView style={styles.safeArea} edges={['top', 'bottom']}>
        <ScrollView
          style={styles.flex}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}>
          <View style={styles.content}>
            <View style={styles.topBar}>
              <Pressable
                style={({ pressed }) => [styles.backButton, pressed && styles.pressed]}
                onPress={goBack}
                accessibilityRole="button"
                accessibilityLabel="뒤로 가기"
                hitSlop={12}>
                <Text style={styles.backLabel}>←</Text>
              </Pressable>
              <Text style={styles.brand}>아뢰다</Text>
            </View>

            <View style={styles.section}>
              <Text style={styles.emptyTitle}>먼저 함께 붙들 말씀을 찾아볼게요.</Text>
              <Text style={styles.emptyBody}>지금의 상황을 이야기해주시면 말씀을 찾아드릴게요.</Text>
            </View>

            <View style={styles.emptyActions}>
              <Pressable
                style={({ pressed }) => [styles.button, pressed && styles.pressed]}
                onPress={() => router.replace('/')}
                accessibilityRole="button"
                accessibilityLabel="상황 이야기하러 가기">
                <Text style={styles.buttonLabel}>상황 이야기하기</Text>
              </Pressable>
            </View>
          </View>
        </ScrollView>
      </SafeAreaView>
    );
  }

  /* 기도를 마친 뒤 */
  if (isDone) {
    return (
      <SafeAreaView style={styles.safeArea} edges={['top', 'bottom']}>
        <ScrollView
          style={styles.flex}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}>
          <View style={styles.content}>
            <View style={styles.topBar}>
              <Text style={styles.brand}>아뢰다</Text>
            </View>

            <View style={styles.doneBlock}>
              <Text style={styles.doneTitle}>오늘의 기도를 마쳤어요.</Text>
              <Text style={styles.doneBody}>
                붙든 말씀을 오늘 하루 천천히 기억해 보세요.
              </Text>
              <Text style={styles.doneReference}>{card.referenceLabel}</Text>
            </View>

            <View style={styles.emptyActions}>
              <Pressable
                style={({ pressed }) => [styles.button, pressed && styles.pressed]}
                onPress={goHome}
                accessibilityRole="button"
                accessibilityLabel="처음으로 돌아가기">
                <Text style={styles.buttonLabel}>처음으로 돌아가기</Text>
              </Pressable>

              <Pressable
                style={({ pressed }) => [styles.quietButton, pressed && styles.pressed]}
                onPress={() => router.replace('/scripture')}
                accessibilityRole="button"
                accessibilityLabel="말씀 다시 보기">
                <Text style={styles.quietButtonLabel}>말씀 다시 보기</Text>
              </Pressable>
            </View>
          </View>
        </ScrollView>
      </SafeAreaView>
    );
  }

  /* 기도하는 자리 */
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
            <View style={styles.topBar}>
              <Pressable
                style={({ pressed }) => [styles.backButton, pressed && styles.pressed]}
                onPress={goBack}
                accessibilityRole="button"
                accessibilityLabel="뒤로 가기"
                hitSlop={12}>
                <Text style={styles.backLabel}>←</Text>
              </Pressable>
              <Text style={styles.brand}>아뢰다</Text>
            </View>

            <View style={styles.section}>
              <Text style={styles.title}>이 말씀으로 아뢰어 보세요</Text>
              <Text style={styles.lead}>
                잘 정리된 말이 아니어도 괜찮아요. 지금 마음에 있는 것을 그대로 말씀드려 보세요.
              </Text>
              <Text style={styles.reference}>{card.referenceLabel}</Text>
            </View>

            {mode === 'guided' ? (
              guidanceState.status === 'loading' ? (
                <View style={styles.guide}>
                  <Text style={styles.waiting}>
                    이 말씀으로 기도를 시작할 수 있도록 잠시 함께 정리하고 있어요.
                  </Text>
                </View>
              ) : guidanceState.status === 'guidance' ? (
                <View style={styles.guide}>
                  <Text style={styles.guideIntro}>{guidanceState.guidance.intro}</Text>
                  {guidanceState.guidance.steps.map((step, index) => (
                    <View key={step.kind} style={styles.guideStep}>
                      <Text style={styles.guideNumber}>{index + 1}</Text>
                      <View style={styles.guideTextBlock}>
                        <Text style={styles.guideTitle}>{step.prompt}</Text>
                        {/* 붙들 것을 아뢰는 걸음에서는 오늘 말씀의 기도 방향을 함께 둡니다. */}
                        {step.kind === 'hold' ? (
                          <Text style={styles.guideOpener}>{card.prayerDirection}</Text>
                        ) : null}
                        {step.starter ? (
                          <Text style={styles.guideStarter}>{step.starter}</Text>
                        ) : null}
                      </View>
                    </View>
                  ))}
                </View>
              ) : (
                /* 도움을 받지 못했어도 기도를 막지 않습니다. 정해진 세 걸음을 그대로 씁니다. */
                <View style={styles.guide}>
                  {GUIDE_STEPS.map((step, index) => (
                    <View key={step.title} style={styles.guideStep}>
                      <Text style={styles.guideNumber}>{index + 1}</Text>
                      <View style={styles.guideTextBlock}>
                        <Text style={styles.guideTitle}>{step.title}</Text>
                        <Text style={styles.guideOpener}>
                          {step.opener ?? card.prayerDirection}
                        </Text>
                      </View>
                    </View>
                  ))}
                </View>
              )
            ) : (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>이 말씀을 붙들고</Text>
                <Text style={styles.body}>{card.prayerDirection}</Text>
              </View>
            )}

            <View style={styles.section}>
              <TextInput
                style={[styles.input, isFocused && styles.inputFocused]}
                value={prayer}
                onChangeText={setPrayer}
                onFocus={() => setIsFocused(true)}
                onBlur={() => setIsFocused(false)}
                placeholder="지금 하나님께 아뢰고 싶은 말을 적어보세요."
                placeholderTextColor={colors.textSubtle}
                multiline
                textAlignVertical="top"
                scrollEnabled={false}
                accessibilityLabel="기도 적는 곳"
              />
              <Text style={styles.inputNote}>
                적으신 기도는 어디에도 저장되지 않고, 이 화면에서만 머물러요.
              </Text>
            </View>

            <View style={styles.actions}>
              <Pressable
                style={({ pressed }) => [styles.button, pressed && styles.pressed]}
                onPress={() => setIsDone(true)}
                accessibilityRole="button"
                accessibilityLabel="기도 마치기">
                <Text style={styles.buttonLabel}>기도 마치기</Text>
              </Pressable>
              <Text style={styles.actionsNote}>
                소리 내어 기도하셨다면 적지 않고 마쳐도 괜찮아요.
              </Text>
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
    paddingTop: 8,
    paddingBottom: 40,
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  backButton: {
    width: 40,
    height: 40,
    marginLeft: -10,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 20,
  },
  backLabel: {
    fontSize: 22,
    lineHeight: 26,
    color: colors.text,
  },
  brand: {
    fontSize: 15,
    lineHeight: 22,
    fontWeight: '600',
    letterSpacing: 1,
    color: colors.sage,
  },
  pressed: {
    opacity: 0.85,
  },
  section: {
    marginTop: 40,
  },
  title: {
    fontSize: 26,
    lineHeight: 38,
    fontWeight: '600',
    color: colors.text,
  },
  lead: {
    marginTop: 16,
    fontSize: 15,
    lineHeight: 29,
    color: colors.textMuted,
  },
  reference: {
    marginTop: 20,
    fontSize: 14,
    lineHeight: 22,
    color: colors.sage,
  },
  sectionTitle: {
    fontSize: 17,
    lineHeight: 26,
    fontWeight: '600',
    color: colors.sage,
  },
  body: {
    marginTop: 14,
    fontSize: 15,
    lineHeight: 29,
    color: colors.text,
  },
  guide: {
    marginTop: 40,
    gap: 24,
  },
  guideStep: {
    flexDirection: 'row',
    gap: 14,
  },
  guideNumber: {
    minWidth: 22,
    fontSize: 14,
    lineHeight: 24,
    fontWeight: '600',
    color: colors.sage,
  },
  guideTextBlock: {
    flex: 1,
  },
  guideIntro: {
    fontSize: 15,
    lineHeight: 27,
    color: colors.textMuted,
  },
  waiting: {
    fontSize: 15,
    lineHeight: 27,
    color: colors.textMuted,
  },
  guideTitle: {
    fontSize: 15,
    lineHeight: 24,
    fontWeight: '600',
    color: colors.text,
  },
  guideStarter: {
    marginTop: 8,
    fontSize: 15,
    lineHeight: 27,
    color: colors.sage,
  },
  guideOpener: {
    marginTop: 8,
    fontSize: 15,
    lineHeight: 27,
    color: colors.textMuted,
  },
  input: {
    minHeight: 180,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: colors.inputBorder,
    backgroundColor: colors.inputBackground,
    paddingHorizontal: 18,
    paddingVertical: 18,
    fontSize: 16,
    lineHeight: 28,
    color: colors.text,
  },
  inputFocused: {
    borderColor: colors.sage,
  },
  inputNote: {
    marginTop: 12,
    fontSize: 13,
    lineHeight: 21,
    color: colors.textSubtle,
  },
  actions: {
    marginTop: 'auto',
    paddingTop: 40,
  },
  actionsNote: {
    marginTop: 14,
    fontSize: 13,
    lineHeight: 21,
    textAlign: 'center',
    color: colors.textSubtle,
  },
  button: {
    minHeight: 58,
    borderRadius: 18,
    backgroundColor: colors.text,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
  },
  buttonLabel: {
    fontSize: 17,
    lineHeight: 24,
    fontWeight: '600',
    color: colors.background,
  },
  quietButton: {
    marginTop: 14,
    minHeight: 52,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
  },
  quietButtonLabel: {
    fontSize: 15,
    lineHeight: 24,
    fontWeight: '600',
    color: colors.textMuted,
  },
  emptyTitle: {
    fontSize: 20,
    lineHeight: 32,
    fontWeight: '600',
    color: colors.text,
  },
  emptyBody: {
    marginTop: 14,
    fontSize: 16,
    lineHeight: 28,
    color: colors.textMuted,
  },
  emptyActions: {
    marginTop: 'auto',
    paddingTop: 48,
  },
  doneBlock: {
    marginTop: 56,
  },
  doneTitle: {
    fontSize: 24,
    lineHeight: 36,
    fontWeight: '600',
    color: colors.text,
  },
  doneBody: {
    marginTop: 16,
    fontSize: 15,
    lineHeight: 29,
    color: colors.textMuted,
  },
  doneReference: {
    marginTop: 24,
    fontSize: 14,
    lineHeight: 22,
    color: colors.sage,
  },
});
