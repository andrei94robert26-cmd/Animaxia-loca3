/**
 * screens/AuthScreen.tsx — Sign in · register · forgot · reset (route /auth).
 *
 * One screen, four modes driven by the query string:
 *
 *   /auth?mode=login    (default) email + password → POST /api/auth/login
 *   /auth?mode=register          email + username + password + confirm
 *   /auth?mode=forgot            email → POST /api/auth/forgot-password
 *                                  sandbox (no SMTP): the 6-digit code comes
 *                                  back inline → success card + "Continue to
 *                                  reset"; production: "check your inbox"
 *   /auth?mode=reset&email=…&code=…   code + new password →
 *                                  POST /api/auth/reset-password
 *
 * `next` is the post-login redirect target (set by AuthGate and the Premium
 * screen); `email` + `code` prefill the reset flow — the deep link
 * animaxia://auth?mode=reset&… lands here through the Shell's
 * NavigationListener. Enter submits via native form onSubmit.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { CheckCircle2, Play } from 'lucide-react';
import { useAuth } from '@/auth/AuthContext';
import { forgotPassword, resetPassword } from '@/api/auth';
import type { ForgotPasswordResponse } from '@/api/auth';
import { errorMessage, isApiError } from '@/api/client';
import { validateEmail, validatePassword, validateResetCode, validateUsername } from '@/auth/validators';
import { Button, Input, Tabs } from '@/components/primitives';
import { LoadingState } from '@/components/states';
import styles from './AuthScreen.module.css';

type Mode = 'login' | 'register' | 'forgot' | 'reset';

const MODE_COPY: Record<Mode, { title: string; subtitle: string }> = {
  login: { title: 'Welcome back', subtitle: 'Your watchlist, history and AI taste travel with you.' },
  register: { title: 'Join Animaxia', subtitle: 'One account — web, cloud, desktop and mobile. AI included.' },
  forgot: { title: 'Reset your password', subtitle: "Enter your email and we'll send you a 6-digit reset code." },
  reset: { title: 'Set a new password', subtitle: 'Enter the 6-digit code you received and pick a new password.' },
};

/* ---------------------------------- login ----------------------------------- */

