'use client';

/**
 * ai-view.tsx — AI hub (#/ai). Provider status header + eight tools:
 * Recommendations (aiRecommendations), Summarize (aiSummarize with a library
 * content picker), Describe (aiDescribe form) and Chat (auth-gated
 * content-scoped aiChat) — plus the Phase-4 AI Cloud panes: Personal
 * (personalized home + weekly recap), Assistant (tool-calling agent),
 * RAG Lab (vector pipeline: recommend / summarize / explain / chat) and
 * Tools (catalog + live runner). Plan-quota (402) errors render upgrade
 * cards; the header shows the live LLM + vector-backend status.
 */

import { useEffect, useRef, useState } from 'react';
import {
  Bot,
  Brain,
  ChevronDown,
  Crown,
  Database,
  Dices,
  Loader2,
  Search,
  Send,
  Sparkles,
  Wrench,
  X,
  Zap,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  platform,
  PlatformError,
  type AiAssistantResponse,
  type AiChatTurn,
  type AiPersonalHomeResponse,
  type AiPersonalRecapResponse,
  type AiRagChatResponse,
  type AiRagExplainResponse,
  type AiRagPick,
  type AiRagRecommendResponse,
  type AiRagSummarizeResponse,
  type AiRecommendation,
  type AiTool,
  type AiToolRunResponse,
  type PlatformUser,
} from '@/lib/animaxia/platform';
import { useApi } from '@/lib/animaxia/hooks';
import { navigate, type AppRoute } from '@/lib/animaxia/router';
import { useAuth } from '@/components/animaxia/auth-provider';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { Container, PageHeader } from '../section';
import { BrandPlaceholder, EmptyState, ErrorState, LoadingCards, TypeBadge } from '../states';

type AiTab = 'recommendations' | 'summarize' | 'describe' | 'chat' | 'personal' | 'assistant' | 'rag' | 'tools';

const TAB_TRIGGER_CLASS =
  'shrink-0 whitespace-nowrap rounded-lg px-3 text-zinc-400 hover:text-zinc-100 data-[state=active]:bg-rose-600 data-[state=active]:text-white sm:px-4';

/* ------------------------------- local helpers ------------------------------ */

interface Suggestion {
  id: number;
  title: string;
  type: string;
  thumbnail: string | null;
}

interface ChatMessage {
  role: 'user' | 'ai';
  text: string;
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success('Copiat în clipboard');
  } catch {
    toast.error('Clipboardul nu este disponibil în acest browser');
  }
}

/** Renders AI output: bullet lines ("- " / "• ") become styled list items. */
function AiText({ text }: { text: string }) {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  return (
    <div className="space-y-2.5">
      {lines.map((line, i) => {
        if (line.startsWith('- ') || line.startsWith('• ')) {
          return (
            <div key={i} className="flex gap-2.5">
              <span className="mt-[9px] h-1.5 w-1.5 shrink-0 rounded-full bg-rose-400" aria-hidden />
              <p className="text-sm leading-relaxed text-zinc-300">{line.slice(2)}</p>
            </div>
          );
        }
        return (
          <p key={i} className="text-sm leading-relaxed text-zinc-300">
            {line}
          </p>
        );
      })}
    </div>
  );
}

function ProviderBadge({ provider }: { provider: string }) {
  const isLlm = provider === 'z-ai';
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider',
        isLlm ? 'border-rose-500/30 bg-rose-500/10 text-rose-300' : 'border-amber-500/30 bg-amber-500/10 text-amber-300',
      )}
    >
      {isLlm ? <Sparkles className="h-3 w-3" aria-hidden /> : <Zap className="h-3 w-3" aria-hidden />}
      {provider}
    </span>
  );
}

function UpgradeCard({ message }: { message: string }) {
  return (
    <div className="rounded-2xl border border-amber-500/30 bg-amber-500/[0.07] p-6 text-center">
      <p className="flex items-center justify-center gap-2 font-semibold text-amber-300">
        <Crown className="h-5 w-5 shrink-0" aria-hidden />
        Daily AI limit reached
      </p>
      <p className="mx-auto mt-1 max-w-md text-sm leading-relaxed text-zinc-400">{message}</p>
      <Button
        type="button"
        className="mt-4 bg-rose-600 font-bold text-white hover:bg-rose-500"
        onClick={() => navigate('/premium')}
      >
        <Crown aria-hidden /> See premium plans
      </Button>
    </div>
  );
}

function TypingDots() {
  return (
    <span className="inline-flex items-center gap-1 py-1" role="status" aria-label="AI is thinking">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-1.5 w-1.5 animate-bounce rounded-full bg-rose-300"
          style={{ animationDelay: `${i * 150}ms` }}
        />
      ))}
    </span>
  );
}

/** Amber "offline / degraded" chip shown when the LLM fell back to mock mode. */
function DegradedBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-amber-300">
      <Zap className="h-3 w-3" aria-hidden /> offline mode
    </span>
  );
}

/** Shared auth-gated sign-in prompt card (same pattern as the Chat tab). */
function SignInCard({ title, message, action }: { title: string; message: string; action: string }) {
  return (
    <div className="mx-auto max-w-3xl">
      <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-white/10 bg-white/[0.02] p-10 text-center">
        <div className="rounded-full bg-rose-500/10 p-3 text-rose-300">
          <Sparkles className="h-6 w-6" aria-hidden />
        </div>
        <div>
          <p className="font-semibold text-zinc-100">{title}</p>
          <p className="mt-1 max-w-md text-sm text-zinc-400">{message}</p>
        </div>
        <Button
          type="button"
          className="bg-rose-600 font-bold text-white hover:bg-rose-500"
          onClick={() => navigate('/auth')}
        >
          {action}
        </Button>
      </div>
    </div>
  );
}

/** True when the error is a per-minute rate limit (429). */
function isRateLimited(e: unknown): e is PlatformError {
  return e instanceof PlatformError && e.status === 429;
}

/** Best-effort daily-quota (402) detection from a useApi error string — the
 *  backend replies "Daily AI quota reached for your plan" with upgrade:true. */
function isQuotaError(message: string | null): boolean {
  return Boolean(message && /daily ai quota|quota reached|upgrade your plan/i.test(message));
}

/* ------------------------------ content picker ------------------------------ */

/**
 * Library content picker: debounced (300 ms) autocomplete dropdown with
 * thumbnails, keyboard (Escape) and click-outside dismissal, and a selected
 * chip. Reused by the Summarize and Chat tabs.
 */
function ContentPicker({
  selected,
  onSelect,
  label,
  inputId,
}: {
  selected: Suggestion | null;
  onSelect: (s: Suggestion | null) => void;
  label: string;
  inputId: string;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  /* Debounced autocomplete (300 ms while typing; instant clear otherwise —
     state updates happen inside the async timer to avoid sync setState). */
  useEffect(() => {
    const q = query.trim();
    const timer = setTimeout(
      () => {
        if (!open || q.length === 0) {
          setSuggestions([]);
          return;
        }
        setLoading(true);
        platform
          .autocomplete(q)
          .then((res) => setSuggestions(res.suggestions))
          .catch(() => setSuggestions([]))
          .finally(() => setLoading(false));
      },
      open && q.length > 0 ? 300 : 0,
    );
    return () => clearTimeout(timer);
  }, [query, open]);

  /* Click-outside closes the dropdown. */
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  return (
    <div className="space-y-2" ref={rootRef}>
      <label htmlFor={inputId} className="text-sm font-semibold text-zinc-300">
        {label}
      </label>
      <div className="relative">
        <Search
          className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500"
          aria-hidden
        />
        <Input
          id={inputId}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={`${inputId}-listbox`}
          aria-autocomplete="list"
          autoComplete="off"
          value={query}
          placeholder="Caută în bibliotecă…"
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setOpen(false);
          }}
          className="h-11 rounded-xl border-white/10 bg-white/[0.04] pl-10 text-sm text-zinc-100 placeholder:text-zinc-500 focus-visible:border-rose-500/50 focus-visible:ring-rose-500/30"
        />
        {open && query.trim().length > 0 && (
          <div
            id={`${inputId}-listbox`}
            role="listbox"
            aria-label="Library suggestions"
            className="absolute z-30 mt-2 max-h-72 w-full overflow-y-auto rounded-xl border border-white/10 bg-[#12121c] p-2 shadow-2xl shadow-black/70 custom-scrollbar"
          >
            {loading ? (
              <p className="px-2 py-3 text-xs text-zinc-500">Searching the library…</p>
            ) : suggestions.length === 0 ? (
              <p className="px-2 py-3 text-xs text-zinc-500">No titles match that search.</p>
            ) : (
              suggestions.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  role="option"
                  aria-selected={selected?.id === s.id}
                  onClick={() => {
                    onSelect(s);
                    setQuery('');
                    setOpen(false);
                  }}
                  className="flex w-full items-center gap-3 rounded-lg p-2 text-left transition-colors hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/60"
                >
                  <span className="h-12 w-9 shrink-0 overflow-hidden rounded-md border border-white/10 bg-white/[0.03]">
                    {s.thumbnail ? (
                      <img src={s.thumbnail} alt="" loading="lazy" className="h-full w-full object-cover" />
                    ) : (
                      <BrandPlaceholder title={s.title} />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-zinc-100">{s.title}</span>
                  </span>
                  <TypeBadge type={s.type} />
                </button>
              ))
            )}
          </div>
        )}
      </div>
      {selected && (
        <div className="flex items-center gap-2">
          <span className="inline-flex max-w-full items-center gap-2 rounded-full border border-rose-500/30 bg-rose-500/10 py-1 pl-1 pr-2 text-sm text-rose-200">
            <span className="h-7 w-7 shrink-0 overflow-hidden rounded-full border border-white/10 bg-white/[0.03]">
              {selected.thumbnail ? (
                <img src={selected.thumbnail} alt="" className="h-full w-full object-cover" />
              ) : (
                <BrandPlaceholder title={selected.title} />
              )}
            </span>
            <span className="truncate font-medium">{selected.title}</span>
            <button
              type="button"
              onClick={() => onSelect(null)}
              aria-label={`Clear ${selected.title}`}
              className="rounded-full p-1 text-rose-300/70 transition hover:bg-rose-500/20 hover:text-rose-100"
            >
              <X className="h-3.5 w-3.5" aria-hidden />
            </button>
          </span>
        </div>
      )}
    </div>
  );
}

