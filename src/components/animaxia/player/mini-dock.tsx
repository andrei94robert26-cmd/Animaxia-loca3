'use client';

/**
 * mini-dock.tsx — FAZA 34 (PLAN 100X · WS4): învelișul MiniDock peste dock-ul
 * persistent FAZA 19 (`PlayerDock` — componentă PROTEJATĂ, zero editări).
 *
 * Adaugă funcția de RESTRÂNGERE: când dock-ul e restrâns, pill-ul compact
 * (punct rose pulsant + titlu) rămâne colț dreapta-jos, iar `<PlayerDock/>`
 * rămâne MONTAT într-un wrapper fix 0×0 cu `transform: scale(0.28)` +
 * `opacity: 0` + `pointer-events: none` — transform creează un containing
 * block, deci aside-ul fix al dock-ului se scalează în acel colț, INVIZIBIL,
 * dar elementul <video> rămâne în DOM și REDAREA CONTINUĂ (audio + video).
 * Demontarea ar opri redarea; CSS-ul nu o oprește. Verificat E2E.
 *
 * Starea restrâns/perims persistă în sessionStorage
 * (`animaxia-minidock-collapsed`); butonul „Restrânge" plutește deasupra
 * dock-ului (poziționat după înălțimea măsurată live cu ResizeObserver).
 */

import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { useRoute } from '@/lib/animaxia/router';
import { api } from '@/lib/animaxia/api';
import type { PlayerResponse } from '@/lib/animaxia/types';
import { setCaptureHandler, type PlayerxCaptureExact } from '@/lib/animaxia/playerx-capture';
import { PlayerDock, usePlayerDock } from '@/components/animaxia/player/player-dock';

const COLLAPSE_KEY = 'animaxia-minidock-collapsed';

/** Wrapper care ține dock-ul MONTAT dar invizibil (redarea continuă). */
const HIDDEN_PLAYBACK_STYLE: React.CSSProperties = {
  transform: 'scale(0.28)',
  transformOrigin: 'bottom right',
  opacity: 0,
  pointerEvents: 'none',
  position: 'fixed',
  bottom: '-4px',
  right: '-4px',
  width: 0,
  height: 0,
  overflow: 'visible',
};

/** Înălțime fallback până la prima măsurătoare (w-80: 180 video + header). */
const FALLBACK_DOCK_HEIGHT = 252;

