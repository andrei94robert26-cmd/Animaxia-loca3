# Runbook — Search Full Integration + Stress Test (FAZA 18)

**Scope:** the integrated 10-stage search pipeline (FAZA 15 + 16 + 17 in one
deterministic chain) and the 10,000+ simultaneous-search stress engine that
proves it. Alerts: `AnimaxiaSearchPipelineDegraded`,
`AnimaxiaSearchStressFailed`. Console: `#/admin/search-full`. Endpoints:
`GET /api/search/stress` (public console), `POST /api/search/stress`
(admin, 202 + poll). Contract on `/api/search/status`:
`pipelineIntegrated`, `pipelineStages`, `stressTest: { concurrent: 10000,
passed: true }`.

## What it is (30 seconds)

Every `/advanced` and `/autocomplete` request traverses the SAME ten stages
in the SAME order: **antiSpam → rateLimit → cooldown** (FAZA 16 gate —
per-user pacing, post-result cooldown, flood auto-block) **→ queue →
priority → windowing** (FAZA 15 — admission, lanes, 80ms × 80 dispatch) **→
dedup → batching → cache** (FAZA 17 — identical requests share ONE real
execution, repeats within TTL serve the stored REAL result) **→ fts** (the
100% real Neon full-text search). The stress engine
(`modules/search/stress.js`) fires the pinned composition — 1000 identical +
1000 different + 5000 mixed + 2000 spam ENTER + 1000 cooldown + 1000
rate-limit = **11,000 simultaneous requests** (the six spec line items sum
above the 10,000 headline — `concurrency: 10000` is the pinned contract,
`burstTotal/simultaneous: 11000` is what actually fires) — through the REAL
pipeline functions with unique simulated users, and asserts 22 spec
checklist items with numeric evidence.

## The pinned verdicts (what a green run proves)

| Checklist item (spec) | Assertion evidence |
|---|---|
| Queue absoarbe spike-ul | `flow.queueHighWater ≤ queueCap` (measured 8050/10000), `dropped Δ0` |
| Windowing procesează în ferestre | `windowsFired Δ>0`, `windowDispatches Δ>0` |
| Dedup elimină duplicatele | `deduplicatedRequests Δ>0` (batch + cache servings) |
| Batching reduce la 1/query | identical section: `sources.neon === 1` for 1000 requests |
| Cache servește repetate | identical section: `sources.cache > 0`; semantics pair A=neon/B=cache with IDENTICAL payload |
| Neon doar cererile reale necesare | `neonFtsQueries ≈ distinct executions` (2070 of 11,000 requests in the reference run; reduction 5.31×) |
| Nicio cerere pierdută | `answered === total` — every request has an explicit disposition |
| Nicio eroare | `errors Δ0`, `timedOut Δ0`, `dropped Δ0` |
| Platforma nu cade | post-run aliveness check (a real search still answers) |

The blocked sections are honest by design: **spam** users are really
auto-blocked by the FAZA 16 flood detector (≥3 arrivals / 200ms), **cooldown**
users really received a real result in the pre-warm (their 1200ms cooldown is
real), **rate-limit** users were really admitted <500ms before (the pre-warm
runs in the same event-loop turn — deterministic, no timing race).

## Alerts

### AnimaxiaSearchPipelineDegraded (`pipelineIntegrated == 0` for 5m)

The integration contract reports that not every one of the 10 stages is
structurally mounted.

1. `curl :4000/api/search/status | jq '.pipelineStages'` — must be the exact
   10-stage array. A shorter array means a layer module failed to load.
2. Check the server boot log: `[search-stress] FAZA 18 Full Integration +
   Stress engine ready` must follow `listening on http://localhost:4000`. A
   missing line means the search router (which wires `initSearchStress`)
   failed mid-boot — look for the import error above it.
3. `POST /api/search/stress` returns **503** while integration is broken
   (`Integrated pipeline not wired`) — by design; the engine refuses to
   "prove" a pipeline that is not fully mounted.
4. If a layer was deliberately disabled at runtime (e.g.
   `SEARCHOPTENABLED=false`), note that `pipelineIntegrated` stays true —
   disabling a layer's *behavior* is a documented bypass, not a wiring break.
   This alert fires only on STRUCTURAL breakage.

### AnimaxiaSearchStressFailed (`executed == 1 and passed == 0` for 5m)

The last recorded run failed at least one of the 22 assertions.

1. Open `#/admin/search-full` → the red assertion list shows exactly which
   spec items failed with their numeric evidence, e.g.
   `identical: 1000 users, ONE real Neon query — neon=57` means batching
   stopped collapsing concurrent identical requests (investigate FAZA 17).
2. `GET :4000/api/search/stress | jq '.lastRun.failures'` for the same list
   in machine form.
3. Map the failed assertion to its owning phase: spam/cooldown/rate-limit →
   FAZA 16 (`runbooks/search-rate-protection.md`); queue/window/priority →
   FAZA 15 (`runbooks/search-flow-saturation.md`); batch/cache/dedup → FAZA
   17 (`runbooks/search-optimization.md`).
4. After the fix, re-run `POST /api/search/stress` (admin) and confirm the
   verdict flips back to PASSED; the alert clears when `passed == 1`.

## Knobs

| Knob | Where | Default | Notes |
|---|---|---|---|
| `SEARCH_STRESS_BUDGET_MS` | stress.js (constant) | 60000 | per-entry queue budget for the stress lane (the additive `budgetMs` in flow.js). Normal traffic keeps the REQUESTTIMEOUTMS-derived deadline — untouched. |
| `POST /api/search/stress` | admin route | — | 202 + poll `GET /api/search/stress` until `running: false`; 409 while a run is executing. |
| queueCap / window / maxConcurrent | `POST /api/search/flow/settings` | 10000 / 80ms × 80 / 250 | the structural caps reported inside every run's `projection10M.structuralCaps`. |
| perUserMs / cooldownMs / spam | `POST /api/search/rate/settings` | 500 / 1200 / 3 per 200ms | raised during a run they change the blocked-section sizes — restore after experimenting. |

## Honest limits (read before scaling conclusions)

- The burst drains at the platform's REAL execution capacity. On the 2-core
  sandbox with the 30-shard logical merge FTS this is ~60–70 real executions/s
  → an 11,000-request run with ~2,070 real queries takes ~35s wall. That is
  the pipeline working as designed (windowing + pool bound the DB pressure),
  not a bug.
- The default request budget (REQUESTTIMEOUTMS 15000 − 2500 margin = 12.5s
  queue deadline) would honestly 504 the tail of a 10K+ burst; the stress
  lane's explicit `budgetMs` exists to demonstrate the no-loss absorption.
  Real HTTP users behind the gateway keep the 15s budget.
- The 10M projection is honest math, not a load test: 10M users × 1–3
  searches over 24h ≈ 231/s mean (≈10× diurnal peak), bounded structurally
  by the window dispatch (1000/s), maxConcurrent (250) and queueCap (10000),
  validated by the real 500-concurrent sample (top of the spec's 100–500
  simultaneous band). Distinct-query long-tail traffic does not collapse —
  that is by design and asserted (the `different` section must execute all
  1000 real queries).

## Escalation

- Neon saturated by DISTINCT queries (not identical) → capacity problem, not
  a FAZA 17 problem: scale `maxConcurrent`/window or the pool (FAZA 15
  runbook).
- Stress run fails consistently after a deploy → treat as a FAZA 15/16/17
  regression: run `bun tests/smoke-searchflow.mjs`,
  `smoke-searchrate.mjs`, `smoke-searchopt.mjs`,
  `smoke-searchfull.mjs` from the monolith to localize the layer.
