/**
 * playerx-capture.ts — FAZA 34 (PLAN 100X · WS4): captură module-level pentru
 * auto-dock-ul la navigarea în interiorul SPA.
 *
 * DE CE MODULE-LEVEL: router-ul (`useRoute` din page.tsx) își re-randează
 * copacul la hashchange; React demontează PlayerView ÎMPREUNĂ cu ascultătorii
 * înregistrați în effect-ele componentei ÎNAINTE ca aceștia să ruleze dacă
 * flush-ul are loc sincron în listener-ul routerului (înregistrat primul la
 * montarea aplicației). Un ascultător înregistrat LA IMPORT — deci înainte de
 * orice montare — rulează ÎNTOTDEAUNA înaintea celui al routerului, deci
 * video-ul protejat este încă în DOM și poate fi citit cu exactitate.
 *
 * DE CE `window.__playerxCapture` (nu closure de modul): în dev, Fast Refresh
 * poate crea o instanță nouă de modul; listener-ul rămas înregistrat ar închide
 * peste variabilele VECIULUI modul (niciodată actualizate de codul nou). O
 * singură stare globală pe `window` e partajată de toate instanțele — HMR-safe
 * și identică în producție (o singură instanță oricum).
 *
 * Stratul e complet aditiv: playerul protejat FAZA 17 nu se atinge; hostul
 * (`experience-host.tsx`) doar actualizează snapshot-ul live la fiecare
 * `timeupdate`, iar `mini-dock.tsx` înregistrează handler-ul care face
 * dock-uirea propriu-zisă (rezolvarea sursei + `minimizeToDock`).
 */

export interface PlayerxCaptureSnapshot {
  contentId: number;
  /** Poziția la ultimul eveniment de redare (secunde). */
  currentTime: number;
  /** `currentSrc` pentru potrivirea directă a sursei (mp4); `blob:` = hls.js. */
  currentSrc: string;
  playing: boolean;
}

/** Indiciul indexului sursei active (chip-ul `aria-pressed` din comutator). */
export interface PlayerxCaptureExact extends PlayerxCaptureSnapshot {
  /** Index în lista `sources` a API-ului de player; −1 = necunoscut. */
  sourceIndexHint: number;
}

interface PlayerxCaptureState {
  snapshot: PlayerxCaptureSnapshot | null;
  handler: ((snap: PlayerxCaptureExact) => void) | null;
  lastCapture: { contentId: number; at: number };
}

declare global {
  interface Window {
    __playerxCapture?: PlayerxCaptureState;
    __playerxCaptureInit?: boolean;
  }
}

/** Starea partajată — o singură per pagină, indiferent de instanțele de modul. */
function state(): PlayerxCaptureState {
  if (typeof window === 'undefined') {
    /* SSR: obiect temporar inert (nu se înregistrează niciodată listener). */
    return { snapshot: null, handler: null, lastCapture: { contentId: -1, at: 0 } };
  }
  if (!window.__playerxCapture) {
    window.__playerxCapture = { snapshot: null, handler: null, lastCapture: { contentId: -1, at: 0 } };
  }
  return window.__playerxCapture;
}

/** Hostul actualizează snapshot-ul la fiecare eveniment de redare. */
export function updateCaptureSnapshot(next: PlayerxCaptureSnapshot | null): void {
  state().snapshot = next;
}

/** Dedupe: aceeași captură în <3s e ignorată (explicit + auto). */
export function markCaptured(contentId: number): void {
  state().lastCapture = { contentId, at: Date.now() };
}

export function recentlyCaptured(contentId: number): boolean {
  const lc = state().lastCapture;
  return lc.contentId === contentId && Date.now() - lc.at < 3000;
}

/** `mini-dock.tsx` înregistrează handler-ul (are acces la `usePlayerDock`). */
export function setCaptureHandler(fn: ((snap: PlayerxCaptureExact) => void) | null): void {
  state().handler = fn;
}

/** `#/player/:id` pentru același conținut? (navigarea rămâne pe scena principală) */
function samePlayerRoute(hash: string, contentId: number): boolean {
  const m = /^#\/player\/(\d+)/.exec(hash);
  return m != null && Number(m[1]) === contentId;
}

/** Citește indexul chip-ului activ din comutatorul de surse al playerului. */
function readSourceIndexHint(): number {
  const host = document.querySelector('[data-playerx-host]');
  if (!host) return -1;
  const group = host.querySelector('div[role="group"][aria-label="Surse de stream"]');
  if (!group) return -1;
  const buttons = Array.from(group.querySelectorAll('button'));
  const active = buttons.findIndex((b) => b.getAttribute('aria-pressed') === 'true');
  return active;
}

if (typeof window !== 'undefined' && !window.__playerxCaptureInit) {
  window.__playerxCaptureInit = true;
  window.addEventListener('hashchange', () => {
    const s = state();
    const snap = s.snapshot;
    if (!snap || !snap.playing) return;
    /* Rămânem pe playerul aceluiași titlu → scena principală continuă. */
    if (samePlayerRoute(window.location.hash, snap.contentId)) return;
    if (recentlyCaptured(snap.contentId)) return;

    /* Acest ascultător rulează ÎNAINTE de re-randarea React: video-ul și
       chip-urile de surse sunt încă în DOM — citim poziția exactă. */
    let exact: PlayerxCaptureExact = { ...snap, sourceIndexHint: -1 };
    const video = document.querySelector('[data-playerx-host] video') as HTMLVideoElement | null;
    if (video && !video.paused && !video.ended) {
      exact = {
        ...snap,
        currentTime: video.currentTime,
        currentSrc: video.currentSrc || video.src || snap.currentSrc,
        sourceIndexHint: readSourceIndexHint(),
      };
    }
    markCaptured(exact.contentId);
    s.handler?.(exact);
  });
}
