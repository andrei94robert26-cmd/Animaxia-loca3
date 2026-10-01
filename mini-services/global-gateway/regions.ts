/**
 * regions.ts — FAZA 22 global gateway region topology + upstream health.
 *
 * Sandbox topology: all healthy upstreams point at the real backend (:4000);
 * the "us" region intentionally lists a dead port first (127.0.0.1:4098) so
 * automatic failover is demonstrable live. Production origins come from
 * regions.production.json (loaded when ANIMAXIA_REGIONS_FILE is set).
 *
 * Overrides (admin down/up) are keyed per (region|upstream) so a shared
 * upstream can be disabled for one region only — e.g. draining "eu" while
 * "asia" keeps serving through the same host in a production topology.
 */

import { readFileSync } from 'node:fs';

export type RegionName = 'eu' | 'us' | 'asia';
export const REGION_CHAIN: RegionName[] = ['eu', 'us', 'asia'];
export const REGION_LABELS: Record<RegionName, string> = {
  eu: 'EU (Frankfurt)',
  us: 'US (Virginia)',
  asia: 'ASIA (Singapore)',
};

export interface UpstreamState {
  url: string;
  healthy: boolean;
  lastError: string | null;
  lastCheck: number;
  latencyMs: number | null;
}

export interface Candidate {
  region: RegionName;
  upstream: string;
  /** true when we left the requested region, or skipped unhealthy upstreams inside it */
  fallback: boolean;
}

export class RegionTable {
  regions: Record<RegionName, string[]>;
  upstreams = new Map<string, UpstreamState>();
  /** admin override: `region|url` -> healthy? (false = forced down) */
  overrides = new Map<string, boolean>();

  constructor() {
    let regions: Record<RegionName, string[]> = {
      eu: ['http://127.0.0.1:4000'],
      us: ['http://127.0.0.1:4098', 'http://127.0.0.1:4000'], // 4098 dead on purpose — failover demo
      asia: ['http://127.0.0.1:4000'],
    };
    const file = process.env.ANIMAXIA_REGIONS_FILE;
    if (file) {
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, string[]>;
        if (parsed.eu?.length && parsed.us?.length && parsed.asia?.length) {
          regions = { eu: parsed.eu, us: parsed.us, asia: parsed.asia };
          console.log(`[regions] production topology loaded from ${file}`);
        } else {
          console.warn('[regions] invalid regions file (need eu/us/asia arrays) — sandbox topology kept');
        }
      } catch (e) {
        console.warn(`[regions] cannot read ${file} — sandbox topology kept: ${(e as Error).message}`);
      }
    }
    this.regions = regions;
    for (const list of Object.values(regions)) {
      for (const u of list) {
        if (!this.upstreams.has(u)) {
          this.upstreams.set(u, { url: u, healthy: true, lastError: null, lastCheck: 0, latencyMs: null });
        }
      }
    }
  }

  isHealthy(region: RegionName, url: string): boolean {
    if (this.overrides.get(`${region}|${url}`) === false) return false;
    return this.upstreams.get(url)?.healthy ?? false;
  }

  markUnhealthy(url: string, err: string): void {
    const s = this.upstreams.get(url);
    if (s) {
      s.healthy = false;
      s.lastError = err;
      s.lastCheck = Date.now();
    }
  }

  markHealthy(url: string, latencyMs: number): void {
    const s = this.upstreams.get(url);
    if (s) {
      s.healthy = true;
      s.lastError = null;
      s.latencyMs = latencyMs;
      s.lastCheck = Date.now();
    }
  }

  /**
   * Ordered healthy candidates: the REQUESTED region first (its upstream
   * order), then the rest of the chain. Empty array = every region is down.
   * (The requested region must lead — QA FAZA 22 caught the original
   * REGION_CHAIN-ordered iteration serving region=asia from eu.)
   */
  candidates(requested: RegionName): Candidate[] {
    const out: Candidate[] = [];
    const chain: RegionName[] = [requested, ...REGION_CHAIN.filter((r) => r !== requested)];
    for (const region of chain) {
      const list = this.regions[region] ?? [];
      let idx = 0;
      for (const u of list) {
        if (this.isHealthy(region, u)) {
          out.push({ region, upstream: u, fallback: region !== requested || idx > 0 });
        }
        idx++;
      }
    }
    return out;
  }

  setOverride(region: RegionName, down: boolean): void {
    for (const u of this.regions[region]) {
      if (down) this.overrides.set(`${region}|${u}`, false);
      else this.overrides.delete(`${region}|${u}`);
    }
  }
}
