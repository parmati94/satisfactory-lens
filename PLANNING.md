# Satisfactory Lens — Planning & Todo

A self-hosted web app for viewing and editing a Satisfactory dedicated server and its saves. Inspired by palworld-lens.

---

## Stack

| Layer | Technology |
|---|---|
| Frontend | Alpine.js + Tailwind CSS + Vite + Handlebars partials |
| Backend | Node.js + TypeScript + Express |
| Save parsing | `@etothepii/satisfactory-file-parser` |
| Server API | Satisfactory HTTP API (port 7777) |
| Map | Leaflet.js + self-hosted tiles (sliced from 16K source at build time) |
| Game data | FModel-extracted pak data (items, buildings, icons) |
| Container | Docker + nginx |

---

## Todo

### Dashboard
- [x] Connect to Satisfactory dedicated server HTTP API
- [x] Auth flow (Bearer token, passwordless or password login)
- [x] Server state: name, version, game phase, active session, tick rate, online players
- [x] Server options viewer (difficulty, autosave interval, etc.)
- [x] Advanced game settings viewer
- [x] Session/save file list (`EnumerateSessions`)
- [x] Load a save remotely (`LoadGame`)
- [x] Trigger a manual save (`SaveGame`)
- [x] Server health check + connection status indicator
- [x] Settings moved to gear icon popup in header (not a nav tab)

### Save Viewer
- [x] Mount or download a save file (volume mount or `DownloadSavegame`)
- [x] Auto-watch save file for changes, reload on SSE event
- [x] Players tab: position, health, inventory icon grid
- [x] Storage tab: storage containers with inventory contents
- [x] Buildings tab: grouped by category, icons, search, stat cards
  - [x] Includes lightweight buildables (foundations, walls, ramps via `FGLightweightBuildableSubsystem`)
  - [x] Display names from `buildable_names.json` (generated from pak data)
  - [x] Full pos + rotation quaternion stored per instance (for future map use)
- [x] Power tab: per-circuit production vs consumption summary
- [ ] Resources tab: remove or rework — currently redundant with Buildings (Miners & Extractors category)
- [ ] Trains tab: stations, locomotives, cargo summary

### Map
- [x] Leaflet.js base map with self-hosted tiles (z3–z6, sliced at build time from 16K JPEG)
- [x] Player position markers (pioneer icon from game textures)
- [x] Resource node markers with purity + resource type
- [x] HUB marker
- [x] Player-placed map stamps
- [x] Filter panel (toggle layers by category)
- [ ] Factory overlay: SCIM-style vector rendering of buildings using stored pos/rot transforms
  - Buildings extractor already stores per-instance transform data
  - Will need building footprint dimensions from game data to draw footprints correctly
  - Conveyors/belts as drawn lines between endpoints
- [ ] Train network overlay: stations + rail lines

### Save Editing
- [ ] Backup save before any write operation (snapshot pattern)
- [ ] Edit player inventory (add/remove/change items + quantities)
- [ ] Edit storage container contents
- [ ] Teleport player (edit position in save)
- [ ] Edit advanced game settings in save
- [ ] Unlock schematics
- [ ] Serialize modified save with `Parser.WriteSave()` and upload via `UploadSavegame` API
  - SF dedicated server API supports `UploadSavegame` — no need to swap files on disk
  - Server will need to reload the save after upload (`LoadGame`)

---

## Satisfactory HTTP API Reference

All endpoints are POST to `/api/v1` on port `7777`. Authentication uses Bearer tokens.

### Auth Tiers
- `NotAuthenticated` — health check only
- `Client` — read server state, list saves
- `Administrator` — load/save games, change settings, run commands
- `InitialAdmin` — first-time setup, set admin password

### Key Endpoints

```
PasswordlessLogin / PasswordLogin     → get auth token
HealthCheck                           → liveness (no auth required)
QueryServerState                      → name, phase, players, session, flags
GetServerOptions                      → difficulty, autosave interval, etc.
SetServerOptions                      → update server options
GetAdvancedGameSettings               → creative mode settings, etc.
ApplyAdvancedGameSettings             → update advanced settings
EnumerateSessions                     → list all save files
LoadGame (sessionName, saveName)      → load a save
SaveGame (saveName)                   → create a save
DownloadSavegame (saveName)           → binary download of .sav file
UploadSavegame (saveName)             → upload a modified .sav file
DeleteSaveFile (saveName)             → delete a save (note: NOT DeleteSavegame)
RunCommand (command)                  → run server console command
Shutdown                              → graceful server shutdown
```

---

## Notes

- **Save editing round-trip**: `Parser.ParseSave()` → mutate in-memory object → `Parser.WriteSave()` → `UploadSavegame` API. The parser library fully supports write-back. `UploadSavegame` then `LoadGame` to apply without touching the filesystem.
- **Map vector rendering**: Building footprint dimensions are not in the save — they come from game data. Will need to extract or hardcode dimensions per building type to draw footprints on the map correctly.
- **Write safety**: Always `DownloadSavegame` as a backup before any edit operation. Expose a restore endpoint.
- **Tiles**: Self-hosted from a 16K JPEG source sliced at container build time (z3–z6). No external dependency.
