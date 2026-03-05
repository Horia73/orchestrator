import { useState, useEffect, useCallback, useRef } from 'react';

const GITHUB_OWNER = 'Horia73';
const GITHUB_REPO = 'orchestrator';
const CHECK_CACHE_KEY = 'orchestrator.updates.last_check';
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

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
        /* noop */
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
    const [installing, setInstalling] = useState(false);
    const [installPhase, setInstallPhase] = useState(null); // 'pulling' | 'restarting' | 'reconnecting'
    const [installResult, setInstallResult] = useState(null);
    const reconnectTimer = useRef(null);

    const checkForUpdates = useCallback(async (force = false) => {
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

        setState((prev) => ({ ...prev, loading: true, error: null }));

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
            setState({ loading: false, error: null, ...result });
        } catch (error) {
            setState((prev) => ({
                ...prev,
                loading: false,
                error: buildErrorMessage(error, 'Failed to check updates.'),
            }));
        }
    }, []);

    useEffect(() => {
        checkForUpdates();
    }, [checkForUpdates]);

    useEffect(() => () => {
        if (reconnectTimer.current) {
            clearInterval(reconnectTimer.current);
        }
    }, []);

    const handleInstall = useCallback(async () => {
        setInstalling(true);
        setInstallResult(null);
        setInstallPhase('pulling');

        try {
            const response = await fetch('/api/update', { method: 'POST' });
            const payload = await response.json().catch(() => ({}));

            if (!response.ok) {
                setInstallResult({ success: false, message: payload.error || `Update failed (HTTP ${response.status})` });
                setInstallPhase(null);
                return;
            }

            if (!payload.restarting) {
                setInstallResult({ success: true, message: payload.message || 'No update applied.' });
                setInstallPhase(null);
                await checkForUpdates(true);
                return;
            }

            setInstallPhase('restarting');
            setInstallResult({ success: true, message: payload.message || 'Update installed. Restarting…' });

            await new Promise((resolve) => setTimeout(resolve, 2000));
            setInstallPhase('reconnecting');

            let attempts = 0;
            reconnectTimer.current = setInterval(async () => {
                attempts += 1;
                try {
                    const health = await fetch('/api/health', { signal: AbortSignal.timeout(2000) });
                    if (!health.ok) {
                        return;
                    }
                    clearInterval(reconnectTimer.current);
                    reconnectTimer.current = null;
                    setInstallPhase(null);
                    setInstallResult({ success: true, message: 'Update complete! Server restarted successfully.' });
                    localStorage.removeItem(CHECK_CACHE_KEY);
                    await checkForUpdates(true);
                } catch {
                    if (attempts > 30) {
                        clearInterval(reconnectTimer.current);
                        reconnectTimer.current = null;
                        setInstallPhase(null);
                        setInstallResult({ success: false, message: 'Server did not come back after 60s. Try restarting manually.' });
                    }
                }
            }, 2000);
        } catch (error) {
            setInstallResult({
                success: false,
                message: buildErrorMessage(error, 'Failed to install update.'),
            });
            setInstallPhase(null);
        } finally {
            setInstalling(false);
        }
    }, [checkForUpdates]);

    const installedLabel = formatVersion(
        state.localVersion,
        state.localShaShort ? `#${state.localShaShort}` : '…'
    );
    const latestLabel = formatVersion(
        state.remoteVersion,
        state.remoteShaShort ? `#${state.remoteShaShort}` : '—'
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

    return (
        <div className="updates-panel">
            <div className="updates-header-row">
                <div>
                    <h2 className="updates-title">Software Updates</h2>
                    <p className="updates-subtitle">Checks your local branch against origin in git</p>
                </div>
                <button
                    className="updates-check-btn"
                    onClick={() => checkForUpdates(true)}
                    disabled={state.loading || !!installPhase}
                    type="button"
                >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 6 }}>
                        <path d="M23 4v6h-6" /><path d="M1 20v-6h6" />
                        <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                    </svg>
                    {state.loading ? 'Checking…' : 'Check now'}
                </button>
            </div>

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

            {!state.loading && isUpToDate && !installPhase && (
                <div className="updates-up-to-date">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M20 6L9 17l-5-5" />
                    </svg>
                    <span>Local branch is synchronized with {remoteLabel}</span>
                </div>
            )}

            {!state.loading && isAheadOnly && !installPhase && (
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
                            onClick={handleInstall}
                            disabled={installing || !!installPhase}
                            type="button"
                        >
                            {installPhase === 'pulling' && (
                                <>
                                    <span className="updates-spinner" />
                                    Pulling changes…
                                </>
                            )}
                            {installPhase === 'restarting' && (
                                <>
                                    <span className="updates-spinner" />
                                    Restarting server…
                                </>
                            )}
                            {installPhase === 'reconnecting' && (
                                <>
                                    <span className="updates-spinner" />
                                    Reconnecting…
                                </>
                            )}
                            {!installPhase && (
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

            {installResult && !installPhase && (
                <div className={`updates-install-result ${installResult.success ? 'success' : 'error'}`}>
                    {installResult.success ? (
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M20 6L9 17l-5-5" />
                        </svg>
                    ) : (
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <circle cx="12" cy="12" r="10" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" />
                        </svg>
                    )}
                    <span>{installResult.message}</span>
                </div>
            )}
        </div>
    );
}
