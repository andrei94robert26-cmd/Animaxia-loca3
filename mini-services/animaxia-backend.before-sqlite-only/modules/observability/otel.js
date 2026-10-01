/**
 * modules/observability/otel.js — FAZA 23 (observability): instrumentare
 * OpenTelemetry ADITIVĂ pentru monolitul Animaxia.
 *
 * CE FACE (observare pură — comportamentul request-urilor NU se schimbă):
 *   1. setupObservability(app) — montat din server.js imediat DUPĂ
 *      resilienceMiddleware și ÎNAINTE de prima rută:
 *        • middleware de span: req._otelStart + spanId random; la res.on('finish')
 *          construiește un span HTTP {traceId: req.traceId (EXISTENT din TS3 —
 *          middleware-ul W3C din server.js rulează ÎNAINTE, deci req.traceId e
 *          deja setat; NU generăm alt traceId)}, îl înregistrează în registry-ul
 *          local de familii FAZA 23 și îl pune în batch queue-ul de export;
 *        • hook one-shot pe res.json DOAR pentru GET /api/content/:id/player —
 *          citește lanțul de fallback din corpul răspunsului ÎNAINTE de
 *          serializare (body.sources?.length + body.mode — forma reală a
 *          răspunsului resolvePlayer() din modules/player/player.js:
 *          {content, mode: 'direct'|'trailer'|'none', allowedTypes, sources[],
 *           primary?, note?}). Body-ul NU este alterat niciodată;
 *        • instrumentPipeline() — wrap pipeline.execute (FAZA 18) pe OBIECTUL
 *          exportat: const orig = pipeline.execute; pipeline.execute = wrapped.
 *          search.js apelează pipeline.execute(...) ca property access la
 *          RUNTIME, deci vede wrap-ul. Comportament 100% identic: aceeași
 *          valoare rezolvată / aceeași rejecție re-aruncată NEALTERATĂ, fără
 *          try/catch care să înghită erori (doar cronometru + înregistrare
 *          span în .then/.catch cu pas-through);
 *        • batch exporter: la 2s SAU 50 spans → POST OTLP JSON canonic către
 *          ${OTEL_EXPORTER_ENDPOINT:-http://localhost:4050}/v1/traces
 *          (collectorul global FAZA 23 construit de agentul 23-a), timeout
 *          AbortController 2000ms, .catch(()=>{}) SILENT, timer .unref().
 *
 *   2. observabilityMetricsHandler(req, res) — GET /api/observability/metrics
 *      (montată în server.js imediat după /api/metrics, publică ca și /api/metrics
 *      — doar date agregate): familii NOI FAZA 23 (hub/ai/auth/player/otel) +
 *      re-expunerea pipeline-ului FAZA 18 prin surse PULL zero-overhead pe
 *      request path (pipeline.perStageCounts() + pipeline.stagesSnapshot()
 *      sunt citite DOAR la scrape). Prometheus text (default) sau ?format=json.
 *
 * REGULI DE PURITATE:
 *   • ZERO dependențe noi (fetch nativ, node:crypto, timers — doar built-in).
 *   • EȘECURI SILENȚIOASE: observabilitatea NU poate afecta platforma. Orice
 *     eroare de export/observare e înghițită și numărată doar în
 *     animaxia_otel_export_errors_total (niciodată log-uită "loud").
 *   • normalizeRoute e IMPORTAT din ../ops/metrics.js (reutilizare, nu duplicare).
 *   • Backpressure: coada de span-uri e limitată la 500; când se umple se
 *     aruncă jumătate deodată (drop-oldest amortizat, O(1) amortizat per push)
 *     — contor onest animaxia_otel_spans_dropped_total.
 *   • Env: OTEL_ENABLED (default '1'; '0' = doar contori locali, fără export),
 *     OTEL_EXPORTER_ENDPOINT (default http://localhost:4050).
 *
 * ONESTITATE TRACING (pipeline): pipeline.execute e apelat din search.js cu un
 * job {kind, client, query, params, executor, priority} — executor-ele sunt
 * closure-uri care NU expun req, deci NU există acces request-scoped la
 * req.traceId din wrap (AsyncLocalStorage ar fi invaziv — respins intenționat).
 * DECI: span-urile de pipeline primesc traceId PROPRIU random 32hex, corelabil
 * cu request-ul HTTP prin atributul pipeline.kind + timestamp. Documentat onest.
 */

