"use client"

import * as React from "react"
import { Eye, EyeOff, Loader2, ShieldCheck } from "lucide-react"

import { appPath } from "@/lib/app-path"
import { detectSecretCandidates } from "@/lib/secrets/detection"
import type { MessageSecretKind, MessageSecretRef } from "@/lib/types"
import { cn } from "@/lib/utils"

type SecretSegment = {
  type: "secret"
  id: string
  label: string
  kind: MessageSecretKind
  provisionalValue?: string
}

type TextSegment = { type: "text"; value: string }

export function ChatSecretText({
  content,
  messageId,
  conversationId,
  secretRefs,
}: {
  content: string
  messageId: string
  conversationId?: string
  secretRefs?: MessageSecretRef[]
}) {
  const segments = React.useMemo(
    () => buildSegments(content, secretRefs),
    [content, secretRefs]
  )
  const segmentSignature = React.useMemo(
    () => segments
      .filter((segment): segment is SecretSegment => segment.type === "secret")
      .map((segment) => segment.id)
      .join("|"),
    [segments]
  )
  const [visibleIds, setVisibleIds] = React.useState<Set<string>>(
    () => new Set()
  )
  const [revealedValues, setRevealedValues] = React.useState<
    Record<string, string>
  >({})
  const [loadingId, setLoadingId] = React.useState<string | null>(null)
  const [errorId, setErrorId] = React.useState<string | null>(null)

  React.useEffect(() => {
    // An optimistic raw message is replaced in-place by its persisted marker.
    // Drop any value the user briefly revealed from component memory at that
    // boundary (and whenever the referenced secret set changes).
    setVisibleIds(new Set())
    setRevealedValues({})
    setLoadingId(null)
    setErrorId(null)
  }, [content, messageId, segmentSignature])

  const toggleSecret = React.useCallback(
    async (segment: SecretSegment) => {
      if (visibleIds.has(segment.id)) {
        setVisibleIds((current) => {
          const next = new Set(current)
          next.delete(segment.id)
          return next
        })
        setRevealedValues((current) => {
          if (!(segment.id in current)) return current
          const next = { ...current }
          delete next[segment.id]
          return next
        })
        return
      }

      if (segment.provisionalValue !== undefined) {
        setRevealedValues((current) => ({
          ...current,
          [segment.id]: segment.provisionalValue ?? "",
        }))
        setVisibleIds((current) => new Set(current).add(segment.id))
        return
      }

      if (!conversationId) return
      setLoadingId(segment.id)
      setErrorId(null)
      try {
        const response = await fetch(appPath("/api/chat/secrets/reveal"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          cache: "no-store",
          body: JSON.stringify({
            conversationId,
            messageId,
            secretId: segment.id,
          }),
        })
        const body = (await response.json().catch(() => ({}))) as {
          value?: unknown
        }
        if (!response.ok || typeof body.value !== "string") {
          throw new Error("Secret unavailable")
        }
        setRevealedValues((current) => ({
          ...current,
          [segment.id]: body.value as string,
        }))
        setVisibleIds((current) => new Set(current).add(segment.id))
      } catch {
        setErrorId(segment.id)
      } finally {
        setLoadingId(null)
      }
    },
    [conversationId, messageId, visibleIds]
  )

  return (
    <>
      {segments.map((segment, index) => {
        if (segment.type === "text") {
          return <React.Fragment key={`text-${index}`}>{segment.value}</React.Fragment>
        }
        const visible = visibleIds.has(segment.id)
        const canReveal =
          segment.provisionalValue !== undefined || Boolean(conversationId)
        const value = revealedValues[segment.id]
        const loading = loadingId === segment.id
        const failed = errorId === segment.id
        return (
          <span
            key={segment.id}
            className={cn(
              "mx-0.5 inline-flex max-w-full items-center gap-1.5 rounded-md border px-2 py-0.5 align-baseline",
              "border-emerald-700/20 bg-emerald-700/8 text-[13px] text-emerald-950 dark:border-emerald-300/20 dark:bg-emerald-300/10 dark:text-emerald-100"
            )}
            title={failed ? "Secret could not be revealed" : `${segment.label} is stored securely`}
          >
            <ShieldCheck className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="max-w-[min(28rem,60vw)] overflow-x-auto whitespace-pre font-mono text-[12px]">
              {visible ? value : "••••••••••••"}
            </span>
            <span className="max-w-40 truncate font-medium opacity-75">
              {segment.label}
            </span>
            {canReveal && (
              <button
                type="button"
                onClick={() => void toggleSecret(segment)}
                disabled={loading}
                className="-mr-1 inline-flex size-6 shrink-0 items-center justify-center rounded hover:bg-emerald-950/10 disabled:opacity-50 dark:hover:bg-white/10"
                aria-label={visible ? `Hide ${segment.label}` : `Show ${segment.label}`}
                title={visible ? "Hide secret" : "Show secret"}
              >
                {loading ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : visible ? (
                  <EyeOff className="size-3.5" />
                ) : (
                  <Eye className="size-3.5" />
                )}
              </button>
            )}
          </span>
        )
      })}
    </>
  )
}

export function secretSafeDisplayText(
  content: string,
  secretRefs?: MessageSecretRef[]
): string {
  let safe = content
  for (const ref of secretRefs ?? []) {
    safe = safe.split(ref.marker).join(`[${ref.key} hidden]`)
  }
  for (const candidate of [...detectSecretCandidates(safe)].reverse()) {
    safe = `${safe.slice(0, candidate.start)}[${candidate.label} hidden]${safe.slice(candidate.end)}`
  }
  return safe.replace(/⟦secret:[a-f0-9]{24}⟧/g, "[secret hidden]")
}

function buildSegments(
  content: string,
  secretRefs?: MessageSecretRef[]
): Array<TextSegment | SecretSegment> {
  const references = (secretRefs ?? [])
    .map((ref) => ({ ref, start: content.indexOf(ref.marker) }))
    .filter((item) => item.start >= 0)
    .sort((a, b) => a.start - b.start)

  if (references.length > 0) {
    const segments: Array<TextSegment | SecretSegment> = []
    let cursor = 0
    for (const { ref, start } of references) {
      if (start < cursor) continue
      if (start > cursor) {
        segments.push({ type: "text", value: content.slice(cursor, start) })
      }
      segments.push({
        type: "secret",
        id: ref.id,
        label: ref.label || ref.key,
        kind: ref.kind,
      })
      cursor = start + ref.marker.length
    }
    if (cursor < content.length) {
      segments.push({ type: "text", value: content.slice(cursor) })
    }
    return segments
  }

  const detected = detectSecretCandidates(content)
  if (detected.length === 0) return [{ type: "text", value: content }]

  const segments: Array<TextSegment | SecretSegment> = []
  let cursor = 0
  for (const candidate of detected) {
    if (candidate.start > cursor) {
      segments.push({ type: "text", value: content.slice(cursor, candidate.start) })
    }
    segments.push({
      type: "secret",
      id: `provisional-${candidate.start}-${candidate.end}`,
      label: candidate.label,
      kind: candidate.kind,
      provisionalValue: candidate.value,
    })
    cursor = candidate.end
  }
  if (cursor < content.length) {
    segments.push({ type: "text", value: content.slice(cursor) })
  }
  return segments
}
