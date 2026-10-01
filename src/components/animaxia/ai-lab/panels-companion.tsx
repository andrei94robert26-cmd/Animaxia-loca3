'use client';

/**
 * ai-lab/panels-companion.tsx — FAZA 35 (WS5): AI Companion.
 * Picker de titlu → context RAG (sinopsis, genuri, recenzii) + chat cu
 * istoric (max 8 mesaje trimise de client), badge provider per răspuns și
 * indicator „RAG: sinopsis ✓ recenzii ✓".
 */

import { useRef, useState } from 'react';
import { Loader2, Send } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/animaxia/api';
import { useApi } from '@/lib/animaxia/hooks';
import type { AiLabChatMessage, AiLabChatResponse } from '@/lib/animaxia/types';
import { ErrorState, RatingBadge, TypeBadge } from '../states';
import { cn } from '@/lib/utils';
import { ContentPicker, LabCard, LabProviderBadge, type PickedContent } from './lab-ui';

const QUICK_PROMPTS = [
  'Merită să-l văd?',
  'Cu ce să încep?',
  'Explică-mi finalul fără spoilere',
];

/** Indicator RAG onest: preferăm ce raportează efectiv ultimul răspuns
 *  (usedContext); dacă backend-ul nu-l trimite, arătăm onest doar ce context
 *  are Companion-ul disponibil (sinopsis/recenzii din /context). */
function RagIndicator({
  used,
  available,
}: {
  used?: { synopsis: boolean; reviews: boolean } | null;
  available: { synopsis: boolean; reviews: boolean };
}) {
  const s = used?.synopsis ?? available.synopsis;
  const r = used?.reviews ?? available.reviews;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5 text-[10px] font-semibold text-zinc-500">
      {used ? 'RAG:' : 'RAG (context disponibil):'}
      <span className={s ? 'text-emerald-300' : 'text-zinc-600'}>sinopsis {s ? '✓' : '✗'}</span>
      <span aria-hidden>·</span>
      <span className={r ? 'text-emerald-300' : 'text-zinc-600'}>recenzii {r ? '✓' : '✗'}</span>
    </span>
  );
}

