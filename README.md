# OSRS Chathead & Dialogue Generator

Authentic Old School RuneScape 3D chathead renderer and `519×142` dialogue chatbox generator powered by a Jagex-style software rasterizer, real OSRS cache decoding, and animated GIF/PNG export.

## Features

- **Authentic 3D Software Rasterizer** (`src/shared/renderer/SoftwareRasterizer.ts`)
  - Uses OSRS fixed-point projection (`zoom 796`, `pitch 40`, NPC yaw `1882` facing right / Player yaw `166` facing left), HSL-to-RGB lighting, face priority/depth sorting, and skeletal chathead animations (`frameIds` + opcode 12 `chatFrameIds`).
- **Dual Chathead Previews (Regular `96×96` Slot + Full Unclipped)** (`src/shared/renderer/ChatheadPipeline.ts`)
  - **Regular (`96×96` slot)**: Matches OSRS `Interface 231 / 217` framing and clipping (`x: 19..114` NPC, `x: 402..497` Player, `y: 23..118`) at configurable integer scale.
  - **Full Unclipped**: Automatically appears when a chathead or tall headgear/beard (e.g., Odd Old Man) extends beyond the `96×96` slot—tight-cropped when paused/static, or clamped to the full sequence's union bounding box during animation so previews never jitter.
- **Authentic `519×142` OSRS Chatbox Composer** (`src/shared/renderer/ChatboxRenderer.ts`)
  - Renders over the game-accurate `Sprite 1017` parchment backdrop (`src/shared/constants/chatboxBackdrop.ts`) with embedded `rev 242` bitmap fonts (`p11_full`, `p12_full`, `b12_full`, and `q8_full` in `src/shared/constants/bitmapFonts.ts`), inline `<col=RRGGBB>` color tags, NPC-left / Player-right / text-only layouts, and stacked multi-turn dialogue strips (`osrs-dialogue-strip.png`).
- **NPC, Player & Live Hiscores Lookup** (`src/client/components/NpcLookupPanel.tsx`, `src/client/components/PlayerLookupPanel.tsx`)
  - Search NPCs by name or ID, inspect morph children, override NPC HSL palette colors, configure Player kits/headgear/colors (auto-hiding hair and beard when wearing full helms), and query live OSRS Hiscores (`index_lite.json` with `index_lite.ws` fallback).
- **Animated GIF & PNG Exports** (`src/shared/renderer/GifExporter.ts`, `src/client/components/ChatboxComposer.tsx`)
  - Shared-palette animated transparent GIFs for Regular and Full chatheads, animated `519×142` chatbox GIFs, scaled PNG downloads, and HTTP-backed `.gif` / `.png` preview images.
- **Multi-Format Cache Support & Browser Persistence** (`src/shared/cache/UnifiedCacheLoader.ts`, `src/client/ClientCacheProxy.ts`)
  - Supports `.dat2`/`.idx*`, Abex `.flatcache`, OpenRS2 flat-file directories, legacy 317 `.dat`/`.idx`, and plain `.dat` model files.
  - Caches dropped or selected in the browser stay client-side (never uploaded to the server) and persist across reloads via `localStorage` (`osrs_local_cache_meta_v1` / `osrs_local_cache_data_v1` up to 2 MB) and `IndexedDB` (`osrs_local_cache_db_v1`), alongside saved user preferences (`osrs_user_prefs_v1`).

---

## Local Development

### Prerequisites

- Node.js `22+` and `npm`

### Setup & Run

```bash
npm install
npm run dev
```

Vite binds to `http://127.0.0.1:5173` by default. If `./cache` is empty, the server automatically generates a built-in starter `.dat2`/`.idx*` cache on first request.

### Cache Scripts

```bash
# Write the built-in starter cache to ./cache (add --force to overwrite)
npm run fetch-cache

# Download the latest OSRS cache archive from OpenRS2 into ./cache
npx tsx scripts/fetch-openrs2-cache.ts --openrs2

# Or download a specific OpenRS2 cache ID
npx tsx scripts/fetch-openrs2-cache.ts --openrs2 2772
```

### Build, Preview & Tests

