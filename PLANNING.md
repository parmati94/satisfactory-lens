# Satisfactory Lens — Project Planning

A self-hosted web app for viewing and interacting with a Satisfactory dedicated server. Inspired by palworld-lens.

---

## Stack

| Layer | Technology | Notes |
|---|---|---|
| Frontend | Alpine.js + Tailwind CSS + Vite | Reuse palworld-lens patterns |
| Backend | Node.js + TypeScript + Express | See rationale below |
| Save parsing | `@greeny/satisfactory-save-parser` | Best-in-class JS library, no Python equivalent |
| Server API | Satisfactory HTTP API (port 7777) | Full REST API shipped with dedicated server |
| Map | Leaflet.js + community map tiles | Standard for community Satisfactory tools |
| Game data | `Docs.json` (extracted from game) | All items, recipes, buildings, schematics |
| Container | Docker + nginx | Same nginx-frontend/node-backend pattern |

### Why Node.js instead of Python

The primary driver is save parsing. `@greeny/satisfactory-save-parser` (used by satisfactory-calculator.com) is the only complete, maintained Satisfactory save parser in the community. There is no Python equivalent at feature parity. Using a Python backend would require either:
- A subprocess/IPC bridge to a Node sidecar (messy)
- Writing a Python parser from scratch against the binary format spec (massive scope)

Since the save parser is JS/TS, a native Node backend is the natural fit. The Satisfactory HTTP API is trivial in any language, so we lose nothing there.

---

## Features

### Phase 1 — Server Dashboard (API-only, no save parsing)
- [ ] Connect to Satisfactory dedicated server HTTP API
- [ ] Auth flow (Bearer token, passwordless or password login)
- [ ] Server state: name, version, game phase, active session, tick rate, online players
- [ ] Server options viewer (difficulty, autosave interval, etc.)
- [ ] Advanced game settings viewer
- [ ] Session/save file list (`EnumerateSessions`)
- [ ] Load a save remotely (`LoadGame`)
- [ ] Trigger a manual save (`SaveGame`)
- [ ] Server health check + connection status indicator
- [ ] Basic auth (same cookie-based session pattern as palworld-lens)

### Phase 2 — Save File Viewer (save parsing)
- [ ] Mount or download a save file (volume mount or `DownloadSavegame` API call)
- [ ] Auto-watch save file for changes, reload on update (SSE, same as palworld-lens)
- [ ] Player list: position, inventory summary, health
- [ ] Factory overview: placed buildings count by type, power consumption
- [ ] Resource extraction: active resource nodes + extractor types + rates
- [ ] Power network summary: production vs consumption per circuit
- [ ] Train network: stations, locomotives, cargo

### Phase 3 — Map
- [ ] Leaflet.js base map with community-sourced tiles (satisfactory-calculator tile set)
- [ ] Plot all player positions on map
- [ ] Plot resource nodes (iron, copper, oil, etc.) with tier indicators
- [ ] Plot player-built structures (extractors, factories) with click-to-inspect
- [ ] Plot train stations + rail network overlay
- [ ] Toggle layers by category

### Phase 4 — Save Editing (write operations)
- [ ] Modify player inventory items/quantities
- [ ] Unlock/grant schematics
- [ ] Teleport player to coordinates (edit spawn position in save)
- [ ] Edit advanced game settings in save directly
- [ ] Upload modified save back to server via API (`UploadSavegame`)
- Note: write operations need careful validation — backup before modify pattern

---

## Satisfactory HTTP API Reference

The dedicated server exposes a REST API on port `7777` at `/api/v1`.
Authentication uses Bearer tokens with tiered privileges.

### Auth Tiers
- `NotAuthenticated` — health check only
- `Client` — read server state, list saves  
- `Administrator` — load/save games, change settings, run commands
- `InitialAdmin` — first-time setup, set admin password

### Key Endpoints (all POST to `/api/v1`)

