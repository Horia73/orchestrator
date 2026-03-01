import { useState, useEffect, useCallback, useRef } from 'react';

/* ─── Constants ─────────────────────────────────────────────────────── */

const GITHUB_OWNER = 'Horia73';
const GITHUB_REPO = 'orchestrator';
const CHECK_CACHE_KEY = 'orchestrator.updates.last_check';
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/* ─── Helpers ───────────────────────────────────────────────────────── */

function parseVersion(tag) {
    const cleaned = String(tag ?? '').replace(/^v/i, '').trim();
    const parts = cleaned.split('.').map(Number);
    return { raw: cleaned, major: parts[0] || 0, minor: parts[1] || 0, patch: parts[2] || 0 };
}

function isNewer(remote, local) {
    const r = parseVersion(remote);
    const l = parseVersion(local);
    if (r.major !== l.major) return r.major > l.major;
    if (r.minor !== l.minor) return r.minor > l.minor;
    return r.patch > l.patch;
}

function readCache() {
    try {
        const raw = localStorage.getItem(CHECK_CACHE_KEY);
        if (!raw) return null;
        const cached = JSON.parse(raw);
        if (Date.now() - cached.ts < CACHE_TTL_MS) return cached;
    } catch { /* noop */ }
    return null;
}

function writeCache(data) {
    try {
        localStorage.setItem(CHECK_CACHE_KEY, JSON.stringify({ ...data, ts: Date.now() }));
    } catch { /* noop */ }
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

/* ─── Component ─────────────────────────────────────────────────────── */

export function UpdatesPanel() {
    const [currentVersion, setCurrentVersion] = useState(null);
    const [state, setState] = useState({
        loading: true,
        error: null,
        latestTag: null,
        releaseUrl: null,
        releaseNotes: null,
        publishedAt: null,
    });
    const [installing, setInstalling] = useState(false);
    const [installPhase, setInstallPhase] = useState(null); // 'pulling' | 'installing' | 'restarting' | 'reconnecting'
    const [installResult, setInstallResult] = useState(null);
    const reconnectTimer = useRef(null);

    // Fetch current version from server
    useEffect(() => {
        fetch('/api/version')
            .then(r => r.json())
            .then(d => setCurrentVersion(d.version || '0.0.0'))
            .catch(() => setCurrentVersion('0.0.0'));
    }, []);

    const checkForUpdates = useCallback(async (force = false) => {
        if (!force) {
            const cached = readCache();
            if (cached) {
                setState({
                    loading: false,
                    error: null,
                    latestTag: cached.latestTag,
                    releaseUrl: cached.releaseUrl,
                    releaseNotes: cached.releaseNotes,
                    publishedAt: cached.publishedAt,
                });
                return;
            }
        }

        setState((prev) => ({ ...prev, loading: true, error: null }));

        try {
            let latestTag = null;
            let releaseUrl = null;
            let releaseNotes = null;
            let publishedAt = null;

            const relRes = await fetch(
                `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`,
                { headers: { Accept: 'application/vnd.github.v3+json' } }
            );

            if (relRes.ok) {
                const rel = await relRes.json();
                latestTag = rel.tag_name;
                releaseUrl = rel.html_url;
                releaseNotes = rel.body || null;
                publishedAt = rel.published_at || null;
            } else {
                // Fallback: fetch latest tag
                const tagsRes = await fetch(
                    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/tags?per_page=1`,
                    { headers: { Accept: 'application/vnd.github.v3+json' } }
                );
                if (tagsRes.ok) {
                    const tags = await tagsRes.json();
                    if (tags.length > 0) {
                        latestTag = tags[0].name;
                        releaseUrl = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/tag/${tags[0].name}`;
                    }
                }
            }

            if (!latestTag) {
                // No releases or tags — use latest commit
                const commitRes = await fetch(
                    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/commits?per_page=1`,
                    { headers: { Accept: 'application/vnd.github.v3+json' } }
                );
                if (commitRes.ok) {
                    const commits = await commitRes.json();
                    if (commits.length > 0) {
                        latestTag = commits[0].sha.slice(0, 7);
                        releaseUrl = commits[0].html_url;
                        publishedAt = commits[0].commit?.committer?.date || null;
                        releaseNotes = commits[0].commit?.message || null;
                    }
                }
            }

            const result = { latestTag, releaseUrl, releaseNotes, publishedAt };
            writeCache(result);
            setState({ loading: false, error: null, ...result });
        } catch (err) {
            setState((prev) => ({ ...prev, loading: false, error: err.message }));
        }
    }, []);

    useEffect(() => {
        checkForUpdates();
    }, [checkForUpdates]);

    // Cleanup reconnect timer
    useEffect(() => () => {
        if (reconnectTimer.current) clearInterval(reconnectTimer.current);
    }, []);

    const handleInstall = useCallback(async () => {
        setInstalling(true);
        setInstallResult(null);
        setInstallPhase('pulling');

        try {
            const res = await fetch('/api/update', { method: 'POST' });
            const data = await res.json().catch(() => ({}));

            if (!res.ok) {
                setInstallResult({ success: false, message: data.error || `Update failed (HTTP ${res.status})` });
                setInstallPhase(null);
                return;
            }

            if (!data.restarting) {
                // Already up to date, no restart
                setInstallResult({ success: true, message: data.message });
                setInstallPhase(null);
                return;
            }

            // Server is restarting — wait for it to come back
            setInstallPhase('restarting');
            setInstallResult({ success: true, message: data.message });

            // Poll /api/health until the server comes back
            await new Promise(resolve => setTimeout(resolve, 2000));
            setInstallPhase('reconnecting');

            let attempts = 0;
            reconnectTimer.current = setInterval(async () => {
                attempts++;
                try {
                    const health = await fetch('/api/health', { signal: AbortSignal.timeout(2000) });
                    if (health.ok) {
                        clearInterval(reconnectTimer.current);
                        reconnectTimer.current = null;
                        // Fetch new version
                        try {
                            const vRes = await fetch('/api/version');
                            const vData = await vRes.json();
                            setCurrentVersion(vData.version || '0.0.0');
                        } catch { /* ignore */ }
                        setInstallPhase(null);
                        setInstallResult({ success: true, message: 'Update complete! Server restarted successfully.' });
                        // Clear update cache so it re-checks
                        localStorage.removeItem(CHECK_CACHE_KEY);
                        checkForUpdates(true);
                    }
                } catch {
                    // Still down
                    if (attempts > 30) {
                        clearInterval(reconnectTimer.current);
                        reconnectTimer.current = null;
                        setInstallPhase(null);
                        setInstallResult({ success: false, message: 'Server did not come back after 60s. Try restarting manually.' });
                    }
                }
            }, 2000);
        } catch (err) {
            setInstallResult({ success: false, message: err.message });
            setInstallPhase(null);
        } finally {
            setInstalling(false);
        }
    }, [checkForUpdates]);

    const localVersion = currentVersion || '…';
    const hasUpdate = currentVersion && state.latestTag && isNewer(state.latestTag, localVersion);
    const isUpToDate = currentVersion && state.latestTag && !hasUpdate && !state.error;

    return (
        <div className="updates-panel">
            {/* ── Header ── */}
            <div className="updates-header-row">
                <div>
                    <h2 className="updates-title">Software Updates</h2>
                    <p className="updates-subtitle">Keep Orchestrator up to date with the latest features and fixes</p>
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

            {/* ── Version cards ── */}
            <div className="updates-version-cards">
                <div className={`updates-version-card ${isUpToDate ? 'up-to-date' : ''}`}>
                    <span className="updates-version-label">Installed</span>
                    <span className="updates-version-value">{localVersion === '…' ? '…' : `v${localVersion}`}</span>
                </div>
                <div className={`updates-version-card ${hasUpdate ? 'has-update' : ''}`}>
                    <span className="updates-version-label">Latest</span>
                    <span className="updates-version-value">
                        {state.loading ? '…' : state.latestTag ? (/^\d/.test(state.latestTag) ? `v${state.latestTag}` : state.latestTag) : '—'}
                    </span>
                    {state.publishedAt && (
                        <span className="updates-version-date">
                            {timeAgo(state.publishedAt)}
                        </span>
                    )}
                </div>
            </div>

            {/* ── Error ── */}
            {state.error && (
                <div className="updates-error">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
                    </svg>
                    <span>Failed to check for updates: {state.error}</span>
                </div>
            )}

            {/* ── Up to date ── */}
            {!state.loading && isUpToDate && !installPhase && (
                <div className="updates-up-to-date">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M20 6L9 17l-5-5" />
                    </svg>
                    <span>You're running the latest version</span>
                </div>
            )}

            {/* ── Update available ── */}
            {!state.loading && !state.error && hasUpdate && (
                <div className="updates-available">
                    <div className="updates-available-header">
                        <div className="updates-available-left">
                            <span className="updates-badge">Update available</span>
                            <span className="updates-upgrade-path">
                                v{currentVersion} → {/^\d/.test(state.latestTag) ? `v${state.latestTag}` : state.latestTag}
                            </span>
                        </div>
                        {state.releaseUrl && (
                            <a
                                className="updates-release-link"
                                href={state.releaseUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                            >
                                View on GitHub →
                            </a>
                        )}
                    </div>

                    {state.releaseNotes && (
                        <div className="updates-release-notes">
                            <h4>What's new</h4>
                            <pre>{state.releaseNotes}</pre>
                        </div>
                    )}

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
                </div>
            )}

            {/* ── Install result ── */}
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

            {/* ── How to release ── */}
            <div className="updates-footer">
                <p className="updates-footer-text">
                    To publish a new release, create a git tag and push it:
                </p>
                <code className="updates-footer-code">
                    npm version patch && git push && git push --tags
                </code>
            </div>
        </div>
    );
}
