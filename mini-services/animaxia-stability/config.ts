/**
 * FAZA 24 — animaxia-stability — configurație fixă (fără env).
 * Portul 4060 este contractul platformei (vezi worklog FAZA 23/24).
 *
 * ACEST FIȘIER ESTE SURSA UNICĂ DE ADEVĂR pentru politicile de stabilitate:
 * artefactele de producție (animaxia-cloud/deploy/stability-faza24/) și
 * suita QA (tests/stability-faza24.mjs) afirmă aceleași valori.
 *
 * Platforma protejată (FAZA 18/20/21/23, Neon FTS, 30B, FAZA 13/17, AI 15/16)
 * nu este modificată — serviciul doar CITEȘTE metrici și DECIDE capacitate.
 */

export const PORT = 4060 as const;
export const SERVICE_NAME = 'animaxia-stability' as const;
export const VERSION = '1.0.0' as const;

/** Cât de des se citesc metricile reale ale platformei (probe per țintă). */
/** NEON FREE PLAN (scale-to-zero): reader-ul de metrici (backend health +
 *  metrics + search status + gateway) a fost ridicat de la 10s la 30 MIN și
 *  primește refresh on-demand: /api/status declanșează o citire proaspătă
 *  dacă datele sunt mai vechi de 60s (cineva chiar se uită la ele). Fiecare
 *  tick la 10s citea /api/health de pe backend → înainte de optimizarea
 *  health-ului, asta însemna interogări Neon reale la 10s, non-stop. */
export const READ_INTERVAL_MS = 30 * 60 * 1000;
/** Pragul de prospețime pentru refresh on-demand al readerului (/api/status). */
export const READ_STALE_MS = 60 * 1000;
/** Retenție mostre per țintă: acoperă ferestrele de scale-in de 10 minute. */
export const SAMPLES_RETENTION = 130;

/* ═══════════════════════════════════════════════════════════════════════════
 * 1. AUTOSCALING — politici per țintă (regulile exacte FAZA 24).
 *    Semantica ferestrelor: regula declanșează când condiția este adevărată
 *    CONTINUU ≥ windowSec (reset complet la prima încălcare).
 * ═══════════════════════════════════════════════════════════════════════════ */

export type Op = '>' | '<';

export interface Rule {
  id: string;
  /** Numele câmpului din mostră (inclusiv cele derivate: rpsPerReplica, reqPerMinPerReplica). */
  metric: string;
  op: Op;
  threshold: number;
  /** Secunde de menținere continuă înainte de declanșare. */
  windowSec: number;
}

export interface TargetPolicy {
  id: string;
  kind: 'backend' | 'gateway' | 'ai';
  label: string;
  minReplicas: number;
  maxReplicas: number;
  stepOut: number;
  stepIn: number;
  /** scale-out: OR (oricare regulă declanșează). */
  scaleOut: Rule[];
  /** scale-in: ALL (toate regulile cu date trebuie declanșate). */
  scaleIn: Rule[];
  /** Cooldown după un scale-out înainte de următorul (HPA scaleUp stabilization). */
  scaleUpCooldownSec: number;
  /** Stabilizare după ultimul scale-out înainte de orice scale-in (HPA scaleDown stabilization). */
  scaleDownStabilizationSec: number;
  /** Cooldown între doi pași de scale-in. */
  scaleInCooldownSec: number;
}

/** 1a. Backend — CPU / RAM / latență / coadă pipeline (regulile exacte din FAZA 24). */
export const BACKEND_POLICY: TargetPolicy = {
  id: 'backend',
  kind: 'backend',
  label: 'animaxia-backend (:4000)',
  minReplicas: 2,
  maxReplicas: 20,
  stepOut: 2,
  stepIn: 1,
  scaleOut: [
    { id: 'cpu-high', metric: 'cpuPct', op: '>', threshold: 70, windowSec: 300 },
    { id: 'latency-p95-high', metric: 'latencyP95Ms', op: '>', threshold: 500, windowSec: 300 },
    { id: 'queue-high', metric: 'queueLength', op: '>', threshold: 300, windowSec: 120 },
  ],
  scaleIn: [
    { id: 'cpu-low', metric: 'cpuPct', op: '<', threshold: 40, windowSec: 600 },
    { id: 'latency-p95-low', metric: 'latencyP95Ms', op: '<', threshold: 200, windowSec: 600 },
  ],
  scaleUpCooldownSec: 60,
  scaleDownStabilizationSec: 300,
  scaleInCooldownSec: 120,
};

