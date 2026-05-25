# Agent Index

This file is a compact map for agents. It points to canonical code and runtime data without loading logs or history into the prompt.

## Runtime Data

- SQLite database: `.orchestrator/data.db`
- Scheduling Past runs table: `scheduled_task_runs`
- Agent/model request logs table: `request_logs`
- Tool-call logs table: `tool_logs`
- Compact run index: `.orchestrator/index/runs/YYYY-MM-DD.jsonl`
- Compact agent-log index: `.orchestrator/index/logs/YYYY-MM-DD.jsonl`

Use tools first:

- `search_past_runs` and `get_past_run` for scheduled task and Smart Monitor wake history.
- `search_agent_logs` and `get_agent_log` for orchestrator/sub-agent request history and errors.
- `read_runtime_index` for index status, recent JSONL entries, and this code map.

## Scheduling

- Runtime execution: `lib/scheduling/run.ts`
- Store and Past runs: `lib/scheduling/store.ts`
- Schema: `lib/scheduling/schema.ts`
- Next-run computation: `lib/scheduling/compute.ts`
- Agent-facing tools: `lib/ai/tools/schedule.ts`
- UI: `components/scheduling/scheduling-view.tsx` and `components/scheduling/run-history.tsx`
- API: `app/api/scheduled-tasks/*`
- Doctrine: `lib/integrations/doctrines/scheduling.ts`

## Smart Monitor

- Agent wake prompt and monitor orchestration: `lib/monitoring/smart-monitor.ts`
- System task adapter: `lib/monitoring/smart-monitor-adapter.ts`
- Watch CRUD tools: `lib/ai/tools/smart-monitor-manage.ts`
- Wake feedback tool: `lib/ai/tools/smart-monitor-feedback.ts`
- Watch store: `lib/monitor/store.ts`
- Rule schema: `lib/monitor/schema.ts`
- Rule evaluation: `lib/monitor/rules.ts`
- Source adapters: `lib/monitor/sources/*`
- UI: `components/monitor/*`
- Doctrine: `lib/integrations/doctrines/monitoring.ts`

## Microscripts

- Runtime schema/store/runner/heartbeat: `lib/microscripts/*`
- Agent tools: `lib/ai/tools/microscripts.ts`
- Monitor-page API/UI: `app/api/monitor/microscripts/*`, `components/monitor/*`
- Doctrine and docs: `lib/integrations/doctrines/microscripts.ts`, `MICROSCRIPTS.md`
- `agent_wake` permission plus `agent.wake` operation let deterministic scripts escalate to a restricted text-agent wake after a concrete match.

## Webhooks

- Inbound webhook schema/store/auth/dispatch: `lib/webhooks/*`
- Public ingress and management APIs: `app/api/webhooks/*`
- Microscript webhook trigger context: `lib/microscripts/runner.ts`
- Docs: `WEBHOOKS.md`

## Logs And Observability

- Request/tool logging store: `lib/observability/store.ts`
- Log schemas: `lib/observability/schema.ts`
- Logs API: `app/api/logs/*`
- Usage API/store: `app/api/usage/*`, `lib/observability/store.ts`
- Runtime JSONL index writer: `lib/runtime-index.ts`
- Agent-facing history tools: `lib/ai/tools/observability.ts`
- Backfill script: `scripts/build-runtime-index.ts`

## Tool Surface

- Tool definitions registry: `lib/ai/tools/registry.ts`
- Tool executor dispatch: `lib/ai/tools/executor.ts`
- Built-in tool groups: `lib/ai/agents/builtins.ts`
- Orchestrator config: `lib/ai/agents/orchestrator.ts`
- Prompt assembly: `lib/ai/prompts/*`
- Integration/subsystem exposure: `lib/integrations/exposure.ts`

## Self Development

- Policy prompt: `lib/ai/prompts/orchestrator/self-development.ts`
- Generic external/new project prepare helper: `npm run project-run:prepare -- --kind existing-git|new --task "..." --json`
- Generic run helper for status/commit/rebase/push/update/cleanup: `npm run project-run:run -- <command> --run-id <id>`
- Generic project workflow docs: `docs/project-run-workflow.md`
- Prepare isolated worktree + port + coder handoff: `npm run self-dev:prepare -- --task "..." --json`
- Prepare script: `scripts/self-dev-prepare.mjs`
- Explicit run helper for status/commit/rebase/push/update/cleanup: `npm run self-dev:run -- <command> --run-id <id>`
- Run helper script: `scripts/self-dev-run.mjs`
- Delegate to coder with `cwd` set to the prepared `repoDir`
- Workflow docs: `docs/self-dev-workflow.md`
- Managed update/restart confirmation: `lib/update/manager.ts`, `instrumentation.ts`, `scripts/update-runner.mjs`, `scripts/docker-update-bridge.py`

## Frontend

- App routes: `app/*`
- Main chat/inbox UI: `components/chat-view.tsx`, `components/message-bubble.tsx`, `components/inbox/*`
- Scheduling UI: `components/scheduling/*`
- Monitoring UI: `components/monitor/*`
- Settings/auth/logs UI: `components/settings/*`

## Verification

- Typecheck: `npm run typecheck`
- Lint: `npm run lint`
- Smart Monitor smoke tests: `npm run smoke:monitor`
- Runtime history smoke test: `npm run smoke:observability`
- Rebuild local JSONL runtime index from SQLite: `npm run index:runtime`
