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
// The tool can also remove previously-added suppress patterns by id, either as
// part of normal match feedback or as a standalone periodic maintenance pass.
// ---------------------------------------------------------------------------

export const monitorWakeFeedbackTool: ToolDef = {
    id: 'monitor_wake_feedback',
    name: 'monitor_wake_feedback',
    description: [
        'Record per-watch feedback after a Smart Monitor wake.',
        'Call this once per watch that produced matches in the wake — even if you also called notify_inbox for it — so the engine can learn what is worth waking you for.',
        'Set was_worth_it=true when the matches deserved attention. Set was_worth_it=false when they were noise/routine; in that case also pass add_suppress_pattern with a structured MonitorRule that captures the noise signature so future ticks drop similar candidates BEFORE waking you.',
        'Use remove_suppress_pattern_id to retract one previously-added pattern, or remove_suppress_pattern_ids during a periodic housekeeping audit to retire several expired, redundant, obsolete, invalid, or over-broad patterns. A removal-only audit may omit was_worth_it; normal match feedback must still provide it.',
        'For a closed-loop FOLLOW-UP watch whose match the engine auto-resolved: pass follow_up_outcome="confirmed" when the matched item really was the expected effect (the engine then removes the watch after this wake), or follow_up_outcome="not_yet" when it was something else (your own message, an unrelated mail) — that re-arms the watch to keep waiting, optionally with extend_deadline_days.',
    ].join(' '),
    input_schema: {
        type: 'object',
        properties: {
            watch_id: { type: 'string', description: 'The watch id from the <wake_reason> block. Must reference an existing watch.' },
            was_worth_it: { type: 'boolean', description: 'True if the matches deserved your attention this tick. False if they were noise. May be omitted only for a removal-only suppress-pattern audit.' },
            reason: { type: 'string', description: 'Short explanation (≤500 chars) for the feedback or maintenance decision. Persisted in the audit log.' },
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
            remove_suppress_pattern_ids: {
                type: 'array',
                items: { type: 'string' },
                description: 'Optional maintenance batch. Remove each listed suppress-pattern id after auditing the watch. Do not remove a pattern merely because its hit count is zero.',
            },
            follow_up_outcome: { type: 'string', enum: ['confirmed', 'not_yet'], description: 'Only for follow-up watches. "confirmed" = the auto-resolving match was the expected effect. "not_yet" = false resolution; re-arm the watch and keep waiting for the real effect.' },
            extend_deadline_days: { type: 'number', description: 'Optional, with follow_up_outcome="not_yet": push the follow-up deadline this many days past the original.' },
        },
        required: ['watch_id', 'reason'],
    },
    tags: ['monitoring'],
}

