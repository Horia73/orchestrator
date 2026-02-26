import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { fetchSystemLogs } from '../../api/settingsApi.js';
import { DateRangePicker } from './DateRangePicker.jsx';
import { getPresetRange, isDateWithinRange, parseDateKey } from './dateRangeUtils.js';

const LONG_DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
});

function formatDateKey(value) {
    return LONG_DATE_FORMATTER.format(parseDateKey(value));
}

function formatRangeLabel(startDate, endDate) {
    if (startDate === endDate) {
        return formatDateKey(startDate);
    }

    return `${formatDateKey(startDate)} - ${formatDateKey(endDate)}`;
}

function formatCreatedAt(value) {
    const timestamp = Number(value);
    if (!Number.isFinite(timestamp) || timestamp <= 0) {
        return '-';
    }

    return new Date(timestamp).toLocaleString();
}

function stringifyData(value) {
    if (value === undefined) {
        return '-';
    }

    try {
        return JSON.stringify(value, null, 2);
    } catch {
        return String(value);
    }
}

function mergeLogs(existing, incoming) {
    const byId = new Map();

    for (const item of existing) {
        byId.set(item.id, item);
    }

    for (const item of incoming) {
        if (!item?.id) continue;
        byId.set(item.id, item);
    }

    return [...byId.values()]
        .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))
        .slice(0, 500);
}

function normalizeLevel(value) {
    const normalized = String(value ?? '').trim().toLowerCase();
    if (normalized === 'warn' || normalized === 'error') {
        return normalized;
    }
    return 'info';
}

function levelBadgeLabel(value) {
    const level = normalizeLevel(value);
    if (level === 'warn') return 'Warn';
    if (level === 'error') return 'Error';
    return 'Info';
}

function levelClassName(value) {
    return normalizeLevel(value);
}

function sourceLabel(value) {
    const raw = String(value ?? '').trim();
    return raw || 'system';
}

function buildStats(logs) {
    const stats = {
        total: logs.length,
        info: 0,
        warn: 0,
        error: 0,
    };

    for (const log of logs) {
        const level = normalizeLevel(log.level);
        if (level === 'warn') {
            stats.warn += 1;
        } else if (level === 'error') {
            stats.error += 1;
        } else {
            stats.info += 1;
        }
    }

    return stats;
}

