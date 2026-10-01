'use client';

/**
 * subtitle-studio.tsx — FAZA 34 (PLAN 100X · WS4): Studio de subtitrări.
 *
 * Strat 100% aditiv peste playerul protejat FAZA 17: stilizează subtitrările
 * WebVTT reale prin pseudo-elementul `video::cue` (font, mărime, culoare text,
 * fundal + opacitate, efect muchie) plus poziția (jos/sus + margine) prin
 * `video::-webkit-media-text-track-display` — suportat doar în Chromium;
 * Firefox ignoră regula onest, subtitrările rămân la stilul nativ.
 *
 * Persistență: localStorage `animaxia-subtitle-style-v1` imediat +, pentru
 * utilizatorii autentificați, PUT /api/playerx/subtitle-settings (backend
 * FAZA-34-a; dacă endpointul 404 încă, sincronizarea cloud se degradează
 * onest la un indiciu discret — setările rămân salvate local).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Captions, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/animaxia/api';
import {
  DEFAULT_PLAYERX_SUBTITLE_SETTINGS,
  type PlayerxSubtitleSettings,
} from '@/lib/animaxia/types';
import { useAuth } from '@/components/animaxia/auth-provider';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Slider } from '@/components/ui/slider';
import { cn } from '@/lib/utils';

/* ------------------------------- constants -------------------------------- */

const STORAGE_KEY = 'animaxia-subtitle-style-v1';
const STYLE_ELEMENT_ID = 'animaxia-subtitle-style';

const FONT_FAMILIES: PlayerxSubtitleSettings['fontFamily'][] = [
  'sans-serif',
  'serif',
  'monospace',
  'Trebuchet MS',
  'Verdana',
  'Georgia',
  'Comic Sans MS',
];

const FONT_LABELS: Record<PlayerxSubtitleSettings['fontFamily'], string> = {
  'sans-serif': 'Sans-serif (implicit)',
  serif: 'Serif',
  monospace: 'Monospace',
  'Trebuchet MS': 'Trebuchet MS',
  Verdana: 'Verdana',
  Georgia: 'Georgia',
  'Comic Sans MS': 'Comic Sans MS',
};

/** Swatch-uri text — ROZ în loc de albastru (design system: doar accente rose).
 *  #79c0ff (albastru) este interzis pe acest proiect. */
const TEXT_SWATCHES: { color: string; label: string }[] = [
  { color: '#ffffff', label: 'Alb' },
  { color: '#ffe066', label: 'Galben' },
  { color: '#7ee787', label: 'Verde' },
  { color: '#f472b6', label: 'Roz' },
  { color: '#f97316', label: 'Portocaliu' },
];

/** Swatch-uri fundal + opțiunea „fără fundal" (opacitate 0). */
const BG_SWATCHES: { color: string; label: string }[] = [
  { color: '#000000', label: 'Negru' },
  { color: '#1a1a2e', label: 'Bleumarin închis' },
  { color: '#2d1b2d', label: 'Mov închis' },
];

/* -------------------------------- helpers --------------------------------- */

function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value.trim());
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Validează un obiect arbitrar și îl fuzionează peste defaults — rezistent
 *  la payload-uri corupte/parțiale (la fel ca player-settings.ts). */
