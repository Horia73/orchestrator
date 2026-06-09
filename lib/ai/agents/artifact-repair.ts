import type { AgentConfig } from './types'

export const ARTIFACT_REPAIR_AGENT_ID = 'artifact_repair'

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
// Artifact Repair.
//
// A tiny utility agent that takes a strict-schema artifact body that failed
// validation (workout / recipe / map / weather) plus the exact parser error,
// and returns a corrected body. No tools, no delegation — a one-shot,
// minimal-edit JSON fix. Invoked by the chat route's in-turn repair pass when
// `insertArtifact` rejects an emitted artifact, so the user sees the corrected
// card instead of a broken one. Defaults to a cheap/fast model; the per-type
// schema is not needed in-prompt because the validator surfaces one concrete
// issue at a time and the route re-validates and re-prompts until it passes.
// ---------------------------------------------------------------------------

export const artifactRepairAgent: AgentConfig = {
    id: ARTIFACT_REPAIR_AGENT_ID,
    name: 'Artifact Repair',
    description: 'Fixes structured artifact JSON that failed strict schema validation, with the smallest possible change.',
    kind: 'text',
    tier: 'system',
    provider: 'google',
    model: 'gemini-3-flash-preview',
    thinkingLevel: 'minimal',
    buildPrompt: buildArtifactRepairPrompt,
    tools: [],
    builtins: [],
    canCallAgents: [],
}
