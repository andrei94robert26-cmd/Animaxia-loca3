'use client';

/**
 * party-vote.tsx — FAZA 34 (PLAN 100X · WS4): „Votează următoarea vizionare"
 * — strat de prezentare watch-together 2.0 peste voturile party din modul
 * playerx (backend FAZA-34-a, contract înghețat). 100% aditiv față de
 * party-room: cardul doar CITEște starea votului (GET public + polling 5s,
 * pus pe pauză când tab-ul e ascuns) și acționează prin cele 3 metode noi
 * api.playerxParty* — logica de sincronizare/chat a camerei nu e atinsă.
 *
 * Candidații se derivesă onest din catalog: primul cuvânt significant
 * (min. 4 litere) din titlul petrecerii → /api/all?search=…&limit=8 →
 * normalizare (fără titlul curent, dedupe, max 6). Butonul de refresh
 * avansează determinist la următorul cuvânt significant. Dacă tally-ul
 * conține id-uri care nu mai sunt în lista de candidați (ex. după refresh),
 * ele se randează onest ca „Alt titlu #id" — niciun vot nu se pierde.
 */

import { useEffect, useMemo, useState } from 'react';
import { Check, Film, LogIn, RotateCw, Trophy, Vote, X } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/animaxia/api';
import { useApi } from '@/lib/animaxia/hooks';
import { useAuth } from '@/components/animaxia/auth-provider';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { TypeBadge } from '../states';

/* --------------------------------- types ---------------------------------- */

interface VoteCandidate {
  id: number;
  title: string;
  thumbnail: string | null;
  type: string;
}

export interface PartyVoteCardProps {
  partyId: number;
  contentId: number;
  isHost: boolean;
  /** Navigare SPA — party-room pasează exact navigate() al routerului. */
  onNavigate: (to: string) => void;
}

/* -------------------------------- helpers ---------------------------------- */

const STOPWORDS = new Set(['the', 'and', 'with', 'from', 'des', 'din', 'pentru']);

/** Cuvintele „significant" ale unui titlu: min. 4 caractere, fără stopwords —
 *  cascade deterministă pentru refresh (al doilea cuvânt etc.). */
function significantWords(title: string): string[] {
  const words = title
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w));
  return Array.from(new Set(words));
}

/* -------------------------------- the card --------------------------------- */

