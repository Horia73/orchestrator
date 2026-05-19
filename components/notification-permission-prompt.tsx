"use client"

import * as React from "react"
import { usePathname } from "next/navigation"
import { BellRing, Loader2, RefreshCw, ShieldCheck, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  useInboxPushNotifications,
  type PushStatus,
  type PushUnsupportedReason,
} from "@/hooks/use-inbox-push-notifications"
import { cn } from "@/lib/utils"

const CERT_SETUP_HOSTS = new Set(["orchestrator.lan"])

type PlatformKind = "ios" | "mac" | "mobile" | "desktop"
type PromptKind = "ready" | "blocked" | "unsupported" | "error"

interface BrowserLocationInfo {
  origin: string
  certSetupUrl: string | null
}

function detectPlatform(): PlatformKind {
  const ua = navigator.userAgent
  const platform = navigator.platform
  const appleTouchDevice =
    platform === "MacIntel" && navigator.maxTouchPoints > 1

  if (/iPad|iPhone|iPod/.test(ua) || appleTouchDevice) return "ios"
  if (/Mac/.test(platform)) return "mac"
  if (/Android|Mobile|IEMobile|Opera Mini/i.test(ua)) return "mobile"
  return "desktop"
}

function getBrowserLocationInfo(): BrowserLocationInfo {
  if (typeof window === "undefined") {
    return { origin: "", certSetupUrl: null }
  }

  const url = new URL(window.location.href)
  const hasLanSetup = CERT_SETUP_HOSTS.has(url.hostname.toLowerCase())
  if (!hasLanSetup) {
    return { origin: window.location.origin, certSetupUrl: null }
  }

  url.protocol = "http:"
  url.port = ""
  url.pathname = "/cert-setup"
  url.search = ""
  url.hash = ""
  return { origin: window.location.origin, certSetupUrl: url.toString() }
}

function promptKindFromStatus(status: PushStatus): PromptKind | null {
  if (status === "ready") return "ready"
  if (status === "blocked") return "blocked"
  if (status === "unsupported") return "unsupported"
  if (status === "error") return "error"
  return null
}

function unsupportedMessage(
  reason: PushUnsupportedReason | null,
  platform: PlatformKind,
  locationInfo: BrowserLocationInfo
): string {
  if (reason === "insecure-context") {
    if (locationInfo.certSetupUrl) {
      return "Install the Orchestrator LAN certificate on this device, then open the HTTPS app to enable push notifications."
    }
    return `This page is using an insecure URL${
      locationInfo.origin ? ` (${locationInfo.origin})` : ""
    }. Open Orchestrator over HTTPS to enable push notifications.`
  }
  if (reason === "ios-pwa-required") {
    return "On iPhone or iPad, open the HTTPS URL in Safari, add Orchestrator to the Home Screen, then enable notifications from the Home Screen app."
  }
  if (platform === "ios") {
    return "Open Orchestrator from the Home Screen app to enable mobile push notifications."
  }
  if (reason === "push-manager") {
    return "This browser cannot receive Web Push for this app. Use a current browser with push support."
  }
  if (reason === "service-worker") {
    return "Service workers are disabled in this browser, so background notifications cannot start."
  }
  return "This browser cannot receive push notifications for this app."
}

function promptCopy(args: {
  kind: PromptKind
  platform: PlatformKind
  permission: NotificationPermission
  unsupportedReason: PushUnsupportedReason | null
  error: string | null
  locationInfo: BrowserLocationInfo
}): { title: string; body: string; action: string | null } {
  const { kind, platform, permission, unsupportedReason, error, locationInfo } =
    args

  if (kind === "blocked") {
    const macBody =
      "Allow this site in your browser and macOS notification settings, then check again."
    return {
      title: "Notifications are blocked",
      body:
        platform === "mac"
          ? macBody
          : "Allow notifications for Orchestrator in this browser, then check again.",
      action: "Check",
    }
  }

  if (kind === "unsupported") {
    return {
      title:
        unsupportedReason === "insecure-context"
          ? "HTTPS setup required"
          : "Notifications unavailable",
      body: unsupportedMessage(unsupportedReason, platform, locationInfo),
      action:
        unsupportedReason === "insecure-context" ? "Setup HTTPS" : "Check",
    }
  }

  if (kind === "error") {
    return {
      title: "Notifications need attention",
      body: error ?? "Push setup did not finish. Try again.",
      action: "Retry",
    }
  }

  const title =
    platform === "mac"
      ? "Enable Mac notifications"
      : platform === "ios" || platform === "mobile"
        ? "Enable mobile notifications"
        : "Enable notifications"

  return {
    title,
    body:
      permission === "granted"
        ? "Finish push setup so Inbox alerts arrive when scheduled runs complete."
        : "Get Inbox alerts when scheduled runs complete, even when Orchestrator is in the background.",
    action: "Enable",
  }
}

