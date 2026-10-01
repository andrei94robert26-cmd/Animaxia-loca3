'use client';

/**
 * experience-host.tsx — FAZA 34 (PLAN 100X · WS4): gazda stratului de
 * experiență player. 100% aditivă: GĂZDUIEȘTE playerul protejat FAZA 17
 * într-un div observation (`data-playerx-host`, display:contents — zero
 * impact pe layout) și adaugă în jur:
 *
 *   • bară de acțiuni slim: „Captions" (Studio de subtitrări), „Markeri"
 *     (panoul de markeri episod), „Minimize" (dock persistent FAZA 19) și
 *     „Help ?" (overlay comenzi rapide);
 *   • scurtături extinse la nivel de fereastră: `,` `.` viteză ±0.25× (cu
 *     badge tranzitoriu în bara de acțiuni), `C` subtitrări on/off, `N`
 *     minimizare în dock, `?` ajutor — complementare, NICIODATĂ suprapuse
 *     peste handlerul propriu al playerului (Space/K/săgeți/F/M rămân ale
 *     playerului protejat);
 *   • AUTO-CAPTURE la navigare: un ascultător hashchange înregistrat în
 *     effect-ul copil rulează ÎNAINTE de re-randarea React (video-ul e încă
 *     în DOM) — dacă se redă ceva și noul hash NU e playerul aceluși titlu,
 *     redarea se dock-ează automat și continuă.
 *
 * Sursa activă la minimizare se rezolvă async prin api.player(id): potrivire
 * directă a currentSrc pentru mp4; `blob:` înseamnă hls.js → citim chip-ul
 * activ al comutatorului de surse (button[aria-pressed="true"] din grupul
 * „Surse de stream") → index în lista de surse; fallback primul m3u8 / sursa
 * primară. Embed-urile nu pot fi dock-uite (onests prin toast).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Captions, Keyboard, ListVideo, PictureInPicture2 } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/animaxia/api';
import { navigate, type AppRoute } from '@/lib/animaxia/router';
import type { PlayerResponse, PlayerSource } from '@/lib/animaxia/types';
import { usePlayerDock } from '@/components/animaxia/player/player-dock';
import { updateCaptureSnapshot } from '@/lib/animaxia/playerx-capture';
import { PlayerMarkers, useHostVideo, type PlayerMarkersStatus } from '@/components/animaxia/player/markers';
import { SubtitleStudio } from '@/components/animaxia/player/subtitle-studio';
import { ShortcutsHelp } from '@/components/animaxia/player/shortcuts-help';
import { cn } from '@/lib/utils';

const ACTION_BTN =
  'inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-semibold text-zinc-300 transition hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/60';

function formatRate(rate: number): string {
  return `${Math.round(rate * 100) / 100}`.replace(/(\.\d\d?)0+$/, '$1');
}

/** E deschis vreun dialog/sheet Radix? (comenzile rapide nu se combină cu el) */
function anyOverlayOpen(): boolean {
  return Boolean(document.querySelector('[role="dialog"][data-state="open"]'));
}

