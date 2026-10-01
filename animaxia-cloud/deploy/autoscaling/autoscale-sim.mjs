#!/usr/bin/env bun
/**
 * autoscale-sim.mjs — decision engine mirroring the HPA policies (FAZA 22).
 *
 * Imports ./policies.json (the single source of truth shared with the
 * Kubernetes HPAs) and exposes:
 *
 *   decideAutoscale(service, windows, currentReplicas?) → {
 *     action: 'scale-up' | 'scale-down' | 'hold',
 *     reason: string,
 *     targetReplicas?: number,
 *   }
 *
 * where `windows` is an array of telemetry snapshots
 * { cpuPct, memPct, p95Ms } (oldest → newest, one per evaluation window)
 * and `currentReplicas` defaults to the policy floor.
 *
 * Decision rules (per policies.json):
 *   • scale-up   — cpu > cpuTarget OR mem > memTarget OR p95 > latencyP95MsTarget
 *                  sustained for `scaleUpWindows` CONSECUTIVE windows (the
 *                  last N windows must each breach at least one target).
 *                  targetReplicas = ceil(current × worst overload ratio),
 *                  clamped to [min, max].
 *   • scale-down — ALL three signals below their targets for
 *                  `scaleDownWindows` consecutive windows.
 *                  targetReplicas = max(min, floor(current × 0.75)) — the
 *                  same 25% step the HPA scaleDown policy uses.
 *   • hold       — anything else (not sustained, mixed windows, already at
 *                  the floor/ceiling).
 *
 * CLI (no side effects on import — guarded by import.meta.main):
 *   bun autoscale-sim.mjs --demo     # 4 scenarios with decisions
 */

import policies from './policies.json';

/** Clamp n into [lo, hi]. */
function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Which policy target a window breaches (if any).
 * Returns 'cpu' | 'mem' | 'latency' | null.
 */
function breachOf(window, policy) {
  if (window.cpuPct > policy.cpuTarget) return 'cpu';
  if (window.memPct > policy.memTarget) return 'mem';
  if (window.p95Ms > policy.latencyP95MsTarget) return 'latency';
  return null;
}

/** Validate + normalize one window snapshot. */
function normalizeWindow(window, index) {
  const out = {
    cpuPct: Number(window?.cpuPct),
    memPct: Number(window?.memPct),
    p95Ms: Number(window?.p95Ms),
  };
  for (const [key, value] of Object.entries(out)) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`autoscale-sim: window[${index}].${key} must be a finite number >= 0 (got ${String(window?.[key])})`);
    }
  }
  return out;
}

/**
 * Decide the autoscaling action for one service given its recent telemetry
 * windows (oldest → newest). Pure decision logic — performs no I/O; safe to
 * import from tests.
 */
