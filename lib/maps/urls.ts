export interface SafeHttpUrlOptions {
  httpsOnly?: boolean
  stripHash?: boolean
  maxLength?: number
}

export function normalizeSafeHttpUrl(
  value: string | null | undefined,
  options: SafeHttpUrlOptions = {}
): string | null {
  const maxLength = options.maxLength ?? 2000
  const cleaned = value?.trim()
  if (!cleaned || cleaned.length > maxLength) return null

  try {
    const url = new URL(cleaned)
    if (options.httpsOnly) {
      if (url.protocol !== "https:") return null
    } else if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null
    }
    if (options.stripHash) url.hash = ""
    const normalized = url.toString()
    return normalized.length <= maxLength ? normalized : null
  } catch {
    return null
  }
}

export function isSafeHttpUrl(
  value: string,
  options: SafeHttpUrlOptions = {}
): boolean {
  return normalizeSafeHttpUrl(value, options) !== null
}