import crypto from 'node:crypto';
import { normalizeRoute } from '../ops/metrics.js'; // FAZA 9: reutilizăm normalizarea de rute (cardinalitate bounded)
import pipeline from '../search/pipeline.js'; // FAZA 18: obiectul exportat — wrap la runtime, nu la module eval

/* --------------------------------- config ---------------------------------- */

const OTEL_ENABLED = (process.env.OTEL_ENABLED ?? '1') !== '0';
const OTEL_EXPORTER_ENDPOINT = (process.env.OTEL_EXPORTER_ENDPOINT || 'http://localhost:4050').replace(/\/+$/, '');
const EXPORT_INTERVAL_MS = 2_000;   // flush la 2s …
const EXPORT_BATCH_SIZE = 50;       // … sau 50 de span-uri
const SPAN_QUEUE_LIMIT = 500;       // backpressure safety — drop-oldest când e plină
const EXPORT_TIMEOUT_MS = 2_000;    // AbortController pe POST-ul OTLP
const SERVICE_NAME = 'animaxia-backend';

/* -------------------------------- registry --------------------------------- */
/* Contori in-memory (nu array-uri per request — zero GC pressure pe hot path). */

const registry = {
  startedAt: Date.now(),
  families: new Map(), // family → Map(route → {count, totalMs, errors})
  authEvents: new Map(), // result ('ok'|'error') → count
  playerRequests: 0,
  playerPlaybackErrors: 0, // status >= 400 pe /api/content/:id/player
  playerResumeEvents: 0, // POST /api/users/me/history (FAZA 21 recordHistory)
  playerSubtitleRequests: 0, // GET /api/player/subtitles/content/:id/subtitles
  playerFallbackChain: new Map(), // `${mode}|${levels}` → count (din res.json hook)
  spansExported: 0,
  exportErrors: 0,
  spansDropped: 0,
};

/* Batch queue de span-uri OTLP (limită 500, drop-oldest amortizat). */
const spanQueue = [];
let flushing = false;
let flushScheduled = false;

/* ------------------------------ route families ------------------------------ */

/**
 * Clasificare pe familii FAZA 23 (etichete bounded, rute normalizate prin
 * normalizeRoute). Ordinea contează: 'history' înainte de alte prefixe /api/users.
 */
function classifyFamily(route) {
  if (route.startsWith('/api/hub')) return 'hub';
  if (route.startsWith('/api/ai')) return 'ai';
  if (route.startsWith('/api/auth')) return 'auth';
  if (route === '/api/content/:id/player' || route.startsWith('/api/player')) return 'player';
  if (route === '/api/users/me/history') return 'history';
  if (route.startsWith('/api/playlists')) return 'playlists';
  if (route.startsWith('/api/users/me/stats') || route.startsWith('/api/admin/playerhub')) return 'stats';
  if (route.startsWith('/api/search')) return 'search';
  return null; // restul platformei nu face parte din familiile FAZA 23
}

function familyEntry(family, route) {
  let byRoute = registry.families.get(family);
  if (!byRoute) {
    byRoute = new Map();
    registry.families.set(family, byRoute);
  }
  let slot = byRoute.get(route);
  if (!slot) {
    slot = { count: 0, totalMs: 0, errors: 0 };
    byRoute.set(route, slot);
  }
  return slot;
}

function bumpMap(map, key, value = 1) {
  map.set(key, (map.get(key) || 0) + value);
}

