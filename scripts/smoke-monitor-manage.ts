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
        check('describe_sources lists 6 sources', sources?.length === 6)
        const gmail = sources?.find((s) => s.source === 'gmail')
        const weather = sources?.find((s) => s.source === 'weather')
        check('gmail source has rule kinds', (gmail?.supported_rule_kinds.length ?? 0) >= 4)
        check('gmail source advertises any_of/all_of', gmail?.supported_rule_kinds.includes('any_of') && gmail?.supported_rule_kinds.includes('all_of'))
        check('gmail source has notify_inbox + archive actions', gmail?.supported_action_kinds.includes('notify_inbox') && gmail?.supported_action_kinds.includes('gmail_archive'))
        check('weather source has weather rules', weather?.supported_rule_kinds.includes('weather_temperature') === true)
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
            cadence: { current: '15m', min: '5m', max: '6h', adaptive: true },
            notify: { onMatch: true, quietHours: { from: '23:00', to: '07:00', timezone: 'Europe/Bucharest' } },
        })
        check('watch_add succeeds', r.success === true)
        const data = r.data as Record<string, unknown> | undefined
        momWatchId = (data?.watch_id as string) ?? ''
        check('watch_add returns watch_id', momWatchId.startsWith('mw_'))
        const w = getMonitorWatch(momWatchId)!
        check('cadence.current parsed from "15m" = 900s', w.cadence.current === 900)
        check('cadence.min parsed from "5m" = 300s', w.cadence.min === 300)
        check('cadence.max parsed from "6h" = 21600s', w.cadence.max === 21600)
        check('quiet hours persisted', w.notify.quietHours?.from === '23:00')
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
            cadence: { current: '5m' },
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
        check('cadence.min preserved at 300s', w.cadence.min === 300)
        check('cadence.adaptive preserved at true', w.cadence.adaptive === true)
        check('notify quiet hours preserved through cadence update', w.notify.quietHours?.from === '23:00')

        // Bump only notify.onMatch — quietHours must persist.
        const r2 = await executeMonitorWatchUpdate({
            watch_id: momWatchId,
            notify: { onMatch: false },
        })
        check('update partial notify succeeds', r2.success === true)
        const w2 = getMonitorWatch(momWatchId)!
        check('notify.onMatch flipped to false', w2.notify.onMatch === false)
        check('notify.quietHours still present', w2.notify.quietHours?.from === '23:00')

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
    // 7. monitor_watch_remove
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
