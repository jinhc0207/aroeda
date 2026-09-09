import { router } from 'expo-router';
import { useMemo } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors } from '@/constants/aroeda-theme';
import { getPassage, TRANSLATION_NAME, type BibleVerse } from '@/data/bible';
import { getCardPassages, getScriptureCard } from '@/data/scripture-cards';
import { useSituation } from '@/state/situation';

type DisplayVerse = BibleVerse & { chapter: number };

export default function ScriptureScreen() {
  // 사용자가 입력한 상황은 화면에 다시 보여주지 않고 상태로만 유지합니다.
  // 보여줄 카드는 서버(Recommendation Gate)가 고른 것만 씁니다.
  const { selectedCardId } = useSituation();

  // 추천이 없거나 모르는 카드 id면 다른 말씀으로 대체하지 않습니다. (SC-001 같은 기본값 금지)
  const card = useMemo(() => {
    if (!selectedCardId) return null;
    try {
      return getScriptureCard(selectedCardId);
    } catch {
      return null;
    }
  }, [selectedCardId]);

  // 본문은 서버나 AI가 아니라 로컬 카드 위치 → 개역한글 성경 데이터에서 가져옵니다.
  const verses = useMemo<DisplayVerse[] | null>(() => {
    if (!card) return null;
    try {
      return getCardPassages(card).flatMap((passage) =>
        getPassage(passage).map((verse) => ({ ...verse, chapter: passage.chapter })),
      );
    } catch {
      return null;
    }
  }, [card]);

  const handleBack = () => {
    if (router.canGoBack()) {
      router.back();
      return;
    }
    router.replace('/');
  };

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
                onPress={handleBack}
                accessibilityRole="button"
                accessibilityLabel="뒤로 가기"
                hitSlop={12}>
                <Text style={styles.backLabel}>←</Text>
              </Pressable>
              <Text style={styles.brand}>아뢰다</Text>
            </View>

            <View style={styles.section}>
              <Text style={styles.emptyTitle}>추천된 말씀이 없습니다.</Text>
              <Text style={styles.emptyBody}>다시 상황을 이야기해주세요.</Text>
            </View>

            <View style={styles.emptyActions}>
              <Pressable
                style={({ pressed }) => [styles.button, pressed && styles.pressed]}
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
              onPress={handleBack}
              accessibilityRole="button"
              accessibilityLabel="뒤로 가기"
              hitSlop={12}>
              <Text style={styles.backLabel}>←</Text>
            </Pressable>
            <Text style={styles.brand}>아뢰다</Text>
          </View>

          <View style={styles.section}>
            <Text style={styles.eyebrow}>오늘 함께 붙들 말씀</Text>
            <Text style={styles.reference}>{card.referenceLabel}</Text>

            <View style={styles.passage}>
              {verses ? (
                verses.map((verse) => (
                  <Text key={`${verse.chapter}:${verse.verse}`} style={styles.verse}>
                    <Text style={styles.verseNumber}>{verse.verse} </Text>
                    {verse.text}
                  </Text>
                ))
              ) : (
                <Text style={styles.passageFallback}>말씀을 불러오지 못했어요.</Text>
              )}
            </View>

            <Text style={styles.translation}>{TRANSLATION_NAME}</Text>
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>이 말씀이 보여주는 것</Text>
            <Text style={styles.body}>{card.userExplanation}</Text>
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>이제 이렇게 바라볼 수 있어요</Text>
            <Text style={styles.body}>{card.prayerDirection}</Text>
          </View>

          <View style={styles.closing}>
            <Text style={styles.closingLead}>원한다면, 이 말씀을 기도로 이어가 보세요.</Text>

            <Text style={styles.closingSub}>
              지금 마음에 남는 말씀과, 하나님께 아뢰고 싶은 것을 있는 그대로 말씀드려 보세요.
            </Text>

            <Pressable
              style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
              onPress={() => router.push({ pathname: '/prayer', params: { mode: 'guided' } })}
              accessibilityRole="button"
              accessibilityLabel="이 말씀으로 기도해보기">
              <Text style={styles.secondaryButtonLabel}>이 말씀으로 기도해보기</Text>
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
  eyebrow: {
    fontSize: 14,
    lineHeight: 20,
    color: colors.textMuted,
  },
  reference: {
    marginTop: 10,
    fontSize: 28,
    lineHeight: 38,
    fontWeight: '600',
    color: colors.text,
  },
  passage: {
    marginTop: 24,
    gap: 14,
  },
  verse: {
    fontSize: 17,
    lineHeight: 32,
    color: colors.text,
  },
  verseNumber: {
    fontSize: 13,
    lineHeight: 32,
    fontWeight: '600',
    color: colors.sage,
  },
  passageFallback: {
    fontSize: 15,
    lineHeight: 26,
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
  translation: {
    marginTop: 20,
    fontSize: 12,
    lineHeight: 20,
    color: colors.textSubtle,
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
  closing: {
    marginTop: 56,
    paddingTop: 32,
    borderTopWidth: 1,
    borderTopColor: colors.hairline,
  },
  closingLead: {
    fontSize: 16,
    lineHeight: 26,
    color: colors.text,
  },
  closingSub: {
    marginTop: 16,
    fontSize: 14,
    lineHeight: 23,
    color: colors.textMuted,
  },
  button: {
    marginTop: 28,
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
  // 기도는 말씀 경험을 마치기 위한 필수 다음 단계가 아니라 선택 사항이다.
  // 그래서 홈 화면의 필수 제출 버튼과 같은 무게(꽉 찬 배경)를 주지 않는다.
  secondaryButton: {
    marginTop: 28,
    minHeight: 56,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: colors.hairline,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
  },
  secondaryButtonLabel: {
    fontSize: 16,
    lineHeight: 24,
    fontWeight: '600',
    color: colors.text,
  },
});
