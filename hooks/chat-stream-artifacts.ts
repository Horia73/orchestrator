import type { JsonSseEvent } from "./chat-stream-sse"

export type ArtifactStreamEventName =
  | "orch:artifact"
  | "orch:artifact-start"
  | "orch:artifact-chunk"
  | "orch:artifact-error"

export type ArtifactStreamEventEmitter = (
  name: ArtifactStreamEventName,
  detail: unknown
) => void

const emitWindowEvent: ArtifactStreamEventEmitter = (name, detail) => {
  if (typeof window === "undefined") return
  window.dispatchEvent(new CustomEvent(name, { detail }))
}

/** Bridge artifact SSE events into the artifact provider's browser events. */
export function handleArtifactStreamEvent(
  data: JsonSseEvent,
  messageId: string,
  emit: ArtifactStreamEventEmitter = emitWindowEvent
): boolean {
  switch (data.type) {
    case "artifact_end":
      if (data.artifact) emit("orch:artifact", data.artifact)
      return true
    case "artifact_start":
      if (data.clientToken && data.attrs) {
        emit("orch:artifact-start", {
          clientToken: data.clientToken,
          messageId,
          attrs: data.attrs,
        })
      }
      return true
    case "artifact_chunk":
      if (data.clientToken && typeof data.content === "string") {
        emit("orch:artifact-chunk", {
          clientToken: data.clientToken,
          content: data.content,
        })
      }
      return true
    case "artifact_error":
      console.warn("Artifact parse error:", data.message)
      if (typeof data.clientToken === "string") {
        emit("orch:artifact-error", {
          clientToken: data.clientToken,
          message: typeof data.message === "string" ? data.message : undefined,
        })
      }
      return true
    default:
      return false
  }
}