export function SystemLogsDashboard() {
    const [range, setRange] = useState(() => getPresetRange('today'));
    const [level, setLevel] = useState('all');
    const [logs, setLogs] = useState([]);
    const [isLoading, setIsLoading] = useState(false);
    const [errorMessage, setErrorMessage] = useState('');
    const [expandedLogId, setExpandedLogId] = useState(null);

    useEffect(() => {
        let cancelled = false;

        const loadLogs = async () => {
            setIsLoading(true);
            setErrorMessage('');

            try {
                const payload = await fetchSystemLogs({
                    startDate: range.startDate,
                    endDate: range.endDate,
                    level: level === 'all' ? undefined : level,
                    limit: 500,
                });

                if (cancelled) return;
                setLogs(payload.logs ?? []);
            } catch (error) {
                if (cancelled) return;
                const message = error instanceof Error ? error.message : 'Failed to load logs.';
                setErrorMessage(message);
                setLogs([]);
            } finally {
                if (!cancelled) {
                    setIsLoading(false);
                }
            }
        };

        loadLogs().catch(() => undefined);

        return () => {
            cancelled = true;
        };
    }, [range.startDate, range.endDate, level]);

    useEffect(() => {
        const source = new EventSource('/api/events');

        source.onmessage = (event) => {
            try {
                const payload = JSON.parse(event.data);
                if (payload?.type !== 'system.log' || !payload?.log) {
                    return;
                }

                const log = payload.log;
                if (!isDateWithinRange(log.dateKey, range.startDate, range.endDate)) {
                    return;
                }

                if (level !== 'all' && normalizeLevel(log.level) !== level) {
                    return;
                }

                setLogs((prev) => mergeLogs(prev, [log]));
            } catch {
                // Ignore malformed payloads.
            }
        };

        return () => {
            source.close();
        };
    }, [range.startDate, range.endDate, level]);

    useEffect(() => {
        setExpandedLogId((current) => {
            if (!current) {
                return current;
            }

            return logs.some((item) => item.id === current) ? current : null;
        });
    }, [logs]);

    const stats = useMemo(() => buildStats(logs), [logs]);

    const toggleLog = useCallback((logId) => {
        setExpandedLogId((current) => (current === logId ? null : logId));
    }, []);

    return (
        <div className="usage-dashboard logs-dashboard">
            <div className="usage-header-row">
                <div>
                    <h2 className="usage-title">System Logs</h2>
                    <p className="usage-subtitle">
                        {`API/server events for ${formatRangeLabel(range.startDate, range.endDate)}.`}
                    </p>
                </div>
            </div>

            <DateRangePicker value={range} onChange={setRange} />

            <div className="logs-toolbar">
                <div className="logs-level-filters" role="tablist" aria-label="Filter logs by level">
                    {[
                        { id: 'all', label: 'All' },
                        { id: 'info', label: 'Info' },
                        { id: 'warn', label: 'Warn' },
                        { id: 'error', label: 'Error' },
                    ].map((option) => (
                        <button
                            key={option.id}
                            type="button"
                            className={`logs-level-btn${level === option.id ? ' active' : ''}`}
                            onClick={() => setLevel(option.id)}
                        >
                            {option.label}
                        </button>
                    ))}
                </div>

                <div className="logs-counts">
                    <span>Total: <strong>{stats.total}</strong></span>
                    <span>Info: <strong>{stats.info}</strong></span>
                    <span>Warn: <strong>{stats.warn}</strong></span>
                    <span>Error: <strong>{stats.error}</strong></span>
                </div>
            </div>

            <section className="usage-list-panel">
                <div className="usage-table-wrap">
                    <table className="usage-table logs-table">
                        <thead>
                            <tr>
                                <th>Time</th>
                                <th>Level</th>
                                <th>Source</th>
                                <th>Event</th>
                                <th>Message</th>
                            </tr>
                        </thead>
                        <tbody>
                            {logs.length === 0 && !isLoading && !errorMessage && (
                                <tr>
                                    <td colSpan={5}>
                                        <div className="usage-empty-row">No logs for this range.</div>
                                    </td>
                                </tr>
                            )}

                            {isLoading && (
                                <tr>
                                    <td colSpan={5}>
                                        <div className="usage-empty-row">Loading logs…</div>
                                    </td>
                                </tr>
                            )}

                            {errorMessage && !isLoading && (
                                <tr>
                                    <td colSpan={5}>
                                        <div className="usage-empty-row usage-empty-row--error">{errorMessage}</div>
                                    </td>
                                </tr>
                            )}

                            {logs.map((log) => {
                                const expanded = log.id === expandedLogId;

                                return (
                                    <Fragment key={log.id}>
                                        <tr
                                            className={`usage-summary-row${expanded ? ' active' : ''}`}
                                            onClick={() => toggleLog(log.id)}
                                            role="button"
                                            tabIndex={0}
                                            onKeyDown={(event) => {
                                                if (event.key === 'Enter' || event.key === ' ') {
                                                    event.preventDefault();
                                                    toggleLog(log.id);
                                                }
                                            }}
                                        >
                                            <td>
                                                <div className="usage-first-cell">
                                                    <span className={`usage-row-caret${expanded ? ' open' : ''}`}>▸</span>
                                                    <span>{formatCreatedAt(log.createdAt)}</span>
                                                </div>
                                            </td>
                                            <td>
                                                <span className={`usage-status-badge ${levelClassName(log.level)}`}>
                                                    {levelBadgeLabel(log.level)}
                                                </span>
                                            </td>
                                            <td>{sourceLabel(log.source)}</td>
                                            <td>{log.eventType || '-'}</td>
                                            <td>{log.message || '-'}</td>
                                        </tr>

                                        {expanded && (
                                            <tr className="usage-dropdown-row">
                                                <td colSpan={5}>
                                                    <div className="usage-dropdown-card">
                                                        <div className="usage-details-meta">
                                                            <span>Level: <strong>{levelBadgeLabel(log.level)}</strong></span>
                                                            <span>Source: <strong>{sourceLabel(log.source)}</strong></span>
                                                            <span>Event: <strong>{log.eventType || '-'}</strong></span>
                                                            <span>Created: <strong>{formatCreatedAt(log.createdAt)}</strong></span>
                                                        </div>

                                                        <div className="usage-details-block">
                                                            <h4>Message</h4>
                                                            <pre>{log.message || '-'}</pre>
                                                        </div>

                                                        <div className="usage-details-block">
                                                            <h4>Data</h4>
                                                            <pre>{stringifyData(log.data)}</pre>
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
