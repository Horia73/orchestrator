import { z } from 'zod'

// ---------------------------------------------------------------------------
// Microscripts domain schema.
//
// A microscript is a short Python function plus a manifest. It is not a
// daemon: every run must finish quickly, return state, and choose whether it
// should continue, pause, or complete. Runtime permissions are declared up
// front and enforced by the Node parent process before any integration/file/
// app-mediated operation executes. In trusted_python mode, ordinary Python
// stdlib work is allowed directly while the runtime still controls lifecycle,
// timeout, workspace confinement, notifications, app tools, and audit.
// ---------------------------------------------------------------------------

export const MicroscriptStatusSchema = z.enum([
    'active',
    'running',
    'paused',
    'completed',
    'expired',
    'error',
])
export type MicroscriptStatus = z.infer<typeof MicroscriptStatusSchema>

export const MicroscriptCreatedBySchema = z.enum(['user', 'orchestrator', 'system'])
export type MicroscriptCreatedBy = z.infer<typeof MicroscriptCreatedBySchema>

export const MicroscriptScheduleSchema = z.discriminatedUnion('kind', [
    z.object({
        kind: z.literal('manual'),
    }),
    z.object({
        kind: z.literal('interval'),
        /** Fixed interval between runs. The script may ask for a later next run,
         *  but never earlier than limits.minIntervalMs. */
        everyMs: z.number().int().min(60_000),
        startAt: z.number().int().positive().optional(),
    }),
])
export type MicroscriptSchedule = z.infer<typeof MicroscriptScheduleSchema>

export const MicroscriptRuntimeSchema = z.literal('trusted_python')
export type MicroscriptRuntime = z.infer<typeof MicroscriptRuntimeSchema>

export const MicroscriptTrustedPythonPolicySchema = z.object({
    /** Allow normal Python imports. Dangerous modules are still blocked unless allowShell is true. */
    allowImports: z.boolean().default(true),
    /** Allow direct Python networking such as urllib/http.client/socket. */
    allowNetwork: z.boolean().default(true),
    /** Direct network may reach private/internal hosts when allowNetwork is true. */
    allowPrivateNetwork: z.boolean().default(true),
    /** Allow Python file APIs, confined to the microscript workspace. */
    allowWorkspaceFiles: z.boolean().default(true),
    /** Expose only the sanitized process env. Real app/user secrets are never passed to Python. */
    allowEnvironment: z.boolean().default(false),
    /** Allow subprocess/shell execution. Default stays false for autonomous recurring scripts. */
    allowShell: z.boolean().default(false),
})
export type MicroscriptTrustedPythonPolicy = z.infer<typeof MicroscriptTrustedPythonPolicySchema>

export const MicroscriptLimitsSchema = z.object({
    /** Hard process timeout for one Python phase. */
    timeoutMs: z.number().int().min(500).max(60_000).default(5_000),
    /** Max request/response phases in one run. Prevents request loops. */
    maxPhases: z.number().int().min(1).max(8).default(4),
    /** Shortest allowed delay before the next automatic run. */
    minIntervalMs: z.number().int().min(60_000).max(24 * 60 * 60_000).default(60_000),
    /** Max captured stdout/stderr bytes from the Python process. */
    maxOutputBytes: z.number().int().min(1_000).max(512_000).default(64_000),
    /** Auto-pause after repeated failures. */
    maxConsecutiveFailures: z.number().int().min(1).max(20).default(5),
    /** Optional total run cap. */
    maxRuns: z.number().int().min(1).max(100_000).optional(),
})
export type MicroscriptLimits = z.infer<typeof MicroscriptLimitsSchema>

const EntityIdPattern = z.string().regex(/^[a-z0-9_]+\.[a-z0-9_]+$/i, 'expected Home Assistant entity_id')
const AgentIdPattern = z.string().min(1).max(64).regex(/^[a-z0-9_-]+$/i, 'expected agent id')

const InboxReplyActionSchema = z.object({
    id: z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/).optional(),
    label: z.string().min(1).max(80),
    value: z.string().min(1).max(2_000),
    style: z.enum(['primary', 'secondary', 'destructive']).optional(),
})

