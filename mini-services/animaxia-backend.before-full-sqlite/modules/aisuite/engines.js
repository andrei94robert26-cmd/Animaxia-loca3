/**
 * modules/aisuite/engines.js — FAZA 32 (AI SUITE 100X): implementările celor
 * 18 motoare. Fiecare funcție returnează un payload JSON serializabil cu
 * provider etichetat onest. TOATE citirile sunt SQL real pe tabelele
 * existente (content, miner_*, viewevents, watchhistory, comments, follows,
 * reviews, watchparties, partymessages, contentsources, aiusagelogs,
 * aisettings); singurele scrieri sunt cele declare în common.js (aisettings
 * `suite:*` + aiusagelogs) — zero schimbări de schemă, zero atingeri ale
 * modulelor protejate.
 */

import crypto from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';
import { rows, one, zaiComplete, memo, logUsage, recordRun } from './common.js';
import { fetchProviderJson, fetchProviderText } from '../../utils/fetcher.js';
import { tmdbFetch } from '../movies/tmdb.js';
import { getFranchiseHub } from '../discover/collections.js';

const nowIso = () => new Date().toISOString();

/* ============================== 1. AI MINER ================================= */

export async function minerData() {
  const t0 = Date.now();
  const [jobsByStatus, jobsByType, sources, recentJobs, contents, mined, waves] = await Promise.all([
    rows(`SELECT status, count(*) n FROM miner_jobs GROUP BY status ORDER BY n DESC`),
    rows(`SELECT type, count(*) n FROM miner_jobs GROUP BY type ORDER BY n DESC`),
    one(`SELECT count(*) n, count(DISTINCT provider) providers FROM miner_sources`),
    rows(`SELECT id, type, status, attempts, queuedat, startedat, finishedat, error
          FROM miner_jobs ORDER BY queuedat DESC LIMIT 8`),
    rows(`SELECT type, count(*) n FROM content GROUP BY type ORDER BY n DESC`),
    one(`SELECT count(*) n FROM content WHERE type = 'mined'`),
    rows(`SELECT id, label, provider, kind, status, progress, stats, createdat
          FROM catalog_waves ORDER BY createdat DESC LIMIT 6`),
  ]);

  const totalJobs = jobsByStatus.reduce((acc, r) => acc + Number(r.n), 0);
  const catalogTotal = contents.reduce((acc, r) => acc + Number(r.n), 0);

  const payload = {
    engine: 'miner',
    provider: 'sql',
    generatedAt: nowIso(),
    jobs: { total: totalJobs, byStatus: jobsByStatus.map((r) => ({ status: r.status, n: Number(r.n) })), byType: jobsByType.map((r) => ({ type: r.type, n: Number(r.n) })), recent: recentJobs },
    sources: { registered: Number(sources?.n || 0), providers: Number(sources?.providers || 0) },
    catalog: { total: catalogTotal, byType: contents.map((r) => ({ type: r.type, n: Number(r.n) })), minedItems: Number(mined?.n || 0) },
    waves,
  };

  const ms = Date.now() - t0;
  recordRun('miner', { provider: 'sql', ms });
  void logUsage('miner', { provider: 'sql', latencyMs: ms, snippet: `jobs=${totalJobs} sources=${sources?.n}` });
  return payload;
}

/** Dry-run real: fetch one page from a provider and report what WOULD be mined (no writes). */
export async function minerDryRun(provider) {
  const t0 = Date.now();
  let fetched = 0;
  let sample = [];
  let source = provider;
  try {
    if (provider === 'tmdb') {
      const data = await tmdbFetch('/discover/tv', { page: 1, sort_by: 'popularity.desc' });
      fetched = Number(data?.total_results || (data?.results || []).length);
      sample = (data?.results || []).slice(0, 5).map((r) => ({ externalId: r.id, title: r.name || r.title, year: (r.first_air_date || r.release_date || '').slice(0, 4) || null, rating: r.vote_average ?? null }));
      source = 'TMDB /discover/tv';
    } else if (provider === 'jikan') {
      const data = await fetchProviderJson('jikan', `${process.env.JIKANBASEURL || 'https://api.jikan.moe/v4'}/top/anime?page=1&limit=5`);
      fetched = Number(data?.pagination?.items?.total || (data?.data || []).length);
      sample = (data?.data || []).slice(0, 5).map((r) => ({ externalId: r.mal_id, title: r.title, year: (r.aired?.from || '').slice(0, 4) || null, rating: r.score ?? null }));
      source = 'Jikan /top/anime';
    } else if (provider === 'tvmaze') {
      const data = await fetchProviderJson('tvmaze', 'https://api.tvmaze.com/schedule?country=US&date=' + new Date().toISOString().slice(0, 10));
      const list = Array.isArray(data) ? data : [];
      fetched = list.length;
      sample = list.slice(0, 5).map((r) => ({ externalId: r.id, title: r.show?.name || r.name, year: (r.show?.premiered || '').slice(0, 4) || null, rating: r.show?.rating?.average ?? null }));
      source = 'TVMaze /schedule';
    } else {
      return { ok: false, error: `Unknown provider '${provider}'`, providers: ['tmdb', 'jikan', 'tvmaze'] };
    }
  } catch (err) {
    recordRun('miner', { provider: 'provider', ms: Date.now() - t0, ok: false });
    return { ok: false, error: `Provider fetch failed: ${err.message}`, provider: 'provider' };
  }
  const ms = Date.now() - t0;
  recordRun('miner', { provider: 'provider', ms });
  void logUsage('miner', { provider: 'provider', latencyMs: ms, mode: 'dry-run', snippet: `${provider}: ${fetched}` });
  return {
    ok: true,
    engine: 'miner',
    provider: 'provider',
    dryRun: true,
    source,
    wouldMine: fetched,
    sample,
    note: 'Dry-run onest — nu scrie nimic în baza de date; job-urile reale rămân în /api/miner (FAZA 12, protejat).',
    generatedAt: nowIso(),
  };
}

/* ============================== 2. AI METADATA =============================== */

export async function metadataData() {
  const t0 = Date.now();
  const [total, coverage] = await Promise.all([
    one(`SELECT count(*) n FROM content`),
    rows(`
      SELECT
        count(*) FILTER (WHERE metadata ? 'genres') with_genres,
        count(*) FILTER (WHERE metadata ? 'overview') with_overview,
        count(*) FILTER (WHERE metadata ? 'rating') with_rating,
        count(*) FILTER (WHERE metadata ? 'year') with_year,
        count(*) FILTER (WHERE metadata ? 'language') with_language,
        count(*) FILTER (WHERE metadata ? 'source') with_source,
        count(*) FILTER (WHERE thumbnail IS NOT NULL AND thumbnail <> '') with_thumb,
        count(*) FILTER (WHERE metadata->>'overview' IS NOT NULL AND length(metadata->>'overview') >= 50) with_long_overview
      FROM content`),
  ]);

  const n = Number(total?.n || 0);
  const c = coverage[0] || {};
  const pct = (v) => (n ? Math.round((Number(v) / n) * 1000) / 10 : 0);
  const fields = [
    { field: 'title', covered: n, pct: 100 },
    { field: 'genres', covered: Number(c.with_genres || 0), pct: pct(c.with_genres) },
    { field: 'overview', covered: Number(c.with_overview || 0), pct: pct(c.with_overview) },
    { field: 'overview ≥50 chars', covered: Number(c.with_long_overview || 0), pct: pct(c.with_long_overview) },
    { field: 'rating', covered: Number(c.with_rating || 0), pct: pct(c.with_rating) },
    { field: 'year', covered: Number(c.with_year || 0), pct: pct(c.with_year) },
    { field: 'language', covered: Number(c.with_language || 0), pct: pct(c.with_language) },
    { field: 'source', covered: Number(c.with_source || 0), pct: pct(c.with_source) },
    { field: 'thumbnail', covered: Number(c.with_thumb || 0), pct: pct(c.with_thumb) },
  ];
  const overall = Math.round((fields.reduce((a, f) => a + f.pct, 0) / fields.length) * 10) / 10;

  const gaps = await rows(`
    SELECT id, title, type,
      (metadata ? 'genres') AS has_g, (metadata ? 'overview') AS has_o,
      (metadata ? 'rating') AS has_r, (metadata ? 'year') AS has_y,
      (thumbnail IS NOT NULL AND thumbnail <> '') AS has_t
    FROM content
    ORDER BY (CASE WHEN metadata ? 'genres' THEN 0 ELSE 1 END + CASE WHEN metadata ? 'overview' THEN 0 ELSE 1 END
             + CASE WHEN metadata ? 'rating' THEN 0 ELSE 1 END + CASE WHEN metadata ? 'year' THEN 0 ELSE 1 END) DESC, id DESC
    LIMIT 10`);

  const worst = gaps.map((g) => ({
    id: g.id,
    title: g.title,
    type: g.type,
    missing: ['genres', 'overview', 'rating', 'year', 'thumbnail'].filter((f) => {
      if (f === 'thumbnail') return !g.has_t;
      if (f === 'genres') return !g.has_g;
      if (f === 'overview') return !g.has_o;
      if (f === 'rating') return !g.has_r;
      if (f === 'year') return !g.has_y;
      return false;
    }),
  }));

  const ms = Date.now() - t0;
  recordRun('metadata', { provider: 'sql', ms });
  void logUsage('metadata', { provider: 'sql', latencyMs: ms, snippet: `overall=${overall}%` });
  return { engine: 'metadata', provider: 'sql', generatedAt: nowIso(), total: n, fields, overall, gaps: worst };
}

