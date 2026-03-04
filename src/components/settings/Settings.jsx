import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { tierColor } from '../../config/agentModels.js';
import { fetchRemoteModels } from '../../api/settingsApi.js';
import { IconClose, IconSearch, IconSettings } from '../shared/icons.jsx';
import { UsageDashboard } from './UsageDashboard.jsx';
import { SystemLogsDashboard } from './SystemLogsDashboard.jsx';
import { UpdatesPanel } from './UpdatesPanel.jsx';
import { SkillsPanel } from './SkillsPanel.jsx';
import { FilesEditorPanel } from './FilesEditorPanel.jsx';
import { McpPanel } from './McpPanel.jsx';
import './Settings.css';

const THINKING_PRESET_COLORS = {
    MINIMAL: '#7A766D',
    LOW: '#6B9E78',
    MEDIUM: '#D4964E',
    HIGH: '#C45A3C',
    OFF: '#7A766D',
    DYNAMIC: '#4C7A9A',
};
const THINKING_PRESET_COLOR_FALLBACKS = ['#6B9E78', '#D4964E', '#C45A3C', '#4C7A9A', '#7C91C7'];

/* ─── Model Dropdown ─────────────────────────────────────────────────── */

function normalizeModelRef(value) {
    const raw = String(value ?? '').trim();
    if (!raw) {
        return '';
    }

    return raw.startsWith('models/') ? raw.slice('models/'.length) : raw;
}

function matchesModelRef(model, selectedModelId) {
    const target = normalizeModelRef(selectedModelId);
    if (!target) {
        return false;
    }

    return (
        normalizeModelRef(model?.id) === target
        || normalizeModelRef(model?.fullName) === target
    );
}

function isRollingAliasModel(modelOrId) {
    const id = normalizeModelRef(
        typeof modelOrId === 'string'
            ? modelOrId
            : (modelOrId?.id ?? modelOrId?.fullName),
    ).toLowerCase();

    return Boolean(id) && /(?:^|-)latest(?:$|-)/.test(id);
}

function getModelByRef(modelsList, modelId) {
    return (Array.isArray(modelsList) ? modelsList : []).find((model) => matchesModelRef(model, modelId)) ?? null;
}

function compareModelsByFreshness(left, right) {
    const rollingAliasDelta = Number(isRollingAliasModel(left)) - Number(isRollingAliasModel(right));
    if (rollingAliasDelta !== 0) {
        return rollingAliasDelta;
    }

    const releaseDelta = Number(right?.releaseTimestamp ?? 0) - Number(left?.releaseTimestamp ?? 0);
    if (releaseDelta !== 0) {
        return releaseDelta;
    }

    const versionDelta = Number(right?.versionRank ?? 0) - Number(left?.versionRank ?? 0);
    if (versionDelta !== 0) {
        return versionDelta;
    }

    return String(left?.displayName ?? '').localeCompare(String(right?.displayName ?? ''));
}

function getCompatibleModels(modelsList, agentId) {
    const normalizedAgentId = String(agentId ?? '').trim().toLowerCase();
    return (Array.isArray(modelsList) ? modelsList : [])
        .filter((model) => {
            if (String(model?.status ?? '').trim().toLowerCase() === 'retired') {
                return false;
            }

            const allowedAgentIds = Array.isArray(model?.allowedAgentIds) ? model.allowedAgentIds : [];
            if (allowedAgentIds.length === 0) {
                return true;
            }

            return allowedAgentIds.includes(normalizedAgentId);
        })
        .sort(compareModelsByFreshness);
}

function getThinkingPresets(model) {
    return Array.isArray(model?.thinkingPresets) ? model.thinkingPresets : [];
}

function getThinkingPresetColor(preset, index = 0) {
    const presetId = String(preset?.id ?? '').trim().toUpperCase();
    if (presetId && THINKING_PRESET_COLORS[presetId]) {
        return THINKING_PRESET_COLORS[presetId];
    }

    const thinkingLevel = String(preset?.thinkingLevel ?? '').trim().toUpperCase();
    if (thinkingLevel && THINKING_PRESET_COLORS[thinkingLevel]) {
        return THINKING_PRESET_COLORS[thinkingLevel];
    }

    return THINKING_PRESET_COLOR_FALLBACKS[index % THINKING_PRESET_COLOR_FALLBACKS.length];
}

function formatThinkingMissingLabel(model) {
    if (model?.thinkingVerified === true) {
        return '';
    }

    if (model?.thinkingMode === 'none') {
        return 'Thinking support is explicitly disabled for this model.';
    }

    return 'Thinking presets have not been verified yet.';
}

function formatMissingCatalogFields(model) {
    const missing = [];
    if (model?.pricingVerified !== true) {
        missing.push('pricing');
    }
    if (model?.thinkingVerified !== true) {
        missing.push('thinking');
    }
    return missing;
}

