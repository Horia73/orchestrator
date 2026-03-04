import { agent as orchestratorAgent } from './orchestrator/index.js';
import { agent as codingAgent } from './coding/index.js';
import { agent as imageAgent } from './image/index.js';
import { agent as multipurposeAgent } from './multipurpose/index.js';
import { agent as researcherAgent } from './researcher/index.js';
import { agent as browserAgent } from './browser/index.js';

const loadedAgents = [
    orchestratorAgent,
    codingAgent,
    imageAgent,
    multipurposeAgent,
    researcherAgent,
    browserAgent,
].filter(Boolean);

function sortAgents(a, b) {
    if (a.isDefault && !b.isDefault) return -1;
    if (!a.isDefault && b.isDefault) return 1;
    return a.id.localeCompare(b.id);
}

const CONFIGURABLE_AGENT_DEFINITIONS = loadedAgents.sort(sortAgents);
const RUNTIME_AGENT_DEFINITIONS = CONFIGURABLE_AGENT_DEFINITIONS
    .filter((agentDef) => agentDef.chatSelectable !== false)
    .sort(sortAgents);

const AGENT_DEFINITION_BY_ID = new Map(
    RUNTIME_AGENT_DEFINITIONS.map((agentDef) => [agentDef.id, agentDef]),
);
const CONFIGURABLE_AGENT_DEFINITION_BY_ID = new Map(
    CONFIGURABLE_AGENT_DEFINITIONS.map((agentDef) => [agentDef.id, agentDef]),
);

const DEFAULT_AGENT = RUNTIME_AGENT_DEFINITIONS.find((a) => a.isDefault) ?? RUNTIME_AGENT_DEFINITIONS[0];
export const DEFAULT_AGENT_ID = DEFAULT_AGENT?.id ?? 'orchestrator';

function normalizeModel(value, fallback) {
    const normalized = String(value ?? '').trim();
    return normalized || fallback;
}

function normalizeThinkingLevel(value, fallback) {
    const normalized = String(value ?? '').trim().toUpperCase();
    if (normalized) {
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
    return [...RUNTIME_AGENT_DEFINITIONS];
}

export function createDefaultSettings() {
    const helpers = getNormalizeHelpers();
    const defaults = {};

    for (const agentDef of CONFIGURABLE_AGENT_DEFINITIONS) {
        defaults[agentDef.id] = agentDef.createDefaultConfig(helpers);
    }

    return defaults;
}

export function sanitizeAgentSettings(rawSettings) {
    const source = rawSettings && typeof rawSettings === 'object' ? rawSettings : {};
    const helpers = getNormalizeHelpers();
    const normalized = {};

    for (const agentDef of CONFIGURABLE_AGENT_DEFINITIONS) {
        normalized[agentDef.id] = agentDef.normalizeConfig(source[agentDef.id], helpers);
    }

    return normalized;
}

export function listClientAgentDefinitions() {
    return CONFIGURABLE_AGENT_DEFINITIONS.map((agentDef) => agentDef.toClientDefinition());
}

export function getAgentToolAccess(agentId = DEFAULT_AGENT_ID) {
    const agentDef = getAgentDefinition(agentId);
    return Array.isArray(agentDef?.toolAccess) ? [...agentDef.toolAccess] : [];
}
