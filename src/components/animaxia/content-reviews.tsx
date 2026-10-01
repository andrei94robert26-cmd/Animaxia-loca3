'use client';

/**
 * content-reviews.tsx — "Reviews" section for a library title (FAZA 10):
 * aggregate rating header with a 1-10 distribution, AI community digest,
 * the review list (like toggles, own review edit/delete) and the signed-in
 * write/edit form (rating 1-10, optional title, 10-4000 char body, upsert).
 */

import { useEffect, useMemo, useState } from 'react';
import { Loader2, LogIn, Pencil, Send, Sparkles, Star, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { PlatformError } from '@/lib/animaxia/platform';
import { social, type ReviewDigest, type SocialReview } from '@/lib/animaxia/social';
import { useApi } from '@/lib/animaxia/hooks';
import { navigate } from '@/lib/animaxia/router';
import { useAuth } from '@/components/animaxia/auth-provider';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { Section } from './section';
import { EmptyState, ErrorState } from './states';
import { RatingPill, UserAvatar, timeAgo } from './social/social-ui';

const BODY_MIN = 10;
const BODY_MAX = 4000;

function isQuotaError(err: unknown): boolean {
  return err instanceof PlatformError && (err.upgrade || err.status === 402);
}

function quotaMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Limita AI zilnică a fost atinsă — fă upgrade pentru mai mult';
}

function upgradeToast(err: unknown): void {
  toast.error(quotaMessage(err), {
    action: { label: 'Upgrade', onClick: () => navigate('/premium') },
  });
}

/* --------------------------------- section --------------------------------- */

