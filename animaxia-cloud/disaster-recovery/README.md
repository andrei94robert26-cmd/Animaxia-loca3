# Animaxia Cloud — Disaster Recovery (quickstart)

Operational entry point for backups, restore and failover. The full policy and
runbooks live in **[PLAN.md](PLAN.md)** — this file gets you running in 5 minutes.

| I want to… | Command | Plan section |
|---|---|---|
| Take a backup now | `bash scripts/backup-neon.sh` | [§3.2 nightly dumps](PLAN.md#32-layer-2--nightly-logical-dumps-backup-neonsh-portability-layer) |
| Schedule nightly backups | cron line below | [§3.2](PLAN.md#32-layer-2--nightly-logical-dumps-backup-neonsh-portability-layer) |
| Restore a dump into a NEW database | `bash scripts/restore-neon.sh --latest --into '<NEW-URL>'` | [§8.2](PLAN.md#82-restore-neonsh-usage) |
| Verify a (restored) database | `bash scripts/verify-restore.sh --into '<URL>'` | [§8.3](PLAN.md#83-verify) |
| Switch the cluster to the read replica | `bash scripts/failover-readonly.sh '<REPLICA-URL>'` | [§6.2](PLAN.md#62-db-outage--read-only-degraded-mode) |
| Tier old dumps to cold R2 storage | `bash scripts/cold-archive.sh` | [§7](PLAN.md#7-cold-archive-operations) |
| Read the actual DR plan | open [PLAN.md](PLAN.md) | — |

## 1. Enable backups (one-time + cron)

Prereqs: PostgreSQL client tools (`pg_dump`, `pg_restore`, `psql`) on PATH, a
repo-root `.env` containing `DATABASEURL` (copy `.env.example` → `.env`).

```bash
# 1) verify a clean backup runs (writes disaster-recovery/backups/<stamp>.dump)
bash scripts/backup-neon.sh

# 2) optional: offload every dump to R2 — add to .env (rclone required):
#    R2REMOTE=r2:animaxia-media/backups
#    BACKUPKEEP=14

# 3) install the cron job (ops host, 02:00 nightly — log lives next to the dumps):
crontab -e
# add:
0 2 * * * cd /opt/animaxia-cloud && bash disaster-recovery/scripts/backup-neon.sh >> disaster-recovery/backups/cron.log 2>&1
```

What you get after each run:

- `backups/YYYYMMDD-HHMMSS.dump` — `pg_dump -Fc` (custom format, portable)
- `backups/latest` — pointer to the newest dump (`--latest` restores use this)
- `backups/manifest.log` — one line per dump: UTC time · name · size · sha256 · offsite state

Also enable the layers you can't cron: **Neon PITR window** (7 days, [§3.1](PLAN.md#31-layer-1--neon-automated-backups--pitr-primary-recovery-mechanism)) and a **read replica** ([§4.1](PLAN.md#41-neon-read-replicas)) in the Neon console, plus the weekly schema export ([§3.3](PLAN.md#33-layer-3--weekly-full-schema--data-export)).

## 2. Restore drill walkthrough (~30 min, do this before you need it)

Full checklist + sign-off table: [PLAN.md §9.2](PLAN.md#92-semi-annual-full-restore-test-the-real-thing-against-throwaway-targets).

```bash
# 0) create a THROWAWAY database in the Neon console, e.g. metadata_restore_drill
#    (NEVER restore over the live DATABASEURL — the script refuses it anyway)

# 1) restore the latest local dump into it
bash scripts/restore-neon.sh --latest \
  --into 'postgresql://user:pass@ep-xxx.neon.tech/metadata_restore_drill?sslmode=require'

# 2) run the full read-only verification battery (counts, queue stats, freshness)
bash scripts/verify-restore.sh \
  --into 'postgresql://user:pass@ep-xxx.neon.tech/metadata_restore_drill?sslmode=require'
#    -> expect: SUMMARY: n passed, 0 failed … RESULT : PASS

# 3) rehearse the cutover WITHOUT touching anything:
bash scripts/failover-readonly.sh \
  'postgresql://user:pass@ep-xxx.neon.tech/metadata_restore_drill?sslmode=require' --dry-run

# 4) record timings in the §9.2 sign-off table, then drop the throwaway database
```

If step 2 reports FAIL, the dump is incomplete — check `backups/manifest.log`
for the newest healthy sha256 and restore that file via `--file` instead.

## 3. Real emergency? (60-second orientation)

1. Open [PLAN.md §6 — failover runbook](PLAN.md#6-failover-runbook) and start at the decision tree.
2. DB down, need reads back in <10 min → §6.2: `bash scripts/failover-readonly.sh "$READREPLICAURL"`
3. Everything gone → §6.3 (new cluster) + §8 (restore): `restore-neon.sh` → `verify-restore.sh` → cutover.
4. Declare the incident and fill the [§10 contact table](PLAN.md#10-responsibility-matrix--contacts) — an unnamed on-call is an outage of its own.

## Folder layout

```
disaster-recovery/
├── PLAN.md              # the actual DR plan (read this)
├── README.md            # this quickstart
├── scripts/
│   ├── backup-neon.sh       # nightly pg_dump -Fc → backups/ (+optional R2)
│   ├── restore-neon.sh      # pg_restore into a NEW db (safety-gated)
│   ├── verify-restore.sh    # read-only verification battery
│   ├── failover-readonly.sh # replica URL → k8s secret patch → rollout restart
│   └── cold-archive.sh      # verified tiering of >30d dumps → R2 cold
└── backups/             # dumps, latest, manifest.log, verify logs (gitignored)
```

All scripts are safe to `--help` / read the header before running — the only
destructive one (`restore-neon.sh`) refuses the live database unless you pass
`--force-i-know-what-im-doing`.
