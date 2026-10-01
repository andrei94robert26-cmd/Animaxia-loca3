-- ============================================================
-- ANIMAXIA REAL 10M (AR10M) — SCHEMA SQL CONSOLIDATĂ
-- Schema reală, minimală, pentru catalogul de până la 10 milioane titluri.
-- Idempotentă: poți rula oricând (IF NOT EXISTS peste tot).
-- Sursa de adevăr în cod: modules/ar10m/schema.js (AR10M_DDL).
-- Aplicare: bun scripts/ar10m-setup.mjs (schema + backfill legacy + seed real).
-- ============================================================

-- 1. Schema dedicată arhitecturii reale --------------------------------
CREATE SCHEMA IF NOT EXISTS ar10m;

-- 2. Sursele video — deduplicate prin source_hash UNIQUE (AR10M §2) ----
-- Aceeași sursă nu se înregistrează niciodată de două ori.
CREATE TABLE IF NOT EXISTS ar10m.content_sources (
  id          SERIAL PRIMARY KEY,
  source_type TEXT NOT NULL CHECK (source_type IN
              ('direct_url','youtube','rumble','iframe','embed','hls')),
  source_url  TEXT NOT NULL,
  embed_code  TEXT,                      -- DOAR iframe sanitizat din allowlist (allowlist.js)
  source_hash TEXT NOT NULL UNIQUE,      -- sha256(source_type + '|' + normalized_url)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. Catalogul minimal — DOAR câmpurile reale (AR10M §2) ----------------
CREATE TABLE IF NOT EXISTS ar10m.content (
  id              INTEGER PRIMARY KEY,   -- 1:1 cu legacy public.content unde există (navigare UI)
  title           TEXT NOT NULL,
  normalized_title TEXT NOT NULL,        -- lowercase, fără diacritice/punctuație (normalize.js)
  year            INTEGER,
  source_id       INTEGER REFERENCES ar10m.content_sources(id) ON DELETE SET NULL,
  shard_id        SMALLINT NOT NULL,     -- fnv1a(normalized_title + ':' + year) % 15 — stabil pentru totdeauna
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4. Indexuri pentru motorul de căutare real (AR10M §4) -----------------
-- Prefix search indexabil (text_pattern_ops): LIKE 'prefix%' = index scan.
-- LIKE '%text%' (wildcard la început) este INTERZIS în gateway.
CREATE INDEX IF NOT EXISTS idx_ar10m_ntitle_prefix ON ar10m.content (normalized_title text_pattern_ops);
CREATE INDEX IF NOT EXISTS idx_ar10m_year          ON ar10m.content (year);
CREATE INDEX IF NOT EXISTS idx_ar10m_ntitle_year   ON ar10m.content (normalized_title, year);
CREATE INDEX IF NOT EXISTS idx_ar10m_shard         ON ar10m.content (shard_id);
CREATE INDEX IF NOT EXISTS idx_ar10m_source        ON ar10m.content (source_id);

-- 5. Benchmark sintetic — marcat explicit, NICIODATĂ în catalogul public -
CREATE TABLE IF NOT EXISTS ar10m.bench_catalog (
  id              SERIAL PRIMARY KEY,
  batch_id        TEXT NOT NULL,         -- prefix 'synthetic-'
  normalized_title TEXT NOT NULL,
  year            INTEGER,
  shard_id        SMALLINT NOT NULL,
  synthetic       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ar10m_bench_ntitle ON ar10m.bench_catalog (normalized_title text_pattern_ops);

-- 6. Legacy: coloană ADITIVĂ pentru fuziunea în căutarea reală ----------
-- public.content (29.192 intrări TMDB reale) rămâne INTACT — regula
-- „nu șterge date reale". Doar o coloană derivată + index prefix:
ALTER TABLE public.content ADD COLUMN IF NOT EXISTS normalized_title TEXT;
-- backfill: bun scripts/ar10m-setup.mjs (batchuri de 500, JS normalizeTitle)
CREATE INDEX IF NOT EXISTS idx_content_ntitle_prefix ON public.content (normalized_title text_pattern_ops);
CREATE INDEX IF NOT EXISTS idx_content_ntitle_year   ON public.content (normalized_title, id);

-- ============================================================
-- CE NU SE STOCHEAZĂ ÎN NEON (AR10M §2, regula utilizatorului):
--   postere, thumbnails, fișiere video, date simulate, embeddings AI,
--   descrieri, actori, genuri, categorii, HTML duplicat, surse duplicate.
-- Thumbnails trăiesc pe tabletă (AR10M §7, /thumb/:id).
-- Metadatele legacy TMDB rămân în public.content DOAR pentru navigarea
-- existentă (date reale, păstrate — plan de retragere graduală în
-- AUDIT-REPORT.md). Nu se mai SCRIE nimic nou de tipul acestora.
-- ============================================================

-- Verificare rapidă (manual):
-- SELECT COUNT(*) FROM ar10m.content;          -- titluri reale
-- SELECT COUNT(*) FROM ar10m.content_sources;  -- surse reale (unice)
-- SELECT shard_id, COUNT(*) FROM ar10m.content GROUP BY shard_id ORDER BY shard_id;
-- SELECT pg_total_relation_size('ar10m.content') AS content_bytes,
--        pg_indexes_size('ar10m.content')       AS index_bytes;
