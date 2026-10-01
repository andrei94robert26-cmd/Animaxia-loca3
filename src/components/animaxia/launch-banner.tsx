'use client';

/**
 * launch-banner.tsx — FAZA 29 (Animaxia 2.0) — reconstituirea banner-ului
 * global de anunțuri pierdut la restaurarea snapshot-ului FAZA 24. Citește
 * anunțurile din fișierul static public `/announcements.json` (livrat odată
 * cu build-ul — funcționează identic în sandbox și pe instanța publică),
 * afișează cel mai recent anunț activ și poate fi închis (memorizat în
 * localStorage, per id de anunț).
 *
 * Componentă 100% aditivă — nu atinge nicio componentă protejată. Dacă nu
 * există anunț activ (sau cel activ a fost închis), randează null.
 */

import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Megaphone, Sparkles, X } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface Announcement {
  id: string;
  /** info | success | warning | promo */
  level?: 'info' | 'success' | 'warning' | 'promo';
  message: string;
  link?: string;
  linkLabel?: string;
  /** ISO date strings — anunțul e activ doar în interval (opțional). */
  from?: string;
  until?: string;
}

const DISMISS_KEY = 'animaxia:banner-dismissed';

const LEVEL_STYLES: Record<string, { wrapper: string; icon: string }> = {
  info: {
    wrapper: 'border-teal-500/25 bg-gradient-to-r from-teal-500/[0.12] to-transparent',
    icon: 'bg-teal-500/20 text-teal-300',
  },
  success: {
    wrapper: 'border-emerald-500/25 bg-gradient-to-r from-emerald-500/[0.12] to-transparent',
    icon: 'bg-emerald-500/20 text-emerald-300',
  },
  warning: {
    wrapper: 'border-amber-500/25 bg-gradient-to-r from-amber-500/[0.12] to-transparent',
    icon: 'bg-amber-500/20 text-amber-300',
  },
  promo: {
    wrapper: 'border-rose-500/25 bg-gradient-to-r from-rose-500/[0.12] via-fuchsia-500/[0.06] to-transparent',
    icon: 'bg-rose-500/20 text-rose-300',
  },
};

function isActive(a: Announcement, now: number): boolean {
  if (a.from) {
    const from = Date.parse(a.from);
    if (Number.isFinite(from) && now < from) return false;
  }
  if (a.until) {
    const until = Date.parse(a.until);
    if (Number.isFinite(until) && now > until) return false;
  }
  return true;
}

async function loadAnnouncements(): Promise<Announcement[]> {
  try {
    const res = await fetch('/announcements.json', { cache: 'no-store' });
    if (!res.ok) return [];
    const body = (await res.json()) as { announcements?: Announcement[] };
    return Array.isArray(body.announcements) ? body.announcements : [];
  } catch {
    return [];
  }
}

export function LaunchBanner() {
  const [current, setCurrent] = useState<Announcement | null>(null);
  const [dismissedId, setDismissedId] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    void loadAnnouncements().then((list) => {
      if (!mounted || list.length === 0) return;
      const now = Date.now();
      const active = list.find((a) => a.id && a.message && isActive(a, now)) ?? null;
      if (!active) return;
      try {
        const stored = window.localStorage.getItem(DISMISS_KEY);
        if (stored !== active.id) setCurrent(active);
      } catch {
        /* localStorage indisponibil (mod privat) — afișăm oricum. */
        setCurrent(active);
      }
    });
    return () => {
      mounted = false;
    };
  }, []);

  const dismiss = () => {
    if (current) {
      try {
        window.localStorage.setItem(DISMISS_KEY, current.id);
      } catch {
        /* ignorăm erorile de storage — banner-ul revine la reload. */
      }
    }
    setDismissedId(current?.id ?? 'x');
    setCurrent(null);
  };

  const level = current?.level ?? 'info';
  const styles = LEVEL_STYLES[level] ?? LEVEL_STYLES.info;
  const isHashLink = current?.link?.startsWith('#') || current?.link?.startsWith('/');

  return (
    <AnimatePresence>
      {current && dismissedId !== current.id ? (
        <motion.div
          initial={{ opacity: 0, y: -16 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -16 }}
          transition={{ duration: 0.3, ease: 'easeOut' }}
          role="region"
          aria-label="Anunț platformă"
          className={cn('border-b backdrop-blur-md', styles.wrapper)}
        >
          <div className="mx-auto flex w-full max-w-7xl items-center gap-3 px-4 py-2.5 sm:px-6">
            <span className={cn('grid h-7 w-7 shrink-0 place-items-center rounded-lg', styles.icon)}>
              {level === 'promo' ? (
                <Sparkles className="h-4 w-4" aria-hidden />
              ) : (
                <Megaphone className="h-3.5 w-3.5" aria-hidden />
              )}
            </span>
            <p className="min-w-0 flex-1 truncate text-xs font-medium text-zinc-200 sm:text-[13px]">
              {current.message}
              {current.link ? (
                <a
                  href={isHashLink ? (current.link.startsWith('#') ? current.link : `#${current.link}`) : current.link}
                  target={isHashLink ? undefined : '_blank'}
                  rel={isHashLink ? undefined : 'noopener noreferrer'}
                  className="ml-2 whitespace-nowrap font-bold text-rose-300 underline-offset-2 hover:underline"
                >
                  {current.linkLabel ?? 'Află mai mult'} →
                </a>
              ) : null}
            </p>
            <button
              type="button"
              onClick={dismiss}
              aria-label="Închide anunțul"
              className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-zinc-500 transition-colors hover:bg-white/10 hover:text-zinc-200"
            >
              <X className="h-3.5 w-3.5" aria-hidden />
            </button>
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
