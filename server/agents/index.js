import { agent as orchestratorAgent } from './orchestrator/index.js';
import { agent as codingAgent } from './coding/index.js';
import { agent as imageAgent } from './image/index.js';

const VALID_THINKING_LEVELS = new Set(['MINIMAL', 'LOW', 'MEDIUM', 'HIGH']);

const loadedAgents = [orchestratorAgent, codingAgent, imageAgent].filter(Boolean);

// Default agent first, then alphabetically by ID
const AGENT_DEFINITIONS = loadedAgents.sort((a, b) => {
    if (a.isDefault && !b.isDefault) return -1;
    if (!a.isDefault && b.isDefault) return 1;
    return a.id.localeCompare(b.id);
});

const AGENT_DEFINITION_BY_ID = new Map(
    AGENT_DEFINITIONS.map((agentDef) => [agentDef.id, agentDef]),
);

const DEFAULT_AGENT = AGENT_DEFINITIONS.find((a) => a.isDefault) ?? AGENT_DEFINITIONS[0];
export const DEFAULT_AGENT_ID = DEFAULT_AGENT?.id ?? 'orchestrator';

function normalizeModel(value, fallback) {
    const normalized = String(value ?? '').trim();
    return normalized || fallback;
}

function normalizeThinkingLevel(value, fallback) {
    const normalized = String(value ?? '').trim().toUpperCase();
    if (VALID_THINKING_LEVELS.has(normalized)) {
        return normalized;
    }

    return fallback;
}

function normalizeGrounding(value, fallback = {}) {
    const webSearchFallback = fallback.webSearch === true;
    const imageSearchFallback = fallback.imageSearch === true;
    const raw = value && typeof value === 'object' ? value : {};
    const webSearch = raw.webSearch === undefined ? webSearchFallback : raw.webSearch === true;
    const imageSearch = raw.imageSearch === undefined ? imageSearchFallback : raw.imageSearch === true;

    return {
        webSearch,
        imageSearch: webSearch ? imageSearch : false,
    };
}

function getNormalizeHelpers() {
    return {
        normalizeModel,
        normalizeThinkingLevel,
        normalizeGrounding,
    };
}

export function normalizeAgentId(value) {
    const normalized = String(value ?? '').trim().toLowerCase();
    if (AGENT_DEFINITION_BY_ID.has(normalized)) {
        return normalized;
    }

    return DEFAULT_AGENT_ID;
}

export function getAgentDefinition(agentId = DEFAULT_AGENT_ID) {
    const normalizedAgentId = normalizeAgentId(agentId);
    return AGENT_DEFINITION_BY_ID.get(normalizedAgentId) ?? AGENT_DEFINITION_BY_ID.get(DEFAULT_AGENT_ID);
}

export function listAgentDefinitions() {
    return [...AGENT_DEFINITIONS];
}

export function createDefaultSettings() {
    const helpers = getNormalizeHelpers();
    const defaults = {};

    for (const agentDef of AGENT_DEFINITIONS) {
        defaults[agentDef.id] = agentDef.createDefaultConfig(helpers);
    }

    return defaults;
}

export function sanitizeAgentSettings(rawSettings) {
    const source = rawSettings && typeof rawSettings === 'object' ? rawSettings : {};
    const helpers = getNormalizeHelpers();
    const normalized = {};

    for (const agentDef of AGENT_DEFINITIONS) {
        normalized[agentDef.id] = agentDef.normalizeConfig(source[agentDef.id], helpers);
    }

    return normalized;
}

export function listClientAgentDefinitions() {
    return AGENT_DEFINITIONS.map((agentDef) => agentDef.toClientDefinition());
}

export function getAgentToolAccess(agentId = DEFAULT_AGENT_ID) {
    const agentDef = getAgentDefinition(agentId);
    return Array.isArray(agentDef?.toolAccess) ? [...agentDef.toolAccess] : [];
}
