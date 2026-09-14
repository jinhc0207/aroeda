import { Stack, router, useNavigation } from 'expo-router';
import { useEffect, useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors } from '@/constants/aroeda-theme';
import {
  createSupabaseDeletionDeps,
  requestDataDeletion,
  retryLocalCleanup,
  type DeletionResult,
} from '@/lib/request-account-deletion';
import { supabase } from '@/lib/supabase';
import { useSituation } from '@/state/situation';

/**
 * 개인정보 및 내 정보
 *
 * 이 앱이 서버에 무엇을 남기는지 알려 주고, 원하면 지울 수 있게 하는 화면이다.
 *
 * 지우기 전에 반드시 한 번 더 묻는다. 묻기 전에는 서버에 아무것도 보내지 않는다.
 *
 * 삭제 작업은 이 화면이 아니라 앱 전체 상태(state/situation)에서 돈다.
 *   화면이 닫혔다 다시 열려도, 두 개가 겹쳐 열려도 삭제 요청은 하나만 나간다.
 *   화면이 사라져도 이미 시작한 작업은 끝까지 진행한다.
 *   서버 삭제가 확인됐다면 이 기기 정리도 빠뜨리지 않는다.
 *
 * 작업이 진행 중이면 이 화면을 닫지 않는다.
 *   화면 안 뒤로가기, Android 시스템 뒤로가기, 다른 곳에서 이 화면을 없애는 이동을 막는다.
 *   iOS의 뒤로 스와이프는 끈다.
 *   다만 앱을 강제로 끄거나 시스템이 앱을 종료하는 것은 막을 수 없다.
 *   서버에서 이미 시작된 처리를 취소할 수도 없다.
 *
 * 무엇이 지워지는지 사실대로만 말한다.
 *   지워지는 것: 개발자 서버의 익명 이용자 식별자와, 거기에 연결된 사용 횟수 기록.
 *   지워지지 않는 것: 누구인지 알 수 없게 모은 영역별 집계, 외부 서비스가 자체 보관하는 기록.
 * 확인하지 못한 것을 "삭제했어요"라고 말하지 않는다.
 *
 * 개인정보처리방침은 아래 PRIVACY_POLICY_URL(공개된 게시 주소, 편집 주소가 아니다)에 연결돼 있다.
 * 가짜 주소나 눌러도 아무 일이 없는 링크를 만들지 않는다.
 *
 * 사용자 번호, 토큰, 원본 오류는 화면에도 로그에도 내지 않는다.
 */

type ResultAction = 'retry-deletion' | 'retry-cleanup' | 'go-back';

/** 공개된 개인정보처리방침 페이지. 편집 주소(/edit)가 아닌 게시 주소만 둔다. */
export const PRIVACY_POLICY_URL = 'https://sites.google.com/view/aroeda/%ED%99%88';

/** 결과마다 보여 줄 말. 사실만 적는다. */
const RESULT_COPY: Record<DeletionResult, { title: string; body: string | null; action: ResultAction }> = {
  deleted: {
    title: '삭제했어요.',
    body:
      '개발자 서버에 있던 익명 이용자 식별자와, 그 식별자에 연결된 사용 횟수 기록을 삭제했어요. ' +
      '이 기기의 로그인 정보도 정리했어요. 다음에 말씀을 찾으면 새 익명 이용자 식별자가 만들어져요.',
    action: 'go-back',
  },
  'deleted-local-cleanup-failed': {
    title: '서버 기록은 삭제했어요.',
    body:
      '개발자 서버에 있던 익명 이용자 식별자와 사용 횟수 기록은 삭제했어요. ' +
      '다만 이 기기에 남은 로그인 정보를 정리하지 못했어요. 서버에 다시 요청하지 않고 이 기기만 다시 정리할 수 있어요.',
    action: 'retry-cleanup',
  },
  unconfirmed: {
    title: '삭제 여부를 확인하지 못했어요. 잠시 후 다시 시도해 주세요.',
    body: null,
    action: 'retry-deletion',
  },
  'no-local-session': {
    title: '이 기기에서 삭제할 서버 기록을 확인할 수 없어요.',
    body:
      '이 기기에 익명 이용자 식별자가 저장되어 있지 않아서, 서버에서 어떤 기록을 삭제해야 하는지 알 수 없어요.',
    action: 'go-back',
  },
  'local-session-unreadable': {
    title: '이 기기의 로그인 정보를 확인하지 못했어요. 잠시 후 다시 시도해 주세요.',
    body: '아직 서버에 삭제를 요청하지 않았어요.',
    action: 'retry-deletion',
  },
  'not-anonymous': {
    title: '익명 이용자로 확인되지 않아 삭제하지 않았어요.',
    body: '이 화면에서는 로그인 없이 쓰는 익명 이용자의 기록만 삭제해요.',
    action: 'go-back',
  },
};

const WORKING_LABEL = {
  deleting: '삭제하고 있어요',
  cleaning: '이 기기를 정리하고 있어요',
} as const;

type ViewState =
  | { step: 'idle' }
  | { step: 'confirm' }
  | { step: 'working'; label: string }
  | { step: 'result'; result: DeletionResult };

