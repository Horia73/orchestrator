import type { EffectiveModelEntry } from '@/lib/models/schema'

// ---------------------------------------------------------------------------
// User-message prompt builders for the model-metadata-researcher agent.
//
// Two shapes:
//   - buildProviderMetadataResearchPrompt  — primary path. Researches all
//     incomplete models of a single provider in one call. Output is an array;
//     each entry is tagged with modelId so the dispatcher can apply patches
//     to the right row.
//   - buildSingleModelMetadataResearchPrompt — fallback. Used when the batch
//     call fails to parse, misses a model, or returns a hallucination-shaped
//     duplicate. Single-model focus reduces row-confusion risk.
//
// The slim system prompt lives in lib/ai/prompts/model-metadata-researcher.ts.
// Together they replace the old "researcher + model-metadata research"
// composition that bled multi-market commerce behaviour into model lookups.
// ---------------------------------------------------------------------------

interface ProviderResearchModel {
    modelId: string
    model: EffectiveModelEntry
}

interface ProviderResearchTargetInput {
    providerId: string
    providerName: string
    models: ProviderResearchModel[]
}

interface SingleModelResearchTargetInput {
    providerId: string
    modelId: string
    model: EffectiveModelEntry
}

const STABLE_ID_RULE = '^[a-zA-Z][a-zA-Z0-9_-]*$'
const KNOWN_THINKING_EXAMPLES = 'minimal, low, medium, high, xhigh, max'
const KNOWN_CAPABILITY_EXAMPLES = 'text, image, audio, video, pdf, google_search, code_execution, url_context, function_calling, mcp, file_search, computer_use'
const KNOWN_KIND_EXAMPLES = 'text, image, video, speech, music'

// ---------------------------------------------------------------------------
// Shared field-contract / preflight blocks. Both prompt shapes use them; the
// only difference is the JSON envelope (single vs. perModel array).
// ---------------------------------------------------------------------------

