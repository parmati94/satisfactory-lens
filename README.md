# Satisfactory Lens

A self-hosted web dashboard for your Satisfactory dedicated server. Connect to the server's HTTP API to view state, manage saves, and tweak settings — all from a clean browser UI.

Built with the same single-container approach as palworld-lens: nginx + Node.js backend in one Docker image.

---

## Features

- **Server Dashboard** — live server state, player count, tech tier, tick rate, session info
- **Save Management** — browse all save files grouped by session, trigger new saves, load saves remotely
- **Settings Viewer** — read server options and advanced game settings
- **Connect UI** — enter host/port/password in-browser, or pre-configure via env for auto-connect on startup
- **Optional App Auth** — protect the UI with a username/password login (cookie-based session)
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

### 2. Build and run

```bash
docker compose up -d --build
```

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
| `SF_PASSWORD` | _(blank)_ | Server admin password |
| `SF_ALLOW_SELF_SIGNED` | `true` | Accept self-signed TLS certs (recommended — the game server uses one) |
| `ENABLE_LOGIN` | `false` | Set to `true` to require username/password to access the UI |
| `USERNAME` | `admin` | App login username (only used if `ENABLE_LOGIN=true`) |
| `PASSWORD` | `changeme` | App login password |
| `SESSION_SECRET` | _(insecure default)_ | Secret for signing session cookies — **change this in production** |
| `TZ` | `America/New_York` | Timezone for log timestamps |

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

### Building for production

```bash
docker compose build
docker compose up -d
```

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
├── data/                        # Game data files (Docs.json goes here — Phase 2)
├── backend/
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts             # Express app entry point
│       ├── config.ts            # Env-based config
│       ├── auth.ts              # App session auth (JWT cookies)
│       ├── api/
│       │   └── sfClient.ts      # Satisfactory HTTP API client
│       └── routes/
│           ├── appAuth.ts       # Login / logout / status
│           ├── sfConnect.ts     # SF server connect / disconnect
│           ├── serverState.ts   # Query server state + health
│           ├── saves.ts         # Enumerate / load / create saves
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
│   └── partials/                # Handlebars HTML partials
│       ├── head.html
│       ├── header.html
│       ├── nav.html
│       ├── footer.html
│       ├── dashboard-tab.html
│       ├── saves-tab.html
│       ├── settings-tab.html
│       └── connect-modal.html
└── supervisor/
    ├── supervisord.conf         # Production: node dist/index.js
    └── supervisord.dev.conf     # Dev: tsx watch src/index.ts
```

---

## Roadmap

See [PLANNING.md](PLANNING.md) for the full feature roadmap, including:

- **Phase 2** — Save file parsing (player positions, factory overview, power networks, trains)
- **Phase 3** — Interactive Leaflet map with resource nodes, player positions, and structure overlays
- **Phase 4** — Save editing (inventory, schematics, teleport, upload back to server)