export default function SettingsScreen() {
  const {
    clearAfterDataDeletion,
    isRecommending,
    deletionTask,
    deletionOutcome,
    runDeletionTask,
    acknowledgeDeletionOutcome,
  } = useSituation();
  const navigation = useNavigation();

  // 확인 단계를 보여 줄지는 이 화면만의 일이다. 작업의 진행과 결과는 앱 전체 상태에 있다.
  const [confirming, setConfirming] = useState(false);

  const busy = deletionTask !== 'idle';

  /*
   * 작업 중에는 이 화면이 없어지지 않게 한다.
   * 화면을 없애는 모든 이동(뒤로가기, Android 시스템 뒤로가기, 교체·초기화)은
   * 먼저 beforeRemove를 거친다. 여기서 막으면 그 이동은 일어나지 않는다.
   */
  useEffect(() => {
    if (!busy) return;
    return navigation.addListener('beforeRemove', (event) => {
      event.preventDefault();
    });
  }, [navigation, busy]);

  /*
   * 화면을 떠날 때, 확인한 결과는 비운다.
   * 다만 서버 삭제 뒤 이 기기 정리가 남은 결과는 남겨 둔다. 다시 들어와 정리할 수 있게.
   */
  useEffect(
    () => () => acknowledgeDeletionOutcome({ keepPendingCleanup: true }),
    [acknowledgeDeletionOutcome],
  );

  const makeDeps = () => createSupabaseDeletionDeps(supabase, clearAfterDataDeletion);

  const openPrivacyPolicy = () => {
    void Linking.openURL(PRIVACY_POLICY_URL).catch(() => {
      // 페이지를 열지 못해도 개인정보 화면 자체는 계속 사용할 수 있다.
    });
  };

  const handleBack = () => {
    if (router.canGoBack()) {
      router.back();
      return;
    }
    router.replace('/');
  };

  /** 잠금은 앱 전체에 있다. 이미 진행 중이면 여기서 새 요청이 나가지 않는다. */
  const confirmDeletion = () => {
    setConfirming(false);
    void runDeletionTask('deleting', () => requestDataDeletion(makeDeps()));
  };

  /** 서버 삭제는 이미 확인됐다. 이 기기의 정리만 다시 한다. */
  const retryCleanup = () => {
    void runDeletionTask('cleaning', () => retryLocalCleanup(makeDeps()));
  };

  const view: ViewState =
    deletionTask !== 'idle'
      ? { step: 'working', label: WORKING_LABEL[deletionTask] }
      : deletionOutcome
        ? { step: 'result', result: deletionOutcome }
        : confirming
          ? { step: 'confirm' }
          : { step: 'idle' };

  const renderResultAction = (action: ResultAction) => {
    if (action === 'retry-cleanup') {
      return (
        <Pressable
          style={({ pressed }) => [styles.button, pressed && styles.pressed]}
          onPress={retryCleanup}
          accessibilityRole="button"
          accessibilityLabel="이 기기 정리 다시 시도">
          <Text style={styles.buttonLabel}>이 기기 정리 다시 시도</Text>
        </Pressable>
      );
    }

    if (action === 'retry-deletion') {
      // 다시 시도해도 확인 단계부터 다시 거친다.
      return (
        <Pressable
          style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
          onPress={() => {
            acknowledgeDeletionOutcome();
            setConfirming(true);
          }}
          accessibilityRole="button"
          accessibilityLabel="다시 시도">
          <Text style={styles.secondaryButtonLabel}>다시 시도</Text>
        </Pressable>
      );
    }

    return (
      <Pressable
        style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
        onPress={() => {
          acknowledgeDeletionOutcome();
          handleBack();
        }}
        accessibilityRole="button"
        accessibilityLabel="처음으로 돌아가기">
        <Text style={styles.secondaryButtonLabel}>처음으로 돌아가기</Text>
      </Pressable>
    );
  };

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'bottom']}>
      {/* 작업 중에는 iOS의 뒤로 스와이프를 끈다. */}
      <Stack.Screen options={{ gestureEnabled: !busy }} />
      <ScrollView
        style={styles.flex}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}>
        <View style={styles.content}>
          <View style={styles.topBar}>
            <Pressable
              style={({ pressed }) => [styles.backButton, pressed && styles.pressed]}
              onPress={handleBack}
              disabled={busy}
              accessibilityRole="button"
              accessibilityState={{ disabled: busy }}
              accessibilityLabel="뒤로 가기"
              hitSlop={12}>
              <Text style={styles.backLabel}>←</Text>
            </Pressable>
            <Text style={styles.brand}>아뢰다</Text>
          </View>

          <View style={styles.section}>
            <Text style={styles.title}>개인정보 및 내 정보</Text>
            <Text style={styles.body}>
              아뢰다는 로그인 없이 쓰는 앱이에요. 처음 말씀을 찾을 때 익명 이용자 식별자가 하나
              만들어지고, 개발자 서버에는 그 식별자와 연결된 사용 횟수 기록이 남아요.
            </Text>
            <Text style={styles.body}>
              적으신 상황 문장과 기도는 개발자 서버의 저장소에 남기지 않아요.
            </Text>
            <Pressable
              style={({ pressed }) => [styles.policyLink, pressed && styles.pressed]}
              onPress={openPrivacyPolicy}
              accessibilityRole="link"
              accessibilityLabel="개인정보처리방침 읽기">
              <Text style={styles.policyLinkLabel}>개인정보처리방침</Text>
            </Pressable>
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>내 정보 삭제</Text>
            <Text style={styles.body}>
              삭제하면 개발자 서버에 있는 익명 이용자 식별자와, 그 식별자에 연결된 사용 횟수 기록이
              삭제돼요.
            </Text>
            <Text style={styles.note}>
              누구인지 알 수 없게 모은 영역별 집계와, 외부 서비스가 자체 정책에 따라 보관하는 기록은
              이 삭제에 포함되지 않아요.
            </Text>
          </View>

          <View style={styles.actions}>
            {view.step === 'idle' ? (
              <>
                <Pressable
                  style={({ pressed }) => [
                    styles.secondaryButton,
                    pressed && styles.pressed,
                    isRecommending && styles.waiting,
                  ]}
                  onPress={() => setConfirming(true)}
                  disabled={isRecommending}
                  accessibilityRole="button"
                  accessibilityState={{ disabled: isRecommending }}
                  accessibilityLabel="내 정보 삭제하기">
                  <Text style={styles.secondaryButtonLabel}>내 정보 삭제하기</Text>
                </Pressable>
                {isRecommending ? (
                  <Text style={styles.note}>말씀을 찾는 중에는 삭제를 시작할 수 없어요.</Text>
                ) : null}
              </>
            ) : null}

            {view.step === 'confirm' ? (
              <View style={styles.panel}>
                <Text style={styles.panelTitle}>정말 삭제할까요?</Text>
                <Text style={styles.body}>
                  개발자 서버에 있는 익명 이용자 식별자와 사용 횟수 기록을 삭제해요. 삭제한 뒤에는
                  되돌릴 수 없어요.
                </Text>
                <Pressable
                  style={({ pressed }) => [styles.button, pressed && styles.pressed]}
                  onPress={confirmDeletion}
                  accessibilityRole="button"
                  accessibilityLabel="삭제하기">
                  <Text style={styles.buttonLabel}>삭제하기</Text>
                </Pressable>
                <Pressable
                  style={({ pressed }) => [styles.quietButton, pressed && styles.pressed]}
                  onPress={() => setConfirming(false)}
                  accessibilityRole="button"
                  accessibilityLabel="취소">
                  <Text style={styles.quietButtonLabel}>취소</Text>
                </Pressable>
              </View>
            ) : null}

            {view.step === 'working' ? (
              <View
                style={[styles.button, styles.waiting]}
                accessibilityRole="button"
                accessibilityState={{ disabled: true, busy: true }}
                accessibilityLabel={view.label}>
                <Text style={styles.buttonLabel}>{view.label}</Text>
              </View>
            ) : null}

            {view.step === 'result' ? (
              <View style={styles.panel}>
                <Text style={styles.panelTitle}>{RESULT_COPY[view.result].title}</Text>
                {RESULT_COPY[view.result].body ? (
                  <Text style={styles.body}>{RESULT_COPY[view.result].body}</Text>
                ) : null}
                {renderResultAction(RESULT_COPY[view.result].action)}
              </View>
            ) : null}
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
  waiting: {
    opacity: 0.6,
  },
  section: {
    marginTop: 36,
    gap: 14,
  },
  title: {
    fontSize: 24,
    lineHeight: 36,
    fontWeight: '600',
    color: colors.text,
  },
  sectionTitle: {
    fontSize: 17,
    lineHeight: 26,
    fontWeight: '600',
    color: colors.sage,
  },
  body: {
    fontSize: 15,
    lineHeight: 27,
    color: colors.text,
  },
  note: {
    fontSize: 13,
    lineHeight: 21,
    color: colors.textMuted,
  },
  policyLink: {
    alignSelf: 'flex-start',
    minHeight: 36,
    justifyContent: 'center',
  },
  policyLinkLabel: {
    fontSize: 14,
    lineHeight: 22,
    textDecorationLine: 'underline',
    color: colors.sage,
  },
  actions: {
    marginTop: 'auto',
    paddingTop: 40,
    gap: 14,
  },
  panel: {
    gap: 14,
    borderRadius: 18,
    padding: 18,
    backgroundColor: colors.noticeBackground,
  },
  panelTitle: {
    fontSize: 16,
    lineHeight: 25,
    fontWeight: '600',
    color: colors.text,
  },
  button: {
    minHeight: 56,
    borderRadius: 18,
    backgroundColor: colors.text,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
  },
  buttonLabel: {
    fontSize: 16,
    lineHeight: 24,
    fontWeight: '600',
    color: colors.background,
  },
  secondaryButton: {
    minHeight: 56,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: colors.inputBorder,
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
  quietButton: {
    minHeight: 48,
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
});