/** 1b. Gateway global — per regiune EU/US/ASIA, capacitatile per replică. */
export const GATEWAY_RPS_PER_REPLICA = 500;
export const GATEWAY_LATENCY_P95_MS = 400;
export const GATEWAY_ERROR_RATE_PCT = 2;

function gatewayPolicy(region: 'eu' | 'us' | 'asia'): TargetPolicy {
  return {
    id: `gateway-${region}`,
    kind: 'gateway',
    label: `global-gateway ${region.toUpperCase()}`,
    minReplicas: 2,
    maxReplicas: 15,
    stepOut: 2,
    stepIn: 1,
    scaleOut: [
      { id: 'rps-spike', metric: 'rpsPerReplica', op: '>', threshold: GATEWAY_RPS_PER_REPLICA * 0.75, windowSec: 120 },
      { id: 'latency-high', metric: 'latencyP95Ms', op: '>', threshold: GATEWAY_LATENCY_P95_MS, windowSec: 120 },
      { id: 'error-rate-high', metric: 'errorRatePct', op: '>', threshold: GATEWAY_ERROR_RATE_PCT, windowSec: 120 },
    ],
    scaleIn: [
      { id: 'rps-low', metric: 'rpsPerReplica', op: '<', threshold: GATEWAY_RPS_PER_REPLICA * 0.3, windowSec: 600 },
    ],
    scaleUpCooldownSec: 60,
    scaleDownStabilizationSec: 300,
    scaleInCooldownSec: 120,
  };
}

/** 1c. Motoare AI — AI Home (FAZA 15), AI Hub (FAZA 16), Personal AI, RAG engine. */
export const AI_REQ_PER_MIN_PER_REPLICA = 30;
export const AI_LLM_LATENCY_MS = 3000;
export const AI_TIMEOUT_RATE_PCT = 2;

function aiPolicy(id: string, label: string, routes: string[]): TargetPolicy & { routes: string[] } {
  return {
    id,
    kind: 'ai',
    label,
    minReplicas: 2,
    maxReplicas: 10,
    stepOut: 1,
    stepIn: 1,
    scaleOut: [
      { id: 'requests-high', metric: 'reqPerMinPerReplica', op: '>', threshold: AI_REQ_PER_MIN_PER_REPLICA * 0.8, windowSec: 180 },
      { id: 'llm-latency-high', metric: 'llmLatencyMs', op: '>', threshold: AI_LLM_LATENCY_MS, windowSec: 180 },
      { id: 'timeout-rate-high', metric: 'timeoutRatePct', op: '>', threshold: AI_TIMEOUT_RATE_PCT, windowSec: 120 },
    ],
    scaleIn: [
      { id: 'requests-low', metric: 'reqPerMinPerReplica', op: '<', threshold: AI_REQ_PER_MIN_PER_REPLICA * 0.3, windowSec: 600 },
      { id: 'timeout-rate-low', metric: 'timeoutRatePct', op: '<', threshold: 0.5, windowSec: 600 },
    ],
    scaleUpCooldownSec: 60,
    scaleDownStabilizationSec: 300,
    scaleInCooldownSec: 120,
    routes,
  };
}

export const REGIONS = ['eu', 'us', 'asia'] as const;
export type RegionName = (typeof REGIONS)[number];

export const GATEWAY_POLICIES: TargetPolicy[] = REGIONS.map((r) => gatewayPolicy(r));

