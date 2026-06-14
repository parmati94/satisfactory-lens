# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

### Backend (TypeScript/Express)
```bash
cd backend && npm install
cd backend && npm run dev        # tsx watch — live reload on src/ changes
cd backend && npm run build      # tsc — type-check and compile to dist/
```

### Frontend (Alpine.js/Vite)
```bash
cd frontend && npm install
cd frontend && npm run dev       # Vite dev server on :3001, proxies /api/ → :3000
cd frontend && npm run build     # Compile to frontend/dist/
cd frontend && npm run build -- --watch   # Watch mode for Docker dev workflow
```

### Docker
```bash
docker compose up -d --build                          # Production (serves on :5180)
docker compose -f docker-compose.dev.yml up --build   # Dev mode (serves on :5181)
```

Dev mode mounts `backend/src/` and `frontend/dist/` as volumes. Backend reloads automatically via `tsx watch`; frontend requires running `npm run build -- --watch` separately.

## Architecture

Two separate npm packages — `backend/` and `frontend/` — served from a single Docker container via nginx. nginx serves the built frontend static files and reverse-proxies `/api/` to the Express backend on port 3000.

### Backend (`backend/src/`)

**Entry point**: `index.ts` — mounts all routers, applies `requireAuth` middleware to all `/api/*` routes, auto-connects to SF server if `SF_HOST` is set, and auto-loads a mounted save on startup.

**Config**: `config.ts` — single export of all env vars with defaults. No `.env` file in dev; pass vars inline or via Docker.

**Auth**: `auth.ts` — cookie-based JWT sessions. The `/api/auth/*` routes in `routes/appAuth.ts` are public; everything else goes through `requireAuth`.

**Satisfactory API client** (`api/sfClient.ts`): Holds runtime connection state (host, port, bearer token) in module-level variables. All SF API calls POST to `https://<host>:<port>/api/v1` with a JSON body `{ function, data }`. Uses `undici` (not node-fetch) to support the `rejectUnauthorized: false` option for self-signed certs. Call `connectTo()` or `autoConnect()` before making API calls.

**Save subsystem** (`save/`):
- `saveState.ts` — in-memory singleton holding the parsed save. Use `getSave()` / `setSave()` / `getSaveStatus()`.
- `loader.ts` — loads from disk (`loadFromDisk`) or downloads from the SF API (`loadFromApi`). Both use `@etothepii/satisfactory-file-parser`'s `Parser.ParseSave()`.
- `watcher.ts` — `fs.watch` on the mounted `.sav` file with a 2-second debounce (game writes multiple times per save). Broadcasts to SSE clients via `broadcastSaveReloaded()`.
- `extractors/` — functions that receive the parsed save object and return structured data. Add new extractors here for Phase 2+ features (power networks, trains, etc.).

**Routes**:
- `routes/sfConnect.ts` — connect/disconnect to SF server
- `routes/serverState.ts` — `QueryServerState`, `HealthCheck`
- `routes/saves.ts` — `EnumerateSessions`, `LoadGame`, `SaveGame`
- `routes/settings.ts` — `GetServerOptions`, `GetAdvancedGameSettings`
- `routes/saveViewer.ts` — save status, reload, download, SSE stream, players, buildings

### Frontend (`frontend/`)

Single Alpine.js component in `js/app.js` (`Alpine.data('app', ...)`). All state lives in one flat component — tabs, SF connection, server data, save viewer data, and SSE lifecycle.

**API client**: `js/api.js` — thin fetch wrapper, grouped by namespace (`api.sf.*`, `api.server.*`, `api.saves.*`, `api.settings.*`, `api.save.*`, `api.auth.*`).

**Templating**: Vite + `vite-plugin-handlebars`. `index.html` and `login.html` use Handlebars `{{> partial}}` syntax to include files from `partials/`. Each tab is a separate partial file.

**CSS**: Tailwind CSS, processed by PostCSS via Vite.

**SSE**: `connectSaveSSE()` in `app.js` opens `EventSource('/api/save/events')` on init. On `save_reloaded` events, clears cached tab data and reloads the active sub-tab.

## Key Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `SF_HOST` | _(blank)_ | Auto-connect to SF server on startup |
| `SF_PORT` | `7777` | SF HTTP API port |
| `SF_PASSWORD` | _(blank)_ | SF admin password |
| `SF_ALLOW_SELF_SIGNED` | `true` | Skip TLS cert verification |
| `ENABLE_LOGIN` | `false` | Require username/password to access the UI |
| `SAVE_MOUNT_PATH` | `/app/saves` | Directory to look for `.sav` files |
| `SAVE_FILE_NAME` | _(blank)_ | Specific `.sav` to load; blank = newest in dir |
| `ENABLE_AUTO_WATCH` | `true` | Watch mounted save for changes |

## Save Parser

The `@etothepii/satisfactory-file-parser` package parses Unreal Engine binary `.sav` files into a structured JS object. The parsed save is stored in `saveState.ts` and passed to extractor functions. New data features (Phase 2+) should add extractor functions in `backend/src/save/extractors/` rather than embedding extraction logic in routes.

## Roadmap Phases

- **Phase 1** (complete): SF API dashboard — server state, saves, settings
- **Phase 2** (in progress): Save file viewer — parse `.sav`, display players and buildings. Future: resource nodes, power networks, trains
- **Phase 3**: Leaflet.js map with player positions, resource nodes, structure overlays
- **Phase 4**: Save editing — inventory, schematics, teleport; upload modified save back via `UploadSavegame`
