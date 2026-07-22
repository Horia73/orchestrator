import type { MessageSecretKind } from "@/lib/types"

export interface DetectedSecretCandidate {
  start: number
  end: number
  value: string
  suggestedKey: string
  label: string
  kind: MessageSecretKind
  confidence: "explicit" | "known_format"
}

interface CandidateWithPriority extends DetectedSecretCandidate {
  priority: number
}

const SECRET_ENV_KEY_RE =
  /(?:^|_)(?:API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE_?KEY|CREDENTIAL|AUTH|COOKIE|SESSION|SIGNING_?KEY|WEBHOOK_?SECRET)(?:_|$)/i

const PLACEHOLDER_RE = /^(?:<[^>]+>|\[[^\]]+\]|x{4,}|\*{4,}|your[-_ ]|example|changeme|redacted|secret)$/i

const SERVICE_ALIASES: Array<[RegExp, string]> = [
  [/\bopenai\b/i, "OPENAI"],
  [/\banthropic\b|\bclaude\b/i, "ANTHROPIC"],
  [/\bopenrouter\b/i, "OPENROUTER"],
  [/\bgemini\b/i, "GEMINI"],
  [/\bgoogle\s+maps?\b/i, "GOOGLE_MAPS"],
  [/\bgoogle\b/i, "GOOGLE"],
  [/\bgithub\b/i, "GITHUB"],
  [/\bgitlab\b/i, "GITLAB"],
  [/\bshopify\b/i, "SHOPIFY"],
  [/\bstripe\b/i, "STRIPE"],
  [/\bslack\b/i, "SLACK"],
  [/\bresend\b/i, "RESEND"],
  [/\bapify\b/i, "APIFY"],
  [/\btwelve\s*data\b/i, "TWELVE_DATA"],
  [/\bhome\s*assistant\b/i, "HOME_ASSISTANT"],
  [/\bserper\b/i, "SERPER"],
  [/\bvercel\b/i, "VERCEL"],
  [/\bnotion\b/i, "NOTION"],
  [/\bdiscord\b/i, "DISCORD"],
  [/\btelegram\b/i, "TELEGRAM"],
]

const KNOWN_FORMATS: Array<{
  regex: RegExp
  key: string
  label?: string
  kind: MessageSecretKind
}> = [
  { regex: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g, key: "ANTHROPIC_API_KEY", kind: "api_key" },
  { regex: /\bsk-or-v1-[A-Za-z0-9_-]{20,}\b/g, key: "OPENROUTER_API_KEY", kind: "api_key" },
  { regex: /\bsk-(?:proj|svcacct)-[A-Za-z0-9_-]{20,}\b/g, key: "OPENAI_API_KEY", kind: "api_key" },
  { regex: /\bAIza[0-9A-Za-z_-]{30,}\b/g, key: "GOOGLE_API_KEY", kind: "api_key" },
  { regex: /\bgithub_pat_[A-Za-z0-9_]{30,}\b/g, key: "GITHUB_TOKEN", kind: "token" },
  { regex: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, key: "GITHUB_TOKEN", kind: "token" },
  { regex: /\bglpat-[A-Za-z0-9_-]{20,}\b/g, key: "GITLAB_TOKEN", kind: "token" },
  { regex: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g, key: "SLACK_TOKEN", kind: "token" },
  { regex: /\bapify_api_[A-Za-z0-9_-]{20,}\b/g, key: "APIFY_API_TOKEN", kind: "token" },
  { regex: /\bre_[A-Za-z0-9_]{20,}\b/g, key: "RESEND_API_KEY", kind: "api_key" },
  { regex: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/g, key: "STRIPE_SECRET_KEY", kind: "api_key" },
  { regex: /\bwhsec_[A-Za-z0-9]{20,}\b/g, key: "WEBHOOK_SIGNING_SECRET", kind: "credential" },
  { regex: /\bya29\.[A-Za-z0-9_-]{20,}\b/g, key: "GOOGLE_ACCESS_TOKEN", kind: "token" },
  {
    regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    key: "JWT_TOKEN",
    kind: "token",
  },
]

