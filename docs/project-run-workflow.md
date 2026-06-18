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
--dev-command "npm run dev -- --host 127.0.0.1 --port 3101"
--test-command "npm test"
--build-command "npm run build"
--push-policy agent-branch
--deploy-target vercel
```

## New Project

Prepare an isolated empty git repo:

```bash
npm run project-run:prepare -- --kind new --name "site-name" --task "Build a Next.js site" --json
```

If Orchestrator wants to run a scaffold before delegating:

```bash
npm run project-run:prepare -- --kind new --name "site-name" \
  --task "Build a Next.js site" \
  --scaffold-command "npx create-next-app@latest {repoDir} --yes"
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

## Managed Preview

Project runs share the self-dev managed preview: a loopback-bound dev server reverse-proxied through the live app at `/dev-preview/<run-id>/`, so the user can open it from any device instead of an unreachable `127.0.0.1:<port>` on the host.

```bash
npm run project-run:run -- start --run-id <run-id> --health-path /
npm run project-run:run -- preview --run-id <run-id> --json
npm run project-run:run -- restart --run-id <run-id>
npm run project-run:run -- logs --run-id <run-id> --lines 200
npm run project-run:run -- stop --run-id <run-id>
```

The preview binds to `127.0.0.1:<assigned-port>` and serves under `/dev-preview/<run-id>/`, so a previewable web app must honour the `PREVIEW_BASE_PATH` env (dev-only `basePath`/`assetPrefix` for Next.js, `base` for Vite). `PROJECT_RUN_INSTRUCTIONS.md` carries the exact snippet. `start` sets `PREVIEW_BASE_PATH`, `HOST=127.0.0.1`, and `PORT`; pass `--dev-command "<cmd>"` (with `{port}` / `{basePath}` placeholders) when the framework needs a non-default command. If `start` reports the server responded at the root but not under `PREVIEW_BASE_PATH`, the base path is not configured yet.

To surface the preview to the user as a live mini-browser in the side panel, emit a `application/vnd.ant.dev-preview` artifact (`display="panel"`) built from the `preview … --json` output (`runId`, `basePath`, `token`, `publicUrl`). The chat auto-opens it.

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