/** Ruta exactă publică de listing subtitrări (modules/player/subtitles.js). */
function isSubtitleListingPath(path) {
  return /^\/api\/player\/subtitles\/content\/\d+\/subtitles\/?$/.test(String(path || ''));
}

/**
 * Full request path (fără query) din req.originalUrl. NOTĂ: în Express 4, după ce
 * un router montat (ex. subtitlesRouter la '/api/player/subtitles') gestionează
 * ruta FĂRĂ next(), req.url rămâne STRIPPED de prefixul de mount ('/content/2/subtitles')
 * — la res.on('finish') req.path nu mai e calea completă. req.originalUrl e setat
 * o singură dată la intrare și rămâne ÎNTOTDEAUNA calea completă — singura sursă
 * sigură pentru verificările de rută din hook-uri asincrone.
 */
function fullPathOf(req) {
  return String(req.originalUrl || req.url || '').split('?')[0].split('#')[0];
}

/* ------------------------------ span plumbing ------------------------------- */

function randomHex(chars) {
  return crypto.randomBytes(chars / 2).toString('hex');
}

/** Push un span în coada de export (public pentru test în izolare/ops tooling). */
export function otelPushSpan(span) {
  try {
    if (spanQueue.length >= SPAN_QUEUE_LIMIT) {
      // drop-half amortizat: un splice O(n) la fiecare 250 de push-uri
      const drop = SPAN_QUEUE_LIMIT >> 1;
      spanQueue.splice(0, drop);
      registry.spansDropped += drop;
    }
    spanQueue.push(span);
    if (spanQueue.length >= EXPORT_BATCH_SIZE) maybeScheduleFlush();
  } catch {
    /* silent — observability never breaks the platform */
  }
}

function maybeScheduleFlush() {
  if (flushScheduled || flushing) return;
  flushScheduled = true;
  const t = setTimeout(() => {
    flushScheduled = false;
    void flushSpans();
  }, 0);
  if (typeof t.unref === 'function') t.unref();
}

/** OTLP JSON canonic pentru un lot de span-uri (service.name = animaxia-backend). */
function toOtlpPayload(spans) {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [{ key: 'service.name', value: { stringValue: SERVICE_NAME } }],
        },
        scopeSpans: [
          {
            scope: { name: 'animaxia-observability', version: '1.0.0' },
            spans: spans.map((s) => {
              const out = {
                traceId: s.traceId,
                spanId: s.spanId,
                name: s.name,
                kind: 1,
                startTimeUnixNano: String(BigInt(Math.max(0, Math.trunc(s.startMs))) * 1000000n),
                endTimeUnixNano: String(BigInt(Math.max(0, Math.trunc(s.endMs))) * 1000000n),
                status: { code: s.status >= 500 ? 2 : 1 }, // 1=OK, 2=ERROR
                attributes: Object.entries(s.attributes || {}).map(([key, v]) => ({
                  key,
                  value: typeof v === 'number' && Number.isInteger(v) ? { intValue: v } : { stringValue: String(v) },
                })),
              };
              if (s.parentSpanId) out.parentSpanId = s.parentSpanId; // canonical: root span = câmp absent
              return out;
            }),
          },
        ],
      },
    ],
  };
}

