export type EnvQuote = "none" | "single" | "double"

export type EnvLine =
  | {
      kind: "entry"
      id: string
      key: string
      value: string
      quote: EnvQuote
      exportPrefix: boolean
    }
  | { kind: "raw"; id: string; value: string }

export type EnvRevealState = Record<string, { message: string }>

export const REDACTED_ENV_VALUE = "__ORCHESTRATOR_SECRET_SET__"

export const ENV_PRESETS = [
  {
    key: "GEMINI_API_KEY",
    label: "Gemini",
    description: "Google Gemini models and browser-agent defaults",
    placeholder: "AIza...",
  },
  {
    key: "OPENAI_API_KEY",
    label: "OpenAI",
    description: "OpenAI models, Responses, and image generation",
    placeholder: "sk-...",
  },
  {
    key: "ANTHROPIC_API_KEY",
    label: "Anthropic",
    description: "Claude models and Anthropic calls",
    placeholder: "sk-ant-...",
  },
] as const

export async function revealEnvValue(
  fileKey: string,
  key: string,
  occurrence: number
): Promise<{ value: string; quote: EnvQuote }> {
  const res = await fetch(
    `/api/settings/files/${encodeURIComponent(fileKey)}/env-value`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, occurrence }),
    }
  )
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(json.error || `Reveal failed (${res.status})`)
  if (typeof json.value !== "string")
    throw new Error("Reveal returned an invalid value")
  const quote =
    json.quote === "single" || json.quote === "double" ? json.quote : "none"
  return { value: json.value, quote }
}

export function isRedactedEnvValue(value: string): boolean {
  return value.trim() === REDACTED_ENV_VALUE
}

export function parseEnvContent(content: string): EnvLine[] {
  const lines = content.replace(/\r\n/g, "\n").split("\n")
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()
  const rows: EnvLine[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] ?? ""
    rows.push(parseEnvLine(raw, index))
  }
  return rows
}

export function parsePastedEnvEntry(
  text: string
): Extract<EnvLine, { kind: "entry" }> | null {
  const line = text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .find((candidate) => parseEnvEntryLine(candidate, 0) !== null)
  return line ? parseEnvEntryLine(line, 0) : null
}

export function formatEnvContent(rows: EnvLine[]): string {
  return rows.map(formatEnvLine).join("\n").replace(/\n*$/, "") + "\n"
}

export function countEnvKeys(
  entries: Array<Extract<EnvLine, { kind: "entry" }>>
): Map<string, number> {
  const counts = new Map<string, number>()
  for (const row of entries) {
    if (!row.key) continue
    counts.set(row.key, (counts.get(row.key) ?? 0) + 1)
  }
  return counts
}

export function normalizeEnvKeyInput(value: string): string {
  const withoutExport = value.replace(/^\s*export\s+/, "")
  const beforeEquals = withoutExport.includes("=")
    ? withoutExport.slice(0, withoutExport.indexOf("="))
    : withoutExport
  return beforeEquals
    .trim()
    .replace(/[^A-Za-z0-9_]/g, "_")
    .replace(/^[^A-Za-z_]+/, "")
}

export function newEnvRowId(): string {
  return `env-row-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function parseEnvLine(line: string, index: number): EnvLine {
  return (
    parseEnvEntryLine(line, index) ?? {
      kind: "raw",
      id: `env-line-${index}`,
      value: line,
    }
  )
}

function parseEnvEntryLine(
  line: string,
  index: number
): Extract<EnvLine, { kind: "entry" }> | null {
  const match = line.match(/^\s*(export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/)
  if (!match) return null
  const parsed = parseEnvValue(match[3] ?? "")
  return {
    kind: "entry",
    id: `env-line-${index}`,
    key: match[2] ?? "",
    value: parsed.value,
    quote: parsed.quote,
    exportPrefix: Boolean(match[1]),
  }
}

function parseEnvValue(rawValue: string): { value: string; quote: EnvQuote } {
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

function formatEnvLine(row: EnvLine): string {
  if (row.kind === "raw") return row.value
  if (!row.key && !row.value) return ""
  const prefix = row.exportPrefix ? "export " : ""
  return `${prefix}${row.key}=${formatEnvValue(row.value, row.quote)}`
}

function formatEnvValue(value: string, quote: EnvQuote): string {
  if (value === "") return ""
  if (quote === "single") return `'${value.replace(/'/g, "\\'")}'`
  if (quote === "double" || !/^[A-Za-z0-9_./:@%+=,\-]+$/.test(value)) {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
  }
  return value
}
