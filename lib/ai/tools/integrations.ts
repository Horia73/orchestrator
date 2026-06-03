import type { ToolDef, ToolExecutionContext, ToolResult } from '@/lib/ai/agents/types'
import {
    ALL_CAPABILITY_IDS,
    describeActivatedIntegration,
    isSubsystemId,
} from '@/lib/integrations/exposure'
import { getIntegrationManifest } from '@/lib/integrations/manifest'
import { getSubsystemManifest } from '@/lib/integrations/subsystem-manifest'
import { refreshIntegrationStatusSnapshot } from '@/lib/integrations/status-snapshot'
import { activateIntegrations } from '@/lib/integrations/activation-store'

// ---------------------------------------------------------------------------
// ActivateIntegrationTools
//
// Tier-1 control tool. Operational integration tool schemas are not loaded by
// default (see lib/integrations/exposure.ts). When an integration is connected
// and the agent needs to operate it, it calls this once; the heavy schemas
// become available from the next step. Connection state must already be good —
// activating a disconnected integration returns guidance instead.
// ---------------------------------------------------------------------------

export const activateIntegrationToolsTool: ToolDef = {
    id: 'ActivateIntegrationTools',
    name: 'ActivateIntegrationTools',
    description:
        'Load a capability for the rest of this conversation — either an integration from <integrations> or a native subsystem from <subsystems>. Activation loads operational tool schemas when that capability has gated tools, plus any doctrine. Use when you are about to operate the capability: an integration whose State is "connected" but whose Tools are "inactive", or a composition/subsystem capability whose Doctrine says "not loaded". Does not connect or configure anything — for integration setup follow the runbook with the setup/lifecycle tools instead.',
    input_schema: {
        type: 'object',
        properties: {
            integrations: {
                type: 'array',
                description: 'Capability ids to activate (from <integrations> or <subsystems>), e.g. ["gmail"], ["maps"], ["watchlist"], ["scheduling"]. Activate only what you are about to use.',
                items: { type: 'string', enum: ALL_CAPABILITY_IDS },
            },
        },
        required: ['integrations'],
    },
    tags: ['integration', 'control'],
}

export const runActivatedIntegrationTool: ToolDef = {
    id: 'RunActivatedIntegrationTool',
    name: 'RunActivatedIntegrationTool',
    description:
        'Runs one operational integration tool that has already been loaded for this conversation with ActivateIntegrationTools. Use this in the same assistant turn when the specific integration tool schema is not directly visible yet. Example for contacts after activating google-workspace: tool_id="GoogleContactsListConnections", arguments={"page_size":25}. Writes still require the target tool’s confirmed_by_user argument after explicit user approval.',
    input_schema: {
        type: 'object',
        properties: {
            tool_id: {
                type: 'string',
                description: 'Exact operational integration tool id to run, for example GoogleContactsListConnections, GmailSearch, or GoogleDriveListFiles.',
            },
            arguments: {
                type: 'object',
                description: 'Arguments for the target tool. Use {} when the target tool has useful defaults.',
            },
        },
        required: ['tool_id', 'arguments'],
    },
    tags: ['integration', 'control'],
}

function parseIds(args: Record<string, unknown>): string[] {
    const raw = args.integrations ?? args.integration
    const list: string[] = []
    if (Array.isArray(raw)) {
        for (const v of raw) if (typeof v === 'string') list.push(v)
    } else if (typeof raw === 'string') {
        for (const part of raw.split(',')) list.push(part)
    }
    return list.map(s => s.trim()).filter(Boolean)
}

export async function executeActivateIntegrationTools(
    args: Record<string, unknown>,
    ctx?: ToolExecutionContext
): Promise<ToolResult> {
    const conversationId = ctx?.conversationId
    if (!conversationId) {
        return { success: false, error: 'No conversation context — cannot activate integration tools.' }
    }

    const ids = parseIds(args)
    if (ids.length === 0) {
        return { success: false, error: 'Provide one or more capability ids in "integrations".' }
    }

    const unknown = ids.filter(id => !ALL_CAPABILITY_IDS.includes(id))
    if (unknown.length > 0) {
        return {
            success: false,
            error: `Unknown capability id(s): ${unknown.join(', ')}. Valid ids: ${ALL_CAPABILITY_IDS.join(', ')}.`,
        }
    }

    // Refresh the snapshot once, lazily — only when a connection-bearing
    // integration is in the list. Subsystems and activationOnly capabilities
    // (maps, weather) have no connection state, so they skip the probe.
    const needsProbe = ids.some(
        (id) => !isSubsystemId(id) && !getIntegrationManifest(id)?.activationOnly
    )
    const snapshot = needsProbe
        ? await refreshIntegrationStatusSnapshot(ctx?.appOrigin)
        : null
    const activatedNow: string[] = []
    const skipped: string[] = []
    const report: string[] = []

    for (const id of ids) {
        if (isSubsystemId(id)) {
            const subsystem = getSubsystemManifest(id)
            if (!subsystem) continue
            activatedNow.push(id)
            report.push(describeActivatedIntegration(id))
            continue
        }

        const entry = getIntegrationManifest(id)
        if (!entry) continue
        // activationOnly capabilities load regardless of connection state —
        // the schemas just become available; a missing key surfaces per-call.
        if (entry.activationOnly) {
            activatedNow.push(id)
            report.push(`${describeActivatedIntegration(id)} If a listed tool schema is not directly visible in this same turn, call RunActivatedIntegrationTool with its tool_id and arguments.`)
            continue
        }
        const state = snapshot?.[entry.statusKind]?.state
        if (state === 'connected') {
            activatedNow.push(id)
            report.push(`${describeActivatedIntegration(id)} If a listed tool schema is not directly visible in this same turn, call RunActivatedIntegrationTool with its tool_id and arguments.`)
        } else {
            skipped.push(id)
            const stateText =
                state === 'needs_reconnect' ? 'needs reconnect'
                : state === 'configured' ? 'configured but not connected'
                : state === 'not_configured' ? 'not configured'
                : 'connection state unknown'
            report.push(
                `${entry.label} was NOT activated — it is ${stateText}. Follow its setup runbook${entry.runbookId ? ` (${entry.runbookId})` : ''} and verify status before using it.`
            )
        }
    }

    if (activatedNow.length > 0) {
        activateIntegrations(conversationId, activatedNow)
    }

    return {
        success: true,
        data: {
            activated: activatedNow,
            skipped,
            message: report.join(' '),
        },
    }
}
