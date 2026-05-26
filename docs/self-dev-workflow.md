# Self Dev Workflow

This workflow lets Orchestrator edit its own source without touching the live checkout.

## Prepare

Run from the live repo, or from the running app directory when
`ORCHESTRATOR_SELF_DEV_SOURCE_DIR` points at the source checkout:

```bash
git status --short
git branch --show-current
git fetch origin --prune
git status -sb
npm run self-dev:prepare -- --task "Describe the change" --json
```

Use this preflight to see whether the live checkout is dirty, behind, ahead, or diverged before creating the isolated worktree. Do not pull, rebase, reset, stash, or discard local work unless the user explicitly asked for that operation.

The script:

- fetches the default branch from origin;
- creates a git worktree under the running app state's `.orchestrator/project-runs/<run-id>/repo`;
- creates an `agent/<run-id>` branch;
- reserves a dev port from `3101-3199`;
- prepares a managed preview URL under `/dev-preview/<run-id>/`;
- writes `SELF_DEV_INSTRUCTIONS.md` inside the worktree;
- writes run metadata under `.orchestrator/project-runs/<run-id>/run-state.json`;
- prints a coder handoff prompt.

In Docker installs, `/app` is a built image copy and normally has no `.git`
metadata. The compose stack mounts the host checkout at `/orchestrator-source`
and sets `ORCHESTRATOR_SELF_DEV_SOURCE_DIR=/orchestrator-source`, so the helper
uses that git checkout while keeping run state under `/app/.orchestrator`. For
manual or unusual layouts, pass `--source-dir <git-checkout>`. The helper also
checks `/orchestrator-source` directly, so self-development still works when the
mount exists but the environment variable is missing.

Use `--copy-env` only when a local dev run genuinely needs env values. The copied `.env` / `.env.local` files stay ignored by git.

You can inspect a prepared run without entering the worktree:

```bash
npm run self-dev:run -- status --run-id <run-id>
```

Start the managed preview before delegating implementation:

```bash
npm run self-dev:run -- start --run-id <run-id> --health-path /
npm run self-dev:run -- preview --run-id <run-id>
```

The preview helper:

- starts `next dev` as a detached process, not inside the coder/tool session;
- binds only to `127.0.0.1:<assigned-port>`;
- exposes it through the live app at `/dev-preview/<run-id>/`;
- waits for HTTP `200` on the configured health path instead of accepting `404` or other non-500 responses;
- writes logs to `.orchestrator/project-runs/<run-id>/preview.log`;
- runs with `ORCHESTRATOR_PREVIEW=1` and explicit `ORCHESTRATOR_DISABLE_*` background flags, so schedulers, Smart Monitor, microscripts, and update confirmation are not armed;
- runs with `ORCHESTRATOR_STATE_DIR=<run-dir>/preview-state`, a snapshot of live `data.db`, `workspace`, and `uploads`. Private browser/WhatsApp/integration state is not copied.

Use these helpers for lifecycle:

```bash
npm run self-dev:run -- restart --run-id <run-id>
npm run self-dev:run -- logs --run-id <run-id> --lines 200
npm run self-dev:run -- stop --run-id <run-id>
```

Use `start --refresh-state` or `restart --refresh-state` when you deliberately want to replace the preview snapshot with current live state.

Use `seed` when the worktree needs config that is not yet present in the live snapshot. The seed changes only the preview snapshot:

```bash
npm run self-dev:run -- seed --run-id <run-id> --profile location-intelligence --entity-id person.horia --label Horia
npm run self-dev:run -- restart --run-id <run-id> --health-path /maps
```

For one-off config changes, pass `--config-json '{"smartMonitor":{...}}'` or `--config-patch <json-file-or-inline-json>`.

## Delegate

Send the generated coder prompt to the coder agent. Coder owns implementation and testing, but must:

- work only inside the isolated worktree;
- not edit the live checkout;
- check git branch/status before editing;
- not commit or push;
- not use port `3000`;
- not run `npm run dev`, `next dev`, or any other dev server for this repo;
- use the managed preview URL that Orchestrator started;
- restart only the managed preview helper if the preview is down;
- leave the preview running for user review.

When delegating, pass the prepared repo as the working directory:

```json
{
  "agent_id": "coder",
  "prompt": "<coderPrompt from run-state.json>",
  "thread_title": "Self-dev: <short task>",
  "cwd": "<repoDir from run-state.json>"
}
```

## Gate

After coder returns, Orchestrator owns the final gate:

```bash
cd .orchestrator/project-runs/<run-id>/repo
git status --short
git diff
npm run typecheck
npm run build
```

Run targeted smoke tests for touched subsystems. If checks fail because of unrelated pre-existing errors, record that explicitly and verify the changed area narrowly.

If the investigation shows that the requested behavior is not implemented yet, Orchestrator should propose the smallest coherent codebase change and ask for confirmation before starting a self-development run, unless the user already explicitly asked for implementation.

## Commit And Push

If the gate passes:

Stop the preview after the user has approved the visible result and before push/update cleanup:

```bash
npm run self-dev:run -- stop --run-id <run-id>
```

```bash
npm run self-dev:run -- commit --run-id <run-id> --message "<message>"
npm run self-dev:run -- rebase --run-id <run-id> --base origin/master
npm run self-dev:run -- push --run-id <run-id> --target-branch master
```

If rebase or push conflicts, stop and report exact files/status.

## Self Update

After pushing to `master`, trigger a branch update:

```bash
npm run self-dev:run -- update --run-id <run-id> --branch master
```

The managed updater rebuilds/restarts the app. On boot, Orchestrator confirms the running commit and posts the result to Inbox.

After the update result is confirmed and no more inspection is needed:

```bash
npm run self-dev:run -- cleanup --run-id <run-id> --delete-branch
```

`cleanup` also stops any still-running managed preview for the run.

Use `--force` only when deliberately discarding an uncommitted worktree.