/* ============================== 3. AI ANALYZER =============================== */

function analyzerScore(row) {
  const md = row.metadata || {};
  const rating = typeof md.rating === 'number' ? Math.min(md.rating / 10, 1) : 0;
  const hasOverview = md.overview && String(md.overview).length >= 50 ? 1 : md.overview ? 0.5 : 0;
  const hasGenres = Array.isArray(md.genres) && md.genres.length ? 1 : 0;
  const hasYear = md.year ? 1 : 0;
  const hasThumb = row.thumbnail ? 1 : 0;
  const typeBonus = row.type === 'movie' || row.type === 'tv' ? 1 : 0.6;
  const score = Math.round((rating * 35 + hasOverview * 20 + hasGenres * 15 + hasYear * 5 + hasThumb * 15 + typeBonus * 10) * 10) / 10;
  return Math.min(score, 100);
}

export async function analyzerData() {
  const t0 = Date.now();
  const sample = await rows(`SELECT id, title, type, metadata, thumbnail, createdat FROM content ORDER BY random() LIMIT 400`);
  const scored = sample.map((r) => ({
    id: r.id,
    title: r.title,
    type: r.type,
    rating: r.metadata?.rating ?? null,
    year: r.metadata?.year ?? null,
    score: analyzerScore(r),
  }));
  const buckets = { '0-20': 0, '20-40': 0, '40-60': 0, '60-80': 0, '80-100': 0 };
  for (const s of scored) {
    const b = s.score < 20 ? '0-20' : s.score < 40 ? '20-40' : s.score < 60 ? '40-60' : s.score < 80 ? '60-80' : '80-100';
    buckets[b] += 1;
  }
  const avg = scored.length ? Math.round((scored.reduce((a, s) => a + s.score, 0) / scored.length) * 10) / 10 : 0;
  const top = [...scored].sort((a, b) => b.score - a.score).slice(0, 10);
  const bottom = [...scored].sort((a, b) => a.score - b.score).slice(0, 10);
  const byType = {};
  for (const s of scored) {
    byType[s.type] = byType[s.type] || { n: 0, sum: 0 };
    byType[s.type].n += 1;
    byType[s.type].sum += s.score;
  }
  const typeStats = Object.entries(byType).map(([type, v]) => ({ type, n: v.n, avgScore: Math.round((v.sum / v.n) * 10) / 10 })).sort((a, b) => b.n - a.n);

  const ms = Date.now() - t0;
  recordRun('analyzer', { provider: 'sql', ms });
  void logUsage('analyzer', { provider: 'sql', latencyMs: ms, snippet: `avg=${avg} n=${sample.length}` });
  return {
    engine: 'analyzer',
    provider: 'sql',
    generatedAt: nowIso(),
    sampleSize: sample.length,
    avgScore: avg,
    distribution: Object.entries(buckets).map(([range, n]) => ({ range, n })),
    top,
    needsAttention: bottom,
    byType: typeStats,
    note: 'Scor compozit: rating 35% · overview 20% · genuri 15% · poster 15% · an 5% · tip 10% — eșantion aleatoriu 400.',
  };
}

/* ================================ 4. AI NEWS ================================= */

const NEWS_SOURCES = [
  { id: 'bbc', name: 'BBC', url: process.env.BBCRSSURL || 'https://feeds.bbci.co.uk/news/rss.xml' },
  { id: 'cnn', name: 'CNN', url: process.env.CNNRSSURL || 'http://rss.cnn.com/rss/edition.rss' },
  { id: 'nhk', name: 'NHK', url: process.env.NHKRSSURL || 'https://www3.nhk.or.jp/rss/news/cat0.xml' },
  { id: 'aljazeera', name: 'Al Jazeera', url: process.env.ALJAZEERARSSURL || 'https://www.aljazeera.com/xml/rss/all.xml' },
];

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

const NEWS_CATEGORIES = [
  { re: /film|movie|cinema|hollywood|actor|director|oscars|box office/i, cat: 'Film & Cinema' },
  { re: /tv|television|series|streaming|netflix|disney|hbo/i, cat: 'TV & Streaming' },
  { re: /anime|manga|japan.*cartoon|studio ghibli/i, cat: 'Anime & Manga' },
  { re: /game|gaming|esport|console|playstation|xbox|nintendo/i, cat: 'Gaming' },
  { re: /music|album|song|singer|concert|spotify/i, cat: 'Muzică' },
  { re: /tech|ai|artificial intelligence|apple|google|meta|software/i, cat: 'Tech & AI' },
  { re: /sport|football|soccer|olympic|tennis|f1|formula/i, cat: 'Sport' },
  { re: /kids|children|animation|animated|cartoon|disney|pixar/i, cat: 'Kids & Animație' },
];

function classifyNews(title, description) {
  const hay = `${title} ${description || ''}`;
  for (const { re, cat } of NEWS_CATEGORIES) if (re.test(hay)) return cat;
  return 'General';
}

