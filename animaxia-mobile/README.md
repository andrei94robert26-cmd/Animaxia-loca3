# Animaxia Mobile 📱

Android + iOS client for **Animaxia Cloud** — built with React Native (Expo SDK 52, **React Navigation**, TypeScript strict). One app for the whole platform: browsing, native playback with analytics tracking, social feed, watchlist, premium plans and the full **Animaxia AI Cloud** (personal recommendations, predicted rating, RAG Lab, explain / more-like-this / chat-with-content and the tool-calling animaxiaAssistant) — plus **push notifications** and an **offline mode** with a bundled test clip.

```
  Animaxia Mobile ──► Animaxia Cloud gateway :8080
                        ├─ /api/auth      → auth-service      :4001   (JWT 15 min + rotating refresh 30d + password reset)
                        ├─ /api/content   → content-service   :4002
                        ├─ /api/ai        → ai-service        :4003   (AI Cloud: RAG · assistant · personal)
                        ├─ /api/analytics → analytics-service :4004
                        ├─ /api/search    → search-service    :4005
                        ├─ /api/premium   → premium-service   :4006
                        ├─ /api/social    → social-service    :4007
                        ├─ /api/mobile    → mobile-service    :4008   (BFF: compact payloads)
                        └─ /api/queue     → queue-service     :4009
```

The dev **monolith** (`mini-services/animaxia-backend`, port **4000**) serves the identical surface on one process — point the app at either.

---

## Architecture (Phase 6)

```
animaxia-mobile/
├── index.ts                entry — registerRootComponent (no expo-router)
├── App.tsx                 AuthProvider + RootNavigator + notification wiring
├── app/
│   ├── navigation/         React Navigation root
│   │   ├── index.tsx         Stack (MainTabs · Login modal · Premium · Content ·
│   │   │                     Player full-screen modal) + animaxia:// deep links
│   │   ├── helpers.ts        navigationRef · navigateTo · goBackOrHome
│   │   └── types.ts          RootStackParamList · MainTabParamList
│   ├── screens/            the 9 screens
│   │   ├── HomeScreen.tsx        hero carousel + rows + version gate +
│   │   │                          new-content notification detection
│   │   ├── LoginScreen.tsx       login · register · forgot-password (2-step,
│   │   │                          sandbox auto-code) as modal views
│   │   ├── ContentScreen.tsx     details + episodes/sources + AI panel +
│   │   │                          predicted-rating chip (★ AI predicts 8.7)
│   │   ├── PlayerScreen.tsx      video + multiple sources + resume + tracking +
│   │   │                          OFFLINE fallback (bundled test clip + demo streams)
│   │   ├── FeedScreen.tsx        Global | Personal | For-you·AI feeds
│   │   ├── AIHubScreen.tsx       Personal | Assistant | RAG Lab
│   │   ├── WatchlistScreen.tsx   saved titles (optimistic toggle)
│   │   ├── ProfileScreen.tsx     avatar · plan · stats · history · preferences ·
│   │   │                          NOTIFICATION SETTINGS
│   │   └── PremiumScreen.tsx     plans + upgrade (sandbox & Stripe checkout)
│   ├── components/         Screen · BottomNav (custom tab bar) · Segmented ·
│   │                       content cards · hero · AIPanel · QuotaMeter ·
│   │                       states (skeleton/error/empty/sign-in/upgrade/offline)
│   ├── hooks/              useApi (stale-while-error) · useAuth
│   ├── context/            AuthContext (boot-restore → background /me validation)
│   ├── api/                HTTP layer
│   │   ├── config.ts         base-URL resolution (EXPO_PUBLIC_API_URL → emulator default)
│   │   ├── client.ts         fetch core: Bearer inject, single-flight 401 refresh + retry,
│   │   │                     15s AbortController timeout, typed ApiError {code, upgrade}
│   │   ├── cache.ts          AsyncStorage offline cache (stale-while-error + TTL cache-first)
│   │   ├── auth.ts           /api/auth/*  login · register · logout · me ·
│   │   │                     forgot-password · reset-password
│   │   ├── mobile.ts         /api/mobile/*  home · player/:id · profile · config
│   │   ├── ai.ts             /api/ai/*  personal.* · assistant · rag.* · cloud/status
│   │   ├── users.ts          /api/users/me/*  watchlist · history · preferences · avatar
│   │   ├── social.ts         /api/social/*  feeds (cursor) · comments · likes
│   │   ├── premium.ts        /api/premium/*  plans · me · checkout · confirm · cancel
│   │   └── analytics.ts      /api/analytics/views  view · play · complete
│   ├── auth/               tokenStore (SecureStore) · validators (register/forgot forms)
│   ├── player/             VideoPlayer (expo-av, local-asset fallback) · tracking
│   ├── ai/                 PersonalTab · AssistantTab · RagLabTab (RAG playground)
│   ├── feed/               FeedList (activity cards)
│   ├── profile/            useProfileActions · NotificationSettings
│   ├── premium/            plan helpers
│   ├── watchlist/          useWatchlist (optimistic add/remove)
│   ├── utils/              theme (dark cinema tokens) · notifications (Expo local
│   │                       push: daily picks · weekly recap · new content ·
│   │                       premium renewal) · offlineVideo (bundled test clip)
│   └── assets/             icon · splash · adaptive-icon · favicon · offline-test.mp4
├── app.json · eas.json · metro.config.js · package.json · tsconfig.json
├── babel.config.js · .env.example
```

