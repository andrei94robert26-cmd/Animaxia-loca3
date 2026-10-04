/**
 * menu.ts — Sidebar menu definition (single source of truth) + virtual
 * category catalog. Mirrors the platform sidebar exactly:
 *
 *   Principal: Acasă, Pentru Tine, Filme, Seriale, Anime, Copii & Desene
 *   AI Metadata: AI Hub (FAZA 16 — comutator live pentru cele 6 AI-uri noi),
 *               Ani, Genuri, Categorii, Studiouri, Actori, Colecții,
 *               Francize, Trilogii (FAZA 15 — values fetched from the
 *               /api/ai/home/metadata dimensions, rendered as collapsibles)
 *   Media: Telenovele
 *   Live: Sport, Distracție
 *   Cont: Lista Mea, Colecțiile Mele, Gestionare & Duplicate
 *   Universuri: Universuri, Marvel, DC, Blockbustere
 *   Canale Kids: Disney, Jetix, Fox Kids, Cartoon Network, Boomerang, Minimax
 *   Lumea — 196 țări: Europa, America de Nord, America de Sud, Asia, Africa, Oceania
 *
 * NOTE (curățare utilizator): secțiunile Muzică, Documentare, Gaming, Știri,
 * Radio Live, Divertisment, Show-biz, Reality TV și Emisiuni TV au fost
 * eliminate complet din platformă (meniuri, cod și conținutul aferent din
 * baza de date Neon), la cererea explicită a utilizatorului.
 *
 * Existing destinations from earlier fazas (Home, Movies, TV, Anime, Sports,
 * Franchises, For You) are preserved and regrouped; every other entry
 * is new and routed through the hash router (#/category/<slug>).
 */

import {
  Activity,
  Baby,
  BarChart3,
  Bookmark,
  Drama,
  Film,
  History,
  Home,
  Layers,
  ListVideo,
  Network,
  PartyPopper,
  Settings2,
  Sparkles,
  Sword,
  Swords,
  Trophy,
  Tv,
  type LucideIcon,
} from 'lucide-react';
import type { AppRoute } from './router';
import type { DbContent, MetaDimension } from './types';

/* --------------------------------- menu ---------------------------------- */

export interface MenuEntry {
  id: string;
  label: string;
  /** Emoji straight from the platform menu (universes, kids channels, show-biz, world). */
  emoji?: string;
  /** Lucide icon for entries without an emoji. */
  icon?: LucideIcon;
  href: string;
  match: (route: AppRoute | null) => boolean;
  /** FAZA 15 — entries of the 'ai-metadata' group carry their metadata
   *  dimension; the sidebar renders them as collapsibles whose value lists
   *  come from api.aiHome.metadata().dimensions[dim]. */
  metaDim?: MetaDimension;
}

export interface MenuGroup {
  id: string;
  label: string;
  entries: MenuEntry[];
}

function categoryEntry(id: string, label: string, icon?: LucideIcon, emoji?: string): MenuEntry {
  return {
    id,
    label,
    emoji,
    icon,
    href: `/category/${id}`,
    match: (r) => r?.view === 'category' && r.params[0] === id,
  };
}

/** FAZA 15 — AI Metadata entry: #/meta/<dim> (first value auto-selected). */
function metaEntry(dim: MetaDimension, label: string, emoji: string): MenuEntry {
  return {
    id: `meta-${dim}`,
    label,
    emoji,
    metaDim: dim,
    href: `/meta/${dim}`,
    match: (r) => r?.view === 'meta' && r.params[0] === dim,
  };
}

/* --------------------- FAZA 32: AI SUITE 100X entries --------------------- */

/** The 18 AI SUITE engines (mirrors modules/aisuite/common.js ENGINES).
 *  Each links to #/ai-suite/<key> and the sidebar renders the whole group
 *  as one collapsible (see sidebar.tsx) to keep the menu compact. */
