# Webhooks

Inbound webhooks are the generic event ingress for Orchestrator. The webhook subsystem owns the public HTTP boundary: authentication, body limits, dedupe, persistence, normalization, and dispatch. Internal consumers such as Microscripts receive already-persisted event context.

## API Surface

- `GET /api/webhooks` lists configured endpoints.
- `POST /api/webhooks` creates an endpoint and returns a generated secret when one was not provided.
- `GET /api/webhooks/:id_or_slug` reads endpoint details and subscriptions.
- `PATCH /api/webhooks/:id_or_slug` updates config or rotates the secret.
- `DELETE /api/webhooks/:id_or_slug` deletes an endpoint and its events/subscriptions.
- `POST /api/webhooks/:slug` is the public ingress endpoint.
- `GET /api/webhooks/:id_or_slug/events?dispatches=1` reads recent events.
- `GET/POST /api/webhooks/:id_or_slug/subscriptions` manages endpoint subscriptions.
- `GET/PATCH/DELETE /api/webhooks/subscriptions/:id` manages one subscription.

Management routes use the normal private API guard. The public ingress route does not use same-origin protection; it authenticates with the webhook endpoint secret.

## Auth

Endpoint `authMode` values:

- `bearer`: accepts `Authorization: Bearer <secret>`, `X-Orchestrator-Webhook-Secret`, or `X-Webhook-Secret`.
- `hmac`: accepts `X-Orchestrator-Signature`, `X-Hub-Signature-256`, or `X-Webhook-Signature` with `sha256=<hex>` or raw hex. If a timestamp header is present, it is checked against `hmacToleranceSeconds`.
- `none`: allowed only when explicitly configured.

Payloads are JSON objects and capped at 512 KB. Rate limiting is per endpoint and caller IP.

## Microscript Dispatch

Create a subscription with:

```json
{
  "targetKind": "microscript",
  "targetId": "ms_...",
  "eventType": "thing.updated"
}
```

The microscript runs with `ctx["trigger"] == "webhook"` and a `ctx["webhook"]` object containing event ids, source, event type, raw payload, and normalized fields. If the script returns `nextCheckAfterMs`, it schedules a follow-up run through the normal microscript heartbeat.
