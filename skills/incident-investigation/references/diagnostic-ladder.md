# Diagnostic ladder

Use the narrowest applicable layers in order. Skip a layer only when it cannot participate in the reported story.

## 1. Identity and current state

- Confirm environment, profile/account, URL/route, provider/model, integration connection, process/container state, deployed version/commit, and incident timezone.
- Check whether the symptom is current, intermittent, or historical.
- Preserve a screenshot/status snapshot before remediation when possible.

## 2. Runtime and request logs

- Inspect terminal/runtime logs around the exact incident window.
- Search Orchestrator run and agent logs when the failure crossed model/tool/sub-agent boundaries.
- Look for the first error, timeout, cancellation, validation failure, provider rejection, missing key, quota/rate limit, unhandled exception, or abrupt last log before a hang.
- Correlate by request/run/tool id. A nearby error without matching identity/timing is not yet the cause.

If no relevant logs exist, record an observability gap. Do not immediately add logging during a diagnosis-only request; propose targeted instrumentation at the uncertain boundary.

## 3. Background machinery

Inspect scheduler/heartbeat state, queued or running jobs, retry count, last progress marker, lock/concurrency state, timeouts, and cancellation. Common patterns include unresolved promises, missing awaits, retry exhaustion, stale locks, provider backoff, and a job that completed but failed to persist/notify.

## 4. Browser boundary

Capture the failing state at the relevant viewport/account. Inspect console and network for JavaScript errors, hydration failures, 4xx/5xx, CORS/CSP, wrong method/path/payload, hanging requests, and response-shape mismatches. Verify the actual user action that triggers the request.

## 5. Environment and deploy identity

Compare local versus production configuration presence without exposing values. Confirm the expected branch/commit/version is running, migrations/build assets match, required services are reachable, and runtime paths/permissions/disk are valid. Do not assume a successful build means the intended commit is deployed.

## 6. Code and data flow

Trace `trigger → client/action → handler → service/integration → persistence → response → UI/notification`. At each boundary check:

- input validation and exact method/path/schema;
- async completion, timeout, cancellation, retries, and error handling;
- server/client import or execution-context mismatch;
- credentials/config availability in that runtime;
- data grain/key, serialization, transaction/persistence result;
- response shape expected by the next consumer.

## Evidence grades

- **Confirmed:** direct matching error/status/reproduction proves the break.
- **High confidence:** multiple independent matching signals with no material contradiction.
- **Hypothesis:** plausible but missing a discriminating check.

Prefer the smallest next check that can falsify the leading hypothesis. Do not list a generic catalogue of causes when one focused check is available.

## Post-fix verification

Re-run the original story at the same relevant boundary and environment. Confirm UI, request, service/data effect, response, persistence/notification, and absence of new console/runtime errors. Record the exact evidence and any coverage limits.