export const AI_SUITE_ENGINES: Array<{ key: string; label: string; emoji: string }> = [
  { key: 'miner', label: 'AI Miner', emoji: '⛏️' },
  { key: 'metadata', label: 'AI Metadata Dashboard', emoji: '🏷️' },
  { key: 'analyzer', label: 'AI Analyzer Dashboard', emoji: '🔬' },
  { key: 'news', label: 'AI News Hub', emoji: '📰' },
  { key: 'social', label: 'AI Social Hub', emoji: '👥' },
  { key: 'watchparty', label: 'AI Watch Party', emoji: '🍿' },
  { key: 'recommendations', label: 'AI Recommendation Engine', emoji: '🎯' },
  { key: 'franchise', label: 'AI Franchise Engine', emoji: '🔗' },
  { key: 'taxonomy', label: 'AI Taxonomy Generator', emoji: '🌳' },
  { key: 'stats', label: 'AI Statistics Dashboard', emoji: '📊' },
  { key: 'infinite', label: 'AI Infinite Scroll Engine', emoji: '♾️' },
  { key: 'scanner', label: 'AI Content Scanner', emoji: '🩺' },
  { key: 'discovery', label: 'AI Source Discovery Engine', emoji: '🧭' },
  { key: 'duplicates', label: 'AI Duplicate Detector', emoji: '🧬' },
  { key: 'poster', label: 'AI Poster Scanner', emoji: '🖼️' },
  { key: 'trends', label: 'AI Trend Analyzer', emoji: '📈' },
  { key: 'feeds', label: 'AI External Feed Engine', emoji: '📡' },
  { key: 'admin', label: 'Dashboard Administrare AI', emoji: '🛠️' },
];

function suiteEntry(key: string, label: string, emoji: string): MenuEntry {
  return {
    id: `suite-${key}`,
    label,
    emoji,
    href: `/ai-suite/${key}`,
    match: (r) => r?.view === 'ai-suite' && r.params[0] === key,
  };
}

/* ---------------------- FAZA 35: AI LAB (WS5) entries ---------------------- */

/** The 8 AI LAB capabilities (mirrors modules/ai/lab — companion, recap,
 *  mood, shield, dubbing, curation, voice, editor). Each links to
 *  #/ai-lab/<key>; the sidebar renders the whole group as one collapsible
 *  (see sidebar.tsx), exactly like the AI SUITE group. */
export const AI_LAB_CAPS: Array<{ key: string; label: string; emoji: string }> = [
  { key: 'companion', label: 'AI Companion', emoji: '💬' },
  { key: 'recap', label: 'AI Recap', emoji: '⏪' },
  { key: 'mood', label: 'AI Mood Playlist', emoji: '🎭' },
  { key: 'shield', label: 'AI Spoiler Shield', emoji: '🛡️' },
  { key: 'dubbing', label: 'AI Dubbing', emoji: '🎙️' },
  { key: 'curation', label: 'AI Curation', emoji: '🎯' },
  { key: 'voice', label: 'AI Voice', emoji: '🎤' },
  { key: 'editor', label: 'AI Playlist Editor', emoji: '✨' },
];

function labEntry(key: string, label: string, emoji: string): MenuEntry {
  return {
    id: `lab-${key}`,
    label,
    emoji,
    href: `/ai-lab/${key}`,
    match: (r) => r?.view === 'ai-lab' && r.params[0] === key,
  };
}

/* --------------------- FAZA 36-R: PERSO (WS6) entries --------------------- */

/** Cele 4 taburi Personalizare (mirrors modules/perso — feed „Pentru Tine",
 *  profil de gust, profile multiple cu PIN, memento-uri). Fiecare trimite
 *  la #/perso/<key>; sidebar-ul randează grupul ca un singur collapsible
 *  (vezi sidebar.tsx), la fel ca grupurile AI Suite / AI Lab. */
export const PERSO_TABS: Array<{ key: string; label: string; emoji: string }> = [
  { key: 'feed', label: 'Pentru Tine', emoji: '✨' },
  { key: 'taste', label: 'Profil de gust', emoji: '🎭' },
  { key: 'profiles', label: 'Profile', emoji: '👥' },
  { key: 'reminders', label: 'Memento-uri', emoji: '⏰' },
];

