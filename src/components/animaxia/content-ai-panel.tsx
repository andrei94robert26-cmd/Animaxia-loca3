'use client';

/**
 * content-ai-panel.tsx — "AI assistant" panel for a library title: AI summary
 * (aiSummarize) + Ask Animaxia AI (RAG-grounded chat with sources), Explain
 * this (match score + vector neighbors) and More like this (vector recommend).
 * Auth-gated chat with plan-quota (402) upgrade card. Anonymous summaries and
 * recommendations are allowed (5/day anonymous quota).
 */

import { useEffect, useRef, useState } from 'react';
import { Crown, Loader2, Search, Send, Sparkles, Zap } from 'lucide-react';
import { toast } from 'sonner';
import {
  platform,
  PlatformError,
  type AiChatTurn,
  type AiRagChatResponse,
  type AiRagExplainResponse,
  type AiRagPick,
  type AiRagRecommendResponse,
} from '@/lib/animaxia/platform';
import { navigate } from '@/lib/animaxia/router';
import { useApi } from '@/lib/animaxia/hooks';
import { useAuth } from '@/components/animaxia/auth-provider';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { BrandPlaceholder, ErrorState, TypeBadge } from './states';

/* ------------------------------- local helpers ------------------------------ */

interface ChatMessage {
  role: 'user' | 'ai';
  text: string;
  sources?: AiRagChatResponse['sources'];
}

