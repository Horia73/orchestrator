import fs from 'fs'
import os from 'os'
import path from 'path'

let failures = 0
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestrator-wa-provider-'))
process.env.ORCHESTRATOR_STATE_DIR = stateDir

const {
    getWhatsAppIntegrationStatus,
    startWhatsApp,
} = await import('@/lib/integrations/whatsapp')
const { BaileysWhatsAppManager } = await import('@/lib/integrations/whatsapp-baileys')
const { whatsappSourceAdapter } = await import('@/lib/monitor/sources/whatsapp')
const { runWithProfileContext } = await import('@/lib/profiles/context')
const { emitAppEvent } = await import('@/lib/events')
const { snapshotFromStatuses, recordIntegrationStatuses } = await import('@/lib/integrations/status-snapshot')
const { activateIntegrations } = await import('@/lib/integrations/activation-store')
const { buildIntegrationsContextBlock, filterIntegrationToolExposure } = await import('@/lib/integrations/exposure')
const { whatsappListChatsTool } = await import('@/lib/ai/tools/whatsapp')
const { whatsAppStatus, whatsAppSummary } = await import('@/components/settings/auth-tab-helpers')

interface SmokeMessageKey {
    remoteJid: string
    id: string
    fromMe?: boolean
    participant?: string
}

interface SmokeMessage {
    key: SmokeMessageKey
    messageTimestamp: number
    message: { conversation: string }
}

interface SmokeBaileysHarness {
    getStatus(): Promise<{ needsReconnect: boolean; sessionStored: boolean }>
    state: { phase: string; lastError: string | null }
    socket: {
        readMessages?(keys: SmokeMessageKey[]): Promise<void>
        chatModify?(mod: unknown, jid: string): Promise<void>
    } | null
    prepareInteractiveAuthStart(): void
    upsertMessage(message: SmokeMessage, options?: { countUnread?: boolean }): void
    ensureChatForJid(jid: string): unknown
    listChats(maxResults: number): Promise<{ chats: Array<{ lastMessage: { id: string } | null }> }>
    unreadSummary(maxResults: number): Promise<{ totalUnread: number }>
    markChatRead(chatId: string): Promise<{ previousUnreadCount: number }>
    markChatUnread(chatId: string): Promise<{ previousUnreadCount: number }>
}

function check(name: string, condition: boolean) {
    if (!condition) {
        failures += 1
        console.error(`FAIL ${name}`)
        return
    }
    console.log(`ok ${name}`)
}

function resetManagers() {
    delete (globalThis as typeof globalThis & {
        __orchestratorWhatsAppManagers?: unknown
    }).__orchestratorWhatsAppManagers
}

function smokeMessage(chatId: string, id: string, timestamp: number): SmokeMessage {
    return {
        key: { remoteJid: chatId, id, fromMe: false },
        messageTimestamp: timestamp,
        message: { conversation: id },
    }
}

process.env.WHATSAPP_PROVIDER = 'baileys'
resetManagers()
const fakeManager = (phoneNumber: string) => ({
    async getStatus() {
        return {
            id: 'whatsapp',
            name: 'WhatsApp',
            description: 'fake',
            provider: 'baileys',
            configured: true,
            connected: false,
            accountName: null,
            phoneNumber,
            phase: 'idle',
            sessionStored: false,
            qrAvailable: false,
            qrDataUrl: null,
            qrImageUrl: null,
            qrUpdatedAt: null,
            qrExpiresAt: null,
            lastReadyAt: null,
            lastSyncAt: null,
            lastError: null,
            browserExecutablePath: null,
            missingConfig: [],
            needsReconnect: true,
            capabilities: ['status'],
        }
    },
})
;(globalThis as unknown as { __orchestratorWhatsAppManagers?: Record<string, unknown> }).__orchestratorWhatsAppManagers = {
    'admin_horia:baileys': fakeManager('+40000000001'),
    'member_one:baileys': fakeManager('+40000000002'),
}
const adminProfileStatus = await runWithProfileContext(
    { profileId: 'admin_horia', role: 'admin' },
    () => getWhatsAppIntegrationStatus()
)
const memberProfileStatus = await runWithProfileContext(
    { profileId: 'member_one', role: 'member' },
    () => getWhatsAppIntegrationStatus()
)
check('whatsapp manager cache is profile-scoped', adminProfileStatus.phoneNumber === '+40000000001' && memberProfileStatus.phoneNumber === '+40000000002')

