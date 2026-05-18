import fs from 'fs'

import type { ToolDef, ToolResult } from '@/lib/ai/agents/types'
import { displayPath, resolveSandboxedWritable } from './sandbox'
import { ensureParentDir, stringArg } from './helpers'

const ENV_LABEL_PREFIX = '# @label '

export const setEnvTool: ToolDef = {
    id: 'SetEnv',
    name: 'SetEnv',
    description: [
        'Sets or updates one variable in the workspace .env.local file.',
        'Use this for API keys, tokens, service URLs, local IPs, and runtime configuration that should not go into markdown memory.',
        'Include a short label when the service is known so the Settings UI can show a human-readable name.',
        'The value is written to disk but never returned in the tool result.',
    ].join(' '),
    input_schema: {
        type: 'object',
        properties: {
            key: {
                type: 'string',
                description: 'Environment variable name, e.g. HOME_ASSISTANT_TOKEN.',
            },
            value: {
                type: 'string',
                description: 'Environment variable value. This is sensitive and will be redacted in UI/tool logs.',
            },
            label: {
                type: 'string',
                description: 'Optional short UI label for this variable, e.g. OpenAI, Google, Home Assistant, Stripe.',
            },
        },
        required: ['key', 'value'],
    },
    tags: ['write', 'filesystem', 'secret'],
}

export function executeSetEnv(args: Record<string, unknown>): ToolResult {
    const key = stringArg(args, ['key', 'name'])
    const value = args.value
    const labelProvided = typeof args.label === 'string'
    const label = labelProvided ? formatEnvLabel(args.label as string) : null

    if (!key) return { success: false, error: 'Missing required parameter: key' }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        return { success: false, error: `Invalid env var name: ${key}` }
    }
    if (typeof value !== 'string') return { success: false, error: 'Missing required string parameter: value' }

    const sandboxed = resolveSandboxedWritable('.env.local')
    if (!sandboxed.ok) return { success: false, error: sandboxed.error }

    try {
        ensureParentDir(sandboxed.resolved)
        const existing = fs.existsSync(sandboxed.resolved)
            ? fs.readFileSync(sandboxed.resolved, 'utf-8')
            : ''
        const lines = existing.split(/\r?\n/)
        const formatted = `${key}=${formatEnvValue(value)}`
        let action: 'created' | 'updated' = 'created'
        const next = [...lines]
        let keyIndex = next.findIndex(line => isKeyLine(line, key))

        if (keyIndex >= 0) {
            action = 'updated'
            next[keyIndex] = formatted
            if (labelProvided) {
                keyIndex = applyEnvLabel(next, keyIndex, label)
            }
        } else {
            while (next.length > 0 && next[next.length - 1] === '') next.pop()
            if (label) next.push(`${ENV_LABEL_PREFIX}${label}`)
            next.push(formatted)
        }

        const output = next.join('\n').replace(/\n*$/, '\n')
        fs.writeFileSync(sandboxed.resolved, output, 'utf-8')
        try {
            fs.chmodSync(sandboxed.resolved, 0o600)
        } catch {
            // Best effort; some filesystems ignore chmod.
        }

        return {
            success: true,
            data: {
                path: displayPath(sandboxed.resolved),
                key,
                label: label || undefined,
                action,
                value: '[redacted]',
                bytes: Buffer.byteLength(output, 'utf-8'),
            },
        }
    } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : 'Unknown error writing env var' }
    }
}

function isKeyLine(line: string, key: string): boolean {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) return false
    const idx = trimmed.indexOf('=')
    if (idx <= 0) return false
    return trimmed.slice(0, idx).trim() === key
}

function applyEnvLabel(lines: string[], keyIndex: number, label: string | null): number {
    const existingLabelIndex = keyIndex > 0 && isEnvLabelLine(lines[keyIndex - 1])
        ? keyIndex - 1
        : -1

    if (!label) {
        if (existingLabelIndex >= 0) {
            lines.splice(existingLabelIndex, 1)
            return keyIndex - 1
        }
        return keyIndex
    }

    const labelLine = `${ENV_LABEL_PREFIX}${label}`
    if (existingLabelIndex >= 0) {
        lines[existingLabelIndex] = labelLine
        return keyIndex
    }

    lines.splice(keyIndex, 0, labelLine)
    return keyIndex + 1
}

function isEnvLabelLine(line: string): boolean {
    return /^\s*#\s*@label\s+/.test(line)
}

function formatEnvLabel(value: string): string {
    return value.replace(/[\r\n]/g, ' ').trim()
}

function formatEnvValue(value: string): string {
    if (value === '') return '""'
    if (/^[A-Za-z0-9_./:@%+=,\-]+$/.test(value)) return value
    return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}
