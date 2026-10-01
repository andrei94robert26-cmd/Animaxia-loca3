'use client';

/**
 * perso/profiles-panel.tsx — FAZA 36-R (WS6): managerul de profile multiple —
 * carduri cu avatar emoji, dialog creare/editare cu tastatură numerică PIN
 * (4 cifre, stocate doar hash-uit în backend), flux de verificare PIN →
 * token de sesiune profil (2h). Max 5 profiluri/cont, primul e principal.
 * Încărcare la montare + Refresh manual (NEON FREE PLAN).
 */

import { useEffect, useState } from 'react';
import { KeyRound, Pencil, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { api, ApiError } from '@/lib/animaxia/api';
import { useApi } from '@/lib/animaxia/hooks';
import type { PersoAccountProfile, PersoProfileVerifyResponse } from '@/lib/animaxia/types';
import { useAuth } from '../auth-provider';
import { PersoCard, PersoCountBadge, PersoHonestNote, PersoLoginPrompt, PersoRefreshButton } from './perso-ui';
import { cn } from '@/lib/utils';

/** Whitelist-ul de emoji-uri — identic cu modules/perso/profiles.js. */
const EMOJIS = ['🧑', '👩', '👨', '🧒', '👧', '👦', '🦊', '🐼', '🦄', '🐯', '🍿', '🎬', '⭐', '🌙', '🚀', '🎸'];
const MAX_PROFILES = 5;

/* --------------------------------- PIN pad ---------------------------------- */

function PinPad({
  value,
  onChange,
  label = 'Cod PIN (4 cifre)',
  optional = false,
}: {
  value: string;
  onChange: (next: string) => void;
  label?: string;
  optional?: boolean;
}) {
  const press = (digit: string) => {
    if (value.length >= 4) return;
    onChange(`${value}${digit}`);
  };
  return (
    <div>
      <p className="mb-2 text-xs font-semibold text-zinc-400">
        {label}
        {optional ? <span className="ml-1 font-normal text-zinc-600">(opțional)</span> : null}
      </p>
      <div
        className="mb-3 flex items-center justify-center gap-2.5"
        role="group"
        aria-label={`PIN introdus: ${value.length} din 4 cifre`}
      >
        {Array.from({ length: 4 }).map((_, i) => (
          <span
            key={i}
            aria-hidden
            className={cn(
              'h-10 w-8 rounded-lg border text-center text-lg font-black leading-10 transition',
              i < value.length
                ? 'border-rose-500/60 bg-rose-500/15 text-rose-200'
                : 'border-white/10 bg-white/[0.03] text-transparent',
            )}
          >
            ●
          </span>
        ))}
      </div>
      <div className="mx-auto grid max-w-[220px] grid-cols-3 gap-2">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
          <button
            key={d}
            type="button"
            onClick={() => press(d)}
            className="h-11 rounded-lg border border-white/10 bg-white/[0.04] text-base font-bold text-zinc-100 transition hover:border-white/30 hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/60"
          >
            {d}
          </button>
        ))}
        <button
          type="button"
          onClick={() => onChange('')}
          className="h-11 rounded-lg border border-white/10 bg-transparent text-[11px] font-bold text-zinc-400 transition hover:border-rose-500/40 hover:text-rose-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/60"
        >
          Golește
        </button>
        <button
          type="button"
          onClick={() => press('0')}
          className="h-11 rounded-lg border border-white/10 bg-white/[0.04] text-base font-bold text-zinc-100 transition hover:border-white/30 hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/60"
        >
          0
        </button>
        <button
          type="button"
          onClick={() => onChange(value.slice(0, -1))}
          className="h-11 rounded-lg border border-white/10 bg-transparent text-sm font-bold text-zinc-400 transition hover:border-rose-500/40 hover:text-rose-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/60"
          aria-label="Șterge ultima cifră"
        >
          ⌫
        </button>
      </div>
    </div>
  );
}

/* ------------------------------ create/edit dialog -------------------------- */

interface EditState {
  mode: 'create' | 'edit';
  profileId?: string;
  name: string;
  emoji: string;
  pin: string;
  oldPin: string;
  removePin: boolean;
  hasPin: boolean;
}

