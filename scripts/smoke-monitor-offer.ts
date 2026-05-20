/**
 * Smoke test for Step 9 — integration-install offer cards.
 *
 * Mocks integration status snapshots and asserts that:
 *   - newly-connected integration → exactly one offer card posted
 *   - same fingerprint on subsequent calls → idempotent (no duplicate)
 *   - lost offer-state file with existing Inbox card → idempotent (no duplicate)
 *   - disconnected → no offer
 *   - reconnect/new fingerprint while the card still exists → no duplicate
 *   - offer card has the right title + body + 3 reply actions
 *   - inbox conversation is anchored to the Smart Monitor system task
 *
 * Run: npx tsx scripts/smoke-monitor-offer.ts
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { GmailIntegrationStatus } from '@/lib/integrations/gmail'
import type { HomeAssistantIntegrationStatus } from '@/lib/integrations/home-assistant'
import type { WhatsAppIntegrationStatus } from '@/lib/integrations/whatsapp'

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'smart-monitor-offer-smoke-'))
process.chdir(tmpRoot)

async function main(): Promise<void> {
    // Bootstrap the Smart Monitor system task so offers have a taskId to anchor to.
    const { wireSmartMonitor } = await import('@/lib/monitoring/smart-monitor-adapter')
    await wireSmartMonitor()

    const { maybeOfferSmartMonitor, _resetOfferStateForTesting } = await import(
        '@/lib/monitoring/smart-monitor-offer'
    )
    const { listInboxConversations, getInboxConversation } = await import('@/lib/scheduling/store')
    const { listScheduledTasks } = await import('@/lib/scheduling/store')

    let failures = 0
    function check(label: string, cond: unknown, detail?: unknown) {
        const ok = Boolean(cond)
        console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : '  (' + JSON.stringify(detail) + ')'}`)
        if (!ok) failures++
    }

    function gmailStatus(opts: { connected: boolean; email?: string; expiresAt?: number }): GmailIntegrationStatus {
        return {
            id: 'gmail',
            name: 'Gmail',
            description: '',
            configured: true,
            connected: opts.connected,
            accountEmail: opts.email ?? null,
            scopes: [],
            requestedScopes: [],
            missingConfig: [],
            redirectUri: '',
            expiresAt: opts.expiresAt ?? null,
            needsReconnect: false,
        }
    }
    function haStatus(opts: { connected: boolean; baseUrl?: string }): HomeAssistantIntegrationStatus {
        return {
            id: 'homeAssistant',
            name: 'Home Assistant',
            description: '',
            configured: true,
            connected: opts.connected,
            baseUrl: opts.baseUrl ?? null,
            version: '2024.1.0',
            locationName: 'Home',
            timeZone: null,
            unitSystem: null,
            entityCount: null,
            serviceDomainCount: null,
            missingConfig: [],
            needsReconnect: false,
            lastCheckedAt: null,
            capabilities: [],
            actionMode: {
                version: 1,
                enabled: false,
                directDomains: [],
                confirmOtherDomains: true,
                updatedAt: 0,
            },
        }
    }
    function waStatus(opts: { connected: boolean; phoneNumber?: string; lastReadyAt?: number }): WhatsAppIntegrationStatus {
        return {
            id: 'whatsapp',
            name: 'WhatsApp',
            description: '',
            configured: true,
            connected: opts.connected,
            accountName: opts.phoneNumber ?? null,
            phoneNumber: opts.phoneNumber ?? null,
            phase: opts.connected ? 'ready' : 'idle',
            sessionStored: true,
            qrAvailable: false,
            qrDataUrl: null,
            qrImageUrl: null,
            qrUpdatedAt: null,
            qrExpiresAt: null,
            lastReadyAt: opts.lastReadyAt ?? null,
            lastSyncAt: null,
            lastError: null,
            browserExecutablePath: null,
            missingConfig: [],
            needsReconnect: false,
            capabilities: [],
        }
    }

    _resetOfferStateForTesting()

    // System task exists
    const tasks = listScheduledTasks().filter(
        (t) => t.action.kind === 'monitor' && t.action.monitorKind === 'smart',
    )
    check('smart monitor system task created at boot', tasks.length === 1)
    const taskId = tasks[0].id

    // ============================================================================
    // 1. Fresh Gmail connect → 1 offer
    // ============================================================================
    {
        const r = await maybeOfferSmartMonitor({
            gmail: gmailStatus({ connected: true, email: 'me@example.com', expiresAt: 1_700_000_000_000 }),
            homeAssistant: haStatus({ connected: false }),
            whatsapp: waStatus({ connected: false }),
        })
        check('first Gmail connect posts an offer', r.posted.includes('gmail') && r.posted.length === 1)
        check('skipped HA + WA', r.skipped.some((s) => s.includes('home_assistant')) && r.skipped.some((s) => s.includes('whatsapp')))
    }

    // ============================================================================
    // 2. Same fingerprint → idempotent
    // ============================================================================
    {
        const r = await maybeOfferSmartMonitor({
            gmail: gmailStatus({ connected: true, email: 'me@example.com', expiresAt: 1_700_000_000_000 }),
            homeAssistant: haStatus({ connected: false }),
            whatsapp: waStatus({ connected: false }),
        })
        check('second call with same fingerprint posts nothing', r.posted.length === 0)
        check('skipped includes "same fingerprint"', r.skipped.some((s) => s.includes('same fingerprint')))
    }

    // ============================================================================
    // 3. Lost state file / redeploy with existing Inbox card → still no duplicate
    // ============================================================================
    {
        _resetOfferStateForTesting()
        const r = await maybeOfferSmartMonitor({
            gmail: gmailStatus({ connected: true, email: 'me@example.com', expiresAt: 1_700_000_000_000 }),
            homeAssistant: haStatus({ connected: false }),
            whatsapp: waStatus({ connected: false }),
        })
        check('lost state file with existing Gmail card posts nothing', r.posted.length === 0)
        check('skipped includes existing inbox offer', r.skipped.some((s) => s.includes('existing inbox offer')))
        check('still only one Gmail card after lost state', listInboxConversations().filter((i) => i.title.includes('Gmail connected')).length === 1)
    }

    // ============================================================================
    // 4. Disconnect Gmail → still no offer
    // ============================================================================
    {
        const r = await maybeOfferSmartMonitor({
            gmail: gmailStatus({ connected: false }),
            homeAssistant: haStatus({ connected: false }),
            whatsapp: waStatus({ connected: false }),
        })
        check('disconnected Gmail posts no offer', r.posted.length === 0)
    }

    // ============================================================================
    // 5. Reconnect/new fingerprint while Inbox card exists → no duplicate
    // ============================================================================
    {
        const r = await maybeOfferSmartMonitor({
            gmail: gmailStatus({ connected: true, email: 'me@example.com', expiresAt: 1_800_000_000_000 }),
            homeAssistant: haStatus({ connected: false }),
            whatsapp: waStatus({ connected: false }),
        })
        check('reconnect with new fingerprint does not duplicate existing Gmail card', !r.posted.includes('gmail'))
        check('Gmail duplicate skipped by existing inbox offer', r.skipped.some((s) => s.includes('gmail: existing inbox offer')))
    }

    // ============================================================================
    // 6. Fresh HA connect alongside existing Gmail → only HA posted
    // ============================================================================
    {
        const r = await maybeOfferSmartMonitor({
            gmail: gmailStatus({ connected: true, email: 'me@example.com', expiresAt: 1_800_000_000_000 }),
            homeAssistant: haStatus({ connected: true, baseUrl: 'http://homeassistant.local:8123' }),
            whatsapp: waStatus({ connected: false }),
        })
        check('fresh HA posts offer, Gmail does not', r.posted.includes('home_assistant') && !r.posted.includes('gmail'))
    }

    // ============================================================================
    // 7. WhatsApp connects → posts offer
    // ============================================================================
    {
        const r = await maybeOfferSmartMonitor({
            gmail: gmailStatus({ connected: true, email: 'me@example.com', expiresAt: 1_800_000_000_000 }),
            homeAssistant: haStatus({ connected: true, baseUrl: 'http://homeassistant.local:8123' }),
            whatsapp: waStatus({ connected: true, phoneNumber: '+40123', lastReadyAt: 1_700_000_000_000 }),
        })
        check('fresh WA posts offer', r.posted.includes('whatsapp'))
    }

    // ============================================================================
    // 8. Verify Inbox content of the posted cards
    // ============================================================================
    {
        const inbox = listInboxConversations()
        check('three offer conversations created total', inbox.length === 3, { length: inbox.length })

        const gmailCards = inbox.filter((i) => i.title.includes('Gmail connected'))
        const haCards = inbox.filter((i) => i.title.includes('Home Assistant connected'))
        const waCards = inbox.filter((i) => i.title.includes('WhatsApp connected'))
        check('Gmail card titles correct', gmailCards.length === 1)
        check('HA card title correct', haCards.length === 1)
        check('WA card title correct', waCards.length === 1)

        // Check first Gmail card body + actions
        const detail = getInboxConversation(gmailCards[0].id)
        check('Gmail card has 1 assistant message', detail?.messages.length === 1)
        const msg = detail?.messages[0]
        check('Gmail card body mentions VIP senders', (msg?.content ?? '').toLowerCase().includes('senders'))
        check('Gmail card has 3 reply actions', (msg?.replyActions?.length ?? 0) === 3)
        const actionLabels = (msg?.replyActions ?? []).map((a) => a.label)
        check('action labels include set-up-watch', actionLabels.some((l) => l.toLowerCase().includes('set up')))
        check('action labels include show-possibilities', actionLabels.some((l) => l.toLowerCase().includes('what')))
        check('action labels include maybe-later', actionLabels.some((l) => l.toLowerCase().includes('later')))

        // Anchored to Smart Monitor system task
        check('Gmail card is anchored to smart monitor task', gmailCards.every((c) => c.scheduledTaskId === taskId))
    }

    // ============================================================================
    // 9. State persistence: read state file directly
    // ============================================================================
    {
        const statePath = path.join(tmpRoot, '.orchestrator', 'private', 'smart-monitor-offers.json')
        check('offer state file exists on disk', fs.existsSync(statePath))
        const state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
        check('state has gmail fingerprint persisted', typeof state.gmail?.lastOfferedFingerprint === 'string')
        check('state has home_assistant fingerprint persisted', typeof state.home_assistant?.lastOfferedFingerprint === 'string')
        check('state has whatsapp fingerprint persisted', typeof state.whatsapp?.lastOfferedFingerprint === 'string')
    }

    console.log(`\n${failures === 0 ? '✅ ALL OK' : `❌ ${failures} failure(s)`}`)
    process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
    console.error('Unhandled error in smoke test:', err)
    process.exit(2)
})