function resolveThinkingPreset(model, preferredPresetId, fallbackPresetId = '') {
    if (!model || model.catalogComplete !== true) {
        return String(preferredPresetId ?? '').trim().toUpperCase();
    }

    if (model.thinkingMode === 'none' || model.thinkingSupported !== true) {
        return '';
    }

    const presets = getThinkingPresets(model);
    if (presets.length === 0) {
        return '';
    }

    const preferredIds = [
        preferredPresetId,
        fallbackPresetId,
        model.defaultThinkingPreset,
    ]
        .map((value) => String(value ?? '').trim().toUpperCase())
        .filter(Boolean);

    for (const presetId of preferredIds) {
        const directMatch = presets.find((preset) => preset.id === presetId);
        if (directMatch) {
            return directMatch.id;
        }

        const levelMatch = presets.find(
            (preset) => String(preset?.thinkingLevel ?? '').trim().toUpperCase() === presetId,
        );
        if (levelMatch) {
            return levelMatch.id;
        }
    }

    return presets.find((preset) => preset.default === true)?.id
        || String(model.defaultThinkingPreset ?? '').trim().toUpperCase()
        || presets[0]?.id
        || '';
}

function normalizeAgentStateForCatalog(agent, state, modelsList) {
    const fallbackState = state && typeof state === 'object' ? state : {};
    const compatibleModels = getCompatibleModels(modelsList, agent.id);
    const selectedModel = compatibleModels.find((model) => matchesModelRef(model, fallbackState.model))
        ?? compatibleModels.find((model) => matchesModelRef(model, agent.defaultModel))
        ?? compatibleModels[0]
        ?? null;

    const normalizedGrounding = agent.supportsGrounding
        ? {
            webSearch: fallbackState?.grounding?.webSearch === true,
            imageSearch: fallbackState?.grounding?.imageSearch === true && fallbackState?.grounding?.webSearch === true,
        }
        : undefined;

    let thinkingLevel = String(
        fallbackState.thinkingLevel
        ?? agent.defaultThinkingLevel
        ?? '',
    ).trim().toUpperCase();

    if (agent.supportsThinking !== false && selectedModel?.thinkingVerified === true) {
        thinkingLevel = resolveThinkingPreset(selectedModel, thinkingLevel, agent.defaultThinkingLevel);
    }

    return {
        model: normalizeModelRef(selectedModel?.id ?? fallbackState.model ?? agent.defaultModel),
        thinkingLevel,
        grounding: normalizedGrounding,
    };
}

function agentStatesEqual(left, right) {
    const leftGrounding = left?.grounding ?? {};
    const rightGrounding = right?.grounding ?? {};

    return (
        normalizeModelRef(left?.model) === normalizeModelRef(right?.model)
        && String(left?.thinkingLevel ?? '').trim().toUpperCase() === String(right?.thinkingLevel ?? '').trim().toUpperCase()
        && (leftGrounding.webSearch === true) === (rightGrounding.webSearch === true)
        && (leftGrounding.imageSearch === true) === (rightGrounding.imageSearch === true)
    );
}

function formatPriceAmount(value, decimals = 2) {
    return `$${Number(value).toFixed(decimals)}`;
}

function buildPricingRows(model) {
    const pricingRows = [];

    if (Number.isFinite(model?.inputPrice200k)) {
        pricingRows.push({
            label: 'Input:',
            value: `${formatPriceAmount(model.inputPrice200k)} / 1M tokens`,
        });
    }
    if (Number.isFinite(model?.inputPriceOver200k) && model.inputPriceOver200k !== model.inputPrice200k) {
        pricingRows.push({
            label: 'Input (>200k tokens):',
            value: `${formatPriceAmount(model.inputPriceOver200k)} / 1M tokens`,
        });
    }
    if (Number.isFinite(model?.outputPrice200k)) {
        pricingRows.push({
            label: 'Output:',
            value: `${formatPriceAmount(model.outputPrice200k)} / 1M tokens`,
        });
    }
    if (Number.isFinite(model?.outputPriceOver200k) && model.outputPriceOver200k !== model.outputPrice200k) {
        pricingRows.push({
            label: 'Output (>200k tokens):',
            value: `${formatPriceAmount(model.outputPriceOver200k)} / 1M tokens`,
        });
    }
    if (Number.isFinite(model?.outputTextPrice200k) && model.outputTextPrice200k !== model.outputPrice200k) {
        pricingRows.push({
            label: 'Output text/thinking:',
            value: `${formatPriceAmount(model.outputTextPrice200k)} / 1M tokens`,
        });
    }
    if (Number.isFinite(model?.outputImagePricePerImage)) {
        pricingRows.push({
            label: 'Output image:',
            value: `${formatPriceAmount(model.outputImagePricePerImage, 3)} / image`,
        });
    }
    if (Number.isFinite(model?.outputImagePrice1K)) {
        pricingRows.push({
            label: 'Output image (1K):',
            value: `${formatPriceAmount(model.outputImagePrice1K, 3)} / image`,
        });
    }
    if (Number.isFinite(model?.outputImagePrice2K)) {
        pricingRows.push({
            label: 'Output image (2K):',
            value: `${formatPriceAmount(model.outputImagePrice2K, 3)} / image`,
        });
    }
    if (Number.isFinite(model?.outputImagePrice4K)) {
        pricingRows.push({
            label: 'Output image (4K):',
            value: `${formatPriceAmount(model.outputImagePrice4K, 3)} / image`,
        });
    }
    if (Number.isFinite(model?.outputAudioPrice)) {
        pricingRows.push({
            label: 'Output audio:',
            value: `${formatPriceAmount(model.outputAudioPrice)} / 1M audio tokens`,
        });
    }
    if (Number.isFinite(model?.outputPricePerSecond)) {
        pricingRows.push({
            label: 'Output video:',
            value: `${formatPriceAmount(model.outputPricePerSecond)} / second`,
        });
    }
    if (Number.isFinite(model?.pricePerQuery)) {
        pricingRows.push({
            label: 'Per query:',
            value: `${formatPriceAmount(model.pricePerQuery, 3)} / query`,
        });
    }
    if (Number.isFinite(model?.groundingPricePer1k)) {
        pricingRows.push({
            label: 'Grounding:',
            value: `${formatPriceAmount(model.groundingPricePer1k)} / 1K requests`,
        });
    }

    return pricingRows;
}

