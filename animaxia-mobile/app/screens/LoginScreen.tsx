/**
 * screens/LoginScreen.tsx — Sign in / create account / reset password (modal).
 *
 * One modal route, three views toggled by internal `mode` state (login ·
 * register · forgot) — Login is a single React Navigation route, so the
 * register and forgot-password flows live inside this file instead of being
 * separate screens:
 *
 *   login     email + password                     → POST /api/auth/login
 *   register  email + username + password          → POST /api/auth/register
 *   forgot    two-step reset (Phase 6):
 *             1. email → POST /api/auth/forgot-password (6-digit code)
 *             2. code + new password → POST /api/auth/reset-password
 *             In sandbox mode (no SMTP) the code comes back in the response
 *             and is auto-filled so the flow is completable end-to-end.
 *
 * Client-side validation mirrors the server rules via auth/validators
 * (email shape · username 3–24 [a-zA-Z0-9._-] · password ≥ 8 · 6-digit code).
 * Successful login/register persists the session (api/auth) and dismisses the
 * modal; reset success bounces back to the login view after ~1.5s.
 */

import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, radii, spacing, typography } from '../utils/theme';
import { useAuth } from '../hooks/useAuth';
import { errorMessage, isApiError } from '../api/client';
import { forgotPassword, resetPassword } from '../api/auth';
import {
  validateEmail,
  validatePassword,
  validateResetCode,
  validateUsername,
} from '../auth/validators';
import { goBackOrHome } from '../navigation/helpers';

type Mode = 'login' | 'register' | 'forgot';

/* ------------------------------ login / register ----------------------------- */