export async function decideAutoscale(service, windows, currentReplicas) {
  const policy = policies.services?.[service];
  if (!policy) {
    throw new Error(`autoscale-sim: unknown service '${service}' (known: ${Object.keys(policies.services).join(', ')})`);
  }
  if (!Array.isArray(windows) || windows.length === 0) {
    return { action: 'hold', reason: 'no telemetry windows yet' };
  }
  const normalized = windows.map(normalizeWindow);
  const replicas = Number.isFinite(Number(currentReplicas))
    ? Math.floor(Number(currentReplicas))
    : policy.min;

  /* ------------------------------------------------------------ scale-up --- */
  const upWindows = normalized.slice(-policy.scaleUpWindows);
  if (upWindows.length === policy.scaleUpWindows && upWindows.every((w) => breachOf(w, policy) !== null)) {
    // Worst overload ratio across the sustained windows drives the target.
    const ratioOf = (w) => Math.max(
      w.cpuPct / policy.cpuTarget,
      w.memPct / policy.memTarget,
      w.p95Ms / policy.latencyP95MsTarget,
    );
    const worst = upWindows.reduce((acc, w) => Math.max(acc, ratioOf(w)), 1);
    const target = clamp(Math.ceil(replicas * worst), policy.min, policy.max);
    const breaches = [...new Set(upWindows.map((w) => breachOf(w, policy)))].join('+');
    if (target <= replicas && replicas >= policy.max) {
      return { action: 'hold', reason: `${breaches} sustained but already at max ${policy.max} replicas` };
    }
    return {
      action: 'scale-up',
      reason: `${breaches} above target for ${policy.scaleUpWindows} consecutive windows (worst overload x${worst.toFixed(2)})`,
      targetReplicas: Math.max(target, replicas + 1),
    };
  }

  /* ---------------------------------------------------------- scale-down --- */
  const downWindows = normalized.slice(-policy.scaleDownWindows);
  if (downWindows.length === policy.scaleDownWindows && downWindows.every((w) => breachOf(w, policy) === null)) {
    const target = Math.max(policy.min, Math.floor(replicas * 0.75));
    if (target < replicas) {
      return {
        action: 'scale-down',
        reason: `cpu/mem/latency all below target for ${policy.scaleDownWindows} consecutive windows (-25% step)`,
        targetReplicas: target,
      };
    }
    return { action: 'hold', reason: `all signals quiet but already at the ${policy.min}-replica floor` };
  }

  /* ----------------------------------------------------------------- hold --- */
  const last = normalized[normalized.length - 1];
  const lastBreach = breachOf(last, policy);
  return {
    action: 'hold',
    reason: lastBreach
      ? `${lastBreach} above target but not sustained for ${policy.scaleUpWindows} windows`
      : 'signals within targets; scale-down window not yet met',
  };
}

/** The full policy table (re-exported for tests / tooling). */
export { policies };

/* ------------------------------------------------------------------ CLI ----- */

async function demo() {
  console.log('Animaxia autoscale simulator — policies from policies.json\n');

  const scenarios = [
    {
      name: '1. backend — sustained CPU spike (2 windows over 70%)',
      service: 'backend',
      replicas: 4,
      windows: [
        { cpuPct: 82, memPct: 60, p95Ms: 600 },
        { cpuPct: 88, memPct: 64, p95Ms: 700 },
        { cpuPct: 91, memPct: 66, p95Ms: 780 },
      ],
    },
    {
      name: '2. backend — brief spike then recovery (NOT sustained)',
      service: 'backend',
      replicas: 4,
      windows: [
        { cpuPct: 95, memPct: 60, p95Ms: 600 },
        { cpuPct: 40, memPct: 50, p95Ms: 400 },
        { cpuPct: 38, memPct: 48, p95Ms: 380 },
      ],
    },
    {
      name: '3. global-gateway — latency breach sustained (p95 > 150ms)',
      service: 'global-gateway',
      replicas: 2,
      windows: [
        { cpuPct: 55, memPct: 50, p95Ms: 240 },
        { cpuPct: 58, memPct: 52, p95Ms: 280 },
      ],
    },
    {
      name: '4. backend — quiet period (5 windows all below target)',
      service: 'backend',
      replicas: 8,
      windows: [
        { cpuPct: 30, memPct: 40, p95Ms: 300 },
        { cpuPct: 28, memPct: 39, p95Ms: 290 },
        { cpuPct: 25, memPct: 38, p95Ms: 280 },
        { cpuPct: 24, memPct: 37, p95Ms: 275 },
        { cpuPct: 22, memPct: 36, p95Ms: 260 },
      ],
    },
  ];

  for (const scenario of scenarios) {
    const decision = await decideAutoscale(scenario.service, scenario.windows, scenario.replicas);
    console.log(`━ ${scenario.name}`);
    console.log(`  service=${scenario.service} currentReplicas=${scenario.replicas}`);
    console.log(`  → ${decision.action.toUpperCase()}${decision.targetReplicas !== undefined ? ` → ${decision.targetReplicas} replicas` : ''}`);
    console.log(`    ${decision.reason}\n`);
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes('--demo')) {
    await demo();
  } else {
    console.log('usage: bun autoscale-sim.mjs --demo   (or import decideAutoscale from code)');
    console.log('       library use: decideAutoscale(service, windows[], currentReplicas?)');
  }
}