process.env.WHATSAPP_PROVIDER = 'disabled'
resetManagers()
let stoppedStaleRuntime = 0
;(globalThis as unknown as { __orchestratorWhatsAppManagers?: Record<string, unknown> }).__orchestratorWhatsAppManagers = {
    'admin_horia:baileys': {
        async stopRuntime() {
            stoppedStaleRuntime += 1
        },
    },
}
const disabled = await getWhatsAppIntegrationStatus()
check('disabled provider reports disabled', disabled.provider === 'disabled')
check('disabled provider is disconnected', disabled.connected === false)
check('disabled provider exposes status only', disabled.capabilities.length === 1 && disabled.capabilities[0] === 'status')
check('settings marks disabled provider disabled', whatsAppStatus(disabled).status === 'Disabled')
check('settings summarizes disabled provider disabled', whatsAppSummary(disabled) === 'Disabled')
check('status snapshot marks disabled provider disabled', snapshotFromStatuses({ whatsapp: disabled }).whatsapp.state === 'disabled')
recordIntegrationStatuses({ whatsapp: disabled })
activateIntegrations('wa-disabled-smoke', ['whatsapp'])
const disabledContext = buildIntegrationsContextBlock(['WhatsAppListChats'], { conversationId: 'wa-disabled-smoke' })
check('integrations block does not report disabled WhatsApp tools loaded', disabledContext.includes('State: disabled. Tools: unavailable while disabled.'))
const disabledTools = filterIntegrationToolExposure([whatsappListChatsTool], { conversationId: 'wa-disabled-smoke' })
check('tool exposure drops disabled WhatsApp operational tools', disabledTools.length === 0)
check('disabled provider stops stale active runtime', stoppedStaleRuntime === 1)

let disabledStartFailed = false
try {
    await startWhatsApp()
} catch {
    disabledStartFailed = true
}
check('disabled provider refuses start', disabledStartFailed)

process.env.WHATSAPP_PROVIDER = 'baileys'
resetManagers()
let stoppedByEnvEvent = 0
;(globalThis as unknown as { __orchestratorWhatsAppManagers?: Record<string, unknown> }).__orchestratorWhatsAppManagers = {
    'admin_horia:baileys': {
        ...fakeManager('+40000000003'),
        async stopRuntime() {
            stoppedByEnvEvent += 1
        },
    },
}
await runWithProfileContext(
    { profileId: 'admin_horia', role: 'admin' },
    () => getWhatsAppIntegrationStatus()
)
process.env.WHATSAPP_PROVIDER = 'disabled'
emitAppEvent({ type: 'settings.changed', reason: 'env', profileId: 'admin_horia' })
check('env-change kill switch stops stale active runtime', stoppedByEnvEvent === 1)

process.env.WHATSAPP_PROVIDER = 'baileys'
resetManagers()
const baileys = await getWhatsAppIntegrationStatus()
check('baileys provider is default-selectable', baileys.provider === 'baileys')
check('baileys isolated state has no stored session', baileys.sessionStored === false)
check('baileys passive status does not connect', baileys.connected === false && baileys.qrAvailable === false)
check('baileys does not require browser executable', baileys.configured === true && baileys.browserExecutablePath === null)

const authDir = path.join(stateDir, 'private', 'whatsapp-baileys')
fs.mkdirSync(authDir, { recursive: true })
fs.writeFileSync(path.join(authDir, 'creds.json'), '{}')
const partialBaileys = await getWhatsAppIntegrationStatus()
check('baileys detects partial local creds', partialBaileys.sessionStored === true)
check('baileys partial creds need reconnect', partialBaileys.needsReconnect === true)
const partialAvailability = await whatsappSourceAdapter.isAvailable()
check('monitor rejects partial baileys creds', partialAvailability.available === false)
check('settings marks partial baileys creds reconnect', whatsAppStatus(partialBaileys).status === 'Reconnect')
check('settings summarizes partial baileys creds reconnect', whatsAppSummary(partialBaileys) === 'Local session needs reconnect')

const recoveryHarness = new BaileysWhatsAppManager() as unknown as SmokeBaileysHarness
recoveryHarness.prepareInteractiveAuthStart()
check('baileys connect cleanup removes partial creds before QR login', !fs.existsSync(path.join(authDir, 'creds.json')))
const cleanedPartialStatus = await recoveryHarness.getStatus()
check('baileys connect cleanup clears stored partial session', cleanedPartialStatus.sessionStored === false && cleanedPartialStatus.needsReconnect === true)

fs.mkdirSync(authDir, { recursive: true })
fs.writeFileSync(path.join(authDir, 'creds.json'), JSON.stringify({ me: { id: '40123456789@s.whatsapp.net' } }))
const storedBaileys = await getWhatsAppIntegrationStatus()
check('baileys detects stored session passively', storedBaileys.sessionStored === true)
check('baileys stored session is resumable', storedBaileys.needsReconnect === false)
check('settings marks resumable baileys session saved', whatsAppStatus(storedBaileys).status === 'Saved')
check('status snapshot marks stored baileys session resumable', snapshotFromStatuses({ whatsapp: storedBaileys }).whatsapp.state === 'resumable')
recordIntegrationStatuses({ whatsapp: storedBaileys })
activateIntegrations('wa-resumable-smoke', ['whatsapp'])
const resumableContext = buildIntegrationsContextBlock(['WhatsAppListChats'], { conversationId: 'wa-resumable-smoke' })
check('integrations block reports stored WhatsApp session resumable', resumableContext.includes('State: saved session, resumes on use'))
const resumableTools = filterIntegrationToolExposure([whatsappListChatsTool], { conversationId: 'wa-resumable-smoke' })
check('tool exposure allows resumable WhatsApp operational tools', resumableTools.length === 1)
const waAvailability = await whatsappSourceAdapter.isAvailable()
check('monitor treats stored baileys session as available', waAvailability.available === true)