export const AI_POLICIES = [
  aiPolicy('ai-home', 'AI Home (FAZA 15)', ['/api/ai/home']),
  aiPolicy('ai-hub', 'AI Hub (FAZA 16)', ['/api/ai/hub']),
  aiPolicy(
    'ai-personal',
    'Personal AI',
    ['/api/ai/personal', '/api/ai/assistant', '/api/ai/social'],
  ),
  aiPolicy('ai-rag', 'RAG engine', ['/api/ai/rag', '/api/ai/tenant/rag', '/api/ai/tenant/vector', '/api/ai/tools']),
] as (TargetPolicy & { routes: string[] })[];

export const ALL_POLICIES: TargetPolicy[] = [BACKEND_POLICY, ...GATEWAY_POLICIES, ...AI_POLICIES];

/* ═══════════════════════════════════════════════════════════════════════════
 * 4. LOAD BALANCING GLOBAL — geo-routing + fallback + health-check-uri.
 * ═══════════════════════════════════════════════════════════════════════════ */

/** Continent → regiune (Africa → EU = cel mai apropiat hub de cablu). */
export const GEO_CONTINENTS: Record<string, RegionName> = {
  EU: 'eu',
  NA: 'us',
  SA: 'us',
  AS: 'asia',
  OC: 'asia',
  AF: 'eu',
  AN: 'eu',
};

/** Țară → regiune (exemplu reprezentativ; producția folosește GeoIP complet). */
export const GEO_COUNTRIES: Record<string, RegionName> = {
  RO: 'eu', DE: 'eu', FR: 'eu', IT: 'eu', ES: 'eu', GB: 'eu', PL: 'eu', NL: 'eu', SE: 'eu', MD: 'eu',
  US: 'us', CA: 'us', MX: 'us', BR: 'us', AR: 'us', CO: 'us', CL: 'us',
  JP: 'asia', CN: 'asia', IN: 'asia', KR: 'asia', SG: 'asia', TH: 'asia', ID: 'asia',
  AU: 'asia', NZ: 'asia', PH: 'asia', VN: 'asia',
  NG: 'eu', ZA: 'eu', EG: 'eu', KE: 'eu',
};

/** Lanțuri de fallback (regiune → preferință ordonată). */
export const FALLBACK_CHAINS: Record<RegionName, RegionName[]> = {
  eu: ['us', 'asia'],
  us: ['eu', 'asia'],
  asia: ['us', 'eu'],
};

/** Cele 3 health-check-uri globale obligatorii (FAZA 24, pct. 4). */
export const HEALTH_CHECKS = {
  backend: { url: 'http://localhost:4000/api/health', expect: 200, mandatory: true },
  gateway: { url: 'http://localhost:4040/api/infra/health', expect: 200, mandatory: true },
  observability: { url: 'http://localhost:4050/health', expect: 200, mandatory: true },
} as const;

/** Servicii urmărite suplimentar (context global, neobligatorii pentru routing). */
export const TRACKED_SERVICES = {
  frontend: { url: 'http://localhost:3000/', anyHttp: true },
  realtime: { url: 'http://localhost:4010/', anyHttp: true },
  watchdog: { url: 'http://localhost:4020/health', expect: 200 },
  redis: { host: '127.0.0.1', port: 4030 },
} as const;

/** NEON FREE PLAN: health-check-urile LB (backend/gateway/observability +
 *  serviciile urmărite) au fost ridicate de la 10s la 30 MIN; verificarea
 *  instantă se face on-demand la /api/status (checkAllIfStale) și la
 *  deciziile de routing. ZERO acces DB — doar probe HTTP/TCP locale. */
export const HEALTH_INTERVAL_MS = 30 * 60 * 1000;
export const HEALTH_STALE_MS = 60 * 1000;
export const HEALTH_TIMEOUT_MS = 4_000;

/* ═══════════════════════════════════════════════════════════════════════════
 * 5. FAILOVER + ZERO-DOWNTIME DEPLOY.
 * ═══════════════════════════════════════════════════════════════════════════ */

/** Gateway-ul FAZA 22 expune un API admin real de region down/up — îl folosim. */
export const GATEWAY_REGION_ADMIN = 'http://localhost:4040/api/infra/regions';

