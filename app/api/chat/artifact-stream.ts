import { ArtifactParser } from "@/lib/artifacts/parser"
import type { ArtifactOpenAttrs, ArtifactRow } from "@/lib/artifacts/schema"
import { insertArtifact } from "@/lib/artifacts/store"
import { stripWrappingCodeFence } from "@/lib/artifacts/sanitize"
import { isStrictArtifactType } from "@/lib/artifacts/validation"

type SendChatEvent = (data: Record<string, unknown>) => void

interface PendingArtifact {
  attrs: ArtifactOpenAttrs
  content: string
}

/**
 * A strict-schema artifact that failed validation on persist. Held back from a
 * hard `artifact_error` so the chat route's in-turn repair pass can try to fix
 * it before the turn finishes. While it sits here the client keeps showing the
 * streaming placeholder (no draft was dropped), so the user never sees a broken
 * card flash.
 */
export interface PendingArtifactRepair {
  clientToken: string
  attrs: ArtifactOpenAttrs
  /** The content that was handed to `insertArtifact` (post-fence-strip). */
  content: string
  /** The exact validation error that rejected it. */
  error: string
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
  const pendingRepairs: PendingArtifactRepair[] = []

  const persistArtifact = (
    clientToken: string,
    pending: PendingArtifact,
    stripFence: boolean
  ) => {
    const content = stripFence
      ? stripWrappingCodeFence(pending.content)
      : pending.content
    try {
      const row = insertArtifact({
        conversationId,
        messageId,
        identifier: pending.attrs.identifier,
        type: pending.attrs.type,
        title: pending.attrs.title,
        language: pending.attrs.language ?? null,
        display: pending.attrs.display ?? null,
        content,
      })
      send({
        type: "artifact_end",
        clientToken,
        artifact: row,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : "persist failed"
      // Strict-schema types get one shot at an in-turn repair before we tell
      // the client it failed. Defer instead of emitting `artifact_error` so the
      // draft (and its streaming placeholder) stays put; the route's repair
      // pass will either commit a fixed row or report the failure.
      if (isStrictArtifactType(pending.attrs.type)) {
        pendingRepairs.push({ clientToken, attrs: pending.attrs, content, error: message })
        send({ type: "artifact_repairing", clientToken, attrs: pending.attrs })
      } else {
        send({ type: "artifact_error", clientToken, message })
      }
    }
  }

  const commitRepairedArtifact = (
    repair: PendingArtifactRepair,
    content: string
  ): ArtifactRow | null => {
    try {
      const row = insertArtifact({
        conversationId,
        messageId,
        identifier: repair.attrs.identifier,
        type: repair.attrs.type,
        title: repair.attrs.title,
        language: repair.attrs.language ?? null,
        display: repair.attrs.display ?? null,
        content,
      })
      send({ type: "artifact_end", clientToken: repair.clientToken, artifact: row })
      return row
    } catch (err) {
      send({
        type: "artifact_error",
        clientToken: repair.clientToken,
        message: err instanceof Error ? err.message : "persist failed",
      })
      return null
    }
  }

  return {
    hasPendingRepairs() {
      return pendingRepairs.length > 0
    },
    /** Drain the deferred failures so the route can repair them once. */
    takePendingRepairs(): PendingArtifactRepair[] {
      return pendingRepairs.splice(0, pendingRepairs.length)
    },
    /** Persist a repaired body and emit the final card to the client. */
    commitRepairedArtifact,
    /** Give up on a deferred failure and surface the (precise) error. */
    reportRepairFailure(clientToken: string, message: string) {
      send({ type: "artifact_error", clientToken, message })
    },
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
