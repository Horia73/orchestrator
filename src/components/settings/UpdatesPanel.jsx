import { useState, useEffect, useCallback, useRef } from 'react';
import {
    installSoftwareUpdate,
    requestSystemReset,
    requestSystemRestart,
} from '../../api/settingsApi.js';

const GITHUB_OWNER = 'Horia73';
const GITHUB_REPO = 'orchestrator';
const CHECK_CACHE_KEY = 'orchestrator.updates.last_check';
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function readCache() {
    try {
        const raw = localStorage.getItem(CHECK_CACHE_KEY);
        if (!raw) return null;
        const cached = JSON.parse(raw);
        if (
            cached
            && typeof cached === 'object'
            && typeof cached.status === 'string'
            && Date.now() - Number(cached.ts || 0) < CACHE_TTL_MS
        ) {
            return cached;
        }
    } catch {
        return null;
    }
    return null;
}

function writeCache(data) {
    try {
        localStorage.setItem(CHECK_CACHE_KEY, JSON.stringify({ ...data, ts: Date.now() }));
    } catch {
        // noop
    }
}

function timeAgo(dateStr) {
    if (!dateStr) return '';
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    if (days < 30) return `${days}d ago`;
    return new Date(dateStr).toLocaleDateString();
}

function formatVersion(version, fallback) {
    const normalized = String(version || '').trim();
    if (!normalized) return fallback;
    return /^\d/.test(normalized) ? `v${normalized}` : normalized;
}

function buildErrorMessage(error, fallback) {
    const message = String(error?.message || '').trim();
    return message || fallback;
}

function getPhaseLabel(actionKind, actionPhase) {
    if (!actionPhase) return '';

    if (actionKind === 'update') {
        if (actionPhase === 'pulling') return 'Pulling changes…';
        if (actionPhase === 'restarting') return 'Restarting server…';
        if (actionPhase === 'reconnecting') return 'Reconnecting…';
    }

    if (actionKind === 'restart') {
        if (actionPhase === 'restarting') return 'Restarting server…';
        if (actionPhase === 'reconnecting') return 'Reconnecting…';
    }

    if (actionKind === 'factoryReset') {
        if (actionPhase === 'resetting') return 'Running factory reset…';
        if (actionPhase === 'reconnecting') return 'Reconnecting…';
    }

    return 'Working…';
}

function getConfirmSpec(actionKind) {
    if (actionKind === 'update') {
        return {
            title: 'Install update and restart?',
            description: 'This will pull latest changes and restart the server.',
            confirmLabel: 'Install & Restart',
            danger: false,
        };
    }

    if (actionKind === 'restart') {
        return {
            title: 'Restart server now?',
            description: 'Active runs may disconnect briefly while the server restarts.',
            confirmLabel: 'Restart Server',
            danger: false,
        };
    }

    if (actionKind === 'factoryReset') {
        return {
            title: 'Run factory reset?',
            description: 'This recreates ~/.orchestrator and clears runtime data before restarting.',
            confirmLabel: 'Factory Reset',
            danger: true,
        };
    }

    return null;
}

