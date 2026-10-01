# Animaxia Desktop

Electron + React + TypeScript desktop client for the **Animaxia** streaming
platform (anime · movies · sports · news · AI). Windows, macOS and Linux,
Netflix/Crunchyroll-grade UX: hero carousel, multi-source player with
pop-out **mini-player**, AI Hub (Personal AI · Assistant · RAG Lab), social
feed, watchlist, premium plans, offline mode, system tray, desktop
notifications, `animaxia://` deep links and auto-update.

```
┌────────────────────────────────────────────────────────────────────┐
│ Animaxia Desktop (Electron)                                        │
│                                                                    │
│  src/main/            Electron main process (plain CommonJS)       │
│    electron.js          1280×800 window · sandbox · single instance│
│    preload.js           contextBridge → window.animaxia (ONLY IPC) │
│    menu.js              native menu (Navigate ▸ …, Theme cycle)    │
│    updater.js           electron-updater (auto-update)             │
│    ipc/                 settings · deepLink · miniPlayer ·         │
│                         playback · notifications · tray            │
│                                                                    │
│  src/renderer/         React 18 + Vite 5 + TypeScript (bundled)    │
│    app.tsx              HashRouter entry (routes below)            │
│    api/                 gateway client (JWT + refresh + offline)   │
│    auth/                session store + AuthContext                │
│    components/          Shell (sidebar/topbar/toasts) · states ·   │
│                         primitives · content · AIPanel · QuotaMeter│
│    screens/             Home · Content · Player · MiniPlayer ·     │
│                         Feed · AI Hub · Watchlist · Premium ·      │
│                         Profile · Auth                             │
│    player/              VideoPlayer (hls.js) · tracking            │
│    ai/ feed/ profile/ premium/ watchlist/   domain modules         │
│    utils/               theme · format · offlineVideo              │
│                                                                    │
│  dist-renderer/        vite build output (packed into the asar)    │
│  build/                packaging icons · public/ bundled assets    │
└────────────────────────────────────────────────────────────────────┘
                    │ HTTPS (REST/JSON, Bearer JWT)
                    ▼
        Animaxia Cloud gateway :8080
   (auth :4001 · content :4002 · ai :4003 · analytics :4004 ·
    search :4005 · premium :4006 · social :4007 · mobile :4008 ·
    queue :4009 — or the dev monolith on :4000, same routes)
```

## Routes

| Route | Screen | Notes |
|---|---|---|
| `/` | Home | hero carousel + anime/movies/sports rows, new-content detection |
| `/content/:id` | Content | details, watchlist, predicted rating, **AI panel** (Explain / More like this / Ask) |
| `/player/:id` | Player | multi-source (mp4/m3u8/youtube/iframe), resume, tracking, pop-out mini-player |
| `/mini-player` | MiniPlayer | standalone always-on-top window (`#/mini-player`) |
| `/feed` | Feed | Global (social) + Personal (AI-ranked) tabs |
| `/ai` | AI Hub | Personal AI · Assistant chat · RAG Lab |
| `/watchlist` | Watchlist | auth-gated |
| `/premium` | Premium | plans, sandbox/stripe checkout, cancel |
| `/profile` | Profile | avatar, plan, history, preferences, notifications, connection, app info |
| `/auth` | Auth | login · register · forgot password · reset (`?mode=…`) |

Deep links: `animaxia://home`, `animaxia://content/42`, `animaxia://player/42`,
`animaxia://feed`, `animaxia://ai`, `animaxia://watchlist`, `animaxia://premium`,
`animaxia://profile`, `animaxia://auth?mode=reset&email=…&code=…`.

## Requirements

- Node.js ≥ 20 and [Bun](https://bun.sh) ≥ 1.1 (or npm/pnpm — swap `bun run`
  for `npm run`)
- The Animaxia backend reachable: the **gateway** (`animaxia-cloud`, port 8080)
  or the **dev monolith** (`mini-services/animaxia-backend`, port 4000).
  Both expose the identical route surface.

## Development

```bash
cd animaxia-desktop
bun install            # first time (downloads Electron binary ~100 MB)

# start the backend first, then:
bun run dev            # vite dev server (:5173) + electron with HMR
```

Hot reload: renderer changes reload instantly; main-process
(`src/main/**`) changes restart Electron (`concurrently` + file watch).

Type checking and a production renderer build:

```bash
bun run typecheck       # tsc --noEmit (strict)
bun run build:renderer  # vite build → dist-renderer/
```

