# Animaxia — Neon multi-region (scalarea citirilor) — FAZA 22

Modulul de infrastructură pentru scalarea citirilor pe Neon, construit
**onest**: fără promisiuni de replicare cross-region nativă, cu strategia
reală documentată și provisionată.

## Onestitate: ce oferă Neon REAL și ce NU

### Ce oferă Neon (folosit aici)

- **Branch-uri** — clonare instantanee a bazei (schema + date), inclusiv
  branch-uri read-only copil al branch-ului `main`, în **regiunea
  proiectului**.
- **Endpoint-uri `read_only`** — un al doilea compute care servește
  exclusively SELECT-uri pe un branch, cu enforțare la nivel de endpoint.
- **Logical replication** (outbound) — Neon poate publica schimbările
  (protocol `pgoutput`, nativ Postgres 10+) către instanțe PostgreSQL
  externe — baza strategiei us/asia.

### Ce NU oferă Neon

- **Replicare cross-region nativă.** Nu poți cere Neon „replică această bază
  în us-east și asia-southeast" — nu există asemenea resursă gestionată.
  Orice artefact care ar pretinde asta ar fi minciună; aici nu pretendem.

## Strategia (ce e provisionată + ce e documentată)

| Regiune | Rol | Mecanism | Status |
|---------|-----|----------|--------|
| eu (primară) | write | proiectul Neon existent | există deja (în afara acestui modul) |
| eu | read | branch `read-replica-eu` + endpoint `read_only` | **provisionat** de `terraform/neon-multiregion.tf` / `scripts/neon-multiregion.sh` |
| us | read | PostgreSQL regional separat, alimentat prin **replicare logică** (pgoutput) | documentat (placeholder) — instanța trăiește în alt cloud/cont |
| asia | read | idem us | documentat (placeholder) |

Replicarea logică (one-time, cross-provider):

```sql
-- pe primara Neon:
CREATE PUBLICATION animaxia_read_pub FOR ALL TABLES;

-- pe fiecare țintă regională (us / asia):
CREATE SUBSCRIPTION animaxia_us_sub
  CONNECTION 'host=<neon-primary> dbname=neondb user=… password=… sslmode=require'
  PUBLICATION animaxia_read_pub WITH (copy_data = true, create_slot = true);
```

`wal2json` NU este necesar — `pgoutput` e nativ; `wal2json` doar dacă
preferi evenimente de schimbare în JSON.

## Punctul de integrare — `DATABASE_READ_REPLICA_URLS`

Routerul de citiri (viitor) va citi variabila de mediu
`DATABASE_READ_REPLICA_URLS` (lista de connection string-uri către
replici, în ordinea din `read-router.config.json`). Configurația
completă — primară, replici, `failoverOrder`, `readSplit` (căi de citire
`/api/hub/browse`, `/api/hub/feed`, `/api/search/advanced`,
`/api/search/autocomplete`; căi de scriere `/api/users`, `/api/social`,
`/api/admin`) — stă în [`read-router.config.json`](read-router.config.json).

**IMPORTANT:** `DATABASE_READ_REPLICA_URLS` este doar **documentat** în
FAZA 22 — NU este conectat în backendul protejat. Niciun fișier din
`mini-services/animaxia-backend` nu îl citește.

## Ce rămâne 100% neatins

- schema bazei (migrările FAZA 16/21/TS3),
- motorul FTS (`to_tsvector` + `pg_trgm`, GIN index-uri),
- sharding-ul logic (FAZA 13),
- simularea 30B,
- backendul protejat în întregime.

Acest modul adaugă DOAR: IaC pentru branch-ul read-only + endpoint,
scriptul de provisioning, configurația routerului și documentația.

## Fișiere

| Fișier | Rol |
|--------|-----|
| `terraform/neon-multiregion.tf` | provider `kislerdm/neon`, data source proiect, `neon_branch` + `neon_endpoint` read_only, țintele us/asia comentate onest |
| `terraform/variables.tf` | `neon_api_key` (sensitiv) + `neon_project_id` |
| `scripts/neon-multiregion.sh` | varianta bash: list endpoints + creare branch/endpoint prin `api.neon.tech/v2`; **default `--dry-run`** (doar tipărește comenzile curl, zero rețea, funcționează fără API key), `--apply` explicit |
| `read-router.config.json` | primară + replici + failoverOrder + readSplit + note oneste |

## Utilizare

```bash
# 1. Plan (fără rețea, fără chei):
bash scripts/neon-multiregion.sh --dry-run

# 2. Real (chei obligatorii):
export NEON_API_KEY=<cheie din consola Neon>
export NEON_PROJECT_ID=<id proiect>
bash scripts/neon-multiregion.sh --apply

# sau prin Terraform:
cd terraform
terraform init
terraform plan -var="neon_api_key=…" -var="neon_project_id=…"
terraform apply -var="neon_api_key=…" -var="neon_project_id=…"
```

După apply: endpoint-ul `read_eu` intră în `DATABASE_READ_REPLICA_URLS`
(intrarea eu), iar routerul de citiri îl folosește pentru căile din
`readSplit.readPaths`. Până la router, resursele există fără niciun efect
asupra traficului.
