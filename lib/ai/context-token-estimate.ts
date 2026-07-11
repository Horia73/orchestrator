export const CONTEXT_ESTIMATE_CHARS_PER_TOKEN = 4

export function estimateCharCountTokens(chars: number): number {
  if (!Number.isFinite(chars) || chars <= 0) return 0
  return Math.max(1, Math.ceil(chars / CONTEXT_ESTIMATE_CHARS_PER_TOKEN))
}

export function estimateTextTokens(value: string): number {
  return estimateCharCountTokens(value.length)
}

export function estimateAttachmentTokens(input: {
  mimeType?: string
  size?: number
  type?: string
}): number {
  const mimeType = input.mimeType?.split(";")[0].trim().toLowerCase() ?? ""
  const type = input.type?.toLowerCase() ?? ""
  const size =
    typeof input.size === "number" && Number.isFinite(input.size) && input.size > 0
      ? input.size
      : 0

  if (type === "image" || mimeType.startsWith("image/")) return 1200
  if (
    type === "pdf" ||
    type === "document" ||
    mimeType === "application/pdf" ||
    mimeType.includes("word") ||
    mimeType.startsWith("text/")
  ) {
    return Math.min(60_000, Math.max(800, Math.ceil(size / 12)))
  }
  if (
    type === "audio" ||
    type === "video" ||
    mimeType.startsWith("audio/") ||
    mimeType.startsWith("video/")
  ) {
    return 0
  }
  return Math.min(12_000, Math.max(100, Math.ceil(size / 24)))
}