export function PlayerExperienceHost({ route, children }: { route: AppRoute; children: React.ReactNode }) {
  const { minimizeToDock } = usePlayerDock();

  const id = Number(route.params[0]);
  const validId = Number.isInteger(id) && id > 0;

  const hostRef = useRef<HTMLDivElement>(null);
  const video = useHostVideo(hostRef);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  /* Sincronizarea ref-ului se face în effect (nu în render) — handler-ele
     de tip hashchange/keydown citesc video-ul curent la momentul evenimentului. */
  useEffect(() => {
    videoRef.current = video;
  }, [video]);

  /* UI state — sheet-uri, panou markeri, badge viteză. */
  const [studioOpen, setStudioOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [markersOpen, setMarkersOpen] = useState(false);
  const [markersStatus, setMarkersStatus] = useState<PlayerMarkersStatus | 'unknown'>('unknown');
  const [rateBadge, setRateBadge] = useState<number | null>(null);
  const rateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const onMarkersStatus = useCallback((status: PlayerMarkersStatus) => {
    setMarkersStatus(status);
  }, []);

  /* --------------------------- minimizare în dock -------------------------- */

  /** Dedupe auto-capture + explicit: aceeași captură în <3s e ignorată. */
  const lastCaptureRef = useRef<{ contentId: number; at: number } | null>(null);

  const captureAndDock = useCallback(
    async (opts: { navigateHome: boolean; interactive: boolean }) => {
      const el = videoRef.current;
      if (!el || el.paused || el.ended) {
        if (opts.interactive) {
          toast.error('Nimic de minimizat — redarea nu este activă');
        }
        return;
      }
      if (!validId) return;

      const now = Date.now();
      if (
        lastCaptureRef.current &&
        lastCaptureRef.current.contentId === id &&
        now - lastCaptureRef.current.at < 3000
      ) {
        return;
      }
      lastCaptureRef.current = { contentId: id, at: now };

      /* Captură SINCRONĂ — înainte de orice await, poziția rămâne exactă. */
      const currentTime = el.currentTime;
      const currentSrc = el.currentSrc || el.src || '';

      let title: string | null = null;
      let thumbnail: string | null = null;
      let source: PlayerSource | null = null;
      try {
        const data: PlayerResponse = await api.player(id);
        title = data.content.title;
        const md = (data.content.metadata ?? {}) as Record<string, unknown>;
        thumbnail =
          data.content.thumbnail || (typeof md.backdrop === 'string' ? md.backdrop : null);
        const sources = data.sources ?? [];

        const direct = sources.find((s) => s.url === currentSrc);
        if (direct) {
          source = direct;
        } else if (currentSrc.startsWith('blob:')) {
          /* hls.js atașează media printr-un blob: URL — citim chip-ul activ. */
          const group = hostRef.current?.querySelector(
            'div[role="group"][aria-label="Surse de stream"]',
          );
          let resolved: PlayerSource | null = null;
          if (group) {
            const buttons = Array.from(group.querySelectorAll('button'));
            const activeIdx = buttons.findIndex((b) => b.getAttribute('aria-pressed') === 'true');
            if (activeIdx >= 0 && sources[activeIdx]) resolved = sources[activeIdx];
          }
          source =
            resolved ??
            sources.find((s) => s.type === 'm3u8') ??
            data.primary ??
            sources[0] ??
            null;
        } else {
          source = data.primary ?? sources[0] ?? null;
        }
      } catch {
        /* fără date player nu putem dock-ui onest */
      }

      if (!source || (source.type !== 'mp4' && source.type !== 'm3u8')) {
        if (opts.interactive) {
          toast.error(source ? 'Embed-urile nu pot fi minimizate' : 'Nu am putut identifica sursa de redare');
        }
        return;
      }

      minimizeToDock({
        contentId: id,
        title,
        thumbnail,
        source: { type: source.type, url: source.url, label: source.label },
        startedAt: Math.floor(currentTime),
        open: true,
      });
      if (opts.navigateHome) navigate('/home');
    },
    [validId, id, minimizeToDock],
  );

  const handleMinimize = useCallback(() => {
    void captureAndDock({ navigateHome: true, interactive: true });
  }, [captureAndDock]);

  /* ------------------- auto-capture la navigarea în SPA ------------------- */
  /* Ascultătorul de hashchange trăiește la nivel de MODUL (playerx-capture.ts)
     — înregistrat la import, înainte de router, deci video-ul e încă în DOM
     când rulează. Aici doar întreținem snapshot-ul live la fiecare eveniment
     de redare (timeupdate/play/pause/ended). */

  useEffect(() => {
    if (!video || !validId) {
      updateCaptureSnapshot(null);
      return undefined;
    }
    const push = () => {
      updateCaptureSnapshot({
        contentId: id,
        currentTime: video.currentTime,
        currentSrc: video.currentSrc || video.src || '',
        playing: !video.paused && !video.ended,
      });
    };
    push();
    video.addEventListener('timeupdate', push);
    video.addEventListener('play', push);
    video.addEventListener('pause', push);
    video.addEventListener('ended', push);
    return () => {
      video.removeEventListener('timeupdate', push);
      video.removeEventListener('play', push);
      video.removeEventListener('pause', push);
      video.removeEventListener('ended', push);
      /* Captura (dacă există) a fost deja declanșată de ascultătorul de modul
         înainte de unmount; snapshot-ul nu mai e necesar. */
      updateCaptureSnapshot(null);
    };
  }, [video, id, validId]);

  /* ------------------------- scurtături extinse --------------------------- */

  const bumpRate = useCallback((delta: number) => {
    const el = videoRef.current;
    if (!el) return;
    const current = Number.isFinite(el.playbackRate) && el.playbackRate > 0 ? el.playbackRate : 1;
    const next = Math.min(2, Math.max(0.25, Math.round((current + delta) * 100) / 100));
    try {
      el.playbackRate = next;
    } catch {
      return;
    }
    setRateBadge(el.playbackRate);
    if (rateTimerRef.current) clearTimeout(rateTimerRef.current);
    rateTimerRef.current = setTimeout(() => setRateBadge(null), 1500);
  }, []);

  const cycleSubs = useCallback(() => {
    const el = videoRef.current;
    if (!el) return;
    const tracks = Array.from(el.textTracks ?? []);
    if (tracks.length === 0) {
      toast.info('Acest titlu nu are subtitrări încărcate');
      return;
    }
    const anyShowing = tracks.some((t) => t.mode === 'showing');
    tracks.forEach((t) => {
      t.mode = 'disabled';
    });
    if (anyShowing) return;
    const first = tracks.find((t) => t.kind === 'subtitles') ?? tracks[0];
    if (first) first.mode = 'showing';
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (anyOverlayOpen()) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName ?? '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) {
        return;
      }
      switch (e.key) {
        case ',':
          bumpRate(-0.25);
          return;
        case '.':
          bumpRate(0.25);
          return;
        case 'c':
        case 'C':
          cycleSubs();
          return;
        case 'n':
        case 'N':
          handleMinimize();
          return;
        case '?':
          setHelpOpen(true);
          return;
        default:
          return;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [bumpRate, cycleSubs, handleMinimize]);

  /* Curățăm timerul badge-ului la unmount. */
  useEffect(
    () => () => {
      if (rateTimerRef.current) clearTimeout(rateTimerRef.current);
    },
    [],
  );

  const toggleMarkers = () => {
    if (markersStatus === 'unavailable') {
      toast.info('Markerii episodului nu sunt disponibili încă pe acest server');
      return;
    }
    setMarkersOpen((v) => !v);
  };

  /* -------------------------------- render --------------------------------- */

  return (
    <>
      {/* Bara de acțiuni slim — deasupra playerului găzduit. */}
      <div className="mx-auto w-full max-w-5xl px-4 pt-4 sm:px-6 lg:px-8">
        <div className="flex flex-wrap items-center gap-2" role="toolbar" aria-label="Experiență player">
          <button type="button" onClick={() => setStudioOpen(true)} className={ACTION_BTN}>
            <Captions className="h-3.5 w-3.5" aria-hidden />
            Captions
          </button>
          <button
            type="button"
            onClick={toggleMarkers}
            aria-pressed={markersOpen}
            className={cn(ACTION_BTN, markersOpen && 'border-rose-500/50 bg-rose-600/20 text-white')}
          >
            <ListVideo className="h-3.5 w-3.5" aria-hidden />
            Markers
          </button>
          <button type="button" onClick={handleMinimize} className={ACTION_BTN}>
            <PictureInPicture2 className="h-3.5 w-3.5" aria-hidden />
            Minimize
          </button>
          <button type="button" onClick={() => setHelpOpen(true)} className={ACTION_BTN}>
            <Keyboard className="h-3.5 w-3.5" aria-hidden />
            Help ?
          </button>

          {/* Badge tranzitoriu de viteză (afișat 1.5s după , / .) */}
          {rateBadge != null && (
            <span
              role="status"
              aria-live="polite"
              className="rounded-md border border-rose-500/40 bg-rose-600/90 px-2 py-1 font-mono text-xs font-bold text-white"
            >
              {formatRate(rateBadge)}×
            </span>
          )}
        </div>
        {markersStatus === 'unavailable' && (
          <p className="mt-2 text-[11px] text-zinc-500">
            Markerii episodului nu sunt disponibili încă pe acest server — serviciul
            „playerx" nu este activ aici.
          </p>
        )}
      </div>

      {/* Panou markeri (chip-ul flotant trăiește tot aici). */}
      <PlayerMarkers
        contentId={id}
        hostRef={hostRef}
        open={markersOpen}
        onOpenChange={setMarkersOpen}
        onStatusChange={onMarkersStatus}
      />

      {/* Playerul protejat, găzduit. display:contents = zero impact pe layout;
          nodul REAL există pentru querySelector/MutationObserver, iar rect-ul
          se citește de pe <video>, nu pe gazdă. */}
      <div ref={hostRef} data-playerx-host className="contents">
        {children}
      </div>

      <SubtitleStudio open={studioOpen} onOpenChange={setStudioOpen} />
      <ShortcutsHelp open={helpOpen} onOpenChange={setHelpOpen} />
    </>
  );
}
