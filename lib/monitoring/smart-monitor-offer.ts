// Smart Monitor integration-install offer cards.
//
// When the user freshly connects Gmail / WhatsApp / Home Assistant, post an
// Inbox card explaining Smart Monitor and offering to set up a watch.
// Idempotent: each integration carries a "fingerprint" of its current
// connection (account id + ready epoch); we persist the last fingerprint we
// offered and only post a new card when it changes (= the user disconnected
// and reconnected, or it's the first install).
//
// The card uses the existing Inbox infrastructure (createInboxConversation +
// replyActions). Clicking a quick reply posts the action's value back as a
// user message in the same Inbox thread; the orchestrator's monitoring
// prompt then takes over.
//
// Called from:
//   - /api/integrations/status (after the UI polls — covers the WA async-
//     connection case without a separate poller),
//   - instrumentation.ts at boot (catches offers that should have fired
//     while the app was down).

import fs from "fs"
import path from "path"
import { randomUUID } from "crypto"

import { PRIVATE_STATE_DIR } from "@/lib/config"
import type { GmailIntegrationStatus } from "@/lib/integrations/gmail"
import type { HomeAssistantIntegrationStatus } from "@/lib/integrations/home-assistant"
import type { WhatsAppIntegrationStatus } from "@/lib/integrations/whatsapp"

const OFFER_STATE_PATH = path.join(PRIVATE_STATE_DIR, "smart-monitor-offers.json")

interface OfferState {
    /** Last fingerprint we offered for this integration, or undefined if
     *  the integration has never been offered. Disconnect + reconnect
     *  produces a new fingerprint → re-offer. */
    [integration: string]: { lastOfferedFingerprint?: string } | undefined
}

function readOfferState(): OfferState {
    try {
        if (!fs.existsSync(OFFER_STATE_PATH)) return {}
        const raw = fs.readFileSync(OFFER_STATE_PATH, "utf8")
        const parsed = JSON.parse(raw)
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
        return parsed as OfferState
    } catch {
        return {}
    }
}

function writeOfferState(state: OfferState): void {
    try {
        fs.mkdirSync(PRIVATE_STATE_DIR, { recursive: true })
        fs.writeFileSync(OFFER_STATE_PATH, JSON.stringify(state, null, 2), "utf8")
    } catch (err) {
        console.warn("[smart-monitor-offer] failed to persist state", err)
    }
}

// ---------------------------------------------------------------------------
// Fingerprints
//
// What counts as a "new connection" worth re-offering for. Disconnect +
// reconnect must always produce a new fingerprint; idle ticks while
// connected must not.
// ---------------------------------------------------------------------------

function gmailFingerprint(status: GmailIntegrationStatus | null): string | null {
    if (!status?.connected) return null
    return `${status.accountEmail ?? "-"}:${status.expiresAt ?? "0"}`
}

function homeAssistantFingerprint(status: HomeAssistantIntegrationStatus | null): string | null {
    if (!status?.connected) return null
    return `${status.baseUrl ?? "-"}:${status.locationName ?? "-"}:${status.version ?? "-"}`
}

function whatsappFingerprint(status: WhatsAppIntegrationStatus | null): string | null {
    if (!status?.connected) return null
    // lastReadyAt updates on every fresh wwebjs "ready" event — exactly the
    // signal we want. Fall back to phoneNumber/accountName when missing.
    return `${status.phoneNumber ?? status.accountName ?? "-"}:${status.lastReadyAt ?? "0"}`
}

// ---------------------------------------------------------------------------
// Card copy per integration
// ---------------------------------------------------------------------------

interface OfferCopy {
    title: string
    body: string
}

const GMAIL_COPY: OfferCopy = {
    title: "Gmail connected — want Smart Monitor?",
    body: [
        "I can watch your inbox in the background and only ping you when something actually matters.",
        "",
        "What I can do (you decide what's worth watching):",
        "- mail from specific senders (Mom, your boss, particular customers)",
        "- subjects containing urgent words (\"urgent\", \"action required\", whatever you tell me)",
        "- anything matching specific Gmail labels or search queries",
        "",
        "Nothing happens until you tell me what to watch. I learn over time which alerts you ignore and quiet them down on my own.",
    ].join("\n"),
}

