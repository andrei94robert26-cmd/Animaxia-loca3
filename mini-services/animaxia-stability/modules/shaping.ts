/**
 * shaping.ts — FAZA 24 — protecție overload (traffic shaping).
 *
 * Plan de control al prioritizării (aplicarea efectivă în producție stă
 * în gateway/edge — artefactul animaxia-cloud/deploy/stability-faza24/
 * traffic-shaping.yaml; local, perimetrul FAZA 22 al gateway-ului deja
 * limitează pe clase search/hub/ai/general, iar pipeline-ul FAZA 18
 * rămâne autoritatea în interior — NICIUNUL nu este modificat).
 *
 *   • API CRITICE (auth, search, huburi, player) — prioritizate; se
 *     încetinesc doar la overload extrem (≥1.8×) și NU se resping niciodată.
 *   • API normale — încetinite la ≥1.3×, respinse onest la ≥1.5×.
 *   • API non-critice — respinse onest de la ≥1.0× cu Retry-After.
 *
 * Orice respingere poartă mesajul onest „platformă ocupată" (RO).
 */

import {
  REGION_LIMIT_RPS,
  SHAPING_BUSY_MESSAGE,
  SHAPING_CLASSES,
  SHAPING_EVAL_HISTORY_MAX,
  SHAPING_RETRY_AFTER,
  SHAPING_THRESHOLDS,
  type RegionName,
  type ShapingClass,
} from '../config';

export interface ShapingEvaluation {
  t: number;
  path: string;
  region: RegionName;
  clazz: ShapingClass;
  loadRatio: number;
  action: 'allow' | 'throttle' | 'shed';
  retryAfterMs: number | null;
  message: string | null;
}

export class TrafficShaper {
  history: ShapingEvaluation[] = [];
  counters = { allow: 0, throttle: 0, shed: 0 };

  /** Clasa unei căi (prima potrivire în ordinea critică). */
  static classFor(path: string): ShapingClass {
    for (const c of SHAPING_CLASSES) {
      for (const prefix of c.prefixes) {
        if (path === prefix || path.startsWith(prefix)) return c.clazz;
      }
    }
    return 'normal'; // căi necunoscute → normal (nu critic, nu sheddable)
  }

  /**
   * Evaluează o cerere: region + currentRps (implicit încărcarea reală
   * observată de reader, transmisă de index.ts) → decizie onestă.
   */
  evaluate(path: string, region: RegionName, currentRps: number): ShapingEvaluation {
    const limit = REGION_LIMIT_RPS[region] ?? 500;
    const ratio = limit > 0 ? currentRps / limit : 0;
    const clazz = TrafficShaper.classFor(path);
    let action: ShapingEvaluation['action'] = 'allow';
    let retryAfterMs: number | null = null;
    let message: string | null = null;

    if (ratio < SHAPING_THRESHOLDS.shedSheddable) {
      action = 'allow';
    } else if (ratio < SHAPING_THRESHOLDS.throttleNormal) {
      if (clazz === 'sheddable') action = 'shed';
    } else if (ratio < SHAPING_THRESHOLDS.shedNormal) {
      if (clazz === 'sheddable') action = 'shed';
      else if (clazz === 'normal') action = 'throttle';
    } else if (ratio < SHAPING_THRESHOLDS.throttleCritical) {
      if (clazz === 'critical') action = 'allow';
      else if (clazz === 'normal') action = 'shed';
      else action = 'shed';
    } else {
      // overload extrem: critical se ÎNCETINEȘTE, dar niciodată nu se respinge
      if (clazz === 'critical') action = 'throttle';
      else action = 'shed';
    }

    if (action === 'throttle') retryAfterMs = SHAPING_RETRY_AFTER.throttleMs;
    if (action === 'shed') {
      retryAfterMs = SHAPING_RETRY_AFTER.shedMs;
      message = SHAPING_BUSY_MESSAGE;
    }

    const evaluation: ShapingEvaluation = {
      t: Date.now(),
      path,
      region,
      clazz,
      loadRatio: Math.round(ratio * 100) / 100,
      action,
      retryAfterMs,
      message,
    };
    this.counters[action]++;
    this.history.push(evaluation);
    if (this.history.length > SHAPING_EVAL_HISTORY_MAX) {
      this.history.splice(0, this.history.length - SHAPING_EVAL_HISTORY_MAX);
    }
    return evaluation;
  }

  status(realRegionRps: Record<RegionName, number | null>): {
    classes: { clazz: ShapingClass; label: string; prefixes: string[] }[];
    thresholds: typeof SHAPING_THRESHOLDS;
    busyMessage: string;
    retryAfter: typeof SHAPING_RETRY_AFTER;
    regions: { region: RegionName; limitRps: number; currentRps: number | null; loadRatio: number | null }[];
    counters: { allow: number; throttle: number; shed: number };
    recentEvaluations: ShapingEvaluation[];
  } {
    return {
      classes: SHAPING_CLASSES,
      thresholds: SHAPING_THRESHOLDS,
      busyMessage: SHAPING_BUSY_MESSAGE,
      retryAfter: SHAPING_RETRY_AFTER,
      regions: (Object.keys(REGION_LIMIT_RPS) as RegionName[]).map((region) => {
        const current = realRegionRps[region];
        const limit = REGION_LIMIT_RPS[region];
        return {
          region,
          limitRps: limit,
          currentRps: current != null ? Math.round(current * 100) / 100 : null,
          loadRatio: current != null ? Math.round((current / limit) * 100) / 100 : null,
        };
      }),
      counters: { ...this.counters },
      recentEvaluations: [...this.history].reverse().slice(0, 12),
    };
  }
}
