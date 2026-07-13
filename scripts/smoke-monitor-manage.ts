/**
 * Smoke test for Step 5: orchestrator watch-management tools.
 *
 * Validates each of the 6 tools end-to-end against the real store:
 *   - monitor_describe_sources: capability snapshot
 *   - monitor_watch_add: happy path, duration-string cadence, source-rule
 *     validation, invalid rule/source rejection
 *   - monitor_watch_list: compact rows, filters
 *   - monitor_watch_get: full detail + recent events
 *   - monitor_watch_update: partial cadence merge, partial notify merge,
 *     allowed_actions replace, rule replace (source-compat enforced), enable
 *     toggle, immutable source (cannot change source field via update)
 *   - monitor_watch_remove: by id; second remove fails cleanly
 *
 * Run: npx tsx scripts/smoke-monitor-manage.ts
 */
import fs from 'fs'
import os from 'os'
import path from 'path'

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'smart-monitor-manage-smoke-'))
process.chdir(tmpRoot)

async function main(): Promise<void> {
    const {
        executeMonitorDescribeSources,
        executeMonitorWatchAdd,
        executeMonitorWatchGet,
        executeMonitorWatchList,
        executeMonitorWatchRemove,
        executeMonitorWatchUpdate,
    } = await import('@/lib/ai/tools/smart-monitor-manage')
    const { getMonitorWatch } = await import('@/lib/monitor/store')
    const { MIN_CADENCE_SECONDS } = await import('@/lib/monitor/schema')

    let failures = 0
    function check(label: string, cond: unknown, detail?: unknown) {
        const ok = Boolean(cond)
        console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : '  (' + JSON.stringify(detail) + ')'}`)
        if (!ok) failures++
    }

    // ============================================================================
    // 1. monitor_describe_sources
    // ============================================================================
    {
        const r = await executeMonitorDescribeSources()
        check('describe_sources succeeds', r.success === true)
        const data = r.data as Record<string, unknown> | undefined
        const sources = data?.sources as Array<{ source: string; supported_rule_kinds: string[]; supported_action_kinds: string[] }>
        check('describe_sources lists 7 sources', sources?.length === 7)
        const gmail = sources?.find((s) => s.source === 'gmail')
        const calendar = sources?.find((s) => s.source === 'google_calendar')
        const weather = sources?.find((s) => s.source === 'weather')
        const custom = sources?.find((s) => s.source === 'custom')
        const whatsapp = sources?.find((s) => s.source === 'whatsapp')
        check('gmail source has rule kinds', (gmail?.supported_rule_kinds.length ?? 0) >= 4)
        check('gmail source advertises any_of/all_of', gmail?.supported_rule_kinds.includes('any_of') && gmail?.supported_rule_kinds.includes('all_of'))
        check('gmail source has notify_inbox + archive actions', gmail?.supported_action_kinds.includes('notify_inbox') && gmail?.supported_action_kinds.includes('gmail_archive'))
        check('gmail source advertises gmail_send action', gmail?.supported_action_kinds.includes('gmail_send') === true)
        check('calendar source has calendar rules', calendar?.supported_rule_kinds.includes('calendar_event_query') === true)
        check('weather source has weather rules', weather?.supported_rule_kinds.includes('weather_temperature') === true)
        check('custom source has custom_prompt', custom?.supported_rule_kinds.includes('custom_prompt') === true)
        check('whatsapp source exposes message metadata predicates',
            whatsapp?.supported_rule_kinds.includes('wa_message_type') === true
                && whatsapp.supported_rule_kinds.includes('wa_has_text')
                && whatsapp.supported_rule_kinds.includes('wa_has_media'),
            whatsapp,
        )
        const bounds = data?.cadence_bounds_seconds as Record<string, number>
        check('cadence bounds present', bounds?.min === MIN_CADENCE_SECONDS && bounds?.max === 12 * 3600)
    }

    // ============================================================================
    // 2. monitor_watch_add — happy path + duration string cadence
    // ============================================================================
    let momWatchId = ''
    {
        const r = await executeMonitorWatchAdd({
            title: 'Mom @ Gmail',
            source: 'gmail',
            target: 'mom@example.com',
            rule: { kind: 'gmail_from', senders: ['mom@example.com'] },
            cadence: { current: '15m', min: '15m', max: '6h', adaptive: true },
            notify: { onMatch: true, quietHours: { from: '23:00', to: '07:00', timezone: 'Europe/Bucharest' } },
        })
        check('watch_add succeeds', r.success === true)
        const data = r.data as Record<string, unknown> | undefined
        momWatchId = (data?.watch_id as string) ?? ''
        check('watch_add returns watch_id', momWatchId.startsWith('mw_'))
        const w = getMonitorWatch(momWatchId)!
        check('cadence.current parsed from "15m" = 900s', w.cadence.current === 900)
        check('cadence.min parsed from "15m" = 900s', w.cadence.min === 900)
        check('cadence.max parsed from "6h" = 21600s', w.cadence.max === 21600)
        check('legacy quiet hours ignored by manage tool', w.notify.quietHours === undefined)
    }

    // ============================================================================
    // 3. monitor_watch_add — validation failures
    // ============================================================================
    {
        const r1 = await executeMonitorWatchAdd({
            title: 'broken',
            source: 'gmail',
            target: 't',
            rule: { kind: 'ha_state_equals', entityId: 'x', state: 'on' },
        })
        check('add rejects HA rule on gmail source', r1.success === false)
        check('error mentions predicate compat', typeof r1.error === 'string' && r1.error.toLowerCase().includes('not supported'))

        const r2 = await executeMonitorWatchAdd({
            title: 'bad source',
            source: 'twitter',
            target: 't',
            rule: { kind: 'gmail_from', senders: ['x@y'] },
        })
        check('add rejects unknown source', r2.success === false)

        const r3 = await executeMonitorWatchAdd({
            title: 'bad cadence',
            source: 'web',
            target: 'https://x.com',
            rule: { kind: 'web_status', url: 'https://x.com', op: 'equals', value: 200 },
            cadence: { current: 'wat' },
        })
        check('add rejects unparseable duration', r3.success === false)
        check('error mentions cadence', typeof r3.error === 'string' && r3.error.toLowerCase().includes('cadence'))

        const r4 = await executeMonitorWatchAdd({
            title: '',
            source: 'gmail',
            target: 't',
            rule: { kind: 'gmail_from', senders: ['x@y'] },
        })
        check('add rejects empty title', r4.success === false)

        const r5 = await executeMonitorWatchAdd({
            title: 'duplicate gmail',
            source: 'gmail',
            target: 'other@example.com',
            rule: { kind: 'gmail_from', senders: ['other@example.com'] },
        })
        check('add rejects second Gmail integration watch', r5.success === false)
        check('duplicate error says update existing watch', typeof r5.error === 'string' && r5.error.includes('Update that watch'))

        // A Gmail-only action cannot be granted on a non-Gmail source.
        const r6 = await executeMonitorWatchAdd({
            title: 'gmail_send on web',
            source: 'web',
            target: 'https://example.com',
            rule: { kind: 'web_status', url: 'https://example.com', op: 'equals', value: 200 },
            allowed_actions: [{ kind: 'gmail_send', mode: 'send', recipients: ['x@example.com'], template: 'hi' }],
        })
        check('add rejects gmail_send on non-gmail source', r6.success === false)
        check('wrong-source action error explains the mismatch', typeof r6.error === 'string' && r6.error.includes('does not support'))
    }

    // ============================================================================
    // 4. monitor_watch_list — compact + filters
    // ============================================================================
    {
        await executeMonitorWatchAdd({
            title: 'Garage door',
            source: 'home_assistant',
            target: 'binary_sensor.garage_door',
            rule: { kind: 'ha_state_equals', entityId: 'binary_sensor.garage_door', state: 'on' },
            cadence: { current: '15m' },
        })

        const all = await executeMonitorWatchList({})
        check('list returns all', all.success === true)
        check('list count includes both watches', (all.data as { count: number }).count === 2)

        const onlyGmail = await executeMonitorWatchList({ source: 'gmail' })
        check('list filter source=gmail', (onlyGmail.data as { count: number }).count === 1)

        const enabled = await executeMonitorWatchList({ enabled: true })
        check('list filter enabled=true', (enabled.data as { count: number }).count === 2)

        const bad = await executeMonitorWatchList({ source: 'bogus' })
        check('list rejects unknown source', bad.success === false)
    }

    // ============================================================================
    // 5. monitor_watch_get — full detail
    // ============================================================================
    {
        const r = await executeMonitorWatchGet({ watch_id: momWatchId })
        check('get succeeds', r.success === true)
        const data = r.data as Record<string, unknown>
        check('get returns id', data.id === momWatchId)
        check('get returns structured rule', typeof data.rule === 'object')
        check('get returns rule_description string', typeof data.rule_description === 'string')
        check('get returns suppress_patterns array', Array.isArray(data.suppress_patterns))
        check('get returns recent_events array', Array.isArray(data.recent_events))

        const notFound = await executeMonitorWatchGet({ watch_id: 'mw_doesnotexist' })
        check('get rejects unknown id', notFound.success === false)

        const empty = await executeMonitorWatchGet({ watch_id: '' })
        check('get rejects empty id', empty.success === false)
    }

    // ============================================================================
    // 6. monitor_watch_update — partial cadence + notify
    // ============================================================================
    {
        // Just bump cadence.current via duration string; everything else preserved.
        const r1 = await executeMonitorWatchUpdate({
            watch_id: momWatchId,
            cadence: { current: '30m' },
        })
        check('update partial cadence succeeds', r1.success === true)
        const w = getMonitorWatch(momWatchId)!
        check('cadence.current updated to 1800s', w.cadence.current === 1800)
        check('cadence.min preserved at 900s', w.cadence.min === 900)
        check('cadence.adaptive preserved at true', w.cadence.adaptive === true)
        check('legacy quiet hours remain unset through cadence update', w.notify.quietHours === undefined)

        // Bump only notify.onMatch; digest/quiet timing is model-owned task state.
        const r2 = await executeMonitorWatchUpdate({
            watch_id: momWatchId,
            notify: { onMatch: false },
        })
        check('update partial notify succeeds', r2.success === true)
        const w2 = getMonitorWatch(momWatchId)!
        check('notify.onMatch flipped to false', w2.notify.onMatch === false)
        check('notify.quietHours remains unset', w2.notify.quietHours === undefined)

        // Rule replace with compatible rule succeeds.
        const r3 = await executeMonitorWatchUpdate({
            watch_id: momWatchId,
            rule: {
                kind: 'any_of', rules: [
                    { kind: 'gmail_from', senders: ['mom@example.com'] },
                    { kind: 'gmail_subject_contains', substrings: ['urgent'] },
                ],
            },
        })
        check('update rule replace (compatible) succeeds', r3.success === true)
        const w3 = getMonitorWatch(momWatchId)!
        check('rule replaced to any_of composition', w3.rule.kind === 'any_of')

        // Rule replace with incompatible rule rejected.
        const r4 = await executeMonitorWatchUpdate({
            watch_id: momWatchId,
            rule: { kind: 'ha_state_changes', entityId: 'x' },
        })
        check('update rule replace with cross-source rejected', r4.success === false)

        // allowed_actions replacement.
        const r5 = await executeMonitorWatchUpdate({
            watch_id: momWatchId,
            allowed_actions: [
                { kind: 'notify_inbox' },
                { kind: 'gmail_archive' },
            ],
        })
        check('update allowed_actions succeeds', r5.success === true)
        const w5 = getMonitorWatch(momWatchId)!
        check('allowed_actions list has 2 entries', w5.allowedActions.length === 2)
        check('allowed_actions includes gmail_archive', w5.allowedActions.some((a) => a.kind === 'gmail_archive'))

        // gmail_send (need #2): the structured send/forward grant is accepted on
        // a Gmail watch, and schema defaults (mode/includeAttachments) apply.
        const r5b = await executeMonitorWatchUpdate({
            watch_id: momWatchId,
            allowed_actions: [
                { kind: 'notify_inbox' },
                { kind: 'gmail_send', recipients: ['accountant@example.com'], template: 'Forwarding this receipt.', senderScope: ['@anthropic.com'] },
            ],
        })
        check('update accepts gmail_send on gmail watch', r5b.success === true, r5b.error)
        const sendAction = getMonitorWatch(momWatchId)!.allowedActions.find((a) => a.kind === 'gmail_send') as
            | { kind: 'gmail_send'; mode: string; includeAttachments: boolean; recipients: string[] }
            | undefined
        check('gmail_send persisted with defaults applied', sendAction?.mode === 'forward' && sendAction?.includeAttachments === true && sendAction?.recipients[0] === 'accountant@example.com')

        // Wrong-source action: a WhatsApp reply cannot land on a Gmail watch.
        const r5c = await executeMonitorWatchUpdate({
            watch_id: momWatchId,
            allowed_actions: [{ kind: 'wa_send_reply', template: 'hi' }],
        })
        check('update rejects wa_send_reply on gmail watch', r5c.success === false && typeof r5c.error === 'string' && r5c.error.includes('does not support'))
        check('rejected update left gmail_send grant intact', getMonitorWatch(momWatchId)!.allowedActions.some((a) => a.kind === 'gmail_send'))

        // Enabled toggle.
        const r6 = await executeMonitorWatchUpdate({ watch_id: momWatchId, enabled: false })
        check('disable via update succeeds', r6.success === true)
        check('watch is disabled', getMonitorWatch(momWatchId)!.enabled === false)
        await executeMonitorWatchUpdate({ watch_id: momWatchId, enabled: true })

        // Empty patch rejected.
        const r7 = await executeMonitorWatchUpdate({ watch_id: momWatchId })
        check('empty patch rejected', r7.success === false)

        // Unknown watch.
        const r8 = await executeMonitorWatchUpdate({ watch_id: 'mw_doesnotexist', enabled: true })
        check('update unknown watch fails cleanly', r8.success === false)
    }

    // ============================================================================
    // 7. monitor_watch_add — closed-loop follow_up
    // ============================================================================
    {
        // Duration deadline, coexists with the main Gmail watch (momWatchId).
        const r1 = await executeMonitorWatchAdd({
            title: 'Reply from Dan',
            source: 'gmail',
            target: 'dan@example.com',
            rule: { kind: 'gmail_from', senders: ['dan@example.com'] },
            follow_up: { expectation: 'a reply from Dan about the Q3 offer', deadline: '2d' },
        })
        check('follow-up add succeeds alongside main gmail watch', r1.success === true, r1.error)
        const fuData = r1.data as { watch_id: string; watch: Record<string, unknown> } | undefined
        const fuId = fuData?.watch_id ?? ''
        const fuRow = fuData?.watch?.follow_up as Record<string, unknown> | null | undefined
        check('compact row exposes follow_up', fuRow?.status === 'waiting' && typeof fuRow?.deadline_at === 'string')
        const fuWatch = getMonitorWatch(fuId)
        check('duration deadline ≈ now+2d', Math.abs((fuWatch?.followUp?.deadlineAt ?? 0) - (Date.now() + 2 * 86_400_000)) < 60_000)
        check('on_deadline defaults to escalate', fuWatch?.followUp?.onDeadline === 'escalate')
        check('follow-up default cadence ceiling tightened to 1h', fuWatch?.cadence.max === 3600)
        await executeMonitorWatchRemove({ watch_id: fuId })

        // ISO deadline form.
        const iso = new Date(Date.now() + 36 * 3_600_000).toISOString()
        const r2 = await executeMonitorWatchAdd({
            title: 'RSVP check',
            source: 'gmail',
            target: 'eve@example.com',
            rule: { kind: 'gmail_from', senders: ['eve@example.com'] },
            follow_up: { expectation: 'an RSVP from Eve', deadline: iso, on_deadline: 'silent' },
        })
        check('ISO deadline accepted', r2.success === true, r2.error)
        const r2Id = (r2.data as { watch_id: string } | undefined)?.watch_id ?? ''
        check('on_deadline silent honored', getMonitorWatch(r2Id)?.followUp?.onDeadline === 'silent')
        await executeMonitorWatchRemove({ watch_id: r2Id })

        // Rejections: missing expectation, bad/past deadline.
        const bad1 = await executeMonitorWatchAdd({
            title: 'x', source: 'gmail', target: 't',
            rule: { kind: 'gmail_from', senders: ['x@y'] },
            follow_up: { deadline: '2d' },
        })
        check('follow_up without expectation rejected', bad1.success === false)
        const bad2 = await executeMonitorWatchAdd({
            title: 'x', source: 'gmail', target: 't',
            rule: { kind: 'gmail_from', senders: ['x@y'] },
            follow_up: { expectation: 'e', deadline: 'soonish' },
        })
        check('unparseable deadline rejected', bad2.success === false && typeof bad2.error === 'string' && bad2.error.includes('deadline'))
        const bad3 = await executeMonitorWatchAdd({
            title: 'x', source: 'gmail', target: 't',
            rule: { kind: 'gmail_from', senders: ['x@y'] },
            follow_up: { expectation: 'e', deadline: new Date(Date.now() - 60_000).toISOString() },
        })
        check('past deadline rejected', bad3.success === false)
    }

    // ============================================================================
    // 8. monitor_watch_remove
    // ============================================================================
    {
        const r1 = await executeMonitorWatchRemove({ watch_id: momWatchId })
        check('remove succeeds', r1.success === true)
        check('watch is gone', getMonitorWatch(momWatchId) === null)
        const r2 = await executeMonitorWatchRemove({ watch_id: momWatchId })
        check('second remove fails', r2.success === false)
        const r3 = await executeMonitorWatchRemove({ watch_id: '' })
        check('remove empty id fails', r3.success === false)
    }

    console.log(`\n${failures === 0 ? '✅ ALL OK' : `❌ ${failures} failure(s)`}`)
    process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
    console.error('Unhandled error in smoke test:', err)
    process.exit(2)
})
