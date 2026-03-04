import { useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react';
import {
    fetchEditableFile,
    fetchEditableFileSections,
    saveEditableFile,
} from '../../api/settingsApi.js';
import './FilesEditorPanel.css';

const SELECTED_FILE_STORAGE_KEY = 'orchestrator.settings.files.selected_path';

function getStoredSelectedPath() {
    try {
        return String(localStorage.getItem(SELECTED_FILE_STORAGE_KEY) ?? '').trim();
    } catch {
        return '';
    }
}

function flattenSections(sections) {
    return (Array.isArray(sections) ? sections : []).flatMap((section) => section?.items ?? []);
}

function formatSize(bytes) {
    const value = Number(bytes);
    if (!Number.isFinite(value) || value < 0) {
        return '-';
    }
    if (value < 1024) {
        return `${value} B`;
    }
    if (value < 1024 * 1024) {
        return `${(value / 1024).toFixed(1)} KB`;
    }
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function formatModifiedAt(value) {
    const timestamp = Number(value);
    if (!Number.isFinite(timestamp) || timestamp <= 0) {
        return '-';
    }

    return new Date(timestamp).toLocaleString();
}

function normalizeSearchValue(value) {
    return String(value ?? '').trim().toLowerCase();
}

function entryMatchesQuery(entry, query) {
    if (!query) {
        return true;
    }

    return [
        entry?.label,
        entry?.relativePath,
        entry?.path,
        entry?.agentName,
    ]
        .map(normalizeSearchValue)
        .some((value) => value.includes(query));
}

function buildErrorMessage(error, fallbackMessage) {
    return error instanceof Error && error.message ? error.message : fallbackMessage;
}

export function FilesEditorPanel() {
    const [sections, setSections] = useState([]);
    const [selectedPath, setSelectedPath] = useState(() => getStoredSelectedPath());
    const [file, setFile] = useState(null);
    const [draft, setDraft] = useState('');
    const [search, setSearch] = useState('');
    const deferredSearch = useDeferredValue(search);
    const [isLoadingSections, setIsLoadingSections] = useState(true);
    const [isLoadingFile, setIsLoadingFile] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const [errorMessage, setErrorMessage] = useState('');
    const [statusMessage, setStatusMessage] = useState('');

    const loadSections = useCallback(async () => {
        setIsLoadingSections(true);
        setErrorMessage('');
        try {
            const nextSections = await fetchEditableFileSections();
            setSections(nextSections);
        } catch (error) {
            setSections([]);
            setErrorMessage(buildErrorMessage(error, 'Failed to load editable files.'));
        } finally {
            setIsLoadingSections(false);
        }
    }, []);

    useEffect(() => {
        loadSections().catch(() => undefined);
    }, [loadSections]);

    useEffect(() => {
        const allItems = flattenSections(sections);
        if (allItems.length === 0) {
            if (selectedPath) {
                setSelectedPath('');
            }
            return;
        }

        if (selectedPath && allItems.some((entry) => entry.path === selectedPath)) {
            return;
        }

        setSelectedPath(allItems[0].path);
    }, [sections, selectedPath]);

    useEffect(() => {
        try {
            if (selectedPath) {
                localStorage.setItem(SELECTED_FILE_STORAGE_KEY, selectedPath);
            } else {
                localStorage.removeItem(SELECTED_FILE_STORAGE_KEY);
            }
        } catch {
            // noop
        }
    }, [selectedPath]);

    useEffect(() => {
        let cancelled = false;

        const loadFile = async () => {
            if (!selectedPath) {
                setFile(null);
                setDraft('');
                return;
            }

            setIsLoadingFile(true);
            setErrorMessage('');
            setStatusMessage('');

            try {
                const nextFile = await fetchEditableFile(selectedPath);
                if (cancelled) return;
                setFile(nextFile);
                setDraft(nextFile.content ?? '');
            } catch (error) {
                if (cancelled) return;
                setFile(null);
                setDraft('');
                setErrorMessage(buildErrorMessage(error, 'Failed to load file.'));
            } finally {
                if (!cancelled) {
                    setIsLoadingFile(false);
                }
            }
        };

        loadFile().catch(() => undefined);

        return () => {
            cancelled = true;
        };
    }, [selectedPath]);

    const isDirty = Boolean(file) && draft !== (file.content ?? '');

    const filteredSections = useMemo(() => {
        const query = normalizeSearchValue(deferredSearch);
        return (Array.isArray(sections) ? sections : [])
            .map((section) => ({
                ...section,
                items: (Array.isArray(section?.items) ? section.items : []).filter((entry) => entryMatchesQuery(entry, query)),
            }))
            .filter((section) => section.items.length > 0);
    }, [deferredSearch, sections]);

    const handleSelectPath = useCallback((nextPath) => {
        if (!nextPath || nextPath === selectedPath) {
            return;
        }

        if (isDirty && !window.confirm('Discard unsaved changes and open another file?')) {
            return;
        }

        setSelectedPath(nextPath);
    }, [isDirty, selectedPath]);

    const handleRefreshCurrentFile = useCallback(async () => {
        if (!selectedPath || isLoadingFile) {
            return;
        }

        if (isDirty && !window.confirm('Discard unsaved changes and reload this file from disk?')) {
            return;
        }

        setIsLoadingFile(true);
        setErrorMessage('');
        setStatusMessage('');

        try {
            const nextFile = await fetchEditableFile(selectedPath);
            setFile(nextFile);
            setDraft(nextFile.content ?? '');
        } catch (error) {
            setErrorMessage(buildErrorMessage(error, 'Failed to reload file.'));
        } finally {
            setIsLoadingFile(false);
        }
    }, [isDirty, isLoadingFile, selectedPath]);

    const handleRefreshList = useCallback(async () => {
        setStatusMessage('');
        await loadSections();
    }, [loadSections]);

    const handleSave = useCallback(async () => {
        if (!file || !selectedPath || isSaving) {
            return;
        }

        setIsSaving(true);
        setErrorMessage('');
        setStatusMessage('');

        try {
            const savedFile = await saveEditableFile({
                path: selectedPath,
                content: draft,
                modifiedAt: file.modifiedAt,
            });
            setFile(savedFile);
            setDraft(savedFile.content ?? '');
            setStatusMessage('Saved.');
            const nextSections = await fetchEditableFileSections().catch(() => null);
            if (nextSections) {
                setSections(nextSections);
            }
        } catch (error) {
            setErrorMessage(buildErrorMessage(error, 'Failed to save file.'));
        } finally {
            setIsSaving(false);
        }
    }, [draft, file, isSaving, selectedPath]);

    useEffect(() => {
        const onKeyDown = (event) => {
            if (!selectedPath || !isDirty || isSaving) {
                return;
            }

            const key = String(event.key ?? '').toLowerCase();
            if (!(event.metaKey || event.ctrlKey) || key !== 's') {
                return;
            }

            event.preventDefault();
            handleSave().catch(() => undefined);
        };

        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [handleSave, isDirty, isSaving, selectedPath]);

    return (
        <div className="files-editor-panel">
            <div className="files-editor-layout">
                <aside className="files-editor-sidebar">
                    <div className="files-editor-search">
                        <input
                            className="files-editor-search-input"
                            type="search"
                            placeholder="Search files…"
                            value={search}
                            onChange={(event) => setSearch(event.target.value)}
                        />
                    </div>

                    <div className="files-editor-sections">
                        {!isLoadingSections && filteredSections.length === 0 && (
                            <div className="files-editor-empty">
                                {sections.length === 0 ? 'No editable files available.' : 'No files match your search.'}
                            </div>
                        )}

                        {filteredSections.map((section) => (
                            <div className="files-editor-section" key={section.id}>
                                <div className="files-editor-section-header">
                                    <span>{section.label}</span>
                                    <span>{section.items.length}</span>
                                </div>
                                <div className="files-editor-item-list">
                                    {section.items.map((entry) => (
                                        <button
                                            key={entry.path}
                                            className={`files-editor-item${entry.path === selectedPath ? ' active' : ''}`}
                                            onClick={() => handleSelectPath(entry.path)}
                                            type="button"
                                        >
                                            <span className="files-editor-item-label">{entry.label}</span>
                                            <span className="files-editor-item-path">{entry.relativePath}</span>
                                        </button>
                                    ))}
                                </div>
                            </div>
                        ))}
                    </div>
                </aside>

                <section className="files-editor-detail">
                    <div className="files-editor-detail-header">
                        <div className="files-editor-detail-heading">
                            {selectedPath ? (
                                <>
                                    <h3>{file?.label ?? 'Loading…'}</h3>
                                    <div className="files-editor-badges">
                                        {file?.kind === 'data' && <span className="files-editor-badge">data</span>}
                                        {file?.kind === 'prompt' && <span className="files-editor-badge">prompt source</span>}
                                        {file?.sensitive && <span className="files-editor-badge files-editor-badge--warn">sensitive</span>}
                                        {file?.restartRequired && <span className="files-editor-badge files-editor-badge--info">restart may be required</span>}
                                        {isDirty && <span className="files-editor-badge files-editor-badge--dirty">unsaved</span>}
                                    </div>
                                </>
                            ) : (
                                <h3>File preview</h3>
                            )}
                        </div>

                        <div className="files-editor-detail-actions">
                            <button
                                className="files-editor-btn files-editor-btn--secondary"
                                onClick={handleRefreshList}
                                type="button"
                                disabled={isLoadingSections}
                            >
                                {isLoadingSections ? 'Refreshing…' : 'Refresh list'}
                            </button>
                            <button
                                className="files-editor-btn files-editor-btn--secondary"
                                onClick={handleRefreshCurrentFile}
                                type="button"
                                disabled={isLoadingFile || !selectedPath}
                            >
                                {isLoadingFile ? 'Loading…' : 'Reload'}
                            </button>
                            <button
                                className="files-editor-btn files-editor-btn--primary"
                                onClick={() => handleSave().catch(() => undefined)}
                                type="button"
                                disabled={!file || !isDirty || isSaving || isLoadingFile}
                            >
                                {isSaving ? 'Saving…' : 'Save'}
                            </button>
                        </div>
                    </div>

                    {errorMessage && (
                        <div className="files-editor-message files-editor-message--error">{errorMessage}</div>
                    )}

                    {!errorMessage && statusMessage && (
                        <div className="files-editor-message files-editor-message--success">{statusMessage}</div>
                    )}

                    {!selectedPath && !isLoadingSections && (
                        <div className="files-editor-placeholder">
                            Select a file to inspect and edit it.
                        </div>
                    )}

                    {selectedPath && (
                        <>
                            {file && (
                                <div className="files-editor-meta">
                                    <span>{file.path}</span>
                                    <span>{formatSize(file.sizeBytes)}</span>
                                    <span>Updated {formatModifiedAt(file.modifiedAt)}</span>
                                </div>
                            )}

                            {file?.kind === 'prompt' && (
                                <div className="files-editor-note">
                                    You are editing the prompt source file directly. Depending on how the app is running, prompt changes can require an API restart before they are used.
                                </div>
                            )}

                            {file?.sensitive && (
                                <div className="files-editor-note files-editor-note--warn">
                                    This file can contain secrets. Edit it deliberately.
                                </div>
                            )}

                            <textarea
                                className="files-editor-textarea"
                                value={draft}
                                onChange={(event) => setDraft(event.target.value)}
                                spellCheck={false}
                                disabled={!file || isLoadingFile}
                            />
                        </>
                    )}
                </section>
            </div>
        </div>
    );
}