export function ContentReviews({ contentId }: { contentId: number }) {
  const { user } = useAuth();
  const [reload, setReload] = useState(0);

  const reviews = useApi(
    `content-reviews-${contentId}-${user?.id ?? 'anon'}-${reload}`,
    () => social.contentReviews(contentId),
  );

  const list = reviews.data?.data ?? [];
  const aggregate = reviews.data?.aggregate;
  const ownReview = user ? list.find((r) => r.user.id === user.id) ?? null : null;

  /* ---- like overrides (optimistic, reset when the list refetches) ---- */
  const [likeOverrides, setLikeOverrides] = useState<Record<number, { likes: number; liked: boolean }>>({});
  const [likeBusy, setLikeBusy] = useState<Record<number, boolean>>({});

  useEffect(() => {
    setLikeOverrides({});
  }, [reviews.data]);

  async function toggleLike(review: SocialReview) {
    if (!user) {
      toast('Conectează-te pentru a aprecia recenziile');
      navigate('/auth');
      return;
    }
    if (likeBusy[review.id]) return;
    const current = likeOverrides[review.id] ?? { likes: review.likes, liked: review.liked };
    const next = { likes: current.liked ? current.likes - 1 : current.likes + 1, liked: !current.liked };
    setLikeOverrides((prev) => ({ ...prev, [review.id]: next }));
    setLikeBusy((prev) => ({ ...prev, [review.id]: true }));
    try {
      const res = await social.likeReview(review.id);
      setLikeOverrides((prev) => ({ ...prev, [review.id]: { likes: res.likes, liked: res.liked } }));
    } catch (err) {
      setLikeOverrides((prev) => ({ ...prev, [review.id]: current }));
      toast.error(err instanceof Error ? err.message : 'Nu am putut aprecia recenzia');
    } finally {
      setLikeBusy((prev) => ({ ...prev, [review.id]: false }));
    }
  }

  /* ---- AI community digest ---- */
  const [digest, setDigest] = useState<ReviewDigest | null>(null);
  const [digestLoading, setDigestLoading] = useState(false);

  async function runDigest() {
    if (!user) {
      toast('Conectează-te pentru a folosi digestul AI');
      navigate('/auth');
      return;
    }
    if (digestLoading) return;
    setDigestLoading(true);
    try {
      setDigest(await social.reviewDigest(contentId));
    } catch (err) {
      if (isQuotaError(err)) upgradeToast(err);
      else toast.error(err instanceof Error ? err.message : 'Nu am putea construi digestul');
    } finally {
      setDigestLoading(false);
    }
  }

  /* ---- write / edit form ---- */
  const [rating, setRating] = useState('8');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [prefillKey, setPrefillKey] = useState<string>('none');

  /* Prefill the form from the own review exactly once per review id. */
  useEffect(() => {
    if (!reviews.data) return;
    const key = ownReview ? `r${ownReview.id}` : 'none';
    if (prefillKey === key) return;
    setPrefillKey(key);
    if (ownReview) {
      setRating(String(ownReview.rating));
      setTitle(ownReview.title ?? '');
      setBody(ownReview.body);
    }
  }, [reviews.data, ownReview, prefillKey]);

  async function submitReview(e: React.FormEvent) {
    e.preventDefault();
    if (!user || submitting) return;
    const trimmed = body.trim();
    if (trimmed.length < BODY_MIN) return;
    setSubmitting(true);
    try {
      const res = await social.upsertReview({
        contentId,
        rating: Number(rating),
        title: title.trim() || undefined,
        body: trimmed,
      });
      toast.success(res.created ? 'Recenzie publicată' : 'Recenzie actualizată');
      setPrefillKey(`r${res.review.id}`);
      setReload((n) => n + 1);
    } catch (err) {
      if (isQuotaError(err)) upgradeToast(err);
      else toast.error(err instanceof Error ? err.message : 'Nu am putut salva recenzia');
    } finally {
      setSubmitting(false);
    }
  }

  async function deleteOwn() {
    if (!ownReview || deleting) return;
    setDeleting(true);
    try {
      await social.deleteReview(ownReview.id);
      toast('Recenzie ștearsă');
      setPrefillKey('none');
      setRating('8');
      setTitle('');
      setBody('');
      setReload((n) => n + 1);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Nu am putut șterge recenzia');
    } finally {
      setDeleting(false);
    }
  }

  const bodyTooShort = body.trim().length < BODY_MIN;

  /* ---- distribution bars ---- */
  const distribution = useMemo(() => {
    const dist = aggregate?.distribution ?? {};
    return Array.from({ length: 10 }, (_, i) => {
      const score = i + 1;
      return { score, count: Number(dist[String(score)] ?? 0) };
    });
  }, [aggregate]);
  const maxDist = Math.max(1, ...distribution.map((d) => d.count));

  return (
    <Section
      title="Recenzii"
      subtitle={aggregate ? (aggregate.count === 1 ? '1 recenzie' : `${aggregate.count} recenzii`) : undefined}
      className="scroll-mt-24"
    >
      {reviews.loading && !reviews.data ? (
        <div className="space-y-4" aria-busy="true" aria-label="Loading reviews">
          <Skeleton className="h-20 w-full rounded-xl" />
          <Skeleton className="h-36 w-full rounded-xl" />
          <Skeleton className="h-36 w-full rounded-xl" />
        </div>
      ) : reviews.error && !reviews.data ? (
        <ErrorState compact message={reviews.error} onRetry={reviews.refetch} />
      ) : (
        <div className="space-y-4">
          {/* Aggregate header */}
          {aggregate && aggregate.count > 0 && (
            <div className="flex flex-wrap items-center gap-5 rounded-xl border border-white/10 bg-white/[0.03] p-4">
              <div className="shrink-0 text-center">
                <p className="text-3xl font-black leading-none text-white">
                  {aggregate.avg.toFixed(1)}
                  <span className="text-base font-bold text-zinc-500"> / 10</span>
                </p>
                <p className="mt-1 text-xs text-zinc-500">
                  {aggregate.count} {aggregate.count === 1 ? 'review' : 'reviews'}
                </p>
              </div>
              <div
                className="flex min-w-[220px] flex-1 items-end gap-1"
                role="img"
                aria-label="Distribuția notelor de la 1 la 10"
              >
                {distribution.map((d) => (
                  <div key={d.score} className="flex flex-1 flex-col items-center gap-1" title={`${d.score}/10 — ${d.count}`}>
                    <span className="text-[9px] font-semibold text-zinc-500">{d.count > 0 ? d.count : ''}</span>
                    <div className="h-10 w-full overflow-hidden rounded bg-white/5">
                      <div
                        className="mt-auto h-full w-full origin-bottom rounded bg-gradient-to-t from-rose-600 to-rose-400/80"
                        style={{ transform: `scaleY(${d.count / maxDist})`, transformOrigin: 'bottom' }}
                      />
                    </div>
                    <span className="text-[9px] font-semibold text-zinc-500">{d.score}</span>
                  </div>
                ))}
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void runDigest()}
                disabled={digestLoading}
                className="shrink-0 border-rose-500/30 bg-rose-500/10 font-semibold text-rose-300 hover:bg-rose-500/20 hover:text-rose-200"
              >
                {digestLoading ? <Loader2 className="animate-spin" aria-hidden /> : <Sparkles aria-hidden />}
                Digest AI al comunității
              </Button>
            </div>
          )}

          {/* Digest result */}
          {digest && (
            <div className="rounded-xl border border-fuchsia-500/20 bg-gradient-to-br from-fuchsia-500/[0.07] to-white/[0.02] p-4">
              <p className="flex flex-wrap items-center gap-2 text-sm font-bold text-zinc-100">
                <Sparkles className="h-4 w-4 text-fuchsia-300" aria-hidden />
                Digest AI al comunității
                <span
                  className={cn(
                    'rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider',
                    digest.sentiment === 'positive' && 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
                    digest.sentiment === 'mixed' && 'border-amber-500/30 bg-amber-500/10 text-amber-300',
                    digest.sentiment === 'critical' && 'border-rose-500/30 bg-rose-500/10 text-rose-300',
                    digest.sentiment === 'neutral' && 'border-white/15 bg-white/5 text-zinc-300',
                  )}
                >
                  {digest.sentiment}
                </span>
                <span className="text-[10px] font-medium text-zinc-500">
                  pe baza a {digest.reviewCount} {digest.reviewCount === 1 ? 'recenzie' : 'recenzii'}
                </span>
              </p>
              <p className="mt-2 text-sm leading-relaxed text-zinc-300">{digest.summary}</p>
              {digest.themes.length > 0 && (
                <div className="mt-2.5 flex flex-wrap gap-1.5">
                  {digest.themes.slice(0, 10).map((t) => (
                    <span
                      key={t}
                      className="rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-0.5 text-[11px] font-medium text-zinc-300"
                    >
                      {t}
                    </span>
                  ))}
                </div>
              )}
              <p className="mt-2 font-mono text-[10px] text-zinc-600">
                {digest.provider}
                {digest.degraded ? ' · mod degradat (mock)' : ''}
              </p>
            </div>
          )}

          {/* Write / edit form (signed in) */}
          {user ? (
            <form onSubmit={submitReview} className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
              <p className="flex flex-wrap items-center justify-between gap-2 text-sm font-bold text-zinc-100">
                {ownReview ? 'Editează-ți recenzia' : 'Scrie o recenzie'}
                {ownReview && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => void deleteOwn()}
                    disabled={deleting}
                    className="gap-1.5 text-rose-400 hover:bg-rose-500/10 hover:text-rose-300"
                  >
                    {deleting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Trash2 className="h-4 w-4" aria-hidden />}
                    Delete
                  </Button>
                )}
              </p>
              <div className="mt-3 grid gap-3 sm:grid-cols-[130px_1fr]">
                <div className="space-y-1.5">
                  <label htmlFor="review-rating" className="text-xs font-semibold text-zinc-400">
                    Notă
                  </label>
                  <Select value={rating} onValueChange={setRating}>
                    <SelectTrigger id="review-rating" aria-label="Notă" className="h-10 w-full border-white/10 bg-black/40">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="border-white/10 bg-[#12121c] text-zinc-100">
                      {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
                        <SelectItem key={n} value={String(n)} className="focus:bg-rose-600/30 focus:text-white">
                          {n} / 10
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <label htmlFor="review-title" className="text-xs font-semibold text-zinc-400">
                    Titlu <span className="font-normal text-zinc-600">(opțional)</span>
                  </label>
                  <Input
                    id="review-title"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    maxLength={120}
                    placeholder="Rezumatul într-o linie…"
                    className="h-10 border-white/10 bg-black/40 text-sm text-zinc-100 placeholder:text-zinc-600"
                  />
                </div>
              </div>
              <div className="mt-3 space-y-1.5">
                <label htmlFor="review-body" className="text-xs font-semibold text-zinc-400">
                  Review
                </label>
                <Textarea
                  id="review-body"
                  value={body}
                  onChange={(e) => setBody(e.target.value.slice(0, BODY_MAX))}
                  rows={4}
                  placeholder="Ce a funcționat, ce nu — fără spoilere e mai frumos (10–4000 de caractere)."
                  className="custom-scrollbar border-white/10 bg-black/40 text-sm text-zinc-100 placeholder:text-zinc-600"
                />
                <p className={cn('text-right text-[11px]', bodyTooShort ? 'text-zinc-500' : 'text-zinc-600')}>
                  {body.trim().length} / {BODY_MAX}
                  {bodyTooShort && body.trim().length > 0 ? ` — at least ${BODY_MIN} characters` : ''}
                </p>
              </div>
              <div className="mt-2 flex items-center justify-between gap-3">
                <p className="text-[11px] text-zinc-500">
                  {bodyTooShort
                    ? `Write at least ${BODY_MIN} characters to publish.`
                    : ownReview
                      ? 'Actualizarea îți înlocuiește recenzia anterioară.'
                      : 'O singură recenzie pe titlu — o poți edita oricând.'}
                </p>
                <Button
                  type="submit"
                  disabled={submitting || bodyTooShort}
                  className="shrink-0 bg-rose-600 font-bold text-white hover:bg-rose-500"
                >
                  {submitting ? <Loader2 className="animate-spin" aria-hidden /> : <Send aria-hidden />}
                  {ownReview ? 'Actualizează recenzia' : 'Publică recenzia'}
                </Button>
              </div>
            </form>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/[0.02] p-4">
              <p className="text-sm text-zinc-400">
                <span className="font-semibold text-zinc-200">Sign in to review</span> — rate 1–10 and tell everyone
                what you thought.
              </p>
              <Button
                type="button"
                size="sm"
                className="bg-rose-600 font-bold text-white hover:bg-rose-500"
                onClick={() => navigate('/auth')}
              >
                <LogIn aria-hidden /> Sign in
              </Button>
            </div>
          )}

          {/* Review list */}
          {list.length === 0 ? (
            <EmptyState
              icon={<Star className="h-6 w-6" aria-hidden />}
              title="Încă nicio recenzie"
              message={user ? 'Fii primul care recenzează acest titlu.' : 'Conectează-te și fii primul care recenzează acest titlu.'}
            />
          ) : (
            <ul className="space-y-3" aria-label="Reviews">
              {list.map((r) => {
                const likeState = likeOverrides[r.id] ?? { likes: r.likes, liked: r.liked };
                const own = Boolean(user && r.user.id === user.id);
                return (
                  <li key={r.id}>
                    <article className="rounded-xl border border-white/10 bg-white/[0.03] p-4 transition-colors hover:border-white/20">
                      <div className="flex items-center gap-2.5">
                        <UserAvatar username={r.user.username} avatar={r.user.avatar} className="h-8 w-8" />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-bold text-zinc-100">{r.user.username}</p>
                          <p className="text-[11px] text-zinc-500">
                            {timeAgo(r.createdat)}
                            {r.updatedat !== r.createdat ? ' · edited' : ''}
                          </p>
                        </div>
                        <RatingPill rating={r.rating} />
                      </div>
                      {r.title ? <p className="mt-2.5 text-sm font-semibold text-zinc-100">{r.title}</p> : null}
                      <p className="mt-1 break-words text-sm leading-relaxed text-zinc-400">{r.body}</p>
                      <div className="mt-2.5 flex items-center gap-2">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => void toggleLike(r)}
                          disabled={!!likeBusy[r.id]}
                          aria-pressed={likeState.liked}
                          className={cn(
                            'gap-1.5 text-zinc-400 hover:bg-white/5 hover:text-white',
                            likeState.liked && 'text-rose-300 hover:text-rose-200',
                          )}
                        >
                          {likeBusy[r.id] ? (
                            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                          ) : (
                            <Star className={cn('h-4 w-4', likeState.liked && 'fill-rose-400')} aria-hidden />
                          )}
                          {likeState.likes} {likeState.likes === 1 ? 'apreciere' : 'aprecieri'}
                        </Button>
                        {own && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="gap-1.5 text-zinc-400 hover:bg-white/5 hover:text-white"
                            onClick={() => {
                              setRating(String(r.rating));
                              setTitle(r.title ?? '');
                              setBody(r.body);
                              setPrefillKey(`r${r.id}`);
                              document.getElementById('review-body')?.focus();
                            }}
                          >
                            <Pencil className="h-4 w-4" aria-hidden /> Editează
                          </Button>
                        )}
                      </div>
                    </article>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </Section>
  );
}
