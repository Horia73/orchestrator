import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import {
    AGENT_DEFINITIONS,
    THINKING_LEVELS,
    buildMergedModels,
    tierColor,
} from '../../config/agentModels.js';
import { IconClose, IconSearch, IconSettings } from '../shared/icons.jsx';
import { fetchRemoteModels } from '../../api/settingsApi.js';
import { UsageDashboard } from './UsageDashboard.jsx';
import { SystemLogsDashboard } from './SystemLogsDashboard.jsx';
import './Settings.css';

/* ─── Model Dropdown ─────────────────────────────────────────────────── */

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

    const selectedModel = modelsList.find((m) => m.id === selectedModelId);

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
                        {selectedModel?.displayName ?? selectedModelId}
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
                                className={`model-option${model.id === selectedModelId ? ' active' : ''}`}
                                onClick={() => {
                                    onSelect(model.id);
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

function ThinkingSelector({ selected, onSelect, selectorRef }) {
    return (
        <div className="thinking-selector" ref={selectorRef}>
            {THINKING_LEVELS.map((level) => (
                <button
                    key={level.id}
                    className={`thinking-btn${level.id === selected ? ' active' : ''}`}
                    onClick={() => onSelect(level.id)}
                    title={level.description}
                    type="button"
                    style={{
                        '--thinking-color': level.color,
                    }}
                >
                    <span className="thinking-dot" />
                    <span className="thinking-label">{level.label}</span>
                </button>
            ))}
        </div>
    );
}

/* ─── Price Indicator ────────────────────────────────────────────────── */

function PriceIndicator({ modelId, modelsList }) {
    const model = modelsList.find((m) => m.id === modelId);
    if (!model) return null;

    if (model.outputPrice200k === undefined) {
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
                {model.inputPriceOver200k !== undefined ? (
                    <>
                        <div className="price-row">
                            <span className="price-row-heading">Input (≤200k tokens):</span>
                            <span>${model.inputPrice200k.toFixed(2)} / 1M tokens</span>
                        </div>
                        <div className="price-row">
                            <span className="price-row-heading">Input (&gt;200k tokens):</span>
                            <span>${model.inputPriceOver200k.toFixed(2)} / 1M tokens</span>
                        </div>
                        <div className="price-row">
                            <span className="price-row-heading">Output (≤200k tokens):</span>
                            <span>${model.outputPrice200k.toFixed(2)} / 1M tokens</span>
                        </div>
                        <div className="price-row">
                            <span className="price-row-heading">Output (&gt;200k tokens):</span>
                            <span>${model.outputPriceOver200k.toFixed(2)} / 1M tokens</span>
                        </div>
                    </>
                ) : (
                    <>
                        <div className="price-row">
                            <span className="price-row-heading">Input:</span>
                            <span>${model.inputPrice200k.toFixed(2)} / 1M tokens</span>
                        </div>
                        <div className="price-row">
                            <span className="price-row-heading">Output:</span>
                            <span>${model.outputPrice200k.toFixed(2)} / 1M tokens</span>
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}

/* ─── Agent Card ─────────────────────────────────────────────────────── */

function AgentCard({ agent, agentState, onChange, modelsList }) {
    const isOrchestrator = agent.id === 'orchestrator';
    const thinkingSelectorRef = useRef(null);
    const [orchestratorContentWidth, setOrchestratorContentWidth] = useState(null);

    const handleModelChange = useCallback(
        (modelId) => onChange({ ...agentState, model: modelId }),
        [agentState, onChange],
    );

    const handleThinkingChange = useCallback(
        (level) => onChange({ ...agentState, thinkingLevel: level }),
        [agentState, onChange],
    );

    useEffect(() => {
        if (!isOrchestrator) return undefined;

        const updateWidth = () => {
            const node = thinkingSelectorRef.current;
            if (!node) return;
            const width = Math.ceil(node.scrollWidth);
            setOrchestratorContentWidth((prev) => (prev === width ? prev : width));
        };

        updateWidth();

        const node = thinkingSelectorRef.current;
        let resizeObserver;
        if (node && typeof ResizeObserver !== 'undefined') {
            resizeObserver = new ResizeObserver(updateWidth);
            resizeObserver.observe(node);
        }

        window.addEventListener('resize', updateWidth);

        return () => {
            resizeObserver?.disconnect();
            window.removeEventListener('resize', updateWidth);
        };
    }, [isOrchestrator]);

    const orchestratorStyle = isOrchestrator && orchestratorContentWidth
        ? { '--orchestrator-content-width': `${orchestratorContentWidth}px` }
        : undefined;

    return (
        <div className={`agent-card${isOrchestrator ? ' agent-card--orchestrator' : ''}`} style={orchestratorStyle}>
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

            <div className="agent-section">
                <label className="agent-section-label">Thinking Level</label>
                <ThinkingSelector
                    selected={agentState.thinkingLevel}
                    onSelect={handleThinkingChange}
                    selectorRef={isOrchestrator ? thinkingSelectorRef : null}
                />
            </div>

            <div className="agent-section">
                <PriceIndicator
                    modelId={agentState.model}
                    modelsList={modelsList}
                />
            </div>
        </div>
    );
}

/* ─── Main Settings Fullscreen Page ─────────────────────────────────── */

const TABS = [
    { id: 'models', label: 'Models' },
    { id: 'usage', label: 'Usage' },
    { id: 'logs', label: 'Logs' },
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

export function Settings({ onClose, savedSettings, onSave }) {
    const [agentStates, setAgentStates] = useState(() => {
        const state = {};
        for (const agent of AGENT_DEFINITIONS) {
            const saved = savedSettings?.[agent.id];
            state[agent.id] = {
                model: saved?.model ?? agent.defaultModel,
                thinkingLevel: saved?.thinkingLevel ?? agent.defaultThinkingLevel,
            };
        }
        return state;
    });

    const [activeTab, setActiveTab] = useState(() => getInitialActiveTab());
    const [modelsList, setModelsList] = useState(() => buildMergedModels([]));

    useEffect(() => {
        fetchRemoteModels()
            .then((list) => {
                setModelsList(buildMergedModels(list));
            })
            .catch((err) => {
                console.error("Failed to load generic models", err);
            });
    }, []);

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
                            {AGENT_DEFINITIONS.map((agent) => (
                                <AgentCard
                                    key={agent.id}
                                    agent={agent}
                                    agentState={agentStates[agent.id]}
                                    modelsList={modelsList}
                                    onChange={(state) => handleAgentChange(agent.id, state)}
                                />
                            ))}
                        </div>
                    )}

                    {activeTab === 'usage' && (
                        <UsageDashboard modelsList={modelsList} />
                    )}

                    {activeTab === 'logs' && (
                        <SystemLogsDashboard />
                    )}
                </div>
            </div>
        </div>
    );
}
