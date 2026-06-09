"use client"

import * as React from "react"
import Link from "next/link"
import {
  Check,
  Download,
  ExternalLink,
  Music,
  Pause,
  Play,
  Square,
} from "lucide-react"

import { cn } from "@/lib/utils"
import type { LibrarySelectionProps } from "./attachments-tab"
import {
  formatBytes,
  formatRelativeTime,
  libraryItemSourceLabel,
  libraryItemUrl,
  type LibraryAttachment,
} from "./use-attachments"

/**
 * Audio attachments rendered as a list with inline play controls.
 *
 * Each row owns its own `<audio>` element and play/pause state. Only one
 * audio plays at a time — clicking play on a new row pauses any other
 * currently-playing row via a shared module-level Set of refs.
 *
 * Duration is loaded lazily via the audio element's `loadedmetadata` event
 * — no extra fetch, just probes the file the browser is about to play
 * anyway.
 */

const activeRefs = new Set<HTMLAudioElement>()

export function AudioList({
  attachments,
  selection,
  className,
}: {
  attachments: LibraryAttachment[]
  selection?: LibrarySelectionProps
  className?: string
}) {
  return (
    <ul
      className={cn("flex flex-col gap-1.5", className)}
      aria-label="Audio list"
    >
      {attachments.map((a) => (
        <AudioRow
          key={a.id}
          attachment={a}
          selected={selection?.selectedIds.has(a.id) ?? false}
          selectionMode={selection?.selectionMode ?? false}
          onToggleSelection={selection?.onToggleSelection}
        />
      ))}
    </ul>
  )
}

function AudioRow({
  attachment,
  selected,
  selectionMode,
  onToggleSelection,
}: {
  attachment: LibraryAttachment
  selected: boolean
  selectionMode: boolean
  onToggleSelection?: (id: string) => void
}) {
  const audioRef = React.useRef<HTMLAudioElement | null>(null)
  const [playing, setPlaying] = React.useState(false)
  const [duration, setDuration] = React.useState<number | null>(null)
  const [progressSec, setProgressSec] = React.useState(0)

  const togglePlay = React.useCallback(async () => {
    const el = audioRef.current
    if (!el) return
    if (playing) {
      el.pause()
      return
    }
    // Pause any others.
    for (const other of activeRefs) {
      if (other !== el) other.pause()
    }
    try {
      await el.play()
    } catch {
      /* user cancelled / network */
    }
  }, [playing])

  React.useEffect(() => {
    const el = audioRef.current
    if (!el) return
    activeRefs.add(el)
    const onPlay = () => setPlaying(true)
    const onPause = () => setPlaying(false)
    const onLoaded = () => {
      if (Number.isFinite(el.duration)) setDuration(el.duration)
    }
    const onTime = () => setProgressSec(el.currentTime)
    const onEnded = () => setPlaying(false)
    el.addEventListener("play", onPlay)
    el.addEventListener("pause", onPause)
    el.addEventListener("loadedmetadata", onLoaded)
    el.addEventListener("timeupdate", onTime)
    el.addEventListener("ended", onEnded)
    return () => {
      el.removeEventListener("play", onPlay)
      el.removeEventListener("pause", onPause)
      el.removeEventListener("loadedmetadata", onLoaded)
      el.removeEventListener("timeupdate", onTime)
      el.removeEventListener("ended", onEnded)
      activeRefs.delete(el)
    }
  }, [])

  const progressPct =
    duration && duration > 0 ? (progressSec / duration) * 100 : 0
  const fileUrl = libraryItemUrl(attachment)
  const chatHref =
    attachment.conversationId && attachment.messageId
      ? `/?chat=${encodeURIComponent(attachment.conversationId)}&msg=${encodeURIComponent(attachment.messageId)}`
      : null

  return (
    <li
      className={cn(
        "overflow-hidden rounded-xl border border-border/55 bg-card shadow-sm transition-colors",
        selected && "border-primary ring-2 ring-primary/20"
      )}
    >
      <div className="flex items-center gap-3 px-4 py-2.5">
        {selectionMode ? (
          <button
            type="button"
            onClick={() => onToggleSelection?.(attachment.id)}
            aria-label={
              selected
                ? `Deselect ${attachment.filename}`
                : `Select ${attachment.filename}`
            }
            aria-pressed={selected}
            className={cn(
              "grid size-7 shrink-0 place-items-center rounded-md transition-colors",
              selected
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground"
            )}
          >
            {selected ? (
              <Check className="size-4" />
            ) : (
              <Square className="size-4" />
            )}
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => void togglePlay()}
          aria-label={
            playing
              ? `Pause ${attachment.filename}`
              : `Play ${attachment.filename}`
          }
          className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-full transition-colors",
            playing
              ? "bg-primary text-primary-foreground"
              : "bg-muted text-foreground hover:bg-muted/70"
          )}
        >
          {playing ? (
            <Pause className="size-4" />
          ) : (
            <Play className="size-4 translate-x-[1px]" />
          )}
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="inline-flex items-center gap-1 text-sm font-medium text-foreground">
              <Music
                className="size-3.5 text-muted-foreground"
                strokeWidth={1.85}
                aria-hidden
              />
              <span className="truncate">{attachment.filename}</span>
            </span>
            <span className="text-[11px] text-muted-foreground tabular-nums">
              {formatBytes(attachment.size)}
              {duration !== null ? <> · {formatDuration(duration)}</> : null}
            </span>
          </div>
          <div className="mt-1.5 flex items-center gap-2">
            <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted/55">
              <div
                className="h-full bg-primary transition-[width] duration-150 ease-linear"
                style={{ width: `${progressPct}%` }}
              />
            </div>
            {playing && duration !== null ? (
              <span className="shrink-0 text-[10.5px] text-muted-foreground tabular-nums">
                {formatDuration(progressSec)} / {formatDuration(duration)}
              </span>
            ) : (
              <span className="shrink-0 text-[10.5px] text-muted-foreground">
                {formatRelativeTime(attachment.messageTimestamp)} ·{" "}
                <span className="truncate">
                  {libraryItemSourceLabel(attachment)}
                </span>
              </span>
            )}
          </div>
        </div>
        {chatHref ? (
          <Link
            href={chatHref}
            title="View in chat"
            aria-label="View in chat"
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <ExternalLink className="size-3.5" />
          </Link>
        ) : (
          <a
            href={fileUrl}
            download={attachment.filename}
            title="Download"
            aria-label="Download"
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <Download className="size-3.5" />
          </a>
        )}
      </div>
      <audio ref={audioRef} src={fileUrl} preload="metadata" />
    </li>
  )
}

function formatDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "0:00"
  const s = Math.floor(sec % 60)
  const m = Math.floor(sec / 60) % 60
  const h = Math.floor(sec / 3600)
  const pad2 = (n: number) => n.toString().padStart(2, "0")
  if (h > 0) return `${h}:${pad2(m)}:${pad2(s)}`
  return `${m}:${pad2(s)}`
}
