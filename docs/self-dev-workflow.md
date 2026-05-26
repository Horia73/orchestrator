# Self Dev Workflow

This workflow lets Orchestrator edit its own source without touching the live checkout.

## Prepare

Run from the live repo:

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
- creates a git worktree under `.orchestrator/project-runs/<run-id>/repo`;
- creates an `agent/<run-id>` branch;
- reserves a dev port from `3101-3199`;
- writes `SELF_DEV_INSTRUCTIONS.md` inside the worktree;
- writes run metadata under `.orchestrator/project-runs/<run-id>/run-state.json`;
- prints a coder handoff prompt.

Use `--copy-env` only when a local dev run genuinely needs env values. The copied `.env` / `.env.local` files stay ignored by git.

You can inspect a prepared run without entering the worktree:

```bash
npm run self-dev:run -- status --run-id <run-id>
```

## Delegate

Send the generated coder prompt to the coder agent. Coder owns implementation and testing, but must:

- work only inside the isolated worktree;
- not edit the live checkout;
- check git branch/status before editing;
- not commit or push;
- not use port `3000`;
- not run `npm run dev` for this repo;
- use the assigned port for any dev server;
- stop any dev server before returning.

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

Use `--force` only when deliberately discarding an uncommitted worktree.
