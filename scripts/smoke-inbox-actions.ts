/**
 * Smoke test for Inbox direct-action normalization (notify_inbox → buttons):
 *   - gmail.send_draft accepts draftId/draft_id and rejects a missing id.
 *   - Existing gmail housekeeping actions still require messageId.
 *   - Unknown tools are dropped instead of stored.
 *
 * Run: npx tsx scripts/smoke-inbox-actions.ts
 */
import { normalizeInboxReplyActions } from '@/lib/ai/tools/notify'

let failures = 0

function check(name: string, condition: boolean) {
    if (condition) {
        console.log(`  ok - ${name}`)
    } else {
        failures += 1
        console.error(`  FAIL - ${name}`)
    }
}

function firstAction(input: unknown) {
    return normalizeInboxReplyActions(input)?.[0]
}

console.log('inbox direct-action normalization:')
{
    const sendDraft = firstAction([
        {
            label: 'Send reply',
            value: 'Sent.',
            style: 'primary',
            direct_action: { tool: 'gmail.send_draft', draftId: ' r-123 ' },
        },
    ])
    check(
        'gmail.send_draft accepted with trimmed draftId',
        sendDraft?.directAction?.tool === 'gmail.send_draft' &&
            'draftId' in (sendDraft.directAction ?? {}) &&
            (sendDraft.directAction as { draftId: string }).draftId === 'r-123'
    )

    const snakeCase = firstAction([
        {
            label: 'Send',
            value: 'Sent.',
            direct_action: { tool: 'gmail.send_draft', draft_id: 'r-456' },
        },
    ])
    check(
        'draft_id snake_case alias accepted',
        snakeCase?.directAction?.tool === 'gmail.send_draft' &&
            (snakeCase.directAction as { draftId: string }).draftId === 'r-456'
    )

    const missingId = firstAction([
        {
            label: 'Send',
            value: 'Sent.',
            direct_action: { tool: 'gmail.send_draft' },
        },
    ])
    check(
        'send_draft without draftId falls back to plain reply action',
        missingId !== undefined && missingId.directAction === undefined
    )

    const wrongParam = firstAction([
        {
            label: 'Send',
            value: 'Sent.',
            direct_action: { tool: 'gmail.send_draft', messageId: 'm-1' },
        },
    ])
    check(
        'send_draft ignores messageId (draft-only semantics)',
        wrongParam !== undefined && wrongParam.directAction === undefined
    )

    const archive = firstAction([
        {
            label: 'Archive',
            value: 'Archived.',
            direct_action: { tool: 'gmail.archive', messageId: 'm-9' },
        },
    ])
    check(
        'gmail.archive still requires and keeps messageId',
        archive?.directAction?.tool === 'gmail.archive' &&
            (archive.directAction as { messageId: string }).messageId === 'm-9'
    )

    const unknown = firstAction([
        {
            label: 'Do it',
            value: 'Done.',
            direct_action: { tool: 'gmail.delete_everything', messageId: 'm-1' },
        },
    ])
    check(
        'unknown direct tool dropped, button degrades to reply action',
        unknown !== undefined && unknown.directAction === undefined
    )
}

if (failures > 0) {
    console.error(`\nsmoke:inbox-actions FAILED (${failures} assertion(s))`)
    process.exit(1)
}
console.log('\nsmoke:inbox-actions passed')