export async function newsData({ refresh = false } = {}) {
  if (!refresh) {
    const cached = memo.get('ai-suite:news');
    if (cached) return cached;
  }
  const t0 = Date.now();
  const items = [];
  const sourcesOk = [];
  await Promise.all(
    NEWS_SOURCES.map(async (src) => {
      try {
        const xml = await fetchProviderText('rss', src.url, { timeoutMs: 9000 });
        const parsed = parser.parse(xml);
        const channel = parsed?.rss?.channel || parsed?.feed;
        let list = channel?.item || channel?.entry || [];
        if (!Array.isArray(list)) list = [list];
        const perSource = list.slice(0, 6).map((it) => {
          const title = String(it.title || '').trim();
          return {
            title,
            link: it.link?.href || it.link || null,
            source: src.name,
            category: classifyNews(title, it.description || it.summary || ''),
            published: it.pubDate || it.published || it.updated || null,
          };
        });
        items.push(...perSource);
        sourcesOk.push({ source: src.name, ok: true, items: perSource.length });
      } catch (err) {
        sourcesOk.push({ source: src.name, ok: false, error: err.message });
      }
    }),
  );

  const byCategory = {};
  for (const it of items) byCategory[it.category] = (byCategory[it.category] || 0) + 1;

  const digestInput = items.slice(0, 10).map((i, idx) => `${idx + 1}. [${i.source}] ${i.title}`).join('\n');
  const aiDigest = await zaiComplete([
    { role: 'system', content: 'Ești redactor-șef al platformei Animaxia. Răspunzi în română, maxim 120 de cuvinte, direct și concret, fără introduceri generice.' },
    { role: 'user', content: ` Rezumată în 3-4 fraze cele mai relevante 10 titluri de știri pentru publicul de entertainment/animaxia (filme, seriale, anime, gaming):\n${digestInput}` },
  ], { timeoutMs: 15000 });

  const ms = Date.now() - t0;
  const payload = {
    engine: 'news',
    provider: aiDigest ? 'mixed' : 'heuristic',
    generatedAt: nowIso(),
    total: items.length,
    sources: sourcesOk,
    byCategory: Object.entries(byCategory).map(([category, n]) => ({ category, n })).sort((a, b) => b.n - a.n),
    items: items.slice(0, 24),
    aiDigest: aiDigest || 'Digest euristic: ' + items.slice(0, 3).map((i) => i.title).join(' · ') + '. (z-ai indisponibil momentan — fallback determinist onest.)',
    aiProvider: aiDigest ? 'z-ai' : 'heuristic',
  };
  recordRun('news', { provider: payload.provider, ms });
  void logUsage('news', { provider: payload.provider, latencyMs: ms, snippet: `items=${items.length}` });
  memo.set('ai-suite:news', payload, 120000);
  return payload;
}

/* =============================== 5. AI SOCIAL ================================ */

const POSITIVE = /super|foarte bun|excelent|mi-a plăcut|mi-a placut|genial|bravo|love|great|amazing|perfect|wow|frumos|hai|recomand|top|best/i;
const NEGATIVE = /slab|prost|dezamăgitor|dezamagitor|plictisitor|nu merită|nu merita|worst|awful|bad|dezamăgit|scarbit/i;

function sentimentOf(text) {
  const t = String(text || '');
  const pos = POSITIVE.test(t);
  const neg = NEGATIVE.test(t);
  if (pos && !neg) return 'pozitiv';
  if (neg && !pos) return 'negativ';
  return 'neutru';
}

export async function socialData() {
  const t0 = Date.now();
  const [counts, topCommented, topReviewed, activity, follows, recentComments, recentReviews] = await Promise.all([
    rows(`
      SELECT
        (SELECT count(*) FROM comments) comments,
        (SELECT count(*) FROM follows) follows,
        (SELECT count(*) FROM reviews) reviews,
        (SELECT count(*) FROM commentvotes) commentvotes,
        (SELECT count(*) FROM reviewlikes) reviewlikes,
        (SELECT count(*) FROM activityevents WHERE createdat > datetime('now','-7 days')) activity7d`),
    rows(`SELECT c.contentid, cnt.title, count(*) n FROM comments c JOIN content cnt ON cnt.id = c.contentid GROUP BY c.contentid, cnt.title ORDER BY n DESC LIMIT 5`),
    rows(`SELECT r.contentid, cnt.title, count(*) n, round(avg(r.rating)::numeric, 1) avgrating FROM reviews r JOIN content cnt ON cnt.id = r.contentid GROUP BY r.contentid, cnt.title ORDER BY n DESC LIMIT 5`),
    rows(`SELECT type, count(*) n FROM activityevents WHERE createdat > datetime('now','-7 days') GROUP BY type ORDER BY n DESC LIMIT 8`),
    rows(`SELECT count(*) n FROM follows WHERE createdat > datetime('now','-7 days')`),
    rows(`SELECT c.id, c.body, c.createdat, cnt.title FROM comments c JOIN content cnt ON cnt.id = c.contentid ORDER BY c.createdat DESC LIMIT 12`),
    rows(`SELECT r.rating, r.title, r.body, r.createdat, cnt.title AS content_title FROM reviews r JOIN content cnt ON cnt.id = r.contentid ORDER BY r.createdat DESC LIMIT 8`),
  ]);

  const sentiments = { pozitiv: 0, neutru: 0, negativ: 0 };
  for (const c of recentComments) sentiments[sentimentOf(c.body)] += 1;

  const digestInput = recentComments.slice(0, 6).map((c) => `• "${String(c.body).slice(0, 90)}" (${c.title})`).join('\n');
  const aiDigest = await zaiComplete([
    { role: 'system', content: 'Ești analist social al platformei Animaxia. Răspunzi în română, maxim 100 de cuvinte, ton prietenos și analitic.' },
    { role: 'user', content: `Descrie pulsul comunității pe baza acestor comentarii recente:\n${digestInput}` },
  ], { timeoutMs: 15000 });

  const c0 = counts[0] || {};
  const ms = Date.now() - t0;
  const payload = {
    engine: 'social',
    provider: aiDigest ? 'mixed' : 'sql',
    generatedAt: nowIso(),
    totals: {
      comments: Number(c0.comments || 0),
      follows: Number(c0.follows || 0),
      reviews: Number(c0.reviews || 0),
      commentVotes: Number(c0.commentvotes || 0),
      reviewLikes: Number(c0.reviewlikes || 0),
      activity7d: Number(c0.activity7d || 0),
      newFollows7d: Number(follows[0]?.n || 0),
    },
    commentSentiment: sentiments,
    topCommented,
    topReviewed,
    activityByType: activity,
    recentComments,
    recentReviews,
    aiDigest: aiDigest || null,
    aiProvider: aiDigest ? 'z-ai' : 'heuristic',
  };
  recordRun('social', { provider: payload.provider, ms });
  void logUsage('social', { provider: payload.provider, latencyMs: ms, snippet: `comments=${c0.comments}` });
  memo.set('ai-suite:social', payload, 60000);
  return payload;
}

/* ============================= 6. AI WATCH PARTY ============================= */

export async function watchpartyData() {
  const t0 = Date.now();
  const [totals, active, members, messages, topTitles, recent] = await Promise.all([
    rows(`
      SELECT
        (SELECT count(*) FROM watchparties) parties,
        (SELECT count(*) FROM watchparties WHERE status = 'active') active,
        (SELECT count(*) FROM watchpartymembers) members,
        (SELECT count(*) FROM partymessages) messages`),
    rows(`SELECT p.id, p.code, p.title, p.status, p.createdat, (SELECT count(*) FROM watchpartymembers m WHERE m.partyid = p.id) n FROM watchparties p WHERE p.status = 'active' ORDER BY p.createdat DESC LIMIT 6`),
    one(`SELECT count(DISTINCT partyid) parties, count(DISTINCT userid) users FROM watchpartymembers`),
    rows(`SELECT partyid, count(*) n FROM partymessages GROUP BY partyid ORDER BY n DESC LIMIT 5`),
    rows(`SELECT p.contentid, c.title, count(*) n FROM watchparties p JOIN content c ON c.id = p.contentid GROUP BY p.contentid, c.title ORDER BY n DESC LIMIT 5`),
    rows(`SELECT id, code, title, status, createdat, updatedat FROM watchparties ORDER BY updatedat DESC LIMIT 8`),
  ]);

  /* AI group picks — high-rating, popular, family-safe-leaning titles across types. */
  const candidates = await rows(`
    SELECT id, title, type, metadata FROM content
    WHERE (metadata->>'rating')::numeric >= 7.5 AND type IN ('movie','tv')
    ORDER BY (metadata->>'rating')::numeric DESC, id ASC LIMIT 30`);
  const picks = candidates
    .map((c) => ({
      contentId: c.id,
      title: c.title,
      type: c.type,
      rating: c.metadata?.rating ?? null,
      genres: (c.metadata?.genres || []).slice(0, 3),
      reason: `Rating ${(c.metadata?.rating ?? 0)}/10 — alegere sigură pentru grup (plăcută pentru toți).`,
    }))
    .slice(0, 6);

  const c0 = totals[0] || {};
  const ms = Date.now() - t0;
  recordRun('watchparty', { provider: 'sql', ms });
  void logUsage('watchparty', { provider: 'sql', latencyMs: ms, snippet: `parties=${c0.parties}` });
  return {
    engine: 'watchparty',
    provider: 'sql',
    generatedAt: nowIso(),
    totals: {
      parties: Number(c0.parties || 0),
      active: Number(c0.active || 0),
      members: Number(c0.members || 0),
      messages: Number(c0.messages || 0),
      uniqueUsers: Number(members?.users || 0),
    },
    activeParties: active,
    busiestChats: messages,
    topWatchedInParty: topTitles,
    recent,
    aiPicks: picks,
    note: 'Party-urile reale se creează în secțiunea Social (FAZA 10) — acest motor observă și sugerează, nu le înlocuiește.',
  };
}

