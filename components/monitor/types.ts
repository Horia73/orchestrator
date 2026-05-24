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
  payload: Record<string, unknown> | null
}
