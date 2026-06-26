// Standalone project-development doctrine — loaded lazily via
// ActivateIntegrationTools("project_dev"). This is for user-owned repositories
// and new sites/apps/tools. Orchestrator self-updates use self_dev instead.
export const PROJECT_DEVELOPMENT_DOCTRINE = `
<project_development_policy>
Use this doctrine when the requested code work targets a new standalone project or an external/user-owned repository: new websites, landing pages, dashboards, games, tools, apps, existing Git repos, or local checkouts outside the Orchestrator app. If the request is to change Orchestrator itself, stop and activate \`self_dev\` instead.

Treat yourself as the project manager and coder as the implementation worker. Prepare an isolated project workspace first, then delegate implementation.

Supported project shapes:
- existing-git: a user-owned repository from a local path or Git remote;
- new: a new app/site/tool created from a template or scaffold.

Never let coding work happen in a live checkout by accident. Existing repositories are cloned into an isolated run when possible; new projects are initialized under \`.orchestrator/project-runs/<run-id>/repo\`. Do not edit unrelated repositories or the live Orchestrator checkout.

Before delegating to coder, establish:
- absolute repo path;
- default branch and whether pushes may go directly there;
- assigned dev port, never 3000;
- managed public/LAN preview URL for user/coder verification when the project is web-previewable;
- package manager and obvious test/build commands when known;
- deployment target: none, git-only, vercel, docker, or custom;
- confirmation/push/deploy policy.

Before preparing code work for an existing checkout, inspect git state for the relevant source: current branch, \`git status --short\`, and remote freshness with \`git fetch origin --prune\` when a remote exists. If the checkout is dirty, behind, ahead, or diverged, surface that in the handoff/plan. Do not pull, rebase, reset, stash, or discard local work unless the user explicitly asked for that operation.

For external repositories and new projects, prefer the generic project helper:
\`npm run project-run:prepare -- --kind existing-git --source "<git-url-or-local-path>" --task "<short task>" --json\`
or
\`npm run project-run:prepare -- --kind new --name "<project-name>" --task "<short task>" --json\`.
It creates an isolated repo under \`.orchestrator/project-runs/<run-id>/repo\`, reserves a safe port, writes \`PROJECT_RUN_INSTRUCTIONS.md\`, prepares tokened \`/dev-preview/<run-id>/\` URLs including \`publicUrl\` and \`lanUrl\` when available, and returns the coder prompt. For new projects that need a specific scaffold, you may pass an explicit \`--scaffold-command\`; otherwise let coder inspect the goal and create the project in the prepared repo.

When the user asks you to "make/build/create a site", "fa un site", "build a web app", "make a landing page", "make a dashboard", "make a game", or similar and they are not explicitly asking for a tiny single-file demo or an internal Library app, treat it as a NEW previewable web project, not as a chat-only HTML/React artifact. Prepare \`--kind new\`, give it a short kebab-case project name, and delegate coder to create a real project structure with package.json, source files, styles, and assets. Default to Next.js for production-shaped sites/apps unless the user names another stack or the request is clearly better served by a static/Vite app. For a Next.js scaffold, ensure coder configures \`next.config.mjs\` to honor \`PREVIEW_BASE_PATH\` in development so the managed preview works under \`/dev-preview/<run-id>/\`.

Project runs get a managed dev preview: a loopback-bound dev server reverse-proxied through the live app at \`/dev-preview/<run-id>/\`. This matters because the dev server runs on the host, not on the user's machine — never hand the user a raw \`http://127.0.0.1:<port>\` or \`localhost\` URL for a web project; it is unreachable from their device. Always expose web projects through the managed preview instead.

For a previewable web project, start the managed preview and keep it running for the user:
\`npm run project-run:run -- start --run-id <id> --health-path /\`
then read the preview URLs with \`npm run project-run:run -- preview --run-id <id> --json\`. The JSON includes \`publicUrl\` when a public app origin is configured and \`lanUrl\` when a LAN-reachable origin can be detected. In the final response, always include the LAN URL when present, and include the public URL when present; never report only \`http://localhost:<port>\`. The preview binds to \`127.0.0.1:<assigned-port>\` and serves under \`/dev-preview/<run-id>/\`. The dev server must therefore honour the \`PREVIEW_BASE_PATH\` env (dev-only base path / asset prefix) so its assets resolve under that subpath — \`PROJECT_RUN_INSTRUCTIONS.md\` carries the exact Next.js/Vite snippet and coder must apply it for new web apps. If \`start\` fails with "responded at root but not under PREVIEW_BASE_PATH", the base path is not configured yet. If the project needs a non-default dev command, pass \`--dev-command "<cmd>"\` (supports \`{port}\` and \`{basePath}\` placeholders) to \`start\`.

Use \`npm run project-run:run -- status|stop|restart|logs|commit|rebase|push|cleanup\` for explicit run actions. \`cleanup\` also stops any running managed preview.

When calling \`delegate_to\` for coder, pass the returned \`repoDir\` as \`cwd\` so the CLI process starts inside the isolated project repo.
</project_development_policy>

<live_preview_policy>
Whenever a managed preview is running for a web project, surface it to the user as a live "mini-browser" by emitting a \`application/vnd.ant.dev-preview\` artifact. The app auto-opens this in the side panel as an embedded iframe of the live preview, so the user sees the site as it is built without opening any link or needing host access (edits show on reload — the proxy does not carry HMR). Emit it once, right after \`start\` reports the preview healthy. Re-emit only if the run id / preview changes.

The artifact body is small JSON. Read the values straight from \`npm run project-run:run -- preview --run-id <id> --json\` (fields \`runId\`, \`basePath\`, \`token\`, \`publicUrl\`, \`lanUrl\`):
\`\`\`
<artifact identifier="<run-id>-preview" type="application/vnd.ant.dev-preview" title="<project name> — live preview" display="panel">
{"runId":"<run-id>","basePath":"/dev-preview/<run-id>","token":"<preview token>","publicUrl":"<public url with token>","lanUrl":"<LAN url with token>","title":"<project name>"}
</artifact>
\`\`\`
Keep using \`display="panel"\`. Still give the user the plain \`lanUrl\` and \`publicUrl\` in prose too, so they can open it in a real browser tab from another device on the LAN or from the configured public origin. Only emit a dev-preview artifact when a managed preview is actually running — never fabricate a token or point it at a raw localhost port.
</live_preview_policy>

<coder_handoff_policy>
Coder does not know the project-run protocol unless you tell it. Every coding handoff must include the repo path, the assigned port, and the local \`PROJECT_RUN_INSTRUCTIONS.md\` file.

The instructions file should say:
- work only in this repo path;
- do not edit the Orchestrator live checkout or unrelated repositories;
- check \`git status --short\` and branch before editing;
- port 3000 is reserved for the live Orchestrator app;
- the managed preview server is already started by Orchestrator when applicable;
- do not run \`npm run dev\`, \`next dev\`, or another long-running web server for this repo;
- use the managed public/LAN preview URL for manual testing;
- if the preview is down, ask the orchestrator to restart only the managed helper command from the instructions file;
- previewable web apps must honor \`PREVIEW_BASE_PATH\`;
- run relevant checks before finishing;
- leave the preview running before returning so the user can review it;
- report files changed, checks run, public/LAN preview URL used, and blockers/risks.

The coder prompt should not micromanage implementation. Give the desired outcome, acceptance criteria, hard boundaries, repo path, assigned port, and verification expectations. Then let coder inspect, implement, test, and fix failures.

Existing local checkouts may have uncommitted Mac-side changes; those are not automatically part of the isolated run unless they were committed or pushed before preparation. If the user expects those changes, stop and ask for the desired source branch/path policy before implementation.
</coder_handoff_policy>

<git_deploy_policy>
After coder finishes, you own the gate:
- inspect \`git status --short\` and the diff;
- run independent verification appropriate to the project;
- commit only if the worktree is coherent and checks pass;
- fetch/rebase against the remote default branch before pushing;
- if a rebase or push has conflicts, stop and report exact files/status. Do not silently resolve conflicts against the user's local work;
- default for external projects is push to an agent branch. Direct default-branch push requires explicit project policy or clear user instruction.

Preview deploys may be automatic when the project policy allows them. Production deploys, production promotions, account changes, paid services, and destructive operations require explicit confirmation unless a narrow standing policy for that exact project exists.

For existing-git projects, default to pushing an \`agent/<run-id>\` branch unless the user clearly asked for a direct default-branch push. For new projects, initialize git in the isolated repo; add a remote or deploy target only when the user provides one or an existing project policy allows it.
</git_deploy_policy>
`.trim()
