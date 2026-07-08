import { validateArtifactContent } from './validation'

/**
 * Strip a leading/trailing markdown code fence the model may wrap the JSON in
 * despite being told not to. Tolerant: only unwraps when the whole string is a
 * single fenced block, so a JSON string that merely contains backticks is left
 * untouched.
 */
export function unwrapJsonFence(text: string): string {
    const trimmed = text.trim()
    const fence = trimmed.match(/^```[a-zA-Z0-9]*\s*\n?([\s\S]*?)\n?```$/)
    return fence ? fence[1].trim() : trimmed
}

export interface RepairArtifactArgs {
    /** Artifact mime type, e.g. `application/vnd.ant.workout`. */
    type: string
    /** The current (invalid) JSON body. */
    content: string
    /** The exact validation error that rejected `content` (first issue). */
    error: string
    /**
     * Every validation issue, when the caller has them. Lets the repair model
     * fix all problems in one round-trip instead of one-per-attempt. When
     * omitted, the full issue list is derived from `content` at repair time.
     */
    issues?: string[]
    /**
     * Runs one repair generation with the given user prompt and returns its raw
     * text output (or null on failure). Injected by the caller so this module
     * stays free of any agent-runner / provider dependency and is unit-testable.
     */
    generate: (userPrompt: string) => Promise<string | null>
    /** How many model round-trips to attempt before giving up. Default 2. */
    maxAttempts?: number
}

export type RepairArtifactResult =
    | { ok: true; content: string; attempts: number }
    | { ok: false; error: string; attempts: number }

// Per-type schema reminders injected into the repair prompt. The repair
// runtime agent is otherwise tool-less and has NO domain schema in context, so
// without these it flies blind and tends to re-emit the same mistake (observed:
// gpt-5.5 repeating `notes` as an array across both repair attempts). Keep each
// hint short and only cover the mistakes the schema can't silently coerce.
const TYPE_REPAIR_HINTS: Record<string, string> = {
    'application/vnd.ant.workout': [
        'Workout schema reminders:',
        '- `notes` (root and per-set) MUST be a single string, never an array — join lines with "\\n".',
        '- `program.day`/`week`/`sessionN` are NUMBERS; map letter days A→1, B→2, C→3.',
        '- Every numeric field (weightKg, weightPct, reps, restSec, durationSec, distanceM, rounds, rpe, rir) is a number, not a string.',
        '- A `weighted` set MUST have weightKg or weightPct; if the load is only bodyweight, change the exercise `kind` to "bodyweight".',
        '- superset / circuit / giant_set groups: every exercise must have the SAME number of planned sets.',
        '- Enum fields (difficulty usor|mediu|greu|brutal, units kg|lb, equipment, muscleGroups, group/exercise/set kind, progression rule) must use an allowed value verbatim.',
        '- `previous` must be { date, bestSet:{…numbers}, allSets?:[…] } — never free-form strings.',
        '- Keep sessionId and every exercise id unchanged.',
    ].join('\n'),
}

function buildRepairUserPrompt(type: string, content: string, issues: string[]): string {
    const hint = TYPE_REPAIR_HINTS[type]
    const errorLines = issues.length > 1
        ? ['Validation errors (fix ALL of them):', ...issues.map((e, i) => `  ${i + 1}. ${e}`)]
        : [`Validation error: ${issues[0] ?? ''}`]
    return [
        `Artifact type: ${type}`,
        ...errorLines,
        ...(hint ? ['', hint] : []),
        '',
        'Current JSON body:',
        content,
        '',
        'Return the corrected JSON body only.',
    ].join('\n')
}

/** Resolve the full issue list for the current (invalid) body. Uses the
 *  caller-provided list when present, else re-validates the content to recover
 *  every issue (falling back to the single `error` string). */
function resolveIssues(type: string, content: string, fallbackError: string, provided?: string[]): string[] {
    if (provided && provided.length) return provided
    const v = validateArtifactContent(type, content)
    if (!v.ok && v.issues && v.issues.length) return v.issues
    return [fallbackError]
}

/**
 * Repair a strict-schema artifact body that failed validation. Re-validates
 * the model's output and, because the parser surfaces one issue at a time,
 * feeds the next error back for another pass until the body is valid or
 * `maxAttempts` is exhausted. Returns the last seen error on failure so the
 * caller can surface a precise message instead of a generic one.
 */
export async function repairArtifactContent(args: RepairArtifactArgs): Promise<RepairArtifactResult> {
    const maxAttempts = Math.max(1, args.maxAttempts ?? 2)
    let currentContent = args.content
    let currentError = args.error
    let currentIssues = resolveIssues(args.type, args.content, args.error, args.issues)

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const raw = await args.generate(buildRepairUserPrompt(args.type, currentContent, currentIssues))
        if (raw == null) return { ok: false, error: currentError, attempts: attempt }

        const candidate = unwrapJsonFence(raw)
        const validation = validateArtifactContent(args.type, candidate)
        if (validation.ok) return { ok: true, content: candidate, attempts: attempt }

        // Carry the model's attempt + its new errors into the next round; even a
        // partial fix usually shrinks the remaining issues.
        currentContent = candidate
        currentError = validation.error
        currentIssues = validation.issues && validation.issues.length ? validation.issues : [validation.error]
    }

    return { ok: false, error: currentError, attempts: maxAttempts }
}
