/**
 * Smoke test for Step 4: model-wake brief enrichment + monitor_wake_feedback.
 *
 * No model, no network. Validates:
 *   - briefPrompt includes <wake_reason> block with watch id, rule, history,
 *     suppress patterns, and per-tick matches
 *   - executeMonitorWakeFeedback records feedback event, optionally adds a
 *     suppress pattern with expiry, optionally removes a previous pattern
 *   - source-rule validation rejects mismatched suppress patterns
 *   - second tick AFTER feedback added: the new suppress pattern drops the
 *     candidate (full learning-loop roundtrip)
 *
 * Run: npx tsx scripts/smoke-monitor-feedback.ts
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { WatchSource } from '@/lib/monitor/schema'
import type { SourceAdapter } from '@/lib/monitor/sources'

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'smart-monitor-feedback-smoke-'))
process.chdir(tmpRoot)

async function main(): Promise<void> {
    const {
        createMonitorWatch,
        getMonitorWatch,
        listWatchEvents,
        setWatchCheckpoint,
    } = await import('@/lib/monitor/store')
    const { runSmartMonitorCheapPass } = await import('@/lib/monitoring/smart-monitor')
    const { executeMonitorWakeFeedback } = await import('@/lib/ai/tools/smart-monitor-feedback')

    let failures = 0
    function check(label: string, cond: unknown, detail?: unknown) {
        const ok = Boolean(cond)
        console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : '  (' + JSON.stringify(detail) + ')'}`)
        if (!ok) failures++
    }

    // ---- Mock Gmail adapter --------------------------------------------------
    let nextMatches: Array<{ id: string; summary: string; from?: string }> = []
    const gmailMock: SourceAdapter = {
        source: 'gmail',
        supportedRuleKinds: ['gmail_from', 'gmail_subject_contains'],
        supportedActionKinds: ['notify_inbox'],
        async isAvailable() { return { available: true } },
        async cheapCheck({ now }) {
            const matches = nextMatches.map((m) => ({
                candidate: {
                    source: 'gmail' as const,
                    id: m.id,
                    threadId: 't_' + m.id,
                    labels: ['INBOX'],
                    from: m.from ?? 'mom@example.com',
                    to: 'me@example.com',
                    subject: m.summary,
                    snippet: m.summary,
                    timestamp: now,
                },
                summary: m.summary,
                externalId: m.id,
                details: { id: m.id, from: m.from ?? 'mom@example.com' },
            }))
            return { ok: true, matches, candidatesSeen: matches.length, stateUpdate: { lastFetchedAt: now }, fetchedAt: now }
        },
    }
    const mockRegistry = (source: WatchSource): SourceAdapter => {
        if (source === 'gmail') return gmailMock
        throw new Error(`unmocked: ${source}`)
    }

    // ============================================================================
    // 1. Wake brief contains <wake_reason>
    // ============================================================================
    const w = createMonitorWatch({
        title: 'Mom @ Gmail',
        source: 'gmail',
        target: 'mom@example.com',
        rule: { kind: 'gmail_from', senders: ['mom@example.com'] },
    })

    nextMatches = [{ id: 'm1', summary: 'Hello from Mom', from: 'mom@example.com' }]
    {
        const r = await runSmartMonitorCheapPass({ now: Date.now() + 1, getAdapter: mockRegistry })
        check('first tick is noteworthy', r.noteworthy === true)
        const bp = r.briefPrompt ?? ''
        check('brief contains <wake_reason>', bp.includes('<wake_reason>') && bp.includes('</wake_reason>'))
        check('brief includes watch id', bp.includes(w.id))
        check('brief includes rule description', bp.includes('From contains: mom@example.com'))
        check('brief includes "Recent decisions" header', bp.includes('Recent decisions'))
        check('brief instructs monitor_wake_feedback', bp.includes('monitor_wake_feedback'))
        check('brief instructs notify_inbox', bp.includes('notify_inbox'))
        check('brief mentions match summary', bp.includes('Hello from Mom'))
        check('brief shows no active suppress patterns initially', bp.includes('Active suppress patterns: none'))
    }

    // ============================================================================
    // 2. monitor_wake_feedback: was_worth_it=false + add suppress pattern
    // ============================================================================
    {
        const fb = await executeMonitorWakeFeedback({
            watch_id: w.id,
            was_worth_it: false,
            reason: 'Hello messages from Mom every morning — routine, not actionable',
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
        // At least 2 events: one from addSuppressPattern, one from explicit feedback record
        check('feedback event recorded in audit', fbEvents.length >= 1)
        const explicitFb = fbEvents.find((e) => e.payload?.was_worth_it === false)
        check('audit log has was_worth_it=false entry', explicitFb !== undefined)
    }

    // ============================================================================
    // 3. Source-rule validation: reject cross-source suppress pattern
    // ============================================================================
    {
        const fb = await executeMonitorWakeFeedback({
            watch_id: w.id,
            was_worth_it: false,
            reason: 'trying to add an HA rule to a Gmail watch — should be rejected',
            add_suppress_pattern: {
                reason: 'wrong-source pattern',
                rule: { kind: 'ha_state_equals', entityId: 'sensor.x', state: 'on' },
            },
        })
        check('cross-source suppress pattern is rejected', fb.success === false)
        check('error mentions source incompat', typeof fb.error === 'string' && fb.error.toLowerCase().includes('source'))
    }

    // ============================================================================
    // 4. Pattern actually drops the next tick's matching candidate
    // ============================================================================
    setWatchCheckpoint(w.id, { nextCheckAt: Date.now() })
    nextMatches = [{ id: 'm2', summary: 'Hello from Mom — second hello', from: 'mom@example.com' }]
    {
        const r = await runSmartMonitorCheapPass({ now: Date.now() + 2, getAdapter: mockRegistry })
        check('next tick: match dropped by feedback-authored pattern', r.noteworthy === false)
        check('debug.matchesSuppressed = 1 on next tick', r.debug.matchesSuppressed === 1)
    }

    // ============================================================================
    // 5. brief shows the active suppress pattern this time
    // ============================================================================
    setWatchCheckpoint(w.id, { nextCheckAt: Date.now() })
    nextMatches = [{ id: 'm3', summary: 'Truly urgent: please call', from: 'mom@example.com' }]
    {
        const r = await runSmartMonitorCheapPass({ now: Date.now() + 3, getAdapter: mockRegistry })
        check('different subject NOT suppressed', r.noteworthy === true)
        const bp = r.briefPrompt ?? ''
        check('brief lists active suppress pattern', bp.includes('Active suppress patterns (1)') && bp.includes('morning routine'))
        check('brief shows recent FEEDBACK entry in history', bp.includes('FEEDBACK (NOT worth-it)'))
    }

    // ============================================================================
    // 6. Remove a suppress pattern via feedback tool
    // ============================================================================
    {
        const w3 = getMonitorWatch(w.id)!
        const patId = w3.suppressPatterns[0].id
        const fb = await executeMonitorWakeFeedback({
            watch_id: w.id,
            was_worth_it: true,
            reason: 'Reconsidered — Mom said the previous suppression was too eager',
            remove_suppress_pattern_id: patId,
        })
        check('remove suppress pattern via feedback succeeds', fb.success === true)
        const after = getMonitorWatch(w.id)!
        check('suppress patterns now empty', after.suppressPatterns.length === 0)
    }

    // ============================================================================
    // 7. Validation: required fields, length caps, unknown watch
    // ============================================================================
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
                // Missing required `senders` field
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
