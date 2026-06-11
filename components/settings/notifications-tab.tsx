"use client"

import * as React from "react"
import {
  BellRing,
  CheckCircle2,
  Laptop,
  Loader2,
  RefreshCcw,
  Send,
  Smartphone,
  Trash2,
  XCircle,
} from "lucide-react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  useInboxPushNotifications,
  type PushStatus,
  type PushUnsupportedReason,
} from "@/hooks/use-inbox-push-notifications"

interface SubscriptionRow {
  id: string
  endpoint: string
  userAgent: string | null
  createdAt: number
  updatedAt: number
}

interface TestResult {
  endpoint: string
  ok: boolean
  statusCode: number | null
  removed: boolean
  error: string | null
}

interface Feedback {
  tone: "success" | "error" | "info"
  text: string
}

function describeDevice(userAgent: string | null): {
  label: string
  mobile: boolean
} {
  const ua = userAgent ?? ""
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Firefox\//.test(ua)
      ? "Firefox"
      : /Chrome\//.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua)
          ? "Safari"
          : "Browser"
  const os = /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua)
      ? "iPad"
      : /Android/.test(ua)
        ? "Android"
        : /Macintosh|Mac OS X/.test(ua)
          ? "macOS"
          : /Windows/.test(ua)
            ? "Windows"
            : /Linux/.test(ua)
              ? "Linux"
              : "Unknown device"
  const mobile = /iPhone|iPad|Android|Mobile/.test(ua)
  return { label: `${browser} on ${os}`, mobile }
}

function pushServiceName(endpoint: string): string {
  if (endpoint.includes("push.apple.com")) return "Apple Push"
  if (endpoint.includes("fcm.googleapis.com")) return "Google FCM"
  if (endpoint.includes("mozilla.com")) return "Mozilla Push"
  return "Push service"
}

function formatTimestamp(value: number): string {
  return new Date(value).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  })
}

function statusBadge(status: PushStatus): { label: string; className: string } {
  switch (status) {
    case "enabled":
      return {
        label: "Enabled",
        className: "bg-emerald-500/12 text-emerald-600 dark:text-emerald-400",
      }
    case "ready":
      return { label: "Not enabled", className: "bg-muted text-foreground/60" }
    case "blocked":
      return {
        label: "Blocked",
        className: "bg-red-500/12 text-red-600 dark:text-red-400",
      }
    case "unsupported":
      return {
        label: "Unsupported",
        className: "bg-amber-500/12 text-amber-600 dark:text-amber-400",
      }
    case "error":
      return {
        label: "Error",
        className: "bg-red-500/12 text-red-600 dark:text-red-400",
      }
    default:
      return { label: "Checking…", className: "bg-muted text-foreground/50" }
  }
}

function unsupportedHelp(reason: PushUnsupportedReason | null): string {
  if (reason === "insecure-context")
    return "This page is served over an insecure URL. Open Orchestrator over HTTPS to enable push notifications."
  if (reason === "ios-pwa-required")
    return "On iPhone or iPad, add Orchestrator to the Home Screen from Safari and enable notifications from the installed app."
  if (reason === "service-worker")
    return "Service workers are disabled in this browser, so background notifications cannot start."
  if (reason === "push-manager" || reason === "notification-api")
    return "This browser cannot receive Web Push for this app. Use a current browser with push support."
  return "This browser cannot receive push notifications for this app."
}

