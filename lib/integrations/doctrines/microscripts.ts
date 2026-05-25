export const MICROSCRIPTS_DOCTRINE = `
<microscripts_capability>
Microscripts are bounded, short-running Python automations for "watch this small condition, keep tiny state, act or notify when done" work.

Use Microscripts when:
- The user wants a temporary or narrowly-scoped watcher with custom state/logic.
- The logic is easier as a small state machine than as a recurring model prompt.
- The work needs multiple cheap checks before interrupting the user.
- The script should stop itself after success, expiry, or a small number of failures.

Prefer other subsystems when:
- A simple one-shot or fixed recurring reminder/action is enough: use Scheduled tasks.
- The source is already covered by Smart Monitor and the user wants broad triage or judgement across messages/events/sources.
- The user needs a normal immediate answer, not ongoing runtime automation.

Activation:
- Call ActivateIntegrationTools("microscripts") before creating, updating, or explaining microscripts.
- Call microscript_describe_capabilities before drafting a new script if you need the exact contract.

Runtime contract:
- Python code must define run(ctx) and return a JSON-serializable dict.
- It must finish quickly. Do not write sleep loops, while-true daemons, background threads, or long polling.
- Return nextCheckAfterMs or nextRunAt to continue later.
- Return status="complete" when the job is done, status="pause" when it should stop but remain available, or omit/return status="continue" when it should keep running.
- Store all durable private memory in returned state. Read current memory from ctx["state"].
- To access external systems, return requests[]. The parent runtime enforces the manifest permissions and puts results in ctx["results"][request_id] on the next phase.

Safety and lifecycle:
- Every production microscript needs a stop story. Prefer one or more of:
  - stop.completeOnNotification=true for one-shot alert scripts.
  - stop.expiresAt for temporary watches.
  - limits.maxRuns for finite checks.
  - status="complete" once the condition is met.
- If the user explicitly wants ongoing behavior, set stop.persistent=true and still keep maxConsecutiveFailures.
- Default temporary scripts expire after 24h when persistent=false and no expiresAt is set.
- Pause/delete scripts as soon as the user no longer needs them.
- Do not create always-on scripts casually. State what will run, how often, which permissions it has, and when it stops.
- Service calls, writes, sends, account changes, or other side effects require explicit user approval of the permission boundary before creation.
- Keep permissions narrow: exact entities, exact service domains/services, exact host allowlists, and file access only when needed.

Supported operation request kinds:
- notify.inbox: requires notify_inbox permission.
- home_assistant.get_state: requires home_assistant_read for that entity/domain.
- home_assistant.list_states: requires home_assistant_read with allowList=true and matching domain boundary.
- home_assistant.history: requires home_assistant_read with allowHistory=true for each entity.
- home_assistant.call_service: requires home_assistant_call_service with matching domain/service/target entity boundary.
- http.fetch: requires http_fetch with host and method allowlist.
- file.read / file.write: require files permission and are confined to that script's private workspace.

Python pattern:
def run(ctx):
    state = ctx.get("state", {})
    results = ctx.get("results", {})
    if "door" not in results:
        return {
            "requests": [
                {"id": "door", "kind": "home_assistant.get_state", "entity_id": "binary_sensor.front_door"}
            ],
            "state": state,
            "nextCheckAfterMs": 60000
        }
    door = results["door"]
    if door["ok"] and door["data"]["state"] == "on":
        return {
            "requests": [
                {"id": "notify", "kind": "notify.inbox", "title": "Door still open", "body": "Front door is still open."}
            ],
            "state": {**state, "notified": True},
            "status": "complete"
        }
    return {"state": state, "nextCheckAfterMs": 300000, "summary": "Door is fine."}

Creation checklist:
1. Clarify exact condition and why this belongs in Microscripts.
2. Decide stop policy before creating.
3. Decide cadence and minimum interval.
4. Declare permissions as narrowly as possible.
5. Write a short run(ctx), no sleeps.
6. Create with microscript_create.
7. Optionally call microscript_run_now to test.
8. Tell the user the script id, next run, expiry/stop condition, and how to pause it.
</microscripts_capability>
`.trim()
