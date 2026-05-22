export interface DirectEmitArtifactData {
  source: Record<string, unknown>
  identifier: string
  type: string
  title: string
  display?: string | null
  body: string
}

export interface ArtifactUpdateData {
  source: Record<string, unknown>
  identifier: string
  type: string
  title: string
  display?: string | null
  body: string
}

/**
 * Provider adapters do not all preserve local tool results as objects.
 * Codex, for example, can surface dynamic tool results as a JSON string.
 * Normalize both shapes so chat can still auto-mount direct-emitted artifacts.
 */
export function getDirectEmitArtifactData(
  data: unknown
): DirectEmitArtifactData | null {
  const source = coerceObject(data)
  if (!source) return null

  if (
    source.directEmit !== true ||
    typeof source.identifier !== "string" ||
    typeof source.type !== "string" ||
    typeof source.title !== "string" ||
    typeof source.body !== "string"
  ) {
    return null
  }

  const display = typeof source.display === "string" ? source.display : null
  return {
    source,
    identifier: source.identifier,
    type: source.type,
    title: source.title,
    display,
    body: source.body,
  }
}

export function stripDirectEmitPayload(
  data: Record<string, unknown>
): Record<string, unknown> {
  const stripped: Record<string, unknown> = { ...data }
  delete stripped.body
  delete stripped.usage
  delete stripped.directEmit
  stripped.directEmitted = true
  stripped.note =
    "Artifact already mounted in chat - do NOT emit an <artifact> tag. Use companion enrichment tools only when the prompt requires them, then write concise prose."
  return stripped
}

export function getArtifactUpdateData(data: unknown): ArtifactUpdateData | null {
  const source = coerceObject(data)
  if (!source) return null

  if (
    source.artifactUpdate !== true ||
    typeof source.identifier !== "string" ||
    typeof source.type !== "string" ||
    typeof source.title !== "string" ||
    typeof source.body !== "string"
  ) {
    return null
  }

  const display = typeof source.display === "string" ? source.display : null
  return {
    source,
    identifier: source.identifier,
    type: source.type,
    title: source.title,
    display,
    body: source.body,
  }
}

export function stripArtifactUpdatePayload(
  data: Record<string, unknown>
): Record<string, unknown> {
  const stripped: Record<string, unknown> = { ...data }
  delete stripped.body
  delete stripped.artifactUpdate
  stripped.artifactUpdated = true
  stripped.note =
    "Artifact data updated in chat. Do NOT emit an <artifact> tag or duplicate the card."
  return stripped
}

function coerceObject(data: unknown): Record<string, unknown> | null {
  if (data && typeof data === "object" && !Array.isArray(data)) {
    return data as Record<string, unknown>
  }

  if (typeof data !== "string") return null
  const trimmed = data.trim()
  if (!trimmed.startsWith("{")) return null

  try {
    const parsed = JSON.parse(trimmed) as unknown
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}