/** Porți de health REALE per țintă de deploy (verificate înainte de trafic). */
export const DEPLOY_HEALTH_GATES: Record<string, string> = {
  backend: 'http://localhost:4000/api/health',
  'gateway-eu': 'http://localhost:4040/api/infra/health',
  'gateway-us': 'http://localhost:4040/api/infra/health',
  'gateway-asia': 'http://localhost:4040/api/infra/health',
  'ai-home': 'http://localhost:4000/api/ai/home/stats',
  'ai-hub': 'http://localhost:4000/api/ai/hub/status',
  'ai-personal': 'http://localhost:4000/api/ai/status',
  'ai-rag': 'http://localhost:4000/api/ai/tenant/status',
};

export const DEPLOY_STEP_MS = 300;
export const DEPLOY_HEALTH_TIMEOUT_MS = 3_000;
export const DEPLOY_HISTORY_MAX = 50;

/* ═══════════════════════════════════════════════════════════════════════════
 * 6. PROTECȚIE OVERLOAD (traffic shaping).
 * ═══════════════════════════════════════════════════════════════════════════ */

export type ShapingClass = 'critical' | 'normal' | 'sheddable';

/** API critice (auth, search, huburi, player) — prioritizate la overload. */
export const SHAPING_CLASSES: { clazz: ShapingClass; label: string; prefixes: string[] }[] = [
  {
    clazz: 'critical',
    label: 'API critice — auth, search, huburi, player',
    prefixes: ['/api/auth', '/api/search', '/api/hub', '/api/player', '/api/content/'],
  },
  {
    clazz: 'normal',
    label: 'API normale — conținut, categorii, recomandări',
    prefixes: ['/api/all', '/api/movies', '/api/anime', '/api/tv', '/api/sports', '/api/franchise', '/api/recommendations', '/api/ai/'],
  },
  {
    clazz: 'sheddable',
    label: 'API non-critice — pot fi încetinite la overload',
    prefixes: ['/api/miner', '/api/admin', '/api/observability', '/api/platform'],
  },
];

/** Limite globale de trafic per regiune (RPS) — buget de producție. */
export const REGION_LIMIT_RPS: Record<RegionName, number> = { eu: 500, us: 500, asia: 500 };

/** Praguri pe raportul încărcare/limită. */
export const SHAPING_THRESHOLDS = {
  /** ≥1.0: sheddable se respinge onest (429 + Retry-After). */
  shedSheddable: 1.0,
  /** ≥1.3: normal se încetinește (throttle). */
  throttleNormal: 1.3,
  /** ≥1.5: normal se respinge onest; mesaj „platformă ocupată”. */
  shedNormal: 1.5,
  /** ≥1.8: critical se încetinește (NICIODATĂ respins — podeaua garantată). */
  throttleCritical: 1.8,
} as const;

export const SHAPING_RETRY_AFTER = { throttleMs: 1000, shedMs: 5000 };
export const SHAPING_BUSY_MESSAGE =
  'Platformă ocupată — cererile non-critice sunt limitate temporar. Reîncearcă în câteva secunde.';
export const SHAPING_EVAL_HISTORY_MAX = 50;

/* ═══════════════════════════════════════════════════════════════════════════
 * Sursele de metrici ale platformei live (FAZA 18/20/21/22/23 — read-only).
 * ═══════════════════════════════════════════════════════════════════════════ */

export const SOURCES = {
  backendHealth: 'http://localhost:4000/api/health',
  backendMetricsJson: 'http://localhost:4000/api/metrics?format=json',
  searchStatus: 'http://localhost:4000/api/search/status',
  observabilityMetrics: 'http://localhost:4000/api/observability/metrics',
  gatewayMetrics: 'http://localhost:4040/metrics',
  gatewayStatus: 'http://localhost:4040/api/infra/status',
} as const;

/** CORS: allowlist + mirror dev pentru http://localhost:* (fără Origin → OK). */
export const CORS_ALLOWLIST = ['http://localhost:81', 'http://localhost:3000'] as const;