function ProfileDialog({
  state,
  onClose,
  onSaved,
  userId,
}: {
  state: EditState | null;
  onClose: () => void;
  onSaved: () => void;
  userId: number | undefined;
}) {
  /* Oglindă locală a stării de editare — dialogul e controlat local, dar se
   * re-inițializează la fiecare deschidere (state nou de la părinte). */
  const [name, setName] = useState('');
  const [emoji, setEmoji] = useState<string>(EMOJIS[0]);
  const [pin, setPin] = useState('');
  const [oldPin, setOldPin] = useState('');
  const [removePin, setRemovePin] = useState(false);
  const [busy, setBusy] = useState(false);
  const isCreate = state?.mode === 'create';

  useEffect(() => {
    if (state) {
      setName(state.name);
      setEmoji(state.emoji);
      setPin('');
      setOldPin('');
      setRemovePin(false);
      setBusy(false);
    }
  }, [state]);

  const save = async () => {
    if (!state || busy) return;
    setBusy(true);
    try {
      if (isCreate) {
        await api.persoProfileCreate(
          { name: name.trim(), emoji, ...(pin.length === 4 ? { pin } : {}) },
          userId,
        );
        toast.success(`Profilul „${name.trim()}" a fost creat`);
      } else if (state.profileId) {
        await api.persoProfileUpdate(
          state.profileId,
          {
            name: name.trim(),
            emoji,
            ...(removePin ? { pin: null } : pin.length === 4 ? { pin } : {}),
            ...(state.hasPin ? { oldPin } : {}),
          },
          userId,
        );
        toast.success('Profilul a fost actualizat');
      }
      onSaved();
      onClose();
    } catch (e) {
      toast.error(isCreate ? 'Crearea profilului a eșuat' : 'Actualizarea a eșuat', {
        description: e instanceof ApiError ? e.message : 'backend-ul nu răspunde',
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={state !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="max-h-[90vh] overflow-y-auto border-white/10 bg-zinc-950 sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base text-white">
            <span aria-hidden>{isCreate ? '➕' : '✏️'}</span>
            {isCreate ? 'Profil nou' : `Editează „${state?.name ?? ''}"`}
          </DialogTitle>
          <DialogDescription className="text-xs text-zinc-500">
            {isCreate
              ? `Primul profil al contului devine principalul. Max ${MAX_PROFILES} profiluri per cont.`
              : 'Schimbările pe un profil cu PIN cer codul vechi (gardă onestă).'}
          </DialogDescription>
        </DialogHeader>

        {state ? (
          <div className="space-y-4">
            <div>
              <label htmlFor="perso-profile-name" className="mb-1.5 block text-xs font-semibold text-zinc-400">
                Numele profilului (2-30 caractere)
              </label>
              <Input
                id="perso-profile-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={30}
                placeholder="ex: Copilul, Oaspete, Bunică…"
                className="h-11 border-white/15 bg-white/5 text-zinc-100"
              />
            </div>

            <div>
              <p className="mb-1.5 text-xs font-semibold text-zinc-400">Avatar emoji</p>
              <div className="flex flex-wrap gap-1.5">
                {EMOJIS.map((e) => (
                  <button
                    key={e}
                    type="button"
                    onClick={() => setEmoji(e)}
                    className={cn(
                      'h-10 w-10 rounded-lg border text-xl leading-none transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/60',
                      emoji === e
                        ? 'border-rose-500/60 bg-rose-500/15'
                        : 'border-white/10 bg-white/[0.03] hover:border-white/30',
                    )}
                    aria-label={`Alege avatarul ${e}`}
                    aria-pressed={emoji === e}
                  >
                    {e}
                  </button>
                ))}
              </div>
            </div>

            {!isCreate && state.hasPin ? (
              <PinPad value={oldPin} onChange={setOldPin} label="PIN vechi (obligatoriu pentru orice modificare)" />
            ) : null}

            {!isCreate && state.hasPin ? (
              <label className="flex items-center gap-2 text-xs text-zinc-400">
                <input
                  type="checkbox"
                  checked={removePin}
                  onChange={(e) => setRemovePin(e.target.checked)}
                  className="h-4 w-4 accent-rose-500"
                />
                Elimină PIN-ul de pe acest profil
              </label>
            ) : null}

            <PinPad
              value={pin}
              onChange={setPin}
              label={isCreate ? 'Protejează profilul cu PIN' : 'PIN nou (lasă gol ca să rămână neschimbat)'}
              optional
            />
          </div>
        ) : null}

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose} className="h-10 border-white/15 bg-white/5 text-sm text-zinc-300 hover:bg-white/10">
            Anulează
          </Button>
          <Button
            onClick={() => void save()}
            disabled={
              busy ||
              !state ||
              name.trim().length < 2 ||
              (pin.length > 0 && pin.length !== 4) ||
              (!isCreate && state.hasPin && oldPin.length !== 4)
            }
            className="h-10 bg-rose-600 text-sm font-bold hover:bg-rose-500"
          >
            {isCreate ? 'Creează profilul' : 'Salvează'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* -------------------------------- verify dialog ----------------------------- */

function VerifyDialog({
  profile,
  onClose,
  userId,
}: {
  profile: PersoAccountProfile | null;
  onClose: () => void;
  userId: number | undefined;
}) {
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PersoProfileVerifyResponse | null>(null);

  const verify = async () => {
    if (!profile || busy) return;
    setBusy(true);
    try {
      const r = await api.persoProfileVerify(profile.id, pin, userId);
      setResult(r);
      toast.success(`Bun venit, ${r.profile.name}!`, {
        description: `Sesiune profil activă 2h (token JWT-lite semnat HMAC).`,
      });
    } catch (e) {
      toast.error('PIN incorect', {
        description: e instanceof ApiError ? e.message : 'încearcă din nou',
      });
      setPin('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={profile !== null}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
          setPin('');
          setResult(null);
        }
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto border-white/10 bg-zinc-950 sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base text-white">
            <KeyRound className="h-4 w-4 text-rose-300" aria-hidden />
            {profile?.name ? `Intră ca „${profile.name}"` : 'Verificare PIN'}
          </DialogTitle>
          <DialogDescription className="text-xs text-zinc-500">
            Introdu codul de 4 cifre al profilului. Primești un token de sesiune valabil 2 ore.
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <div className="space-y-3">
            <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4 text-center">
              <ShieldCheck className="mx-auto h-8 w-8 text-emerald-300" aria-hidden />
              <p className="mt-2 text-sm font-bold text-emerald-200">Sesiune activă 2h</p>
              <p className="mt-1 text-[11px] leading-relaxed text-emerald-100/70">
                Profil: {result.profile.name} {result.profile.emoji} · expiră la{' '}
                {new Date(Date.now() + result.expiresInSec * 1000).toLocaleTimeString('ro-RO')}
              </p>
              <p className="mt-2 break-all rounded-lg bg-black/30 p-2 font-mono text-[9px] text-zinc-400" title="Token JWT-lite (semnat HMAC)">
                {result.token.slice(0, 64)}…
              </p>
            </div>
            <Button onClick={onClose} className="h-10 w-full bg-rose-600 text-sm font-bold hover:bg-rose-500">
              Gata
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            <PinPad value={pin} onChange={setPin} label="Cod de acces" />
            <Button
              onClick={() => void verify()}
              disabled={busy || pin.length !== 4}
              className="h-11 w-full bg-rose-600 text-sm font-bold hover:bg-rose-500"
            >
              {busy ? 'Verificăm…' : 'Deblochează profilul'}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/* --------------------------------- the panel -------------------------------- */

export function ProfilesPanel() {
  const { user } = useAuth();
  const listRes = useApi(
    `perso-profiles-${user?.id ?? 'anon'}`,
    () => api.persoProfiles(user?.id),
    { enabled: Boolean(user) },
  );
  const [edit, setEdit] = useState<EditState | null>(null);
  const [verifyTarget, setVerifyTarget] = useState<PersoAccountProfile | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  if (!user) return <PersoLoginPrompt />;

  const profiles = listRes.data?.profiles ?? [];
  const max = listRes.data?.max ?? MAX_PROFILES;

  const remove = async (p: PersoAccountProfile) => {
    if (deleting) return;
    setDeleting(p.id);
    try {
      await api.persoProfileDelete(p.id, user.id);
      toast.success(`Profilul „${p.name}" a fost șters`);
      await listRes.refetch();
    } catch (e) {
      toast.error('Ștergerea a eșuat', {
        description: e instanceof ApiError ? e.message : 'backend-ul nu răspunde',
      });
    } finally {
      setDeleting(null);
    }
  };

  if (listRes.loading && !listRes.data) {
    return (
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5" aria-busy="true">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-52 rounded-xl" />
        ))}
      </div>
    );
  }
  if (listRes.error) {
    const needLogin = listRes.error.toLowerCase().includes('autentificare');
    if (needLogin) return <PersoLoginPrompt />;
    return (
      <div role="alert" className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
        Profilele nu au putut fi încărcate: {listRes.error}
        <div className="mt-2">
          <PersoRefreshButton onClick={() => void listRes.refetch()} loading={listRes.loading} label="Reîncearcă" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <PersoCountBadge tone="rose">
            {profiles.length}/{max} profiluri
          </PersoCountBadge>
          <span className="text-[11px] text-zinc-600">PIN-urile se stochează doar hash-uite (sha256 + salt)</span>
        </div>
        <div className="flex items-center gap-2">
          <PersoRefreshButton onClick={() => void listRes.refetch()} loading={listRes.loading} />
          <Button
            type="button"
            onClick={() => setEdit({ mode: 'create', name: '', emoji: EMOJIS[0], pin: '', oldPin: '', removePin: false, hasPin: false })}
            disabled={profiles.length >= max}
            className="h-9 gap-1.5 bg-rose-600 text-xs font-bold hover:bg-rose-500"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden />
            Profil nou
          </Button>
        </div>
      </div>

      {profiles.length === 0 ? (
        <PersoCard>
          <div className="py-8 text-center">
            <span className="text-3xl" aria-hidden>👥</span>
            <p className="mt-2 text-sm font-bold text-zinc-200">Niciun profil încă</p>
            <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-zinc-500">
              Creează profiluri separate pentru membrii familiei — fiecare cu avatarul lui și, opțional, un PIN
              de 4 cifre. Primul profil creat devine profilul principal al contului.
            </p>
            <Button
              onClick={() => setEdit({ mode: 'create', name: '', emoji: EMOJIS[0], pin: '', oldPin: '', removePin: false, hasPin: false })}
              className="mt-4 h-10 bg-rose-600 text-sm font-bold hover:bg-rose-500"
            >
              <Plus className="mr-1.5 h-4 w-4" aria-hidden />
              Creează primul profil
            </Button>
          </div>
        </PersoCard>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {profiles.map((p) => (
            <article
              key={p.id}
              className="flex flex-col items-center gap-2 rounded-xl border border-white/10 bg-white/[0.03] p-4 text-center transition hover:border-white/25"
            >
              <span className="grid h-16 w-16 place-items-center rounded-2xl border border-white/10 bg-white/[0.04] text-4xl leading-none" aria-hidden>
                {p.emoji}
              </span>
              <p className="min-w-0 w-full truncate text-sm font-bold text-zinc-100">{p.name}</p>
              <div className="flex flex-wrap items-center justify-center gap-1">
                {p.isMain ? <PersoCountBadge tone="emerald">principal</PersoCountBadge> : null}
                {p.hasPin ? (
                  <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-bold text-amber-300">
                    🔒 PIN
                  </span>
                ) : (
                  <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] font-semibold text-zinc-500">
                    fără PIN
                  </span>
                )}
              </div>
              <p className="text-[10px] text-zinc-600">
                creat {p.createdAt ? new Date(p.createdAt).toLocaleDateString('ro-RO') : '—'}
              </p>

              <div className="mt-auto flex w-full flex-col gap-1.5 pt-2">
                {p.hasPin ? (
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => setVerifyTarget(p)}
                    className="h-8 w-full bg-rose-600 text-xs font-bold hover:bg-rose-500"
                  >
                    <KeyRound className="mr-1 h-3 w-3" aria-hidden />
                    Intră
                  </Button>
                ) : null}
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    setEdit({
                      mode: 'edit',
                      profileId: p.id,
                      name: p.name,
                      emoji: p.emoji,
                      pin: '',
                      oldPin: '',
                      removePin: false,
                      hasPin: p.hasPin,
                    })
                  }
                  className="h-8 w-full border-white/15 bg-white/5 text-xs font-semibold text-zinc-300 hover:bg-white/10 hover:text-white"
                >
                  <Pencil className="mr-1 h-3 w-3" aria-hidden />
                  Editează
                </Button>
                {!p.isMain ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => void remove(p)}
                    disabled={deleting === p.id}
                    className="h-8 w-full border-rose-500/25 bg-rose-500/[0.06] text-xs font-semibold text-rose-300 hover:bg-rose-500/15"
                  >
                    <Trash2 className="mr-1 h-3 w-3" aria-hidden />
                    Șterge
                  </Button>
                ) : null}
              </div>
            </article>
          ))}
        </div>
      )}

      <PersoHonestNote>
        Profilurile multiple sunt un strat de personalizare per cont — max {max}, stocate file-based în
        backend (data/perso). PIN-ul e opțional și protejează profilul la intrare; hash-ul nu circulă
        niciodată prin API.
      </PersoHonestNote>

      <ProfileDialog
        state={edit}
        onClose={() => setEdit(null)}
        onSaved={() => void listRes.refetch()}
        userId={user.id}
      />
      <VerifyDialog profile={verifyTarget} onClose={() => setVerifyTarget(null)} userId={user.id} />
    </div>
  );
}