function persoEntry(key: string, label: string, emoji: string): MenuEntry {
  return {
    id: `perso-${key}`,
    label,
    emoji,
    href: `/perso/${key}`,
    match: (r) => r?.view === 'perso' && (r.params[0] ?? 'feed') === key,
  };
}

export const MENU_GROUPS: MenuGroup[] = [
  {
    id: 'principal',
    label: 'Principal',
    entries: [
      { id: 'home', label: 'Acasă', icon: Home, href: '/home', match: (r) => !r || r.view === 'home' },
      {
        id: 'for-you',
        label: 'Pentru Tine',
        icon: Sparkles,
        href: '/recommendations',
        match: (r) => r?.view === 'recommendations',
      },
      { ...categoryEntry('movie', 'Filme', Film), match: (r) => r?.view === 'category' && r.params[0] === 'movie' },
      { ...categoryEntry('tv', 'Seriale', Tv), match: (r) => r?.view === 'category' && r.params[0] === 'tv' },
      { ...categoryEntry('anime', 'Anime', Sword), match: (r) => r?.view === 'category' && r.params[0] === 'anime' },
      categoryEntry('kids', 'Copii & Desene', Baby),
    ],
  },
  {
    /* FAZA 15 — values come live from the AI metadata extractor; the sidebar
       renders each entry as a collapsible with the dimension's value list.
       FAZA 16 — 'AI Hub' sits first in the group (plain link, no submenu). */
    id: 'ai-metadata',
    label: 'AI Metadata',
    entries: [
      {
        id: 'aihub',
        label: 'AI Hub',
        emoji: '🤖',
        href: '/aihub',
        match: (r) => r?.view === 'aihub',
      },
      metaEntry('year', 'Ani', '📅'),
      metaEntry('genre', 'Genuri', '🎭'),
      metaEntry('category', 'Categorii', '🗂️'),
      metaEntry('studio', 'Studiouri', '🏭'),
      metaEntry('actor', 'Actori', '🎬'),
      metaEntry('collection', 'Colecții', '📚'),
      metaEntry('franchise', 'Francize', '🔗'),
      metaEntry('trilogy', 'Trilogii', '🎞️'),
    ],
  },
  {
    /* FAZA 32 (AI SUITE 100X — cerință utilizator): 18 motoare AI noi.
     * Randat ca un singur grup collapsibil în sidebar (vezi sidebar.tsx). */
    id: 'ai-suite',
    label: 'AI Suite 100X',
    entries: AI_SUITE_ENGINES.map((e) => suiteEntry(e.key, e.label, e.emoji)),
  },
  {
    /* FAZA 35 (PLAN 100X · WS5 — AI LAB): 8 capabilități AI noi (companion,
     * recap, mood, shield, dubbing, curation, voice, editor). Randat ca un
     * singur grup collapsibil în sidebar (vezi sidebar.tsx). */
    id: 'ai-lab',
    label: 'AI Lab',
    entries: AI_LAB_CAPS.map((c) => labEntry(c.key, c.label, c.emoji)),
  },
  {
    /* FAZA 36-R (PLAN 100X · WS6 — PERSO): Personalizare & Recomandări 2.0 —
     * feed „Pentru Tine" cu secțiuni explicite, profil de gust învățat pasiv,
     * profile multiple cu PIN, memento-uri de încheiere. Grup collapsibil
     * (vezi sidebar.tsx); recomandările existente rămân neatinse. */
    id: 'perso',
    label: 'Personalizare',
    entries: PERSO_TABS.map((t) => persoEntry(t.key, t.label, t.emoji)),
  },
  {
    id: 'media',
    label: 'Media',
    entries: [
      categoryEntry('telenovelas', 'Telenovele', Drama),
    ],
  },
  {
    id: 'live',
    label: 'Live',
    entries: [
      { ...categoryEntry('sports', 'Sport', Trophy), match: (r) => r?.view === 'category' && r.params[0] === 'sports' },
      categoryEntry('fun', 'Distracție', PartyPopper),
    ],
  },
  {
    id: 'cont',
    label: 'Cont',
    entries: [
      /* FAZA 21 — istoric, playlist-uri și statistici personale (rute noi
         #/history, #/playlists, #/stats, la începutul grupului Cont). */
      {
        id: 'history',
        label: 'Istoric',
        icon: History,
        href: '/history',
        match: (r) => r?.view === 'history',
      },
      {
        id: 'playlists',
        label: 'Playlist-uri',
        icon: ListVideo,
        href: '/playlists',
        match: (r) => r?.view === 'playlists',
      },
      {
        id: 'mystats',
        label: 'Statisticile mele',
        icon: BarChart3,
        href: '/stats',
        match: (r) => r?.view === 'stats',
      },
      categoryEntry('my-list', 'Lista Mea', Bookmark),
      categoryEntry('my-collections', 'Colecțiile Mele', Layers),
      categoryEntry('manage', 'Gestionare & Duplicate', Settings2),
      {
        /* AR10M — „Arhitectura Reală": contori reali, capacitate declarată
           onest (proiectată 10M / testată / benchmark), sharduri reale. */
        id: 'scale',
        label: 'Arhitectura Reală',
        icon: Network,
        href: '/scale',
        match: (r) => r?.view === 'scale',
      },
      {
        /* FAZA 17 — live stress & stability lab (#/stability). */
        id: 'stability',
        label: 'Stres & Stabilitate',
        emoji: '🛡️',
        href: '/stability',
        match: (r) => r?.view === 'stability',
      },
      {
        /* FAZA 29 (2.0) — stare live platformă, sonde reale (#/status). */
        id: 'status',
        label: 'Stare Platformă',
        icon: Activity,
        href: '/status',
        match: (r) => r?.view === 'status',
      },
    ],
  },
  {
    id: 'universuri',
    label: 'Universuri',
    entries: [
      {
        id: 'franchise',
        label: 'Universuri',
        icon: Bookmark,
        href: '/franchise',
        match: (r) => r?.view === 'franchise',
      },
      {
        id: 'franchises',
        label: 'Francize',
        emoji: '🎬',
        href: '/franchises',
        match: (r) => r?.view === 'franchises',
      },
      {
        id: 'trilogies',
        label: 'Trilogii',
        emoji: '🎞️',
        href: '/trilogies',
        match: (r) => r?.view === 'trilogies',
      },
      categoryEntry('marvel', 'Marvel', undefined, '🦸'),
      categoryEntry('dc', 'DC', undefined, '🦇'),
      categoryEntry('blockbusters', 'Blockbustere', undefined, '💥'),
    ],
  },
  {
    id: 'canale-kids',
    label: 'Canale Kids',
    entries: [
      categoryEntry('disney', 'Disney', undefined, '🏰'),
      categoryEntry('jetix', 'Jetix', undefined, '⚡'),
      categoryEntry('foxkids', 'Fox Kids', undefined, '🦊'),
      categoryEntry('cartoon-network', 'Cartoon Network', undefined, '📺'),
      categoryEntry('boomerang', 'Boomerang', undefined, '🪃'),
      categoryEntry('minimax', 'Minimax', undefined, '🎈'),
      /* FAZA 32 (cerință utilizator): 8 canale noi — toate cu feed live TMDB
       * real (ID-uri de rețea verificate, vezi modules/discover/discover.js). */
      categoryEntry('nickelodeon', 'Nickelodeon', undefined, '🧽'),
      categoryEntry('disney-channel', 'Disney Channel', undefined, '🪄'),
      categoryEntry('nicktoons', 'Nicktoons', undefined, '🛸'),
      categoryEntry('cartoonito', 'Cartoonito', undefined, '🐰'),
      categoryEntry('disney-junior', 'Disney Junior', undefined, '🧸'),
      categoryEntry('nick-jr', 'Nick Jr.', undefined, '🌈'),
      categoryEntry('jimjam', 'JimJam', undefined, '🍼'),
      categoryEntry('duck-tv', 'Duck TV', undefined, '🦆'),
    ],
  },
  {
    id: 'lumea',
    label: 'Lumea — 196 țări',
    entries: [
      categoryEntry('europa', 'Europa', undefined, '🇪🇺'),
      categoryEntry('america-nord', 'America de Nord', undefined, '🌎'),
      categoryEntry('america-sud', 'America de Sud', undefined, '🌏'),
      categoryEntry('asia', 'Asia', undefined, '🏯'),
      categoryEntry('africa', 'Africa', undefined, '🌍'),
      categoryEntry('oceania', 'Oceania', undefined, '🏝️'),
    ],
  },
];

