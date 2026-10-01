# COMENZI COMPLETE TERMUX — ANIMAXIA REAL 10M (AR10M)

Ghid pentru tableta Android (Termux). Toate comenzile rulează în Termux pe tabletă.

## 0. Setup inițial Termux
```bash
# actualizare pachete
pkg update -y && pkg upgrade -y
# unelte de bază
pkg install -y git curl wget openssh nano jq cronie termux-api
# Node/Bun pentru rularea scripturilor platformei
pkg install -y nodejs-lts      # sau: curl -fsSL https://bun.sh/install | bash
# ffmpeg — OBLIGATORIU pentru pipeline-ul de thumbnails (extragere cadru → WebP)
pkg install -y ffmpeg
# verificare
ffmpeg -version | head -1
```

## 1. Directorul de lucru + thumbnails (AR10M §7)
```bash
mkdir -p ~/animaxia/thumbnails
# structura pe hash: ~/animaxia/thumbnails/ab/cd/<content-id>.webp
# (thumbnail-urile NU se stochează în Neon — doar pe tabletă)
```

## 2. Variabile de mediu (FĂRĂ secrete în repo)
```bash
mkdir -p ~/animaxia
cat > ~/animaxia/.env <<'EOF'
# completează cu valorile reale (NU commite acest fișier)
DATABASEURL=postgresql://UTILIZATOR:PAROLA@ep-xxxx-pooler.regiune.aws.neon.tech/neondb?sslmode=require
AR10M_ADMIN_TOKEN=<generează: openssl rand -hex 32>
AR10M_SHARD_COUNT=15
THUMB_DIR=/data/data/com.termux/files/home/animaxia/thumbnails
THUMB_WIDTH=320
THUMB_HEIGHT=180
THUMB_QUALITY=75
EOF
chmod 600 ~/animaxia/.env
```

## 3. Pipeline-ul de thumbnail la importarea unui URL (AR10M §7 — ordinea exactă)
```bash
# Pasul 1: validează sursa (allowlist — youtube/rumble/direct/hls permise)
# Pasul 2-6: rulează importul prin backend (endpoint face tot: thumbnail oficial
#            sau cadru extra din video → WebP 320x180 → salvare atomică → id):
source ~/animaxia/.env
curl -s -X POST http://BACKEND:4000/api/ar10m/thumb/import \
  -H 'content-type: application/json' \
  -d '{"url":"https://www.youtube.com/watch?v=XXXXXXXXXXX","contentId":12345}'
# răspuns onest: {"ok":true,"thumbnailId":12345} sau
#               {"ok":false,"reason":"ffmpeg-indisponibil","thumbnailId":null}

# Servirea thumbnail-ului (ETag + Cache-Control + placeholder):
curl -s -o /dev/null -w "%{http_code} %{content_type}\n" http://BACKEND:4000/thumb/12345
```

## 4. Generare manuală thumbnail pe tabletă (fără backend)
```bash
ID=12345; URL="https://commondatastorage.googleapis.com/.../video.mp4"
HASH=$(echo -n "$ID" | sha256sum | cut -c1-4)   # ab/cd din hash
mkdir -p ~/animaxia/thumbnails/${HASH:0:2}/${HASH:2:2}
# extrage cadru la 3s → WebP 320x180, calitate 75 (atomic: .tmp apoi rename)
ffmpeg -ss 3 -i "$URL" -frames:v 1 \
  -vf "scale=320:180:force_original_aspect_ratio=decrease,pad=320:180:(ow-iw)/2:(oh-ih)/2" \
  -c:v libwebp -quality 75 \
  ~/animaxia/thumbnails/${HASH:0:2}/${HASH:2:2}/$ID.webp.tmp.webp \
  && mv ~/animaxia/thumbnails/${HASH:0:2}/${HASH:2:2}/$ID.webp.tmp.webp \
        ~/animaxia/thumbnails/${HASH:0:2}/${HASH:2:2}/$ID.webp
```

## 5. Servicii platformă (pe serverul/tableta unde rulează)
```bash
cd ~/animaxia/mini-services/animaxia-backend
bun install                    # prima dată
(nohup bun --watch server.js > backend.log 2>&1 &)   # backend :4000
curl -s localhost:4000/api/health | jq '.status'      # verificare
```

## 6. Operații admin (MANUAL — zero cron)
```bash
source ~/animaxia/.env
# deep-probe DB (max 2s, manual):
curl -s -H "X-Admin-Token: $AR10M_ADMIN_TOKEN" localhost:4000/api/health/db | jq
# reîmprospătează metricile shard-urilor (rânduri + spațiu real per shard):
curl -s -X POST -H "X-Admin-Token: $AR10M_ADMIN_TOKEN" localhost:4000/api/ar10m/admin/refresh-metrics | jq
# status shards (registru real, 15 sloturi):
curl -s localhost:4000/api/ar10m/shards | jq '.shards[] | {slot,name,mode,state,lastRowCount}'
# mod economic (la 85% buget — sau automat):
curl -s -X POST -H "X-Admin-Token: $AR10M_ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"on":true}' localhost:4000/api/ar10m/admin/economic | jq
```

## 7. Benchmark progresiv (date sintetice marcate — NICIUN rând în catalogul public)
```bash
cd ~/animaxia/mini-services/animaxia-backend
bun tests/bench-ar10m.mjs --rows 10000      # pasul 1: 10K
bun tests/bench-ar10m.mjs --rows 100000     # pasul 2: 100K (doar după 10K stabil)
bun tests/bench-ar10m.mjs --rows 1000000    # pasul 3: 1M (doar după 100K stabil)
# NU importa 10M până când 1M nu e stabil (regula AR10M §9)
bun tests/bench-ar10m.mjs --resume          # continuă de la checkpoint
bun tests/bench-ar10m.mjs --cleanup         # curăță rândurile sintetice
cat data/ar10m-bench-state.json | jq        # stare + rezultate
```

## 8. Rebalansare shard-uri (după ce adaugi ANIMAXIA_DB_02..15 în .env)
```bash
bun scripts/ar10m-rebalance.mjs --status    # ce s-ar muta
bun scripts/ar10m-rebalance.mjs             # mută rândurile shard-elor cu DB dedicat (batchuri + checkpoint)
```

## 9. Seed/aplicare schemă (idempotent — sigur de re-rulat)
```bash
bun scripts/ar10m-setup.mjs    # schemă ar10m + backfill normalized_title legacy + seed itemi reali
```

## 10. Reguli de aur (AR10M)
1. ZERO cron permanent — totul on-demand (butoane admin, endpoint-uri manuale).
2. ZERO secrete în repo/loguri/răspunsuri API — doar variabile de mediu.
3. ZERO date demo în producție — bench doar în `ar10m.bench_catalog` (synthetic=true).
4. NU pretinde capacitate nemăsurată — contoarele afișează EXCLUSIV valori reale din DB.
5. Neon trebuie să poată intra în scale-to-zero după 5 min fără trafic real.
