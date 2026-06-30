# Project Run Workflow

This workflow lets Orchestrator work on external repositories or new projects without touching the user's live checkout.

## Existing Git Repository

Prepare an isolated clone:

```bash
npm run project-run:prepare -- --kind existing-git --source "<git-url-or-local-path>" --task "Describe the change" --json
```

For a local path, the helper uses the source repo's `origin` remote when available and falls back to a local clone if the remote clone fails. Uncommitted changes in the local source checkout are not included unless they were committed before preparation.

Before preparing from a local checkout, inspect branch/status and fetch remote refs when available:

```bash
git status --short
git branch --show-current
git fetch origin --prune
git status -sb
```

Do not pull, rebase, reset, stash, or discard local work unless the user explicitly asked for that operation.

Useful options:

```bash
--base-branch main
--branch agent/<name>
--copy-env
--test-command "npm test"
--build-command "npm run build"
--push-policy agent-branch
--deploy-target vercel
```

## New Project

Prepare an isolated empty git repo:

```bash
npm run project-run:prepare -- --kind new --name "site-name" --task "Build a static web app" --json
```

If Orchestrator wants to run a scaffold before delegating:

```bash
npm run project-run:prepare -- --kind new --name "site-name" \
  --task "Build a static web app" \
  --scaffold-command "npm create vite@latest {repoDir} -- --template react-ts"
```

The placeholders `{repoDir}`, `{runDir}`, and `{name}` are replaced by the helper. Without a scaffold command, coder creates the project inside the prepared repo.

## Delegate

Send the generated `coderPrompt` to coder and pass `repoDir` as `cwd`:

```json
{
  "agent_id": "coder",
  "prompt": "<coderPrompt from run-state.json>",
  "thread_title": "Project run: <short task>",
  "cwd": "<repoDir from run-state.json>"
}
```

Coder owns implementation and testing, but does not commit or push unless the orchestrator explicitly says so.

## Default Web App Path

Standalone project runs do not get a managed `/dev-preview` by default. For generated sites/apps that the user should keep, the normal path is: build/test in the isolated repo, publish static assets into the Orchestrator workspace, then return the stable `/published-apps/<slug>/` LAN URL and the Tailscale Funnel URL when the host bridge can create one. Do not return raw `localhost` URLs and do not put interactive apps under `files/`.

The app must honour `PUBLISHED_BASE_PATH=/published-apps/<slug>` when it builds so root-absolute assets and client routes resolve from the published subpath.

## Durable Static Publish

For static web apps/sites/games/dashboards, publish the verified build through Orchestrator:

```bash
npm run project-run:run -- publish-static --run-id <run-id> --slug <stable-app-slug> --json
```

The command runs the build with `PUBLISHED_BASE_PATH=/published-apps/<slug>`, detects `dist/`, `out/`, or `build/`, copies it into the active profile workspace at `published-apps/<slug>/`, returns stable public/LAN URLs served by Orchestrator at `/published-apps/<slug>/`, and by default asks the host bridge to create a Tailscale Funnel scoped only to `/published-apps/<slug>`. The JSON result includes `tailscaleFunnelUrl` when that succeeds, or `tailscaleFunnel.status`/`error` when the bridge or Tailscale is unavailable. The files live in the mounted workspace, so they persist and are served again when the Orchestrator container restarts.

Published static apps run with script execution but without Orchestrator API/network permissions; if they need fetch/XHR/WebSocket, a backend, SSR, secrets, cron, custom Docker/nginx, or an external host, use an explicit deploy target instead.

Do not publish interactive apps under `files/`: `/files` is for documents/downloads and intentionally blocks scripts. Use host nginx/vhost/Docker/Vercel deployment only when the app has backend/SSR/custom-service requirements and the user has explicitly approved that deployment policy.

## Optional Diagnostic Preview

`/dev-preview/<run-id>/` is normally for Orchestrator self-development. For a standalone project, use it only when an operator explicitly asks for a temporary diagnostic preview. Prepare the run with preview metadata:

```bash
npm run project-run:prepare -- --kind new --name "site-name" --task "..." --managed-preview --json
npm run project-run:run -- start --run-id <run-id> --health-path /
npm run project-run:run -- preview --run-id <run-id> --json
```

The preview binds to `127.0.0.1:<assigned-port>` and serves under `/dev-preview/<run-id>/`, so a previewable app must honour `PREVIEW_BASE_PATH`. This is not a durable result and should not replace `publish-static`.

## Gate And Publish

Orchestrator owns the final gate:

```bash
npm run project-run:run -- status --run-id <run-id>
cd .orchestrator/project-runs/<run-id>/repo
git diff
```

Run the checks appropriate to the project. If the gate passes:

```bash
npm run project-run:run -- commit --run-id <run-id> --message "<message>"
npm run project-run:run -- rebase --run-id <run-id> --base origin/main
npm run project-run:run -- push --run-id <run-id> --target-branch agent/<run-id>
```

Default for external projects is an agent branch. Direct pushes to `main`/`master`, production deploys, paid services, and account changes require a clear project policy or explicit user instruction.

## Cleanup

After the work is no longer needed locally:

```bash
npm run project-run:run -- cleanup --run-id <run-id> --delete-branch
```

Use `--force` only when deliberately discarding an uncommitted worktree.
