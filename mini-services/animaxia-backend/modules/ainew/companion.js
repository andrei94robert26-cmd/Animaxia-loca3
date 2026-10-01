/**
 * modules/ainew/companion.js — FAZA 35 (WS5): AI Companion — chat contextual
 * pe titlu, RAG peste sinopsis + recenzii reale (tabela `reviews`, join
 * `users` pentru username — users ARE are coloana username, verificat în
 * schemă). 100% READ-ONLY pe DB; provider etichetat onest.
 */

import { getContentById } from '../../db.js';
import { rows, one, zaiComplete, memo, nowIso } from './common.js';

/* ------------------------------ context build ------------------------------- */

/** Titlu + sinopsis + recenzii + notă medie — payloadul RAG (memo 120s). */
export async function buildContext(contentId) {
  const content = await getContentById(contentId);
  if (!content) return { content: null, context: null };

  const meta = content.metadata && typeof content.metadata === 'object' ? content.metadata : {};
  const synopsis = String(meta.overview ?? meta.synopsis ?? '').trim();
  const genres = Array.isArray(meta.genres) ? meta.genres.slice(0, 8) : [];

  /* Recenzii reale (max 3, cele mai recente) + username prin LEFT JOIN users
   * (coloana username există în users — verificat în migrations.js); o revie
   * fără user (FK SET NULL nu există pe reviews, dar defensive oricum). */
  let reviews = [];
  let avgRating = null;
  let dbNote = null;
  try {
    reviews = await rows(
      `SELECT r.id, r.userid, u.username, r.rating, r.body
         FROM reviews r LEFT JOIN users u ON u.id = r.userid
        WHERE r.contentid = $1
        ORDER BY r.id DESC LIMIT 3`,
      [contentId],
    );
    const agg = await one(
      `SELECT ROUND(AVG(rating), 1) AS avg, COUNT(*) AS n FROM reviews WHERE contentid = $1`,
      [contentId],
    );
    if (agg && Number(agg.n) > 0) avgRating = Number(agg.avg);
  } catch {
    dbNote = 'recenziile nu sunt disponibile momentan (sursa SQL indisponibilă)';
  }

  const context = {
    contentId,
    title: content.title,
    type: content.type ?? null,
    year: meta.year ?? null,
    synopsis: synopsis || null,
    genres,
    rating: meta.rating != null ? Number(meta.rating) : null,
    avgRating, // nota medie din recenziile reale
    reviews: reviews.map((r) => ({
      id: Number(r.id),
      userid: Number(r.userid),
      username: r.username ?? null,
      rating: Number(r.rating),
      body: String(r.body ?? '').slice(0, 300),
    })),
    ...(dbNote ? { note: dbNote } : {}),
  };
  return { content, context };
}

/** companionData(contentId) — contextul cache-uit 120s per titlu; null când
 *  conținutul nu există (niciodată memoizat — lookup-ul rămâne onest). */
export async function companionData(contentId) {
  const key = `ai-lab:companion:${contentId}`;
  const cached = memo.get(key);
  if (cached) return cached;
  const { content, context } = await buildContext(contentId);
  if (!content) return null;
  return memo.set(key, context, 120000);
}

/* --------------------------------- chat ------------------------------------- */

const ROLE_WHITELIST = ['user', 'assistant'];
const MAX_MESSAGES = 8;
const SYNOPSIS_PROMPT_LIMIT = 1200;

/** Sistem RAG în română: răspunde despre ACEST titlu, din contextul dat. */
function buildSystemPrompt(context) {
  const lines = [
    'Ești AI Companionul platformei Animaxia. Răspunzi ÎN ROMÂNĂ, prietenos și concis (maxim 150 de cuvinte).',
    `Titlul curent: ${context.title}${context.year ? ` (${context.year})` : ''}${context.type ? `, tip: ${context.type}` : ''}.`,
    'Răspunzi DOAR despre acest titlu și despre experiența utilizatorului cu el.',
  ];
  if (context.genres.length > 0) lines.push(`Genuri: ${context.genres.join(', ')}.`);
  if (context.rating != null) lines.push(`Notă catalog: ${context.rating}.`);
  if (context.avgRating != null) lines.push(`Nota medie a recenziilor utilizatorilor: ${context.avgRating}.`);
  if (context.synopsis) {
    lines.push(`Sinopsis (sursa ta principală): ${context.synopsis.slice(0, SYNOPSIS_PROMPT_LIMIT)}`);
  }
  if (context.reviews.length > 0) {
    lines.push(
      'Recenzii reale ale utilizatorilor (fără spoilere, citate scurte):',
      ...context.reviews.map((r) => `- ${r.username ?? `user ${r.userid}`} (${r.rating}/10): ${r.body}`),
    );
  }
  lines.push(
    'Reguli oneste: dacă informația cerută NU se află în contextul de mai sus, spune clar că nu o știi din sursele disponibile („nu am această informație în contextul titlului").',
    'Nu dezvălui spoilere dincolo de sinopsis. Nu inventa fapte, actori sau episoade.',
  );
  return lines.join('\n');
}

/** Deterministic fallback: primele 2 propoziții din sinopsis + notă onestă. */
function heuristicAnswer(context) {
  if (context.synopsis) {
    const sentences = context.synopsis
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const head = sentences.slice(0, 2).join(' ');
    return {
      answer: `${head}\n\n(Notă: răspuns generat din sinopsisul disponibil — serviciul AI este momentan indisponibil.)`,
      provider: 'heuristic',
    };
  }
  return {
    answer: `„${context.title}" este disponibil pe Animaxia${context.genres.length ? ` (genuri: ${context.genres.join(', ')})` : ''}. Nu am sinopsisul în context ca să-ți dau detalii despre subiect — serviciul AI este momentan indisponibil.`,
    provider: 'heuristic',
  };
}

/**
 * companionChat({ contentId, messages, user }) — validare strictă, ultimele
 * max 8 mesaje păstrate, apel z-ai cu fallback determinist onest.
 * Returnează { ok, contentId, title, answer, provider, usedMessages } sau
 * { error, status } — rutele traduc status-ul.
 */
export async function companionChat({ contentId, messages, user = null }) {
  const context = await companionData(contentId);
  if (!context) return { status: 404, error: 'Conținut inexistent' };

  if (!Array.isArray(messages) || messages.length === 0) {
    return { status: 400, error: 'messages (array {role, content}) este obligatoriu' };
  }
  for (const m of messages) {
    if (!m || typeof m !== 'object' || !ROLE_WHITELIST.includes(m.role)) {
      return { status: 400, error: 'fiecare mesaj trebuie { role: "user"|"assistant", content: string }' };
    }
    if (typeof m.content !== 'string' || m.content.trim().length === 0 || m.content.length > 2000) {
      return { status: 400, error: 'content-ul mesajului trebuie un string nevid de max 2000 de caractere' };
    }
  }

  /* Contract: păstrăm ULTIMELE 8 mesaje (cele mai recente) — onest raportat. */
  const kept = messages.slice(-MAX_MESSAGES).map((m) => ({ role: m.role, content: m.content.trim() }));

  const answer = await zaiComplete([
    { role: 'system', content: buildSystemPrompt(context) },
    ...kept,
  ]);

  const fallback = heuristicAnswer(context);
  return {
    ok: true,
    contentId,
    title: context.title,
    answer: answer ?? fallback.answer,
    provider: answer ? 'z-ai' : 'heuristic',
    usedMessages: kept.length,
    ...(user ? { user: user.id } : {}),
    generatedAt: nowIso(),
  };
}
