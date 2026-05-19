# Orchestrator

Local-first AI orchestrator web app for personal agents, model routing, browser automation, scheduling, inbox-style task results, watchlists, artifacts, and service integrations.

Orchestrator is designed to run on your own machine or a private Linux host. It can execute local tools, launch browser sessions, store API keys in local env files, and persist private workspace state. Treat it as a trusted local application, not a public web service.

## Features

- Multi-agent chat with provider/model configuration.
- Local CLI-backed agents, browser agent, artifacts, upload handling, and terminal output rendering.
- Scheduling, recurring monitors, and an Inbox for silent/background runs.
- Watchlist for financial instruments with optional Twelve Data quotes/history.
- Integrations for Google Workspace, Gmail, Home Assistant, WhatsApp, and local tool execution.
- Managed updater based on GitHub Releases for native services and installer-managed Docker.
- Docker/Compose deployment for Linux with browser runtime included.

## Security Model

By default the app binds to `127.0.0.1`. Keep it that way unless it is behind a trusted access layer such as SSH tunneling, Tailscale, VPN, or a reverse proxy with authentication.

Do not expose Orchestrator directly to the public internet. The app has endpoints that can run agents, mutate local state, use local credentials, and execute local tools. Cross-origin mutating API requests are blocked, but that is not a substitute for authentication at the network edge.

## Requirements

- Node.js `22.x` for native/manual installs.
- npm `11.x` or compatible with Node 22.
- Git.
- Docker with Compose for container deployment.
- Optional API keys in `.env` / `.env.local`.

## One-Line Linux Install

On Linux, the installer uses Docker by default. It installs/verifies Docker and Compose, starts the Docker daemon where supported, clones or updates the repo under `~/.orchestrator/app`, creates `.env` if missing, installs the local Docker update bridge, builds the image, and starts the stack detached.

```bash
curl -fsSL https://raw.githubusercontent.com/Horia73/orchestrator/master/scripts/install.sh | bash
```

Open:

```text
http://127.0.0.1:3000
```

Useful overrides:

```bash
curl -fsSL https://raw.githubusercontent.com/Horia73/orchestrator/master/scripts/install.sh | \
  ORCHESTRATOR_PORT=3100 \
  BROWSER_AGENT_VNC_WS_PORT=6081 \
  ORCHESTRATOR_HOME="$HOME/.orchestrator" \
  bash
```

Force the native service installer instead:

```bash
curl -fsSL https://raw.githubusercontent.com/Horia73/orchestrator/master/scripts/install.sh | \
  ORCHESTRATOR_INSTALL_MODE=native \
  bash
```

The installed `orchestrator` CLI supports `start`, `stop`, `restart`, `status`, `logs`, and `update`. Installer-managed Docker installs also enable Settings -> Updates -> Update from inside the app.

## Quick Start With Docker

Docker is the recommended Linux deployment because the app uses native Node modules and browser automation runtimes.

```bash
git clone https://github.com/Horia73/orchestrator.git
cd orchestrator
cp .env.example .env
docker compose up --build -d
```

Open:

```text
http://127.0.0.1:3000
```

The Compose file publishes only local host ports:

- `127.0.0.1:3000` for the app.
- `127.0.0.1:6080` for browser live view WebSocket/VNC proxy.

If your Docker installation uses the legacy binary, use:

```bash
docker-compose up --build -d
```

## Docker Operations

View logs:

```bash
docker compose logs -f orchestrator
```

Restart:

```bash
docker compose restart orchestrator
```

Update a Docker install:

```bash
orchestrator update
```

Manual Docker checkouts can still update with `git pull --ff-only && docker compose up --build -d`.

Persistent data lives in the `orchestrator-data` Docker volume mounted at `/app/.orchestrator`.

## Native Install

Use native install for macOS/Linux desktops or when you want the managed updater.

```bash
git clone https://github.com/Horia73/orchestrator.git
cd orchestrator
npm ci
npm run browsers:install
npm run build
npm start
```

Open:

```text
http://127.0.0.1:3000
```

The `npm start` wrapper binds to `ORCHESTRATOR_HOST` and `ORCHESTRATOR_PORT`; defaults are `127.0.0.1` and `3000`.

## Native Managed Service Install

macOS uses the native managed service install by default. Linux can opt into it with `ORCHESTRATOR_INSTALL_MODE=native`.

```bash
curl -fsSL https://raw.githubusercontent.com/Horia73/orchestrator/master/scripts/install.sh | \
  ORCHESTRATOR_INSTALL_MODE=native \
  bash
```

The native installer:

- clones or updates the app under `~/.orchestrator/app`;
- installs Node 22 with `nvm` if needed;
- installs Linux build/browser dependencies where possible;
- runs `npm ci`;
- installs the Patchright Chromium runtime;
- builds the app;
- creates a `systemd --user` service on Linux or a `launchd` service on macOS;
- installs an `orchestrator` CLI with `start`, `stop`, `restart`, `status`, `logs`, and `update`.

Native overrides:

```bash
curl -fsSL https://raw.githubusercontent.com/Horia73/orchestrator/master/scripts/install.sh | \
  ORCHESTRATOR_INSTALL_MODE=native \
  ORCHESTRATOR_PORT=3100 \
  ORCHESTRATOR_HOST=127.0.0.1 \
  ORCHESTRATOR_HOME="$HOME/.orchestrator" \
  bash
```

## Configuration

Start from:

```bash
cp .env.example .env
```

Important variables:

- `GEMINI_API_KEY`: Google/Gemini provider and browser vision loop.
- `OPENAI_API_KEY`: OpenAI provider.
- `ANTHROPIC_API_KEY`: Anthropic provider.
- `TWELVE_DATA_API_KEY`: Watchlist financial search, quotes, and history.
- `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET`: Google Workspace and Gmail OAuth.
- `HOME_ASSISTANT_URL` / `HOME_ASSISTANT_TOKEN`: Home Assistant integration.
- `WHATSAPP_CHROME_EXECUTABLE_PATH`: browser executable override for WhatsApp.
- `WHATSAPP_USER_AGENT`: optional WhatsApp Web browser user-agent override.
- `BROWSER_AGENT_LIVE_VIEW`: enables live browser view on Linux/Docker.

For native installs, runtime workspace state and editable app files live under `.orchestrator/` in the checkout. For managed installs, that is usually `~/.orchestrator/app/.orchestrator`.

## Browser Agent Live View

macOS runs Patchright in a local headful browser window. Linux/Docker uses Xvnc plus a tokenized WebSocket proxy. The provided Docker image includes Chromium, TigerVNC, Openbox, and noVNC client dependencies.

Default Docker live-view settings:

```text
ORCHESTRATOR_PUBLIC_URL=
BROWSER_AGENT_LIVE_VIEW=1
BROWSER_AGENT_VNC_WS_HOST=0.0.0.0
BROWSER_AGENT_VNC_WS_PORT=6080
BROWSER_AGENT_VNC_WS_PUBLIC_URL=ws://127.0.0.1:6080
```

Set `ORCHESTRATOR_PUBLIC_URL` when users open the app through a LAN hostname,
reverse proxy, or tunnel, for example `http://orchestrator.lan`. Google OAuth
is stricter than normal app routing: Authorized redirect URIs must be either
`localhost` for a local/SSH-tunnel setup, or an HTTPS URL on a real public
domain. Names such as `.lan`, `.local`, and private IPs are fine for opening
Orchestrator, but Google rejects them as OAuth redirect URIs. When the app URL
is not Google-compatible, Orchestrator falls back to `http://localhost:3000/...`
for OAuth so users can connect through an SSH tunnel, or you can set
`GOOGLE_WORKSPACE_OAUTH_REDIRECT_URI` / `GMAIL_OAUTH_REDIRECT_URI` to a public
HTTPS callback.

The simplest Google-compatible setup that needs no port forwarding: point a
dynamic-DNS hostname (for example a free DuckDNS subdomain) at the box, issue a
Let's Encrypt certificate through the DNS-01 challenge, and use split-horizon
DNS so the name resolves to the LAN IP at home. The app then runs on a real
publicly-trusted HTTPS URL — OAuth works directly, with no SSH tunnel and
nothing exposed to the internet.

For headless Linux where the browser is on another machine, keep the app
reachable through the LAN name/IP for normal use, but do Google OAuth through a
local tunnel:

```bash
ssh -N -L 3000:127.0.0.1:3000 user@orchestrator.lan
```

Then open `http://localhost:3000/settings`, run Connect, wait until the
integration card says Connected, and stop the tunnel with `Ctrl+C`. If the LAN
IP changes, prefer a stable LAN DNS name such as `orchestrator.lan`; the app
also reports current SSH host candidates in the integration status payload.

Keep `6080` bound to `127.0.0.1` unless it is protected by the same private access layer as the main app.

## Updates

Installer-managed Docker installs use a local host update bridge:

```bash
orchestrator update
```

The bridge is installed by `scripts/install.sh`, listens locally for the container through `host.docker.internal`, authenticates with a generated token, runs `git pull --ff-only`, then rebuilds/restarts Docker Compose.

Managed installs use GitHub Releases as the update source:

- Settings -> Updates shows installed and latest release versions.
- Settings -> Updates -> Update queues an update when the install is managed.
- `orchestrator update` performs the same update from the host shell.
- Active AI runs are allowed to finish before maintenance starts.
- During maintenance, new AI requests are paused until restart completes.

Manual Docker checkouts without the installer bridge should update from the host:

```bash
git pull --ff-only
docker compose up --build -d
```

## Development

```bash
npm ci
npm run browsers:install
npm run dev
```

Quality checks:

```bash
npm run typecheck
npm run lint
npm run build
npm audit --omit=dev --audit-level=high
```

## Release

Normal branch pushes are development snapshots. Public releases are tags.

Before releasing:

```bash
git status --short
npm run typecheck
npm run lint
npm run build
```

Create and push a release:

```bash
npm run release:patch
npm run release:minor
npm run release:major
```

The release script runs checks, bumps `package.json` and `package-lock.json`, commits, tags, pushes the branch, and pushes the tag. The GitHub Release workflow creates the GitHub Release for pushed `v*` tags.
