'use client';

/**
 * ai-cursor.tsx — AI cursor aura overlay (FAZA 15).
 *
 * An additive rose→fuchsia ring that follows the mouse with a small lerp
 * (requestAnimationFrame + translate3d). The native cursor stays visible —
 * this is an accessibility-friendly aura, not a replacement.
 *
 *   - hovering [data-ai-poster]        → the ring grows + label "AI · Vezi"
 *   - hovering [data-ai-trailer="1"]   → the label becomes "AI · Trailer"
 *
 * Rendered only while the aiCursor setting is ON and the device has a fine
 * pointer (matchMedia('(pointer: fine)')). Hidden when the mouse leaves the
 * window. All listeners are cleaned up on unmount.
 */

import { useEffect, useRef, useState } from 'react';
import { useAiHomeSettings } from './ai-home-settings';

const LERP = 0.18;
const IDLE_EPSILON = 0.4;

export function AiCursor() {
  const { settings } = useAiHomeSettings();
  const [finePointer, setFinePointer] = useState(false);

  /* Coarse-pointer devices (touch) never get the aura. */
  useEffect(() => {
    const mq = window.matchMedia('(pointer: fine)');
    const apply = () => setFinePointer(mq.matches);
    const timer = setTimeout(apply, 0);
    mq.addEventListener('change', apply);
    return () => {
      clearTimeout(timer);
      mq.removeEventListener('change', apply);
    };
  }, []);

  const rootRef = useRef<HTMLDivElement>(null);
  const ringRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLSpanElement>(null);

  const active = settings.aiCursor && finePointer;

  useEffect(() => {
    if (!active) return undefined;

    const root = rootRef.current;
    const ring = ringRef.current;
    const label = labelRef.current;
    if (!root || !ring || !label) return undefined;

    let raf = 0;
    let running = false;
    let targetX = -200;
    let targetY = -200;
    let x = -200;
    let y = -200;
    let shown = false;

    const apply = () => {
      root.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    };

    const loop = () => {
      x += (targetX - x) * LERP;
      y += (targetY - y) * LERP;
      if (Math.abs(targetX - x) < IDLE_EPSILON && Math.abs(targetY - y) < IDLE_EPSILON) {
        x = targetX;
        y = targetY;
        apply();
        running = false;
        return;
      }
      apply();
      raf = requestAnimationFrame(loop);
    };

    const kick = () => {
      if (!running) {
        running = true;
        raf = requestAnimationFrame(loop);
      }
    };

    const show = () => {
      if (!shown) {
        shown = true;
        root.style.opacity = '1';
      }
    };

    const hide = () => {
      shown = false;
      root.style.opacity = '0';
    };

    /* While hovering a poster without a trailer yet, watch for the
       data-ai-trailer attribute — the hover trailer resolves async (~700ms
       dwell + fetch), and the label should flip to "AI · Trailer" on its own. */
    let attrObserver: MutationObserver | null = null;
    const stopAttrObserver = () => {
      attrObserver?.disconnect();
      attrObserver = null;
    };

    const onMove = (e: MouseEvent) => {
      targetX = e.clientX;
      targetY = e.clientY;
      show();
      kick();

      const el = e.target instanceof Element ? e.target : null;
      const poster = el?.closest('[data-ai-poster]') ?? null;
      const withTrailer = poster?.getAttribute('data-ai-trailer') === '1';

      if (poster) {
        /* Grow to the 64px aura + label pill. */
        ring.classList.remove('h-10', 'w-10');
        ring.classList.add('h-16', 'w-16');
        const title = poster.getAttribute('data-ai-title') ?? '';
        label.textContent = withTrailer ? 'AI · Trailer' : 'AI · Vezi';
        label.title = title;
        label.style.opacity = '1';
        if (!withTrailer) {
          stopAttrObserver();
          attrObserver = new MutationObserver(() => {
            if (poster.getAttribute('data-ai-trailer') === '1') {
              label.textContent = 'AI · Trailer';
              stopAttrObserver();
            }
          });
          attrObserver.observe(poster, { attributes: true, attributeFilter: ['data-ai-trailer'] });
        } else {
          stopAttrObserver();
        }
      } else {
        stopAttrObserver();
        ring.classList.remove('h-16', 'w-16');
        ring.classList.add('h-10', 'w-10');
        label.style.opacity = '0';
        label.removeAttribute('title');
      }
    };

    document.addEventListener('mousemove', onMove, { passive: true });
    document.addEventListener('mouseleave', hide);

    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseleave', hide);
      stopAttrObserver();
      if (raf) cancelAnimationFrame(raf);
      running = false;
    };
  }, [active]);

  if (!active) return null;

  return (
    <div
      ref={rootRef}
      aria-hidden
      className="pointer-events-none fixed left-0 top-0 z-[90] opacity-0 transition-opacity duration-200 will-change-transform"
    >
      <div
        ref={ringRef}
        className="grid h-10 w-10 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border border-rose-400/60 bg-gradient-to-br from-rose-500/25 to-fuchsia-500/25 shadow-[0_0_22px_rgba(244,63,94,0.35)] backdrop-blur-[2px] transition-[height,width] duration-200"
      >
        <span
          ref={labelRef}
          className="absolute left-1/2 top-full mt-1.5 max-w-40 -translate-x-1/2 truncate whitespace-nowrap rounded-full bg-rose-600 px-2.5 py-0.5 text-[10px] font-bold text-white opacity-0 shadow-lg shadow-rose-900/40 transition-opacity duration-150"
        >
          AI · Vezi
        </span>
      </div>
    </div>
  );
}

