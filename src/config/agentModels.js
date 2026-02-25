/**
 * Centralized agent & model configuration.
 *
 * To add a new agent (e.g. "Coding Agent"), just push another entry
 * into AGENT_DEFINITIONS with a unique `id`, display `name`, `icon`,
 * and its own `defaultModel` + `defaultThinkingLevel`.
 */

// ─── Thinking Levels ───────────────────────────────────────────────────────
export const THINKING_LEVELS = [
    {
        id: 'MINIMAL',
        label: 'Minimal',
        description: 'Fastest responses, least reasoning',
        color: '#7A766D',
    },
    {
        id: 'LOW',
        label: 'Low',
        description: 'Quick with light reasoning',
        color: '#6B9E78',
    },
    {
        id: 'MEDIUM',
        label: 'Medium',
        description: 'Balanced speed and depth',
        color: '#D4964E',
    },
    {
        id: 'HIGH',
        label: 'High',
        description: 'Deepest reasoning, slowest',
        color: '#C45A3C',
    },
];

// ─── Known Gemini Models & Pricing ─────────────────────────────────────────
// This is used to enrich the dynamic models fetched from the API with known
// tier details and pricing data.
const KNOWN_MODELS_DATA = {
    'models/gemini-3.1-pro-preview': {
        tier: 'pro',
        description: 'Latest performance, intelligence, and usability improvements',
        inputPrice200k: 2.00,
        inputPriceOver200k: 4.00,
        outputPrice200k: 12.00,
        outputPriceOver200k: 18.00,
    },
    'models/gemini-3-pro-preview': {
        tier: 'pro',
        description: 'Best model for multimodal understanding & agentic capabilities',
        inputPrice200k: 2.00,
        inputPriceOver200k: 4.00,
        outputPrice200k: 12.00,
        outputPriceOver200k: 18.00,
    },
    'models/gemini-3-flash-preview': {
        tier: 'flash',
        description: 'Frontier intelligence with superior search and grounding',
        inputPrice200k: 0.50,
        outputPrice200k: 3.00,
    },
    'models/gemini-2.5-pro': {
        tier: 'pro',
        description: 'Excels at coding and complex reasoning tasks',
        inputPrice200k: 1.25,
        inputPriceOver200k: 2.50,
        outputPrice200k: 10.00,
        outputPriceOver200k: 15.00,
    },
    'models/gemini-2.5-flash': {
        tier: 'flash',
        description: 'Hybrid reasoning model with 1M token context & thinking budgets',
        inputPrice200k: 0.30,
        outputPrice200k: 2.50,
    },
    'models/gemini-2.5-flash-lite': {
        tier: 'flash-lite',
        description: 'Smallest and most cost-effective model for at-scale usage',
        inputPrice200k: 0.10,
        outputPrice200k: 0.40,
    },
    'models/gemini-2.0-flash': {
        tier: 'flash',
        description: 'Balanced multimodal model for the era of Agents',
        inputPrice200k: 0.10,
        outputPrice200k: 0.40,
    },
    'models/gemini-2.0-flash-lite': {
        tier: 'flash-lite',
        description: 'Smallest model, built for at-scale usage',
        inputPrice200k: 0.075,
        outputPrice200k: 0.30,
    },
};

export const GEMINI_DEFAULT_MODEL = 'gemini-3-flash-preview';

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Merges the dynamic list of models from the API with our known robust data. */
export function buildMergedModels(apiModels = []) {
    const rawList = apiModels.map((m) => {
        const idStr = m.name; // e.g. "models/gemini-2.5-pro"
        const friendlyId = idStr.replace('models/', '');
        const meta = KNOWN_MODELS_DATA[idStr] || {};

        // Try guessing tier if metadata is missing
        let tier = meta.tier || 'standard';
        if (!meta.tier) {
            if (idStr.includes('pro')) tier = 'pro';
            else if (idStr.includes('flash-lite')) tier = 'flash-lite';
            else if (idStr.includes('flash')) tier = 'flash';
        }

        return {
            id: friendlyId,
            fullName: m.name,
            displayName: m.displayName || friendlyId,
            description: meta.description || m.description || 'No description available',
            tier,
            inputPrice200k: meta.inputPrice200k,
            inputPriceOver200k: meta.inputPriceOver200k,
            outputPrice200k: meta.outputPrice200k,
            outputPriceOver200k: meta.outputPriceOver200k,
        };
    });

    // Make known models appear first, matching our order above, then append others backwards
    const knownKeys = Object.keys(KNOWN_MODELS_DATA).map(k => k.replace('models/', ''));

    rawList.sort((a, b) => {
        const idxA = knownKeys.indexOf(a.id);
        const idxB = knownKeys.indexOf(b.id);

        if (idxA !== -1 && idxB !== -1) return idxA - idxB;
        if (idxA !== -1) return -1;
        if (idxB !== -1) return 1;
        // both unknown, arbitrary alphabetical
        return b.id.localeCompare(a.id);
    });

    return rawList;
}

/** Tier badge color */
export function tierColor(tier) {
    switch (tier) {
        case 'pro': return '#C45A3C';
        case 'flash': return '#D4964E';
        case 'flash-lite': return '#6B9E78';
        default: return '#7A766D';
    }
}

// ─── Agent Definitions ─────────────────────────────────────────────────────
export const AGENT_DEFINITIONS = [
    {
        id: 'orchestrator',
        name: 'Orchestrator',
        description: 'The primary agent that plans, delegates, and synthesizes answers.',
        icon: '🧠',
        defaultModel: GEMINI_DEFAULT_MODEL,
        defaultThinkingLevel: 'MINIMAL',
    },
];
