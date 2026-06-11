import { WHATSAPP_TOOL_IDS } from '@/lib/ai/agents/builtins'
import { getToolExecutor } from '@/lib/ai/tools/executors/registry'
import {
    executeWhatsAppFindMessages,
    whatsappFindMessagesTool,
    whatsappTools,
} from '@/lib/ai/tools/whatsapp'
import { INTEGRATION_MANIFEST } from '@/lib/integrations/manifest'

let failures = 0

function check(name: string, condition: unknown, details?: unknown) {
    if (condition) {
        console.log(`ok - ${name}`)
        return
    }
    failures += 1
    console.error(`not ok - ${name}`)
    if (details !== undefined) console.error(details)
}

const schema = whatsappFindMessagesTool.input_schema as {
    required?: string[]
    properties?: Record<string, unknown>
}

check('tool id is stable', whatsappFindMessagesTool.id === 'WhatsAppFindMessages')
check('tool is read-only', whatsappFindMessagesTool.tags.includes('read'))
check('tool is not a write/external/destructive action', !whatsappFindMessagesTool.tags.some(tag => ['write', 'external_action', 'destructive'].includes(tag)))
check('schema requires chat_id', schema.required?.includes('chat_id'))
check('schema exposes date filters', Boolean(schema.properties?.date_from && schema.properties?.date_to && schema.properties?.time_zone))
check('schema exposes media filters', Boolean(schema.properties?.types && schema.properties?.media_only))
check('tool collection includes find before download', whatsappTools.indexOf(whatsappFindMessagesTool) > -1 && whatsappTools.indexOf(whatsappFindMessagesTool) < whatsappTools.findIndex(tool => tool.id === 'WhatsAppDownloadMedia'))
check('builtins expose WhatsAppFindMessages', WHATSAPP_TOOL_IDS.includes('WhatsAppFindMessages'))
check('executor registry exposes WhatsAppFindMessages', typeof getToolExecutor('WhatsAppFindMessages') === 'function')

const whatsappManifest = INTEGRATION_MANIFEST.find(entry => entry.id === 'whatsapp')
check('manifest includes WhatsAppFindMessages operationally', whatsappManifest?.operationalToolIds.includes('WhatsAppFindMessages'))
check('manifest mentions older media lookup', whatsappManifest?.capability.includes('older messages/media'))

const missingChat = await executeWhatsAppFindMessages({ query: 'water' })
check('executor validates chat_id before touching integration', missingChat.success === false && missingChat.error?.includes('chat_id'), missingChat)

const missingFilter = await executeWhatsAppFindMessages({ chat_id: '123456@c.us' })
check('executor requires a narrowing filter before touching integration', missingFilter.success === false && missingFilter.error?.includes('requires at least one filter'), missingFilter)

if (failures > 0) {
    console.error(`\n${failures} WhatsApp find-message smoke check(s) failed.`)
    process.exit(1)
}

console.log('\nWhatsApp find-message smoke checks passed.')
