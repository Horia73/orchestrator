import { useCallback, useEffect, useState } from 'react';
import { fetchMcpServerTools, fetchMcpServers, saveMcpServers } from '../../api/settingsApi.js';

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

function hasServerIssues(server) {
    return (Array.isArray(server.validationErrors) && server.validationErrors.length > 0) || Boolean(server.lastError);
}

function isDraftServer(serverId) {
    return String(serverId ?? '').startsWith('draft-');
}

export function McpPanel() {
    const [servers, setServers] = useState([]);
    const [editingServerId, setEditingServerId] = useState('');
    const [loading, setLoading] = useState(true);
    const [loadingToolsServerId, setLoadingToolsServerId] = useState('');
    const [saving, setSaving] = useState(false);
    const [dirty, setDirty] = useState(false);
    const [error, setError] = useState('');

    const loadServers = useCallback(async ({ nextEditingServerId = null } = {}) => {
        setLoading(true);
        setError('');

        try {
            const nextServers = await fetchMcpServers({ includeTools: false });
            const editableServers = nextServers.map(toEditableServer);

            setServers(editableServers);
            setDirty(false);
            setEditingServerId((currentEditingServerId) => {
                const preferredServerId = nextEditingServerId === null ? currentEditingServerId : nextEditingServerId;
                if (preferredServerId && editableServers.some((server) => server.id === preferredServerId)) {
                    return preferredServerId;
                }
                return '';
            });
        } catch (nextError) {
            setError(nextError.message);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        loadServers().catch(() => undefined);
    }, [loadServers]);

    const editingServer = servers.find((server) => server.id === editingServerId) ?? null;
    const isLoadingEditedServerTools = Boolean(editingServer && loadingToolsServerId === editingServer.id);
    const isCreatingServer = Boolean(editingServer && isDraftServer(editingServer.id));

    useEffect(() => {
        if (!editingServerId || loading || saving || dirty) {
            return undefined;
        }

        const server = servers.find((candidate) => candidate.id === editingServerId);
        if (!server) {
            return undefined;
        }

        const canLoadTools = !isDraftServer(server.id)
            && server.enabled
            && server.validationErrors.length === 0
            && server.connectionStatus === 'idle'
            && server.tools.length === 0
            && loadingToolsServerId !== server.id;

        if (!canLoadTools) {
            return undefined;
        }

        let cancelled = false;
        setLoadingToolsServerId(server.id);

        fetchMcpServerTools(server.id)
            .then((serverSnapshot) => {
                if (cancelled || !serverSnapshot) {
                    return;
                }

                setServers((currentServers) => currentServers.map((currentServer) => {
                    if (currentServer.id !== server.id) {
                        return currentServer;
                    }

                    return toEditableServer(serverSnapshot);
                }));
            })
            .catch((nextError) => {
                if (cancelled) {
                    return;
                }

                setServers((currentServers) => currentServers.map((currentServer) => {
                    if (currentServer.id !== server.id) {
                        return currentServer;
                    }

                    return toEditableServer({
                        ...currentServer,
                        connectionStatus: 'error',
                        lastError: nextError.message,
                        tools: [],
                        toolCount: 0,
                    });
                }));
            })
            .finally(() => {
                if (!cancelled) {
                    setLoadingToolsServerId('');
                }
            });

        return () => {
            cancelled = true;
        };
    }, [dirty, editingServerId, loading, loadingToolsServerId, saving, servers]);

    const updateServer = useCallback((serverId, updater) => {
        setServers((currentServers) => currentServers.map((server) => {
            if (server.id !== serverId) {
                return server;
            }

            const nextServer = typeof updater === 'function' ? updater(server) : { ...server, ...updater };
            return toEditableServer(nextServer);
        }));
        setDirty(true);
        setError('');
    }, []);

    const handleAddServer = useCallback(() => {
        const nextServer = createEmptyServer();
        setServers((currentServers) => [...currentServers, nextServer]);
        setEditingServerId(nextServer.id);
        setDirty(true);
        setError('');
    }, []);

    const handleEditServer = useCallback((serverId) => {
        setEditingServerId(serverId);
        setError('');
    }, []);

    const handleRemoveServer = useCallback((serverId) => {
        setServers((currentServers) => currentServers.filter((server) => server.id !== serverId));
        setEditingServerId((currentEditingServerId) => (currentEditingServerId === serverId ? '' : currentEditingServerId));
        setDirty(true);
        setError('');
    }, []);

    const handleSave = useCallback(async () => {
        setSaving(true);
        setError('');

        try {
            await saveMcpServers(servers.map(serializeServer));
            await loadServers({ nextEditingServerId: editingServerId });
        } catch (nextError) {
            setError(nextError.message);
        } finally {
            setSaving(false);
        }
    }, [editingServerId, loadServers, servers]);

    const handleCancelEdit = useCallback(() => {
        if (editingServer && isDraftServer(editingServer.id)) {
            setServers((currentServers) => currentServers.filter((server) => server.id !== editingServer.id));
            setEditingServerId('');
            setDirty(false);
            setError('');
            return;
        }

        if (dirty) {
            loadServers({ nextEditingServerId: '' }).catch(() => undefined);
            return;
        }

        setEditingServerId('');
    }, [dirty, editingServer, loadServers]);

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
                    <p className="mcp-panel-copy">Configure MCP servers.</p>
                </div>
                <div className="mcp-panel-actions">
                    <button
                        className="mcp-secondary-btn"
                        type="button"
                        onClick={() => loadServers().catch(() => undefined)}
                        disabled={saving}
                    >
                        Refresh
                    </button>
                </div>
            </div>

            {error && <div className="mcp-banner mcp-banner-error">{error}</div>}

            {servers.length === 0 ? (
                <div className="mcp-empty-state">
                    <div className="mcp-empty-state-card">
                        <span className="mcp-empty-eyebrow">Model Context Protocol</span>
                        <h3>No MCP servers yet</h3>
                        <p>Add the first server and then edit only what matters.</p>
                        <button className="mcp-primary-btn" type="button" onClick={handleAddServer}>
                            Add first server
                        </button>
                    </div>
                </div>
            ) : (
                <div className="mcp-workbench">
                    {!isCreatingServer && (
                        <section className="mcp-list-section">
                            <div className="mcp-list-header">
                                <h3>Servers</h3>
                            </div>

                            <div className="mcp-server-grid">
                                {servers.map((server) => (
                                    <section className={`mcp-server-card${editingServerId === server.id ? ' is-editing' : ''}`} key={server.id}>
                                        <div className="mcp-card-header">
                                            <div className="mcp-card-name">
                                                <strong>{server.name || 'New MCP server'}</strong>
                                                <span>{getStatusLabel(server)}</span>
                                            </div>
                                            <span className={`mcp-status-dot status-${server.connectionStatus}`} aria-hidden="true" />
                                        </div>

                                        <div className="mcp-card-tags">
                                            <span>{getTransportLabel(server.transport)}</span>
                                            {!server.enabled && <span>Disabled</span>}
                                            {server.tools.length > 0 && <span>{server.tools.length} tools</span>}
                                        </div>

                                        {hasServerIssues(server) && (
                                            <div className="mcp-server-item-alert">Check config</div>
                                        )}

                                        <div className="mcp-card-actions">
                                            <button
                                                className="mcp-secondary-btn"
                                                type="button"
                                                onClick={() => handleEditServer(server.id)}
                                            >
                                                Edit
                                            </button>
                                            <button
                                                className="mcp-danger-btn"
                                                type="button"
                                                onClick={() => handleRemoveServer(server.id)}
                                            >
                                                Remove
                                            </button>
                                        </div>
                                    </section>
                                ))}
                            </div>

                            <div className="mcp-list-footer">
                                <button className="mcp-secondary-btn" type="button" onClick={handleAddServer} disabled={saving}>
                                    Add server
                                </button>
                            </div>
                        </section>
                    )}

                    {editingServer ? (
                        <section className="mcp-editor-shell">
                            <div className="mcp-editor-header">
                                <div className="mcp-editor-heading">
                                    <h3>{editingServer.name || 'New MCP server'}</h3>
                                    <p>{getTransportLabel(editingServer.transport)}</p>
                                </div>
                                <span className={`mcp-status-badge status-${editingServer.connectionStatus}`}>
                                    {getStatusLabel(editingServer)}
                                </span>
                            </div>

                            <div className="mcp-editor-main">
                                <div className="mcp-section-card">
                                    <div className="mcp-section-header">
                                        <h4>General</h4>
                                    </div>

                                    <div className="mcp-section-row">
                                        <label className="mcp-toggle">
                                            <input
                                                type="checkbox"
                                                checked={editingServer.enabled}
                                                onChange={(event) => updateServer(editingServer.id, { enabled: event.target.checked })}
                                            />
                                            <span>{editingServer.enabled ? 'Enabled' : 'Disabled'}</span>
                                        </label>
                                    </div>

                                    <div className="mcp-grid">
                                        <label className="mcp-field">
                                            <span>Name</span>
                                            <input
                                                type="text"
                                                value={editingServer.name}
                                                onChange={(event) => updateServer(editingServer.id, { name: event.target.value })}
                                                placeholder="github"
                                            />
                                        </label>

                                        <label className="mcp-field">
                                            <span>Tool prefix</span>
                                            <input
                                                type="text"
                                                value={editingServer.toolPrefix}
                                                onChange={(event) => updateServer(editingServer.id, { toolPrefix: event.target.value })}
                                                placeholder="github"
                                            />
                                        </label>

                                        <label className="mcp-field">
                                            <span>Transport</span>
                                            <select
                                                value={editingServer.transport}
                                                onChange={(event) => updateServer(editingServer.id, (currentServer) => ({
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
                                                value={editingServer.timeoutMs}
                                                onChange={(event) => updateServer(editingServer.id, {
                                                    timeoutMs: Number(event.target.value) || 20000,
                                                })}
                                            />
                                        </label>
                                    </div>
                                </div>

                                <div className="mcp-section-card">
                                    <div className="mcp-section-header">
                                        <h4>Connection</h4>
                                    </div>

                                    {editingServer.transport === 'stdio' ? (
                                        <div className="mcp-grid">
                                            <label className="mcp-field mcp-field-wide">
                                                <span>Command</span>
                                                <input
                                                    type="text"
                                                    value={editingServer.command}
                                                    onChange={(event) => updateServer(editingServer.id, { command: event.target.value })}
                                                    placeholder="npx"
                                                />
                                            </label>

                                            <label className="mcp-field">
                                                <span>Working directory</span>
                                                <input
                                                    type="text"
                                                    value={editingServer.cwd}
                                                    onChange={(event) => updateServer(editingServer.id, { cwd: event.target.value })}
                                                    placeholder="/absolute/path"
                                                />
                                            </label>

                                            <label className="mcp-field mcp-field-wide">
                                                <span>Args (one per line)</span>
                                                <textarea
                                                    value={formatListInput(editingServer.args)}
                                                    onChange={(event) => updateServer(editingServer.id, {
                                                        args: parseListInput(event.target.value),
                                                    })}
                                                    placeholder={'-y\n@modelcontextprotocol/server-filesystem\n/absolute/path/to/workspace'}
                                                />
                                            </label>

                                            <label className="mcp-field mcp-field-wide">
                                                <span>Environment (KEY=VALUE)</span>
                                                <textarea
                                                    value={formatKeyValueLines(editingServer.env)}
                                                    onChange={(event) => updateServer(editingServer.id, {
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
                                                    value={editingServer.url}
                                                    onChange={(event) => updateServer(editingServer.id, { url: event.target.value })}
                                                    placeholder="https://example.com/mcp"
                                                />
                                            </label>

                                            <label className="mcp-field mcp-field-wide">
                                                <span>Headers (KEY=VALUE)</span>
                                                <textarea
                                                    value={formatKeyValueLines(editingServer.headers)}
                                                    onChange={(event) => updateServer(editingServer.id, {
                                                        headers: parseKeyValueLines(event.target.value),
                                                    })}
                                                    placeholder={'Authorization=Bearer ...\nX-API-Key=...'}
                                                />
                                            </label>
                                        </div>
                                    )}
                                </div>

                                {hasServerIssues(editingServer) && (
                                    <div className="mcp-errors">
                                        {editingServer.validationErrors.map((message, index) => (
                                            <p key={`${editingServer.id}-validation-${index}`}>{message}</p>
                                        ))}
                                        {editingServer.lastError && <p>{editingServer.lastError}</p>}
                                    </div>
                                )}

                                {(isLoadingEditedServerTools || editingServer.tools.length > 0) && (
                                    <div className="mcp-section-card">
                                        <div className="mcp-section-header">
                                            <h4>Tools</h4>
                                        </div>

                                        {isLoadingEditedServerTools ? (
                                            <div className="mcp-side-empty">Loading tools...</div>
                                        ) : (
                                            <div className="mcp-tools">
                                                {editingServer.tools.map((tool) => (
                                                    <div className="mcp-tool-pill" key={`${editingServer.id}-${tool.alias}`}>
                                                        <code>{tool.alias}</code>
                                                        {tool.description && <span>{tool.description}</span>}
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>

                            <div className="mcp-editor-footer">
                                <button className="mcp-secondary-btn" type="button" onClick={handleCancelEdit} disabled={saving}>
                                    Cancel
                                </button>
                                <button className="mcp-primary-btn" type="button" onClick={() => handleSave().catch(() => undefined)} disabled={saving || !dirty}>
                                    {saving ? 'Saving...' : 'Save changes'}
                                </button>
                            </div>
                        </section>
                    ) : null}
                </div>
            )}
        </div>
    );
}