export function sanitizeSubtitleSettings(input: unknown): PlayerxSubtitleSettings {
  const merged: PlayerxSubtitleSettings = { ...DEFAULT_PLAYERX_SUBTITLE_SETTINGS };
  if (typeof input !== 'object' || input === null) return merged;
  const raw = input as Record<string, unknown>;
  if (FONT_FAMILIES.includes(raw.fontFamily as PlayerxSubtitleSettings['fontFamily'])) {
    merged.fontFamily = raw.fontFamily as PlayerxSubtitleSettings['fontFamily'];
  }
  merged.fontSizePct = clampNumber(raw.fontSizePct, 50, 250, DEFAULT_PLAYERX_SUBTITLE_SETTINGS.fontSizePct);
  if (isHexColor(raw.textColor)) merged.textColor = raw.textColor.trim();
  if (isHexColor(raw.bgColor)) merged.bgColor = raw.bgColor.trim();
  merged.bgOpacity = clampNumber(raw.bgOpacity, 0, 1, DEFAULT_PLAYERX_SUBTITLE_SETTINGS.bgOpacity);
  if (raw.edge === 'none' || raw.edge === 'shadow' || raw.edge === 'outline') merged.edge = raw.edge;
  if (raw.position === 'bottom' || raw.position === 'top') merged.position = raw.position;
  merged.marginPct = clampNumber(raw.marginPct, 0, 20, DEFAULT_PLAYERX_SUBTITLE_SETTINGS.marginPct);
  return merged;
}

/** Citește setările din localStorage (fallback: defaults). */
export function loadSubtitleSettings(): PlayerxSubtitleSettings {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_PLAYERX_SUBTITLE_SETTINGS };
    return sanitizeSubtitleSettings(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_PLAYERX_SUBTITLE_SETTINGS };
  }
}

function persistSubtitleSettings(settings: PlayerxSubtitleSettings): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* storage indisponibil (mod privat) — stilul se aplică oricum în sesiune */
  }
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return { r: 0, g: 0, b: 0 };
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/** CSS font-family: familiile generice rămân ne-citate (altfel ar deveni nume
 *  custom), cele cu spații se citează. */
function cssFontStack(family: PlayerxSubtitleSettings['fontFamily']): string {
  if (family === 'sans-serif' || family === 'serif' || family === 'monospace') {
    return `${family}, sans-serif`;
  }
  return `"${family}", sans-serif`;
}

function cssTextShadow(edge: PlayerxSubtitleSettings['edge']): string {
  if (edge === 'shadow') return '0 0 4px rgba(0, 0, 0, 0.9)';
  if (edge === 'outline') {
    /* Hack contur: 4 umbre în cele 4 direcții (text-shadow nu are outline). */
    return [
      '-1px -1px 0 rgba(0, 0, 0, 0.9)',
      '1px -1px 0 rgba(0, 0, 0, 0.9)',
      '-1px 1px 0 rgba(0, 0, 0, 0.9)',
      '1px 1px 0 rgba(0, 0, 0, 0.9)',
    ].join(', ');
  }
  return 'none';
}

/* --------------------------- the ::cue style API --------------------------- */

/**
 * Aplică idempotent stilul subtitrărilor printr-un SINGUR element
 * `<style id="animaxia-subtitle-style">` din document.head. Reapelarea cu
 * alte setări doar rescrie textContent — zero duplicate.
 */
export function applySubtitleStyle(s: PlayerxSubtitleSettings): void {
  if (typeof document === 'undefined') return;
  let el = document.getElementById(STYLE_ELEMENT_ID) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement('style');
    el.id = STYLE_ELEMENT_ID;
    document.head.appendChild(el);
  }
  const settings = sanitizeSubtitleSettings(s);
  const { r, g, b } = hexToRgb(settings.bgColor);
  const opacity = Math.min(1, Math.max(0, settings.bgOpacity));

  /* Marginea: {marginPct}% din ~40px (înălțimea tipică a unei linii de cue)
     → px, aplicată ca translateY pe display-ul de cue. */
  const marginPx = (settings.marginPct / 100) * 40;

  const lines: string[] = [
    'video::cue {',
    `  font-family: ${cssFontStack(settings.fontFamily)};`,
    `  font-size: ${Math.round(settings.fontSizePct)}%;`,
    `  color: ${settings.textColor};`,
    `  background: rgba(${r}, ${g}, ${b}, ${opacity.toFixed(2)});`,
    `  text-shadow: ${cssTextShadow(settings.edge)};`,
    '}',
    '/* Poziționare cue — doar Chromium (::-webkit-media-text-track-*);',
    '   Firefox ignoră onest aceste reguli. */',
  ];
  if (settings.position === 'top') {
    lines.push(
      'video::-webkit-media-text-track-container { top: 0; bottom: auto; }',
      `video::-webkit-media-text-track-display { transform: translateY(${marginPx.toFixed(1)}px); }`,
    );
  } else {
    lines.push(
      `video::-webkit-media-text-track-display { transform: translateY(-${marginPx.toFixed(1)}px); }`,
    );
  }
  el.textContent = lines.join('\n');
}