const ENV_ASSIGNMENT_RE =
  /(?:^|[\s`])(?:export\s+)?([A-Za-z_][A-Za-z0-9_]{2,})\s*=\s*(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s`"',;]+))/gm

const SERVICE_FIRST_CREDENTIAL_RE =
  /\b((?:(?:my|the|for|pentru|de\s+la|cheia|key-ul)\s+)?[A-Za-z][A-Za-z0-9 ._-]{0,32}?)\s+(api[\s_-]?key|cheie\s+api|access[\s_-]?token|refresh[\s_-]?token|client[\s_-]?secret|webhook[\s_-]?secret|password|parol[aă]|passwd|token|secret)\s*(?:is|este|e|=|:)\s*(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s`"',;]+))/gim

const CREDENTIAL_FIRST_RE =
  /\b(api[\s_-]?key|cheie\s+api|access[\s_-]?token|refresh[\s_-]?token|client[\s_-]?secret|webhook[\s_-]?secret|password|parol[aă]|passwd|token|secret)\s+(?:for|pentru|de\s+la)\s+([A-Za-z][A-Za-z0-9 ._-]{1,32}?)\s*(?:is|este|e|=|:)\s*(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s`"',;]+))/gim

const PEM_PRIVATE_KEY_RE =
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]+?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g

export function isSecretEnvKey(key: string): boolean {
  return SECRET_ENV_KEY_RE.test(key.trim())
}

export function detectSecretCandidates(content: string): DetectedSecretCandidate[] {
  if (!content || content.length > 500_000) return []
  const candidates: CandidateWithPriority[] = []

  for (const match of content.matchAll(ENV_ASSIGNMENT_RE)) {
    const key = match[1]?.trim() ?? ""
    const value = firstValue(match[2], match[3], match[4])
    if (!key || !value || (!isSecretEnvKey(key) && !looksLikeKnownSecret(value))) continue
    addCandidate(candidates, content, match, value, {
      key: normalizeEnvKey(key),
      kind: kindFromCredentialLabel(key),
      confidence: "explicit",
      priority: 100,
    })
  }

  for (const match of content.matchAll(SERVICE_FIRST_CREDENTIAL_RE)) {
    const service = cleanServiceLabel(match[1] ?? "")
    const credential = match[2] ?? "credential"
    const value = firstValue(match[3], match[4], match[5])
    if (!service || !value) continue
    const key = keyFromServiceCredential(service, credential)
    addCandidate(candidates, content, match, value, {
      key,
      kind: kindFromCredentialLabel(credential),
      confidence: "explicit",
      priority: 90,
    })
  }

  for (const match of content.matchAll(CREDENTIAL_FIRST_RE)) {
    const credential = match[1] ?? "credential"
    const service = cleanServiceLabel(match[2] ?? "")
    const value = firstValue(match[3], match[4], match[5])
    if (!service || !value) continue
    const key = keyFromServiceCredential(service, credential)
    addCandidate(candidates, content, match, value, {
      key,
      kind: kindFromCredentialLabel(credential),
      confidence: "explicit",
      priority: 90,
    })
  }

  for (const format of KNOWN_FORMATS) {
    for (const match of content.matchAll(format.regex)) {
      const value = match[0]
      if (!value) continue
      candidates.push({
        start: match.index ?? 0,
        end: (match.index ?? 0) + value.length,
        value,
        suggestedKey: format.key,
        label: format.label ?? format.key,
        kind: format.kind,
        confidence: "known_format",
        priority: 80,
      })
    }
  }

  for (const match of content.matchAll(PEM_PRIVATE_KEY_RE)) {
    const value = match[0]
    candidates.push({
      start: match.index ?? 0,
      end: (match.index ?? 0) + value.length,
      value,
      suggestedKey: "PRIVATE_KEY",
      label: "PRIVATE_KEY",
      kind: "private_key",
      confidence: "known_format",
      priority: 110,
    })
  }

  return selectNonOverlapping(candidates).map((candidate) => ({
    start: candidate.start,
    end: candidate.end,
    value: candidate.value,
    suggestedKey: candidate.suggestedKey,
    label: candidate.label,
    kind: candidate.kind,
    confidence: candidate.confidence,
  }))
}

function addCandidate(
  out: CandidateWithPriority[],
  content: string,
  match: RegExpMatchArray,
  value: string,
  options: {
    key: string
    kind: MessageSecretKind
    confidence: DetectedSecretCandidate["confidence"]
    priority: number
  }
): void {
  const trimmed = value.trim()
  if (!isUsableSecretValue(trimmed)) return
  const full = match[0] ?? ""
  const relative = full.lastIndexOf(value)
  if (relative < 0) return
  const start = (match.index ?? content.indexOf(full)) + relative
  out.push({
    start,
    end: start + value.length,
    value,
    suggestedKey: options.key,
    label: options.key,
    kind: options.kind,
    confidence: options.confidence,
    priority: options.priority,
  })
}

function firstValue(...values: Array<string | undefined>): string {
  return values.find((value) => typeof value === "string" && value.length > 0) ?? ""
}

function isUsableSecretValue(value: string): boolean {
  if (value.length < 4 || value.length > 64_000) return false
  if (PLACEHOLDER_RE.test(value)) return false
  if (/^(?:true|false|null|undefined|none)$/i.test(value)) return false
  return true
}

function looksLikeKnownSecret(value: string): boolean {
  const known = KNOWN_FORMATS.some(({ regex }) => {
    regex.lastIndex = 0
    const matched = regex.test(value)
    regex.lastIndex = 0
    return matched
  })
  PEM_PRIVATE_KEY_RE.lastIndex = 0
  const pem = PEM_PRIVATE_KEY_RE.test(value)
  PEM_PRIVATE_KEY_RE.lastIndex = 0
  return known || pem
}

function cleanServiceLabel(value: string): string {
  return value
    .replace(/^(?:here(?:'s|\s+is)?|acesta\s+este|asta\s+e|my|the|for|pentru|de\s+la|cheia|key-ul)\s+/i, "")
    .trim()
}

function keyFromServiceCredential(service: string, credential: string): string {
  const alias = SERVICE_ALIASES.find(([pattern]) => pattern.test(service))?.[1]
  const serviceKey = alias ?? normalizeEnvKey(service)
  const normalizedCredential = credential.toLowerCase().replace(/[ăâ]/g, "a")

  if (/api[\s_-]?key|cheie\s+api/.test(normalizedCredential)) {
    if (serviceKey === "GEMINI") return "GEMINI_API_KEY"
    return `${serviceKey}_API_KEY`
  }
  if (/client[\s_-]?secret/.test(normalizedCredential)) return `${serviceKey}_CLIENT_SECRET`
  if (/webhook[\s_-]?secret/.test(normalizedCredential)) return `${serviceKey}_WEBHOOK_SECRET`
  if (/refresh[\s_-]?token/.test(normalizedCredential)) return `${serviceKey}_REFRESH_TOKEN`
  if (/access[\s_-]?token/.test(normalizedCredential)) return `${serviceKey}_ACCESS_TOKEN`
  if (/password|parola|passwd/.test(normalizedCredential)) return `${serviceKey}_PASSWORD`
  if (/token/.test(normalizedCredential)) return `${serviceKey}_TOKEN`
  return `${serviceKey}_SECRET`
}

function kindFromCredentialLabel(value: string): MessageSecretKind {
  const normalized = value.toLowerCase().replace(/[ăâ]/g, "a")
  if (/api_?key|api[\s_-]?key|cheie\s+api/.test(normalized)) return "api_key"
  if (/token|auth|session|cookie/.test(normalized)) return "token"
  if (/password|parola|passwd/.test(normalized)) return "password"
  if (/private_?key|private[\s_-]?key/.test(normalized)) return "private_key"
  return "credential"
}

export function normalizeEnvKey(value: string): string {
  const normalized = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_")
  if (!normalized) return "ORCHESTRATOR_SECRET"
  return /^[A-Z_]/.test(normalized) ? normalized : `SECRET_${normalized}`
}

function selectNonOverlapping(candidates: CandidateWithPriority[]): CandidateWithPriority[] {
  const selected: CandidateWithPriority[] = []
  for (const candidate of [...candidates].sort((a, b) => {
    const priority = b.priority - a.priority
    if (priority !== 0) return priority
    return (b.end - b.start) - (a.end - a.start)
  })) {
    if (selected.some((item) => candidate.start < item.end && candidate.end > item.start)) continue
    selected.push(candidate)
  }
  return selected.sort((a, b) => a.start - b.start)
}
