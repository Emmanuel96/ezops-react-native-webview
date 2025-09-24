import { Slot, Stack } from 'expo-router';
import React from 'react';

export default function Layout() {
  // Use a Stack wrapper and disable the header so "(tabs)" won't appear.
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Slot />
    </Stack>
  );
}