const FIELD_CONTRACT = [
    '<field_contract>',
    'pricing:',
    '- Required when official pricing exists.',
    '- Use tokens pricing for per-token/per-million-token API billing.',
    '- Use largeContextThreshold/inputPerMillionLarge/outputPerMillionLarge when pricing changes above a context threshold.',
    '- Use cachedInputPerMillion and/or token pricing tiers when official docs publish extra token-price dimensions such as cached input or multiple context thresholds.',
    '- Use unit pricing for images, videos, audio, speech, songs, jobs, requests, or provider-specific units.',
    '- Use subscription only when official docs say access is included in a flat plan/subscription and no per-unit price applies through this route.',
    '- If the provider has more than one pricing tier, encode tiers and explain selection rules in pricingNotes.',
    '',
    'contextWindow, maxOutputTokens, and knowledgeCutoff:',
    '- contextWindow is the maximum input/context window in tokens. Treat it as max input tokens when official docs use that wording.',
    '- maxOutputTokens is the maximum output/completion tokens in one response.',
    '- Return token counts as integers.',
    '- knowledgeCutoff is optional; return the official cutoff as a concise string only when docs publish one, such as "2025-10" or "October 2025".',
    '- For CLI wrappers, use official CLI docs first; if the CLI explicitly defers to the underlying model, use official underlying-model docs and say that in notes.',
    '- Omit contextWindow for non-text-only media models unless official docs give a meaningful text context window for that generation endpoint.',
    '',
    'thinkingLevels and defaultThinkingLevel:',
    '- thinkingLevels is an open list of official user-selectable reasoning/thinking effort identifiers.',
    `- Known examples are ${KNOWN_THINKING_EXAMPLES}; future official values are allowed if they match the stable-id rule.`,
    '- Prefer the exact provider/API/CLI parameter value when it is already a stable identifier. If docs only provide a label, convert it to a short stable id like "very_high".',
    '- Do not invent a generic "none", "off", "auto", "reasoning", "thinking", or "enabled" level unless official docs expose exactly that as a selectable level.',
    '- If docs only say thinking can be disabled, omit thinkingLevels or use the documented positive effort choices; do not add "none" as a UI option.',
    '- If the official control is numeric, token-budget based, or otherwise not a named effort choice, model it under features with type "number" or "enum" instead of forcing it into thinkingLevels.',
    '- defaultThinkingLevel must be one of the returned thinkingLevels.',
    '- If official docs clearly say the model has no user-selectable thinking/reasoning setting, return "thinkingLevels": [] and omit defaultThinkingLevel. If you cannot determine this from official docs, list thinkingLevels in unresolved.',
    '',
    'capabilities:',
    '- capabilities is an open list of stable ids describing concrete supported inputs, tool integrations, or runtime abilities.',
    `- Known examples are ${KNOWN_CAPABILITY_EXAMPLES}; new official capabilities are allowed when they are concrete and useful to route/render the model.`,
    '- Use precise ids. For example, prefer "google_search" over broad labels like "web" when the official feature is Google Search grounding.',
    '- Do not add generic marketing labels such as "chat", "vision", "reasoning", "streaming", "json", "multimodal", "fast", "smart", or "advanced".',
    '',
    'kinds:',
    '- kinds is an open list of stable ids for what the model generates as its primary output.',
    `- Known examples are ${KNOWN_KIND_EXAMPLES}; new official generation kinds are allowed if the product exposes a genuinely new output class.`,
    '- kinds describes output/generation kind, not every input modality.',
    '- Text/chat models use ["text"]. Image generators use ["image"]. Video generators use ["video"]. TTS/speech generators use ["speech"]. Music generators use ["music"].',
    '- Do not use "audio" as a generation kind when official behavior is more specific; use a stable id that describes the actual generated output.',
    '',
    'features:',
    '- Add only runtime-configurable options that the UI should expose for this model.',
    '- This is the adaptive UI contract: every official per-model setting the user may choose should be represented here so the Settings UI can render it without source edits.',
    '- Do not duplicate first-class fields as features. Named reasoning/thinking effort choices belong in thinkingLevels/defaultThinkingLevel, not in a feature such as thinking_level or reasoning_effort.',
    '- Use stable feature ids matching the stable-id rule, normally snake_case.',
    '- Use providerParam when official docs expose the request/CLI parameter name.',
    '- Supported UI control types are "boolean", "enum", "number", and "string". Choose the narrowest accurate control.',
    '- For dropdowns use type "enum" with options whose values are short stable strings when possible; if the provider requires exact non-stable parameter values, keep the official value and explain it in description or notes.',
    '- For booleans use type "boolean"; for numeric ranges include min/max/step/unit when official docs define them; for free-form provider strings use type "string" only when docs genuinely accept arbitrary strings.',
    '- Every feature MUST include a defaultValue equal to the provider\'s documented default (or the safest no-op when docs omit one). enum defaultValue must be one of its options. A feature with no default renders as a blank/broken control and leaves the orchestrator guessing.',
    '- Do not hard-code a setting into notes if it is selectable at runtime; model it as a feature.',
    '',
    'customMetadata:',
    '- Use customMetadata for official, useful model facts that do not fit a first-class field or a runtime feature, such as shutdown dates, cache discounts, batch/flex/priority pricing caveats, regional availability, rate-limit classes, or special billing dimensions.',
    '- Keep each item compact and structured: stable id, human label, scalar value, optional unit/category/description/sourceUrl.',
    '- Do not put runtime-selectable settings in customMetadata; those belong in features. Do not put primary token/unit pricing only in customMetadata; use pricing first.',
    '',
    'notes:',
    '- Use notes to state, in one line, what this model is for and any routing caveat, so the orchestrator knows when to pick it.',
    '</field_contract>',
].join('\n')

