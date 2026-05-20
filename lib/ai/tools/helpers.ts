import fs from 'fs'
import path from 'path'

import { AGENT_WORKSPACE_DIR } from '@/lib/runtime-paths'

export const DEFAULT_MAX_OUTPUT_CHARS = 100_000

export function stringArg(args: Record<string, unknown>, keys: string[]): string {
    for (const key of keys) {
        const value = args[key]
        if (typeof value === 'string') return value
    }
    return ''
}

export function numberArg(args: Record<string, unknown>, keys: string[], fallback: number): number {
    for (const key of keys) {
        const value = args[key]
        if (typeof value === 'number' && Number.isFinite(value)) return value
        if (typeof value === 'string' && value.trim() !== '') {
            const parsed = Number(value)
            if (Number.isFinite(parsed)) return parsed
        }
    }
    return fallback
}

export function booleanArg(args: Record<string, unknown>, keys: string[], fallback = false): boolean {
    for (const key of keys) {
        const value = args[key]
        if (typeof value === 'boolean') return value
        if (typeof value === 'string') {
            if (value.toLowerCase() === 'true') return true
            if (value.toLowerCase() === 'false') return false
        }
    }
    return fallback
}

export function clamp(n: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, n))
}

export function truncateText(text: string, maxChars = DEFAULT_MAX_OUTPUT_CHARS): { text: string; truncated: boolean } {
    if (text.length <= maxChars) return { text, truncated: false }
    const keepHead = Math.floor(maxChars * 0.6)
    const keepTail = maxChars - keepHead
    return {
        text: `${text.slice(0, keepHead)}\n\n...[truncated ${text.length - maxChars} chars]...\n\n${text.slice(-keepTail)}`,
        truncated: true,
    }
}

export function ensureParentDir(filePath: string): void {
    fs.mkdirSync(/* turbopackIgnore: true */ path.dirname(filePath), { recursive: true })
}

export function workspaceCwd(inputPath?: string): string {
    const raw = inputPath?.trim()
    if (!raw) return AGENT_WORKSPACE_DIR
    return path.isAbsolute(raw)
        ? raw
        : path.resolve(/* turbopackIgnore: true */ AGENT_WORKSPACE_DIR, raw)
}

export function isProbablyBinary(buffer: Buffer): boolean {
    const len = Math.min(buffer.length, 8000)
    for (let i = 0; i < len; i++) {
        if (buffer[i] === 0) return true
    }
    return false
}
