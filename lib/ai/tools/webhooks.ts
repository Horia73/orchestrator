import type { ToolDef, ToolExecutionContext, ToolResult } from '@/lib/ai/agents/types'
import {
    createWebhookEndpoint,
    createWebhookSubscription,
    deleteWebhookEndpoint,
    getWebhookEndpointByIdOrSlug,
    listWebhookEndpoints,
    listWebhookSubscriptions,
    toPublicWebhookEndpoint,
    updateWebhookEndpoint,
} from '@/lib/webhooks/store'
import { WebhookAuthModeSchema } from '@/lib/webhooks/schema'

const AUTH_MODES = ['bearer', 'hmac', 'svix', 'none'] as const

export const webhookDescribeCapabilitiesTool: ToolDef = {
    id: 'webhook_describe_capabilities',
    name: 'webhook_describe_capabilities',
    description: 'Describe generic inbound webhook endpoint auth profiles, provider compatibility, event persistence, and Microscript dispatch.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    tags: ['webhooks', 'microscripts'],
}

export function executeWebhookDescribeCapabilities(args: Record<string, unknown> = {}): ToolResult {
    const unknown = rejectUnknownArgs('webhook_describe_capabilities', args, [])
    if (unknown) return unknown
    return {
        success: true,
        data: {
            auth_modes: {
                bearer: 'Authorization: Bearer <secret>, x-orchestrator-webhook-secret, or x-webhook-secret.',
                hmac: [
                    'Generic HMAC-SHA256 for providers such as Shopify, GitHub, Stripe, Slack, and simple custom senders.',
                    'Accepted signature headers include x-orchestrator-signature, x-hub-signature-256, x-webhook-signature, x-shopify-hmac-sha256, x-signature, x-signature-256, x-slack-signature, and stripe-signature.',
                    'Hex and base64 digests are accepted. Timestamped schemes verify tolerance when a timestamp header is present.',
                ].join(' '),
                svix: 'Svix / Standard Webhooks profile for Resend, Clerk, and compatible senders using svix-* or webhook-* headers with whsec_* signing secrets.',
                none: 'No authentication. Use only for local testing or a temporary high-entropy slug workaround.',
            },
            flow: [
                'Create a webhook endpoint.',
                'Create or update a Microscript that handles ctx["trigger"] == "webhook".',
                'Create a webhook subscription from the endpoint to that Microscript, optionally filtering event_type, payload_path, and payload_equals.',
                'Provider calls POST /api/webhooks/<slug> with a JSON object. The app authenticates, rate-limits, persists, dedupes, normalizes, and dispatches to matching subscriptions.',
            ],
            tool_argument_schemas: {
                webhook_create: 'Required: {title, slug}. Optional: description, source, default_event_type, auth_mode, secret, enabled, rate_limit_per_minute, retention_days, hmac_tolerance_seconds.',
                webhook_update: 'Required: {endpoint_id_or_slug}. Optional endpoint fields plus secret or rotate_secret.',
                webhook_subscription_create: 'Required: {endpoint_id_or_slug, target_id}. Optional: event_type, payload_path, payload_equals object, payload_equals_json string.',
            },
        },
    }
}

export const webhookListTool: ToolDef = {
    id: 'webhook_list',
    name: 'webhook_list',
    description: 'List configured inbound webhook endpoints without exposing secrets.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    tags: ['webhooks', 'microscripts'],
}

export function executeWebhookList(args: Record<string, unknown> = {}): ToolResult {
    const unknown = rejectUnknownArgs('webhook_list', args, [])
    if (unknown) return unknown
    return {
        success: true,
        data: {
            endpoints: listWebhookEndpoints().map(toPublicWebhookEndpoint),
        },
    }
}

export const webhookCreateTool: ToolDef = {
    id: 'webhook_create',
    name: 'webhook_create',
    description: 'Create a generic inbound webhook endpoint. Returns a generated secret once when auth is enabled and no secret was supplied.',
    input_schema: {
        type: 'object',
        properties: {
            title: { type: 'string' },
            slug: { type: 'string' },
            description: { type: 'string' },
            source: { type: 'string' },
            default_event_type: { type: 'string' },
            auth_mode: { type: 'string', enum: [...AUTH_MODES] },
            secret: { type: 'string', description: 'Optional provider signing/token secret. Treated as sensitive and not returned.' },
            enabled: { type: 'boolean' },
            rate_limit_per_minute: { type: 'number' },
            retention_days: { type: 'number' },
            hmac_tolerance_seconds: { type: 'number' },
        },
        required: ['title', 'slug'],
        additionalProperties: false,
    },
    tags: ['webhooks', 'microscripts', 'write', 'secret'],
}

