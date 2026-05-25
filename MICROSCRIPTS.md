# Microscripts

Microscripts are bounded Python automations for small stateful watchers. They are meant for jobs that need a few cheap checks, tiny private state, and a clear stop condition.

They are not background daemons. A microscript runs, returns JSON, and exits. If it needs to keep watching, it returns `nextCheckAfterMs` or `nextRunAt`. Microscripts can also be triggered by inbound Webhooks after the webhook subsystem has authenticated, deduped, persisted, and normalized the event.

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

Allowed statuses:

- `continue`: keep active and schedule another run.
- `pause`: stop running but keep the script and history.
- `complete`: mark done and disable future runs.

The script cannot read environment variables or secrets directly. External work is requested through `requests`; the parent runtime enforces the manifest permissions and returns results in `ctx["results"][request_id]` on the next phase.

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
- `files`

Keep permissions narrow. For Home Assistant writes, list the exact domain, service, and target entity IDs wherever possible.

`agent_wake` lets a script request an `agent.wake` operation after its deterministic gate passes. The permission lists allowed agent ids, maximum prompt size, and whether the woken agent may call `notify_inbox`. The woken agent receives the script prompt as context and a restricted tool surface; use this for "cheap check first, model judgement only on match" workflows.

## Example

```json
{
  "description": "Notify once if the garage door stays open across two checks.",
  "schedule": { "kind": "interval", "every": "2m" },
  "permissions": [
    {
      "kind": "home_assistant_read",
      "entity_ids": ["binary_sensor.garage_door"]
    },
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
def run(ctx):
    state = ctx.get("state", {})
    results = ctx.get("results", {})

    if "door" not in results:
        return {
            "requests": [
                {
                    "id": "door",
                    "kind": "home_assistant.get_state",
                    "entity_id": "binary_sensor.garage_door"
                }
            ],
            "state": state,
            "nextCheckAfterMs": 120000
        }

    door = results["door"]
    if not door["ok"]:
        return {
            "summary": "Could not read garage door state.",
            "state": state,
            "nextCheckAfterMs": 300000
        }

    is_open = door["data"]["state"] in ["on", "open"]
    open_runs = state.get("open_runs", 0) + 1 if is_open else 0

    if open_runs >= 2:
        return {
            "requests": [
                {
                    "id": "notify",
                    "kind": "notify.inbox",
                    "title": "Garage door",
                    "body": "Garage door is still open."
                }
            ],
            "state": {"open_runs": open_runs},
            "status": "complete"
        }

    return {
        "summary": "Garage door check completed.",
        "state": {"open_runs": open_runs},
        "nextCheckAfterMs": 120000
    }
```

## Useful Scenarios

- Notify once when a device remains unavailable past a debounce window.
- Verify that a smart-home action actually produced the expected state.
- Watch a local file until a job writes a final result.
- Check an internal endpoint for a specific anomaly and wake only on failures.
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
