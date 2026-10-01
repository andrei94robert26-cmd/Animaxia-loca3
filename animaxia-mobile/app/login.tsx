/**
 * app/login.tsx — Sign in / create account (modal).
 *
 * POST /api/auth/login | /api/auth/register → { accessToken (15 min),
 * refreshToken (rotating, 30d), user }. The client core (api/client.ts)
 * handles silent refreshes from here on; this screen only bootstraps the
 * session. Validation mirrors the server rules (password ≥ 8, username
 * 3–24 [a-zA-Z0-9._-], email format).
 */

import React, { useState } from 'react';
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
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, radii, spacing, typography } from '../theme';
import { useAuth } from '../auth/useAuth';
import { errorMessage, isApiError } from '../api/client';

type Mode = 'login' | 'register';

export default function LoginScreen(): React.JSX.Element {
  const { login, register } = useAuth();
  const insets = useSafeAreaInsets();
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const valid =
    /.+@.+\..+/.test(email.trim()) &&
    password.length >= 8 &&
    (mode === 'login' || /^[a-zA-Z0-9._-]{3,24}$/.test(username.trim()));

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (mode === 'login') await login(email.trim(), password);
      else await register(email.trim(), username.trim(), password);
      if (router.canGoBack()) router.back();
      else router.replace('/');
    } catch (err) {
      setError(isApiError(err) ? err.message : errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.safe}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={insets.top}
    >
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close"
          style={styles.close}
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
        >
          <Ionicons name="close" size={20} color={colors.textMuted} />
        </Pressable>

        <View style={styles.logoBadge}>
          <Ionicons name="play" size={26} color="#fff" />
        </View>
        <Text style={styles.title}>{mode === 'login' ? 'Welcome back' : 'Join Animaxia'}</Text>
        <Text style={styles.subtitle}>
          {mode === 'login'
            ? 'Your watchlist, history and AI taste travel with you.'
            : 'One account — web, cloud and mobile. AI included.'}
        </Text>

        <View style={styles.form}>
          <Text style={styles.label}>Email</Text>
          <TextInput
            style={styles.input}
            value={email}
            onChangeText={setEmail}
            placeholder="you@animaxia.test"
            placeholderTextColor={colors.textDim}
            autoCapitalize="none"
            autoComplete="email"
            keyboardType="email-address"
            accessibilityLabel="Email"
          />

          {mode === 'register' ? (
            <>
              <Text style={styles.label}>Username</Text>
              <TextInput
                style={styles.input}
                value={username}
                onChangeText={setUsername}
                placeholder="otaku99"
                placeholderTextColor={colors.textDim}
                autoCapitalize="none"
                maxLength={24}
                accessibilityLabel="Username"
              />
            </>
          ) : null}

          <Text style={styles.label}>Password</Text>
          <TextInput
            style={styles.input}
            value={password}
            onChangeText={setPassword}
            placeholder={mode === 'register' ? 'At least 8 characters' : '••••••••'}
            placeholderTextColor={colors.textDim}
            secureTextEntry
            accessibilityLabel="Password"
          />

          {error ? (
            <View style={styles.errorBox}>
              <Ionicons name="alert-circle-outline" size={14} color={colors.red} />
              <Text style={styles.errorText}>{error}</Text>
            </View>
          ) : null}

          <Pressable
            accessibilityRole="button"
            accessibilityLabel={mode === 'login' ? 'Sign in' : 'Create account'}
            style={[styles.submit, (!valid || busy) && styles.submitDisabled]}
            disabled={!valid || busy}
            onPress={submit}
          >
            <Text style={styles.submitText}>{busy ? '…' : mode === 'login' ? 'Sign in' : 'Create account'}</Text>
          </Pressable>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel={mode === 'login' ? 'Switch to create account' : 'Switch to sign in'}
            style={styles.switchRow}
            onPress={() => {
              setMode(mode === 'login' ? 'register' : 'login');
              setError(null);
            }}
          >
            <Text style={styles.switchText}>
              {mode === 'login' ? "Don't have an account? " : 'Already a member? '}
              <Text style={styles.switchAction}>{mode === 'login' ? 'Create one' : 'Sign in'}</Text>
            </Text>
          </Pressable>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.xxl, gap: spacing.md },
  close: {
    alignSelf: 'flex-end',
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.card,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoBadge: {
    width: 56,
    height: 56,
    borderRadius: 18,
    backgroundColor: colors.rose,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'center',
    marginTop: spacing.xl,
  },
  title: {
    color: colors.text,
    fontSize: typography.title,
    fontWeight: '800',
    textAlign: 'center',
    marginTop: spacing.sm,
  },
  subtitle: { color: colors.textMuted, fontSize: typography.small, textAlign: 'center', marginBottom: spacing.lg },
  form: { gap: 6 },
  label: { color: colors.textMuted, fontSize: typography.tiny, fontWeight: '700', marginTop: spacing.sm },
  input: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    color: colors.text,
    fontSize: typography.body,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  errorBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'rgba(248,113,113,0.1)',
    borderWidth: 1,
    borderColor: 'rgba(248,113,113,0.3)',
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    marginTop: spacing.sm,
  },
  errorText: { flex: 1, color: colors.red, fontSize: typography.tiny },
  submit: {
    backgroundColor: colors.rose,
    borderRadius: radii.md,
    alignItems: 'center',
    paddingVertical: 14,
    marginTop: spacing.lg,
  },
  submitDisabled: { opacity: 0.45 },
  submitText: { color: '#fff', fontSize: typography.body, fontWeight: '800' },
  switchRow: { alignItems: 'center', paddingVertical: spacing.md },
  switchText: { color: colors.textMuted, fontSize: typography.small },
  switchAction: { color: colors.roseSoft, fontWeight: '700' },
});
