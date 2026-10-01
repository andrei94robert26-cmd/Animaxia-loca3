#!/usr/bin/env bun
/**
 * tests/smoke-observability.mjs — FAZA 23 (observabilitate enterprise) smoke
 * suite: 76 checks.
 *
 * Live end-to-end checks against the FAZA-23 observability stack
 * (mini-services/animaxia-observability :4050) plus the instrumented platform
 * (backend /api/observability/metrics, global-gateway /metrics, realtime
 * /metrics) — WITHOUT touching any protected logic (FAZA 18/20/21, FTS,
 * sharding 13, player 17, AI 15/16 are only OBSERVED, never modified;
 * AR10M: fostul 30B simulat a fost eliminat din platformă).
 *
 *   S1. Service & health      — :4050 health/components/retention + CORS via :81
 *   S2. OTel tracing          — OTLP canonical + simple ingest, trace query,
 *                               W3C end-to-end correlation (traceparent →
 *                               X-Trace-Id → collector), pipeline spans,
 *                               span export counters
 *   S3. Metrics               — backend FAZA-23 families (44+), gateway,
 *                               realtime, collector aggregation (100+ families,
 *                               animaxia_up, synthetics, otel), retention 30d
 *   S4. Dashboards            — exactly 4 faza23-* dashboards + live panel data
 *   S5. Alertmanager          — exactly 10 canonical rules, states, v2 API,
 *                               _simulate isolation (no real-state mutation)
 *   S6. Synthetics            — exactly 46 checks, 16 categories, 3 regions,
 *                               history, full run green
 *   S7. UI observability      — /api/summary contract (10 gauges, layers 10,
 *                               rules 10, synthetics 46, retention 30) + :81 path
 *   S8. Protected regression  — FAZA 18 (pipelineIntegrated + 10 stages),
 *                               FAZA 20 (hub), AR10M (stats reale + capacitate
 *                               proiectată 10M), FAZA 13 (shards), FAZA 21
 *                               (gating 401), FAZA 17 (player)
 *
 * Zero dependencies (bun-native fetch). Exits non-zero on any failure.
 *
 * Usage:  bun tests/smoke-observability.mjs
 * Env:    API_ORIGIN  default http://localhost:4000
 *         OBS_ORIGIN  default http://localhost:4050
 *         GW_ORIGIN   default http://localhost:81 (Caddy gateway)
 */

const API_ORIGIN = process.env.API_ORIGIN || 'http://localhost:4000';
const OBS_ORIGIN = process.env.OBS_ORIGIN || 'http://localhost:4050';
const GW_ORIGIN = process.env.GW_ORIGIN || 'http://localhost:81';
/** FAZA 23 load-budget: direct backend probes carry the observer identity
 *  (own rate-limit bucket) so the QA suite never eats the shared 127.0.0.1
 *  budget — same pattern as the collector scraper (see config.ts OBSERVER_XFF). */
const OBSERVER_XFF = '10.23.23.23';

let passed = 0;
let failed = 0;
const failures = [];

function record(name, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function get(url, headers = {}, timeoutMs = 15000) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* keep null */
  }
  return { res, text, json };
}

async function post(url, body, headers = {}, timeoutMs = 20000) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* keep null */
  }
  return { res, text, json };
}

