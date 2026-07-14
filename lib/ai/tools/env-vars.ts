import fs from 'fs'

import type { ToolDef, ToolResult } from '@/lib/ai/agents/types'
import {
    activeProfileCanReadAdminEnvironment,
    activeProfileUsesAdminEnvironment,
    effectiveWorkspaceEnvPath,
    effectiveWorkspaceEnvSourceLabel,
} from '@/lib/profiles/env-sharing'
import { parseEnvAssignment, parseEnvStoredValue } from '@/lib/settings/workspace-files-env'
import { displayPath } from './sandbox'
import { booleanArg, numberArg, stringArg } from './helpers'

type EnvVarSource = 'workspace' | 'process'

interface EnvVarListing {
    key: string
    sources: EnvVarSource[]
    has_value: boolean
    workspace_occurrences?: number
}

interface WorkspaceEnvEntry {
    key: string
    value: string
    hasValue: boolean
    occurrences: number
}

export interface SecretRedaction {
    key: string
    value: string
    marker: string
}

export interface EnvVarInjection {
    env: Record<string, string>
    keys: string[]
    sources: Record<string, EnvVarSource>
    redactions: SecretRedaction[]
}

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const DEFAULT_LIST_LIMIT = 100
const MAX_LIST_LIMIT = 500
const MAX_ENV_KEYS = 50

export const listEnvVarsTool: ToolDef = {
    id: 'ListEnvVars',
    name: 'ListEnvVars',
    description: [
        'Lists environment variable names available to the current profile without revealing values.',
        'Use this to discover the right key name before calling Bash with env_keys or SetEnv.',
        'Values are never returned; only names, sources, and whether a non-empty value exists are shown.',
    ].join(' '),
    input_schema: {
        type: 'object',
        properties: {
            query: {
                type: 'string',
                description: 'Optional case-insensitive substring filter for env var names, e.g. SHOPIFY or THEME.',
            },
            include_process: {
                type: 'boolean',
                description: 'Also list matching names from the running Orchestrator process environment. Defaults to false.',
            },
            limit: {
                type: 'integer',
                description: `Maximum number of names to return. Defaults to ${DEFAULT_LIST_LIMIT}, capped at ${MAX_LIST_LIMIT}.`,
            },
        },
    },
    tags: ['read', 'filesystem', 'secret'],
}

export function executeListEnvVars(args: Record<string, unknown> = {}): ToolResult {
    const query = stringArg(args, ['query', 'filter']).trim().toLowerCase()
    const includeProcess = booleanArg(args, ['include_process', 'includeProcess'])
    const limit = Math.floor(Math.min(MAX_LIST_LIMIT, Math.max(1, numberArg(args, ['limit'], DEFAULT_LIST_LIMIT))))
    const rows = new Map<string, EnvVarListing>()

    for (const entry of readWorkspaceEnvEntries().values()) {
        upsertListing(rows, entry.key, 'workspace', entry.hasValue, entry.occurrences)
    }

    const processEnvironmentAvailable = activeProfileCanReadAdminEnvironment()
    if (includeProcess && processEnvironmentAvailable) {
        for (const [key, value] of Object.entries(process.env)) {
            if (!ENV_NAME_RE.test(key)) continue
            upsertListing(rows, key, 'process', hasEnvValue(value))
        }
    }

    const filtered = Array.from(rows.values())
        .filter(row => !query || row.key.toLowerCase().includes(query))
        .sort((a, b) => a.key.localeCompare(b.key))
    const entries = filtered.slice(0, limit)

    return {
        success: true,
        data: {
            entries,
            count: entries.length,
            total_matches: filtered.length,
            truncated: filtered.length > entries.length,
            sources: {
                workspace: activeProfileUsesAdminEnvironment()
                    ? effectiveWorkspaceEnvSourceLabel()
                    : displayPath(effectiveWorkspaceEnvPath()),
                process: includeProcess
                    ? (processEnvironmentAvailable ? 'runtime process environment' : 'not available to this profile')
                    : 'not included',
            },
            note: 'Secret values are intentionally not returned. Pass selected names to Bash env_keys to inject them into a command without exposing them in tool args/results.',
        },
    }
}

export function collectEnvKeys(args: Record<string, unknown>): string[] {
    const raw = args.env_keys ?? args.envKeys
    const out: string[] = []
    const push = (value: unknown) => {
        if (typeof value !== 'string') return
        for (const part of value.split(/[,\s]+/)) {
            const trimmed = part.trim()
            if (trimmed) out.push(trimmed)
        }
    }
    if (Array.isArray(raw)) raw.forEach(push)
    else push(raw)
    return out
}

