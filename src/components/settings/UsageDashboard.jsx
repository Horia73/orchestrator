import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { clearUsage, fetchUsage } from '../../api/settingsApi.js';
import { BrowserActivityLog } from '../shared/BrowserActivityLog.jsx';
import { DateRangePicker } from './DateRangePicker.jsx';
import { getPresetRange, isDateWithinRange, parseDateKey } from './dateRangeUtils.js';

const LONG_DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
});

function normalizeModelId(value) {
    const raw = String(value ?? '').trim();
    if (!raw) {
        return 'unknown-model';
    }

    if (raw.startsWith('models/')) {
        return raw.slice('models/'.length);
    }

    return raw;
}

function normalizeUsageSource(value) {
    const normalized = String(value ?? '').trim().toLowerCase();
    if (!normalized) {
        return 'chat';
    }

    return normalized;
}

function isVisibleUsageRequest(request) {
    return !normalizeModelId(request?.model).toLowerCase().startsWith('tool:');
}

function formatNumber(value) {
    return new Intl.NumberFormat('en-US').format(Number(value) || 0);
}

function formatCost(value) {
    const amount = Number(value) || 0;
    if (amount >= 1) {
        return `$${amount.toFixed(2)}`;
    }

    if (amount >= 0.01) {
        return `$${amount.toFixed(4)}`;
    }

    return `$${amount.toFixed(6)}`;
}

function formatCreatedAt(value) {
    const timestamp = Number(value);
    if (!Number.isFinite(timestamp) || timestamp <= 0) {
        return '-';
    }

    return new Date(timestamp).toLocaleString();
}

function formatDateKey(value) {
    return LONG_DATE_FORMATTER.format(parseDateKey(value));
}

function formatRangeLabel(startDate, endDate) {
    if (startDate === endDate) {
        return formatDateKey(startDate);
    }

    return `${formatDateKey(startDate)} - ${formatDateKey(endDate)}`;
}

function truncatePreview(value, maxChars = 72) {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim();
    if (!text) {
        return '-';
    }

    if (text.length <= maxChars) {
        return text;
    }

    return `${text.slice(0, maxChars - 1)}…`;
}

function formatThinkingLevel(value) {
    const normalized = String(value ?? '').trim().toLowerCase();
    if (!normalized) {
        return '-';
    }

    if (normalized === 'minimal' || normalized === 'low' || normalized === 'medium' || normalized === 'high') {
        return normalized.charAt(0).toUpperCase() + normalized.slice(1);
    }

    return normalized;
}

function sourceLabel(value) {
    const normalized = normalizeUsageSource(value);
    if (normalized === 'title') return 'Title';
    if (normalized === 'tool') return 'Tool';
    if (normalized === 'chat') return 'Chat';
    return normalized;
}

function sortRequestsByNewest(requests) {
    return [...requests].sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
}

function mergeRequests(existing, incoming) {
    const byId = new Map();

    for (const item of existing) {
        byId.set(item.id, item);
    }

    for (const item of incoming) {
        if (!item?.id) continue;
        byId.set(item.id, item);
    }

    return sortRequestsByNewest([...byId.values()]);
}

function normalizeAgentId(value) {
    const normalized = String(value ?? '').trim().toLowerCase();
    if (!normalized || normalized === 'all') {
        return '';
    }

    return normalized;
}

function normalizeAgentFilter(value) {
    const normalized = normalizeAgentId(value);
    if (!normalized) {
        return 'all';
    }

    return normalized;
}

function getRequestAgentId(request) {
    return normalizeAgentId(request?.agentId);
}

function requestMatchesAgentFilter(request, agentFilter) {
    if (agentFilter === 'all') {
        return true;
    }

    const requestAgentId = getRequestAgentId(request);
    if (agentFilter === 'system') {
        return !requestAgentId;
    }

    return requestAgentId === agentFilter;
}

function normalizeSourceFilter(value) {
    const normalized = normalizeUsageSource(value);
    if (!normalized || normalized === 'all') {
        return 'all';
    }

    return normalized;
}

function requestMatchesSourceFilter(request, sourceFilter) {
    if (sourceFilter === 'all') {
        return true;
    }

    return normalizeUsageSource(request?.source) === sourceFilter;
}