```bash
# Run TypeScript check and build production bundle to dist/
npm run build

# Serve production build + /api/* middleware locally
npm run preview

# Run Vitest unit and API tests
npm test
```

---

## Docker & Public Hosting

Both `configureServer` (`vite`) and `configurePreviewServer` (`vite preview`) mount the `/api/*` middleware in [src/server/apiPlugin.ts](src/server/apiPlugin.ts).

```bash
OSRS_ADMIN_TOKEN="change-this-secret" docker compose up -d --build
```

- Exposes port `5173` (`http://localhost:5173`).
- Mounts `./cache:/app/cache` so server cache files persist across container rebuilds.
- Runs as non-root `USER node` on `node:22-alpine` with a container healthcheck on `/api/cache/status`.

### Environment Variables

| Variable | Default | Description |
| --- | --- | --- |
| `OSRS_ADMIN_TOKEN` | _(unset)_ | Secret token checked via `X-OSRS-Admin-Token` (`timingSafeEqual`) for `POST /api/cache/load-path` and `POST /api/cache/download-openrs2`. When unset, only direct non-proxied loopback requests are permitted. Can be saved in browser `localStorage` (`osrs_admin_token`) under **Server Admin (Self-Hosted)**. |
| `OSRS_ALLOW_HOST_CACHES` | `0` | Opt-in flag (`1`) allowing local `~/jagexcache/oldschool/LIVE` and `~/.runelite/jagexcache/oldschool/LIVE` directories on the server allowlist for single-user local setups. Keep `0` in Docker and public deployments. |

When deploying publicly behind a reverse proxy (Caddy, nginx, Cloudflare, etc.), always set `OSRS_ADMIN_TOKEN` so forwarded external requests cannot trigger server-side OpenRS2 downloads via the proxy's loopback socket.

### API Hardening Summary

- **Allowlisted cache paths only**: `POST /api/cache/load-path` validates canonical `fs.realpath` entries against the allowlist (`403` otherwise), and `GET /api/cache/status` exposes only logical labels (e.g., `./cache`) rather than host paths.
- **Same-origin `POST` guard**: Verifies `Sec-Fetch-Site` and `Origin` against `Host` on all `POST /api/*` requests.
- **Upload validation & memory caps**: Verifies `GIF87a`/`GIF89a` or PNG magic bytes on `POST /api/preview-image/*`, caps uploads at `12 MB` (`48 MB` / `60` files total in memory), and serves images with `X-Content-Type-Options: nosniff` and `Content-Security-Policy: default-src 'none'`.
- **Rate limiting**: Sliding-window per-IP limits on `/api/player/lookup/*` (20 req/min), `/api/cache/download-openrs2` (2 req/min), and `POST /api/preview-image/*` (120 req/min).

---

## Project Structure

```text
├── cache/                       # Server OSRS cache directory (mounted volume in Docker)
├── scripts/
│   └── fetch-openrs2-cache.ts   # Starter & OpenRS2 cache downloader CLI
├── src/
│   ├── client/
│   │   ├── components/
│   │   │   ├── AnimationControls.tsx
│   │   │   ├── CacheLoaderPanel.tsx
│   │   │   ├── ChatboxComposer.tsx
│   │   │   ├── NpcLookupPanel.tsx
│   │   │   └── PlayerLookupPanel.tsx
│   │   ├── App.tsx
│   │   ├── ClientCacheProxy.ts  # API proxy + localStorage/IndexedDB persistence
│   │   ├── main.tsx
│   │   └── styles.css
│   ├── server/
│   │   ├── apiPlugin.ts         # Vite dev & preview API middleware + security guards
│   │   └── NodeFileProvider.ts
│   └── shared/
│       ├── __tests__/
│       │   └── renderer.test.ts
│       ├── cache/               # Binary/flatcache/dat2/legacy decoders & starter builder
│       ├── constants/           # OSRS fonts, Sprite 1017 backdrop, animations & colors
│       └── renderer/            # Math, mesh builder, rasterizer, chatbox & GIF encoder
├── Dockerfile
├── docker-compose.yml
├── .dockerignore
├── index.html
├── package.json
├── tsconfig.json
└── vite.config.ts
```
