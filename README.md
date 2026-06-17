# Satisfactory Lens

A self-hosted web dashboard for your Satisfactory dedicated server. Connect to the server's HTTP API to view state, manage saves, and tweak settings — all from a clean browser UI.

Built with the same single-container approach as palworld-lens: nginx + Node.js backend in one Docker image.

---

## Features

- **Server Dashboard** — live server state, player count, tech tier, tick rate, session info
- **Save Viewer** — parses the live save into intent-based tabs: Players, Progression (unlocks), Production, Power, Storage, and a Structures census
- **Interactive Map** — Leaflet world map with resource nodes, machines drawn as top-down silhouettes/height-reliefs, belts/pipes/rails as splines, and click-to-inspect linked to the Save Viewer
- **Save Editing** — edit player health & inventory, toggle schematic unlocks, and write changes back to the save
- **Save Management** — browse all save files grouped by session, trigger new saves, load saves remotely
- **Settings Viewer** — read server options and advanced game settings
- **Connect UI** — enter host/port/password in-browser, or pre-configure via env for auto-connect on startup
- **Optional App Auth** — protect the UI with a username/password login (cookie-based session, rate-limited)
- **Single Container** — nginx serves the frontend and proxies `/api/` to the Express backend

---

## Quick Start

### Prerequisites

- Docker & Docker Compose
- A running Satisfactory dedicated server (Update 8+) with the HTTP API enabled on port `7777`

### 1. Clone and configure

```bash
git clone https://github.com/yourname/satisfactory-lens.git
cd satisfactory-lens
```

Open `docker-compose.yml` and set your server details:

```yaml
environment:
  - SF_HOST=192.168.1.100   # your dedicated server IP/hostname
  - SF_PORT=7777             # default Satisfactory API port
  - SF_PASSWORD=             # admin password (blank if none set)
```

### 2. Pull and run

```bash
docker compose up -d
```

This pulls the prebuilt image (`parmati/satisfactory-lens:latest`, published by CI on push to `main`). Run `docker compose pull` to grab the newest image later. To build from source instead, use `docker-compose.dev.yml`.

### 3. Open the UI

```
http://localhost:5180
```

If `SF_HOST` is set, the backend auto-connects on startup and the dashboard loads immediately. If left blank, a **Connect** button in the header lets you enter the details in-browser.

---

## Configuration Reference

All settings are environment variables in `docker-compose.yml`:

| Variable | Default | Description |
|---|---|---|
| `SF_HOST` | _(blank)_ | Dedicated server IP or hostname. Leave blank to connect via the UI. |
| `SF_PORT` | `7777` | Satisfactory HTTP API port |
| `SF_PASSWORD` | _(blank)_ | Server admin password. Used for auto-connect on startup when `SF_HOST` is set. |
| `ENABLE_LOGIN` | `false` | Set to `true` to require username/password to access the UI |
| `USERNAME` | `admin` | App login username (only used if `ENABLE_LOGIN=true`) |
| `PASSWORD` | `changeme` | App login password (only used if `ENABLE_LOGIN=true`) |
| `SESSION_SECRET` | _(placeholder)_ | Secret for signing session cookies. When `ENABLE_LOGIN=true` the backend **refuses to start** unless this is a strong, random value — generate with `openssl rand -hex 32`. |
| `TZ` | `America/New_York` | Timezone for log timestamps |
| `ENABLE_AUTO_WATCH` | `true` | Flag (never auto-reload) when a newer save appears, in the UI (header reload button). Watches `/app/saves` if mounted, otherwise polls the SF API. Never reloads automatically — you choose when to reload, so it won't clobber in-progress edits. |
| `SAVE_POLL_INTERVAL_SECONDS` | `30` | How often to poll the SF API for a newer save when no mount is present. Ignored in mount mode (which watches the directory directly). |

Mounting a save folder is **fully optional**. By default the Save Viewer loads the latest save via the SF API once connected — no volume needed. For local-disk access instead, uncomment the volume in `docker-compose.yml` and point it at your save folder (read-only):

```yaml
volumes:
  - /path/to/satisfactory/saves:/app/saves:ro
```

A mounted save always takes precedence over the API when present. Which specific save to load (an older save, a different session) is a UI choice — see the Saves tab or the Download modal — not a config setting.

When `ENABLE_LOGIN=true`, auth is enforced on the backend — every `/api/` route requires the session cookie (not just the UI), and the login endpoint is rate-limited. For public exposure, terminate HTTPS at a reverse proxy (Caddy/nginx) or Cloudflare in front of the container.

---

## Satisfactory Server Setup

The HTTP API ships with the dedicated server. By default it listens on the same port as the game (`7777`) but on a different protocol (HTTPS). No extra mods or configuration are required.

If you haven't set an admin password yet, the game server will prompt you on first join — or you can do it via the **Initial Admin** flow in the connect modal (leave password blank to use `PasswordlessLogin` which grants initial admin on a fresh server).