const FIELDS_OBJECT_SCHEMA = [
    '"fields"?: {',
    '  "pricing"?: { "kind": "tokens", "inputPerMillion": number, "outputPerMillion": number, "largeContextThreshold"?: number, "inputPerMillionLarge"?: number, "outputPerMillionLarge"?: number, "cachedInputPerMillion"?: number, "tiers"?: [{ "name": string, "threshold"?: number, "inputPerMillion"?: number, "outputPerMillion"?: number, "cachedInputPerMillion"?: number, "notes"?: string }] } | { "kind": "unit", "unit": string, "pricePerUnit"?: number, "currency"?: "$", "tiers"?: [{ "name": string, "unit"?: string, "pricePerUnit"?: number, "inputPerMillion"?: number, "outputPerMillion"?: number, "threshold"?: number, "notes"?: string }], "notes"?: string } | { "kind": "subscription" } | null,',
    '  "pricingNotes"?: string,',
    '  "contextWindow"?: number,',
    '  "maxOutputTokens"?: number,',
    '  "knowledgeCutoff"?: string,',
    '  "thinkingLevels"?: string[],',
    '  "defaultThinkingLevel"?: string,',
    '  "capabilities"?: string[],',
    '  "features"?: [',
    '    { "id": string, "label": string, "type": "boolean", "defaultValue"?: boolean, "description"?: string, "category"?: string, "providerParam"?: string } |',
    '    { "id": string, "label": string, "type": "enum", "defaultValue"?: string, "description"?: string, "category"?: string, "providerParam"?: string, "options": [{ "value": string, "label": string, "description"?: string }] } |',
    '    { "id": string, "label": string, "type": "number", "defaultValue"?: number, "min"?: number, "max"?: number, "step"?: number, "unit"?: string, "description"?: string, "category"?: string, "providerParam"?: string } |',
    '    { "id": string, "label": string, "type": "string", "defaultValue"?: string, "placeholder"?: string, "description"?: string, "category"?: string, "providerParam"?: string }',
    '  ],',
    '  "customMetadata"?: [{ "id": string, "label": string, "value": string | number | boolean, "unit"?: string, "category"?: string, "description"?: string, "sourceUrl"?: string }],',
    '  "intelligenceTier"?: string,',
    '  "kinds"?: string[],',
    '  "notes"?: string',
    '}',
].join('\n')

const PREFLIGHT = [
    '<preflight_before_final_json>',
    '- JSON parses with no comments, no trailing commas, no code fence.',
    `- Every thinkingLevels/defaultThinkingLevel, capabilities, kinds, intelligenceTier, feature id, customMetadata id, and unresolved field id matches ${STABLE_ID_RULE}.`,
    '- defaultThinkingLevel is included in thinkingLevels if both are present.',
    '- thinkingLevels does not include generic "none", "off", "auto", "reasoning", "thinking", or "enabled" unless an official selectable parameter uses that exact stable id.',
    '- Every feature has a defaultValue; for enum features the defaultValue is one of its options.value.',
    '- Stable ids are concrete provider/product facts, not unsupported marketing labels.',
    '- Every missing field is either filled or listed in unresolved.',
    '- Every filled fact has an official source URL in sources.',
    '</preflight_before_final_json>',
].join('\n')

function providerSpecificGuidance(providerId: string): string {
    if (providerId !== 'codex') return ''
    const productName = 'OpenAI Codex CLI'
    return [
        '<cli_provider_guidance>',
        `providerId "${providerId}" is a local CLI/subscription provider for ${productName}.`,
        'Do not treat this as a normal REST API model endpoint.',
        'Search official web docs for the CLI/product, official subscription/pricing pages, official changelogs/release notes, and official underlying model docs when the CLI documentation delegates model facts to the underlying model.',
        'For pricing, distinguish clearly between subscription access, included usage, and any extra metered usage. Do not copy API pricing unless official CLI docs say the CLI route is API-token billed.',
        'For context window and thinking levels, use official CLI docs first; if they are silent, use official underlying model docs and state that dependency in notes.',
        '</cli_provider_guidance>',
    ].join('\n')
}

function compactModelSnapshot(model: EffectiveModelEntry) {
    return {
        displayName: model.name,
        kinds: model.kinds,
        contextWindow: model.contextWindow || null,
        maxOutputTokens: model.maxOutputTokens || null,
        knowledgeCutoff: model.knowledgeCutoff ?? null,
        pricing: model.pricing,
        pricingNotes: model.pricingNotes ?? null,
        capabilities: model.capabilities,
        features: model.features,
        customMetadata: model.customMetadata,
        thinkingLevels: model.thinkingLevels ?? null,
        defaultThinkingLevel: model.defaultThinkingLevel ?? null,
        notes: model.notes ?? null,
        missingFields: model.missingFields,
    }
}

