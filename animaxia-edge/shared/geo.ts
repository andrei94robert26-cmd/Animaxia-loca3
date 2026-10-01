/**
 * shared/geo.ts — FAZA 22 global geo-routing toolkit (pure functions).
 *
 * Maps Cloudflare request geo (request.cf) to one of the three Animaxia
 * origin regions and picks a regional upstream with failover. Used by the
 * gateway (worker/src/index.ts) behind the ORIGIN_REGIONS env gate — when
 * that gate is OFF (the default) none of this code influences any request.
 *
 *   • REGION_ORDER / EdgeRegion  — the fixed region set eu | us | asia
 *   • parseOriginRegions(json)   — validate the ORIGIN_REGIONS env value:
 *     a JSON object carrying ALL THREE regions as https URLs. Returns the
 *     normalized map, or null on anything invalid/empty (null = feature OFF
 *     — the caller must treat null as "no geo routing").
 *   • regionForRequest(cf)      — continent mapping (EU/AF→eu, NA/SA→us,
 *     AS/OC→asia) with country-code fallback (US/CA/MX→us,
 *     JP/CN/KR/IN/AU/SG→asia, DE/FR/GB/RO/…→eu) and 'eu' as the default.
 *   • failoverChain(region)     — [region, ...others in REGION_ORDER].
 *   • pickUpstream(origins, region, isHealthy) — first healthy region in
 *     the failover chain; isHealthy is injected so callers own the health
 *     model (the gateway uses a 30s in-memory unhealthy map).
 *
 * Pure functions — zero side effects, zero runtime imports; fully
 * unit-testable (tests/smoke-edge.mjs suite 15).
 */

/** The fixed Animaxia origin region set (failover order for "others"). */
export const REGION_ORDER = ['eu', 'us', 'asia'] as const;

export type EdgeRegion = (typeof REGION_ORDER)[number];

/**
 * The slice of Cloudflare request.cf consumed here. Loose on purpose:
 * request.cf is a union (IncomingRequestCfProperties | RequestInitCfProperties)
 * in @cloudflare/workers-types, so the interface carries an index signature
 * and every field is validated with typeof inside regionForRequest.
 */
export interface CfGeo {
  [key: string]: unknown;
  country?: unknown;
  continent?: unknown;
  colo?: unknown;
}

/** Continent (ISO-ish, uppercase) → serving region. */
const CONTINENT_TO_REGION: Record<string, EdgeRegion> = {
  EU: 'eu',   // Europe
  AF: 'eu',   // Africa → served from eu (closest of the three)
  NA: 'us',   // North America
  SA: 'us',   // South America → us
  AS: 'asia', // Asia
  OC: 'asia', // Oceania → asia
};

/**
 * Country-code fallback (ISO 3166-1 alpha-2, uppercase) used when the
 * continent is missing or unrecognized. Covers the largest audience
 * markets; every other country falls through to the 'eu' default.
 */
const COUNTRY_TO_REGION: Record<string, EdgeRegion> = {
  // us
  US: 'us', CA: 'us', MX: 'us',
  // asia
  JP: 'asia', CN: 'asia', KR: 'asia', IN: 'asia', AU: 'asia', SG: 'asia',
  // eu (representative European markets — RO included, home market)
  DE: 'eu', FR: 'eu', GB: 'eu', RO: 'eu', IT: 'eu', ES: 'eu', NL: 'eu',
  PL: 'eu', SE: 'eu', AT: 'eu', BE: 'eu', CH: 'eu', CZ: 'eu', HU: 'eu',
};

/**
 * Parse + validate the ORIGIN_REGIONS env value: JSON such as
 *   {"eu":"https://eu.origin.animaxia.com","us":"https://us…","asia":"https://asia…"}
 *
 * Rules: must be a non-empty JSON object carrying ALL THREE regions
 * (eu/us/asia) as https:// URLs (trailing slashes trimmed). Anything else —
 * empty string, non-JSON, missing region, non-https URL, non-string value —
 * returns null, which the caller MUST treat as "geo routing OFF" (the
 * pre-FAZA-22 default path). Extra keys are ignored (forward compatible).
 */
export function parseOriginRegions(
  json: string | null | undefined,
): Record<EdgeRegion, string> | null {
  if (typeof json !== 'string' || json.trim() === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const out: Partial<Record<EdgeRegion, string>> = {};
  for (const region of REGION_ORDER) {
    const value = record[region];
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed || !/^https:\/\//i.test(trimmed)) return null; // https URLs only
    out[region] = trimmed.replace(/\/+$/, '');
  }
  return out as Record<EdgeRegion, string>;
}

/**
 * Resolve the serving region for a request: continent mapping first, then
 * the country-code fallback, then the 'eu' default. Never throws; a missing
 * cf object (local dev / tests) maps to the default.
 */
export function regionForRequest(cf: CfGeo | null | undefined): EdgeRegion {
  const continentRaw = cf?.continent;
  const continent = typeof continentRaw === 'string' ? continentRaw.trim().toUpperCase() : '';
  if (continent && CONTINENT_TO_REGION[continent]) return CONTINENT_TO_REGION[continent];
  const countryRaw = cf?.country;
  const country = typeof countryRaw === 'string' ? countryRaw.trim().toUpperCase() : '';
  if (country && COUNTRY_TO_REGION[country]) return COUNTRY_TO_REGION[country];
  return 'eu'; // default region
}

/**
 * The failover chain for a region: the region itself first, then the other
 * regions in REGION_ORDER. Example: failoverChain('us') → ['us','eu','asia'].
 */
export function failoverChain(region: EdgeRegion): EdgeRegion[] {
  const chain: EdgeRegion[] = [region];
  for (const r of REGION_ORDER) {
    if (r !== region) chain.push(r);
  }
  return chain;
}

/** pickUpstream result: the chosen upstream URL + region + failover hint. */
export interface UpstreamPick {
  /** Base URL of the selected regional origin (trailing slashes trimmed). */
  upstream: string;
  /** The region the upstream belongs to (for health bookkeeping). */
  via: EdgeRegion;
  /** Next healthy region in the chain after the chosen one, or null. */
  fallback: EdgeRegion | null;
}

/**
 * Pick the first HEALTHY upstream in the region's failover chain. `isHealthy`
 * is injected (the gateway owns the health model — an in-memory unhealthy
 * map with a TTL). Returns null when every region in the chain is unhealthy
 * (callers then fall back to their legacy path).
 */
export function pickUpstream(
  origins: Record<EdgeRegion, string>,
  region: EdgeRegion,
  isHealthy: (region: EdgeRegion) => boolean,
): UpstreamPick | null {
  const chain = failoverChain(region);
  for (let i = 0; i < chain.length; i += 1) {
    const candidate = chain[i];
    if (!isHealthy(candidate)) continue;
    let fallback: EdgeRegion | null = null;
    for (let j = i + 1; j < chain.length && fallback === null; j += 1) {
      if (isHealthy(chain[j])) fallback = chain[j];
    }
    return { upstream: origins[candidate], via: candidate, fallback };
  }
  return null;
}
