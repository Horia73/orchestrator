import { z } from 'zod'

// ---------------------------------------------------------------------------
// Generic inbound webhook domain schema.
//
// Webhooks are the public-facing ingress. They authenticate, persist, dedupe,
// normalize, and then dispatch events to internal consumers such as
// Microscripts. Consumers should not own request authentication or raw event
// storage; they receive already-validated event context.
// ---------------------------------------------------------------------------

export const WebhookSlugSchema = z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9][a-z0-9_-]*$/i, 'slug must contain only letters, numbers, "_" or "-" and start with a letter/number')
    .transform((value) => value.toLowerCase())
export type WebhookSlug = z.infer<typeof WebhookSlugSchema>

export const WebhookAuthModeSchema = z.enum(['bearer', 'hmac', 'svix', 'none'])
export type WebhookAuthMode = z.infer<typeof WebhookAuthModeSchema>

export const WebhookEventStatusSchema = z.enum(['received', 'processing', 'processed', 'duplicate', 'error'])
export type WebhookEventStatus = z.infer<typeof WebhookEventStatusSchema>

export const WebhookDispatchStatusSchema = z.enum(['queued', 'running', 'ok', 'skipped', 'error'])
export type WebhookDispatchStatus = z.infer<typeof WebhookDispatchStatusSchema>

export const WebhookTargetKindSchema = z.enum(['microscript'])
export type WebhookTargetKind = z.infer<typeof WebhookTargetKindSchema>

export const WebhookEndpointCreateInputSchema = z.object({
    slug: WebhookSlugSchema,
    title: z.string().trim().min(1).max(160),
    description: z.string().trim().max(2_000).optional(),
    source: z.string().trim().min(1).max(120).optional(),
    defaultEventType: z.string().trim().min(1).max(160).optional(),
    enabled: z.boolean().default(true),
    authMode: WebhookAuthModeSchema.default('bearer'),
    secret: z.string().min(16).max(500).optional(),
    generateSecret: z.boolean().default(false),
    hmacToleranceSeconds: z.number().int().min(30).max(24 * 60 * 60).default(300),
    rateLimitPerMinute: z.number().int().min(1).max(10_000).default(120),
    retentionDays: z.number().int().min(1).max(365).default(30),
})
export type WebhookEndpointCreateInput = z.input<typeof WebhookEndpointCreateInputSchema>

export const WebhookEndpointUpdateInputSchema = z.object({
    title: z.string().trim().min(1).max(160).optional(),
    description: z.string().trim().max(2_000).nullable().optional(),
    source: z.string().trim().min(1).max(120).nullable().optional(),
    defaultEventType: z.string().trim().min(1).max(160).nullable().optional(),
    enabled: z.boolean().optional(),
    authMode: WebhookAuthModeSchema.optional(),
    secret: z.string().min(16).max(500).optional(),
    rotateSecret: z.boolean().optional(),
    hmacToleranceSeconds: z.number().int().min(30).max(24 * 60 * 60).optional(),
    rateLimitPerMinute: z.number().int().min(1).max(10_000).optional(),
    retentionDays: z.number().int().min(1).max(365).optional(),
})
export type WebhookEndpointUpdateInput = z.input<typeof WebhookEndpointUpdateInputSchema>

export const WebhookEndpointSchema = z.object({
    id: z.string().min(1),
    slug: WebhookSlugSchema,
    title: z.string().min(1).max(160),
    description: z.string().max(2_000).nullable(),
    source: z.string().min(1).max(120),
    defaultEventType: z.string().min(1).max(160).nullable(),
    enabled: z.boolean(),
    authMode: WebhookAuthModeSchema,
    secret: z.string().nullable(),
    hmacToleranceSeconds: z.number().int().positive(),
    rateLimitPerMinute: z.number().int().positive(),
    retentionDays: z.number().int().positive(),
    createdBy: z.enum(['user', 'orchestrator', 'system']),
    createdAt: z.number().int().positive(),
    updatedAt: z.number().int().positive(),
})
export type WebhookEndpoint = z.infer<typeof WebhookEndpointSchema>