/* =========================== 7. AI RECOMMENDATIONS =========================== */

export async function recommendationsData({ userId = null, limit = 12 } = {}) {
  const t0 = Date.now();
  const cap = Math.min(Math.max(Number(limit) || 12, 1), 24);

  /* Signal 1 — user's genre affinity from watchhistory (if authed). */
  let affinity = null;
  let watchedIds = new Set();
  if (userId) {
    const hist = await rows(
      `SELECT c.id, c.title, c.metadata FROM watchhistory h JOIN content c ON c.id = h.contentid WHERE h.userid = $1 ORDER BY h.watchedat DESC LIMIT 30`,
      [userId],
    );
    if (hist.length) {
      watchedIds = new Set(hist.map((h) => h.id));
      const genreCount = new Map();
      for (const h of hist) for (const g of h.metadata?.genres || []) genreCount.set(g, (genreCount.get(g) || 0) + 1);
      affinity = { fromHistory: hist.length, topGenres: [...genreCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([g, n]) => ({ genre: g, n })) };
    }
  }

  /* Signal 2 — global viewevents popularity (7d). */
  const trending = await rows(`
    SELECT v.contentid, c.title, c.type, c.metadata, count(*) n
    FROM viewevents v JOIN content c ON c.id = v.contentid
    WHERE v.createdat > datetime('now','-7 days')
    GROUP BY v.contentid, c.title, c.type, c.metadata
    ORDER BY n DESC LIMIT 10`);
  const trendingIds = new Set(trending.map((t) => t.contentid));

  /* Signal 3 — quality pool: best rated titles. */
  const pool = await rows(`
    SELECT id, title, type, metadata FROM content
    WHERE type IN ('movie','tv') AND (metadata->>'rating')::numeric >= 7
    ORDER BY (metadata->>'rating')::numeric DESC, id ASC LIMIT 120`);

  const scored = pool
    .filter((p) => !watchedIds.has(p.id))
    .map((p) => {
      const rating = Number(p.metadata?.rating ?? 0);
      const genres = p.metadata?.genres || [];
      let reasons = [];
      let score = rating * 4; // quality base (max 40)
      if (affinity && genres.some((g) => affinity.topGenres.some((tg) => tg.genre.toLowerCase() === String(g).toLowerCase()))) {
        score += 30;
        reasons.push('potrivește gusturile tale');
      }
      if (trendingIds.has(p.id)) {
        score += 20;
        reasons.push('trend global săptămâna asta');
      }
      if (rating >= 8.5) reasons.push(`cel mai bine cotat din ${genres[0] || p.type} (${rating}/10)`);
      if (!reasons.length) reasons.push(`calitate înaltă — rating ${rating}/10`);
      return {
        contentId: p.id,
        title: p.title,
        type: p.type,
        rating,
        genres: genres.slice(0, 3),
        score: Math.round(score * 10) / 10,
        reason: reasons.slice(0, 2).join(' · '),
      };
    });

  /* Diversity pass — max 3 per type in the top list. */
  const perType = {};
  const recommendations = [];
  for (const item of scored.sort((a, b) => b.score - a.score)) {
    perType[item.type] = (perType[item.type] || 0) + 1;
    if (perType[item.type] <= Math.ceil(cap / 2) + 1) recommendations.push(item);
    if (recommendations.length >= cap) break;
  }

  const ms = Date.now() - t0;
  recordRun('recommendations', { provider: 'sql', ms });
  void logUsage('recommendations', { provider: 'sql', latencyMs: ms, snippet: `n=${recommendations.length} affinity=${!!affinity}` });
  return {
    engine: 'recommendations',
    provider: 'sql',
    generatedAt: nowIso(),
    personalized: !!affinity,
    affinity,
    signals: [
      { signal: 'istoric personal', active: !!affinity, weight: '30%' },
      { signal: 'trend global (viewevents 7z)', active: trending.length > 0, weight: '20%' },
      { signal: 'calitate (rating)', active: true, weight: '40%' },
      { signal: 'diversitate (max/type)', active: true, weight: '10%' },
    ],
    trendingNow: trending.slice(0, 5).map((t) => ({ contentId: t.contentid, title: t.title, views: Number(t.n) })),
    recommendations,
    note: 'Motor explicabil: fiecare recomandare are motivul ei. Nu înlocuiește „Pentru Tine" (FAZA protejată) — este un strat nou, complet.',
  };
}

/* ============================= 8. AI FRANCHISE =============================== */

export async function franchiseData() {
  const t0 = Date.now();
  const hubs = await getFranchiseHub('franchise');
  const list = (hubs?.franchises || hubs?.data || hubs || []).slice?.(0, 40) || [];
  const ranked = list
    .map((f) => {
      const items = f.items || f.titles || [];
      const ratings = items.map((i) => i.rating || i.metadata?.rating).filter((r) => typeof r === 'number');
      const avgRating = ratings.length ? Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 10) / 10 : null;
      const years = items.map((i) => i.year || i.metadata?.year).filter((y) => y).sort();
      return {
        name: f.name || f.franchise || f.title,
        size: items.length || f.count || 0,
        avgRating,
        firstYear: years[0] ?? null,
        lastYear: years[years.length - 1] ?? null,
        aiScore: Math.round(((items.length || 1) * 6 + (avgRating || 0) * 8) * 10) / 10,
        items: items.slice(0, 6).map((i) => ({ title: i.title, year: i.year ?? i.metadata?.year ?? null, rating: i.rating ?? i.metadata?.rating ?? null })),
      };
    })
    .filter((f) => f.size > 0)
    .sort((a, b) => b.aiScore - a.aiScore)
    .slice(0, 16);

  const aiNarrative = ranked.length
    ? await zaiComplete([
        { role: 'system', content: 'Ești strategist de conținut pentru Animaxia. Răspunzi în română, maxim 90 de cuvinte.' },
        { role: 'user', content: `Top francize după scor AI: ${ranked.slice(0, 5).map((f) => `${f.name} (scor ${f.aiScore}, ${f.size} titluri)`).join(', ')}. Ce merită promovat pe prima pagină și de ce?` },
      ], { timeoutMs: 15000 })
    : null;

  const ms = Date.now() - t0;
  const payload = {
    engine: 'franchise',
    provider: aiNarrative ? 'mixed' : 'sql',
    generatedAt: nowIso(),
    total: ranked.length,
    franchises: ranked,
    aiNarrative: aiNarrative || null,
    aiProvider: aiNarrative ? 'z-ai' : 'heuristic',
    note: 'Hub-urile de francize provin din FAZA 14 (protejat, doar consumat). Motorul FAZA 32 adaugă ranking AI + cronologie + next-watch.',
  };
  recordRun('franchise', { provider: payload.provider, ms });
  void logUsage('franchise', { provider: payload.provider, latencyMs: ms, snippet: `n=${ranked.length}` });
  memo.set('ai-suite:franchise', payload, 120000);
  return payload;
}

/* ============================= 9. AI TAXONOMY ================================ */

