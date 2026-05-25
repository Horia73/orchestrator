import type { ToolDef, ToolResult } from '@/lib/ai/agents/types'

// ---------------------------------------------------------------------------
// monitor_wake_feedback — the model's learning channel for Smart Monitor.
//
// At every consolidated wake the orchestrator decides, per watch, whether the
// matches were worth notifying. After deciding it calls THIS tool once per
// watch involved:
//   - `was_worth_it: true`  → routine confirmation; recorded in the audit log
//   - `was_worth_it: false` → matches looked noisy this time; recorded plus
//     OPTIONALLY a suppress_pattern that drops similar candidates BEFORE the
//     model is woken next time. The suppress pattern reuses the same
//     MonitorRule shape the watch itself uses — adapter-side evaluation of
//     patterns is automatic (see lib/monitoring/smart-monitor.ts).
//
// The tool can also remove a previously-added suppress pattern by id, so the
// model can retract a filter that turned out to over-suppress.
// ---------------------------------------------------------------------------

export const monitorWakeFeedbackTool: ToolDef = {
    id: 'monitor_wake_feedback',
    name: 'monitor_wake_feedback',
    description: [
        'Record per-watch feedback after a Smart Monitor wake.',
        'Call this once per watch that produced matches in the wake — even if you also called notify_inbox for it — so the engine can learn what is worth waking you for.',
        'Set was_worth_it=true when the matches deserved attention. Set was_worth_it=false when they were noise/routine; in that case also pass add_suppress_pattern with a structured MonitorRule that captures the noise signature so future ticks drop similar candidates BEFORE waking you.',
        'Use remove_suppress_pattern_id to retract a previously-added pattern that is now over-suppressing.',
    ].join(' '),
    input_schema: {
        type: 'object',
        properties: {
            watch_id: { type: 'string', description: 'The watch id from the <wake_reason> block. Must reference an existing watch.' },
            was_worth_it: { type: 'boolean', description: 'True if the matches deserved your attention this tick. False if they were noise.' },
            reason: { type: 'string', description: 'Short explanation (≤500 chars). Persisted in the audit log; shown in the watch detail UI so the user can see why you classified it that way.' },
            add_suppress_pattern: {
                type: 'object',
                description: 'Optional. When was_worth_it=false, attach a rule that captures the noise signature; future ticks evaluate it and drop matching candidates before any wake. Reuses MonitorRule shape.',
                properties: {
                    reason: { type: 'string', description: 'Plain-English explanation shown next to the pattern in the UI.' },
                    rule: { type: 'object', description: 'A MonitorRule (any predicate kind supported by the watch\'s source, plus any_of/all_of composition).' },
                    expires_in_days: { type: 'number', description: 'Optional auto-expiry. Omit for stable recurring noise. Use only for clearly temporary or uncertain filters, and mention why the filter is temporary in reason.' },
                },
                required: ['reason', 'rule'],
            },
            remove_suppress_pattern_id: { type: 'string', description: 'Optional. Remove a previously-added suppress pattern (use the id shown in <wake_reason>).' },
        },
        required: ['watch_id', 'was_worth_it', 'reason'],
    },
    tags: ['monitoring'],
}

export async function executeMonitorWakeFeedback(args: Record<string, unknown>): Promise<ToolResult> {
    const watchId = typeof args.watch_id === 'string' ? args.watch_id.trim() : ''
    if (!watchId) return { success: false, error: 'watch_id is required.' }
    if (typeof args.was_worth_it !== 'boolean') return { success: false, error: 'was_worth_it (boolean) is required.' }
    const reason = typeof args.reason === 'string' ? args.reason.trim() : ''
    if (!reason) return { success: false, error: 'reason is required.' }
    if (reason.length > 500) return { success: false, error: 'reason must be ≤500 characters.' }

    const wasWorthIt = args.was_worth_it as boolean
    const addSuppressArg = args.add_suppress_pattern as Record<string, unknown> | undefined
    const removeSuppressIdArg = args.remove_suppress_pattern_id as string | undefined

    const store = await import('@/lib/monitor/store')
    const { MonitorRuleSchema, assertRuleDepth } = await import('@/lib/monitor/schema')
    const { ruleMatchesSource } = await import('@/lib/monitor/rules')

    const watch = store.getMonitorWatch(watchId)
    if (!watch) return { success: false, error: `No watch with id ${watchId}.` }

    // 1. Record the feedback event itself.
    store.recordWatchEvent(watchId, 'feedback', {
        was_worth_it: wasWorthIt,
        reason,
    })

    // 2. Optional: remove an over-suppressing pattern.
    let removed: { patternId: string } | null = null
    if (typeof removeSuppressIdArg === 'string' && removeSuppressIdArg.trim()) {
        const ok = store.removeSuppressPattern(watchId, removeSuppressIdArg.trim())
        if (!ok) {
            return { success: false, error: `No suppress pattern ${removeSuppressIdArg} on watch ${watchId}.` }
        }
        removed = { patternId: removeSuppressIdArg.trim() }
    }

    // 3. Optional: add a new suppress pattern. Validate against the watch's
    //    source so we never persist a Gmail rule on an HA watch (or vice versa).
    let added: { patternId: string; reason: string } | null = null
    if (addSuppressArg && typeof addSuppressArg === 'object' && !Array.isArray(addSuppressArg)) {
        const patReason = typeof addSuppressArg.reason === 'string' ? addSuppressArg.reason.trim() : ''
        if (!patReason) return { success: false, error: 'add_suppress_pattern.reason is required.' }
        if (patReason.length > 500) return { success: false, error: 'add_suppress_pattern.reason must be ≤500 characters.' }

        const ruleRaw = addSuppressArg.rule
        if (!ruleRaw || typeof ruleRaw !== 'object') {
            return { success: false, error: 'add_suppress_pattern.rule is required and must be a MonitorRule object.' }
        }
        const parsed = MonitorRuleSchema.safeParse(ruleRaw)
        if (!parsed.success) {
            return { success: false, error: `add_suppress_pattern.rule is invalid: ${parsed.error.message}` }
        }
        try {
            assertRuleDepth(parsed.data)
        } catch (err) {
            return { success: false, error: err instanceof Error ? err.message : 'rule too deep.' }
        }
        if (watch.source !== 'custom' && !ruleMatchesSource(parsed.data, watch.source)) {
            return { success: false, error: `add_suppress_pattern.rule contains predicate(s) not supported by source "${watch.source}". Use predicates compatible with the watch's own rule.` }
        }

        const expiresInDays = typeof addSuppressArg.expires_in_days === 'number' && addSuppressArg.expires_in_days > 0
            ? addSuppressArg.expires_in_days
            : null
        const expiresAt = expiresInDays ? Date.now() + expiresInDays * 86_400_000 : null

        const pattern = store.addSuppressPattern(watchId, {
            reason: patReason,
            rule: parsed.data,
            expiresAt,
        })
        if (!pattern) return { success: false, error: 'Failed to add suppress pattern (watch may have just been deleted).' }
        added = { patternId: pattern.id, reason: pattern.reason }
    }

    return {
        success: true,
        data: {
            watch_id: watchId,
            was_worth_it: wasWorthIt,
            recorded: true,
            added_suppress_pattern: added,
            removed_suppress_pattern: removed,
        },
    }
}
