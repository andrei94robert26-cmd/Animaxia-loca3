'use client';

/**
 * home-panels.tsx — Platform panels from the product blueprint:
 *
 *  - PlatformHeroPanel      "PLATFORMĂ ALIMENTATĂ DE TINE" + badges (196 țări,
 *                           100% Neon, AI clasificare automată) + CTA
 *  - AddContentForm/Dialog  URL • Embed • iframe • JS ingestion (Animaxia Miner)
 *  - CommunityActivityPanel "Activitatea comunității — live din SQLite local"
 *  - NeonLibraryPanel       "🧠 Biblioteca ta locală — redare universală"
 *  - AiAnalysisPanel        "AI Analiză conținut" — LIVE, auto-refresh 60s
 *  - TaxonomyPanel          "Genuri & Categorii create automat de AI"
 *
 * FAZA 15 — AI Home engine panels (external loads + extracted metadata):
 *  - AiExternalAnalysisPanel "AI Analiză Externă — LIVE", auto-refresh 30s + delta
 *  - AiTaxonomyAutoPanel     Genuri & categorii din postere externe + z-ai narration
 *  - AiMetadataPanel         AI Extractor Metadata (coverage + 8 dimensions)
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BrainCircuit,
  CalendarDays,
  Clapperboard,
  Database,
  Globe2,
  Image as ImageIcon,
  Inbox,
  Layers,
  Link2,
  Loader2,
  Plus,
  RefreshCw,
  Rss,
  ShieldCheck,
  Sparkles,
  Upload,
  Users,
} from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Switch } from '@/components/ui/switch';
import { api, dbToItem } from '@/lib/animaxia/api';
import { useApi } from '@/lib/animaxia/hooks';
import { navigate } from '@/lib/animaxia/router';
import { social } from '@/lib/animaxia/social';
import type { ActivityEvent, SocialFeedResponse } from '@/lib/animaxia/social';
import type {
  AiExternalStatsResponse,
  AiMetaEntry,
  AiMetadataResponse,
  DbContent,
  IngestCheckResponse,
  MetaDimension,
  MinerExtraction,
} from '@/lib/animaxia/types';
import { useAiHomeSettings } from './ai-home-settings';
import { ContentGrid } from './content-grid';
import { Section } from './section';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState, TypeBadge } from './states';
import { cn } from '@/lib/utils';

/* ------------------------------ add content ------------------------------- */