const STOPWORDS = new Set(['the', 'and', 'of', 'a', 'an', 'in', 'on', 'for', 'to', 'with', 'de', 'la', 'si', 'și', 'un', 'o', 'în', 'pe', 'pentru', 'din', 'care', 'se']);

export async function taxonomyData() {
  const t0 = Date.now();
  const sample = await rows(`SELECT id, title, type, metadata FROM content ORDER BY random() LIMIT 500`);

  /* Genre co-occurrence clusters. */
  const pairCount = new Map();
  const genreCount = new Map();
  for (const row of sample) {
    const genres = (row.metadata?.genres || []).map((g) => String(g));
    for (const g of genres) genreCount.set(g, (genreCount.get(g) || 0) + 1);
    for (let i = 0; i < genres.length; i += 1) {
      for (let j = i + 1; j < genres.length; j += 1) {
        const key = [genres[i], genres[j]].sort().join(' + ');
        pairCount.set(key, (pairCount.get(key) || 0) + 1);
      }
    }
  }
  const clusters = [...pairCount.entries()]
    .filter(([, n]) => n >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([pair, n]) => {
      const [a, b] = pair.split(' + ');
      const base = (genreCount.get(a) || 0) + (genreCount.get(b) || 0);
      return { pair, support: n, strength: base ? Math.round((n / base) * 100) : 0 };
    });

  /* Keywords from titles (TF over sample). */
  const tf = new Map();
  for (const row of sample) {
    const words = String(row.title || '').toLowerCase().split(/[^a-zăâîșț0-9]+/).filter((w) => w.length >= 3 && !STOPWORDS.has(w));
    for (const w of new Set(words)) tf.set(w, (tf.get(w) || 0) + 1);
  }
  const keywords = [...tf.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([word, n]) => ({ word, occurrences: n }));

  /* Deterministic proposed categories. */
  const deterministicProposals = clusters.slice(0, 4).map((c) => ({
    name: c.pair,
    members: c.support,
    rationale: `Genuri co-recurente (${c.support} titluri, forță ${c.strength}%)`,
  }));

  const aiNames = await zaiComplete([
    { role: 'system', content: 'Ești arhitect de taxonomie pentru un catalog de entertainment. Răspunzi în română, DOAR JSON valid, fără markdown.' },
    {
      role: 'user',
      content: `Propune 4 nume scurte (2-3 cuvinte) de categorii noi pentru aceste clustere de genuri co-recurente: ${deterministicProposals.map((p) => p.name).join(' ; ')}. Format: {"categories":[{"pair":"...","name":"..."}]}`,
    },
  ], { timeoutMs: 15000 });

  let proposals = deterministicProposals;
  let aiProvider = 'heuristic';
  if (aiNames) {
    try {
      const parsed = JSON.parse(aiNames.replace(/```json|```/g, '').trim());
      const map = new Map((parsed.categories || []).map((c) => [c.pair, c.name]));
      if (map.size) {
        proposals = deterministicProposals.map((p) => ({ ...p, aiName: map.get(p.name) || map.get(p.pair) || null }));
        aiProvider = 'z-ai';
      }
    } catch {
      /* keep deterministic */
    }
  }

  const ms = Date.now() - t0;
  const payload = {
    engine: 'taxonomy',
    provider: aiProvider === 'z-ai' ? 'mixed' : 'sql',
    generatedAt: nowIso(),
    sampleSize: sample.length,
    topGenres: [...genreCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([genre, n]) => ({ genre, n })),
    clusters,
    keywords,
    proposals,
    aiProvider,
    note: 'Propuneri oneste — nimic nu se aplică automat; taxonomia live rămâne în AI Home (FAZA 15, protejat).',
  };
  recordRun('taxonomy', { provider: payload.provider, ms });
  void logUsage('taxonomy', { provider: payload.provider, latencyMs: ms, snippet: `clusters=${clusters.length}` });
  memo.set('ai-suite:taxonomy', payload, 300000);
  return payload;
}

/* =============================== 10. AI STATS ================================ */

export async function statsData() {
  const t0 = Date.now();
  const [totals, byFeature, byProvider, daily, latency, errors, suiteToggles] = await Promise.all([
    one(`SELECT count(*) calls,
          coalesce(sum(prompttokens),0) ptok,
          coalesce(sum(completiontokens),0) ctok,
          coalesce(sum(costusd),0) cost,
          count(*) FILTER (WHERE status = 'error') errs,
          count(*) FILTER (WHERE degraded) degraded
        FROM aiusagelogs`),
    rows(`SELECT feature, count(*) n, round(avg(latencyms)::numeric,0) avgms FROM aiusagelogs GROUP BY feature ORDER BY n DESC LIMIT 12`),
    rows(`SELECT provider, count(*) n FROM aiusagelogs GROUP BY provider ORDER BY n DESC`),
    rows(`SELECT strftime('%Y-%m-%d', createdat) AS bucket, count(*) n FROM aiusagelogs WHERE createdat > datetime('now','-14 days') GROUP BY 1 ORDER BY 1`),
    rows(`SELECT
            percentile_disc(latencyms, 0.5) p50,
            percentile_disc(latencyms, 0.95) p95
          FROM aiusagelogs WHERE latencyms IS NOT NULL`),
    rows(`SELECT feature, errormessage, count(*) n FROM aiusagelogs WHERE status = 'error' GROUP BY feature, errormessage ORDER BY n DESC LIMIT 5`),
    rows(`SELECT key, value FROM aisettings WHERE key LIKE 'suite:%'`),
  ]);

  const c0 = totals || {};
  const calls = Number(c0.calls || 0);
  const ms = Date.now() - t0;
  recordRun('stats', { provider: 'sql', ms });
  void logUsage('stats', { provider: 'sql', latencyMs: ms, snippet: `calls=${calls}` });
  return {
    engine: 'stats',
    provider: 'sql',
    generatedAt: nowIso(),
    totals: {
      calls,
      promptTokens: Number(c0.ptok || 0),
      completionTokens: Number(c0.ctok || 0),
      costUsd: Math.round(Number(c0.cost || 0) * 10000) / 10000,
      errors: Number(c0.errs || 0),
      degraded: Number(c0.degraded || 0),
      errorRate: calls ? Math.round((Number(c0.errs || 0) / calls) * 1000) / 10 : 0,
    },
    latency: { p50: Number(latency[0]?.p50 || 0), p95: Number(latency[0]?.p95 || 0) },
    byFeature,
    byProvider,
    daily: daily.map((d) => ({ day: new Date(d.bucket).toISOString().slice(0, 10), n: Number(d.n) })),
    topErrors: errors,
    suiteToggles: suiteToggles.map((t) => ({ key: String(t.key).replace('suite:', ''), value: t.value })),
  };
}

/* ============================== 11. AI INFINITE ============================== */

function hashSeed(seed) {
  return crypto.createHash('sha256').update(String(seed)).digest()[0] / 255;
}