/* ------------------------------ shared preview ----------------------------- */

/** Stiluri inline EXACT echivalente cu ::cue-ul generat (același font stack,
 *  aceeași culoare/fundal/umbări) — folosite de preview-ul live. */
function previewCueStyles(s: PlayerxSubtitleSettings): React.CSSProperties {
  const { r, g, b } = hexToRgb(s.bgColor);
  return {
    fontFamily: cssFontStack(s.fontFamily),
    /* cqh = 1% din înălțimea containerului de preview; ::cue 100% ≈ 5% din
       înălțimea video-ului în Chromium → font-size preview = 5cqh la 100%. */
    fontSize: `calc(${Math.round(s.fontSizePct)} * 0.05cqh)`,
    color: s.textColor,
    background: `rgba(${r}, ${g}, ${b}, ${Math.min(1, Math.max(0, s.bgOpacity)).toFixed(2)})`,
    textShadow: cssTextShadow(s.edge),
  };
}

function CuePreview({ settings }: { settings: PlayerxSubtitleSettings }) {
  const marginPx = (settings.marginPct / 100) * 40;
  return (
    <div
      aria-hidden
      /* container-type: size face cqh-ul rezolvabil în interior. */
      style={{ containerType: 'size' }}
      className="relative aspect-video w-full overflow-hidden rounded-xl border border-white/10"
    >
      {/* Fundal „video" static — gradient cinematic, fără conținut real. */}
      <div className="absolute inset-0 bg-[linear-gradient(135deg,#1a1030_0%,#2d1b3d_35%,#0f0a1a_70%,#241530_100%)]" />
      <div className="absolute left-1/2 top-[38%] h-16 w-16 -translate-x-1/2 rounded-full bg-gradient-to-br from-rose-500/50 to-fuchsia-600/40 blur-md" />
      <p
        className="absolute left-1/2 w-max max-w-[92%] -translate-x-1/2 whitespace-nowrap px-1 text-center leading-normal"
        style={{
          ...previewCueStyles(settings),
          ...(settings.position === 'top'
            ? { top: `calc(2.5% + ${marginPx.toFixed(1)}px)` }
            : { bottom: `calc(2.5% + ${marginPx.toFixed(1)}px)` }),
        }}
      >
        Așa vor arăta subtitrările tale
      </p>
    </div>
  );
}

/* --------------------------------- studio ---------------------------------- */

type CloudState = 'idle' | 'saving' | 'saved' | 'unavailable' | 'local-only';

