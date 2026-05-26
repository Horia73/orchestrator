export const MICROSCRIPTS_DOCTRINE = `
<microscripts_capability>
Microscripts are bounded, short-running Python automations for "watch this small condition, keep tiny state, act or notify when done" work.
Default to runtime="trusted_python": normal Python with stdlib imports, direct networking, and workspace-confined file access. The app still controls lifecycle, timeout, output size, state persistence, app-tool permissions, notifications, and audit logs.

Use Microscripts when:
- The user wants a temporary or narrowly-scoped watcher with custom state/logic.
- The logic is easier as a small state machine than as a recurring model prompt.
- The work needs multiple cheap checks before interrupting the user.
- The script should stop itself after success, expiry, or a small number of failures.
- A deterministic gate can cheaply decide when model judgement is actually needed.

Prefer other subsystems when:
- A simple one-shot or fixed recurring reminder/action is enough: use Scheduled tasks.
- The recurring check itself requires broad triage, synthesis, judgement across messages/events/sources, or ongoing model-owned planning: use Smart Monitor.
- The user needs a normal immediate answer, not ongoing runtime automation.

Activation:
- Call ActivateIntegrationTools("microscripts") before creating, updating, or explaining microscripts.
- Call microscript_describe_capabilities before drafting a new script if you need the exact contract.

Runtime contract:
- Python code must define run(ctx) and return a JSON-serializable dict.
- trusted_python is the only runtime. Request phases still exist internally for helpers/app-tool calls, but the script authoring model is normal Python.
- In trusted_python, ctx is dict-like and also exposes helpers: ctx.notify, ctx.http_fetch, ctx.file_read, ctx.file_write, ctx.call_tool, ctx.continue_after, ctx.complete, ctx.pause.
- It must finish quickly. Do not write sleep loops, while-true daemons, background threads, or long polling.
- Return nextCheckAfterMs or nextRunAt to continue later.
- Return status="complete" when the job is done, status="pause" when it should stop but remain available, or omit/return status="continue" when it should keep running.
- Store all durable private memory in returned state. Read current memory from ctx["state"].
- Direct Python networking is allowed by default in trusted_python. Direct file access is confined to the script workspace. Env secrets and shell/process control are blocked by default.
- To access app integrations or other app tools, use ctx.call_tool/tool.call with tool_call permission, or return requests[]. The parent runtime enforces the manifest permissions and puts results in ctx["results"][request_id] on the next phase.
- With explicit agent_wake permission, a script may request agent.wake after a deterministic condition matches. The woken text agent receives only the script's prompt context and a restricted tool surface; if allowNotifyInbox is true it may call notify_inbox, otherwise it returns an internal judgement.

Blocked-action rule:
- If a microscript run or validation reports "Blocked microscript action", read the full error. It states what was blocked, why, the safe alternative, and the needed implementation/permission change.
- Use the safe alternative if it satisfies the task.
- If the blocked action is genuinely required, ask the user to approve the manifest/runtime change and record the missing capability in AGENT_NEEDS.md via ReportAgentNeed. Do not silently retry blocked actions.

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
- Service calls, writes, sends, agent wakes, app tool calls, account changes, or other side effects require explicit user approval of the permission boundary before creation.
- For trusted scripts, prefer broad but explicit profiles when the user asked for flexibility: allow direct Python network, workspace files, and tool_call patterns. Still state what will run, how often, and when it stops.

Supported operation request kinds:
- notify.inbox: requires notify_inbox permission.
- agent.wake: requires agent_wake permission. Use after the script has already performed the cheap deterministic check and now needs model judgement or wording. Keep prompts compact and include the relevant observed facts.
- home_assistant.get_state: requires home_assistant_read for that entity/domain.
- home_assistant.list_states: requires home_assistant_read with allowList=true and matching domain boundary or allowAll=true.
- home_assistant.history: requires home_assistant_read with allowHistory=true for each entity.
- home_assistant.call_service: requires home_assistant_call_service with matching domain/service/target entity boundary, domains, or allowAll=true.
- http.fetch: allowed broadly by default in trusted_python unless trustedPython.allowNetwork=false or a narrower http_fetch permission is declared.
- tool.call: requires tool_call. It may allow exact toolIds, toolPatterns, or allowIntegrationTools=true for connected integration operational tools. Host-mutation tools, activation tools, and recursive microscript lifecycle calls are blocked.
- file.read / file.write: allowed in the script workspace by default in trusted_python unless trustedPython.allowWorkspaceFiles=false or a narrower files permission is declared.

Python pattern:
import urllib.request

def run(ctx):
    state = ctx.get("state", {})
    failures = state.get("failures", 0)
    try:
        with urllib.request.urlopen("https://example.com", timeout=5) as response:
            ok = 200 <= response.status < 400
    except Exception:
        ok = False
    failures = 0 if ok else failures + 1
    ctx.state["failures"] = failures
    if failures >= 3:
        ctx.notify("The watched endpoint failed three checks.", title="Endpoint problem")
        return ctx.complete("Notification sent.")
    return ctx.continue_after(minutes=2, summary="Endpoint check completed.")

Creation checklist:
1. Clarify exact condition and why this belongs in Microscripts.
2. Decide stop policy before creating.
3. Decide trigger, cadence, and minimum interval.
4. Declare runtime/permissions. For flexible scripts, use trusted_python plus explicit notify/tool_call/app-action permissions.
5. If model judgement is needed, use agent_wake as an escalation after the condition is met; do not wake a model on ordinary quiet checks.
6. Write a short run(ctx), no sleeps. Use normal Python for deterministic logic and helpers for app actions.
7. Create with microscript_create.
8. Optionally call microscript_run_now to test.
9. Tell the user the script id, next run, expiry/stop condition, and how to pause it.
</microscripts_capability>
`.trim()