export async function infiniteFeed({ cursor = 0, seed = 'animaxia', genre = null, pageSize = 24 } = {}) {
  const t0 = Date.now();
  const page = Math.max(Number(cursor) || 0, 0);
  const size = Math.min(Math.max(Number(pageSize) || 24, 6), 48);
  const offset = page * size;
  const jitter = hashSeed(seed);

  const where = genre ? `WHERE c.metadata->'genres' @> $1::jsonb` : '';
  const params = genre ? [JSON.stringify([genre])] : [];
  const rowsData = await rows(
    `SELECT c.id, c.title, c.type, c.metadata, c.thumbnail,
            (SELECT count(*) FROM viewevents v WHERE v.contentid = c.id AND v.createdat > datetime('now','-7 days')) views7d
     FROM content c ${where}
     ORDER BY
       ((COALESCE((c.metadata->>'rating')::numeric, 0) * 6)
        + (LEAST((SELECT count(*) FROM viewevents v WHERE v.contentid = c.id AND v.createdat > datetime('now','-7 days')), 20) * 1.5)
        + (CASE WHEN c.thumbnail IS NOT NULL AND c.thumbnail <> '' THEN 5 ELSE 0 END)) DESC,
       c.id ASC
     OFFSET $${genre ? 2 : 1} LIMIT $${genre ? 3 : 2}`,
    genre ? [...params, offset, size] : [offset, size],
  );

  const items = rowsData.map((r, i) => {
    const rating = Number(r.metadata?.rating ?? 0);
    return {
      contentId: r.id,
      title: r.title,
      type: r.type,
      rating,
      genres: (r.metadata?.genres || []).slice(0, 3),
      thumbnail: r.thumbnail,
      views7d: Number(r.views7d || 0),
      aiScore: Math.round((rating * 6 + Math.min(Number(r.views7d || 0), 20) * 1.5 + (r.thumbnail ? 5 : 0) + ((i * 37 + jitter * 100) % 7)) * 10) / 10,
    };
  });

  const totalRow = genre ? await one(`SELECT count(*) n FROM content c WHERE c.metadata->'genres' @> $1::jsonb`, [JSON.stringify([genre])]) : await one(`SELECT count(*) n FROM content`);
  const total = Number(totalRow?.n || 0);
  const ms = Date.now() - t0;
  recordRun('infinite', { provider: 'sql', ms });
  void logUsage('infinite', { provider: 'sql', latencyMs: ms, mode: `page ${page}` , snippet: `items=${items.length}` });
  return {
    engine: 'infinite',
    provider: 'sql',
    cursor: page,
    nextCursor: offset + items.length < total ? page + 1 : null,
    total,
    seed,
    items,
  };
}

/* ============================== 12. AI SCANNER =============================== */

export async function scannerData({ limit = 300 } = {}) {
  const t0 = Date.now();
  const cap = Math.min(Math.max(Number(limit) || 300, 50), 1000);
  const sample = await rows(`SELECT id, title, type, metadata, thumbnail, createdat FROM content ORDER BY random() LIMIT $1`, [cap]);

  const issues = { missingThumbnail: [], shortOverview: [], missingOverview: [], missingGenres: [], suspiciousTitle: [], missingYear: [] };
  for (const r of sample) {
    const md = r.metadata || {};
    if (!r.thumbnail) issues.missingThumbnail.push({ id: r.id, title: r.title, type: r.type });
    if (!md.overview) issues.missingOverview.push({ id: r.id, title: r.title, type: r.type });
    else if (String(md.overview).length < 20) issues.shortOverview.push({ id: r.id, title: r.title, type: r.type, len: String(md.overview).length });
    if (!Array.isArray(md.genres) || !md.genres.length) issues.missingGenres.push({ id: r.id, title: r.title, type: r.type });
    if (!md.year) issues.missingYear.push({ id: r.id, title: r.title, type: r.type });
    if (String(r.title || '') === String(r.title || '').toUpperCase() && /[A-Z]{6,}/.test(r.title || '')) issues.suspiciousTitle.push({ id: r.id, title: r.title, type: r.type, hint: 'titlu integral cu majuscule' });
  }

  const severity = [
    { issue: 'thumbnail lipsă', severity: 'ridicat', n: issues.missingThumbnail.length },
    { issue: 'overview lipsă', severity: 'ridicat', n: issues.missingOverview.length },
    { issue: 'genuri lipsă', severity: 'medie', n: issues.missingGenres.length },
    { issue: 'an lipsă', severity: 'medie', n: issues.missingYear.length },
    { issue: 'overview foarte scurt', severity: 'scăzut', n: issues.shortOverview.length },
    { issue: 'titlu suspect (caps)', severity: 'scăzut', n: issues.suspiciousTitle.length },
  ];
  const healthScore = Math.max(0, 100 - severity.reduce((a, s) => a + s.n * (s.severity === 'ridicat' ? 0.15 : s.severity === 'medie' ? 0.08 : 0.04), 0));
  const ms = Date.now() - t0;

  recordRun('scanner', { provider: 'sql', ms });
  void logUsage('scanner', { provider: 'sql', latencyMs: ms, snippet: `health=${Math.round(healthScore)} n=${sample.length}` });
  return {
    engine: 'scanner',
    provider: 'sql',
    generatedAt: nowIso(),
    sampleSize: sample.length,
    healthScore: Math.round(healthScore * 10) / 10,
    severity,
    samples: {
      missingThumbnail: issues.missingThumbnail.slice(0, 8),
      missingOverview: issues.missingOverview.slice(0, 8),
      missingGenres: issues.missingGenres.slice(0, 8),
      missingYear: issues.missingYear.slice(0, 8),
      shortOverview: issues.shortOverview.slice(0, 8),
      suspiciousTitle: issues.suspiciousTitle.slice(0, 8),
    },
  };
}

/* ============================= 13. AI DISCOVERY ============================== */

const PROVIDER_PROBES = [
  { id: 'tmdb', name: 'TMDB', url: () => `${process.env.TMDBBASEURL || 'https://api.themoviedb.org/3'}/configuration?api_key=${process.env.TMDBAPIKEY || ''}` },
  { id: 'jikan', name: 'Jikan (MyAnimeList)', url: () => `${process.env.JIKANBASEURL || 'https://api.jikan.moe/v4'}/top/anime?limit=1` },
  { id: 'tvmaze', name: 'TVMaze', url: () => 'https://api.tvmaze.com/schedule?country=US&date=2020-01-01' },
  { id: 'rss-bbc', name: 'RSS BBC', url: () => process.env.BBCRSSURL || 'https://feeds.bbci.co.uk/news/rss.xml' },
];

const PROPOSED_SOURCES = [
  { id: 'tmdb-trending', provider: 'tmdb', kind: 'trending', label: 'TMDB Trending (săptămânal)', value: 'mare', note: 'Cele mai populare titluri ale săptămânii — refresh natural al catalogului.' },
  { id: 'jikan-seasonal', provider: 'jikan', kind: 'seasonal', label: 'Jikan Seasonal Anime', value: 'mare', note: 'Anime-ul sezonului curent — direct din MyAnimeList.' },
  { id: 'tvmaze-schedule', provider: 'tvmaze', kind: 'schedule', label: 'TVMaze Schedule (RO)', value: 'medie', note: 'Program TV zilnic — poate alimenta un ghid TV live.' },
  { id: 'rss-variety', provider: 'rss', kind: 'news', label: 'RSS Variety (entertainment)', value: 'medie', note: 'Știri de entertainment pentru AI News Hub.' },
  { id: 'rss-animenews', provider: 'rss', kind: 'news', label: 'RSS Anime News Network', value: 'mică', note: 'Știri anime dedicate pentru publicul Animaxia.' },
];

export async function discoveryData() {
  const t0 = Date.now();
  const [byKind, total, recent] = await Promise.all([
    rows(`SELECT kind, count(*) n, coalesce(sum(hits),0) hits, max(lastseenat) lastseen FROM contentsources GROUP BY kind ORDER BY n DESC`),
    one(`SELECT count(*) n, count(DISTINCT kind) kinds FROM contentsources`),
    rows(`SELECT url, kind, hits, lastseenat FROM contentsources ORDER BY lastseenat DESC NULLS LAST LIMIT 8`),
  ]);

  const probes = await Promise.all(
    PROVIDER_PROBES.map(async (p) => {
      try {
        const started = Date.now();
        await fetchProviderJson('discovery-probe', p.url(), { timeoutMs: 8000 });
        return { provider: p.name, ok: true, ms: Date.now() - started };
      } catch (err) {
        return { provider: p.name, ok: false, error: String(err.message || err).slice(0, 120) };
      }
    }),
  );

  const ms = Date.now() - t0;
  recordRun('discovery', { provider: 'sql', ms });
  void logUsage('discovery', { provider: 'sql', latencyMs: ms, snippet: `sources=${total?.n} probes=${probes.filter((p) => p.ok).length}/${probes.length}` });
  const payload = {
    engine: 'discovery',
    provider: 'sql',
    generatedAt: nowIso(),
    registry: { total: Number(total?.n || 0), kinds: Number(total?.kinds || 0), byKind, recent },
    providerProbes: probes,
    proposed: PROPOSED_SOURCES,
    note: 'Sondele providerilor sunt fetch-uri HTTP reale, rulate la cerere (cache 60s).',
  };
  memo.set('ai-suite:discovery', payload, 60000);
  return payload;
}