export const WebhookEndpointPublicSchema = WebhookEndpointSchema.omit({ secret: true }).extend({
    secretConfigured: z.boolean(),
    secretPreview: z.string().nullable(),
})
export type WebhookEndpointPublic = z.infer<typeof WebhookEndpointPublicSchema>

export const NormalizedWebhookEventSchema = z.object({
    source: z.string().min(1).max(120),
    eventType: z.string().min(1).max(160),
    subject: z.string().max(500).nullable().default(null),
    actor: z.string().max(500).nullable().default(null),
    occurredAt: z.number().int().positive(),
    summary: z.string().max(2_000),
    metadata: z.record(z.string(), z.unknown()).default({}),
})
export type NormalizedWebhookEvent = z.infer<typeof NormalizedWebhookEventSchema>

export const WebhookEventSchema = z.object({
    id: z.string().min(1),
    endpointId: z.string().min(1),
    slug: WebhookSlugSchema,
    source: z.string().min(1).max(120),
    eventType: z.string().min(1).max(160),
    dedupeKey: z.string().min(1).max(200),
    payload: z.record(z.string(), z.unknown()),
    normalized: NormalizedWebhookEventSchema,
    status: WebhookEventStatusSchema,
    error: z.string().nullable(),
    occurredAt: z.number().int().positive(),
    receivedAt: z.number().int().positive(),
    processedAt: z.number().int().positive().nullable(),
})
export type WebhookEvent = z.infer<typeof WebhookEventSchema>

export const WebhookEventIngestInputSchema = z.object({
    endpointId: z.string().min(1),
    slug: WebhookSlugSchema,
    payload: z.record(z.string(), z.unknown()),
    dedupeKey: z.string().min(1).max(200),
    normalized: NormalizedWebhookEventSchema,
})
export type WebhookEventIngestInput = z.infer<typeof WebhookEventIngestInputSchema>

export const WebhookSubscriptionCreateInputSchema = z.object({
    endpointId: z.string().min(1),
    targetKind: WebhookTargetKindSchema,
    targetId: z.string().min(1).max(160),
    enabled: z.boolean().default(true),
    eventType: z.string().trim().min(1).max(160).nullable().optional(),
    payloadPath: z.string().trim().min(1).max(200).nullable().optional(),
    payloadEquals: z.unknown().optional(),
})
export type WebhookSubscriptionCreateInput = z.input<typeof WebhookSubscriptionCreateInputSchema>

export const WebhookSubscriptionUpdateInputSchema = z.object({
    enabled: z.boolean().optional(),
    eventType: z.string().trim().min(1).max(160).nullable().optional(),
    payloadPath: z.string().trim().min(1).max(200).nullable().optional(),
    payloadEquals: z.unknown().optional(),
})
export type WebhookSubscriptionUpdateInput = z.input<typeof WebhookSubscriptionUpdateInputSchema>

export const WebhookSubscriptionSchema = z.object({
    id: z.string().min(1),
    endpointId: z.string().min(1),
    targetKind: WebhookTargetKindSchema,
    targetId: z.string().min(1).max(160),
    enabled: z.boolean(),
    eventType: z.string().min(1).max(160).nullable(),
    payloadPath: z.string().min(1).max(200).nullable(),
    payloadEquals: z.unknown().nullable(),
    createdAt: z.number().int().positive(),
    updatedAt: z.number().int().positive(),
})
export type WebhookSubscription = z.infer<typeof WebhookSubscriptionSchema>

export const WebhookDispatchSchema = z.object({
    id: z.string().min(1),
    eventId: z.string().min(1),
    subscriptionId: z.string().min(1).nullable(),
    targetKind: WebhookTargetKindSchema,
    targetId: z.string().min(1).max(160),
    status: WebhookDispatchStatusSchema,
    error: z.string().nullable(),
    runSummary: z.string().nullable(),
    conversationId: z.string().nullable(),
    startedAt: z.number().int().positive(),
    endedAt: z.number().int().positive().nullable(),
})
export type WebhookDispatch = z.infer<typeof WebhookDispatchSchema>
