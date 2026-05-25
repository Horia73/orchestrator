import type {
    PreviousSessionSnapshot,
    ProgressionConfig,
} from './schema'

/**
 * Server-side helper that the artifact generator can call to suggest the
 * next session's target weight × reps for an exercise. The renderer never
 * uses this — it operates on what the model bakes into `planned`.
 *
 * Rules:
 *
 *   - `linear`              if last session hit all prescribed reps without
 *                           failing, weight += increment (default 2.5 kg
 *                           for upper body, 5 kg for lower — caller passes
 *                           the increment per exercise). Otherwise repeat.
 *
 *   - `double_progression`  add reps until top of the target range; then
 *                           +increment kg and reset reps to bottom of range.
 *
 *   - `rpe_target`          if last session's RPE was below target by ≥1.5,
 *                           +increment kg; if above target by ≥0.5, -increment;
 *                           else hold.
 *
 *   - `percentage`          deterministic — caller supplies the percent for
 *                           the upcoming session as `target.rpe` reused
 *                           (we don't have a separate field). The function
 *                           passes the previous weight through unless an
 *                           explicit `percent` override is passed in opts.
 *
 *   - `none`                always return the previous weight unchanged.
 *
 * Returns `null` when there's no previous session to base a suggestion on
 * (first-time exercise). The caller then either uses a starting weight or
 * asks the user.
 */

export interface ProgressionSuggestion {
    /** Suggested target weight in kg. */
    weightKg: number | null
    /** Suggested target reps (single value or range). */
    reps: number | [number, number] | null
    /** One-line rationale shown in the LLM's response. */
    rationale: string
}

export function suggestNextTarget(
    config: ProgressionConfig,
    previous: PreviousSessionSnapshot | undefined,
    opts: {
        defaultIncrementKg?: number
        previousFailed?: boolean
    } = {},
): ProgressionSuggestion {
    if (!previous) {
        return {
            weightKg: null,
            reps: config.target?.reps ?? null,
            rationale: 'No previous session — set a starting weight conservatively (RPE 7).',
        }
    }

    const increment = config.increment ?? opts.defaultIncrementKg ?? 2.5
    const prevW = previous.bestSet.weightKg
    const prevR = previous.bestSet.reps
    const prevRpe = previous.bestSet.rpe

    switch (config.rule) {
        case 'none':
            return {
                weightKg: prevW ?? null,
                reps: prevR ?? null,
                rationale: 'Hold previous weight × reps.',
            }

        case 'linear': {
            if (opts.previousFailed) {
                return {
                    weightKg: prevW ?? null,
                    reps: prevR ?? null,
                    rationale: 'Failed last session — repeat same weight × reps.',
                }
            }
            const next = prevW !== undefined ? prevW + increment : null
            return {
                weightKg: next,
                reps: prevR ?? null,
                rationale: next !== null
                    ? `Linear progression: +${increment} kg from last session.`
                    : 'Linear progression: no previous weight to add from.',
            }
        }

        case 'double_progression': {
            const range = config.target?.reps
            if (!range || !prevR || prevW === undefined) {
                return {
                    weightKg: prevW ?? null,
                    reps: range ?? prevR ?? null,
                    rationale: 'Double progression needs target rep range and previous data.',
                }
            }
            const [lo, hi] = range
            if (prevR >= hi) {
                // Topped out — bump weight, reset to bottom of range.
                return {
                    weightKg: prevW + increment,
                    reps: [lo, hi],
                    rationale: `Hit top of range (${hi} reps) — +${increment} kg, reset reps.`,
                }
            }
            // Add reps next session.
            return {
                weightKg: prevW,
                reps: [Math.min(prevR + 1, hi), hi],
                rationale: `Add reps within range (${lo}-${hi}) until top, then add weight.`,
            }
        }

        case 'rpe_target': {
            const targetRpe = config.target?.rpe ?? 8
            if (prevRpe === undefined || prevW === undefined) {
                return {
                    weightKg: prevW ?? null,
                    reps: prevR ?? null,
                    rationale: 'RPE target needs last-session RPE data — repeat for now.',
                }
            }
            const diff = targetRpe - prevRpe
            if (diff >= 1.5) {
                return {
                    weightKg: prevW + increment,
                    reps: prevR ?? null,
                    rationale: `Last RPE ${prevRpe} below target ${targetRpe} — +${increment} kg.`,
                }
            }
            if (diff <= -0.5) {
                return {
                    weightKg: prevW - increment,
                    reps: prevR ?? null,
                    rationale: `Last RPE ${prevRpe} above target ${targetRpe} — -${increment} kg.`,
                }
            }
            return {
                weightKg: prevW,
                reps: prevR ?? null,
                rationale: `RPE on target — hold.`,
            }
        }

        case 'percentage':
            return {
                weightKg: prevW ?? null,
                reps: prevR ?? null,
                rationale: 'Percentage-based: caller computes from 1RM × percent.',
            }
    }
}