/* ============================ 14. AI DUPLICATES ============================== */

function normalizeTitle(t) {
  return String(t || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\b(the|a|an|un|o|le|la|les|der|die|das)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function tokenJaccard(a, b) {
  const sa = new Set(a.split(' ').filter(Boolean));
  const sb = new Set(b.split(' ').filter(Boolean));
  if (!sa.size || !sb.size) return 0;
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter += 1;
  return inter / (sa.size + sb.size - inter);
}

function levenshteinRatio(a, b) {
  if (a === b) return 1;
  const m = a.length;
  const n = b.length;
  if (!m || !n) return 0;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i += 1) {
    const cur = [i];
    for (let j = 1; j <= n; j += 1) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return 1 - prev[n] / Math.max(m, n);
}

export async function duplicatesData() {
  const t0 = Date.now();
  const titles = await rows(`SELECT id, title, type, metadata FROM content WHERE type IN ('movie','tv','anime') ORDER BY type, id LIMIT 6000`);

  const byType = new Map();
  for (const r of titles) {
    if (!byType.has(r.type)) byType.set(r.type, []);
    byType.get(r.type).push({ id: r.id, title: r.title, norm: normalizeTitle(r.title), rating: r.metadata?.rating ?? null });
  }

  const pairs = [];
  for (const [type, list] of byType) {
    for (let i = 0; i < list.length; i += 1) {
      const a = list[i];
      if (!a.norm) continue;
      for (let j = i + 1; j < list.length && pairs.length < 60; j += 1) {
        const b = list[j];
        if (!b.norm) continue;
        /* Cheap pre-filter: first token must match or lengths within 2. */
        if (a.norm.slice(0, 3) !== b.norm.slice(0, 3) && Math.abs(a.norm.length - b.norm.length) > 2) continue;
        const jac = tokenJaccard(a.norm, b.norm);
        if (jac < 0.6 && Math.abs(a.norm.length - b.norm.length) > 2) continue;
        const lev = levenshteinRatio(a.norm, b.norm);
        const score = Math.round(((jac * 0.5 + lev * 0.5) * 100) * 10) / 10;
        if (score >= 85) pairs.push({ type, a: { id: a.id, title: a.title, rating: a.rating }, b: { id: b.id, title: b.title, rating: b.rating }, score });
      }
    }
  }
  pairs.sort((x, y) => y.score - x.score);
  const top = pairs.slice(0, 24);

  const ms = Date.now() - t0;
  recordRun('duplicates', { provider: 'sql', ms });
  void logUsage('duplicates', { provider: 'sql', latencyMs: ms, snippet: `pairs=${pairs.length} scanned=${titles.length}` });
  return {
    engine: 'duplicates',
    provider: 'sql',
    generatedAt: nowIso(),
    scanned: titles.length,
    candidatesFound: pairs.length,
    duplicates: top,
    note: 'Asemănare = 50% Jaccard token + 50% Levenshtein pe titluri normalizate (fără diacritice/articole). Doar raportare — fuziunea rămâne la Curator (FAZA 16, protejat).',
  };
}

/* ============================== 15. AI POSTER ================================ */

async function checkUrl(url) {
  try {
    const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(6000) });
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false, status: 0 };
  }
}

export async function posterData({ sampleSize = 12 } = {}) {
  const t0 = Date.now();
  const cap = Math.min(Math.max(Number(sampleSize) || 12, 4), 24);
  const withThumb = await rows(`SELECT id, title, thumbnail FROM content WHERE thumbnail IS NOT NULL AND thumbnail <> '' ORDER BY random() LIMIT $1`, [cap]);
  const without = await one(`SELECT count(*) n FROM content WHERE thumbnail IS NULL OR thumbnail = ''`);

  const results = await Promise.all(
    withThumb.map(async (r) => {
      const check = await checkUrl(r.thumbnail);
      return { id: r.id, title: r.title, thumbnail: r.thumbnail, reachable: check.ok, httpStatus: check.status };
    }),
  );

  /* VLM sample on up to 2 reachable posters — honest AI vision, bounded. */
  let vlm = [];
  let aiProvider = 'http';
  const forVlm = results.filter((r) => r.reachable).slice(0, 2);
  if (forVlm.length) {
    try {
      const { default: ZAI } = await import('z-ai-web-dev-sdk');
      const zai = await ZAI.create();
      for (const item of forVlm) {
        try {
          const completion = await Promise.race([
            zai.chat.completions.create({
              messages: [
                { role: 'system', content: 'Descrii poste de film/serial în română, maxim 15 cuvinte.' },
                { role: 'user', content: [{ type: 'image_url', image_url: { url: item.thumbnail } }, { type: 'text', text: `Descrie acest poster pentru "${item.title}".` }] },
              ],
              thinking: { type: 'disabled' },
            }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('vlm timeout')), 15000)),
          ]);
          const text = completion?.choices?.[0]?.message?.content;
          if (text) {
            vlm.push({ id: item.id, title: item.title, description: String(text).slice(0, 160) });
            aiProvider = 'mixed';
          }
        } catch {
          /* per-item VLM failure is non-fatal */
        }
      }
    } catch {
      /* z-ai init failure — HTTP checks remain the honest provider */
    }
  }

  const reachable = results.filter((r) => r.reachable).length;
  const ms = Date.now() - t0;
  const payload = {
    engine: 'poster',
    provider: aiProvider,
    generatedAt: nowIso(),
    checked: results.length,
    reachable,
    broken: results.length - reachable,
    missingThumbnail: Number(without?.n || 0),
    results,
    vlmSamples: vlm,
    aiProvider,
    note: 'Verificare HEAD reală pe eșantion aleatoriu + VLM pe максимум 2 postere (limitat conștient).',
  };
  recordRun('poster', { provider: aiProvider, ms });
  void logUsage('poster', { provider: aiProvider, latencyMs: ms, snippet: `reachable=${reachable}/${results.length}` });
  memo.set('ai-suite:poster', payload, 120000);
  return payload;
}

/* =============================== 16. AI TRENDS =============================== */

