export function shouldTryModelFallback(
  error: string | null | undefined,
  opts?: { afterToolCall?: boolean }
): boolean {
  const message = (error ?? "").toLowerCase()
  if (!message || message.includes("aborted")) return false

  const transient =
    message.includes("api key") ||
    message.includes("quota") ||
    message.includes("rate limit") ||
    message.includes("rate_limit") ||
    message.includes("out of usage") ||
    message.includes("usage limit") ||
    message.includes("resource_exhausted") ||
    message.includes("exhausted") ||
    message.includes("overloaded") ||
    message.includes("capacity") ||
    message.includes("unavailable") ||
    message.includes("temporarily unavailable") ||
    message.includes("service unavailable") ||
    message.includes("expired") ||
    message.includes("429") ||
    message.includes("503") ||
    message.includes("401")

  if (transient) return true

  // Once a tool has run, retrying on a broad/non-provider error can duplicate
  // external effects. Keep the post-tool retry path limited to availability
  // failures that another configured model can plausibly recover from.
  if (opts?.afterToolCall) return false

  return message.includes("model") || message.includes("streaming")
}
