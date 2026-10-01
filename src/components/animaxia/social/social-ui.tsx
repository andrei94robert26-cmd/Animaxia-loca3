'use client';

/**
 * social-ui.tsx — small shared building blocks for the FAZA 10 social
 * surfaces (hub, party room, content reviews): relative time, initials
 * fallback avatars, plan chips, navigable content mini-cards and the
 * sign-in prompt card.
 */

import { useState } from 'react';
import { LogIn } from 'lucide-react';
import { navigate } from '@/lib/animaxia/router';
import type { SocialContentRef } from '@/lib/animaxia/social';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { BrandPlaceholder, TypeBadge } from '../states';

/* ------------------------------- formatting ------------------------------- */

export function timeAgo(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const diff = Date.now() - t;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d`;
  return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

/* -------------------------------- avatars --------------------------------- */

export function UserAvatar({
  username,
  avatar,
  className,
}: {
  username: string;
  avatar?: string | null;
  className?: string;
}) {
  const usable = avatar && (avatar.startsWith('data:') || avatar.startsWith('http') || avatar.startsWith('/'));
  return (
    <Avatar className={cn('h-9 w-9 border border-white/15', className)}>
      {usable ? <AvatarImage src={avatar as string} alt={username} /> : null}
      <AvatarFallback className="bg-gradient-to-br from-rose-500 to-fuchsia-600 text-[11px] font-black text-white">
        {initials(username)}
      </AvatarFallback>
    </Avatar>
  );
}

/* --------------------------------- badges ---------------------------------- */

export function PlanBadge({ plan }: { plan: string }) {
  const plus = plan === 'plus' || plan === 'pro';
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider',
        plus ? 'border-amber-500/30 bg-amber-500/10 text-amber-300' : 'border-white/10 bg-white/[0.04] text-zinc-400',
      )}
    >
      {plan}
    </span>
  );
}

export function RatingPill({ rating }: { rating: number }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-rose-500/30 bg-rose-500/10 px-2 py-0.5 text-[11px] font-bold text-rose-300">
      <svg viewBox="0 0 24 24" className="h-3 w-3 fill-rose-400" aria-hidden>
        <path d="M12 2l2.9 6.26 6.85.62-5.17 4.55 1.53 6.7L12 16.5l-6.11 3.63 1.53-6.7L2.25 8.88l6.85-.62L12 2z" />
      </svg>
      {rating}/10
    </span>
  );
}

/* ----------------------------- content mini-card ---------------------------- */

export function ContentMiniCard({
  content,
  compact,
}: {
  content: SocialContentRef;
  compact?: boolean;
}) {
  const [imgError, setImgError] = useState(false);
  const showImage = Boolean(content.thumbnail) && !imgError;

  return (
    <button
      type="button"
      onClick={() => navigate(`/content/${content.id}`)}
      aria-label={`Deschide ${content.title}`}
      className="flex w-full items-stretch gap-3 rounded-lg border border-white/10 bg-black/20 p-2 text-left transition-colors hover:border-rose-500/40 hover:bg-white/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/60"
    >
      <span
        className={cn(
          'shrink-0 overflow-hidden rounded-md border border-white/10 bg-white/[0.03]',
          compact ? 'h-14 w-10' : 'h-14 w-10 sm:h-16 sm:w-11',
        )}
      >
        {showImage ? (
          <img
            src={content.thumbnail as string}
            alt=""
            loading="lazy"
            onError={() => setImgError(true)}
            className="h-full w-full object-cover"
          />
        ) : (
          <BrandPlaceholder title={content.title} />
        )}
      </span>
      <span className="flex min-w-0 flex-1 flex-col justify-center gap-1.5 py-0.5">
        <span className="line-clamp-2 break-words text-sm font-semibold text-zinc-100">{content.title}</span>
        <TypeBadge type={content.type} className="self-start" />
      </span>
    </button>
  );
}

/* ------------------------------ sign-in prompt ------------------------------ */

export function SignInPrompt({ title, message }: { title: string; message: string }) {
  return (
    <div className="mx-auto flex max-w-xl flex-col items-center justify-center gap-3 rounded-2xl border border-white/10 bg-white/[0.02] p-8 text-center sm:p-10">
      <div className="rounded-full bg-rose-500/10 p-3 text-rose-300">
        <LogIn className="h-6 w-6" aria-hidden />
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
        <LogIn aria-hidden /> Sign in
      </Button>
    </div>
  );
}
