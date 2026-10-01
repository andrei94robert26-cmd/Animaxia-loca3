/**
 * FAZA 23 — animaxia-observability — configurație fixă (fără env PORT).
 * Portul 4050 este contractul platformei (vezi worklog FAZA 22/23).
 */

export const PORT = 4050 as const;
export const SERVICE_NAME = 'animaxia-observability' as const;
export const VERSION = '1.0.0' as const;

/** Retention aplicat pe TOATE seriile (traces, metrici istorice, alert log):
 *  punctele mai vechi de 30 zile sunt drop-ate la fiecare sweep. */
export const RETENTION_DAYS = 30 as const;
export const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;
/** Sweep de retention o dată pe oră (ieftin, comportament real). */
export const RETENTION_SWEEP_MS = 60 * 60 * 1000;

/** Scraper Prometheus: tolerant la erori/404 (vezi load-budget mai jos). */
/** Scraper: 30 MIN — NEON FREE PLAN (scale-to-zero), cerință explicită
 *  utilizator: „colectare metrici la minim 30 de minute”.
 *  Fostul interval de 30s genera, printre altele, un apel /api/health pe
 *  backend la fiecare 30s — care înainte de optimizare executa interogări
 *  reale Neon (countContent/countsByType) și ținea compute-ul treaz non-stop
 *  (rădăcina arderii cotei de 53000 unități pe vechea bază). Backend-ul a
 *  fost și el optimizat (health servește cache), dar și intervalele de
 *  colectare au fost ridicate la minimul cerut: 30 min. */
export const SCRAPE_INTERVAL_MS = 30 * 60 * 1000;

/** Identitatea de observer pentru cererile DIRECTE către backend (:4000):
 *  X-Forwarded-For cu o adresă dedicată monitorizării. rateLimit.js al
 *  platformei bucket-uiește pe XFF-first → monitorizarea primește propriul
 *  bucket, separată de traficul de utilizatori/QA de pe 127.0.0.1 (în
 *  producție echivalentul e Prometheus/synthetics cu IP-uri proprii).
 *  ZERO efect asupra logicilor de perimetru ale utilizatorilor reali. */
export const OBSERVER_XFF = '10.23.23.23';

/** Alertmanager local: evaluare la 5 min (NEON FREE PLAN — fost 15s).
 *  Evaluarea lucrează EXCLUSIV pe datele deja scrapate în MetricsStore
 *  (memorie locală) — zero query PostgreSQL, zero I/O. Intervalul a fost
 *  aliniat la noua cadență de scrape (30 min) — nu are sens să evaluăm
 *  aceleași date la 15s. */
export const ALERT_EVAL_MS = 5 * 60 * 1000;
/** O alertă trece în resolved după ce condiția e falsă ≥ 60s. */
export const ALERT_RESOLVE_AFTER_MS = 60_000;
/** Log notificări in-memory: ultimele 100 tranziții (FAZA 23 final: memorie redusă). */
export const ALERT_LOG_MAX = 100;

/** OTel collector: ring buffer ultimele 1500 traces (LRU pe traceId).
 *  FAZA 23 final: redus de la 5000 pentru memorie redusă (RSS < 300MB). */
export const TRACES_RING_MAX = 1_500;
/** Istoric puncte per serie istorică (dashboard live): cap intern redus
 *  (FAZA 23 final: 400, pentru memorie redusă), output-ul API taie la ultimele 60. */
export const HISTORY_POINTS_MAX = 400;
export const HISTORY_POINTS_OUT = 60;

/** Synthetics: ON-DEMAND (NEON FREE PLAN). Fostul loop automat la 120s cu
 *  46 check-uri genera trafic fals continuu pe platformă (căutări reale FTS,
 *  hub browse, AI hub status → interogări Neon reale la fiecare 2 min, 24/7)
 *  — exact tipul de „trafic fără utilizatori” care împiedica scale-to-zero.
 *  Acum: DEFAULT OPRIT; rulează DOAR la cerere prin POST /api/synthetics/_run
 *  (buton în UI / QA / admin). Auto-rulare doar cu SYNTHETICS_AUTO=1. */
export const SYNTHETICS_AUTO = (process.env.SYNTHETICS_AUTO ?? '0') === '1';
export const SYNTHETIC_INTERVAL_SEC = 120;
export const SYNTHETIC_CONCURRENCY = 4;
export const SYNTHETIC_STAGGER_MS = 2_600;
export const SYNTHETIC_RUN_CONCURRENCY = 6;
export const SYNTHETIC_RUN_STAGGER_MS = 700;
export const SYNTHETIC_TIMEOUT_MS = 8_000;
/** FAZA 23 final: istoric redus la 20 check-uri/check (memorie redusă). */
export const SYNTHETIC_HISTORY_MAX = 20;

/** Sursele de scrape — platforma live (FAZA 18/20/21/22). */
export const SOURCES = {
  backendHealth: 'http://localhost:4000/api/health',
  backendMetrics: 'http://localhost:4000/api/metrics',
  /** VA EXISTA prin agentul paralel 23-b — 404 tolerat până apare. */
  backendObservability: 'http://localhost:4000/api/observability/metrics',
  searchStatus: 'http://localhost:4000/api/search/status',
  hubStats: 'http://localhost:4000/api/hub/stats',
  gatewayHealth: 'http://localhost:4040/api/infra/health',
  gatewayStatus: 'http://localhost:4040/api/infra/status',
  /** VA EXISTA prin 23-b — 404 tolerat până apare. */
  gatewayMetrics: 'http://localhost:4040/metrics',
  watchdogHealth: 'http://localhost:4020/health',
  frontend: 'http://localhost:3000/',
  realtime: 'http://localhost:4010/',
  redis: { host: '127.0.0.1', port: 4030 },
} as const;

/** CORS: allowlist + mirror dev pentru http://localhost:* (fără Origin → OK). */
export const CORS_ALLOWLIST = ['http://localhost:81', 'http://localhost:3000'] as const;

/** Serviciile platformei urmărite în animaxia_up{service}. */
export const TRACKED_SERVICES = [
  'animaxia-backend',
  'animaxia-frontend',
  'animaxia-realtime',
  'animaxia-watchdog',
  'redis-global',
  'global-gateway',
  'animaxia-observability',
] as const;

export const REGIONS = ['eu', 'us', 'asia'] as const;