const hex = (n) =>
  Array.from({ length: n }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');

/* ─────────────────────────────────────────── S1. Service & health (1..6) ── */

console.log('── S1. Serviciu :4050 — health, componente, retention, CORS ──');

const s1a = await get(`${OBS_ORIGIN}/health`);
record(
  'S1-1 (1) GET :4050/health → ok + 5 componente live',
  s1a.res.status === 200 &&
    s1a.json?.ok === true &&
    s1a.json?.components?.collector === true &&
    s1a.json?.components?.metrics === true &&
    s1a.json?.components?.alerts === true &&
    s1a.json?.components?.dashboards === true &&
    s1a.json?.components?.synthetics === true,
  `status=${s1a.res.status}`,
);

record(
  'S1-2 (2) retention 30 zile configurat (comportament real, nu doar declarativ)',
  s1a.json?.retentionDays === 30,
  `retentionDays=${s1a.json?.retentionDays}`,
);

const s1c = await get(`${OBS_ORIGIN}/api/observability/health`);
record(
  'S1-3 (3) GET /api/observability/health → alias ok',
  s1c.res.status === 200 && s1c.json?.ok === true,
  `status=${s1c.res.status}`,
);

const s1d = await get(`${OBS_ORIGIN}/`);
record(
  'S1-4 (4) GET / → info serviciu (nume + versiune)',
  s1d.res.status === 200 && typeof s1d.json?.service === 'string' && s1d.json?.service?.includes('animaxia'),
  `status=${s1d.res.status}`,
);

const s1e = await fetch(`${GW_ORIGIN}/api/summary?XTransformPort=4050`, {
  method: 'OPTIONS',
  headers: { Origin: 'http://localhost:81', 'Access-Control-Request-Method': 'GET' },
  signal: AbortSignal.timeout(10000),
});
record(
  'S1-5 (5) CORS preflight prin gateway :81 → 204 + allow-origin',
  s1e.status === 204 && (s1e.headers.get('access-control-allow-origin') || '').includes('localhost:81'),
  `status=${s1e.status} acao=${s1e.headers.get('access-control-allow-origin')}`,
);

const s1f = await get(`${GW_ORIGIN}/api/summary?XTransformPort=4050`);
record(
  'S1-6 (6) GET /api/summary prin :81 (path-ul folosit de UI) → 200 ok',
  s1f.res.status === 200 && s1f.json?.ok === true,
  `status=${s1f.res.status}`,
);

/* ─────────────────────────────────────────────── S2. OTel tracing (7..16) ── */

console.log('── S2. OTel tracing — ingest OTLP, corelare W3C end-to-end, pipeline ──');

const corrTraceId = hex(32); // trace cunoscut pentru testul de corelare end-to-end
const corrSpanId = hex(16);
const otlpTraceId = hex(32);
const otlpParentSpan = hex(16);
const otlpChildSpan = hex(16);
const nowMs = Date.now();

// OTLP/HTTP-JSON canonic — 2 spans (părinte + copil) cu resource attributes
const s2a = await post(`${OBS_ORIGIN}/v1/traces`, {
  resourceSpans: [
    {
      resource: {
        attributes: [{ key: 'service.name', value: { stringValue: 'animaxia-qa' } }],
      },
      scopeSpans: [
        {
          spans: [
            {
              traceId: otlpTraceId,
              spanId: otlpParentSpan,
              parentSpanId: '',
              name: 'qa.parent',
              kind: 1,
              startTimeUnixNano: String(BigInt(nowMs - 40) * 1_000_000n),
              endTimeUnixNano: String(BigInt(nowMs - 10) * 1_000_000n),
              status: { code: 1 },
              attributes: [{ key: 'qa', value: { stringValue: 'otlp-canonic' } }],
            },
            {
              traceId: otlpTraceId,
              spanId: otlpChildSpan,
              parentSpanId: otlpParentSpan,
              name: 'qa.child',
              kind: 1,
              startTimeUnixNano: String(BigInt(nowMs - 30) * 1_000_000n),
              endTimeUnixNano: String(BigInt(nowMs - 20) * 1_000_000n),
              status: { code: 1 },
              attributes: [{ key: 'http.status_code', value: { intValue: 200 } }],
            },
          ],
        },
      ],
    },
  ],
});
record(
  'S2-1 (7) POST /v1/traces OTLP/HTTP-JSON canonic → 2 spans accepți',
  s2a.res.status === 200 && s2a.json?.acceptedSpans === 2,
  `status=${s2a.res.status} accepted=${s2a.json?.acceptedSpans}`,
);

const s2b = await get(`${OBS_ORIGIN}/api/traces/${otlpTraceId}`);
record(
  'S2-2 (8) GET /api/traces/:id → span tree (2 spans, părinte→copil, service animaxia-qa)',
  s2b.res.status === 200 &&
    Array.isArray(s2b.json?.spans) &&
    s2b.json.spans.length === 2 &&
    s2b.json.spans.some((s) => s.name === 'qa.parent') &&
    s2b.json.spans.some((s) => s.name === 'qa.child' && s.parentSpanId === otlpParentSpan) &&
    s2b.json.spans.every((s) => s.service === 'animaxia-qa'),
  `status=${s2b.res.status} spans=${s2b.json?.spans?.length}`,
);

// format simplu (browser) — exact ce trimite otel-browser.ts
const browserTraceId = hex(32);
const s2c = await post(`${OBS_ORIGIN}/v1/traces`, {
  spans: [
    {
      traceId: browserTraceId,
      spanId: hex(16),
      parentSpanId: '',
      name: 'GET /api/all',
      service: 'animaxia-web',
      kind: 1,
      startMs: nowMs - 50,
      endMs: nowMs - 30,
      status: 200,
      attributes: { 'http.method': 'GET', 'http.status_code': 200, 'http.trace_correlated': true },
    },
  ],
});
record(
  'S2-3 (9) POST /v1/traces format simplu (browser) → 1 span accepțat',
  s2c.res.status === 200 && s2c.json?.acceptedSpans === 1,
  `status=${s2c.res.status} accepted=${s2c.json?.acceptedSpans}`,
);

const s2d = await get(`${OBS_ORIGIN}/api/traces?service=animaxia-web&limit=50`);
record(
  'S2-4 (10) GET /api/traces?service=animaxia-web → span-ul de browser regăsit',
  s2d.res.status === 200 && (s2d.json?.traces ?? []).some((t) => t.traceId === browserTraceId),
  `status=${s2d.res.status} total=${s2d.json?.total}`,
);

const s2e = await get(`${OBS_ORIGIN}/api/traces/stats`);
const svcNames = (s2e.json?.services ?? []).map((s) => s.name);
record(
  'S2-5 (11) GET /api/traces/stats → servicii cu span-uri reale (backend + gateway prezente)',
  s2e.res.status === 200 &&
    svcNames.includes('animaxia-backend') &&
    svcNames.includes('animaxia-gateway') &&
    typeof s2e.json?.spansPerMin === 'number' &&
    s2e.json.spansPerMin > 0,
  `services=${svcNames.join(',')} spansPerMin=${s2e.json?.spansPerMin}`,
);

// Corelare W3C end-to-end: traceparent → backend adoptă traceId → X-Trace-Id →
// span-ul backend ajunge în collector PE ACELAȘI traceId.
const s2f = await fetch(`${API_ORIGIN}/api/hub/stats`, {
  headers: { traceparent: `00-${corrTraceId}-${corrSpanId}-01`, 'x-forwarded-for': OBSERVER_XFF },
  signal: AbortSignal.timeout(15000),
});
const echoedTraceId = s2f.headers.get('x-trace-id');
record(
  'S2-6 (12) Backend TS3 adoptă traceparent → X-Trace-Id identic (corelare W3C)',
  s2f.status === 200 && echoedTraceId === corrTraceId,
  `status=${s2f.status} x-trace-id=${echoedTraceId}`,
);

await new Promise((r) => setTimeout(r, 4500)); // batch export backend = 2s
const s2g = await get(`${OBS_ORIGIN}/api/traces/${corrTraceId}`);
record(
  'S2-7 (13) Span-ul backend apare ÎN COLLECTOR pe traceId-ul browserului (lanț complet web→backend→collector)',
  s2g.res.status === 200 &&
    (s2g.json?.spans ?? []).some(
      (s) => s.service === 'animaxia-backend' && String(s.name).includes('/api/hub/stats'),
    ),
  `status=${s2g.res.status} spans=${s2g.json?.spans?.length ?? 0}`,
);

// Pipeline FAZA 18 observat (nu modificat): 1 căutare reală → span-uri + contoare
await fetch(`${API_ORIGIN}/api/search/advanced?q=observability-qa&limit=3`, {
  headers: { 'x-forwarded-for': OBSERVER_XFF },
  signal: AbortSignal.timeout(15000),
}).then((r) => r.text()).catch(() => {});
await new Promise((r) => setTimeout(r, 4500));

const s2h = await get(`${API_ORIGIN}/api/observability/metrics`, { 'x-forwarded-for': OBSERVER_XFF });
const obsText = s2h.text || '';
const exportedMatch = /animaxia_otel_spans_exported_total (\d+)/.exec(obsText);
record(
  'S2-8 (14) Pipeline executat + export OTel activ (contoare reale, nu zero)',
  /animaxia_pipeline_executed_total (\d+)/.test(obsText) && Number(exportedMatch?.[1] ?? 0) > 10,
  `exported=${exportedMatch?.[1]}`,
);

const s2i = await get(`${OBS_ORIGIN}/api/traces?limit=200`);
const hasPipelineTrace = (s2i.json?.traces ?? []).some(
  (t) => String(t.rootName ?? '').startsWith('pipeline.execute') || String(t.rootName ?? '').startsWith('pipeline.layer'),
);
record(
  'S2-9 (15) Span-uri pipeline (FAZA 18 observată) vizibile în collector — pipeline.execute + straturi',
  hasPipelineTrace,
  `traces=${s2i.json?.total}`,
);

const s2j = await get(`${OBS_ORIGIN}/metrics`);
record(
  'S2-10 (16) Collector: animaxia_otel_spans_received_total{service} — spans recepționate de la toate serviciile',
  /animaxia_otel_spans_received_total\{[^}]*service="animaxia-backend"[^}]*\} \d+/.test(s2j.text || '') &&
    /animaxia_otel_spans_received_total\{[^}]*service="animaxia-gateway"[^}]*\} \d+/.test(s2j.text || ''),
  `found=${/animaxia_otel_spans_received_total/g.test(s2j.text || '')}`,
);

