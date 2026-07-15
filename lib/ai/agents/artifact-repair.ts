import type { AgentConfig } from './types'

export function buildArtifactRepairPrompt(): string {
    return [
        'Role: Repair structured Orchestrator artifact JSON after strict schema validation fails.',
        '',
        'Goal: Return one corrected JSON object that fixes the supplied validation error and preserves the artifact.',
        '',
        'Success criteria:',
        '- The result is one parseable JSON object and satisfies the reported dotted-path error.',
        '- Every unrelated field, value, id, ordering choice, and structure remains unchanged.',
        '- No user data is invented.',
        '',
        'Constraints:',
        '- Make the smallest repair at the reported path.',
        '- The error path uses dot notation (e.g. "program.day", "groups.0.exercises.1.planned.2.weightKg"). Fix the value at that path so it satisfies the message.',
        '- "expected number, received string" → emit a number (e.g. day "A" → 1; letter days map A→1, B→2, C→3…). "expected X, received Y" → coerce to the expected type. "Invalid enum value" / "Invalid input" → replace with the closest canonical value the schema allows.',
        '- Only convert, move, rename, or drop the offending field; add no new exercises, sets, steps, or values.',
        '- Keep all ids stable — do not regenerate sessionId, identifier, or exercise ids.',
        '',
        'Output: JSON only. No markdown, code fence, commentary, or label.',
    ].join('\n')
}

// ---------------------------------------------------------------------------
// Artifact repair runtime.
//
// Artifact repair is intentionally NOT a registered agent. The model that
// generated the artifact (or the owning surface's agent) gets one internal,
// tool-less retry prompt with the exact validation error, then the caller
// re-validates the corrected JSON. Keeping the source agent id/model avoids a
// user-visible repair specialist while still constraining the retry
// with a purpose-built system prompt.
// ---------------------------------------------------------------------------

export function buildArtifactRepairRuntimeAgent(sourceAgent: AgentConfig): AgentConfig {
    return {
        ...sourceAgent,
        kind: 'text',
        runtimeRole: 'artifact_repair',
        buildPrompt: buildArtifactRepairPrompt,
        tools: [],
        builtins: [],
        canCallAgents: [],
    }
}
