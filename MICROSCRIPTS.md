# Microscripts

Microscripts are bounded Python automations for small stateful watchers. They are meant for jobs that need a few cheap checks, tiny private state, and a clear stop condition.

They are not background daemons. A microscript runs, returns JSON, and exits. If it needs to keep watching, it returns `nextCheckAfterMs` or `nextRunAt`. Microscripts can also be triggered by inbound Webhooks after the webhook subsystem has authenticated, deduped, persisted, and normalized the event.

The default runtime is `trusted_python`: normal Python with stdlib imports, direct networking, and workspace-confined file access. The app still controls lifecycle, timeout, output size, state persistence, app-tool permissions, notifications, and audit logs.

## When To Use

Use Microscripts for:

- Watching one or a few concrete runtime conditions.
- Temporary automations that should stop after a success, expiry, or failure cap.
- Small state machines where a full agent wake every time would be wasteful.
- Checks that need a private watermark, counter, or debounce window.
- Cheap deterministic gates that should wake a model only after a concrete condition is met.

Use another subsystem for simple reminders, broad source triage, recurring work whose check itself requires model judgement, or normal one-off answers.

## Runtime Contract

Python code must define:

```python
def run(ctx):
    return {
        "summary": "optional short summary",
        "state": {},
        "requests": [],
        "nextCheckAfterMs": 300000,
        "status": "continue",
    }
```

`ctx` is dict-like and also exposes helper methods:

- `ctx.notify(body, title=None, actions=None)`
- `ctx.http_fetch(url, method="GET", headers=None, body=None, id="http_fetch")`
- `ctx.file_read(path)` and `ctx.file_write(path, content, append=False)`
- `ctx.call_tool(tool_id, arguments, id=None)`
- `ctx.continue_after(seconds=60)`, `ctx.complete()`, and `ctx.pause()`

Allowed statuses:

- `continue`: keep active and schedule another run.
- `pause`: stop running but keep the script and history.
- `complete`: mark done and disable future runs.

In `trusted_python`, the script may use normal Python libraries for local logic and direct HTTP/network checks. App-mediated actions such as Inbox notification, waking an agent, integration calls, and `ctx.call_tool` still go through the parent runtime and require manifest permissions.

Direct Python file access is confined to the script workspace. Relative paths are allowed; absolute paths and path traversal are blocked. Environment variables are sanitized, and app/user secrets are not passed to Python. Shell/process control is blocked by default.

## Trigger And Schedule Contract

Microscripts have two canonical schedule shapes:

- Webhook-only or manual-only: `"schedule": { "kind": "manual" }`
- Polling: `"schedule": { "kind": "interval", "every": "2m" }`

`manual` means there is no timed polling. It still allows manual runs and inbound webhook dispatch.

If a webhook event needs a later follow-up check, the script can return `nextCheckAfterMs` or `nextRunAt` from that webhook run. Otherwise it should process the event and exit.

## Agent Tool Contract

Microscript lifecycle tools reject unknown top-level arguments. Use the exact field names below; aliases such as `id`, `scriptId`, `dryRun`, `includeCode`, and `runId` are not accepted.

- `microscript_describe_capabilities`: `{}`
- `microscript_create`: `{ "title": string, "code": string, "manifest": object, "enabled"?: boolean, "initial_state"?: object }`
- `microscript_list`: `{ "enabled"?: boolean, "status"?: "active" | "running" | "paused" | "completed" | "expired" | "error" }`
- `microscript_get`: `{ "script_id": string, "include_code"?: boolean, "event_limit"?: number, "run_limit"?: number }`
- `microscript_update`: `{ "script_id": string, "title"?: string, "code"?: string, "manifest"?: object, "enabled"?: boolean, "state"?: object, "dry_run"?: boolean }`
- `microscript_pause`: `{ "script_id": string, "reason"?: string }`
- `microscript_resume`: `{ "script_id": string }`
- `microscript_delete`: `{ "script_id": string }`
- `microscript_run_now`: `{ "script_id": string, "dry_run"?: boolean, "test_context"?: object }`
- `microscript_get_run`: `{ "run_id": string }`

`microscript_run_now.test_context` is only valid with `dry_run=true` and may include:

```json
{
  "trigger": "manual",
  "now": "2026-06-06T12:00:00Z",
  "state": {},
  "webhook": {
    "eventId": "whe_test",
    "endpointId": "wh_test",
    "slug": "home-assistant",
    "source": "home_assistant",
    "eventType": "location.changed",
    "dedupeKey": "sample-1",
    "payload": {},
    "normalized": {}
  },
  "operation_results": {
    "request_id": { "ok": true, "data": {} }
  }
}
```

## Update And Dry-Run Semantics

Use `microscript_update` with `dry_run=true` before patching production scripts. It validates code and manifest, returns `changed`, `changed_fields`, and before/after hashes, and does not write `updatedAt`, `code_hash`, state, heartbeat, or events.

Effective no-op updates return `changed=false` and `write_performed=false`. They do not mutate `updatedAt`, `code_hash`, state, `nextRunAt`, or events.

`code_hash` changes only when stored code changes. The heartbeat/sync path should not rewrite `code_hash` or emit `updated` events after a validated update.

Use `microscript_run_now` with `dry_run=true` to evaluate deterministic state transitions with supplied `state`, `webhook`, and optional `operation_results`. Dry-run runs do not persist state/status/runs/events, post Inbox notifications, wake agents, call app tools/integrations, perform parent-mediated HTTP fetches, or write production script files. Direct Python networking is disabled, and direct Python file access uses a temporary workspace.