/* ---------------------------- virtual categories -------------------------- */
/*
 * New menu entries resolve to client-side filtered views over the Neon
 * library (fetched once via /api/all?limit=100). Filters receive the raw
 * DbContent row so metadata (genres, language, source) is available.
 */

export type ContentFilter = (row: DbContent) => boolean;

export interface VirtualCategory {
  slug: string;
  title: string;
  subtitle: string;
  filter: ContentFilter;
  /** Optional client-side sort (e.g. blockbusters by rating). */
  sort?: (a: DbContent, b: DbContent) => number;
  /** Extra hint rendered in the empty state. */
  emptyHint?: string;
  /** FAZA 14: category is backed by a LIVE /api/discover/:slug feed (real
   *  TMDB data). The library filter above still powers the “În biblioteca
   *  ta” row, while the live feed fills the main grid. */
  live?: boolean;
  /** Human description of the real live source (rendered as a badge). */
  liveSource?: string;
}

function genresOf(row: DbContent): string[] {
  const genres = row.metadata?.genres;
  return Array.isArray(genres) ? genres.map((g) => String(g).toLowerCase()) : [];
}

function genreMatch(row: DbContent, re: RegExp): boolean {
  return genresOf(row).some((g) => re.test(g));
}

function titleMatch(row: DbContent, re: RegExp): boolean {
  return re.test(row.title || '');
}

