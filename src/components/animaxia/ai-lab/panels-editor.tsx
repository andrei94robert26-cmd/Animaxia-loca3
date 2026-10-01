'use client';

/**
 * ai-lab/panels-editor.tsx — FAZA 35 (WS5): AI Playlist Editor.
 * Descriere liberă („thrillere coreene lungi") → interpretare AI (genuri,
 * tipuri, cuvinte-cheie, mood) → playlist real cu itemi din catalog →
 * salvare în colecția mea (AUTH) + listele salvate cu preview și navigare.
 */

import { useState } from 'react';
import { ChevronDown, Loader2, Save, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/animaxia/api';
import { useApi } from '@/lib/animaxia/hooks';
import { navigate } from '@/lib/animaxia/router';
import type { AiLabEditorGenerateResponse } from '@/lib/animaxia/types';
import { useAuth } from '../auth-provider';
import { ErrorState } from '../states';
import { cn } from '@/lib/utils';
import { LabCard, LabItemGrid, LabLoginPrompt, LabNote, LabProviderBadge } from './lab-ui';

const EXAMPLES = [
  'thrillere coreene lungi',
  'anime de acțiune pentru seara de vineri',
  'comedii romantice din anii 2000',
  'documentare despre spațiu',
];

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString('ro-RO', { day: 'numeric', month: 'long', year: 'numeric' });
  } catch {
    return '';
  }
}

