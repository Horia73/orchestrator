import { useCallback, useEffect, useState } from 'react';
import { fetchMcpServers, saveMcpServers } from '../../api/settingsApi.js';

function createDraftId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return `draft-${crypto.randomUUID()}`;
    }

    return `draft-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function createEmptyServer() {
    return {
        id: createDraftId(),
        name: '',
        toolPrefix: '',
        enabled: true,
        transport: 'stdio',
        timeoutMs: 20000,
        command: '',
        args: [],
        cwd: '',
        env: {},
        url: '',
        headers: {},
        effectiveToolPrefix: 'mcp',
        validationErrors: [],
        connectionStatus: 'invalid',
        tools: [],
        toolCount: 0,
        lastError: '',
    };
}

function toEditableServer(server) {
    const source = server && typeof server === 'object' ? server : {};
    return {
        id: String(source.id ?? '').trim() || createDraftId(),
        name: String(source.name ?? '').trim(),
        toolPrefix: String(source.toolPrefix ?? '').trim(),
        enabled: source.enabled !== false,
        transport: String(source.transport ?? 'stdio').trim() || 'stdio',
        timeoutMs: Number.isFinite(Number(source.timeoutMs)) ? Number(source.timeoutMs) : 20000,
        command: String(source.command ?? '').trim(),
        args: Array.isArray(source.args) ? source.args.map((item) => String(item ?? '')) : [],
        cwd: String(source.cwd ?? '').trim(),
        env: source.env && typeof source.env === 'object' && !Array.isArray(source.env) ? source.env : {},
        url: String(source.url ?? '').trim(),
        headers: source.headers && typeof source.headers === 'object' && !Array.isArray(source.headers) ? source.headers : {},
        effectiveToolPrefix: String(source.effectiveToolPrefix ?? '').trim() || 'mcp',
        validationErrors: Array.isArray(source.validationErrors) ? source.validationErrors : [],
        connectionStatus: String(source.connectionStatus ?? 'idle').trim() || 'idle',
        tools: Array.isArray(source.tools) ? source.tools : [],
        toolCount: Number.isFinite(Number(source.toolCount)) ? Number(source.toolCount) : 0,
        lastError: String(source.lastError ?? '').trim(),
    };
}

function serializeServer(server) {
    const base = {
        id: server.id,
        name: server.name,
        toolPrefix: server.toolPrefix,
        enabled: server.enabled,
        transport: server.transport,
        timeoutMs: Number.isFinite(Number(server.timeoutMs)) ? Number(server.timeoutMs) : 20000,
    };

    if (server.transport === 'stdio') {
        return {
            ...base,
            command: server.command,
            args: Array.isArray(server.args) ? server.args : [],
            cwd: server.cwd,
            env: server.env && typeof server.env === 'object' ? server.env : {},
        };
    }

    return {
        ...base,
        url: server.url,
        headers: server.headers && typeof server.headers === 'object' ? server.headers : {},
    };
}

function parseListInput(value) {
    return String(value ?? '')
        .split(/\r?\n/)
        .map((item) => item.trim())
        .filter(Boolean);
}

function formatListInput(value) {
    return Array.isArray(value) ? value.join('\n') : '';
}

function parseKeyValueLines(value) {
    const result = {};
    const lines = String(value ?? '').split(/\r?\n/);

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
            continue;
        }

        const separatorIndex = trimmed.includes('=')
            ? trimmed.indexOf('=')
            : trimmed.indexOf(':');
        if (separatorIndex === -1) {
            result[trimmed] = '';
            continue;
        }

        const key = trimmed.slice(0, separatorIndex).trim();
        const nextValue = trimmed.slice(separatorIndex + 1).trim();
        if (!key) {
            continue;
        }

        result[key] = nextValue;
    }

    return result;
}

function formatKeyValueLines(value) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    return Object.entries(source)
        .map(([key, nextValue]) => `${key}=${nextValue}`)
        .join('\n');
}

function getStatusLabel(server) {
    const status = String(server.connectionStatus ?? '').trim().toLowerCase();
    if (status === 'connected') {
        return 'Connected';
    }
    if (status === 'error') {
        return 'Error';
    }
    if (status === 'disabled') {
        return 'Disabled';
    }
    if (status === 'invalid') {
        return 'Invalid';
    }

    return 'Idle';
}

function getTransportLabel(transport) {
    const normalized = String(transport ?? '').trim().toLowerCase();
    if (normalized === 'streamable-http') {
        return 'Streamable HTTP';
    }
    if (normalized === 'sse') {
        return 'SSE';
    }
    return 'stdio';
}

export function McpPanel() {
    const [servers, setServers] = useState([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [dirty, setDirty] = useState(false);
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');

    const loadServers = useCallback(async () => {
        setLoading(true);
        setError('');

        try {
            const nextServers = await fetchMcpServers({ includeTools: true });
            setServers(nextServers.map(toEditableServer));
            setDirty(false);
        } catch (nextError) {
            setError(nextError.message);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        loadServers().catch(() => undefined);
    }, [loadServers]);

    const updateServer = useCallback((serverId, updater) => {
        setServers((currentServers) => currentServers.map((server) => {
            if (server.id !== serverId) {
                return server;
            }

            const nextServer = typeof updater === 'function' ? updater(server) : { ...server, ...updater };
            return toEditableServer(nextServer);
        }));
        setDirty(true);
        setNotice('');
    }, []);

    const handleAddServer = useCallback(() => {
        setServers((currentServers) => [...currentServers, createEmptyServer()]);
        setDirty(true);
        setNotice('');
    }, []);

    const handleRemoveServer = useCallback((serverId) => {
        setServers((currentServers) => currentServers.filter((server) => server.id !== serverId));
        setDirty(true);
        setNotice('');
    }, []);

    const handleSave = useCallback(async () => {
        setSaving(true);
        setError('');
        setNotice('');

        try {
            await saveMcpServers(servers.map(serializeServer));
            const refreshedServers = await fetchMcpServers({ includeTools: true });
            setServers(refreshedServers.map(toEditableServer));
            setDirty(false);
            setNotice('MCP settings saved.');
        } catch (nextError) {
            setError(nextError.message);
        } finally {
            setSaving(false);
        }
    }, [servers]);

    const enabledServers = servers.filter((server) => server.enabled);
    const connectedServers = servers.filter((server) => String(server.connectionStatus ?? '').trim().toLowerCase() === 'connected');
    const problematicServers = servers.filter((server) => (
        String(server.connectionStatus ?? '').trim().toLowerCase() === 'error'
        || Array.isArray(server.validationErrors) && server.validationErrors.length > 0
    ));
    const totalTools = servers.reduce((sum, server) => sum + (Number(server.toolCount) || 0), 0);

    const overviewStats = [
        { label: 'Configured', value: String(servers.length).padStart(2, '0') },
        { label: 'Enabled', value: String(enabledServers.length).padStart(2, '0') },
        { label: 'Live tools', value: String(totalTools).padStart(2, '0') },
        { label: 'Needs attention', value: String(problematicServers.length).padStart(2, '0') },
    ];

    if (loading) {
        return (
            <div className="settings-placeholder">
                <h2>Loading MCP servers...</h2>
                <p>Inspecting configured MCP integrations.</p>
            </div>
        );
    }

    return (
        <div className="mcp-panel">
            <div className="mcp-panel-header">
                <div className="mcp-panel-intro">
                    <h2 className="mcp-panel-title">Model Context Protocol</h2>
                    <p className="mcp-panel-copy">
                        Add stdio or remote MCP servers. Tools are surfaced directly in chat and auto-namespaced with a stable prefix.
                    </p>
                    <div className="mcp-panel-note">
                        {connectedServers.length > 0
                            ? `${connectedServers.length} server${connectedServers.length === 1 ? '' : 's'} connected right now.`
                            : 'No live MCP connections yet.'}
                    </div>
                </div>
                <div className="mcp-panel-actions">
                    <button className="mcp-secondary-btn" type="button" onClick={() => loadServers().catch(() => undefined)}>
                        Refresh
                    </button>
                    <button className="mcp-secondary-btn" type="button" onClick={handleAddServer}>
                        Add server
                    </button>
                    <button
                        className="mcp-primary-btn"
                        type="button"
                        onClick={() => handleSave().catch(() => undefined)}
                        disabled={saving || !dirty}
                    >
                        {saving ? 'Saving...' : 'Save changes'}
                    </button>
                </div>
            </div>

            <div className="mcp-overview-grid">
                {overviewStats.map((item) => (
                    <div className="mcp-overview-card" key={item.label}>
                        <span>{item.label}</span>
                        <strong>{item.value}</strong>
                    </div>
                ))}
            </div>

            {error && <div className="mcp-banner mcp-banner-error">{error}</div>}
            {!error && notice && <div className="mcp-banner mcp-banner-success">{notice}</div>}

            {servers.length === 0 ? (
                <div className="settings-placeholder">
                    <h2>No MCP servers configured</h2>
                    <p>Add a server to expose external MCP tools inside the app.</p>
                </div>
            ) : (
                <div className="mcp-server-list">
                    {servers.map((server) => (
                        <section className="mcp-server-card" key={server.id}>
                            <div className="mcp-server-shell">
                                <div className="mcp-server-main">
                                    <div className="mcp-server-header">
                                        <div className="mcp-server-heading">
                                            <span className="mcp-server-kicker">MCP server</span>
                                            <h3>{server.name || 'New MCP server'}</h3>
                                            <p className="mcp-server-caption">
                                                {server.transport === 'stdio'
                                                    ? 'Local process transport for workspace-native tools.'
                                                    : 'Remote transport for hosted MCP endpoints.'}
                                            </p>
                                        </div>

                                        <div className="mcp-server-actions">
                                            <span className={`mcp-status-badge status-${server.connectionStatus}`}>
                                                {getStatusLabel(server)}
                                            </span>
                                            <button
                                                className="mcp-danger-btn"
                                                type="button"
                                                onClick={() => handleRemoveServer(server.id)}
                                            >
                                                Remove
                                            </button>
                                        </div>
                                    </div>

                                    <div className="mcp-summary-strip">
                                        <div className="mcp-summary-pill">
                                            <span>Transport</span>
                                            <strong>{getTransportLabel(server.transport)}</strong>
                                        </div>
                                        <div className="mcp-summary-pill">
                                            <span>Effective prefix</span>
                                            <strong>{server.effectiveToolPrefix || 'mcp'}</strong>
                                        </div>
                                        <div className="mcp-summary-pill">
                                            <span>Visible tools</span>
                                            <strong>{server.toolCount || 0}</strong>
                                        </div>
                                        <div className="mcp-summary-pill">
                                            <span>Timeout</span>
                                            <strong>{server.timeoutMs} ms</strong>
                                        </div>
                                    </div>

                                    <div className="mcp-section-card">
                                        <div className="mcp-section-header">
                                            <div>
                                                <h4>Identity</h4>
                                                <p>Controls naming, exposure, and invocation style inside the app.</p>
                                            </div>
                                        </div>

                                        <div className="mcp-grid">
                                            <label className="mcp-field">
                                                <span>Name</span>
                                                <input
                                                    type="text"
                                                    value={server.name}
                                                    onChange={(event) => updateServer(server.id, { name: event.target.value })}
                                                    placeholder="github"
                                                />
                                            </label>

                                            <label className="mcp-field">
                                                <span>Tool prefix</span>
                                                <input
                                                    type="text"
                                                    value={server.toolPrefix}
                                                    onChange={(event) => updateServer(server.id, { toolPrefix: event.target.value })}
                                                    placeholder="github"
                                                />
                                            </label>

                                            <label className="mcp-field">
                                                <span>Transport</span>
                                                <select
                                                    value={server.transport}
                                                    onChange={(event) => updateServer(server.id, (currentServer) => ({
                                                        ...currentServer,
                                                        transport: event.target.value,
                                                    }))}
                                                >
                                                    <option value="stdio">stdio</option>
                                                    <option value="streamable-http">streamable-http</option>
                                                    <option value="sse">sse</option>
                                                </select>
                                            </label>

                                            <label className="mcp-field">
                                                <span>Timeout (ms)</span>
                                                <input
                                                    type="number"
                                                    min="1000"
                                                    step="1000"
                                                    value={server.timeoutMs}
                                                    onChange={(event) => updateServer(server.id, {
                                                        timeoutMs: Number(event.target.value) || 20000,
                                                    })}
                                                />
                                            </label>
                                        </div>
                                    </div>

                                    <div className="mcp-section-card">
                                        <div className="mcp-section-header">
                                            <div>
                                                <h4>Connection</h4>
                                                <p>
                                                    {server.transport === 'stdio'
                                                        ? 'Launch a local process and speak MCP over stdin/stdout.'
                                                        : 'Connect to an externally hosted MCP server with optional headers.'}
                                                </p>
                                            </div>
                                        </div>

                                        {server.transport === 'stdio' ? (
                                            <div className="mcp-grid">
                                                <label className="mcp-field mcp-field-wide">
                                                    <span>Command</span>
                                                    <input
                                                        type="text"
                                                        value={server.command}
                                                        onChange={(event) => updateServer(server.id, { command: event.target.value })}
                                                        placeholder="npx"
                                                    />
                                                </label>

                                                <label className="mcp-field">
                                                    <span>Working directory</span>
                                                    <input
                                                        type="text"
                                                        value={server.cwd}
                                                        onChange={(event) => updateServer(server.id, { cwd: event.target.value })}
                                                        placeholder="/absolute/path"
                                                    />
                                                </label>

                                                <label className="mcp-field mcp-field-wide">
                                                    <span>Args (one per line)</span>
                                                    <textarea
                                                        value={formatListInput(server.args)}
                                                        onChange={(event) => updateServer(server.id, {
                                                            args: parseListInput(event.target.value),
                                                        })}
                                                        placeholder={'-y\n@modelcontextprotocol/server-filesystem\n/Users/horia/orchestrator'}
                                                    />
                                                </label>

                                                <label className="mcp-field mcp-field-wide">
                                                    <span>Environment (KEY=VALUE)</span>
                                                    <textarea
                                                        value={formatKeyValueLines(server.env)}
                                                        onChange={(event) => updateServer(server.id, {
                                                            env: parseKeyValueLines(event.target.value),
                                                        })}
                                                        placeholder={'GITHUB_TOKEN=...\nAPI_KEY=...'}
                                                    />
                                                </label>
                                            </div>
                                        ) : (
                                            <div className="mcp-grid">
                                                <label className="mcp-field mcp-field-wide">
                                                    <span>URL</span>
                                                    <input
                                                        type="text"
                                                        value={server.url}
                                                        onChange={(event) => updateServer(server.id, { url: event.target.value })}
                                                        placeholder="https://example.com/mcp"
                                                    />
                                                </label>

                                                <label className="mcp-field mcp-field-wide">
                                                    <span>Headers (KEY=VALUE)</span>
                                                    <textarea
                                                        value={formatKeyValueLines(server.headers)}
                                                        onChange={(event) => updateServer(server.id, {
                                                            headers: parseKeyValueLines(event.target.value),
                                                        })}
                                                        placeholder={'Authorization=Bearer ...\nX-API-Key=...'}
                                                    />
                                                </label>
                                            </div>
                                        )}
                                    </div>
                                </div>

                                <aside className="mcp-server-side">
                                    <div className="mcp-side-card">
                                        <div className="mcp-side-card-header">
                                            <div>
                                                <h4>Runtime</h4>
                                                <p>Toggle exposure without deleting the configuration.</p>
                                            </div>
                                        </div>
                                        <label className="mcp-toggle">
                                            <input
                                                type="checkbox"
                                                checked={server.enabled}
                                                onChange={(event) => updateServer(server.id, { enabled: event.target.checked })}
                                            />
                                            <span>{server.enabled ? 'Server enabled' : 'Server disabled'}</span>
                                        </label>
                                    </div>

                                    {(server.validationErrors.length > 0 || server.lastError) && (
                                        <div className="mcp-errors">
                                            {server.validationErrors.map((message, index) => (
                                                <p key={`${server.id}-validation-${index}`}>{message}</p>
                                            ))}
                                            {server.lastError && <p>{server.lastError}</p>}
                                        </div>
                                    )}

                                    <div className="mcp-side-card">
                                        <div className="mcp-side-card-header">
                                            <div>
                                                <h4>Exposed tools</h4>
                                                <p>These names are what the runtime can call from chat.</p>
                                            </div>
                                        </div>

                                        {server.tools.length > 0 ? (
                                            <div className="mcp-tools">
                                                {server.tools.map((tool) => (
                                                    <div className="mcp-tool-pill" key={`${server.id}-${tool.alias}`}>
                                                        <code>{tool.alias}</code>
                                                        {tool.description && <span>{tool.description}</span>}
                                                    </div>
                                                ))}
                                            </div>
                                        ) : (
                                            <div className="mcp-side-empty">
                                                Save and refresh to inspect the resolved tool catalog.
                                            </div>
                                        )}
                                    </div>
                                </aside>
                            </div>
                        </section>
                    ))}
                </div>
            )}
        </div>
    );
}
