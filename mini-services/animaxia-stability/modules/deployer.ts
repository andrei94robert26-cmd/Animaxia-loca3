/**
 * deployer.ts — FAZA 24 — zero-downtime deploy (rolling updates).
 *
 * Simulator de rolling update care exerciță porți de health REALE:
 * pentru fiecare replică (surge) se face un GET efectiv către endpoint-ul
 * de health AL ȚINTEI (backend :4000/api/health, gateway :4040/api/infra/health,
 * motoare AI — rutele lor reale). Doar după 200 traficul „trece" pe noua
 * replică; vechiul pod se retrage. maxUnavailable = 0 (zero-downtime).
 *
 * Eșec la orice pas (poarta reală nu răspunde 200 sau failAtStep QA) →
 * ROLLBACK AUTOMAT la versiunea anterioară, cu eveniment + motiv.
 */

import {
  DEPLOY_HEALTH_GATES,
  DEPLOY_HEALTH_TIMEOUT_MS,
  DEPLOY_HISTORY_MAX,
  DEPLOY_STEP_MS,
} from '../config';

export interface DeployStep {
  index: number;
  action: 'surge' | 'health-check' | 'ready' | 'retire-old';
  ok: boolean;
  detail: string;
  at: number;
}

export interface Rollout {
  id: string;
  target: string;
  fromVersion: string;
  toVersion: string;
  status: 'running' | 'success' | 'rolled-back';
  startedAt: number;
  finishedAt: number | null;
  replicas: number;
  steps: DeployStep[];
  unavailableReplicas: number;
  reason?: string;
}

interface DeployState {
  versions: Record<string, string>;
  history: Rollout[];
  active: Rollout | null;
  rolloutsTotal: { success: number; 'rolled-back': number };
}

class Deployer {
  state: DeployState = {
    versions: {},
    history: [],
    active: null,
    rolloutsTotal: { success: 0, 'rolled-back': 0 },
  };

  currentVersion(target: string): string {
    return this.state.versions[target] ?? 'v1.0.0';
  }

  status(): { versions: Record<string, string>; active: Rollout | null; history: Rollout[]; rolloutsTotal: { success: number; 'rolled-back': number } } {
    return {
      versions: { ...this.state.versions },
      active: this.state.active,
      history: [...this.state.history].reverse(),
      rolloutsTotal: { ...this.state.rolloutsTotal },
    };
  }

  /** Pornește un rolling update asincron. failAtStep = doar QA (forțează pasul N să eșueze). */
  async start(
    target: string,
    toVersion: string,
    replicas: number,
    failAtStep?: number,
  ): Promise<{ ok: boolean; error?: string; rolloutId?: string }> {
    if (!DEPLOY_HEALTH_GATES[target]) return { ok: false, error: 'țintă de deploy necunoscută' };
    if (this.state.active) return { ok: false, error: 'un rollout este deja activ' };
    if (!/^v[0-9]+\.[0-9]+\.[0-9]+(-[a-z0-9.-]+)?$/.test(toVersion)) {
      return { ok: false, error: 'versiune invalidă (ex: v2.4.0)' };
    }
    const id = `ro-${Date.now().toString(36)}`;
    const fromVersion = this.currentVersion(target);
    const rollout: Rollout = {
      id,
      target,
      fromVersion,
      toVersion,
      status: 'running',
      startedAt: Date.now(),
      finishedAt: null,
      replicas,
      steps: [],
      unavailableReplicas: 0,
    };
    this.state.active = rollout;
    void this.run(rollout, failAtStep);
    return { ok: true, rolloutId: id };
  }

  private async run(rollout: Rollout, failAtStep?: number): Promise<void> {
    const gate = DEPLOY_HEALTH_GATES[rollout.target];
    try {
      for (let i = 1; i <= rollout.replicas; i++) {
        const step: DeployStep = { index: i, action: 'surge', ok: true, detail: `replică nouă ${rollout.toVersion} pornită (surge)`, at: Date.now() };
        rollout.steps.push(step);
        await sleep(DEPLOY_STEP_MS);

        // poarta de health REALĂ — înainte de trafic
        const check = await realHealthGate(gate);
        const forcedFail = failAtStep === i;
        if (!check.ok || forcedFail) {
          rollout.steps.push({
            index: i,
            action: 'health-check',
            ok: false,
            detail: forcedFail
              ? `poarta de health a eșuat FORȚAT (QA failAtStep=${i}) — ${gate}`
              : `poarta de health a eșuat (${check.detail}) — ${gate}`,
            at: Date.now(),
          });
          throw new Error(
            `health gate failed la replică ${i}: ${forcedFail ? 'forțat QA' : check.detail}`,
          );
        }
        rollout.steps.push({
          index: i,
          action: 'health-check',
          ok: true,
          detail: `GET ${gate} → 200 în ${check.ms}ms`,
          at: Date.now(),
        });
        await sleep(DEPLOY_STEP_MS);

        rollout.steps.push({ index: i, action: 'ready', ok: true, detail: 'trafic mutat pe noua replică', at: Date.now() });
        await sleep(DEPLOY_STEP_MS);
        rollout.steps.push({ index: i, action: 'retire-old', ok: true, detail: `replica veche ${rollout.fromVersion} retrasă (maxUnavailable=0)`, at: Date.now() });
        await sleep(DEPLOY_STEP_MS);
      }
      // succes
      rollout.status = 'success';
      rollout.finishedAt = Date.now();
      this.state.versions[rollout.target] = rollout.toVersion;
      this.state.rolloutsTotal.success++;
    } catch (e) {
      // ROLLBACK AUTOMAT — replicile revin la versiunea anterioară
      rollout.status = 'rolled-back';
      rollout.finishedAt = Date.now();
      rollout.reason = `rollback automat: ${(e as Error).message}`;
      this.state.rolloutsTotal['rolled-back']++;
      // versiunea rămâne cea veche (rollback complet, disponibil 100%)
    } finally {
      this.state.history.push(rollout);
      if (this.state.history.length > DEPLOY_HISTORY_MAX) {
        this.state.history.splice(0, this.state.history.length - DEPLOY_HISTORY_MAX);
      }
      this.state.active = null;
    }
  }
}

async function realHealthGate(url: string): Promise<{ ok: boolean; ms: number; detail: string }> {
  const start = Date.now();
  try {
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), DEPLOY_HEALTH_TIMEOUT_MS);
    const res = await fetch(url, { signal: ac.signal });
    clearTimeout(to);
    const ms = Date.now() - start;
    return { ok: res.status === 200, ms, detail: `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, ms: Date.now() - start, detail: (e as Error).message ?? 'unreachable' };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export const deployer = new Deployer();