## Configuration

| What | How |
|---|---|
| API target (build-time) | `.env` → `VITE_API_URL=http://localhost:8080` (gateway) or `http://localhost:4000` (monolith) |
| API target (runtime) | Profile → **Connection** card → custom URL (stored per-install, no rebuild needed) |
| Update feed | `ANIMAXIA_UPDATE_URL` env override, else the `publish` generic URL in `electron-builder.yml` |
| Theme / tray / notifications | persisted by the main process in `<userData>/settings.json` |

## Desktop feature map

- **Window** — 1280×800 (min 1024×640), dark/light/system theme applied
  before first paint (no white flash), close-to-tray on packaged builds.
- **Security** — `sandbox: true`, `contextIsolation: true`,
  `nodeIntegration: false`; the renderer only ever talks to Electron through
  the `window.animaxia` preload bridge with hardcoded channels. External
  http(s) links open in the OS browser, never in-app.
- **Mini-player** — pop out any playback into a frameless always-on-top
  window (progress keeps syncing to the resume store; **Expand** returns to
  the main window at the exact position).
- **Tray** — Show / Mini-player / Check for Updates / Quit.
- **Notifications** — daily picks (09:00), weekly recap (Saturday 18:00),
  new content (detected on Home), premium renewal (3 days before), each
  individually toggleable in Profile → Notifications.
- **Offline mode** — home/content/AI payloads cached in IndexedDB
  (localStorage fallback) with stale-while-error serving; a bundled test
  clip (`public/offline-test.mp4`) always plays; Blender demo streams are
  offered as fallback sources while online.
- **Auto-update** — checks at startup + every 4 h, downloads in the
  background, "Restart to update" toast. Dev builds report a friendly
  no-op.

## Build & package (electron-builder)

The renderer is bundled by Vite (`dist-renderer/`); the main process ships
as-is; `electron-updater` is the only runtime `dependency` — the app stays
small.

```bash
bun install

# 1. Windows — NSIS installer (.exe, x64)
bun run build:win       # → release/Animaxia-Setup-<version>.exe

# 2. macOS — DMG (x64 + arm64)
bun run build:mac       # → release/Animaxia-<version>-<arch>.dmg

# 3. Linux — AppImage (x64)
bun run build:linux     # → release/Animaxia-<version>.AppImage

# All three platforms in one go:
bun run build
```

Notes:

- **Windows** builds work on any OS (NSIS cross-compiles). Code-signing is
  optional — add `certificateFile`/`certificatePassword` under `win:` in
  `electron-builder.yml` when you have a certificate.
- **macOS** DMGs build on macOS. For distribution outside the App Store,
  add `identity: null` (unsigned/ad-hoc) or a Developer ID under `mac:`.
- **Linux** AppImage is fully self-contained — no installation needed.
- Deep-link registration: installers register `animaxia://`
  (`protocols` in `electron-builder.yml`); the app also calls
  `setAsDefaultProtocolClient` at runtime for portable builds.
- Unpacked debug build (no installer): `bun run build:dir`.

### Publishing auto-updates

electron-builder emits `latest.yml` / `latest-mac.yml` / `latest-linux.yml`
next to the artifacts in `release/`. Host the whole `release/` folder at the
generic feed URL (`publish:` in `electron-builder.yml`, e.g.
`https://updates.animaxia.io/desktop`) — `electron-updater` will find the
metadata, download deltas in the background and offer a restart.

## Project scripts

| Script | Purpose |
|---|---|
| `bun run dev` | Vite dev server + Electron (HMR) |
| `bun run dev:renderer` | renderer only (browser preview at :5173 — `window.animaxia` absent, screens degrade gracefully) |
| `bun run typecheck` | strict TypeScript check |
| `bun run lint` | guard lint — no console.log/debugger/TODO/@ts-ignore + Electron security posture (scripts/lint.mjs) |
| `bun run test:smoke` | headless QA suite — 9 suites / 55 checks (scripts/smoke-test.mjs) |
| `bun run build:renderer` | production renderer bundle |
| `bun run build:electron` | electron-builder packaging only (after `build:renderer`) |
| `bun run build[:win\|:mac\|:linux]` | renderer build + electron-builder packaging |

## QA — lint, smoke suite and E2E