function buildPriceSummary(model) {
    if (!model) {
        return '';
    }

    if (Number.isFinite(model.pricePerQuery)) {
        return `${formatPriceAmount(model.pricePerQuery, 3)} / query`;
    }

    if (Number.isFinite(model.outputPricePerSecond)) {
        return `${formatPriceAmount(model.outputPricePerSecond)} / sec`;
    }

    if (Number.isFinite(model.outputImagePricePerImage)) {
        return `${formatPriceAmount(model.outputImagePricePerImage, 3)} / image`;
    }

    if (Number.isFinite(model.outputImagePrice1K)) {
        return `From ${formatPriceAmount(model.outputImagePrice1K, 3)} / image`;
    }

    if (Number.isFinite(model.inputPrice200k) && Number.isFinite(model.outputPrice200k)) {
        return `In ${formatPriceAmount(model.inputPrice200k)} / Out ${formatPriceAmount(model.outputPrice200k)}`;
    }

    if (Number.isFinite(model.inputPrice200k)) {
        return `${formatPriceAmount(model.inputPrice200k)} / 1M input`;
    }

    if (Number.isFinite(model.outputPrice200k)) {
        return `${formatPriceAmount(model.outputPrice200k)} / 1M output`;
    }

    if (Number.isFinite(model.outputAudioPrice)) {
        return `${formatPriceAmount(model.outputAudioPrice)} / 1M audio`;
    }

    return '';
}

function formatSourceUrlLabel(url) {
    try {
        const parsed = new URL(url);
        return parsed.pathname.replace(/\/$/, '') || parsed.hostname;
    } catch {
        return url;
    }
}

function formatTokenCount(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return '';
    }

    return `${new Intl.NumberFormat('en-US').format(parsed)} tokens`;
}

function formatThinkingModeSummary(model) {
    if (model?.thinkingVerified !== true) {
        return '';
    }

    if (model?.thinkingMode === 'level') {
        return 'Level-based thinking';
    }

    if (model?.thinkingMode === 'budget') {
        return 'Budget-based thinking';
    }

    if (model?.thinkingMode === 'none') {
        return 'Thinking not supported';
    }

    return '';
}

function humanizeMethod(method) {
    const normalized = String(method ?? '').trim();
    const knownMethods = {
        batchGenerateContent: 'Batch generation',
        bidiGenerateContent: 'Live audio',
        countTokens: 'Token counting',
        createCachedContent: 'Prompt caching',
        embedContent: 'Embeddings',
        generateContent: 'Text generation',
        predict: 'Media generation',
        predictLongRunning: 'Long-running generation',
    };

    return knownMethods[normalized] ?? normalized;
}

function buildCapabilityRows(model, agent, agentState) {
    if (!model) {
        return [];
    }

    const rows = [];
    const thinkingSummary = formatThinkingModeSummary(model);
    if (thinkingSummary) {
        rows.push({
            label: 'Thinking:',
            value: thinkingSummary,
        });
    }

    const presets = getThinkingPresets(model)
        .map((preset) => String(preset?.label ?? preset?.id ?? '').trim())
        .filter(Boolean);
    if (presets.length > 0) {
        rows.push({
            label: 'Presets:',
            value: presets.join(', '),
        });
    }

    const contextWindow = formatTokenCount(model.contextWindow);
    if (contextWindow) {
        rows.push({
            label: 'Context window:',
            value: contextWindow,
        });
    }

    const outputTokenLimit = formatTokenCount(model.outputTokenLimit);
    if (outputTokenLimit) {
        rows.push({
            label: 'Max output:',
            value: outputTokenLimit,
        });
    }

    const supportedMethods = [...new Set(
        (Array.isArray(model?.supportedGenerationMethods) ? model.supportedGenerationMethods : [])
            .map(humanizeMethod)
            .filter(Boolean),
    )];
    if (supportedMethods.length > 0) {
        rows.push({
            label: 'Supports:',
            value: supportedMethods.join(', '),
        });
    }

    if (agent?.supportsGrounding === true && agent?.id !== 'image') {
        const groundingOptions = [];
        if (agentState?.grounding?.webSearch === true) {
            groundingOptions.push('Web Search');
        }
        if (agentState?.grounding?.imageSearch === true) {
            groundingOptions.push('Image Search');
        }

        rows.push({
            label: 'Grounding:',
            value: groundingOptions.length > 0 ? groundingOptions.join(' + ') : 'Off',
        });
    }

    return rows;
}

