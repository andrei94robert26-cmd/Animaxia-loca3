/**
 * screens/ProfileScreen.tsx — Account hub (auth-gated route /profile).
 *
 * Desktop port of the FAZA 6 mobile Profile tab, laid out as a 2-column card
 * grid (stacked on narrow windows):
 *
 *   • Identity    avatar upload (hidden file input → useProfileActions),
 *                 username + email, ADMIN badge, member-since
 *   • Plan        current plan badge + live limits (mobile:profile BFF) +
 *                 "Manage plan" → /premium
 *   • Library     watchlist / history / comments counters
 *   • Continue    profile/HistoryList (direct /me/history fetch)
 *   • Taste       types · genres · franchises chip editor → PUT preferences
 *   • Notifications  profile/NotificationSettings (+ premium renewal sync)
 *   • Connection  API target override (gateway/monolith/custom URL)
 *   • App         Electron version/platform/data folder (bridge info)
 *   • Session     sign out
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Camera, Crown, LogOut, Monitor, Server, WifiOff } from 'lucide-react';
import { useAuth } from '@/auth/AuthContext';
import { getProfileCached } from '@/api/mobile';
import type { PlanLimits } from '@/api/mobile';
import { getMe } from '@/api/users';
import { apiTargetLabel, setApiUrlOverride } from '@/api/config';
import { useApi } from '@/hooks/useApi';
import { Avatar, Badge, Button, Input, SectionHeader } from '@/components/primitives';
import { EmptyState, ErrorState, LoadingState, Skeleton } from '@/components/states';
import { NotificationSettings } from '@/profile/NotificationSettings';
import { HistoryList } from '@/profile/HistoryList';
import { useProfileActions } from '@/profile/useProfileActions';
import { planTone } from '@/premium/plans';
import { planLabel } from '@/utils/format';
import styles from './ProfileScreen.module.css';

/* -------------------------------- constants -------------------------------- */

const TYPE_OPTIONS = ['anime', 'movie', 'sport', 'news'];
const GENRE_OPTIONS = ['Action', 'Comedy', 'Drama', 'Fantasy', 'Sci-Fi', 'Slice of Life', 'Thriller'];
const FRANCHISE_OPTIONS = ['One Piece', 'Naruto', 'Dragon Ball', 'Demon Slayer', 'Jujutsu Kaisen', 'Attack on Titan'];
const FALLBACK_LIMITS: PlanLimits = { watchlist: 20, history: 50, aiPerDay: 10, quality: 'sd' };

type AppInfo = Awaited<ReturnType<AnimaxiaBridge['app']['getInfo']>>;

interface TasteDraft {
  types: string[];
  genres: string[];
  franchises: string[];
}

/* --------------------------------- helpers ---------------------------------- */

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