export const MicroscriptPermissionSchema = z.discriminatedUnion('kind', [
    z.object({
        kind: z.literal('notify_inbox'),
    }),
    z.object({
        kind: z.literal('agent_wake'),
        /** Agents this script may wake. Defaults to the orchestrator. */
        agentIds: z.array(AgentIdPattern).min(1).max(20).default(['orchestrator']),
        /** Upper bound for each prompt payload passed from Python to the model. */
        maxPromptChars: z.number().int().min(200).max(20_000).default(4_000),
        /** Let the woken agent call notify_inbox. Keep true for "model decides whether to surface" gates. */
        allowNotifyInbox: z.boolean().default(true),
        /**
         * Idle (no-progress) timeout for the model wake, in ms. The woken agent is
         * aborted only after this long with NO activity (no tool call, content, or
         * reasoning) — an agent that keeps making progress runs as long as it needs.
         * It is NOT a total wall-clock cap. 0 disables the timeout entirely.
         */
        timeoutMs: z.number().int().min(0).max(15 * 60_000).default(120_000)
            .refine((v) => v === 0 || v >= 5_000, {
                message: 'timeoutMs must be 0 (disabled) or at least 5000ms',
            }),
        /**
         * Tool surface for the woken agent. 'full' (default) gives the agent its
         * normal gated tool surface — actions stay governed by the action policy
         * and standing user authorizations. 'read-only' restricts the wake to
         * context reads plus notify_inbox for scripts that only ever judge/notify.
         */
        toolSurface: z.enum(['full', 'read-only']).default('full'),
    }),
    z.object({
        kind: z.literal('home_assistant_read'),
        /** Broad read mode for trusted scripts. Allows any entity/list/history permitted by flags. */
        allowAll: z.boolean().default(false),
        /** Exact entities this script may read. Empty/omitted means use domains. */
        entityIds: z.array(EntityIdPattern).max(200).optional(),
        /** Entity domains this script may read/list, e.g. sensor, binary_sensor. */
        domains: z.array(z.string().min(1).max(64).regex(/^[a-z0-9_]+$/i)).max(50).optional(),
        allowList: z.boolean().default(false),
        allowHistory: z.boolean().default(false),
    }),
    z.object({
        kind: z.literal('home_assistant_call_service'),
        /** Broad write mode for trusted scripts. Prefer domains/services unless user explicitly approves this. */
        allowAll: z.boolean().default(false),
        /** Allow any service in these domains. */
        domains: z.array(z.string().min(1).max(64).regex(/^[a-z0-9_]+$/i)).max(50).optional(),
        services: z.array(z.object({
            domain: z.string().min(1).max(64).regex(/^[a-z0-9_]+$/i),
            /** Omit service to allow any service in the domain. Prefer exact service in production scripts. */
            service: z.string().min(1).max(96).regex(/^[a-z0-9_]+$/i).optional(),
            /** Optional target entity boundary. Omit only for service calls that do not target entities. */
            entityIds: z.array(EntityIdPattern).max(200).optional(),
        })).max(50).default([]),
    }),
    z.object({
        kind: z.literal('http_fetch'),
        /** Host allowlist. Supports exact hosts and "*.example.com". */
        allowedHosts: z.array(z.string().min(1).max(253)).min(1).max(100),
        methods: z.array(z.enum(['HEAD', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE'])).min(1).max(6).default(['GET']),
        allowPrivateNetwork: z.boolean().default(false),
        maxBytes: z.number().int().min(1_000).max(2_000_000).default(200_000),
    }),
    z.object({
        kind: z.literal('tool_call'),
        /** Exact app tool ids this script may call through ctx.call_tool/tool.call. */
        toolIds: z.array(z.string().min(1).max(160)).max(200).optional(),
        /** Glob patterns for tool ids, e.g. "HomeAssistant*" or "GoogleCalendarList*". */
        toolPatterns: z.array(z.string().min(1).max(160)).max(50).optional(),
        /** Permit connected integration operational tools without listing every id. */
        allowIntegrationTools: z.boolean().default(true),
        /** Allow tools marked orchestrator-only. Keep false unless the script needs that surface. */
        allowOrchestratorOnly: z.boolean().default(false),
        maxCallsPerRun: z.number().int().min(1).max(100).default(20),
    }),
    z.object({
        kind: z.literal('files'),
        read: z.boolean().default(true),
        write: z.boolean().default(false),
        maxBytes: z.number().int().min(1_000).max(5_000_000).default(500_000),
    }),
])
export type MicroscriptPermission = z.infer<typeof MicroscriptPermissionSchema>

export const MicroscriptStopPolicySchema = z.object({
    /** Default for one-shot alert scripts: after a notification is posted,
     *  mark the script completed unless it explicitly returns status=continue. */
    completeOnNotification: z.boolean().default(false),
    /** If set, the script expires at this absolute epoch ms. */
    expiresAt: z.number().int().positive().nullable().default(null),
    /** Allow truly long-lived scripts. When false and expiresAt is omitted,
     *  creation applies a default 24h expiry. */
    persistent: z.boolean().default(false),
})
export type MicroscriptStopPolicy = z.infer<typeof MicroscriptStopPolicySchema>

export const MicroscriptManifestSchema = z.object({
    description: z.string().min(1).max(2_000),
    runtime: MicroscriptRuntimeSchema.default('trusted_python'),
    trustedPython: MicroscriptTrustedPythonPolicySchema.default({
        allowImports: true,
        allowNetwork: true,
        allowPrivateNetwork: true,
        allowWorkspaceFiles: true,
        allowEnvironment: false,
        allowShell: false,
    }),
    schedule: MicroscriptScheduleSchema.default({ kind: 'manual' }),
    permissions: z.array(MicroscriptPermissionSchema).max(100).default([]),
    limits: MicroscriptLimitsSchema.default({
        timeoutMs: 5_000,
        maxPhases: 4,
        minIntervalMs: 60_000,
        maxOutputBytes: 64_000,
        maxConsecutiveFailures: 5,
    }),
    stop: MicroscriptStopPolicySchema.default({
        completeOnNotification: false,
        expiresAt: null,
        persistent: false,
    }),
})
export type MicroscriptManifest = z.infer<typeof MicroscriptManifestSchema>

export const MicroscriptSchema = z.object({
    id: z.string().min(1),
    title: z.string().min(1).max(200),
    enabled: z.boolean(),
    status: MicroscriptStatusSchema,
    code: z.string().min(1).max(60_000),
    codeHash: z.string().min(1),
    manifest: MicroscriptManifestSchema,
    state: z.record(z.string(), z.unknown()).default({}),
    nextRunAt: z.number().int().positive().nullable(),
    lastRunAt: z.number().int().positive().nullable(),
    lastRunStatus: z.enum(['ok', 'error']).nullable(),
    lastRunError: z.string().nullable(),
    runCount: z.number().int().nonnegative(),
    consecutiveFailures: z.number().int().nonnegative(),
    createdBy: MicroscriptCreatedBySchema,
    createdAt: z.number().int().positive(),
    updatedAt: z.number().int().positive(),
})
export type Microscript = z.infer<typeof MicroscriptSchema>

export const CreateMicroscriptInputSchema = z.object({
    title: z.string().min(1).max(200),
    code: z.string().min(1).max(60_000),
    manifest: MicroscriptManifestSchema,
    enabled: z.boolean().default(true),
    createdBy: MicroscriptCreatedBySchema.default('orchestrator'),
    initialState: z.record(z.string(), z.unknown()).default({}),
})
export type CreateMicroscriptInput = z.input<typeof CreateMicroscriptInputSchema>

export const UpdateMicroscriptInputSchema = z.object({
    title: z.string().min(1).max(200).optional(),
    code: z.string().min(1).max(60_000).optional(),
    manifest: MicroscriptManifestSchema.optional(),
    enabled: z.boolean().optional(),
    state: z.record(z.string(), z.unknown()).optional(),
})
export type UpdateMicroscriptInput = z.infer<typeof UpdateMicroscriptInputSchema>

export const MicroscriptOperationSchema = z.discriminatedUnion('kind', [
    z.object({
        kind: z.literal('notify.inbox'),
        id: z.string().min(1).max(120).optional(),
        title: z.string().min(1).max(160).optional(),
        body: z.string().min(1).max(8_000),
        actions: z.array(InboxReplyActionSchema).max(8).optional(),
    }),
    z.object({
        kind: z.literal('agent.wake'),
        id: z.string().min(1).max(120),
        agent_id: AgentIdPattern.default('orchestrator'),
        prompt: z.string().min(1).max(20_000),
    }),
    z.object({
        kind: z.literal('home_assistant.get_state'),
        id: z.string().min(1).max(120),
        entity_id: EntityIdPattern,
    }),
    z.object({
        kind: z.literal('home_assistant.list_states'),
        id: z.string().min(1).max(120),
        domain: z.string().min(1).max(64).regex(/^[a-z0-9_]+$/i).optional(),
        query: z.string().min(1).max(120).optional(),
        include_attributes: z.boolean().optional(),
        max_results: z.number().int().min(1).max(1_000).optional(),
    }),
    z.object({
        kind: z.literal('home_assistant.history'),
        id: z.string().min(1).max(120),
        entity_ids: z.array(EntityIdPattern).min(1).max(25),
        start_time: z.string().min(1).max(80).optional(),
        end_time: z.string().min(1).max(80).optional(),
        max_state_changes: z.number().int().min(1).max(1_000).optional(),
    }),
    z.object({
        kind: z.literal('home_assistant.call_service'),
        id: z.string().min(1).max(120),
        domain: z.string().min(1).max(64).regex(/^[a-z0-9_]+$/i),
        service: z.string().min(1).max(96).regex(/^[a-z0-9_]+$/i),
        target: z.record(z.string(), z.unknown()).optional(),
        data: z.record(z.string(), z.unknown()).optional(),
        reason: z.string().min(1).max(500).optional(),
        return_response: z.boolean().optional(),
    }),
    z.object({
        kind: z.literal('http.fetch'),
        id: z.string().min(1).max(120),
        url: z.string().url(),
        method: z.enum(['HEAD', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET'),
        headers: z.record(z.string(), z.string()).optional(),
        body: z.string().max(100_000).optional(),
    }),
    z.object({
        kind: z.literal('tool.call'),
        id: z.string().min(1).max(120),
        tool_id: z.string().min(1).max(160),
        arguments: z.record(z.string(), z.unknown()).default({}),
    }),
    z.object({
        kind: z.literal('file.read'),
        id: z.string().min(1).max(120),
        path: z.string().min(1).max(300),
        // Read only the last N bytes of a (typically append-only) file instead
        // of the whole thing. Lets a script tail a growing journal without
        // pulling the entire file through the run each time. When set, the
        // whole-file size cap is skipped and only this slice is returned.
        tail_bytes: z.number().int().positive().max(5_000_000).optional(),
    }),
    z.object({
        kind: z.literal('file.write'),
        id: z.string().min(1).max(120),
        path: z.string().min(1).max(300),
        content: z.string().max(1_000_000),
        append: z.boolean().optional(),
    }),
])
export type MicroscriptOperation = z.infer<typeof MicroscriptOperationSchema>

export const MicroscriptRunResponseSchema = z.object({
    summary: z.string().max(2_000).optional(),
    state: z.record(z.string(), z.unknown()).optional(),
    requests: z.array(MicroscriptOperationSchema).max(25).optional(),
    status: z.enum(['continue', 'pause', 'complete']).optional(),
    reason: z.string().max(1_000).optional(),
    nextRunAt: z.number().int().positive().optional(),
    nextCheckAfterMs: z.number().int().positive().optional(),
})
export type MicroscriptRunResponse = z.infer<typeof MicroscriptRunResponseSchema>

export interface MicroscriptRunRecord {
    id: string
    scriptId: string
    startedAt: number
    endedAt: number
    status: 'ok' | 'error'
    trigger: 'schedule' | 'manual' | 'webhook'
    summary: string
    error: string | null
    phases: number
    operations: number
    surfaced: boolean
    conversationId: string | null
}
