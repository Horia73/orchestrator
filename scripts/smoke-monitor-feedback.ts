/**
 * Smoke test for Smart Monitor wake prompt context + monitor_wake_feedback.
 *
 * No model, no network. Validates:
 *   - model-led wake prompt includes watch id, rule, source strategy, and
 *     the lightest-runtime guidance;
 *   - executeMonitorWakeFeedback records feedback, optionally adds/removes
 *     suppress patterns, and validates source-compatible rules;
 *   - active suppress patterns and feedback history are injected into the
 *     next Smart Monitor prompt.
 *
 * Run: npx tsx scripts/smoke-monitor-feedback.ts
 */
import fs from 'fs'
import os from 'os'
import path from 'path'

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'smart-monitor-feedback-smoke-'))
process.chdir(tmpRoot)

async function main(): Promise<void> {
    const {
        createMonitorWatch,
        getMonitorWatch,
        listWatchEvents,
        recordWatchEvent,
    } = await import('@/lib/monitor/store')
    const { buildSmartMonitorAgentPrompt } = await import('@/lib/monitoring/smart-monitor')
    const { executeMonitorWakeFeedback } = await import('@/lib/ai/tools/smart-monitor-feedback')

    let failures = 0
    function check(label: string, cond: unknown, detail?: unknown) {
        const ok = Boolean(cond)
        console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : '  (' + JSON.stringify(detail) + ')'}`)
        if (!ok) failures++
    }

    const w = createMonitorWatch({
        title: 'Mom @ Gmail',
        source: 'gmail',
        target: 'mom@example.com',
        rule: { kind: 'gmail_from', senders: ['mom@example.com'] },
    })
    recordWatchEvent(w.id, 'match', {
        externalId: 'm1',
        summary: 'Hello from Mom',
        details: { from: 'mom@example.com' },
    })

    {
        const prompt = buildSmartMonitorAgentPrompt({
            now: Date.now(),
            taskId: 'task_smart',
            taskState: { quietRuns: 1 },
        })
        check('prompt includes watch id', prompt.includes(w.id))
        check('prompt includes rule description', prompt.includes('From contains: mom@example.com'))
        check('prompt includes recent decision history', prompt.includes('Recent watch decisions') && prompt.includes('Hello from Mom'))
        check('prompt instructs notify_inbox', prompt.includes('notify_inbox'))
        check('prompt includes lightest-runtime guidance', prompt.includes('Cheap deterministic gates belong in Microscripts'))
    }

    {
        const fb = await executeMonitorWakeFeedback({
            watch_id: w.id,
            was_worth_it: false,
            reason: 'Hello messages from Mom every morning - routine, not actionable',
            add_suppress_pattern: {
                reason: 'morning routine "Hello from Mom"',
                rule: { kind: 'gmail_subject_contains', substrings: ['Hello from Mom'] },
                expires_in_days: 30,
            },
        })
        check('feedback executor succeeds', fb.success === true)
        const data = fb.data as Record<string, unknown> | undefined
        check('feedback echoes watch_id', data?.watch_id === w.id)
        const added = data?.added_suppress_pattern as { patternId: string } | null
        check('feedback added pattern id returned', typeof added?.patternId === 'string')

        const w2 = getMonitorWatch(w.id)!
        check('watch now has 1 suppress pattern', w2.suppressPatterns.length === 1)
        check('pattern has 30-day expiry set', w2.suppressPatterns[0].expiresAt !== null && w2.suppressPatterns[0].expiresAt! > Date.now() + 25 * 86_400_000)

        const fbEvents = listWatchEvents(w.id, { kinds: ['feedback'] })
        const explicitFb = fbEvents.find((e) => e.payload?.was_worth_it === false)
        check('audit log has was_worth_it=false entry', explicitFb !== undefined)
    }

    {
        const prompt = buildSmartMonitorAgentPrompt({
            now: Date.now(),
            taskId: 'task_smart',
            taskState: {},
        })
        check('prompt lists active suppress pattern', prompt.includes('Learned suppress patterns to consider') && prompt.includes('morning routine'))
        check('prompt shows recent FEEDBACK entry in history', prompt.includes('FEEDBACK (NOT worth-it)'))
    }

    {
        const fb = await executeMonitorWakeFeedback({
            watch_id: w.id,
            was_worth_it: false,
            reason: 'trying to add an HA rule to a Gmail watch - should be rejected',
            add_suppress_pattern: {
                reason: 'wrong-source pattern',
                rule: { kind: 'ha_state_equals', entityId: 'sensor.x', state: 'on' },
            },
        })
        check('cross-source suppress pattern is rejected', fb.success === false)
        check('error mentions source incompat', typeof fb.error === 'string' && fb.error.toLowerCase().includes('source'))
    }

    {
        const w3 = getMonitorWatch(w.id)!
        const patId = w3.suppressPatterns[0].id
        const fb = await executeMonitorWakeFeedback({
            watch_id: w.id,
            was_worth_it: true,
            reason: 'Reconsidered - previous suppression was too eager',
            remove_suppress_pattern_id: patId,
        })
        check('remove suppress pattern via feedback succeeds', fb.success === true)
        const after = getMonitorWatch(w.id)!
        check('suppress patterns now empty', after.suppressPatterns.length === 0)
    }

    {
        const r1 = await executeMonitorWakeFeedback({ watch_id: '', was_worth_it: true, reason: 'x' })
        check('rejects empty watch_id', r1.success === false)

        const r2 = await executeMonitorWakeFeedback({ watch_id: w.id, reason: 'x' })
        check('rejects missing was_worth_it', r2.success === false)

        const r3 = await executeMonitorWakeFeedback({ watch_id: w.id, was_worth_it: false, reason: '' })
        check('rejects empty reason', r3.success === false)

        const r4 = await executeMonitorWakeFeedback({
            watch_id: w.id,
            was_worth_it: false,
            reason: 'x'.repeat(600),
        })
        check('rejects reason > 500 chars', r4.success === false)

        const r5 = await executeMonitorWakeFeedback({ watch_id: 'mw_doesnotexist', was_worth_it: true, reason: 'x' })
        check('rejects unknown watch_id', r5.success === false)

        const r6 = await executeMonitorWakeFeedback({
            watch_id: w.id,
            was_worth_it: false,
            reason: 'invalid rule shape test',
            add_suppress_pattern: {
                reason: 'bad rule',
                rule: { kind: 'gmail_from' } as Record<string, unknown>,
            },
        })
        check('rejects malformed rule in add_suppress_pattern', r6.success === false)
    }

    console.log(`\n${failures === 0 ? '✅ ALL OK' : `❌ ${failures} failure(s)`}`)
    process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
    console.error('Unhandled error in smoke test:', err)
    process.exit(2)
})
