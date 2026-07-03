"use client"

// Client side of the live voice mode: streams mic audio (PCM16 @ 16 kHz) to
// the voice gateway over a WebSocket and plays back the model's PCM16 @ 24 kHz
// answer through a scheduled AudioBuffer queue. Capture and downsampling run
// in an AudioWorklet; interruption support just flushes the playback queue.

import * as React from "react"

export type VoiceSessionState =
  | "idle"
  | "connecting"
  | "listening"
  | "speaking"
  | "error"
  | "ended"

export interface VoiceCaption {
  role: "user" | "assistant"
  text: string
  final: boolean
}

export interface VoiceSessionHandle {
  state: VoiceSessionState
  error: string | null
  muted: boolean
  activeTool: string | null
  userCaption: string
  assistantCaption: string
  start: () => Promise<void>
  stop: () => void
  toggleMute: () => void
}

const OUTPUT_SAMPLE_RATE = 24_000
const TARGET_INPUT_RATE = 16_000

// Runs on the audio rendering thread: accumulates mic frames, downsamples to
// 16 kHz mono PCM16 and posts ~40 ms chunks to the main thread.
const CAPTURE_WORKLET_SOURCE = `
class VoiceCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buffer = []
    this.buffered = 0
    this.chunkSize = Math.max(1, Math.round(sampleRate * 0.04))
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (channel && channel.length) {
      this.buffer.push(channel.slice(0))
      this.buffered += channel.length
      if (this.buffered >= this.chunkSize) {
        const merged = new Float32Array(this.buffered)
        let offset = 0
        for (const part of this.buffer) {
          merged.set(part, offset)
          offset += part.length
        }
        this.buffer = []
        this.buffered = 0
        const ratio = sampleRate / ${TARGET_INPUT_RATE}
        const outLength = Math.floor(merged.length / ratio)
        const pcm = new Int16Array(outLength)
        for (let i = 0; i < outLength; i += 1) {
          const position = i * ratio
          const index = Math.floor(position)
          const next = Math.min(index + 1, merged.length - 1)
          const fraction = position - index
          const sample = merged[index] * (1 - fraction) + merged[next] * fraction
          const clamped = Math.max(-1, Math.min(1, sample))
          pcm[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff
        }
        this.port.postMessage(pcm.buffer, [pcm.buffer])
      }
    }
    return true
  }
}
registerProcessor("voice-capture", VoiceCaptureProcessor)
`

interface VoiceGatewayInfo {
  enabled: boolean
  configured: boolean
  wsPath: string
  devPort: number | null
}

