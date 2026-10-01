# Animaxia Cloud — Disaster Recovery Plan

| | |
|---|---|
| **Document** | Disaster Recovery Plan (PLAN.md) |
| **Scope** | All of Animaxia Cloud: gateway + 9 microservices, Neon Postgres, Cloudflare edge, GitHub Actions deploys |
| **Status** | Active — reviewed quarterly (see [§9 DR drills](#9-dr-drills)) |
| **Owner** | Platform on-call lead (see [§10 responsibility matrix](#10-responsibility-matrix--contacts)) |
| **Companion scripts** | [`scripts/`](scripts/) — [`backup-neon.sh`](scripts/backup-neon.sh), [`restore-neon.sh`](scripts/restore-neon.sh), [`failover-readonly.sh`](scripts/failover-readonly.sh), [`cold-archive.sh`](scripts/cold-archive.sh), [`verify-restore.sh`](scripts/verify-restore.sh) |
| **Quickstart** | [`README.md`](README.md) in this folder |

---

## Table of contents

1. [Objectives](#1-objectives)
2. [Architecture assumptions](#2-architecture-assumptions)
3. [Backup strategy](#3-backup-strategy)
4. [Replication & read-only failover](#4-replication--read-only-failover)
5. [Cold storage & retention](#5-cold-storage--retention)
6. [Failover runbook](#6-failover-runbook)
7. [Cold archive operations](#7-cold-archive-operations)
8. [Restore plan](#8-restore-plan)
9. [DR drills](#9-dr-drills)
10. [Responsibility matrix & contacts](#10-responsibility-matrix--contacts)
11. [Failure scenarios](#11-failure-scenarios)
12. [Appendix: script reference & revision history](#12-appendix-script-reference--revision-history)

---

## 1. Objectives

| Objective | Target | How we meet it |
|---|---|---|
| **RPO** (max data loss) | **≤ 15 minutes** | Neon WAL shipping is continuous (RPO ≈ 0 for the primary); the *logical* nightly dumps alone would give a 24 h RPO, so PITR (§3.1) is the primary mechanism and dumps are the portability layer. |
| **RTO — full stack** | **≤ 60 minutes** | Helm chart + pinned GHCR images redeploy the full platform on any new cluster ([§6.3](#63-region--cluster-loss--full-restore)); DB restore into fresh Neon + verify + cutover ([§8](#8-restore-plan)) fits the budget. |
| **RTO — read-only degraded mode** | **≤ 10 minutes** | Neon read replica + [`failover-readonly.sh`](scripts/failover-readonly.sh) (secret patch + rollout restart) — [§6.2](#62-db-outage--read-only-degraded-mode). |

Degraded-mode contract: during read-only mode, **reads keep working** (content browsing, search, analytics dashboards, cached pages) and **writes fail visibly** (logins that need token writes, social posts, premium checkout, queue enqueues). The gateway stays up; users see honest errors, not hangs.

Non-goals: multi-master operation, zero-downtime planned maintenance (handled by rolling deploys), and DR for the third-party provider APIs themselves (TMDB/Jikan/etc. — mitigated by caching + breakers, see [§11](#11-failure-scenarios)).

---

## 2. Architecture assumptions

The plan assumes the deployed architecture of **Animaxia Cloud v3**:

1. **Neon Postgres is the single source of truth.** All services connect through the **pooled** connection string (`DATABASEURL`, `-pooler` host, PgBouncer transaction mode). One logical database holds the platform schema: `content`, `users`, `refreshtokens`, `watchlist`, `watchhistory`, `comments`, `commentvotes`, `contentlikes`, `viewevents`, `subscriptions`, `auditlogs`, `aichats`, `jobs` (Postgres-backed durable queue).
2. **10 microservices, stateless by design** (`gateway-service` :8080, `auth` :4001, `content` :4002, `ai` :4003, `analytics` :4004, `search` :4005, `premium` :4006, `social` :4007, `mobile` :4008, `queue` :4009). Any node-local state is a rebuildable cache. **Exceptions:** `content-service` and `queue-service` mount a small PVC (`animaxia-data`) used only as a *local fallback store + thumbnails* — it is a performance cache, never a source of truth; losing it costs a reseed/rethumbnail, not data.
3. **Cloudflare edge in front** (WAF, rate limiting, cache, Workers/KV, R2 for media/thumbnails). DNS + proxy are Cloudflare-controlled — which enables the *grey-DNS* fallback ([§11](#11-failure-scenarios), row "Cloudflare outage").
4. **GitHub Actions deploys** (`.github/workflows/`): tag `v*` → build → push `ghcr.io/animaxia/<svc>:<version>` → `helm upgrade --install --atomic` → in-cluster smoke → auto-rollback. Kubernetes manifests and the Helm chart live in-repo (`deploy/k8s/`, `deploy/helm/animaxia-cloud/`).
5. **Observability is in-band**: Prometheus/Grafana/Loki/Tempo + OTel collector run alongside the platform (same cluster/compose project). Their loss does not extend an outage; they are rebuilt with the stack.
6. Secrets are injected via the `animaxia-secrets` Kubernetes Secret (raw manifests) / `existingSecret` (Helm). Non-secret config via the `animaxia-config` ConfigMap.

If any assumption changes (e.g. services gain persistent state), this plan must be re-reviewed.

---

## 3. Backup strategy

Five layers, ordered by restore speed. Layers are **complementary** — no single layer is sufficient.

### 3.1 Layer 1 — Neon automated backups + PITR (primary recovery mechanism)

Neon continuously ships WAL and takes storage-level snapshots of the compute's pages. **Point-in-time restore (PITR)** means: create a **new Neon branch** whose data is the parent branch as of a chosen timestamp — giving an RPO of minutes.

**Enabling PITR (once per Neon project):**

1. Neon console → project → **Settings → Backups and restore** (or *Restore* in the sidebar).
2. Confirm the **Point-in-time restore window**. Free/launch plans have a short window (typically 7 days on paid plans — that is what this plan assumes); larger windows cost storage.
   - This plan's working assumption: **PITR window = 7 days**, which comfortably covers our ≤ 15 min RPO for anything newer than a week old.
3. No per-table configuration exists — the window is project-wide. Document the chosen window here and in the runbook.
4. To use it: console → **Branches → Create branch → "Restore to a past point"** → pick timestamp (or use the Neon API/CLI: `neonctl branches create --restore-to "<ISO-timestamp>"`). The new branch gets its own connection string; use it exactly like a restored dump target ([§8](#8-restore-plan)).

**PITR drill note:** a PITR restore produces a *branch*, not a dump — verification ([§8.3](#83-verify)) runs identically against the branch's connection string.

### 3.2 Layer 2 — nightly logical dumps (`backup-neon.sh`, portability layer)

- `pg_dump --format=custom --no-owner --no-privileges` against the pooled `DATABASEURL` (the script strips `channel_binding`-style params that some client builds reject).
- Output: `disaster-recovery/backups/YYYYMMDD-HHMMSS.dump` + `latest` pointer + one `manifest.log` line (UTC timestamp, size, sha256, offsite state).
- Local retention: last `BACKUPKEEP` dumps (default **14**).
- **Optional offsite offload**: set `R2REMOTE=r2:animaxia-media/backups` and the script `rclone copyto`s every dump to the hot R2 tier right after writing it.
- Cron (on the ops/backup host):
  ```
  0 2 * * * cd /opt/animaxia-cloud && bash disaster-recovery/scripts/backup-neon.sh >> disaster-recovery/backups/cron.log 2>&1
  ```
- Why logical dumps when PITR exists: dumps are **portable** (restorable into any Postgres 15+, including other providers and a future migration off Neon), **inspectable** (single file, sha256 in the manifest), and **provider-outage-proof** (they live outside Neon).

### 3.3 Layer 3 — weekly full schema + data export

Weekly (Sunday 03:30, before the 04:00 reindex cron), a plain-SQL export for auditing and long-term portability:

```bash
# schema + data as readable SQL (in addition to the nightly custom-format dumps)
pg_dump --format=plain --no-owner --no-privileges --create "$DATABASEURL" \
  | gzip > disaster-recovery/backups/weekly-$(date +%G-W%V).sql.gz
```

- Kept on the same host/R2 prefix; the weekly export is what gets mirrored to the **1-year monthly retention** tier (§5).
- Review the weekly export once a month: it must contain `CREATE TABLE` statements for **all 13 platform tables** (§2) — an early detector of schema drift breaking dumps.

### 3.4 Layer 4 — configuration backup (private git repo / secret manager)

Everything that is *not* data but is needed to rebuild the world:

| Artifact | Where it lives | Backup method |
|---|---|---|
| `.env` (real values) | ops host only, never committed | mirrored to the secret manager (GitHub Actions secrets + a private `animaxia-ops` repo with encrypted storage, or Vault/1Password) |
| Terraform state (`cdn/cloudflare/terraform/`) | local + Cloudflare remote state | `terraform state pull > terraform-$(date +%F).tfstate` weekly into the private ops repo |
| Helm values incl. `values-production.yaml` | in-repo | git itself is the backup (GitHub); ops repo holds the *rendered* production values with real registry tags |
| Kubernetes Secret material | cluster | re-creatable from `.env` via the `kubectl create secret` commands in `deploy/k8s/README.md` — store the `.env` source of truth, not the cluster objects |
| rclone config (R2 credentials) | ops host | stored in the secret manager; re-creatable via the steps in `cold-archive.sh`'s header |
| Cloudflare config (WAF rules, workers, DNS records) | Cloudflare | Terraform covers the managed parts; quarterly `terraform plan` must show no unmanaged drift in scope |

Rule: **the private ops repo must let a new engineer rebuild the cluster from zero with no access to the old cluster.**

### 3.5 Layer 5 — thumbnails/media in R2 (versioning + lifecycle)

- Thumbnails and media objects live in the `animaxia-media` R2 bucket (`cdn/cloudflare/` documents the layout).
- **Object versioning: ON** — accidental deletes/overwrites are recoverable by restoring a previous object version.
- **Lifecycle rules:** noncurrent versions expire after 90 days; see §5 for the full retention ladder.
- The `thumbnail` column in Postgres references R2 keys — a DB restore + intact R2 bucket = fully working media.

### 3.6 What is *not* backed up (accepted risks)

- Edge caches (Cloudflare cache, gateway edge cache, per-service caches) — rebuildable, cold start is acceptable.
- The `animaxia-data` PVC (content/queue local fallback + thumbnails) — rebuildable cache (reseed + `thumbnails.generate` jobs).
- Prometheus/Grafana/Loki/Tempo data — operational telemetry; a full observability reset is acceptable during DR (alerting history loss is tolerable, data loss is not).
- Queue `jobs` rows newer than the last backup window — bounded by RPO; the platform treats job loss as "retry the ingest", never as source data.

---

## 4. Replication & read-only failover

### 4.1 Neon read replicas

Provision **at least one read replica** of the production branch (Neon console → Branches → Add read replica, or `neonctl branches create --type read-only`). A read replica:

- streams from the primary continuously (replication lag typically < a few seconds),
- has its **own connection string** (distinct host, still pooler-compatible),
- accepts **reads only** — any write fails with `ERROR: cannot execute INSERT in a read-only transaction`.

Store the replica connection string as `READREPLICAURL` in the ops `.env` (never in the public repo).

### 4.2 The DATABASEURL swap procedure (k8s)

`failover-readonly.sh` automates exactly this sequence:

```
1. pre-checks        kubectl present · current-context confirmed by the operator ·
                     secret <ns>/animaxia-secrets exists
2. patch secret      kubectl -n animaxia patch secret animaxia-secrets --type merge \
                       -p '{"stringData":{"DATABASEURL":"<REPLICA-URL>"}}'
3. rolling restart   kubectl -n animaxia rollout restart deployment
4. watch             kubectl -n animaxia rollout status deploy/gateway-service --timeout=180s
5. smoke             kubectl port-forward + curl /api/health, then /api/all?page=1&limit=1
```

Why a **rolling restart** and not just a patch: the pg pool is opened at boot (`initDb`); env changes only reach new processes. The rollout restart is rolling (maxUnavailable default), so the gateway never goes fully dark — this is what keeps the read-only RTO under 10 minutes.

ConfigMap note: `DATABASEURL` lives in the **Secret**, not the ConfigMap (all `deploy/k8s/01-configmap.yaml` values are non-secret). If your deployment stores it elsewhere, adjust the patch target; the script's `SECRETNAME` env covers renames.

### 4.3 Non-k8s (docker compose) procedure

Edit `DATABASEURL` in the repo-root `.env`, then **recreate** (env_file is only read on container creation):

```bash
docker compose -f deploy/docker/docker-compose.yml up -d --force-recreate
curl -fsS http://localhost:8080/api/health
```

Roll back by restoring the original `DATABASEURL` line and recreating again.

---

## 5. Cold storage & retention

Retention ladder (hot → cold → gone):

| Tier | Location | Contents | Transition | Retention |
|---|---|---|---|---|
| Hot | local `disaster-recovery/backups/` | nightly dumps | on write (BACKUPKEEP) | **14 dumps** |
| Warm | `r2:animaxia-media/backups/` (R2 standard) | every nightly dump (offload at backup time) | immediate via `R2REMOTE` | 90 days (R2 lifecycle rule) |
| Cold | `r2:animaxia-media/backups/cold/` | dumps older than 30 days (from the backup host), **plus the monthly weekly export** | `cold-archive.sh` (30 days) / monthly cron copy | **90 days in R2 standard → Glacier-class** via lifecycle |
| Deep | R2 lifecycle Glacier-class | monthly full exports | automatic at 90 days in cold | **1 year** total, then expire |

Concretely:

- **R2 lifecycle rule on `animaxia-media/backups/cold/`**: after **90 days** in the cold prefix, objects transition to **Glacier-class** storage; objects expire after **365 days**.
- **Monthly dumps kept 1 year**: the first weekly export of each month is also copied to `backups/cold/monthly/` and is covered by the same 1-year expiry — this is the "point-in-time audit copy" tier.
- Thumbnails/media bucket versioning (§3.5) is a separate lifecycle: noncurrent versions expire after 90 days.

---

## 6. Failover runbook

Decision tree — start at the top, take the **first branch that matches**:

```
INCIDENT DETECTED (alert, user report, smoke failure)
│
├─ Is the gateway up at all?  ── NO ──> §6.1 (partial outage) — check ingress/edge first (§11 rows 6–7)
│
├─ Can the gateway reach the DATABASE? ── check /api/health "checks.db" ──
│      │
│      ├─ db = false / timeouts / "too many connections" ──> §6.2 (read-only mode), then §8 if the primary won't recover
│      │
│      └─ db = true ──> continue
│
├─ Single service broken (5xx on its prefixes only, breaker open)? ──> §6.1 (service-level rollback)
│
├─ Queue dead letters piling up? ──> §11 row 2 (requeue/replay), not a failover
│
├─ Whole cluster unreachable / region lost? ──> §6.3 (full restore on a new cluster)
│
└─ Unclear ──> declare incident (§10), assign IC, gather facts; default posture is §6.2.
```

### 6.1 Partial outage → service-level k8s rollback

**Symptoms:** one service 5xxing (gateway `animaxia_gateway_upstream_up{service}` = 0, breaker open), or a bad release caught by smoke. Other services healthy.

1. Identify the culprit: `kubectl -n animaxia get pods`, gateway `/api/gateway/stats` (breaker states), Grafana service dashboard.
2. **Roll back the Helm release** (the whole release rolls, but it is the fastest safe path):
   ```bash
   helm history animaxia-cloud -n animaxia --max 10
   helm rollback animaxia-cloud <previous-good-revision> -n animaxia --wait --timeout 10m
   ```
   (Or trigger `.github/workflows/rollback.yml` — manual dispatch, revision `0` = previous.)
3. If only ONE deployment needs a nudge (pod stuck, OOM loop) without a release rollback:
   ```bash
   kubectl -n animaxia rollout undo deploy/<name>-service
   kubectl -n animaxia rollout status deploy/<name>-service
   ```
4. Verify: gateway `/api/health` fan-out green; `curl -fsS http://<gateway>/api/health`.
5. Root-cause before the next deploy; the auto-rollback in `cd-deploy.yml` should have caught release-level breakage already.

### 6.2 DB outage → read-only degraded mode

**Symptoms:** all DB-bound readiness checks red, psql timeouts, Neon status page incident, or primary saturation. Gateway is up but everything DB-touching errors.

1. Confirm it is the DB and not the network: try `psql "$DATABASEURL" -c 'select 1'` from the ops host; check the Neon status page.
2. **Switch to the read replica** (≤ 10 min budget):
   ```bash
   bash disaster-recovery/scripts/failover-readonly.sh "$READREPLICAURL"        # interactive confirm
   # or non-interactive:
   bash disaster-recovery/scripts/failover-readonly.sh "$READREPLICAURL" --yes
   # or preview first:
   bash disaster-recovery/scripts/failover-readonly.sh "$READREPLICAURL" --dry-run
   ```
3. Watch the rollout; smoke via port-forward (the script prints both commands).
4. Announce degraded mode (status page + team channel): reads OK, writes disabled.
5. **While degraded**: writes fail visibly; queue enqueues fail; workers idle. Do NOT run ingest crons against the replica.
6. **Return to primary** (§6.2 exit) once Neon declares the primary healthy:
   ```bash
   # capture any data written to... nothing can be written to a read replica —
   # the replica is read-only, so the primary remains authoritative once it is back.
   bash disaster-recovery/scripts/failover-readonly.sh "$DATABASEURL_PRIMARY" --yes
   ```
   Then re-enable crons and verify `/api/queue/stats` shows workers claiming again.
7. If the primary is **not** coming back (data loss suspected, region gone), escalate to §6.3 + §8.

### 6.3 Region / cluster loss → full restore on a new cluster

**Symptoms:** API 404/timeout at the edge even in grey-DNS mode, cluster API unreachable, provider region incident. Budget: **≤ 60 min**.

1. Declare a major incident; IC assigned (§10). Freeze deploys (GitHub environment protection / cancel running workflows).
2. **Provision the new target** (any Kubernetes 1.28+):
   - new cluster (same or different provider/region), `kubectl` context switched,
   - **new Neon database** (fresh project or branch) — *never* restore over a live DB (§8).
3. **Restore the database** (§8): latest dump (or PITR branch) into the new Neon DB → `verify-restore.sh` → PASS.
4. **Recreate secrets** from the backed-up `.env` (§3.4):
   ```bash
   kubectl -n animaxia create secret generic animaxia-secrets \
     --from-literal=DATABASEURL='<RESTORED-URL>' \
     --from-literal=AUTHSECRET='...' --from-literal=TMDBAPIKEY='...' \
     --from-literal=STRIPESECRETKEY='...' --from-literal=FOOTBALLDATAAPI_KEY='...' \
     --from-literal=ADMINEMAILS='...' --from-literal=OTELSENDPOINT='http://otel-collector:4318/v1/traces'
   ```
5. **Deploy the platform from the Helm chart** (pinned version — never `:latest` in a DR event):
   ```bash
   helm upgrade --install animaxia-cloud deploy/helm/animaxia-cloud \
     -n animaxia --create-namespace \
     -f deploy/helm/animaxia-cloud/values-production.yaml \
     --set image.tag=<last-known-good> --atomic --timeout 10m --wait
   ```
6. **Repoint Cloudflare** (DNS → new ingress IP/hostname, keep proxied). If Cloudflare itself is the casualty, see §11 row 7.
7. Smoke through the edge: `/api/health`, `/api/all?page=1&limit=1`, login flow, `/api/queue/stats`.
8. Post-incident: reconcile queue jobs lost since the last backup (re-run ingests via `providers.refresh`), re-check thumbnails, write the PIR (post-incident report), update this plan with lessons.

---

## 7. Cold archive operations

Operational procedure for the retention ladder in §5 — see [`scripts/cold-archive.sh`](scripts/cold-archive.sh).

- **What it does:** selects local dumps older than `AGEDAYS` (default 30), copies them to `r2:animaxia-media/backups/cold/`, **verifies with `rclone check --size-only`**, and only then deletes the verified local copies. Every action is appended to `backups/manifest.log`.
- **Why verified copy→check→delete instead of a blind `rclone move`:** a move that fails mid-transfer would leave the dump nowhere; the verified pipeline guarantees the remote copy exists and matches before the local one goes away.
- **Scheduling (backup host, weekly):**
  ```
  30 4 * * 0 cd /opt/animaxia-cloud && bash disaster-recovery/scripts/cold-archive.sh >> disaster-recovery/backups/cron.log 2>&1
  ```
- **R2 credentials** are needed once — full `rclone config` walkthrough in the script header.
- **Monthly deep copies** (weekly export → `backups/cold/monthly/`) run on the first Sunday:
  ```
  0 5 1-7 * 0 [ "$(date +\%d)" -le 7 ] && rclone copy disaster-recovery/backups/ r2:animaxia-media/backups/cold/monthly/ --include "weekly-*.sql.gz" --size-only
  ```
- **Restore from cold:** `rclone copy r2:animaxia-media/backups/cold/<dump> .` then follow §8 as usual. Glacier-class objects may take extra time on first read — the monthly tier is a *last resort*, not the primary restore path.

---

## 8. Restore plan

Golden rule, repeated everywhere because it is the one that saves you: **restore into a NEW database first — never over the live one.** Cutover is a separate, explicit, human-approved step.

### 8.1 What to restore from

| Situation | Source | RPO |
|---|---|---|
| DB corrupted, cluster fine, incident < 7 days old | **PITR branch** (§3.1) | minutes |
| Neon entirely unavailable / provider exit | **nightly dump** (local or warm R2) | ≤ 24 h (dumps) — verify the newest in the manifest |
| Audit / legal / "how did data look on date X" | **weekly/monthly export** (§3.3, §5) | by definition |
| Everything local is gone | **cold R2** (§7) | ≤ 30–365 days |

Prefer PITR when the incident is recent and Neon is reachable; dumps are the portable fallback.

### 8.2 `restore-neon.sh` usage

```bash
# latest local dump into a NEW database:
bash disaster-recovery/scripts/restore-neon.sh --latest \
  --into 'postgresql://user:pass@ep-xxx.neon.tech/metadata_restore_drill?sslmode=require'

# a specific dump file:
bash disaster-recovery/scripts/restore-neon.sh \
  --file disaster-recovery/backups/20250101-020000.dump \
  --into 'postgresql://user:pass@ep-xxx.neon.tech/metadata_restore_drill?sslmode=require'
```

Safety rails built into the script:

- **Refuses** to run when `--into` equals the `.env` `DATABASEURL` unless you pass `--force-i-know-what-im-doing` (the flag exists for documented drills only — using it in production requires the IC's explicit approval).
- Runs `pg_restore --clean --if-exists --no-owner --no-privileges` (idempotent on an empty target; drops-if-exists elsewhere).
- Strips `channel_binding`-style params from the target URL (same treatment as backup-neon.sh).
- After restoring, prints quick counts (content/users/jobs) + the cutover runbook.

Requirements: `pg_restore` + `psql` on PATH (install hints in the script), the dump file (`backups/latest` pointer is written by every backup run).

### 8.3 Verify

```bash
bash disaster-recovery/scripts/verify-restore.sh --into '<restored-URL>'
```

Read-only battery (safe on any DB): core table counts (`content`, `users`, `jobs` — FAIL if missing), queue stats by status, newest-content age, secondary tables (comments/viewevents/subscriptions/auditlogs/aichats — WARN if missing). Exits non-zero on any FAIL; writes a stamped log next to the dumps. **Cutover requires: RESULT = PASS.**

For PITR branches, run the same script against the branch URL — no restore step needed.

### 8.4 Cutover (explicit, human-approved)

1. IC announces cutover window (expect ~1–2 min of write unavailability during the roll).
2. Point the cluster at the restored DB — the same mechanism as §4.2:
   ```bash
   bash disaster-recovery/scripts/failover-readonly.sh '<RESTORED-URL>' --yes
   # equivalent manual form:
   # kubectl -n animaxia patch secret animaxia-secrets --type merge \
   #   -p '{"stringData":{"DATABASEURL":"<RESTORED-URL>"}}'
   # kubectl -n animaxia rollout restart deployment
   ```
3. Watch: `kubectl -n animaxia rollout status deploy/gateway-service`.
4. Smoke: `/api/health` → all checks green · `/api/all?page=1&limit=1` → rows · login → works · `/api/queue/stats` → workers claiming.
5. Update the ops `.env` `DATABASEURL` (the source of truth for future secret recreations, §3.4).
6. Reconcile: re-run lost ingest jobs (`providers.refresh`, `maintenance.reindex`), verify thumbnails.
7. Log the event (manifest.log line + PIR link) and schedule the drill report update (§9).

---

## 9. DR drills

Drills are *scheduled rehearsals* — the goal is muscle memory and finding plan bugs while nothing is burning.

### 9.1 Quarterly tabletop (60–90 min, no systems touched)

Agenda: walk through §6 decision tree against a scripted scenario; assign §10 roles; timebox each step; end with plan edits.

| Quarter | Scenario (rotate) |
|---|---|
| Q1 | DB saturation → read-only mode (§6.2) + return-to-primary |
| Q2 | Bad release, single service 5xx (§6.1) |
| Q3 | Neon provider outage → nightly-dump restore + cutover (§8) |
| Q4 | Full region loss, grey-DNS edge case (§6.3 + §11 row 7) |

### 9.2 Semi-annual full restore test (the real thing, against throwaway targets)

Checklist — every step is timed; the total must fit the **60-minute RTO** budget:

| # | Step | Tool | Target time | Done |
|---|---|---|---|---|
| 1 | Create throwaway Neon DB (`metadata_restore_drill`) | Neon console | 3 min | ☐ |
| 2 | Restore latest dump into it | `restore-neon.sh --latest --into …` | 15 min | ☐ |
| 3 | Verify battery passes | `verify-restore.sh --into …` | 5 min | ☐ |
| 4 | Spin up a scratch k8s namespace / compose project pointing at the restored DB | helm/compose | 15 min | ☐ |
| 5 | Smoke: /api/health, /api/all, login, /api/queue/stats | curl | 5 min | ☐ |
| 6 | Simulated read-only failover in the scratch namespace | `failover-readonly.sh --dry-run` + live | 10 min | ☐ |
| 7 | Fetch one dump from the cold tier (Glacier-class) and sha256 it against the manifest | rclone | 7 min | ☐ |
| 8 | Tear down the drill targets; record timings | — | 5 min | ☐ |

**Sign-off table (fill per drill):**

| Field | Value |
|---|---|
| Drill date | ______ |
| Type | tabletop ☐ · full restore ☐ |
| Executed by | ______ |
| Observed by (independent) | ______ |
| Total time (steps 1–5) | ______ min (budget 60) |
| RPO verified (newest dump age) | ______ |
| Verify battery result | PASS ☐ FAIL ☐ |
| Issues found | ______ |
| Plan changes required | ______ |
| Signed off (IC) | ______ |

Drill artifacts (logs, timings, sign-off) are committed to the private ops repo (§3.4), not to this public repo.

---

## 10. Responsibility matrix & contacts

### RACI-style matrix (role → action)

| Action | IC (incident commander) | Ops on-call | Platform lead | Comms |
|---|---|---|---|---|
| Declare incident / severity | **A** | R | C | I |
| Triage via §6 decision tree | A | **R** | C | — |
| Read-only failover (§6.2) | A | **R** | C | I |
| DB restore + verify (§8) | A | **R** | C | — |
| Cutover approval (§8.4) | **A/R** | R | C | I |
| Helm rollback / redeploy (§6.1, §6.3) | A | **R** | C | — |
| Grey-DNS / edge fallback (§11) | A | **R** | C | I |
| Status page + user comms | A | C | I | **R** |
| Post-incident report (48 h) | **R** | R | C | I |
| Plan upkeep + drill scheduling | C | R | **A** | — |

*R = does it, A = accountable/approves, C = consulted, I = informed.*

### Contact placeholders — FILL IN BEFORE THIS PLAN IS "ACTIVE"

| Role | Name | Primary channel | Backup channel | Timezone |
|---|---|---|---|---|
| Incident commander (primary) | `@________` | `#________` | `+________` | ___ |
| Ops on-call (primary) | `@________` | `#________` | `+________` | ___ |
| Platform lead | `@________` | `#________` | `+________` | ___ |
| Comms / status page owner | `@________` | `#________` | `+________` | ___ |
| Neon support | portal | Neon console → Support | support@neon.tech | — |
| Cloudflare support | portal | dashboard → Support | @CloudflareHelp | — |
| GitHub / GHCR status | — | https://www.githubstatus.com | — | — |

Escalation default: if the on-call does not ack within **10 minutes**, page the platform lead; within another **15 minutes**, the IC role is assumed by whoever is available (never let the incident go unowned).

---

## 11. Failure scenarios

Quick triage table — symptom → first response → escalation.

| # | Symptom | First response (do this now) | Escalate when / to |
|---|---|---|---|
| 1 | **Gateway 5xx spike** (all routes) | Check `/api/health` fan-out + `/api/gateway/stats` (breaker states, upstream gauge); if a single upstream is down → §6.1 rollback; if edge → row 7 | Spike > 5 min or all upstreams dark → IC + §6.2/§6.3 |
| 2 | **Queue dead letters piling up** (`/api/queue/stats` `dead` count climbing, `animaxia_queue_depth{status="dead"}`) | Inspect `lasterror` via `GET /api/queue/jobs?status=dead`; fix root cause; `POST /api/queue/jobs/:id/retry` in batches; check worker heartbeats | Dead > 100 or a job type fully stuck > 30 min → platform lead |
| 3 | **DB saturation** (connections exhausted, `too many connections`, p99 up) | `PGPOOLMAX` audit (sum of replicas × pool max vs Neon limit); scale down non-critical replicas; if genuinely overloaded → §6.2 read-only mode to shed writes | Not recovering in 10 min → IC; consider Neon compute scaling |
| 4 | **Provider outages** (TMDB/Jikan/TVMaze/football/F1/RSS failing) | Breakers open automatically; cached content keeps serving (`X-Cache: STALE`); watch `animaxia_circuit_state`; no user action needed | Provider down > 24 h → consider sourcing alternates; note in status page |
| 5 | **Certificate expiry** (browser warnings, edge 526, cert-manager alerts) | Check ingress TLS cert + Cloudflare origin cert; `cert-manager` renewal logs; manual `kubectl describe certificate -n animaxia` | Expired at the edge → Cloudflare dashboard Universal SSL; expired at origin → rotate via helm ingress values; IC if user-facing > 15 min |
| 6 | **K8s cluster degraded** (node loss, evictions) | `kubectl get nodes -o wide`; HPA + PDBs should absorb; PVC (content/queue) is RWO — check rescheduling | Multiple nodes lost or control plane unreachable → §6.3 |
| 7 | **Cloudflare outage** (edge dark, WAF errors) | **Grey-DNS mode:** in the Cloudflare DNS dashboard switch the API record(s) to **DNS only** (grey cloud) so traffic goes direct to the origin ingress — bypasses the edge (WAF/cache lost, origin must hold); announce reduced protection | Cloudflare status page incident; re-enable proxy (orange cloud) once green — IC approves the flip |
| 8 | **Neon outage** (DB unreachable) | §6.2 read-only mode (replica); if the replica is also gone → §6.3 + §8 dump restore | Neon status incident confirmed → status page + comms |
| 9 | **Secrets leak suspected** (token/idle anomalies, auditlog oddities) | Rotate: `AUTHSECRET` (logs everyone out — acceptable), provider keys at their sources, Stripe key in the Stripe dashboard; then `kubectl create secret` replace + rollout restart | Always IC + comms; legal review if user data exposed |
| 10 | **CI/CD compromised or broken** (bad image shipped) | Freeze deploys (GitHub environment protection); `rollback.yml` workflow to last good; verify image digests | Suspected compromise → revoke GITHUB_TOKEN package access + IC |

---

## 12. Appendix: script reference & revision history

| Script | Purpose | Schedule | Dangerous? |
|---|---|---|---|
| [`scripts/backup-neon.sh`](scripts/backup-neon.sh) | nightly logical dump → `backups/` (+ optional R2 offload) | `0 2 * * *` | No (read-only on the DB) |
| [`scripts/restore-neon.sh`](scripts/restore-neon.sh) | dump → NEW database, verified | drills + real DR | **Yes** (drops objects in the target; refuses the live DB without `--force-i-know-what-im-doing`) |
| [`scripts/verify-restore.sh`](scripts/verify-restore.sh) | read-only verification battery | after every restore | No (SELECT-only) |
| [`scripts/failover-readonly.sh`](scripts/failover-readonly.sh) | replica URL → secret patch → rollout restart | real DR / drills | Medium (rolling restart; `--dry-run` available) |
| [`scripts/cold-archive.sh`](scripts/cold-archive.sh) | verified tiering of old local dumps → R2 cold | `30 4 * * 0` | Medium (deletes verified local copies) |

Revision history:

| Date | Author | Change |
|---|---|---|
| 2025-09-15 | agent 2-l (Phase 3) | Initial plan: objectives, 5-layer backup strategy, PITR enabling, replication/failover, decision-tree runbook, retention ladder, restore + cutover, drills with sign-off, RACI + contacts, 10 failure scenarios |
| | | *(next review: first quarterly drill — fill §10 contacts first)* |
