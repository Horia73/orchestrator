import type { ArtifactPayload } from "@/components/artifact-panel"
import type {
  AgentCallReasoningEntry,
  Message,
  ReasoningEntry,
} from "@/lib/types"

export const LAYOUT_TRANSITION =
  "duration-[260ms] ease-[cubic-bezier(0.22,1,0.36,1)]"
export const STICKY_BOTTOM_THRESHOLD = 80
export const ARTIFACT_PANEL_DEFAULT_WIDTH = 560
export const ARTIFACT_PANEL_MIN_WIDTH = 340
export const ARTIFACT_PANEL_MAX_WIDTH = 2400
const ARTIFACT_PANEL_MIN_CHAT_WIDTH = 360
export const ARTIFACT_PANEL_RESIZE_STEP = 40
export const ARTIFACT_PANEL_RESIZER_WIDTH = 10
const ARTIFACT_PANEL_WIDTH_STORAGE_PREFIX = "chat:artifact-panel-width"
export const SCROLL_BOTTOM_SENTINEL = "bottom"
export const SCROLL_ANCHOR_STORAGE_PREFIX = "scroll-anchor:chat"
export const SCROLL_RESTORE_STORAGE_PREFIX = "scroll-restore:chat"
// Remembers which streaming message we already pinned to the top, so a remount
// during the same ongoing stream doesn't re-anchor over a restored scroll.
export const STREAM_ANCHOR_TAKEN_PREFIX = "chat:anchoredStream"
export const SCROLL_RESTORE_TOP_OFFSET = 16
// How long the post-restore hold keeps re-pinning the restored position while
// late content (idle-scheduled Shiki ≤1200ms, images, chunk-rendered "Worked
// for" bodies) is still reflowing. Real user input cancels it immediately.
export const POST_RESTORE_HOLD_MS = 2500
export const MESSAGE_ANCHOR_TOP_OFFSET = 32
export const MESSAGE_ANCHOR_SCROLL_DURATION_MS = 420
export const SCROLL_BUTTON_FADE_DISTANCE_PX = 2700
export const MESSAGE_VERTICAL_GAP = 24
export const TAIL_SPACER_UPDATE_THRESHOLD_PX = 4

export type SavedScrollRestore = {
  messageId: string
  offset: number
  scrollTop: number
  distanceFromBottom: number
  savedAt: number
}

export type ArtifactState = ArtifactPayload

export function getElementContentHeight(element: HTMLElement): number {
  const firstChild = element.firstElementChild
  if (firstChild instanceof HTMLElement) {
    return Math.ceil(firstChild.getBoundingClientRect().height)
  }
  return Math.ceil(element.getBoundingClientRect().height)
}

/** Old persisted artifact shape (no `kind`). Migrate to current union. */
function migrateLegacyArtifact(stored: unknown): ArtifactState | null {
  if (!stored || typeof stored !== "object") return null
  const obj = stored as Record<string, unknown>
  if (obj.kind === "code-block" || obj.kind === "tool-result")
    return obj as unknown as ArtifactState
  if (
    typeof obj.title === "string" &&
    typeof obj.language === "string" &&
    typeof obj.code === "string"
  ) {
    return {
      kind: "code-block",
      title: obj.title,
      language: obj.language,
      code: obj.code,
    }
  }
  return null
}

// Per-conversation view state that the mount initializers seed from localStorage.
export function readSavedMinHeightState(conversationId: string | null): {
  minHeight: number
  minHeightMsgId: string | null
} {
  if (typeof window === "undefined" || !conversationId)
    return { minHeight: 0, minHeightMsgId: null }
  const saved = localStorage.getItem(`chat:minHeight:${conversationId}`)
  if (saved) {
    try {
      const parsed = JSON.parse(saved)
      const savedViewportHeight =
        typeof parsed.viewportHeight === "number" ? parsed.viewportHeight : 0
      if (
        savedViewportHeight > 0 &&
        Math.abs(savedViewportHeight - window.innerHeight) > 96
      ) {
        return { minHeight: 0, minHeightMsgId: null }
      }
      return {
        minHeight: parsed.minHeight || 0,
        minHeightMsgId: parsed.minHeightMsgId || null,
      }
    } catch {}
  }
  return { minHeight: 0, minHeightMsgId: null }
}

