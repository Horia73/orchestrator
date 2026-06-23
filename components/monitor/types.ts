export type WatchSource =
  | "gmail"
  | "google_calendar"
  | "whatsapp"
  | "home_assistant"
  | "web"
  | "weather"
  | "custom"

export interface WatchRow {
  id: string
  title: string
  source: WatchSource
  target: string
  rule_description: string
  enabled: boolean
  cadence_seconds: number
  cadence_adaptive: boolean
  allowed_action_count: number
  allowed_actions: string[]
  suppress_pattern_count: number
  next_check_at: number | null
  last_checked_at: number | null
  last_fired_at: number | null
  consecutive_errors: number
  last_error: string | null
  active_runs: number
  quiet_runs: number
  notify_quiet_hours: { from: string; to: string; timezone: string } | null
  follow_up: {
    expectation: string
    deadline_at: number
    on_deadline: "escalate" | "silent"
    status: "waiting" | "resolved" | "deadline_passed"
  } | null
  created_by: string
  created_at: number
  updated_at: number
}

export interface WatchDetail extends Omit<WatchRow, "allowed_action_count"> {
  rule: unknown
  allowed_actions_detailed: Array<{ raw: unknown; description: string }>
  cadence: {
    current: number
    min: number
    max: number
    adaptive: boolean
  }
  notify: {
    onMatch: boolean
    digestAt?: string
    quietHours?: { from: string; to: string; timezone: string }
  }
  state: Record<string, unknown>
  suppress_patterns: Array<{
    id: string
    reason: string
    rule: unknown
    rule_description: string
    created_at: number
    expires_at: number | null
    match_count: number
    last_matched_at: number | null
  }>
}

export interface MonitorSettings {
  quietHours?: { from: string; to: string; timezone: string }
}

export interface HeartbeatStatus {
  heartbeat: {
    id: string
    enabled: boolean
    status: string
    next_run_at: number | null
    last_run_at: number | null
    last_run_status: "ok" | "error" | "missed" | null
    last_run_error: string | null
    schedule: { kind: string; everyMs?: number }
  } | null
  counts: { total: number; enabled: number; paused: number; errored: number }
  next_due_at: number | null
}

export interface WatchEvent {
  id: string
  ts: number
  kind:
    | "check"
    | "match"
    | "suppress"
    | "wake"
    | "notify"
    | "action"
    | "feedback"
    | "cadence_change"
    | "error"
    | "followup"
    | "user_signal"
  payload: Record<string, unknown> | null
}

export interface MicroscriptRow {
  id: string
  title: string
  enabled: boolean
  status:
    | "active"
    | "running"
    | "paused"
    | "completed"
    | "expired"
    | "error"
  description: string
  schedule: unknown
  permission_count: number
  next_run_at: number | null
  last_run_at: number | null
  last_run_status: "ok" | "error" | null
  last_run_error: string | null
  run_count: number
  consecutive_failures: number
  expires_at: number | null
  created_by: string
  created_at: number
  updated_at: number
}

export interface MicroscriptRun {
  id: string
  scriptId: string
  startedAt: number
  endedAt: number
  status: "ok" | "error"
  trigger: "schedule" | "manual" | "webhook"
  summary: string
  error: string | null
  phases: number
  operations: number
  surfaced: boolean
  conversationId: string | null
}

export interface MicroscriptEvent {
  id: string
  scriptId: string
  ts: number
  kind: string
  payload: Record<string, unknown> | null
}

export interface MicroscriptDetail extends MicroscriptRow {
  code: string
  code_hash: string
  manifest: Record<string, unknown>
  state: Record<string, unknown>
  runs: MicroscriptRun[]
  events: MicroscriptEvent[]
}

export type WebhookAuthMode = "bearer" | "hmac" | "svix" | "none"
export type WebhookEventStatus =
  | "received"
  | "processing"
  | "processed"
  | "duplicate"
  | "error"
export type WebhookDispatchStatus =
  | "queued"
  | "running"
  | "ok"
  | "skipped"
  | "error"

export interface WebhookEndpoint {
  id: string
  slug: string
  title: string
  description: string | null
  source: string
  defaultEventType: string | null
  enabled: boolean
  authMode: WebhookAuthMode
  hmacToleranceSeconds: number
  rateLimitPerMinute: number
  retentionDays: number
  createdBy: "user" | "orchestrator" | "system"
  createdAt: number
  updatedAt: number
  secretConfigured: boolean
  secretPreview: string | null
}

export interface WebhookSubscription {
  id: string
  endpointId: string
  targetKind: "microscript"
  targetId: string
  enabled: boolean
  eventType: string | null
  payloadPath: string | null
  payloadEquals: unknown | null
  createdAt: number
  updatedAt: number
}

export interface NormalizedWebhookEvent {
  source: string
  eventType: string
  subject: string | null
  actor: string | null
  occurredAt: number
  summary: string
  metadata: Record<string, unknown>
}

export interface WebhookDispatch {
  id: string
  eventId: string
  subscriptionId: string | null
  targetKind: "microscript"
  targetId: string
  status: WebhookDispatchStatus
  error: string | null
  runSummary: string | null
  conversationId: string | null
  startedAt: number
  endedAt: number | null
}

export interface WebhookEvent {
  id: string
  endpointId: string
  slug: string
  source: string
  eventType: string
  dedupeKey: string
  payload: Record<string, unknown>
  normalized: NormalizedWebhookEvent
  status: WebhookEventStatus
  error: string | null
  occurredAt: number
  receivedAt: number
  processedAt: number | null
  dispatches?: WebhookDispatch[]
}
