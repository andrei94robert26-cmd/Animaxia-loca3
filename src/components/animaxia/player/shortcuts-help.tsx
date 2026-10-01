'use client';

/**
 * shortcuts-help.tsx — FAZA 34 (PLAN 100X · WS4): overlay „Comenzi rapide".
 *
 * Dialog onest cu trei grupuri: comenzile globale ale platformei, comenzile
 * playerului protejat FAZA 17/19 (etichetate ca integrate — nu le gestionăm
 * noi) și extensiile FAZA 34 (viteză / subtitrări / minimizare în dock),
 * gestionate de PlayerExperienceHost. Nota de subsol este onestă despre
 * faptul că scurtăturile extinse funcționează doar pe redarea nativă.
 *
 * ZERO atingeri ale playerului protejat — componentă pur prezentatională.
 */

import { Keyboard } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded border border-white/20 bg-white/10 px-1.5 py-0.5 font-mono text-[11px] text-zinc-200">
      {children}
    </kbd>
  );
}

interface ShortcutRow {
  keys: string[];
  label: string;
}

const GROUPS: { title: string; hint?: string; rows: ShortcutRow[] }[] = [
  {
    title: 'Global',
    rows: [
      { keys: ['⌘K', 'Ctrl+K'], label: 'Căutare rapidă (paleta globală)' },
      { keys: ['?'], label: 'Acest ajutor' },
      { keys: ['Esc'], label: 'Închide dialoguri' },
    ],
  },
  {
    title: 'Player (integrat)',
    hint: 'Comenzile native ale playerului Animaxia — funcționează pe suprafața playerului.',
    rows: [
      { keys: ['Space', 'K'], label: 'Redare / pauză' },
      { keys: ['←', '→', 'J', 'L'], label: '±10 secunde' },
      { keys: ['↑', '↓'], label: 'Volum' },
      { keys: ['F'], label: 'Ecran complet' },
      { keys: ['M'], label: 'Mut' },
    ],
  },
  {
    title: 'Extinse (FAZA 34)',
    hint: 'Adăugate de stratul de experiență — disponibile pe pagina playerului.',
    rows: [
      { keys: [','], label: 'Viteză −0,25×' },
      { keys: ['.'], label: 'Viteză +0,25×' },
      { keys: ['C'], label: 'Subtitrări pornit / oprit' },
      { keys: ['N'], label: 'Minimizează în dock (redarea continuă)' },
    ],
  },
];

export function ShortcutsHelp({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto border-white/10 bg-zinc-950/95 sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-lg font-bold text-white">
            <span className="grid h-8 w-8 place-items-center rounded-xl bg-gradient-to-br from-rose-500/30 to-fuchsia-500/30">
              <Keyboard className="h-4 w-4 text-rose-300" aria-hidden />
            </span>
            Comenzi rapide
          </DialogTitle>
          <DialogDescription className="text-sm text-zinc-400">
            Tot ce poți face de la tastatură pe Animaxia.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          {GROUPS.map((group) => (
            <section key={group.title} aria-label={`Comenzi ${group.title}`}>
              <h3 className="mb-2 text-[11px] font-bold uppercase tracking-widest text-zinc-500">
                {group.title}
              </h3>
              {group.hint && <p className="mb-2 text-xs text-zinc-500">{group.hint}</p>}
              <ul className="space-y-1.5">
                {group.rows.map((row) => (
                  <li
                    key={row.label}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2"
                  >
                    <span className="text-sm text-zinc-300">{row.label}</span>
                    <span className="flex items-center gap-1">
                      {row.keys.map((key) => (
                        <Kbd key={key}>{key}</Kbd>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}

          <p className="rounded-xl border border-white/10 bg-white/[0.02] p-3 text-xs leading-relaxed text-zinc-500">
            Comenzile extinse funcționează pe redarea nativă (mp4/HLS).
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