export function AddContentForm({
  onAdded,
  compact = false,
}: {
  onAdded?: (record: DbContent, extraction: MinerExtraction) => void;
  compact?: boolean;
}) {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  /* FAZA 16 — registru anti-duplicat Neon: verificare înainte de adăugare. */
  const [dupCheck, setDupCheck] = useState<IngestCheckResponse | null>(null);
  const [checking, setChecking] = useState(false);
  const [forceAdd, setForceAdd] = useState(false);

  const onUrlChange = (value: string) => {
    setUrl(value);
    setDupCheck(null);
    setForceAdd(false);
  };

  const checkDuplicate = async () => {
    const trimmed = url.trim();
    if (!trimmed) return;
    setChecking(true);
    try {
      const res = await api.ingestCheck(trimmed);
      setDupCheck(res);
      if (res.exists) {
        toast.warning('Acest link există deja local', {
          description: `${res.source?.kind ?? 'sursă'} · ${res.source?.hits ?? 1} accesări — apasă din nou „Adaugă” dacă vrei să continui oricum.`,
        });
      } else {
        toast.success('Link nou — nu există duplicat local');
      }
    } catch {
      toast.error('Verificarea anti-duplicat a eșuat', { description: 'Backend-ul nu răspunde — poți continua oricum.' });
    } finally {
      setChecking(false);
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = url.trim();
    if (!trimmed) return;
    /* Confirmare dublă când linkul e deja înregistrat ca sursă. */
    if (dupCheck?.exists && !forceAdd) {
      setForceAdd(true);
      toast.warning('Link deja în SQLite — confirmă adăugarea', {
        description: 'Apasă din nou „Adaugă” pentru a adăuga totuși acest conținut.',
      });
      return;
    }
    setBusy(true);
    try {
      const result = await api.miner({ url: trimmed });
      const found =
        result.extraction.mp4.length +
        result.extraction.m3u8.length +
        result.extraction.iframe.length +
        result.extraction.youtube.length;
      toast.success(
        found > 0
          ? `Conținut adăugat — ${found} ${found === 1 ? 'sursă' : 'surse'} salvate local în SQLite, verificate anti-duplicat`
          : `Pagina a fost indexată local în SQLite (verificată anti-duplicat), dar nu am găsit surse video directe`,
        { description: result.record.title },
      );
      onUrlChange('');
      onAdded?.(result.record, result.extraction);
    } catch (err) {
      toast.error('Nu am putut încărca conținutul', {
        description: err instanceof Error ? err.message : 'Încearcă din nou într-un moment.',
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-2 sm:flex-row">
      <div className="relative flex-1">
        <Link2 className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" aria-hidden />
        <Input
          value={url}
          onChange={(e) => onUrlChange(e.target.value)}
          placeholder="Lipștește un link: MP4 / HLS / DASH, iframe, embed sau YouTube…"
          aria-label="URL conținut"
          className="h-11 border-white/10 bg-white/5 pl-9 text-sm text-zinc-100 placeholder:text-zinc-500"
        />
      </div>
      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={() => void checkDuplicate()}
          disabled={!url.trim() || checking}
          className="h-11 shrink-0 border-white/15 bg-white/5 px-3 font-semibold text-zinc-200 hover:bg-white/10 hover:text-white"
          aria-label="Verifică duplicat înainte de adăugare"
        >
          {checking ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          ) : (
            <ShieldCheck className="h-4 w-4 text-emerald-400" aria-hidden />
          )}
          <span className="hidden sm:inline">Verifică duplicat</span>
        </Button>
        <Button
          type="submit"
          disabled={busy || !url.trim()}
          className={cn('h-11 font-bold hover:bg-rose-500', forceAdd ? 'bg-amber-600 text-white' : 'bg-rose-600')}
        >
          {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden /> : <Plus className="mr-1.5 h-4 w-4" aria-hidden />}
          Adaugă
        </Button>
      </div>
      {!compact && (
        <p className="text-xs text-zinc-500 sm:hidden">
          Playerul universal redă orice sursă; motorul de căutare o indexează instant local.
        </p>
      )}
      {dupCheck?.exists ? (
        <p role="status" className="text-xs font-medium text-amber-300 sm:col-span-2">
          ⚠ Link deja în registrul SQLite — {dupCheck.source?.hits ?? 1} accesări · {dupCheck.source?.kind}.{' '}
          {forceAdd ? 'Apasă „Adaugă” din nou pentru a confirma.' : 'Apasă „Adaugă” o a doua oară ca să continui oricum.'}
        </p>
      ) : null}
    </form>
  );
}

export function AddContentDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-white/10 bg-[#12121c] sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-zinc-100">
            <Upload className="h-5 w-5 text-rose-400" aria-hidden />
            Adaugă conținut
          </DialogTitle>
          <DialogDescription className="text-zinc-400">
            Link direct (MP4 / HLS / DASH), iframe, cod embed sau JavaScript din YouTube, OK.ru, Vimeo, TikTok,
            Dailymotion, Rumble, Twitch — sau orice altă sursă, inclusiv surse necunoscute.
          </DialogDescription>
        </DialogHeader>
        <AddContentForm compact onAdded={() => onOpenChange(false)} />
        <p className="text-xs leading-relaxed text-zinc-500">
          Playerul universal îl redă, motorul de căutare îl indexează instant local, iar AI-ul îl clasifică
          automat. Arhitectură reală pregătită gradual pentru până la 10.000.000 de conținuturi.
        </p>
      </DialogContent>
    </Dialog>
  );
}

/* ---------------------------- platform hero ------------------------------- */

export function PlatformHeroPanel() {
  const [open, setOpen] = useState(false);
  return (
    <section
      aria-labelledby="platform-powered-title"
      className="relative overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-br from-rose-600/15 via-fuchsia-600/10 to-transparent p-6 sm:p-8"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute -right-16 -top-16 h-56 w-56 rounded-full bg-rose-500/15 blur-3xl"
      />
      <div className="relative flex flex-col gap-5">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.25em] text-rose-400">Platformă alimentată de tine</p>
          <h2 id="platform-powered-title" className="mt-2 text-2xl font-black tracking-tight text-white sm:text-3xl">
            Încarcă orice conținut.
            <span className="text-rose-400"> Arhitectură reală pregătită gradual pentru până la 10.000.000 de conținuturi.</span>
          </h2>
          <p className="mt-2 text-sm font-semibold text-zinc-200">
            Catalog real, distribuit și extensibil gradual până la 10 milioane de titluri.
          </p>
          <p className="mt-3 max-w-3xl text-sm leading-relaxed text-zinc-400">
            Adaugă tu conținutul prin <strong className="text-zinc-200">link direct</strong> (MP4 / HLS / DASH),{' '}
            <strong className="text-zinc-200">iframe</strong>, <strong className="text-zinc-200">cod embed</strong> sau{' '}
            <strong className="text-zinc-200">JavaScript</strong> din YouTube, OK.ru, Vimeo, TikTok, Dailymotion,
            Rumble, Twitch sau <strong className="text-zinc-200">orice altă sursă</strong> — inclusiv surse
            necunoscute. Playerul universal îl redă, motorul de căutare îl indexează instant local, fără să pice
            nimic.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge className="border-white/15 bg-white/10 text-zinc-200 hover:bg-white/10">
            <Globe2 className="mr-1.5 h-3.5 w-3.5 text-rose-300" aria-hidden /> 196 țări
          </Badge>
          <Badge className="border-white/15 bg-white/10 text-zinc-200 hover:bg-white/10">
            <Database className="mr-1.5 h-3.5 w-3.5 text-rose-300" aria-hidden /> 100% local, SQLite
          </Badge>
          <Badge className="border-white/15 bg-white/10 text-zinc-200 hover:bg-white/10">
            <Sparkles className="mr-1.5 h-3.5 w-3.5 text-rose-300" aria-hidden /> AI clasificare automată
          </Badge>
        </div>
        <div>
          <Button onClick={() => setOpen(true)} className="bg-rose-600 font-bold text-white hover:bg-rose-500">
            <Plus className="mr-1.5 h-4 w-4" aria-hidden />
            Adaugă conținut acum
          </Button>
        </div>
      </div>
      <AddContentDialog open={open} onOpenChange={setOpen} />
    </section>
  );
}

/* -------------------------- community activity ---------------------------- */

const ACTIVITY_LABELS: Record<string, string> = {
  comment: 'a comentat la',
  review: 'a scris o recenzie pentru',
  follow: 'începe să urmărească',
  'party:create': 'a pornit un watch party pentru',
  'party:join': 's-a alăturat unui watch party pentru',
  'party:ended': 'a încheiat un watch party pentru',
};

function activityLabel(type: string): string {
  return ACTIVITY_LABELS[type] ?? 'a interacționat cu';
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'chiar acum';
  if (min < 60) return `acum ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `acum ${h}h`;
  const d = Math.floor(h / 24);
  return `acum ${d}z`;
}

export function CommunityActivityPanel() {
  const feedRes = useApi('home-social-feed', () => social.publicFeed(undefined, 8));
  const events: ActivityEvent[] = feedRes.data?.data ?? [];

  return (
    <Section
      title="Activitatea comunității"
      subtitle="Live din biblioteca locală — comentarii, recenzii și watch parties"
      action={
        <Button
          variant="outline"
          size="sm"
          onClick={() => navigate('/social')}
          className="h-8 border-white/15 bg-white/5 text-zinc-200 hover:bg-white/10 hover:text-white"
        >
          <Rss className="mr-1.5 h-3.5 w-3.5" aria-hidden />
          Hub social
        </Button>
      }
    >
      {feedRes.loading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-14 w-full rounded-xl" />
          ))}
        </div>
      ) : events.length === 0 ? (
        <div className="flex items-center gap-4 rounded-xl border border-white/10 bg-white/[0.02] p-6">
          <span className="grid h-12 w-12 shrink-0 place-items-center rounded-xl border border-rose-500/20 bg-rose-500/10 text-rose-400">
            <Users className="h-6 w-6" aria-hidden />
          </span>
          <div>
            <p className="text-sm font-semibold text-zinc-200">Încă nimic — comentează sau vizionează ceva</p>
            <p className="mt-0.5 text-xs text-zinc-500">
              pentru a porni fluxul social. Orice acțiune apare aici în timp real, direct din SQLite local.
            </p>
          </div>
        </div>
      ) : (
        <ul className="divide-y divide-white/5 overflow-hidden rounded-xl border border-white/10 bg-white/[0.02]">
          {events.map((event) => (
            <li key={event.id} className="flex items-center gap-3 px-4 py-3">
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-gradient-to-br from-rose-500 to-fuchsia-600 text-[11px] font-black text-white">
                {event.user.username.slice(0, 2).toUpperCase()}
              </span>
              <p className="min-w-0 flex-1 truncate text-sm text-zinc-300">
                <span className="font-semibold text-zinc-100">{event.user.username}</span>{' '}
                {activityLabel(event.type)}{' '}
                {event.content ? (
                  <button
                    type="button"
                    onClick={() => navigate(`/content/${event.content!.id}`)}
                    className="font-semibold text-rose-300 hover:text-rose-200 hover:underline"
                  >
                    {event.content.title}
                  </button>
                ) : null}
                {event.preview ? <span className="text-zinc-500"> — “{event.preview.slice(0, 90)}”</span> : null}
              </p>
              <span className="shrink-0 text-xs text-zinc-500">{timeAgo(event.createdat)}</span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

/* ---------------------------- neon library -------------------------------- */

export function NeonLibraryPanel({ rows, loading, totalCount }: { rows: DbContent[]; loading: boolean; totalCount: number }) {
  const [addOpen, setAddOpen] = useState(false);
  const items = useMemo(() => rows.map(dbToItem), [rows]);

  return (
    <Section
      title={`🧠 Biblioteca ta locală — redare universală (${totalCount})`}
      subtitle="Tot ce încarci tu, jucat de playerul universal și indexat instant"
      action={
        <Button
          variant="outline"
          size="sm"
          onClick={() => setAddOpen(true)}
          className="h-8 border-rose-500/30 bg-rose-500/10 text-rose-200 hover:bg-rose-500/20 hover:text-rose-100"
        >
          <Plus className="mr-1.5 h-3.5 w-3.5" aria-hidden />
          Adaugă conținut
        </Button>
      }
    >
      <div className="space-y-4">
        <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
          <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-zinc-500">
            Adaugă conținut — URL • Embed • iframe • JS
          </p>
          <AddContentForm compact />
        </div>
        {items.length === 0 && !loading ? (
          <div className="flex items-center gap-4 rounded-xl border border-white/10 bg-white/[0.02] p-6">
            <span className="grid h-12 w-12 shrink-0 place-items-center rounded-xl border border-rose-500/20 bg-rose-500/10 text-rose-400">
              <Inbox className="h-6 w-6" aria-hidden />
            </span>
            <div>
              <p className="text-sm font-semibold text-zinc-200">Biblioteca e pregătită — 0 conținuturi simulate</p>
              <p className="mt-0.5 text-xs text-zinc-500">
                Fiecare poster de aici va fi unul încărcat de tine — redat prin playerul universal. Catalog
                real, distribuit și extensibil gradual până la 10 milioane de titluri.
              </p>
            </div>
          </div>
        ) : (
          <ContentGrid
            items={items}
            loading={loading}
            skeletonCount={8}
            emptyTitle="Biblioteca e pregătită"
            emptyMessage="Fiecare poster de aici va fi unul încărcat de tine."
          />
        )}
      </div>
      <AddContentDialog open={addOpen} onOpenChange={setAddOpen} />
    </Section>
  );
}

/* ----------------------------- AI analysis -------------------------------- */

function taxonomyOf(rows: DbContent[]) {
  const genres = new Set<string>();
  const categories = new Set<string>();
  const decades = new Set<string>();
  const years = new Set<string>();
  for (const row of rows) {
    categories.add(row.type);
    for (const g of row.metadata?.genres ?? []) genres.add(String(g));
    const y = row.metadata?.year;
    const yearNum = typeof y === 'number' ? y : typeof y === 'string' ? Number.parseInt(y, 10) : NaN;
    if (!Number.isNaN(yearNum)) {
      years.add(String(yearNum));
      decades.add(`${Math.floor(yearNum / 10) * 10}s`);
    }
  }
  return { genres: genres.size, categories: categories.size, decades: decades.size, years: years.size };
}

export function AiAnalysisPanel({ rows, loading, onRefetch }: { rows: DbContent[]; loading: boolean; onRefetch: () => void }) {
  const [stamp, setStamp] = useState<string>('--:--:--');
  const [analyzing, setAnalyzing] = useState(false);

  const refresh = useCallback(() => {
    onRefetch();
    setStamp(new Date().toLocaleTimeString('ro-RO', { hour12: false }));
  }, [onRefetch]);

  /* NEON FREE PLAN: auto-refresh la 60 MIN (fost 60s), doar când tab-ul e
   * vizibil — homepage-ul nu mai ține Neon treaz cu interogări la fiecare
   * minut; utilizatorul are și butonul Refresh manual. */
  useEffect(() => {
    setStamp(new Date().toLocaleTimeString('ro-RO', { hour12: false }));
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') refresh();
    }, 60 * 60_000);
    return () => clearInterval(id);
  }, [refresh]);

  const playable = useMemo(
    () => rows.filter((r) => (r.metadata?.player?.sources ?? r.metadata?.sources ?? []).length > 0).length,
    [rows],
  );
  const tax = useMemo(() => taxonomyOf(rows), [rows]);

  const reanalyze = async () => {
    setAnalyzing(true);
    try {
      await api.health();
      refresh();
      toast.success('Re-analiză AI completă', {
        description: `${rows.length} titluri verificate · ${tax.genres} genuri · ${tax.categories} categorii`,
      });
    } finally {
      setAnalyzing(false);
    }
  };

  return (
    <Section
      title="AI Analiză conținut"
      subtitle="Platforma, mereu la zi — clasificare automată pe tot ce încarci"
      action={
        <div className="flex items-center gap-2">
          <span className="hidden items-center gap-1.5 text-xs text-zinc-500 sm:flex">
            <span className="relative flex h-2 w-2" aria-hidden>
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
            </span>
            LIVE · {stamp}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={refresh}
            disabled={loading}
            title="Reîmprospătează datele acum"
            className="h-8 border-white/15 bg-white/5 text-zinc-200 hover:bg-white/10 hover:text-white"
          >
            <RefreshCw className={cn('mr-1.5 h-3.5 w-3.5', loading && 'animate-spin')} aria-hidden />
            Refresh
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={reanalyze}
            disabled={analyzing || loading}
            className="h-8 border-white/15 bg-white/5 text-zinc-200 hover:bg-white/10 hover:text-white"
          >
            {analyzing ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : (
              <BrainCircuit className="mr-1.5 h-3.5 w-3.5" aria-hidden />
            )}
            Re-analiză AI
          </Button>
        </div>
      }
    >
      {loading ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24 w-full rounded-xl" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <AnalysisTile icon={<Database className="h-5 w-5" aria-hidden />} label="Titluri analizate" value={rows.length} />
          <AnalysisTile icon={<Sparkles className="h-5 w-5" aria-hidden />} label="Surse gata de redare" value={playable} />
          <AnalysisTile icon={<BrainCircuit className="h-5 w-5" aria-hidden />} label="Genuri detectate" value={tax.genres} />
          <AnalysisTile icon={<Globe2 className="h-5 w-5" aria-hidden />} label="Categorii active" value={tax.categories} />
        </div>
      )}
    </Section>
  );
}

function AnalysisTile({ icon, label, value }: { icon: React.ReactNode; label: string; value: number }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] p-4">
      <span className="grid h-11 w-11 shrink-0 place-items-center rounded-lg border border-rose-500/20 bg-rose-500/10 text-rose-400">
        {icon}
      </span>
      <div className="min-w-0">
        <p className="text-2xl font-black leading-none text-white">{value.toLocaleString('ro-RO')}</p>
        <p className="mt-1.5 truncate text-xs font-medium text-zinc-500">{label}</p>
      </div>
    </div>
  );
}

/* ------------------------------- taxonomy --------------------------------- */

export function TaxonomyPanel({ rows, loading, onRefetch }: { rows: DbContent[]; loading: boolean; onRefetch: () => void }) {
  const [busy, setBusy] = useState(false);
  const tax = useMemo(() => taxonomyOf(rows), [rows]);

  const regenerate = async () => {
    setBusy(true);
    try {
      onRefetch();
      toast.success('Taxonomie regenerată', {
        description: `🎭 ${tax.genres} genuri · 🗂️ ${tax.categories} categorii · 📅 ${tax.decades} decenii · 🗓️ ${tax.years} ani`,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      title="Genuri & Categorii create automat de AI"
      subtitle="Fiecare titlu încărcat e clasificat instant — taxonomia crește cu biblioteca"
      action={
        <Button
          variant="outline"
          size="sm"
          onClick={regenerate}
          disabled={busy || loading}
          className="h-8 border-white/15 bg-white/5 text-zinc-200 hover:bg-white/10 hover:text-white"
        >
          {busy ? (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : (
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" aria-hidden />
          )}
          Regenerare taxonomie
        </Button>
      }
    >
      {loading ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24 w-full rounded-xl" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <TaxonomyTile emoji="🎭" label="Genuri" value={tax.genres} />
          <TaxonomyTile emoji="🗂️" label="Categorii" value={tax.categories} />
          <TaxonomyTile emoji="📅" label="Decenii" value={tax.decades} />
          <TaxonomyTile emoji="🗓️" label="Ani" value={tax.years} />
        </div>
      )}
    </Section>
  );
}

function TaxonomyTile({ emoji, label, value }: { emoji: string; label: string; value: number }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] p-4">
      <span className="grid h-11 w-11 shrink-0 place-items-center rounded-lg border border-fuchsia-500/20 bg-fuchsia-500/10 text-xl" aria-hidden>
        {emoji}
      </span>
      <div className="min-w-0">
        <p className="text-2xl font-black leading-none text-white">{value}</p>
        <p className="mt-1.5 truncate text-xs font-medium text-zinc-500">
          <CalendarDays className="mr-1 inline h-3 w-3" aria-hidden />
          {label}
        </p>
      </div>
    </div>
  );
}

/* ------------------- FAZA 15: AI Home engine (external) -------------------- */

/** Small clickable chip that navigates into a metadata browse view. */
function MetaChip({ href, children, count }: { href: string; children: React.ReactNode; count?: number }) {
  return (
    <button
      type="button"
      onClick={() => navigate(href)}
      className="rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-xs font-medium text-zinc-300 transition hover:border-rose-500/50 hover:bg-rose-500/10 hover:text-rose-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/60"
    >
      {children}
      {count != null && <span className="ml-1 text-[10px] font-semibold text-zinc-500">{count}</span>}
    </button>
  );
}

function LiveStamp({ stamp, interval }: { stamp: string; interval: string }) {
  return (
    <span className="hidden items-center gap-1.5 text-xs text-zinc-500 sm:flex">
      <span className="relative flex h-2 w-2" aria-hidden>
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-rose-400 opacity-60" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-rose-400" />
      </span>
      LIVE · actualizare auto {interval} · {stamp}
    </span>
  );
}

/**
 * "AI Analiză Externă — LIVE" — continuous analysis of what the AI loaded
 * from external sources (TMDB / Jikan / miner), auto-refreshed every 30s.
 * Each pass asks for the delta since the previous check, so the panel can
 * surface "N conținuturi noi de la ultima verificare".
 */
export function AiExternalAnalysisPanel() {
  const [since, setSince] = useState<string | null>(null);
  const statsRes = useApi(since ? `ai-home-stats:${since}` : 'ai-home-stats', () =>
    api.aiHome.stats(since ?? undefined),
  );
  const stats: AiExternalStatsResponse | null = statsRes.data;
  const [stamp, setStamp] = useState('--:--:--');
  const [newItems, setNewItems] = useState<number | null>(null);
  const lastUpdatedRef = useRef<string | null>(null);

  /* Stamp + delta follow the latest payload (deferred, never sync in effect). */
  useEffect(() => {
    if (!stats) return undefined;
    const timer = setTimeout(() => {
      lastUpdatedRef.current = stats.updatedAt;
      setStamp(new Date(stats.updatedAt).toLocaleTimeString('ro-RO', { hour12: false }));
      setNewItems(stats.delta ? stats.delta.newItems : null);
    }, 0);
    return () => clearTimeout(timer);
  }, [stats]);

  /* Auto-refresh cycle — next pass measures the delta since the last updatedAt. */
  useEffect(() => {
    const timer = setInterval(() => {
      setSince(lastUpdatedRef.current ?? new Date().toISOString());
    }, 30_000);
    return () => clearInterval(timer);
  }, []);

  const sourceCount = stats ? Object.keys(stats.library.bySource).length : 0;

  return (
    <Section
      title="AI Analiză Externă — LIVE"
      subtitle="Ce a încărcat AI-ul din surse externe — TMDB, Jikan, miner — verificat la 30 de secunde"
      action={<LiveStamp stamp={stamp} interval="30s" />}
    >
      {statsRes.loading && !stats ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24 w-full rounded-xl" />
          ))}
        </div>
      ) : !stats ? (
        <ErrorState compact message={statsRes.error} onRetry={statsRes.refetch} />
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <AnalysisTile
              icon={<ImageIcon className="h-5 w-5" aria-hidden />}
              label="Postere din extern"
              value={stats.posters.fromExternal}
            />
            <AnalysisTile
              icon={<Clapperboard className="h-5 w-5" aria-hidden />}
              label="Conținuturi din extern"
              value={stats.contents.fromExternal}
            />
            <AnalysisTile
              icon={<Database className="h-5 w-5" aria-hidden />}
              label="Titluri locale"
              value={stats.library.total}
            />
            <AnalysisTile
              icon={<Layers className="h-5 w-5" aria-hidden />}
              label="Surse externe"
              value={sourceCount}
            />
          </div>

          {newItems != null && (
            <p
              className={cn(
                'rounded-xl border px-4 py-2.5 text-sm font-medium',
                newItems > 0
                  ? 'border-rose-500/30 bg-rose-500/10 text-rose-200'
                  : 'border-white/10 bg-white/[0.02] text-zinc-500',
              )}
            >
              {newItems > 0
                ? `+${newItems.toLocaleString('ro-RO')} conținuturi noi de la ultima verificare`
                : 'niciun conținut nou de la ultima verificare'}
            </p>
          )}

          <div>
            <p className="mb-2 text-xs font-bold uppercase tracking-wider text-zinc-500">Surse detectate</p>
            <div className="flex flex-wrap gap-2">
              {Object.entries(stats.library.bySource).map(([src, count]) => (
                <span
                  key={src}
                  className="rounded-full border border-rose-500/25 bg-rose-500/10 px-2.5 py-1 text-xs font-semibold text-rose-200"
                >
                  {src} · {count}
                </span>
              ))}
            </div>
          </div>

          <p className="text-sm text-zinc-400">
            Catalog extern live: TMDB {stats.externalCatalog.tmdbTrendingMovies?.toLocaleString('ro-RO') ?? '—'} filme
            trending · {stats.externalCatalog.tmdbTrendingTv?.toLocaleString('ro-RO') ?? '—'} seriale · Jikan{' '}
            {stats.externalCatalog.jikanTop ? stats.externalCatalog.jikanTop.toLocaleString('ro-RO') : '—'} anime
          </p>

          <div>
            <p className="mb-2 text-xs font-bold uppercase tracking-wider text-zinc-500">Adăugate recent din extern</p>
            <ul className="divide-y divide-white/5 overflow-hidden rounded-xl border border-white/10 bg-white/[0.02]">
              {stats.recent.slice(0, 8).map((r) => (
                <li key={r.id} className="flex items-center gap-3 px-4 py-2.5">
                  <span className="min-w-0 flex-1 truncate text-sm text-zinc-300">{r.title}</span>
                  <span className="shrink-0 rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] font-semibold text-zinc-400">
                    {r.source}
                  </span>
                  <TypeBadge type={r.type} />
                  {r.createdat && <span className="shrink-0 text-xs text-zinc-500">{timeAgo(r.createdat)}</span>}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </Section>
  );
}

/**
 * "Genuri & Categorii generate automat de AI din posterele externe" —
 * taxonomy over external posters with a z-ai narration quote. When the
 * autoTaxonomy toggle is OFF, the panel collapses to a compact notice.
 */
export function AiTaxonomyAutoPanel() {
  const { settings, setToggle } = useAiHomeSettings();
  const taxRes = useApi('ai-home-taxonomy', () => api.aiHome.taxonomy());
  const narrationRes = useApi('ai-home-taxonomy-narration', () => api.aiHome.narration());
  const [busy, setBusy] = useState(false);
  const tax = taxRes.data;
  const narration = narrationRes.data;

  const regenerate = async () => {
    setBusy(true);
    try {
      await api.aiHome.metadataRefresh();
      await Promise.all([taxRes.refetch(), narrationRes.refetch()]);
      const fresh = await api.aiHome.taxonomy().catch(() => null);
      if (fresh) {
        toast.success('Taxonomie AI regenerată', {
          description: `🎭 ${fresh.genres.length} genuri · 🗂️ ${fresh.categories.length} categorii · ${fresh.analyzedItems} conținuturi analizate de AI`,
        });
      } else {
        toast.success('Taxonomie AI regenerată');
      }
    } catch {
      toast.error('Regenerarea taxonomiei a eșuat', { description: 'Backend-ul nu răspunde — încearcă din nou.' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      title="Genuri & Categorii generate automat de AI din posterele externe"
      subtitle="Taxonomia crește la fiecare încărcare din TMDB, Jikan și biblioteca locală"
      action={
        <Button
          variant="outline"
          size="sm"
          onClick={regenerate}
          disabled={busy || taxRes.loading}
          className="h-8 border-white/15 bg-white/5 text-zinc-200 hover:bg-white/10 hover:text-white"
        >
          {busy ? (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : (
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" aria-hidden />
          )}
          Regenerare taxonomie AI
        </Button>
      }
    >
      {!settings.autoTaxonomy ? (
        <div className="flex items-center justify-between gap-4 rounded-xl border border-white/10 bg-white/[0.02] p-4">
          <div>
            <p className="text-sm font-semibold text-zinc-200">Taxonomie auto oprită</p>
            <p className="mt-0.5 text-xs text-zinc-500">
              AI-ul nu mai clasifică posterele externe noi. Reactiveaz-o oricând.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2.5">
            <Switch
              checked={settings.autoTaxonomy}
              onCheckedChange={(v) => setToggle('autoTaxonomy', v)}
              aria-label="Taxonomie auto"
              className="data-[state=checked]:bg-rose-600"
            />
            <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-600">OFF</span>
          </div>
        </div>
      ) : taxRes.loading && !tax ? (
        <div className="space-y-3">
          <Skeleton className="h-16 w-full rounded-xl" />
          <Skeleton className="h-24 w-full rounded-xl" />
        </div>
      ) : !tax ? (
        <ErrorState compact message={taxRes.error} onRetry={taxRes.refetch} />
      ) : (
        <div className="space-y-4">
          {narration?.narration && narration.provider === 'z-ai' ? (
            <blockquote className="rounded-xl border border-fuchsia-500/20 bg-fuchsia-500/5 p-4 text-sm italic leading-relaxed text-zinc-300">
              “{narration.narration}”
              <span className="ml-2 inline-block rounded-full border border-fuchsia-500/30 bg-fuchsia-500/10 px-2 py-0.5 text-[10px] font-bold not-italic text-fuchsia-300">
                z-ai
              </span>
            </blockquote>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            <Badge className="border-rose-500/30 bg-rose-500/10 text-rose-200 hover:bg-rose-500/10">
              <Sparkles className="mr-1.5 h-3.5 w-3.5" aria-hidden />
              {tax.analyzedItems} conținuturi analizate
            </Badge>
            {tax.sourcesChecked.map((s) => (
              <Badge key={s} className="border-white/15 bg-white/5 text-zinc-300 hover:bg-white/5">
                {s}
              </Badge>
            ))}
          </div>

          <div>
            <p className="mb-2 text-xs font-bold uppercase tracking-wider text-zinc-500">🎭 Genuri de top</p>
            <div className="flex flex-wrap gap-1.5">
              {tax.genres.slice(0, 18).map((g) => (
                <MetaChip key={g.name} href={`/meta/genre/${encodeURIComponent(g.name)}`} count={g.count}>
                  {g.name}
                </MetaChip>
              ))}
            </div>
          </div>

          <div>
            <p className="mb-2 text-xs font-bold uppercase tracking-wider text-zinc-500">🗂️ Categorii</p>
            <div className="flex flex-wrap gap-1.5">
              {tax.categories.map((c) => (
                <MetaChip key={c.name} href={`/meta/category/${encodeURIComponent(c.name)}`} count={c.count}>
                  {c.name}
                </MetaChip>
              ))}
            </div>
          </div>

          {tax.decades.length > 0 && (
            <div>
              <p className="mb-2 text-xs font-bold uppercase tracking-wider text-zinc-500">📅 Decenii</p>
              <div className="flex flex-wrap gap-1.5">
                {tax.decades.map((d) => (
                  <span
                    key={d.name}
                    className="rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1 text-xs font-medium text-zinc-400"
                  >
                    {d.name} <span className="text-[10px] text-zinc-600">{d.count}</span>
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </Section>
  );
}

/** Ordered metadata dimensions rendered as chip sections (Romanian labels). */
const META_DIM_SECTIONS: { dim: MetaDimension; label: string; hint?: string }[] = [
  { dim: 'year', label: '📅 Ani' },
  { dim: 'genre', label: '🎭 Genuri' },
  { dim: 'category', label: '🗂️ Categorii' },
  { dim: 'studio', label: '🏭 Studiouri' },
  { dim: 'actor', label: '🎬 Actori' },
  { dim: 'collection', label: '📚 Colecții' },
  { dim: 'franchise', label: '🔗 Francize', hint: 'count = părți' },
  { dim: 'trilogy', label: '🎞️ Trilogii' },
];

function CoverageRow({ label, value, total }: { label: string; value: number; total: number }) {
  const pct = total > 0 ? Math.min(100, Math.round((value / total) * 100)) : 0;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="font-semibold text-zinc-300">{label}</span>
        <span className="text-zinc-500">
          {value.toLocaleString('ro-RO')} · {pct}%
        </span>
      </div>
      <Progress
        value={pct}
        aria-label={`Acoperire ${label}`}
        className="h-1.5 bg-white/10 [&_[data-slot=progress-indicator]]:bg-gradient-to-r [&_[data-slot=progress-indicator]]:from-rose-500 [&_[data-slot=progress-indicator]]:to-fuchsia-500"
      />
    </div>
  );
}

function MetaDimChips({ dim, label, hint, values }: { dim: MetaDimension; label: string; hint?: string; values: AiMetaEntry[] }) {
  return (
    <div>
      <p className="mb-2 flex items-center justify-between gap-2 text-xs font-bold uppercase tracking-wider text-zinc-500">
        <span>
          {label}
          {hint ? <span className="ml-1.5 font-medium normal-case text-zinc-600">({hint})</span> : null}
        </span>
        <span className="font-semibold text-zinc-600">{values.length} valori</span>
      </p>
      {values.length === 0 ? (
        <p className="rounded-xl border border-white/10 bg-white/[0.02] px-3 py-2.5 text-xs text-zinc-500">
          AI extrage valorile — pool-ul crește continuu.
        </p>
      ) : (
        <div className="custom-scrollbar flex max-h-40 flex-wrap gap-1.5 overflow-y-auto pr-1">
          {values.map((v) => (
            <MetaChip key={v.value} href={`/meta/${dim}/${encodeURIComponent(v.value)}`} count={v.count}>
              {v.value}
            </MetaChip>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * "AI Extractor Metadata" — coverage of the extracted metadata surface plus
 * the eight ordered dimensions that power the AI Metadata sidebar menus.
 */
export function AiMetadataPanel() {
  const metaRes = useApi('ai-home-metadata-panel', () => api.aiHome.metadata());
  const [busy, setBusy] = useState(false);
  const meta: AiMetadataResponse | null = metaRes.data;

  const extractNow = async () => {
    setBusy(true);
    try {
      const r = await api.aiHome.metadataRefresh();
      await metaRes.refetch();
      toast.success('Extragere metadata pornită', {
        description: `${r.enriched} intrări nou extrase · pool-ul AI crește continuu în fundal`,
      });
    } catch {
      toast.error('Extragerea metadata a eșuat', { description: 'Backend-ul nu răspunde — încearcă din nou.' });
    } finally {
      setBusy(false);
    }
  };

  const titles = meta?.coverage.titles ?? 0;
  const coverageRows: { label: string; value: number }[] = [
    { label: 'Titluri', value: titles },
    { label: 'An', value: meta?.coverage.withYear ?? 0 },
    { label: 'Genuri', value: meta?.coverage.withGenres ?? 0 },
    { label: 'Descriere', value: meta?.coverage.withDescription ?? 0 },
    { label: 'Studio', value: meta?.coverage.withStudio ?? 0 },
    { label: 'Actori', value: meta?.coverage.withCast ?? 0 },
    { label: 'Colecție', value: meta?.coverage.withCollection ?? 0 },
    { label: 'Trailer', value: meta?.coverage.withTrailer ?? 0 },
  ];

  return (
    <Section
      title="AI Extractor Metadata — An · Genuri · Franciză · Studio · Categorii · Actori · Trilogie · Colecție"
      subtitle="Metadata reală extrasă din conținuturile existente — alimentează meniurile AI din sidebar"
      action={
        <div className="flex flex-wrap items-center gap-2">
          <span className="hidden items-center gap-1.5 rounded-full border border-fuchsia-500/25 bg-fuchsia-500/10 px-2.5 py-1 text-xs font-semibold text-fuchsia-200 sm:flex">
            <span className="relative flex h-2 w-2" aria-hidden>
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-fuchsia-400 opacity-60" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-fuchsia-400" />
            </span>
            Pool AI: {meta?.enriching.enriched ?? 0}/{meta?.enriching.pool ?? 0} extrase · se actualizează mereu
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={extractNow}
            disabled={busy || metaRes.loading}
            className="h-8 border-white/15 bg-white/5 text-zinc-200 hover:bg-white/10 hover:text-white"
          >
            {busy ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : (
              <BrainCircuit className="mr-1.5 h-3.5 w-3.5" aria-hidden />
            )}
            Extrage metadata acum
          </Button>
        </div>
      }
    >
      {metaRes.loading && !meta ? (
        <div className="space-y-3">
          <Skeleton className="h-24 w-full rounded-xl" />
          <Skeleton className="h-40 w-full rounded-xl" />
        </div>
      ) : !meta ? (
        <ErrorState compact message={metaRes.error} onRetry={metaRes.refetch} />
      ) : (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-x-6 gap-y-4 lg:grid-cols-4">
            {coverageRows.map((r) => (
              <CoverageRow key={r.label} label={r.label} value={r.value} total={titles} />
            ))}
          </div>
          <div className="grid gap-5 lg:grid-cols-2">
            {META_DIM_SECTIONS.map((s) => (
              <MetaDimChips
                key={s.dim}
                dim={s.dim}
                label={s.label}
                hint={s.hint}
                values={meta.dimensions[s.dim] ?? []}
              />
            ))}
          </div>
        </div>
      )}
    </Section>
  );
}
