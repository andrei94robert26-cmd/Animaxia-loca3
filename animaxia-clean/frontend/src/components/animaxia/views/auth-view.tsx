'use client';

/**
 * auth-view.tsx — #/auth: sign in / create account. Two-panel card (form on
 * the left, gradient feature panel on lg+), demo-account chip, inline
 * destructive alerts for API errors (brute-force lockout included), and a
 * post-login redirect via ?next=… (defaults to /home).
 */

import { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  BookmarkCheck,
  Crown,
  Loader2,
  LogIn,
  Play,
  Rss,
  Sparkles,
  UserPlus,
} from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/components/animaxia/auth-provider';
import { navigate, type AppRoute } from '@/lib/animaxia/router';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

const EMAIL_RE = /.+@.+\..+/;

const FEATURES: { icon: React.ComponentType<{ className?: string }>; title: string; text: string }[] = [
  { icon: BookmarkCheck, title: 'Watchlist sync', text: 'Your picks follow you across every device.' },
  { icon: Sparkles, title: 'AI recommendations', text: 'A hub that learns your taste and surfaces gems.' },
  { icon: Crown, title: 'Premium streaming', text: 'HD and 4K quality on Plus and Pro plans.' },
  { icon: Rss, title: 'Social feed', text: 'Comments, likes and activity in real time.' },
];

const INPUT_CLASS =
  'h-11 border-white/10 bg-white/5 text-zinc-100 placeholder:text-zinc-500 focus-visible:ring-rose-500/50';

function ErrorAlert({ message }: { message: string }) {
  return (
    <Alert variant="destructive" className="mt-4 border-rose-500/30 bg-rose-500/10 text-rose-200">
      <AlertTriangle aria-hidden />
      <AlertTitle className="text-rose-200">Something went wrong</AlertTitle>
      <AlertDescription className="text-rose-200/80">{message}</AlertDescription>
    </Alert>
  );
}

/* --------------------------------- login ---------------------------------- */

