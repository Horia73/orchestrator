import fs from 'fs'
import path from 'path'

import { activeRuntimePaths } from '@/lib/runtime-paths'

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

/**
 * Collect target IDs from a tool's args, scanning each key in order. A key may
 * hold a single string (one ID) or an array of strings (many IDs). Used by
 * batch-capable per-item tools that accept both a singular field (e.g. `id`,
 * `chat_id`) and a plural one (e.g. `ids`, `chat_ids`). Trims, drops empties,
 * and de-duplicates while preserving first-seen order.
 */
export function collectIds(args: Record<string, unknown>, keys: string[]): string[] {
    const out: string[] = []
    const seen = new Set<string>()
    const push = (value: unknown): void => {
        if (typeof value !== 'string') return
        const trimmed = value.trim()
        if (trimmed && !seen.has(trimmed)) {
            seen.add(trimmed)
            out.push(trimmed)
        }
    }
    for (const key of keys) {
        const value = args[key]
        if (Array.isArray(value)) value.forEach(push)
        else push(value)
    }
    return out
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
    const dir = path.dirname(/* turbopackIgnore: true */ filePath)
    fs.mkdirSync(/* turbopackIgnore: true */ dir, { recursive: true })
}

export function workspaceCwd(inputPath?: string): string {
    const workspaceDir = activeRuntimePaths().agentWorkspaceDir
    const raw = inputPath?.trim()
    if (!raw) return workspaceDir
    return path.isAbsolute(raw)
        ? raw
        : path.resolve(/* turbopackIgnore: true */ workspaceDir, raw)
}

export function isProbablyBinary(buffer: Buffer): boolean {
    const len = Math.min(buffer.length, 8000)
    for (let i = 0; i < len; i++) {
        if (buffer[i] === 0) return true
    }
    return false
}
