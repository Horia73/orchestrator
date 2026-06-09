// Smoke test for cross-integration batch support: the runIdBatch primitive,
// the collectIds arg helper, and the plural-id wiring on the per-item tool
// schemas (Gmail / WhatsApp / Calendar / Drive). Pure, deterministic, no network.

import { runIdBatch } from '@/lib/integrations/batch'
import { collectIds } from '@/lib/ai/tools/helpers'
import { gmailArchiveTool, gmailModifyLabelsTool, gmailDeleteTool } from '@/lib/ai/tools/gmail'
import { whatsappMarkChatReadTool, whatsappMarkChatUnreadTool, whatsappDeleteMessageTool } from '@/lib/ai/tools/whatsapp'
import { googleCalendarDeleteEventTool, googleCalendarRespondToEventTool, googleCalendarMoveEventTool } from '@/lib/ai/tools/google-calendar'
import { googleDriveTrashFileTool, googleDriveDeleteFileTool, googleDriveMoveFileTool } from '@/lib/ai/tools/google-drive'
import type { ToolDef } from '@/lib/ai/agents/types'

function check(name: string, condition: boolean, detail?: unknown): void {
    if (!condition) {
        console.error(`FAIL ${name}`, detail ?? '')
        process.exitCode = 1
        return
    }
    console.log(`ok ${name}`)
}

function arraysEqual(a: unknown[], b: unknown[]): boolean {
    return a.length === b.length && a.every((v, i) => v === b[i])
}

function hasArrayProp(tool: ToolDef, prop: string): boolean {
    const schema = tool.input_schema.properties?.[prop]
    return Boolean(schema) && (schema as { type?: string }).type === 'array'
}

function requiredOf(tool: ToolDef): string[] {
    return tool.input_schema.required ?? []
}

async function main(): Promise<void> {
    // --- collectIds ---------------------------------------------------------
    check('collectIds: singular string', arraysEqual(collectIds({ id: 'a' }, ['ids', 'id']), ['a']))
    check('collectIds: array', arraysEqual(collectIds({ ids: ['a', 'b'] }, ['ids', 'id']), ['a', 'b']))
    check('collectIds: array + singular merge', arraysEqual(collectIds({ ids: ['a'], id: 'b' }, ['ids', 'id']), ['a', 'b']))
    check('collectIds: dedupe preserves first-seen order', arraysEqual(collectIds({ ids: ['b', 'a', 'b'], id: 'a' }, ['ids', 'id']), ['b', 'a']))
    check('collectIds: trims and drops blanks', arraysEqual(collectIds({ ids: ['  a  ', '', '   '] }, ['ids']), ['a']))
    check('collectIds: ignores non-strings', arraysEqual(collectIds({ ids: [1, 'a', null, true] as unknown[] }, ['ids']), ['a']))
    check('collectIds: empty when nothing matches', collectIds({ other: 'x' }, ['ids', 'id']).length === 0)

    // --- runIdBatch: all succeed -------------------------------------------
    const ok = await runIdBatch(['a', 'b', 'c'], async id => `done:${id}`)
    check('runIdBatch: batch flag + counts', ok.batch === true && ok.total === 3 && ok.succeeded === 3 && ok.failed === 0)
    check('runIdBatch: order + data preserved', arraysEqual(ok.items.map(i => i.data), ['done:a', 'done:b', 'done:c']))
    check('runIdBatch: ids preserved', arraysEqual(ok.items.map(i => i.id), ['a', 'b', 'c']))

    // --- runIdBatch: partial failure does not reject the whole batch -------
    const mixed = await runIdBatch(['good', 'bad', 'good2'], async id => {
        if (id === 'bad') throw new Error('boom')
        return id
    })
    check('runIdBatch: partial counts', mixed.total === 3 && mixed.succeeded === 2 && mixed.failed === 1)
    const badItem = mixed.items.find(i => i.id === 'bad')
    check('runIdBatch: failed item carries error, no data', badItem?.ok === false && badItem?.error === 'boom' && badItem?.data === undefined)
    check('runIdBatch: failure keeps positional order', mixed.items[1].id === 'bad' && mixed.items[1].ok === false)

    // --- runIdBatch: empty input -------------------------------------------
    const empty = await runIdBatch([], async id => id)
    check('runIdBatch: empty input', empty.total === 0 && empty.succeeded === 0 && empty.failed === 0 && empty.items.length === 0)

    // --- runIdBatch: concurrency is bounded --------------------------------
    let inFlight = 0
    let maxInFlight = 0
    await runIdBatch(['1', '2', '3', '4', '5', '6'], async id => {
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise<void>(resolve => setTimeout(resolve, 5))
        inFlight--
        return id
    }, { concurrency: 2 })
    check('runIdBatch: respects concurrency cap', maxInFlight === 2, { maxInFlight })

    // --- tool schema wiring: plural id field present ------------------------
    check('Gmail archive exposes ids[]', hasArrayProp(gmailArchiveTool, 'ids'))
    check('Gmail modify-labels exposes ids[]', hasArrayProp(gmailModifyLabelsTool, 'ids'))
    check('Gmail delete exposes ids[]', hasArrayProp(gmailDeleteTool, 'ids'))
    check('WhatsApp mark-read exposes chat_ids[]', hasArrayProp(whatsappMarkChatReadTool, 'chat_ids'))
    check('WhatsApp mark-unread exposes chat_ids[]', hasArrayProp(whatsappMarkChatUnreadTool, 'chat_ids'))
    check('WhatsApp delete exposes message_ids[]', hasArrayProp(whatsappDeleteMessageTool, 'message_ids'))
    check('Calendar delete exposes event_ids[]', hasArrayProp(googleCalendarDeleteEventTool, 'event_ids'))
    check('Calendar respond exposes event_ids[]', hasArrayProp(googleCalendarRespondToEventTool, 'event_ids'))
    check('Calendar move exposes event_ids[]', hasArrayProp(googleCalendarMoveEventTool, 'event_ids'))
    check('Drive trash exposes file_ids[]', hasArrayProp(googleDriveTrashFileTool, 'file_ids'))
    check('Drive delete exposes file_ids[]', hasArrayProp(googleDriveDeleteFileTool, 'file_ids'))
    check('Drive move exposes file_ids[]', hasArrayProp(googleDriveMoveFileTool, 'file_ids'))

    // --- tool schema wiring: singular id no longer forced ------------------
    // The singular id must be optional now (one OR many), so it is dropped from
    // `required` and validated in the executor instead. Confirmation/required
    // gates that are NOT the id must stay.
    check('Gmail archive: id not required', !requiredOf(gmailArchiveTool).includes('id'))
    check('Gmail delete: keeps confirm_permanent_delete required', requiredOf(gmailDeleteTool).includes('confirm_permanent_delete'))
    check('WhatsApp delete: keeps confirmed_by_user required', requiredOf(whatsappDeleteMessageTool).includes('confirmed_by_user'))
    check('Calendar delete: keeps confirmed_by_user required, drops event_id', requiredOf(googleCalendarDeleteEventTool).includes('confirmed_by_user') && !requiredOf(googleCalendarDeleteEventTool).includes('event_id'))
    check('Calendar move: keeps destination required', requiredOf(googleCalendarMoveEventTool).includes('destination_calendar_id'))

    if (process.exitCode === 1) {
        console.error('\n✗ smoke-batch-ops failed')
    } else {
        console.log('\n✓ smoke-batch-ops passed')
    }
}

void main()
