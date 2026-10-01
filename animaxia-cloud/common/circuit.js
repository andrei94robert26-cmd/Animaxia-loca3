/**
 * common/circuit.js — Generic circuit breaker for inter-service calls
 * (gateway → microservices, queue → services). Independent from the provider
 * breaker in fetcher.js (that one guards external provider APIs).
 *
 * States: closed → (failures >= threshold) → open → (after openMs) →
 * half-open → (probe success) closed | (probe failure) open.
 *
 * Exposes a Prometheus gauge (animaxia_circuit_state{service,breaker}:
 * 0 closed / 1 half-open / 2 open) so Grafana can alert on open circuits.
 */

import { Gauge, registerMetric } from './metrics.js';

const circuitStateGauge = registerMetric(
  new Gauge({
    name: 'animaxia_circuit_state',
    help: 'Circuit breaker state (0 closed, 1 half-open, 2 open)',
    labelNames: ['service', 'breaker'],
  }),
);

export class CircuitBreaker {
  constructor({ name = 'default', threshold = 3, openMs = 30000, halfOpenMaxCalls = 3 } = {}) {
    this.name = name;
    this.threshold = Math.max(1, threshold);
    this.openMs = Math.max(1000, openMs);
    this.halfOpenMaxCalls = halfOpenMaxCalls;
    this.state = 'closed';
    this.failures = 0;
    this.successes = 0;
    this.openedAt = 0;
    this.lastError = null;
    this.halfOpenInflight = 0;
    this.totalTripped = 0;
    this._publish();
  }

  _publish() {
    circuitStateGauge.set(
      { service: process.env.SERVICENAME || 'unknown', breaker: this.name },
      this.state === 'closed' ? 0 : this.state === 'half-open' ? 1 : 2,
    );
  }

  /** Throws when the circuit disallows the call. */
  allow() {
    if (this.state === 'open') {
      if (Date.now() - this.openedAt >= this.openMs) {
        this.state = 'half-open';
        this.halfOpenInflight = 0;
        this._publish();
      } else {
        const err = new Error(`Circuit open for ${this.name} (retry in ${Math.ceil((this.openedAt + this.openMs - Date.now()) / 1000)}s)`);
        err.status = 503;
        err.circuitOpen = true;
        throw err;
      }
    }
    if (this.state === 'half-open') {
      if (this.halfOpenInflight >= this.halfOpenMaxCalls) {
        const err = new Error(`Circuit half-open probe limit reached for ${this.name}`);
        err.status = 503;
        err.circuitOpen = true;
        throw err;
      }
      this.halfOpenInflight += 1;
    }
  }

  success() {
    if (this.state === 'half-open') {
      this.halfOpenInflight = Math.max(0, this.halfOpenInflight - 1);
      this.successes += 1;
      if (this.successes >= 1) {
        this.state = 'closed';
        this.failures = 0;
        this.successes = 0;
      }
    } else {
      this.failures = 0;
    }
    this._publish();
  }

  failure(message = 'upstream error') {
    this.lastError = String(message).slice(0, 300);
    if (this.state === 'half-open') {
      this.halfOpenInflight = Math.max(0, this.halfOpenInflight - 1);
      this.state = 'open';
      this.openedAt = Date.now();
      this.totalTripped += 1;
    } else {
      this.failures += 1;
      if (this.failures >= this.threshold) {
        this.state = 'open';
        this.openedAt = Date.now();
        this.totalTripped += 1;
      }
    }
    this._publish();
  }

  snapshot() {
    return {
      name: this.name,
      state: this.state,
      failures: this.failures,
      openedAt: this.openedAt ? new Date(this.openedAt).toISOString() : null,
      totalTripped: this.totalTripped,
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }
}

/** Registry of breakers by name (each service/gateway keeps its own map). */
export class BreakerRegistry {
  constructor({ threshold, openMs } = {}) {
    this.breakers = new Map();
    this.defaults = { threshold, openMs };
  }

  get(name) {
    let breaker = this.breakers.get(name);
    if (!breaker) {
      breaker = new CircuitBreaker({ name, ...this.defaults });
      this.breakers.set(name, breaker);
    }
    return breaker;
  }

  /** Wrap a promise producer with breaker accounting. */
  async exec(name, fn) {
    const breaker = this.get(name);
    breaker.allow();
    try {
      const result = await fn();
      breaker.success();
      return result;
    } catch (err) {
      breaker.failure(err.message);
      throw err;
    }
  }

  snapshot() {
    return Array.from(this.breakers.values()).map((b) => b.snapshot());
  }
}

export default CircuitBreaker;
