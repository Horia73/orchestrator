// The SSE boundary is intentionally loose: individual event handlers validate
// the fields they consume, and the server can add event shapes independently.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type JsonSseEvent = Record<string, any>

export interface JsonSseStreamOptions {
  onEvent: (event: JsonSseEvent) => void
  onActivity?: () => void
}

/**
 * Decode a fetch response body containing one JSON value per SSE `data` line.
 *
 * Transport concerns stay here: arbitrary byte boundaries, CRLF, keepalive
 * comments, malformed events, and a final line without a trailing newline.
 * Domain-specific chat event handling remains outside the wire parser.
 */
export async function readJsonSseStream(
  body: ReadableStream<Uint8Array>,
  { onEvent, onActivity }: JsonSseStreamOptions
): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""

  const processLine = (rawLine: string) => {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine
    if (!line.startsWith("data:")) return

    const payload = line.slice(5).trimStart()
    if (!payload) return

    try {
      onEvent(JSON.parse(payload))
    } catch {
      // A malformed event must not tear down an otherwise healthy stream.
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      onActivity?.()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""
      for (const line of lines) processLine(line)
    }

    buffer += decoder.decode()
    if (buffer) processLine(buffer)
  } finally {
    reader.releaseLock()
  }
}
