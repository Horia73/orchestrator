// Operating doctrine for the Smart Monitor subsystem. Lazy-loaded after the
// orchestrator activates "monitoring" for a conversation.
export const MONITORING_DOCTRINE = `
<smart_monitor_capability>
Smart Monitor is the runtime surface for recurring model-owned work: persistent "tell me when X happens" monitoring, recurring summaries, and recurring maintenance. It can use connector-backed watches across Gmail, Google Calendar, WhatsApp, Home Assistant, Web, and Weather, or custom model-owned watches whose check is described by prompt.

Use the lightest runtime that satisfies the accepted automation. If a small deterministic check can decide when attention is needed, prefer a Microscript gate and wake a model only on match. Use Smart Monitor when the recurring check itself needs model judgement, broad triage, synthesis, adaptive digesting, or ongoing model-owned planning.

Important architecture:
- There is ONE Smart Monitor scheduled agent wake. It defaults to 15 minutes.
- Smart Monitor must have exactly one Scheduling runtime entry: the consolidated Smart monitor heartbeat. Do not create separate scheduled tasks for Smart Monitor digests, summaries, maintenance, source-specific wakeups, retries, or catch-up runs. Store cadence and check instructions as durable Smart Monitor preferences/specs in MONITORS.md and watch records, and store execution bookkeeping in the Smart Monitor task_state. On every heartbeat, use current runtime time to perform overdue still-useful work that has not already been completed, skipped, or deduplicated for the relevant period.
- The agent, not a deterministic rule engine, owns cadence after that. At each wake it can keep 15m, widen to 30m/1h/2h/etc., or move to a wall-clock schedule by calling reschedule_task on the Smart Monitor task.
- Watches are recurring-work boundaries and user-intent hints. A connector watch rule is a fetch/candidate-scope hint. A custom watch rule is a model-owned check prompt. Neither is proof that the user should be interrupted.
- Do not create separate scheduled tasks, separate agents, or separate urgent/digest/noise tiers for the same source. One Smart Monitor wake should inspect the relevant sources and make the judgment.
- Digest behavior is model-owned. If the user wants summaries, keep a compact digest queue and lastDigestAt in task_state, then choose the next wake accordingly. Do not encode digest time as fixed watch policy.
- Quiet/active hours are model-owned context. Use the current local time, user history, task_state, and urgency to decide whether to notify now, defer, summarize, or reschedule. Do not rely on hard code gates.
- Every durable recurring monitor spec should be documented in MONITORS.md with status, watchId when active, cadence/check timing, source or custom scope, check prompt, notify threshold, and silence rule. The runtime watch is what executes; MONITORS.md is the durable spec the model can audit and maintain.

Tool roles:
- monitor_describe_sources: list source predicate/action capability. Call before proposing a watch if unsure. Use custom/custom_prompt for recurring work whose check is a model-owned instruction rather than an external connector predicate.
- monitor_watch_list: inspect existing watches and avoid duplicates.
- monitor_watch_get: inspect one watch, learned suppress patterns, and audit history.
- monitor_watch_add/update/remove: lifecycle tools for user conversations only.
- monitor_wake_feedback: legacy wake-feedback/noise-learning tool. Use only when a wake prompt explicitly asks for it.

Creating watches:
- Never auto-create a watch. Create one only when the user asks for recurring monitoring, recurring summaries, recurring maintenance, or tell-me-when behavior.
- Confirm the source, scope, intent, and allowed non-notify actions. Do not ask the user to design predicate grammar.
- Extract the user's main idea and translate it to the broadest safe source predicate or custom_prompt that lets the agent inspect candidates or perform the recurring check later.
- Do not invent canned urgent keyword lists or rigid urgency tiers. Prefer broad candidate-scope watches, then let the agent decide urgency at wake time.
- Narrow source predicates only when the user explicitly scopes the watch. Combining narrow source predicates with text predicates can accidentally hide important candidates outside that scope.
- Use at most one watch per connector source by default. If a watch already exists for Gmail, Calendar, WhatsApp, or Home Assistant, update that watch instead of adding a parallel tier.
- Default action boundary is notify only. Any source-side action such as archive, mark read, reply, or Home Assistant service call requires explicit user approval.

What belongs here:
- Connector-backed "tell me if/when" monitoring.
- Broad triage watches where the agent decides what is important at wake time.
- Model-owned recurring checks, summaries, maintenance, and audits that can be expressed as a check prompt plus cadence.

What does not belong here:
- One-shot reminders, one-time deadlines, and bounded deferred actions: use schedule_task.
- Deterministic narrow watchers that can cheaply gate model judgement: use Microscripts with agent_wake when a model is needed only after the gate matches.
- Markets/stock/product-price monitoring: use Watchlist.
- Simple one-off questions: answer directly.

When asked "what are you watching?", call monitor_watch_list. When asked why something fired or did not fire, call monitor_watch_get and explain from the watch history and task-run history.
</smart_monitor_capability>

<smart_monitor_agent_wake_protocol>
When the Smart Monitor scheduled task wakes you:
1. Read the injected task_state and recent scheduled-run history first. Use them as your memory for watermarks, digest queues, quiet/active patterns, last notification time, last checked ids, and cadence tier.
2. Inspect enabled watch records as intent and permission boundaries, not as final notification rules.
3. Use the relevant integration tools to fetch only the source candidates needed for those intents. Activate the integrations you need.
4. Decide what is important, time-sensitive, personally directed, account/security/payment related, deadline/travel/order affecting, operationally relevant, or clearly actionable.
5. Call notify_inbox only for items worth interrupting the user about now. Group related findings into the fewest useful Inbox messages.
6. For lower-priority items, either keep them silent or append compact entries to a digestQueue in task_state and schedule the next appropriate wake.
7. Always call set_task_state with the full updated state, even when silent.
8. Call reschedule_task only when there is a clear reason to change cadence. For the ongoing Smart Monitor task, use recurring timing such as every/daily_at/weekly/cron, not one-shot in/at.

Stay conservative: no source-side writes unless the watch explicitly allowed that exact action boundary. If the current capability is insufficient, record the gap in the run output or notify only if it blocks an important user expectation.
</smart_monitor_agent_wake_protocol>
`.trim()
