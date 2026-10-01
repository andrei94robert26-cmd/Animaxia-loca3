/**
 * autoscaler.ts — FAZA 24 — motorul de decizie autoscaling.
 *
 * evaluateSeries() este O FUNCȚIE PURĂ folosită IDENTIC de:
 *   (a) bucla live — re-procesează istoricul real de mostre la fiecare 10s
 *       (decizii deterministe, re-derivate din istoric, zero drift de stare);
 *   (b) simulatorul QA (POST /api/autoscaling/simulate) — serii sintetice
 *       care verifică EXACT aceleași reguli (fără mutarea stării live).
 *
 * Semantica ferestrelor: o regulă declanșează când condiția e adevărată
 * CONTINUU ≥ windowSec; prima încălcare resetează fereastra complet.
 * Cooldown global per țintă între pașii de scale-out (HPA-like) și
 * stabilizare obligatorie înainte de scale-in.
 */

import type { Rule, TargetPolicy } from '../config';

/** O mostră de metrici (t = secunde, monoton). Câmpurile lipsă = nedisponibile. */
export interface Sample {
  t: number;
  cpuPct?: number | null;
  ramBytes?: number | null;
  latencyP95Ms?: number | null;
  queueLength?: number | null;
  rps?: number | null;
  errorRatePct?: number | null;
  reqPerMin?: number | null;
  llmLatencyMs?: number | null;
  timeoutRatePct?: number | null;
}

export interface Decision {
  t: number;
  direction: 'out' | 'in';
  rule: string;
  from: number;
  to: number;
}

export interface RuleState {
  id: string;
  active: boolean;
  since: number | null;
  satisfiedFor: number;
  fired: boolean;
  windowSec: number;
  lastValue: number | null;
}

export interface EvalResult {
  replicas: number;
  decisions: Decision[];
  ruleStates: RuleState[];
}

interface RuleRuntime {
  rule: Rule;
  direction: 'out' | 'in';
  active: boolean;
  since: number | null;
  fired: boolean;
  lastValue: number | null;
}

function derived(sample: Sample, replicas: number): Record<string, number | null | undefined> {
  return {
    ...sample,
    rpsPerReplica: sample.rps != null && replicas > 0 ? sample.rps / replicas : null,
    reqPerMinPerReplica:
      sample.reqPerMin != null && replicas > 0 ? sample.reqPerMin / replicas : null,
  };
}

function check(rule: Rule, values: Record<string, number | null | undefined>): number | null {
  const v = values[rule.metric];
  if (v == null || !Number.isFinite(v)) return null;
  const ok = rule.op === '>' ? v > rule.threshold : v < rule.threshold;
  return ok ? v : null; // valoarea dacă condiția e adevărată, altfel null
}

/**
 * Evaluează o serie de mostre pornind de la startReplicas.
 * Replicile rezultate + deciziile (cu timpii exacte) + starea regulilor.
 */
