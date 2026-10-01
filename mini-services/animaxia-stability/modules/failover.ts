/**
 * failover.ts — FAZA 24 — failover automat + stare ținte critice.
 *
 * Ținte: backend, gateway (per regiune), 4 motoare AI, Neon.
 *
 *  • REGIUNI: simularea „down" folosește API-ul admin REAL al gateway-ului
 *    FAZA 22 (POST /api/infra/regions/:name/down) — proxy-uirile reale
 *    eșuează peste cu antetul x-animaxia-fallback: true. ZERO modificări
 *    de cod pe gateway; mecanismul lui documentat, exercițiat.
 *  • BACKEND / AI / NEON: starea reală vine din health-check-uri și
 *    metrici; simulările QA marchează starea degradată în planul de
 *    control (evenimente + decizii LB), fără să mintă despre health-ul real.
 *  • NEON: în sandbox platforma rulează cu driver local de fallback +
 *    sondă de reconectare la 60s (Task 1-a) — failover-ul DB există DEJA
 *    în platformă; aici îl observăm și îl înregistrăm onest.
 */

import {
  GATEWAY_REGION_ADMIN,
  REGIONS,
  type RegionName,
} from '../config';

export type FailoverTargetId =
  | 'backend'
  | 'neon'
  | 'ai-home'
  | 'ai-hub'
  | 'ai-personal'
  | 'ai-rag'
  | `region-${RegionName}`;

export interface FailoverEvent {
  t: number;
  target: string;
  action: 'down' | 'up' | 'detected-down' | 'detected-up' | 'recovered';
  simulated: boolean;
  detail: string;
}

export class FailoverManager {
  events: FailoverEvent[] = [];
  /** Ținte marcate down sintetic (QA) — cheie = target id. */
  private simulatedDown = new Set<string>();
  private eventLimit = 100;

  private log(target: string, action: FailoverEvent['action'], simulated: boolean, detail: string): void {
    this.events.push({ t: Date.now(), target, action, simulated, detail });
    if (this.events.length > this.eventLimit) this.events.splice(0, this.events.length - this.eventLimit);
  }

  /* ---- regiuni (prin API-ul admin real al gateway-ului FAZA 22) ---- */

  regionSimulatedDown(region: RegionName): boolean {
    return this.simulatedDown.has(`region-${region}`);
  }

  gatewayRegionForcedDown(region: RegionName): boolean {
    return this.simulatedDown.has(`region-${region}`);
  }

  /** POST către gateway-ul real (mecanism FAZA 22, documentat în README-ul lui). */
  async setRegion(region: RegionName, down: boolean): Promise<{ ok: boolean; detail: string }> {
    const action = down ? 'down' : 'up';
    try {
      const res = await fetch(`${GATEWAY_REGION_ADMIN}/${region}/${action}`, { method: 'POST' });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean };
      const ok = res.status === 200 && body.ok !== false;
      if (down) this.simulatedDown.add(`region-${region}`);
      else this.simulatedDown.delete(`region-${region}`);
      this.log(
        `region-${region}`,
        down ? 'down' : 'up',
        true,
        ok
          ? `gateway admin API: regiunea ${region.toUpperCase()} ${down ? 'forced down' : 'restaurată'} — proxy-uirile reale ${down ? 'failover-esc către lanțul de regiuni' : 'revin în regiunea primară'}`
          : `gateway admin API a răspuns ${res.status}`,
      );
      return { ok, detail: ok ? `region ${region} ${action}` : `gateway admin HTTP ${res.status}` };
    } catch (e) {
      return { ok: false, detail: (e as Error).message ?? 'gateway admin unreachable' };
    }
  }

  /* ---- backend / AI / Neon (stare sintetică QA + detecție reală) ---- */

  simulate(target: FailoverTargetId, down: boolean): { ok: boolean; detail: string } {
    if (target.startsWith('region-')) {
      const region = target.slice('region-'.length) as RegionName;
      if (!(REGIONS as readonly string[]).includes(region)) {
        return { ok: false, detail: 'regiune necunoscută (eu|us|asia)' };
      }
      // regiunile trec prin API-ul real (async) — expus separat
      return { ok: false, detail: 'folosește acțiunea de regiune (cheamă setRegion)' };
    }
    if (down) this.simulatedDown.add(target);
    else this.simulatedDown.delete(target);
    this.log(
      target,
      down ? 'down' : 'up',
      true,
      down
        ? ` QA: ${target} marcat degradat în planul de control — LB/redirecționare recomandată; health-ul real continuă să fie raportat separat`
        : `QA: ${target} restaurat în planul de control`,
    );
    return { ok: true, detail: `${target} ${down ? 'down (simulat)' : 'up'}` };
  }

  isSimulatedDown(target: string): boolean {
    return this.simulatedDown.has(target);
  }

  /** Înregistrează o detecție REALĂ (ex. neon trece în fallback driver). */
  recordDetection(target: string, down: boolean, detail: string): void {
    this.log(target, down ? 'detected-down' : 'detected-up', false, detail);
  }

  state(): {
    targets: { id: string; degraded: boolean; simulated: boolean }[];
    events: FailoverEvent[];
    regionsReal: Record<string, boolean>;
  } {
    return {
      targets: ['backend', 'neon', 'ai-home', 'ai-hub', 'ai-personal', 'ai-rag', ...REGIONS.map((r) => `region-${r}`)].map(
        (id) => ({ id, degraded: this.simulatedDown.has(id), simulated: this.simulatedDown.has(id) }),
      ),
      events: [...this.events].reverse(),
      regionsReal: {},
    };
  }
}
