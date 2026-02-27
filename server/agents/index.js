import { imageAgent } from './image/index.js';
import { codingAgent } from './coding/index.js';
import { ORCHESTRATOR_AGENT_ID, orchestratorAgent } from './orchestrator/index.js';

const VALID_THINKING_LEVELS = new Set(['MINIMAL', 'LOW', 'MEDIUM', 'HIGH']);

const AGENT_DEFINITIONS = [
    orchestratorAgent,
    codingAgent,
    imageAgent,
];

const AGENT_DEFINITION_BY_ID = new Map(
    AGENT_DEFINITIONS.map((agent) => [agent.id, agent]),
);

export const DEFAULT_AGENT_ID = ORCHESTRATOR_AGENT_ID;

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

    for (const agent of AGENT_DEFINITIONS) {
        defaults[agent.id] = agent.createDefaultConfig(helpers);
    }

    return defaults;
}

export function sanitizeAgentSettings(rawSettings) {
    const source = rawSettings && typeof rawSettings === 'object' ? rawSettings : {};
    const helpers = getNormalizeHelpers();
    const normalized = {};

    for (const agent of AGENT_DEFINITIONS) {
        normalized[agent.id] = agent.normalizeConfig(source[agent.id], helpers);
    }

    return normalized;
}

export function listClientAgentDefinitions() {
    return AGENT_DEFINITIONS.map((agent) => agent.toClientDefinition());
}

export function getAgentToolAccess(agentId = DEFAULT_AGENT_ID) {
    const agent = getAgentDefinition(agentId);
    return Array.isArray(agent?.toolAccess) ? [...agent.toolAccess] : [];
}