export function PartyVoteCard({ partyId, contentId, isHost, onNavigate }: PartyVoteCardProps) {
  const { user } = useAuth();
  const valid = Number.isInteger(partyId) && partyId > 0;

  /* ---------- starea votului (GET public + polling 5s, pauză pe hidden) ---------- */

  const votes = useApi(`party-vote-${partyId}`, () => api.playerxPartyVotes(partyId), {
    enabled: valid,
  });

  useEffect(() => {
    if (!valid) return undefined;
    const timer = setInterval(() => {
      /* Pauză onestă când tab-ul nu e vizibil — fără request-uri inutile. */
      if (typeof document !== 'undefined' && document.hidden) return;
      void votes.refetch();
    }, 10_000); /* NEON FREE PLAN: 10s (fost 5s) — vot live doar în timpul vizionării active */
    return () => clearInterval(timer);
  }, [valid, votes.refetch]);

  /* ---------- candidații: titlul petrecerii → cuvânt significant → /api/all ---------- */

  const contentRes = useApi(`party-vote-content-${contentId}`, () => api.content(contentId), {
    enabled: contentId > 0,
  });
  /* Stale-data guard (pattern FAZA 2-b): datele vechi nu se randează pentru
     alt id decât cel curent. */
  const content = contentRes.data && contentRes.data.id === contentId ? contentRes.data : null;

  const words = useMemo(() => (content ? significantWords(content.title) : []), [content]);
  const [wordIndex, setWordIndex] = useState(0);
  const term = words.length > 0 ? words[wordIndex % words.length] : null;

  const candRes = useApi(
    `party-vote-candidates-${contentId}-${term ?? 'none'}`,
    () => api.all({ search: term as string, limit: 8 }),
    { enabled: term != null },
  );

  const candidates = useMemo(() => {
    const rows = candRes.data?.data ?? [];
    const seen = new Set<number>();
    const out: VoteCandidate[] = [];
    for (const row of rows) {
      if (row.id === contentId || seen.has(row.id)) continue;
      seen.add(row.id);
      out.push({ id: row.id, title: row.title, thumbnail: row.thumbnail, type: row.type });
      if (out.length >= 6) break;
    }
    return out;
  }, [candRes.data, contentId]);

  /* ---------- randurile: candidați + id-uri „orfan" din tally ---------- */

  const voteState = votes.data && votes.data.partyId === partyId ? votes.data : null;
  const tally = voteState?.tally ?? {};
  const myVote = useMemo(() => {
    if (!user || !voteState) return null;
    const mine = voteState.voters.find((v) => v.userid === user.id);
    return mine ? mine.contentId : null;
  }, [user, voteState]);

  const rows = useMemo<VoteCandidate[]>(() => {
    const byId = new Map<number, VoteCandidate>();
    for (const c of candidates) byId.set(c.id, c);
    const orphans: VoteCandidate[] = [];
    for (const key of Object.keys(tally)) {
      const id = Number(key);
      if (!Number.isInteger(id) || id <= 0 || byId.has(id)) continue;
      orphans.push({ id, title: `Alt titlu #${id}`, thumbnail: null, type: 'mined' });
    }
    return [...candidates, ...orphans];
  }, [candidates, tally]);

  const maxTally = useMemo(() => {
    const values = rows.map((r) => tally[String(r.id)] ?? 0);
    return Math.max(1, ...values);
  }, [rows, tally]);

  const winnerRow = voteState?.status === 'closed' && voteState.winner != null
    ? rows.find((r) => r.id === voteState.winner) ?? null
    : null;

  /* ---------- acțiuni ---------- */

  const [votingId, setVotingId] = useState<number | null>(null);
  const [closing, setClosing] = useState(false);

  async function castVote(candidateId: number): Promise<void> {
    if (!user) {
      /* Guest — exact pattern-ul party-room: buton care duce la autentificare. */
      onNavigate('/auth');
      return;
    }
    if (voteState?.status === 'closed' || votingId != null) return;
    setVotingId(candidateId);
    try {
      await api.playerxPartyVote(partyId, candidateId);
      toast.success('Vot înregistrat');
      await votes.refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Nu am putut înregistra votul');
    } finally {
      setVotingId(null);
    }
  }

  async function closeVote(): Promise<void> {
    if (closing) return;
    setClosing(true);
    try {
      const res = await api.playerxClosePartyVote(partyId);
      const winnerTitle = rows.find((r) => r.id === res.winner)?.title;
      toast.success(
        res.winner != null
          ? `Votul s-a închis — câștigător: ${winnerTitle ?? `titlul #${res.winner}`}`
          : 'Votul s-a închis',
      );
      await votes.refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Nu am putut închide votul');
    } finally {
      setClosing(false);
    }
  }

  /* ----------------------------- stări de grație ----------------------------- */

  /* Petrecere dispărută (404 onest) sau endpoint indisponibil: cardul e un
     enhancement — dispare complet, camera rămâne intactă. Polling-ul continuă
     în montare, deci un 404/eroare tranzitorie se vindecă singură la următorul
     tick dacă serviciul revine. */
  if (!valid || (votes.error && !voteState)) return null;

  if (votes.loading && !voteState) {
    return (
      <Card className="border-white/10 bg-white/[0.03]">
        <CardHeader className="pb-3">
          <Skeleton className="h-4 w-44" />
        </CardHeader>
        <CardContent className="space-y-2 pt-0">
          <Skeleton className="h-14 w-full rounded-xl" />
          <Skeleton className="h-14 w-full rounded-xl" />
          <Skeleton className="h-14 w-full rounded-xl" />
        </CardContent>
      </Card>
    );
  }

  const candidatesLoading = Boolean(term) && candRes.loading && candidates.length === 0;
  const open = voteState?.status !== 'closed';

  return (
    <Card className="border-white/10 bg-white/[0.03]">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between gap-2 text-xs font-bold uppercase tracking-widest text-zinc-400">
          <span className="inline-flex min-w-0 items-center gap-2">
            <Vote className="h-4 w-4 shrink-0 text-rose-400" aria-hidden />
            Votează următoarea vizionare
          </span>
          <span className="inline-flex shrink-0 items-center gap-1.5">
            <span
              className={cn(
                'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold',
                open
                  ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                  : 'border-white/15 bg-white/[0.06] text-zinc-300',
              )}
            >
              {open ? (
                <span className="relative flex h-1.5 w-1.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-400" />
                </span>
              ) : (
                <X className="h-3 w-3" aria-hidden />
              )}
              {open ? 'Deschis' : 'Închis'}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Caută alte titluri înrudite"
              title="Caută alte titluri înrudite (alt cuvânt din titlu)"
              onClick={() => setWordIndex((i) => i + 1)}
              className="h-6 w-6 rounded-lg text-zinc-400 hover:bg-white/10 hover:text-zinc-100"
            >
              <RotateCw className="h-3.5 w-3.5" aria-hidden />
            </Button>
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 pt-0">
        {/* Câștigător — votul închis e final (gazda poate doar naviga). */}
        {!open && voteState && (
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/[0.08] p-3 text-center">
            <p className="flex items-center justify-center gap-1.5 text-sm font-bold text-amber-200">
              <Trophy className="h-4 w-4" aria-hidden />
              Câștigător: {winnerRow ? winnerRow.title : `alt titlu #${voteState.winner}`}
            </p>
            {voteState.winner != null && (
              <Button
                size="sm"
                className="mt-2 h-8 bg-rose-600 text-xs font-bold text-white hover:bg-rose-500"
                onClick={() => onNavigate(`/player/${voteState.winner}`)}
              >
                Deschide playerul
              </Button>
            )}
          </div>
        )}

        {candidatesLoading ? (
          <div className="space-y-2" aria-busy="true">
            <Skeleton className="h-14 w-full rounded-xl" />
            <Skeleton className="h-14 w-full rounded-xl" />
          </div>
        ) : rows.length < 2 ? (
          /* Onest: fără suficiente titluri înrudite găsite în catalog. */
          <div className="flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/[0.02] px-3 py-4">
            <p className="text-sm leading-relaxed text-zinc-500">
              Prea puține titluri înrudite pentru un vot
            </p>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Reîncearcă cu alt cuvânt din titlu"
              onClick={() => setWordIndex((i) => i + 1)}
              className="h-7 w-7 shrink-0 rounded-lg text-zinc-400 hover:bg-white/10 hover:text-zinc-100"
            >
              <RotateCw className="h-3.5 w-3.5" aria-hidden />
            </Button>
          </div>
        ) : (
          <>
            <ul
              className="custom-scrollbar max-h-80 space-y-2 overflow-y-auto pr-1"
              aria-label="Candidații pentru următoarea vizionare"
            >
              {rows.map((candidate) => {
                const count = tally[String(candidate.id)] ?? 0;
                const width = Math.round((count / maxTally) * 100);
                const mine = myVote === candidate.id;
                return (
                  <li
                    key={candidate.id}
                    className={cn(
                      'rounded-xl border p-2.5 transition',
                      mine
                        ? 'border-rose-500/50 bg-rose-500/[0.06] ring-2 ring-rose-500'
                        : 'border-white/10 bg-white/[0.03]',
                    )}
                  >
                    <div className="flex items-center gap-2.5">
                      {candidate.thumbnail ? (
                        <img
                          src={candidate.thumbnail}
                          alt=""
                          loading="lazy"
                          className="h-12 w-12 shrink-0 rounded-lg border border-white/10 object-cover"
                        />
                      ) : (
                        <span className="grid h-12 w-12 shrink-0 place-items-center rounded-lg border border-white/10 bg-gradient-to-br from-white/[0.08] to-white/[0.02]">
                          <Film className="h-5 w-5 text-zinc-600" aria-hidden />
                        </span>
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="min-w-0 truncate text-sm font-semibold text-zinc-100">
                            {candidate.title}
                          </span>
                          <TypeBadge type={candidate.type} />
                        </div>
                        <div
                          className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-white/10"
                          role="progressbar"
                          aria-valuenow={count}
                          aria-valuemin={0}
                          aria-valuemax={maxTally}
                          aria-label={`${count} voturi pentru ${candidate.title}`}
                        >
                          <div
                            className={cn(
                              'h-full rounded-full transition-all',
                              mine
                                ? 'bg-gradient-to-r from-rose-400 to-fuchsia-400'
                                : 'bg-gradient-to-r from-rose-500 to-fuchsia-500',
                            )}
                            style={{ width: `${width}%` }}
                          />
                        </div>
                      </div>
                      <span className="w-6 shrink-0 text-center font-mono text-xs font-bold text-zinc-300">
                        {count}
                      </span>
                      <Button
                        type="button"
                        size="sm"
                        aria-label={user ? `Votează ${candidate.title}` : 'Autentifică-te pentru a vota'}
                        disabled={!open || votingId != null}
                        onClick={() => void castVote(candidate.id)}
                        className={cn(
                          'h-8 shrink-0 text-xs font-bold',
                          mine
                            ? 'border border-rose-500/50 bg-rose-500/15 text-rose-200 hover:bg-rose-500/25'
                            : user
                              ? 'bg-rose-600 text-white hover:bg-rose-500'
                              : 'border border-white/15 bg-white/[0.04] text-zinc-300 hover:bg-white/10 hover:text-white',
                        )}
                      >
                        {!open ? (
                          'Închis'
                        ) : !user ? (
                          <>
                            <LogIn className="h-3.5 w-3.5" aria-hidden /> Autentifică-te
                          </>
                        ) : mine ? (
                          <>
                            <Check className="h-3.5 w-3.5" aria-hidden /> Votat
                          </>
                        ) : votingId === candidate.id ? (
                          'Se votează…'
                        ) : (
                          'Votează'
                        )}
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>

            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-[11px] text-zinc-500">
                {user
                  ? open
                    ? 'Un vot per persoană — îl poți schimba cât votul e deschis.'
                    : 'Votul s-a închis — navigați împreună la câștigător.'
                  : 'Conectează-te pentru a vota.'}
              </p>
              {isHost && open && (voteState?.voters.length ?? 0) > 0 && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={closing}
                  onClick={() => void closeVote()}
                  className="h-8 border-amber-500/40 bg-amber-500/10 text-xs font-bold text-amber-200 hover:bg-amber-500/20 hover:text-amber-100"
                >
                  {closing ? 'Se închide…' : 'Închide votul'}
                </Button>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