/** Renders an AI text: bullet lines ("- " / "• ") become styled list items. */
function SummaryText({ text }: { text: string }) {
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

function UpgradeCard({ message, compact }: { message: string; compact?: boolean }) {
  return (
    <div className="rounded-xl border border-amber-500/30 bg-amber-500/[0.07] p-4 text-sm">
      <p className="flex items-center gap-2 font-semibold text-amber-300">
        <Crown className="h-4 w-4 shrink-0" aria-hidden />
        Daily AI limit reached
      </p>
      <p className="mt-1 text-xs leading-relaxed text-zinc-400">{message}</p>
      <Button
        type="button"
        size="sm"
        className={cn('mt-3 bg-rose-600 font-bold text-white hover:bg-rose-500', compact && 'mt-2')}
        onClick={() => navigate('/premium')}
      >
        <Crown aria-hidden /> Upgrade plan
      </Button>
    </div>
  );
}

/* ---------------------------------- panel ---------------------------------- */

export function ContentAiPanel({ contentId, title }: { contentId: number; title: string }) {
  const [tab, setTab] = useState<'summary' | 'ask' | 'explain' | 'similar'>('summary');

  return (
    <Card id="ai-assistant" className="h-fit border-white/10 bg-white/[0.03]">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2.5 text-sm font-bold uppercase tracking-widest text-zinc-400">
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-rose-500/30 to-fuchsia-500/30">
            <Sparkles className="h-4 w-4 text-rose-300" aria-hidden />
          </span>
          AI assistant
          <span className="inline-flex items-center gap-1 rounded-full border border-fuchsia-500/30 bg-fuchsia-500/10 px-2 py-0.5 font-mono text-[10px] font-bold tracking-widest text-fuchsia-300">
            <Sparkles className="h-3 w-3" aria-hidden /> RAG
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <Tabs value={tab} onValueChange={(v) => setTab(v as 'summary' | 'ask' | 'explain' | 'similar')}>
          <TabsList className="custom-scrollbar h-10 w-full gap-1 overflow-x-auto rounded-xl border border-white/10 bg-white/[0.03] p-1">
            <TabsTrigger
              value="summary"
              className="shrink-0 whitespace-nowrap rounded-lg px-3 text-zinc-400 hover:text-zinc-100 data-[state=active]:bg-rose-600 data-[state=active]:text-white sm:px-4"
            >
              Rezumat
            </TabsTrigger>
            <TabsTrigger
              value="ask"
              className="shrink-0 whitespace-nowrap rounded-lg px-3 text-zinc-400 hover:text-zinc-100 data-[state=active]:bg-rose-600 data-[state=active]:text-white sm:px-4"
            >
              Întreabă AI-ul Animaxia
            </TabsTrigger>
            <TabsTrigger
              value="explain"
              className="shrink-0 whitespace-nowrap rounded-lg px-3 text-zinc-400 hover:text-zinc-100 data-[state=active]:bg-rose-600 data-[state=active]:text-white sm:px-4"
            >
              Explică-mi
            </TabsTrigger>
            <TabsTrigger
              value="similar"
              className="shrink-0 whitespace-nowrap rounded-lg px-3 text-zinc-400 hover:text-zinc-100 data-[state=active]:bg-rose-600 data-[state=active]:text-white sm:px-4"
            >
              Semănătoare cu aceasta
            </TabsTrigger>
          </TabsList>
          <TabsContent value="summary" className="pt-4">
            <SummaryPane contentId={contentId} title={title} />
          </TabsContent>
          <TabsContent value="ask" className="pt-4">
            <AskPane contentId={contentId} title={title} />
          </TabsContent>
          <TabsContent value="explain" className="pt-4">
            <ExplainPane contentId={contentId} title={title} />
          </TabsContent>
          <TabsContent value="similar" className="pt-4">
            <SimilarPane contentId={contentId} title={title} />
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}

/* ------------------------------- summary pane ------------------------------- */

function SummaryPane({ contentId, title }: { contentId: number; title: string }) {
  const [result, setResult] = useState<{ summary: string; provider: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function summarize() {
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      const res = await platform.aiSummarize(contentId);
      setResult({ summary: res.summary, provider: res.provider });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Nu am putut genera rezumatul');
    } finally {
      setLoading(false);
    }
  }

  async function copy() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.summary);
      toast.success('Rezumatul a fost copiat în clipboard');
    } catch {
      toast.error('Clipboardul nu este disponibil în acest browser');
    }
  }

  if (loading) {
    return (
      <div className="space-y-2.5" aria-busy="true" aria-label="Se generează rezumatul">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-11/12" />
        <Skeleton className="h-4 w-4/5" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    );
  }

  if (error) {
    return <ErrorState compact message={error} onRetry={summarize} />;
  }

  if (!result) {
    return (
      <div className="space-y-3">
        <p className="text-sm leading-relaxed text-zinc-400">
          Generează un rezumat AI rapid pentru <span className="font-semibold text-zinc-200">{title}</span> — perfect
          pentru prindere în ritm înainte de vizionare.
        </p>
        <Button
          type="button"
          onClick={summarize}
          className="w-full bg-rose-600 font-bold text-white hover:bg-rose-500"
        >
          <Sparkles aria-hidden /> Rezumă acest titlu
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <SummaryText text={result.summary} />
      <div className="flex items-center justify-between gap-3 border-t border-white/5 pt-3">
        <ProviderBadge provider={result.provider} />
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={copy}
          className="border-white/15 bg-white/5 font-semibold hover:bg-white/10"
        >
          Copy
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------ ask pane (RAG) ------------------------------ */

function AskPane({ contentId, title }: { contentId: number; title: string }) {
  const { user } = useAuth();
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
      <div className="space-y-3 text-center">
        <p className="text-sm leading-relaxed text-zinc-400">
          Sign in to ask the Animaxia AI about <span className="font-semibold text-zinc-200">{title}</span> — every
          answer is grounded in the title&apos;s indexed facts.
        </p>
        <Button
          type="button"
          className="bg-rose-600 font-bold text-white hover:bg-rose-500"
          onClick={() => navigate('/auth')}
        >
          Sign in to chat
        </Button>
      </div>
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
      /* Send the last 8 turns of client-side history for context. */
      const history: AiChatTurn[] = messages
        .slice(-8)
        .map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.text }));
      const res = await platform.aiRagChat(contentId, text, history);
      setMessages((prev) => [...prev, { role: 'ai', text: res.reply, sources: res.sources }]);
    } catch (e) {
      if (e instanceof PlatformError && e.upgrade) {
        setQuotaError(e.message);
      } else if (e instanceof PlatformError && e.status === 429) {
        toast.error('Limita AI pe minut a fost atinsă — așteaptă câteva secunde și încearcă din nou.');
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
    <div className="space-y-3">
      <div
        ref={scrollRef}
        className="custom-scrollbar max-h-96 space-y-3 overflow-y-auto rounded-xl border border-white/10 bg-black/20 p-3"
        aria-live="polite"
      >
        {messages.length === 0 && !busy && !quotaError && (
          <p className="py-6 text-center text-xs leading-relaxed text-zinc-500">
            Ask anything about <span className="font-semibold text-zinc-300">{title}</span> — characters, plot, where to
            start, similar vibes…
          </p>
        )}
        {messages.map((m, i) => (
          <div key={i} className={cn('flex gap-2', m.role === 'user' ? 'justify-end' : 'justify-start')}>
            {m.role === 'ai' && (
              <span className="mt-1 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-gradient-to-br from-rose-500/30 to-fuchsia-500/30">
                <Sparkles className="h-3 w-3 text-rose-300" aria-hidden />
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
              {m.role === 'ai' && m.sources && m.sources.length > 0 && (
                <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px] leading-relaxed text-zinc-500">
                  <span className="font-semibold uppercase tracking-wider">Bazat pe:</span>
                  {m.sources.slice(0, 3).map((s) => (
                    <span
                      key={s.id}
                      className="inline-flex items-center gap-1 rounded-full border border-fuchsia-500/25 bg-fuchsia-500/10 px-2 py-0.5 font-mono text-[10px] font-semibold text-fuchsia-300"
                    >
                      {s.title} · {s.score.toFixed(2)}
                    </span>
                  ))}
                </p>
              )}
            </div>
          </div>
        ))}
        {busy && (
          <div className="flex justify-start">
            <span className="mt-1 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-gradient-to-br from-rose-500/30 to-fuchsia-500/30">
              <Sparkles className="h-3 w-3 text-rose-300" aria-hidden />
            </span>
            <div className="rounded-2xl rounded-bl-sm bg-white/5 px-3.5 py-2">
              <TypingDots />
            </div>
          </div>
        )}
      </div>

      {quotaError && <UpgradeCard message={quotaError} compact />}

      <div className="flex items-end gap-2">
        <Textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={`Întreabă despre ${title}…`}
          aria-label={`Întreabă AI-ul despre ${title}`}
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
      {messages.length > 0 && (
        <button
          type="button"
          onClick={() => {
            setMessages([]);
            setQuotaError(null);
          }}
          className="text-[11px] font-semibold text-zinc-500 transition hover:text-zinc-300"
        >
          Clear conversation
        </button>
      )}
    </div>
  );
}

/* ------------------------------ explain pane ------------------------------ */

function ExplainPane({ contentId, title }: { contentId: number; title: string }) {
  const [result, setResult] = useState<AiRagExplainResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [upgrade, setUpgrade] = useState<string | null>(null);

  async function explain() {
    if (loading) return;
    setLoading(true);
    setError(null);
    setUpgrade(null);
    try {
      setResult(await platform.aiRagExplain(contentId));
    } catch (e) {
      if (e instanceof PlatformError && e.upgrade) setUpgrade(e.message);
      else if (e instanceof PlatformError && e.status === 429) {
        toast.error('Limita AI pe minut a fost atinsă — așteaptă câteva secunde și încearcă din nou.');
        setError(e.message);
      } else setError(e instanceof Error ? e.message : 'Nu am putut genera explicația');
    } finally {
      setLoading(false);
    }
  }

  const matchPct = result?.matchScore != null ? Math.round(result.matchScore * 100) : null;

  return (
    <div className="space-y-3">
      {!result && !loading && !error && !upgrade && (
        <div className="space-y-3">
          <p className="text-sm leading-relaxed text-zinc-400">
            Let the RAG engine explain <span className="font-semibold text-zinc-200">{title}</span> for your taste —
            vector match, reasoning and the nearest neighbors it retrieved.
          </p>
          <Button
            type="button"
            onClick={explain}
            className="w-full bg-rose-600 font-bold text-white hover:bg-rose-500"
          >
            <Search aria-hidden /> Explain this title
          </Button>
        </div>
      )}

      {upgrade && <UpgradeCard message={upgrade} compact />}
      {error && !upgrade && <ErrorState compact message={error} onRetry={explain} />}

      {loading && (
        <div className="space-y-2.5" aria-busy="true" aria-label="Generating explanation">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-11/12" />
          <Skeleton className="h-4 w-4/5" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      )}

      {!loading && result && (
        <div className="space-y-4">
          {matchPct != null && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="font-semibold text-zinc-300">Potrivirea ta</span>
                <span className="font-black text-rose-300">{matchPct}%</span>
              </div>
              <div
                role="progressbar"
                aria-label="Potrivirea ta with this title"
                aria-valuenow={matchPct}
                aria-valuemin={0}
                aria-valuemax={100}
                className="h-2 w-full overflow-hidden rounded-full bg-white/10"
              >
                <div className="h-full rounded-full bg-gradient-to-r from-rose-500 to-fuchsia-500" style={{ width: `${matchPct}%` }} />
              </div>
            </div>
          )}
          <SummaryText text={result.explanation} />
          {result.similar.length > 0 && (
            <div className="space-y-2 border-t border-white/5 pt-3">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-zinc-500">Vecini vectoriali</p>
              <div className="flex flex-wrap gap-1.5">
                {result.similar.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => navigate(`/content/${s.id}`)}
                    className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[11px] font-medium text-zinc-300 transition hover:border-rose-500/40 hover:text-rose-200"
                  >
                    {s.title}
                    <span className="font-mono text-fuchsia-400">· {s.score.toFixed(2)}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="flex items-center justify-between gap-3 border-t border-white/5 pt-3">
            <ProviderBadge provider={result.provider} />
            {result.degraded && (
              <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-amber-300">
                <Zap className="h-3 w-3" aria-hidden /> mod offline
              </span>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={explain}
              disabled={loading}
              className="ml-auto border-white/15 bg-white/5 font-semibold hover:bg-white/10"
            >
              Regenerate
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ----------------------------- similar pane ----------------------------- */

/** Best-effort daily-quota (402) detection from a useApi error string — the
 *  backend replies "Daily AI quota reached for your plan" with upgrade:true. */
function isQuotaMessage(message: string | null): boolean {
  return Boolean(message && /daily ai quota|quota reached|upgrade your plan/i.test(message));
}

function SimilarPane({ contentId, title }: { contentId: number; title: string }) {
  /* Vector recommend seeded with this title — public with anonymous quota. */
  const rec = useApi(`ai-similar-${contentId}`, () => platform.aiRagRecommend({ query: title, limit: 6 }));

  const picks: AiRagPick[] = (rec.data?.data ?? []).filter((p) => p.id !== contentId);

  if (rec.loading) {
    return (
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3" aria-busy="true" aria-label="Finding similar titles">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="space-y-1.5">
            <Skeleton className="aspect-[2/3] w-full rounded-lg" />
            <Skeleton className="h-3.5 w-4/5" />
          </div>
        ))}
      </div>
    );
  }

  if (rec.error) {
    if (isQuotaMessage(rec.error)) {
      return <UpgradeCard message={rec.error} compact />;
    }
    return <ErrorState compact message={rec.error} onRetry={rec.refetch} />;
  }

  if (picks.length === 0) {
    return (
      <div className="space-y-3 text-center">
        <p className="text-sm leading-relaxed text-zinc-400">
          No close vector matches for <span className="font-semibold text-zinc-200">{title}</span> yet.
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={rec.refetch}
          className="border-white/15 bg-white/5 font-semibold hover:bg-white/10"
        >
          Try again
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {picks.map((pick) => (
          <SimilarCard key={pick.id} pick={pick} />
        ))}
      </div>
      <div className="flex items-center justify-between gap-3 border-t border-white/5 pt-3">
        <ProviderBadge provider={rec.data?.provider ?? ''} />
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={rec.refetch}
          className="border-white/15 bg-white/5 font-semibold hover:bg-white/10"
        >
          Refresh picks
        </Button>
      </div>
    </div>
  );
}

function SimilarCard({ pick }: { pick: AiRagPick }) {
  const [imgError, setImgError] = useState(false);
  const showImage = Boolean(pick.thumbnail) && !imgError;
  return (
    <button
      type="button"
      onClick={() => navigate(`/content/${pick.id}`)}
      aria-label={`Open ${pick.title}`}
      className="group space-y-1.5 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/60"
    >
      <div className="aspect-[2/3] w-full overflow-hidden rounded-lg border border-white/10 bg-white/[0.03] transition group-hover:border-rose-500/40">
        {showImage ? (
          <img
            src={pick.thumbnail as string}
            alt={`${pick.title} poster`}
            loading="lazy"
            onError={() => setImgError(true)}
            className="h-full w-full object-cover"
          />
        ) : (
          <BrandPlaceholder title={pick.title} />
        )}
      </div>
      <p className="line-clamp-1 text-xs font-semibold text-zinc-100">{pick.title}</p>
      <div className="flex items-center justify-between gap-1.5">
        <TypeBadge type={pick.type} />
        <span className="font-mono text-[10px] text-fuchsia-400">{pick.score.toFixed(2)}</span>
      </div>
    </button>
  );
}