function formatMemberSince(iso: string | null): string {
  if (!iso) return 'unknown date';
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return 'unknown date';
  return date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

function formatPeriodEnd(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '';
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/* ------------------------------- small pieces ------------------------------- */

function LimitTile({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className={styles.limitTile}>
      <span className={styles.limitValue}>{value}</span>
      <span className={styles.limitLabel}>{label}</span>
    </div>
  );
}

function StatTile({ label, value }: { label: string; value: number | string }): React.JSX.Element {
  return (
    <div className={styles.statTile}>
      <span className={styles.statValue}>{value}</span>
      <span className={styles.statLabel}>{label}</span>
    </div>
  );
}

/** One chip group of the taste editor — known options + optional add input. */
function ChipGroup({
  title,
  known,
  selected,
  onToggle,
  onAdd,
  addPlaceholder,
}: {
  title: string;
  known: string[];
  selected: string[];
  onToggle: (value: string) => void;
  onAdd?: (value: string) => void;
  addPlaceholder?: string;
}): React.JSX.Element {
  const [custom, setCustom] = useState('');
  const options = Array.from(new Set([...known, ...selected]));

  const submit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const value = custom.trim();
    if (!value || !onAdd) return;
    onAdd(value);
    setCustom('');
  };

  return (
    <div className={styles.prefGroup}>
      <div className={styles.prefGroupTitle}>{title}</div>
      <div className="row row--wrap">
        {options.map((option) => {
          const on = selected.includes(option);
          return (
            <button
              key={option}
              type="button"
              className={`chip${on ? ' chip--on' : ''}`}
              aria-pressed={on}
              onClick={() => onToggle(option)}
            >
              {option}
            </button>
          );
        })}
      </div>
      {onAdd ? (
        <form className={styles.addForm} onSubmit={submit}>
          <input
            className={`input ${styles.addInput}`}
            value={custom}
            onChange={(event) => setCustom(event.target.value)}
            placeholder={addPlaceholder ?? `Add ${title.toLowerCase()}…`}
            maxLength={40}
            aria-label={`Add ${title}`}
          />
          <Button size="sm" variant="ghost" type="submit" disabled={custom.trim().length === 0}>
            Add
          </Button>
        </form>
      ) : null}
    </div>
  );
}

/** API connection card — runtime API base override (custom gateway/monolith). */
function ConnectionCard(): React.JSX.Element {
  const [label, setLabel] = useState<string>(apiTargetLabel());
  const [url, setUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const apply = (): void => {
    const trimmed = url.trim().replace(/\/+$/, '');
    if (!trimmed) {
      setError('Enter an API base URL first.');
      return;
    }
    if (!/^https?:\/\/.+/i.test(trimmed)) {
      setError('The URL must start with http:// or https://');
      return;
    }
    setApiUrlOverride(trimmed);
    setLabel(apiTargetLabel());
    setError(null);
    setNote(`Saved — Animaxia now talks to ${trimmed}.`);
    setUrl('');
  };

  const reset = (): void => {
    setApiUrlOverride(null);
    setLabel(apiTargetLabel());
    setUrl('');
    setError(null);
    setNote('Reset — back to the default target.');
  };

  return (
    <section className="card stack">
      <div className={styles.cardHead}>
        <Server size={16} color="var(--text-dim)" />
        <div className={styles.cardTitle}>Connection</div>
      </div>
      <div className={`mono ${styles.targetRow}`} title={label}>
        API: {label}
      </div>
      <Input
        label="Custom API URL"
        value={url}
        placeholder="http://192.168.1.20:8080"
        spellCheck={false}
        error={error}
        hint={note ?? 'Point Animaxia at your own gateway or monolith.'}
        onChange={(event) => setUrl(event.target.value)}
      />
      <div className="row row--wrap">
        <Button size="sm" onClick={apply}>
          Save &amp; use
        </Button>
        <Button size="sm" variant="ghost" onClick={reset}>
          Reset to default
        </Button>
      </div>
      <p className="dim">Changes apply immediately; reload the app (View → Reload) to re-fetch everything.</p>
    </section>
  );
}

/** Electron build info (desktop-only card; graceful outside Electron). */
function AppInfoCard(): React.JSX.Element {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const bridge = typeof window !== 'undefined' ? window.animaxia : undefined;
    if (!bridge) {
      setFailed(true);
      return undefined;
    }
    bridge.app
      .getInfo()
      .then((payload) => {
        if (!cancelled) setInfo(payload);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="card stack">
      <div className={styles.cardHead}>
        <Monitor size={16} color="var(--text-dim)" />
        <div className={styles.cardTitle}>App</div>
      </div>
      {failed ? (
        <p className="dim">App info is unavailable — Animaxia appears to be running outside Electron.</p>
      ) : info ? (
        <>
          <div className={styles.infoGrid}>
            <div className={styles.infoTile}>
              <div className="dim">Version</div>
              <div className={`mono ${styles.infoValue}`}>v{info.version}</div>
            </div>
            <div className={styles.infoTile}>
              <div className="dim">Platform</div>
              <div className={`mono ${styles.infoValue}`}>{info.platform}</div>
            </div>
            <div className={styles.infoTile}>
              <div className="dim">Build</div>
              <div className={`mono ${styles.infoValue}`}>{info.isPackaged ? 'Packaged' : 'Development'}</div>
            </div>
          </div>
          <div>
            <div className="dim">Data folder</div>
            <div className={`mono ${styles.pathRow}`} title={info.userDataPath}>
              {info.userDataPath}
            </div>
          </div>
        </>
      ) : (
        <Skeleton h={72} radius={12} />
      )}
    </section>
  );
}

/** Sign-out card. */
function SessionCard({ onSignOut, busy }: { onSignOut: () => void; busy: boolean }): React.JSX.Element {
  return (
    <section className="card stack">
      <div className={styles.cardHead}>
        <LogOut size={16} color="var(--text-dim)" />
        <div className={styles.cardTitle}>Session</div>
      </div>
      <p className="dim">Sign out of Animaxia on this device. Your watchlist, history and plan stay synced to your account.</p>
      <Button variant="danger" loading={busy} onClick={onSignOut}>
        Sign out
      </Button>
    </section>
  );
}

/* ---------------------------------- screen ---------------------------------- */

export default function ProfileScreen(): React.JSX.Element {
  const { user, initializing, logout } = useAuth();
  const navigate = useNavigate();

  // mobile:profile BFF card — user · plan · limits · watchlistCount · history.
  const profile = useApi(user ? () => getProfileCached() : null, [user?.id]);
  // /api/users/me stats — the only source of the true history + comments counts.
  const stats = useApi(
    user ? () => getMe().then((res) => ({ data: res.stats, stale: false })) : null,
    [user?.id],
  );
  const actions = useProfileActions(profile.refetch);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [prefDraft, setPrefDraft] = useState<TasteDraft | null>(null);
  const [savedHint, setSavedHint] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  const handleAvatarChange = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = ''; // allow re-picking the same file
      if (!file) return;
      const updated = await actions.pickAvatar(file);
      if (updated) profile.refetch();
    },
    [actions, profile],
  );

  /* Settings changed → re-push the premium context so the renewal reminder
   * is re-planned by the main-process scheduler. */
  const handleNotificationSettings = useCallback(() => {
    const bridge = typeof window !== 'undefined' ? window.animaxia : undefined;
    if (!bridge || !user || !user.plan || user.plan === 'free') return;
    try {
      bridge.notifications.setPremium({ plan: user.plan, planExpiresAt: user.planexpiresat });
    } catch {
      /* best-effort — main re-reads settings.json on launch */
    }
  }, [user]);

  const handleSignOut = useCallback(async () => {
    setSigningOut(true);
    try {
      await logout();
    } finally {
      setSigningOut(false);
      navigate('/');
    }
  }, [logout, navigate]);

  if (initializing) {
    return <LoadingState label="Loading your profile…" />;
  }

  // AuthGate normally redirects first — safe fallback for direct deep links.
  if (!user) {
    return (
      <EmptyState
        title="Sign in to continue"
        hint="Sign in to sync your watchlist, history, plan and AI taste across Animaxia."
        action={<Button onClick={() => navigate('/auth?next=/profile')}>Sign in / Register</Button>}
      />
    );
  }

  const plan = profile.data?.plan ?? user.plan ?? 'free';
  const limits = profile.data?.limits ?? FALLBACK_LIMITS;
  const watchlistCount = profile.data?.watchlistCount ?? stats.data?.watchlist ?? '—';
  const historyCount = stats.data?.history ?? profile.data?.recentHistory.length ?? 0;
  const commentsCount = stats.data?.comments ?? '—';

  /* Taste draft: local selection until Save; falls back to the session user. */
  const prefsSource: Record<string, unknown> = user.preferences ?? {};
  const prefs: TasteDraft =
    prefDraft ??
    {
      types: stringList(prefsSource.types),
      genres: stringList(prefsSource.genres),
      franchises: stringList(prefsSource.franchises),
    };
  const dirty = prefDraft !== null;

  const togglePref = (key: keyof TasteDraft, value: string): void => {
    const current = prefs[key];
    const next = current.includes(value) ? current.filter((item) => item !== value) : [...current, value];
    setPrefDraft({ ...prefs, [key]: next });
  };

  const addPref = (key: keyof TasteDraft, value: string): void => {
    if (prefs[key].includes(value)) return;
    setPrefDraft({ ...prefs, [key]: [...prefs[key], value] });
  };

  const savePrefs = async (): Promise<void> => {
    if (!prefDraft) return;
    const ok = await actions.savePreferences({
      types: prefDraft.types,
      genres: prefDraft.genres,
      franchises: prefDraft.franchises,
    });
    if (ok) {
      setPrefDraft(null);
      setSavedHint(true);
      window.setTimeout(() => setSavedHint(false), 2600);
    }
  };

  return (
    <>
      <SectionHeader title="Profile" subtitle="Your identity, plan, taste and desktop settings" />

      {profile.stale ? (
        <div className="offline-banner" style={{ margin: '0 0 14px' }}>
          <WifiOff size={15} /> Offline — showing your cached profile.
        </div>
      ) : null}
      {profile.error ? <ErrorState message={profile.error} compact onRetry={profile.refetch} /> : null}
      {actions.error ? <ErrorState message={actions.error} compact onRetry={actions.clearError} /> : null}

      <div className={styles.grid}>
        {/* identity */}
        <section className={`card ${styles.identity} ${styles.span2}`}>
          <button
            type="button"
            className={styles.avatarButton}
            onClick={() => fileInputRef.current?.click()}
            disabled={actions.busy}
            aria-label="Change avatar"
            title="Change avatar"
          >
            <Avatar url={user.avatar} name={user.username} size={72} />
            <span className={styles.avatarBadge}>
              {actions.busy ? (
                <span className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} />
              ) : (
                <Camera size={12} />
              )}
            </span>
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(event) => void handleAvatarChange(event)}
          />
          <div className={styles.identityText}>
            <div className={styles.username}>{user.username}</div>
            <div className={styles.identityEmail}>{user.email}</div>
            <div className="row row--wrap">
              {user.role === 'admin' ? <Badge tone="amber">Admin</Badge> : null}
              <span className="dim">Member since {formatMemberSince(user.createdat)}</span>
            </div>
          </div>
        </section>

        {/* plan */}
        <section className="card stack">
          <div className={styles.cardHead}>
            <Crown size={16} color="var(--rose-soft)" />
            <div className={styles.cardTitle}>Plan</div>
            <Badge tone={planTone(plan)}>{planLabel(plan)}</Badge>
          </div>
          <div className={styles.limitGrid}>
            <LimitTile label="Watchlist" value={limits.watchlist < 0 ? '∞' : String(limits.watchlist)} />
            <LimitTile label="History" value={limits.history < 0 ? '∞' : String(limits.history)} />
            <LimitTile label="AI / day" value={String(limits.aiPerDay)} />
            <LimitTile label="Quality" value={String(limits.quality).toUpperCase()} />
          </div>
          <div className="row row--wrap">
            <Button size="sm" onClick={() => navigate('/premium')}>
              <Crown size={14} /> Manage plan
            </Button>
            {user.planexpiresat ? (
              <span className="dim">Renews {formatPeriodEnd(user.planexpiresat)}</span>
            ) : null}
          </div>
        </section>

        {/* library stats */}
        <section className="card stack">
          <div className={styles.cardHead}>
            <div className={styles.cardTitle}>Library</div>
            <Button size="sm" variant="ghost" onClick={() => navigate('/watchlist')}>
              Open watchlist
            </Button>
          </div>
          <div className={styles.statsGrid}>
            <StatTile label="Watchlist" value={watchlistCount} />
            <StatTile label="History" value={historyCount} />
            <StatTile label="Comments" value={commentsCount} />
          </div>
        </section>

        {/* continue watching */}
        <section className={styles.span2}>
          <SectionHeader title="Continue watching" subtitle="Pick up where you left off" />
          <HistoryList />
        </section>

        {/* taste preferences */}
        <section className={`card stack ${styles.span2}`}>
          <div className={styles.cardHead}>
            <div className={styles.cardHeadText}>
              <div className={styles.cardTitle}>Your taste — feeds the AI</div>
              <div className="dim">Personal recommendations and the AI feed use these picks.</div>
            </div>
            {dirty || savedHint ? (
              <div className={styles.prefFooter}>
                {savedHint && !dirty ? <span className={styles.savedHint}>Saved</span> : null}
                <Button size="sm" loading={actions.busy} disabled={!dirty} onClick={() => void savePrefs()}>
                  Save preferences
                </Button>
              </div>
            ) : null}
          </div>
          <ChipGroup
            title="Content types"
            known={TYPE_OPTIONS}
            selected={prefs.types}
            onToggle={(value) => togglePref('types', value)}
          />
          <ChipGroup
            title="Genres"
            known={GENRE_OPTIONS}
            selected={prefs.genres}
            onToggle={(value) => togglePref('genres', value)}
            onAdd={(value) => addPref('genres', value)}
            addPlaceholder="Add a genre…"
          />
          <ChipGroup
            title="Franchises"
            known={FRANCHISE_OPTIONS}
            selected={prefs.franchises}
            onToggle={(value) => togglePref('franchises', value)}
            onAdd={(value) => addPref('franchises', value)}
            addPlaceholder="Add a franchise…"
          />
        </section>

        {/* notifications */}
        <NotificationSettings onSettingsChange={handleNotificationSettings} />

        {/* connection + app + session */}
        <ConnectionCard />
        <AppInfoCard />
        <SessionCard onSignOut={() => void handleSignOut()} busy={signingOut} />
      </div>
    </>
  );
}