export function CompanionPanel() {
  const [picked, setPicked] = useState<PickedContent | null>(null);
  const [messages, setMessages] = useState<AiLabChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [lastMeta, setLastMeta] = useState<AiLabChatResponse | null>(null);
  const [chatError, setChatError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const ctxRes = useApi(
    picked ? `ai-lab-companion-ctx-${picked.id}` : 'ai-lab-companion-ctx-idle',
    () => api.aiLabCompanionContext(picked!.id),
    { enabled: !!picked },
  );

  const pickContent = (c: PickedContent) => {
    setPicked(c);
    setMessages([]);
    setLastMeta(null);
    setChatError(null);
    setInput('');
  };

  const send = async (text?: string) => {
    const content = (text ?? input).trim();
    if (!picked || !content || sending) return;
    const userMsg: AiLabChatMessage = { role: 'user', content };
    const history = [...messages, userMsg].slice(-8); // max 8 mesaje trimise
    setInput('');
    setChatError(null);
    setMessages((m) => [...m, userMsg]);
    setSending(true);
    try {
      const r = await api.aiLabCompanionChat(picked.id, history);
      setMessages((m) => [...m, { role: 'assistant', content: r.answer }]);
      setLastMeta(r);
      requestAnimationFrame(() => {
        listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
      });
    } catch (e) {
      setChatError(e instanceof Error ? e.message : 'Chat-ul a eșuat');
      toast.error('Companion nu a putut răspunde', {
        description: e instanceof Error ? e.message : 'backend-ul nu răspunde',
      });
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="space-y-4">
      <ContentPicker
        label="Alege un titlu despre care să vorbim"
        picked={picked}
        onPick={pickContent}
        onClear={() => {
          setPicked(null);
          setMessages([]);
          setLastMeta(null);
        }}
      />

      {picked ? (
        <>
          {/* Context RAG */}
          {ctxRes.loading ? (
            <LabCard title="Context RAG">
              <div className="space-y-2">
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-5/6" />
              </div>
            </LabCard>
          ) : ctxRes.error ? (
            <ErrorState message={ctxRes.error} onRetry={() => void ctxRes.refetch()} compact />
          ) : ctxRes.data ? (
            (() => {
              const d = ctxRes.data;
              const ctx = d.context;
              const ready = d.ready ?? Boolean(ctx.synopsis || ctx.reviews.length > 0);
              const avgReview = ctx.avgReviewRating ?? ctx.avgRating;
              return (
            <LabCard
              title="Context RAG — ce vede Companion-ul"
              action={
                ready ? (
                  <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-bold text-emerald-300">
                    gata ✓
                  </span>
                ) : (
                  <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-bold text-amber-300">
                    context parțial
                  </span>
                )
              }
            >
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <TypeBadge type={ctx.type ?? picked.type} />
                  {ctx.year ? (
                    <span className="text-[11px] text-zinc-500">{String(ctx.year)}</span>
                  ) : null}
                  <RatingBadge value={ctx.rating} />
                  {avgReview != null ? (
                    <span className="text-[11px] text-zinc-500">
                      media recenziilor: {Number(avgReview).toFixed(1)}/5
                    </span>
                  ) : null}
                  {ctx.genres.map((g) => (
                    <span
                      key={g}
                      className="rounded-full border border-white/10 bg-white/[0.03] px-2 py-0.5 text-[10px] font-medium text-zinc-400"
                    >
                      {g}
                    </span>
                  ))}
                </div>
                {ctx.synopsis ? (
                  <p className="text-sm leading-relaxed text-zinc-300">{ctx.synopsis}</p>
                ) : (
                  <p className="text-xs text-zinc-500">Sinopsis indisponibil pentru acest titlu.</p>
                )}
                {ctx.reviews.length > 0 ? (
                  <div>
                    <p className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.16em] text-zinc-500">
                      Recenzii în context ({ctx.reviews.length})
                    </p>
                    <div className="custom-scrollbar max-h-40 space-y-2 overflow-y-auto pr-1">
                      {ctx.reviews.map((rv, i) => (
                        <div key={`${rv.user}-${i}`} className="rounded-lg border border-white/10 bg-white/[0.02] p-2.5">
                          <p className="flex items-center gap-2 text-xs font-bold text-zinc-200">
                            {rv.user}
                            <span className="text-amber-300">{'★'.repeat(Math.max(0, Math.min(5, Math.round(rv.rating))))}</span>
                          </p>
                          <p className="mt-0.5 line-clamp-3 text-[11px] leading-relaxed text-zinc-400">{rv.body}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <p className="text-xs text-zinc-500">Nicio recenzie în context — Companion-ul va răspunde doar din sinopsis.</p>
                )}
              </div>
            </LabCard>
              );
            })()
          ) : null}

          {/* Chat */}
          <LabCard
            title={`Chat cu Companion — ${picked.title}`}
            action={
              ctxRes.data ? (
                <RagIndicator
                  used={lastMeta?.usedContext ?? null}
                  available={{
                    synopsis: Boolean(ctxRes.data.context.synopsis),
                    reviews: ctxRes.data.context.reviews.length > 0,
                  }}
                />
              ) : undefined
            }
          >
            {messages.length === 0 ? (
              <div className="space-y-3">
                <p className="text-sm text-zinc-400">
                  Întreabă orice despre <span className="font-bold text-zinc-100">{picked.title}</span> — răspunsurile
                  se bazează pe sinopsisul și recenziile reale din platformă.
                </p>
                <div className="flex flex-wrap gap-2">
                  {QUICK_PROMPTS.map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => void send(p)}
                      className="min-h-11 rounded-full border border-white/15 bg-white/[0.03] px-3.5 text-xs font-semibold text-zinc-300 transition hover:border-rose-500/40 hover:text-rose-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/60"
                    >
                      {p}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div ref={listRef} className="custom-scrollbar max-h-96 space-y-3 overflow-y-auto pr-1" aria-live="polite">
                {messages.map((m, i) => (
                  <div key={i} className={cn('flex', m.role === 'user' ? 'justify-end' : 'justify-start')}>
                    <div
                      className={cn(
                        'max-w-[85%] rounded-2xl border px-3.5 py-2.5',
                        m.role === 'user'
                          ? 'border-rose-500/30 bg-rose-500/10 text-zinc-100'
                          : 'border-white/10 bg-white/[0.03] text-zinc-200',
                      )}
                    >
                      {m.role === 'assistant' && lastMeta && i === messages.length - 1 ? (
                        <div className="mb-1">
                          <LabProviderBadge provider={lastMeta.provider} />
                        </div>
                      ) : null}
                      <p className="whitespace-pre-wrap text-sm leading-relaxed">{m.content}</p>
                    </div>
                  </div>
                ))}
                {sending ? (
                  <div className="flex justify-start">
                    <div className="flex items-center gap-2 rounded-2xl border border-white/10 bg-white/[0.03] px-3.5 py-2.5">
                      <Loader2 className="h-4 w-4 animate-spin text-zinc-400" aria-hidden />
                      <span className="text-sm text-zinc-400">Companionul se gândește…</span>
                    </div>
                  </div>
                ) : null}
              </div>
            )}
            {chatError ? <p className="mt-2 text-[11px] text-rose-300">{chatError}</p> : null}
            <form
              className="mt-3 flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void send();
              }}
            >
              <Input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Scrie o întrebare… (Enter pentru a trimite)"
                className="h-11 min-w-0"
                maxLength={500}
                aria-label="Mesaj pentru AI Companion"
              />
              <Button
                type="submit"
                disabled={!input.trim() || sending}
                className="h-11 shrink-0 bg-rose-600 font-bold hover:bg-rose-500"
                aria-label="Trimite mesajul"
              >
                {sending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Send className="h-4 w-4" aria-hidden />}
                <span className="ml-1.5 hidden sm:inline">Trimite</span>
              </Button>
            </form>
          </LabCard>
        </>
      ) : (
        <LabCard>
          <p className="py-6 text-center text-sm text-zinc-500">
            💬 Caută un titlu mai sus pentru a porni o conversație cu AI Companion — răspunsurile
            folosesc context real (sinopsis + recenzii), nu invenții.
          </p>
        </LabCard>
      )}
    </div>
  );
}
