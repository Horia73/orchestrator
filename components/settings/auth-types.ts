export interface GmailConfigInput {
  clientId?: string
  clientSecret?: string
  redirectUri?: string
  rawEnv?: string
}

export interface GoogleWorkspaceConfigInput {
  clientId?: string
  clientSecret?: string
  redirectUri?: string
  rawEnv?: string
}

export type GoogleCalendarConfigInput = GoogleWorkspaceConfigInput
export type GoogleDriveConfigInput = GoogleWorkspaceConfigInput

export interface HomeAssistantConfigInput {
  baseUrl?: string
  token?: string
  rawEnv?: string
}

export interface GoogleMapsConfigInput {
  apiKey?: string
  mapId?: string
  rawEnv?: string
}

export interface RemoteMcpConfigInput {
  id?: string
  label?: string
  url: string
  authType?: "oauth" | "none"
  enabled?: boolean
  notes?: string
}

export type BusyAction =
  | "connect"
  | "disconnect"
  | "save"
  | "google-calendar-connect"
  | "google-calendar-disconnect"
  | "google-calendar-save"
  | "google-drive-connect"
  | "google-drive-disconnect"
  | "google-drive-save"
  | "google-account-select"
  | "whatsapp-connect"
  | "whatsapp-disconnect"
  | "homeassistant-save"
  | "homeassistant-disconnect"
  | "homeassistant-action-mode"
  | "google-maps-save"
  | "mcp-save"
  | "mcp-connect"
  | "mcp-disconnect"
  | "mcp-remove"
  | null

export type NoticeTone = "success" | "error" | "warning"