**`bun run lint`** (scripts/lint.mjs) scans every source file for
`console.log`/`console.debug`/`debugger`/`TODO`/`@ts-ignore` and asserts the
Electron security flags (`sandbox`, `contextIsolation`, `nodeIntegration: false`,
`webSecurity`) on the main process. 78 files scanned, 0 violations.

**`bun run test:smoke`** (scripts/smoke-test.mjs) is the CI-runnable
replacement for an `electron --inspect` round — no display needed, 9 suites /
55 checks, all green:

| Suite | What it proves |
|---|---|
| 1. main-process syntax | `node --check` on all 10 `src/main/**` files |
| 2. security posture | sandbox/contextIsolation/nodeIntegration/webSecurity flags |
| 3. IPC contract parity | every `ipcRenderer.invoke/send/on` channel in preload has an `ipcMain.handle/on` + `webContents.send` counterpart in main, and every `window.animaxia.*` member is typed in `global.d.ts` (10 invoke + 10 send + 5 event channels, 9 bridge members) |
| 4. deep-link contract | functional `parseLink`/`findLinkArg`/park-replay test with an Electron stub (15 mappings incl. XSS-id encoding + foreign-scheme reject) + router parity against `app.tsx` (scripts/check-deeplink.cjs) |
| 5. refresh single-flight | **10 parallel 401s share ONE `/api/auth/refresh`**; revoked refresh clears the session + emits `logout` once; `/api/auth/*` never retries (scripts/test-single-flight.ts, bun) |
| 6. packaging targets | .exe/.dmg/.AppImage + `animaxia://` protocol + asar + renderer-source exclusion in electron-builder.yml |
| 7. bundled assets | offline test clip (366 KB), icons, renderer entry |
| 8. script matrix | all 11 npm scripts + `main` entry declared |
| 9. strict typecheck | `tsc --noEmit` — 0 errors |

**Renderer E2E** was additionally verified against the live dev monolith
(`VITE_API_URL=http://localhost:4000 bun run dev:renderer`) in a real
Chromium at 1280×800: register → auto-login → Home (live hero + rows) →
Content → watchlist toggle (optimistic, persisted) → **Ask AI** (RAG answer
with sources) → Player (remote-source failure path + Retry, **bundled offline
clip plays**, t≈3 s of an 8 s clip) → AI Hub (Personal: greeting, profile,
quota 3/10 free, 6 vector-ranked daily picks, weekly recap; Assistant: reply
with 3 `SEARCHCONTENT` tool traces) → Feed (Global + Personal) → Premium →
Profile → Watchlist → theme dark↔light (`html.light`, white bg) → every hash
route (= the deep-link target set). Fresh load: 0 console errors, 0 page
errors. Electron-only surfaces (tray, frameless mini-player window, native
notifications, auto-update) are covered by suites 1–6 + the structural checks.

## CI — GitHub Actions

Two additive workflows build and publish the desktop app:

- **`animaxia-cloud/.github/workflows/desktop-build.yml`** — active in the
  cloud monorepo. On pushes touching `animaxia-desktop/**`: `verify` job
  (bun install without the Electron binary → lint → smoke → typecheck →
  renderer bundle) then a 3-OS `build` matrix (ubuntu AppImage · windows NSIS
  .exe · macos DMG) uploading installers as artifacts; on `v*` tags a
  `release` job attaches all installers to a GitHub Release.
- **`animaxia-desktop/.github/workflows/desktop-ci.yml`** — the same pipeline
  for when the folder is pushed as its own repository.

```yaml
# quick local preview of what CI runs:
bun install            # ELECTRON_SKIP_BINARY_DOWNLOAD=1 is enough for verify
bun run lint && bun run test:smoke && bun run typecheck && bun run build:renderer
```

## Verification status

- `bun run lint`: **clean** — 78 source files, 0 violations.
- `bun run test:smoke`: **55/55 checks green** across 9 suites (see QA above).
- `tsc --noEmit` (strict): **0 errors** across the renderer.
- `node --check`: all 10 main-process files parse clean.
- `vite build`: production bundle builds clean (311 KB app + 593 KB hls.js
  lazy chunk + 47 KB CSS, 1.3 MB total with assets).
- Renderer E2E vs the live monolith: login → browse → Ask AI → play →
  offline fallback → theme — all green (see QA above).
- Runtime end-to-end of Electron-only surfaces (window, tray, mini-player,
  notifications, updater) requires a display — verified structurally (smoke
  suites 1–6) + via the preload↔main contract parity; run `bun run dev`
  against a live gateway for the full flow.
