export type EnvQuote = "none" | "single" | "double"

export interface WorkspaceEnvValue {
  value: string
  quote: EnvQuote
}

const REDACTED_ENV_VALUE = "__ORCHESTRATOR_SECRET_SET__"

export function mergeMissingEnvDefaults(
  content: string,
  defaultContent: string
): string {
  if (!defaultContent) return content
  const existing = new Set(extractEnvKeys(content))
  const missing = extractEnvLines(defaultContent).filter(
    (line) => !existing.has(line.key)
  )
  if (missing.length === 0) return content

  const base = content.replace(/\s*$/, "\n")
  return [base, ...missing.map((line) => line.raw), ""].join("\n")
}

function extractEnvKeys(content: string): string[] {
  return extractEnvLines(content).map((line) => line.key)
}

function extractEnvLines(content: string): Array<{ key: string; raw: string }> {
  const lines = content.replace(/\r\n/g, "\n").split("\n")
  const out: Array<{ key: string; raw: string }> = []
  for (const raw of lines) {
    const match = raw.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/)
    if (!match?.[1]) continue
    out.push({ key: match[1], raw: raw.trim() })
  }
  return out
}

export function redactEnvContent(content: string): string {
  return content
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => {
      const parsed = parseEnvAssignment(line)
      if (!parsed) return line
      if (isEmptyEnvValue(parsed.value)) return line
      return `${parsed.prefix}${REDACTED_ENV_VALUE}`
    })
    .join("\n")
}

export function mergeRedactedEnvSubmission(
  submittedContent: string,
  existingContent: string
): string {
  const existingValues = new Map<string, string[]>()
  for (const line of existingContent.replace(/\r\n/g, "\n").split("\n")) {
    const parsed = parseEnvAssignment(line)
    if (!parsed) continue
    const values = existingValues.get(parsed.key) ?? []
    values.push(parsed.value)
    existingValues.set(parsed.key, values)
  }
  const usedOccurrences = new Map<string, number>()

  return submittedContent
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => {
      const parsed = parseEnvAssignment(line)
      if (!parsed || !isRedactedEnvValue(parsed.value)) return line
      const occurrence = usedOccurrences.get(parsed.key) ?? 0
      usedOccurrences.set(parsed.key, occurrence + 1)
      const values = existingValues.get(parsed.key)
      const existingValue = values?.[occurrence] ?? values?.[values.length - 1]
      return `${parsed.prefix}${existingValue ?? ""}`
    })
    .join("\n")
}

export function parseEnvAssignment(
  line: string
): { key: string; prefix: string; value: string } | null {
  const match = line.match(
    /^(\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*)(.*)$/
  )
  if (!match?.[1] || !match[2]) return null
  return {
    key: match[2],
    prefix: match[1],
    value: match[3] ?? "",
  }
}

function isEmptyEnvValue(value: string): boolean {
  const trimmed = value.trim()
  return trimmed === "" || trimmed === '""' || trimmed === "''"
}

function isRedactedEnvValue(value: string): boolean {
  const trimmed = value.trim()
  if (trimmed === REDACTED_ENV_VALUE) return true
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1) === REDACTED_ENV_VALUE
  }
  return false
}

export function parseEnvStoredValue(rawValue: string): WorkspaceEnvValue {
  const value = rawValue.trim()
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return {
      value: value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\"),
      quote: "double",
    }
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return {
      value: value.slice(1, -1).replace(/\\'/g, "'"),
      quote: "single",
    }
  }
  return { value, quote: "none" }
}

const workspaceEnvProcessKeys = new Set<string>()

export function syncWorkspaceEnvToProcess(
  previousContent: string,
  nextContent: string
): void {
  const previous = parseEnvValueMap(previousContent)
  const next = parseEnvValueMap(nextContent)

  for (const [key, value] of next) {
    process.env[key] = value
    workspaceEnvProcessKeys.add(key)
  }

  for (const key of previous.keys()) {
    if (next.has(key) || !workspaceEnvProcessKeys.has(key)) continue
    delete process.env[key]
    workspaceEnvProcessKeys.delete(key)
  }
}

function parseEnvValueMap(content: string): Map<string, string> {
  const values = new Map<string, string>()
  for (const line of content.replace(/\r\n/g, "\n").split("\n")) {
    const parsed = parseEnvAssignment(line)
    if (!parsed || isEmptyEnvValue(parsed.value)) continue
    values.set(parsed.key, parseEnvStoredValue(parsed.value).value)
  }
  return values
}