export async function executeMonitorWakeFeedback(args: Record<string, unknown>): Promise<ToolResult> {
    const watchId = typeof args.watch_id === 'string' ? args.watch_id.trim() : ''
    if (!watchId) return { success: false, error: 'watch_id is required.' }
    const reason = typeof args.reason === 'string' ? args.reason.trim() : ''
    if (!reason) return { success: false, error: 'reason is required.' }
    if (reason.length > 500) return { success: false, error: 'reason must be ≤500 characters.' }

    const addSuppressArg = args.add_suppress_pattern as Record<string, unknown> | undefined
    const removeSuppressIdArg = args.remove_suppress_pattern_id as string | undefined
    const removeSuppressIdsArg = args.remove_suppress_pattern_ids
    if (removeSuppressIdsArg !== undefined && !Array.isArray(removeSuppressIdsArg)) {
        return { success: false, error: 'remove_suppress_pattern_ids must be an array of ids.' }
    }
    const rawRemovalIds = [
        ...(typeof removeSuppressIdArg === 'string' ? [removeSuppressIdArg] : []),
        ...(Array.isArray(removeSuppressIdsArg) ? removeSuppressIdsArg : []),
    ]
    if (rawRemovalIds.some((id) => typeof id !== 'string' || !id.trim())) {
        return { success: false, error: 'remove_suppress_pattern_ids must contain only non-empty string ids.' }
    }
    const removalIds = [...new Set(rawRemovalIds.map((id) => (id as string).trim()))]
    const maintenanceOnly = args.was_worth_it === undefined
        && removalIds.length > 0
        && addSuppressArg === undefined
        && args.follow_up_outcome === undefined
        && args.extend_deadline_days === undefined
    if (typeof args.was_worth_it !== 'boolean' && !maintenanceOnly) {
        return { success: false, error: 'was_worth_it (boolean) is required outside a removal-only suppress-pattern audit.' }
    }
    const wasWorthIt = typeof args.was_worth_it === 'boolean' ? args.was_worth_it : null

    const store = await import('@/lib/monitor/store')
    const { MonitorRuleSchema, assertRuleDepth } = await import('@/lib/monitor/schema')
    const { ruleMatchesSource, findAdapterEvaluatedKind } = await import('@/lib/monitor/rules')

    const watch = store.getMonitorWatch(watchId)
    if (!watch) return { success: false, error: `No watch with id ${watchId}.` }
    const knownPatternIds = new Set(watch.suppressPatterns.map((pattern) => pattern.id))
    const missingPatternIds = removalIds.filter((id) => !knownPatternIds.has(id))
    if (missingPatternIds.length > 0) {
        return { success: false, error: `No suppress pattern(s) ${missingPatternIds.join(', ')} on watch ${watchId}.` }
    }

    // 1. Record the feedback event itself.
    store.recordWatchEvent(watchId, 'feedback', {
        ...(wasWorthIt === null
            ? { maintenance: 'suppress_pattern_audit' }
            : { was_worth_it: wasWorthIt }),
        reason,
        ...(args.follow_up_outcome === 'confirmed' || args.follow_up_outcome === 'not_yet'
            ? { follow_up_outcome: args.follow_up_outcome }
            : {}),
    })

    // 2. Optional: remove one or more audited patterns. Validate the complete
    //    batch above before mutating so a bad id cannot cause a partial audit.
    const removed: Array<{ patternId: string }> = []
    for (const patternId of removalIds) {
        const ok = store.removeSuppressPattern(watchId, patternId)
        if (!ok) {
            return { success: false, error: `Failed to remove suppress pattern ${patternId} from watch ${watchId}.` }
        }
        removed.push({ patternId })
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
        const adapterKind = findAdapterEvaluatedKind(parsed.data)
        if (adapterKind) {
            return { success: false, error: `add_suppress_pattern.rule contains "${adapterKind}", which is applied by the ${watch.source} adapter during fetch — as a suppress pattern it would match EVERY candidate and silence the watch entirely. Re-express the noise signature with locally-evaluable predicates (e.g. gmail_from / gmail_subject_contains / wa_from / wa_text_contains), composed with any_of/all_of if needed.` }
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

    // 4. Optional: follow-up resolution verdict (closed-loop watches only).
    let followUpResult: { outcome: string; deadline_at?: string } | null = null
    const followUpOutcomeArg = args.follow_up_outcome
    if (followUpOutcomeArg !== undefined) {
        if (followUpOutcomeArg !== 'confirmed' && followUpOutcomeArg !== 'not_yet') {
            return { success: false, error: 'follow_up_outcome must be "confirmed" or "not_yet".' }
        }
        if (!watch.followUp) {
            return { success: false, error: `Watch ${watchId} is not a follow-up watch; follow_up_outcome does not apply.` }
        }
        if (followUpOutcomeArg === 'not_yet') {
            const extendDays = typeof args.extend_deadline_days === 'number' && args.extend_deadline_days > 0
                ? Math.min(args.extend_deadline_days, 180)
                : null
            const reopened = store.reopenWatchFollowUp(watchId, {
                extendDeadlineToMs: extendDays
                    ? watch.followUp.deadlineAt + extendDays * 86_400_000
                    : undefined,
            })
            if (!reopened?.followUp) return { success: false, error: 'Failed to re-arm follow-up watch.' }
            followUpResult = {
                outcome: 're-armed',
                deadline_at: new Date(reopened.followUp.deadlineAt).toISOString(),
            }
        } else {
            // Confirmed: nothing to mutate — the engine already completed the
            // lifecycle and the post-wake sweep removes the watch. Recording the
            // verdict in the feedback event (step 1) is the audit trail.
            followUpResult = { outcome: 'confirmed' }
        }
    }

    return {
        success: true,
        data: {
            watch_id: watchId,
            was_worth_it: wasWorthIt,
            recorded: true,
            added_suppress_pattern: added,
            removed_suppress_pattern: removed.length === 1 ? removed[0] : null,
            removed_suppress_patterns: removed,
            follow_up: followUpResult,
        },
    }
}
