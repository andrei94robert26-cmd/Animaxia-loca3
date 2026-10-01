'use client';

/**
 * markers.tsx — FAZA 34 (PLAN 100X · WS4): markeri episod (skip intro/outro/recap).
 *
 * Consumă GET /api/playerx/markers/:contentId (backend FAZA-34-a — endpointul
 * poate 404 până la deploy; atunci componenta randează null, onest, și gazda
 * afișează indiciul). ZERO atingeri ale playerului protejat:
 *
 *   • găsește <video>-ul live din DOM-ul găzduit (MutationObserver — elementul
 *     e re-keyed de player la schimbarea sursei, deci re-atasăm ascultătorii);
 *   • CHIP DE SALT flotant, poziționat fixed după rect-ul video-ului, vizibil
 *     când currentTime ∈ [startsec−4, endsec−2] — doar pentru redare nativă
 *     (mp4/HLS); embed-urile nu au <video>, deci nu apare nimic;
 *   • PANOU markeri: listă + editare inline (autentificat) + ștergere markeri
 *     confirmați, cu toast-uri și refetch.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, ChevronUp, ListVideo, Pencil, Play, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/animaxia/api';
import { useApi } from '@/lib/animaxia/hooks';
import type { PlayerxMarker, PlayerxMarkerKind } from '@/lib/animaxia/types';
import { useAuth } from '@/components/animaxia/auth-provider';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

/* --------------------------------- helpers -------------------------------- */

export function formatMarkerClock(sec: number): string {
  const s = Math.max(0, Math.floor(Number.isFinite(sec) ? sec : 0));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

const KIND_BADGE: Record<PlayerxMarkerKind, string> = {
  intro: 'border-teal-500/30 bg-teal-500/15 text-teal-300',
  recap: 'border-amber-500/30 bg-amber-500/15 text-amber-300',
  outro: 'border-fuchsia-500/30 bg-fuchsia-500/15 text-fuchsia-300',
};

const KIND_LABEL: Record<PlayerxMarkerKind, string> = {
  intro: 'Intro',
  recap: 'Recap',
  outro: 'Final',
};

function skipVerb(marker: PlayerxMarker): string {
  if (marker.label === 'Intro' || marker.kind === 'intro') return 'Sari intro-ul';
  if (marker.label === 'Recapitulare' || marker.kind === 'recap') return 'Sari recapitularea';
  return 'Sari finalul';
}

/**
 * Atașează (și re-atașă) <video>-ul live dintr-un container gazdă. Playerul
 * protejat re-key-e elementul la schimbarea sursei, deci un MutationObserver
 * pe subarbore re-detectează elementul nou și îl expune prin stare.
 */
export function useHostVideo(
  hostRef: React.RefObject<HTMLDivElement | null>,
): HTMLVideoElement | null {
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    const attach = () => {
      const el = host.querySelector('video');
      setVideo((prev) => (prev === el ? prev : el));
    };
    /* Deferit (regula set-state-in-effect) + observer pentru re-mount-uri. */
    const timer = setTimeout(attach, 0);
    const mo = new MutationObserver(attach);
    mo.observe(host, { childList: true, subtree: true });
    return () => {
      clearTimeout(timer);
      mo.disconnect();
    };
  }, [hostRef]);

  return video;
}

/* ------------------------------- the component ----------------------------- */

export type PlayerMarkersStatus = 'available' | 'unavailable';

type MarkersResult =
  | { status: 'available'; markers: PlayerxMarker[]; note?: string }
  | { status: 'unavailable' };