function buildAgentFilterOptions(agentDefinitions, hasUnassigned) {
    const optionsById = new Map();
    for (const agent of agentDefinitions ?? []) {
        const agentId = normalizeAgentId(agent?.id);
        if (!agentId) continue;

        const agentName = String(agent?.name ?? '').trim() || agentId;
        optionsById.set(agentId, {
            id: agentId,
            label: agentName,
            isCoding: agentId === 'coding',
        });
    }

    // Orchestrator first, then other agents alphabetically
    const orchestrator = optionsById.get('orchestrator');
    const others = [...optionsById.values()]
        .filter((o) => o.id !== 'orchestrator')
        .sort((a, b) => a.label.localeCompare(b.label));
    const agentOptions = orchestrator ? [orchestrator, ...others] : others;

    const result = [...agentOptions, { id: 'all', label: 'All agents', isCoding: false }];
    if (hasUnassigned) {
        result.push({ id: 'system', label: 'Unassigned', isCoding: false });
    }
    return result;
}

function buildSummary(requests) {
    const totals = {
        requestCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalCostUsd: 0,
        unpricedRequestCount: 0,
    };

    const byModelMap = new Map();

    for (const request of requests) {
        totals.requestCount += 1;
        totals.inputTokens += Number(request.inputTokens) || 0;
        totals.outputTokens += Number(request.outputTokens) || 0;
        totals.totalCostUsd += Number(request.totalCostUsd) || 0;

        if (request.priced !== true) {
            totals.unpricedRequestCount += 1;
        }

        const model = normalizeModelId(request.model);
        const current = byModelMap.get(model) ?? {
            model,
            requestCount: 0,
            inputTokens: 0,
            outputTokens: 0,
            totalCostUsd: 0,
        };

        current.requestCount += 1;
        current.inputTokens += Number(request.inputTokens) || 0;
        current.outputTokens += Number(request.outputTokens) || 0;
        current.totalCostUsd += Number(request.totalCostUsd) || 0;

        byModelMap.set(model, current);
    }

    const byModel = [...byModelMap.values()].sort((a, b) => {
        const byCost = b.totalCostUsd - a.totalCostUsd;
        if (byCost !== 0) return byCost;

        const byCount = b.requestCount - a.requestCount;
        if (byCount !== 0) return byCount;

        return a.model.localeCompare(b.model);
    });

    return { totals, byModel };
}

function statusLabel(value) {
    const normalized = String(value ?? '').trim().toLowerCase();
    if (normalized === 'stopped') return 'Stopped';
    if (normalized === 'error') return 'Error';
    return 'Completed';
}

function statusClassName(value) {
    const normalized = String(value ?? '').trim().toLowerCase();
    if (normalized === 'stopped') return 'stopped';
    if (normalized === 'error') return 'error';
    return 'completed';
}

function getRequestActivityLog(request) {
    return Array.isArray(request?.activityLog) ? request.activityLog : [];
}