Make sure port `7777` (TCP) is accessible from the machine running satisfactory-lens. If both are on the same host or Docker network, no firewall changes are needed.

---

## Development Workflow

### Prerequisites

- Node.js 20+
- npm

### Setup

```bash
# Install backend deps
cd backend && npm install

# Install frontend deps
cd ../frontend && npm install
```

### Running locally (no Docker)

In one terminal — backend with live reload:

```bash
cd backend
SF_HOST=192.168.1.100 SF_PASSWORD=yourpassword npm run dev
# Listens on http://localhost:3000
```

In a second terminal — frontend Vite dev server with HMR:

```bash
cd frontend
npm run dev
# Listens on http://localhost:3001
# Proxies /api/ → http://localhost:3000 automatically (see vite.config.js)
```

Open `http://localhost:3001` in your browser.

### Running with Docker (dev mode)

Dev mode mounts `backend/src/` for live backend reload via `tsx watch` and `frontend/dist/` so you can control the frontend build yourself.

```bash
docker compose -f docker-compose.dev.yml up --build
```

Then in a separate terminal, run the frontend Vite watcher to auto-rebuild into `frontend/dist/` on save:

```bash
cd frontend && npm run build -- --watch
```

The container serves on port `5181`. Backend changes (in `backend/src/`) reload automatically inside the container. Frontend changes rebuild locally and are picked up by nginx via the mounted `dist/` volume.

### Production image

`docker-compose.yml` runs the prebuilt `parmati/satisfactory-lens:latest` image, published by GitHub CI on every push to `main`. Just pull and run:

```bash
docker compose pull
docker compose up -d
```

To build the image from source yourself, use `docker-compose.dev.yml` (or add a `build: .` line to `docker-compose.yml`).

### TypeScript compilation check (no Docker)

```bash
cd backend && npm run build
```

---

## Project Structure

```
satisfactory-lens/
├── docker-compose.yml           # Production compose
├── docker-compose.dev.yml       # Dev compose (source mounts + tsx watch)
├── Dockerfile
├── nginx.conf                   # Reverse proxy: static files + /api/ → :3000
├── PLANNING.md                  # Feature planning and roadmap
├── backend/
│   ├── package.json
│   ├── tsconfig.json
│   ├── data/                    # Static runtime data (e.g. buildable-footprints.json)
│   └── src/
│       ├── index.ts             # Express app entry point + auth boot guard
│       ├── config.ts            # Env-based config
│       ├── auth.ts              # App session auth (JWT cookies)
│       ├── loginRateLimit.ts    # In-memory rate limiter for the login route
│       ├── api/
│       │   └── sfClient.ts      # Satisfactory HTTP API client
│       ├── save/                # Save-file parsing, extractors, and mutators
│       └── routes/
│           ├── appAuth.ts       # Login / logout / status
│           ├── sfConnect.ts     # SF server connect / disconnect
│           ├── serverState.ts   # Query server state + health
│           ├── saves.ts         # Enumerate / load / create saves
│           ├── saveViewer.ts    # Parsed save data + edit mutations
│           ├── mapTiles.ts      # Map tile + save-derived map pin endpoints
│           └── settings.ts      # Server options + advanced settings
├── frontend/
│   ├── index.html               # Main app (uses Handlebars partials)
│   ├── login.html
│   ├── vite.config.js
│   ├── tailwind.config.js
│   ├── css/main.css
│   ├── js/
│   │   ├── api.js               # Fetch wrapper for all backend endpoints
│   │   ├── app.js               # Alpine.js app component
│   │   └── login.js             # Alpine.js login component
│   ├── public/                  # Static assets (map img, item icons, building reliefs)
│   └── partials/                # Handlebars HTML partials (header, tabs, modals)
│       ├── head.html
│       ├── header.html          # Merged top bar: logo + tabs + status + actions
│       ├── footer.html
│       ├── dashboard-tab.html
│       ├── save-viewer-tab.html
│       ├── map-tab.html
│       ├── saves-tab.html
│       ├── settings-tab.html
│       ├── connect-modal.html
│       ├── app-settings.html
│       └── confirm-dialog.html
└── supervisor/
    ├── supervisord.conf         # Production: node dist/index.js
    └── supervisord.dev.conf     # Dev: tsx watch src/index.ts
```

---

## Roadmap

Save parsing, the interactive map, and the first wave of save editing have shipped (see the Features list above). See [PLANNING.md](PLANNING.md) for the full roadmap and what's next, including:

- **Save Viewer** — a Production overview header, Structures per-type drill-down, and a Logistics tab (trains/trucks/drones)
- **Map** — train-network overlay, viewport culling / zoom LOD
- **Save Editing** — in-place machine recipe & overclock editing, equipment/arm slots, AWESOME Sink coupons