export function UpdatesPanel() {
    const [state, setState] = useState({
        loading: true,
        error: null,
        status: null,
        branch: null,
        remoteRef: null,
        localVersion: null,
        remoteVersion: null,
        localSha: null,
        localShaShort: null,
        remoteSha: null,
        remoteShaShort: null,
        localCommitDate: null,
        remoteCommitDate: null,
        ahead: 0,
        behind: 0,
        canInstall: false,
        checkedAt: null,
    });
    const [actionKind, setActionKind] = useState('');
    const [actionPhase, setActionPhase] = useState('');
    const [actionResult, setActionResult] = useState(null);
    const [connectionState, setConnectionState] = useState('connecting');
    const [confirmAction, setConfirmAction] = useState('');
    const mountedRef = useRef(true);

    const checkForUpdates = useCallback(async ({ force = false, silent = false } = {}) => {
        if (!force) {
            const cached = readCache();
            if (cached) {
                setState((prev) => ({
                    ...prev,
                    loading: false,
                    error: null,
                    ...cached,
                }));
                return;
            }
        }

        if (!silent) {
            setState((prev) => ({ ...prev, loading: true, error: null }));
        }

        try {
            const response = await fetch('/api/update/status', { cache: 'no-store' });
            const payload = await response.json().catch(() => ({}));
            if (!response.ok || payload?.ok === false) {
                throw new Error(payload?.error || `Update check failed (HTTP ${response.status})`);
            }

            const result = {
                status: String(payload.status || ''),
                branch: String(payload.branch || ''),
                remoteRef: String(payload.remoteRef || ''),
                localVersion: payload.localVersion || null,
                remoteVersion: payload.remoteVersion || null,
                localSha: payload.localSha || null,
                localShaShort: payload.localShaShort || null,
                remoteSha: payload.remoteSha || null,
                remoteShaShort: payload.remoteShaShort || null,
                localCommitDate: payload.localCommitDate || null,
                remoteCommitDate: payload.remoteCommitDate || null,
                ahead: Number(payload.ahead || 0),
                behind: Number(payload.behind || 0),
                canInstall: payload.canInstall === true,
                checkedAt: payload.checkedAt || new Date().toISOString(),
            };

            writeCache(result);
            if (mountedRef.current) {
                setState({ loading: false, error: null, ...result });
            }
        } catch (error) {
            if (!mountedRef.current) {
                return;
            }

            if (!silent) {
                setState((prev) => ({
                    ...prev,
                    loading: false,
                    error: buildErrorMessage(error, 'Failed to check updates.'),
                }));
            }
        }
    }, []);

    const waitForReconnect = useCallback(async ({
        maxAttempts = 30,
        intervalMs = 2000,
        successMessage = 'Server restarted successfully.',
        timeoutMessage = 'Server did not come back in time. Please try again.',
    } = {}) => {
        for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
            await sleep(intervalMs);
            try {
                const health = await fetch('/api/health', { signal: AbortSignal.timeout(2000) });
                if (!health.ok) {
                    continue;
                }

                if (!mountedRef.current) {
                    return;
                }

                setActionPhase('');
                setActionKind('');
                setActionResult({ success: true, message: successMessage });
                localStorage.removeItem(CHECK_CACHE_KEY);
                await checkForUpdates({ force: true });
                return;
            } catch {
                // keep polling
            }
        }

        if (!mountedRef.current) {
            return;
        }

        setActionPhase('');
        setActionKind('');
        setActionResult({ success: false, message: timeoutMessage });
    }, [checkForUpdates]);

    useEffect(() => {
        checkForUpdates().catch(() => undefined);
    }, [checkForUpdates]);

    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
        };
    }, []);

    useEffect(() => {
        const source = new EventSource('/api/events');
        setConnectionState('connecting');

        source.onopen = () => {
            if (!mountedRef.current) return;
            setConnectionState('connected');
        };

        source.onerror = () => {
            if (!mountedRef.current) return;
            setConnectionState('disconnected');
        };

        return () => {
            source.close();
        };
    }, []);

    useEffect(() => {
        const timer = setInterval(() => {
            if (actionPhase) {
                return;
            }
            checkForUpdates({ force: true, silent: true }).catch(() => undefined);
        }, 5000);

        return () => {
            clearInterval(timer);
        };
    }, [actionPhase, checkForUpdates]);

    useEffect(() => {
        if (!confirmAction) {
            return undefined;
        }

        const handleKeyDown = (event) => {
            if (event.key === 'Escape') {
                setConfirmAction('');
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [confirmAction]);

    const runInstall = useCallback(async () => {
        setActionResult(null);
        setActionKind('update');
        setActionPhase('pulling');

        try {
            const payload = await installSoftwareUpdate();

            if (!payload.restarting) {
                setActionKind('');
                setActionPhase('');
                setActionResult({ success: true, message: payload.message || 'No update applied.' });
                await checkForUpdates({ force: true });
                return;
            }

            setActionPhase('restarting');
            setActionResult({ success: true, message: payload.message || 'Update installed. Restarting…' });
            await sleep(1200);
            if (!mountedRef.current) return;

            setActionPhase('reconnecting');
            await waitForReconnect({
                maxAttempts: 30,
                intervalMs: 2000,
                successMessage: 'Update complete! Server restarted successfully.',
                timeoutMessage: 'Server did not come back after 60s. Try restarting manually.',
            });
        } catch (error) {
            if (!mountedRef.current) {
                return;
            }
            setActionKind('');
            setActionPhase('');
            setActionResult({
                success: false,
                message: buildErrorMessage(error, 'Failed to install update.'),
            });
        }
    }, [checkForUpdates, waitForReconnect]);

    const runRestart = useCallback(async () => {
        setActionResult(null);
        setActionKind('restart');
        setActionPhase('restarting');

        try {
            await requestSystemRestart();
            if (!mountedRef.current) return;

            setActionPhase('reconnecting');
            await waitForReconnect({
                maxAttempts: 40,
                intervalMs: 1500,
                successMessage: 'Restart complete. Server is connected again.',
                timeoutMessage: 'Server did not come back after restart.',
            });
        } catch (error) {
            if (!mountedRef.current) {
                return;
            }
            setActionKind('');
            setActionPhase('');
            setActionResult({
                success: false,
                message: buildErrorMessage(error, 'Failed to restart server.'),
            });
        }
    }, [waitForReconnect]);

    const runFactoryReset = useCallback(async () => {
        setActionResult(null);
        setActionKind('factoryReset');
        setActionPhase('resetting');

        try {
            await requestSystemReset();
            if (!mountedRef.current) return;

            setActionPhase('reconnecting');
            await waitForReconnect({
                maxAttempts: 80,
                intervalMs: 2000,
                successMessage: 'Factory reset complete. Runtime was recreated and server is back online.',
                timeoutMessage: 'Server did not come back after factory reset.',
            });
        } catch (error) {
            if (!mountedRef.current) {
                return;
            }
            setActionKind('');
            setActionPhase('');
            setActionResult({
                success: false,
                message: buildErrorMessage(error, 'Failed to run factory reset.'),
            });
        }
    }, [waitForReconnect]);

    const installedLabel = formatVersion(
        state.localVersion,
        state.localShaShort ? `#${state.localShaShort}` : '…',
    );
    const latestLabel = formatVersion(
        state.remoteVersion,
        state.remoteShaShort ? `#${state.remoteShaShort}` : '—',
    );
    const hasUpdate = !state.loading && !state.error && state.behind > 0;
    const canAutoInstall = hasUpdate && state.ahead === 0 && state.canInstall;
    const isUpToDate = !state.loading && !state.error && state.behind === 0 && state.ahead === 0;
    const isAheadOnly = !state.loading && !state.error && state.behind === 0 && state.ahead > 0;
    const isDiverged = !state.loading && !state.error && state.behind > 0 && state.ahead > 0;
    const remoteLabel = state.remoteRef || `origin/${state.branch || 'main'}`;
    const compareUrl = state.localSha && state.remoteSha
        ? `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/compare/${state.localSha}...${state.remoteSha}`
        : null;
    const isBusy = Boolean(actionPhase);
    const currentPhaseLabel = getPhaseLabel(actionKind, actionPhase);
    const connectionLabel = connectionState === 'connected'
        ? 'Connected'
        : connectionState === 'disconnected'
            ? 'Disconnected'
            : 'Connecting';
    const confirmSpec = getConfirmSpec(confirmAction);

    const openConfirm = useCallback((nextAction) => {
        if (isBusy) {
            return;
        }
        setConfirmAction(nextAction);
    }, [isBusy]);

    const closeConfirm = useCallback(() => {
        if (isBusy) {
            return;
        }
        setConfirmAction('');
    }, [isBusy]);

    const handleConfirmAction = useCallback(() => {
        const selectedAction = confirmAction;
        setConfirmAction('');

        if (selectedAction === 'update') {
            void runInstall();
            return;
        }

        if (selectedAction === 'restart') {
            void runRestart();
            return;
        }

        if (selectedAction === 'factoryReset') {
            void runFactoryReset();
        }
    }, [confirmAction, runFactoryReset, runInstall, runRestart]);

    return (
        <div className="updates-panel">
            <div className="updates-header-row">
                <div>
                    <h2 className="updates-title">Software Updates</h2>
                    <p className="updates-subtitle">Checks your local branch against origin in git</p>
                </div>
                <button
                    className="updates-check-btn"
                    onClick={() => checkForUpdates({ force: true })}
                    disabled={state.loading || isBusy}
                    type="button"
                >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 6 }}>
                        <path d="M23 4v6h-6" /><path d="M1 20v-6h6" />
                        <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                    </svg>
                    {state.loading ? 'Checking…' : 'Check now'}
                </button>
            </div>

            <div className="updates-live-row">
                <span className={`updates-connection-pill is-${connectionState}`}>
                    <span className="updates-connection-dot" aria-hidden="true" />
                    {connectionLabel}
                </span>
                <span className="updates-live-meta">Live refresh: 5s</span>
                {state.checkedAt && <span className="updates-live-meta">Last check: {timeAgo(state.checkedAt)}</span>}
            </div>

            <div className="updates-operations-card">
                <div className="updates-operations-header">
                    <h3>Server Controls</h3>
                    <p>Restart the server or run a full factory reset.</p>
                </div>
                <div className="updates-maintenance-actions">
                    <button
                        className="updates-maintenance-btn"
                        type="button"
                        onClick={() => openConfirm('restart')}
                        disabled={isBusy}
                    >
                        Restart Server
                    </button>
                    <button
                        className="updates-maintenance-btn danger"
                        type="button"
                        onClick={() => openConfirm('factoryReset')}
                        disabled={isBusy}
                    >
                        Factory Reset
                    </button>
                </div>
                <p className="updates-maintenance-note">
                    Factory reset recreates <code>~/.orchestrator</code>.
                </p>
            </div>

            {currentPhaseLabel && (
                <div className="updates-action-progress">
                    <span className="updates-spinner" />
                    <span>{currentPhaseLabel}</span>
                </div>
            )}

            <div className="updates-version-cards">
                <div className={`updates-version-card ${isUpToDate ? 'up-to-date' : ''}`}>
                    <span className="updates-version-label">Installed</span>
                    <span className="updates-version-value">{installedLabel}</span>
                    {state.localShaShort && (
                        <span className="updates-version-date">#{state.localShaShort}</span>
                    )}
                </div>
                <div className={`updates-version-card ${hasUpdate ? 'has-update' : ''}`}>
                    <span className="updates-version-label">{remoteLabel}</span>
                    <span className="updates-version-value">{latestLabel}</span>
                    {state.remoteCommitDate && (
                        <span className="updates-version-date">{timeAgo(state.remoteCommitDate)}</span>
                    )}
                </div>
            </div>

            {state.error && (
                <div className="updates-error">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
                    </svg>
                    <span>Failed to check for updates: {state.error}</span>
                </div>
            )}

            {!state.loading && isUpToDate && !actionPhase && (
                <div className="updates-up-to-date">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M20 6L9 17l-5-5" />
                    </svg>
                    <span>Local branch is synchronized with {remoteLabel}</span>
                </div>
            )}

            {!state.loading && isAheadOnly && !actionPhase && (
                <div className="updates-up-to-date">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M20 6L9 17l-5-5" />
                    </svg>
                    <span>Local branch is ahead of {remoteLabel} by {state.ahead} commit{state.ahead === 1 ? '' : 's'}</span>
                </div>
            )}

            {!state.loading && !state.error && hasUpdate && (
                <div className="updates-available">
                    <div className="updates-available-header">
                        <div className="updates-available-left">
                            <span className="updates-badge">{isDiverged ? 'Branches diverged' : 'Update available'}</span>
                            <span className="updates-upgrade-path">
                                Behind by {state.behind} commit{state.behind === 1 ? '' : 's'}
                            </span>
                        </div>
                        {compareUrl && (
                            <a
                                className="updates-release-link"
                                href={compareUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                            >
                                View compare →
                            </a>
                        )}
                    </div>

                    <div className="updates-release-notes">
                        <h4>Git status</h4>
                        <pre>
                            {state.localShaShort || 'local'} → {state.remoteShaShort || 'remote'}
                            {`\n`}
                            branch: {state.branch || 'main'}
                            {`\n`}
                            ahead: {state.ahead} / behind: {state.behind}
                        </pre>
                    </div>

                    {!canAutoInstall && isDiverged && (
                        <div className="updates-error">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
                            </svg>
                            <span>Local and origin have diverged. Resolve git merge/rebase manually, then run update again.</span>
                        </div>
                    )}

                    {canAutoInstall && (
                        <button
                            className="updates-install-btn"
                            onClick={() => openConfirm('update')}
                            disabled={isBusy}
                            type="button"
                        >
                            {actionKind === 'update' && actionPhase ? (
                                <>
                                    <span className="updates-spinner" />
                                    {getPhaseLabel('update', actionPhase)}
                                </>
                            ) : (
                                <>
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                                        <polyline points="7 10 12 15 17 10" />
                                        <line x1="12" y1="15" x2="12" y2="3" />
                                    </svg>
                                    Install & Restart
                                </>
                            )}
                        </button>
                    )}
                </div>
            )}

            {actionResult && !actionPhase && (
                <div className={`updates-install-result ${actionResult.success ? 'success' : 'error'}`}>
                    {actionResult.success ? (
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M20 6L9 17l-5-5" />
                        </svg>
                    ) : (
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <circle cx="12" cy="12" r="10" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" />
                        </svg>
                    )}
                    <span>{actionResult.message}</span>
                </div>
            )}

            {confirmSpec && (
                <div
                    className="updates-confirm-overlay"
                    role="presentation"
                    onClick={closeConfirm}
                >
                    <div
                        className="updates-confirm-modal"
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="updates-confirm-title"
                        onClick={(event) => event.stopPropagation()}
                    >
                        <h3 id="updates-confirm-title">{confirmSpec.title}</h3>
                        <p>{confirmSpec.description}</p>
                        <div className="updates-confirm-actions">
                            <button
                                className="updates-confirm-btn"
                                type="button"
                                onClick={closeConfirm}
                                disabled={isBusy}
                            >
                                Cancel
                            </button>
                            <button
                                className={`updates-confirm-btn primary${confirmSpec.danger ? ' danger' : ''}`}
                                type="button"
                                onClick={handleConfirmAction}
                                disabled={isBusy}
                            >
                                {confirmSpec.confirmLabel}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