export function EditorPanel() {
  const { user } = useAuth();
  const [description, setDescription] = useState('');
  const [res, setRes] = useState<AiLabEditorGenerateResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [showLogin, setShowLogin] = useState(false);

  const listsRes = useApi('ai-lab-editor-lists', () => api.aiLabEditorLists(), { enabled: !!user });

  const generate = async () => {
    if (!description.trim() || loading) return;
    setLoading(true);
    setError(null);
    setRes(null);
    try {
      const r = await api.aiLabEditorGenerate(description.trim());
      setRes(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Generarea playlist-ului a eșuat');
    } finally {
      setLoading(false);
    }
  };

  const save = async () => {
    if (!res || saving) return;
    if (!user) {
      setShowLogin(true);
      return;
    }
    setSaving(true);
    try {
      await api.aiLabEditorSave(res.playlist, res.items.map((it) => it.id));
      toast.success('Playlist salvat', { description: `„${res.playlist.title}" — ${res.items.length} titluri în colecția ta.` });
      void listsRes.refetch();
    } catch (e) {
      toast.error('Salvarea a eșuat', { description: e instanceof Error ? e.message : 'backend-ul nu răspunde' });
    } finally {
      setSaving(false);
    }
  };

  const interpreted = res?.interpreted;

  return (
    <div className="space-y-4">
      <LabCard title="Descrie playlist-ul dorit" hint="Limbaj natural — AI-ul interpretează genuri, tipuri, cuvinte-cheie și mood">
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            {EXAMPLES.map((ex) => (
              <button
                key={ex}
                type="button"
                onClick={() => setDescription(ex)}
                className="min-h-9 rounded-full border border-white/15 bg-white/[0.03] px-3 text-xs font-semibold text-zinc-300 transition hover:border-rose-500/40 hover:text-rose-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/60"
              >
                {ex}
              </button>
            ))}
          </div>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="ex. thrillere coreene lungi, preferabil din ultimii ani, cu intrigi complexe…"
            rows={3}
            maxLength={300}
            className="flex min-h-20 w-full rounded-xl border border-white/10 bg-white/[0.03] px-3.5 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-600 focus-visible:border-rose-500/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/30"
            aria-label="Descrierea playlist-ului"
          />
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={() => void generate()} disabled={!description.trim() || loading} className="h-11 bg-rose-600 font-bold hover:bg-rose-500">
              {loading ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden /> : <Sparkles className="mr-1.5 h-4 w-4" aria-hidden />}
              Creează playlist
            </Button>
            {res ? <LabProviderBadge provider={res.provider} /> : null}
          </div>
        </div>
      </LabCard>

      {loading ? (
        <LabCard title="Se interpretează descrierea…">
          <div className="space-y-2" aria-busy="true">
            <Skeleton className="h-5 w-2/3" />
            <Skeleton className="h-24 rounded-xl" />
            <Skeleton className="h-40 rounded-xl" />
          </div>
        </LabCard>
      ) : null}

      {error ? (
        <div role="alert" className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
          {error}
          <Button variant="outline" size="sm" className="ml-3 h-8" onClick={() => void generate()}>
            Reîncearcă
          </Button>
        </div>
      ) : null}

      {showLogin && !user ? (
        <LabLoginPrompt
          title="Salvează playlist-ul în contul tău"
          message="Playlist-urile AI salvate rămân în colecția ta și le poți redeschide oricând — conectează-te și apasă din nou «Salvează»."
        />
      ) : null}

      {res && interpreted ? (
        <div className="space-y-4">
          {/* Interpretarea AI */}
          <LabCard title="Cum a înțeles AI-ul descrierea">
            <div className="flex flex-wrap items-center gap-2">
              {interpreted.title ? (
                <span className="rounded-full border border-fuchsia-500/30 bg-fuchsia-500/10 px-2.5 py-1 text-[11px] font-bold text-fuchsia-300">
                  titlu: {interpreted.title}
                </span>
              ) : null}
              {interpreted.mood ? (
                <span className="rounded-full border border-violet-500/30 bg-violet-500/10 px-2.5 py-1 text-[11px] font-bold text-violet-300">
                  mood: {interpreted.mood}
                </span>
              ) : null}
              {interpreted.genres.map((g) => (
                <span key={g} className="rounded-full border border-rose-500/30 bg-rose-500/10 px-2.5 py-1 text-[11px] font-semibold text-rose-300">
                  {g}
                </span>
              ))}
              {interpreted.types.map((t) => (
                <span key={t} className="rounded-full border border-teal-500/30 bg-teal-500/10 px-2.5 py-1 text-[11px] font-semibold text-teal-300">
                  {t}
                </span>
              ))}
              {interpreted.keywords.map((k) => (
                <span key={k} className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-[11px] font-medium text-amber-300">
                  „{k}"
                </span>
              ))}
              {interpreted.maxItems != null ? (
                <span className="rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1 text-[11px] text-zinc-400">
                  max {interpreted.maxItems} itemi
                </span>
              ) : null}
            </div>
          </LabCard>

          {/* Playlist + itemi */}
          <LabCard title="Playlist-ul generat">
            <div className="mb-3 rounded-xl border border-white/10 bg-white/[0.02] p-3.5">
              <p className="text-base font-black text-white">{res.playlist.title}</p>
              <p className="mt-0.5 text-sm leading-relaxed text-zinc-400">{res.playlist.description}</p>
            </div>
            <LabItemGrid items={res.items} empty="Niciun titlu nu s-a potrivit descrierii — încearcă alta." />
            <Button
              onClick={() => void save()}
              disabled={saving || res.items.length === 0}
              className="mt-3 h-11 bg-emerald-600 font-bold hover:bg-emerald-500"
            >
              {saving ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden /> : <Save className="mr-1.5 h-4 w-4" aria-hidden />}
              Salvează în colecția mea
            </Button>
          </LabCard>
        </div>
      ) : null}

      {/* Listele salvate */}
      {user ? (
        <LabCard title="Playlist-urile mele AI">
          {listsRes.loading && !listsRes.data ? (
            <div className="space-y-2" aria-busy="true">
              <Skeleton className="h-16 rounded-xl" />
              <Skeleton className="h-16 rounded-xl" />
            </div>
          ) : listsRes.error ? (
            <p className="text-sm text-zinc-500">
              Listele nu au putut fi încărcate.{' '}
              <button type="button" onClick={() => void listsRes.refetch()} className="font-semibold text-rose-300 underline underline-offset-2">
                Reîncearcă
              </button>
            </p>
          ) : listsRes.data && listsRes.data.lists.length > 0 ? (
            <div className="space-y-2">
              {listsRes.data.lists.map((l) => (
                <SavedListRow key={l.id} list={l} />
              ))}
            </div>
          ) : (
            <p className="py-2 text-sm text-zinc-500">
              Niciun playlist AI salvat încă — creează unul mai sus și apasă „Salvează în colecția mea".
            </p>
          )}
        </LabCard>
      ) : (
        <LabNote>
          ✨ Playlist-urile AI salvate rămân în contul tău. Conectează-te pentru a-ți păstra colecția.
        </LabNote>
      )}
    </div>
  );
}

function SavedListRow({
  list,
}: {
  list: { id: number; title: string; description: string; itemIds: number[]; createdAt: string };
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.02]">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex min-h-11 w-full items-center gap-3 p-3 text-left transition hover:bg-white/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/60"
      >
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-bold text-zinc-100">{list.title}</p>
          <p className="truncate text-[11px] text-zinc-500">
            {list.itemIds.length} titluri · {formatDate(list.createdAt)}
          </p>
        </div>
        <ChevronDown className={cn('h-4 w-4 shrink-0 text-zinc-500 transition-transform', open && 'rotate-180')} aria-hidden />
      </button>
      {open ? (
        <div className="space-y-2 border-t border-white/5 p-3">
          {list.description ? <p className="text-xs leading-relaxed text-zinc-400">{list.description}</p> : null}
          <div className="custom-scrollbar flex max-h-32 flex-wrap gap-1.5 overflow-y-auto">
            {list.itemIds.map((id) => (
              <button
                key={id}
                type="button"
                onClick={() => navigate(`/content/${id}`)}
                className="min-h-9 rounded-full border border-white/15 bg-white/[0.03] px-2.5 text-[11px] font-semibold text-zinc-300 transition hover:border-rose-500/40 hover:text-rose-200"
                aria-label={`Deschide titlul #${id}`}
              >
                #{id}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
