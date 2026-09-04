import { router } from 'expo-router';
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors } from '@/constants/aroeda-theme';
import { SAFETY_CONTACTS, SAFETY_CONTACTS_REGION } from '@/constants/safety-contacts';

/**
 * Recommendation Gate의 route가 safety일 때 보여줄 화면.
 *
 * 이 화면은 상담이나 진단을 하지 않는다.
 * 말씀 추천보다 현실의 안전을 먼저 안내하는 것이 전부다.
 *
 * 이번 단계에서는 caution과 urgent를 나누지 않고 공통 기본 화면만 둔다.
 * 서버가 안전의 종류를 화면까지 보내지 않으므로, 어느 상황에서도 쓸 수 있게 네 곳을 함께 보여준다.
 * 성경구절, 기도문, 하나님의 뜻 해석, 용서와 인내 권면은 넣지 않는다.
 *
 * 전화는 사용자가 눌렀을 때만 연다. 화면에 들어왔다고 저절로 걸지 않는다.
 * 연결이 안 되더라도 번호가 화면에 그대로 남아 있어 직접 걸 수 있다.
 *
 * 경고색이나 경고 아이콘을 쓰지 않는다. 다만 내용의 중요성이 흐려지지 않게 한다.
 */
export default function SafetyScreen() {
  /**
   * 전화 앱을 연다.
   *
   * 사용자가 누른 뒤에만 불린다.
   * 열지 못해도 앱이 멈추지 않는다. 번호는 화면에 남아 있다.
   */
  const callNumber = (dial: string) => {
    void Linking.openURL(`tel:${dial}`).catch(() => {
      // 원본 오류는 남기지 않는다. 사용자는 화면의 번호를 보고 직접 걸 수 있다.
    });
  };

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
            <Text style={styles.title}>지금은 당신의 안전이 먼저예요</Text>

            <Text style={styles.body}>
              지금 나누어주신 이야기는 말씀을 추천하는 것보다 당신의 안전을 먼저 살펴야 하는 상황일
              수 있어요.
            </Text>
            <Text style={styles.body}>
              가능하다면 지금 혼자 감당하지 말고, 신뢰할 수 있는 사람이나 가까운 전문적인 도움에 현재
              상황을 알려주세요.
            </Text>

            <View style={styles.highlight}>
              <Text style={styles.highlightText}>
                지금 당장 자신이나 다른 사람이 다칠 위험이 있거나 긴급한 의료 도움이 필요하다면,
                말씀이나 기도보다 먼저 현실의 도움을 요청해 주세요.
              </Text>
            </View>
          </View>

          <View style={styles.contactsBlock}>
            <Text style={styles.contactsTitle}>도움을 받을 수 있는 곳</Text>
            <Text style={styles.contactsRegion}>{SAFETY_CONTACTS_REGION}</Text>

            <View style={styles.contacts}>
              {SAFETY_CONTACTS.map((contact) => (
                <Pressable
                  key={contact.dial}
                  style={({ pressed }) => [styles.contact, pressed && styles.buttonPressed]}
                  onPress={() => callNumber(contact.dial)}
                  accessibilityRole="button"
                  accessibilityLabel={`${contact.label} ${contact.display}에 전화하기`}
                  accessibilityHint={contact.purpose}>
                  <View style={styles.contactHeader}>
                    <Text style={styles.contactLabel}>{contact.label}</Text>
                    <Text style={styles.contactNumber}>{contact.display}</Text>
                  </View>
                  <Text style={styles.contactPurpose}>
                    {contact.purpose}
                    {contact.note ? ` · ${contact.note}` : ''}
                  </Text>
                </Pressable>
              ))}
            </View>

            <Text style={styles.contactsFoot}>
              가능하다면 지금 상황을 믿을 수 있는 사람에게 알려주세요.
            </Text>
          </View>

          <View style={styles.actions}>
            <Pressable
              style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
              onPress={handleBack}
              accessibilityRole="button"
              accessibilityLabel="처음으로 돌아가기">
              <Text style={styles.buttonLabel}>처음으로 돌아가기</Text>
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
  // 경고색 대신 따뜻한 모래빛으로 한 문단만 조용히 강조한다.
  highlight: {
    marginTop: 28,
    borderRadius: 20,
    backgroundColor: colors.passageBackground,
    paddingHorizontal: 20,
    paddingVertical: 22,
  },
  highlightText: {
    fontSize: 16,
    lineHeight: 30,
    color: colors.text,
  },
  contactsBlock: {
    marginTop: 44,
  },
  contactsTitle: {
    fontSize: 17,
    lineHeight: 26,
    fontWeight: '600',
    color: colors.text,
  },
  contactsRegion: {
    marginTop: 6,
    fontSize: 13,
    lineHeight: 21,
    color: colors.textSubtle,
  },
  contacts: {
    marginTop: 18,
    gap: 12,
  },
  contact: {
    minHeight: 72,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: colors.inputBorder,
    backgroundColor: colors.inputBackground,
    paddingHorizontal: 18,
    paddingVertical: 16,
    justifyContent: 'center',
  },
  contactHeader: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 10,
  },
  contactLabel: {
    fontSize: 16,
    lineHeight: 24,
    fontWeight: '600',
    color: colors.text,
  },
  contactNumber: {
    fontSize: 18,
    lineHeight: 26,
    fontWeight: '700',
    color: colors.sage,
  },
  contactPurpose: {
    marginTop: 6,
    fontSize: 14,
    lineHeight: 22,
    color: colors.textMuted,
  },
  contactsFoot: {
    marginTop: 20,
    fontSize: 14,
    lineHeight: 24,
    color: colors.textMuted,
  },
  actions: {
    marginTop: 'auto',
    paddingTop: 40,
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
