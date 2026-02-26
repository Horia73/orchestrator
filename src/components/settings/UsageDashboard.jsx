import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { fetchUsage } from '../../api/settingsApi.js';
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

export function UsageDashboard({ modelsList }) {
    const [range, setRange] = useState(() => getPresetRange('today'));
    const [requests, setRequests] = useState([]);
    const [isLoading, setIsLoading] = useState(false);
    const [errorMessage, setErrorMessage] = useState('');
    const [expandedRequestId, setExpandedRequestId] = useState(null);

    useEffect(() => {
        let cancelled = false;

        const loadUsage = async () => {
            setIsLoading(true);
            setErrorMessage('');

            try {
                const payload = await fetchUsage({
                    startDate: range.startDate,
                    endDate: range.endDate,
                });
                if (cancelled) return;
                setRequests(sortRequestsByNewest(payload.requests ?? []));
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
    }, [range.startDate, range.endDate]);

    useEffect(() => {
        const source = new EventSource('/api/events');

        source.onmessage = (event) => {
            try {
                const payload = JSON.parse(event.data);
                if (payload?.type !== 'usage.logged' || !payload?.request) {
                    return;
                }

                const request = payload.request;
                if (!isDateWithinRange(request.dateKey, range.startDate, range.endDate)) {
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
    }, [range.startDate, range.endDate]);

    useEffect(() => {
        setExpandedRequestId((current) => {
            if (!current) {
                return current;
            }

            return requests.some((item) => item.id === current) ? current : null;
        });
    }, [requests]);

    const summary = useMemo(() => buildSummary(requests), [requests]);

    const modelNameMap = useMemo(() => {
        const map = new Map();
        for (const model of modelsList ?? []) {
            if (!model?.id) continue;
            map.set(String(model.id), model.displayName || model.id);
        }
        return map;
    }, [modelsList]);

    const formatModelName = useCallback((modelId) => {
        const normalized = normalizeModelId(modelId);
        return modelNameMap.get(normalized) ?? normalized;
    }, [modelNameMap]);

    const handleToggleRequest = useCallback((requestId) => {
        setExpandedRequestId((current) => (current === requestId ? null : requestId));
    }, []);

    return (
        <div className="usage-dashboard">
            <div className="usage-header-row">
                <div>
                    <h2 className="usage-title">Usage</h2>
                    <p className="usage-subtitle">
                        {`Live API request tracking for ${formatRangeLabel(range.startDate, range.endDate)}.`}
                    </p>
                </div>
            </div>

            <DateRangePicker value={range} onChange={setRange} />

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
                                <th>Created</th>
                                <th>Input Tokens</th>
                                <th>Output Tokens</th>
                                <th>Cost</th>
                            </tr>
                        </thead>
                        <tbody>
                            {requests.length === 0 && !isLoading && !errorMessage && (
                                <tr>
                                    <td colSpan={8}>
                                        <div className="usage-empty-row">No requests for this range.</div>
                                    </td>
                                </tr>
                            )}

                            {isLoading && (
                                <tr>
                                    <td colSpan={8}>
                                        <div className="usage-empty-row">Loading usage…</div>
                                    </td>
                                </tr>
                            )}

                            {errorMessage && !isLoading && (
                                <tr>
                                    <td colSpan={8}>
                                        <div className="usage-empty-row usage-empty-row--error">{errorMessage}</div>
                                    </td>
                                </tr>
                            )}

                            {requests.map((request) => {
                                const expanded = request.id === expandedRequestId;

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
                                            <td>{formatCreatedAt(request.createdAt)}</td>
                                            <td>{formatNumber(request.inputTokens)}</td>
                                            <td>{formatNumber(request.outputTokens)}</td>
                                            <td>{formatCost(request.totalCostUsd)}</td>
                                        </tr>

                                        {expanded && (
                                            <tr className="usage-dropdown-row">
                                                <td colSpan={8}>
                                                    <div className="usage-dropdown-card">
                                                        <div className="usage-details-meta">
                                                            <span>Status: <strong>{statusLabel(request.status)}</strong></span>
                                                            <span>Model: <strong>{formatModelName(request.model)}</strong></span>
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