/* ---------------------------------- view ---------------------------------- */

export function AiView(_route: { route: AppRoute }) {
  const { user } = useAuth();
  const [tab, setTab] = useState<AiTab>('recommendations');

  const status = useApi('ai-status', () => platform.aiStatus());
  const statusData = status.data;
  /* Phase-4 AI Cloud status (LLM + vector backend + quota). */
  const cloud = useApi('ai-cloud-status', () => platform.aiCloudStatus());
  const cloudData = cloud.data;

  return (
    <Container className="space-y-8 py-8 sm:py-10">
      <PageHeader title="Hub AI" subtitle="Susținut de Animaxia Intelligence">
        <div className="flex flex-wrap items-center gap-2 pt-1">
          {statusData ? (
            statusData.provider === 'z-ai' && statusData.available ? (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-rose-500/30 bg-rose-500/10 px-3 py-1 text-xs font-semibold text-rose-300">
                <Sparkles className="h-3.5 w-3.5" aria-hidden /> LLM online
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-xs font-semibold text-amber-300">
                <Zap className="h-3.5 w-3.5" aria-hidden /> {statusData.provider || 'offline'} mode
              </span>
            )
          ) : (
            <Skeleton className="h-7 w-28 rounded-full" />
          )}
          {cloudData ? (
            <span
              className="inline-flex items-center gap-1.5 rounded-full border border-fuchsia-500/30 bg-fuchsia-500/10 px-3 py-1 text-xs font-semibold text-fuchsia-300"
              title={`Vector backend: ${cloudData.vector.backend} · ${cloudData.vector.dims} dimensions · indexed ${Object.values(cloudData.vector.counts).reduce((a, b) => a + b, 0)} vectors`}
            >
              <Database className="h-3.5 w-3.5" aria-hidden /> {cloudData.vector.backend} · {cloudData.vector.dims}d
            </span>
          ) : (
            !cloud.error && <Skeleton className="h-7 w-32 rounded-full" />
          )}
          {statusData && (
            <span className="inline-flex items-center rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-xs font-medium text-zinc-400">
              {statusData.requestsToday} requests today
            </span>
          )}
          {statusData &&
            (['free', 'plus', 'pro'] as const)
              .filter((plan) => statusData.quota?.[plan] != null)
              .map((plan) => (
                <span
                  key={plan}
                  className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-xs font-medium text-zinc-400"
                >
                  <Crown className="h-3 w-3 text-amber-300/80" aria-hidden />
                  {plan} · {statusData.quota[plan]}/day
                </span>
              ))}
        </div>
      </PageHeader>

      <Tabs value={tab} onValueChange={(v) => setTab(v as AiTab)}>
        <TabsList className="custom-scrollbar h-10 w-full justify-start gap-1 overflow-x-auto rounded-xl border border-white/10 bg-white/[0.03] p-1 sm:w-auto">
          <TabsTrigger value="recommendations" className={TAB_TRIGGER_CLASS}>
            Recomandări
          </TabsTrigger>
          <TabsTrigger value="summarize" className={TAB_TRIGGER_CLASS}>
            Rezumat
          </TabsTrigger>
          <TabsTrigger value="describe" className={TAB_TRIGGER_CLASS}>
            Descriere
          </TabsTrigger>
          <TabsTrigger value="chat" className={TAB_TRIGGER_CLASS}>
            Chat
          </TabsTrigger>
          <TabsTrigger value="personal" className={TAB_TRIGGER_CLASS}>
            Personal
          </TabsTrigger>
          <TabsTrigger value="assistant" className={TAB_TRIGGER_CLASS}>
            Asistent
          </TabsTrigger>
          <TabsTrigger value="rag" className={TAB_TRIGGER_CLASS}>
            RAG Lab
          </TabsTrigger>
          <TabsTrigger value="tools" className={TAB_TRIGGER_CLASS}>
            Unelte
          </TabsTrigger>
        </TabsList>

        <TabsContent value="recommendations" className="pt-6">
          <RecommendationsTab user={user} />
        </TabsContent>
        <TabsContent value="summarize" className="pt-6">
          <SummarizeTab user={user} />
        </TabsContent>
        <TabsContent value="describe" className="pt-6">
          <DescribeTab />
        </TabsContent>
        <TabsContent value="chat" className="pt-6">
          <ChatTab user={user} />
        </TabsContent>
        <TabsContent value="personal" className="pt-6">
          <PersonalTab user={user} />
        </TabsContent>
        <TabsContent value="assistant" className="pt-6">
          <AssistantTab user={user} />
        </TabsContent>
        <TabsContent value="rag" className="pt-6">
          <RagLabTab user={user} />
        </TabsContent>
        <TabsContent value="tools" className="pt-6">
          <ToolsTab user={user} />
        </TabsContent>
      </Tabs>
    </Container>
  );
}

/* ---------------------------- recommendations tab ---------------------------- */

function RecommendationsTab({ user }: { user: PlatformUser | null }) {
  const [picks, setPicks] = useState<AiRecommendation[] | null>(null);
  const [provider, setProvider] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [upgrade, setUpgrade] = useState<string | null>(null);

  async function fetchPicks() {
    if (loading) return;
    setLoading(true);
    setError(null);
    setUpgrade(null);
    try {
      const res = await platform.aiRecommendations(8);
      setPicks(res.data);
      setProvider(res.provider);
    } catch (e) {
      if (e instanceof PlatformError && e.upgrade) setUpgrade(e.message);
      else setError(e instanceof Error ? e.message : 'Nu am putut obține alegerile AI');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Hero */}
      <div className="rounded-2xl bg-gradient-to-br from-rose-500/50 via-fuchsia-500/30 to-amber-500/40 p-[1px]">
        <div className="rounded-2xl bg-[#0d0d14] p-5 sm:p-7">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <h2 className="flex items-center gap-2.5 text-xl font-black tracking-tight text-white sm:text-2xl">
                <Dices className="h-6 w-6 text-rose-400" aria-hidden />
                Alegeri AI pentru tine
              </h2>
              <p className="mt-1 max-w-xl text-sm text-zinc-400">
                {user
                  ? 'Opt alegeri clasate de LLM-ul Animaxia după profilul tău de gusturi și istoricul de vizionare.'
                  : 'Opt alegeri clasate de LLM din bibliotecă. Conectează-te pentru alegeri personalizate pe profilul tău.'}
              </p>
            </div>
            <Button
              type="button"
              size="lg"
              onClick={fetchPicks}
              disabled={loading}
              className="bg-rose-600 font-bold text-white hover:bg-rose-500"
            >
              {loading ? <Loader2 className="animate-spin" aria-hidden /> : <Dices aria-hidden />}
              {loading ? 'Se gândește…' : picks ? 'Regenerează' : 'Obține alegerile AI'}
            </Button>
          </div>
        </div>
      </div>

      {upgrade && <UpgradeCard message={upgrade} />}
      {error && !upgrade && <ErrorState message={error} onRetry={fetchPicks} />}
      {loading && <LoadingCards count={8} />}

      {!loading && picks && picks.length === 0 && (
        <EmptyState
          title="Nicio alegere acum"
          message="Biblioteca e prea săracă pentru LLM — adaugă câteva titluri în plus și încearcă din nou."
        />
      )}

      {!loading && picks && picks.length > 0 && (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {picks.map((rec) => (
              <RecommendationCard key={rec.content.id} rec={rec} />
            ))}
          </div>
          <p className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
            Alegeri generate de Animaxia Intelligence <ProviderBadge provider={provider} />
          </p>
        </>
      )}
    </div>
  );
}

function RecommendationCard({ rec }: { rec: AiRecommendation }) {
  const [imgError, setImgError] = useState(false);
  const c = rec.content;
  const md = c.metadata || {};
  const poster = c.thumbnail || (typeof md.backdrop === 'string' ? md.backdrop : null);
  const showImage = Boolean(poster) && !imgError;

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-white/10 bg-white/[0.03] p-3">
      <div className="aspect-[2/3] w-full overflow-hidden rounded-lg border border-white/10 bg-white/[0.03]">
        {showImage ? (
          <img
            src={poster as string}
            alt={`${c.title} poster`}
            loading="lazy"
            onError={() => setImgError(true)}
            className="h-full w-full object-cover"
          />
        ) : (
          <BrandPlaceholder title={c.title} />
        )}
      </div>
      <p className="line-clamp-4 text-sm italic leading-relaxed text-zinc-300">
        <span className="font-bold text-rose-400">&ldquo;</span>
        {rec.reason}
        <span className="font-bold text-rose-400">&rdquo;</span>
      </p>
      <div className="mt-auto space-y-2.5">
        <p className="line-clamp-1 text-sm font-semibold text-zinc-100">{c.title}</p>
        <div className="flex items-center justify-between gap-2">
          <TypeBadge type={c.type} />
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => navigate(`/content/${c.id}`)}
            className="h-9 border-white/15 bg-white/5 font-semibold hover:bg-white/10"
          >
            View
          </Button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------- summarize tab ------------------------------- */

