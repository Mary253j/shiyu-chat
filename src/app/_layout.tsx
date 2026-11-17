import React from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { AppProvider } from '../services/AppProvider';

export default function RootLayout() {
  return <AppProvider><StatusBar style="dark" /><Stack screenOptions={{ headerShown: false, animation: 'none', contentStyle: { backgroundColor: '#FAF9F6' } }} /></AppProvider>;
}
