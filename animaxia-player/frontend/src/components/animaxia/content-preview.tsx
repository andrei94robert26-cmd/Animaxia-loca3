'use client';

/**
 * content-preview.tsx — FAZA 19 (task 19-3b): preview mode la hover pe carduri.
 *
 * Wrapper aditiv pentru <ContentCard>: pe dispozitive hover-capabile
 * (matchMedia '(hover: hover) and (pointer: fine)' — pe mobil nu apare deloc),
 * după un dwell de 600ms deschide un popover absolut (w-64, z-40, framer-motion
 * scale/fade) deasupra cardului cu thumbnail mare, titlu, tip + an, rating,
 * overview pe 2 linii și 2 acțiuni rapide («Redă» / «Detalii»).
 *
 * Popover-ul este un SIBLING al elementului cardului (nu un copil al lui), deci
 * click-urile pe butoane NU declanșează navigația normală a cardului și
 * click-ul normal pe card rămâne intact. Închiderea se face la mouse leave cu
 * un grace period de 150ms (pointerul poate traverse spațiul până la popover —
 * deși popover-ul e descendent DOM al wrapperului și păstrează hover-ul).
 *
 * Când dispozitivul nu e hover-capable, componenta randează copilul fix cum era
 * (fragment, zero wrapperi) — ZERO schimbări de layout.
 */

import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Info, Play } from 'lucide-react';
import { navigate, targetForItem } from '@/lib/animaxia/router';
import type { NormalizedItem } from '@/lib/animaxia/types';
import { Button } from '@/components/ui/button';
import { BrandPlaceholder, RatingBadge, TypeBadge } from '@/components/animaxia/states';

const PREVIEW_DWELL_MS = 600;
const PREVIEW_GRACE_MS = 150;
const PREVIEW_WIDTH = 256; /* w-64 */
const PREVIEW_MIN_SPACE = 330; /* înălțimea aproximativă a popover-ului */

interface PreviewPosition {
  side: 'above' | 'below';
  /** offset stânga relativ la wrapper (poate fi negativ — popover mai lat ca cardul) */
  left: number;
  /** distanța (px) față de marginea wrapper-ului pe axa verticală */
  offset: number;
}

