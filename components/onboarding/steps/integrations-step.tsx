"use client"

import * as React from "react"
import { Mail, Calendar, FolderOpen, MessageCircle, Home, Check, Loader2 } from "lucide-react"

import { cn } from "@/lib/utils"
import { useChatStore } from "@/hooks/use-chat-store"
import { useIntegrationsStatus, type IntegrationsStatus } from "@/components/settings/use-integrations-status"
import { OnboardingFooter } from "@/components/onboarding/onboarding-chrome"
import { useOnboarding } from "@/components/onboarding/onboarding-context"
import { OnboardingChatPanel } from "@/components/onboarding/onboarding-chat-panel"

interface IntegrationDef {
  /** Manifest id passed to activateIntegrations. */
  manifestId: string
  /** Key into IntegrationsStatus. */
  statusKey: keyof Pick<
    IntegrationsStatus,
    "gmail" | "googleCalendar" | "googleDrive" | "whatsapp" | "homeAssistant"
  >
  label: string
  icon: React.ComponentType<{ className?: string }>
  needsHttps: boolean
}

const INTEGRATIONS: IntegrationDef[] = [
  { manifestId: "gmail", statusKey: "gmail", label: "Gmail", icon: Mail, needsHttps: true },
  { manifestId: "google-calendar", statusKey: "googleCalendar", label: "Calendar", icon: Calendar, needsHttps: true },
  { manifestId: "google-workspace", statusKey: "googleDrive", label: "Drive & Docs", icon: FolderOpen, needsHttps: true },
  { manifestId: "whatsapp", statusKey: "whatsapp", label: "WhatsApp", icon: MessageCircle, needsHttps: false },
  { manifestId: "home-assistant", statusKey: "homeAssistant", label: "Home Assistant", icon: Home, needsHttps: false },
]

export function IntegrationsStep() {
  const { data: onb, setData } = useOnboarding()
  const { sendMessage } = useChatStore()
  const { data: status, refresh } = useIntegrationsStatus()
  const [convId, setConvId] = React.useState<string | null>(null)

  const opener = React.useMemo(() => {
    const name = onb.userName?.trim()
    return `Hi${name ? ` — I'm ${name}` : ""}! I just finished setting up Orchestrator. Can you welcome me and help me connect my tools?`
  }, [onb.userName])

  const handleConversationId = React.useCallback(
    (id: string) => {
      setConvId(id)
      setData({ bootConversationId: id })
    },
    [setData],
  )

  const handleSetup = React.useCallback(
    (def: IntegrationDef) => {
      if (!convId) return
      sendMessage(`Help me connect ${def.label}.`, undefined, undefined, {
        activateIntegrations: [def.manifestId],
        promptContextSource: "Onboarding",
      })
      // Re-poll status shortly after so the card flips to Connected once done.
      window.setTimeout(() => void refresh(), 4000)
    },
    [convId, sendMessage, refresh],
  )

  const isConnected = (def: IntegrationDef): boolean => {
    const entry = status?.[def.statusKey] as { connected?: boolean } | undefined
    return entry?.connected === true
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 gap-5 px-6 pb-2">
        {/* Left: integration cards */}
        <div className="flex w-[320px] shrink-0 flex-col overflow-y-auto pt-2">
          <h1 className="font-display text-xl font-semibold tracking-tight text-foreground">
            Connect your tools
          </h1>
          <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
            Click a tool and your assistant will walk you through it, right here. Or just chat.
          </p>
          <div className="mt-5 space-y-2">
            {INTEGRATIONS.map((def) => {
              const connected = isConnected(def)
              const blocked = def.needsHttps && !onb.httpsConfigured
              const Icon = def.icon
              return (
                <div
                  key={def.manifestId}
                  className={cn(
                    "flex items-center gap-3 rounded-xl border border-border/60 bg-card/40 px-3 py-2.5",
                    blocked && "opacity-60",
                  )}
                >
                  <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-foreground">{def.label}</div>
                    {blocked ? (
                      <div className="text-[11px] text-amber-600 dark:text-amber-400">needs HTTPS</div>
                    ) : null}
                  </div>
                  {connected ? (
                    <span className="flex items-center gap-1 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                      <Check className="h-3.5 w-3.5" /> Connected
                    </span>
                  ) : (
                    <button
                      type="button"
                      disabled={blocked || !convId}
                      onClick={() => handleSetup(def)}
                      className="rounded-md border border-border/60 bg-background px-2.5 py-1 text-xs font-medium text-foreground transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {!convId ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Set up"}
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        </div>

        {/* Right: live assistant chat */}
        <div className="min-h-0 flex-1 pt-2 pb-2">
          <OnboardingChatPanel opener={opener} onConversationId={handleConversationId} />
        </div>
      </div>

      <div className="border-t border-border/60 bg-background/80 px-6 py-4 backdrop-blur">
        <OnboardingFooter primaryLabel="Finish" />
      </div>
    </div>
  )
}
