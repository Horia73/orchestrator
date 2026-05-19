"use client"

import * as React from "react"

export type PushStatus =
  | "checking"
  | "unsupported"
  | "ready"
  | "enabled"
  | "blocked"
  | "error"

export type PushUnsupportedReason =
  | "not-browser"
  | "insecure-context"
  | "notification-api"
  | "service-worker"
  | "push-manager"

const SYNC_RECORD_KEY = "orchestrator:push-subscription-sync"
const SYNC_TTL_MS = 12 * 60 * 60 * 1000

function urlBase64ToApplicationServerKey(value: string): ArrayBuffer {
  const padding = "=".repeat((4 - (value.length % 4)) % 4)
  const base64 = `${value}${padding}`.replace(/-/g, "+").replace(/_/g, "/")
  const raw = window.atob(base64)
  const buffer = new ArrayBuffer(raw.length)
  const output = new Uint8Array(buffer)
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i)
  return buffer
}

function getPushUnsupportedReason(): PushUnsupportedReason | null {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return "not-browser"
  }
  if (!window.isSecureContext) return "insecure-context"
  if (!("Notification" in window)) return "notification-api"
  if (!("serviceWorker" in navigator)) return "service-worker"
  if (!("PushManager" in window)) return "push-manager"
  return null
}

async function registerServiceWorker(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration("/")
  const registration =
    existing ??
    (await navigator.serviceWorker.register("/sw.js", { scope: "/" }))
  return navigator.serviceWorker.ready.catch(() => registration)
}

function requestNotificationPermission(): Promise<NotificationPermission> {
  return new Promise((resolve) => {
    const result = Notification.requestPermission(resolve)
    if (result && typeof result.then === "function") {
      result.then(resolve).catch(() => resolve(Notification.permission))
    }
  })
}

async function getApplicationServerKey(): Promise<ArrayBuffer> {
  const keyRes = await fetch("/api/push/vapid-public-key", {
    cache: "no-store",
  })
  if (!keyRes.ok) throw new Error("Push configuration is unavailable")

  const { publicKey } = (await keyRes.json()) as { publicKey?: string }
  if (!publicKey) throw new Error("Push public key is unavailable")

  return urlBase64ToApplicationServerKey(publicKey)
}

function buffersMatch(left: ArrayBuffer | null, right: ArrayBuffer): boolean {
  if (!left) return true
  const a = new Uint8Array(left)
  const b = new Uint8Array(right)
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

function readSyncRecord(): { endpoint: string; syncedAt: number } | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(SYNC_RECORD_KEY) ?? "null")
    if (
      parsed &&
      typeof parsed.endpoint === "string" &&
      typeof parsed.syncedAt === "number"
    ) {
      return parsed
    }
  } catch {
    // Private browsing or malformed state: re-sync below.
  }
  return null
}

function writeSyncRecord(endpoint: string) {
  try {
    localStorage.setItem(
      SYNC_RECORD_KEY,
      JSON.stringify({ endpoint, syncedAt: Date.now() })
    )
  } catch {
    // Browser storage is best-effort; server sync already succeeded.
  }
}

async function saveSubscription(subscription: PushSubscription): Promise<void> {
  const saveRes = await fetch("/api/push/subscriptions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ subscription: subscription.toJSON() }),
  })
  if (!saveRes.ok) throw new Error("Push subscription could not be saved")
  writeSyncRecord(subscription.endpoint)
}

async function deleteSubscription(endpoint: string): Promise<void> {
  if (!endpoint) return
  await fetch("/api/push/subscriptions", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ endpoint }),
  }).catch(() => undefined)
}

async function syncSubscriptionIfNeeded(
  subscription: PushSubscription
): Promise<void> {
  const record = readSyncRecord()
  if (
    record?.endpoint === subscription.endpoint &&
    Date.now() - record.syncedAt < SYNC_TTL_MS
  ) {
    return
  }
  await saveSubscription(subscription)
}

export function useInboxPushNotifications() {
  const [status, setStatus] = React.useState<PushStatus>("checking")
  const [permission, setPermission] =
    React.useState<NotificationPermission>("default")
  const [unsupportedReason, setUnsupportedReason] =
    React.useState<PushUnsupportedReason | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const refresh = React.useCallback(async () => {
    if (typeof window === "undefined") return
    const reason = getPushUnsupportedReason()
    setUnsupportedReason(reason)
    if (reason) {
      setStatus("unsupported")
      setError(null)
      return
    }

    setPermission(Notification.permission)
    if (Notification.permission === "denied") {
      setStatus("blocked")
      setError(null)
      return
    }

    try {
      const registration = await registerServiceWorker()
      const subscription = await registration.pushManager.getSubscription()
      if (subscription) await syncSubscriptionIfNeeded(subscription)
      setStatus(subscription ? "enabled" : "ready")
      setError(null)
    } catch (err) {
      setStatus("error")
      setError(err instanceof Error ? err.message : "Push setup failed")
    }
  }, [])

  React.useEffect(() => {
    void refresh()
  }, [refresh])

  React.useEffect(() => {
    if (typeof window === "undefined" || typeof document === "undefined") return

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void refresh()
    }
    document.addEventListener("visibilitychange", onVisibilityChange)

    let permissionStatus: PermissionStatus | null = null
    let cancelled = false
    if ("permissions" in navigator && navigator.permissions?.query) {
      void navigator.permissions
        .query({ name: "notifications" as PermissionName })
        .then((result) => {
          if (cancelled) return
          permissionStatus = result
          permissionStatus.onchange = () => void refresh()
        })
        .catch(() => undefined)
    }

    return () => {
      cancelled = true
      document.removeEventListener("visibilitychange", onVisibilityChange)
      if (permissionStatus) permissionStatus.onchange = null
    }
  }, [refresh])

  const enable = React.useCallback(async () => {
    const reason = getPushUnsupportedReason()
    setUnsupportedReason(reason)
    if (reason) {
      setStatus("unsupported")
      setError(null)
      return false
    }

    setBusy(true)
    setError(null)
    try {
      const permission =
        Notification.permission === "granted"
          ? "granted"
          : await requestNotificationPermission()
      setPermission(permission)
      if (permission !== "granted") {
        setStatus(permission === "denied" ? "blocked" : "ready")
        setError(null)
        return false
      }

      const registration = await registerServiceWorker()
      let subscription = await registration.pushManager.getSubscription()
      const applicationServerKey = await getApplicationServerKey()
      if (!subscription) {
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey,
        })
      } else if (
        !buffersMatch(
          subscription.options.applicationServerKey,
          applicationServerKey
        )
      ) {
        const oldEndpoint = subscription.endpoint
        await subscription.unsubscribe()
        await deleteSubscription(oldEndpoint)
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey,
        })
      }

      await saveSubscription(subscription)
      setStatus("enabled")
      return true
    } catch (err) {
      setStatus("error")
      setError(err instanceof Error ? err.message : "Push setup failed")
      return false
    } finally {
      setBusy(false)
    }
  }, [])

  return { status, permission, unsupportedReason, busy, error, enable, refresh }
}