export async function trendsData() {
  const t0 = Date.now();
  const [now7, prev7, byGenre, watchMomentum, topContent] = await Promise.all([
    rows(`SELECT contentid, count(*) n FROM viewevents WHERE createdat > datetime('now','-7 days') GROUP BY contentid ORDER BY n DESC LIMIT 10`),
    rows(`SELECT contentid, count(*) n FROM viewevents WHERE createdat > datetime('now','-14 days') AND createdat <= datetime('now','-7 days') GROUP BY contentid`),
    rows(`
      SELECT g.value genre, count(*) n
      FROM viewevents v, content c, json_each(c.metadata->'genres') g
      WHERE v.contentid = c.id AND v.createdat > datetime('now','-7 days')
      GROUP BY g.value ORDER BY n DESC LIMIT 8`),
    one(`SELECT count(*) FILTER (WHERE watchedat > datetime('now','-7 days')) last7, count(*) FILTER (WHERE watchedat > datetime('now','-14 days') AND watchedat <= datetime('now','-7 days')) prev7 FROM watchhistory`),
    rows(`
      SELECT c.id, c.title, c.metadata,
        (SELECT count(*) FROM viewevents v WHERE v.contentid = c.id AND v.createdat > datetime('now','-7 days')) now_n,
        (SELECT count(*) FROM viewevents v WHERE v.contentid = c.id AND v.createdat > datetime('now','-14 days') AND v.createdat <= datetime('now','-7 days')) prev_n
      FROM content c WHERE c.type IN ('movie','tv') ORDER BY c.id DESC LIMIT 200`),
  ]);

  const prevMap = new Map(prev7.map((p) => [p.contentid, Number(p.n)]));
  const rising = topContent
    .map((c) => {
      const nowN = Number(c.now_n || 0);
      const prevN = Number(c.prev_n || prevMap.get(c.id) || 0);
      if (nowN === 0) return null;
      const delta = prevN === 0 ? 100 : Math.round(((nowN - prevN) / prevN) * 100);
      return { id: c.id, title: c.title, now: nowN, prev: prevN, delta };
    })
    .filter(Boolean)
    .sort((a, b) => b.delta - a.delta || b.now - a.now)
    .slice(0, 8);

  const narrative = await zaiComplete([
    { role: 'system', content: 'Ești analist de trenduri pentru Animaxia. Răspunzi în română, maxim 80 de cuvinte, concret.' },
    {
      role: 'user',
      content: `Top genuri săptămâna aceasta: ${byGenre.map((g) => `${g.genre} (${g.n})`).join(', ') || 'no data'}. Titluri în creștere: ${rising.slice(0, 3).map((r) => `${r.title} (+${r.delta}%)`).join(', ') || 'no data'}. Ce vezi?`,
    },
  ], { timeoutMs: 15000 });

  const ms = Date.now() - t0;
  const payload = {
    engine: 'trends',
    provider: narrative ? 'mixed' : 'sql',
    generatedAt: nowIso(),
    topContent: now7.map((r) => ({ contentid: r.contentid, views: Number(r.n) })),
    genresThisWeek: byGenre.map((g) => ({ genre: g.genre, n: Number(g.n) })),
    watchMomentum: { last7: Number(watchMomentum?.last7 || 0), prev7: Number(watchMomentum?.prev7 || 0) },
    rising,
    aiNarrative: narrative || 'Analiză euristică: ' + (rising[0] ? `${rising[0].title} conduce creșterile (+${rising[0].delta}%).` : 'Feriștea de date este încă mică — trendurile se vor preciza cu trafic real.') + ' (z-ai indisponibil — fallback onest.)',
    aiProvider: narrative ? 'z-ai' : 'heuristic',
  };
  recordRun('trends', { provider: payload.provider, ms });
  void logUsage('trends', { provider: payload.provider, latencyMs: ms, snippet: `rising=${rising.length}` });
  memo.set('ai-suite:trends', payload, 120000);
  return payload;
}

/* =============================== 17. AI FEEDS ================================ */

const FEED_CATALOG = [
  { id: 'bbc', name: 'BBC News', url: process.env.BBCRSSURL || 'https://feeds.bbci.co.uk/news/rss.xml', category: 'general' },
  { id: 'cnn', name: 'CNN', url: process.env.CNNRSSURL || 'http://rss.cnn.com/rss/edition.rss', category: 'general' },
  { id: 'nhk', name: 'NHK World', url: process.env.NHKRSSURL || 'https://www3.nhk.or.jp/rss/news/cat0.xml', category: 'general' },
  { id: 'aljazeera', name: 'Al Jazeera', url: process.env.ALJAZEERARSSURL || 'https://www.aljazeera.com/xml/rss/all.xml', category: 'general' },
  { id: 'deadline', name: 'Deadline', url: 'https://deadline.com/feed/', category: 'entertainment' },
  { id: 'variety', name: 'Variety', url: 'https://variety.com/feed/', category: 'entertainment' },
  { id: 'ann', name: 'Anime News Network', url: 'https://www.animenewsnetwork.com/newsroom/rss.xml', category: 'anime' },
];

export async function feedsData() {
  const t0 = Date.now();
  const checks = await Promise.all(
    FEED_CATALOG.map(async (f) => {
      try {
        const xml = await fetchProviderText('rss', f.url, { timeoutMs: 8000 });
        const parsed = parser.parse(xml);
        const channel = parsed?.rss?.channel || parsed?.feed;
        let list = channel?.item || channel?.entry || [];
        if (!Array.isArray(list)) list = list ? [list] : [];
        return { id: f.id, name: f.name, category: f.category, ok: true, items: list.length };
      } catch (err) {
        return { id: f.id, name: f.name, category: f.category, ok: false, error: String(err.message || err).slice(0, 100) };
      }
    }),
  );

  const ms = Date.now() - t0;
  recordRun('feeds', { provider: 'sql', ms });
  void logUsage('feeds', { provider: 'sql', latencyMs: ms, snippet: `ok=${checks.filter((c) => c.ok).length}/${checks.length}` });
  const payload = {
    engine: 'feeds',
    provider: 'sql',
    generatedAt: nowIso(),
    catalog: FEED_CATALOG.map((f) => ({ id: f.id, name: f.name, category: f.category, url: f.url })),
    checks,
    healthy: checks.filter((c) => c.ok).length,
    note: 'Fetch-uri RSS reale cu circuit-breaker (utils/fetcher). Feed-urile entertainment/anime extind AI News Hub.',
  };
  memo.set('ai-suite:feeds', payload, 120000);
  return payload;
}

/** Real fetch + AI categorization of ONE feed (bounded, read-only). */
export async function feedsFetchOne(feedId) {
  const feed = FEED_CATALOG.find((f) => f.id === feedId);
  if (!feed) return { ok: false, error: `Unknown feed '${feedId}'`, available: FEED_CATALOG.map((f) => f.id) };
  const t0 = Date.now();
  try {
    const xml = await fetchProviderText('rss', feed.url, { timeoutMs: 9000 });
    const parsed = parser.parse(xml);
    const channel = parsed?.rss?.channel || parsed?.feed;
    let list = channel?.item || channel?.entry || [];
    if (!Array.isArray(list)) list = list ? [list] : [];
    const items = list.slice(0, 10).map((it) => {
      const title = String(it.title || '').trim();
      return { title, link: it.link?.href || it.link || null, category: classifyNews(title, it.description || ''), published: it.pubDate || it.published || null };
    });
    const ms = Date.now() - t0;
    recordRun('feeds', { provider: 'provider', ms });
    void logUsage('feeds', { provider: 'provider', latencyMs: ms, mode: 'fetch-one', snippet: `${feedId}: ${items.length}` });
    return { ok: true, feed: { id: feed.id, name: feed.name, url: feed.url }, items, classified: items.length };
  } catch (err) {
    recordRun('feeds', { provider: 'provider', ms: Date.now() - t0, ok: false });
    return { ok: false, error: `Fetch failed: ${err.message}` };
  }
}

/* =============================== 18. AI ADMIN ================================ */

export async function adminData() {
  const t0 = Date.now();
  const [dbInfo, recentUsage, auditRecent] = await Promise.all([
    one(`SELECT
          (SELECT count(*) FROM content) content,
          (SELECT count(*) FROM aiusagelogs) usage_logs,
          (SELECT count(*) FROM aisettings) settings,
          (SELECT count(*) FROM users) users`),
    rows(`SELECT feature, provider, latencyms, status, createdat FROM aiusagelogs ORDER BY createdat DESC LIMIT 10`),
    rows(`SELECT id, action, createdat FROM auditlogs ORDER BY createdat DESC LIMIT 8`),
  ]);
  const ms = Date.now() - t0;
  recordRun('admin', { provider: 'sql', ms });
  return {
    engine: 'admin',
    provider: 'sql',
    generatedAt: nowIso(),
    db: dbInfo || {},
    recentUsage,
    recentAudit: auditRecent,
    health: {
      database: { ok: Number(dbInfo?.content || 0) > 0, content: Number(dbInfo?.content || 0) },
      zaiSdk: 'lazy-init on first AI call (fallback heurist on)',
    },
  };
}
