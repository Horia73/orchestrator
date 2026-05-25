import type {
    AvailabilityResult,
    CheapCheckInput,
    CheapCheckResult,
    SourceAdapter,
} from './types'
import { evaluateRule, type CustomCandidate } from '../rules'
import type { MonitorRule } from '../schema'

// ---------------------------------------------------------------------------
// Model-owned custom source adapter.
//
// `custom` watches let Smart Monitor carry recurring model-owned work whose
// check is described by prompt rather than by a connector-specific predicate.
// The active Smart Monitor path wakes the model on the consolidated heartbeat
// and includes the custom prompt in the watch list. The cheap-check below keeps
// the legacy pass usable by emitting one due candidate per custom watch tick.
// ---------------------------------------------------------------------------

function collectCustomPrompts(rule: MonitorRule): string[] {
    if (rule.kind === 'custom_prompt') return [rule.prompt]
    if (rule.kind === 'any_of' || rule.kind === 'all_of') {
        return rule.rules.flatMap(collectCustomPrompts)
    }
    return []
}

export const customSourceAdapter: SourceAdapter = {
    source: 'custom',
    supportedRuleKinds: ['custom_prompt'],
    supportedActionKinds: ['notify_inbox'],

    async isAvailable(): Promise<AvailabilityResult> {
        return { available: true }
    },

    async cheapCheck(input: CheapCheckInput): Promise<CheapCheckResult> {
        const prompts = collectCustomPrompts(input.watch.rule)
        const prompt = prompts.join('\n\n').trim() || input.watch.target
        const candidate: CustomCandidate = {
            source: 'custom',
            watchId: input.watch.id,
            target: input.watch.target,
            prompt,
            firedAt: input.now,
        }
        const matches = evaluateRule(input.watch.rule, candidate)
            ? [{
                candidate,
                summary: `Model-owned check due: ${input.watch.title}`,
                externalId: `${input.watch.id}:${input.now}`,
                details: {
                    target: input.watch.target,
                    prompt,
                },
            }]
            : []

        return {
            ok: true,
            matches,
            candidatesSeen: 1,
            stateUpdate: {
                lastFetchedAt: input.now,
                lastSeenId: `${input.watch.id}:${input.now}`,
                extra: {
                    custom: {
                        lastDueAt: input.now,
                    },
                },
            },
            fetchedAt: input.now,
        }
    },
}
