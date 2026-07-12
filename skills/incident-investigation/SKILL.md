---
name: incident-investigation
description: Diagnose broken, stuck, slow, failing, or inconsistent application and agent flows from runtime evidence. Use for incidents, hung jobs, blank pages, failed integrations, missing output, production/local mismatches, and end-to-end verification; distinguish diagnosis from authorization to implement a fix.
---

# Incident Investigation

Find the first broken boundary with evidence. Do not shotgun retries, invent a root cause, or mutate production merely to see whether the symptom disappears.

## Orchestrator Runtime

- Activate `ActivateIntegrationTools("observability")` when prior Orchestrator runs, model requests, sub-agent logs, tool calls, or runtime index entries matter. Use `search_past_runs`/`get_past_run` and `search_agent_logs`/`get_agent_log` instead of guessing.
- Activate `browser` before delegating to `browser_agent` for live UI, console, network, or logged-in-flow evidence. Capture the failing state before changing it.
- For Orchestrator code/runtime work, activate `self_dev`; for an external or generated project, activate `project_dev`. Follow the loaded doctrine and repository instructions rather than creating an ad-hoc checkout or server.
- Use integration status/read tools for the affected service. Do not reconnect, resend, restart, deploy, or alter credentials unless the user asked for remediation and the action policy permits it.
- For production host checks, prefer read-only status/log/version inspection. A deploy request is separate authorization.

## Reporting Contract

Keep the user informed during an active investigation. For each meaningful layer report:

- **Checking:** what boundary you are inspecting;
- **Evidence:** the exact relevant status, timestamp, error, request id, log line, or screenshot finding;
- **Next:** what that evidence implies and the next discriminating check.

Redact secrets and irrelevant personal data. Summarize noisy logs; quote only the lines that establish the finding.

## Workflow

### 1. Define the incident

Capture expected versus actual behavior, affected surface/account/profile, environment, start time and timezone, frequency, last known good state, and user impact. Build a one-sentence flow such as `UI action → API route → integration/provider → persisted result → rendered response`.

Do not require every detail before starting when logs or current state can resolve them safely.

### 2. Establish the evidence baseline

Read [references/diagnostic-ladder.md](references/diagnostic-ladder.md). Start with the cheapest high-signal evidence: current status and recent errors around the incident window, then background job/run state, browser console/network/UI, environment/deploy identity, and finally code/data boundaries.

Correlate evidence by timestamp, request/run id, conversation/profile, provider/model, endpoint, and deployed commit/version. Confirm that the evidence belongs to the reported occurrence.

### 3. Trace boundary by boundary

At each boundary verify input, execution, output, persistence, and the next consumer's expectation. Stop at the first confirmed break; later symptoms are downstream until proven otherwise.

Prefer one targeted reproduction after the baseline is captured. Do not run the same failed check more than twice unless new evidence changes the hypothesis.

### 4. Separate finding from fix

- If the user asked only to diagnose, report the root cause and proposed smallest fix; do not implement it.
- If the user asked to fix, implement only after the root cause is supported, then verify the original user story end to end.
- If remediation needs a restart, deploy, account change, credential rotation, destructive cleanup, external write, or expanded scope, obtain the required approval first.

### 5. Stop correctly

Stop when all story boundaries are verified or when a specific first broken boundary/root cause is supported. If two consecutive layers produce no useful signal, report the observability gap and the smallest instrumentation or user context needed; do not keep cycling.

## Final Report

Lead with status and root cause/confidence. Include the affected story, evidence timeline, first broken boundary, user impact, what remains verified working, fix or next discriminating step, and verification performed. Label hypotheses as hypotheses. Never report “fixed” without re-running the original failing path.