const HA_COPY: OfferCopy = {
    title: "Home Assistant connected — want Smart Monitor?",
    body: [
        "I can keep an eye on your sensors, devices, and alarms — and only ping you on real state transitions, never on steady state.",
        "",
        "Common watches:",
        "- doors / windows open when they shouldn't be",
        "- temperature crossing a threshold",
        "- smoke / leak / motion alarms",
        "- a device going offline or an attribute changing",
        "",
        "I learn from your feedback which kinds of changes are noise (you'd be surprised how chatty some entities are) and filter them out over time.",
    ].join("\n"),
}

const WHATSAPP_COPY: OfferCopy = {
    title: "WhatsApp connected — want Smart Monitor?",
    body: [
        "I can watch incoming messages and only surface the ones that matter to you.",
        "",
        "Common watches:",
        "- messages from specific contacts (\"tell me when Mom writes\")",
        "- messages mentioning you in a group chat",
        "- messages with urgent words or specific topics",
        "",
        "Outgoing messages (the ones you send) are ignored. I learn which patterns are routine and stop waking you for them.",
    ].join("\n"),
}

const COMMON_ACTIONS = (integration: "Gmail" | "Home Assistant" | "WhatsApp") => [
    {
        id: "set_up_watch",
        label: `Set up a ${integration} watch`,
        value: `Let's set up a Smart Monitor watch for ${integration}. Walk me through what you can monitor and propose a starting setup.`,
        style: "primary" as const,
    },
    {
        id: "show_possibilities",
        label: "Show me what's possible",
        value: `What can Smart Monitor do with ${integration}? Use monitor_describe_sources to enumerate the predicate kinds and give me concrete examples.`,
        style: "secondary" as const,
    },
    {
        id: "maybe_later",
        label: "Maybe later",
        value: `Skip Smart Monitor for ${integration} for now. Don't bring it up again unless I ask.`,
        style: "secondary" as const,
    },
]

interface IntegrationKey {
    id: "gmail" | "home_assistant" | "whatsapp"
    label: "Gmail" | "Home Assistant" | "WhatsApp"
}

const INTEGRATIONS: IntegrationKey[] = [
    { id: "gmail", label: "Gmail" },
    { id: "home_assistant", label: "Home Assistant" },
    { id: "whatsapp", label: "WhatsApp" },
]

function copyFor(id: IntegrationKey["id"]): OfferCopy {
    switch (id) {
        case "gmail":
            return GMAIL_COPY
        case "home_assistant":
            return HA_COPY
        case "whatsapp":
            return WHATSAPP_COPY
    }
}

// ---------------------------------------------------------------------------
// Inbox posting
// ---------------------------------------------------------------------------

/** Look up the Smart Monitor system task id; offers are anchored to it so
 *  Inbox rows are namespaced under "Smart monitor" rather than appearing
 *  taskless (the conversations table requires a non-null scheduledTaskId for
 *  inbox rows, by convention). Returns null if the heartbeat task hasn't
 *  been created yet — in which case we skip the offer (the boot path runs
 *  `wireSmartMonitor()` before this, so this should be rare). */
async function getSmartMonitorTaskId(): Promise<string | null> {
    const { listScheduledTasks } = await import("@/lib/scheduling/store")
    const task = listScheduledTasks().find(
        (t) => t.action.kind === "monitor" && t.action.monitorKind === "smart",
    )
    return task?.id ?? null
}

async function postOfferCard(args: {
    integration: IntegrationKey
    fingerprint: string
}): Promise<void> {
    const taskId = await getSmartMonitorTaskId()
    if (!taskId) {
        console.warn(
            `[smart-monitor-offer] no Smart Monitor system task yet; skipping ${args.integration.id} offer.`,
        )
        return
    }

    const copy = copyFor(args.integration.id)
    const actions = COMMON_ACTIONS(args.integration.label)
    const now = Date.now()

    const { createInboxConversation } = await import("@/lib/scheduling/store")
    const { sendInboxPushNotification } = await import("@/lib/push-notifications")

    const conversationId = createInboxConversation({
        taskId,
        title: copy.title,
        messages: [
            {
                id: `msg_${randomUUID()}`,
                role: "assistant",
                content: copy.body,
                replyActions: actions,
                timestamp: now,
            },
        ],
    })

    // Best-effort push notification — failures don't block the offer.
    void sendInboxPushNotification({
        conversationId,
        title: copy.title,
        body: `${args.integration.label} is connected. Open to set up monitoring.`,
    }).catch(() => {
        /* best-effort */
    })

    console.log(
        `[smart-monitor-offer] posted ${args.integration.id} offer card (fingerprint=${args.fingerprint})`,
    )
}

