/**
 * tasks/thumbnail.mjs — worker task: generate branded SVG poster placeholders
 * (400x600) for content rows that lack artwork. The poster design is fully
 * deterministic: two HSL gradient stops derived from an FNV-1a hash of the
 * title, so the same title always renders the same artwork.
 *
 * workerData:
 *   { missing: true }              → batch over rows WHERE thumbnail IS NULL (LIMIT 50)
 *   { contentId: <number> }        → the single row (explicit regeneration allowed)
 * posts: { ok: true, generated: n, files: [names] } | { ok: false, error }
 *
 * FAZA 16-a: the SVG text is stored in the Neon `thumbnailcache` table
 * (file = '{contentid}.svg', svg, contentid); data/thumbnails/ on disk is a
 * fallback only (used when the postgres driver is unavailable). Files are
 * served by GET /api/workers/thumbnails/:file (table first, disk on miss).
 */

import fs from 'node:fs';
import path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';

dotenv.config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });

const THUMBNAILS_DIR = fileURLToPath(new URL('../../../data/thumbnails/', import.meta.url));

/* --------------------------------- SVG poster -------------------------------- */

/** Deterministic 32-bit FNV-1a hash of a string. */
function hashString(str) {
  let h = 2166136261;
  const text = String(str || '');
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Escape XML-special characters for safe embedding in SVG text nodes. */
function escapeXml(value) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&apos;', '"': '&quot;' };
  return String(value).replace(/[&<>'"]/g, (c) => map[c]);
}

/** Greedy word-wrap: build lines of at most maxChars chars (max maxLines). */
function wrapWords(words, maxChars, maxLines) {
  const lines = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > maxChars && current) {
      lines.push(current);
      current = word;
      if (lines.length === maxLines) break;
    } else if (candidate.length > maxChars) {
      // A single over-long word — hard-split it.
      for (let i = 0; i < candidate.length; i += maxChars) {
        lines.push(candidate.slice(i, i + maxChars));
        if (lines.length === maxLines) break;
      }
      current = '';
    } else {
      current = candidate;
    }
  }
  if (lines.length < maxLines && current) lines.push(current);
  // Truncate the last line with an ellipsis when the title was cut short.
  if (lines.length === maxLines) {
    const last = lines[maxLines - 1];
    if (last.length > maxChars - 1) lines[maxLines - 1] = `${last.slice(0, maxChars - 1)}…`;
  }
  return lines;
}

/** Build the 400x600 poster SVG for one content row. */
function buildPosterSvg(row) {
  const title = String(row.title || 'Untitled');
  const type = String(row.type || 'title');
  const hash = hashString(title);
  const hue1 = hash % 360;
  const hue2 = (hue1 + 40 + ((hash >> 8) % 80)) % 360;
  const c1 = `hsl(${hue1}, 62%, 16%)`;
  const c2 = `hsl(${hue2}, 68%, 38%)`;

  const words = title.split(/\s+/).filter(Boolean).slice(0, 3); // first 3 words
  const lines = wrapWords(words, 16, 4);
  const fontSize = lines.length >= 4 ? 30 : lines.length === 3 ? 34 : 40;
  const lineHeight = Math.round(fontSize * 1.25);
  const firstLineY = 310 - Math.round(((lines.length - 1) * lineHeight) / 2);

  const titleSpans = lines
    .map(
      (line, i) =>
        `    <text x="200" y="${firstLineY + i * lineHeight}" font-size="${fontSize}" fill="#ffffff" opacity="0.96">${escapeXml(line)}</text>`,
    )
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600" viewBox="0 0 400 600" role="img" aria-label="${escapeXml(title)} poster">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${c1}"/>
      <stop offset="100%" stop-color="${c2}"/>
    </linearGradient>
    <radialGradient id="glow" cx="50%" cy="42%" r="65%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.16"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="400" height="600" fill="url(#bg)"/>
  <rect width="400" height="600" fill="url(#glow)"/>
  <circle cx="${60 + (hash % 60)}" cy="${140 + ((hash >> 5) % 80)}" r="${90 + ((hash >> 3) % 60)}" fill="#000000" opacity="0.14"/>
  <circle cx="${300 - ((hash >> 7) % 70)}" cy="${430 + ((hash >> 11) % 60)}" r="${70 + ((hash >> 9) % 50)}" fill="#ffffff" opacity="0.07"/>
  <g font-family="'Segoe UI', 'Helvetica Neue', Arial, sans-serif" text-anchor="middle">
    <g transform="translate(200 60)">
      <rect x="-58" y="-16" width="116" height="32" rx="16" fill="#000000" opacity="0.45"/>
      <text y="6" font-size="15" font-weight="700" fill="#ffffff" letter-spacing="2">${escapeXml(type.toUpperCase())}</text>
    </g>
    <g font-weight="800">
${titleSpans}
    </g>
    <text x="200" y="566" font-size="15" fill="#ffffff" opacity="0.55" letter-spacing="7">ANIMAXIA</text>
    <rect x="168" y="578" width="64" height="3" rx="1.5" fill="#ffffff" opacity="0.35"/>
  </g>
</svg>
`;
}

/* ---------------------------------- task body -------------------------------- */

try {
  const { contentId, missing } = workerData || {};
  const { initDb, closeDb, query } = await import('../../../db.js');

  await initDb();

  let targets = [];
  if (missing) {
    const res = await query('SELECT id, title, type FROM content WHERE thumbnail IS NULL ORDER BY id LIMIT 50');
    targets = res.rows || [];
  } else if (contentId != null) {
    const res = await query('SELECT id, title, type FROM content WHERE id = $1', [Number(contentId)]);
    targets = res.rows || [];
  } else {
    throw new Error('thumbnail task requires contentId or missing=true');
  }

  const files = [];
  for (const row of targets) {
    const svg = buildPosterSvg(row);
    const name = `${row.id}.svg`;
    // FAZA 16-a: SVG text is stored in the Neon `thumbnailcache` table
    // (file = '{contentid}.svg') instead of disk; disk remains a fallback.
    try {
      await query(
        `INSERT INTO thumbnailcache (file, svg, contentid) VALUES ($1, $2, $3)
         ON CONFLICT (file) DO UPDATE SET svg = EXCLUDED.svg, contentid = EXCLUDED.contentid`,
        [name, svg, row.id],
      );
    } catch (dbErr) {
      // Table unavailable (local-fallback driver) — write to disk instead.
      fs.mkdirSync(THUMBNAILS_DIR, { recursive: true });
      fs.writeFileSync(path.join(THUMBNAILS_DIR, name), svg, 'utf8');
      void dbErr;
    }
    files.push(name);
  }

  await closeDb();
  parentPort.postMessage({ ok: true, generated: files.length, files });
} catch (err) {
  try {
    const { closeDb } = await import('../../../db.js');
    await closeDb();
  } catch {
    /* pool may never have opened */
  }
  parentPort.postMessage({ ok: false, error: err?.message || String(err) });
}
