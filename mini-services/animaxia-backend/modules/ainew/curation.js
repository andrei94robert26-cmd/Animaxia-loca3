/**
 * modules/ainew/curation.js — FAZA 35 (WS5): AI Curation Notes — explicația
 * „De ce îți recomandăm" de pe cardul de recomandare. Semnale reale
 * (READ-ONLY): nota catalogului, popularitatea (viewevents 30 zile — tabela
 * există, verificată în schemă), potrivirea cu genurile din istoricul
 * utilizatorului (watchhistory), recența (an), apartenența la franciză
 * (metadata collection/franchise). Ponderi 0..1, narațiune z-ai cu fallback
 * DETERMINIST construit din semnalele de top — provider etichetat onest.
 */

import { getContentById } from '../../db.js';
import { rows, zaiComplete, nowIso } from './common.js';

/* ------------------------------- signals ------------------------------------ */

async function popularitySignal(contentId) {
  try {
    const r = await rows(
      `SELECT COUNT(*) AS n FROM viewevents
        WHERE contentid = $1 AND createdat > datetime('now','-30 days')`,
      [contentId],
    );
    const views = Number(r[0]?.n ?? 0);
    /* Scalare onestă logaritmică: 0 vizionări → 0; 10 → 0.41; 100+ → ~0.7+. */
    const value = views > 0 ? Math.min(1, Math.log10(views + 1) / 2) : 0;
    return { views, value: Math.round(value * 100) / 100 };
  } catch {
    return { views: null, value: 0 }; // sursa indisponibilă → semnal 0, onest
  }
}

async function genreMatchSignal(contentId, genres, userId) {
  if (!userId || genres.length === 0) return { overlap: 0, value: 0, genres: [] };
  try {
    const history = await rows(
      `SELECT c.metadata FROM watchhistory h JOIN content c ON c.id = h.contentid
        WHERE h.userid = $1 ORDER BY h.watchedat DESC LIMIT 20`,
      [userId],
    );
    const watchedGenres = new Set();
    for (const row of history) {
      let meta = row.metadata;
      if (typeof meta === 'string') {
        try { meta = JSON.parse(meta); } catch { meta = {}; }
      }
      if (Array.isArray(meta?.genres)) for (const g of meta.genres) watchedGenres.add(String(g));
    }
    const overlap = genres.filter((g) => watchedGenres.has(g));
    if (watchedGenres.size === 0) return { overlap: 0, value: 0, genres: [] };
    const value = Math.min(1, overlap.length / 3); // 3 genuri comune = potrivire maximă
    return { overlap: overlap.length, value: Math.round(value * 100) / 100, genres: overlap };
  } catch {
    return { overlap: 0, value: 0, genres: [] };
  }
}

function recencySignal(year) {
  const y = Number(year);
  if (!Number.isFinite(y) || y <= 1900) return 0;
  const age = new Date().getFullYear() - y;
  if (age <= 0) return 1;
  if (age >= 15) return 0;
  return Math.round(((15 - age) / 15) * 100) / 100;
}

function franchiseSignal(metadata) {
  const meta = metadata && typeof metadata === 'object' ? metadata : {};
  return meta.collection ?? meta.franchise ?? meta.franchiseName ?? meta.belongsToCollection ?? null;
}

/* ------------------------------ capability API ------------------------------ */

/** Semnale → etichete românești pentru card + fallback determinist. */
function signalLabels() {
  return {
    rating: 'Notă catalog',
    popularity: 'Popularitate (30 zile)',
    genreMatch: 'Potrivire cu gusturile tale',
    recency: 'Recența',
    franchise: 'Apartenență la franciză',
  };
}