```
PasswordlessLogin / PasswordLogin     → get auth token
QueryServerState                      → name, phase, players, session, flags
GetServerOptions                      → difficulty, autosave interval, etc.
SetServerOptions                      → update server options
GetAdvancedGameSettings               → creative mode settings, etc.
ApplyAdvancedGameSettings             → update advanced settings
EnumerateSessions                     → list all save files
LoadGame (sessionName, saveName)      → load a save
SaveGame (saveName)                   → create a save
DownloadSavegame (saveName)           → binary download of .sav file
UploadSavegame (saveName)             → upload a .sav file
DeleteSavegame (saveName)             → delete a save
RunCommand (command)                  → run server console command
Shutdown                              → graceful server shutdown
RenameServer (serverName)             → rename
SetAdminPassword / SetClientPassword  → auth management
HealthCheck                           → basic liveness (no auth required)
```

---

## Save File Parsing

Satisfactory `.sav` files are Unreal Engine binary saves. The community has fully reverse-engineered the format.

**Parser**: `@greeny/satisfactory-save-parser`
- npm: `@greeny/satisfactory-save-parser`
- Used by satisfactory-calculator.com and other major tools
- Outputs a structured JSON representation of the entire save

**Game data**: `Docs.json`
- Extracted from the game's `/CommunityResources/Docs/` directory
- Contains every item, recipe, building class, schematic, resource node type
- Should be committed to the repo under `data/` (same as palworld-lens data JSONs)

---

## Save Access Modes

Similar to palworld-lens, we want to support multiple ways to get the save file:

1. **Volume mount** — mount the server's save directory into the container (same host, Docker)
2. **API download** — use `DownloadSavegame` to pull the active save on demand
3. **SFTP/remote** — pull from a remote host (for remote server setups) — Phase 2+

---

## Project Structure (planned)

```
satisfactory-lens/
├── docker-compose.yml
├── docker-compose.dev.yml
├── Dockerfile
├── nginx.conf
├── PLANNING.md
├── data/
│   └── docs.json                    # Extracted Docs.json from game
├── backend/
│   ├── package.json
│   ├── tsconfig.json
│   ├── src/
│   │   ├── index.ts                 # App entry point
│   │   ├── config.ts                # Env-based config
│   │   ├── auth.ts                  # Session auth middleware
│   │   ├── api/
│   │   │   ├── server.ts            # Satisfactory HTTP API client
│   │   │   ├── routes/
│   │   │   │   ├── health.ts
│   │   │   │   ├── serverState.ts
│   │   │   │   ├── saves.ts
│   │   │   │   └── settings.ts
│   │   ├── save/
│   │   │   ├── loader.ts            # Load .sav from disk or API
│   │   │   ├── parser.ts            # Wrapper around greeny parser
│   │   │   ├── watcher.ts           # File watch + SSE (like palworld-lens)
│   │   │   └── extractors/
│   │   │       ├── players.ts
│   │   │       ├── buildings.ts
│   │   │       ├── resources.ts
│   │   │       ├── power.ts
│   │   │       └── trains.ts
│   │   └── models/
│   │       └── types.ts             # Shared TypeScript types
├── frontend/
│   ├── index.html
│   ├── login.html
│   ├── package.json
│   ├── vite.config.js
│   ├── tailwind.config.js
│   ├── postcss.config.js
│   ├── css/
│   ├── js/
│   │   ├── api.js                   # API client helpers
│   │   ├── auth.js
│   │   ├── dashboard.js             # Server state page
│   │   ├── saves.js                 # Save management page
│   │   ├── map.js                   # Leaflet map page
│   │   └── players.js
│   ├── partials/                    # Shared HTML partials
│   └── public/
└── supervisor/
    ├── supervisord.conf
    └── supervisord.dev.conf
```

---

## Open Questions / Decisions

- **Express vs Fastify vs Hono**: Going with Express — most mature, best-supported, no scalability concerns for a self-hosted tool. The ecosystem familiarity is the right tradeoff here.
- **Map tiles source**: satisfactory-calculator.com publishes tiles — need to confirm license/terms for self-hosted use. Fallback: SCIM (satisfactory-calculator interactive map) has an open-source version.
- **`Docs.json` versioning**: Game updates change Docs.json. Should be versioned in the repo and noted in the README.
- **Write operations safety**: Phase 4 write operations should always snapshot the save before modification and expose a restore endpoint.
- **TypeScript strict mode**: Yes, enable strict mode from the start to take full advantage of the typed save parser output.