export function evaluateSeries(
  policy: TargetPolicy,
  samples: Sample[],
  startReplicas?: number,
): EvalResult {
  let replicas = Math.min(
    policy.maxReplicas,
    Math.max(policy.minReplicas, startReplicas ?? policy.minReplicas),
  );

  const outRt: RuleRuntime[] = policy.scaleOut.map((rule) => ({
    rule,
    direction: 'out',
    active: false,
    since: null,
    fired: false,
    lastValue: null,
  }));
  const inRt: RuleRuntime[] = policy.scaleIn.map((rule) => ({
    rule,
    direction: 'in',
    active: false,
    since: null,
    fired: false,
    lastValue: null,
  }));
  const allRt = [...outRt, ...inRt];

  const decisions: Decision[] = [];
  let lastScaleOutAt = Number.NEGATIVE_INFINITY;
  let lastScaleInAt = Number.NEGATIVE_INFINITY;

  const sorted = [...samples].sort((a, b) => a.t - b.t);

  for (const s of sorted) {
    const values = derived(s, replicas);

    // 1) actualizarea ferestrelor (înainte de decizii — starea la momentul t)
    for (const rt of allRt) {
      const hit = check(rt.rule, values);
      rt.lastValue = values[rt.rule.metric] ?? null;
      if (hit != null) {
        if (!rt.active) {
          rt.active = true;
          rt.since = s.t;
        }
        rt.fired = false; // re-armare continuă după cooldown
      } else {
        rt.active = false;
        rt.since = null;
        rt.fired = false;
      }
    }

    // 2) scale-out: OR — prima regulă cu fereastra satisfăcută și cooldown trecut
    let scaledOut = false;
    for (const rt of outRt) {
      if (!rt.active || rt.since == null) continue;
      const held = s.t - rt.since;
      if (held < rt.rule.windowSec) continue;
      if (s.t - lastScaleOutAt < policy.scaleUpCooldownSec) continue;
      if (replicas >= policy.maxReplicas) break;
      const from = replicas;
      replicas = Math.min(policy.maxReplicas, replicas + policy.stepOut);
      decisions.push({ t: s.t, direction: 'out', rule: rt.rule.id, from, to: replicas });
      rt.fired = true;
      lastScaleOutAt = s.t;
      scaledOut = true;
      break; // un singur pas de scale-out per mostră
    }

    // 3) scale-in: ALL — doar după stabilizare, fără scale-out în această mostră
    if (!scaledOut && policy.scaleIn.length > 0) {
      const withData = inRt.filter((rt) => rt.lastValue != null);
      const canIn =
        withData.length > 0 &&
        withData.every((rt) => rt.active && rt.since != null && s.t - rt.since >= rt.rule.windowSec);
      const stable = s.t - lastScaleOutAt >= policy.scaleDownStabilizationSec;
      const cooldownOk = s.t - lastScaleInAt >= policy.scaleInCooldownSec;
      if (canIn && stable && cooldownOk && replicas > policy.minReplicas) {
        const from = replicas;
        replicas = Math.max(policy.minReplicas, replicas - policy.stepIn);
        decisions.push({
          t: s.t,
          direction: 'in',
          rule: 'all-clear',
          from,
          to: replicas,
        });
        lastScaleInAt = s.t;
      }
    }
  }

  const ruleStates: RuleState[] = allRt.map((rt) => ({
    id: rt.rule.id,
    active: rt.active,
    since: rt.since,
    satisfiedFor: rt.active && rt.since != null && sorted.length ? sorted[sorted.length - 1].t - rt.since : 0,
    fired: rt.fired,
    windowSec: rt.rule.windowSec,
    lastValue: rt.lastValue,
  }));

  return { replicas, decisions, ruleStates };
}

/** Stare live per țintă (istoric + re-evaluare deterministă). */
export interface LiveTarget {
  policy: TargetPolicy;
  samples: Sample[];
  replicas: number;
  decisions: Decision[];
  ruleStates: RuleState[];
  lastSampleAt: number | null;
}

export function newLiveTarget(policy: TargetPolicy): LiveTarget {
  return {
    policy,
    samples: [],
    replicas: policy.minReplicas,
    decisions: [],
    ruleStates: policy
      .scaleOut.concat(policy.scaleIn)
      .map((r) => ({
        id: r.id,
        active: false,
        since: null,
        satisfiedFor: 0,
        fired: false,
        windowSec: r.windowSec,
        lastValue: null,
      })),
    lastSampleAt: null,
  };
}

/** Adaugă o mostră reală și re-derivează TOATE deciziile din istoric. */
export function pushSample(target: LiveTarget, sample: Sample, retention: number): void {
  target.samples.push(sample);
  if (target.samples.length > retention) {
    target.samples.splice(0, target.samples.length - retention);
  }
  const res = evaluateSeries(target.policy, target.samples, target.policy.minReplicas);
  target.replicas = res.replicas;
  target.decisions = res.decisions.slice(-50);
  target.ruleStates = res.ruleStates;
  target.lastSampleAt = sample.t;
}