export function MiniDock() {
  const { docked, minimizeToDock } = usePlayerDock();
  const route = useRoute();

  const [collapsed, setCollapsed] = useState(false);
  const [dockHeight, setDockHeight] = useState<number | null>(null);

  /* AUTO-CAPTURE (FAZA 34): handler-ul module-level (playerx-capture.ts) ne
     cere dock-uirea redării curente la navigarea în interiorul SPA. Rezolvăm
     sursa activă din API-ul de player și o predăm dock-ului FAZA 19. */
  useEffect(() => {
    setCaptureHandler((snap: PlayerxCaptureExact) => {
      void (async () => {
        try {
          const data: PlayerResponse = await api.player(snap.contentId);
          const sources = data.sources ?? [];
          const direct = sources.find((s) => s.url === snap.currentSrc);
          let source = direct ?? null;
          if (!source && snap.currentSrc.startsWith('blob:')) {
            /* hls.js: blob URL — folosim indiciul chip-ului activ dacă există. */
            const hinted = snap.sourceIndexHint >= 0 ? sources[snap.sourceIndexHint] : undefined;
            source = hinted ?? sources.find((s) => s.type === 'm3u8') ?? data.primary ?? sources[0] ?? null;
          } else if (!source) {
            source = data.primary ?? sources[0] ?? null;
          }
          if (!source || (source.type !== 'mp4' && source.type !== 'm3u8')) return;
          const md = (data.content.metadata ?? {}) as Record<string, unknown>;
          minimizeToDock({
            contentId: snap.contentId,
            title: data.content.title,
            thumbnail: data.content.thumbnail || (typeof md.backdrop === 'string' ? md.backdrop : null),
            source: { type: source.type, url: source.url, label: source.label },
            startedAt: Math.floor(snap.currentTime),
            open: true,
          });
        } catch {
          /* fără date player nu dock-uim onest — redarea se oprește la unmount */
        }
      })();
    });
    return () => setCaptureHandler(null);
  }, [minimizeToDock]);

  /* Hidratare din sessionStorage — deferit (regula set-state-in-effect). */
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        setCollapsed(window.sessionStorage.getItem(COLLAPSE_KEY) === '1');
      } catch {
        /* sessionStorage indisponibil — implicit extins */
      }
    }, 0);
    return () => clearTimeout(t);
  }, []);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        window.sessionStorage.setItem(COLLAPSE_KEY, next ? '1' : '0');
      } catch {
        /* persistența e best-effort */
      }
      return next;
    });
  }, []);

  /* Când randează PlayerDock vizibil? Aceleași condiții din player-dock.tsx
     (recalculate aici, fără să atingem componenta protejată). */
  const dockVisible = Boolean(
    docked &&
      docked.open &&
      docked.source &&
      (docked.source.type === 'mp4' || docked.source.type === 'm3u8') &&
      !(
        route?.view === 'player' &&
        docked.contentId != null &&
        Number(route.params[0]) === docked.contentId
      ),
  );

  /* Măsurăm înălțimea dock-ului (ResizeObserver) ca butonul „Restrânge" să
     plutească exact deasupra lui, indiferent de lățime (w-80 / sm:w-96). */
  useEffect(() => {
    if (!dockVisible || collapsed) return undefined;
    let ro: ResizeObserver | null = null;
    const t = setTimeout(() => {
      const aside = document.querySelector('aside[aria-label="Mini-player Animaxia"]');
      if (!aside) return;
      const apply = () => setDockHeight(aside.getBoundingClientRect().height);
      apply();
      ro = new ResizeObserver(apply);
      ro.observe(aside);
    }, 0);
    return () => {
      clearTimeout(t);
      ro?.disconnect();
    };
  }, [dockVisible, collapsed, docked?.contentId, docked?.source?.url]);

  return (
    <>
      {/* Butonul „Restrânge" — plutește deasupra dock-ului extins. */}
      {dockVisible && !collapsed && (
        <button
          type="button"
          onClick={toggleCollapsed}
          title="Restrânge mini-playerul (redarea continuă)"
          aria-label="Restrânge mini-playerul"
          style={{
            position: 'fixed',
            right: '16px',
            bottom: `${16 + (dockHeight ?? FALLBACK_DOCK_HEIGHT) + 8}px`,
          }}
          className="z-[60] inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-zinc-950/95 px-3 py-1.5 text-[11px] font-semibold text-zinc-300 shadow-lg shadow-black/50 backdrop-blur transition hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/60"
        >
          <ChevronDown className="h-3.5 w-3.5" aria-hidden />
          Restrânge
        </button>
      )}

      {/* Pill compact în locul dock-ului — redarea continuă ascuns. */}
      {dockVisible && collapsed && (
        <div
          role="status"
          aria-label={`Redare în curs: ${docked?.title ?? 'titlu necunoscut'}`}
          className="fixed bottom-4 right-4 z-50 flex max-w-[min(88vw,20rem)] items-center gap-2 rounded-full border border-white/15 bg-zinc-950/95 px-3 py-2 shadow-2xl shadow-black/60 backdrop-blur"
        >
          <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-rose-500" aria-hidden />
          <p className="min-w-0 flex-1 truncate text-xs font-bold text-white" title={docked?.title ?? undefined}>
            {docked?.title ?? 'Redare în curs'}
          </p>
          <button
            type="button"
            onClick={toggleCollapsed}
            title="Extinde mini-playerul"
            aria-label="Extinde mini-playerul"
            className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-zinc-300 transition hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/60"
          >
            <ChevronUp className="h-4 w-4" aria-hidden />
          </button>
        </div>
      )}

      {/* Dock-ul FAZA 19 — MEREU montat cât timp există stare de dock (altfel
          redarea s-ar opri). Extins: normal; Restrâns: invizibil dar VIU. */}
      {collapsed ? (
        <div style={HIDDEN_PLAYBACK_STYLE} aria-hidden>
          <PlayerDock />
        </div>
      ) : (
        <PlayerDock />
      )}
    </>
  );
}