function ModelDropdown({ selectedModelId, modelsList, onSelect }) {
    const [open, setOpen] = useState(false);
    const [search, setSearch] = useState('');
    const dropdownRef = useRef(null);
    const searchRef = useRef(null);

    useEffect(() => {
        if (!open) return undefined;

        const handler = (event) => {
            if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
                setOpen(false);
                setSearch('');
            }
        };

        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [open]);

    useEffect(() => {
        if (open && searchRef.current) {
            searchRef.current.focus();
        }
    }, [open]);

    const filtered = useMemo(() => {
        const query = search.toLowerCase().trim();
        if (!query) {
            return modelsList;
        }

        return modelsList.filter((model) => (
            String(model?.displayName ?? '').toLowerCase().includes(query)
            || String(model?.id ?? '').toLowerCase().includes(query)
            || String(model?.tier ?? '').toLowerCase().includes(query)
        ));
    }, [modelsList, search]);

    const selectedModel = getModelByRef(modelsList, selectedModelId);
    const triggerLabel = selectedModel?.displayName ?? normalizeModelRef(selectedModelId) ?? 'Select model';

    return (
        <div className="model-dropdown" ref={dropdownRef}>
            <button
                className="model-dropdown-trigger"
                onClick={() => {
                    if (modelsList.length === 0) {
                        return;
                    }

                    setOpen((current) => {
                        const nextOpen = !current;
                        if (!nextOpen) {
                            setSearch('');
                        }
                        return nextOpen;
                    });
                }}
                type="button"
                disabled={modelsList.length === 0}
            >
                <div className="model-trigger-content">
                    <span className="model-trigger-name">{triggerLabel || 'No compatible models'}</span>
                    <span
                        className="model-trigger-tier"
                        style={{ color: tierColor(selectedModel?.tier) }}
                    >
                        {selectedModel?.tier?.toUpperCase() || ''}
                    </span>
                    {selectedModel?.catalogComplete !== true && selectedModel && (
                        <span className="model-option-badge model-option-badge--warning">Needs sync</span>
                    )}
                    {selectedModel?.status === 'deprecated' && (
                        <span className="model-option-badge model-option-badge--deprecated">Deprecated</span>
                    )}
                </div>
                <span className={`model-chevron${open ? ' open' : ''}`}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                        <polyline points="6 9 12 15 18 9" />
                    </svg>
                </span>
            </button>

            {open && (
                <div className="model-dropdown-menu">
                    <div className="model-search-wrap">
                        <span className="model-search-icon"><IconSearch /></span>
                        <input
                            ref={searchRef}
                            className="model-search-input"
                            type="text"
                            placeholder="Search models…"
                            value={search}
                            onChange={(event) => setSearch(event.target.value)}
                            onKeyDown={(event) => {
                                if (event.key === 'Escape') {
                                    setOpen(false);
                                    setSearch('');
                                }
                            }}
                        />
                        {search && (
                            <button
                                className="model-search-clear"
                                onClick={() => {
                                    setSearch('');
                                    searchRef.current?.focus();
                                }}
                                type="button"
                            >
                                <IconClose />
                            </button>
                        )}
                    </div>

                    <div className="model-list">
                        {filtered.length === 0 && (
                            <div className="model-empty">No models match your search</div>
                        )}
                        {filtered.map((model) => (
                            <button
                                key={model.id}
                                className={`model-option${matchesModelRef(model, selectedModelId) ? ' active' : ''}`}
                                onClick={() => {
                                    onSelect(normalizeModelRef(model.id || model.fullName));
                                    setOpen(false);
                                    setSearch('');
                                }}
                                type="button"
                            >
                                <div className="model-option-top">
                                    <span className="model-option-name">{model.displayName}</span>
                                    {model.catalogComplete !== true && (
                                        <span className="model-option-badge model-option-badge--warning">Needs sync</span>
                                    )}
                                    {model.status === 'deprecated' && (
                                        <span className="model-option-badge model-option-badge--deprecated">Deprecated</span>
                                    )}
                                </div>
                                <div className="model-option-api">{model.fullName || `models/${model.id}`}</div>
                            </button>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}

/* ─── Thinking Selector ──────────────────────────────────────────────── */

function ThinkingSelector({ selected, onSelect, presets = [] }) {
    if (presets.length === 0) {
        return (
            <div className="thinking-selector thinking-not-supported">
                <span className="thinking-not-supported-label">Thinking not available for this model</span>
            </div>
        );
    }

    return (
        <div className="thinking-selector">
            {presets.map((preset, index) => {
                const color = getThinkingPresetColor(preset, index);
                return (
                    <button
                        key={preset.id}
                        className={`thinking-btn${preset.id === selected ? ' active' : ''}`}
                        onClick={() => onSelect(preset.id)}
                        title={preset.description || preset.label}
                        type="button"
                        style={{ '--thinking-color': color }}
                    >
                        <span className="thinking-dot" />
                        <span className="thinking-label">{preset.label}</span>
                    </button>
                );
            })}
        </div>
    );
}

function GroundingSelector({ grounding, onChange }) {
    const webSearchEnabled = grounding?.webSearch === true;
    const imageSearchEnabled = grounding?.imageSearch === true;

    const handleWebSearchChange = (event) => {
        const checked = event.target.checked;
        onChange({
            webSearch: checked,
            imageSearch: checked ? imageSearchEnabled : false,
        });
    };

    const handleImageSearchChange = (event) => {
        const checked = event.target.checked;
        onChange({
            webSearch: checked ? true : webSearchEnabled,
            imageSearch: checked,
        });
    };

    return (
        <div className="grounding-selector">
            <label className="grounding-option">
                <input
                    type="checkbox"
                    checked={webSearchEnabled}
                    onChange={handleWebSearchChange}
                />
                <span>Google Web Search</span>
            </label>
            <label className="grounding-option">
                <input
                    type="checkbox"
                    checked={imageSearchEnabled}
                    onChange={handleImageSearchChange}
                />
                <span>Google Image Search (3.1 Flash Image only)</span>
            </label>
        </div>
    );
}

/* ─── Pricing & Model Metadata ──────────────────────────────────────── */

function PriceIndicator({ modelId, modelsList, modelsLoading }) {
    const model = getModelByRef(modelsList, modelId);
    if (!model) {
        return modelsLoading
            ? <div className="price-indicator price-indicator--loading" />
            : null;
    }

    const summary = buildPriceSummary(model);
    if (!summary) {
        return null;
    }

    return (
        <div className="price-indicator price-indicator--compact">
            <span className="price-label">Price</span>
            <span className="price-summary">{summary}</span>
        </div>
    );
}

function ModelCatalogMissingCard({ model, onLaunchTask }) {
    const missingFields = formatMissingCatalogFields(model);
    const thinkingLabel = formatThinkingMissingLabel(model);

    return (
        <div className="model-catalog-missing-card">
            <div className="model-catalog-missing-copy">
                <span className="model-catalog-missing-label">Model data missing</span>
                <h3 className="model-catalog-missing-title">{model?.displayName || normalizeModelRef(model?.id)}</h3>
                <p className="model-catalog-missing-text">
                    Verified {missingFields.join(' and ')} data is missing for this model.
                    Open the Orchestrator task to update the catalog.
                </p>
                {thinkingLabel && (
                    <p className="model-catalog-missing-hint">{thinkingLabel}</p>
                )}
            </div>
            <button
                className="model-catalog-sync-btn"
                type="button"
                onClick={onLaunchTask}
            >
                Open in Orchestrator
            </button>
        </div>
    );
}

function ModelStatusSummary({ model }) {
    if (model?.status !== 'deprecated') {
        return null;
    }

    let label = 'Deprecated model.';
    if (model?.deprecatedAt) {
        label = `Deprecated on ${model.deprecatedAt}.`;
    }
    if (model?.recommendedReplacement) {
        label += ` Use ${normalizeModelRef(model.recommendedReplacement)}.`;
    }

    return (
        <div className="model-status-summary">
            <p>{label}</p>
        </div>
    );
}

function ModelDetailsPanel({ model, agent, agentState }) {
    const [open, setOpen] = useState(false);
    const panelRef = useRef(null);

    useEffect(() => {
        if (!open) {
            return undefined;
        }

        const handlePointerDown = (event) => {
            if (panelRef.current && !panelRef.current.contains(event.target)) {
                setOpen(false);
            }
        };

        const handleEscape = (event) => {
            if (event.key === 'Escape') {
                setOpen(false);
            }
        };

        document.addEventListener('mousedown', handlePointerDown);
        document.addEventListener('keydown', handleEscape);

        return () => {
            document.removeEventListener('mousedown', handlePointerDown);
            document.removeEventListener('keydown', handleEscape);
        };
    }, [open]);

    if (!model) {
        return null;
    }

    const pricingRows = buildPricingRows(model);
    const capabilityRows = buildCapabilityRows(model, agent, agentState);
    const hasLifecycle = model.status === 'deprecated';
    const hasNote = Boolean(model.note);
    const restrictions = Array.isArray(model?.restrictions) ? model.restrictions.filter(Boolean) : [];
    const hasSources = Array.isArray(model.sourceUrls) && model.sourceUrls.length > 0;

    if (!hasLifecycle && !hasNote && capabilityRows.length === 0 && pricingRows.length === 0 && restrictions.length === 0 && !hasSources) {
        return null;
    }

    return (
        <div className={`model-details-panel${open ? ' model-details-panel--open' : ''}`} ref={panelRef}>
            <button
                className="model-details-trigger"
                onClick={() => setOpen((current) => !current)}
                type="button"
                aria-expanded={open}
            >
                <span>More details</span>
                <span className={`model-details-chevron${open ? ' open' : ''}`}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                        <polyline points="6 9 12 15 18 9" />
                    </svg>
                </span>
            </button>

            {open && (
                <div className="model-details-popover">
                    <div className="model-details-content">
                        {hasLifecycle && (
                            <p className="model-details-text">
                                {model.deprecatedAt
                                    ? `Deprecated on ${model.deprecatedAt}.`
                                    : 'Deprecated model.'}
                                {model.recommendedReplacement
                                    ? ` Recommended replacement: ${normalizeModelRef(model.recommendedReplacement)}.`
                                    : ''}
                            </p>
                        )}
                        {hasNote && (
                            <p className="model-details-text">{model.note}</p>
                        )}

                        {capabilityRows.length > 0 && (
                            <div className="model-details-group">
                                <span className="model-details-group-title">Capabilities</span>
                                <div className="model-details-grid">
                                    {capabilityRows.map((row, index) => (
                                        <div className="model-detail-row" key={`${index}-${row.label}`}>
                                            <span className="model-detail-label">{row.label}</span>
                                            <span className="model-detail-value">{row.value}</span>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}

                        {restrictions.length > 0 && (
                            <div className="model-details-group">
                                <span className="model-details-group-title">Restrictions</span>
                                <ul className="model-details-list">
                                    {restrictions.map((restriction) => (
                                        <li key={restriction}>{restriction}</li>
                                    ))}
                                </ul>
                            </div>
                        )}

                        {pricingRows.length > 0 && (
                            <div className="model-details-group">
                                <span className="model-details-group-title">Pricing</span>
                                <div className="price-details">
                                    {pricingRows.map((row, index) => (
                                        <div className="price-row" key={`${index}-${row.label}`}>
                                            <span className="price-row-heading">{row.label}</span>
                                            <span>{row.value}</span>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}

                        {hasSources && (
                            <div className="model-details-group">
                                <span className="model-details-group-title">Sources</span>
                                <div className="model-sources">
                                    {model.sourceUrls.map((url) => (
                                        <a key={url} href={url} target="_blank" rel="noreferrer">
                                            {formatSourceUrlLabel(url)}
                                        </a>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}

function ModelDetailsSection({ selectedModel, agent, agentState }) {
    if (!selectedModel) {
        return null;
    }

    return (
        <div className="agent-section">
            <ModelDetailsPanel
                model={selectedModel}
                agent={agent}
                agentState={agentState}
            />
        </div>
    );
}

function shouldShowGroundingControl(agent) {
    return agent?.supportsGrounding === true && agent?.id !== 'image';
}

function shouldShowModelDetails(model) {
    return Boolean(
        model
        && (
            model.status === 'deprecated'
            || model.note
            || (Array.isArray(model?.sourceUrls) && model.sourceUrls.length > 0)
            || (Array.isArray(model?.restrictions) && model.restrictions.length > 0)
            || buildPricingRows(model).length > 0
            || buildCapabilityRows(model).length > 0
        )
    );
}

function formatMissingModelsForBanner(models = []) {
    return models
        .map((model) => model.displayName || normalizeModelRef(model.id))
        .filter(Boolean);
}

function ModelCatalogSyncBanner({ incompleteModels = [], onLaunchTask }) {
    const incompleteModelsCount = incompleteModels.length;

    if (incompleteModelsCount === 0) {
        return null;
    }

    const title = 'Model catalog';
    const description = `Verified data is still missing for ${incompleteModelsCount} model(s). Open a new Orchestrator task to update ~/.orchestrator/models.json.`;
    const missingNames = formatMissingModelsForBanner(incompleteModels);

    return (
        <div className="model-sync-banner">
            <div className="model-sync-banner-copy">
                <span className="model-sync-banner-label">{title}</span>
                <p className="model-sync-banner-text">{description}</p>
                <div className="model-sync-missing-list">
                    {missingNames.map((name) => (
                        <span key={name} className="model-option-badge model-option-badge--warning">{name}</span>
                    ))}
                </div>
            </div>
            <button
                className="model-catalog-sync-btn"
                type="button"
                onClick={onLaunchTask}
            >
                Open in Orchestrator
            </button>
        </div>
    );
}

function buildAgentStates(agentDefinitions, savedSettings, previousStates = {}) {
    const next = {};

    for (const agent of agentDefinitions) {
        const previous = previousStates?.[agent.id];
        const saved = savedSettings?.[agent.id];

        next[agent.id] = {
            model: previous?.model ?? saved?.model ?? agent.defaultModel,
            thinkingLevel: previous?.thinkingLevel ?? saved?.thinkingLevel ?? agent.defaultThinkingLevel,
            grounding: agent.supportsGrounding
                ? {
                    webSearch: previous?.grounding?.webSearch
                        ?? saved?.grounding?.webSearch
                        ?? agent.defaultGrounding?.webSearch
                        ?? false,
                    imageSearch: previous?.grounding?.imageSearch
                        ?? saved?.grounding?.imageSearch
                        ?? agent.defaultGrounding?.imageSearch
                        ?? false,
                }
                : undefined,
        };
    }

    return next;
}

/* ─── Agent Card ─────────────────────────────────────────────────────── */

function AgentCard({ agent, agentState, onChange, modelsList, modelsLoading, onLaunchCatalogTask }) {
    const supportsThinking = agent.supportsThinking !== false;
    const supportsGrounding = shouldShowGroundingControl(agent);
    const compatibleModels = useMemo(
        () => getCompatibleModels(modelsList, agent.id),
        [agent.id, modelsList],
    );
    const selectedModel = compatibleModels.find((model) => matchesModelRef(model, agentState.model))
        ?? getModelByRef(modelsList, agentState.model);
    const catalogComplete = selectedModel?.catalogComplete === true;
    const thinkingPresets = getThinkingPresets(selectedModel);
    const selectedThinkingPreset = resolveThinkingPreset(
        selectedModel,
        agentState.thinkingLevel,
        agent.defaultThinkingLevel,
    );
    const priceSummary = buildPriceSummary(selectedModel);
    const hasModelDetails = shouldShowModelDetails(selectedModel);

    const handleModelChange = useCallback((modelId) => {
        const nextModel = compatibleModels.find((model) => matchesModelRef(model, modelId))
            ?? getModelByRef(modelsList, modelId);
        const nextState = {
            ...agentState,
            model: normalizeModelRef(modelId),
        };

        if (supportsThinking && nextModel?.thinkingVerified === true) {
            nextState.thinkingLevel = resolveThinkingPreset(
                nextModel,
                agentState.thinkingLevel,
                agent.defaultThinkingLevel,
            );
        }

        onChange(nextState);
    }, [
        agent.defaultThinkingLevel,
        agentState,
        compatibleModels,
        modelsList,
        onChange,
        supportsThinking,
    ]);

    const handleThinkingChange = useCallback((presetId) => {
        onChange({
            ...agentState,
            thinkingLevel: presetId,
        });
    }, [agentState, onChange]);

    const handleGroundingChange = useCallback((grounding) => {
        onChange({
            ...agentState,
            grounding,
        });
    }, [agentState, onChange]);

    return (
        <div className="agent-card">
            <div className="agent-card-header">
                <span className="agent-icon">{agent.icon}</span>
                <div className="agent-header-text">
                    <h2 className="agent-name">{agent.name}</h2>
                    <p className="agent-desc">{agent.description}</p>
                </div>
            </div>

            <div className="agent-section">
                <label className="agent-section-label">Model</label>
                <ModelDropdown
                    selectedModelId={agentState.model}
                    modelsList={compatibleModels}
                    onSelect={handleModelChange}
                />
            </div>

            {supportsGrounding && (
                <div className="agent-section">
                    <label className="agent-section-label">Grounding</label>
                    <GroundingSelector
                        grounding={agentState.grounding}
                        onChange={handleGroundingChange}
                    />
                </div>
            )}

            <ModelStatusSummary model={selectedModel} />

            {supportsThinking && catalogComplete && (
                <div className="agent-section">
                    <label className="agent-section-label">Thinking</label>
                    <ThinkingSelector
                        selected={selectedThinkingPreset}
                        onSelect={handleThinkingChange}
                        presets={thinkingPresets}
                    />
                </div>
            )}

            {catalogComplete ? (
                <>
                    {priceSummary && (
                        <div className="agent-section">
                            <PriceIndicator
                                modelId={agentState.model}
                                modelsList={modelsList}
                                modelsLoading={modelsLoading}
                            />
                        </div>
                    )}
                    {hasModelDetails && (
                        <ModelDetailsSection
                            selectedModel={selectedModel}
                            agent={agent}
                            agentState={agentState}
                        />
                    )}
                </>
            ) : (
                selectedModel && (
                    <div className="agent-section">
                        <ModelCatalogMissingCard
                            model={selectedModel}
                            onLaunchTask={() => onLaunchCatalogTask(selectedModel)}
                        />
                    </div>
                )
            )}
        </div>
    );
}

/* ─── Main Settings Fullscreen Page ─────────────────────────────────── */

const TABS = [
    { id: 'models', label: 'Models' },
    { id: 'mcp', label: 'MCP' },
    { id: 'files', label: 'Files' },
    { id: 'skills', label: 'Skills' },
    { id: 'usage', label: 'Usage' },
    { id: 'logs', label: 'Logs' },
    { id: 'updates', label: 'Updates' },
];
const SETTINGS_ACTIVE_TAB_STORAGE_KEY = 'orchestrator.settings.active_tab';

function getInitialActiveTab() {
    const fallbackTab = TABS[0]?.id ?? 'models';

    try {
        const stored = String(localStorage.getItem(SETTINGS_ACTIVE_TAB_STORAGE_KEY) ?? '').trim();
        if (stored && TABS.some((tab) => tab.id === stored)) {
            return stored;
        }
    } catch {
        // noop
    }

    return fallbackTab;
}

export function Settings({ onClose, savedSettings, agentDefinitions = [], onSave, onLaunchModelCatalogTask }) {
    const [agentStates, setAgentStates] = useState(() => buildAgentStates(agentDefinitions, savedSettings));
    const [activeTab, setActiveTab] = useState(() => getInitialActiveTab());
    const [modelsList, setModelsList] = useState([]);
    const [modelsLoading, setModelsLoading] = useState(true);

    const loadModels = useCallback(async () => {
        setModelsLoading(true);
        try {
            const list = await fetchRemoteModels();
            setModelsList(Array.isArray(list) ? list : []);
        } catch (error) {
            console.error('Failed to load model catalog', error);
        } finally {
            setModelsLoading(false);
        }
    }, []);

    useEffect(() => {
        loadModels().catch(() => undefined);
    }, [loadModels]);

    useEffect(() => {
        if (modelsLoading || agentDefinitions.length === 0 || modelsList.length === 0) {
            return;
        }

        const nextStates = {};
        let changed = false;

        for (const agent of agentDefinitions) {
            const currentState = agentStates[agent.id] ?? buildAgentStates([agent], savedSettings)[agent.id];
            const normalizedState = normalizeAgentStateForCatalog(agent, currentState, modelsList);
            nextStates[agent.id] = normalizedState;
            if (!agentStatesEqual(currentState, normalizedState)) {
                changed = true;
            }
        }

        if (changed) {
            setAgentStates(nextStates);
            onSave(nextStates);
        }
    }, [agentDefinitions, agentStates, modelsList, modelsLoading, onSave, savedSettings]);

    useEffect(() => {
        const source = new EventSource('/api/events');

        source.onmessage = (event) => {
            try {
                const payload = JSON.parse(event.data);
                if (payload?.type === 'models.updated') {
                    loadModels().catch(() => undefined);
                }
            } catch {
                // Ignore malformed payloads.
            }
        };

        return () => {
            source.close();
        };
    }, [loadModels]);

    useEffect(() => {
        try {
            localStorage.setItem(SETTINGS_ACTIVE_TAB_STORAGE_KEY, activeTab);
        } catch {
            // noop
        }
    }, [activeTab]);

    const handleAgentChange = useCallback((agentId, state) => {
        setAgentStates((previousStates) => {
            const nextStates = { ...previousStates, [agentId]: state };
            onSave(nextStates);
            return nextStates;
        });
    }, [onSave]);

    const incompleteModels = useMemo(
        () => modelsList.filter((model) => model.catalogComplete !== true),
        [modelsList],
    );
    const handleLaunchCatalogTask = useCallback((focusModel = null) => {
        if (typeof onLaunchModelCatalogTask !== 'function') {
            return;
        }

        onLaunchModelCatalogTask({
            focusModelId: normalizeModelRef(focusModel?.id ?? focusModel?.fullName ?? ''),
            missingModelIds: incompleteModels.map((model) => normalizeModelRef(model.id)),
        });
    }, [incompleteModels, onLaunchModelCatalogTask]);

    return (
        <div className="settings-page">
            <div className="settings-container">
                <header className="settings-header">
                    <div className="settings-header-left">
                        <span className="settings-header-icon"><IconSettings /></span>
                        <h1 className="settings-title">Settings</h1>
                    </div>
                    <div className="settings-tabs">
                        {TABS.map((tab) => (
                            <button
                                key={tab.id}
                                className={`settings-tab${activeTab === tab.id ? ' active' : ''}`}
                                onClick={() => setActiveTab(tab.id)}
                                type="button"
                            >
                                {tab.label}
                            </button>
                        ))}
                    </div>
                    <button
                        className="settings-close-btn"
                        onClick={onClose}
                        title="Close settings"
                        type="button"
                    >
                        <IconClose />
                    </button>
                </header>

                <div className={`settings-content${activeTab === 'files' ? ' settings-content--files' : ''}`}>
                    {activeTab === 'models' && (
                        <>
                            <ModelCatalogSyncBanner
                                incompleteModels={incompleteModels}
                                onLaunchTask={() => handleLaunchCatalogTask()}
                            />

                            <div className="settings-agents-grid">
                                {agentDefinitions.length === 0 ? (
                                    <div className="settings-placeholder">
                                        <h2>Agents unavailable</h2>
                                        <p>Could not load agent definitions from API.</p>
                                    </div>
                                ) : (
                                    agentDefinitions.map((agent) => (
                                        <AgentCard
                                            key={agent.id}
                                            agent={agent}
                                            agentState={agentStates[agent.id] ?? buildAgentStates([agent], savedSettings)[agent.id]}
                                            modelsList={modelsList}
                                            modelsLoading={modelsLoading}
                                            onLaunchCatalogTask={handleLaunchCatalogTask}
                                            onChange={(state) => handleAgentChange(agent.id, state)}
                                        />
                                    ))
                                )}
                            </div>
                        </>
                    )}

                    {activeTab === 'usage' && (
                        <UsageDashboard modelsList={modelsList} agentDefinitions={agentDefinitions} />
                    )}

                    {activeTab === 'mcp' && (
                        <McpPanel />
                    )}

                    {activeTab === 'files' && (
                        <FilesEditorPanel />
                    )}

                    {activeTab === 'skills' && (
                        <SkillsPanel />
                    )}

                    {activeTab === 'logs' && (
                        <SystemLogsDashboard agentDefinitions={agentDefinitions} />
                    )}

                    {activeTab === 'updates' && (
                        <UpdatesPanel />
                    )}
                </div>
            </div>
        </div>
    );
}
