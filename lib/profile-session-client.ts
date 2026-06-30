"use client"

export const PROFILE_SESSION_CHANGED_EVENT =
  "orchestrator:profile-session-changed"

export function dispatchProfileSessionChanged(): void {
  if (typeof window === "undefined") return
  window.dispatchEvent(new Event(PROFILE_SESSION_CHANGED_EVENT))
}