function sourceMatch(row: DbContent, re: RegExp): boolean {
  const md = row.metadata ?? {};
  const hay = [md.source, md.network, md.studio, md.channel]
    .flatMap((v) => (Array.isArray(v) ? v.map(String) : typeof v === 'string' ? [v] : []))
    .join(' ');
  return re.test(hay.toLowerCase());
}

function ratingOf(row: DbContent): number {
  const r = row.metadata?.rating ?? row.metadata?.score;
  return typeof r === 'number' ? r : 0;
}

/** Language → continent mapping for the "Lumea" group (TMDB original_language). */
const CONTINENT_LANGUAGES: Record<string, string[]> = {
  europa: ['fr', 'de', 'es', 'it', 'pl', 'ro', 'sv', 'nl', 'cs', 'hu', 'el', 'uk', 'da', 'fi', 'no', 'pt', 'ru', 'bg', 'hr', 'sr', 'sk', 'sl', 'lt', 'lv', 'et'],
  'america-nord': ['en', 'es-MX', 'fr-CA'],
  'america-sud': ['pt-BR', 'es-AR', 'es-CO', 'es-CL', 'es-PE', 'es-419', 'gn', 'qu'],
  asia: ['ja', 'ko', 'te', 'hi', 'zh', 'th', 'vi', 'id', 'tl', 'fa', 'he', 'ur', 'bn', 'ta', 'ml', 'kn', 'mr', 'gu', 'pa', 'si', 'km', 'my', 'ka', 'hy', 'az', 'kk', 'uz', 'mn'],
  africa: ['ar', 'sw', 'af', 'zu', 'ha', 'yo', 'ig', 'am', 'so', 'xh', 'sn', 'amh'],
  oceania: ['mi', 'sm', 'haw', 'fj', 'to', 'ty'],
};

