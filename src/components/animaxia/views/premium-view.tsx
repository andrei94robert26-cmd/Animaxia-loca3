'use client';

/**
 * premium-view.tsx — #/premium: public plan grid, Stripe-sandbox checkout
 * dialog (with automatic confirmation for ?session=… returns), current
 * subscription management (cancel via AlertDialog) and usage bars.
 */

import { useEffect, useRef, useState } from 'react';
import {
  BadgeCheck,
  Bookmark,
  Check,
  CheckCircle2,
  CreditCard,
  Crown,
  History as HistoryIcon,
  Loader2,
  Lock,
  Play,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import { toast } from 'sonner';
import { planAtLeast, useAuth } from '@/components/animaxia/auth-provider';
import { useApi } from '@/lib/animaxia/hooks';
import { navigate, type AppRoute } from '@/lib/animaxia/router';
import { platform } from '@/lib/animaxia/platform';
import type { Plan, PlatformUser } from '@/lib/animaxia/platform';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { Container, PageHeader } from '../section';
import { ErrorState } from '../states';

/* ------------------------------ local helpers ------------------------------ */

function cap(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function priceLabel(price: number): string {
  return price === 0 ? '$0' : `$${price.toFixed(2)}`;
}

function limitLabel(value: number): string {
  return value === -1 ? 'Nelimitat' : String(value);
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

function statusBadgeClass(status: string | null | undefined): string {
  switch (status) {
    case 'active':
      return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300';
    case 'pending':
    case 'past_due':
      return 'border-amber-500/30 bg-amber-500/10 text-amber-300';
    case 'canceled':
      return 'border-zinc-500/30 bg-zinc-500/10 text-zinc-300';
    default:
      return 'border-white/10 bg-white/5 text-zinc-300';
  }
}

/* ------------------------------ checkout flow ------------------------------ */

type CheckoutState =
  | { phase: 'idle' }
  | { phase: 'form'; plan: Plan; sessionId: string }
  | { phase: 'paying'; plan: Plan; sessionId: string }
  | { phase: 'confirming' }
  | { phase: 'success'; planKey: string };

function CheckoutDialogForm({
  plan,
  paying,
  onPay,
  onCancel,
}: {
  plan: Plan;
  paying: boolean;
  onPay: () => void;
  onCancel: () => void;
}) {
  const price = priceLabel(plan.price);
  return (
    <>
      <DialogHeader>
        <div className="flex items-center gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-xl bg-gradient-to-br from-rose-500 to-fuchsia-600 shadow-lg shadow-rose-900/40">
            <Play className="h-5 w-5 fill-white text-white" aria-hidden />
          </span>
          <div>
            <DialogTitle className="text-lg font-black tracking-tight text-white">
              Animaxia {plan.name}
            </DialogTitle>
            <DialogDescription className="text-xs text-zinc-400">
              Planul {plan.name} · facturat lunar · anulezi oricând
            </DialogDescription>
          </div>
        </div>
      </DialogHeader>

      <div className="space-y-4">
        <div className="flex items-baseline justify-between rounded-xl border border-white/10 bg-white/[0.03] p-4">
          <span className="text-sm font-semibold text-zinc-300">{plan.name} — lunar</span>
          <span className="text-xl font-black text-white">
            {price}
            <span className="text-xs font-medium text-zinc-400"> /{plan.period}</span>
          </span>
        </div>

        <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-xs font-semibold text-amber-300">
          <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
          Stripe sandbox — nicio plată reală
        </span>

        <div className="space-y-3 rounded-xl border border-white/10 bg-black/30 p-4">
          <div className="space-y-1.5">
            <span className="text-xs font-semibold text-zinc-400" id="sandbox-card-label">
              Număr card
            </span>
            <div
              aria-labelledby="sandbox-card-label"
              className="flex h-11 items-center gap-2 rounded-lg border border-white/10 bg-white/[0.04] px-3 text-sm tracking-widest text-zinc-400 opacity-70"
            >
              <CreditCard className="h-4 w-4" aria-hidden />
              •••• •••• •••• 4242
              <span className="ml-auto rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-amber-300">
                test
              </span>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <span className="text-xs font-semibold text-zinc-400">Expiră</span>
              <div className="flex h-11 items-center rounded-lg border border-white/10 bg-white/[0.04] px-3 text-sm tracking-widest text-zinc-400 opacity-70">
                12 / 34
              </div>
            </div>
            <div className="space-y-1.5">
              <span className="text-xs font-semibold text-zinc-400">CVC</span>
              <div className="flex h-11 items-center rounded-lg border border-white/10 bg-white/[0.04] px-3 text-sm tracking-widest text-zinc-400 opacity-70">
                424
              </div>
            </div>
          </div>
        </div>
      </div>

      <DialogFooter className="gap-2">
        <Button
          variant="outline"
          onClick={onCancel}
          disabled={paying}
          className="h-11 border-white/15 bg-white/5 font-semibold hover:bg-white/10"
        >
          Anulează
        </Button>
        <Button onClick={onPay} disabled={paying} className="h-11 bg-rose-600 px-6 font-bold hover:bg-rose-500">
          {paying ? <Loader2 className="animate-spin" aria-hidden /> : <Lock className="h-4 w-4" aria-hidden />}
          {paying ? 'Se procesează…' : `Plătește ${price} (sandbox)`}
        </Button>
      </DialogFooter>
    </>
  );
}

function CheckoutDialogSuccess({
  planKey,
  plans,
  onDone,
}: {
  planKey: string;
  plans: Plan[];
  onDone: () => void;
}) {
  const plan = plans.find((p) => p.key === planKey);
  return (
    <div className="flex flex-col items-center gap-4 py-4 text-center">
      <span className="grid h-16 w-16 place-items-center rounded-full bg-emerald-500/15 text-emerald-400">
        <CheckCircle2 className="h-9 w-9" aria-hidden />
      </span>
      <DialogTitle className="text-xl font-black tracking-tight text-white">
        Bine ai venit pe Animaxia {cap(planKey)}!
      </DialogTitle>
      <DialogDescription className="max-w-sm text-sm leading-relaxed text-zinc-400">
        {plan ? plan.features.slice(1, 4).join(' · ') : 'Beneficiile tale premium sunt active.'}
      </DialogDescription>
      <Button onClick={onDone} className="mt-2 h-11 bg-rose-600 px-8 font-bold hover:bg-rose-500">
        Gata
      </Button>
    </div>
  );
}

/* -------------------------------- plan card ------------------------------- */

function PlanCard({
  plan,
  user,
  starting,
  onChoose,
}: {
  plan: Plan;
  user: PlatformUser | null;
  starting: boolean;
  onChoose: (plan: Plan) => void;
}) {
  const isFree = plan.key === 'free';
  const isPlus = plan.key === 'plus';
  const isPro = plan.key === 'pro';
  const included = Boolean(user && planAtLeast(user, plan.key));

  let ctaLabel: string;
  let ctaCurrent = false;
  if (isFree) {
    ctaCurrent = user?.plan === 'free';
    ctaLabel = ctaCurrent ? 'Planul tău curent' : 'Planul tău de bază';
  } else if (included) {
    ctaCurrent = user?.plan === plan.key;
    ctaLabel = ctaCurrent ? 'Planul tău curent' : 'Inclus în planul tău';
  } else {
    ctaLabel = `Treci pe ${plan.name}`;
  }
  const ctaDisabled = isFree || included || starting;

  return (
    <div
      className={cn(
        'relative flex h-full flex-col rounded-2xl border bg-white/[0.03] p-6',
        isPlus && 'border-rose-500/40 ring-2 ring-rose-500/50',
        isPro && 'border-amber-500/30',
        isFree && 'border-white/10',
      )}
    >
      {plan.highlight && (
        <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-gradient-to-r from-rose-500 to-fuchsia-600 px-3 py-1 text-[10px] font-black uppercase tracking-widest text-white shadow-lg shadow-rose-900/40">
          Cel mai popular
        </span>
      )}

      <div className="flex items-center justify-between">
        <h3 className="text-lg font-black tracking-tight text-white">{plan.name}</h3>
        {isPlus && <Crown className="h-5 w-5 text-rose-400" aria-hidden />}
        {isPro && <Crown className="h-5 w-5 text-amber-400" aria-hidden />}
        {isFree && <Play className="h-5 w-5 text-zinc-500" aria-hidden />}
      </div>

      <p className="mt-3 flex items-baseline gap-1">
        <span
          className={cn(
            'text-4xl font-black tracking-tight',
            isPlus ? 'text-rose-400' : isPro ? 'text-amber-400' : 'text-zinc-100',
          )}
        >
          {priceLabel(plan.price)}
        </span>
        <span className="text-sm font-medium text-zinc-500">/{plan.period}</span>
      </p>

      <ul className="mt-5 flex-1 space-y-2.5">
        {plan.features.map((feature) => (
          <li key={feature} className="flex items-start gap-2 text-sm text-zinc-300">
            <Check
              className={cn(
                'mt-0.5 h-4 w-4 shrink-0',
                isPlus ? 'text-rose-400' : isPro ? 'text-amber-400' : 'text-zinc-500',
              )}
              aria-hidden
            />
            {feature}
          </li>
        ))}
      </ul>

      <div className="mt-5 flex flex-wrap gap-1.5" aria-label="Limitele planului">
        <span className="rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-0.5 text-[11px] font-medium text-zinc-400">
          Listă: {limitLabel(plan.limits.watchlist)}
        </span>
        <span className="rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-0.5 text-[11px] font-medium text-zinc-400">
          Istoric: {limitLabel(plan.limits.history)}
        </span>
        <span className="rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-0.5 text-[11px] font-medium text-zinc-400">
          AI: {limitLabel(plan.limits.aiPerDay)}/zi
        </span>
        <span className="rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-0.5 text-[11px] font-medium text-zinc-400">
          {plan.limits.quality.toUpperCase()}
        </span>
      </div>

      <Button
        type="button"
        onClick={() => onChoose(plan)}
        disabled={ctaDisabled}
        aria-label={ctaLabel}
        className={cn(
          'mt-6 h-11 w-full font-bold',
          ctaDisabled
            ? 'border border-white/10 bg-white/5 text-zinc-400'
            : isPlus
              ? 'bg-rose-600 text-white hover:bg-rose-500'
              : 'bg-amber-500 text-black hover:bg-amber-400',
        )}
      >
        {starting ? (
          <Loader2 className="animate-spin" aria-hidden />
        ) : ctaCurrent ? (
          <BadgeCheck className="h-4 w-4" aria-hidden />
        ) : null}
        {starting ? 'Se pornește…' : ctaLabel}
      </Button>
    </div>
  );
}

/* -------------------------------- usage bar ------------------------------- */

function UsageBar({
  label,
  icon: Icon,
  used,
  limit,
}: {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  used: number;
  limit: number;
}) {
  const unlimited = limit === -1;
  const pct = unlimited ? 100 : limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const full = !unlimited && used >= limit;

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-2 text-sm font-bold text-zinc-200">
          <Icon className="h-4 w-4 text-rose-400" aria-hidden />
          {label}
        </span>
        <span
          className={cn(
            'text-xs font-semibold',
            unlimited ? 'text-emerald-300' : full ? 'text-rose-300' : 'text-zinc-400',
          )}
        >
          {unlimited ? 'Nelimitat' : `${used} / ${limit}`}
        </span>
      </div>
      <Progress
        value={pct}
        aria-label={`Grad de ocupare ${label}`}
        className={cn(
          'mt-3 h-2.5 bg-white/10',
          unlimited
            ? '[&>[data-slot=progress-indicator]]:bg-emerald-500'
            : '[&>[data-slot=progress-indicator]]:bg-rose-500',
        )}
      />
      <p className="mt-2 text-[11px] text-zinc-500">
        {unlimited
          ? 'Fără limită pe acest plan.'
          : full
            ? `${label} e plin — fă upgrade pentru a continua să adaugi.`
            : `${Math.max(0, limit - used)} locuri rămase pe acest plan.`}
      </p>
    </div>
  );
}

/* ---------------------------------- view ---------------------------------- */

export function PremiumView({ route }: { route: AppRoute }) {
  const { user, initializing, refreshUser } = useAuth();
  const plans = useApi('premium-plans', () => platform.plans());
  const premiumMe = useApi(`premium-me-${user?.id ?? 'anon'}`, () => platform.premiumMe(), {
    enabled: Boolean(user),
  });
  const refetchPremium = premiumMe.refetch;

  const [checkout, setCheckout] = useState<CheckoutState>({ phase: 'idle' });
  const [startingKey, setStartingKey] = useState<string | null>(null);
  const [canceling, setCanceling] = useState(false);
  const plansRef = useRef<HTMLDivElement>(null);

  /* Return-from-checkout (?session=…) → confirm automatically, once. */
  const [returnSession] = useState(() => route.query.get('session'));
  const autoHandled = useRef(false);
  useEffect(() => {
    if (!returnSession || initializing || !user || autoHandled.current) return;
    autoHandled.current = true;
    let cancelled = false;
    (async () => {
      setCheckout({ phase: 'confirming' });
      try {
        const res = await platform.confirmCheckout(returnSession);
        if (cancelled) return;
        await refreshUser();
        await refetchPremium();
        toast.success(`Abonament activ — bine ai venit pe Animaxia ${cap(res.user.plan)}!`);
        setCheckout({ phase: 'success', planKey: res.user.plan });
        navigate('/premium'); // strip ?session= from the URL
      } catch (err) {
        if (cancelled) return;
        toast.error(errorMessage(err, 'Nu am putut confirma plata'));
        setCheckout({ phase: 'idle' });
        navigate('/premium');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [returnSession, initializing, user, refreshUser, refetchPremium]);

  async function startCheckout(plan: Plan) {
    if (!user) {
      toast('Conectează-te pentru a te abona');
      navigate('/auth');
      return;
    }
    if (plan.key === 'free' || planAtLeast(user, plan.key)) return;
    setStartingKey(plan.key);
    try {
      const res = await platform.checkout(plan.key);
      setCheckout({ phase: 'form', plan, sessionId: res.sessionId });
    } catch (err) {
      toast.error(errorMessage(err, 'Nu am putut porni finalizarea comenzii'));
    } finally {
      setStartingKey(null);
    }
  }

  async function pay() {
    if (checkout.phase !== 'form') return;
    const { plan, sessionId } = checkout;
    setCheckout({ phase: 'paying', plan, sessionId });
    try {
      const res = await platform.confirmCheckout(sessionId);
      await refreshUser();
      await refetchPremium();
      toast.success(`Bine ai venit pe Animaxia ${cap(plan.key)}!`);
      setCheckout({ phase: 'success', planKey: res.user.plan });
    } catch (err) {
      toast.error(errorMessage(err, 'Plata a eșuat'));
      setCheckout({ phase: 'form', plan, sessionId }); // keep the dialog open for retry
    }
  }

  async function cancelSubscription() {
    setCanceling(true);
    try {
      await platform.cancelSubscription();
      await refreshUser();
      await refetchPremium();
      toast.success('Abonament anulat — ai revenit pe planul Free');
    } catch (err) {
      toast.error(errorMessage(err, 'Nu am putut anula abonamentul'));
    } finally {
      setCanceling(false);
    }
  }

  const subscription = premiumMe.data?.subscription;
  const usage = premiumMe.data?.usage;
  const limits = premiumMe.data?.limits;
  const planList = plans.data?.data ?? [];

  return (
    <Container className="space-y-10 py-8 sm:py-10">
      <PageHeader title="Planuri Premium" subtitle="Deblochează mai mult din Animaxia." />

      {/* Plans */}
      <section ref={plansRef} id="plans" className="space-y-5 scroll-mt-24" aria-label="Planuri Premium">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 className="text-lg font-bold tracking-tight text-zinc-100 sm:text-xl">Alege-ți planul</h2>
            <p className="text-xs text-zinc-500 sm:text-sm">Anulezi oricând — plată în sandbox, fără costuri reale.</p>
          </div>
          {!user && !initializing && (
            <span className="text-xs text-zinc-500">Răsfoiești anonim — conectează-te pentru a te abona.</span>
          )}
        </div>
        {plans.loading ? (
          <div className="grid gap-5 lg:grid-cols-3" aria-busy="true" aria-label="Se încarcă planurile">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-[460px] rounded-2xl" />
            ))}
          </div>
        ) : plans.error ? (
          <ErrorState message={plans.error} onRetry={() => void plans.refetch()} />
        ) : (
          <div className="grid gap-5 lg:grid-cols-3">
            {planList.map((plan) => (
              <PlanCard
                key={plan.key}
                plan={plan}
                user={user}
                starting={startingKey === plan.key}
                onChoose={(p) => void startCheckout(p)}
              />
            ))}
          </div>
        )}
      </section>

      {/* Current subscription */}
      {user && user.plan !== 'free' && (
        <section className="space-y-4" aria-label="Abonamentul curent">
          <h2 className="text-lg font-bold tracking-tight text-zinc-100 sm:text-xl">Abonamentul curent</h2>
          {premiumMe.loading ? (
            <Skeleton className="h-44 rounded-2xl" />
          ) : premiumMe.error ? (
            <ErrorState message={premiumMe.error} onRetry={() => void refetchPremium()} compact />
          ) : (
            <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-6">
              <div className="flex flex-wrap items-start justify-between gap-5">
                <div className="space-y-3">
                  <div className="flex items-center gap-2.5">
                    <Crown className="h-6 w-6 text-amber-400" aria-hidden />
                    <div>
                      <p className="text-lg font-black tracking-tight text-white">
                        Animaxia {cap(premiumMe.data?.plan ?? user.plan)}
                      </p>
                      <p className="text-xs text-zinc-500">Abonament Premium</p>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={cn(
                        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-bold capitalize',
                        statusBadgeClass(subscription?.status),
                      )}
                    >
                      <ShieldCheck className="h-3 w-3" aria-hidden />
                      {subscription?.status ?? 'active'}
                    </span>
                    <span className="rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-0.5 text-xs font-medium text-zinc-400">
                      Furnizor: {subscription?.provider ?? 'stripe'}
                    </span>
                    <span className="rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-0.5 text-xs font-medium text-zinc-400">
                      {subscription?.status === 'canceled' ? 'Se încheie' : 'Se reînnoiește'}{' '}
                      {formatDate(subscription?.currentperiodend)}
                    </span>
                  </div>
                </div>

                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      variant="outline"
                      disabled={canceling}
                      className="h-11 border-rose-500/30 bg-rose-500/5 font-semibold text-rose-300 hover:bg-rose-500/15 hover:text-rose-200"
                    >
                      {canceling ? <Loader2 className="animate-spin" aria-hidden /> : null}
                      {canceling ? 'Se anulează…' : 'Anulează abonamentul'}
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent className="border-white/10 bg-[#12121c]">
                    <AlertDialogHeader>
                      <AlertDialogTitle>Anulezi abonamentul?</AlertDialogTitle>
                      <AlertDialogDescription>
                        Reveniți imediat pe planul Free — listă de 20 de titluri, istoric de 50 de intrări și 10
                        interacțiuni AI pe zi. Nu se percepe nicio plată în acest sandbox.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel className="border-white/15 bg-white/5 hover:bg-white/10">
                        Păstrează {cap(user.plan)}
                      </AlertDialogCancel>
                      <AlertDialogAction
                        onClick={() => void cancelSubscription()}
                        className="bg-rose-600 font-bold text-white hover:bg-rose-500"
                      >
                        Da, anulează
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            </div>
          )}
        </section>
      )}

      {/* Usage */}
      {user && !initializing && (
        <section className="space-y-4" aria-label="Utilizarea ta">
          <h2 className="text-lg font-bold tracking-tight text-zinc-100 sm:text-xl">Utilizarea ta</h2>
          {premiumMe.loading ? (
            <div className="grid gap-4 sm:grid-cols-2" aria-busy="true" aria-label="Se încarcă utilizarea">
              <Skeleton className="h-32 rounded-2xl" />
              <Skeleton className="h-32 rounded-2xl" />
            </div>
          ) : premiumMe.error ? (
            <ErrorState message={premiumMe.error} onRetry={() => void refetchPremium()} compact />
          ) : (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <UsageBar
                  label="Lista Mea"
                  icon={Bookmark}
                  used={usage?.watchlist ?? 0}
                  limit={limits?.watchlist ?? 0}
                />
                <UsageBar
                  label="Istoric"
                  icon={HistoryIcon}
                  used={usage?.history ?? 0}
                  limit={limits?.history ?? 0}
                />
              </div>
              {user.plan === 'free' && (
                <p className="flex flex-wrap items-center gap-2 text-sm text-zinc-400">
                  <Sparkles className="h-4 w-4 text-rose-400" aria-hidden />
                  Planul Free te limitează la 20 de titluri în listă și 50 de intrări în istoric.
                  <button
                    type="button"
                    onClick={() => plansRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                    className="font-semibold text-rose-300 underline-offset-4 transition hover:underline"
                  >
                    Fă upgrade pentru 200 →
                  </button>
                </p>
              )}
            </>
          )}
        </section>
      )}

      {/* Sandbox checkout dialog */}
      <Dialog
        open={checkout.phase !== 'idle'}
        onOpenChange={(open) => {
          if (!open && checkout.phase !== 'paying' && checkout.phase !== 'confirming') {
            setCheckout({ phase: 'idle' });
          }
        }}
      >
        <DialogContent className="border-white/10 bg-[#12121c] sm:max-w-md">
          {checkout.phase === 'confirming' && (
            <div className="flex flex-col items-center gap-4 py-8 text-center">
              <Loader2 className="h-10 w-10 animate-spin text-rose-400" aria-hidden />
              <div>
                <DialogTitle className="text-lg font-bold text-white">Confirmăm plata…</DialogTitle>
                <DialogDescription className="mt-1 text-sm text-zinc-400">
                  Încheiem sesiunea de plată din sandbox.
                </DialogDescription>
              </div>
            </div>
          )}
          {(checkout.phase === 'form' || checkout.phase === 'paying') && (
            <CheckoutDialogForm
              plan={checkout.plan}
              paying={checkout.phase === 'paying'}
              onPay={() => void pay()}
              onCancel={() => setCheckout({ phase: 'idle' })}
            />
          )}
          {checkout.phase === 'success' && (
            <CheckoutDialogSuccess
              planKey={checkout.planKey}
              plans={planList}
              onDone={() => setCheckout({ phase: 'idle' })}
            />
          )}
        </DialogContent>
      </Dialog>
    </Container>
  );
}

export default PremiumView;