Recommended production update sequence for state-machine scripts such as location or gym gates:

1. `microscript_get` with `include_code=true`.
2. `microscript_update` with `dry_run=true`.
3. `microscript_run_now` with `dry_run=true` and representative `test_context` cases.
4. `microscript_update` without `dry_run` only when `changed_fields` are intended.
5. `microscript_get` to verify `code_hash` and recent events.
6. `microscript_run_now` without `dry_run` only when live side effects are intended and approved.

## Blocked Actions

When the runtime blocks an action, the error must include:

- What was blocked.
- Why it was blocked.
- A safe alternative.
- What implementation or permission change would be needed.

Agent behavior on a real blocker:

- Explain the blocker to the user in plain language.
- Use the safe alternative if it satisfies the task.
- If the task genuinely needs the blocked capability, ask the user to approve the manifest/runtime change.
- Record the missing capability in `AGENT_NEEDS.md` via `ReportAgentNeed` so it is not lost.

Default blocked surfaces:

- Shell/subprocess/process control, unless `trustedPython.allowShell=true`.
- Absolute/global filesystem access.
- Path traversal outside the script workspace.
- Reading app/user secrets from environment variables.
- Native memory/process escape modules such as `ctypes` and `subprocess` when shell is not approved.
- App tools outside the `tool_call` permission boundary.

## Stop Policy

Every production microscript needs a stop story.

Recommended defaults:

- One-shot alert: `stop.completeOnNotification=true`.
- Temporary watch: set `stop.expiresAt`.
- Finite check: set `limits.maxRuns`.
- Ongoing automation: set `stop.persistent=true`, keep narrow permissions, and keep failure caps.

If `persistent=false` and no `expiresAt` is set, creation applies a 24 hour default expiry.

## Permissions

Supported permission kinds:

- `notify_inbox`
- `agent_wake`
- `home_assistant_read`
- `home_assistant_call_service`
- `http_fetch`
- `tool_call`
- `files`

`trusted_python` direct networking and workspace files are available by default. Permissions are still required for parent-mediated app actions.

For broad app-tool access, use `tool_call` with exact `toolIds`, `toolPatterns`, or `allowIntegrationTools=true`. The runtime blocks host mutation tools such as shell, raw workspace edit tools, activation tools, and recursive microscript lifecycle calls from `ctx.call_tool`.

Home Assistant permissions support both narrow and broad modes:

- Reads can use `allowAll=true`, domains, or exact entity ids.
- Service calls can use `allowAll=true`, domains, or exact domain/service/entity boundaries.

`agent_wake` lets a script request an `agent.wake` operation after its deterministic gate passes. The permission lists allowed agent ids, maximum prompt size, and whether the woken agent may call `notify_inbox`. The woken agent receives the script prompt as context and a restricted tool surface; use this for "cheap check first, model judgement only on match" workflows.

## Example: Direct Python Network Watch

```json
{
  "description": "Notify once when a temporary web check recovers twice in a row.",
  "runtime": "trusted_python",
  "schedule": { "kind": "interval", "every": "2m" },
  "permissions": [
    { "kind": "notify_inbox" }
  ],
  "stop": {
    "complete_on_notification": true,
    "expires_at": "2026-05-26T20:00:00+03:00"
  },
  "limits": {
    "timeout": "5s",
    "max_consecutive_failures": 5
  }
}
```

```python
import urllib.request

def run(ctx):
    state = ctx.get("state", {})
    successes = state.get("successes", 0)

    try:
        req = urllib.request.Request("https://example.com", method="HEAD")
        with urllib.request.urlopen(req, timeout=5) as response:
            ok = 200 <= response.status < 400
    except Exception:
        ok = False

    successes = successes + 1 if ok else 0
    ctx.state["successes"] = successes

    if successes >= 2:
        ctx.notify("The watched site recovered across two checks.", title="Site recovered")
        return ctx.complete("Recovery notification sent.")

    return ctx.continue_after(minutes=2, summary="Still watching.")
```

## Useful Scenarios

- Notify once when a device remains unavailable past a debounce window.
- Verify that a smart-home action actually produced the expected state.
- Watch a local file until a job writes a final result.
- Check an internal endpoint for a specific anomaly and wake only on failures.
- Watch a public or internal status page until it returns a healthy response twice.
- Track a counter/sensor until it crosses a threshold, then pause.
- Monitor repeated automation failures and send context only after a pattern emerges.
- Run a short temporary watch after starting a long local process.
- Escalate a matched runtime condition to a model for concise judgement and optional Inbox notification.

## Webhook Trigger Context

When a webhook subscription targets a microscript, `run(ctx)` receives:

```json
{
  "trigger": "webhook",
  "webhook": {
    "eventId": "whe_...",
    "endpointId": "wh_...",
    "slug": "example-events",
    "source": "example",
    "eventType": "thing.updated",
    "dedupeKey": "upstream-event-id",
    "occurredAt": 1779720000000,
    "receivedAt": 1779720000123,
    "payload": {},
    "normalized": {}
  },
  "state": {}
}
```

The microscript should treat `ctx["webhook"]["payload"]` as input, keep durable watermarks/debounce counters in `ctx["state"]`, and return `nextCheckAfterMs` only when it needs a follow-up check after the event.