const authFailureRecoveryHarness = new BaileysWhatsAppManager() as unknown as SmokeBaileysHarness
authFailureRecoveryHarness.state.phase = 'auth_failure'
authFailureRecoveryHarness.state.lastError = 'synthetic auth rejection'
authFailureRecoveryHarness.prepareInteractiveAuthStart()
check('baileys reconnect cleanup removes auth-failed creds before fresh QR', !fs.existsSync(path.join(authDir, 'creds.json')))
fs.mkdirSync(authDir, { recursive: true })
fs.writeFileSync(path.join(authDir, 'creds.json'), JSON.stringify({ me: { id: '40123456789@s.whatsapp.net' } }))

const harness = new BaileysWhatsAppManager() as unknown as SmokeBaileysHarness
const readCalls: SmokeMessageKey[][] = []
const chatModifyCalls: Array<{ mod: unknown; jid: string }> = []
harness.state.phase = 'error'
harness.state.lastError = 'synthetic socket failure'
const erroredStored = await harness.getStatus()
check('baileys stored session in error state needs reconnect', erroredStored.sessionStored === true && erroredStored.needsReconnect === true)
harness.state.phase = 'ready'
harness.state.lastError = null
harness.socket = {
    async readMessages(keys: SmokeMessageKey[]) {
        readCalls.push(keys)
    },
    async chatModify(mod: unknown, jid: string) {
        chatModifyCalls.push({ mod, jid })
    },
}
const chatId = '40123456789@s.whatsapp.net'
harness.upsertMessage(smokeMessage(chatId, 'older-history', 1_700_000_000), { countUnread: false })
const afterHistory = await harness.unreadSummary(10)
check('baileys history append does not increment unread', afterHistory.totalUnread === 0)
harness.upsertMessage(smokeMessage(chatId, 'new-notify', 1_700_000_100), { countUnread: true })
harness.upsertMessage(smokeMessage(chatId, 'second-notify', 1_700_000_200), { countUnread: true })
harness.upsertMessage(smokeMessage(chatId, 'second-notify', 1_700_000_200), { countUnread: true })
const afterNotify = await harness.unreadSummary(10)
check('baileys notify messages increment unread without double-counting duplicates', afterNotify.totalUnread === 2)
harness.upsertMessage(smokeMessage(chatId, 'late-history', 1_700_000_050), { countUnread: false })
const chatList = await harness.listChats(10)
check('baileys older history does not replace last message', chatList.chats[0]?.lastMessage?.id.includes('second-notify') === true)
const markRead = await harness.markChatRead(chatId)
check('baileys mark-read reports previous unread', markRead.previousUnreadCount === 2)
check('baileys mark-read uses newest unread keys', readCalls.length === 1 && readCalls[0]?.[0]?.id === 'second-notify' && readCalls[0]?.[1]?.id === 'new-notify')
const afterMarkRead = await harness.unreadSummary(10)
check('baileys mark-read clears local unread count', afterMarkRead.totalUnread === 0)
const markUnread = await harness.markChatUnread(chatId)
check('baileys mark-unread reports previous unread', markUnread.previousUnreadCount === 0)
check('baileys mark-unread sends chatModify with last message', chatModifyCalls.length === 1 && chatModifyCalls[0]?.jid === chatId)
const afterMarkUnread = await harness.unreadSummary(10)
check('baileys mark-unread restores local unread count', afterMarkUnread.totalUnread === 1)

const noLastHarness = new BaileysWhatsAppManager() as unknown as SmokeBaileysHarness
let noLastModifyCalls = 0
noLastHarness.state.phase = 'ready'
noLastHarness.socket = {
    async chatModify() {
        noLastModifyCalls += 1
    },
}
noLastHarness.ensureChatForJid('40999999999@s.whatsapp.net')
let noLastFailed = false
try {
    await noLastHarness.markChatUnread('40999999999@s.whatsapp.net')
} catch {
    noLastFailed = true
}
check('baileys mark-unread requires a recent message', noLastFailed && noLastModifyCalls === 0)

if (failures > 0) {
    console.error(`\n${failures} WhatsApp provider smoke check(s) failed.`)
    fs.rmSync(stateDir, { recursive: true, force: true })
    process.exit(1)
}

fs.rmSync(stateDir, { recursive: true, force: true })
console.log('\nWhatsApp provider smoke checks passed.')
// Baileys imports may leave defensive reconnect/timer handles alive even
// though this isolated smoke harness never starts a real socket.
process.exit(0)