export function useVoiceSession(): VoiceSessionHandle {
  const [state, setState] = React.useState<VoiceSessionState>("idle")
  const [error, setError] = React.useState<string | null>(null)
  const [muted, setMuted] = React.useState(false)
  const [activeTool, setActiveTool] = React.useState<string | null>(null)
  const [userCaption, setUserCaption] = React.useState("")
  const [assistantCaption, setAssistantCaption] = React.useState("")

  const wsRef = React.useRef<WebSocket | null>(null)
  const audioContextRef = React.useRef<AudioContext | null>(null)
  const mediaStreamRef = React.useRef<MediaStream | null>(null)
  const scheduledSourcesRef = React.useRef<Set<AudioBufferSourceNode>>(new Set())
  const playheadRef = React.useRef(0)
  const speakingCheckRef = React.useRef<number | null>(null)
  const wakeLockRef = React.useRef<{ release: () => Promise<void> } | null>(null)
  const stoppedRef = React.useRef(false)

  const cleanup = React.useCallback(() => {
    if (speakingCheckRef.current !== null) {
      window.clearInterval(speakingCheckRef.current)
      speakingCheckRef.current = null
    }
    for (const source of scheduledSourcesRef.current) {
      try {
        source.stop()
      } catch {
        // Source may already be done.
      }
    }
    scheduledSourcesRef.current.clear()
    playheadRef.current = 0
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop())
    mediaStreamRef.current = null
    void audioContextRef.current?.close().catch(() => undefined)
    audioContextRef.current = null
    if (wsRef.current && wsRef.current.readyState <= WebSocket.OPEN) {
      wsRef.current.close(1000, "client-stopped")
    }
    wsRef.current = null
    void wakeLockRef.current?.release().catch(() => undefined)
    wakeLockRef.current = null
  }, [])

  const stop = React.useCallback(() => {
    if (stoppedRef.current) return
    stoppedRef.current = true
    try {
      wsRef.current?.send(JSON.stringify({ type: "end" }))
    } catch {
      // Socket already closed.
    }
    cleanup()
    setState((current) => (current === "error" ? current : "ended"))
  }, [cleanup])

  const flushPlayback = React.useCallback(() => {
    for (const source of scheduledSourcesRef.current) {
      try {
        source.stop()
      } catch {
        // Already stopped.
      }
    }
    scheduledSourcesRef.current.clear()
    playheadRef.current = 0
  }, [])

  const enqueuePlayback = React.useCallback((chunk: ArrayBuffer) => {
    const ctx = audioContextRef.current
    if (!ctx || chunk.byteLength < 2) return
    const pcm = new Int16Array(chunk)
    const floats = new Float32Array(pcm.length)
    for (let i = 0; i < pcm.length; i += 1) {
      floats[i] = pcm[i] / (pcm[i] < 0 ? 0x8000 : 0x7fff)
    }
    const buffer = ctx.createBuffer(1, floats.length, OUTPUT_SAMPLE_RATE)
    buffer.copyToChannel(floats, 0)
    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.connect(ctx.destination)
    const startAt = Math.max(ctx.currentTime + 0.06, playheadRef.current)
    source.start(startAt)
    playheadRef.current = startAt + buffer.duration
    scheduledSourcesRef.current.add(source)
    source.onended = () => {
      scheduledSourcesRef.current.delete(source)
    }
  }, [])

  const start = React.useCallback(async () => {
    if (wsRef.current) return
    stoppedRef.current = false
    setError(null)
    setUserCaption("")
    setAssistantCaption("")
    setActiveTool(null)
    setState("connecting")
    try {
      const infoResponse = await fetch("/api/voice/config", { cache: "no-store" })
      if (!infoResponse.ok) throw new Error("Voice mode is unavailable.")
      const info = (await infoResponse.json()) as VoiceGatewayInfo
      if (!info.enabled) throw new Error("Voice mode is disabled in Settings.")
      if (!info.configured) throw new Error("Google API key is not configured.")

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      })
      mediaStreamRef.current = stream

      const ctx = new AudioContext()
      audioContextRef.current = ctx
      await ctx.resume()
      const workletUrl = URL.createObjectURL(
        new Blob([CAPTURE_WORKLET_SOURCE], { type: "application/javascript" })
      )
      try {
        await ctx.audioWorklet.addModule(workletUrl)
      } finally {
        URL.revokeObjectURL(workletUrl)
      }

      const wsUrl = info.devPort
        ? `ws://${window.location.hostname}:${info.devPort}${info.wsPath}`
        : `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}${info.wsPath}`
      const ws = new WebSocket(wsUrl)
      ws.binaryType = "arraybuffer"
      wsRef.current = ws

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "start" }))
      }
      ws.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) {
          enqueuePlayback(event.data)
          return
        }
        handleControlMessage(String(event.data))
      }
      ws.onerror = () => {
        if (stoppedRef.current) return
        setError("Voice connection failed.")
        setState("error")
        cleanup()
      }
      ws.onclose = () => {
        if (stoppedRef.current) return
        stoppedRef.current = true
        cleanup()
        setState((current) =>
          current === "error" ? current : current === "idle" ? current : "ended"
        )
      }

      const source = ctx.createMediaStreamSource(stream)
      const worklet = new AudioWorkletNode(ctx, "voice-capture")
      worklet.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(event.data)
      }
      // The worklet needs to stay in the rendering graph to process, but its
      // output must not be audible — route it through a muted gain node.
      const silent = ctx.createGain()
      silent.gain.value = 0
      source.connect(worklet)
      worklet.connect(silent)
      silent.connect(ctx.destination)

      speakingCheckRef.current = window.setInterval(() => {
        const context = audioContextRef.current
        if (!context) return
        setState((current) => {
          if (current !== "listening" && current !== "speaking") return current
          return playheadRef.current > context.currentTime ? "speaking" : "listening"
        })
      }, 150)

      try {
        const nav = navigator as Navigator & {
          wakeLock?: { request: (type: "screen") => Promise<{ release: () => Promise<void> }> }
        }
        wakeLockRef.current = (await nav.wakeLock?.request("screen")) ?? null
      } catch {
        wakeLockRef.current = null
      }
    } catch (err) {
      cleanup()
      setError(err instanceof Error ? err.message : "Could not start voice mode.")
      setState("error")
    }

    function handleControlMessage(raw: string) {
      let message: Record<string, unknown>
      try {
        message = JSON.parse(raw) as Record<string, unknown>
      } catch {
        return
      }
      switch (message.type) {
        case "ready":
        case "listening":
          setState("listening")
          break
        case "interrupted":
          flushPlayback()
          setState("listening")
          break
        case "transcript": {
          const text = typeof message.text === "string" ? message.text : ""
          if (message.role === "user") {
            setUserCaption(text)
            if (message.final) setAssistantCaption("")
          } else {
            setAssistantCaption(text)
          }
          break
        }
        case "tool":
          setActiveTool(message.status === "running" ? String(message.name ?? "") : null)
          break
        case "turn_complete":
          setActiveTool(null)
          break
        case "error": {
          const text =
            typeof message.message === "string" ? message.message : "Voice error."
          if (message.fatal) {
            stoppedRef.current = true
            cleanup()
            setError(text)
            setState("error")
          } else {
            setError(text)
          }
          break
        }
        case "closed":
          stoppedRef.current = true
          cleanup()
          setState("ended")
          break
        default:
          break
      }
    }
  }, [cleanup, enqueuePlayback, flushPlayback])

  const toggleMute = React.useCallback(() => {
    const stream = mediaStreamRef.current
    if (!stream) return
    const next = !muted
    for (const track of stream.getAudioTracks()) {
      track.enabled = !next
    }
    setMuted(next)
  }, [muted])

  React.useEffect(() => () => {
    stoppedRef.current = true
    cleanup()
  }, [cleanup])

  return {
    state,
    error,
    muted,
    activeTool,
    userCaption,
    assistantCaption,
    start,
    stop,
    toggleMute,
  }
}