export function executeWebhookCreate(args: Record<string, unknown>, ctx?: ToolExecutionContext): ToolResult {
    const unknown = rejectUnknownArgs('webhook_create', args, [
        'title',
        'slug',
        'description',
        'source',
        'default_event_type',
        'auth_mode',
        'secret',
        'enabled',
        'rate_limit_per_minute',
        'retention_days',
        'hmac_tolerance_seconds',
    ])
    if (unknown) return unknown

    try {
        const authMode = optionalAuthMode(args.auth_mode) ?? 'bearer'
        const { endpoint, generatedSecret } = createWebhookEndpoint({
            title: requiredString(args.title, 'title'),
            slug: requiredString(args.slug, 'slug'),
            description: optionalString(args.description),
            source: optionalString(args.source),
            defaultEventType: optionalString(args.default_event_type),
            authMode,
            secret: optionalString(args.secret),
            enabled: optionalBoolean(args.enabled) ?? true,
            rateLimitPerMinute: optionalNumber(args.rate_limit_per_minute) ?? 120,
            retentionDays: optionalNumber(args.retention_days) ?? 30,
            hmacToleranceSeconds: optionalNumber(args.hmac_tolerance_seconds) ?? 300,
        }, 'orchestrator')
        return {
            success: true,
            data: {
                endpoint: toPublicWebhookEndpoint(endpoint),
                ingress_url: ingressUrl(ctx, endpoint.slug),
                ...(generatedSecret ? { secret: generatedSecret } : {}),
            },
        }
    } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : 'Failed to create webhook.' }
    }
}

export const webhookUpdateTool: ToolDef = {
    id: 'webhook_update',
    name: 'webhook_update',
    description: 'Patch an inbound webhook endpoint. Use this to set provider secrets, switch auth modes, rotate secrets, pause, or tune retention/rate limits.',
    input_schema: {
        type: 'object',
        properties: {
            endpoint_id_or_slug: { type: 'string' },
            title: { type: 'string' },
            description: { type: 'string' },
            source: { type: 'string' },
            default_event_type: { type: 'string' },
            auth_mode: { type: 'string', enum: [...AUTH_MODES] },
            secret: { type: 'string', description: 'Optional replacement provider signing/token secret. Treated as sensitive and not returned.' },
            rotate_secret: { type: 'boolean' },
            enabled: { type: 'boolean' },
            rate_limit_per_minute: { type: 'number' },
            retention_days: { type: 'number' },
            hmac_tolerance_seconds: { type: 'number' },
        },
        required: ['endpoint_id_or_slug'],
        additionalProperties: false,
    },
    tags: ['webhooks', 'microscripts', 'write', 'secret'],
}

export function executeWebhookUpdate(args: Record<string, unknown>, ctx?: ToolExecutionContext): ToolResult {
    const unknown = rejectUnknownArgs('webhook_update', args, [
        'endpoint_id_or_slug',
        'title',
        'description',
        'source',
        'default_event_type',
        'auth_mode',
        'secret',
        'rotate_secret',
        'enabled',
        'rate_limit_per_minute',
        'retention_days',
        'hmac_tolerance_seconds',
    ])
    if (unknown) return unknown

    try {
        const id = requiredString(args.endpoint_id_or_slug, 'endpoint_id_or_slug')
        const updated = updateWebhookEndpoint(id, {
            title: optionalString(args.title),
            description: optionalNullableString(args.description),
            source: optionalNullableString(args.source),
            defaultEventType: optionalNullableString(args.default_event_type),
            authMode: optionalAuthMode(args.auth_mode),
            secret: optionalString(args.secret),
            rotateSecret: optionalBoolean(args.rotate_secret),
            enabled: optionalBoolean(args.enabled),
            rateLimitPerMinute: optionalNumber(args.rate_limit_per_minute),
            retentionDays: optionalNumber(args.retention_days),
            hmacToleranceSeconds: optionalNumber(args.hmac_tolerance_seconds),
        })
        if (!updated) return { success: false, error: `No webhook endpoint found for ${id}.` }
        return {
            success: true,
            data: {
                endpoint: toPublicWebhookEndpoint(updated.endpoint),
                ingress_url: ingressUrl(ctx, updated.endpoint.slug),
                ...(updated.generatedSecret ? { secret: updated.generatedSecret } : {}),
            },
        }
    } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : 'Failed to update webhook.' }
    }
}

export const webhookDeleteTool: ToolDef = {
    id: 'webhook_delete',
    name: 'webhook_delete',
    description: 'Delete an inbound webhook endpoint, its subscriptions, and retained events.',
    input_schema: {
        type: 'object',
        properties: {
            endpoint_id_or_slug: { type: 'string' },
        },
        required: ['endpoint_id_or_slug'],
        additionalProperties: false,
    },
    tags: ['webhooks', 'microscripts', 'write'],
}

export function executeWebhookDelete(args: Record<string, unknown>): ToolResult {
    const unknown = rejectUnknownArgs('webhook_delete', args, ['endpoint_id_or_slug'])
    if (unknown) return unknown
    const id = requiredString(args.endpoint_id_or_slug, 'endpoint_id_or_slug')
    const deleted = deleteWebhookEndpoint(id)
    return deleted
        ? { success: true, data: { endpoint_id_or_slug: id, deleted: true } }
        : { success: false, error: `No webhook endpoint found for ${id}.` }
}