function SummarizeTab({ user }: { user: PlatformUser | null }) {
  const [selected, setSelected] = useState<Suggestion | null>(null);
  const [result, setResult] = useState<{ summary: string; provider: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [upgrade, setUpgrade] = useState<string | null>(null);

  async function summarize() {
    if (!selected || loading) return;
    setLoading(true);
    setError(null);
    setUpgrade(null);
    try {
      const res = await platform.aiSummarize(selected.id);
      setResult({ summary: res.summary, provider: res.provider });
    } catch (e) {
      if (e instanceof PlatformError && e.upgrade) setUpgrade(e.message);
      else setError(e instanceof Error ? e.message : 'Nu am putut genera rezumatul');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Card className="border-white/10 bg-white/[0.03]">
        <CardContent className="space-y-4 p-5 sm:p-6">
          <ContentPicker
            selected={selected}
            onSelect={(s) => {
              setSelected(s);
              setResult(null);
            }}
            label="Alege un titlu din biblioteca ta"
            inputId="summarize-picker"
          />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-zinc-500">
              {!user && 'Vizitatorii anonimi primesc 5 cereri AI pe zi — conectează-te pentru limite zilnice mai mari.'}
            </p>
            <Button
              type="button"
              onClick={summarize}
              disabled={!selected || loading}
              className="bg-rose-600 font-bold text-white hover:bg-rose-500"
            >
              {loading ? <Loader2 className="animate-spin" aria-hidden /> : <Sparkles aria-hidden />}
              {loading ? 'Se rezumă…' : 'Rezumă'}
            </Button>
          </div>
        </CardContent>
      </Card>

      {upgrade && <UpgradeCard message={upgrade} />}
      {error && !upgrade && <ErrorState message={error} onRetry={summarize} />}

      {loading && (
        <Card className="border-white/10 bg-white/[0.03]" aria-busy="true">
          <CardContent className="space-y-2.5 p-5 sm:p-6">
            <Skeleton className="h-5 w-2/5" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-11/12" />
            <Skeleton className="h-4 w-4/5" />
          </CardContent>
        </Card>
      )}

      {!loading && result && (
        <Card className="border-white/10 bg-white/[0.03]">
          <CardContent className="space-y-4 p-5 sm:p-6">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-base font-bold text-zinc-100">{selected?.title}</h3>
              <ProviderBadge provider={result.provider} />
            </div>
            <AiText text={result.summary} />
            <div className="flex justify-end border-t border-white/5 pt-3">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void copyText(result.summary)}
                className="border-white/15 bg-white/5 font-semibold hover:bg-white/10"
              >
                Copy summary
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/* -------------------------------- describe tab -------------------------------- */

const DESCRIBE_TYPES = ['movie', 'tv', 'anime', 'sports', 'news'] as const;

const DESCRIBE_EXAMPLES: { label: string; title: string; type: (typeof DESCRIBE_TYPES)[number]; genres: string }[] = [
  { label: 'Saga cyberpunk de răzbunare, în stil Neon', title: 'Neon Requiem', type: 'movie', genres: 'Sci-Fi, Action, Thriller' },
  { label: 'Anime cozy despre o brutărie', title: 'Flour & Feelings', type: 'anime', genres: 'Slice of Life, Comedy, Gourmet' },
];

function DescribeTab() {
  const [title, setTitle] = useState('');
  const [type, setType] = useState<(typeof DESCRIBE_TYPES)[number]>('movie');
  const [genres, setGenres] = useState('');
  const [result, setResult] = useState<{ description: string; provider: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [upgrade, setUpgrade] = useState<string | null>(null);

  async function describe() {
    const trimmed = title.trim();
    if (!trimmed || loading) return;
    setLoading(true);
    setError(null);
    setUpgrade(null);
    try {
      const genreList = genres
        .split(',')
        .map((g) => g.trim())
        .filter(Boolean);
      const res = await platform.aiDescribe({ title: trimmed, type, genres: genreList.length ? genreList : undefined });
      setResult({ description: res.description, provider: res.provider });
    } catch (e) {
      if (e instanceof PlatformError && e.upgrade) setUpgrade(e.message);
      else setError(e instanceof Error ? e.message : 'Nu am putut genera descrierea');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Card className="border-white/10 bg-white/[0.03]">
        <CardContent className="space-y-4 p-5 sm:p-6">
          <div className="space-y-2">
            <label htmlFor="describe-title" className="text-sm font-semibold text-zinc-300">
              Title
            </label>
            <Input
              id="describe-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Neon Requiem"
              maxLength={200}
              className="h-11 rounded-xl border-white/10 bg-white/[0.04] text-sm text-zinc-100 placeholder:text-zinc-500 focus-visible:border-rose-500/50 focus-visible:ring-rose-500/30"
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <label htmlFor="describe-type" className="text-sm font-semibold text-zinc-300">
                Type
              </label>
              <Select value={type} onValueChange={(v) => setType(v as (typeof DESCRIBE_TYPES)[number])}>
                <SelectTrigger
                  id="describe-type"
                  className="h-11 w-full rounded-xl border-white/10 bg-white/[0.04] text-sm text-zinc-100 focus-visible:ring-rose-500/30"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="border-white/10 bg-[#12121c] text-zinc-100">
                  {DESCRIBE_TYPES.map((t) => (
                    <SelectItem key={t} value={t} className="capitalize focus:bg-white/10 focus:text-white">
                      <span className="capitalize">{t}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <label htmlFor="describe-genres" className="text-sm font-semibold text-zinc-300">
                Genres <span className="font-normal text-zinc-500">(comma separated)</span>
              </label>
              <Input
                id="describe-genres"
                value={genres}
                onChange={(e) => setGenres(e.target.value)}
                placeholder="e.g. Sci-Fi, Action, Thriller"
                maxLength={200}
                className="h-11 rounded-xl border-white/10 bg-white/[0.04] text-sm text-zinc-100 placeholder:text-zinc-500 focus-visible:border-rose-500/50 focus-visible:ring-rose-500/30"
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Try</span>
            {DESCRIBE_EXAMPLES.map((ex) => (
              <button
                key={ex.label}
                type="button"
                onClick={() => {
                  setTitle(ex.title);
                  setType(ex.type);
                  setGenres(ex.genres);
                }}
                className="rounded-full border border-rose-500/25 bg-rose-500/10 px-3 py-1 text-xs font-medium text-rose-300 transition hover:bg-rose-500/20 hover:text-rose-200"
              >
                {ex.label}
              </button>
            ))}
          </div>

          <div className="flex justify-end">
            <Button
              type="button"
              onClick={describe}
              disabled={!title.trim() || loading}
              className="bg-rose-600 font-bold text-white hover:bg-rose-500"
            >
              {loading ? <Loader2 className="animate-spin" aria-hidden /> : <Sparkles aria-hidden />}
              {loading ? 'Se scrie…' : 'Generează descrierea'}
            </Button>
          </div>
        </CardContent>
      </Card>

      {upgrade && <UpgradeCard message={upgrade} />}
      {error && !upgrade && <ErrorState message={error} onRetry={describe} />}

      {loading && (
        <Card className="border-white/10 bg-white/[0.03]" aria-busy="true">
          <CardContent className="space-y-2.5 p-5 sm:p-6">
            <Skeleton className="h-5 w-2/5" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-11/12" />
          </CardContent>
        </Card>
      )}

      {!loading && result && (
        <Card className="border-white/10 bg-white/[0.03]">
          <CardContent className="space-y-4 p-5 sm:p-6">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-base font-bold text-zinc-100">{title.trim()}</h3>
              <ProviderBadge provider={result.provider} />
            </div>
            <AiText text={result.description} />
            <div className="flex justify-end border-t border-white/5 pt-3">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void copyText(result.description)}
                className="border-white/15 bg-white/5 font-semibold hover:bg-white/10"
              >
                Copy description
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/* ---------------------------------- chat tab ---------------------------------- */

function ChatTab({ user }: { user: PlatformUser | null }) {
  const [selected, setSelected] = useState<Suggestion | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [quotaError, setQuotaError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, busy]);

  if (!user) {
    return (
      <div className="mx-auto max-w-3xl">
        <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-white/10 bg-white/[0.02] p-10 text-center">
          <div className="rounded-full bg-rose-500/10 p-3 text-rose-300">
            <Sparkles className="h-6 w-6" aria-hidden />
          </div>
          <div>
            <p className="font-semibold text-zinc-100">Sign in to chat with Animaxia AI</p>
            <p className="mt-1 max-w-md text-sm text-zinc-400">
              Ask anything about any title in the library — characters, plots, watch order, hidden gems.
            </p>
          </div>
          <Button
            type="button"
            className="bg-rose-600 font-bold text-white hover:bg-rose-500"
            onClick={() => navigate('/auth')}
          >
            Sign in to chat
          </Button>
        </div>
      </div>
    );
  }

  async function send() {
    const text = input.trim();
    if (!text || !selected || busy) return;
    setBusy(true);
    setQuotaError(null);
    setMessages((prev) => [...prev, { role: 'user', text }]);
    setInput('');
    try {
      const res = await platform.aiChat(selected.id, text);
      setMessages((prev) => [...prev, { role: 'ai', text: res.reply }]);
    } catch (e) {
      if (e instanceof PlatformError && e.upgrade) {
        setQuotaError(e.message);
      } else {
        setMessages((prev) => [...prev, { role: 'ai', text: e instanceof Error ? e.message : 'Ceva nu a funcționat.' }]);
      }
    } finally {
      setBusy(false);
    }
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <Card className="border-white/10 bg-white/[0.03]">
        <CardContent className="p-5 sm:p-6">
          <ContentPicker
            selected={selected}
            onSelect={(s) => {
              setSelected(s);
              setMessages([]);
              setQuotaError(null);
            }}
            label="Alege un titlu despre care să vorbim"
            inputId="chat-picker"
          />
        </CardContent>
      </Card>

      <div
        ref={scrollRef}
        className="custom-scrollbar max-h-96 space-y-3 overflow-y-auto rounded-2xl border border-white/10 bg-black/20 p-4"
        aria-live="polite"
        aria-label="Conversație chat"
      >
        {messages.length === 0 && !busy && !quotaError && (
          <p className="py-8 text-center text-xs leading-relaxed text-zinc-500">
            {selected
              ? `Întreabă orice despre ${selected.title} — AI-ul cunoaște detaliile titlului și istoricul conversației voastre.`
              : 'Alege un titlu mai sus, apoi întreabă orice — personaje, intrigă, de unde să începi…'}
          </p>
        )}
        {messages.map((m, i) => (
          <div key={i} className={cn('flex gap-2.5', m.role === 'user' ? 'justify-end' : 'justify-start')}>
            {m.role === 'ai' && (
              <span className="mt-1 grid h-7 w-7 shrink-0 place-items-center rounded-full bg-gradient-to-br from-rose-500/30 to-fuchsia-500/30">
                <Sparkles className="h-3.5 w-3.5 text-rose-300" aria-hidden />
              </span>
            )}
            <div
              className={cn(
                'max-w-[85%] whitespace-pre-wrap break-words px-3.5 py-2 text-sm leading-relaxed',
                m.role === 'user'
                  ? 'rounded-2xl rounded-br-sm bg-rose-600/20 text-rose-50'
                  : 'rounded-2xl rounded-bl-sm bg-white/5 text-zinc-200',
              )}
            >
              {m.text}
            </div>
          </div>
        ))}
        {busy && (
          <div className="flex justify-start">
            <span className="mt-1 grid h-7 w-7 shrink-0 place-items-center rounded-full bg-gradient-to-br from-rose-500/30 to-fuchsia-500/30">
              <Sparkles className="h-3.5 w-3.5 text-rose-300" aria-hidden />
            </span>
            <div className="rounded-2xl rounded-bl-sm bg-white/5 px-3.5 py-2">
              <TypingDots />
            </div>
          </div>
        )}
      </div>

      {quotaError && <UpgradeCard message={quotaError} />}

      <div className="flex items-end gap-2">
        <Textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={selected ? `Întreabă despre ${selected.title}…` : 'Alege mai întâi un titlu…'}
          aria-label="Mesaj către AI-ul Animaxia"
          rows={2}
          maxLength={1000}
          disabled={!selected}
          className="min-h-11 flex-1 rounded-xl border-white/10 bg-white/[0.04] text-sm text-zinc-100 placeholder:text-zinc-500 focus-visible:border-rose-500/50 focus-visible:ring-rose-500/30 disabled:opacity-50"
        />
        <Button
          type="button"
          onClick={() => void send()}
          disabled={busy || !selected || !input.trim()}
          aria-label="Trimite mesajul"
          className="h-11 bg-rose-600 font-bold text-white hover:bg-rose-500"
        >
          {busy ? <Loader2 className="animate-spin" aria-hidden /> : <Send aria-hidden />}
        </Button>
      </div>
      <div className="flex items-center justify-between gap-3">
        <p className="text-[11px] text-zinc-600">Enter to send · Shift+Enter for a new line</p>
        {messages.length > 0 && (
          <button
            type="button"
            onClick={() => {
              setMessages([]);
              setQuotaError(null);
            }}
            className="text-[11px] font-semibold text-zinc-500 transition hover:text-zinc-300"
          >
            Șterge conversația
          </button>
        )}
      </div>
    </div>
  );
}

/* ------------------------------- personal tab ------------------------------- */

function PersonalTab({ user }: { user: PlatformUser | null }) {
  /* Hook order: fetch runs only while signed in; the sign-in card below is
     the same auth-gate pattern as the Chat tab. */
  const home = useApi(`ai-personal-home-${user?.id ?? 'anon'}`, () => platform.aiPersonalHome(), {
    enabled: Boolean(user),
  });

  if (!user) {
    return (
      <SignInCard
        title="Conectează-te pentru a-ți debloca pagina AI personală"
        message="Alegeri zilnice clasate după profilul tău de gusturi, un recapitulativ săptămânal și alegeri pentru-că-ai-vizionat — generate de Animaxia Intelligence."
        action="Conectează-te pentru personalizare"
      />
    );
  }

  if (home.loading && !home.data) {
    return (
      <div className="space-y-6" aria-busy="true">
        <Skeleton className="h-28 w-full rounded-2xl" />
        <LoadingCards count={6} />
        <Skeleton className="h-32 w-full rounded-2xl" />
      </div>
    );
  }

  if (home.error) {
    if (isQuotaError(home.error)) {
      return <UpgradeCard message={home.error} />;
    }
    return <ErrorState message={home.error} onRetry={home.refetch} />;
  }

  const data = home.data;
  if (!data) return null;

  return (
    <div className="space-y-8">
      {/* Greeting + mood + quota */}
      <div className="rounded-2xl bg-gradient-to-br from-rose-500/50 via-fuchsia-500/30 to-amber-500/40 p-[1px]">
        <div className="space-y-4 rounded-2xl bg-[#0d0d14] p-5 sm:p-7">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-lg font-black leading-snug tracking-tight text-white sm:text-2xl">{data.greeting}</p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1.5 rounded-full border border-rose-500/30 bg-rose-500/10 px-3 py-1 text-xs font-semibold text-rose-300">
                  <Sparkles className="h-3.5 w-3.5" aria-hidden /> mood: {data.mood}
                </span>
                <ProviderBadge provider={data.provider} />
                {data.degraded && <DegradedBadge />}
              </div>
            </div>
            <QuotaMeter quota={data.quota} />
          </div>
          {(data.aiProfile.tags.length > 0 || data.aiProfile.summary) && (
            <div className="space-y-2 border-t border-white/5 pt-4">
              <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-widest text-zinc-500">
                <Brain className="h-3.5 w-3.5 text-fuchsia-400" aria-hidden /> Your AI taste profile
              </p>
              {data.aiProfile.summary && <p className="text-sm leading-relaxed text-zinc-300">{data.aiProfile.summary}</p>}
              {data.aiProfile.tags.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {data.aiProfile.tags.map((tag) => (
                    <span
                      key={tag}
                      className="rounded-full border border-fuchsia-500/25 bg-fuchsia-500/10 px-2.5 py-0.5 text-[11px] font-medium text-fuchsia-300"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Daily picks */}
      <section aria-labelledby="personal-daily-picks" className="space-y-4">
        <h2 id="personal-daily-picks" className="text-lg font-bold tracking-tight text-zinc-100 sm:text-xl">
          Alegeri zilnice pentru tine
        </h2>
        {data.dailyPicks.length === 0 ? (
          <EmptyState
            title="Încă nicio alegere"
            message="Vizionează și notează câteva titluri ca AI-ul să-ți învețe gusturile."
          />
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-6">
            {data.dailyPicks.map((pick) => (
              <DailyPickCard key={pick.id} pick={pick} />
            ))}
          </div>
        )}
      </section>

      {/* Because you watched */}
      {data.becauseYouWatched.length > 0 && (
        <section aria-labelledby="personal-because" className="space-y-4">
          <h2 id="personal-because" className="text-lg font-bold tracking-tight text-zinc-100 sm:text-xl">
            Because you watched…
          </h2>
          <div className="custom-scrollbar flex gap-3 overflow-x-auto pb-2 sm:gap-4">
            {data.becauseYouWatched.map((item) => (
              <BecauseCard key={item.id} item={item} />
            ))}
          </div>
        </section>
      )}

      {/* Weekly recap */}
      <RecapCard preview={data.recapPreview} />
    </div>
  );
}

function QuotaMeter({ quota }: { quota: AiPersonalHomeResponse['quota'] }) {
  const pct = quota.limit > 0 ? Math.min(100, Math.round((quota.used / quota.limit) * 100)) : 0;
  const nearLimit = pct >= 80;
  return (
    <div className="w-full max-w-xs shrink-0 rounded-xl border border-white/10 bg-white/[0.03] p-3">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="font-semibold capitalize text-zinc-300">
          {quota.plan} · {quota.used}/{quota.limit} AI calls today
        </span>
        {nearLimit && (
          <button
            type="button"
            onClick={() => navigate('/premium')}
            className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-amber-300 transition hover:bg-amber-500/20"
          >
            upgrade
          </button>
        )}
      </div>
      <div
        role="progressbar"
        aria-label="Daily AI quota used"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-white/10"
      >
        <div
          className={cn('h-full rounded-full transition-all', nearLimit ? 'bg-amber-400' : 'bg-rose-500')}
          style={{ width: `${pct}%` }}
        />
      </div>
      {quota.perMinute > 0 && (
        <p className="mt-1.5 text-[10px] text-zinc-500">burst limit {quota.perMinute}/min</p>
      )}
    </div>
  );
}

function DailyPickCard({ pick }: { pick: AiRagPick }) {
  const [imgError, setImgError] = useState(false);
  const showImage = Boolean(pick.thumbnail) && !imgError;
  return (
    <button
      type="button"
      onClick={() => navigate(`/content/${pick.id}`)}
      aria-label={`Open ${pick.title}`}
      className="group flex h-full flex-col gap-2.5 rounded-xl border border-white/10 bg-white/[0.03] p-2.5 text-left transition hover:border-rose-500/40 hover:bg-white/[0.06] focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/60"
    >
      <div className="relative aspect-[2/3] w-full overflow-hidden rounded-lg border border-white/10 bg-white/[0.03]">
        {showImage ? (
          <img
            src={pick.thumbnail as string}
            alt={`${pick.title} poster`}
            loading="lazy"
            onError={() => setImgError(true)}
            className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
          />
        ) : (
          <BrandPlaceholder title={pick.title} />
        )}
        <span className="absolute right-1.5 top-1.5">
          <TypeBadge type={pick.type} />
        </span>
      </div>
      <p className="line-clamp-1 text-sm font-semibold text-zinc-100">{pick.title}</p>
      <p className="line-clamp-3 text-xs italic leading-relaxed text-zinc-400">{pick.reason}</p>
    </button>
  );
}

function BecauseCard({ item }: { item: AiPersonalHomeResponse['becauseYouWatched'][number] }) {
  const [imgError, setImgError] = useState(false);
  const showImage = Boolean(item.thumbnail) && !imgError;
  return (
    <button
      type="button"
      onClick={() => navigate(`/content/${item.id}`)}
      aria-label={`Open ${item.title}`}
      className="group w-[150px] shrink-0 space-y-2 text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/60 sm:w-[176px]"
    >
      <div className="aspect-[2/3] w-full overflow-hidden rounded-xl border border-white/10 bg-white/[0.03] transition group-hover:border-rose-500/40">
        {showImage ? (
          <img
            src={item.thumbnail as string}
            alt={`${item.title} poster`}
            loading="lazy"
            onError={() => setImgError(true)}
            className="h-full w-full object-cover"
          />
        ) : (
          <BrandPlaceholder title={item.title} />
        )}
      </div>
      <div>
        <p className="line-clamp-1 text-sm font-semibold text-zinc-100">{item.title}</p>
        <p className="line-clamp-2 text-[11px] leading-relaxed text-zinc-500">{item.because}</p>
      </div>
    </button>
  );
}

/** Recap preview with a lazy "See full recap" expander (fetches on first open). */
function RecapCard({ preview }: { preview: string }) {
  const [open, setOpen] = useState(false);
  const [recap, setRecap] = useState<AiPersonalRecapResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function loadRecap() {
    setOpen((prev) => !prev);
    if (!open && !recap && !loading) {
      setLoading(true);
      setError(null);
      platform
        .aiPersonalRecap()
        .then(setRecap)
        .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Nu am putut încărca recapitulativul'))
        .finally(() => setLoading(false));
    }
  }

  return (
    <Card className="border-white/10 bg-white/[0.03]">
      <CardContent className="space-y-4 p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="flex items-center gap-2 text-base font-bold text-zinc-100">
            <Bot className="h-4 w-4 text-rose-400" aria-hidden /> Săptămâna ta pe Animaxia
          </h3>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={loadRecap}
            aria-expanded={open}
            className="border-white/15 bg-white/5 font-semibold hover:bg-white/10"
          >
            {open ? 'Ascunde recapitulativul complet' : 'Vezi recapitulativul complet'}
            <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-180')} aria-hidden />
          </Button>
        </div>
        {!open && <p className="text-sm leading-relaxed text-zinc-300">{preview}</p>}
        {open &&
          (loading ? (
            <div className="space-y-2.5" aria-busy="true">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-11/12" />
              <Skeleton className="h-4 w-2/3" />
            </div>
          ) : error ? (
            <ErrorState compact message={error} onRetry={loadRecap} />
          ) : recap ? (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-0.5 font-mono text-[11px] text-zinc-400">
                  {recap.week}
                </span>
                <span className="rounded-full border border-rose-500/25 bg-rose-500/10 px-2.5 py-0.5 text-[11px] font-semibold text-rose-300">
                  {recap.stats.watched} watched
                </span>
                {recap.stats.topGenres.slice(0, 3).map((g) => (
                  <span key={g} className="rounded-full border border-fuchsia-500/25 bg-fuchsia-500/10 px-2.5 py-0.5 text-[11px] text-fuchsia-300">
                    {g}
                  </span>
                ))}
              </div>
              <AiText text={recap.recap} />
              {recap.stats.topTitles.length > 0 && (
                <p className="text-xs text-zinc-500">
                  Top titles: <span className="text-zinc-300">{recap.stats.topTitles.join(' · ')}</span>
                </p>
              )}
            </div>
          ) : null)}
      </CardContent>
    </Card>
  );
}

/* ------------------------------ assistant tab ------------------------------ */

interface AssistantMessage {
  role: 'user' | 'assistant';
  text: string;
  meta?: {
    provider: string;
    degraded: boolean;
    toolsUsed: AiAssistantResponse['toolsUsed'];
    memoriesUsed: number;
    refused: boolean;
  };
}

function AssistantTab({ user }: { user: PlatformUser | null }) {
  const [messages, setMessages] = useState<AssistantMessage[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [quotaError, setQuotaError] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, busy]);

  /* Restore the persisted conversation (oldest → newest) on mount. */
  useEffect(() => {
    if (!user) {
      setHistoryLoading(false);
      return;
    }
    let cancelled = false;
    setHistoryLoading(true);
    platform
      .aiAssistantHistory(20)
      .then((res) => {
        if (cancelled) return;
        const turns: { at: number; role: 'user' | 'assistant'; text: string }[] = [];
        for (const t of res.data) {
          if (t.role !== 'user' && t.role !== 'assistant') continue;
          const at = Date.parse(t.createdat);
          turns.push({ at: Number.isNaN(at) ? 0 : at, role: t.role, text: t.message });
        }
        turns.sort((a, b) => a.at - b.at);
        setMessages(turns.map(({ role, text }) => ({ role, text })));
      })
      .catch(() => {
        /* history is best-effort — start a fresh conversation */
      })
      .finally(() => {
        if (!cancelled) setHistoryLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [user]);

  if (!user) {
    return (
      <SignInCard
        title="Conectează-te pentru a vorbi cu Asistentul Animaxia"
        message="Un agent cu unelte care caută în bibliotecă, îți citește istoricul, verifică tendințe și planuri — cu memorie pe termen lung a conversațiilor voastre."
        action="Conectează-te pentru chat"
      />
    );
  }

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    setBusy(true);
    setQuotaError(null);
    setMessages((prev) => [...prev, { role: 'user', text }]);
    setInput('');
    try {
      const history: AiChatTurn[] = messages
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .slice(-8)
        .map((m) => ({ role: m.role, content: m.text }));
      const res: AiAssistantResponse = await platform.aiAssistant(text, history);
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          text: res.reply,
          meta: {
            provider: res.provider,
            degraded: res.degraded,
            toolsUsed: res.toolsUsed ?? [],
            memoriesUsed: res.memoriesUsed ?? 0,
            refused: Boolean(res.refused),
          },
        },
      ]);
    } catch (e) {
      if (e instanceof PlatformError && e.upgrade) {
        setQuotaError(e.message);
      } else if (isRateLimited(e)) {
        toast.error('Limita AI pe minut a fost atinsă — așteaptă câteva secunde și încearcă din nou.');
      } else {
        setMessages((prev) => [
          ...prev,
          { role: 'assistant', text: e instanceof Error ? e.message : 'Ceva nu a funcționat.' },
        ]);
      }
    } finally {
      setBusy(false);
    }
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-sm text-zinc-400">
          <Bot className="h-4 w-4 text-rose-400" aria-hidden />
          The Animaxia Assistant can call platform tools (search, trending, feed, plans, queue) and remembers past
          conversations.
        </p>
        {historyLoading && (
          <span className="inline-flex items-center gap-1.5 text-xs text-zinc-500">
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> loading history…
          </span>
        )}
      </div>

      <div
        ref={scrollRef}
        className="custom-scrollbar max-h-96 space-y-3 overflow-y-auto rounded-2xl border border-white/10 bg-black/20 p-4"
        aria-live="polite"
        aria-label="Assistant conversation"
      >
        {messages.length === 0 && !busy && !quotaError && !historyLoading && (
          <p className="py-8 text-center text-xs leading-relaxed text-zinc-500">
            Ask anything — &ldquo;what should I watch tonight?&rdquo;, &ldquo;what&apos;s trending?&rdquo;, &ldquo;how
            much is the pro plan?&rdquo;…
          </p>
        )}
        {messages.map((m, i) => (
          <div key={i} className={cn('flex gap-2.5', m.role === 'user' ? 'justify-end' : 'justify-start')}>
            {m.role === 'assistant' && (
              <span className="mt-1 grid h-7 w-7 shrink-0 place-items-center rounded-full bg-gradient-to-br from-rose-500/30 to-fuchsia-500/30">
                <Bot className="h-3.5 w-3.5 text-rose-300" aria-hidden />
              </span>
            )}
            <div className={cn('max-w-[85%]', m.role === 'user' && 'flex flex-col items-end')}>
              <div
                className={cn(
                  'whitespace-pre-wrap break-words px-3.5 py-2 text-sm leading-relaxed',
                  m.role === 'user'
                    ? 'rounded-2xl rounded-br-sm bg-rose-600/20 text-rose-50'
                    : 'rounded-2xl rounded-bl-sm bg-white/5 text-zinc-200',
                )}
              >
                {m.text}
              </div>
              {m.role === 'assistant' && m.meta && (
                <div className="mt-1.5 space-y-1.5">
                  <div className="flex flex-wrap items-center gap-1.5">
                    {m.meta.toolsUsed.map((t, ti) => (
                      <span
                        key={`${t.name}-${ti}`}
                        className={cn(
                          'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[10px] font-semibold',
                          t.ok
                            ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                            : 'border-rose-500/30 bg-rose-500/10 text-rose-300',
                        )}
                        title={`${t.name}(${JSON.stringify(t.args)})`}
                      >
                        <Wrench className="h-3 w-3" aria-hidden /> {t.name} · {t.ms}ms
                      </span>
                    ))}
                    {m.meta.memoriesUsed > 0 && (
                      <span className="inline-flex items-center gap-1 rounded-full border border-fuchsia-500/30 bg-fuchsia-500/10 px-2 py-0.5 font-mono text-[10px] font-semibold text-fuchsia-300">
                        <Brain className="h-3 w-3" aria-hidden /> {m.meta.memoriesUsed}{' '}
                        {m.meta.memoriesUsed === 1 ? 'memory' : 'memories'}
                      </span>
                    )}
                    <ProviderBadge provider={m.meta.provider} />
                    {m.meta.degraded && <DegradedBadge />}
                  </div>
                  {m.meta.refused && (
                    <p className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-2.5 py-1.5 text-[11px] leading-relaxed text-amber-300">
                      The assistant declined this request — it only helps with Animaxia-related topics.
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>
        ))}
        {busy && (
          <div className="flex justify-start">
            <span className="mt-1 grid h-7 w-7 shrink-0 place-items-center rounded-full bg-gradient-to-br from-rose-500/30 to-fuchsia-500/30">
              <Bot className="h-3.5 w-3.5 text-rose-300" aria-hidden />
            </span>
            <div className="rounded-2xl rounded-bl-sm bg-white/5 px-3.5 py-2">
              <TypingDots />
            </div>
          </div>
        )}
      </div>

      {quotaError && <UpgradeCard message={quotaError} />}

      <div className="flex items-end gap-2">
        <Textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Întreabă Asistentul Animaxia…"
          aria-label="Message the Animaxia Assistant"
          rows={2}
          maxLength={1000}
          className="min-h-11 flex-1 rounded-xl border-white/10 bg-white/[0.04] text-sm text-zinc-100 placeholder:text-zinc-500 focus-visible:border-rose-500/50 focus-visible:ring-rose-500/30"
        />
        <Button
          type="button"
          onClick={() => void send()}
          disabled={busy || !input.trim()}
          aria-label="Trimite mesajul"
          className="h-11 bg-rose-600 font-bold text-white hover:bg-rose-500"
        >
          {busy ? <Loader2 className="animate-spin" aria-hidden /> : <Send aria-hidden />}
        </Button>
      </div>
      <div className="flex items-center justify-between gap-3">
        <p className="text-[11px] text-zinc-600">Enter to send · Shift+Enter for a new line</p>
        {messages.length > 0 && (
          <button
            type="button"
            onClick={() => {
              setMessages([]);
              setQuotaError(null);
            }}
            className="text-[11px] font-semibold text-zinc-500 transition hover:text-zinc-300"
          >
            Șterge conversația
          </button>
        )}
      </div>
    </div>
  );
}

/* -------------------------------- rag lab tab -------------------------------- */

type RagMode = 'recommend' | 'summarize' | 'explain' | 'chat';

const RAG_MODES: { key: RagMode; label: string }[] = [
  { key: 'recommend', label: 'Recomandă' },
  { key: 'summarize', label: 'Rezumă' },
  { key: 'explain', label: 'Explică' },
  { key: 'chat', label: 'Chat cu conținutul' },
];

function RagLabTab({ user }: { user: PlatformUser | null }) {
  const [mode, setMode] = useState<RagMode>('recommend');
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <p className="rounded-xl border border-white/10 bg-black/30 px-3.5 py-2.5 font-mono text-[11px] leading-relaxed text-zinc-400">
        query <span className="text-rose-400">→</span> retrieve (vector) <span className="text-rose-400">→</span> rank{' '}
        <span className="text-rose-400">→</span> prompt <span className="text-rose-400">→</span> LLM
        <span className="ml-2 text-zinc-600">· every answer is grounded in the indexed library</span>
      </p>

      <div role="group" aria-label="RAG mode" className="flex flex-wrap gap-1.5">
        {RAG_MODES.map((m) => (
          <button
            key={m.key}
            type="button"
            onClick={() => setMode(m.key)}
            aria-pressed={mode === m.key}
            className={cn(
              'rounded-full border px-3.5 py-1.5 text-xs font-semibold transition',
              mode === m.key
                ? 'border-rose-500/60 bg-rose-600 text-white shadow-lg shadow-rose-900/30'
                : 'border-white/10 bg-white/[0.04] text-zinc-300 hover:border-white/25 hover:bg-white/10',
            )}
          >
            {m.label}
          </button>
        ))}
      </div>

      {mode === 'recommend' && <RagRecommendMode />}
      {mode === 'summarize' && <RagSummarizeMode />}
      {mode === 'explain' && <RagExplainMode />}
      {mode === 'chat' && <RagChatMode user={user} />}
    </div>
  );
}

const RAG_LIMITS = [4, 6, 8, 12] as const;

function RagRecommendMode() {
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState<number>(6);
  const [result, setResult] = useState<AiRagRecommendResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [upgrade, setUpgrade] = useState<string | null>(null);

  async function run() {
    if (loading) return;
    setLoading(true);
    setError(null);
    setUpgrade(null);
    try {
      setResult(await platform.aiRagRecommend({ query: query.trim() || undefined, limit }));
    } catch (e) {
      if (e instanceof PlatformError && e.upgrade) setUpgrade(e.message);
      else if (isRateLimited(e)) {
        toast.error('Limita AI pe minut a fost atinsă — așteaptă câteva secunde și încearcă din nou.');
        setError(e.message);
      } else setError(e instanceof Error ? e.message : 'Pipeline-ul RAG a eșuat');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card className="border-white/10 bg-white/[0.03]">
        <CardContent className="space-y-4 p-5 sm:p-6">
          <div className="space-y-2">
            <label htmlFor="rag-recommend-query" className="text-sm font-semibold text-zinc-300">
              What are you in the mood for?
            </label>
            <Input
              id="rag-recommend-query"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void run();
              }}
              placeholder="e.g. mind-bending sci-fi with a great ending"
              maxLength={300}
              className="h-11 rounded-xl border-white/10 bg-white/[0.04] text-sm text-zinc-100 placeholder:text-zinc-500 focus-visible:border-rose-500/50 focus-visible:ring-rose-500/30"
            />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <label htmlFor="rag-recommend-limit" className="text-xs font-semibold text-zinc-500">
                Results
              </label>
              <Select value={String(limit)} onValueChange={(v) => setLimit(Number(v))}>
                <SelectTrigger
                  id="rag-recommend-limit"
                  className="h-9 w-[72px] rounded-lg border-white/10 bg-white/[0.04] text-sm text-zinc-100"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="border-white/10 bg-[#12121c] text-zinc-100">
                  {RAG_LIMITS.map((n) => (
                    <SelectItem key={n} value={String(n)} className="focus:bg-white/10 focus:text-white">
                      {n}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button
              type="button"
              onClick={run}
              disabled={loading}
              className="bg-rose-600 font-bold text-white hover:bg-rose-500"
            >
              {loading ? <Loader2 className="animate-spin" aria-hidden /> : <Search aria-hidden />}
              {loading ? 'Se preiau datele…' : 'Rulează RAG'}
            </Button>
          </div>
        </CardContent>
      </Card>

      {upgrade && <UpgradeCard message={upgrade} />}
      {error && !upgrade && <ErrorState compact message={error} onRetry={run} />}
      {loading && <LoadingCards count={limit} />}

      {!loading && result && result.data.length === 0 && (
        <EmptyState title="Nicio potrivire" message="Indexul vectorial nu a găsit nimic apropiat de interogare — încearcă alte cuvinte." />
      )}

      {!loading && result && result.data.length > 0 && (
        <div className="space-y-3">
          {result.intro && (
            <p className="rounded-xl border border-white/10 bg-white/[0.03] p-3.5 text-sm italic leading-relaxed text-zinc-300">
              <span className="font-bold text-rose-400">&ldquo;</span>
              {result.intro}
              <span className="font-bold text-rose-400">&rdquo;</span>
            </p>
          )}
          <ul className="space-y-2.5">
            {result.data.map((pick) => (
              <li key={pick.id}>
                <button
                  type="button"
                  onClick={() => navigate(`/content/${pick.id}`)}
                  aria-label={`Open ${pick.title}`}
                  className="flex w-full items-start gap-3 rounded-xl border border-white/10 bg-white/[0.03] p-3 text-left transition hover:border-rose-500/40 hover:bg-white/[0.06] focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/60"
                >
                  <span className="h-16 w-11 shrink-0 overflow-hidden rounded-md border border-white/10 bg-white/[0.03]">
                    {pick.thumbnail ? (
                      <img src={pick.thumbnail} alt="" loading="lazy" className="h-full w-full object-cover" />
                    ) : (
                      <BrandPlaceholder title={pick.title} />
                    )}
                  </span>
                  <span className="min-w-0 flex-1 space-y-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-semibold text-zinc-100">{pick.title}</span>
                      <TypeBadge type={pick.type} />
                    </span>
                    <span className="block line-clamp-2 text-xs leading-relaxed text-zinc-400">{pick.reason}</span>
                  </span>
                  <span className="shrink-0 rounded-full border border-fuchsia-500/25 bg-fuchsia-500/10 px-2 py-0.5 font-mono text-[10px] font-semibold text-fuchsia-300">
                    {pick.score.toFixed(2)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <p className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
            sources: {result.data.length} · {result.personalized ? 'personalized ranking' : 'anonymous ranking'}
            <ProviderBadge provider={result.provider} />
            {result.degraded && <DegradedBadge />}
          </p>
        </div>
      )}
    </div>
  );
}

function RagSummarizeMode() {
  const [selected, setSelected] = useState<Suggestion | null>(null);
  const [result, setResult] = useState<AiRagSummarizeResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [upgrade, setUpgrade] = useState<string | null>(null);

  async function run() {
    if (!selected || loading) return;
    setLoading(true);
    setError(null);
    setUpgrade(null);
    try {
      setResult(await platform.aiRagSummarize(selected.id));
    } catch (e) {
      if (e instanceof PlatformError && e.upgrade) setUpgrade(e.message);
      else if (isRateLimited(e)) {
        toast.error('Limita AI pe minut a fost atinsă — așteaptă câteva secunde și încearcă din nou.');
        setError(e.message);
      } else setError(e instanceof Error ? e.message : 'Pipeline-ul RAG a eșuat');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card className="border-white/10 bg-white/[0.03]">
        <CardContent className="space-y-4 p-5 sm:p-6">
          <ContentPicker
            selected={selected}
            onSelect={(s) => {
              setSelected(s);
              setResult(null);
            }}
            label="Alege un titlu de rezumat (ancorat RAG)"
            inputId="rag-summarize-picker"
          />
          <div className="flex justify-end">
            <Button
              type="button"
              onClick={run}
              disabled={!selected || loading}
              className="bg-rose-600 font-bold text-white hover:bg-rose-500"
            >
              {loading ? <Loader2 className="animate-spin" aria-hidden /> : <Sparkles aria-hidden />}
              {loading ? 'Se rezumă…' : 'Rezumă'}
            </Button>
          </div>
        </CardContent>
      </Card>

      {upgrade && <UpgradeCard message={upgrade} />}
      {error && !upgrade && <ErrorState compact message={error} onRetry={run} />}

      {loading && (
        <Card className="border-white/10 bg-white/[0.03]" aria-busy="true">
          <CardContent className="space-y-2.5 p-5 sm:p-6">
            <Skeleton className="h-5 w-2/5" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-11/12" />
            <Skeleton className="h-4 w-4/5" />
          </CardContent>
        </Card>
      )}

      {!loading && result && (
        <Card className="border-white/10 bg-white/[0.03]">
          <CardContent className="space-y-4 p-5 sm:p-6">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-base font-bold text-zinc-100">{result.title || selected?.title}</h3>
              <span className="flex items-center gap-2">
                <ProviderBadge provider={result.provider} />
                {result.degraded && <DegradedBadge />}
              </span>
            </div>
            <AiText text={result.summary} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function RagExplainMode() {
  const [selected, setSelected] = useState<Suggestion | null>(null);
  const [question, setQuestion] = useState('');
  const [result, setResult] = useState<AiRagExplainResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [upgrade, setUpgrade] = useState<string | null>(null);

  async function run() {
    if (!selected || loading) return;
    setLoading(true);
    setError(null);
    setUpgrade(null);
    try {
      setResult(await platform.aiRagExplain(selected.id, question.trim() || undefined));
    } catch (e) {
      if (e instanceof PlatformError && e.upgrade) setUpgrade(e.message);
      else if (isRateLimited(e)) {
        toast.error('Limita AI pe minut a fost atinsă — așteaptă câteva secunde și încearcă din nou.');
        setError(e.message);
      } else setError(e instanceof Error ? e.message : 'Pipeline-ul RAG a eșuat');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card className="border-white/10 bg-white/[0.03]">
        <CardContent className="space-y-4 p-5 sm:p-6">
          <ContentPicker
            selected={selected}
            onSelect={(s) => {
              setSelected(s);
              setResult(null);
            }}
            label="Alege un titlu de explicat"
            inputId="rag-explain-picker"
          />
          <div className="space-y-2">
            <label htmlFor="rag-explain-question" className="text-sm font-semibold text-zinc-300">
              Întrebare de focus <span className="font-normal text-zinc-500">(opțional)</span>
            </label>
            <Input
              id="rag-explain-question"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="ex. De ce mi-ar plăcea? E finalul bun?"
              maxLength={300}
              className="h-11 rounded-xl border-white/10 bg-white/[0.04] text-sm text-zinc-100 placeholder:text-zinc-500 focus-visible:border-rose-500/50 focus-visible:ring-rose-500/30"
            />
          </div>
          <div className="flex justify-end">
            <Button
              type="button"
              onClick={run}
              disabled={!selected || loading}
              className="bg-rose-600 font-bold text-white hover:bg-rose-500"
            >
              {loading ? <Loader2 className="animate-spin" aria-hidden /> : <Sparkles aria-hidden />}
              {loading ? 'Se explică…' : 'Explică'}
            </Button>
          </div>
        </CardContent>
      </Card>

      {upgrade && <UpgradeCard message={upgrade} />}
      {error && !upgrade && <ErrorState compact message={error} onRetry={run} />}

      {loading && (
        <Card className="border-white/10 bg-white/[0.03]" aria-busy="true">
          <CardContent className="space-y-2.5 p-5 sm:p-6">
            <Skeleton className="h-5 w-2/5" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-11/12" />
            <Skeleton className="h-4 w-3/4" />
          </CardContent>
        </Card>
      )}

      {!loading && result && (
        <Card className="border-white/10 bg-white/[0.03]">
          <CardContent className="space-y-4 p-5 sm:p-6">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-base font-bold text-zinc-100">{result.title || selected?.title}</h3>
              <span className="flex items-center gap-2">
                <ProviderBadge provider={result.provider} />
                {result.degraded && <DegradedBadge />}
              </span>
            </div>
            <AiText text={result.explanation} />
            {result.similar.length > 0 && (
              <div className="space-y-2 border-t border-white/5 pt-3">
                <p className="text-xs font-semibold uppercase tracking-widest text-zinc-500">Retrieved neighbors</p>
                <div className="flex flex-wrap gap-1.5">
                  {result.similar.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => navigate(`/content/${s.id}`)}
                      className="rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[11px] font-medium text-zinc-300 transition hover:border-rose-500/40 hover:text-rose-200"
                    >
                      {s.title} <span className="font-mono text-fuchsia-400">· {s.score.toFixed(2)}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

interface RagChatMessage {
  role: 'user' | 'assistant';
  text: string;
  sources?: AiRagChatResponse['sources'];
}

function RagChatMode({ user }: { user: PlatformUser | null }) {
  const [selected, setSelected] = useState<Suggestion | null>(null);
  const [messages, setMessages] = useState<RagChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [quotaError, setQuotaError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, busy]);

  if (!user) {
    return (
      <SignInCard
        title="Conectează-te pentru chat cu conținutul"
        message="Chat-ul cu conținutul ancorează fiecare răspuns în faptele indexate ale titlului — disponibil pentru utilizatorii conectați."
        action="Conectează-te pentru chat"
      />
    );
  }

  async function send() {
    const text = input.trim();
    if (!text || !selected || busy) return;
    setBusy(true);
    setQuotaError(null);
    setMessages((prev) => [...prev, { role: 'user', text }]);
    setInput('');
    try {
      const history: AiChatTurn[] = messages
        .slice(-8)
        .map((m) => ({ role: m.role, content: m.text }));
      const res = await platform.aiRagChat(selected.id, text, history);
      setMessages((prev) => [...prev, { role: 'assistant', text: res.reply, sources: res.sources }]);
    } catch (e) {
      if (e instanceof PlatformError && e.upgrade) {
        setQuotaError(e.message);
      } else if (isRateLimited(e)) {
        toast.error('Limita AI pe minut a fost atinsă — așteaptă câteva secunde și încearcă din nou.');
      } else {
        setMessages((prev) => [
          ...prev,
          { role: 'assistant', text: e instanceof Error ? e.message : 'Ceva nu a funcționat.' },
        ]);
      }
    } finally {
      setBusy(false);
    }
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <div className="space-y-4">
      <Card className="border-white/10 bg-white/[0.03]">
        <CardContent className="p-5 sm:p-6">
          <ContentPicker
            selected={selected}
            onSelect={(s) => {
              setSelected(s);
              setMessages([]);
              setQuotaError(null);
            }}
            label="Alege un titlu despre care să vorbim"
            inputId="rag-chat-picker"
          />
        </CardContent>
      </Card>

      <div
        ref={scrollRef}
        className="custom-scrollbar max-h-96 space-y-3 overflow-y-auto rounded-2xl border border-white/10 bg-black/20 p-4"
        aria-live="polite"
        aria-label="Conversație RAG chat"
      >
        {messages.length === 0 && !busy && !quotaError && (
          <p className="py-8 text-center text-xs leading-relaxed text-zinc-500">
            {selected
              ? `Întreabă orice despre ${selected.title} — răspunsurile sunt ancorate în faptele indexate ale titlului și în vecinii lui vectoriali.`
              : 'Alege un titlu mai sus, apoi întreabă orice — pipeline-ul preia mai întâi fragmentele relevante.'}
          </p>
        )}
        {messages.map((m, i) => (
          <div key={i} className={cn('flex gap-2.5', m.role === 'user' ? 'justify-end' : 'justify-start')}>
            {m.role === 'assistant' && (
              <span className="mt-1 grid h-7 w-7 shrink-0 place-items-center rounded-full bg-gradient-to-br from-rose-500/30 to-fuchsia-500/30">
                <Database className="h-3.5 w-3.5 text-fuchsia-300" aria-hidden />
              </span>
            )}
            <div className={cn('max-w-[85%]', m.role === 'user' && 'flex flex-col items-end')}>
              <div
                className={cn(
                  'whitespace-pre-wrap break-words px-3.5 py-2 text-sm leading-relaxed',
                  m.role === 'user'
                    ? 'rounded-2xl rounded-br-sm bg-rose-600/20 text-rose-50'
                    : 'rounded-2xl rounded-bl-sm bg-white/5 text-zinc-200',
                )}
              >
                {m.text}
              </div>
              {m.role === 'assistant' && m.sources && m.sources.length > 0 && (
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-600">sources</span>
                  {m.sources.slice(0, 4).map((s) => (
                    <span
                      key={s.id}
                      className="inline-flex items-center gap-1 rounded-full border border-fuchsia-500/25 bg-fuchsia-500/10 px-2 py-0.5 font-mono text-[10px] font-semibold text-fuchsia-300"
                    >
                      {s.title} · {s.score.toFixed(2)}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
        {busy && (
          <div className="flex justify-start">
            <span className="mt-1 grid h-7 w-7 shrink-0 place-items-center rounded-full bg-gradient-to-br from-rose-500/30 to-fuchsia-500/30">
              <Database className="h-3.5 w-3.5 text-fuchsia-300" aria-hidden />
            </span>
            <div className="rounded-2xl rounded-bl-sm bg-white/5 px-3.5 py-2">
              <TypingDots />
            </div>
          </div>
        )}
      </div>

      {quotaError && <UpgradeCard message={quotaError} />}

      <div className="flex items-end gap-2">
        <Textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={selected ? `Întreabă despre ${selected.title}…` : 'Alege mai întâi un titlu…'}
          aria-label="Mesaj în RAG chat"
          rows={2}
          maxLength={1000}
          disabled={!selected}
          className="min-h-11 flex-1 rounded-xl border-white/10 bg-white/[0.04] text-sm text-zinc-100 placeholder:text-zinc-500 focus-visible:border-rose-500/50 focus-visible:ring-rose-500/30 disabled:opacity-50"
        />
        <Button
          type="button"
          onClick={() => void send()}
          disabled={busy || !selected || !input.trim()}
          aria-label="Trimite mesajul"
          className="h-11 bg-rose-600 font-bold text-white hover:bg-rose-500"
        >
          {busy ? <Loader2 className="animate-spin" aria-hidden /> : <Send aria-hidden />}
        </Button>
      </div>
    </div>
  );
}

/* --------------------------------- tools tab --------------------------------- */

function ToolsTab({ user }: { user: PlatformUser | null }) {
  const tools = useApi('ai-tools', () => platform.aiTools());

  if (tools.loading && !tools.data) {
    return (
      <div className="grid gap-4 sm:grid-cols-2" aria-busy="true">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-56 rounded-xl" />
        ))}
      </div>
    );
  }

  if (tools.error && !tools.data) {
    return <ErrorState message={tools.error} onRetry={tools.refetch} />;
  }

  const list: AiTool[] = tools.data?.data ?? [];
  if (list.length === 0) {
    return <EmptyState title="Nicio unealtă înregistrată" message="Catalogul de unelte al asistentului este gol." />;
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-zinc-500">
        Același catalog pe care îl apelează Asistentul Animaxia — rulează orice unealtă direct, cu argumente proprii
        (conectat, 20 rulări/min).
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        {list.map((tool) => (
          <ToolCard key={tool.name} tool={tool} signedIn={Boolean(user)} />
        ))}
      </div>
    </div>
  );
}

function ToolCard({ tool, signedIn }: { tool: AiTool; signedIn: boolean }) {
  const [open, setOpen] = useState(false);
  const [args, setArgs] = useState(() => JSON.stringify(tool.example, null, 2));
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<AiToolRunResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    if (running) return;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(args) as Record<string, unknown>;
    } catch {
      toast.error('Argumentele trebuie să fie JSON valid');
      return;
    }
    setRunning(true);
    setError(null);
    try {
      setResult(await platform.aiToolRun(tool.name, parsed));
    } catch (e) {
      if (isRateLimited(e)) toast.error('Limita pe minut a fost atinsă — încearcă din nou într-un minut.');
      setError(e instanceof Error ? e.message : 'Rularea uneltei a eșuat');
    } finally {
      setRunning(false);
    }
  }

  return (
    <Card className="flex h-full flex-col border-white/10 bg-white/[0.03]">
      <CardContent className="flex h-full flex-col gap-3 p-5">
        <div className="flex items-start justify-between gap-2">
          <p className="font-mono text-sm font-bold text-rose-300">{tool.name}</p>
          {tool.required.length > 0 && (
            <span className="shrink-0 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-amber-300">
              {tool.required.length} obligatorii
            </span>
          )}
        </div>
        <p className="text-xs leading-relaxed text-zinc-400">{tool.description}</p>
        <div className="space-y-1.5">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-zinc-600">Parametri</p>
          <div className="space-y-1">
            {Object.entries(tool.parameters).map(([key, spec]) => (
              <p key={key} className="font-mono text-[11px] leading-relaxed">
                <span className={cn(tool.required.includes(key) ? 'font-bold text-amber-300' : 'text-zinc-300')}>
                  {key}
                </span>
                <span className="text-zinc-600"> — {spec}</span>
              </p>
            ))}
          </div>
        </div>

        <div className="mt-auto space-y-2.5 border-t border-white/5 pt-3">
          {!open ? (
            signedIn ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setOpen(true)}
                className="w-full border-white/15 bg-white/5 font-semibold hover:bg-white/10"
              >
                <Wrench aria-hidden /> Rulează această unealtă
              </Button>
            ) : (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => navigate('/auth')}
                className="w-full border-white/15 bg-white/5 font-semibold hover:bg-white/10"
              >
                Conectează-te pentru a rula unelte
              </Button>
            )
          ) : (
            <div className="space-y-2.5">
              <label htmlFor={`tool-args-${tool.name}`} className="sr-only">
                Argumente JSON pentru {tool.name}
              </label>
              <Textarea
                id={`tool-args-${tool.name}`}
                value={args}
                onChange={(e) => setArgs(e.target.value)}
                spellCheck={false}
                rows={4}
                className="custom-scrollbar rounded-xl border-white/10 bg-black/40 font-mono text-[11px] leading-relaxed text-zinc-200 focus-visible:border-rose-500/50 focus-visible:ring-rose-500/30"
              />
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  onClick={run}
                  disabled={running}
                  className="bg-rose-600 font-bold text-white hover:bg-rose-500"
                >
                  {running ? <Loader2 className="animate-spin" aria-hidden /> : <Sparkles aria-hidden />}
                  {running ? 'Se rulează…' : 'Rulează'}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setOpen(false);
                    setResult(null);
                    setError(null);
                  }}
                  className="text-zinc-400 hover:text-zinc-200"
                >
                  Închide
                </Button>
              </div>
            </div>
          )}

          {error && <ErrorState compact message={error} onRetry={run} />}

          {result && (
            <div className="space-y-1.5">
              <p className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-widest text-zinc-600">
                Result
                <span className="inline-flex items-center gap-1 rounded-full border border-fuchsia-500/25 bg-fuchsia-500/10 px-2 py-0.5 font-mono text-[10px] font-semibold normal-case tracking-normal text-fuchsia-300">
                  {result.ms}ms
                </span>
                {result.ok ? (
                  <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold normal-case tracking-normal text-emerald-300">
                    ok
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 rounded-full border border-rose-500/25 bg-rose-500/10 px-2 py-0.5 text-[10px] font-semibold normal-case tracking-normal text-rose-300">
                    failed
                  </span>
                )}
              </p>
              <pre className="custom-scrollbar max-h-72 overflow-auto rounded-xl border border-white/10 bg-black/40 p-3 font-mono text-[11px] leading-relaxed text-zinc-300">
                {JSON.stringify(result.result, null, 2)}
              </pre>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export default AiView;