function LoginForm({
  email,
  onEmailChange,
  onForgot,
  next,
}: {
  email: string;
  onEmailChange: (value: string) => void;
  onForgot: () => void;
  next: string;
}): React.JSX.Element {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [apiError, setApiError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (busy) return;
    const nextEmailError = validateEmail(email);
    const nextPasswordError = validatePassword(password);
    setEmailError(nextEmailError);
    setPasswordError(nextPasswordError);
    setApiError(null);
    if (nextEmailError || nextPasswordError) return;
    setBusy(true);
    try {
      await login(email.trim(), password);
      navigate(next);
    } catch (err) {
      setApiError(isApiError(err) ? err.message : errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="stack" onSubmit={(event) => void submit(event)} noValidate>
      <Input
        label="Email"
        type="email"
        value={email}
        placeholder="you@animaxia.test"
        autoComplete="email"
        autoFocus
        onChange={(event) => onEmailChange(event.target.value)}
        error={emailError}
      />
      <Input
        label="Password"
        type="password"
        value={password}
        placeholder="••••••••"
        autoComplete="current-password"
        onChange={(event) => setPassword(event.target.value)}
        error={passwordError}
      />
      <div className={styles.forgotRow}>
        <button type="button" className={styles.linkButton} onClick={onForgot}>
          Forgot password?
        </button>
      </div>
      {apiError ? (
        <div className={styles.errorBox} role="alert">
          {apiError}
        </div>
      ) : null}
      <Button type="submit" full loading={busy}>
        Sign in
      </Button>
    </form>
  );
}

/* --------------------------------- register --------------------------------- */

function RegisterForm({
  email,
  onEmailChange,
  next,
}: {
  email: string;
  onEmailChange: (value: string) => void;
  next: string;
}): React.JSX.Element {
  const { register } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<{ email?: string; username?: string; password?: string; confirm?: string }>({});
  const [apiError, setApiError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (busy) return;
    const nextErrors = {
      email: validateEmail(email) ?? undefined,
      username: validateUsername(username) ?? undefined,
      password: validatePassword(password) ?? undefined,
      confirm: password !== confirm ? "Passwords don't match" : undefined,
    };
    setErrors(nextErrors);
    setApiError(null);
    if (nextErrors.email || nextErrors.username || nextErrors.password || nextErrors.confirm) return;
    setBusy(true);
    try {
      await register(email.trim(), username.trim(), password);
      navigate(next);
    } catch (err) {
      setApiError(isApiError(err) ? err.message : errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="stack" onSubmit={(event) => void submit(event)} noValidate>
      <Input
        label="Email"
        type="email"
        value={email}
        placeholder="you@animaxia.test"
        autoComplete="email"
        onChange={(event) => onEmailChange(event.target.value)}
        error={errors.email ?? null}
      />
      <Input
        label="Username"
        value={username}
        placeholder="otaku99"
        maxLength={24}
        autoComplete="username"
        onChange={(event) => setUsername(event.target.value)}
        error={errors.username ?? null}
        hint="3-24 characters: letters, numbers, . _ -"
      />
      <Input
        label="Password"
        type="password"
        value={password}
        placeholder="At least 8 characters"
        autoComplete="new-password"
        onChange={(event) => setPassword(event.target.value)}
        error={errors.password ?? null}
      />
      <Input
        label="Confirm password"
        type="password"
        value={confirm}
        placeholder="••••••••"
        autoComplete="new-password"
        onChange={(event) => setConfirm(event.target.value)}
        error={errors.confirm ?? null}
      />
      {apiError ? (
        <div className={styles.errorBox} role="alert">
          {apiError}
        </div>
      ) : null}
      <Button type="submit" full loading={busy}>
        Create account
      </Button>
    </form>
  );
}

/* ------------------------------ forgot password ----------------------------- */

function ForgotForm({
  email,
  onEmailChange,
  onSwitchMode,
  next,
}: {
  email: string;
  onEmailChange: (value: string) => void;
  onSwitchMode: (mode: Mode) => void;
  next: string;
}): React.JSX.Element {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [apiError, setApiError] = useState<string | null>(null);
  const [result, setResult] = useState<ForgotPasswordResponse | null>(null);

  const submit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (busy) return;
    const nextEmailError = validateEmail(email);
    setEmailError(nextEmailError);
    setApiError(null);
    if (nextEmailError) return;
    setBusy(true);
    try {
      setResult(await forgotPassword(email.trim()));
    } catch (err) {
      setApiError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  /* Sandbox (no SMTP) — the code came back inline: show it + jump to reset. */
  if (result?.sandbox && result.code) {
    const keepNext = next !== '/' ? `&next=${encodeURIComponent(next)}` : '';
    return (
      <div className="stack">
        <div className={`card ${styles.codeCard}`} role="status">
          <div className={styles.codeLabel}>Sandbox mode — your reset code</div>
          <div className={styles.codeValue}>{result.code}</div>
          <div className="dim">
            Valid for {result.codeExpiresInMin ?? 30} minutes. No SMTP server is configured, so the code is shown here
            instead of emailed.
          </div>
        </div>
        <Button
          full
          onClick={() =>
            navigate(`/auth?mode=reset&email=${encodeURIComponent(email.trim())}&code=${result.code}${keepNext}`)
          }
        >
          Continue to reset
        </Button>
        <Button full variant="ghost" onClick={() => setResult(null)}>
          Use a different email
        </Button>
      </div>
    );
  }

  /* Production — the code was emailed. */
  if (result) {
    const keepNext = next !== '/' ? `&next=${encodeURIComponent(next)}` : '';
    return (
      <div className="stack">
        <div className={`card ${styles.noticeCard}`} role="status">
          <CheckCircle2 size={15} color="var(--emerald)" />
          <span>
            If an account exists for {email.trim()}, a 6-digit reset code is on its way. Check your inbox (and spam
            folder).
          </span>
        </div>
        <Button
          full
          onClick={() => navigate(`/auth?mode=reset&email=${encodeURIComponent(email.trim())}${keepNext}`)}
        >
          I have a code — reset now
        </Button>
        <Button full variant="ghost" onClick={() => setResult(null)}>
          Use a different email
        </Button>
      </div>
    );
  }

  return (
    <form className="stack" onSubmit={(event) => void submit(event)} noValidate>
      <Input
        label="Email"
        type="email"
        value={email}
        placeholder="you@animaxia.test"
        autoComplete="email"
        onChange={(event) => onEmailChange(event.target.value)}
        error={emailError}
      />
      {apiError ? (
        <div className={styles.errorBox} role="alert">
          {apiError}
        </div>
      ) : null}
      <Button type="submit" full loading={busy}>
        Send reset code
      </Button>
      <div className={styles.switchRow}>
        <button type="button" className={styles.linkButton} onClick={() => onSwitchMode('login')}>
          Back to sign in
        </button>
      </div>
    </form>
  );
}

/* ----------------------------------- reset ----------------------------------- */

function ResetForm({
  email,
  code,
  onEmailChange,
  onCodeChange,
  onBack,
}: {
  email: string;
  code: string;
  onEmailChange: (value: string) => void;
  onCodeChange: (value: string) => void;
  onBack: () => void;
}): React.JSX.Element {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [errors, setErrors] = useState<{ email?: string; code?: string; password?: string }>({});
  const [apiError, setApiError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (busy) return;
    const nextErrors = {
      email: validateEmail(email) ?? undefined,
      code: validateResetCode(code) ?? undefined,
      password: validatePassword(password) ?? undefined,
    };
    setErrors(nextErrors);
    setApiError(null);
    if (nextErrors.email || nextErrors.code || nextErrors.password) return;
    setBusy(true);
    try {
      await resetPassword(email.trim(), code.trim(), password);
      setDone(true);
    } catch (err) {
      setApiError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <div className="stack">
        <div className={`card ${styles.noticeCard}`} role="status">
          <CheckCircle2 size={15} color="var(--emerald)" />
          <span>Password updated — every other session was signed out. Sign in with your new password.</span>
        </div>
        <Button full onClick={onBack}>
          Back to sign in
        </Button>
      </div>
    );
  }

  return (
    <form className="stack" onSubmit={(event) => void submit(event)} noValidate>
      <Input
        label="Email"
        type="email"
        value={email}
        placeholder="you@animaxia.test"
        autoComplete="email"
        onChange={(event) => onEmailChange(event.target.value)}
        error={errors.email ?? null}
      />
      <Input
        label="Reset code"
        value={code}
        placeholder="123456"
        inputMode="numeric"
        maxLength={6}
        onChange={(event) => onCodeChange(event.target.value.replace(/\D/g, '').slice(0, 6))}
        error={errors.code ?? null}
        hint="The 6-digit code from the reset request."
      />
      <Input
        label="New password"
        type="password"
        value={password}
        placeholder="At least 8 characters"
        autoComplete="new-password"
        onChange={(event) => setPassword(event.target.value)}
        error={errors.password ?? null}
      />
      {apiError ? (
        <div className={styles.errorBox} role="alert">
          {apiError}
        </div>
      ) : null}
      <Button type="submit" full loading={busy}>
        Update password
      </Button>
      <div className={styles.switchRow}>
        <button type="button" className={styles.linkButton} onClick={onBack}>
          Back to sign in
        </button>
      </div>
    </form>
  );
}

/* ---------------------------------- screen ---------------------------------- */

export default function AuthScreen(): React.JSX.Element {
  const { user, initializing } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();

  const modeParam = searchParams.get('mode');
  const mode: Mode =
    modeParam === 'register' || modeParam === 'forgot' || modeParam === 'reset' ? modeParam : 'login';
  const rawNext = searchParams.get('next');
  const next = rawNext && rawNext.startsWith('/') ? rawNext : '/';
  const emailParam = searchParams.get('email') ?? '';
  const codeParam = searchParams.get('code') ?? '';

  const [email, setEmail] = useState(emailParam);
  const [code, setCode] = useState(codeParam);

  /* Deep links (animaxia://auth?mode=reset&email=…&code=…) update the prefill. */
  useEffect(() => {
    setEmail(emailParam);
  }, [emailParam]);
  useEffect(() => {
    setCode(codeParam);
  }, [codeParam]);

  const switchMode = useCallback(
    (target: Mode) => {
      const params: Record<string, string> = { mode: target };
      if (next !== '/') params.next = next;
      setSearchParams(params);
    },
    [next, setSearchParams],
  );

  const backToLogin = useCallback(() => {
    const keepNext = next !== '/' ? `&next=${encodeURIComponent(next)}` : '';
    navigate(`/auth?mode=login${keepNext}`);
  }, [navigate, next]);

  if (initializing) {
    return <LoadingState label="Checking your session…" />;
  }
  if (user) {
    return <Navigate to="/" replace />;
  }

  const copy = MODE_COPY[mode];
  const authTab = mode === 'register' ? 'register' : 'login';

  return (
    <div className={styles.page}>
      <div className={`card ${styles.authCard}`}>
        <div className={styles.brand}>
          <span className={styles.brandMark}>
            <Play size={20} fill="currentColor" />
          </span>
          <span className={styles.brandName}>
            Anima<span className={styles.brandAccent}>xa</span>
          </span>
        </div>
        <h1 className={styles.title}>{copy.title}</h1>
        <p className={styles.subtitle}>{copy.subtitle}</p>

        {mode === 'login' || mode === 'register' ? (
          <Tabs<'login' | 'register'>
            tabs={[
              { value: 'login', label: 'Login' },
              { value: 'register', label: 'Register' },
            ]}
            value={authTab}
            onChange={(value) => switchMode(value)}
          />
        ) : null}

        <div className={styles.form}>
          {mode === 'login' ? (
            <LoginForm email={email} onEmailChange={setEmail} onForgot={() => switchMode('forgot')} next={next} />
          ) : null}
          {mode === 'register' ? <RegisterForm email={email} onEmailChange={setEmail} next={next} /> : null}
          {mode === 'forgot' ? (
            <ForgotForm email={email} onEmailChange={setEmail} onSwitchMode={switchMode} next={next} />
          ) : null}
          {mode === 'reset' ? (
            <ResetForm
              email={email}
              code={code}
              onEmailChange={setEmail}
              onCodeChange={setCode}
              onBack={backToLogin}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