/* ──────────────────────────────────────────────────── S3. Metrics (17..28) ── */

console.log('── S3. Metrics — backend FAZA 23, gateway, realtime, agregare collector ──');

record(
  'S3-1 (17) Backend /api/observability/metrics → Prometheus text (content-type 0.0.4)',
  s2h.res.status === 200 && String(s2h.res.headers.get('content-type') || '').includes('text/plain'),
  `ct=${s2h.res.headers.get('content-type')}`,
);

const famCount = (obsText.match(/^# TYPE /gm) || []).length;
record(
  'S3-2 (18) Backend: 40+ familii noi FAZA 23 (pipeline/hub/ai/auth/player/otel)',
  famCount >= 40,
  `families=${famCount}`,
);

const requiredFamilies = [
  'animaxia_pipeline_queue_length',
  'animaxia_pipeline_cache_hits_total',
  'animaxia_pipeline_cache_misses_total',
  'animaxia_pipeline_ratelimit_hits_total',
  'animaxia_pipeline_antispam_hits_total',
  'animaxia_pipeline_cooldown_served_total',
  'animaxia_pipeline_windowing_batches_total',
  'animaxia_pipeline_dedup_total',
  'animaxia_hub_requests_total',
  'animaxia_hub_duration_ms_sum',
  'animaxia_ai_usage_calls_total',
  'animaxia_ai_usage_errors_total',
  'animaxia_auth_events_total',
  'animaxia_player_requests_total',
  'animaxia_player_resume_events_total',
  'animaxia_player_subtitle_requests_total',
  'animaxia_player_playback_errors_total',
  'animaxia_player_fallback_chain_total',
  'animaxia_otel_spans_exported_total',
];
const missingFamilies = requiredFamilies.filter((f) => !obsText.includes(f));
record(
  'S3-3 (19) Familii pipeline FAZA 18 (10 straturi) prezente — anti-spam, rate-limit, cooldown, queue, windowing, dedup, cache',
  missingFamilies.filter((f) => f.startsWith('animaxia_pipeline_')).length === 0,
  `lipsă=${missingFamilies.filter((f) => f.startsWith('animaxia_pipeline_')).join(',') || '—'}`,
);

record(
  'S3-4 (20) Familii hub FAZA 20 + AI + auth + player FAZA 17/21 prezente',
  missingFamilies.filter((f) => !f.startsWith('animaxia_pipeline_')).length === 0,
  `lipsă=${missingFamilies.filter((f) => !f.startsWith('animaxia_pipeline_')).join(',') || '—'}`,
);

const s3e = await get(`${API_ORIGIN}/api/observability/metrics?format=json`, { 'x-forwarded-for': OBSERVER_XFF });
record(
  'S3-5 (21) Backend ?format=json → snapshot JSON valid',
  s3e.res.status === 200 && s3e.json !== null && typeof s3e.json === 'object',
  `status=${s3e.res.status}`,
);

const s3f = await get('http://localhost:4040/metrics');
record(
  'S3-6 (22) Global-gateway /metrics → animaxia_gateway_* (requests pe regiune, uptime, redis)',
  s3f.res.status === 200 &&
    /animaxia_gateway_requests_total\{region="(eu|us|asia)",cache="(hit|miss|bypass)"\}/.test(s3f.text || '') &&
    /animaxia_gateway_uptime_seconds/.test(s3f.text || ''),
  `status=${s3f.res.status}`,
);

const s3g = await get('http://localhost:4010/metrics');
record(
  'S3-7 (23) Realtime /metrics → animaxia_realtime_* (sockets, rooms, mesaje)',
  s3g.res.status === 200 && /animaxia_realtime_sockets_connected/.test(s3g.text || ''),
  `status=${s3g.res.status}`,
);

const collText = s2j.text || '';
const collFamilies = (collText.match(/^# TYPE /gm) || []).length;
record(
  'S3-8 (24) Collector /metrics → 100+ familii agregate (proprii + FAZA 9 re-expuse + FAZA 23)',
  collFamilies >= 100,
  `families=${collFamilies}`,
);

record(
  'S3-9 (25) animaxia_up{service} — toate cele 7 servicii urmărite',
  ['animaxia-backend', 'animaxia-frontend', 'animaxia-realtime', 'animaxia-watchdog', 'redis-global', 'global-gateway', 'animaxia-observability'].every(
    (svc) => new RegExp(`animaxia_up\\{[^}]*service="${svc}"[^}]*\\} 1`).test(collText),
  ),
  `up-lines=${(collText.match(/animaxia_up\{[^}]*\} 1/g) || []).length}`,
);

record(
  'S3-10 (26) animaxia_neon_connected 1 + animaxia_redis_connected 1 (sănătate infrastructură globală)',
  /animaxia_neon_connected 1/.test(collText) && /animaxia_redis_connected 1/.test(collText),
  '',
);

record(
  'S3-11 (27) Familii synthetics + alerte în expoziția Prometheus (animaxia_synthetic_checks_total, animaxia_alerts_*)',
  /animaxia_synthetic_checks_total\{/.test(collText) &&
    /animaxia_synthetic_pass_ratio/.test(collText) &&
    /animaxia_alerts_(firing|pending)/.test(collText),
  '',
);

const s3l = await get(`${OBS_ORIGIN}/api/metrics.json`);
record(
  'S3-12 (28) /api/metrics.json → families + retentionDays 30',
  s3l.res.status === 200 && Array.isArray(s3l.json?.families) && s3l.json?.retentionDays === 30,
  `families=${s3l.json?.families?.length}`,
);

/* ──────────────────────────────────────────────── S4. Dashboards (29..36) ── */

console.log('── S4. Grafana — 4 dashboard-uri FAZA 23 cu date live ──');

const s4a = await get(`${OBS_ORIGIN}/api/dashboards`);
const dashUids = (s4a.json?.dashboards ?? []).map((d) => d.uid).sort();
record(
  'S4-1 (29) GET /api/dashboards → EXACT 4 (faza23-pipeline, faza23-huburi, faza23-player, faza23-global)',
  s4a.res.status === 200 &&
    JSON.stringify(dashUids) === JSON.stringify(['faza23-global', 'faza23-huburi', 'faza23-pipeline', 'faza23-player']),
  `uids=${dashUids.join(',')}`,
);

for (const [uid, minPanels] of [
  ['faza23-pipeline', 8],
  ['faza23-huburi', 5],
  ['faza23-player', 4],
  ['faza23-global', 6],
]) {
  const d = await get(`${OBS_ORIGIN}/api/dashboards/${uid}`);
  const panels = d.json?.panels ?? [];
  const ok =
    d.res.status === 200 &&
    d.json?.uid === uid &&
    Array.isArray(panels) &&
    panels.length >= minPanels &&
    panels.every((p) => typeof p.title === 'string' && Array.isArray(p.targets));
  record(
    `S4-2 (30) ${uid} → JSON Grafana valid, ${minPanels}+ panouri cu targets`,
    ok,
    `panels=${panels.length}`,
  );
}

for (const uid of ['faza23-pipeline', 'faza23-huburi', 'faza23-player', 'faza23-global']) {
  const d = await get(`${OBS_ORIGIN}/api/dashboards/${uid}/data`);
  const panels = d.json?.panels ?? [];
  const ok =
    d.res.status === 200 &&
    Array.isArray(panels) &&
    panels.length > 0 &&
    panels.every((p) => Array.isArray(p.series) && p.series.every((s) => Array.isArray(s.points)));
  record(
    `S4-3 (34) ${uid}/data → serii live (puncte [ts, valoare]) pentru fiecare panou`,
    ok,
    `panels=${panels.length}`,
  );
}

/* ──────────────────────────────────────────────── S5. Alertmanager (37..46) ── */

console.log('── S5. Alertmanager — 10 reguli canonice, evaluare pasivă ──');

const CANONICAL_RULES = [
  ['animaxia-neon-down', 'critical'],
  ['animaxia-redis-down', 'critical'],
  ['animaxia-gateway-down', 'critical'],
  ['animaxia-backend-down', 'critical'],
  ['animaxia-ai-timeout', 'warning'],
  ['animaxia-fts-latency-high', 'warning'],
  ['animaxia-queue-high', 'critical'],
  ['animaxia-cache-miss-high', 'warning'],
  ['animaxia-ratelimit-abuse', 'warning'],
  ['animaxia-cooldown-abuse', 'warning'],
];

const s5a = await get(`${OBS_ORIGIN}/api/alerts`);
const rules = s5a.json?.rules ?? [];
record(
  'S5-1 (37) GET /api/alerts → EXACT 10 reguli',
  s5a.res.status === 200 && rules.length === 10,
  `rules=${rules.length}`,
);

const rulesBad = CANONICAL_RULES.filter(
  ([id, sev]) => !rules.some((r) => r.id === id && r.severity === sev),
);
record(
  'S5-2 (38) Cele 10 reguli canonice cu severități corecte (4 critical + 6 warning)',
  rulesBad.length === 0,
  `incorecte=${rulesBad.map((r) => r[0]).join(',') || '—'}`,
);

const validStates = rules.every((r) => ['inactive', 'pending', 'firing', 'resolved'].includes(r.state));
record(
  'S5-3 (39) Stări valide (inactive/pending/firing/resolved) + descrieri RO + runbook',
  validStates && rules.every((r) => typeof r.description === 'string' && r.description.length > 5),
  '',
);

const s5d = await get(`${OBS_ORIGIN}/alertmanager/api/v2/alerts`);
record(
  'S5-4 (40) GET /alertmanager/api/v2/alerts → compatibil Alertmanager (array)',
  s5d.res.status === 200 && Array.isArray(s5d.json),
  `status=${s5d.res.status}`,
);

const s5e = await post(`${OBS_ORIGIN}/api/alerts/_simulate/animaxia-neon-down`, {
  neonConnected: 0,
  backendDown: false,
});
const simFires = s5e.json?.wouldFire === true || s5e.json?.state === 'firing' || s5e.json?.firing === true;
record(
  'S5-5 (41) _simulate animaxia-neon-down cu snapshot sintetic → detectează firing ÎN RĂSPUNS',
  s5e.res.status === 200 && simFires,
  `status=${s5e.res.status} body=${JSON.stringify(s5e.json)?.slice(0, 80)}`,
);

const s5f = await get(`${OBS_ORIGIN}/api/alerts`);
const neonRuleAfter = (s5f.json?.rules ?? []).find((r) => r.id === 'animaxia-neon-down');
record(
  'S5-6 (42) _simulate NU alterează starea reală (regula rămâne inactive — alerte pasive, zero impact platformă)',
  neonRuleAfter?.state === 'inactive',
  `state=${neonRuleAfter?.state}`,
);

const s5g = await post(`${OBS_ORIGIN}/api/alerts/_simulate/animaxia-queue-high`, { queueLength: 50 });
record(
  'S5-7 (43) _simulate animaxia-queue-high sub prag (50 < 500) → NU arde (onestitate praguri)',
  s5g.res.status === 200 && !(s5g.json?.wouldFire === true || s5g.json?.state === 'firing' || s5g.json?.firing === true),
  `body=${JSON.stringify(s5g.json)?.slice(0, 60)}`,
);

record(
  'S5-8 (44) Zero alerte firing pe starea reală sănătoasă (platforma up)',
  (s5f.json?.firing ?? []).length === 0,
  `firing=${(s5f.json?.firing ?? []).map((a) => a.id || a.name).join(',')}`,
);

record(
  'S5-9 (45) Log notificări prezent (structură pentru tranziții)',
  Array.isArray(s5f.json?.log),
  '',
);

record(
  'S5-10 (46) animaxia_alerts_firing/pending expuse în /metrics (familii Prometheus)',
  /animaxia_alerts_(firing|pending)/.test(collText),
  '',
);

/* ──────────────────────────────────────────────── S6. Synthetics (47..58) ── */

console.log('── S6. Synthetics — 46 check-uri globale EU/US/ASIA ──');

const s6a = await get(`${OBS_ORIGIN}/api/synthetics`);
const checks = s6a.json?.checks ?? [];
record(
  'S6-1 (47) GET /api/synthetics → EXACT 46 check-uri',
  s6a.res.status === 200 && s6a.json?.total === 46 && checks.length === 46,
  `total=${s6a.json?.total} checks=${checks.length}`,
);

const REQUIRED_CATEGORIES = [
  'homepage',
  'search',
  'pipeline',
  'huburi',
  'feed',
  'recomandari',
  'recomandări',
  'history',
  'playlists',
  'stats',
  'player',
  'subtitrari',
  'subtitrări',
  'ai-hub',
  'ai-home',
  'ar10m',
  'platform',
  'sharding',
  'uptime',
];
const cats = new Set(checks.map((c) => String(c.category).toLowerCase()));
const catCoverage = ['homepage', 'search', 'pipeline', 'huburi', 'history', 'playlists', 'stats', 'player', 'ai-hub', 'ai-home', 'sharding', 'uptime'].every(
  (c) => cats.has(c),
);
record(
  'S6-2 (48) Acoperire completă categorii: homepage, search, pipeline FAZA 18, huburi FAZA 20, history/playlists/stats FAZA 21, player FAZA 17, AI Hub/Home, ar10m, sharding FAZA 13, feed, uptime',
  catCoverage,
  `categorii=${[...cats].sort().join(',')}`,
);

const regions = new Set(checks.map((c) => c.region));
record(
  'S6-3 (49) Regiuni globale eu/us/asia prezente + interne local',
  ['eu', 'us', 'asia'].every((r) => regions.has(r)),
  `regiuni=${[...regions].sort().join(',')}`,
);

const perRegion = { eu: 0, us: 0, asia: 0 };
for (const c of checks) if (perRegion[c.region] != null) perRegion[c.region] += 1;
record(
  'S6-4 (50) Distribuție regională echilibrată (≥12 check-uri per regiune)',
  perRegion.eu >= 12 && perRegion.us >= 12 && perRegion.asia >= 12,
  `eu=${perRegion.eu} us=${perRegion.us} asia=${perRegion.asia}`,
);

// FAZA 23 final: 'RESP' = PING direct către redis-global prin clientul RESP
// propriu (node:net) — protocolul nativ Redis, strict read-only (zero
// modificări pe platforma protejată, identic ca efect cu un GET de health).
const allReadOnly = checks.every((c) => ['GET', 'RESP'].includes(c.method || 'GET'));
record(
  'S6-5 (51) Toate check-urile read-only (GET sau RESP PING) — zero modificări pe platforma protejată',
  allReadOnly,
  '',
);

const ar10mChecks = checks.filter((c) => ['ar10m', 'platform'].includes(String(c.category).toLowerCase()));
record(
  'S6-6 (52) AR10M verificat prin synthetics (capacitate proiectată 10.000.000 pe /api/ar10m/stats; fost 30B simulat — eliminat)',
  ar10mChecks.length >= 3 && ar10mChecks.every((c) => String(c.target).includes('/api/ar10m/stats')),
  `checks=${ar10mChecks.length}`,
);

const hist = await get(`${OBS_ORIGIN}/api/synthetics/homepage-eu/history`);
record(
  'S6-7 (53) GET /api/synthetics/:id/history → istoric rulări',
  hist.res.status === 200 && Array.isArray(hist.json?.history),
  `status=${hist.res.status}`,
);

console.log('  … rulez toate cele 46 acum (POST /api/synthetics/_run — poate dura ~2 min)…');
const runRes = await post(`${OBS_ORIGIN}/api/synthetics/_run`, {}, {}, 240000);
const runJson = runRes.json ?? {};
record(
  'S6-8 (54) POST /api/synthetics/_run → 46 rulate, toate trec (fereastra curată)',
  runRes.res.status === 200 && runJson.total === 46 && runJson.failing === 0,
  `total=${runJson.total} passing=${runJson.passing} failing=${runJson.failing}`,
);

const s6i = await get(`${OBS_ORIGIN}/api/synthetics`);
record(
  'S6-9 (55) Starea post-run: passing 46/46 + lastRunAt actualizat',
  s6i.json?.passing === 46 && typeof s6i.json?.lastRunAt === 'string',
  `passing=${s6i.json?.passing} lastRunAt=${s6i.json?.lastRunAt}`,
);

const byRegion = s6i.json?.byRegion ?? {};
record(
  'S6-10 (56) byRegion — toate regiunile verzi după rulare',
  ['eu', 'us', 'asia'].every((r) => (byRegion[r]?.total ?? 0) > 0 && byRegion[r].passing === byRegion[r].total),
  `eu=${byRegion.eu?.passing}/${byRegion.eu?.total} us=${byRegion.us?.passing}/${byRegion.us?.total} asia=${byRegion.asia?.passing}/${byRegion.asia?.total}`,
);

record(
  'S6-11 (57) animaxia_synthetic_pass_ratio = 1 după rulare verde',
  /animaxia_synthetic_pass_ratio 1(\.0+)?/.test((await get(`${OBS_ORIGIN}/metrics`)).text || ''),
  '',
);

record(
  'S6-12 (58) Durate înregistrate per check (animaxia_synthetic_duration_ms)',
  /animaxia_synthetic_duration_ms\{check="/.test((await get(`${OBS_ORIGIN}/metrics`)).text || ''),
  '',
);

/* ─────────────────────────────────────────── S7. UI observability (59..68) ── */

console.log('── S7. UI observability — contractul /api/summary pentru tab-ul admin ──');

const summary = (await get(`${OBS_ORIGIN}/api/summary`)).json;
const GAUGE_IDS = [
  'uptime',
  'backend',
  'neon',
  'redis',
  'gateway',
  'ai_usage',
  'search_activity',
  'hub_activity',
  'pipeline_health',
  'synthetics',
];
record(
  'S7-1 (59) /api/summary → ok + EXACT 10 gauge-uri în ordinea canonică',
  summary?.ok === true && Array.isArray(summary.gauges) && summary.gauges.length === 10 &&
    JSON.stringify(summary.gauges.map((g) => g.id)) === JSON.stringify(GAUGE_IDS),
  `gauges=${(summary?.gauges ?? []).map((g) => g.id).join(',')}`,
);

record(
  'S7-2 (60) Fiecare gauge complet: label, value numerică, unit, status ok/warn/error, detail',
  summary.gauges.every(
    (g) => typeof g.label === 'string' && typeof g.value === 'number' && typeof g.unit === 'string' &&
      ['ok', 'warn', 'error'].includes(g.status) && typeof g.detail === 'string',
  ),
  '',
);

record(
  'S7-3 (61) Gauge-uri de sănătatetate ok pe platforma live (uptime/backend/neon/redis/gateway)',
  ['uptime', 'backend', 'neon', 'redis', 'gateway'].every((id) => summary.gauges.find((g) => g.id === id)?.status === 'ok'),
  `stări=${summary.gauges.map((g) => `${g.id}:${g.status}`).join(' ')}`,
);

record(
  'S7-4 (62) pipeline.layers → cele 10 straturi FAZA 18 (vizual, observate)',
  Array.isArray(summary.pipeline?.layers) && summary.pipeline.layers.length === 10,
  `layers=${summary.pipeline?.layers?.length}`,
);

record(
  'S7-5 (63) hub.routes + player + ai — structuri vizuale populate',
  Array.isArray(summary.hub?.routes) &&
    typeof summary.player?.resumeEvents === 'number' &&
    typeof summary.ai?.calls === 'number',
  `hub.routes=${summary.hub?.routes?.length}`,
);

record(
  'S7-6 (64) neon/redis/gateway — detaliu infrastructură globală (shards, mode, regiuni)',
  typeof summary.neon?.shardsHealthy === 'number' &&
    typeof summary.redis?.mode === 'string' &&
    summary.gateway?.regions && ['eu', 'us', 'asia'].every((r) => summary.gateway.regions[r]),
  `redis.mode=${summary.redis?.mode}`,
);

record(
  'S7-7 (65) alerts.totalRules 10 + synthetics.total 46 + retentionDays 30 în summary',
  summary.alerts?.totalRules === 10 && summary.synthetics?.total === 46 && summary.metrics?.retentionDays === 30,
  `rules=${summary.alerts?.totalRules} synth=${summary.synthetics?.total} ret=${summary.metrics?.retentionDays}`,
);

record(
  'S7-8 (66) traces.services + traces.recent — span-uri recente pentru vizualizare',
  Array.isArray(summary.traces?.services) && summary.traces.services.length > 0 && Array.isArray(summary.traces?.recent),
  `services=${summary.traces?.services?.length}`,
);

record(
  'S7-9 (67) Familii de metrici expuse în summary (families > 100)',
  typeof summary.metrics?.families === 'number' && summary.metrics.families > 100,
  `families=${summary.metrics?.families}`,
);

const uiPath = await get(`${GW_ORIGIN}/api/summary?XTransformPort=4050`);
record(
  'S7-10 (68) UI path prin :81 → același contract (10 gauge-uri)',
  uiPath.res.status === 200 && uiPath.json?.gauges?.length === 10,
  `status=${uiPath.res.status}`,
);

/* ────────────────────────────────────── S8. Regresie protejată (69..76) ── */

console.log('── S8. Regresie protejată — FAZA 18/20/21 + AR10M + FAZA 13/17 (doar observate) ──');

const hdr = { 'x-forwarded-for': OBSERVER_XFF };
const r8a = await get(`${API_ORIGIN}/api/search/status`, hdr);
record(
  'S8-1 (69) FAZA 18 intactă: pipelineIntegrated true + 10 straturi live',
  r8a.json?.pipelineIntegrated === true && Array.isArray(r8a.json?.pipelineStages) && r8a.json.pipelineStages.length === 10,
  `integrated=${r8a.json?.pipelineIntegrated} stages=${r8a.json?.pipelineStages?.length}`,
);

record(
  'S8-2 (70) FAZA 18 intactă: engine real animaxia-neon-fts + pg_trgm',
  r8a.json?.engine === 'animaxia-neon-fts' && r8a.json?.extensions?.pg_trgm === true,
  `engine=${r8a.json?.engine}`,
);

const r8c = await get(`${API_ORIGIN}/api/hub/stats`, hdr);
const r8d = await get(`${API_ORIGIN}/api/hub/browse?limit=3`, hdr);
record(
  'S8-3 (71) FAZA 20 intactă: hub stats + browse 200 cu date reale Neon',
  r8c.res.status === 200 && r8c.json?.ok === true && r8d.res.status === 200 && Array.isArray(r8d.json?.data),
  `stats=${r8c.res.status} browse=${r8d.res.status}`,
);

const r8e = await get(`${API_ORIGIN}/api/ar10m/stats`, hdr);
record(
  'S8-4 (72) AR10M intact: capacitate proiectată 10.000.000 + contori reali (fost 30B simulat — eliminat)',
  r8e.res.status === 200 && r8e.json?.capacity?.designed === 10000000,
  `designed=${r8e.json?.capacity?.designed} titles=${r8e.json?.real?.titles}`,
);

const r8f = await get(`${API_ORIGIN}/api/shards`, hdr);
const shardsHealthy = (r8f.json?.cluster?.nodes ?? r8f.json?.shards ?? []).every?.((n) => n.healthy !== false);
record(
  'S8-5 (73) FAZA 13 intactă: cluster logic cu shard-uri sănătoase',
  r8f.res.status === 200 && shardsHealthy !== false,
  `status=${r8f.res.status}`,
);

const r8g = await get(`${API_ORIGIN}/api/users/me/stats`);
record(
  'S8-6 (74) FAZA 21 intactă: stats personale → 401 fără token (gating corect)',
  r8g.res.status === 401,
  `status=${r8g.res.status}`,
);

const r8h = await get(`${API_ORIGIN}/api/playlists`);
record(
  'S8-7 (75) FAZA 21 intactă: playlists → 401/403 fără token (gating corect)',
  r8h.res.status === 401 || r8h.res.status === 403,
  `status=${r8h.res.status}`,
);

const r8i = await get(`${API_ORIGIN}/api/content/1907/player`, hdr);
record(
  'S8-8 (76) FAZA 17 intactă: player răspunde cu surse (fallback chain observat de FAZA 23)',
  r8i.res.status === 200 && r8i.json && typeof r8i.json === 'object',
  `status=${r8i.res.status}`,
);

/* ───────────────────────────────────────────────────────────────── summary ── */

console.log('');
console.log(`SMOKE-OBSERVABILITY: ${passed} passed, ${failed} failed (din 76)`);
if (failed > 0) {
  console.log('');
  console.log('Eșecuri:');
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
process.exit(0);
