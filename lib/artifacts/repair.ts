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
    /** The exact validation error that rejected `content`. */
    error: string
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

function buildRepairUserPrompt(type: string, content: string, error: string): string {
    return [
        `Artifact type: ${type}`,
        `Validation error: ${error}`,
        '',
        'Current JSON body:',
        content,
        '',
        'Return the corrected JSON body only.',
    ].join('\n')
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

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const raw = await args.generate(buildRepairUserPrompt(args.type, currentContent, currentError))
        if (raw == null) return { ok: false, error: currentError, attempts: attempt }

        const candidate = unwrapJsonFence(raw)
        const validation = validateArtifactContent(args.type, candidate)
        if (validation.ok) return { ok: true, content: candidate, attempts: attempt }

        // Carry the model's attempt + its new error into the next round; even a
        // partial fix usually shrinks the remaining issues.
        currentContent = candidate
        currentError = validation.error
    }

    return { ok: false, error: currentError, attempts: maxAttempts }
}