export function UsageDashboard({ modelsList, agentDefinitions = [] }) {
    const [range, setRange] = useState(() => getPresetRange('today'));
    const [agentFilter, setAgentFilter] = useState('all');
    const [sourceFilter, setSourceFilter] = useState('all');
    const [requests, setRequests] = useState([]);
    const [isLoading, setIsLoading] = useState(false);
    const [isClearingUsage, setIsClearingUsage] = useState(false);
    const [errorMessage, setErrorMessage] = useState('');
    const [expandedRequestId, setExpandedRequestId] = useState(null);
    const [reloadVersion, setReloadVersion] = useState(0);

    useEffect(() => {
        let cancelled = false;

        const loadUsage = async () => {
            setIsLoading(true);
            setErrorMessage('');

            try {
                const payload = await fetchUsage({
                    startDate: range.startDate,
                    endDate: range.endDate,
                    agentId: agentFilter === 'all' ? undefined : agentFilter,
                    source: sourceFilter === 'all' ? undefined : sourceFilter,
                });
                if (cancelled) return;
                setRequests(sortRequestsByNewest((payload.requests ?? []).filter(isVisibleUsageRequest)));
            } catch (error) {
                if (cancelled) return;
                const message = error instanceof Error ? error.message : 'Failed to load usage.';
                setErrorMessage(message);
                setRequests([]);
            } finally {
                if (!cancelled) {
                    setIsLoading(false);
                }
            }
        };

        loadUsage().catch(() => undefined);

        return () => {
            cancelled = true;
        };
    }, [range.startDate, range.endDate, agentFilter, sourceFilter, reloadVersion]);

    useEffect(() => {
        const source = new EventSource('/api/events');

        source.onmessage = (event) => {
            try {
                const payload = JSON.parse(event.data);
                if (payload?.type === 'usage.cleared') {
                    setRequests([]);
                    setExpandedRequestId(null);
                    return;
                }
                if (payload?.type === 'models.updated') {
                    setReloadVersion((current) => current + 1);
                    return;
                }
                if (payload?.type !== 'usage.logged' || !payload?.request) {
                    return;
                }

                const request = payload.request;
                if (!isVisibleUsageRequest(request)) {
                    return;
                }
                if (!isDateWithinRange(request.dateKey, range.startDate, range.endDate)) {
                    return;
                }
                if (!requestMatchesAgentFilter(request, agentFilter)) {
                    return;
                }
                if (!requestMatchesSourceFilter(request, sourceFilter)) {
                    return;
                }

                setRequests((prev) => mergeRequests(prev, [request]));
            } catch {
                // Ignore malformed payloads.
            }
        };

        return () => {
            source.close();
        };
    }, [range.startDate, range.endDate, agentFilter, sourceFilter]);

    useEffect(() => {
        setExpandedRequestId((current) => {
            if (!current) {
                return current;
            }

            return requests.some((item) => item.id === current) ? current : null;
        });
    }, [requests]);

    const summary = useMemo(() => buildSummary(requests), [requests]);
    const hasUnassigned = useMemo(
        () => requests.some((r) => !normalizeAgentId(r?.agentId)),
        [requests],
    );
    const agentFilterOptions = useMemo(
        () => buildAgentFilterOptions(agentDefinitions, hasUnassigned),
        [agentDefinitions, hasUnassigned],
    );

    useEffect(() => {
        if (agentFilter === 'all' || agentFilter === 'system') {
            return;
        }

        const stillExists = agentFilterOptions.some((option) => option.id === agentFilter);
        if (!stillExists) {
            setAgentFilter('all');
        }
    }, [agentFilter, agentFilterOptions]);

    const agentNameMap = useMemo(() => {
        const map = new Map();
        for (const option of agentFilterOptions) {
            if (option.id === 'all' || option.id === 'system') {
                continue;
            }
            map.set(option.id, option.label);
        }
        return map;
    }, [agentFilterOptions]);

    const selectedAgentLabel = useMemo(() => {
        if (agentFilter === 'all') {
            return 'all agents';
        }
        if (agentFilter === 'system') {
            return 'unassigned requests';
        }

        return `agent ${agentNameMap.get(agentFilter) ?? agentFilter}`;
    }, [agentFilter, agentNameMap]);

    const selectedSourceLabel = useMemo(() => {
        if (sourceFilter === 'all') {
            return 'all sources';
        }

        return `${sourceLabel(sourceFilter)} source`;
    }, [sourceFilter]);

    const modelNameMap = useMemo(() => {
        const map = new Map();
        for (const model of modelsList ?? []) {
            const displayName = model?.displayName || model?.id;
            const normalizedId = normalizeModelId(model?.id);
            const normalizedFullName = normalizeModelId(model?.fullName);
            if (normalizedId) {
                map.set(normalizedId, displayName);
            }
            if (normalizedFullName) {
                map.set(normalizedFullName, displayName);
            }
        }
        return map;
    }, [modelsList]);

    const formatModelName = useCallback((modelId) => {
        const normalized = normalizeModelId(modelId);
        return modelNameMap.get(normalized) ?? normalized;
    }, [modelNameMap]);

    const formatAgentName = useCallback((agentId) => {
        const normalized = normalizeAgentId(agentId);
        if (!normalized) {
            return 'Unassigned';
        }

        return agentNameMap.get(normalized) ?? normalized;
    }, [agentNameMap]);

    const formatRequestAgent = useCallback((request) => {
        return formatAgentName(getRequestAgentId(request));
    }, [formatAgentName]);

    const handleToggleRequest = useCallback((requestId) => {
        setExpandedRequestId((current) => (current === requestId ? null : requestId));
    }, []);

    const handleAgentFilterSelect = useCallback((value) => {
        setAgentFilter(normalizeAgentFilter(value));
    }, []);

    const handleSourceFilterSelect = useCallback((value) => {
        setSourceFilter(normalizeSourceFilter(value));
    }, []);

    const handleClearUsage = useCallback(async () => {
        const confirmed = window.confirm('Delete all usage records? This cannot be undone.');
        if (!confirmed) {
            return;
        }

        setIsClearingUsage(true);
        setErrorMessage('');

        try {
            await clearUsage();
            setRequests([]);
            setExpandedRequestId(null);
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to clear usage.';
            setErrorMessage(message);
        } finally {
            setIsClearingUsage(false);
        }
    }, []);

    return (
        <div className="usage-dashboard">
            <div className="usage-header-row">
                <div>
                    <h2 className="usage-title">Usage</h2>
                    <p className="usage-subtitle">
                        {`Live API request tracking for ${formatRangeLabel(range.startDate, range.endDate)} (${selectedAgentLabel}, ${selectedSourceLabel}).`}
                    </p>
                </div>
            </div>

            <DateRangePicker value={range} onChange={setRange} />

            <div className="usage-filter-row">
                <div className="usage-agent-filters" role="tablist" aria-label="Filter usage by agent">
                    {agentFilterOptions.map((option) => (
                        <button
                            key={option.id}
                            type="button"
                            className={`usage-filter-btn${agentFilter === option.id ? ' active' : ''}${option.isCoding ? ' coding-frame' : ''}`}
                            onClick={() => handleAgentFilterSelect(option.id)}
                        >
                            {option.label}
                        </button>
                    ))}
                </div>
                <div className="usage-agent-filters" role="tablist" aria-label="Filter usage by source">
                    {[
                        { id: 'all', label: 'All sources' },
                        { id: 'chat', label: 'Chat' },
                        { id: 'title', label: 'Title' },
                        { id: 'tool', label: 'Tool' },
                    ].map((option) => (
                        <button
                            key={option.id}
                            type="button"
                            className={`usage-filter-btn${sourceFilter === option.id ? ' active' : ''}`}
                            onClick={() => handleSourceFilterSelect(option.id)}
                        >
                            {option.label}
                        </button>
                    ))}
                </div>
                <button
                    type="button"
                    className="dashboard-danger-btn"
                    onClick={() => void handleClearUsage()}
                    disabled={isClearingUsage}
                >
                    {isClearingUsage ? 'Clearing usage…' : 'Clear all usage'}
                </button>
            </div>

            <div className="usage-stats-grid">
                <div className="usage-stat-card">
                    <span className="usage-stat-label">Requests</span>
                    <strong className="usage-stat-value">{formatNumber(summary.totals.requestCount)}</strong>
                </div>
                <div className="usage-stat-card">
                    <span className="usage-stat-label">Total Cost</span>
                    <strong className="usage-stat-value">{formatCost(summary.totals.totalCostUsd)}</strong>
                </div>
                <div className="usage-stat-card">
                    <span className="usage-stat-label">Input Tokens</span>
                    <strong className="usage-stat-value">{formatNumber(summary.totals.inputTokens)}</strong>
                </div>
                <div className="usage-stat-card">
                    <span className="usage-stat-label">Output Tokens</span>
                    <strong className="usage-stat-value">{formatNumber(summary.totals.outputTokens)}</strong>
                </div>
            </div>

            {summary.totals.unpricedRequestCount > 0 && (
                <p className="usage-note">
                    {summary.totals.unpricedRequestCount} request(s) have unknown model pricing and are shown with $0 cost.
                </p>
            )}

            <div className="usage-models-card">
                <h3>Cost by model</h3>
                {summary.byModel.length === 0 ? (
                    <p className="usage-empty-inline">No model usage for this range.</p>
                ) : (
                    <div className="usage-model-list">
                        {summary.byModel.map((item) => (
                            <div key={item.model} className="usage-model-row">
                                <div className="usage-model-main">
                                    <span className="usage-model-name">{formatModelName(item.model)}</span>
                                    <span className="usage-model-id">{item.model}</span>
                                </div>
                                <div className="usage-model-metrics">
                                    <span>{formatNumber(item.requestCount)} req</span>
                                    <span>{formatCost(item.totalCostUsd)}</span>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            <section className="usage-list-panel">
                <div className="usage-table-wrap">
                    <table className="usage-table">
                        <thead>
                            <tr>
                                <th>Input</th>
                                <th>Output</th>
                                <th>Status</th>
                                <th>Model</th>
                                <th>Source</th>
                                <th>Thinking</th>
                                <th>Created</th>
                                <th>Input Tokens</th>
                                <th>Output Tokens</th>
                                <th>Cost</th>
                            </tr>
                        </thead>
                        <tbody>
                            {requests.length === 0 && !isLoading && !errorMessage && (
                                <tr>
                                    <td colSpan={10}>
                                        <div className="usage-empty-row">No requests for this range.</div>
                                    </td>
                                </tr>
                            )}

                            {isLoading && (
                                <tr>
                                    <td colSpan={10}>
                                        <div className="usage-empty-row">Loading usage…</div>
                                    </td>
                                </tr>
                            )}

                            {errorMessage && !isLoading && (
                                <tr>
                                    <td colSpan={10}>
                                        <div className="usage-empty-row usage-empty-row--error">{errorMessage}</div>
                                    </td>
                                </tr>
                            )}

                            {requests.map((request) => {
                                const expanded = request.id === expandedRequestId;
                                const activityLog = getRequestActivityLog(request);

                                return (
                                    <Fragment key={request.id}>
                                        <tr
                                            className={`usage-summary-row${expanded ? ' active' : ''}`}
                                            onClick={() => handleToggleRequest(request.id)}
                                            role="button"
                                            tabIndex={0}
                                            onKeyDown={(event) => {
                                                if (event.key === 'Enter' || event.key === ' ') {
                                                    event.preventDefault();
                                                    handleToggleRequest(request.id);
                                                }
                                            }}
                                        >
                                            <td title={request.inputText || ''}>
                                                <div className="usage-first-cell">
                                                    <span className={`usage-row-caret${expanded ? ' open' : ''}`}>▸</span>
                                                    <span>{truncatePreview(request.inputText)}</span>
                                                </div>
                                            </td>
                                            <td title={request.outputText || ''}>{truncatePreview(request.outputText)}</td>
                                            <td>
                                                <span className={`usage-status-badge ${statusClassName(request.status)}`}>
                                                    {statusLabel(request.status)}
                                                </span>
                                            </td>
                                            <td title={request.model || ''}>{formatModelName(request.model)}</td>
                                            <td>{sourceLabel(request.source)}</td>
                                            <td>{formatThinkingLevel(request.thinkingLevel)}</td>
                                            <td>{formatCreatedAt(request.createdAt)}</td>
                                            <td>{formatNumber(request.inputTokens)}</td>
                                            <td>{formatNumber(request.outputTokens)}</td>
                                            <td>{formatCost(request.totalCostUsd)}</td>
                                        </tr>

                                        {expanded && (
                                            <tr className="usage-dropdown-row">
                                                <td colSpan={10}>
                                                    <div className="usage-dropdown-card">
                                                        <div className="usage-details-meta">
                                                            <span>Status: <strong>{statusLabel(request.status)}</strong></span>
                                                            <span>Model: <strong>{formatModelName(request.model)}</strong></span>
                                                            <span>Source: <strong>{sourceLabel(request.source)}</strong></span>
                                                            <span>Thinking: <strong>{formatThinkingLevel(request.thinkingLevel)}</strong></span>
                                                            <span>Agent: <strong>{formatRequestAgent(request)}</strong></span>
                                                            <span>Created: <strong>{formatCreatedAt(request.createdAt)}</strong></span>
                                                            <span>Input tokens: <strong>{formatNumber(request.inputTokens)}</strong></span>
                                                            <span>Output tokens: <strong>{formatNumber(request.outputTokens)}</strong></span>
                                                            <span>Cost: <strong>{formatCost(request.totalCostUsd)}</strong></span>
                                                        </div>

                                                        <div className="usage-details-columns">
                                                            <div className="usage-details-block">
                                                                <h4>Input</h4>
                                                                <pre>{request.inputText || '-'}</pre>
                                                            </div>
                                                            <div className="usage-details-block">
                                                                <h4>Output</h4>
                                                                <pre>{request.outputText || '-'}</pre>
                                                            </div>
                                                        </div>

                                                        {activityLog.length > 0 && (
                                                            <BrowserActivityLog
                                                                entries={activityLog}
                                                                title="Browser Activity Log"
                                                                className="usage-browser-activity-log"
                                                            />
                                                        )}
                                                    </div>
                                                </td>
                                            </tr>
                                        )}
                                    </Fragment>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            </section>
        </div>
    );
}