export function readSavedArtifactState(conversationId: string | null): {
  artifact: ArtifactState | null
  artifactOpen: boolean
} {
  if (typeof window === "undefined" || !conversationId)
    return { artifact: null, artifactOpen: false }
  const saved = localStorage.getItem(`chat:artifact:${conversationId}`)
  if (saved) {
    try {
      const parsed = JSON.parse(saved)
      return {
        artifact: migrateLegacyArtifact(parsed.artifact),
        artifactOpen: Boolean(parsed.artifactOpen),
      }
    } catch {}
  }
  return { artifact: null, artifactOpen: false }
}

function hashStorageKey(value: string): string {
  let hash = 5381
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) + hash) ^ value.charCodeAt(i)
  }
  return (hash >>> 0).toString(36)
}

export function artifactPanelConversationWidthKey(
  conversationId: string
): string {
  return `${ARTIFACT_PANEL_WIDTH_STORAGE_PREFIX}:${conversationId}`
}

export function artifactPanelArtifactWidthKey(
  conversationId: string,
  artifactResizeKey: string | null
): string | null {
  if (!artifactResizeKey) return null
  return `${ARTIFACT_PANEL_WIDTH_STORAGE_PREFIX}:${conversationId}:artifact:${hashStorageKey(artifactResizeKey)}`
}

export function readStoredArtifactPanelWidth(key: string | null): number | null {
  if (typeof window === "undefined" || !key) return null
  const raw = window.localStorage.getItem(key)
  if (!raw) return null
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : null
}

export function clampArtifactPanelWidth(
  width: number,
  containerWidth?: number | null
): number {
  const rounded = Math.round(width)
  if (!Number.isFinite(rounded)) return ARTIFACT_PANEL_DEFAULT_WIDTH

  const maxFromContainer =
    typeof containerWidth === "number" &&
    Number.isFinite(containerWidth) &&
    containerWidth > 0
      ? Math.max(
          ARTIFACT_PANEL_MIN_WIDTH,
          Math.min(
            ARTIFACT_PANEL_MAX_WIDTH,
            Math.floor(
              containerWidth -
                ARTIFACT_PANEL_MIN_CHAT_WIDTH -
                ARTIFACT_PANEL_RESIZER_WIDTH
            )
          )
        )
      : ARTIFACT_PANEL_MAX_WIDTH

  return Math.min(Math.max(rounded, ARTIFACT_PANEL_MIN_WIDTH), maxFromContainer)
}

export function collectAgentRuns(
  reasoning?: ReasoningEntry[]
): AgentCallReasoningEntry[] {
  if (!reasoning?.length) return []
  const out: AgentCallReasoningEntry[] = []
  for (const entry of reasoning) {
    if (entry.type === "agent_call") {
      out.push(entry)
      out.push(...collectAgentRuns(entry.reasoning))
    }
  }
  return out
}

export function isAssistantMessageInProgress(
  message: Message | null | undefined
): message is Message {
  return (
    message?.role === "assistant" &&
    message.status == null &&
    message.thinkingDuration == null
  )
}

export function hasAssistantProgress(
  message: Message | null | undefined
): boolean {
  if (!message || message.role !== "assistant") return false
  const hasReasoning =
    Array.isArray(message.reasoning) && message.reasoning.length > 0
  const hasContent = message.content.trim().length > 0
  const hasSegments =
    Array.isArray(message.contentSegments) &&
    message.contentSegments.some((segment) => segment.content.length > 0)
  return hasReasoning || hasContent || hasSegments
}
