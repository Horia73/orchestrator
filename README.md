# Orchestrator

Self-hosted Gemini workspace for multi-agent chat, coding, research, browser automation, MCP tools, scheduling, and local persistence.


## Quickstart

On a clean machine, use one shell command to clone, install, and start onboarding:

```bash
git clone https://github.com/Horia73/orchestrator.git && cd orchestrator && npm install && npm run setup
```

What `npm run setup` does:

- asks for your Gemini API key and preferred port
- installs Patchright Chromium for the Browser Agent
- on Linux, installs the browser system dependencies Patchright needs and may prompt for `sudo`
- on Linux, also installs `ffmpeg`, `Xvfb`, and `x11vnc` so Browser Agent recordings and remote desktop work out of the box when the distro package manager is supported
- writes `~/.orchestrator/config.json`
- creates `~/.orchestrator/BOOT.md` for first-chat identity onboarding
- creates the runtime data directories under `~/.orchestrator/data`
- builds the frontend for production
- starts the app in the background so your terminal is free when onboarding finishes

After setup, open:

```text
http://localhost:8787
```

If you chose another port during onboarding, use that port instead.

## Runtime Commands

These commands are the intended production lifecycle:

| Command | What it does |
| --- | --- |
| `npm start` | Starts Orchestrator in the background. If the frontend build is missing, it builds it first. |
| `npm stop` | Stops the managed background process. |
| `npm restart` | Restarts the managed background process in the background. |
| `npm run status` | Shows config, URL, build status, PID, and log location. |
| `npm run setup` | Runs onboarding again, refreshes Browser Agent runtime dependencies, installs Linux Browser Agent extras when applicable, rebuilds production assets, and restarts the app in the background. |
| `npm run reset` | Stops the app, deletes `~/.orchestrator`, recreates runtime data/config/BOOT onboarding state, and restarts the app. |
| `npm run serve` | Runs the server in the foreground. Useful for debugging server startup directly. |
| `npm run dev` | Starts Vite and the API together for development. |
| `npm run build` | Builds the frontend into `dist/`. |

Production mode serves both the UI and API from the same port. In development, the UI runs on Vite (`5173`) and proxies `/api` to the backend (`8787` by default).

## Requirements

Required:

- Node.js `^20.19.0 || >=22.12.0`
- a valid Gemini API key

Optional but recommended:

- `git` if you want to use the in-app update flow
- `ffmpeg` if you want finalized Browser Agent MP4 recordings on non-Linux hosts
- `Xvfb` and `x11vnc` on Linux only if you are skipping setup-managed installation

`npm run setup` now installs Patchright Chromium automatically. On Linux it also installs `ffmpeg`, `Xvfb`, and `x11vnc` through supported distro package managers; if that install cannot be completed, setup stops instead of leaving Browser Agent partially configured.

## What The App Includes

### Agents

- `Orchestrator`: default general-purpose agent with tool access and routing logic
- `Coding Agent`: implementation, refactors, debugging, and code-oriented tasks
- `Researcher`: deep research with web tools, reports, and optional subagents
- `Multipurpose Agent`: broad tool access for more free-form multi-step work
- `Image Agent`: Gemini image generation and editing
- `Browser Agent`: live website interaction, authenticated flows, recordings, and remote control

### Product Features

- multi-chat workspace with server-side persistence
- live synchronization through SSE (`/api/events`)
- file uploads and attachment handling
- MCP server registry and tool discovery
- built-in and workspace skills
- editable config/memory files from the UI
- cron/scheduled jobs
- usage analytics and system log dashboards
- in-app update flow
- browser session inspection, live preview, and recording playback

## Architecture

Production runtime:

1. `vite build` outputs the UI to `dist/`
2. `server/index.js` serves the built SPA and all `/api/*` routes from the same Express server
3. background lifecycle state is tracked in `~/.orchestrator/data/runtime/app.json`

Development runtime:

1. `npm run dev:web` runs Vite on `5173`
2. `npm run dev:api` runs the Node API on `8787`
3. Vite proxies `/api` to the backend

Core pieces:

- `src/`: React 19 frontend
- `server/index.js`: Express API, SSE, chat orchestration, and production asset serving
- `server/agents/`: agent definitions and prompts
- `server/tools/`: filesystem, shell, web, agent, todo, and schedule tools
- `server/services/`: MCP, skills, browser agent, cron, model catalog, memory, and Gemini integration
- `server/storage/`: disk-backed persistence

## Persistence And File Layout

Orchestrator stores user data outside the repo so upgrades and rebuilds do not wipe runtime state.