export function resolveEnvVarInjection(keys: string[]): { ok: true; injection: EnvVarInjection } | { ok: false; error: string; missing?: string[] } {
    const uniqueKeys = dedupe(keys)
    if (uniqueKeys.length === 0) {
        return { ok: true, injection: { env: {}, keys: [], sources: {}, redactions: [] } }
    }
    if (uniqueKeys.length > MAX_ENV_KEYS) {
        return { ok: false, error: `Too many env vars requested; maximum is ${MAX_ENV_KEYS}.` }
    }

    const invalid = uniqueKeys.filter(key => !ENV_NAME_RE.test(key))
    if (invalid.length > 0) {
        return { ok: false, error: `Invalid env var name(s): ${invalid.join(', ')}` }
    }

    const workspace = readWorkspaceEnvEntries()
    const env: Record<string, string> = {}
    const sources: Record<string, EnvVarSource> = {}
    const missing: string[] = []
    const redactions: SecretRedaction[] = []

    for (const key of uniqueKeys) {
        const workspaceEntry = workspace.get(key)
        if (workspaceEntry?.hasValue) {
            env[key] = workspaceEntry.value
            sources[key] = 'workspace'
            redactions.push({ key, value: workspaceEntry.value, marker: `[redacted:${key}]` })
            continue
        }

        const processValue = activeProfileCanReadAdminEnvironment()
            ? process.env[key]
            : undefined
        if (hasEnvValue(processValue)) {
            env[key] = processValue
            sources[key] = 'process'
            redactions.push({ key, value: processValue, marker: `[redacted:${key}]` })
            continue
        }

        missing.push(key)
    }

    if (missing.length > 0) {
        return {
            ok: false,
            error: `Missing env var(s): ${missing.join(', ')}. Use ListEnvVars to discover configured names or SetEnv to store the value first.`,
            missing,
        }
    }

    return { ok: true, injection: { env, keys: uniqueKeys, sources, redactions } }
}

export function redactSecretText(text: string, redactions: SecretRedaction[]): string {
    if (!text || redactions.length === 0) return text
    let out = text
    for (const item of redactions) {
        if (!item.value) continue
        out = out.split(item.value).join(item.marker)
    }
    return out
}

export function createSecretStreamRedactor(redactions: SecretRedaction[]): { push: (text: string) => string; flush: () => string } {
    if (redactions.length === 0) {
        return {
            push: text => text,
            flush: () => '',
        }
    }

    const maxSecretLength = Math.max(...redactions.map(item => item.value.length))
    const keepChars = Math.max(0, maxSecretLength - 1)
    let buffer = ''

    const drain = (final: boolean): string => {
        let out = ''

        while (buffer) {
            const match = findEarliestSecret(buffer, redactions)
            if (match) {
                out += buffer.slice(0, match.index)
                out += match.redaction.marker
                buffer = buffer.slice(match.index + match.redaction.value.length)
                continue
            }

            if (final) {
                out += buffer
                buffer = ''
                break
            }

            if (buffer.length <= keepChars) break
            const emitLength = buffer.length - keepChars
            out += buffer.slice(0, emitLength)
            buffer = buffer.slice(emitLength)
            break
        }

        return out
    }

    return {
        push(text: string): string {
            if (!text) return ''
            buffer += text
            return drain(false)
        },
        flush(): string {
            return drain(true)
        },
    }
}

function readWorkspaceEnvEntries(): Map<string, WorkspaceEnvEntry> {
    const filePath = effectiveWorkspaceEnvPath()
    const entries = new Map<string, WorkspaceEnvEntry>()
    let content = ''
    try {
        if (!fs.existsSync(filePath)) return entries
        content = fs.readFileSync(filePath, 'utf-8')
    } catch {
        return entries
    }

    for (const line of content.replace(/\r\n/g, '\n').split('\n')) {
        const parsed = parseEnvAssignment(line)
        if (!parsed) continue
        const stored = parseEnvStoredValue(parsed.value)
        const previous = entries.get(parsed.key)
        const next: WorkspaceEnvEntry = {
            key: parsed.key,
            value: stored.value,
            hasValue: hasEnvValue(stored.value),
            occurrences: (previous?.occurrences ?? 0) + 1,
        }
        if (next.hasValue || !previous?.hasValue) {
            entries.set(parsed.key, next)
        } else {
            entries.set(parsed.key, { ...previous, occurrences: next.occurrences })
        }
    }

    return entries
}

function upsertListing(
    rows: Map<string, EnvVarListing>,
    key: string,
    source: EnvVarSource,
    hasValue: boolean,
    workspaceOccurrences?: number,
): void {
    const existing = rows.get(key)
    if (!existing) {
        rows.set(key, {
            key,
            sources: [source],
            has_value: hasValue,
            ...(workspaceOccurrences ? { workspace_occurrences: workspaceOccurrences } : {}),
        })
        return
    }
    if (!existing.sources.includes(source)) existing.sources.push(source)
    existing.has_value ||= hasValue
    if (workspaceOccurrences) existing.workspace_occurrences = workspaceOccurrences
}

function hasEnvValue(value: string | undefined): value is string {
    return typeof value === 'string' && value.trim() !== ''
}

function dedupe(items: string[]): string[] {
    const out: string[] = []
    const seen = new Set<string>()
    for (const item of items) {
        const trimmed = item.trim()
        if (!trimmed || seen.has(trimmed)) continue
        seen.add(trimmed)
        out.push(trimmed)
    }
    return out
}

function findEarliestSecret(text: string, redactions: SecretRedaction[]): { index: number; redaction: SecretRedaction } | null {
    let found: { index: number; redaction: SecretRedaction } | null = null
    for (const redaction of redactions) {
        if (!redaction.value) continue
        const index = text.indexOf(redaction.value)
        if (index < 0) continue
        if (
            !found ||
            index < found.index ||
            (index === found.index && redaction.value.length > found.redaction.value.length)
        ) {
            found = { index, redaction }
        }
    }
    return found
}
