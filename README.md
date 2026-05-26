# Orchestrator

Local-first AI orchestrator web app for personal agents, model routing, browser automation, scheduling, inbox-style task results, watchlists, artifacts, and service integrations.

Orchestrator is designed to run on your own machine or a private Linux host. It can execute local tools, launch browser sessions, store API keys in local env files, and persist private workspace state. Treat it as a trusted local application, not a public web service.

## Features

- Multi-agent chat with provider/model configuration.
- Local CLI-backed agents, browser agent, artifacts, upload handling, and terminal output rendering.
- Scheduling, recurring monitors, and an Inbox for silent/background runs.
- Generic inbound webhooks with authenticated event logs and Microscript dispatch.
- Microscripts for bounded deterministic checks, with optional restricted agent wake escalation after a concrete match.
- Watchlist for financial instruments with optional Twelve Data quotes/history.
- Integrations for Google Workspace, Gmail, Home Assistant, WhatsApp, and local tool execution.
- Managed updater based on GitHub Releases for native services and installer-managed Docker.
- Docker/Compose deployment for Linux with browser runtime included.

## Security Model

By default the app binds to `127.0.0.1`. Keep it that way unless it is behind a trusted access layer such as SSH tunneling, Tailscale, VPN, or a reverse proxy with authentication.

Do not expose Orchestrator directly to the public internet. The app has endpoints that can run agents, mutate local state, use local credentials, and execute local tools. Cross-origin mutating API requests are blocked, but that is not a substitute for authentication at the network edge.

All private `/api/*` routes are restricted to same-origin browser requests or
direct loopback calls. Direct API calls to a non-loopback host must include
`ORCHESTRATOR_API_TOKEN` as `Authorization: Bearer <token>` or
`X-Orchestrator-API-Token: <token>`. OAuth callbacks and internal tokenized
bridge endpoints are handled separately.

Inbound webhook routes under `POST /api/webhooks/:slug` are intentionally
cross-origin capable. They bypass the same-origin API guard and authenticate
with the per-webhook secret configured in Orchestrator.

When a caller needs both the private API token and an endpoint-specific bearer
secret, keep them in separate headers: use `X-Orchestrator-API-Token` for the
global API token and `Authorization: Bearer <webhook-secret>` or
`X-Orchestrator-Webhook-Secret` for the webhook secret.

## Requirements

- Node.js `22.x` for native/manual installs.
- npm `11.x` or compatible with Node 22.
- Git.
- Docker with Compose for container deployment.
- Optional API keys in `.env` / `.env.local`.

## One-Line Linux Install

On Linux, the installer uses Docker by default. It installs/verifies Docker and Compose, starts the Docker daemon where supported, clones or updates the repo under `~/orchestrator/`, sets up `~/.orchestrator/` for runtime data (bind-mounted into the container so files are owned by your host user and visible on the host filesystem), creates `.env` if missing, installs the local Docker update bridge, builds the image, and starts the stack detached.

```bash
curl -fsSL https://raw.githubusercontent.com/Horia73/orchestrator/master/scripts/install.sh | bash
```

Open:

```text
http://127.0.0.1:3000
```

### Public HTTPS With DuckDNS

For a personal Linux server, the installer can also configure a DuckDNS hostname,
DNS-based Let's Encrypt certificate, nginx reverse proxy, and the app's public
origin. This keeps every install tied to the user's own hostname; do not bake a
shared Orchestrator URL into the repo or image.

Prerequisites:

- A DuckDNS subdomain owned by the user, for example `my-orchestrator.duckdns.org`.
- The DuckDNS account token.
- Port `443` reachable from the user's browser to the server. Port `80` is only
  used for HTTP-to-HTTPS redirect when reachable.
- `sudo` on the server. The installer uses Docker for the app and host nginx for
  TLS termination.

Interactive setup:

```bash
curl -fsSL https://raw.githubusercontent.com/Horia73/orchestrator/master/scripts/install.sh | \
  ORCHESTRATOR_PUBLIC_HTTPS_SETUP=duckdns \
  bash
```

The installer asks for:

- DuckDNS domain, either `my-orchestrator` or `my-orchestrator.duckdns.org`.
- DuckDNS token.
- Optional Let's Encrypt email.

Non-interactive setup:

```bash
curl -fsSL https://raw.githubusercontent.com/Horia73/orchestrator/master/scripts/install.sh | \
  ORCHESTRATOR_PUBLIC_HTTPS_SETUP=duckdns \
  ORCHESTRATOR_DUCKDNS_DOMAIN=my-orchestrator \
  ORCHESTRATOR_DUCKDNS_TOKEN='paste-duckdns-token-here' \
  ORCHESTRATOR_LETSENCRYPT_EMAIL='me@example.com' \
  bash
```

This mode:

- sets `ORCHESTRATOR_PUBLIC_URL=https://<domain>.duckdns.org`;
- sets `ORCHESTRATOR_SSH_HOST=<domain>.duckdns.org`;
- updates the DuckDNS record immediately and installs a systemd user timer, or a
  cron fallback, to keep it current;
- installs nginx plus acme.sh;
- issues a Let's Encrypt certificate with DuckDNS DNS-01 validation;
- configures nginx on `80`/`443` to proxy Orchestrator to `127.0.0.1:3000` and
  browser live-view WebSockets to `/vnc/`;
- sets `BROWSER_AGENT_VNC_WS_PUBLIC_URL=wss://<domain>.duckdns.org/vnc`.

After install, open:

```text
https://<domain>.duckdns.org
```

Google OAuth setup is handled from Orchestrator's Settings UI. The important
installer responsibility is that `ORCHESTRATOR_PUBLIC_URL` is the user's real
HTTPS origin before the app starts, so Orchestrator reports the correct redirect
URIs.

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

- clones or updates the app under `~/orchestrator/`;
- installs Node 22 with `nvm` if needed;
- installs Linux build/browser dependencies where possible;
- runs `npm ci`;
- installs the Patchright Chromium runtime;
- stores runtime workspace state under `~/.orchestrator/state` and links it into the checkout;
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
- `GOOGLE_MAPS_API_KEY`: optional Google Maps Platform key for Smart Maps, geocoding, places, routes, Google Weather, Google Air Quality, and Google Pollen. Weather/pollen can fall back through keyless Open-Meteo if a Google environmental API is not enabled.
- `GOOGLE_MAPS_MAP_ID`: recommended JavaScript Vector Map ID with Tilt and Rotation enabled for production Smart Maps tilt/heading. Earth-like 3D uses Google Maps JavaScript 3D Maps beta where coverage exists.
- `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET`: Google Workspace and Gmail OAuth.
- `HOME_ASSISTANT_URL` / `HOME_ASSISTANT_TOKEN`: Home Assistant integration.
- `WHATSAPP_CHROME_EXECUTABLE_PATH`: browser executable override for WhatsApp.
- `WHATSAPP_USER_AGENT`: optional WhatsApp Web browser user-agent override.
- `BROWSER_AGENT_LIVE_VIEW`: enables live browser view on Linux/Docker.
- `BROWSER_AGENT_BACKEND`: optional browser-agent backend override. Leave empty to use the Settings default (`Auto`); set `patchright`, `official-display`, or `auto` only when a deployment should ignore the saved UI setting.

For native installs, runtime workspace state is stored at `~/.orchestrator/state` and exposed to the app through `~/orchestrator/.orchestrator` (a symlink). For Docker installs, persistent app data lives directly at `~/.orchestrator/` on the host (bind-mounted into the container at `/app/.orchestrator`), and the container cache lives at `~/.orchestrator-node-home/` (bind-mounted at `/home/node`). Both paths are owned by your host user (`ORCHESTRATOR_UID`/`ORCHESTRATOR_GID` in `.env`), so backups are a simple `cp -a ~/.orchestrator/ <dest>`.

## Browser Agent Live View

The browser agent backend is controlled from Settings > Models > Browser Agent. `Auto` selects Patchright on macOS and official Chromium display on Linux/Docker when Chromium, Xvnc/TigerVNC, xdotool, xclip, and ImageMagick are available; otherwise it falls back to Patchright. Set `BROWSER_AGENT_BACKEND=patchright` or `BROWSER_AGENT_BACKEND=official-display` only to force a backend from the deployment environment. The provided Docker image includes Chromium, TigerVNC, Openbox, xdotool, xclip, ImageMagick, ffmpeg, and noVNC client dependencies.

Default Docker live-view settings:

```text
ORCHESTRATOR_PUBLIC_URL=
BROWSER_AGENT_LIVE_VIEW=1
BROWSER_AGENT_BACKEND=
BROWSER_AGENT_PROFILE_MODE=isolated
BROWSER_AGENT_MAX_CONCURRENT=3
BROWSER_AGENT_ALLOW_NO_SANDBOX=1
BROWSER_AGENT_VNC_WS_HOST=0.0.0.0
BROWSER_AGENT_VNC_WS_PORT=6080
BROWSER_AGENT_VNC_WS_PUBLIC_URL=ws://127.0.0.1:6080
```

