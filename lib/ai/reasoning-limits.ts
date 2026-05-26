import type {
  ContentSegment,
  Message,
  ReasoningEntry,
  ToolCallReasoningEntry,
  ToolStreamDelta,
} from "@/lib/types"

export const MAX_TOOL_DELTA_TEXT_CHARS = 120_000
const MAX_TOOL_RESULT_CONTENT_CHARS = 120_000
const MAX_TOOL_SUMMARY_CONTENT_CHARS = 80_000
const MAX_THOUGHT_CONTENT_CHARS = 80_000
const MAX_AGENT_PROMPT_CHARS = 40_000
const MAX_AGENT_CONTENT_CHARS = 160_000

function truncateMiddle(
  text: string,
  maxChars: number,
  label: string
): string {
  if (text.length <= maxChars) return text

  const omitted = text.length - maxChars
  const marker = `\n\n...[${label} truncated ${omitted} chars to keep chat history small]...\n\n`
  if (marker.length >= maxChars) return text.slice(0, maxChars)

  const keep = maxChars - marker.length
  const keepHead = Math.ceil(keep / 2)
  const keepTail = keep - keepHead
  return `${text.slice(0, keepHead)}${marker}${text.slice(-keepTail)}`
}

function compactToolDeltas(deltas: ToolStreamDelta[]): ToolStreamDelta[] {
  const totalChars = deltas.reduce((sum, delta) => sum + delta.text.length, 0)
  if (totalChars <= MAX_TOOL_DELTA_TEXT_CHARS) return deltas

  const last = deltas[deltas.length - 1]
  return [
    {
      stream: last?.stream ?? "message",
      text: truncateMiddle(
        deltas.map((delta) => delta.text).join(""),
        MAX_TOOL_DELTA_TEXT_CHARS,
        "tool output"
      ),
      timestamp: last?.timestamp,
    },
  ]
}

export function appendBoundedToolDelta(
  deltas: ToolStreamDelta[] | undefined,
  delta: ToolStreamDelta
): ToolStreamDelta[] {
  return compactToolDeltas([...(deltas ?? []), delta])
}

export function sanitizeToolCallReasoningEntry(
  entry: ToolCallReasoningEntry
): ToolCallReasoningEntry {
  const deltas = entry.deltas?.length
    ? compactToolDeltas(entry.deltas)
    : undefined

  return {
    ...entry,
    content: truncateMiddle(
      entry.content,
      MAX_TOOL_RESULT_CONTENT_CHARS,
      "tool result"
    ),
    ...(deltas ? { deltas } : { deltas: undefined }),
  }
}

function sanitizeContentSegments(
  segments: ContentSegment[] | undefined,
  maxChars: number
): ContentSegment[] | undefined {
  if (!segments?.length) return segments
  let used = 0
  let truncated = false
  const out: ContentSegment[] = []

  for (const segment of segments) {
    if (used >= maxChars) {
      truncated = true
      break
    }
    const remaining = maxChars - used
    if (segment.content.length <= remaining) {
      out.push(segment)
      used += segment.content.length
      continue
    }
    out.push({
      ...segment,
      content: truncateMiddle(segment.content, remaining, "agent output"),
    })
    truncated = true
    used = maxChars
  }

  if (truncated && out.length > 0) {
    const last = out[out.length - 1]
    out[out.length - 1] = {
      ...last,
      content: `${last.content}\n\n...[additional agent output omitted]...`,
    }
  }

  return out
}

export function sanitizeReasoningForPersistence(
  reasoning: ReasoningEntry[] | undefined
): ReasoningEntry[] | undefined {
  if (!reasoning?.length) return reasoning

  return reasoning.map((entry) => {
    if (entry.type === "thought") {
      return {
        ...entry,
        content: truncateMiddle(
          entry.content,
          MAX_THOUGHT_CONTENT_CHARS,
          "reasoning"
        ),
      }
    }

    if (entry.type === "tool_call") {
      return sanitizeToolCallReasoningEntry(entry)
    }

    if (entry.type === "agent_call") {
      return {
        ...entry,
        prompt: truncateMiddle(
          entry.prompt,
          MAX_AGENT_PROMPT_CHARS,
          "agent prompt"
        ),
        content: truncateMiddle(
          entry.content,
          MAX_AGENT_CONTENT_CHARS,
          "agent output"
        ),
        contentSegments: sanitizeContentSegments(
          entry.contentSegments,
          MAX_AGENT_CONTENT_CHARS
        ),
        reasoning: sanitizeReasoningForPersistence(entry.reasoning),
      }
    }

    return entry
  })
}

export function sanitizeToolCallSummaries(
  toolCalls: Message["toolCalls"] | undefined
): Message["toolCalls"] | undefined {
  if (!toolCalls?.length) return toolCalls
  return toolCalls.map((toolCall) => ({
    ...toolCall,
    content: truncateMiddle(
      toolCall.content,
      MAX_TOOL_SUMMARY_CONTENT_CHARS,
      "tool summary"
    ),
  }))
}

export function sanitizeMessageForPersistence(message: Message): Message {
  return {
    ...message,
    reasoning: sanitizeReasoningForPersistence(message.reasoning),
    toolCalls: sanitizeToolCallSummaries(message.toolCalls),
  }
}