// ---------------------------------------------------------------------------
// Per-provider batch prompt (primary path).
// ---------------------------------------------------------------------------

export function buildProviderMetadataResearchPrompt(target: ProviderResearchTargetInput): string {
    const currentEntries = target.models.map(({ modelId, model }) => ({
        providerId: target.providerId,
        modelId,
        ...compactModelSnapshot(model),
    }))

    const modelIdsLine = target.models.map(m => `"${m.modelId}"`).join(', ')

    return [
        '<provider_metadata_research_task>',
        `Update metadata for ${target.models.length} model(s) of provider "${target.providerId}" (${target.providerName}) in one research pass.`,
        'The provider may have additional models beyond this batch — research ONLY the modelIds listed in current_registry_entries. If you encounter other model names on official pages, ignore them: do not investigate them, do not include them in your output, and do not flag them as unresolved.',
        `The registry accepts open, future-proof stable identifiers matching ${STABLE_ID_RULE}. Do not force new official values into an old vocabulary just because they are new.`,
        '',
        '<research_workflow>',
        `1. Identify the provider's official product surface(s) for these models: providerId "${target.providerId}", ${target.models.length} model(s) listed below.`,
        '2. Fetch the official documentation page(s) and the official pricing page once, then reuse them across all models in this batch — do not re-fetch the same page for each model.',
        '3. For each model in this batch, locate the EXACT model name/id on the source pages before extracting numbers. If a model name does not appear on the fetched pages, search for it specifically before declaring it unresolved.',
        '4. Do not rely on model-list API metadata for pricing. Model-list endpoints are discovery signals, not pricing authority.',
        '5. For each model, fill missingFields when an official source exists; otherwise list each gap in that model\'s unresolved.',
        '6. Prefer exact current docs over older release posts. If sources disagree, use the newest official source and mention the conflict in that model\'s notes.',
        '7. Keep results narrow. Add official selectable controls and factual metadata, but do not invent broad marketing claims.',
        '8. In addition to missingFields, opportunistically fill officially documented knowledgeCutoff, maximum input/context tokens, maximum output tokens, pricing tiers, thinking levels, and runtime-configurable features when the source is clear.',
        '</research_workflow>',
        '',
        '<anti_hallucination_rules>',
        '- These models are listed together so you can amortize one page-fetch across all of them. They are NOT one unit. Each model gets its own values.',
        '- Never copy a value from one model to another in this batch just because they appear on the same page.',
        '- If two models in this batch share the same documented pricing/context-window/etc on the official page, that is fine — but you must verify each independently by reading the row labelled with that model\'s exact name. Note explicitly in your output if you confirmed the shared value by separate reads.',
        '- If you cannot find an explicit row/section/entry for a given modelId on the official pages, return that model with status "insufficient" instead of guessing from neighbours.',
        `- Input modelIds you must address (each one independently): ${modelIdsLine}.`,
        '- Every perModel entry MUST echo back the providerId and modelId you were given. Do not invent modelIds; do not rename them.',
        '</anti_hallucination_rules>',
        '',
        '<official_source_rules>',
        '- Accepted: official provider docs/pricing/release notes/model pages, official GitHub repos owned by the provider for CLI docs, official product help centers.',
        '- Rejected: blogs, Reddit, forum posts, GitHub issues from users, benchmark sites, pricing aggregators, copied model cards, docs mirrors.',
        '- sources must include URLs for facts you return; include title and publisher when the official source publishes them.',
        '- If you cannot find an official source for a missing field, do not guess. Put it in the model\'s unresolved.',
        '</official_source_rules>',
        '',
        providerSpecificGuidance(target.providerId),
        '',
        FIELD_CONTRACT,
        '',
        '<json_schema>',
        'Return exactly one JSON object and no markdown:',
        '{',
        '  "status": "found" | "partial" | "insufficient",',
        '  "summary"?: string,',
        '  "perModel": [',
        '    {',
        '      "providerId": string,',
        '      "modelId": string,',
        '      "status": "found" | "insufficient",',
        '      "summary"?: string,',
        '      ' + FIELDS_OBJECT_SCHEMA.replace(/\n/g, '\n      ') + ',',
        '      "sources"?: [{ "title"?: string, "url": string, "publisher"?: string }],',
        '      "unresolved"?: [{ "field": string, "reason"?: string }]',
        '    }',
        '  ],',
        '  "sources"?: [{ "title"?: string, "url": string, "publisher"?: string }]',
        '}',
        '',
        'Notes:',
        '- The top-level "sources" lists pages shared across the batch (e.g. the provider\'s pricing page that covered multiple models). Per-model "sources" lists pages used specifically for that one model.',
        '- "perModel" MUST contain exactly one entry per input modelId, with providerId/modelId echoed verbatim. If a model could not be found at all, still include its entry with status "insufficient" and an unresolved list.',
        '- Top-level "status" is "found" when every perModel entry is "found", "partial" when some are "insufficient", and "insufficient" only when none were found.',
        '</json_schema>',
        '',
        PREFLIGHT,
        '',
        '<current_registry_entries>',
        JSON.stringify(currentEntries, null, 2),
        '</current_registry_entries>',
        '</provider_metadata_research_task>',
    ].filter(Boolean).join('\n')
}

