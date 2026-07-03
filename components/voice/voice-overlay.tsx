"use client"

import * as React from "react"
import {
  Bot,
  Check,
  Globe,
  House,
  Mic,
  MicOff,
  PhoneOff,
  Power,
  Wrench,
  X,
} from "lucide-react"

import { useVoiceSession, type VoiceActivityEntry } from "@/hooks/use-voice-session"
import { cn } from "@/lib/utils"

function activityIcon(name: string) {
  if (name.startsWith("home_assistant")) return House
  if (name === "google_search") return Globe
  if (name === "delegate_to_orchestrator") return Bot
  if (name === "end_conversation") return Power
  return Wrench
}

const ACTIVITY_LABELS: Record<string, string> = {
  home_assistant_find_entities: "Finding devices",
  home_assistant_get_state: "Reading device state",
  home_assistant_control: "Controlling the home",
  google_search: "Searched the web",
  delegate_to_orchestrator: "Delegating a background task",
  end_conversation: "Wrapping up",
}

function activityLabel(name: string): string {
  return ACTIVITY_LABELS[name] ?? name.replaceAll("_", " ")
}

function ActivityFeed({ entries }: { entries: VoiceActivityEntry[] }) {
  if (!entries.length) return null
  return (
    <div className="flex w-full max-w-sm flex-col gap-1">
      {entries.slice(-4).map((entry) => {
        const Icon = activityIcon(entry.name)
        return (
          <div
            key={entry.id}
            className="flex items-center gap-2 rounded-lg bg-muted/50 px-3 py-1.5 text-[12.5px] text-muted-foreground animate-in fade-in slide-in-from-bottom-1 duration-200"
          >
            <Icon className="size-3.5 shrink-0" strokeWidth={1.5} />
            <span className="min-w-0 flex-1 truncate">{activityLabel(entry.name)}</span>
            {entry.status === "running" ? (
              <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-[#b76440]" />
            ) : entry.status === "done" ? (
              <Check className="size-3.5 shrink-0 text-emerald-600" strokeWidth={2} />
            ) : (
              <X className="size-3.5 shrink-0 text-red-500" strokeWidth={2} />
            )}
          </div>
        )
      })}
    </div>
  )
}

interface VoiceOverlayProps {
  open: boolean
  onClose: () => void
}

/** Full-screen live voice mode: hold a spoken conversation with the
 *  assistant (Gemini Live through the local voice gateway). */
export function VoiceOverlay({ open, onClose }: VoiceOverlayProps) {
  const session = useVoiceSession()
  const { start, stop } = session
  const startedRef = React.useRef(false)

  React.useEffect(() => {
    if (open && !startedRef.current) {
      startedRef.current = true
      void start()
    }
    if (!open && startedRef.current) {
      startedRef.current = false
      stop()
    }
  }, [open, start, stop])

  const handleEnd = React.useCallback(() => {
    stop()
    onClose()
  }, [stop, onClose])

  React.useEffect(() => {
    if (!open) return
    if (session.state === "ended") {
      const timer = setTimeout(onClose, 600)
      return () => clearTimeout(timer)
    }
  }, [open, session.state, onClose])

  if (!open) return null

  const statusLabel =
    session.state === "connecting"
      ? "Connecting…"
      : session.state === "listening"
        ? "Listening"
        : session.state === "speaking"
          ? "Speaking"
          : session.state === "error"
            ? "Something went wrong"
            : session.state === "ended"
              ? "Call ended"
              : ""

  return (
    <div
      className="fixed inset-0 z-[100] flex flex-col bg-background/95 backdrop-blur-sm animate-in fade-in duration-200"
      style={{
        paddingTop: "env(safe-area-inset-top)",
        paddingBottom: "env(safe-area-inset-bottom)",
      }}
    >
      <div className="flex flex-1 flex-col items-center justify-center gap-8 px-6">
        <div className="relative flex items-center justify-center">
          <div
            className={cn(
              "absolute size-40 rounded-full bg-[#b76440]/15 transition-transform duration-500",
              session.state === "speaking" && "scale-125 animate-pulse",
              session.state === "listening" && "scale-105",
              session.state === "connecting" && "animate-pulse"
            )}
          />
          <div
            className={cn(
              "relative flex size-28 items-center justify-center rounded-full bg-[#b76440] text-white shadow-lg transition-transform duration-300",
              session.state === "speaking" && "scale-110"
            )}
          >
            <Mic className="size-10 stroke-[1.4]" />
          </div>
        </div>

        <div className="flex flex-col items-center gap-2 text-center">
          <span className="text-[15px] font-medium text-foreground">
            {statusLabel}
          </span>
          <ActivityFeed entries={session.activity} />
          {session.error && (
            <span className="max-w-sm text-[13px] text-red-500">{session.error}</span>
          )}
        </div>

        <div className="flex min-h-[88px] w-full max-w-md flex-col items-center justify-end gap-2 text-center">
          {session.userCaption && (
            <p className="text-[14px] text-muted-foreground line-clamp-2">
              {session.userCaption}
            </p>
          )}
          {session.assistantCaption && (
            <p className="text-[15px] text-foreground line-clamp-4">
              {session.assistantCaption}
            </p>
          )}
        </div>
      </div>

      <div className="flex items-center justify-center gap-6 pb-12 pt-4">
        <button
          type="button"
          onClick={session.toggleMute}
          className={cn(
            "flex size-14 items-center justify-center rounded-full border transition-colors",
            session.muted
              ? "border-red-500/40 bg-red-500/10 text-red-500"
              : "border-border bg-muted/40 text-foreground hover:bg-muted"
          )}
          aria-label={session.muted ? "Unmute" : "Mute"}
        >
          {session.muted ? (
            <MicOff className="size-6" strokeWidth={1.5} />
          ) : (
            <Mic className="size-6" strokeWidth={1.5} />
          )}
        </button>
        <button
          type="button"
          onClick={handleEnd}
          className="flex size-14 items-center justify-center rounded-full bg-red-500 text-white transition-colors hover:bg-red-600"
          aria-label="End voice chat"
        >
          <PhoneOff className="size-6" strokeWidth={1.5} />
        </button>
      </div>
    </div>
  )
}