export function NotificationPermissionPrompt() {
  const pathname = usePathname()
  if (pathname === "/cert-setup") return null

  return <NotificationPermissionPromptInner />
}

function NotificationPermissionPromptInner() {
  const {
    status,
    permission,
    unsupportedReason,
    busy,
    error,
    enable,
    refresh,
  } = useInboxPushNotifications()
  const [mounted, setMounted] = React.useState(false)
  const [platform, setPlatform] = React.useState<PlatformKind>("desktop")
  const [locationInfo, setLocationInfo] = React.useState<BrowserLocationInfo>({
    origin: "",
    certSetupUrl: null,
  })
  const [dismissedKind, setDismissedKind] = React.useState<PromptKind | null>(
    null
  )
  const [checking, setChecking] = React.useState(false)
  const [checkMessage, setCheckMessage] = React.useState<string | null>(null)

  React.useEffect(() => {
    const nextLocationInfo = getBrowserLocationInfo()
    setLocationInfo(nextLocationInfo)
    setMounted(true)
    setPlatform(detectPlatform())
  }, [])

  const kind = promptKindFromStatus(status)

  React.useEffect(() => {
    if (!kind || dismissedKind === kind) return
    if (dismissedKind) {
      setDismissedKind(null)
      setCheckMessage(null)
    }
  }, [dismissedKind, kind])

  if (!mounted || !kind || dismissedKind === kind) return null

  const copy = promptCopy({
    kind,
    platform,
    permission,
    unsupportedReason,
    error,
    locationInfo,
  })
  const hasEnableAction = kind === "ready" || kind === "error"
  const onPrimaryAction = async () => {
    setCheckMessage(null)
    if (kind === "unsupported" && unsupportedReason === "insecure-context") {
      const nextLocationInfo = getBrowserLocationInfo()
      setLocationInfo(nextLocationInfo)
      window.location.assign(nextLocationInfo.certSetupUrl ?? "/cert-setup")
      return
    }

    if (hasEnableAction) {
      void enable()
      return
    }

    const nextLocationInfo = getBrowserLocationInfo()
    setLocationInfo(nextLocationInfo)

    setChecking(true)
    const result = await refresh()
    setChecking(false)
    if (result?.status === "ready" || result?.status === "enabled") return

    const checkedReason = result?.unsupportedReason ?? unsupportedReason
    if (checkedReason === "insecure-context") {
      setCheckMessage(
        "Still using HTTP. Open Orchestrator through the HTTPS reverse proxy."
      )
    } else if (checkedReason === "ios-pwa-required") {
      setCheckMessage(
        "Still in the browser tab. Open it from the Home Screen app, then check again."
      )
    } else if (result?.status === "blocked" || kind === "blocked") {
      setCheckMessage("Still blocked. Change browser or system settings first.")
    } else if (result?.status === "error") {
      setCheckMessage(result.error ?? "Push setup still needs attention.")
    } else {
      setCheckMessage(
        "Checked again. The current browser state did not change."
      )
    }
  }
  const onDismiss = () => {
    setCheckMessage(null)
    setDismissedKind(kind)
  }

  return (
    <section
      role="status"
      aria-live="polite"
      className={cn(
        "fixed right-3 bottom-[calc(4.75rem+env(safe-area-inset-bottom))] left-3 z-50 rounded-lg border border-border/70 bg-background/95 p-3 text-foreground shadow-[0_12px_40px_-24px_rgba(0,0,0,0.45)] backdrop-blur md:top-4 md:right-4 md:bottom-auto md:left-auto md:w-[360px]"
      )}
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-foreground text-background">
          <BellRing className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <h2 className="text-[13.5px] leading-tight font-semibold">
                {copy.title}
              </h2>
              <p className="mt-1 text-[12px] leading-relaxed text-foreground/60">
                {copy.body}
              </p>
              {checkMessage && (
                <p className="mt-2 text-[12px] leading-relaxed font-medium text-foreground/70">
                  {checkMessage}
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={onDismiss}
              aria-label="Dismiss notification prompt"
              className="flex size-7 shrink-0 items-center justify-center rounded-md text-foreground/45 hover:bg-muted hover:text-foreground"
            >
              <X className="size-4" />
            </button>
          </div>
          <div className="mt-3 flex items-center gap-2">
            {copy.action && (
              <Button
                type="button"
                size="sm"
                onClick={onPrimaryAction}
                disabled={busy || checking}
                className="h-8"
              >
                {busy || checking ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : kind === "ready" || kind === "error" ? (
                  <BellRing className="size-3.5" />
                ) : unsupportedReason === "insecure-context" ? (
                  <ShieldCheck className="size-3.5" />
                ) : (
                  <RefreshCw className="size-3.5" />
                )}
                {copy.action}
              </Button>
            )}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onDismiss}
              className="h-8"
            >
              Not now
            </Button>
          </div>
        </div>
      </div>
    </section>
  )
}
