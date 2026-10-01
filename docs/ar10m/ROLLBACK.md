# PROCEDURĂ DE ROLLBACK — ANIMAXIA REAL 10M (AR10M)

## Principiu
Transformarea AR10M a fost proiectată **aditiv + reversibil**:
- Datele legacy NU au fost șterse (regula: „nu șterge date reale").
- Backup cod complet există înainte de modificări.
- Schema `ar10m` este aditivă; tabelele `public.*` sunt intacte.

## 0. Backup-uri disponibile (create 2026-09-27, înainte de modificări)
- **Cod**: `backups/ar10m-pre-backup-20260927-135627.tar.gz`
  (src/ frontend + mini-services backend/watchdog/observability/stability/edge-live + Caddyfile + .env)
- **DB**: tabelele legacy `public.content` (29.192 rânduri), `public.searchdocs`, `public.users` etc. — NICIODATĂ modificate de AR10M (doar coloana aditivă `normalized_title` + 2 indexuri).

```bash
# verifică backup-ul codului:
tar -tzf backups/ar10m-pre-backup-20260927-135627.tar.gz | head
```

## 1. Rollback COD (frontend + backend)
```bash
cd /home/z/my-project
# oprește backend-ul
pkill -f "bun --watch server.js" || true
# restaurare selectivă din backup:
mkdir -p /tmp/ar10m-restore && tar -xzf backups/ar10m-pre-backup-*.tar.gz -C /tmp/ar10m-restore
cp -r /tmp/ar10m-restore/src/* src/                      # frontend (înainte de eliminarea 30B)
cp -r /tmp/ar10m-restore/mini-services/animaxia-backend/* mini-services/animaxia-backend/
# repornește backend-ul:
cd mini-services/animaxia-backend && (nohup bun --watch server.js > backend.log 2>&1 &)
```

## 2. Rollback SCHEMA ar10m (dacă vrei să elimini complet schema reală)
```bash
cd /home/z/my-project/mini-services/animaxia-backend
# ATENȚIE: șterge DOAR schema ar10m (catalogul real + bench sintetic).
# NU atinge public.* (legacy — 29.192 itemi TMDB + utilizatori + social).
psql "$DATABASEURL" -c 'DROP SCHEMA IF EXISTS ar10m CASCADE;'
# rollback coloana aditivă legacy (opțional — coloana e inofensivă dacă rămâne):
psql "$DATABASEURL" -c 'ALTER TABLE public.content DROP COLUMN IF EXISTS normalized_title;'
```

## 3. Rollback DOAR datele bench sintetice (păstrând arhitectura)
```bash
cd /home/z/my-project/mini-services/animaxia-backend
bun tests/bench-ar10m.mjs --cleanup   # șterge exclusiv rândurile batch_id LIKE 'synthetic-%'
```

## 4. Rollback granular pe componente
| Componentă | Rollback |
|---|---|
| `/api/health` zero-DB | restaurează `server.js` din backup (piggyback la 60 min, dar cu ?refresh=1) |
| db.js lazy reconnect | restaurează `db.js` din backup (probe 60s doar în starea de eroare) |
| edge-live on-demand | restaurează `edge-live/upstreams.ts` + `index.ts` din backup (probe 60s) |
| SHARDCOUNT 15 | `SHARDCOUNT=30` în `.env` (vechea topologie logică 30×1B) |
| view-ul „Arhitectura Reală" | restaurează `src/components/animaxia/views/scale-report-view.tsx` + `menu.ts` din backup |
| rutele AR10M | comentează în `server.js`: `app.use('/api/ar10m', ar10mRouter)` + `registerThumbRoute(app)` |

## 5. Verificare post-rollback
```bash
curl -s localhost:4000/api/health | head -c 100          # backend viu
curl -s localhost:4000/api/all?limit=1 | head -c 100     # catalog legacy intact
bun run lint && bunx tsc --noEmit                        # frontend sănătos
```

## 6. Ce NU se poate da rollback (onest)
- Rândurile din `ar10m.content`/`ar10m.content_sources` create prin importuri reale NOI (după AR10M) — exportă-le înainte:
  ```bash
  psql "$DATABASEURL" -c "COPY (SELECT * FROM ar10m.content) TO STDOUT WITH CSV HEADER" > ar10m-content-backup.csv
  psql "$DATABASEURL" -c "COPY (SELECT * FROM ar10m.content_sources) TO STDOUT WITH CSV HEADER" > ar10m-sources-backup.csv
  ```
- Consumul de cotă Neon produs între timp (CU-hours) — ireversibil.
