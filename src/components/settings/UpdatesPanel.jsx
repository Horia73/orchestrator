import { useState, useEffect, useCallback } from 'react';

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

/* ─── Component ─────────────────────────────────────────────────────── */

export function UpdatesPanel({ currentVersion }) {
    const [state, setState] = useState({
        loading: true,
        error: null,
        latestTag: null,
        releaseUrl: null,
        releaseNotes: null,
        publishedAt: null,
    });
    const [installing, setInstalling] = useState(false);
    const [installResult, setInstallResult] = useState(null);

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
            // Try releases first, fallback to tags
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

    const handleInstall = useCallback(async () => {
        setInstalling(true);
        setInstallResult(null);
        try {
            const res = await fetch('/api/update', { method: 'POST' });
            const data = await res.json().catch(() => ({}));
            if (res.ok) {
                setInstallResult({ success: true, message: data.message || 'Update installed! Restart the server to apply.' });
            } else {
                setInstallResult({ success: false, message: data.error || `Update failed (HTTP ${res.status})` });
            }
        } catch (err) {
            setInstallResult({ success: false, message: err.message });
        } finally {
            setInstalling(false);
        }
    }, []);

    const localVersion = currentVersion || '0.0.0';
    const hasUpdate = state.latestTag && isNewer(state.latestTag, localVersion);

    return (
        <div className="updates-panel">
            <div className="updates-header-row">
                <div>
                    <h2 className="updates-title">Updates</h2>
                    <p className="updates-subtitle">Check for new versions of Orchestrator</p>
                </div>
                <button
                    className="updates-check-btn"
                    onClick={() => checkForUpdates(true)}
                    disabled={state.loading}
                    type="button"
                >
                    {state.loading ? 'Checking…' : 'Check for updates'}
                </button>
            </div>

            <div className="updates-version-cards">
                <div className="updates-version-card">
                    <span className="updates-version-label">Current Version</span>
                    <span className="updates-version-value">{localVersion}</span>
                </div>
                <div className="updates-version-card">
                    <span className="updates-version-label">Latest Available</span>
                    <span className="updates-version-value">
                        {state.loading ? '…' : state.latestTag || '—'}
                    </span>
                    {state.publishedAt && (
                        <span className="updates-version-date">
                            {new Date(state.publishedAt).toLocaleDateString()}
                        </span>
                    )}
                </div>
            </div>

            {state.error && (
                <div className="updates-error">
                    Failed to check for updates: {state.error}
                </div>
            )}

            {!state.loading && !state.error && hasUpdate && (
                <div className="updates-available">
                    <div className="updates-available-header">
                        <span className="updates-badge">New version available</span>
                        {state.releaseUrl && (
                            <a
                                className="updates-release-link"
                                href={state.releaseUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                            >
                                View on GitHub
                            </a>
                        )}
                    </div>

                    {state.releaseNotes && (
                        <div className="updates-release-notes">
                            <h4>Release Notes</h4>
                            <pre>{state.releaseNotes}</pre>
                        </div>
                    )}

                    <button
                        className="updates-install-btn"
                        onClick={handleInstall}
                        disabled={installing}
                        type="button"
                    >
                        {installing ? 'Installing…' : `Install ${state.latestTag}`}
                    </button>

                    {installResult && (
                        <div className={`updates-install-result ${installResult.success ? 'success' : 'error'}`}>
                            {installResult.message}
                        </div>
                    )}
                </div>
            )}

            {!state.loading && !state.error && !hasUpdate && state.latestTag && (
                <div className="updates-up-to-date">
                    You're up to date!
                </div>
            )}
        </div>
    );
}
