# Animaxia — origin de producție (Caddy) — FAZA 22

Acest document explică `Caddyfile.production`: proxy-ul invers de origine pentru
deployment-ul real al platformei Animaxia (frontend Next.js + backend API),
în spatele Cloudflare sau standalone.

## Ce face acest fișier

| Bloc | Rol |
|------|-----|
| Global (`{ … }`) | e-mail ACME (`admin@animaxia.com` — **de înlocuit** cu adresa reală de ops), protocoale `h1 h2 h3` |
| `http://animaxia.com` | redirect **permanent** (301) către `https://` — portul 80 rămâne deschis pentru provocările ACME HTTP-01 |
| `animaxia.com` + `www` | TLS automat (ACME), HSTS strict global, headere de securitate, `encode zstd gzip`, `reverse_proxy 127.0.0.1:3000` (Next.js) |
| `api.animaxia.com` | aceleași TLS+headere, `reverse_proxy 127.0.0.1:4000` (backend) pe `/api/*`; varianta comentată `127.0.0.1:4040` pentru global-gateway |

Headerele aplicate pe **fiecare** răspuns:

- `Strict-Transport-Security: max-age=31536000; includeSubDomains; preload`
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy: camera=(), microphone=(), geolocation=()`
- `X-Served-By: animaxia-origin`

## Relația cu Cloudflare (Full strict)

Zona Cloudflare este provisionată cu `ssl = "strict"` (vede
`cdn/cloudflare/terraform/main.tf`) — adică **Full (strict)**: Cloudflare
refuză conexiuni către o origine fără certificat valid.

Caddy rezolvă asta nativ, fără certificat Origin CA:

1. Caddy obține automat certificate Let's Encrypt prin ACME (HTTP-01 pe port
   80 sau TLS-ALPN pe 443) pentru `animaxia.com`, `www.animaxia.com` și
   `api.animaxia.com`.
2. Cloudflare se conectează la origine pe 443 cu SNI și validează lanțul
   ACME — cerința Full (strict) este îndeplinită.
3. Renewal-ul e automat (Caddy reîncarcă certificatele la ~2/3 din
   valabilitate); nu trebuie făcut nimic manual.

Atenție: DNS-ul pentru cele 3 hostname-uri trebuie să puncteze către IP-ul
originiilor și să fie **proxied** (norul portocaliu) în Cloudflare — asta
provisionează și `cdn/cloudflare/terraform/main.tf` (înregistrările `api`,
`www`, `root`).

Modul standalone (fără Cloudflare) funcționează identic: Caddy servește
direct h1/h2/h3 cu certificate ACME proprii.

## Cum se activează

Pe hostul de origine (Ubuntu/Debian exemplu):

```bash
# 1. Instalează Caddy (https://caddyserver.com/docs/install) — ex. Debian:
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install caddy

# 2. Instalează configurația (adjustează căile la locația ta):
sudo cp Caddyfile.production /etc/caddy/Caddyfile
sudo chown caddy:caddy /etc/caddy/Caddyfile

# 3. Verifică sintaxa:
caddy validate --config /etc/caddy/Caddyfile

# 4. Pornește / reîncarcă:
sudo systemctl enable --now caddy    # pornire + boot persist
sudo systemctl reload caddy          # după orice modificare

# 5. Verifică:
curl -sI https://animaxia.com        | grep -iE 'strict-transport|x-served-by'
curl -sI https://api.animaxia.com/api/health | grep -iE 'strict-transport|x-served-by'
```

Porturi obligatorii deschise în firewall: **80/tcp** (redirect + ACME HTTP-01)
și **443/tcp + 443/udp** (443/udp pentru HTTP/3 — QUIC).

## DNS (rezumat)

| Hostname | Tip | Destinație | Proxy |
|----------|-----|------------|-------|
| `animaxia.com` | CNAME (flattened) | `www.animaxia.com` | da |
| `www.animaxia.com` | CNAME | `animaxia.com` (sau hostul frontend) | da |
| `api.animaxia.com` | A | IP-ul originii (ex. LB/ingress) | da |

Toate trei sunt gestionate de Terraform (`cdn/cloudflare/terraform/main.tf`);
înlocuiește `var.origin_ip` cu IP-ul real al serverului cu Caddy.

## Upstream-uri

| Upstream | Serviciu | Note |
|----------|----------|------|
| `127.0.0.1:3000` | Next.js frontend | doar SSR — staticul e servit de CDN/edge anycast |
| `127.0.0.1:4000` | animaxia-backend | API monolit (montează rutele la `/api/*`) |
| `127.0.0.1:4040` | global-gateway | variantă comentată — perimetru distribuit (rate-limit, cooldown, anti-spam, cache) pentru origins multi-region |

Pentru origins multi-region: decomentează blocul `global-gateway` din
`api.animaxia.com` (sau duplică site-ul Caddy per regiune cu upstream-ul
regional) — cererile `/api/*` vor trece prin perimetrul global înainte de
backend.

## Ce NU face acest fișier

- Nu modică codul backendului sau al frontendului — este strict infrastructură
  de origine.
- Nu termină WebSocket-uri speciale — dacă backendul expune `/ws/*`, adaugă un
  bloc `handle /ws/*` cu `reverse_proxy` (Caddy le proxy-ează nativ).
- Nu înlocuiește edge-ul Cloudflare (WAF, rate limiting, cache) — doar îl
  completează ca origine hardenată.
