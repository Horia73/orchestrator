import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import {
    THINKING_LEVELS,
    tierColor,
} from '../../config/agentModels.js';
import { IconClose, IconSearch, IconSettings } from '../shared/icons.jsx';
import { fetchRemoteModels } from '../../api/settingsApi.js';
import { UsageDashboard } from './UsageDashboard.jsx';
import { SystemLogsDashboard } from './SystemLogsDashboard.jsx';
import { UpdatesPanel } from './UpdatesPanel.jsx';
import { SkillsPanel } from './SkillsPanel.jsx';
import { FilesEditorPanel } from './FilesEditorPanel.jsx';
import './Settings.css';

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

function formatPriceAmount(value, decimals = 2) {
    return `$${Number(value).toFixed(decimals)}`;
}

function ModelDropdown({ selectedModelId, modelsList, onSelect }) {
    const [open, setOpen] = useState(false);
    const [search, setSearch] = useState('');
    const dropdownRef = useRef(null);
    const searchRef = useRef(null);

    // Close on outside click
    useEffect(() => {
        if (!open) return;
        const handler = (e) => {
            if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
                setOpen(false);
                setSearch('');
            }
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [open]);

    // Auto-focus search when opening
    useEffect(() => {
        if (open && searchRef.current) {
            searchRef.current.focus();
        }
    }, [open]);

    const filtered = useMemo(() => {
        const q = search.toLowerCase().trim();
        if (!q) return modelsList;
        return modelsList.filter(
            (m) =>
                m.displayName.toLowerCase().includes(q) ||
                m.id.toLowerCase().includes(q) ||
                m.tier.toLowerCase().includes(q)
        );
    }, [search, modelsList]);

    const selectedModel = modelsList.find((m) => matchesModelRef(m, selectedModelId));

    return (
        <div className="model-dropdown" ref={dropdownRef}>
            <button
                className="model-dropdown-trigger"
                onClick={() => {
                    setOpen(!open);
                    if (open) setSearch('');
                }}
                type="button"
            >
                <div className="model-trigger-content">
                    <span className="model-trigger-name">
                        {selectedModel?.displayName ?? normalizeModelRef(selectedModelId)}
                    </span>
                    <span
                        className="model-trigger-tier"
                        style={{ color: tierColor(selectedModel?.tier) }}
                    >
                        {selectedModel?.tier?.toUpperCase() || ''}
                    </span>
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
                            onChange={(e) => setSearch(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Escape') {
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

/* ─── Thinking Level Selector ────────────────────────────────────────── */

function ThinkingSelector({ selected, onSelect, selectorRef, disabledLevels = [], thinkingSupported = true }) {
    if (!thinkingSupported) {
        return (
            <div className="thinking-selector thinking-not-supported" ref={selectorRef}>
                <span className="thinking-not-supported-label">Thinking not available for this model</span>
            </div>
        );
    }

    return (
        <div className="thinking-selector" ref={selectorRef}>
            {THINKING_LEVELS.map((level) => {
                const isDisabled = disabledLevels.includes(level.id);
                return (
                    <button
                        key={level.id}
                        className={`thinking-btn${level.id === selected ? ' active' : ''}${isDisabled ? ' disabled' : ''}`}
                        onClick={() => !isDisabled && onSelect(level.id)}
                        title={isDisabled ? `${level.label} is not supported by this model` : level.description}
                        type="button"
                        disabled={isDisabled}
                        style={{
                            '--thinking-color': level.color,
                        }}
                    >
                        <span className="thinking-dot" />
                        <span className="thinking-label">{level.label}</span>
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

/* ─── Price Indicator ────────────────────────────────────────────────── */

function PriceIndicator({ modelId, modelsList, modelsLoading }) {
    const model = modelsList.find((m) => matchesModelRef(m, modelId));
    if (!model) {
        // Reserve space while models are still loading to prevent card resize.
        return modelsLoading
            ? <div className="price-indicator price-indicator--loading" />
            : null;
    }

    const pricingRows = [];

    if (Number.isFinite(model.inputPrice200k)) {
        pricingRows.push({
            label: 'Input:',
            value: `${formatPriceAmount(model.inputPrice200k)} / 1M tokens`,
        });
    }
    if (Number.isFinite(model.inputPriceOver200k)) {
        pricingRows.push({
            label: 'Input (>200k tokens):',
            value: `${formatPriceAmount(model.inputPriceOver200k)} / 1M tokens`,
        });
    }
    if (Number.isFinite(model.outputPrice200k)) {
        pricingRows.push({
            label: 'Output:',
            value: `${formatPriceAmount(model.outputPrice200k)} / 1M tokens`,
        });
    }
    if (Number.isFinite(model.outputPriceOver200k)) {
        pricingRows.push({
            label: 'Output (>200k tokens):',
            value: `${formatPriceAmount(model.outputPriceOver200k)} / 1M tokens`,
        });
    }
    if (Number.isFinite(model.outputTextPrice200k)) {
        pricingRows.push({
            label: 'Output text/thinking:',
            value: `${formatPriceAmount(model.outputTextPrice200k)} / 1M tokens`,
        });
    }
    if (Number.isFinite(model.outputImagePrice200k)) {
        pricingRows.push({
            label: 'Output images:',
            value: `${formatPriceAmount(model.outputImagePrice200k)} / 1M tokens`,
        });
    }
    if (Number.isFinite(model.outputImagePricePerImage)) {
        pricingRows.push({
            label: 'Output images:',
            value: `${formatPriceAmount(model.outputImagePricePerImage, 3)} / image`,
        });
    }
    if (Number.isFinite(model.outputImagePrice1K)) {
        pricingRows.push({
            label: 'Output image (1K):',
            value: `${formatPriceAmount(model.outputImagePrice1K, 3)} / image`,
        });
    }
    if (Number.isFinite(model.outputImagePrice2K)) {
        pricingRows.push({
            label: 'Output image (2K):',
            value: `${formatPriceAmount(model.outputImagePrice2K, 3)} / image`,
        });
    }
    if (Number.isFinite(model.outputImagePrice4K)) {
        pricingRows.push({
            label: 'Output image (4K):',
            value: `${formatPriceAmount(model.outputImagePrice4K, 3)} / image`,
        });
    }
    if (Number.isFinite(model.outputAudioPrice)) {
        pricingRows.push({
            label: 'Output audio:',
            value: `${formatPriceAmount(model.outputAudioPrice)} / 1M audio tokens`,
        });
    }
    if (Number.isFinite(model.outputPricePerSecond)) {
        pricingRows.push({
            label: 'Output video:',
            value: `${formatPriceAmount(model.outputPricePerSecond)} / second`,
        });
    }
    if (Number.isFinite(model.pricePerQuery)) {
        pricingRows.push({
            label: 'Per query:',
            value: `${formatPriceAmount(model.pricePerQuery)} / query`,
        });
    }
    if (Number.isFinite(model.groundingPricePer1k)) {
        pricingRows.push({
            label: 'Grounding:',
            value: `${formatPriceAmount(model.groundingPricePer1k)} / 1K requests`,
        });
    }

    if (pricingRows.length === 0) {
        return (
            <div className="price-indicator">
                <div className="price-header">
                    <span className="price-label">Pricing Info</span>
                    <span className="price-value" style={{ color: 'var(--text-tertiary)' }}>Unknown</span>
                </div>
                <div className="price-details">
                    <span>Pricing for {model.displayName} is not tracked.</span>
                </div>
            </div>
        );
    }

    return (
        <div className="price-indicator">
            <div className="price-header">
                <span className="price-label">Model Pricing Details</span>
            </div>
            <div className="price-details">
                {pricingRows.map((row, index) => (
                    <div className="price-row" key={`${index}-${row.label}`}>
                        <span className="price-row-heading">{row.label}</span>
                        <span>{row.value}</span>
                    </div>
                ))}
                {model.note && (
                    <span>{model.note}</span>
                )}
            </div>
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

function AgentCard({ agent, agentState, onChange, modelsList, modelsLoading }) {
    const supportsThinking = agent.supportsThinking !== false;
    const selectedModel = modelsList.find((m) => matchesModelRef(m, agentState.model));
    const thinkingSupported = selectedModel ? selectedModel.thinking !== false : true;
    const disabledLevels = selectedModel?.unsupportedThinkingLevels ?? [];

    const handleModelChange = useCallback(
        (modelId) => onChange({ ...agentState, model: modelId }),
        [agentState, onChange],
    );

    const handleThinkingChange = useCallback(
        (level) => onChange({ ...agentState, thinkingLevel: level }),
        [agentState, onChange],
    );

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
                    modelsList={modelsList}
                    onSelect={handleModelChange}
                />
            </div>

            {supportsThinking && (
                <div className="agent-section">
                    <label className="agent-section-label">Thinking Level</label>
                    <ThinkingSelector
                        selected={agentState.thinkingLevel}
                        onSelect={handleThinkingChange}
                        selectorRef={null}
                        disabledLevels={disabledLevels}
                        thinkingSupported={thinkingSupported}
                    />
                </div>
            )}

            <div className="agent-section">
                <PriceIndicator
                    modelId={agentState.model}
                    modelsList={modelsList}
                    modelsLoading={modelsLoading}
                />
            </div>
        </div>
    );
}

/* ─── Main Settings Fullscreen Page ─────────────────────────────────── */

const TABS = [
    { id: 'models', label: 'Models' },
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

export function Settings({ onClose, savedSettings, agentDefinitions = [], onSave }) {
    const [agentStates, setAgentStates] = useState(() => buildAgentStates(agentDefinitions, savedSettings));
    const [activeTab, setActiveTab] = useState(() => getInitialActiveTab());
    const [modelsList, setModelsList] = useState([]);
    const [modelsLoading, setModelsLoading] = useState(true);

    const loadModels = useCallback(async () => {
        setModelsLoading(true);
        try {
            const list = await fetchRemoteModels();
            setModelsList(Array.isArray(list) ? list : []);
        } catch (err) {
            console.error('Failed to load generic models', err);
        } finally {
            setModelsLoading(false);
        }
    }, []);

    useEffect(() => {
        loadModels().catch(() => undefined);
    }, [loadModels]);

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

    // Auto-save logic
    const handleAgentChange = useCallback((agentId, state) => {
        setAgentStates((prev) => {
            const nextStates = { ...prev, [agentId]: state };
            onSave(nextStates);
            return nextStates;
        });
    }, [onSave]);



    return (
        <div className="settings-page">
            <div className="settings-container">
                {/* Header */}
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

                {/* Content */}
                <div className="settings-content">
                    {activeTab === 'models' && (
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
                                        onChange={(state) => handleAgentChange(agent.id, state)}
                                    />
                                ))
                            )}
                        </div>
                    )}

                    {activeTab === 'usage' && (
                        <UsageDashboard modelsList={modelsList} agentDefinitions={agentDefinitions} />
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
