"use client"

import * as React from "react"
import {
  CheckCircle2,
  CircleAlert,
  CircleStop,
  FileAudio,
  Loader2,
  PanelRightOpen,
  Sparkles,
} from "lucide-react"

import { MarkdownRenderer } from "@/components/markdown-renderer"
import type { AgentCallReasoningEntry, ReasoningEntry } from "@/lib/types"
import { cn } from "@/lib/utils"

export const AUDIO_CONTEXT_AGENT_ID = "audio_context_agent"
const PANEL_BODY_CLASS =
  "h-[132px] overflow-x-hidden overflow-y-auto overscroll-contain pr-1 [scrollbar-gutter:stable] sm:h-[148px]"

export function AudioContextAgentCard({
  entry,
  onOpen,
}: {
  entry: AgentCallReasoningEntry
  onOpen?: (entry: AgentCallReasoningEntry) => void
}) {
  const content = agentContent(entry)
  const thinking = collectThoughtText(entry.reasoning)
  const meta = parsePromptMeta(entry.prompt)
  const running = entry.status === "running"
  const hasContent = content.trim().length > 0
  const hasThinking = thinking.trim().length > 0
  const status = audioStatus(entry, hasContent, hasThinking)
  const duration = formatDuration(entry.startedAt, entry.endedAt)

  return (
    <div className="relative z-10 flex max-w-full items-start gap-3 bg-background py-1 text-left">
      <div
        className={cn(
          "mt-[3px] flex size-4 shrink-0 items-center justify-center rounded-full bg-background",
          status.tone === "error"
            ? "text-destructive"
            : status.tone === "stopped"
              ? "text-muted-foreground"
              : running
                ? "text-cyan-600 dark:text-cyan-400"
                : "text-emerald-600 dark:text-emerald-400"
        )}
      >
        {status.tone === "error" ? (
          <CircleAlert className="size-4" />
        ) : status.tone === "stopped" ? (
          <CircleStop className="size-4" />
        ) : running ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <CheckCircle2 className="size-4" />
        )}
      </div>

      <div className="relative min-w-0 flex-1 overflow-hidden rounded-md border border-cyan-500/20 bg-background text-foreground shadow-sm ring-1 ring-border/40">
        <div
          className={cn(
            "absolute inset-y-0 left-0 w-1",
            status.tone === "error"
              ? "bg-destructive/70"
              : status.tone === "stopped"
                ? "bg-muted-foreground/35"
                : running
                  ? "bg-cyan-500/70"
                  : "bg-emerald-500/70"
          )}
        />

        <div className="flex min-w-0 items-start gap-3 px-3 py-2.5 pl-4">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-md border border-cyan-500/20 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300">
            <FileAudio className="size-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <span className="min-w-0 truncate text-[14px] font-semibold tracking-tight text-foreground">
                Gemini Audio Context
              </span>
              <span
                className={cn(
                  "inline-flex shrink-0 items-center rounded-full border px-1.5 py-0.5 text-[10.5px] font-medium",
                  status.className
                )}
              >
                {status.label}
              </span>
            </div>
            <div className="mt-0.5 flex min-w-0 flex-wrap gap-x-2 gap-y-0.5 text-[11.5px] text-muted-foreground">
              <span className="max-w-full truncate">{meta.filename ?? entry.agentName}</span>
              {meta.mime && <span className="shrink-0">mime {meta.mime}</span>}
              {duration && <span className="min-w-8 shrink-0 tabular-nums">{duration}</span>}
            </div>
          </div>

          <AudioBars active={running} />

          {onOpen && (
            <button
              type="button"
              onClick={() => onOpen(entry)}
              className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              aria-label="Open audio context details"
              title="Open audio context details"
            >
              <PanelRightOpen className="size-4" />
            </button>
          )}
        </div>

        <div className="border-t border-border/60 px-3 py-2.5 pl-4">
          <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            <Sparkles className="size-3.5" />
            Gemini thinking
          </div>
          <div
            className={cn(
              PANEL_BODY_CLASS,
              "border-l-2 border-cyan-500/25 pl-3 text-[12.5px] leading-relaxed text-muted-foreground"
            )}
          >
            {hasThinking ? (
              <MarkdownRenderer content={thinking} compact />
            ) : running ? (
              <LiveLines />
            ) : (
              <p className="text-[12.5px] text-muted-foreground/70">
                No separate thinking stream was returned.
              </p>
            )}
          </div>
        </div>

        <div className="border-t border-border/60 px-3 py-2.5 pl-4">
          <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Transcript and overview
          </div>
          <div className={cn(PANEL_BODY_CLASS, "text-[13px] leading-relaxed text-foreground/85")}>
            {hasContent ? (
              <MarkdownRenderer content={content} compact />
            ) : running ? (
              <LiveLines />
            ) : (
              <p className="text-[12.5px] text-muted-foreground/70">
                No audio report was returned.
              </p>
            )}
          </div>
        </div>

        {entry.error && (
          <div className="border-t border-destructive/25 bg-destructive/5 px-3 py-2 pl-4 text-[12.5px] text-destructive">
            {entry.error}
          </div>
        )}
      </div>
    </div>
  )
}