export function PlayerMarkers({
  contentId,
  hostRef,
  open,
  onOpenChange,
  onStatusChange,
}: {
  contentId: number;
  hostRef: React.RefObject<HTMLDivElement | null>;
  /** Vizibilitatea panoului (butonul „Markeri" din bara gazdă). */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Raportează gazdei dacă serviciul playerx e disponibil pe acest server. */
  onStatusChange?: (status: PlayerMarkersStatus) => void;
}) {
  const { user } = useAuth();
  const validId = Number.isInteger(contentId) && contentId > 0;

  const state = useApi(
    `playerx-markers-${contentId}`,
    async (): Promise<MarkersResult> => {
      try {
        const res = await api.playerxMarkers(contentId);
        return { status: 'available', markers: Array.isArray(res.data) ? res.data : [], note: res.note };
      } catch {
        /* 404 (backend încă nedeploysat) sau eroare rețea → null onest. */
        return { status: 'unavailable' };
      }
    },
    { enabled: validId },
  );

  const markers = state.data?.status === 'available' ? state.data.markers : [];
  const unavailable = state.data != null && state.data.status === 'unavailable';
  const available = state.data?.status === 'available';

  /* Raportăm starea gazdei (debounced prin comparație — fără bucle). */
  const lastReportRef = useRef<PlayerMarkersStatus | null>(null);
  useEffect(() => {
    if (state.data == null) return;
    const status: PlayerMarkersStatus = state.data.status;
    if (lastReportRef.current === status) return;
    lastReportRef.current = status;
    onStatusChange?.(status);
  }, [state.data, onStatusChange]);

  const video = useHostVideo(hostRef);
  const markersRef = useRef<PlayerxMarker[]>(markers);
  markersRef.current = markers;

  /* ------------------------ chip-ul flotant de salt ----------------------- */

  const [chip, setChip] = useState<{ marker: PlayerxMarker; bottom: number; right: number } | null>(null);

  const computeChipPos = useCallback((el: HTMLVideoElement) => {
    const rect = el.getBoundingClientRect();
    /* Colț dreapta-jos ÎN interiorul video-ului: 64px peste marginea de jos,
       16px față de marginea dreaptă (8px pe video-uri înguste). */
    const bottom = Math.round(window.innerHeight - rect.bottom + 64);
    const right = Math.round(window.innerWidth - rect.right + (rect.width < 260 ? 8 : 16));
    return { bottom, right };
  }, []);

  useEffect(() => {
    if (!video) {
      /* Elementul a dispărut (ex. navigare) — curățăm chip-ul, deferit. */
      const t = setTimeout(() => setChip(null), 0);
      return () => clearTimeout(t);
    }
    const onTime = () => {
      const t = video.currentTime;
      const list = markersRef.current;
      const active =
        list.find((m) => t >= m.startsec - 4 && t <= m.endsec - 2) ?? null;
      if (!active) {
        setChip((prev) => (prev == null ? prev : null));
        return;
      }
      const pos = computeChipPos(video);
      setChip((prev) =>
        prev && prev.marker.id === active.id && prev.bottom === pos.bottom && prev.right === pos.right
          ? prev
          : { marker: active, ...pos },
      );
    };
    const onEnded = () => setChip(null);
    video.addEventListener('timeupdate', onTime);
    video.addEventListener('ended', onEnded);
    return () => {
      video.removeEventListener('timeupdate', onTime);
      video.removeEventListener('ended', onEnded);
    };
  }, [video, computeChipPos, available, markers.length]);

  /* Repoziționare la resize/scroll cât timp chip-ul e vizibil. */
  useEffect(() => {
    if (!chip || !video) return undefined;
    const update = () => {
      const pos = computeChipPos(video);
      setChip((prev) =>
        prev && (prev.bottom !== pos.bottom || prev.right !== pos.right)
          ? { marker: prev.marker, ...pos }
          : prev,
      );
    };
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [chip != null, video, computeChipPos]);

  const skipTo = useCallback(
    (marker: PlayerxMarker) => {
      if (!video) return;
      try {
        video.currentTime = marker.endsec;
      } catch {
        /* seek imposibil — lăsăm redarea neatinasă */
      }
      api.playerxMarkerUse(contentId, marker.kind).catch(() => {});
      setChip(null);
    },
    [video, contentId],
  );

  /* --------------------------- editare / ștergere -------------------------- */

  const [editing, setEditing] = useState<PlayerxMarkerKind | null>(null);
  const [editStart, setEditStart] = useState('');
  const [editEnd, setEditEnd] = useState('');
  const [busy, setBusy] = useState(false);

  const startEdit = (marker: PlayerxMarker) => {
    setEditing((prev) => (prev === marker.kind ? null : marker.kind));
    setEditStart(String(Math.round(marker.startsec)));
    setEditEnd(String(Math.round(marker.endsec)));
  };

  const confirmEdit = async (kind: PlayerxMarkerKind) => {
    const start = Number(editStart);
    const end = Number(editEnd);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
      toast.error('Interval invalid — finalul trebuie să fie după început');
      return;
    }
    setBusy(true);
    try {
      await api.playerxUpsertMarker(contentId, { kind, startsec: Math.round(start), endsec: Math.round(end) });
      toast.success('Marker salvat — mulțumim pentru confirmare');
      setEditing(null);
      await state.refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Salvarea markerului a eșuat');
    } finally {
      setBusy(false);
    }
  };

  const deleteMarker = async (kind: PlayerxMarkerKind) => {
    setBusy(true);
    try {
      await api.playerxDeleteMarker(contentId, kind);
      toast.success('Marker șters');
      await state.refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Ștergerea a eșuat');
    } finally {
      setBusy(false);
    }
  };

  /* ------------------------------- render ---------------------------------- */

  /* Serviciu nedisponibil (backend FAZA-34-a încă nelivatrat): zero UI vizibil,
     doar starea ascunsă pentru gazdă/E2E. */
  if (unavailable) {
    return (
      <span data-playerx-markers="unavailable" className="sr-only">
        Markerii episodului nu sunt disponibili pe acest server.
      </span>
    );
  }

  if (!available) return null;

  return (
    <>
      {/* Stare ascunsă pentru gazdă/E2E — markeri disponibili. */}
      <span data-playerx-markers="available" data-count={markers.length} className="sr-only">
        {markers.length} markeri disponibili pentru episod.
      </span>

      {/* Chip flotant „Sari …" — doar când există video nativ în DOM. */}
      {chip && video && (
        <button
          type="button"
          onClick={() => skipTo(chip.marker)}
          style={{ position: 'fixed', bottom: `${chip.bottom}px`, right: `${chip.right}px` }}
          className="z-40 inline-flex items-center gap-1.5 rounded-full bg-rose-600 px-4 py-2 text-sm font-bold text-white shadow-lg shadow-black/50 transition hover:bg-rose-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-300"
        >
          <Play className="h-3.5 w-3.5 fill-white" aria-hidden />
          {skipVerb(chip.marker)} ▸ {formatMarkerClock(chip.marker.endsec)}
          {chip.marker.source === 'estimated' && (
            <span className="font-medium text-white/70">(estimat)</span>
          )}
        </button>
      )}

      {/* Panou markeri (comutabil din bara gazdei). */}
      {open && (
        <section
          aria-label="Markeri episod"
          className="mx-auto w-full max-w-5xl px-4 sm:px-6 lg:px-8"
        >
          <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 sm:p-5">
            <header className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="flex items-center gap-2 text-sm font-bold text-white">
                <span className="grid h-7 w-7 place-items-center rounded-lg bg-gradient-to-br from-teal-500/30 to-fuchsia-500/30">
                  <ListVideo className="h-4 w-4 text-teal-300" aria-hidden />
                </span>
                Markeri episod
                {markers.length > 0 && (
                  <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[11px] font-semibold text-zinc-400">
                    {markers.length}
                  </span>
                )}
              </h2>
              <button
                type="button"
                onClick={() => onOpenChange(false)}
                aria-label="Restrânge panoul de markeri"
                className="grid h-8 w-8 place-items-center rounded-lg text-zinc-400 transition hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/60"
              >
                <ChevronUp className="h-4 w-4" aria-hidden />
              </button>
            </header>

            {markers.length === 0 ? (
              <p className="mt-2 text-xs text-zinc-500">
                Niciun marker episod pentru acest titlu încă{user ? ' — confirmă intervalele mai jos după ce apar estimări' : ''}.
              </p>
            ) : (
              <>
                {!video && (
                  <p className="mt-2 text-xs text-zinc-500">
                    Chip-ul de salt apare doar la redarea nativă (mp4/HLS) — embed-urile
                    nu pot fi controlate din afară.
                  </p>
                )}

                <ul className="mt-3 space-y-2">
              {markers.map((marker) => (
                <li
                  key={String(marker.id)}
                  className="rounded-xl border border-white/10 bg-white/[0.02] p-3"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={cn(
                        'inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider',
                        KIND_BADGE[marker.kind] ?? KIND_BADGE.intro,
                      )}
                    >
                      {KIND_LABEL[marker.kind] ?? marker.label}
                    </span>
                    <span className="font-mono text-xs text-zinc-300">
                      de la {formatMarkerClock(marker.startsec)} la {formatMarkerClock(marker.endsec)}
                    </span>
                    <span
                      className={cn(
                        'rounded-full border px-2 py-0.5 text-[10px] font-semibold',
                        marker.source === 'curated'
                          ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                          : 'border-white/10 bg-white/5 text-zinc-400',
                      )}
                    >
                      {marker.source === 'curated' ? 'confirmat' : 'estimat'}
                    </span>
                    <span className="flex-1" />
                    {video && (
                      <Button
                        size="sm"
                        onClick={() => skipTo(marker)}
                        className="h-8 bg-rose-600 px-3 text-xs font-bold hover:bg-rose-500"
                      >
                        <Play className="h-3.5 w-3.5 fill-white" aria-hidden />
                        Sari acum
                      </Button>
                    )}
                    {user && (
                      <>
                        <button
                          type="button"
                          onClick={() => startEdit(marker)}
                          aria-label={`Editează markerul ${KIND_LABEL[marker.kind] ?? marker.kind}`}
                          title="Editează intervalul"
                          className="grid h-8 w-8 place-items-center rounded-lg text-zinc-400 transition hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/60"
                        >
                          <Pencil className="h-3.5 w-3.5" aria-hidden />
                        </button>
                        {marker.source === 'curated' && (
                          <button
                            type="button"
                            onClick={() => void deleteMarker(marker.kind)}
                            disabled={busy}
                            aria-label={`Șterge markerul ${KIND_LABEL[marker.kind] ?? marker.kind}`}
                            title="Șterge markerul confirmat"
                            className="grid h-8 w-8 place-items-center rounded-lg text-zinc-400 transition hover:bg-rose-500/15 hover:text-rose-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/60 disabled:opacity-50"
                          >
                            <Trash2 className="h-3.5 w-3.5" aria-hidden />
                          </button>
                        )}
                      </>
                    )}
                  </div>

                  {/* Rând de editare inline (autentificat). */}
                  {user && editing === marker.kind && (
                    <div className="mt-3 flex flex-wrap items-end gap-2 rounded-lg border border-white/10 bg-black/30 p-2.5">
                      <label className="text-[11px] font-semibold text-zinc-400">
                        Start (s)
                        <Input
                          type="number"
                          min={0}
                          value={editStart}
                          onChange={(e) => setEditStart(e.target.value)}
                          className="mt-1 h-8 w-24 border-white/10 bg-black/40 font-mono text-xs text-zinc-200 focus-visible:ring-rose-500/60"
                        />
                      </label>
                      <label className="text-[11px] font-semibold text-zinc-400">
                        Final (s)
                        <Input
                          type="number"
                          min={1}
                          value={editEnd}
                          onChange={(e) => setEditEnd(e.target.value)}
                          className="mt-1 h-8 w-24 border-white/10 bg-black/40 font-mono text-xs text-zinc-200 focus-visible:ring-rose-500/60"
                        />
                      </label>
                      <Button
                        size="sm"
                        disabled={busy}
                        onClick={() => void confirmEdit(marker.kind)}
                        className="h-8 bg-emerald-600 px-3 text-xs font-bold hover:bg-emerald-500"
                      >
                        <Check className="h-3.5 w-3.5" aria-hidden />
                        Confirmați
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => setEditing(null)}
                        className="h-8 px-3 text-xs font-semibold text-zinc-400 hover:bg-white/10 hover:text-white"
                      >
                        Anulează
                      </Button>
                    </div>
                  )}
                </li>
              ))}
                </ul>

                {user && (
                  <p className="mt-3 text-[11px] text-zinc-500">
                    Confirmarea unui marker îl transformă în „confirmat" și îl face
                    disponibil pentru toți vizitatorii.
                  </p>
                )}
              </>
            )}
          </div>
        </section>
      )}

    </>
  );
}
