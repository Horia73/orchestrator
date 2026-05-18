"use client"

import * as React from "react"

type PushStatus =
  | "checking"
  | "unsupported"
  | "ready"
  | "enabled"
  | "blocked"
  | "error"

function urlBase64ToApplicationServerKey(value: string): ArrayBuffer {
  const padding = "=".repeat((4 - (value.length % 4)) % 4)
  const base64 = `${value}${padding}`.replace(/-/g, "+").replace(/_/g, "/")
  const raw = window.atob(base64)
  const buffer = new ArrayBuffer(raw.length)
  const output = new Uint8Array(buffer)
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i)
  return buffer
}

function hasPushSupport(): boolean {
  return (
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  )
}

async function registerServiceWorker(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration("/")
  return existing ?? navigator.serviceWorker.register("/sw.js", { scope: "/" })
}

export function useInboxPushNotifications() {
  const [status, setStatus] = React.useState<PushStatus>("checking")
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const refresh = React.useCallback(async () => {
    if (typeof window === "undefined") return
    if (!hasPushSupport()) {
      setStatus("unsupported")
      return
    }
    if (Notification.permission === "denied") {
      setStatus("blocked")
      return
    }

    try {
      const registration = await registerServiceWorker()
      const subscription = await registration.pushManager.getSubscription()
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

  const enable = React.useCallback(async () => {
    if (!hasPushSupport()) {
      setStatus("unsupported")
      return
    }

    setBusy(true)
    setError(null)
    try {
      const permission =
        Notification.permission === "granted"
          ? "granted"
          : await Notification.requestPermission()
      if (permission !== "granted") {
        setStatus(permission === "denied" ? "blocked" : "ready")
        return
      }

      const registration = await registerServiceWorker()
      let subscription = await registration.pushManager.getSubscription()
      if (!subscription) {
        const keyRes = await fetch("/api/push/vapid-public-key", {
          cache: "no-store",
        })
        if (!keyRes.ok) throw new Error("Push configuration is unavailable")
        const { publicKey } = (await keyRes.json()) as { publicKey?: string }
        if (!publicKey) throw new Error("Push public key is unavailable")

        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToApplicationServerKey(publicKey),
        })
      }

      const saveRes = await fetch("/api/push/subscriptions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subscription: subscription.toJSON() }),
      })
      if (!saveRes.ok) throw new Error("Push subscription could not be saved")

      setStatus("enabled")
    } catch (err) {
      setStatus("error")
      setError(err instanceof Error ? err.message : "Push setup failed")
    } finally {
      setBusy(false)
    }
  }, [])

  return { status, busy, error, enable, refresh }
}