function continentFilter(slug: string): ContentFilter {
  const langs = CONTINENT_LANGUAGES[slug] ?? [];
  return (row) => {
    const lang = String(row.metadata?.language ?? '').toLowerCase();
    if (lang && langs.includes(lang)) return true;
    const country = row.metadata?.country ?? row.metadata?.originCountry ?? row.metadata?.origin_country;
    if (country) {
      const list = Array.isArray(country) ? country.map(String) : [String(country)];
      if (list.some((c) => langs.includes(c.toLowerCase()))) return true;
    }
    return false;
  };
}

const MARVEL_RE =
  /marvel|avenger|spider.?man|iron.?man|captain.?america|thor|black.?panther|guardians.?of.?the.?galaxy|x.?men|deadpool|wolverine|hulk|doctor.?strange|ant.?man|venom|eternals|black.?widow|hawkeye|loki|moon.?knight|falcon|shang.?chi|captain.?marvel|ms.?marvel|she.?hulk|daredevil|punisher|jessica.?jones|luke.?cage|iron.?fist|agents.?of.?shield|fantastic.?four|silver.?surfer|blade/i;

const DC_RE =
  /\bdc\b|batman|superman|wonder.?woman|joker|aquaman|green.?lantern|shazam|black.?adam|harley|suicide.?squad|peacemaker|teen.?titans|supergirl|constantine|sandman|doom.?patrol|the.?batman|gotham|metropolis|krypton/i;