export const webhookSubscriptionCreateTool: ToolDef = {
    id: 'webhook_subscription_create',
    name: 'webhook_subscription_create',
    description: 'Subscribe an inbound webhook endpoint to a Microscript target, optionally filtering by event type and payload value.',
    input_schema: {
        type: 'object',
        properties: {
            endpoint_id_or_slug: { type: 'string' },
            target_id: { type: 'string', description: 'Microscript id.' },
            enabled: { type: 'boolean' },
            event_type: { type: 'string' },
            payload_path: { type: 'string', description: 'Dot path inside payload, e.g. data.object.status.' },
            payload_equals: { type: 'object', description: 'Optional JSON object value the payload path must equal.' },
            payload_equals_json: { type: 'string', description: 'Optional JSON-encoded value the payload path must equal. Use this for strings, numbers, booleans, null, arrays, or objects.' },
        },
        required: ['endpoint_id_or_slug', 'target_id'],
        additionalProperties: false,
    },
    tags: ['webhooks', 'microscripts', 'write'],
}

export function executeWebhookSubscriptionCreate(args: Record<string, unknown>): ToolResult {
    const unknown = rejectUnknownArgs('webhook_subscription_create', args, [
        'endpoint_id_or_slug',
        'target_id',
        'enabled',
        'event_type',
        'payload_path',
        'payload_equals',
        'payload_equals_json',
    ])
    if (unknown) return unknown

    try {
        const endpointRef = requiredString(args.endpoint_id_or_slug, 'endpoint_id_or_slug')
        const endpoint = getWebhookEndpointByIdOrSlug(endpointRef)
        if (!endpoint) return { success: false, error: `No webhook endpoint found for ${endpointRef}.` }
        const payloadEquals = payloadEqualsFromArgs(args)
        const subscription = createWebhookSubscription({
            endpointId: endpoint.id,
            targetKind: 'microscript',
            targetId: requiredString(args.target_id, 'target_id'),
            enabled: optionalBoolean(args.enabled) ?? true,
            eventType: optionalNullableString(args.event_type),
            payloadPath: optionalNullableString(args.payload_path),
            ...(payloadEquals.supplied ? { payloadEquals: payloadEquals.value } : {}),
        })
        return {
            success: true,
            data: {
                endpoint: toPublicWebhookEndpoint(endpoint),
                subscription,
                subscriptions: listWebhookSubscriptions(endpoint.id),
            },
        }
    } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : 'Failed to create webhook subscription.' }
    }
}

export const webhookTools: ToolDef[] = [
    webhookDescribeCapabilitiesTool,
    webhookListTool,
    webhookCreateTool,
    webhookUpdateTool,
    webhookDeleteTool,
    webhookSubscriptionCreateTool,
]

function rejectUnknownArgs(toolId: string, args: Record<string, unknown>, allowed: string[]): ToolResult | null {
    const unknown = Object.keys(args).filter((key) => !allowed.includes(key))
    return unknown.length > 0
        ? { success: false, error: `${toolId} received unknown field(s): ${unknown.join(', ')}.` }
        : null
}

function requiredString(value: unknown, field: string): string {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required.`)
    return value.trim()
}

function optionalString(value: unknown): string | undefined {
    if (value === undefined) return undefined
    if (typeof value !== 'string') throw new Error('Expected a string field.')
    const clean = value.trim()
    return clean || undefined
}

function optionalNullableString(value: unknown): string | null | undefined {
    if (value === undefined) return undefined
    if (value === null) return null
    if (typeof value !== 'string') throw new Error('Expected a string field.')
    const clean = value.trim()
    return clean || null
}

function optionalBoolean(value: unknown): boolean | undefined {
    if (value === undefined) return undefined
    if (typeof value !== 'boolean') throw new Error('Expected a boolean field.')
    return value
}

function optionalNumber(value: unknown): number | undefined {
    if (value === undefined) return undefined
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Expected a finite number field.')
    return value
}

function optionalAuthMode(value: unknown): typeof AUTH_MODES[number] | undefined {
    if (value === undefined) return undefined
    const parsed = WebhookAuthModeSchema.safeParse(value)
    if (!parsed.success) throw new Error(`auth_mode must be one of: ${AUTH_MODES.join(', ')}.`)
    return parsed.data
}

function payloadEqualsFromArgs(args: Record<string, unknown>): { supplied: boolean; value?: unknown } {
    const hasRaw = args.payload_equals !== undefined
    const hasJson = args.payload_equals_json !== undefined
    if (hasRaw && hasJson) throw new Error('Use payload_equals or payload_equals_json, not both.')
    if (hasRaw) return { supplied: true, value: args.payload_equals }
    if (!hasJson) return { supplied: false }
    const raw = requiredString(args.payload_equals_json, 'payload_equals_json')
    try {
        return { supplied: true, value: JSON.parse(raw) as unknown }
    } catch {
        throw new Error('payload_equals_json must be valid JSON.')
    }
}

function ingressUrl(ctx: ToolExecutionContext | undefined, slug: string): string {
    const origin = ctx?.appOrigin?.replace(/\/+$/, '')
    return origin ? `${origin}/api/webhooks/${slug}` : `/api/webhooks/${slug}`
}