### API surface consumed (already running on Animaxia Cloud)

| Purpose | Endpoint |
| --- | --- |
| Home rows + hero | `GET /api/mobile/home` |
| Player payload | `GET /api/mobile/player/:id` |
| Profile card | `GET /api/mobile/profile` |
| Version gate + flags | `GET /api/mobile/config` |
| Auth | `POST /api/auth/login · register · refresh · logout · forgot-password · reset-password`, `GET /api/auth/me` |
| Watchlist / history / prefs / avatar | `GET·POST·DELETE /api/users/me/watchlist`, `GET·POST /api/users/me/history`, `GET·PUT /api/users/me/preferences`, `POST /api/users/me/avatar` |
| Feeds | `GET /api/social/feed/global`, `GET /api/social/feed/personal` |
| Likes / comments | `GET·POST /api/social/content/:id/like`, `GET·POST /api/social/content/:id/comments` |
| Personal AI | `GET /api/ai/personal/home · feed · player · recap` |
| Assistant | `POST /api/ai/assistant`, `GET /api/ai/assistant/history` |
| RAG (RAG Lab + panels) | `POST /api/ai/rag/recommend · summarize · explain · chat` |
| AI status | `GET /api/ai/cloud/status` |
| Premium | `GET /api/premium/plans · me`, `POST /api/premium/checkout · confirm · cancel` |
| Tracking | `POST /api/analytics/views` |

**AI quota per plan** (shown live by the QuotaMeter): free 10/day · plus 100/day · pro 500/day · anonymous 5/day per IP. A `402` with `upgrade: true` renders the Upgrade card → Premium screen.

### Phase 6 highlights

- **React Navigation** — 5-tab bottom navigator (custom BottomNav bar) + root stack; `animaxia://` deep links (`content/:id`, `player/:id`, `premium`, tabs) also serve notification taps.
- **Forgot password** — 2-step flow (email → 6-digit code + new password). The backend issues single-use, sha256-hashed 30-min codes; with no SMTP configured it runs in **sandbox mode** (code returned inline so the flow completes end-to-end — set `SMTPURL` in production).
- **Predicted rating** — Content screen shows the AI's predicted rating for YOU (`★ AI predicts 8.7 for you` + match %) from `GET /api/ai/personal/player`.
- **RAG Lab** — a 4-mode AI playground: Recommend (free-text query → vector-ranked picks with reasons), Summarize, Explain (match score + similar titles) and Chat-with-content.
- **Push notifications** (Expo local notifications — no server needed):
  - Daily picks — every day at 09:00
  - Weekly recap — Saturdays at 18:00
  - New content — one summary alert when the home feed surfaces unseen titles
  - Premium renewal — 3 days before the plan expires
  - Managed from Profile → Notifications (per-category switches, permission request, Android channel `animaxia`).
- **Offline mode** — Home / content / player payloads / AI picks are cached (AsyncStorage) and served stale with an amber banner; the player falls back to a **bundled test clip** (`app/assets/offline-test.mp4`) when cached sources are unavailable, and to public demo streams when a remote source fails.

---

## Setup

### 1. Prerequisites

- **Node.js ≥ 18** and a package manager (`npm`, `yarn`, `pnpm`; `bun` also works)
- **Expo CLI**: `npm i -g eas-cli` (for builds) — `npx expo` needs no global install
- Android Studio (emulator) and/or Xcode (simulator) for local dev
- The **Animaxia backend** running and reachable:
  - monolith: `cd mini-services/animaxia-backend && bun install && bun run dev` → `http://localhost:4000`
  - or the cloud fleet: `cd animaxia-cloud && ./scripts/dev-up.sh` → gateway `http://localhost:8080`

### 2. Install & configure

```bash
cd animaxia-mobile
npm install           # or: bun install

cp .env.example .env
```

Edit `.env` and point `EXPO_PUBLIC_API_URL` at your backend:

