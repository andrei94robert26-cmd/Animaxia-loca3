/**
 * loadbalancer.ts — FAZA 24 — load balancing global EU/US/ASIA.
 *
 * Rutare geografică declarativă (continent/țară → regiune), fallback automat
 * pe lanțul de preferințe când regiunea primară e down (sănătatea reală a
 * upstream-urilor vine din gateway-ul FAZA 22 + starea de failover FAZA 24)
 * și cele 3 health-check-uri globale obligatorii: backend, gateway,
 * observability (poll la 10s).
 *
 * Serviciul NU proxy-ifică trafic (gateway-ul :4040 face asta deja, cu
 * failover propriu) — acest modul este planul de control al rutării:
 * decide CE REGIUNE deservește un client, cu ce fallback și de ce.
 */

import {
  FALLBACK_CHAINS,
  GEO_CONTINENTS,
  GEO_COUNTRIES,
  HEALTH_CHECKS,
  HEALTH_INTERVAL_MS,
  HEALTH_STALE_MS,
  HEALTH_TIMEOUT_MS,
  REGIONS,
  TRACKED_SERVICES,
  type RegionName,
} from '../config';
import type { FailoverManager } from './failover';

export interface HealthState {
  up: boolean;
  latencyMs: number | null;
  lastCheckAt: number;
  error: string | null;
}

export interface RouteDecision {
  ok: boolean;
  clientRegion: RegionName | null;
  region: RegionName | null;
  fallbackUsed: boolean;
  via: RegionName | null;
  reason: string;
  healthyRegions: RegionName[];
}

export class GlobalLoadBalancer {
  health = new Map<string, HealthState>();
  reroutesTotal = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private failover: FailoverManager) {}

  start(): void {
    /* NEON FREE PLAN: background check la 30 MIN (fost 10s — fiecare ciclu
     *  lovea /api/health pe backend, care înainte de optimizare executa
     *  interogări Neon reale). Prospețimea o asigură checkAllIfStale()
     *  apelat on-demand de /api/status și de deciziile de routing. */
    setTimeout(() => void this.checkAll(), 2_000);
    this.timer = setInterval(() => void this.checkAll(), HEALTH_INTERVAL_MS);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** NEON FREE PLAN: re-verificare on-demand — dacă ultimul check e mai vechi
   *  de HEALTH_STALE_MS, pornește un checkAll nou (max o dată la 60s). */
  checkAllIfStale(): void {
    const last = Math.max(0, ...[...this.health.values()].map((h) => h.lastCheckAt));
    if (Date.now() - last > HEALTH_STALE_MS) {
      void this.checkAll();
    }
  }

  /** Cele 3 health-check-uri globale obligatorii + serviciile urmărite. */
  private async checkAll(): Promise<void> {
    const jobs: [string, Promise<{ up: boolean; latencyMs: number | null; error: string | null }>][] = [];

    for (const [name, cfg] of Object.entries(HEALTH_CHECKS)) {
      jobs.push([
        name,
        probe(cfg.url, HEALTH_TIMEOUT_MS, (code) => code === 200),
      ]);
    }
    for (const [name, cfg] of Object.entries(TRACKED_SERVICES)) {
      if ('url' in cfg) {
        jobs.push([name, probe(cfg.url, HEALTH_TIMEOUT_MS, () => true)]);
      } else if ('port' in cfg) {
        jobs.push([name, redisPing(cfg.host, cfg.port)]);
      }
    }

    const results = await Promise.allSettled(jobs.map(([, p]) => p));
    const now = Date.now();
    results.forEach((r, i) => {
      const [name] = jobs[i];
      const prev = this.health.get(name);
      if (r.status === 'fulfilled') {
        this.health.set(name, { up: r.value.up, latencyMs: r.value.latencyMs, lastCheckAt: now, error: r.value.error });
      } else {
        this.health.set(name, { up: false, latencyMs: null, lastCheckAt: now, error: 'probe_failed' });
      }
      // tranziție down → contor rerutes (LB-ul va recomanda fallback)
      if (prev?.up && !this.health.get(name)!.up) this.reroutesTotal++;
    });
  }

  /** Sănătatea unei regiuni: upstream-uri reale (gateway) + failover simulat. */
  regionHealthy(region: RegionName): { healthy: boolean; reason: string } {
    const sim = this.failover.regionSimulatedDown(region);
    if (sim) return { healthy: false, reason: 'failover-simulated-down (QA)' };
    const forced = this.failover.gatewayRegionForcedDown(region);
    if (forced) return { healthy: false, reason: 'region forced down (gateway admin)' };
    const gw = this.health.get('gateway');
    if (gw && !gw.up) return { healthy: false, reason: 'gateway health-check down' };
    return { healthy: true, reason: 'healthy' };
  }

  healthyRegions(): RegionName[] {
    return REGIONS.filter((r) => this.regionHealthy(r).healthy);
  }

  /** Regiunea clientului din țară/continent/cod direct. */
  static regionFor(input: { country?: string; continent?: string; region?: string }): RegionName | null {
    if (input.region && (REGIONS as readonly string[]).includes(input.region)) {
      return input.region as RegionName;
    }
    if (input.country) {
      const c = input.country.trim().toUpperCase();
      if (GEO_COUNTRIES[c]) return GEO_COUNTRIES[c];
    }
    if (input.continent) {
      const k = input.continent.trim().toUpperCase();
      if (GEO_CONTINENTS[k]) return GEO_CONTINENTS[k];
    }
    return null;
  }

  /** Decizia de rutare: regiunea primară → lanț de fallback → onest. */
  route(
    input: { country?: string; continent?: string; region?: string },
    healthy?: RegionName[],
  ): RouteDecision {
    const healthyRegions = healthy ?? this.healthyRegions();
    const clientRegion = GlobalLoadBalancer.regionFor(input);
    if (!clientRegion) {
      return {
        ok: false,
        clientRegion: null,
        region: null,
        fallbackUsed: false,
        via: null,
        reason: 'geolocation necunoscută — indică țară, continent sau regiune',
        healthyRegions,
      };
    }
    const primary = this.regionHealthy(clientRegion).healthy;
    if (primary) {
      return {
        ok: true,
        clientRegion,
        region: clientRegion,
        fallbackUsed: false,
        via: clientRegion,
        reason: 'regiune primară sănătoasă',
        healthyRegions,
      };
    }
    // fallback automat pe lanțul de preferințe
    for (const candidate of FALLBACK_CHAINS[clientRegion]) {
      if (this.regionHealthy(candidate).healthy) {
        this.reroutesTotal++;
        return {
          ok: true,
          clientRegion,
          region: candidate,
          fallbackUsed: true,
          via: candidate,
          reason: `regiunea primară ${clientRegion.toUpperCase()} down — redirect automat către ${candidate.toUpperCase()}`,
          healthyRegions,
        };
      }
    }
    return {
      ok: false,
      clientRegion,
      region: null,
      fallbackUsed: false,
      via: null,
      reason: 'toate regiunile din lanțul de fallback sunt down',
      healthyRegions,
    };
  }

  status(): {
    regions: { name: RegionName; label: string; healthy: boolean; reason: string; chain: RegionName[] }[];
    healthChecks: Record<string, HealthState>;
    mandatoryUp: boolean;
    geoContinents: Record<string, RegionName>;
    geoCountries: number;
  } {
    const checks: Record<string, HealthState> = {};
    for (const [k, v] of this.health.entries()) checks[k] = v;
    const mandatoryUp = Object.entries(HEALTH_CHECKS)
      .filter(([, c]) => c.mandatory)
      .every(([name]) => this.health.get(name)?.up === true);
    return {
      regions: REGIONS.map((r) => ({
        name: r,
        label: r.toUpperCase(),
        healthy: this.regionHealthy(r).healthy,
        reason: this.regionHealthy(r).reason,
        chain: FALLBACK_CHAINS[r],
      })),
      healthChecks: checks,
      mandatoryUp,
      geoContinents: GEO_CONTINENTS,
      geoCountries: Object.keys(GEO_COUNTRIES).length,
    };
  }
}