function AudioBars({ active }: { active: boolean }) {
  const bars = [10, 16, 8, 18, 12]
  return (
    <div
      className="hidden h-8 shrink-0 items-center gap-0.5 rounded-md border border-border/60 bg-muted/20 px-2 sm:flex"
      aria-hidden="true"
    >
      {bars.map((height, index) => (
        <span
          key={`${height}-${index}`}
          className={cn(
            "w-1 rounded-full bg-cyan-500/70",
            active && "animate-pulse"
          )}
          style={{
            height,
            animationDelay: `${index * 120}ms`,
            animationDuration: "760ms",
          }}
        />
      ))}
    </div>
  )
}

function LiveLines({ compact = false }: { compact?: boolean }) {
  return (
    <div className={cn("space-y-1.5", compact ? "py-1" : "py-1.5")}>
      <div className="h-2.5 w-4/5 animate-pulse rounded-full bg-muted-foreground/15" />
      <div className="h-2.5 w-11/12 animate-pulse rounded-full bg-muted-foreground/10 [animation-delay:120ms]" />
      <div className="h-2.5 w-2/3 animate-pulse rounded-full bg-muted-foreground/10 [animation-delay:240ms]" />
    </div>
  )
}

function agentContent(entry: AgentCallReasoningEntry): string {
  const segmented = entry.contentSegments?.map((segment) => segment.content).join("") ?? ""
  return entry.content || segmented
}

function collectThoughtText(reasoning?: ReasoningEntry[]): string {
  if (!reasoning?.length) return ""
  const chunks: string[] = []
  for (const item of reasoning) {
    if (item.type === "thought" && item.content.trim()) {
      chunks.push(item.content.trim())
    } else if (item.type === "agent_call") {
      const nested = collectThoughtText(item.reasoning)
      if (nested) chunks.push(nested)
    }
  }
  return chunks.join("\n\n")
}

function parsePromptMeta(prompt: string): { filename?: string; mime?: string } {
  return {
    filename: readPromptLine(prompt, "Filename"),
    mime: readPromptLine(prompt, "MIME type"),
  }
}

function readPromptLine(prompt: string, label: string): string | undefined {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const match = prompt.match(new RegExp(`^${escaped}:\\s*(.+)$`, "im"))
  return match?.[1]?.trim() || undefined
}

function formatDuration(startedAt: number, endedAt?: number): string | null {
  if (!Number.isFinite(startedAt)) return null
  const end = endedAt && Number.isFinite(endedAt) ? endedAt : Date.now()
  const seconds = Math.max(0, Math.round((end - startedAt) / 1000))
  if (seconds <= 0) return null
  return `${seconds}s`
}

function audioStatus(
  entry: AgentCallReasoningEntry,
  hasContent: boolean,
  hasThinking: boolean
): { label: string; tone: "running" | "ok" | "error" | "stopped"; className: string } {
  if (entry.status === "error") {
    return {
      label: "Failed",
      tone: "error",
      className: "border-destructive/30 bg-destructive/10 text-destructive",
    }
  }
  if (entry.status === "aborted") {
    return {
      label: "Stopped",
      tone: "stopped",
      className: "border-border bg-muted text-muted-foreground",
    }
  }
  if (entry.status === "running") {
    return {
      label: hasContent ? "Writing report" : hasThinking ? "Thinking live" : "Starting",
      tone: "running",
      className: "border-cyan-500/30 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300",
    }
  }
  return {
    label: "Ready",
    tone: "ok",
    className: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  }
}