| Environment | Value |
| --- | --- |
| Android emulator | `http://10.0.2.2:8080` (gateway) or `http://10.0.2.2:4000` (monolith) |
| iOS simulator | `http://localhost:8080` or `http://localhost:4000` |
| Physical device | `http://<your-LAN-IP>:8080` (same Wi-Fi) |
| Production | `https://<your-deployed-gateway-origin>` |

> `10.0.2.2` is the Android emulator's alias for your machine's localhost.

### 3. Run in development

```bash
npm start             # Expo DevTools — scan the QR with Expo Go
npm run android       # open on the Android emulator/device
npm run ios           # open on the iOS simulator
npm run start:tunnel  # physical device over the internet (expo start --tunnel)
npm run typecheck     # tsc --noEmit (strict)
```

In **Expo Go** you get the JS bundle + hot reload; native playback (mp4/HLS via expo-av), SecureStore, the image picker and local notifications all work inside Expo Go on SDK 52.

### 4. Sign in

Any account created on the web console works (same Neon database) — or create one on the Login screen. Admin accounts see the ADMIN chip on the profile.

---

## Building for release

### EAS Build (recommended — no local Android/Xcode toolchain needed)

```bash
npm i -g eas-cli
eas login                       # or: eas whoami

# First time — link the project (creates the EAS project id):
eas init

# Android APK (install directly on devices):
npm run build:android:apk       # = eas build -p android --profile preview

# Android AAB (Google Play upload):
npm run build:android:play      # = eas build -p android --profile production

# iOS IPA (requires an Apple Developer account; EAS manages credentials):
npm run build:ios               # = eas build -p ios --profile production
```

Build profiles live in `eas.json`. Each profile injects its own `EXPO_PUBLIC_API_URL` — set your production gateway origin in the `production` and `preview` profiles before building.

### Local native builds (optional)

```bash
npx expo prebuild -p android      # generates android/ from app.json
npx expo run:android              # debug build on device/emulator

npx expo prebuild -p ios
npx expo run:ios
```

### Submit to stores

```bash
eas submit -p android --latest    # needs a service-account JSON key
eas submit -p ios --latest        # needs App Store Connect API key
```

### App identity

| Key | Value |
| --- | --- |
| Scheme / deep link | `animaxia://` (`animaxia://content/123`, `animaxia://player/123`, …) |
| Android package | `com.animaxia.mobile` |
| iOS bundle id | `com.animaxia.mobile` |
| Version | `2.0.0` (must be ≥ `versions.min` from `/api/mobile/config` — the Home screen warns below-min builds) |
| Android notifications channel | `animaxia` (importance HIGH) |

---

## Behaviour notes

- **Offline first** — Home, player payloads, AI explain/more-like-this and personal-AI data are cached in AsyncStorage and served stale with an amber banner when the network fails. Pull-to-refresh retries. The Player adds a bundled offline test clip + public demo streams as last-resort sources.
- **Token lifecycle** — access JWT lives 15 min; any 401 triggers ONE shared refresh (`POST /api/auth/refresh`, rotating tokens) and replays the original request. A dead refresh token clears the session and the app drops to anonymous mode (browsing stays public).
- **Password reset** — `POST /api/auth/forgot-password` issues a single-use 6-digit code (30 min, sha256 at rest, no user enumeration); `POST /api/auth/reset-password` consumes it, sets the new password and revokes every refresh token (all devices log out). Without `SMTPURL` on the server the code is returned inline (sandbox mode) — the app shows it in an info card.
- **Playback** — mp4 + HLS (`m3u8`) play natively (expo-av); `youtube`/`iframe` sources are listed under "External" and open in the browser. `view`/`play`/`complete` events go to `/api/analytics/views`; progress saves (throttled) power Continue-watching. The bundled offline clip plays with network tracking skipped.
- **AI on mobile** — Personal tab (GET /personal/home, 5-min cache), Assistant chat (history restored from the server, tool traces + memory chips shown per reply), content screen AI panel (Explain / More like this / Ask + predicted rating), RAG Lab (recommend / summarize / explain / chat). All quota-aware per plan.
- **Premium** — with no `STRIPESECRETKEY` on the backend, checkout runs in sandbox mode and the app activates the subscription inline; with a live key it opens the real Stripe page and confirms on return.
- **Notifications** — all four categories are local schedules (they fire even with the app killed); toggles live in Profile → Notifications and persist in AsyncStorage. Taps deep-link to the relevant screen.

## Roadmap hooks

- `expo-video` migration when moving past SDK 52 (drop-in inside `app/player/VideoPlayer.tsx`)
- Server push (Expo push tokens + a gateway `/api/notifications/register`) — the local scheduler already covers the four categories
- Offline downloads (expo-file-system) — the BFF payload already separates direct sources from embeds
