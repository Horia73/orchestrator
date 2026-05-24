/**
 * Smoke test for Step 10 — global quiet hours + per-watch override.
 *
 * Validates:
 *   - global quiet hours apply when watch has no per-watch override
 *   - per-watch quiet hours win over global
 *   - both absent → never quiet
 *   - explicit null in options disables global fallback (test mode)
 *
 * Run: npx tsx scripts/smoke-monitor-quiet-hours.ts
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { WatchSource } from '@/lib/monitor/schema'
import type { SourceAdapter } from '@/lib/monitor/sources'

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'smart-monitor-qh-smoke-'))
process.chdir(tmpRoot)

async function main(): Promise<void> {
    const { createMonitorWatch, setWatchCheckpoint, getMonitorWatch } = await import('@/lib/monitor/store')
    const { runSmartMonitorCheapPass } = await import('@/lib/monitoring/smart-monitor')
    const { updateConfig } = await import('@/lib/config')

    let failures = 0
    function check(label: string, cond: unknown, detail?: unknown) {
        const ok = Boolean(cond)
        console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : '  (' + JSON.stringify(detail) + ')'}`)
        if (!ok) failures++
    }

    // Adapters that always return one match for their source.
    const gmailMock: SourceAdapter = {
        source: 'gmail',
        supportedRuleKinds: ['gmail_from'],
        supportedActionKinds: ['notify_inbox'],
        async isAvailable() { return { available: true } },
        async cheapCheck({ now }) {
            return {
                ok: true,
                matches: [{
                    candidate: {
                        source: 'gmail',
                        id: `m${now}`,
                        threadId: 't',
                        labels: [],
                        from: 'mom@example.com',
                        to: 'me@example.com',
                        subject: 'hi',
                        snippet: 'x',
                        timestamp: now,
                    },
                    summary: 'mail',
                    externalId: `m${now}`,
                }],
                candidatesSeen: 1,
                stateUpdate: { lastFetchedAt: now },
                fetchedAt: now,
            }
        },
    }
    const webMock: SourceAdapter = {
        source: 'web',
        supportedRuleKinds: ['web_status'],
        supportedActionKinds: ['notify_inbox'],
        async isAvailable() { return { available: true } },
        async cheapCheck({ now }) {
            return {
                ok: true,
                matches: [{
                    candidate: {
                        source: 'web',
                        url: 'https://example.com/status',
                        status: 200,
                        previousStatus: 200,
                        text: 'ok',
                        json: null,
                        previousJson: null,
                        fetchedAt: now,
                    },
                    summary: 'web',
                    externalId: `w${now}`,
                }],
                candidatesSeen: 1,
                stateUpdate: { lastFetchedAt: now },
                fetchedAt: now,
            }
        },
    }
    const haMock: SourceAdapter = {
        source: 'home_assistant',
        supportedRuleKinds: ['ha_state_equals'],
        supportedActionKinds: ['notify_inbox'],
        async isAvailable() { return { available: true } },
        async cheapCheck({ now }) {
            return {
                ok: true,
                matches: [{
                    candidate: {
                        source: 'home_assistant',
                        entityId: 'binary_sensor.garage_door',
                        state: 'on',
                        attributes: {},
                        numericValue: null,
                        previousState: 'off',
                        previousAttributes: {},
                        previousNumericValue: null,
                        lastChanged: now,
                    },
                    summary: 'ha',
                    externalId: `ha${now}`,
                }],
                candidatesSeen: 1,
                stateUpdate: { lastFetchedAt: now },
                fetchedAt: now,
            }
        },
    }
    const mockReg = (src: WatchSource): SourceAdapter => {
        if (src === 'gmail') return gmailMock
        if (src === 'web') return webMock
        if (src === 'home_assistant') return haMock
        throw new Error('not mocked')
    }

    // Compute a time when it's "always quiet" using UTC 00:00-23:59 window
    // so the wrap-around check is unaffected by the test host's clock.
    const alwaysQuietWindow = { from: '00:00', to: '23:59', timezone: 'UTC' }

    // ============================================================================
    // 1. Per-watch quiet hours: matches NOT surfaced
    // ============================================================================
    const w1 = createMonitorWatch({
        title: 'Per-watch quiet',
        source: 'gmail',
        target: 'mom@example.com',
        rule: { kind: 'gmail_from', senders: ['mom@example.com'] },
        notify: { onMatch: true, quietHours: alwaysQuietWindow },
    })
    {
        const r = await runSmartMonitorCheapPass({
            now: Date.now() + 1,
            getAdapter: mockReg,
            globalQuietHours: null, // explicitly disable global fallback
        })
        check('per-watch quiet hours suppress the wake', r.noteworthy === false)
        check('matches recorded as quiet-hours suppressed', r.debug.matchesQuietHours === 1)
    }

    // ============================================================================
    // 2. Global quiet hours apply when per-watch is absent
    // ============================================================================
    const w2 = createMonitorWatch({
        title: 'No per-watch quiet',
        source: 'web',
        target: 'https://example.com/status',
        rule: { kind: 'web_status', url: 'https://example.com/status', op: 'equals', value: 200 },
        notify: { onMatch: true }, // NO quietHours here
    })
    setWatchCheckpoint(w2.id, { nextCheckAt: Date.now() })

    {
        // Without global, this watch SHOULD wake.
        const r = await runSmartMonitorCheapPass({
            now: Date.now() + 2,
            getAdapter: mockReg,
            globalQuietHours: null,
        })
        check('without global QH the new watch wakes', r.noteworthy === true)
    }

    setWatchCheckpoint(w2.id, { nextCheckAt: Date.now() })
    setWatchCheckpoint(w1.id, { nextCheckAt: Date.now() + 999_999_999 }) // park w1 to keep it out

    {
        // With global QH set via options, the watch should suppress.
        const r = await runSmartMonitorCheapPass({
            now: Date.now() + 3,
            getAdapter: mockReg,
            globalQuietHours: alwaysQuietWindow,
        })
        check('global QH suppresses watch without per-watch override', r.noteworthy === false)
        check('matches recorded as quiet-hours suppressed (global)', r.debug.matchesQuietHours === 1)
    }

    // ============================================================================
    // 3. Per-watch override beats global
    // ============================================================================
    // Add a watch with explicit quietHours that's "never" (00:00 - 00:00 = zero
    // window → never quiet per our parser semantics: from === to disables).
    const w3 = createMonitorWatch({
        title: 'Per-watch always-on',
        source: 'home_assistant',
        target: 'binary_sensor.garage_door',
        rule: { kind: 'ha_state_equals', entityId: 'binary_sensor.garage_door', state: 'on' },
        notify: {
            onMatch: true,
            quietHours: { from: '00:00', to: '00:00', timezone: 'UTC' },
        },
    })
    setWatchCheckpoint(w2.id, { nextCheckAt: Date.now() + 999_999_999 })

    {
        const r = await runSmartMonitorCheapPass({
            now: Date.now() + 4,
            getAdapter: mockReg,
            globalQuietHours: alwaysQuietWindow, // global wants to silence
        })
        check('per-watch zero-length window beats global', r.noteworthy === true)
    }

    // Re-park w3 before next test
    setWatchCheckpoint(w3.id, { nextCheckAt: Date.now() + 999_999_999 })

    // ============================================================================
    // 4. Engine reads getConfig() when options.globalQuietHours is undefined
    // ============================================================================
    // Persist global QH via updateConfig and verify engine uses it.
    updateConfig({ smartMonitor: { quietHours: alwaysQuietWindow } })

    setWatchCheckpoint(w2.id, { nextCheckAt: Date.now() })
    {
        const r = await runSmartMonitorCheapPass({
            now: Date.now() + 5,
            getAdapter: mockReg,
            // intentionally NO globalQuietHours — engine reads config
        })
        check('engine reads global QH from config when option undefined', r.noteworthy === false)
    }

    // Clear global config and confirm watch wakes again.
    updateConfig({ smartMonitor: undefined })
    setWatchCheckpoint(w2.id, { nextCheckAt: Date.now() })
    {
        const r = await runSmartMonitorCheapPass({
            now: Date.now() + 6,
            getAdapter: mockReg,
        })
        check('after clearing global QH the watch wakes', r.noteworthy === true)
    }

    const w2After = getMonitorWatch(w2.id)
    check('watch2 still exists and is active', w2After !== null && w2After.enabled)

    console.log(`\n${failures === 0 ? '✅ ALL OK' : `❌ ${failures} failure(s)`}`)
    process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
    console.error('Unhandled error in smoke test:', err)
    process.exit(2)
})