export function SubtitleStudio({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { user } = useAuth();
  const [settings, setSettings] = useState<PlayerxSubtitleSettings>(DEFAULT_PLAYERX_SUBTITLE_SETTINGS);
  const [hydrated, setHydrated] = useState(false);
  const [cloud, setCloud] = useState<CloudState>('idle');
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* La deschidere: localStorage, apoi — dacă există sesiune — GET setările din
     profil și fuzionează-le peste cele locale (backend > local, per contract).
     401/404/network → rămân cele locale, cu un indiciu discret. */
  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    (async () => {
      setCloud('idle');
      const local = loadSubtitleSettings();
      setSettings(local);
      setHydrated(true);
      applySubtitleStyle(local);
      if (user) {
        try {
          const res = await api.playerxGetSubtitleSettings();
          if (cancelled) return;
          if (res.settings) {
            const merged = sanitizeSubtitleSettings({ ...local, ...res.settings });
            setSettings(merged);
            applySubtitleStyle(merged);
          }
        } catch {
          if (!cancelled) setCloud('local-only');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, user]);

  /* Orice schimbare (după hidratare): aplică live + persistă local imediat;
     PUT cloud debounced 900ms doar pentru utilizatori autentificați. */
  useEffect(() => {
    if (!hydrated) return undefined;
    applySubtitleStyle(settings);
    persistSubtitleSettings(settings);
    if (!user) return undefined;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      setCloud('saving');
      api
        .playerxSaveSubtitleSettings(settings)
        .then(() => setCloud('saved'))
        .catch(() => setCloud('unavailable'));
    }, 900);
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [settings, hydrated, user]);

  const patch = useCallback((p: Partial<PlayerxSubtitleSettings>) => {
    setSettings((prev) => sanitizeSubtitleSettings({ ...prev, ...p }));
  }, []);

  const reset = () => {
    setSettings({ ...DEFAULT_PLAYERX_SUBTITLE_SETTINGS });
    toast.info('Subtitrările au fost resetate la valorile implicite');
  };

  const swatchBtn =
    'h-8 w-8 rounded-lg border transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/70';

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 overflow-y-auto border-white/10 bg-zinc-950/95 p-0 sm:max-w-md"
      >
        <SheetHeader className="border-b border-white/10">
          <SheetTitle className="flex items-center gap-2 text-lg font-bold text-white">
            <span className="grid h-8 w-8 place-items-center rounded-xl bg-gradient-to-br from-rose-500/30 to-fuchsia-500/30">
              <Captions className="h-4 w-4 text-rose-300" aria-hidden />
            </span>
            Studio de subtitrări
          </SheetTitle>
          <SheetDescription className="text-xs leading-relaxed text-zinc-400">
            Personalizează cum arată subtitrările. Se aplică live pe video-ul care
            rulează acum (efect <code className="font-mono text-[11px] text-zinc-300">::cue</code>).
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 space-y-6 p-4">
          {/* Preview live */}
          <section aria-label="Previzualizare live">
            <CuePreview settings={settings} />
            <p className="mt-2 text-[11px] text-zinc-500">
              Previzualizare aproximativă — video-ul real poate scala diferit.
            </p>
          </section>

          {/* Font */}
          <section className="space-y-2" aria-label="Font">
            <div className="flex items-center justify-between">
              <label htmlFor="subtitle-font" className="text-xs font-semibold uppercase tracking-widest text-zinc-500">
                Font
              </label>
            </div>
            <Select value={settings.fontFamily} onValueChange={(v) => patch({ fontFamily: v as PlayerxSubtitleSettings['fontFamily'] })}>
              <SelectTrigger
                id="subtitle-font"
                className="w-full border-white/10 bg-black/40 text-sm text-zinc-200 focus-visible:ring-rose-500/60"
              >
                <SelectValue placeholder="Alege fontul" />
              </SelectTrigger>
              <SelectContent className="border-white/10 bg-zinc-950">
                {FONT_FAMILIES.map((f) => (
                  <SelectItem key={f} value={f} style={{ fontFamily: cssFontStack(f) }}>
                    {FONT_LABELS[f]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </section>

          {/* Mărime */}
          <section className="space-y-2" aria-label="Mărime text">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-widest text-zinc-500">Mărime</span>
              <span className="rounded-md border border-white/10 bg-white/5 px-2 py-0.5 font-mono text-[11px] text-zinc-300">
                {Math.round(settings.fontSizePct)}%
              </span>
            </div>
            <Slider
              value={[settings.fontSizePct]}
              min={50}
              max={250}
              step={5}
              onValueChange={(v) => patch({ fontSizePct: v[0] })}
              aria-label="Mărime text subtitrări"
              className="focus-visible:ring-rose-500/60"
            />
          </section>

          {/* Culoare text */}
          <section className="space-y-2" aria-label="Culoare text">
            <span className="text-xs font-semibold uppercase tracking-widest text-zinc-500">Culoare text</span>
            <div className="flex flex-wrap items-center gap-2">
              {TEXT_SWATCHES.map((sw) => (
                <button
                  key={sw.color}
                  type="button"
                  onClick={() => patch({ textColor: sw.color })}
                  title={sw.label}
                  aria-label={`Culoare text ${sw.label}`}
                  aria-pressed={settings.textColor.toLowerCase() === sw.color}
                  className={cn(swatchBtn, settings.textColor.toLowerCase() === sw.color ? 'border-rose-500 ring-2 ring-rose-500/60' : 'border-white/15 hover:border-white/40')}
                  style={{ background: sw.color }}
                />
              ))}
              <label className="sr-only" htmlFor="subtitle-text-hex">Cod hex personalizat pentru culoarea textului</label>
              <Input
                id="subtitle-text-hex"
                value={settings.textColor}
                onChange={(e) => patch({ textColor: e.target.value })}
                placeholder="#ffffff"
                aria-label="Culoare text (hex)"
                className="h-8 w-24 border-white/10 bg-black/40 font-mono text-xs text-zinc-200 focus-visible:ring-rose-500/60"
              />
            </div>
          </section>

          {/* Fundal */}
          <section className="space-y-2" aria-label="Fundal">
            <span className="text-xs font-semibold uppercase tracking-widest text-zinc-500">Fundal</span>
            <div className="flex flex-wrap items-center gap-2">
              {BG_SWATCHES.map((sw) => (
                <button
                  key={sw.color}
                  type="button"
                  onClick={() => patch({ bgColor: sw.color })}
                  title={sw.label}
                  aria-label={`Fundal ${sw.label}`}
                  aria-pressed={settings.bgColor.toLowerCase() === sw.color}
                  className={cn(swatchBtn, settings.bgColor.toLowerCase() === sw.color ? 'border-rose-500 ring-2 ring-rose-500/60' : 'border-white/15 hover:border-white/40')}
                  style={{ background: sw.color }}
                />
              ))}
              <button
                type="button"
                onClick={() => patch({ bgOpacity: 0 })}
                title="Fără fundal (transparent)"
                aria-label="Fără fundal"
                aria-pressed={settings.bgOpacity === 0}
                className={cn(
                  swatchBtn,
                  'grid place-items-center bg-[repeating-conic-gradient(#52525b_0%_25%,#27272a_0%_50%)] bg-[length:10px_10px] text-[9px] font-bold text-zinc-300',
                  settings.bgOpacity === 0 ? 'border-rose-500 ring-2 ring-rose-500/60' : 'border-white/15 hover:border-white/40',
                )}
              >
                ✕
              </button>
            </div>
            <div className="flex items-center justify-between pt-1">
              <span className="text-xs text-zinc-500">Opacitate fundal</span>
              <span className="rounded-md border border-white/10 bg-white/5 px-2 py-0.5 font-mono text-[11px] text-zinc-300">
                {Math.round(settings.bgOpacity * 100)}%
              </span>
            </div>
            <Slider
              value={[settings.bgOpacity]}
              min={0}
              max={1}
              step={0.05}
              onValueChange={(v) => patch({ bgOpacity: v[0] })}
              aria-label="Opacitate fundal subtitrări"
              className="focus-visible:ring-rose-500/60"
            />
          </section>

          {/* Muchie */}
          <section className="space-y-2" aria-label="Efect muchie">
            <span className="text-xs font-semibold uppercase tracking-widest text-zinc-500">Muchie text</span>
            <Select value={settings.edge} onValueChange={(v) => patch({ edge: v as PlayerxSubtitleSettings['edge'] })}>
              <SelectTrigger
                aria-label="Efect muchie text"
                className="w-full border-white/10 bg-black/40 text-sm text-zinc-200 focus-visible:ring-rose-500/60"
              >
                <SelectValue placeholder="Alege efectul" />
              </SelectTrigger>
              <SelectContent className="border-white/10 bg-zinc-950">
                <SelectItem value="none">Fără efect</SelectItem>
                <SelectItem value="shadow">Umbră</SelectItem>
                <SelectItem value="outline">Contur</SelectItem>
              </SelectContent>
            </Select>
          </section>

          {/* Poziție */}
          <section className="space-y-2" aria-label="Poziție">
            <span className="text-xs font-semibold uppercase tracking-widest text-zinc-500">Poziție</span>
            <div
              role="group"
              aria-label="Poziția subtitrărilor"
              className="grid grid-cols-2 gap-2 rounded-xl border border-white/10 bg-white/[0.03] p-1"
            >
              {(['bottom', 'top'] as const).map((pos) => (
                <button
                  key={pos}
                  type="button"
                  onClick={() => patch({ position: pos })}
                  aria-pressed={settings.position === pos}
                  className={cn(
                    'rounded-lg px-3 py-1.5 text-xs font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/60',
                    settings.position === pos
                      ? 'bg-rose-600 text-white'
                      : 'text-zinc-400 hover:bg-white/10 hover:text-white',
                  )}
                >
                  {pos === 'bottom' ? 'Jos' : 'Sus'}
                </button>
              ))}
            </div>
            <div className="flex items-center justify-between pt-1">
              <span className="text-xs text-zinc-500">Margine</span>
              <span className="rounded-md border border-white/10 bg-white/5 px-2 py-0.5 font-mono text-[11px] text-zinc-300">
                {Math.round(settings.marginPct)}%
              </span>
            </div>
            <Slider
              value={[settings.marginPct]}
              min={0}
              max={20}
              step={1}
              onValueChange={(v) => patch({ marginPct: v[0] })}
              aria-label="Margine subtitrări"
              className="focus-visible:ring-rose-500/60"
            />
            <p className="text-[11px] text-zinc-600">
              Poziția și marginea funcționează în browserele Chromium (Chrome/Edge);
              Firefox folosește poziția nativă.
            </p>
          </section>

          {/* Reset + stare cloud */}
          <section className="space-y-3 border-t border-white/10 pt-4">
            <Button
              variant="outline"
              onClick={reset}
              className="w-full border-white/15 bg-white/5 font-semibold hover:bg-white/10"
            >
              <RotateCcw className="h-4 w-4" aria-hidden />
              Resetează la implicit
            </Button>
            <p className="min-h-4 text-[11px] leading-relaxed text-zinc-500" aria-live="polite">
              {user
                ? cloud === 'saving'
                  ? 'Se salvează în profilul tău…'
                  : cloud === 'saved'
                    ? 'Salvat local și în profilul tău Animaxia.'
                    : cloud === 'unavailable' || cloud === 'local-only'
                      ? 'Sincronizarea cloud nu este disponibilă încă pe acest server — setările sunt salvate local.'
                      : 'Setările se salvează local și în profilul tău.'
                : 'Setările se salvează local pe acest dispozitiv. Conectează-te pentru sincronizare în profil.'}
            </p>
          </section>
        </div>
      </SheetContent>
    </Sheet>
  );
}

/* ------------------------------ global applier ----------------------------- */

/**
 * Componentă null-render montată global în page.tsx: la încărcare și la orice
 * schimbare de sesiune rezolvă setările (backend dacă există sesiune, altfel
 * localStorage, fallback defaults) și aplică stilul ::cue pe TOATE video-urile.
 */
export function SubtitleStyleApplier() {
  const { user } = useAuth();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let settings = loadSubtitleSettings();
      if (user) {
        try {
          const res = await api.playerxGetSubtitleSettings();
          if (res.settings) {
            settings = sanitizeSubtitleSettings({ ...settings, ...res.settings });
          }
        } catch {
          /* 401/404/rețea — rămân setările locale */
        }
      }
      if (!cancelled) applySubtitleStyle(settings);
    })();
    return () => {
      cancelled = true;
    };
  }, [user]);

  return null;
}