export function ContentPreview({
  item,
  children,
}: {
  item: NormalizedItem;
  children: React.ReactNode;
}) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const openTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* SSR-safe: fals la primul randare → copilul se randează fix ca înainte.
     Detectarea hover-capable e amânată printr-un macrotask (pattern-ul useApi)
     — fără setState sincron în corpul efectului, fără hydration mismatch. */
  const [hoverCapable, setHoverCapable] = useState(false);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<PreviewPosition | null>(null);

  useEffect(() => {
    const t = setTimeout(() => {
      if (
        typeof window !== 'undefined' &&
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(hover: hover) and (pointer: fine)').matches
      ) {
        setHoverCapable(true);
      }
    }, 0);
    return () => clearTimeout(t);
  }, []);

  /* Curățenie la unmount — niciun timer nu scapă. */
  useEffect(
    () => () => {
      if (openTimerRef.current) clearTimeout(openTimerRef.current);
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    },
    [],
  );

  if (!hoverCapable) return <>{children}</>;

  const clearOpenTimer = () => {
    if (openTimerRef.current) {
      clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
  };
  const clearCloseTimer = () => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  };

  const computePosition = () => {
    const el = wrapperRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    /* Centrează orizontal pe card, apoi clampează la viewport. */
    let left = rect.left + rect.width / 2 - PREVIEW_WIDTH / 2;
    left = Math.max(8, Math.min(left, vw - PREVIEW_WIDTH - 8));
    const spaceAbove = rect.top;
    const spaceBelow = vh - rect.bottom;
    const side: 'above' | 'below' =
      spaceAbove >= PREVIEW_MIN_SPACE ? 'above' : spaceBelow >= PREVIEW_MIN_SPACE ? 'below' : 'above';
    setPos({ side, left: left - rect.left, offset: rect.height + 8 });
  };

  const onEnter = () => {
    clearCloseTimer();
    if (openTimerRef.current || open) return;
    openTimerRef.current = setTimeout(() => {
      openTimerRef.current = null;
      computePosition();
      setOpen(true);
    }, PREVIEW_DWELL_MS);
  };

  const onLeave = () => {
    clearOpenTimer();
    if (closeTimerRef.current) return;
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = null;
      setOpen(false);
    }, PREVIEW_GRACE_MS);
  };

  const target = targetForItem(item);
  /* «Redă»: direct la player pentru titluri din bibliotecă; altfel comportamentul
     normal al cardului (detalii / link extern). */
  const onPlay = () => {
    setOpen(false);
    if (item.kind === 'db' && item.dbId != null) {
      navigate(`/player/${item.dbId}`);
    } else if (target?.kind === 'internal') {
      navigate(target.href);
    } else if (target?.kind === 'external') {
      window.open(target.href, '_blank', 'noopener,noreferrer');
    }
  };
  /* «Detalii»: exact comportamentul normal de click pe card. */
  const onDetails = () => {
    setOpen(false);
    if (target?.kind === 'internal') navigate(target.href);
    else if (target?.kind === 'external') window.open(target.href, '_blank', 'noopener,noreferrer');
  };

  return (
    <div ref={wrapperRef} className="relative w-full" onMouseEnter={onEnter} onMouseLeave={onLeave}>
      {children}
      <AnimatePresence>
        {open && pos && (
          <motion.div
            key="content-preview"
            role="dialog"
            aria-label={`Previzualizare ${item.title}`}
            initial={{ opacity: 0, scale: 0.96, y: pos.side === 'above' ? 6 : -6 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97 }}
            transition={{ duration: 0.16, ease: 'easeOut' }}
            className="absolute z-40 w-64"
            style={
              pos.side === 'above'
                ? { bottom: pos.offset, left: pos.left }
                : { top: pos.offset, left: pos.left }
            }
            onMouseEnter={clearCloseTimer}
            onMouseLeave={onLeave}
          >
            <div className="overflow-hidden rounded-xl border border-white/15 bg-[#12121a] shadow-2xl shadow-black/70">
              <div className="relative aspect-video w-full bg-white/5">
                {item.image ? (
                  <img
                    src={item.image}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <BrandPlaceholder title={item.title} />
                )}
                <div className="absolute inset-0 bg-gradient-to-t from-black/70 to-transparent" />
                <div className="absolute bottom-1.5 left-2 right-2 flex flex-wrap items-center gap-1.5">
                  <TypeBadge type={item.type} />
                  {item.rating != null && item.rating > 0 && <RatingBadge value={item.rating} />}
                </div>
              </div>
              <div className="space-y-1.5 p-2.5">
                <p className="line-clamp-1 text-sm font-bold leading-tight text-white" title={item.title}>
                  {item.title}
                </p>
                <p className="text-[11px] text-zinc-400">
                  {item.type}
                  {item.year != null && item.year !== '' ? ` · ${item.year}` : ''}
                </p>
                {item.overview && (
                  <p className="line-clamp-2 text-[11px] leading-relaxed text-zinc-400">{item.overview}</p>
                )}
                <div className="flex gap-2 pt-1">
                  <Button
                    size="sm"
                    className="h-8 flex-1 bg-rose-600 text-xs font-bold hover:bg-rose-500"
                    onClick={onPlay}
                  >
                    <Play className="h-3.5 w-3.5 fill-white" aria-hidden /> Redă
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 flex-1 border-white/15 bg-white/5 text-xs font-semibold hover:bg-white/10"
                    onClick={onDetails}
                  >
                    <Info className="h-3.5 w-3.5" aria-hidden /> Detalii
                  </Button>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
