'use client';

/**
 * profile-view.tsx — #/profile: account header with avatar upload (≤512 KB
 * data-URL), usage stats, and the Overview / Watchlist / History /
 * Preferences tabs. Auth-gated: initializing shows a full-page skeleton,
 * signed-out visitors get a sign-in prompt. Deep link: #/profile?tab=…
 */

import { useRef, useState } from 'react';
import {
  ArrowRight,
  Bookmark,
  BookmarkMinus,
  Bot,
  CalendarDays,
  Camera,
  Check,
  Clock,
  Copy,
  Crown,
  History as HistoryIcon,
  KeyRound,
  Loader2,
  Lock,
  MessageSquare,
  Play,
  Rss,
  ShieldCheck,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/components/animaxia/auth-provider';
import { dbToItem } from '@/lib/animaxia/api';
import { useApi } from '@/lib/animaxia/hooks';
import { navigate, type AppRoute } from '@/lib/animaxia/router';
import { platform } from '@/lib/animaxia/platform';
import type { HistoryEntry, PlatformUser, Preferences } from '@/lib/animaxia/platform';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import { ContentCard } from '../content-card';
import { Container, Section } from '../section';
import { EmptyState, ErrorState, LoadingCards, TypeBadge } from '../states';

/* ------------------------------ local helpers ------------------------------ */

const AVATAR_MIME_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const AVATAR_MAX_BYTES = 512 * 1024;
const PREFERENCE_TYPES = ['anime', 'movie', 'tv', 'sports', 'news', 'mined'];
const PROFILE_TABS = ['overview', 'watchlist', 'history', 'preferences', 'settings'] as const;
type ProfileTab = (typeof PROFILE_TABS)[number];

function cap(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function isAvatarSrc(avatar: string | null | undefined): avatar is string {
  return Boolean(avatar && (avatar.startsWith('data:') || avatar.startsWith('http')));
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function relativeTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return '—';
  const diff = Math.max(0, Date.now() - time);
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

function formatSeconds(total: number): string {
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

function normalizePrefs(p: Preferences | null | undefined): Required<Preferences> {
  return { types: p?.types ?? [], genres: p?.genres ?? [], franchises: p?.franchises ?? [] };
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

/* ------------------------------ avatar header ------------------------------ */

function AvatarHeader({ user, isAdmin }: { user: PlatformUser; isAdmin: boolean }) {
  const { setUser } = useAuth();
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  async function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-selecting the same file immediately
    if (!file || uploading) return;
    if (!AVATAR_MIME_TYPES.includes(file.type)) {
      toast.error('Imagine nesuportată — folosește PNG, JPEG, GIF sau WebP.');
      return;
    }
    if (file.size > AVATAR_MAX_BYTES) {
      toast.error('Imagine prea mare — dimensiunea maximă este 512 KB.');
      return;
    }
    const dataUrl = await new Promise<string | null>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    });
    if (!dataUrl) {
      toast.error('Nu am putut citi fișierul — încearcă altă imagine.');
      return;
    }
    setUploading(true);
    try {
      const res = await platform.uploadAvatar(dataUrl);
      setUser(res.user);
      toast.success('Avatar actualizat');
    } catch (err) {
      toast.error(errorMessage(err, 'Încărcarea avatarului a eșuat'));
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-6">
      <div className="flex flex-col gap-6 sm:flex-row sm:items-center sm:gap-8">
        <div className="relative w-fit shrink-0">
          <Avatar className="h-20 w-20 border-2 border-white/15 shadow-lg shadow-black/40">
            {isAvatarSrc(user.avatar) ? <AvatarImage src={user.avatar} alt={`Avatarul lui ${user.username}`} /> : null}
            <AvatarFallback className="bg-gradient-to-br from-rose-500 to-fuchsia-600 text-2xl font-black text-white">
              {user.username.slice(0, 2).toUpperCase()}
            </AvatarFallback>
          </Avatar>
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={uploading}
            aria-label="Încarcă un avatar nou"
            title="Încarcă un avatar nou (PNG, JPEG, GIF sau WebP — max 512 KB)"
            className="absolute -bottom-1 -right-1 grid h-9 w-9 place-items-center rounded-full border border-white/20 bg-[#12121c] text-zinc-200 shadow-lg transition hover:border-rose-500/50 hover:text-rose-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/60 disabled:opacity-60"
          >
            {uploading ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <Camera className="h-4 w-4" aria-hidden />
            )}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            onChange={(e) => void onFileChange(e)}
            className="hidden"
            tabIndex={-1}
            aria-hidden
          />
        </div>

        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
            <h1 className="text-2xl font-black tracking-tight text-white">{user.username}</h1>
            {user.plan !== 'free' ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-0.5 text-xs font-bold text-amber-300">
                <Crown className="h-3 w-3" aria-hidden />
                {cap(user.plan)}
              </span>
            ) : (
              <span className="inline-flex items-center rounded-full border border-white/10 bg-white/5 px-2.5 py-0.5 text-xs font-bold text-zinc-400">
                FREE
              </span>
            )}
            {isAdmin && (
              <span className="rounded-full bg-rose-500/20 px-2.5 py-0.5 text-xs font-bold text-rose-300">ADMIN</span>
            )}
          </div>
          <p className="truncate text-sm text-zinc-400">{user.email}</p>
          <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-500">
            <span className="inline-flex items-center gap-1.5">
              <CalendarDays className="h-3.5 w-3.5" aria-hidden />
              Membru din {formatDate(user.createdat)}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Clock className="h-3.5 w-3.5" aria-hidden />
              Ultima conectare {relativeTime(user.lastloginat)}
            </span>
          </p>
        </div>
      </div>
    </div>
  );
}

/* --------------------------------- stats ---------------------------------- */

function StatCard({
  icon: Icon,
  label,
  value,
  loading,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: number | undefined;
  loading: boolean;
}) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 sm:p-5">
      {loading ? (
        <div className="space-y-2.5" aria-busy="true">
          <Skeleton className="h-5 w-5 rounded-md" />
          <Skeleton className="h-7 w-16" />
          <Skeleton className="h-3.5 w-20" />
        </div>
      ) : (
        <div className="flex items-start gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-rose-500/10 text-rose-300">
            <Icon className="h-4.5 w-4.5" aria-hidden />
          </span>
          <div className="min-w-0">
            <p className="text-xl font-black leading-tight text-white sm:text-2xl">{value ?? 0}</p>
            <p className="mt-0.5 text-xs font-medium text-zinc-500">{label}</p>
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------ history rows ------------------------------- */

function HistoryRow({ entry }: { entry: HistoryEntry }) {
  const content = entry.content;
  return (
    <div className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] p-3 transition hover:border-rose-500/30 sm:gap-4 sm:p-4">
      {content.thumbnail ? (
        <img
          src={content.thumbnail}
          alt=""
          loading="lazy"
          className="h-24 w-16 shrink-0 rounded-lg border border-white/10 object-cover"
        />
      ) : (
        <div className="grid h-24 w-16 shrink-0 place-items-center rounded-lg border border-white/10 bg-gradient-to-br from-white/[0.08] to-white/[0.02] text-zinc-600">
          <Play className="h-5 w-5" aria-hidden />
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <button
            type="button"
            onClick={() => navigate(`/content/${content.id}`)}
            className="truncate text-left text-sm font-bold text-zinc-100 transition hover:text-rose-300 sm:text-base"
          >
            {content.title}
          </button>
          <TypeBadge type={content.type} />
        </div>
        <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-zinc-500">
          <span className="inline-flex items-center gap-1">
            <Clock className="h-3.5 w-3.5" aria-hidden />
            {formatSeconds(entry.progress)} vizionate
          </span>
          <span>{relativeTime(entry.watchedat)}</span>
        </p>
      </div>
      <Button
        size="sm"
        variant="outline"
        onClick={() => navigate(`/player/${content.id}`)}
        aria-label={`Reia ${content.title}`}
        className="h-9 shrink-0 border-rose-500/30 bg-rose-500/10 font-semibold text-rose-300 hover:bg-rose-500/20 hover:text-rose-200"
      >
        <Play className="h-3.5 w-3.5 fill-rose-300" aria-hidden />
        Reia
      </Button>
    </div>
  );
}

/* ------------------------------- overview tab ------------------------------ */

const QUICK_LINKS: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
  href: string;
  accent: string;
}[] = [
  {
    icon: Crown,
    title: 'Premium',
    description: 'Compară planurile, fă upgrade și administrează-ți abonamentul.',
    href: '/premium',
    accent: 'bg-amber-500/10 text-amber-300',
  },
  {
    icon: Rss,
    title: 'Feed de activitate',
    description: 'Ce vizionează, ce apreciază și ce spune comunitatea.',
    href: '/feed',
    accent: 'bg-fuchsia-500/10 text-fuchsia-300',
  },
  {
    icon: Bot,
    title: 'Hub AI',
    description: 'Recomandări reglate pe preferințele de mai jos.',
    href: '/ai',
    accent: 'bg-rose-500/10 text-rose-300',
  },
];

function OverviewTab() {
  const recent = useApi('profile-history-5', () => platform.history(5));

  return (
    <div className="space-y-8">
      <div className="grid gap-4 sm:grid-cols-3">
        {QUICK_LINKS.map((link) => {
          const Icon = link.icon;
          return (
            <button
              key={link.href}
              type="button"
              onClick={() => navigate(link.href)}
              className="group flex items-center gap-4 rounded-2xl border border-white/10 bg-white/[0.03] p-5 text-left transition hover:border-rose-500/40 hover:bg-white/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/60"
            >
              <span className={cn('grid h-11 w-11 shrink-0 place-items-center rounded-xl', link.accent)}>
                <Icon className="h-5 w-5" aria-hidden />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5 text-sm font-bold text-white">
                  {link.title}
                  <ArrowRight
                    className="h-3.5 w-3.5 text-zinc-500 transition group-hover:translate-x-0.5 group-hover:text-rose-300"
                    aria-hidden
                  />
                </span>
                <span className="mt-0.5 block text-xs leading-relaxed text-zinc-400">{link.description}</span>
              </span>
            </button>
          );
        })}
      </div>

      <Section title="Vizionate recent" subtitle="Continuă exact de unde ai rămas.">
        {recent.loading ? (
          <div className="space-y-3" aria-busy="true" aria-label="Se încarcă istoricul de vizionare">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-[120px] rounded-xl" />
            ))}
          </div>
        ) : recent.error ? (
          <ErrorState message={recent.error} onRetry={() => void recent.refetch()} />
        ) : (recent.data?.data ?? []).length === 0 ? (
          <EmptyState
            icon={<HistoryIcon className="h-6 w-6" aria-hidden />}
            title="Încă nimic vizionat"
            message="Redă ceva și progresul tău va apărea aici."
            action={
              <Button
                onClick={() => navigate('/home')}
                className="bg-rose-600 font-bold hover:bg-rose-500"
              >
                Răsfoiește titluri
              </Button>
            }
          />
        ) : (
          <div className="space-y-3">
            {(recent.data?.data ?? []).map((entry) => (
              <HistoryRow key={`${entry.content.id}-${entry.watchedat}`} entry={entry} />
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}

/* ------------------------------ watchlist tab ------------------------------ */

function WatchlistTab() {
  const watchlist = useApi('profile-watchlist', () => platform.watchlist());
  const [removingId, setRemovingId] = useState<number | null>(null);

  async function remove(contentId: number, title: string) {
    setRemovingId(contentId);
    try {
      await platform.removeWatchlist(contentId);
      toast.success(`„${title}” a fost eliminat din Lista Mea`);
      await watchlist.refetch();
    } catch (err) {
      toast.error(errorMessage(err, 'Nu am putut elimina titlul'));
    } finally {
      setRemovingId(null);
    }
  }

  if (watchlist.loading) return <LoadingCards count={6} />;
  if (watchlist.error) return <ErrorState message={watchlist.error} onRetry={() => void watchlist.refetch()} />;

  const entries = watchlist.data?.data ?? [];
  if (entries.length === 0) {
    return (
      <EmptyState
        icon={<BookmarkMinus className="h-6 w-6" aria-hidden />}
        title="Lista Mea e goală"
        message="Salvează filmele, serialele și animele pe care vrei să le vizionezi următoarele."
        action={
          <Button onClick={() => navigate('/home')} className="bg-rose-600 font-bold hover:bg-rose-500">
            Răsfoiește titluri
          </Button>
        }
      />
    );
  }

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
      {entries.map((entry) => {
        const item = dbToItem(entry.content);
        return (
          <div key={item.key} className="group/card relative">
            <ContentCard item={item} />
            <button
              type="button"
              onClick={() => void remove(entry.content.id, entry.content.title)}
              disabled={removingId === entry.content.id}
              aria-label={`Remove ${entry.content.title} from watchlist`}
              title={`Remove ${entry.content.title} from watchlist`}
              className="absolute right-2 top-2 z-10 grid h-9 w-9 place-items-center rounded-full border border-white/10 bg-black/70 text-rose-300 backdrop-blur-sm transition hover:border-rose-500/50 hover:bg-rose-600 hover:text-white focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/60 disabled:opacity-60 sm:opacity-0 sm:group-hover/card:opacity-100"
            >
              {removingId === entry.content.id ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <BookmarkMinus className="h-4 w-4" aria-hidden />
              )}
            </button>
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------- history tab ------------------------------- */

function HistoryTab() {
  const history = useApi('profile-history-30', () => platform.history(30));

  if (history.loading) {
    return (
      <div className="space-y-3" aria-busy="true" aria-label="Se încarcă istoricul de vizionare">
        {[0, 1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-[120px] rounded-xl" />
        ))}
      </div>
    );
  }
  if (history.error) return <ErrorState message={history.error} onRetry={() => void history.refetch()} />;

  const entries = history.data?.data ?? [];
  if (entries.length === 0) {
    return (
      <EmptyState
        icon={<HistoryIcon className="h-6 w-6" aria-hidden />}
        title="Încă niciun istoric de vizionare"
        message="Tot ce redai ajunge aici, cu progresul tău."
        action={
          <Button onClick={() => navigate('/home')} className="bg-rose-600 font-bold hover:bg-rose-500">
            Răsfoiește titluri
          </Button>
        }
      />
    );
  }

  return (
    <div className="space-y-3">
      {entries.map((entry) => (
        <HistoryRow key={`${entry.content.id}-${entry.watchedat}`} entry={entry} />
      ))}
    </div>
  );
}

/* ----------------------------- preferences tab ----------------------------- */

function ChipInput({
  id,
  label,
  placeholder,
  values,
  onAdd,
  onRemove,
}: {
  id: string;
  label: string;
  placeholder: string;
  values: string[];
  onAdd: (value: string) => void;
  onRemove: (value: string) => void;
}) {
  const [text, setText] = useState('');

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const value = text.trim();
    if (!value) return;
    onAdd(value);
    setText('');
  }

  return (
    <div className="space-y-2.5">
      <Label htmlFor={id} className="text-sm font-semibold text-zinc-300">
        {label}
      </Label>
      <form onSubmit={submit} className="flex gap-2">
        <Input
          id={id}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={placeholder}
          aria-label={`Add ${label.toLowerCase()} value`}
          className="h-11 flex-1 border-white/10 bg-white/5 text-zinc-100 placeholder:text-zinc-500 focus-visible:ring-rose-500/50"
        />
        <Button
          type="submit"
          variant="outline"
          className="h-11 border-rose-500/30 bg-rose-500/10 px-5 font-semibold text-rose-300 hover:bg-rose-500/20 hover:text-rose-200"
        >
          Add
        </Button>
      </form>
      {values.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {values.map((value) => (
            <span
              key={value}
              className="inline-flex h-8 items-center gap-1 rounded-full border border-white/10 bg-white/[0.04] pl-3 pr-1.5 text-xs font-medium text-zinc-200"
            >
              {value}
              <button
                type="button"
                onClick={() => onRemove(value)}
                aria-label={`Remove ${value}`}
                className="grid h-5 w-5 place-items-center rounded-full text-zinc-500 transition hover:bg-rose-500/20 hover:text-rose-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/60"
              >
                <X className="h-3 w-3" aria-hidden />
              </button>
            </span>
          ))}
        </div>
      ) : (
        <p className="text-xs text-zinc-500">Nothing yet — add a few to sharpen your recommendations.</p>
      )}
    </div>
  );
}

function PreferencesTab({ user }: { user: PlatformUser }) {
  const [baseline, setBaseline] = useState<Required<Preferences>>(() => normalizePrefs(user.preferences));
  const [types, setTypes] = useState<string[]>(baseline.types);
  const [genres, setGenres] = useState<string[]>(baseline.genres);
  const [franchises, setFranchises] = useState<string[]>(baseline.franchises);
  const [saving, setSaving] = useState(false);

  const dirty =
    types.join('\u0000') !== baseline.types.join('\u0000') ||
    genres.join('\u0000') !== baseline.genres.join('\u0000') ||
    franchises.join('\u0000') !== baseline.franchises.join('\u0000');

  function toggleType(type: string) {
    setTypes((cur) => (cur.includes(type) ? cur.filter((t) => t !== type) : [...cur, type]));
  }

  function addValue(value: string, list: string[], setList: (next: string[]) => void, kind: string) {
    if (list.some((v) => v.toLowerCase() === value.toLowerCase())) return; // dedupe (case-insensitive)
    if (list.length >= 20) {
      toast.error(`You can save up to 20 ${kind}.`);
      return;
    }
    setList([...list, value]);
  }

  async function save() {
    if (saving || !dirty) return;
    setSaving(true);
    try {
      const res = await platform.putPreferences({ types, genres, franchises });
      const saved = normalizePrefs(res.preferences);
      setTypes(saved.types);
      setGenres(saved.genres);
      setFranchises(saved.franchises);
      setBaseline(saved);
      toast.success('Preferințe salvate');
    } catch (err) {
      toast.error(errorMessage(err, 'Nu am putut salva preferințele'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="max-w-2xl space-y-8">
      <p className="text-sm leading-relaxed text-zinc-400">
        Used by AI recommendations and your personal feed. The more you tell Animaxia, the better it gets at
        surfacing titles you&apos;ll actually finish.
      </p>

      {/* Content types */}
      <div className="space-y-2.5">
        <p className="text-sm font-semibold text-zinc-300">Content types</p>
        <div className="flex flex-wrap gap-2">
          {PREFERENCE_TYPES.map((type) => {
            const active = types.includes(type);
            return (
              <button
                key={type}
                type="button"
                onClick={() => toggleType(type)}
                aria-pressed={active}
                className={cn(
                  'inline-flex h-10 items-center gap-1.5 rounded-full border px-4 text-sm font-semibold capitalize transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/60',
                  active
                    ? 'border-rose-500/50 bg-rose-500/15 text-rose-300'
                    : 'border-white/10 bg-white/[0.03] text-zinc-400 hover:border-white/20 hover:text-zinc-200',
                )}
              >
                {type}
              </button>
            );
          })}
        </div>
      </div>

      {/* Genres */}
      <ChipInput
        id="pref-genres"
        label="Genuri"
        placeholder="ex. Sci-Fi, Shounen, Thriller…"
        values={genres}
        onAdd={(value) => addValue(value, genres, setGenres, 'genres')}
        onRemove={(value) => setGenres((cur) => cur.filter((g) => g !== value))}
      />

      {/* Franchises */}
      <ChipInput
        id="pref-franchises"
        label="Francize"
        placeholder="ex. Naruto, Marvel, Lord of the Rings…"
        values={franchises}
        onAdd={(value) => addValue(value, franchises, setFranchises, 'franchises')}
        onRemove={(value) => setFranchises((cur) => cur.filter((f) => f !== value))}
      />

      <div className="flex flex-wrap items-center gap-3 pt-1">
        <Button
          onClick={() => void save()}
          disabled={saving || !dirty}
          className="relative h-11 bg-rose-600 px-6 font-bold hover:bg-rose-500"
        >
          {saving ? <Loader2 className="animate-spin" aria-hidden /> : <Bookmark aria-hidden />}
          {saving ? 'Se salvează…' : 'Salvează preferințele'}
          {dirty && !saving && (
            <span
              className="absolute -right-1 -top-1 h-3 w-3 rounded-full bg-rose-400 ring-2 ring-[#0a0a10]"
              aria-hidden
            />
          )}
        </Button>
        {dirty && <p className="text-xs font-medium text-rose-300">Modificări nesalvate</p>}
      </div>
    </div>
  );
}

/* ------------------------------- settings tab ------------------------------ */

/** TS2b: 2FA TOTP — enrollment dialog (secret + otpauth:// + code proof)
   and the disable flow. State comes from /api/auth/me (twofaenabled). */
function SettingsTab({ user }: { user: PlatformUser }) {
  const { refreshUser } = useAuth();
  const twoFactorOn = user.twofaenabled === true;

  const [enrollOpen, setEnrollOpen] = useState(false);
  const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [starting, setStarting] = useState(false);
  const [enrollCode, setEnrollCode] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [disableCode, setDisableCode] = useState('');
  const [disabling, setDisabling] = useState(false);
  const [copied, setCopied] = useState(false);

  async function startEnrollment() {
    if (starting) return;
    setStarting(true);
    try {
      const res = await platform.twoFactorSetup();
      setSetup({ secret: res.secret, otpauthUrl: res.otpauthUrl });
      setEnrollCode('');
      setCopied(false);
      setEnrollOpen(true);
    } catch (err) {
      toast.error(errorMessage(err, 'Nu am putut porni configurarea 2FA'));
    } finally {
      setStarting(false);
    }
  }

  async function confirmEnrollment() {
    if (confirming || enrollCode.trim().length !== 6) return;
    setConfirming(true);
    try {
      await platform.twoFactorEnable(enrollCode.trim());
      toast.success('2FA activat — de acum vei avea nevoie de codul TOTP la conectare');
      setEnrollOpen(false);
      setSetup(null);
      await refreshUser();
    } catch (err) {
      toast.error(errorMessage(err, 'Cod invalid — verifică aplicația autentificatoare'));
    } finally {
      setConfirming(false);
    }
  }

  async function disableTwoFactor() {
    if (disabling || disableCode.trim().length !== 6) return;
    setDisabling(true);
    try {
      await platform.twoFactorDisable(disableCode.trim());
      toast.success('2FA a fost dezactivat');
      setDisableCode('');
      await refreshUser();
    } catch (err) {
      toast.error(errorMessage(err, 'Cod invalid — 2FA rămâne activ'));
    } finally {
      setDisabling(false);
    }
  }

  async function copySecret() {
    if (!setup) return;
    try {
      await navigator.clipboard.writeText(setup.secret);
      setCopied(true);
      toast.success('Secretul a fost copiat');
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error('Clipboardul nu este disponibil în acest browser');
    }
  }

  return (
    <div className="max-w-2xl space-y-8">
      {/* Account status */}
      <div className="space-y-2.5">
        <h3 className="text-sm font-bold text-zinc-300">Starea contului</h3>
        <div className="flex flex-wrap gap-2 text-xs">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-zinc-300">
            <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" aria-hidden />
            {user.emailverified ? 'Email verificat' : 'Email neverificat'}
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-zinc-300">
            <KeyRound className="h-3.5 w-3.5 text-rose-400" aria-hidden />
            {twoFactorOn ? '2FA activ (TOTP)' : '2FA inactiv'}
          </span>
        </div>
      </div>

      {/* 2FA section */}
      <div className="space-y-4 rounded-2xl border border-white/10 bg-white/[0.03] p-5 sm:p-6">
        <div>
          <h3 className="flex items-center gap-2 text-base font-bold text-white">
            <KeyRound className="h-4.5 w-4.5 text-rose-400" aria-hidden />
            Autentificare cu doi factori (2FA)
          </h3>
          <p className="mt-1.5 text-sm leading-relaxed text-zinc-400">
            Coduri TOTP la 30 de secunde (Google Authenticator, Authy, 1Password…). La conectare, după parolă ți se
            va cere codul curent — protecție reală chiar dacă parola îți este furată.
          </p>
        </div>

        {twoFactorOn ? (
          <div className="space-y-3">
            <p className="rounded-xl border border-emerald-500/25 bg-emerald-500/[0.07] px-3.5 py-2.5 text-sm text-emerald-200">
              2FA este <strong>activ</strong> pe acest cont. Pentru a-l dezactiva, confirmă un cod curent din
              aplicația autentificatoare.
            </p>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                value={disableCode}
                onChange={(e) => setEnrollDigits(setDisableCode, e.target.value)}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                placeholder="123456"
                aria-label="Cod TOTP pentru dezactivare"
                className="h-11 w-full border-white/10 bg-white/5 font-mono tracking-[0.3em] text-zinc-100 placeholder:tracking-normal sm:w-44"
              />
              <Button
                onClick={() => void disableTwoFactor()}
                disabled={disabling || disableCode.trim().length !== 6}
                variant="outline"
                className="h-11 border-red-500/30 bg-red-500/10 font-semibold text-red-300 hover:bg-red-500/20 hover:text-red-200"
              >
                {disabling ? <Loader2 className="animate-spin" aria-hidden /> : null}
                Dezactivează
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-zinc-500">
              Contul tău este protejat doar cu parolă. Activează 2FA pentru un al doilea factor la conectare.
            </p>
            <Button
              onClick={() => void startEnrollment()}
              disabled={starting}
              className="h-11 bg-rose-600 px-6 font-bold hover:bg-rose-500"
            >
              {starting ? <Loader2 className="animate-spin" aria-hidden /> : <KeyRound aria-hidden />}
              {starting ? 'Se pregătește…' : 'Activează 2FA'}
            </Button>
          </div>
        )}
      </div>

      {/* Enrollment dialog */}
      <Dialog open={enrollOpen} onOpenChange={setEnrollOpen}>
        <DialogContent className="max-w-lg border-white/10 bg-[#12121c] text-zinc-100">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <KeyRound className="h-5 w-5 text-rose-400" aria-hidden />
              Configurează 2FA
            </DialogTitle>
            <DialogDescription className="text-zinc-400">
              Adaugă contul în aplicația autentificatoare (scanând codul QR din URL-ul otpauth sau introducând
              secretul manual), apoi confirmă cu codul curent.
            </DialogDescription>
          </DialogHeader>
          {setup && (
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label className="text-xs font-semibold text-zinc-400">Secret (base32, 32 caractere)</Label>
                <div className="flex items-center gap-2">
                  <code className="flex-1 break-all rounded-lg border border-white/10 bg-black/40 px-3 py-2 font-mono text-sm text-rose-200">
                    {setup.secret}
                  </code>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    onClick={() => void copySecret()}
                    aria-label="Copiază secretul"
                    className="h-10 w-10 shrink-0 border-white/15 bg-white/5 hover:bg-white/10"
                  >
                    {copied ? <Check className="h-4 w-4 text-emerald-400" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
                  </Button>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-semibold text-zinc-400">URL otpauth (pentru QR)</Label>
                <p className="break-all rounded-lg border border-white/10 bg-black/40 px-3 py-2 font-mono text-[11px] leading-relaxed text-zinc-400">
                  {setup.otpauthUrl}
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="twofa-enroll-code" className="text-xs font-semibold text-zinc-400">
                  Cod curent (6 cifre)
                </Label>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Input
                    id="twofa-enroll-code"
                    value={enrollCode}
                    onChange={(e) => setEnrollDigits(setEnrollCode, e.target.value)}
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    placeholder="123456"
                    className="h-11 w-full border-white/10 bg-white/5 font-mono tracking-[0.3em] text-zinc-100 placeholder:tracking-normal sm:w-44"
                  />
                  <Button
                    onClick={() => void confirmEnrollment()}
                    disabled={confirming || enrollCode.trim().length !== 6}
                    className="h-11 bg-rose-600 px-6 font-bold hover:bg-rose-500"
                  >
                    {confirming ? <Loader2 className="animate-spin" aria-hidden /> : <ShieldCheck aria-hidden />}
                    {confirming ? 'Se verifică…' : 'Confirmă și activează'}
                  </Button>
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Only digits, max 6 — shared by the 2FA inputs. */
function setEnrollDigits(
  setter: React.Dispatch<React.SetStateAction<string>>,
  raw: string,
): void {
  setter(raw.replace(/\D/g, '').slice(0, 6));
}

/* ---------------------------------- view ---------------------------------- */

export function ProfileView({ route }: { route: AppRoute }) {
  const { user, initializing, isAdmin } = useAuth();
  const requestedTab = route.query.get('tab');
  const [tab, setTab] = useState<ProfileTab>(
    PROFILE_TABS.includes(requestedTab as ProfileTab) ? (requestedTab as ProfileTab) : 'overview',
  );

  const profile = useApi('profile-me', () => platform.profile(), { enabled: Boolean(user) });

  if (initializing) {
    return (
      <Container className="space-y-8 py-8 sm:py-10" aria-busy="true" aria-label="Se încarcă profilul">
        <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-6">
          <div className="flex flex-col gap-6 sm:flex-row sm:items-center">
            <Skeleton className="h-20 w-20 rounded-full" />
            <div className="flex-1 space-y-3">
              <Skeleton className="h-7 w-48" />
              <Skeleton className="h-4 w-64" />
              <Skeleton className="h-4 w-40" />
            </div>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-3 sm:gap-4">
          <Skeleton className="h-24 rounded-2xl sm:h-28" />
          <Skeleton className="h-24 rounded-2xl sm:h-28" />
          <Skeleton className="h-24 rounded-2xl sm:h-28" />
        </div>
        <Skeleton className="h-11 w-full max-w-md rounded-lg" />
        <LoadingCards count={6} />
      </Container>
    );
  }

  if (!user) {
    return (
      <Container className="flex min-h-[60vh] items-center justify-center py-10">
        <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-white/[0.03] p-8 text-center">
          <span className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-rose-500/10 text-rose-400">
            <Lock className="h-7 w-7" aria-hidden />
          </span>
          <h1 className="mt-4 text-xl font-black tracking-tight text-white">Conectează-te pentru a-ți vedea profilul</h1>
          <p className="mt-2 text-sm leading-relaxed text-zinc-400">
            Avatarul, lista, istoricul și preferințele tale locuiesc aici.
          </p>
          <Button
            onClick={() => navigate('/auth')}
            className="mt-6 h-11 w-full bg-rose-600 font-bold hover:bg-rose-500"
          >
            Conectare
          </Button>
        </div>
      </Container>
    );
  }

  const stats = profile.data?.stats;

  return (
    <Container className="space-y-8 py-8 sm:py-10">
      <AvatarHeader user={user} isAdmin={isAdmin} />

      {/* Stats */}
      {profile.error ? (
        <ErrorState message={profile.error} onRetry={() => void profile.refetch()} compact />
      ) : (
        <div className="grid grid-cols-3 gap-3 sm:gap-4">
          <StatCard icon={Bookmark} label="Titluri în Listă" value={stats?.watchlist} loading={profile.loading} />
          <StatCard icon={HistoryIcon} label="Intrări în istoric" value={stats?.history} loading={profile.loading} />
          <StatCard icon={MessageSquare} label="Comentarii postate" value={stats?.comments} loading={profile.loading} />
        </div>
      )}

      <Tabs value={tab} onValueChange={(value) => setTab(value as ProfileTab)} className="gap-6">
        <TabsList className="grid h-11 w-full max-w-xl grid-cols-5 bg-white/5 p-1 sm:w-fit sm:grid-cols-5">
          <TabsTrigger
            value="overview"
            className="h-9 text-xs font-semibold data-[state=active]:bg-rose-600 data-[state=active]:text-white sm:text-sm"
          >
            Prezentare generală
          </TabsTrigger>
          <TabsTrigger
            value="watchlist"
            className="h-9 text-xs font-semibold data-[state=active]:bg-rose-600 data-[state=active]:text-white sm:text-sm"
          >
            Lista Mea
          </TabsTrigger>
          <TabsTrigger
            value="history"
            className="h-9 text-xs font-semibold data-[state=active]:bg-rose-600 data-[state=active]:text-white sm:text-sm"
          >
            Istoric
          </TabsTrigger>
          <TabsTrigger
            value="preferences"
            className="h-9 text-xs font-semibold data-[state=active]:bg-rose-600 data-[state=active]:text-white sm:text-sm"
          >
            Preferințe
          </TabsTrigger>
          <TabsTrigger
            value="settings"
            className="h-9 text-xs font-semibold data-[state=active]:bg-rose-600 data-[state=active]:text-white sm:text-sm"
          >
            Setări
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview">
          <OverviewTab />
        </TabsContent>
        <TabsContent value="watchlist">
          <WatchlistTab />
        </TabsContent>
        <TabsContent value="history">
          <HistoryTab />
        </TabsContent>
        <TabsContent value="preferences">
          <PreferencesTab user={user} />
        </TabsContent>
        <TabsContent value="settings">
          <SettingsTab user={user} />
        </TabsContent>
      </Tabs>
    </Container>
  );
}

export default ProfileView;
