"use client"

import * as React from "react"
import { BellRing, Loader2, RefreshCw, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  useInboxPushNotifications,
  type PushStatus,
  type PushUnsupportedReason,
} from "@/hooks/use-inbox-push-notifications"
import { cn } from "@/lib/utils"

const SNOOZE_KEY = "orchestrator:notification-prompt-snoozed"
const SNOOZE_MS = 24 * 60 * 60 * 1000

type PlatformKind = "ios" | "mac" | "mobile" | "desktop"
type PromptKind = "ready" | "blocked" | "unsupported" | "error"

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

function readSnooze(): { kind: PromptKind; until: number } | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(SNOOZE_KEY) ?? "null")
    if (
      parsed &&
      typeof parsed.kind === "string" &&
      typeof parsed.until === "number"
    ) {
      return parsed
    }
  } catch {
    // Storage is optional; show the prompt if we cannot read the snooze state.
  }
  return null
}

function writeSnooze(kind: PromptKind) {
  try {
    localStorage.setItem(
      SNOOZE_KEY,
      JSON.stringify({ kind, until: Date.now() + SNOOZE_MS })
    )
  } catch {
    // Best-effort only.
  }
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
  platform: PlatformKind
): string {
  if (reason === "insecure-context") {
    return "Open the secure HTTPS app URL to enable push notifications on this device."
  }
  if (platform === "ios") {
    return "Install Orchestrator to the Home Screen, then reopen it to enable mobile push notifications."
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
}): { title: string; body: string; action: string | null } {
  const { kind, platform, permission, unsupportedReason, error } = args

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
      title: "Notifications unavailable",
      body: unsupportedMessage(unsupportedReason, platform),
      action: "Check",
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
  const [dismissedKind, setDismissedKind] = React.useState<PromptKind | null>(
    null
  )

  React.useEffect(() => {
    setMounted(true)
    setPlatform(detectPlatform())
  }, [])

  const kind = promptKindFromStatus(status)

  React.useEffect(() => {
    if (!mounted || !kind) return
    const snooze = readSnooze()
    if (snooze?.kind === kind && snooze.until > Date.now()) {
      setDismissedKind(kind)
    } else if (dismissedKind === kind) {
      setDismissedKind(null)
    }
  }, [dismissedKind, kind, mounted])

  if (!mounted || !kind || dismissedKind === kind) return null

  const copy = promptCopy({
    kind,
    platform,
    permission,
    unsupportedReason,
    error,
  })
  const hasEnableAction = kind === "ready" || kind === "error"
  const onPrimaryAction = () => {
    if (hasEnableAction) void enable()
    else void refresh()
  }
  const onDismiss = () => {
    writeSnooze(kind)
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
                disabled={busy}
                className="h-8"
              >
                {busy ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : kind === "ready" || kind === "error" ? (
                  <BellRing className="size-3.5" />
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
