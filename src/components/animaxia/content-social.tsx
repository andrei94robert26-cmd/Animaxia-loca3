'use client';

/**
 * content-social.tsx — "Community" section for a library title: like/dislike
 * bar (contentLikes/likeContent) + threaded comments (list/post/reply/vote/
 * delete). Auth-aware: myVote is fetched with the Bearer token when signed in
 * (via authRequest, since the GET endpoints are optionalAuth on the backend)
 * and falls back to the anonymous platform client.
 */

import { useEffect, useState } from 'react';
import { Loader2, LogIn, MessageSquare, Reply, Send, ThumbsDown, ThumbsUp, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { authRequest, platform, type Comment } from '@/lib/animaxia/platform';
import { BACKEND_PORT } from '@/lib/animaxia/api';
import { useApi } from '@/lib/animaxia/hooks';
import { navigate } from '@/lib/animaxia/router';
import { useAuth } from '@/components/animaxia/auth-provider';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { Section } from './section';
import { EmptyState, ErrorState } from './states';

/* ------------------------------- local helpers ------------------------------ */

interface VoteCounts {
  likes: number;
  dislikes: number;
  myVote: number | null;
}

/** Gateway URL for a platform path (same convention as platform.ts). */
function socialUrl(path: string): string {
  return `${path}?XTransformPort=${BACKEND_PORT}`;
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

function timeAgo(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const diff = Date.now() - t;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d`;
  return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Recomputes tallies after switching a vote to `next` (0 = remove). */
function applyVote(current: VoteCounts, next: 1 | -1 | 0): VoteCounts {
  let { likes, dislikes } = current;
  if (current.myVote === 1) likes -= 1;
  if (current.myVote === -1) dislikes -= 1;
  if (next === 1) likes += 1;
  if (next === -1) dislikes += 1;
  return { likes: Math.max(0, likes), dislikes: Math.max(0, dislikes), myVote: next === 0 ? null : next };
}

function countComments(threads: Comment[]): number {
  return threads.reduce((n, t) => n + 1 + (t.replies?.length ?? 0), 0);
}

/* --------------------------------- section --------------------------------- */

export function ContentSocial({ contentId }: { contentId: number }) {
  const { user, isAdmin } = useAuth();
  const [reload, setReload] = useState(0);

  /* ---- like bar ---- */

  const [likeOverride, setLikeOverride] = useState<VoteCounts | null>(null);
  const [likeBusy, setLikeBusy] = useState(false);

  const likes = useApi(`content-likes-${contentId}-${user?.id ?? 'anon'}-${reload}`, async (): Promise<VoteCounts> => {
    if (user) {
      try {
        // Authenticated GET so the backend can resolve myVote (optionalAuth route).
        return await authRequest<VoteCounts>(socialUrl(`/api/social/content/${contentId}/likes`));
      } catch {
        /* fall back to the anonymous client below */
      }
    }
    return platform.contentLikes(contentId);
  });

  useEffect(() => {
    setLikeOverride(null);
  }, [likes.data]);

  const likeCounts: VoteCounts | null =
    likeOverride ?? (likes.data ? { likes: likes.data.likes, dislikes: likes.data.dislikes, myVote: likes.data.myVote } : null);

  async function voteContent(value: 1 | -1) {
    if (!user) {
      toast('Conectează-te pentru a reacționa');
      navigate('/auth');
      return;
    }
    if (likeBusy || !likeCounts) return;
    const next: 1 | -1 | 0 = likeCounts.myVote === value ? 0 : value;
    setLikeOverride(applyVote(likeCounts, next));
    setLikeBusy(true);
    try {
      const res = await platform.likeContent(contentId, next);
      setLikeOverride({ likes: res.likes, dislikes: res.dislikes, myVote: res.myVote });
    } catch (e) {
      setLikeOverride(likeCounts); // revert
      toast.error(e instanceof Error ? e.message : 'Nu am putut salva votul');
    } finally {
      setLikeBusy(false);
    }
  }

  /* ---- comments ---- */

  const comments = useApi(
    `content-comments-${contentId}-${user?.id ?? 'anon'}-${reload}`,
    async (): Promise<{ data: Comment[] }> => {
      if (user) {
        try {
          return await authRequest<{ data: Comment[] }>(socialUrl(`/api/social/content/${contentId}/comments`));
        } catch {
          /* anonymous fallback below */
        }
      }
      return platform.comments(contentId);
    },
  );

  const [voteOverrides, setVoteOverrides] = useState<Record<number, VoteCounts>>({});

  useEffect(() => {
    setVoteOverrides({});
  }, [comments.data]);

  function withOverride(c: Comment): Comment {
    const o = voteOverrides[c.id];
    return o ? { ...c, likes: o.likes, dislikes: o.dislikes, myVote: o.myVote } : c;
  }

  async function voteOnComment(c: Comment, value: 1 | -1) {
    if (!user) {
      toast('Conectează-te pentru a vota comentariile');
      navigate('/auth');
      return;
    }
    const next: 1 | -1 | 0 = c.myVote === value ? 0 : value;
    setVoteOverrides((prev) => ({ ...prev, [c.id]: applyVote({ likes: c.likes, dislikes: c.dislikes, myVote: c.myVote }, next) }));
    try {
      const res = await platform.voteComment(c.id, next);
      setVoteOverrides((prev) => ({ ...prev, [c.id]: { likes: res.likes, dislikes: res.dislikes, myVote: res.myVote } }));
    } catch (e) {
      setVoteOverrides((prev) => {
        const nextPrev = { ...prev };
        delete nextPrev[c.id];
        return nextPrev;
      });
      toast.error(e instanceof Error ? e.message : 'Nu am putut salva votul');
    }
  }

  async function postComment(body: string, parentid?: number) {
    await platform.addComment(contentId, body, parentid);
    setReload((n) => n + 1);
  }

  async function removeComment(id: number) {
    try {
      await platform.deleteComment(id);
      toast.success('Comentariu a fost șters');
      setReload((n) => n + 1);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Nu am putut șterge comentariul');
    }
  }

  const threads = (comments.data?.data || []).map(withOverride);
  const total = countComments(threads);

  return (
    <Section
      title="Comunitate"
      subtitle={comments.data ? (total === 1 ? '1 comentariu' : `${total} comentarii`) : undefined}
      className="scroll-mt-24"
    >
      {/* Like bar */}
      {likes.error && !likes.loading ? (
        <ErrorState compact message={likes.error} onRetry={likes.refetch} />
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            variant="outline"
            aria-pressed={likeCounts?.myVote === 1}
            aria-label={`Îmi place acest titlu — ${likeCounts ? likeCounts.likes : 0} aprecieri`}
            onClick={() => voteContent(1)}
            disabled={!likeCounts || likeBusy}
            className={cn(
              'h-11 min-w-11 gap-2 border-white/15 bg-white/5 px-4 font-semibold hover:bg-white/10',
              likeCounts?.myVote === 1 && 'border-rose-500/40 bg-rose-500/15 text-rose-300 hover:bg-rose-500/25',
            )}
          >
            <ThumbsUp className="h-4 w-4" aria-hidden />
            <span>{likeCounts ? likeCounts.likes : '–'}</span>
          </Button>
          <Button
            type="button"
            variant="outline"
            aria-pressed={likeCounts?.myVote === -1}
            aria-label={`Nu îmi place acest titlu — ${likeCounts ? likeCounts.dislikes : 0} nemulțumiri`}
            onClick={() => voteContent(-1)}
            disabled={!likeCounts || likeBusy}
            className={cn(
              'h-11 min-w-11 gap-2 border-white/15 bg-white/5 px-4 font-semibold hover:bg-white/10',
              likeCounts?.myVote === -1 && 'border-zinc-400/40 bg-zinc-400/15 text-zinc-200 hover:bg-zinc-400/25',
            )}
          >
            <ThumbsDown className="h-4 w-4" aria-hidden />
            <span>{likeCounts ? likeCounts.dislikes : '–'}</span>
          </Button>
          {!user && (
            <span className="text-xs text-zinc-500">
              <button
                type="button"
                onClick={() => navigate('/auth')}
                className="font-semibold text-rose-400 underline-offset-2 transition hover:text-rose-300 hover:underline"
              >
                Conectează-te
              </button>{' '}
              pentru a reacționa și a intra în discuție
            </span>
          )}
          {likeBusy && <Loader2 className="h-4 w-4 animate-spin text-zinc-500" aria-hidden />}
        </div>
      )}

      {/* Add-comment form */}
      <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
        <CommentForm user={user ? { username: user.username, avatar: user.avatar } : null} onSubmit={postComment} />
      </div>

      {/* Thread list */}
      {comments.loading && !comments.data ? (
        <div className="space-y-4" aria-busy="true" aria-label="Se încarcă comentariile">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex gap-3">
              <Skeleton className="h-8 w-8 shrink-0 rounded-full" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-3.5 w-32" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-2/3" />
              </div>
            </div>
          ))}
        </div>
      ) : comments.error ? (
        <ErrorState compact message={comments.error} onRetry={comments.refetch} />
      ) : threads.length === 0 ? (
        <EmptyState
          icon={<MessageSquare className="h-6 w-6" aria-hidden />}
          title="Încă niciun comentariu"
          message={user ? 'Fii primul care își împărtășește părerea despre acest titlu.' : 'Conectează-te și fii primul care își împărtășește părerea.'}
        />
      ) : (
        <div className="max-w-3xl space-y-6">
          {threads.map((thread) => (
            <CommentItem
              key={thread.id}
              comment={thread}
              viewer={user ? { id: user.id, username: user.username, avatar: user.avatar } : null}
              isAdmin={isAdmin}
              onVote={voteOnComment}
              onReply={postComment}
              onDelete={removeComment}
            />
          ))}
        </div>
      )}
    </Section>
  );
}

/* ------------------------------ comment form ------------------------------ */

function CommentForm({
  user,
  onSubmit,
  placeholder = 'Împărtășește-ți părerea…',
  submitLabel = 'Publică',
  successMessage = 'Comentariu publicat',
  autoFocus,
}: {
  user: { username: string; avatar: string | null } | null;
  onSubmit: (body: string, parentid?: number) => Promise<void>;
  placeholder?: string;
  submitLabel?: string;
  successMessage?: string;
  autoFocus?: boolean;
}) {
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);

  if (!user) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="flex items-center gap-2 text-sm text-zinc-400">
          <LogIn className="h-4 w-4 text-rose-400" aria-hidden />
          Join the conversation — sign in to comment.
        </p>
        <Button
          type="button"
          size="sm"
          className="bg-rose-600 font-bold text-white hover:bg-rose-500"
          onClick={() => navigate('/auth')}
        >
          Sign in
        </Button>
      </div>
    );
  }

  async function submit() {
    const trimmed = body.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    try {
      await onSubmit(trimmed);
      setBody('');
      toast.success(successMessage);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Nu am putut publica comentariul');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex gap-3">
      <UserChip username={user.username} avatar={user.avatar} className="h-8 w-8 text-[11px]" />
      <div className="min-w-0 flex-1 space-y-2">
        <Textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={placeholder}
          aria-label="Comment"
          maxLength={2000}
          rows={3}
          autoFocus={autoFocus}
          className="min-h-16 rounded-xl border-white/10 bg-white/[0.04] text-sm text-zinc-100 placeholder:text-zinc-500 focus-visible:border-rose-500/50 focus-visible:ring-rose-500/30"
        />
        <div className="flex items-center justify-between gap-3">
          <span className="text-[11px] tabular-nums text-zinc-600" aria-live="polite">
            {body.length}/2000
          </span>
          <Button
            type="button"
            size="sm"
            onClick={submit}
            disabled={busy || !body.trim()}
            className="bg-rose-600 font-bold text-white hover:bg-rose-500"
          >
            {busy ? <Loader2 className="animate-spin" aria-hidden /> : <Send aria-hidden />}
            {busy ? 'Se publică…' : submitLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------ thread item ------------------------------ */

function UserChip({ username, avatar, className }: { username: string; avatar: string | null; className?: string }) {
  return (
    <Avatar className={cn('h-8 w-8', className)}>
      {avatar ? <AvatarImage src={avatar} alt={username} /> : null}
      <AvatarFallback className="bg-gradient-to-br from-rose-500/30 to-fuchsia-500/30 text-[11px] font-bold text-rose-200">
        {initials(username) || '?'}
      </AvatarFallback>
    </Avatar>
  );
}

function CommentItem({
  comment,
  viewer,
  isAdmin,
  onVote,
  onReply,
  onDelete,
  isReply = false,
}: {
  comment: Comment;
  viewer: { id: number; username: string; avatar: string | null } | null;
  isAdmin: boolean;
  onVote: (c: Comment, value: 1 | -1) => void;
  onReply: (body: string, parentid?: number) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
  isReply?: boolean;
}) {
  const [replying, setReplying] = useState(false);
  const canDelete = viewer != null && (comment.user?.id === viewer.id || isAdmin);

  return (
    <article className="flex gap-3" aria-label={`Comment by ${comment.user?.username ?? 'unknown'}`}>
      <UserChip username={comment.user?.username ?? '?'} avatar={comment.user?.avatar ?? null} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="text-sm font-semibold text-zinc-100">{comment.user?.username ?? 'unknown'}</span>
          <time className="text-[11px] text-zinc-500" dateTime={comment.createdat}>
            {timeAgo(comment.createdat)}
          </time>
        </div>
        <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-relaxed text-zinc-300">{comment.body}</p>
        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          <button
            type="button"
            onClick={() => onVote(comment, 1)}
            aria-label={`Like comment by ${comment.user?.username ?? 'unknown'}`}
            className={cn(
              'inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-zinc-400 transition hover:bg-white/5 hover:text-zinc-200',
              comment.myVote === 1 && 'text-rose-400 hover:text-rose-300',
            )}
          >
            <ThumbsUp className="h-3.5 w-3.5" aria-hidden />
            <span className="tabular-nums">{comment.likes}</span>
          </button>
          <button
            type="button"
            onClick={() => onVote(comment, -1)}
            aria-label={`Dislike comment by ${comment.user?.username ?? 'unknown'}`}
            className={cn(
              'inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-zinc-400 transition hover:bg-white/5 hover:text-zinc-200',
              comment.myVote === -1 && 'text-zinc-200',
            )}
          >
            <ThumbsDown className="h-3.5 w-3.5" aria-hidden />
            <span className="tabular-nums">{comment.dislikes}</span>
          </button>
          <button
            type="button"
            onClick={() => setReplying((v) => !v)}
            aria-expanded={replying}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-xs font-semibold text-zinc-400 transition hover:bg-white/5 hover:text-zinc-100"
          >
            <Reply className="h-3.5 w-3.5" aria-hidden />
            Răspunde
          </button>
          {canDelete && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <button
                  type="button"
                  aria-label="Delete comment"
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-zinc-500 transition hover:bg-rose-500/10 hover:text-rose-300"
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden />
                  Delete
                </button>
              </AlertDialogTrigger>
              <AlertDialogContent className="border-white/10 bg-[#12121c] text-zinc-100">
                <AlertDialogHeader>
                  <AlertDialogTitle>Ștergi acest comentariu?</AlertDialogTitle>
                  <AlertDialogDescription className="text-zinc-400">
                    {comment.replies?.length
                      ? `Acest comentariu și cele ${comment.replies.length} ${comment.replies.length === 1 ? 'răspuns' : 'răspunsuri'} ale sale vor fi eliminate definitiv.`
                      : 'Acest comentariu va fi eliminat definitiv.'}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel className="border-white/15 bg-white/5 hover:bg-white/10">Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    className="bg-rose-600 font-bold text-white hover:bg-rose-500"
                    onClick={() => void onDelete(comment.id)}
                  >
                    Delete
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>

        {replying && (
          <div className="mt-3 rounded-xl border border-white/10 bg-white/[0.02] p-3">
            <CommentForm
              user={viewer ? { username: viewer.username, avatar: viewer.avatar } : null}
              onSubmit={async (body) => {
                await onReply(body, comment.id);
                setReplying(false);
              }}
              placeholder={`Răspunde-i lui ${comment.user?.username ?? 'acest comentariu'}…`}
              submitLabel="Răspunde"
              successMessage="Răspuns publicat"
              autoFocus
            />
          </div>
        )}

        {!isReply && comment.replies?.length > 0 && (
          <div className="mt-4 space-y-4 border-l-2 border-white/10 pl-4">
            {comment.replies.map((reply) => (
              <CommentItem
                key={reply.id}
                comment={reply}
                viewer={viewer}
                isAdmin={isAdmin}
                onVote={onVote}
                onReply={onReply}
                onDelete={onDelete}
                isReply
              />
            ))}
          </div>
        )}
      </div>
    </article>
  );
}