async function probe(
  url: string,
  timeoutMs: number,
  isOk: (code: number) => boolean,
): Promise<{ up: boolean; latencyMs: number | null; error: string | null }> {
  const start = Date.now();
  try {
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), timeoutMs);
    const res = await fetch(url, { signal: ac.signal });
    clearTimeout(to);
    return { up: isOk(res.status), latencyMs: Date.now() - start, error: null };
  } catch (e) {
    return { up: false, latencyMs: null, error: (e as Error).message?.slice(0, 120) ?? 'error' };
  }
}

/** PING Redis prin socket TCP raw (protocolul RESP, read-only). */
async function redisPing(host: string, port: number): Promise<{ up: boolean; latencyMs: number | null; error: string | null }> {
  const start = Date.now();
  try {
    const { connect } = await import('node:net');
    return await new Promise((resolve) => {
      const sock = connect({ host, port, timeout: HEALTH_TIMEOUT_MS });
      const fail = (err: string) => {
        sock.destroy();
        resolve({ up: false, latencyMs: null, error: err });
      };
      sock.on('connect', () => sock.write('*1\r\n$4\r\nPING\r\n'));
      sock.on('data', (buf) => {
        const ok = buf.toString().startsWith('+PONG');
        sock.end();
        resolve({ up: ok, latencyMs: Date.now() - start, error: ok ? null : 'unexpected_reply' });
      });
      sock.on('error', (e) => fail((e as Error).message));
      sock.on('timeout', () => fail('timeout'));
    });
  } catch (e) {
    return { up: false, latencyMs: null, error: (e as Error).message ?? 'error' };
  }
}