function AuthFormView({
  mode,
  email,
  onEmailChange,
  onSwitchMode,
}: {
  mode: 'login' | 'register';
  email: string;
  onEmailChange: (value: string) => void;
  onSwitchMode: (mode: Mode) => void;
}): React.JSX.Element {
  const { login, register } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const valid =
    validateEmail(email) === null &&
    validatePassword(password) === null &&
    (mode === 'login' || validateUsername(username) === null);

  const submit = async () => {
    if (busy) return;
    const emailError = validateEmail(email);
    if (emailError) {
      setError(emailError);
      return;
    }
    const passwordError = validatePassword(password);
    if (passwordError) {
      setError(passwordError);
      return;
    }
    if (mode === 'register') {
      const usernameError = validateUsername(username);
      if (usernameError) {
        setError(usernameError);
        return;
      }
    }
    setBusy(true);
    setError(null);
    try {
      if (mode === 'login') await login(email.trim(), password);
      else await register(email.trim(), username.trim(), password);
      goBackOrHome(); // session persisted — dismiss the modal
    } catch (err) {
      setError(isApiError(err) ? err.message : errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
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
          onChangeText={onEmailChange}
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

        {mode === 'login' ? (
          <Pressable
            accessibilityRole="link"
            accessibilityLabel="Forgot password"
            style={styles.forgotLink}
            onPress={() => onSwitchMode('forgot')}
          >
            <Text style={styles.forgotText}>Forgot password?</Text>
          </Pressable>
        ) : null}

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
          {busy ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Text style={styles.submitText}>{mode === 'login' ? 'Sign in' : 'Create account'}</Text>
          )}
        </Pressable>

        <Pressable
          accessibilityRole="link"
          accessibilityLabel={mode === 'login' ? 'Switch to create account' : 'Switch to sign in'}
          style={styles.switchRow}
          onPress={() => {
            setError(null);
            onSwitchMode(mode === 'login' ? 'register' : 'login');
          }}
        >
          <Text style={styles.switchText}>
            {mode === 'login' ? "Don't have an account? " : 'Already a member? '}
            <Text style={styles.switchAction}>{mode === 'login' ? 'Create one' : 'Sign in'}</Text>
          </Text>
        </Pressable>
      </View>
    </>
  );
}

/* ------------------------------ forgot password ------------------------------ */

function ForgotPasswordView({
  email,
  onEmailChange,
  onBack,
}: {
  email: string;
  onEmailChange: (value: string) => void;
  onBack: () => void;
}): React.JSX.Element {
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [code, setCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const returnTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* Auto-return to the login view after a successful reset. */
  useEffect(() => {
    return () => {
      if (returnTimer.current) clearTimeout(returnTimer.current);
    };
  }, []);

  const stepEmailValid = validateEmail(email) === null;
  const stepCodeValid =
    validateResetCode(code) === null &&
    validatePassword(newPassword) === null &&
    confirmPassword.length > 0 &&
    newPassword === confirmPassword;

  const requestCode = async () => {
    if (busy) return;
    const emailError = validateEmail(email);
    if (emailError) {
      setError(emailError);
      return;
    }
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      const res = await forgotPassword(email.trim());
      if (res.sandbox && res.code) {
        setInfo(
          `Sandbox mode — your reset code: ${res.code} (valid ${res.codeExpiresInMin ?? 30} min)`,
        );
        setCode(res.code); // auto-fill: no SMTP server is configured
      } else {
        setInfo('If an account exists, a reset code was sent to your email.');
      }
      setStep('code');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const submitReset = async () => {
    if (busy) return;
    const codeError = validateResetCode(code);
    if (codeError) {
      setError(codeError);
      return;
    }
    const passwordError = validatePassword(newPassword);
    if (passwordError) {
      setError(passwordError);
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("Passwords don't match");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await resetPassword(email.trim(), code.trim(), newPassword);
      setDone(true);
      returnTimer.current = setTimeout(() => onBack(), 1500);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <View style={styles.successWrap}>
        <View style={styles.successBadge}>
          <Ionicons name="checkmark" size={26} color={colors.emerald} />
        </View>
        <Text style={styles.title}>All set</Text>
        <View style={styles.successBox}>
          <Ionicons name="checkmark-circle" size={14} color={colors.emerald} />
          <Text style={styles.successText}>
            Password updated — sign in with your new password
          </Text>
        </View>
      </View>
    );
  }

  return (
    <>
      <View style={styles.logoBadge}>
        <Ionicons name="key-outline" size={24} color="#fff" />
      </View>
      <Text style={styles.title}>
        {step === 'email' ? 'Reset your password' : 'Enter your code'}
      </Text>
      <Text style={styles.subtitle}>
        {step === 'email'
          ? "Enter your email and we'll send you a 6-digit reset code."
          : `We sent a code to ${email.trim()}.`}
      </Text>

      <View style={styles.form}>
        {step === 'email' ? (
          <>
            <Text style={styles.label}>Email</Text>
            <TextInput
              style={styles.input}
              value={email}
              onChangeText={onEmailChange}
              placeholder="you@animaxia.test"
              placeholderTextColor={colors.textDim}
              autoCapitalize="none"
              autoComplete="email"
              keyboardType="email-address"
              accessibilityLabel="Email"
            />

            {info ? (
              <View style={styles.infoBox}>
                <Ionicons name="information-circle-outline" size={14} color={colors.emerald} />
                <Text style={styles.infoText}>{info}</Text>
              </View>
            ) : null}
            {error ? (
              <View style={styles.errorBox}>
                <Ionicons name="alert-circle-outline" size={14} color={colors.red} />
                <Text style={styles.errorText}>{error}</Text>
              </View>
            ) : null}

            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Send reset code"
              style={[styles.submit, (!stepEmailValid || busy) && styles.submitDisabled]}
              disabled={!stepEmailValid || busy}
              onPress={requestCode}
            >
              {busy ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Text style={styles.submitText}>Send reset code</Text>
              )}
            </Pressable>
          </>
        ) : (
          <>
            {info ? (
              <View style={styles.infoBox}>
                <Ionicons name="information-circle-outline" size={14} color={colors.emerald} />
                <Text style={styles.infoText}>{info}</Text>
              </View>
            ) : null}

            <Text style={styles.label}>Reset code</Text>
            <TextInput
              style={styles.input}
              value={code}
              onChangeText={(text) => setCode(text.replace(/\D/g, '').slice(0, 6))}
              placeholder="123456"
              placeholderTextColor={colors.textDim}
              autoCapitalize="none"
              keyboardType="number-pad"
              maxLength={6}
              accessibilityLabel="Reset code"
            />

            <Text style={styles.label}>New password</Text>
            <TextInput
              style={styles.input}
              value={newPassword}
              onChangeText={setNewPassword}
              placeholder="At least 8 characters"
              placeholderTextColor={colors.textDim}
              secureTextEntry
              accessibilityLabel="New password"
            />

            <Text style={styles.label}>Confirm password</Text>
            <TextInput
              style={styles.input}
              value={confirmPassword}
              onChangeText={setConfirmPassword}
              placeholder="••••••••"
              placeholderTextColor={colors.textDim}
              secureTextEntry
              accessibilityLabel="Confirm password"
            />

            {error ? (
              <View style={styles.errorBox}>
                <Ionicons name="alert-circle-outline" size={14} color={colors.red} />
                <Text style={styles.errorText}>{error}</Text>
              </View>
            ) : null}

            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Update password"
              style={[styles.submit, (!stepCodeValid || busy) && styles.submitDisabled]}
              disabled={!stepCodeValid || busy}
              onPress={submitReset}
            >
              {busy ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Text style={styles.submitText}>Update password</Text>
              )}
            </Pressable>
          </>
        )}

        <Pressable
          accessibilityRole="link"
          accessibilityLabel="Back to sign in"
          style={styles.switchRow}
          onPress={onBack}
        >
          <Text style={styles.switchText}>
            <Text style={styles.switchAction}>Back to sign in</Text>
          </Text>
        </Pressable>
      </View>
    </>
  );
}

/* ---------------------------------- screen ---------------------------------- */

export default function LoginScreen(): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const [mode, setMode] = useState<Mode>('login');
  /** Shared between the auth form and the reset flow (forgot pre-fills email). */
  const [email, setEmail] = useState('');

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
          onPress={goBackOrHome}
        >
          <Ionicons name="close" size={20} color={colors.textMuted} />
        </Pressable>

        {mode === 'forgot' ? (
          <ForgotPasswordView email={email} onEmailChange={setEmail} onBack={() => setMode('login')} />
        ) : (
          <AuthFormView
            mode={mode === 'login' ? 'login' : 'register'}
            email={email}
            onEmailChange={setEmail}
            onSwitchMode={setMode}
          />
        )}
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
  forgotLink: { alignSelf: 'flex-end', paddingVertical: spacing.xs, marginTop: spacing.xs },
  forgotText: { color: colors.roseSoft, fontSize: typography.tiny, fontWeight: '700' },
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
  infoBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'rgba(52,211,153,0.1)',
    borderWidth: 1,
    borderColor: 'rgba(52,211,153,0.3)',
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    marginTop: spacing.sm,
  },
  infoText: { flex: 1, color: colors.emerald, fontSize: typography.tiny },
  successWrap: { alignItems: 'center', gap: spacing.md, paddingTop: spacing.xxl },
  successBadge: {
    width: 56,
    height: 56,
    borderRadius: 18,
    backgroundColor: 'rgba(52,211,153,0.15)',
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'center',
    marginTop: spacing.xl,
  },
  successBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'rgba(52,211,153,0.1)',
    borderWidth: 1,
    borderColor: 'rgba(52,211,153,0.3)',
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    marginTop: spacing.sm,
    alignSelf: 'stretch',
  },
  successText: { flex: 1, color: colors.emerald, fontSize: typography.small, fontWeight: '600' },
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
