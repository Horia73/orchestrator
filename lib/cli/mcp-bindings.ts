import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

import type { ToolDef, ToolExecutionContext } from '@/lib/ai/agents/types'
import { getActiveProfileContext, normalizeProfileId, type ActiveProfileContext } from '@/lib/profiles/context'
import { PRIVATE_STATE_DIR } from '@/lib/runtime-paths'

/**
 * In-memory token → execution context store for the MCP stdio proxy.
 *
 * When a CLI provider (claude-code, codex) is invoked, we spawn a stdio MCP
 * server as a child of the CLI process. That MCP server lives in a separate
 * process and can't share JS state with us, so it talks back via HTTP to
 * /api/cli/mcp-exec. Each invocation gets a short-lived token here; the
 * endpoint resolves the token to the original tool list + execution context.
 *
 * `globalThis` carries the map across Next.js dev hot reloads — same trick
 * `chat-streams.ts` uses — so a pending CLI run survives an edit-save cycle.
 */

export interface Binding {
    ctx: ToolExecutionContext
    toolDefs: ToolDef[]
    createdAt: number
    profileContext: ActiveProfileContext
}

export interface PortableBinding {
    ctx: ToolExecutionContext
    toolIds: string[]
    createdAt: number
    profileContext: ActiveProfileContext
}

const globalForBindings = globalThis as unknown as {
    __orchestratorMcpBindings?: Map<string, Binding>
}

const bindings = globalForBindings.__orchestratorMcpBindings ?? new Map<string, Binding>()
if (!globalForBindings.__orchestratorMcpBindings) {
    globalForBindings.__orchestratorMcpBindings = bindings
}

/** Stale-binding sweep: drop entries older than this. */
const BINDING_TTL_MS = 30 * 60_000  // 30 minutes — well past any normal CLI turn
const TOKEN_VERSION = 1
const TOKEN_PREFIX = 'mcpb1'
const TOKEN_SECRET_PATH = join(PRIVATE_STATE_DIR, 'mcp-auth-secret')

function sweep() {
    const cutoff = Date.now() - BINDING_TTL_MS
    for (const [token, b] of bindings) {
        if (b.createdAt < cutoff) bindings.delete(token)
    }
}

export function createBinding(ctx: ToolExecutionContext, toolDefs: ToolDef[]): string {
    sweep()
    const profileContext = getActiveProfileContext()
    const token = createPortableToken(ctx, toolDefs, profileContext)
    bindings.set(token, { ctx, toolDefs, createdAt: Date.now(), profileContext })
    return token
}

export function getBinding(token: string): Binding | undefined {
    sweep()
    return bindings.get(token)
}

export function clearBinding(token: string): void {
    bindings.delete(token)
}

export function decodePortableBinding(token: string): PortableBinding | undefined {
    const parts = token.split('.')
    if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) return undefined

    const [, payloadPart, signaturePart] = parts
    const expected = hmac(payloadPart)
    const provided = base64UrlDecode(signaturePart)
    if (
        provided.length !== expected.length ||
        !timingSafeEqual(provided, expected)
    ) {
        return undefined
    }

    let payload: unknown
    try {
        payload = JSON.parse(base64UrlDecode(payloadPart).toString('utf-8'))
    } catch {
        return undefined
    }

    const parsed = parsePortablePayload(payload)
    if (!parsed) return undefined
    if (parsed.exp < Date.now()) return undefined
    return {
        ctx: parsed.ctx,
        toolIds: parsed.toolIds,
        createdAt: parsed.iat,
        profileContext: parsed.profileContext,
    }
}

function createPortableToken(
    ctx: ToolExecutionContext,
    toolDefs: ToolDef[],
    profileContext: ActiveProfileContext,
): string {
    const now = Date.now()
    const payload = {
        v: TOKEN_VERSION,
        jti: randomUUID(),
        iat: now,
        exp: now + BINDING_TTL_MS,
        profile: {
            profileId: normalizeProfileId(profileContext.profileId),
            role: profileContext.role,
        },
        ctx: serializableContext(ctx),
        toolIds: toolDefs.map(tool => tool.id),
    }
    const payloadPart = base64UrlEncode(Buffer.from(JSON.stringify(payload)))
    const signaturePart = base64UrlEncode(hmac(payloadPart))
    return `${TOKEN_PREFIX}.${payloadPart}.${signaturePart}`
}

