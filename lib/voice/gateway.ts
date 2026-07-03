// Voice gateway: accepts the browser's WebSocket at /api/voice/ws and pairs
// it with a Gemini Live session. In production the custom server
// (scripts/start.mjs) owns HTTP upgrade dispatch and delegates to the hook
// this module registers on globalThis — start.mjs is plain JS and cannot
// import TS modules, while this module lives inside the Next bundle in the
// same process. In `next dev` there is no custom server, so a small
// loopback listener on VOICE_DEV_PORT serves the same endpoint.

import http from "http"
import type { IncomingMessage } from "http"
import type { Duplex } from "stream"

import { WebSocketServer, WebSocket } from "ws"

import { getApiKey } from "@/lib/config"
import { getProfile, getProfileSessionByToken } from "@/lib/profiles/store"
import { PROFILE_SESSION_COOKIE } from "@/lib/profiles/constants"
import { VoiceLiveSession } from "@/lib/voice/live-session"
import {
  parseVoiceClientMessage,
  type VoiceServerMessage,
} from "@/lib/voice/schema"
import { voiceSettingsFromConfig } from "@/lib/voice/tools"
import { runWithProfileContext } from "@/lib/profiles/context"

export const VOICE_WS_PATH = "/api/voice/ws"
export const VOICE_DEV_PORT = 3210

const PING_INTERVAL_MS = 20_000

type VoiceUpgradeHandler = (
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer
) => boolean

declare global {
  var __orchestratorVoiceUpgrade: VoiceUpgradeHandler | undefined
}

const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false })

export function registerVoiceGateway(): void {
  globalThis.__orchestratorVoiceUpgrade = handleVoiceUpgrade
  if (process.env.NODE_ENV === "development") {
    startDevListener()
  }
}

export function handleVoiceUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer
): boolean {
  const pathname = parsePathname(req.url)
  if (pathname !== VOICE_WS_PATH) return false

  const auth = authenticate(req)
  if (!auth) {
    rejectUpgrade(socket, 401, "Profile session required.")
    return true
  }
  const enabled = runWithProfileContext(
    { profileId: auth.profileId, role: auth.role },
    () => voiceSettingsFromConfig().enabled && !!getApiKey("google")
  )
  if (!enabled) {
    rejectUpgrade(socket, 409, "Voice mode is disabled or Google API key missing.")
    return true
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    attachVoiceClient(ws, auth)
  })
  return true
}

interface VoiceAuth {
  profileId: string
  role: "admin" | "member"
}

function authenticate(req: IncomingMessage): VoiceAuth | null {
  const token = readCookie(req.headers.cookie, PROFILE_SESSION_COOKIE)
  if (!token) return null
  const session = getProfileSessionByToken(token)
  if (!session) return null
  const profile = getProfile(session.profileId)
  if (!profile || profile.disabledAt) return null
  return { profileId: profile.id, role: profile.role }
}

function attachVoiceClient(ws: WebSocket, auth: VoiceAuth): void {
  let session: VoiceLiveSession | null = null
  let alive = true

  const send = (message: VoiceServerMessage) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message))
    }
  }
  const sendAudio = (chunk: Buffer) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(chunk, { binary: true })
    }
  }

  const pingTimer = setInterval(() => {
    if (!alive) {
      ws.terminate()
      return
    }
    alive = false
    ws.ping()
  }, PING_INTERVAL_MS)
  ws.on("pong", () => {
    alive = true
  })

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      session?.sendAudioChunk(asBuffer(data))
      return
    }
    const message = parseVoiceClientMessage(data.toString())
    if (!message) return
    if (message.type === "start" && !session) {
      session = new VoiceLiveSession({
        profileId: auth.profileId,
        role: auth.role,
        send,
        sendAudio,
        onClose: () => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.close(1000, "session-ended")
          }
        },
      })
      session.start().catch((err) => {
        console.error("[voice] session start failed", err)
        send({ type: "error", message: "Voice session failed to start.", fatal: true })
        ws.close(1011, "start-failed")
      })
      return
    }
    if (message.type === "end") {
      session?.finish("client-ended")
      session = null
    }
  })

  ws.on("close", () => {
    clearInterval(pingTimer)
    session?.finish("socket-closed")
    session = null
  })
  ws.on("error", (err) => {
    console.error("[voice] client socket error", err)
  })
}

// In dev there is no custom server owning `upgrade`, so expose the same
// endpoint on a loopback port. The client asks /api/voice/config which
// endpoint to use.
let devServer: http.Server | null = null

function startDevListener(): void {
  if (devServer) return
  devServer = http.createServer((req, res) => {
    res.statusCode = 426
    res.end("WebSocket endpoint")
  })
  devServer.on("upgrade", (req, socket, head) => {
    if (!handleVoiceUpgrade(req, socket, head)) socket.destroy()
  })
  devServer.on("error", (err) => {
    console.error("[voice] dev listener error", err)
  })
  devServer.listen(VOICE_DEV_PORT, "0.0.0.0", () => {
    console.log(`[voice] dev gateway listening on :${VOICE_DEV_PORT}`)
  })
}

function parsePathname(url: string | undefined): string {
  try {
    return new URL(url || "/", "http://voice.local").pathname
  } catch {
    return "/"
  }
}

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null
  for (const part of header.split(";")) {
    const index = part.indexOf("=")
    if (index <= 0) continue
    if (part.slice(0, index).trim() !== name) continue
    const raw = part.slice(index + 1).trim()
    try {
      return decodeURIComponent(raw)
    } catch {
      return raw
    }
  }
  return null
}

function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  const reason = http.STATUS_CODES[status] ?? "Error"
  const body = `${message}\n`
  socket.end(
    [
      `HTTP/1.1 ${status} ${reason}`,
      "Connection: close",
      "Content-Type: text/plain; charset=utf-8",
      `Content-Length: ${Buffer.byteLength(body)}`,
      "",
      body,
    ].join("\r\n")
  )
}

function asBuffer(data: unknown): Buffer {
  if (Buffer.isBuffer(data)) return data
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[])
  if (data instanceof ArrayBuffer) return Buffer.from(data)
  return Buffer.from(String(data))
}
