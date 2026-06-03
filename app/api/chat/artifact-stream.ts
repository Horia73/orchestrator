import { ArtifactParser } from "@/lib/artifacts/parser"
import type { ArtifactOpenAttrs } from "@/lib/artifacts/schema"
import { insertArtifact } from "@/lib/artifacts/store"
import { stripWrappingCodeFence } from "@/lib/artifacts/sanitize"

type SendChatEvent = (data: Record<string, unknown>) => void

interface PendingArtifact {
  attrs: ArtifactOpenAttrs
  content: string
}

export function createArtifactStreamBridge({
  conversationId,
  messageId,
  send,
}: {
  conversationId: string
  messageId: string
  send: SendChatEvent
}) {
  const artifactParser = new ArtifactParser()
  const pendingArtifacts = new Map<string, PendingArtifact>()

  const persistArtifact = (
    clientToken: string,
    pending: PendingArtifact,
    stripFence: boolean
  ) => {
    try {
      const row = insertArtifact({
        conversationId,
        messageId,
        identifier: pending.attrs.identifier,
        type: pending.attrs.type,
        title: pending.attrs.title,
        language: pending.attrs.language ?? null,
        display: pending.attrs.display ?? null,
        content: stripFence
          ? stripWrappingCodeFence(pending.content)
          : pending.content,
      })
      send({
        type: "artifact_end",
        clientToken,
        artifact: row,
      })
    } catch (err) {
      send({
        type: "artifact_error",
        clientToken,
        message: err instanceof Error ? err.message : "persist failed",
      })
    }
  }

  return {
    feed(text: string) {
      for (const ev of artifactParser.feed(text)) {
        switch (ev.kind) {
          case "prose":
            break
          case "artifact_start":
            pendingArtifacts.set(ev.clientToken, {
              attrs: ev.attrs,
              content: "",
            })
            send({
              type: "artifact_start",
              clientToken: ev.clientToken,
              attrs: ev.attrs,
            })
            break
          case "artifact_chunk": {
            const pending = pendingArtifacts.get(ev.clientToken)
            if (pending) pending.content += ev.text
            break
          }
          case "artifact_end": {
            const pending = pendingArtifacts.get(ev.clientToken)
            pendingArtifacts.delete(ev.clientToken)
            if (pending) persistArtifact(ev.clientToken, pending, true)
            else send({ type: "artifact_end", clientToken: ev.clientToken })
            break
          }
          case "artifact_error":
            send({ type: "artifact_error", message: ev.message })
            break
        }
      }
    },

    flush() {
      for (const ev of artifactParser.end()) {
        if (ev.kind === "prose") {
          // Unterminated tag bytes already went through the raw content stream.
        } else if (ev.kind === "artifact_chunk") {
          const pending = pendingArtifacts.get(ev.clientToken)
          if (pending) pending.content += ev.text
        } else if (ev.kind === "artifact_end") {
          const pending = pendingArtifacts.get(ev.clientToken)
          pendingArtifacts.delete(ev.clientToken)
          if (pending) persistArtifact(ev.clientToken, pending, false)
          else send({ type: "artifact_end", clientToken: ev.clientToken })
        } else if (ev.kind === "artifact_error") {
          send({ type: "artifact_error", message: ev.message })
        }
      }
    },
  }
}