/** Flush batch (≤50 spans) către collector — SILENT pe orice eșec. */
async function flushSpans() {
  if (flushing || spanQueue.length === 0) return;
  flushing = true;
  const batch = spanQueue.splice(0, EXPORT_BATCH_SIZE);
  try {
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), EXPORT_TIMEOUT_MS);
    const res = await fetch(`${OTEL_EXPORTER_ENDPOINT}/v1/traces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(toOtlpPayload(batch)),
      signal: ac.signal,
    });
    clearTimeout(to);
    if (res.ok) {
      registry.spansExported += batch.length;
    } else {
      registry.exportErrors += 1;
      registry.spansDropped += batch.length; // lot pierdut onest — fără requeue (backpressure)
    }
  } catch {
    registry.exportErrors += 1;
    registry.spansDropped += batch.length; // collector jos / timeout — silent
  } finally {
    flushing = false;
  }
}

/** Flush imediat (test în izolare / drain manual). */
export async function otelFlushNow() {
  await flushSpans();
}

/* --------------------------- HTTP span middleware --------------------------- */

/** Hook one-shot pe res.json — DOAR pentru GET /api/content/:id/player. */
function attachPlayerBodyObserver(req, res) {
  if (req.method !== 'GET' || !/^\/api\/content\/\d+\/player\/?$/.test(fullPathOf(req))) return;
  const orig = res.json.bind(res);
  let observed = false; // one-shot: prima serializare JSON a răspunsului
  res.json = (body) => {
    try {
      if (!observed && body && typeof body === 'object') {
        observed = true;
        // Forma reală a răspunsului resolvePlayer() (modules/player/player.js):
        // { content, mode, allowedTypes, sources: [{type,url,label}], primary?, note? }
        const levels = Array.isArray(body.sources) ? body.sources.length : 0;
        bumpMap(registry.playerFallbackChain, `${String(body.mode ?? 'unknown')}|${levels}`);
      }
    } catch {
      /* silent — niciodată nu alterăm sau blocăm body-ul */
    }
    return orig(body); // body-ul trece NEALTERAT
  };
}

function observabilitySpanMiddleware(req, res, next) {
  try {
    req._otelStart = Date.now();
    req._otelSpanId = randomHex(16);
    attachPlayerBodyObserver(req, res);
    res.on('finish', () => {
      try {
        const endMs = Date.now();
        const route = normalizeRoute(req.originalUrl || req.url);
        const family = classifyFamily(route);
        const status = res.statusCode | 0;
        const durationMs = endMs - (req._otelStart || endMs);

        /* registry familii FAZA 23 (contori in-memory) */
        if (family) {
          const slot = familyEntry(family, route);
          slot.count += 1;
          slot.totalMs += durationMs;
          if (status >= 400) slot.errors += 1;
        }

        /* contori specifici numiți în contractul FAZA 23 */
        if (family === 'auth') {
          bumpMap(registry.authEvents, status < 400 ? 'ok' : 'error');
        }
        if (route === '/api/content/:id/player') {
          registry.playerRequests += 1;
          if (status >= 400) registry.playerPlaybackErrors += 1;
        }
        if (family === 'history' && req.method === 'POST') {
          registry.playerResumeEvents += 1; // resume events (FAZA 21 recordHistory)
        }
        if (isSubtitleListingPath(fullPathOf(req))) {
          registry.playerSubtitleRequests += 1;
        }

        /* span HTTP — traceId-ul EXISTENT din TS3 (middleware W3C rulează înainte) */
        otelPushSpan({
          traceId: /^[0-9a-f]{32}$/.test(String(req.traceId || '')) ? req.traceId : randomHex(32),
          spanId: req._otelSpanId || randomHex(16),
          parentSpanId: '',
          name: `${req.method} ${route}`,
          kind: 1,
          startMs: req._otelStart || endMs,
          endMs,
          status,
          attributes: {
            'http.method': String(req.method || ''),
            'http.route': route,
            'http.status_code': status,
            'http.url': fullPathOf(req),
          },
        });
      } catch {
        /* silent */
      }
    });
  } catch {
    /* silent — observability never blocks a request */
  }
  next();
}

/* --------------------------- pipeline wrap (FAZA 18) ------------------------ */

/**
 * Wrap pipeline.execute pe obiectul exportat. Idempotent (guard pe numele
 * wrap-ului). search.js apelează pipeline.execute(...) ca property access la
 * runtime → vede wrap-ul. ESM module cache: obiectul e același.
 */
function instrumentPipeline() {
  try {
    if (typeof pipeline.execute !== 'function') return;
    if (pipeline.execute.name === 'otelWrappedExecute') return; // deja instrumentat
    const orig = pipeline.execute;
    const wrapped = function (...args) {
      const startMs = Date.now();
      const job = args[0] || {};
      const kind = String(job.kind ?? 'search');
      // Onest: span de pipeline cu traceId PROPRIU (job-ul nu expune req.traceId —
      // vezi nota de onestitate din header). Corelare: pipeline.kind + timestamp.
      const traceId = randomHex(32);
      const parentSpanId = randomHex(16);
      const emit = (name, status, extraAttrs, start, end) => {
        otelPushSpan({
          traceId,
          spanId: randomHex(16),
          parentSpanId,
          name,
          kind: 1,
          startMs: start,
          endMs: end,
          status,
          attributes: { 'pipeline.kind': kind, ...(extraAttrs || {}) },
        });
      };
      let result;
      try {
        result = orig.apply(pipeline, args); // apel SINCRON identic (layers 1-4 rulează în același tick)
      } catch (err) {
        emit(`pipeline.layer${err && err.layer != null ? err.layer : 'x'}.reject`, (err && err.status) || 500, {
          'http.status_code': (err && err.status) || 500,
        }, startMs, Date.now());
        throw err; // rejecție sincronă NEALTERATĂ
      }
      if (!result || typeof result.then !== 'function') return result; // non-promise identic
      return result.then(
        (res) => {
          const endMs = Date.now();
          const source = res && typeof res === 'object' ? String(res.source ?? 'unknown') : 'unknown';
          // span părinte — durata REALĂ a pipeline.execute
          emit('pipeline.execute', 200, { 'pipeline.source': source }, startMs, endMs);
          // span copil după sursă (formele reale din pipeline.js: hit|miss|cooldown)
          if (source === 'hit') emit('pipeline.layer9.cache.hit', 200, {}, endMs, endMs);
          else if (source === 'cooldown') emit('pipeline.layer3.cooldown.served', 200, {}, endMs, endMs);
          else if (source === 'miss') emit('pipeline.layer10.neon-fts.executed', 200, {}, endMs, endMs);
          return res; // valoarea rezolvată IDENTICĂ
        },
        (err) => {
          const endMs = Date.now();
          const layer = err && err.layer != null ? err.layer : null; // PipelineRejection: err.layer din payload
          emit('pipeline.execute', (err && err.status) || 500, { 'pipeline.rejected': 'true' }, startMs, endMs);
          if (layer != null) {
            emit(`pipeline.layer${layer}.reject`, (err && err.status) || 429, {
              'http.status_code': (err && err.status) || 429,
            }, endMs, endMs);
          }
          throw err; // rejecție NEALTERATĂ (err propagate exact cum a venit)
        },
      );
    };
    Object.defineProperty(wrapped, 'name', { value: 'otelWrappedExecute', configurable: true });
    pipeline.execute = wrapped; // property pe obiectul exportat — search.js vede wrap-ul la runtime
  } catch {
    /* silent — dacă wrap-ul eșuează, pipeline-ul rulează neinstrumentat */
  }
}

/* --------------------------------- setup ------------------------------------ */

/**
 * Montat din server.js imediat DUPĂ resilienceMiddleware, ÎNAINTE de prima
 * rută. Pure additive: niciun import/rută/middleware existent nu se schimbă.
 */
export function setupObservability(app) {
  try {
    app.use(observabilitySpanMiddleware);
    instrumentPipeline();
    /* NEON FREE PLAN: fostul timer permanent de flush la 2s a fost eliminat
     * (I/O continuu chiar și cu zero trafic). Export on-demand:
     *   1. batch plin (≥50 spans) → flush imediat prin maybeScheduleFlush (există);
     *   2. la SCRAPE (/api/metrics, /api/observability/metrics) → drain parțial
     *      exact când cineva (Prometheus/utilizator) citește metricile. */
    if (OTEL_ENABLED) {
      app.use((req, _res, next) => {
        try {
          if (req.method === 'GET' && (req.path === '/api/metrics' || req.path === '/api/observability/metrics')) {
            void flushSpans();
          }
        } catch {
          /* silent */
        }
        next();
      });
    }
  } catch {
    /* silent — observability must never break boot */
  }
}

/* ------------------------------ metrics render ------------------------------ */

function esc(v) {
  return String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/** Snapshot structurat (pentru ?format=json) — surse pull citite DOAR aici. */
function buildSnapshot() {
  const families = {};
  for (const [family, byRoute] of registry.families) {
    families[family] = {};
    for (const [route, slot] of byRoute) {
      families[family][route] = { ...slot, avgMs: slot.count > 0 ? Math.round(slot.totalMs / slot.count) : 0 };
    }
  }
  let pipelineCounts = null;
  let pipelineStages = null;
  try {
    pipelineCounts = pipeline.perStageCounts();
    pipelineStages = pipeline.stagesSnapshot();
  } catch {
    pipelineCounts = null; // honest degrade
    pipelineStages = null;
  }
  const fallbackChain = {};
  for (const [key, n] of registry.playerFallbackChain) {
    const [mode, levels] = key.split('|');
    fallbackChain[`${mode}:${levels}`] = n;
  }
  return {
    service: SERVICE_NAME,
    uptimeSec: Math.floor(process.uptime()),
    generatedAt: new Date().toISOString(),
    otel: {
      enabled: OTEL_ENABLED,
      endpoint: OTEL_EXPORTER_ENDPOINT,
      spansExported: registry.spansExported,
      exportErrors: registry.exportErrors,
      spansDropped: registry.spansDropped,
      queueLength: spanQueue.length,
    },
    families,
    auth: Object.fromEntries(registry.authEvents),
    player: {
      requests: registry.playerRequests,
      playbackErrors: registry.playerPlaybackErrors,
      resumeEvents: registry.playerResumeEvents,
      subtitleRequests: registry.playerSubtitleRequests,
      fallbackChain,
    },
    pipeline: { counts: pipelineCounts, stages: pipelineStages },
  };
}

/** Text Prometheus — familiile NOI FAZA 23 + re-expunerea pipeline-ului (pull). */
function renderPrometheusText() {
  const L = [];
  const emit = (line) => L.push(line);
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

  /* ---- familiile generice (route-family counters, alimentate la finish) ---- */
  emit('# TYPE animaxia_family_requests_total counter');
  emit('# TYPE animaxia_family_duration_ms_sum counter');
  emit('# TYPE animaxia_family_errors_total counter');
  for (const [family, byRoute] of registry.families) {
    for (const [route, slot] of byRoute) {
      const lb = `family="${esc(family)}",route="${esc(route)}"`;
      emit(`animaxia_family_requests_total{${lb}} ${slot.count}`);
      emit(`animaxia_family_duration_ms_sum{${lb}} ${Math.round(slot.totalMs)}`);
      emit(`animaxia_family_errors_total{${lb}} ${slot.errors}`);
    }
  }

  /* ---- hub: contori + durate pe familia de rută ---- */
  emit('# TYPE animaxia_hub_requests_total counter');
  emit('# TYPE animaxia_hub_duration_ms_sum counter');
  emit('# TYPE animaxia_hub_duration_ms_count counter');
  const hub = registry.families.get('hub');
  if (hub) {
    for (const [route, slot] of hub) {
      emit(`animaxia_hub_requests_total{route="${esc(route)}"} ${slot.count}`);
      emit(`animaxia_hub_duration_ms_sum{route="${esc(route)}"} ${Math.round(slot.totalMs)}`);
      emit(`animaxia_hub_duration_ms_count{route="${esc(route)}"} ${slot.count}`);
    }
  }

  /* ---- ai usage ---- */
  emit('# TYPE animaxia_ai_usage_calls_total counter');
  emit('# TYPE animaxia_ai_usage_errors_total counter');
  const ai = registry.families.get('ai');
  if (ai) {
    for (const [route, slot] of ai) {
      emit(`animaxia_ai_usage_calls_total{route="${esc(route)}"} ${slot.count}`);
      emit(`animaxia_ai_usage_errors_total{route="${esc(route)}"} ${slot.errors}`);
    }
  }

  /* ---- auth events ---- */
  emit('# TYPE animaxia_auth_events_total counter');
  for (const [result, n] of registry.authEvents) {
    emit(`animaxia_auth_events_total{result="${esc(result)}"} ${n}`);
  }

  /* ---- player ---- */
  emit('# TYPE animaxia_player_requests_total counter');
  emit(`animaxia_player_requests_total ${registry.playerRequests}`);
  emit('# TYPE animaxia_player_playback_errors_total counter');
  emit(`animaxia_player_playback_errors_total ${registry.playerPlaybackErrors}`);
  emit('# TYPE animaxia_player_resume_events_total counter');
  emit(`animaxia_player_resume_events_total ${registry.playerResumeEvents}`);
  emit('# TYPE animaxia_player_subtitle_requests_total counter');
  emit(`animaxia_player_subtitle_requests_total ${registry.playerSubtitleRequests}`);
  emit('# TYPE animaxia_player_fallback_chain_total counter');
  for (const [key, n] of registry.playerFallbackChain) {
    const [mode, levels] = key.split('|');
    emit(`animaxia_player_fallback_chain_total{mode="${esc(mode)}",levels="${esc(levels)}"} ${n}`);
  }

  /* ---- otel export (contori interni — niciodată log-uitți loud) ---- */
  emit('# TYPE animaxia_otel_spans_exported_total counter');
  emit(`animaxia_otel_spans_exported_total ${registry.spansExported}`);
  emit('# TYPE animaxia_otel_export_errors_total counter');
  emit(`animaxia_otel_export_errors_total ${registry.exportErrors}`);
  emit('# TYPE animaxia_otel_spans_dropped_total counter');
  emit(`animaxia_otel_spans_dropped_total ${registry.spansDropped}`);
  emit('# TYPE animaxia_otel_span_queue_length gauge');
  emit(`animaxia_otel_span_queue_length ${spanQueue.length}`);
  emit('# TYPE animaxia_observability_enabled gauge');
  emit(`animaxia_observability_enabled ${OTEL_ENABLED ? 1 : 0}`);

  /* ---- pipeline FAZA 18 — surse PULL zero-overhead (câmpuri REALE) ---- */
  try {
    const c = pipeline.perStageCounts();
    emit('# TYPE animaxia_pipeline_antispam_hits_total counter');
    emit(`animaxia_pipeline_antispam_hits_total ${num(c.antiSpamRejected)}`);
    emit('# TYPE animaxia_pipeline_ratelimit_hits_total counter');
    emit(`animaxia_pipeline_ratelimit_hits_total ${num(c.rateLimited)}`);
    emit('# TYPE animaxia_pipeline_cooldown_served_total counter');
    emit(`animaxia_pipeline_cooldown_served_total ${num(c.cooldownServed)}`);
    emit('# TYPE animaxia_pipeline_cooldown_deprioritized_total counter');
    emit(`animaxia_pipeline_cooldown_deprioritized_total ${num(c.cooldownDeprioritized)}`);
    emit('# TYPE animaxia_pipeline_queue_rejected_total counter');
    emit(`animaxia_pipeline_queue_rejected_total ${num(c.queueRejected)}`);
    emit('# TYPE animaxia_pipeline_queue_enqueued_total counter');
    emit(`animaxia_pipeline_queue_enqueued_total ${num(c.enqueued)}`);
    emit('# TYPE animaxia_pipeline_queue_dispatched_total counter');
    emit(`animaxia_pipeline_queue_dispatched_total ${num(c.dispatched)}`);
    emit('# TYPE animaxia_pipeline_dedup_total counter');
    emit(`animaxia_pipeline_dedup_total ${num(c.coalesced)}`);
    emit('# TYPE animaxia_pipeline_cache_hits_total counter');
    emit(`animaxia_pipeline_cache_hits_total ${num(c.cacheHits)}`);
    emit('# TYPE animaxia_pipeline_cache_misses_total counter');
    emit(`animaxia_pipeline_cache_misses_total ${num(c.cacheMisses)}`);
    emit('# TYPE animaxia_pipeline_executed_total counter');
    emit(`animaxia_pipeline_executed_total ${num(c.executed)}`);
    emit('# TYPE animaxia_pipeline_executor_errors_total counter');
    emit(`animaxia_pipeline_executor_errors_total ${num(c.executorErrors)}`);
    emit('# TYPE animaxia_pipeline_windowing_batches_total counter');
    emit(`animaxia_pipeline_windowing_batches_total ${num(c.batches)}`);
    emit('# TYPE animaxia_pipeline_batched_queries_total counter');
    emit(`animaxia_pipeline_batched_queries_total ${num(c.batchedQueries)}`);
    emit('# TYPE animaxia_pipeline_window_deferred_total counter');
    emit(`animaxia_pipeline_window_deferred_total ${num(c.windowDeferred)}`);
  } catch {
    /* honest degrade: pipeline pull indisponibil */
  }
  try {
    const stages = pipeline.stagesSnapshot();
    const byName = {};
    for (const s of stages) byName[s.name] = s.stats || {};
    emit('# TYPE animaxia_pipeline_queue_length gauge');
    emit(`animaxia_pipeline_queue_length ${num(byName.queue?.queueDepth)}`);
    emit('# TYPE animaxia_pipeline_queue_inflight gauge');
    emit(`animaxia_pipeline_queue_inflight ${num(byName.queue?.inflight)}`);
    emit('# TYPE animaxia_pipeline_windowing_executions_per_sec gauge');
    emit(`animaxia_pipeline_windowing_executions_per_sec ${num(byName.windowing?.executionsPerSec)}`);
    emit('# TYPE animaxia_pipeline_dedup_inflight gauge');
    emit(`animaxia_pipeline_dedup_inflight ${num(byName.dedup?.inflight)}`);
    emit('# TYPE animaxia_pipeline_cache_keys gauge');
    emit(`animaxia_pipeline_cache_keys ${num(byName.cache?.keys)}`);
    emit('# TYPE animaxia_pipeline_cache_hit_ratio gauge');
    emit(`animaxia_pipeline_cache_hit_ratio ${num(byName.cache?.hitRate)}`);
    emit('# TYPE animaxia_pipeline_executor_latency_p50_ms gauge');
    emit(`animaxia_pipeline_executor_latency_p50_ms ${num(byName['neon-fts']?.p50Ms)}`);
    emit('# TYPE animaxia_pipeline_executor_latency_p95_ms gauge');
    emit(`animaxia_pipeline_executor_latency_p95_ms ${num(byName['neon-fts']?.p95Ms)}`);
    emit('# TYPE animaxia_pipeline_executor_inflight gauge');
    emit(`animaxia_pipeline_executor_inflight ${num(byName['neon-fts']?.inflight)}`);
  } catch {
    /* honest degrade */
  }

  emit('# TYPE animaxia_uptime_seconds gauge');
  emit(`animaxia_uptime_seconds ${Math.floor(process.uptime())}`);

  return `${L.join('\n')}\n`;
}

/**
 * GET /api/observability/metrics — handler unic (req/res), public ca /api/metrics.
 * Prometheus text (default) sau ?format=json. Doar date agregate.
 */
export function observabilityMetricsHandler(req, res) {
  try {
    if (req.query && req.query.format === 'json') {
      return res.json(buildSnapshot());
    }
    res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    return res.send(renderPrometheusText());
  } catch {
    return res.status(500).json({ error: 'observability_metrics_failed' }); // niciodată fără răspuns
  }
}

export default { setupObservability, observabilityMetricsHandler, otelPushSpan, otelFlushNow };