export const VIRTUAL_CATEGORIES: Record<string, VirtualCategory> = {
  kids: {
    slug: 'kids',
    title: 'Copii & Desene',
    subtitle: 'Desene animate, aventuri și titluri pentru toată familia.',
    filter: (row) => genreMatch(row, /animation|family|kids|children/i),
    live: true,
    liveSource: 'TMDB · Animație & Family',
  },
  telenovelas: {
    slug: 'telenovelas',
    title: 'Telenovele',
    subtitle: 'Dragoste, intrigi și dramă în episod după episod.',
    filter: (row) => genreMatch(row, /soap|telenovela|melodrama/i),
    live: true,
    liveSource: 'TMDB · Soap',
  },
  fun: {
    slug: 'fun',
    title: 'Distracție',
    subtitle: 'Comedii și tot ce te face să zâmbești.',
    filter: (row) => genreMatch(row, /comed/i),
    live: true,
    liveSource: 'TMDB · Comedy',
  },
  marvel: {
    slug: 'marvel',
    title: 'Marvel',
    subtitle: 'Universul Marvel — eroi, echipări și multivers.',
    filter: (row) => titleMatch(row, MARVEL_RE) || genreMatch(row, /marvel/i) || sourceMatch(row, /marvel/i),
    live: true,
    liveSource: 'TMDB · Marvel Studios',
  },
  dc: {
    slug: 'dc',
    title: 'DC',
    subtitle: 'Gotham, Metropolis și tot universul DC.',
    filter: (row) => titleMatch(row, DC_RE) || genreMatch(row, /\bdc\b/i) || sourceMatch(row, /\bdc\b|warner/i),
    live: true,
    liveSource: 'TMDB · DC Studios',
  },
  blockbusters: {
    slug: 'blockbusters',
    title: 'Blockbustere',
    subtitle: 'Cele mai mari producții ale tuturor timpurilor — ordonate după încasări.',
    filter: (row) =>
      genreMatch(row, /action|adventure|sci.?fi|thriller/i) && ratingOf(row) >= 6,
    sort: (a, b) => ratingOf(b) - ratingOf(a),
    live: true,
    liveSource: 'TMDB · Top încasări',
  },
  disney: {
    slug: 'disney',
    title: 'Disney',
    subtitle: 'Magia Disney — filme Walt Disney Pictures și program Disney Channel.',
    filter: (row) => titleMatch(row, /disney/i) || sourceMatch(row, /disney/i),
    live: true,
    liveSource: 'Walt Disney Pictures · Disney Channel',
  },
  jetix: {
    slug: 'jetix',
    title: 'Jetix',
    subtitle: 'Aventurile Jetix care au marcat copilăria.',
    filter: (row) => titleMatch(row, /jetix/i) || sourceMatch(row, /jetix/i),
    live: true,
    liveSource: 'TMDB · Jetix',
  },
  foxkids: {
    slug: 'foxkids',
    title: 'Fox Kids',
    subtitle: 'Eroii Fox Kids — biblioteca Saban, gata de revedere.',
    filter: (row) => titleMatch(row, /fox.?kids/i) || sourceMatch(row, /fox.?kids/i),
    live: true,
    liveSource: 'TMDB · Saban Entertainment',
  },
  'cartoon-network': {
    slug: 'cartoon-network',
    title: 'Cartoon Network',
    subtitle: 'Desenele Cartoon Network, tot timpul la cerere.',
    filter: (row) => titleMatch(row, /cartoon.?network/i) || sourceMatch(row, /cartoon.?network/i),
    live: true,
    liveSource: 'TMDB · Cartoon Network',
  },
  boomerang: {
    slug: 'boomerang',
    title: 'Boomerang',
    subtitle: 'Clasicele Hanna-Barbera — mereu bune, mereu la cerere.',
    filter: (row) => titleMatch(row, /boomerang|hanna/i) || sourceMatch(row, /boomerang|hanna/i),
    live: true,
    liveSource: 'TMDB · Hanna-Barbera',
  },
  minimax: {
    slug: 'minimax',
    title: 'Minimax',
    subtitle: 'Minimax — desene din inima Europei Centrale.',
    filter: (row) => titleMatch(row, /minimax/i) || sourceMatch(row, /minimax/i),
    live: true,
    liveSource: 'TMDB · Animație HU·CZ·SK·RO',
  },
  /* FAZA 32: cele 8 canale noi — feed live TMDB (rețele verificate:
   * Nickelodeon=13, Disney Channel=54, Nicktoons=224, Disney Junior=281,
   * Nick Jr.=35; Cartoonito/JimJam/Duck TV = aproximări onete etichetate). */
  nickelodeon: {
    slug: 'nickelodeon',
    title: 'Nickelodeon',
    subtitle: 'Nickelodeon — desenele care au crescut o generație întreagă.',
    filter: (row) => titleMatch(row, /nickelodeon/i) || sourceMatch(row, /nickelodeon/i),
    live: true,
    liveSource: 'TMDB · Rețeaua Nickelodeon (ID 13)',
  },
  'disney-channel': {
    slug: 'disney-channel',
    title: 'Disney Channel',
    subtitle: 'Disney Channel — serialele originale care au marcat copilăria.',
    filter: (row) => sourceMatch(row, /disney\s*channel/i) || titleMatch(row, /disney\s*channel/i),
    live: true,
    liveSource: 'TMDB · Rețeaua Disney Channel (ID 54)',
  },
  nicktoons: {
    slug: 'nicktoons',
    title: 'Nicktoons',
    subtitle: 'Nicktoons — animațiile semnătură Nickelodeon.',
    filter: (row) => titleMatch(row, /nicktoons/i) || sourceMatch(row, /nicktoons/i),
    live: true,
    liveSource: 'TMDB · Rețeaua Nicktoons (ID 224)',
  },
  cartoonito: {
    slug: 'cartoonito',
    title: 'Cartoonito',
    subtitle: 'Cartoonito — desene blânde pentru cei mai mici (Warner/Hanna-Barbera).',
    filter: (row) => titleMatch(row, /cartoonito/i) || sourceMatch(row, /cartoonito|hanna.?barbera/i),
    live: true,
    liveSource: 'TMDB · Preșcolar Warner/Hanna-Barbera',
  },
  'disney-junior': {
    slug: 'disney-junior',
    title: 'Disney Junior',
    subtitle: 'Disney Junior — primele povești Disney pentru cei mici.',
    filter: (row) => titleMatch(row, /disney\s*junior/i) || sourceMatch(row, /disney\s*junior/i),
    live: true,
    liveSource: 'TMDB · Rețeaua Disney Junior (ID 281)',
  },
  'nick-jr': {
    slug: 'nick-jr',
    title: 'Nick Jr.',
    subtitle: 'Nick Jr. — învățare prin joacă pentru preșcolari.',
    filter: (row) => titleMatch(row, /nick\s*jr/i) || sourceMatch(row, /nick\s*jr/i),
    live: true,
    liveSource: 'TMDB · Rețeaua Nick Jr. (ID 35)',
  },
  jimjam: {
    slug: 'jimjam',
    title: 'JimJam',
    subtitle: 'JimJam — povești blânde din inima Europei.',
    filter: (row) => titleMatch(row, /jimjam/i) || sourceMatch(row, /jimjam/i),
    live: true,
    liveSource: 'TMDB · Preșcolar Europa Centrală',
  },
  'duck-tv': {
    slug: 'duck-tv',
    title: 'Duck TV',
    subtitle: 'Duck TV — muzică și povești liniștitoare pentru bebeluși.',
    filter: (row) => titleMatch(row, /duck\s*tv|ducktv/i) || sourceMatch(row, /ducktv/i),
    live: true,
    liveSource: 'TMDB · Muzică & Familie',
  },
  europa: {
    slug: 'europa',
    title: 'Europa',
    subtitle: 'Producții din toată Europa — 44 de țări, un singur loc.',
    filter: continentFilter('europa'),
    live: true,
    liveSource: 'TMDB · Europa',
  },
  'america-nord': {
    slug: 'america-nord',
    title: 'America de Nord',
    subtitle: 'Hollywood și dincolo de el — SUA, Canada, Mexic.',
    filter: continentFilter('america-nord'),
    live: true,
    liveSource: 'TMDB · America de Nord',
  },
  'america-sud': {
    slug: 'america-sud',
    title: 'America de Sud',
    subtitle: 'Brazilia, Argentina, Columbia și toată America Latină.',
    filter: continentFilter('america-sud'),
    live: true,
    liveSource: 'TMDB · America de Sud',
  },
  asia: {
    slug: 'asia',
    title: 'Asia',
    subtitle: 'Anime, K-drama și cinema asiatic — totul la cerere.',
    filter: continentFilter('asia'),
    live: true,
    liveSource: 'TMDB · Asia',
  },
  africa: {
    slug: 'africa',
    title: 'Africa',
    subtitle: 'Povești din Africa — de la Nollywood la Nordul Africii.',
    filter: continentFilter('africa'),
    live: true,
    liveSource: 'TMDB · Africa',
  },
  oceania: {
    slug: 'oceania',
    title: 'Oceania',
    subtitle: 'Australia, Noua Zeelandă și insulele Pacificului.',
    filter: continentFilter('oceania'),
    live: true,
    liveSource: 'TMDB · Oceania',
  },
};

/** Special (non-grid) categories rendered with dedicated panels. */
export const SPECIAL_CATEGORIES = new Set(['my-list', 'my-collections', 'manage']);

/** Slugs backed by the live /api/discover/:slug feed (mirrors the backend
 *  SLUG_CATALOG — kept in sync so every sidebar menu shows real content). */
export const DISCOVER_SLUGS = new Set([
  'kids',
  'telenovelas',
  'fun',
  'blockbusters',
  'marvel',
  'dc',
  'disney',
  'jetix',
  'foxkids',
  'cartoon-network',
  'boomerang',
  'minimax',
  'nickelodeon',
  'disney-channel',
  'nicktoons',
  'cartoonito',
  'disney-junior',
  'nick-jr',
  'jimjam',
  'duck-tv',
  'europa',
  'america-nord',
  'america-sud',
  'asia',
  'africa',
  'oceania',
]);