For the Linux official-display backend, `isolated` creates a fresh profile per
session, `clone-base` copies `BROWSER_AGENT_BASE_PROFILE_DIR` into each session
profile, and `shared-serial` reuses one profile but forces browser-agent runs to
one at a time. In Docker, Chromium may require `BROWSER_AGENT_ALLOW_NO_SANDBOX=1`;
run that container on an isolated host boundary. The `BROWSER_AGENT_DISPLAY_STABILITY_*`
settings tune screenshot-diff settling after OS-input actions.

Linux smoke tests:

```bash
BROWSER_AGENT_ALLOW_NO_SANDBOX=1 npm run smoke:official-display
BROWSER_AGENT_ALLOW_NO_SANDBOX=1 npm run smoke:official-display-agent
```

Leave `ORCHESTRATOR_PUBLIC_URL` empty for local installs or when a trusted
reverse proxy sends correct canonical `Host` / `X-Forwarded-*` headers. Do not
forward arbitrary client-supplied `Host` values as a loopback host. Set it when
the app must advertise one canonical URL, especially for public HTTPS installs:

```text
ORCHESTRATOR_PUBLIC_URL=https://<your-domain>.duckdns.org
```

Google OAuth is stricter than normal app routing: Authorized redirect URIs must
be either `localhost` for a local/SSH-tunnel setup, or an HTTPS URL on a real
public domain. Names such as `.lan`, `.local`, and private IPs are fine for
opening Orchestrator, but Google rejects them as OAuth redirect URIs. When the
app URL is not Google-compatible, Orchestrator falls back to
`http://localhost:3000/...` for OAuth.

For DuckDNS public HTTPS installs, prefer the installer flow in
**Public HTTPS With DuckDNS**. It writes `ORCHESTRATOR_PUBLIC_URL`, configures
DuckDNS updates, issues the certificate, and installs nginx.

For headless Linux where the browser is on another machine, keep the app
reachable through the LAN name/IP for normal use, but do Google OAuth through a
local tunnel:

```bash
ssh -N -L 3000:127.0.0.1:3000 user@your-server.lan
```

Then open `http://localhost:3000/settings`, run Connect, wait until the
integration card says Connected, and stop the tunnel with `Ctrl+C`. If the LAN
IP changes, prefer a stable LAN DNS name or a private network name; the app also
reports current SSH host candidates in the integration status payload.

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

## Diagnostics and Uninstall

The installer ships `scripts/doctor.sh`, also exposed as `orchestrator doctor`.
Use it to validate a host before installing, to inspect leftover state after a
previous installation, to verify the running system, or to remove the install
cleanly.

```bash
orchestrator doctor            # full health check (preflight + state + runtime)
orchestrator doctor preflight  # read-only pre-install checks
orchestrator doctor inspect    # inventory of previous-install artifacts
orchestrator doctor fix        # apply suggested fixes for the last check
orchestrator uninstall         # remove install, keep data/logs and Docker volumes
orchestrator uninstall --purge # also wipe ~/.orchestrator and Orchestrator Docker volumes/image
```

`uninstall` does not remove shared system dependencies such as Docker, Node.js,
nginx, or acme.sh itself. `--purge` removes data owned by Orchestrator, including
managed native state and Docker named volumes created by the Compose stack.

Every install run writes a full log to `~/.orchestrator/logs/install-<timestamp>.log`.
Every doctor run writes its own log to `~/.orchestrator/logs/doctor/run-<timestamp>.log`.
If the installer fails, the trailing message points at both the log file and the
doctor command for follow-up.

Exit codes follow:

- `0` healthy / clean / done
- `1` hard failure (blocker)
- `2` warnings only — non-blocking
- `3` stale state from a previous install was found (`inspect` only)

The installer calls `doctor preflight` and `doctor inspect` automatically right
after the checkout step. When stale state is detected on an interactive run the
installer offers `keep` (reuse what is valid), `reset` (uninstall first, then
install fresh), or `abort`. Set `ORCHESTRATOR_SKIP_DOCTOR=1` to bypass these
checks entirely.

## Development

```bash
npm ci
npm run browsers:install
npm run dev
```

Quality checks:

```bash
npm run typecheck
npm run smoke:monitor
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
npm run smoke:monitor
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