function serializableContext(ctx: ToolExecutionContext): Record<string, unknown> {
    return {
        callerAgentId: ctx.callerAgentId,
        depth: ctx.depth,
        conversationId: ctx.conversationId,
        agentThreadId: ctx.agentThreadId,
        parentRequestId: ctx.parentRequestId,
        parentAgentRunId: ctx.parentAgentRunId,
        appOrigin: ctx.appOrigin,
        scheduledTaskId: ctx.scheduledTaskId,
        scheduledFiredAt: ctx.scheduledFiredAt,
        preactivatedCapabilities: ctx.preactivatedCapabilities,
        toolSurfaceMode: ctx.toolSurfaceMode,
    }
}

function parsePortablePayload(payload: unknown): {
    iat: number
    exp: number
    ctx: ToolExecutionContext
    toolIds: string[]
    profileContext: ActiveProfileContext
} | null {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
    const raw = payload as Record<string, unknown>
    if (raw.v !== TOKEN_VERSION) return null
    const iat = validMs(raw.iat)
    const exp = validMs(raw.exp)
    if (iat === null || exp === null) return null

    const profile = objectRecord(raw.profile)
    if (!profile) return null
    const profileId = typeof profile.profileId === 'string'
        ? normalizeProfileId(profile.profileId)
        : null
    if (!profileId) return null
    const role = profile.role === 'admin' || profile.role === 'member'
        ? profile.role
        : undefined

    const ctxRaw = objectRecord(raw.ctx)
    if (!ctxRaw) return null
    const callerAgentId = cleanString(ctxRaw.callerAgentId)
    const conversationId = cleanString(ctxRaw.conversationId)
    const parentRequestId = cleanString(ctxRaw.parentRequestId)
    const depth = validNonNegativeInt(ctxRaw.depth)
    if (!callerAgentId || !conversationId || !parentRequestId || depth === null) {
        return null
    }

    const toolIds = Array.isArray(raw.toolIds)
        ? raw.toolIds.filter((item): item is string => typeof item === 'string' && item.length > 0)
        : []
    if (toolIds.length === 0) return null

    const preactivatedCapabilities = Array.isArray(ctxRaw.preactivatedCapabilities)
        ? ctxRaw.preactivatedCapabilities.filter((item): item is string => typeof item === 'string' && item.length > 0)
        : undefined
    const toolSurfaceMode = ctxRaw.toolSurfaceMode === 'read-only'
        ? 'read-only'
        : ctxRaw.toolSurfaceMode === 'default'
            ? 'default'
            : undefined

    const ctx: ToolExecutionContext = {
        callerAgentId,
        depth,
        conversationId,
        parentRequestId,
        agentThreadId: cleanString(ctxRaw.agentThreadId),
        parentAgentRunId: cleanString(ctxRaw.parentAgentRunId),
        appOrigin: cleanString(ctxRaw.appOrigin),
        scheduledTaskId: cleanString(ctxRaw.scheduledTaskId),
        scheduledFiredAt: validMs(ctxRaw.scheduledFiredAt) ?? undefined,
        preactivatedCapabilities,
        toolSurfaceMode,
    }

    return {
        iat,
        exp,
        ctx,
        toolIds: Array.from(new Set(toolIds)),
        profileContext: { profileId, role },
    }
}

function objectRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null
}

function cleanString(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined
    const trimmed = value.trim()
    return trimmed ? trimmed : undefined
}

function validMs(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? Math.floor(value)
        : null
}

function validNonNegativeInt(value: unknown): number | null {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0
        ? value
        : null
}

function hmac(payloadPart: string): Buffer {
    return createHmac('sha256', tokenSecret()).update(payloadPart).digest()
}

function tokenSecret(): Buffer {
    const fromEnv = process.env.ORCHESTRATOR_MCP_BINDING_SECRET
    if (fromEnv) return Buffer.from(fromEnv, 'utf-8')

    try {
        if (existsSync(TOKEN_SECRET_PATH)) {
            const value = readFileSync(TOKEN_SECRET_PATH)
            if (value.length >= 32) return value
        }
    } catch {
        // Regenerate below.
    }

    const secret = randomBytes(32)
    mkdirSync(PRIVATE_STATE_DIR, { recursive: true })
    writeFileSync(TOKEN_SECRET_PATH, secret, { mode: 0o600 })
    return secret
}

function base64UrlEncode(buf: Buffer): string {
    return buf.toString('base64url')
}

function base64UrlDecode(value: string): Buffer {
    return Buffer.from(value, 'base64url')
}
