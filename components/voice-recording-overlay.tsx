"use client"

import * as React from "react"
import { ArrowUp, Mic, Pause, Trash2 } from "lucide-react"
import { useVoiceRecorder } from "@/hooks/use-voice-recorder"
import { cn, formatDuration } from "@/lib/utils"

const MAX_BARS = 120
const SAMPLE_MS = 100

interface VoiceRecordingProps {
  isChat: boolean
  onSend: (blob: Blob, mimeType: string) => void
  onDismiss: () => void
}

/**
 * Self-contained voice recording UI. Renders:
 * - Waveform / status overlay (to be placed inside a grid cell overlaying the textarea)
 * - Left button (cancel) and right buttons (pause/send) for the bottom bar
 *
 * Parent is responsible for layout — this component renders fragments via `renderOverlay`,
 * `renderLeftButton`, and `renderRightButtons` so the parent can slot them into its existing layout.
 */
export function useVoiceRecording({
  isChat,
  onSend,
  onDismiss,
}: VoiceRecordingProps) {
  const {
    state: recorderState,
    error: recorderError,
    getAmplitude,
    getDuration,
    startRecording,
    stopRecording,
    cancelRecording,
    pauseRecording,
    resumeRecording,
  } = useVoiceRecorder()

  const [waveformBars, setWaveformBars] = React.useState<number[]>([])
  const [recordingDuration, setRecordingDuration] = React.useState(0)
  const waveformHistoryRef = React.useRef<number[]>([])
  const getAmplitudeRef = React.useRef(getAmplitude)
  const getDurationRef = React.useRef(getDuration)
  React.useEffect(() => {
    getAmplitudeRef.current = getAmplitude
  }, [getAmplitude])
  React.useEffect(() => {
    getDurationRef.current = getDuration
  }, [getDuration])

  // Waveform sampling
  React.useEffect(() => {
    if (recorderState !== "recording") return
    const id = setInterval(() => {
      const amp = getAmplitudeRef.current()
      const height = Math.min(100, Math.max(8, amp * 500))
      const history = waveformHistoryRef.current
      history.push(height)
      if (history.length > MAX_BARS) history.shift()
      setWaveformBars([...history])
      setRecordingDuration(getDurationRef.current())
    }, SAMPLE_MS)
    return () => clearInterval(id)
  }, [recorderState])

  // Freeze duration on pause
  React.useEffect(() => {
    if (recorderState === "paused") {
      setRecordingDuration(getDurationRef.current())
    }
  }, [recorderState])

  // Auto-dismiss on error
  React.useEffect(() => {
    if (recorderState === "error") {
      const t = setTimeout(onDismiss, 2000)
      return () => clearTimeout(t)
    }
  }, [recorderState, onDismiss])

  const start = React.useCallback(() => {
    waveformHistoryRef.current = []
    setWaveformBars([])
    setRecordingDuration(0)
    startRecording()
  }, [startRecording])

  const handleSend = React.useCallback(async () => {
    const result = await stopRecording()
    if (result) onSend(result.blob, result.mimeType)
    onDismiss()
  }, [stopRecording, onSend, onDismiss])

  const handleCancel = React.useCallback(() => {
    cancelRecording()
    onDismiss()
  }, [cancelRecording, onDismiss])

  const handleTogglePause = React.useCallback(() => {
    if (recorderState === "recording") pauseRecording()
    else if (recorderState === "paused") resumeRecording()
  }, [recorderState, pauseRecording, resumeRecording])

  const showWaveform =
    recorderState === "recording" || recorderState === "paused"
  const showStatus = recorderState === "requesting" || recorderState === "error"
  const isActive = showWaveform || showStatus

  const overlay = isActive ? (
    <>
      {showWaveform && (
        <div
          style={{ gridArea: "1 / 1", zIndex: 1 }}
          className={cn(
            "flex min-w-0 items-center gap-2.5 overflow-hidden px-5",
            isChat ? "min-h-[46px] pt-3.5 pb-2" : "min-h-[66px] pt-[19px]"
          )}
        >
          <span
            className={cn(
              "size-2 shrink-0 rounded-full bg-red-500",
              recorderState === "paused" ? "opacity-35" : "animate-pulse"
            )}
          />
          <div className="flex h-6 min-w-0 flex-1 items-center justify-end gap-[2px] overflow-hidden">
            {waveformBars.map((h, i) => (
              <div
                key={i}
                className="w-[3px] shrink-0 rounded-[1.5px] bg-[#b76440] transition-all duration-75"
                style={{
                  height: `${h > 0 ? Math.max(8, h) : 0}%`,
                  opacity: h > 0 ? 1 : 0,
                }}
              />
            ))}
          </div>
          <span className="min-w-[36px] shrink-0 text-center text-[14px] text-muted-foreground tabular-nums">
            {formatDuration(recordingDuration)}
          </span>
        </div>
      )}
      {showStatus && (
        <div
          style={{ gridArea: "1 / 1", zIndex: 1 }}
          className={cn(
            "flex items-center px-5 text-[14px]",
            isChat ? "min-h-[46px]" : "min-h-[66px]",
            recorderState === "error" ? "text-red-500" : "text-muted-foreground"
          )}
        >
          {recorderState === "error"
            ? recorderError || "Could not access microphone."
            : "Requesting microphone access…"}
        </div>
      )}
    </>
  ) : null

  const leftButton = (
    <button
      type="button"
      onClick={handleCancel}
      className="flex size-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/50 hover:text-red-500"
      aria-label="Cancel recording"
    >
      <Trash2 className="size-5" strokeWidth={1.5} />
    </button>
  )

  const rightButtons = (
    <>
      {showWaveform && (
        <button
          type="button"
          onClick={handleTogglePause}
          className="flex size-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
          aria-label={recorderState === "paused" ? "Resume" : "Pause"}
        >
          {recorderState === "paused" ? (
            <Mic className="size-5 stroke-[1.2]" />
          ) : (
            <Pause className="size-5" strokeWidth={1.5} />
          )}
        </button>
      )}
      <button
        type="button"
        onClick={handleSend}
        className="flex size-8 items-center justify-center rounded-[11px] bg-[#b76440] text-white transition-colors hover:bg-[#a55837]"
        aria-label="Send voice message"
      >
        <ArrowUp className="size-[17px] stroke-[2.5]" />
      </button>
    </>
  )

  return { start, isActive, overlay, leftButton, rightButtons }
}
