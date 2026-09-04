import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

import { colors } from '@/constants/aroeda-theme';
import { SituationProvider } from '@/state/situation';

export default function RootLayout() {
  return (
    <SituationProvider>
      <StatusBar style="dark" />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.background },
        }}
      />
    </SituationProvider>
  );
}
