import crypto from "crypto"
import fs from "fs"
import path from "path"

import type { Message, MessageSecretRef } from "@/lib/types"
import { activeRuntimePaths } from "@/lib/runtime-paths"
import { detectSecretCandidates, normalizeEnvKey } from "./detection"
import { upsertWorkspaceEnvValue } from "./workspace-env"

interface StoredSecret {
  id: string
  key: string
  label: string
  kind: MessageSecretRef["kind"]
  value: string
  messageId: string
  createdAt: number
  updatedAt: number
}

interface SecretVaultFile {
  version: 1
  records: StoredSecret[]
}

export interface ProtectedUserMessageResult {
  message: Message
  capturedKeys: string[]
}

const SECRET_MARKER_RE = /⟦secret:([a-f0-9]{24})⟧/g
const vaultCache = new Map<
  string,
  { mtimeMs: number; size: number; vault: SecretVaultFile }
>()

function vaultPath(): string {
  return path.join(activeRuntimePaths().privateStateDir, "secrets", "chat-secrets.json")
}

function readVault(): SecretVaultFile {
  const filePath = vaultPath()
  try {
    const stat = fs.statSync(filePath)
    const cached = vaultCache.get(filePath)
    if (cached?.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.vault
    }
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Partial<SecretVaultFile>
    const vault: SecretVaultFile = {
      version: 1,
      records: Array.isArray(parsed.records)
        ? parsed.records.filter(isStoredSecret)
        : [],
    }
    vaultCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, vault })
    return vault
  } catch {
    vaultCache.delete(filePath)
    return { version: 1, records: [] }
  }
}

function writeVault(vault: SecretVaultFile): void {
  const filePath = vaultPath()
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmpPath, `${JSON.stringify(vault, null, 2)}\n`, {
    encoding: "utf-8",
    mode: 0o600,
  })
  fs.renameSync(tmpPath, filePath)
  try {
    fs.chmodSync(filePath, 0o600)
  } catch {
    // Best effort for filesystems without chmod support.
  }
  const stat = fs.statSync(filePath)
  vaultCache.set(filePath, {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    vault,
  })
}

function isStoredSecret(value: unknown): value is StoredSecret {
  if (!value || typeof value !== "object") return false
  const record = value as Partial<StoredSecret>
  return (
    typeof record.id === "string" &&
    typeof record.key === "string" &&
    typeof record.value === "string" &&
    typeof record.messageId === "string"
  )
}

function stableSecretId(messageId: string, start: number, key: string): string {
  return crypto
    .createHash("sha256")
    .update(`${messageId}\u0000${start}\u0000${key}`)
    .digest("hex")
    .slice(0, 24)
}

function fallbackSecretKey(messageId: string, index: number): string {
  const suffix = crypto
    .createHash("sha256")
    .update(`${messageId}\u0000${index}`)
    .digest("hex")
    .slice(0, 8)
    .toUpperCase()
  return `ORCHESTRATOR_CHAT_SECRET_${suffix}`
}

export function protectUserMessage(message: Message): ProtectedUserMessageResult {
  if (message.role !== "user" || typeof message.content !== "string") {
    return { message, capturedKeys: [] }
  }

  const existingRefs = validateSecretRefs(message)
  const candidates = detectSecretCandidates(message.content)
  if (candidates.length === 0) {
    const normalizedMessage = existingRefs.length > 0
      ? { ...message, secretRefs: existingRefs }
      : message.secretRefs
        ? { ...message, secretRefs: undefined }
        : message
    return {
      message: normalizedMessage,
      capturedKeys: existingRefs.map((ref) => ref.key),
    }
  }

  const vault = readVault()
  const now = Date.now()
  const refs: MessageSecretRef[] = []
  let content = message.content

  for (let index = candidates.length - 1; index >= 0; index--) {
    const candidate = candidates[index]
    const key = normalizeEnvKey(
      candidate.suggestedKey || fallbackSecretKey(message.id, index)
    )
    const id = stableSecretId(message.id, candidate.start, key)
    const marker = `⟦secret:${id}⟧`
    const previous = vault.records.find((record) => record.id === id)
    const record: StoredSecret = {
      id,
      key,
      label: candidate.label || key,
      kind: candidate.kind,
      value: candidate.value,
      messageId: message.id,
      createdAt: previous?.createdAt ?? now,
      // Later occurrences of the same inferred env key deterministically win.
      updatedAt: now + index,
    }
    if (previous) Object.assign(previous, record)
    else vault.records.push(record)

    refs.unshift({
      id,
      key,
      label: record.label,
      kind: record.kind,
      marker,
      capturedAt: record.createdAt,
    })
    content = `${content.slice(0, candidate.start)}${marker}${content.slice(candidate.end)}`
  }

  writeVault(vault)

  // Convenience copy for provider configuration and explicit Bash env_keys.
  // Shared-member profiles keep their own vault entry when the inherited admin
  // environment is intentionally read-only.
  for (const ref of refs) {
    const record = vault.records.find((item) => item.id === ref.id)
    if (!record) continue
    try {
      upsertWorkspaceEnvValue(ref.key, record.value)
    } catch {
      // The private vault remains authoritative and immediately usable.
    }
  }

  return {
    message: { ...message, content, secretRefs: refs },
    capturedKeys: refs.map((ref) => ref.key),
  }
}

export function protectConversationMessages(messages: Message[]): Message[] {
  return messages.map((message) => protectUserMessage(message).message)
}

export function getCapturedSecretValue(key: string): string | null {
  const normalized = normalizeEnvKey(key)
  const records = readVault().records
    .filter((record) => record.key === normalized && record.value.length > 0)
    .sort((a, b) => b.updatedAt - a.updatedAt)
  return records[0]?.value ?? null
}

export function listCapturedSecretKeys(): string[] {
  return Array.from(new Set(readVault().records.map((record) => record.key))).sort()
}

export function revealMessageSecret(messageId: string, secretId: string): string | null {
  const record = readVault().records.find(
    (item) => item.id === secretId && item.messageId === messageId
  )
  return record?.value ?? null
}

export function contentForModel(message: Pick<Message, "content" | "secretRefs">): string {
  if (!message.secretRefs?.length) return message.content
  let content = message.content
  for (const ref of message.secretRefs) {
    content = content.split(ref.marker).join(
      `[Secret saved as ${ref.key}. Use ListEnvVars, then pass ${ref.key} in Bash env_keys; do not ask for or repeat its value.]`
    )
  }
  return content
}

function validateSecretRefs(message: Message): MessageSecretRef[] {
  if (!message.secretRefs?.length) return []
  const records = new Map(readVault().records.map((record) => [record.id, record]))
  return message.secretRefs.filter((ref) => {
    const record = records.get(ref.id)
    return (
      record?.messageId === message.id &&
      record.key === ref.key &&
      ref.marker === `⟦secret:${ref.id}⟧` &&
      message.content.includes(ref.marker)
    )
  })
}

export function containsSecretMarker(content: string): boolean {
  SECRET_MARKER_RE.lastIndex = 0
  const result = SECRET_MARKER_RE.test(content)
  SECRET_MARKER_RE.lastIndex = 0
  return result
}