// ---------------------------------------------------------------------------
// Public entry: check all integrations and post offers for newly-connected ones.
// ---------------------------------------------------------------------------

export interface OfferCheckSnapshot {
    gmail?: GmailIntegrationStatus | null
    homeAssistant?: HomeAssistantIntegrationStatus | null
    whatsapp?: WhatsAppIntegrationStatus | null
}

/**
 * Compare each integration's current connection fingerprint to what we last
 * offered for, and post an Inbox offer card for any integration that has a
 * new fingerprint (= first connection OR reconnect after disconnect).
 *
 * Best-effort: errors are logged, never thrown. Caller should fire-and-forget.
 *
 * Accepts pre-fetched statuses to avoid double-fetching when the caller
 * already has them (e.g., /api/integrations/status). Anything not provided
 * is fetched lazily.
 */
export async function maybeOfferSmartMonitor(
    snapshot: OfferCheckSnapshot = {},
): Promise<{ posted: string[]; skipped: string[] }> {
    const posted: string[] = []
    const skipped: string[] = []

    try {
        // Resolve missing statuses (lazy — boot may not have any prefetched).
        let gmail: GmailIntegrationStatus | null | undefined = snapshot.gmail
        if (gmail === undefined) {
            const [gmailMod, originMod] = await Promise.all([
                import("@/lib/integrations/gmail"),
                import("@/lib/app-origin"),
            ])
            gmail = await gmailMod.getGmailIntegrationStatus(originMod.resolveAppOrigin(), false)
        }
        let homeAssistant: HomeAssistantIntegrationStatus | null | undefined = snapshot.homeAssistant
        if (homeAssistant === undefined) {
            const mod = await import("@/lib/integrations/home-assistant")
            homeAssistant = await mod.getHomeAssistantIntegrationStatus(false)
        }
        let whatsapp: WhatsAppIntegrationStatus | null | undefined = snapshot.whatsapp
        if (whatsapp === undefined) {
            const mod = await import("@/lib/integrations/whatsapp")
            whatsapp = await mod.getWhatsAppIntegrationStatus()
        }

        const fingerprints: Record<IntegrationKey["id"], string | null> = {
            gmail: gmailFingerprint(gmail ?? null),
            home_assistant: homeAssistantFingerprint(homeAssistant ?? null),
            whatsapp: whatsappFingerprint(whatsapp ?? null),
        }

        const state = readOfferState()
        let mutated = false

        for (const integration of INTEGRATIONS) {
            const fp = fingerprints[integration.id]
            const prev = state[integration.id]?.lastOfferedFingerprint
            if (!fp) {
                skipped.push(`${integration.id}: not connected`)
                continue
            }
            if (prev === fp) {
                skipped.push(`${integration.id}: same fingerprint as last offer`)
                continue
            }
            await postOfferCard({ integration, fingerprint: fp })
            state[integration.id] = { lastOfferedFingerprint: fp }
            mutated = true
            posted.push(integration.id)
        }

        if (mutated) writeOfferState(state)
    } catch (err) {
        console.warn("[smart-monitor-offer] check failed", err)
    }

    return { posted, skipped }
}

// ---------------------------------------------------------------------------
// Test/debug helpers
// ---------------------------------------------------------------------------

/** Reset the offer state file (DELETE for testing) so the next call re-offers
 *  for every currently-connected integration. Not exposed via a route. */
export function _resetOfferStateForTesting(): void {
    try {
        if (fs.existsSync(OFFER_STATE_PATH)) fs.unlinkSync(OFFER_STATE_PATH)
    } catch {
        /* ignore */
    }
}