| Path | Purpose |
| --- | --- |
| `~/.orchestrator/config.json` | Main app config written by onboarding |
| `~/.orchestrator/BOOT.md` | First-chat onboarding gate (removed automatically after completion) |
| `~/.orchestrator/models.json` | Local Gemini model catalog |
| `~/.orchestrator/data/chats` | Chat metadata and messages |
| `~/.orchestrator/data/uploads` | Uploaded attachments |
| `~/.orchestrator/data/logs/system.jsonl` | Structured application logs |
| `~/.orchestrator/data/logs/app.log` | Background process stdout/stderr log |
| `~/.orchestrator/data/usage` | Usage and pricing records |
| `~/.orchestrator/data/cron` | Scheduled jobs |
| `~/.orchestrator/data/memory` | Persistent memory files |
| `~/.orchestrator/data/skills` | User-installed workspace skills |
| `~/.orchestrator/data/runtime/app.json` | Managed background process state |

## Runtime File Tutorial

If you are new to Orchestrator internals, this is the minimum map:

### 1) `~/.orchestrator/config.json`

Main runtime config. Most important keys:

- `port`: API/UI port (default `8787`)
- `context.messages`: how many chat messages are kept in model context
- `agents`: per-agent model + thinking settings
- `ui`: display identity shown in UI (`aiName`, `userName`, `aiEmoji`, `aiVibe`)
- `cron`: scheduler switch
- `onboarding`: first-chat BOOT onboarding state machine

### 2) `~/.orchestrator/models.json`

Local model catalog used by Settings and pricing/metadata flows.
It is intentionally local so you can pin, annotate, and review model metadata without editing source code.

### 3) `~/.orchestrator/BOOT.md`

A first-run gate file. While this exists, chat is forced into onboarding mode:

1. asks AI name
2. asks user name
3. asks AI emoji
4. asks AI vibe

After those are answered, values are saved to `config.json` (`ui`) and `BOOT.md` is deleted automatically.

### 4) `~/.orchestrator/data/chats`

Persistent chat storage:

- `index.json`: chat list/index metadata
- `messages/*.jsonl`: one JSONL log per chat

### 5) `~/.orchestrator/data/logs` and `~/.orchestrator/data/usage`

- `logs/system.jsonl`: structured app/system logs
- `logs/app.log`: process stdout/stderr
- `usage/requests.jsonl`: request usage + cost snapshots

## Configuration

The runtime resolves config in this order:

1. shell environment variables
2. secret env store in `~/.orchestrator/data/secrets/SECRETS.env`
3. `~/.orchestrator/config.json`
4. project `.env*` files
5. built-in defaults

Common values:

| Variable | Purpose | Default |
| --- | --- | --- |
| `GEMINI_API_KEY` | Gemini API key | none |
| `API_PORT` | Production API/UI port | `8787` |
| `GEMINI_CONTEXT_MESSAGES` | History window size | `120` |
| `GEMINI_MODEL` | Default fallback model | `gemini-3-flash-preview` |
| `GEMINI_THINKING_LEVEL` | Default fallback thinking level | `MINIMAL` |

Agent-specific model and thinking overrides are configurable from the Settings UI and persisted in `~/.orchestrator/config.json`.

## First-Run And Day-2 Operations

### Fresh install

```bash
git clone https://github.com/Horia73/orchestrator.git && cd orchestrator && npm install && npm run setup
```

### Start the app later

```bash
npm start
```

This runs in the background and returns your terminal immediately.

### Restart after changes or after an update

```bash
npm restart
```

If you changed frontend code locally, rebuild first:

```bash
npm run build && npm restart
```

### Stop the background app

```bash
npm stop
```

### Inspect status

```bash
npm run status
```

## Development

Use this when you are actively changing the app:

```bash
npm run dev
```

That starts:

- Vite on `http://localhost:5173`
- the API on `http://localhost:8787`

Useful details:

- `npm run dev` frees occupied `8787` and `5173` before starting
- production mode does not use `vite preview`
- the background lifecycle is intended for production-like local usage, not hot reload

## Updates

The Settings UI includes an update panel that:

1. checks GitHub for newer releases/tags
2. runs `git pull`
3. runs `npm install`
4. rebuilds the frontend
5. restarts the background app

Manual equivalent:

```bash
git pull origin main && npm install && npm run build && npm restart
```

## Troubleshooting

If something feels off, start with:

```bash
npm run status
```

That tells you:

- whether the build exists
- whether the managed process is running
- which port is active
- where the background log file lives

To follow the background log:

```bash
tail -f ~/.orchestrator/data/logs/app.log
```

Common fixes:

- rerun `npm run setup` after changing API key or port
- run `npm run build && npm restart` after frontend changes
- use `npm run serve` if you want the server in the foreground for direct debugging

## Notes On Dependencies

The dependency set was trimmed to keep only the packages the app actually uses at runtime or build time. Two default Vite leftovers, `@types/react` and `@types/react-dom`, were removed because this repo is plain JavaScript, not TypeScript.

The `postinstall` script also normalizes executable permissions for `node-pty` prebuilds so background terminal sessions work reliably across supported environments.
