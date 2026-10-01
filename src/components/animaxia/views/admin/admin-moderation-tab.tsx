'use client';

/**
 * admin-moderation-tab.tsx — TS2b: moderation queue. Latest 30 comments +
 * 30 reviews + 30 watch parties from GET /api/admin/moderation (admin-gated),
 * with author, content title, text and date on every card. Deletions reuse
 * the EXISTING owner/admin routes (platform.deleteComment → DELETE
 * /api/social/comments/:id, social.deleteReview → DELETE /api/social/reviews/:id);
 * watch parties are display-only (no delete route exists — honest).
 * Deep-linked via #/admin/moderation.
 */

import { useState } from 'react';
import {
  Lock,
  Loader2,
  MessageSquare,
  RefreshCw,
  ShieldAlert,
  Star,
  Trash2,
  Users as UsersIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/animaxia/api';
import { platform } from '@/lib/animaxia/platform';
import { social } from '@/lib/animaxia/social';
import { useApi } from '@/lib/animaxia/hooks';
import { navigate } from '@/lib/animaxia/router';
import { useAuth } from '../../auth-provider';
import type { ModerationComment, ModerationParty, ModerationReview } from '@/lib/animaxia/types';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { EmptyState, ErrorState, RatingBadge, TypeBadge } from '../../states';
import { cn } from '@/lib/utils';

/* ------------------------------- helpers ------------------------------- */

function isForbidden(message: string | null): boolean {
  return Boolean(message && /admin access required|forbidden|status 40[13]/i.test(message));
}

function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '—';
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return '—';
  const diff = Math.max(0, Date.now() - time);
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'chiar acum';
  if (mins < 60) return `acum ${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `acum ${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `acum ${days}z`;
  return new Date(iso).toLocaleDateString('ro-RO', { month: 'short', day: 'numeric' });
}

/* ------------------------------ lock card ------------------------------ */

function LockCard() {
  return (
    <Card className="border-rose-500/20 bg-white/[0.03]">
      <CardContent className="flex flex-col items-center gap-4 p-10 text-center">
        <div className="grid h-14 w-14 place-items-center rounded-2xl bg-rose-500/10">
          <Lock className="h-6 w-6 text-rose-400" aria-hidden />
        </div>
        <div>
          <p className="font-semibold text-zinc-100">Sunt necesare drepturi de administrator</p>
          <p className="mt-1 max-w-md text-sm text-zinc-400">
            Conectează-te ca administrator pentru a vedea coada de moderare.
          </p>
          <p className="mt-1 text-xs text-zinc-600">Admin demo: admin@animaxia.test</p>
        </div>
        <Button className="bg-rose-600 font-bold hover:bg-rose-500" onClick={() => navigate('/auth')}>
          Conectare
        </Button>
      </CardContent>
    </Card>
  );
}

/* -------------------------------- cards -------------------------------- */

function ModerationCardShell({
  author,
  contentTitle,
  contentId,
  contentType,
  date,
  children,
  actions,
}: {
  author: string;
  contentTitle: string | null;
  contentId: number | null;
  contentType: string | null;
  date: string | null;
  children: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <Card className="border-white/10 bg-white/[0.03]">
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-zinc-500">
          <span className="inline-flex items-center gap-1.5 font-semibold text-zinc-300">
            <span className="grid h-6 w-6 place-items-center rounded-full bg-gradient-to-br from-rose-500/30 to-fuchsia-500/20 text-[10px] font-bold text-rose-200">
              {author.slice(0, 1).toUpperCase()}
            </span>
            {author}
          </span>
          <span aria-hidden>·</span>
          {contentId != null && contentTitle ? (
            <button
              type="button"
              onClick={() => navigate(`/content/${contentId}`)}
              className="inline-flex items-center gap-1.5 font-medium text-zinc-400 transition hover:text-rose-300"
            >
              {contentTitle}
              {contentType && <TypeBadge type={contentType} />}
            </button>
          ) : (
            <span className="italic text-zinc-600">conținut șters</span>
          )}
          <span className="ml-auto">{timeAgo(date)}</span>
        </div>
        {children}
        {actions ? <div className="flex justify-end gap-2 pt-0.5">{actions}</div> : null}
      </CardContent>
    </Card>
  );
}

/* --------------------------------- tab --------------------------------- */

export function AdminModerationTab() {
  const { isAdmin, initializing } = useAuth();
  const queue = useApi('admin:moderation', () => api.adminModeration(), { enabled: !initializing && isAdmin });

  const [deleting, setDeleting] = useState<{ kind: 'comment' | 'review'; id: number; author: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const locked = !initializing && (!isAdmin || (queue.error != null && isForbidden(queue.error)));

  async function runDelete() {
    if (!deleting || busy) return;
    setBusy(true);
    try {
      if (deleting.kind === 'comment') {
        await platform.deleteComment(deleting.id);
        toast.success('Comentariul a fost șters');
      } else {
        await social.deleteReview(deleting.id);
        toast.success('Recenzia a fost ștearsă');
      }
      setDeleting(null);
      await queue.refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Ștergerea a eșuat');
    } finally {
      setBusy(false);
    }
  }

  if (locked) return <LockCard />;

  if (queue.loading && !queue.data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-72 rounded-xl" />
        <div className="grid gap-3 lg:grid-cols-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-36 rounded-xl" />
          ))}
        </div>
      </div>
    );
  }

  if (queue.error && !queue.data) {
    return <ErrorState message={queue.error} onRetry={() => void queue.refetch()} compact />;
  }

  const data = queue.data;
  const comments: ModerationComment[] = data?.comments ?? [];
  const reviews: ModerationReview[] = data?.reviews ?? [];
  const parties: ModerationParty[] = data?.parties ?? [];

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-zinc-500">
          Ultimele 30 din fiecare categorie — comentarii și recenzii se pot șterge direct (rute owner/admin existente);
          watch parties sunt doar afișate.
        </p>
        <Button
          variant="outline"
          size="sm"
          className="border-white/15 bg-white/5 font-semibold hover:bg-white/10"
          onClick={() => void queue.refetch()}
        >
          <RefreshCw aria-hidden /> Reîmprospătează
        </Button>
      </div>

      <Tabs defaultValue="comments" className="gap-4">
        <TabsList className="h-10 w-full justify-start gap-1 rounded-xl border border-white/10 bg-white/[0.03] p-1 sm:w-auto">
          <TabsTrigger
            value="comments"
            className="gap-1.5 px-4 text-zinc-400 hover:text-zinc-100 data-[state=active]:bg-rose-600 data-[state=active]:text-white sm:px-5"
          >
            <MessageSquare className="h-3.5 w-3.5" aria-hidden /> Comentarii ({comments.length})
          </TabsTrigger>
          <TabsTrigger
            value="reviews"
            className="gap-1.5 px-4 text-zinc-400 hover:text-zinc-100 data-[state=active]:bg-rose-600 data-[state=active]:text-white sm:px-5"
          >
            <Star className="h-3.5 w-3.5" aria-hidden /> Recenzii ({reviews.length})
          </TabsTrigger>
          <TabsTrigger
            value="parties"
            className="gap-1.5 px-4 text-zinc-400 hover:text-zinc-100 data-[state=active]:bg-rose-600 data-[state=active]:text-white sm:px-5"
          >
            <UsersIcon className="h-3.5 w-3.5" aria-hidden /> Watch parties ({parties.length})
          </TabsTrigger>
        </TabsList>

        {/* Comments */}
        <TabsContent value="comments" className="space-y-3">
          {comments.length === 0 ? (
            <EmptyState
              icon={<ShieldAlert className="h-6 w-6" aria-hidden />}
              title="Niciun comentariu de moderat"
              message="Ultimele comentarii de pe platformă vor apărea aici."
            />
          ) : (
            <div className="grid gap-3 lg:grid-cols-2">
              {comments.map((c) => (
                <ModerationCardShell
                  key={c.id}
                  author={c.author}
                  contentTitle={c.contenttitle}
                  contentId={c.contentid}
                  contentType={c.contenttype}
                  date={c.createdat}
                  actions={
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => setDeleting({ kind: 'comment', id: c.id, author: c.author })}
                      className="h-8 border-red-500/30 bg-red-500/10 text-xs font-semibold text-red-300 hover:bg-red-500/20"
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden /> Șterge
                    </Button>
                  }
                >
                  <p className="line-clamp-4 whitespace-pre-wrap break-words text-sm leading-relaxed text-zinc-300">
                    {c.body}
                  </p>
                </ModerationCardShell>
              ))}
            </div>
          )}
        </TabsContent>

        {/* Reviews */}
        <TabsContent value="reviews" className="space-y-3">
          {reviews.length === 0 ? (
            <EmptyState
              icon={<ShieldAlert className="h-6 w-6" aria-hidden />}
              title="Nicio recenzie de moderat"
              message="Ultimele recenzii de pe platformă vor apărea aici."
            />
          ) : (
            <div className="grid gap-3 lg:grid-cols-2">
              {reviews.map((r) => (
                <ModerationCardShell
                  key={r.id}
                  author={r.author}
                  contentTitle={r.contenttitle}
                  contentId={r.contentid}
                  contentType={r.contenttype}
                  date={r.createdat}
                  actions={
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => setDeleting({ kind: 'review', id: r.id, author: r.author })}
                      className="h-8 border-red-500/30 bg-red-500/10 text-xs font-semibold text-red-300 hover:bg-red-500/20"
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden /> Șterge
                    </Button>
                  }
                >
                  <div className="flex flex-wrap items-center gap-2">
                    {r.title && <span className="text-sm font-bold text-zinc-100">{r.title}</span>}
                    <RatingBadge value={r.rating} />
                  </div>
                  <p className="line-clamp-4 whitespace-pre-wrap break-words text-sm leading-relaxed text-zinc-300">
                    {r.body}
                  </p>
                </ModerationCardShell>
              ))}
            </div>
          )}
        </TabsContent>

        {/* Watch parties (display-only — no delete route exists) */}
        <TabsContent value="parties" className="space-y-3">
          {parties.length === 0 ? (
            <EmptyState
              icon={<ShieldAlert className="h-6 w-6" aria-hidden />}
              title="Nicio watch party"
              message="Ultimele watch parties create pe platformă vor apărea aici."
            />
          ) : (
            <div className="grid gap-3 lg:grid-cols-2">
              {parties.map((p) => (
                <ModerationCardShell
                  key={p.id}
                  author={p.author}
                  contentTitle={p.contenttitle}
                  contentId={p.contentid}
                  contentType={p.contenttype}
                  date={p.updatedat ?? p.createdat}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-bold text-zinc-100">{p.title}</span>
                    <span
                      className={cn(
                        'rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider',
                        p.status === 'active'
                          ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                          : 'border-zinc-500/30 bg-zinc-500/10 text-zinc-400',
                      )}
                    >
                      {p.status}
                    </span>
                    <span className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 font-mono text-[10px] font-semibold text-zinc-400">
                      cod {p.code}
                    </span>
                  </div>
                  <p className="text-xs text-zinc-500">
                    Watch parties nu au rută de ștergere — se afișează doar pentru contextul de moderare.
                  </p>
                </ModerationCardShell>
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>

      {/* Delete confirm */}
      <AlertDialog open={deleting !== null} onOpenChange={(open) => (open ? null : setDeleting(null))}>
        <AlertDialogContent className="border-white/10 bg-[#12121c] text-zinc-100">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <Trash2 className="h-5 w-5 text-red-400" aria-hidden />
              {deleting?.kind === 'comment' ? 'Ștergi comentariul lui' : 'Ștergi recenzia lui'} „{deleting?.author}”?
            </AlertDialogTitle>
            <AlertDialogDescription className="text-zinc-400">
              Acțiunea este permanentă și folosește ruta owner/admin existentă. Utilizatorul va vedea conținutul
              dispărut la următoarea încărcare.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="border-white/15 bg-white/5 hover:bg-white/10" disabled={busy}>
              Anulează
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void runDelete();
              }}
              disabled={busy}
              className="bg-red-600 font-bold hover:bg-red-500"
            >
              {busy && <Loader2 className="animate-spin" aria-hidden />}
              Șterge definitiv
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