function LoginForm({ next }: { next: string }) {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (pending) return;
    setError(null);
    if (!EMAIL_RE.test(email.trim())) {
      setError('Enter a valid email address.');
      return;
    }
    if (!password) {
      setError('Enter your password.');
      return;
    }
    setPending(true);
    try {
      const user = await login(email.trim(), password);
      toast.success(`Welcome back, ${user.username}`);
      navigate(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed — please try again.');
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="login-email" className="text-sm font-semibold text-zinc-300">
          Email
        </Label>
        <Input
          id="login-email"
          type="email"
          autoComplete="email"
          inputMode="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          className={INPUT_CLASS}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="login-password" className="text-sm font-semibold text-zinc-300">
          Password
        </Label>
        <Input
          id="login-password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="••••••••"
          className={INPUT_CLASS}
        />
      </div>
      {error && <ErrorAlert message={error} />}
      <Button
        type="submit"
        size="lg"
        disabled={pending}
        className="h-11 w-full bg-rose-600 text-base font-bold hover:bg-rose-500"
      >
        {pending ? <Loader2 className="animate-spin" aria-hidden /> : <LogIn aria-hidden />}
        {pending ? 'Signing in…' : 'Sign in'}
      </Button>
    </form>
  );
}

/* -------------------------------- register -------------------------------- */

function RegisterForm() {
  const { register } = useAuth();
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (pending) return;
    setError(null);
    const name = username.trim();
    if (name.length < 3 || name.length > 24) {
      setError('Username must be 3–24 characters.');
      return;
    }
    if (!EMAIL_RE.test(email.trim())) {
      setError('Enter a valid email address.');
      return;
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    setPending(true);
    try {
      await register(email.trim(), name, password);
      toast.success('Account created — welcome to Animaxia!');
      navigate('/home');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Registration failed — please try again.');
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="register-username" className="text-sm font-semibold text-zinc-300">
          Username
        </Label>
        <Input
          id="register-username"
          autoComplete="username"
          required
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="kaguya_fan_99"
          aria-describedby="register-username-hint"
          className={INPUT_CLASS}
        />
        <p id="register-username-hint" className="text-[11px] text-zinc-500">
          3–24 characters — this is how you show up in the feed.
        </p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="register-email" className="text-sm font-semibold text-zinc-300">
          Email
        </Label>
        <Input
          id="register-email"
          type="email"
          autoComplete="email"
          inputMode="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          className={INPUT_CLASS}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="register-password" className="text-sm font-semibold text-zinc-300">
          Password
        </Label>
        <Input
          id="register-password"
          type="password"
          autoComplete="new-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="••••••••"
          aria-describedby="register-password-hint"
          className={INPUT_CLASS}
        />
        <p id="register-password-hint" className="text-[11px] text-zinc-500">
          Minimum 8 characters.
        </p>
      </div>
      {error && <ErrorAlert message={error} />}
      <Button
        type="submit"
        size="lg"
        disabled={pending}
        className="h-11 w-full bg-rose-600 text-base font-bold hover:bg-rose-500"
      >
        {pending ? <Loader2 className="animate-spin" aria-hidden /> : <UserPlus aria-hidden />}
        {pending ? 'Creating account…' : 'Create account'}
      </Button>
    </form>
  );
}

/* ---------------------------------- view ---------------------------------- */

export function AuthView({ route }: { route: AppRoute }) {
  const { user, initializing } = useAuth();
  const [next] = useState(() => {
    const raw = route.query.get('next');
    return raw && raw.startsWith('/') ? raw : '/home';
  });

  // Already signed in → bounce to the profile. Only triggers on the
  // initializing→ready transition (session restore or mount while logged in),
  // never right after an in-form login (which navigates to `next` itself).
  const wasInitializing = useRef(true);
  useEffect(() => {
    const before = wasInitializing.current;
    wasInitializing.current = initializing;
    if (before && !initializing && user) {
      toast('Already signed in');
      navigate('/profile');
    }
  }, [user, initializing]);

  return (
    <div className="mx-auto flex min-h-[calc(100vh-12rem)] w-full max-w-md flex-col justify-center px-4 py-10 md:max-w-lg lg:max-w-4xl">
      <div className="grid overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03] shadow-2xl shadow-black/60 lg:grid-cols-2">
        {/* Form panel */}
        <div className="flex flex-col justify-center p-6 sm:p-8 lg:p-10">
          <div className="mb-7 flex flex-col items-center gap-3 text-center">
            <span className="grid h-12 w-12 place-items-center rounded-2xl bg-gradient-to-br from-rose-500 to-fuchsia-600 shadow-lg shadow-rose-900/40">
              <Play className="h-6 w-6 fill-white text-white" aria-hidden />
            </span>
            <div>
              <h1 className="text-2xl font-black tracking-tight text-white">
                ANIMA<span className="text-rose-400">XIA</span>
              </h1>
              <p className="mt-1 text-sm text-zinc-400">Stream everything — one account, all your worlds.</p>
            </div>
          </div>

          <Tabs defaultValue="signin" className="w-full">
            <TabsList className="grid h-11 w-full grid-cols-2 bg-white/5 p-1">
              <TabsTrigger
                value="signin"
                className="h-9 text-sm font-semibold data-[state=active]:bg-rose-600 data-[state=active]:text-white data-[state=active]:shadow-lg data-[state=active]:shadow-rose-900/40"
              >
                Sign in
              </TabsTrigger>
              <TabsTrigger
                value="register"
                className="h-9 text-sm font-semibold data-[state=active]:bg-rose-600 data-[state=active]:text-white data-[state=active]:shadow-lg data-[state=active]:shadow-rose-900/40"
              >
                Create account
              </TabsTrigger>
            </TabsList>
            <TabsContent value="signin" className="mt-6">
              <LoginForm next={next} />
            </TabsContent>
            <TabsContent value="register" className="mt-6">
              <RegisterForm />
            </TabsContent>
          </Tabs>
        </div>

        {/* Feature panel (lg+) */}
        <aside className="hidden flex-col justify-center gap-8 border-l border-white/10 bg-gradient-to-br from-rose-600/20 via-fuchsia-600/10 to-fuchsia-600/20 p-10 lg:flex">
          <div>
            <h2 className="text-xl font-black tracking-tight text-white">Everything you stream, in one place.</h2>
            <p className="mt-2 text-sm leading-relaxed text-zinc-300/80">
              Anime, movies, TV, sports and news — with your watchlist, history and taste profile along for the ride.
            </p>
          </div>
          <ul className="space-y-5">
            {FEATURES.map((feature) => {
              const Icon = feature.icon;
              return (
                <li key={feature.title} className="flex items-start gap-3.5">
                  <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-white/10 bg-black/30 text-rose-300">
                    <Icon className="h-5 w-5" aria-hidden />
                  </span>
                  <div>
                    <p className="text-sm font-bold text-white">{feature.title}</p>
                    <p className="mt-0.5 text-xs leading-relaxed text-zinc-400">{feature.text}</p>
                  </div>
                </li>
              );
            })}
          </ul>
          <p className="text-xs font-medium uppercase tracking-[0.2em] text-zinc-500">
            Animaxia — stream everything
          </p>
        </aside>
      </div>
    </div>
  );
}

export default AuthView;