function heuristicNote(title, signals, meta) {
  const labels = signalLabels();
  const top = signals
    .filter((s) => s.weight > 0 && s.value > 0)
    .sort((a, b) => b.value * b.weight - a.value * a.weight)
    .slice(0, 2);
  const parts = top.map((s) => {
    switch (s.key) {
      case 'rating':
        return `are nota ${meta.ratingText} din partea comunității`;
      case 'popularity':
        return `e urmărit activ acum (${meta.views} vizionări în ultimele 30 de zile)`;
      case 'genreMatch':
        return `se potrivește cu genurile pe care le urmărești (${(s.genres || []).slice(0, 2).join(', ')})`;
      case 'recency':
        return `e un titlu ${meta.age <= 1 ? 'foarte recent' : 'relativ recent'} (${meta.year})`;
      case 'franchise':
        return `face parte din franciza „${meta.franchise}"`;
      default:
        return labels[s.key];
    }
  });
  const why = parts.length > 0
    ? `Ți-l recomandăm pentru că ${parts.join(' și ')}.`
    : `„${title}" e un titlu bine cotaat din catalog — merită o privire.`;
  return `${why} (Notă: explicație generată din semnalele reale ale catalogului — serviciul AI este momentan indisponibil.)`;
}

/**
 * curationWhy({ contentId, userId }) — READ-ONLY; userId opțional (fără el,
 * semnalul genreMatch rămâne 0, onest). Returnează note + signals + provider.
 */
export async function curationWhy({ contentId, userId }) {
  const content = await getContentById(contentId);
  if (!content) return { status: 404, error: 'Conținut inexistent' };

  const meta = content.metadata && typeof content.metadata === 'object' ? content.metadata : {};
  const genres = Array.isArray(meta.genres) ? meta.genres.slice(0, 8) : [];
  const year = meta.year != null ? Number(meta.year) : null;
  const rating = meta.rating != null ? Number(meta.rating) : null;
  const franchise = franchiseSignal(meta);

  const [pop, match] = await Promise.all([
    popularitySignal(contentId),
    genreMatchSignal(contentId, genres, userId),
  ]);

  const ratingValue = rating != null ? Math.min(1, rating / 10) : 0;
  const recencyValue = recencySignal(year);
  const franchiseValue = franchise ? 1 : 0;

  const signals = [
    { key: 'rating', label: signalLabels().rating, value: ratingValue, weight: 0.3 },
    { key: 'popularity', label: signalLabels().popularity, value: pop.value, weight: 0.2 },
    { key: 'genreMatch', label: signalLabels().genreMatch, value: match.value, weight: 0.3 },
    { key: 'recency', label: signalLabels().recency, value: recencyValue, weight: 0.1 },
    { key: 'franchise', label: signalLabels().franchise, value: franchiseValue, weight: 0.1 },
  ];

  const metaForNote = {
    ratingText: rating != null ? String(rating) : '—',
    views: pop.views,
    year: year ?? null,
    age: year != null ? new Date().getFullYear() - year : null,
    franchise,
  };

  const factual = [
    `Titlu: „${content.title}"${year ? ` (${year})` : ''}.`,
    genres.length ? `Genuri: ${genres.join(', ')}.` : '',
    rating != null ? `Notă catalog: ${rating}.` : '',
    pop.views != null && pop.views > 0 ? `Vizionări în ultimele 30 de zile: ${pop.views}.` : '',
    match.genres.length ? `Genuri în comun cu istoricul utilizatorului: ${match.genres.join(', ')}.` : '',
    franchise ? `Parte din franciza: ${franchise}.` : '',
  ].filter(Boolean).join(' ');

  const aiNote = await zaiComplete([
    { role: 'system', content: 'Ești motorul de recomandări al platformei Animaxia. Răspunzi în română cu 1-2 propoziții scurte, concrete, fără enumerări.' },
    {
      role: 'user',
      content: `Scrie explicația „De ce îți recomandăm" pentru cardul de recomandare. Fapte reale (singura ta sursă — nu inventa):\n${factual}\n\nFormatează natural: „De ce îți recomandăm: …". Maxim 2 propoziții.`,
    },
  ]);

  return {
    ok: true,
    contentId,
    title: content.title,
    note: aiNote ?? heuristicNote(content.title, signals, metaForNote),
    provider: aiNote ? 'z-ai' : 'heuristic',
    signals,
    ...(userId ? { userId } : {}),
    generatedAt: nowIso(),
  };
}
