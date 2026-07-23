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
  | "ios-pwa-required"
  | "notification-api"
  | "service-worker"
  | "push-manager"

export interface PushRefreshResult {
  status: PushStatus
  permission: NotificationPermission
  unsupportedReason: PushUnsupportedReason | null
  error: string | null
}

const SYNC_RECORD_KEY = "orchestrator:push-subscription-sync"
const SYNC_TTL_MS = 12 * 60 * 60 * 1000
let subscriptionSetupPromise: Promise<PushSubscription> | null = null

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
  if (isAppleMobileDevice() && !isStandaloneApp()) return "ios-pwa-required"
  if (!("Notification" in window)) return "notification-api"
  if (!("serviceWorker" in navigator)) return "service-worker"
  if (!("PushManager" in window)) return "push-manager"
  return null
}

function isAppleMobileDevice(): boolean {
  const ua = navigator.userAgent
  const platform = navigator.platform
  return (
    /iPad|iPhone|iPod/.test(ua) ||
    (platform === "MacIntel" && navigator.maxTouchPoints > 1)
  )
}

function isStandaloneApp(): boolean {
  const nav = navigator as Navigator & { standalone?: boolean }
  return Boolean(
    nav.standalone || window.matchMedia("(display-mode: standalone)").matches
  )
}

async function registerServiceWorker(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration("/")
  if (existing) {
    await existing.update().catch(() => undefined)
  }
  const registration =
    existing ??
    (await navigator.serviceWorker.register("/sw.js", {
      scope: "/",
      updateViaCache: "none",
    }))
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

function readSyncRecord(): {
  endpoint: string
  profileId: string | null
  syncedAt: number
} | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(SYNC_RECORD_KEY) ?? "null")
    if (
      parsed &&
      typeof parsed.endpoint === "string" &&
      typeof parsed.syncedAt === "number"
    ) {
      return {
        endpoint: parsed.endpoint,
        profileId:
          typeof parsed.profileId === "string" ? parsed.profileId : null,
        syncedAt: parsed.syncedAt,
      }
    }
  } catch {
    // Private browsing or malformed state: re-sync below.
  }
  return null
}

function writeSyncRecord(endpoint: string, profileId: string | null) {
  try {
    localStorage.setItem(
      SYNC_RECORD_KEY,
      JSON.stringify({ endpoint, profileId, syncedAt: Date.now() })
    )
  } catch {
    // Browser storage is best-effort; server sync already succeeded.
  }
}

async function fetchCurrentProfileId(): Promise<string | null> {
  const res = await fetch("/api/profiles/current", { cache: "no-store" })
  if (!res.ok) return null
  const data = (await res.json().catch(() => ({}))) as {
    profile?: { id?: unknown }
  }
  return typeof data.profile?.id === "string" ? data.profile.id : null
}

async function saveSubscription(
  subscription: PushSubscription,
  fallbackProfileId: string | null
): Promise<void> {
  const saveRes = await fetch("/api/push/subscriptions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ subscription: subscription.toJSON() }),
  })
  if (!saveRes.ok) throw new Error("Push subscription could not be saved")
  const data = (await saveRes.json().catch(() => ({}))) as {
    profileId?: unknown
  }
  writeSyncRecord(
    subscription.endpoint,
    typeof data.profileId === "string" ? data.profileId : fallbackProfileId
  )
}

async function deleteSubscription(endpoint: string): Promise<void> {
  if (!endpoint) return
  await fetch("/api/push/subscriptions", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ endpoint }),
  }).catch(() => undefined)
  try {
    const record = readSyncRecord()
    if (record?.endpoint === endpoint) localStorage.removeItem(SYNC_RECORD_KEY)
  } catch {
    // Best-effort local cache cleanup.
  }
}

async function syncSubscriptionIfNeeded(
  subscription: PushSubscription
): Promise<void> {
  const profileId = await fetchCurrentProfileId()
  const record = readSyncRecord()
  if (
    record?.endpoint === subscription.endpoint &&
    record.profileId === profileId &&
    Date.now() - record.syncedAt < SYNC_TTL_MS
  ) {
    return
  }
  await saveSubscription(subscription, profileId)
}

async function getOrCreatePushSubscription(): Promise<PushSubscription> {
  if (!subscriptionSetupPromise) {
    subscriptionSetupPromise = (async () => {
      const registration = await registerServiceWorker()
      let subscription = await registration.pushManager.getSubscription()
      const applicationServerKey = await getApplicationServerKey()

      if (!subscription) {
        return registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey,
        })
      }

      if (
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

      return subscription
    })().finally(() => {
      subscriptionSetupPromise = null
    })
  }

  return subscriptionSetupPromise
}

async function ensurePushSubscription(options?: {
  forceSave?: boolean
}): Promise<PushSubscription> {
  const subscription = await getOrCreatePushSubscription()
  if (options?.forceSave) {
    await saveSubscription(subscription, await fetchCurrentProfileId())
  } else await syncSubscriptionIfNeeded(subscription)
  return subscription
}

export function useInboxPushNotifications() {
  const [status, setStatus] = React.useState<PushStatus>("checking")
  const [permission, setPermission] =
    React.useState<NotificationPermission>("default")
  const [unsupportedReason, setUnsupportedReason] =
    React.useState<PushUnsupportedReason | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const refresh =
    React.useCallback(async (): Promise<PushRefreshResult | null> => {
      if (typeof window === "undefined") return null
      const reason = getPushUnsupportedReason()
      setUnsupportedReason(reason)
      if (reason) {
        const currentPermission =
          "Notification" in window ? Notification.permission : "default"
        setStatus("unsupported")
        setError(null)
        setPermission(currentPermission)
        return {
          status: "unsupported",
          permission: currentPermission,
          unsupportedReason: reason,
          error: null,
        }
      }

      setPermission(Notification.permission)
      if (Notification.permission === "denied") {
        setStatus("blocked")
        setError(null)
        return {
          status: "blocked",
          permission: "denied",
          unsupportedReason: null,
          error: null,
        }
      }

      try {
        const registration = await registerServiceWorker()
        const subscription = await registration.pushManager.getSubscription()
        let nextStatus: PushStatus = "ready"
        if (Notification.permission === "granted") {
          if (subscription) await syncSubscriptionIfNeeded(subscription)
          else await ensurePushSubscription()
          nextStatus = "enabled"
        } else if (subscription) {
          await syncSubscriptionIfNeeded(subscription)
          nextStatus = "enabled"
        }
        setStatus(nextStatus)
        setError(null)
        return {
          status: nextStatus,
          permission: Notification.permission,
          unsupportedReason: null,
          error: null,
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "Push setup failed"
        setStatus("error")
        setError(message)
        return {
          status: "error",
          permission: Notification.permission,
          unsupportedReason: null,
          error: message,
        }
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

      await ensurePushSubscription({ forceSave: true })
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
