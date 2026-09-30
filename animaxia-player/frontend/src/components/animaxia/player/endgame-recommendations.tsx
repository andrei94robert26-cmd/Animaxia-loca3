'use client';

/**
 * endgame-recommendations.tsx — FAZA 19 (task 19-3b): overlay-ul „Ce urmează?"
 * de la finalul redării (mp4/m3u8), afișat DOAR când nu există o coadă de
 * playlist activă (coada are prioritate — vezi playlist-queue.tsx).
 *
 * Recomandările sunt 100% REALE: sursa este platform.aiPersonalPlayer(contentId)
 * — exact endpoint-ul folosit de cardul AI companion de sub player. Se refolosește
 * useApi cu ACEEAȘI cheie `player-ai-${contentId}`; componenta se montează doar
 * când overlay-ul devine vizibil, astfel încât în timpul redării normale nu se
 * face niciun request suplimentar (iar la momentul „ended" cererea lovește
 * cache-ul backend, cald de la companion).
 */

import { motion } from 'framer-motion';
import { Loader2, Play, RotateCcw, Sparkles, X } from 'lucide-react';
import { navigate } from '@/lib/animaxia/router';
import { useApi } from '@/lib/animaxia/hooks';
import { platform } from '@/lib/animaxia/platform';
import { Button } from '@/components/ui/button';
import { BrandPlaceholder, TypeBadge } from '@/components/animaxia/states';

export function EndgameRecommendationsOverlay({
  contentId,
  onReplay,
  onClose,
}: {
  contentId: number;
  onReplay: () => void;
  onClose: () => void;
}) {
  const ai = useApi(`player-ai-${contentId}`, () => platform.aiPersonalPlayer(contentId));

  /* Aceeași disciplină de dedupe by id ca în PlayerAiCompanion (FAZA 19-2). */
  const recs = ai.data
    ? ai.data.moreLikeThis
        .filter((item, i, arr) => arr.findIndex((x) => x.id === item.id) === i)
        .slice(0, 6)
    : [];

  return (
    <motion.div
      role="dialog"
      aria-label="Ce urmează? Recomandări la finalul redării"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.25 }}
      className="absolute inset-0 z-30 flex flex-col bg-black/85 p-4 backdrop-blur-sm sm:p-6"
    >
      <div className="flex items-center justify-between gap-3">
        <p className="flex items-center gap-2 text-sm font-bold uppercase tracking-widest text-zinc-300">
          <Sparkles className="h-4 w-4 text-rose-400" aria-hidden />
          Ce urmează?
        </p>
        <Button
          variant="outline"
          size="icon"
          className="h-8 w-8 border-white/15 bg-white/5 hover:bg-white/10"
          aria-label="Închide"
          onClick={onClose}
        >
          <X className="h-4 w-4" aria-hidden />
        </Button>
      </div>

      <div className="custom-scrollbar mt-3 flex-1 overflow-y-auto pr-1">
        {ai.loading ? (
          <div className="flex h-full min-h-40 flex-col items-center justify-center gap-2 text-zinc-400">
            <Loader2 className="h-6 w-6 animate-spin" aria-hidden />
            <p className="text-xs font-semibold">Se încarcă recomandările…</p>
          </div>
        ) : recs.length === 0 ? (
          <div className="flex h-full min-h-40 flex-col items-center justify-center gap-2 text-center">
            <p className="text-sm font-semibold text-zinc-200">Ai terminat de vizionat</p>
            <p className="max-w-xs text-xs leading-relaxed text-zinc-400">
              Nu am recomandări pentru acest titlu chiar acum — poți relua redarea
              sau poți explora biblioteca.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {recs.map((item, i) => (
              <motion.button
                key={item.id}
                type="button"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.25, delay: i * 0.05 }}
                onClick={() => navigate(`/player/${item.id}`)}
                aria-label={`Redă ${item.title}`}
                className="group overflow-hidden rounded-xl border border-white/10 bg-white/[0.03] text-left transition hover:border-rose-500/50 hover:bg-white/[0.07] focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/60"
              >
                <span className="relative block aspect-video w-full bg-white/5">
                  {item.thumbnail ? (
                    <img
                      src={item.thumbnail}
                      alt=""
                      loading="lazy"
                      className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
                    />
                  ) : (
                    <BrandPlaceholder title={item.title} />
                  )}
                  <span className="absolute inset-0 bg-gradient-to-t from-black/70 to-transparent" />
                  <span className="absolute inset-0 hidden items-center justify-center group-hover:flex">
                    <span className="rounded-full bg-rose-600/95 p-2 shadow-lg shadow-rose-900/40">
                      <Play className="h-4 w-4 fill-white text-white" aria-hidden />
                    </span>
                  </span>
                </span>
                <span className="block p-2">
                  <span className="line-clamp-2 text-xs font-semibold leading-tight text-zinc-100">
                    {item.title}
                  </span>
                  <TypeBadge type={item.type} className="mt-1.5" />
                </span>
              </motion.button>
            ))}
          </div>
        )}
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          className="flex-1 bg-rose-600 font-bold hover:bg-rose-500 sm:flex-none"
          onClick={onReplay}
        >
          <RotateCcw className="h-4 w-4" aria-hidden /> Reia de la început
        </Button>
        <Button
          variant="outline"
          className="flex-1 border-white/15 bg-white/5 font-semibold hover:bg-white/10 sm:flex-none"
          onClick={onClose}
        >
          Închide
        </Button>
      </div>
    </motion.div>
  );
}
