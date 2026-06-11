import type { AgentConfig } from './types'

export function buildArtifactRepairPrompt(): string {
    return [
        'You repair structured artifact JSON in Orchestrator that failed strict schema validation.',
        '',
        'You will be given the artifact type, the exact validation error (a dotted path plus a message), and the current JSON body. Your job is to return a corrected JSON body that passes validation.',
        '',
        'Rules:',
        '- Output ONLY the corrected JSON object. No markdown, no code fences, no commentary, no leading label like "JSON:".',
        '- Make the SMALLEST change that fixes the reported error. Preserve every other field, value, ordering, and the overall structure exactly as given.',
        '- The error path uses dot notation (e.g. "program.day", "groups.0.exercises.1.planned.2.weightKg"). Fix the value at that path so it satisfies the message.',
        '- "expected number, received string" → emit a number (e.g. day "A" → 1; letter days map A→1, B→2, C→3…). "expected X, received Y" → coerce to the expected type. "Invalid enum value" / "Invalid input" → replace with the closest canonical value the schema allows.',
        '- Never invent data the user did not provide (no new exercises, sets, steps, or values). Only convert, move, rename, or drop the offending field to make it valid.',
        '- Keep all ids stable — do not regenerate sessionId, identifier, or exercise ids.',
        '- The result MUST be a single valid, parseable JSON object.',
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