// ---------------------------------------------------------------------------
// Single-model fallback prompt. Used when the batch path fails to deliver a
// model (parse error, missing entry, suspicious duplicate).
// ---------------------------------------------------------------------------

export function buildSingleModelMetadataResearchPrompt(target: SingleModelResearchTargetInput): string {
    const current = {
        providerId: target.providerId,
        modelId: target.modelId,
        ...compactModelSnapshot(target.model),
    }

    return [
        '<model_metadata_research_task>',
        'You are updating one model entry in Orchestrator\'s local model registry.',
        'Your job is to research the current official metadata for this exact model and return a machine-validated JSON object only.',
        `The registry accepts open, future-proof stable identifiers matching ${STABLE_ID_RULE}. Do not force new official values into an old vocabulary just because they are new.`,
        '',
        '<research_workflow>',
        '1. Identify the exact product route: providerId, modelId, displayName, and whether this is an API model, a media model, or a local CLI/subscription wrapper.',
        '2. Search official sources only: provider docs, API docs, official pricing pages, official release notes, official model cards, or official CLI/product docs.',
        '3. Do not rely on model-list API metadata for pricing. Model-list endpoints are discovery signals, not pricing authority.',
        '4. For every field in current_registry_entry.missingFields, either return a sourced value in fields or add an unresolved item with the reason.',
        '5. Prefer exact current docs over older release posts. If sources disagree, use the newest official source and mention the conflict in notes.',
        '6. Keep the result narrow. Add official selectable controls and factual metadata, but do not add broad marketing claims or speculative settings just because docs mention them.',
        '7. In addition to missingFields, opportunistically fill officially documented knowledgeCutoff, maximum input/context tokens, maximum output tokens, pricing tiers, thinking levels, and runtime-configurable features when the source is clear.',
        '</research_workflow>',
        '',
        '<official_source_rules>',
        '- Accepted: official provider docs/pricing/release notes/model pages, official GitHub repos owned by the provider for CLI docs, official product help centers.',
        '- Rejected: blogs, Reddit, forum posts, GitHub issues from users, benchmark sites, pricing aggregators, copied model cards, docs mirrors.',
        '- sources must include URLs for facts you return; include title and publisher when the official source publishes them.',
        '- If you cannot find an official source for a missing field, do not guess. Put it in unresolved.',
        '</official_source_rules>',
        '',
        providerSpecificGuidance(target.providerId),
        '',
        FIELD_CONTRACT,
        '',
        '<json_schema>',
        'Return exactly one JSON object and no markdown:',
        '{',
        '  "status": "found" | "insufficient",',
        '  "summary"?: string,',
        '  ' + FIELDS_OBJECT_SCHEMA.replace(/\n/g, '\n  ') + ',',
        '  "sources"?: [{ "title"?: string, "url": string, "publisher"?: string }],',
        '  "unresolved"?: [{ "field": string, "reason"?: string }]',
        '}',
        '</json_schema>',
        '',
        PREFLIGHT,
        '',
        '<current_registry_entry>',
        JSON.stringify(current, null, 2),
        '</current_registry_entry>',
        '</model_metadata_research_task>',
    ].filter(Boolean).join('\n')
}