export function NotificationsTab() {
  const { status, permission, unsupportedReason, busy, error, enable, refresh } =
    useInboxPushNotifications()
  const [localEndpoint, setLocalEndpoint] = React.useState<string | null>(null)
  const [subscriptions, setSubscriptions] = React.useState<SubscriptionRow[]>([])
  const [loadingList, setLoadingList] = React.useState(true)
  const [listError, setListError] = React.useState<string | null>(null)
  const [feedback, setFeedback] = React.useState<Feedback | null>(null)
  const [pendingAction, setPendingAction] = React.useState<string | null>(null)

  const readLocalEndpoint = React.useCallback(async () => {
    try {
      const registration = await navigator.serviceWorker?.getRegistration("/")
      const subscription = await registration?.pushManager.getSubscription()
      setLocalEndpoint(subscription?.endpoint ?? null)
    } catch {
      setLocalEndpoint(null)
    }
  }, [])

  const loadSubscriptions = React.useCallback(async () => {
    setLoadingList(true)
    setListError(null)
    try {
      const res = await fetch("/api/push/subscriptions", { cache: "no-store" })
      if (!res.ok) throw new Error("Could not load registered devices")
      const data = (await res.json()) as { subscriptions?: SubscriptionRow[] }
      setSubscriptions(data.subscriptions ?? [])
    } catch (err) {
      setListError(
        err instanceof Error ? err.message : "Could not load registered devices"
      )
    } finally {
      setLoadingList(false)
    }
  }, [])

  React.useEffect(() => {
    void readLocalEndpoint()
    void loadSubscriptions()
  }, [readLocalEndpoint, loadSubscriptions])

  const refreshAll = React.useCallback(async () => {
    setFeedback(null)
    await refresh()
    await readLocalEndpoint()
    await loadSubscriptions()
  }, [refresh, readLocalEndpoint, loadSubscriptions])

  const handleEnable = async () => {
    setFeedback(null)
    const enabled = await enable()
    await readLocalEndpoint()
    await loadSubscriptions()
    if (enabled) {
      setFeedback({
        tone: "success",
        text: "Notifications enabled on this device.",
      })
    }
  }

  const sendTest = async (endpoint: string | null, deviceLabel: string) => {
    setPendingAction(endpoint ? `test:${endpoint}` : "test:all")
    setFeedback(null)
    try {
      const res = await fetch("/api/push/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(endpoint ? { endpoint } : {}),
      })
      if (!res.ok) throw new Error("Test request failed")
      const data = (await res.json()) as { results?: TestResult[] }
      const results = data.results ?? []
      if (results.length === 0) {
        setFeedback({
          tone: "error",
          text: `No subscription found for ${deviceLabel}. Re-enable notifications first.`,
        })
        return
      }
      const failed = results.filter((r) => !r.ok)
      if (failed.length === 0) {
        setFeedback({
          tone: "success",
          text: `Push service accepted the test for ${deviceLabel}. If no notification appeared within a few seconds, the device's browser or OS is blocking display.`,
        })
      } else {
        const removed = failed.filter((r) => r.removed)
        setFeedback({
          tone: "error",
          text: removed.length
            ? `The subscription for ${deviceLabel} is expired and was removed. Re-enable notifications on that device.`
            : `Push service rejected the test for ${deviceLabel}: ${failed[0].error ?? `status ${failed[0].statusCode}`}`,
        })
      }
      await loadSubscriptions()
    } catch (err) {
      setFeedback({
        tone: "error",
        text: err instanceof Error ? err.message : "Test request failed",
      })
    } finally {
      setPendingAction(null)
    }
  }

  const resetThisDevice = async () => {
    setPendingAction("reset")
    setFeedback(null)
    try {
      const registration = await navigator.serviceWorker?.getRegistration("/")
      const subscription = await registration?.pushManager.getSubscription()
      if (subscription) {
        const endpoint = subscription.endpoint
        await subscription.unsubscribe()
        await fetch("/api/push/subscriptions", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint }),
        }).catch(() => undefined)
      }
      const result = await refresh()
      await readLocalEndpoint()
      await loadSubscriptions()
      setFeedback(
        result?.status === "enabled"
          ? {
              tone: "success",
              text: "Subscription reset. This device re-subscribed with a fresh endpoint.",
            }
          : {
              tone: "info",
              text: "Old subscription removed. Use Enable to subscribe again.",
            }
      )
    } catch (err) {
      setFeedback({
        tone: "error",
        text: err instanceof Error ? err.message : "Reset failed",
      })
    } finally {
      setPendingAction(null)
    }
  }

  const removeDevice = async (endpoint: string) => {
    setPendingAction(`remove:${endpoint}`)
    setFeedback(null)
    try {
      await fetch("/api/push/subscriptions", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint }),
      })
      await loadSubscriptions()
    } finally {
      setPendingAction(null)
    }
  }

  const badge = statusBadge(status)

  return (
    <div className="flex flex-col gap-6">
      <section className="rounded-xl border border-border/60 bg-background p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-foreground text-background">
              <BellRing className="size-4" />
            </div>
            <div className="min-w-0">
              <h2 className="text-[14px] font-semibold text-foreground">
                This device
              </h2>
              <p className="text-[12px] text-foreground/55">
                Browser permission:{" "}
                <span className="font-medium text-foreground/75">
                  {permission}
                </span>
                {localEndpoint && (
                  <>
                    {" · "}
                    {pushServiceName(localEndpoint)}
                  </>
                )}
              </p>
            </div>
          </div>
          <span
            className={cn(
              "rounded-full px-2.5 py-1 text-[11.5px] font-medium",
              badge.className
            )}
          >
            {badge.label}
          </span>
        </div>

        {status === "unsupported" && (
          <p className="mt-3 text-[12.5px] leading-relaxed text-foreground/65">
            {unsupportedHelp(unsupportedReason)}
          </p>
        )}

        {status === "blocked" && (
          <p className="mt-3 text-[12.5px] leading-relaxed text-foreground/65">
            Notifications are blocked for this site in the browser. Allow them
            in the browser&apos;s site settings, then come back and press
            Re-check.
          </p>
        )}

        {error && (
          <p className="mt-3 text-[12.5px] leading-relaxed text-red-600 dark:text-red-400">
            {error}
          </p>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-2">
          {(status === "ready" || status === "error") && (
            <Button
              type="button"
              size="sm"
              onClick={handleEnable}
              disabled={busy}
              className="h-8"
            >
              {busy ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <BellRing className="size-3.5" />
              )}
              Enable notifications
            </Button>
          )}
          {status === "enabled" && (
            <Button
              type="button"
              size="sm"
              onClick={() => sendTest(localEndpoint, "this device")}
              disabled={pendingAction !== null}
              className="h-8"
            >
              {pendingAction === `test:${localEndpoint}` ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Send className="size-3.5" />
              )}
              Send test notification
            </Button>
          )}
          {(status === "enabled" || status === "error") && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={resetThisDevice}
              disabled={pendingAction !== null}
              className="h-8"
            >
              {pendingAction === "reset" ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <RefreshCcw className="size-3.5" />
              )}
              Reset subscription
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={refreshAll}
            disabled={pendingAction !== null}
            className="h-8"
          >
            <RefreshCcw className="size-3.5" />
            Re-check
          </Button>
        </div>

        {feedback && (
          <p
            className={cn(
              "mt-3 flex items-start gap-1.5 text-[12.5px] leading-relaxed",
              feedback.tone === "success" &&
                "text-emerald-600 dark:text-emerald-400",
              feedback.tone === "error" && "text-red-600 dark:text-red-400",
              feedback.tone === "info" && "text-foreground/65"
            )}
          >
            {feedback.tone === "success" ? (
              <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" />
            ) : feedback.tone === "error" ? (
              <XCircle className="mt-0.5 size-3.5 shrink-0" />
            ) : null}
            {feedback.text}
          </p>
        )}
      </section>

      <section>
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="text-[13px] font-semibold text-foreground">
            Registered devices
          </h3>
          <p className="text-[12px] text-foreground/50 tabular-nums">
            {loadingList
              ? "Loading…"
              : `${subscriptions.length} ${subscriptions.length === 1 ? "subscription" : "subscriptions"}`}
          </p>
        </div>
        <p className="mt-1 text-[12px] text-foreground/55">
          Every device that enabled notifications gets its own subscription and
          receives all alerts. Stale entries are removed automatically when the
          push service reports them expired.
        </p>

        {listError && (
          <p className="mt-3 text-[12.5px] text-red-600 dark:text-red-400">
            {listError}
          </p>
        )}

        <div className="mt-3 flex flex-col gap-2">
          {subscriptions.map((row) => {
            const device = describeDevice(row.userAgent)
            const isThisDevice = row.endpoint === localEndpoint
            return (
              <div
                key={row.id}
                className="flex flex-wrap items-center gap-3 rounded-lg border border-border/60 bg-background px-3 py-2.5"
              >
                <div className="grid size-8 shrink-0 place-items-center rounded-md bg-muted text-foreground/70">
                  {device.mobile ? (
                    <Smartphone className="size-4" />
                  ) : (
                    <Laptop className="size-4" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 text-[13px] font-medium text-foreground">
                    {device.label}
                    {isThisDevice && (
                      <span className="rounded-full bg-foreground/10 px-2 py-0.5 text-[10.5px] font-medium text-foreground/70">
                        This device
                      </span>
                    )}
                  </p>
                  <p className="text-[11.5px] text-foreground/50">
                    {pushServiceName(row.endpoint)} · added{" "}
                    {formatTimestamp(row.createdAt)} · last sync{" "}
                    {formatTimestamp(row.updatedAt)}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => sendTest(row.endpoint, device.label)}
                    disabled={pendingAction !== null}
                    className="h-7 px-2 text-[12px]"
                    title="Send a test notification to this device"
                  >
                    {pendingAction === `test:${row.endpoint}` ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Send className="size-3.5" />
                    )}
                    Test
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => removeDevice(row.endpoint)}
                    disabled={pendingAction !== null}
                    className="h-7 px-2 text-[12px] text-foreground/55 hover:text-red-600 dark:hover:text-red-400"
                    title="Remove this subscription"
                  >
                    {pendingAction === `remove:${row.endpoint}` ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Trash2 className="size-3.5" />
                    )}
                  </Button>
                </div>
              </div>
            )
          })}
          {!loadingList && !listError && subscriptions.length === 0 && (
            <p className="rounded-lg border border-dashed border-border/60 px-3 py-4 text-center text-[12.5px] text-foreground/50">
              No devices registered yet. Enable notifications above to subscribe
              this device.
            </p>
          )}
        </div>
      </section>
    </div>
  )
}
