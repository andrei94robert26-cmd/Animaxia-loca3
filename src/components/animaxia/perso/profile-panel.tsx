'use client';

/**
 * perso/profile-panel.tsx — FAZA 36-R (WS6): Profilul de gust — bare de
 * afinitate cu procente (top genuri/tipuri/decenii), scor de diversitate,
 * titluri favorite și resetarea onestă a agregării (semnalele rămân).
 * Încărcare la montare + Refresh manual (NEON FREE PLAN).
 */

import { useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { api, ApiError } from '@/lib/animaxia/api';
import { useApi } from '@/lib/animaxia/hooks';
import { navigate } from '@/lib/animaxia/router';
import type { PersoProfileResponse } from '@/lib/animaxia/types';
import { useAuth } from '../auth-provider';
import {
  PersoAffinityBar, PersoCard, PersoHonestNote, PersoLoginPrompt, PersoMethodBadge,
  PersoRefreshButton,
} from './perso-ui';

export function ProfilePanel() {
  const { user } = useAuth();
  const profileRes = useApi(
    `perso-taste-${user?.id ?? 'anon'}`,
    () => api.persoProfile(user?.id),
    { enabled: Boolean(user) },
  );
  const [resetting, setResetting] = useState(false);

  if (!user) return <PersoLoginPrompt />;

  const reset = async () => {
    if (resetting) return;
    setResetting(true);
    try {
      await api.persoProfileReset(user.id);
      toast.success('Profilul de gust a fost resetat', {
        description: 'Agregarea învățată s-a șters — semnalele istorice rămân în istoric, dar nu mai contează de acum.',
      });
      await profileRes.refetch();
    } catch (e) {
      toast.error('Resetarea a eșuat', {
        description: e instanceof ApiError ? e.message : 'backend-ul nu răspunde',
      });
    } finally {
      setResetting(false);
    }
  };

  if (profileRes.loading && !profileRes.data) {
    return (
      <div className="grid gap-4 lg:grid-cols-2" aria-busy="true">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-64 rounded-xl" />
        ))}
      </div>
    );
  }
  if (profileRes.error) {
    const needLogin = profileRes.error.toLowerCase().includes('autentificare');
    if (needLogin) return <PersoLoginPrompt />;
    return (
      <div role="alert" className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
        Profilul de gust nu a putut fi încărcat: {profileRes.error}
        <div className="mt-2">
          <PersoRefreshButton onClick={() => void profileRes.refetch()} loading={profileRes.loading} label="Reîncearcă" />
        </div>
      </div>
    );
  }

  const data: PersoProfileResponse | null = profileRes.data;
  const profile = data?.profile;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <PersoMethodBadge method={profile?.method} />
          {data?.cached ? (
            <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] font-bold text-zinc-400">
              cache server 10 min
            </span>
          ) : null}
          {profile?.lastSignalAt ? (
            <span className="text-[11px] text-zinc-600">
              ultimul semnal: {new Date(profile.lastSignalAt).toLocaleDateString('ro-RO')}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <PersoRefreshButton onClick={() => void profileRes.refetch()} loading={profileRes.loading} />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void reset()}
            disabled={resetting || profile?.empty}
            className="h-9 gap-1.5 border-amber-500/30 bg-amber-500/10 text-xs font-semibold text-amber-200 hover:bg-amber-500/20 hover:text-amber-100"
          >
            <RotateCcw className={resetting ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} aria-hidden />
            Resetează profilul
          </Button>
        </div>
      </div>

      {profile?.empty ? (
        <PersoCard>
          <div className="py-8 text-center">
            <span className="text-3xl" aria-hidden>🎭</span>
            <p className="mt-2 text-sm font-bold text-zinc-200">Încă nicio afinitate învățată — onest.</p>
            <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-zinc-500">
              Profilul se construiește pasiv din semnale reale: vizionări (progres), aprecieri, recenzii și
              interacțiuni. Fără ML extern — o agregare deterministă, etichetată onest.
            </p>
            <Button onClick={() => navigate('/home')} className="mt-4 h-10 bg-rose-600 text-sm font-bold hover:bg-rose-500">
              Începe să vizionezi
            </Button>
          </div>
        </PersoCard>
      ) : (
        <>
          {/* Semnalele care alimentează profilul */}
          <PersoCard
            title="Semnale reale (sursă)"
            hint="de unde învață profilul tău — doar citire, din tabelele platformei"
          >
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
              {[
                { label: 'Vizionări', value: profile?.signals.watched ?? 0, emoji: '▶️' },
                { label: 'Aprecieri', value: profile?.signals.liked ?? 0, emoji: '❤️' },
                { label: 'Recenzii', value: profile?.signals.reviewed ?? 0, emoji: '📝' },
                { label: 'Evenimente', value: profile?.signals.events ?? 0, emoji: '⚡' },
                { label: 'Total', value: profile?.signals.total ?? 0, emoji: 'Σ' },
              ].map((s) => (
                <div key={s.label} className="rounded-lg border border-white/10 bg-white/[0.03] p-3 text-center">
                  <p className="text-lg font-black text-zinc-100">
                    <span className="mr-1 text-sm" aria-hidden>{s.emoji}</span>
                    {s.value}
                  </p>
                  <p className="mt-0.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">{s.label}</p>
                </div>
              ))}
            </div>
          </PersoCard>

          <div className="grid gap-4 lg:grid-cols-2">
            <PersoCard title="Top genuri" hint="procent normalizat față de genul tău cel mai puternic">
              <div className="space-y-3">
                {(profile?.topGenres ?? []).slice(0, 8).map((g, i) => (
                  <PersoAffinityBar key={g.value} value={g.value} pct={g.pct} detail={`${g.titles} titluri`} index={i} />
                ))}
                {(profile?.topGenres ?? []).length === 0 ? (
                  <p className="py-2 text-xs text-zinc-500">Niciun gen încă.</p>
                ) : null}
              </div>
            </PersoCard>

            <div className="space-y-4">
              <PersoCard title="Tipuri de conținut">
                <div className="space-y-3">
                  {(profile?.topTypes ?? []).slice(0, 4).map((t, i) => (
                    <PersoAffinityBar key={t.value} value={t.value} pct={t.pct} detail={`${t.titles} titluri`} index={i + 2} />
                  ))}
                  {(profile?.topTypes ?? []).length === 0 ? (
                    <p className="py-2 text-xs text-zinc-500">Nicio preferință de tip încă.</p>
                  ) : null}
                </div>
              </PersoCard>

              <PersoCard title="Decenii preferate">
                <div className="space-y-3">
                  {(profile?.topDecades ?? []).slice(0, 4).map((d, i) => (
                    <PersoAffinityBar key={d.value} value={`anii ${d.value}`} pct={d.pct} detail={`${d.titles} titluri`} index={i + 1} />
                  ))}
                  {(profile?.topDecades ?? []).length === 0 ? (
                    <p className="py-2 text-xs text-zinc-500">Nicio preferință de decadă încă.</p>
                  ) : null}
                </div>
              </PersoCard>
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <PersoCard title="Scor de diversitate" hint={profile?.diversity.note}>
              <div className="flex items-center gap-4">
                <div
                  className="grid h-20 w-20 shrink-0 place-items-center rounded-full border-4 border-rose-500/40 bg-rose-500/10"
                  role="img"
                  aria-label={`Scor diversitate ${profile?.diversity.score ?? 0} din 100`}
                >
                  <span className="text-2xl font-black text-rose-200">{profile?.diversity.score ?? 0}</span>
                </div>
                <p className="text-xs leading-relaxed text-zinc-400">
                  <span className="font-bold text-zinc-200">{profile?.diversity.distinctGenres ?? 0} genuri distincte</span>{' '}
                  îți alimentează profilul. Un scor mare = gusturi variate; unul mic = focus (ambele sunt bine).
                </p>
              </div>
            </PersoCard>

            <PersoCard title="Titluri favorite" hint="ce apasă cel mai tare pe profilul tău" className="lg:col-span-2">
              <div className="custom-scrollbar max-h-56 space-y-1.5 overflow-y-auto pr-1">
                {(profile?.favoriteTitles ?? []).map((t) => (
                  <button
                    key={t.contentId}
                    type="button"
                    onClick={() => navigate(`/content/${t.contentId}`)}
                    className="flex w-full items-center gap-3 rounded-lg border border-white/10 bg-white/[0.02] p-2.5 text-left transition hover:border-rose-500/40 hover:bg-rose-500/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/60"
                  >
                    <span className="text-lg leading-none" aria-hidden>{t.type === 'tv' ? '📺' : t.type === 'anime' ? '🐉' : '🎬'}</span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-zinc-100">{t.title}</p>
                      <p className="truncate text-[10px] text-zinc-600">
                        {t.year ?? '—'} · {t.signals.slice(0, 3).join(' + ')}
                      </p>
                    </div>
                    <span className="shrink-0 rounded-full border border-rose-500/30 bg-rose-500/10 px-2 py-0.5 text-[10px] font-bold text-rose-200">
                      {t.weight}
                    </span>
                  </button>
                ))}
                {(profile?.favoriteTitles ?? []).length === 0 ? (
                  <p className="py-2 text-xs text-zinc-500">Niciun titlu favorit încă.</p>
                ) : null}
              </div>
            </PersoCard>
          </div>

          <PersoHonestNote>
            Profilul e o agregare ponderată de semnale reale (vizionări, aprecieri, recenzii, evenimente) —
            zero ML extern, etichetat onest. Resetarea șterge doar agregarea; istoricul tău rămâne intact.
          </PersoHonestNote>
        </>
      )}
    </div>
  );
}
